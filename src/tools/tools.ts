import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { mergedSessionModelOverrides, mergedSessionThinkingOverrides } from "../agents/agent-overrides.ts";
import { AgentCatalog } from "../agents/agents.ts";
import { ArtifactStore } from "../artifacts/artifacts.ts";
import { loadEffectiveConfig } from "../config/config.ts";
import { ChalinKernel } from "../kernel/kernel.ts";
import { createMemoryCandidate } from "../memory/memory.ts";
import { createConfiguredMemoryStore } from "../memory/memory-provider.ts";
import { formatInterviewResult, runChalinInterview, type InterviewRequestInput, type InterviewResult } from "../interview/interview.ts";
import { loadFailedRunDiagnostic } from "../runner/run-recovery.ts";
import { loadResumableRunState } from "../runner/runner-state.ts";
import { activateSkillForTurn, disableSkillForTurn, setLatestRun } from "../runtime/state.ts";
import { setChalinStatus } from "../ui/ui-status.ts";
import { chalinRouteUpdateDetails, colorizeChalinWidget, footerStateForRun, formatChalinRoutePlanWidget, formatChalinRunWidget, formatChalinRunWidgetFromDetails, isUsableStepStatus, routeIntent, type ChalinRouteWidgetDetails } from "../routing/route-widget.ts";
import { fetchWebUrls, formatWebBundle, formatWebBundleProgressWidget, formatWebBundleWidget, searchWeb, type WebBundleProgressWidgetInput, type WebContextBundle } from "../webfetch/webfetch.ts";
import type { MemoryRecord, RunState } from "../domain/schemas.ts";
import { compactRouteDetails, formatRoute } from "../routing/route-format.ts";
import { executeDelegatedChalinRoute, type ChalinDelegationRouteParams } from "../routing/delegation.ts";
import { buildProjectDiscoveryIndex, formatProjectDiscoveryIndex } from "../project/discovery.ts";
import { SkillCatalog, SkillMetricsStore, auditSkill, formatSkillList, formatSkillSearch, formatSkillShow, promoteSkill, reconcileSkillLifecyclesEffect, retireSkill, summarizeSkillMetrics } from "../skills/skills.ts";
import { Effect } from "effect";
import { clampInteger, clampNumber, errorResult, finalToolResult, formatMemoryInventory, isMemoryInventoryQuery, textResult, truncateForTool } from "./tool-output.ts";

const InterviewChoiceParams = Type.Object({
  label: Type.String({ description: "Short answer option shown to the user." }),
  value: Type.Optional(Type.String({ description: "Optional expanded value saved when this option is selected." })),
  recommended: Type.Optional(Type.Boolean({ description: "Mark the orchestrator-recommended answer. At most one per question." })),
});

const InterviewQuestionParams = Type.Object({
  id: Type.Optional(Type.String({ description: "Stable short id, e.g. scope, risk, unknown-term." })),
  question: Type.String({ description: "Clear concise question. Avoid jargon." }),
  choices: Type.Array(InterviewChoiceParams, { description: "Two to five concise choices. Include a recommended option." }),
  allowCustom: Type.Optional(Type.Boolean({ description: "Allow a free-form custom answer. Defaults to true." })),
});

const ChalinInterviewParams = Type.Object({
  featureId: Type.Optional(Type.String({ description: "Artifact id to persist interview answers under. Defaults from task." })),
  task: Type.String({ description: "Original user request or feature being clarified." }),
  reason: Type.String({ description: "Why clarification is required before planning or running agents." }),
  questions: Type.Array(InterviewQuestionParams, { description: "Batch of up to five blocking clarification questions." }),
  batchSize: Type.Optional(Type.Number({ description: "Maximum questions to ask in this batch. Default 5, hard max 5." })),
});

const ChalinRouteStepParams = Type.Object({
  id: Type.Optional(Type.String({ description: "Stable step id, e.g. scout, plan, implement, review." })),
  agent: Type.String({ description: "pi-chalin agent name such as scout, planner, context-builder, worker, reviewer, researcher, or conflict-resolver." }),
  task: Type.String({ minLength: 12, description: "Concrete responsibility for this subagent. Include relevant constraints and expected evidence." }),
  budget: Type.Optional(Type.Union([Type.Literal("tight"), Type.Literal("normal"), Type.Literal("deep"), Type.Literal("extended")])),
  files: Type.Optional(Type.Array(Type.String(), { description: "Optional authoritative mutable file scope for this step when known." })),
});

const ChalinRouteStageParams = Type.Object({
  id: Type.Optional(Type.String({ description: "Stable stage id." })),
  name: Type.Optional(Type.String({ description: "Human-readable stage name." })),
  tasks: Type.Optional(Type.Array(ChalinRouteStepParams, { minItems: 1, description: "Subagent tasks in this DAG stage." })),
});

