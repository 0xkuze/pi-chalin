import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { mergedSessionModelOverrides, mergedSessionThinkingOverrides } from "./agent-overrides.ts";
import { AgentCatalog } from "./agents.ts";
import { ArtifactStore } from "./artifacts.ts";
import { loadEffectiveConfig } from "./config.ts";
import { ChalinKernel, routeFromPlan } from "./kernel.ts";
import { createMemoryCandidate } from "./memory.ts";
import { createConfiguredMemoryStore } from "./memory-provider.ts";
import { formatInterviewResult, runChalinInterview, type InterviewRequestInput } from "./interview.ts";
import { loadResumableRunState } from "./runner-state.ts";
import { beginChalinRouteInvocation, finishChalinRouteInvocation, setLatestRun } from "./runtime-state.ts";
import { openSafetyApproval } from "./ui.ts";
import { clearLegacyChalinControlWidget, setChalinStatus } from "./ui-status.ts";
import { chalinRouteUpdateDetails, colorizeChalinWidget, footerStateForRun, formatChalinRoutePlanWidget, formatChalinRunWidget, formatChalinRunWidgetFromDetails, isUsableStepStatus, plannedWidgetRun, routeIntent, type ChalinRouteWidgetDetails } from "./route-widget.ts";
import { fetchWebUrls, formatWebBundle, searchWeb } from "./webfetch.ts";
import type { MemoryRecord, RouteDecision, RunState } from "./schemas.ts";
import { collapseReadOnlyScoutContextRoute, ensureMutationRouteHasWorkerAndReviewer, inferRouteRequiresWorkspaceMutation } from "./route-guards.ts";
import { compactRouteDetails, finalAnswerMaterial, formatRoute, outcomeForResult } from "./route-format.ts";
import { buildProjectDiscoveryIndex, formatProjectDiscoveryIndex } from "./discovery.ts";
import { buildProjectSnapshot, formatProjectSnapshot } from "./snapshot.ts";

const AgentStepParams = Type.Object({
  id: Type.Optional(Type.String({ description: "Stable step id such as scout, plan, implement, review." })),
  agent: Type.String({ description: "Available pi-chalin agent name. Built-in names include scout, context-builder, planner, worker, reviewer, researcher, oracle, delegate, and conflict-resolver; project catalogs may add more." }),
  task: Type.String({ description: "Concrete outcome for this agent, including evidence to inspect, files to modify if any, and success criteria." }),
  budget: Type.Optional(Type.Union([
    Type.Literal("tight"),
    Type.Literal("normal"),
    Type.Literal("deep"),
    Type.Literal("extended"),
  ], { description: "Optional tool/time budget hint. Use tight for bounded evidence, normal for ordinary work, deep/extended only when broad exploration is necessary." })),
});

const AgentStageParams = Type.Object({
  id: Type.Optional(Type.String({ description: "Stable stage id." })),
  name: Type.Optional(Type.String({ description: "Human-readable stage name." })),
  tasks: Type.Array(AgentStepParams, { description: "One or more agent tasks in this DAG stage." }),
});


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

const ChalinRouteParams = Type.Object({
  task: Type.String({ description: "Original user goal rewritten as an executable workflow objective." }),
  topology: Type.Union([
    Type.Literal("single", { description: "One agent executes a bounded delegated task." }),
    Type.Literal("chain", { description: "Agents run sequentially in the order chosen by the orchestrator." }),
    Type.Literal("parallel", { description: "Independent agents analyze alternatives in parallel." }),
    Type.Literal("dag", { description: "Staged workflow with explicit stage dependencies." }),
    Type.Literal("memory-only", { description: "Only retrieve pi-chalin memory; no steps/stages." }),
  ], { description: "Must be exactly one of: single, chain, parallel, dag, memory-only. Do not invent values such as broad, direct, planner, or review." }),
  steps: Type.Optional(Type.Array(AgentStepParams, { description: "Required for single/chain/parallel. Omit for dag and memory-only." })),
  stages: Type.Optional(Type.Array(AgentStageParams, { description: "Required for dag. Omit for single/chain/parallel/memory-only." })),
  risk: Type.Optional(Type.Union([Type.Literal("low"), Type.Literal("medium"), Type.Literal("high"), Type.Literal("critical")])),
  needsMemory: Type.Optional(Type.Boolean()),
  needsArtifacts: Type.Optional(Type.Boolean()),
  requiresWorkspaceMutation: Type.Optional(Type.Boolean({ description: "Set true when any routed step is expected to edit, write, create, delete, or otherwise mutate workspace files. Implementation/file-mutation routes require an executor plus final reviewer." })),
  reason: Type.Optional(Type.String({ description: "Why delegation improves correctness, confidence, isolation, or review for this specific task." })),
  dryRun: Type.Optional(Type.Boolean()),
});

