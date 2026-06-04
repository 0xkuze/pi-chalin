import assert from "node:assert/strict";
import { test } from "vitest";
import { routeFromPlan } from "../src/kernel/kernel.ts";
import { buildContextPacket, formatContextPacket } from "../src/runner/context-packet.ts";
import { createRunState } from "../src/runner/runner-state.ts";

test("ContextPacket prefers structured handoff fields over truncated prose handoff", () => {
  const route = routeFromPlan({
    topology: "sequential",
    expectedEffects: ["read", "write", "verify"],
    steps: [
      { id: "inspect", agent: "scout", task: "Inspect API evidence." },
      { id: "apply", agent: "worker", task: "Apply API change." },
    ],
  });
  const run = createRunState(route, process.cwd(), "Apply API change.");
  const scout = run.steps[0]!;
  const worker = run.steps[1]!;
  scout.status = "complete";
  scout.output = {
    agent: "scout",
    text: "raw output",
    handoff: `Summary: ${"noisy prose ".repeat(200)}`,
    raw: "raw output",
    warnings: [],
    memoryCandidates: [],
    structuredHandoff: {
      summary: "Precise API evidence summary.",
      changedFiles: ["apps/api/vite.config.ts"],
      verification: ["vp run api#test passed"],
      evidenceClaims: [],
      risks: ["Swagger path needs review"],
      nextActions: ["Implement Vite+ config"],
      workUnits: [],
    },
  };

  const packet = buildContextPacket(run, worker, "previous prose that should not hide structured fields", 240, process.cwd(), process.cwd());
  const formatted = formatContextPacket(packet);

  assert.match(packet?.summary ?? "", /Precise API evidence summary/);
  assert.doesNotMatch(packet?.summary ?? "", /noisy prose noisy prose noisy prose/);
  assert.match(formatted ?? "", /changedFiles: apps\/api\/vite\.config\.ts/);
  assert.match(formatted ?? "", /verification: vp run api#test passed/);
  assert.match(formatted ?? "", /knownGaps: Swagger path needs review/);
});

test("ContextPacket compacts long verification lists and avoids duplicate previous summaries", () => {
  const route = routeFromPlan({
    topology: "sequential",
    expectedEffects: ["read", "write", "verify"],
    steps: [
      { id: "inspect", agent: "scout", task: "Inspect API evidence." },
      { id: "apply", agent: "worker", task: "Apply API change." },
    ],
  });
  const run = createRunState(route, process.cwd(), "Apply API change.");
  const scout = run.steps[0]!;
  const worker = run.steps[1]!;
  const evidencePaths = Array.from({ length: 28 }, (_, index) => `apps/api/src/file-${index}.ts`).join(", ");
  scout.status = "complete";
  scout.output = {
    agent: "scout",
    text: "raw output",
    handoff: "Summary: raw",
    raw: "raw output",
    warnings: [],
    memoryCandidates: [],
    structuredHandoff: {
      summary: "Mapped the API workspace evidence.",
      changedFiles: [],
      verification: [`evidencePaths: ${evidencePaths}`],
      evidenceClaims: [],
      risks: ["Keep Swagger smoke coverage."],
      nextActions: ["Implement Vite+ alignment."],
      workUnits: [],
    },
  };

  const previous = "summary: Mapped the API workspace evidence.\nverification: evidencePaths: apps/api/src/file-0.ts; apps/api/src/file-1.ts";
  const packet = buildContextPacket(run, worker, previous, 600, process.cwd(), process.cwd());
  const formatted = formatContextPacket(packet);

  assert.match(formatted ?? "", /evidencePaths: apps\/api\/src\/file-0\.ts/);
  assert.match(formatted ?? "", /more/);
  assert.doesNotMatch(formatted ?? "", /file-27\.ts/);
  assert.equal(((packet?.summary ?? "").match(/Mapped the API workspace evidence/g) ?? []).length, 1);
});
