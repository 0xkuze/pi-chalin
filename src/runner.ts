import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AgentDefinition, AgentThinkingLevel } from "./schemas.ts";
import { evaluateBudgetUsage, policyForStep, recordBudgetCheckpoint, summarizeToolUtility } from "./budget.ts";
import type { ChalinPathsOptions } from "./paths.ts";
import { createMemoryCandidate, MemoryStore } from "./memory.ts";
import type { AgentOutput, AgentStep, MemoryCandidate, RouteDecision, RoutePlan, RunState, RunStepMetrics, RunStepState, TokenUsageSummary } from "./schemas.ts";
import { createChildToolPolicy, createChildTools, type ChildToolActivity, type ChildToolPolicy } from "./child-tools.ts";
import { createChalinChildSessionManager } from "./child-sessions.ts";
import { buildProjectSnapshot, formatProjectSnapshot } from "./snapshot.ts";
import { ArtifactStore } from "./artifacts.ts";
import { resolveAgentModel, resolveAgentThinking } from "./model-resolution.ts";
import { buildSdkPrompt, childToolNames, handoffReviewToolCallLimit, isHandoffGapReadMode, resolveStepCompletionStatus, synthesisCrossStepDuplicateReadLimit, synthesisGapReadLimit, synthesisToolCallLimit, type SdkPromptOptions } from "./runner-prompt.ts";
import { createRunState, isUsableStepHandoff, persistRun, prepareRunForResume } from "./runner-state.ts";
import { clearLiveStepSession, setLiveStepSession, type LiveStepSessionRef } from "./runtime-state.ts";
import { cleanupWorktrees, mergeWorktreeChanges, needsWorktreeIsolation, prepareWorktreeIsolation, type WorktreeIsolationPlan } from "./worktrees.ts";

export interface WorkerRunnerContext extends ChalinPathsOptions {
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
    promptOptions.memoryContext = await compactMemoryContextForStep(options.cwd, step, agent, options.previous);
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
    const sessionManager = createChalinChildSessionManager({ cwd: options.cwd, runId: run.id, step, extensionContext });
    const releaseChildEnv = enterChildEnv();
    try {
      const created = await createAgentSession({
        cwd: options.cwd,
        model: selectedModel.model,
        ...(selectedThinking.level ? { thinkingLevel: selectedThinking.level as never } : {}),
        modelRegistry: extensionContext.modelRegistry,
        sessionManager,
        tools: allowedTools,
        customTools: createChildTools(childPolicy),
        sessionStartEvent: { type: "session_start", reason: "new" },
      });
      step.thinkingLevel = (created.session.thinkingLevel as AgentThinkingLevel | undefined) ?? step.thinkingLevel;
      const liveRef: LiveStepSessionRef = {
        runId: run.id,
        stepId: step.id,
        agent: step.agent,
        cwd: options.cwd,
        startedAt: new Date().toISOString(),
        getMessages: () => Array.isArray(created.session.state.messages) ? created.session.state.messages as unknown[] : [],
      };
      setLiveStepSession(liveRef);
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
              pollActivitySignature: () => {
                const messages = created.session.state.messages as unknown[];
                activity.onSessionActivity(messages);
                return sessionActivitySignature(messages, childPolicy);
              },
              onTimeout: abortChild,
            },
          );
        } finally {
          context.signal?.removeEventListener("abort", abortChild);
          step.currentTool = undefined;
        }
        activity.onSessionActivity(created.session.state.messages as unknown[]);
        text = extractLastAssistantText(created.session.state.messages as unknown[]);
        step.output = parseAgentOutput(step.agent, text || `SDK run completed for ${step.agent}.`);
        step.metrics = finalizeStepMetrics(
          mergePolicyMetrics(extractSessionMetrics(created.session.state.messages as unknown[], stepStartedAtMs), childPolicy),
          step,
          budgetPolicy,
          promptOptions.priorFilesRead,
        );
      } finally {
        clearLiveStepSession(run.id, step.id, liveRef);
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

async function compactMemoryContextForStep(cwd: string, step: RunStepState, agent: AgentDefinition | undefined, previous?: string): Promise<string | undefined> {
  if (!agent?.memory.read || !agent.capabilities.includes("memory-read")) return undefined;
  const query = [step.task, previous ? `Previous handoff: ${previous.slice(0, 700)}` : ""].filter(Boolean).join("\n");
  const bundle = await new MemoryStore({ cwd }).retrieve({
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
  const snapshotCalls = metrics.toolCallsByName.chalin_project_snapshot ?? 0;
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
