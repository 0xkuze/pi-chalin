import * as fs from "node:fs";
import * as path from "node:path";
import {
  createBashToolDefinition,
  createEditToolDefinition,
  createFindToolDefinition,
  createGrepToolDefinition,
  createLsToolDefinition,
  createReadToolDefinition,
  createWriteToolDefinition,
  defineTool,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { ArtifactStore, type ArtifactFeatureStatus } from "./artifacts.ts";
import type { BudgetPolicy } from "./budget.ts";
import { buildProjectDiscoveryIndex, formatProjectDiscoveryIndex } from "./discovery.ts";
import { createMemoryCandidate } from "./memory.ts";
import { createConfiguredMemoryStore } from "./memory-provider.ts";
import type { BudgetCapHit, BudgetCapName, BudgetCapSeverity } from "./schemas.ts";
import { buildProjectSnapshot, formatProjectSnapshot } from "./snapshot.ts";
import { fetchWebUrls, formatWebBundle, searchWeb } from "./webfetch.ts";

const SnapshotParams = Type.Object({});
const DiscoveryParams = Type.Object({
  maxDepth: Type.Optional(Type.Number({ description: "Maximum directory depth to index. Default 4." })),
  maxEntries: Type.Optional(Type.Number({ description: "Maximum entries to return. Default 450." })),
});
const ChalinArtifactWriteParams = Type.Object({
  kind: Type.Union([Type.Literal("checkpoint"), Type.Literal("validation-contract"), Type.Literal("worker-skill"), Type.Literal("feature-state")]),
  featureId: Type.String({ description: "Stable feature/task artifact id." }),
  title: Type.Optional(Type.String({ description: "Checkpoint or validation title." })),
  summary: Type.Optional(Type.String({ description: "Compact human-readable summary. No raw logs/code." })),
  status: Type.Optional(Type.Union([Type.Literal("active"), Type.Literal("complete"), Type.Literal("failed"), Type.Literal("paused")])),
  stage: Type.Optional(Type.String()),
  agent: Type.Optional(Type.String()),
  id: Type.Optional(Type.String({ description: "Validation contract id." })),
  commands: Type.Optional(Type.Array(Type.String())),
  successCriteria: Type.Optional(Type.Array(Type.String())),
  files: Type.Optional(Type.Array(Type.String())),
  name: Type.Optional(Type.String({ description: "Worker skill name." })),
  rules: Type.Optional(Type.Array(Type.String())),
  chain: Type.Optional(Type.Array(Type.String())),
});

type ChalinArtifactWriteParamsShape = {
  kind: "checkpoint" | "validation-contract" | "worker-skill" | "feature-state";
  featureId: string;
  title?: string;
  summary?: string;
  status?: ArtifactFeatureStatus;
  stage?: string;
  agent?: string;
  id?: string;
  commands?: string[];
  successCriteria?: string[];
  files?: string[];
  name?: string;
  rules?: string[];
  chain?: string[];
};

const ChalinWebSearchParams = Type.Object({
  query: Type.Optional(Type.String({ description: "Web search query." })),
  url: Type.Optional(Type.String({ description: "Single URL to fetch." })),
  urls: Type.Optional(Type.Array(Type.String(), { description: "URLs to fetch." })),
  maxSources: Type.Optional(Type.Number({ description: "Maximum search sources." })),
  depth: Type.Optional(Type.Union([Type.Literal("snippets"), Type.Literal("content")])),
  freshness: Type.Optional(Type.Union([Type.Literal("cache-ok"), Type.Literal("prefer-fresh"), Type.Literal("must-be-fresh")])),
});

const ChalinMemorySearchParams = Type.Object({
  query: Type.String({ description: "Concrete task, decision, file, or concept to recall. Keep it short." }),
  limit: Type.Optional(Type.Number({ description: "Maximum memories to consider. Default 8." })),
  tokenBudget: Type.Optional(Type.Number({ description: "Maximum returned memory context tokens. Default is per-agent and capped." })),
  includeEvidence: Type.Optional(Type.Boolean({ description: "Include compact evidence snippets when needed for contradiction or review work." })),
});

const ChalinMemoryWriteParams = Type.Object({
  category: Type.String({ description: "Memory category, e.g. project-fact, pattern, tooling, testing, workflow, bugfix, decision, preference, architecture, safety, security, failure." }),
  content: Type.String({ description: "Durable human-readable memory. No logs, code dumps, command output, or task completion notes." }),
  confidence: Type.Optional(Type.Number({ description: "Confidence from 0 to 1. Defaults to 0.8." })),
  evidence: Type.Optional(Type.String({ description: "Compact evidence source, file path, command, or reason. No raw logs." })),
  topicKey: Type.Optional(Type.String({ description: "Optional stable topic key when correcting or merging a known concept." })),
});

const ChalinMemoryReviseParams = Type.Object({
  id: Type.String({ description: "Existing memory id to revise." }),
  content: Type.String({ description: "Corrected durable memory content." }),
  category: Type.Optional(Type.String({ description: "Corrected category if it changed." })),
  confidence: Type.Optional(Type.Number({ description: "Confidence from 0 to 1. Defaults to the existing record confidence." })),
  evidence: Type.Optional(Type.String({ description: "Compact evidence proving the correction." })),
  reason: Type.Optional(Type.String({ description: "Why the old memory is stale, wrong, or less useful." })),
});

const DelegateStepParams = Type.Object({
  id: Type.Optional(Type.String({ description: "Stable step id." })),
  agent: Type.String({ description: "Available pi-chalin agent name for the delegated subtask." }),
  task: Type.String({ description: "Concrete delegated outcome, evidence to inspect, files to modify if any, and success criteria." }),
  budget: Type.Optional(Type.Union([
    Type.Literal("tight"),
    Type.Literal("normal"),
    Type.Literal("deep"),
    Type.Literal("extended"),
  ])),
});

const DelegateStageParams = Type.Object({
  id: Type.Optional(Type.String({ description: "Stable stage id." })),
  name: Type.Optional(Type.String({ description: "Human-readable stage name." })),
  tasks: Type.Array(DelegateStepParams),
});

const ChalinDelegateParams = Type.Object({
  task: Type.String({ description: "Bounded objective for the nested subagent chain. Include current evidence and exact success criteria." }),
  topology: Type.Union([
    Type.Literal("single"),
    Type.Literal("chain"),
    Type.Literal("parallel"),
    Type.Literal("dag"),
  ], { description: "Small nested workflow only. Use single/chain/parallel with steps; dag with stages." }),
  steps: Type.Optional(Type.Array(DelegateStepParams)),
  stages: Type.Optional(Type.Array(DelegateStageParams)),
  reason: Type.String({ description: "Why this rare nested delegation is necessary instead of finishing in the current agent." }),
  requiresWorkspaceMutation: Type.Optional(Type.Boolean()),
});

type ChalinMemorySearchParamsShape = {
  query: string;
  limit?: number;
  tokenBudget?: number;
  includeEvidence?: boolean;
};

type ChalinMemoryWriteParamsShape = {
  category: string;
  content: string;
  confidence?: number;
  evidence?: string;
  topicKey?: string;
};

type ChalinMemoryReviseParamsShape = {
  id: string;
  content: string;
  category?: string;
  confidence?: number;
  evidence?: string;
  reason?: string;
};

export type ChalinDelegateParamsShape = {
  task: string;
  topology: "single" | "chain" | "parallel" | "dag";
  steps?: Array<{ id?: string; agent: string; task: string; budget?: "tight" | "normal" | "deep" | "extended" }>;
  stages?: Array<{ id?: string; name?: string; tasks: Array<{ id?: string; agent: string; task: string; budget?: "tight" | "normal" | "deep" | "extended" }> }>;
  reason: string;
  requiresWorkspaceMutation?: boolean;
};

export interface ChildToolPolicyOptions {
  cwd: string;
  maxToolCalls: number;
  budgetPolicy?: BudgetPolicy;
  agentName?: string;
  allowedTools?: string[];
  priorFilesRead?: string[];
  maxCrossStepDuplicateReads?: number;
  subagentDelegation?: {
    enabled: boolean;
    depth: number;
    maxDepth: number;
    execute(params: ChalinDelegateParamsShape): Promise<{ text: string; details?: unknown }>;
  };
  onActivity?: (activity: ChildToolActivity) => void;
}

export interface ChildToolActivity {
  toolName: string;
  phase: "start" | "end" | "blocked";
  at: number;
}

export interface ChildToolPolicyMetrics {
  toolCalls: number;
  toolCallsByName: Record<string, number>;
  policyViolations: string[];
  budgetStopCount: number;
  budgetCapHits: BudgetCapHit[];
  duplicateReadCount: number;
  filesRead: string[];
  readBytes: number;
  outputChars: number;
  outputTruncatedCount: number;
  filesTouched: string[];
  shellCommands: string[];
  postMutationShellCommands: number;
  successfulPostMutationShellCommands: number;
  retriesByTool: Record<string, number>;
}

export interface ChildToolPolicy {
  cwd: string;
  maxToolCalls: number;
  agentName?: string;
  allowedTools: Set<string>;
  subagentDelegation?: ChildToolPolicyOptions["subagentDelegation"];
  beforeTool(toolName: string, params: Record<string, unknown>): { allowed: true } | { allowed: false; reason: string };
  afterTool(toolName: string, result: unknown): unknown;
  metrics(): ChildToolPolicyMetrics;
}

export function createChildToolPolicy(options: ChildToolPolicyOptions): ChildToolPolicy {
  const toolCallsByName: Record<string, number> = {};
  const policyViolations: string[] = [];
  const budgetCapHits: BudgetCapHit[] = [];
  const budgetCapHitKeys = new Set<string>();
  const filesRead: string[] = [];
  const filesTouched: string[] = [];
  const shellCommands: string[] = [];
  const pendingShellCommands: Array<{ command?: string; afterMutation: boolean }> = [];
  const retriesByTool: Record<string, number> = {};
  const allowedTools = new Set(options.allowedTools ?? []);
  const priorFilesRead = new Set((options.priorFilesRead ?? []).map((item) => normalizeMetricPath(item, options.cwd)));
  const maxCrossStepDuplicateReads = options.maxCrossStepDuplicateReads ?? Number.POSITIVE_INFINITY;
  const hasExplicitAllowlist = options.allowedTools !== undefined;
  let budgetStopCount = 0;
  let toolCalls = 0;
  let readBytes = 0;
  let outputChars = 0;
  let outputTruncatedCount = 0;
  let crossStepDuplicateReadCount = 0;
  let mutationSucceeded = false;
  let postMutationShellCommands = 0;
  let successfulPostMutationShellCommands = 0;
  const startedAt = Date.now();
  const caps = options.budgetPolicy?.caps ?? {
    maxToolCalls: options.maxToolCalls,
    maxSeconds: Number.POSITIVE_INFINITY,
    maxUsd: Number.POSITIVE_INFINITY,
    maxTurns: Number.POSITIVE_INFINITY,
    maxOutputChars: 12_000,
    maxReadBytes: 120_000,
    maxFilesTouched: 8,
    maxRetriesPerTool: 2,
  };

  function violation(reason: string): { allowed: false; reason: string } {
    policyViolations.push(reason);
    return { allowed: false, reason };
  }

  function recordBudgetCapHit(input: {
    name: BudgetCapName;
    used: number;
    limit: number;
    severity: BudgetCapSeverity;
    phase: BudgetCapHit["phase"];
    toolName?: string;
    reason?: string;
  }): void {
    if (!Number.isFinite(input.limit)) return;
    const key = `${input.phase}:${input.severity}:${input.name}:${input.toolName ?? ""}`;
    if (budgetCapHitKeys.has(key)) return;
    budgetCapHitKeys.add(key);
    budgetCapHits.push({
      name: input.name,
      used: roundMetric(input.used),
      limit: roundMetric(input.limit),
      severity: input.severity,
      phase: input.phase,
      ...(input.toolName ? { toolName: input.toolName } : {}),
      ...(input.reason ? { reason: input.reason } : {}),
    });
  }

  function budgetBlock(toolName: string, name: BudgetCapName, used: number, limit: number, reason?: string): { allowed: false; reason: string } {
    budgetStopCount += 1;
    recordBudgetCapHit({ name, used, limit, severity: "hard", phase: "pre-tool", toolName, reason });
    activity(toolName, "blocked");
    return { allowed: false, reason: `budget_exceeded:${toolName}:${name}=${limit}` };
  }

  function budgetWarn(toolName: string, name: BudgetCapName, used: number, limit: number, phase: BudgetCapHit["phase"] = "pre-tool", reason?: string): void {
    recordBudgetCapHit({ name, used, limit, severity: "soft", phase, toolName, reason });
  }

  function activity(toolName: string, phase: ChildToolActivity["phase"]): void {
    options.onActivity?.({ toolName, phase, at: Date.now() });
  }

  function record(toolName: string, params: Record<string, unknown>): { allowed: true } {
    toolCalls += 1;
    toolCallsByName[toolName] = (toolCallsByName[toolName] ?? 0) + 1;
    if (toolName === "read") {
      const readPath = getPathParam(params);
      if (readPath) filesRead.push(normalizeMetricPath(readPath, options.cwd));
    }
    if (toolName === "edit" || toolName === "write") {
      const target = getPathParam(params);
      if (target) filesTouched.push(normalizeMetricPath(target, options.cwd));
    }
    if (toolName === "bash") {
      const command = getCommandParam(params);
      if (command) shellCommands.push(command);
      pendingShellCommands.push({ command, afterMutation: mutationSucceeded });
    }
    return { allowed: true };
  }

  return {
    cwd: options.cwd,
    maxToolCalls: caps.maxToolCalls,
    agentName: options.agentName,
    allowedTools,
    subagentDelegation: options.subagentDelegation,
    beforeTool(toolName, params) {
      if (hasExplicitAllowlist && !allowedTools.has(toolName)) {
        activity(toolName, "blocked");
        return violation(`tool_not_allowed:${toolName}`);
      }
      if (Date.now() - startedAt >= caps.maxSeconds * 1000) {
        return budgetBlock(toolName, "max_seconds", Math.ceil((Date.now() - startedAt) / 1000), caps.maxSeconds);
      }
      if (toolCalls >= adaptiveHardLimit(caps.maxToolCalls, "tool-calls")) {
        return budgetBlock(toolName, "max_tool_calls", toolCalls, caps.maxToolCalls, "adaptive hard ceiling after soft tool-call budget");
      }
      if (toolCalls >= caps.maxToolCalls) {
        budgetWarn(toolName, "max_tool_calls", toolCalls, caps.maxToolCalls, "pre-tool", "soft tool-call budget reached; continuing under adaptive grace");
      }
      if (isInspectionTool(toolName) && readBytes >= adaptiveHardLimit(caps.maxReadBytes, "read-bytes")) {
        return budgetBlock(toolName, "max_read_bytes", readBytes, caps.maxReadBytes, "adaptive hard ceiling after soft read budget");
      }
      if (isInspectionTool(toolName) && readBytes >= caps.maxReadBytes) {
        budgetWarn(toolName, "max_read_bytes", readBytes, caps.maxReadBytes, "pre-tool", "soft read budget reached; continuing under adaptive grace");
      }
      if ((toolName === "edit" || toolName === "write") && filesTouched.length >= adaptiveHardLimit(caps.maxFilesTouched, "files-touched")) {
        return budgetBlock(toolName, "max_files_touched", filesTouched.length, caps.maxFilesTouched, "adaptive hard ceiling after soft touched-files budget");
      }
      if (filesTouched.length >= caps.maxFilesTouched && (toolName === "edit" || toolName === "write")) {
        budgetWarn(toolName, "max_files_touched", filesTouched.length, caps.maxFilesTouched, "pre-tool", "soft touched-files budget reached; continuing under adaptive grace");
      }

      if (toolName === "write") {
        const target = getPathParam(params);
        if (target && fs.existsSync(resolveProjectPath(target, options.cwd))) {
          activity(toolName, "blocked");
          return violation(`write_existing_file:${normalizeMetricPath(target, options.cwd)}`);
        }
      }

      if (toolName === "read") {
        const readPath = getPathParam(params);
        const normalizedReadPath = readPath ? normalizeMetricPath(readPath, options.cwd) : undefined;
        if (normalizedReadPath && priorFilesRead.has(normalizedReadPath)) {
          const nextDuplicateCount = crossStepDuplicateReadCount + 1;
          const hardDuplicateLimit = adaptiveHardLimit(maxCrossStepDuplicateReads, "duplicate-reads");
          if (nextDuplicateCount > hardDuplicateLimit) {
            return budgetBlock("read", "max_cross_step_duplicate_reads", nextDuplicateCount, maxCrossStepDuplicateReads, normalizedReadPath);
          }
          if (nextDuplicateCount > maxCrossStepDuplicateReads) {
            budgetWarn("read", "max_cross_step_duplicate_reads", nextDuplicateCount, maxCrossStepDuplicateReads, "pre-tool", normalizedReadPath);
          }
          crossStepDuplicateReadCount = nextDuplicateCount;
        }
      }

      if (toolName === "edit") {
        const edits = Array.isArray(params.edits) ? params.edits : [];
        const tooLarge = edits.some((edit) => {
          if (!edit || typeof edit !== "object") return false;
          const item = edit as Record<string, unknown>;
          return stringSize(item.oldText) > 12_000 || stringSize(item.newText) > 12_000;
        });
        if (tooLarge) {
          activity(toolName, "blocked");
          return violation(`large_edit_block:${normalizeMetricPath(getPathParam(params) ?? "unknown", options.cwd)}`);
        }
      }

      const recorded = record(toolName, params);
      activity(toolName, "start");
      return recorded;
    },
    afterTool(toolName, result) {
      if ((toolName === "edit" || toolName === "write") && !isToolError(result)) mutationSucceeded = true;
      if (toolName === "bash") {
        const pending = pendingShellCommands.shift();
        if (pending?.afterMutation) {
          postMutationShellCommands += 1;
          if (!isToolError(result)) successfulPostMutationShellCommands += 1;
        }
      }
      const compressed = compressToolResult(result, toolName, caps.maxOutputChars);
      if (compressed.truncated) outputTruncatedCount += 1;
      outputChars += compressed.outputChars;
      if (toolName === "read") readBytes += compressed.outputChars;
      recordPostToolBudgetWarnings(toolName);
      activity(toolName, "end");
      return compressed.result;
    },
    metrics() {
      return {
        toolCalls,
        toolCallsByName: { ...toolCallsByName },
        policyViolations: [...policyViolations],
        budgetStopCount,
        budgetCapHits: budgetCapHits.slice(0, 30),
        duplicateReadCount: filesRead.length - new Set(filesRead).size,
        filesRead: [...new Set(filesRead)].slice(0, 50),
        readBytes,
        outputChars,
        outputTruncatedCount,
        filesTouched: [...new Set(filesTouched)].slice(0, 50),
        shellCommands: shellCommands.slice(0, 30),
        postMutationShellCommands,
        successfulPostMutationShellCommands,
        retriesByTool: { ...retriesByTool },
      };
    },
  };

  function recordPostToolBudgetWarnings(toolName: string): void {
    if (toolCalls >= caps.maxToolCalls) budgetWarn(toolName, "max_tool_calls", toolCalls, caps.maxToolCalls, "post-tool");
    if (outputChars >= caps.maxOutputChars) budgetWarn(toolName, "max_output_chars", outputChars, caps.maxOutputChars, "post-tool");
    if (readBytes >= caps.maxReadBytes) budgetWarn(toolName, "max_read_bytes", readBytes, caps.maxReadBytes, "post-tool");
    if (filesTouched.length >= caps.maxFilesTouched) budgetWarn(toolName, "max_files_touched", filesTouched.length, caps.maxFilesTouched, "post-tool");
  }
}

export function createChildTools(policy: ChildToolPolicy): ToolDefinition[] {
  const builtinTools: Array<[string, ToolDefinition<any, any, any>]> = [
    ["read", createReadToolDefinition(policy.cwd)],
    ["grep", createGrepToolDefinition(policy.cwd)],
    ["find", createFindToolDefinition(policy.cwd)],
    ["ls", createLsToolDefinition(policy.cwd)],
    ["edit", createEditToolDefinition(policy.cwd)],
    ["write", createWriteToolDefinition(policy.cwd)],
  ];
  const tools: Array<[string, ToolDefinition<any, any, any>]> = [
    ...builtinTools.map(([name, tool]) => [name, guardTool(tool, name, policy)] as [string, ToolDefinition<any, any, any>]),
    ["chalin_project_discovery", createProjectDiscoveryTool(policy)],
    ["chalin_project_snapshot", createProjectSnapshotTool(policy)],
    ["bash", guardTool(createBashToolDefinition(policy.cwd), "bash", policy)],
    ["chalin_web_search", createChalinWebSearchTool(policy)],
    ["chalin_artifact_write", createChalinArtifactWriteTool(policy)],
    ["chalin_delegate", createChalinDelegateTool(policy)],
    ["chalin_memory_search", createChalinMemorySearchTool(policy)],
    ["chalin_memory_write", createChalinMemoryWriteTool(policy)],
    ["chalin_memory_revise", createChalinMemoryReviseTool(policy)],
  ];
  return tools.filter(([name]) => policy.allowedTools.has(name)).map(([, tool]) => tool);
}

export function createProjectDiscoveryTool(policy: ChildToolPolicy): ToolDefinition {
  return defineTool<typeof DiscoveryParams, unknown>({
    name: "chalin_project_discovery",
    label: "Chalin Project Discovery",
    description: "Return a raw, stack-agnostic project file index with shallow files, config-like files, test-like files, directories, and extension histogram. It does not infer architecture or framework.",
    promptSnippet: "chalin_project_discovery: get a raw non-semantic file index for broad orientation; skip it for bounded edits when native find/grep/read is cheaper.",
    promptGuidelines: [
      "Call chalin_project_discovery before broad repository exploration.",
      "For bounded bugfix/refactor/test/scaffold work, prefer targeted native find/grep/read over inventorying the project.",
      "Use it as an index, not as proof of architecture.",
      "Read evidence files before making project claims.",
    ],
    parameters: DiscoveryParams,
    async execute(_toolCallId, params) {
      const gate = policy.beforeTool("chalin_project_discovery", params);
      if (!gate.allowed) return blockedToolResult(gate.reason);
      const index = buildProjectDiscoveryIndex(policy.cwd, {
        maxDepth: typeof params.maxDepth === "number" ? params.maxDepth : undefined,
        maxEntries: typeof params.maxEntries === "number" ? params.maxEntries : undefined,
      });
      return policy.afterTool("chalin_project_discovery", {
        content: [{ type: "text" as const, text: formatProjectDiscoveryIndex(index) }],
        details: { index },
      }) as never;
    },
  });
}

export function createProjectSnapshotTool(policy: ChildToolPolicy): ToolDefinition {
  return defineTool<typeof SnapshotParams, unknown>({
    name: "chalin_project_snapshot",
    label: "Chalin Project Snapshot",
    description: "Legacy alias that returns raw project inventory plus git metadata. It does not infer stack, entrypoints, tests, commands, or importance.",
    promptSnippet: "chalin_project_snapshot: get raw project inventory plus git metadata before branch/diff reconnaissance.",
    promptGuidelines: [
      "Prefer chalin_project_discovery unless git metadata is needed.",
      "Treat this as filesystem/git facts only; choose follow-up reads/searches with LLM judgment.",
    ],
    parameters: SnapshotParams,
    async execute() {
      const gate = policy.beforeTool("chalin_project_snapshot", {});
      if (!gate.allowed) return blockedToolResult(gate.reason);
      const snapshot = buildProjectSnapshot({ cwd: policy.cwd });
      return policy.afterTool("chalin_project_snapshot", {
        content: [{ type: "text" as const, text: formatProjectSnapshot(snapshot) }],
        details: { snapshot },
      }) as never;
    },
  });
}

export function createChalinWebSearchTool(policy: ChildToolPolicy): ToolDefinition {
  return defineTool<typeof ChalinWebSearchParams, unknown>({
    name: "chalin_web_search",
    label: "Chalin Web Search",
    description: "Search or fetch current web context through Exa MCP. Available only to agents with external-context capability.",
    promptSnippet: "chalin_web_search: fetch compact external evidence through Exa MCP when authorized.",
    promptGuidelines: [
      "Use chalin_web_search only when current external docs/facts or a URL are needed.",
      "Return source URLs in the handoff; do not paste raw dumps.",
    ],
    parameters: ChalinWebSearchParams,
    async execute(_toolCallId, params, signal) {
      const input = isRecord(params) ? params : {};
      const gate = policy.beforeTool("chalin_web_search", input);
      if (!gate.allowed) return blockedToolResult(gate.reason);
      const urls = [
        ...(Array.isArray(params.urls) ? params.urls : []),
        ...(typeof params.url === "string" ? [params.url] : []),
      ].filter((url): url is string => typeof url === "string" && url.trim().length > 0);
      const freshness = params.freshness as "cache-ok" | "prefer-fresh" | "must-be-fresh" | undefined;
      const bundle = urls.length > 0
        ? await fetchWebUrls({ cwd: policy.cwd, urls, freshness, signal })
        : await searchWeb({ cwd: policy.cwd, query: String(params.query ?? ""), maxSources: Number(params.maxSources ?? 5), depth: params.depth as "snippets" | "content" | undefined, freshness, signal });
      return policy.afterTool("chalin_web_search", { content: [{ type: "text" as const, text: formatWebBundle(bundle) }], details: bundle }) as never;
    },
  });
}

export function createChalinMemorySearchTool(policy: ChildToolPolicy): ToolDefinition {
  return defineTool<typeof ChalinMemorySearchParams, unknown>({
    name: "chalin_memory_search",
    label: "Chalin Memory Search",
    description: "Retrieve compact project/user memory autonomously when it can reduce exploration, prevent repeated mistakes, or check prior decisions. Results are token-budgeted.",
    promptSnippet: "chalin_memory_search: recall compact durable memory without waiting for an explicit human instruction.",
    promptGuidelines: [
      "Use when prior decisions, preferences, workflows, or repeated project facts may matter.",
      "Keep query short and specific; ask for evidence only when checking contradictions or reviewing risk.",
      "Treat memory as guidance. Current repo evidence wins over stale memory.",
    ],
    parameters: ChalinMemorySearchParams,
    async execute(_toolCallId, params: ChalinMemorySearchParamsShape) {
      const input = isRecord(params) ? params : {};
      const gate = policy.beforeTool("chalin_memory_search", input);
      if (!gate.allowed) return blockedToolResult(gate.reason);
      const store = createConfiguredMemoryStore({ cwd: policy.cwd });
      const bundle = await store.retrieve({
        query: String(params.query ?? ""),
        sourceAgent: policy.agentName,
        limit: typeof params.limit === "number" ? params.limit : undefined,
        tokenBudget: typeof params.tokenBudget === "number" ? params.tokenBudget : undefined,
        includeEvidence: Boolean(params.includeEvidence),
      });
      const text = bundle.text || "No relevant active memory found.";
      return policy.afterTool("chalin_memory_search", {
        content: [{ type: "text" as const, text }],
        details: { ...bundle, results: bundle.results.map((result) => ({ id: result.record.id, category: result.record.category, score: result.score })) },
      }) as never;
    },
  });
}

export function createChalinDelegateTool(policy: ChildToolPolicy): ToolDefinition {
  return defineTool<typeof ChalinDelegateParams, unknown>({
    name: "chalin_delegate",
    label: "Chalin Delegate",
    description: "Rare nested pi-chalin delegation for a coordinating subagent that discovers a bounded subproblem is too ambiguous, long, or multi-surface to finish alone. Maximum two subagent levels below the primary orchestrator.",
    promptSnippet: "chalin_delegate: rarely split a subagent's work into a tiny nested chain/DAG when current evidence proves the task is too broad or ambiguous to finish safely alone.",
    promptGuidelines: [
      "This is exceptional, not a normal path. Prefer finishing the current task yourself when the scope is bounded.",
      "Use only after current evidence shows ambiguity, multiple independent surfaces, or review/isolation needs that would otherwise lower quality.",
      "Keep the nested plan tiny and concrete. Pass current evidence, exact files/surfaces, ownership boundaries, and success criteria in the task.",
      "Do not use it to avoid ordinary implementation work, repeat broad discovery, or create another planning layer without a clear output contract.",
      "Nested delegation stops at two subagent levels; if blocked by depth, return a compact handoff and ask the parent orchestrator to continue.",
    ],
    parameters: ChalinDelegateParams,
    async execute(_toolCallId, params: ChalinDelegateParamsShape) {
      const input = isRecord(params) ? params : {};
      const gate = policy.beforeTool("chalin_delegate", input);
      if (!gate.allowed) return blockedToolResult(gate.reason);
      const delegate = policy.subagentDelegation;
      if (!delegate?.enabled) return blockedToolResult("nested_delegation_unavailable");
      if (delegate.depth >= delegate.maxDepth) {
        return blockedToolResult(`nested_delegation_depth_exceeded:${delegate.depth}/${delegate.maxDepth}`);
      }
      if (!params.reason?.trim()) return blockedToolResult("nested_delegation_reason_required");
      const result = await delegate.execute(params);
      return policy.afterTool("chalin_delegate", {
        content: [{ type: "text" as const, text: result.text }],
        details: result.details,
      }) as never;
    },
  });
}

export function createChalinMemoryWriteTool(policy: ChildToolPolicy): ToolDefinition {
  return defineTool<typeof ChalinMemoryWriteParams, unknown>({
    name: "chalin_memory_write",
    label: "Chalin Memory Write",
    description: "Submit a durable memory candidate autonomously through pi-chalin WriteGuard. The store decides active, pending, or rejected.",
    promptSnippet: "chalin_memory_write: save durable, verified project knowledge; never save logs or trivial task notes.",
    promptGuidelines: [
      "Write only knowledge that should help future runs: decisions, durable patterns, project facts, testing/tooling rules, failures, or preferences.",
      "Prefer one compact sentence. Include evidence when the memory corrects or replaces earlier understanding.",
      "Do not write raw logs, commands, stdout/stderr, stack traces, code dumps, or simple completion notes.",
    ],
    parameters: ChalinMemoryWriteParams,
    async execute(_toolCallId, params: ChalinMemoryWriteParamsShape) {
      const input = isRecord(params) ? params : {};
      const gate = policy.beforeTool("chalin_memory_write", input);
      if (!gate.allowed) return blockedToolResult(gate.reason);
      const validation = validateMemoryWriteParams(params);
      if (!validation.allowed) return blockedToolResult(validation.reason);
      const store = createConfiguredMemoryStore({ cwd: policy.cwd });
      const [record] = await store.submitCandidates([createMemoryCandidate({
        category: params.category,
        content: params.content,
        sourceAgent: policy.agentName ?? "subagent",
        confidence: typeof params.confidence === "number" ? Math.max(0, Math.min(1, params.confidence)) : 0.8,
        evidence: params.evidence,
        scope: "project",
        topicKey: params.topicKey,
      })]);
      const text = record
        ? `memory ${record.status}: ${record.id} · ${record.category} · ${truncateForTool(record.content, 220)}`
        : "memory rejected: no candidate was persisted.";
      return policy.afterTool("chalin_memory_write", { content: [{ type: "text" as const, text }], details: { record } }) as never;
    },
  });
}

export function createChalinMemoryReviseTool(policy: ChildToolPolicy): ToolDefinition {
  return defineTool<typeof ChalinMemoryReviseParams, unknown>({
    name: "chalin_memory_revise",
    label: "Chalin Memory Revise",
    description: "Correct an existing memory when current evidence proves it stale, wrong, or less useful. Revisions are audited.",
    promptSnippet: "chalin_memory_revise: repair stale or wrong memory with evidence.",
    promptGuidelines: [
      "Use only when you have evidence that the previous memory is wrong, stale, or lower quality.",
      "Keep corrected content compact and durable.",
      "Explain why the correction is safer or more accurate.",
    ],
    parameters: ChalinMemoryReviseParams,
    async execute(_toolCallId, params: ChalinMemoryReviseParamsShape) {
      const input = isRecord(params) ? params : {};
      const gate = policy.beforeTool("chalin_memory_revise", input);
      if (!gate.allowed) return blockedToolResult(gate.reason);
      const validation = validateMemoryRevisionParams(params);
      if (!validation.allowed) return blockedToolResult(validation.reason);
      const store = createConfiguredMemoryStore({ cwd: policy.cwd });
      const record = await store.revise(params.id, {
        category: params.category,
        content: params.content,
        confidence: params.confidence,
        evidence: params.evidence,
        reason: params.reason,
        sourceAgent: policy.agentName ?? "subagent",
      });
      const text = record
        ? `memory revised: ${record.id} · ${record.status} · rev=${record.revisionCount} · ${truncateForTool(record.content, 220)}`
        : `memory revise skipped: '${params.id}' was not found or cannot be revised.`;
      return policy.afterTool("chalin_memory_revise", { content: [{ type: "text" as const, text }], details: { record } }) as never;
    },
  });
}


export function createChalinArtifactWriteTool(policy: ChildToolPolicy): ToolDefinition {
  return defineTool<typeof ChalinArtifactWriteParams, unknown>({
    name: "chalin_artifact_write",
    label: "Chalin Artifact Write",
    description: "Write controlled pi-chalin checkpoints, validation contracts, worker skills, or feature state for long-running work.",
    promptSnippet: "chalin_artifact_write: save compact task artifacts for resumable chalin workflows; never store raw logs or code dumps.",
    promptGuidelines: [
      "Use after a meaningful handoff, validation boundary, or worker-specific convention is discovered.",
      "Write compact human-readable summaries only. Do not store raw command output, stack traces, or code dumps.",
      "Prefer validation contracts with explicit commands and success criteria before handing work to another agent.",
    ],
    parameters: ChalinArtifactWriteParams,
    async execute(_toolCallId, params: ChalinArtifactWriteParamsShape) {
      const input = isRecord(params) ? params : {};
      const gate = policy.beforeTool("chalin_artifact_write", input);
      if (!gate.allowed) return blockedToolResult(gate.reason);
      const validation = validateArtifactParams(params);
      if (!validation.allowed) return blockedToolResult(validation.reason);
      const store = new ArtifactStore({ cwd: policy.cwd });
      if (params.kind === "feature-state") {
        const state = await store.initFeature({ featureId: params.featureId, goal: params.summary ?? params.title ?? `Continue ${params.featureId}`, chain: params.chain, currentStep: params.title });
        return artifactToolResult(`feature state saved: ${state.featureId}`, state);
      }
      if (params.kind === "checkpoint") {
        const checkpoint = await store.appendCheckpoint(params.featureId, {
          agent: params.agent ?? policy.agentName ?? "subagent",
          title: params.title ?? "Checkpoint",
          summary: params.summary ?? "Checkpoint recorded.",
          status: params.status ?? "active",
          stage: params.stage,
        });
        return artifactToolResult(`checkpoint saved: ${checkpoint.id}`, checkpoint);
      }
      if (params.kind === "validation-contract") {
        const contract = await store.saveValidationContract(params.featureId, {
          id: params.id ?? params.title ?? "validation-contract",
          title: params.title ?? params.id ?? "Validation contract",
          commands: params.commands ?? [],
          successCriteria: params.successCriteria ?? [],
          files: params.files,
        });
        return artifactToolResult(`validation contract saved: ${contract.id}`, contract);
      }
      const skill = await store.saveWorkerSkill(params.featureId, {
        name: params.name ?? params.title ?? "worker-skill",
        summary: params.summary ?? params.title ?? "Worker skill for this feature.",
        rules: params.rules ?? [],
      });
      return artifactToolResult(`worker skill saved: ${skill.name}`, skill);
    },
  });
}

function validateArtifactParams(params: ChalinArtifactWriteParamsShape): { allowed: true } | { allowed: false; reason: string } {
  if (!params.featureId || params.featureId.length > 96) return { allowed: false, reason: "artifact_feature_id_invalid" };
  const text = [params.title, params.summary, ...(params.successCriteria ?? []), ...(params.rules ?? [])].filter(Boolean).join("\n");
  if (text.length > 3000) return { allowed: false, reason: "artifact_payload_too_large" };
  if (/\b(stdout|stderr|traceback|stack trace|returncode|subprocess|os\.environ|sys\.exit)\b/i.test(text)) return { allowed: false, reason: "artifact_raw_runtime_noise" };
  if (params.kind === "checkpoint" && !params.summary) return { allowed: false, reason: "checkpoint_summary_required" };
  if (params.kind === "validation-contract" && (!params.successCriteria?.length || !params.commands?.length)) return { allowed: false, reason: "validation_contract_requires_commands_and_success_criteria" };
  if (params.kind === "worker-skill" && (!params.summary || !params.rules?.length)) return { allowed: false, reason: "worker_skill_requires_summary_and_rules" };
  return { allowed: true };
}

function validateMemoryWriteParams(params: ChalinMemoryWriteParamsShape): { allowed: true } | { allowed: false; reason: string } {
  const text = [params.category, params.content, params.evidence, params.topicKey].filter(Boolean).join("\n");
  if (!params.category || params.category.length > 40) return { allowed: false, reason: "memory_category_invalid" };
  if (!params.content || params.content.length < 48 || params.content.length > 600) return { allowed: false, reason: "memory_content_must_be_48_to_600_chars" };
  if (text.length > 1200) return { allowed: false, reason: "memory_payload_too_large" };
  if (containsRawRuntimeNoise(text)) return { allowed: false, reason: "memory_raw_runtime_noise" };
  return { allowed: true };
}

function validateMemoryRevisionParams(params: ChalinMemoryReviseParamsShape): { allowed: true } | { allowed: false; reason: string } {
  const text = [params.id, params.category, params.content, params.evidence, params.reason].filter(Boolean).join("\n");
  if (!params.id || params.id.length > 120) return { allowed: false, reason: "memory_revision_id_invalid" };
  if (!params.content || params.content.length < 48 || params.content.length > 600) return { allowed: false, reason: "memory_revision_content_must_be_48_to_600_chars" };
  if (text.length > 1400) return { allowed: false, reason: "memory_revision_payload_too_large" };
  if (containsRawRuntimeNoise(text)) return { allowed: false, reason: "memory_revision_raw_runtime_noise" };
  return { allowed: true };
}

function containsRawRuntimeNoise(text: string): boolean {
  return /\b(stdout|stderr|traceback|stack trace|returncode|subprocess|os\.environ|sys\.exit|TimeoutExpired|print\(|cmd\s*=)\b/i.test(text);
}

function artifactToolResult(text: string, details: unknown) {
  return { content: [{ type: "text" as const, text }], details };
}

function guardTool(base: ToolDefinition<any, any, any>, toolName: string, policy: ChildToolPolicy): ToolDefinition<any, any, any> {
  return {
    ...base,
    description: `${base.description} Guarded by pi-chalin child policy: adaptive budgets, observable activity, and surgical repository writes.`,
    promptGuidelines: [
      ...(base.promptGuidelines ?? []),
      "Stay within the pi-chalin child tool budget.",
      "Prefer targeted inspection over broad crawls.",
    ],
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const input = isRecord(params) ? params : {};
      const gate = policy.beforeTool(toolName, input);
      if (!gate.allowed) return blockedToolResult(gate.reason);
      const result = await base.execute(toolCallId, params as never, signal, onUpdate, ctx);
      return policy.afterTool(toolName, result) as Awaited<ReturnType<typeof base.execute>>;
    },
  };
}

function blockedToolResult(reason: string) {
  return {
    content: [{ type: "text" as const, text: `Blocked by pi-chalin child policy: ${reason}\nStop if you have enough evidence; otherwise use fewer, more targeted Pi-native tools.` }],
    details: { blocked: true, reason },
    isError: true,
  };
}

function getPathParam(params: Record<string, unknown>): string | undefined {
  return typeof params.path === "string" ? params.path : typeof params.file_path === "string" ? params.file_path : undefined;
}

function getCommandParam(params: Record<string, unknown>): string | undefined {
  return typeof params.command === "string" ? params.command : undefined;
}

function resolveProjectPath(target: string, cwd: string): string {
  return path.isAbsolute(target) ? target : path.resolve(cwd, target);
}

function normalizeMetricPath(target: string, cwd: string): string {
  const resolved = resolveProjectPath(target, cwd);
  const relative = path.relative(cwd, resolved);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) return resolved;
  return relative.split(path.sep).join("/");
}

