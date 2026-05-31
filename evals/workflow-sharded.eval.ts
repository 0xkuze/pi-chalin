#!/usr/bin/env node
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { partitionWorkflowCases, readWorkflowMatrixRows, summarizeWorkflowMatrixRows, type WorkflowMatrixShard } from "./workflow-matrix.ts";
import { resolveCaseIds, resolveVariants, resolveWorkflowRunCount, resolveWorkflowTimeoutMs } from "./workflow-quality.eval.ts";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const workflowEvalPath = path.join(repoRoot, "evals", "workflow-quality.eval.ts");
const workflowShardPresetArgs = {
  community: {
    case: "community",
    variant: "both",
    runs: "3",
    timeoutMs: "45000",
    shards: "5",
    concurrency: "1",
    shardRetries: "1",
    model: "openai-codex/gpt-5.3-codex-spark",
    thinking: "low",
    matrixPath: "evals/results/workflow-quality-community-sharded-matrix.jsonl",
  },
} satisfies Record<string, Record<string, string>>;

if (isMain()) await main();

async function main(): Promise<void> {
  const args = resolveWorkflowShardArgs(parseArgs(process.argv.slice(2)));
  const startedAt = new Date().toISOString();
  const allCaseIds = resolveCaseIds(args.case);
  const variants = resolveVariants(args.variant);
  const runs = resolveWorkflowRunCount(args.runs ?? process.env.PI_CHALIN_WORKFLOW_RUNS);
  const timeoutMs = resolveWorkflowTimeoutMs(args.timeoutMs);
  const shardCount = Number(args.shards ?? process.env.PI_CHALIN_WORKFLOW_SHARDS ?? Math.min(5, allCaseIds.length || 1));
  const concurrency = Math.max(1, Number(args.concurrency ?? process.env.PI_CHALIN_WORKFLOW_SHARD_CONCURRENCY ?? 1));
  const shardRetries = Math.max(0, Number(args.shardRetries ?? process.env.PI_CHALIN_WORKFLOW_SHARD_RETRIES ?? 1));
  const matrixPath = path.resolve(args.matrixPath ?? path.join(repoRoot, "evals", "results", "workflow-quality-sharded-matrix.jsonl"));
  const runId = slugSegment(args.runId ?? `${stamp(startedAt)}-${randomUUID().slice(0, 8)}`);
  const shardDir = path.join(path.dirname(matrixPath), `.workflow-shards-${runId}`);
  fs.mkdirSync(shardDir, { recursive: true });
  fs.rmSync(matrixPath, { force: true });

  const shards = partitionWorkflowCases(allCaseIds, shardCount);
  console.log(`workflow sharded matrix: ${allCaseIds.length} case(s), ${variants.join("+")}, runs=${runs}, timeout=${timeoutMs}ms, shards=${shards.length}/${shardCount}, concurrency=${concurrency}, shardRetries=${shardRetries}`);

  const results = await runShards({ shards, variants, runs, timeoutMs, matrixPath, shardDir, concurrency, shardRetries, extraArgs: args });
  const finalShardMatrices = results.map((result) => result.matrixPath).filter(Boolean) as string[];
  fs.writeFileSync(matrixPath, finalShardMatrices.map((item) => fs.existsSync(item) ? fs.readFileSync(item, "utf-8") : "").join(""));
  const rows = readWorkflowMatrixRows([matrixPath]);
  const aggregate = summarizeWorkflowMatrixRows(rows);
  const pass = aggregate.pass && results.every((result) => result.status === 0);

  const report = {
    startedAt,
    finishedAt: new Date().toISOString(),
    runId,
    caseCount: allCaseIds.length,
    variants,
    runs,
    timeoutMs,
    shardCount,
    concurrency,
    shardRetries,
    matrixPath,
    shardDir,
    pass,
    aggregate,
    shards: results,
  };
  const reportDir = path.join(repoRoot, ".pi-chalin", "evals");
  fs.mkdirSync(reportDir, { recursive: true });
  const reportPath = path.join(reportDir, `workflow-sharded-${runId}.json`);
  fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);

  console.log(`workflow sharded matrix: ${pass ? "PASS" : "FAIL"}`);
  console.log(`cases: ${aggregate.passedCases}/${aggregate.cases}`);
  for (const [variant, stats] of Object.entries(aggregate.variants)) {
    console.log(`${variant}: runs=${stats.passCount}/${stats.runs}, avgScore=${stats.avgWorkspaceScore}, maxCaseP95=${stats.p95DurationMs}ms, tokens=${stats.totalTokens}, estCost=$${stats.estimatedCostUsd}`);
  }
  if (aggregate.failedCases.length) console.log(`failed cases: ${aggregate.failedCases.join(", ")}`);
  if (aggregate.infrastructureBlockedCases.length) console.log(`infrastructure blocked cases: ${aggregate.infrastructureBlockedCases.join(", ")}`);
  if (aggregate.warnings.length) console.log(`warnings: ${aggregate.warnings.length}`);
  console.log(`report: ${reportPath}`);
  console.log(`matrix: ${matrixPath}`);
  process.exitCode = pass ? 0 : 1;
}

interface ShardRunOptions {
  shards: WorkflowMatrixShard[];
  variants: string[];
  runs: number;
  timeoutMs: number;
  matrixPath: string;
  shardDir: string;
  concurrency: number;
  shardRetries: number;
  extraArgs: Record<string, string>;
}

interface ShardResult {
  shardIndex: number;
  caseIds: string[];
  attempts: number;
  status: number | null;
  signal: NodeJS.Signals | null;
  durationMs: number;
  matrixPath?: string;
}

