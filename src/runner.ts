import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import { Context, Effect, Layer } from "effect";
import type { AgentDefinition, AgentThinkingLevel } from "./schemas.ts";
import { evaluateBudgetUsage, policyForStep, recordBudgetCheckpoint, summarizeToolUtility } from "./budget.ts";
import type { ChalinPathsOptions } from "./paths.ts";
import { createMemoryCandidate } from "./memory.ts";
import { createConfiguredMemoryStore } from "./memory-provider.ts";
import type { AgentOutput, AgentStep, BudgetCapHit, MemoryCandidate, RouteDecision, RoutePlan, RunState, RunStepMetrics, RunStepState, TokenUsageSummary, ToolBudgetProfile } from "./schemas.ts";
import { createChildToolPolicy, createChildTools, type ChalinDelegateParamsShape, type ChildToolActivity, type ChildToolPolicy } from "./child-tools.ts";
import { createChalinChildSessionManager } from "./child-sessions.ts";
import { buildProjectSnapshot, formatProjectSnapshot } from "./snapshot.ts";
import { ArtifactStore } from "./artifacts.ts";
import { resolveAgentModel, resolveAgentThinking, resolveInheritedModelFallback, type ResolvedAgentModel } from "./model-resolution.ts";
import { buildSdkPrompt, childToolNames, handoffReviewToolCallLimit, isHandoffGapReadMode, resolveStepCompletionStatus, synthesisCrossStepDuplicateReadLimit, synthesisGapReadLimit, synthesisToolCallLimit, type SdkPromptOptions } from "./runner-prompt.ts";
import { createRunState, isUsableStepHandoff, persistRun, prepareRunForResume } from "./runner-state.ts";
import { clearLiveStepSession, setLiveStepSession, type LiveStepSessionRef } from "./runtime-state.ts";
import { cleanupWorktrees, mergeWorktreeChanges, needsWorktreeIsolation, prepareWorktreeIsolation, type WorktreeIsolationPlan } from "./worktrees.ts";

