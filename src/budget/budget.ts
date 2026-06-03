import { Context, Effect, Layer, Schedule } from "effect";
import type { ArtifactCheckpoint, ArtifactStore } from "../artifacts/artifacts.ts";
import type { AgentDefinition, BudgetCapHit, BudgetCapName, RouteKind, RouteRisk, RunStepState, ToolBudgetProfile } from "../domain/schemas.ts";

export type { BudgetCapHit } from "../domain/schemas.ts";

export type BudgetTaskKind = "recon" | "review" | "implementation" | "migration" | "long-autonomous" | "research" | "planning" | "synthesis";
export type BudgetHealthStatus = "ok" | "warn" | "checkpointed";
export type BudgetResumeStrategy = "none" | "handoff-only" | "checkpoint-and-continue" | "split-and-continue" | "stage-checkpoint-validate-memory-next";

export interface BudgetCaps {
  maxToolCalls: number;
  maxSeconds: number;
  maxUsd: number;
  maxTurns: number;
  maxOutputChars: number;
  maxReadBytes: number;
  maxFilesTouched: number;
  maxRetriesPerTool: number;
}

export interface BudgetPolicy {
  id: string;
  taskKind: BudgetTaskKind;
  profile: ToolBudgetProfile;
  risk: RouteRisk;
  routeKind: RouteKind;
  caps: BudgetCaps;
  resumeStrategy: BudgetResumeStrategy;
}

export interface BudgetPreflightInput {
  task: string;
  routeKind: RouteKind;
  steps?: Array<{ agent: string; task: string; budget?: ToolBudgetProfile }>;
  risk?: RouteRisk;
  needsArtifacts?: boolean;
}

export interface BudgetPreflight {
  taskKind: BudgetTaskKind;
  expectedStages: number;
  expectedTools: number;
  risk: RouteRisk;
  budgetProfile: ToolBudgetProfile;
  resumeStrategy: BudgetResumeStrategy;
  requiresArtifacts: boolean;
  recommendation: string;
  policy: BudgetPolicy;
}

export interface BudgetUsage {
  elapsedMs: number;
  toolCalls: number;
  totalCostUsd: number;
  turns: number;
  outputChars: number;
  readBytes: number;
  filesTouched: number;
  retriesByTool: Record<string, number>;
}

export interface BudgetHealth {
  status: BudgetHealthStatus;
  caps: BudgetCapHit[];
  warnings: string[];
  next: "continue" | "checkpoint-and-continue" | "checkpoint-low-signal" | "checkpoint-needs-continuation" | "split" | "escalate";
  checkpointStatus?: "checkpointed-needs-continuation" | "checkpointed-low-signal" | "checkpointed-awaiting-review" | "checkpointed-split-recommended";
}

export interface ToolUtilityInput {
  findings: string[];
  toolCalls: number;
  filesRead: string[];
  firstSignalToolCall?: number;
  verificationDone: boolean;
  memoryCandidates: Array<{ content: string; category?: string; confidence?: number }>;
}

export interface ToolUtilityMetrics {
  findingsPerTool: number;
  filesReadPerFinding: number;
  duplicateReads: number;
  toolCallsBeforeFirstSignal: number;
  verificationDone: boolean;
  memoryCandidatesQuality: number;
}

export interface ProgressScore {
  score: number;
  level: "low" | "medium" | "high";
  gate: "continue" | "checkpoint-low-signal" | "checkpoint-needs-continuation" | "split";
  positiveSignals: string[];
  negativeSignals: string[];
}

interface BudgetPolicyServiceShape {
  readonly policyForStep: typeof policyForStep;
  readonly evaluateUsage: typeof evaluateBudgetUsage;
  readonly checkpointSchedule: BudgetCheckpointSchedule;
  readonly checkpointWriteSchedule: BudgetCheckpointWriteSchedule;
  readonly recordCheckpoint: (store: ArtifactStore, featureId: string, step: RunStepState, reason: string) => Effect.Effect<ArtifactCheckpoint, unknown>;
}

class BudgetPolicyService extends Context.Tag("pi-chalin/BudgetPolicy")<BudgetPolicyService, BudgetPolicyServiceShape>() {}

function makeCheckpointSchedule() {
  return Schedule.spaced("5 minutes");
}

function makeCheckpointWriteSchedule() {
  return Schedule.recurs(0);
}

type BudgetCheckpointSchedule = ReturnType<typeof makeCheckpointSchedule>;
type BudgetCheckpointWriteSchedule = ReturnType<typeof makeCheckpointWriteSchedule>;

