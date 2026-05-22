import assert from "node:assert/strict";
import { test } from "bun:test";
import { analyzeTrajectory, scoreTrajectory } from "../evals/trajectory.ts";
import type { RunState } from "../src/schemas.ts";

function run(overrides: Partial<RunState> = {}): RunState {
  return {
    id: "chalin-test",
    route: {
      kind: "multi-agent-chain",
      agents: ["scout", "worker", "reviewer"],
      risk: "medium",
      ambiguity: "low",
      needsMemory: true,
      needsArtifacts: true,
      reason: "test",
      plan: { kind: "chain", steps: [{ agent: "scout", task: "scan" }, { agent: "worker", task: "edit" }, { agent: "reviewer", task: "verify" }] },
    },
    status: "complete",
    startedAt: new Date().toISOString(),
    endedAt: new Date().toISOString(),
    warnings: [],
    steps: [
      {
        id: "step-1",
        agent: "scout",
        task: "scan",
        status: "complete",
        output: { agent: "scout", text: "## Findings\n- src/index.ts controls entrypoint.", handoff: "src/index.ts", raw: "src/index.ts", warnings: [], memoryCandidates: [] },
        metrics: { durationMs: 10, usage: emptyUsage(), toolCalls: 4, toolCallsByName: { read: 3, grep: 1 }, filesRead: ["src/index.ts", "src/config.ts"] },
      },
      {
        id: "step-2",
        agent: "worker",
        task: "edit",
        status: "complete",
        output: { agent: "worker", text: "Changed one line.", handoff: "Changed one line.", raw: "Changed one line.", warnings: [], memoryCandidates: [] },
        metrics: { durationMs: 10, usage: emptyUsage(), toolCalls: 3, toolCallsByName: { read: 1, edit: 1, bash: 1 }, filesRead: ["src/index.ts"] },
      },
      {
        id: "step-3",
        agent: "reviewer",
        task: "verify",
        status: "complete",
        output: { agent: "reviewer", text: "Validation passed.", handoff: "Validation passed.", raw: "Validation passed.", warnings: [], memoryCandidates: [] },
        metrics: { durationMs: 10, usage: emptyUsage(), toolCalls: 1, toolCallsByName: { bash: 1 } },
      },
    ],
    ...overrides,
  };
}

test("analyzeTrajectory passes a healthy verified mutation trajectory", () => {
  const report = analyzeTrajectory(run());

  assert.equal(report.pass, true);
  assert.equal(report.findings.toolMisuse.pass, true);
  assert.equal(report.findings.verificationSkipped.pass, true);
  assert.equal(report.findings.budgetWaste.pass, true);
});

test("analyzeTrajectory detects tool misuse, skipped verification, loops, large rewrites, hallucinated completion and budget waste", () => {
  const bad = run({
    steps: [
      {
        id: "step-1",
        agent: "worker",
        task: "rewrite implementation",
        status: "complete",
        output: { agent: "worker", text: "Done.", handoff: "Done.", raw: "Done.", warnings: [], memoryCandidates: [] },
        metrics: {
          durationMs: 20,
          usage: emptyUsage(),
          toolCalls: 30,
          maxToolCalls: 24,
          toolCallsByName: { bash: 3, read: 20, write: 1 },
          policyViolations: ["bash_policy:python scan.py"],
          filesRead: ["a.ts", "a.ts", "a.ts", "b.ts", "b.ts", "c.ts"],
          duplicateReadCount: 3,
          budgetStopCount: 2,
          utility: {
            findingsPerTool: 0,
            filesReadPerFinding: 6,
            duplicateReads: 3,
            toolCallsBeforeFirstSignal: 30,
            verificationDone: false,
            memoryCandidatesQuality: 0,
          },
        },
      },
    ],
    metrics: { durationMs: 20, usage: emptyUsage(), toolCalls: 30, toolCallsByName: { bash: 3, read: 20, write: 1 }, policyViolations: ["bash_policy:python scan.py"], budgetStopCount: 2, duplicateReadCount: 3 },
  });

  const report = analyzeTrajectory(bad);
  const ids = Object.values(report.findings).filter((finding) => !finding.pass).map((finding) => finding.id);

  assert.equal(report.pass, false);
  assert.ok(ids.includes("tool_misuse"));
  assert.ok(ids.includes("verification_skipped"));
  assert.ok(ids.includes("looping"));
  assert.ok(ids.includes("hallucinated_completion"));
  assert.ok(ids.includes("rewrite_large_file"));
  assert.ok(ids.includes("budget_waste"));
  assert.ok(scoreTrajectory(report) < 0.8);
});

function emptyUsage() {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
}
