import assert from "node:assert/strict";
import { afterEach, test } from "vitest";
import { routeFromPlan } from "../src/kernel/kernel.ts";
import { createRunState } from "../src/runner/runner-state.ts";
import {
  activateSkillForTurn,
  beginChalinTurn,
  beginChalinRouteInvocation,
  clearLiveStepSession,
  finishChalinRouteInvocation,
  getChalinRouteInvocations,
  getLatestRun,
  getInlineCompletionGatePayload,
  getLiveStepSession,
  getSkillOverridesForTurn,
  hasInlineToolStarted,
  getInlineCriticalGuardContextMessage,
  recordCompletionGateBlock,
  recordInlineToolStart,
  recordInlineToolCompletion,
  resetRuntimeState,
  setLatestRun,
  setLiveStepSession,
} from "../src/runtime/state.ts";
import type { LiveStepSessionRef } from "../src/runtime/state.ts";

afterEach(() => {
  resetRuntimeState();
});

function route() {
  return routeFromPlan({
    topology: "sequential",
    expectedEffects: ["read"],
    steps: [{ agent: "scout", task: "Map a bounded evidence surface." }],
  });
}

function liveSession(runId: string, stepId: string, marker: string): LiveStepSessionRef {
  return {
    runId,
    stepId,
    agent: "scout",
    cwd: process.cwd(),
    startedAt: new Date(0).toISOString(),
    getMessages: () => [marker],
  };
}

test("resetRuntimeState clears module runtime state without stale storage wrappers", () => {
  const planned = route();
  const run = createRunState(planned, process.cwd(), "Map project", { sessionId: "session-a" });
  const live = liveSession(run.id, run.steps[0]!.id, "first");
  setLatestRun(run);
  setLiveStepSession(live);
  activateSkillForTurn("built-in:manual-review");
  recordInlineToolStart({ toolName: "chalin_route" });
  const invocation = beginChalinRouteInvocation({ dryRun: false, route: planned });
  assert.equal(invocation.allowed, true);
  finishChalinRouteInvocation(invocation.invocationId, "complete");

  resetRuntimeState();

  assert.equal(getLatestRun(), undefined);
  assert.equal(getLiveStepSession(run.id, run.steps[0]!.id), undefined);
  assert.equal(getChalinRouteInvocations().length, 0);
  assert.deepEqual([...getSkillOverridesForTurn().explicit], []);
  assert.deepEqual([...getSkillOverridesForTurn().disabled], []);
  assert.equal(hasInlineToolStarted("chalin_route"), false);
  const nextInvocation = beginChalinRouteInvocation({ dryRun: false, route: planned });
  assert.equal(nextInvocation.allowed, true);
  assert.equal(nextInvocation.invocationId, 1);
});

test("clearLiveStepSession ignores stale refs for the same run step", () => {
  const first = liveSession("run-1", "step-1", "first");
  const second = liveSession("run-1", "step-1", "second");

  setLiveStepSession(first);
  setLiveStepSession(second);
  clearLiveStepSession("run-1", "step-1", first);

  assert.equal(getLiveStepSession("run-1", "step-1"), second);
  clearLiveStepSession("run-1", "step-1", second);
  assert.equal(getLiveStepSession("run-1", "step-1"), undefined);
});

test("route invocation guard blocks completed duplicates but allows paused continuation", () => {
  const planned = route();
  const first = beginChalinRouteInvocation({ dryRun: false, route: planned });
  assert.equal(first.allowed, true);
  finishChalinRouteInvocation(first.invocationId, "paused");

  const continuation = beginChalinRouteInvocation({ dryRun: false, route: planned });
  assert.equal(continuation.allowed, true);
  finishChalinRouteInvocation(continuation.invocationId, "complete");

  const duplicate = beginChalinRouteInvocation({ dryRun: false, route: planned });
  assert.equal(duplicate.allowed, false);
  assert.match(duplicate.reason ?? "", /already completed/i);
});

