#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createWorkflowFixture, getWorkflowEvalCase, listWorkflowEvalCases, listWorkflowHoldoutCases, type WorkflowEvalCase } from "./workflow-cases.ts";
import { scoreWorkflowWorkspace, type WorkflowQualityReport } from "../src/workflow-quality.ts";
import { gradePiTrace, parsePiJsonTrace, type TraceQualityReport, type TraceVariant } from "../src/trace-quality.ts";
import { DEFAULT_JUDGE_MODEL, resolveJudgeTimeoutMs } from "./trace-quality.eval.ts";

export type WorkflowVariant = "simple" | "mesh";
export type WorkflowJudgeMode = "none" | "auto" | "pi";

export const DEFAULT_WORKFLOW_TIMEOUT_MS = 45_000;
export const MAX_WORKFLOW_TIMEOUT_MS = 60_000;
export const DEFAULT_WORKFLOW_RUNS = 1;
export const MAX_WORKFLOW_RUNS = 5;
export const DEFAULT_MAX_INTERACTIVE_SDK_WALL_MS = 120_000;
export const DEFAULT_WORKFLOW_IDLE_TIMEOUT_MS = 25_000;

interface WorkflowEfficiencyDiagnostics {
  jsonEvents: number;
  toolEvents: number;
  toolCallsByName: Record<string, number>;
  meshRouteCalls: number;
  meshRouteNonExecutable: number;
  duplicateToolCalls: number;
  readCalls: number;
  writeCalls: number;
  editCalls: number;
  retries: number;
  sdkRetryAttempts?: number;
  recoveredInfrastructureFailures?: WorkflowInfrastructureFailure[];
  retainedRetryFixturePaths?: string[];
  tokenTotal: number;
  timeToWorkspaceStaticValidMs?: number;
  timeToWorkspaceValidMs?: number;
  timeToVerificationPassMs?: number;
  timeToFinalAnswerMs?: number;
  verificationPassed: boolean;
  verificationToolCalls: number;
  finalAnswerMissing: boolean;
  objectiveStopReason?: string;
  infrastructureFailure?: WorkflowInfrastructureFailure;
}

interface WorkflowInfrastructureFailure {
  kind: "provider-error" | "cli-error" | "agent-stall";
  message: string;
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
  judge?: WorkflowJudgeVerdict;
  retainedFixturePath?: string;
}

interface WorkflowComparisonSummary {
  caseId: string;
  pass: boolean;
  reason: string;
  variants: Partial<Record<WorkflowVariant, VariantStats>>;
}

interface VariantStats {
  runs: number;
  passCount: number;
  passRate: number;
  infrastructureFailures: number;
  avgWorkspaceScore: number;
  avgTraceScore: number;
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
  avgMeshRouteCalls: number;
  avgMeshRouteNonExecutable: number;
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
    minMeshPassRate: number;
    maxDirectMeshRouteCalls: number;
    maxDuplicateToolCalls: number;
  };
}

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const extensionPath = path.join(repoRoot, "src", "index.ts");
const defaultMatrixPath = path.join(repoRoot, "evals", "results", "workflow-quality-matrix.jsonl");

