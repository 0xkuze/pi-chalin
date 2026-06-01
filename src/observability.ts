import type { RoutePlan, RunState, RunStepState } from "./schemas.ts";
import { isCheckpointStepStatus } from "./status.ts";

export type TokenomicsPhase =
  | "orchestratorPrompt"
  | "roster"
  | "childPrompt"
  | "memory"
  | "toolOutputs"
  | "webContextFetch"
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
  | "repair"
  | "checkpoint"
  | "interview"
  | "webfetch";

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

export type TrajectoryEventType =
  | "routing.decision"
  | "policy.decision"
  | "policy.nudge"
  | "verifier.result"
  | "reviewer.verdict"
  | "repair.decision";

export interface TrajectoryEvent {
  type: TrajectoryEventType;
  at: string;
  runId?: string;
  stepId?: string;
  agent?: string;
  decision?: string;
  reason?: string;
  confidence?: number;
  blockingGap?: boolean;
  metadata?: Record<string, string | number | boolean>;
}

export function createSkillTraceEvent(input: Omit<SkillTraceEvent, "at"> & { at?: string }): SkillTraceEvent {
  return {
    ...input,
    at: input.at ?? new Date().toISOString(),
  };
}

export function createTrajectoryEvent(input: Omit<TrajectoryEvent, "at"> & { at?: string }): TrajectoryEvent {
  return {
    ...input,
    at: input.at ?? new Date().toISOString(),
    metadata: compactAttributes(input.metadata),
  };
}

export function mergeTrajectoryEvents(...groups: Array<TrajectoryEvent[] | undefined>): TrajectoryEvent[] {
  const merged: TrajectoryEvent[] = [];
  const seen = new Set<string>();
  for (const group of groups) {
    for (const event of group ?? []) {
      const key = [
        event.type,
        event.at,
        event.runId ?? "",
        event.stepId ?? "",
        event.agent ?? "",
        event.decision ?? "",
        event.reason ?? "",
      ].join("\0");
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push({ ...event, metadata: compactAttributes(event.metadata) });
    }
  }
  return merged.slice(0, 300);
}

export function buildPromptTokenomics(input: Partial<Record<TokenomicsPhase, string>>): TokenomicsSummary {
  return buildTokenomicsFromCharCounts(Object.fromEntries(Object.entries(input).map(([phase, text]) => [phase, promptPhaseChars(text)])) as Partial<Record<TokenomicsPhase, number>>);
}

export function buildTokenomicsFromCharCounts(input: Partial<Record<TokenomicsPhase, number>>): TokenomicsSummary {
  const phases = Object.fromEntries(tokenomicsPhases.map((phase) => {
    const estimatedChars = Math.max(0, Math.floor(input[phase] ?? 0));
    return [phase, { estimatedChars, estimatedTokens: estimateTokensFromChars(estimatedChars) }];
  })) as Record<TokenomicsPhase, PhaseTokenEstimate>;
  const totalEstimatedChars = Object.values(phases).reduce((sum, phase) => sum + phase.estimatedChars, 0);
  const totalEstimatedTokens = Object.values(phases).reduce((sum, phase) => sum + phase.estimatedTokens, 0);
  return { phases, totalEstimatedChars, totalEstimatedTokens };
}

export function buildToolOutputTokenomics(outputChars: number, outputCharsByToolName: Record<string, number> = {}): TokenomicsSummary | undefined {
  const safeOutputChars = Math.max(0, Math.floor(outputChars));
  const webContextFetchChars = Math.max(0, Math.floor(outputCharsByToolName.chalin_web_search ?? 0));
  if (safeOutputChars <= 0 && webContextFetchChars <= 0) return undefined;
  return buildTokenomicsFromCharCounts({
    toolOutputs: Math.max(0, safeOutputChars - webContextFetchChars),
    webContextFetch: webContextFetchChars,
  });
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
    name: redactTraceAttribute("name", input.name),
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
      const sanitized = sanitizeTraceSpan(span);
      if (seen.has(sanitized.id)) continue;
      seen.add(sanitized.id);
      merged.push(sanitized);
    }
  }
  return merged.slice(0, 200);
}

