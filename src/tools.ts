import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { mergedSessionModelOverrides, mergedSessionThinkingOverrides } from "./agent-overrides.ts";
import { AgentCatalog } from "./agents.ts";
import { ArtifactStore } from "./artifacts.ts";
import { loadEffectiveConfig } from "./config.ts";
import { ChalinKernel, routeFromPlan } from "./kernel.ts";
import { MemoryStore } from "./memory.ts";
import { formatInterviewResult, runChalinInterview, type InterviewRequestInput } from "./interview.ts";
import { loadResumableRunState } from "./runner.ts";
import { beginChalinRouteInvocation, finishChalinRouteInvocation, setLatestRun, type ChalinRouteOutcome } from "./runtime-state.ts";
import { clearLegacyChalinControlWidget, openSafetyApproval, setChalinStatus } from "./ui.ts";
import { fetchWebUrls, formatWebBundle, searchWeb } from "./webfetch.ts";
import type { AgentStep, RouteDecision, RunState, RunStatus } from "./schemas.ts";

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

type ChalinRouteWidgetStep = {
  id?: string;
  agent: string;
  task?: string;
  status?: RunStatus;
  model?: string;
  thinkingLevel?: string;
  error?: string;
  handoff?: string;
};

type ChalinRouteWidgetDetails = {
  route?: RouteDecision;
  run?: {
    id: string;
    status: RunStatus;
    steps: ChalinRouteWidgetStep[];
    metrics?: RunState["metrics"];
    warnings?: string[];
  };
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
      const memory = new MemoryStore({ cwd: ctx.cwd });
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
    promptSnippet: "chalin_resume: resume an interrupted pi-chalin run when the user says continue/resume after ESC, abort, terminal close, or a paused run.",
    promptGuidelines: [
      "Use this before answering from partial findings when the user asks to continue a paused/interrupted chalin run.",
      "Do not create a new chalin_route for a paused run; resume the persisted run instead.",
      "After chalin_resume returns, answer the user from the resumed Final answer material.",
    ],
    parameters: ChalinResumeParams,
    async execute(_toolCallId, params: ChalinResumeToolParams, signal, onUpdate, ctx) {
      const loaded = loadEffectiveConfig({ cwd: ctx.cwd });
      const run = loadResumableRunState({ cwd: ctx.cwd, runId: params.runId });
      if (!run) return textResult(params.runId ? `No resumable pi-chalin run found for '${params.runId}'.` : "No paused or stale pi-chalin run found to resume.", { runId: params.runId });
      const catalog = AgentCatalog.load({ cwd: ctx.cwd });
      const memory = new MemoryStore({ cwd: ctx.cwd });
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

function textResult(text: string, details: unknown) {
  return { content: [{ type: "text" as const, text }], details };
}

function finalToolResult(ctx: { hasUI: boolean; abort(): void; shutdown(): void }, text: string, details: unknown) {
  scheduleNonInteractiveShutdown(ctx);
  return textResult(text, details);
}

export function formatChalinRoutePlanWidget(params: ChalinRouteToolParams): string {
  const steps = plannedWidgetSteps(params);
  const title = routeTitle(params.topology, params.task);
  const agents = steps.map((step) => step.agent).filter(Boolean);
  return [
    `pi-chalin · ${title}`,
    agents.length ? `agents: ${compactAgentPath(agents)} · 0/${steps.length || 1}` : "agents: memory · 0/1",
    ...steps.slice(0, 8).map((step, index) => `${treePrefix(index, steps.length)} ${statusGlyph(step.status ?? "pending")} ${step.agent} — ${truncate(step.task ?? "waiting", 76)}`),
    steps.length > 8 ? `└ … +${steps.length - 8} more` : undefined,
  ].filter((line): line is string => Boolean(line)).join("\n");
}

export function formatChalinRunWidget(run: RunState): string {
  return formatChalinRunWidgetFromDetails(chalinRouteUpdateDetails(run));
}

function formatChalinRunWidgetFromDetails(details: ChalinRouteWidgetDetails): string {
  const run = details.run;
  if (!run) return "pi-chalin · no run";
  const route = details.route;
  const steps = run.steps;
  const completed = steps.filter((step) => isUsableStepStatus(step.status)).length;
  const active = activeWidgetStep(run.status, steps);
  const title = route ? routeIntent(route) : "workflow";
  const displayStatus = run.status === "budget-capped" && completed === (steps.length || 1) ? "done" : statusLabel(run.status);
  const activeLabel = run.status === "failed" ? "blocked" : "current";
  return [
    `pi-chalin · ${title} · ${displayStatus} · ${completed}/${steps.length || 1}`,
    active ? `${activeLabel}: ${active.agent} — ${truncate(active.error ?? active.task ?? statusLabel(active.status ?? "pending"), 86)}` : undefined,
    ...steps.slice(0, 8).map((step, index) => formatWidgetStep(step, index, steps.length, run.status)),
    steps.length > 8 ? `└ … +${steps.length - 8} more` : undefined,
    formatWidgetGuards(run.metrics),
  ].filter((line): line is string => Boolean(line)).join("\n");
}

function activeWidgetStep(runStatus: RunStatus, steps: ChalinRouteWidgetStep[]): ChalinRouteWidgetStep | undefined {
  if (runStatus === "failed") return steps.find((step) => step.status === "failed");
  if (runStatus === "running" || runStatus === "pending") {
    return steps.find((step) => step.status === "running") ?? steps.find((step) => step.status === "pending");
  }
  return undefined;
}

function plannedWidgetRun(route: RouteDecision): ChalinRouteWidgetDetails["run"] {
  return {
    id: "planned",
    status: "pending",
    steps: route.plan ? plannedStepsFromRoute(route).map((step) => ({ ...step, status: "pending" })) : [],
    warnings: [],
  };
}

function chalinRouteUpdateDetails(run: RunState): ChalinRouteWidgetDetails {
  return {
    route: run.route,
    run: {
      id: run.id,
      status: run.status,
      metrics: run.metrics,
      warnings: run.warnings,
      steps: run.steps.map((step) => ({
        id: step.id,
        agent: step.agent,
        task: step.task,
        status: step.status,
        model: step.model,
        thinkingLevel: step.thinkingLevel,
        error: step.error,
        handoff: truncate(step.output?.handoff || step.output?.text || "", 180),
      })),
    },
  };
}

function plannedStepsFromRoute(route: RouteDecision): ChalinRouteWidgetStep[] {
  const plan = route.plan;
  if (!plan) return [];
  if (plan.kind === "single") return [{ agent: plan.agent, task: plan.task }];
  if (plan.kind === "chain") return plan.steps;
  if (plan.kind === "parallel") return plan.tasks;
  return plan.stages.flatMap((stage) => stage.tasks.map((step) => ({ ...step, id: `${stage.id}:${step.id ?? step.agent}` })));
}

function plannedWidgetSteps(params: ChalinRouteToolParams): ChalinRouteWidgetStep[] {
  if (params.topology === "single") {
    const first = params.steps?.[0];
    return first ? [first] : [];
  }
  if (params.topology === "chain" || params.topology === "parallel") return params.steps ?? [];
  if (params.topology === "dag") return params.stages?.flatMap((stage) => stage.tasks.map((step) => ({ ...step, id: `${stage.id ?? "stage"}:${step.id ?? step.agent}` }))) ?? [];
  return [{ agent: "memory", task: params.task, status: "pending" }];
}

function formatWidgetStep(step: ChalinRouteWidgetStep, index: number, total: number, runStatus?: RunStatus): string {
  const detail = step.status === "complete"
    ? step.handoff || "done"
    : step.status === "failed"
      ? step.error || "failed"
      : step.status === "paused"
        ? step.error || "paused"
        : step.status === "budget-capped"
          ? step.handoff || step.error || step.task || "checkpoint saved"
          : step.status === "pending" && runStatus === "failed"
            ? "skipped after failure"
          : step.task || "working";
  const suffix = step.status === "budget-capped" ? " · budget limit reached" : "";
  return `${treePrefix(index, total)} ${statusGlyph(step.status)} ${step.agent} — ${truncate(detail, 88)}${suffix}`;
}

function statusGlyph(status: RunStatus | undefined): string {
  if (status === "complete" || status === "budget-capped") return "✓";
  if (status === "running") return "◆";
  if (status === "failed") return "×";
  if (status === "paused") return "■";
  return "○";
}

function statusLabel(status: RunStatus): string {
  if (status === "complete") return "done";
  if (status === "failed") return "failed";
  if (status === "paused") return "paused";
  if (status === "budget-capped") return "checkpointed";
  if (status === "running") return "running";
  return "pending";
}

function isUsableStepStatus(status: RunStatus | undefined): boolean {
  return status === "complete" || status === "budget-capped";
}

function treePrefix(index: number, total: number): string {
  return index === total - 1 ? "└" : "├";
}

function routeTitle(topology: ChalinRouteToolParams["topology"], task: string): string {
  if (topology === "memory-only") return "memory lookup";
  return `${topology} · ${truncate(task, 52)}`;
}

function compactAgentPath(agents: string[]): string {
  const compact = agents.slice(0, 5).join(" → ");
  return agents.length > 5 ? `${compact} → +${agents.length - 5}` : compact;
}

function colorizeChalinWidget(text: string, theme: { fg(scope: string, value: string): string; bold(value: string): string }): string {
  return text.split("\n").map((line, index) => {
    if (index === 0) return theme.fg("toolTitle", theme.bold(line));
    if (/current:/.test(line)) return theme.fg("muted", line);
    if (/✓/.test(line)) return theme.fg("success", line);
    if (/×|failed|attention/.test(line)) return theme.fg("error", line);
    if (/budget: limit reached/.test(line)) return theme.fg("warning", line);
    if (/◆/.test(line)) return theme.fg("accent", line);
    return theme.fg("dim", line);
  }).join("\n");
}

function formatWidgetGuards(metrics: RunState["metrics"] | undefined): string {
  if (!metrics) return "tools: 0 · guards: checking";
  const policyViolations = metrics.policyViolations?.length ?? 0;
  const budgetStops = metrics.budgetStopCount ?? 0;
  if (policyViolations > 0) return `tools: ${metrics.toolCalls} · guards: attention · ${policyViolations} policy`;
  if (budgetStops > 0) return `tools: ${metrics.toolCalls} · guards: ok · budget: limit reached (${budgetStops} stops)`;
  return `tools: ${metrics.toolCalls} · guards: ok`;
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

function formatRoute(route: RouteDecision, result: Awaited<ReturnType<ChalinKernel["handleRoute"]>> | undefined, options: { availableAgents?: string[] } = {}): string {
  if (!result) {
    return [
      `Chalin workflow: ${route.kind}`,
      `Agents: ${route.agents.join(" → ") || "none"}`,
      `Risk: ${route.risk}`,
      `Reason: ${route.reason}`,
      options.availableAgents ? `\nAvailable agents: ${options.availableAgents.join(", ") || "none"}` : undefined,
    ].filter((line): line is string => line !== undefined).join("\n");
  }

  const finalMaterial = finalAnswerMaterial(result.run);
  const supportingFindings = supportingAgentFindings(result.run);
  const lines = [
    `pi-chalin completed: ${route.agents.join(" → ") || route.kind}`,
    `status: ${result.run?.status ?? result.approval.action}`,
    result.approval.action === "allow"
      ? "Instruction for the primary Pi agent: answer the user now from the Final answer material below. Do not call more tools unless it explicitly says a critical gap remains."
      : "Instruction for the primary Pi agent: pi-chalin did not execute because approval is required. Do not claim completion. If this is a safe explicit user-requested edit, continue directly with native tools; otherwise explain that approval is required.",
    result.approval.action !== "allow" ? `Approval: ${result.approval.action} — ${result.approval.reason}` : undefined,
    result.memories.length > 0 ? `Memory used: ${result.memories.length}` : undefined,
    finalMaterial ? "\nFinal answer material:" : undefined,
    finalMaterial,
    supportingFindings ? "\nSupporting findings:" : undefined,
    supportingFindings,
    !finalMaterial && result.run ? "\nSubagent handoff:" : undefined,
    !finalMaterial && result.run ? result.run.steps.map(formatStep).join("\n") : undefined,
    options.availableAgents ? `\nAvailable agents: ${options.availableAgents.join(", ") || "none"}` : undefined,
  ];
  return lines.filter((line): line is string => line !== undefined && line.length > 0).join("\n");
}

export function finalAnswerMaterial(run: RunState | undefined): string | undefined {
  if (!run) return undefined;
  const completeSteps = run.steps.filter((step) => isUsableStepStatus(step.status));
  if (shouldAggregateFinalMaterial(run, completeSteps)) {
    const material = completeSteps
      .map((step) => {
        const output = stepFullOutput(step);
        return output ? `## ${step.agent}\n${output}` : undefined;
      })
      .filter((item): item is string => Boolean(item))
      .join("\n\n");
    return material ? truncate(material, finalAnswerMaterialBudget(run)) : undefined;
  }
  const primary = completeSteps.at(-1) ?? run.steps.at(-1);
  const output = primary ? stepOutput(primary) : undefined;
  return output ? truncate(output, finalAnswerMaterialBudget(run)) : undefined;
}

function shouldAggregateFinalMaterial(run: RunState, completeSteps: RunState["steps"]): boolean {
  if (completeSteps.length <= 1) return false;
  if (run.route.kind === "multi-agent-dag") return true;
  return /\b(deep|in[- ]depth|profundidad|profundo|an[aá]lisis|project analysis|Coverage Matrix|Evidence Table)\b/i.test(run.route.reason);
}

function finalAnswerMaterialBudget(run: RunState): number {
  const parsed = Number(process.env.PI_CHALIN_FINAL_MATERIAL_CHARS);
  if (Number.isFinite(parsed) && parsed > 500) return Math.floor(parsed);
  if (run.route.kind === "multi-agent-dag") return 12000;
  if (/\b(deep|in[- ]depth|profundidad|profundo|an[aá]lisis|project analysis|Coverage Matrix|Evidence Table)\b/i.test(run.route.reason)) return 10000;
  return 1200;
}

function supportingAgentFindings(run: RunState | undefined): string | undefined {
  if (!run) return undefined;
  const completeSteps = run.steps.filter((step) => isUsableStepStatus(step.status));
  if (completeSteps.length <= 1) return undefined;
  return completeSteps
    .slice(0, -1)
    .map((step) => `- ${step.agent}: ${truncate(stepOutput(step) || "no output", 260)}`)
    .join("\n");
}

function stepOutput(step: RunState["steps"][number]): string | undefined {
  return step.output?.handoff || step.output?.text || step.output?.raw || step.error;
}

function stepFullOutput(step: RunState["steps"][number]): string | undefined {
  return step.output?.text || step.output?.raw || step.output?.handoff || step.error;
}

function outcomeForResult(result: Awaited<ReturnType<ChalinKernel["handleRoute"]>>): ChalinRouteOutcome {
  if (result.approval.action === "ask") return "ask";
  if (result.approval.action === "block") return "block";
  if (result.run?.status === "failed") return "failed";
  if (result.run?.status === "paused") return "paused";
  return "complete";
}

export function ensureMutationRouteHasWorker(route: RouteDecision, task: string): RouteDecision {
  if (!taskExpectsWorkspaceMutation(task) || route.kind === "memory-only" || route.kind === "ask-user" || route.agents.includes("worker")) return route;
  if (!route.plan) return route;

  const workerStep: AgentStep = {
    id: "implementation",
    agent: "worker",
    task: [
      "Implement the user's requested workspace changes.",
      "Preserve existing behavior, satisfy every explicit acceptance criterion, and run or update relevant tests when available.",
      `Original task: ${task}`,
    ].join(" "),
    budget: "normal",
  };
  const reason = `${route.reason} Mutation task normalized by pi-chalin: added a worker step because implementation routes must include an executor.`;

  if (route.plan.kind === "dag") {
    return {
      ...route,
      agents: [...route.agents, "worker"],
      needsArtifacts: true,
      reason,
      plan: {
        kind: "dag",
        stages: [...route.plan.stages, { id: "implementation", tasks: [workerStep] }],
      },
    };
  }

  const existingSteps = route.plan.kind === "single"
    ? [{ id: "existing", agent: route.plan.agent, task: route.plan.task, budget: route.plan.budget }]
    : route.plan.kind === "chain" ? route.plan.steps : route.plan.tasks;
  const reviewerIndex = existingSteps.findIndex((step) => step.agent === "reviewer");
  const steps = reviewerIndex >= 0
    ? [...existingSteps.slice(0, reviewerIndex), workerStep, ...existingSteps.slice(reviewerIndex)]
    : [...existingSteps, workerStep];
  return {
    ...route,
    kind: "multi-agent-chain",
    agents: steps.map((step) => step.agent),
    needsArtifacts: true,
    reason,
    plan: { kind: "chain", steps },
  };
}

function taskExpectsWorkspaceMutation(task: string): boolean {
  return /\b(refactoriza|implementa|a[nñ]ade|a[nñ]adir|actualiza|modifica|corrige|arregla|crea|extrae|implement|add|update|modify|fix|create|write|edit|extract|scaffold)\b/i.test(task)
    || /\brefactor\b/i.test(task) && /\b(src\/|test\/|archivo|file|\.tsx?|\.jsx?|\.py|\.go|\.rs)\b/i.test(task);
}

export function directExecutionRecommendation(task: string, route: RouteDecision): string | undefined {
  if (route.kind === "memory-only" || route.kind === "ask-user") return undefined;
  if (route.risk === "high" || route.risk === "critical") return undefined;
  if (isBoundedReadOnlyReview(task)) {
    return [
      "Direct execution recommended: this is a bounded read-only review that explicitly forbids file changes.",
      "Use native read/grep/find/ls tools only; inspect the small relevant file set directly, perform no writes, and answer with concrete path evidence.",
    ].join(" ");
  }
  if (!taskExpectsWorkspaceMutation(task)) return undefined;
  if (!hasExplicitFileTargets(task)) return undefined;
  if (hasBroadOrRiskyScope(task)) return undefined;
  return [
    "Direct execution recommended: this is a bounded explicit-file mutation.",
    "Use native read/edit/write/bash tools instead of subagents; inspect the named target file(s), make the requested change, run the nearest relevant verification command, fix failures and rerun after the final edit, then answer with paths plus passing verification status.",
  ].join(" ");
}

function hasExplicitFileTargets(task: string): boolean {
  const matches = task.match(/\b[\w@.-]+(?:\/[\w@.-]+)+\.[a-zA-Z0-9]+\b/g) ?? [];
  return matches.length > 0 && new Set(matches).size <= 3;
}

function isBoundedReadOnlyReview(task: string): boolean {
  if (taskExpectsWorkspaceMutation(task)) return false;
  if (!/\b(revisa|review|audit|audita|inspect|inspecciona)\b/i.test(task)) return false;
  if (!/\b(no modifiques|no modificar|no edits?|do not modify|don't modify|read[- ]only|solo lectura|sin modificar)\b/i.test(task)) return false;
  if (hasBroadReadOnlyScope(task)) return false;
  return /\b(mini|small|peque[nñ]o|bounded|concret[oa]s?|specific paths?|paths concretos|file evidence|evidencia)\b/i.test(task)
    || hasExplicitFileTargets(task);
}

function hasBroadReadOnlyScope(task: string): boolean {
  return /\b(project[- ]wide|entire project|whole project|all files|monorepo|architecture|migration|migraci[oó]n|deep|en profundidad|broad|amplio|large|complex|risky)\b/i.test(task);
}

function hasBroadOrRiskyScope(task: string): boolean {
  return /\b(project[- ]wide|entire project|whole project|all files|monorepo|architecture|migration|migraci[oó]n|security|seguridad|auth|authentication|authorization|permissions?|database|schema|concurrency|race condition|large|complex|risky|long file|archivo largo|surgical|quir[uú]rgic|no rewrite|sin reescribir)\b/i.test(task);
}

function formatDirectRecommendation(route: RouteDecision, reason: string): string {
  return [
    "pi-chalin direct execution recommended",
    "status: direct-recommended",
    reason,
    `Original route: ${route.kind} · ${route.agents.join(" → ") || "none"}`,
    "Instruction for the primary Pi agent: do not claim completion from this tool result. Continue now with native tools and complete the bounded edit directly.",
  ].join("\n");
}

function formatStep(step: RunState["steps"][number]): string {
  return `- ${step.agent}: ${truncate(stepOutput(step) || "no output", 420)}`;
}

function compactRouteDetails(route: RouteDecision, result: Awaited<ReturnType<ChalinKernel["handleRoute"]>>, diagnostics: unknown[]) {
  return {
    route,
    approval: result.approval,
    memoriesUsed: result.memories?.length ?? 0,
    run: result.run ? {
      id: result.run.id,
      status: result.run.status,
      logsPath: result.run.logsPath,
      metrics: result.run.metrics,
      steps: result.run.steps.map((step) => ({
        agent: step.agent,
        status: step.status,
      model: step.model,
      thinkingLevel: step.thinkingLevel,
      error: step.error,
        handoff: truncate(step.output?.handoff || step.output?.text || step.error || "", 600),
      })),
    } : undefined,
    diagnostics,
  };
}

function footerStateForRun(run: RunState): Parameters<typeof setChalinStatus>[1] {
  const active = run.steps.find((step) => step.status === "running") ?? run.steps.find((step) => step.status === "pending");
  const completed = run.steps.filter((step) => isUsableStepStatus(step.status)).length;
  const total = run.steps.length || 1;
  if (run.status === "complete") return { kind: "complete", intent: routeIntent(run.route) };
  if (run.status === "paused") return { kind: "stopped" };
  if (run.status === "failed") return { kind: "failed" };
  return { kind: "running", intent: routeIntent(run.route), agent: active?.agent ?? run.route.agents[0] ?? run.status, completed, total };
}

function routeIntent(route: RouteDecision): string {
  if (route.kind === "memory-only") return "memory lookup";
  if (route.agents.includes("worker")) return "implement safely";
  if (route.agents.includes("reviewer")) return "review";
  if (route.agents.includes("context-builder")) return "understand";
  if (route.agents.includes("planner")) return "plan";
  return route.agents[0] ?? route.kind;
}

function truncate(text: string, max: number): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  return normalized.length <= max ? normalized : `${normalized.slice(0, max - 1)}…`;
}
