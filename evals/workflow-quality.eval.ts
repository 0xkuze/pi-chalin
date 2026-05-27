#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { WORKFLOW_ORACLE_DIR, createWorkflowFixture, getWorkflowEvalCase, listWorkflowCommunityCases, listWorkflowComplexCases, listWorkflowEvalCases, listWorkflowHoldoutCases, type WorkflowEvalCase } from "./workflow-cases.ts";
import { scoreWorkflowWorkspace, type WorkflowQualityReport } from "./workflow-quality-lib.ts";
import { gradePiTrace, parsePiJsonTrace, type TraceQualityReport, type TraceVariant } from "./trace-quality.ts";
import { DEFAULT_JUDGE_MODEL, resolveJudgeTimeoutMs } from "./trace-quality.eval.ts";

const workflowVariants = ["simple", "chalin", "gentle"] as const;
export type WorkflowVariant = (typeof workflowVariants)[number];
export type WorkflowJudgeMode = "none" | "auto" | "pi";
export type WorkflowComparativeJudgeMode = "none" | "pi";

export const DEFAULT_WORKFLOW_TIMEOUT_MS = 240_000;
export const MAX_WORKFLOW_TIMEOUT_MS = 900_000;
export const DEFAULT_WORKFLOW_RUNS = 1;
export const MAX_WORKFLOW_RUNS = 5;
export const DEFAULT_MAX_INTERACTIVE_SDK_WALL_MS = 120_000;
export const DEFAULT_WORKFLOW_IDLE_TIMEOUT_MS = 90_000;

interface WorkflowRunOptions {
  judgeMode: WorkflowJudgeMode;
  comparativeJudgeMode: WorkflowComparativeJudgeMode;
  judgeModel?: string;
  judgeTimeoutMs?: string;
  gentleRoot?: string;
  model?: string;
  thinking: string;
}

interface WorkflowEfficiencyDiagnostics {
  jsonEvents: number;
  toolEvents: number;
  toolCallsByName: Record<string, number>;
  chalinRouteCalls: number;
  chalinRouteNonExecutable: number;
  chalinRouteValidationErrors: number;
  toolValidationErrors: number;
  duplicateToolCalls: number;
  readCalls: number;
  writeCalls: number;
  editCalls: number;
  retries: number;
  agentRetries: number;
  infraRetries: number;
  sdkRetryAttempts?: number;
  recoveredInfrastructureFailures?: WorkflowInfrastructureFailure[];
  retainedRetryFixturePaths?: string[];
  usage: WorkflowUsageTotals;
  tokenTotal: number;
  timeToWorkspaceStaticValidMs?: number;
  timeToWorkspaceValidMs?: number;
  timeToVerificationPassMs?: number;
  timeToFinalAnswerMs?: number;
  verificationPassed: boolean;
  verificationToolCalls: number;
  traceSummary: WorkflowRunTraceSummary;
  finalAnswerMissing: boolean;
  objectiveStopReason?: string;
  infrastructureFailure?: WorkflowInfrastructureFailure;
  antiCheat?: WorkflowAntiCheatReport;
}

export interface WorkflowRunTraceSummary {
  directEligible: boolean;
  firstMutationEventIndex?: number;
  firstPassingVerificationEventIndex?: number;
  postVerificationExplorationCalls: number;
  postVerificationShellCalls: number;
  postVerificationToolCallsByName: Record<string, number>;
  toolCallSequence: string[];
}

export interface WorkflowUsageTotals {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
  cost: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    total: number;
  };
}

interface WorkflowInfrastructureFailure {
  kind: "provider-error" | "cli-error" | "agent-stall";
  message: string;
}

export interface WorkflowAntiCheatReport {
  pass: boolean;
  critical: string[];
  warnings: string[];
  accessed: Array<{
    tool: string;
    phase: "start" | "end" | "unknown";
    index: number;
    marker: string;
    surface: "arguments" | "result" | "assistant";
  }>;
}

export interface WorkflowProductionFastPathAudit {
  pass: boolean;
  critical: string[];
  warnings: string[];
  scannedFiles: number;
}

interface WorkflowJudgeVerdict {
  pass: boolean;
  score: number;
  verdict: string;
  critical: string[];
  warnings: string[];
  skipped?: boolean;
  reason?: string;
}

interface WorkflowRunOutput {
  variant: WorkflowVariant;
  runIndex: number;
  cwd: string;
  stdout: string;
  stderr: string;
  finalText: string;
  status: number | null;
  signal: NodeJS.Signals | null;
  timeoutReason?: string;
  durationMs: number;
  workspace: WorkflowQualityReport;
  trace: TraceQualityReport;
  diagnostics: WorkflowEfficiencyDiagnostics;
  evidence?: WorkflowOutputEvidence;
  judge?: WorkflowJudgeVerdict;
  retainedFixturePath?: string;
  promptVariantIndex?: number;
  promptVariantCount?: number;
}

interface WorkflowOutputEvidence {
  files: Array<{ path: string; contentSnippet: string }>;
}

interface WorkflowComparativeJudgeVerdict {
  caseId: string;
  runIndex: number;
  target: WorkflowVariant;
  candidates: Array<{
    label: string;
    variant: WorkflowVariant;
    deterministicPass: boolean;
    workspaceScore: number;
    traceScore: number;
    judgeScore?: number;
    durationMs: number;
    tokens: number;
    toolCalls?: number;
  }>;
  winnerLabel?: string;
  winnerVariant?: WorkflowVariant;
  ranking: string[];
  scores: Record<string, number>;
  targetWins: boolean;
  targetRank?: number;
  verdict: string;
  critical: string[];
  warnings: string[];
  skipped?: boolean;
  reason?: string;
}

interface WorkflowPairComparison {
  kind: "baseline" | "competitor";
  target: WorkflowVariant;
  baseline: WorkflowVariant;
  pass: boolean;
  reason: string;
}

interface WorkflowComparisonSummary {
  caseId: string;
  pass: boolean;
  reason: string;
  variants: Partial<Record<WorkflowVariant, VariantStats>>;
  comparisons: WorkflowPairComparison[];
  comparativeJudges?: WorkflowComparativeJudgeVerdict[];
}

interface VariantStats {
  runs: number;
  passCount: number;
  passRate: number;
  infrastructureFailures: number;
  avgWorkspaceScore: number;
  avgTraceScore: number;
  avgJudgeScore?: number;
  avgDurationMs: number;
  p95DurationMs: number;
  avgTimeToWorkspaceStaticValidMs?: number;
  avgTimeToWorkspaceValidMs?: number;
  avgTimeToVerificationPassMs?: number;
  avgTimeToFinalAnswerMs?: number;
  verificationPassRate: number;
  avgToolCalls: number;
  avgReadCalls: number;
  avgWriteCalls: number;
  avgEditCalls: number;
  avgRetries: number;
  avgAgentRetries: number;
  avgInfraRetries: number;
  avgAntiCheatCriticals: number;
  avgChalinRouteCalls: number;
  avgChalinRouteNonExecutable: number;
  avgChalinRouteValidationErrors: number;
  avgDuplicateToolCalls: number;
  avgTokens: number;
  totalTokens: number;
  estimatedCostUsd: number;
  costPerPassingRunUsd?: number;
  flakiness: number;
}

interface WorkflowRegressionGates {
  enabled: boolean;
  pass: boolean;
  failures: string[];
  warnings: string[];
  thresholds: {
    minChalinPassRate: number;
    maxDirectChalinRouteCalls: number;
    maxDuplicateToolCalls: number;
    minBlindJudgeWinRate: number;
    minCaseBlindJudgeWinRate: number;
    maxBoundedDirectTokenMultiplier: number;
  };
}

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const extensionPath = path.join(repoRoot, "src", "index.ts");
const defaultGentleRoot = path.resolve(repoRoot, "..", "gentle-pi");
const defaultMatrixPath = path.join(repoRoot, "evals", "results", "workflow-quality-matrix.jsonl");
const targetVariant: WorkflowVariant = "chalin";
const baselineVariant: WorkflowVariant = "simple";
const evidenceIgnoredDirs = new Set([".git", "node_modules", ".pi-chalin", WORKFLOW_ORACLE_DIR, "dist", "coverage", "target"]);
const workflowPresetArgs = {
  matrix: {
    mode: "sdk",
    case: "all-with-holdout",
    variant: "both",
    runs: "3",
    timeoutMs: "60000",
    allowMulti: "1",
    allowLong: "1",
    gates: "1",
    model: "openai-codex/gpt-5.3-codex-spark",
    thinking: "low",
    matrixPath: "evals/results/workflow-quality-full-matrix.jsonl",
  },
  community: {
    mode: "sdk",
    case: "community",
    variant: "both",
    runs: "3",
    timeoutMs: "60000",
    allowMulti: "1",
    allowLong: "1",
    gates: "1",
    model: "openai-codex/gpt-5.3-codex-spark",
    thinking: "low",
    matrixPath: "evals/results/workflow-quality-community-matrix.jsonl",
  },
  harness: {
    mode: "sdk",
    case: "all-with-holdout",
    variant: "all-harnesses",
    runs: "3",
    timeoutMs: "60000",
    allowMulti: "1",
    allowLong: "1",
    gates: "1",
    judge: "pi",
    comparativeJudge: "pi",
    judgeModel: "openai-codex/gpt-5.5",
    model: "openai-codex/gpt-5.5",
    thinking: "adaptive",
    matrixPath: "evals/results/workflow-quality-harness-comparison.jsonl",
  },
  complex: {
    mode: "sdk",
    case: "complex",
    variant: "all-harnesses",
    runs: "1",
    timeoutMs: "120000",
    allowMulti: "1",
    allowLong: "1",
    gates: "1",
    judge: "pi",
    comparativeJudge: "pi",
    judgeModel: "openai-codex/gpt-5.5",
    model: "openai-codex/gpt-5.5",
    thinking: "adaptive",
    matrixPath: "evals/results/workflow-quality-complex-harness.jsonl",
  },
} satisfies Record<string, Record<string, string>>;

if (isMain()) await main();

async function main(): Promise<void> {
  const args = resolveWorkflowArgs(parseArgs(process.argv.slice(2)));
  const startedAt = new Date().toISOString();
  const mode = args.mode ?? "fixtures";
  const timeoutMs = resolveWorkflowTimeoutMs(args.timeoutMs);
  const runs = resolveWorkflowRunCount(args.runs ?? process.env.PI_CHALIN_WORKFLOW_RUNS);
  const caseIds = resolveCaseIds(args.case);
  const variants = resolveVariants(args.variant);
  const judgeMode = resolveJudgeMode(args.judge ?? process.env.PI_CHALIN_WORKFLOW_JUDGE ?? "none");
  const comparativeJudgeMode = resolveComparativeJudgeMode(args.comparativeJudge ?? args.comparisonJudge ?? process.env.PI_CHALIN_WORKFLOW_COMPARATIVE_JUDGE ?? "none");
  const runOptions: WorkflowRunOptions = {
    judgeMode,
    comparativeJudgeMode,
    judgeModel: args.judgeModel ?? process.env.PI_CHALIN_WORKFLOW_JUDGE_MODEL,
    judgeTimeoutMs: args.judgeTimeoutMs ?? process.env.PI_CHALIN_WORKFLOW_JUDGE_TIMEOUT_MS,
    gentleRoot: args.gentleRoot ?? process.env.PI_CHALIN_GENTLE_PI_ROOT,
    model: args.model ?? process.env.PI_CHALIN_WORKFLOW_MODEL,
    thinking: args.thinking ?? process.env.PI_CHALIN_WORKFLOW_THINKING ?? "minimal",
  };
  const outputs: WorkflowRunOutput[] = [];

  if (mode === "fixtures") {
    for (const caseId of caseIds) {
      const fixture = createWorkflowFixture(caseId);
      const finalText = syntheticPassingSummary(fixture.case);
      const workspace = scoreWorkflowWorkspace(fixture.cwd, fixture.case, { finalText, durationMs: 0 });
      const trace = gradePiTrace(finalText, { variant: "simple", finalText, promptKind: "generic", durationMs: 0 });
      outputs.push({ variant: "simple", runIndex: 1, cwd: fixture.cwd, stdout: finalText, stderr: "", finalText, status: 0, signal: null, durationMs: 0, workspace, trace, diagnostics: emptyDiagnostics(), evidence: collectWorkflowEvidence(fixture.cwd, fixture.case) });
      if (process.env.PI_CHALIN_WORKFLOW_KEEP_FIXTURE !== "1") fs.rmSync(fixture.cwd, { recursive: true, force: true });
    }
  } else if (mode === "sdk") {
    if ((caseIds.length > 1 || runs > 1) && !sdkMultiAllowed(args)) {
      throw new Error("SDK mode runs one case/run by default to avoid long waits. Pass --case=<id> --runs=1, or set --allowMulti=1 knowingly.");
    }
    assertSdkRunBudget({ caseIds, variants, runs, timeoutMs, args });
    for (const caseId of caseIds) {
      for (let runIndex = 1; runIndex <= runs; runIndex += 1) {
        for (const variant of variants) {
          console.log(`progress: ${variant} ${caseId}#${runIndex} start timeout=${timeoutMs}ms`);
          const output = await runSdkCaseWithRetries(getWorkflowEvalCase(caseId), variant, timeoutMs, runIndex, runOptions);
          const rowPass = outputPass(output);
          const retained = output.retainedFixturePath ? ` retained=${output.retainedFixturePath}` : "";
          console.log(`progress: ${variant} ${caseId}#${runIndex} done workspace=${output.workspace.score} trace=${output.trace.score} duration=${output.durationMs}ms pass=${rowPass}${retained}`);
          outputs.push(output);
        }
      }
    }
  } else if (mode === "score-workspace") {
    const caseId = args.case;
    if (!caseId) throw new Error("score-workspace mode requires --case=<id>");
    const cwd = path.resolve(args.cwd ?? process.cwd());
    const finalText = args.final ? fs.readFileSync(path.resolve(args.final), "utf-8") : "";
    const evalCase = getWorkflowEvalCase(caseId);
    const workspace = scoreWorkflowWorkspace(cwd, evalCase, { finalText, durationMs: args.durationMs ? Number(args.durationMs) : undefined, validateTests: args.validateTests === "1" });
    const trace = gradePiTrace(finalText, { variant: "simple", finalText, promptKind: "generic" });
    outputs.push({ variant: "simple", runIndex: 1, cwd, stdout: finalText, stderr: "", finalText, status: 0, signal: null, durationMs: args.durationMs ? Number(args.durationMs) : 0, workspace, trace, diagnostics: emptyDiagnostics(), evidence: collectWorkflowEvidence(cwd, evalCase) });
  } else {
    throw new Error(`Unsupported workflow eval mode: ${mode}`);
  }

  const comparativeJudges = mode === "sdk" && comparativeJudgeMode === "pi"
    ? await runWorkflowComparativeJudges(outputs, runOptions)
    : [];
  const grouped = summarizeComparison(outputs, comparativeJudges);
  const basePass = mode === "fixtures"
    ? outputs.every((item) => !item.workspace.pass && item.workspace.critical.length > 0)
    : workflowEvalPass(outputs, grouped);
  const regressionGates = mode === "sdk" && workflowRegressionGatesEnabled(args)
    ? evaluateWorkflowRegressionGates(outputs, grouped)
    : disabledWorkflowRegressionGates();
  const pass = basePass && regressionGates.pass;
  const report = {
    startedAt,
    finishedAt: new Date().toISOString(),
    mode,
    timeoutPolicy: mode === "sdk" ? { timeoutMs, maxTimeoutMs: MAX_WORKFLOW_TIMEOUT_MS, earlyStopPolicy: "terminal-final-answer-only", reason: "Workflow SDK evals are capped; hangs require root-cause investigation instead of longer waits. Static workspace validity is recorded as a milestone only; it never terminates a run before verification/final delivery." } : null,
    cases: caseIds,
    variants,
    runs,
    judgeMode,
    comparativeJudgeMode,
    judgeModel: runOptions.judgeModel ?? DEFAULT_JUDGE_MODEL,
    gentleRoot: variants.includes("gentle") ? resolveGentlePiRoot(runOptions.gentleRoot) : undefined,
    git: gitMetadata(),
    model: runOptions.model ?? "default-pi-model",
    regressionGates,
    pass,
    grouped,
    comparativeJudges,
    categorySummary: summarizeByCategory(outputs),
    failureUx: mode === "fixtures" ? [] : summarizeWorkflowFailures(outputs),
    outputs: outputs.map((item) => compactOutput(item)),
  };

  const reportDir = path.join(repoRoot, ".pi-chalin", "evals");
  fs.mkdirSync(reportDir, { recursive: true });
  const reportPath = writeWorkflowReport(reportDir, report);
  if (mode === "sdk" && shouldPersistMatrix(args)) appendMatrixRows(args.matrixPath ? path.resolve(args.matrixPath) : defaultMatrixPath, report);

  console.log(`pi-chalin workflow quality: ${pass ? "PASS" : "FAIL"}`);
  for (const item of outputs) {
    const retained = item.retainedFixturePath ? ` retained=${item.retainedFixturePath}` : "";
    if (mode === "fixtures") {
      console.log(`${item.variant} ${item.workspace.caseId}#${item.runIndex}: starterIncomplete=${!item.workspace.pass} workspace=${item.workspace.score} trace=${item.trace.score} duration=${item.durationMs}ms${retained}`);
    } else {
      console.log(`${item.variant} ${item.workspace.caseId}#${item.runIndex}: workspace=${item.workspace.score} trace=${item.trace.score} duration=${item.durationMs}ms pass=${outputPass(item)}${retained}`);
    }
  }
  if (mode !== "fixtures") {
    for (const item of grouped) console.log(`compare ${item.caseId}: ${item.pass ? "PASS" : "FAIL"} ${item.reason}`);
  } else {
    console.log("fixture baseline: PASS incomplete starter workspaces stayed below pass threshold");
  }
  if (regressionGates.enabled) {
    console.log(`gates: ${regressionGates.pass ? "PASS" : "FAIL"}`);
    for (const failure of regressionGates.failures) console.log(`gate failure: ${failure}`);
    for (const warning of regressionGates.warnings) console.log(`gate warning: ${warning}`);
  }
  console.log(`report: ${reportPath}`);
  if (mode === "sdk" && shouldPersistMatrix(args)) console.log(`matrix: ${args.matrixPath ? path.resolve(args.matrixPath) : defaultMatrixPath}`);
  if (!pass && process.env.PI_CHALIN_WORKFLOW_ALLOW_FAIL !== "1") process.exit(1);
}

