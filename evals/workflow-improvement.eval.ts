#!/usr/bin/env node
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { readWorkflowMatrixRows, type WorkflowMatrixRow } from "./workflow-matrix.ts";
import { summarizeWorkflowImprovementReports, type WorkflowImprovementReportInput } from "./workflow-improvement.ts";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

if (isMain()) await main();

async function main(): Promise<void> {
  const args = parseWorkflowImprovementArgs(process.argv.slice(2));
  const startedAt = new Date().toISOString();
  const selection = resolveWorkflowImprovementReportSelection(args);
  const reportPaths = selection.reportPaths;
  if (reportPaths.length === 0) throw new Error(emptySelectionMessage(selection));

  const allReports = reportPaths.map(readWorkflowReportForImprovement);
  const filters = workflowImprovementReportFilters(args);
  const filteredReports = filterWorkflowImprovementReports(allReports, filters);
  if (filteredReports.length === 0) {
    throw new Error(`workflow improvement filters excluded every report: read=${allReports.length}, model=${filters.model?.join(",") ?? "any"}, judgeModel=${filters.judgeModel?.join(",") ?? "any"}`);
  }
  const latestPerCase = shouldSelectLatestWorkflowImprovementPerCase(args);
  const latestReportSelection = latestPerCase ? selectLatestWorkflowImprovementReportSelectionByCase(filteredReports) : undefined;
  const reports = latestReportSelection?.reports ?? filteredReports;
  const summary = summarizeWorkflowImprovementReports(reports);
  const output = {
    startedAt,
    finishedAt: new Date().toISOString(),
    reportPaths,
    selectedReportPaths: uniqueStrings(reports.map((report) => report.reportPath).filter((item): item is string => Boolean(item))),
    filters: {
      model: filters.model,
      judgeModel: filters.judgeModel,
      reportsRead: allReports.length,
      reportsAfterFilter: filteredReports.length,
      excludedReports: allReports.length - filteredReports.length,
    },
    latestPerCase,
    latestReportSelection,
    matrixPaths: splitPaths(args.matrix),
    matrixResolution: selection.matrixResolution,
    summary,
  };

  const reportDir = path.join(repoRoot, ".pi-chalin", "evals");
  fs.mkdirSync(reportDir, { recursive: true });
  const reportPath = path.join(reportDir, `workflow-improvement-${stamp(startedAt)}.json`);
  fs.writeFileSync(reportPath, `${JSON.stringify(output, null, 2)}\n`);

  console.log(`pi-chalin workflow improvement: reports=${summary.reports} comparisons=${summary.comparisons} wins=${summary.targetWins} losses=${summary.targetLosses}`);
  console.log(`gaps: quality=${summary.qualityGaps} efficiency=${summary.efficiencyGaps} infrastructure=${summary.infrastructureBlocked}`);
  for (const [pattern, count] of Object.entries(summary.patternCounts).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))) {
    console.log(`pattern x${count}: ${pattern}`);
  }
  for (const [rule, count] of Object.entries(summary.abstractRules).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))) {
    console.log(`rule x${count}: ${rule}`);
  }
  for (const item of summary.caseSummaries.filter((caseSummary) => caseSummary.targetLosses > 0).slice(0, 8)) {
    const lossWinners = Object.entries(item.lossWinnerVariants).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([variant, count]) => `${variant}:${count}`).join(",");
    console.log(`case ${item.caseId}: losses=${item.targetLosses} quality=${item.qualityGaps} efficiency=${item.efficiencyGaps} lossWinners=${lossWinners || "none"} maxTokenPremium=${item.maxTokenPremium} maxDurationPremiumMs=${item.maxDurationPremiumMs}`);
  }
  console.log(`report: ${reportPath}`);
}

export interface WorkflowImprovementReportSelection {
  reportPaths: string[];
  matrixResolution: {
    matrixPaths: string[];
    matrixRows: number;
    selectedMatrixRows: number;
    latestPerCase: boolean;
    rowsWithReportPath: number;
    rowsInferredReportPath: number;
    unresolvedRows: Array<{
      caseId: string;
      startedAt?: string;
      mode?: string;
      runs?: number;
    }>;
  };
}

export interface WorkflowImprovementReportFilters {
  model?: string[];
  judgeModel?: string[];
}

export function resolveWorkflowImprovementReportPaths(args: Record<string, string>, options: { reportDir?: string } = {}): string[] {
  return resolveWorkflowImprovementReportSelection(args, options).reportPaths;
}

