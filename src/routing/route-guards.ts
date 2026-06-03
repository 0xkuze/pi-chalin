import { Effect } from "effect";
import type { AgentDefinition, AgentStep, RouteDecision, RouteExpectedEffect } from "../domain/schemas.ts";
import { routeNeedsWorkUnitDiscovery } from "../runner/intent-contract.ts";

interface RouteNormalizationOptions {
  requiresWorkspaceMutation: boolean;
  task: string;
  agents?: ReadonlyMap<string, AgentDefinition>;
}

export function normalizeRouteForExecution(route: RouteDecision, options: RouteNormalizationOptions): RouteDecision {
  return Effect.runSync(normalizeRouteForExecutionEffect(route, options));
}

export function normalizeRouteForExecutionEffect(route: RouteDecision, options: RouteNormalizationOptions): Effect.Effect<RouteDecision> {
  return Effect.succeed(route).pipe(
    Effect.map((current) => stripPrematureDiscoverWorkUnitExecution(current)),
    Effect.map((current) => ensureMutationRouteHasWorkerAndReviewer(current, options.requiresWorkspaceMutation, options.task, options.agents)),
    Effect.map((current) => serializeUnsafeParallelPlannedWriters(current, options.requiresWorkspaceMutation, options.agents)),
    Effect.map((current) => collapseReadOnlyScoutContextRoute(current, options.requiresWorkspaceMutation)),
    Effect.withSpan("route-guards.normalizeRouteForExecution"),
  );
}

export function ensureMutationRouteHasWorker(route: RouteDecision, requiresWorkspaceMutation: boolean, task: string): RouteDecision {
  return ensureMutationRouteHasWorkerAndReviewer(route, requiresWorkspaceMutation, task);
}

export function inferRouteRequiresWorkspaceMutation(route: RouteDecision, _task: string): boolean {
  if (route.kind === "ask-user") return false;
  if (route.expectedEffects?.includes("write")) return true;
  if (route.expectedEffects && !route.expectedEffects.includes("write")) return false;
  if (route.agents.includes("worker")) return true;
  return false;
}

function stripPrematureDiscoverWorkUnitExecution(route: RouteDecision): RouteDecision {
  if (route.workUnitStrategy !== "discover" || !route.plan) return route;
  if (route.plan.kind === "dag") {
    const stages = route.plan.stages
      .map((stage) => ({ ...stage, tasks: stage.tasks.filter((step) => step.agent !== "worker" && step.agent !== "reviewer") }))
      .filter((stage) => stage.tasks.length > 0);
    const agents = stages.flatMap((stage) => stage.tasks.map((step) => step.agent));
    return {
      ...route,
      agents,
      plan: { kind: "dag", stages },
      reason: `${route.reason} Discover WorkUnit route normalized by pi-chalin: execution/review steps will be materialized after structured unit discovery.`,
    };
  }
  const steps = route.plan.steps.filter((step) => step.agent !== "worker" && step.agent !== "reviewer");
  return {
    ...route,
    agents: steps.map((step) => step.agent),
    plan: { kind: "sequential", steps },
    reason: `${route.reason} Discover WorkUnit route normalized by pi-chalin: execution/review steps will be materialized after structured unit discovery.`,
  };
}

export function ensureMutationRouteHasWorkerAndReviewer(route: RouteDecision, requiresWorkspaceMutation: boolean, task: string, agents?: ReadonlyMap<string, AgentDefinition>): RouteDecision {
  if (reviewerDisabled()) return ensureMutationRouteHasWorkerOnly(route, requiresWorkspaceMutation, task, agents);
  const hasImplementationWorker = routeHasImplementationWriter(route, agents);
  if ((!requiresWorkspaceMutation && !hasImplementationWorker) || route.kind === "ask-user") return route;
  if (!route.plan) return route;
  if (!hasImplementationWorker && routeNeedsWorkUnitDiscovery(route)) return ensureFanoutDiscoveryRoute(route, task);

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
  const reviewerStep: AgentStep = {
    id: "implementation-review",
    agent: "reviewer",
    task: [
      "Review the implementation against the original user request, the initial plan, repository standards, and the worker's verification evidence.",
      "Call out any missing acceptance criteria, skipped scope, code-quality gaps, insufficient tests, or unrelated changes before final synthesis.",
      `Original task: ${task}`,
    ].join(" "),
    budget: "normal",
  };

  if (route.plan.kind === "dag") {
    const result = ensureDagHasImplementationReview(route.plan.stages, workerStep, reviewerStep, agents);
    const withReview = result.changed ? {
      ...route,
      agents: result.stages.flatMap((stage) => stage.tasks.map((step) => step.agent)),
      needsArtifacts: true,
      expectedEffects: addExpectedEffects(route.expectedEffects, ["write", "verify"]),
      reason: implementationReviewReason(route.reason, result.addedWorker, result.addedReviewer),
      plan: {
        kind: "dag",
        stages: result.stages,
      },
    } satisfies RouteDecision : route;
    return withReview;
  }

  const existingSteps = route.plan.steps;
  const result = ensureStepsHaveImplementationReview(existingSteps, workerStep, reviewerStep, agents);
  const withReview = result.changed ? {
    ...route,
    kind: "multi-agent-sequential",
    agents: result.steps.map((step) => step.agent),
    needsArtifacts: true,
    expectedEffects: addExpectedEffects(route.expectedEffects, ["write", "verify"]),
    reason: implementationReviewReason(route.reason, result.addedWorker, result.addedReviewer),
    plan: { kind: "sequential", steps: result.steps },
  } satisfies RouteDecision : route;
  return withReview;
}

