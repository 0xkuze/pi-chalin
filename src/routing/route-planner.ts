import { StringEnum, Type, type Api, type AssistantMessage, type Model } from "@earendil-works/pi-ai";
import { createAgentSession, DefaultResourceLoader, defineTool, getAgentDir, SessionManager, type ModelRegistry } from "@earendil-works/pi-coding-agent";
import type { AgentCatalog } from "../agents/agents.ts";
import type { AgentDefinition, RouteDecision, RouteExpectedEffect, RouteRisk, RouteWorkUnitStrategy } from "../domain/schemas.ts";
import { routeFromPlan, type StrictRoutePlanInput } from "../kernel/kernel.ts";
import { errorMessage, isRecord } from "../utils/guards.ts";
import { compactString, parseJsonObject } from "../utils/json.ts";

export type ChalinRouteTopologyInput = "auto" | "sequential" | "dag" | "chain" | "parallel";
type NormalizedChalinRouteTopologyInput = "auto" | "sequential" | "dag";

export type ChalinDelegationStep = {
  id?: string;
  agent: string;
  task: string;
  files?: string[];
  expectedEffects?: RouteExpectedEffect[];
};

export type ChalinRoutePlannerInput = {
  task: string;
  topology?: ChalinRouteTopologyInput;
  steps?: ChalinDelegationStep[];
  stages?: Array<{ id?: string; name?: string; tasks?: ChalinDelegationStep[] }>;
  risk?: RouteRisk;
  needsMemory?: boolean;
  needsArtifacts?: boolean;
  expectedEffects?: RouteExpectedEffect[];
  workUnitStrategy?: RouteWorkUnitStrategy;
  fanoutAuthorized?: boolean;
  requiresWorkspaceMutation?: boolean;
  reason?: string;
};

export type ChalinRoutePlanningSource = "llm" | "failed";

export type ChalinRoutePlanningResult = {
  route: RouteDecision;
  source: ChalinRoutePlanningSource;
  diagnostics: string[];
  requiresWorkspaceMutation?: boolean;
};

export type ChalinRoutePlannerOutput = {
  plan: StrictRoutePlanInput;
  requiresWorkspaceMutation: boolean;
};

export type ChalinRoutePlannerRunResult = {
  output?: ChalinRoutePlannerOutput;
  diagnostics: string[];
};

export type ChalinRoutePlanner = (
  input: ChalinRoutePlannerInput,
  context: ChalinRoutePlanningContext,
) => Promise<ChalinRoutePlannerRunResult>;

export interface ChalinRoutePlanningContext {
  cwd: string;
  catalog: AgentCatalog;
  model?: Model<Api>;
  modelRegistry?: ModelRegistry;
  signal?: AbortSignal;
  planner?: ChalinRoutePlanner;
}

type PlannerStepInput = NonNullable<StrictRoutePlanInput["steps"]>[number];
type PlannerStageInput = NonNullable<StrictRoutePlanInput["stages"]>[number];

const ROUTE_PLANNER_TOOL_NAME = "chalin_route_plan";
const ROUTE_TOPOLOGIES = ["sequential", "dag"] as const;
const ROUTE_RISKS = ["low", "medium", "high", "critical"] as const;
const ROUTE_EFFECTS = ["read", "write", "verify"] as const satisfies readonly RouteExpectedEffect[];
const ROUTE_WORK_UNIT_STRATEGIES = ["none", "planned", "discover"] as const satisfies readonly RouteWorkUnitStrategy[];
const ROUTE_PLANNER_RESULT_KEYS = new Set([
  "topology",
  "steps",
  "stages",
  "risk",
  "needsMemory",
  "needsArtifacts",
  "expectedEffects",
  "workUnitStrategy",
  "fanoutAuthorized",
  "requiresWorkspaceMutation",
  "reason",
]);
const ROUTE_PLANNER_STEP_KEYS = new Set(["id", "agent", "task", "files", "expectedEffects"]);
const ROUTE_PLANNER_STAGE_KEYS = new Set(["id", "tasks"]);