export function shouldSelectLatestWorkflowImprovementPerCase(args: Record<string, string>): boolean {
  return args.latestPerCase === "1" || args.latest === "1";
}

export function workflowImprovementReportFilters(args: Record<string, string>): WorkflowImprovementReportFilters {
  return {
    model: splitCsv(args.model ?? args.models),
    judgeModel: splitCsv(args.judgeModel ?? args.judgeModels),
  };
}

export function filterWorkflowImprovementReports(reports: readonly WorkflowImprovementReportInput[], filters: WorkflowImprovementReportFilters): WorkflowImprovementReportInput[] {
  const modelSet = filters.model?.length ? new Set(filters.model) : undefined;
  const judgeModelSet = filters.judgeModel?.length ? new Set(filters.judgeModel) : undefined;
  if (!modelSet && !judgeModelSet) return [...reports];
  return reports.filter((report) => {
    if (modelSet && !modelSet.has(report.model ?? "")) return false;
    if (judgeModelSet && !judgeModelSet.has(report.judgeModel ?? "")) return false;
    return true;
  });
}

export interface WorkflowImprovementLatestReportSelection {
  reports: WorkflowImprovementReportInput[];
  infrastructureFallbacks: Array<{
    caseId: string;
    latestReportId?: string;
    latestReportPath?: string;
    fallbackReportId?: string;
    fallbackReportPath?: string;
  }>;
}

export function selectLatestWorkflowImprovementReportsByCase(reports: readonly WorkflowImprovementReportInput[]): WorkflowImprovementReportInput[] {
  return selectLatestWorkflowImprovementReportSelectionByCase(reports).reports;
}

export function selectLatestWorkflowImprovementReportSelectionByCase(reports: readonly WorkflowImprovementReportInput[]): WorkflowImprovementLatestReportSelection {
  const byCase = new Map<string, WorkflowImprovementReportInput[]>();
  for (const report of reports) {
    for (const caseId of workflowImprovementReportCaseIds(report)) {
      byCase.set(caseId, [...(byCase.get(caseId) ?? []), report]);
    }
  }
  const infrastructureFallbacks: WorkflowImprovementLatestReportSelection["infrastructureFallbacks"] = [];
  const selected = [...byCase.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([caseId, caseReports]) => {
      const ordered = [...caseReports].sort(compareWorkflowImprovementReportRecency);
      const latest = ordered.at(-1)!;
      const fallback = isInfrastructureOnlyWorkflowImprovementReport(latest, caseId)
        ? [...ordered].reverse().find((report) => report !== latest && isAnalyzableWorkflowImprovementReport(report, caseId))
        : undefined;
      if (fallback) {
        infrastructureFallbacks.push({
          caseId,
          latestReportId: latest.id,
          latestReportPath: latest.reportPath,
          fallbackReportId: fallback.id,
          fallbackReportPath: fallback.reportPath,
        });
      }
      return workflowImprovementReportForCase(fallback ?? latest, caseId);
    })
    .filter((report) => report.outputs.length > 0 || (report.comparativeJudges?.length ?? 0) > 0);
  return { reports: selected, infrastructureFallbacks };
}

export function resolveWorkflowImprovementReportSelection(args: Record<string, string>, options: { reportDir?: string } = {}): WorkflowImprovementReportSelection {
  const explicit = args.report
    ? splitPaths(args.report)
    : [];
  const matrixPaths = splitPaths(args.matrix);
  const allMatrixRows = matrixPaths.flatMap((matrixPath) => readWorkflowMatrixRows([matrixPath]));
  const latestPerCase = args.latestPerCase === "1" || args.latest === "1";
  const matrixRows = latestPerCase ? selectLatestMatrixRowsByCase(allMatrixRows) : allMatrixRows;
  const reportCandidates = loadWorkflowReportCandidates(options.reportDir ?? path.join(repoRoot, ".pi-chalin", "evals"));
  const matrixReportPaths: string[] = [];
  const unresolvedRows: WorkflowImprovementReportSelection["matrixResolution"]["unresolvedRows"] = [];
  let rowsWithReportPath = 0;
  let rowsInferredReportPath = 0;
  for (const row of matrixRows) {
    if (row.reportPath) {
      rowsWithReportPath += 1;
      matrixReportPaths.push(path.resolve(row.reportPath));
      continue;
    }
    const inferred = inferWorkflowReportPathForMatrixRow(row, reportCandidates);
    if (inferred) {
      rowsInferredReportPath += 1;
      matrixReportPaths.push(inferred);
      continue;
    }
    unresolvedRows.push({ caseId: row.caseId, startedAt: row.startedAt, mode: row.mode, runs: row.runs });
  }
  const positional = args._ ? args._.split("\n").map((item) => item.trim()).filter(Boolean) : [];
  return {
    reportPaths: uniqueStrings([...explicit, ...matrixReportPaths, ...positional].map((item) => path.resolve(item))),
    matrixResolution: {
      matrixPaths,
      matrixRows: allMatrixRows.length,
      selectedMatrixRows: matrixRows.length,
      latestPerCase,
      rowsWithReportPath,
      rowsInferredReportPath,
      unresolvedRows,
    },
  };
}

