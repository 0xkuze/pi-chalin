import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "bun:test";
import { AgentCatalog } from "../src/agents.ts";
import {
  ORCHESTRATION_EVAL_CASES,
  summarizeOrchestrationEvalCases,
} from "../evals/orchestration-cases.ts";
import { activeTokenTotal } from "../evals/token-metrics.ts";
import { buildChalinOrchestratorSystemPrompt, selectLikelyAgentsForPrompt } from "../src/orchestration.ts";
import { routeFromLegacyPlan, routeFromPlan } from "../src/kernel.ts";
import { collapseReadOnlyScoutContextRoute, ensureMutationRouteHasWorkerAndReviewer, inferRouteRequiresWorkspaceMutation, normalizeRouteForExecution } from "../src/route-guards.ts";
import type { RouteDecision } from "../src/schemas.ts";

const expectedTopologyMap = new Map([
  ["sequential", "multi-agent-sequential"],
  ["dag", "multi-agent-dag"],
  ["none", "none"],
]);
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

test("orchestration eval cases cover chalin and direct decisions", () => {
  const summary = summarizeOrchestrationEvalCases();

  assert.equal(summary.total, 21);
  assert.equal(summary.chalinExpected, 12);
  assert.equal(summary.directExpected, 9);
  assert.equal(summary.byTopology.sequential, 10);
  assert.equal(summary.byTopology.dag, 2);
  assert.equal(summary.byTopology.none, 9);

  for (const testCase of ORCHESTRATION_EVAL_CASES) {
    assert.ok(testCase.id.length > 0);
    assert.ok(testCase.reason.length > 20);
    assert.equal(expectedTopologyMap.has(testCase.expectedTopology), true);
    if (testCase.expectedDecision === "direct") assert.equal(testCase.expectedTopology, "none");
    if (testCase.expectedDecision === "chalin") assert.notEqual(testCase.expectedTopology, "none");
  }
});

test("orchestration eval token threshold ignores cached reads as active token work", () => {
  const usage = { input: 7123, output: 2227, cacheRead: 48896, cacheWrite: 0, totalTokens: 58246 };

  assert.equal(activeTokenTotal(usage), 9350);
});

