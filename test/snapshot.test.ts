import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, test } from "bun:test";
import { buildProjectSnapshot, formatProjectSnapshot } from "../src/project/snapshot.ts";
import { createChildToolPolicy, createChildTools, createProjectSnapshotTool } from "../src/tools/child-tools.ts";
import { createMemoryCandidate, MemoryStore } from "../src/memory/memory.ts";

const tempDirs: string[] = [];
afterEach(() => { while (tempDirs.length > 0) fs.rmSync(tempDirs.pop()!, { recursive: true, force: true }); });
function tempDir(prefix: string): string { const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix)); tempDirs.push(dir); return dir; }

test("project snapshot returns raw inventory without stack inference", () => {
  const dir = tempDir("pi-chalin-go-");
  fs.mkdirSync(path.join(dir, "cmd", "api"), { recursive: true });
  fs.mkdirSync(path.join(dir, "internal", "service"), { recursive: true });
  fs.writeFileSync(path.join(dir, "go.mod"), "module example.com/app\n");
  fs.writeFileSync(path.join(dir, "cmd", "api", "main.go"), "package main\nfunc main(){}\n");
  fs.writeFileSync(path.join(dir, "README.md"), "# Go service\n");

  const snapshot = buildProjectSnapshot({ cwd: dir, maxAgeMs: 60_000 });
  const text = formatProjectSnapshot(snapshot);

  assert.equal("stack" in snapshot, false);
  assert.equal("entrypoints" in snapshot, false);
  assert.ok(snapshot.entries.some((entry) => entry.path === "go.mod" && entry.type === "file"));
  assert.ok(snapshot.entries.some((entry) => entry.path === "cmd/api/main.go" && entry.type === "file"));
  assert.match(text, /Project discovery inventory/);
  assert.doesNotMatch(text, /stack:/);
});

test("project snapshot surfaces nested layouts through uniform inventory", () => {
  const dir = tempDir("pi-chalin-workspace-snapshot-");
  fs.mkdirSync(path.join(dir, "crates", "resolver", "src"), { recursive: true });
  fs.mkdirSync(path.join(dir, "src", "install"), { recursive: true });
  fs.writeFileSync(path.join(dir, "crates", "resolver", "src", "manifest.rs"), "pub struct PackageManifest;\n");
  fs.writeFileSync(path.join(dir, "src", "install", "lockfile.zig"), "pub const Lockfile = struct {};\n");
  fs.writeFileSync(path.join(dir, "README.md"), "# Workspace\n");

  const snapshot = buildProjectSnapshot({ cwd: dir, maxAgeMs: 60_000 });
  const text = formatProjectSnapshot(snapshot);

  assert.ok(snapshot.entries.some((entry) => entry.path === "crates/resolver/src/manifest.rs" && entry.type === "file"));
  assert.ok(snapshot.entries.some((entry) => entry.path === "src/install/lockfile.zig" && entry.type === "file"));
  assert.match(text, /crates\/resolver/);
});

test("child bash policy allows arbitrary command text for bash-capable agents", () => {
  const dir = tempDir("pi-chalin-bash-autonomy-");
  const policy = createChildToolPolicy({ cwd: dir, maxToolCalls: 5, agentName: "scout", allowedTools: ["bash"] });

  assert.deepEqual(policy.beforeTool("bash", { command: "gh pr comment 112 --body ok" }), { allowed: true });
  assert.deepEqual(policy.beforeTool("bash", { command: "python3 /tmp/read.py" }), { allowed: true });
  assert.deepEqual(policy.beforeTool("bash", { command: "sed -i 's/a/b/' file.ts" }), { allowed: true });
  assert.deepEqual(policy.metrics().policyViolations, []);
});

test("child tool policy warns at soft budget and never hard-stops on tool count", async () => {
  const dir = tempDir("pi-chalin-budget-");
  const policy = createChildToolPolicy({ cwd: dir, maxToolCalls: 1, agentName: "scout" });
  const tool = createProjectSnapshotTool(policy);

  const first = await tool.execute("call-1", {}, undefined, undefined, {} as never);
  let last = first;
  for (let index = 2; index <= 20; index += 1) {
    last = await tool.execute(`call-${index}`, {}, undefined, undefined, {} as never);
  }

  assert.match(first.content[0]?.type === "text" ? first.content[0].text : "", /Project discovery inventory/i);
  assert.match(last.content[0]?.type === "text" ? last.content[0].text : "", /Project discovery inventory/i);
  assert.equal(policy.metrics().toolCalls, 20);
  assert.equal(policy.metrics().budgetStopCount, 0);
  assert.ok(policy.metrics().budgetCapHits.some((hit) => hit.name === "max_tool_calls" && hit.severity === "soft"));
  assert.equal(policy.metrics().budgetCapHits.some((hit) => hit.name === "max_tool_calls" && hit.severity === "hard"), false);
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

  const previousProvider = process.env.PI_CHALIN_MEMORY_PROVIDER;
  process.env.PI_CHALIN_MEMORY_PROVIDER = "pi-chalin";
  try {
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
  } finally {
    if (previousProvider === undefined) delete process.env.PI_CHALIN_MEMORY_PROVIDER;
    else process.env.PI_CHALIN_MEMORY_PROVIDER = previousProvider;
  }
});


test("formatProjectSnapshot includes compact recent commits for branch summaries", () => {
  const text = formatProjectSnapshot({
    version: 1,
    createdAt: new Date().toISOString(),
    cwd: "/tmp/project",
    cacheKey: "cache",
    entries: [],
    truncated: false,
    ignoredDirs: [],
    extensionHistogram: {},
    git: { branch: "feature/auth", head: "abc123", changedFiles: ["M	src/auth.ts"], recentCommits: ["abc123 fix auth", "def456 add tests"] },
  });

  assert.match(text, /recent commits: abc123 fix auth \| def456 add tests/);
});