function workflowImprovementReportCaseIds(report: WorkflowImprovementReportInput): string[] {
  return uniqueStrings([
    ...report.outputs.map((output) => output.workspace?.caseId).filter((caseId): caseId is string => typeof caseId === "string" && caseId.length > 0),
    ...(report.comparativeJudges?.map((judge) => judge.caseId).filter((caseId): caseId is string => typeof caseId === "string" && caseId.length > 0) ?? []),
  ]);
}

function workflowImprovementReportForCase(report: WorkflowImprovementReportInput, caseId: string): WorkflowImprovementReportInput {
  return {
    id: report.id,
    reportPath: report.reportPath,
    outputs: report.outputs.filter((output) => output.workspace?.caseId === caseId),
    comparativeJudges: report.comparativeJudges?.filter((judge) => judge.caseId === caseId),
  };
}

function isInfrastructureOnlyWorkflowImprovementReport(report: WorkflowImprovementReportInput, caseId: string): boolean {
  const summary = summarizeWorkflowImprovementReports([workflowImprovementReportForCase(report, caseId)]);
  return summary.infrastructureBlocked > 0 && summary.comparisons === 0 && summary.targetWins === 0 && summary.targetLosses === 0;
}

function isAnalyzableWorkflowImprovementReport(report: WorkflowImprovementReportInput, caseId: string): boolean {
  const summary = summarizeWorkflowImprovementReports([workflowImprovementReportForCase(report, caseId)]);
  return summary.comparisons > 0 || summary.targetWins > 0 || summary.targetLosses > 0;
}

function compareWorkflowImprovementReportRecency(left: WorkflowImprovementReportInput, right: WorkflowImprovementReportInput): number {
  return workflowImprovementReportTime(left) - workflowImprovementReportTime(right)
    || (left.reportPath ?? "").localeCompare(right.reportPath ?? "");
}

function workflowImprovementReportTime(report: WorkflowImprovementReportInput): number {
  const parsed = Date.parse(report.id ?? "");
  return Number.isFinite(parsed) ? parsed : 0;
}

interface WorkflowReportCandidate {
  path: string;
  startedAt?: string;
  mode?: string;
  cases?: string[];
  variants?: string[];
  runs?: number;
}

function loadWorkflowReportCandidates(reportDir: string): WorkflowReportCandidate[] {
  if (!fs.existsSync(reportDir)) return [];
  return fs.readdirSync(reportDir)
    .filter((name) => /^workflow-quality-.+[.]json$/.test(name))
    .map((name) => readWorkflowReportCandidate(path.join(reportDir, name)))
    .filter((item): item is WorkflowReportCandidate => Boolean(item));
}

function readWorkflowReportCandidate(reportPath: string): WorkflowReportCandidate | undefined {
  try {
    const parsed = JSON.parse(fs.readFileSync(reportPath, "utf-8")) as {
      startedAt?: string;
      mode?: string;
      cases?: string[];
      variants?: string[];
      runs?: number;
    };
    return {
      path: reportPath,
      startedAt: parsed.startedAt,
      mode: parsed.mode,
      cases: parsed.cases,
      variants: parsed.variants,
      runs: parsed.runs,
    };
  } catch {
    return undefined;
  }
}

function inferWorkflowReportPathForMatrixRow(row: WorkflowMatrixRow, candidates: readonly WorkflowReportCandidate[]): string | undefined {
  if (!row.startedAt) return undefined;
  const matches = candidates.filter((candidate) => {
    if (candidate.startedAt !== row.startedAt) return false;
    if (row.mode && candidate.mode !== row.mode) return false;
    if (row.runs !== undefined && candidate.runs !== row.runs) return false;
    if (row.caseId && !(candidate.cases ?? []).includes(row.caseId)) return false;
    if (row.variants && !sameStringSet(candidate.variants ?? [], row.variants)) return false;
    return true;
  });
  return matches.length === 1 ? matches[0]?.path : undefined;
}