const BudgetLayer = Layer.succeed(BudgetPolicyService, {
  policyForStep,
  evaluateUsage: evaluateBudgetUsage,
  checkpointSchedule: makeCheckpointSchedule(),
  checkpointWriteSchedule: makeCheckpointWriteSchedule(),
  recordCheckpoint: recordBudgetCheckpointEffect,
});

export function budgetCheckpointSchedule(): BudgetCheckpointSchedule {
  return makeCheckpointSchedule();
}

export function policyForStep(
  agent: AgentDefinition | undefined,
  step: Pick<RunStepState, "agent" | "task" | "budget">,
  routeKind: RouteKind = "multi-agent-sequential",
  risk: RouteRisk = "low",
): BudgetPolicy {
  const profile = step.budget ?? inferredBudgetProfile(agent, step, routeKind);
  const taskKind = taskKindForStep(agent, { ...step, budget: profile }, routeKind);
  const caps = scaleCaps(baseCapsForTask(taskKind, agent), profile, risk);
  return {
    id: `${taskKind}:${profile}:${risk}`,
    taskKind,
    profile,
    risk,
    routeKind,
    caps,
    resumeStrategy: resumeStrategyFor(taskKind, profile),
  };
}

export function estimateBudgetPreflight(input: BudgetPreflightInput): BudgetPreflight {
  const budgetProfile = inferPreflightProfile(input.steps, input.routeKind, input.needsArtifacts);
  const taskKind = inferTaskKind(input.steps, budgetProfile, input.needsArtifacts);
  const risk = input.risk ?? inferRisk(input.steps);
  const representativeStep = input.steps?.[0] ?? { agent: "scout", task: input.task, budget: budgetProfile };
  const policy = policyForStep(undefined, { ...representativeStep, budget: budgetProfile }, input.routeKind, risk);
  const expectedStages = input.routeKind === "multi-agent-dag"
    ? Math.max(2, Math.min(8, input.steps?.length ?? 3))
    : Math.max(1, input.steps?.length ?? 1);
  const expectedTools = Math.max(policy.caps.maxToolCalls, (input.steps ?? [representativeStep]).reduce((sum, step) => {
    const stepPolicy = policyForStep(undefined, step, input.routeKind, risk);
    return sum + stepPolicy.caps.maxToolCalls;
  }, 0));
  const requiresArtifacts = Boolean(input.needsArtifacts || taskKind === "long-autonomous" || budgetProfile === "extended");
  const resumeStrategy = requiresArtifacts ? "stage-checkpoint-validate-memory-next" : taskKind === "implementation" ? "checkpoint-and-continue" : "handoff-only";
  return {
    taskKind,
    expectedStages,
    expectedTools,
    risk,
    budgetProfile,
    resumeStrategy,
    requiresArtifacts,
    recommendation: recommendationFor(taskKind, budgetProfile, requiresArtifacts),
    policy: { ...policy, resumeStrategy },
  };
}

export function evaluateBudgetUsage(policy: BudgetPolicy, usage: BudgetUsage, progress?: ProgressScore): BudgetHealth {
  if (budgetGatesDisabled()) return { status: "ok", caps: [], warnings: [], next: "continue" };
  const caps: BudgetCapHit[] = [];
  compare(caps, "max_tool_calls", usage.toolCalls, policy.caps.maxToolCalls);
  compare(caps, "max_seconds", Math.ceil(usage.elapsedMs / 1000), policy.caps.maxSeconds);
  compare(caps, "max_usd", usage.totalCostUsd, policy.caps.maxUsd);
  compare(caps, "max_turns", usage.turns, policy.caps.maxTurns);
  compare(caps, "max_output_chars", usage.outputChars, policy.caps.maxOutputChars);
  compare(caps, "max_read_bytes", usage.readBytes, policy.caps.maxReadBytes);
  compare(caps, "max_files_touched", usage.filesTouched, policy.caps.maxFilesTouched);
  const maxRetries = Math.max(0, ...Object.values(usage.retriesByTool));
  compare(caps, "max_retries_per_tool", maxRetries, policy.caps.maxRetriesPerTool);

  if (caps.length === 0) return { status: "ok", caps, warnings: [], next: "continue" };
  return {
    status: "warn",
    caps,
    warnings: [
      ...caps.map((cap) => `${cap.name} used ${formatNumber(cap.used)} over limit ${formatNumber(cap.limit)}`),
      ...(progress && progress.gate !== "continue" ? [`progress signal ${progress.gate} from score ${formatNumber(progress.score)}`] : []),
    ],
    next: "continue",
  };
}

