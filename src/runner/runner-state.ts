import * as fs from "node:fs";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { estimateBudgetPreflight } from "../budget/budget.ts";
import { resolveChalinPaths, type ChalinPathsOptions } from "../config/paths.ts";
import type { AgentStep, RouteDecision, RoutePlan, RunState, RunStepState } from "../domain/schemas.ts";
import { isUsableStepStatus } from "../runtime/status.ts";
import { buildIntentContract } from "./intent-contract.ts";
import { updateRecoveryState } from "./run-recovery.ts";
import { planStepsWithWorkUnits, refreshWorkUnitStatuses } from "./work-units.ts";

export type ChalinSessionContextLike = {
  sessionManager?: {
    getSessionFile?: () => string | undefined;
  };
};

export function createRunState(route: RouteDecision, cwd: string, rootTask?: string, metadata: { parentRunId?: string; parentStepId?: string; delegationDepth?: number; sessionId?: string } = {}): RunState {
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
    ...(metadata.sessionId ? { sessionId: metadata.sessionId } : {}),
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

export type RunContinuationKind = "none" | "resume" | "repair" | "synthesize-final";

export function prepareRunForResume(run: RunState): RunState {
  if (run.status === "failed" && !run.recoveryState?.failedStepId) {
    updateRecoveryState(run, firstFailedStep(run));
  }
  refreshPersistedBackgroundJobs(run);
  normalizeRunPlanForContinuation(run);
  const failedStepIdsToRetry = failedStepIdsForContinuation(run);
  run.status = "running";
  run.endedAt = undefined;
  const resumeWarning = `Resumed pi-chalin run ${run.id}.`;
  if (!run.warnings.includes(resumeWarning)) run.warnings = [...run.warnings, resumeWarning];
  for (const step of run.steps) {
    if (isUsableStepHandoff(step)) continue;
    if (step.status === "failed" && !failedStepIdsToRetry.has(step.id)) continue;
    step.status = "pending";
    step.error = undefined;
    step.skipReason = undefined;
    step.pauseReason = undefined;
    step.currentTool = undefined;
    step.endedAt = undefined;
  }
  clearStaleWorkUnitSkipMetadata(run);
  refreshWorkUnitStatuses(run);
  persistRun(run);
  return run;
}

function normalizeRunPlanForContinuation(run: RunState): void {
  const plan = run.route.plan;
  if (!plan || plan.kind !== "dag") return;
  const existingStageIds = new Set(plan.stages.map((stage) => stage.id));
  const missingStages = new Map<string, RunStepState[]>();
  for (const step of run.steps) {
    if (isUsableStepHandoff(step) || step.status === "skipped") continue;
    const existingStageId = step.stageId ?? stageIdFromStepId(step.id);
    if (existingStageId && existingStageIds.has(existingStageId)) {
      step.stageId ??= existingStageId;
      continue;
    }
    const stageId = existingStageId ?? `resume-${safeId(step.id)}`;
    step.stageId = stageId;
    const group = missingStages.get(stageId) ?? [];
    group.push(step);
    missingStages.set(stageId, group);
  }
  if (missingStages.size === 0) return;
  for (const [stageId, steps] of missingStages) {
    plan.stages.push({
      id: stageId,
      tasks: steps.map((step) => runStepToAgentStep(step, stageId)),
    });
  }
  run.route.kind = "multi-agent-dag";
  const warning = `Normalized ${missingStages.size} missing DAG stage(s) for pending resume step(s).`;
  if (!run.warnings.includes(warning)) run.warnings.push(warning);
}

function runStepToAgentStep(step: RunStepState, stageId: string): AgentStep {
  return {
    id: localStepId(step.id, stageId),
    agent: step.agent,
    task: step.task,
    ...(step.budget ? { budget: step.budget } : {}),
  };
}

function localStepId(stepId: string, stageId: string): string {
  const prefix = `${stageId}:`;
  return stepId.startsWith(prefix) ? stepId.slice(prefix.length) : stepId;
}

function stageIdFromStepId(stepId: string): string | undefined {
  const index = stepId.indexOf(":");
  return index > 0 ? stepId.slice(0, index) : undefined;
}

function safeId(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80) || "step";
}