if (isMain()) await main();

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const startedAt = new Date().toISOString();
  const mode = args.mode ?? "fixtures";
  const timeoutMs = resolveWorkflowTimeoutMs(args.timeoutMs);
  const runs = resolveWorkflowRunCount(args.runs ?? process.env.PI_MESH_WORKFLOW_RUNS);
  const caseIds = resolveCaseIds(args.case);
  const variants = resolveVariants(args.variant);
  const judgeMode = resolveJudgeMode(args.judge ?? process.env.PI_MESH_WORKFLOW_JUDGE ?? "none");
  const outputs: WorkflowRunOutput[] = [];

  if (mode === "fixtures") {
    for (const caseId of caseIds) {
      const fixture = createWorkflowFixture(caseId);
      const finalText = syntheticPassingSummary(fixture.case);
      const workspace = scoreWorkflowWorkspace(fixture.cwd, fixture.case, { finalText, durationMs: 0 });
      const trace = gradePiTrace(finalText, { variant: "simple", finalText, promptKind: "generic", durationMs: 0 });
      outputs.push({ variant: "simple", runIndex: 1, cwd: fixture.cwd, stdout: finalText, stderr: "", finalText, status: 0, signal: null, durationMs: 0, workspace, trace, diagnostics: emptyDiagnostics() });
      if (process.env.PI_MESH_WORKFLOW_KEEP_FIXTURE !== "1") fs.rmSync(fixture.cwd, { recursive: true, force: true });
    }
  } else if (mode === "sdk") {
    if ((caseIds.length > 1 || runs > 1) && process.env.PI_MESH_WORKFLOW_ALLOW_MULTI_SDK !== "1") {
      throw new Error("SDK mode runs one case/run by default to avoid long waits. Pass --case=<id> --runs=1, or set PI_MESH_WORKFLOW_ALLOW_MULTI_SDK=1 knowingly.");
    }
    assertSdkRunBudget({ caseIds, variants, runs, timeoutMs, args });
    for (const caseId of caseIds) {
      for (let runIndex = 1; runIndex <= runs; runIndex += 1) {
        for (const variant of variants) {
          console.log(`progress: ${variant} ${caseId}#${runIndex} start timeout=${timeoutMs}ms`);
          const output = await runSdkCaseWithRetries(getWorkflowEvalCase(caseId), variant, timeoutMs, runIndex, judgeMode);
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
    outputs.push({ variant: "simple", runIndex: 1, cwd, stdout: finalText, stderr: "", finalText, status: 0, signal: null, durationMs: args.durationMs ? Number(args.durationMs) : 0, workspace, trace, diagnostics: emptyDiagnostics() });
  } else {
    throw new Error(`Unsupported workflow eval mode: ${mode}`);
  }

  const grouped = summarizeComparison(outputs);
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
    git: gitMetadata(),
    model: process.env.PI_MESH_WORKFLOW_MODEL ?? "default-pi-model",
    regressionGates,
    pass,
    grouped,
    categorySummary: summarizeByCategory(outputs),
    failureUx: mode === "fixtures" ? [] : summarizeWorkflowFailures(outputs),
    outputs: outputs.map((item) => compactOutput(item)),
  };

  const reportDir = path.join(repoRoot, ".pi-mesh", "evals");
  fs.mkdirSync(reportDir, { recursive: true });
  const reportPath = writeWorkflowReport(reportDir, report);
  if (mode === "sdk" && shouldPersistMatrix(args)) appendMatrixRows(args.matrixPath ? path.resolve(args.matrixPath) : defaultMatrixPath, report);

  console.log(`pi-mesh workflow quality: ${pass ? "PASS" : "FAIL"}`);
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
  if (!pass && process.env.PI_MESH_WORKFLOW_ALLOW_FAIL !== "1") process.exit(1);
}

export function resolveWorkflowTimeoutMs(value: string | undefined): number {
  const parsed = Number(value ?? DEFAULT_WORKFLOW_TIMEOUT_MS);
  return Number.isFinite(parsed) && parsed > 0 ? Math.min(Math.floor(parsed), MAX_WORKFLOW_TIMEOUT_MS) : DEFAULT_WORKFLOW_TIMEOUT_MS;
}

export function resolveWorkflowRunCount(value: string | undefined): number {
  const parsed = Number(value ?? DEFAULT_WORKFLOW_RUNS);
  return Number.isFinite(parsed) && parsed > 0 ? Math.min(Math.floor(parsed), MAX_WORKFLOW_RUNS) : DEFAULT_WORKFLOW_RUNS;
}

export function resolveWorkflowIdleTimeoutMs(value: string | undefined, workflowTimeoutMs = MAX_WORKFLOW_TIMEOUT_MS): number {
  const parsed = Number(value ?? DEFAULT_WORKFLOW_IDLE_TIMEOUT_MS);
  const bounded = Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : DEFAULT_WORKFLOW_IDLE_TIMEOUT_MS;
  return Math.min(Math.max(bounded, 5_000), Math.max(5_000, workflowTimeoutMs - 1_000));
}

export function resolveCaseIds(value: string | undefined): string[] {
  if (!value || value === "all") return listWorkflowEvalCases().map((item) => item.id);
  if (value === "holdout" || value === "holdout-all") return listWorkflowHoldoutCases().map((item) => item.id);
  if (value === "all-with-holdout") return listWorkflowEvalCases({ includeHoldout: true }).map((item) => item.id);
  return value.split(",").map((item) => item.trim()).filter(Boolean);
}

export function resolveVariants(value: string | undefined): WorkflowVariant[] {
  if (!value || value === "both" || value === "all") return ["simple", "mesh"];
  if (value === "simple" || value === "mesh") return [value];
  throw new Error(`Unsupported workflow variant: ${value}`);
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
  return args.gates === "1" || process.env.PI_MESH_WORKFLOW_GATES === "1";
}

export function assertSdkRunBudget(options: { caseIds: string[]; variants: WorkflowVariant[]; runs: number; timeoutMs: number; args: Record<string, string> }): void {
  if (options.args.allowLong === "1" || process.env.PI_MESH_WORKFLOW_ALLOW_LONG_SDK === "1") return;
  const totalRuns = options.caseIds.length * options.variants.length * options.runs;
  const estimatedWorstCaseMs = totalRuns * options.timeoutMs;
  const maxWallMs = Number(options.args.maxWallMs ?? process.env.PI_MESH_WORKFLOW_MAX_WALL_MS ?? DEFAULT_MAX_INTERACTIVE_SDK_WALL_MS);
  if (estimatedWorstCaseMs <= maxWallMs) return;
  throw new Error([
    `Refusing long SDK matrix by default: ${options.caseIds.length} case(s) × ${options.variants.length} variant(s) × ${options.runs} run(s) = ${totalRuns} SDK run(s).`,
    `Worst-case budget is ${estimatedWorstCaseMs}ms with timeoutMs=${options.timeoutMs}, above maxWallMs=${maxWallMs}.`,
    "Shard the matrix into smaller --case groups, lower --runs/--timeoutMs, or set PI_MESH_WORKFLOW_ALLOW_LONG_SDK=1/--allowLong=1 intentionally.",
  ].join(" "));
}

export function evaluateWorkflowRegressionGates(outputs: WorkflowRunOutput[], grouped: WorkflowComparisonSummary[]): WorkflowRegressionGates {
  const thresholds = { minMeshPassRate: 1, maxDirectMeshRouteCalls: 0, maxDuplicateToolCalls: 2 };
  const failures: string[] = [];
  const warnings: string[] = [];

  for (const output of outputs) {
    const label = `${output.variant} ${output.workspace.caseId}#${output.runIndex}`;
    const isMesh = output.variant === "mesh";
    if (output.diagnostics.infrastructureFailure) {
      const message = `${label}: infrastructure failure ${output.diagnostics.infrastructureFailure.kind}`;
      if (isMesh) failures.push(message);
      else warnings.push(message);
    }
    if (output.diagnostics.recoveredInfrastructureFailures?.length) {
      warnings.push(`${label}: recovered after ${output.diagnostics.sdkRetryAttempts ?? output.diagnostics.recoveredInfrastructureFailures.length} infrastructure retry attempt(s): ${output.diagnostics.recoveredInfrastructureFailures.map((failure) => failure.kind).join(", ")}`);
    }
    if (!outputPass(output)) {
      const message = `${label}: output did not pass deterministic/judge checks`;
      if (isMesh) failures.push(message);
      else warnings.push(message);
    }
    if (output.diagnostics.finalAnswerMissing) {
      const message = `${label}: missing final answer evidence`;
      if (isMesh) failures.push(message);
      else warnings.push(message);
    }
    if (getWorkflowEvalCase(output.workspace.caseId).expected.validation?.runTests && !output.diagnostics.verificationPassed) {
      const message = `${label}: did not execute a passing verification command`;
      if (isMesh) failures.push(message);
      else warnings.push(message);
    }
    if (output.trace.warnings.some((issue) => issue.id === "thin-answer")) {
      const message = `${label}: thin final answer`;
      if (isMesh) failures.push(message);
      else warnings.push(message);
    }
    if (output.diagnostics.duplicateToolCalls > thresholds.maxDuplicateToolCalls) {
      warnings.push(`${label}: duplicate tool calls ${output.diagnostics.duplicateToolCalls} > ${thresholds.maxDuplicateToolCalls}`);
    }
    if (output.variant === "mesh" && !shouldRequireMeshRoute(getWorkflowEvalCase(output.workspace.caseId)) && output.diagnostics.meshRouteCalls > thresholds.maxDirectMeshRouteCalls) {
      failures.push(`${label}: direct-eligible case called mesh_route ${output.diagnostics.meshRouteCalls} time(s)`);
    }
  }

  for (const group of grouped) {
    const evalCase = getWorkflowEvalCase(group.caseId);
    const mesh = group.variants.mesh;
    if (!mesh) continue;
    if (mesh.passRate < thresholds.minMeshPassRate) failures.push(`${group.caseId}: mesh passRate ${mesh.passRate} < ${thresholds.minMeshPassRate}`);
    if (mesh.avgWorkspaceScore < 90) failures.push(`${group.caseId}: mesh workspace avg ${mesh.avgWorkspaceScore} < 90`);
    if (mesh.avgTraceScore < 90) failures.push(`${group.caseId}: mesh trace avg ${mesh.avgTraceScore} < 90`);
    if (evalCase.expected.maxDurationMs && mesh.p95DurationMs > evalCase.expected.maxDurationMs) {
      failures.push(`${group.caseId}: mesh p95 ${mesh.p95DurationMs}ms > case budget ${evalCase.expected.maxDurationMs}ms`);
    }
    if (!group.pass) failures.push(`${group.caseId}: comparison gate failed (${group.reason})`);
  }

  return { enabled: true, pass: failures.length === 0, failures, warnings, thresholds };
}

export function shouldRetainWorkflowFixture(output: Pick<WorkflowRunOutput, "workspace" | "trace" | "diagnostics" | "judge">, env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.PI_MESH_WORKFLOW_KEEP_FIXTURE === "1") return true;
  if (env.PI_MESH_WORKFLOW_KEEP_FAILED_FIXTURE === "0") return false;
  return !outputPass(output as WorkflowRunOutput);
}