const ROUTE_PLANNER_STEP_SCHEMA = Type.Object({
  id: Type.Optional(Type.String({ minLength: 1, maxLength: 80, description: "Stable short step id." })),
  agent: Type.String({ minLength: 1, maxLength: 120, description: "Agent reference from the available roster." }),
  task: Type.String({ minLength: 12, maxLength: 1_200, description: "Concrete responsibility, evidence expectations, and boundaries for this subagent." }),
  files: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 240 }), { maxItems: 40, description: "Optional authoritative mutable file scope when already known." })),
  expectedEffects: Type.Optional(Type.Array(StringEnum(ROUTE_EFFECTS), { minItems: 1, maxItems: 3, uniqueItems: true, description: "Effects this step is responsible for covering." })),
}, { additionalProperties: false });

const ROUTE_PLANNER_STAGE_SCHEMA = Type.Object({
  id: Type.String({ minLength: 1, maxLength: 80, description: "Stable stage id." }),
  tasks: Type.Array(ROUTE_PLANNER_STEP_SCHEMA, { minItems: 1, maxItems: 10, description: "Tasks that can run in this stage after prior stages complete." }),
}, { additionalProperties: false });

export const CHALIN_ROUTE_PLANNER_RESULT_SCHEMA = Type.Object({
  topology: StringEnum(ROUTE_TOPOLOGIES, { description: "sequential for dependent work, dag when stages contain truly independent tasks." }),
  steps: Type.Optional(Type.Array(ROUTE_PLANNER_STEP_SCHEMA, { minItems: 1, maxItems: 6, description: "Required only for sequential topology." })),
  stages: Type.Optional(Type.Array(ROUTE_PLANNER_STAGE_SCHEMA, { minItems: 1, maxItems: 8, description: "Required only for dag topology." })),
  risk: StringEnum(ROUTE_RISKS, { description: "Risk of the delegated workflow before runtime approval." }),
  needsMemory: Type.Boolean({ description: "Whether durable pi-chalin memory may improve the route." }),
  needsArtifacts: Type.Boolean({ description: "Whether route artifacts/checkpoints should be persisted." }),
  expectedEffects: Type.Array(StringEnum(ROUTE_EFFECTS), { minItems: 1, maxItems: 3, uniqueItems: true, description: "Effects this route must cover." }),
  workUnitStrategy: Type.Optional(StringEnum(ROUTE_WORK_UNIT_STRATEGIES, { description: "none, planned, or discover." })),
  fanoutAuthorized: Type.Optional(Type.Boolean({ description: "True only when the user authorized repeated independent mutation across discovered targets." })),
  requiresWorkspaceMutation: Type.Boolean({ description: "True when the route is expected to edit, write, or delete files." }),
  reason: Type.String({ minLength: 12, maxLength: 1_200, description: "Compact semantic reason for the chosen topology and agents." }),
}, { additionalProperties: false });

export async function planChalinRoute(
  input: ChalinRoutePlannerInput,
  context: ChalinRoutePlanningContext,
): Promise<ChalinRoutePlanningResult> {
  const normalizedInput = normalizeChalinRoutePlannerInput(input);
  const attempt = context.planner
    ? await context.planner(normalizedInput, context)
    : await runStructuredRoutePlanner(normalizedInput, context);

  if (!attempt.output) {
    return {
      route: routePlannerBlockedRoute(attempt.diagnostics.at(-1) ?? "Internal route planner did not return a valid structured plan."),
      source: "failed",
      diagnostics: attempt.diagnostics,
    };
  }

  const route = routeFromPlan(attempt.output.plan);
  if (!route.plan) {
    return {
      route: routePlannerBlockedRoute(route.reason),
      source: "failed",
      diagnostics: [...attempt.diagnostics, route.reason],
    };
  }

  return {
    route,
    source: "llm",
    diagnostics: attempt.diagnostics,
    requiresWorkspaceMutation: attempt.output.requiresWorkspaceMutation,
  };
}