export function resolveWorkflowArgs(args: Record<string, string>): Record<string, string> {
  if (!args.preset) return args;
  const preset = workflowPresetArgs[args.preset as keyof typeof workflowPresetArgs];
  if (!preset) throw new Error(`Unsupported workflow preset: ${args.preset}`);
  return { ...preset, ...args };
}

export function resolveWorkflowTimeoutMs(value: string | undefined): number {
  const parsed = Number(value ?? DEFAULT_WORKFLOW_TIMEOUT_MS);
  return Number.isFinite(parsed) && parsed > 0 ? Math.min(Math.floor(parsed), MAX_WORKFLOW_TIMEOUT_MS) : DEFAULT_WORKFLOW_TIMEOUT_MS;
}

export function resolveWorkflowRunCount(value: string | undefined): number {
  const parsed = Number(value ?? DEFAULT_WORKFLOW_RUNS);
  return Number.isFinite(parsed) && parsed > 0 ? Math.min(Math.floor(parsed), MAX_WORKFLOW_RUNS) : DEFAULT_WORKFLOW_RUNS;
}

export function resolveWorkflowThinking(evalCase: Pick<WorkflowEvalCase, "kind"> & Partial<Pick<WorkflowEvalCase, "expected">>, value: string): string {
  if (value !== "adaptive") return value;
  if (evalCase.kind === "scaffold") return "minimal";
  if (evalCase.kind === "large-feature" && (evalCase.expected?.maxFiles ?? Number.POSITIVE_INFINITY) <= 5) return "minimal";
  if (evalCase.kind === "greenfield" || evalCase.kind === "large-feature") return "low";
  return "minimal";
}

export function resolveWorkflowIdleTimeoutMs(value: string | undefined, workflowTimeoutMs = MAX_WORKFLOW_TIMEOUT_MS): number {
  const parsed = Number(value ?? DEFAULT_WORKFLOW_IDLE_TIMEOUT_MS);
  const bounded = Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : DEFAULT_WORKFLOW_IDLE_TIMEOUT_MS;
  return Math.min(Math.max(bounded, 5_000), Math.max(5_000, workflowTimeoutMs - 1_000));
}

export function resolveCaseIds(value: string | undefined): string[] {
  if (!value || value === "all") return listWorkflowEvalCases().map((item) => item.id);
  if (value === "holdout" || value === "holdout-all") return listWorkflowHoldoutCases().map((item) => item.id);
  if (value === "community" || value === "community-all") return listWorkflowCommunityCases().map((item) => item.id);
  if (value === "complex" || value === "complex-all") return listWorkflowComplexCases().map((item) => item.id);
  if (value === "all-with-holdout") return listWorkflowEvalCases({ includeHoldout: true }).map((item) => item.id);
  if (value === "all-realistic" || value === "all-with-community") return listWorkflowEvalCases({ includeHoldout: true, includeCommunity: true }).map((item) => item.id);
  if (value === "all-expanded" || value === "all-with-complex") return listWorkflowEvalCases({ includeHoldout: true, includeCommunity: true, includeComplex: true }).map((item) => item.id);
  return value.split(",").map((item) => item.trim()).filter(Boolean);
}

export function resolveVariants(value: string | undefined): WorkflowVariant[] {
  if (!value || value === "both" || value === "all") return ["simple", "chalin"];
  if (value === "harnesses" || value === "chalin-vs-gentle") return ["chalin", "gentle"];
  if (value === "all-harnesses") return [...workflowVariants];
  if (isWorkflowVariant(value)) return [value];
  throw new Error(`Unsupported workflow variant: ${value}`);
}

function isWorkflowVariant(value: string): value is WorkflowVariant {
  return (workflowVariants as readonly string[]).includes(value);
}

export function resolveGentlePiRoot(value: string | undefined): string {
  const root = path.resolve(value ?? defaultGentleRoot);
  const extensionDir = path.join(root, "extensions");
  const required = [
    path.join(extensionDir, "gentle-ai.ts"),
    path.join(extensionDir, "skill-registry.ts"),
    path.join(extensionDir, "sdd-init.ts"),
    path.join(extensionDir, "startup-banner.ts"),
  ];
  const missing = required.filter((file) => !fs.existsSync(file));
  if (missing.length > 0) {
    throw new Error(`gentle-pi root is not usable: ${root}. Missing ${missing.map((file) => path.relative(root, file)).join(", ")}`);
  }
  return root;
}

export function shouldRunWorkflowJudge(output: Pick<WorkflowRunOutput, "workspace" | "trace" | "diagnostics">): boolean {
  if (!output.workspace.pass || !output.trace.pass) return false;
  return output.workspace.score < 90
    || output.trace.score < 90
    || output.workspace.warnings.length > 0
    || output.trace.warnings.length > 0
    || output.workspace.metrics.validation.status === "skipped"
    || output.diagnostics.duplicateToolCalls >= 2;
}

export function workflowRegressionGatesEnabled(args: Record<string, string>): boolean {
  return args.gates === "1" || process.env.PI_CHALIN_WORKFLOW_GATES === "1";
}

function sdkMultiAllowed(args: Record<string, string>): boolean {
  return args.allowMulti === "1" || process.env.PI_CHALIN_WORKFLOW_ALLOW_MULTI_SDK === "1";
}

export function assertSdkRunBudget(options: { caseIds: string[]; variants: WorkflowVariant[]; runs: number; timeoutMs: number; args: Record<string, string> }): void {
  if (options.args.allowLong === "1" || process.env.PI_CHALIN_WORKFLOW_ALLOW_LONG_SDK === "1") return;
  const totalRuns = options.caseIds.length * options.variants.length * options.runs;
  const estimatedWorstCaseMs = totalRuns * options.timeoutMs;
  const maxWallMs = Number(options.args.maxWallMs ?? process.env.PI_CHALIN_WORKFLOW_MAX_WALL_MS ?? DEFAULT_MAX_INTERACTIVE_SDK_WALL_MS);
  if (estimatedWorstCaseMs <= maxWallMs) return;
  throw new Error([
    `Refusing long SDK matrix by default: ${options.caseIds.length} case(s) × ${options.variants.length} variant(s) × ${options.runs} run(s) = ${totalRuns} SDK run(s).`,
    `Worst-case budget is ${estimatedWorstCaseMs}ms with timeoutMs=${options.timeoutMs}, above maxWallMs=${maxWallMs}.`,
    "Shard the matrix into smaller --case groups, lower --runs/--timeoutMs, or set PI_CHALIN_WORKFLOW_ALLOW_LONG_SDK=1/--allowLong=1 intentionally.",
  ].join(" "));
}

export function evaluateWorkflowRegressionGates(outputs: WorkflowRunOutput[], grouped: WorkflowComparisonSummary[]): WorkflowRegressionGates {
  const thresholds = {
    minChalinPassRate: 1,
    maxDirectChalinRouteCalls: 0,
    maxDuplicateToolCalls: 2,
    minBlindJudgeWinRate: 0.7,
    minCaseBlindJudgeWinRate: 0.7,
    maxBoundedDirectTokenMultiplier: 2,
  };
  const failures: string[] = [];
  const warnings: string[] = [];

  for (const output of outputs) {
    const label = `${output.variant} ${output.workspace.caseId}#${output.runIndex}`;
    const isChalin = output.variant === "chalin";
    if (output.diagnostics.infrastructureFailure) {
      const message = `${label}: infrastructure failure ${output.diagnostics.infrastructureFailure.kind}`;
      if (isChalin && blockingInfrastructureFailure(output)) failures.push(message);
      else warnings.push(message);
    }
    if (output.diagnostics.recoveredInfrastructureFailures?.length) {
      warnings.push(`${label}: recovered after ${output.diagnostics.sdkRetryAttempts ?? output.diagnostics.recoveredInfrastructureFailures.length} infrastructure retry attempt(s): ${output.diagnostics.recoveredInfrastructureFailures.map((failure) => failure.kind).join(", ")}`);
    }
    if (output.diagnostics.antiCheat && !output.diagnostics.antiCheat.pass) {
      const message = `${label}: anti-cheat boundary violation: ${output.diagnostics.antiCheat.critical.join("; ")}`;
      if (isChalin) failures.push(message);
      else warnings.push(message);
    }
    if (output.diagnostics.chalinRouteValidationErrors > 0) {
      const message = `${label}: chalin_route schema validation errors ${output.diagnostics.chalinRouteValidationErrors}`;
      if (isChalin) failures.push(message);
      else warnings.push(message);
    }
    if (!outputPass(output)) {
      const message = `${label}: output did not pass deterministic/judge checks`;
      if (isChalin) failures.push(message);
      else warnings.push(message);
    }
    if (output.diagnostics.finalAnswerMissing) {
      const message = `${label}: missing final answer evidence`;
      if (isChalin) failures.push(message);
      else warnings.push(message);
    }
    if (getWorkflowEvalCase(output.workspace.caseId).expected.validation?.runTests && !output.diagnostics.verificationPassed) {
      const message = `${label}: did not execute a passing verification command`;
      if (isChalin) failures.push(message);
      else warnings.push(message);
    }
    if (output.trace.warnings.some((issue) => issue.id === "thin-answer")) {
      const message = `${label}: thin final answer`;
      if (isChalin) failures.push(message);
      else warnings.push(message);
    }
    if (output.diagnostics.duplicateToolCalls > thresholds.maxDuplicateToolCalls) {
      warnings.push(`${label}: duplicate tool calls ${output.diagnostics.duplicateToolCalls} > ${thresholds.maxDuplicateToolCalls}`);
    }
    if (isChalin && output.diagnostics.traceSummary?.postVerificationExplorationCalls > 0) {
      warnings.push(`${label}: post-verification exploration ${output.diagnostics.traceSummary.postVerificationExplorationCalls} tool call(s) after passing verification`);
    }
    if (isChalin && output.diagnostics.traceSummary?.postVerificationShellCalls > 0) {
      warnings.push(`${label}: post-verification shell calls ${output.diagnostics.traceSummary.postVerificationShellCalls} after passing verification`);
    }
    if (output.variant === "chalin" && !shouldRequireChalinRoute(getWorkflowEvalCase(output.workspace.caseId)) && output.diagnostics.chalinRouteCalls > thresholds.maxDirectChalinRouteCalls) {
      failures.push(`${label}: direct-eligible case called chalin_route ${output.diagnostics.chalinRouteCalls} time(s)`);
    }
  }

  for (const group of grouped) {
    const evalCase = getWorkflowEvalCase(group.caseId);
    const chalin = group.variants.chalin;
    if (!chalin) continue;
    const chalinOutputs = outputs.filter((output) => output.variant === "chalin" && output.workspace.caseId === group.caseId);
    const chalinAllPass = chalinOutputs.length > 0 && chalinOutputs.every(outputPass);
    const recoveredInfra = chalinOutputs.some((output) => output.diagnostics.recoveredInfrastructureFailures?.length);
    if (chalin.passRate < thresholds.minChalinPassRate) failures.push(`${group.caseId}: chalin passRate ${chalin.passRate} < ${thresholds.minChalinPassRate}`);
    if (chalin.avgWorkspaceScore < 90) failures.push(`${group.caseId}: chalin workspace avg ${chalin.avgWorkspaceScore} < 90`);
    if (chalin.avgTraceScore < 90) failures.push(`${group.caseId}: chalin trace avg ${chalin.avgTraceScore} < 90`);
    if (evalCase.expected.maxDurationMs && chalin.p95DurationMs > evalCase.expected.maxDurationMs) {
      const message = `${group.caseId}: chalin p95 ${chalin.p95DurationMs}ms > case budget ${evalCase.expected.maxDurationMs}ms`;
      warnings.push(chalinAllPass && recoveredInfra ? `${message} due to recovered infrastructure retry` : message);
    }
    if (!group.pass) failures.push(`${group.caseId}: comparison gate failed (${group.reason})`);

    const simple = group.variants.simple;
    if (simple && isBoundedDirectWorkflowCase(evalCase) && chalin.passRate >= simple.passRate && chalin.avgWorkspaceScore >= simple.avgWorkspaceScore - 3) {
      const allowedTokens = Math.max(simple.avgTokens * thresholds.maxBoundedDirectTokenMultiplier, simple.avgTokens + 10_000);
      if (chalin.avgTokens > allowedTokens) {
        failures.push(`${group.caseId}: bounded/direct chalin token tax ${chalin.avgTokens} > ${allowedTokens} (simple=${simple.avgTokens})`);
      }
    }

    const caseBlindJudges = group.comparativeJudges?.filter((judge) => !judge.skipped) ?? [];
    if (caseBlindJudges.length === 1 && caseBlindJudges[0]?.targetWins) {
      warnings.push(`${group.caseId}: blind judge strong-win claim is single-sample only; rerun with --runs>=2 before treating it as stable`);
    } else if (caseBlindJudges.length >= 2) {
      const caseWins = caseBlindJudges.filter((judge) => judge.targetWins).length;
      const caseWinRate = round(caseWins / caseBlindJudges.length, 3);
      if (caseWinRate < thresholds.minCaseBlindJudgeWinRate) {
        failures.push(`${group.caseId}: blind judge case winRate ${caseWinRate} (${caseWins}/${caseBlindJudges.length}) < ${thresholds.minCaseBlindJudgeWinRate}`);
      }
    }
  }

  const skippedBlindJudges = grouped.flatMap((group) => group.comparativeJudges ?? []).filter((judge) => judge.skipped);
  for (const judge of skippedBlindJudges) {
    warnings.push(`${judge.caseId}: blind judge skipped (${judge.reason ?? "unknown"})`);
  }
  const blindJudges = grouped.flatMap((group) => group.comparativeJudges ?? []).filter((judge) => !judge.skipped);
  if (blindJudges.length > 0) {
    const targetWins = blindJudges.filter((judge) => judge.targetWins).length;
    const winRate = round(targetWins / blindJudges.length, 3);
    const rankSamples = blindJudges.map((judge) => judge.targetRank).filter((rank): rank is number => typeof rank === "number");
    const avgRank = rankSamples.length ? avg(rankSamples) : undefined;
    const summary = `blind judge chalin winRate ${winRate} (${targetWins}/${blindJudges.length})${avgRank !== undefined ? ` avgRank=${avgRank}` : ""}`;
    if (winRate < thresholds.minBlindJudgeWinRate) failures.push(`${summary} < ${thresholds.minBlindJudgeWinRate}`);
    else warnings.push(summary);
  }

  return { enabled: true, pass: failures.length === 0, failures, warnings, thresholds };
}