test("orchestration eval uses inactivity guards instead of hard wall-clock deadlines", () => {
  const source = readFileSync(resolve(repoRoot, "evals", "orchestration.eval.ts"), "utf-8");

  assert.match(source, /defaultInactivityTimeoutMs = 120_000/);
  assert.match(source, /hardTimeoutMs: null/);
  assert.match(source, /startup timeout after/);
  assert.match(source, /idle timeout after/);
  assert.doesNotMatch(source, /hard timeout after/);
  assert.doesNotMatch(source, /setTimeout\(\(\) => kill\(`hard timeout/);
});

test("orchestrator prompt teaches LLM-first routing without prompt keyword classifiers", () => {
  const catalog = AgentCatalog.load({ cwd: process.cwd() });
  const prompt = buildChalinOrchestratorSystemPrompt(catalog.list());

  assert.match(prompt, /primary Pi agent/i);
  assert.match(prompt, /At the start choose one path: `DIRECT` or `ROUTE`/i);
  assert.match(prompt, /`DIRECT`: use normal Pi tools/i);
  assert.match(prompt, /`ROUTE`: call `chalin_route`/i);
  assert.match(prompt, /topology=sequential.*topology=dag/i);
  assert.match(prompt, /Pick agents by responsibility/i);
  assert.match(prompt, /Use the fewest agents/i);
  assert.match(prompt, /Routed file mutation needs a worker and a later reviewer/i);
  assert.match(prompt, /Use `chalin_interview` only when a human decision remains/i);
  assert.match(prompt, /memory is a capability, not a route category/i);
  assert.doesNotMatch(prompt, /bun test|dependency-free TypeScript|Bun CLI|tsx|vitest|jest/i);
  assert.match(prompt, /scout/);
  assert.match(prompt, /reviewer/);
  assert.ok(prompt.length < 2600, `orchestrator prompt should stay minimal, got ${prompt.length}`);
  assert.doesNotMatch(prompt, /branch\/diff\/PR/i);
  assert.doesNotMatch(prompt, /->/i);
  assert.doesNotMatch(prompt, /regex|if the prompt contains|hard-coded prompt/i);
});

test("orchestrator prompt shows a compact role roster so the model chooses agents", () => {
  const catalog = AgentCatalog.load({ cwd: process.cwd() });
  const agents = catalog.list();
  const selected = selectLikelyAgentsForPrompt(agents, "Implementa src/cache.ts con tests y luego revisa la cobertura.");
  const names = selected.map((agent) => agent.name);

  assert.ok(names.includes("worker"));
  assert.ok(names.includes("reviewer"));
  assert.equal(names.includes("conflict-resolver"), false);
  assert.ok(names.length < agents.length);
  assert.deepEqual(selectLikelyAgentsForPrompt(agents, "hola").map((agent) => agent.name), agents.map((agent) => agent.name));

  const conflictNames = selectLikelyAgentsForPrompt(agents, "Resuelve el conflicto de merge del worktree aislado y valida el resultado.")
    .map((agent) => agent.name);
  assert.ok(conflictNames.includes("conflict-resolver"));

  const prompt = buildChalinOrchestratorSystemPrompt(agents, "Implementa src/cache.ts con tests y luego revisa la cobertura.");
  assert.match(prompt, /Available pi-chalin agents/i);
  assert.match(prompt, /worker/);
  assert.match(prompt, /reviewer/);
  assert.doesNotMatch(prompt, /conflict-resolver: conflict-resolution/);
  assert.doesNotMatch(prompt, /capabilities=/);
  assert.doesNotMatch(prompt, /tools=/);
});

test("chalin mutation routes without workers are normalized before execution and review", () => {
  const route: RouteDecision = {
    kind: "multi-agent-sequential",
    agents: ["scout", "planner", "reviewer"],
    risk: "low",
    ambiguity: "low",
    needsMemory: false,
    needsArtifacts: true,
    reason: "primary selected analysis chain",
    plan: {
      kind: "sequential",
      steps: [
        { agent: "scout", task: "inspect pricing files" },
        { agent: "planner", task: "plan refactor" },
        { agent: "reviewer", task: "review result" },
      ],
    },
  };

  const normalized = ensureMutationRouteHasWorkerAndReviewer(route, true, "Refactoriza src/pricing.ts para extraer funciones puras y añade tests.");

  assert.deepEqual(normalized.agents, ["scout", "planner", "worker", "reviewer"]);
  assert.equal(normalized.plan?.kind, "sequential");
  assert.match(normalized.reason, /added a worker/i);
});

test("reviewer-disabled harness mode keeps mutation routes executable without adding review", () => {
  const previous = process.env.PI_CHALIN_DISABLE_REVIEWER;
  process.env.PI_CHALIN_DISABLE_REVIEWER = "1";
  try {
    const route = routeFromPlan({
      topology: "sequential",
      expectedEffects: ["read", "write", "verify"],
      steps: [{ agent: "planner", task: "Plan and patch a focused implementation change." }],
      reason: "Harness no-reviewer ablation.",
    });
    const normalized = normalizeRouteForExecution(route, {
      requiresWorkspaceMutation: true,
      task: "Implementa el cambio y corre tests.",
    });

    assert.equal(normalized.plan?.kind, "sequential");
    assert.ok(normalized.agents.includes("worker"));
    assert.equal(normalized.agents.includes("reviewer"), false);
    assert.doesNotMatch(normalized.reason, /added a reviewer/i);
  } finally {
    if (previous === undefined) delete process.env.PI_CHALIN_DISABLE_REVIEWER;
    else process.env.PI_CHALIN_DISABLE_REVIEWER = previous;
  }
});

test("reviewer-disabled harness mode removes review-only routes instead of executing reviewer", () => {
  const previous = process.env.PI_CHALIN_DISABLE_REVIEWER;
  process.env.PI_CHALIN_DISABLE_REVIEWER = "1";
  try {
    const singleReviewer = normalizeRouteForExecution(routeFromPlan({
      topology: "sequential",
      expectedEffects: ["read", "verify"],
      steps: [{ agent: "reviewer", task: "Review the implementation." }],
      reason: "Harness no-reviewer ablation.",
    }), {
      requiresWorkspaceMutation: false,
      task: "Review the implementation.",
    });
    const dagReviewer = normalizeRouteForExecution(routeFromPlan({
      topology: "dag",
      expectedEffects: ["read", "verify"],
      stages: [{ id: "review", tasks: [{ agent: "reviewer", task: "Review the implementation." }] }],
      reason: "Harness no-reviewer DAG ablation.",
    }), {
      requiresWorkspaceMutation: false,
      task: "Review the implementation.",
    });

    assert.equal(singleReviewer.agents.includes("reviewer"), false);
    assert.equal(singleReviewer.kind, "ask-user");
    assert.equal(dagReviewer.agents.includes("reviewer"), false);
    assert.equal(dagReviewer.kind, "ask-user");
  } finally {
    if (previous === undefined) delete process.env.PI_CHALIN_DISABLE_REVIEWER;
    else process.env.PI_CHALIN_DISABLE_REVIEWER = previous;
  }
});

test("mutation normalization is driven by structured route metadata, not prompt regex", () => {
  const route: RouteDecision = {
    kind: "multi-agent-sequential",
    agents: ["scout", "planner", "reviewer"],
    risk: "medium",
    ambiguity: "low",
    needsMemory: false,
    needsArtifacts: true,
    expectedEffects: ["read"],
    reason: "parent chose chalin",
    plan: { kind: "sequential", steps: [{ agent: "scout", task: "inspect" }, { agent: "planner", task: "plan" }, { agent: "reviewer", task: "review" }] },
  };

  const withoutFlag = ensureMutationRouteHasWorkerAndReviewer(
    route,
    false,
    "Refactoriza src/pricing.ts para extraer funciones puras pequeñas y corre tests.",
  );
  const withFlag = ensureMutationRouteHasWorkerAndReviewer(
    route,
    true,
    "Analiza sin palabras de implementación; la intención de mutar viene del campo estructurado.",
  );

  assert.deepEqual(withoutFlag.agents, ["scout", "planner", "reviewer"]);
  assert.deepEqual(withFlag.agents, ["scout", "planner", "worker", "reviewer"]);
});

test("route expectedEffects marks mutation without prose inference", () => {
  const route = routeFromPlan({
    topology: "sequential",
    expectedEffects: ["read", "write", "verify"],
    steps: [{ agent: "planner", task: "Prepare the execution contract." }],
    reason: "Side effects are explicit route metadata.",
  });

  assert.equal(inferRouteRequiresWorkspaceMutation(route, "No mutation words here."), true);

  const normalized = normalizeRouteForExecution(route, {
    requiresWorkspaceMutation: inferRouteRequiresWorkspaceMutation(route, "No mutation words here."),
    task: "No mutation words here.",
  });

  assert.deepEqual(normalized.agents, ["planner", "worker", "reviewer"]);
  assert.deepEqual(normalized.expectedEffects, ["read", "write", "verify"]);
});

test("routes without expectedEffects do not infer mutation from prose", () => {
  const route: RouteDecision = {
    kind: "multi-agent-sequential",
    agents: ["scout"],
    risk: "medium",
    ambiguity: "low",
    needsMemory: false,
    needsArtifacts: true,
    reason: "Tokenizer bugfix with make test verification.",
    plan: { kind: "sequential", steps: [{ agent: "scout", task: "Inspect source and return a patch plan." }] },
  };

  assert.equal(inferRouteRequiresWorkspaceMutation(route, "Fix the tokenizer and make test must pass."), false);
  assert.equal(inferRouteRequiresWorkspaceMutation(route, "Read-only analysis only; do not modify files."), false);
});

test("routeFromLegacyPlan derives mutation effects from worker responsibility", () => {
  const route = routeFromLegacyPlan({
    topology: "sequential",
    steps: [
      { agent: "worker", task: "Apply the requested workspace change." },
      { agent: "reviewer", task: "Review the changed files and verification evidence." },
    ],
    reason: "Worker owns the mutation; reviewer owns verification.",
  });

  assert.equal(inferRouteRequiresWorkspaceMutation(route, "Handle the requested work."), true);
  assert.deepEqual(route.expectedEffects, ["read", "write", "verify"]);

  const normalized = normalizeRouteForExecution(route, {
    requiresWorkspaceMutation: inferRouteRequiresWorkspaceMutation(route, "Handle the requested work."),
    task: "Handle the requested work.",
  });

  assert.deepEqual(normalized.agents, ["worker", "reviewer"]);
});

test("implementation routes with workers are normalized to include a post-worker reviewer", () => {
  const route: RouteDecision = {
    kind: "multi-agent-sequential",
    agents: ["scout", "planner", "worker"],
    risk: "medium",
    ambiguity: "low",
    needsMemory: false,
    needsArtifacts: true,
    reason: "parent chose implementation chain",
    plan: {
      kind: "sequential",
      steps: [
        { agent: "scout", task: "inspect implementation surface" },
        { agent: "planner", task: "plan the change" },
        { agent: "worker", task: "implement the change" },
      ],
    },
  };

  const normalized = ensureMutationRouteHasWorkerAndReviewer(route, false, "Implementa la mejora y corre tests.");

  assert.deepEqual(normalized.agents, ["scout", "planner", "worker", "reviewer"]);
  assert.equal(normalized.plan?.kind, "sequential");
  assert.match(normalized.reason, /added a reviewer/i);
  assert.match(normalized.reason, /plan, standards, gaps, and verification evidence/i);
});

test("dag implementation routes add final reviewer after worker stages", () => {
  const route: RouteDecision = {
    kind: "multi-agent-dag",
    agents: ["scout", "worker", "worker"],
    risk: "medium",
    ambiguity: "low",
    needsMemory: false,
    needsArtifacts: true,
    reason: "parent chose independent implementation slices",
    plan: {
      kind: "dag",
      stages: [
        { id: "discover", tasks: [{ agent: "scout", task: "map ownership" }] },
        { id: "implement", tasks: [{ agent: "worker", task: "edit package a" }, { agent: "worker", task: "edit package b" }] },
      ],
    },
  };

  const normalized = ensureMutationRouteHasWorkerAndReviewer(route, true, "Implementa cambios independientes en dos paquetes.");

  assert.deepEqual(normalized.agents, ["scout", "worker", "worker", "reviewer"]);
  assert.equal(normalized.plan?.kind, "dag");
  assert.equal(normalized.plan?.kind === "dag" ? normalized.plan.stages.at(-1)?.tasks[0]?.agent : undefined, "reviewer");
  assert.match(normalized.reason, /added a reviewer/i);
});

test("implementation normalization preserves the orchestrator-selected evidence and planning agents", () => {
  const route: RouteDecision = {
    kind: "multi-agent-sequential",
    agents: ["scout", "planner", "worker", "reviewer"],
    risk: "medium",
    ambiguity: "low",
    needsMemory: false,
    needsArtifacts: true,
    reason: "parent selected a richer implementation workflow",
    plan: {
      kind: "sequential",
      steps: [
        { agent: "scout", task: "inspect ownership" },
        { agent: "planner", task: "plan risk controls" },
        { agent: "worker", task: "implement" },
        { agent: "reviewer", task: "review" },
      ],
    },
  };

  const normalized = ensureMutationRouteHasWorkerAndReviewer(route, true, "Implementa una mejora con revisión.");

  assert.deepEqual(normalized.agents, ["scout", "planner", "worker", "reviewer"]);
  assert.equal(normalized.plan?.kind, "sequential");
  assert.deepEqual(normalized.plan?.kind === "sequential" ? normalized.plan.steps.map((step) => step.agent) : [], ["scout", "planner", "worker", "reviewer"]);
});

test("read-only scout/context-builder normalization is driven by route shape", () => {
  const route: RouteDecision = {
    kind: "multi-agent-sequential",
    agents: ["scout", "context-builder"],
    risk: "low",
    ambiguity: "low",
    needsMemory: false,
    needsArtifacts: true,
    reason: "Read-only user-facing understanding.",
    plan: {
      kind: "sequential",
      steps: [
        { agent: "scout", task: "Map repository evidence.", budget: "deep" },
        { agent: "context-builder", task: "Synthesize user-facing answer.", budget: "normal" },
      ],
    },
  };

  const normalized = collapseReadOnlyScoutContextRoute(route, false);
  const mutating = collapseReadOnlyScoutContextRoute(route, true);

  assert.equal(normalized.kind, "multi-agent-sequential");
  assert.deepEqual(normalized.agents, ["scout"]);
  assert.equal(normalized.needsArtifacts, false);
  assert.equal(normalized.plan?.kind, "sequential");
  assert.match(normalized.reason, /primary Pi agent can synthesize/i);
  assert.equal(mutating.kind, "multi-agent-sequential");
});
