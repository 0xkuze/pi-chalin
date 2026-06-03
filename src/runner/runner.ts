import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { Context, Effect, Layer } from "effect";
import type { AgentDefinition, AgentHandoff, AgentThinkingLevel, ReviewerEvidenceRecord, ReviewerVerdict } from "../domain/schemas.ts";
import { evaluateBudgetUsage, policyForStep, recordBudgetCheckpoint, scoreProgress, summarizeToolUtility } from "../budget/budget.ts";
import { claimsNeedingAudit, claimsRequireAudit } from "../observability/evidence-claims.ts";
import type { ChalinPathsOptions } from "../config/paths.ts";
import { createConfiguredMemoryStore } from "../memory/memory-provider.ts";
import type { AgentOutput, AgentStep, BudgetCapHit, EvidenceClaim, RouteDecision, RouteExpectedEffect, RoutePlan, RunState, RunStepMetrics, RunStepRepairKind, RunStepState, TokenUsageSummary, ToolBudgetProfile, WorkUnit } from "../domain/schemas.ts";
import { createChildToolPolicy, createChildTools, type ChalinDelegateParamsShape, type ChildToolActivity, type ChildToolPolicy } from "../tools/child-tools.ts";
import { createChalinChildSessionManager } from "../runtime/child-sessions.ts";
import { buildProjectDiscoveryIndex, formatProjectDiscoveryIndex } from "../project/discovery.ts";
import { ArtifactStore } from "../artifacts/artifacts.ts";
import { buildPromptTokenomics, buildRunLifecycleSpans, buildToolOutputTokenomics, createSkillTraceEvent, createStructuredSpan, createTrajectoryEvent, mergeTraceSpans, mergeTrajectoryEvents, type SkillTraceEvent, type StructuredTraceSpan, type StructuredTraceSpanKind, type TokenomicsSummary, type TrajectoryEvent } from "../observability/observability.ts";
import { resolveAgentModel, resolveAgentThinking, resolveInheritedModelFallback, type ResolvedAgentModel } from "./model-resolution.ts";
import { buildSdkPrompt, childToolNames, handoffReviewToolCallLimit, isHandoffGapReadMode, resolveStepCompletionStatus, synthesisCrossStepDuplicateReadLimit, synthesisGapReadLimit, synthesisToolCallLimit, type SdkPromptOptions } from "./runner-prompt.ts";
import { chalinSessionIdFromContext, createRunState, isUsableStepHandoff, persistRun, prepareRunForResume } from "./runner-state.ts";
import { clearLiveStepSession, setLiveStepSession, type LiveStepSessionRef } from "../runtime/state.ts";
import { cleanupWorktrees, mergeWorktreeChanges, needsWorktreeIsolation, prepareWorktreeIsolation, type WorktreeIsolationPlan } from "../worktrees/worktrees.ts";
import { DEFAULT_CONFIG, type ChalinConfig } from "../config/config.ts";
import { SkillCatalog, effectiveSkillToolNames, resolveSkillsForStep } from "../skills/skills.ts";
import { checkpointSummary, isUsableStepStatus } from "../runtime/status.ts";
import { normalizeRouteForExecution } from "../routing/route-guards.ts";
import { parseAgentOutput } from "./agent-output.ts";
import { buildContextPacket, formatContextPacket, sanitizeWorkspacePathList, sanitizeWorkspaceTextForRoots } from "./context-packet.ts";
import { markBlockedDependentsSkipped, markHumanBlockedDependentsSkipped, updateRecoveryState } from "./run-recovery.ts";
import { isRecord, truncateText } from "./runner-utils.ts";
import { expandWorkUnitsFromBestHandoff, expandWorkUnitsFromHandoff, refreshWorkUnitStatuses } from "./work-units.ts";

export { parseAgentOutput } from "./agent-output.ts";

export interface WorkerRunnerContext extends ChalinPathsOptions {
  agents: Map<string, AgentDefinition>;
  config?: ChalinConfig;
  rootTask?: string;
  modelOverrides?: Record<string, string>;
  thinkingOverrides?: Record<string, AgentThinkingLevel>;
  parentRunId?: string;
  parentStepId?: string;
  delegationDepth?: number;
  explicitSkills?: string[];
  disabledSkills?: string[];
  extensionContext?: ExtensionContext;
  signal?: AbortSignal;
  onUpdate?: (run: RunState) => void;
}

export interface WorkerRunner {
  run(route: RouteDecision, context: WorkerRunnerContext): Promise<RunState>;
  resume?(run: RunState, context: WorkerRunnerContext): Promise<RunState>;
}

interface WorkerRunnerServiceShape {
  readonly run: (route: RouteDecision, context: WorkerRunnerContext) => Effect.Effect<RunState, unknown>;
  readonly resume: (run: RunState, context: WorkerRunnerContext) => Effect.Effect<RunState, unknown>;
}

class WorkerRunnerService extends Context.Tag("pi-chalin/Runner")<WorkerRunnerService, WorkerRunnerServiceShape>() {}

export function runnerLayer(runner: WorkerRunner): Layer.Layer<WorkerRunnerService> {
  return Layer.succeed(WorkerRunnerService, {
    run: (route, context) => Effect.tryPromise(() => runner.run(route, context)),
    resume: (run, context) => Effect.tryPromise(() => runner.resume ? runner.resume(run, context) : runner.run(run.route, context)),
  });
}

export function runWorkerRunnerEffect(runner: WorkerRunner, route: RouteDecision, context: WorkerRunnerContext): Effect.Effect<RunState, unknown> {
  return Effect.gen(function* () {
    const service = yield* WorkerRunnerService;
    return yield* service.run(route, context);
  }).pipe(Effect.provide(runnerLayer(runner)), Effect.withSpan("runner.service.run"));
}

export function resumeWorkerRunnerEffect(runner: WorkerRunner, run: RunState, context: WorkerRunnerContext): Effect.Effect<RunState, unknown> {
  return Effect.gen(function* () {
    const service = yield* WorkerRunnerService;
    return yield* service.resume(run, context);
  }).pipe(Effect.provide(runnerLayer(runner)), Effect.withSpan("runner.service.resume"));
}

class RunnerAbortError {
  readonly _tag = "AbortError";
  constructor(readonly message: string) {}
}

class BudgetExceededError {
  readonly _tag = "BudgetExceeded";
  constructor(readonly message: string) {}
}

class StepFailedError {
  readonly _tag = "StepFailed";
  constructor(readonly message: string) {}
}

type RunnerError = RunnerAbortError | BudgetExceededError | StepFailedError;

export class MockWorkerRunner implements WorkerRunner {
  async run(route: RouteDecision, context: WorkerRunnerContext): Promise<RunState> {
    const run = createRunState(route, context.cwd, context.rootTask, {
      parentRunId: context.parentRunId,
      parentStepId: context.parentStepId,
      delegationDepth: context.delegationDepth,
      sessionId: chalinSessionIdFromContext(context.extensionContext),
    });
    persistRun(run);
    context.onUpdate?.(run);
    const plan = route.plan;
    if (!plan) return completeRun(run, context);
    const dagSteps = plan.kind === "dag" ? plan.stages.flatMap((stage) => stage.tasks) : [];
    if (plan.kind === "dag" && needsWorktreeIsolation(dagSteps, context.agents)) {
      const isolation = prepareWorktreeIsolation({ cwd: context.cwd, runId: run.id, steps: dagSteps, agents: context.agents });
      run.warnings.push(...isolation.warnings);
      if (isolation.enabled) {
        run.warnings.push("Parallel writer worktree isolation active; mock run cleaned isolated worktrees after completion.");
        run.warnings.push(...cleanupWorktrees({ cwd: context.cwd, plan: isolation }));
      } else {
        run.warnings.push(`Parallel writer worktree isolation unavailable: ${isolation.reason}`);
      }
    }

    await runMockPlan(run, plan, context);

    return completeRun(run, context);
  }

  async resume(run: RunState, context: WorkerRunnerContext): Promise<RunState> {
    prepareRunForResume(run);
    context.onUpdate?.(run);
    const plan = run.route.plan;
    if (!plan) return completeRun(run, context);
    await resumeMockPlan(run, plan, context);
    return completeRun(run, context);
  }
}

function runMockPlan(run: RunState, plan: RoutePlan, context: WorkerRunnerContext): Promise<void> {
  return Effect.runPromise(Effect.gen(function* () {
    yield* checkAbortEffect(context.signal);
    if (plan.kind === "sequential") {
      yield* runChainEffect(run, run.steps, context, {});
    } else {
      yield* runnerTryPromise(() => runMockDag(run, plan.stages, context));
    }
  }).pipe(
    Effect.catchTag("AbortError", (error) => Effect.sync(() => markRunAborted(run, context, error.message))),
    Effect.catchTag("BudgetExceeded", (error) => Effect.fail(new Error(error.message))),
    Effect.catchTag("StepFailed", (error) => Effect.fail(new Error(error.message))),
    Effect.withSpan("runner.mock.plan"),
  ));
}

function resumeMockPlan(run: RunState, plan: RoutePlan, context: WorkerRunnerContext): Promise<void> {
  return Effect.runPromise(Effect.gen(function* () {
    yield* checkAbortEffect(context.signal);
    if (plan.kind === "sequential") {
      yield* runChainEffect(run, run.steps, context, { resume: true, initialPrevious: aggregateCompletedHandoffBefore(run.steps, run.steps.length) });
    } else {
      yield* runnerTryPromise(() => resumeMockDag(run, plan.stages, context));
    }
  }).pipe(
    Effect.catchTag("AbortError", (error) => Effect.sync(() => markRunAborted(run, context, error.message))),
    Effect.catchTag("BudgetExceeded", (error) => Effect.fail(new Error(error.message))),
    Effect.catchTag("StepFailed", (error) => Effect.fail(new Error(error.message))),
    Effect.withSpan("runner.mock.resumePlan"),
  ));
}

export class SdkWorkerRunner implements WorkerRunner {
  async run(route: RouteDecision, context: WorkerRunnerContext): Promise<RunState> {
    if (shouldUseMockSdkFallback(context)) {
      const mock = new MockWorkerRunner();
      const run = await mock.run(route, context);
      run.warnings.push(mockFallbackReason(context));
      persistRun(run);
      return run;
    }
    const extensionContext = context.extensionContext;
    if (!extensionContext) throw new Error("SDK runner requires an extension context.");

    const run = createRunState(route, context.cwd, context.rootTask, {
      parentRunId: context.parentRunId,
      parentStepId: context.parentStepId,
      delegationDepth: context.delegationDepth,
      sessionId: chalinSessionIdFromContext(context.extensionContext),
    });
    persistRun(run);
    context.onUpdate?.(run);
    const plan = route.plan;
    if (!plan) return completeRun(run, context);
    if (plan.kind === "dag") {
      await runSdkDag(run, plan.stages, context, extensionContext);
    } else {
      let previous = "";
      for (let index = 0; index < run.steps.length; index += 1) {
        const step = run.steps[index]!;
        if (runBlockedByHumanInput(run) || step.status === "skipped") break;
        const result = await runSdkStep(step, context, extensionContext, run, { previous, cwd: context.cwd });
        if (result.aborted || result.paused) break;
        previous = result.handoff ?? previous;
        afterStepHandoff(run, step);
        if (runBlockedByHumanInput(run)) break;
        maybeAppendWorkerScopeGapRepair(run, step);
        maybeAppendImplementationReviewRepair(run, step);
        if (step.status === "failed") break;
      }
    }

    return completeRun(run, context);
  }

  async resume(run: RunState, context: WorkerRunnerContext): Promise<RunState> {
    if (shouldUseMockSdkFallback(context)) {
      const mock = new MockWorkerRunner();
      const resumed = await mock.resume(run, context);
      resumed.warnings.push(mockFallbackReason(context));
      persistRun(resumed);
      return resumed;
    }
    const extensionContext = context.extensionContext;
    if (!extensionContext) throw new Error("SDK runner requires an extension context.");

    prepareRunForResume(run);
    context.onUpdate?.(run);
    const plan = run.route.plan;
    if (!plan) return completeRun(run, context);
    if (plan.kind === "dag") {
      await runSdkDag(run, plan.stages, context, extensionContext);
    } else {
      let previous = "";
      for (let index = 0; index < run.steps.length; index += 1) {
        const step = run.steps[index]!;
        if (runBlockedByHumanInput(run) || step.status === "skipped") break;
        if (isUsableStepHandoff(step)) {
          previous = step.output?.handoff ?? step.output?.text ?? previous;
          afterStepHandoff(run, step);
          if (runBlockedByHumanInput(run)) break;
          maybeAppendWorkerScopeGapRepair(run, step);
          maybeAppendImplementationReviewRepair(run, step);
          if (step.status === "failed") break;
          continue;
        }
        const result = await runSdkStep(step, context, extensionContext, run, { previous, cwd: context.cwd });
        if (result.aborted || result.paused) break;
        previous = result.handoff ?? previous;
        afterStepHandoff(run, step);
        if (runBlockedByHumanInput(run)) break;
        maybeAppendWorkerScopeGapRepair(run, step);
        maybeAppendImplementationReviewRepair(run, step);
        if (step.status === "failed") break;
      }
    }

    return completeRun(run, context);
  }
}

async function runMockDag(run: RunState, stages: Extract<RoutePlan, { kind: "dag" }>["stages"], context: WorkerRunnerContext): Promise<void> {
  let previous = "";
  for (let stageIndex = 0; stageIndex < stages.length; stageIndex += 1) {
    const stage = stages[stageIndex]!;
    if (runBlockedByHumanInput(run)) break;
    throwIfAborted(context.signal);
    const stageSteps = run.steps.filter((step) => step.id.startsWith(`${stage.id}:`));
    const outputs = await runParallel(stageSteps, context, previous, run, `mock-dag:${stage.id}`);
    afterStageHandoffs(run, stageSteps);
    if (runBlockedByHumanInput(run)) break;
    for (const step of stageSteps) {
      maybeAppendWorkerScopeGapRepair(run, step);
      maybeAppendImplementationReviewRepair(run, step);
    }
    previous = aggregateHandoff(outputs.map((output) => ({ agent: output.agent, text: output.handoff ?? output.text })));
  }
}

async function resumeMockDag(run: RunState, stages: Extract<RoutePlan, { kind: "dag" }>["stages"], context: WorkerRunnerContext): Promise<void> {
  let previous = "";
  for (let stageIndex = 0; stageIndex < stages.length; stageIndex += 1) {
    const stage = stages[stageIndex]!;
    if (runBlockedByHumanInput(run)) break;
    throwIfAborted(context.signal);
    const stageSteps = run.steps.filter((step) => step.id.startsWith(`${stage.id}:`));
    if (stageSteps.every((step) => isUsableStepHandoff(step))) {
      previous = aggregateStageHandoff(stageSteps);
      afterStageHandoffs(run, stageSteps);
      if (runBlockedByHumanInput(run)) break;
      for (const step of stageSteps) {
        maybeAppendWorkerScopeGapRepair(run, step);
        maybeAppendImplementationReviewRepair(run, step);
      }
      continue;
    }
    const outputs = await runParallel(
      stageSteps.filter((step) => !isUsableStepHandoff(step)),
      context,
      previous,
      run,
      `mock-dag-resume:${stage.id}`,
    );
    const completedOutputs = stageSteps
      .filter((step) => isUsableStepHandoff(step))
      .map((step) => ({ agent: step.agent, text: step.output?.handoff ?? step.output?.text ?? "" }));
    afterStageHandoffs(run, stageSteps);
    if (runBlockedByHumanInput(run)) break;
    for (const step of stageSteps) {
      maybeAppendWorkerScopeGapRepair(run, step);
      maybeAppendImplementationReviewRepair(run, step);
    }
    previous = aggregateHandoff([...completedOutputs, ...outputs.map((output) => ({ agent: output.agent, text: output.handoff ?? output.text }))]);
  }
}

async function runSdkParallelSteps(
  run: RunState,
  tasks: AgentStep[],
  context: WorkerRunnerContext,
  extensionContext: ExtensionContext,
): Promise<void> {
  let isolation: WorktreeIsolationPlan | undefined;
  const isolationSteps = isolationAgentStepsForRunSteps(run.steps);
  if (needsWorktreeIsolation(isolationSteps.length ? isolationSteps : tasks, context.agents)) {
    isolation = prepareWorktreeIsolation({ cwd: context.cwd, runId: run.id, steps: isolationSteps.length ? isolationSteps : tasks, agents: context.agents });
    run.warnings.push(...isolation.warnings);
    if (!isolation.enabled) {
      const reason = `Parallel writer worktree isolation unavailable: ${isolation.reason}`;
      run.warnings.push(reason);
      for (const step of run.steps) {
        step.status = "failed";
        step.error = reason;
        step.endedAt = new Date().toISOString();
      }
      persistRun(run);
      context.onUpdate?.(run);
      return;
    }
    run.warnings.push("Parallel writer worktree isolation active; writer agents run in isolated git worktrees and merge back with git apply --3way.");
  }

  try {
    await Effect.runPromise(Effect.forEach(
      run.steps.filter(isRunnableStep),
      (step) => Effect.tryPromise(() => {
        const worktree = isolation?.worktrees.find((item) => item.stepId === step.id);
        return runSdkStep(step, context, extensionContext, run, { cwd: worktree?.path ?? context.cwd });
      }),
      { concurrency: "unbounded" },
    ).pipe(Effect.withSpan("runner.sdk.parallel")));

    if (run.steps.some((step) => step.status === "paused")) {
      run.warnings.push(isolation?.enabled
        ? "Parallel SDK run paused after a child idle stall; isolated writer changes were not merged."
        : "Parallel SDK run paused after a child idle stall.");
      persistRun(run);
      context.onUpdate?.(run);
      return;
    }

    if (isolation?.enabled) await mergeIsolatedStage(run, context, extensionContext, isolation, { scopeSteps: run.steps });
  } finally {
    if (isolation?.enabled) run.warnings.push(...cleanupWorktrees({ cwd: context.cwd, plan: isolation }));
  }
}

async function mergeIsolatedStage(
  run: RunState,
  context: WorkerRunnerContext,
  extensionContext: ExtensionContext,
  isolation: WorktreeIsolationPlan,
  options: { scopeSteps?: RunStepState[] } = {},
): Promise<void> {
  const merge = mergeWorktreeChanges({ cwd: context.cwd, plan: isolation, declaredFilesByStepId: declaredFilesByIsolatedStepId(options.scopeSteps ?? run.steps) });
  run.warnings.push(...merge.warnings);
  if (merge.applied.length) run.warnings.push(`Merged isolated writer patches: ${merge.applied.join(", ")}.`);
  for (const conflict of merge.conflicts) {
    const step = findIsolatedConflictStep(conflict, options.scopeSteps ?? run.steps);
    if (step) {
      step.status = "failed";
      step.error = `Worktree merge conflict: ${conflict.reason}`;
      step.endedAt = new Date().toISOString();
    } else {
      run.warnings.push(`Worktree merge conflict for ${conflict.agent}/${conflict.stepId ?? "unknown-step"} could not be mapped to a run step.`);
    }
    run.warnings.push(`Worktree merge conflict for ${conflict.agent}: ${conflict.reason}`);
  }
  if (merge.conflicts.length > 0 && context.agents.has("conflict-resolver")) {
    for (const conflict of merge.conflicts) {
      const targetStep = findIsolatedConflictStep(conflict, options.scopeSteps ?? run.steps);
      const resolverStep: RunStepState = {
        id: `conflict:${conflict.stepId ?? conflict.agent}`,
        agent: "conflict-resolver",
        task: buildConflictResolverTask(conflict),
        status: "pending",
        stageId: targetStep?.stageId ? `${targetStep.stageId}:repair` : "conflict-repair",
        workUnitId: targetStep?.workUnitId,
        dependencies: targetStep ? [targetStep.id] : [],
        repairCycle: (targetStep?.repairCycle ?? 0) + 1,
      };
      run.steps.push(resolverStep);
      run.warnings.push(`Starting conflict-resolver for ${conflict.agent}.`);
      await runSdkStep(resolverStep, context, extensionContext, run, { cwd: context.cwd });
      if (resolverStep.status === "complete") {
        afterStepHandoff(run, resolverStep);
        const repaired = targetStep ? applyConflictResolverRepair(run, targetStep, resolverStep) : false;
        run.warnings.push(repaired
          ? `Conflict-resolver completed for ${conflict.agent}; repaired ${targetStep?.agent}/${targetStep?.id} with resolver evidence.`
          : `Conflict-resolver completed for ${conflict.agent}; original isolated patch was not auto-applied after conflict.`);
      }
    }
  }
  persistRun(run);
  context.onUpdate?.(run);
}

function findIsolatedConflictStep(conflict: { agent: string; stepId?: string }, scopeSteps: RunStepState[]): RunStepState | undefined {
  const sameAgentSteps = scopeSteps.filter((step) => step.agent === conflict.agent);
  if (conflict.stepId) {
    const exactStep = sameAgentSteps.find((step) => step.id === conflict.stepId);
    if (exactStep) return exactStep;
    const localStep = sameAgentSteps.find((step) => step.id.split(":").at(-1) === conflict.stepId);
    if (localStep) return localStep;
  }
  return sameAgentSteps.length === 1 ? sameAgentSteps[0] : undefined;
}

export function declaredFilesByIsolatedStepId(scopeSteps: RunStepState[]): Map<string, string[]> {
  const files = new Map<string, string[]>();
  for (const step of scopeSteps) {
    if (step.status !== "complete") continue;
    if ((step.metrics?.policyViolations ?? []).some(isFatalToolPolicyViolation)) continue;
    const changedFiles = step.output?.structuredHandoff?.changedFiles ?? [];
    if (changedFiles.length === 0) continue;
    files.set(step.id.split(":").at(-1) ?? step.id, changedFiles);
  }
  return files;
}

export function applyConflictResolverRepair(run: RunState, failedStep: RunStepState, resolverStep: RunStepState): boolean {
  const resolverHandoff = resolverStep.output?.structuredHandoff;
  if (resolverStep.agent !== "conflict-resolver" || resolverStep.status !== "complete" || !resolverHandoff) return false;
  if (resolverHandoff.changedFiles.length === 0 || resolverHandoff.verification.length === 0) return false;
  if (failedStep.status !== "failed") return false;

  const previousFailure = failedStep.error;
  failedStep.status = "complete";
  failedStep.error = undefined;
  failedStep.repairCycle = (failedStep.repairCycle ?? 0) + 1;
  if (failedStep.output) {
    failedStep.output.warnings = appendUnique(
      failedStep.output.warnings,
      `Recovered by conflict-resolver/${resolverStep.id}${previousFailure ? ` after: ${previousFailure}` : ""}.`,
    );
  }
  refreshWorkUnitStatuses(run);
  updateRecoveryState(run, run.steps.find((step) => step.status === "failed"));
  return true;
}

export function buildConflictResolverTask(conflict: { agent: string; reason: string; patch?: string; worktreePath?: string }): string {
  return [
    `Resolve a pi-chalin isolated worktree merge conflict from agent '${conflict.agent}'.`,
    `Conflict reason: ${conflict.reason}`,
    conflict.worktreePath ? `Isolated worktree path for reference: ${conflict.worktreePath}` : undefined,
    "",
    "Apply the intended change surgically to the primary worktree if and only if the intent is clear.",
    "Prefer read/grep/find/ls/edit for precise evidence and diffs; use bash when it is the right tool, and keep commands purposeful.",
    "If the patch intent conflicts with existing local changes or is ambiguous, stop and explain the human decision needed.",
    conflict.patch ? "\nConflicting patch excerpt:" : undefined,
    conflict.patch ? truncateText(conflict.patch, 3000) : undefined,
  ].filter((line): line is string => Boolean(line)).join("\n");
}

