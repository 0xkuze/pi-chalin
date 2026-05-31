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
  reportPath?: string;
  mode?: string;
  caseId: string;
  kind?: string;
  suite?: string;
  variants?: string[];
  runs?: number;
  pass: boolean;
  reason?: string;
  stats: Record<string, WorkflowMatrixVariantStats | undefined>;
  blindJudgeStability?: {
    status?: string;
    samples?: number;
    skipped?: number;
    targetWins?: number;
    targetLosses?: number;
    winRate?: number;
    preliminary?: boolean;
    stable?: boolean;
    recommendation?: string;
  };
  improvementSignals?: WorkflowMatrixImprovementSummary;
  regressionGates?: { pass?: boolean; failures?: string[]; warnings?: string[] };
  git?: object;
  model?: string;
  judgeModel?: string;
}

export interface WorkflowMatrixImprovementSummary {
  comparisons?: number;
  targetWins?: number;
  targetLosses?: number;
  skipped?: number;
  qualityGaps?: number;
  efficiencyGaps?: number;
  infrastructureBlocked?: number;
  abstractRules?: string[];
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
  infrastructureBlockedCases: string[];
  qualityFallbackCases: string[];
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
  blindJudge: {
    cases: number;
    samples: number;
    targetWins: number;
    targetLosses: number;
    winRate: number;
    stableWins: number;
    stableLosses: number;
    unstable: number;
    preliminary: number;
    skipped: number;
    unavailable: number;
    statuses: Record<string, string>;
  };
  improvement: {
    comparisons: number;
    targetWins: number;
    targetLosses: number;
    qualityGaps: number;
    efficiencyGaps: number;
    infrastructureBlocked: number;
    abstractRules: Record<string, number>;
  };
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
  const selection = selectQualityMatrixRowsByCase(rows);
  const selectedRows = selection.rows;
  const failedCases = selectedRows.filter((row) => !row.pass).map((row) => row.caseId);
  const gateWarnings = selectedRows.flatMap((row) => row.regressionGates?.warnings?.map((warning) => formatCaseWarning(row.caseId, warning)) ?? []);
  const stabilityWarnings = selectedRows
    .filter((row) => row.blindJudgeStability?.preliminary)
    .map((row) => `${row.caseId}: blind judge stability is preliminary (${row.blindJudgeStability?.status}; samples=${row.blindJudgeStability?.samples ?? 0})`);
  const infrastructureWarnings = selection.infrastructureBlockedCases.map((caseId) => {
    const suffix = selection.qualityFallbackCases.includes(caseId)
      ? "; using previous analyzable row for quality aggregate"
      : "; no previous analyzable row exists";
    return `${caseId}: latest matrix row is blocked by infrastructure${suffix}`;
  });
  const warnings = [...gateWarnings, ...stabilityWarnings, ...infrastructureWarnings];
  const variants: WorkflowMatrixAggregate["variants"] = {};
  const blindJudge = summarizeBlindJudgeRows(selectedRows);
  const improvement = summarizeImprovementRows(selectedRows);

  for (const row of selectedRows) {
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
    pass: failedCases.length === 0 && selection.infrastructureBlockedCases.length === 0 && selectedRows.length > 0,
    cases: selectedRows.length,
    passedCases: selectedRows.length - failedCases.length,
    failedCases,
    infrastructureBlockedCases: selection.infrastructureBlockedCases,
    qualityFallbackCases: selection.qualityFallbackCases,
    variants,
    blindJudge,
    improvement,
    warnings,
  };
}

function selectQualityMatrixRowsByCase(rows: readonly WorkflowMatrixRow[]): { rows: WorkflowMatrixRow[]; infrastructureBlockedCases: string[]; qualityFallbackCases: string[] } {
  const byCase = matrixRowsByCase(rows);
  const selected: WorkflowMatrixRow[] = [];
  const infrastructureBlockedCases: string[] = [];
  const qualityFallbackCases: string[] = [];

  for (const [caseId, caseRows] of byCase) {
    const latest = caseRows.at(-1);
    if (!latest) continue;
    if (!isInfrastructureBlockedMatrixRow(latest)) {
      selected.push(latest);
      continue;
    }

    infrastructureBlockedCases.push(caseId);
    const fallback = [...caseRows].reverse().find((row) => !isInfrastructureBlockedMatrixRow(row));
    if (fallback) {
      selected.push(fallback);
      qualityFallbackCases.push(caseId);
    } else {
      selected.push(latest);
    }
  }

  return {
    rows: selected.sort((a, b) => a.caseId.localeCompare(b.caseId)),
    infrastructureBlockedCases: infrastructureBlockedCases.sort(),
    qualityFallbackCases: qualityFallbackCases.sort(),
  };
}

