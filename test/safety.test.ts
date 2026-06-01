import assert from "node:assert/strict";
import { test } from "bun:test";
import { approvalDecision, DEFAULT_CONFIG } from "../src/config.ts";
import { createChildToolPolicy } from "../src/child-tools.ts";
import type { RouteDecision } from "../src/schemas.ts";

function route(risk: RouteDecision["risk"]): RouteDecision {
  return { kind: "single-agent", agents: ["worker"], risk, ambiguity: "low", needsMemory: false, needsArtifacts: true, reason: "test", plan: { kind: "single", agent: "worker", task: "x" } };
}

test("approvalDecision allows low risk under balanced mode", () => {
  assert.equal(approvalDecision(DEFAULT_CONFIG, route("low")).action, "allow");
});

test("approvalDecision allows medium risk by default", () => {
  assert.equal(approvalDecision(DEFAULT_CONFIG, route("medium")).action, "allow");
});

test("approvalDecision can ask for medium risk when explicitly configured", () => {
  const config = {
    ...DEFAULT_CONFIG,
    safety: {
      ...DEFAULT_CONFIG.safety,
      approvalRiskThreshold: "medium" as const,
    },
  };
  assert.equal(approvalDecision(config, route("medium")).action, "ask");
});

test("approvalDecision blocks critical risk", () => {
  assert.equal(approvalDecision(DEFAULT_CONFIG, route("critical")).action, "block");
});

test("approvalDecision supports disabling approval prompts without disabling critical blocks", () => {
  const config = {
    ...DEFAULT_CONFIG,
    safety: {
      ...DEFAULT_CONFIG.safety,
      approvalRiskThreshold: "none" as const,
    },
  };

  assert.equal(approvalDecision(config, route("high")).action, "allow");
  assert.equal(approvalDecision(config, route("critical")).action, "block");
});

test("child policy compresses oversized tool output and records output/read budgets", () => {
  const policy = createChildToolPolicy({ cwd: process.cwd(), maxToolCalls: 4, allowedTools: ["read"] });
  assert.deepEqual(policy.beforeTool("read", { path: "src/index.ts" }), { allowed: true });

  const result = policy.afterTool("read", {
    content: [{ type: "text", text: "x".repeat(20_000) }],
    details: {},
  }) as { content: Array<{ text: string }>; details: { piChalinCompressed?: boolean } };

  assert.equal(result.details.piChalinCompressed, true);
  assert.ok(result.content[0]!.text.length < 7000);
  assert.match(result.content[0]!.text, /compressed by pi-chalin/);
  assert.equal(policy.metrics().outputTruncatedCount, 1);
  assert.ok(policy.metrics().readBytes < 7000);
  assert.equal(policy.metrics().outputCharsByToolName.read, policy.metrics().readBytes);
});

test("child policy tracks WebFetch output separately for tokenomics attribution", () => {
  const policy = createChildToolPolicy({ cwd: process.cwd(), maxToolCalls: 4, allowedTools: ["chalin_web_search"] });
  assert.deepEqual(policy.beforeTool("chalin_web_search", { url: "https://example.com/docs" }), { allowed: true });

  policy.afterTool("chalin_web_search", {
    content: [{ type: "text", text: "external docs evidence".repeat(100) }],
    details: {},
  });

  const metrics = policy.metrics();
  assert.ok((metrics.outputCharsByToolName.chalin_web_search ?? 0) > 0);
  assert.equal(metrics.outputCharsByToolName.chalin_web_search, metrics.outputChars);
});

test("child policy guards repeated cross-step reads as a loop without budget stops", () => {
  const policy = createChildToolPolicy({
    cwd: process.cwd(),
    maxToolCalls: 10,
    allowedTools: ["read"],
    priorFilesRead: ["src/index.ts"],
    maxCrossStepDuplicateReads: 1,
  });

  assert.deepEqual(policy.beforeTool("read", { path: "src/index.ts" }), { allowed: true });
  const warned = policy.beforeTool("read", { path: "src/index.ts" });
  const stillAllowed = policy.beforeTool("read", { path: "src/index.ts" });
  const blocked = policy.beforeTool("read", { path: "src/index.ts" });

  assert.equal(warned.allowed, true);
  assert.equal(stillAllowed.allowed, true);
  assert.equal(blocked.allowed, false);
  assert.match(blocked.reason, /read_loop:src\/index\.ts/);
  assert.equal(policy.metrics().budgetStopCount, 0);
  assert.ok(policy.metrics().budgetCapHits.some((hit) => hit.name === "max_cross_step_duplicate_reads" && hit.severity === "soft"));
  assert.equal(policy.metrics().budgetCapHits.some((hit) => hit.name === "max_cross_step_duplicate_reads" && hit.severity === "hard"), false);
  assert.deepEqual(policy.metrics().policyViolations, ["read_loop:src/index.ts"]);
  assert.equal(policy.metrics().toolCalls, 3);
});

test("child policy guards same-file read loops inside one subagent", () => {
  const policy = createChildToolPolicy({
    cwd: process.cwd(),
    maxToolCalls: 100,
    allowedTools: ["read"],
  });

  assert.equal(policy.beforeTool("read", { path: "src/index.ts" }).allowed, true);
  assert.equal(policy.beforeTool("read", { path: "src/index.ts" }).allowed, true);
  assert.equal(policy.beforeTool("read", { path: "src/index.ts" }).allowed, true);
  assert.equal(policy.beforeTool("read", { path: "src/index.ts" }).allowed, true);
  const blocked = policy.beforeTool("read", { path: "src/index.ts" });

  assert.equal(blocked.allowed, false);
  assert.match(blocked.reason, /read_loop:src\/index\.ts/);
  assert.equal(policy.metrics().budgetStopCount, 0);
  assert.deepEqual(policy.metrics().policyViolations, ["read_loop:src/index.ts"]);
  assert.equal(policy.metrics().toolCalls, 4);
});
