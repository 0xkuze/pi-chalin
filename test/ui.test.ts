import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "vitest";
import { routeFromPlan } from "../src/kernel/kernel.ts";
import { createRunState } from "../src/runner/runner-state.ts";
import { liveStatusSelectedTab, liveStatusTabs } from "../src/ui/ui.ts";

function tempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

test("live status tabs expose nested child runs under their coordinating parent", () => {
  const run = createRunState(routeFromPlan({
    topology: "sequential",
    expectedEffects: ["read"],
    steps: [
      { id: "scout-map", agent: "scout", task: "Map the repository." },
      { id: "parent-review", agent: "reviewer", task: "Coordinate child review slices." },
      { id: "fan-in", agent: "context-builder", task: "Integrate handoffs." },
    ],
  }), tempDir("pi-chalin-live-tabs-"), "Audit project");
  run.id = "root-run";
  run.startedAt = new Date(0).toISOString();
  run.steps[0]!.status = "complete";
  run.steps[1]!.status = "running";
  run.steps[1]!.nestedRuns = [
    {
      id: "nested-core",
      status: "running",
      steps: [
        {
          id: "core-review",
          agent: "reviewer",
          task: "Audit core architecture/runtime/security.",
          status: "running",
        },
      ],
      updatedAt: new Date(1_000).toISOString(),
    },
  ];
  run.steps[2]!.status = "pending";

  const tabs = liveStatusTabs(run);

  assert.deepEqual(tabs.map((tab) => ({
    id: tab.id,
    title: tab.title,
    runId: tab.runId,
    depth: tab.depth,
    stepId: tab.step.id,
  })), [
    { id: "step-1", title: "✓ scout", runId: "root-run", depth: 0, stepId: "step-1" },
    { id: "step-2", title: "◆ reviewer", runId: "root-run", depth: 0, stepId: "step-2" },
    { id: "step-2/nested-core/core-review", title: "◆ >reviewer", runId: "nested-core", depth: 1, stepId: "core-review" },
    { id: "step-3", title: "· context-builder", runId: "root-run", depth: 0, stepId: "step-3" },
  ]);
  assert.equal(liveStatusSelectedTab(tabs)?.id, "step-2/nested-core/core-review");
  assert.equal(liveStatusSelectedTab(tabs, "step-2")?.id, "step-2");
});
