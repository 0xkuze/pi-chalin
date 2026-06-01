import { Context, Effect, Layer } from "effect";
import { AgentCatalog } from "./agents.ts";
import { ArtifactStore, recordRunArtifactEffect } from "./artifacts.ts";
import { DEFAULT_CONFIG, approvalDecision, type ChalinConfig } from "./config.ts";
import type { MemoryStoreLike } from "./memory.ts";
import { createConfiguredMemoryStore } from "./memory-provider.ts";
import { MockWorkerRunner, SdkWorkerRunner, resumeWorkerRunnerEffect, runWorkerRunnerEffect, type WorkerRunner, type WorkerRunnerContext } from "./runner.ts";
import type { AgentDefinition, AgentStage, AgentStep, AgentThinkingLevel, ApprovalDecision, MemoryRecord, RouteDecision, RouteExpectedEffect, RunState } from "./schemas.ts";
import { recordSkillMetricsEffect } from "./skills.ts";

export interface ChalinKernelOptions {
  cwd?: string;
  config?: ChalinConfig;
  catalog?: AgentCatalog;
  memory?: MemoryStoreLike;
  artifacts?: ArtifactStore;
  runner?: WorkerRunner;
  sdkRunner?: WorkerRunner;
  modelOverrides?: Record<string, string>;
  thinkingOverrides?: Record<string, AgentThinkingLevel>;
}

export interface ChalinHandleResult {
  route: RouteDecision;
  approval: ApprovalDecision;
  run?: RunState;
  memories: MemoryRecord[];
  diagnostics: string[];
}

interface KernelServiceShape {
  readonly kernel: ChalinKernel;
  readonly handleRoute: (route: RouteDecision, prompt: string, context?: Omit<WorkerRunnerContext, "agents" | "modelOverrides">, approvalOverride?: ApprovalDecision) => Effect.Effect<ChalinHandleResult, unknown>;
  readonly handlePrompt: (prompt: string, context?: Omit<WorkerRunnerContext, "agents" | "modelOverrides">) => Effect.Effect<ChalinHandleResult, unknown>;
}

class KernelService extends Context.Tag("pi-chalin/Kernel")<KernelService, KernelServiceShape>() {}

export function kernelLayer(kernel: ChalinKernel): Layer.Layer<KernelService> {
  return Layer.succeed(KernelService, {
    kernel,
    handleRoute: (route, prompt, context, approvalOverride) => Effect.tryPromise(() => kernel.handleRoute(route, prompt, context, approvalOverride)),
    handlePrompt: (prompt, context) => Effect.tryPromise(() => kernel.handlePrompt(prompt, context)),
  });
}

export function createKernelLayer(options?: ChalinKernelOptions): Layer.Layer<KernelService> {
  return kernelLayer(new ChalinKernel(options));
}

function recordRunSkillMetricsEffect(cwd: string, run: RunState): Effect.Effect<void, unknown> {
  const skillEvents = [
    ...(run.metrics?.skillEvents ?? []),
    ...run.steps.flatMap((step) => step.metrics?.skillEvents ?? []),
  ];
  return skillEvents.length > 0
    ? Effect.asVoid(recordSkillMetricsEffect({ cwd }, skillEvents))
    : Effect.void;
}

export class ChalinKernel {
  private readonly cwd: string;
  private readonly config: ChalinConfig;
  private readonly catalog: AgentCatalog;
  private readonly memory: MemoryStoreLike;
  private readonly artifacts: ArtifactStore;
  private readonly runner: WorkerRunner;
  private readonly sdkRunner: WorkerRunner;
  private readonly modelOverrides: Record<string, string>;
  private readonly thinkingOverrides: Record<string, AgentThinkingLevel>;

  constructor(options?: ChalinKernelOptions) {
    this.cwd = options?.cwd ?? process.cwd();
    this.config = options?.config ?? DEFAULT_CONFIG;
    this.catalog = options?.catalog ?? AgentCatalog.load({ cwd: this.cwd });
    this.memory = options?.memory ?? createConfiguredMemoryStore({ cwd: this.cwd }, this.config);
    this.artifacts = options?.artifacts ?? new ArtifactStore({ cwd: this.cwd });
    this.runner = options?.runner ?? new MockWorkerRunner();
    this.sdkRunner = options?.sdkRunner ?? new SdkWorkerRunner();
    this.modelOverrides = options?.modelOverrides ?? this.config.agents.modelOverrides;
    this.thinkingOverrides = options?.thinkingOverrides ?? this.config.agents.thinkingOverrides;
  }

