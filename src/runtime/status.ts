import type { CheckpointInfo, RunMetricsCheckpoint, RunStepState, RunStepStatus } from "../domain/schemas.ts";

export function isCheckpointStepStatus(status: RunStepStatus | string | undefined): boolean {
  return status === "checkpointed";
}

export function isUsableStepStatus(status: RunStepStatus | undefined): boolean {
  return status === "complete" || isCheckpointStepStatus(status);
}

export function checkpointLabel(checkpoint: CheckpointInfo | undefined): string {
  if (!checkpoint) return "checkpointed";
  if (checkpoint.kind === "low-signal") return "checkpointed · low signal";
  if (checkpoint.kind === "awaiting-review") return "checkpointed · awaiting review";
  if (checkpoint.kind === "split-recommended") return "checkpointed · split recommended";
  if (checkpoint.kind === "handoff-contract") return "checkpointed · handoff contract";
  return "checkpointed · needs continuation";
}

export function checkpointSummary(steps: readonly RunStepState[]): RunMetricsCheckpoint | undefined {
  const checkpointed = steps.filter((step) => isCheckpointStepStatus(step.status));
  if (checkpointed.length === 0) return undefined;
  const kinds: RunMetricsCheckpoint["kinds"] = {};
  for (const step of checkpointed) {
    const kind = step.checkpoint?.kind ?? "needs-continuation";
    kinds[kind] = (kinds[kind] ?? 0) + 1;
  }
  return { steps: checkpointed.length, kinds };
}
