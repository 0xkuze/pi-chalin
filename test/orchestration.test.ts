import assert from "node:assert/strict";
import { test } from "bun:test";
import { AgentCatalog } from "../src/agents.ts";
import {
  ORCHESTRATION_EVAL_CASES,
  summarizeOrchestrationEvalCases,
} from "../evals/orchestration-cases.ts";
import { buildChalinOrchestratorSystemPrompt } from "../src/orchestration.ts";
import { collapseReadOnlyScoutContextRoute, ensureMutationRouteHasWorkerAndReviewer, inferRouteRequiresWorkspaceMutation } from "../src/route-guards.ts";
import type { RouteDecision } from "../src/schemas.ts";

const expectedTopologyMap = new Map([
  ["single", "single-agent"],
  ["chain", "multi-agent-chain"],
  ["parallel", "multi-agent-parallel"],
  ["dag", "multi-agent-dag"],
  ["memory-only", "memory-only"],
  ["none", "none"],
]);

test("orchestration eval cases cover chalin and direct decisions", () => {
  const summary = summarizeOrchestrationEvalCases();

  assert.equal(summary.total, 19);
  assert.equal(summary.chalinExpected, 13);
  assert.equal(summary.directExpected, 6);
  assert.equal(summary.byTopology.single, 3);
  assert.equal(summary.byTopology.chain, 6);
  assert.equal(summary.byTopology.parallel, 1);
  assert.equal(summary.byTopology.dag, 2);
  assert.equal(summary.byTopology["memory-only"], 1);
  assert.equal(summary.byTopology.none, 6);

  for (const testCase of ORCHESTRATION_EVAL_CASES) {
    assert.ok(testCase.id.length > 0);
    assert.ok(testCase.reason.length > 20);
    assert.equal(expectedTopologyMap.has(testCase.expectedTopology), true);
    if (testCase.expectedDecision === "direct") assert.equal(testCase.expectedTopology, "none");
    if (testCase.expectedDecision === "chalin") assert.notEqual(testCase.expectedTopology, "none");
  }
});

test("orchestrator prompt teaches LLM-first routing without prompt keyword classifiers", () => {
  const catalog = AgentCatalog.load({ cwd: process.cwd() });
  const prompt = buildChalinOrchestratorSystemPrompt(catalog.list());

  assert.match(prompt, /primary Pi agent/i);
  assert.match(prompt, /answer directly, call `chalin_interview`, or call `chalin_route`/i);
  assert.match(prompt, /MUST call `chalin_interview` before `chalin_route`/i);
  assert.match(prompt, /Interview when/i);
  assert.match(prompt, /Call `chalin_route` first when specialist context isolation/i);
  assert.match(prompt, /Gate/i);
  assert.match(prompt, /branch\/diff\/PR/i);
  assert.match(prompt, /Architecture\/migration/i);
  assert.match(prompt, /Do not treat an explicit named-file refactor implementation as project strategy/i);
  assert.match(prompt, /Direct bias/i);
  assert.match(prompt, /small target set of files/i);
  assert.match(prompt, /specific function\/symbol\/API plus a local verifier/i);
  assert.match(prompt, /bounded read-only mini-project review/i);
  assert.match(prompt, /docs-only allows docs writes/i);
  assert.match(prompt, /runtime\/API-boundary analysis/i);
  assert.match(prompt, /full fidelity to every explicit criterion/i);
  assert.match(prompt, /derive the contract from prompt\+repo evidence/i);
  assert.match(prompt, /preservation\/no-op paths/i);
  assert.match(prompt, /composition with nearby metadata/i);
  assert.match(prompt, /low-allocation/i);
  assert.match(prompt, /resource escape hatches/i);
  assert.match(prompt, /arbitrary fixed caps/i);
  assert.match(prompt, /one combined implementation\/test edit/i);
  assert.match(prompt, /avoids micro-edits/i);
  assert.match(prompt, /smallest exact block/i);
  assert.match(prompt, /one focused corrective edit per failed verification/i);
  assert.match(prompt, /Verification must be docs readback/i);
  assert.match(prompt, /changed-file readback/i);
  assert.match(prompt, /exact implementation and nearest test\/evidence source paths/i);
  assert.match(prompt, /controlled clocks/i);
  assert.match(prompt, /exact requested files\/APIs/i);
  assert.match(prompt, /executable metadata/i);
  assert.match(prompt, /no unrequested deps/i);
  assert.doesNotMatch(prompt, /bun test|dependency-free TypeScript|Bun CLI|tsx|vitest|jest/i);
  assert.match(prompt, /explicit memory recall\/remembrance or memory inventory\/counts/i);
  assert.match(prompt, /call `chalin_memory_search` first/i);
  assert.match(prompt, /Routing principles/i);
  assert.match(prompt, /Use the available agent roster as tools/i);
  assert.match(prompt, /fixed recipe book/i);
  assert.match(prompt, /staged fan-out\/fan-in/i);
  assert.match(prompt, /Coverage Matrix/i);
  assert.match(prompt, /covered, not-present with evidence, or marked unknown\/gap/i);
  assert.match(prompt, /derive domain-critical surfaces/i);
  assert.match(prompt, /Routed implementation\/file mutation must include at least one worker-capable executor and a later reviewer/i);
  assert.match(prompt, /reviewer reports FAIL\/GAP/i);
  assert.match(prompt, /non-overlapping/i);
  assert.match(prompt, /Direct answer when/i);
  assert.match(prompt, /named-file bugfixes/i);
  assert.match(prompt, /named-file bugfixes\/refactors/i);
  assert.match(prompt, /After a passing verification, perform one changed-file readback and stop/i);
  assert.match(prompt, /scout/);
  assert.match(prompt, /reviewer/);
  assert.doesNotMatch(prompt, /regex|if the prompt contains|hard-coded prompt/i);
});

