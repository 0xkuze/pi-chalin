import type { CheckpointInfo, RunMetricsCheckpoint, RunState, RunStepState, RunStepStatus } from "./schemas.ts";

export function isCheckpointStepStatus(status: RunStepStatus | string | undefined): boolean {
  return status === "checkpointed";
}

export function isUsableStepStatus(status: RunStepStatus | undefined): boolean {
  return status === "complete" || isCheckpointStepStatus(status);
}

export function checkpointLabel(checkpoint: CheckpointInfo | undefined): string {
  if (!checkpoint) return "checkpointed";
  if (checkpoint.kind === "budget-cap") return "checkpointed · budget limit reached";
  if (checkpoint.kind === "low-signal") return "checkpointed · low signal";
  if (checkpoint.kind === "awaiting-review") return "checkpointed · awaiting review";
  if (checkpoint.kind === "split-recommended") return "checkpointed · split recommended";
  if (checkpoint.kind === "handoff-contract") return "checkpointed · handoff contract";
  return "checkpointed · needs continuation";
}

export function checkpointFromLegacyBudgetCap(reason = "Legacy budget-capped run migrated on read."): CheckpointInfo {
  return { kind: "budget-cap", continuation: "continue", reason, legacyStatus: "budget-capped" };
}

export function normalizeLegacyBudgetCappedRun<T extends RunState>(run: T): T {
  let changed = false;
  if ((run.status as string) === "budget-capped") {
    run.status = "paused";
    changed = true;
  }
  for (const step of run.steps) {
    if ((step.status as string) === "budget-capped") {
      step.status = "checkpointed";
      step.checkpoint ??= checkpointFromLegacyBudgetCap("legacy budget-capped step status");
      changed = true;
    }
  }
  if (changed) {
    run.schemaVersion ??= 2;
    run.warnings = [...(run.warnings ?? []), "Migrated legacy budget-capped status to checkpointed state."];
  }
  return run;
}

export function checkpointSummary(steps: readonly RunStepState[]): RunMetricsCheckpoint | undefined {
  const checkpointed = steps.filter((step) => isCheckpointStepStatus(step.status));
  if (checkpointed.length === 0) return undefined;
  const kinds: RunMetricsCheckpoint["kinds"] = {};
  for (const step of checkpointed) {
    const kind = step.checkpoint?.kind ?? "budget-cap";
    kinds[kind] = (kinds[kind] ?? 0) + 1;
  }
  return { steps: checkpointed.length, kinds };
}
