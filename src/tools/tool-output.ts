import type { MemoryRecord } from "../domain/schemas.ts";
import { compactText } from "../utils/text.ts";

export function clampInteger(value: number, min: number, max: number): number {
  const parsed = Math.floor(Number(value));
  if (!Number.isFinite(parsed)) return min;
  return Math.min(max, Math.max(min, parsed));
}

export function clampNumber(value: number, min: number, max: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return min;
  return Math.min(max, Math.max(min, parsed));
}

export function isMemoryInventoryQuery(query: string): boolean {
  const normalized = query.toLowerCase();
  if (!normalized.trim()) return false;
  return [
    "how many",
    "how much",
    "memory count",
    "count memory",
    "list memory",
    "memory elements",
    "memory records",
    "what elements",
    "what do you have in memory",
    "what is in memory",
    "what's in memory",
  ].some((phrase) => normalized.includes(phrase));
}

export function formatMemoryInventory(
  records: MemoryRecord[],
  options: { total: number; omitted: number; status: string; includeEvidence: boolean },
): string {
  const header = `Memory inventory (${records.length}/${options.total} records${options.status !== "all" ? `, status=${options.status}` : ""}). Treat as guidance; current repo evidence wins.`;
  if (options.total === 0) return `${header}\nNo visible memory records found.`;
  return [
    header,
    ...records.map((record) => `- ${formatMemoryInventoryLine(record, options.includeEvidence)}`),
    options.omitted > 0 ? `- ${options.omitted} more record${options.omitted === 1 ? "" : "s"} omitted by limit.` : undefined,
  ].filter((line): line is string => Boolean(line)).join("\n");
}

export function truncateForTool(text: string, maxChars: number): string {
  return compactText(text, maxChars);
}

export function textResult(text: string, details: unknown) {
  return { content: [{ type: "text" as const, text }], details };
}

export function errorResult(text: string, details: unknown) {
  return { content: [{ type: "text" as const, text }], details, isError: true };
}

export function finalToolResult(ctx: { hasUI: boolean; abort(): void; shutdown(): void }, text: string, details: unknown) {
  scheduleNonInteractiveShutdown(ctx);
  return textResult(text, details);
}

function formatMemoryInventoryLine(record: MemoryRecord, includeEvidence: boolean): string {
  const meta = [
    record.id,
    record.status,
    record.category,
    record.scope,
    record.sourceAgent ? `source=${record.sourceAgent}` : undefined,
    record.topicKey ? `topic=${record.topicKey}` : undefined,
    record.revisionCount > 1 ? `rev=${record.revisionCount}` : undefined,
  ].filter(Boolean).join(" · ");
  const evidence = includeEvidence && record.evidence ? ` evidence=${truncateForTool(record.evidence, 120)}` : "";
  return `[${meta}] ${truncateForTool(record.content, 260)}${evidence}`;
}

export function shouldScheduleFinalToolShutdown(ctx: { hasUI: boolean; shutdown?: () => void }): boolean {
  return !ctx.hasUI && typeof ctx.shutdown === "function" && process.env.PI_CHALIN_NONINTERACTIVE_SHUTDOWN === "1";
}

function scheduleNonInteractiveShutdown(ctx: { hasUI: boolean; abort(): void; shutdown(): void }): void {
  if (!shouldScheduleFinalToolShutdown(ctx)) return;
  const configuredDelay = Number(process.env.PI_CHALIN_NONINTERACTIVE_SHUTDOWN_DELAY_MS);
  const delayMs = Number.isFinite(configuredDelay) && configuredDelay >= 0 ? configuredDelay : 0;
  const timer = setTimeout(() => {
    try {
      ctx.abort();
      ctx.shutdown();
    } catch {
      // Pi can mark extension contexts stale while a print-mode turn exits.
      // The tool result has already been emitted, so stale shutdown is safe to ignore.
    }
  }, delayMs);
  timer.unref?.();
}