function refreshPersistedBackgroundJobs(run: RunState): void {
  if (!run.logsPath) return;
  const jobsDir = path.resolve(path.dirname(run.logsPath), "..", "background-jobs");
  if (!fs.existsSync(jobsDir)) return;
  const jobs = fs.readdirSync(jobsDir)
    .filter((name) => name.endsWith(".json"))
    .flatMap((name) => readBackgroundJobRecord(path.join(jobsDir, name)));
  if (jobs.length === 0) return;
  const byId = new Map(jobs.map((job) => [String(job.id), job]));
  for (const step of run.steps) {
    step.backgroundJobs = (step.backgroundJobs ?? []).map((job) => {
      const persisted = byId.get(job.id);
      return persisted ? mergeBackgroundJobTrace(job, persisted) : job;
    });
  }
  for (const job of jobs) {
    const owner = isRecord(job.owner) ? job.owner : undefined;
    if (owner?.runId !== run.id || typeof owner.stepId !== "string") continue;
    const step = run.steps.find((candidate) => candidate.id === owner.stepId);
    if (!step) continue;
    const current = step.backgroundJobs ?? [];
    if (current.some((candidate) => candidate.id === job.id)) continue;
    step.backgroundJobs = [...current, backgroundJobTraceFromRecord(job)];
  }
}

function readBackgroundJobRecord(file: string): Record<string, unknown>[] {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf-8"));
    return isRecord(parsed) && typeof parsed.id === "string" ? [parsed] : [];
  } catch {
    return [];
  }
}

function mergeBackgroundJobTrace(current: NonNullable<RunStepState["backgroundJobs"]>[number], job: Record<string, unknown>): NonNullable<RunStepState["backgroundJobs"]>[number] {
  return {
    ...current,
    ...backgroundJobTraceFromRecord(job),
  };
}

function backgroundJobTraceFromRecord(job: Record<string, unknown>): NonNullable<RunStepState["backgroundJobs"]>[number] {
  return {
    id: String(job.id),
    command: typeof job.command === "string" ? job.command : "",
    status: backgroundJobStatus(job.status),
    cwd: typeof job.cwd === "string" ? job.cwd : "",
    outputLogPath: typeof job.outputLogPath === "string" ? job.outputLogPath : "",
    ...(job.requiredEvidence === true ? { requiredEvidence: true } : {}),
    ...(job.completionAction === "notify" || job.completionAction === "resume" || job.completionAction === "none" ? { completionAction: job.completionAction } : {}),
    ...(job.notifyOnCompletion === true ? { notifyOnCompletion: true } : {}),
    ...(typeof job.maxOutputBytes === "number" ? { maxOutputBytes: job.maxOutputBytes } : {}),
    ...(typeof job.startedAt === "string" ? { startedAt: job.startedAt } : {}),
    ...(typeof job.finishedAt === "string" ? { finishedAt: job.finishedAt } : {}),
    ...(typeof job.exitCode === "number" || job.exitCode === null ? { exitCode: job.exitCode } : {}),
    ...(typeof job.tail === "string" ? { tail: job.tail.slice(-4000) } : {}),
    ...(typeof job.error === "string" ? { error: job.error } : {}),
    ...(typeof job.staleReason === "string" ? { staleReason: job.staleReason } : {}),
  };
}

