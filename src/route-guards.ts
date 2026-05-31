import type { AgentStep, RouteDecision } from "./schemas.ts";

export function ensureMutationRouteHasWorker(route: RouteDecision, requiresWorkspaceMutation: boolean, task: string): RouteDecision {
  return ensureMutationRouteHasWorkerAndReviewer(route, requiresWorkspaceMutation, task);
}

export function inferRouteRequiresWorkspaceMutation(route: RouteDecision, task: string): boolean {
  if (route.kind === "memory-only" || route.kind === "ask-user") return false;
  if (route.agents.includes("worker")) return true;
  const text = `${task}\n${route.reason}`.toLowerCase();
  if (/\b(read[- ]?only|no[- ]?code|sin modificar|no modificar|do not modify|analysis only|solo analizar|s[oó]lo analizar)\b/.test(text)) return false;
  return /\b(fix|bugfix|implement|refactor|change|update|add|write|create|patch|repair|corrige|arregla|implementa|refactoriza|cambia|modifica|actualiza|agrega|añade|escribe|crea|parchea|repara)\b|\b(?:make|cargo|go|bun|npm|pnpm|yarn|pytest|python|node)\s+test\b|\btests?\s+must\s+pass\b|\bdebe(?:n)?\s+pasar\b/.test(text);
}

export function ensureMutationRouteHasWorkerAndReviewer(route: RouteDecision, requiresWorkspaceMutation: boolean, task: string): RouteDecision {
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
    if (!result.changed) return route;
    return {
      ...route,
      agents: result.stages.flatMap((stage) => stage.tasks.map((step) => step.agent)),
      needsArtifacts: true,
      reason: implementationReviewReason(route.reason, result.addedWorker, result.addedReviewer),
      plan: {
        kind: "dag",
        stages: result.stages,
      },
    };
  }

  const existingSteps = route.plan.kind === "single"
    ? [{ id: "existing", agent: route.plan.agent, task: route.plan.task, budget: route.plan.budget }]
    : route.plan.kind === "chain" ? route.plan.steps : route.plan.tasks;
  const result = ensureStepsHaveImplementationReview(existingSteps, workerStep, reviewerStep);
  if (!result.changed) return route;
  return {
    ...route,
    kind: "multi-agent-chain",
    agents: result.steps.map((step) => step.agent),
    needsArtifacts: true,
    reason: implementationReviewReason(route.reason, result.addedWorker, result.addedReviewer),
    plan: { kind: "chain", steps: result.steps },
  };
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
