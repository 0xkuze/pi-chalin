import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, test } from "vitest";
import { createMemoryCandidate, MemoryStore } from "../src/memory/memory.ts";

const tempDirs: string[] = [];
afterEach(() => { while (tempDirs.length > 0) fs.rmSync(tempDirs.pop()!, { recursive: true, force: true }); });
function tempDir(prefix: string): string { const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix)); tempDirs.push(dir); return dir; }

test("MemoryStore evaluates important candidates as pending", async () => {
  const cwd = tempDir("pi-chalin-memory-");
  const store = new MemoryStore({ cwd });
  const [record] = await store.submitCandidates([
    createMemoryCandidate({
      category: "decision",
      content: "Use a modular monolith for pi-chalin so routing, memory, runner, and TUI stay in one deployable extension while modules remain independently testable.",
      sourceAgent: "planner",
      confidence: 0.9,
      scope: "project",
    }),
  ]);
  assert.equal(record?.status, "pending");
  assert.equal(await store.pendingCount(), 1);
});

test("MemoryStore activates curated high-confidence project facts and searches them", async () => {
  const cwd = tempDir("pi-chalin-memory-");
  const store = new MemoryStore({ cwd });
  const [record] = await store.submitCandidates([
    createMemoryCandidate({
      category: "project-fact",
      content: "pi-chalin stores project memory in .pi-chalin/memory.sqlite using SQLite FTS5, and only active records are indexed for retrieval.",
      sourceAgent: "reviewer",
      confidence: 0.9,
      scope: "project",
    }),
  ]);
  assert.equal(record?.status, "active");
  const results = await store.search("SQLite FTS5 retrieval");
  assert.equal(results.length, 1);
  assert.equal(results[0]?.record.sourceAgent, "reviewer");
});

test("MemoryStore keeps generic agent notes pending for human review", async () => {
  const cwd = tempDir("pi-chalin-memory-");
  const store = new MemoryStore({ cwd });
  const [record] = await store.submitCandidates([
    createMemoryCandidate({
      category: "agent-note",
      content: "The project test suite currently runs through Vitest, so new regression tests should follow the existing Vitest style.",
      sourceAgent: "reviewer",
      confidence: 0.9,
      scope: "project",
    }),
  ]);
  assert.equal(record?.status, "pending");
  assert.equal((await store.search("Vitest style")).length, 0, "pending memories are not retrieved until approved");
});

test("MemoryStore rejects logs code snippets and task completion noise", async () => {
  const cwd = tempDir("pi-chalin-memory-");
  const store = new MemoryStore({ cwd });
  const records = await store.submitCandidates([
    createMemoryCandidate({ category: "agent-note", content: "cmd = ['pi', '-e', '/Users/me/project/src/index.ts']", sourceAgent: "scout", confidence: 0.9, scope: "project" }),
    createMemoryCandidate({ category: "agent-note", content: "print('--- stdout ---')", sourceAgent: "scout", confidence: 0.9, scope: "project" }),
    createMemoryCandidate({ category: "agent-note", content: "scout completed a recon step for: review this project", sourceAgent: "scout", confidence: 0.9, scope: "project" }),
  ]);

  assert.deepEqual(records.map((record) => record.status), ["rejected", "rejected", "rejected"]);
  assert.equal((await store.list()).length, 0, "invalid old-format memories should be hidden from review lists");
});

test("MemoryStore rejects transient verification status as durable memory", async () => {
  const cwd = tempDir("pi-chalin-memory-");
  const store = new MemoryStore({ cwd });
  const records = await store.submitCandidates([
    createMemoryCandidate({
      category: "testing",
      content: "The test suite dry-run currently reports 538 tests with 138 failing cases in smoke integration.",
      sourceAgent: "scout",
      confidence: 0.94,
      scope: "project",
    }),
    createMemoryCandidate({
      category: "tooling",
      content: "Project regression tests run through Vitest, so new TypeScript tests should use the Vitest API and isolated temporary roots.",
      sourceAgent: "reviewer",
      confidence: 0.94,
      scope: "project",
    }),
  ]);

  assert.equal(records[0]?.status, "rejected");
  assert.equal(records[1]?.status, "active");
  assert.deepEqual((await store.list("active")).map((record) => record.category), ["tooling"]);
});

