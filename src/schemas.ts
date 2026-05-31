export const AGENT_SCOPES = ["built-in", "project", "user"] as const;
export type AgentScope = (typeof AGENT_SCOPES)[number];

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

export type RunStatus = "pending" | "running" | "complete" | "failed" | "paused" | "budget-capped" | "stale-repaired";

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
  status: RunStatus;
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
}

export interface RunState {
  id: string;
  route: RouteDecision;
  rootTask?: string;
  status: RunStatus;
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