test("post-mutation failure and later command evidence are left for semantic gate judgment", () => {
  recordInlineToolCompletion({
    toolName: "edit",
    path: "src/parser.py",
    argsText: JSON.stringify({ path: "src/parser.py", newText: "def parse(value):\n    return value\n" }),
  });
  const failedBehaviorCheck = recordInlineToolCompletion({
    toolName: "bash",
    command: "python - <<'PY'\nraise RuntimeError('public flow failed')\nPY",
    isError: true,
  });

  assert.equal(failedBehaviorCheck.shouldFailureNudge, true);
  assert.match(getInlineCriticalGuardContextMessage() ?? "", /evidence/i);
  assert.match(getInlineCriticalGuardContextMessage() ?? "", /same user-facing acceptance surface/i);

  const narrowerEvidence = recordInlineToolCompletion({
    toolName: "bash",
    command: "python - <<'PY'\nprint('helper check passed')\nPY",
  });

  assert.equal(narrowerEvidence.shouldCompletionNudge, false);
  assert.equal(narrowerEvidence.shouldTestCoverageNudge, true);
  assert.equal(getInlineCompletionGatePayload().state.verificationObserved, true);
  assert.equal(getInlineCompletionGatePayload().state.verificationCommand, "python - <<'PY'\nprint('helper check passed')\nPY");
});

test("source mutation records post-mutation command evidence without classifying command names", () => {
  recordInlineToolCompletion({
    toolName: "edit",
    path: "src/parser.py",
    argsText: JSON.stringify({ path: "src/parser.py", newText: "def parse(value):\n    return value\n" }),
  });

  const afterMutationGuard = getInlineCriticalGuardContextMessage() ?? "";
  assert.equal(afterMutationGuard.includes("source files changed"), true);
  assert.equal(afterMutationGuard.includes("no accepted evidence"), true);

  const narrowCheck = recordInlineToolCompletion({
    toolName: "bash",
    command: "python - <<'PY'\nprint('helper check passed')\nPY",
  });

  assert.equal(narrowCheck.shouldCompletionNudge, false);
  assert.equal(narrowCheck.shouldReadyToVerifyNudge, false);
  assert.equal(narrowCheck.shouldTestCoverageNudge, true);
  assert.equal(getInlineCompletionGatePayload().state.verificationObserved, true);
});

test("post-mutation command evidence does not depend on a harness toolchain allowlist", () => {
  recordInlineToolCompletion({
    toolName: "edit",
    path: "src/parser.py",
    argsText: JSON.stringify({ path: "src/parser.py", newText: "def parse(value):\n    return value.strip()\n" }),
  });
  recordInlineToolCompletion({
    toolName: "edit",
    path: "tests/test_parser.py",
    argsText: JSON.stringify({ path: "tests/test_parser.py", newText: "def test_parse():\n    assert parse(' x ') == 'x'\n" }),
  });

  const evidence = recordInlineToolCompletion({
    toolName: "bash",
    command: "repo-acceptance-check --changed-surface",
    observation: "custom project acceptance passed",
  });

  assert.equal(evidence.shouldCompletionNudge, true);
  assert.equal(getInlineCompletionGatePayload().state.verificationCommand, "repo-acceptance-check --changed-surface");
});

test("background bash job completion counts as post-mutation command evidence", () => {
  recordInlineToolCompletion({
    toolName: "edit",
    path: "src/parser.py",
    argsText: JSON.stringify({ path: "src/parser.py", newText: "def parse(value):\n    return value.strip()\n" }),
  });
  recordInlineToolCompletion({
    toolName: "edit",
    path: "tests/test_parser.py",
    argsText: JSON.stringify({ path: "tests/test_parser.py", newText: "def test_parse():\n    assert parse(' x ') == 'x'\n" }),
  });

  const evidence = recordInlineToolCompletion({
    toolName: "chalin_bash_job",
    command: "repo-acceptance-check --changed-surface",
    observation: "background job succeeded with project acceptance marker",
  });

  assert.equal(evidence.shouldCompletionNudge, true);
  assert.equal(getInlineCompletionGatePayload().state.verificationObserved, true);
  assert.equal(getInlineCompletionGatePayload().state.verificationCommand, "repo-acceptance-check --changed-surface");
});