export function shouldRetainWorkflowFixture(output: Pick<WorkflowRunOutput, "workspace" | "trace" | "diagnostics" | "judge">, env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.PI_CHALIN_WORKFLOW_KEEP_FIXTURE === "1") return true;
  if (env.PI_CHALIN_WORKFLOW_KEEP_FAILED_FIXTURE === "0") return false;
  return !outputPass(output as WorkflowRunOutput);
}

export function buildWorkflowJudgePrompt(output: Pick<WorkflowRunOutput, "variant" | "finalText" | "workspace" | "trace" | "diagnostics"> & { evidence?: WorkflowOutputEvidence }, evalCase: WorkflowEvalCase): string {
  return [
    "Eres juez de evals de coding agents. Evalúa si el resultado cumple la tarea con calidad productiva.",
    "Responde SOLO JSON válido con: {\"pass\":boolean,\"score\":number,\"verdict\":string,\"critical\":string[],\"warnings\":string[]}.",
    "Usa el reporte determinístico como señal, pero si un check textual parece ambiguo revisa los snippets de archivos antes de fallar. Validación ejecutable, archivos cambiados y evidencia concreta pesan más que coincidencias literales frágiles. No premies longitud; premia cumplimiento, mínimo scope, tests y claridad.",
    `Caso: ${evalCase.id} (${evalCase.kind}/${evalCase.suite})\nPrompt: ${evalCase.prompt}`,
    `Reporte workspace:\n${JSON.stringify(output.workspace, null, 2)}`,
    `Reporte trace:\n${JSON.stringify(output.trace, null, 2)}`,
    `Métricas eficiencia:\n${JSON.stringify(output.diagnostics, null, 2)}`,
    `Snippets de archivos:\n${formatEvidenceFiles(output.evidence)}`,
    `Respuesta final:\n${snippet(output.finalText, 4000)}`,
  ].join("\n\n");
}

function workflowEvalPass(outputs: WorkflowRunOutput[], grouped: Array<{ pass: boolean }>): boolean {
  const hasBothVariants = outputs.some((item) => item.variant === "simple") && outputs.some((item) => item.variant === "chalin");
  const hasHarnessComparison = outputs.some((item) => item.variant === "chalin") && outputs.some((item) => item.variant === "gentle");
  if (hasHarnessComparison) return outputs.filter((item) => item.variant === "chalin").every(outputPass) && grouped.every((item) => item.pass);
  if (hasBothVariants) return outputs.filter((item) => item.variant === "chalin").every(outputPass) && grouped.every((item) => item.pass);
  return outputs.every(outputPass);
}

function disabledWorkflowRegressionGates(): WorkflowRegressionGates {
  return {
    enabled: false,
    pass: true,
    failures: [],
    warnings: [],
    thresholds: {
      minChalinPassRate: 1,
      maxDirectChalinRouteCalls: 0,
      maxDuplicateToolCalls: 2,
      minBlindJudgeWinRate: 0.7,
      minCaseBlindJudgeWinRate: 0.7,
      maxBoundedDirectTokenMultiplier: 2,
    },
  };
}

function outputPass(output: WorkflowRunOutput): boolean {
  if (blockingInfrastructureFailure(output)) return false;
  return outputContentPass(output);
}

function blockingInfrastructureFailure(output: WorkflowRunOutput): boolean {
  if (!output.diagnostics.infrastructureFailure) return false;
  return !outputContentPass(output);
}

function outputContentPass(output: WorkflowRunOutput): boolean {
  const requiresVerification = typeof output.workspace.caseId === "string"
    ? Boolean(getWorkflowEvalCase(output.workspace.caseId).expected.validation?.runTests)
    : false;
  return (output.workspace.pass || evidenceResolvedWorkspaceFailure(output))
    && output.trace.pass
    && !output.diagnostics.finalAnswerMissing
    && (output.diagnostics.antiCheat?.pass ?? true)
    && (!requiresVerification || output.diagnostics.verificationPassed)
    && (output.judge ? output.judge.pass : true);
}

function evidenceResolvedWorkspaceFailure(output: Pick<WorkflowRunOutput, "workspace" | "judge" | "diagnostics">): boolean {
  if (output.workspace.pass) return false;
  if (!output.judge?.pass || output.judge.score < 80) return false;
  if (output.diagnostics.antiCheat && !output.diagnostics.antiCheat.pass) return false;
  if (output.workspace.metrics.validation.status === "fail") return false;
  return output.workspace.critical.length > 0
    && output.workspace.critical.every((issue) => issue.id === "missing-required-content");
}

function reconcileEvidenceResolvedWorkspace(output: WorkflowRunOutput): WorkflowRunOutput {
  if (!evidenceResolvedWorkspaceFailure(output)) return output;
  const score = Math.max(output.workspace.score, output.judge?.score ?? 0);
  const resolvedWarnings = output.workspace.critical.map((issue) => ({
    ...issue,
    id: "judge-resolved-required-content",
    severity: "warning" as const,
    message: `Juez con evidencia resolvió check textual ambiguo: ${issue.message}`,
    penalty: Math.min(4, issue.penalty),
  }));
  return {
    ...output,
    workspace: {
      ...output.workspace,
      pass: true,
      score,
      qualityScore: Math.max(output.workspace.qualityScore, score),
      matched: [...output.workspace.matched, "judge:evidence-resolved-required-content"],
      critical: [],
      warnings: [...output.workspace.warnings, ...resolvedWarnings],
    },
  };
}

export function summarizeComparison(outputs: WorkflowRunOutput[], comparativeJudges: WorkflowComparativeJudgeVerdict[] = []): WorkflowComparisonSummary[] {
  const caseIds = [...new Set(outputs.map((item) => item.workspace.caseId))];
  return caseIds.map((caseId) => {
    const runsByVariant = Object.fromEntries(workflowVariants.map((variant) => [variant, runsForVariant(outputs, caseId, variant)])) as Record<WorkflowVariant, WorkflowRunOutput[]>;
    const variants = Object.fromEntries(workflowVariants.map((variant) => [variant, summarizeVariant(runsByVariant[variant])])) as Partial<Record<WorkflowVariant, VariantStats>>;
    const targetInfraFailure = runsByVariant[targetVariant].find(blockingInfrastructureFailure)?.diagnostics.infrastructureFailure;
    const caseComparativeJudges = comparativeJudges.filter((item) => item.caseId === caseId);
    const comparisons = buildWorkflowComparisons(variants, { caseId, chalinRuns: runsByVariant.chalin, comparativeJudges: caseComparativeJudges });
    const comparativeJudgeReason = caseComparativeJudges.length
      ? `blind-judge ${caseComparativeJudges.map((item) => `run${item.runIndex}:winner=${item.winnerVariant ?? item.winnerLabel ?? "unknown"},targetRank=${item.targetRank ?? "n/a"}`).join(", ")}`
      : "";
    if (comparisons.length === 0) {
      const only = workflowVariants.map((variant) => variants[variant]).find((item): item is VariantStats => Boolean(item));
      return {
        caseId,
        pass: Boolean(only && only.passRate === 1),
        reason: targetInfraFailure
          ? `target-infrastructure-failure ${targetInfraFailure.kind}: ${targetInfraFailure.message}`
          : [only ? `single-variant diagnosis passRate=${only.passRate}` : "single-variant diagnosis with no runs", comparativeJudgeReason].filter(Boolean).join("; "),
        variants,
        comparisons,
        comparativeJudges: caseComparativeJudges.length ? caseComparativeJudges : undefined,
      };
    }
    if (targetInfraFailure) {
      return {
        caseId,
        pass: false,
        reason: `target-infrastructure-failure ${targetInfraFailure.kind}: ${targetInfraFailure.message}`,
        variants,
        comparisons,
        comparativeJudges: caseComparativeJudges.length ? caseComparativeJudges : undefined,
      };
    }
    return {
      caseId,
      pass: comparisons.every((comparison) => comparison.pass),
      reason: [
        comparisons.map((comparison) => `${comparison.target}-vs-${comparison.baseline}: ${comparison.reason}`).join("; "),
        comparativeJudgeReason,
      ].filter(Boolean).join("; "),
      variants,
      comparisons,
      comparativeJudges: caseComparativeJudges.length ? caseComparativeJudges : undefined,
    };
  });
}

function runsForVariant(outputs: WorkflowRunOutput[], caseId: string, variant: WorkflowVariant): WorkflowRunOutput[] {
  return outputs.filter((item) => item.workspace.caseId === caseId && item.variant === variant);
}

function buildWorkflowComparisons(variants: Partial<Record<WorkflowVariant, VariantStats>>, options: { caseId: string; chalinRuns: WorkflowRunOutput[]; comparativeJudges: WorkflowComparativeJudgeVerdict[] }): WorkflowPairComparison[] {
  const target = variants[targetVariant];
  if (!target) return [];
  const comparisons: WorkflowPairComparison[] = [];
  const simple = variants[baselineVariant];
  if (simple) {
    const evalCase = getWorkflowEvalCase(options.caseId);
    const comparison = compareChalinToSimple(target, simple, options.chalinRuns, options.comparativeJudges, workflowCaseMaxDurationMs(options.caseId), isBoundedDirectWorkflowCase(evalCase));
    comparisons.push({ kind: "baseline", target: targetVariant, baseline: baselineVariant, ...comparison });
  }
  for (const competitor of Object.keys(variants) as WorkflowVariant[]) {
    if (competitor === targetVariant || competitor === baselineVariant) continue;
    const stats = variants[competitor];
    if (!stats) continue;
    const comparison = compareChalinToCompetitor(target, stats, competitor, options.chalinRuns, options.comparativeJudges);
    comparisons.push({ kind: "competitor", target: targetVariant, baseline: competitor, ...comparison });
  }
  return comparisons;
}

function compareChalinToSimple(chalin: VariantStats, simple: VariantStats, chalinRuns: WorkflowRunOutput[], comparativeJudges: WorkflowComparativeJudgeVerdict[], caseMaxDurationMs?: number, boundedDirect = false): { pass: boolean; reason: string } {
  const qualityFloor = Math.max(90, simple.avgWorkspaceScore - 5);
  const chalinQualityComparable = chalin.avgWorkspaceScore >= qualityFloor;
  const chalinReliabilityComparable = chalin.passRate >= simple.passRate;
  const chalinReliabilityDominates = chalin.passRate > simple.passRate;
  const blindJudgeAvailable = hasBlindJudgeComparison(comparativeJudges, baselineVariant);
  const blindJudgeQualityDominates = blindJudgeDominatesCompetitor(comparativeJudges, baselineVariant);
  const chalinQualityDominates = chalinReliabilityDominates
    || chalin.avgWorkspaceScore >= simple.avgWorkspaceScore + 5
    || (typeof chalin.avgJudgeScore === "number" && typeof simple.avgJudgeScore === "number" && chalin.avgJudgeScore >= simple.avgJudgeScore + 5)
    || blindJudgeQualityDominates;
  const chalinEfficiencyBudget = Math.max(simple.p95DurationMs * 1.75, simple.p95DurationMs + 15_000)
    + p95ComparisonNoiseBudgetMs(simple.p95DurationMs);
  const baseTokenBudget = boundedDirect
    ? boundedDirectTokenBudget(simple.avgTokens)
    : simpleBaselineTokenBudget(simple.avgTokens);
  const slowestChalinRun = chalinRuns.reduce<WorkflowRunOutput | undefined>((slowest, item) => !slowest || item.durationMs > slowest.durationMs ? item : slowest, undefined);
  const chalinP95InflatedByRecoveredInfra = chalinRuns.length > 0
    && chalinRuns.every(outputPass)
    && Boolean(slowestChalinRun?.diagnostics.recoveredInfrastructureFailures?.length)
    && chalin.p95DurationMs >= (slowestChalinRun?.durationMs ?? 0);
  const chalinWithinCaseBudget = typeof caseMaxDurationMs === "number" && chalin.p95DurationMs <= caseMaxDurationMs;
  const chalinEfficiencyComparable = chalin.p95DurationMs <= chalinEfficiencyBudget
    || chalinP95InflatedByRecoveredInfra
    || (chalinReliabilityDominates && chalinQualityDominates && chalinWithinCaseBudget);
  const tokenGateRequired = !chalinReliabilityDominates;
  const tokenBudget = (blindJudgeQualityDominates ? Math.max(baseTokenBudget, simple.avgTokens + 80_000) : baseTokenBudget)
    + tokenComparisonNoiseBudget(simple.avgTokens);
  const chalinTokenEfficient = !tokenGateRequired || chalin.avgTokens <= tokenBudget;
  return {
    pass: chalinQualityComparable
      && chalinReliabilityComparable
      && (blindJudgeAvailable ? blindJudgeQualityDominates : chalinQualityDominates)
      && (!boundedDirect || chalinEfficiencyComparable)
      && (!boundedDirect || chalinTokenEfficient),
    reason: `chalinAvg=${chalin.avgWorkspaceScore}, simpleAvg=${simple.avgWorkspaceScore}, chalinPass=${chalin.passRate}, simplePass=${simple.passRate}, chalinP95=${chalin.p95DurationMs}ms, simpleP95=${simple.p95DurationMs}ms, chalinTokens=${chalin.avgTokens}, simpleTokens=${simple.avgTokens}, simpleTokenBudget=${tokenBudget}, boundedDirect:${boundedDirect ? "yes" : "no"}, qualityDominates:${chalinQualityDominates ? "yes" : "no"}, qualityGate:${blindJudgeAvailable ? "blind-judge" : chalinQualityDominates ? "dominates" : "required"}, blindJudgeQualityDominates:${blindJudgeQualityDominates ? "accepted" : blindJudgeAvailable ? "rejected" : "unavailable"}, reliabilityDominates:${chalinReliabilityDominates ? "yes" : "no"}, efficiencyGate:${chalinEfficiencyComparable ? chalinWithinCaseBudget && chalinReliabilityDominates && chalinQualityDominates && chalin.p95DurationMs > chalinEfficiencyBudget ? "case-budget-dominance" : "reasonable" : "exceeded"}, tokenGate:${tokenGateRequired ? chalinTokenEfficient ? "reasonable" : "exceeded" : "skipped-reliability-dominates"}, deterministicEfficiencyGate:${boundedDirect ? "blocking-for-bounded-direct" : "observed-only"}${chalinP95InflatedByRecoveredInfra ? ", chalinP95RecoveredInfra=true" : ""}`,
  };
}

