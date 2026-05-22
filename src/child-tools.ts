import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import {
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
import { buildProjectSnapshot, formatProjectSnapshot } from "./snapshot.ts";
import { fetchWebUrls, formatWebBundle, searchWeb } from "./webfetch.ts";

const SnapshotParams = Type.Object({});
const DiscoveryParams = Type.Object({
  maxDepth: Type.Optional(Type.Number({ description: "Maximum directory depth to index. Default 4." })),
  maxEntries: Type.Optional(Type.Number({ description: "Maximum entries to return. Default 450." })),
});
const BashParams = Type.Object({
  command: Type.String({ description: "Safe shell command to execute" }),
  timeout: Type.Optional(Type.Number({ description: "Timeout in seconds" })),
});

const MeshArtifactWriteParams = Type.Object({
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

type MeshArtifactWriteParamsShape = {
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

const MeshWebSearchParams = Type.Object({
  query: Type.Optional(Type.String({ description: "Web search query." })),
  url: Type.Optional(Type.String({ description: "Single URL to fetch." })),
  urls: Type.Optional(Type.Array(Type.String(), { description: "URLs to fetch." })),
  maxSources: Type.Optional(Type.Number({ description: "Maximum search sources." })),
  depth: Type.Optional(Type.Union([Type.Literal("snippets"), Type.Literal("content")])),
  freshness: Type.Optional(Type.Union([Type.Literal("cache-ok"), Type.Literal("prefer-fresh"), Type.Literal("must-be-fresh")])),
});

interface BashGuardDetails {
  blocked: boolean;
  reason?: string;
  command: string;
  exitCode?: number | null;
}

export interface ChildToolPolicyOptions {
  cwd: string;
  maxToolCalls: number;
  budgetPolicy?: BudgetPolicy;
  agentName?: string;
  allowedTools?: string[];
  priorFilesRead?: string[];
  maxCrossStepDuplicateReads?: number;
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
  duplicateReadCount: number;
  filesRead: string[];
  readBytes: number;
  outputChars: number;
  outputTruncatedCount: number;
  filesTouched: string[];
  retriesByTool: Record<string, number>;
}

export interface ChildToolPolicy {
  cwd: string;
  maxToolCalls: number;
  agentName?: string;
  allowedTools: Set<string>;
  beforeTool(toolName: string, params: Record<string, unknown>): { allowed: true } | { allowed: false; reason: string };
  afterTool(toolName: string, result: unknown): unknown;
  metrics(): ChildToolPolicyMetrics;
}

export function createChildToolPolicy(options: ChildToolPolicyOptions): ChildToolPolicy {
  const toolCallsByName: Record<string, number> = {};
  const policyViolations: string[] = [];
  const filesRead: string[] = [];
  const filesTouched: string[] = [];
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
    return { allowed: true };
  }

  return {
    cwd: options.cwd,
    maxToolCalls: caps.maxToolCalls,
    agentName: options.agentName,
    allowedTools,
    beforeTool(toolName, params) {
      if (hasExplicitAllowlist && !allowedTools.has(toolName)) {
        activity(toolName, "blocked");
        return violation(`tool_not_allowed:${toolName}`);
      }
      if (Date.now() - startedAt >= caps.maxSeconds * 1000) {
        budgetStopCount += 1;
        activity(toolName, "blocked");
        return { allowed: false, reason: `budget_exceeded:${toolName}:max_seconds=${caps.maxSeconds}` };
      }
      if (toolCalls >= caps.maxToolCalls) {
        budgetStopCount += 1;
        activity(toolName, "blocked");
        return { allowed: false, reason: `budget_exceeded:${toolName}:max_tool_calls=${caps.maxToolCalls}` };
      }
      if (readBytes >= caps.maxReadBytes) {
        budgetStopCount += 1;
        activity(toolName, "blocked");
        return { allowed: false, reason: `budget_exceeded:${toolName}:max_read_bytes=${caps.maxReadBytes}` };
      }
      if (filesTouched.length >= caps.maxFilesTouched && (toolName === "edit" || toolName === "write")) {
        budgetStopCount += 1;
        activity(toolName, "blocked");
        return { allowed: false, reason: `budget_exceeded:${toolName}:max_files_touched=${caps.maxFilesTouched}` };
      }

      if (toolName === "bash") {
        const command = typeof params.command === "string" ? params.command : "";
        const verdict = classifyBashCommand(command);
        if (!verdict.allowed) {
          activity(toolName, "blocked");
          return violation(`bash_policy:${verdict.reason ?? "blocked"}:${command.slice(0, 140)}`);
        }
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
        if (normalizedReadPath && priorFilesRead.has(normalizedReadPath) && crossStepDuplicateReadCount >= maxCrossStepDuplicateReads) {
          budgetStopCount += 1;
          activity(toolName, "blocked");
          return { allowed: false, reason: `budget_exceeded:read:cross_step_duplicate_reads=${maxCrossStepDuplicateReads}:${normalizedReadPath}` };
        }
        if (normalizedReadPath && priorFilesRead.has(normalizedReadPath)) crossStepDuplicateReadCount += 1;
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
      const compressed = compressToolResult(result, toolName, caps.maxOutputChars);
      if (compressed.truncated) outputTruncatedCount += 1;
      outputChars += compressed.outputChars;
      if (toolName === "read") readBytes += compressed.outputChars;
      activity(toolName, "end");
      return compressed.result;
    },
    metrics() {
      return {
        toolCalls,
        toolCallsByName: { ...toolCallsByName },
        policyViolations: [...policyViolations],
        budgetStopCount,
        duplicateReadCount: filesRead.length - new Set(filesRead).size,
        filesRead: [...new Set(filesRead)].slice(0, 50),
        readBytes,
        outputChars,
        outputTruncatedCount,
        filesTouched: [...new Set(filesTouched)].slice(0, 50),
        retriesByTool: { ...retriesByTool },
      };
    },
  };
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
    ["mesh_project_discovery", createProjectDiscoveryTool(policy)],
    ["mesh_project_snapshot", createProjectSnapshotTool(policy)],
    ["bash", createGuardedBashTool(policy)],
    ["mesh_web_search", createMeshWebSearchTool(policy)],
    ["mesh_artifact_write", createMeshArtifactWriteTool(policy)],
  ];
  return tools.filter(([name]) => policy.allowedTools.has(name)).map(([, tool]) => tool);
}

export function createProjectDiscoveryTool(policy: ChildToolPolicy): ToolDefinition {
  return defineTool<typeof DiscoveryParams, unknown>({
    name: "mesh_project_discovery",
    label: "Mesh Project Discovery",
    description: "Return a raw, stack-agnostic project file index with shallow files, config-like files, test-like files, directories, and extension histogram. It does not infer architecture or framework.",
    promptSnippet: "mesh_project_discovery: get a raw non-semantic file index before deciding which files to inspect.",
    promptGuidelines: [
      "Call mesh_project_discovery before broad repository exploration.",
      "Use it as an index, not as proof of architecture.",
      "Read evidence files before making project claims.",
    ],
    parameters: DiscoveryParams,
    async execute(_toolCallId, params) {
      const gate = policy.beforeTool("mesh_project_discovery", params);
      if (!gate.allowed) return blockedToolResult(gate.reason);
      const index = buildProjectDiscoveryIndex(policy.cwd, {
        maxDepth: typeof params.maxDepth === "number" ? params.maxDepth : undefined,
        maxEntries: typeof params.maxEntries === "number" ? params.maxEntries : undefined,
      });
      return policy.afterTool("mesh_project_discovery", {
        content: [{ type: "text" as const, text: formatProjectDiscoveryIndex(index) }],
        details: { index },
      }) as never;
    },
  });
}

export function createProjectSnapshotTool(policy: ChildToolPolicy): ToolDefinition {
  return defineTool<typeof SnapshotParams, unknown>({
    name: "mesh_project_snapshot",
    label: "Mesh Project Snapshot",
    description: "Return a stack-agnostic, cached project snapshot: stack signals, test/build commands, entrypoints, high-signal files, and git context.",
    promptSnippet: "mesh_project_snapshot: get cached stack/project/git context before manual repository exploration.",
    promptGuidelines: [
      "Call mesh_project_snapshot before broad repository exploration.",
      "Use the snapshot to choose high-signal files instead of scanning the whole repository.",
    ],
    parameters: SnapshotParams,
    async execute() {
      const gate = policy.beforeTool("mesh_project_snapshot", {});
      if (!gate.allowed) return blockedToolResult(gate.reason);
      const snapshot = buildProjectSnapshot({ cwd: policy.cwd });
      return policy.afterTool("mesh_project_snapshot", {
        content: [{ type: "text" as const, text: formatProjectSnapshot(snapshot) }],
        details: { snapshot },
      }) as never;
    },
  });
}

export function createGuardedBashTool(policy: ChildToolPolicy): ToolDefinition {
  return defineTool<typeof BashParams, BashGuardDetails>({
    name: "bash",
    label: "bash (guarded)",
    description: "Run only safe inspection or explicit validation commands. Scripts, file writes, and generated readers/modifiers are blocked.",
    promptSnippet: "bash: guarded shell for git/status/list/search/test commands only; do not create scripts or modify files.",
    promptGuidelines: [
      "Use read/find/grep/ls/edit before bash when possible.",
      "Do not create Python/Node/shell scripts to inspect or modify files.",
      "Do not use bash for file edits. Use edit for targeted changes.",
    ],
    parameters: BashParams,
    async execute(_toolCallId, params, signal) {
      const gate = policy.beforeTool("bash", params);
      if (!gate.allowed) {
        return {
          content: [{ type: "text" as const, text: `Blocked by pi-chalin child policy: ${gate.reason}\nUse Pi-native read/find/grep/ls/edit tools instead, or stop and report partial findings.` }],
          details: { blocked: true, reason: gate.reason, command: params.command },
        };
      }
      const verdict = classifyBashCommand(params.command);
      if (!verdict.allowed) {
        return {
          content: [{ type: "text" as const, text: `Blocked by pi-chalin child bash guard: ${verdict.reason}\nUse Pi-native read/find/grep/ls/edit tools instead.` }],
          details: { blocked: true, reason: verdict.reason, command: params.command },
        };
      }
      const result = await runGuardedCommand(params.command, policy.cwd, Math.min(Math.max(params.timeout ?? 10, 1), 30), signal);
      return policy.afterTool("bash", {
        content: [{ type: "text" as const, text: result.text }],
        details: { blocked: false, reason: undefined, exitCode: result.exitCode, command: params.command },
      }) as never;
    },
  });
}


export function createMeshWebSearchTool(policy: ChildToolPolicy): ToolDefinition {
  return defineTool<typeof MeshWebSearchParams, unknown>({
    name: "mesh_web_search",
    label: "Mesh Web Search",
    description: "Search or fetch current web context through Exa MCP. Available only to agents with external-context capability.",
    promptSnippet: "mesh_web_search: fetch compact external evidence through Exa MCP when authorized.",
    promptGuidelines: [
      "Use mesh_web_search only when current external docs/facts or a URL are needed.",
      "Return source URLs in the handoff; do not paste raw dumps.",
    ],
    parameters: MeshWebSearchParams,
    async execute(_toolCallId, params, signal) {
      const input = isRecord(params) ? params : {};
      const gate = policy.beforeTool("mesh_web_search", input);
      if (!gate.allowed) return blockedToolResult(gate.reason);
      const urls = [
        ...(Array.isArray(params.urls) ? params.urls : []),
        ...(typeof params.url === "string" ? [params.url] : []),
      ].filter((url): url is string => typeof url === "string" && url.trim().length > 0);
      const freshness = params.freshness as "cache-ok" | "prefer-fresh" | "must-be-fresh" | undefined;
      const bundle = urls.length > 0
        ? await fetchWebUrls({ cwd: policy.cwd, urls, freshness, signal })
        : await searchWeb({ cwd: policy.cwd, query: String(params.query ?? ""), maxSources: Number(params.maxSources ?? 5), depth: params.depth as "snippets" | "content" | undefined, freshness, signal });
      return policy.afterTool("mesh_web_search", { content: [{ type: "text" as const, text: formatWebBundle(bundle) }], details: bundle }) as never;
    },
  });
}


export function createMeshArtifactWriteTool(policy: ChildToolPolicy): ToolDefinition {
  return defineTool<typeof MeshArtifactWriteParams, unknown>({
    name: "mesh_artifact_write",
    label: "Mesh Artifact Write",
    description: "Write controlled pi-chalin checkpoints, validation contracts, worker skills, or feature state for long-running work.",
    promptSnippet: "mesh_artifact_write: save compact task artifacts for resumable mesh workflows; never store raw logs or code dumps.",
    promptGuidelines: [
      "Use after a meaningful handoff, validation boundary, or worker-specific convention is discovered.",
      "Write compact human-readable summaries only. Do not store raw command output, stack traces, or code dumps.",
      "Prefer validation contracts with explicit commands and success criteria before handing work to another agent.",
    ],
    parameters: MeshArtifactWriteParams,
    async execute(_toolCallId, params: MeshArtifactWriteParamsShape) {
      const input = isRecord(params) ? params : {};
      const gate = policy.beforeTool("mesh_artifact_write", input);
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

function validateArtifactParams(params: MeshArtifactWriteParamsShape): { allowed: true } | { allowed: false; reason: string } {
  if (!params.featureId || params.featureId.length > 96) return { allowed: false, reason: "artifact_feature_id_invalid" };
  const text = [params.title, params.summary, ...(params.successCriteria ?? []), ...(params.rules ?? [])].filter(Boolean).join("\n");
  if (text.length > 3000) return { allowed: false, reason: "artifact_payload_too_large" };
  if (/\b(stdout|stderr|traceback|stack trace|returncode|subprocess|os\.environ|sys\.exit)\b/i.test(text)) return { allowed: false, reason: "artifact_raw_runtime_noise" };
  if (params.kind === "checkpoint" && !params.summary) return { allowed: false, reason: "checkpoint_summary_required" };
  if (params.kind === "validation-contract" && (!params.successCriteria?.length || !params.commands?.length)) return { allowed: false, reason: "validation_contract_requires_commands_and_success_criteria" };
  if (params.kind === "worker-skill" && (!params.summary || !params.rules?.length)) return { allowed: false, reason: "worker_skill_requires_summary_and_rules" };
  return { allowed: true };
}

function artifactToolResult(text: string, details: unknown) {
  return { content: [{ type: "text" as const, text }], details };
}

function guardTool(base: ToolDefinition<any, any, any>, toolName: string, policy: ChildToolPolicy): ToolDefinition<any, any, any> {
  return {
    ...base,
    description: `${base.description} Guarded by pi-chalin child policy: bounded calls, no script-driven inspection, and surgical writes only.`,
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

export function classifyBashCommand(command: string): { allowed: boolean; reason?: string } {
  const normalized = command.trim();
  if (!normalized) return { allowed: false, reason: "empty command" };
  if (/[;&|`$<>]/.test(normalized) || normalized.includes("$(")) return { allowed: false, reason: "shell composition, substitution, pipes, or redirection are not allowed for child agents" };
  if (/\b(?:python|python3|node|ruby|perl|php|deno|tsx|ts-node|sh|bash|zsh)\b/i.test(normalized)) return { allowed: false, reason: "creating or running ad-hoc scripts is not allowed" };
  if (/\b(?:tee|touch|mv|cp|rm|mkdir|rmdir|chmod|chown|sed\s+-i|truncate)\b/i.test(normalized)) return { allowed: false, reason: "file mutation through bash is not allowed" };

  const words = normalized.split(/\s+/);
  const first = words[0] ?? "";
  if (["pwd", "ls"].includes(first)) return { allowed: true };
  if (["grep", "rg", "find"].includes(first)) return { allowed: true };
  if (first === "cat") return words.length <= 4 ? { allowed: true } : { allowed: false, reason: "cat is allowed only for one small explicit file; prefer read" };
  if (first === "git" && isAllowedGit(words.slice(1))) return { allowed: true };
  if (isAllowedTestCommand(words)) return { allowed: true };
  return { allowed: false, reason: `command '${first}' is not in the child-agent bash allowlist` };
}

function isAllowedGit(args: string[]): boolean {
  const sub = args[0];
  return Boolean(sub && ["status", "branch", "log", "diff", "show", "rev-parse", "rev-list"].includes(sub));
}

function isAllowedTestCommand(words: string[]): boolean {
  const [cmd, ...args] = words;
  const joined = words.join(" ");
  if (cmd === "go") return args[0] === "test";
  if (cmd === "cargo") return args[0] === "test" || args[0] === "check";
  if (cmd === "pytest") return true;
  if (cmd === "mvn") return args.includes("test");
  if (cmd === "gradle") return args.includes("test");
  if (["npm", "pnpm", "yarn", "bun"].includes(cmd ?? "")) return /\b(test|vitest|jest|typecheck|lint)\b/.test(joined);
  return false;
}

function getPathParam(params: Record<string, unknown>): string | undefined {
  return typeof params.path === "string" ? params.path : typeof params.file_path === "string" ? params.file_path : undefined;
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function runGuardedCommand(command: string, cwd: string, timeoutSeconds: number, signal?: AbortSignal): Promise<{ text: string; exitCode: number | null }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, { cwd, shell: true, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    const timeout = setTimeout(() => child.kill("SIGTERM"), timeoutSeconds * 1000);
    const onAbort = () => child.kill("SIGTERM");
    signal?.addEventListener("abort", onAbort, { once: true });
    child.stdout?.on("data", (chunk) => { output += chunk.toString(); });
    child.stderr?.on("data", (chunk) => { output += chunk.toString(); });
    child.on("error", reject);
    child.on("close", (exitCode) => {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", onAbort);
      const text = output.trim();
      resolve({ exitCode, text: compressTextTail(text, 8000, "pi-chalin guarded bash") });
    });
  });
}

function compressToolResult(result: unknown, toolName: string, maxChars: number): { result: unknown; outputChars: number; truncated: boolean } {
  if (!isRecord(result) || !Array.isArray(result.content)) return { result, outputChars: 0, truncated: false };
  const perToolMax = toolName === "read" ? Math.min(maxChars, 6000)
    : toolName === "grep" || toolName === "find" ? Math.min(maxChars, 5000)
      : toolName === "mesh_web_search" ? Math.min(maxChars, 7000)
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
