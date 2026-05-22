#!/usr/bin/env bun
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { createMemoryCandidate, MemoryStore } from "../src/memory.ts";

interface MemoryEvalResult {
  id: string;
  pass: boolean;
  score: number;
  threshold: number;
  details: Record<string, unknown>;
}

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = parseArgs(process.argv.slice(2));
const repeats = positiveInt(args.repeats ?? process.env.PI_CHALIN_MEMORY_EVAL_REPEATS, 5);
const thresholds = {
  minRecall: positiveFloat(args.minRecall ?? process.env.PI_CHALIN_MEMORY_EVAL_MIN_RECALL, 0.95),
  minReliabilityDelta: positiveFloat(args.minDelta ?? process.env.PI_CHALIN_MEMORY_EVAL_MIN_DELTA, 0.75),
  minDuplicateSuppression: positiveFloat(args.minDuplicateSuppression ?? process.env.PI_CHALIN_MEMORY_EVAL_MIN_DEDUPE, 0.95),
  minRevisionAccuracy: positiveFloat(args.minRevisionAccuracy ?? process.env.PI_CHALIN_MEMORY_EVAL_MIN_REVISION, 1),
  minNoiseRejection: positiveFloat(args.minNoiseRejection ?? process.env.PI_CHALIN_MEMORY_EVAL_MIN_NOISE, 1),
  maxAvgSearchMs: positiveFloat(args.maxAvgSearchMs ?? process.env.PI_CHALIN_MEMORY_EVAL_MAX_SEARCH_MS, 25),
  maxAvgWriteMs: positiveFloat(args.maxAvgWriteMs ?? process.env.PI_CHALIN_MEMORY_EVAL_MAX_WRITE_MS, 90),
};

const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-chalin-memory-eval-"));
const startedAt = new Date().toISOString();
try {
  const store = new MemoryStore({ cwd });
  const writeSamples: number[] = [];
  const searchSamples: number[] = [];
  const results: MemoryEvalResult[] = [];

  results.push(await evaluateRecall(store, writeSamples, searchSamples));
  results.push(await evaluateDuplicateSuppression(store, writeSamples));
  results.push(await evaluateRevisionAccuracy(store, writeSamples));
  results.push(await evaluateNoiseRejection(store, writeSamples));
  results.push(await evaluateReliabilityDelta(store, searchSamples));
  results.push(evaluateLatency(writeSamples, searchSamples));

  const passed = results.filter((result) => result.pass).length;
  const failed = results.length - passed;
  const report = {
    startedAt,
    finishedAt: new Date().toISOString(),
    fixture: cwd,
    repeats,
    thresholds,
    passed,
    failed,
    metrics: {
      avgWriteMs: average(writeSamples),
      p95WriteMs: percentile(writeSamples, 0.95),
      avgSearchMs: average(searchSamples),
      p95SearchMs: percentile(searchSamples, 0.95),
    },
    results,
  };
  const reportDir = path.join(repoRoot, ".pi-chalin", "evals");
  fs.mkdirSync(reportDir, { recursive: true });
  const reportPath = path.join(reportDir, `memory-${stamp(startedAt)}.json`);
  fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  printReport(reportPath, report);
  if (failed > 0 && process.env.PI_CHALIN_MEMORY_EVAL_ALLOW_FAIL !== "1") process.exit(1);
} finally {
  fs.rmSync(cwd, { recursive: true, force: true });
}

