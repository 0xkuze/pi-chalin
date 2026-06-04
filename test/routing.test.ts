import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "vitest";
import { AgentCatalog } from "../src/agents/agents.ts";
import type { AgentDefinition, AgentOutput } from "../src/domain/schemas.ts";
import { formatInterviewResult } from "../src/interview/interview.ts";
import { routeFromPlan } from "../src/kernel/kernel.ts";
import { normalizeRouteForExecution } from "../src/routing/route-guards.ts";
import { formatRoute } from "../src/routing/route-format.ts";
import { shouldScheduleNonInteractiveShutdown } from "../src/routing/autoroute.ts";
import { planChalinRoute, validateChalinRoutePlannerOutput } from "../src/routing/route-planner.ts";
import { formatChalinRouteRequestWidget, formatChalinRunWidgetFromDetails } from "../src/routing/route-widget.ts";
import { loadFailedRunDiagnostic, markHumanBlockedDependentsSkipped } from "../src/runner/run-recovery.ts";
import { chalinSessionIdFromFile, createRunState, loadResumableRunState, markRunHumanInputAnswered, persistRun, prepareRunForResume } from "../src/runner/runner-state.ts";
import { MockWorkerRunner, planNestedDelegationRoute } from "../src/runner/runner.ts";
import { expandWorkUnitsFromHandoff, planStepsWithWorkUnits, refreshWorkUnitStatuses } from "../src/runner/work-units.ts";
import { beginChalinTurn, hasInlineToolStarted, recordInlineToolStart } from "../src/runtime/state.ts";
import { chalinChildSessionDir } from "../src/runtime/child-sessions.ts";
import { registerChalinTools } from "../src/tools/tools.ts";

function tempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function executableAgents(catalog: AgentCatalog): Map<string, AgentDefinition> {
  const result = new Map<string, AgentDefinition>();
  for (const agent of catalog.listExecutable()) {
    result.set(agent.name, agent);
    result.set(`${agent.scope}/${agent.name}`, agent);
  }
  return result;
}

function customAgent(name: string, concern: AgentDefinition["concern"], capabilities: AgentDefinition["capabilities"]): AgentDefinition {
  return {
    name,
    scope: "project",
    concern,
    capabilities,
    description: name,
    model: "inherit",
    tools: [],
    memory: { read: false, write: "never", categories: [] },
    systemPrompt: "",
    diagnostics: [],
  };
}

function discoveredWorkUnitsOutput(): AgentOutput {
  return {
    agent: "scout",
    text: "Discovered two independent write units.",
    handoff: "Discovered two independent write units.",
    structuredHandoff: {
      summary: "Two independent units were found.",
      changedFiles: [],
      verification: [],
      evidenceClaims: [],
      risks: [],
      nextActions: [],
      requiresHumanInput: false,
      humanInputQuestions: [],
      workUnits: [
        {
          id: "parser",
          title: "Parser regression",
          scope: ["Fix parser behavior"],
          files: ["src/parser.ts", "test/parser.test.ts"],
          dependencies: [],
          expectedEffects: ["read", "write", "verify"],
          acceptanceCriteria: ["Parser regression test passes."],
        },
        {
          id: "docs",
          title: "Docs update",
          scope: ["Update parser documentation"],
          files: ["README.md"],
          dependencies: [],
          expectedEffects: ["read", "write", "verify"],
          acceptanceCriteria: ["Docs reflect parser behavior."],
        },
      ],
    },
    memoryCandidates: [],
    raw: "Discovered two independent write units.",
    warnings: [],
  };
}

test("routeFromPlan normalizes human budget aliases", () => {
  const cases = [
    ["small", "tight"],
    ["medium", "normal"],
    ["large", "deep"],
  ] as const;

  for (const [input, expected] of cases) {
    const route = routeFromPlan({
      topology: "sequential",
      expectedEffects: ["read"],
      steps: [
        {
          agent: "scout",
          task: "Map a bounded local evidence surface.",
          budget: input,
        },
      ],
    });

    assert.equal(route.plan?.kind, "sequential");
    assert.equal(route.plan?.kind === "sequential" ? route.plan.steps[0]?.budget : undefined, expected);
  }
});

test("runtime records whether chalin_route already started in the current turn", () => {
  beginChalinTurn({ prompt: "inspect repo", cwd: process.cwd() });

  assert.equal(hasInlineToolStarted("chalin_route"), false);
  recordInlineToolStart({ toolName: "chalin_route" });
  assert.equal(hasInlineToolStarted("chalin_route"), true);

  beginChalinTurn({ prompt: "new turn", cwd: process.cwd() });
  assert.equal(hasInlineToolStarted("chalin_route"), false);
});

test("resumable run lookup is isolated to the originating Pi session", () => {
  const cwd = tempDir("pi-chalin-session-resume-");
  const route = routeFromPlan({
    topology: "sequential",
    expectedEffects: ["read"],
    steps: [
      {
        agent: "scout",
        task: "Map a bounded local evidence surface.",
      },
    ],
  });
  const run = createRunState(route, cwd, "Map project", { sessionId: "session-a" });
  run.status = "paused";
  run.steps[0]!.status = "pending";
  persistRun(run);

  assert.equal(loadResumableRunState({ cwd, recoverStale: false, sessionId: "session-b" }), undefined);
  assert.equal(loadResumableRunState({ cwd, recoverStale: false, sessionId: "session-a" })?.id, run.id);
});

