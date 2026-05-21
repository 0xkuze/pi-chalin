import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, test } from "node:test";
import { AgentCatalog } from "../src/agents.ts";

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
  const cwd = tempDir("pi-mesh-cwd-");
  const catalog = AgentCatalog.load({ cwd });
  const names = catalog.list("built-in").map((agent) => agent.name);

  for (const expected of ["scout", "researcher", "context-builder", "planner", "worker", "reviewer", "conflict-resolver", "oracle", "delegate"]) {
    assert.equal(names.includes(expected), true, `${expected} should load`);
  }
});

test("AgentCatalog loads explicit concern capabilities", () => {
  const cwd = tempDir("pi-mesh-cwd-");
  const catalog = AgentCatalog.load({ cwd });
  const worker = catalog.resolve("worker").agent;
  const conflictResolver = catalog.resolve("conflict-resolver").agent;
  const planner = catalog.resolve("planner").agent;

  assert.ok(worker?.capabilities.includes("edit-files"));
  assert.ok(worker?.capabilities.includes("write-new-files"));
  assert.ok(conflictResolver?.capabilities.includes("edit-files"));
  assert.equal(conflictResolver?.capabilities.includes("write-new-files"), false);
  assert.equal(planner?.capabilities.includes("edit-files"), false);
  assert.equal(planner?.capabilities.includes("write-new-files"), false);
  assert.equal(worker?.thinking, "high");
  assert.equal(planner?.thinking, "high");
  assert.equal(catalog.resolve("scout").agent?.thinking, "low");
});

test("AgentCatalog validates per-agent thinking frontmatter", () => {
  const cwd = tempDir("pi-mesh-cwd-");
  fs.mkdirSync(path.join(cwd, ".pi-mesh", "agents"), { recursive: true });
  fs.writeFileSync(path.join(cwd, ".pi-mesh", "agents", "thinker.md"), `---\nname: thinker\ndescription: custom thinker\nconcern: planning\nmodel: inherit\nthinking: xhigh\ntools: read\n---\nThink carefully.\n`, "utf-8");
  fs.writeFileSync(path.join(cwd, ".pi-mesh", "agents", "bad-thinker.md"), `---\nname: bad-thinker\ndescription: bad thinker\nconcern: planning\nmodel: inherit\nthinking: huge\ntools: read\n---\nThink badly.\n`, "utf-8");

  const catalog = AgentCatalog.load({ cwd });

  assert.equal(catalog.resolve("thinker").agent?.thinking, "xhigh");
  assert.equal(catalog.resolve("bad-thinker").agent?.thinking, "inherit");
  assert.match(catalog.diagnostics.warnings.join("\n"), /unknown thinking level 'huge'/);
});

test("AgentCatalog default resolution prefers project over user over built-in", () => {
  const cwd = tempDir("pi-mesh-cwd-");
  const userRoot = tempDir("pi-mesh-user-");
  writeAgent(path.join(userRoot, "agents", "worker.md"), "worker", "user worker");
  writeAgent(path.join(cwd, ".pi-mesh", "agents", "worker.md"), "worker", "project worker");

  const catalog = AgentCatalog.load({ cwd, userRoot });
  assert.equal(catalog.resolve("worker").agent?.scope, "project");
  assert.equal(catalog.resolve("user/worker").agent?.scope, "user");
  assert.equal(catalog.resolve("built-in/worker").agent?.scope, "built-in");
});

test("AgentCatalog reports invalid explicit scope clearly", () => {
  const cwd = tempDir("pi-mesh-cwd-");
  const catalog = AgentCatalog.load({ cwd });
  const result = catalog.resolve("team/worker");
  assert.match(result.error ?? "", /Unknown agent scope/);
});
