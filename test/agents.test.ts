import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, test } from "bun:test";
import { AgentCatalog } from "../src/agents/agents.ts";
import { childToolNames } from "../src/runner/runner-prompt.ts";

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) fs.rmSync(tempDirs.pop()!, { recursive: true, force: true });
});

function tempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function writeAgent(filePath: string, name: string, description: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `---\nname: ${name}\ndescription: ${description}\nconcern: planning\nmodel: inherit\ntools: read, grep\n---\n${description} prompt\n`, "utf-8");
}

test("AgentCatalog loads built-in agents", () => {
  const cwd = tempDir("pi-chalin-cwd-");
  const catalog = AgentCatalog.load({ cwd });
  const names = catalog.list("built-in").map((agent) => agent.name);

  for (const expected of ["scout", "researcher", "context-builder", "planner", "worker", "reviewer", "conflict-resolver", "oracle", "delegate"]) {
    assert.equal(names.includes(expected), true, `${expected} should load`);
  }
});

test("AgentCatalog loads explicit concern capabilities", () => {
  const cwd = tempDir("pi-chalin-cwd-");
  const catalog = AgentCatalog.load({ cwd });
  const worker = catalog.resolve("worker").agent;
  const conflictResolver = catalog.resolve("conflict-resolver").agent;
  const planner = catalog.resolve("planner").agent;
  const scout = catalog.resolve("scout").agent;

  assert.ok(worker?.capabilities.includes("edit-files"));
  assert.ok(worker?.capabilities.includes("write-new-files"));
  assert.ok(worker?.capabilities.includes("coordinate"));
  assert.ok(scout?.capabilities.includes("run-safe-bash"));
  assert.ok(conflictResolver?.capabilities.includes("edit-files"));
  assert.equal(conflictResolver?.capabilities.includes("write-new-files"), false);
  assert.equal(planner?.capabilities.includes("edit-files"), false);
  assert.equal(planner?.capabilities.includes("write-new-files"), false);
  assert.equal(worker?.thinking, "high");
  assert.equal(planner?.thinking, "high");
  assert.equal(scout?.thinking, "low");
});

test("built-in worker can coordinate nested decomposition below depth limit", () => {
  const cwd = tempDir("pi-chalin-cwd-");
  const worker = AgentCatalog.load({ cwd }).resolve("worker").agent;

  assert.ok(worker);
  assert.ok(childToolNames(worker, "Implementa un scope que excede un limite de ownership confiable.", true, false, {
    delegationDepth: 1,
    maxDelegationDepth: 2,
  }).includes("chalin_delegate"));
});

test("scout receives native bash for branch and PR reconnaissance", () => {
  const cwd = tempDir("pi-chalin-cwd-");
  const scout = AgentCatalog.load({ cwd }).resolve("scout").agent;

  assert.ok(scout);
  assert.ok(childToolNames(scout, "Review PR comments and map relevant branch context.").includes("bash"));
});

test("read-only built-in agent prompts do not mention unavailable edit tooling", () => {
  const cwd = tempDir("pi-chalin-cwd-");
  const catalog = AgentCatalog.load({ cwd });

  for (const name of ["planner", "reviewer", "scout"]) {
    const prompt = catalog.resolve(name).agent?.systemPrompt ?? "";
    assert.doesNotMatch(prompt, /\bedit\b/i, `${name} should not mention edit`);
  }
});

test("edge implementation contracts live in the contextual skill, not base agents", () => {
  const cwd = tempDir("pi-chalin-cwd-");
  const catalog = AgentCatalog.load({ cwd });
  const worker = catalog.resolve("worker").agent?.systemPrompt ?? "";
  const reviewer = catalog.resolve("reviewer").agent?.systemPrompt ?? "";
  const skill = fs.readFileSync(path.join(process.cwd(), "skills", "implementation-contract-edges", "SKILL.md"), "utf-8");
  const edgePatterns = [
    /Parser, scanner, tokenizer, and state-machine work/,
    /Normalization, sorting, filtering, and key-builder work/,
    /Time, retry, cache, rate, budget, and window behavior/,
    /Scaffold, package, CLI, and entrypoint work/,
  ];

  for (const pattern of edgePatterns) {
    assert.doesNotMatch(worker, pattern);
    assert.doesNotMatch(reviewer, pattern);
    assert.match(skill, pattern);
  }
  assert.match(reviewer, /always emit `## Reviewer Verdict` JSON/);
  assert.match(reviewer, /`verdict: "pass"`/);
});

test("AgentCatalog validates per-agent thinking frontmatter", () => {
  const cwd = tempDir("pi-chalin-cwd-");
  fs.mkdirSync(path.join(cwd, ".pi-chalin", "agents"), { recursive: true });
  fs.writeFileSync(path.join(cwd, ".pi-chalin", "agents", "thinker.md"), `---\nname: thinker\ndescription: custom thinker\nconcern: planning\nmodel: inherit\nthinking: xhigh\ntools: read\n---\nThink carefully.\n`, "utf-8");
  fs.writeFileSync(path.join(cwd, ".pi-chalin", "agents", "bad-thinker.md"), `---\nname: bad-thinker\ndescription: bad thinker\nconcern: planning\nmodel: inherit\nthinking: huge\ntools: read\n---\nThink badly.\n`, "utf-8");

  const catalog = AgentCatalog.load({ cwd });

  assert.equal(catalog.resolve("thinker").agent?.thinking, "xhigh");
  assert.equal(catalog.resolve("bad-thinker").agent?.thinking, "inherit");
  assert.match(catalog.diagnostics.warnings.join("\n"), /unknown thinking level 'huge'/);
});

test("AgentCatalog default resolution prefers project over user over built-in", () => {
  const cwd = tempDir("pi-chalin-cwd-");
  const userRoot = tempDir("pi-chalin-user-");
  writeAgent(path.join(userRoot, "agents", "worker.md"), "worker", "user worker");
  writeAgent(path.join(cwd, ".pi-chalin", "agents", "worker.md"), "worker", "project worker");

  const catalog = AgentCatalog.load({ cwd, userRoot });
  assert.equal(catalog.resolve("worker").agent?.scope, "project");
  assert.equal(catalog.resolve("user/worker").agent?.scope, "user");
  assert.equal(catalog.resolve("built-in/worker").agent?.scope, "built-in");
});

test("AgentCatalog reports invalid explicit scope clearly", () => {
  const cwd = tempDir("pi-chalin-cwd-");
  const catalog = AgentCatalog.load({ cwd });
  const result = catalog.resolve("team/worker");
  assert.match(result.error ?? "", /Unknown agent scope/);
});