async function runShards(options: ShardRunOptions): Promise<ShardResult[]> {
  const queue = [...options.shards];
  const results: ShardResult[] = [];
  const workers = Array.from({ length: Math.min(options.concurrency, queue.length) }, async () => {
    while (queue.length > 0) {
      const shard = queue.shift();
      if (!shard) return;
      results.push(await runShardWithRetries(shard, options));
    }
  });
  await Promise.all(workers);
  return results.sort((a, b) => a.shardIndex - b.shardIndex);
}

async function runShardWithRetries(shard: WorkflowMatrixShard, options: ShardRunOptions): Promise<ShardResult> {
  let last: ShardResult | undefined;
  for (let attempt = 1; attempt <= options.shardRetries + 1; attempt += 1) {
    const result = await runShardAttempt(shard, options, attempt);
    last = result;
    if (result.status === 0) return result;
    if (attempt <= options.shardRetries) console.log(`shard ${shard.index}/${shard.total}: retry ${attempt}/${options.shardRetries} after exit=${result.status ?? result.signal}`);
  }
  return last!;
}

function runShardAttempt(shard: WorkflowMatrixShard, options: ShardRunOptions, attempt: number): Promise<ShardResult> {
  const started = Date.now();
  const matrixPath = path.join(options.shardDir, `shard-${String(shard.index).padStart(2, "0")}-attempt-${attempt}.jsonl`);
  fs.rmSync(matrixPath, { force: true });
  const childArgs = buildWorkflowShardChildArgs({
    caseIds: shard.caseIds,
    variants: options.variants,
    runs: options.runs,
    timeoutMs: options.timeoutMs,
    matrixPath,
    extraArgs: options.extraArgs,
  });
  console.log(`shard ${shard.index}/${shard.total} attempt ${attempt}: ${shard.caseIds.join(",")}`);
  const child = spawn(process.execPath, childArgs, {
    cwd: repoRoot,
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.setEncoding("utf-8");
  child.stderr.setEncoding("utf-8");
  child.stdout.on("data", (chunk) => prefixWrite(`s${shard.index}`, chunk, false));
  child.stderr.on("data", (chunk) => prefixWrite(`s${shard.index}`, chunk, true));
  return new Promise((resolve) => {
    child.on("close", (status, signal) => resolve({ shardIndex: shard.index, caseIds: shard.caseIds, attempts: attempt, status, signal, durationMs: Date.now() - started, matrixPath }));
  });
}

export function buildWorkflowShardChildArgs(options: { caseIds: string[]; variants: string[]; runs: number; timeoutMs: number; matrixPath: string; extraArgs: Record<string, string> }): string[] {
  const childArgs = [
    workflowEvalPath,
    "--mode=sdk",
    `--case=${options.caseIds.join(",")}`,
    `--variant=${variantArgForShard(options.variants)}`,
    `--runs=${options.runs}`,
    `--timeoutMs=${options.timeoutMs}`,
    `--matrixPath=${options.matrixPath}`,
    "--allowMulti=1",
    "--allowLong=1",
    "--gates=1",
    `--model=${options.extraArgs.model ?? process.env.PI_CHALIN_WORKFLOW_MODEL ?? "openai-codex/gpt-5.3-codex-spark"}`,
    `--thinking=${options.extraArgs.thinking ?? process.env.PI_CHALIN_WORKFLOW_THINKING ?? "low"}`,
  ];
  if (options.extraArgs.judge) childArgs.push(`--judge=${options.extraArgs.judge}`);
  const comparativeJudge = options.extraArgs.comparativeJudge ?? options.extraArgs.comparisonJudge;
  if (comparativeJudge) childArgs.push(`--comparativeJudge=${comparativeJudge}`);
  for (const key of ["judgeModel", "judgeTimeoutMs", "gentleRoot", "gentleCompanionRoot", "storeFullOutput", "storeFullWorkflowOutput", "storeFailedOutput", "storeFailedWorkflowOutput"]) {
    const value = options.extraArgs[key];
    if (value !== undefined) childArgs.push(`--${key}=${value}`);
  }
  return childArgs;
}

function variantArgForShard(variants: string[]): string {
  const key = variants.join("+");
  if (key === "simple+chalin") return "both";
  if (key === "simple+chalin+gentle") return "all-harnesses";
  if (key === "chalin+gentle") return "harnesses";
  return variants.join(",");
}

function prefixWrite(prefix: string, chunk: string, stderr: boolean): void {
  const text = chunk.split("\n").map((line) => line ? `[${prefix}] ${line}` : line).join("\n");
  (stderr ? process.stderr : process.stdout).write(text);
}

export function resolveWorkflowShardArgs(args: Record<string, string>): Record<string, string> {
  if (!args.preset) return args;
  const preset = workflowShardPresetArgs[args.preset as keyof typeof workflowShardPresetArgs];
  if (!preset) throw new Error(`Unsupported workflow shard preset: ${args.preset}`);
  return { ...preset, ...args };
}

function parseArgs(items: string[]): Record<string, string> {
  const result: Record<string, string> = {};
  for (const item of items) {
    const match = item.match(/^--([^=]+)=(.*)$/);
    if (match?.[1] !== undefined && match[2] !== undefined) result[match[1]] = match[2];
  }
  return result;
}

function isMain(): boolean {
  return process.argv[1] ? pathToComparable(process.argv[1]) === pathToComparable(fileURLToPath(import.meta.url)) : false;
}

function pathToComparable(item: string): string {
  return path.resolve(item);
}

function stamp(iso: string): string {
  return iso.replace(/[:.]/g, "-");
}

function slugSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 120) || "run";
}