const ChalinProjectDiscoveryParams = Type.Object({
  maxDepth: Type.Optional(Type.Number({ description: "Maximum directory depth to index. Default 4." })),
  maxEntries: Type.Optional(Type.Number({ description: "Maximum entries to return. Default 450." })),
});
const ChalinProjectSnapshotParams = Type.Object({});

type ChalinRouteToolParams = {
  task: string;
  topology: "single" | "chain" | "parallel" | "dag" | "memory-only";
  steps?: Array<{ id?: string; agent: string; task: string; budget?: "tight" | "normal" | "deep" | "extended" }>;
  stages?: Array<{ id?: string; name?: string; tasks: Array<{ id?: string; agent: string; task: string; budget?: "tight" | "normal" | "deep" | "extended" }> }>;
  risk?: RouteDecision["risk"];
  needsMemory?: boolean;
  needsArtifacts?: boolean;
  requiresWorkspaceMutation?: boolean;
  reason?: string;
  dryRun?: boolean;
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
    name: "chalin_project_discovery",
    label: "Chalin Project Discovery",
    description: "Return a bounded raw filesystem inventory for local project orientation. It does not infer stack, entrypoints, tests, commands, or importance.",
    promptSnippet: "chalin_project_discovery: get raw project inventory for broad orientation; skip it for bounded direct edits when native find/grep/read is cheaper.",
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
    name: "chalin_project_snapshot",
    label: "Chalin Project Snapshot",
    description: "Legacy alias that returns raw project inventory plus git metadata. It does not infer stack, entrypoints, tests, commands, or importance.",
    promptSnippet: "chalin_project_snapshot: get raw project inventory plus git metadata before branch/diff reconnaissance.",
    promptGuidelines: [
      "Prefer chalin_project_discovery unless git metadata is needed.",
      "Treat this as filesystem/git facts only; choose follow-up reads/searches with LLM judgment.",
      "Do not use for external/current facts; verify final claims from exact file evidence.",
    ],
    parameters: ChalinProjectSnapshotParams,
    async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
      const snapshot = buildProjectSnapshot({ cwd: ctx.cwd });
      return textResult(formatProjectSnapshot(snapshot), { snapshot });
    },
  });

  pi.registerTool({
    name: "chalin_interview",
    label: "Chalin Interview",
    description: "Ask blocking clarification questions in the TUI and persist answers as pi-chalin artifacts before planning or running subagents.",
    promptSnippet: "chalin_interview: when the request is ambiguous or missing critical information, ask concise multiple-choice questions before chalin_route.",
    promptGuidelines: [
      "Use chalin_interview before chalin_route when the user's request has unknown terms, missing scope, uncovered constraints, destructive/risky choices, or multiple valid directions with meaningful tradeoffs.",
      "Ask only what blocks correct planning. Prefer one to five questions per batch. Each question must have two to five concise options and exactly one recommended option when possible.",
      "Always allow a custom answer unless the answer space must be constrained for safety.",
      "After chalin_interview returns, use the persisted answers as artifact context and continue with planning or chalin_route only when you are confident enough.",
    ],
    parameters: ChalinInterviewParams,
    async execute(_toolCallId, params: InterviewRequestInput, _signal, _onUpdate, ctx) {
      const store = new ArtifactStore({ cwd: ctx.cwd });
      const result = await runChalinInterview(ctx, store, params);
      return textResult(formatInterviewResult(result), { interview: result });
    },
  });

  pi.registerTool({
    name: "chalin_route",
    label: "Chalin Route",
    description: "Run a selected pi-chalin subagent workflow for broad, risky, deep, parallel, or multi-surface work; skip bounded direct code/test edits, single-symbol/function bugfixes with local verification, simple named parser/scanner bugfixes, and localized docs edits unless stateful transition review is likely to improve quality.",
    promptSnippet: "chalin_route: use for broad/risky/deep or multi-surface workflows; skip bounded direct code/test edits, single-symbol/function bugfixes with local verification, simple parser/scanner bugfixes, and localized docs edits unless stateful transition review is useful.",
    promptGuidelines: [
      "Use only when subagents materially improve quality, confidence, isolation, or review.",
      "Keep explicit-file bugfix/refactor/add-test work direct unless risk, breadth, ambiguity, or no-rewrite discipline requires isolation.",
      "Keep specific function/symbol/API bugfixes with local verification direct: use one targeted native search/read first, then edit/test; route only after evidence proves broad or risky coupling.",
      "Keep one-behavior code+test tasks with local verification direct until file evidence proves broad ownership, migration, generated-code coupling, unsafe long-file surgery, stateful parser/scanner transition risk, or another concrete risk.",
      "If direct work reveals real breadth, ambiguity, repeated failed verification, generated/cross-runtime coupling, or context pressure, escalate with a compact handoff instead of forcing the parent agent to finish alone.",
      "Keep single docs-only/no-code artifacts with an explicit docs path direct when evidence is cheap; route them only when substantial synthesis or independent review across surfaces is worth the latency.",
      "Keep bounded read-only mini-project reviews direct when the user forbids modification; answer with path evidence.",
      "Valid topology values are exactly: single, chain, parallel, dag, memory-only. Use single/chain/parallel with steps; use dag with stages; use memory-only without steps.",
      "For routed implementation, choose the topology from the task evidence and available agents; do not force a prewritten chain when a smaller or different workflow is enough.",
      "Set requiresWorkspaceMutation for any routed file edit, including docs artifacts. Any routed implementation or file mutation must include an editing/executing worker and a later reviewer who checks the original request, plan/claims, repository standards, gaps, and test/readback evidence.",
      "Add scout/planner/researcher/context-builder only when they materially improve evidence, ownership, alternatives, risk control, or parallelization; otherwise keep the route compact.",
      "Use risk low for explicit docs-only artifact edits; reserve medium/high/critical for product-code mutation, secrets, destructive actions, or security-sensitive execution.",
      "After the result, answer from Final answer material; call more tools only for an explicit critical gap.",
    ],
    parameters: ChalinRouteParams,
    async execute(_toolCallId, params: ChalinRouteToolParams, signal, onUpdate, ctx) {
      const loaded = loadEffectiveConfig({ cwd: ctx.cwd });
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
      let route = routeFromPlan(params);
      const requiresWorkspaceMutation = Boolean(params.requiresWorkspaceMutation) || inferRouteRequiresWorkspaceMutation(route, params.task);
      if (loaded.config.safety.mutationExpectationGuard) {
        route = ensureMutationRouteHasWorkerAndReviewer(route, requiresWorkspaceMutation, params.task);
      }
      route = collapseReadOnlyScoutContextRoute(route, requiresWorkspaceMutation);
      const agents = catalog.list();
      const unknownAgents = route.agents.filter((agent) => !catalog.resolve(agent).agent);

      if (!loaded.config.enabled) {
        return textResult("pi-chalin is disabled for this project. Answer directly or ask the user to run /chalin on.", { route, diagnostics: loaded.diagnostics });
      }
      if (unknownAgents.length > 0) {
        return errorResult(`Unknown pi-chalin agent(s): ${unknownAgents.join(", ")}\nAvailable agents: ${agents.map((agent) => agent.name).join(", ")}\nRetry chalin_route with only available agent names, or answer directly if the task is bounded.`, { route, diagnostics: catalog.diagnostics });
      }
      if (route.kind === "ask-user") {
        return errorResult(`${route.reason}\nRetry chalin_route with a valid topology contract: single/chain/parallel require steps, dag requires stages, and memory-only requires no steps.`, { route });
      }
      const guard = beginChalinRouteInvocation({ dryRun: Boolean(params.dryRun), route });
      if (!guard.allowed) {
        return textResult(guard.reason ?? "chalin_route already executed for this prompt.", { route, guard });
      }
      if (params.dryRun) {
        finishChalinRouteInvocation(guard.invocationId, "dry-run");
        return textResult(formatRoute(route, undefined, { availableAgents: agents.map((agent) => agent.name) }), { route, diagnostics: [...loaded.diagnostics, catalog.diagnostics] });
      }

      clearLegacyChalinControlWidget(ctx);
      onUpdate?.({
        content: [{ type: "text", text: formatChalinRoutePlanWidget(params) }],
        details: { route, run: plannedWidgetRun(route) },
      });

      const preApproval = await kernel.approvalFor(route);
      const approvalOverride = preApproval.action === "ask" && await openSafetyApproval(ctx, route, preApproval)
        ? { action: "allow" as const, reason: "Approved once through Safety Approval." }
        : undefined;
      if (preApproval.action === "block" || (preApproval.action === "ask" && !approvalOverride)) {
        finishChalinRouteInvocation(guard.invocationId, preApproval.action);
        setChalinStatus(ctx, preApproval.action === "block" ? { kind: "failed" } : { kind: "stopped" });
        return textResult(formatRoute(route, { route, approval: preApproval, memories: [], diagnostics: [] }), { route, approval: preApproval });
      }

      const abortSignal = signal ?? new AbortController().signal;
      setChalinStatus(ctx, route.plan ? { kind: "running", intent: routeIntent(route), agent: route.agents[0] ?? route.kind, completed: 0, total: Math.max(route.agents.length, 1) } : { kind: "synthesizing" });
      let result: Awaited<ReturnType<ChalinKernel["handleRoute"]>>;
      try {
        result = await kernel.handleRoute(route, params.task, {
          cwd: ctx.cwd,
          extensionContext: ctx,
          signal: abortSignal,
          onUpdate: (run) => {
            setLatestRun(run);
            setChalinStatus(ctx, footerStateForRun(run));
            onUpdate?.({
              content: [{ type: "text", text: formatChalinRunWidget(run) }],
              details: chalinRouteUpdateDetails(run),
            });
          },
        }, approvalOverride);
      } catch (error) {
        finishChalinRouteInvocation(guard.invocationId, "failed");
        setChalinStatus(ctx, abortSignal.aborted ? { kind: "stopped" } : { kind: "failed" });
        throw error;
      }
      if (result.run) setLatestRun(result.run);
      if (result.approval.action !== "allow") {
        finishChalinRouteInvocation(guard.invocationId, outcomeForResult(result));
        setChalinStatus(ctx, result.approval.action === "block" ? { kind: "failed" } : { kind: "stopped" });
        return finalToolResult(ctx, formatRoute(route, result), compactRouteDetails(route, result, [...loaded.diagnostics, catalog.diagnostics]));
      }
      if (result.run?.status === "paused" || abortSignal.aborted) setChalinStatus(ctx, { kind: "stopped" });
      else if (result.run?.status === "failed") setChalinStatus(ctx, { kind: "failed" });
      else setChalinStatus(ctx, { kind: "complete", intent: routeIntent(route) });
      finishChalinRouteInvocation(guard.invocationId, outcomeForResult(result));

      return finalToolResult(ctx, formatRoute(route, result), compactRouteDetails(route, result, [...loaded.diagnostics, catalog.diagnostics]));
    },
    renderCall(args, theme) {
      void args;
      void theme;
      // Keep the call slot intentionally empty. Pi renders call + result in the
      // same tool component; rendering the full tree in both places creates the
      // duplicated "planned tree + running tree" UX and layout shift while tool
      // arguments stream in. The result slot below is the single source of UI.
      return new Text("", 0, 0);
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
      "Do not create a new chalin_route for a paused run; resume the persisted run instead.",
      "After chalin_resume returns, answer the user from the resumed Final answer material.",
    ],
    parameters: ChalinResumeParams,
    async execute(_toolCallId, params: ChalinResumeToolParams, signal, onUpdate, ctx) {
      const loaded = loadEffectiveConfig({ cwd: ctx.cwd });
      const run = loadResumableRunState({ cwd: ctx.cwd, runId: params.runId });
      if (!run) return textResult(params.runId ? `No resumable pi-chalin run found for '${params.runId}'.` : "No paused or stale pi-chalin run found to resume.", { runId: params.runId });
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
      clearLegacyChalinControlWidget(ctx);
      const abortSignal = signal ?? new AbortController().signal;
      setChalinStatus(ctx, {
        kind: "running",
        intent: routeIntent(run.route),
        agent: run.steps.find((step) => !isUsableStepStatus(step.status))?.agent ?? run.route.agents[0] ?? "chalin",
        completed: run.steps.filter((step) => isUsableStepStatus(step.status)).length,
        total: Math.max(run.steps.length, 1),
      });
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
    description: "Search or list compact durable pi-chalin memory from the primary Pi agent, including direct-mode work. Use without waiting for an explicit memory request when prior decisions, project facts, workflows, preferences, or memory inventory/counts matter.",
    promptSnippet: "chalin_memory_search: recall or list compact durable memory during direct work when prior context or memory inventory may help.",
    promptGuidelines: [
      "Use this as the first tool for explicit memory/recall questions instead of routing through chalin_route.",
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
    promptSnippet: "chalin_memory_write: save durable verified knowledge discovered during direct or routed work.",
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
      const label = urls.length > 0 ? `fetching ${urls.length} URL${urls.length === 1 ? "" : "s"}` : `searching ${params.query ?? "web"}`;
      onUpdate?.({ content: [{ type: "text", text: `chalin web · ${label} via Exa MCP…` }], details: { status: "running", provider: "exa-mcp" } });
      const bundle = urls.length > 0
        ? await fetchWebUrls({ cwd: ctx.cwd, urls, freshness: params.freshness, signal })
        : await searchWeb({ cwd: ctx.cwd, query: params.query ?? "", maxSources: params.maxSources, depth: params.depth, freshness: params.freshness, signal });
      return textResult(formatWebBundle(bundle), bundle);
    },
  });
}