export function redactTraceAttribute(key: string, value: string): string {
  const lowerKey = key.toLowerCase();
  if (/(?:token|secret|api[_-]?key|authorization|password|credential|cookie)/i.test(lowerKey)) return "[REDACTED]";
  let redacted = value
    .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, "[REDACTED]")
    .replace(/\b(api[_-]?key|access[_-]?token|token|secret|password)=([^&\s]+)/gi, "$1=[REDACTED]")
    .replace(/\b(Bearer\s+)[A-Za-z0-9._~+/=-]{8,}\b/gi, "$1[REDACTED]");
  try {
    const parsed = new URL(redacted);
    const sensitiveKeys = ["api_key", "apikey", "key", "token", "access_token", "secret", "password"];
    let changed = false;
    for (const param of sensitiveKeys) {
      if (!parsed.searchParams.has(param)) continue;
      parsed.searchParams.set(param, "[REDACTED]");
      changed = true;
    }
    if (parsed.username || parsed.password) {
      parsed.username = parsed.username ? "[REDACTED]" : "";
      parsed.password = "";
      changed = true;
    }
    if (changed) redacted = parsed.toString();
  } catch {
    // Non-URL values still receive token-like redaction above.
  }
  return redacted;
}

export function buildRunLifecycleSpans(run: Pick<RunState, "id" | "route" | "rootTask" | "status" | "startedAt" | "endedAt" | "warnings" | "steps">): StructuredTraceSpan[] {
  const startedAt = timestampMs(run.startedAt) ?? Date.now();
  const endedAt = timestampMs(run.endedAt) ?? Math.max(startedAt, ...run.steps.map((step) => timestampMs(step.endedAt) ?? startedAt));
  const spans: StructuredTraceSpan[] = [
    createStructuredSpan({
      id: `${run.id}:run`,
      name: run.route.kind,
      kind: "run",
      startedAt,
      endedAt,
      attributes: {
        routeKind: run.route.kind,
        status: run.status,
        risk: run.route.risk,
        ambiguity: run.route.ambiguity,
        agents: run.route.agents.join(","),
        needsArtifacts: run.route.needsArtifacts,
        rootTask: run.rootTask,
      },
    }),
  ];
  spans.push(...stageLifecycleSpans(run.id, run.route.plan, run.steps, startedAt, endedAt));
  for (const step of run.steps) {
    const stepStartedAt = timestampMs(step.startedAt) ?? startedAt;
    const stepEndedAt = timestampMs(step.endedAt) ?? stepStartedAt + Math.max(0, step.metrics?.durationMs ?? 0);
    if (step.output?.handoff || step.output?.text || isCheckpointStepStatus(step.status)) {
      spans.push(createStructuredSpan({
        id: `${run.id}:${step.id}:handoff`,
        parentId: `${run.id}:${step.id}:step`,
        name: `${step.agent} handoff`,
        kind: "handoff",
        startedAt: stepEndedAt,
        endedAt: stepEndedAt,
        attributes: { agent: step.agent, status: step.status, checkpointed: isCheckpointStepStatus(step.status) },
      }));
    }
    if (step.agent === "reviewer") {
      spans.push(createStructuredSpan({
        id: `${run.id}:${step.id}:review`,
        parentId: `${run.id}:${step.id}:step`,
        name: "review gate",
        kind: "review",
        startedAt: stepStartedAt,
        endedAt: stepEndedAt,
        attributes: { status: step.status },
      }));
    }
    if (step.id.includes("review-repair") || /repair/i.test(step.task)) {
      spans.push(createStructuredSpan({
        id: `${run.id}:${step.id}:repair`,
        parentId: `${run.id}:run`,
        name: "implementation review repair",
        kind: "repair",
        startedAt: stepStartedAt,
        endedAt: stepEndedAt,
        attributes: { agent: step.agent, status: step.status },
      }));
    }
    if (isCheckpointStepStatus(step.status) || step.metrics?.budgetStopCount) {
      spans.push(createStructuredSpan({
        id: `${run.id}:${step.id}:checkpoint`,
        parentId: `${run.id}:${step.id}:step`,
        name: "budget checkpoint",
        kind: "checkpoint",
        startedAt: stepEndedAt,
        endedAt: stepEndedAt,
        attributes: { budgetStopCount: step.metrics?.budgetStopCount ?? 0 },
      }));
    }
    if ((step.metrics?.toolCallsByName.chalin_web_search ?? 0) > 0) {
      spans.push(createStructuredSpan({
        id: `${run.id}:${step.id}:webfetch`,
        parentId: `${run.id}:${step.id}:step`,
        name: "chalin_web_search",
        kind: "webfetch",
        startedAt: stepStartedAt,
        endedAt: stepEndedAt,
        attributes: { toolCalls: step.metrics?.toolCallsByName.chalin_web_search ?? 0 },
      }));
    }
    if ((step.metrics?.toolCallsByName.chalin_interview ?? 0) > 0) {
      spans.push(createStructuredSpan({
        id: `${run.id}:${step.id}:interview`,
        parentId: `${run.id}:${step.id}:step`,
        name: "chalin_interview",
        kind: "interview",
        startedAt: stepStartedAt,
        endedAt: stepEndedAt,
        attributes: { toolCalls: step.metrics?.toolCallsByName.chalin_interview ?? 0 },
      }));
    }
  }
  const existingSpans = run.steps.flatMap((step) => step.metrics?.spans ?? []);
  return mergeTraceSpans(spans, existingSpans);
}

