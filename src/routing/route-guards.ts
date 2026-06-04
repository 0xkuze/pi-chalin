import type { AgentDefinition, AgentStep, RouteDecision } from "../domain/schemas.ts";

interface RouteNormalizationOptions {
  requiresWorkspaceMutation: boolean;
  agents?: ReadonlyMap<string, AgentDefinition>;
}

export function normalizeRouteForExecution(route: RouteDecision, options: RouteNormalizationOptions): RouteDecision {
  const covered = validateRouteEffectCoverage(route, options.requiresWorkspaceMutation, options.agents);
  return serializeUnsafeParallelPlannedWriters(covered, options.requiresWorkspaceMutation, options.agents);
}

export function routeRequiresWorkspaceMutation(route: RouteDecision): boolean {
  if (route.kind === "ask-user") return false;
  return route.expectedEffects?.includes("write") === true;
}

function validateRouteEffectCoverage(route: RouteDecision, requiresWorkspaceMutation: boolean, agents?: ReadonlyMap<string, AgentDefinition>): RouteDecision {
  if (route.kind === "ask-user" || !route.plan) return route;
  const expectedEffects = route.expectedEffects ?? [];
  const writeExpected = requiresWorkspaceMutation || expectedEffects.includes("write");
  if (!writeExpected) return route;
  if (!expectedEffects.includes("write")) {
    return askUserRoute(`${route.reason} Invalid route plan: workspace mutation is expected but expectedEffects does not include write. Ask the route planner for a repaired structured plan.`);
  }
  if (!expectedEffects.includes("verify")) {
    return askUserRoute(`${route.reason} Invalid route plan: workspace mutation is expected but expectedEffects does not include verify. Ask the route planner for a repaired structured plan.`);
  }
  if (route.workUnitStrategy === "discover") return route;
  if (!routeHasImplementationWriter(route, agents)) {
    return askUserRoute(`${route.reason} Invalid route plan: missing write-capable agent for expected workspace mutation. Ask the route planner for a repaired structured plan instead of adding agents in the harness.`);
  }
  if (agents && !routeHasIndependentReviewer(route, agents)) {
    return askUserRoute(`${route.reason} Invalid route plan: missing independent reviewer for expected workspace mutation. Ask the route planner for a repaired structured plan instead of adding agents in the harness.`);
  }
  if (!routeHasVerificationCapability(route, agents)) {
    return askUserRoute(`${route.reason} Invalid route plan: expected verification but no validation-capable agent was selected. Ask the route planner for a repaired structured plan instead of adding agents in the harness.`);
  }
  return route;
}

function askUserRoute(reason: string): RouteDecision {
  return { kind: "ask-user", agents: [], risk: "low", ambiguity: "high", needsMemory: false, needsArtifacts: false, expectedEffects: ["read"], reason };
}

function serializeUnsafeParallelPlannedWriters(route: RouteDecision, requiresWorkspaceMutation: boolean, agents?: ReadonlyMap<string, AgentDefinition>): RouteDecision {
  if (!requiresWorkspaceMutation && !route.expectedEffects?.includes("write")) return route;
  if (route.kind !== "multi-agent-dag" || route.plan?.kind !== "dag") return route;

  let changed = false;
  const stages: Array<{ id: string; tasks: AgentStep[] }> = [];
  for (const stage of route.plan.stages) {
    if (!stageHasUnsafeParallelWriters(stage.tasks, agents)) {
      stages.push(stage);
      continue;
    }
    changed = true;
    const readOnlyTasks = stage.tasks.filter((step) => !isPlannedWriterStep(step, agents));
    const writerTasks = stage.tasks.filter((step) => isPlannedWriterStep(step, agents));
    if (readOnlyTasks.length) stages.push({ id: `${stage.id}-read`, tasks: readOnlyTasks });
    for (const [index, step] of writerTasks.entries()) {
      stages.push({ id: `${stage.id}-writer-${index + 1}`, tasks: [step] });
    }
  }
  if (!changed) return route;
  return {
    ...route,
    agents: stages.flatMap((stage) => stage.tasks.map((step) => step.agent)),
    reason: `${route.reason} Parallel writer stages normalized by pi-chalin: write-capable tasks without explicit disjoint file ownership are ordered to avoid shared mutable-surface conflicts.`,
    plan: { kind: "dag", stages },
  };
}