const ChalinRouteParams = Type.Object({
  task: Type.String({ minLength: 12, description: "Original user request or the exact work to delegate to the pi-chalin orchestrator." }),
  topology: Type.Union([Type.Literal("sequential"), Type.Literal("dag")], { description: "sequential for dependent phases, dag for independent fan-out before fan-in." }),
  steps: Type.Optional(Type.Array(ChalinRouteStepParams, { minItems: 1, maxItems: 6, description: "Ordered subagent steps for sequential topology." })),
  stages: Type.Optional(Type.Array(ChalinRouteStageParams, { minItems: 1, maxItems: 8, description: "DAG stages for independent or staged subagent work." })),
  risk: Type.Optional(Type.Union([Type.Literal("low"), Type.Literal("medium"), Type.Literal("high"), Type.Literal("critical")])),
  needsMemory: Type.Optional(Type.Boolean({ description: "Allow the workflow to retrieve relevant pi-chalin memory." })),
  needsArtifacts: Type.Optional(Type.Boolean({ description: "Persist run artifacts/checkpoints for resume and inspection." })),
  expectedEffects: Type.Array(Type.Union([Type.Literal("read"), Type.Literal("write"), Type.Literal("verify")]), { minItems: 1, maxItems: 3, uniqueItems: true, description: "Effects the delegated workflow must cover. Mutation requires write and verify." }),
  workUnitStrategy: Type.Optional(Type.Union([Type.Literal("none"), Type.Literal("planned"), Type.Literal("discover")], { description: "Use discover when the orchestrator must derive safe work units before execution; planned when user already named independent slices." })),
  fanoutAuthorized: Type.Optional(Type.Boolean({ description: "True only when the user authorized applying the same delegated change across discovered independent targets." })),
  requiresWorkspaceMutation: Type.Optional(Type.Boolean({ description: "Set true when the delegated work is expected to edit/write files." })),
  reason: Type.Optional(Type.String({ minLength: 8, maxLength: 400, description: "Short internal reason for delegating to subagents; do not expose delegation mechanics to the user." })),
});

const ChalinProjectDiscoveryParams = Type.Object({
  maxDepth: Type.Optional(Type.Number({ description: "Maximum directory depth to index. Default 4." })),
  maxEntries: Type.Optional(Type.Number({ description: "Maximum entries to return. Default 450." })),
});
const ChalinSkillParams = Type.Object({
  action: Type.Union([
    Type.Literal("list"),
    Type.Literal("show"),
    Type.Literal("search"),
    Type.Literal("use"),
    Type.Literal("disable"),
    Type.Literal("audit"),
    Type.Literal("promote"),
    Type.Literal("retire"),
    Type.Literal("metrics"),
    Type.Literal("reconcile"),
  ]),
  name: Type.Optional(Type.String({ description: "Skill reference such as project:run-verify-project, built-in:bugfix-tight-loop, or feature:<id>:<name>." })),
  task: Type.Optional(Type.String({ description: "Task text for search/use matching." })),
  targetScope: Type.Optional(Type.Union([Type.Literal("project"), Type.Literal("user")])),
  lifecycle: Type.Optional(Type.Union([Type.Literal("stale"), Type.Literal("expired"), Type.Literal("blocked")])),
});

type ChalinSkillToolParams = {
  action: "list" | "show" | "search" | "use" | "disable" | "audit" | "promote" | "retire" | "metrics" | "reconcile";
  name?: string;
  task?: string;
  targetScope?: "project" | "user";
  lifecycle?: "stale" | "expired" | "blocked";
};

const WebFreshnessParam = Type.Optional(Type.Union([
  Type.Literal("cache-ok"),
  Type.Literal("prefer-fresh"),
  Type.Literal("must-be-fresh"),
], { description: "Freshness policy. cache-ok uses local cache; prefer-fresh refreshes when possible; must-be-fresh bypasses cache." }));

const ChalinWebSearchParams = Type.Object({
  query: Type.Optional(Type.String({ description: "Web search query." })),
  url: Type.Optional(Type.String({ description: "Single URL to fetch as clean web context." })),
  urls: Type.Optional(Type.Array(Type.String(), { description: "URLs to fetch as clean web context." })),
  maxSources: Type.Optional(Type.Number({ description: "Maximum search sources, default 5, max 10." })),
  depth: Type.Optional(Type.Union([Type.Literal("snippets"), Type.Literal("content")], { description: "snippets by default; content asks Exa for more page text." })),
  freshness: WebFreshnessParam,
});

