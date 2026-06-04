import * as fs from "node:fs";
import * as path from "node:path";
import { resolveChalinPaths, type ChalinPathsOptions } from "../config/paths.ts";
import type { RunRecoveryState, RunState, RunStepState } from "../domain/schemas.ts";
import { isUsableStepStatus } from "../runtime/status.ts";
import { refreshWorkUnitStatuses } from "./work-units.ts";

export interface FailedRunDiagnostic {
  run: RunState;
  failedStep?: RunStepState;
  message: string;
}

export function loadFailedRunDiagnostic(options: ChalinPathsOptions & { runId?: string; sessionId?: string }): FailedRunDiagnostic | undefined {
  for (const run of readRunsNewestFirst(options)) {
    if (options.runId && run.id !== options.runId) continue;
    if (options.sessionId && run.sessionId !== options.sessionId) continue;
    if (run.status !== "failed") continue;
    const failedStep = firstFailedStep(run);
    return {
      run,
      failedStep,
      message: formatFailedRunDiagnostic(run, failedStep),
    };
  }
  return undefined;
}

export function markBlockedDependentsSkipped(run: RunState, failedStep?: RunStepState): number {
  const blocker = failedStep ?? firstFailedStep(run);
  if (!blocker) return 0;
  return markDependentsSkipped(run, blocker, {
    reason: `Skipped because upstream ${blocker.agent}/${blocker.id} failed: ${blocker.error ?? "unknown failure"}.`,
    recovery: "failed",
  });
}

export function markHumanBlockedDependentsSkipped(run: RunState, blocker: RunStepState, questions: string[] = []): number {
  run.intentContract = {
    ...(run.intentContract ?? { originalPrompt: run.rootTask ?? run.route.reason, explicitConstraints: [], forbiddenPaths: [] }),
    requiresInterview: true,
  };
  run.recoveryState = {
    ...(run.recoveryState ?? { pendingUnits: [], reviewersNotRun: [], resumeKind: "none", repairOptions: [] }),
    blockedByHumanInput: true,
  };
  const reason = questions.length
    ? `Skipped because upstream ${blocker.agent}/${blocker.id} requires human input: ${questions.join("; ")}.`
    : `Skipped because upstream ${blocker.agent}/${blocker.id} requires human input before safe continuation.`;
  return markDependentsSkipped(run, blocker, { reason, recovery: "human-input", questions });
}

function markDependentsSkipped(run: RunState, blocker: RunStepState, options: { reason: string; recovery: "failed" | "human-input"; questions?: string[] }): number {
  const blockerIndex = run.steps.indexOf(blocker);
  const hasExplicitDependencies = run.steps.some((step) => (step.dependencies?.length ?? 0) > 0);
  let skipped = 0;
  const reviewersNotRun: string[] = [];
  for (let index = 0; index < run.steps.length; index += 1) {
    const step = run.steps[index]!;
    if (step.status !== "pending") continue;
    const dependsOnBlocker = stepDependsOn(run, step, blocker.id) || (!hasExplicitDependencies && run.route.plan?.kind !== "dag" && blockerIndex >= 0 && index > blockerIndex);
    if (!dependsOnBlocker) continue;
    step.status = "skipped";
    step.skipReason = options.reason;
    step.endedAt = new Date().toISOString();
    if (stepIsReviewWork(run, step)) reviewersNotRun.push(step.id);
    skipped += 1;
  }
  if (options.recovery === "human-input") {
    run.recoveryState = {
      ...(run.recoveryState ?? { pendingUnits: [], reviewersNotRun: [], resumeKind: "none", repairOptions: [] }),
      blockedByHumanInput: true,
      repairOptions: [...new Set([
        ...(run.recoveryState?.repairOptions ?? []),
        ...(options.questions?.length ? options.questions : ["Ask the user the blocking question(s), then rerun or resume with the chosen scope."]),
      ])],
    };
    updateRecoveryState(run, undefined, reviewersNotRun);
  } else {
    updateRecoveryState(run, blocker, reviewersNotRun);
  }
  refreshWorkUnitStatuses(run);
  return skipped;
}

function stepDependsOn(run: RunState, step: RunStepState, dependencyId: string, visited = new Set<string>()): boolean {
  const dependencies = step.dependencies ?? [];
  if (dependencies.includes(dependencyId)) return true;
  for (const id of dependencies) {
    if (visited.has(id)) continue;
    visited.add(id);
    const dependency = run.steps.find((candidate) => candidate.id === id);
    if (dependency && stepDependsOn(run, dependency, dependencyId, visited)) return true;
  }
  return false;
}

function stepIsReviewWork(run: RunState, step: RunStepState): boolean {
  const unit = step.workUnitId ? run.workUnits?.find((candidate) => candidate.id === step.workUnitId) : undefined;
  if (unit) return unit.kind === "review";
  return step.agent === "reviewer";
}

