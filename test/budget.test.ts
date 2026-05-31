import assert from "node:assert/strict";
import { test } from "bun:test";
import { evaluateBudgetUsage, estimateBudgetPreflight, policyForStep, recordBudgetCheckpoint, scoreProgress, summarizeToolUtility } from "../src/budget.ts";
import { ArtifactStore } from "../src/artifacts.ts";
import type { AgentDefinition, RunStepState } from "../src/schemas.ts";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

function tempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function agent(name: string, concern: AgentDefinition["concern"], capabilities: AgentDefinition["capabilities"] = ["inspect-files", "search-files"]): AgentDefinition {
  return {
    name,
    scope: "built-in",
    concern,
    capabilities,
    description: name,
    model: "inherit",
    tools: [],
    memory: { read: false, write: "candidate", categories: [] },
    systemPrompt: "",
    diagnostics: [],
  };
}

test("policyForStep centralizes every budget cap and scales by task/profile", () => {
  const worker = agent("worker", "implementation", ["inspect-files", "search-files", "edit-files", "validate"]);
  const policy = policyForStep(worker, { agent: "worker", task: "Implement a migration with tests", budget: "deep" }, "multi-agent-dag");

  assert.equal(policy.profile, "deep");
  assert.equal(policy.taskKind, "implementation");
  assert.equal(policy.caps.maxToolCalls, 160);
  assert.ok(policy.caps.maxSeconds >= 1800);
  assert.ok(policy.caps.maxUsd > 0);
  assert.ok(policy.caps.maxTurns >= 1);
  assert.ok(policy.caps.maxOutputChars > 0);
  assert.ok(policy.caps.maxReadBytes > 0);
  assert.ok(policy.caps.maxFilesTouched > 0);
  assert.ok(policy.caps.maxRetriesPerTool > 0);
});

test("estimateBudgetPreflight classifies long autonomous work as resumable DAG/artifact work", () => {
  const preflight = estimateBudgetPreflight({
    task: "Migrate this large codebase over several hours, split folders, validate each stage, and continue from checkpoints.",
    routeKind: "multi-agent-dag",
    steps: [
      { agent: "scout", task: "Map modules" },
      { agent: "worker", task: "Implement isolated changes", budget: "extended" },
      { agent: "reviewer", task: "Validate" },
    ],
    risk: "high",
    needsArtifacts: true,
  });

  assert.equal(preflight.taskKind, "long-autonomous");
  assert.equal(preflight.budgetProfile, "extended");
  assert.equal(preflight.resumeStrategy, "stage-checkpoint-validate-memory-next");
  assert.equal(preflight.requiresArtifacts, true);
  assert.ok(preflight.expectedStages >= 3);
  assert.ok(preflight.expectedTools >= 300);
  assert.match(preflight.recommendation, /checkpoint/i);
});

test("evaluateBudgetUsage turns exhausted budget into budget-capped checkpoint state", () => {
  const reviewer = agent("reviewer", "review");
  const policy = policyForStep(reviewer, { agent: "reviewer", task: "Review project", budget: "tight" }, "multi-agent-chain");
  const health = evaluateBudgetUsage(policy, {
    elapsedMs: policy.caps.maxSeconds * 1000 + 1,
    toolCalls: policy.caps.maxToolCalls,
    totalCostUsd: 0,
    turns: 1,
    outputChars: 100,
    readBytes: 200,
    filesTouched: 0,
    retriesByTool: {},
  });

  assert.equal(health.status, "budget-capped");
  assert.ok(health.caps.some((cap) => cap.name === "max_seconds"));
  assert.equal(health.next, "checkpoint-and-continue");
});

test("tool-call budget alone is a soft cap that can checkpoint without failing the stage", () => {
  const scout = agent("scout", "recon");
  const policy = policyForStep(scout, { agent: "scout", task: "Map project", budget: "normal" }, "multi-agent-chain");
  const health = evaluateBudgetUsage(policy, {
    elapsedMs: 1000,
    toolCalls: policy.caps.maxToolCalls,
    totalCostUsd: 0,
    turns: 1,
    outputChars: 100,
    readBytes: 200,
    filesTouched: 0,
    retriesByTool: {},
  });

  assert.equal(health.status, "warn");
  assert.ok(health.caps.some((cap) => cap.name === "max_tool_calls"));
  assert.equal(health.next, "continue");
});