test("chalin mutation routes without workers are normalized before execution and review", () => {
  const route: RouteDecision = {
    kind: "multi-agent-chain",
    agents: ["scout", "planner", "reviewer"],
    risk: "low",
    ambiguity: "low",
    needsMemory: false,
    needsArtifacts: true,
    reason: "primary selected analysis chain",
    plan: {
      kind: "chain",
      steps: [
        { agent: "scout", task: "inspect pricing files" },
        { agent: "planner", task: "plan refactor" },
        { agent: "reviewer", task: "review result" },
      ],
    },
  };

  const normalized = ensureMutationRouteHasWorkerAndReviewer(route, true, "Refactoriza src/pricing.ts para extraer funciones puras y añade tests.");

  assert.deepEqual(normalized.agents, ["scout", "planner", "worker", "reviewer"]);
  assert.equal(normalized.plan?.kind, "chain");
  assert.match(normalized.reason, /added a worker/i);
});

test("mutation normalization is driven by structured route metadata, not prompt regex", () => {
  const route: RouteDecision = {
    kind: "multi-agent-chain",
    agents: ["scout", "planner", "reviewer"],
    risk: "medium",
    ambiguity: "low",
    needsMemory: false,
    needsArtifacts: true,
    reason: "parent chose chalin",
    plan: { kind: "chain", steps: [{ agent: "scout", task: "inspect" }, { agent: "planner", task: "plan" }, { agent: "reviewer", task: "review" }] },
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

test("route tool infers mutation intent when a routed implementation omits the mutation flag", () => {
  const route: RouteDecision = {
    kind: "single-agent",
    agents: ["scout"],
    risk: "medium",
    ambiguity: "low",
    needsMemory: false,
    needsArtifacts: true,
    reason: "Tokenizer bugfix with make test verification.",
    plan: { kind: "single", agent: "scout", task: "Inspect source and return a patch plan." },
  };

  assert.equal(inferRouteRequiresWorkspaceMutation(route, "Fix the tokenizer and make test must pass."), true);
  assert.equal(inferRouteRequiresWorkspaceMutation(route, "Read-only analysis only; do not modify files."), false);
});

test("implementation routes with workers are normalized to include a post-worker reviewer", () => {
  const route: RouteDecision = {
    kind: "multi-agent-chain",
    agents: ["scout", "planner", "worker"],
    risk: "medium",
    ambiguity: "low",
    needsMemory: false,
    needsArtifacts: true,
    reason: "parent chose implementation chain",
    plan: {
      kind: "chain",
      steps: [
        { agent: "scout", task: "inspect implementation surface" },
        { agent: "planner", task: "plan the change" },
        { agent: "worker", task: "implement the change" },
      ],
    },
  };

  const normalized = ensureMutationRouteHasWorkerAndReviewer(route, false, "Implementa la mejora y corre tests.");

  assert.deepEqual(normalized.agents, ["scout", "planner", "worker", "reviewer"]);
  assert.equal(normalized.plan?.kind, "chain");
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
    kind: "multi-agent-chain",
    agents: ["scout", "planner", "worker", "reviewer"],
    risk: "medium",
    ambiguity: "low",
    needsMemory: false,
    needsArtifacts: true,
    reason: "parent selected a richer implementation workflow",
    plan: {
      kind: "chain",
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
  assert.equal(normalized.plan?.kind, "chain");
  assert.deepEqual(normalized.plan?.kind === "chain" ? normalized.plan.steps.map((step) => step.agent) : [], ["scout", "planner", "worker", "reviewer"]);
});

test("read-only scout/context-builder normalization is driven by route shape", () => {
  const route: RouteDecision = {
    kind: "multi-agent-chain",
    agents: ["scout", "context-builder"],
    risk: "low",
    ambiguity: "low",
    needsMemory: false,
    needsArtifacts: true,
    reason: "Read-only user-facing understanding.",
    plan: {
      kind: "chain",
      steps: [
        { agent: "scout", task: "Map repository evidence.", budget: "deep" },
        { agent: "context-builder", task: "Synthesize user-facing answer.", budget: "normal" },
      ],
    },
  };

  const normalized = collapseReadOnlyScoutContextRoute(route, false);
  const mutating = collapseReadOnlyScoutContextRoute(route, true);

  assert.equal(normalized.kind, "single-agent");
  assert.deepEqual(normalized.agents, ["scout"]);
  assert.equal(normalized.needsArtifacts, false);
  assert.equal(normalized.plan?.kind, "single");
  assert.match(normalized.reason, /primary Pi agent can synthesize/i);
  assert.equal(mutating.kind, "multi-agent-chain");
});
