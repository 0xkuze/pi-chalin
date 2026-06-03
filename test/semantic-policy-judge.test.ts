import assert from "node:assert/strict";
import { test } from "vitest";
import { validateSemanticPolicyJudgeResult } from "../src/skills/semantic-policy-judge.ts";

test("semantic policy judge accepts typed steer fields", () => {
  const result = validateSemanticPolicyJudgeResult({
    nextAction: "repair",
    nudgeKind: "weak-test-coverage",
    reason: "The changed tests do not assert the requested boundary behavior.",
    confidence: 0.86,
    blockingGap: true,
    requiredEvidence: ["test/user-boundary.test.ts", "pnpm test"],
    steerMessage: "Patch the focused test to assert the requested boundary, then rerun `pnpm test` once.",
  });

  assert.equal(result?.nextAction, "repair");
  assert.equal(result?.nudgeKind, "weak-test-coverage");
  assert.equal(result?.steerMessage, "Patch the focused test to assert the requested boundary, then rerun `pnpm test` once.");
});

test("semantic policy judge rejects untyped or extra structured output", () => {
  assert.equal(validateSemanticPolicyJudgeResult({
    nextAction: "repair",
    nudgeKind: "made-up-gap",
    reason: "Invalid gap category.",
    confidence: 0.8,
    blockingGap: true,
    requiredEvidence: ["test"],
  }), undefined);

  assert.equal(validateSemanticPolicyJudgeResult({
    nextAction: "repair",
    reason: "Extra properties must not be accepted.",
    confidence: 0.8,
    blockingGap: true,
    requiredEvidence: ["test"],
    extra: "nope",
  }), undefined);
});