  /**
   * pi-chalin is LLM-routed: the primary Pi agent decides whether to call the
   * chalin_route tool and provides the topology/steps. This method remains as a
   * safe legacy preview path, but it intentionally does not infer workflows from
   * hard-coded prompt keywords.
   */
  classify(prompt: string): RouteDecision {
    const text = prompt.trim();
    if (!text) return askUser("Prompt is empty.");
    return {
      kind: "bypass",
      agents: [],
      risk: "low",
      ambiguity: "low",
      needsMemory: false,
      needsArtifacts: false,
      reason: "pi-chalin uses LLM-first routing: the primary Pi agent decides when to call chalin_route and which agents/topology to use.",
    };
  }

  classifyPlaceholder(prompt: string): RouteDecision {
    return this.classify(prompt);
  }

  async handlePrompt(prompt: string, context: Omit<WorkerRunnerContext, "agents" | "modelOverrides"> = { cwd: this.cwd }): Promise<ChalinHandleResult> {
    return this.handleRoute(this.classify(prompt), prompt, context);
  }

  async handleRoute(route: RouteDecision, prompt: string, context: Omit<WorkerRunnerContext, "agents" | "modelOverrides"> = { cwd: this.cwd }, approvalOverride?: ApprovalDecision): Promise<ChalinHandleResult> {
    return Effect.runPromise(this.handleRouteEffect(route, prompt, context, approvalOverride));
  }

  private handleRouteEffect(
    route: RouteDecision,
    prompt: string,
    context: Omit<WorkerRunnerContext, "agents" | "modelOverrides">,
    approvalOverride?: ApprovalDecision,
  ): Effect.Effect<ChalinHandleResult, unknown> {
    const self = this;
    return Effect.gen(function* () {
      const approval = approvalOverride ?? approvalDecision(self.config, route);
      const diagnostics = [...self.catalog.diagnostics.warnings, ...self.catalog.diagnostics.errors];
      const memories = route.needsMemory && !memoryDisabled() ? yield* Effect.tryPromise(() => self.retrieveRouteMemories(route, prompt)) : [];
      if (approval.action !== "allow" || !route.plan) return { route, approval, memories, diagnostics };

      const agents = self.resolvePlanAgents(route);
      const missing = route.agents.filter((ref) => !agents.has(ref));
      if (missing.length > 0) {
        const blockedApproval: ApprovalDecision = { action: "block", reason: `Unknown pi-chalin agent(s): ${missing.join(", ")}.` };
        return {
          route,
          approval: blockedApproval,
          memories,
          diagnostics: [...diagnostics, `Unknown pi-chalin agent(s): ${missing.join(", ")}.`],
        };
      }

      const runner = context.extensionContext ? self.sdkRunner : self.runner;
      const run = yield* runWorkerRunnerEffect(runner, route, { ...context, cwd: self.cwd, config: self.config, rootTask: prompt, agents, modelOverrides: self.modelOverrides, thinkingOverrides: self.thinkingOverrides });
      const candidates = run.steps.flatMap((step) => step.output?.memoryCandidates ?? []);
      if (candidates.length > 0 && !memoryDisabled()) {
        if (context.extensionContext) {
          self.persistMemoriesAfterToolResult(candidates, run.id, context.extensionContext.hasUI);
        } else {
          yield* Effect.tryPromise(() => self.memory.submitCandidates(candidates));
        }
      }
      yield* recordRunSkillMetricsEffect(self.cwd, run);
      if (route.needsArtifacts || run.steps.length > 1) yield* recordRunArtifactEffect(self.artifacts, run);
      return { route, approval, run, memories, diagnostics };
    }).pipe(Effect.withSpan("kernel.handleRoute"));
  }

