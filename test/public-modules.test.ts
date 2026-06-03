import { describe, test } from "vitest";
import assert from "node:assert/strict";

describe("public module surface", () => {
  test("exposes canonical nested modules", async () => {
    const runner = await import("pi-chalin/runner/runner");
    const tools = await import("pi-chalin/tools/tools");
    const childTools = await import("pi-chalin/tools/child-tools");
    const runtime = await import("pi-chalin/runtime/state");
    const ui = await import("pi-chalin/ui/ui");
    const artifacts = await import("pi-chalin/artifacts/artifacts");
    const config = await import("pi-chalin/config/config");
    const kernel = await import("pi-chalin/kernel/kernel");
    const project = await import("pi-chalin/project/discovery");
    const workUnits = await import("pi-chalin/runner/work-units");
    const runRecovery = await import("pi-chalin/runner/run-recovery");
    const contextPacket = await import("pi-chalin/runner/context-packet");
    const intentContract = await import("pi-chalin/runner/intent-contract");
    const inlinePolicy = await import("pi-chalin/runtime/inline-policy");

    assert.equal(typeof runner.MockWorkerRunner, "function");
    assert.equal(typeof runner.parseAgentOutput, "function");
    assert.equal(typeof tools.registerChalinTools, "function");
    assert.equal(typeof childTools.createChildTools, "function");
    assert.equal(typeof runtime.resetRuntimeState, "function");
    assert.equal(typeof ui.openSmartPanel, "function");
    assert.equal(typeof artifacts.ArtifactStore, "function");
    assert.equal(typeof config.loadEffectiveConfig, "function");
    assert.equal(typeof kernel.ChalinKernel, "function");
    assert.equal(typeof project.buildProjectDiscoveryIndex, "function");
    assert.equal(typeof workUnits.planStepsWithWorkUnits, "function");
    assert.equal(typeof runRecovery.loadFailedRunDiagnostic, "function");
    assert.equal(typeof contextPacket.buildContextPacket, "function");
    assert.equal(typeof intentContract.buildIntentContract, "function");
    assert.equal(typeof inlinePolicy.judgeInlineCompletionPolicy, "function");
  });

  test("does not expose removed root implementation imports", async () => {
    const removedRootPaths = [
      "pi-chalin/artifacts",
      "pi-chalin/config",
      "pi-chalin/kernel",
      "pi-chalin/src/artifacts.ts",
      "pi-chalin/src/config.ts",
      "pi-chalin/src/runner.ts",
      "pi-chalin/src/tools.ts",
      "pi-chalin/src/runtime-state.ts",
      "pi-chalin/runtime/direct-policy",
    ];

    for (const specifier of removedRootPaths) {
      await assert.rejects(() => import(specifier));
    }
  });
});