function clampInteger(value: number, min: number, max: number): number {
  const parsed = Math.floor(Number(value));
  if (!Number.isFinite(parsed)) return min;
  return Math.min(max, Math.max(min, parsed));
}

function clampNumber(value: number, min: number, max: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return min;
  return Math.min(max, Math.max(min, parsed));
}

function isMemoryInventoryQuery(query: string): boolean {
  const normalized = query.toLowerCase();
  if (!normalized.trim()) return false;
  return [
    "how many",
    "how much",
    "memory count",
    "count memory",
    "list memory",
    "memory elements",
    "memory records",
    "what elements",
    "what do you have in memory",
    "what is in memory",
    "what's in memory",
  ].some((phrase) => normalized.includes(phrase));
}

function formatMemoryInventory(
  records: MemoryRecord[],
  options: { total: number; omitted: number; status: string; includeEvidence: boolean },
): string {
  const header = `Memory inventory (${records.length}/${options.total} records${options.status !== "all" ? `, status=${options.status}` : ""}). Treat as guidance; current repo evidence wins.`;
  if (options.total === 0) return `${header}\nNo visible memory records found.`;
  return [
    header,
    ...records.map((record) => `- ${formatMemoryInventoryLine(record, options.includeEvidence)}`),
    options.omitted > 0 ? `- ${options.omitted} more record${options.omitted === 1 ? "" : "s"} omitted by limit.` : undefined,
  ].filter((line): line is string => Boolean(line)).join("\n");
}

