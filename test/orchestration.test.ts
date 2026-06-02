import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "bun:test";
import { AgentCatalog } from "../src/agents/agents.ts";
import {
  ORCHESTRATION_EVAL_CASES,
  summarizeOrchestrationEvalCases,
} from "../evals/orchestration-cases.ts";
import { activeTokenTotal } from "../evals/token-metrics.ts";
import { buildChalinOrchestratorSystemPrompt, selectLikelyAgentsForPrompt } from "../src/orchestration/orchestration.ts";
import { routeFromLegacyPlan, routeFromPlan } from "../src/kernel/kernel.ts";
import { collapseReadOnlyScoutContextRoute, ensureMutationRouteHasWorkerAndReviewer, inferRouteRequiresWorkspaceMutation, normalizeRouteForExecution } from "../src/routing/route-guards.ts";
import type { RouteDecision } from "../src/domain/schemas.ts";

const expectedTopologyMap = new Map([
  ["sequential", "multi-agent-sequential"],
  ["dag", "multi-agent-dag"],
  ["none", "none"],
]);
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

test("orchestration eval cases cover chalin and direct decisions", () => {
  const summary = summarizeOrchestrationEvalCases();

  assert.equal(summary.total, 25);
  assert.equal(summary.chalinExpected, 16);
  assert.equal(summary.directExpected, 9);
  assert.equal(summary.byTopology.sequential, 10);
  assert.equal(summary.byTopology.dag, 6);
  assert.equal(summary.byTopology.none, 9);
  assert.ok(ORCHESTRATION_EVAL_CASES.some((testCase) => testCase.preRouteInspection === "minimal-if-needed"));

  for (const testCase of ORCHESTRATION_EVAL_CASES) {
    assert.ok(testCase.id.length > 0);
    assert.ok(testCase.reason.length > 20);
    assert.equal(expectedTopologyMap.has(testCase.expectedTopology), true);
    if (testCase.expectedDecision === "direct") assert.equal(testCase.expectedTopology, "none");
    if (testCase.expectedDecision === "chalin") {
      assert.notEqual(testCase.expectedTopology, "none");
      assert.ok(testCase.preRouteInspection === "forbidden" || testCase.preRouteInspection === "minimal-if-needed");
    } else {
      assert.equal(testCase.preRouteInspection, undefined);
    }
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
  assert.match(source, /pre-decision inspection/);
  assert.match(source, /isChalinRouteResultEvent/);
  assert.match(source, /chalinRouteProgressSignature/);
  assert.match(source, /evalRunProgressSignature/);
  assert.match(source, /latestChildSessionProgress/);
  assert.match(source, /childSessionProgressRoots/);
  assert.match(source, /worktreeProgressRoots/);
  assert.match(source, /entry\.name\.startsWith\(`\$\{runId\}-`\)/);
  assert.match(source, /\.pi-chalin-worktrees/);
  assert.match(source, /lastChildSessionProgressSignature/);
  assert.doesNotMatch(source, /runProgress\?\.mtimeMs && runProgress\.mtimeMs > lastChalinProgressAt/);
  assert.match(source, /without structural progress/);
  assert.doesNotMatch(source, /hard timeout after/);
  assert.doesNotMatch(source, /setTimeout\(\(\) => kill\(`hard timeout/);
  assert.doesNotMatch(source, /role\\":\\"toolResult\\"[\s\S]*toolName\\":\\"chalin_route/);
});

test("orchestration eval requires persisted run JSON for routed checkpointing", () => {
  const source = readFileSync(resolve(repoRoot, "evals", "orchestration.eval.ts"), "utf-8");

  assert.match(source, /missing persisted run JSON for chalin_route checkpoint\/resume/);
  assert.match(source, /evaluateRunPersistence/);
  assert.match(source, /run status \$\{runSummary\.status\} != complete/);
  assert.match(source, /runPath: file/);
  assert.match(source, /augmentMetricsWithPersistedRun/);
  assert.match(source, /extractPersistedRunMetrics/);
  assert.match(source, /aggregateRunMetrics/);
});

test("orchestration eval isolates mutating SDK fixtures and writes incremental reports", () => {
  const source = readFileSync(resolve(repoRoot, "evals", "orchestration.eval.ts"), "utf-8");

  assert.match(source, /const fixture = makeFixtureRepo\(\);\s*const runFilesBefore = listRunFiles\(fixture\);/);
  assert.match(source, /runPi\(args, testCase, fixture, runFilesBefore, \{/);
  assert.match(source, /loadNewRunSummary\(fixture, runFilesBefore\)/);
  assert.match(source, /fixtures: Object\.fromEntries/);
  assert.match(source, /const activeCases = new Map<string, ActiveEvalCase>\(\)/);
  assert.match(source, /activeCases: active/);
  assert.match(source, /activeCases\.set\(testCase\.id/);
  assert.match(source, /createCaseLogFiles\(testCase\.id\)/);
  assert.match(source, /updateActiveCaseProgress\(testCase\.id, progress\)/);
  assert.match(source, /writeCurrentReport\("running"\)/);
  assert.match(source, /results\.push\(result\);\s*writeCurrentReport\("running"\)/);
  assert.match(source, /stdoutPath/);
  assert.match(source, /stderrPath/);
  assert.match(source, /writeCaseLogs/);
  assert.match(source, /fs\.appendFileSync\(options\.stdoutPath/);
  assert.match(source, /fs\.appendFileSync\(options\.stderrPath/);
  assert.match(source, /latestRunProgress\(fixture, runFilesBefore\)/);
  assert.match(source, /childSessionProgress/);
});

test("orchestration eval scales SDK efficiency thresholds by persisted step count", () => {
  const source = readFileSync(resolve(repoRoot, "evals", "orchestration.eval.ts"), "utf-8");

  assert.match(source, /const steps = Array\.isArray\(run\.steps\) \? run\.steps : \[\]/);
  assert.match(source, /stepCount: steps\.length/);
  assert.match(source, /runningStepCount: steps\.filter\(\(step\) => step\.status === "running"\)\.length/);
  assert.match(source, /budgetMaxSeconds: positiveNumber\(run\.budgetPreflight\?\.policy\?\.caps\?\.maxSeconds\)/);
  assert.match(source, /scaledSdkThreshold/);
  assert.match(source, /scaledSdkCostThreshold/);
  assert.match(source, /scaledSdkTimeout/);
  assert.match(source, /latestRunProgress\(fixture, runFilesBefore\)/);
  assert.match(source, /scaledSdkDuplicateReadThreshold/);
  assert.match(source, /runSummary\.stepCount \* 2/);
  assert.match(source, /const structuralLimit = base \* Math\.max\(1, runSummary\.stepCount\)/);
  assert.match(source, /Math\.ceil\(structuralLimit \* 1\.05\)/);
  assert.match(source, /runSummary\.workUnitCount/);
  assert.match(source, /runSummary\.materializedFanoutUnits/);
  assert.match(source, /Math\.ceil\(runSummary\.stepCount \/ 4\)/);
  assert.match(source, /runSummary\.status === "running" && runSummary\.runningStepCount > 0 && runSummary\.budgetMaxSeconds/);
  assert.match(source, /runSummary\.budgetMaxSeconds \* 1_000/);
});

test("orchestration eval forces child agents onto the selected eval model", () => {
  const source = readFileSync(resolve(repoRoot, "evals", "orchestration.eval.ts"), "utf-8");

  assert.match(source, /--model/);
  assert.match(source, /PI_CHALIN_EVAL_AGENT_MODEL: evalModel/);
});

test("orchestration eval reports recoverable policy attempts without making them blocking", () => {
  const source = readFileSync(resolve(repoRoot, "evals", "orchestration.eval.ts"), "utf-8");

  assert.match(source, /violationReasons/);
  assert.match(source, /blockingPolicyViolationReasons/);
  assert.match(source, /isRecoverablePolicyAttempt/);
  assert.match(source, /write_existing_file:/);
  assert.match(source, /large_edit_block:/);
  assert.match(source, /read_loop:/);
  assert.match(source, /work_unit_scope_gap:/);
  assert.match(source, /outside_workspace_path:/);
  assert.match(source, /runSummary\?\.status === "complete"/);
});

test("orchestrator prompt teaches LLM-first routing without prompt keyword classifiers", () => {
  const catalog = AgentCatalog.load({ cwd: process.cwd() });
  const prompt = buildChalinOrchestratorSystemPrompt(catalog.list());

  for (const stableToken of ["DIRECT", "ROUTE", "chalin_direct", "chalin_route", "topology=sequential", "topology=dag", "chalin_interview"]) {
    assert.match(prompt, new RegExp(stableToken.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), stableToken);
  }
  for (const abstractTerm of ["bounded", "risk", "ambiguity", "ownership", "fan-in", "responsibility", "workspace evidence", "repository history"]) {
    assert.match(prompt, new RegExp(`\\b${abstractTerm}\\b`, "i"), abstractTerm);
  }
  assert.match(prompt, /Escalate later with `chalin_route`/);
  assert.match(prompt, /call `chalin_direct` first/);
  assert.match(prompt, /`chalin_route` first/);
  assert.match(prompt, /not parent pre-scout/);
  assert.match(prompt, /same routed run/);
  assert.match(prompt, /expectedEffects describe the whole workflow/);
  assert.doesNotMatch(prompt, /\b(?:example|examples|ejemplo|ejemplos|e\.g\.)\b/i);
  assert.doesNotMatch(prompt, /bun test|dependency-free TypeScript|Bun CLI|tsx|vitest|jest/i);
  for (const concern of ["recon", "context-building", "planning", "implementation", "review"]) {
    assert.match(prompt, new RegExp(`\\b${concern}\\b`));
  }
  assert.ok(prompt.length < 2600, `orchestrator prompt should stay minimal, got ${prompt.length}`);
  assert.doesNotMatch(prompt, /branch\/diff\/PR/i);
  assert.doesNotMatch(prompt, /->/i);
  assert.doesNotMatch(prompt, /regex|if the prompt contains|hard-coded prompt/i);
});

test("orchestrator prompt shows the role roster so the model chooses agents", () => {
  const catalog = AgentCatalog.load({ cwd: process.cwd() });
  const agents = catalog.list();
  const selected = selectLikelyAgentsForPrompt(agents, "Implementa src/cache.ts con tests y luego revisa la cobertura.");
  const names = selected.map((agent) => agent.name);

  const expectedCore = agents.filter((agent) => ["recon", "context-building", "planning", "implementation", "review"].includes(agent.concern)).map((agent) => agent.name);

  assert.deepEqual(names, expectedCore);
  assert.deepEqual(selectLikelyAgentsForPrompt(agents, "hola").map((agent) => agent.name), expectedCore);

  const prompt = buildChalinOrchestratorSystemPrompt(agents, "Implementa src/cache.ts con tests y luego revisa la cobertura.");
  assert.match(prompt, /Agents:/i);
  for (const agentName of expectedCore) assert.match(prompt, new RegExp(`\\b${agentName}\\b`));
  assert.doesNotMatch(prompt, /capabilities=/);
  assert.doesNotMatch(prompt, /tools=/);
});

test("orchestrator roster leaves decomposition decisions to the model", () => {
  const catalog = AgentCatalog.load({ cwd: process.cwd() });
  const agents = catalog.list();
  for (const prompt of [
    "divide el trabajo por unidad independiente con ejecucion y revision aisladas",
    "resuelve cada limite de ownership como una unidad separada",
    "descompone un plan demasiado grande para un solo worker",
  ]) {
    const selected = selectLikelyAgentsForPrompt(agents, prompt).map((agent) => agent.name);
    assert.deepEqual(selected, agents.filter((agent) => ["recon", "context-building", "planning", "implementation", "review"].includes(agent.concern)).map((agent) => agent.name), prompt);
  }

  const prompt = buildChalinOrchestratorSystemPrompt(
    agents,
    "divide el trabajo por unidad independiente con ejecucion y revision aisladas",
  );
  assert.match(prompt, /scout/);
  assert.match(prompt, /worker/);
  assert.match(prompt, /reviewer/);
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

test("chalin mutation normalization preserves structured DAG discovery instead of adding one generic worker", () => {
  const route: RouteDecision = {
    kind: "multi-agent-dag",
    agents: ["reviewer"],
    risk: "medium",
    ambiguity: "low",
    needsMemory: false,
    needsArtifacts: true,
    expectedEffects: ["read", "write", "verify"],
    reason: "structured fanout review route",
    plan: { kind: "dag", stages: [{ id: "review", tasks: [{ agent: "reviewer", task: "Review the discovered work units." }] }] },
  };

  const normalized = ensureMutationRouteHasWorkerAndReviewer(route, true, "No fanout hints are needed in this text.");

  assert.equal(normalized.plan?.kind, "dag");
  assert.deepEqual(normalized.agents, ["scout", "reviewer"]);
  assert.doesNotMatch(normalized.agents.join(","), /worker/);
  assert.match(normalized.reason, /Fanout\/decomposition intent preserved/i);
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
    workUnitStrategy: "planned",
    steps: [{ agent: "planner", task: "Prepare the execution contract." }],
    reason: "Side effects are explicit route metadata.",
  });

  assert.equal(inferRouteRequiresWorkspaceMutation(route, "No mutation words here."), true);
  assert.equal(route.workUnitStrategy, "planned");

  const normalized = normalizeRouteForExecution(route, {
    requiresWorkspaceMutation: inferRouteRequiresWorkspaceMutation(route, "No mutation words here."),
    task: "No mutation words here.",
  });

  assert.deepEqual(normalized.agents, ["planner", "worker", "reviewer"]);
  assert.deepEqual(normalized.expectedEffects, ["read", "write", "verify"]);
});

test("work unit strategy is structured and independent from topology", () => {
  const sequential = routeFromPlan({
    topology: "sequential",
    expectedEffects: ["read", "write", "verify"],
    workUnitStrategy: "discover",
    steps: [{ agent: "worker", task: "Coordinate bounded child units from the assigned scope." }],
    reason: "Primary Pi selected a sequential coordinator with nested units.",
  });
  const dag = routeFromPlan({
    topology: "dag",
    expectedEffects: ["read", "verify"],
    workUnitStrategy: "planned",
    stages: [{ id: "review", tasks: [{ agent: "reviewer", task: "Review a bounded unit." }] }],
    reason: "Primary Pi selected planned unit reviews.",
  });

  assert.equal(sequential.kind, "multi-agent-sequential");
  assert.equal(sequential.workUnitStrategy, "discover");
  assert.equal(dag.kind, "multi-agent-dag");
  assert.equal(dag.workUnitStrategy, "planned");
});

test("discover WorkUnit routes strip premature worker and reviewer placeholders structurally", () => {
  const route = routeFromPlan({
    topology: "dag",
    expectedEffects: ["read", "write", "verify"],
    workUnitStrategy: "discover",
    stages: [
      { id: "discover", tasks: [{ agent: "scout", task: "Materialize bounded units." }] },
      { id: "execute", tasks: [{ agent: "worker", task: "Premature execution placeholder." }] },
      { id: "review", tasks: [{ agent: "reviewer", task: "Premature review placeholder." }] },
    ],
    reason: "Primary Pi selected dynamic unit discovery.",
  });

  const normalized = normalizeRouteForExecution(route, {
    requiresWorkspaceMutation: inferRouteRequiresWorkspaceMutation(route, "Structured mutation route."),
    task: "Structured mutation route.",
  });

  assert.equal(normalized.workUnitStrategy, "discover");
  assert.deepEqual(normalized.agents, ["scout"]);
  assert.equal(normalized.plan?.kind, "dag");
  assert.deepEqual(normalized.plan?.kind === "dag" ? normalized.plan.stages.map((stage) => stage.id) : [], ["discover"]);
  assert.equal(normalized.plan?.kind === "dag" ? normalized.plan.stages[0]?.tasks[0]?.agent : undefined, "scout");
});

test("planned WorkUnit routes preserve named worker and reviewer units", () => {
  const route = routeFromPlan({
    topology: "dag",
    expectedEffects: ["read", "write", "verify"],
    workUnitStrategy: "planned",
    stages: [
      { id: "execute", tasks: [{ agent: "worker", task: "Implement bounded unit A." }, { agent: "worker", task: "Implement bounded unit B." }] },
      { id: "review", tasks: [{ agent: "reviewer", task: "Review bounded units." }] },
    ],
    reason: "Primary Pi selected planned bounded units.",
  });

  const normalized = normalizeRouteForExecution(route, {
    requiresWorkspaceMutation: inferRouteRequiresWorkspaceMutation(route, "Structured mutation route."),
    task: "Structured mutation route.",
  });

  assert.equal(normalized.workUnitStrategy, "planned");
  assert.deepEqual(normalized.agents, ["worker", "worker", "reviewer"]);
  assert.deepEqual(normalized.plan?.kind === "dag" ? normalized.plan.stages.map((stage) => stage.tasks.map((step) => step.agent)) : [], [["worker", "worker"], ["reviewer"]]);
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
