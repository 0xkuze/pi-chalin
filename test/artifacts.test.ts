import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, test } from "vitest";
import { ArtifactStore } from "../src/artifacts/artifacts.ts";

import { openArtifactPanel } from "../src/ui/ui.ts";
import { ChalinKernel, routeFromPlan } from "../src/kernel/kernel.ts";

const tempDirs: string[] = [];
afterEach(() => { while (tempDirs.length > 0) fs.rmSync(tempDirs.pop()!, { recursive: true, force: true }); });
function tempDir(prefix: string): string { const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix)); tempDirs.push(dir); return dir; }

test("ArtifactStore persists resumable feature state with checkpoints and validation contracts", async () => {
  const cwd = tempDir("pi-chalin-artifacts-");
  const store = new ArtifactStore({ cwd });

  await store.initFeature({
    featureId: "memory-and-artifacts",
    goal: "Improve pi-chalin memory and artifact continuation.",
    chain: ["scout", "planner", "worker", "reviewer"],
  });
  await store.appendCheckpoint("memory-and-artifacts", {
    agent: "planner",
    title: "Design selected",
    summary: "Use local filesystem artifacts with atomic state writes and append-only checkpoint history.",
    status: "complete",
  });
  await store.saveValidationContract("memory-and-artifacts", {
    id: "memory-quality-gate",
    title: "Memory quality regression gate",
    commands: ["pnpm test -- test/memory.test.ts"],
    successCriteria: ["No raw logs are stored", "Topic-key duplicates revise existing memories"],
  });
  await store.saveWorkerSkill("memory-and-artifacts", {
    name: "memory-worker",
    summary: "Worker must produce human-readable memories and update only targeted lines.",
    rules: ["Use structured memory candidates", "Do not store raw command output"],
  });
  await store.appendInterviewDecision("memory-and-artifacts", {
    task: "Improve pi-chalin memory and artifact continuation.",
    reason: "Scope is ambiguous before planning.",
    status: "answered",
    answers: [{ questionId: "scope", question: "How broad is the change?", answer: "MVP scope", recommended: true }],
  });
  await store.appendApprovalDecision("memory-and-artifacts", {
    requestId: "approval-123",
    decision: "approved",
    toolName: "bash",
    reason: "llm_declared_risky_action:production database access",
    risk: "high",
    approvedAction: "bash: psql production",
    retriedAction: "bash: psql production",
    equivalenceReason: "exact normalized retry",
    subagentId: "worker",
    paramsSummary: "psql production",
  });

  const state = await store.loadFeature("memory-and-artifacts");
  assert.equal(state?.featureId, "memory-and-artifacts");
  assert.equal(state?.checkpoints.length, 1);
  assert.equal(state?.status, "complete");
  assert.equal(state?.validationContracts.length, 1);
  assert.equal(state?.workerSkills.length, 1);
  assert.equal(state?.interviewDecisions.length, 1);
  assert.equal(state?.approvalDecisions.length, 1);

  const resume = await store.resumeContext("memory-and-artifacts");
  assert.match(resume, /Improve pi-chalin memory/);
  assert.match(resume, /Design selected/);
  assert.match(resume, /memory-quality-gate/);
  assert.match(resume, /memory-worker/);
  assert.match(resume, /Interview decisions/);
  assert.match(resume, /How broad is the change\?/);
  assert.match(resume, /Action approvals/);
  assert.match(resume, /approved: bash: psql production/);
  assert.match(resume, /exact normalized retry/);

  assert.ok(fs.existsSync(path.join(cwd, ".pi-chalin", "artifacts", "features", "memory-and-artifacts", "state.json")));
  assert.ok(fs.existsSync(path.join(cwd, ".pi-chalin", "artifacts", "features", "memory-and-artifacts", "checkpoints.jsonl")));
  assert.ok(fs.existsSync(path.join(cwd, ".pi-chalin", "artifacts", "features", "memory-and-artifacts", "approvals.jsonl")));
  const skillPath = path.join(cwd, ".pi-chalin", "artifacts", "features", "memory-and-artifacts", "skills", "memory-worker", "SKILL.md");
  assert.ok(fs.existsSync(skillPath));
  assert.match(fs.readFileSync(skillPath, "utf-8"), /lifecycle: candidate\nexpiresAt: /);
});