async function runSdkDag(
  run: RunState,
  stages: Extract<RoutePlan, { kind: "dag" }>["stages"],
  context: WorkerRunnerContext,
  extensionContext: ExtensionContext,
): Promise<void> {
  let previous = "";
  for (let stageIndex = 0; stageIndex < stages.length; stageIndex += 1) {
    const stage = stages[stageIndex]!;
    if (runBlockedByHumanInput(run)) break;
    if (context.signal?.aborted) {
      markRunAborted(run, context, "pi-chalin run stopped by user.");
      break;
    }
    const stageSteps = run.steps.filter((step) => step.id.startsWith(`${stage.id}:`));
    const stageResult = await runSdkStage(run, stage, stageSteps, context, extensionContext, previous);
    const recoveredPauses = recoverPausedReadOnlyDagStage(stageSteps, context.agents);
    if (recoveredPauses > 0) {
      run.warnings.push(`DAG stage ${stage.id} continued with partial fan-out results after ${recoveredPauses} read-only idle stall(s).`);
      persistRun(run);
      context.onUpdate?.(run);
    }
    if (stageResult.paused && stageSteps.some((step) => step.status === "paused")) {
      run.warnings.push(stageResult.isolated
        ? `DAG stage ${stage.id} paused after a child idle stall; isolated writer changes were not merged.`
        : `DAG stage ${stage.id} paused after a child idle stall.`);
      persistRun(run);
      context.onUpdate?.(run);
    }
    afterStageHandoffs(run, stageSteps);
    if (runBlockedByHumanInput(run)) break;
    for (const step of stageSteps) {
      maybeAppendWorkerScopeGapRepair(run, step);
      maybeAppendImplementationReviewRepair(run, step);
    }
    previous = aggregateStageHandoff(stageSteps);
    if (shouldStopAfterDagStage(stageSteps, context.agents)) {
      markBlockedDependentsSkipped(run, stageSteps.find((step) => step.status === "failed"));
      break;
    }
    const failedSteps = stageSteps.filter((step) => step.status === "failed");
    if (failedSteps.length > 0) {
      run.warnings.push(`DAG stage ${stage.id} continued with partial fan-out results after ${failedSteps.length} read-only failure(s).`);
      persistRun(run);
      context.onUpdate?.(run);
    }
  }
}

function aggregateStageHandoff(stageSteps: RunStepState[]): string {
  return aggregateHandoff(stageSteps.map((step) => {
    if (isUsableStepHandoff(step)) return { agent: step.agent, text: step.output?.handoff ?? step.output?.text ?? "" };
    if (step.status === "failed") return { agent: step.agent, text: `FAILED: ${step.error ?? "unknown error"}. Treat this as a known coverage gap and make it explicit in downstream synthesis.` };
    return { agent: step.agent, text: "" };
  }));
}

function maybeAppendWorkerScopeGapRepair(run: RunState, step: RunStepState): boolean {
  if (step.agent !== "worker" || !isUsableStepHandoff(step)) return false;
  const gapFiles = workUnitScopeGapPaths(step.metrics?.policyViolations ?? []);
  if (gapFiles.length === 0) return false;
  const stepIndex = run.steps.indexOf(step);
  if (stepIndex < 0 || hasLaterImplementationRepair(run, stepIndex)) return false;

  const existingRepairCycles = repairCycleCount(run, "scope-gap");
  const maxRepairCycles = maxImplementationReviewRepairCycles();
  if (existingRepairCycles >= maxRepairCycles) {
    step.status = "failed";
    step.error = `Worker reported WorkUnit scope gap(s) after ${existingRepairCycles} repair cycle(s): ${gapFiles.slice(0, 8).join(", ")}.`;
    run.warnings.push(`${step.error} Stopping instead of finalizing incomplete routed implementation.`);
    persistRun(run);
    return false;
  }

  const cycle = existingRepairCycles + 1;
  const sequence = nextReviewRepairSequence(run);
  const repairUnit = ensureWorkerScopeGapRepairScope(run, step, gapFiles, sequence);
  const originalTask = run.rootTask ?? run.route.reason;
  const workerText = truncateText(step.output?.handoff ?? step.output?.text ?? "", 900);
  const repairWorker: RunStepState = {
    id: `review-repair-${sequence}-worker`,
    agent: "worker",
    task: [
      "Repair the worker-reported WorkUnit scope gap.",
      formatRepairUnitContext(repairUnit),
      "Apply only the missing cross-scope repair named by the previous worker handoff, then run the nearest verification command.",
      "Handoff exact changed paths, verification command/result, and any remaining risk.",
      `Original task: ${originalTask}`,
      `Previous worker handoff: ${workerText}`,
    ].join(" "),
    budget: "tight",
    status: "pending",
    workUnitId: repairUnit.id,
    dependencies: [step.id],
    repairCycle: cycle,
    repairKind: "scope-gap",
  };
  const repairReviewer: RunStepState = {
    id: `review-repair-${sequence}-reviewer`,
    agent: "reviewer",
    task: [
      "Review the scope-gap repair against the original task, the previous worker handoff, and the repair WorkUnit scope.",
      "Return PASS only if the blocked file gap is resolved and verification evidence is real.",
      "Return FAIL/GAP with structured blocker files if the repair is incomplete.",
      `Original task: ${originalTask}`,
      `Previous worker handoff: ${workerText}`,
    ].join(" "),
    budget: "tight",
    status: "pending",
    workUnitId: repairUnit.id,
    repairCycle: cycle,
    repairKind: "scope-gap",
  };

  appendImplementationReviewRepair(
    run,
    sequence,
    repairWorker,
    repairReviewer,
    "because a worker reported a WorkUnit scope gap",
    { afterStageId: run.route.plan?.kind === "dag" ? step.stageId ?? stageIdForStep(step.id) : undefined },
  );
  run.warnings.push(`Worker reported WorkUnit scope gap(s); queued repair cycle ${cycle}/${maxRepairCycles} for ${gapFiles.slice(0, 8).join(", ")}.`);
  persistRun(run);
  return true;
}

function maybeAppendImplementationReviewRepair(run: RunState, step: RunStepState): boolean {
  if (step.agent !== "reviewer" || !isUsableStepHandoff(step)) return false;
  const stepIndex = run.steps.indexOf(step);
  if (stepIndex < 0 || hasLaterImplementationRepair(run, stepIndex)) return false;
  const expectsVerify = routeExpectedEffects(run).has("verify");
  const reviewerMissingVerdict = reviewerMissingStructuredVerdictNeedsRepair(step);
  const reviewerEvidenceGap = reviewerMissingVerdict || reviewerPassNeedsEvidenceRepair(step, { expectsReviewedContent: true, expectsVerify });
  const existingEvidenceRepairCycles = repairCycleCount(run, "review-evidence");
  const existingImplementationRepairCycles = repairCycleCount(run, "implementation");
  const maxRepairCycles = maxImplementationReviewRepairCycles();
  if (reviewerEvidenceGap && existingEvidenceRepairCycles >= maxRepairCycles) {
    if (reviewerEvidenceGap) {
      step.reviewGate = "missing-evidence";
      markVerificationLedgerGap(run, step, "Structured Reviewer Verdict PASS lacks required contractual evidence.");
    }
    step.status = "failed";
    step.error = `Reviewer still reports missing required review evidence after ${existingEvidenceRepairCycles} repair cycle(s).`;
    run.warnings.push(`${step.error} Stopping instead of finalizing incomplete routed implementation.`);
    persistRun(run);
    return false;
  }

  const reviewText = truncateText(step.output?.handoff ?? step.output?.text ?? "", 1200);
  const originalTask = run.rootTask ?? run.route.reason;
  const priorVerificationEvidence = compactRunVerificationEvidence(run);
  const reviewerUnitContext = formatReviewRepairUnitContext(run, step);
  if (reviewerEvidenceGap) {
    const cycle = existingEvidenceRepairCycles + 1;
    const sequence = nextReviewRepairSequence(run);
    const repairReviewer: RunStepState = {
      id: `review-repair-${sequence}-reviewer`,
      agent: "reviewer",
      task: [
        "Re-audit the previous implementation review evidence, not the implementation itself unless a named claim needs one targeted read.",
        "Scope this evidence repair to the same WorkUnit as the previous reviewer. Do not report pending, skipped, or unrelated WorkUnits as blocking findings; those units keep their own worker/reviewer gates.",
        reviewerUnitContext,
        "Return a structured Reviewer Verdict. PASS requires evidence records: {kind:\"reviewed-content\", paths:[...], summary:\"...\"} and, when verification is expected, {kind:\"verification\", command:\"...\", status:\"pass|fail|unknown\", result:\"...\"}.",
        "If the earlier PASS was wrong, return FAIL/GAP with exact blocking findings and required repair.",
        `Original task: ${originalTask}`,
        ...(priorVerificationEvidence ? [`Known prior verification evidence from run ledgers: ${priorVerificationEvidence}`] : []),
        `Previous reviewer material: ${truncateText(reviewText, 700)}`,
      ].join(" "),
      budget: "tight",
      status: "pending",
      workUnitId: step.workUnitId,
      dependencies: [step.id],
      repairCycle: cycle,
      repairKind: "review-evidence",
    };
    appendReviewerEvidenceRepair(
      run,
      sequence,
      repairReviewer,
      reviewerMissingVerdict
        ? "because the reviewer omitted the structured verdict contract"
        : "because the reviewer pass lacked contractual evidence",
      { afterStageId: run.route.plan?.kind === "dag" ? step.stageId ?? stageIdForStep(step.id) : undefined },
    );
    run.warnings.push(`${reviewerMissingVerdict ? "Reviewer omitted the structured verdict contract" : "Reviewer pass lacked required evidence"}; queued reviewer evidence repair cycle ${cycle}/${maxRepairCycles}.`);
    persistRun(run);
    return true;
  }

  const workerIndex = findImplementationWorkerIndexForReviewer(run, step, stepIndex);
  if (workerIndex < 0) return false;
  let reviewerGap = !reviewerMissingVerdict && reviewerBlockingHandoffNeedsRepair(step);
  if (reviewerGap && downgradeOutOfScopeReviewerEvidenceRepairGap(run, step)) reviewerGap = false;
  const permanentTestGap = !reviewerGap && implementationPassNeedsPermanentTestRepair(run, workerIndex, stepIndex);
  if (!reviewerGap && !permanentTestGap) return false;
  if (existingImplementationRepairCycles >= maxRepairCycles) {
    const gap = reviewerGap ? "a blocking FAIL/GAP" : "missing permanent test coverage";
    step.status = "failed";
    step.error = `Implementation reviewer still reports ${gap} after ${existingImplementationRepairCycles} repair cycle(s).`;
    run.warnings.push(`${step.error} Stopping instead of finalizing incomplete routed implementation.`);
    persistRun(run);
    return false;
  }

  const cycle = existingImplementationRepairCycles + 1;
  const sequence = nextReviewRepairSequence(run);
  const implementationUnitId = run.steps[workerIndex]?.workUnitId ?? step.workUnitId;
  const repairIntro = reviewerGap
    ? "Repair the blocking implementation-review findings from the Previous Handoff."
    : "Repair the runtime coverage guard: product code changed while available permanent tests were not updated.";
  const repairScope = reviewerGap
    ? "Use the previous reviewer handoff as the gap list; do not repeat broad discovery unless a named file is missing."
    : "Add/update permanent runner-discoverable tests for the changed behavior. Preserve the implementation unless the new tests reveal a bug. Ignore narrower step wording that prohibited tests unless the Original User Goal explicitly prohibited test edits.";
  const repairUnit = reviewerGap ? ensureCrossWorkUnitRepairScope(run, step, implementationUnitId, sequence) : undefined;
  const repairWorkUnitId = repairUnit?.id ?? implementationUnitId;
  const repairUnitContext = repairUnit ? formatRepairUnitContext(repairUnit) : formatImplementationRepairUnitContext(run, step, implementationUnitId);
  const repairWorker: RunStepState = {
    id: `review-repair-${sequence}-worker`,
    agent: "worker",
    task: [
      repairIntro,
      repairUnitContext,
      "Read only the changed implementation/test files needed for the repair, apply the smallest corrective edit, add or update focused regression tests for the missed criteria, then run the requested or nearest verification command.",
      "Before handoff, check workspace status and clean transient generated outputs from verification/build/setup commands unless those generated files are intentional deliverables listed in changedFiles.",
      "Handoff exact changed paths, tests added/updated, verification command, and any remaining risk.",
      `Original task: ${originalTask}`,
      repairScope,
    ].join(" "),
    budget: "tight",
    status: "pending",
    workUnitId: repairWorkUnitId,
    dependencies: [step.id],
    repairCycle: cycle,
    repairKind: "implementation",
  };
  const repairReviewer: RunStepState = {
    id: `review-repair-${sequence}-reviewer`,
    agent: "reviewer",
    task: [
      "Re-review the repaired implementation against the original task and the previous reviewer findings.",
      "Check actual changed files, test coverage for each missed criterion, and verification output.",
      "Verify workspace hygiene: generated files left by verification/build/setup must be intentional changedFiles or reported as blocking cleanup work.",
      "Return PASS only if the blocking gaps are fixed; otherwise return FAIL/GAP with exact evidence. PASS evidence uses structured records for reviewed content and verification.",
      `Original task: ${originalTask}`,
      `Previous reviewer findings: ${truncateText(reviewText, 700)}`,
    ].join(" "),
    budget: "tight",
    status: "pending",
    workUnitId: repairWorkUnitId,
    repairCycle: cycle,
    repairKind: "implementation",
  };

  appendImplementationReviewRepair(
    run,
    sequence,
    repairWorker,
    repairReviewer,
    reviewerGap
      ? "because the reviewer reported a blocking FAIL/GAP"
      : "because changed product code had no permanent test update despite an available test surface",
    { afterStageId: run.route.plan?.kind === "dag" ? step.stageId ?? stageIdForStep(step.id) : undefined },
  );
  run.warnings.push(`${reviewerGap ? "Implementation reviewer reported a blocking gap" : "Implementation changed product code without permanent test coverage"}; queued repair cycle ${cycle}/${maxRepairCycles} with worker repair and reviewer re-check.`);
  persistRun(run);
  return true;
}

function downgradeOutOfScopeReviewerEvidenceRepairGap(run: RunState, step: RunStepState): boolean {
  if (!isReviewerOnlyEvidenceRepairStep(run, step)) return false;
  const verdict = step.output?.reviewerVerdict;
  const unit = run.workUnits?.find((candidate) => candidate.id === step.workUnitId);
  const unitFiles = new Set((unit?.files ?? []).map(normalizeMetricFilePath).filter(Boolean));
  if (!verdict || unitFiles.size === 0) return false;
  const blockingTexts = [...verdict.blockingFindings, ...verdict.missingCoverage, verdict.requiredRepair ?? ""].filter(Boolean);
  const blockingPaths = pathsMentionedInTexts(blockingTexts);
  const failedEvidencePaths = (verdict.evidenceRecords ?? [])
    .filter((record) => record.status === "fail")
    .flatMap((record) => record.paths.map(normalizeMetricFilePath).filter(Boolean));
  const scopedBlockingPaths = [...new Set([...blockingPaths, ...failedEvidencePaths])];
  if (scopedBlockingPaths.length === 0 || scopedBlockingPaths.some((filePath) => unitFiles.has(filePath))) return false;

  const warning = `Reviewer evidence repair reported out-of-scope gap(s) for ${scopedBlockingPaths.slice(0, 8).join(", ")}; kept them as residual risks instead of queuing a worker repair for ${step.workUnitId ?? "unknown WorkUnit"}.`;
  verdict.residualRisks = [
    ...new Set([
      ...(verdict.residualRisks ?? []),
      ...verdict.blockingFindings,
      ...verdict.missingCoverage,
      ...(verdict.requiredRepair ? [verdict.requiredRepair] : []),
    ]),
  ];
  verdict.verdict = "pass";
  verdict.blockingFindings = [];
  verdict.missingCoverage = [];
  delete verdict.requiredRepair;
  step.output!.warnings = appendUnique(step.output!.warnings, warning);
  pushUniqueWarnings(run, [warning]);
  return true;
}

function isReviewerOnlyEvidenceRepairStep(run: RunState, step: RunStepState): boolean {
  if (step.agent !== "reviewer") return false;
  const cycle = reviewRepairCycleId(step.id);
  if (!cycle) return false;
  return !run.steps.some((candidate) => candidate.id.startsWith(`review-repair-${cycle}-worker`));
}

function reviewRepairCycleId(stepId: string): string | undefined {
  const normalized = stepId.trim();
  const match = /^review-repair-(\d+)-reviewer(?::|$)/.exec(normalized);
  return match?.[1];
}