  async resumeRun(run: RunState, context: Omit<WorkerRunnerContext, "agents" | "modelOverrides" | "thinkingOverrides"> = { cwd: this.cwd }): Promise<ChalinHandleResult> {
    const approval = resumeApprovalDecision(this.config, run.route);
    const diagnostics = [...this.catalog.diagnostics.warnings, ...this.catalog.diagnostics.errors];
    if (approval.action !== "allow" || !run.route.plan) return { route: run.route, approval, memories: [], diagnostics, run };
    const agents = this.resolvePlanAgents(run.route);
    const runner = context.extensionContext ? this.sdkRunner : this.runner;
    const resumed = await Effect.runPromise(resumeWorkerRunnerEffect(runner, run, { ...context, cwd: this.cwd, config: this.config, rootTask: run.rootTask, agents, modelOverrides: this.modelOverrides, thinkingOverrides: this.thinkingOverrides }));
    const candidates = resumed.steps.flatMap((step) => step.output?.memoryCandidates ?? []);
    if (candidates.length > 0 && !memoryDisabled()) {
      if (context.extensionContext) this.persistMemoriesAfterToolResult(candidates, resumed.id, context.extensionContext.hasUI);
      else await this.memory.submitCandidates(candidates);
    }
    await Effect.runPromise(recordRunSkillMetricsEffect(this.cwd, resumed));
    await this.artifacts.recordRun(resumed);
    return { route: resumed.route, approval, run: resumed, memories: [], diagnostics };
  }

  async approvalFor(route: RouteDecision): Promise<ApprovalDecision> {
    return approvalDecision(this.config, route);
  }

  private async retrieveRouteMemories(route: RouteDecision, prompt: string): Promise<MemoryRecord[]> {
    return (await this.memory.retrieve({ query: prompt, sourceAgent: "primary-pi", limit: 5, tokenBudget: 900 })).results.map((result) => result.record);
  }

  resolvePlanAgents(route: RouteDecision): Map<string, AgentDefinition> {
    const result = new Map<string, AgentDefinition>();
    for (const ref of route.agents) {
      const resolved = this.catalog.resolve(ref);
      if (resolved.agent) result.set(resolved.agent.name, resolved.agent);
    }
    const conflictResolver = this.catalog.resolve("conflict-resolver").agent;
    if (conflictResolver) result.set(conflictResolver.name, conflictResolver);
    return result;
  }

  private persistMemoriesAfterToolResult(candidates: NonNullable<RunState["steps"][number]["output"]>["memoryCandidates"], runId: string, hasUI: boolean): void {
    const configuredDelay = Number(process.env.PI_CHALIN_MEMORY_PERSIST_DELAY_MS);
    const delayMs = Number.isFinite(configuredDelay) && configuredDelay >= 0 ? configuredDelay : hasUI ? 0 : 30_000;
    const timer = setTimeout(() => {
      void this.memory.submitCandidates(candidates).catch((error) => {
        const message = error instanceof Error ? error.message : String(error);
        console.warn(`pi-chalin memory persistence failed after run ${runId}: ${message}`);
      });
    }, delayMs);
    timer.unref?.();
  }
}

function resumeApprovalDecision(config: ChalinConfig, route: RouteDecision): ApprovalDecision {
  const current = approvalDecision(config, route);
  if (current.action === "block") return current;
  return { action: "allow", reason: "Existing pi-chalin run resumes under the start-time approval gate; non-critical routes are not re-approved mid-run." };
}

function askUser(reason: string): RouteDecision {
  return { kind: "ask-user", agents: [], risk: "low", ambiguity: "high", needsMemory: false, needsArtifacts: false, reason };
}

type StrictRoutePlanInput = {
  topology: "sequential" | "dag";
  steps?: AgentStep[];
  stages?: Array<{ id?: string; name?: string; tasks: AgentStep[] }>;
  risk?: RouteDecision["risk"];
  needsMemory?: boolean;
  needsArtifacts?: boolean;
  expectedEffects: RouteExpectedEffect[];
  reason?: string;
};

type LegacyRoutePlanInput = Omit<StrictRoutePlanInput, "expectedEffects"> & {
  expectedEffects?: RouteExpectedEffect[];
};

export function routeFromPlan(input: LegacyRoutePlanInput): RouteDecision {
  return routeFromPlanInternal(input, false);
}

export function routeFromLegacyPlan(input: LegacyRoutePlanInput): RouteDecision {
  return routeFromPlanInternal(input, true);
}

