import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, test } from "bun:test";
import { MockWorkerRunner, buildConflictResolverTask, buildSdkPrompt, childToolNames, createRunState, hasUnrecoverableFailedSteps, loadResumableRunState, parseAgentOutput, prepareRunForResume, resolveAgentModel, resolveAgentThinking, resolveStepCompletionStatus, shouldStopAfterDagStage, toolBudgetForStep, withIdleTimeout } from "../src/runner.ts";
import type { AgentDefinition, RouteDecision, RunState } from "../src/schemas.ts";

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

function readOnlyAgent(name: string, concern: AgentDefinition["concern"] = "context-building"): AgentDefinition {
  return { name, scope: "built-in", concern, capabilities: ["inspect-files", "search-files"], description: name, model: "inherit", tools: [], memory: { read: false, write: "never", categories: [] }, systemPrompt: "", diagnostics: [] };
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
  assert.match(task, /do not rewrite whole/i);
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

test("SDK DAG can continue synthesis after a partial read-only fan-out timeout", () => {
  const agents = new Map([
    ["context-builder", readOnlyAgent("context-builder")],
    ["reviewer", readOnlyAgent("reviewer", "review")],
  ]);

  const shouldStop = shouldStopAfterDagStage([
    { agent: "context-builder", status: "failed", error: "SDK runner timed out for context-builder after 180000ms" },
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

test("SDK child timeout is based on idle time, not total wall-clock while a tool is active", async () => {
  let active = 1;
  const result = await withIdleTimeout(
    new Promise<string>((resolve) => setTimeout(() => {
      active = 0;
      resolve("finished");
    }, 55)),
    {
      idleTimeoutMs: 20,
      pollMs: 5,
      message: "idle guard",
      activeOperations: () => active,
    },
  );

  assert.equal(result, "finished");
});

test("SDK child idle guard rejects when no tool or message activity occurs", async () => {
  await assert.rejects(
    withIdleTimeout(new Promise(() => undefined), {
      idleTimeoutMs: 20,
      pollMs: 5,
      message: "idle guard",
      activeOperations: () => 0,
    }),
    /idle guard after 20ms without activity/,
  );
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
      { id: "fanout:step-1", agent: "context-builder", task: "Analyze backend.", status: "failed", error: "SDK runner timed out for context-builder after 180000ms" },
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
      { id: "fanout:step-1", agent: "context-builder", task: "Analyze backend.", status: "failed", error: "SDK runner timed out for context-builder after 180000ms" },
      { id: "fanout:step-2", agent: "context-builder", task: "Analyze UI.", status: "complete", output: { agent: "context-builder", text: "ui", handoff: "ui", memoryCandidates: [], raw: "", warnings: [] } },
    ],
  };

  assert.equal(hasUnrecoverableFailedSteps(run, agents), true);
});

test("parseAgentOutput accepts richer memory categories for long-running work", () => {
  const output = parseAgentOutput("planner", "## Memory Candidates\n- testing: This project runs regression tests with bun:test and isolated temp directories, so feature tests should not share filesystem state.\n- workflow: Long-running mesh features should checkpoint handoffs and validation contracts after each stage so later agents can resume safely.");
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
  assert.match(prompt, /at most 5 gap reads/i);
  assert.match(prompt, /Already Covered Evidence Paths/);
  assert.match(prompt, /middleware\/auth\.js/);
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
  assert.ok(childToolNames(agent, "Save a checkpoint for this long-running feature.", true, true).includes("mesh_artifact_write"));
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

  const tools = childToolNames(agent, "Synthesize deep project analysis in-depth into final answer material.", true, true);

  assert.ok(tools.includes("read"));
  assert.ok(tools.includes("grep"));
  assert.ok(tools.includes("find"));
  assert.ok(tools.includes("ls"));
});

test("childToolNames uses discovery plus snapshot mode for branch reconnaissance", () => {
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

  assert.deepEqual(childToolNames(agent, "Inspect current git branch, status, recent commits, and diff against base.", false, false), ["mesh_project_discovery", "mesh_project_snapshot"]);
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

test("resolveStepCompletionStatus treats useful budget handoffs as complete", () => {
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
  assert.equal(empty, "budget-capped");
});