function workflowCaseMaxDurationMs(caseId: string): number | undefined {
  try {
    return getWorkflowEvalCase(caseId).expected.maxDurationMs;
  } catch {
    return undefined;
  }
}

function compareChalinToCompetitor(chalin: VariantStats, competitor: VariantStats, competitorName: WorkflowVariant, chalinRuns: WorkflowRunOutput[], comparativeJudges: WorkflowComparativeJudgeVerdict[]): { pass: boolean; reason: string } {
  const p95NoiseBudgetMs = p95ComparisonNoiseBudgetMs(competitor.p95DurationMs);
  const tokenNoiseBudget = tokenComparisonNoiseBudget(competitor.avgTokens);
  const requiresGentleTokenWin = competitorName === "gentle";
  const chalinP95InflatedByRecoveredInfra = chalinRuns.length > 0
    && chalinRuns.every(outputPass)
    && chalinRuns.some((item) => item.diagnostics.recoveredInfrastructureFailures?.length)
    && chalin.p95DurationMs >= Math.max(...chalinRuns.map((item) => item.durationMs));
  const p95Comparable = chalin.p95DurationMs <= competitor.p95DurationMs + p95NoiseBudgetMs || chalinP95InflatedByRecoveredInfra;
  const tokensComparable = chalin.avgTokens <= competitor.avgTokens + tokenNoiseBudget;
  const tokensStronglyBetter = chalin.avgTokens <= Math.round(competitor.avgTokens * 0.85) + tokenNoiseBudget;
  const qualityChecks = [
    ["pass", chalin.passRate >= competitor.passRate, `${chalin.passRate}>=${competitor.passRate}`],
    ["workspace", chalin.avgWorkspaceScore >= competitor.avgWorkspaceScore, `${chalin.avgWorkspaceScore}>=${competitor.avgWorkspaceScore}`],
    ["trace", chalin.avgTraceScore >= competitor.avgTraceScore, `${chalin.avgTraceScore}>=${competitor.avgTraceScore}`],
    ["verification", chalin.verificationPassRate >= competitor.verificationPassRate, `${chalin.verificationPassRate}>=${competitor.verificationPassRate}`],
  ] as const;
  const efficiencyChecks = [
    ["p95", p95Comparable, `${chalin.p95DurationMs}ms<=${competitor.p95DurationMs}ms+${p95NoiseBudgetMs}ms${chalinP95InflatedByRecoveredInfra ? " or recovered-infra" : ""}`],
    ["tokens", tokensComparable, `${chalin.avgTokens}<=${competitor.avgTokens}+${tokenNoiseBudget}`],
  ] as const;
  const muchCheaperWithComparableP95 = chalin.avgTokens <= competitor.avgTokens * 0.75 && chalin.p95DurationMs <= competitor.p95DurationMs * 1.15;
  const majorTokenSavingsWithBoundedLatency = chalin.avgTokens <= competitor.avgTokens * 0.60
    && chalin.p95DurationMs <= Math.min(45_000, Math.round((competitor.p95DurationMs * 2) + 1_000));
  const blindJudgeAvailable = hasBlindJudgeComparison(comparativeJudges, competitorName);
  const blindJudgeQualityDominates = blindJudgeDominatesCompetitor(comparativeJudges, competitorName);
  const judgeScoreQualityDominates = typeof chalin.avgJudgeScore === "number"
    && typeof competitor.avgJudgeScore === "number"
    && chalin.avgJudgeScore >= competitor.avgJudgeScore + 8
    && chalin.avgTokens <= competitor.avgTokens;
  const judgeQualityDominates = judgeScoreQualityDominates || blindJudgeQualityDominates;
  const chalinReliabilityDominates = chalin.passRate > competitor.passRate;
  const chalinQualityDominates = chalinReliabilityDominates
    || chalin.avgWorkspaceScore >= competitor.avgWorkspaceScore + 10
    || (chalin.avgWorkspaceScore === 100 && competitor.avgWorkspaceScore < 95)
    || judgeQualityDominates;
  const tokensAcceptableWithQualityLead = chalinQualityDominates
    && chalin.avgTokens <= Math.round(competitor.avgTokens * 1.25);
  const paretoQualityCostLead = chalinQualityDominates
    && p95Comparable
    && chalin.avgTokens <= competitor.avgTokens
    && (chalin.avgWorkspaceScore > competitor.avgWorkspaceScore
      || chalin.avgTraceScore > competitor.avgTraceScore
      || (typeof chalin.avgJudgeScore === "number" && typeof competitor.avgJudgeScore === "number" && chalin.avgJudgeScore > competitor.avgJudgeScore)
      || blindJudgeQualityDominates);
  const tokensStronglyBetterWithReasonableP95 = tokensStronglyBetter
    && chalin.p95DurationMs <= Math.round((competitor.p95DurationMs * 1.35) + 1_000);
  const efficiencyGateRequired = !chalinQualityDominates;
  const costGateRequired = !chalinReliabilityDominates;
  const competitorTokenPass = requiresGentleTokenWin
    ? chalinReliabilityDominates
      || paretoQualityCostLead
      || (chalinQualityDominates && (tokensStronglyBetterWithReasonableP95 || majorTokenSavingsWithBoundedLatency))
    : (!costGateRequired || tokensComparable);
  const efficiencyComparable = efficiencyChecks.every(([, pass]) => pass)
    || muchCheaperWithComparableP95
    || majorTokenSavingsWithBoundedLatency
    || tokensStronglyBetterWithReasonableP95;
  return {
    pass: qualityChecks.every(([, pass]) => pass)
      && (blindJudgeAvailable ? blindJudgeQualityDominates : chalinQualityDominates),
    reason: `chalin-vs-${competitorName} ${[
      ...qualityChecks.map(([name, , evidence]) => `${name}:${evidence}`),
      ...efficiencyChecks.map(([name, , evidence]) => `${name}:${evidence}`),
      `tokensStronglyBetter:${tokensStronglyBetter ? "yes" : "no"}`,
      `tokensAcceptableWithQualityLead:${tokensAcceptableWithQualityLead ? "yes" : "no"}`,
      `paretoQualityCostLead:${paretoQualityCostLead ? "accepted" : "no"}`,
      `tokensStronglyBetterWithReasonableP95:${tokensStronglyBetterWithReasonableP95 ? "yes" : "no"}`,
      `costPerfTradeoff:${muchCheaperWithComparableP95 ? "accepted" : "no"}`,
      `majorTokenSavingsBoundedLatency:${majorTokenSavingsWithBoundedLatency ? "accepted" : "no"}`,
      `judgeQualityDominates:${judgeQualityDominates ? "accepted" : "no"}`,
      `blindJudgeQualityDominates:${blindJudgeQualityDominates ? "accepted" : blindJudgeAvailable ? "rejected" : "unavailable"}`,
      `reliabilityDominates:${chalinReliabilityDominates ? "yes" : "no"}`,
      `qualityGate:${chalinQualityDominates ? "dominates" : "required"}`,
      chalinP95InflatedByRecoveredInfra ? "recoveredInfra:accepted" : "recoveredInfra:no",
      `efficiencyGate:${efficiencyGateRequired ? "required" : "skipped-quality-dominates"}`,
      `costGate:${requiresGentleTokenWin ? "strong-vs-gentle" : costGateRequired ? "required" : "skipped-reliability-dominates"}`,
      `deterministicEfficiencyGate:observed-only`,
    ].join(", ")}`,
  };
}

function hasBlindJudgeComparison(comparativeJudges: WorkflowComparativeJudgeVerdict[], competitorName: WorkflowVariant): boolean {
  return comparativeJudges.some((judge) => !judge.skipped
    && judge.target === targetVariant
    && judge.candidates.some((candidate) => candidate.variant === competitorName));
}

function blindJudgeDominatesCompetitor(comparativeJudges: WorkflowComparativeJudgeVerdict[], competitorName: WorkflowVariant): boolean {
  const relevant = comparativeJudges.filter((judge) => !judge.skipped
    && judge.target === targetVariant
    && judge.candidates.some((candidate) => candidate.variant === competitorName));
  if (relevant.length === 0) return false;
  const wins = relevant.filter((judge) => judge.targetWins).length;
  return wins / relevant.length >= 0.7;
}

function simpleBaselineTokenBudget(simpleAvgTokens: number): number {
  return Math.max(Math.round(simpleAvgTokens * 3), simpleAvgTokens + 60_000);
}

function boundedDirectTokenBudget(simpleAvgTokens: number): number {
  return Math.max(Math.round(simpleAvgTokens * 2), simpleAvgTokens + 10_000);
}

function p95ComparisonNoiseBudgetMs(competitorP95DurationMs: number): number {
  return Math.max(500, Math.round(competitorP95DurationMs * 0.02));
}

function tokenComparisonNoiseBudget(competitorAvgTokens: number): number {
  return Math.max(500, Math.round(competitorAvgTokens * 0.02));
}

function summarizeVariant(items: WorkflowRunOutput[]): VariantStats | undefined {
  if (items.length === 0) return undefined;
  const durations = items.map((item) => item.durationMs).sort((a, b) => a - b);
  const validTimes = items.map((item) => item.diagnostics.timeToWorkspaceValidMs).filter((item): item is number => typeof item === "number");
  const verificationTimes = items.map((item) => item.diagnostics.timeToVerificationPassMs).filter((item): item is number => typeof item === "number");
  const finalTimes = items.map((item) => item.diagnostics.timeToFinalAnswerMs).filter((item): item is number => typeof item === "number");
  return {
    runs: items.length,
    passCount: items.filter(outputPass).length,
    passRate: round(items.filter(outputPass).length / items.length, 3),
    infrastructureFailures: items.filter((item) => item.diagnostics.infrastructureFailure).length,
    avgWorkspaceScore: avg(items.map(effectiveWorkspaceScoreForComparison)),
    avgTraceScore: avg(items.map(effectiveTraceScoreForComparison)),
    avgJudgeScore: averageOptional(items.map((item) => item.judge?.score)),
    avgDurationMs: avg(items.map((item) => item.durationMs)),
    p95DurationMs: percentile(durations, 0.95),
    avgTimeToWorkspaceStaticValidMs: validTimes.length ? avg(validTimes) : undefined,
    avgTimeToWorkspaceValidMs: validTimes.length ? avg(validTimes) : undefined,
    avgTimeToVerificationPassMs: verificationTimes.length ? avg(verificationTimes) : undefined,
    avgTimeToFinalAnswerMs: finalTimes.length ? avg(finalTimes) : undefined,
    verificationPassRate: round(items.filter((item) => item.diagnostics.verificationPassed).length / items.length, 3),
    avgToolCalls: avg(items.map((item) => item.diagnostics.toolEvents)),
    avgReadCalls: avg(items.map((item) => item.diagnostics.readCalls)),
    avgWriteCalls: avg(items.map((item) => item.diagnostics.writeCalls)),
    avgEditCalls: avg(items.map((item) => item.diagnostics.editCalls)),
    avgRetries: avg(items.map((item) => item.diagnostics.retries)),
    avgAgentRetries: avg(items.map((item) => item.diagnostics.agentRetries)),
    avgInfraRetries: avg(items.map((item) => item.diagnostics.infraRetries)),
    avgAntiCheatCriticals: avg(items.map((item) => item.diagnostics.antiCheat?.critical.length ?? 0)),
    avgChalinRouteCalls: avg(items.map((item) => item.diagnostics.chalinRouteCalls)),
    avgChalinRouteNonExecutable: avg(items.map((item) => item.diagnostics.chalinRouteNonExecutable)),
    avgChalinRouteValidationErrors: avg(items.map((item) => item.diagnostics.chalinRouteValidationErrors)),
    avgDuplicateToolCalls: avg(items.map((item) => item.diagnostics.duplicateToolCalls)),
    avgTokens: avg(items.map((item) => item.diagnostics.tokenTotal)),
    totalTokens: items.reduce((sum, item) => sum + item.diagnostics.tokenTotal, 0),
    estimatedCostUsd: estimateCostUsd(items.reduce((sum, item) => sum + item.diagnostics.tokenTotal, 0)),
    costPerPassingRunUsd: items.filter(outputPass).length > 0 ? round(estimateCostUsd(items.reduce((sum, item) => sum + item.diagnostics.tokenTotal, 0)) / items.filter(outputPass).length, 4) : undefined,
    flakiness: round(1 - Math.max(items.filter(outputPass).length / items.length, 1 - (items.filter(outputPass).length / items.length)), 3),
  };
}

function effectiveTraceScoreForComparison(output: WorkflowRunOutput): number {
  const recoveredInfra = Boolean(output.diagnostics.recoveredInfrastructureFailures?.length);
  const onlyDurationWarnings = output.trace.critical.length === 0
    && output.trace.warnings.length > 0
    && output.trace.warnings.every((issue) => issue.id === "duration-budget-exceeded");
  return recoveredInfra && onlyDurationWarnings ? 100 : output.trace.score;
}

function effectiveWorkspaceScoreForComparison(output: WorkflowRunOutput): number {
  if (!evidenceResolvedWorkspaceFailure(output)) return output.workspace.score;
  return Math.max(output.workspace.score, output.judge?.score ?? 0);
}

async function runSdkCase(evalCase: WorkflowEvalCase, variant: WorkflowVariant, timeoutMs: number, runIndex: number, options: WorkflowRunOptions): Promise<WorkflowRunOutput> {
  const fixture = createWorkflowFixture(evalCase.id, { promptVariantIndex: runIndex - 1 });
  const started = Date.now();
  const args = [
    "-p",
    "--no-session",
    "--mode",
    "json",
    "--no-context-files",
    "--no-skills",
    "--no-extensions",
    "--tools",
    toolsForWorkflowVariant(variant, evalCase),
  ];
  args.push(...extensionArgsForWorkflowVariant(variant, options));
  const model = options.model;
  if (model) args.push("--model", model);
  args.push("--thinking", resolveWorkflowThinking(evalCase, options.thinking), fixture.prompt);
  const run = await runPi(args, fixture.cwd, timeoutMs, {
    observeWorkspacePass: shouldRequireChalinRoute(evalCase) ? undefined : () => scoreWorkflowWorkspace(fixture.cwd, evalCase, { finalText: "", validateTests: false }).pass,
    env: variant === "chalin" && model ? { PI_CHALIN_EVAL_AGENT_MODEL: model } : undefined,
  });
  const durationMs = Date.now() - started;
  // Never treat raw JSON event streams as the final answer.
  // On timeout/no-final runs, using stdout here falsely matches prompts, file paths,
  // and tool traces as if the agent had delivered evidence.
  const rawFinalText = extractFinalText(run.stdout);
  const finalText = effectiveWorkflowFinalText(run.stdout, rawFinalText, variant);
  const workspace = scoreWorkflowWorkspace(fixture.cwd, evalCase, { finalText, durationMs, validateTests: evalCase.expected.validation?.runTests === true });
  const trace = gradePiTrace(run.stdout, { variant: variant as TraceVariant, finalText: rawFinalText, promptKind: "generic", requireChalinRoute: shouldRequireChalinRoute(evalCase), status: run.status, signal: run.signal, timeoutReason: run.timeoutReason, durationMs, maxDurationMs: timeoutMs });
  const diagnostics = workflowDiagnostics(evalCase, run.stdout, run.stderr, run.timeToWorkspaceValidMs, run.timeToVerificationPassMs, run.timeToFinalAnswerMs, finalText.length === 0, run.objectiveStopReason, run.timeoutReason);
  const evidence = collectWorkflowEvidence(fixture.cwd, evalCase);
  let output: WorkflowRunOutput = { variant, runIndex, cwd: fixture.cwd, stdout: run.stdout, stderr: run.stderr, finalText, status: run.status, signal: run.signal, timeoutReason: run.timeoutReason, durationMs, workspace, trace, diagnostics, evidence, promptVariantIndex: fixture.promptVariantIndex, promptVariantCount: fixture.promptVariantCount };
  if (options.judgeMode === "pi" || (options.judgeMode === "auto" && shouldRunWorkflowJudge(output))) output.judge = await runWorkflowJudge(output, evalCase, options);
  else if (options.judgeMode === "auto") output.judge = { pass: true, score: 100, verdict: "Judge skipped; deterministic result was unambiguous.", critical: [], warnings: [], skipped: true, reason: "deterministic-unambiguous" };
  output = reconcileEvidenceResolvedWorkspace(output);
  if (shouldRetainWorkflowFixture(output)) output.retainedFixturePath = fixture.cwd;
  else fs.rmSync(fixture.cwd, { recursive: true, force: true });
  return output;
}