function routeFromPlanInternal(input: LegacyRoutePlanInput, legacyInferExpectedEffects: boolean): RouteDecision {
  const steps = sanitizeSteps(input.steps ?? []);
  if (input.topology === "dag") {
    const stages = sanitizeStages(input.stages ?? []);
    if (stages.length === 0) return askUser("chalin_route dag topology requires at least one stage with agent tasks.");
    const agents = stages.flatMap((stage) => stage.tasks.map((step) => step.agent));
    const allSteps = stages.flatMap((stage) => stage.tasks);
    const expectedEffects = expectedEffectsFromInput(input.expectedEffects, allSteps, legacyInferExpectedEffects);
    if (!expectedEffects) return expectedEffectsRequiredRoute();
    return {
      kind: "multi-agent-dag",
      agents,
      risk: input.risk ?? riskFromPlan(allSteps),
      ambiguity: "low",
      needsMemory: routeNeedsMemory(input.needsMemory),
      needsArtifacts: input.needsArtifacts ?? allSteps.some((step) => ["scout", "planner", "worker", "reviewer", "context-builder"].includes(step.agent)),
      expectedEffects,
      reason: input.reason?.trim() || "Primary Pi agent selected a staged DAG workflow dynamically.",
      plan: { kind: "dag", stages },
    };
  }
  if (steps.length === 0) return askUser("chalin_route sequential topology requires at least one agent step.");

  const agents = steps.map((step) => step.agent);
  const expectedEffects = expectedEffectsFromInput(input.expectedEffects, steps, legacyInferExpectedEffects);
  if (!expectedEffects) return expectedEffectsRequiredRoute();
  return {
    kind: "multi-agent-sequential",
    agents,
    risk: input.risk ?? riskFromPlan(steps),
    ambiguity: "low",
    needsMemory: routeNeedsMemory(input.needsMemory),
    needsArtifacts: input.needsArtifacts ?? steps.some((step) => ["scout", "planner", "worker", "reviewer", "context-builder"].includes(step.agent)),
    expectedEffects,
    reason: input.reason?.trim() || "Primary Pi agent selected this chalin workflow dynamically.",
    plan: { kind: "sequential", steps },
  };
}

function expectedEffectsRequiredRoute(): RouteDecision {
  return askUser("chalin_route requires explicit expectedEffects; set read, write, and/or verify instead of relying on legacy agent-based inference.");
}

function routeNeedsMemory(value: boolean | undefined): boolean {
  return !memoryDisabled() && Boolean(value);
}

function memoryDisabled(): boolean {
  return process.env.PI_CHALIN_DISABLE_MEMORY === "1";
}

function sanitizeSteps(steps: AgentStep[]): AgentStep[] {
  return steps
    .map((step) => ({ id: step.id?.trim(), agent: step.agent.trim(), task: step.task.trim(), budget: sanitizeBudget(step.budget) }))
    .filter((step) => step.agent.length > 0 && step.task.length > 0)
    .slice(0, 6);
}

function sanitizeStages(stages: Array<{ id?: string; name?: string; tasks: AgentStep[] }>): AgentStage[] {
  return stages
    .map((stage, index) => ({
      id: (stage.id ?? stage.name ?? `stage-${index + 1}`).trim() || `stage-${index + 1}`,
      tasks: sanitizeSteps(stage.tasks).slice(0, 10),
    }))
    .filter((stage) => stage.tasks.length > 0)
    .slice(0, 8);
}

function sanitizeBudget(value: AgentStep["budget"]): AgentStep["budget"] | undefined {
  return value === "tight" || value === "normal" || value === "deep" || value === "extended" ? value : undefined;
}

function expectedEffectsFromInput(effects: RouteExpectedEffect[] | undefined, steps: AgentStep[], legacyInferExpectedEffects: boolean): RouteExpectedEffect[] | undefined {
  if (effects !== undefined) return sanitizeExpectedEffects(effects);
  if (legacyInferExpectedEffects) return inferExpectedEffectsFromSteps(steps);
  return undefined;
}

function sanitizeExpectedEffects(effects: RouteExpectedEffect[]): RouteExpectedEffect[] | undefined {
  const valid = new Set<RouteExpectedEffect>(["read", "write", "verify"]);
  const normalized = effects.filter((effect): effect is RouteExpectedEffect => valid.has(effect));
  const unique = [...new Set(normalized)];
  return unique.length > 0 ? unique : undefined;
}

function inferExpectedEffectsFromSteps(steps: AgentStep[]): RouteExpectedEffect[] {
  const effects = new Set<RouteExpectedEffect>(["read"]);
  if (steps.some((step) => step.agent === "worker" || step.agent === "conflict-resolver")) effects.add("write");
  if (steps.some((step) => step.agent === "worker" || step.agent === "reviewer" || step.agent === "conflict-resolver")) effects.add("verify");
  return [...effects];
}

function riskFromPlan(steps: Array<{ agent: string }>): RouteDecision["risk"] {
  if (steps.some((step) => step.agent === "worker")) return "medium";
  return "low";
}

function isMemoryInventoryPrompt(prompt: string): boolean {
  const normalized = prompt.toLowerCase();
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