function pathsMentionedInTexts(texts: string[]): string[] {
  const paths: string[] = [];
  const pathPattern = /(?:^|[\s(:])([A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)+|[A-Za-z0-9_.-]+\.[A-Za-z0-9_.-]+)/g;
  for (const text of texts) {
    for (const match of text.matchAll(pathPattern)) {
      const normalized = normalizeMetricFilePath(match[1] ?? "");
      if (normalized && !normalized.startsWith(".") && /[A-Za-z_]/.test(normalized)) paths.push(normalized);
    }
  }
  return [...new Set(paths)];
}

function formatReviewRepairUnitContext(run: RunState, step: RunStepState): string {
  const unit = run.workUnits?.find((candidate) => candidate.id === step.workUnitId);
  if (!unit) return `WorkUnit scope: ${step.workUnitId ?? "unknown"}.`;
  const files = unit.files?.length ? unit.files.join(", ") : "no declared files";
  const criteria = unit.acceptanceCriteria?.length ? unit.acceptanceCriteria.join("; ") : "no explicit criteria";
  return `WorkUnit scope: ${unit.id} (${unit.title}). Files: ${files}. Acceptance criteria: ${criteria}.`;
}

function formatImplementationRepairUnitContext(run: RunState, reviewerStep: RunStepState, implementationUnitId: string | undefined): string {
  const unit = run.workUnits?.find((candidate) => candidate.id === implementationUnitId) ?? run.workUnits?.find((candidate) => candidate.id === reviewerStep.workUnitId);
  if (!unit) return `WorkUnit scope: ${implementationUnitId ?? reviewerStep.workUnitId ?? "unknown"}.`;
  const repairFiles = [
    ...(unit.files ?? []),
    ...priorWorkerChangedFilesForReviewer(run, reviewerStep, implementationUnitId),
  ];
  const files = repairFiles.length ? [...new Set(repairFiles)].join(", ") : "no declared files";
  const criteria = unit.acceptanceCriteria?.length ? unit.acceptanceCriteria.join("; ") : "reviewer-confirmed blocking findings";
  return `WorkUnit scope: ${unit.id} (${unit.title}). Files: ${files}. Acceptance criteria: ${criteria}.`;
}

function ensureCrossWorkUnitRepairScope(run: RunState, reviewerStep: RunStepState, implementationUnitId: string | undefined, cycle: number): WorkUnit | undefined {
  const verdict = reviewerStep.output?.reviewerVerdict;
  const repairFiles = normalizedRepairFiles(verdict?.repairFiles ?? []);
  if (repairFiles.length === 0) return undefined;

  const baseUnit = run.workUnits?.find((candidate) => candidate.id === implementationUnitId || candidate.id === reviewerStep.workUnitId);
  const baseFiles = normalizedRepairFiles([
    ...(baseUnit?.files ?? []),
    ...priorWorkerChangedFilesForReviewer(run, reviewerStep, implementationUnitId),
  ]);
  const baseFileSet = new Set(baseFiles);
  const outsideBase = repairFiles.filter((filePath) => !baseFileSet.has(filePath));
  if (outsideBase.length === 0) return undefined;

  const expectedEffects = [...routeExpectedEffects(run)];
  const unit: WorkUnit = {
    id: uniqueRepairUnitId(run, `repair-${cycle}-${implementationUnitId ?? reviewerStep.workUnitId ?? "work-unit"}`),
    title: baseUnit ? `Repair ${baseUnit.title}` : "Repair reviewer findings",
    kind: "repair",
    status: "pending",
    scope: [
      "Repair reviewer-confirmed blocking findings that cross the original WorkUnit file boundary.",
    ],
    files: [...new Set([...baseFiles, ...repairFiles])],
    dependencies: baseUnit ? [baseUnit.id] : [],
    expectedEffects: expectedEffects.length ? expectedEffects : ["read", "write", "verify"],
    acceptanceCriteria: repairAcceptanceCriteria(verdict),
    sourceStepId: reviewerStep.id,
    createdFrom: "repair",
  };
  run.workUnits ??= [];
  run.workUnits.push(unit);
  const warning = `Created cross-WorkUnit repair scope ${unit.id} for reviewer-confirmed file(s): ${outsideBase.slice(0, 8).join(", ")}${outsideBase.length > 8 ? `, and ${outsideBase.length - 8} more` : ""}.`;
  pushUniqueWarnings(run, [warning]);
  return unit;
}

function ensureWorkerScopeGapRepairScope(run: RunState, step: RunStepState, gapFiles: string[], cycle: number): WorkUnit {
  const baseUnit = run.workUnits?.find((candidate) => candidate.id === step.workUnitId);
  const baseFiles = normalizedRepairFiles([
    ...(baseUnit?.files ?? []),
    ...(step.output?.structuredHandoff?.changedFiles ?? []),
  ]);
  const normalizedGapFiles = normalizedRepairFiles(gapFiles);
  const ownerUnitIds = workUnitIdsOwningFiles(run, normalizedGapFiles);
  const expectedEffects = [...routeExpectedEffects(run)];
  const unit: WorkUnit = {
    id: uniqueRepairUnitId(run, `repair-${cycle}-${step.workUnitId ?? "scope-gap"}`),
    title: baseUnit ? `Repair ${baseUnit.title}` : "Repair WorkUnit scope gap",
    kind: "repair",
    status: "pending",
    scope: [
      "Repair a worker-reported missing dependency or file boundary from the current WorkUnit.",
    ],
    files: [...new Set([...baseFiles, ...normalizedGapFiles])],
    dependencies: [...new Set([...(baseUnit ? [baseUnit.id] : []), ...ownerUnitIds])],
    expectedEffects: expectedEffects.length ? expectedEffects : ["read", "write", "verify"],
    acceptanceCriteria: workerScopeGapAcceptanceCriteria(step, normalizedGapFiles),
    sourceStepId: step.id,
    createdFrom: "repair",
  };
  run.workUnits ??= [];
  run.workUnits.push(unit);
  const warning = `Created WorkUnit scope-gap repair ${unit.id} for ${normalizedGapFiles.slice(0, 8).join(", ")}${normalizedGapFiles.length > 8 ? `, and ${normalizedGapFiles.length - 8} more` : ""}.`;
  pushUniqueWarnings(run, [warning]);
  return unit;
}

function formatRepairUnitContext(unit: WorkUnit): string {
  const files = unit.files?.length ? unit.files.join(", ") : "no declared files";
  const criteria = unit.acceptanceCriteria.length ? unit.acceptanceCriteria.join("; ") : "reviewer-confirmed blocking findings";
  return `Repair WorkUnit scope: ${unit.id} (${unit.title}). Files: ${files}. Acceptance criteria: ${criteria}.`;
}

function workerScopeGapAcceptanceCriteria(step: RunStepState, gapFiles: string[]): string[] {
  const handoff = step.output?.structuredHandoff;
  const criteria = [
    ...gapFiles.map((filePath) => `Resolve WorkUnit scope gap for ${filePath}.`),
    ...(handoff?.nextActions ?? []),
    ...(handoff?.risks ?? []),
  ].map((item) => item.trim()).filter(Boolean);
  return criteria.length ? [...new Set(criteria)].slice(0, 12) : ["Resolve the worker-reported scope gap and verify the repair."];
}

function workUnitIdsOwningFiles(run: RunState, files: string[]): string[] {
  const wanted = new Set(files.map(normalizeMetricFilePath));
  return [...new Set((run.workUnits ?? [])
    .filter((unit) => (unit.files ?? []).map(normalizeMetricFilePath).some((filePath) => wanted.has(filePath)))
    .map((unit) => unit.id))];
}

function priorWorkerChangedFilesForReviewer(run: RunState, reviewerStep: RunStepState, implementationUnitId: string | undefined): string[] {
  const reviewerIndex = run.steps.indexOf(reviewerStep);
  if (reviewerIndex < 0) return [];
  const workerIndex = findLastIndex(run.steps, (candidate, index) => (
    index < reviewerIndex
    && candidate.agent === "worker"
    && isUsableStepHandoff(candidate)
    && (
      !implementationUnitId
      || candidate.workUnitId === implementationUnitId
      || candidate.workUnitId === reviewerStep.workUnitId
    )
  ));
  return workerIndex >= 0 ? run.steps[workerIndex]?.output?.structuredHandoff?.changedFiles ?? [] : [];
}

function repairAcceptanceCriteria(verdict: ReviewerVerdict | undefined): string[] {
  const criteria = [
    ...(verdict?.blockingFindings ?? []),
    ...(verdict?.missingCoverage ?? []),
    verdict?.requiredRepair ?? "",
  ].map((item) => item.trim()).filter(Boolean);
  return criteria.length ? [...new Set(criteria)].slice(0, 12) : ["Resolve the reviewer-confirmed blocking findings and verify the repair."];
}

function normalizedRepairFiles(files: string[]): string[] {
  return [...new Set(files.map(normalizeRepairFile).filter((filePath): filePath is string => Boolean(filePath)))];
}

function normalizeRepairFile(filePath: string): string | undefined {
  const normalized = normalizeMetricFilePath(filePath);
  if (!normalized || normalized === "." || normalized === "..") return undefined;
  if (path.isAbsolute(normalized) || normalized.startsWith("../") || normalized.includes("/../")) return undefined;
  return normalized;
}

function uniqueRepairUnitId(run: RunState, baseId: string): string {
  let id = baseId;
  let suffix = 2;
  while (run.workUnits?.some((unit) => unit.id === id)) {
    id = `${baseId}-${suffix}`;
    suffix += 1;
  }
  return id;
}

function findImplementationWorkerIndexForReviewer(run: RunState, reviewerStep: RunStepState, reviewerIndex: number): number {
  const fileMatchedWorkerIndex = findImplementationWorkerIndexForReviewerFiles(run, reviewerStep, reviewerIndex);
  if (fileMatchedWorkerIndex >= 0) return fileMatchedWorkerIndex;
  const sameUnitWorkerIndex = findLastIndex(run.steps, (candidate, index) => (
    index < reviewerIndex
    && candidate.agent === "worker"
    && candidate.workUnitId === reviewerStep.workUnitId
    && isUsableStepHandoff(candidate)
  ));
  if (sameUnitWorkerIndex >= 0) return sameUnitWorkerIndex;
  const dependencyWorkerIndex = findImplementationWorkerIndexForReviewerDependencies(run, reviewerStep, reviewerIndex);
  if (dependencyWorkerIndex >= 0) return dependencyWorkerIndex;
  return findLastIndex(run.steps, (candidate, index) => index < reviewerIndex && candidate.agent === "worker" && isUsableStepHandoff(candidate));
}

function findImplementationWorkerIndexForReviewerFiles(run: RunState, reviewerStep: RunStepState, reviewerIndex: number): number {
  const targetFiles = reviewerRepairTargetFiles(reviewerStep);
  if (targetFiles.length === 0) return -1;
  const targetSet = new Set(targetFiles);
  let bestIndex = -1;
  let bestScore = 0;
  for (let index = 0; index < reviewerIndex; index += 1) {
    const candidate = run.steps[index];
    if (!candidate || candidate.agent !== "worker" || !isUsableStepHandoff(candidate)) continue;
    const score = workerOwnershipFileScore(run, candidate, targetSet);
    if (score <= bestScore) continue;
    bestScore = score;
    bestIndex = index;
  }
  return bestIndex;
}

function reviewerRepairTargetFiles(reviewerStep: RunStepState): string[] {
  const verdict = reviewerStep.output?.reviewerVerdict;
  if (!verdict) return [];
  return normalizedRepairFiles([
    ...(verdict.repairFiles ?? []),
    ...(verdict.evidenceRecords ?? [])
      .filter((record) => record.status === "fail")
      .flatMap((record) => record.paths),
    ...pathsMentionedInTexts([
      ...verdict.blockingFindings,
      ...verdict.missingCoverage,
      verdict.requiredRepair ?? "",
    ]),
  ]);
}

function workerOwnershipFileScore(run: RunState, step: RunStepState, targetFiles: Set<string>): number {
  const unit = step.workUnitId ? run.workUnits?.find((candidate) => candidate.id === step.workUnitId) : undefined;
  const candidateFiles = [
    ...(step.output?.structuredHandoff?.changedFiles ?? []),
    ...(step.metrics?.filesTouched ?? []),
    ...(unit?.files ?? []),
  ].map(normalizeMetricFilePath).filter(Boolean);
  let score = 0;
  for (const filePath of candidateFiles) {
    if (targetFiles.has(filePath)) score += 1;
  }
  return score;
}

function findImplementationWorkerIndexForReviewerDependencies(run: RunState, reviewerStep: RunStepState, reviewerIndex: number): number {
  const reviewerUnit = reviewerStep.workUnitId ? run.workUnits?.find((candidate) => candidate.id === reviewerStep.workUnitId) : undefined;
  const dependencyUnitIds = new Set(reviewerUnit?.dependencies ?? []);
  if (dependencyUnitIds.size !== 1) return -1;
  return findLastIndex(run.steps, (candidate, index) => (
    index < reviewerIndex
    && candidate.agent === "worker"
    && Boolean(candidate.workUnitId && dependencyUnitIds.has(candidate.workUnitId))
    && isUsableStepHandoff(candidate)
  ));
}

function compactRunVerificationEvidence(run: RunState): string {
  const evidence = [
    ...(run.mutationLedger ?? []).flatMap((entry) => entry.verification),
    ...(run.verificationLedger ?? []).flatMap((entry) => entry.evidence),
  ]
    .map((item) => item.trim())
    .filter(Boolean);
  return [...new Set(evidence)].slice(-6).map((item) => truncateText(item, 220)).join("; ");
}

function reviewerMissingStructuredVerdictNeedsRepair(step: Pick<RunStepState, "agent" | "status" | "output">): boolean {
  return step.agent === "reviewer" && isUsableStepHandoff(step) && !step.output?.reviewerVerdict;
}

function reviewerPassNeedsEvidenceRepair(step: Pick<RunStepState, "agent" | "status" | "output">, options: { expectsReviewedContent?: boolean; expectsVerify?: boolean }): boolean {
  if (step.agent !== "reviewer" || !isUsableStepHandoff(step)) return false;
  const verdict = step.output?.reviewerVerdict;
  if (!verdict || verdict.verdict !== "pass") return false;
  if (verdict.blockingFindings.length > 0 || verdict.missingCoverage.length > 0 || Boolean(verdict.requiredRepair?.trim())) return false;
  let needsRepair = false;
  if (options.expectsReviewedContent && !hasStructuredReviewedContentEvidence(verdict.evidenceRecords)) {
    const warning = "Structured Reviewer Verdict pass lacks real evidence of reviewed files or content.";
    step.output!.warnings = appendUnique(step.output!.warnings, warning);
    needsRepair = true;
  }
  if (options.expectsVerify && !hasStructuredVerificationEvidence(verdict.evidenceRecords)) {
    const warning = "Structured Reviewer Verdict pass lacks real verification evidence for a route that expects verify.";
    step.output!.warnings = appendUnique(step.output!.warnings, warning);
    needsRepair = true;
  }
  return needsRepair;
}

function implementationPassNeedsPermanentTestRepair(run: RunState, workerIndex: number, reviewerIndex: number): boolean {
  if (rootTaskExplicitlyForbidsTestEdits(run.rootTask ?? "")) return false;
  const inspectedSteps = run.steps.slice(0, reviewerIndex + 1);
  const implementationSteps = run.steps.slice(workerIndex, reviewerIndex + 1);
  const touchedPaths = implementationSteps.flatMap((candidate) => candidate.metrics?.filesTouched ?? []);
  if (!touchedPaths.some(isProductImplementationPath)) return false;
  if (touchedPaths.some(isTestPath)) return false;
  const knownPaths = inspectedSteps.flatMap((candidate) => [
    ...(candidate.metrics?.filesRead ?? []),
    ...(candidate.metrics?.filesTouched ?? []),
  ]);
  return knownPaths.some(isTestPath);
}

function rootTaskExplicitlyForbidsTestEdits(task: string): boolean {
  return /\b(?:do\s+not|don't|without)\s+(?:edit|modify|change|add|update|write|touch)\s+(?:the\s+)?(?:tests?|test\s+files?|test\s+suite)\b/i.test(task)
    || /\bno\s+(?:edites?|modifiques?|cambies?|agregues?|anadas?|añadas?|toques?)\s+(?:los\s+|las\s+)?(?:tests?|pruebas?|archivos?\s+de\s+prueba|suite\s+de\s+tests?)\b/i.test(task);
}

function isProductImplementationPath(filePath: string): boolean {
  const normalized = normalizeMetricFilePath(filePath);
  if (!normalized || isTestPath(normalized) || isDocumentationPath(normalized)) return false;
  return /\.(?:c|cc|cpp|cxx|h|hh|hpp|hxx|m|mm|go|rs|zig|ts|tsx|js|jsx|mjs|cjs|py|rb|php|java|kt|kts|swift|cs)$/i.test(normalized);
}

function isTestPath(filePath: string): boolean {
  const normalized = normalizeMetricFilePath(filePath);
  if (!normalized) return false;
  const base = normalized.split("/").pop() ?? normalized;
  return /(?:^|\/)(?:tests?|__tests__|specs?|fixtures?)(?:\/|$)/i.test(normalized)
    || /\.(?:test|spec)\.[cm]?[jt]sx?$/i.test(base)
    || /(?:^|[_-])test[_-].+\.(?:c|cc|cpp|cxx|h|hh|hpp|hxx|go|rs|zig|py|rb|php|java|kt|swift|cs)$/i.test(base)
    || /.+[_-]test\.(?:c|cc|cpp|cxx|h|hh|hpp|hxx|go|rs|zig|py|rb|php|java|kt|swift|cs)$/i.test(base);
}

function isDocumentationPath(filePath: string): boolean {
  return /\.(?:md|mdx|txt|rst|adoc)$/i.test(normalizeMetricFilePath(filePath));
}

function normalizeMetricFilePath(filePath: string): string {
  return filePath.replace(/\\/g, "/").replace(/^\.\//, "").trim();
}

export function reviewerHandoffNeedsRepair(step: Pick<RunStepState, "agent" | "status" | "output">, options: { expectsReviewedContent?: boolean; expectsVerify?: boolean } = {}): boolean {
  if (step.agent !== "reviewer" || !isUsableStepHandoff(step)) return false;
  if (reviewerPassNeedsEvidenceRepair(step, options)) return true;
  return reviewerBlockingHandoffNeedsRepair(step);
}

function reviewerBlockingHandoffNeedsRepair(step: Pick<RunStepState, "agent" | "status" | "output">): boolean {
  if (step.agent !== "reviewer" || !isUsableStepHandoff(step)) return false;
  const verdict = step.output?.reviewerVerdict;
  if (!verdict) return true;
  return verdict.verdict !== "pass"
    || verdict.blockingFindings.length > 0
    || verdict.missingCoverage.length > 0
    || Boolean(verdict.requiredRepair?.trim());
}

function hasStructuredReviewedContentEvidence(records: ReviewerEvidenceRecord[] | undefined): boolean {
  return (records ?? []).some((record) => record.kind === "reviewed-content" && record.paths.length > 0);
}

function hasStructuredVerificationEvidence(records: ReviewerEvidenceRecord[] | undefined): boolean {
  return (records ?? []).some((record) =>
    record.kind === "verification"
    && record.status === "pass"
    && Boolean(record.command?.trim())
    && Boolean(record.result?.trim())
  );
}

function appendImplementationReviewRepair(
  run: RunState,
  cycle: number,
  repairWorker: RunStepState,
  repairReviewer: RunStepState,
  reason: string,
  options: { afterStageId?: string } = {},
): void {
  const routeReason = run.route.reason.includes("Implementation review repair queued by pi-chalin")
    ? run.route.reason
    : `${run.route.reason} Implementation review repair queued by pi-chalin ${reason}.`;
  const workerPlanStep = { agent: repairWorker.agent, task: repairWorker.task, budget: repairWorker.budget };
  const reviewerPlanStep = { agent: repairReviewer.agent, task: repairReviewer.task, budget: repairReviewer.budget };

  if (run.route.plan?.kind === "dag") {
    const workerStageId = `review-repair-${cycle}-worker`;
    const reviewerStageId = `review-repair-${cycle}-reviewer`;
    const workerStepId = `${workerStageId}:step-1`;
    const reviewerStepId = `${reviewerStageId}:step-1`;
    const repairSteps = [
      { ...repairWorker, id: workerStepId, stageId: workerStageId },
      { ...repairReviewer, id: reviewerStepId, stageId: reviewerStageId, dependencies: [workerStepId] },
    ];
    const repairStages = [
      { id: workerStageId, tasks: [workerPlanStep] },
      { id: reviewerStageId, tasks: [reviewerPlanStep] },
    ];
    insertRunStepsAfterStage(run, options.afterStageId, repairSteps);
    insertDagStagesAfter(run.route.plan, options.afterStageId, repairStages);
    run.route.agents = [...run.route.agents, "worker", "reviewer"];
    run.route.needsArtifacts = true;
    run.route.reason = routeReason;
    return;
  }

  const existingPlanSteps: AgentStep[] = run.route.plan?.kind === "sequential"
    ? run.route.plan.steps
    : run.steps.map((candidate) => ({ agent: candidate.agent, task: candidate.task, budget: candidate.budget }));
  run.steps.push(repairWorker, repairReviewer);
  run.route = {
    ...run.route,
    kind: "multi-agent-sequential",
    agents: [...run.route.agents, "worker", "reviewer"],
    needsArtifacts: true,
    reason: routeReason,
    plan: {
      kind: "sequential",
      steps: [...existingPlanSteps, workerPlanStep, reviewerPlanStep],
    },
  };
}

function appendReviewerEvidenceRepair(
  run: RunState,
  cycle: number,
  repairReviewer: RunStepState,
  reason: string,
  options: { afterStageId?: string } = {},
): void {
  const routeReason = run.route.reason.includes("Implementation review repair queued by pi-chalin")
    ? run.route.reason
    : `${run.route.reason} Implementation review repair queued by pi-chalin ${reason}.`;
  const reviewerPlanStep = { agent: repairReviewer.agent, task: repairReviewer.task, budget: repairReviewer.budget };

  if (run.route.plan?.kind === "dag") {
    const reviewerStageId = `review-repair-${cycle}-reviewer`;
    const repairStep = { ...repairReviewer, id: `${reviewerStageId}:step-1`, stageId: reviewerStageId };
    const repairStage = { id: reviewerStageId, tasks: [reviewerPlanStep] };
    insertRunStepsAfterStage(run, options.afterStageId, [repairStep]);
    insertDagStagesAfter(run.route.plan, options.afterStageId, [repairStage]);
    run.route.agents = [...run.route.agents, "reviewer"];
    run.route.needsArtifacts = true;
    run.route.reason = routeReason;
    return;
  }

  const existingPlanSteps: AgentStep[] = run.route.plan?.kind === "sequential"
    ? run.route.plan.steps
    : run.steps.map((candidate) => ({ agent: candidate.agent, task: candidate.task, budget: candidate.budget }));
  run.steps.push(repairReviewer);
  run.route = {
    ...run.route,
    kind: "multi-agent-sequential",
    agents: [...run.route.agents, "reviewer"],
    needsArtifacts: true,
    reason: routeReason,
    plan: {
      kind: "sequential",
      steps: [...existingPlanSteps, reviewerPlanStep],
    },
  };
}

function insertRunStepsAfterStage(run: RunState, afterStageId: string | undefined, steps: RunStepState[]): void {
  if (!afterStageId) {
    run.steps.push(...steps);
    return;
  }
  const lastStepInStage = findLastIndex(run.steps, (step) => (step.stageId ?? stageIdForStep(step.id)) === afterStageId);
  if (lastStepInStage < 0) {
    run.steps.push(...steps);
    return;
  }
  run.steps.splice(lastStepInStage + 1, 0, ...steps);
}

function insertDagStagesAfter(plan: Extract<RoutePlan, { kind: "dag" }>, afterStageId: string | undefined, stages: Extract<RoutePlan, { kind: "dag" }>["stages"]): void {
  if (!afterStageId) {
    plan.stages.push(...stages);
    return;
  }
  const stageIndex = plan.stages.findIndex((stage) => stage.id === afterStageId);
  if (stageIndex < 0) {
    plan.stages.push(...stages);
    return;
  }
  plan.stages.splice(stageIndex + 1, 0, ...stages);
}

function repairCycleCount(run: RunState, kind: RunStepRepairKind): number {
  const cycles = new Set<string>();
  const repairSteps = run.steps
    .map((step) => ({ step, sequence: reviewRepairSequence(step.id) }))
    .filter((entry): entry is { step: RunStepState; sequence: string } => Boolean(entry.sequence));
  for (const { step, sequence } of repairSteps) {
    if (step.repairKind === kind) cycles.add(`${step.repairKind}:${sequence}`);
  }
  return cycles.size;
}

function nextReviewRepairSequence(run: RunState): number {
  const sequences = run.steps
    .map((step) => Number(reviewRepairSequence(step.id)))
    .filter((sequence) => Number.isFinite(sequence));
  return Math.max(0, ...sequences) + 1;
}

function reviewRepairSequence(stepId: string): string | undefined {
  const numbered = /^review-repair-(\d+)-(?:worker|reviewer)(?::|$)/.exec(stepId);
  if (numbered?.[1]) return numbered[1];
  return undefined;
}

function hasLaterImplementationRepair(run: RunState, stepIndex: number): boolean {
  return run.steps.some((candidate, index) => index > stepIndex && candidate.id.startsWith("review-repair-"));
}

function maxImplementationReviewRepairCycles(): number {
  const parsed = Number(process.env.PI_CHALIN_IMPLEMENTATION_REVIEW_REPAIR_CYCLES);
  if (!Number.isFinite(parsed)) return 2;
  return Math.max(0, Math.min(4, Math.floor(parsed)));
}

export function shouldStopAfterDagStage(stageSteps: Pick<RunStepState, "status" | "agent" | "output" | "error">[], agents: Map<string, AgentDefinition>): boolean {
  if (stageSteps.some((step) => step.status === "paused")) return true;
  const failedSteps = stageSteps.filter((step) => step.status === "failed");
  if (failedSteps.length === 0) return false;
  const usableSteps = stageSteps.filter((step) => isUsableStepStatus(step.status));
  if (usableSteps.length === 0) return true;
  return failedSteps.some((step) => isWriterAgent(agents.get(step.agent)));
}

export function recoverPausedReadOnlyDagStage(stageSteps: RunStepState[], agents: Map<string, AgentDefinition>): number {
  if (!stageSteps.some((step) => isUsableStepStatus(step.status))) return 0;
  let recovered = 0;
  for (const step of stageSteps) {
    if (step.status !== "paused") continue;
    if (step.pauseReason !== "idle-stall") continue;
    if (isWriterAgent(agents.get(step.agent))) continue;
    step.status = "failed";
    step.pauseReason = undefined;
    step.error ??= "SDK runner idle stalled before producing a handoff.";
    recovered += 1;
  }
  return recovered;
}

function isWriterAgent(agent?: AgentDefinition): boolean {
  if (!agent) return false;
  return agent.concern === "implementation"
    || agent.concern === "conflict-resolution"
    || agent.capabilities.includes("edit-files")
    || agent.capabilities.includes("write-new-files");
}

type StructuredHandoffContractAction = "accept" | "warn" | "checkpoint" | "fail";

export function applyStructuredHandoffContract(run: RunState | undefined, step: RunStepState, agent?: AgentDefinition): StructuredHandoffContractAction {
  const output = step.output;
  if (!output) return "accept";
  if (isReviewerStep(step, agent) && output.reviewerVerdict) return "accept";
  if (output.structuredHandoff) {
    const fieldGaps = structuredHandoffFieldGaps(run, step, agent);
    if (fieldGaps.length === 0) {
      const blockedNoMutationReason = structuredHandoffBlockedNoMutationReason(run, step, agent);
      if (blockedNoMutationReason) {
        output.warnings = appendUnique(output.warnings, blockedNoMutationReason);
        if (run) pushUniqueWarnings(run, [blockedNoMutationReason]);
        if (step.status === "complete") {
          step.status = "failed";
          step.error = blockedNoMutationReason;
          return "fail";
        }
        return "warn";
      }
      return "accept";
    }
    const action = structuredHandoffContractAction(run, step, agent);
    const reason = structuredHandoffFieldGapReason(step, fieldGaps);
    output.warnings = appendUnique(output.warnings, reason);
    if (run) pushUniqueWarnings(run, [reason]);
    if (action === "warn") return "warn";
    if (action === "fail") {
      step.status = "failed";
      step.error = reason;
      return "fail";
    }
    if (step.status === "complete") {
      step.status = "checkpointed";
      step.checkpoint = {
        kind: "handoff-contract",
        continuation: "review",
        reason,
      };
    }
    return "checkpoint";
  }
  const action = structuredHandoffContractAction(run, step, agent);
  if (action === "accept") return "accept";

  const reason = structuredHandoffContractReason(step, output.handoffContract ?? "missing");
  output.warnings = appendUnique(output.warnings, reason);
  if (run) pushUniqueWarnings(run, [reason]);

  if (action === "warn") return "warn";
  if (action === "fail") {
    step.status = "failed";
    step.error = reason;
    return "fail";
  }

  if (step.status === "complete") {
    step.status = "checkpointed";
    step.checkpoint = {
      kind: "handoff-contract",
      continuation: "review",
      reason,
    };
  }
  return "checkpoint";
}

function isReviewerStep(step: RunStepState, agent?: AgentDefinition): boolean {
  return step.agent === "reviewer" || agent?.concern === "review";
}

function structuredHandoffContractAction(run: RunState | undefined, step: RunStepState, agent?: AgentDefinition): StructuredHandoffContractAction {
  if (step.status !== "complete") return "warn";
  const expectedEffects = expectedEffectsForStep(run, step);
  if (isWriterAgent(agent) && !hasStepSpecificExpectedEffects(run, step)) return "fail";
  if (expectedEffects.has("write") && isWriteResponsibleStep(step, agent)) return "fail";
  if (expectedEffects.has("verify") && isVerificationResponsibleStep(step, agent)) return "fail";
  if (requiresContractualHandoff(run, step, agent)) return "checkpoint";
  return "warn";
}

function requiresContractualHandoff(run: RunState | undefined, step: RunStepState, agent?: AgentDefinition): boolean {
  const concern = agent?.concern;
  if (concern === "planning" || concern === "context-building" || concern === "review" || concern === "decision-consistency" || concern === "conflict-resolution") return true;
  const expectedEffects = expectedEffectsForStep(run, step);
  if (expectedEffects.has("write") || expectedEffects.has("verify")) return true;
  if (run?.route.plan?.kind === "dag") return true;
  const feedsAnotherStep = run ? run.steps.indexOf(step) >= 0 && run.steps.indexOf(step) < run.steps.length - 1 : false;
  if (feedsAnotherStep && concern !== "recon" && concern !== "research") return true;
  return false;
}

function structuredHandoffFieldGaps(run: RunState | undefined, step: RunStepState, agent?: AgentDefinition): string[] {
  const handoff = step.output?.structuredHandoff;
  if (!handoff) return [];
  const expectedEffects = expectedEffectsForStep(run, step);
  const gaps: string[] = [];
  if (
    requiresChangedFilesInStructuredHandoff(expectedEffects, step, agent)
    && handoff.changedFiles.length === 0
    && !isVerifiedNoMutationHandoff(step, handoff)
    && !isVerifiedBlockedNoMutationHandoff(step, handoff)
  ) {
    gaps.push("changedFiles is required for writer/write handoffs");
  }
  if (requiresVerificationInStructuredHandoff(expectedEffects, step, agent) && handoff.verification.length === 0) {
    gaps.push("verification is required for verify handoffs");
  }
  return gaps;
}

function requiresChangedFilesInStructuredHandoff(expectedEffects: Set<RouteExpectedEffect>, step: RunStepState, agent?: AgentDefinition): boolean {
  return expectedEffects.has("write") && isWriteResponsibleStep(step, agent);
}

function requiresVerificationInStructuredHandoff(expectedEffects: Set<RouteExpectedEffect>, step: RunStepState, agent?: AgentDefinition): boolean {
  if (!expectedEffects.has("verify")) return false;
  return isWriteResponsibleStep(step, agent) || isVerificationResponsibleStep(step, agent);
}

function isVerifiedNoMutationHandoff(step: RunStepState, handoff: NonNullable<AgentOutput["structuredHandoff"]>): boolean {
  return handoff.verification.length > 0
    && (step.metrics?.filesTouched?.length ?? 0) === 0
    && handoff.risks.length === 0
    && handoff.nextActions.length === 0;
}

function isVerifiedBlockedNoMutationHandoff(step: RunStepState, handoff: NonNullable<AgentOutput["structuredHandoff"]>): boolean {
  return handoff.changedFiles.length === 0
    && handoff.verification.length > 0
    && (step.metrics?.filesTouched?.length ?? 0) === 0
    && (handoff.risks.length > 0 || handoff.nextActions.length > 0);
}

function structuredHandoffBlockedNoMutationReason(run: RunState | undefined, step: RunStepState, agent?: AgentDefinition): string | undefined {
  const handoff = step.output?.structuredHandoff;
  if (!handoff) return undefined;
  const expectedEffects = expectedEffectsForStep(run, step);
  if (!requiresChangedFilesInStructuredHandoff(expectedEffects, step, agent)) return undefined;
  if (!isVerifiedBlockedNoMutationHandoff(step, handoff)) return undefined;
  const details = [
    handoff.summary ? truncateText(handoff.summary, 220) : undefined,
    handoff.risks[0] ? `risk: ${truncateText(handoff.risks[0], 180)}` : undefined,
    handoff.nextActions[0] ? `next action: ${truncateText(handoff.nextActions[0], 180)}` : undefined,
  ].filter((item): item is string => Boolean(item)).join(" ");
  return `${step.agent}/${step.id} verified that no writer mutation was safe or possible despite a write contract${details ? `: ${details}` : "."}`;
}

function isWriteResponsibleStep(step: RunStepState, agent?: AgentDefinition): boolean {
  return isWriterAgent(agent) || /^(?:worker|writer|implementer|conflict-resolver)$/i.test(step.agent);
}

function isVerificationResponsibleStep(step: RunStepState, agent?: AgentDefinition): boolean {
  if (agent?.concern === "review" || agent?.concern === "conflict-resolution" || agent?.capabilities.includes("validate")) return true;
  if (agent) return false;
  return /^(?:reviewer|verifier|validator|qa)$/i.test(step.agent) || /\b(?:verify|validate|review|test)\b/i.test(step.task);
}

function routeExpectedEffects(run: RunState | undefined): Set<RouteExpectedEffect> {
  return new Set(run?.route.expectedEffects ?? ["read"]);
}

function expectedEffectsForStep(run: RunState | undefined, step: RunStepState): Set<RouteExpectedEffect> {
  const unit = step.workUnitId ? run?.workUnits?.find((candidate) => candidate.id === step.workUnitId) : undefined;
  return new Set(unit?.expectedEffects?.length ? unit.expectedEffects : run?.route.expectedEffects ?? ["read"]);
}

function hasStepSpecificExpectedEffects(run: RunState | undefined, step: RunStepState): boolean {
  const unit = step.workUnitId ? run?.workUnits?.find((candidate) => candidate.id === step.workUnitId) : undefined;
  if (!unit?.expectedEffects.length) return false;
  return !sameExpectedEffects(unit.expectedEffects, run?.route.expectedEffects ?? ["read"]);
}

function sameExpectedEffects(left: RouteExpectedEffect[], right: RouteExpectedEffect[]): boolean {
  if (left.length !== right.length) return false;
  const rightSet = new Set(right);
  return left.every((effect) => rightSet.has(effect));
}

function structuredHandoffContractReason(step: RunStepState, contract: NonNullable<AgentOutput["handoffContract"]>): string {
  const mode = contract === "structured" ? "provided a structured handoff" : "did not provide a usable handoff";
  return `${step.agent}/${step.id} ${mode}; structured ## Agent Handoff is required before treating this step as a contractual multi-agent result.`;
}

function structuredHandoffFieldGapReason(step: RunStepState, gaps: string[]): string {
  return `${step.agent}/${step.id} structured ## Agent Handoff is missing required contract field(s): ${gaps.join("; ")}.`;
}

function applyWorkspaceHygieneGate(run: RunState, step: RunStepState, agent: AgentDefinition | undefined, cwd: string, dirtyPathBaseline: string[], options: { isolatedWorktree?: boolean } = {}): void {
  if (!step.output || step.status !== "complete") return;
  const changedFiles = step.output.structuredHandoff?.changedFiles ?? [];
  const newDirtyEntries = readWorkspaceDirtyEntries(cwd).filter((entry) => !dirtyPathBaseline.includes(entry.path));
  const newDirtyPaths = newDirtyEntries.map((entry) => entry.path);
  const initialProblems = workspaceHygieneProblemsForDirtyPaths(newDirtyPaths, changedFiles);
  const cleanedTransientOutputs = cleanTransientGeneratedWorkspaceOutputs(
    cwd,
    newDirtyEntries.filter((entry) => initialProblems.includes(normalizeMetricFilePath(entry.path))),
    step.metrics?.filesTouched ?? [],
  );
  if (cleanedTransientOutputs.length > 0) {
    const cleanupReason = `Cleaned transient generated output(s) left by verification/build/setup: ${cleanedTransientOutputs.slice(0, 8).join(", ")}${cleanedTransientOutputs.length > 8 ? `, and ${cleanedTransientOutputs.length - 8} more` : ""}.`;
    step.output.warnings = appendUnique(step.output.warnings, cleanupReason);
    pushUniqueWarnings(run, [cleanupReason]);
  }
  const problems = initialProblems.filter((filePath) => !cleanedTransientOutputs.includes(filePath));
  if (problems.length === 0) return;

  const reason = workspaceHygieneProblemReason(problems);
  step.output.warnings = appendUnique(step.output.warnings, reason);
  pushUniqueWarnings(run, [reason]);
  if (options.isolatedWorktree) return;

  if (isWriterAgent(agent) || isWriteResponsibleStep(step, agent)) {
    step.status = "failed";
    step.error = reason;
    return;
  }

  if (step.agent === "reviewer" || agent?.concern === "review") {
    step.output.reviewerVerdict ??= {
      verdict: "gap",
      blockingFindings: [],
      missingCoverage: [],
      evidence: [],
      requiredRepair: "Clean transient generated outputs or list intentional generated files in changedFiles.",
    };
    step.output.reviewerVerdict.verdict = "gap";
    step.output.reviewerVerdict.missingCoverage = appendUnique(step.output.reviewerVerdict.missingCoverage, reason);
    if (!step.output.reviewerVerdict.requiredRepair) {
      step.output.reviewerVerdict.requiredRepair = "Clean transient generated outputs or list intentional generated files in changedFiles.";
    }
  }
}

function applyFatalToolPolicyGate(run: RunState, step: RunStepState, agent: AgentDefinition | undefined): void {
  if (step.status !== "complete") return;
  const fatalViolations = (step.metrics?.policyViolations ?? []).filter(isFatalToolPolicyViolation);
  if (fatalViolations.length === 0) return;
  const reason = `Tool policy violation(s): ${fatalViolations.slice(0, 5).join("; ")}${fatalViolations.length > 5 ? `; and ${fatalViolations.length - 5} more` : ""}.`;
  step.output!.warnings = appendUnique(step.output!.warnings, reason);
  pushUniqueWarnings(run, [reason]);
  if (isWriterAgent(agent) || isWriteResponsibleStep(step, agent)) {
    step.status = "failed";
    step.error = reason;
  }
}

export function reconcileDeclaredGeneratedScopeViolations(run: RunState, step: RunStepState, cwd?: string): string[] {
  if (step.status !== "complete") return [];
  const metrics = step.metrics;
  const output = step.output;
  const handoff = output?.structuredHandoff;
  if (!metrics?.policyViolations?.length || !output || !handoff || handoff.verification.length === 0) return [];
  const unit = run.workUnits?.find((candidate) => candidate.id === step.workUnitId);
  if (!unit) return [];
  const changedFileList = handoff.changedFiles.map(normalizeMetricFilePath).filter(Boolean);
  const changedFiles = new Set(changedFileList);
  const filesTouched = new Set((metrics.filesTouched ?? []).map(normalizeMetricFilePath).filter(Boolean));
  const currentUnitFiles = new Set((unit.files ?? []).map(normalizeMetricFilePath).filter(Boolean));
  const removedGeneratedArtifacts = scopeViolationPaths(metrics.policyViolations)
    .filter((filePath) => changedFiles.has(filePath))
    .filter((filePath) => !filesTouched.has(filePath))
    .filter((filePath) => !currentUnitFiles.has(filePath))
    .filter((filePath) => Boolean(cwd) && !workspaceMetricPathExists(cwd!, filePath));
  if (removedGeneratedArtifacts.length > 0) {
    metrics.policyViolations = removeScopeViolationPaths(metrics.policyViolations, removedGeneratedArtifacts);
    handoff.changedFiles = handoff.changedFiles.filter((filePath) => !removedGeneratedArtifacts.includes(normalizeMetricFilePath(filePath)));
    const warning = `Ignored removed generated artifact(s) outside WorkUnit deliverables: ${removedGeneratedArtifacts.slice(0, 8).join(", ")}${removedGeneratedArtifacts.length > 8 ? `, and ${removedGeneratedArtifacts.length - 8} more` : ""}.`;
    output.warnings = appendUnique(output.warnings, warning);
    pushUniqueWarnings(run, [warning]);
  }
  const transientDependencyArtifacts = scopeViolationPaths(metrics.policyViolations)
    .filter((filePath) => changedFiles.has(filePath))
    .filter((filePath) => !filesTouched.has(filePath))
    .filter((filePath) => !currentUnitFiles.has(filePath))
    .filter(isDependencyResolutionArtifactPath)
    .filter((filePath) => !unitOwnsDependencyResolutionSurface(unit, changedFileList, filePath));
  if (transientDependencyArtifacts.length > 0) {
    metrics.policyViolations = removeScopeViolationPaths(metrics.policyViolations, transientDependencyArtifacts);
    handoff.changedFiles = handoff.changedFiles.filter((filePath) => !transientDependencyArtifacts.includes(normalizeMetricFilePath(filePath)));
    const warning = `Ignored transient dependency artifact(s) outside WorkUnit ownership: ${transientDependencyArtifacts.slice(0, 8).join(", ")}${transientDependencyArtifacts.length > 8 ? `, and ${transientDependencyArtifacts.length - 8} more` : ""}.`;
    output.warnings = appendUnique(output.warnings, warning);
    pushUniqueWarnings(run, [warning]);
  }
  const resolvable = scopeViolationPaths(metrics.policyViolations)
    .filter((filePath) => changedFiles.has(filePath) || changedFileList.length > 0)
    .filter((filePath) => !filesTouched.has(filePath))
    .filter((filePath) => !currentUnitFiles.has(filePath))
    .filter((filePath) => !looksLikeDirectoryPath(filePath))
    .filter((filePath) => !isDeclaredByAnotherWorkUnit(run, unit.id, filePath));
  if (resolvable.length === 0) return [];

  const resolved = new Set(resolvable);
  unit.files = [...new Set([...(unit.files ?? []), ...resolvable])];
  handoff.changedFiles = [...new Set([...handoff.changedFiles, ...resolvable])];
  metrics.policyViolations = metrics.policyViolations.flatMap((reason) => {
    const paths = scopeViolationPaths([reason]);
    if (paths.length === 0) return [reason];
    const unresolved = paths.filter((filePath) => !resolved.has(filePath));
    if (unresolved.length === paths.length) return [reason];
    return unresolved.length ? [`outside_work_unit_scope:${unresolved.join(",")}`] : [];
  });
  const warning = `Expanded WorkUnit scope from declared generated output(s): ${resolvable.slice(0, 8).join(", ")}${resolvable.length > 8 ? `, and ${resolvable.length - 8} more` : ""}.`;
  output.warnings = appendUnique(output.warnings, warning);
  pushUniqueWarnings(run, [warning]);
  return resolvable;
}

function isFatalToolPolicyViolation(reason: string): boolean {
  return reason.startsWith("outside_work_unit_scope:")
    || reason.startsWith("work_unit_scope_gap:")
    || reason.startsWith("policy_stopped_after_scope_violation:")
    || reason === "bash_denied_for_work_unit_scope";
}

function scopeViolationPaths(reasons: string[]): string[] {
  const paths: string[] = [];
  for (const reason of reasons) {
    if (!reason.startsWith("outside_work_unit_scope:")) continue;
    const raw = reason.slice("outside_work_unit_scope:".length);
    for (const item of raw.split(",")) {
      const normalized = normalizeMetricFilePath(item);
      if (normalized && normalized !== "unknown") paths.push(normalized);
    }
  }
  return [...new Set(paths)];
}

function workUnitScopeGapPaths(reasons: string[]): string[] {
  const paths: string[] = [];
  for (const reason of reasons) {
    if (!reason.startsWith("work_unit_scope_gap:")) continue;
    const raw = reason.slice("work_unit_scope_gap:".length);
    for (const item of raw.split(",")) {
      const normalized = normalizeRepairFile(item);
      if (normalized) paths.push(normalized);
    }
  }
  return [...new Set(paths)];
}

function isDeclaredByAnotherWorkUnit(run: RunState, unitId: string, filePath: string): boolean {
  const normalized = normalizeMetricFilePath(filePath);
  return Boolean(run.workUnits?.some((unit) => unit.id !== unitId && (unit.files ?? []).map(normalizeMetricFilePath).includes(normalized)));
}

function removeScopeViolationPaths(reasons: string[], removedPaths: string[]): string[] {
  const removed = new Set(removedPaths.map(normalizeMetricFilePath));
  return reasons.flatMap((reason) => {
    const paths = scopeViolationPaths([reason]);
    if (paths.length === 0) return [reason];
    const unresolved = paths.filter((filePath) => !removed.has(filePath));
    if (unresolved.length === paths.length) return [reason];
    return unresolved.length ? [`outside_work_unit_scope:${unresolved.join(",")}`] : [];
  });
}

function unitOwnsDependencyResolutionSurface(unit: WorkUnit, changedFiles: string[], artifactPath: string): boolean {
  const artifactDir = parentMetricDir(artifactPath);
  const candidateFiles = [...(unit.files ?? []), ...changedFiles]
    .map(normalizeMetricFilePath)
    .filter((filePath) => filePath !== normalizeMetricFilePath(artifactPath));
  return candidateFiles.some((filePath) => parentMetricDir(filePath) === artifactDir && isDependencyManifestPath(filePath));
}

function isDependencyResolutionArtifactPath(filePath: string): boolean {
  const base = metricBaseName(filePath).toLowerCase();
  if (DEPENDENCY_RESOLUTION_ARTIFACTS.has(base)) return true;
  return base.endsWith(".lock") || base.endsWith("-lock.json") || base.endsWith(".lock.hcl");
}

function isDependencyManifestPath(filePath: string): boolean {
  return DEPENDENCY_MANIFESTS.has(metricBaseName(filePath).toLowerCase());
}

const DEPENDENCY_RESOLUTION_ARTIFACTS = new Set([
  ".terraform.lock.hcl",
  "cargo.lock",
  "composer.lock",
  "deno.lock",
  "flake.lock",
  "gemfile.lock",
  "go.sum",
  "go.work.sum",
  "mix.lock",
  "npm-shrinkwrap.json",
  "package-lock.json",
  "package.resolved",
  "pipfile.lock",
  "pnpm-lock.yaml",
  "poetry.lock",
  "uv.lock",
  "yarn.lock",
]);

const DEPENDENCY_MANIFESTS = new Set([
  "bunfig.toml",
  "cargo.toml",
  "composer.json",
  "deno.json",
  "deno.jsonc",
  "gemfile",
  "go.mod",
  "go.work",
  "mix.exs",
  "package.json",
  "pipfile",
  "pnpm-workspace.yaml",
  "pyproject.toml",
  "requirements.txt",
]);

function metricBaseName(filePath: string): string {
  const normalized = normalizeMetricFilePath(filePath);
  return normalized.split("/").pop() ?? normalized;
}

function parentMetricDir(filePath: string): string {
  const normalized = normalizeMetricFilePath(filePath);
  const index = normalized.lastIndexOf("/");
  return index >= 0 ? normalized.slice(0, index) : "";
}

function workspaceMetricPathExists(cwd: string, filePath: string): boolean {
  const resolved = resolveWorkspacePath(cwd, filePath);
  return Boolean(resolved && fs.existsSync(resolved));
}

function looksLikeDirectoryPath(filePath: string): boolean {
  return filePath.endsWith("/");
}

function readWorkspaceDirtyPaths(cwd: string): string[] {
  return readWorkspaceDirtyEntries(cwd).map((entry) => entry.path);
}

function readWorkspaceDirtyEntries(cwd: string): WorkspaceDirtyEntry[] {
  const result = spawnSync("git", ["status", "--short", "--untracked-files=all"], { cwd, encoding: "utf-8" });
  if (result.status !== 0) return [];
  return workspaceDirtyEntriesFromStatus(result.stdout);
}

export interface WorkspaceDirtyEntry {
  status: string;
  path: string;
}

export function workspaceDirtyPathsFromStatus(status: string): string[] {
  return workspaceDirtyEntriesFromStatus(status).map((entry) => entry.path);
}

export function workspaceDirtyEntriesFromStatus(status: string): WorkspaceDirtyEntry[] {
  return status
    .split(/\r?\n/)
    .flatMap((line) => {
      const entry = statusLineEntry(line);
      return entry ? [entry] : [];
    });
}

export function workspaceHygieneProblemsForDirtyPaths(dirtyPaths: string[], changedFiles: string[]): string[] {
  const declared = new Set(changedFiles.map(normalizeMetricFilePath).filter(Boolean));
  return [...new Set(dirtyPaths.map(normalizeMetricFilePath).filter(Boolean))]
    .filter((filePath) => !filePath.startsWith(".pi-chalin/"))
    .filter((filePath) => !declared.has(filePath));
}

export function cleanTransientGeneratedWorkspaceOutputs(cwd: string, dirtyEntries: WorkspaceDirtyEntry[], filesTouched: string[]): string[] {
  const touched = new Set(filesTouched.map(normalizeMetricFilePath).filter(Boolean));
  const cleaned: string[] = [];
  for (const entry of dirtyEntries) {
    const normalized = normalizeMetricFilePath(entry.path);
    if (!normalized || touched.has(normalized)) continue;
    if (entry.status !== "??") continue;
    if (!removeTransientGeneratedWorkspaceOutput(cwd, normalized)) continue;
    cleaned.push(normalized);
  }
  return cleaned;
}

function removeTransientGeneratedWorkspaceOutput(cwd: string, filePath: string): boolean {
  const fullPath = resolveWorkspacePath(cwd, filePath);
  if (!fullPath) return false;
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(fullPath);
  } catch {
    return false;
  }
  if (!stat.isFile() || stat.isSymbolicLink()) return false;
  if (!isLikelyBinaryFile(fullPath)) return false;
  try {
    fs.unlinkSync(fullPath);
    return true;
  } catch {
    return false;
  }
}

function resolveWorkspacePath(cwd: string, filePath: string): string | undefined {
  const fullPath = path.resolve(cwd, filePath);
  const relative = path.relative(cwd, fullPath);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) return undefined;
  return fullPath;
}

function isLikelyBinaryFile(filePath: string): boolean {
  let buffer: Buffer;
  try {
    const fd = fs.openSync(filePath, "r");
    try {
      buffer = Buffer.alloc(4096);
      const bytesRead = fs.readSync(fd, buffer, 0, buffer.length, 0);
      buffer = buffer.subarray(0, bytesRead);
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return false;
  }
  return buffer.includes(0);
}

function statusLineEntry(line: string): WorkspaceDirtyEntry | undefined {
  if (line.length < 4) return undefined;
  const status = line.slice(0, 2);
  const rawPath = line.slice(3).trim();
  if (!rawPath) return undefined;
  const arrowIndex = rawPath.lastIndexOf(" -> ");
  const filePath = arrowIndex >= 0 ? rawPath.slice(arrowIndex + 4) : rawPath;
  return { status, path: unquoteGitStatusPath(filePath) };
}

function unquoteGitStatusPath(filePath: string): string {
  const trimmed = filePath.trim();
  if (trimmed.length >= 2 && trimmed.startsWith("\"") && trimmed.endsWith("\"")) {
    return trimmed.slice(1, -1).replace(/\\"/g, "\"").replace(/\\\\/g, "\\");
  }
  return trimmed;
}

function workspaceHygieneProblemReason(problems: string[]): string {
  const shown = problems.slice(0, 8).join(", ");
  const remaining = problems.length > 8 ? `, and ${problems.length - 8} more` : "";
  return `Workspace hygiene gap: dirty/generated path(s) not listed in changedFiles: ${shown}${remaining}. Clean transient outputs or declare intentional generated files.`;
}

function appendUnique<T>(items: T[], item: T): T[] {
  return items.includes(item) ? items : [...items, item];
}

function runBlockedByHumanInput(run: Pick<RunState, "intentContract" | "recoveryState">): boolean {
  return run.intentContract?.requiresInterview === true || run.recoveryState?.blockedByHumanInput === true;
}

function isRunnableStep(step: RunStepState): boolean {
  return !isUsableStepHandoff(step) && step.status !== "failed" && step.status !== "skipped";
}

function markStepSkippedForHumanInputBlock(run: RunState, step: RunStepState): void {
  if (isUsableStepHandoff(step) || step.status === "failed" || step.status === "skipped") return;
  step.status = "skipped";
  step.skipReason ??= "Skipped because a prior step requires human input before safe continuation.";
  step.endedAt = new Date().toISOString();
  run.warnings = appendUnique(run.warnings, `${step.agent}/${step.id} was not executed because the run is blocked by required human input.`);
}

async function runSdkStage(
  run: RunState,
  stage: Extract<RoutePlan, { kind: "dag" }>["stages"][number],
  stageSteps: RunStepState[],
  context: WorkerRunnerContext,
  extensionContext: ExtensionContext,
  previous: string,
): Promise<{ paused: boolean; isolated: boolean }> {
  let isolation: WorktreeIsolationPlan | undefined;
  if (runBlockedByHumanInput(run)) return { paused: true, isolated: false };
  const runnableSteps = stageSteps.filter(isRunnableStep);
  if (runnableSteps.length === 0) return { paused: false, isolated: false };
  const isolationSteps = isolationAgentStepsForRunSteps(stageSteps);
  if (needsWorktreeIsolation(isolationSteps, context.agents)) {
    isolation = prepareWorktreeIsolation({ cwd: context.cwd, runId: `${run.id}-${stage.id}`, steps: isolationSteps, agents: context.agents });
    run.warnings.push(...isolation.warnings);
    if (!isolation.enabled) {
      const reason = `DAG stage ${stage.id} worktree isolation unavailable: ${isolation.reason}`;
      run.warnings.push(reason);
      for (const step of stageSteps) {
        step.status = "failed";
        step.error = reason;
        step.endedAt = new Date().toISOString();
      }
      persistRun(run);
      context.onUpdate?.(run);
      return { paused: false, isolated: Boolean(isolation.enabled) };
    }
    run.warnings.push(`DAG stage ${stage.id} worktree isolation active.`);
  }

  try {
    await Effect.runPromise(Effect.forEach(
      runnableSteps,
      (step) => Effect.tryPromise(() => {
        const localStepId = step.id.split(":").at(-1) ?? step.id;
        const worktree = isolation?.worktrees.find((item) => item.stepId === localStepId);
        return runSdkStep(step, context, extensionContext, run, { cwd: worktree?.path ?? context.cwd, previous });
      }),
      { concurrency: "unbounded" },
    ).pipe(Effect.withSpan(`runner.sdk.dag.${stage.id}`)));
    if (stageSteps.some((step) => step.status === "paused")) {
      persistRun(run);
      context.onUpdate?.(run);
      return { paused: true, isolated: Boolean(isolation?.enabled) };
    }

    if (isolation?.enabled) await mergeIsolatedStage(run, context, extensionContext, isolation, { scopeSteps: stageSteps });
    return { paused: false, isolated: Boolean(isolation?.enabled) };
  } finally {
    if (isolation?.enabled) run.warnings.push(...cleanupWorktrees({ cwd: context.cwd, plan: isolation }));
  }
}

function isolationAgentStepsForRunSteps(steps: RunStepState[]): AgentStep[] {
  return steps.map((step) => ({
    id: step.id.split(":").at(-1) ?? step.id,
    agent: step.agent,
    task: step.task,
    budget: step.budget,
  }));
}

async function runSdkStep(
  step: RunStepState,
  context: WorkerRunnerContext,
  extensionContext: ExtensionContext,
  run: RunState,
  options: { cwd: string; previous?: string },
): Promise<{ aborted: boolean; paused?: boolean; handoff?: string }> {
  if (runBlockedByHumanInput(run)) {
    markStepSkippedForHumanInputBlock(run, step);
    persistRun(run);
    context.onUpdate?.(run);
    return { aborted: false, paused: true };
  }
  if (step.status === "skipped") return { aborted: false, paused: runBlockedByHumanInput(run) };
  if (context.signal?.aborted) {
    markRunAborted(run, context, "pi-chalin run stopped by user.");
    return { aborted: true };
  }
  step.status = "running";
  step.error = undefined;
  step.pauseReason = undefined;
  step.startedAt = new Date().toISOString();
  persistRun(run);
  context.onUpdate?.(run);
  try {
    const agent = context.agents.get(step.agent);
    step.delegationDepth = currentSubagentDepth(run);
    let selectedModel = resolveAgentModel(agent, step.agent, context);
    step.model = selectedModel.label;
    step.modelResolution = selectedModel.resolution;
    pushUniqueWarnings(run, selectedModel.warnings);
    const budgetPolicy = budgetPolicyForSdkStep(policyForStep(agent, step, run.route.kind, run.route.risk), agent, options.previous);
    const originalRunCwd = runWorkspaceRoot(run);
    const promptPrevious = sanitizePromptWorkspaceText(options.previous, options.cwd, originalRunCwd);
    const promptTask = sanitizePromptWorkspaceText(step.task, options.cwd, originalRunCwd) ?? step.task;
    const promptOptions = buildPromptOptionsForStep(run, step, agent, budgetPolicy, options.cwd, promptPrevious);
    promptOptions.memoryContext = run.route.needsMemory ? await compactMemoryContextForStep(options.cwd, step, agent, options.previous) : undefined;
    const skillCatalog = SkillCatalog.load({ cwd: options.cwd, config: context.config ?? DEFAULT_CONFIG });
    const skillResolution = resolveSkillsForStep({
      catalog: skillCatalog,
      config: context.config ?? DEFAULT_CONFIG,
      agent,
      task: [promptTask, promptOptions.rootTask].filter(Boolean).join("\n"),
      routeKind: run.route.kind,
      risk: run.route.risk,
      explicitSkills: context.explicitSkills,
      disabledSkills: context.disabledSkills,
    });
    step.activeSkills = skillResolution.active;
    step.suggestedSkills = skillResolution.suggested;
    step.rejectedSkills = skillResolution.rejected.slice(0, 20);
    step.skillTraceEvents = [...skillCatalog.events, ...skillResolution.events];
    promptOptions.activeSkills = skillResolution.active;
    promptOptions.suggestedSkills = skillResolution.suggested;
    promptOptions.rejectedSkills = skillResolution.rejected;
    const maxToolCalls = budgetPolicy.caps.maxToolCalls;
    step.budget = budgetPolicy.profile;
    step.maxToolCalls = maxToolCalls;
    const dirtyPathBaseline = readWorkspaceDirtyPaths(options.cwd);
    const previousClaims = previousClaimsBeforeStep(run, step);
    const baseAllowedTools = childToolNames(agent, promptTask, run.route.needsArtifacts, Boolean(promptPrevious), {
      budgetProfile: budgetPolicy.profile,
      routeKind: run.route.kind,
      memoryEnabled: run.route.needsMemory,
      delegationDepth: currentSubagentDepth(run),
      maxDelegationDepth: maxSubagentDepth(),
      previousClaimsNeedAudit: claimsRequireAudit(previousClaims),
    });
    const allowedTools = allowedToolsForStep(effectiveSkillToolNames(baseAllowedTools, skillResolution.active.map((item) => item.skill)), run, step, options.cwd);
    const prompt = buildSdkPrompt(agent, promptTask, options.cwd, promptPrevious, budgetPolicy, "normal", promptOptions);
    const promptPhase = promptTokenomicsPhaseForStep(step, agent);
    const tokenomics = buildPromptTokenomics({
      childPrompt: promptPhase === "childPrompt" ? prompt : "",
      reviewer: promptPhase === "reviewer" ? prompt : "",
      repair: promptPhase === "repair" ? prompt : "",
      memory: promptOptions.memoryContext ?? "",
      handoff: options.previous ?? "",
    });
    let fallbackAttempted = false;
    let idleStallRetryAttempted = false;
    let accumulatedMetrics: RunStepMetrics | undefined;
    for (;;) {
      step.model = selectedModel.label;
      step.modelResolution = selectedModel.resolution;
      const selectedThinking = normalizeThinkingForBudget(resolveAgentThinking(agent, step.agent, context, selectedModel.resolution), budgetPolicy.profile, {
        handoffOnly: allowedTools.length === 0,
        hasPrevious: Boolean(options.previous),
        agent,
        model: selectedModel.model,
      });
      step.thinkingLevel = selectedThinking.label;
      let attempt: { text: string; metrics: RunStepMetrics; runtimeError?: string };
      try {
        attempt = await runSdkSessionAttempt({
          step,
          run,
          context,
          extensionContext,
          cwd: options.cwd,
          prompt,
          selectedModel,
          selectedThinking,
          allowedTools,
          maxToolCalls,
          budgetPolicy,
          promptOptions,
          agent,
          tokenomics,
        });
      } catch (error) {
        if (shouldRetryIdleStallWithoutActivity(error, idleStallRetryAttempted)) {
          idleStallRetryAttempted = true;
          if (error.metrics) accumulatedMetrics = mergeAttemptMetrics(accumulatedMetrics, error.metrics);
          run.warnings.push(`Retrying ${step.agent} after no-activity SDK idle stall: ${error.message}`);
          persistRun(run);
          context.onUpdate?.(run);
          continue;
        }
        throw error;
      }
      accumulatedMetrics = mergeAttemptMetrics(accumulatedMetrics, attempt.metrics);
      if (attempt.runtimeError) {
        const fallback = !fallbackAttempted && canRetryWithInheritedModel(attempt.metrics)
          ? resolveInheritedModelFallback(selectedModel, step.agent, context, attempt.runtimeError)
          : undefined;
        if (fallback) {
          fallbackAttempted = true;
          selectedModel = fallback;
          pushUniqueWarnings(run, fallback.warnings);
          persistRun(run);
          context.onUpdate?.(run);
          continue;
        }
        step.status = "failed";
        step.error = `SDK runner failed for ${step.agent}: ${attempt.runtimeError}`;
        if (attempt.text.trim()) step.output = parseAgentOutput(step.agent, attempt.text);
        step.metrics = finalizeStepMetrics(accumulatedMetrics, step, budgetPolicy, promptOptions.priorFilesRead);
        run.warnings.push(step.error);
        persistRun(run);
        context.onUpdate?.(run);
        return { aborted: false };
      }
      if (!attempt.text.trim()) {
        step.status = "failed";
        step.error = `SDK runner produced no assistant output for ${step.agent}.`;
        step.metrics = finalizeStepMetrics(accumulatedMetrics, step, budgetPolicy, promptOptions.priorFilesRead);
        run.warnings.push(step.error);
        persistRun(run);
        context.onUpdate?.(run);
        return { aborted: false };
      }
      step.output = parseAgentOutput(step.agent, attempt.text);
      step.metrics = finalizeStepMetrics(accumulatedMetrics, step, budgetPolicy, promptOptions.priorFilesRead);
      break;
    }
    step.status = resolveStepCompletionStatus(step);
    applyStructuredHandoffContract(run, step, agent);
    reconcileDeclaredGeneratedScopeViolations(run, step, options.cwd);
    applyFatalToolPolicyGate(run, step, agent);
    applyWorkspaceHygieneGate(run, step, agent, options.cwd, dirtyPathBaseline, { isolatedWorktree: options.cwd !== context.cwd });
    if (step.status === "checkpointed") {
      run.warnings.push(`${step.agent} checkpointed partial handoff for ${step.checkpoint?.continuation ?? "continuation"}.`);
      await recordBudgetCheckpoint(new ArtifactStore({ cwd: context.cwd }), run.id, step, step.checkpoint?.reason ?? "Budget cap reached during SDK child execution.");
    }
    persistRun(run);
    context.onUpdate?.(run);
    return { aborted: false, handoff: step.output?.handoff ?? step.output?.text };
  } catch (error) {
    if (isAbortError(error)) {
      step.status = "paused";
      step.error = errorMessage(error);
      step.pauseReason = "aborted";
      markRunAborted(run, context, step.error);
      return { aborted: true };
    }
    if (isIdleStallError(error)) {
      step.status = "paused";
      step.error = error.message;
      step.pauseReason = "idle-stall";
      if (error.metrics) step.metrics = error.metrics;
      if (error.assistantText?.trim()) step.output = parseAgentOutput(step.agent, error.assistantText);
      run.warnings.push(`SDK runner paused ${step.agent}: ${step.error}. Resume can start a fresh child session.`);
      persistRun(run);
      context.onUpdate?.(run);
      return { aborted: false, paused: true };
    }
    step.status = "failed";
    step.error = error instanceof Error ? error.message : String(error);
    run.warnings.push(`SDK runner failed for ${step.agent}: ${step.error}`);
    persistRun(run);
    context.onUpdate?.(run);
    return { aborted: false };
  } finally {
    step.endedAt = new Date().toISOString();
    persistRun(run);
  }
}

async function runSdkSessionAttempt(input: {
  step: RunStepState;
  run: RunState;
  context: WorkerRunnerContext;
  extensionContext: ExtensionContext;
  cwd: string;
  prompt: string;
  selectedModel: ResolvedAgentModel;
  selectedThinking: ReturnType<typeof resolveAgentThinking>;
  allowedTools: string[];
  maxToolCalls: number;
  budgetPolicy: ReturnType<typeof policyForStep>;
  promptOptions: SdkPromptOptions;
  agent?: AgentDefinition;
  tokenomics: TokenomicsSummary;
}): Promise<{ text: string; metrics: RunStepMetrics; runtimeError?: string }> {
  const stepStartedAtMs = Date.now();
  const activity = createStepActivityMonitor(input.step, input.run, input.context);
  const spanIdPrefix = `${input.run.id}:${input.step.id}`;
  const toolSpans: StructuredTraceSpan[] = [];
  const activeToolStarts = new Map<string, Array<{ at: number; index: number }>>();
  let toolSpanIndex = 0;
  let lastToolActivityPersistAt = 0;
  const persistToolActivity = (force = false) => {
    const now = Date.now();
    if (!force && now - lastToolActivityPersistAt < 1000) return;
    lastToolActivityPersistAt = now;
    persistRun(input.run);
    input.context.onUpdate?.(input.run);
  };
  const recordToolActivity = (toolActivity: ChildToolActivity) => {
    activity.onToolActivity(toolActivity);
    if (toolActivity.phase === "start") {
      const starts = activeToolStarts.get(toolActivity.toolName) ?? [];
      starts.push({ at: toolActivity.at, index: toolSpanIndex++ });
      activeToolStarts.set(toolActivity.toolName, starts);
      persistToolActivity(true);
      return;
    }
    if (toolActivity.phase === "blocked") {
      toolSpans.push(createStructuredSpan({
        id: `${spanIdPrefix}:tool:${toolSpanIndex++}`,
        parentId: `${spanIdPrefix}:step`,
        name: toolActivity.toolName,
        kind: traceKindForTool(toolActivity.toolName),
        startedAt: toolActivity.at,
        endedAt: toolActivity.at,
        attributes: {
          toolName: toolActivity.toolName,
          blocked: true,
          reason: toolActivity.reason,
          paramsSummary: toolActivity.paramsSummary,
        },
      }));
      persistToolActivity(true);
      return;
    }
    const starts = activeToolStarts.get(toolActivity.toolName) ?? [];
    const start = starts.shift();
    if (starts.length === 0) activeToolStarts.delete(toolActivity.toolName);
    toolSpans.push(createStructuredSpan({
      id: `${spanIdPrefix}:tool:${start?.index ?? toolSpanIndex++}`,
      parentId: `${spanIdPrefix}:step`,
      name: toolActivity.toolName,
      kind: traceKindForTool(toolActivity.toolName),
      startedAt: start?.at ?? toolActivity.at,
      endedAt: toolActivity.at,
      attributes: { toolName: toolActivity.toolName },
    }));
    persistToolActivity(true);
  };
  const childPolicy = createChildToolPolicy({
    cwd: input.cwd,
    maxToolCalls: input.maxToolCalls,
    budgetPolicy: input.budgetPolicy,
    agentName: input.step.agent,
    allowedTools: input.allowedTools,
    priorFilesRead: input.promptOptions.priorFilesRead,
    maxCrossStepDuplicateReads: input.promptOptions.synthesisGapReadLimit !== undefined ? synthesisCrossStepDuplicateReadLimit(input.agent) : undefined,
    subagentDelegation: {
      enabled: Boolean(input.agent?.capabilities.includes("coordinate")),
      depth: currentSubagentDepth(input.run),
      maxDepth: maxSubagentDepth(),
      execute: (params) => runNestedDelegation(params, input),
    },
    workUnitScope: workUnitMutationScopeForStep(input.run, input.step),
    onActivity: recordToolActivity,
  });
  const attemptMetrics = (messages: unknown[] = []) => {
    const metrics = mergePolicyMetrics(extractSessionMetrics(messages, stepStartedAtMs), childPolicy);
    const tokenomics = mergeTokenomics(input.tokenomics, tokenomicsForToolOutputs(metrics)) ?? input.tokenomics;
    return {
      ...metrics,
      tokenomics,
      spans: mergeTraceSpans(baseStepSpans(spanIdPrefix, input.step, stepStartedAtMs, Date.now(), tokenomics, input.promptOptions), toolSpans),
    };
  };
  const { createAgentSession } = await import("@earendil-works/pi-coding-agent");
  const sessionManager = createChalinChildSessionManager({ cwd: input.cwd, runId: input.run.id, step: input.step, extensionContext: input.extensionContext });
  const releaseChildEnv = enterChildEnv();
  try {
    const created = await createAgentSession({
      cwd: input.cwd,
      model: input.selectedModel.model,
      ...(input.selectedThinking.level ? { thinkingLevel: input.selectedThinking.level as never } : {}),
      modelRegistry: input.extensionContext.modelRegistry,
      sessionManager,
      tools: input.allowedTools,
      customTools: createChildTools(childPolicy),
      sessionStartEvent: { type: "session_start", reason: "new" },
    });
    input.step.thinkingLevel = (created.session.thinkingLevel as AgentThinkingLevel | undefined) ?? input.step.thinkingLevel;
    const liveRef: LiveStepSessionRef = {
      runId: input.run.id,
      stepId: input.step.id,
      agent: input.step.agent,
      cwd: input.cwd,
      startedAt: new Date().toISOString(),
      getMessages: () => Array.isArray(created.session.state.messages) ? created.session.state.messages as unknown[] : [],
    };
    setLiveStepSession(liveRef);
    try {
      const abortChild = () => { void created.session.abort(); };
      input.context.signal?.addEventListener("abort", abortChild, { once: true });
      try {
        await runWithIdleStallMonitor(
          created.session.prompt(input.prompt, { expandPromptTemplates: false, source: "extension" }),
          {
            idleStallMs: sdkStepIdleStallMs({
              thinkingLevel: input.selectedThinking.label,
              budgetMaxSeconds: input.budgetPolicy.caps.maxSeconds,
            }),
            message: `SDK runner idle stalled for ${input.step.agent}`,
            signal: input.context.signal,
            activeOperations: activity.activeOperations,
            pollActivitySignature: () => {
              const messages = created.session.state.messages as unknown[];
              activity.onSessionActivity(messages);
              return sessionActivitySignature(messages, childPolicy);
            },
            onStall: abortChild,
          },
        );
      } catch (error) {
        if (isIdleStallError(error)) {
          const messages = created.session.state.messages as unknown[];
          activity.onSessionActivity(messages);
          error.metrics = attemptMetrics(messages);
          error.assistantText = extractLastAssistantText(messages);
        }
        throw error;
      } finally {
        input.context.signal?.removeEventListener("abort", abortChild);
        input.step.currentTool = undefined;
      }
      const messages = created.session.state.messages as unknown[];
      activity.onSessionActivity(messages);
      const text = extractLastAssistantText(messages);
      return { text, metrics: attemptMetrics(messages), runtimeError: extractAssistantRuntimeError(messages) };
    } finally {
      clearLiveStepSession(input.run.id, input.step.id, liveRef);
      created.session.dispose();
    }
  } catch (error) {
    if (isAbortError(error) || isIdleStallError(error)) throw error;
    return { text: "", metrics: attemptMetrics(), runtimeError: errorMessage(error) };
  } finally {
    releaseChildEnv();
  }
}

async function runNestedDelegation(params: ChalinDelegateParamsShape, input: {
  step: RunStepState;
  run: RunState;
  context: WorkerRunnerContext;
  extensionContext: ExtensionContext;
  cwd: string;
}): Promise<{ text: string; details?: unknown }> {
  let route = routeFromNestedDelegationPlan(params);
  if (!route.plan) {
    return { text: `Nested delegation rejected: ${route.reason}` };
  }
  route = normalizeRouteForExecution(route, {
    requiresWorkspaceMutation: Boolean(params.requiresWorkspaceMutation || route.expectedEffects?.includes("write")),
    task: params.task,
    agents: input.context.agents,
  });
  const missing = route.agents.filter((agent) => !input.context.agents.has(agent));
  if (missing.length > 0) {
    return { text: `Nested delegation rejected: unknown agent(s): ${missing.join(", ")}.` };
  }
  const parentDepth = currentSubagentDepth(input.run);
  const maxDepth = maxSubagentDepth();
  if (parentDepth >= maxDepth) {
    return { text: `Nested delegation rejected: depth ${parentDepth}/${maxDepth}. Return a compact handoff to the parent orchestrator instead.` };
  }
  const nested = await new SdkWorkerRunner().run(route, {
    ...input.context,
    cwd: input.cwd,
    extensionContext: input.extensionContext,
    rootTask: [
      input.context.rootTask ?? input.run.rootTask ?? params.task,
      `Nested delegation from ${input.step.agent}/${input.step.id}: ${params.reason}`,
    ].filter(Boolean).join("\n\n"),
    parentRunId: input.run.id,
    parentStepId: input.step.id,
    delegationDepth: parentDepth,
    onUpdate: undefined,
  });
  return {
    text: formatNestedDelegationResult(nested),
    details: { runId: nested.id, status: nested.status, route: nested.route, metrics: nested.metrics },
  };
}

function routeFromNestedDelegationPlan(input: ChalinDelegateParamsShape): RouteDecision {
  const steps = sanitizeNestedSteps(input.steps ?? []);
  const expectedEffects = nestedExpectedEffects(input);
  if (input.topology === "dag") {
    const stages = sanitizeNestedStages(input.stages ?? []);
    if (stages.length === 0) {
      return { kind: "ask-user", agents: [], risk: "low", ambiguity: "high", needsMemory: false, needsArtifacts: false, expectedEffects: ["read"], reason: "Nested dag requires at least one stage with tasks." };
    }
    const agents = stages.flatMap((stage) => stage.tasks.map((step) => step.agent));
    return {
      kind: "multi-agent-dag",
      agents,
      risk: input.requiresWorkspaceMutation ? "medium" : "low",
      ambiguity: "low",
      needsMemory: false,
      needsArtifacts: true,
      expectedEffects,
      reason: input.reason.trim() || "Subagent selected a rare nested DAG because the current task was no longer bounded.",
      plan: { kind: "dag", stages },
    };
  }
  if (steps.length === 0) return { kind: "ask-user", agents: [], risk: "low", ambiguity: "high", needsMemory: false, needsArtifacts: false, expectedEffects: ["read"], reason: "Nested sequential delegation requires steps." };
  const agents = steps.map((step) => step.agent);
  return {
    kind: "multi-agent-sequential",
    agents,
    risk: input.requiresWorkspaceMutation ? "medium" : "low",
    ambiguity: "low",
    needsMemory: false,
    needsArtifacts: true,
    expectedEffects,
    reason: input.reason.trim() || "Subagent selected rare nested delegation because the current task was no longer bounded.",
    plan: { kind: "sequential", steps },
  };
}

function nestedExpectedEffects(input: ChalinDelegateParamsShape): RouteExpectedEffect[] {
  return input.requiresWorkspaceMutation ? ["read", "write", "verify"] : ["read"];
}

function sanitizeNestedSteps(steps: NonNullable<ChalinDelegateParamsShape["steps"]>): AgentStep[] {
  return steps
    .map((step) => ({ id: step.id?.trim(), agent: step.agent.trim(), task: step.task.trim(), budget: sanitizeNestedBudget(step.budget) }))
    .filter((step) => step.agent.length > 0 && step.task.length > 0)
    .slice(0, 4);
}

function sanitizeNestedStages(stages: NonNullable<ChalinDelegateParamsShape["stages"]>): Array<{ id: string; tasks: AgentStep[] }> {
  return stages
    .map((stage, index) => ({
      id: (stage.id ?? stage.name ?? `nested-stage-${index + 1}`).trim() || `nested-stage-${index + 1}`,
      tasks: sanitizeNestedSteps(stage.tasks).slice(0, 4),
    }))
    .filter((stage) => stage.tasks.length > 0)
    .slice(0, 3);
}

function sanitizeNestedBudget(value: AgentStep["budget"] | "small" | "medium" | "large"): AgentStep["budget"] | undefined {
  if (value === "small") return "tight";
  if (value === "medium") return "normal";
  if (value === "large") return "deep";
  return value === "tight" || value === "normal" || value === "deep" || value === "extended" ? value : undefined;
}

function formatNestedDelegationResult(run: RunState): string {
  const lines = [
    `Nested delegation ${run.id} ${run.status}.`,
    `Depth: ${run.delegationDepth ?? 0}/${maxSubagentDepth()}.`,
    ...run.steps.map((step) => {
      const handoff = step.output?.handoff ?? step.output?.text ?? step.error ?? "No handoff.";
      return `- ${step.agent}/${step.id}: ${step.status}. ${handoff.slice(0, 900)}`;
    }),
  ];
  if (run.warnings.length) lines.push(`Warnings: ${run.warnings.slice(0, 5).join(" | ")}`);
  return lines.join("\n");
}

function currentSubagentDepth(run: RunState): number {
  return (run.delegationDepth ?? 0) + 1;
}

function maxSubagentDepth(): number {
  const parsed = Number(process.env.PI_CHALIN_MAX_SUBAGENT_DEPTH);
  return Number.isFinite(parsed) && parsed >= 1 ? Math.floor(parsed) : 2;
}

export function promptTokenomicsPhaseForStep(
  step: Pick<RunStepState, "id" | "agent">,
  agent?: Pick<AgentDefinition, "concern">,
): "childPrompt" | "reviewer" | "repair" {
  if (/^review-repair(?:-|:|$)/.test(step.id)) return "repair";
  if (agent?.concern === "review" || step.agent === "reviewer") return "reviewer";
  return "childPrompt";
}

const childEnv = { active: 0, previousChild: undefined as string | undefined, previousDisabled: undefined as string | undefined };

function enterChildEnv(): () => void {
  if (childEnv.active === 0) {
    childEnv.previousChild = process.env.PI_CHALIN_CHILD;
    childEnv.previousDisabled = process.env.PI_CHALIN_DISABLED;
    process.env.PI_CHALIN_CHILD = "1";
    process.env.PI_CHALIN_DISABLED = "1";
  }
  childEnv.active += 1;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    childEnv.active = Math.max(0, childEnv.active - 1);
    if (childEnv.active > 0) return;
    if (childEnv.previousChild === undefined) delete process.env.PI_CHALIN_CHILD;
    else process.env.PI_CHALIN_CHILD = childEnv.previousChild;
    if (childEnv.previousDisabled === undefined) delete process.env.PI_CHALIN_DISABLED;
    else process.env.PI_CHALIN_DISABLED = childEnv.previousDisabled;
    childEnv.previousChild = undefined;
    childEnv.previousDisabled = undefined;
  };
}

function buildPromptOptionsForStep(run: RunState, step: RunStepState, agent: AgentDefinition | undefined, policy: ReturnType<typeof policyForStep>, cwd: string, previous?: string): SdkPromptOptions {
  const priorFilesRead = priorFilesReadBeforeStep(run, step, cwd);
  const previousClaims = claimsNeedingAudit(previousClaimsBeforeStep(run, step)).slice(0, 12);
  const contextPacket = formatContextPacket(buildContextPacket(run, step, previous, 900, cwd, runWorkspaceRoot(run)));
  return {
    rootTask: sanitizePromptWorkspaceText(run.rootTask, cwd, runWorkspaceRoot(run)),
    priorFilesRead,
    previousClaims,
    workUnitStrategy: run.route.workUnitStrategy,
    expectedEffects: run.route.expectedEffects ?? ["read"],
    fanoutAuthorized: run.intentContract?.fanoutAuthorized === true,
    ...(contextPacket ? { contextPacket } : {}),
    ...(isHandoffGapReadMode(agent, previous, policy.profile === "deep") ? { synthesisGapReadLimit: synthesisGapReadLimit() } : {}),
  };
}

export function sanitizePromptWorkspaceText(value: string | undefined, cwd: string, originalCwd?: string): string | undefined {
  if (!value) return value;
  return sanitizeWorkspaceTextForRoots(value, [cwd, originalCwd].filter((root): root is string => Boolean(root)));
}

function runWorkspaceRoot(run: Pick<RunState, "logsPath">): string | undefined {
  if (!run.logsPath) return undefined;
  return path.dirname(path.dirname(path.dirname(run.logsPath)));
}

export function allowedToolsForStep(tools: string[], run: Pick<RunState, "workUnits">, step: Pick<RunStepState, "workUnitId">, cwd: string): string[] {
  if (!tools.includes("write")) return tools;
  const unit = run.workUnits?.find((candidate) => candidate.id === step.workUnitId);
  if (!unit?.files?.length) return tools;
  const hasNewStructuredFile = unit.files.some((file) => !fs.existsSync(resolveStepFilePath(cwd, file)));
  return hasNewStructuredFile ? tools : tools.filter((tool) => tool !== "write");
}

export function workUnitMutationScopeForStep(run: Pick<RunState, "workUnits">, step: Pick<RunStepState, "workUnitId">): { files: string[]; mode: "strict"; bash: "allow-with-postcheck" } | undefined {
  const unit = run.workUnits?.find((candidate) => candidate.id === step.workUnitId);
  return unit?.files?.length ? { files: unit.files, mode: "strict", bash: "allow-with-postcheck" } : undefined;
}

function resolveStepFilePath(cwd: string, file: string): string {
  return path.isAbsolute(file) ? file : path.resolve(cwd, file);
}

async function compactMemoryContextForStep(cwd: string, step: RunStepState, agent: AgentDefinition | undefined, previous?: string): Promise<string | undefined> {
  if (!agent?.memory.read || !agent.capabilities.includes("memory-read")) return undefined;
  const query = [step.task, previous ? `Previous handoff: ${previous.slice(0, 700)}` : ""].filter(Boolean).join("\n");
  const bundle = await createConfiguredMemoryStore({ cwd }).retrieve({
    query,
    sourceAgent: step.agent,
    agentConcern: agent.concern,
    tokenBudget: memoryPromptTokenBudget(agent),
    limit: 8,
  });
  return bundle.text || undefined;
}

function memoryPromptTokenBudget(agent: AgentDefinition): number {
  if (agent.concern === "review" || agent.concern === "decision-consistency") return 700;
  if (agent.concern === "planning" || agent.concern === "context-building") return 560;
  if (agent.concern === "implementation" || agent.concern === "conflict-resolution") return 420;
  return 320;
}

function priorFilesReadBeforeStep(run: RunState, currentStep: RunStepState, cwd?: string): string[] {
  const index = run.steps.indexOf(currentStep);
  const previousSteps = index >= 0 ? run.steps.slice(0, index) : run.steps.filter((step) => step !== currentStep);
  return sanitizeWorkspacePathList([...new Set(previousSteps.flatMap((step) => step.metrics?.filesRead ?? []))], cwd).slice(0, 80);
}

function previousClaimsBeforeStep(run: RunState, currentStep: RunStepState): EvidenceClaim[] {
  const index = run.steps.indexOf(currentStep);
  const previousSteps = index >= 0 ? run.steps.slice(0, index) : run.steps.filter((step) => step !== currentStep);
  return previousSteps.flatMap((step) => step.output?.claims ?? []);
}

export function budgetPolicyForSdkStep(policy: ReturnType<typeof policyForStep>, agent: AgentDefinition | undefined, previous?: string): ReturnType<typeof policyForStep> {
  if (agent?.concern === "recon" && policy.profile === "deep" && !previous?.trim()) {
    return {
      ...policy,
      id: `${policy.id}:surface-recon`,
      caps: {
        ...policy.caps,
        maxToolCalls: Math.min(policy.caps.maxToolCalls, deepReconToolCallLimit()),
        maxReadBytes: Math.min(policy.caps.maxReadBytes, 260_000),
        maxOutputChars: Math.min(policy.caps.maxOutputChars, 18_000),
        maxTurns: Math.min(policy.caps.maxTurns, 5),
      },
    };
  }
  if (!isHandoffGapReadMode(agent, previous, policy.profile === "deep")) return policy;
  const reviewMode = agent?.concern === "review";
  const maxToolCalls = Math.min(policy.caps.maxToolCalls, reviewMode ? handoffReviewToolCallLimit() : synthesisToolCallLimit());
  return {
    ...policy,
    id: `${policy.id}:${reviewMode ? "handoff-review" : "handoff-synthesis"}`,
    taskKind: reviewMode ? "review" : "synthesis",
    caps: {
      ...policy.caps,
      maxToolCalls,
      maxReadBytes: Math.min(policy.caps.maxReadBytes, reviewMode ? 240_000 : 600_000),
      maxOutputChars: Math.min(policy.caps.maxOutputChars, reviewMode ? 10_000 : 14_000),
      maxTurns: Math.min(policy.caps.maxTurns, reviewMode ? 3 : 4),
    },
  };
}

function deepReconToolCallLimit(): number {
  const parsed = Number(process.env.PI_CHALIN_DEEP_RECON_TOOL_LIMIT);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 12;
}

function aggregateCompletedHandoffBefore(steps: RunStepState[], endIndex: number): string {
  return aggregateHandoff(steps
    .slice(0, endIndex)
    .filter((step) => isUsableStepHandoff(step))
    .map((step) => ({ agent: step.agent, text: step.output?.handoff ?? step.output?.text ?? "" })));
}

function aggregateHandoff(items: Array<{ agent: string; text: string }>): string {
  return items
    .filter((item) => item.text.trim().length > 0)
    .map((item) => `- ${item.agent}: ${truncateText(item.text.trim(), 450)}`)
    .join("\n");
}

function afterStageHandoffs(run: RunState, stageSteps: RunStepState[]): void {
  for (const step of stageSteps) afterStepHandoff(run, step, { expandWorkUnits: false });
  if (run.recoveryState?.blockedByHumanInput) {
    refreshWorkUnitStatuses(run);
    updateRecoveryState(run, run.steps.find((candidate) => candidate.status === "failed"));
    persistRun(run);
    return;
  }
  expandWorkUnitsFromBestHandoff(run, stageSteps);
  refreshWorkUnitStatuses(run);
  updateRecoveryState(run, run.steps.find((candidate) => candidate.status === "failed"));
  persistRun(run);
}

function afterStepHandoff(run: RunState, step: RunStepState, options: { expandWorkUnits?: boolean } = {}): void {
  recordStepLedgers(run, step);
  if (maybePauseForHumanInput(run, step)) {
    persistRun(run);
    return;
  }
  if (options.expandWorkUnits !== false && isUsableStepHandoff(step)) expandWorkUnitsFromHandoff(run, step);
  refreshWorkUnitStatuses(run);
  updateRecoveryState(run, run.steps.find((candidate) => candidate.status === "failed"));
  persistRun(run);
}

function maybePauseForHumanInput(run: RunState, step: RunStepState): boolean {
  const handoff = step.output?.structuredHandoff;
  if (!handoff?.requiresHumanInput) return false;
  if (shouldProceedWithAuthorizedPartialFanout(run, step)) {
    run.warnings.push(`Human input questions from ${step.agent}/${step.id} recorded as non-blocking authorized fanout risks; proceeding with ${step.output?.structuredHandoff?.workUnits?.length ?? 0} safe WorkUnit(s).`);
    return false;
  }
  const questions = handoff.humanInputQuestions?.length ? handoff.humanInputQuestions : handoff.nextActions;
  const skipped = markHumanBlockedDependentsSkipped(run, step, questions);
  run.warnings.push(`Human input required by ${step.agent}/${step.id}; skipped ${skipped} dependent step(s) until the user answers.`);
  return true;
}

export function shouldProceedWithAuthorizedPartialFanout(run: Pick<RunState, "route" | "intentContract" | "workUnits">, step: Pick<RunStepState, "workUnitId" | "output">): boolean {
  const handoff = step.output?.structuredHandoff;
  if (!handoff?.requiresHumanInput) return false;
  if (run.intentContract?.fanoutAuthorized !== true) return false;
  if (run.route.workUnitStrategy !== "discover") return false;
  if (!run.route.expectedEffects?.includes("write")) return false;
  if ((handoff.workUnits?.length ?? 0) < 2) return false;
  const sourceUnit = run.workUnits?.find((unit) => unit.id === step.workUnitId);
  return sourceUnit?.createdFrom !== "fanout";
}

function recordStepLedgers(run: RunState, step: RunStepState): void {
  if (!step.output) return;
  const handoff = step.output.structuredHandoff;
  if (handoff?.changedFiles.length && shouldRecordMutationLedgerEntry(step)) {
    run.mutationLedger ??= [];
    if (!run.mutationLedger.some((entry) => entry.stepId === step.id)) {
      run.mutationLedger.push({
        unitId: step.workUnitId,
        stepId: step.id,
        agent: step.agent,
        paths: handoff.changedFiles,
        summary: handoff.summary,
        verification: handoff.verification,
        at: new Date().toISOString(),
      });
    }
  }
  if (handoff?.verification.length || step.output.reviewerVerdict) {
    run.verificationLedger ??= [];
    if (!run.verificationLedger.some((entry) => entry.stepId === step.id)) {
      const verdict = step.output.reviewerVerdict;
      const reviewerMissingVerdict = isReviewerStep(step) && !verdict;
      const reviewerEvidenceGap = verdict?.verdict === "pass"
        ? reviewerPassNeedsEvidenceRepair(step, { expectsReviewedContent: true, expectsVerify: routeExpectedEffects(run).has("verify") })
        : false;
      const status = reviewerEvidenceGap ? "gap" : verdict?.verdict ?? (reviewerMissingVerdict ? "gap" : handoff?.verification.length ? "pass" : "unknown");
      run.verificationLedger.push({
        unitId: step.workUnitId,
        stepId: step.id,
        agent: step.agent,
        status,
        evidence: verdict?.evidence.length ? verdict.evidence : handoff?.verification ?? [],
        covers: handoff?.changedFiles ?? [],
        gaps: [
          ...(reviewerEvidenceGap ? ["Structured Reviewer Verdict PASS lacks required contractual evidence."] : []),
          ...(verdict?.blockingFindings ?? []),
          ...(verdict?.missingCoverage ?? []),
        ],
        risks: [...new Set([...(verdict?.residualRisks ?? []), ...(handoff?.risks ?? [])])],
        at: new Date().toISOString(),
      });
      if (verdict) step.reviewGate = reviewerEvidenceGap || (verdict.verdict === "pass" && verdict.evidence.length === 0) ? "missing-evidence" : verdict.verdict;
      else if (reviewerMissingVerdict) step.reviewGate = "gap";
    }
  }
}

function markVerificationLedgerGap(run: RunState, step: RunStepState, gap: string): void {
  const entry = run.verificationLedger?.find((candidate) => candidate.stepId === step.id);
  if (!entry) return;
  entry.status = "gap";
  entry.gaps = appendUnique(entry.gaps, gap);
}

export function shouldRecordMutationLedgerEntry(step: RunStepState): boolean {
  if ((step.metrics?.filesTouched?.length ?? 0) > 0) return true;
  return isWriteResponsibleStep(step);
}

interface RunChainOptions {
  resume?: boolean;
  initialPrevious?: string;
}

function runChain(
  run: RunState,
  steps: RunStepState[],
  context: WorkerRunnerContext,
  options: RunChainOptions = {},
): Promise<void> {
  return Effect.runPromise(runChainEffect(run, steps, context, options));
}

function runChainEffect(
  run: RunState,
  steps: RunStepState[],
  context: WorkerRunnerContext,
  options: RunChainOptions,
): Effect.Effect<void, RunnerError> {
  return Effect.gen(function* () {
    let previous = options.initialPrevious ?? "";
    for (const step of steps) {
      if (runBlockedByHumanInput(run) || step.status === "skipped") break;
      if (options.resume && isUsableStepHandoff(step)) {
        previous = aggregateHandoff([{ agent: step.agent, text: step.output?.handoff ?? step.output?.text ?? previous }]);
        afterStepHandoff(run, step);
        if (runBlockedByHumanInput(run)) break;
        maybeAppendWorkerScopeGapRepair(run, step);
        maybeAppendImplementationReviewRepair(run, step);
        continue;
      }
      yield* checkAbortEffect(context.signal);
      const output = yield* runStepEffect(step, context, previous, run);
      previous = output.handoff ?? output.text;
      afterStepHandoff(run, step);
      if (runBlockedByHumanInput(run)) break;
      maybeAppendWorkerScopeGapRepair(run, step);
      maybeAppendImplementationReviewRepair(run, step);
      if (step.status === "failed") break;
    }
  }).pipe(Effect.withSpan("runner.mock.chain"));
}

function runParallel(
  steps: RunStepState[],
  context: WorkerRunnerContext,
  previous: string | undefined,
  run?: RunState,
  span = "runner.mock.parallel",
): Promise<AgentOutput[]> {
  return Effect.runPromise(runParallelEffect(steps, context, previous, run, span));
}

function runParallelEffect(
  steps: RunStepState[],
  context: WorkerRunnerContext,
  previous: string | undefined,
  run: RunState | undefined,
  span: string,
): Effect.Effect<AgentOutput[], RunnerError> {
  return Effect.forEach(
    steps.filter(isRunnableStep),
    (step) => runStepEffect(step, context, previous, run),
    { concurrency: "unbounded" },
  ).pipe(Effect.withSpan(span));
}

async function runStep(step: RunStepState, context: WorkerRunnerContext, previous: string | undefined, run?: RunState): Promise<AgentOutput> {
  return Effect.runPromise(runStepEffect(step, context, previous, run));
}

function runStepEffect(step: RunStepState, context: WorkerRunnerContext, previous: string | undefined, run?: RunState): Effect.Effect<AgentOutput, RunnerError> {
  return Effect.gen(function* () {
    if (run && runBlockedByHumanInput(run)) {
      markStepSkippedForHumanInputBlock(run, step);
      persistRun(run);
      context.onUpdate?.(run);
      return parseAgentOutput(step.agent, "");
    }
    if (step.status === "skipped") return parseAgentOutput(step.agent, "");
    step.status = "running";
    step.startedAt = new Date().toISOString();
    if (run) persistRun(run);
    context.onUpdate?.(run ?? { ...createRunState({ kind: "bypass", agents: [], risk: "low", ambiguity: "low", needsMemory: false, needsArtifacts: false, reason: "update" }, context.cwd), steps: [step] });
    yield* runnerTryPromise(() => maybeMockDelay(context.signal), step);
    yield* checkAbortEffect(context.signal);
    const agent = context.agents.get(step.agent);
    const model = context.modelOverrides?.[`${agent?.scope ?? "built-in"}/${step.agent}`] ?? context.modelOverrides?.[step.agent] ?? agent?.model;
    step.model = model && model !== "inherit" ? model : "inherit";
    const raw = buildMockOutput(step, context, previous, agent);
    const output = parseAgentOutput(step.agent, raw);
    step.output = output;
    step.status = "complete";
    applyStructuredHandoffContract(run, step, agent);
    step.endedAt = new Date().toISOString();
    if (run) persistRun(run);
    context.onUpdate?.(run ?? { ...createRunState({ kind: "bypass", agents: [], risk: "low", ambiguity: "low", needsMemory: false, needsArtifacts: false, reason: "update" }, context.cwd), steps: [step] });
    return output;
  }).pipe(Effect.withSpan(`runner.mock.step.${step.agent}`));
}

function buildMockOutput(step: RunStepState, context: WorkerRunnerContext, previous: string | undefined, agent: AgentDefinition | undefined): string {
  const index = buildProjectDiscoveryIndex(context.cwd);
  const summary = formatProjectDiscoveryIndex(index);
  const gitSummary = "";
  const projectFiles = index.entries.filter((entry) => entry.type === "file").map((entry) => entry.path).slice(0, 8);
  const findings = mockFindings(step, summary, gitSummary, projectFiles, previous);
  const handoff = mockHandoff(step, summary, gitSummary, projectFiles, previous);
  const structuredHandoff = mockStructuredHandoff(step, handoff, projectFiles);
  const reviewerVerdict = step.agent === "reviewer" ? mockReviewerVerdict(previous) : undefined;
  const memories = mockMemoryCandidates(step, summary);
  return [
    `## ${step.agent} result`,
    `Task: ${step.task}`,
    previous ? `Previous handoff: ${truncateText(previous, 500)}` : undefined,
    `Concern: ${agent?.concern ?? "unknown"}`,
    "",
    "## Findings",
    ...findings.map((finding) => `- ${finding}`),
    "",
    "## Handoff",
    ...handoff.map((line) => `- ${line}`),
    "",
    "## Agent Handoff",
    JSON.stringify(structuredHandoff),
    "",
    reviewerVerdict ? "## Reviewer Verdict" : undefined,
    reviewerVerdict ? JSON.stringify(reviewerVerdict) : undefined,
    reviewerVerdict ? "" : undefined,
    "## Memory Candidates",
    ...(memories.length ? memories.map((memory) => `- ${memory}`) : ["- None."]),
  ].filter((line): line is string => line !== undefined).join("\n");
}

function mockStructuredHandoff(step: RunStepState, handoff: string[], projectFiles: string[]): AgentHandoff {
  const normalizedAgent = step.agent.toLowerCase();
  const mockWriter = normalizedAgent === "worker" || normalizedAgent.slice(0, 7) === "worker-";
  return {
    summary: handoff[0] ?? `Completed ${step.agent} task.`,
    changedFiles: mockWriter ? ["mock-change"] : [],
    verification: mockWriter || step.agent === "reviewer" ? ["mock verification evidence"] : [],
    evidenceClaims: [],
    risks: step.agent === "reviewer" ? ["mock review risk inventory"] : [],
    nextActions: handoff.slice(1, 4),
    workUnits: mockDiscoveredWorkUnits(step, projectFiles),
  };
}

function mockDiscoveredWorkUnits(step: RunStepState, projectFiles: string[]): AgentHandoff["workUnits"] {
  if (step.agent !== "scout" && step.agent !== "planner" && step.agent !== "context-builder") return [];
  const surfaces = projectFiles.length >= 2 ? projectFiles.slice(0, 4) : ["primary implementation surface", "primary verification surface"];
  return surfaces.slice(0, Math.max(2, Math.min(4, surfaces.length))).map((surface, index) => ({
    title: `Bounded unit ${index + 1}: ${surface}`,
    scope: [surface],
    dependencies: [],
    acceptanceCriteria: [`Complete and verify the bounded responsibility for ${surface}.`],
  }));
}

function mockReviewerVerdict(previous: string | undefined): ReviewerVerdict {
  const reviewedPath = previous ? "src/mock-reviewed.ts" : "src/mock-reviewed.ts";
  return {
    verdict: "pass",
    blockingFindings: [],
    missingCoverage: [],
    evidence: [
      `kind: reviewed-content | paths: ${reviewedPath} | summary: mock reviewed changed content`,
      "kind: verification | command: mock test command | status: pass | result: exited 0",
    ],
    evidenceRecords: [
      { kind: "reviewed-content", paths: [reviewedPath], summary: "Mock reviewed changed content." },
      { kind: "verification", paths: [], command: "mock test command", status: "pass", result: "Exited 0." },
    ],
  };
}

function mockFindings(step: RunStepState, snapshotSummary: string, gitSummary: string, projectFiles: string[], previous: string | undefined): string[] {
  const findings: string[] = [];
  if (snapshotSummary) findings.push(`Project inventory: ${truncateText(snapshotSummary, 320)}`);
  if (gitSummary) findings.push(gitSummary);
  if (projectFiles.length) findings.push(`Sampled files from raw inventory: ${projectFiles.slice(0, 6).join(", ")}.`);
  if (previous) findings.push(`Prior handoff available and should be used instead of re-scanning: ${truncateText(previous, 240)}`);
  if (step.agent === "reviewer") findings.push("Review focus: validate architecture risks from scout evidence, not generic advice.");
  if (step.agent === "planner") findings.push("Planning focus: produce phased steps with validation and rollback points.");
  if (step.agent === "worker") findings.push("Implementation focus: make bounded file changes and add or update tests before reporting complete.");
  return findings.slice(0, 5);
}

function mockHandoff(step: RunStepState, snapshotSummary: string, gitSummary: string, projectFiles: string[], previous: string | undefined): string[] {
  const handoff: string[] = [];
  if (step.agent === "context-builder") {
    handoff.push(`Project inventory: ${snapshotSummary || "no repository inventory available"}`);
    if (gitSummary) handoff.push(gitSummary);
    if (projectFiles.length) handoff.push(`Inventory file samples: ${projectFiles.slice(0, 5).join(", ")}.`);
    handoff.push("Answer should summarize purpose, modules, changed areas, and risks from the gathered context.");
  } else if (step.agent === "reviewer") {
    handoff.push(previous ? `Use scout evidence: ${truncateText(previous, 420)}` : "Review should first anchor claims in project files.");
    handoff.push("Likely risk areas: changed behavior, ownership boundaries, integration points, and validation coverage.");
    handoff.push("Final answer should prioritize actionable risks and avoid generic architecture advice.");
  } else if (step.agent === "planner") {
    handoff.push(previous ? `Plan from evidence: ${truncateText(previous, 420)}` : "Plan should begin with inventory and risk slicing.");
    handoff.push("Recommended order: inventory → low-risk slices → shared dependencies → highest-risk slices → regression checks.");
  } else if (step.agent === "worker") {
    handoff.push("Apply only the planned bounded change, keep diffs small, and run the nearest test command.");
  } else {
    handoff.push(`Mapped context for task: ${step.task}`);
    if (snapshotSummary) handoff.push(snapshotSummary);
    if (gitSummary) handoff.push(gitSummary);
    if (projectFiles.length) handoff.push(`Inventory file samples: ${projectFiles.slice(0, 5).join(", ")}.`);
  }
  return handoff.slice(0, 6);
}

function mockMemoryCandidates(step: RunStepState, snapshotSummary: string): string[] {
  if (step.agent !== "scout" && step.agent !== "context-builder") return [];
  if (!snapshotSummary) return [];
  return [`tooling: ${truncateText(snapshotSummary, 420)}`];
}

async function maybeMockDelay(signal?: AbortSignal): Promise<void> {
  const parsed = Number(process.env.PI_CHALIN_MOCK_STEP_DELAY_MS);
  if (!Number.isFinite(parsed) || parsed <= 0) return;
  await abortableSleep(parsed, signal);
}

function completeRun(run: RunState, context: WorkerRunnerContext): RunState {
  const unrecoverableFailure = hasUnrecoverableFailedSteps(run, context.agents);
  if (unrecoverableFailure) markBlockedDependentsSkipped(run, run.steps.find((step) => step.status === "failed"));
  refreshWorkUnitStatuses(run);
  updateRecoveryState(run, run.steps.find((step) => step.status === "failed"));
  run.status = terminalRunStatusForSteps(run, context.agents);
  run.endedAt = new Date().toISOString();
  run.metrics = summarizeRunMetrics(run);
  persistRun(run);
  context.onUpdate?.(run);
  return run;
}

export function terminalRunStatusForSteps(run: Pick<RunState, "steps"> & Partial<Pick<RunState, "intentContract" | "recoveryState">>, agents: Map<string, AgentDefinition>): RunState["status"] {
  if (hasUnrecoverableFailedSteps(run, agents)) return "failed";
  if (run.intentContract?.requiresInterview || run.recoveryState?.blockedByHumanInput) return "paused";
  if (run.steps.some((step) => step.status === "paused" || step.status === "pending" || step.status === "running")) return "paused";
  if (hasBlockingCheckpointedSteps(run)) return "paused";
  return "complete";
}

export function hasBlockingCheckpointedSteps(run: Pick<RunState, "steps">): boolean {
  return run.steps.some((step, index) => (
    step.status === "checkpointed"
    && !run.steps.some((candidate, candidateIndex) => candidateIndex > index && isUsableStepHandoff(candidate))
  ));
}

export function hasUnrecoverableFailedSteps(run: Pick<RunState, "steps">, agents: Map<string, AgentDefinition>): boolean {
  const failedIndexes = run.steps
    .map((step, index) => ({ step, index }))
    .filter(({ step }) => step.status === "failed");
  if (failedIndexes.length === 0) return false;
  if (failedIndexes.some(({ step }) => isWriterAgent(agents.get(step.agent)))) return true;

  const lastFailedIndex = Math.max(...failedIndexes.map(({ index }) => index));
  const failedStageIds = new Set(failedIndexes.map(({ step }) => stageIdForStep(step.id)));
  return !run.steps.some((step, index) => (
    index > lastFailedIndex
    && isUsableStepHandoff(step)
    && !failedStageIds.has(stageIdForStep(step.id))
  ));
}

const THINKING_ORDER: Array<Exclude<AgentThinkingLevel, "inherit">> = ["off", "minimal", "low", "medium", "high", "xhigh"];

export function normalizeThinkingForBudget(
  thinking: ReturnType<typeof resolveAgentThinking>,
  profile: ToolBudgetProfile,
  options: { handoffOnly?: boolean; hasPrevious?: boolean; agent?: AgentDefinition; model?: ExtensionContext["model"] } = {},
): ReturnType<typeof resolveAgentThinking> {
  const cap = evalAgentThinkingOverrideEnabled() ? undefined : thinkingCapForBudget(profile, options);
  const current = thinking.label === "inherit" ? undefined : thinking.label;
  const capped = cap && (!current || thinkingRank(current) > thinkingRank(cap)) ? cap : current;
  const effective = chooseSupportedThinkingAtOrBelow(capped, options.model);
  if (cap === "medium" && options.agent?.concern === "implementation" && effective && thinkingRank(effective) < thinkingRank("low")) {
    return thinking;
  }
  if (!effective) return thinking;
  if (effective === thinking.level && effective === thinking.label) return thinking;
  return { ...thinking, level: effective, label: effective };
}

function evalAgentThinkingOverrideEnabled(): boolean {
  const value = process.env.PI_CHALIN_EVAL_AGENT_THINKING?.trim();
  return value === "off" || value === "minimal" || value === "low" || value === "medium" || value === "high" || value === "xhigh";
}

function thinkingCapForBudget(profile: ToolBudgetProfile, options: { handoffOnly?: boolean; hasPrevious?: boolean; agent?: AgentDefinition }): Exclude<AgentThinkingLevel, "inherit"> | undefined {
  if (options.handoffOnly) return "minimal";
  if (options.hasPrevious && isEvidenceLedAgent(options.agent)) return "low";
  if (profile === "tight") return "low";
  if (profile === "normal" && options.agent?.concern === "implementation") return "medium";
  if (profile === "normal" && isEvidenceLedAgent(options.agent)) return "low";
  return undefined;
}

function chooseSupportedThinkingAtOrBelow(level: Exclude<AgentThinkingLevel, "inherit"> | undefined, model: ExtensionContext["model"] | undefined): Exclude<AgentThinkingLevel, "inherit"> | undefined {
  if (!level || !model) return level;
  const supported = new Set(getSupportedThinkingLevels(model).filter(isConcreteThinkingLevel));
  for (let index = thinkingRank(level); index >= 0; index -= 1) {
    const candidate = THINKING_ORDER[index];
    if (candidate && supported.has(candidate)) return candidate;
  }
  return level;
}

function isConcreteThinkingLevel(level: string): level is Exclude<AgentThinkingLevel, "inherit"> {
  return (THINKING_ORDER as string[]).includes(level);
}

function thinkingRank(level: Exclude<AgentThinkingLevel, "inherit">): number {
  return THINKING_ORDER.indexOf(level);
}

function isEvidenceLedAgent(agent: AgentDefinition | undefined): boolean {
  return agent?.concern === "recon"
    || agent?.concern === "research"
    || agent?.concern === "context-building"
    || agent?.concern === "review"
    || agent?.concern === "decision-consistency"
    || agent?.concern === "memory-curation";
}

function stageIdForStep(stepId: string): string {
  return stepId.includes(":") ? stepId.split(":")[0] ?? stepId : stepId;
}

function shouldUseMockSdkFallback(context: WorkerRunnerContext): boolean {
  return process.env.PI_CHALIN_RUNNER === "mock" || process.env.PI_OFFLINE === "1" || !context.extensionContext?.model;
}

function mockFallbackReason(context: WorkerRunnerContext): string {
  if (process.env.PI_CHALIN_RUNNER === "mock") return "SDK runner fallback: PI_CHALIN_RUNNER=mock requested.";
  if (process.env.PI_OFFLINE === "1") return "SDK runner fallback: PI_OFFLINE=1 avoids model calls during smoke tests.";
  if (!context.extensionContext?.model) return "SDK runner fallback: no active Pi model is available in extension context.";
  return "SDK runner fallback requested.";
}

function createStepActivityMonitor(step: RunStepState, run: RunState, context: WorkerRunnerContext) {
  let activeTools = 0;
  let lastActivityAt = Date.now();
  let lastActivitySignature = "";
  return {
    onToolActivity(activity: ChildToolActivity) {
      lastActivityAt = activity.at;
      if (activity.phase === "start") {
        activeTools += 1;
        step.currentTool = activity.toolName;
      } else if (activity.phase === "end") {
        activeTools = Math.max(0, activeTools - 1);
        if (activeTools === 0) step.currentTool = undefined;
      }
      context.onUpdate?.(run);
    },
    onSessionActivity(messages: unknown[]) {
      const signature = sessionActivityMarker(messages);
      if (signature === lastActivitySignature) return;
      lastActivitySignature = signature;
      lastActivityAt = Date.now();
    },
    activeOperations() {
      return activeTools;
    },
    lastActivityAt() {
      return lastActivityAt;
    },
  };
}

function sessionActivityMarker(messages: unknown[]): string {
  const last = messages.at(-1);
  const lastText = typeof last === "object" && last !== null ? JSON.stringify(last).slice(-512) : String(last ?? "");
  return `${messages.length}:${lastText.length}:${lastText}`;
}

function sessionActivitySignature(messages: unknown[], policy: ChildToolPolicy): string {
  const last = messages.at(-1);
  const lastText = typeof last === "object" && last !== null ? JSON.stringify(last).slice(-512) : String(last ?? "");
  const metrics = policy.metrics();
  return `${messages.length}:${lastText.length}:${metrics.toolCalls}:${metrics.outputChars}:${metrics.readBytes}`;
}

export const DEFAULT_SDK_STEP_IDLE_STALL_MS = 120_000;

export function sdkStepIdleStallMs(options: { thinkingLevel?: AgentThinkingLevel; budgetMaxSeconds?: number } = {}): number {
  const parsed = Number(process.env.PI_CHALIN_SDK_STEP_IDLE_STALL_MS);
  if (Number.isFinite(parsed) && parsed > 0) return parsed;
  const thinking = options.thinkingLevel && isConcreteThinkingLevel(options.thinkingLevel)
    ? options.thinkingLevel
    : undefined;
  const thinkingWindow = DEFAULT_SDK_STEP_IDLE_STALL_MS * Math.max(1, thinking ? thinkingRank(thinking) : 1);
  const budgetWindow = typeof options.budgetMaxSeconds === "number" && Number.isFinite(options.budgetMaxSeconds) && options.budgetMaxSeconds > 0
    ? options.budgetMaxSeconds * 1_000
    : undefined;
  return Math.max(DEFAULT_SDK_STEP_IDLE_STALL_MS, budgetWindow ? Math.min(thinkingWindow, budgetWindow) : thinkingWindow);
}

export class IdleStallError extends Error {
  readonly idleStallMs: number;
  metrics?: RunStepMetrics;
  assistantText?: string;

  constructor(message: string, idleStallMs: number) {
    super(`${message} after ${idleStallMs}ms without activity`);
    this.name = "IdleStallError";
    this.idleStallMs = idleStallMs;
  }
}

function isIdleStallError(error: unknown): error is IdleStallError {
  return error instanceof IdleStallError;
}

function shouldRetryIdleStallWithoutActivity(error: unknown, alreadyRetried: boolean): error is IdleStallError {
  if (alreadyRetried || !isIdleStallError(error)) return false;
  if (error.assistantText?.trim()) return false;
  const metrics = error.metrics;
  if (!metrics) return true;
  return (metrics.toolCalls ?? 0) === 0
    && Object.keys(metrics.toolCallsByName ?? {}).length === 0
    && (metrics.policyViolations ?? []).length === 0
    && (metrics.filesTouched ?? []).length === 0;
}

export async function runWithIdleStallMonitor<T>(
  promise: Promise<T>,
  options: {
    idleStallMs: number;
    message: string;
    signal?: AbortSignal;
    activeOperations?: () => number;
    pollActivitySignature?: () => string;
    onStall?: () => void;
    pollMs?: number;
  },
): Promise<T> {
  let lastActivityAt = Date.now();
  let lastSignature = options.pollActivitySignature?.();
  const pollMs = Math.max(10, Math.min(options.pollMs ?? 1_000, Math.max(10, Math.floor(options.idleStallMs / 4))));

  return await new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      clearInterval(timer);
      options.signal?.removeEventListener("abort", onAbort);
      callback();
    };
    const onAbort = () => finish(() => reject(new Error("pi-chalin run stopped by user.")));
    const timer = setInterval(() => {
      const signature = options.pollActivitySignature?.();
      if (signature !== undefined && signature !== lastSignature) {
        lastSignature = signature;
        lastActivityAt = Date.now();
      }
      const activeOperations = options.activeOperations?.() ?? 0;
      if (activeOperations > 0) {
        lastActivityAt = Date.now();
        return;
      }
      if (Date.now() - lastActivityAt >= options.idleStallMs) {
        options.onStall?.();
        finish(() => reject(new IdleStallError(options.message, options.idleStallMs)));
      }
    }, pollMs);
    timer.unref?.();
    options.signal?.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => finish(() => resolve(value)),
      (error) => finish(() => reject(error)),
    );
  });
}