function findRouteStep(run: RunState, step: RunStepState): { id?: string; agent: string; task: string; expectedEffects?: string[] } | undefined {
  const plan = run.route.plan;
  if (!plan) return undefined;
  if (plan.kind === "sequential") {
    return plan.steps.find((candidate, index) => candidate.agent === step.agent && (candidate.id === step.id || `step-${index + 1}` === step.id));
  }
  for (const stage of plan.stages) {
    if (!step.id.startsWith(`${stage.id}:`)) continue;
    const localId = step.id.split(":").at(-1);
    return stage.tasks.find((candidate, index) => candidate.agent === step.agent && (candidate.id === localId || `step-${index + 1}` === localId));
  }
  return undefined;
}

export function updateRecoveryState(run: RunState, failedStep?: RunStepState, reviewersNotRun: string[] = []): RunRecoveryState {
  const blocker = failedStep ?? firstFailedStep(run);
  const pendingUnits = (run.workUnits ?? []).filter((unit) => unit.status === "pending").map((unit) => unit.id);
  const existingReviewersNotRun = run.recoveryState?.reviewersNotRun ?? [];
  const baseRepairOptions = repairOptionsFor(run, blocker);
  const repairOptions = run.recoveryState?.blockedByHumanInput
    ? [...new Set([...(run.recoveryState.repairOptions ?? []), ...baseRepairOptions])]
    : baseRepairOptions;
  const recovery: RunRecoveryState = {
    failedUnitId: blocker?.workUnitId,
    failedStepId: blocker?.id,
    failedReason: blocker?.error,
    pendingUnits,
    reviewersNotRun: [...new Set([...existingReviewersNotRun, ...reviewersNotRun])],
    resumeKind: run.status === "paused" ? "resume" : blocker ? "repair" : "none",
    repairOptions,
    ...(run.recoveryState?.blockedByHumanInput ? { blockedByHumanInput: true } : {}),
  };
  run.recoveryState = recovery;
  run.observabilitySummary = {
    workUnits: run.workUnits?.length ?? 0,
    skippedSteps: run.steps.filter((step) => step.status === "skipped").length,
    failedStepId: recovery.failedStepId,
    failedUnitId: recovery.failedUnitId,
    reviewersNotRun: recovery.reviewersNotRun.length,
    mutationEntries: run.mutationLedger?.length ?? 0,
    verificationEntries: run.verificationLedger?.length ?? 0,
    repairOptions,
  };
  return recovery;
}

export function formatFailedRunDiagnostic(run: RunState, failedStep = firstFailedStep(run)): string {
  const lines = [
    `No resumable pi-chalin run found. Latest matching run failed: ${run.id}.`,
    failedStep ? `failed step: ${failedStep.agent}/${failedStep.id}` : undefined,
    failedStep?.workUnitId ? `failed unit: ${failedStep.workUnitId}` : undefined,
    failedStep?.error ? `reason: ${failedStep.error}` : undefined,
    run.logsPath ? `log: ${run.logsPath}` : undefined,
    `repair options: ${repairOptionsFor(run, failedStep).join("; ")}`,
  ];
  return lines.filter((line): line is string => Boolean(line)).join("\n");
}

export function repairOptionsFor(run: RunState, failedStep?: RunStepState): string[] {
  if (run.intentContract?.requiresInterview || run.recoveryState?.blockedByHumanInput) return ["Ask the user the blocking interview questions, then rerun the route."];
  if (!failedStep) return ["Start a new routed run with clearer scope."];
  const effects = expectedEffectsForStep(run, failedStep);
  if (effects.includes("write")) return ["Run a mutation repair route from the failed step.", "Retry the failed work unit after fixing the handoff contract."];
  if (effects.includes("verify")) return ["Run an implementation repair route from the verification findings.", "Retry verification after adding missing evidence."];
  return ["Retry the failed step with a narrower work unit.", "Rerun the workflow from the last usable handoff."];
}

function expectedEffectsForStep(run: RunState, step: RunStepState): string[] {
  const unit = step.workUnitId ? run.workUnits?.find((candidate) => candidate.id === step.workUnitId) : undefined;
  if (unit?.expectedEffects.length) return unit.expectedEffects;
  const routeStep = findRouteStep(run, step);
  if (routeStep?.expectedEffects?.length) return routeStep.expectedEffects;
  return run.route.expectedEffects ?? ["read"];
}

function readRunsNewestFirst(options: ChalinPathsOptions): RunState[] {
  const runsDir = path.join(resolveChalinPaths(options).projectRoot, ".pi-chalin", "runs");
  if (!fs.existsSync(runsDir)) return [];
  return fs.readdirSync(runsDir)
    .filter((name) => name.endsWith(".json"))
    .map((name) => path.join(runsDir, name))
    .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)
    .flatMap((file) => {
      try {
        const parsed = JSON.parse(fs.readFileSync(file, "utf-8")) as RunState;
        parsed.logsPath ??= file;
        return [parsed];
      } catch {
        return [];
      }
    });
}

function firstFailedStep(run: RunState): RunStepState | undefined {
  return run.steps.find((step) => step.status === "failed") ?? run.steps.find((step) => !isUsableStepStatus(step.status) && step.error);
}