async function evaluateRecall(store: MemoryStore, writeSamples: number[], searchSamples: number[]): Promise<MemoryEvalResult> {
  const memories = [
    {
      category: "testing",
      content: "The checkout module uses bun:test with isolated temporary directories, so regression tests should avoid shared filesystem state.",
      query: "checkout bun:test isolated temporary directories",
      expected: /checkout module uses bun:test/i,
    },
    {
      category: "tooling",
      content: "This project uses Bun for fast unit tests, and test waits should use deterministic promise hooks instead of setTimeout sleeps.",
      query: "Bun deterministic promise hooks setTimeout sleeps",
      expected: /uses Bun for fast unit tests/i,
    },
    {
      category: "workflow",
      content: "Long-running pi-chalin features should write checkpoints after every agent handoff and validation contract before reviewer synthesis.",
      query: "long-running pi-chalin checkpoints validation contract reviewer",
      expected: /write checkpoints after every agent handoff/i,
    },
  ];
  for (const memory of memories) {
    const start = performance.now();
    await store.submitCandidates([createMemoryCandidate({ ...memory, sourceAgent: "memory-eval", confidence: 0.95, scope: "project" })]);
    writeSamples.push(performance.now() - start);
  }
  let hits = 0;
  for (const memory of memories) {
    const start = performance.now();
    const found = await store.search(memory.query, 3);
    searchSamples.push(performance.now() - start);
    if (found.some((result) => memory.expected.test(result.record.content))) hits += 1;
  }
  const score = hits / memories.length;
  return result("recall", score, thresholds.minRecall, { hits, total: memories.length });
}

async function evaluateDuplicateSuppression(store: MemoryStore, writeSamples: number[]): Promise<MemoryEvalResult> {
  const before = await store.list();
  const content = "The payments adapter should keep provider retry rules in a single helper because duplicated backoff logic caused flaky integration behavior.";
  for (let index = 0; index < repeats; index++) {
    const start = performance.now();
    await store.submitCandidates([createMemoryCandidate({ category: "pattern", content: `${content}${index % 2 === 0 ? "" : " "}`, sourceAgent: `agent-${index}`, confidence: 0.94, scope: "project" })]);
    writeSamples.push(performance.now() - start);
  }
  const after = await store.list();
  const added = after.length - before.length;
  const record = after.find((item) => /payments adapter/i.test(item.content));
  const score = added === 1 && (record?.duplicateCount ?? 0) >= repeats ? 1 : Math.max(0, 1 - Math.max(0, added - 1) / repeats);
  return result("duplicate-suppression", score, thresholds.minDuplicateSuppression, { added, duplicateCount: record?.duplicateCount });
}

async function evaluateRevisionAccuracy(store: MemoryStore, writeSamples: number[]): Promise<MemoryEvalResult> {
  const first = "Project tests run on Bun; avoid setTimeout sleeps in tests because timing sleeps make retry assertions flaky.";
  const revised = "Project tests run on Bun; avoid setTimeout sleeps and prefer deterministic fake timers or promise hooks for retry assertions.";
  for (const content of [first, revised]) {
    const start = performance.now();
    await store.submitCandidates([createMemoryCandidate({ category: "testing", content, sourceAgent: "reviewer", confidence: 0.95, scope: "project" })]);
    writeSamples.push(performance.now() - start);
  }
  const records = (await store.search("Bun fake timers retry assertions", 5)).map((item) => item.record).filter((item) => /retry assertions/i.test(item.content));
  const best = records[0];
  const score = best && /fake timers or promise hooks/i.test(best.content) && best.revisionCount >= 2 ? 1 : 0;
  return result("revision-accuracy", score, thresholds.minRevisionAccuracy, { content: best?.content, revisionCount: best?.revisionCount });
}