function markRunAborted(run: RunState, context: WorkerRunnerContext, reason: string): void {
  for (const step of run.steps) {
    if (step.status === "running" || step.status === "pending") {
      step.status = "paused";
      step.error = reason;
      step.endedAt = new Date().toISOString();
    }
  }
  run.status = "paused";
  run.endedAt = new Date().toISOString();
  if (!run.warnings.includes(reason)) run.warnings.push(reason);
  persistRun(run);
  context.onUpdate?.(run);
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new Error("pi-chalin run stopped by user.");
}

function checkAbortEffect(signal?: AbortSignal): Effect.Effect<void, RunnerAbortError> {
  return Effect.try({
    try: () => throwIfAborted(signal),
    catch: (error) => new RunnerAbortError(errorMessage(error)),
  });
}

function runnerTryPromise<T>(tryPromise: () => Promise<T>, step?: RunStepState): Effect.Effect<T, RunnerError> {
  return Effect.tryPromise({
    try: tryPromise,
    catch: (error) => runnerErrorFromUnknown(error, step),
  });
}

function runnerErrorFromUnknown(error: unknown, step?: RunStepState): RunnerError {
  if (isAbortError(error)) return new RunnerAbortError(errorMessage(error));
  if (isBudgetExceededError(error, step)) return new BudgetExceededError(errorMessage(error));
  return new StepFailedError(errorMessage(error));
}