export function buildWorkflowJudgePrompt(output: Pick<WorkflowRunOutput, "variant" | "finalText" | "workspace" | "trace" | "diagnostics">, evalCase: WorkflowEvalCase): string {
  return [
    "Eres juez de evals de coding agents. Evalúa si el resultado cumple la tarea con calidad productiva.",
    "Responde SOLO JSON válido con: {\"pass\":boolean,\"score\":number,\"verdict\":string,\"critical\":string[],\"warnings\":string[]}.",
    "Si el outcome determinístico pasa pero la evidencia es débil, puedes marcar pass=false. No premies longitud; premia cumplimiento, mínimo scope, tests y claridad.",
    `Caso: ${evalCase.id} (${evalCase.kind}/${evalCase.suite})\nPrompt: ${evalCase.prompt}`,
    `Reporte workspace:\n${JSON.stringify(output.workspace, null, 2)}`,
    `Reporte trace:\n${JSON.stringify(output.trace, null, 2)}`,
    `Métricas eficiencia:\n${JSON.stringify(output.diagnostics, null, 2)}`,
    `Respuesta final:\n${snippet(output.finalText, 4000)}`,
  ].join("\n\n");
}

function workflowEvalPass(outputs: WorkflowRunOutput[], grouped: Array<{ pass: boolean }>): boolean {
  const hasBothVariants = outputs.some((item) => item.variant === "simple") && outputs.some((item) => item.variant === "mesh");
  if (hasBothVariants) return outputs.filter((item) => item.variant === "mesh").every(outputPass) && grouped.every((item) => item.pass);
  return outputs.every(outputPass);
}