export function normalizeChalinRoutePlannerInput(input: ChalinRoutePlannerInput): ChalinRoutePlannerInput {
  return {
    ...input,
    topology: normalizeTopologyInput(input.topology),
  };
}

function normalizeTopologyInput(topology: ChalinRouteTopologyInput | undefined): NormalizedChalinRouteTopologyInput | undefined {
  if (topology === "chain") return "sequential";
  if (topology === "parallel") return "dag";
  return topology;
}

export async function runStructuredRoutePlanner(
  input: ChalinRoutePlannerInput,
  context: ChalinRoutePlanningContext,
): Promise<ChalinRoutePlannerRunResult> {
  const model = context.model;
  const registry = context.modelRegistry;
  if (!model || !registry) {
    return { diagnostics: ["Internal route planner requires an active Pi model and model registry."] };
  }
  if (context.catalog.listExecutable().length === 0) {
    return { diagnostics: ["Internal route planner cannot run because no executable pi-chalin agents are available."] };
  }

  try {
    return await runAgentSessionRoutePlanner(input, context);
  } catch (error) {
    return { diagnostics: [`Internal route planner failed: ${errorMessage(error)}`] };
  }
}

export function parseChalinRoutePlannerMessage(message: AssistantMessage, catalog?: AgentCatalog): ChalinRoutePlannerOutput | undefined {
  const toolResult = parseChalinRoutePlannerToolResult(message, catalog);
  if (toolResult) return toolResult;
  const text = message.content
    .filter((block): block is { type: "text"; text: string } => block.type === "text")
    .map((block) => block.text)
    .join("\n")
    .trim();
  const parsed = parseJsonObject(text);
  return parsed ? validateChalinRoutePlannerOutput(parsed, catalog) : undefined;
}

export function validateChalinRoutePlannerOutput(parsed: Record<string, unknown>, catalog?: AgentCatalog): ChalinRoutePlannerOutput | undefined {
  if (Object.keys(parsed).some((key) => !ROUTE_PLANNER_RESULT_KEYS.has(key))) return undefined;
  const topology = isOneOf(parsed.topology, ROUTE_TOPOLOGIES) ? parsed.topology : undefined;
  if (!topology) return undefined;

  const expectedEffects = validateExpectedEffects(parsed.expectedEffects);
  if (!expectedEffects) return undefined;
  if (expectedEffects.includes("write") && (!expectedEffects.includes("read") || !expectedEffects.includes("verify"))) return undefined;

  const risk = isOneOf(parsed.risk, ROUTE_RISKS) ? parsed.risk : undefined;
  if (!risk) return undefined;
  if (typeof parsed.needsMemory !== "boolean") return undefined;
  if (typeof parsed.needsArtifacts !== "boolean") return undefined;
  if (typeof parsed.requiresWorkspaceMutation !== "boolean") return undefined;
  if (parsed.requiresWorkspaceMutation && !expectedEffects.includes("write")) return undefined;
  if (expectedEffects.includes("write") && parsed.requiresWorkspaceMutation !== true) return undefined;

  const workUnitStrategy = parsed.workUnitStrategy === undefined
    ? undefined
    : isOneOf(parsed.workUnitStrategy, ROUTE_WORK_UNIT_STRATEGIES)
      ? parsed.workUnitStrategy
      : undefined;
  if (parsed.workUnitStrategy !== undefined && !workUnitStrategy) return undefined;
  const fanoutAuthorized = parsed.fanoutAuthorized === undefined ? undefined : parsed.fanoutAuthorized;
  if (fanoutAuthorized !== undefined && typeof fanoutAuthorized !== "boolean") return undefined;
  const reason = compactString(parsed.reason, 1_200);
  if (!reason) return undefined;

  const agentRefs = catalog ? executableAgentRefs(catalog) : undefined;
  const common = {
    risk,
    needsMemory: parsed.needsMemory,
    needsArtifacts: parsed.needsArtifacts,
    expectedEffects,
    ...(workUnitStrategy ? { workUnitStrategy } : {}),
    ...(typeof fanoutAuthorized === "boolean" ? { fanoutAuthorized } : {}),
    reason,
  };

  let plan: StrictRoutePlanInput;
  if (topology === "sequential") {
    const steps = validatePlannerSteps(parsed.steps, agentRefs, 6);
    if (!steps) return undefined;
    if (parsed.stages !== undefined) return undefined;
    plan = { topology, steps, ...common };
  } else {
    const stages = validatePlannerStages(parsed.stages, agentRefs);
    if (!stages) return undefined;
    if (parsed.steps !== undefined) return undefined;
    plan = { topology, stages, ...common };
  }

  const route = routeFromPlan(plan);
  if (!route.plan) return undefined;
  return { plan, requiresWorkspaceMutation: parsed.requiresWorkspaceMutation };
}

