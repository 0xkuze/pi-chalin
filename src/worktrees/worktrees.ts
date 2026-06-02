import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import type { ChalinPathsOptions } from "../config/paths.ts";
import type { AgentDefinition, AgentStep } from "../domain/schemas.ts";

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

export type DeclaredFilesByStepId = Map<string, string[]> | Record<string, string[]>;

export function needsWorktreeIsolation(steps: AgentStep[], agents: Map<string, AgentDefinition>): boolean {
  return steps.filter((step) => isWriterAgent(agents.get(step.agent))).length > 1;
}

export function prepareWorktreeIsolation(options: ChalinPathsOptions & { runId: string; steps: AgentStep[]; agents: Map<string, AgentDefinition> }): WorktreeIsolationPlan {
  if (!needsWorktreeIsolation(options.steps, options.agents)) {
    return { enabled: false, reason: "No parallel writer contention detected.", worktrees: [], warnings: [] };
  }
  const warnings: string[] = [];
  const gitRoot = git(options.cwd, ["rev-parse", "--show-toplevel"]);
  if (!gitRoot.ok) return { enabled: false, reason: "Parallel writers require a git repository for worktree isolation.", worktrees: [], warnings: [gitRoot.stderr] };
  const status = git(options.cwd, ["status", "--porcelain", "--untracked-files=all"]);
  if (!status.ok) return { enabled: false, reason: "Could not inspect git status before worktree isolation.", worktrees: [], warnings: [status.stderr] };
  const dirtyPrimaryPaths = dirtyPathsFromStatus(status.stdout);
  if (status.stdout.trim()) {
    warnings.push("Dirty primary worktree detected; isolated writer patches will be checked against the current local state before applying.");
  }

  const repoRoot = gitRoot.stdout.trim();
  const baseDir = path.join(path.dirname(repoRoot), ".pi-chalin-worktrees", safeName(path.basename(repoRoot)), options.runId);
  fs.mkdirSync(baseDir, { recursive: true });
  const worktrees: WorktreeIsolationPlan["worktrees"] = [];
  for (const [index, step] of options.steps.entries()) {
    if (!isWriterAgent(options.agents.get(step.agent))) continue;
    const stepId = normalizedStepId(step.id) ?? `step-${index + 1}`;
    const safeStepId = safeName(stepId);
    const branch = `pi-chalin/${options.runId}/${safeStepId}-${safeName(step.agent)}`;
    const target = path.join(baseDir, `${safeStepId}-${safeName(step.agent)}`);
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
    const synced = syncDirtyPrimaryPaths(repoRoot, target, dirtyPrimaryPaths);
    if (synced > 0) warnings.push(`Synced ${synced} dirty primary path(s) into isolated worktree for ${step.agent}.`);
    worktrees.push({ stepId, agent: step.agent, path: target, branch });
  }
  return worktrees.length > 0
    ? { enabled: true, reason: "Parallel writer worktrees created; merge patches back sequentially after review.", worktrees, warnings }
    : { enabled: false, reason: "No writer worktrees could be created.", worktrees, warnings };
}