const ChalinMemorySearchParams = Type.Object({
  query: Type.Optional(Type.String({ description: "Compact local memory search query. Required for search mode; optional for list mode." })),
  mode: Type.Optional(Type.Union([
    Type.Literal("search", { description: "Semantic search over memory using query." }),
    Type.Literal("list", { description: "Enumerate visible memory records for inventory/count requests." }),
  ], { description: "Use list for questions like how many memory records exist or what memory elements are visible." })),
  status: Type.Optional(Type.Union([
    Type.Literal("all"),
    Type.Literal("active"),
    Type.Literal("pending"),
    Type.Literal("quarantined"),
    Type.Literal("stale"),
    Type.Literal("superseded"),
    Type.Literal("rejected"),
  ], { description: "Optional status filter for list mode. Default all visible records." })),
  limit: Type.Optional(Type.Number({ description: "Maximum memories to return. Default 6/max 10 for search; default 20/max 100 for list." })),
  tokenBudget: Type.Optional(Type.Number({ description: "Approximate token budget for returned context. Default 700, max 1600." })),
  includeEvidence: Type.Optional(Type.Boolean({ description: "Include evidence when checking contradictions or reviewing memory quality." })),
});

const ChalinMemoryWriteParams = Type.Object({
  category: Type.String({ description: "Memory category such as testing, architecture, workflow, user-preference, or tooling." }),
  content: Type.String({ description: "Compact durable project/user knowledge. Do not write logs, command output, or trivial completion notes." }),
  confidence: Type.Optional(Type.Number({ description: "Confidence from 0 to 1. Default 0.85." })),
  evidence: Type.Optional(Type.String({ description: "Short evidence for why this memory is durable." })),
  topicKey: Type.Optional(Type.String({ description: "Optional stable topic key for revision/deduplication." })),
});

const ChalinMemoryReviseParams = Type.Object({
  id: Type.String({ description: "Existing memory record id to revise." }),
  content: Type.String({ description: "Corrected compact memory content." }),
  category: Type.Optional(Type.String({ description: "Optional replacement category." })),
  confidence: Type.Optional(Type.Number({ description: "Confidence from 0 to 1. Default 0.9." })),
  evidence: Type.Optional(Type.String({ description: "Evidence proving the old memory is stale or weaker." })),
  reason: Type.String({ description: "Why the revision is more accurate or useful than the prior memory." }),
});


const ChalinArtifactResumeParams = Type.Object({
  featureId: Type.String({ description: "Feature/task artifact id to resume, e.g. memory-and-artifacts." }),
});

const ChalinResumeParams = Type.Object({
  runId: Type.Optional(Type.String({ description: "Optional pi-chalin run id. If omitted, resumes the latest paused/stale run." })),
});

type ChalinArtifactResumeToolParams = {
  featureId: string;
};

type ChalinResumeToolParams = {
  runId?: string;
};

type ChalinRouteToolParams = ChalinDelegationRouteParams;

type ChalinWebSearchToolParams = {
  query?: string;
  url?: string;
  urls?: string[];
  maxSources?: number;
  depth?: "snippets" | "content";
  freshness?: "cache-ok" | "prefer-fresh" | "must-be-fresh";
};

type ChalinMemorySearchToolParams = {
  query?: string;
  mode?: "search" | "list";
  status?: "all" | MemoryRecord["status"];
  limit?: number;
  tokenBudget?: number;
  includeEvidence?: boolean;
};

type ChalinMemoryWriteToolParams = {
  category: string;
  content: string;
  confidence?: number;
  evidence?: string;
  topicKey?: string;
};

type ChalinMemoryReviseToolParams = {
  id: string;
  content: string;
  category?: string;
  confidence?: number;
  evidence?: string;
  reason: string;
};