function disabledWorkflowRegressionGates(): WorkflowRegressionGates {
  return {
    enabled: false,
    pass: true,
    failures: [],
    warnings: [],
    thresholds: { minMeshPassRate: 1, maxDirectMeshRouteCalls: 0, maxDuplicateToolCalls: 2 },
  };
}

function outputPass(output: WorkflowRunOutput): boolean {
  if (output.diagnostics.infrastructureFailure) return false;
  const requiresVerification = typeof output.workspace.caseId === "string"
    ? Boolean(getWorkflowEvalCase(output.workspace.caseId).expected.validation?.runTests)
    : false;
  return output.workspace.pass
    && output.trace.pass
    && !output.diagnostics.finalAnswerMissing
    && (!requiresVerification || output.diagnostics.verificationPassed)
    && (output.judge ? output.judge.pass : true);
}

function summarizeComparison(outputs: WorkflowRunOutput[]): WorkflowComparisonSummary[] {
  const caseIds = [...new Set(outputs.map((item) => item.workspace.caseId))];
  return caseIds.map((caseId) => {
    const simpleRuns = outputs.filter((item) => item.workspace.caseId === caseId && item.variant === "simple");
    const meshRuns = outputs.filter((item) => item.workspace.caseId === caseId && item.variant === "mesh");
    const simple = summarizeVariant(simpleRuns);
    const mesh = summarizeVariant(meshRuns);
    const infraFailure = [...simpleRuns, ...meshRuns].find((item) => item.diagnostics.infrastructureFailure)?.diagnostics.infrastructureFailure;
    if (!simple || !mesh) {
      const only = simple ?? mesh;
      return {
        caseId,
        pass: Boolean(only && only.passRate === 1),
        reason: infraFailure
          ? `infrastructure-failure ${infraFailure.kind}: ${infraFailure.message}`
          : only ? `single-variant diagnosis passRate=${only.passRate}` : "single-variant diagnosis with no runs",
        variants: { simple, mesh },
      };
    }
    if (infraFailure) {
      return {
        caseId,
        pass: false,
        reason: `infrastructure-failure ${infraFailure.kind}: ${infraFailure.message}`,
        variants: { simple, mesh },
      };
    }
    const qualityFloor = Math.max(90, simple.avgWorkspaceScore - 5);
    const meshQualityComparable = mesh.avgWorkspaceScore >= qualityFloor;
    const meshReliabilityComparable = mesh.passRate >= simple.passRate;
    const meshEfficiencyComparable = mesh.p95DurationMs <= Math.max(simple.p95DurationMs * 1.75, simple.p95DurationMs + 15_000);
    return {
      caseId,
      pass: meshQualityComparable && meshReliabilityComparable && meshEfficiencyComparable,
      reason: `meshAvg=${mesh.avgWorkspaceScore}, simpleAvg=${simple.avgWorkspaceScore}, meshPass=${mesh.passRate}, simplePass=${simple.passRate}, meshP95=${mesh.p95DurationMs}ms, simpleP95=${simple.p95DurationMs}ms`,
      variants: { simple, mesh },
    };
  });
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
    avgWorkspaceScore: avg(items.map((item) => item.workspace.score)),
    avgTraceScore: avg(items.map((item) => item.trace.score)),
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
    avgMeshRouteCalls: avg(items.map((item) => item.diagnostics.meshRouteCalls)),
    avgMeshRouteNonExecutable: avg(items.map((item) => item.diagnostics.meshRouteNonExecutable)),
    avgDuplicateToolCalls: avg(items.map((item) => item.diagnostics.duplicateToolCalls)),
    avgTokens: avg(items.map((item) => item.diagnostics.tokenTotal)),
    totalTokens: items.reduce((sum, item) => sum + item.diagnostics.tokenTotal, 0),
    estimatedCostUsd: estimateCostUsd(items.reduce((sum, item) => sum + item.diagnostics.tokenTotal, 0)),
    costPerPassingRunUsd: items.filter(outputPass).length > 0 ? round(estimateCostUsd(items.reduce((sum, item) => sum + item.diagnostics.tokenTotal, 0)) / items.filter(outputPass).length, 4) : undefined,
    flakiness: round(1 - Math.max(items.filter(outputPass).length / items.length, 1 - (items.filter(outputPass).length / items.length)), 3),
  };
}