test("ChalinKernel records run artifacts for long or artifact-aware workflows", async () => {
  const cwd = tempDir("pi-chalin-artifacts-kernel-");
  const route = routeFromPlan({
    topology: "sequential",
    expectedEffects: ["read", "verify"],
    steps: [
      { agent: "scout", task: "Map project context." },
      { agent: "reviewer", task: "Review findings." },
    ],
    needsArtifacts: true,
  });

  const result = await new ChalinKernel({ cwd }).handleRoute(route, "review this project", { cwd });
  assert.equal(result.run?.status, "complete");

  const store = new ArtifactStore({ cwd });
  const summary = await store.loadRun(result.run!.id);
  assert.equal(summary?.runId, result.run!.id);
  assert.equal(summary?.routeKind, "multi-agent-sequential");
  assert.deepEqual(summary?.agents, ["scout", "reviewer"]);
  assert.ok((summary?.handoffs.length ?? 0) >= 1);
});


test("openArtifactPanel provides a real navigable TUI over feature artifacts", async () => {
  const cwd = tempDir("pi-chalin-artifacts-ui-");
  const store = new ArtifactStore({ cwd });
  await store.initFeature({ featureId: "checkout-refactor", goal: "Refactor checkout flow.", chain: ["scout", "worker", "reviewer"] });
  await store.appendCheckpoint("checkout-refactor", {
    agent: "worker",
    title: "Worker finished slice",
    summary: "Updated checkout validation and left tests ready for reviewer.",
    status: "complete",
  });

  const notifications: string[] = [];
  const selections = ["complete · checkout-refactor · Worker finished slice", "Resume context"];
  const ctx = {
    cwd,
    hasUI: true,
    ui: {
      notify: (message: string) => notifications.push(message),
      select: async (_title: string, options: string[]) => selections.shift() ?? options.at(-1),
    },
  } as never;

  await openArtifactPanel(ctx, store);

  assert.equal(notifications.length, 1);
  assert.match(notifications[0] ?? "", /Feature: checkout-refactor/);
  assert.match(notifications[0] ?? "", /Worker finished slice/);
});

test("openArtifactPanel shows interview decisions as navigable artifact context", async () => {
  const cwd = tempDir("pi-chalin-artifacts-interview-ui-");
  const store = new ArtifactStore({ cwd });
  await store.initFeature({ featureId: "ambiguous-migration", goal: "Clarify migration request.", chain: ["interview"] });
  await store.appendInterviewDecision("ambiguous-migration", {
    task: "Migrate the project.",
    reason: "Migration target is ambiguous.",
    status: "answered",
    answers: [{ questionId: "target", question: "What should be migrated?", answer: "Only auth module", custom: true }],
  });

  const notifications: string[] = [];
  const selections = ["active · ambiguous-migration · Interview answered", "Interview decisions"];
  await openArtifactPanel({
    cwd,
    hasUI: true,
    ui: {
      notify: (message: string) => notifications.push(message),
      select: async (_title: string, options: string[]) => selections.shift() ?? options.at(-1),
    },
  } as never, store);

  assert.match(notifications.join("\n"), /Migration target is ambiguous/);
  assert.match(notifications.join("\n"), /What should be migrated\? → Only auth module \(custom\)/);
});

test("openArtifactPanel shows action approval decisions as navigable artifact context", async () => {
  const cwd = tempDir("pi-chalin-artifacts-approval-ui-");
  const store = new ArtifactStore({ cwd });
  await store.initFeature({ featureId: "risky-migration", goal: "Run guarded migration.", chain: ["worker"] });
  await store.appendApprovalDecision("risky-migration", {
    requestId: "approval-migration",
    decision: "rejected",
    toolName: "bash",
    reason: "llm_declared_risky_action:production migration",
    risk: "high",
    approvedAction: "bash: pnpm db:migrate --prod",
    retriedAction: "bash: pnpm db:migrate --prod",
    equivalenceReason: "same migration command",
    subagentId: "worker",
    paramsSummary: "pnpm db:migrate --prod",
  });

  const notifications: string[] = [];
  const selections = ["paused · risky-migration · Action approval rejected", "Action approvals"];
  await openArtifactPanel({
    cwd,
    hasUI: true,
    ui: {
      notify: (message: string) => notifications.push(message),
      select: async (_title: string, options: string[]) => selections.shift() ?? options.at(-1),
    },
  } as never, store);

  assert.match(notifications.join("\n"), /rejected · high · bash/);
  assert.match(notifications.join("\n"), /bash: pnpm db:migrate --prod/);
  assert.match(notifications.join("\n"), /same migration command/);
});