function ensureFanoutDiscoveryRoute(route: RouteDecision, task: string): RouteDecision {
  if (!route.plan) return route;
  const discoveryStep: AgentStep = {
    id: "fanout-discovery",
    agent: "scout",
    task: [
      "Discover the concrete decomposition targets required before implementation.",
      "Return a structured handoff with bounded work units, acceptance criteria, and dependencies so pi-chalin can launch worker and reviewer coverage without overlapping mutable ownership.",
      `Original task: ${task}`,
    ].join(" "),
    budget: "normal",
  };
  const hasDiscovery = route.plan.kind === "dag"
    ? route.plan.stages.some((stage) => stage.tasks.some((step) => isFanoutDiscoveryAgent(step.agent)))
    : route.plan.steps.some((step) => isFanoutDiscoveryAgent(step.agent));
  const plan = route.plan.kind === "dag"
    ? {
      kind: "dag" as const,
      stages: hasDiscovery ? route.plan.stages : [{ id: "fanout-discovery", tasks: [discoveryStep] }, ...route.plan.stages],
    }
    : {
      kind: "sequential" as const,
      steps: hasDiscovery ? route.plan.steps : [discoveryStep, ...route.plan.steps],
    };
  return {
    ...route,
    kind: plan.kind === "dag" ? "multi-agent-dag" : "multi-agent-sequential",
    agents: plan.kind === "dag" ? plan.stages.flatMap((stage) => stage.tasks.map((step) => step.agent)) : plan.steps.map((step) => step.agent),
    needsArtifacts: true,
    expectedEffects: addExpectedEffects(route.expectedEffects, ["write", "verify"]),
    reason: `${route.reason} Fanout/decomposition intent preserved by pi-chalin: discovery will materialize bounded worker and reviewer coverage instead of adding one oversized implementation worker.`,
    plan,
  };
}

function isFanoutDiscoveryAgent(agent: string): boolean {
  return agent === "scout" || agent === "planner" || agent === "context-builder";
}

function ensureMutationRouteHasWorkerOnly(route: RouteDecision, requiresWorkspaceMutation: boolean, task: string, agents?: ReadonlyMap<string, AgentDefinition>): RouteDecision {
  const hasImplementationWorker = routeHasImplementationWriter(route, agents);
  if ((!requiresWorkspaceMutation && !hasImplementationWorker) || route.kind === "ask-user") return stripReviewerSteps(route);
  if (!route.plan) return stripReviewerSteps(route);

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

  if (route.plan.kind === "dag") {
    const stages = stripReviewerStages(route.plan.stages);
    const withWorker = stages.some((stage) => stage.tasks.some((step) => isImplementationWriterStep(step, agents)))
      ? stages
      : [...stages, { id: "implementation", tasks: [workerStep] }];
    return {
      ...route,
      agents: withWorker.flatMap((stage) => stage.tasks.map((step) => step.agent)),
      needsArtifacts: true,
      expectedEffects: addExpectedEffects(route.expectedEffects, ["write"]),
      reason: `${route.reason} Mutation task normalized by pi-chalin harness ablation: reviewer disabled; worker execution preserved.`,
      plan: { kind: "dag", stages: withWorker },
    };
  }

  const existingSteps = route.plan.steps;
  const stripped = existingSteps.filter((step) => step.agent !== "reviewer");
  const steps = stripped.some((step) => isImplementationWriterStep(step, agents)) ? stripped : [...stripped, workerStep];
  return {
    ...route,
    kind: "multi-agent-sequential",
    agents: steps.map((step) => step.agent),
    needsArtifacts: true,
    expectedEffects: addExpectedEffects(route.expectedEffects, ["write"]),
    reason: `${route.reason} Mutation task normalized by pi-chalin harness ablation: reviewer disabled; worker execution preserved.`,
    plan: { kind: "sequential", steps },
  };
}