async function runSdkCase(evalCase: WorkflowEvalCase, variant: WorkflowVariant, timeoutMs: number, runIndex: number, judgeMode: WorkflowJudgeMode): Promise<WorkflowRunOutput> {
  const fixture = createWorkflowFixture(evalCase.id);
  const started = Date.now();
  const args = [
    "-p",
    "--no-session",
    "--mode",
    "json",
    "--no-context-files",
    "--no-skills",
    "--tools",
    variant === "mesh" ? "read,bash,grep,find,ls,edit,write,mesh_route" : "read,bash,grep,find,ls,edit,write",
  ];
  if (variant === "mesh") args.push("-e", extensionPath);
  const model = process.env.PI_MESH_WORKFLOW_MODEL;
  if (model) args.push("--model", model);
  args.push("--thinking", process.env.PI_MESH_WORKFLOW_THINKING ?? "minimal", evalCase.prompt);
  const run = await runPi(args, fixture.cwd, timeoutMs, {
    observeWorkspacePass: shouldRequireMeshRoute(evalCase) ? undefined : () => scoreWorkflowWorkspace(fixture.cwd, evalCase, { finalText: "", validateTests: false }).pass,
  });
  const durationMs = Date.now() - started;
  // Never treat raw JSON event streams as the final answer.
  // On timeout/no-final runs, using stdout here falsely matches prompts, file paths,
  // and tool traces as if the agent had delivered evidence.
  const finalText = extractFinalText(run.stdout);
  const workspace = scoreWorkflowWorkspace(fixture.cwd, evalCase, { finalText, durationMs, validateTests: evalCase.expected.validation?.runTests === true });
  const trace = gradePiTrace(run.stdout, { variant: variant as TraceVariant, finalText, promptKind: "generic", requireMeshRoute: shouldRequireMeshRoute(evalCase), status: run.status, signal: run.signal, timeoutReason: run.timeoutReason, durationMs, maxDurationMs: timeoutMs });
  const diagnostics = workflowDiagnostics(run.stdout, run.stderr, run.timeToWorkspaceValidMs, run.timeToVerificationPassMs, run.timeToFinalAnswerMs, finalText.length === 0, run.objectiveStopReason, run.timeoutReason);
  const output: WorkflowRunOutput = { variant, runIndex, cwd: fixture.cwd, stdout: run.stdout, stderr: run.stderr, finalText, status: run.status, signal: run.signal, timeoutReason: run.timeoutReason, durationMs, workspace, trace, diagnostics };
  if (judgeMode === "pi" || (judgeMode === "auto" && shouldRunWorkflowJudge(output))) output.judge = await runWorkflowJudge(output, evalCase);
  else if (judgeMode === "auto") output.judge = { pass: true, score: 100, verdict: "Judge skipped; deterministic result was unambiguous.", critical: [], warnings: [], skipped: true, reason: "deterministic-unambiguous" };
  if (shouldRetainWorkflowFixture(output)) output.retainedFixturePath = fixture.cwd;
  else fs.rmSync(fixture.cwd, { recursive: true, force: true });
  return output;
}

