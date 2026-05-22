import assert from "node:assert/strict";
import test from "node:test";
import { approvalDecision, DEFAULT_CONFIG } from "../src/config.ts";
import { createChildToolPolicy } from "../src/child-tools.ts";
import type { RouteDecision } from "../src/schemas.ts";

function route(risk: RouteDecision["risk"]): RouteDecision {
  return { kind: "single-agent", agents: ["worker"], risk, ambiguity: "low", needsMemory: false, needsArtifacts: true, reason: "test", plan: { kind: "single", agent: "worker", task: "x" } };
}

test("approvalDecision allows low risk under balanced mode", () => {
  assert.equal(approvalDecision(DEFAULT_CONFIG, route("low")).action, "allow");
});

test("approvalDecision asks for medium risk", () => {
  assert.equal(approvalDecision(DEFAULT_CONFIG, route("medium")).action, "ask");
});

test("approvalDecision blocks critical risk", () => {
  assert.equal(approvalDecision(DEFAULT_CONFIG, route("critical")).action, "block");
});

test("child policy compresses oversized tool output and records output/read budgets", () => {
  const policy = createChildToolPolicy({ cwd: process.cwd(), maxToolCalls: 4, allowedTools: ["read"] });
  assert.deepEqual(policy.beforeTool("read", { path: "src/index.ts" }), { allowed: true });

  const result = policy.afterTool("read", {
    content: [{ type: "text", text: "x".repeat(20_000) }],
    details: {},
  }) as { content: Array<{ text: string }>; details: { piMeshCompressed?: boolean } };

  assert.equal(result.details.piMeshCompressed, true);
  assert.ok(result.content[0]!.text.length < 7000);
  assert.match(result.content[0]!.text, /compressed by pi-mesh/);
  assert.equal(policy.metrics().outputTruncatedCount, 1);
  assert.ok(policy.metrics().readBytes < 7000);
});

test("child policy limits synthesis cross-step duplicate reads", () => {
  const policy = createChildToolPolicy({
    cwd: process.cwd(),
    maxToolCalls: 10,
    allowedTools: ["read"],
    priorFilesRead: ["src/index.ts"],
    maxCrossStepDuplicateReads: 1,
  });

  assert.deepEqual(policy.beforeTool("read", { path: "src/index.ts" }), { allowed: true });
  const blocked = policy.beforeTool("read", { path: "src/index.ts" });

  assert.equal(blocked.allowed, false);
  assert.match(blocked.reason, /cross_step_duplicate_reads=1:src\/index\.ts/);
  assert.equal(policy.metrics().budgetStopCount, 1);
  assert.equal(policy.metrics().toolCalls, 1);
});