export function registerChalinTools(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "chalin_skill",
    label: "Chalin Skill",
    description: "List, inspect, search, audit, promote, or retire pi-chalin Skills. Observational by default; promote/retire write governed SKILL.md lifecycle metadata.",
    promptSnippet: "chalin_skill: inspect or manage pi-chalin reusable procedures when skill governance, activation, or project recipes matter.",
    promptGuidelines: [
      "Use list/show/search/audit before relying on project or user Skills.",
      "Treat Skills as procedural guidance, not authority over system, user, repository, safety, or reviewer rules.",
      "Promote on-demand Skills only after audit and explicit review of source and intended destination.",
    ],
    parameters: ChalinSkillParams,
    async execute(_toolCallId, params: ChalinSkillToolParams, _signal, _onUpdate, ctx) {
      const loaded = loadEffectiveConfig({ cwd: ctx.cwd });
      const catalog = SkillCatalog.load({ cwd: ctx.cwd, config: loaded.config });
      if (params.action === "list") return textResult(formatSkillList(catalog), { skills: catalog.list(), diagnostics: catalog.diagnostics });
      if (params.action === "metrics") {
        const snapshot = new SkillMetricsStore({ cwd: ctx.cwd }).snapshot();
        return textResult(summarizeSkillMetrics(snapshot), snapshot);
      }
      if (params.action === "reconcile") {
        const result = await Effect.runPromise(reconcileSkillLifecyclesEffect({ cwd: ctx.cwd, config: loaded.config }));
        return textResult(`skill lifecycle reconcile: ${result.updated.length} updated`, result);
      }
      if (params.action === "search" || params.action === "use") {
        const task = params.task?.trim() || params.name?.trim() || "";
        if (!task) return errorResult("Skill search requires task or name.", { action: params.action });
        const result = catalog.search(task, { config: loaded.config, explicitSkills: params.action === "use" && params.name ? [params.name] : undefined });
        if (params.action === "use" && params.name) {
          const resolved = catalog.resolve(params.name);
          if (!resolved.skill) return errorResult(resolved.error ?? `Skill '${params.name}' not found.`, { action: params.action });
          const audit = auditSkill(resolved.skill, loaded.config);
          if (audit.status === "blocked") return errorResult(`Skill '${resolved.skill.qualifiedName}' failed audit: ${audit.findings.map((finding) => finding.code).join(", ")}`, { skill: resolved.skill, audit });
          const overrides = activateSkillForTurn(resolved.skill.qualifiedName);
          return textResult(`skill activated for this turn: ${resolved.skill.qualifiedName}\n\n${formatSkillSearch(task, result)}`, {
            ...result,
            explicitSkills: [...overrides.explicit],
            disabledSkills: [...overrides.disabled],
          });
        }
        return textResult(formatSkillSearch(task, result), result);
      }
      if (!params.name?.trim()) return errorResult(`chalin_skill ${params.action} requires name.`, { action: params.action });
      const resolved = catalog.resolve(params.name);
      if (!resolved.skill) return errorResult(resolved.error ?? `Skill '${params.name}' not found.`, { action: params.action });
      if (params.action === "show") return textResult(formatSkillShow(resolved.skill), { skill: resolved.skill });
      if (params.action === "audit") {
        const audit = auditSkill(resolved.skill, loaded.config);
        return textResult(formatSkillShow(resolved.skill, audit), { skill: resolved.skill, audit });
      }
      if (params.action === "promote") {
        const targetScope = params.targetScope ?? "project";
        const result = promoteSkill({ cwd: ctx.cwd, reference: params.name, targetScope, reviewedBy: "chalin_skill" });
        return textResult(`skill promoted: ${result.skill.qualifiedName}\npath: ${result.path}\naudit: ${result.audit.status}`, result);
      }
      if (params.action === "disable") {
        const overrides = disableSkillForTurn(resolved.skill.qualifiedName);
        return textResult(`skill disabled for this turn: ${resolved.skill.qualifiedName}`, {
          skill: resolved.skill,
          explicitSkills: [...overrides.explicit],
          disabledSkills: [...overrides.disabled],
        });
      }
      if (params.action === "retire") {
        const lifecycle = params.lifecycle ?? "stale";
        const result = retireSkill({ cwd: ctx.cwd, reference: params.name, lifecycle, actor: "chalin_skill" });
        return textResult(`skill retired: ${result.skill.qualifiedName} -> ${result.skill.lifecycle}\npath: ${result.path}`, result);
      }
      return errorResult(`Unsupported chalin_skill action '${params.action}'.`, { action: params.action });
    },
  });

  pi.registerTool({
    name: "chalin_project_discovery",
    label: "Chalin Project Discovery",
    description: "Return a bounded raw filesystem inventory for local project orientation. It does not infer stack, entrypoints, tests, commands, or importance.",
    promptSnippet: "chalin_project_discovery: get raw project inventory for broad orientation; skip it for bounded inline edits when native find/grep/read is cheaper.",
    promptGuidelines: [
      "Use when broad repository orientation is needed before selecting files.",
      "For bounded bugfix/refactor/test/scaffold work, prefer native find/grep/read against likely files and nearby tests instead of inventorying the project.",
      "Treat it as filesystem facts only; choose follow-up reads/searches with LLM judgment.",
      "Verify final claims from exact file evidence, not from the inventory alone.",
    ],
    parameters: ChalinProjectDiscoveryParams,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const discovery = buildProjectDiscoveryIndex(ctx.cwd, {
        maxDepth: typeof params.maxDepth === "number" ? params.maxDepth : undefined,
        maxEntries: typeof params.maxEntries === "number" ? params.maxEntries : undefined,
      });
      return textResult(formatProjectDiscoveryIndex(discovery), { discovery });
    },
  });

  pi.registerTool({
    name: "chalin_interview",
    label: "Chalin Interview",
    description: "Ask blocking clarification questions in the TUI and persist answers as pi-chalin artifacts for inline or delegated work.",
    promptSnippet: "chalin_interview: ask concise questions only when a remaining human decision blocks safe progress after discoverable context is used.",
    promptGuidelines: [
      "Use chalin_interview when proceeding would require guessing user intent, constraints, tradeoffs, or safety boundaries that cannot be discovered cheaply.",
      "Ask only what blocks correct planning. Prefer one to five questions per batch. Each question must have two to five concise options and exactly one recommended option when possible.",
      "Always allow a custom answer unless the answer space must be constrained for safety.",
      "After chalin_interview returns, use the persisted answers as artifact context and continue only when you are confident enough.",
    ],
    parameters: ChalinInterviewParams,
    async execute(_toolCallId, params: InterviewRequestInput, _signal, _onUpdate, ctx) {
      const store = new ArtifactStore({ cwd: ctx.cwd });
      const result = await runChalinInterview(ctx, store, params);
      return textResult(formatInterviewResult(result), { interview: result });
    },
    renderCall(args, theme) {
      const count = Array.isArray(args.questions) ? args.questions.length : 0;
      const label = args.featureId || args.task || "interview";
      return new Text([
        theme.fg("toolTitle", theme.bold("chalin_interview")),
        theme.fg("muted", ` ${count} question${count === 1 ? "" : "s"}`),
        theme.fg("dim", ` · ${truncateForTool(label, 56)}`),
      ].join(""), 0, 0);
    },
    renderResult(result, _options, theme) {
      const details = result.details as { interview?: InterviewResult } | undefined;
      const interview = details?.interview;
      if (!interview) return new Text(result.content.find((part) => part.type === "text")?.text ?? "", 0, 0);
      const statusColor = interview.status === "answered" ? "success" : interview.status === "cancelled" ? "warning" : "muted";
      const lines = [
        `${theme.fg(statusColor, interview.status)} · ${interview.answers.length} answer${interview.answers.length === 1 ? "" : "s"}`,
        theme.fg("muted", `artifact: ${truncateForTool(interview.featureId, 64)}`),
        ...interview.answers.map((answer) => {
          const suffix = answer.custom ? " (custom)" : answer.recommended ? " (recommended)" : "";
          return `- ${theme.fg("accent", answer.questionId)}: ${truncateForTool(answer.answer, 120)}${theme.fg("muted", suffix)}`;
        }),
        interview.status === "answered" ? theme.fg("dim", "next: continue with these answers") : theme.fg("warning", "next: ask before routing"),
      ];
      return new Text(lines.join("\n"), 0, 0);
    },
  });

  pi.registerTool({
    name: "chalin_route",
    label: "Chalin Route",
    description: "Delegate complex, multi-step, high-risk, or multi-surface work to the pi-chalin orchestrator and its subagents. This is a delegation gateway, not a route-selection or user-facing decision tool.",
    promptSnippet: "chalin_route: delegate to the pi-chalin orchestrator when subagents, WorkUnits, independent review, or staged execution will materially improve quality.",
    promptGuidelines: [
      "Use this when the work is complex, touches multiple files or ownership boundaries, needs independent verification/review, benefits from decomposition, or would otherwise overload the primary Pi thread.",
      "Do not call chalin_route just to decide whether to delegate. Decide with LLM judgment from the task shape, evidence burden, risk, ambiguity, decomposition value, and verification burden.",
      "If a non-discoverable human decision blocks safe progress, use chalin_interview before delegating. If uncertainty is discoverable from repo/web evidence, pass it into the delegated workflow.",
      "Use sequential topology for dependent phases. Use DAG only for independent work before fan-in, and give disjoint file scopes for parallel writers when known.",
      "For mutation, include expectedEffects read/write/verify and let the orchestrator add worker/reviewer coverage when needed.",
      "Keep the user experience simple: after chalin_route returns, answer from its final material without exposing internal delegation labels unless the user asks.",
    ],
    parameters: ChalinRouteParams,
    async execute(_toolCallId, params: ChalinRouteToolParams, signal, onUpdate, ctx) {
      const loaded = loadEffectiveConfig({ cwd: ctx.cwd });
      const catalog = AgentCatalog.load({ cwd: ctx.cwd });
      onUpdate?.({
        content: [{ type: "text", text: formatChalinRoutePlanWidget(params) }],
        details: { status: "pending", params },
      });
      try {
        const result = await executeDelegatedChalinRoute(params, params.task, ctx, { signal, onUpdate });
        if (result.run) setLatestRun(result.run);
        if (result.run?.status === "paused" || signal?.aborted) setChalinStatus(ctx, { kind: "stopped" });
        else if (result.run?.status === "failed") setChalinStatus(ctx, { kind: "failed" });
        else setChalinStatus(ctx, { kind: "complete", intent: routeIntent(result.route) });
        return finalToolResult(ctx, formatRoute(result.route, result), compactRouteDetails(result.route, result, [...loaded.diagnostics, catalog.diagnostics]));
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        setChalinStatus(ctx, signal?.aborted ? { kind: "stopped" } : { kind: "failed" });
        return textResult(`chalin_route failed: ${message}`, { error: message, params });
      }
    },
    renderCall(args: ChalinRouteToolParams, theme) {
      return new Text(colorizeChalinWidget(formatChalinRoutePlanWidget(args), theme), 0, 0);
    },
    renderResult(result, _options, theme) {
      const details = result.details as ChalinRouteWidgetDetails | undefined;
      const rendered = details?.run ? formatChalinRunWidgetFromDetails(details) : result.content.find((part) => part.type === "text")?.text ?? "";
      return new Text(colorizeChalinWidget(rendered, theme), 0, 0);
    },
  });

  pi.registerTool({
    name: "chalin_resume",
    label: "Chalin Resume",
    description: "Resume the latest paused or stale pi-chalin subagent run, preserving completed steps and continuing pending DAG/chain work.",
    promptSnippet: "chalin_resume: resume an interrupted pi-chalin run when the user's current intent is continuation after ESC, abort, terminal close, or a paused run.",
    promptGuidelines: [
      "Use this before answering from partial findings when the user asks to continue a paused/interrupted chalin run; infer continuation from intent and resumable-run context, not literal phrase matching.",
      "Do not start a new subagent workflow for a paused run; resume the persisted run instead.",
      "After chalin_resume returns, answer the user from the resumed Final answer material.",
    ],
    parameters: ChalinResumeParams,
    async execute(_toolCallId, params: ChalinResumeToolParams, signal, onUpdate, ctx) {
      const loaded = loadEffectiveConfig({ cwd: ctx.cwd });
      const run = loadResumableRunState({ cwd: ctx.cwd, runId: params.runId });
      if (!run) {
        const failed = loadFailedRunDiagnostic({ cwd: ctx.cwd, runId: params.runId });
        if (failed) return textResult(failed.message, { runId: failed.run.id, run: failed.run, recoveryState: failed.run.recoveryState });
        return textResult(params.runId ? `No resumable pi-chalin run found for '${params.runId}'.` : "No paused or stale pi-chalin run found to resume.", { runId: params.runId });
      }
      const catalog = AgentCatalog.load({ cwd: ctx.cwd });
      const memory = createConfiguredMemoryStore({ cwd: ctx.cwd }, loaded.config);
      const kernel = new ChalinKernel({
        cwd: ctx.cwd,
        config: loaded.config,
        catalog,
        memory,
        modelOverrides: mergedSessionModelOverrides(loaded.config.agents.modelOverrides),
        thinkingOverrides: mergedSessionThinkingOverrides(loaded.config.agents.thinkingOverrides),
      });
      const abortSignal = signal ?? new AbortController().signal;
      setChalinStatus(ctx, {
        kind: "running",
        intent: routeIntent(run.route),
        agent: run.steps.find((step) => !isUsableStepStatus(step.status))?.agent ?? run.route.agents[0] ?? "chalin",
        completed: run.steps.filter((step) => isUsableStepStatus(step.status)).length,
        total: Math.max(run.steps.length, 1),
      });
      try {
        const result = await kernel.resumeRun(run, {
          cwd: ctx.cwd,
          extensionContext: ctx,
          signal: abortSignal,
          onUpdate: (updated) => {
            setLatestRun(updated);
            setChalinStatus(ctx, footerStateForRun(updated));
            onUpdate?.({
              content: [{ type: "text", text: formatChalinRunWidget(updated) }],
              details: chalinRouteUpdateDetails(updated),
            });
          },
        });
        if (result.run) setLatestRun(result.run);
        if (result.run?.status === "paused" || abortSignal.aborted) setChalinStatus(ctx, { kind: "stopped" });
        else if (result.run?.status === "failed") setChalinStatus(ctx, { kind: "failed" });
        else setChalinStatus(ctx, { kind: "complete", intent: routeIntent(result.route) });
        return finalToolResult(ctx, formatRoute(result.route, result), compactRouteDetails(result.route, result, [...loaded.diagnostics, catalog.diagnostics]));
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        run.status = abortSignal.aborted ? "paused" : "failed";
        run.warnings = [...(run.warnings ?? []), `chalin_resume failed: ${message}`];
        setLatestRun(run);
        setChalinStatus(ctx, abortSignal.aborted ? { kind: "stopped" } : { kind: "failed" });
        return textResult(`chalin_resume failed for ${run.id}: ${message}\nlog: ${run.logsPath ?? "unknown"}`, { runId: run.id, run, error: message });
      }
    },
    renderCall(args, theme) {
      void args;
      void theme;
      return new Text("", 0, 0);
    },
    renderResult(result, _options, theme) {
      const details = result.details as ChalinRouteWidgetDetails | undefined;
      const rendered = details?.run ? formatChalinRunWidgetFromDetails(details) : result.content.find((part) => part.type === "text")?.text ?? "";
      return new Text(colorizeChalinWidget(rendered, theme), 0, 0);
    },
  });


  pi.registerTool({
    name: "chalin_memory_search",
    label: "Chalin Memory Search",
    description: "Search or list compact durable pi-chalin memory from the primary Pi agent. Use without waiting for an explicit memory request when prior decisions, project facts, workflows, preferences, or memory inventory/counts matter.",
    promptSnippet: "chalin_memory_search: recall or list compact durable memory during inline work when prior context or memory inventory may help.",
    promptGuidelines: [
      "Use this as the first tool for explicit memory/recall questions instead of starting a subagent workflow.",
      "Use mode `list` for memory inventory/count questions such as what memory elements exist or how many records are visible.",
      "Use this proactively for repeated project conventions, prior decisions, user preferences, workflows, and suspected stale assumptions.",
      "Keep queries short and tokenBudget small. Current repository evidence and explicit user instructions override memory.",
      "Ask for evidence only when checking contradictions, reviewing memory, or deciding whether to revise a memory.",
    ],
    parameters: ChalinMemorySearchParams,
    async execute(_toolCallId, params: ChalinMemorySearchToolParams, _signal, _onUpdate, ctx) {
      const memory = createConfiguredMemoryStore({ cwd: ctx.cwd });
      const query = params.query?.trim() ?? "";
      const mode = params.mode ?? (isMemoryInventoryQuery(query) ? "list" : "search");
      if (mode === "list") {
        const allRecords = await memory.list(params.status && params.status !== "all" ? params.status : undefined);
        const limit = clampInteger(params.limit ?? 20, 1, 100);
        const records = allRecords.slice(0, limit);
        const text = formatMemoryInventory(records, {
          total: allRecords.length,
          omitted: Math.max(0, allRecords.length - records.length),
          status: params.status ?? "all",
          includeEvidence: Boolean(params.includeEvidence),
        });
        return textResult(text, { mode, records, total: allRecords.length, omitted: Math.max(0, allRecords.length - records.length) });
      }
      if (!query) return textResult("No memory query provided.", { mode, results: [] });
      const bundle = await memory.retrieve({
        query,
        sourceAgent: "primary-pi",
        limit: clampInteger(params.limit ?? 6, 1, 10),
        tokenBudget: clampInteger(params.tokenBudget ?? 700, 80, 1600),
        includeEvidence: Boolean(params.includeEvidence),
      });
      return textResult(bundle.text || "No memory matches.", bundle);
    },
  });

  pi.registerTool({
    name: "chalin_memory_write",
    label: "Chalin Memory Write",
    description: "Save compact durable project or user knowledge from the primary Pi agent. The MemoryStore WriteGuard decides active, pending, duplicate, revised, or rejected.",
    promptSnippet: "chalin_memory_write: save durable verified knowledge discovered during inline or delegated work.",
    promptGuidelines: [
      "Use this for durable project facts, decisions, workflows, user preferences, and lessons that should reduce future rediscovery.",
      "Do not write logs, command output, code dumps, transient task completion notes, or facts that are not backed by evidence.",
      "Prefer one compact sentence with evidence over multiple broad memories.",
    ],
    parameters: ChalinMemoryWriteParams,
    async execute(_toolCallId, params: ChalinMemoryWriteToolParams, _signal, _onUpdate, ctx) {
      const content = params.content.trim();
      if (content.length < 24) return textResult("memory rejected: content is too short to be durable.", { status: "rejected" });
      const memory = createConfiguredMemoryStore({ cwd: ctx.cwd });
      const [record] = await memory.submitCandidates([createMemoryCandidate({
        category: params.category,
        content,
        sourceAgent: "primary-pi",
        confidence: clampNumber(params.confidence ?? 0.85, 0, 1),
        evidence: params.evidence,
        topicKey: params.topicKey,
        scope: "project",
      })]);
      if (!record) return textResult("memory rejected: no durable candidate was produced.", { status: "rejected" });
      return textResult(`memory ${record.status}: ${record.id}`, { record });
    },
  });

  pi.registerTool({
    name: "chalin_memory_revise",
    label: "Chalin Memory Revise",
    description: "Correct or replace an existing pi-chalin memory when current evidence proves it stale, wrong, or weaker than the new formulation.",
    promptSnippet: "chalin_memory_revise: repair stale or incorrect durable memory with evidence.",
    promptGuidelines: [
      "Use this when retrieved memory contradicts repository evidence or a newer instruction is clearly better.",
      "Always include concise evidence and a reason. Keep the revised memory compact.",
      "Do not revise memory just to restyle wording unless utility or correctness improves.",
    ],
    parameters: ChalinMemoryReviseParams,
    async execute(_toolCallId, params: ChalinMemoryReviseToolParams, _signal, _onUpdate, ctx) {
      const content = params.content.trim();
      if (content.length < 24) return textResult("memory revision rejected: content is too short to be durable.", { status: "rejected" });
      const memory = createConfiguredMemoryStore({ cwd: ctx.cwd });
      const record = await memory.revise(params.id, {
        content,
        category: params.category,
        sourceAgent: "primary-pi",
        confidence: clampNumber(params.confidence ?? 0.9, 0, 1),
        evidence: params.evidence,
        reason: params.reason,
      });
      if (!record) return textResult(`memory revision failed: ${params.id} was not found.`, { status: "missing", id: params.id });
      return textResult(`memory revised: ${record.id}`, { record });
    },
  });

  pi.registerTool({
    name: "chalin_artifact_resume",
    label: "Chalin Artifact Resume",
    description: "Load compact resumable pi-chalin artifact context for a long-running feature/task.",
    promptSnippet: "chalin_artifact_resume: load prior checkpoints, validation contracts, and worker skills for a long-running chalin task.",
    promptGuidelines: [
      "Use this before continuing a long-running or previously interrupted pi-chalin task.",
      "Use the returned checkpoints and validation contracts as the source of truth for continuation.",
    ],
    parameters: ChalinArtifactResumeParams,
    async execute(_toolCallId, params: ChalinArtifactResumeToolParams, _signal, _onUpdate, ctx) {
      const artifacts = new ArtifactStore({ cwd: ctx.cwd });
      const text = await artifacts.resumeContext(params.featureId);
      return textResult(text, { featureId: params.featureId });
    },
  });

  pi.registerTool({
    name: "chalin_web_search",
    label: "Chalin Web Search",
    description: "Search or fetch web context through Exa MCP. Use only when current external information, documentation, or a URL is required; returns compact sources, not a raw dump.",
    promptSnippet: "chalin_web_search: search/fetch current web context through Exa MCP with compact citations.",
    promptGuidelines: [
      "Use chalin_web_search for current docs, recent facts, URLs, or external verification; do not use it for local repo facts.",
      "Prefer maxSources 3-5 and snippets unless the user explicitly needs deeper content.",
      "Cite source URLs from the tool result in your answer.",
    ],
    parameters: ChalinWebSearchParams,
    async execute(_toolCallId, params: ChalinWebSearchToolParams, signal, onUpdate, ctx) {
      const urls = [...(params.urls ?? []), ...(params.url ? [params.url] : [])].filter(Boolean);
      const progressDetails: WebBundleProgressWidgetInput & { status: "running"; provider: "exa-mcp" } = urls.length > 0
        ? { status: "running", provider: "exa-mcp", mode: "fetch", label: urls.length === 1 ? urls[0] ?? "URL" : `${urls.length} URLs`, requested: urls, done: 0, total: urls.length }
        : { status: "running", provider: "exa-mcp", mode: "search", label: params.query ?? "web", requested: params.query ? [params.query] : [], done: 0, total: 1 };
      onUpdate?.({ content: [{ type: "text", text: formatWebBundleProgressWidget(progressDetails) }], details: progressDetails });
      const bundle = urls.length > 0
        ? await fetchWebUrls({ cwd: ctx.cwd, urls, freshness: params.freshness, signal })
        : await searchWeb({ cwd: ctx.cwd, query: params.query ?? "", maxSources: params.maxSources, depth: params.depth, freshness: params.freshness, signal });
      return textResult(formatWebBundle(bundle), bundle);
    },
    renderResult(result, _options, _theme) {
      const details = result.details as (Partial<WebContextBundle> & Partial<WebBundleProgressWidgetInput> & { status?: string }) | undefined;
      if (details?.status === "running" && (details.mode === "search" || details.mode === "fetch")) {
        return new Text(formatWebBundleProgressWidget(details as WebBundleProgressWidgetInput), 0, 0);
      }
      const rendered = details?.provider === "exa-mcp" && Array.isArray(details.sources)
        ? formatWebBundleWidget(details as WebContextBundle)
        : result.content.find((part) => part.type === "text")?.text ?? "";
      return new Text(rendered, 0, 0);
    },
  });
}