function formatMemoryInventoryLine(record: MemoryRecord, includeEvidence: boolean): string {
  const meta = [
    record.id,
    record.status,
    record.category,
    record.scope,
    record.sourceAgent ? `source=${record.sourceAgent}` : undefined,
    record.topicKey ? `topic=${record.topicKey}` : undefined,
    record.revisionCount > 1 ? `rev=${record.revisionCount}` : undefined,
  ].filter(Boolean).join(" · ");
  const evidence = includeEvidence && record.evidence ? ` evidence=${truncateForTool(record.evidence, 120)}` : "";
  return `[${meta}] ${truncateForTool(record.content, 260)}${evidence}`;
}

function truncateForTool(text: string, maxChars: number): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxChars) return normalized;
  return `${normalized.slice(0, Math.max(0, maxChars - 1)).trimEnd()}…`;
}

function textResult(text: string, details: unknown) {
  return { content: [{ type: "text" as const, text }], details };
}

function errorResult(text: string, details: unknown) {
  return { content: [{ type: "text" as const, text }], details, isError: true };
}

function finalToolResult(ctx: { hasUI: boolean; abort(): void; shutdown(): void }, text: string, details: unknown) {
  scheduleNonInteractiveShutdown(ctx);
  return textResult(text, details);
}

function scheduleNonInteractiveShutdown(ctx: { hasUI: boolean; abort(): void; shutdown(): void }): void {
  if (ctx.hasUI || process.env.PI_CHALIN_NONINTERACTIVE_SHUTDOWN === "0") return;
  const configuredDelay = Number(process.env.PI_CHALIN_NONINTERACTIVE_SHUTDOWN_DELAY_MS);
  const delayMs = Number.isFinite(configuredDelay) && configuredDelay >= 0 ? configuredDelay : 0;
  const timer = setTimeout(() => {
    try {
      ctx.abort();
      ctx.shutdown();
    } catch {
      // Pi can mark extension contexts stale while a print-mode turn exits.
      // The tool result has already been emitted, so stale shutdown is safe to ignore.
    }
  }, delayMs);
  timer.unref?.();
}
