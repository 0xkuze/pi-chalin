import * as fs from "node:fs";
import * as path from "node:path";
import { estimateBudgetPreflight } from "./budget.ts";
import { resolveChalinPaths, type ChalinPathsOptions } from "./paths.ts";
import type { AgentStep, RouteDecision, RoutePlan, RunState, RunStepState } from "./schemas.ts";

export function createRunState(route: RouteDecision, cwd: string, rootTask?: string, metadata: { parentRunId?: string; parentStepId?: string; delegationDepth?: number } = {}): RunState {
  const id = `chalin-${Date.now().toString(36)}`;
  return {
    id,
    route,
    ...(rootTask?.trim() ? { rootTask: rootTask.trim() } : {}),
    status: "running",
    startedAt: new Date().toISOString(),
    steps: route.plan ? planSteps(route.plan) : [],
    logsPath: path.join(resolveChalinPaths({ cwd }).projectRoot, ".pi-chalin", "runs", `${id}.json`),
    ...(metadata.parentRunId ? { parentRunId: metadata.parentRunId } : {}),
    ...(metadata.parentStepId ? { parentStepId: metadata.parentStepId } : {}),
    ...(metadata.delegationDepth !== undefined ? { delegationDepth: metadata.delegationDepth } : {}),
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

export function loadResumableRunState(options: ChalinPathsOptions & { runId?: string; recoverStale?: boolean }): RunState | undefined {
  const runsDir = path.join(resolveChalinPaths(options).projectRoot, ".pi-chalin", "runs");
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
        if (parsed.status === "running" && options.recoverStale !== false) {
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

export function persistRun(run: RunState): void {
  if (!run.logsPath) return;
  fs.mkdirSync(path.dirname(run.logsPath), { recursive: true });
  fs.writeFileSync(run.logsPath, `${JSON.stringify(run, null, 2)}\n`, "utf-8");
}

export function isUsableStepHandoff(step: Pick<RunStepState, "status">): boolean {
  return step.status === "complete" || step.status === "budget-capped";
}

function isResumableRun(run: RunState): boolean {
  if (!run.route?.plan) return false;
  if (run.status !== "paused" && run.status !== "running") return false;
  if (run.steps.some((step) => !isUsableStepHandoff(step) && step.status !== "failed")) return true;
  return run.status === "running" && run.steps.length > 0 && run.steps.every((step) => isUsableStepHandoff(step));
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
  const rawSteps = plan.kind === "single" ? [{ agent: plan.agent, task: plan.task, budget: plan.budget }] : plan.kind === "chain" ? plan.steps : plan.tasks;
  return rawSteps.map((step, index) => ({ id: `step-${index + 1}`, agent: step.agent, task: step.task, budget: step.budget, status: "pending" }));
}

function planAgentSteps(plan: RoutePlan): AgentStep[] {
  if (plan.kind === "single") return [{ agent: plan.agent, task: plan.task, budget: plan.budget }];
  if (plan.kind === "chain") return plan.steps;
  if (plan.kind === "parallel") return plan.tasks;
  return plan.stages.flatMap((stage) => stage.tasks);
}
