#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { ArtifactStore } from "../src/artifacts/artifacts.ts";
import { createMemoryCandidate, MemoryStore } from "../src/memory/memory.ts";
import type { AgentDefinition } from "../src/domain/schemas.ts";
import { cleanupWorktrees, mergeWorktreeChanges, prepareWorktreeIsolation } from "../src/worktrees/worktrees.ts";

interface MutationEvalCheck {
  id: string;
  pass: boolean;
  details: Record<string, unknown>;
}

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const startedAt = new Date().toISOString();
const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-chalin-mutation-eval-"));
const checks: MutationEvalCheck[] = [];
const warnings: string[] = [];

try {
  createFixture(cwd);
  const agents = new Map<string, AgentDefinition>([
    ["worker-feature", agent("worker-feature", ["inspect-files", "edit-files", "write-new-files", "validate", "memory-write"])],
    ["worker-test", agent("worker-test", ["inspect-files", "edit-files", "write-new-files", "validate", "memory-write"])],
    ["reviewer", agent("reviewer", ["inspect-files", "search-files", "run-safe-bash", "validate", "memory-write"], "review")],
  ]);
  const steps = [
    { agent: "worker-feature", task: "Change the feature flag with a surgical one-line edit." },
    { agent: "worker-test", task: "Add a focused regression test for the feature flag." },
  ];

  const plan = prepareWorktreeIsolation({ cwd, runId: `mutation-${Date.now().toString(36)}`, steps, agents });
  warnings.push(...plan.warnings);
  checks.push(check("worktree-isolation-created", plan.enabled && plan.worktrees.length === 2, { reason: plan.reason, worktrees: plan.worktrees.length, warnings: plan.warnings }));

  if (!plan.enabled) throw new Error(`worktree isolation failed: ${plan.reason}`);
  const featureWorktree = plan.worktrees.find((item) => item.agent === "worker-feature")!;
  const testWorktree = plan.worktrees.find((item) => item.agent === "worker-test")!;

  const featureFile = path.join(featureWorktree.path, "src", "feature.js");
  const beforeFeature = fs.readFileSync(featureFile, "utf-8");
  fs.writeFileSync(featureFile, beforeFeature.replace("enabled: false", "enabled: true"));
  const testDir = path.join(testWorktree.path, "tests");
  fs.mkdirSync(testDir, { recursive: true });
  fs.writeFileSync(path.join(testDir, "feature.test.mjs"), [
    "import { test } from 'bun:test';",
    "import assert from 'node:assert/strict';",
    "import { featureConfig } from '../src/feature.js';",
    "",
    "test('feature flag is enabled after isolated worker patch', () => {",
    "  assert.equal(featureConfig.enabled, true);",
    "});",
    "",
  ].join("\n"));

  const rewrite = rewriteRisk(featureWorktree.path, "src/feature.js");
  checks.push(check("worker-edit-is-surgical", !rewrite.rewriteRisk, rewrite));

  const merge = mergeWorktreeChanges({ cwd, plan });
  checks.push(check("merge-applied-without-conflict", merge.applied.length === 2 && merge.conflicts.length === 0, { applied: merge.applied, conflicts: merge.conflicts, warnings: merge.warnings }));
  warnings.push(...merge.warnings);

  const cleanupWarnings = cleanupWorktrees({ cwd, plan });
  warnings.push(...cleanupWarnings);
  checks.push(check("worktree-cleanup-ok", cleanupWarnings.length === 0, { cleanupWarnings }));

  const mergedFeature = fs.readFileSync(path.join(cwd, "src", "feature.js"), "utf-8");
  checks.push(check("primary-worktree-has-worker-change", /enabled: true/.test(mergedFeature), { mergedFeature }));
  checks.push(check("primary-worktree-has-test-change", fs.existsSync(path.join(cwd, "tests", "feature.test.mjs")), { testPath: "tests/feature.test.mjs" }));

  const validation = spawnSync("bun", ["test", "tests/feature.test.mjs"], { cwd, encoding: "utf-8", timeout: 15_000 });
  checks.push(check("reviewer-validation-passed", validation.status === 0, { status: validation.status, stdout: tail(validation.stdout), stderr: tail(validation.stderr) }));

  const artifacts = new ArtifactStore({ cwd });
  await artifacts.initFeature({ featureId: "mutation-worktree-gate", goal: "Verify isolated worker mutation, reviewer validation, artifacts, and memory capture.", chain: ["worker-feature", "worker-test", "reviewer"] });
  await artifacts.appendCheckpoint("mutation-worktree-gate", {
    agent: "worker-feature",
    title: "Feature flag patched",
    summary: "Worker changed src/feature.js with a one-line isolated worktree patch and merge applied cleanly.",
    status: "complete",
  });
  await artifacts.saveValidationContract("mutation-worktree-gate", {
    id: "feature-flag-bun-test",
    title: "Feature flag regression test",
    commands: ["bun test tests/feature.test.mjs"],
    successCriteria: ["The reviewer validation command exits 0", "The worker edit touches only the intended feature flag line"],
  });
  await artifacts.appendCheckpoint("mutation-worktree-gate", {
    agent: "reviewer",
    title: "Reviewer validation passed",
    summary: "Reviewer validated merged worker changes with bun test tests/feature.test.mjs and no worktree conflicts.",
    status: validation.status === 0 ? "complete" : "failed",
  });
  const artifactState = await artifacts.loadFeature("mutation-worktree-gate");
  checks.push(check("artifact-checkpoints-and-contract-persisted", Boolean(artifactState && artifactState.checkpoints.length >= 2 && artifactState.validationContracts.length === 1), { checkpoints: artifactState?.checkpoints.length, validationContracts: artifactState?.validationContracts.length }));

  const memory = new MemoryStore({ cwd });
  const [record] = await memory.submitCandidates([createMemoryCandidate({
    category: "bugfix",
    content: "Isolated worker patches can safely modify a feature flag through worktree merge when reviewer validation runs after merge and artifacts capture checkpoints plus validation contracts.",
    sourceAgent: "reviewer",
    confidence: 0.96,
    scope: "project",
    evidence: "mutation-worktree-gate eval",
  })]);
  const memoryHits = await memory.search("isolated worker patches feature flag reviewer validation artifacts", 5);
  checks.push(check("memory-candidate-active-and-retrievable", record?.status === "active" && memoryHits.some((hit) => hit.record.id === record.id), { status: record?.status, hits: memoryHits.length, content: record?.content }));

  const report = buildReport();
  writeReport(report);
  printReport(report);
  if (report.failed > 0 && process.env.PI_CHALIN_MUTATION_EVAL_ALLOW_FAIL !== "1") process.exit(1);
} catch (error) {
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  checks.push(check("mutation-eval-unhandled-error", false, { message }));
  const report = buildReport();
  writeReport(report);
  printReport(report);
  if (process.env.PI_CHALIN_MUTATION_EVAL_ALLOW_FAIL !== "1") process.exit(1);
}