async function runSdkCaseWithRetries(evalCase: WorkflowEvalCase, variant: WorkflowVariant, timeoutMs: number, runIndex: number, judgeMode: WorkflowJudgeMode): Promise<WorkflowRunOutput> {
  const maxRetries = resolveWorkflowInfraRetries(process.env.PI_MESH_WORKFLOW_INFRA_RETRIES);
  const failedAttempts: WorkflowRunOutput[] = [];

  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    const output = await runSdkCase(evalCase, variant, timeoutMs, runIndex, judgeMode);
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
  const totalTokens = output.diagnostics.tokenTotal + failedAttempts.reduce((sum, item) => sum + item.diagnostics.tokenTotal, 0);
  const retryToolCalls = failedAttempts.reduce((sum, item) => sum + item.diagnostics.toolEvents, 0);
  const retainedRetryFixturePaths = failedAttempts.map((item) => item.retainedFixturePath).filter((item): item is string => Boolean(item));
  return {
    ...output,
    durationMs: totalDurationMs,
    diagnostics: {
      ...output.diagnostics,
      toolEvents: output.diagnostics.toolEvents + retryToolCalls,
      tokenTotal: totalTokens,
      retries: output.diagnostics.retries + failedAttempts.length,
      sdkRetryAttempts: failedAttempts.length,
      recoveredInfrastructureFailures: failedAttempts.map((item) => item.diagnostics.infrastructureFailure).filter((item): item is WorkflowInfrastructureFailure => Boolean(item)),
      retainedRetryFixturePaths: retainedRetryFixturePaths.length ? retainedRetryFixturePaths : undefined,
    },
  };
}

function shouldRequireMeshRoute(_evalCase: WorkflowEvalCase): boolean {
  return false;
}

async function runWorkflowJudge(output: WorkflowRunOutput, evalCase: WorkflowEvalCase): Promise<WorkflowJudgeVerdict> {
  const model = process.env.PI_MESH_WORKFLOW_JUDGE_MODEL ?? DEFAULT_JUDGE_MODEL;
  const timeoutMs = resolveJudgeTimeoutMs(process.env.PI_MESH_WORKFLOW_JUDGE_TIMEOUT_MS);
  const prompt = buildWorkflowJudgePrompt(output, evalCase);
  try {
    const text = await runPiJsonPrompt(prompt, { cwd: repoRoot, model, timeoutMs });
    const parsed = parseJsonObjectFromText(text);
    return {
      pass: Boolean(parsed.pass),
      score: typeof parsed.score === "number" ? Math.max(0, Math.min(100, Math.round(parsed.score))) : 0,
      verdict: typeof parsed.verdict === "string" ? parsed.verdict : "No verdict",
      critical: Array.isArray(parsed.critical) ? parsed.critical.filter((item): item is string => typeof item === "string") : [],
      warnings: Array.isArray(parsed.warnings) ? parsed.warnings.filter((item): item is string => typeof item === "string") : [],
    };
  } catch (error) {
    return { pass: false, score: 0, verdict: "Judge failed", critical: [error instanceof Error ? error.message : String(error)], warnings: [] };
  }
}

