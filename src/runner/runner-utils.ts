export { isRecord } from "../utils/guards.ts";

export function truncateText(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

export function compactHandoffText(text: string, max = 240): string {
  const trimmed = text.trim();
  if (trimmed.length <= max) return trimmed;
  const colon = trimmed.indexOf(":");
  if (colon > 0 && colon < 60) {
    const prefix = trimmed.slice(0, colon + 1);
    const compacted = compactDelimitedTail(prefix, trimmed.slice(colon + 1), max);
    if (compacted) return compacted;
  }
  return truncateText(trimmed, max);
}

export function compactHandoffItems(items: readonly string[], options: { itemLimit?: number; itemMax?: number } = {}): string {
  const itemLimit = options.itemLimit ?? 8;
  const itemMax = options.itemMax ?? 220;
  const values = items.map((item) => compactHandoffText(item, itemMax)).filter(Boolean);
  const shown = values.slice(0, itemLimit).join("; ");
  return values.length > itemLimit ? `${shown}; +${values.length - itemLimit} more` : shown;
}

function compactDelimitedTail(prefix: string, tail: string, max: number): string | undefined {
  const parts = tail
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
  if (parts.length < 4) return undefined;
  const shown: string[] = [];
  for (const part of parts) {
    const candidate = `${prefix} ${shown.concat(part).join(", ")}; +${parts.length - shown.length - 1} more`;
    if (candidate.length > max && shown.length > 0) break;
    shown.push(part);
  }
  if (shown.length === parts.length) return undefined;
  return `${prefix} ${shown.join(", ")}; +${parts.length - shown.length} more`;
}

export function handoffBudgetChars(agent?: string): number {
  const parsed = Number(process.env.PI_CHALIN_HANDOFF_BUDGET_CHARS);
  if (Number.isFinite(parsed) && parsed > 200) return parsed;
  return agent === "scout" || agent === "context-builder" ? 2200 : 1200;
}

export function rawOutputBudgetChars(): number {
  const parsed = Number(process.env.PI_CHALIN_RAW_OUTPUT_BUDGET_CHARS);
  return Number.isFinite(parsed) && parsed > 500 ? parsed : 6000;
}

export function memoryCandidateBudget(): number {
  const parsed = Number(process.env.PI_CHALIN_MEMORY_CANDIDATE_BUDGET);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 3;
}