function selectLatestMatrixRowsByCase(rows: readonly WorkflowMatrixRow[]): WorkflowMatrixRow[] {
  const byCase = new Map<string, { row: WorkflowMatrixRow; index: number }>();
  rows.forEach((row, index) => {
    const current = byCase.get(row.caseId);
    if (!current || compareMatrixRowRecency(row, index, current.row, current.index) > 0) {
      byCase.set(row.caseId, { row, index });
    }
  });
  return [...byCase.values()].map((item) => item.row);
}

function compareMatrixRowRecency(left: WorkflowMatrixRow, leftIndex: number, right: WorkflowMatrixRow, rightIndex: number): number {
  return matrixRowTime(left) - matrixRowTime(right) || leftIndex - rightIndex;
}

function matrixRowTime(row: WorkflowMatrixRow): number {
  const parsed = Date.parse(row.recordedAt ?? row.startedAt ?? "");
  return Number.isFinite(parsed) ? parsed : 0;
}

function readWorkflowReportForImprovement(reportPath: string): WorkflowImprovementReportInput {
  const parsed = JSON.parse(fs.readFileSync(reportPath, "utf-8")) as {
    startedAt?: string;
    model?: string;
    judgeModel?: string;
    outputs?: WorkflowImprovementReportInput["outputs"];
    comparativeJudges?: WorkflowImprovementReportInput["comparativeJudges"];
  };
  if (!Array.isArray(parsed.outputs)) throw new Error(`Workflow report lacks outputs: ${reportPath}`);
  return {
    id: parsed.startedAt,
    reportPath,
    model: parsed.model,
    judgeModel: parsed.judgeModel,
    outputs: parsed.outputs,
    comparativeJudges: parsed.comparativeJudges,
  };
}

export function parseWorkflowImprovementArgs(items: string[]): Record<string, string> {
  const args: Record<string, string> = {};
  const positional: string[] = [];
  for (const item of items) {
    const match = item.match(/^--([^=]+)=(.*)$/);
    if (match?.[1] !== undefined && match[2] !== undefined) {
      args[match[1]] = args[match[1]] ? `${args[match[1]]},${match[2]}` : match[2];
    }
    else positional.push(item);
  }
  if (positional.length) args._ = positional.join("\n");
  return args;
}

function emptySelectionMessage(selection: WorkflowImprovementReportSelection): string {
  const resolution = selection.matrixResolution;
  const base = "workflow improvement eval requires --report=<workflow-report.json[,more.json]>, --matrix=<workflow-matrix.jsonl[,more.jsonl]>, or report paths";
  if (resolution.matrixPaths.length === 0) return base;
  const unresolved = resolution.unresolvedRows.slice(0, 5).map((row) => {
    const startedAt = row.startedAt ? ` startedAt=${row.startedAt}` : "";
    const mode = row.mode ? ` mode=${row.mode}` : "";
    const runs = typeof row.runs === "number" ? ` runs=${row.runs}` : "";
    return `${row.caseId}${startedAt}${mode}${runs}`;
  });
  return [
    base,
    `matrixRows=${resolution.matrixRows}`,
    `selectedMatrixRows=${resolution.selectedMatrixRows}`,
    `rowsWithReportPath=${resolution.rowsWithReportPath}`,
    `rowsInferredReportPath=${resolution.rowsInferredReportPath}`,
    `unresolvedRows=${resolution.unresolvedRows.length}`,
    unresolved.length ? `firstUnresolved=[${unresolved.join("; ")}]` : undefined,
  ].filter((item): item is string => Boolean(item)).join("; ");
}

function stamp(value: string): string {
  return value.replace(/[:.]/g, "-");
}

function splitPaths(value: string | undefined): string[] {
  return value ? value.split(",").map((item) => item.trim()).filter(Boolean).map((item) => path.resolve(item)) : [];
}

function splitCsv(value: string | undefined): string[] | undefined {
  const items = value?.split(",").map((item) => item.trim()).filter(Boolean);
  return items && items.length > 0 ? items : undefined;
}

function sameStringSet(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false;
  const leftSet = new Set(left);
  return right.every((item) => leftSet.has(item));
}

function uniqueStrings(items: string[]): string[] {
  return [...new Set(items)];
}

function isMain(): boolean {
  return Boolean(process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href);
}