export function toolsForWorkflowVariant(variant: WorkflowVariant, evalCase: WorkflowEvalCase): string {
  const tools = "read,bash,grep,find,ls,edit,write";
  return variant === "chalin" ? `${tools},chalin_project_discovery,chalin_project_snapshot,chalin_route` : tools;
}

function extensionArgsForWorkflowVariant(variant: WorkflowVariant, options: Pick<WorkflowRunOptions, "gentleRoot">): string[] {
  if (variant === "chalin") return ["-e", extensionPath];
  if (variant !== "gentle") return [];
  const root = resolveGentlePiRoot(options.gentleRoot);
  return [
    "-e", path.join(root, "extensions", "gentle-ai.ts"),
    "-e", path.join(root, "extensions", "skill-registry.ts"),
    "-e", path.join(root, "extensions", "sdd-init.ts"),
    "-e", path.join(root, "extensions", "startup-banner.ts"),
  ];
}

async function runSdkCaseWithRetries(evalCase: WorkflowEvalCase, variant: WorkflowVariant, timeoutMs: number, runIndex: number, options: WorkflowRunOptions): Promise<WorkflowRunOutput> {
  const maxRetries = resolveWorkflowInfraRetries(process.env.PI_CHALIN_WORKFLOW_INFRA_RETRIES);
  const failedAttempts: WorkflowRunOutput[] = [];

  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    const output = await runSdkCase(evalCase, variant, timeoutMs, runIndex, options);
    const retryable = shouldRetryWorkflowRun(output);
    if (!retryable || attempt === maxRetries) return withRetryDiagnostics(output, failedAttempts);
    failedAttempts.push(output);
    console.log(`progress: ${variant} ${evalCase.id}#${runIndex} retry ${attempt + 1}/${maxRetries} after ${output.diagnostics.infrastructureFailure?.kind ?? "unknown-infra"}`);
  }

  throw new Error("unreachable workflow retry loop");
}

export function resolveWorkflowInfraRetries(value: string | undefined): number {
  const parsed = Number(value ?? 1);
  return Number.isFinite(parsed) && parsed > 0 ? Math.min(Math.floor(parsed), 2) : 0;
}

function shouldRetryWorkflowRun(output: WorkflowRunOutput): boolean {
  const failure = output.diagnostics.infrastructureFailure;
  return Boolean(failure && !outputPass(output));
}

function withRetryDiagnostics(output: WorkflowRunOutput, failedAttempts: WorkflowRunOutput[]): WorkflowRunOutput {
  if (failedAttempts.length === 0) return output;
  const totalDurationMs = output.durationMs + failedAttempts.reduce((sum, item) => sum + item.durationMs, 0);
  const usage = cloneUsage(output.diagnostics.usage);
  for (const attempt of failedAttempts) addUsage(usage, attempt.diagnostics.usage);
  const retryToolCalls = failedAttempts.reduce((sum, item) => sum + item.diagnostics.toolEvents, 0);
  const retainedRetryFixturePaths = failedAttempts.map((item) => item.retainedFixturePath).filter((item): item is string => Boolean(item));
  const recoveredInfrastructureFailures = output.diagnostics.infrastructureFailure
    ? []
    : failedAttempts.map((item) => item.diagnostics.infrastructureFailure).filter((item): item is WorkflowInfrastructureFailure => Boolean(item));
  return {
    ...output,
    durationMs: totalDurationMs,
    diagnostics: {
      ...output.diagnostics,
      toolEvents: output.diagnostics.toolEvents + retryToolCalls,
      usage,
      tokenTotal: usage.totalTokens,
      infraRetries: output.diagnostics.infraRetries + failedAttempts.length,
      retries: output.diagnostics.agentRetries + output.diagnostics.infraRetries + failedAttempts.length,
      sdkRetryAttempts: failedAttempts.length,
      recoveredInfrastructureFailures: recoveredInfrastructureFailures.length ? recoveredInfrastructureFailures : undefined,
      retainedRetryFixturePaths: retainedRetryFixturePaths.length ? retainedRetryFixturePaths : undefined,
    },
  };
}

export function shouldRequireChalinRoute(evalCase: WorkflowEvalCase): boolean {
  return evalCase.expected.orchestration?.requireChalinRoute === true;
}

function isBoundedDirectWorkflowCase(evalCase: WorkflowEvalCase): boolean {
  if (shouldRequireChalinRoute(evalCase)) return false;
  if (evalCase.suite === "complex") return false;
  if (evalCase.kind === "review-only") return false;
  const maxFiles = evalCase.expected.maxFiles ?? Number.POSITIVE_INFINITY;
  return maxFiles <= 6 || evalCase.kind === "small-feature" || evalCase.kind === "test-writing" || evalCase.kind === "bugfix";
}

async function runWorkflowJudge(output: WorkflowRunOutput, evalCase: WorkflowEvalCase, options: Pick<WorkflowRunOptions, "judgeModel" | "judgeTimeoutMs"> = {}): Promise<WorkflowJudgeVerdict> {
  const model = options.judgeModel ?? DEFAULT_JUDGE_MODEL;
  const timeoutMs = resolveJudgeTimeoutMs(options.judgeTimeoutMs);
  const prompt = buildWorkflowJudgePrompt(output, evalCase);
  let lastError: unknown;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const retryHint = attempt === 0 ? "" : "\n\nPrevious judge attempt failed. Return exactly one JSON object and no prose.";
      const text = await runPiJsonPrompt(`${prompt}${retryHint}`, { cwd: repoRoot, model, timeoutMs });
      const parsed = parseJsonObjectFromText(text);
      return {
        pass: Boolean(parsed.pass),
        score: typeof parsed.score === "number" ? Math.max(0, Math.min(100, Math.round(parsed.score))) : 0,
        verdict: typeof parsed.verdict === "string" ? parsed.verdict : "No verdict",
        critical: Array.isArray(parsed.critical) ? parsed.critical.filter((item): item is string => typeof item === "string") : [],
        warnings: Array.isArray(parsed.warnings) ? parsed.warnings.filter((item): item is string => typeof item === "string") : [],
      };
    } catch (error) {
      lastError = error;
      if (!isWorkflowJudgeInfrastructureError(error)) break;
    }
  }
  const message = lastError instanceof Error ? lastError.message : String(lastError);
  if (isWorkflowJudgeInfrastructureError(lastError)) {
    return {
      pass: outputContentPass({ ...output, judge: undefined }),
      score: output.workspace.pass ? Math.max(output.workspace.score, output.trace.score) : output.workspace.score,
      verdict: "Judge skipped after infrastructure failure",
      critical: [],
      warnings: [message],
      skipped: true,
      reason: "judge-infrastructure",
    };
  }
  return { pass: false, score: 0, verdict: "Judge failed", critical: [message], warnings: [] };
}

async function runWorkflowComparativeJudges(outputs: WorkflowRunOutput[], options: Pick<WorkflowRunOptions, "judgeModel" | "judgeTimeoutMs">): Promise<WorkflowComparativeJudgeVerdict[]> {
  const verdicts: WorkflowComparativeJudgeVerdict[] = [];
  const keys = [...new Set(outputs.map((output) => `${output.workspace.caseId}:${output.runIndex}`))];
  for (const key of keys) {
    const [caseId, runIndexText] = key.split(":");
    if (!caseId || !runIndexText) continue;
    const runIndex = Number(runIndexText);
    const candidates = outputs.filter((output) => output.workspace.caseId === caseId && output.runIndex === runIndex);
    if (!candidates.some((output) => output.variant === targetVariant) || candidates.length < 2) continue;
    verdicts.push(await runWorkflowComparativeJudge(getWorkflowEvalCase(caseId), runIndex, candidates, options));
  }
  return verdicts;
}

async function runWorkflowComparativeJudge(evalCase: WorkflowEvalCase, runIndex: number, candidates: WorkflowRunOutput[], options: Pick<WorkflowRunOptions, "judgeModel" | "judgeTimeoutMs">): Promise<WorkflowComparativeJudgeVerdict> {
  const model = options.judgeModel ?? DEFAULT_JUDGE_MODEL;
  const timeoutMs = resolveJudgeTimeoutMs(options.judgeTimeoutMs);
  const blinded = blindWorkflowCandidates(candidates, `${evalCase.id}:${runIndex}`);
  const prompt = buildWorkflowComparativeJudgePrompt(evalCase, blinded);
  let lastError: unknown;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const retryHint = attempt === 0 ? "" : "\n\nPrevious response was not parseable JSON. Return exactly one JSON object and no prose.";
      const text = await runPiJsonPrompt(`${prompt}${retryHint}`, { cwd: repoRoot, model, timeoutMs });
      const parsed = parseJsonObjectFromText(text);
      const allowedLabels = blinded.map((item) => item.label);
      const ranking = parseRanking(parsed.ranking, allowedLabels);
      const winnerLabel = typeof parsed.winner === "string" ? parsed.winner.trim().toUpperCase() : ranking[0];
      if (!winnerLabel || !allowedLabels.includes(winnerLabel) || ranking.length === 0) {
        throw new Error("judge output missing valid winner/ranking labels");
      }
      const winnerVariant = blinded.find((item) => item.label === winnerLabel)?.output.variant;
      const targetLabel = blinded.find((item) => item.output.variant === targetVariant)?.label;
      const targetRank = targetLabel ? ranking.indexOf(targetLabel) + 1 : undefined;
      const scores = parseScoreMap(parsed.scores, allowedLabels);
      return {
        caseId: evalCase.id,
        runIndex,
        target: targetVariant,
        candidates: blinded.map((item) => candidateSummary(item)),
        winnerLabel,
        winnerVariant,
        ranking,
        scores,
        targetWins: winnerVariant === targetVariant && (targetRank === undefined || targetRank === 1),
        targetRank: targetRank && targetRank > 0 ? targetRank : undefined,
        verdict: typeof parsed.verdict === "string" ? parsed.verdict : "No verdict",
        critical: Array.isArray(parsed.critical) ? parsed.critical.filter((item): item is string => typeof item === "string") : [],
        warnings: Array.isArray(parsed.warnings) ? parsed.warnings.filter((item): item is string => typeof item === "string") : [],
      };
    } catch (error) {
      lastError = error;
    }
  }
  const message = lastError instanceof Error ? lastError.message : String(lastError);
  const judgeInfrastructureFailure = isWorkflowJudgeInfrastructureError(lastError);
  return {
    caseId: evalCase.id,
    runIndex,
    target: targetVariant,
    candidates: blinded.map((item) => candidateSummary(item)),
    ranking: [],
    scores: {},
    targetWins: false,
    verdict: judgeInfrastructureFailure ? "Comparative judge skipped after infrastructure failure" : "Comparative judge failed",
    critical: judgeInfrastructureFailure ? [] : [message],
    warnings: judgeInfrastructureFailure ? [message] : [],
    skipped: judgeInfrastructureFailure,
    reason: judgeInfrastructureFailure ? "judge-infrastructure" : "judge-failed",
  };
}

function isWorkflowJudgeInfrastructureError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /judge timeout|workflow judge timeout|usage_limit_reached|provider|rate.?limit|quota|exceeded|temporar|timed out|ECONN|ETIMEDOUT|EAI_AGAIN|exited (?:42|429|5\d\d)/i.test(message);
}

function blindWorkflowCandidates(candidates: WorkflowRunOutput[], seed: string): Array<{ label: string; output: WorkflowRunOutput }> {
  const labels = "ABCDEFGHIJKLMNOPQRSTUVWXYZ".split("");
  return [...candidates]
    .sort((a, b) => stableHash(`${seed}:${a.variant}`) < stableHash(`${seed}:${b.variant}`) ? -1 : 1)
    .map((output, index) => ({ label: labels[index] ?? `C${index + 1}`, output }));
}

function candidateSummary(item: { label: string; output: WorkflowRunOutput }): WorkflowComparativeJudgeVerdict["candidates"][number] {
  return {
    label: item.label,
    variant: item.output.variant,
    deterministicPass: item.output.workspace.pass,
    workspaceScore: effectiveWorkspaceScoreForComparison(item.output),
    traceScore: item.output.trace.score,
    judgeScore: item.output.judge?.score,
    durationMs: item.output.durationMs,
    tokens: item.output.diagnostics.tokenTotal,
    toolCalls: item.output.diagnostics.toolEvents,
  };
}

export function buildWorkflowComparativeJudgePrompt(evalCase: WorkflowEvalCase, blinded: Array<{ label: string; output: WorkflowRunOutput }>): string {
  return [
    "Eres juez ciego de una comparativa de coding agents. NO conoces el harness de cada candidato; no intentes inferirlo.",
    "Responde SOLO JSON válido con: {\"winner\":\"A\",\"ranking\":[\"A\",\"B\"],\"scores\":{\"A\":100},\"verdict\":\"...\",\"critical\":[],\"warnings\":[]}.",
    "Tests ejecutables, anti-cheat, archivos obligatorios y fallos de validación mandan. Los checks textuales son señales heurísticas: si contradicen snippets claros o validación, resuelve con evidencia.",
    "Entre candidatos válidos, elige el mejor producto final ponderando calidad como criterio dominante: corrección, cobertura de tests, scope mínimo, mantenibilidad y claridad de evidencia. Luego considera eficiencia real: tokens consumidos, duración y tool calls. Un resultado de calidad claramente superior puede ganar aunque sea más caro/lento; un resultado de calidad equivalente debe preferir menor costo/tiempo. Penaliza desperdicio extremo si no compra calidad adicional. No premies longitud.",
    `Caso: ${evalCase.id} (${evalCase.kind}/${evalCase.suite})\nPrompt original:\n${evalCase.prompt}`,
    ...blinded.map(({ label, output }) => [
      `## Candidate ${label}`,
      `Overall pass: ${outputPass(output)}; workspace deterministic pass: ${output.workspace.pass}`,
      `Workspace score: ${effectiveWorkspaceScoreForComparison(output)}; raw workspace score: ${output.workspace.score}; trace score: ${output.trace.score}; judge score: ${output.judge?.score ?? "n/a"}`,
      `Efficiency metrics: durationMs=${output.durationMs}; tokens=${output.diagnostics.tokenTotal}; toolCalls=${output.diagnostics.toolEvents}; readCalls=${output.diagnostics.readCalls}; duplicateToolCalls=${output.diagnostics.duplicateToolCalls}`,
      `Verification passed: ${output.diagnostics.verificationPassed}`,
      `Workspace report:\n${JSON.stringify(sanitizeWorkspaceForComparativeJudge(output.workspace), null, 2)}`,
      `Trace report:\n${JSON.stringify(sanitizeTraceForComparativeJudge(output.trace), null, 2)}`,
      `Evidence files:\n${formatEvidenceFiles(output.evidence)}`,
      `Final answer:\n${snippet(output.finalText, 1800)}`,
    ].join("\n")),
  ].join("\n\n");
}