function isAbortError(error: unknown): boolean {
  const message = errorMessage(error).toLowerCase();
  return message.includes("abort") || message.includes("stopped by user");
}

function isBudgetExceededError(error: unknown, step?: RunStepState): boolean {
  const message = errorMessage(error).toLowerCase();
  return step?.status === "checkpointed" || message.includes("budget cap") || message.includes("budget exceeded");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function pushUniqueWarnings(run: RunState, warnings: string[]): void {
  for (const warning of warnings) {
    if (!run.warnings.includes(warning)) run.warnings.push(warning);
  }
}

function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error("pi-chalin run stopped by user."));
      return;
    }
    const timeout = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timeout);
      reject(new Error("pi-chalin run stopped by user."));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export function extractLastAssistantText(messages: unknown[]): string {
  const texts = messages
    .map(assistantTextFromMessage)
    .filter((text) => text.trim().length > 0);
  const last = texts.at(-1) ?? "";
  const contractual = [...texts].reverse().find(hasAgentContractSection) ?? "";
  if (contractual && contractual !== last && !hasAgentContractSection(last)) return [contractual, last].filter(Boolean).join("\n\n");
  return last || contractual;
}

function assistantTextFromMessage(message: unknown): string {
  if (!message || typeof message !== "object") return "";
  const maybe = message as { role?: unknown; content?: unknown };
  if (maybe.role !== "assistant") return "";
  if (typeof maybe.content === "string") return maybe.content;
  if (Array.isArray(maybe.content)) {
    return maybe.content.map((part) => typeof part?.text === "string" ? part.text : "").join("\n").trim();
  }
  return "";
}