export function mergeWorktreeChanges(options: { cwd: string; plan: WorktreeIsolationPlan; declaredFilesByStepId?: DeclaredFilesByStepId }): WorktreeMergeResult {
  const applied: string[] = [];
  const conflicts: WorktreeMergeResult["conflicts"] = [];
  const warnings: string[] = [];
  for (const worktree of options.plan.worktrees) {
    const declaredFiles = declaredWorktreeFiles(options.declaredFilesByStepId, worktree.stepId);
    if (options.declaredFilesByStepId !== undefined && declaredFiles.length === 0) {
      warnings.push(`${worktree.agent} isolated patch was not merged because no completed step declared changed files for ${worktree.stepId}.`);
      continue;
    }
    const existingDeclaredFiles = declaredFiles.filter((file) => fs.existsSync(path.join(worktree.path, file)));
    const markPathspec = declaredFiles.length > 0 ? existingDeclaredFiles : ["."];
    const markNewFiles = markPathspec.length > 0
      ? git(worktree.path, ["add", "-N", "--", ...markPathspec])
      : { ok: true, stdout: "", stderr: "" };
    if (!markNewFiles.ok) warnings.push(`Could not mark new files for ${worktree.agent}: ${markNewFiles.stderr}`);
    const diffPathspec = declaredFiles.length > 0 ? ["--", ...declaredFiles] : [];
    const diff = git(worktree.path, ["diff", "--binary", "HEAD", ...diffPathspec]);
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

function declaredWorktreeFiles(filesByStepId: DeclaredFilesByStepId | undefined, stepId: string): string[] {
  const raw = filesByStepId instanceof Map ? filesByStepId.get(stepId) : filesByStepId?.[stepId];
  if (!Array.isArray(raw)) return [];
  return [...new Set(raw.flatMap((file) => {
    const normalized = normalizeDeclaredWorktreeFile(file);
    return normalized ? [normalized] : [];
  }))];
}

function normalizeDeclaredWorktreeFile(file: string): string | undefined {
  const normalized = file.trim().replace(/\\/g, "/").replace(/^\.\/+/, "");
  if (!normalized || path.isAbsolute(normalized)) return undefined;
  if (normalized === "." || normalized === ".." || normalized.startsWith("../") || normalized.includes("/../")) return undefined;
  if (normalized === ".git" || normalized.startsWith(".git/")) return undefined;
  return normalized;
}

function normalizedStepId(stepId: string | undefined): string | undefined {
  const normalized = stepId?.trim();
  if (!normalized || normalized.length > 120) return undefined;
  if (normalized === "." || normalized === ".." || normalized.includes("/") || normalized.includes("\\")) return undefined;
  return normalized;
}

function dirtyPathsFromStatus(stdout: string): string[] {
  const seen = new Set<string>();
  const paths: string[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    if (!line.trim()) continue;
    for (const candidate of dirtyPathsFromStatusLine(line)) {
      const normalized = normalizeDeclaredWorktreeFile(candidate);
      if (!normalized || normalized.startsWith(".pi-chalin/") || seen.has(normalized)) continue;
      seen.add(normalized);
      paths.push(normalized);
    }
  }
  return paths;
}

function dirtyPathsFromStatusLine(line: string): string[] {
  if (line.length < 4) return [];
  const rawPath = line.slice(3).trim();
  if (!rawPath) return [];
  const arrowIndex = rawPath.lastIndexOf(" -> ");
  if (arrowIndex < 0) return [unquoteGitStatusPath(rawPath)];
  return [rawPath.slice(0, arrowIndex), rawPath.slice(arrowIndex + 4)].map(unquoteGitStatusPath);
}

function unquoteGitStatusPath(filePath: string): string {
  const trimmed = filePath.trim();
  if (trimmed.length >= 2 && trimmed.startsWith("\"") && trimmed.endsWith("\"")) {
    return trimmed.slice(1, -1).replace(/\\"/g, "\"").replace(/\\\\/g, "\\");
  }
  return trimmed;
}

function syncDirtyPrimaryPaths(repoRoot: string, worktreePath: string, dirtyPaths: string[]): number {
  let synced = 0;
  for (const dirtyPath of dirtyPaths) {
    const normalized = normalizeDeclaredWorktreeFile(dirtyPath);
    if (!normalized) continue;
    const source = path.join(repoRoot, normalized);
    const target = path.join(worktreePath, normalized);
    if (fs.existsSync(source)) {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.cpSync(source, target, { recursive: true, force: true, errorOnExist: false });
      synced += 1;
      continue;
    }
    if (fs.existsSync(target)) {
      fs.rmSync(target, { recursive: true, force: true });
      synced += 1;
    }
  }
  return synced;
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
