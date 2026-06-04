import * as fs from "node:fs";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
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
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { ArtifactStore, type ApprovalDecisionInput, type ArtifactFeatureStatus } from "../artifacts/artifacts.ts";
import type { BudgetPolicy } from "../budget/budget.ts";
import { buildProjectDiscoveryIndex, formatProjectDiscoveryIndex } from "../project/discovery.ts";
import { createMemoryCandidate } from "../memory/memory.ts";
import { createConfiguredMemoryStore } from "../memory/memory-provider.ts";
import { loadEffectiveConfig } from "../config/config.ts";
import type { BudgetCapHit, BudgetCapName, BudgetCapSeverity, RouteExpectedEffect, ToolApprovalDecision, ToolApprovalRequest } from "../domain/schemas.ts";
import { formatInterviewResult, runChalinInterview } from "../interview/interview.ts";
import { SkillCatalog, auditSkill, formatSkillList, formatSkillShow } from "../skills/skills.ts";
import { isRecord } from "../utils/guards.ts";
import { normalizeMetricFilePath } from "../utils/paths.ts";
import { compactText } from "../utils/text.ts";
import { fetchWebUrls, formatWebBundle, searchWeb } from "../webfetch/webfetch.ts";

const ChildSkillParams = Type.Object({
  action: Type.Union([Type.Literal("list"), Type.Literal("show"), Type.Literal("search"), Type.Literal("audit")]),
  name: Type.Optional(Type.String({ description: "Skill reference for show/audit, or search text when task is omitted." })),
  task: Type.Optional(Type.String({ description: "Task text for searching matching Skills." })),
});
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

const ChalinDelegateParams = Type.Object({
  task: Type.String({ description: "Bounded objective for the nested subagent chain. Include current evidence and exact success criteria." }),
  reason: Type.String({ description: "Why this rare nested delegation is necessary instead of finishing in the current agent." }),
  expectedEffects: Type.Optional(Type.Array(Type.Union([Type.Literal("read"), Type.Literal("write"), Type.Literal("verify")]), { minItems: 1, maxItems: 3, uniqueItems: true, description: "Optional effect contract for the nested objective. Omit when the planner should infer it from task intent." })),
  requiresWorkspaceMutation: Type.Optional(Type.Boolean({ description: "True when the nested objective is expected to edit/write workspace files." })),
});

