import type { InlineToolEvent } from "./inline-policy.ts";

export type EvidenceStatus = "pass" | "fail" | "pending";

export interface EvidenceCommandRecord {
  command: string;
  status: EvidenceStatus;
  afterLatestMutation: boolean;
}

export interface EvidenceMutationRecord {
  toolName: "edit" | "write";
  status: EvidenceStatus;
  afterFailedCommand: boolean;
  path?: string;
  args?: string;
  observation?: string;
}

export interface EvidenceObservationRecord {
  toolName: string;
  status: EvidenceStatus;
  afterLatestMutation: boolean;
  text: string;
  command?: string;
  path?: string;
}

export interface EvidenceLedger {
  changedPaths: string[];
  readPaths: string[];
  mutationRecords: EvidenceMutationRecord[];
  commandRecords: EvidenceCommandRecord[];
  failedCommandsAfterMutation: EvidenceCommandRecord[];
  failedPostMutationCommands: EvidenceCommandRecord[];
  postFailureMutationRecords: EvidenceMutationRecord[];
  observations: EvidenceObservationRecord[];
  evidenceAfterLatestMutation: boolean;
  latestMutationIndex?: number;
}

const MAX_OBSERVATION_CHARS = 4_000;
const TRUNCATION_MARKER = "\n... observation compacted; full output remains in the Pi session trace ...\n";

export function buildEvidenceLedger(events: readonly InlineToolEvent[]): EvidenceLedger {
  const completed = events.filter((event) => event.phase === "completed");
  const latestMutationIndex = latestMutationEventIndex(completed);
  const changedPaths = new Set<string>();
  const readPaths = new Set<string>();
  const mutationRecords: EvidenceMutationRecord[] = [];
  const commandRecords: EvidenceCommandRecord[] = [];
  const failedCommandsAfterMutation: EvidenceCommandRecord[] = [];
  const observations: EvidenceObservationRecord[] = [];
  let mutationSeen = false;
  let failedCommandAfterMutationSeen = false;

  completed.forEach((event, index) => {
    const afterLatestMutation = latestMutationIndex !== undefined && index > latestMutationIndex;
    const observation = compactEvidenceObservation(event.observation);
    if (observation) {
      const status = evidenceStatusForEvent(event);
      observations.push({
        toolName: event.toolName,
        status,
        afterLatestMutation,
        text: observation,
        ...(event.command ? { command: event.command.trim() } : {}),
        ...(event.path ? { path: normalizeWorkflowPath(event.path) } : {}),
      });
    }
    if (event.toolName === "edit" || event.toolName === "write") {
      const changedPath = normalizeWorkflowPath(event.path ?? extractPathFromArgsText(event.argsText) ?? "");
      const args = compactEvidenceObservation(event.argsText);
      mutationRecords.push({
        toolName: event.toolName,
        status: event.isError ? "fail" : "pass",
        afterFailedCommand: failedCommandAfterMutationSeen,
        ...(changedPath ? { path: changedPath } : {}),
        ...(args ? { args } : {}),
        ...(observation ? { observation } : {}),
      });
      if (event.isError) return;
      mutationSeen = true;
      if (changedPath) changedPaths.add(changedPath);
      return;
    }
    if (event.toolName === "read" && event.path && !event.isError) {
      readPaths.add(normalizeWorkflowPath(event.path));
      return;
    }
    if ((event.toolName === "bash" || event.toolName === "chalin_bash_job") && event.command && !isPendingBackgroundJobEvent(event)) {
      const commandRecord = {
        command: event.command.trim(),
        status: event.isError ? "fail" : "pass",
        afterLatestMutation,
      } satisfies EvidenceCommandRecord;
      commandRecords.push(commandRecord);
      if (event.isError && mutationSeen) {
        failedCommandsAfterMutation.push(commandRecord);
        failedCommandAfterMutationSeen = true;
      }
    }
  });

  const failedPostMutationCommands = commandRecords.filter((record) => record.afterLatestMutation && record.status === "fail");
  const postFailureMutationRecords = mutationRecords.filter((record) => record.status === "pass" && record.afterFailedCommand);
  return {
    changedPaths: [...changedPaths].sort(),
    readPaths: [...readPaths].sort(),
    mutationRecords,
    commandRecords,
    failedCommandsAfterMutation,
    failedPostMutationCommands,
    postFailureMutationRecords,
    observations,
    evidenceAfterLatestMutation: commandRecords.some((record) => record.afterLatestMutation) || completed.some((event, index) => {
      if (latestMutationIndex === undefined || index <= latestMutationIndex || event.isError) return false;
      if (isPendingBackgroundJobEvent(event)) return false;
      return event.toolName !== "edit" && event.toolName !== "write";
    }),
    ...(latestMutationIndex !== undefined ? { latestMutationIndex } : {}),
  };
}

function evidenceStatusForEvent(event: InlineToolEvent): EvidenceStatus {
  if (isPendingBackgroundJobEvent(event)) return "pending";
  return event.isError ? "fail" : "pass";
}

function isPendingBackgroundJobEvent(event: InlineToolEvent): boolean {
  return event.toolName === "chalin_bash_job"
    && (event.backgroundJobStatus === "queued" || event.backgroundJobStatus === "running");
}

export function compactEvidenceObservation(value: unknown, maxLength = MAX_OBSERVATION_CHARS): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = trimLineNoise(value);
  if (!trimmed) return undefined;
  if (trimmed.length <= maxLength) return trimmed;
  const marker = TRUNCATION_MARKER;
  if (maxLength <= marker.length + 2) return trimmed.slice(0, maxLength);
  const headLength = Math.floor((maxLength - marker.length) * 0.65);
  const tailLength = maxLength - marker.length - headLength;
  return `${trimmed.slice(0, headLength)}${marker}${trimmed.slice(trimmed.length - tailLength)}`;
}

function latestMutationEventIndex(events: readonly InlineToolEvent[]): number | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (!event || event.isError) continue;
    if (event.toolName === "edit" || event.toolName === "write") return index;
  }
  return undefined;
}

function trimLineNoise(value: string): string {
  const lines = value.split("\n");
  const normalized: string[] = [];
  let blankOpen = false;
  for (const rawLine of lines) {
    const line = rawLine.trimEnd();
    if (line.trim().length === 0) {
      if (!blankOpen) normalized.push("");
      blankOpen = true;
      continue;
    }
    blankOpen = false;
    normalized.push(line);
  }
  return normalized.join("\n").trim();
}

function extractPathFromArgsText(argsText: string | undefined): string | undefined {
  if (!argsText) return undefined;
  try {
    const parsed = JSON.parse(argsText) as { path?: unknown; filePath?: unknown; file?: unknown };
    for (const value of [parsed.path, parsed.filePath, parsed.file]) {
      if (typeof value === "string" && value.trim()) return value;
    }
  } catch {
    return undefined;
  }
  return undefined;
}

function normalizeWorkflowPath(value: string): string {
  let normalized = value.replaceAll("\\", "/").trim();
  while (normalized.startsWith("./")) normalized = normalized.slice(2);
  while (normalized.startsWith("../")) normalized = normalized.slice(3);
  return normalized;
}
