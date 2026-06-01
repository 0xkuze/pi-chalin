import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, test } from "bun:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { chalinChildSessionDir, createChalinChildSessionManager, hideLegacyTopLevelChildSessions } from "../src/child-sessions.ts";
import { policyForStep } from "../src/budget.ts";
import { resolveAgentModel, resolveAgentThinking, resolveInheritedModelFallback } from "../src/model-resolution.ts";
import { buildSdkPrompt, childToolNames, resolveStepCompletionStatus, toolBudgetForStep } from "../src/runner-prompt.ts";
import { DEFAULT_SDK_STEP_IDLE_STALL_MS, MockWorkerRunner, budgetPolicyForSdkStep, buildConflictResolverTask, extractAssistantRuntimeError, hasUnrecoverableFailedSteps, normalizeThinkingForBudget, parseAgentOutput, promptTokenomicsPhaseForStep, reviewerHandoffNeedsRepair, runWithIdleStallMonitor, sdkStepIdleStallMs, shouldStopAfterDagStage } from "../src/runner.ts";
import { createRunState, loadResumableRunState, prepareRunForResume } from "../src/runner-state.ts";
import type { AgentDefinition, RouteDecision, RunState, RunStepMetrics } from "../src/schemas.ts";

const tempDirs: string[] = [];
afterEach(() => { while (tempDirs.length > 0) fs.rmSync(tempDirs.pop()!, { recursive: true, force: true }); });
function tempDir(prefix: string): string { const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix)); tempDirs.push(dir); return dir; }
function git(cwd: string, args: string[]) {
  const result = spawnSync("git", args, { cwd, encoding: "utf-8" });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}
function agent(name: string, caps: AgentDefinition["capabilities"]): AgentDefinition {
  return { name, scope: "built-in", concern: "implementation", capabilities: caps, description: name, model: "inherit", tools: [], memory: { read: false, write: "never", categories: [] }, systemPrompt: "", diagnostics: [] };
}

function userMessage(content: string): Parameters<SessionManager["appendMessage"]>[0] {
  return { role: "user", content } as Parameters<SessionManager["appendMessage"]>[0];
}

function assistantMessage(content: string): Parameters<SessionManager["appendMessage"]>[0] {
  return { role: "assistant", content } as unknown as Parameters<SessionManager["appendMessage"]>[0];
}

function readOnlyAgent(name: string, concern: AgentDefinition["concern"] = "context-building"): AgentDefinition {
  return { name, scope: "built-in", concern, capabilities: ["inspect-files", "search-files"], description: name, model: "inherit", tools: [], memory: { read: false, write: "never", categories: [] }, systemPrompt: "", diagnostics: [] };
}

test("promptTokenomicsPhaseForStep does not treat normal repair tasks as review repair phases", () => {
  const worker = agent("worker", ["edit-files"]);
  const reviewer = { ...agent("reviewer", ["inspect-files"]), concern: "review" as const };

  assert.equal(promptTokenomicsPhaseForStep({ id: "step-1", agent: "worker" }, worker), "childPrompt");
  assert.equal(promptTokenomicsPhaseForStep({ id: "repair-parser-bug:step-1", agent: "worker" }, worker), "childPrompt");
  assert.equal(promptTokenomicsPhaseForStep({ id: "step-2", agent: "reviewer" }, reviewer), "reviewer");
  assert.equal(promptTokenomicsPhaseForStep({ id: "review-repair-1-worker", agent: "worker" }, worker), "repair");
  assert.equal(promptTokenomicsPhaseForStep({ id: "review-repair-1-reviewer", agent: "reviewer" }, reviewer), "repair");
});

function stepMetrics(overrides: Partial<RunStepMetrics> = {}): RunStepMetrics {
  return {
    durationMs: 1,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    toolCalls: 0,
    toolCallsByName: {},
    ...overrides,
  };
}

test("parseAgentOutput extracts categorized human-readable memory candidates", () => {
  const output = parseAgentOutput("planner", "## Handoff\nUse worker next\n\n## Memory Candidates\n- tooling: This project uses Bun for tests, and tests should avoid setTimeout-based waits because they make the suite flaky.");
  assert.equal(output.handoff, "Use worker next");
  assert.equal(output.memoryCandidates.length, 1);
  assert.equal(output.memoryCandidates[0]?.category, "tooling");
});

