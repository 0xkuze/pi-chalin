import type { AgentStep, RouteDecision } from "./schemas.ts";

export function ensureMutationRouteHasWorker(route: RouteDecision, requiresWorkspaceMutation: boolean, task: string): RouteDecision {
  if (!requiresWorkspaceMutation || route.kind === "memory-only" || route.kind === "ask-user" || route.agents.includes("worker")) return route;
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