function matrixRowsByCase(rows: readonly WorkflowMatrixRow[]): Map<string, WorkflowMatrixRow[]> {
  const grouped = new Map<string, Array<{ row: WorkflowMatrixRow; index: number }>>();
  rows.forEach((row, index) => grouped.set(row.caseId, [...(grouped.get(row.caseId) ?? []), { row, index }]));
  const sorted = new Map<string, WorkflowMatrixRow[]>();
  for (const [caseId, caseRows] of grouped) {
    sorted.set(caseId, caseRows
      .sort((a, b) => compareMatrixRowRecency(a.row, a.index, b.row, b.index))
      .map((item) => item.row));
  }
  return sorted;
}

function compareMatrixRowRecency(left: WorkflowMatrixRow, leftIndex: number, right: WorkflowMatrixRow, rightIndex: number): number {
  return matrixRowTime(left) - matrixRowTime(right) || leftIndex - rightIndex;
}

function matrixRowTime(row: WorkflowMatrixRow): number {
  const parsed = Date.parse(row.recordedAt ?? row.startedAt ?? "");
  return Number.isFinite(parsed) ? parsed : 0;
}

function isInfrastructureBlockedMatrixRow(row: WorkflowMatrixRow): boolean {
  const failures = row.regressionGates?.failures ?? [];
  const text = [row.reason, ...failures].filter(Boolean).join("\n");
  return /target-infrastructure-failure|^chalin .*infrastructure failure (?:provider-error|cli-error|agent-stall)/im.test(text)
    || (!row.pass && /chalinP95RecoveredInfra=true/im.test(text));
}

function formatCaseWarning(caseId: string, warning: string): string {
  return warning.startsWith(`${caseId}:`) ? warning : `${caseId}: ${warning}`;
}

function summarizeBlindJudgeRows(rows: readonly WorkflowMatrixRow[]): WorkflowMatrixAggregate["blindJudge"] {
  const summary: WorkflowMatrixAggregate["blindJudge"] = {
    cases: 0,
    samples: 0,
    targetWins: 0,
    targetLosses: 0,
    winRate: 0,
    stableWins: 0,
    stableLosses: 0,
    unstable: 0,
    preliminary: 0,
    skipped: 0,
    unavailable: 0,
    statuses: {},
  };

  for (const row of rows) {
    const stability = row.blindJudgeStability;
    if (!stability?.status) {
      summary.unavailable += 1;
      summary.statuses[row.caseId] = "unavailable";
      continue;
    }
    summary.statuses[row.caseId] = stability.status;
    if (stability.status === "unavailable") summary.unavailable += 1;
    if (stability.status === "skipped") summary.skipped += 1;
    if (stability.preliminary) summary.preliminary += 1;
    if (stability.status === "stable-win") summary.stableWins += 1;
    if (stability.status === "stable-loss") summary.stableLosses += 1;
    if (stability.status === "unstable") summary.unstable += 1;

    const samples = stability.samples ?? 0;
    if (samples <= 0) continue;
    summary.cases += 1;
    summary.samples += samples;
    summary.targetWins += stability.targetWins ?? 0;
    summary.targetLosses += stability.targetLosses ?? Math.max(0, samples - (stability.targetWins ?? 0));
  }

  summary.winRate = summary.samples > 0 ? round(summary.targetWins / summary.samples, 3) : 0;
  return summary;
}

function summarizeImprovementRows(rows: readonly WorkflowMatrixRow[]): WorkflowMatrixAggregate["improvement"] {
  const summary: WorkflowMatrixAggregate["improvement"] = {
    comparisons: 0,
    targetWins: 0,
    targetLosses: 0,
    qualityGaps: 0,
    efficiencyGaps: 0,
    infrastructureBlocked: 0,
    abstractRules: {},
  };

  for (const row of rows) {
    const improvement = row.improvementSignals;
    if (!improvement) continue;
    summary.comparisons += improvement.comparisons ?? 0;
    summary.targetWins += improvement.targetWins ?? 0;
    summary.targetLosses += improvement.targetLosses ?? 0;
    summary.qualityGaps += improvement.qualityGaps ?? 0;
    summary.efficiencyGaps += improvement.efficiencyGaps ?? 0;
    summary.infrastructureBlocked += improvement.infrastructureBlocked ?? 0;
    for (const rule of improvement.abstractRules ?? []) {
      summary.abstractRules[rule] = (summary.abstractRules[rule] ?? 0) + 1;
    }
  }

  return summary;
}

function normalizePositiveInt(value: number, label: string): number {
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${label} must be a positive integer, got ${value}`);
  return value;
}

function round(value: number, places: number): number {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
}