function budgetGatesDisabled(): boolean {
  return process.env.PI_CHALIN_DISABLE_BUDGET_GATES === "1";
}

export function summarizeToolUtility(input: ToolUtilityInput): ToolUtilityMetrics {
  const findings = input.findings.filter((item) => item.trim().length > 0);
  const uniqueFiles = new Set(input.filesRead);
  const duplicateReads = input.filesRead.length - uniqueFiles.size;
  const qualityScores = input.memoryCandidates.map(memoryQualityScore);
  const memoryCandidatesQuality = qualityScores.length ? round(qualityScores.reduce((sum, value) => sum + value, 0) / qualityScores.length) : 0;
  return {
    findingsPerTool: round(findings.length / Math.max(input.toolCalls, 1)),
    filesReadPerFinding: round(uniqueFiles.size / Math.max(findings.length, 1)),
    duplicateReads,
    toolCallsBeforeFirstSignal: input.firstSignalToolCall ?? (findings.length > 0 ? Math.min(input.toolCalls, 1) : input.toolCalls),
    verificationDone: input.verificationDone,
    memoryCandidatesQuality,
  };
}

export function scoreProgress(input: ToolUtilityInput): ProgressScore {
  const utility = summarizeToolUtility(input);
  const positiveSignals: string[] = [];
  const negativeSignals: string[] = [];
  if (utility.findingsPerTool > 0) positiveSignals.push("new_evidence");
  if (utility.toolCallsBeforeFirstSignal <= 2 && input.toolCalls > 0) positiveSignals.push("early_signal");
  if (utility.verificationDone) positiveSignals.push("verification_done");
  if (utility.memoryCandidatesQuality >= 0.45) positiveSignals.push("memory_quality");
  if (utility.duplicateReads > 0) negativeSignals.push("duplicate_reads");
  if (input.toolCalls >= 8 && utility.toolCallsBeforeFirstSignal > 6) negativeSignals.push("late_first_signal");
  if (input.toolCalls >= 10 && utility.findingsPerTool < 0.08) negativeSignals.push("low_signal_tools");
  if (input.findings.filter((item) => item.trim()).length === 0) negativeSignals.push("no_findings");

  const score = round(
    utility.findingsPerTool * 1.4
    + (utility.verificationDone ? 0.3 : 0)
    + Math.min(0.2, utility.memoryCandidatesQuality * 0.25)
    + (positiveSignals.includes("early_signal") ? 0.12 : 0)
    - utility.duplicateReads * 0.18
    - (negativeSignals.includes("late_first_signal") ? 0.25 : 0)
    - (negativeSignals.includes("low_signal_tools") ? 0.32 : 0)
    - (negativeSignals.includes("no_findings") ? 0.18 : 0),
  );
  const level: ProgressScore["level"] = score >= 0.5 ? "high" : score >= 0.15 ? "medium" : "low";
  const gate: ProgressScore["gate"] = level !== "low"
    ? "continue"
    : utility.duplicateReads >= 2 || negativeSignals.includes("low_signal_tools")
    ? "checkpoint-low-signal"
    : "checkpoint-needs-continuation";
  return { score, level, gate, positiveSignals, negativeSignals };
}

export async function recordBudgetCheckpoint(store: ArtifactStore, featureId: string, step: RunStepState, reason: string): Promise<ArtifactCheckpoint> {
  return Effect.runPromise(Effect.gen(function* () {
    const budget = yield* BudgetPolicyService;
    return yield* checkpointWriteWithSchedule(budget.recordCheckpoint(store, featureId, step, reason), budget.checkpointWriteSchedule);
  }).pipe(Effect.provide(BudgetLayer), Effect.withSpan("budget.recordCheckpoint")));
}

function checkpointWriteWithSchedule<A>(effect: Effect.Effect<A, unknown>, schedule: BudgetCheckpointWriteSchedule): Effect.Effect<A, unknown> {
  return Effect.gen(function* () {
    const result = yield* effect;
    yield* Effect.repeat(Effect.void, { schedule });
    return result;
  }).pipe(Effect.withSpan("budget.checkpointSchedule"));
}

function recordBudgetCheckpointEffect(store: ArtifactStore, featureId: string, step: RunStepState, reason: string): Effect.Effect<ArtifactCheckpoint, unknown> {
  return Effect.gen(function* () {
    yield* Effect.tryPromise(() => store.initFeature({
      featureId,
      goal: `Continue budget checkpoint for pi-chalin step ${step.agent}`,
      chain: [step.agent],
      currentStep: step.task,
    }));
    return yield* Effect.tryPromise(() => store.appendCheckpoint(featureId, {
      agent: step.agent,
      title: `${step.agent} budget checkpoint`,
      summary: compact([step.output?.handoff, step.output?.text, reason].filter(Boolean).join(" "), 900),
      status: "paused",
      stage: step.id,
    }));
  }).pipe(Effect.withSpan("budget.recordCheckpoint.write"));
}

