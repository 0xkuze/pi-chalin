import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AgentCapability, AgentDefinition, AgentThinkingLevel, ModelResolutionAttempt, ModelResolutionLog, RouteKind, ToolBudgetProfile } from "./schemas.ts";
import { evaluateBudgetUsage, estimateBudgetPreflight, policyForStep, recordBudgetCheckpoint, summarizeToolUtility } from "./budget.ts";
import { resolveMeshPaths, type MeshPathsOptions } from "./paths.ts";
import { createMemoryCandidate } from "./memory.ts";
import type { AgentOutput, AgentStep, MemoryCandidate, RouteDecision, RoutePlan, RunState, RunStepMetrics, RunStepState, TokenUsageSummary } from "./schemas.ts";
import { createChildToolPolicy, createChildTools, type ChildToolActivity, type ChildToolPolicy } from "./child-tools.ts";
import { buildProjectSnapshot, formatProjectSnapshot } from "./snapshot.ts";
import { ArtifactStore } from "./artifacts.ts";
import { buildProjectDiscoveryIndex, formatProjectDiscoveryIndex } from "./discovery.ts";
import { cleanupWorktrees, mergeWorktreeChanges, needsWorktreeIsolation, prepareWorktreeIsolation, type WorktreeIsolationPlan } from "./worktrees.ts";

interface SdkPromptOptions {
  priorFilesRead?: string[];
  synthesisGapReadLimit?: number;
}

export interface WorkerRunnerContext extends MeshPathsOptions {
  agents: Map<string, AgentDefinition>;
  modelOverrides?: Record<string, string>;
  thinkingOverrides?: Record<string, AgentThinkingLevel>;
  extensionContext?: ExtensionContext;
  signal?: AbortSignal;
  onUpdate?: (run: RunState) => void;
}

export interface WorkerRunner {
  run(route: RouteDecision, context: WorkerRunnerContext): Promise<RunState>;
  resume?(run: RunState, context: WorkerRunnerContext): Promise<RunState>;
}

export class MockWorkerRunner implements WorkerRunner {
  async run(route: RouteDecision, context: WorkerRunnerContext): Promise<RunState> {
    const run = createRunState(route, context.cwd);
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

    try {
      throwIfAborted(context.signal);
      if (plan.kind === "single") {
        await runStep(run.steps[0]!, context, undefined, run);
      } else if (plan.kind === "chain") {
        let previous = "";
        for (const step of run.steps) {
          throwIfAborted(context.signal);
          const output = await runStep(step, context, previous, run);
          previous = output.handoff ?? output.text;
        }
      } else if (plan.kind === "parallel") {
        await Promise.all(run.steps.map((step) => runStep(step, context, undefined, run)));
      } else {
        await runMockDag(run, plan.stages, context);
      }
    } catch (error) {
      if (!isAbortError(error)) throw error;
      markRunAborted(run, context, errorMessage(error));
    }

    return completeRun(run, context);
  }

  async resume(run: RunState, context: WorkerRunnerContext): Promise<RunState> {
    prepareRunForResume(run);
    context.onUpdate?.(run);
    const plan = run.route.plan;
    if (!plan) return completeRun(run, context);
    try {
      throwIfAborted(context.signal);
      if (plan.kind === "single" || plan.kind === "chain") {
        let previous = aggregateCompletedHandoffBefore(run.steps, run.steps.length);
        for (const step of run.steps) {
          if (isUsableStepHandoff(step)) {
            previous = aggregateHandoff([{ agent: step.agent, text: step.output?.handoff ?? step.output?.text ?? previous }]);
            continue;
          }
          throwIfAborted(context.signal);
          const output = await runStep(step, context, previous, run);
          previous = output.handoff ?? output.text;
        }
      } else if (plan.kind === "parallel") {
        await Promise.all(run.steps.filter((step) => !isUsableStepHandoff(step)).map((step) => runStep(step, context, undefined, run)));
      } else {
        await resumeMockDag(run, plan.stages, context);
      }
    } catch (error) {
      if (!isAbortError(error)) throw error;
      markRunAborted(run, context, errorMessage(error));
    }
    return completeRun(run, context);
  }
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

    const run = createRunState(route, context.cwd);
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
      for (const step of run.steps) {
        const result = await runSdkStep(step, context, extensionContext, run, { previous, cwd: context.cwd });
        if (result.aborted) break;
        previous = result.handoff ?? previous;
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
      for (const step of run.steps) {
        if (isUsableStepHandoff(step)) {
          previous = step.output?.handoff ?? step.output?.text ?? previous;
          continue;
        }
        const result = await runSdkStep(step, context, extensionContext, run, { previous, cwd: context.cwd });
        if (result.aborted) break;
        previous = result.handoff ?? previous;
      }
    }

    return completeRun(run, context);
  }
}

async function runMockDag(run: RunState, stages: Extract<RoutePlan, { kind: "dag" }>["stages"], context: WorkerRunnerContext): Promise<void> {
  let previous = "";
  for (const stage of stages) {
    throwIfAborted(context.signal);
    const stageSteps = run.steps.filter((step) => step.id.startsWith(`${stage.id}:`));
    const outputs = await Promise.all(stageSteps.map((step) => runStep(step, context, previous, run)));
    previous = aggregateHandoff(outputs.map((output) => ({ agent: output.agent, text: output.handoff ?? output.text })));
  }
}

