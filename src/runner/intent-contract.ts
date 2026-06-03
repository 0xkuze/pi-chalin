import type { AgentStep, RouteDecision, RoutePlan, UserIntentContract } from "../domain/schemas.ts";

export function buildIntentContract(rootTask: string | undefined, route: RouteDecision): UserIntentContract | undefined {
  const originalPrompt = (rootTask || route.reason || "").trim();
  if (!originalPrompt) return undefined;
  const workUnitDiscovery = routeNeedsWorkUnitDiscovery(route);
  const requiredReviewMode = workUnitDiscovery && routeHasAgent(route.plan, "reviewer") ? "per-unit" as const : undefined;
  return {
    originalPrompt,
    explicitConstraints: [],
    forbiddenPaths: [],
    ...(workUnitDiscovery ? {
      workUnitDiscoveryRequested: true,
      decompositionTarget: "work unit",
      ...(route.fanoutAuthorized === true ? { fanoutAuthorized: true, fanoutTarget: "authorized discovered work units" } : {}),
      ...(requiredReviewMode ? { requiredReviewMode } : {}),
    } : {}),
  };
}

export function routeNeedsWorkUnitDiscovery(route: RouteDecision): boolean {
  if (route.kind === "ask-user") return false;
  if (route.workUnitStrategy === "none" || route.workUnitStrategy === "planned") return false;
  if (route.workUnitStrategy === "discover") return Boolean(route.plan);
  if (!route.expectedEffects?.includes("write")) return false;
  const plan = route.plan;
  if (!plan) return false;
  if (routeHasAgent(plan, "worker")) return false;
  return route.kind === "multi-agent-dag" || plan.kind === "dag";
}

export function hasFanoutIntent(input: unknown): boolean {
  return hasWorkUnitDiscoveryIntent(input);
}

export function hasExplicitFanoutIntent(input: unknown): boolean {
  if (!input || typeof input !== "object") return false;
  const record = input as Partial<UserIntentContract>;
  return record.fanoutAuthorized === true;
}

export function hasWorkUnitDiscoveryIntent(input: unknown): boolean {
  if (isRouteDecision(input)) return routeNeedsWorkUnitDiscovery(input);
  if (!input || typeof input !== "object") return false;
  const record = input as Partial<UserIntentContract>;
  return record.workUnitDiscoveryRequested === true || record.fanoutAuthorized === true;
}

function routeHasAgent(plan: RoutePlan | undefined, agent: string): boolean {
  return Boolean(plan && planSteps(plan).some((step) => step.agent === agent));
}

function planSteps(plan: RoutePlan): AgentStep[] {
  return plan.kind === "dag"
    ? plan.stages.flatMap((stage) => stage.tasks)
    : plan.steps;
}

function isRouteDecision(input: unknown): input is RouteDecision {
  if (!input || typeof input !== "object") return false;
  const record = input as Partial<RouteDecision>;
  return record.kind === "ask-user"
    || record.kind === "multi-agent-sequential"
    || record.kind === "multi-agent-dag";
}
