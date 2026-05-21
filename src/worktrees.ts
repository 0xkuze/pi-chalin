import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import type { MeshPathsOptions } from "./paths.ts";
import type { AgentDefinition, AgentStep } from "./schemas.ts";

export interface WorktreeIsolationPlan {
  enabled: boolean;
  reason: string;
  worktrees: Array<{ stepId: string; agent: string; path: string; branch: string }>;
  warnings: string[];
}

export interface WorktreeMergeResult {
  applied: string[];
  conflicts: Array<{ agent: string; stepId?: string; reason: string; patch?: string; worktreePath?: string }>;
  warnings: string[];
}

export function needsWorktreeIsolation(steps: AgentStep[], agents: Map<string, AgentDefinition>): boolean {
  return steps.filter((step) => isWriterAgent(agents.get(step.agent))).length > 1;
}

export function prepareWorktreeIsolation(options: MeshPathsOptions & { runId: string; steps: AgentStep[]; agents: Map<string, AgentDefinition> }): WorktreeIsolationPlan {
  if (!needsWorktreeIsolation(options.steps, options.agents)) {
    return { enabled: false, reason: "No parallel writer contention detected.", worktrees: [], warnings: [] };
  }
  const warnings: string[] = [];
  const gitRoot = git(options.cwd, ["rev-parse", "--show-toplevel"]);
  if (!gitRoot.ok) return { enabled: false, reason: "Parallel writers require a git repository for worktree isolation.", worktrees: [], warnings: [gitRoot.stderr] };
  const status = git(options.cwd, ["status", "--porcelain"]);
  if (!status.ok) return { enabled: false, reason: "Could not inspect git status before worktree isolation.", worktrees: [], warnings: [status.stderr] };
  if (status.stdout.trim()) {
    warnings.push("Dirty primary worktree detected; isolated writer patches will be checked against the current local state before applying.");
  }

  const repoRoot = gitRoot.stdout.trim();
  const baseDir = path.join(path.dirname(repoRoot), ".pi-mesh-worktrees", safeName(path.basename(repoRoot)), options.runId);
  fs.mkdirSync(baseDir, { recursive: true });
  const worktrees: WorktreeIsolationPlan["worktrees"] = [];
  for (const [index, step] of options.steps.entries()) {
    if (!isWriterAgent(options.agents.get(step.agent))) continue;
    const stepId = `step-${index + 1}`;
    const branch = `pi-mesh/${options.runId}/${stepId}-${safeName(step.agent)}`;
    const target = path.join(baseDir, `${stepId}-${safeName(step.agent)}`);
    const branchResult = git(options.cwd, ["branch", branch, "HEAD"]);
    if (!branchResult.ok && !branchResult.stderr.includes("already exists")) {
      warnings.push(`Could not create branch ${branch}: ${branchResult.stderr}`);
      continue;
    }
    const add = git(options.cwd, ["worktree", "add", target, branch]);
    if (!add.ok) {
      warnings.push(`Could not create worktree for ${step.agent}: ${add.stderr}`);
      continue;
    }
    worktrees.push({ stepId, agent: step.agent, path: target, branch });
  }
  return worktrees.length > 0
    ? { enabled: true, reason: "Parallel writer worktrees created; merge patches back sequentially after review.", worktrees, warnings }
    : { enabled: false, reason: "No writer worktrees could be created.", worktrees, warnings };
}

export function mergeWorktreeChanges(options: { cwd: string; plan: WorktreeIsolationPlan }): WorktreeMergeResult {
  const applied: string[] = [];
  const conflicts: WorktreeMergeResult["conflicts"] = [];
  const warnings: string[] = [];
  for (const worktree of options.plan.worktrees) {
    const markNewFiles = git(worktree.path, ["add", "-N", "--", "."]);
    if (!markNewFiles.ok) warnings.push(`Could not mark new files for ${worktree.agent}: ${markNewFiles.stderr}`);
    const diff = git(worktree.path, ["diff", "--binary", "HEAD"]);
    if (!diff.ok) {
      conflicts.push({ agent: worktree.agent, stepId: worktree.stepId, reason: diff.stderr || "could not read worktree diff", worktreePath: worktree.path });
      continue;
    }
    if (!diff.stdout.trim()) {
      warnings.push(`${worktree.agent} produced no file diff.`);
      continue;
    }
    const check = spawnSync("git", ["apply", "--3way", "--check"], { cwd: options.cwd, input: diff.stdout, encoding: "utf-8" });
    if (check.status !== 0) {
      conflicts.push({ agent: worktree.agent, stepId: worktree.stepId, reason: check.stderr || "patch would not apply cleanly", patch: diff.stdout, worktreePath: worktree.path });
      continue;
    }
    const apply = spawnSync("git", ["apply", "--3way"], { cwd: options.cwd, input: diff.stdout, encoding: "utf-8" });
    if (apply.status !== 0) conflicts.push({ agent: worktree.agent, stepId: worktree.stepId, reason: apply.stderr || "patch apply failed", patch: diff.stdout, worktreePath: worktree.path });
    else applied.push(worktree.agent);
  }
  return { applied, conflicts, warnings };
}

export function cleanupWorktrees(options: { cwd: string; plan: WorktreeIsolationPlan }): string[] {
  const warnings: string[] = [];
  for (const worktree of options.plan.worktrees) {
    const remove = git(options.cwd, ["worktree", "remove", "--force", worktree.path]);
    if (!remove.ok) warnings.push(`Could not remove worktree ${worktree.path}: ${remove.stderr}`);
    const branch = git(options.cwd, ["branch", "-D", worktree.branch]);
    if (!branch.ok) warnings.push(`Could not delete branch ${worktree.branch}: ${branch.stderr}`);
  }
  return warnings;
}

function isWriterAgent(agent: AgentDefinition | undefined): boolean {
  return Boolean(agent?.capabilities.includes("edit-files") || agent?.capabilities.includes("write-new-files"));
}

function git(cwd: string, args: string[]): { ok: boolean; stdout: string; stderr: string } {
  const result = spawnSync("git", args, { cwd, encoding: "utf-8" });
  return { ok: result.status === 0, stdout: result.stdout, stderr: result.stderr.trim() };
}

function safeName(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "agent";
}
