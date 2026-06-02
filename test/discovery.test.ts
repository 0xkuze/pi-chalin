import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, test } from "bun:test";
import { buildProjectDiscoveryIndex, formatProjectDiscoveryIndex } from "../src/project/discovery.ts";

const tempDirs: string[] = [];
afterEach(() => { while (tempDirs.length > 0) fs.rmSync(tempDirs.pop()!, { recursive: true, force: true }); });
function tempDir(prefix: string): string { const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix)); tempDirs.push(dir); return dir; }

test("project discovery indexes unusual nested layouts without semantic hardcoding", () => {
  const dir = tempDir("pi-chalin-discovery-");
  fs.mkdirSync(path.join(dir, "weird-zone", "alpha", "src"), { recursive: true });
  fs.mkdirSync(path.join(dir, "weird-zone", "alpha", "docs", "adr"), { recursive: true });
  fs.mkdirSync(path.join(dir, "runtime", "edge", "checks"), { recursive: true });
  fs.mkdirSync(path.join(dir, "node_modules", "ignored"), { recursive: true });
  fs.mkdirSync(path.join(dir, ".workflow-oracle"), { recursive: true });
  fs.writeFileSync(path.join(dir, "AGENTS.md"), "Read me first.\n");
  fs.writeFileSync(path.join(dir, "weird-zone", "alpha", "AGENTS.md"), "Package rules.\n");
  fs.writeFileSync(path.join(dir, "weird-zone", "alpha", "docs", "adr", "0001.md"), "Decision.\n");
  fs.writeFileSync(path.join(dir, "workspace.anything"), "members = ['weird-zone/*']\n");
  fs.writeFileSync(path.join(dir, "weird-zone", "alpha", "manifest.custom.json"), "{}\n");
  fs.writeFileSync(path.join(dir, "weird-zone", "alpha", "src", "entry.strange"), "boot\n");
  fs.writeFileSync(path.join(dir, "runtime", "edge", "checks", "health.spec.strange"), "test\n");
  fs.writeFileSync(path.join(dir, "node_modules", "ignored", "huge.js"), "ignored\n");
  fs.writeFileSync(path.join(dir, ".workflow-oracle", "README.md"), "hidden eval boundary\n");

  const index = buildProjectDiscoveryIndex(dir, { maxDepth: 5, maxEntries: 100 });
  const text = formatProjectDiscoveryIndex(index);

  assert.ok(index.entries.some((entry) => entry.path === "weird-zone/alpha/src/entry.strange"));
  assert.ok(index.entries.some((entry) => entry.path === "runtime/edge/checks/health.spec.strange"));
  assert.equal(index.entries.some((entry) => entry.path.includes("node_modules")), false);
  assert.equal(index.entries.some((entry) => entry.path.includes(".workflow-oracle")), false);
  assert.ok(index.entries.some((entry) => entry.path === "weird-zone/alpha/manifest.custom.json" && entry.type === "file"));
  assert.ok(index.entries.some((entry) => entry.path === "AGENTS.md" && entry.type === "file"));
  assert.ok(index.entries.some((entry) => entry.path === "weird-zone/alpha/AGENTS.md" && entry.type === "file"));
  assert.ok(index.entries.some((entry) => entry.path === "weird-zone/alpha/docs/adr/0001.md" && entry.type === "file"));
  assert.doesNotMatch(text, /instruction\/JIT files/i);
  assert.doesNotMatch(text, /read the root instruction file/i);
  assert.match(text, /raw filesystem facts, non-semantic/i);
});

test("project discovery keeps generated shard noise compact", () => {
  const dir = tempDir("pi-chalin-discovery-compact-");
  fs.mkdirSync(path.join(dir, "src"), { recursive: true });
  fs.mkdirSync(path.join(dir, "evals", "results", ".workflow-shards-2026-06-01T00-00-00-000Z-a"), { recursive: true });
  fs.mkdirSync(path.join(dir, "evals", "results", ".workflow-shards-2026-06-01T00-00-00-000Z-b"), { recursive: true });
  fs.mkdirSync(path.join(dir, "evals", "results", ".workflow-shards-2026-06-01T00-00-00-000Z-c"), { recursive: true });
  fs.mkdirSync(path.join(dir, "evals", "results", ".workflow-shards-2026-06-01T00-00-00-000Z-d"), { recursive: true });
  fs.mkdirSync(path.join(dir, "evals", "results", ".workflow-shards-2026-06-01T00-00-00-000Z-e"), { recursive: true });
  fs.writeFileSync(path.join(dir, "src", "index.ts"), "export const value = 1;\n");

  const index = buildProjectDiscoveryIndex(dir, { maxDepth: 5, maxEntries: 100 });
  const text = formatProjectDiscoveryIndex(index, { maxEntries: 20 });

  assert.equal(index.entries.some((entry) => entry.path.includes(".workflow-shards")), false);
  assert.ok(index.entries.some((entry) => entry.path === "src/index.ts"));
  assert.match(text, /ignored dirs:/i);
  assert.match(text, /\.\.\. 1 more/i);
  assert.ok(text.length < 900, `compact discovery should stay small, got ${text.length}`);
});

test("project discovery excludes Pi runtime artifacts from project inventory", () => {
  const dir = tempDir("pi-chalin-discovery-runtime-");
  fs.mkdirSync(path.join(dir, "src"), { recursive: true });
  fs.mkdirSync(path.join(dir, ".pi-chalin", "runs"), { recursive: true });
  fs.mkdirSync(path.join(dir, ".pi-chalin-hidden-child-sessions", "archived"), { recursive: true });
  fs.mkdirSync(path.join(dir, ".pi-sessions", "active-session", "pi-chalin"), { recursive: true });
  fs.writeFileSync(path.join(dir, "src", "index.ts"), "export const value = 1;\n");
  fs.writeFileSync(path.join(dir, ".pi-chalin", "runs", "run.json"), "{}\n");
  fs.writeFileSync(path.join(dir, ".pi-chalin-hidden-child-sessions", "archived", "child.jsonl"), "{}\n");
  fs.writeFileSync(path.join(dir, ".pi-sessions", "parent.jsonl"), "{}\n");
  fs.writeFileSync(path.join(dir, ".pi-sessions", "active-session", "pi-chalin", "child.jsonl"), "{}\n");

  const index = buildProjectDiscoveryIndex(dir, { maxDepth: 5, maxEntries: 100 });

  assert.ok(index.entries.some((entry) => entry.path === "src/index.ts"));
  assert.equal(index.entries.some((entry) => entry.path.includes(".pi-chalin")), false);
  assert.equal(index.entries.some((entry) => entry.path.includes(".pi-chalin-hidden-child-sessions")), false);
  assert.equal(index.entries.some((entry) => entry.path.includes(".pi-sessions")), false);
  assert.deepEqual(index.ignoredDirs.filter((entry) => entry.startsWith(".pi")).sort(), [
    ".pi-chalin",
    ".pi-chalin-hidden-child-sessions",
    ".pi-sessions",
  ]);
});
