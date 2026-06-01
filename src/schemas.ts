import type { SkillTraceEvent, StructuredTraceSpan, TokenomicsSummary } from "./observability.ts";

export const AGENT_SCOPES = ["built-in", "project", "user"] as const;
export type AgentScope = (typeof AGENT_SCOPES)[number];

export const SKILL_SCOPES = ["built-in", "project", "user", "on-demand"] as const;
export type SkillScope = (typeof SKILL_SCOPES)[number];
export const SKILL_ACTIVATIONS = ["manual", "suggested", "auto"] as const;
export type SkillActivation = (typeof SKILL_ACTIVATIONS)[number];
export const SKILL_TRUST_LEVELS = ["trusted", "reviewed", "untrusted", "blocked"] as const;
export type SkillTrust = (typeof SKILL_TRUST_LEVELS)[number];
export const SKILL_LIFECYCLES = ["active", "stale", "expired", "candidate", "blocked"] as const;
export type SkillLifecycle = (typeof SKILL_LIFECYCLES)[number];
export const SKILL_SCRIPT_POLICIES = ["disabled", "sandboxed", "trusted-only"] as const;
export type SkillScriptPolicy = (typeof SKILL_SCRIPT_POLICIES)[number];

export const AGENT_CONCERNS = [
  "recon",
  "research",
  "context-building",
  "planning",
  "implementation",
  "review",
  "conflict-resolution",
  "decision-consistency",
  "delegation",
  "memory-curation",
] as const;
export type AgentConcern = (typeof AGENT_CONCERNS)[number];

export const AGENT_CAPABILITIES = [
  "inspect-files",
  "search-files",
  "run-safe-bash",
  "validate",
  "edit-files",
  "write-new-files",
  "external-context",
  "memory-read",
  "memory-write",
  "coordinate",
] as const;
export type AgentCapability = (typeof AGENT_CAPABILITIES)[number];

export const AGENT_THINKING_LEVELS = ["inherit", "off", "minimal", "low", "medium", "high", "xhigh"] as const;
export type AgentThinkingLevel = (typeof AGENT_THINKING_LEVELS)[number];

export type AgentMemoryWritePolicy = "never" | "candidate" | "approved";

export interface AgentMemoryPolicy {
  read: boolean;
  write: AgentMemoryWritePolicy;
  categories: string[];
}

export interface AgentDefinition {
  name: string;
  scope: AgentScope;
  concern: AgentConcern;
  capabilities: AgentCapability[];
  description: string;
  model: "inherit" | string;
  thinking?: AgentThinkingLevel;
  tools: string[];
  memory: AgentMemoryPolicy;
  systemPrompt: string;
  sourcePath?: string;
  diagnostics: string[];
}

export interface SkillDefinition {
  name: string;
  description: string;
  scope: SkillScope;
  extends: string[];
  concerns: AgentConcern[];
  capabilities: AgentCapability[];
  activation: SkillActivation;
  triggers: string[];
  risk: RouteRisk;
  maxActiveWith: string[];
  allowedTools: string[];
  deniedTools: string[];
  requiresReview: boolean;
  scripts: SkillScriptPolicy;
  trust: SkillTrust;
  lifecycle: SkillLifecycle;
  version: number;
  sourcePath: string;
  checksum: string;
  qualifiedName: string;
  diagnostics: string[];
  lastVerifiedAt?: string;
  expiresAt?: string;
  featureId?: string;
  verifiedBy?: string;
  commandEvidence: string[];
  resources: string[];
  body: string;
  bodyLoaded: boolean;
}

export interface ResolvedSkill {
  skill: SkillDefinition;
  reason: string;
}

export interface RejectedSkill {
  skill: SkillDefinition;
  reason: string;
  policy?: string;
}

export interface SkillResolutionResult {
  active: ResolvedSkill[];
  suggested: ResolvedSkill[];
  rejected: RejectedSkill[];
  events?: SkillTraceEvent[];
}

export interface AgentCatalogDiagnostics {
  warnings: string[];
  errors: string[];
}

export type RouteKind =
  | "bypass"
  | "single-agent"
  | "multi-agent-chain"
  | "multi-agent-parallel"
  | "multi-agent-dag"
  | "memory-only"
  | "ask-user";

export type RouteRisk = "low" | "medium" | "high" | "critical";
export type RouteAmbiguity = "low" | "medium" | "high";

export interface AgentStep {
  id?: string;
  agent: string;
  task: string;
  budget?: ToolBudgetProfile;
}

export interface AgentStage {
  id: string;
  tasks: AgentStep[];
}

export type ToolBudgetProfile = "tight" | "normal" | "deep" | "extended";