async function runAgentSessionRoutePlanner(
  input: ChalinRoutePlannerInput,
  context: ChalinRoutePlanningContext,
): Promise<ChalinRoutePlannerRunResult> {
  const model = context.model;
  const registry = context.modelRegistry;
  if (!model || !registry) return { diagnostics: ["AgentSession route planner requires an active Pi model and model registry."] };

  let created: Awaited<ReturnType<typeof createAgentSession>> | undefined;
  try {
    const resourceLoader = new DefaultResourceLoader({
      cwd: context.cwd,
      agentDir: getAgentDir(),
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noContextFiles: true,
      systemPrompt: routePlannerSystemPrompt(),
    });
    await resourceLoader.reload();
    created = await createAgentSession({
      cwd: context.cwd,
      model,
      modelRegistry: registry,
      sessionManager: SessionManager.inMemory(context.cwd),
      resourceLoader,
      noTools: "all",
      tools: [ROUTE_PLANNER_TOOL_NAME],
      customTools: [createRoutePlannerTool(context.catalog)],
      sessionStartEvent: { type: "session_start", reason: "new" },
    });
    const abortPlanner = () => { void created?.session.abort(); };
    context.signal?.addEventListener("abort", abortPlanner, { once: true });
    try {
      await created.session.prompt(routePlannerSessionPrompt(input, context.catalog), {
        expandPromptTemplates: false,
        source: "extension",
      });
    } finally {
      context.signal?.removeEventListener("abort", abortPlanner);
    }
    const messages = Array.isArray(created.session.state.messages) ? created.session.state.messages as unknown[] : [];
    const output = parseChalinRoutePlannerSessionMessages(messages, context.catalog);
    return output
      ? { output, diagnostics: [`AgentSession route planner selected a structured ${output.plan.topology} route.`] }
      : { diagnostics: ["AgentSession route planner response failed structured validation.", routePlannerSessionSummary(messages)] };
  } catch (error) {
    return { diagnostics: [`AgentSession route planner failed: ${errorMessage(error)}`] };
  } finally {
    created?.session.dispose();
  }
}

function createRoutePlannerTool(catalog: AgentCatalog) {
  return defineTool({
    name: ROUTE_PLANNER_TOOL_NAME,
    label: "Chalin Route Plan",
    description: "Emit the final pi-chalin route plan as structured output.",
    promptSnippet: "Emit the final pi-chalin route plan.",
    promptGuidelines: [
      `Call ${ROUTE_PLANNER_TOOL_NAME} exactly once as the final action.`,
      "Do not answer in prose when this tool is available.",
    ],
    parameters: CHALIN_ROUTE_PLANNER_RESULT_SCHEMA,
    async execute(_toolCallId, params) {
      const output = validateChalinRoutePlannerOutput(params as Record<string, unknown>, catalog);
      return {
        content: [{ type: "text", text: output ? `Accepted route plan: ${output.plan.topology}` : "Rejected route plan: failed catalog or schema coherence validation." }],
        details: output ?? { rejected: true, params },
        terminate: true,
      };
    },
  });
}

