import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, test } from "bun:test";
import { buildProjectSnapshot, formatProjectSnapshot } from "../src/snapshot.ts";
import { classifyBashCommand, createChildToolPolicy, createChildTools, createProjectSnapshotTool } from "../src/child-tools.ts";
import { createMemoryCandidate, MemoryStore } from "../src/memory.ts";

const tempDirs: string[] = [];
afterEach(() => { while (tempDirs.length > 0) fs.rmSync(tempDirs.pop()!, { recursive: true, force: true }); });
function tempDir(prefix: string): string { const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix)); tempDirs.push(dir); return dir; }

test("project snapshot is stack-agnostic and detects Go projects without package.json", () => {
  const dir = tempDir("pi-chalin-go-");
  fs.mkdirSync(path.join(dir, "cmd", "api"), { recursive: true });
  fs.mkdirSync(path.join(dir, "internal", "service"), { recursive: true });
  fs.writeFileSync(path.join(dir, "go.mod"), "module example.com/app\n");
  fs.writeFileSync(path.join(dir, "cmd", "api", "main.go"), "package main\nfunc main(){}\n");
  fs.writeFileSync(path.join(dir, "README.md"), "# Go service\n");

  const snapshot = buildProjectSnapshot({ cwd: dir, maxAgeMs: 60_000 });
  const text = formatProjectSnapshot(snapshot);

  assert.ok(snapshot.stack.includes("go"));
  assert.ok(snapshot.signals.includes("go.mod"));
  assert.ok(snapshot.testCommands.includes("go test ./..."));
  assert.ok(snapshot.entrypoints.includes("cmd/api/main.go"));
  assert.match(text, /stack: go/);
});

test("guarded child bash blocks ad-hoc scripts and file mutation", () => {
  assert.equal(classifyBashCommand("git status --short").allowed, true);
  assert.equal(classifyBashCommand("go test ./...").allowed, true);
  assert.equal(classifyBashCommand("python3 /tmp/read.py").allowed, false);
  assert.equal(classifyBashCommand("cat > script.py").allowed, false);
  assert.equal(classifyBashCommand("node -e \"console.log(1)\"").allowed, false);
  assert.equal(classifyBashCommand("sed -i 's/a/b/' file.ts").allowed, false);
});

test("child tool policy enforces budget before executing tools", async () => {
  const dir = tempDir("pi-chalin-budget-");
  const policy = createChildToolPolicy({ cwd: dir, maxToolCalls: 1, agentName: "scout" });
  const tool = createProjectSnapshotTool(policy);

  const first = await tool.execute("call-1", {}, undefined, undefined, {} as never);
  const second = await tool.execute("call-2", {}, undefined, undefined, {} as never);

  assert.match(first.content[0]?.type === "text" ? first.content[0].text : "", /stack:/i);
  assert.equal(policy.metrics().toolCalls, 1);
  assert.match(second.content[0]?.type === "text" ? second.content[0].text : "", /budget_exceeded/);
  assert.equal(policy.metrics().budgetStopCount, 1);
  assert.deepEqual(policy.metrics().policyViolations, []);
});

test("child write tool is blocked for existing files", async () => {
  const dir = tempDir("pi-chalin-write-");
  fs.writeFileSync(path.join(dir, "existing.ts"), "export const value = 1;\n");
  const policy = createChildToolPolicy({ cwd: dir, maxToolCalls: 5, agentName: "worker", allowedTools: ["write"] });
  const write = createChildTools(policy).find((tool) => tool.name === "write");
  assert.ok(write);

  const result = await write.execute("call-1", { path: "existing.ts", content: "export const value = 2;\n" }, undefined, undefined, {} as never);

  assert.match(result.content[0]?.type === "text" ? result.content[0].text : "", /write_existing_file:existing\.ts/);
  assert.equal(fs.readFileSync(path.join(dir, "existing.ts"), "utf8"), "export const value = 1;\n");
  assert.deepEqual(policy.metrics().policyViolations, ["write_existing_file:existing.ts"]);
});

test("child tool policy blocks tools outside capabilities", () => {
  const dir = tempDir("pi-chalin-allowed-tools-");
  const policy = createChildToolPolicy({ cwd: dir, maxToolCalls: 5, agentName: "planner", allowedTools: ["chalin_project_snapshot", "read"] });

  const gate = policy.beforeTool("bash", { command: "git status --short" });

  assert.equal(gate.allowed, false);
  assert.match(gate.reason, /tool_not_allowed:bash/);
  assert.deepEqual(policy.metrics().policyViolations, ["tool_not_allowed:bash"]);
});