function runPi(args: string[], cwd: string, timeoutMs: number, options: { observeWorkspacePass?: () => boolean } = {}): Promise<{ stdout: string; stderr: string; status: number | null; signal: NodeJS.Signals | null; timeoutReason?: string; timeToWorkspaceValidMs?: number; timeToVerificationPassMs?: number; timeToFinalAnswerMs?: number; objectiveStopReason?: string }> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const idleTimeoutMs = resolveWorkflowIdleTimeoutMs(process.env.PI_MESH_WORKFLOW_IDLE_TIMEOUT_MS, timeoutMs);
    let lastProgressAt = started;
    const child = spawn("pi", args, { cwd, stdio: ["ignore", "pipe", "pipe"], detached: true, env: { ...process.env, PI_TELEMETRY: "0" } });
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

function workflowDiagnostics(stdout: string, stderr: string, timeToWorkspaceValidMs: number | undefined, timeToVerificationPassMs: number | undefined, timeToFinalAnswerMs: number | undefined, finalAnswerMissing: boolean, objectiveStopReason?: string, timeoutReason?: string): WorkflowEfficiencyDiagnostics {
  const parsed = parsePiJsonTrace(stdout);
  const verification = detectWorkflowVerification(stdout);
  const toolCallsByName: Record<string, number> = {};
  let duplicateToolCalls = 0;
  let previous = "";
  for (const event of parsed.toolEvents) {
    if (event.phase === "end") continue;
    toolCallsByName[event.name] = (toolCallsByName[event.name] ?? 0) + 1;
    const signature = `${event.name}:${event.argsText}`;
    if (signature && signature === previous) duplicateToolCalls += 1;
    previous = signature;
  }
  return {
    jsonEvents: parsed.jsonEvents,
    toolEvents: parsed.toolEvents.length,
    toolCallsByName,
    meshRouteCalls: toolCallsByName.mesh_route ?? 0,
    meshRouteNonExecutable: parsed.toolEvents.filter((item) => item.name === "mesh_route" && item.phase === "end" && /status:\s*direct-recommended|direct execution recommended|approval is required|status:\s*(ask|block)|Approval:\s*(ask|block)/i.test(item.resultText)).length,
    duplicateToolCalls,
    readCalls: toolCallsByName.read ?? 0,
    writeCalls: toolCallsByName.write ?? 0,
    editCalls: toolCallsByName.edit ?? 0,
    retries: countPattern(stdout, /retry|again|reintento|try again/i),
    tokenTotal: extractTokenTotal(stdout),
    timeToWorkspaceStaticValidMs: timeToWorkspaceValidMs,
    timeToWorkspaceValidMs,
    timeToVerificationPassMs,
    timeToFinalAnswerMs,
    verificationPassed: verification.passed,
    verificationToolCalls: verification.calls,
    finalAnswerMissing,
    objectiveStopReason,
    infrastructureFailure: detectWorkflowInfrastructureFailure(stdout, stderr, timeoutReason),
  };
}

export function detectWorkflowInfrastructureFailure(stdout: string, stderr = "", timeoutReason?: string): WorkflowInfrastructureFailure | undefined {
  if (timeoutReason && /idle timeout|without SDK events|stall/i.test(timeoutReason)) {
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

export function observeTerminalAssistantAnswer(buffer: string): { remainder: string; terminalAnswer: boolean } {
  const lines = buffer.split(/\r?\n/);
  const remainder = lines.pop() ?? "";
  let terminalAnswer = false;
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line) as { type?: string; message?: { role?: string; content?: unknown; stopReason?: unknown }; assistantMessageEvent?: { type?: string; content?: string } };
      const messageText = parsed.message?.role === "assistant" ? contentToText(parsed.message.content) : "";
      if ((parsed.type === "message_end" || parsed.type === "turn_end") && parsed.message?.stopReason !== "toolUse" && isFinalAnswerText(messageText)) terminalAnswer = true;
      if (parsed.assistantMessageEvent?.type === "text_end" && typeof parsed.assistantMessageEvent.content === "string" && isFinalAnswerText(parsed.assistantMessageEvent.content)) terminalAnswer = true;
    } catch {
      // Ignore non-json progress lines.
    }
  }
  return { remainder, terminalAnswer };
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
    cwd: item.cwd,
    status: item.status,
    signal: item.signal,
    timeoutReason: item.timeoutReason,
    durationMs: item.durationMs,
    retainedFixturePath: item.retainedFixturePath,
    diagnostics: item.diagnostics,
    workspace: item.workspace,
    trace: item.trace,
    judge: item.judge,
    finalTextSnippet: snippet(item.finalText, 1200),
    stderrSnippet: snippet(item.stderr, 800),
    ...(includeFullOutput ? { stdout: item.stdout, stderr: item.stderr, finalText: item.finalText } : {}),
  };
}

