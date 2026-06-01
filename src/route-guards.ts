import { Effect } from "effect";
import type { AgentStep, RouteDecision } from "./schemas.ts";

interface RouteNormalizationOptions {
  requiresWorkspaceMutation: boolean;
  task: string;
}

export function normalizeRouteForExecution(route: RouteDecision, options: RouteNormalizationOptions): RouteDecision {
  return Effect.runSync(normalizeRouteForExecutionEffect(route, options));
}

export function normalizeRouteForExecutionEffect(route: RouteDecision, options: RouteNormalizationOptions): Effect.Effect<RouteDecision> {
  return Effect.succeed(route).pipe(
    Effect.map((current) => ensureMutationRouteHasWorkerAndReviewer(current, options.requiresWorkspaceMutation, options.task)),
    Effect.map((current) => collapseReadOnlyScoutContextRoute(current, options.requiresWorkspaceMutation)),
    Effect.withSpan("route-guards.normalizeRouteForExecution"),
  );
}

export function ensureMutationRouteHasWorker(route: RouteDecision, requiresWorkspaceMutation: boolean, task: string): RouteDecision {
  return ensureMutationRouteHasWorkerAndReviewer(route, requiresWorkspaceMutation, task);
}

export function inferRouteRequiresWorkspaceMutation(route: RouteDecision, task: string): boolean {
  if (route.kind === "memory-only" || route.kind === "ask-user") return false;
  if (route.agents.includes("worker")) return true;
  const text = `${task}\n${route.reason}\n${routeStepTasks(route).join("\n")}`.toLowerCase();
  if (/\b(read[- ]?only|no[- ]?code|sin modificar|no modificar|do not modify|analysis only|solo analizar|s[oó]lo analizar)\b/.test(text)) return false;
  return /\b(fix|bugfix|implement|refactor|change|update|add|write|create|patch|repair|corrige|arregla|implementa|refactoriza|cambia|modifica|actualiza|agrega|añade|escribe|crea|parchea|repara)\b|\b(?:make|cargo|go|bun|npm|pnpm|yarn|pytest|python|node)\s+test\b|\btests?\s+must\s+pass\b|\bdebe(?:n)?\s+pasar\b/.test(text);
}

function routeStepTasks(route: RouteDecision): string[] {
  if (!route.plan) return [];
  if (route.plan.kind === "single") return [route.plan.task];
  if (route.plan.kind === "parallel") return route.plan.tasks.map((step) => step.task);
  if (route.plan.kind === "chain") return route.plan.steps.map((step) => step.task);
  return route.plan.stages.flatMap((stage) => stage.tasks.map((step) => step.task));
}

export function ensureMutationRouteHasWorkerAndReviewer(route: RouteDecision, requiresWorkspaceMutation: boolean, task: string): RouteDecision {
  if (reviewerDisabled()) return ensureMutationRouteHasWorkerOnly(route, requiresWorkspaceMutation, task);
  const hasImplementationWorker = route.agents.includes("worker");
  if ((!requiresWorkspaceMutation && !hasImplementationWorker) || route.kind === "memory-only" || route.kind === "ask-user") return route;
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
    const result = ensureDagHasImplementationReview(route.plan.stages, workerStep, reviewerStep);
    const withReview = result.changed ? {
      ...route,
      agents: result.stages.flatMap((stage) => stage.tasks.map((step) => step.agent)),
      needsArtifacts: true,
      reason: implementationReviewReason(route.reason, result.addedWorker, result.addedReviewer),
      plan: {
        kind: "dag",
        stages: result.stages,
      },
    } satisfies RouteDecision : route;
    return withReview;
  }

  const existingSteps = route.plan.kind === "single"
    ? [{ id: "existing", agent: route.plan.agent, task: route.plan.task, budget: route.plan.budget }]
    : route.plan.kind === "chain" ? route.plan.steps : route.plan.tasks;
  const result = ensureStepsHaveImplementationReview(existingSteps, workerStep, reviewerStep);
  const withReview = result.changed ? {
    ...route,
    kind: "multi-agent-chain",
    agents: result.steps.map((step) => step.agent),
    needsArtifacts: true,
    reason: implementationReviewReason(route.reason, result.addedWorker, result.addedReviewer),
    plan: { kind: "chain", steps: result.steps },
  } satisfies RouteDecision : route;
  return withReview;
}

function ensureMutationRouteHasWorkerOnly(route: RouteDecision, requiresWorkspaceMutation: boolean, task: string): RouteDecision {
  const hasImplementationWorker = route.agents.includes("worker");
  if ((!requiresWorkspaceMutation && !hasImplementationWorker) || route.kind === "memory-only" || route.kind === "ask-user") return stripReviewerSteps(route);
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
    const withWorker = stages.some((stage) => stage.tasks.some((step) => step.agent === "worker"))
      ? stages
      : [...stages, { id: "implementation", tasks: [workerStep] }];
    return {
      ...route,
      agents: withWorker.flatMap((stage) => stage.tasks.map((step) => step.agent)),
      needsArtifacts: true,
      reason: `${route.reason} Mutation task normalized by pi-chalin harness ablation: reviewer disabled; worker execution preserved.`,
      plan: { kind: "dag", stages: withWorker },
    };
  }

  const existingSteps = route.plan.kind === "single"
    ? [{ id: "existing", agent: route.plan.agent, task: route.plan.task, budget: route.plan.budget }]
    : route.plan.kind === "chain" ? route.plan.steps : route.plan.tasks;
  const stripped = existingSteps.filter((step) => step.agent !== "reviewer");
  const steps = stripped.some((step) => step.agent === "worker") ? stripped : [...stripped, workerStep];
  return {
    ...route,
    kind: "multi-agent-chain",
    agents: steps.map((step) => step.agent),
    needsArtifacts: true,
    reason: `${route.reason} Mutation task normalized by pi-chalin harness ablation: reviewer disabled; worker execution preserved.`,
    plan: { kind: "chain", steps },
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
  const steps = route.plan.kind === "single"
    ? [{ id: "existing", agent: route.plan.agent, task: route.plan.task, budget: route.plan.budget }]
    : route.plan.kind === "chain" ? route.plan.steps : route.plan.tasks;
  const stripped = steps.filter((step) => step.agent !== "reviewer");
  if (stripped.length === steps.length) return route;
  if (stripped.length === 0) return askUserRoute(`${route.reason} Reviewer-only route removed for pi-chalin no-reviewer harness ablation; no executable non-reviewer step remains.`);
  return {
    ...route,
    kind: stripped.length === 1 ? "single-agent" : "multi-agent-chain",
    agents: stripped.map((step) => step.agent),
    reason: `${route.reason} Reviewer steps removed for pi-chalin no-reviewer harness ablation.`,
    plan: stripped.length === 1 ? { kind: "single", agent: stripped[0]!.agent, task: stripped[0]!.task, budget: stripped[0]!.budget } : { kind: "chain", steps: stripped },
  };
}