function stageHasUnsafeParallelWriters(tasks: AgentStep[], agents?: ReadonlyMap<string, AgentDefinition>): boolean {
  const writers = tasks.filter((step) => isPlannedWriterStep(step, agents));
  if (writers.length <= 1) return false;
  if (writers.some((step) => normalizedStepFiles(step).length === 0)) return true;
  for (let leftIndex = 0; leftIndex < writers.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < writers.length; rightIndex += 1) {
      if (fileScopesOverlap(normalizedStepFiles(writers[leftIndex]!), normalizedStepFiles(writers[rightIndex]!))) return true;
    }
  }
  return false;
}

function isPlannedWriterStep(step: AgentStep, agents?: ReadonlyMap<string, AgentDefinition>): boolean {
  const agent = agents?.get(step.agent);
  if (agent) return agentCanMutateWorkspace(agent);
  if (agents) return normalizedStepFiles(step).length > 0;
  return true;
}

function routeHasImplementationWriter(route: RouteDecision, agents?: ReadonlyMap<string, AgentDefinition>): boolean {
  if (route.plan?.kind === "dag") return route.plan.stages.some((stage) => stage.tasks.some((step) => isImplementationWriterStep(step, agents)));
  if (route.plan?.kind === "sequential") return route.plan.steps.some((step) => isImplementationWriterStep(step, agents));
  if (agents) return route.agents.some((ref) => {
    const agent = agents.get(ref);
    return agent ? agentCanMutateWorkspace(agent) : false;
  });
  return false;
}

function routeHasVerificationCapability(route: RouteDecision, agents?: ReadonlyMap<string, AgentDefinition>): boolean {
  if (route.plan?.kind === "dag") return route.plan.stages.some((stage) => stage.tasks.some((step) => isVerificationStep(step, agents)));
  if (route.plan?.kind === "sequential") return route.plan.steps.some((step) => isVerificationStep(step, agents));
  if (agents) return route.agents.some((ref) => {
    const agent = agents.get(ref);
    return agent ? agentCanVerify(agent) : false;
  });
  return false;
}

function routeHasIndependentReviewer(route: RouteDecision, agents: ReadonlyMap<string, AgentDefinition>): boolean {
  if (route.plan?.kind === "dag") return route.plan.stages.some((stage) => stage.tasks.some((step) => isReviewStep(step, agents)));
  if (route.plan?.kind === "sequential") return route.plan.steps.some((step) => isReviewStep(step, agents));
  return route.agents.some((ref) => agents.get(ref)?.concern === "review");
}

function isImplementationWriterStep(step: AgentStep, agents?: ReadonlyMap<string, AgentDefinition>): boolean {
  const agent = agents?.get(step.agent);
  if (agent) return agentCanMutateWorkspace(agent);
  if (agents) return normalizedStepFiles(step).length > 0;
  return normalizedStepFiles(step).length > 0;
}

function isVerificationStep(step: AgentStep, agents?: ReadonlyMap<string, AgentDefinition>): boolean {
  const agent = agents?.get(step.agent);
  if (agent) return agentCanVerify(agent);
  if (agents) return false;
  return false;
}

function isReviewStep(step: AgentStep, agents: ReadonlyMap<string, AgentDefinition>): boolean {
  return agents.get(step.agent)?.concern === "review";
}

function agentCanMutateWorkspace(agent: AgentDefinition): boolean {
  return agent.concern === "implementation"
    || agent.concern === "conflict-resolution"
    || agent.capabilities.includes("edit-files")
    || agent.capabilities.includes("write-new-files");
}

function agentCanVerify(agent: AgentDefinition): boolean {
  return agent.concern === "review"
    || agent.concern === "implementation"
    || agent.concern === "conflict-resolution"
    || agent.capabilities.includes("validate")
    || agent.capabilities.includes("run-safe-bash");
}

function normalizedStepFiles(step: AgentStep): string[] {
  const seen = new Set<string>();
  const files: string[] = [];
  for (const file of step.files ?? []) {
    const normalized = normalizeFileScope(file);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    files.push(normalized);
  }
  return files;
}

function normalizeFileScope(file: string): string {
  let normalized = file.trim().replaceAll("\\", "/").replace(/\/+$/, "");
  while (normalized.startsWith("./")) normalized = normalized.slice(2);
  return normalized;
}

function fileScopesOverlap(left: string[], right: string[]): boolean {
  for (const leftFile of left) {
    for (const rightFile of right) {
      if (leftFile === rightFile) return true;
      if (rightFile.startsWith(`${leftFile}/`) || leftFile.startsWith(`${rightFile}/`)) return true;
    }
  }
  return false;
}