test("summarizeToolUtility exposes waste and signal metrics", () => {
  const utility = summarizeToolUtility({
    findings: [
      "testing: Project uses bun:test.",
      "workflow: Checkpoints are written after each handoff.",
    ],
    toolCalls: 8,
    filesRead: ["a.ts", "b.ts", "a.ts"],
    firstSignalToolCall: 4,
    verificationDone: true,
    memoryCandidates: [
      { content: "Project uses bun:test with isolated temp dirs.", category: "testing", confidence: 0.9 },
      { content: "cmd = ['pi']", category: "agent-note", confidence: 0.5 },
    ],
  });

  assert.equal(utility.findingsPerTool, 0.25);
  assert.equal(utility.duplicateReads, 1);
  assert.equal(utility.toolCallsBeforeFirstSignal, 4);
  assert.equal(utility.verificationDone, true);
  assert.ok(utility.memoryCandidatesQuality > 0);
  assert.ok(utility.memoryCandidatesQuality < 1);
});

test("scoreProgress turns utility signals into continuation gates", () => {
  const positive = scoreProgress({
    findings: [
      "testing: Project uses bun:test.",
      "validation: nearest verification command is bun run test.",
    ],
    toolCalls: 5,
    filesRead: ["package.json", "test/budget.test.ts"],
    firstSignalToolCall: 1,
    verificationDone: true,
    memoryCandidates: [
      { content: "Project uses bun:test with isolated temp dirs.", category: "testing", confidence: 0.9 },
    ],
  });

  assert.equal(positive.level, "high");
  assert.equal(positive.gate, "continue");
  assert.ok(positive.positiveSignals.includes("verification_done"));
  assert.ok(positive.score > 0.5);

  const lowSignal = scoreProgress({
    findings: [],
    toolCalls: 12,
    filesRead: ["src/runner.ts", "src/runner.ts", "src/runner.ts"],
    verificationDone: false,
    memoryCandidates: [],
  });

  assert.equal(lowSignal.level, "low");
  assert.equal(lowSignal.gate, "checkpoint-low-signal");
  assert.ok(lowSignal.negativeSignals.includes("duplicate_reads"));
  assert.ok(lowSignal.score < 0);
});

test("evaluateBudgetUsage keeps soft caps as explicit progress gates", () => {
  const scout = agent("scout", "recon");
  const policy = policyForStep(scout, { agent: "scout", task: "Map project", budget: "normal" }, "multi-agent-chain");
  const health = evaluateBudgetUsage(policy, {
    elapsedMs: 1000,
    toolCalls: policy.caps.maxToolCalls,
    totalCostUsd: 0,
    turns: 1,
    outputChars: 100,
    readBytes: 200,
    filesTouched: 0,
    retriesByTool: {},
  }, {
    score: -0.25,
    level: "low",
    gate: "checkpoint-low-signal",
    positiveSignals: [],
    negativeSignals: ["duplicate_reads", "no_findings"],
  });

  assert.equal(health.status, "warn");
  assert.equal(health.next, "checkpoint-low-signal");
  assert.equal(health.checkpointStatus, "checkpointed-low-signal");
  assert.ok(health.warnings.some((warning) => warning.includes("progress gate checkpoint-low-signal")));
});

test("recordBudgetCheckpoint persists partial handoff when a step is budget-capped", async () => {
  const cwd = tempDir("pi-chalin-budget-checkpoint-");
  try {
    const step: RunStepState = {
      id: "stage-1:step-1",
      agent: "context-builder",
      task: "Analyze backend module",
      status: "budget-capped",
      output: {
        agent: "context-builder",
        text: "Partial backend findings.",
        handoff: "Backend uses API route handlers and needs validation.",
        memoryCandidates: [],
        raw: "Partial backend findings.",
        warnings: [],
      },
    };

    const checkpoint = await recordBudgetCheckpoint(new ArtifactStore({ cwd }), "feature-budget", step, "Reached tool cap after useful findings.");
    const state = await new ArtifactStore({ cwd }).loadFeature("feature-budget");

    assert.match(checkpoint.summary, /Backend uses API route handlers/);
    assert.equal(checkpoint.status, "paused");
    assert.equal(state?.checkpoints.length, 1);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});