function askUserRoute(reason: string): RouteDecision {
  return { kind: "ask-user", agents: [], risk: "low", ambiguity: "high", needsMemory: false, needsArtifacts: false, reason };
}

function stripReviewerStages(stages: Array<{ id: string; tasks: AgentStep[] }>): Array<{ id: string; tasks: AgentStep[] }> {
  return stages
    .map((stage) => ({ ...stage, tasks: stage.tasks.filter((step) => step.agent !== "reviewer") }))
    .filter((stage) => stage.tasks.length > 0);
}

export function collapseReadOnlyScoutContextRoute(route: RouteDecision, requiresWorkspaceMutation: boolean): RouteDecision {
  if (requiresWorkspaceMutation || route.needsMemory || route.risk !== "low") return route;
  if (route.kind !== "multi-agent-chain" || route.plan?.kind !== "chain") return route;
  if (route.plan.steps.length !== 2) return route;

  const [scout, contextBuilder] = route.plan.steps;
  if (scout?.agent !== "scout" || contextBuilder?.agent !== "context-builder") return route;

  return {
    ...route,
    kind: "single-agent",
    agents: ["scout"],
    needsArtifacts: false,
    reason: `${route.reason} Read-only scout/context-builder route normalized by pi-chalin: the primary Pi agent can synthesize the user-facing answer from the scout handoff without a second child synthesis step.`,
    plan: {
      kind: "single",
      agent: "scout",
      task: scout.task,
      budget: scout.budget,
    },
  };
}

function reviewerDisabled(): boolean {
  return process.env.PI_CHALIN_DISABLE_REVIEWER === "1";
}

function ensureStepsHaveImplementationReview(existingSteps: AgentStep[], workerStep: AgentStep, reviewerStep: AgentStep): { steps: AgentStep[]; changed: boolean; addedWorker: boolean; addedReviewer: boolean } {
  let steps = [...existingSteps];
  let addedWorker = false;
  let addedReviewer = false;

  if (!steps.some((step) => step.agent === "worker")) {
    const firstReviewerIndex = steps.findIndex((step) => step.agent === "reviewer");
    const insertAt = firstReviewerIndex >= 0 ? firstReviewerIndex : steps.length;
    steps = [...steps.slice(0, insertAt), workerStep, ...steps.slice(insertAt)];
    addedWorker = true;
  }

  const lastWorkerIndex = findLastIndex(steps, (step) => step.agent === "worker");
  const hasPostWorkerReviewer = lastWorkerIndex >= 0 && steps.some((step, index) => index > lastWorkerIndex && step.agent === "reviewer");
  if (!hasPostWorkerReviewer) {
    steps = [...steps, reviewerStep];
    addedReviewer = true;
  }

  return { steps, changed: addedWorker || addedReviewer, addedWorker, addedReviewer };
}

function ensureDagHasImplementationReview(stages: Array<{ id: string; tasks: AgentStep[] }>, workerStep: AgentStep, reviewerStep: AgentStep): { stages: Array<{ id: string; tasks: AgentStep[] }>; changed: boolean; addedWorker: boolean; addedReviewer: boolean } {
  let nextStages = stages.map((stage) => ({ ...stage, tasks: [...stage.tasks] }));
  let addedWorker = false;
  let addedReviewer = false;

  if (!nextStages.some((stage) => stage.tasks.some((step) => step.agent === "worker"))) {
    const firstReviewerStageIndex = nextStages.findIndex((stage) => stage.tasks.some((step) => step.agent === "reviewer"));
    const insertAt = firstReviewerStageIndex >= 0 ? firstReviewerStageIndex : nextStages.length;
    nextStages = [
      ...nextStages.slice(0, insertAt),
      { id: "implementation", tasks: [workerStep] },
      ...nextStages.slice(insertAt),
    ];
    addedWorker = true;
  }

  const lastWorkerStageIndex = findLastIndex(nextStages, (stage) => stage.tasks.some((step) => step.agent === "worker"));
  const hasPostWorkerReviewer = lastWorkerStageIndex >= 0 && nextStages.some((stage, index) => index > lastWorkerStageIndex && stage.tasks.some((step) => step.agent === "reviewer"));
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

function findLastIndex<T>(items: T[], predicate: (item: T, index: number) => boolean): number {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    if (predicate(items[index]!, index)) return index;
  }
  return -1;
}
