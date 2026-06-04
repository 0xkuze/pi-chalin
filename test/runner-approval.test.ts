import assert from "node:assert/strict";
import { test } from "vitest";
import type { RunStepMetrics } from "../src/domain/schemas.ts";
import { approvalPauseForMetrics, terminalRunStatusForSteps } from "../src/runner/runner.ts";

const baseMetrics: RunStepMetrics = {
  durationMs: 1,
  usage: {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  },
  toolCalls: 0,
  toolCallsByName: {},
};

test("approvalPauseForMetrics pauses pending approvals and rejected decisions", () => {
  const pending = approvalPauseForMetrics({
    ...baseMetrics,
    approvalRequests: [{
      id: "approval-1",
      toolName: "bash",
      reason: "llm_declared_risky_action:production migration",
      risk: "high",
      actionDescription: "bash: pnpm db:migrate --prod",
      semanticDescription: "bash: pnpm db:migrate --prod",
      paramsSummary: "pnpm db:migrate --prod",
      paramsFingerprint: "fingerprint",
      createdAt: "2026-06-03T00:00:00.000Z",
    }],
  });

  assert.equal(pending?.pauseReason, "awaiting-approval");
  assert.match(pending?.message ?? "", /pnpm db:migrate --prod/);

  const rejected = approvalPauseForMetrics({
    ...baseMetrics,
    approvalRequests: pending ? [{
      id: "approval-1",
      toolName: "bash",
      reason: "llm_declared_risky_action:production migration",
      risk: "high",
      actionDescription: "bash: pnpm db:migrate --prod",
      semanticDescription: "bash: pnpm db:migrate --prod",
      paramsSummary: "pnpm db:migrate --prod",
      paramsFingerprint: "fingerprint",
      createdAt: "2026-06-03T00:00:00.000Z",
    }] : [],
    approvalDecisions: [{
      requestId: "approval-1",
      decision: "rejected",
      approvedAction: "bash: pnpm db:migrate --prod",
      retriedAction: "bash: pnpm db:migrate --prod",
      equivalenceReason: "user rejected the pending action through chalin_interview",
      decidedBy: "worker",
      decidedAt: "2026-06-03T00:01:00.000Z",
      consumed: false,
    }],
  });

  assert.equal(rejected?.pauseReason, "human-rejected");
  assert.match(rejected?.message ?? "", /blocked by human rejection/i);

  const approved = approvalPauseForMetrics({
    ...baseMetrics,
    approvalRequests: [{
      id: "approval-1",
      toolName: "bash",
      reason: "llm_declared_risky_action:production migration",
      risk: "high",
      actionDescription: "bash: pnpm db:migrate --prod",
      semanticDescription: "bash: pnpm db:migrate --prod",
      paramsSummary: "pnpm db:migrate --prod",
      paramsFingerprint: "fingerprint",
      createdAt: "2026-06-03T00:00:00.000Z",
    }],
    approvalDecisions: [{
      requestId: "approval-1",
      decision: "approved",
      approvedAction: "bash: pnpm db:migrate --prod",
      decidedBy: "worker",
      decidedAt: "2026-06-03T00:01:00.000Z",
      consumed: true,
    }],
  });

  assert.equal(approved, undefined);
});

test("terminalRunStatusForSteps keeps human approval pauses resumable", () => {
  assert.equal(terminalRunStatusForSteps({
    steps: [{
      id: "worker",
      agent: "worker",
      task: "Run guarded migration.",
      status: "paused",
      pauseReason: "awaiting-approval",
    }],
  }, new Map()), "paused");
});