test("controlled child artifact tool writes checkpoints and validation contracts", async () => {
  const dir = tempDir("pi-chalin-child-artifact-");
  const policy = createChildToolPolicy({ cwd: dir, maxToolCalls: 5, agentName: "worker", allowedTools: ["chalin_artifact_write"] });
  const tool = createChildTools(policy).find((candidate) => candidate.name === "chalin_artifact_write");
  assert.ok(tool);

  const checkpoint = await tool.execute("tool-1", {
    kind: "checkpoint",
    featureId: "checkout-refactor",
    title: "Slice complete",
    summary: "Worker completed the checkout validation slice and handed off reviewer checks.",
    status: "complete",
    agent: "worker",
  }, undefined, undefined, undefined as never);
  assert.match(String((checkpoint.content?.[0] as { text?: string } | undefined)?.text ?? ""), /checkpoint saved/i);

  const validation = await tool.execute("tool-2", {
    kind: "validation-contract",
    featureId: "checkout-refactor",
    id: "checkout-tests",
    title: "Checkout validation tests",
    commands: ["bun test -- checkout"],
    successCriteria: ["Checkout validation tests pass", "No snapshot-only approval"],
  }, undefined, undefined, undefined as never);
  assert.match(String((validation.content?.[0] as { text?: string } | undefined)?.text ?? ""), /validation contract saved/i);

  const state = JSON.parse(fs.readFileSync(path.join(dir, ".pi-chalin", "artifacts", "features", "checkout-refactor", "state.json"), "utf-8"));
  assert.equal(state.checkpoints.length, 1);
  assert.equal(state.validationContracts.length, 1);
  assert.equal(policy.metrics().toolCalls, 2);
});

test("child tools expose only policy-allowed definitions to reduce child prompt bloat", () => {
  const dir = tempDir("pi-chalin-child-tools-prune-");
  const policy = createChildToolPolicy({ cwd: dir, maxToolCalls: 5, agentName: "scout", allowedTools: ["read", "chalin_project_snapshot"] });
  const names = createChildTools(policy).map((tool) => tool.name).sort();
  assert.deepEqual(names, ["chalin_project_snapshot", "read"]);
});

test("controlled child memory tools retrieve write and revise through policy", async () => {
  const dir = tempDir("pi-chalin-child-memory-");
  const store = new MemoryStore({ cwd: dir });
  const [seed] = await store.submitCandidates([createMemoryCandidate({
    category: "testing",
    content: "Project tests use Bun and should avoid setTimeout sleeps in async retry assertions.",
    sourceAgent: "reviewer",
    confidence: 0.95,
    scope: "project",
  })]);
  assert.ok(seed);

  const policy = createChildToolPolicy({ cwd: dir, maxToolCalls: 5, agentName: "worker", allowedTools: ["chalin_memory_search", "chalin_memory_write", "chalin_memory_revise"] });
  const tools = createChildTools(policy);
  const search = tools.find((tool) => tool.name === "chalin_memory_search");
  const write = tools.find((tool) => tool.name === "chalin_memory_write");
  const revise = tools.find((tool) => tool.name === "chalin_memory_revise");
  assert.ok(search);
  assert.ok(write);
  assert.ok(revise);

  const found = await search.execute("mem-1", { query: "Bun async retry assertions", tokenBudget: 120 }, undefined, undefined, undefined as never);
  assert.match(String((found.content?.[0] as { text?: string } | undefined)?.text ?? ""), /Memory context/);

  const written = await write.execute("mem-2", {
    category: "workflow",
    content: "Agents should search memory before broad repeated repository discovery when prior decisions may reduce file reads.",
    confidence: 0.9,
    evidence: "child memory tool policy test",
  }, undefined, undefined, undefined as never);
  assert.match(String((written.content?.[0] as { text?: string } | undefined)?.text ?? ""), /memory active|memory pending/);

  const revised = await revise.execute("mem-3", {
    id: seed.id,
    content: "Project tests use Bun and should prefer deterministic fake timers or promise hooks over setTimeout sleeps in async retry assertions.",
    evidence: "existing memory plus test policy",
    reason: "Make the procedural guidance more precise.",
  }, undefined, undefined, undefined as never);
  assert.match(String((revised.content?.[0] as { text?: string } | undefined)?.text ?? ""), /memory revised/);
  assert.equal(policy.metrics().toolCalls, 3);
});


test("formatProjectSnapshot includes compact recent commits for branch summaries", () => {
  const text = formatProjectSnapshot({
    version: 1,
    createdAt: new Date().toISOString(),
    cwd: "/tmp/project",
    cacheKey: "cache",
    stack: ["node"],
    signals: ["package.json"],
    packageManagers: ["bun"],
    testCommands: ["bun test"],
    buildCommands: [],
    entrypoints: [],
    highSignalFiles: [],
    git: { branch: "feature/auth", head: "abc123", changedFiles: ["M	src/auth.ts"], recentCommits: ["abc123 fix auth", "def456 add tests"] },
  });

  assert.match(text, /recent commits: abc123 fix auth \| def456 add tests/);
});