const ChalinInterviewChoiceParams = Type.Object({
  label: Type.String(),
  value: Type.Optional(Type.String()),
  recommended: Type.Optional(Type.Boolean()),
});
const ChalinInterviewQuestionParams = Type.Object({
  id: Type.Optional(Type.String()),
  question: Type.String(),
  choices: Type.Array(ChalinInterviewChoiceParams),
  allowCustom: Type.Optional(Type.Boolean()),
});
const ChalinInterviewParams = Type.Object({
  featureId: Type.Optional(Type.String()),
  task: Type.String(),
  reason: Type.String(),
  questions: Type.Array(ChalinInterviewQuestionParams),
  batchSize: Type.Optional(Type.Number()),
});
const ChalinApprovalRequestParams = Type.Object({
  targetToolName: Type.String({ description: "Tool that would perform the action after approval, e.g. bash, edit, write, read." }),
  reason: Type.String({ description: "Why the current subagent judges this exact action needs human approval before execution." }),
  risk: Type.Union([Type.Literal("medium"), Type.Literal("high"), Type.Literal("critical")]),
  command: Type.Optional(Type.String({ description: "Exact bash command to approve when targetToolName is bash." })),
  path: Type.Optional(Type.String({ description: "Exact path to approve when targetToolName is a path-based tool." })),
  actionDescription: Type.Optional(Type.String({ description: "Short user-facing description of the intended action." })),
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

type ChalinApprovalRequestParamsShape = {
  targetToolName: string;
  reason: string;
  risk: ChildToolApprovalRequest["risk"];
  command?: string;
  path?: string;
  actionDescription?: string;
};

export type ChalinDelegateParamsShape = {
  task: string;
  reason: string;
  expectedEffects?: RouteExpectedEffect[];
  requiresWorkspaceMutation?: boolean;
};

export interface ChildToolPolicyOptions {
  cwd: string;
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
  workUnitScope?: {
    files: string[];
    mode: "strict";
    bash: "deny" | "allow-with-postcheck";
  };
  onActivity?: (activity: ChildToolActivity) => void;
}

export interface ChildToolActivity {
  toolName: string;
  phase: "start" | "end" | "blocked" | "approval";
  at: number;
  reason?: string;
  paramsSummary?: string;
}

export type ChildToolApprovalRequest = ToolApprovalRequest;
export type ChildToolApprovalDecision = ToolApprovalDecision;

type ChildToolGate =
  | { allowed: true }
  | { allowed: false; reason: string; approvalRequired?: ChildToolApprovalRequest };

export interface ChildToolPolicyMetrics {
  toolCalls: number;
  toolCallsByName: Record<string, number>;
  policyViolations: string[];
  approvalRequests: ChildToolApprovalRequest[];
  approvalDecisions: ChildToolApprovalDecision[];
  budgetCapHits: BudgetCapHit[];
  duplicateReadCount: number;
  filesRead: string[];
  readBytes: number;
  outputChars: number;
  outputCharsByToolName: Record<string, number>;
  outputTruncatedCount: number;
  filesTouched: string[];
  shellCommands: string[];
  postMutationShellCommands: number;
  successfulPostMutationShellCommands: number;
  retriesByTool: Record<string, number>;
}

export interface ChildToolPolicy {
  cwd: string;
  agentName?: string;
  allowedTools: Set<string>;
  subagentDelegation?: ChildToolPolicyOptions["subagentDelegation"];
  beforeTool(toolName: string, params: Record<string, unknown>): ChildToolGate;
  afterTool(toolName: string, result: unknown): unknown;
  pendingApproval(): ChildToolApprovalRequest | undefined;
  requestApproval(input: ChalinApprovalRequestParamsShape): ChildToolApprovalRequest | undefined;
  approveAction(input: Omit<ChildToolApprovalDecision, "decision" | "decidedAt" | "consumed">): ChildToolApprovalDecision | undefined;
  rejectAction(input: Omit<ChildToolApprovalDecision, "decision" | "decidedAt" | "consumed">): ChildToolApprovalDecision | undefined;
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
  const pendingShellCommands: Array<{ command?: string; afterMutation: boolean; dirtyBaseline?: string[] }> = [];
  const approvalRequests: ChildToolApprovalRequest[] = [];
  const approvalDecisions: ChildToolApprovalDecision[] = [];
  const retriesByTool: Record<string, number> = {};
  const readCallsBySignature: Record<string, number> = {};
  const allowedTools = new Set(options.allowedTools ?? []);
  allowedTools.add("chalin_interview");
  allowedTools.add("chalin_request_approval");
  const priorFilesRead = new Set((options.priorFilesRead ?? []).map((item) => normalizeMetricPath(item, options.cwd)));
  const workUnitScope = normalizeWorkUnitScope(options.workUnitScope, options.cwd);
  const maxCrossStepDuplicateReads = options.maxCrossStepDuplicateReads ?? Number.POSITIVE_INFINITY;
  const hasExplicitAllowlist = options.allowedTools !== undefined;
  let toolCalls = 0;
  let readBytes = 0;
  let outputChars = 0;
  const outputCharsByToolName: Record<string, number> = {};
  let outputTruncatedCount = 0;
  let crossStepDuplicateReadCount = 0;
  let mutationSucceeded = false;
  let postMutationShellCommands = 0;
  let successfulPostMutationShellCommands = 0;
  let terminalPolicyViolation: string | undefined;
  const caps = options.budgetPolicy?.caps ?? {
    maxSeconds: Number.POSITIVE_INFINITY,
    maxUsd: Number.POSITIVE_INFINITY,
    maxTurns: Number.POSITIVE_INFINITY,
    maxOutputChars: 12_000,
    maxReadBytes: 120_000,
    maxFilesTouched: 8,
    maxRetriesPerTool: 2,
  };

  function violation(reason: string): ChildToolGate {
    policyViolations.push(reason);
    if (isTerminalToolPolicyViolation(reason)) terminalPolicyViolation ??= reason;
    return { allowed: false, reason };
  }

  function approvalRequired(toolName: string, reason: string, params: Record<string, unknown>, risk: ChildToolApprovalRequest["risk"] = "high"): ChildToolGate {
    const request = makeApprovalRequest(toolName, reason, params, risk, options.cwd);
    approvalRequests.push(request);
    const approvalReason = `approval_required:${reason}`;
    policyViolations.push(approvalReason);
    activity(toolName, "approval", approvalReason, params);
    return { allowed: false, reason: approvalReason, approvalRequired: request };
  }

  function requestApproval(input: ChalinApprovalRequestParamsShape): ChildToolApprovalRequest | undefined {
    const targetToolName = input.targetToolName.trim();
    const reason = compactApprovalReason(input.reason);
    if (!targetToolName || !reason) return undefined;
    const params = approvalTargetParams(input);
    const request = makeApprovalRequest(targetToolName, `llm_declared_risky_action:${reason}`, params, input.risk, options.cwd, input.actionDescription);
    approvalRequests.push(request);
    const approvalReason = `approval_required:${request.reason}`;
    policyViolations.push(approvalReason);
    activity(targetToolName, "approval", approvalReason, params);
    return request;
  }

  function decideAction(input: Omit<ChildToolApprovalDecision, "decision" | "decidedAt" | "consumed">, decision: ChildToolApprovalDecision["decision"]): ChildToolApprovalDecision | undefined {
    const request = approvalRequests.find((item) => item.id === input.requestId);
    if (!request) return undefined;
    const record: ChildToolApprovalDecision = {
      ...input,
      decision,
      decidedAt: new Date().toISOString(),
      consumed: false,
    };
    approvalDecisions.push(record);
    return record;
  }

  function consumeApprovedAction(toolName: string, params: Record<string, unknown>): boolean {
    const fingerprint = actionFingerprint(toolName, params, options.cwd);
    const declared = isRecord(params.piChalinApproval) ? params.piChalinApproval : undefined;
    for (const decision of approvalDecisions) {
      if (decision.decision !== "approved" || decision.consumed) continue;
      const request = approvalRequests.find((item) => item.id === decision.requestId);
      if (!request) continue;
      const exact = request.paramsFingerprint === fingerprint;
      const declaredEquivalent = declared
        && declared.requestId === decision.requestId
        && typeof declared.equivalenceReason === "string"
        && declared.equivalenceReason.trim().length > 0;
      if (!exact && !declaredEquivalent) continue;
      decision.consumed = true;
      if (declaredEquivalent) decision.equivalenceReason = String(declared.equivalenceReason);
      return true;
    }
    return false;
  }

  function latestPendingApproval(): ChildToolApprovalRequest | undefined {
    return [...approvalRequests].reverse().find((request) => !approvalDecisions.some((decision) => decision.requestId === request.id));
  }

  function priorDeclaredApprovalForAction(toolName: string, params: Record<string, unknown>): ChildToolApprovalRequest | undefined {
    const fingerprint = actionFingerprint(toolName, params, options.cwd);
    return [...approvalRequests]
      .reverse()
      .find((request) => request.toolName === toolName
        && request.paramsFingerprint === fingerprint
        && request.reason.startsWith("llm_declared_risky_action:"));
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

  function budgetWarn(toolName: string, name: BudgetCapName, used: number, limit: number, phase: BudgetCapHit["phase"] = "pre-tool", reason?: string): void {
    recordBudgetCapHit({ name, used, limit, severity: "soft", phase, toolName, reason });
  }

  function activity(toolName: string, phase: ChildToolActivity["phase"], reason?: string, params?: Record<string, unknown>): void {
    options.onActivity?.({
      toolName,
      phase,
      at: Date.now(),
      ...(reason ? { reason } : {}),
      ...(params ? { paramsSummary: summarizeBlockedToolParams(toolName, params) } : {}),
    });
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
      pendingShellCommands.push({
        command,
        afterMutation: mutationSucceeded,
        ...(workUnitScope ? { dirtyBaseline: workspaceDirtyPaths(options.cwd) } : {}),
      });
    }
    return { allowed: true };
  }

  return {
    cwd: options.cwd,
    agentName: options.agentName,
    allowedTools,
    subagentDelegation: options.subagentDelegation,
    pendingApproval() {
      return latestPendingApproval();
    },
    requestApproval(input) {
      return requestApproval(input);
    },
    approveAction(input) {
      return decideAction(input, "approved");
    },
    rejectAction(input) {
      return decideAction(input, "rejected");
    },
    beforeTool(toolName, params) {
      normalizeSafeToolParams(toolName, params, options.cwd);
      const secretRead = secretReadIntentViolation(toolName, params, options.cwd);
      if (secretRead) {
        activity(toolName, "blocked", secretRead, params);
        return violation(secretRead);
      }
      if (consumeApprovedAction(toolName, params)) return record(toolName, params);
      const pendingApproval = latestPendingApproval();
      if (pendingApproval && toolName !== "chalin_interview") {
        const reason = `approval_required:${pendingApproval.reason}`;
        activity(toolName, "approval", reason, params);
        return { allowed: false, reason, approvalRequired: pendingApproval };
      }
      const declaredApproval = priorDeclaredApprovalForAction(toolName, params);
      if (declaredApproval) {
        return approvalRequired(toolName, declaredApproval.reason, params, declaredApproval.risk);
      }
      if (terminalPolicyViolation) {
        const reason = `policy_stopped_after_scope_violation:${terminalPolicyViolation}`;
        activity(toolName, "blocked", reason, params);
        return violation(reason);
      }
      if (hasExplicitAllowlist && !allowedTools.has(toolName)) {
        const reason = `tool_not_allowed:${toolName}`;
        activity(toolName, "blocked", reason, params);
        return violation(reason);
      }
      if (isInspectionTool(toolName) && readBytes >= caps.maxReadBytes) {
        budgetWarn(toolName, "max_read_bytes", readBytes, caps.maxReadBytes, "pre-tool", "soft read budget reached; continuing");
      }
      if (filesTouched.length >= caps.maxFilesTouched && (toolName === "edit" || toolName === "write")) {
        budgetWarn(toolName, "max_files_touched", filesTouched.length, caps.maxFilesTouched, "pre-tool", "soft touched-files budget reached; continuing");
      }

      const workspacePathViolation = childWorkspacePathViolation(toolName, params, options.cwd);
      if (workspacePathViolation) {
        if (isApprovalEligibleViolation(workspacePathViolation)) return approvalRequired(toolName, workspacePathViolation, params, riskForApprovalReason(workspacePathViolation));
        activity(toolName, "blocked", workspacePathViolation, params);
        return violation(workspacePathViolation);
      }

      const workUnitScopeViolation = mutationOutsideWorkUnitScopeViolation(toolName, params, options.cwd, workUnitScope);
      if (workUnitScopeViolation) {
        return approvalRequired(toolName, workUnitScopeViolation, params, "medium");
      }

      if (toolName === "write") {
        const target = getPathParam(params);
        if (target && fs.existsSync(resolveProjectPath(target, options.cwd))) {
          const reason = `write_existing_file:${normalizeMetricPath(target, options.cwd)}`;
          activity(toolName, "blocked", reason, params);
          return violation(reason);
        }
      }

      if (toolName === "read") {
        const readPath = getPathParam(params);
        const normalizedReadPath = readPath ? normalizeMetricPath(readPath, options.cwd) : undefined;
        if (normalizedReadPath && priorFilesRead.has(normalizedReadPath)) {
          const nextDuplicateCount = crossStepDuplicateReadCount + 1;
          const hardDuplicateLimit = adaptiveHardLimit(maxCrossStepDuplicateReads, "duplicate-reads");
          if (nextDuplicateCount > hardDuplicateLimit) {
            const reason = `read_loop:${normalizedReadPath}`;
            activity("read", "blocked", reason, params);
            return violation(reason);
          }
          if (nextDuplicateCount > maxCrossStepDuplicateReads) {
            budgetWarn("read", "max_cross_step_duplicate_reads", nextDuplicateCount, maxCrossStepDuplicateReads, "pre-tool", normalizedReadPath);
          }
          crossStepDuplicateReadCount = nextDuplicateCount;
        }
        if (normalizedReadPath) {
          const readSignature = sameStepReadSignature(normalizedReadPath, params);
          const nextReadCount = (readCallsBySignature[readSignature] ?? 0) + 1;
          if (nextReadCount > sameStepReadLoopLimit()) {
            const reason = `read_loop:${normalizedReadPath}`;
            activity("read", "blocked", reason, params);
            return violation(reason);
          }
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
          const reason = `large_edit_block:${normalizeMetricPath(getPathParam(params) ?? "unknown", options.cwd)}`;
          activity(toolName, "blocked", reason, params);
          return violation(reason);
        }
      }

      const recorded = record(toolName, params);
      if (toolName === "read") {
        const readPath = getPathParam(params);
        const normalizedReadPath = readPath ? normalizeMetricPath(readPath, options.cwd) : undefined;
        if (normalizedReadPath) {
          const readSignature = sameStepReadSignature(normalizedReadPath, params);
          readCallsBySignature[readSignature] = (readCallsBySignature[readSignature] ?? 0) + 1;
        }
      }
      activity(toolName, "start");
      return recorded;
    },
    afterTool(toolName, result) {
      let nextResult = result;
      if ((toolName === "edit" || toolName === "write") && !isToolError(result)) mutationSucceeded = true;
      if (toolName === "bash") {
        const pending = pendingShellCommands.shift();
        if (pending?.dirtyBaseline && !isToolError(result)) {
          const scopeViolations = dirtyEntriesOutsideWorkUnitScope(workspaceDirtyEntries(options.cwd), pending.dirtyBaseline, workUnitScope, options.cwd);
          if (scopeViolations.length > 0) {
            const reason = `outside_work_unit_scope:${scopeViolations.slice(0, 8).join(",")}${scopeViolations.length > 8 ? `,+${scopeViolations.length - 8}` : ""}`;
            const request = makeApprovalRequest(toolName, reason, pending.command ? { command: pending.command } : {}, "medium", options.cwd);
            approvalRequests.push(request);
            const approvalReason = `approval_required:${reason}`;
            policyViolations.push(approvalReason);
            activity(toolName, "approval", approvalReason, pending.command ? { command: pending.command } : {});
            nextResult = appendToolResultApprovalRequired(nextResult, request);
          }
        }
        if (pending?.afterMutation) {
          postMutationShellCommands += 1;
          if (!isToolError(nextResult)) successfulPostMutationShellCommands += 1;
        }
      }
      const compressed = compressToolResult(nextResult, toolName, caps.maxOutputChars);
      if (compressed.truncated) outputTruncatedCount += 1;
      outputChars += compressed.outputChars;
      outputCharsByToolName[toolName] = (outputCharsByToolName[toolName] ?? 0) + compressed.outputChars;
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
        approvalRequests: [...approvalRequests],
        approvalDecisions: approvalDecisions.map((decision) => ({ ...decision })),
        budgetCapHits: budgetCapHits.slice(0, 30),
        duplicateReadCount: filesRead.length - new Set(filesRead).size,
        filesRead: [...new Set(filesRead)].slice(0, 50),
        readBytes,
        outputChars,
        outputCharsByToolName: { ...outputCharsByToolName },
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
    ["bash", guardTool(createBashToolDefinition(policy.cwd), "bash", policy)],
    ["chalin_web_search", createChalinWebSearchTool(policy)],
    ["chalin_request_approval", createChalinApprovalRequestTool(policy)],
    ["chalin_interview", createChalinInterviewTool(policy)],
    ["chalin_artifact_write", createChalinArtifactWriteTool(policy)],
    ["chalin_delegate", createChalinDelegateTool(policy)],
    ["chalin_memory_search", createChalinMemorySearchTool(policy)],
    ["chalin_memory_write", createChalinMemoryWriteTool(policy)],
    ["chalin_memory_revise", createChalinMemoryReviseTool(policy)],
    ["chalin_skill", createChalinSkillTool(policy)],
  ];
  return tools
    .filter(([name]) => policy.allowedTools.has(name))
    .map(([, tool]) => tool);
}

function createChalinApprovalRequestTool(policy: ChildToolPolicy): ToolDefinition {
  return defineTool<typeof ChalinApprovalRequestParams, unknown>({
    name: "chalin_request_approval",
    label: "Chalin Approval Request",
    description: "Declare that the current subagent judges a concrete next tool action unsafe to run without a one-shot human approval.",
    promptSnippet: "chalin_request_approval: before empirical or externally risky actions, declare the exact next action and then ask via chalin_interview.",
    promptGuidelines: [
      "Use when your semantic judgment says the next action may affect external services, irreversible state, credentials, history, data, or broad project files.",
      "Do not wait for the harness to classify command names. You own the judgment; the harness only records and gates the one-shot approval.",
      "After this returns approval_required, immediately call chalin_interview with approve/reject choices in the user's language.",
      "If approved, retry only the exact declared target action once. If rejected, stop the WorkUnit as blocked by human decision.",
    ],
    parameters: ChalinApprovalRequestParams,
    async execute(_toolCallId, params) {
      const input = isRecord(params) ? params : {};
      const gate = policy.beforeTool("chalin_request_approval", input);
      if (!gate.allowed) return blockedToolResult(gate.reason);
      const request = policy.requestApproval(params);
      if (!request) return blockedToolResult("approval_request_invalid");
      return blockedToolResult(`approval_required:${request.reason}`);
    },
  });
}

function createChalinInterviewTool(policy: ChildToolPolicy): ToolDefinition {
  return defineTool<typeof ChalinInterviewParams, unknown>({
    name: "chalin_interview",
    label: "Chalin Interview",
    description: "Ask the user a blocking approval or clarification question from inside the current subagent. Always available for one-shot risky-action approvals.",
    promptSnippet: "chalin_interview: ask one minimal approval question when pi-chalin returns approval_required; approve/reject is one-shot for that exact action.",
    promptGuidelines: [
      "Use immediately when a tool returns approval_required.",
      "Ask one minimal question: action, risk, affected file/service, approve or reject.",
      "Write the question and labels in the user's language; keep approval choice values exactly approve or reject.",
      "If rejected, stop the WorkUnit as blocked by human decision; do not workaround.",
    ],
    parameters: ChalinInterviewParams,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const input = isRecord(params) ? params : {};
      const gate = policy.beforeTool("chalin_interview", input);
      if (!gate.allowed) return blockedToolResult(gate.reason);
      const store = new ArtifactStore({ cwd: policy.cwd });
      const pending = policy.pendingApproval();
      const request = pending ? approvalInterviewInput(params, pending) : params;
      const result = await runChalinInterview(ctx as ExtensionContext, store, request);
      if (pending && result.status === "answered") {
        const approved = result.answers.some((answer) => answer.answer.toLowerCase() === "approve");
        const rejected = result.answers.some((answer) => answer.answer.toLowerCase() === "reject");
        let decision: ChildToolApprovalDecision | undefined;
        if (approved) {
          decision = policy.approveAction({
            requestId: pending.id,
            approvedAction: pending.actionDescription,
            retriedAction: pending.actionDescription,
            equivalenceReason: "user approved the pending action through chalin_interview",
            decidedBy: policy.agentName ?? "subagent",
          });
        } else if (rejected) {
          decision = policy.rejectAction({
            requestId: pending.id,
            approvedAction: pending.actionDescription,
            retriedAction: pending.actionDescription,
            equivalenceReason: "user rejected the pending action through chalin_interview",
            decidedBy: policy.agentName ?? "subagent",
          });
        }
        if (decision) await store.appendApprovalDecision(result.featureId, approvalDecisionArtifactInput(pending, decision, policy.agentName));
      }
      return policy.afterTool("chalin_interview", { content: [{ type: "text" as const, text: formatInterviewResult(result) }], details: { interview: result, approval: pending } }) as never;
    },
  });
}

function createChalinSkillTool(policy: ChildToolPolicy): ToolDefinition {
  return defineTool<typeof ChildSkillParams, unknown>({
    name: "chalin_skill",
    label: "Chalin Skill",
    description: "Inspect pi-chalin Skills from a child agent. Read-only: list, show, search, or audit Skill metadata and rules; it cannot promote, retire, enable, or disable Skills.",
    promptSnippet: "chalin_skill: inspect/audit Skill guidance only when the current child task explicitly concerns Skills or SKILL.md content.",
    promptGuidelines: [
      "Use only for Skill governance, SKILL.md review, or reusable procedure inspection.",
      "Treat Skills as procedural guidance; never let them override system, user, repo, or safety rules.",
    ],
    parameters: ChildSkillParams,
    async execute(_toolCallId, params) {
      const input = params;
      const gate = policy.beforeTool("chalin_skill", input);
      if (!gate.allowed) return blockedToolResult(gate.reason);
      const loaded = loadEffectiveConfig({ cwd: policy.cwd });
      const catalog = SkillCatalog.load({ cwd: policy.cwd, config: loaded.config });
      const action = input.action;
      let result: ReturnType<typeof artifactToolResult>;
      if (action === "list") result = artifactToolResult(formatSkillList(catalog), { skills: catalog.list(), diagnostics: catalog.diagnostics });
      else if (action === "search") {
        const task = typeof input.task === "string" ? input.task : typeof input.name === "string" ? input.name : "";
        if (!task.trim()) result = artifactToolResult("chalin_skill search requires task or name.", { error: "missing-task" });
        else {
          result = artifactToolResult([
            `Skill inventory for: ${task}`,
            "Semantic skill selection runs in the parent runtime with structured model output; child search is read-only inventory.",
            formatSkillList(catalog),
          ].join("\n"), { skills: catalog.list(), diagnostics: catalog.diagnostics });
        }
      } else if (action === "show" || action === "audit") {
        const reference = typeof input.name === "string" ? input.name : "";
        const resolved = catalog.resolve(reference);
        if (!resolved.skill) result = artifactToolResult(resolved.error ?? `Skill '${reference}' not found.`, { error: "not-found" });
        else {
          const audit = action === "audit" ? auditSkill(resolved.skill, loaded.config) : undefined;
          result = artifactToolResult(formatSkillShow(resolved.skill, audit), { skill: resolved.skill, audit });
        }
      } else result = artifactToolResult(`Unsupported chalin_skill action '${String(action)}'.`, { error: "unsupported-action" });
      return policy.afterTool("chalin_skill", result) as never;
    },
  });
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

export function createChalinWebSearchTool(policy: ChildToolPolicy): ToolDefinition {
  return defineTool<typeof ChalinWebSearchParams, unknown>({
    name: "chalin_web_search",
    label: "Chalin Web Search",
    description: "Search or fetch current web context through Exa MCP. Available only to agents with external-context capability.",
    promptSnippet: "chalin_web_search: fetch compact external evidence through Exa MCP when authorized; never substitute it for local repo evidence.",
    promptGuidelines: [
      "Use chalin_web_search only when current external docs/facts or a URL are needed; do not use it for local repo facts or when the task asks for repository evidence.",
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
    description: "Rare nested pi-chalin delegation for a coordinating subagent that discovers the assigned scope exceeds one reliable ownership boundary. Only one visible nested level is allowed; deeper needs return to the parent orchestrator as compact handoff.",
    promptSnippet: "chalin_delegate: delegate an overlarge nested objective by intent when current evidence proves one agent would reduce quality.",
    promptGuidelines: [
      "This is exceptional, not a normal path. Prefer finishing the current task yourself when the scope is bounded.",
      "Use only after current evidence shows the scope is independently splittable, under-specified for safe continuation, or review/isolation-heavy enough that one worker would lower quality.",
      "Pass current evidence, exact files/surfaces, ownership boundaries, effects, and success criteria in the task. Do not choose topology, agents, steps, stages, or budgets.",
      "Do not use it to avoid ordinary implementation work, repeat broad discovery, or create another planning layer without a clear output contract.",
      "Nested delegation stops after one child level under the current parent; if blocked by depth, return a compact handoff and ask the parent orchestrator to continue.",
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
        ? `memory ${record.status}: ${record.id} · ${record.category} · ${compactText(record.content, 220)}`
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
        ? `memory revised: ${record.id} · ${record.status} · rev=${record.revisionCount} · ${compactText(record.content, 220)}`
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
  return { allowed: true };
}

function validateMemoryRevisionParams(params: ChalinMemoryReviseParamsShape): { allowed: true } | { allowed: false; reason: string } {
  const text = [params.id, params.category, params.content, params.evidence, params.reason].filter(Boolean).join("\n");
  if (!params.id || params.id.length > 120) return { allowed: false, reason: "memory_revision_id_invalid" };
  if (!params.content || params.content.length < 48 || params.content.length > 600) return { allowed: false, reason: "memory_revision_content_must_be_48_to_600_chars" };
  if (text.length > 1400) return { allowed: false, reason: "memory_revision_payload_too_large" };
  return { allowed: true };
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
      toolName === "write" ? "Use only for paths that do not exist yet. Existing paths are blocked; use edit for existing files, including full-content replacements." : undefined,
      "Treat the pi-chalin child tool budget as advisory telemetry; continue when the next action has clear expected value and emit recoverable handoff state when pressure rises.",
      "Prefer targeted inspection over broad crawls.",
    ].filter((item): item is string => Boolean(item)),
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
  if (reason.startsWith("approval_required:")) {
    return {
      content: [{
        type: "text" as const,
        text: [
          `pi-chalin approval required: ${reason.slice("approval_required:".length)}`,
          "Call chalin_interview now with one minimal approve/reject question. If approved, retry the same action once. If rejected, stop this WorkUnit as blocked by human decision.",
        ].join("\n"),
      }],
      details: { approvalRequired: true, reason },
    };
  }
  const guidance = reason.startsWith("work_unit_scope_gap:")
    ? "Report the missing WorkUnit scope/dependency in ## Agent Handoff and stop instead of editing outside the unit."
    : reason.startsWith("policy_stopped_after_scope_violation:")
      ? "A prior scope violation made this step terminal. Return ## Agent Handoff with the exact missing scope/dependency; do not call more tools."
    : "Stop if you have enough evidence; otherwise use fewer, more targeted Pi-native tools.";
  return {
    content: [{ type: "text" as const, text: `Blocked by pi-chalin child policy: ${reason}\n${guidance}` }],
    details: { blocked: true, reason },
    isError: true,
  };
}

function approvalInterviewInput(params: {
  featureId?: string;
  task: string;
  reason: string;
  questions: Array<{ id?: string; question: string; choices: Array<{ label: string; value?: string; recommended?: boolean }>; allowCustom?: boolean }>;
  batchSize?: number;
}, request: ChildToolApprovalRequest) {
  const providedQuestion = params.questions.find((question) => (
    question.choices.some((choice) => choice.value === "approve")
    && question.choices.some((choice) => choice.value === "reject")
  ));
  const approveChoice = providedQuestion?.choices.find((choice) => choice.value === "approve");
  const rejectChoice = providedQuestion?.choices.find((choice) => choice.value === "reject");
  return {
    featureId: params.featureId ?? `approval-${request.id}`,
    task: params.task || `Approve ${request.toolName} action`,
    reason: params.reason || request.semanticDescription,
    batchSize: 1,
    questions: [{
      id: "approval",
      question: providedQuestion?.question.trim() || `${request.semanticDescription}. Risk: ${request.risk}.`,
      allowCustom: false,
      choices: [
        { label: approveChoice?.label ?? "Approve once", value: "approve", recommended: approveChoice?.recommended ?? true },
        { label: rejectChoice?.label ?? "Reject", value: "reject", recommended: rejectChoice?.recommended },
      ],
    }],
  };
}

function approvalDecisionArtifactInput(request: ChildToolApprovalRequest, decision: ChildToolApprovalDecision, fallbackAgent?: string): ApprovalDecisionInput {
  return {
    requestId: request.id,
    decision: decision.decision,
    toolName: request.toolName,
    reason: request.reason,
    risk: request.risk,
    approvedAction: decision.approvedAction,
    retriedAction: decision.retriedAction,
    equivalenceReason: decision.equivalenceReason,
    subagentId: decision.decidedBy ?? fallbackAgent ?? "subagent",
    paramsSummary: request.paramsSummary,
  };
}

function makeApprovalRequest(toolName: string, reason: string, params: Record<string, unknown>, risk: ChildToolApprovalRequest["risk"], cwd: string, actionOverride?: string): ChildToolApprovalRequest {
  const paramsSummary = summarizeBlockedToolParams(toolName, params);
  const description = compactText(actionOverride ?? "", 180) || actionDescription(toolName, params, reason, cwd);
  return {
    id: `approval-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    toolName,
    reason,
    risk,
    actionDescription: description,
    semanticDescription: description,
    paramsSummary,
    paramsFingerprint: actionFingerprint(toolName, params, cwd),
    createdAt: new Date().toISOString(),
  };
}

function actionDescription(toolName: string, params: Record<string, unknown>, reason: string, cwd: string): string {
  const command = getCommandParam(params);
  if (command) return `${toolName}: ${compactText(command, 180)}`;
  const target = getPathParam(params);
  if (target) return `${toolName}: ${normalizeMetricPath(target, cwd)} (${reason})`;
  return `${toolName}: ${compactText(reason, 180)}`;
}

function actionFingerprint(toolName: string, params: Record<string, unknown>, cwd: string): string {
  const normalized = normalizeActionParams(toolName, params, cwd);
  return JSON.stringify(sortJson(normalized));
}

function normalizeActionParams(toolName: string, params: Record<string, unknown>, cwd: string): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(params)) {
    if (key === "piChalinApproval") continue;
    if ((key === "path" || key === "file_path") && typeof value === "string") result[key] = normalizeMetricPath(value, cwd);
    else if (key === "command" && typeof value === "string") result[key] = value.replace(/\s+/g, " ").trim();
    else result[key] = value;
  }
  return { toolName, params: result };
}

function approvalTargetParams(input: ChalinApprovalRequestParamsShape): Record<string, unknown> {
  const params: Record<string, unknown> = {};
  if (typeof input.command === "string" && input.command.trim()) params.command = input.command;
  if (typeof input.path === "string" && input.path.trim()) params.path = input.path;
  if (Object.keys(params).length === 0 && typeof input.actionDescription === "string" && input.actionDescription.trim()) {
    params.actionDescription = input.actionDescription;
  }
  return params;
}

function compactApprovalReason(reason: string): string {
  return compactText(reason, 180).replace(/:/g, " -");
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (!isRecord(value)) return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortJson(value[key])]));
}

function isApprovalEligibleViolation(reason: string): boolean {
  return reason.startsWith("outside_workspace_path:")
    || reason.startsWith("internal_harness_path:")
    || reason.startsWith("work_unit_scope_gap:")
    || reason.startsWith("outside_work_unit_scope:")
    || reason === "bash_denied_for_work_unit_scope";
}

function riskForApprovalReason(reason: string): ChildToolApprovalRequest["risk"] {
  if (reason.startsWith("outside_workspace_path:") || reason.startsWith("internal_harness_path:")) return "high";
  return "medium";
}

function secretReadIntentViolation(toolName: string, params: Record<string, unknown>, cwd: string): string | undefined {
  if (toolName === "read") {
    const target = getPathParam(params);
    if (target && isSecretPath(target, cwd)) return `secret_read_intent:${normalizeMetricPath(target, cwd)}`;
  }
  if (toolName !== "bash") return undefined;
  const command = getCommandParam(params);
  if (!command) return undefined;
  for (const word of shellWords(command)) {
    if (isSecretPath(word, cwd)) return "secret_read_intent:shell";
  }
  return undefined;
}

function isSecretPath(target: string, cwd: string): boolean {
  const normalized = normalizeMetricPath(target.replace(/^['"]|['"]$/g, ""), cwd).replaceAll("\\", "/");
  const base = normalized.split("/").filter(Boolean).at(-1)?.toLowerCase() ?? normalized.toLowerCase();
  return base === ".env"
    || base.startsWith(".env.")
    || base.endsWith(".pem")
    || base.endsWith(".key")
    || normalized.toLowerCase().includes("/.ssh/");
}

function isTerminalToolPolicyViolation(reason: string): boolean {
  return reason.startsWith("work_unit_scope_gap:")
    || reason.startsWith("outside_work_unit_scope:")
    || reason === "bash_denied_for_work_unit_scope";
}

function appendToolResultApprovalRequired(result: unknown, request: ChildToolApprovalRequest): unknown {
  const text = [
    `pi-chalin approval required: ${request.reason}`,
    `Action: ${request.actionDescription}`,
    "Call chalin_interview now. If approved, retry this action once; if rejected, stop this WorkUnit as blocked by human decision.",
  ].join("\n");
  if (!isRecord(result) || !Array.isArray(result.content)) {
    return {
      content: [{ type: "text" as const, text }],
      details: { approvalRequired: request },
    };
  }
  const details = isRecord(result.details) ? result.details : {};
  return {
    ...result,
    content: [...result.content, { type: "text" as const, text }],
    details: { ...details, approvalRequired: request },
  };
}

function getPathParam(params: Record<string, unknown>): string | undefined {
  return typeof params.path === "string" ? params.path : typeof params.file_path === "string" ? params.file_path : undefined;
}

function getCommandParam(params: Record<string, unknown>): string | undefined {
  return typeof params.command === "string" ? params.command : undefined;
}

function normalizeSafeToolParams(toolName: string, params: Record<string, unknown>, cwd: string): void {
  if (toolName === "bash" && typeof params.command === "string") {
    const normalized = stripLeadingCurrentWorkspaceCd(params.command, cwd);
    if (normalized !== params.command) params.command = normalized;
    return;
  }
  normalizeWorkspacePathParam(params, "path", cwd);
  normalizeWorkspacePathParam(params, "file_path", cwd);
}

function normalizeWorkspacePathParam(params: Record<string, unknown>, key: string, cwd: string): void {
  const target = params[key];
  if (typeof target !== "string" || !path.isAbsolute(target) || isOutsideWorkspacePath(target, cwd)) return;
  params[key] = normalizeMetricPath(target, cwd);
}

function stripLeadingCurrentWorkspaceCd(command: string, cwd: string): string {
  const andIndex = command.indexOf("&&");
  if (andIndex < 0) return command;
  const left = command.slice(0, andIndex).trim();
  const right = command.slice(andIndex + 2).trimStart();
  const words = shellWords(left);
  if (words.length !== 2 || path.basename(words[0]!) !== "cd") return command;
  return isSameWorkspacePath(words[1]!, cwd) ? right : command;
}

function isSameWorkspacePath(target: string, cwd: string): boolean {
  if (!path.isAbsolute(target)) return false;
  return path.resolve(target) === path.resolve(cwd) || safeRealpath(target) === safeRealpath(cwd);
}

function sameStepReadSignature(normalizedPath: string, params: Record<string, unknown>): string {
  const offset = Number.isFinite(params.offset) ? Number(params.offset) : "full";
  const limit = Number.isFinite(params.limit) ? Number(params.limit) : "full";
  return `${normalizedPath}@${offset}:${limit}`;
}

type NormalizedWorkUnitScope = {
  files: Set<string>;
  directories: string[];
  bash: "deny" | "allow-with-postcheck";
};

function normalizeWorkUnitScope(scope: ChildToolPolicyOptions["workUnitScope"], cwd: string): NormalizedWorkUnitScope | undefined {
  if (!scope || scope.mode !== "strict" || scope.files.length === 0) return undefined;
  const files = new Set<string>();
  const directories: string[] = [];
  for (const file of scope.files) {
    const normalized = normalizeMetricPath(file, cwd).replace(/\/+$/, "");
    if (!normalized) continue;
    if (file.trim().endsWith("/") || isExistingDirectoryPath(file, cwd)) directories.push(`${normalized}/`);
    else files.add(normalized);
  }
  if (files.size === 0 && directories.length === 0) return undefined;
  return { files, directories, bash: scope.bash };
}

function isExistingDirectoryPath(target: string, cwd: string): boolean {
  try {
    return fs.statSync(resolveProjectPath(target, cwd)).isDirectory();
  } catch {
    return false;
  }
}

function mutationOutsideWorkUnitScopeViolation(toolName: string, params: Record<string, unknown>, cwd: string, scope: NormalizedWorkUnitScope | undefined): string | undefined {
  if (!scope) return undefined;
  if (toolName === "bash" && scope.bash === "deny") return "bash_denied_for_work_unit_scope";
  if (toolName !== "edit" && toolName !== "write") return undefined;
  const target = getPathParam(params);
  const normalized = target ? normalizeMetricPath(target, cwd) : undefined;
  if (!normalized) return "work_unit_scope_gap:unknown";
  return isPathInsideWorkUnitScope(normalized, scope) ? undefined : `work_unit_scope_gap:${normalized}`;
}

function dirtyEntriesOutsideWorkUnitScope(currentDirtyEntries: WorkspaceDirtyEntry[], baselineDirtyPaths: string[], scope: NormalizedWorkUnitScope | undefined, cwd: string): string[] {
  if (!scope) return [];
  const baseline = new Set(baselineDirtyPaths.map(normalizeMetricFilePath));
  return currentDirtyEntries
    .map((entry) => ({ status: entry.status, path: normalizeMetricFilePath(entry.path) }))
    .filter((entry) => entry.path.length > 0)
    .filter((entry) => !entry.path.startsWith(".pi-chalin/"))
    .filter((entry) => !baseline.has(entry.path))
    .filter((entry) => !isUntrackedBinaryOutput(cwd, entry))
    .filter((entry) => !isPathInsideWorkUnitScope(entry.path, scope))
    .map((entry) => entry.path);
}

function isPathInsideWorkUnitScope(filePath: string, scope: NormalizedWorkUnitScope): boolean {
  const normalized = normalizeMetricFilePath(filePath);
  return scope.files.has(normalized) || scope.directories.some((directory) => normalized.startsWith(directory));
}

function workspaceDirtyPaths(cwd: string): string[] {
  return workspaceDirtyEntries(cwd).map((entry) => entry.path);
}

type WorkspaceDirtyEntry = {
  status: string;
  path: string;
};

function workspaceDirtyEntries(cwd: string): WorkspaceDirtyEntry[] {
  const result = spawnSync("git", ["status", "--short", "--untracked-files=all"], { cwd, encoding: "utf-8" });
  if (result.status !== 0) return [];
  return result.stdout
    .split(/\r?\n/)
    .map(statusLineEntry)
    .filter((entry): entry is WorkspaceDirtyEntry => Boolean(entry));
}

function statusLineEntry(line: string): WorkspaceDirtyEntry | undefined {
  if (line.length < 4) return undefined;
  const status = line.slice(0, 2);
  const rawPath = line.slice(3).trim();
  if (!rawPath) return undefined;
  const arrowIndex = rawPath.lastIndexOf(" -> ");
  const filePath = arrowIndex >= 0 ? rawPath.slice(arrowIndex + 4) : rawPath;
  return { status, path: unquoteGitStatusPath(filePath) };
}

function unquoteGitStatusPath(filePath: string): string {
  const trimmed = filePath.trim();
  if (trimmed.length >= 2 && trimmed.startsWith("\"") && trimmed.endsWith("\"")) {
    return trimmed.slice(1, -1).replace(/\\"/g, "\"").replace(/\\\\/g, "\\");
  }
  return trimmed;
}

function isUntrackedBinaryOutput(cwd: string, entry: { status: string; path: string }): boolean {
  if (entry.status !== "??") return false;
  const fullPath = resolveProjectPath(entry.path, cwd);
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(fullPath);
  } catch {
    return false;
  }
  if (!stat.isFile() || stat.isSymbolicLink()) return false;
  return isLikelyBinaryFile(fullPath);
}

function isLikelyBinaryFile(filePath: string): boolean {
  let buffer: Buffer;
  try {
    const fd = fs.openSync(filePath, "r");
    try {
      buffer = Buffer.alloc(4096);
      const bytesRead = fs.readSync(fd, buffer, 0, buffer.length, 0);
      buffer = buffer.subarray(0, bytesRead);
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return false;
  }
  return buffer.includes(0);
}

function childWorkspacePathViolation(toolName: string, params: Record<string, unknown>, cwd: string): string | undefined {
  if (toolName === "bash") {
    const command = getCommandParam(params);
    return command ? firstShellWorkspacePathViolation(command, cwd) : undefined;
  }
  const target = getPathParam(params);
  if (!target) return undefined;
  const normalized = normalizeMetricPath(target, cwd);
  if (isInternalHarnessPath(normalized)) return `internal_harness_path:${normalized}`;
  if (isOutsideWorkspacePath(target, cwd)) return `outside_workspace_path:${normalized}`;
  return undefined;
}

function shellWords(segment: string): string[] {
  return segment.match(/(?:[^\s"'`\\]+|"(?:\\.|[^"])*"|'[^']*')+/g)?.map((word) => word.replace(/^['"]|['"]$/g, "")) ?? [];
}

function firstShellWorkspacePathViolation(command: string, cwd: string): string | undefined {
  const internalPath = firstInternalHarnessPathInCommand(command, cwd);
  if (internalPath) return `internal_harness_path:${internalPath}`;
  for (const token of dangerousAbsolutePathTokens(command)) {
    if (isAllowedExternalShellPath(token)) continue;
    if (isOutsideWorkspacePath(token, cwd)) return `outside_workspace_path:${token}`;
  }
  return undefined;
}

function firstInternalHarnessPathInCommand(command: string, cwd: string): string | undefined {
  for (const line of stripNonShellHeredocBodies(command).split(/\r?\n/)) {
    const words = shellWords(line);
    for (let index = 0; index < words.length; index += 1) {
      const word = words[index]!;
      if (isNegatedFindPathPattern(words, index)) continue;
      for (const candidate of shellInternalPathCandidatesFromWord(word)) {
        const normalized = normalizeMetricPath(candidate, cwd);
        if (isInternalHarnessPath(normalized)) return normalized;
      }
    }
  }
  return undefined;
}

function isNegatedFindPathPattern(words: string[], index: number): boolean {
  if (index < 2) return false;
  const command = words[0];
  if (command !== "find" && !command.endsWith("/find")) return false;
  return words[index - 1] === "-path" && (words[index - 2] === "-not" || words[index - 2] === "!");
}

function shellInternalPathCandidatesFromWord(word: string): string[] {
  const candidates = new Set<string>();
  const stripped = stripShellRedirectionPrefix(word.trim());
  if (stripped) candidates.add(trimCommandPathToken(stripped));
  const assignmentValue = shellAssignmentValue(word);
  if (assignmentValue) candidates.add(trimCommandPathToken(assignmentValue));
  return [...candidates].filter(Boolean);
}

function isInternalHarnessPath(normalizedPath: string): boolean {
  return normalizedPath === ".pi-chalin" || normalizedPath.startsWith(".pi-chalin/");
}

function dangerousAbsolutePathTokens(command: string): string[] {
  const tokens: string[] = [];
  const pending: Array<{ delimiter: string; scanBody: boolean }> = [];
  for (const line of command.split(/\r?\n/)) {
    const active = pending[0];
    if (active) {
      if (line.trim() === active.delimiter) {
        pending.shift();
        continue;
      }
      if (active.scanBody) tokens.push(...absolutePathTokensFromLine(line));
      continue;
    }
    tokens.push(...dangerousTopLevelPathTokensFromLine(line));
    pending.push(...heredocSpecsForLine(line));
  }
  return tokens;
}

function absolutePathTokensFromLine(line: string): string[] {
  const tokens: string[] = [];
  for (const word of shellWords(line)) {
    for (const candidate of shellPathCandidatesFromWord(word)) {
      const token = trimCommandPathToken(candidate);
      if (path.isAbsolute(token)) tokens.push(token);
    }
  }
  return tokens;
}

function dangerousTopLevelPathTokensFromLine(line: string): string[] {
  const tokens: string[] = [];
  const words = shellWords(line);
  for (let index = 0; index < words.length; index += 1) {
    const word = words[index]!;
    if (["cd", "pushd", "popd"].includes(path.basename(word))) {
      const target = words[index + 1];
      if (target) {
        const token = trimCommandPathToken(target);
        if (path.isAbsolute(token)) tokens.push(token);
      }
      continue;
    }
    if (isShellRedirectionWord(word)) {
      const inline = shellPathCandidateFromWord(word);
      const candidate = inline && path.isAbsolute(trimCommandPathToken(inline)) ? inline : words[index + 1];
      if (candidate) {
        const token = trimCommandPathToken(candidate);
        if (path.isAbsolute(token)) tokens.push(token);
      }
    }
  }
  return tokens;
}

function stripNonShellHeredocBodies(command: string): string {
  const output: string[] = [];
  const pending: Array<{ delimiter: string; scanBody: boolean }> = [];
  for (const line of command.split(/\r?\n/)) {
    const active = pending[0];
    if (active) {
      if (line.trim() === active.delimiter) {
        pending.shift();
        continue;
      }
      if (active.scanBody) output.push(line);
      continue;
    }
    output.push(line);
    pending.push(...heredocSpecsForLine(line));
  }
  return output.join("\n");
}

function heredocSpecsForLine(line: string): Array<{ delimiter: string; scanBody: boolean }> {
  const commandName = firstShellCommandWord(line);
  const scanBody = commandName !== undefined && SHELL_INTERPRETER_COMMANDS.has(path.basename(commandName));
  const specs: Array<{ delimiter: string; scanBody: boolean }> = [];
  const heredocPattern = /<<-?\s*(?:"([^"]+)"|'([^']+)'|([A-Za-z0-9_.-]+))/g;
  for (const match of line.matchAll(heredocPattern)) {
    const delimiter = match[1] ?? match[2] ?? match[3];
    if (delimiter) specs.push({ delimiter, scanBody });
  }
  return specs;
}

function firstShellCommandWord(line: string): string | undefined {
  for (const word of shellWords(line)) {
    if (!word || isShellAssignmentWord(word) || isShellRedirectionWord(word)) continue;
    return word;
  }
  return undefined;
}

function shellPathCandidatesFromWord(word: string): string[] {
  const candidates: string[] = [];
  const direct = shellPathCandidateFromWord(word);
  if (direct) candidates.push(direct);
  const assignmentValue = shellAssignmentValue(word);
  if (assignmentValue) {
    const assigned = shellPathCandidateFromWord(assignmentValue);
    if (assigned) candidates.push(assigned);
  }
  return candidates;
}

function shellPathCandidateFromWord(word: string): string | undefined {
  const trimmed = word.trim();
  if (isMarkupLikeShellWord(trimmed)) return undefined;
  const value = stripShellRedirectionPrefix(trimmed);
  return value.startsWith("/") ? value : undefined;
}

function shellAssignmentValue(word: string): string | undefined {
  if (!isShellAssignmentWord(word)) return undefined;
  const index = word.indexOf("=");
  return index >= 0 ? word.slice(index + 1) : undefined;
}

function isShellAssignmentWord(word: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*=/.test(word);
}

function isShellRedirectionWord(word: string): boolean {
  return /^\d*(?:>>?|<)(?!<)/.test(word);
}

function stripShellRedirectionPrefix(word: string): string {
  return word.replace(/^\d*(?:>>?|<)(?!<)/, "");
}

function isMarkupLikeShellWord(word: string): boolean {
  return /^<\/[A-Za-z][^/\s<>]*>$/.test(word);
}

const SHELL_INTERPRETER_COMMANDS = new Set(["bash", "sh", "zsh"]);

function isAllowedExternalShellPath(token: string): boolean {
  return token === "/dev/null"
    || token === "/dev/stdin"
    || token === "/dev/stdout"
    || token === "/dev/stderr"
    || isDoubleSlashCommentToken(token)
    || isSlashOnlyToken(token);
}

function isDoubleSlashCommentToken(token: string): boolean {
  if (!token.startsWith("//") || token.startsWith("///")) return false;
  const marker = token.slice(2);
  return marker.length > 0 && (!marker.includes("/") || marker.includes(" ") || marker.includes("\n") || marker.includes("\t"));
}

function isSlashOnlyToken(token: string): boolean {
  return token.length > 1 && [...token].every((char) => char === "/");
}

function isOutsideWorkspacePath(target: string, cwd: string): boolean {
  const resolved = resolveProjectPath(target, cwd);
  return !isPathInside(cwd, resolved) && !isPathInside(safeRealpath(cwd), safeRealpath(resolved));
}

function isPathInside(root: string, target: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function safeRealpath(target: string): string {
  try {
    return fs.realpathSync(target);
  } catch {
    return path.resolve(target);
  }
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

function sameStepReadLoopLimit(): number {
  return 4;
}

function isInspectionTool(toolName: string): boolean {
  return toolName === "read" || toolName === "grep" || toolName === "find" || toolName === "ls" || toolName === "chalin_project_discovery" || toolName === "chalin_web_search";
}

function isToolError(result: unknown): boolean {
  return isRecord(result) && result.isError === true;
}

function trimCommandPathToken(token: string): string {
  let end = token.length;
  while (end > 0 && isCommandPathSuffix(token[end - 1]!)) end -= 1;
  return token.slice(0, end);
}

function summarizeBlockedToolParams(toolName: string, params: Record<string, unknown>): string {
  const primary = toolName === "bash" ? getCommandParam(params) : getPathParam(params);
  if (primary) return compactText(primary, 300);
  try {
    return compactText(JSON.stringify(params), 300);
  } catch {
    return "[unserializable params]";
  }
}

function isCommandPathSuffix(char: string): boolean {
  return char === "." || char === "," || char === ";" || char === ")" || char === "]" || char === "}";
}

function roundMetric(value: number): number {
  if (!Number.isFinite(value)) return value;
  return Math.round(value * 1000) / 1000;
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