test("MemoryStore deduplicates normalized candidates before writing", async () => {
  const cwd = tempDir("pi-chalin-memory-");
  const store = new MemoryStore({ cwd });
  const content = "This project uses Vitest for tests, and tests should avoid setTimeout-based waits because they make the suite flaky.";
  const records = await store.submitCandidates([
    createMemoryCandidate({ category: "tooling", content, sourceAgent: "scout", confidence: 0.9, scope: "project" }),
    createMemoryCandidate({ category: "tooling", content: `${content} `, sourceAgent: "reviewer", confidence: 0.9, scope: "project" }),
  ]);

  assert.equal(records.length, 1);
  assert.equal((await store.list()).length, 1);
});

test("MemoryStore approve reject and delete mutate records", async () => {
  const cwd = tempDir("pi-chalin-memory-");
  const store = new MemoryStore({ cwd });
  const [record] = await store.submitCandidates([
    createMemoryCandidate({
      category: "preference",
      content: "Ask before risky writes whenever a pi-chalin route is medium risk or higher, especially when the worker would modify multiple files.",
      sourceAgent: "planner",
      confidence: 0.9,
      scope: "project",
    }),
  ]);
  assert.ok(record);
  assert.equal((await store.approve(record.id))?.status, "active");
  assert.equal((await store.reject(record.id))?.status, "rejected");
  assert.equal(await store.delete(record.id), true);
});

test("MemoryStore does not persist duplicate candidates across agents", async () => {
  const cwd = tempDir("pi-chalin-memory-");
  const store = new MemoryStore({ cwd });
  const first = await store.submitCandidates([
    createMemoryCandidate({
      category: "project-fact",
      content: "pi-chalin is a Pi Coding Agent extension that routes normal prompts through specialized subagents for project analysis and review.",
      sourceAgent: "scout",
      confidence: 0.9,
      scope: "project",
    }),
  ]);
  const second = await store.submitCandidates([
    createMemoryCandidate({
      category: "project-fact",
      content: "pi-chalin is a Pi Coding Agent extension that routes normal prompts through specialized subagents for project analysis and review.",
      sourceAgent: "context-builder",
      confidence: 0.9,
      scope: "project",
    }),
  ]);

  assert.equal(first.length, 1);
  assert.equal(second.length, 1);
  assert.equal((await store.list()).length, 1);
});

test("MemoryStore collapses near-duplicate old-format records in review lists", async () => {
  const cwd = tempDir("pi-chalin-memory-");
  const store = new MemoryStore({ cwd });
  await store.submitCandidates([
    createMemoryCandidate({
      category: "project-fact",
      content: "pi-chalin is a Pi Coding Agent extension that delegates complex work to specialized subagents for project analysis and review.",
      sourceAgent: "scout",
      confidence: 0.9,
      scope: "project",
    }),
    createMemoryCandidate({
      category: "project-fact",
      content: "pi-chalin is a Pi Coding Agent extension package that delegates complex prompts through specialized subagents for project analysis and review.",
      sourceAgent: "context-builder",
      confidence: 0.9,
      scope: "project",
      id: "old-format-near-duplicate",
    }),
  ]);

  const records = await store.list();
  assert.equal(records.length, 1);
  assert.match(records[0]?.content ?? "", /pi-chalin/);
});

test("MemoryStore revisions topic-key memories instead of duplicating them", async () => {
  const cwd = tempDir("pi-chalin-memory-");
  const store = new MemoryStore({ cwd });
  await store.submitCandidates([
    createMemoryCandidate({
      category: "tooling",
      content: "Testing uses Vitest, and asynchronous tests should prefer deterministic promise resolution over setTimeout-based waits because timers make the suite flaky.",
      sourceAgent: "scout",
      confidence: 0.93,
      scope: "project",
    }),
  ]);
  await store.submitCandidates([
    createMemoryCandidate({
      category: "testing",
      content: "Project tests run on Vitest; avoid setTimeout sleeps in tests and use deterministic promise hooks or controlled fakes to prevent flaky timing behavior.",
      sourceAgent: "reviewer",
      confidence: 0.95,
      scope: "project",
    }),
  ]);

  const records = await store.list("active");
  assert.equal(records.length, 1);
  assert.equal(records[0]?.category, "testing");
  assert.equal(records[0]?.revisionCount, 2);
  assert.equal(records[0]?.duplicateCount, 1);
  assert.match(records[0]?.content ?? "", /avoid setTimeout/i);
});

