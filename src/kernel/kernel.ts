import { Effect } from "effect";
import { AgentCatalog } from "../agents/agents.ts";
import { ArtifactStore, recordRunArtifactEffect } from "../artifacts/artifacts.ts";
import { DEFAULT_CONFIG, approvalDecision, type ChalinConfig } from "../config/config.ts";
import type { MemoryStoreLike } from "../memory/memory.ts";
import { createConfiguredMemoryStore } from "../memory/memory-provider.ts";
import { MockWorkerRunner, SdkWorkerRunner, resumeWorkerRunnerEffect, runWorkerRunnerEffect, type WorkerRunner, type WorkerRunnerContext } from "../runner/runner.ts";
import type { AgentDefinition, AgentStage, AgentStep, AgentThinkingLevel, ApprovalDecision, MemoryRecord, RouteDecision, RouteExpectedEffect, RouteWorkUnitStrategy, RunState } from "../domain/schemas.ts";
import { recordSkillMetricsEffect } from "../skills/skills.ts";

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
      const memories = route.needsMemory && !memoryDisabled() ? yield* Effect.tryPromise(() => self.retrieveRouteMemories(prompt)) : [];
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

  private async retrieveRouteMemories(prompt: string): Promise<MemoryRecord[]> {
    return (await this.memory.retrieve({ query: prompt, sourceAgent: "primary-pi", limit: 5, tokenBudget: 900 })).results.map((result) => result.record);
  }

  resolvePlanAgents(route: RouteDecision): Map<string, AgentDefinition> {
    const result = new Map<string, AgentDefinition>();
    for (const agent of this.catalog.listExecutable()) {
      if (!result.has(agent.name)) result.set(agent.name, agent);
      result.set(`${agent.scope}/${agent.name}`, agent);
    }
    for (const ref of route.agents) {
      const resolved = this.catalog.resolve(ref);
      if (resolved.agent) {
        result.set(ref, resolved.agent);
        result.set(resolved.agent.name, resolved.agent);
      }
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

type RouteBudgetInput = AgentStep["budget"] | "small" | "medium" | "large";
type RouteStepInput = Omit<AgentStep, "budget"> & { budget?: RouteBudgetInput };

export type StrictRoutePlanInput = {
  topology: "sequential" | "dag";
  steps?: RouteStepInput[];
  stages?: Array<{ id?: string; name?: string; tasks?: RouteStepInput[] }>;
  risk?: RouteDecision["risk"];
  needsMemory?: boolean;
  needsArtifacts?: boolean;
  expectedEffects: RouteExpectedEffect[];
  workUnitStrategy?: RouteWorkUnitStrategy;
  fanoutAuthorized?: boolean;
  reason?: string;
};

export function routeFromPlan(input: StrictRoutePlanInput): RouteDecision {
  const steps = sanitizeSteps(input.steps ?? []);
  if (input.topology === "dag") {
    const stages = sanitizeStages(input.stages ?? []);
    if (stages.length === 0) return askUser("Routed dag topology requires at least one stage with agent tasks.");
    const agents = stages.flatMap((stage) => stage.tasks.map((step) => step.agent));
    const expectedEffects = expectedEffectsFromInput(input.expectedEffects);
    if (!expectedEffects) return expectedEffectsRequiredRoute();
    return {
      kind: "multi-agent-dag",
      agents,
      risk: input.risk ?? "low",
      ambiguity: "low",
      needsMemory: routeNeedsMemory(input.needsMemory),
      needsArtifacts: input.needsArtifacts ?? input.expectedEffects.includes("write"),
      expectedEffects,
      workUnitStrategy: sanitizeWorkUnitStrategy(input.workUnitStrategy),
      ...(typeof input.fanoutAuthorized === "boolean" ? { fanoutAuthorized: input.fanoutAuthorized } : {}),
      reason: input.reason?.trim() || "pi-chalin selected a staged DAG workflow dynamically.",
      plan: { kind: "dag", stages },
    };
  }
  if (steps.length === 0) return askUser("Routed sequential topology requires at least one agent step.");

  const agents = steps.map((step) => step.agent);
  const expectedEffects = expectedEffectsFromInput(input.expectedEffects);
  if (!expectedEffects) return expectedEffectsRequiredRoute();
  return {
    kind: "multi-agent-sequential",
    agents,
    risk: input.risk ?? "low",
    ambiguity: "low",
    needsMemory: routeNeedsMemory(input.needsMemory),
    needsArtifacts: input.needsArtifacts ?? input.expectedEffects.includes("write"),
    expectedEffects,
    workUnitStrategy: sanitizeWorkUnitStrategy(input.workUnitStrategy),
    ...(typeof input.fanoutAuthorized === "boolean" ? { fanoutAuthorized: input.fanoutAuthorized } : {}),
    reason: input.reason?.trim() || "pi-chalin selected this workflow dynamically.",
    plan: { kind: "sequential", steps },
  };
}

function expectedEffectsRequiredRoute(): RouteDecision {
  return askUser("Delegated work requires explicit expectedEffects; set read, write, and/or verify so the orchestrator can enforce the right coverage.");
}

function routeNeedsMemory(value: boolean | undefined): boolean {
  return !memoryDisabled() && Boolean(value);
}

function memoryDisabled(): boolean {
  return process.env.PI_CHALIN_DISABLE_MEMORY === "1";
}

function sanitizeSteps(steps: RouteStepInput[]): AgentStep[] {
  return steps
    .map((step) => {
      const files = sanitizeStepFiles(step.files);
      const expectedEffects = step.expectedEffects ? sanitizeExpectedEffects(step.expectedEffects) : undefined;
      return {
        id: step.id?.trim(),
        agent: step.agent.trim(),
        task: step.task.trim(),
        budget: sanitizeBudget(step.budget),
        ...(files ? { files } : {}),
        ...(expectedEffects ? { expectedEffects } : {}),
      };
    })
    .filter((step) => step.agent.length > 0 && step.task.length > 0)
    .slice(0, 6);
}

function sanitizeStages(stages: Array<{ id?: string; name?: string; tasks?: RouteStepInput[] }>): AgentStage[] {
  return stages
    .map((stage, index) => ({
      id: (stage.id ?? stage.name ?? `stage-${index + 1}`).trim() || `stage-${index + 1}`,
      tasks: sanitizeSteps(stage.tasks ?? []).slice(0, 10),
    }))
    .filter((stage) => stage.tasks.length > 0)
    .slice(0, 8);
}

function sanitizeBudget(value: RouteBudgetInput): AgentStep["budget"] | undefined {
  if (value === "small") return "tight";
  if (value === "medium") return "normal";
  if (value === "large") return "deep";
  return value === "tight" || value === "normal" || value === "deep" || value === "extended" ? value : undefined;
}

function sanitizeStepFiles(files: string[] | undefined): string[] | undefined {
  if (!files?.length) return undefined;
  const seen = new Set<string>();
  const result: string[] = [];
  for (const file of files) {
    const normalized = file.trim().replaceAll("\\", "/");
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(normalized);
    if (result.length >= 40) break;
  }
  return result.length ? result : undefined;
}

function sanitizeWorkUnitStrategy(value: RouteWorkUnitStrategy | undefined): RouteWorkUnitStrategy | undefined {
  return value === "none" || value === "discover" || value === "planned" ? value : undefined;
}

function expectedEffectsFromInput(effects: RouteExpectedEffect[]): RouteExpectedEffect[] | undefined {
  return sanitizeExpectedEffects(effects);
}

function sanitizeExpectedEffects(effects: RouteExpectedEffect[]): RouteExpectedEffect[] | undefined {
  const valid = new Set<RouteExpectedEffect>(["read", "write", "verify"]);
  const normalized = effects.filter((effect): effect is RouteExpectedEffect => valid.has(effect));
  const unique = [...new Set(normalized)];
  return unique.length > 0 ? unique : undefined;
}
