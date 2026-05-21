import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, test } from "node:test";
import { createMemoryCandidate, MemoryStore } from "../src/memory.ts";

const tempDirs: string[] = [];
afterEach(() => { while (tempDirs.length > 0) fs.rmSync(tempDirs.pop()!, { recursive: true, force: true }); });
function tempDir(prefix: string): string { const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix)); tempDirs.push(dir); return dir; }

test("MemoryStore evaluates important candidates as pending", async () => {
  const cwd = tempDir("pi-mesh-memory-");
  const store = new MemoryStore({ cwd });
  const [record] = await store.submitCandidates([
    createMemoryCandidate({
      category: "decision",
      content: "Use a modular monolith for pi-mesh so routing, memory, runner, and TUI stay in one deployable extension while modules remain independently testable.",
      sourceAgent: "planner",
      confidence: 0.9,
      scope: "project",
    }),
  ]);
  assert.equal(record?.status, "pending");
  assert.equal(await store.pendingCount(), 1);
});

test("MemoryStore activates curated high-confidence project facts and searches them", async () => {
  const cwd = tempDir("pi-mesh-memory-");
  const store = new MemoryStore({ cwd });
  const [record] = await store.submitCandidates([
    createMemoryCandidate({
      category: "project-fact",
      content: "pi-mesh stores project memory in .pi-mesh/memory.sqlite using SQLite FTS5, and only active records are indexed for retrieval.",
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
  const cwd = tempDir("pi-mesh-memory-");
  const store = new MemoryStore({ cwd });
  const [record] = await store.submitCandidates([
    createMemoryCandidate({
      category: "agent-note",
      content: "The project test suite currently runs through Node's built-in test runner, so new regression tests should follow the existing node:test style.",
      sourceAgent: "reviewer",
      confidence: 0.9,
      scope: "project",
    }),
  ]);
  assert.equal(record?.status, "pending");
  assert.equal((await store.search("node:test style")).length, 0, "pending memories are not retrieved until approved");
});

test("MemoryStore rejects logs code snippets and task completion noise", async () => {
  const cwd = tempDir("pi-mesh-memory-");
  const store = new MemoryStore({ cwd });
  const records = await store.submitCandidates([
    createMemoryCandidate({ category: "agent-note", content: "cmd = ['pi', '-e', '/Users/me/project/src/index.ts']", sourceAgent: "scout", confidence: 0.9, scope: "project" }),
    createMemoryCandidate({ category: "agent-note", content: "print('--- stdout ---')", sourceAgent: "scout", confidence: 0.9, scope: "project" }),
    createMemoryCandidate({ category: "agent-note", content: "scout completed a recon step for: review this project", sourceAgent: "scout", confidence: 0.9, scope: "project" }),
  ]);

  assert.deepEqual(records.map((record) => record.status), ["rejected", "rejected", "rejected"]);
  assert.equal((await store.list()).length, 0, "invalid legacy-style memories should be hidden from review lists");
});

test("MemoryStore deduplicates normalized candidates before writing", async () => {
  const cwd = tempDir("pi-mesh-memory-");
  const store = new MemoryStore({ cwd });
  const content = "This project uses Bun for tests, and tests should avoid setTimeout-based waits because they make the suite flaky.";
  const records = await store.submitCandidates([
    createMemoryCandidate({ category: "tooling", content, sourceAgent: "scout", confidence: 0.9, scope: "project" }),
    createMemoryCandidate({ category: "tooling", content: `${content} `, sourceAgent: "reviewer", confidence: 0.9, scope: "project" }),
  ]);

  assert.equal(records.length, 1);
  assert.equal((await store.list()).length, 1);
});

test("MemoryStore approve reject and delete mutate records", async () => {
  const cwd = tempDir("pi-mesh-memory-");
  const store = new MemoryStore({ cwd });
  const [record] = await store.submitCandidates([
    createMemoryCandidate({
      category: "preference",
      content: "Ask before risky writes whenever a pi-mesh route is medium risk or higher, especially when the worker would modify multiple files.",
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
  const cwd = tempDir("pi-mesh-memory-");
  const store = new MemoryStore({ cwd });
  const first = await store.submitCandidates([
    createMemoryCandidate({
      category: "project-fact",
      content: "pi-mesh is a Pi Coding Agent extension that routes normal prompts through specialized subagents for project analysis and review.",
      sourceAgent: "scout",
      confidence: 0.9,
      scope: "project",
    }),
  ]);
  const second = await store.submitCandidates([
    createMemoryCandidate({
      category: "project-fact",
      content: "pi-mesh is a Pi Coding Agent extension that routes normal prompts through specialized subagents for project analysis and review.",
      sourceAgent: "context-builder",
      confidence: 0.9,
      scope: "project",
    }),
  ]);

  assert.equal(first.length, 1);
  assert.equal(second.length, 1);
  assert.equal((await store.list()).length, 1);
});

test("MemoryStore collapses near-duplicate legacy records in review lists", async () => {
  const cwd = tempDir("pi-mesh-memory-");
  const store = new MemoryStore({ cwd });
  await store.submitCandidates([
    createMemoryCandidate({
      category: "project-fact",
      content: "pi-mesh is a Pi Coding Agent extension that routes normal prompts through specialized subagents for project analysis and review.",
      sourceAgent: "scout",
      confidence: 0.9,
      scope: "project",
    }),
    createMemoryCandidate({
      category: "project-fact",
      content: "pi-mesh is a Pi Coding Agent extension package for routed subagent workflows that analyze and review normal project prompts.",
      sourceAgent: "context-builder",
      confidence: 0.9,
      scope: "project",
      id: "legacy-near-duplicate",
    }),
  ]);

  const records = await store.list();
  assert.equal(records.length, 1);
  assert.match(records[0]?.content ?? "", /pi-mesh/);
});

test("MemoryStore revisions topic-key memories instead of duplicating them", async () => {
  const cwd = tempDir("pi-mesh-memory-");
  const store = new MemoryStore({ cwd });
  await store.submitCandidates([
    createMemoryCandidate({
      category: "tooling",
      content: "Testing uses Bun, and asynchronous tests should prefer deterministic promise resolution over setTimeout-based waits because timers make the suite flaky.",
      sourceAgent: "scout",
      confidence: 0.93,
      scope: "project",
    }),
  ]);
  await store.submitCandidates([
    createMemoryCandidate({
      category: "testing",
      content: "Project tests run on Bun; avoid setTimeout sleeps in tests and use deterministic promise hooks or controlled fakes to prevent flaky timing behavior.",
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
  const cwd = tempDir("pi-mesh-memory-");
  const store = new MemoryStore({ cwd });
  const content = "The project uses node:test for extension regression tests, so new tests should import from node:assert/strict and keep temporary project roots isolated.";
  await store.submitCandidates([createMemoryCandidate({ category: "testing", content, sourceAgent: "scout", confidence: 0.91, scope: "project" })]);
  await store.submitCandidates([createMemoryCandidate({ category: "testing", content: `${content} `, sourceAgent: "context-builder", confidence: 0.92, scope: "project" })]);

  const records = await store.list("active");
  assert.equal(records.length, 1);
  assert.equal(records[0]?.duplicateCount, 2);
  assert.ok(records[0]?.lastSeenAt);
});

test("MemoryStore stores decision metadata for explainable review", async () => {
  const cwd = tempDir("pi-mesh-memory-");
  const store = new MemoryStore({ cwd });
  const [record] = await store.submitCandidates([
    createMemoryCandidate({
      category: "workflow",
      content: "Long-running pi-mesh tasks should write resumable checkpoints after each agent handoff so a later run can continue from the last completed step instead of restarting.",
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