export type RoutePlan =
  | { kind: "single"; agent: string; task: string; budget?: ToolBudgetProfile }
  | { kind: "chain"; steps: AgentStep[] }
  | { kind: "parallel"; tasks: AgentStep[] }
  | { kind: "dag"; stages: AgentStage[] };

export interface RouteDecision {
  kind: RouteKind;
  agents: string[];
  risk: RouteRisk;
  ambiguity: RouteAmbiguity;
  needsMemory: boolean;
  needsArtifacts: boolean;
  reason: string;
  plan?: RoutePlan;
}

export type ApprovalAction = "allow" | "ask" | "block";

export interface ApprovalDecision {
  action: ApprovalAction;
  reason: string;
}

export type RunStatus = "pending" | "running" | "complete" | "failed" | "paused" | "stale-repaired";
export type RunStepStatus = "pending" | "running" | "complete" | "failed" | "paused" | "checkpointed";
export type LegacyRunStatus = RunStatus | "budget-capped";
export type LegacyRunStepStatus = RunStepStatus | "budget-capped";
export type CheckpointKind = "budget-cap" | "needs-continuation" | "low-signal" | "awaiting-review" | "split-recommended";
export type CheckpointContinuation = "continue" | "review" | "split" | "resume";

export interface CheckpointInfo {
  kind: CheckpointKind;
  reason: string;
  continuation: CheckpointContinuation;
  progressScore?: number;
  capHits?: BudgetCapHit[];
  legacyStatus?: "budget-capped";
}

export interface MemoryCandidate {
  id: string;
  category: string;
  content: string;
  sourceAgent: string;
  confidence: number;
  evidence?: string;
  scope: "project" | "user";
  createdAt: string;
  topicKey?: string;
}

export type MemoryRecordStatus = "active" | "pending" | "rejected" | "superseded" | "stale" | "quarantined";

export interface MemoryRecord extends MemoryCandidate {
  status: MemoryRecordStatus;
  reviewedAt?: string;
  importance: number;
  trigger: string;
  lastSeenAt: string;
  duplicateCount: number;
  revisionCount: number;
  updatedAt?: string;
  lastUsedAt?: string;
  useCount?: number;
  utilityScore?: number;
  tokenCostEstimate?: number;
  supersedesId?: string;
  supersededBy?: string;
}

export type MemoryAuditEventType =
  | "create"
  | "duplicate"
  | "revise"
  | "approve"
  | "reject"
  | "delete"
  | "retrieve"
  | "quarantine"
  | "stale";

export interface MemoryAuditEvent {
  id: string;
  recordId: string;
  type: MemoryAuditEventType;
  actor: string;
  at: string;
  summary: string;
  previousContent?: string;
  nextContent?: string;
  metadata?: Record<string, unknown>;
}

export interface AgentOutput {
  agent: string;
  text: string;
  handoff?: string;
  memoryCandidates: MemoryCandidate[];
  raw: string;
  warnings: string[];
}

export interface TokenUsageCost {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  total: number;
}

export interface TokenUsageSummary {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
  cost: TokenUsageCost;
}

export type BudgetCapName =
  | "max_tool_calls"
  | "max_seconds"
  | "max_usd"
  | "max_turns"
  | "max_output_chars"
  | "max_read_bytes"
  | "max_files_touched"
  | "max_retries_per_tool"
  | "max_cross_step_duplicate_reads";

export type BudgetCapSeverity = "soft" | "hard";
export type BudgetCapPhase = "pre-tool" | "post-tool" | "post-step";

export interface BudgetCapHit {
  name: BudgetCapName;
  used: number;
  limit: number;
  severity: BudgetCapSeverity;
  phase: BudgetCapPhase;
  toolName?: string;
  reason?: string;
}

export interface RunStepMetrics {
  durationMs: number;
  usage: TokenUsageSummary;
  toolCalls: number;
  maxToolCalls?: number;
  toolCallsByName: Record<string, number>;
  policyViolations?: string[];
  budgetStopCount?: number;
  budgetCapHits?: BudgetCapHit[];
  duplicateReadCount?: number;
  crossStepDuplicateReadCount?: number;
  crossStepDuplicateReads?: string[];
  filesRead?: string[];
  readBytes?: number;
  outputChars?: number;
  outputCharsByToolName?: Record<string, number>;
  outputTruncatedCount?: number;
  filesTouched?: string[];
  shellCommands?: string[];
  postMutationShellCommands?: number;
  successfulPostMutationShellCommands?: number;
  retriesByTool?: Record<string, number>;
  utility?: {
    findingsPerTool: number;
    filesReadPerFinding: number;
    duplicateReads: number;
    toolCallsBeforeFirstSignal: number;
    verificationDone: boolean;
    memoryCandidatesQuality: number;
  };
  progress?: {
    score: number;
    level: "low" | "medium" | "high";
    gate: "continue" | "checkpoint-low-signal" | "checkpoint-needs-continuation" | "split";
    positiveSignals: string[];
    negativeSignals: string[];
  };
  tokenomics?: TokenomicsSummary;
  spans?: StructuredTraceSpan[];
  skills?: string[];
  skillEvents?: SkillTraceEvent[];
}