function checkpointStatusForGate(gate: ProgressScore["gate"]): BudgetHealth["checkpointStatus"] | undefined {
  if (gate === "checkpoint-low-signal") return "checkpointed-low-signal";
  if (gate === "checkpoint-needs-continuation") return "checkpointed-needs-continuation";
  if (gate === "split") return "checkpointed-split-recommended";
  return undefined;
}

function compare(caps: BudgetCapHit[], name: BudgetCapName, used: number, limit: number): void {
  if (!Number.isFinite(limit) || used < limit) return;
  caps.push({
    name,
    used,
    limit,
    severity: "soft",
    phase: "post-step",
  });
}

function baseCapsForTask(taskKind: BudgetTaskKind, agent: AgentDefinition | undefined): BudgetCaps {
  const baseToolCalls = baseToolCallsFor(taskKind, agent);
  const isLong = taskKind === "long-autonomous";
  const isWriteHeavy = taskKind === "implementation" || taskKind === "migration";
  const isSynthesis = taskKind === "synthesis" || taskKind === "planning";
  return {
    maxToolCalls: baseToolCalls,
    maxSeconds: isLong ? 7200 : isWriteHeavy ? 1800 : isSynthesis ? 900 : 1200,
    maxUsd: isLong ? 2.5 : isWriteHeavy ? 1.2 : isSynthesis ? 0.45 : 0.8,
    maxTurns: isLong ? 12 : isWriteHeavy ? 8 : isSynthesis ? 4 : 6,
    maxOutputChars: isLong ? 24000 : isWriteHeavy ? 16000 : isSynthesis ? 7000 : 12000,
    maxReadBytes: isLong ? 5_000_000 : isWriteHeavy ? 2_000_000 : isSynthesis ? 350_000 : 1_500_000,
    maxFilesTouched: taskKind === "migration" ? 40 : taskKind === "implementation" ? 20 : 4,
    maxRetriesPerTool: 3,
  };
}

function baseToolCallsFor(taskKind: BudgetTaskKind, agent: AgentDefinition | undefined): number {
  if (agent?.budget?.baseToolCalls) return agent.budget.baseToolCalls;
  if (taskKind === "long-autonomous") return 160;
  if (taskKind === "migration") return 120;
  if (taskKind === "implementation") return 80;
  if (taskKind === "review") return 50;
  if (taskKind === "research") return 60;
  if (taskKind === "planning") return 25;
  if (taskKind === "synthesis") return 25;
  return 40;
}

function scaleCaps(caps: BudgetCaps, profile: ToolBudgetProfile, risk: RouteRisk): BudgetCaps {
  const multiplier = profile === "tight" ? 0.5 : profile === "deep" ? 2 : profile === "extended" ? 4 : 1;
  const riskMultiplier = risk === "critical" ? 0.75 : risk === "high" ? 0.9 : 1;
  const toolCap = profile === "extended" ? 500 : profile === "deep" ? 240 : profile === "tight" ? 60 : 140;
  return {
    maxToolCalls: Math.max(1, Math.min(toolCap, Math.ceil(caps.maxToolCalls * multiplier * riskMultiplier))),
    maxSeconds: Math.max(120, Math.ceil(caps.maxSeconds * multiplier)),
    maxUsd: round(caps.maxUsd * multiplier),
    maxTurns: Math.max(1, Math.ceil(caps.maxTurns * (profile === "tight" ? 0.75 : profile === "deep" ? 1.5 : profile === "extended" ? 2 : 1))),
    maxOutputChars: Math.ceil(caps.maxOutputChars * multiplier),
    maxReadBytes: Math.ceil(caps.maxReadBytes * multiplier),
    maxFilesTouched: Math.max(1, Math.ceil(caps.maxFilesTouched * (profile === "extended" ? 2 : profile === "deep" ? 1.5 : profile === "tight" ? 0.75 : 1))),
    maxRetriesPerTool: caps.maxRetriesPerTool,
  };
}

