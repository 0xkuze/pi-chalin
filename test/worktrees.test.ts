import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, test } from "vitest";
import { cleanupWorktrees, mergeWorktreeChanges, needsWorktreeIsolation, prepareWorktreeIsolation } from "../src/worktrees/worktrees.ts";
import type { AgentDefinition } from "../src/domain/schemas.ts";

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
  const plan = prepareWorktreeIsolation({ cwd, runId: "chalin-test", steps: [{ agent: "worker-a", task: "a" }, { agent: "worker-b", task: "b" }], agents });
  assert.equal(plan.enabled, true, plan.warnings.join("\n"));
  assert.equal(plan.worktrees.length, 2);
  fs.appendFileSync(path.join(plan.worktrees[0]!.path, "a.txt"), "two\n");
  const merge = mergeWorktreeChanges({ cwd, plan: { ...plan, worktrees: [plan.worktrees[0]!] } });
  assert.deepEqual(merge.applied, ["worker-a"]);
  assert.match(fs.readFileSync(path.join(cwd, "a.txt"), "utf-8"), /two/);
  const warnings = cleanupWorktrees({ cwd, plan });
  assert.deepEqual(warnings, []);
});

test("worktree isolation preserves structured task ids for lookup and merge", () => {
  const cwd = tempDir("pi-chalin-worktree-step-ids-");
  git(cwd, ["init"]);
  git(cwd, ["config", "user.email", "pi-chalin@example.com"]);
  git(cwd, ["config", "user.name", "pi-chalin"]);
  fs.writeFileSync(path.join(cwd, "a.txt"), "one\n");
  git(cwd, ["add", "."]);
  git(cwd, ["commit", "-m", "init"]);

  const agents = new Map([["worker-a", agent("worker-a", ["edit-files"])], ["worker-b", agent("worker-b", ["write-new-files"])]]) as Map<string, AgentDefinition>;
  const plan = prepareWorktreeIsolation({
    cwd,
    runId: "chalin-step-ids",
    steps: [{ id: "step-2", agent: "worker-a", task: "a" }, { id: "step-4", agent: "worker-b", task: "b" }],
    agents,
  });

  assert.equal(plan.enabled, true, plan.warnings.join("\n"));
  assert.deepEqual(plan.worktrees.map((worktree) => worktree.stepId), ["step-2", "step-4"]);
  cleanupWorktrees({ cwd, plan });
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
  const plan = prepareWorktreeIsolation({ cwd, runId: "chalin-dirty", steps: [{ agent: "worker-a", task: "a" }, { agent: "worker-b", task: "b" }], agents });

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

test("worktree isolation mirrors dirty primary files into isolated workers", () => {
  const cwd = tempDir("pi-chalin-worktree-dirty-sync-");
  git(cwd, ["init"]);
  git(cwd, ["config", "user.email", "pi-chalin@example.com"]);
  git(cwd, ["config", "user.name", "pi-chalin"]);
  fs.writeFileSync(path.join(cwd, "a.txt"), "one\n");
  git(cwd, ["add", "."]);
  git(cwd, ["commit", "-m", "init"]);
  fs.writeFileSync(path.join(cwd, "a.txt"), "dirty primary\n");
  fs.mkdirSync(path.join(cwd, "locks"), { recursive: true });
  fs.writeFileSync(path.join(cwd, "locks", "deps.lock"), "locked\n");
  fs.mkdirSync(path.join(cwd, ".pi-chalin", "runs"), { recursive: true });
  fs.writeFileSync(path.join(cwd, ".pi-chalin", "runs", "runtime.json"), "{}\n");

  const agents = new Map([["worker-a", agent("worker-a", ["edit-files"])], ["worker-b", agent("worker-b", ["write-new-files"])]]) as Map<string, AgentDefinition>;
  const plan = prepareWorktreeIsolation({ cwd, runId: "chalin-dirty-sync", steps: [{ agent: "worker-a", task: "a" }, { agent: "worker-b", task: "b" }], agents });

  assert.equal(plan.enabled, true, plan.warnings.join("\n"));
  assert.match(plan.warnings.join("\n"), /Synced 2 dirty primary path\(s\)/);
  for (const worktree of plan.worktrees) {
    assert.equal(fs.readFileSync(path.join(worktree.path, "a.txt"), "utf-8"), "dirty primary\n");
    assert.equal(fs.readFileSync(path.join(worktree.path, "locks", "deps.lock"), "utf-8"), "locked\n");
    assert.equal(fs.existsSync(path.join(worktree.path, ".pi-chalin", "runs", "runtime.json")), false);
  }
  cleanupWorktrees({ cwd, plan });
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
  const plan = prepareWorktreeIsolation({ cwd, runId: "chalin-new-file", steps: [{ agent: "worker-a", task: "add test" }, { agent: "worker-b", task: "edit" }], agents });
  assert.equal(plan.enabled, true, plan.warnings.join("\n"));
  fs.mkdirSync(path.join(plan.worktrees[0]!.path, "tests"), { recursive: true });
  fs.writeFileSync(path.join(plan.worktrees[0]!.path, "tests", "new.test.js"), "export const ok = true;\n");

  const merge = mergeWorktreeChanges({ cwd, plan: { ...plan, worktrees: [plan.worktrees[0]!] } });

  assert.deepEqual(merge.applied, ["worker-a"]);
  assert.equal(merge.conflicts.length, 0);
  assert.equal(fs.readFileSync(path.join(cwd, "tests", "new.test.js"), "utf-8"), "export const ok = true;\n");
  cleanupWorktrees({ cwd, plan });
});

test("worktree merge applies declared files without merging transient outputs", () => {
  const cwd = tempDir("pi-chalin-worktree-declared-files-");
  git(cwd, ["init"]);
  git(cwd, ["config", "user.email", "pi-chalin@example.com"]);
  git(cwd, ["config", "user.name", "pi-chalin"]);
  fs.mkdirSync(path.join(cwd, "cmd", "api"), { recursive: true });
  fs.writeFileSync(path.join(cwd, "cmd", "api", "main.go"), "package main\nfunc main() {}\n");
  git(cwd, ["add", "."]);
  git(cwd, ["commit", "-m", "init"]);

  const agents = new Map([["worker-a", agent("worker-a", ["edit-files"])]]) as Map<string, AgentDefinition>;
  const plan = prepareWorktreeIsolation({ cwd, runId: "chalin-declared-files", steps: [{ agent: "worker-a", task: "edit api" }, { agent: "worker-a", task: "edit api 2" }], agents });
  assert.equal(plan.enabled, true, plan.warnings.join("\n"));
  const worktree = plan.worktrees[0]!;
  const undeclaredWorktree = plan.worktrees[1]!;
  fs.writeFileSync(path.join(worktree.path, "cmd", "api", "main.go"), "package main\nimport \"fmt\"\nfunc main() { fmt.Println(\"ok\") }\n");
  fs.writeFileSync(path.join(worktree.path, "api"), "\0generated-binary");
  fs.writeFileSync(path.join(undeclaredWorktree.path, "leaked.txt"), "failed worker output\n");

  const merge = mergeWorktreeChanges({
    cwd,
    plan: { ...plan, worktrees: [worktree, undeclaredWorktree] },
    declaredFilesByStepId: new Map([[worktree.stepId, ["cmd/api/main.go"]]]),
  });

  assert.deepEqual(merge.applied, ["worker-a"]);
  assert.equal(merge.conflicts.length, 0);
  assert.match(merge.warnings.join("\n"), /not merged because no completed step declared changed files/i);
  assert.match(fs.readFileSync(path.join(cwd, "cmd", "api", "main.go"), "utf-8"), /fmt\.Println/);
  assert.equal(fs.existsSync(path.join(cwd, "api")), false, "transient generated output must not be merged into the primary worktree");
  assert.equal(fs.existsSync(path.join(cwd, "leaked.txt")), false, "undeclared isolated output must not be merged into the primary worktree");
  cleanupWorktrees({ cwd, plan });
});
