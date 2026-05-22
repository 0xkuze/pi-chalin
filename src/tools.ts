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
import type { RouteDecision, RunState } from "./schemas.ts";
import { directExecutionRecommendation, ensureMutationRouteHasWorker } from "./route-guards.ts";
import { compactRouteDetails, finalAnswerMaterial, formatDirectRecommendation, formatRoute, outcomeForResult } from "./route-format.ts";

const AgentStepParams = Type.Object({
  id: Type.Optional(Type.String({ description: "Optional stable step id for DAG stages." })),
  agent: Type.String({ description: "Agent name from the pi-chalin catalog, e.g. scout, planner, worker, reviewer." }),
  task: Type.String({ description: "Concrete bounded task and success criteria for this subagent." }),
  budget: Type.Optional(Type.Union([
    Type.Literal("tight"),
    Type.Literal("normal"),
    Type.Literal("deep"),
    Type.Literal("extended"),
  ], { description: "Per-subagent tool-call budget profile. Use normal by default, deep for project-wide/folder fan-out analysis, extended only for long autonomous stages with artifacts/checkpoints." })),
});

const AgentStageParams = Type.Object({
  id: Type.Optional(Type.String({ description: "Stable stage id, e.g. discover, fanout, review." })),
  name: Type.Optional(Type.String({ description: "Human-readable stage name." })),
  tasks: Type.Array(AgentStepParams, { description: "Tasks that can run in parallel inside this stage." }),
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
  task: Type.String({ description: "The user's request being handled." }),
  topology: Type.Union([
    Type.Literal("single"),
    Type.Literal("chain"),
    Type.Literal("parallel"),
    Type.Literal("dag"),
    Type.Literal("memory-only"),
  ], { description: "The workflow shape chosen by the primary Pi agent." }),
  steps: Type.Optional(Type.Array(AgentStepParams, { description: "Ordered steps for single/chain, independent tasks for parallel. Omit for memory-only." })),
  stages: Type.Optional(Type.Array(AgentStageParams, { description: "For dag topology: ordered stages; tasks inside each stage run in parallel after prior stage completes." })),
  risk: Type.Optional(Type.Union([Type.Literal("low"), Type.Literal("medium"), Type.Literal("high"), Type.Literal("critical")], { description: "Risk estimated by the primary Pi agent." })),
  needsMemory: Type.Optional(Type.Boolean({ description: "Whether pi-chalin should retrieve relevant project/user memory before running." })),
  needsArtifacts: Type.Optional(Type.Boolean({ description: "Whether the workflow is expected to inspect or create artifacts/files." })),
  reason: Type.Optional(Type.String({ description: "Short rationale for using chalin instead of answering directly." })),
  dryRun: Type.Optional(Type.Boolean({ description: "If true, validate and preview the chosen route without running subagents." })),
});