export function shouldStoreFullWorkflowOutput(output: Pick<WorkflowRunOutput, "workspace" | "trace" | "diagnostics" | "judge">, env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.PI_MESH_WORKFLOW_STORE_FULL_OUTPUT === "1") return true;
  if (env.PI_MESH_WORKFLOW_STORE_FAILED_OUTPUT === "0") return false;
  return !outputPass(output as WorkflowRunOutput);
}

function shouldPersistMatrix(args: Record<string, string>): boolean {
  return args.persistMatrix !== "0" && process.env.PI_MESH_WORKFLOW_PERSIST_MATRIX !== "0";
}

function appendMatrixRows(matrixPath: string, report: { startedAt: string; finishedAt: string; mode: string; cases: string[]; variants: WorkflowVariant[]; runs: number; pass: boolean; grouped: WorkflowComparisonSummary[]; git: object; model: string; regressionGates: WorkflowRegressionGates; categorySummary?: unknown; failureUx?: unknown }): void {
  fs.mkdirSync(path.dirname(matrixPath), { recursive: true });
  const rows = report.grouped.map((group) => ({
    schemaVersion: 3,
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

function parseJsonObjectFromText(text: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(text) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
  } catch {
    // Try embedded JSON.
  }
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start >= 0 && end > start) {
    const parsed = JSON.parse(text.slice(start, end + 1)) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
  }
  throw new Error("judge output did not contain JSON");
}

function resolveJudgeMode(value: string): WorkflowJudgeMode {
  if (value === "none" || value === "auto" || value === "pi") return value;
  throw new Error(`Unsupported workflow judge mode: ${value}`);
}

function emptyDiagnostics(): WorkflowEfficiencyDiagnostics {
  return { jsonEvents: 0, toolEvents: 0, toolCallsByName: {}, meshRouteCalls: 0, meshRouteNonExecutable: 0, duplicateToolCalls: 0, readCalls: 0, writeCalls: 0, editCalls: 0, retries: 0, tokenTotal: 0, verificationPassed: false, verificationToolCalls: 0, finalAnswerMissing: false };
}

function extractTokenTotal(stdout: string): number {
  let total = 0;
  for (const line of stdout.split(/\r?\n/)) {
    try {
      const parsed = JSON.parse(line) as { message?: { usage?: { totalTokens?: number } }; usage?: { totalTokens?: number } };
      const value = parsed.usage?.totalTokens ?? parsed.message?.usage?.totalTokens;
      if (typeof value === "number" && Number.isFinite(value)) total += value;
    } catch {
      // ignore
    }
  }
  return total;
}

function countPattern(text: string, pattern: RegExp): number {
  return text.split(/\r?\n/).filter((line) => pattern.test(line)).length;
}

function isVerificationCommand(commandText: string | undefined): boolean {
  return Boolean(commandText && /\b(npm\s+test|pnpm\s+test|yarn\s+test|bun\s+test|node\b.*--test|python(?:3)?\s+-m\s+unittest|go\s+test|cargo\s+test|pytest|vitest|jest|tsc\s+--noEmit|typecheck|eslint)\b/i.test(commandText));
}

function estimateCostUsd(totalTokens: number): number {
  // Conservative blended estimate for matrix trend comparisons; provider billing remains source of truth.
  return round((totalTokens / 1_000_000) * 5, 4);
}

function avg(items: number[]): number {
  if (items.length === 0) return 0;
  return Math.round(items.reduce((sum, item) => sum + item, 0) / items.length);
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