function createFixture(dir: string): void {
  fs.mkdirSync(path.join(dir, "src"), { recursive: true });
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ type: "module", scripts: { test: "bun test tests/*.test.mjs" } }, null, 2));
  fs.writeFileSync(path.join(dir, "src", "feature.js"), [
    "export const featureConfig = {",
    "  name: 'mutation-eval',",
    "  enabled: false,",
    "  rollout: 'internal',",
    "};",
    "",
  ].join("\n"));
  git(dir, ["init"]);
  git(dir, ["config", "user.email", "pi-chalin@example.com"]);
  git(dir, ["config", "user.name", "pi-chalin"]);
  git(dir, ["add", "."]);
  git(dir, ["commit", "-m", "init"]);
}

function agent(name: string, capabilities: AgentDefinition["capabilities"], concern: AgentDefinition["concern"] = "implementation"): AgentDefinition {
  return { name, scope: "built-in", concern, capabilities, description: name, model: "inherit", tools: [], memory: { read: false, write: "candidate", categories: [] }, systemPrompt: "", diagnostics: [] };
}

function rewriteRisk(worktreePath: string, file: string): { added: number; deleted: number; hunks: number; rewriteRisk: boolean; patch: string } {
  const diff = spawnSync("git", ["diff", "--", file], { cwd: worktreePath, encoding: "utf-8" });
  const patch = diff.stdout;
  const added = patch.split("\n").filter((line) => line.startsWith("+") && !line.startsWith("+++")).length;
  const deleted = patch.split("\n").filter((line) => line.startsWith("-") && !line.startsWith("---")).length;
  const hunks = (patch.match(/^@@ /gm) ?? []).length;
  return { added, deleted, hunks, rewriteRisk: added > 2 || deleted > 2 || hunks > 1, patch };
}

function git(dir: string, args: string[]): string {
  const result = spawnSync("git", args, { cwd: dir, encoding: "utf-8" });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  return result.stdout.trim();
}

function check(id: string, pass: boolean, details: Record<string, unknown>): MutationEvalCheck {
  return { id, pass, details };
}

function buildReport() {
  const passed = checks.filter((item) => item.pass).length;
  const failed = checks.length - passed;
  return {
    startedAt,
    finishedAt: new Date().toISOString(),
    fixture: cwd,
    passed,
    failed,
    warnings,
    checks,
  };
}

function writeReport(report: ReturnType<typeof buildReport>): void {
  const reportDir = path.join(repoRoot, ".pi-chalin", "evals");
  fs.mkdirSync(reportDir, { recursive: true });
  fs.writeFileSync(path.join(reportDir, `mutation-${stamp(startedAt)}.json`), `${JSON.stringify(report, null, 2)}\n`);
}

function printReport(report: ReturnType<typeof buildReport>): void {
  console.log(`pi-chalin mutation evals: ${report.passed}/${report.checks.length} passed`);
  for (const item of report.checks) console.log(`${item.pass ? "✓" : "✗"} ${item.id}`);
  if (report.failed > 0) console.log(JSON.stringify(report.checks.filter((item) => !item.pass), null, 2));
}

function tail(text: string): string {
  const normalized = text.trim();
  return normalized.length <= 1600 ? normalized : normalized.slice(-1600);
}

function stamp(value: string): string {
  return value.replace(/[:.]/g, "-");
}