function hasAgentContractSection(text: string): boolean {
  return /(?:^|\n)##\s+(?:Agent Handoff|Structured Handoff|Reviewer Verdict|Handoff)\b/i.test(text);
}

export function extractAssistantRuntimeError(messages: unknown[]): string | undefined {
  for (const message of [...messages].reverse()) {
    if (!isRecord(message) || message.role !== "assistant") continue;
    const stopReason = typeof message.stopReason === "string" ? message.stopReason : "";
    const error = typeof message.errorMessage === "string" ? message.errorMessage : "";
    if (stopReason === "error") return error || "assistant runtime error";
    if (error) return error;
  }
  return undefined;
}

function extractSessionMetrics(messages: unknown[], startedAtMs: number): RunStepMetrics {
  const responseIds = new Set<string>();
  const usage = emptyUsage();
  const toolCallsByName: Record<string, number> = {};
  const filesRead: string[] = [];
  const shellCommands: string[] = [];
  const policyViolations: string[] = [];
  let mutationSeen = false;
  let postMutationShellCommands = 0;
  let toolCalls = 0;
  for (const message of messages) {
    if (!isRecord(message) || message.role !== "assistant") continue;
    const responseId = typeof message.responseId === "string" ? message.responseId : undefined;
    if (responseId && responseIds.has(responseId)) continue;
    if (responseId) responseIds.add(responseId);
    addUsage(usage, usageFromMessage(message));
    for (const call of toolCallRecords(message)) {
      const name = call.name;
      toolCalls += 1;
      toolCallsByName[name] = (toolCallsByName[name] ?? 0) + 1;
      const path = typeof call.args.path === "string" ? call.args.path : undefined;
      if (name === "read" && path) filesRead.push(path);
      if (name === "bash") {
        const command = typeof call.args.command === "string" ? call.args.command : undefined;
        if (command) shellCommands.push(command);
        if (mutationSeen) postMutationShellCommands += 1;
      }
      if (name === "edit" || name === "write") mutationSeen = true;
    }
  }
  const duplicateReadCount = filesRead.length - new Set(filesRead).size;
  return {
    durationMs: Date.now() - startedAtMs,
    usage,
    toolCalls,
    toolCallsByName,
    ...(policyViolations.length ? { policyViolations } : {}),
    ...(duplicateReadCount > 0 ? { duplicateReadCount } : {}),
    ...(filesRead.length ? { filesRead: [...new Set(filesRead)].slice(0, 30) } : {}),
    ...(shellCommands.length ? { shellCommands: shellCommands.slice(0, 30) } : {}),
    ...(postMutationShellCommands > 0 ? { postMutationShellCommands } : {}),
  };
}

