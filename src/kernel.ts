import { AgentCatalog } from "./agents.ts";
import { ArtifactStore } from "./artifacts.ts";
import { DEFAULT_CONFIG, approvalDecision, type ChalinConfig } from "./config.ts";
import type { MemoryStoreLike } from "./memory.ts";
import { createConfiguredMemoryStore } from "./memory-provider.ts";
import { MockWorkerRunner, SdkWorkerRunner, type WorkerRunner, type WorkerRunnerContext } from "./runner.ts";
import type { AgentDefinition, AgentStage, AgentStep, AgentThinkingLevel, ApprovalDecision, MemoryRecord, RouteDecision, RoutePlan, RunState } from "./schemas.ts";

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
    const approval = approvalOverride ?? approvalDecision(this.config, route);
    const diagnostics = [...this.catalog.diagnostics.warnings, ...this.catalog.diagnostics.errors];
    const memories = route.needsMemory ? (await this.memory.retrieve({ query: prompt, sourceAgent: "primary-pi", limit: 5, tokenBudget: 900 })).results.map((result) => result.record) : [];
    if (approval.action !== "allow" || !route.plan) return { route, approval, memories, diagnostics };

    const agents = this.resolvePlanAgents(route);
    const missing = route.agents.filter((ref) => !agents.has(ref));
    if (missing.length > 0) {
      return {
        route,
        approval: { action: "block", reason: `Unknown pi-chalin agent(s): ${missing.join(", ")}.` },
        memories,
        diagnostics: [...diagnostics, `Unknown pi-chalin agent(s): ${missing.join(", ")}.`],
      };
    }

    const runner = context.extensionContext ? this.sdkRunner : this.runner;
    const run = await runner.run(route, { ...context, cwd: this.cwd, rootTask: prompt, agents, modelOverrides: this.modelOverrides, thinkingOverrides: this.thinkingOverrides });
    const candidates = run.steps.flatMap((step) => step.output?.memoryCandidates ?? []);
    if (candidates.length > 0) {
      if (context.extensionContext) {
        this.persistMemoriesAfterToolResult(candidates, run.id, context.extensionContext.hasUI);
      } else {
        await this.memory.submitCandidates(candidates);
      }
    }
    if (route.needsArtifacts || run.steps.length > 1) await this.artifacts.recordRun(run);
    return { route, approval, run, memories, diagnostics };
  }

  async resumeRun(run: RunState, context: Omit<WorkerRunnerContext, "agents" | "modelOverrides" | "thinkingOverrides"> = { cwd: this.cwd }): Promise<ChalinHandleResult> {
    const approval = resumeApprovalDecision(this.config, run.route);
    const diagnostics = [...this.catalog.diagnostics.warnings, ...this.catalog.diagnostics.errors];
    if (approval.action !== "allow" || !run.route.plan) return { route: run.route, approval, memories: [], diagnostics, run };
    const agents = this.resolvePlanAgents(run.route);
    const runner = context.extensionContext ? this.sdkRunner : this.runner;
    const resumed = runner.resume
      ? await runner.resume(run, { ...context, cwd: this.cwd, rootTask: run.rootTask, agents, modelOverrides: this.modelOverrides, thinkingOverrides: this.thinkingOverrides })
      : await runner.run(run.route, { ...context, cwd: this.cwd, rootTask: run.rootTask, agents, modelOverrides: this.modelOverrides, thinkingOverrides: this.thinkingOverrides });
    const candidates = resumed.steps.flatMap((step) => step.output?.memoryCandidates ?? []);
    if (candidates.length > 0) {
      if (context.extensionContext) this.persistMemoriesAfterToolResult(candidates, resumed.id, context.extensionContext.hasUI);
      else await this.memory.submitCandidates(candidates);
    }
    await this.artifacts.recordRun(resumed);
    return { route: resumed.route, approval, run: resumed, memories: [], diagnostics };
  }

  async approvalFor(route: RouteDecision): Promise<ApprovalDecision> {
    return approvalDecision(this.config, route);
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

export function routeFromPlan(input: {
  topology: "single" | "chain" | "parallel" | "dag" | "memory-only";
  steps?: AgentStep[];
  stages?: Array<{ id?: string; name?: string; tasks: AgentStep[] }>;
  risk?: RouteDecision["risk"];
  needsMemory?: boolean;
  needsArtifacts?: boolean;
  reason?: string;
}): RouteDecision {
  const steps = sanitizeSteps(input.steps ?? []);
  if (input.topology === "memory-only") {
    return {
      kind: "memory-only",
      agents: [],
      risk: input.risk ?? "low",
      ambiguity: "low",
      needsMemory: true,
      needsArtifacts: false,
      reason: input.reason?.trim() || "Primary Pi agent requested pi-chalin memory lookup.",
    };
  }
  if (input.topology === "dag") {
    const stages = sanitizeStages(input.stages ?? []);
    if (stages.length === 0) return askUser("chalin_route dag topology requires at least one stage with agent tasks.");
    const agents = stages.flatMap((stage) => stage.tasks.map((step) => step.agent));
    const allSteps = stages.flatMap((stage) => stage.tasks);
    return {
      kind: "multi-agent-dag",
      agents,
      risk: input.risk ?? riskFromPlan(allSteps),
      ambiguity: "low",
      needsMemory: Boolean(input.needsMemory),
      needsArtifacts: input.needsArtifacts ?? allSteps.some((step) => ["scout", "planner", "worker", "reviewer", "context-builder"].includes(step.agent)),
      reason: input.reason?.trim() || "Primary Pi agent selected a staged DAG workflow dynamically.",
      plan: { kind: "dag", stages },
    };
  }
  if (steps.length === 0) return askUser("chalin_route requires at least one agent step unless topology is memory-only.");

  const agents = steps.map((step) => step.agent);
  const plan = planFromTopology(input.topology, steps);
  return {
    kind: kindFromTopology(input.topology, steps.length),
    agents,
    risk: input.risk ?? riskFromPlan(steps),
    ambiguity: "low",
    needsMemory: Boolean(input.needsMemory),
    needsArtifacts: input.needsArtifacts ?? steps.some((step) => ["scout", "planner", "worker", "reviewer", "context-builder"].includes(step.agent)),
    reason: input.reason?.trim() || "Primary Pi agent selected this chalin workflow dynamically.",
    plan,
  };
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

function kindFromTopology(topology: "single" | "chain" | "parallel", stepCount: number): RouteDecision["kind"] {
  if (topology === "parallel") return "multi-agent-parallel";
  if (topology === "chain" || stepCount > 1) return "multi-agent-chain";
  return "single-agent";
}

function planFromTopology(topology: "single" | "chain" | "parallel", steps: AgentStep[]): RoutePlan {
  if (topology === "parallel") return { kind: "parallel", tasks: steps };
  if (topology === "chain" || steps.length > 1) return { kind: "chain", steps };
  return { kind: "single", agent: steps[0]!.agent, task: steps[0]!.task, budget: steps[0]!.budget };
}

function sanitizeBudget(value: AgentStep["budget"]): AgentStep["budget"] | undefined {
  return value === "tight" || value === "normal" || value === "deep" || value === "extended" ? value : undefined;
}

function riskFromPlan(steps: Array<{ agent: string }>): RouteDecision["risk"] {
  if (steps.some((step) => step.agent === "worker")) return "medium";
  return "low";
}
