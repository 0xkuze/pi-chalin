import assert from "node:assert/strict";
import { test } from "bun:test";
import { buildPromptTokenomics, buildTokenomicsFromCharCounts, buildToolOutputTokenomics, createStructuredSpan, mergeTraceSpans } from "../src/observability.ts";

test("buildPromptTokenomics estimates stable and variable prompt phases separately", () => {
  const tokenomics = buildPromptTokenomics({
    orchestratorPrompt: "stable orchestrator rules ".repeat(10),
    roster: "scout\nworker\nreviewer",
    childPrompt: "child task contract ".repeat(8),
    memory: "memory context ".repeat(5),
    handoff: "previous handoff evidence",
    toolOutputs: "tool output text",
    webContextFetch: "external docs result",
  });

  assert.ok(tokenomics.totalEstimatedTokens > 0);
  assert.ok(tokenomics.phases.orchestratorPrompt.estimatedTokens > tokenomics.phases.roster.estimatedTokens);
  assert.equal(tokenomics.phases.memory.estimatedChars, "memory context ".repeat(5).length);
  assert.equal(tokenomics.phases.toolOutputs.estimatedChars, "tool output text".length);
  assert.equal(tokenomics.phases.webContextFetch.estimatedChars, "external docs result".length);
});

test("buildPromptTokenomics ignores whitespace-only prompt phase text", () => {
  const tokenomics = buildPromptTokenomics({
    childPrompt: "   \n\t",
  });

  assert.equal(tokenomics.phases.childPrompt.estimatedChars, 0);
  assert.equal(tokenomics.phases.childPrompt.estimatedTokens, 0);
  assert.equal(tokenomics.totalEstimatedChars, 0);
});

test("buildTokenomicsFromCharCounts records web context fetch without allocating output text", () => {
  const tokenomics = buildTokenomicsFromCharCounts({
    toolOutputs: 12_000,
    webContextFetch: 7_000,
  });

  assert.equal(tokenomics.phases.toolOutputs.estimatedChars, 12_000);
  assert.equal(tokenomics.phases.webContextFetch.estimatedChars, 7_000);
  assert.ok(tokenomics.totalEstimatedTokens >= tokenomics.phases.toolOutputs.estimatedTokens);
});

test("buildToolOutputTokenomics separates web fetch output from generic tool output", () => {
  const tokenomics = buildToolOutputTokenomics(7_000, { chalin_web_search: 7_000 });

  assert.ok(tokenomics);
  assert.equal(tokenomics.phases.toolOutputs.estimatedChars, 0);
  assert.equal(tokenomics.phases.webContextFetch.estimatedChars, 7_000);
  assert.equal(tokenomics.totalEstimatedChars, 7_000);
});

test("buildToolOutputTokenomics keeps local tool output separate from web fetch output", () => {
  const tokenomics = buildToolOutputTokenomics(170, { read: 100, chalin_web_search: 70 });

  assert.ok(tokenomics);
  assert.equal(tokenomics.phases.toolOutputs.estimatedChars, 100);
  assert.equal(tokenomics.phases.webContextFetch.estimatedChars, 70);
  assert.equal(tokenomics.totalEstimatedChars, 170);
});

test("structured spans keep parent-child timing and bounded metadata", () => {
  const run = createStructuredSpan({ id: "run", name: "run", kind: "run", startedAt: 1000, endedAt: 1600 });
  const tool = createStructuredSpan({
    id: "tool-1",
    parentId: "run",
    name: "read src/runner.ts",
    kind: "tool-call",
    startedAt: 1100,
    endedAt: 1300,
    attributes: { toolName: "read", path: "src/runner.ts", ignored: undefined },
  });

  assert.equal(run.durationMs, 600);
  assert.equal(tool.parentId, "run");
  assert.deepEqual(tool.attributes, { toolName: "read", path: "src/runner.ts" });
  assert.deepEqual(mergeTraceSpans([run], [tool]).map((span) => span.id), ["run", "tool-1"]);
});