function canRetryWithInheritedModel(metrics: RunStepMetrics): boolean {
  return metrics.toolCalls === 0
    && (metrics.filesTouched?.length ?? 0) === 0
    && (metrics.shellCommands?.length ?? 0) === 0;
}

function mergeAttemptMetrics(previous: RunStepMetrics | undefined, next: RunStepMetrics): RunStepMetrics {
  if (!previous) return next;
  const usage = emptyUsage();
  addUsage(usage, previous.usage);
  addUsage(usage, next.usage);
  const toolCallsByName = { ...previous.toolCallsByName };
  for (const [name, count] of Object.entries(next.toolCallsByName)) {
    toolCallsByName[name] = (toolCallsByName[name] ?? 0) + count;
  }
  return {
    ...next,
    durationMs: previous.durationMs + next.durationMs,
    usage,
    toolCalls: previous.toolCalls + next.toolCalls,
    toolCallsByName,
    maxToolCalls: Math.max(previous.maxToolCalls ?? 0, next.maxToolCalls ?? 0) || undefined,
    policyViolations: [...(previous.policyViolations ?? []), ...(next.policyViolations ?? [])],
    budgetStopCount: (previous.budgetStopCount ?? 0) + (next.budgetStopCount ?? 0) || undefined,
    budgetCapHits: mergeBudgetCapHits(previous.budgetCapHits, next.budgetCapHits),
    duplicateReadCount: (previous.duplicateReadCount ?? 0) + (next.duplicateReadCount ?? 0) || undefined,
    filesRead: [...new Set([...(previous.filesRead ?? []), ...(next.filesRead ?? [])])].slice(0, 50),
    readBytes: (previous.readBytes ?? 0) + (next.readBytes ?? 0),
    outputChars: (previous.outputChars ?? 0) + (next.outputChars ?? 0),
    outputCharsByToolName: mergeNumberRecords(previous.outputCharsByToolName, next.outputCharsByToolName),
    outputTruncatedCount: (previous.outputTruncatedCount ?? 0) + (next.outputTruncatedCount ?? 0),
    filesTouched: [...new Set([...(previous.filesTouched ?? []), ...(next.filesTouched ?? [])])].slice(0, 50),
    shellCommands: [...(previous.shellCommands ?? []), ...(next.shellCommands ?? [])].slice(0, 50),
    postMutationShellCommands: (previous.postMutationShellCommands ?? 0) + (next.postMutationShellCommands ?? 0) || undefined,
    successfulPostMutationShellCommands: (previous.successfulPostMutationShellCommands ?? 0) + (next.successfulPostMutationShellCommands ?? 0) || undefined,
    retriesByTool: { ...(previous.retriesByTool ?? {}), ...(next.retriesByTool ?? {}) },
    tokenomics: mergeTokenomics(previous.tokenomics, next.tokenomics),
    spans: mergeTraceSpans(previous.spans, next.spans),
    trajectoryEvents: mergeTrajectoryEvents(previous.trajectoryEvents, next.trajectoryEvents),
  };
}