function routePlannerSessionPrompt(input: ChalinRoutePlannerInput, catalog: AgentCatalog): string {
  return [
    routePlannerSystemPrompt(),
    "",
    "Payload JSON:",
    JSON.stringify(routePlannerPayload(input, catalog), null, 2),
  ].join("\n");
}

function parseChalinRoutePlannerSessionMessages(messages: unknown[], catalog: AgentCatalog): ChalinRoutePlannerOutput | undefined {
  for (const message of [...messages].reverse()) {
    if (!isRecord(message)) continue;
    const details = message.details;
    if (isRecord(details)) {
      const plan = validateSessionToolDetails(details);
      if (plan) return plan;
    }
    if (message.role !== "assistant" || !Array.isArray(message.content)) continue;
    for (const block of message.content) {
      if (!isRecord(block) || block.type !== "toolCall" || block.name !== ROUTE_PLANNER_TOOL_NAME || !isRecord(block.arguments)) continue;
      const output = validateChalinRoutePlannerOutput(block.arguments, catalog);
      if (output) return output;
    }
  }
  return undefined;
}

function validateSessionToolDetails(details: Record<string, unknown>): ChalinRoutePlannerOutput | undefined {
  if (!isRecord(details.plan)) return undefined;
  const requiresWorkspaceMutation = details.requiresWorkspaceMutation;
  if (typeof requiresWorkspaceMutation !== "boolean") return undefined;
  return { plan: details.plan as StrictRoutePlanInput, requiresWorkspaceMutation };
}

function routePlannerSessionSummary(messages: unknown[]): string {
  const assistant = [...messages].reverse().find((message) => isRecord(message) && message.role === "assistant") as Record<string, unknown> | undefined;
  if (!assistant || !Array.isArray(assistant.content)) return `Planner session trace: ${messages.length} messages, no assistant content.`;
  const parts = assistant.content
    .filter(isRecord)
    .map((block) => block.type === "toolCall"
      ? `${String(block.name)} ${truncate(JSON.stringify(block.arguments), 900)}`
      : typeof block.text === "string"
        ? truncate(block.text, 900)
        : String(block.type ?? "content"))
    .join(" | ");
  return `Planner session trace: ${messages.length} messages. Last assistant: ${truncate(parts, 1_200)}`;
}

function parseChalinRoutePlannerToolResult(message: AssistantMessage, catalog?: AgentCatalog): ChalinRoutePlannerOutput | undefined {
  for (const block of message.content) {
    if (block.type !== "toolCall" || block.name !== ROUTE_PLANNER_TOOL_NAME) continue;
    const result = validateChalinRoutePlannerOutput(block.arguments, catalog);
    if (result) return result;
  }
  return undefined;
}

function routePlannerPayload(input: ChalinRoutePlannerInput, catalog: AgentCatalog): Record<string, unknown> {
  return {
    delegatedTask: input.task,
    hints: {
      requestedTopology: input.topology ?? "auto",
      expectedEffects: input.expectedEffects,
      risk: input.risk,
      needsMemory: input.needsMemory,
      needsArtifacts: input.needsArtifacts,
      workUnitStrategy: input.workUnitStrategy,
      fanoutAuthorized: input.fanoutAuthorized,
      requiresWorkspaceMutation: input.requiresWorkspaceMutation,
      delegationReason: input.reason,
    },
    primarySuppliedRouteProposal: input.steps?.length || input.stages?.length
      ? { steps: input.steps, stages: input.stages }
      : undefined,
    availableAgents: catalog.listExecutable().map(agentRosterItem),
  };
}

function agentRosterItem(agent: AgentDefinition): Record<string, unknown> {
  return {
    ref: agent.name,
    scopedRef: `${agent.scope}/${agent.name}`,
    concern: agent.concern,
    capabilities: agent.capabilities,
    tools: agent.tools,
    description: truncate(agent.description, 260),
  };
}