test("background bash job start remains pending evidence until terminal status", () => {
  beginChalinTurn({ prompt: "change parser and run tests", cwd: process.cwd() });
  recordInlineToolCompletion({
    toolName: "edit",
    path: "src/parser.py",
    argsText: JSON.stringify({ path: "src/parser.py", newText: "def parse(value):\n    return value.strip()\n" }),
  });

  const pending = recordInlineToolCompletion({
    toolName: "chalin_bash_job",
    observation: "background job verify-parser: running",
    backgroundJobId: "verify-parser",
    backgroundJobStatus: "running",
    backgroundJobRequiredEvidence: true,
    backgroundJobCompletionAction: "resume",
  });
  const payload = getInlineCompletionGatePayload();

  assert.equal(pending.shouldCompletionNudge, false);
  assert.equal(payload.state.verificationObserved, false);
  assert.equal(payload.state.verificationCommand, undefined);
  assert.deepEqual(payload.state.backgroundJobs, [{
    id: "verify-parser",
    status: "running",
    requiredEvidence: true,
    completionAction: "resume",
  }]);
  assert.equal(payload.ledger.evidenceAfterLatestMutation, false);
  assert.equal(payload.ledger.observations.at(-1)?.status, "pending");
});

test("pre-mutation commands are not classified as verification by toolchain names", () => {
  beginChalinTurn({ prompt: "change src/parser.py", cwd: process.cwd() });

  const baseline = recordInlineToolCompletion({
    toolName: "bash",
    command: "pnpm test",
    observation: "baseline passed",
  });

  assert.equal(baseline.plan, undefined);
  assert.equal(getInlineCompletionGatePayload().state.verificationObserved, false);
});

test("inline completion gate payload exposes raw ledger and runtime state", () => {
  resetRuntimeState();
  recordInlineToolCompletion({
    toolName: "read",
    path: "tests/test_parser.py",
    observation: "existing test transforms the full fixture and checks preservation",
  });
  recordInlineToolCompletion({
    toolName: "edit",
    path: "src/parser.py",
    argsText: JSON.stringify({ path: "src/parser.py", newText: "def parse(value):\n    return value\n" }),
  });
  recordInlineToolCompletion({
    toolName: "bash",
    command: "python - <<'PY'\nprint('probe')\nPY",
    observation: "custom probe passed only the minimal changed branch",
  });
  recordCompletionGateBlock({
    canFinalize: false,
    confidence: 0.82,
    missingEvidence: ["representative fixture evidence"],
    nextAction: "expand_custom_probe",
    reason: "The first finalization attempt used narrower evidence.",
    requiredEvidence: ["rerun a full observed fixture variant"],
  });

  const payload = getInlineCompletionGatePayload({ finalAnswer: "Done." });

  assert.equal(payload.finalAnswer, "Done.");
  assert.deepEqual(payload.priorBlocks?.map((block) => [block.nextAction, block.missingEvidence, block.requiredEvidence]), [
    ["expand_custom_probe", ["representative fixture evidence"], ["rerun a full observed fixture variant"]],
  ]);
  assert.equal(payload.state.mutationObserved, true);
  assert.equal(payload.state.sourceMutationObserved, true);
  assert.deepEqual(payload.state.changedPaths, ["src/parser.py"]);
  assert.deepEqual(payload.ledger.readPaths, ["tests/test_parser.py"]);
  assert.deepEqual(payload.ledger.mutationRecords.map((item) => [item.toolName, item.path, item.afterFailedCommand]), [
    ["edit", "src/parser.py", false],
  ]);
  assert.deepEqual(payload.ledger.failedCommandsAfterMutation, []);
  assert.deepEqual(payload.ledger.postFailureMutationRecords, []);
  assert.equal(payload.ledger.commandRecords[0]?.afterLatestMutation, true);
  assert.deepEqual(payload.ledger.observations.map((item) => [item.toolName, item.path ?? item.command, item.afterLatestMutation, item.text]), [
    ["read", "tests/test_parser.py", false, "existing test transforms the full fixture and checks preservation"],
    ["bash", "python - <<'PY'\nprint('probe')\nPY", true, "custom probe passed only the minimal changed branch"],
  ]);
});