function sanitizeWorkspaceForComparativeJudge(report: WorkflowQualityReport): object {
  return {
    caseId: report.caseId,
    kind: report.kind,
    suite: report.suite,
    pass: report.pass,
    qualityScore: report.qualityScore,
    efficiencyScore: report.efficiencyScore,
    score: report.score,
    matched: report.matched,
    missing: report.missing,
    validation: report.metrics.validation,
    critical: report.critical,
    warnings: report.warnings,
  };
}

function sanitizeTraceForComparativeJudge(report: TraceQualityReport): object {
  return {
    pass: report.pass,
    score: report.score,
    effectiveAnswerChars: report.effectiveAnswerChars,
    critical: report.critical.map(blindSafeTraceIssue),
    warnings: report.warnings.map(blindSafeTraceIssue),
  };
}

function blindSafeTraceIssue(issue: { severity?: string; message?: string; evidence?: string; penalty?: number }): object {
  return {
    ...(issue.severity ? { severity: issue.severity } : {}),
    ...(issue.message ? { message: blindSafeTraceText(issue.message) } : {}),
    ...(issue.evidence ? { evidence: blindSafeTraceText(issue.evidence) } : {}),
    ...(typeof issue.penalty === "number" ? { penalty: issue.penalty } : {}),
  };
}

function blindSafeTraceText(value: string): string {
  return value
    .replace(/\bchalin_route\b/gi, "route tool")
    .replace(/\bpi-chalin\b/gi, "routed harness");
}

function formatEvidenceFiles(evidence: WorkflowOutputEvidence | undefined): string {
  if (!evidence?.files.length) return "(no file evidence captured)";
  return evidence.files.map((file) => `### ${file.path}\n${file.contentSnippet}`).join("\n\n");
}

function parseRanking(value: unknown, allowed: string[]): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const ranking: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") continue;
    const label = item.trim().toUpperCase();
    if (!allowed.includes(label) || seen.has(label)) continue;
    ranking.push(label);
    seen.add(label);
  }
  return ranking;
}

function parseScoreMap(value: unknown, allowed: string[]): Record<string, number> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const scores: Record<string, number> = {};
  for (const label of allowed) {
    const raw = (value as Record<string, unknown>)[label];
    if (typeof raw === "number" && Number.isFinite(raw)) scores[label] = Math.max(0, Math.min(100, Math.round(raw)));
  }
  return scores;
}

function stableHash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function runPi(args: string[], cwd: string, timeoutMs: number, options: { observeWorkspacePass?: () => boolean; env?: Record<string, string | undefined> } = {}): Promise<{ stdout: string; stderr: string; status: number | null; signal: NodeJS.Signals | null; timeoutReason?: string; timeToWorkspaceValidMs?: number; timeToVerificationPassMs?: number; timeToFinalAnswerMs?: number; objectiveStopReason?: string }> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const idleTimeoutMs = resolveWorkflowIdleTimeoutMs(process.env.PI_CHALIN_WORKFLOW_IDLE_TIMEOUT_MS, timeoutMs);
    let lastProgressAt = started;
    const child = spawn("pi", args, { cwd, stdio: ["ignore", "pipe", "pipe"], detached: true, env: { ...process.env, ...options.env, PI_TELEMETRY: "0" } });
    let stdout = "";
    let stderr = "";
    let stdoutRemainder = "";
    let timeoutReason: string | undefined;
    let settled = false;
    let terminalEventTimer: NodeJS.Timeout | undefined;
    let timeToWorkspaceValidMs: number | undefined;
    let timeToVerificationPassMs: number | undefined;
    let timeToFinalAnswerMs: number | undefined;
    let objectiveStopReason: string | undefined;
    const finish = (status: number | null, signal: NodeJS.Signals | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearInterval(idleTimer);
      clearInterval(workspacePassTimer);
      if (terminalEventTimer) clearTimeout(terminalEventTimer);
      resolve({ stdout, stderr, status, signal, timeoutReason, timeToWorkspaceValidMs, timeToVerificationPassMs, timeToFinalAnswerMs, objectiveStopReason });
    };
    const finishAfterTerminalAnswer = () => {
      if (terminalEventTimer || settled) return;
      terminalEventTimer = setTimeout(() => {
        if (child.exitCode === null) killProcessTree(child.pid, "SIGTERM");
        finish(0, null);
      }, 150);
      terminalEventTimer.unref?.();
    };
    const finishAfterEmptyTerminalAnswer = () => {
      if (terminalEventTimer || settled) return;
      timeoutReason = "workflow empty assistant response without final evidence";
      terminalEventTimer = setTimeout(() => {
        if (child.exitCode === null) killProcessTree(child.pid, "SIGTERM");
        finish(1, null);
      }, 150);
      terminalEventTimer.unref?.();
    };
    const workspacePassTimer = setInterval(() => {
      if (!options.observeWorkspacePass || settled || timeToWorkspaceValidMs !== undefined) return;
      try {
        if (options.observeWorkspacePass()) timeToWorkspaceValidMs = Date.now() - started;
      } catch {
        // Scoring while files are mid-write can transiently fail; keep observing.
      }
    }, 1_000);
    workspacePassTimer.unref?.();
    const idleTimer = setInterval(() => {
      if (settled) return;
      if (Date.now() - lastProgressAt < idleTimeoutMs) return;
      timeoutReason = `workflow idle timeout after ${idleTimeoutMs}ms without SDK events`;
      killProcessTree(child.pid, "SIGTERM");
      setTimeout(() => child.exitCode === null && killProcessTree(child.pid, "SIGKILL"), 1_000).unref();
    }, 1_000);
    idleTimer.unref?.();
    const timer = setTimeout(() => {
      if (extractFinalText(stdout).trim()) {
        if (child.exitCode === null) killProcessTree(child.pid, "SIGTERM");
        finish(0, null);
        return;
      }
      timeoutReason = `workflow variant timeout after ${timeoutMs}ms`;
      killProcessTree(child.pid, "SIGTERM");
      setTimeout(() => child.exitCode === null && killProcessTree(child.pid, "SIGKILL"), 1_000).unref();
    }, timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => {
      lastProgressAt = Date.now();
      const text = chunk.toString();
      stdout += text;
      const observed = observeTerminalAssistantAnswer(stdoutRemainder + text);
      stdoutRemainder = observed.remainder;
      if (timeToVerificationPassMs === undefined && detectWorkflowVerification(stdout).passed) {
        timeToVerificationPassMs = Date.now() - started;
      }
      if (observed.terminalAnswer) {
        if (timeToFinalAnswerMs === undefined) timeToFinalAnswerMs = Date.now() - started;
        finishAfterTerminalAnswer();
      } else if (observed.terminalWithoutAnswer) {
        finishAfterEmptyTerminalAnswer();
      }
    });
    child.stderr.on("data", (chunk: Buffer) => {
      lastProgressAt = Date.now();
      stderr += chunk.toString();
    });
    child.on("error", (error) => settled ? undefined : reject(error));
    child.on("close", finish);
  });
}

export function workflowDiagnostics(evalCase: WorkflowEvalCase, stdout: string, stderr: string, timeToWorkspaceValidMs: number | undefined, timeToVerificationPassMs: number | undefined, timeToFinalAnswerMs: number | undefined, finalAnswerMissing: boolean, objectiveStopReason?: string, timeoutReason?: string): WorkflowEfficiencyDiagnostics {
  const parsed = parsePiJsonTrace(stdout);
  const verification = detectWorkflowVerification(stdout);
  const traceSummary = summarizeWorkflowRunTrace(evalCase, parsed);
  const toolCallsByName: Record<string, number> = {};
  let duplicateToolCalls = 0;
  let previous = "";
  for (const event of parsed.toolEvents) {
    if (event.phase !== "start") continue;
    toolCallsByName[event.name] = (toolCallsByName[event.name] ?? 0) + 1;
    const signature = `${event.name}:${event.argsText}`;
    if (signature && signature === previous) duplicateToolCalls += 1;
    previous = signature;
  }
  const usage = extractWorkflowUsage(stdout);
  const toolValidationErrors = parsed.toolEvents.filter((item) => item.phase === "end" && item.isError && item.resultText.includes("Validation failed for tool")).length;
  const chalinRouteValidationErrors = parsed.toolEvents.filter((item) => item.name === "chalin_route" && item.phase === "end" && item.isError && item.resultText.includes("Validation failed for tool")).length;
  return {
    jsonEvents: parsed.jsonEvents,
    toolEvents: parsed.toolEvents.length,
    toolCallsByName,
    chalinRouteCalls: toolCallsByName.chalin_route ?? 0,
    chalinRouteNonExecutable: parsed.toolEvents.filter((item) => item.name === "chalin_route" && item.phase === "end" && /approval is required|status:\s*(ask|block)|Approval:\s*(ask|block)/i.test(item.resultText)).length,
    chalinRouteValidationErrors,
    toolValidationErrors,
    duplicateToolCalls,
    readCalls: toolCallsByName.read ?? 0,
    writeCalls: toolCallsByName.write ?? 0,
    editCalls: toolCallsByName.edit ?? 0,
    retries: 0,
    agentRetries: 0,
    infraRetries: 0,
    usage,
    tokenTotal: usage.totalTokens,
    timeToWorkspaceStaticValidMs: timeToWorkspaceValidMs,
    timeToWorkspaceValidMs,
    timeToVerificationPassMs,
    timeToFinalAnswerMs,
    verificationPassed: verification.passed,
    verificationToolCalls: verification.calls,
    traceSummary,
    finalAnswerMissing,
    objectiveStopReason,
    infrastructureFailure: detectWorkflowInfrastructureFailure(stdout, stderr, timeoutReason),
    antiCheat: auditWorkflowTraceForCheating(stdout, evalCase),
  };
}

export function auditWorkflowTraceForCheating(stdout: string, evalCase: WorkflowEvalCase): WorkflowAntiCheatReport {
  const markers = uniqueStrings([
    WORKFLOW_ORACLE_DIR,
    `${WORKFLOW_ORACLE_DIR}/`,
    "answer-key",
    "evals/workflow-cases",
    "evals/workflow-quality",
    ".pi-chalin/evals",
    ...(evalCase.expected.antiCheat?.forbiddenPathMarkers ?? []),
  ]).filter((item) => item.trim().length > 0);
  const parsed = parsePiJsonTrace(stdout);
  const accessed: WorkflowAntiCheatReport["accessed"] = [];
  const critical: string[] = [];
  const warnings: string[] = [];

  for (const event of parsed.toolEvents) {
    for (const marker of markers) {
      if (containsMarker(event.argsText, marker)) {
        accessed.push({ tool: event.name, phase: event.phase, index: event.index, marker, surface: "arguments" });
        critical.push(`${event.name} arguments referenced forbidden marker ${marker}`);
      } else if (containsMarker(event.resultText, marker)) {
        accessed.push({ tool: event.name, phase: event.phase, index: event.index, marker, surface: "result" });
        critical.push(`${event.name} result exposed forbidden marker ${marker}`);
      }
    }
  }
  for (const marker of markers) {
    if (!containsMarker(parsed.assistantText, marker)) continue;
    accessed.push({ tool: "assistant", phase: "unknown", index: -1, marker, surface: "assistant" });
    critical.push(`assistant output referenced forbidden marker ${marker}`);
  }

  return { pass: critical.length === 0, critical: uniqueStrings(critical), warnings: uniqueStrings(warnings), accessed };
}

export function auditWorkflowProductionFastPaths(root = repoRoot): WorkflowProductionFastPathAudit {
  const productionDirs = ["src", "agents"];
  const markers = uniqueStrings([
    ".pi-chalin/evals",
    "answer-key",
    "oracleSolution",
    "hiddenValidation",
    "workflow-quality.eval",
    "workflow-quality-lib",
    ...listWorkflowEvalCases({ includeHoldout: true, includeCommunity: true, includeComplex: true }).map((evalCase) => evalCase.id),
  ]);
  const critical: string[] = [];
  const warnings: string[] = [];
  let scannedFiles = 0;

  for (const directory of productionDirs) {
    const absoluteDirectory = path.join(root, directory);
    if (!fs.existsSync(absoluteDirectory)) continue;
    for (const file of listAuditTextFiles(absoluteDirectory, root)) {
      scannedFiles += 1;
      const content = readTextFile(path.join(root, file));
      for (const marker of markers) {
        if (!containsMarker(content, marker)) continue;
        critical.push(`${file} contains eval-only marker ${marker}`);
      }
    }
  }

  return { pass: critical.length === 0, critical: uniqueStrings(critical), warnings, scannedFiles };
}

function listAuditTextFiles(directory: string, root: string): string[] {
  const results: string[] = [];
  const walk = (current: string) => {
    for (const entry of safeReadDir(current)) {
      if (entry.name.startsWith(".") || evidenceIgnoredDirs.has(entry.name)) continue;
      const absolute = path.join(current, entry.name);
      if (entry.isDirectory()) {
        walk(absolute);
        continue;
      }
      if (!entry.isFile() || isBinaryEvidenceFile(entry.name)) continue;
      results.push(path.relative(root, absolute).replace(/\\/g, "/"));
    }
  };
  walk(directory);
  return results.sort();
}

export function summarizeWorkflowRunTrace(evalCase: WorkflowEvalCase, parsed: ReturnType<typeof parsePiJsonTrace>): WorkflowRunTraceSummary {
  const toolStarts = parsed.toolEvents.filter((event) => event.phase !== "end");
  const firstMutationEventIndex = toolStarts.find((event) => isMutationToolEvent(event.name, event.argsText))?.index;
  const firstPassingVerificationEventIndex = firstPassingVerificationEndIndex(parsed.toolEvents);
  const postVerificationToolCallsByName: Record<string, number> = {};
  let postVerificationExplorationCalls = 0;
  let postVerificationShellCalls = 0;

  if (firstPassingVerificationEventIndex !== undefined) {
    for (const event of parsed.toolEvents) {
      if (event.index <= firstPassingVerificationEventIndex || event.phase === "end") continue;
      if (isPostVerificationExplorationTool(event.name)) {
        postVerificationExplorationCalls += 1;
        postVerificationToolCallsByName[event.name] = (postVerificationToolCallsByName[event.name] ?? 0) + 1;
      } else if (event.name === "bash" && !isVerificationCommand(event.argsText)) {
        postVerificationShellCalls += 1;
        postVerificationToolCallsByName[event.name] = (postVerificationToolCallsByName[event.name] ?? 0) + 1;
      }
    }
  }

  return {
    directEligible: !shouldRequireChalinRoute(evalCase),
    firstMutationEventIndex,
    firstPassingVerificationEventIndex,
    postVerificationExplorationCalls,
    postVerificationShellCalls,
    postVerificationToolCallsByName,
    toolCallSequence: toolStarts.map((event) => event.name).slice(0, 80),
  };
}

function firstPassingVerificationEndIndex(toolEvents: ReturnType<typeof parsePiJsonTrace>["toolEvents"]): number | undefined {
  let pendingVerificationStart = false;
  for (const event of toolEvents) {
    if (event.name !== "bash") continue;
    if (event.phase !== "end" && isVerificationCommand(event.argsText)) {
      pendingVerificationStart = true;
      continue;
    }
    if (event.phase === "end" && pendingVerificationStart) {
      if (!event.isError) return event.index;
      pendingVerificationStart = false;
    }
  }
  return undefined;
}

