import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, test } from "bun:test";
import { buildProjectDiscoveryIndex, formatProjectDiscoveryIndex } from "../src/discovery.ts";

const tempDirs: string[] = [];
afterEach(() => { while (tempDirs.length > 0) fs.rmSync(tempDirs.pop()!, { recursive: true, force: true }); });
function tempDir(prefix: string): string { const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix)); tempDirs.push(dir); return dir; }

test("project discovery indexes unusual nested layouts without semantic hardcoding", () => {
  const dir = tempDir("pi-chalin-discovery-");
  fs.mkdirSync(path.join(dir, "weird-zone", "alpha", "src"), { recursive: true });
  fs.mkdirSync(path.join(dir, "weird-zone", "alpha", "docs", "adr"), { recursive: true });
  fs.mkdirSync(path.join(dir, "runtime", "edge", "checks"), { recursive: true });
  fs.mkdirSync(path.join(dir, "node_modules", "ignored"), { recursive: true });
  fs.writeFileSync(path.join(dir, "AGENTS.md"), "Read me first.\n");
  fs.writeFileSync(path.join(dir, "weird-zone", "alpha", "AGENTS.md"), "Package rules.\n");
  fs.writeFileSync(path.join(dir, "weird-zone", "alpha", "docs", "adr", "0001.md"), "Decision.\n");
  fs.writeFileSync(path.join(dir, "workspace.anything"), "members = ['weird-zone/*']\n");
  fs.writeFileSync(path.join(dir, "weird-zone", "alpha", "manifest.custom.json"), "{}\n");
  fs.writeFileSync(path.join(dir, "weird-zone", "alpha", "src", "entry.strange"), "boot\n");
  fs.writeFileSync(path.join(dir, "runtime", "edge", "checks", "health.spec.strange"), "test\n");
  fs.writeFileSync(path.join(dir, "node_modules", "ignored", "huge.js"), "ignored\n");

  const index = buildProjectDiscoveryIndex(dir, { maxDepth: 5, maxEntries: 100 });
  const text = formatProjectDiscoveryIndex(index);

  assert.ok(index.entries.some((entry) => entry.path === "weird-zone/alpha/src/entry.strange"));
  assert.ok(index.entries.some((entry) => entry.path === "runtime/edge/checks/health.spec.strange"));
  assert.equal(index.entries.some((entry) => entry.path.includes("node_modules")), false);
  assert.ok(index.configLikeFiles.includes("weird-zone/alpha/manifest.custom.json"));
  assert.ok(index.testLikeFiles.includes("runtime/edge/checks/health.spec.strange"));
  assert.ok(index.instructionFiles.includes("AGENTS.md"));
  assert.ok(index.instructionFiles.includes("weird-zone/alpha/AGENTS.md"));
  assert.ok(index.instructionFiles.includes("weird-zone/alpha/docs/adr/0001.md"));
  assert.match(text, /instruction\/JIT files/i);
  assert.match(text, /read the root instruction file/i);
  assert.match(text, /raw, non-semantic/i);
});