function routePlannerSystemPrompt(): string {
  return [
    "You are pi-chalin's internal route planner for delegated coding-agent work.",
    "Choose the route semantically from the delegated task, available agents, expected effects, risk, ambiguity, evidence burden, decomposition value, and verification burden.",
    "Do not use keyword routing, task-type tables, or fixed mappings from phrases to agents. A PR, bugfix, review, research task, or refactor may need different routes depending on the actual task shape.",
    "Treat any Primary Pi supplied steps/stages as a proposal, not authority. Preserve them only when they are semantically justified.",
    "Select only agents from availableAgents. Prefer the smallest route that can gather evidence, execute required effects, and verify the outcome.",
    "First decompose the task into responsibilities: reconnaissance, focused review or validation, external research, planning or option comparison, workspace mutation, fan-in synthesis, and final quality gate. Then choose topology and agents for those responsibilities.",
    "Use sequential when steps depend on earlier evidence, planning, implementation, or synthesized handoffs. Use dag when independent responsibilities or coverage slices can safely run in parallel after their shared prerequisites are known.",
    "For broad read-only analysis, prefer a coverage-map recon step when the surface is not already known, then parallel focused review/research slices for independent surfaces, then fan-in synthesis when multiple handoffs must be reconciled, and a final review gate when claims or coverage need independent validation.",
    "Nested delegation is a runtime parent-agent decision, not a route-plan topology feature. Use it when a parent must inspect evidence first, discover the true slices, or coordinate same-role child work under one verdict or plan.",
    "Do not flatten explicit or semantic parent/child delegation into top-level sibling steps. If a coordinating parent should decide child slices after scout/planner/worker/reviewer evidence, create the parent step at top level and put the child-slice responsibility inside that parent step task for `chalin_delegate`.",
    "Flatten independent slices into top-level DAG tasks only when no parent coordination, same-role verdict, or runtime slice discovery is needed and each slice can produce a complete handoff directly to the route fan-in.",
    "Agnostic nested-delegation examples: a reviewer parent splits a broad audit into focused review slices; a worker parent splits implementation across independent ownership boundaries after reading the scoped code; a planner parent splits competing migration/architecture plans before consolidating one plan. In each case, top-level route owns the parent plus later fan-in/final gate, not every child slice.",
    "Do not use a planning agent as a generic auditor. Use planning for strategy, option comparison, ordered implementation plans, risks, rollback, or validation strategy; use review-capable agents for evidence-backed critique, coverage gaps, and correctness risks.",
    "When two or more independent handoffs must become one final answer or downstream contract, include an explicit context-building or synthesis responsibility unless a later agent's task clearly owns that fan-in.",
    "If writes are expected, expectedEffects must include read, write, and verify, and requiresWorkspaceMutation must be true.",
    "If writes are not expected, do not add mutation agents merely to look thorough; read-only routes still need evidence coverage, synthesis, and validation when the scope is broad.",
    "Select agents by their declared concerns, capabilities, tools, and descriptions; do not assign or exclude an agent merely because its name appears to match a task type.",
    "Independent validation, mutation, fresh external evidence, and evidence packaging are responsibilities to cover through the roster, not fixed agent-name recipes.",
    "Set each step's expectedEffects when its responsibility is known; the harness will use those effects as the contract instead of inferring responsibility from agent names.",
    "Step tasks must be concrete, bounded, and mention the evidence, mutation, or verification responsibility of that agent.",
    "Do not collapse separable responsibilities into one opaque write step solely because they share a workspace or mutable files. Shared mutable surfaces require explicit ordering, dependency, merge ownership, or a coordinating parent step.",
    `When the ${ROUTE_PLANNER_TOOL_NAME} tool is available, call it exactly once with the final route. Otherwise return JSON only with the same fields.`,
  ].join("\n");
}

function validatePlannerSteps(values: unknown, agentRefs: Set<string> | undefined, maxItems: number): PlannerStepInput[] | undefined {
  if (!Array.isArray(values) || values.length < 1 || values.length > maxItems) return undefined;
  const steps: PlannerStepInput[] = [];
  for (const value of values) {
    const step = validatePlannerStep(value, agentRefs);
    if (!step) return undefined;
    steps.push(step);
  }
  return steps;
}