function backgroundJobStatus(value: unknown): NonNullable<RunStepState["backgroundJobs"]>[number]["status"] {
  const allowed = new Set(["queued", "running", "succeeded", "failed", "cancelled", "timed_out", "orphaned", "stale"]);
  return typeof value === "string" && allowed.has(value) ? value as NonNullable<RunStepState["backgroundJobs"]>[number]["status"] : "stale";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function markRunHumanInputAnswered(run: RunState): boolean {
  const wasBlocked = run.intentContract?.requiresInterview === true || run.recoveryState?.blockedByHumanInput === true;
  if (!wasBlocked) return false;

  if (run.intentContract?.requiresInterview === true) {
    delete run.intentContract.requiresInterview;
  }
  if (run.recoveryState?.blockedByHumanInput === true) {
    delete run.recoveryState.blockedByHumanInput;
    run.recoveryState.repairOptions = [];
  }
  clearAnsweredHumanInputHandoffs(run);
  updateRecoveryState(run);
  persistRun(run);
  return true;
}

function clearAnsweredHumanInputHandoffs(run: RunState): void {
  for (const step of run.steps) {
    const handoff = step.output?.structuredHandoff;
    if (!handoff?.requiresHumanInput) continue;
    handoff.requiresHumanInput = false;
    handoff.humanInputQuestions = [];
    step.output!.handoff = appendResolutionNote(step.output?.handoff);
    step.output!.text = appendResolutionNote(step.output?.text);
  }
}

function appendResolutionNote(value: string | undefined): string {
  const note = "Human input was answered; continue pending WorkUnits from this handoff.";
  if (!value?.trim()) return note;
  if (value.includes(note)) return value;
  return `${value}\n\n${note}`;
}

function clearStaleWorkUnitSkipMetadata(run: RunState): void {
  for (const unit of run.workUnits ?? []) {
    const unitSteps = run.steps.filter((step) => step.workUnitId === unit.id);
    if (unitSteps.length === 0) continue;
    if (unitSteps.some((step) => step.status === "skipped" || step.skipReason)) continue;
    if (unit.status === "skipped") unit.status = "pending";
    delete unit.skippedReason;
  }
}

export function loadResumableRunState(options: ChalinPathsOptions & { runId?: string; recoverStale?: boolean; sessionId?: string; includeCompleted?: boolean }): RunState | undefined {
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
      if (options.sessionId && parsed.sessionId !== options.sessionId) continue;
      if (isResumableRun(parsed, { includeCompleted: options.includeCompleted === true })) {
        parsed.logsPath ??= file;
        if (parsed.status === "running" && options.recoverStale !== false) {
          parsed.status = "paused";
          parsed.warnings = [...(parsed.warnings ?? []), "Recovered stale running run from disk after process shutdown."];
          updateRecoveryState(parsed);
          persistRun(parsed);
        } else if (parsed.status === "failed" || parsed.status === "paused") {
          updateRecoveryState(parsed, firstFailedStep(parsed));
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

export function chalinSessionIdFromContext(context: ChalinSessionContextLike | undefined): string | undefined {
  try {
    return chalinSessionIdFromFile(context?.sessionManager?.getSessionFile?.());
  } catch {
    return undefined;
  }
}

export function chalinSessionIdFromFile(file: string | undefined): string | undefined {
  if (!file?.trim()) return undefined;
  const resolved = path.resolve(file);
  const baseName = path.basename(resolved, path.extname(resolved))
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48) || "session";
  const hash = createHash("sha256").update(resolved).digest("hex").slice(0, 12);
  return `${baseName}-${hash}`;
}

export function persistRun(run: RunState): void {
  if (!run.logsPath) return;
  fs.mkdirSync(path.dirname(run.logsPath), { recursive: true });
  fs.writeFileSync(run.logsPath, `${JSON.stringify(run, null, 2)}\n`, "utf-8");
}

export function isUsableStepHandoff(step: Pick<RunStepState, "status">): boolean {
  return isUsableStepStatus(step.status);
}

export function continuationKindForRun(run: RunState, options: { includeCompleted?: boolean } = {}): RunContinuationKind {
  if (!run.route?.plan) return "none";
  if (run.status === "complete") return options.includeCompleted === true ? "synthesize-final" : "none";
  if (run.status === "failed") return hasUnfinishedWorkflowObligation(run) ? "repair" : "none";
  if (run.status === "paused" || run.status === "running") {
    if (hasUnfinishedWorkflowObligation(run)) return "resume";
    return run.status === "running" && run.steps.length > 0 && run.steps.every((step) => isUsableStepHandoff(step)) ? "resume" : "none";
  }
  return "none";
}

function isResumableRun(run: RunState, options: { includeCompleted?: boolean } = {}): boolean {
  return continuationKindForRun(run, options) !== "none";
}

function hasUnfinishedWorkflowObligation(run: RunState): boolean {
  if (run.intentContract?.requiresInterview || run.recoveryState?.blockedByHumanInput) return true;
  if (run.steps.some((step) => !isUsableStepHandoff(step))) return true;
  if ((run.workUnits ?? []).some((unit) => unit.status !== "complete" && unit.status !== "checkpointed")) return true;
  return run.steps.some((step) => (step.nestedRuns ?? []).some((nested) => nested.status !== "complete" && nested.status !== "stale-repaired"));
}

function failedStepIdsForContinuation(run: RunState): Set<string> {
  const ids = new Set<string>();
  if (run.recoveryState?.failedStepId) ids.add(run.recoveryState.failedStepId);
  for (const step of run.steps) {
    if (step.status !== "failed") continue;
    if (ids.size === 0) ids.add(step.id);
    const hasLaterRecoveryAttempt = run.steps.some((candidate) =>
      candidate !== step
      && step.workUnitId !== undefined
      && candidate.workUnitId === step.workUnitId
      && candidate.status !== "failed"
      && !isUsableStepHandoff(candidate)
    );
    if (hasLaterRecoveryAttempt) ids.delete(step.id);
  }
  return ids;
}

function firstFailedStep(run: RunState): RunStepState | undefined {
  return run.steps.find((step) => step.status === "failed");
}

function planAgentSteps(plan: RoutePlan): AgentStep[] {
  if (plan.kind === "sequential") return plan.steps;
  return plan.stages.flatMap((stage) => stage.tasks);
}
