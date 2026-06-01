export type TokenomicsPhase =
  | "orchestratorPrompt"
  | "roster"
  | "childPrompt"
  | "memory"
  | "toolOutputs"
  | "handoff"
  | "reviewer"
  | "repair"
  | "finalSynthesis";

export interface PhaseTokenEstimate {
  estimatedChars: number;
  estimatedTokens: number;
}

export interface TokenomicsSummary {
  phases: Record<TokenomicsPhase, PhaseTokenEstimate>;
  totalEstimatedChars: number;
  totalEstimatedTokens: number;
}

export type StructuredTraceSpanKind =
  | "run"
  | "stage"
  | "step"
  | "prompt-build"
  | "memory-read"
  | "tool-call"
  | "verification"
  | "handoff"
  | "review"
  | "repair";

export interface StructuredTraceSpan {
  id: string;
  parentId?: string;
  name: string;
  kind: StructuredTraceSpanKind;
  startedAt: number;
  endedAt?: number;
  durationMs?: number;
  attributes?: Record<string, string | number | boolean>;
}

export type SkillEventType =
  | "skill.catalog.loaded"
  | "skill.match.started"
  | "skill.match.result"
  | "skill.activation.applied"
  | "skill.activation.rejected"
  | "skill.audit.result"
  | "skill.lifecycle.changed"
  | "skill.outcome.recorded"
  | "skill.stale.detected"
  | "skill.promoted";

export interface SkillTraceEvent {
  type: SkillEventType;
  at: string;
  skill?: string;
  scope?: string;
  trust?: string;
  policy?: string;
  stepId?: string;
  agent?: string;
  reason?: string;
  metadata?: Record<string, string | number | boolean>;
}

export function createSkillTraceEvent(input: Omit<SkillTraceEvent, "at"> & { at?: string }): SkillTraceEvent {
  return {
    ...input,
    at: input.at ?? new Date().toISOString(),
  };
}

export function buildPromptTokenomics(input: Partial<Record<TokenomicsPhase, string>>): TokenomicsSummary {
  const phases = Object.fromEntries(tokenomicsPhases.map((phase) => {
    const text = input[phase] ?? "";
    const estimatedChars = text.length;
    return [phase, { estimatedChars, estimatedTokens: estimateTokens(text) }];
  })) as Record<TokenomicsPhase, PhaseTokenEstimate>;
  const totalEstimatedChars = Object.values(phases).reduce((sum, phase) => sum + phase.estimatedChars, 0);
  const totalEstimatedTokens = Object.values(phases).reduce((sum, phase) => sum + phase.estimatedTokens, 0);
  return { phases, totalEstimatedChars, totalEstimatedTokens };
}

export function createStructuredSpan(input: {
  id: string;
  parentId?: string;
  name: string;
  kind: StructuredTraceSpanKind;
  startedAt: number;
  endedAt?: number;
  attributes?: Record<string, unknown>;
}): StructuredTraceSpan {
  const durationMs = input.endedAt === undefined ? undefined : Math.max(0, input.endedAt - input.startedAt);
  const attributes = compactAttributes(input.attributes);
  return {
    id: input.id,
    ...(input.parentId ? { parentId: input.parentId } : {}),
    name: input.name,
    kind: input.kind,
    startedAt: input.startedAt,
    ...(input.endedAt !== undefined ? { endedAt: input.endedAt } : {}),
    ...(durationMs !== undefined ? { durationMs } : {}),
    ...(Object.keys(attributes).length ? { attributes } : {}),
  };
}

export function mergeTraceSpans(...groups: Array<StructuredTraceSpan[] | undefined>): StructuredTraceSpan[] {
  const merged: StructuredTraceSpan[] = [];
  const seen = new Set<string>();
  for (const group of groups) {
    for (const span of group ?? []) {
      if (seen.has(span.id)) continue;
      seen.add(span.id);
      merged.push(span);
    }
  }
  return merged.slice(0, 200);
}

function estimateTokens(text: string): number {
  if (!text.trim()) return 0;
  return Math.max(1, Math.ceil(text.length / 4));
}

function compactAttributes(attributes: Record<string, unknown> | undefined): Record<string, string | number | boolean> {
  const compact: Record<string, string | number | boolean> = {};
  for (const [key, value] of Object.entries(attributes ?? {})) {
    if (value === undefined || value === null) continue;
    if (typeof value === "string") compact[key] = value.length > 500 ? `${value.slice(0, 497)}...` : value;
    else if (typeof value === "number" && Number.isFinite(value)) compact[key] = value;
    else if (typeof value === "boolean") compact[key] = value;
  }
  return compact;
}

const tokenomicsPhases: TokenomicsPhase[] = [
  "orchestratorPrompt",
  "roster",
  "childPrompt",
  "memory",
  "toolOutputs",
  "handoff",
  "reviewer",
  "repair",
  "finalSynthesis",
];