function validatePlannerStages(values: unknown, agentRefs: Set<string> | undefined): PlannerStageInput[] | undefined {
  if (!Array.isArray(values) || values.length < 1 || values.length > 8) return undefined;
  const stages: PlannerStageInput[] = [];
  const seen = new Set<string>();
  for (const [index, value] of values.entries()) {
    if (!isRecord(value)) return undefined;
    if (Object.keys(value).some((key) => !ROUTE_PLANNER_STAGE_KEYS.has(key))) return undefined;
    const id = compactString(value.id, 80) ?? `stage-${index + 1}`;
    if (seen.has(id)) return undefined;
    seen.add(id);
    const tasks = validatePlannerSteps(value.tasks, agentRefs, 10);
    if (!tasks) return undefined;
    stages.push({ id, tasks });
  }
  return stages;
}

function validatePlannerStep(value: unknown, agentRefs: Set<string> | undefined): PlannerStepInput | undefined {
  if (!isRecord(value)) return undefined;
  if (Object.keys(value).some((key) => !ROUTE_PLANNER_STEP_KEYS.has(key))) return undefined;
  const id = value.id === undefined ? undefined : compactString(value.id, 80);
  if (value.id !== undefined && !id) return undefined;
  const agent = compactString(value.agent, 120);
  if (!agent) return undefined;
  if (agentRefs && !agentRefs.has(agent)) return undefined;
  const task = compactString(value.task, 1_200);
  if (!task) return undefined;
  const files = value.files === undefined ? undefined : validateFiles(value.files);
  if (value.files !== undefined && !files) return undefined;
  const expectedEffects = value.expectedEffects === undefined ? undefined : validateExpectedEffects(value.expectedEffects);
  if (value.expectedEffects !== undefined && !expectedEffects) return undefined;
  return {
    ...(id ? { id } : {}),
    agent,
    task,
    ...(files ? { files } : {}),
    ...(expectedEffects ? { expectedEffects } : {}),
  };
}

function validateFiles(values: unknown): string[] | undefined {
  if (!Array.isArray(values) || values.length > 40) return undefined;
  const files: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const file = compactString(value, 240)?.replaceAll("\\", "/");
    if (!file || seen.has(file)) return undefined;
    seen.add(file);
    files.push(file);
  }
  return files;
}

function validateExpectedEffects(values: unknown): RouteExpectedEffect[] | undefined {
  if (!Array.isArray(values) || values.length < 1 || values.length > 3) return undefined;
  const normalized: RouteExpectedEffect[] = [];
  const seen = new Set<RouteExpectedEffect>();
  for (const value of values) {
    if (!isOneOf(value, ROUTE_EFFECTS) || seen.has(value)) return undefined;
    seen.add(value);
    normalized.push(value);
  }
  return normalized;
}

function executableAgentRefs(catalog: AgentCatalog): Set<string> {
  const refs = new Set<string>();
  for (const agent of catalog.listExecutable()) {
    refs.add(agent.name);
    refs.add(`${agent.scope}/${agent.name}`);
  }
  return refs;
}

function routePlannerBlockedRoute(reason: string): RouteDecision {
  return {
    kind: "ask-user",
    agents: [],
    risk: "low",
    ambiguity: "high",
    needsMemory: false,
    needsArtifacts: false,
    expectedEffects: ["read"],
    reason: `pi-chalin route planning blocked: ${reason}`,
  };
}

function truncate(value: string, maxLength: number): string {
  const normalized = value.trim().replace(/\s+/g, " ");
  return normalized.length <= maxLength ? normalized : `${normalized.slice(0, maxLength - 3)}...`;
}

function isOneOf<const TValue extends string>(value: unknown, values: readonly TValue[]): value is TValue {
  return typeof value === "string" && values.includes(value as TValue);
}
