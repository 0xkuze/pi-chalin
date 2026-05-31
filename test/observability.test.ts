import assert from "node:assert/strict";
import { test } from "bun:test";
import { buildPromptTokenomics, createStructuredSpan, mergeTraceSpans } from "../src/observability.ts";

test("buildPromptTokenomics estimates stable and variable prompt phases separately", () => {
  const tokenomics = buildPromptTokenomics({
    orchestratorPrompt: "stable orchestrator rules ".repeat(10),
    roster: "scout\nworker\nreviewer",
    childPrompt: "child task contract ".repeat(8),
    memory: "memory context ".repeat(5),
    handoff: "previous handoff evidence",
    toolOutputs: "tool output text",
  });

  assert.ok(tokenomics.totalEstimatedTokens > 0);
  assert.ok(tokenomics.phases.orchestratorPrompt.estimatedTokens > tokenomics.phases.roster.estimatedTokens);
  assert.equal(tokenomics.phases.memory.estimatedChars, "memory context ".repeat(5).length);
  assert.equal(tokenomics.phases.toolOutputs.estimatedChars, "tool output text".length);
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