test("recoverable failed workflow lookup continues the same run instead of requiring a new route", () => {
  const cwd = tempDir("pi-chalin-failed-continuation-");
  try {
    const route = routeFromPlan({
      topology: "sequential",
      expectedEffects: ["read", "write", "verify"],
      steps: [
        { agent: "planner", task: "Plan the implementation.", expectedEffects: ["read"] },
        { agent: "worker", task: "Apply the implementation.", expectedEffects: ["read", "write", "verify"] },
        { agent: "reviewer", task: "Review the implementation.", expectedEffects: ["read", "verify"] },
      ],
    });
    const run = createRunState(route, cwd, "Continue the interrupted workflow.", { sessionId: "session-a" });
    run.status = "failed";
    run.steps[0]!.status = "complete";
    run.steps[0]!.output = {
      agent: "planner",
      text: "Plan ready.",
      handoff: "Plan ready.",
      structuredHandoff: {
        summary: "Plan ready.",
        changedFiles: [],
        verification: [],
        evidenceClaims: [],
        risks: [],
        nextActions: [],
      },
      memoryCandidates: [],
      raw: "Plan ready.",
      warnings: [],
    };
    run.steps[1]!.status = "failed";
    run.steps[1]!.error = "SDK runner failed for worker: tool crashed";
    run.steps[1]!.childSessionFile = path.join(cwd, "worker-child.jsonl");
    run.steps[2]!.status = "skipped";
    run.steps[2]!.skipReason = "Skipped because upstream worker/step-2 failed.";
    persistRun(run);

    const loaded = loadResumableRunState({ cwd, recoverStale: false, sessionId: "session-a" });

    assert.equal(loaded?.id, run.id);
    assert.equal(loaded?.recoveryState?.resumeKind, "repair");
    prepareRunForResume(loaded!);
    assert.equal(loaded!.steps[0]!.status, "complete");
    assert.equal(loaded!.steps[1]!.status, "pending");
    assert.equal(loaded!.steps[1]!.childSessionFile, path.join(cwd, "worker-child.jsonl"));
    assert.equal(loaded!.steps[2]!.status, "pending");
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test("completed workflow is available for continuation synthesis only when explicitly included", () => {
  const cwd = tempDir("pi-chalin-complete-continuation-");
  try {
    const route = routeFromPlan({
      topology: "sequential",
      expectedEffects: ["read", "verify"],
      steps: [
        { agent: "reviewer", task: "Verify the final state.", expectedEffects: ["read", "verify"] },
      ],
    });
    const run = createRunState(route, cwd, "Answer from the completed workflow.", { sessionId: "session-a" });
    run.status = "complete";
    run.steps[0]!.status = "complete";
    run.steps[0]!.output = {
      agent: "reviewer",
      text: "Final evidence is ready.",
      handoff: "Final evidence is ready.",
      structuredHandoff: {
        summary: "Final evidence is ready.",
        changedFiles: [],
        verification: ["fake check passed"],
        evidenceClaims: [],
        risks: [],
        nextActions: [],
      },
      reviewerVerdict: {
        verdict: "pass",
        blockingFindings: [],
        missingCoverage: [],
        evidence: ["fake check passed"],
        evidenceRecords: [{ kind: "verification", paths: [], command: "fake check", status: "pass", result: "passed" }],
        residualRisks: [],
      },
      memoryCandidates: [],
      raw: "Final evidence is ready.",
      warnings: [],
    };
    persistRun(run);

    assert.equal(loadResumableRunState({ cwd, recoverStale: false, sessionId: "session-a" }), undefined);
    assert.equal(loadResumableRunState({ cwd, recoverStale: false, sessionId: "session-a", includeCompleted: true })?.id, run.id);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test("chalin_resume answers from a completed workflow instead of rerunning agents", async () => {
  const cwd = tempDir("pi-chalin-complete-resume-tool-");
  try {
    const route = routeFromPlan({
      topology: "sequential",
      expectedEffects: ["read", "verify"],
      needsArtifacts: true,
      steps: [
        { agent: "reviewer", task: "Verify final state.", expectedEffects: ["read", "verify"] },
      ],
    });
    const sessionFile = path.join(cwd, "session-a.jsonl");
    const run = createRunState(route, cwd, "Summarize final workflow evidence.", { sessionId: chalinSessionIdFromFile(sessionFile) });
    run.status = "complete";
    run.steps[0]!.status = "complete";
    run.steps[0]!.output = {
      agent: "reviewer",
      text: "Final workflow evidence: fake check passed.",
      handoff: "Final workflow evidence: fake check passed.",
      structuredHandoff: {
        summary: "Final workflow evidence: fake check passed.",
        changedFiles: [],
        verification: ["fake check passed"],
        evidenceClaims: [],
        risks: [],
        nextActions: [],
      },
      reviewerVerdict: {
        verdict: "pass",
        blockingFindings: [],
        missingCoverage: [],
        evidence: ["fake check passed"],
        evidenceRecords: [{ kind: "verification", paths: [], command: "fake check", status: "pass", result: "passed" }],
        residualRisks: [],
      },
      memoryCandidates: [],
      raw: "Final workflow evidence: fake check passed.",
      warnings: [],
    };
    persistRun(run);

    const tools: Array<{ name: string; execute: (...args: any[]) => Promise<any> }> = [];
    registerChalinTools({ registerTool: (tool: any) => tools.push(tool) } as never);
    const resume = tools.find((tool) => tool.name === "chalin_resume");
    assert.ok(resume);

    const result = await resume.execute("resume", {}, undefined, undefined, {
      cwd,
      sessionManager: { getSessionFile: () => sessionFile },
      hasUI: false,
    });
    const text = result.content.find((part: { type: string; text?: string }) => part.type === "text")?.text ?? "";

    assert.match(text, /pi-chalin completed/i);
    assert.match(text, /fake check passed/i);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test("chalin_resume retries the unfinished failed step inside the same persisted run", async () => {
  const cwd = tempDir("pi-chalin-failed-resume-tool-");
  const previousRunner = process.env.PI_CHALIN_RUNNER;
  try {
    process.env.PI_CHALIN_RUNNER = "mock";
    const sessionFile = path.join(cwd, "session-a.jsonl");
    const route = routeFromPlan({
      topology: "sequential",
      expectedEffects: ["read", "write", "verify"],
      steps: [
        { agent: "planner", task: "Plan the change.", expectedEffects: ["read"] },
        { agent: "worker", task: "Apply the change.", expectedEffects: ["read", "write", "verify"] },
        { agent: "reviewer", task: "Review the change.", expectedEffects: ["read", "verify"] },
      ],
    });
    const run = createRunState(route, cwd, "Continue failed workflow.", { sessionId: chalinSessionIdFromFile(sessionFile) });
    run.status = "failed";
    run.steps[0]!.status = "complete";
    run.steps[0]!.output = {
      agent: "planner",
      text: "Plan ready.",
      handoff: "Plan ready.",
      structuredHandoff: {
        summary: "Plan ready.",
        changedFiles: [],
        verification: [],
        evidenceClaims: [],
        risks: [],
        nextActions: [],
      },
      memoryCandidates: [],
      raw: "Plan ready.",
      warnings: [],
    };
    run.steps[1]!.status = "failed";
    run.steps[1]!.error = "arbitrary child tool failure";
    run.steps[1]!.childSessionFile = path.join(cwd, "worker-child.jsonl");
    run.steps[2]!.status = "skipped";
    run.steps[2]!.skipReason = "Skipped because upstream worker/step-2 failed.";
    persistRun(run);

    const tools: Array<{ name: string; execute: (...args: any[]) => Promise<any> }> = [];
    registerChalinTools({ registerTool: (tool: any) => tools.push(tool) } as never);
    const resume = tools.find((tool) => tool.name === "chalin_resume");
    assert.ok(resume);

    const result = await resume.execute("resume", {}, undefined, undefined, {
      cwd,
      sessionManager: { getSessionFile: () => sessionFile },
      hasUI: false,
    });
    const text = result.content.find((part: { type: string; text?: string }) => part.type === "text")?.text ?? "";
    const persisted = JSON.parse(fs.readFileSync(run.logsPath!, "utf-8"));
    const runFiles = fs.readdirSync(path.join(cwd, ".pi-chalin", "runs")).filter((name) => name.endsWith(".json"));

    assert.equal(runFiles.length, 1);
    assert.equal(persisted.id, run.id);
    assert.equal(persisted.status, "complete");
    assert.equal(persisted.steps[0].status, "complete");
    assert.equal(persisted.steps[1].status, "complete");
    assert.equal(persisted.steps[1].childSessionFile, path.join(cwd, "worker-child.jsonl"));
    assert.match(text, /pi-chalin completed/i);
  } finally {
    if (previousRunner === undefined) delete process.env.PI_CHALIN_RUNNER;
    else process.env.PI_CHALIN_RUNNER = previousRunner;
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test("chalin_resume falls back to the latest project workflow when the session changed", async () => {
  const cwd = tempDir("pi-chalin-session-fallback-tool-");
  const previousRunner = process.env.PI_CHALIN_RUNNER;
  try {
    process.env.PI_CHALIN_RUNNER = "mock";
    const route = routeFromPlan({
      topology: "sequential",
      expectedEffects: ["read", "write", "verify"],
      steps: [
        { agent: "planner", task: "Plan the change.", expectedEffects: ["read"] },
        { agent: "worker", task: "Apply the change.", expectedEffects: ["read", "write", "verify"] },
      ],
    });
    const run = createRunState(route, cwd, "Continue after account switch.", { sessionId: "old-account-session" });
    run.status = "failed";
    run.steps[0]!.status = "complete";
    run.steps[0]!.output = {
      agent: "planner",
      text: "Plan ready.",
      handoff: "Plan ready.",
      structuredHandoff: {
        summary: "Plan ready.",
        changedFiles: [],
        verification: [],
        evidenceClaims: [],
        risks: [],
        nextActions: [],
      },
      memoryCandidates: [],
      raw: "Plan ready.",
      warnings: [],
    };
    run.steps[1]!.status = "failed";
    run.steps[1]!.error = "arbitrary previous-session failure";
    persistRun(run);

    const tools: Array<{ name: string; execute: (...args: any[]) => Promise<any> }> = [];
    registerChalinTools({ registerTool: (tool: any) => tools.push(tool) } as never);
    const resume = tools.find((tool) => tool.name === "chalin_resume");
    assert.ok(resume);

    const result = await resume.execute("resume", {}, undefined, undefined, {
      cwd,
      sessionManager: { getSessionFile: () => path.join(cwd, "new-account-session.jsonl") },
      hasUI: false,
    });
    const persisted = JSON.parse(fs.readFileSync(run.logsPath!, "utf-8"));
    const text = result.content.find((part: { type: string; text?: string }) => part.type === "text")?.text ?? "";

    assert.equal(persisted.id, run.id);
    assert.equal(persisted.status, "complete");
    assert.match(text, /pi-chalin completed/i);
  } finally {
    if (previousRunner === undefined) delete process.env.PI_CHALIN_RUNNER;
    else process.env.PI_CHALIN_RUNNER = previousRunner;
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test("failed route result tells the primary agent to continue the persisted workflow", () => {
  const route = routeFromPlan({
    topology: "sequential",
    expectedEffects: ["read", "write", "verify"],
    steps: [
      { agent: "worker", task: "Apply the implementation.", expectedEffects: ["read", "write", "verify"] },
      { agent: "reviewer", task: "Review the implementation.", expectedEffects: ["read", "verify"] },
    ],
  });
  const run = createRunState(route, process.cwd(), "Continue failed workflow.");
  run.status = "failed";
  run.steps[0]!.status = "failed";
  run.steps[0]!.error = "arbitrary child tool failure";

  const text = formatRoute(route, {
    route,
    run,
    approval: { action: "allow", reason: "allowed" },
    memories: [],
    diagnostics: [],
  });

  assert.match(text, /chalin_resume/i);
  assert.match(text, /do not start another route/i);
});

test("nested child session directories can use the worker session file as explicit parent", () => {
  const cwd = tempDir("pi-chalin-child-session-parent-");
  try {
    const parentSessionFile = path.join(cwd, "parent-worker.jsonl");
    const childDir = chalinChildSessionDir({
      cwd,
      runId: "nested-run",
      stepId: "implementation:step-1",
      agent: "worker",
      parentSessionFile,
    });

    assert.equal(
      childDir,
      path.join(cwd, "parent-worker", "pi-chalin", "nested-run", "implementation-step-1-worker"),
    );
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test("prepareRunForResume clears stale skip metadata and records resume once", () => {
  const cwd = tempDir("pi-chalin-resume-clean-");
  const route = routeFromPlan({
    topology: "sequential",
    expectedEffects: ["read", "write", "verify"],
    steps: [
      { agent: "scout", task: "Map evidence." },
      { agent: "worker", task: "Apply change." },
      { agent: "reviewer", task: "Review change." },
    ],
  });
  const run = createRunState(route, cwd, "Resume skipped work");
  run.status = "paused";
  run.steps[1]!.status = "skipped";
  run.steps[1]!.skipReason = "Skipped because a prior step needed input.";
  run.steps[1]!.endedAt = "2026-06-04T00:00:00.000Z";
  run.steps[1]!.childSessionFile = path.join(cwd, "worker-session.jsonl");

  prepareRunForResume(run);
  prepareRunForResume(run);

  assert.equal(run.steps[1]!.status, "pending");
  assert.equal(run.steps[1]!.skipReason, undefined);
  assert.equal(run.steps[1]!.endedAt, undefined);
  assert.equal(run.steps[1]!.childSessionFile, path.join(cwd, "worker-session.jsonl"));
  assert.equal(run.warnings.filter((warning) => warning === `Resumed pi-chalin run ${run.id}.`).length, 1);
});

test("prepareRunForResume clears stale WorkUnit skip metadata", () => {
  const cwd = tempDir("pi-chalin-resume-unit-clean-");
  const route = routeFromPlan({
    topology: "sequential",
    expectedEffects: ["read", "write", "verify"],
    steps: [
      { agent: "planner", task: "Plan implementation.", expectedEffects: ["read"] },
      { agent: "worker", task: "Apply implementation.", expectedEffects: ["read", "write", "verify"] },
    ],
  });
  const run = createRunState(route, cwd, "Resume skipped WorkUnit");
  run.status = "paused";
  run.steps[1]!.status = "skipped";
  run.steps[1]!.skipReason = "Skipped because a prior step needed input.";
  run.workUnits![1]!.status = "skipped";
  run.workUnits![1]!.skippedReason = "Skipped because a prior step needed input.";

  prepareRunForResume(run);

  assert.equal(run.steps[1]!.status, "pending");
  assert.equal(run.workUnits![1]!.status, "pending");
  assert.equal(run.workUnits![1]!.skippedReason, undefined);
});

test("prepareRunForResume retries a failed legacy step without WorkUnit metadata", () => {
  const cwd = tempDir("pi-chalin-resume-legacy-failed-step-");
  const route = routeFromPlan({
    topology: "sequential",
    expectedEffects: ["read", "verify"],
    steps: [
      { agent: "scout", task: "Map legacy state.", expectedEffects: ["read"] },
      { agent: "reviewer", task: "Review legacy state.", expectedEffects: ["read", "verify"] },
    ],
  });
  const run = createRunState(route, cwd, "Resume legacy failed step");
  run.status = "failed";
  run.steps[0]!.status = "failed";
  run.steps[0]!.error = "legacy step failed before WorkUnits existed";
  run.steps[0]!.workUnitId = undefined;
  run.steps[1]!.status = "pending";
  run.steps[1]!.workUnitId = undefined;

  prepareRunForResume(run);

  assert.equal(run.steps[0]!.status, "pending");
  assert.equal(run.steps[0]!.error, undefined);
  assert.equal(run.steps[1]!.status, "pending");
});

test("human-input recovery only records actual review steps as reviewers not run", () => {
  const cwd = tempDir("pi-chalin-human-block-reviewers-");
  const route = routeFromPlan({
    topology: "sequential",
    expectedEffects: ["read", "write", "verify"],
    steps: [
      { agent: "scout", task: "Map evidence.", expectedEffects: ["read"] },
      { agent: "worker", task: "Apply change.", expectedEffects: ["read", "write", "verify"] },
      { agent: "reviewer", task: "Review change.", expectedEffects: ["read", "verify"] },
    ],
  });
  const run = createRunState(route, cwd, "Ask before changing scope");
  const scout = run.steps[0]!;
  scout.status = "complete";

  markHumanBlockedDependentsSkipped(run, scout, ["Which target should be changed?"]);

  assert.equal(run.steps[1]!.status, "skipped");
  assert.equal(run.steps[2]!.status, "skipped");
  assert.deepEqual(run.recoveryState?.reviewersNotRun, ["step-3"]);
});

test("answered human-input interview clears the paused run block before resume", () => {
  const cwd = tempDir("pi-chalin-human-input-answered-");
  const route = routeFromPlan({
    topology: "sequential",
    expectedEffects: ["read", "write", "verify"],
    steps: [
      { agent: "planner", task: "Plan implementation.", expectedEffects: ["read"] },
      { agent: "worker", task: "Apply implementation.", expectedEffects: ["read", "write", "verify"] },
      { agent: "reviewer", task: "Review implementation.", expectedEffects: ["read", "verify"] },
    ],
  });
  const run = createRunState(route, cwd, "Implement feature.");
  run.status = "paused";
  run.steps[0]!.status = "complete";
  run.steps[0]!.output = {
    agent: "planner",
    text: "Human input required.",
    handoff: "Human input required.",
    structuredHandoff: {
      summary: "Human input required.",
      changedFiles: [],
      verification: [],
      evidenceClaims: [],
      risks: [],
      nextActions: [],
      requiresHumanInput: true,
      humanInputQuestions: ["Which product behavior should be used?"],
    },
    memoryCandidates: [],
    raw: "Human input required.",
    warnings: [],
  };
  markHumanBlockedDependentsSkipped(run, run.steps[0]!, ["Which product behavior should be used?"]);

  assert.equal(run.intentContract?.requiresInterview, true);
  assert.equal(run.recoveryState?.blockedByHumanInput, true);
  assert.equal(run.steps[1]!.status, "skipped");

  assert.equal(markRunHumanInputAnswered(run), true);
  prepareRunForResume(run);

  assert.equal(run.intentContract?.requiresInterview, undefined);
  assert.equal(run.recoveryState?.blockedByHumanInput, undefined);
  assert.equal(run.steps[0]!.output?.structuredHandoff?.requiresHumanInput, false);
  assert.deepEqual(run.steps[0]!.output?.structuredHandoff?.humanInputQuestions, []);
  assert.equal(run.recoveryState?.repairOptions.includes("Which product behavior should be used?"), false);
  assert.equal(run.steps[1]!.status, "pending");
  assert.equal(run.steps[2]!.status, "pending");
});

test("planned verification from read-only planning handoff is not recorded as executed verification", async () => {
  const cwd = tempDir("pi-chalin-planned-verification-ledger-");
  try {
    const route = routeFromPlan({
      topology: "sequential",
      expectedEffects: ["read", "write", "verify"],
      steps: [
        { agent: "planner", task: "Plan implementation.", expectedEffects: ["read"] },
        { agent: "worker", task: "Apply implementation.", expectedEffects: ["read", "write", "verify"] },
      ],
    });
    const run = createRunState(route, cwd, "Implement feature.");
    run.status = "paused";
    const planner = run.steps[0]!;
    planner.status = "complete";
    planner.output = {
      agent: "planner",
      text: "Plan created.",
      handoff: "Plan created.",
      structuredHandoff: {
        summary: "Plan created.",
        changedFiles: [],
        verification: ["pnpm test", "pnpm build"],
        evidenceClaims: [],
        risks: [],
        nextActions: ["Run pnpm test after implementation."],
        requiresHumanInput: false,
        humanInputQuestions: [],
      },
      memoryCandidates: [],
      raw: "Plan created.",
      warnings: [],
    };

    const resumed = await new MockWorkerRunner().resume(run, {
      cwd,
      agents: new Map([
        ["planner", customAgent("planner", "planning", ["inspect-files"])],
        ["worker", customAgent("worker", "implementation", ["inspect-files", "edit-files", "validate"])],
      ]),
    });

    assert.equal(resumed.verificationLedger?.some((entry) => entry.stepId === planner.id), false);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test("interview result instructs resume when it resolves a paused chalin run", () => {
  const text = formatInterviewResult({
    featureId: "feature",
    task: "Implement feature.",
    reason: "Needs a human answer.",
    status: "answered",
    answers: [{ questionId: "scope", question: "Which scope?", answer: "Use current scope.", custom: false, recommended: true }],
  }, { resumeRunId: "chalin-run-1" });

  assert.match(text, /call chalin_resume/i);
  assert.match(text, /\{"runId":"chalin-run-1"\}/);
  assert.doesNotMatch(text, /continue with these answers as planning context/i);
});

test("run widget shows approval pauses explicitly", () => {
  const text = formatChalinRunWidgetFromDetails({
    route: routeFromPlan({
      topology: "sequential",
      expectedEffects: ["write"],
      steps: [{ id: "worker", agent: "worker", task: "Run guarded migration." }],
    }),
    run: {
      id: "run-approval",
      rootTask: "Run guarded migration.",
      status: "paused",
      steps: [{
        id: "worker",
        agent: "worker",
        task: "Run guarded migration.",
        status: "paused",
        pauseReason: "awaiting-approval",
      }],
      warnings: ["Awaiting one-shot approval for bash: pnpm db:migrate --prod."],
    },
  });

  assert.match(text, /chalin · paused · 0\/1 · Run guarded migration/);
  assert.match(text, /awaiting approval/);
});

test("non-interactive chalin route shutdown is opt-in so final synthesis is not aborted", () => {
  const previous = process.env.PI_CHALIN_NONINTERACTIVE_SHUTDOWN;
  try {
    delete process.env.PI_CHALIN_NONINTERACTIVE_SHUTDOWN;
    assert.equal(shouldScheduleNonInteractiveShutdown({ hasUI: false, shutdown: () => undefined }), false);

    process.env.PI_CHALIN_NONINTERACTIVE_SHUTDOWN = "1";
    assert.equal(shouldScheduleNonInteractiveShutdown({ hasUI: false, shutdown: () => undefined }), true);
  } finally {
    if (previous === undefined) delete process.env.PI_CHALIN_NONINTERACTIVE_SHUTDOWN;
    else process.env.PI_CHALIN_NONINTERACTIVE_SHUTDOWN = previous;
  }
});

test("failed run diagnostics are isolated to the originating Pi session", () => {
  const cwd = tempDir("pi-chalin-session-failed-");
  const route = routeFromPlan({
    topology: "sequential",
    expectedEffects: ["read"],
    steps: [
      {
        agent: "scout",
        task: "Map a bounded local evidence surface.",
      },
    ],
  });
  const run = createRunState(route, cwd, "Map project", { sessionId: "session-a" });
  run.status = "failed";
  run.steps[0]!.status = "failed";
  run.steps[0]!.error = "tool validation failed";
  persistRun(run);

  assert.equal(loadFailedRunDiagnostic({ cwd, sessionId: "session-b" }), undefined);
  assert.equal(loadFailedRunDiagnostic({ cwd, sessionId: "session-a" })?.run.id, run.id);
});

test("paused human-input route result instructs asking instead of starting a new route", () => {
  const route = routeFromPlan({
    topology: "sequential",
    expectedEffects: ["read", "write", "verify"],
    steps: [
      { agent: "scout", task: "Discover implementation scope." },
      { agent: "worker", task: "Apply implementation." },
    ],
  });
  const run = createRunState(route, process.cwd(), "Implement the requested API client.");
  run.status = "paused";
  run.intentContract = {
    originalPrompt: run.rootTask ?? "Implement the requested API client.",
    explicitConstraints: [],
    forbiddenPaths: [],
    requiresInterview: true,
  };
  run.recoveryState = {
    pendingUnits: [],
    reviewersNotRun: [],
    resumeKind: "none",
    blockedByHumanInput: true,
    repairOptions: ["Which API client target should be changed?"],
  };

  const text = formatRoute(route, {
    route,
    run,
    approval: { action: "allow", reason: "allowed" },
    memories: [],
    diagnostics: [],
  });

  assert.match(text, /ask the user/i);
  assert.match(text, /Which API client target should be changed/i);
  assert.match(text, /do not start another route/i);
});

test("route request widget renders the initial delegation as a compact tool call", () => {
  const text = formatChalinRouteRequestWidget({
    task: "Triage GitHub PR #124 reviewer comments in this evgo repository.",
    topology: "auto",
    steps: [
      { agent: "scout", task: "Inspect PR comments with gh/git." },
      { agent: "planner", task: "Plan needed fixes." },
      { agent: "worker", task: "Apply fixes." },
      { agent: "reviewer", task: "Review changes." },
    ],
  });

  assert.deepEqual(text.split("\n"), [
    "chalin_route · delegating · auto",
    "task: Triage GitHub PR #124 reviewer comments in this evgo repository.",
    "agents: scout → planner → worker → reviewer",
  ]);
  assert.equal(text.includes("├"), false);
  assert.equal(text.includes("Inspect PR comments with gh/git."), false);
});

test("chalin_route initial render uses the standard Pi tool shell", () => {
  const tools: Array<{ name: string; renderShell?: string; renderCall?: unknown }> = [];
  registerChalinTools({ registerTool: (tool: any) => tools.push(tool) } as never);

  const routeTool = tools.find((tool) => tool.name === "chalin_route");

  assert.ok(routeTool);
  assert.notEqual(routeTool.renderShell, "self");
  assert.equal(typeof routeTool.renderCall, "function");
});

test("run widget renders WorkUnits as a compact product tree without harness internals", () => {
  const text = formatChalinRunWidgetFromDetails({
    route: routeFromPlan({
      topology: "dag",
      expectedEffects: ["read", "write", "verify"],
      steps: [
        { id: "scan-comments", agent: "scout", task: "Review unresolved reviewer comments and collect evidence." },
        { id: "map-diff", agent: "scout", task: "Map current diff against reviewer concerns." },
      ],
      reason: "Triage PR comments, validate each requested change, and prepare bounded fixes.",
    }),
    run: {
      id: "run-1",
      rootTask: "Reviewing comments on PR #124 and validating unresolved reviewer feedback before fixes.",
      status: "running",
      metrics: {
        durationMs: 100,
        usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        toolCalls: 7,
        toolCallsByName: { read: 4, bash: 3 },
        budgetCapHits: [{ name: "max_output_chars", used: 7_500, limit: 7_000, severity: "soft", phase: "post-tool" }],
      },
      warnings: ["hidden warning"],
      recoveryState: { pendingUnits: ["unit-map-diff"], reviewersNotRun: [], resumeKind: "none", repairOptions: [] },
      workUnits: [
        {
          id: "Unit Scan Comments",
          title: "Comments scan should be normalized and short enough for the terminal tree",
          kind: "discovery",
          status: "complete",
          scope: ["Review comments"],
          dependencies: [],
          expectedEffects: ["read"],
          acceptanceCriteria: ["Evidence collected"],
          workerStepId: "scan",
          createdFrom: "route-plan",
        },
        {
          id: "Unit Map Diff",
          title: "Diff map",
          kind: "discovery",
          status: "running",
          scope: ["Map diff"],
          dependencies: ["Unit Scan Comments"],
          expectedEffects: ["read"],
          acceptanceCriteria: ["Diff mapped"],
          workerStepId: "map",
          createdFrom: "route-plan",
        },
      ],
      steps: [
        {
          id: "scan",
          agent: "scout",
          task: "Review unresolved reviewer comments and collect evidence.",
          status: "complete",
          skills: ["github-pr-review"],
          workUnitId: "Unit Scan Comments",
        },
        {
          id: "map",
          agent: "scout",
          task: "Map current diff against reviewer concerns.",
          status: "running",
          skills: ["git-audit"],
          workUnitId: "Unit Map Diff",
        },
      ],
    },
  });

  const lines = text.split("\n");
  assert.equal(lines[0], "chalin · running · 1/2 · Reviewing comments on PR #124 and validating unresolved reviewer feedback...");
  assert.equal(lines[1], "├ ✓ scout - Review unresolved reviewer comments and collect evidence.");
  assert.equal(lines[2], "└ ◆ scout - Map current diff against reviewer concerns.");
  assert.equal(text.includes("current:"), false);
  assert.equal(text.includes("tools:"), false);
  assert.equal(text.includes("guards:"), false);
  assert.equal(text.includes("budget"), false);
  assert.equal(text.includes("skills:"), false);
  assert.equal(text.includes("recovery:"), false);
  assert.equal(text.includes("policy"), false);
  assert.equal(text.includes("unit-scan-comments"), false);
  assert.equal(text.includes("unit-map-diff"), false);
});

test("run widget keeps completed WorkUnit trees visible as execution history", () => {
  const text = formatChalinRunWidgetFromDetails({
    route: routeFromPlan({
      topology: "sequential",
      expectedEffects: ["read", "verify"],
      steps: [
        { id: "comments", agent: "scout", task: "Review comments." },
        { id: "synthesis", agent: "planner", task: "Synthesize result." },
      ],
    }),
    run: {
      id: "run-2",
      rootTask: "Review PR comments.",
      status: "complete",
      steps: [
        { id: "comments", agent: "scout", task: "Review comments.", status: "complete", workUnitId: "unit-comments" },
        { id: "synthesis", agent: "planner", task: "Synthesize result.", status: "complete", workUnitId: "unit-synthesis" },
      ],
      workUnits: [
        {
          id: "unit-comments",
          title: "Comments",
          kind: "discovery",
          status: "complete",
          scope: ["Review comments"],
          dependencies: [],
          expectedEffects: ["read"],
          acceptanceCriteria: ["Comments reviewed"],
          workerStepId: "comments",
          createdFrom: "route-plan",
        },
        {
          id: "unit-synthesis",
          title: "Synthesis",
          kind: "synthesis",
          status: "complete",
          scope: ["Synthesize"],
          dependencies: ["unit-comments"],
          expectedEffects: ["verify"],
          acceptanceCriteria: ["Result synthesized"],
          workerStepId: "synthesis",
          createdFrom: "route-plan",
        },
      ],
    },
  });

  assert.deepEqual(text.split("\n"), [
    "chalin · done · 2/2 · Review PR comments.",
    "├ ✓ scout - Review comments.",
    "└ ✓ planner - Synthesize result.",
  ]);
});

test("run widget keeps failed replaced attempts out of the normal tree and counts the WorkUnit once", () => {
  const text = formatChalinRunWidgetFromDetails({
    route: routeFromPlan({
      topology: "sequential",
      expectedEffects: ["read"],
      steps: [{ id: "comments", agent: "scout", task: "Review comments." }],
    }),
    run: {
      id: "run-3",
      rootTask: "Review comments.",
      status: "running",
      steps: [
        { id: "comments-attempt-1", agent: "scout", task: "Review comments.", status: "failed", error: "tool failed", workUnitId: "unit-comments" },
        { id: "comments-attempt-2", agent: "scout", task: "Review comments with recovered state.", status: "running", workUnitId: "unit-comments" },
      ],
      workUnits: [
        {
          id: "unit-comments",
          title: "Comments",
          kind: "discovery",
          status: "running",
          scope: ["Review comments"],
          dependencies: [],
          expectedEffects: ["read"],
          acceptanceCriteria: ["Comments reviewed"],
          workerStepId: "comments-attempt-2",
          createdFrom: "repair",
          failureReason: "tool failed",
        },
      ],
    },
  });

  assert.deepEqual(text.split("\n"), [
    "chalin · running · 0/1 · Review comments.",
    "└ ◆ scout - Review comments with recovered state.",
  ]);
  assert.equal(text.includes("tool failed"), false);
  assert.equal(text.includes("comments-attempt-1"), false);
});

test("run widget shows active WorkUnit from live step state without duplicate headers", () => {
  const text = formatChalinRunWidgetFromDetails({
    route: routeFromPlan({
      topology: "sequential",
      expectedEffects: ["read", "write", "verify"],
      steps: [
        { id: "recon", agent: "scout", task: "Inspect contract and client surfaces." },
        { id: "implement", agent: "worker", task: "Implement OpenAPI generated client." },
        { id: "review", agent: "reviewer", task: "Validate final implementation." },
      ],
    }),
    run: {
      id: "run-openapi",
      rootTask: "Continue and apply the OpenAPI-generated API client implementation across all discovered required targets.",
      status: "running",
      steps: [
        { id: "recon", agent: "scout", task: "Inspect contract and client surfaces.", status: "complete", workUnitId: "unit-recon" },
        { id: "implement", agent: "worker", task: "Implement OpenAPI generated client.", status: "running", workUnitId: "unit-client" },
        { id: "review", agent: "reviewer", task: "Validate final implementation.", status: "pending", workUnitId: "unit-review" },
      ],
      workUnits: [
        {
          id: "unit-recon",
          title: "recon-contract-client-surfaces",
          kind: "synthesis",
          status: "complete",
          scope: ["Inspect contract and client surfaces."],
          dependencies: [],
          expectedEffects: ["read"],
          acceptanceCriteria: ["Evidence recorded."],
          workerStepId: "recon",
          createdFrom: "route-plan",
        },
        {
          id: "unit-client",
          title: "implement-openapi-generated-client",
          kind: "implementation",
          status: "pending",
          scope: ["Implement OpenAPI generated client."],
          dependencies: ["unit-recon"],
          expectedEffects: ["read", "write", "verify"],
          acceptanceCriteria: ["Client implemented."],
          workerStepId: "implement",
          createdFrom: "route-plan",
        },
        {
          id: "unit-review",
          title: "independent-validation",
          kind: "review",
          status: "pending",
          scope: ["Validate final implementation."],
          dependencies: ["unit-client"],
          expectedEffects: ["read", "verify"],
          acceptanceCriteria: ["Implementation validated."],
          reviewerStepId: "review",
          createdFrom: "route-plan",
        },
      ],
    },
  });

  const lines = text.split("\n");
  assert.equal(lines[0], "chalin · running · 1/3 · Continue and apply the OpenAPI-generated API client implementation across all...");
  assert.equal(lines[1], "├ ✓ scout - Inspect contract and client surfaces.");
  assert.equal(lines[2], "├ ◆ worker - Implement OpenAPI generated client.");
  assert.equal(lines[3], "└ ○ reviewer - Validate final implementation.");
  assert.equal(text.includes("current:"), false);
  assert.equal(text.includes("chalin · worker"), false);
  assert.equal(text.includes("unit-client"), false);
});

test("run widget derives parallel WorkUnit status from referenced live step ids", () => {
  const text = formatChalinRunWidgetFromDetails({
    route: routeFromPlan({
      topology: "dag",
      expectedEffects: ["read"],
      stages: [{
        id: "evidence",
        tasks: [
          { id: "scout", agent: "scout", task: "Inventory the project." },
          { id: "researcher", agent: "researcher", task: "Gather current package guidance." },
        ],
      }],
    }),
    run: {
      id: "run-parallel-status",
      rootTask: "Implement OpenAPI workflow.",
      status: "running",
      steps: [
        { id: "evidence:step-1", agent: "scout", task: "Inventory the project.", status: "complete" },
        { id: "evidence:step-2", agent: "researcher", task: "Gather current package guidance.", status: "running" },
      ],
      workUnits: [
        {
          id: "unit-scout",
          title: "local-recon",
          kind: "synthesis",
          status: "complete",
          scope: ["Inventory the project."],
          dependencies: [],
          expectedEffects: ["read"],
          acceptanceCriteria: ["Project inventoried."],
          workerStepId: "evidence:step-1",
          createdFrom: "route-plan",
        },
        {
          id: "unit-researcher",
          title: "current-package-research",
          kind: "synthesis",
          status: "complete",
          scope: ["Gather current package guidance."],
          dependencies: [],
          expectedEffects: ["read"],
          acceptanceCriteria: ["Package guidance gathered."],
          workerStepId: "evidence:step-2",
          createdFrom: "route-plan",
        },
      ],
    },
  });

  assert.deepEqual(text.split("\n").slice(0, 3), [
    "chalin · running · 1/2 · Implement OpenAPI workflow.",
    "├ ✓ scout - Inventory the project.",
    "└ ◆ researcher - Gather current package guidance.",
  ]);
});

test("run widget marks a completed parallel step even before stale WorkUnit status refreshes", () => {
  const text = formatChalinRunWidgetFromDetails({
    route: routeFromPlan({
      topology: "dag",
      expectedEffects: ["read"],
      stages: [{
        id: "evidence",
        tasks: [
          { id: "scout", agent: "scout", task: "Inventory the project." },
          { id: "researcher", agent: "researcher", task: "Gather current package guidance." },
        ],
      }],
    }),
    run: {
      id: "run-parallel-stale-unit",
      rootTask: "Implement OpenAPI workflow.",
      status: "running",
      steps: [
        { id: "evidence:step-1", agent: "scout", task: "Inventory the project.", status: "running" },
        { id: "evidence:step-2", agent: "researcher", task: "Gather current package guidance.", status: "complete" },
      ],
      workUnits: [
        {
          id: "unit-scout",
          title: "local-recon",
          kind: "synthesis",
          status: "pending",
          scope: ["Inventory the project."],
          dependencies: [],
          expectedEffects: ["read"],
          acceptanceCriteria: ["Project inventoried."],
          workerStepId: "evidence:step-1",
          createdFrom: "route-plan",
        },
        {
          id: "unit-researcher",
          title: "current-package-research",
          kind: "synthesis",
          status: "pending",
          scope: ["Gather current package guidance."],
          dependencies: [],
          expectedEffects: ["read"],
          acceptanceCriteria: ["Package guidance gathered."],
          workerStepId: "evidence:step-2",
          createdFrom: "route-plan",
        },
      ],
    },
  });

  assert.deepEqual(text.split("\n").slice(0, 3), [
    "chalin · running · 1/2 · Implement OpenAPI workflow.",
    "├ ◆ scout - Inventory the project.",
    "└ ✓ researcher - Gather current package guidance.",
  ]);
});

test("WorkUnit status stays running while a recovery step is active after an earlier failure", () => {
  const route = routeFromPlan({
    topology: "sequential",
    expectedEffects: ["read", "write", "verify"],
    steps: [{ id: "apply", agent: "worker", task: "Apply scoped fix." }],
  });
  const run = createRunState(route, process.cwd(), "Apply scoped fix.");
  run.steps = [
    { id: "apply-attempt-1", agent: "worker", task: "Apply scoped fix.", status: "failed", error: "workspace hygiene gap", workUnitId: "unit-apply" },
    { id: "apply-repair-2", agent: "worker", task: "Repair hygiene and verify.", status: "running", workUnitId: "unit-apply" },
  ];
  run.workUnits = [{
    id: "unit-apply",
    title: "Apply scoped fix",
    kind: "implementation",
    status: "failed",
    scope: ["Apply scoped fix"],
    dependencies: [],
    expectedEffects: ["read", "write", "verify"],
    acceptanceCriteria: ["Fix verified"],
    workerStepId: "apply-attempt-1",
    createdFrom: "repair",
    failureReason: "workspace hygiene gap",
  }];

  refreshWorkUnitStatuses(run);

  assert.equal(run.workUnits[0]?.status, "running");
  assert.equal(run.workUnits[0]?.failureReason, "workspace hygiene gap");
});

test("WorkUnit refresh derives status from referenced step ids when workUnitId is missing", () => {
  const route = routeFromPlan({
    topology: "dag",
    expectedEffects: ["read"],
    stages: [{
      id: "evidence",
      tasks: [
        { id: "scout", agent: "scout", task: "Inventory the project." },
        { id: "researcher", agent: "researcher", task: "Gather current package guidance." },
      ],
    }],
  });
  const run = createRunState(route, process.cwd(), "Implement OpenAPI workflow.");
  run.steps[0]!.status = "complete";
  run.steps[0]!.workUnitId = undefined;
  run.steps[1]!.status = "running";
  run.steps[1]!.workUnitId = undefined;
  run.workUnits![0]!.status = "complete";
  run.workUnits![1]!.status = "complete";

  refreshWorkUnitStatuses(run);

  assert.equal(run.workUnits![0]!.status, "complete");
  assert.equal(run.workUnits![1]!.status, "running");
});

test("run widget normalizes duplicate WorkUnit display ids without changing language", () => {
  const text = formatChalinRunWidgetFromDetails({
    route: routeFromPlan({
      topology: "sequential",
      expectedEffects: ["read"],
      steps: [{ id: "revision", agent: "scout", task: "Revisar API." }],
    }),
    run: {
      id: "run-4",
      rootTask: "Revisar API.",
      status: "running",
      steps: [
        { id: "first", agent: "scout", task: "Revisar API.", status: "running", workUnitId: "Revisión API" },
        { id: "second", agent: "planner", task: "Revisar API alternativa.", status: "pending", workUnitId: "revisión api" },
      ],
      workUnits: [
        {
          id: "Revisión API",
          title: "Revisión API",
          kind: "discovery",
          status: "running",
          scope: ["Revisar API"],
          dependencies: [],
          expectedEffects: ["read"],
          acceptanceCriteria: ["API revisada"],
          workerStepId: "first",
          createdFrom: "route-plan",
        },
        {
          id: "revisión api",
          title: "Revisión API alternativa",
          kind: "planning",
          status: "pending",
          scope: ["Revisar API alternativa"],
          dependencies: ["Revisión API"],
          expectedEffects: ["read"],
          acceptanceCriteria: ["Alternativa revisada"],
          workerStepId: "second",
          createdFrom: "route-plan",
        },
      ],
    },
  });

  assert.deepEqual(text.split("\n"), [
    "chalin · running · 0/2 · Revisar API.",
    "├ ◆ scout - Revisar API.",
    "└ ○ planner - Revisar API alternativa.",
  ]);
});

test("run widget renders one visible nested subagent level from parent step traces", () => {
  const text = formatChalinRunWidgetFromDetails({
    route: routeFromPlan({
      topology: "sequential",
      expectedEffects: ["read", "write", "verify"],
      steps: [{ id: "review-comments", agent: "scout", task: "Review comments." }],
    }),
    run: {
      id: "run-nested",
      rootTask: "Reviewing PR comments.",
      status: "running",
      steps: [
        {
          id: "review-comments",
          agent: "scout",
          task: "Review comments.",
          status: "running",
          workUnitId: "unit-review-comments",
          nestedRuns: [
            {
              id: "nested-1",
              status: "running",
              rootTask: "Inspect unresolved review comments in GitHub.",
              steps: [
                {
                  id: "comments-scan",
                  agent: "scout",
                  task: "Inspect unresolved review comments in GitHub.",
                  status: "running",
                  workUnitId: "nested-comments-scan",
                },
              ],
              workUnits: [
                {
                  id: "nested-comments-scan",
                  title: "Comments scan",
                  kind: "discovery",
                  status: "running",
                  scope: ["Inspect unresolved comments"],
                  dependencies: [],
                  expectedEffects: ["read"],
                  acceptanceCriteria: ["Comments inspected"],
                  workerStepId: "comments-scan",
                  createdFrom: "route-plan",
                },
              ],
            },
          ],
        },
      ],
      workUnits: [
        {
          id: "unit-review-comments",
          title: "Review comments",
          kind: "discovery",
          status: "running",
          scope: ["Review comments"],
          dependencies: [],
          expectedEffects: ["read", "write", "verify"],
          acceptanceCriteria: ["Comments reviewed"],
          workerStepId: "review-comments",
          createdFrom: "route-plan",
        },
      ],
    },
  });

  assert.deepEqual(text.split("\n"), [
    "chalin · running · 0/1 · Reviewing PR comments.",
    "└ ◆ scout - Review comments.",
    "   └ ◆ scout - Inspect unresolved review comments in GitHub.",
  ]);
});

test("auto route does not fabricate a hardcoded plan when the structured planner is unavailable", async () => {
  const catalog = AgentCatalog.load({ cwd: process.cwd() });
  const result = await planChalinRoute({
    task: "Triage GitHub PR #124 reviewer comments, validate unresolved comments, implement needed fixes, and verify the result.",
    topology: "auto",
  }, {
    cwd: process.cwd(),
    catalog,
  });

  assert.equal(result.source, "failed");
  assert.equal(result.route.plan, undefined);
  assert.match(result.route.reason, /route planning blocked/i);
});

test("structured route planner output validates into a route plan without task-type mapping", () => {
  const catalog = AgentCatalog.load({ cwd: process.cwd() });
  const output = validateChalinRoutePlannerOutput({
    topology: "sequential",
    steps: [
      {
        id: "inspect",
        agent: "scout",
        task: "Inspect the exact files, tests, and repository evidence needed for this delegated change.",
      },
      {
        id: "apply",
        agent: "worker",
        task: "Apply the validated change inside the discovered file scope and run focused verification.",
      },
      {
        id: "review",
        agent: "reviewer",
        task: "Review the resulting diff and verification evidence before final synthesis.",
      },
    ],
    risk: "medium",
    needsMemory: false,
    needsArtifacts: true,
    expectedEffects: ["read", "write", "verify"],
    requiresWorkspaceMutation: true,
    reason: "The task needs evidence, mutation, and independent validation.",
  }, catalog);

  assert.equal(output?.plan.topology, "sequential");
  assert.deepEqual(output?.plan.steps?.map((step) => step.agent), ["scout", "worker", "reviewer"]);
});

test("route planner normalizes public topology aliases before planning", async () => {
  const catalog = AgentCatalog.load({ cwd: process.cwd() });
  const seenTopologies: string[] = [];

  const chain = await planChalinRoute({
    task: "Run a read-only hierarchical audit through scout, reviewer, context-builder, and final reviewer.",
    topology: "chain",
    steps: [
      { agent: "scout", task: "Map the project evidence read-only." },
      { agent: "reviewer", task: "Review the mapped evidence read-only." },
    ],
    expectedEffects: ["read", "verify"],
  }, {
    cwd: process.cwd(),
    catalog,
    planner: async (input) => {
      seenTopologies.push(input.topology ?? "unset");
      return {
        diagnostics: ["normalized chain alias"],
        output: {
          requiresWorkspaceMutation: false,
          plan: {
            topology: input.topology === "sequential" ? "sequential" : "dag",
            steps: input.steps,
            risk: "low",
            needsMemory: false,
            needsArtifacts: true,
            expectedEffects: ["read", "verify"],
            reason: "Alias normalization test.",
          },
        },
      };
    },
  });

  assert.equal(chain.source, "llm");
  assert.equal(chain.route.plan?.kind, "sequential");
  assert.deepEqual(seenTopologies, ["sequential"]);

  const parallel = await planChalinRoute({
    task: "Run independent read-only review slices in parallel.",
    topology: "parallel",
    stages: [{
      id: "review",
      tasks: [
        { agent: "reviewer", task: "Review architecture evidence." },
        { agent: "reviewer", task: "Review security evidence." },
      ],
    }],
    expectedEffects: ["read", "verify"],
  }, {
    cwd: process.cwd(),
    catalog,
    planner: async (input) => {
      seenTopologies.push(input.topology ?? "unset");
      return {
        diagnostics: ["normalized parallel alias"],
        output: {
          requiresWorkspaceMutation: false,
          plan: {
            topology: input.topology === "dag" ? "dag" : "sequential",
            stages: input.stages,
            risk: "low",
            needsMemory: false,
            needsArtifacts: true,
            expectedEffects: ["read", "verify"],
            reason: "Alias normalization test.",
          },
        },
      };
    },
  });

  assert.equal(parallel.source, "llm");
  assert.equal(parallel.route.plan?.kind, "dag");
  assert.deepEqual(seenTopologies, ["sequential", "dag"]);
});

test("route planner prompt separates broad audit, synthesis, planning, and mutation responsibilities", () => {
  const source = fs.readFileSync(path.join(process.cwd(), "src/routing/route-planner.ts"), "utf-8");

  assert.match(source, /First decompose the task into responsibilities/);
  assert.match(source, /parallel focused review\/research slices/);
  assert.match(source, /fan-in synthesis/);
  assert.match(source, /Do not flatten explicit or semantic parent\/child delegation/);
  assert.match(source, /Agnostic nested-delegation examples/);
  assert.match(source, /Do not use a planning agent as a generic auditor/);
  assert.match(source, /If writes are not expected, do not add mutation agents/);
});

test("structured route planner rejects extra fields, step budgets, incoherent effects, and unknown agents", () => {
  const catalog = AgentCatalog.load({ cwd: process.cwd() });
  const base = {
    topology: "sequential",
    steps: [
      {
        agent: "scout",
        task: "Inspect the exact files and tests needed for this delegated task.",
      },
    ],
    risk: "low",
    needsMemory: false,
    needsArtifacts: false,
    expectedEffects: ["read"],
    requiresWorkspaceMutation: false,
    reason: "The task only needs bounded read-only evidence.",
  };

  assert.equal(validateChalinRoutePlannerOutput({ ...base, extra: "nope" }, catalog), undefined);
  assert.equal(validateChalinRoutePlannerOutput({ ...base, expectedEffects: ["read"], requiresWorkspaceMutation: true }, catalog), undefined);
  assert.equal(validateChalinRoutePlannerOutput({
    ...base,
    steps: [
      {
        agent: "scout",
        task: "Inspect the exact files and tests needed for this delegated task.",
        budget: "normal",
      },
    ],
  }, catalog), undefined);
  assert.equal(validateChalinRoutePlannerOutput({
    ...base,
    steps: [
      {
        agent: "made-up-agent",
        task: "Inspect the exact files and tests needed for this delegated task.",
      },
    ],
  }, catalog), undefined);
  assert.equal(validateChalinRoutePlannerOutput({
    ...base,
    steps: [
      {
        agent: "scout",
        task: "Inspect the exact files and tests needed for this delegated task.",
        expectedEffects: ["delete"],
      },
    ],
  }, catalog), undefined);
});

test("planned WorkUnits use LLM step expectedEffects instead of agent-name heuristics", () => {
  const catalog = AgentCatalog.load({ cwd: process.cwd() });
  const output = validateChalinRoutePlannerOutput({
    topology: "sequential",
    steps: [
      {
        id: "mutate-with-custom-agent",
        agent: "scout",
        task: "Apply the bounded implementation change and capture concrete verification evidence.",
        expectedEffects: ["read", "write", "verify"],
        files: ["src/parser.ts", "test/parser.test.ts"],
      },
      {
        id: "verify-with-custom-agent",
        agent: "worker",
        task: "Independently verify the changed behavior and report exact evidence.",
        expectedEffects: ["read", "verify"],
      },
    ],
    risk: "medium",
    needsMemory: false,
    needsArtifacts: true,
    expectedEffects: ["read", "write", "verify"],
    requiresWorkspaceMutation: true,
    reason: "The LLM assigned effects explicitly, so the harness should not infer responsibility from names.",
  }, catalog);

  assert.deepEqual(output?.plan.steps?.map((step) => step.expectedEffects), [
    ["read", "write", "verify"],
    ["read", "verify"],
  ]);

  const route = routeFromPlan(output!.plan);
  const planned = planStepsWithWorkUnits(route);

  assert.equal(planned.workUnits[0]?.kind, "implementation");
  assert.deepEqual(planned.workUnits[0]?.expectedEffects, ["read", "write", "verify"]);
  assert.equal(planned.workUnits[0]?.workerStepId, "step-1");
  assert.equal(planned.workUnits[0]?.reviewerStepId, undefined);
  assert.equal(planned.workUnits[1]?.kind, "review");
  assert.deepEqual(planned.workUnits[1]?.expectedEffects, ["read", "verify"]);
  assert.equal(planned.workUnits[1]?.workerStepId, undefined);
  assert.equal(planned.workUnits[1]?.reviewerStepId, "step-2");
});

test("primary supplied route steps are proposals and do not bypass the structured planner", async () => {
  const catalog = AgentCatalog.load({ cwd: process.cwd() });
  let plannerCalled = false;
  const result = await planChalinRoute({
    task: "Inspect the routing module and produce a read-only recommendation.",
    topology: "sequential",
    expectedEffects: ["read"],
    steps: [
      {
        agent: "scout",
        task: "Primary-proposed step that must not be treated as authoritative.",
      },
    ],
  }, {
    cwd: process.cwd(),
    catalog,
    planner: async () => {
      plannerCalled = true;
      return {
        diagnostics: ["planner chose semantic route"],
        output: {
          requiresWorkspaceMutation: false,
          plan: {
            topology: "sequential",
            steps: [
              {
                agent: "planner",
                task: "Inspect routing evidence and produce the bounded read-only recommendation.",
              },
            ],
            risk: "low",
            needsMemory: false,
            needsArtifacts: false,
            expectedEffects: ["read"],
            reason: "The delegated task needs a read-only planning recommendation, not the primary proposal.",
          },
        },
      };
    },
  });

  assert.equal(plannerCalled, true);
  assert.equal(result.source, "llm");
  assert.deepEqual(result.route.agents, ["planner"]);
  assert.deepEqual(result.diagnostics, ["planner chose semantic route"]);
});

test("auto route uses the injected structured planner output as the selected route", async () => {
  const catalog = AgentCatalog.load({ cwd: process.cwd() });
  const result = await planChalinRoute({
    task: "Fix the parser bug and update the nearest regression test.",
    topology: "auto",
  }, {
    cwd: process.cwd(),
    catalog,
    planner: async () => ({
      diagnostics: ["stub structured planner"],
      output: {
        requiresWorkspaceMutation: true,
        plan: {
          topology: "sequential",
          steps: [
            {
              agent: "worker",
              task: "Implement the parser fix and update the nearest regression test.",
            },
            {
              agent: "reviewer",
              task: "Review the diff and focused test output for correctness.",
            },
          ],
          risk: "medium",
          needsMemory: false,
          needsArtifacts: true,
          expectedEffects: ["read", "write", "verify"],
          reason: "Injected structured planner route for a mutation task.",
        },
      },
    }),
  });

  assert.equal(result.source, "llm");
  assert.deepEqual(result.route.agents, ["worker", "reviewer"]);
  assert.deepEqual(result.diagnostics, ["stub structured planner"]);
});

test("route guards validate mutation coverage without inventing worker or reviewer steps", () => {
  const catalog = AgentCatalog.load({ cwd: process.cwd() });
  const route = routeFromPlan({
    topology: "sequential",
    expectedEffects: ["read", "write", "verify"],
    steps: [
      {
        agent: "scout",
        task: "Inspect the files that would need mutation without actually editing them.",
      },
    ],
    reason: "Invalid mutation route for guard validation.",
  });

  const normalized = normalizeRouteForExecution(route, {
    requiresWorkspaceMutation: true,
    agents: executableAgents(catalog),
  });

  assert.equal(normalized.kind, "ask-user");
  assert.equal(normalized.plan, undefined);
  assert.match(normalized.reason, /missing write-capable/i);
  assert.doesNotMatch(normalized.reason, /added worker|added reviewer/i);
});

test("route guards require an independent reviewer when a mutation route has a worker", () => {
  const catalog = AgentCatalog.load({ cwd: process.cwd() });
  const route = routeFromPlan({
    topology: "sequential",
    expectedEffects: ["read", "write", "verify"],
    steps: [
      {
        agent: "worker",
        task: "Implement the parser fix and run the nearest verification.",
        expectedEffects: ["read", "write", "verify"],
      },
    ],
    reason: "Invalid mutation route without independent review.",
  });

  const normalized = normalizeRouteForExecution(route, {
    requiresWorkspaceMutation: true,
    agents: executableAgents(catalog),
  });

  assert.equal(normalized.kind, "ask-user");
  assert.match(normalized.reason, /independent reviewer/i);
  assert.doesNotMatch(normalized.reason, /added worker|added reviewer/i);
});

test("route guards defer mutation coverage for discovered WorkUnits without stripping LLM-selected steps", () => {
  const catalog = AgentCatalog.load({ cwd: process.cwd() });
  const route = routeFromPlan({
    topology: "sequential",
    expectedEffects: ["read", "write", "verify"],
    workUnitStrategy: "discover",
    fanoutAuthorized: true,
    steps: [
      {
        agent: "scout",
        task: "Discover independent bounded work units before mutation.",
      },
      {
        agent: "planner",
        task: "Validate discovered work unit boundaries and dependency ordering.",
      },
    ],
    reason: "The route must discover WorkUnits before deciding executable mutation coverage.",
  });

  const normalized = normalizeRouteForExecution(route, {
    requiresWorkspaceMutation: true,
    agents: executableAgents(catalog),
  });

  assert.equal(normalized.kind, "multi-agent-sequential");
  assert.deepEqual(normalized.agents, ["scout", "planner"]);
  assert.equal(normalized.plan?.kind, "sequential");
  assert.deepEqual(normalized.plan?.kind === "sequential" ? normalized.plan.steps.map((step) => step.agent) : [], ["scout", "planner"]);
  assert.equal(normalized.reason.includes("removed"), false);
  assert.equal(normalized.reason.includes("missing write-capable"), false);
});

test("route guards do not escalate risk from protected path mentions before an action occurs", () => {
  const catalog = AgentCatalog.load({ cwd: process.cwd() });
  const route = routeFromPlan({
    topology: "sequential",
    expectedEffects: ["read"],
    risk: "low",
    steps: [
      {
        agent: "scout",
        task: "Read docs that mention deleting .env files and explain the safety implications.",
      },
    ],
    reason: "Read-only safety analysis can mention protected paths without executing a destructive action.",
  });

  const normalized = normalizeRouteForExecution(route, {
    requiresWorkspaceMutation: false,
    agents: executableAgents(catalog),
  });

  assert.equal(normalized.kind, "multi-agent-sequential");
  assert.equal(normalized.risk, "low");
  assert.deepEqual(normalized.agents, ["scout"]);
});

test("discovered WorkUnits materialize planner handoff instead of hardcoded executor and reviewer agents", () => {
  const cwd = tempDir("pi-chalin-fanout-planner-");
  try {
    const route = routeFromPlan({
      topology: "sequential",
      expectedEffects: ["read", "write", "verify"],
      workUnitStrategy: "discover",
      fanoutAuthorized: true,
      steps: [
        {
          agent: "scout",
          task: "Discover independent bounded work units for the requested mutation.",
        },
      ],
      reason: "Discover bounded work units before execution.",
    });
    const run = createRunState(route, cwd, "Apply the discovered independent changes.");
    const source = run.steps[0]!;
    source.status = "complete";
    source.output = {
      agent: "scout",
      text: "Discovered two independent write units.",
      handoff: "Discovered two independent write units.",
      structuredHandoff: {
        summary: "Two independent units were found.",
        changedFiles: [],
        verification: [],
        evidenceClaims: [],
        risks: [],
        nextActions: [],
        requiresHumanInput: false,
        humanInputQuestions: [],
        workUnits: [
          {
            id: "parser",
            title: "Parser regression",
            scope: ["Fix parser behavior"],
            files: ["src/parser.ts", "test/parser.test.ts"],
            dependencies: [],
            expectedEffects: ["read", "write", "verify"],
            acceptanceCriteria: ["Parser regression test passes."],
          },
          {
            id: "docs",
            title: "Docs update",
            scope: ["Update parser documentation"],
            files: ["README.md"],
            dependencies: [],
            expectedEffects: ["read", "write", "verify"],
            acceptanceCriteria: ["Docs reflect parser behavior."],
          },
        ],
      },
      memoryCandidates: [],
      raw: "Discovered two independent write units.",
      warnings: [],
    };

    assert.equal(expandWorkUnitsFromHandoff(run, source), true);
    const fanoutSteps = run.steps.filter((step) => step.id !== source.id);

    assert.equal(fanoutSteps.length, 1);
    assert.equal(fanoutSteps[0]?.agent, "planner");
    assert.match(fanoutSteps[0]?.task ?? "", /decide the executable route/i);
    assert.notDeepEqual(fanoutSteps.map((step) => step.agent), ["worker", "reviewer"]);
    assert.equal(run.workUnits?.filter((unit) => unit.createdFrom === "fanout" && unit.kind !== "planning").length, 2);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test("discovered WorkUnits do not queue a fanout planner when a planner stage is already pending", () => {
  const cwd = tempDir("pi-chalin-fanout-existing-planner-");
  try {
    const route = routeFromPlan({
      topology: "dag",
      expectedEffects: ["read", "write", "verify"],
      workUnitStrategy: "discover",
      fanoutAuthorized: true,
      stages: [
        {
          id: "evidence",
          tasks: [
            {
              id: "discover",
              agent: "scout",
              task: "Discover bounded work units for the requested mutation.",
              expectedEffects: ["read"],
            },
          ],
        },
        {
          id: "architecture-plan",
          tasks: [
            {
              id: "plan",
              agent: "planner",
              task: "Synthesize the discovered work into one executable implementation plan.",
              expectedEffects: ["read", "verify"],
            },
          ],
        },
      ],
      reason: "Discover bounded work units before execution.",
    });
    const run = createRunState(route, cwd, "Apply the discovered independent changes.");
    const source = run.steps[0]!;
    source.status = "complete";
    source.output = discoveredWorkUnitsOutput();

    assert.equal(expandWorkUnitsFromHandoff(run, source), false);
    assert.deepEqual(run.steps.map((step) => step.id), ["evidence:step-1", "architecture-plan:step-1"]);
    assert.deepEqual(run.route.plan?.kind === "dag" ? run.route.plan.stages.map((stage) => stage.id) : [], ["evidence", "architecture-plan"]);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test("planner handoff WorkUnits do not create sibling planner fanout steps", () => {
  const cwd = tempDir("pi-chalin-planner-handoff-no-sibling-planner-");
  try {
    const route = routeFromPlan({
      topology: "sequential",
      expectedEffects: ["read", "write", "verify"],
      workUnitStrategy: "discover",
      fanoutAuthorized: true,
      steps: [
        {
          agent: "planner",
          task: "Consolidate discovered WorkUnits into the global implementation plan.",
          expectedEffects: ["read", "verify"],
        },
        {
          agent: "worker",
          task: "Implement the consolidated planner handoff.",
          expectedEffects: ["read", "write", "verify"],
        },
        {
          agent: "reviewer",
          task: "Review the worker implementation.",
          expectedEffects: ["read", "verify"],
        },
      ],
      reason: "Planner should consolidate before worker execution.",
    });
    const run = createRunState(route, cwd, "Apply the discovered independent changes.");
    const source = run.steps[0]!;
    source.status = "complete";
    source.output = { ...discoveredWorkUnitsOutput(), agent: "planner" };

    assert.equal(expandWorkUnitsFromHandoff(run, source), false);
    assert.deepEqual(run.steps.map((step) => step.agent), ["planner", "worker", "reviewer"]);
    assert.equal(run.steps.filter((step) => step.agent === "planner").length, 1);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test("discovered WorkUnit fanout planner is inserted after the source stage instead of appended after downstream work", () => {
  const cwd = tempDir("pi-chalin-fanout-insert-order-");
  try {
    const route = routeFromPlan({
      topology: "dag",
      expectedEffects: ["read", "write", "verify"],
      workUnitStrategy: "discover",
      fanoutAuthorized: true,
      stages: [
        {
          id: "evidence",
          tasks: [
            {
              id: "discover",
              agent: "scout",
              task: "Discover bounded work units for the requested mutation.",
              expectedEffects: ["read"],
            },
            {
              id: "context",
              agent: "researcher",
              task: "Gather external package guidance.",
              expectedEffects: ["read"],
            },
          ],
        },
        {
          id: "validation",
          tasks: [
            {
              id: "review",
              agent: "reviewer",
              task: "Review the final implementation.",
              expectedEffects: ["read", "verify"],
            },
          ],
        },
      ],
      reason: "Discover bounded work units before execution.",
    });
    const run = createRunState(route, cwd, "Apply the discovered independent changes.");
    const source = run.steps[0]!;
    source.status = "complete";
    source.output = discoveredWorkUnitsOutput();
    run.steps[1]!.status = "complete";

    assert.equal(expandWorkUnitsFromHandoff(run, source), true);
    assert.deepEqual(run.steps.map((step) => step.id), [
      "evidence:step-1",
      "evidence:step-2",
      "fanout-evidence-step-1-route-plan:step-1",
      "validation:step-1",
    ]);
    assert.deepEqual(run.route.plan?.kind === "dag" ? run.route.plan.stages.map((stage) => stage.id) : [], [
      "evidence",
      "fanout-evidence-step-1-route-plan",
      "validation",
    ]);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test("discovered write WorkUnits proceed when the agent handoff does not require human input", () => {
  const cwd = tempDir("pi-chalin-discovered-workunits-");
  try {
    const route = routeFromPlan({
      topology: "sequential",
      expectedEffects: ["read", "write", "verify"],
      workUnitStrategy: "discover",
      fanoutAuthorized: false,
      steps: [
        {
          agent: "scout",
          task: "Discover bounded work units inside the requested implementation scope.",
        },
      ],
      reason: "Discover bounded work units before execution.",
    });
    const run = createRunState(route, cwd, "Implement the requested API client across all required surfaces.");
    const source = run.steps[0]!;
    source.status = "complete";
    source.output = {
      agent: "scout",
      text: "Discovered required implementation units.",
      handoff: "Discovered required implementation units.",
      structuredHandoff: {
        summary: "The requested implementation requires API export, client package, and website consumption units.",
        changedFiles: [],
        verification: [],
        evidenceClaims: [],
        risks: [],
        nextActions: [],
        requiresHumanInput: false,
        humanInputQuestions: [],
        workUnits: [
          {
            id: "api-export",
            title: "Add OpenAPI export",
            scope: ["Add API contract generation."],
            files: ["apps/api/package.json", "apps/api/scripts/generate-openapi.ts"],
            dependencies: [],
            expectedEffects: ["read", "write", "verify"],
            acceptanceCriteria: ["OpenAPI contract can be generated."],
          },
          {
            id: "client-package",
            title: "Create API client package",
            scope: ["Create generated API client package."],
            files: ["packages/api-client/package.json", "packages/api-client/src/index.ts"],
            dependencies: ["api-export"],
            expectedEffects: ["read", "write", "verify"],
            acceptanceCriteria: ["API client package builds."],
          },
          {
            id: "website-consumption",
            title: "Update website consumption",
            scope: ["Use generated client in website."],
            files: ["apps/website/package.json", "apps/website/src/api.ts"],
            dependencies: ["client-package"],
            expectedEffects: ["read", "write", "verify"],
            acceptanceCriteria: ["Website consumes generated client."],
          },
        ],
      },
      memoryCandidates: [],
      raw: "Discovered required implementation units.",
      warnings: [],
    };

    assert.equal(expandWorkUnitsFromHandoff(run, source), true);
    assert.equal(run.recoveryState?.blockedByHumanInput, undefined);
    assert.equal(run.steps.some((step) => step.status === "skipped"), false);
    assert.doesNotMatch(run.warnings.join("\n"), /fanout authorization|Which discovered target/i);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test("empty discovered WorkUnits warn about WorkUnits, not fanout", () => {
  const cwd = tempDir("pi-chalin-empty-workunits-");
  try {
    const route = routeFromPlan({
      topology: "sequential",
      expectedEffects: ["read", "write", "verify"],
      workUnitStrategy: "discover",
      fanoutAuthorized: false,
      steps: [
        {
          agent: "scout",
          task: "Discover bounded units inside the requested scope.",
          expectedEffects: ["read"],
        },
      ],
    });
    const run = createRunState(route, cwd, "Discover bounded units.");
    const source = run.steps[0]!;
    source.status = "complete";
    source.output = {
      agent: "scout",
      text: "No safe units found.",
      handoff: "No safe units found.",
      structuredHandoff: {
        summary: "No safe units found.",
        changedFiles: [],
        verification: ["read package metadata"],
        evidenceClaims: [],
        risks: [],
        nextActions: [],
        workUnits: [],
      },
      memoryCandidates: [],
      raw: "No safe units found.",
      warnings: [],
    };

    assert.equal(expandWorkUnitsFromHandoff(run, source), false);
    assert.match(run.warnings.join("\n"), /WorkUnit discovery/i);
    assert.doesNotMatch(run.warnings.join("\n"), /fanout/i);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test("nested delegation enforces parent-role architecture boundaries", async () => {
  const catalog = AgentCatalog.load({ cwd: process.cwd() });
  const agents = executableAgents(catalog);
  const plannerAgent = catalog.resolve("planner").agent!;
  const workerAgent = catalog.resolve("worker").agent!;
  const reviewerAgent = catalog.resolve("reviewer").agent!;
  let plannerCalled = false;

  const plannerRejectsWorker = await planNestedDelegationRoute({
    task: "Plan detailed implementation slices for parser and docs.",
    reason: "The planner needs narrower planning shards before consolidating the global plan.",
    requiresWorkspaceMutation: true,
  }, {
    cwd: process.cwd(),
    agents,
    parentAgent: plannerAgent,
    planner: async () => ({
      diagnostics: ["nested planner selected an invalid worker route"],
      output: {
        requiresWorkspaceMutation: true,
        plan: {
          topology: "sequential",
          steps: [
            {
              agent: "worker",
              task: "Implement parser and docs from the planner child route.",
            },
          ],
          risk: "medium",
          needsMemory: false,
          needsArtifacts: true,
          expectedEffects: ["read", "write", "verify"],
          reason: "Invalid nested planner route.",
        },
      },
    }),
  });

  assert.equal(plannerRejectsWorker.source, "failed");
  assert.equal(plannerRejectsWorker.route.kind, "ask-user");
  assert.match(plannerRejectsWorker.route.reason, /planner nested delegation is planning-only/i);

  const plannerChildren = await planNestedDelegationRoute({
    task: "Plan detailed implementation slices for parser and docs.",
    reason: "The planner needs narrower planning shards before consolidating the global plan.",
    expectedEffects: ["read"],
  }, {
    cwd: process.cwd(),
    agents,
    parentAgent: plannerAgent,
    planner: async () => ({
      diagnostics: ["nested planner selected planning shards"],
      output: {
        requiresWorkspaceMutation: false,
        plan: {
          topology: "dag",
          stages: [{
            id: "planning-shards",
            tasks: [
              { agent: "planner", task: "Plan the parser implementation slice." },
              { agent: "planner", task: "Plan the docs implementation slice." },
            ],
          }],
          risk: "low",
          needsMemory: false,
          needsArtifacts: true,
          expectedEffects: ["read"],
          reason: "Planning-only nested route.",
        },
      },
    }),
  });

  assert.equal(plannerChildren.source, "llm");
  assert.deepEqual(plannerChildren.route.agents, ["planner", "planner"]);

  const workerRejectsReviewerChild = await planNestedDelegationRoute({
    task: "Resolve the nested parser and docs work with verification.",
    reason: "The current worker discovered independently bounded ownership.",
    requiresWorkspaceMutation: true,
  }, {
    cwd: process.cwd(),
    agents,
    parentAgent: workerAgent,
    planner: async () => {
      plannerCalled = true;
      return {
        diagnostics: ["nested planner selected route"],
        output: {
          requiresWorkspaceMutation: true,
          plan: {
            topology: "sequential",
            steps: [
              {
                agent: "worker",
                task: "Implement the nested parser and docs work with focused verification.",
              },
              {
                agent: "reviewer",
                task: "Review the nested diff and verification evidence.",
              },
            ],
            risk: "medium",
            needsMemory: false,
            needsArtifacts: true,
            expectedEffects: ["read", "write", "verify"],
            reason: "Nested delegation requires mutation and independent verification.",
          },
        },
      };
    },
  });

  assert.equal(plannerCalled, true);
  assert.equal(workerRejectsReviewerChild.source, "failed");
  assert.equal(workerRejectsReviewerChild.route.kind, "ask-user");
  assert.match(workerRejectsReviewerChild.route.reason, /worker nested delegation is implementation-only/i);

  const reviewerChildren = await planNestedDelegationRoute({
    task: "Split the broad security audit into focused auth, logging, and secret-handling review slices.",
    reason: "The reviewer found independent risk surfaces that need focused review children before one parent verdict.",
    expectedEffects: ["read", "verify"],
  }, {
    cwd: process.cwd(),
    agents,
    parentAgent: reviewerAgent,
    planner: async () => ({
      diagnostics: ["nested planner selected reviewer children"],
      output: {
        requiresWorkspaceMutation: false,
        plan: {
          topology: "dag",
          stages: [{
            id: "review-slices",
            tasks: [
              { agent: "reviewer", task: "Review auth boundaries and token lifecycle evidence." },
              { agent: "reviewer", task: "Review logging and redaction evidence for sensitive data." },
              { agent: "reviewer", task: "Review secret handling and configuration exposure evidence." },
            ],
          }],
          risk: "medium",
          needsMemory: false,
          needsArtifacts: true,
          expectedEffects: ["read", "verify"],
          reason: "Review-only nested route.",
        },
      },
    }),
  });

  assert.equal(reviewerChildren.source, "llm");
  assert.deepEqual(reviewerChildren.route.agents, ["reviewer", "reviewer", "reviewer"]);

  const reviewerRejectsWrite = await planNestedDelegationRoute({
    task: "Review and repair the security issues.",
    reason: "Invalid reviewer nested route tries to mutate.",
    requiresWorkspaceMutation: true,
  }, {
    cwd: process.cwd(),
    agents,
    parentAgent: reviewerAgent,
    planner: async () => ({
      diagnostics: ["nested planner selected invalid reviewer write route"],
      output: {
        requiresWorkspaceMutation: true,
        plan: {
          topology: "sequential",
          steps: [
            { agent: "reviewer", task: "Review and modify the security implementation.", expectedEffects: ["read", "write", "verify"] },
          ],
          risk: "medium",
          needsMemory: false,
          needsArtifacts: true,
          expectedEffects: ["read", "write", "verify"],
          reason: "Invalid review-only nested route.",
        },
      },
    }),
  });

  assert.equal(reviewerRejectsWrite.source, "failed");
  assert.equal(reviewerRejectsWrite.route.kind, "ask-user");
  assert.match(reviewerRejectsWrite.route.reason, /reviewer nested delegation is review-only/i);

  const unavailable = await planNestedDelegationRoute({
    task: "Resolve the nested parser and docs work with verification.",
    reason: "The current worker discovered independently bounded ownership.",
    requiresWorkspaceMutation: true,
  }, {
    cwd: process.cwd(),
    agents,
    parentAgent: workerAgent,
    planner: async () => ({ diagnostics: ["planner offline"] }),
  });

  assert.equal(unavailable.source, "failed");
  assert.equal(unavailable.route.plan, undefined);
  assert.equal(unavailable.route.kind, "ask-user");
  assert.match(unavailable.route.reason, /planner offline/);
  assert.equal(unavailable.route.agents.length, 0);
});

test("repair cycles reuse LLM-selected responsibilities instead of hardcoded worker reviewer agents", async () => {
  const cwd = tempDir("pi-chalin-custom-repair-");
  try {
    const route = routeFromPlan({
      topology: "sequential",
      expectedEffects: ["read", "write", "verify"],
      steps: [
        {
          id: "apply",
          agent: "impl-a",
          task: "Apply the parser mutation and collect verification evidence.",
          expectedEffects: ["read", "write", "verify"],
          files: ["src/parser.ts"],
        },
        {
          id: "audit",
          agent: "audit-a",
          task: "Verify the parser mutation against the requested behavior.",
          expectedEffects: ["read", "verify"],
        },
      ],
      risk: "medium",
      needsMemory: false,
      needsArtifacts: true,
      reason: "Custom agents were selected by the structured planner.",
    });
    const run = createRunState(route, cwd, "Fix the parser behavior.");
    const implementation = run.steps[0]!;
    implementation.status = "complete";
    implementation.output = {
      agent: "impl-a",
      text: "Implemented parser change.",
      handoff: "Implemented parser change.",
      structuredHandoff: {
        summary: "Parser behavior changed.",
        changedFiles: ["src/parser.ts"],
        verification: ["pnpm test parser"],
        evidenceClaims: [],
        risks: [],
        nextActions: [],
      },
      memoryCandidates: [],
      raw: "Implemented parser change.",
      warnings: [],
    };
    implementation.metrics = {
      durationMs: 1,
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      toolCalls: 1,
      toolCallsByName: {},
      filesTouched: ["src/parser.ts"],
    };
    const audit = run.steps[1]!;
    audit.status = "complete";
    audit.output = {
      agent: "audit-a",
      text: "Parser verification failed.",
      handoff: "Parser verification failed.",
      structuredHandoff: {
        summary: "Parser verification found a blocking gap.",
        changedFiles: [],
        verification: ["reviewed src/parser.ts"],
        evidenceClaims: [],
        risks: ["parser edge case still fails"],
        nextActions: [],
      },
      reviewerVerdict: {
        verdict: "fail",
        blockingFindings: ["Parser edge case still fails in src/parser.ts."],
        missingCoverage: [],
        evidence: ["reviewed src/parser.ts"],
        repairFiles: ["src/parser.ts"],
        residualRisks: [],
        requiredRepair: "Fix the parser edge case.",
      },
      memoryCandidates: [],
      raw: "Parser verification failed.",
      warnings: [],
    };

    const agents = new Map<string, AgentDefinition>([
      ["impl-a", customAgent("impl-a", "implementation", ["inspect-files", "edit-files", "validate"])],
      ["audit-a", customAgent("audit-a", "review", ["inspect-files", "validate"])],
    ]);
    const resumed = await new MockWorkerRunner().resume(run, { cwd, agents });
    const repairSteps = resumed.steps.filter((step) => step.id.startsWith("review-repair-"));

    assert.ok(repairSteps.some((step) => step.id.includes("-mutation") && step.agent === "impl-a"));
    assert.ok(repairSteps.some((step) => step.id.includes("-verification") && step.agent === "audit-a"));
    assert.equal(resumed.route.agents.includes("worker"), false);
    assert.equal(resumed.route.agents.includes("reviewer"), false);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});