function taskKindForStep(agent: AgentDefinition | undefined, step: Pick<RunStepState, "agent" | "budget">, routeKind: RouteKind): BudgetTaskKind {
  if (step.budget === "extended") return "long-autonomous";
  if (agent?.concern === "implementation") return "implementation";
  if (step.agent === "worker") return "implementation";
  if (agent?.concern === "research") return "research";
  if (agent?.concern === "planning") return "planning";
  if (agent?.concern === "review") return "review";
  if (step.agent === "researcher") return "research";
  if (step.agent === "planner") return "planning";
  if (step.agent === "reviewer") return "review";
  if (routeKind === "multi-agent-dag" && step.budget === "deep" && step.agent === "worker") return "migration";
  return "recon";
}

function inferTaskKind(steps: BudgetPreflightInput["steps"], profile: ToolBudgetProfile, needsArtifacts?: boolean): BudgetTaskKind {
  if (needsArtifacts && profile === "extended") return "long-autonomous";
  if ((steps ?? []).some((step) => step.budget === "extended")) return "long-autonomous";
  if ((steps ?? []).some((step) => step.agent === "worker" && step.budget === "deep")) return "migration";
  if ((steps ?? []).some((step) => step.agent === "worker")) return "implementation";
  if ((steps ?? []).some((step) => step.agent === "researcher")) return "research";
  if ((steps ?? []).some((step) => step.agent === "planner")) return "planning";
  if ((steps ?? []).some((step) => step.agent === "reviewer")) return "review";
  return "recon";
}

function inferRisk(steps: BudgetPreflightInput["steps"]): RouteRisk {
  if ((steps ?? []).some((step) => step.agent === "worker")) return "medium";
  return "low";
}

function inferPreflightProfile(steps: BudgetPreflightInput["steps"], routeKind: RouteKind, needsArtifacts?: boolean): ToolBudgetProfile {
  const explicit = steps?.map((step) => step.budget).filter(Boolean).at(-1);
  if (explicit) return explicit;
  if (needsArtifacts) return "extended";
  if (routeKind === "multi-agent-dag") return "deep";
  if ((steps ?? []).length === 1 && steps?.[0]?.agent === "planner") return "tight";
  return "normal";
}

function inferredBudgetProfile(agent: AgentDefinition | undefined, step: Pick<RunStepState, "agent" | "task" | "budget">, routeKind: RouteKind): ToolBudgetProfile {
  if (step.budget) return step.budget;
  if (routeKind === "multi-agent-dag" && ["recon", "context-building", "review", "research"].includes(agent?.concern ?? "")) return "deep";
  if (agent?.concern === "planning") return "tight";
  return "normal";
}

function resumeStrategyFor(taskKind: BudgetTaskKind, profile: ToolBudgetProfile): BudgetResumeStrategy {
  if (taskKind === "long-autonomous" || profile === "extended") return "stage-checkpoint-validate-memory-next";
  if (taskKind === "implementation" || taskKind === "migration") return "checkpoint-and-continue";
  if (taskKind === "recon" || taskKind === "review" || taskKind === "research") return "handoff-only";
  return "none";
}

function recommendationFor(taskKind: BudgetTaskKind, profile: ToolBudgetProfile, artifacts: boolean): string {
  if (taskKind === "long-autonomous") return "Use staged DAG execution with checkpoint → validate → memory → next-stage continuation.";
  if (artifacts || profile === "extended") return "Write checkpoint artifacts at every handoff and split work before budget caps are hit.";
  if (taskKind === "migration") return "Prefer DAG fan-out by module with reviewer synthesis and validation contracts.";
  return "Use the smallest bounded agent workflow and stop after enough exact evidence to state remaining uncertainty.";
}

function memoryQualityScore(candidate: { content: string; category?: string; confidence?: number }): number {
  const content = candidate.content.trim();
  if (!content || /\b(stdout|stderr|traceback|cmd =|subprocess|returncode)\b/i.test(content)) return 0;
  const durableCategory = /^(project-fact|pattern|tooling|testing|workflow|bugfix|validation|artifact|decision|preference|architecture|safety|security|failure)$/i.test(candidate.category ?? "");
  const sentenceScore = content.split(/[.!?]+/).filter((part) => part.trim().length > 15).length >= 1 ? 0.35 : 0.15;
  const lengthScore = content.length >= 80 && content.length <= 600 ? 0.35 : 0.15;
  const categoryScore = durableCategory ? 0.2 : 0.05;
  const confidenceScore = Math.min(0.1, Math.max(0, candidate.confidence ?? 0) / 10);
  return round(sentenceScore + lengthScore + categoryScore + confidenceScore);
}

function compact(text: string, max: number): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  return normalized.length <= max ? normalized : `${normalized.slice(0, max - 1)}…`;
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function formatNumber(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(3);
}