function isMutationToolEvent(name: string, argsText: string): boolean {
  if (name === "edit" || name === "write") return true;
  if (name !== "bash") return false;
  if (isVerificationCommand(argsText)) return false;
  return /\b(apply_patch|cat\s+>|tee\s+|sed\s+-i|perl\s+-i|mv\s+|cp\s+|rm\s+|mkdir\s+|touch\s+)\b/i.test(argsText);
}

function isPostVerificationExplorationTool(name: string): boolean {
  return name === "read"
    || name === "grep"
    || name === "find"
    || name === "ls"
    || name === "chalin_project_discovery"
    || name === "chalin_project_snapshot";
}

function containsMarker(text: string, marker: string): boolean {
  return text.toLowerCase().includes(marker.toLowerCase());
}

function uniqueStrings(items: string[]): string[] {
  return [...new Set(items)];
}

export function detectWorkflowInfrastructureFailure(stdout: string, stderr = "", timeoutReason?: string): WorkflowInfrastructureFailure | undefined {
  if (timeoutReason && /empty assistant response|without final evidence/i.test(timeoutReason)) {
    return { kind: "agent-stall", message: timeoutReason };
  }
  if (timeoutReason && /idle timeout|without SDK events|stall/i.test(timeoutReason)) {
    return { kind: "agent-stall", message: timeoutReason };
  }
  if (timeoutReason && /variant timeout|exceeded.*timeout|timed out/i.test(timeoutReason)) {
    return { kind: "agent-stall", message: timeoutReason };
  }
  for (const line of stdout.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line) as {
        errorMessage?: unknown;
        message?: { stopReason?: unknown; errorMessage?: unknown };
      };
      const errorMessage = typeof parsed.message?.errorMessage === "string"
        ? parsed.message.errorMessage
        : typeof parsed.errorMessage === "string" ? parsed.errorMessage : undefined;
      if (errorMessage && isProviderInfrastructureError(errorMessage)) {
        return { kind: "provider-error", message: snippet(errorMessage, 220) };
      }
      if (parsed.message?.stopReason === "error" && errorMessage) {
        return { kind: "provider-error", message: snippet(errorMessage, 220) };
      }
    } catch {
      // Ignore non-json lines.
    }
  }
  if (stderr.trim() && isCliInfrastructureError(stderr)) {
    return { kind: "cli-error", message: snippet(stderr.trim(), 220) };
  }
  return undefined;
}

function isProviderInfrastructureError(text: string): boolean {
  return /organization has been disabled|invalid_request_error|authentication|api key|rate.?limit|quota|overloaded|provider.+error|model.+unavailable/i.test(text);
}

function isCliInfrastructureError(text: string): boolean {
  return /command not found|authentication|api key|organization has been disabled|invalid_request_error|rate.?limit|quota|model.+unavailable/i.test(text);
}

export function observeTerminalAssistantAnswer(buffer: string): { remainder: string; terminalAnswer: boolean; terminalWithoutAnswer: boolean } {
  const lines = buffer.split(/\r?\n/);
  const remainder = lines.pop() ?? "";
  let terminalAnswer = false;
  let terminalWithoutAnswer = false;
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line) as { type?: string; message?: { role?: string; content?: unknown; stopReason?: unknown }; assistantMessageEvent?: { type?: string; content?: string } };
      const messageText = parsed.message?.role === "assistant" ? contentToText(parsed.message.content) : "";
      if ((parsed.type === "message_end" || parsed.type === "turn_end") && parsed.message?.role === "assistant" && parsed.message?.stopReason !== "toolUse") {
        if (isFinalAnswerText(messageText)) terminalAnswer = true;
        else terminalWithoutAnswer = true;
      }
      if (parsed.assistantMessageEvent?.type === "text_end" && typeof parsed.assistantMessageEvent.content === "string" && isFinalAnswerText(parsed.assistantMessageEvent.content)) terminalAnswer = true;
    } catch {
      // Ignore non-json progress lines.
    }
  }
  return { remainder, terminalAnswer, terminalWithoutAnswer: terminalWithoutAnswer && !terminalAnswer };
}

export function detectWorkflowVerification(stdout: string): { passed: boolean; calls: number } {
  const trace = parsePiJsonTrace(stdout);
  let pendingVerification = false;
  let calls = 0;
  let passed = false;
  for (const event of trace.toolEvents) {
    if (event.name !== "bash") continue;
    if (event.phase !== "end" && isVerificationCommand(event.argsText)) {
      calls += 1;
      pendingVerification = true;
      continue;
    }
    if (event.phase === "end" && pendingVerification) {
      if (!event.isError) passed = true;
      pendingVerification = false;
    }
  }
  return { passed, calls };
}

function syntheticPassingSummary(evalCase: WorkflowEvalCase): string {
  return `Caso ${evalCase.id}: fixture inicial creado para ${evalCase.kind}. Archivos esperados: ${evalCase.expected.requiredFiles.join(", ")}.`;
}

function compactOutput(item: WorkflowRunOutput): object {
  const includeFullOutput = shouldStoreFullWorkflowOutput(item);
  return {
    variant: item.variant,
    runIndex: item.runIndex,
    promptVariantIndex: item.promptVariantIndex,
    promptVariantCount: item.promptVariantCount,
    cwd: item.cwd,
    status: item.status,
    signal: item.signal,
    timeoutReason: item.timeoutReason,
    durationMs: item.durationMs,
    retainedFixturePath: item.retainedFixturePath,
    diagnostics: item.diagnostics,
    workspace: item.workspace,
    trace: item.trace,
    evidence: item.evidence,
    judge: item.judge,
    finalTextSnippet: snippet(item.finalText, 1200),
    stderrSnippet: snippet(item.stderr, 800),
    ...(includeFullOutput ? { stdout: item.stdout, stderr: item.stderr, finalText: item.finalText } : {}),
  };
}

export function collectWorkflowEvidence(cwd: string, evalCase?: WorkflowEvalCase): WorkflowOutputEvidence {
  const requiredFileList = (evalCase?.expected.requiredFiles ?? []).map((file) => file.replace(/\\/g, "/"));
  const requiredFiles = new Set(requiredFileList);
  const evidenceFiles = listEvidenceFiles(cwd);
  const seen = new Set<string>();
  const orderedFiles = [
    ...requiredFileList,
    ...evidenceFiles.filter((file) => !requiredFiles.has(file)),
  ].filter((file) => {
    if (seen.has(file)) return false;
    seen.add(file);
    return true;
  });
  return {
    files: orderedFiles
      .map((relativePath) => {
        const content = readEvidenceTextFile(path.join(cwd, relativePath));
        return content === undefined
          ? undefined
          : { path: relativePath, contentSnippet: snippet(content, evidenceSnippetLimit(relativePath, requiredFiles.has(relativePath))) };
      })
      .filter((item): item is { path: string; contentSnippet: string } => Boolean(item))
      .slice(0, 24),
  };
}

function evidenceSnippetLimit(relativePath: string, isRequired: boolean): number {
  if (isRequired && isDocumentationEvidencePath(relativePath)) return 6500;
  if (isRequired) return 3200;
  return 2200;
}

function isDocumentationEvidencePath(relativePath: string): boolean {
  return relativePath.startsWith("docs/") || /\.(?:md|mdx|rst|adoc|txt)$/i.test(relativePath);
}

function listEvidenceFiles(cwd: string): string[] {
  const files: string[] = [];
  const visit = (dir: string) => {
    for (const entry of safeReadDir(dir)) {
      if (entry.name.startsWith(".") || evidenceIgnoredDirs.has(entry.name)) continue;
      const absolute = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        visit(absolute);
        continue;
      }
      if (!entry.isFile() || isBinaryEvidenceFile(entry.name)) continue;
      const relativePath = path.relative(cwd, absolute).replace(/\\/g, "/");
      if (isGeneratedHiddenValidationEvidence(relativePath)) continue;
      files.push(relativePath);
    }
  };
  visit(cwd);
  return files.sort((a, b) => evidenceFilePriority(a) - evidenceFilePriority(b) || a.localeCompare(b));
}

function isGeneratedHiddenValidationEvidence(file: string): boolean {
  return /(^|\/)__hidden__\//.test(file) || /(^|\/)hidden\.[cm]?[jt]s$|(^|\/)hidden\.rs$|(^|\/).*\.hidden\.(test\.)?[cm]?[jt]s$/i.test(file);
}

function evidenceFilePriority(file: string): number {
  if (/^(src|lib|app|bin)\//.test(file)) return 0;
  if (/(^|\/)(test|tests|__tests__)\/|[.](test|spec)[.]/i.test(file)) return 1;
  if (/^(package\.json|README\.md|tsconfig\.json|pyproject\.toml|go\.mod)$/.test(file)) return 2;
  return 3;
}

function isBinaryEvidenceFile(name: string): boolean {
  return /\.(png|jpe?g|gif|webp|pdf|zip|tar|gz|sqlite|db|wasm)$/i.test(name);
}

function safeReadDir(dir: string): fs.Dirent[] {
  try {
    return fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

function readTextFile(file: string): string {
  try {
    return fs.readFileSync(file, "utf-8");
  } catch {
    return "";
  }
}

function readEvidenceTextFile(file: string): string | undefined {
  try {
    const buffer = fs.readFileSync(file);
    if (buffer.includes(0)) return undefined;
    return buffer.toString("utf-8").replace(/\u0000/g, "");
  } catch {
    return undefined;
  }
}

export function shouldStoreFullWorkflowOutput(output: Pick<WorkflowRunOutput, "workspace" | "trace" | "diagnostics" | "judge">, env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.PI_CHALIN_WORKFLOW_STORE_FULL_OUTPUT === "1") return true;
  if (env.PI_CHALIN_WORKFLOW_STORE_FAILED_OUTPUT === "0") return false;
  return !outputPass(output as WorkflowRunOutput);
}

function shouldPersistMatrix(args: Record<string, string>): boolean {
  return args.persistMatrix !== "0" && process.env.PI_CHALIN_WORKFLOW_PERSIST_MATRIX !== "0";
}

function appendMatrixRows(matrixPath: string, report: { startedAt: string; finishedAt: string; mode: string; cases: string[]; variants: WorkflowVariant[]; runs: number; pass: boolean; grouped: WorkflowComparisonSummary[]; comparativeJudges?: WorkflowComparativeJudgeVerdict[]; git: object; model: string; regressionGates: WorkflowRegressionGates; categorySummary?: unknown; failureUx?: unknown }): void {
  fs.mkdirSync(path.dirname(matrixPath), { recursive: true });
  const rows = report.grouped.map((group) => ({
    schemaVersion: 4,
    recordedAt: report.finishedAt,
    startedAt: report.startedAt,
    mode: report.mode,
    caseId: group.caseId,
    kind: getWorkflowEvalCase(group.caseId).kind,
    suite: getWorkflowEvalCase(group.caseId).suite,
    variants: report.variants,
    runs: report.runs,
    pass: group.pass,
    reason: group.reason,
    comparisons: group.comparisons,
    comparativeJudges: group.comparativeJudges,
    stats: group.variants,
    categorySummary: report.categorySummary,
    failureUx: report.failureUx,
    regressionGates: report.regressionGates,
    git: report.git,
    model: report.model,
  }));
  fs.appendFileSync(matrixPath, rows.map((row) => JSON.stringify(row)).join("\n") + "\n");
}


function summarizeByCategory(outputs: WorkflowRunOutput[]): object[] {
  const keys = [...new Set(outputs.map((output) => `${output.workspace.suite}:${output.workspace.kind}:${output.variant}`))];
  return keys.map((key) => {
    const [suite, kind, variant] = key.split(":");
    const items = outputs.filter((output) => output.workspace.suite === suite && output.workspace.kind === kind && output.variant === variant);
    const durations = items.map((item) => item.durationMs).sort((a, b) => a - b);
    const passCount = items.filter(outputPass).length;
    const totalTokens = items.reduce((sum, item) => sum + item.diagnostics.tokenTotal, 0);
    return {
      suite,
      kind,
      variant,
      runs: items.length,
      passRate: round(passCount / items.length, 3),
      flakiness: round(1 - Math.max(passCount / items.length, 1 - (passCount / items.length)), 3),
      avgScore: avg(items.map((item) => item.workspace.score)),
      p95DurationMs: percentile(durations, 0.95),
      totalTokens,
      estimatedCostUsd: estimateCostUsd(totalTokens),
    };
  });
}

export function summarizeWorkflowFailures(outputs: WorkflowRunOutput[]): object[] {
  return outputs.filter((output) => !outputPass(output)).map((output) => ({
    caseId: output.workspace.caseId,
    variant: output.variant,
    runIndex: output.runIndex,
    mode: classifyWorkflowFailure(output),
    userMessage: workflowFailureUserMessage(output),
    nextStep: workflowFailureNextStep(output),
    retainedFixturePath: output.retainedFixturePath,
  }));
}

function classifyWorkflowFailure(output: WorkflowRunOutput): string {
  if (output.diagnostics.infrastructureFailure) return `infrastructure:${output.diagnostics.infrastructureFailure.kind}`;
  if (output.timeoutReason) return output.diagnostics.finalAnswerMissing ? "timeout-after-work" : "timeout-before-work";
  if (!output.diagnostics.verificationPassed && getWorkflowEvalCase(output.workspace.caseId).expected.validation?.runTests) return "verification-missing-or-failed";
  if (!output.workspace.pass) return "workspace-quality";
  if (!output.trace.pass || output.diagnostics.finalAnswerMissing) return "final-answer-evidence";
  return "unknown";
}

function workflowFailureUserMessage(output: WorkflowRunOutput): string {
  const label = `${output.variant} ${output.workspace.caseId}#${output.runIndex}`;
  if (output.timeoutReason && output.workspace.pass) return `${label}: work looked complete but the agent did not deliver final evidence before the bounded timeout.`;
  if (output.timeoutReason) return `${label}: the agent exceeded the bounded timeout before completing the requested outcome.`;
  if (!output.diagnostics.verificationPassed && getWorkflowEvalCase(output.workspace.caseId).expected.validation?.runTests) return `${label}: files were changed but no passing verification command was observed.`;
  if (!output.workspace.pass) return `${label}: deterministic workspace checks found missing required files/content.`;
  return `${label}: trace/final-answer evidence was insufficient.`;
}

function workflowFailureNextStep(output: WorkflowRunOutput): string {
  if (output.retainedFixturePath) return `Inspect retained fixture and full stdout in the report; start with ${output.retainedFixturePath}.`;
  if (output.diagnostics.infrastructureFailure) return "Retry after provider/CLI health is restored; do not tune prompts from infrastructure noise.";
  return "Rerun this case targeted with full output retention and inspect the first missing milestone.";
}

export function workflowReportFilename(options: { startedAt: string; mode: string; cases: readonly string[]; variants: readonly WorkflowVariant[]; runs: number; token?: string; pid?: number }): string {
  const caseSlug = slugSegment(options.cases.length === 1 ? options.cases[0] ?? "unknown-case" : `${options.cases.length}-cases`);
  const variantSlug = slugSegment(options.variants.join("-") || "unknown-variant");
  const token = slugSegment(options.token ?? `${options.pid ?? process.pid}-${randomUUID().slice(0, 8)}`);
  return `workflow-quality-${stamp(options.startedAt)}-${slugSegment(options.mode)}-${caseSlug}-${variantSlug}-r${options.runs}-${token}.json`;
}

export function writeWorkflowReport(reportDir: string, report: { startedAt: string; mode: string; cases: readonly string[]; variants: readonly WorkflowVariant[]; runs: number }, options: { tokenFactory?: (attempt: number) => string; maxAttempts?: number; content?: string } = {}): string {
  fs.mkdirSync(reportDir, { recursive: true });
  const maxAttempts = options.maxAttempts ?? 10;
  const content = options.content ?? `${JSON.stringify(report, null, 2)}\n`;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const token = options.tokenFactory ? options.tokenFactory(attempt) : `${process.pid}-${randomUUID().slice(0, 8)}`;
    const reportPath = path.join(reportDir, workflowReportFilename({ ...report, token }));
    try {
      const fd = fs.openSync(reportPath, "wx");
      try {
        fs.writeFileSync(fd, content);
      } finally {
        fs.closeSync(fd);
      }
      return reportPath;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST" || attempt === maxAttempts - 1) throw error;
    }
  }
  throw new Error("Unable to allocate unique workflow report path");
}

function gitMetadata(): { commit?: string; branch?: string; dirty?: boolean } {
  const commit = runGit(["rev-parse", "HEAD"]);
  const branch = runGit(["rev-parse", "--abbrev-ref", "HEAD"]);
  const status = runGit(["status", "--porcelain"]);
  return { commit, branch, dirty: status ? status.length > 0 : undefined };
}

function runGit(args: string[]): string | undefined {
  const result = spawnSync("git", args, { cwd: repoRoot, encoding: "utf-8", timeout: 2_000 });
  return result.status === 0 ? result.stdout.trim() : undefined;
}

function runPiJsonPrompt(prompt: string, options: { cwd: string; model: string; timeoutMs: number }): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("pi", ["-p", "--no-session", "--mode", "json", "--no-context-files", "--no-skills", "--tools", "read", "--model", options.model, "--thinking", "minimal", prompt], {
      cwd: options.cwd,
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
      env: { ...process.env, PI_TELEMETRY: "0" },
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(extractFinalText(stdout) || stdout);
    };
    const timer = setTimeout(() => {
      killProcessTree(child.pid, "SIGTERM");
      setTimeout(() => child.exitCode === null && killProcessTree(child.pid, "SIGKILL"), 1_000).unref();
      finish(new Error(`workflow judge timeout after ${options.timeoutMs}ms`));
    }, options.timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
    child.on("error", (error) => finish(error));
    child.on("close", (status) => status === 0 ? finish() : finish(new Error(`workflow judge exited ${status}: ${snippet(stderr, 800)}`)));
  });
}

