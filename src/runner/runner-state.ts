import * as fs from "node:fs";
import * as path from "node:path";
import { estimateBudgetPreflight } from "../budget/budget.ts";
import { resolveChalinPaths, type ChalinPathsOptions } from "../config/paths.ts";
import type { AgentStep, RouteDecision, RoutePlan, RunState, RunStepState } from "../domain/schemas.ts";
import { isUsableStepStatus, normalizeLegacyBudgetCappedRun } from "../runtime/status.ts";
import { buildIntentContract } from "./intent-contract.ts";
import { updateRecoveryState } from "./run-recovery.ts";
import { planStepsWithWorkUnits } from "./work-units.ts";

export function createRunState(route: RouteDecision, cwd: string, rootTask?: string, metadata: { parentRunId?: string; parentStepId?: string; delegationDepth?: number } = {}): RunState {
  const id = `chalin-${Date.now().toString(36)}`;
  const planned = planStepsWithWorkUnits(route);
  const intentContract = buildIntentContract(rootTask, route);
  ensureChalinGitInfoExclude(cwd);
  return {
    id,
    route,
    ...(rootTask?.trim() ? { rootTask: rootTask.trim() } : {}),
    status: "running",
    schemaVersion: 3,
    startedAt: new Date().toISOString(),
    steps: planned.steps,
    logsPath: path.join(resolveChalinPaths({ cwd }).projectRoot, ".pi-chalin", "runs", `${id}.json`),
    ...(metadata.parentRunId ? { parentRunId: metadata.parentRunId } : {}),
    ...(metadata.parentStepId ? { parentStepId: metadata.parentStepId } : {}),
    ...(metadata.delegationDepth !== undefined ? { delegationDepth: metadata.delegationDepth } : {}),
    warnings: [],
    ...(intentContract ? { intentContract } : {}),
    workUnits: planned.workUnits,
    mutationLedger: [],
    verificationLedger: [],
    recoveryState: { pendingUnits: planned.workUnits.map((unit) => unit.id), reviewersNotRun: [], resumeKind: "none", repairOptions: [] },
    observabilitySummary: {
      workUnits: planned.workUnits.length,
      skippedSteps: 0,
      reviewersNotRun: 0,
      mutationEntries: 0,
      verificationEntries: 0,
      repairOptions: [],
    },
    budgetPreflight: estimateBudgetPreflight({
      task: route.reason,
      routeKind: route.kind,
      steps: route.plan ? planAgentSteps(route.plan) : undefined,
      risk: route.risk,
      needsArtifacts: route.needsArtifacts,
    }),
  };
}

export function ensureChalinGitInfoExclude(cwd: string): void {
  const gitDir = resolveGitDir(cwd);
  if (!gitDir) return;
  const infoDir = path.join(gitDir, "info");
  const excludePath = path.join(infoDir, "exclude");
  try {
    fs.mkdirSync(infoDir, { recursive: true });
    const current = fs.existsSync(excludePath) ? fs.readFileSync(excludePath, "utf-8") : "";
    const lines = current.split(/\r?\n/).map((line) => line.trim());
    if (lines.includes(".pi-chalin/") || lines.includes(".pi-chalin")) return;
    const prefix = current.length > 0 && !current.endsWith("\n") ? "\n" : "";
    fs.appendFileSync(excludePath, `${prefix}.pi-chalin/\n`, "utf-8");
  } catch {
    // Git ignore hygiene is best-effort; run persistence still works without it.
  }
}

function resolveGitDir(cwd: string): string | undefined {
  const dotGit = path.join(cwd, ".git");
  try {
    const stat = fs.statSync(dotGit);
    if (stat.isDirectory()) return dotGit;
    if (!stat.isFile()) return undefined;
    const content = fs.readFileSync(dotGit, "utf-8").trim();
    const marker = "gitdir:";
    if (!content.toLowerCase().startsWith(marker)) return undefined;
    const rawGitDir = content.slice(marker.length).trim();
    return path.isAbsolute(rawGitDir) ? rawGitDir : path.resolve(cwd, rawGitDir);
  } catch {
    return undefined;
  }
}

export function prepareRunForResume(run: RunState): RunState {
  run.status = "running";
  run.endedAt = undefined;
  run.warnings = [...run.warnings, `Resumed paused pi-chalin run ${run.id}.`];
  for (const step of run.steps) {
    if (isUsableStepHandoff(step) || step.status === "failed") continue;
    step.status = "pending";
    step.error = undefined;
    step.pauseReason = undefined;
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
      const parsed = normalizeLegacyBudgetCappedRun(JSON.parse(fs.readFileSync(file, "utf-8")) as RunState);
      if (options.runId && parsed.id !== options.runId) continue;
      if (isResumableRun(parsed)) {
        parsed.logsPath ??= file;
        if (parsed.status === "running" && options.recoverStale !== false) {
          parsed.status = "paused";
          parsed.warnings = [...(parsed.warnings ?? []), "Recovered stale running run from disk after process shutdown."];
          updateRecoveryState(parsed);
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
  return isUsableStepStatus(step.status);
}

function isResumableRun(run: RunState): boolean {
  if (!run.route?.plan) return false;
  if (run.status !== "paused" && run.status !== "running") return false;
  if (run.steps.some((step) => !isUsableStepHandoff(step) && step.status !== "failed")) return true;
  return run.status === "running" && run.steps.length > 0 && run.steps.every((step) => isUsableStepHandoff(step));
}

function planAgentSteps(plan: RoutePlan): AgentStep[] {
  if (plan.kind === "sequential") return plan.steps;
  return plan.stages.flatMap((stage) => stage.tasks);
}