function stringSize(value: unknown): number {
  return typeof value === "string" ? value.length : 0;
}

function adaptiveHardLimit(limit: number, kind: "tool-calls" | "read-bytes" | "files-touched" | "duplicate-reads"): number {
  if (!Number.isFinite(limit)) return Number.POSITIVE_INFINITY;
  if (limit <= 0) return 0;
  if (kind === "tool-calls") return Math.max(limit + 12, Math.ceil(limit * 1.5));
  if (kind === "read-bytes") return Math.max(limit + 120_000, Math.ceil(limit * 2));
  if (kind === "files-touched") return Math.max(limit + 2, Math.ceil(limit * 1.5));
  return Math.max(limit + 2, Math.ceil(limit * 1.5));
}

function isInspectionTool(toolName: string): boolean {
  return toolName === "read" || toolName === "grep" || toolName === "find" || toolName === "ls" || toolName === "chalin_project_discovery" || toolName === "chalin_project_snapshot" || toolName === "chalin_web_search";
}

function isToolError(result: unknown): boolean {
  return isRecord(result) && result.isError === true;
}

function roundMetric(value: number): number {
  if (!Number.isFinite(value)) return value;
  return Math.round(value * 1000) / 1000;
}

function truncateForTool(text: string, maxChars: number): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxChars) return normalized;
  return `${normalized.slice(0, Math.max(0, maxChars - 3)).trimEnd()}...`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function compressToolResult(result: unknown, toolName: string, maxChars: number): { result: unknown; outputChars: number; truncated: boolean } {
  if (!isRecord(result) || !Array.isArray(result.content)) return { result, outputChars: 0, truncated: false };
  const perToolMax = toolName === "read" ? Math.min(maxChars, 6000)
    : toolName === "grep" || toolName === "find" ? Math.min(maxChars, 5000)
      : toolName === "chalin_web_search" ? Math.min(maxChars, 7000)
        : maxChars;
  let outputChars = 0;
  let truncated = false;
  const content = result.content.map((part) => {
    if (!isRecord(part) || typeof part.text !== "string") return part;
    const compressed = compressTextTail(part.text, perToolMax, `${toolName} output`);
    outputChars += compressed.length;
    if (compressed !== part.text) truncated = true;
    return { ...part, text: compressed };
  });
  const details = isRecord(result.details) ? result.details : {};
  return { result: { ...result, content, details: { ...details, piChalinCompressed: truncated } }, outputChars, truncated };
}

function compressTextTail(text: string, maxChars: number, label: string): string {
  if (text.length <= maxChars) return text;
  const headSize = Math.floor(maxChars * 0.35);
  const tailSize = Math.floor(maxChars * 0.55);
  return [
    text.slice(0, headSize).trimEnd(),
    "",
    `[${label} compressed by pi-chalin: ${text.length} chars → ${maxChars} chars; middle omitted]`,
    "",
    text.slice(-tailSize).trimStart(),
  ].join("\n");
}