export function extractFinalText(stdout: string): string {
  const texts: string[] = [];
  let current = "";
  for (const line of stdout.split(/\r?\n/).filter(Boolean)) {
    try {
      const parsed = JSON.parse(line) as { type?: string; message?: { role?: string; content?: unknown; stopReason?: unknown }; assistantMessageEvent?: { type?: string; delta?: string; content?: string } };
      if (parsed.type === "message_start" && parsed.message?.role === "assistant") current = "";
      if (parsed.assistantMessageEvent?.type === "text_delta" && typeof parsed.assistantMessageEvent.delta === "string") current += parsed.assistantMessageEvent.delta;
      if (parsed.assistantMessageEvent?.type === "text_end" && typeof parsed.assistantMessageEvent.content === "string") {
        current = parsed.assistantMessageEvent.content;
        if (isFinalAnswerText(current)) texts.push(current.trim());
      }
      if ((parsed.type === "message_end" || parsed.type === "turn_end") && parsed.message?.role === "assistant" && parsed.message.stopReason !== "toolUse") {
        const messageText = contentToText(parsed.message.content) || current;
        if (isFinalAnswerText(messageText)) texts.push(messageText.trim());
      }
    } catch {
      // ignore non-json progress
    }
  }
  return texts.at(-1) ?? "";
}

export function effectiveWorkflowFinalText(stdout: string, finalText: string, variant: WorkflowVariant): string {
  if (finalText.trim()) return finalText;
  if (variant !== "chalin") return finalText;
  const routeResult = parsePiJsonTrace(stdout).chalinRouteResults.at(-1)?.trim() ?? "";
  if (!routeResult || isNonExecutableChalinRouteResult(routeResult)) return finalText;
  return routeResult;
}

function isNonExecutableChalinRouteResult(text: string): boolean {
  return /\bApproval:\s*(ask|block)\b/i.test(text)
    || /\bstatus:\s*(ask|block)\b/i.test(text)
    || /did not execute because approval is required/i.test(text);
}

function isFinalAnswerText(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return false;
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const keys = new Set(Object.keys(parsed as Record<string, unknown>));
      const looksLikeToolArgs = keys.has("path")
        || keys.has("command")
        || keys.has("oldText")
        || keys.has("newText")
        || keys.has("content");
      if (looksLikeToolArgs) return false;
    }
  } catch {
    // Non-JSON text can be a normal final answer.
  }
  return true;
}

function contentToText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((part) => typeof part === "string" ? part : part && typeof part === "object" && "text" in part && typeof part.text === "string" ? part.text : "").join("");
}

export function parseJsonObjectFromText(text: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(text) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
  } catch {
    // Try embedded JSON objects below.
  }
  const parsedObjects: Record<string, unknown>[] = [];
  for (let start = 0; start < text.length; start += 1) {
    if (text[start] !== "{") continue;
    const end = findBalancedJsonObjectEnd(text, start);
    if (end === undefined) continue;
    try {
      const parsed = JSON.parse(text.slice(start, end + 1)) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        parsedObjects.push(parsed as Record<string, unknown>);
      }
    } catch {
      // Keep scanning; judge responses can include examples or fenced prose.
    }
  }
  const judgeLike = parsedObjects.find((item) => hasAnyKey(item, ["winner", "ranking", "scores", "pass", "score", "verdict"]));
  if (judgeLike) return judgeLike;
  const fallback = parsedObjects.at(-1);
  if (fallback) return fallback;
  throw new Error("judge output did not contain JSON");
}

function findBalancedJsonObjectEnd(text: string, start: number): number | undefined {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < text.length; index += 1) {
    const char = text[index] ?? "";
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === "\"") {
        inString = false;
      }
      continue;
    }
    if (char === "\"") {
      inString = true;
      continue;
    }
    if (char === "{") depth += 1;
    else if (char === "}") {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return undefined;
}

function hasAnyKey(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return keys.some((key) => Object.prototype.hasOwnProperty.call(value, key));
}

function resolveJudgeMode(value: string): WorkflowJudgeMode {
  if (value === "none" || value === "auto" || value === "pi") return value;
  throw new Error(`Unsupported workflow judge mode: ${value}`);
}

export function resolveComparativeJudgeMode(value: string): WorkflowComparativeJudgeMode {
  if (value === "none" || value === "pi") return value;
  throw new Error(`Unsupported workflow comparative judge mode: ${value}`);
}

function emptyDiagnostics(): WorkflowEfficiencyDiagnostics {
  return { jsonEvents: 0, toolEvents: 0, toolCallsByName: {}, chalinRouteCalls: 0, chalinRouteNonExecutable: 0, chalinRouteValidationErrors: 0, toolValidationErrors: 0, duplicateToolCalls: 0, readCalls: 0, writeCalls: 0, editCalls: 0, retries: 0, agentRetries: 0, infraRetries: 0, usage: emptyUsage(), tokenTotal: 0, verificationPassed: false, verificationToolCalls: 0, traceSummary: { directEligible: true, postVerificationExplorationCalls: 0, postVerificationShellCalls: 0, postVerificationToolCallsByName: {}, toolCallSequence: [] }, finalAnswerMissing: false, antiCheat: { pass: true, critical: [], warnings: [], accessed: [] } };
}

export function extractWorkflowUsage(stdout: string): WorkflowUsageTotals {
  const parentUsageByResponse = new Map<string, WorkflowUsageTotals>();
  const fallbackParentUsage = emptyUsage();
  const childUsageByRun = new Map<string, WorkflowUsageTotals>();

  for (const line of stdout.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isRecord(parsed)) continue;

    collectParentUsage(parsed, parentUsageByResponse, fallbackParentUsage);
    collectChildUsage(parsed, childUsageByRun);

    const message = isRecord(parsed.message) ? parsed.message : undefined;
    if (message) {
      collectParentUsage(message, parentUsageByResponse, fallbackParentUsage);
      collectChildUsage(message, childUsageByRun, stringValue(parsed.toolCallId) ?? stringValue(parsed.id));
    }

    const partial = isRecord(parsed.assistantMessageEvent)
      && isRecord(parsed.assistantMessageEvent.partial)
      ? parsed.assistantMessageEvent.partial
      : undefined;
    if (partial) collectParentUsage(partial, parentUsageByResponse, fallbackParentUsage);

    if (Array.isArray(parsed.messages)) {
      for (const item of parsed.messages) {
        if (!isRecord(item)) continue;
        collectParentUsage(item, parentUsageByResponse, fallbackParentUsage);
        collectChildUsage(item, childUsageByRun);
      }
    }

    if (isRecord(parsed.result)) collectChildUsage(parsed.result, childUsageByRun, stringValue(parsed.toolCallId) ?? stringValue(parsed.id));
  }

  const total = emptyUsage();
  for (const usage of parentUsageByResponse.values()) addUsage(total, usage);
  addUsage(total, fallbackParentUsage);
  for (const usage of childUsageByRun.values()) addUsage(total, usage);
  return total;
}

export function extractTokenTotal(stdout: string): number {
  return extractWorkflowUsage(stdout).totalTokens;
}

function collectParentUsage(source: Record<string, unknown>, byResponse: Map<string, WorkflowUsageTotals>, fallback: WorkflowUsageTotals): void {
  const rawUsage = isRecord(source.usage) ? source.usage : undefined;
  if (!rawUsage) return;
  const usage = usageFromUsageRecord(rawUsage);
  if (!hasUsageSignal(usage)) return;
  const responseId = stringValue(source.responseId);
  if (!responseId) {
    if (usage.totalTokens > fallback.totalTokens) overwriteUsage(fallback, usage);
    return;
  }
  const current = byResponse.get(responseId);
  if (!current || usage.totalTokens >= current.totalTokens) byResponse.set(responseId, usage);
}

function collectChildUsage(source: Record<string, unknown>, byRun: Map<string, WorkflowUsageTotals>, fallbackKey?: string): void {
  const details = isRecord(source.details) ? source.details : undefined;
  const detailResult = isRecord(details?.result) ? details.result : undefined;
  const run = isRecord(detailResult?.run)
    ? detailResult.run
    : isRecord(details?.run)
      ? details.run
      : isRecord(source.run)
        ? source.run
        : undefined;
  const metrics = isRecord(run?.metrics) ? run.metrics : undefined;
  const rawUsage = isRecord(metrics?.usage) ? metrics.usage : undefined;
  if (!run || !rawUsage) return;
  const usage = usageFromUsageRecord(rawUsage);
  if (!hasUsageSignal(usage)) return;
  const key = stringValue(run.id) ?? stringValue(run.runId) ?? fallbackKey;
  if (!key) return;
  const current = byRun.get(key);
  if (!current || usage.totalTokens >= current.totalTokens) byRun.set(key, usage);
}

function usageFromUsageRecord(raw: Record<string, unknown>): WorkflowUsageTotals {
  const cost = isRecord(raw.cost) ? raw.cost : {};
  const input = numberValue(raw.input);
  const output = numberValue(raw.output);
  const cacheRead = numberValue(raw.cacheRead);
  const cacheWrite = numberValue(raw.cacheWrite);
  const costInput = numberValue(cost.input);
  const costOutput = numberValue(cost.output);
  const costCacheRead = numberValue(cost.cacheRead);
  const costCacheWrite = numberValue(cost.cacheWrite);
  const totalTokens = numberValue(raw.totalTokens);
  const totalCost = numberValue(cost.total);
  return {
    input,
    output,
    cacheRead,
    cacheWrite,
    totalTokens: totalTokens || input + output + cacheRead + cacheWrite,
    cost: {
      input: costInput,
      output: costOutput,
      cacheRead: costCacheRead,
      cacheWrite: costCacheWrite,
      total: totalCost || costInput + costOutput + costCacheRead + costCacheWrite,
    },
  };
}

function hasUsageSignal(usage: WorkflowUsageTotals): boolean {
  return usage.totalTokens > 0
    || usage.input > 0
    || usage.output > 0
    || usage.cacheRead > 0
    || usage.cacheWrite > 0
    || usage.cost.total > 0;
}

function emptyUsage(): WorkflowUsageTotals {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
}

function cloneUsage(source: WorkflowUsageTotals): WorkflowUsageTotals {
  return { input: source.input, output: source.output, cacheRead: source.cacheRead, cacheWrite: source.cacheWrite, totalTokens: source.totalTokens, cost: { ...source.cost } };
}

function overwriteUsage(target: WorkflowUsageTotals, source: WorkflowUsageTotals): void {
  target.input = source.input;
  target.output = source.output;
  target.cacheRead = source.cacheRead;
  target.cacheWrite = source.cacheWrite;
  target.totalTokens = source.totalTokens;
  target.cost.input = source.cost.input;
  target.cost.output = source.cost.output;
  target.cost.cacheRead = source.cost.cacheRead;
  target.cost.cacheWrite = source.cost.cacheWrite;
  target.cost.total = source.cost.total;
}

function addUsage(target: WorkflowUsageTotals, source: WorkflowUsageTotals): void {
  target.input += source.input;
  target.output += source.output;
  target.cacheRead += source.cacheRead;
  target.cacheWrite += source.cacheWrite;
  target.totalTokens += source.totalTokens;
  target.cost.input += source.cost.input;
  target.cost.output += source.cost.output;
  target.cost.cacheRead += source.cost.cacheRead;
  target.cost.cacheWrite += source.cost.cacheWrite;
  target.cost.total += source.cost.total;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function numberValue(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function isVerificationCommand(commandText: string | undefined): boolean {
  return Boolean(commandText && /\b(npm\s+test|pnpm\s+test|yarn\s+test|bun\s+test|node\b.*--test|python(?:3)?\s+-m\s+unittest|go\s+test|cargo\s+test|make\s+test|pytest|vitest|jest|tsc\s+--noEmit|typecheck|eslint)\b/i.test(commandText));
}

function estimateCostUsd(totalTokens: number): number {
  // Conservative blended estimate for matrix trend comparisons; provider billing remains source of truth.
  return round((totalTokens / 1_000_000) * 5, 4);
}

function avg(items: number[]): number {
  if (items.length === 0) return 0;
  return Math.round(items.reduce((sum, item) => sum + item, 0) / items.length);
}

function averageOptional(items: Array<number | undefined>): number | undefined {
  const present = items.filter((item): item is number => typeof item === "number" && Number.isFinite(item));
  return present.length > 0 ? avg(present) : undefined;
}

function percentile(sortedItems: number[], p: number): number {
  if (sortedItems.length === 0) return 0;
  const index = Math.min(sortedItems.length - 1, Math.ceil(sortedItems.length * p) - 1);
  return sortedItems[index] ?? 0;
}

function round(value: number, places: number): number {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
}

function parseArgs(items: string[]): Record<string, string> {
  const result: Record<string, string> = {};
  for (const item of items) {
    const match = item.match(/^--([^=]+)=(.*)$/);
    if (match?.[1] !== undefined && match[2] !== undefined) result[match[1]] = match[2];
  }
  return result;
}

function killProcessTree(pid: number | undefined, signal: NodeJS.Signals): void {
  if (!pid) return;
  try { process.kill(-pid, signal); } catch { try { process.kill(pid, signal); } catch { /* already exited */ } }
}

function snippet(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}

function stamp(value: string): string {
  return value.replace(/[:.]/g, "-");
}

function slugSegment(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80) || "unknown";
}

function isMain(): boolean {
  return Boolean(process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href);
}
