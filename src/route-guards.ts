import type { AgentStep, RouteDecision } from "./schemas.ts";

export function ensureMutationRouteHasWorker(route: RouteDecision, task: string): RouteDecision {
  if (!taskExpectsWorkspaceMutation(task) || route.kind === "memory-only" || route.kind === "ask-user" || route.agents.includes("worker")) return route;
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

function taskExpectsWorkspaceMutation(task: string): boolean {
  return /\b(refactoriza|implementa|a[nñ]ade|a[nñ]adir|actualiza|modifica|corrige|arregla|crea|extrae|implement|add|update|modify|fix|create|write|edit|extract|scaffold)\b/i.test(task)
    || /\brefactor\b/i.test(task) && /\b(src\/|test\/|archivo|file|\.tsx?|\.jsx?|\.py|\.go|\.rs)\b/i.test(task);
}

export function directExecutionRecommendation(task: string, route: RouteDecision): string | undefined {
  if (route.kind === "memory-only" || route.kind === "ask-user") return undefined;
  if (route.risk === "high" || route.risk === "critical") return undefined;
  if (isBoundedReadOnlyReview(task)) {
    return [
      "Direct execution recommended: this is a bounded read-only review that explicitly forbids file changes.",
      "Use native read/grep/find/ls tools only; inspect the small relevant file set directly, perform no writes, and answer with concrete path evidence.",
    ].join(" ");
  }
  if (!taskExpectsWorkspaceMutation(task)) return undefined;
  if (!hasExplicitFileTargets(task)) return undefined;
  if (hasBroadOrRiskyScope(task)) return undefined;
  return [
    "Direct execution recommended: this is a bounded explicit-file mutation.",
    "Use native read/edit/write/bash tools instead of subagents; inspect the named target file(s), make the requested change, run the nearest relevant verification command, fix failures and rerun after the final edit, then answer with paths plus passing verification status.",
  ].join(" ");
}

function hasExplicitFileTargets(task: string): boolean {
  const matches = task.match(/\b[\w@.-]+(?:\/[\w@.-]+)+\.[a-zA-Z0-9]+\b/g) ?? [];
  return matches.length > 0 && new Set(matches).size <= 3;
}

function isBoundedReadOnlyReview(task: string): boolean {
  if (taskExpectsWorkspaceMutation(task)) return false;
  if (!/\b(revisa|review|audit|audita|inspect|inspecciona)\b/i.test(task)) return false;
  if (!/\b(no modifiques|no modificar|no edits?|do not modify|don't modify|read[- ]only|solo lectura|sin modificar)\b/i.test(task)) return false;
  if (hasBroadReadOnlyScope(task)) return false;
  return /\b(mini|small|peque[nñ]o|bounded|concret[oa]s?|specific paths?|paths concretos|file evidence|evidencia)\b/i.test(task)
    || hasExplicitFileTargets(task);
}

function hasBroadReadOnlyScope(task: string): boolean {
  return /\b(project[- ]wide|entire project|whole project|all files|monorepo|architecture|migration|migraci[oó]n|deep|en profundidad|broad|amplio|large|complex|risky)\b/i.test(task);
}

function hasBroadOrRiskyScope(task: string): boolean {
  return /\b(project[- ]wide|entire project|whole project|all files|monorepo|architecture|migration|migraci[oó]n|security|seguridad|auth|authentication|authorization|permissions?|database|schema|concurrency|race condition|large|complex|risky|long file|archivo largo|surgical|quir[uú]rgic|no rewrite|sin reescribir)\b/i.test(task);
}