type ChalinRouteToolParams = {
  task: string;
  topology: "single" | "chain" | "parallel" | "dag" | "memory-only";
  steps?: Array<{ id?: string; agent: string; task: string; budget?: "tight" | "normal" | "deep" | "extended" }>;
  stages?: Array<{ id?: string; name?: string; tasks: Array<{ id?: string; agent: string; task: string; budget?: "tight" | "normal" | "deep" | "extended" }> }>;
  risk?: RouteDecision["risk"];
  needsMemory?: boolean;
  needsArtifacts?: boolean;
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
  query: Type.String({ description: "Compact local memory search query." }),
  limit: Type.Optional(Type.Number({ description: "Maximum memories to return. Default 6, max 10." })),
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
  query: string;
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
    description: [
      "Run a pi-chalin workflow chosen by the primary Pi agent.",
      "The caller decides whether chalin is needed, which agents to use, and whether the workflow is single, chained, parallel, DAG/staged, or memory-only.",
      "Do not use for bounded explicit-file refactors/bugfixes; native tools are faster and pi-chalin will recommend direct execution for those.",
    ].join(" "),
    promptSnippet: "chalin_route: delegate broad/risky/deep workflows to pi-chalin subagents; do not use for bounded explicit-file edits.",
    promptGuidelines: [
      "Use chalin_route only when subagents materially improve quality, confidence, context isolation, or review; do not use it for simple direct answers.",
      "Do not call chalin_route for explicit-file refactor/fix/add-test tasks with one to three named files unless the prompt says broad, risky, long-file, security/auth, migration, or no-rewrite.",
      "Do not call chalin_route for bounded read-only mini-project reviews that explicitly forbid file modification; inspect directly and answer with path evidence.",
      "When using chalin_route, choose the minimal agent topology yourself and provide concrete tasks with success criteria.",
      "Use dag topology for staged fan-out/fan-in: for example scout first, multiple folder/module agents in parallel, then reviewer/context-builder synthesis.",
      "After chalin_route returns, immediately answer the user from its Final answer material; do not call more tools unless it explicitly says a critical gap remains.",
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
      if (loaded.config.safety.mutationExpectationGuard) {
        route = ensureMutationRouteHasWorker(route, params.task);
      }
      const agents = catalog.list();
      const unknownAgents = route.agents.filter((agent) => !catalog.resolve(agent).agent);

      if (!loaded.config.enabled) {
        return textResult("pi-chalin is disabled for this project. Answer directly or ask the user to run /chalin on.", { route, diagnostics: loaded.diagnostics });
      }
      if (unknownAgents.length > 0) {
        return textResult(`Unknown pi-chalin agent(s): ${unknownAgents.join(", ")}\nAvailable agents: ${agents.map((agent) => agent.name).join(", ")}`, { route, diagnostics: catalog.diagnostics });
      }
      if (route.kind === "ask-user") {
        return textResult(route.reason, { route });
      }
      const directRecommendation = directExecutionRecommendation(params.task, route);
      if (directRecommendation) {
        const guard = beginChalinRouteInvocation({ dryRun: false, route });
        if (!guard.allowed) {
          return textResult(guard.reason ?? "chalin_route already executed for this prompt.", { route, guard });
        }
        finishChalinRouteInvocation(guard.invocationId, "dry-run");
        setChalinStatus(ctx, { kind: "idle" });
        return textResult(formatDirectRecommendation(route, directRecommendation), {
          route,
          routeGuard: { action: "direct-recommended", reason: directRecommendation },
        });
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
        ? { action: "allow" as const, reason: "Approved once through pi-chalin Safety Approval." }
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
    promptSnippet: "chalin_resume: resume an interrupted pi-chalin run when the user says continue/resume/continua/continúa/sigue/reanuda after ESC, abort, terminal close, or a paused run.",
    promptGuidelines: [
      "Use this before answering from partial findings when the user asks to continue a paused/interrupted chalin run, including short Spanish prompts like `continua`, `continúa`, `sigue`, `reanuda`, or `retoma`.",
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
    description: "Search compact durable pi-chalin memory from the primary Pi agent, including direct-mode work. Use without waiting for an explicit memory request when prior decisions, project facts, workflows, or preferences can reduce rediscovery.",
    promptSnippet: "chalin_memory_search: recall compact durable memory during direct or routed work when prior context may help.",
    promptGuidelines: [
      "Use this proactively for repeated project conventions, prior decisions, user preferences, workflows, and suspected stale assumptions.",
      "Keep queries short and tokenBudget small. Current repository evidence and explicit user instructions override memory.",
      "Ask for evidence only when checking contradictions, reviewing memory, or deciding whether to revise a memory.",
    ],
    parameters: ChalinMemorySearchParams,
    async execute(_toolCallId, params: ChalinMemorySearchToolParams, _signal, _onUpdate, ctx) {
      const memory = createConfiguredMemoryStore({ cwd: ctx.cwd });
      const bundle = await memory.retrieve({
        query: params.query,
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

function textResult(text: string, details: unknown) {
  return { content: [{ type: "text" as const, text }], details };
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
