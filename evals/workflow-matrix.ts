import * as fs from "node:fs";

export interface WorkflowMatrixVariantStats {
  runs: number;
  passCount: number;
  passRate: number;
  infrastructureFailures?: number;
  avgWorkspaceScore?: number;
  avgTraceScore?: number;
  avgDurationMs?: number;
  p95DurationMs?: number;
  totalTokens?: number;
  estimatedCostUsd?: number;
  flakiness?: number;
}

export interface WorkflowMatrixRow {
  schemaVersion?: number;
  recordedAt?: string;
  startedAt?: string;
  mode?: string;
  caseId: string;
  kind?: string;
  suite?: string;
  variants?: string[];
  runs?: number;
  pass: boolean;
  reason?: string;
  stats: Record<string, WorkflowMatrixVariantStats | undefined>;
  regressionGates?: { pass?: boolean; failures?: string[]; warnings?: string[] };
  git?: object;
  model?: string;
}

export interface WorkflowMatrixShard {
  index: number;
  total: number;
  caseIds: string[];
}

export interface WorkflowMatrixAggregate {
  pass: boolean;
  cases: number;
  passedCases: number;
  failedCases: string[];
  variants: Record<string, {
    cases: number;
    runs: number;
    passCount: number;
    passRate: number;
    avgWorkspaceScore: number;
    p95DurationMs: number;
    totalTokens: number;
    estimatedCostUsd: number;
    infrastructureFailures: number;
  }>;
  warnings: string[];
}

export function partitionWorkflowCases(caseIds: readonly string[], shardCount: number): WorkflowMatrixShard[] {
  const count = normalizePositiveInt(shardCount, "shardCount");
  const shards = Array.from({ length: count }, (_item, index): WorkflowMatrixShard => ({ index: index + 1, total: count, caseIds: [] }));
  caseIds.forEach((caseId, index) => shards[index % count]!.caseIds.push(caseId));
  return shards.filter((shard) => shard.caseIds.length > 0);
}

export function selectWorkflowShard(caseIds: readonly string[], shardCount: number, shardIndex: number): WorkflowMatrixShard {
  const shards = partitionWorkflowCases(caseIds, shardCount);
  const index = normalizePositiveInt(shardIndex, "shardIndex");
  const shard = shards.find((item) => item.index === index);
  if (!shard) throw new Error(`Shard ${index}/${shardCount} has no cases. Non-empty shards: ${shards.map((item) => item.index).join(", ") || "none"}`);
  return shard;
}

export function readWorkflowMatrixRows(paths: readonly string[]): WorkflowMatrixRow[] {
  return paths.flatMap((matrixPath) => {
    if (!fs.existsSync(matrixPath)) return [];
    return fs.readFileSync(matrixPath, "utf-8")
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => JSON.parse(line) as WorkflowMatrixRow);
  });
}

export function summarizeWorkflowMatrixRows(rows: readonly WorkflowMatrixRow[]): WorkflowMatrixAggregate {
  const latestRows = latestMatrixRowsByCase(rows);
  const failedCases = latestRows.filter((row) => !row.pass).map((row) => row.caseId);
  const warnings = latestRows.flatMap((row) => row.regressionGates?.warnings?.map((warning) => `${row.caseId}: ${warning}`) ?? []);
  const variants: WorkflowMatrixAggregate["variants"] = {};

  for (const row of latestRows) {
    for (const [variant, stats] of Object.entries(row.stats ?? {})) {
      if (!stats) continue;
      const aggregate = variants[variant] ?? {
        cases: 0,
        runs: 0,
        passCount: 0,
        passRate: 0,
        avgWorkspaceScore: 0,
        p95DurationMs: 0,
        totalTokens: 0,
        estimatedCostUsd: 0,
        infrastructureFailures: 0,
      };
      aggregate.cases += 1;
      aggregate.runs += stats.runs;
      aggregate.passCount += stats.passCount;
      aggregate.avgWorkspaceScore += (stats.avgWorkspaceScore ?? 0) * stats.runs;
      aggregate.p95DurationMs = Math.max(aggregate.p95DurationMs, stats.p95DurationMs ?? 0);
      aggregate.totalTokens += stats.totalTokens ?? 0;
      aggregate.estimatedCostUsd += stats.estimatedCostUsd ?? 0;
      aggregate.infrastructureFailures += stats.infrastructureFailures ?? 0;
      variants[variant] = aggregate;
    }
  }

  for (const stats of Object.values(variants)) {
    stats.passRate = stats.runs > 0 ? round(stats.passCount / stats.runs, 3) : 0;
    stats.avgWorkspaceScore = stats.runs > 0 ? round(stats.avgWorkspaceScore / stats.runs, 1) : 0;
    stats.estimatedCostUsd = round(stats.estimatedCostUsd, 4);
  }

  return {
    pass: failedCases.length === 0 && latestRows.length > 0,
    cases: latestRows.length,
    passedCases: latestRows.length - failedCases.length,
    failedCases,
    variants,
    warnings,
  };
}

function latestMatrixRowsByCase(rows: readonly WorkflowMatrixRow[]): WorkflowMatrixRow[] {
  const byCase = new Map<string, WorkflowMatrixRow>();
  for (const row of rows) byCase.set(row.caseId, row);
  return [...byCase.values()].sort((a, b) => a.caseId.localeCompare(b.caseId));
}

function normalizePositiveInt(value: number, label: string): number {
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${label} must be a positive integer, got ${value}`);
  return value;
}

function round(value: number, places: number): number {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
}
