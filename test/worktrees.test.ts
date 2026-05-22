import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, test } from "node:test";
import { cleanupWorktrees, mergeWorktreeChanges, needsWorktreeIsolation, prepareWorktreeIsolation } from "../src/worktrees.ts";
import type { AgentDefinition } from "../src/schemas.ts";

const tempDirs: string[] = [];
afterEach(() => { while (tempDirs.length > 0) fs.rmSync(tempDirs.pop()!, { recursive: true, force: true }); });
function tempDir(prefix: string): string { const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix)); tempDirs.push(dir); return dir; }
function git(cwd: string, args: string[]) { const result = spawnSync("git", args, { cwd, encoding: "utf-8" }); assert.equal(result.status, 0, result.stderr); return result.stdout.trim(); }
function agent(name: string, caps: AgentDefinition["capabilities"]): AgentDefinition {
  return { name, scope: "built-in", concern: "implementation", capabilities: caps, description: name, model: "inherit", tools: [], memory: { read: false, write: "never", categories: [] }, systemPrompt: "", diagnostics: [] };
}

test("worktree isolation detects parallel writer contention", () => {
  const agents = new Map([["worker-a", agent("worker-a", ["edit-files"])], ["worker-b", agent("worker-b", ["write-new-files"])]]) as Map<string, AgentDefinition>;
  assert.equal(needsWorktreeIsolation([{ agent: "worker-a", task: "a" }, { agent: "worker-b", task: "b" }], agents), true);
});

test("worktree isolation creates isolated branches and merges clean patches", () => {
  const cwd = tempDir("pi-chalin-worktree-");
  git(cwd, ["init"]);
  git(cwd, ["config", "user.email", "pi-chalin@example.com"]);
  git(cwd, ["config", "user.name", "pi-chalin"]);
  fs.writeFileSync(path.join(cwd, "a.txt"), "one\n");
  git(cwd, ["add", "."]);
  git(cwd, ["commit", "-m", "init"]);
  const agents = new Map([["worker-a", agent("worker-a", ["edit-files"])], ["worker-b", agent("worker-b", ["write-new-files"])]]) as Map<string, AgentDefinition>;
  const plan = prepareWorktreeIsolation({ cwd, runId: "mesh-test", steps: [{ agent: "worker-a", task: "a" }, { agent: "worker-b", task: "b" }], agents });
  assert.equal(plan.enabled, true, plan.warnings.join("\n"));
  assert.equal(plan.worktrees.length, 2);
  fs.appendFileSync(path.join(plan.worktrees[0]!.path, "a.txt"), "two\n");
  const merge = mergeWorktreeChanges({ cwd, plan: { ...plan, worktrees: [plan.worktrees[0]!] } });
  assert.deepEqual(merge.applied, ["worker-a"]);
  assert.match(fs.readFileSync(path.join(cwd, "a.txt"), "utf-8"), /two/);
  const warnings = cleanupWorktrees({ cwd, plan });
  assert.deepEqual(warnings, []);
});

test("worktree isolation allows dirty primary worktrees but detects overlapping merge conflicts", () => {
  const cwd = tempDir("pi-chalin-worktree-dirty-");
  git(cwd, ["init"]);
  git(cwd, ["config", "user.email", "pi-chalin@example.com"]);
  git(cwd, ["config", "user.name", "pi-chalin"]);
  fs.writeFileSync(path.join(cwd, "a.txt"), "one\n");
  git(cwd, ["add", "."]);
  git(cwd, ["commit", "-m", "init"]);
  fs.writeFileSync(path.join(cwd, "a.txt"), "local dirty change\n");

  const agents = new Map([["worker-a", agent("worker-a", ["edit-files"])], ["worker-b", agent("worker-b", ["write-new-files"])]]) as Map<string, AgentDefinition>;
  const plan = prepareWorktreeIsolation({ cwd, runId: "mesh-dirty", steps: [{ agent: "worker-a", task: "a" }, { agent: "worker-b", task: "b" }], agents });

  assert.equal(plan.enabled, true, plan.warnings.join("\n"));
  assert.match(plan.warnings.join("\n"), /dirty primary worktree/i);
  fs.writeFileSync(path.join(plan.worktrees[0]!.path, "a.txt"), "isolated writer change\n");

  const merge = mergeWorktreeChanges({ cwd, plan: { ...plan, worktrees: [plan.worktrees[0]!] } });

  assert.deepEqual(merge.applied, []);
  assert.equal(merge.conflicts.length, 1);
  assert.match(merge.conflicts[0]!.reason, /patch|apply|conflict|error/i);
  assert.match(merge.conflicts[0]!.patch ?? "", /isolated writer change/);
  const warnings = cleanupWorktrees({ cwd, plan });
  assert.deepEqual(warnings, []);
});

test("worktree merge includes new untracked files from isolated writers", () => {
  const cwd = tempDir("pi-chalin-worktree-new-file-");
  git(cwd, ["init"]);
  git(cwd, ["config", "user.email", "pi-chalin@example.com"]);
  git(cwd, ["config", "user.name", "pi-chalin"]);
  fs.writeFileSync(path.join(cwd, "a.txt"), "one\n");
  git(cwd, ["add", "."]);
  git(cwd, ["commit", "-m", "init"]);

  const agents = new Map([["worker-a", agent("worker-a", ["write-new-files"])], ["worker-b", agent("worker-b", ["edit-files"])]]) as Map<string, AgentDefinition>;
  const plan = prepareWorktreeIsolation({ cwd, runId: "mesh-new-file", steps: [{ agent: "worker-a", task: "add test" }, { agent: "worker-b", task: "edit" }], agents });
  assert.equal(plan.enabled, true, plan.warnings.join("\n"));
  fs.mkdirSync(path.join(plan.worktrees[0]!.path, "tests"), { recursive: true });
  fs.writeFileSync(path.join(plan.worktrees[0]!.path, "tests", "new.test.js"), "export const ok = true;\n");

  const merge = mergeWorktreeChanges({ cwd, plan: { ...plan, worktrees: [plan.worktrees[0]!] } });

  assert.deepEqual(merge.applied, ["worker-a"]);
  assert.equal(merge.conflicts.length, 0);
  assert.equal(fs.readFileSync(path.join(cwd, "tests", "new.test.js"), "utf-8"), "export const ok = true;\n");
  cleanupWorktrees({ cwd, plan });
});
