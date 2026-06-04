import assert from "node:assert/strict";
import { afterEach, test } from "vitest";
import { routeFromPlan } from "../src/kernel/kernel.ts";
import { createRunState } from "../src/runner/runner-state.ts";
import {
  activateSkillForTurn,
  beginChalinRouteInvocation,
  clearLiveStepSession,
  finishChalinRouteInvocation,
  getChalinRouteInvocations,
  getLatestRun,
  getLiveStepSession,
  getSkillOverridesForTurn,
  hasInlineToolStarted,
  recordInlineToolStart,
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