function stripReviewerSteps(route: RouteDecision): RouteDecision {
  if (!route.plan || !route.agents.includes("reviewer")) return route;
  if (route.plan.kind === "dag") {
    const originalPlan = route.plan;
    const stages = stripReviewerStages(route.plan.stages);
    const unchanged = stages.length === originalPlan.stages.length
      && stages.every((stage, index) => stage.tasks.length === (originalPlan.stages[index]?.tasks.length ?? -1));
    if (unchanged) return route;
    if (stages.length === 0) return askUserRoute(`${route.reason} Reviewer-only route removed for pi-chalin no-reviewer harness ablation; no executable non-reviewer step remains.`);
    return {
      ...route,
      agents: stages.flatMap((stage) => stage.tasks.map((step) => step.agent)),
      reason: `${route.reason} Reviewer steps removed for pi-chalin no-reviewer harness ablation.`,
      plan: { kind: "dag", stages },
    };
  }
  const steps = route.plan.steps;
  const stripped = steps.filter((step) => step.agent !== "reviewer");
  if (stripped.length === steps.length) return route;
  if (stripped.length === 0) return askUserRoute(`${route.reason} Reviewer-only route removed for pi-chalin no-reviewer harness ablation; no executable non-reviewer step remains.`);
  return {
    ...route,
    kind: "multi-agent-sequential",
    agents: stripped.map((step) => step.agent),
    reason: `${route.reason} Reviewer steps removed for pi-chalin no-reviewer harness ablation.`,
    plan: { kind: "sequential", steps: stripped },
  };
}

function askUserRoute(reason: string): RouteDecision {
  return { kind: "ask-user", agents: [], risk: "low", ambiguity: "high", needsMemory: false, needsArtifacts: false, expectedEffects: ["read"], reason };
}

function stripReviewerStages(stages: Array<{ id: string; tasks: AgentStep[] }>): Array<{ id: string; tasks: AgentStep[] }> {
  return stages
    .map((stage) => ({ ...stage, tasks: stage.tasks.filter((step) => step.agent !== "reviewer") }))
    .filter((stage) => stage.tasks.length > 0);
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
  return route.agents.includes("worker");
}

function isImplementationWriterStep(step: AgentStep, agents?: ReadonlyMap<string, AgentDefinition>): boolean {
  const agent = agents?.get(step.agent);
  if (agent) return agentCanMutateWorkspace(agent);
  if (agents) return normalizedStepFiles(step).length > 0;
  return step.agent === "worker";
}

function isReviewerPlanStep(step: AgentStep, agents?: ReadonlyMap<string, AgentDefinition>): boolean {
  const agent = agents?.get(step.agent);
  if (agent) return agent.concern === "review";
  return step.agent === "reviewer";
}