test("MemoryStore counts exact duplicate sightings without cluttering review", async () => {
  const cwd = tempDir("pi-chalin-memory-");
  const store = new MemoryStore({ cwd });
  const content = "The project uses Vitest for extension regression tests, so new tests should import from node:assert/strict and keep temporary project roots isolated.";
  await store.submitCandidates([createMemoryCandidate({ category: "testing", content, sourceAgent: "scout", confidence: 0.91, scope: "project" })]);
  await store.submitCandidates([createMemoryCandidate({ category: "testing", content: `${content} `, sourceAgent: "context-builder", confidence: 0.92, scope: "project" })]);

  const records = await store.list("active");
  assert.equal(records.length, 1);
  assert.equal(records[0]?.duplicateCount, 2);
  assert.ok(records[0]?.lastSeenAt);
});

test("MemoryStore stores decision metadata for explainable review", async () => {
  const cwd = tempDir("pi-chalin-memory-");
  const store = new MemoryStore({ cwd });
  const [record] = await store.submitCandidates([
    createMemoryCandidate({
      category: "workflow",
      content: "Long-running pi-chalin tasks should write resumable checkpoints after each agent handoff so a later run can continue from the last completed step instead of restarting.",
      sourceAgent: "planner",
      confidence: 0.9,
      evidence: "Artifact design review",
      scope: "project",
    }),
  ]);

  assert.equal(record?.status, "active");
  assert.equal(record?.importance, 0.8);
  assert.equal(record?.trigger, "workflow-learning");
  assert.ok(record?.topicKey);
});

test("MemoryStore retrieves compact token-budgeted context and audits usage", async () => {
  const cwd = tempDir("pi-chalin-memory-");
  const store = new MemoryStore({ cwd });
  await store.submitCandidates([
    createMemoryCandidate({
      category: "testing",
      content: "Project tests use Vitest, and async retry tests should avoid setTimeout sleeps in favor of deterministic fake timers or promise hooks.",
      sourceAgent: "reviewer",
      confidence: 0.95,
      scope: "project",
    }),
    createMemoryCandidate({
      category: "workflow",
      content: "Long-running pi-chalin routes should save validation contracts before reviewer synthesis so later agents can resume without re-reading the whole repository.",
      sourceAgent: "planner",
      confidence: 0.94,
      scope: "project",
    }),
  ]);

  const bundle = await store.retrieve({ query: "Vitest retry tests validation contracts", sourceAgent: "worker", tokenBudget: 80, limit: 5 });

  assert.match(bundle.text, /Memory context/);
  assert.ok(bundle.estimatedTokens <= 80);
  assert.ok(bundle.results.length >= 1);
  const events = await store.events(bundle.results[0]!.record.id);
  assert.ok(events.some((event) => event.type === "retrieve" && event.actor === "worker"));
  const used = (await store.list("active")).find((record) => record.id === bundle.results[0]!.record.id);
  assert.ok((used?.useCount ?? 0) > 0);
});

test("MemoryStore revises incorrect memories with audited provenance", async () => {
  const cwd = tempDir("pi-chalin-memory-");
  const store = new MemoryStore({ cwd });
  const [record] = await store.submitCandidates([
    createMemoryCandidate({
      category: "testing",
      content: "Project tests use Vitest for extension regression tests and should place specs under src/__tests__.",
      sourceAgent: "scout",
      confidence: 0.9,
      scope: "project",
    }),
  ]);
  assert.ok(record);

  const revised = await store.revise(record.id, {
    category: "testing",
    content: "Project tests use Vitest for extension regression tests and should keep temporary project roots isolated.",
    sourceAgent: "reviewer",
    confidence: 0.98,
    evidence: "package.json test script and existing test/*.test.ts files",
    reason: "Current repository evidence contradicts the old test layout memory.",
  });

  assert.equal(revised?.revisionCount, 2);
  assert.match(revised?.content ?? "", /Vitest/);
  assert.match(revised?.evidence ?? "", /package\.json/);
  const events = await store.events(record.id);
  assert.ok(events.some((event) => event.type === "revise" && event.previousContent?.includes("src/__tests__") && event.nextContent?.includes("temporary project roots")));
});
