import assert from "node:assert/strict";
import { test } from "bun:test";
import { AgentCatalog } from "../src/agents.ts";
import {
  ORCHESTRATION_EVAL_CASES,
  buildChalinOrchestratorSystemPrompt,
  summarizeOrchestrationEvalCases,
} from "../src/orchestration.ts";
import { directExecutionRecommendation, ensureMutationRouteHasWorker } from "../src/tools.ts";
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
  assert.equal(summary.byTopology.chain, 9);
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
  assert.match(prompt, /MUST call `chalin_route` first/i);
  assert.match(prompt, /Gate/i);
  assert.match(prompt, /branch\/diff\/PR/i);
  assert.match(prompt, /Architecture\/migration/i);
  assert.match(prompt, /named-file refactor implementation is not this category/i);
  assert.match(prompt, /Hard direct gate/i);
  assert.match(prompt, /one to three target file paths/i);
  assert.match(prompt, /bounded read-only mini-project review/i);
  assert.match(prompt, /changing only implementation is incomplete/i);
  assert.match(prompt, /injected or controlled clock/i);
  assert.match(prompt, /dependency-free TypeScript scaffolding/i);
  assert.match(prompt, /exact requested files/i);
  assert.match(prompt, /bun test/i);
  assert.match(prompt, /package\.json `bin`/i);
  assert.match(prompt, /never command strings|not command strings/i);
  assert.match(prompt, /Explicit recall/i);
  assert.match(prompt, /Default recipes/i);
  assert.match(prompt, /scout → context-builder/i);
  assert.match(prompt, /scout → parallel folder agents → reviewer/i);
  assert.match(prompt, /staged fan-out\/fan-in/i);
  assert.match(prompt, /Coverage Matrix/i);
  assert.match(prompt, /covered with evidence, not present with evidence, or unknown\/gap/i);
  assert.match(prompt, /prefer `chain` with scout → context-builder using `budget: "deep"`/i);
  assert.match(prompt, /Reserve `dag` for explicit staged fan-out\/fan-in requests/i);
  assert.match(prompt, /scout → planner → reviewer/i);
  assert.match(prompt, /parallel worker/i);
  assert.match(prompt, /worktree/i);
  assert.match(prompt, /non-overlapping/i);
  assert.match(prompt, /Direct answer when/i);
  assert.match(prompt, /named-file bugfixes/i);
  assert.match(prompt, /named-file bugfixes\/refactors/i);
  assert.match(prompt, /do not convert safe bounded edits into dry-run reports/i);
  assert.match(prompt, /passing verification command after the final edit/i);
  assert.match(prompt, /scout/);
  assert.match(prompt, /reviewer/);
  assert.doesNotMatch(prompt, /regex|if the prompt contains|hard-coded prompt/i);
});

test("chalin mutation routes without workers are normalized before execution", () => {
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

  const normalized = ensureMutationRouteHasWorker(route, "Refactoriza src/pricing.ts para extraer funciones puras y añade tests.");

  assert.deepEqual(normalized.agents, ["scout", "planner", "worker", "reviewer"]);
  assert.equal(normalized.plan?.kind, "chain");
  assert.match(normalized.reason, /added a worker/i);
});

test("bounded explicit-file refactors are recommended back to direct execution", () => {
  const route: RouteDecision = {
    kind: "multi-agent-chain",
    agents: ["scout", "worker", "reviewer"],
    risk: "medium",
    ambiguity: "low",
    needsMemory: false,
    needsArtifacts: true,
    reason: "parent chose chalin",
    plan: { kind: "chain", steps: [{ agent: "worker", task: "edit" }] },
  };

  const recommendation = directExecutionRecommendation(
    "Refactoriza src/pricing.ts para extraer funciones puras pequeñas y corre tests.",
    route,
  );

  assert.match(recommendation ?? "", /Direct execution recommended/i);
});

test("bounded read-only mini reviews are recommended back to direct execution", () => {
  const route: RouteDecision = {
    kind: "multi-agent-chain",
    agents: ["scout", "reviewer"],
    risk: "medium",
    ambiguity: "low",
    needsMemory: false,
    needsArtifacts: false,
    reason: "parent chose chalin",
    plan: { kind: "chain", steps: [{ agent: "scout", task: "inspect" }, { agent: "reviewer", task: "review" }] },
  };

  const recommendation = directExecutionRecommendation(
    "Revisa este mini proyecto y dime si hay riesgo de seguridad en el boundary de auth. No modifiques archivos; entrega evidencia con paths concretos.",
    route,
  );

  assert.match(recommendation ?? "", /bounded read-only review/i);
});

test("broad risky file work is not recommended back to direct execution", () => {
  const route: RouteDecision = {
    kind: "multi-agent-chain",
    agents: ["scout", "worker", "reviewer"],
    risk: "medium",
    ambiguity: "low",
    needsMemory: false,
    needsArtifacts: true,
    reason: "parent chose chalin",
    plan: { kind: "chain", steps: [{ agent: "worker", task: "edit" }] },
  };

  assert.equal(
    directExecutionRecommendation("Refactoriza todo el proyecto y la arquitectura de src/pricing.ts sin reescribir.", route),
    undefined,
  );
});