async function resumeMockDag(run: RunState, stages: Extract<RoutePlan, { kind: "dag" }>["stages"], context: WorkerRunnerContext): Promise<void> {
  let previous = "";
  for (const stage of stages) {
    throwIfAborted(context.signal);
    const stageSteps = run.steps.filter((step) => step.id.startsWith(`${stage.id}:`));
    if (stageSteps.every((step) => isUsableStepHandoff(step))) {
      previous = aggregateStageHandoff(stageSteps);
      continue;
    }
    const outputs = await Promise.all(stageSteps
      .filter((step) => !isUsableStepHandoff(step))
      .map((step) => runStep(step, context, previous, run)));
    const completedOutputs = stageSteps
      .filter((step) => isUsableStepHandoff(step))
      .map((step) => ({ agent: step.agent, text: step.output?.handoff ?? step.output?.text ?? "" }));
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
    await Promise.all(run.steps.map((step) => {
      const worktree = isolation?.worktrees.find((item) => item.stepId === step.id);
      return runSdkStep(step, context, extensionContext, run, { cwd: worktree?.path ?? context.cwd });
    }));

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
    "Use read/grep/find/ls/edit; do not rewrite whole existing files and do not modify files through bash.",
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
  for (const stage of stages) {
    if (context.signal?.aborted) {
      markRunAborted(run, context, "pi-chalin run stopped by user.");
      break;
    }
    const stageSteps = run.steps.filter((step) => step.id.startsWith(`${stage.id}:`));
    await runSdkStage(run, stage, stageSteps, context, extensionContext, previous);
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

function isUsableStepHandoff(step: RunStepState): boolean {
  return step.status === "complete" || step.status === "budget-capped";
}

function aggregateStageHandoff(stageSteps: RunStepState[]): string {
  return aggregateHandoff(stageSteps.map((step) => {
    if (isUsableStepHandoff(step)) return { agent: step.agent, text: step.output?.handoff ?? step.output?.text ?? "" };
    if (step.status === "failed") return { agent: step.agent, text: `FAILED: ${step.error ?? "unknown error"}. Treat this as a known coverage gap and make it explicit in downstream synthesis.` };
    return { agent: step.agent, text: "" };
  }));
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
    await Promise.all(runnableSteps.map((step) => {
      const localStepId = step.id.split(":").at(-1) ?? step.id;
      const worktree = isolation?.worktrees.find((item) => item.stepId === localStepId);
      return runSdkStep(step, context, extensionContext, run, { cwd: worktree?.path ?? context.cwd, previous });
    }));
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
): Promise<{ aborted: boolean; handoff?: string }> {
  if (context.signal?.aborted) {
    markRunAborted(run, context, "pi-chalin run stopped by user.");
    return { aborted: true };
  }
  step.status = "running";
  step.startedAt = new Date().toISOString();
  persistRun(run);
  context.onUpdate?.(run);
  try {
    const stepStartedAtMs = Date.now();
    const agent = context.agents.get(step.agent);
    const selectedModel = resolveAgentModel(agent, step.agent, context);
    step.model = selectedModel.label;
    step.modelResolution = selectedModel.resolution;
    run.warnings.push(...selectedModel.warnings);
    const selectedThinking = resolveAgentThinking(agent, step.agent, context, selectedModel.resolution);
    step.thinkingLevel = selectedThinking.label;
    const promptOptions = buildPromptOptionsForStep(run, step, agent, options.previous);
    const budgetPolicy = budgetPolicyForSdkStep(policyForStep(agent, step, run.route.kind, run.route.risk), agent, step, options.previous);
    const maxToolCalls = budgetPolicy.caps.maxToolCalls;
    step.budget = budgetPolicy.profile;
    step.maxToolCalls = maxToolCalls;
    const allowedTools = childToolNames(agent, step.task, run.route.needsArtifacts, Boolean(options.previous));
    const activity = createStepActivityMonitor(step, run, context);
    const childPolicy = createChildToolPolicy({
      cwd: options.cwd,
      maxToolCalls,
      budgetPolicy,
      agentName: step.agent,
      allowedTools,
      priorFilesRead: promptOptions.priorFilesRead,
      maxCrossStepDuplicateReads: promptOptions.synthesisGapReadLimit !== undefined ? synthesisCrossStepDuplicateReadLimit(agent) : undefined,
      onActivity: activity.onToolActivity,
    });
    const prompt = buildSdkPrompt(agent, step.task, options.cwd, options.previous, budgetPolicy, "normal", promptOptions);
    const { createAgentSession } = await import("@earendil-works/pi-coding-agent");
    const releaseChildEnv = enterChildEnv();
    try {
      const created = await createAgentSession({
        cwd: options.cwd,
        model: selectedModel.model,
        ...(selectedThinking.level ? { thinkingLevel: selectedThinking.level as never } : {}),
        modelRegistry: extensionContext.modelRegistry,
        tools: allowedTools,
        customTools: createChildTools(childPolicy),
        sessionStartEvent: { type: "session_start", reason: "new" },
      });
      step.thinkingLevel = (created.session.thinkingLevel as AgentThinkingLevel | undefined) ?? step.thinkingLevel;
      let text = "";
      try {
        const abortChild = () => { void created.session.abort(); };
        context.signal?.addEventListener("abort", abortChild, { once: true });
        try {
          await withIdleTimeout(
            created.session.prompt(prompt, { expandPromptTemplates: false, source: "extension" }),
            {
              idleTimeoutMs: sdkStepIdleTimeoutMs(),
              message: `SDK runner idle timed out for ${step.agent}`,
              signal: context.signal,
              activeOperations: activity.activeOperations,
              pollActivitySignature: () => sessionActivitySignature(created.session.state.messages as unknown[], childPolicy),
              onTimeout: abortChild,
            },
          );
        } finally {
          context.signal?.removeEventListener("abort", abortChild);
          step.currentTool = undefined;
        }
        text = extractLastAssistantText(created.session.state.messages as unknown[]);
        step.output = parseAgentOutput(step.agent, text || `SDK run completed for ${step.agent}.`);
        step.metrics = finalizeStepMetrics(
          mergePolicyMetrics(extractSessionMetrics(created.session.state.messages as unknown[], stepStartedAtMs), childPolicy),
          step,
          budgetPolicy,
          promptOptions.priorFilesRead,
        );
      } finally {
        created.session.dispose();
      }
    } finally {
      releaseChildEnv();
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

function buildPromptOptionsForStep(run: RunState, step: RunStepState, agent: AgentDefinition | undefined, previous?: string): SdkPromptOptions {
  const priorFilesRead = priorFilesReadBeforeStep(run, step);
  return {
    priorFilesRead,
    ...(isHandoffGapReadMode(agent, step.task, previous) ? { synthesisGapReadLimit: synthesisGapReadLimit() } : {}),
  };
}

function priorFilesReadBeforeStep(run: RunState, currentStep: RunStepState): string[] {
  const index = run.steps.indexOf(currentStep);
  const previousSteps = index >= 0 ? run.steps.slice(0, index) : run.steps.filter((step) => step !== currentStep);
  return [...new Set(previousSteps.flatMap((step) => step.metrics?.filesRead ?? []))].slice(0, 80);
}

function budgetPolicyForSdkStep(policy: ReturnType<typeof policyForStep>, agent: AgentDefinition | undefined, step: RunStepState, previous?: string): ReturnType<typeof policyForStep> {
  if (!isHandoffGapReadMode(agent, step.task, previous)) return policy;
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

export function createRunState(route: RouteDecision, cwd: string): RunState {
  const id = `mesh-${Date.now().toString(36)}`;
  return {
    id,
    route,
    status: "running",
    startedAt: new Date().toISOString(),
    steps: route.plan ? planSteps(route.plan) : [],
    logsPath: path.join(resolveMeshPaths({ cwd }).projectRoot, ".pi-chalin", "runs", `${id}.json`),
    warnings: [],
    budgetPreflight: estimateBudgetPreflight({
      task: route.reason,
      routeKind: route.kind,
      steps: route.plan ? planAgentSteps(route.plan) : undefined,
      risk: route.risk,
      needsArtifacts: route.needsArtifacts,
    }),
  };
}

export function prepareRunForResume(run: RunState): RunState {
  run.status = "running";
  run.endedAt = undefined;
  run.warnings = [...run.warnings, `Resumed paused pi-chalin run ${run.id}.`];
  for (const step of run.steps) {
    if (isUsableStepHandoff(step) || step.status === "failed") continue;
    step.status = "pending";
    step.error = undefined;
    step.currentTool = undefined;
    step.endedAt = undefined;
  }
  persistRun(run);
  return run;
}

function aggregateCompletedHandoffBefore(steps: RunStepState[], endIndex: number): string {
  return aggregateHandoff(steps
    .slice(0, endIndex)
    .filter((step) => isUsableStepHandoff(step))
    .map((step) => ({ agent: step.agent, text: step.output?.handoff ?? step.output?.text ?? "" })));
}

export function loadResumableRunState(options: MeshPathsOptions & { runId?: string }): RunState | undefined {
  const runsDir = path.join(resolveMeshPaths(options).projectRoot, ".pi-chalin", "runs");
  if (!fs.existsSync(runsDir)) return undefined;
  const files = fs.readdirSync(runsDir)
    .filter((name) => name.endsWith(".json"))
    .map((name) => path.join(runsDir, name))
    .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
  for (const file of files) {
    try {
      const parsed = JSON.parse(fs.readFileSync(file, "utf-8")) as RunState;
      if (options.runId && parsed.id !== options.runId) continue;
      if (isResumableRun(parsed)) {
        parsed.logsPath ??= file;
        if (parsed.status === "running") {
          parsed.status = "paused";
          parsed.warnings = [...(parsed.warnings ?? []), "Recovered stale running run from disk after process shutdown."];
          persistRun(parsed);
        }
        return parsed;
      }
    } catch {
      // Ignore corrupt run files; a newer/older run may still be resumable.
    }
  }
  return undefined;
}

function isResumableRun(run: RunState): boolean {
  if (!run.route?.plan) return false;
  if (run.status !== "paused" && run.status !== "running") return false;
  if (run.steps.some((step) => !isUsableStepHandoff(step) && step.status !== "failed")) return true;
  return run.status === "running" && run.steps.length > 0 && run.steps.every((step) => isUsableStepHandoff(step));
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

function planSteps(plan: RoutePlan): RunStepState[] {
  if (plan.kind === "dag") {
    return plan.stages.flatMap((stage) => stage.tasks.map((step, index) => ({
      id: `${stage.id}:step-${index + 1}`,
      agent: step.agent,
      task: step.task,
      budget: step.budget,
      status: "pending" as const,
    })));
  }
  const rawSteps = plan.kind === "single" ? [{ agent: plan.agent, task: plan.task }] : plan.kind === "chain" ? plan.steps : plan.tasks;
  return rawSteps.map((step, index) => ({ id: `step-${index + 1}`, agent: step.agent, task: step.task, budget: step.budget, status: "pending" }));
}

function planAgentSteps(plan: RoutePlan): AgentStep[] {
  if (plan.kind === "single") return [{ agent: plan.agent, task: plan.task, budget: plan.budget }];
  if (plan.kind === "chain") return plan.steps;
  if (plan.kind === "parallel") return plan.tasks;
  return plan.stages.flatMap((stage) => stage.tasks);
}

function aggregateHandoff(items: Array<{ agent: string; text: string }>): string {
  return items
    .filter((item) => item.text.trim().length > 0)
    .map((item) => `- ${item.agent}: ${truncateText(item.text.trim(), 450)}`)
    .join("\n");
}

async function runStep(step: RunStepState, context: WorkerRunnerContext, previous: string | undefined, run?: RunState): Promise<AgentOutput> {
  step.status = "running";
  step.startedAt = new Date().toISOString();
  if (run) persistRun(run);
  context.onUpdate?.(run ?? { ...createRunState({ kind: "bypass", agents: [], risk: "low", ambiguity: "low", needsMemory: false, needsArtifacts: false, reason: "update" }, context.cwd), steps: [step] });
  await maybeMockDelay(context.signal);
  throwIfAborted(context.signal);
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
}

function buildMockOutput(step: RunStepState, context: WorkerRunnerContext, previous: string | undefined, agent: AgentDefinition | undefined): string {
  const snapshot = buildProjectSnapshot({ cwd: context.cwd });
  const summary = formatProjectSnapshot(snapshot);
  const gitSummary = snapshot.git ? `Git context: branch=${snapshot.git.branch ?? "unknown"}; recent changed files=${snapshot.git.changedFiles.slice(0, 8).join(", ") || "none"}.` : "";
  const projectFiles = snapshot.highSignalFiles;
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
  if (snapshotSummary) findings.push(`Snapshot signals: ${truncateText(snapshotSummary, 320)}`);
  if (gitSummary) findings.push(gitSummary);
  if (projectFiles.length) findings.push(`High-signal files: ${projectFiles.slice(0, 6).join(", ")}.`);
  if (previous) findings.push(`Prior handoff available and should be used instead of re-scanning: ${truncateText(previous, 240)}`);
  if (step.agent === "reviewer") findings.push("Review focus: validate architecture risks from scout evidence, not generic advice.");
  if (step.agent === "planner") findings.push("Planning focus: produce phased migration/implementation steps with tests and rollback points.");
  if (step.agent === "worker") findings.push("Implementation focus: make bounded file changes and add or update tests before reporting complete.");
  return findings.slice(0, 5);
}

function mockHandoff(step: RunStepState, snapshotSummary: string, gitSummary: string, projectFiles: string[], previous: string | undefined): string[] {
  const handoff: string[] = [];
  if (step.agent === "context-builder") {
    handoff.push(`Project context: ${snapshotSummary || "no stack metadata found"}`);
    if (gitSummary) handoff.push(gitSummary);
    if (projectFiles.length) handoff.push(`Inspect these first: ${projectFiles.slice(0, 5).join(", ")}.`);
    handoff.push("Answer should summarize purpose, modules, changed areas, and risks from the gathered context.");
  } else if (step.agent === "reviewer") {
    handoff.push(previous ? `Use scout evidence: ${truncateText(previous, 420)}` : "Review should first anchor claims in project files.");
    handoff.push("Likely risk areas: auth/session behavior, test coverage around changed behavior, and legacy component patterns.");
    handoff.push("Final answer should prioritize actionable risks and avoid generic architecture advice.");
  } else if (step.agent === "planner") {
    handoff.push(previous ? `Plan from evidence: ${truncateText(previous, 420)}` : "Plan should begin with inventory and risk slicing.");
    handoff.push("Recommended order: inventory → low-risk components → shared UI/composables → high-risk flows → regression tests.");
  } else if (step.agent === "worker") {
    handoff.push("Apply only the planned bounded change, keep diffs small, and run the nearest test command.");
  } else {
    handoff.push(`Mapped context for task: ${step.task}`);
    if (snapshotSummary) handoff.push(snapshotSummary);
    if (gitSummary) handoff.push(gitSummary);
    if (projectFiles.length) handoff.push(`High-signal files: ${projectFiles.slice(0, 5).join(", ")}.`);
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

function stageIdForStep(stepId: string): string {
  return stepId.includes(":") ? stepId.split(":")[0] ?? stepId : stepId;
}

function persistRun(run: RunState): void {
  if (run.logsPath) {
    fs.mkdirSync(path.dirname(run.logsPath), { recursive: true });
    fs.writeFileSync(run.logsPath, `${JSON.stringify(run, null, 2)}\n`, "utf-8");
  }
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
    activeOperations() {
      return activeTools;
    },
    lastActivityAt() {
      return lastActivityAt;
    },
  };
}

function sessionActivitySignature(messages: unknown[], policy: ChildToolPolicy): string {
  const last = messages.at(-1);
  const lastText = typeof last === "object" && last !== null ? JSON.stringify(last).slice(-512) : String(last ?? "");
  const metrics = policy.metrics();
  return `${messages.length}:${lastText.length}:${metrics.toolCalls}:${metrics.outputChars}:${metrics.readBytes}`;
}

function sdkStepIdleTimeoutMs(): number {
  const parsed = Number(process.env.PI_CHALIN_SDK_STEP_IDLE_TIMEOUT_MS ?? process.env.PI_CHALIN_SDK_STEP_TIMEOUT_MS);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 180_000;
}

export async function withIdleTimeout<T>(
  promise: Promise<T>,
  options: {
    idleTimeoutMs: number;
    message: string;
    signal?: AbortSignal;
    activeOperations?: () => number;
    pollActivitySignature?: () => string;
    onTimeout?: () => void;
    pollMs?: number;
  },
): Promise<T> {
  let lastActivityAt = Date.now();
  let lastSignature = options.pollActivitySignature?.();
  const pollMs = Math.max(10, Math.min(options.pollMs ?? 1_000, Math.max(10, Math.floor(options.idleTimeoutMs / 4))));

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
      if (Date.now() - lastActivityAt >= options.idleTimeoutMs) {
        options.onTimeout?.();
        finish(() => reject(new Error(`${options.message} after ${options.idleTimeoutMs}ms without activity`)));
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

function isAbortError(error: unknown): boolean {
  const message = errorMessage(error).toLowerCase();
  return message.includes("abort") || message.includes("stopped by user");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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

export function buildSdkPrompt(agent: AgentDefinition | undefined, task: string, cwd: string, previous?: string, budget: ReturnType<typeof policyForStep> | number = toolBudgetForAgent(agent), budgetProfile: ToolBudgetProfile = "normal", options: SdkPromptOptions = {}): string {
  const discoveryIndex = formatProjectDiscoveryIndex(buildProjectDiscoveryIndex(cwd));
  const capabilities = agent?.capabilities ?? [];
  const deepProjectAnalysis = isDeepProjectAnalysisTask(task) || budgetProfile === "deep" || (typeof budget !== "number" && budget.profile === "deep");
  const handoffGapMode = isHandoffGapReadMode(agent, task, previous);
  const budgetPolicy = typeof budget === "number"
    ? policyForStep(agent, { agent: agent?.name ?? "agent", task, budget: budgetProfile }, "single-agent")
    : budget;
  const maxTools = typeof budget === "number" ? budget : budget.caps.maxToolCalls;
  const profile = typeof budget === "number" ? budgetProfile : budget.profile;
  return [
    compactAgentInstructions(agent),
    "",
    "## pi-chalin concern/capability policy",
    `- Concern: ${agent?.concern ?? "delegation"}.`,
    `- Capabilities: ${capabilities.join(", ") || "inspect-files, search-files"}.`,
    "- Runtime tools are derived from capabilities; do not assume a tool exists because another agent has it.",
    "",
    "## pi-chalin child tool policy",
    "- Use Pi-native tools directly: read/find/grep/ls for inspection, edit for minimal line-level changes.",
    "- Use mesh_project_discovery first for broad project understanding. It is a raw file index, not semantic truth; read evidence files before making claims.",
    "- Use mesh_project_snapshot only as legacy compact stack/git context or for branch-summary reconnaissance; never treat it as proof of architecture.",
    "- Bash is guarded and only for safe inspection or explicit validation commands: git status/log/diff/show/rev-parse, pwd, ls, find, grep/rg, cat for one explicit small file, and known test/typecheck commands.",
    "- Never create temporary Python/Node/shell scripts to read, inspect, summarize, or modify project files.",
    "- Never modify files through bash. No redirection, tee, sed -i, rm/cp/mv/mkdir/touch/chmod, or generated scripts.",
    "- For existing files, never rewrite the whole file when a targeted edit is possible. Use edit with the smallest exact old/new block. Use write only for new files.",
    "",
    "## pi-chalin runtime budget",
    `- Tool budget profile: ${profile}. Max tool calls for this child turn: ${maxTools}.`,
    `- Budget caps: ${budgetPolicy.caps.maxSeconds}s, $${budgetPolicy.caps.maxUsd}, ${budgetPolicy.caps.maxTurns} turns, ${budgetPolicy.caps.maxOutputChars} output chars, ${budgetPolicy.caps.maxReadBytes} read bytes, ${budgetPolicy.caps.maxFilesTouched} files touched, ${budgetPolicy.caps.maxRetriesPerTool} retries/tool.`,
    "- Stay bounded. Do not perform an exhaustive repository crawl unless the task explicitly requires it.",
    agent?.concern === "recon" || deepProjectAnalysis
      ? "- AGENTS/JIT-first: when the discovery index lists AGENTS.md, CONTEXT.md, ADRs, or package instruction files, read the root instructions first and then only the package instruction files relevant to the task before broad source reads."
      : undefined,
    profile === "tight"
      ? "- Tight profile: use the discovery index first, then inspect only the smallest evidence set needed to answer."
      : profile === "deep" || profile === "extended"
        ? "- Deep/autonomous profile: use the discovery index first, formulate an inspection plan, then inspect breadth-first with compact notes; checkpoint/compress at stage boundaries instead of exhaustive context stuffing."
        : "- Normal profile: use the discovery index first, then inspect the evidence files needed; avoid exhaustive crawls unless the task requires it.",
    "- Prefer concise findings with evidence. Stop after the highest-value actionable issues; do not spend budget proving low-value metadata already present in the snapshot.",
    `- Use at most ${maxTools} tool calls for this role. If you hit the budget, stop and report partial findings plus uncertainty.`,
    "- If you hit any budget cap, treat it as a checkpoint boundary, not a failure: return partial handoff, uncertainty, and the next split/continue recommendation.",
    "- For hours/days-long autonomous work, do not try to solve everything inside one child turn. Write artifacts/checkpoints, return a handoff, and let the orchestrator continue with another bounded stage.",
    "- Do not browse the web unless this agent role and task explicitly request fresh external context.",
    deepProjectAnalysis
      ? "- Output budget for deep analysis: `## Findings` max 10 evidence-backed bullets, `## Handoff` max 14 bullets or 2600 characters, `## Memory Candidates` max 3 bullets. Accuracy beats brevity; do not pad."
      : "- Output budget: `## Findings` max 5 bullets, `## Handoff` max 8 bullets or 1200 characters, `## Memory Candidates` max 3 bullets.",
    "- For long-running work, use mesh_artifact_write only at meaningful boundaries: feature-state at start, checkpoint after a completed handoff, validation-contract before reviewer/worker handoff, worker-skill for reusable feature-specific rules.",
    "- Do not paste raw command output or long code snippets. Cite file paths and line-level evidence when useful.",
    deepProjectAnalysis ? deepProjectAnalysisContract() : undefined,
    handoffGapMode ? handoffGapReadContract(options, agent) : undefined,
    "",
    "## Stop conditions",
    stopConditionsForAgent(agent, task),
    "",
    previous ? "## Previous Handoff" : undefined,
    previous || undefined,
    previous ? "" : undefined,
    previous && options.priorFilesRead?.length ? "## Already Covered Evidence Paths" : undefined,
    previous && options.priorFilesRead?.length ? formatPriorFilesRead(options.priorFilesRead) : undefined,
    previous && options.priorFilesRead?.length ? "" : undefined,
    "## Task",
    task,
    "",
    "## Cached Project Discovery Index",
    previous ? "Discovery index omitted because Previous Handoff is available. Call mesh_project_discovery only if the handoff lacks required repo facts." : discoveryIndex,
    "",
    "Return a concise result with these sections when useful:",
    "## Findings",
    deepProjectAnalysis
      ? "- Evidence-backed discoveries that the orchestrator should show the user. Include claim + evidence; do not merge unsupported guesses."
      : "- Evidence-backed discoveries that the orchestrator should show the user. Max 5 bullets.",
    "## Handoff",
    deepProjectAnalysis
      ? "- Preserve the Coverage Matrix, Evidence Table, Unknowns/Gaps, and final synthesis material. Do not drop domain-critical subsystems."
      : "- A compact summary for the next agent or the orchestrator. Max 8 bullets or 1200 characters.",
    "## Memory Candidates",
    "- Only durable, human-readable project knowledge that will help future work.",
    "- Max 3 bullets.",
    "- Use 1-3 complete sentences per bullet. Prefer categories like `project-fact:`, `pattern:`, `tooling:`, `testing:`, `workflow:`, `bugfix:`, `decision:`, or `preference:`.",
    "- Good: `tooling: This project uses Bun for tests, and tests should avoid setTimeout-based waits because they are flaky.`",
    "- Good: `workflow: Long-running feature work should checkpoint validation contracts after each stage so later agents can resume safely.`",
    "- Bad: commands, logs, code snippets, raw stdout/stderr, stack traces, task completion notes, or obvious one-line facts.",
    "- Write `- None.` when there is nothing worth remembering.",
  ].filter(Boolean).join("\n");
}


function compactAgentInstructions(agent: AgentDefinition | undefined): string | undefined {
  if (!agent) return undefined;
  const rules = extractAgentSection(agent.systemPrompt, "Rules", "Tool discipline")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("-"))
    .slice(0, 4);
  return [
    `You are pi-chalin ${agent.name}: ${agent.description}`,
    rules.length ? "Role rules:" : undefined,
    ...rules,
  ].filter(Boolean).join("\n");
}

function extractAgentSection(text: string, start: string, end: string): string {
  const pattern = new RegExp(`${escapeRegExp(start)}:\\s*([\\s\\S]*?)(?:\\n\\s*${escapeRegExp(end)}:|$)`, "i");
  return pattern.exec(text)?.[1]?.trim() ?? "";
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}



function isSnapshotOnlyRecon(task: string, agent: AgentDefinition | undefined): boolean {
  return agent?.concern === "recon"
    && /\b(branch|diff|git state|status|recent commits?|changed files?)\b/i.test(task)
    && !/\b(implement|fix|edit|security|deep|exact behavior|line-level)\b/i.test(task);
}

function shouldUseHandoffOnlyMode(task: string, agent: AgentDefinition | undefined): boolean {
  if (!agent || agent.concern === "implementation") return false;
  if (isDeepProjectAnalysisTask(task)) return false;
  const explicitDeepInspection = /\b(exact line|line-level|verify|validate|run tests?|execute tests?|security|correctness|must inspect|full review)\b/i.test(task);
  if (explicitDeepInspection) return false;
  if (agent.concern === "context-building") return /\b(synthesize|summarize|explain|final answer|answer material|consolidate|plain language|package|using scout findings|changed files enough)\b/i.test(task);
  return /\b(synthesize|summarize|explain|final answer|answer material|consolidate|package)\b/i.test(task);
}

function taskNeedsArtifactWrite(task: string): boolean {
  return /\b(artifact|checkpoint|validation contract|worker skill|resume|continuation|long-running|long running)\b/i.test(task);
}

function taskNeedsExternalContext(task: string, agent: AgentDefinition): boolean {
  if (agent.concern === "research") return true;
  return /\b(web|internet|online|current|latest|recent|docs?|url|https?:\/\/|exa|source|sources)\b/i.test(task);
}

function taskNeedsBash(task: string, agent: AgentDefinition): boolean {
  if (agent.concern === "implementation") return true;
  return /\b(test|validate|validation|lint|typecheck|git|branch|diff|commit|status|log)\b/i.test(task);
}

export function childToolNames(agent: AgentDefinition | undefined, task = "", needsArtifacts = false, hasPrevious = false): string[] {
  if (hasPrevious && shouldUseHandoffOnlyMode(task, agent)) return taskNeedsArtifactWrite(task) && needsArtifacts ? ["mesh_artifact_write"] : [];
  if (isSnapshotOnlyRecon(task, agent)) return ["mesh_project_discovery", "mesh_project_snapshot"];
  if (!agent?.capabilities.length) {
    const fallback = new Set(agent?.tools.length ? agent.tools : ["read", "grep", "find", "ls"]);
    fallback.add("mesh_project_discovery");
    return [...fallback];
  }
  const names = new Set<string>();
  if (hasAnyCapability(agent, ["inspect-files"])) {
    names.add("read");
    names.add("ls");
  }
  if (hasAnyCapability(agent, ["search-files"])) {
    names.add("grep");
    names.add("find");
  }
  if (hasAnyCapability(agent, ["run-safe-bash", "validate"]) && taskNeedsBash(task, agent)) names.add("bash");
  if (hasAnyCapability(agent, ["edit-files"])) names.add("edit");
  if (hasAnyCapability(agent, ["write-new-files"])) names.add("write");
  if (hasAnyCapability(agent, ["external-context"]) && taskNeedsExternalContext(task, agent)) names.add("mesh_web_search");
  if (needsArtifacts && taskNeedsArtifactWrite(task) && hasAnyCapability(agent, ["memory-write", "coordinate", "validate", "edit-files"])) names.add("mesh_artifact_write");
  names.add("mesh_project_discovery");
  return [...names];
}

function toolBudgetForAgent(agent: AgentDefinition | undefined, fallbackName?: string): number {
  const env = Number(process.env.PI_CHALIN_CHILD_TOOL_BUDGET);
  if (Number.isFinite(env) && env > 0) return Math.floor(env);
  return baseToolBudget(agent, fallbackName);
}

export function toolBudgetForStep(agent: AgentDefinition | undefined, step: Pick<RunStepState, "agent" | "task" | "budget">, routeKind: RouteKind = "single-agent"): number {
  const env = Number(process.env.PI_CHALIN_CHILD_TOOL_BUDGET);
  if (Number.isFinite(env) && env > 0) return Math.floor(env);
  return policyForStep(agent, step, routeKind).caps.maxToolCalls;
}

export function resolveStepCompletionStatus(step: Pick<RunStepState, "metrics" | "output" | "error">): RunStepState["status"] {
  if (!step.metrics?.budgetStopCount) return "complete";
  if (hasUsableHandoff(step)) return "complete";
  return "budget-capped";
}

function hasUsableHandoff(step: Pick<RunStepState, "output" | "error">): boolean {
  const text = [step.output?.handoff, step.output?.text].filter(Boolean).join("\n").trim();
  if (text.length < 80) return false;
  if (/^(done|complete|ok|no output)\.?$/i.test(text)) return false;
  return /\b(file|path|module|test|risk|finding|because|uses|contains|should|next|changed|review|implementation|architecture|project)\b/i.test(text);
}

function baseToolBudget(agent: AgentDefinition | undefined, fallbackName?: string): number {
  if (agent?.concern === "recon") return 40;
  if (agent?.concern === "context-building") return 60;
  if (agent?.concern === "planning") return 25;
  if (agent?.concern === "review") return 50;
  if (agent?.concern === "implementation") return 80;
  if (agent?.concern === "research") return 60;
  if (agent?.concern === "decision-consistency") return 8;
  if (agent?.concern === "conflict-resolution") return 16;
  if (fallbackName === "scout") return 40;
  if (fallbackName === "context-builder") return 60;
  if (fallbackName === "planner") return 25;
  if (fallbackName === "reviewer") return 50;
  if (fallbackName === "worker") return 80;
  return 40;
}

function stopConditionsForAgent(agent: AgentDefinition | undefined, task = ""): string {
  if (isDeepProjectAnalysisTask(task) && agent?.concern === "recon") {
    return "- Stop only after producing a coverage map across top-level functional areas: entrypoints, commands/tools/routes, storage/sync, integrations, UI/cloud surfaces, tests/evals/tooling, and explicit unknowns.";
  }
  if (isDeepProjectAnalysisTask(task) && (agent?.concern === "context-building" || agent?.concern === "review")) {
    return "- Stop only after the Coverage Matrix marks each critical surface as covered with evidence, not present with evidence, or unknown/gap.";
  }
  if (agent?.concern === "recon") return "- Stop once stack signals, test/build commands, entrypoints, changed files, and 3-5 high-signal files are identified.";
  if (agent?.concern === "context-building") return "- Stop once the next agent has enough facts, constraints, relevant paths, and uncertainties to act without re-scanning.";
  if (agent?.concern === "planning") return "- Stop once the plan has ordered phases, likely files, validation, risks, and rollback notes; do not inspect implementation details deeply.";
  if (agent?.concern === "review") return "- Stop after the top 3-5 evidence-backed risks/findings; do not keep searching for marginal issues.";
  if (agent?.concern === "implementation") return "- Stop after the scoped change and nearest validation are complete; do not broaden scope or rewrite unrelated code.";
  if (agent?.concern === "research") return "- Stop after current sourced context is enough; do not browse or fetch beyond the task scope.";
  return "- Stop when the bounded task can be answered with evidence and remaining uncertainty is explicit.";
}

function isDeepProjectAnalysisTask(task: string): boolean {
  return /\b(deep|thorough|in[- ]depth|profundidad|profundo|profunda|revisa este proyecto|review this project|what (does|is) this project|que hace este proyecto|analiza este (repo|proyecto)|understand this project|project analysis)\b/i.test(task);
}

function deepProjectAnalysisContract(): string {
  return [
    "",
    "## Deep project analysis accuracy contract",
    "- Optimize for accuracy, not length. A short answer that misses core subsystems is wrong; a long answer without evidence is also wrong.",
    "- Produce a Coverage Matrix before synthesis. Required surfaces: runtime/entrypoints; commands/tools/routes; data/storage/sync; local project detection; external integrations/MCP/tools; HTTP/API routes; UI/dashboard/cloud surfaces; memory/conflict/governance; tests/evals/tooling; known gaps.",
    "- Mark every Coverage Matrix item as one of: covered with evidence, not present with evidence, or unknown/gap. Do not pretend an unknown is absent.",
    "- Produce an Evidence Table using claim + evidence + confidence + gap. Evidence should include file paths and symbol/function/route/config keys when available.",
    "- For memory/agent/orchestration projects, explicitly check: local/project detection, memory persistence and sync, MCP/tool surface, HTTP/API surface, conflict detection/surfacing, external integrations, UI/dashboard/cloud, and test/eval status.",
    "- For command/tool/route surfaces, include representative exact commands, endpoints, and tool names (for example `engram mcp`, `/observations`, or `mem_save`) instead of generic labels only.",
    "- For local-first persistence/sync, state what is the source of truth and name concrete sync artifacts such as manifests/chunks when present.",
    "- Do not merge a claim into final synthesis unless it has evidence or is explicitly labeled as inference.",
    "- Final synthesis must preserve domain-critical subsystems discovered in docs, routes, tools, tests, or config.",
  ].join("\n");
}

function isSynthesisGapReadMode(agent: AgentDefinition | undefined, task: string, previous?: string): boolean {
  if (!previous?.trim()) return false;
  if (agent?.concern !== "context-building") return false;
  return isDeepProjectAnalysisTask(task) || /\b(synthesize|summarize|explain|final answer|answer material|consolidate|context-builder|a partir del handoff|scout findings|síntesis|sintetiza|resumen)\b/i.test(task);
}

function isReviewGapReadMode(agent: AgentDefinition | undefined, task: string, previous?: string): boolean {
  if (!previous?.trim()) return false;
  if (agent?.concern !== "review") return false;
  return isDeepProjectAnalysisTask(task) || /\b(review|validate|verify|audit|risk|gap|quality|correctness|revisa|verifica|valida|riesgos?|gaps?)\b/i.test(task);
}

function isHandoffGapReadMode(agent: AgentDefinition | undefined, task: string, previous?: string): boolean {
  return isSynthesisGapReadMode(agent, task, previous) || isReviewGapReadMode(agent, task, previous);
}

function synthesisToolCallLimit(): number {
  const parsed = Number(process.env.PI_CHALIN_SYNTHESIS_TOOL_LIMIT);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 35;
}

function handoffReviewToolCallLimit(): number {
  const parsed = Number(process.env.PI_CHALIN_REVIEW_TOOL_LIMIT);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 12;
}

function synthesisGapReadLimit(): number {
  const parsed = Number(process.env.PI_CHALIN_SYNTHESIS_GAP_READ_LIMIT);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 12;
}

function synthesisCrossStepDuplicateReadLimit(agent?: AgentDefinition): number {
  const parsed = Number(process.env.PI_CHALIN_SYNTHESIS_CROSS_READ_LIMIT);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : agent?.concern === "review" ? 1 : 3;
}

function handoffGapReadContract(options: SdkPromptOptions, agent: AgentDefinition | undefined): string {
  const gapReadLimit = options.synthesisGapReadLimit ?? synthesisGapReadLimit();
  const reviewMode = agent?.concern === "review";
  return [
    "",
    reviewMode ? "## Handoff-first review / sampled-audit contract" : "## Handoff-first synthesis / gap-read contract",
    reviewMode
      ? "- Treat `Previous Handoff` as the primary evidence map. Your job is targeted quality audit, not a second repository crawl."
      : "- Treat `Previous Handoff` as the primary evidence map. Your job is synthesis, not a second repository crawl.",
    `- You may do at most ${gapReadLimit} gap reads/searches when the handoff has a concrete unknown, contradiction, or missing evidence needed for the final answer.`,
    reviewMode ? "- For review, sample only the highest-risk or least-supported claims. Prefer grep/find for exact symbols/config keys; avoid full reads of already-covered files." : undefined,
    "- Do not reread files listed in `Already Covered Evidence Paths` unless you name the specific missing symbol/line/claim you are verifying.",
    "- If a read is blocked by the cross-step duplicate-read policy, do not retry variants of the same evidence path; use the handoff evidence and mark the claim as sampled/not rechecked.",
    "- Prefer citing evidence already present in the handoff. Use new reads only to close explicit gaps, then stop.",
    "- If coverage is incomplete, say exactly what remains unknown instead of expanding into a broad crawl.",
    "- Return final answer material plus a compact handoff; do not emit a second raw exploration log.",
  ].filter((line): line is string => Boolean(line)).join("\n");
}

function formatPriorFilesRead(files: string[]): string {
  const unique = [...new Set(files)].slice(0, 40);
  const extra = files.length > unique.length ? `\n- …${files.length - unique.length} more` : "";
  return `${unique.map((file) => `- ${file}`).join("\n")}${extra}`;
}

function hasAnyCapability(agent: AgentDefinition, capabilities: AgentCapability[]): boolean {
  return capabilities.some((capability) => agent.capabilities.includes(capability));
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

export function resolveAgentModel(agent: AgentDefinition | undefined, agentName: string, context: WorkerRunnerContext): { model: ExtensionContext["model"]; label: string; resolution: ModelResolutionLog; warnings: string[] } {
  const fallback = context.extensionContext?.model;
  const tier = agentTier(agentName);
  const candidates: Array<{ source: ModelResolutionAttempt["source"]; ref?: string }> = [
    { source: "session-override", ref: context.modelOverrides?.[`${agent?.scope ?? "built-in"}/${agentName}`] ?? context.modelOverrides?.[agentName] },
    { source: "agent", ref: agent?.model && agent.model !== "inherit" ? agent.model : undefined },
    { source: "tier", ref: context.modelOverrides?.[`tier/${tier}`] ?? process.env[`PI_CHALIN_${tier.toUpperCase()}_MODEL`] },
  ];
  const attempts: ModelResolutionAttempt[] = [];

  for (const candidate of candidates) {
    if (!candidate.ref) continue;
    const resolved = resolveModelRef(candidate.ref, context);
    attempts.push({ source: candidate.source, ref: candidate.ref, status: resolved.status, model: resolved.model ? `${resolved.model.provider}/${resolved.model.id}` : undefined, reason: resolved.reason });
    if (resolved.status === "selected" && resolved.model) {
      const selected = `${resolved.model.provider}/${resolved.model.id}`;
      return {
        model: resolved.model,
        label: selected,
        resolution: { selected, tier, attempts },
        warnings: fallbackWarnings(agentName, attempts, selected),
      };
    }
  }

  const inherited = fallback ? `${fallback.provider}/${fallback.id}` : "inherit";
  attempts.push({ source: "inherit", status: fallback ? "selected" : "fallback", model: inherited, reason: fallback ? undefined : "no active Pi model available" });
  return {
    model: fallback,
    label: fallback ? `${inherited} (${tier}:inherit)` : `inherit (${tier})`,
    resolution: { selected: inherited, tier, attempts },
    warnings: fallbackWarnings(agentName, attempts, inherited),
  };
}

export function resolveAgentThinking(
  agent: AgentDefinition | undefined,
  agentName: string,
  context: WorkerRunnerContext,
  modelResolution?: ModelResolutionLog,
): { level?: Exclude<AgentThinkingLevel, "inherit">; label: AgentThinkingLevel } {
  const explicit = context.thinkingOverrides?.[`${agent?.scope ?? "built-in"}/${agentName}`] ?? context.thinkingOverrides?.[agentName];
  const frontmatter = agent?.thinking && agent.thinking !== "inherit" ? agent.thinking : undefined;
  const modelSuffix = selectedThinkingSuffix(modelResolution);
  const level = explicit && explicit !== "inherit" ? explicit : frontmatter ?? modelSuffix;
  return level ? { level, label: level } : { label: "inherit" };
}

function selectedThinkingSuffix(modelResolution?: ModelResolutionLog): Exclude<AgentThinkingLevel, "inherit"> | undefined {
  const selected = modelResolution?.attempts.find((attempt) => attempt.status === "selected" && attempt.ref)?.ref;
  if (!selected) return undefined;
  return splitThinkingSuffix(selected).thinking;
}

function resolveModelRef(ref: string, context: WorkerRunnerContext): { status: ModelResolutionAttempt["status"]; model?: ExtensionContext["model"]; reason?: string } {
  const parsed = parseModelRef(stripThinkingSuffix(ref).model);
  if (!parsed) return { status: "invalid", reason: "expected provider/model-id" };
  const registry = context.extensionContext?.modelRegistry;
  const model = registry?.find(parsed.provider, parsed.modelId);
  if (!model) return { status: "unavailable", reason: "not found in Pi model registry" };
  if (!registry?.hasConfiguredAuth(model)) return { status: "unauthenticated", model, reason: "provider is not configured" };
  return { status: "selected", model };
}

function splitThinkingSuffix(ref: string): { model: string; thinking?: Exclude<AgentThinkingLevel, "inherit"> } {
  const trimmed = ref.trim();
  const colon = trimmed.lastIndexOf(":");
  if (colon === -1) return { model: trimmed };
  const suffix = trimmed.slice(colon + 1);
  if (suffix === "off" || suffix === "minimal" || suffix === "low" || suffix === "medium" || suffix === "high" || suffix === "xhigh") {
    return { model: trimmed.slice(0, colon), thinking: suffix };
  }
  return { model: trimmed };
}

function stripThinkingSuffix(ref: string): { model: string } {
  return { model: splitThinkingSuffix(ref).model };
}

function parseModelRef(ref: string): { provider: string; modelId: string } | undefined {
  const trimmed = ref.trim();
  if (!trimmed || trimmed === "inherit") return undefined;
  const slash = trimmed.indexOf("/");
  if (slash <= 0 || slash === trimmed.length - 1) return undefined;
  return { provider: trimmed.slice(0, slash), modelId: trimmed.slice(slash + 1) };
}

function agentTier(agentName: string): "fast" | "balanced" | "strong" {
  if (["scout", "context-builder", "delegate"].includes(agentName)) return "fast";
  if (["worker", "oracle"].includes(agentName)) return "strong";
  return "balanced";
}

function fallbackWarnings(agentName: string, attempts: ModelResolutionAttempt[], selected: string): string[] {
  const failed = attempts.filter((attempt) => ["invalid", "unavailable", "unauthenticated", "fallback"].includes(attempt.status) && attempt.source !== "inherit");
  if (failed.length === 0) return [];
  const refs = failed.map((attempt) => `${attempt.ref ?? attempt.source} ${attempt.status}`).join("; ");
  return [`Model fallback for ${agentName}: ${refs}; selected ${selected}.`];
}

function extractSessionMetrics(messages: unknown[], startedAtMs: number): RunStepMetrics {
  const responseIds = new Set<string>();
  const usage = emptyUsage();
  const toolCallsByName: Record<string, number> = {};
  const filesRead: string[] = [];
  const policyViolations: string[] = [];
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
      policyViolations.push(...policyViolationsForCall(name, call.args));
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
  const budgetStopCount = (metrics.budgetStopCount ?? 0) + policyMetrics.budgetStopCount;
  return {
    ...metrics,
    toolCalls: Math.max(metrics.toolCalls, policyMetrics.toolCalls),
    maxToolCalls: policy.maxToolCalls,
    toolCallsByName,
    ...(policyViolations.length ? { policyViolations } : {}),
    ...(budgetStopCount > 0 ? { budgetStopCount } : {}),
    ...(duplicateReadCount > 0 ? { duplicateReadCount } : {}),
    ...(filesRead.length ? { filesRead: filesRead.slice(0, 50) } : {}),
    readBytes: Math.max(metrics.readBytes ?? 0, policyMetrics.readBytes),
    outputChars: Math.max(metrics.outputChars ?? 0, policyMetrics.outputChars),
    outputTruncatedCount: Math.max(metrics.outputTruncatedCount ?? 0, policyMetrics.outputTruncatedCount),
    filesTouched: [...new Set([...(metrics.filesTouched ?? []), ...policyMetrics.filesTouched])].slice(0, 50),
    retriesByTool: { ...(metrics.retriesByTool ?? {}), ...policyMetrics.retriesByTool },
  };
}

function finalizeStepMetrics(metrics: RunStepMetrics, step: RunStepState, budgetPolicy: ReturnType<typeof policyForStep>, priorFilesRead: string[] = []): RunStepMetrics {
  const utility = summarizeToolUtility({
    findings: extractFindingLines(step.output?.text ?? ""),
    toolCalls: metrics.toolCalls,
    filesRead: metrics.filesRead ?? [],
    firstSignalToolCall: firstSignalToolCall(metrics),
    verificationDone: Boolean((metrics.toolCallsByName.bash ?? 0) > 0 || /validat|test|passed|verified/i.test(step.output?.text ?? "")),
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
  return {
    ...metrics,
    utility,
    ...(crossStepDuplicateReads.length ? {
      crossStepDuplicateReadCount: crossStepDuplicateReads.length,
      crossStepDuplicateReads: crossStepDuplicateReads.slice(0, 30),
    } : {}),
    ...(health.status === "budget-capped" || health.status === "warn" ? { budgetStopCount: Math.max(metrics.budgetStopCount ?? 0, health.status === "budget-capped" ? 1 : 0) } : {}),
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
  const snapshotCalls = metrics.toolCallsByName.mesh_project_snapshot ?? 0;
  if ((metrics.filesRead?.length ?? 0) > 0 || snapshotCalls > 0) return Math.max(1, Math.min(metrics.toolCalls, snapshotCalls || readCalls || 1));
  return metrics.toolCalls;
}

function summarizeRunMetrics(run: RunState): RunState["metrics"] {
  const usage = emptyUsage();
  const toolCallsByName: Record<string, number> = {};
  const policyViolations: string[] = [];
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

function policyViolationsForCall(name: string, args: Record<string, unknown>): string[] {
  const violations: string[] = [];
  const command = typeof args.command === "string" ? args.command : "";
  if (name === "bash" && /\b(?:python|python3|node|ruby|perl|php|deno|tsx|ts-node|sh|bash|zsh)\b|[<>]|tee|sed\s+-i|cat\s+>/i.test(command)) {
    violations.push(`bash_policy:${command.slice(0, 140)}`);
  }
  return violations;
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