function agentCanMutateWorkspace(agent: AgentDefinition): boolean {
  return agent.concern === "implementation"
    || agent.concern === "conflict-resolution"
    || agent.capabilities.includes("edit-files")
    || agent.capabilities.includes("write-new-files");
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

export function collapseReadOnlyScoutContextRoute(route: RouteDecision, requiresWorkspaceMutation: boolean): RouteDecision {
  if (requiresWorkspaceMutation || route.needsMemory || route.risk !== "low") return route;
  if (route.kind !== "multi-agent-sequential" || route.plan?.kind !== "sequential") return route;
  if (route.plan.steps.length !== 2) return route;

  const [scout, contextBuilder] = route.plan.steps;
  if (scout?.agent !== "scout" || contextBuilder?.agent !== "context-builder") return route;

  return {
    ...route,
    kind: "multi-agent-sequential",
    agents: ["scout"],
    needsArtifacts: false,
    expectedEffects: readOnlyEffects(route.expectedEffects),
    reason: `${route.reason} Read-only scout/context-builder route normalized by pi-chalin: the primary Pi agent can synthesize the user-facing answer from the scout handoff without a second child synthesis step.`,
    plan: {
      kind: "sequential",
      steps: [{ ...scout }],
    },
  };
}

function reviewerDisabled(): boolean {
  return process.env.PI_CHALIN_DISABLE_REVIEWER === "1";
}

function ensureStepsHaveImplementationReview(existingSteps: AgentStep[], workerStep: AgentStep, reviewerStep: AgentStep, agents?: ReadonlyMap<string, AgentDefinition>): { steps: AgentStep[]; changed: boolean; addedWorker: boolean; addedReviewer: boolean } {
  let steps = [...existingSteps];
  let addedWorker = false;
  let addedReviewer = false;

  if (!steps.some((step) => isImplementationWriterStep(step, agents))) {
    const firstReviewerIndex = steps.findIndex((step) => isReviewerPlanStep(step, agents));
    const insertAt = firstReviewerIndex >= 0 ? firstReviewerIndex : steps.length;
    steps = [...steps.slice(0, insertAt), workerStep, ...steps.slice(insertAt)];
    addedWorker = true;
  }

  const lastWorkerIndex = findLastIndex(steps, (step) => isImplementationWriterStep(step, agents));
  const hasPostWorkerReviewer = lastWorkerIndex >= 0 && steps.some((step, index) => index > lastWorkerIndex && isReviewerPlanStep(step, agents));
  if (!hasPostWorkerReviewer) {
    steps = [...steps, reviewerStep];
    addedReviewer = true;
  }

  return { steps, changed: addedWorker || addedReviewer, addedWorker, addedReviewer };
}

function ensureDagHasImplementationReview(stages: Array<{ id: string; tasks: AgentStep[] }>, workerStep: AgentStep, reviewerStep: AgentStep, agents?: ReadonlyMap<string, AgentDefinition>): { stages: Array<{ id: string; tasks: AgentStep[] }>; changed: boolean; addedWorker: boolean; addedReviewer: boolean } {
  let nextStages = stages.map((stage) => ({ ...stage, tasks: [...stage.tasks] }));
  let addedWorker = false;
  let addedReviewer = false;

  if (!nextStages.some((stage) => stage.tasks.some((step) => isImplementationWriterStep(step, agents)))) {
    const firstReviewerStageIndex = nextStages.findIndex((stage) => stage.tasks.some((step) => isReviewerPlanStep(step, agents)));
    const insertAt = firstReviewerStageIndex >= 0 ? firstReviewerStageIndex : nextStages.length;
    nextStages = [
      ...nextStages.slice(0, insertAt),
      { id: "implementation", tasks: [workerStep] },
      ...nextStages.slice(insertAt),
    ];
    addedWorker = true;
  }

  const lastWorkerStageIndex = findLastIndex(nextStages, (stage) => stage.tasks.some((step) => isImplementationWriterStep(step, agents)));
  const hasPostWorkerReviewer = lastWorkerStageIndex >= 0 && nextStages.some((stage, index) => index > lastWorkerStageIndex && stage.tasks.some((step) => isReviewerPlanStep(step, agents)));
  if (!hasPostWorkerReviewer) {
    nextStages = [...nextStages, { id: "implementation-review", tasks: [reviewerStep] }];
    addedReviewer = true;
  }

  return { stages: nextStages, changed: addedWorker || addedReviewer, addedWorker, addedReviewer };
}

function implementationReviewReason(reason: string, addedWorker: boolean, addedReviewer: boolean): string {
  const additions = [
    addedWorker ? "added a worker step because implementation routes must include an executor." : undefined,
    addedReviewer ? "added a reviewer step because implementation routes must be checked against the plan, standards, gaps, and verification evidence." : undefined,
  ].filter(Boolean);
  return `${reason} Mutation task normalized by pi-chalin: ${additions.join(" ")}`;
}

function addExpectedEffects(current: RouteExpectedEffect[] | undefined, additions: RouteExpectedEffect[]): RouteExpectedEffect[] {
  return [...new Set<RouteExpectedEffect>([...(current ?? ["read"]), ...additions])];
}

function readOnlyEffects(current: RouteExpectedEffect[] | undefined): RouteExpectedEffect[] {
  const safe = (current ?? ["read"]).filter((effect) => effect !== "write" && effect !== "verify");
  return safe.length ? safe : ["read"];
}

function findLastIndex<T>(items: T[], predicate: (item: T, index: number) => boolean): number {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    if (predicate(items[index]!, index)) return index;
  }
  return -1;
}