export interface WorkerRunnerContext extends ChalinPathsOptions {
  agents: Map<string, AgentDefinition>;
  rootTask?: string;
  modelOverrides?: Record<string, string>;
  thinkingOverrides?: Record<string, AgentThinkingLevel>;
  parentRunId?: string;
  parentStepId?: string;
  delegationDepth?: number;
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
    });
    persistRun(run);
    context.onUpdate?.(run);
    const plan = route.plan;
    if (!plan) return completeRun(run, context);
    if (plan.kind === "parallel" && needsWorktreeIsolation(plan.tasks, context.agents)) {
      const isolation = prepareWorktreeIsolation({ cwd: context.cwd, runId: run.id, steps: plan.tasks, agents: context.agents });
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
    if (plan.kind === "single") {
      yield* runChainEffect(run, [run.steps[0]!], context, {});
    } else if (plan.kind === "chain") {
      yield* runChainEffect(run, run.steps, context, {});
    } else if (plan.kind === "parallel") {
      yield* runParallelEffect(run.steps, context, undefined, run, "runner.mock.parallel");
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
    if (plan.kind === "single" || plan.kind === "chain") {
      yield* runChainEffect(run, run.steps, context, { resume: true, initialPrevious: aggregateCompletedHandoffBefore(run.steps, run.steps.length) });
    } else if (plan.kind === "parallel") {
      yield* runParallelEffect(run.steps.filter((step) => !isUsableStepHandoff(step)), context, undefined, run, "runner.mock.resumeParallel");
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
    });
    persistRun(run);
    context.onUpdate?.(run);
    const plan = route.plan;
    if (!plan) return completeRun(run, context);
    if (plan.kind === "parallel") {
      await runSdkParallelSteps(run, plan.tasks, context, extensionContext);
    } else if (plan.kind === "dag") {
      await runSdkDag(run, plan.stages, context, extensionContext);
    } else {
      let previous = "";
      for (let index = 0; index < run.steps.length; index += 1) {
        const step = run.steps[index]!;
        const result = await runSdkStep(step, context, extensionContext, run, { previous, cwd: context.cwd });
        if (result.aborted || result.paused) break;
        previous = result.handoff ?? previous;
        maybeAppendImplementationReviewRepair(run, step);
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
    if (plan.kind === "parallel") {
      await runSdkParallelSteps(run, plan.tasks, context, extensionContext);
    } else if (plan.kind === "dag") {
      await runSdkDag(run, plan.stages, context, extensionContext);
    } else {
      let previous = "";
      for (let index = 0; index < run.steps.length; index += 1) {
        const step = run.steps[index]!;
        if (isUsableStepHandoff(step)) {
          previous = step.output?.handoff ?? step.output?.text ?? previous;
          maybeAppendImplementationReviewRepair(run, step);
          continue;
        }
        const result = await runSdkStep(step, context, extensionContext, run, { previous, cwd: context.cwd });
        if (result.aborted || result.paused) break;
        previous = result.handoff ?? previous;
        maybeAppendImplementationReviewRepair(run, step);
      }
    }

    return completeRun(run, context);
  }
}

async function runMockDag(run: RunState, stages: Extract<RoutePlan, { kind: "dag" }>["stages"], context: WorkerRunnerContext): Promise<void> {
  let previous = "";
  for (let stageIndex = 0; stageIndex < stages.length; stageIndex += 1) {
    const stage = stages[stageIndex]!;
    throwIfAborted(context.signal);
    const stageSteps = run.steps.filter((step) => step.id.startsWith(`${stage.id}:`));
    const outputs = await runParallel(stageSteps, context, previous, run, `mock-dag:${stage.id}`);
    for (const step of stageSteps) maybeAppendImplementationReviewRepair(run, step);
    previous = aggregateHandoff(outputs.map((output) => ({ agent: output.agent, text: output.handoff ?? output.text })));
  }
}

async function resumeMockDag(run: RunState, stages: Extract<RoutePlan, { kind: "dag" }>["stages"], context: WorkerRunnerContext): Promise<void> {
  let previous = "";
  for (let stageIndex = 0; stageIndex < stages.length; stageIndex += 1) {
    const stage = stages[stageIndex]!;
    throwIfAborted(context.signal);
    const stageSteps = run.steps.filter((step) => step.id.startsWith(`${stage.id}:`));
    if (stageSteps.every((step) => isUsableStepHandoff(step))) {
      previous = aggregateStageHandoff(stageSteps);
      for (const step of stageSteps) maybeAppendImplementationReviewRepair(run, step);
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
    for (const step of stageSteps) maybeAppendImplementationReviewRepair(run, step);
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
  if (needsWorktreeIsolation(tasks, context.agents)) {
    isolation = prepareWorktreeIsolation({ cwd: context.cwd, runId: run.id, steps: tasks, agents: context.agents });
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
      run.steps,
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

    if (isolation?.enabled) await mergeIsolatedStage(run, context, extensionContext, isolation);
  } finally {
    if (isolation?.enabled) run.warnings.push(...cleanupWorktrees({ cwd: context.cwd, plan: isolation }));
  }
}

async function mergeIsolatedStage(run: RunState, context: WorkerRunnerContext, extensionContext: ExtensionContext, isolation: WorktreeIsolationPlan): Promise<void> {
  const merge = mergeWorktreeChanges({ cwd: context.cwd, plan: isolation });
  run.warnings.push(...merge.warnings);
  if (merge.applied.length) run.warnings.push(`Merged isolated writer patches: ${merge.applied.join(", ")}.`);
  for (const conflict of merge.conflicts) {
    const step = run.steps.find((item) => item.agent === conflict.agent);
    if (step) {
      step.status = "failed";
      step.error = `Worktree merge conflict: ${conflict.reason}`;
      step.endedAt = new Date().toISOString();
    }
    run.warnings.push(`Worktree merge conflict for ${conflict.agent}: ${conflict.reason}`);
  }
  if (merge.conflicts.length > 0 && context.agents.has("conflict-resolver")) {
    for (const conflict of merge.conflicts) {
      const resolverStep: RunStepState = {
        id: `conflict:${conflict.stepId ?? conflict.agent}`,
        agent: "conflict-resolver",
        task: buildConflictResolverTask(conflict),
        status: "pending",
      };
      run.steps.push(resolverStep);
      run.warnings.push(`Starting conflict-resolver for ${conflict.agent}.`);
      await runSdkStep(resolverStep, context, extensionContext, run, { cwd: context.cwd });
      if (resolverStep.status === "complete") {
        run.warnings.push(`Conflict-resolver completed for ${conflict.agent}; original isolated patch was not auto-applied after conflict.`);
      }
    }
  }
  persistRun(run);
  context.onUpdate?.(run);
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
    if (context.signal?.aborted) {
      markRunAborted(run, context, "pi-chalin run stopped by user.");
      break;
    }
    const stageSteps = run.steps.filter((step) => step.id.startsWith(`${stage.id}:`));
    await runSdkStage(run, stage, stageSteps, context, extensionContext, previous);
    for (const step of stageSteps) maybeAppendImplementationReviewRepair(run, step);
    previous = aggregateStageHandoff(stageSteps);
    if (shouldStopAfterDagStage(stageSteps, context.agents)) break;
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

function maybeAppendImplementationReviewRepair(run: RunState, step: RunStepState): boolean {
  if (step.agent !== "reviewer" || !isUsableStepHandoff(step)) return false;
  const stepIndex = run.steps.indexOf(step);
  if (stepIndex < 0 || hasLaterImplementationRepair(run, stepIndex)) return false;
  const workerIndex = findLastIndex(run.steps, (candidate, index) => index < stepIndex && candidate.agent === "worker" && isUsableStepHandoff(candidate));
  if (workerIndex < 0) return false;
  const reviewerGap = reviewerHandoffNeedsRepair(step);
  const permanentTestGap = !reviewerGap && implementationPassNeedsPermanentTestRepair(run, workerIndex, stepIndex);
  if (!reviewerGap && !permanentTestGap) return false;
  const existingRepairCycles = implementationReviewRepairCycleCount(run);
  const maxRepairCycles = maxImplementationReviewRepairCycles();
  if (existingRepairCycles >= maxRepairCycles) {
    const gap = reviewerGap ? "a blocking FAIL/GAP" : "missing permanent test coverage";
    step.status = "failed";
    step.error = `Implementation reviewer still reports ${gap} after ${existingRepairCycles} repair cycle(s).`;
    run.warnings.push(`${step.error} Stopping instead of finalizing incomplete routed implementation.`);
    persistRun(run);
    return false;
  }

  const cycle = existingRepairCycles + 1;
  const reviewText = truncateText(step.output?.handoff ?? step.output?.text ?? "", 1200);
  const originalTask = run.rootTask ?? run.route.reason;
  const repairIntro = reviewerGap
    ? "Repair the blocking implementation-review findings from the Previous Handoff."
    : "Repair the runtime coverage guard: product code changed while available permanent tests were not updated.";
  const repairScope = reviewerGap
    ? "Use the previous reviewer handoff as the gap list; do not repeat broad discovery unless a named file is missing."
    : "Add/update permanent runner-discoverable tests for the changed behavior. Preserve the implementation unless the new tests reveal a bug. Ignore narrower step wording that prohibited tests unless the Original User Goal explicitly prohibited test edits.";
  const repairWorker: RunStepState = {
    id: `review-repair-${cycle}-worker`,
    agent: "worker",
    task: [
      repairIntro,
      "Read only the changed implementation/test files needed for the repair, apply the smallest corrective edit, add or update focused regression tests for the missed criteria, then run the requested or nearest verification command.",
      "Handoff exact changed paths, tests added/updated, verification command, and any remaining risk.",
      `Original task: ${originalTask}`,
      repairScope,
    ].join(" "),
    budget: "tight",
    status: "pending",
  };
  const repairReviewer: RunStepState = {
    id: `review-repair-${cycle}-reviewer`,
    agent: "reviewer",
    task: [
      "Re-review the repaired implementation against the original task and the previous reviewer findings.",
      "Check actual changed files, test coverage for each missed criterion, and verification output.",
      "Return PASS only if the blocking gaps are fixed; otherwise return FAIL/GAP with exact evidence.",
      `Original task: ${originalTask}`,
      `Previous reviewer findings: ${truncateText(reviewText, 700)}`,
    ].join(" "),
    budget: "tight",
    status: "pending",
  };

  appendImplementationReviewRepair(
    run,
    cycle,
    repairWorker,
    repairReviewer,
    reviewerGap
      ? "because the reviewer reported a blocking FAIL/GAP"
      : "because changed product code had no permanent test update despite an available test surface",
  );
  run.warnings.push(`${reviewerGap ? "Implementation reviewer reported a blocking gap" : "Implementation changed product code without permanent test coverage"}; queued repair cycle ${cycle}/${maxRepairCycles} with worker repair and reviewer re-check.`);
  persistRun(run);
  return true;
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

export function reviewerHandoffNeedsRepair(step: Pick<RunStepState, "agent" | "status" | "output">): boolean {
  if (step.agent !== "reviewer" || !isUsableStepHandoff(step)) return false;
  const text = (step.output?.handoff?.trim() ? step.output.handoff : step.output?.text ?? "").trim();
  if (!text) return false;
  const explicitVerdict = /\bverdict\s*:\s*(PASS|FAIL|GAP|BLOCKER|BLOCKING)\b/i.exec(text)?.[1]?.toUpperCase();
  const signalText = stripNonBlockingReviewerPhrases(text);
  const blockingSignal = /\b(?:blocking\s+gap|bugs?\s+found|coverage\s+is\s+insufficient|tests?\s+miss|does\s+not\s+exercise|verification\s+blind\s+spot|bug remains|does not meet|missing acceptance|missing\s+tests?\s+for|insufficient tests|skipped scope|test\s+coverage\s+gap|permanent\s+test\s+suite\s+could\s+be\s+expanded|untested\s+in\s+the\s+permanent\s+suite|permanent\s+coverage\s+missing|ad[- ]hoc\s+(?:tests?|checks?|verification)[^.\n]{0,80}(?:not\s+a\s+substitute|only|instead|replace)|must fix|required[^.\n]{0,80}missing|no cumple|falta(?:n)?[^.\n]{0,80}(?:criteri|test|cobertura|validaci[oó]n|implementaci[oó]n|alcance|aceptaci[oó]n|required|coverage|verification|scope))\b/i.test(signalText);
  if (explicitVerdict === "PASS" && !blockingSignal) return false;
  if (explicitVerdict && explicitVerdict !== "PASS") return true;
  return blockingSignal || /\b(?:FAIL|BLOCKER|BLOCKING)\b/i.test(signalText) || /^\s*[-*]?\s*GAP\b/im.test(signalText);
}

function appendImplementationReviewRepair(run: RunState, cycle: number, repairWorker: RunStepState, repairReviewer: RunStepState, reason: string): void {
  const routeReason = run.route.reason.includes("Implementation review repair queued by pi-chalin")
    ? run.route.reason
    : `${run.route.reason} Implementation review repair queued by pi-chalin ${reason}.`;
  const workerPlanStep = { agent: repairWorker.agent, task: repairWorker.task, budget: repairWorker.budget };
  const reviewerPlanStep = { agent: repairReviewer.agent, task: repairReviewer.task, budget: repairReviewer.budget };

  if (run.route.plan?.kind === "dag") {
    const workerStageId = `review-repair-${cycle}-worker`;
    const reviewerStageId = `review-repair-${cycle}-reviewer`;
    run.steps.push(
      { ...repairWorker, id: `${workerStageId}:step-1` },
      { ...repairReviewer, id: `${reviewerStageId}:step-1` },
    );
    run.route.plan.stages.push(
      { id: workerStageId, tasks: [workerPlanStep] },
      { id: reviewerStageId, tasks: [reviewerPlanStep] },
    );
    run.route.agents = [...run.route.agents, "worker", "reviewer"];
    run.route.needsArtifacts = true;
    run.route.reason = routeReason;
    return;
  }

  const existingPlanSteps: AgentStep[] = run.route.plan?.kind === "single"
    ? [{ agent: run.route.plan.agent, task: run.route.plan.task, budget: run.route.plan.budget }]
    : run.route.plan?.kind === "chain"
      ? run.route.plan.steps
      : run.route.plan?.kind === "parallel"
        ? run.route.plan.tasks
        : run.steps.map((candidate) => ({ agent: candidate.agent, task: candidate.task, budget: candidate.budget }));
  run.steps.push(repairWorker, repairReviewer);
  run.route = {
    ...run.route,
    kind: "multi-agent-chain",
    agents: [...run.route.agents, "worker", "reviewer"],
    needsArtifacts: true,
    reason: routeReason,
    plan: {
      kind: "chain",
      steps: [...existingPlanSteps, workerPlanStep, reviewerPlanStep],
    },
  };
}

function implementationReviewRepairCycleCount(run: RunState): number {
  const cycles = new Set<string>();
  for (const step of run.steps) {
    const numbered = /^review-repair-(\d+)-(?:worker|reviewer)$/.exec(step.id);
    if (numbered?.[1]) {
      cycles.add(numbered[1]);
      continue;
    }
    if (/^review-repair-(?:worker|reviewer)$/.test(step.id)) cycles.add("legacy");
    const dagNumbered = /^review-repair-(\d+)-(?:worker|reviewer):/.exec(step.id);
    if (dagNumbered?.[1]) cycles.add(dagNumbered[1]);
  }
  return cycles.size;
}

function hasLaterImplementationRepair(run: RunState, stepIndex: number): boolean {
  return run.steps.some((candidate, index) => index > stepIndex && candidate.id.startsWith("review-repair-"));
}

function maxImplementationReviewRepairCycles(): number {
  const parsed = Number(process.env.PI_CHALIN_IMPLEMENTATION_REVIEW_REPAIR_CYCLES);
  if (!Number.isFinite(parsed)) return 2;
  return Math.max(0, Math.min(4, Math.floor(parsed)));
}

function stripNonBlockingReviewerPhrases(text: string): string {
  return text
    .replace(/\bno\s+bugs?\s+found\b/gi, "")
    .replace(/\bno\s+(?:blocking\s+)?gaps?\s+(?:remain|remaining|found)?\b/gi, "")
    .replace(/\bno\s+remaining\s+(?:gaps?|blockers?|issues?)\b/gi, "")
    .replace(/\bno\s+missing\s+(?:acceptance|criteria|coverage|tests?|verification|scope)[^.\n]*/gi, "")
    .replace(/[^.\n]*(?:not required by (?:the )?(?:user )?goal|not required by (?:the )?(?:original )?request)[^.\n]*/gi, "")
    .replace(/\bno\s+falta(?:n)?[^.\n]*/gi, "");
}

export function shouldStopAfterDagStage(stageSteps: Pick<RunStepState, "status" | "agent" | "output" | "error">[], agents: Map<string, AgentDefinition>): boolean {
  if (stageSteps.some((step) => step.status === "paused")) return true;
  const failedSteps = stageSteps.filter((step) => step.status === "failed");
  if (failedSteps.length === 0) return false;
  const usableSteps = stageSteps.filter((step) => step.status === "complete" || step.status === "budget-capped");
  if (usableSteps.length === 0) return true;
  return failedSteps.some((step) => isWriterAgent(agents.get(step.agent)));
}

function isWriterAgent(agent?: AgentDefinition): boolean {
  if (!agent) return false;
  return agent.concern === "implementation"
    || agent.concern === "conflict-resolution"
    || agent.capabilities.includes("edit-files")
    || agent.capabilities.includes("write-new-files");
}

async function runSdkStage(
  run: RunState,
  stage: Extract<RoutePlan, { kind: "dag" }>["stages"][number],
  stageSteps: RunStepState[],
  context: WorkerRunnerContext,
  extensionContext: ExtensionContext,
  previous: string,
): Promise<void> {
  let isolation: WorktreeIsolationPlan | undefined;
  const runnableSteps = stageSteps.filter((step) => !isUsableStepHandoff(step));
  if (runnableSteps.length === 0) return;
  if (needsWorktreeIsolation(stage.tasks, context.agents)) {
    isolation = prepareWorktreeIsolation({ cwd: context.cwd, runId: `${run.id}-${stage.id}`, steps: stage.tasks, agents: context.agents });
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
      return;
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
      run.warnings.push(isolation?.enabled
        ? `DAG stage ${stage.id} paused after a child idle stall; isolated writer changes were not merged.`
        : `DAG stage ${stage.id} paused after a child idle stall.`);
      persistRun(run);
      context.onUpdate?.(run);
      return;
    }

    if (isolation?.enabled) await mergeIsolatedStage(run, context, extensionContext, isolation);
  } finally {
    if (isolation?.enabled) run.warnings.push(...cleanupWorktrees({ cwd: context.cwd, plan: isolation }));
  }
}

async function runSdkStep(
  step: RunStepState,
  context: WorkerRunnerContext,
  extensionContext: ExtensionContext,
  run: RunState,
  options: { cwd: string; previous?: string },
): Promise<{ aborted: boolean; paused?: boolean; handoff?: string }> {
  if (context.signal?.aborted) {
    markRunAborted(run, context, "pi-chalin run stopped by user.");
    return { aborted: true };
  }
  step.status = "running";
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
    const promptOptions = buildPromptOptionsForStep(run, step, agent, budgetPolicy, options.previous);
    promptOptions.memoryContext = run.route.needsMemory ? await compactMemoryContextForStep(options.cwd, step, agent, options.previous) : undefined;
    const maxToolCalls = budgetPolicy.caps.maxToolCalls;
    step.budget = budgetPolicy.profile;
    step.maxToolCalls = maxToolCalls;
    const allowedTools = childToolNames(agent, step.task, run.route.needsArtifacts, Boolean(options.previous), {
      budgetProfile: budgetPolicy.profile,
      routeKind: run.route.kind,
      memoryEnabled: run.route.needsMemory,
      delegationDepth: currentSubagentDepth(run),
      maxDelegationDepth: maxSubagentDepth(),
    });
    const prompt = buildSdkPrompt(agent, step.task, options.cwd, options.previous, budgetPolicy, "normal", promptOptions);
    let fallbackAttempted = false;
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
      const attempt = await runSdkSessionAttempt({
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
      });
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
    if (step.status === "budget-capped") {
      run.warnings.push(`${step.agent} reached budget cap; checkpointed partial handoff for continuation.`);
      await recordBudgetCheckpoint(new ArtifactStore({ cwd: context.cwd }), run.id, step, "Budget cap reached during SDK child execution.");
    }
    persistRun(run);
    context.onUpdate?.(run);
    return { aborted: false, handoff: step.output?.handoff ?? step.output?.text };
  } catch (error) {
    if (isAbortError(error)) {
      step.status = "paused";
      step.error = errorMessage(error);
      markRunAborted(run, context, step.error);
      return { aborted: true };
    }
    if (isIdleStallError(error)) {
      step.status = "paused";
      step.error = error.message;
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
}): Promise<{ text: string; metrics: RunStepMetrics; runtimeError?: string }> {
  const stepStartedAtMs = Date.now();
  const activity = createStepActivityMonitor(input.step, input.run, input.context);
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
    onActivity: activity.onToolActivity,
  });
  const attemptMetrics = (messages: unknown[] = []) => mergePolicyMetrics(extractSessionMetrics(messages, stepStartedAtMs), childPolicy);
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
            idleStallMs: sdkStepIdleStallMs(),
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
  const route = routeFromNestedDelegationPlan(params);
  if (!route.plan) {
    return { text: `Nested delegation rejected: ${route.reason}` };
  }
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
  if (input.topology === "dag") {
    const stages = sanitizeNestedStages(input.stages ?? []);
    if (stages.length === 0) {
      return { kind: "ask-user", agents: [], risk: "low", ambiguity: "high", needsMemory: false, needsArtifacts: false, reason: "Nested dag requires at least one stage with tasks." };
    }
    const agents = stages.flatMap((stage) => stage.tasks.map((step) => step.agent));
    return {
      kind: "multi-agent-dag",
      agents,
      risk: input.requiresWorkspaceMutation ? "medium" : "low",
      ambiguity: "low",
      needsMemory: false,
      needsArtifacts: true,
      reason: input.reason.trim() || "Subagent selected a rare nested DAG because the current task was no longer bounded.",
      plan: { kind: "dag", stages },
    };
  }
  if (steps.length === 0) {
    return { kind: "ask-user", agents: [], risk: "low", ambiguity: "high", needsMemory: false, needsArtifacts: false, reason: "Nested single/chain/parallel delegation requires steps." };
  }
  const agents = steps.map((step) => step.agent);
  const plan: RoutePlan = input.topology === "parallel"
    ? { kind: "parallel", tasks: steps }
    : input.topology === "chain" || steps.length > 1
    ? { kind: "chain", steps }
    : { kind: "single", agent: steps[0]!.agent, task: steps[0]!.task, budget: steps[0]!.budget };
  return {
    kind: input.topology === "parallel" ? "multi-agent-parallel" : input.topology === "chain" || steps.length > 1 ? "multi-agent-chain" : "single-agent",
    agents,
    risk: input.requiresWorkspaceMutation ? "medium" : "low",
    ambiguity: "low",
    needsMemory: false,
    needsArtifacts: true,
    reason: input.reason.trim() || "Subagent selected rare nested delegation because the current task was no longer bounded.",
    plan,
  };
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

function sanitizeNestedBudget(value: AgentStep["budget"]): AgentStep["budget"] | undefined {
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

function buildPromptOptionsForStep(run: RunState, step: RunStepState, agent: AgentDefinition | undefined, policy: ReturnType<typeof policyForStep>, previous?: string): SdkPromptOptions {
  const priorFilesRead = priorFilesReadBeforeStep(run, step);
  return {
    rootTask: run.rootTask,
    priorFilesRead,
    ...(isHandoffGapReadMode(agent, previous, policy.profile === "deep") ? { synthesisGapReadLimit: synthesisGapReadLimit() } : {}),
  };
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

function priorFilesReadBeforeStep(run: RunState, currentStep: RunStepState): string[] {
  const index = run.steps.indexOf(currentStep);
  const previousSteps = index >= 0 ? run.steps.slice(0, index) : run.steps.filter((step) => step !== currentStep);
  return [...new Set(previousSteps.flatMap((step) => step.metrics?.filesRead ?? []))].slice(0, 80);
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

export function parseAgentOutput(agent: string, raw: string): AgentOutput {
  const warnings: string[] = [];
  let handoff: string | undefined;
  const handoffMatch = raw.match(/##\s*Handoff\s*\n([\s\S]*?)(?:\n##\s|$)/i);
  if (handoffMatch?.[1]) handoff = truncateText(handoffMatch[1].trim(), handoffBudgetChars(agent));

  const candidates: MemoryCandidate[] = [];
  const memoryBlock = raw.match(/##\s*Memory Candidates?\s*\n([\s\S]*?)(?:\n##\s|$)/i)?.[1];
  if (memoryBlock) {
    for (const line of memoryBlock.split("\n")) {
      const parsed = parseMemoryCandidateLine(line);
      if (!parsed) continue;
      candidates.push(createMemoryCandidate({ category: parsed.category, content: parsed.content, sourceAgent: agent, confidence: parsed.confidence, scope: "project" }));
    }
  }

  if (raw.includes("## Memory Candidate") && candidates.length === 0) warnings.push("Memory candidate block was present but no valid bullet candidates were parsed.");
  const compactRaw = truncateText(raw.trim(), rawOutputBudgetChars());
  return { agent, text: compactRaw, handoff, memoryCandidates: candidates.slice(0, memoryCandidateBudget()), raw: compactRaw, warnings };
}


function parseMemoryCandidateLine(line: string): { category: string; content: string; confidence: number } | undefined {
  const bullet = line.match(/^\s*[-*]\s+(.+?)\s*$/)?.[1]?.trim();
  if (!bullet || /^none\.?$/i.test(bullet)) return undefined;
  const normalized = bullet
    .replace(/^`+|`+$/g, "")
    .replace(/^["“”']+|["“”']+$/g, "")
    .trim();
  if (!normalized || /^none\.?$/i.test(normalized)) return undefined;
  const tagged = normalized.match(/^(project-fact|pattern|tooling|testing|workflow|bugfix|validation|artifact|decision|preference|architecture|safety|security|failure|agent-note)\s*:\s*(.+)$/i);
  if (tagged?.[1] && tagged[2]) {
    const category = tagged[1].toLowerCase();
    return { category, content: tagged[2].trim(), confidence: category === "agent-note" ? 0.7 : 0.9 };
  }
  return { category: "agent-note", content: normalized, confidence: 0.7 };
}

function aggregateHandoff(items: Array<{ agent: string; text: string }>): string {
  return items
    .filter((item) => item.text.trim().length > 0)
    .map((item) => `- ${item.agent}: ${truncateText(item.text.trim(), 450)}`)
    .join("\n");
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
      if (options.resume && isUsableStepHandoff(step)) {
        previous = aggregateHandoff([{ agent: step.agent, text: step.output?.handoff ?? step.output?.text ?? previous }]);
        maybeAppendImplementationReviewRepair(run, step);
        continue;
      }
      yield* checkAbortEffect(context.signal);
      const output = yield* runStepEffect(step, context, previous, run);
      previous = output.handoff ?? output.text;
      maybeAppendImplementationReviewRepair(run, step);
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
    steps,
    (step) => runStepEffect(step, context, previous, run),
    { concurrency: "unbounded" },
  ).pipe(Effect.withSpan(span));
}

async function runStep(step: RunStepState, context: WorkerRunnerContext, previous: string | undefined, run?: RunState): Promise<AgentOutput> {
  return Effect.runPromise(runStepEffect(step, context, previous, run));
}

function runStepEffect(step: RunStepState, context: WorkerRunnerContext, previous: string | undefined, run?: RunState): Effect.Effect<AgentOutput, RunnerError> {
  return Effect.gen(function* () {
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
    step.endedAt = new Date().toISOString();
    if (run) persistRun(run);
    context.onUpdate?.(run ?? { ...createRunState({ kind: "bypass", agents: [], risk: "low", ambiguity: "low", needsMemory: false, needsArtifacts: false, reason: "update" }, context.cwd), steps: [step] });
    return output;
  }).pipe(Effect.withSpan(`runner.mock.step.${step.agent}`));
}

function buildMockOutput(step: RunStepState, context: WorkerRunnerContext, previous: string | undefined, agent: AgentDefinition | undefined): string {
  const snapshot = buildProjectSnapshot({ cwd: context.cwd });
  const summary = formatProjectSnapshot(snapshot);
  const gitSummary = snapshot.git ? `Git context: branch=${snapshot.git.branch ?? "unknown"}; recent changed files=${snapshot.git.changedFiles.slice(0, 8).join(", ") || "none"}.` : "";
  const projectFiles = snapshot.entries.filter((entry) => entry.type === "file").map((entry) => entry.path).slice(0, 8);
  const findings = mockFindings(step, summary, gitSummary, projectFiles, previous);
  const handoff = mockHandoff(step, summary, gitSummary, projectFiles, previous);
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
    "## Memory Candidates",
    ...(memories.length ? memories.map((memory) => `- ${memory}`) : ["- None."]),
  ].filter((line): line is string => line !== undefined).join("\n");
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
  run.status = hasUnrecoverableFailedSteps(run, context.agents)
    ? "failed"
    : run.steps.some((step) => step.status === "paused")
      ? "paused"
      : run.steps.some((step) => step.status === "budget-capped")
        ? "budget-capped"
      : "complete";
  run.endedAt = new Date().toISOString();
  run.metrics = summarizeRunMetrics(run);
  persistRun(run);
  context.onUpdate?.(run);
  return run;
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
  const cap = thinkingCapForBudget(profile, options);
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

export const DEFAULT_SDK_STEP_IDLE_STALL_MS = 90_000;

export function sdkStepIdleStallMs(): number {
  const parsed = Number(process.env.PI_CHALIN_SDK_STEP_IDLE_STALL_MS);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_SDK_STEP_IDLE_STALL_MS;
}

export class IdleStallError extends Error {
  readonly idleStallMs: number;

  constructor(message: string, idleStallMs: number) {
    super(`${message} after ${idleStallMs}ms without activity`);
    this.name = "IdleStallError";
    this.idleStallMs = idleStallMs;
  }
}

function isIdleStallError(error: unknown): error is IdleStallError {
  return error instanceof IdleStallError;
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
  return step?.status === "budget-capped" || message.includes("budget cap") || message.includes("budget exceeded");
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

function extractLastAssistantText(messages: unknown[]): string {
  for (const message of [...messages].reverse()) {
    if (!message || typeof message !== "object") continue;
    const maybe = message as { role?: unknown; content?: unknown };
    if (maybe.role !== "assistant") continue;
    if (typeof maybe.content === "string") return maybe.content;
    if (Array.isArray(maybe.content)) {
      return maybe.content.map((part) => typeof part?.text === "string" ? part.text : "").join("\n").trim();
    }
  }
  return "";
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
    outputTruncatedCount: (previous.outputTruncatedCount ?? 0) + (next.outputTruncatedCount ?? 0),
    filesTouched: [...new Set([...(previous.filesTouched ?? []), ...(next.filesTouched ?? [])])].slice(0, 50),
    shellCommands: [...(previous.shellCommands ?? []), ...(next.shellCommands ?? [])].slice(0, 50),
    postMutationShellCommands: (previous.postMutationShellCommands ?? 0) + (next.postMutationShellCommands ?? 0) || undefined,
    successfulPostMutationShellCommands: (previous.successfulPostMutationShellCommands ?? 0) + (next.successfulPostMutationShellCommands ?? 0) || undefined,
    retriesByTool: { ...(previous.retriesByTool ?? {}), ...(next.retriesByTool ?? {}) },
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
  const budgetStopCount = Math.max(metrics.budgetStopCount ?? 0, policyMetrics.budgetStopCount, countHardBudgetHits(budgetCapHits));
  const shellCommands = [...(metrics.shellCommands ?? []), ...policyMetrics.shellCommands].slice(0, 50);
  const postMutationShellCommands = Math.max(metrics.postMutationShellCommands ?? 0, policyMetrics.postMutationShellCommands);
  const successfulPostMutationShellCommands = Math.max(metrics.successfulPostMutationShellCommands ?? 0, policyMetrics.successfulPostMutationShellCommands);
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
    outputTruncatedCount: Math.max(metrics.outputTruncatedCount ?? 0, policyMetrics.outputTruncatedCount),
    filesTouched: [...new Set([...(metrics.filesTouched ?? []), ...policyMetrics.filesTouched])].slice(0, 50),
    ...(shellCommands.length ? { shellCommands } : {}),
    ...(postMutationShellCommands > 0 ? { postMutationShellCommands } : {}),
    ...(successfulPostMutationShellCommands > 0 ? { successfulPostMutationShellCommands } : {}),
    retriesByTool: { ...(metrics.retriesByTool ?? {}), ...policyMetrics.retriesByTool },
  };
}

function finalizeStepMetrics(metrics: RunStepMetrics, step: RunStepState, budgetPolicy: ReturnType<typeof policyForStep>, priorFilesRead: string[] = []): RunStepMetrics {
  const mutated = (metrics.toolCallsByName.edit ?? 0) > 0 || (metrics.toolCallsByName.write ?? 0) > 0;
  const verificationDone = mutated ? (metrics.successfulPostMutationShellCommands ?? metrics.postMutationShellCommands ?? 0) > 0 : false;
  const utility = summarizeToolUtility({
    findings: extractFindingLines(step.output?.text ?? ""),
    toolCalls: metrics.toolCalls,
    filesRead: metrics.filesRead ?? [],
    firstSignalToolCall: firstSignalToolCall(metrics),
    verificationDone,
    memoryCandidates: (step.output?.memoryCandidates ?? []).map((candidate) => ({ content: candidate.content, category: candidate.category, confidence: candidate.confidence })),
  });
  const health = evaluateBudgetUsage(budgetPolicy, {
    elapsedMs: metrics.durationMs,
    toolCalls: metrics.toolCalls,
    totalCostUsd: metrics.usage.cost.total,
    turns: Math.max(1, Math.ceil(metrics.usage.output / 4000)),
    outputChars: metrics.outputChars ?? step.output?.text.length ?? 0,
    readBytes: metrics.readBytes ?? 0,
    filesTouched: metrics.filesTouched?.length ?? 0,
    retriesByTool: metrics.retriesByTool ?? {},
  });
  const prior = new Set(priorFilesRead);
  const crossStepDuplicateReads = [...new Set((metrics.filesRead ?? []).filter((file) => prior.has(file)))];
  const budgetCapHits = mergeBudgetCapHits(metrics.budgetCapHits, health.caps);
  const budgetStopCount = Math.max(metrics.budgetStopCount ?? 0, countHardBudgetHits(budgetCapHits));
  return {
    ...metrics,
    utility,
    ...(budgetCapHits.length ? { budgetCapHits } : {}),
    ...(crossStepDuplicateReads.length ? {
      crossStepDuplicateReadCount: crossStepDuplicateReads.length,
      crossStepDuplicateReads: crossStepDuplicateReads.slice(0, 30),
    } : {}),
    ...(budgetStopCount > 0 ? { budgetStopCount } : {}),
  };
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
  const snapshotCalls = metrics.toolCallsByName.chalin_project_snapshot ?? 0;
  if ((metrics.filesRead?.length ?? 0) > 0 || snapshotCalls > 0) return Math.max(1, Math.min(metrics.toolCalls, snapshotCalls || readCalls || 1));
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

function countHardBudgetHits(hits: BudgetCapHit[] | undefined): number {
  return (hits ?? []).filter((hit) => hit.severity === "hard").length;
}

function summarizeRunMetrics(run: RunState): RunState["metrics"] {
  const usage = emptyUsage();
  const toolCallsByName: Record<string, number> = {};
  const policyViolations: string[] = [];
  const budgetCapHits: BudgetCapHit[] = [];
  const filesRead: string[] = [];
  const crossStepDuplicateReads: string[] = [];
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function numberValue(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function durationMs(startedAt: string, endedAt?: string): number {
  const end = endedAt ? Date.parse(endedAt) : Date.now();
  const start = Date.parse(startedAt);
  return Number.isFinite(end) && Number.isFinite(start) ? Math.max(0, end - start) : 0;
}

function truncateText(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

function findLastIndex<T>(items: T[], predicate: (item: T, index: number) => boolean): number {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    if (predicate(items[index]!, index)) return index;
  }
  return -1;
}

function handoffBudgetChars(agent?: string): number {
  const parsed = Number(process.env.PI_CHALIN_HANDOFF_BUDGET_CHARS);
  if (Number.isFinite(parsed) && parsed > 200) return parsed;
  return agent === "scout" || agent === "context-builder" ? 2200 : 1200;
}

function rawOutputBudgetChars(): number {
  const parsed = Number(process.env.PI_CHALIN_RAW_OUTPUT_BUDGET_CHARS);
  return Number.isFinite(parsed) && parsed > 500 ? parsed : 6000;
}

function memoryCandidateBudget(): number {
  const parsed = Number(process.env.PI_CHALIN_MEMORY_CANDIDATE_BUDGET);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 3;
}