export interface RunMetricsCheckpoint {
  steps: number;
  kinds: Partial<Record<CheckpointKind, number>>;
}

export type ModelResolutionSource = "session-override" | "agent" | "tier" | "inherit";
export type ModelResolutionStatus = "selected" | "invalid" | "unavailable" | "unauthenticated" | "fallback" | "runtime-error";

export interface ModelResolutionAttempt {
  source: ModelResolutionSource;
  ref?: string;
  status: ModelResolutionStatus;
  model?: string;
  reason?: string;
}

export interface ModelResolutionLog {
  selected: string;
  tier: "fast" | "balanced" | "strong";
  attempts: ModelResolutionAttempt[];
}

export interface RunStepState {
  id: string;
  agent: string;
  task: string;
  status: RunStepStatus;
  checkpoint?: CheckpointInfo;
  budget?: ToolBudgetProfile;
  maxToolCalls?: number;
  startedAt?: string;
  endedAt?: string;
  model?: string;
  thinkingLevel?: AgentThinkingLevel;
  output?: AgentOutput;
  error?: string;
  currentTool?: string;
  modelResolution?: ModelResolutionLog;
  metrics?: RunStepMetrics;
  delegationDepth?: number;
  activeSkills?: ResolvedSkill[];
  suggestedSkills?: ResolvedSkill[];
  rejectedSkills?: RejectedSkill[];
  skillTraceEvents?: SkillTraceEvent[];
}

export interface RunState {
  id: string;
  route: RouteDecision;
  rootTask?: string;
  status: RunStatus;
  schemaVersion?: number;
  startedAt: string;
  endedAt?: string;
  steps: RunStepState[];
  logsPath?: string;
  parentRunId?: string;
  parentStepId?: string;
  delegationDepth?: number;
  warnings: string[];
  budgetPreflight?: {
    taskKind: string;
    expectedStages: number;
    expectedTools: number;
    risk: RouteRisk;
    budgetProfile: ToolBudgetProfile;
    resumeStrategy: string;
    requiresArtifacts: boolean;
    recommendation: string;
  };
  metrics?: {
    durationMs: number;
    usage: TokenUsageSummary;
    toolCalls: number;
    toolCallsByName: Record<string, number>;
    policyViolations?: string[];
    budgetStopCount?: number;
    budgetCapHits?: BudgetCapHit[];
    duplicateReadCount?: number;
    crossStepDuplicateReadCount?: number;
    crossStepDuplicateReads?: string[];
    filesRead?: string[];
    tokenomics?: TokenomicsSummary;
    spans?: StructuredTraceSpan[];
    skillEvents?: SkillTraceEvent[];
    checkpoints?: RunMetricsCheckpoint;
  };
}

export interface ChalinRuntimeState {
  autoRoutingEnabled: boolean;
  pendingApprovals: number;
  activeRuns: number;
  pendingMemoryCandidates: number;
  memoryBackend?: string;
  lastRun?: RunState;
}

export function isAgentScope(value: string): value is AgentScope {
  return (AGENT_SCOPES as readonly string[]).includes(value);
}

export function isSkillScope(value: string): value is SkillScope {
  return (SKILL_SCOPES as readonly string[]).includes(value);
}

export function isSkillActivation(value: string): value is SkillActivation {
  return (SKILL_ACTIVATIONS as readonly string[]).includes(value);
}

export function isSkillTrust(value: string): value is SkillTrust {
  return (SKILL_TRUST_LEVELS as readonly string[]).includes(value);
}

export function isSkillLifecycle(value: string): value is SkillLifecycle {
  return (SKILL_LIFECYCLES as readonly string[]).includes(value);
}

export function isSkillScriptPolicy(value: string): value is SkillScriptPolicy {
  return (SKILL_SCRIPT_POLICIES as readonly string[]).includes(value);
}

export function isAgentConcern(value: string): value is AgentConcern {
  return (AGENT_CONCERNS as readonly string[]).includes(value);
}

export function isAgentCapability(value: string): value is AgentCapability {
  return (AGENT_CAPABILITIES as readonly string[]).includes(value);
}

export function isAgentThinkingLevel(value: string): value is AgentThinkingLevel {
  return (AGENT_THINKING_LEVELS as readonly string[]).includes(value);
}

export function riskRank(risk: RouteRisk): number {
  return { low: 0, medium: 1, high: 2, critical: 3 }[risk];
}