function estimateTokens(text: string): number {
  if (!text.trim()) return 0;
  return Math.max(1, Math.ceil(text.length / 4));
}

function promptPhaseChars(text: string | undefined): number {
  return text?.trim() ? text.length : 0;
}

function estimateTokensFromChars(chars: number): number {
  return chars <= 0 ? 0 : Math.max(1, Math.ceil(chars / 4));
}

function compactAttributes(attributes: Record<string, unknown> | undefined): Record<string, string | number | boolean> {
  const compact: Record<string, string | number | boolean> = {};
  for (const [key, value] of Object.entries(attributes ?? {})) {
    if (value === undefined || value === null) continue;
    if (typeof value === "string") {
      const redacted = redactTraceAttribute(key, value);
      compact[key] = redacted.length > 500 ? `${redacted.slice(0, 497)}...` : redacted;
    }
    else if (typeof value === "number" && Number.isFinite(value)) compact[key] = value;
    else if (typeof value === "boolean") compact[key] = value;
  }
  return compact;
}

function sanitizeTraceSpan(span: StructuredTraceSpan): StructuredTraceSpan {
  const attributes = compactAttributes(span.attributes);
  const sanitized = {
    ...span,
    name: redactTraceAttribute("name", span.name),
  };
  if (Object.keys(attributes).length) return { ...sanitized, attributes };
  const { attributes: _attributes, ...withoutAttributes } = sanitized;
  return withoutAttributes;
}

function timestampMs(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function stageLifecycleSpans(runId: string, plan: RoutePlan | undefined, steps: RunStepState[], runStartedAt: number, runEndedAt: number): StructuredTraceSpan[] {
  if (!plan) return [];
  if (plan.kind === "dag") {
    return plan.stages.flatMap((stage) => {
      const stageSteps = steps.filter((step) => step.id.startsWith(`${stage.id}:`));
      if (!stageSteps.some(hasStartedLifecycleStep)) return [];
      return [createStructuredSpan({
        id: `${runId}:stage:${stage.id}`,
        parentId: `${runId}:run`,
        name: ("name" in stage && typeof stage.name === "string" ? stage.name : stage.id),
        kind: "stage",
        startedAt: minStepTime(stageSteps, "startedAt") ?? runStartedAt,
        endedAt: maxStepTime(stageSteps, "endedAt") ?? runEndedAt,
        attributes: { stageId: stage.id, tasks: stage.tasks.length },
      })];
    });
  }
  return [createStructuredSpan({
    id: `${runId}:stage:${plan.kind}`,
    parentId: `${runId}:run`,
    name: plan.kind,
    kind: "stage",
    startedAt: minStepTime(steps, "startedAt") ?? runStartedAt,
    endedAt: maxStepTime(steps, "endedAt") ?? runEndedAt,
    attributes: { stageId: plan.kind, tasks: steps.length },
  })];
}

function hasStartedLifecycleStep(step: RunStepState): boolean {
  if (step.startedAt || step.endedAt) return true;
  if (step.status === "pending") return false;
  return step.status === "running"
    || step.status === "complete"
    || step.status === "failed"
    || step.status === "paused"
    || isCheckpointStepStatus(step.status);
}

function minStepTime(steps: RunStepState[], field: "startedAt" | "endedAt"): number | undefined {
  const values = steps.map((step) => timestampMs(step[field])).filter((value): value is number => value !== undefined);
  return values.length ? Math.min(...values) : undefined;
}

function maxStepTime(steps: RunStepState[], field: "startedAt" | "endedAt"): number | undefined {
  const values = steps.map((step) => timestampMs(step[field])).filter((value): value is number => value !== undefined);
  return values.length ? Math.max(...values) : undefined;
}

const tokenomicsPhases: TokenomicsPhase[] = [
  "orchestratorPrompt",
  "roster",
  "childPrompt",
  "memory",
  "toolOutputs",
  "webContextFetch",
  "handoff",
  "reviewer",
  "repair",
  "finalSynthesis",
];