function mergePolicyMetrics(metrics: RunStepMetrics, policy: ChildToolPolicy): RunStepMetrics {
  const policyMetrics = policy.metrics();
  const toolCallsByName = { ...metrics.toolCallsByName };
  for (const [name, count] of Object.entries(policyMetrics.toolCallsByName)) {
    toolCallsByName[name] = Math.max(toolCallsByName[name] ?? 0, count);
  }
  const policyViolations = [...(metrics.policyViolations ?? []), ...policyMetrics.policyViolations];
  const filesRead = [...new Set([...(metrics.filesRead ?? []), ...policyMetrics.filesRead])];
  const duplicateReadCount = Math.max(metrics.duplicateReadCount ?? 0, policyMetrics.duplicateReadCount);
  const budgetCapHits = mergeBudgetCapHits(metrics.budgetCapHits, policyMetrics.budgetCapHits);
  const budgetStopCount = Math.max(metrics.budgetStopCount ?? 0, policyMetrics.budgetStopCount);
  const shellCommands = [...(metrics.shellCommands ?? []), ...policyMetrics.shellCommands].slice(0, 50);
  const postMutationShellCommands = Math.max(metrics.postMutationShellCommands ?? 0, policyMetrics.postMutationShellCommands);
  const successfulPostMutationShellCommands = Math.max(metrics.successfulPostMutationShellCommands ?? 0, policyMetrics.successfulPostMutationShellCommands);
  const outputCharsByToolName = mergeNumberRecordsByMax(metrics.outputCharsByToolName, policyMetrics.outputCharsByToolName);
  return {
    ...metrics,
    toolCalls: Math.max(metrics.toolCalls, policyMetrics.toolCalls),
    maxToolCalls: policy.maxToolCalls,
    toolCallsByName,
    ...(policyViolations.length ? { policyViolations } : {}),
    ...(budgetStopCount > 0 ? { budgetStopCount } : {}),
    ...(budgetCapHits.length ? { budgetCapHits } : {}),
    ...(duplicateReadCount > 0 ? { duplicateReadCount } : {}),
    ...(filesRead.length ? { filesRead: filesRead.slice(0, 50) } : {}),
    readBytes: Math.max(metrics.readBytes ?? 0, policyMetrics.readBytes),
    outputChars: Math.max(metrics.outputChars ?? 0, policyMetrics.outputChars),
    ...(Object.keys(outputCharsByToolName).length ? { outputCharsByToolName } : {}),
    outputTruncatedCount: Math.max(metrics.outputTruncatedCount ?? 0, policyMetrics.outputTruncatedCount),
    filesTouched: [...new Set([...(metrics.filesTouched ?? []), ...policyMetrics.filesTouched])].slice(0, 50),
    ...(shellCommands.length ? { shellCommands } : {}),
    ...(postMutationShellCommands > 0 ? { postMutationShellCommands } : {}),
    ...(successfulPostMutationShellCommands > 0 ? { successfulPostMutationShellCommands } : {}),
    retriesByTool: { ...(metrics.retriesByTool ?? {}), ...policyMetrics.retriesByTool },
    trajectoryEvents: metrics.trajectoryEvents,
  };
}

function tokenomicsForToolOutputs(metrics: RunStepMetrics): TokenomicsSummary | undefined {
  return buildToolOutputTokenomics(metrics.outputChars ?? 0, metrics.outputCharsByToolName);
}

function mergeNumberRecords(left: Record<string, number> | undefined, right: Record<string, number> | undefined): Record<string, number> {
  const merged: Record<string, number> = {};
  for (const [key, value] of Object.entries(left ?? {})) {
    if (Number.isFinite(value)) merged[key] = (merged[key] ?? 0) + value;
  }
  for (const [key, value] of Object.entries(right ?? {})) {
    if (Number.isFinite(value)) merged[key] = (merged[key] ?? 0) + value;
  }
  return merged;
}

function mergeNumberRecordsByMax(left: Record<string, number> | undefined, right: Record<string, number> | undefined): Record<string, number> {
  const merged: Record<string, number> = {};
  for (const [key, value] of Object.entries(left ?? {})) {
    if (Number.isFinite(value)) merged[key] = Math.max(merged[key] ?? 0, value);
  }
  for (const [key, value] of Object.entries(right ?? {})) {
    if (Number.isFinite(value)) merged[key] = Math.max(merged[key] ?? 0, value);
  }
  return merged;
}

function finalizeStepMetrics(metrics: RunStepMetrics, step: RunStepState, budgetPolicy: ReturnType<typeof policyForStep>, priorFilesRead: string[] = []): RunStepMetrics {
  const mutated = (metrics.toolCallsByName.edit ?? 0) > 0 || (metrics.toolCallsByName.write ?? 0) > 0;
  const verificationDone = mutated ? (metrics.successfulPostMutationShellCommands ?? metrics.postMutationShellCommands ?? 0) > 0 : false;
  const progressInput = {
    findings: extractFindingLines(step.output?.text ?? ""),
    toolCalls: metrics.toolCalls,
    filesRead: metrics.filesRead ?? [],
    firstSignalToolCall: firstSignalToolCall(metrics),
    verificationDone,
    memoryCandidates: (step.output?.memoryCandidates ?? []).map((candidate) => ({ content: candidate.content, category: candidate.category, confidence: candidate.confidence })),
  };
  const utility = summarizeToolUtility(progressInput);
  const progress = scoreProgress(progressInput);
  const health = evaluateBudgetUsage(budgetPolicy, {
    elapsedMs: metrics.durationMs,
    toolCalls: metrics.toolCalls,
    totalCostUsd: metrics.usage.cost.total,
    turns: Math.max(1, Math.ceil(metrics.usage.output / 4000)),
    outputChars: metrics.outputChars ?? step.output?.text.length ?? 0,
    readBytes: metrics.readBytes ?? 0,
    filesTouched: metrics.filesTouched?.length ?? 0,
    retriesByTool: metrics.retriesByTool ?? {},
  }, progress);
  const prior = new Set(priorFilesRead);
  const crossStepDuplicateReads = [...new Set((metrics.filesRead ?? []).filter((file) => prior.has(file)))];
  const budgetCapHits = mergeBudgetCapHits(metrics.budgetCapHits, health.caps);
  const budgetStopCount = metrics.budgetStopCount ?? 0;
  if (budgetStopCount > 0 || health.checkpointStatus) {
    const kind = budgetStopCount > 0
      ? "budget-cap"
      : health.checkpointStatus === "checkpointed-low-signal"
      ? "low-signal"
      : health.checkpointStatus === "checkpointed-split-recommended"
        ? "split-recommended"
        : health.checkpointStatus === "checkpointed-awaiting-review"
          ? "awaiting-review"
          : "needs-continuation";
    step.checkpoint = {
      kind,
      continuation: kind === "budget-cap" ? "continue" : kind === "awaiting-review" ? "review" : kind === "split-recommended" ? "split" : "resume",
      reason: health.warnings[0] ?? "Budget gate checkpointed this step.",
      progressScore: progress.score,
      capHits: budgetCapHits,
    };
  }
  const skillEvents = mergeSkillTraceEvents([
    ...(step.skillTraceEvents ?? []),
    ...skillEventsForStep(step, utility),
  ]);
  const trajectoryEvents = mergeTrajectoryEvents(metrics.trajectoryEvents, trajectoryEventsForStep(step, metrics, progress, health.next));
  return {
    ...metrics,
    utility,
    progress,
    ...(step.activeSkills?.length ? { skills: step.activeSkills.map((item) => item.skill.qualifiedName) } : {}),
    ...(trajectoryEvents.length ? { trajectoryEvents } : {}),
    ...(skillEvents.length ? { skillEvents } : {}),
    ...(budgetCapHits.length ? { budgetCapHits } : {}),
    ...(crossStepDuplicateReads.length ? {
      crossStepDuplicateReadCount: crossStepDuplicateReads.length,
      crossStepDuplicateReads: crossStepDuplicateReads.slice(0, 30),
    } : {}),
    ...(budgetStopCount > 0 ? { budgetStopCount } : {}),
  };
}

function trajectoryEventsForStep(step: RunStepState, metrics: RunStepMetrics, progress: NonNullable<RunStepMetrics["progress"]>, budgetNext: string): TrajectoryEvent[] {
  const events = [
    createTrajectoryEvent({
      type: "policy.decision",
      stepId: step.id,
      agent: step.agent,
      decision: progress.gate,
      confidence: progress.level === "high" ? 0.85 : progress.level === "medium" ? 0.65 : 0.45,
      blockingGap: progress.gate !== "continue",
      reason: [...progress.positiveSignals, ...progress.negativeSignals].join(", ") || "no progress signals",
      metadata: { score: progress.score, budgetNext },
    }),
  ];
  if (step.output?.reviewerVerdict) {
    const verdict = step.output.reviewerVerdict;
    events.push(createTrajectoryEvent({
      type: "reviewer.verdict",
      stepId: step.id,
      agent: step.agent,
      decision: verdict.verdict,
      confidence: verdict.evidence.length > 0 ? 0.85 : 0.6,
      blockingGap: verdict.verdict !== "pass" || verdict.blockingFindings.length > 0 || verdict.missingCoverage.length > 0,
      reason: verdict.requiredRepair || verdict.blockingFindings[0] || verdict.missingCoverage[0] || "structured reviewer verdict",
      metadata: {
        blockingFindings: verdict.blockingFindings.length,
        missingCoverage: verdict.missingCoverage.length,
        evidence: verdict.evidence.length,
      },
    }));
  }
  if ((metrics.postMutationShellCommands ?? 0) > 0 || (metrics.successfulPostMutationShellCommands ?? 0) > 0) {
    const success = (metrics.successfulPostMutationShellCommands ?? 0) > 0;
    events.push(createTrajectoryEvent({
      type: "verifier.result",
      stepId: step.id,
      agent: step.agent,
      decision: success ? "pass" : "attempted",
      confidence: success ? 0.82 : 0.55,
      blockingGap: !success,
      reason: success ? "post-mutation verification command succeeded" : "post-mutation verification was attempted without recorded success",
      metadata: {
        postMutationShellCommands: metrics.postMutationShellCommands ?? 0,
        successfulPostMutationShellCommands: metrics.successfulPostMutationShellCommands ?? 0,
      },
    }));
  }
  return events;
}

function skillEventsForStep(step: RunStepState, utility: RunStepMetrics["utility"]): SkillTraceEvent[] {
  const reviewerPass = step.agent === "reviewer" && step.output?.reviewerVerdict
    ? step.output.reviewerVerdict.verdict === "pass"
    : undefined;
  const retries = Object.values(step.metrics?.retriesByTool ?? {}).reduce((total, count) => total + count, 0);
  return [
    ...(step.activeSkills ?? []).map((item) => createSkillTraceEvent({
      type: "skill.activation.applied",
      skill: item.skill.qualifiedName,
      scope: item.skill.scope,
      trust: item.skill.trust,
      stepId: step.id,
      agent: step.agent,
      reason: item.reason,
    })),
    ...(step.activeSkills ?? []).map((item) => createSkillTraceEvent({
      type: "skill.outcome.recorded",
      skill: item.skill.qualifiedName,
      scope: item.skill.scope,
      trust: item.skill.trust,
      stepId: step.id,
      agent: step.agent,
      reason: step.status,
      metadata: {
        verification: utility?.verificationDone === true ? "observed" : "unknown",
        reviewerPass: reviewerPass === undefined ? "unknown" : reviewerPass ? "true" : "false",
        retries,
      },
    })),
    ...(step.suggestedSkills ?? []).map((item) => createSkillTraceEvent({
      type: "skill.match.result",
      skill: item.skill.qualifiedName,
      scope: item.skill.scope,
      trust: item.skill.trust,
      stepId: step.id,
      agent: step.agent,
      reason: `suggested: ${item.reason}`,
    })),
    ...(step.rejectedSkills ?? []).slice(0, 20).map((item) => createSkillTraceEvent({
      type: "skill.activation.rejected",
      skill: item.skill.qualifiedName,
      scope: item.skill.scope,
      trust: item.skill.trust,
      stepId: step.id,
      agent: step.agent,
      reason: item.reason,
    })),
  ];
}

function mergeSkillTraceEvents(events: SkillTraceEvent[]): SkillTraceEvent[] {
  const seen = new Set<string>();
  const merged: SkillTraceEvent[] = [];
  for (const event of events) {
    const key = [
      event.type,
      event.skill ?? "",
      event.scope ?? "",
      event.agent ?? "",
      event.stepId ?? "",
      event.policy ?? "",
      event.reason ?? "",
      JSON.stringify(event.metadata ?? {}),
    ].join("\u0000");
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(event);
  }
  return merged.slice(0, 80);
}

function baseStepSpans(
  prefix: string,
  step: RunStepState,
  startedAt: number,
  endedAt: number,
  tokenomics: TokenomicsSummary,
  promptOptions: SdkPromptOptions,
): StructuredTraceSpan[] {
  const spans = [
    createStructuredSpan({
      id: `${prefix}:step`,
      name: `${step.agent}:${step.id}`,
      kind: "step",
      startedAt,
      endedAt,
      attributes: { agent: step.agent, status: step.status, estimatedTokens: tokenomics.totalEstimatedTokens },
    }),
    createStructuredSpan({
      id: `${prefix}:prompt-build`,
      parentId: `${prefix}:step`,
      name: "build child prompt",
      kind: "prompt-build",
      startedAt,
      endedAt: startedAt,
      attributes: { estimatedTokens: tokenomics.totalEstimatedTokens, childPromptTokens: tokenomics.phases.childPrompt.estimatedTokens },
    }),
  ];
  if (promptOptions.memoryContext?.trim()) {
    spans.push(createStructuredSpan({
      id: `${prefix}:memory-read`,
      parentId: `${prefix}:step`,
      name: "compact memory context",
      kind: "memory-read",
      startedAt,
      endedAt: startedAt,
      attributes: { estimatedTokens: tokenomics.phases.memory.estimatedTokens },
    }));
  }
  return spans;
}

function traceKindForTool(toolName: string): StructuredTraceSpanKind {
  if (toolName === "chalin_web_search") return "webfetch";
  if (toolName === "chalin_interview") return "interview";
  if (toolName === "chalin_artifact_write") return "checkpoint";
  return "tool-call";
}

function extractFindingLines(text: string): string[] {
  const block = text.match(/##\s*Findings\s*\n([\s\S]*?)(?:\n##\s|$)/i)?.[1] ?? text;
  return block.split("\n")
    .map((line) => line.replace(/^\s*[-*]\s*/, "").trim())
    .filter((line) => line.length > 20)
    .slice(0, 12);
}

function firstSignalToolCall(metrics: RunStepMetrics): number {
  const readCalls = metrics.toolCallsByName.read ?? 0;
  const discoveryCalls = metrics.toolCallsByName.chalin_project_discovery ?? 0;
  if ((metrics.filesRead?.length ?? 0) > 0 || discoveryCalls > 0) return Math.max(1, Math.min(metrics.toolCalls, discoveryCalls || readCalls || 1));
  return metrics.toolCalls;
}

function mergeBudgetCapHits(...groups: Array<BudgetCapHit[] | undefined>): BudgetCapHit[] {
  const merged: BudgetCapHit[] = [];
  const seen = new Set<string>();
  for (const group of groups) {
    for (const hit of group ?? []) {
      const key = `${hit.phase}:${hit.severity}:${hit.name}:${hit.toolName ?? ""}`;
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push(hit);
    }
  }
  return merged.slice(0, 50);
}

function summarizeRunMetrics(run: RunState): RunState["metrics"] {
  const usage = emptyUsage();
  const toolCallsByName: Record<string, number> = {};
  const policyViolations: string[] = [];
  const budgetCapHits: BudgetCapHit[] = [];
  const filesRead: string[] = [];
  const crossStepDuplicateReads: string[] = [];
  const spans: StructuredTraceSpan[] = [];
  const skillEvents: SkillTraceEvent[] = [];
  const trajectoryEvents: TrajectoryEvent[] = runLifecycleTrajectoryEvents(run);
  let tokenomics: TokenomicsSummary | undefined;
  let toolCalls = 0;
  let duplicateReadCount = 0;
  let crossStepDuplicateReadCount = 0;
  let budgetStopCount = 0;
  for (const step of run.steps) {
    if (!step.metrics) continue;
    addUsage(usage, step.metrics.usage);
    toolCalls += step.metrics.toolCalls;
    duplicateReadCount += step.metrics.duplicateReadCount ?? 0;
    crossStepDuplicateReadCount += step.metrics.crossStepDuplicateReadCount ?? 0;
    budgetStopCount += step.metrics.budgetStopCount ?? 0;
    policyViolations.push(...(step.metrics.policyViolations ?? []));
    budgetCapHits.push(...(step.metrics.budgetCapHits ?? []));
    filesRead.push(...(step.metrics.filesRead ?? []));
    crossStepDuplicateReads.push(...(step.metrics.crossStepDuplicateReads ?? []));
    spans.push(...(step.metrics.spans ?? []));
    skillEvents.push(...(step.metrics.skillEvents ?? []));
    trajectoryEvents.push(...(step.metrics.trajectoryEvents ?? []));
    tokenomics = mergeTokenomics(tokenomics, step.metrics.tokenomics);
    for (const [name, count] of Object.entries(step.metrics.toolCallsByName)) {
      toolCallsByName[name] = (toolCallsByName[name] ?? 0) + count;
    }
  }
  return {
    durationMs: durationMs(run.startedAt, run.endedAt),
    usage,
    toolCalls,
    toolCallsByName,
    ...(policyViolations.length ? { policyViolations } : {}),
    ...(budgetStopCount > 0 ? { budgetStopCount } : {}),
    ...(budgetCapHits.length ? { budgetCapHits: mergeBudgetCapHits(budgetCapHits) } : {}),
    ...(duplicateReadCount > 0 ? { duplicateReadCount } : {}),
    ...(crossStepDuplicateReadCount > 0 ? { crossStepDuplicateReadCount, crossStepDuplicateReads: [...new Set(crossStepDuplicateReads)].slice(0, 50) } : {}),
    ...(filesRead.length ? { filesRead: [...new Set(filesRead)].slice(0, 50) } : {}),
    ...(tokenomics ? { tokenomics } : {}),
    ...(spans.length ? { spans: mergeTraceSpans(buildRunLifecycleSpans(run), spans) } : {}),
    ...(trajectoryEvents.length ? { trajectoryEvents: mergeTrajectoryEvents(trajectoryEvents) } : {}),
    ...(skillEvents.length ? { skillEvents: skillEvents.slice(0, 200) } : {}),
    ...(checkpointSummary(run.steps) ? { checkpoints: checkpointSummary(run.steps) } : {}),
  };
}

function runLifecycleTrajectoryEvents(run: RunState): TrajectoryEvent[] {
  const events: TrajectoryEvent[] = [
    createTrajectoryEvent({
      type: "routing.decision",
      runId: run.id,
      decision: run.route.kind,
      confidence: run.route.ambiguity === "low" ? 0.82 : run.route.ambiguity === "medium" ? 0.62 : 0.42,
      blockingGap: false,
      reason: run.route.reason,
      metadata: {
        risk: run.route.risk,
        agents: run.route.agents.length,
        expectedEffects: run.route.expectedEffects?.join(",") ?? "unspecified",
      },
    }),
  ];
  for (const step of run.steps) {
    if (!step.id.includes("review-repair")) continue;
    events.push(createTrajectoryEvent({
      type: "repair.decision",
      runId: run.id,
      stepId: step.id,
      agent: step.agent,
      decision: step.status,
      confidence: 0.78,
      blockingGap: step.status === "failed" || step.status === "paused",
      reason: step.task.slice(0, 240),
    }));
  }
  return events;
}

function mergeTokenomics(previous: TokenomicsSummary | undefined, next: TokenomicsSummary | undefined): TokenomicsSummary | undefined {
  if (!previous) return next;
  if (!next) return previous;
  const phases = { ...previous.phases };
  for (const [phase, estimate] of Object.entries(next.phases) as Array<[keyof TokenomicsSummary["phases"], TokenomicsSummary["phases"][keyof TokenomicsSummary["phases"]]]>) {
    phases[phase] = {
      estimatedChars: phases[phase].estimatedChars + estimate.estimatedChars,
      estimatedTokens: phases[phase].estimatedTokens + estimate.estimatedTokens,
    };
  }
  return {
    phases,
    totalEstimatedChars: previous.totalEstimatedChars + next.totalEstimatedChars,
    totalEstimatedTokens: previous.totalEstimatedTokens + next.totalEstimatedTokens,
  };
}

function usageFromMessage(message: Record<string, unknown>): TokenUsageSummary {
  const raw = isRecord(message.usage) ? message.usage : {};
  const cost = isRecord(raw.cost) ? raw.cost : {};
  return {
    input: numberValue(raw.input),
    output: numberValue(raw.output),
    cacheRead: numberValue(raw.cacheRead),
    cacheWrite: numberValue(raw.cacheWrite),
    totalTokens: numberValue(raw.totalTokens) || numberValue(raw.input) + numberValue(raw.output) + numberValue(raw.cacheRead) + numberValue(raw.cacheWrite),
    cost: {
      input: numberValue(cost.input),
      output: numberValue(cost.output),
      cacheRead: numberValue(cost.cacheRead),
      cacheWrite: numberValue(cost.cacheWrite),
      total: numberValue(cost.total),
    },
  };
}

function toolCallRecords(message: Record<string, unknown>): Array<{ name: string; args: Record<string, unknown> }> {
  const content = Array.isArray(message.content) ? message.content : [];
  return content
    .filter((part): part is Record<string, unknown> => isRecord(part) && part.type === "toolCall" && typeof part.name === "string")
    .map((part) => ({ name: part.name as string, args: parseToolArgs(part) }));
}

function parseToolArgs(part: Record<string, unknown>): Record<string, unknown> {
  for (const key of ["args", "input", "parameters"]) {
    const value = part[key];
    if (isRecord(value)) return value;
    if (typeof value === "string") {
      try {
        const parsed = JSON.parse(value) as unknown;
        if (isRecord(parsed)) return parsed;
      } catch {
        // ignore malformed tool args
      }
    }
  }
  return {};
}

function emptyUsage(): TokenUsageSummary {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
}

function addUsage(target: TokenUsageSummary, source: TokenUsageSummary): void {
  target.input += source.input;
  target.output += source.output;
  target.cacheRead += source.cacheRead;
  target.cacheWrite += source.cacheWrite;
  target.totalTokens += source.totalTokens;
  target.cost.input += source.cost.input;
  target.cost.output += source.cost.output;
  target.cost.cacheRead += source.cost.cacheRead;
  target.cost.cacheWrite += source.cost.cacheWrite;
  target.cost.total += source.cost.total;
}

function numberValue(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function durationMs(startedAt: string, endedAt?: string): number {
  const end = endedAt ? Date.parse(endedAt) : Date.now();
  const start = Date.parse(startedAt);
  return Number.isFinite(end) && Number.isFinite(start) ? Math.max(0, end - start) : 0;
}

function findLastIndex<T>(items: T[], predicate: (item: T, index: number) => boolean): number {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    if (predicate(items[index]!, index)) return index;
  }
  return -1;
}