test("parseAgentOutput parses tagged memory candidates wrapped in backticks", () => {
  const output = parseAgentOutput("scout", "## Memory Candidates\n- `project-fact: evgo is a Go monorepo for Evaluar microservices.`\n- `pattern: Pattern B to Pattern A migration requires a new ADR.`");
  assert.deepEqual(output.memoryCandidates.map((candidate) => candidate.category), ["project-fact", "pattern"]);
  assert.equal(output.memoryCandidates[0]?.confidence, 0.9);
  assert.doesNotMatch(output.memoryCandidates[0]?.content ?? "", /^`/);
});

test("parseAgentOutput ignores non-bullet memory blocks and None", () => {
  const codeOutput = parseAgentOutput("scout", "## Memory Candidates\ncmd = ['pi', '-e', 'src/index.ts']\nprint('--- stdout ---')");
  const noneOutput = parseAgentOutput("scout", "## Memory Candidates\n- None.");

  assert.equal(codeOutput.memoryCandidates.length, 0);
  assert.match(codeOutput.warnings.join("\n"), /no valid bullet candidates/);
  assert.equal(noneOutput.memoryCandidates.length, 0);
});

test("reviewerHandoffNeedsRepair detects blocking implementation review gaps", () => {
  const failing = parseAgentOutput("reviewer", "## Handoff\nVerdict: FAIL — implementation does not meet the adjacent-token requirement; add missing regression tests.");
  const passing = parseAgentOutput("reviewer", "## Handoff\nPASS — checked changed files, tests, and verification. No gaps remain.");
  const passingWithLowRiskGap = parseAgentOutput("reviewer", "## Handoff\n- Implementation matches the request.\n- Single low-risk gap: empty literal is not explicitly tested, not required by the user goal.\n- Verdict: PASS — make test exits 0.");
  const passingWithBlockingGap = parseAgentOutput("reviewer", "## Handoff\nVerdict: PASS — but a blocking gap remains: required parser behavior is missing.");
  const bugsWithoutVerdict = parseAgentOutput("reviewer", "## Handoff\n- 3 bugs found in the implementation.\n- Existing tests miss EOF comment and adjacent-token behavior.\n- make test passes but does not exercise these edge cases.");
  const noBugsFound = parseAgentOutput("reviewer", "## Handoff\nVerdict: PASS — checked changed files and verification. No bugs found, no blocking gaps remain.");
  const passWithPermanentCoverageGap = parseAgentOutput("reviewer", "## Handoff\n- Verdict: PASS — implementation works in ad-hoc checks.\n- Low-severity gap: permanent test suite could be expanded with escaped quotes and adjacency cases.");

  assert.equal(reviewerHandoffNeedsRepair({ agent: "reviewer", status: "complete", output: failing }), true);
  assert.equal(reviewerHandoffNeedsRepair({ agent: "reviewer", status: "complete", output: passing }), false);
  assert.equal(reviewerHandoffNeedsRepair({ agent: "reviewer", status: "complete", output: passingWithLowRiskGap }), false);
  assert.equal(reviewerHandoffNeedsRepair({ agent: "reviewer", status: "complete", output: passingWithBlockingGap }), true);
  assert.equal(reviewerHandoffNeedsRepair({ agent: "reviewer", status: "complete", output: bugsWithoutVerdict }), true);
  assert.equal(reviewerHandoffNeedsRepair({ agent: "reviewer", status: "complete", output: noBugsFound }), false);
  assert.equal(reviewerHandoffNeedsRepair({ agent: "reviewer", status: "complete", output: passWithPermanentCoverageGap }), true);
  assert.equal(reviewerHandoffNeedsRepair({ agent: "worker", status: "complete", output: failing }), false);
});

test("buildConflictResolverTask creates a bounded surgical conflict task", () => {
  const task = buildConflictResolverTask({
    agent: "worker-a",
    reason: "patch would not apply",
    patch: "diff --git a/a.txt b/a.txt\n+isolated writer change\n",
  });

  assert.match(task, /worker-a/);
  assert.match(task, /patch would not apply/);
  assert.match(task, /surgical/i);
  assert.match(task, /isolated writer change/);
  assert.match(task, /precise evidence and diffs/i);
});

test("MockWorkerRunner runs chain plans in order", async () => {
  const route: RouteDecision = {
    kind: "multi-agent-chain",
    agents: ["scout", "planner"],
    risk: "medium",
    ambiguity: "low",
    needsMemory: false,
    needsArtifacts: true,
    reason: "test",
    plan: { kind: "chain", steps: [{ agent: "scout", task: "scan" }, { agent: "planner", task: "plan" }] },
  };
  const run = await new MockWorkerRunner().run(route, { cwd: tempDir("pi-chalin-runner-"), agents: new Map() });
  assert.equal(run.status, "complete");
  assert.deepEqual(run.steps.map((step) => step.status), ["complete", "complete"]);
  assert.match(run.steps[1]?.output?.raw ?? "", /Previous handoff/);
});

test("MockWorkerRunner resumes reviewer FAIL/GAP with bounded repair cycles", async () => {
  const cwd = tempDir("pi-chalin-review-repair-chain-");
  const run = createRunState({
    kind: "multi-agent-chain",
    agents: ["worker", "reviewer"],
    risk: "medium",
    ambiguity: "low",
    needsMemory: false,
    needsArtifacts: true,
    reason: "implementation route",
    plan: { kind: "chain", steps: [{ agent: "worker", task: "implement" }, { agent: "reviewer", task: "review" }] },
  }, cwd, "Implement parser behavior and tests.");
  run.status = "paused";
  run.steps[0]!.status = "complete";
  run.steps[0]!.output = parseAgentOutput("worker", "## Handoff\nChanged: src/parser.c. Verification: `make test` exits 0.");
  run.steps[1]!.status = "complete";
  run.steps[1]!.output = parseAgentOutput("reviewer", "## Handoff\nVerdict: FAIL — tests miss EOF comments and adjacent-token behavior.");

  const resumed = await new MockWorkerRunner().resume(run, { cwd, agents: new Map() });

  assert.equal(resumed.status, "complete");
  assert.deepEqual(resumed.steps.map((step) => step.agent), ["worker", "reviewer", "worker", "reviewer"]);
  assert.equal(resumed.steps[2]?.id, "review-repair-1-worker");
  assert.equal(resumed.steps[3]?.id, "review-repair-1-reviewer");
  assert.match(resumed.steps[2]?.task ?? "", /Read only the changed implementation\/test files/i);
  assert.match(resumed.steps[3]?.task ?? "", /Previous reviewer findings/i);
  assert.match(resumed.warnings.join("\n"), /queued repair cycle 1\/2/i);
});

test("MockWorkerRunner repairs implementation routes that changed code without permanent tests", async () => {
  const cwd = tempDir("pi-chalin-review-permanent-tests-");
  const run = createRunState({
    kind: "multi-agent-chain",
    agents: ["worker", "reviewer"],
    risk: "medium",
    ambiguity: "low",
    needsMemory: false,
    needsArtifacts: true,
    reason: "implementation route",
    plan: { kind: "chain", steps: [{ agent: "worker", task: "implement" }, { agent: "reviewer", task: "review" }] },
  }, cwd, "Implement parser behavior and keep make test passing.");
  run.status = "paused";
  run.steps[0]!.status = "complete";
  run.steps[0]!.output = parseAgentOutput("worker", "## Handoff\nChanged: src/parser.c. Verification: `make test` exits 0.");
  run.steps[0]!.metrics = stepMetrics({ filesRead: ["src/parser.c", "tests/test_parser.c"], filesTouched: ["src/parser.c"] });
  run.steps[1]!.status = "complete";
  run.steps[1]!.output = parseAgentOutput("reviewer", "## Handoff\nVerdict: PASS — code and ad-hoc checks look good. `make test` exits 0.");
  run.steps[1]!.metrics = stepMetrics({ filesRead: ["src/parser.c", "tests/test_parser.c"] });

  const resumed = await new MockWorkerRunner().resume(run, { cwd, agents: new Map() });

  assert.equal(resumed.status, "complete");
  assert.deepEqual(resumed.steps.map((step) => step.agent), ["worker", "reviewer", "worker", "reviewer"]);
  assert.equal(resumed.steps[2]?.id, "review-repair-1-worker");
  assert.match(resumed.steps[2]?.task ?? "", /permanent runner-discoverable tests/i);
  assert.match(resumed.steps[2]?.task ?? "", /narrower step wording that prohibited tests/i);
  assert.match(resumed.warnings.join("\n"), /without permanent test coverage; queued repair cycle 1\/2/i);
});

test("MockWorkerRunner allows no-test implementation only when tests changed or user forbids them", async () => {
  const withTestEditCwd = tempDir("pi-chalin-review-tests-edited-");
  const withTestEdit = createRunState({
    kind: "multi-agent-chain",
    agents: ["worker", "reviewer"],
    risk: "medium",
    ambiguity: "low",
    needsMemory: false,
    needsArtifacts: true,
    reason: "implementation route",
    plan: { kind: "chain", steps: [{ agent: "worker", task: "implement" }, { agent: "reviewer", task: "review" }] },
  }, withTestEditCwd, "Implement parser behavior.");
  withTestEdit.status = "paused";
  withTestEdit.steps[0]!.status = "complete";
  withTestEdit.steps[0]!.output = parseAgentOutput("worker", "## Handoff\nChanged: src/parser.c, tests/test_parser.c. Verification: `make test` exits 0.");
  withTestEdit.steps[0]!.metrics = stepMetrics({ filesRead: ["src/parser.c", "tests/test_parser.c"], filesTouched: ["src/parser.c", "tests/test_parser.c"] });
  withTestEdit.steps[1]!.status = "complete";
  withTestEdit.steps[1]!.output = parseAgentOutput("reviewer", "## Handoff\nVerdict: PASS — implementation and permanent tests match the request.");
  withTestEdit.steps[1]!.metrics = stepMetrics({ filesRead: ["src/parser.c", "tests/test_parser.c"] });

  const resumedWithTestEdit = await new MockWorkerRunner().resume(withTestEdit, { cwd: withTestEditCwd, agents: new Map() });
  assert.deepEqual(resumedWithTestEdit.steps.map((step) => step.agent), ["worker", "reviewer"]);

  const forbiddenCwd = tempDir("pi-chalin-review-tests-forbidden-");
  const forbidden = createRunState({
    kind: "multi-agent-chain",
    agents: ["worker", "reviewer"],
    risk: "medium",
    ambiguity: "low",
    needsMemory: false,
    needsArtifacts: true,
    reason: "implementation route",
    plan: { kind: "chain", steps: [{ agent: "worker", task: "implement" }, { agent: "reviewer", task: "review" }] },
  }, forbiddenCwd, "Do not edit tests; implement the parser fix only.");
  forbidden.status = "paused";
  forbidden.steps[0]!.status = "complete";
  forbidden.steps[0]!.output = parseAgentOutput("worker", "## Handoff\nChanged: src/parser.c. Verification: `make test` exits 0.");
  forbidden.steps[0]!.metrics = stepMetrics({ filesRead: ["src/parser.c", "tests/test_parser.c"], filesTouched: ["src/parser.c"] });
  forbidden.steps[1]!.status = "complete";
  forbidden.steps[1]!.output = parseAgentOutput("reviewer", "## Handoff\nVerdict: PASS — implementation matches the no-test-edit constraint.");
  forbidden.steps[1]!.metrics = stepMetrics({ filesRead: ["src/parser.c", "tests/test_parser.c"] });

  const resumedForbidden = await new MockWorkerRunner().resume(forbidden, { cwd: forbiddenCwd, agents: new Map() });
  assert.deepEqual(resumedForbidden.steps.map((step) => step.agent), ["worker", "reviewer"]);
});

test("MockWorkerRunner fails instead of finalizing after repeated reviewer repair gaps", async () => {
  const cwd = tempDir("pi-chalin-review-repair-max-");
  const run = createRunState({
    kind: "multi-agent-chain",
    agents: ["worker", "reviewer", "worker", "reviewer", "worker", "reviewer"],
    risk: "medium",
    ambiguity: "low",
    needsMemory: false,
    needsArtifacts: true,
    reason: "implementation route",
    plan: {
      kind: "chain",
      steps: [
        { agent: "worker", task: "implement" },
        { agent: "reviewer", task: "review" },
        { agent: "worker", task: "repair once" },
        { agent: "reviewer", task: "review repair once" },
        { agent: "worker", task: "repair twice" },
        { agent: "reviewer", task: "review repair twice" },
      ],
    },
  }, cwd, "Implement parser behavior and tests.");
  const ids = ["step-1", "step-2", "review-repair-1-worker", "review-repair-1-reviewer", "review-repair-2-worker", "review-repair-2-reviewer"];
  run.status = "paused";
  run.steps.forEach((step, index) => {
    step.id = ids[index]!;
    step.status = "complete";
    step.output = parseAgentOutput(step.agent, step.agent === "reviewer"
      ? "## Handoff\nVerdict: FAIL — blocking gap remains: required parser behavior is missing."
      : "## Handoff\nChanged: src/parser.c. Verification: `make test` exits 0.");
  });

  const resumed = await new MockWorkerRunner().resume(run, { cwd, agents: new Map() });

  assert.equal(resumed.status, "failed");
  assert.equal(resumed.steps.at(-1)?.status, "failed");
  assert.match(resumed.steps.at(-1)?.error ?? "", /after 2 repair cycle/i);
  assert.match(resumed.warnings.join("\n"), /Stopping instead of finalizing incomplete routed implementation/i);
});

test("MockWorkerRunner queues reviewer repair stages for DAG implementation routes", async () => {
  const cwd = tempDir("pi-chalin-review-repair-dag-");
  const run = createRunState({
    kind: "multi-agent-dag",
    agents: ["worker", "reviewer"],
    risk: "medium",
    ambiguity: "low",
    needsMemory: false,
    needsArtifacts: true,
    reason: "dag implementation route",
    plan: {
      kind: "dag",
      stages: [
        { id: "implement", tasks: [{ agent: "worker", task: "implement" }] },
        { id: "review", tasks: [{ agent: "reviewer", task: "review" }] },
      ],
    },
  }, cwd, "Implement parser behavior and tests.");
  run.status = "paused";
  run.steps[0]!.status = "complete";
  run.steps[0]!.output = parseAgentOutput("worker", "## Handoff\nChanged: src/parser.c. Verification: `make test` exits 0.");
  run.steps[1]!.status = "complete";
  run.steps[1]!.output = parseAgentOutput("reviewer", "## Handoff\nVerdict: FAIL — coverage is insufficient for EOF comments.");

  const resumed = await new MockWorkerRunner().resume(run, { cwd, agents: new Map() });

  assert.equal(resumed.status, "complete");
  assert.deepEqual(resumed.route.plan?.kind === "dag" ? resumed.route.plan.stages.map((stage) => stage.id) : [], [
    "implement",
    "review",
    "review-repair-1-worker",
    "review-repair-1-reviewer",
  ]);
  assert.deepEqual(resumed.steps.map((step) => step.id), [
    "implement:step-1",
    "review:step-1",
    "review-repair-1-worker:step-1",
    "review-repair-1-reviewer:step-1",
  ]);
});

test("MockWorkerRunner stops promptly when Pi abort signal is raised", async () => {
  const previousDelay = process.env.PI_CHALIN_MOCK_STEP_DELAY_MS;
  process.env.PI_CHALIN_MOCK_STEP_DELAY_MS = "100";
  try {
    const route: RouteDecision = {
      kind: "multi-agent-chain",
      agents: ["scout", "planner"],
      risk: "medium",
      ambiguity: "low",
      needsMemory: false,
      needsArtifacts: true,
      reason: "test",
      plan: { kind: "chain", steps: [{ agent: "scout", task: "scan" }, { agent: "planner", task: "plan" }] },
    };
    const controller = new AbortController();
    const updates: string[] = [];
    const promise = new MockWorkerRunner().run(route, {
      cwd: tempDir("pi-chalin-runner-abort-"),
      agents: new Map(),
      signal: controller.signal,
      onUpdate: (run) => updates.push(run.status),
    });
    setTimeout(() => controller.abort(), 10);

    const run = await promise;

    assert.equal(run.status, "paused");
    assert.ok(run.steps.some((step) => step.status === "paused"));
    assert.match(run.warnings.join("\n"), /stopped by user/);
    assert.ok(updates.includes("paused"));
  } finally {
    if (previousDelay === undefined) delete process.env.PI_CHALIN_MOCK_STEP_DELAY_MS;
    else process.env.PI_CHALIN_MOCK_STEP_DELAY_MS = previousDelay;
  }
});

test("MockWorkerRunner persists in-flight run state for terminal/process recovery", async () => {
  const previousDelay = process.env.PI_CHALIN_MOCK_STEP_DELAY_MS;
  process.env.PI_CHALIN_MOCK_STEP_DELAY_MS = "100";
  try {
    const cwd = tempDir("pi-chalin-runner-live-persist-");
    const route: RouteDecision = {
      kind: "multi-agent-chain",
      agents: ["scout", "planner"],
      risk: "medium",
      ambiguity: "low",
      needsMemory: false,
      needsArtifacts: true,
      reason: "test recovery",
      plan: { kind: "chain", steps: [{ agent: "scout", task: "scan" }, { agent: "planner", task: "plan" }] },
    };
    const controller = new AbortController();
    const promise = new MockWorkerRunner().run(route, {
      cwd,
      agents: new Map(),
      signal: controller.signal,
    });

    await new Promise((resolve) => setTimeout(resolve, 20));
    const recoveredDuringRun = loadResumableRunState({ cwd });
    controller.abort();
    const finalRun = await promise;

    assert.equal(recoveredDuringRun?.status, "paused");
    assert.match(recoveredDuringRun?.warnings.join("\n") ?? "", /Recovered stale running run/);
    assert.ok(recoveredDuringRun?.steps.some((step) => step.status === "running" || step.status === "pending"));
    assert.equal(finalRun.status, "paused");
  } finally {
    if (previousDelay === undefined) delete process.env.PI_CHALIN_MOCK_STEP_DELAY_MS;
    else process.env.PI_CHALIN_MOCK_STEP_DELAY_MS = previousDelay;
  }
});

test("pi-chalin child sessions are stored outside Pi resume top-level index", async () => {
  const cwd = tempDir("pi-chalin-child-cwd-");
  const parentSessionDir = tempDir("pi-chalin-parent-sessions-");
  const parent = SessionManager.create(cwd, parentSessionDir);
  parent.appendMessage(userMessage("Implement a parent orchestrator task"));
  parent.appendMessage(assistantMessage("Parent orchestrator response"));
  const parentSessionFile = parent.getSessionFile();
  assert.ok(parentSessionFile);

  const step = { id: "step:1", agent: "worker", task: "implement", status: "pending" as const };
  const child = createChalinChildSessionManager({
    cwd,
    runId: "run-123",
    step,
    extensionContext: { sessionManager: parent },
  });
  child.appendMessage(userMessage("You are pi-chalin worker: Single-write implementation agent for approved scoped changes."));
  child.appendMessage(assistantMessage("Child worker response"));

  const topLevelSessions = await SessionManager.list(cwd, parentSessionDir);
  assert.deepEqual(topLevelSessions.map((session) => session.path), [parentSessionFile]);
  assert.equal(topLevelSessions.some((session) => session.firstMessage.includes("You are pi-chalin worker")), false);

  const childSessionDir = child.getSessionDir();
  const expectedChildRoot = path.join(parentSessionDir, path.basename(parentSessionFile, ".jsonl"), "pi-chalin", "run-123");
  assert.ok(childSessionDir.startsWith(expectedChildRoot + path.sep), childSessionDir);

  const nestedSessions = await SessionManager.list(cwd, childSessionDir);
  assert.equal(nestedSessions.length, 1);
  assert.equal(nestedSessions[0]?.parentSessionPath, parentSessionFile);
});

test("pi-chalin child session fallback stays in project-local hidden state", () => {
  const cwd = tempDir("pi-chalin-child-fallback-");
  const sessionDir = chalinChildSessionDir({
    cwd,
    runId: "run:with/spaces",
    stepId: "stage:2/reviewer",
    agent: "reviewer",
  });

  assert.equal(
    sessionDir,
    path.join(cwd, ".pi-chalin", "child-sessions", "run-with-spaces", "stage-2-reviewer-reviewer"),
  );
});

test("legacy top-level child sessions are hidden without moving parent sessions", async () => {
  const cwd = tempDir("pi-chalin-legacy-cwd-");
  const parentSessionDir = tempDir("pi-chalin-legacy-sessions-");
  const parent = SessionManager.create(cwd, parentSessionDir);
  parent.appendMessage(userMessage("Parent task visible in resume"));
  parent.appendMessage(assistantMessage("Parent response"));

  const legacyChild = SessionManager.create(cwd, parentSessionDir);
  legacyChild.appendMessage(userMessage("You are pi-chalin planner: Turns context into an implementation plan."));
  legacyChild.appendMessage(assistantMessage("Planner response"));
  const legacyChildFile = legacyChild.getSessionFile();
  assert.ok(legacyChildFile);

  const cleanup = await hideLegacyTopLevelChildSessions({ sessionManager: parent });
  assert.equal(cleanup.moved.length, 1);
  assert.equal(cleanup.failed.length, 0);
  assert.equal(fs.existsSync(legacyChildFile), false);
  assert.equal(fs.existsSync(cleanup.moved[0]!), true);

  const topLevelSessions = await SessionManager.list(cwd, parentSessionDir);
  assert.deepEqual(topLevelSessions.map((session) => session.firstMessage), ["Parent task visible in resume"]);
});

test("MockWorkerRunner prepares and cleans isolated worktrees for parallel writer routes", async () => {
  const cwd = tempDir("pi-chalin-runner-worktrees-");
  git(cwd, ["init"]);
  git(cwd, ["config", "user.email", "pi-chalin@example.com"]);
  git(cwd, ["config", "user.name", "pi-chalin"]);
  fs.writeFileSync(path.join(cwd, "a.txt"), "one\n");
  git(cwd, ["add", "."]);
  git(cwd, ["commit", "-m", "init"]);

  const route: RouteDecision = {
    kind: "multi-agent-parallel",
    agents: ["worker-a", "worker-b"],
    risk: "medium",
    ambiguity: "low",
    needsMemory: false,
    needsArtifacts: true,
    reason: "test",
    plan: { kind: "parallel", tasks: [{ agent: "worker-a", task: "edit a" }, { agent: "worker-b", task: "edit b" }] },
  };
  const agents = new Map([
    ["worker-a", agent("worker-a", ["inspect-files", "edit-files"])],
    ["worker-b", agent("worker-b", ["inspect-files", "write-new-files"])],
  ]);

  const run = await new MockWorkerRunner().run(route, { cwd, agents });

  assert.equal(run.status, "complete");
  assert.match(run.warnings.join("\n"), /worktree isolation active/i);
  assert.doesNotMatch(run.warnings.join("\n"), /gated|before real concurrent writes/i);
  assert.equal(git(cwd, ["branch", "--list", "pi-chalin/*"]), "");
});

test("MockWorkerRunner runs staged DAGs with parallel fan-out and downstream synthesis", async () => {
  const route: RouteDecision = {
    kind: "multi-agent-dag",
    agents: ["scout", "context-builder", "context-builder", "reviewer"],
    risk: "low",
    ambiguity: "low",
    needsMemory: false,
    needsArtifacts: true,
    reason: "test dag",
    plan: {
      kind: "dag",
      stages: [
        { id: "discover", tasks: [{ agent: "scout", task: "Map modules." }] },
        { id: "fanout", tasks: [{ agent: "context-builder", task: "Analyze auth." }, { agent: "context-builder", task: "Analyze billing." }] },
        { id: "review", tasks: [{ agent: "reviewer", task: "Synthesize final answer." }] },
      ],
    },
  };

  const run = await new MockWorkerRunner().run(route, { cwd: tempDir("pi-chalin-runner-dag-"), agents: new Map() });

  assert.equal(run.status, "complete");
  assert.deepEqual(run.steps.map((step) => step.status), ["complete", "complete", "complete", "complete"]);
  assert.match(run.steps[1]?.output?.raw ?? "", /Previous handoff/);
  assert.match(run.steps[2]?.output?.raw ?? "", /Previous handoff/);
  assert.match(run.steps[3]?.output?.raw ?? "", /context-builder/);
});

test("createRunState preserves single-plan budget metadata", () => {
  const route: RouteDecision = {
    kind: "single-agent",
    agents: ["scout"],
    risk: "low",
    ambiguity: "low",
    needsMemory: false,
    needsArtifacts: false,
    reason: "deep recon",
    plan: { kind: "single", agent: "scout", task: "Map project.", budget: "deep" },
  };

  const run = createRunState(route, tempDir("pi-chalin-single-budget-"));

  assert.equal(run.steps[0]?.budget, "deep");
});

test("MockWorkerRunner resumes paused DAG runs without rerunning completed steps", async () => {
  const cwd = tempDir("pi-chalin-runner-resume-dag-");
  const route: RouteDecision = {
    kind: "multi-agent-dag",
    agents: ["scout", "context-builder", "context-builder"],
    risk: "low",
    ambiguity: "low",
    needsMemory: false,
    needsArtifacts: true,
    reason: "test resume dag",
    plan: {
      kind: "dag",
      stages: [
        { id: "discover", tasks: [{ agent: "scout", task: "Map modules." }] },
        { id: "fanout", tasks: [{ agent: "context-builder", task: "Analyze auth." }, { agent: "context-builder", task: "Analyze billing." }] },
        { id: "synthesis", tasks: [{ agent: "context-builder", task: "Synthesize final answer." }] },
      ],
    },
  };
  const run = createRunState(route, cwd);
  run.steps[0]!.status = "complete";
  run.steps[0]!.startedAt = new Date().toISOString();
  run.steps[0]!.endedAt = new Date().toISOString();
  run.steps[0]!.output = { agent: "scout", text: "Scout handoff", handoff: "Scout mapped README and src.", memoryCandidates: [], raw: "Scout handoff", warnings: [] };
  for (const step of run.steps.slice(1)) {
    step.status = "paused";
    step.error = "pi-chalin run stopped by user.";
  }
  run.status = "paused";

  const resumed = await new MockWorkerRunner().resume(run, { cwd, agents: new Map() });

  assert.equal(resumed.id, run.id);
  assert.equal(resumed.status, "complete");
  assert.deepEqual(resumed.steps.map((step) => step.status), ["complete", "complete", "complete", "complete"]);
  assert.equal(resumed.steps[0]?.output?.handoff, "Scout mapped README and src.");
  assert.match(resumed.warnings.join("\n"), /Resumed paused pi-chalin run/);
  assert.match(fs.readFileSync(resumed.logsPath!, "utf-8"), /Synthesize final answer/);
});

test("loadResumableRunState recovers latest paused or stale running run from disk", () => {
  const cwd = tempDir("pi-chalin-resumable-load-");
  const paused = createRunState({
    kind: "multi-agent-chain",
    agents: ["scout", "reviewer"],
    risk: "low",
    ambiguity: "low",
    needsMemory: false,
    needsArtifacts: true,
    reason: "paused",
    plan: { kind: "chain", steps: [{ agent: "scout", task: "scan" }, { agent: "reviewer", task: "review" }] },
  }, cwd);
  paused.status = "paused";
  paused.steps[0]!.status = "complete";
  paused.steps[0]!.output = { agent: "scout", text: "done", handoff: "done", memoryCandidates: [], raw: "done", warnings: [] };
  paused.steps[1]!.status = "paused";
  fs.mkdirSync(path.dirname(paused.logsPath!), { recursive: true });
  fs.writeFileSync(paused.logsPath!, `${JSON.stringify(paused, null, 2)}\n`);

  const loaded = loadResumableRunState({ cwd });

  assert.equal(loaded?.id, paused.id);
  assert.equal(loaded?.status, "paused");

  const stale = createRunState(paused.route, cwd);
  stale.status = "running";
  stale.steps[0]!.status = "complete";
  stale.steps[0]!.output = { agent: "scout", text: "done", handoff: "done", memoryCandidates: [], raw: "done", warnings: [] };
  stale.steps[1]!.status = "running";
  fs.writeFileSync(stale.logsPath!, `${JSON.stringify(stale, null, 2)}\n`);

  const loadedStale = loadResumableRunState({ cwd, runId: stale.id });
  assert.equal(loadedStale?.status, "paused");
  assert.match(loadedStale?.warnings.join("\n") ?? "", /Recovered stale running run/);

  const completedStale = createRunState(paused.route, cwd);
  completedStale.status = "running";
  completedStale.steps[0]!.status = "complete";
  completedStale.steps[0]!.output = { agent: "scout", text: "done", handoff: "done", memoryCandidates: [], raw: "done", warnings: [] };
  completedStale.steps[1]!.status = "complete";
  completedStale.steps[1]!.output = { agent: "reviewer", text: "reviewed", handoff: "reviewed", memoryCandidates: [], raw: "reviewed", warnings: [] };
  fs.writeFileSync(completedStale.logsPath!, `${JSON.stringify(completedStale, null, 2)}\n`);

  const loadedCompletedStale = loadResumableRunState({ cwd, runId: completedStale.id });
  assert.equal(loadedCompletedStale?.status, "paused");
  assert.deepEqual(loadedCompletedStale?.steps.map((step) => step.status), ["complete", "complete"]);
});

test("prepareRunForResume resets interrupted work but keeps completed handoffs", () => {
  const cwd = tempDir("pi-chalin-prepare-resume-");
  const run = createRunState({
    kind: "multi-agent-chain",
    agents: ["scout", "reviewer"],
    risk: "low",
    ambiguity: "low",
    needsMemory: false,
    needsArtifacts: true,
    reason: "resume",
    plan: { kind: "chain", steps: [{ agent: "scout", task: "scan" }, { agent: "reviewer", task: "review" }] },
  }, cwd);
  run.status = "paused";
  run.endedAt = new Date().toISOString();
  run.steps[0]!.status = "complete";
  run.steps[0]!.output = { agent: "scout", text: "done", handoff: "done", memoryCandidates: [], raw: "done", warnings: [] };
  run.steps[1]!.status = "paused";
  run.steps[1]!.error = "stopped";
  run.steps[1]!.endedAt = new Date().toISOString();

  prepareRunForResume(run);

  assert.equal(run.status, "running");
  assert.equal(run.endedAt, undefined);
  assert.equal(run.steps[0]?.status, "complete");
  assert.equal(run.steps[1]?.status, "pending");
  assert.equal(run.steps[1]?.error, undefined);
});

test("SDK DAG can continue synthesis after a partial read-only fan-out idle stall", () => {
  const agents = new Map([
    ["context-builder", readOnlyAgent("context-builder")],
    ["reviewer", readOnlyAgent("reviewer", "review")],
  ]);

  const shouldStop = shouldStopAfterDagStage([
    { agent: "context-builder", status: "failed", error: "SDK runner idle stalled for context-builder after 90000ms without activity" },
    {
      agent: "context-builder",
      status: "complete",
      output: { agent: "context-builder", text: "Frontend mapped", handoff: "Frontend mapped.", memoryCandidates: [], raw: "", warnings: [] },
    },
    {
      agent: "reviewer",
      status: "complete",
      output: { agent: "reviewer", text: "Docs reviewed", handoff: "Docs reviewed.", memoryCandidates: [], raw: "", warnings: [] },
    },
  ], agents);

  assert.equal(shouldStop, false);
});

test("SDK child idle guard is based on idle time, not total wall-clock while a tool is active", async () => {
  let active = 1;
  const result = await runWithIdleStallMonitor(
    new Promise<string>((resolve) => setTimeout(() => {
      active = 0;
      resolve("finished");
    }, 55)),
    {
      idleStallMs: 20,
      pollMs: 5,
      message: "idle guard",
      activeOperations: () => active,
    },
  );

  assert.equal(result, "finished");
});

test("SDK child idle guard rejects when no tool or message activity occurs", async () => {
  await assert.rejects(
    runWithIdleStallMonitor(new Promise(() => undefined), {
      idleStallMs: 20,
      pollMs: 5,
      message: "idle guard",
      activeOperations: () => 0,
    }),
    /idle guard after 20ms without activity/,
  );
});

test("SDK child idle stall window defaults to 90s and uses only the idle-stall env knob", () => {
  const previousStall = process.env.PI_CHALIN_SDK_STEP_IDLE_STALL_MS;
  try {
    delete process.env.PI_CHALIN_SDK_STEP_IDLE_STALL_MS;
    assert.equal(sdkStepIdleStallMs(), DEFAULT_SDK_STEP_IDLE_STALL_MS);

    process.env.PI_CHALIN_SDK_STEP_IDLE_STALL_MS = "45000";
    assert.equal(sdkStepIdleStallMs(), 45_000);
  } finally {
    if (previousStall === undefined) delete process.env.PI_CHALIN_SDK_STEP_IDLE_STALL_MS;
    else process.env.PI_CHALIN_SDK_STEP_IDLE_STALL_MS = previousStall;
  }
});

test("SDK DAG stops after writer failures to avoid unsafe partial merges", () => {
  const agents = new Map([
    ["worker", agent("worker", ["inspect-files", "edit-files"])],
    ["reviewer", readOnlyAgent("reviewer", "review")],
  ]);

  const shouldStop = shouldStopAfterDagStage([
    { agent: "worker", status: "failed", error: "patch failed" },
    {
      agent: "reviewer",
      status: "complete",
      output: { agent: "reviewer", text: "Review done", handoff: "Review done.", memoryCandidates: [], raw: "", warnings: [] },
    },
  ], agents);

  assert.equal(shouldStop, true);
});

test("recovered read-only DAG failures do not poison the final run status", () => {
  const agents = new Map([
    ["context-builder", readOnlyAgent("context-builder")],
    ["reviewer", readOnlyAgent("reviewer", "review")],
  ]);
  const run: Pick<RunState, "steps"> = {
    steps: [
      { id: "discover:step-1", agent: "context-builder", task: "Map project.", status: "complete", output: { agent: "context-builder", text: "map", handoff: "map", memoryCandidates: [], raw: "", warnings: [] } },
      { id: "fanout:step-1", agent: "context-builder", task: "Analyze backend.", status: "failed", error: "SDK runner idle stalled for context-builder after 90000ms without activity" },
      { id: "fanout:step-2", agent: "context-builder", task: "Analyze UI.", status: "complete", output: { agent: "context-builder", text: "ui", handoff: "ui", memoryCandidates: [], raw: "", warnings: [] } },
      { id: "synthesis:step-1", agent: "context-builder", task: "Synthesize.", status: "complete", output: { agent: "context-builder", text: "final", handoff: "final", memoryCandidates: [], raw: "", warnings: [] } },
    ],
  };

  assert.equal(hasUnrecoverableFailedSteps(run, agents), false);
});

test("unrecovered read-only DAG failures remain failed until a downstream stage synthesizes", () => {
  const agents = new Map([["context-builder", readOnlyAgent("context-builder")]]);
  const run: Pick<RunState, "steps"> = {
    steps: [
      { id: "discover:step-1", agent: "context-builder", task: "Map project.", status: "complete", output: { agent: "context-builder", text: "map", handoff: "map", memoryCandidates: [], raw: "", warnings: [] } },
      { id: "fanout:step-1", agent: "context-builder", task: "Analyze backend.", status: "failed", error: "SDK runner idle stalled for context-builder after 90000ms without activity" },
      { id: "fanout:step-2", agent: "context-builder", task: "Analyze UI.", status: "complete", output: { agent: "context-builder", text: "ui", handoff: "ui", memoryCandidates: [], raw: "", warnings: [] } },
    ],
  };

  assert.equal(hasUnrecoverableFailedSteps(run, agents), true);
});

test("parseAgentOutput accepts richer memory categories for long-running work", () => {
  const output = parseAgentOutput("planner", "## Memory Candidates\n- testing: This project runs regression tests with bun:test and isolated temp directories, so feature tests should not share filesystem state.\n- workflow: Long-running chalin features should checkpoint handoffs and validation contracts after each stage so later agents can resume safely.");
  assert.deepEqual(output.memoryCandidates.map((candidate) => candidate.category), ["testing", "workflow"]);
});

test("parseAgentOutput preserves larger scout handoffs for downstream synthesis", () => {
  const longHandoff = `## Handoff\n${"Evidence path src/index.ts supports runtime entrypoint. ".repeat(45)}\n## Memory Candidates\n- None.`;
  const scout = parseAgentOutput("scout", longHandoff);
  const worker = parseAgentOutput("worker", longHandoff);
  assert.ok((scout.handoff?.length ?? 0) > 1800);
  assert.ok((worker.handoff?.length ?? 0) <= 1200);
});

test("buildSdkPrompt compresses repeated policy when previous handoff is available", () => {
  const agent: AgentDefinition = {
    name: "context-builder",
    scope: "built-in",
    concern: "context-building",
    capabilities: ["inspect-files", "search-files", "memory-read", "memory-write"],
    description: "Packages repo facts for the next agent.",
    model: "inherit",
    tools: [],
    memory: { read: true, write: "candidate", categories: [] },
    systemPrompt: "You are verbose.\n\nRules:\n- Keep facts.\n- Do not edit.\n\nTool discipline:\n- duplicated tool rule.\n\nStop condition:\n- duplicated stop.",
    diagnostics: [],
  };
  const prompt = buildSdkPrompt(agent, "Summarize scout handoff.", tempDir("pi-chalin-prompt-"), "Scout found package.json and src/index.ts.");
  assert.match(prompt, /Packages repo facts/);
  assert.match(prompt, /Previous Handoff/);
  assert.match(prompt, /Discovery index omitted/i);
  assert.doesNotMatch(prompt, /duplicated tool rule/);
  assert.ok(prompt.length < 6500, `prompt should stay compact, got ${prompt.length}`);
});

test("buildSdkPrompt injects compact memory context without bloating discovery", () => {
  const agent: AgentDefinition = {
    name: "worker",
    scope: "built-in",
    concern: "implementation",
    capabilities: ["inspect-files", "search-files", "memory-read", "memory-write"],
    description: "Implements scoped changes.",
    model: "inherit",
    tools: [],
    memory: { read: true, write: "candidate", categories: [] },
    systemPrompt: "",
    diagnostics: [],
  };
  const prompt = buildSdkPrompt(
    agent,
    "Fix async retry tests.",
    tempDir("pi-chalin-memory-prompt-"),
    undefined,
    80,
    "normal",
    { memoryContext: "Memory context (1 records, <=120 token budget). Treat as guidance; current repo evidence wins.\n- [memory-1 · testing · 95%] Project tests use Bun and avoid setTimeout sleeps." },
  );

  assert.match(prompt, /edit existing files; write new paths only/i);
  assert.match(prompt, /autonomous memory policy/i);
  assert.match(prompt, /Compact Memory Context/);
  assert.match(prompt, /Changed:/);
  assert.match(prompt, /Verification:/);
  assert.match(prompt, /exact implementation and test\/evidence source paths/i);
  assert.match(prompt, /Never write only local\/existing tests/i);
  assert.match(prompt, /derive the contract from prompt\+repo evidence/i);
  assert.match(prompt, /Tests are contract oracles/i);
  assert.match(prompt, /one boundary\/counterexample/i);
  assert.match(prompt, /preservation\/no-op\/composition paths/i);
  assert.match(prompt, /Preserve public compatibility/i);
  assert.match(prompt, /internal test seams or runner-native fake time/i);
  assert.match(prompt, /without expanding public APIs/i);
  assert.match(prompt, /Bun `setSystemTime`/i);
  assert.match(prompt, /scoped Date\.now restore/i);
  assert.match(prompt, /ad hoc sleeps/i);
  assert.match(prompt, /Code behavior changes update nearest tests/i);
  assert.match(prompt, /Coverage breadth/i);
  assert.match(prompt, /separate compact tests per rule/i);
  assert.match(prompt, /evidence-only tests/i);
  assert.match(prompt, /runner-discoverable cases/i);
  assert.match(prompt, /zero-test assertion scripts/i);
  assert.doesNotMatch(prompt, /Scaffold\/package work/i);
  assert.doesNotMatch(prompt, /Parser\/scanner\/state-machine changes/i);
  assert.doesNotMatch(prompt, /Sorting\/normalization contracts/i);
  assert.doesNotMatch(prompt, /Normalization\/key APIs need 8-12/i);
  assert.match(prompt, /resource escape hatches/i);
  assert.match(prompt, /arbitrary fixed caps/i);
  assert.match(prompt, /small evidence/i);
  assert.match(prompt, /one impl\/test edit/i);
  assert.match(prompt, /avoid micro-edits/i);
  assert.match(prompt, /smallest exact block/i);
  assert.match(prompt, /one corrective edit\/fail/i);
  assert.match(prompt, /After pass, one readback/i);
  assert.match(prompt, /exact named command/i);
  assert.match(prompt, /Project tests use Bun/);
  assert.ok(prompt.length < 7000, `prompt should stay compact, got ${prompt.length}`);
});

test("buildSdkPrompt loads domain contracts only when the implementation surface needs them", () => {
  const agent: AgentDefinition = {
    name: "worker",
    scope: "built-in",
    concern: "implementation",
    capabilities: ["inspect-files", "search-files", "edit-files", "run-safe-bash", "validate"],
    description: "Implements scoped changes.",
    model: "inherit",
    tools: [],
    memory: { read: false, write: "never", categories: [] },
    systemPrompt: "",
    diagnostics: [],
  };

  const scaffoldPrompt = buildSdkPrompt(agent, "Scaffold a TypeScript CLI package with bin, README, build, and tests.", tempDir("pi-chalin-scaffold-contract-"));
  assert.match(scaffoldPrompt, /Scaffold\/package work/i);
  assert.match(scaffoldPrompt, /runner's discoverable API/i);
  assert.match(scaffoldPrompt, /real command path/i);
  assert.match(scaffoldPrompt, /args\/no-input/i);
  assert.doesNotMatch(scaffoldPrompt, /Parser\/scanner\/state-machine changes/i);

  const parserPrompt = buildSdkPrompt(agent, "Fix SQL tokenizer string literal comments, delimiter adjacency, and EOF behavior.", tempDir("pi-chalin-parser-contract-"));
  assert.match(parserPrompt, /Parser\/scanner\/state-machine changes follow repo grammar evidence/i);
  assert.match(parserPrompt, /EOF\/error behavior/i);
  assert.match(parserPrompt, /adjacency before and after non-whitespace must be tested as separation/i);
  assert.match(parserPrompt, /Permanent repo tests must cover changed transitions/i);
  assert.doesNotMatch(parserPrompt, /Scaffold\/package work/i);
});

test("buildSdkPrompt preserves the original user goal across routed step prompts", () => {
  const agent: AgentDefinition = {
    name: "worker",
    scope: "built-in",
    concern: "implementation",
    capabilities: ["inspect-files", "search-files", "edit-files"],
    description: "Implements scoped changes.",
    model: "inherit",
    tools: [],
    memory: { read: false, write: "never", categories: [] },
    systemPrompt: "",
    diagnostics: [],
  };
  const prompt = buildSdkPrompt(
    agent,
    "Update the docs artifact with the requested fields.",
    tempDir("pi-chalin-root-task-prompt-"),
    "Scout found a neighboring identity issue.",
    25,
    "tight",
    { rootTask: "Analyze duplicate packages when workspace paths mix Windows/POSIX separators. Do not change code." },
  );

  assert.match(prompt, /Original User Goal/);
  assert.match(prompt, /workspace paths mix Windows\/POSIX separators/i);
  assert.match(prompt, /Original User Goal below is the contract/i);
  assert.match(prompt, /preserve the user's exact failure trigger/i);
});

test("buildSdkPrompt puts context-builder into handoff-first gap-read mode", () => {
  const agent: AgentDefinition = {
    name: "context-builder",
    scope: "built-in",
    concern: "context-building",
    capabilities: ["inspect-files", "search-files", "memory-read", "memory-write"],
    description: "Packages repo facts for the next agent.",
    model: "inherit",
    tools: [],
    memory: { read: true, write: "candidate", categories: [] },
    systemPrompt: "",
    diagnostics: [],
  };

  const prompt = buildSdkPrompt(
    agent,
    "A partir del handoff del scout, sintetiza qué hace el proyecto en profundidad.",
    tempDir("pi-chalin-gap-read-prompt-"),
    "Coverage Matrix: runtime covered with evidence in src/index.ts.",
    120,
    "deep",
    { priorFilesRead: ["package.json", "src/index.ts"], synthesisGapReadLimit: 7 },
  );

  assert.match(prompt, /Handoff-first synthesis/i);
  assert.match(prompt, /at most 7 gap reads/i);
  assert.match(prompt, /Already Covered Evidence Paths/);
  assert.match(prompt, /src\/index\.ts/);
  assert.match(prompt, /primary evidence map/i);
  assert.match(prompt, /Context handoff completeness/i);
  assert.match(prompt, /follow imports, callers, tests, fixtures, config, docs, and adjacent patterns/i);
  assert.match(prompt, /do not omit a domain-critical file\/source just to keep the handoff short/i);
});

test("buildSdkPrompt puts reviewer into sampled audit mode after handoff", () => {
  const agent: AgentDefinition = {
    name: "reviewer",
    scope: "built-in",
    concern: "review",
    capabilities: ["inspect-files", "search-files", "validate"],
    description: "Reviews synthesized repo facts.",
    model: "inherit",
    tools: [],
    memory: { read: false, write: "never", categories: [] },
    systemPrompt: "",
    diagnostics: [],
  };

  const prompt = buildSdkPrompt(
    agent,
    "Review risks/gaps in this deep project analysis.",
    tempDir("pi-chalin-review-gap-prompt-"),
    "Coverage Matrix: runtime covered with evidence in nuxt.config.js; auth covered in middleware/auth.js.",
    120,
    "deep",
    { priorFilesRead: ["nuxt.config.js", "middleware/auth.js"], synthesisGapReadLimit: 5 },
  );

  assert.match(prompt, /Handoff-first review/i);
  assert.match(prompt, /sample only the highest-risk/i);
  assert.match(prompt, /re-read the exact covered file or region once/i);
  assert.match(prompt, /at most 5 gap reads/i);
  assert.match(prompt, /Already Covered Evidence Paths/);
  assert.match(prompt, /middleware\/auth\.js/);
});

test("buildSdkPrompt gives implementation workers a preserved-value sorting contract", () => {
  const agent: AgentDefinition = {
    name: "worker",
    scope: "built-in",
    concern: "implementation",
    capabilities: ["inspect-files", "edit-files", "run-safe-bash", "validate"],
    description: "Implements bounded changes.",
    model: "inherit",
    tools: [],
    memory: { read: false, write: "never", categories: [] },
    systemPrompt: "",
    diagnostics: [],
  };

  const prompt = buildSdkPrompt(
    agent,
    "Implement a deterministic key builder that sorts markers while preserving case and duplicates.",
    tempDir("pi-chalin-impl-sort-contract-"),
    undefined,
    80,
    "normal",
    { rootTask: "Sort markers, preserve case and duplicates, and cover it with tests." },
  );

  assert.match(prompt, /Sorting\/normalization contracts/i);
  assert.match(prompt, /language's normal lexicographic\/ordinal comparison/i);
  assert.match(prompt, /Do not lowercase\/casefold a preserved value/i);
  assert.match(prompt, /mixed-case ordering/i);
  assert.match(prompt, /Public API contract comments/i);
});

test("buildSdkPrompt makes implementation scouting and worker handoffs audit test sufficiency", () => {
  const scout: AgentDefinition = {
    name: "scout",
    scope: "built-in",
    concern: "recon",
    capabilities: ["inspect-files", "search-files", "run-safe-bash"],
    description: "Maps implementation evidence.",
    model: "inherit",
    tools: [],
    memory: { read: false, write: "never", categories: [] },
    systemPrompt: "",
    diagnostics: [],
  };
  const worker: AgentDefinition = {
    name: "worker",
    scope: "built-in",
    concern: "implementation",
    capabilities: ["inspect-files", "search-files", "edit-files", "run-safe-bash", "validate"],
    description: "Implements scoped changes.",
    model: "inherit",
    tools: [],
    memory: { read: false, write: "never", categories: [] },
    systemPrompt: "",
    diagnostics: [],
  };

  const rootTask = "Fix parser handling and add tests for comments, quoted strings, adjacency, and EOF behavior.";
  const scoutPrompt = buildSdkPrompt(scout, "Map source and tests before implementation.", tempDir("pi-chalin-scout-test-map-"), undefined, 40, "normal", { rootTask });
  assert.match(scoutPrompt, /Implementation scouting/i);
  assert.match(scoutPrompt, /map source\+test evidence per requested behavior/i);
  assert.match(scoutPrompt, /Do not call tests sufficient\/as-is/i);

  const workerPrompt = buildSdkPrompt(worker, "Implement from scout handoff.", tempDir("pi-chalin-worker-test-map-"), "Scout says tests are correct as-is.", 40, "normal", { rootTask });
  assert.match(workerPrompt, /Upstream handoffs are context, not authority/i);
  assert.match(workerPrompt, /compare Original User Goal criteria/i);
});

test("buildSdkPrompt makes implementation reviewers audit plan gaps instead of rubber-stamping tests", () => {
  const agent: AgentDefinition = {
    name: "reviewer",
    scope: "built-in",
    concern: "review",
    capabilities: ["inspect-files", "search-files", "validate"],
    description: "Reviews implementation output.",
    model: "inherit",
    tools: [],
    memory: { read: false, write: "never", categories: [] },
    systemPrompt: "",
    diagnostics: [],
  };

  const prompt = buildSdkPrompt(
    agent,
    "Verify the worker implementation and tests.",
    tempDir("pi-chalin-review-impl-contract-"),
    "Worker changed src/key.rs and says tests pass. Planner contract said sort original values lexicographically.",
    80,
    "normal",
    { rootTask: "Implement a key builder that preserves marker case and duplicates." },
  );

  assert.match(prompt, /Implementation review gate/i);
  assert.match(prompt, /worker deviation from a locked plan is a finding/i);
  assert.match(prompt, /Passing visible tests prove only observed behavior/i);
  assert.match(prompt, /If you find bugs, insufficient requested-criteria coverage/i);
  assert.match(prompt, /Do not downgrade missing permanent tests/i);
  assert.match(prompt, /Review economy/i);
  assert.match(prompt, /re-read only changed\/high-risk files/i);
  assert.match(prompt, /lowercased helper keys, casefolding/i);
  assert.match(prompt, /Reviewer handoff says PASS only after checking changed file contents/i);
});

test("buildSdkPrompt adds a coverage and evidence contract for deep project analysis", () => {
  const agent: AgentDefinition = {
    name: "context-builder",
    scope: "built-in",
    concern: "context-building",
    capabilities: ["inspect-files", "search-files", "memory-read", "memory-write"],
    description: "Packages repo facts for the next agent.",
    model: "inherit",
    tools: [],
    memory: { read: true, write: "candidate", categories: [] },
    systemPrompt: "",
    diagnostics: [],
  };

  const prompt = buildSdkPrompt(
    agent,
    "Revisa este proyecto en profundidad y sintetiza qué hace, módulos, riesgos y cómo se testea.",
    tempDir("pi-chalin-deep-analysis-prompt-"),
    undefined,
    120,
    "deep",
  );

  assert.match(prompt, /Deep project analysis accuracy contract/i);
  assert.match(prompt, /Coverage Matrix/i);
  assert.match(prompt, /Evidence Table/i);
  assert.match(prompt, /tests\/evals\/tooling/i);
  assert.match(prompt, /claim.+evidence/i);
});

test("childToolNames removes inspection tools for handoff-only synthesis steps", () => {
  const agent: AgentDefinition = {
    name: "context-builder",
    scope: "built-in",
    concern: "context-building",
    capabilities: ["inspect-files", "search-files", "memory-read", "memory-write"],
    description: "Synthesize context.",
    model: "inherit",
    tools: [],
    memory: { read: true, write: "candidate", categories: [] },
    systemPrompt: "",
    diagnostics: [],
  };

  assert.deepEqual(childToolNames(agent, "Synthesize scout findings into final answer material.", true, true), []);
  assert.ok(childToolNames(agent, "Save a checkpoint for this long-running feature.", true, true, { budgetProfile: "extended" }).includes("chalin_artifact_write"));
});

test("childToolNames keeps inspection tools for deep synthesis with possible coverage gaps", () => {
  const agent: AgentDefinition = {
    name: "context-builder",
    scope: "built-in",
    concern: "context-building",
    capabilities: ["inspect-files", "search-files", "memory-read", "memory-write"],
    description: "Synthesize context.",
    model: "inherit",
    tools: [],
    memory: { read: true, write: "candidate", categories: [] },
    systemPrompt: "",
    diagnostics: [],
  };

  const tools = childToolNames(agent, "Synthesize deep project analysis in-depth into final answer material.", true, true, { budgetProfile: "deep" });

  assert.ok(tools.includes("read"));
  assert.ok(tools.includes("grep"));
  assert.ok(tools.includes("find"));
  assert.ok(tools.includes("ls"));
});

test("childToolNames exposes autonomous memory tools only to memory-capable agents", () => {
  const memoryAgent: AgentDefinition = {
    name: "worker",
    scope: "built-in",
    concern: "implementation",
    capabilities: ["inspect-files", "search-files", "memory-read", "memory-write"],
    description: "Memory capable.",
    model: "inherit",
    tools: [],
    memory: { read: true, write: "candidate", categories: [] },
    systemPrompt: "",
    diagnostics: [],
  };
  const noMemoryAgent: AgentDefinition = { ...memoryAgent, capabilities: ["inspect-files", "search-files"], memory: { read: false, write: "never", categories: [] } };

  const memoryTools = childToolNames(memoryAgent, "Implement feature with prior project rules.", true, false);
  assert.ok(memoryTools.includes("chalin_memory_search"));
  assert.ok(memoryTools.includes("chalin_memory_write"));
  assert.ok(memoryTools.includes("chalin_memory_revise"));
  assert.equal(childToolNames(noMemoryAgent, "Implement feature.", true, false).some((tool) => tool.startsWith("chalin_memory_")), false);
});

test("childToolNames exposes nested delegation only to coordinating subagents below depth limit", () => {
  const worker: AgentDefinition = {
    name: "worker",
    scope: "built-in",
    concern: "implementation",
    capabilities: ["inspect-files", "search-files", "edit-files", "coordinate"],
    description: "Coordinating worker.",
    model: "inherit",
    tools: [],
    memory: { read: false, write: "never", categories: [] },
    systemPrompt: "",
    diagnostics: [],
  };
  const noCoordinate: AgentDefinition = { ...worker, capabilities: ["inspect-files", "search-files", "edit-files"] };

  assert.ok(childToolNames(worker, "Implement broad change.", true, false, { delegationDepth: 1, maxDelegationDepth: 2 }).includes("chalin_delegate"));
  assert.equal(childToolNames(worker, "Implement broad change.", true, false, { delegationDepth: 2, maxDelegationDepth: 2 }).includes("chalin_delegate"), false);
  assert.equal(childToolNames(worker, "Synthesize previous handoff.", true, true, { delegationDepth: 1, maxDelegationDepth: 2 }).includes("chalin_delegate"), false);
  assert.equal(childToolNames(noCoordinate, "Implement broad change.", true, false, { delegationDepth: 1, maxDelegationDepth: 2 }).includes("chalin_delegate"), false);
  assert.equal(childToolNames(worker, "Implement focused change.", true, false, { budgetProfile: "normal" }).includes("chalin_artifact_write"), false);
  assert.equal(childToolNames(worker, "Implement long checkpointed change.", true, false, { budgetProfile: "extended" }).includes("chalin_artifact_write"), true);
});

test("childToolNames respects route-level memory gating", () => {
  const memoryAgent: AgentDefinition = {
    name: "scout",
    scope: "built-in",
    concern: "recon",
    capabilities: ["inspect-files", "search-files", "memory-read", "memory-write"],
    description: "Memory capable scout.",
    model: "inherit",
    tools: [],
    memory: { read: true, write: "candidate", categories: [] },
    systemPrompt: "",
    diagnostics: [],
  };

  const tools = childToolNames(memoryAgent, "Map project.", false, false, { memoryEnabled: false });

  assert.equal(tools.some((tool) => tool.startsWith("chalin_memory_")), false);
  assert.ok(tools.includes("chalin_project_discovery"));
});

test("childToolNames exposes discovery plus snapshot for recon without semantic branch classification", () => {
  const agent: AgentDefinition = {
    name: "scout",
    scope: "built-in",
    concern: "recon",
    capabilities: ["inspect-files", "search-files", "memory-read", "memory-write"],
    description: "Recon.",
    model: "inherit",
    tools: [],
    memory: { read: true, write: "candidate", categories: [] },
    systemPrompt: "",
    diagnostics: [],
  };

  const tools = childToolNames(agent, "Inspect current git branch, status, recent commits, and diff against base.", false, false);
  assert.ok(tools.includes("chalin_project_discovery"));
  assert.ok(tools.includes("chalin_project_snapshot"));
  assert.ok(tools.includes("read"));
  assert.ok(tools.includes("grep"));
});


test("resolveAgentModel records fallback attempts and selects next configured candidate", () => {
  const candidate = { provider: "openai", id: "gpt-5-mini" };
  const registry = {
    find(provider: string, id: string) {
      if (provider === "openai" && id === "gpt-5-mini") return candidate;
      return undefined;
    },
    hasConfiguredAuth(model: { provider: string; id: string }) {
      return model.id === "gpt-5-mini";
    },
  };
  const agentDef = agent("reviewer", ["inspect-files"]);
  agentDef.model = "anthropic/missing-model";

  const resolved = resolveAgentModel(agentDef, "reviewer", {
    cwd: tempDir("pi-chalin-model-resolution-"),
    agents: new Map(),
    modelOverrides: { "tier/balanced": "openai/gpt-5-mini" },
    extensionContext: { model: { provider: "openai", id: "fallback-active" }, modelRegistry: registry } as never,
  });

  assert.equal(resolved.label, "openai/gpt-5-mini");
  assert.equal(resolved.resolution.selected, "openai/gpt-5-mini");
  assert.ok(resolved.resolution.attempts.some((attempt) => attempt.status === "unavailable" && attempt.ref === "anthropic/missing-model"));
  assert.ok(resolved.warnings.some((warning) => /model fallback/i.test(warning)));
});

test("resolveAgentModel lets evals force child agent model over local overrides", () => {
  const forced = { provider: "openai-codex", id: "gpt-5.5" };
  const registry = {
    find(provider: string, id: string) {
      if (provider === forced.provider && id === forced.id) return forced;
      return undefined;
    },
    hasConfiguredAuth(model: { provider: string; id: string }) {
      return model.id === forced.id;
    },
  };
  const previous = process.env.PI_CHALIN_EVAL_AGENT_MODEL;
  process.env.PI_CHALIN_EVAL_AGENT_MODEL = "openai-codex/gpt-5.5";
  try {
    const resolved = resolveAgentModel(agent("worker", ["inspect-files"]), "worker", {
      cwd: tempDir("pi-chalin-model-force-"),
      agents: new Map(),
      modelOverrides: { worker: "opencode/kimi-k2.6" },
      extensionContext: { model: { provider: "openai", id: "fallback-active" }, modelRegistry: registry } as never,
    });

    assert.equal(resolved.label, "openai-codex/gpt-5.5");
    assert.equal(resolved.resolution.attempts[0]?.ref, "openai-codex/gpt-5.5");
  } finally {
    if (previous === undefined) delete process.env.PI_CHALIN_EVAL_AGENT_MODEL;
    else process.env.PI_CHALIN_EVAL_AGENT_MODEL = previous;
  }
});

test("resolveInheritedModelFallback switches any subagent runtime provider failure to active inherited model", () => {
  const active = { provider: "openai", id: "gpt-5.5" };
  const override = { provider: "opencode", id: "kimi-k2.6" };
  const registry = {
    find(provider: string, id: string) {
      if (provider === active.provider && id === active.id) return active;
      if (provider === override.provider && id === override.id) return override;
      return undefined;
    },
    hasConfiguredAuth() {
      return true;
    },
  };

  for (const agentName of ["scout", "reviewer", "worker"]) {
    const resolved = resolveAgentModel(agent(agentName, ["inspect-files"]), agentName, {
      cwd: tempDir(`pi-chalin-runtime-model-fallback-${agentName}-`),
      agents: new Map(),
      modelOverrides: { [agentName]: "opencode/kimi-k2.6" },
      extensionContext: { model: active, modelRegistry: registry } as never,
    });

    const fallback = resolveInheritedModelFallback(resolved, agentName, {
      cwd: tempDir(`pi-chalin-runtime-model-fallback-inherit-${agentName}-`),
      agents: new Map(),
      extensionContext: { model: active, modelRegistry: registry } as never,
    }, "401 Insufficient balance");

    assert.ok(fallback);
    assert.equal(fallback.model, active);
    assert.equal(fallback.resolution.selected, "openai/gpt-5.5");
    assert.ok(fallback.resolution.attempts.some((attempt) => attempt.status === "runtime-error" && attempt.model === "opencode/kimi-k2.6"));
    assert.equal(fallback.resolution.attempts.at(-1)?.source, "inherit");
    assert.match(fallback.warnings.join("\n"), new RegExp(`runtime fallback for ${agentName}`, "i"));
  }
});

test("extractAssistantRuntimeError detects structural SDK provider errors", () => {
  const error = extractAssistantRuntimeError([
    { role: "user", content: "Task" },
    { role: "assistant", content: [], stopReason: "error", errorMessage: "401 Insufficient balance" },
  ]);

  assert.equal(error, "401 Insufficient balance");
});

test("resolveAgentThinking uses overrides, agent defaults, and model suffixes", () => {
  const agentDef = agent("reviewer", ["inspect-files"]);
  agentDef.model = "openai/gpt-5-mini:high";
  agentDef.thinking = "medium";

  const modelSuffix = resolveAgentThinking({ ...agentDef, thinking: "inherit" }, "reviewer", {
    cwd: tempDir("pi-chalin-thinking-suffix-"),
    agents: new Map(),
  }, {
    selected: "openai/gpt-5-mini",
    tier: "balanced",
    attempts: [{ source: "agent", ref: "openai/gpt-5-mini:high", status: "selected", model: "openai/gpt-5-mini" }],
  });
  const agentDefault = resolveAgentThinking(agentDef, "reviewer", { cwd: tempDir("pi-chalin-thinking-agent-"), agents: new Map() });
  const override = resolveAgentThinking(agentDef, "reviewer", {
    cwd: tempDir("pi-chalin-thinking-override-"),
    agents: new Map(),
    thinkingOverrides: { "built-in/reviewer": "xhigh" },
  });

  assert.equal(modelSuffix.level, "high");
  assert.equal(agentDefault.level, "medium");
  assert.equal(override.level, "xhigh");
});

test("normalizeThinkingForBudget avoids upward SDK clamps for efficient evidence work", () => {
  const deepseekLikeModel = {
    reasoning: true,
    thinkingLevelMap: { minimal: null, low: null, medium: null, high: "high", xhigh: "max" },
  };
  const scout = agent("scout", ["inspect-files"]);
  scout.concern = "recon";
  const contextBuilder = agent("context-builder", ["inspect-files"]);
  contextBuilder.concern = "context-building";
  const worker = agent("worker", ["edit-files"]);
  worker.concern = "implementation";

  const scoutThinking = normalizeThinkingForBudget({ level: "low", label: "low" }, "normal", {
    agent: scout,
    model: deepseekLikeModel as never,
  });
  const synthesisThinking = normalizeThinkingForBudget({ level: "medium", label: "medium" }, "deep", {
    agent: contextBuilder,
    hasPrevious: true,
    model: deepseekLikeModel as never,
  });
  const implementationThinking = normalizeThinkingForBudget({ level: "high", label: "high" }, "deep", {
    agent: worker,
    model: deepseekLikeModel as never,
  });
  const normalWorkerThinking = normalizeThinkingForBudget({ level: "high", label: "high" }, "normal", {
    agent: worker,
    model: {
      reasoning: true,
      thinkingLevelMap: { minimal: null, low: null, medium: "medium", high: "high", xhigh: "max" },
    } as never,
  });
  const unsupportedNormalWorkerThinking = normalizeThinkingForBudget({ level: "high", label: "high" }, "normal", {
    agent: worker,
    model: deepseekLikeModel as never,
  });

  assert.equal(scoutThinking.level, "off");
  assert.equal(synthesisThinking.level, "off");
  assert.equal(implementationThinking.level, "high");
  assert.equal(normalWorkerThinking.level, "medium");
  assert.equal(unsupportedNormalWorkerThinking.level, "high");
});


test("toolBudgetForStep supports LLM-chosen profiles and deep DAG defaults", () => {
  const contextAgent: AgentDefinition = {
    name: "context-builder",
    scope: "built-in",
    concern: "context-building",
    capabilities: ["inspect-files", "search-files"],
    description: "Context builder",
    model: "inherit",
    tools: [],
    memory: { read: true, write: "candidate", categories: [] },
    systemPrompt: "",
    diagnostics: [],
  };

  assert.equal(toolBudgetForStep(contextAgent, { agent: "context-builder", task: "Summarize bounded handoff.", budget: "tight" }, "multi-agent-chain"), 30);
  assert.equal(toolBudgetForStep(contextAgent, { agent: "context-builder", task: "Analyze one module." }, "multi-agent-chain"), 60);
  assert.equal(toolBudgetForStep(contextAgent, { agent: "context-builder", task: "Analyze folder deeply." }, "multi-agent-dag"), 120);
  assert.equal(toolBudgetForStep(contextAgent, { agent: "context-builder", task: "Long autonomous stage with checkpoints.", budget: "extended" }, "multi-agent-dag"), 240);
});

test("budgetPolicyForSdkStep keeps deep recon surface-complete instead of file-exhaustive", () => {
  const scout = readOnlyAgent("scout", "recon");
  const base = policyForStep(scout, { agent: "scout", task: "Map the whole project.", budget: "deep" }, "single-agent", "low");
  const sdk = budgetPolicyForSdkStep(base, scout);

  assert.equal(base.caps.maxToolCalls, 80);
  assert.equal(sdk.caps.maxToolCalls, 12);
  assert.equal(sdk.caps.maxTurns, 5);
  assert.equal(sdk.caps.maxReadBytes, 260_000);
  assert.match(sdk.id, /surface-recon/);
});

test("buildSdkPrompt tells deep recon to cover surfaces without exhaustive crawling", () => {
  const scout = readOnlyAgent("scout", "recon");
  const policy = budgetPolicyForSdkStep(policyForStep(scout, { agent: "scout", task: "Map the project.", budget: "deep" }, "single-agent", "low"), scout);
  const prompt = buildSdkPrompt(scout, "Map the project.", tempDir("prompt-recon-"), undefined, policy);

  assert.match(prompt, /Deep recon is surface-complete, not file-exhaustive/);
  assert.match(prompt, /Coverage means representative evidence per surface/);
  assert.match(prompt, /cite full relative paths from the repo root/);
  assert.match(prompt, /preserve exact runnable commands discovered in README/);
  assert.match(prompt, /report them as runnable invocations/);
});

test("resolveStepCompletionStatus turns budget-capped SDK stops into checkpointed handoffs", () => {
  const useful = resolveStepCompletionStatus({
    metrics: {
      durationMs: 100,
      usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      toolCalls: 60,
      toolCallsByName: { read: 60 },
      budgetStopCount: 1,
    },
    output: {
      agent: "scout",
      text: "Project finding: the repository uses TypeScript modules and tests in test/*.test.ts; next step should review src/runner.ts budget handling with file-level evidence.",
      handoff: "Project finding: review src/runner.ts and src/budget.ts because budget policy controls subagent autonomy and checkpoint behavior.",
      memoryCandidates: [],
      raw: "",
      warnings: [],
    },
  });

  const empty = resolveStepCompletionStatus({
    metrics: {
      durationMs: 100,
      usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      toolCalls: 60,
      toolCallsByName: { read: 60 },
      budgetStopCount: 1,
    },
    output: { agent: "scout", text: "done", memoryCandidates: [], raw: "done", warnings: [] },
  });

  assert.equal(useful, "complete");
  assert.equal(empty, "checkpointed");
});

test("loadResumableRunState normalizes legacy budget-capped steps at the storage edge", () => {
  const cwd = tempDir("legacy-budget-run-");
  const runId = "chalin-legacy-budget";
  const runsDir = path.join(cwd, ".pi-chalin", "runs");
  fs.mkdirSync(runsDir, { recursive: true });
  fs.writeFileSync(path.join(runsDir, `${runId}.json`), JSON.stringify({
    id: runId,
    route: {
      kind: "multi-agent-chain",
      agents: ["scout", "worker"],
      risk: "low",
      ambiguity: "low",
      needsMemory: false,
      needsArtifacts: true,
      reason: "legacy budget checkpoint",
      plan: { kind: "chain", steps: [
        { agent: "scout", task: "Map", budget: "tight" },
        { agent: "worker", task: "Implement", budget: "normal" },
      ] },
    },
    status: "paused",
    startedAt: new Date().toISOString(),
    warnings: [],
    steps: [
      {
        id: "step-1",
        agent: "scout",
        task: "Map",
        status: "budget-capped",
        output: { agent: "scout", text: "partial", handoff: "Mapped enough to continue.", memoryCandidates: [], raw: "partial", warnings: [] },
      },
      { id: "step-2", agent: "worker", task: "Implement", status: "pending" },
    ],
  }, null, 2), "utf-8");

  const loaded = loadResumableRunState({ cwd, runId });

  assert.equal(loaded?.steps[0]?.status, "checkpointed");
  assert.deepEqual(loaded?.steps[0]?.checkpoint, {
    kind: "budget-cap",
    reason: "legacy budget-capped step status",
    continuation: "continue",
    legacyStatus: "budget-capped",
  });
});

test("resolveStepCompletionStatus fails errored child steps even without budget caps", () => {
  const status = resolveStepCompletionStatus({
    error: "SDK runner failed for worker: 401 Insufficient balance",
    metrics: {
      durationMs: 1,
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      toolCalls: 0,
      toolCallsByName: {},
    },
    output: undefined,
  });

  assert.equal(status, "failed");
});