async function evaluateNoiseRejection(store: MemoryStore, writeSamples: number[]): Promise<MemoryEvalResult> {
  const start = performance.now();
  const records = await store.submitCandidates([
    createMemoryCandidate({ category: "agent-note", content: "cmd = ['pi', '-e', 'src/index.ts']", sourceAgent: "scout", confidence: 0.9, scope: "project" }),
    createMemoryCandidate({ category: "agent-note", content: "print('--- stdout ---')", sourceAgent: "scout", confidence: 0.9, scope: "project" }),
    createMemoryCandidate({ category: "agent-note", content: "Traceback most recent call last: subprocess.TimeoutExpired returncode stderr", sourceAgent: "scout", confidence: 0.9, scope: "project" }),
  ]);
  writeSamples.push(performance.now() - start);
  const rejected = records.filter((record) => record.status === "rejected").length;
  const visibleNoise = (await store.list()).filter((record) => /stdout|Traceback|subprocess|cmd =/i.test(record.content)).length;
  const score = rejected === records.length && visibleNoise === 0 ? 1 : rejected / records.length;
  return result("noise-rejection", score, thresholds.minNoiseRejection, { rejected, total: records.length, visibleNoise });
}

async function evaluateReliabilityDelta(store: MemoryStore, searchSamples: number[]): Promise<MemoryEvalResult> {
  const queries = [
    { query: "checkout isolated temporary directories", expected: /checkout module/i },
    { query: "pi-chalin checkpoints validation contract", expected: /Long-running pi-chalin features/i },
    { query: "payments adapter retry rules", expected: /payments adapter/i },
    { query: "Bun fake timers retry assertions", expected: /Bun/i },
  ];
  let memoryHits = 0;
  for (const item of queries) {
    const start = performance.now();
    const found = await store.search(item.query, 5);
    searchSamples.push(performance.now() - start);
    if (found.some((result) => item.expected.test(result.record.content))) memoryHits += 1;
  }
  const memoryRecall = memoryHits / queries.length;
  const baselineRecall = 0;
  const score = memoryRecall - baselineRecall;
  return result("reliability-delta", score, thresholds.minReliabilityDelta, { memoryRecall, baselineRecall, memoryHits, total: queries.length });
}

function evaluateLatency(writeSamples: number[], searchSamples: number[]): MemoryEvalResult {
  const avgWriteMs = average(writeSamples);
  const avgSearchMs = average(searchSamples);
  const writeScore = avgWriteMs <= thresholds.maxAvgWriteMs ? 1 : thresholds.maxAvgWriteMs / Math.max(avgWriteMs, 1);
  const searchScore = avgSearchMs <= thresholds.maxAvgSearchMs ? 1 : thresholds.maxAvgSearchMs / Math.max(avgSearchMs, 1);
  const score = Math.min(writeScore, searchScore);
  return result("latency-budget", score, 1, { avgWriteMs, avgSearchMs, p95WriteMs: percentile(writeSamples, 0.95), p95SearchMs: percentile(searchSamples, 0.95) });
}

function result(id: string, score: number, threshold: number, details: Record<string, unknown>): MemoryEvalResult {
  return { id, score, threshold, pass: score >= threshold, details };
}

function parseArgs(items: string[]): Record<string, string> {
  const result: Record<string, string> = {};
  for (const item of items) {
    const match = item.match(/^--([^=]+)=(.+)$/);
    if (match?.[1] && match[2]) result[match[1]] = match[2];
  }
  return result;
}

function positiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

function positiveFloat(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function average(values: number[]): number {
  if (values.length === 0) return 0;
  return Math.round((values.reduce((sum, value) => sum + value, 0) / values.length) * 100) / 100;
}

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return Math.round((sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * p))] ?? 0) * 100) / 100;
}

function stamp(value: string): string {
  return value.replace(/[:.]/g, "-");
}

function printReport(reportPath: string, report: { passed: number; failed: number; results: MemoryEvalResult[]; metrics: unknown }): void {
  console.log(`pi-chalin memory evals: ${report.passed}/${report.results.length} passed`);
  console.log(`report: ${reportPath}`);
  console.log(`metrics: ${JSON.stringify(report.metrics)}`);
  for (const item of report.results) {
    console.log(`${item.pass ? "✓" : "✗"} ${item.id}: score=${item.score.toFixed(3)} threshold=${item.threshold}`);
    if (!item.pass) console.log(`  details=${JSON.stringify(item.details)}`);
  }
}
