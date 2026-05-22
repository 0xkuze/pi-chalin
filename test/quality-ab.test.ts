import assert from "node:assert/strict";
import { test } from "bun:test";
import { extractFinalText, extractMeshToolResultText, MAX_VARIANT_TIMEOUT_MS, resolveVariantTimeoutMs, resolveVariantsToRun } from "../evals/quality-ab.eval.ts";

test("resolveVariantTimeoutMs caps SDK quality evals to a fast-fail window", () => {
  assert.equal(resolveVariantTimeoutMs(undefined), MAX_VARIANT_TIMEOUT_MS);
  assert.equal(resolveVariantTimeoutMs("250000"), MAX_VARIANT_TIMEOUT_MS);
  assert.equal(resolveVariantTimeoutMs("1500"), 1500);
});

test("resolveVariantsToRun supports single-variant diagnosis", () => {
  assert.deepEqual(resolveVariantsToRun(undefined), ["simple", "mesh"]);
  assert.deepEqual(resolveVariantsToRun("both"), ["simple", "mesh"]);
  assert.deepEqual(resolveVariantsToRun("mesh"), ["mesh"]);
  assert.deepEqual(resolveVariantsToRun("simple"), ["simple"]);
  assert.throws(() => resolveVariantsToRun("unknown"), /Unsupported quality eval variant/);
});

test("extractFinalText reconstructs Pi streaming JSON deltas", () => {
  const stdout = [
    JSON.stringify({ type: "message_start", message: { role: "assistant", content: [] } }),
    JSON.stringify({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "Este proyecto " }, message: { role: "assistant", content: [{ type: "text", text: "Este proyecto " }] } }),
    JSON.stringify({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "es React" }, message: { role: "assistant", content: [{ type: "text", text: "Este proyecto es React" }] } }),
    JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "Este proyecto es React" }] } }),
  ].join("\n");

  assert.equal(extractFinalText(stdout), "Este proyecto es React");
});

test("extractMeshToolResultText reads completed mesh_route material directly", () => {
  const stdout = [
    JSON.stringify({ type: "tool_execution_end", toolName: "mesh_route", result: { content: [{ type: "text", text: "Final answer material: apps/web services/api packages/ui pnpm test" }] } }),
    JSON.stringify({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "Parcial" }, message: { role: "assistant", content: [{ type: "text", text: "Parcial" }] } }),
  ].join("\n");

  assert.match(extractMeshToolResultText(stdout), /apps\/web services\/api/);
});
