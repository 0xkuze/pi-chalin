#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
  ORCHESTRATION_EVAL_CASES,
  summarizeOrchestrationEvalCases,
  type ChalinExpectedTopology,
  type ChalinOrchestrationEvalCase,
} from "./orchestration-cases.ts";
import { activeTokenTotal } from "./token-metrics.ts";

const DECISION_TOOL_NAMES = new Set(["chalin_direct", "chalin_route", "chalin_resume", "chalin_interview"]);

interface UsageTotals {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
}

interface ToolMetrics {
  totalCalls: number;
  chalinRouteCalls: number;
  builtInCalls: number;
  callsByName: Record<string, number>;
  firstTool?: string;
  builtInCallsBeforeDecision: number;
}

interface EvalMetrics {
  usage: UsageTotals;
  childUsage: UsageTotals;
  combinedUsage: UsageTotals;
  tools: ToolMetrics;
  childTools: { totalCalls: number; callsByName: Record<string, number> };
  policy: { violations: number; violationReasons: string[]; budgetStops: number; duplicateReadCount: number; filesRead: number };
  eventCount: number;
  stdoutBytes: number;
  stderrBytes: number;
}

interface EvalRunSummary {
  id: string;
  runPath: string;
  status: string;
  workUnitStrategy?: string;
  workUnitCount: number;
  materializedFanoutUnits: number;
  stepCount: number;
  runningStepCount: number;
  budgetMaxSeconds?: number;
}

interface ChildSessionProgress {
  latestMtimeMs: number;
  totalSizeBytes: number;
  fileCount: number;
  signature: string;
  latestPath?: string;
}

interface EvalResult {
  id: string;
  prompt: string;
  fixture: string;
  stdoutPath: string;
  stderrPath: string;
  preRouteInspection?: ChalinOrchestrationEvalCase["preRouteInspection"];
  expectedDecision: string;
  expectedTopology: ChalinExpectedTopology;
  actualDecision: "chalin" | "direct" | "error";
  actualTopology: string;
  matchedExpectedAgents: string[];
  pass: boolean;
  durationMs: number;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  timeoutReason?: string;
  stdoutSnippet: string;
  stderrSnippet: string;
  reason: string;
  thresholdFailures: string[];
  runSummary?: EvalRunSummary;
  metrics: EvalMetrics;
}

interface ActiveEvalCase {
  id: string;
  prompt: string;
  fixture: string;
  stdoutPath: string;
  stderrPath: string;
  startedAt: string;
  updatedAt: string;
  status: "running";
  childPid?: number;
  timeoutReason?: string;
  runSummary?: EvalRunSummary;
  runMtimeMs?: number;
  childSessionProgress?: ChildSessionProgress;
  stdoutBytes: number;
  stderrBytes: number;
}

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const extensionPath = path.join(repoRoot, "src", "index.ts");
const cli = parseCliArgs(process.argv.slice(2));
const evalRunner = cli.runner ?? process.env.PI_CHALIN_EVAL_RUNNER ?? "mock";
const evalModel = process.env.PI_CHALIN_EVAL_MODEL;
const evalThinking = process.env.PI_CHALIN_EVAL_THINKING ?? "high";
const sdkRunner = evalRunner === "sdk";
const defaultInactivityTimeoutMs = 120_000;
const legacyInactivityTimeoutMs = cli.timeoutMs ?? process.env.PI_CHALIN_EVAL_TIMEOUT_MS;
const startTimeoutMs = positiveInt(cli.startTimeoutMs ?? process.env.PI_CHALIN_EVAL_START_TIMEOUT_MS ?? legacyInactivityTimeoutMs, defaultInactivityTimeoutMs);
const idleTimeoutMs = positiveInt(cli.idleTimeoutMs ?? process.env.PI_CHALIN_EVAL_IDLE_TIMEOUT_MS ?? legacyInactivityTimeoutMs, defaultInactivityTimeoutMs);
const postChalinIdleTimeoutMs = positiveInt(cli.postChalinIdleTimeoutMs ?? process.env.PI_CHALIN_EVAL_POST_CHALIN_IDLE_TIMEOUT_MS, defaultInactivityTimeoutMs);
const chalinToolTimeoutMs = positiveInt(cli.chalinToolTimeoutMs ?? process.env.PI_CHALIN_EVAL_CHALIN_TOOL_TIMEOUT_MS ?? legacyInactivityTimeoutMs, defaultInactivityTimeoutMs);
const thresholds = {
  maxDurationMs: optionalPositiveInt(process.env.PI_CHALIN_EVAL_MAX_DURATION_MS),
  maxCombinedCost: positiveFloat(process.env.PI_CHALIN_EVAL_MAX_COMBINED_COST, sdkRunner ? 0.25 : Number.POSITIVE_INFINITY),
  maxChildToolCalls: positiveInt(process.env.PI_CHALIN_EVAL_MAX_CHILD_TOOL_CALLS, sdkRunner ? 30 : Number.POSITIVE_INFINITY),
  maxChildActiveTokens: positiveInt(process.env.PI_CHALIN_EVAL_MAX_CHILD_TOKENS, sdkRunner ? 20_000 : Number.POSITIVE_INFINITY),
  maxPolicyViolations: positiveInt(process.env.PI_CHALIN_EVAL_MAX_POLICY_VIOLATIONS, 0),
  maxDuplicateReads: positiveInt(process.env.PI_CHALIN_EVAL_MAX_DUPLICATE_READS, 0),
  maxBuiltInsBeforeChalin: positiveInt(process.env.PI_CHALIN_EVAL_MAX_BUILTINS_BEFORE_CHALIN, 0),
};
const limit = positiveInt(cli.limit ?? process.env.PI_CHALIN_EVAL_LIMIT, ORCHESTRATION_EVAL_CASES.length);
const selected = selectCases(ORCHESTRATION_EVAL_CASES).slice(0, limit);
const startedAt = new Date().toISOString();
const reportDir = path.join(repoRoot, ".pi-chalin", "evals");
fs.mkdirSync(reportDir, { recursive: true });
const reportPath = path.join(reportDir, `orchestration-${stamp(startedAt)}.json`);
const caseLogDir = path.join(reportDir, `orchestration-${stamp(startedAt)}`);
fs.mkdirSync(caseLogDir, { recursive: true });
const results: EvalResult[] = [];
const activeCases = new Map<string, ActiveEvalCase>();
const activeChildPids = new Set<number>();
let fatalError: string | undefined;

const writeCurrentReport = (status: "running" | "complete" | "error", error?: string) => {
  const report = buildReport(results, status, error);
  fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf-8");
  return report;
};

const writeSignalReport = (signal: NodeJS.Signals) => {
  for (const pid of activeChildPids) killProcessTree(pid, "SIGTERM");
  writeCurrentReport("error", `interrupted by ${signal}`);
  process.exit(128 + signalNumber(signal));
};

process.once("SIGINT", writeSignalReport);
process.once("SIGTERM", writeSignalReport);

writeCurrentReport("running");

try {
  for (const testCase of selected) {
    console.log(`pi-chalin orchestration eval: ${testCase.id}…`);
    const result = await runCase(testCase);
    results.push(result);
    writeCurrentReport("running");
    console.log(`${result.pass ? "✓" : "✗"} ${testCase.id} · ${result.actualDecision}/${result.actualTopology} · ${result.durationMs}ms`);
  }
} catch (error) {
  fatalError = errorMessage(error);
} finally {
  process.removeListener("SIGINT", writeSignalReport);
  process.removeListener("SIGTERM", writeSignalReport);
}

const passed = results.filter((result) => result.pass).length;
const failed = results.length - passed;
writeCurrentReport(fatalError ? "error" : "complete", fatalError);

printReport(reportPath, results);

if (fatalError) {
  console.error(`pi-chalin orchestration eval failed: ${fatalError}`);
  process.exit(1);
}
if (failed > 0 && process.env.PI_CHALIN_EVAL_ALLOW_FAIL !== "1") process.exit(1);

function buildReport(results: EvalResult[], status: "running" | "complete" | "error", error?: string) {
  const passed = results.filter((result) => result.pass).length;
  const failed = results.length - passed;
  const chalinActual = results.filter((result) => result.actualDecision === "chalin").length;
  const directActual = results.filter((result) => result.actualDecision === "direct").length;
  const active = Array.from(activeCases.values());
  return {
    startedAt,
    finishedAt: status === "running" ? null : new Date().toISOString(),
    harnessStatus: status,
    ...(error ? { error } : {}),
    fixture: results[0]?.fixture ?? active[0]?.fixture ?? null,
    fixtures: Object.fromEntries([
      ...results.map((result) => [result.id, result.fixture] as const),
      ...active.map((testCase) => [testCase.id, testCase.fixture] as const),
    ]),
    activeCases: active,
    extensionPath,
    expected: summarizeOrchestrationEvalCases(selected),
    actual: { total: results.length, passed, failed, chalinActual, directActual },
    metrics: summarizeMetrics(results),
    thresholds,
    timeouts: { hardTimeoutMs: null, startTimeoutMs, idleTimeoutMs, chalinToolTimeoutMs, postChalinIdleTimeoutMs },
    model: evalModel ?? "default-pi-model",
    thinking: evalThinking,
    runner: evalRunner,
    command: "pi -p --no-session --mode json --no-context-files --no-skills --tools read,bash,grep,find,ls,chalin_direct,chalin_route,chalin_memory_search -e <extension> <prompt>",
    results,
  };
}

async function runCase(testCase: ChalinOrchestrationEvalCase): Promise<EvalResult> {
  const started = Date.now();
  const fixture = makeFixtureRepo();
  const runFilesBefore = listRunFiles(fixture);
  const { stdoutPath, stderrPath } = createCaseLogFiles(testCase.id);
  activeCases.set(testCase.id, {
    id: testCase.id,
    prompt: testCase.prompt,
    fixture,
    stdoutPath,
    stderrPath,
    startedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    status: "running",
    stdoutBytes: 0,
    stderrBytes: 0,
  });
  writeCurrentReport("running");
  const args = [
    "-p",
    "--no-session",
    "--mode",
    "json",
    "--no-context-files",
    "--no-skills",
    "--tools",
    "read,bash,grep,find,ls,chalin_direct,chalin_route,chalin_memory_search",
    "-e",
    extensionPath,
  ];
  const model = evalModel;
  if (model) args.push("--model", model);
  const thinking = evalThinking;
  if (thinking) args.push("--thinking", thinking);
  args.push(testCase.prompt);

  const run = await runPi(args, testCase, fixture, runFilesBefore, {
    stdoutPath,
    stderrPath,
    onProgress: (progress) => updateActiveCaseProgress(testCase.id, progress),
  });
  const runSummary = loadNewRunSummary(fixture, runFilesBefore);

  const stdout = run.stdout;
  const stderr = run.stderr;
  writeCaseLogs(stdoutPath, stderrPath, stdout, stderr);
  const metrics = augmentMetricsWithPersistedRun(extractMetrics(stdout, stderr), runSummary);
  const detectedDecision = detectDecision(stdout);
  const actualDecision: EvalResult["actualDecision"] = detectedDecision;
  const actualTopology = detectTopology(stdout);
  const matchedExpectedAgents = expectedAgentCandidates(testCase).filter((agent) => hasAgent(stdout, agent));
  const durationMs = Date.now() - started;
  const topologyPass = acceptedTopologies(testCase).some((topology) => topologyMatches(topology, actualTopology));
  const agentsPass = acceptedAgentSets(testCase).some((agents) => agents.length === 0 || agents.every((agent) => matchedExpectedAgents.includes(agent)));
  const decisionPass = actualDecision === testCase.expectedDecision;
  const executionPass = run.status === 0 && !run.signal && !run.timeoutReason;
  const thresholdFailures = [
    ...evaluateThresholds(testCase, metrics, durationMs, runSummary),
    ...evaluateRunPersistence(testCase, actualDecision, runSummary),
    ...evaluateRunExpectations(testCase, runSummary),
  ];
  const pass = executionPass && decisionPass && topologyPass && agentsPass && thresholdFailures.length === 0;

  const result: EvalResult = {
    id: testCase.id,
    prompt: testCase.prompt,
    fixture,
    stdoutPath,
    stderrPath,
    preRouteInspection: testCase.preRouteInspection,
    expectedDecision: testCase.expectedDecision,
    expectedTopology: testCase.expectedTopology,
    actualDecision,
    actualTopology,
    matchedExpectedAgents,
    pass,
    durationMs,
    exitCode: run.status,
    signal: run.signal,
    timeoutReason: run.timeoutReason,
    stdoutSnippet: snippet(stdout),
    stderrSnippet: snippet(stderr),
    reason: pass ? "matched expected orchestration behavior" : failureReason(testCase, actualDecision, actualTopology, matchedExpectedAgents, run.status, run.signal, run.timeoutReason, stderr, thresholdFailures),
    thresholdFailures,
    runSummary,
    metrics,
  };
  activeCases.delete(testCase.id);
  return result;
}

function createCaseLogFiles(id: string): { stdoutPath: string; stderrPath: string } {
  const safeId = safeLogFileName(id);
  const stdoutPath = path.join(caseLogDir, `${safeId}.stdout.jsonl`);
  const stderrPath = path.join(caseLogDir, `${safeId}.stderr.log`);
  fs.writeFileSync(stdoutPath, "", "utf-8");
  fs.writeFileSync(stderrPath, "", "utf-8");
  return { stdoutPath, stderrPath };
}

function writeCaseLogs(stdoutPath: string, stderrPath: string, stdout: string, stderr: string): void {
  fs.writeFileSync(stdoutPath, stdout, "utf-8");
  fs.writeFileSync(stderrPath, stderr, "utf-8");
}

function safeLogFileName(value: string): string {
  return Array.from(value).map((char) => {
    const code = char.charCodeAt(0);
    const letter = (code >= 65 && code <= 90) || (code >= 97 && code <= 122);
    const digit = code >= 48 && code <= 57;
    return letter || digit || char === "-" || char === "_" || char === "." ? char : "-";
  }).join("") || "case";
}

function listRunFiles(cwd: string): Set<string> {
  const dir = path.join(cwd, ".pi-chalin", "runs");
  if (!fs.existsSync(dir)) return new Set();
  return new Set(fs.readdirSync(dir).filter((file) => file.endsWith(".json")).map((file) => path.join(dir, file)));
}

function loadNewRunSummary(cwd: string, before: Set<string>): EvalRunSummary | undefined {
  const file = latestNewRunFile(cwd, before);
  return file ? loadRunSummaryFile(file) : undefined;
}

function latestRunProgress(cwd: string, before: Set<string>): { mtimeMs: number; summary: EvalRunSummary } | undefined {
  const file = latestNewRunFile(cwd, before);
  if (!file) return undefined;
  return { mtimeMs: fs.statSync(file).mtimeMs, summary: loadRunSummaryFile(file) };
}

function latestChildSessionProgress(cwd: string, runId: string | undefined): ChildSessionProgress | undefined {
  const roots = childSessionProgressRoots(cwd, runId);
  let latestMtimeMs = 0;
  let totalSizeBytes = 0;
  let fileCount = 0;
  let latestPath: string | undefined;
  for (const root of roots) {
    for (const file of listChildSessionFiles(root)) {
      const stat = safeStat(file);
      if (!stat) continue;
      fileCount += 1;
      totalSizeBytes += stat.size;
      if (stat.mtimeMs > latestMtimeMs) {
        latestMtimeMs = stat.mtimeMs;
        latestPath = file;
      }
    }
  }
  if (!fileCount) return undefined;
  return {
    latestMtimeMs,
    totalSizeBytes,
    fileCount,
    signature: `${fileCount}:${Math.trunc(latestMtimeMs)}:${totalSizeBytes}`,
    ...(latestPath ? { latestPath } : {}),
  };
}

function childSessionProgressRoots(cwd: string, runId: string | undefined): string[] {
  const roots = [path.join(cwd, ".pi-chalin", "child-sessions", runId ?? "")];
  if (runId) roots.push(...worktreeProgressRoots(cwd, runId));
  return roots.filter((root) => fs.existsSync(root));
}

function worktreeProgressRoots(cwd: string, runId: string): string[] {
  const base = path.join(path.dirname(cwd), ".pi-chalin-worktrees", safeWorktreeName(path.basename(cwd)));
  if (!fs.existsSync(base)) return [];
  try {
    return fs.readdirSync(base, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && (entry.name === runId || entry.name.startsWith(`${runId}-`)))
      .map((entry) => path.join(base, entry.name));
  } catch {
    return [];
  }
}

function listChildSessionFiles(root: string): string[] {
  const files: string[] = [];
  const walk = (dir: string, depth: number) => {
    if (depth > 9) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (isEvalProgressIgnoredDir(entry.name)) continue;
        walk(path.join(dir, entry.name), depth + 1);
      } else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
        files.push(path.join(dir, entry.name));
      }
    }
  };
  walk(root, 0);
  return files;
}

function isEvalProgressIgnoredDir(name: string): boolean {
  return name === ".git" || name === "node_modules" || name === "vendor" || name === "dist" || name === "build" || name === "coverage";
}

function safeStat(file: string): fs.Stats | undefined {
  try {
    return fs.statSync(file);
  } catch {
    return undefined;
  }
}

function safeWorktreeName(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "agent";
}

function latestNewRunFile(cwd: string, before: Set<string>): string | undefined {
  const dir = path.join(cwd, ".pi-chalin", "runs");
  if (!fs.existsSync(dir)) return undefined;
  const candidates = fs.readdirSync(dir)
    .filter((file) => file.endsWith(".json"))
    .map((file) => path.join(dir, file))
    .filter((file) => !before.has(file))
    .sort((left, right) => fs.statSync(right).mtimeMs - fs.statSync(left).mtimeMs);
  return candidates[0];
}

function loadRunSummaryFile(file: string): EvalRunSummary {
  const run = JSON.parse(fs.readFileSync(file, "utf-8")) as {
    id?: string;
    status?: string;
    route?: { workUnitStrategy?: string };
    workUnits?: Array<{ createdFrom?: string; kind?: string; finalReviewerStepId?: string }>;
    steps?: Array<{ status?: string }>;
    budgetPreflight?: { policy?: { caps?: { maxSeconds?: unknown } } };
  };
  const workUnits = Array.isArray(run.workUnits) ? run.workUnits : [];
  const steps = Array.isArray(run.steps) ? run.steps : [];
  const fanoutUnits = workUnits.filter((unit) => unit.createdFrom === "fanout");
  const materializedFanoutUnits = fanoutUnits.filter((unit) => unit.kind !== "synthesis" && !unit.finalReviewerStepId).length;
  return {
    id: run.id ?? path.basename(file, ".json"),
    runPath: file,
    status: run.status ?? "unknown",
    workUnitStrategy: run.route?.workUnitStrategy,
    workUnitCount: workUnits.length,
    materializedFanoutUnits,
    stepCount: steps.length,
    runningStepCount: steps.filter((step) => step.status === "running").length,
    budgetMaxSeconds: positiveNumber(run.budgetPreflight?.policy?.caps?.maxSeconds),
  };
}

function evaluateRunPersistence(testCase: ChalinOrchestrationEvalCase, actualDecision: "chalin" | "direct" | "error", runSummary: EvalRunSummary | undefined): string[] {
  if (testCase.expectedDecision !== "chalin" || actualDecision !== "chalin") return [];
  return runSummary ? [] : ["missing persisted run JSON for chalin_route checkpoint/resume"];
}

function evaluateRunExpectations(testCase: ChalinOrchestrationEvalCase, runSummary: EvalRunSummary | undefined): string[] {
  const failures: string[] = [];
  if (testCase.expectedDecision === "chalin" && runSummary && runSummary.status !== "complete") {
    failures.push(`run status ${runSummary.status} != complete`);
  }
  if (testCase.minWorkUnits !== undefined) {
    if (!runSummary) failures.push(`missing run summary for minWorkUnits=${testCase.minWorkUnits}`);
    else if (runSummary.workUnitCount < testCase.minWorkUnits) failures.push(`work units ${runSummary.workUnitCount} < ${testCase.minWorkUnits}`);
  }
  if (!testCase.expectedWorkUnitStrategy) return failures;
  if (!runSummary) return [`missing run summary for expected workUnitStrategy=${testCase.expectedWorkUnitStrategy}`];
  if (runSummary.workUnitStrategy !== testCase.expectedWorkUnitStrategy) {
    failures.push(`workUnitStrategy ${runSummary.workUnitStrategy ?? "unset"} != ${testCase.expectedWorkUnitStrategy}`);
  }
  if (testCase.expectedWorkUnitStrategy === "discover") {
    const minUnits = testCase.minMaterializedWorkUnits ?? 1;
    if (runSummary.materializedFanoutUnits < minUnits) failures.push(`materialized fanout units ${runSummary.materializedFanoutUnits} < ${minUnits}`);
  }
  if (testCase.expectedWorkUnitStrategy === "planned") {
    if (runSummary.workUnitCount < 2) failures.push(`planned work units ${runSummary.workUnitCount} < 2`);
    if (runSummary.materializedFanoutUnits > 0) failures.push(`planned route used dynamic fanout units ${runSummary.materializedFanoutUnits}`);
  }
  return failures;
}

interface RunPiProgress {
  childPid?: number;
  timeoutReason?: string;
  runSummary?: EvalRunSummary;
  runMtimeMs?: number;
  childSessionProgress?: ChildSessionProgress;
  stdoutBytes: number;
  stderrBytes: number;
}

function updateActiveCaseProgress(id: string, progress: Partial<RunPiProgress>): void {
  const active = activeCases.get(id);
  if (!active) return;
  Object.assign(active, progress, { updatedAt: new Date().toISOString() });
  writeCurrentReport("running");
}

function runPi(
  args: string[],
  testCase: ChalinOrchestrationEvalCase,
  fixture: string,
  runFilesBefore: Set<string>,
  options: {
    stdoutPath: string;
    stderrPath: string;
    onProgress?: (progress: Partial<RunPiProgress>) => void;
  },
): Promise<{ stdout: string; stderr: string; status: number | null; signal: NodeJS.Signals | null; timeoutReason?: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn("pi", args, {
      cwd: fixture,
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
      env: {
        ...process.env,
        PI_CHALIN_RUNNER: evalRunner,
        PI_CHALIN_MOCK_STEP_DELAY_MS: "0",
        PI_TELEMETRY: "0",
        ...(evalModel ? { PI_CHALIN_EVAL_AGENT_MODEL: evalModel } : {}),
      },
    });
    if (child.pid) activeChildPids.add(child.pid);
    options.onProgress?.({ childPid: child.pid });

    let stdout = "";
    let stderr = "";
    let timeoutReason: string | undefined;
    let settled = false;
    let chalinResultTimer: NodeJS.Timeout | undefined;
    let lastOutputAt = Date.now();
    let sawOutput = false;
    let chalinToolStartedAt: number | undefined;
    let lastChalinProgressAt = 0;
    let lastChalinProgressSignature: string | undefined;
    let lastRunProgressSignature: string | undefined;
    let lastChildSessionProgressSignature: string | undefined;
    let sawChalinResult = false;
    let stdoutLineBuffer = "";
    let sawDecisionToolCall = false;
    let preDecisionBuiltIns = 0;
    let lastProgressReportAt = 0;
    const observedToolIds = new Set<string>();
    const allowedPreRouteBuiltIns = testCase.expectedDecision === "chalin" ? maxBuiltInsBeforeChalinForCase(testCase) : Number.POSITIVE_INFINITY;
    const reportProgress = (progress: Partial<RunPiProgress>, reportOptions: { force?: boolean } = {}) => {
      const now = Date.now();
      if (!reportOptions.force && now - lastProgressReportAt < 2_000) return;
      lastProgressReportAt = now;
      const stdoutBytes = fs.existsSync(optionsPath.stdoutPath) ? fs.statSync(optionsPath.stdoutPath).size : Buffer.byteLength(stdout);
      const stderrBytes = fs.existsSync(optionsPath.stderrPath) ? fs.statSync(optionsPath.stderrPath).size : Buffer.byteLength(stderr);
      options.onProgress?.({ stdoutBytes, stderrBytes, timeoutReason, ...progress });
    };
    const optionsPath = { stdoutPath: options.stdoutPath, stderrPath: options.stderrPath };
    const finish = (status: number | null, signal: NodeJS.Signals | null) => {
      if (settled) return;
      settled = true;
      if (child.pid) activeChildPids.delete(child.pid);
      clearInterval(progressTimer);
      if (chalinResultTimer) clearTimeout(chalinResultTimer);
      reportProgress({ timeoutReason }, { force: true });
      resolve({ stdout, stderr, status, signal, timeoutReason });
    };

    const finishAfterChalinResult = () => {
      if (settled || chalinResultTimer) return;
      chalinResultTimer = setTimeout(() => {
        if (child.exitCode === null) killProcessTree(child.pid, "SIGTERM");
        finish(0, null);
      }, 150);
      chalinResultTimer.unref?.();
    };

    const kill = (reason: string) => {
      if (timeoutReason || settled) return;
      timeoutReason = reason;
      killProcessTree(child.pid, "SIGTERM");
      setTimeout(() => {
        if (child.exitCode === null) killProcessTree(child.pid, "SIGKILL");
      }, 1_000).unref();
    };

    const observeStdout = (text: string) => {
      stdoutLineBuffer += text;
      const lines = stdoutLineBuffer.split("\n");
      stdoutLineBuffer = lines.pop() ?? "";
      for (const line of lines) observeJsonLine(line);
    };

    const observeJsonLine = (line: string) => {
      if (!line.trim() || settled) return;
      let event: unknown;
      try {
        event = JSON.parse(line) as unknown;
      } catch {
        return;
      }
      if (isChalinRouteStartEvent(event)) {
        chalinToolStartedAt ??= Date.now();
        lastChalinProgressAt = Math.max(lastChalinProgressAt, chalinToolStartedAt);
      }
      const routeProgressSignature = chalinRouteProgressSignature(event);
      if (routeProgressSignature && routeProgressSignature !== lastChalinProgressSignature) {
        lastChalinProgressSignature = routeProgressSignature;
        lastChalinProgressAt = Date.now();
      }
      if (isChalinRouteResultEvent(event)) {
        sawChalinResult = true;
        lastChalinProgressAt = Date.now();
        finishAfterChalinResult();
      }
      for (const call of findToolCalls(event)) {
        const id = call.id || `${call.name}-${observedToolIds.size}`;
        if (observedToolIds.has(id)) continue;
        observedToolIds.add(id);
        if (isDecisionTool(call.name)) {
          sawDecisionToolCall = true;
          if (call.name === "chalin_route") {
            chalinToolStartedAt ??= Date.now();
            lastChalinProgressAt = Math.max(lastChalinProgressAt, chalinToolStartedAt);
          }
          continue;
        }
        if (testCase.expectedDecision !== "chalin" || sawDecisionToolCall || !isBuiltInTool(call.name)) continue;
        preDecisionBuiltIns += 1;
        if (preDecisionBuiltIns > allowedPreRouteBuiltIns) {
          kill(`pre-decision inspection ${preDecisionBuiltIns} > ${allowedPreRouteBuiltIns} (${testCase.preRouteInspection ?? "forbidden"})`);
        }
      }
    };

    const progressTimer = setInterval(() => {
      const runProgress = latestRunProgress(fixture, runFilesBefore);
      const childSessionProgress = latestChildSessionProgress(fixture, runProgress?.summary.id);
      if (runProgress || childSessionProgress) {
        reportProgress({ runSummary: runProgress?.summary, runMtimeMs: runProgress?.mtimeMs, childSessionProgress });
      }
      const runProgressSignature = runProgress ? evalRunProgressSignature(runProgress.summary) : undefined;
      if (runProgressSignature && runProgressSignature !== lastRunProgressSignature) {
        lastRunProgressSignature = runProgressSignature;
        lastChalinProgressAt = Date.now();
      }
      if (childSessionProgress && childSessionProgress.signature !== lastChildSessionProgressSignature) {
        lastChildSessionProgressSignature = childSessionProgress.signature;
        lastChalinProgressAt = Date.now();
      }
      const progressAt = Math.max(lastOutputAt, runProgress?.mtimeMs ?? 0, childSessionProgress?.latestMtimeMs ?? 0);
      const idleFor = Date.now() - progressAt;
      const chalinProgressAt = Math.max(lastChalinProgressAt, chalinToolStartedAt ?? 0);
      const chalinIdleFor = chalinProgressAt > 0 ? Date.now() - chalinProgressAt : idleFor;
      const effectiveChalinToolTimeoutMs = scaledSdkTimeout(chalinToolTimeoutMs, runProgress?.summary, "PI_CHALIN_EVAL_CHALIN_TOOL_TIMEOUT_MS");
      if (!sawOutput && idleFor > startTimeoutMs) kill(`startup timeout after ${idleFor}ms without output`);
      else if (chalinToolStartedAt && !sawChalinResult && chalinIdleFor > effectiveChalinToolTimeoutMs) kill(`chalin_route idle timeout after ${chalinIdleFor}ms without structural progress`);
      else if (sawChalinResult && idleFor > postChalinIdleTimeoutMs) kill(`post-chalin idle timeout after ${idleFor}ms`);
      else if (sawOutput && !chalinToolStartedAt && idleFor > idleTimeoutMs) kill(`idle timeout after ${idleFor}ms`);
    }, 500);

    const append = (target: "stdout" | "stderr", chunk: Buffer) => {
      const text = chunk.toString();
      lastOutputAt = Date.now();
      sawOutput = true;
      if (target === "stdout") {
        stdout += text;
        fs.appendFileSync(options.stdoutPath, text, "utf-8");
        observeStdout(text);
      } else {
        stderr += text;
        fs.appendFileSync(options.stderrPath, text, "utf-8");
      }
      reportProgress({});
    };

    child.stdout.on("data", (chunk: Buffer) => append("stdout", chunk));
    child.stderr.on("data", (chunk: Buffer) => append("stderr", chunk));
    child.on("error", (error) => settled ? undefined : reject(error));
    child.on("close", (status, signal) => finish(status, signal));
  });
}

function killProcessTree(pid: number | undefined, signal: NodeJS.Signals): void {
  if (!pid) return;
  try {
    process.kill(-pid, signal);
  } catch {
    try {
      process.kill(pid, signal);
    } catch {
      // Process already exited.
    }
  }
}

function detectDecision(stdout: string): "chalin" | "direct" {
  let sawDirect = false;
  for (const line of stdout.split("\n")) {
    if (!line.trim()) continue;
    let event: unknown;
    try {
      event = JSON.parse(line) as unknown;
    } catch {
      continue;
    }
    const toolName = eventToolNameOf(event);
    if (toolName === "chalin_route") return "chalin";
    if (toolName === "chalin_direct") sawDirect = true;
    for (const call of findToolCalls(event)) {
      if (call.name === "chalin_route") return "chalin";
      if (call.name === "chalin_direct") sawDirect = true;
    }
  }
  return sawDirect ? "direct" : "direct";
}

function detectTopology(stdout: string): string {
  const routeKinds = Array.from(stdout.matchAll(/"kind":"(multi-agent-sequential|multi-agent-dag)"/gi), (match) => match[1]?.trim()).filter(Boolean);
  const routeKind = routeKinds.at(-1);
  if (routeKind) return routeKind === "multi-agent-dag" ? "dag" : "sequential";

  const topologies = Array.from(stdout.matchAll(/"topology":"(sequential|dag)"/gi), (match) => match[1]?.trim()).filter(Boolean);
  const topology = topologies.at(-1);
  if (topology === "sequential" || topology === "dag") return topology;

  const workflow = stdout.match(/Chalin workflow:\s*([^\\n"]+)/i)?.[1]?.trim();
  if (workflow) return normalizeDetectedTopology(workflow);
  return "none";
}

function topologyMatches(expected: ChalinExpectedTopology, actual: string): boolean {
  return expected === normalizeDetectedTopology(actual);
}

function normalizeDetectedTopology(value: string): string {
  if (value === "multi-agent-dag" || value === "dag") return "dag";
  if (value === "multi-agent-sequential" || value === "sequential") return "sequential";
  return "none";
}

function acceptedTopologies(testCase: ChalinOrchestrationEvalCase): ChalinExpectedTopology[] {
  return testCase.acceptedTopologies?.length ? testCase.acceptedTopologies : [testCase.expectedTopology];
}

function acceptedAgentSets(testCase: ChalinOrchestrationEvalCase): string[][] {
  return testCase.acceptedAgentSets?.length ? testCase.acceptedAgentSets : [testCase.expectedAgents];
}

function expectedAgentCandidates(testCase: ChalinOrchestrationEvalCase): string[] {
  return [...new Set(acceptedAgentSets(testCase).flat())];
}

function hasAgent(stdout: string, agent: string): boolean {
  const escaped = RegExp.escape(agent);
  return new RegExp(`"agent":"${escaped}"|"agents":\\[[^\\]]*"${escaped}"`, "i").test(stdout);
}

function evaluateThresholds(testCase: ChalinOrchestrationEvalCase, metrics: EvalMetrics, durationMs: number, runSummary?: EvalRunSummary): string[] {
  const failures: string[] = [];
  const effectiveMaxCombinedCost = scaledSdkCostThreshold(runSummary);
  const effectiveMaxChildToolCalls = scaledSdkThreshold(thresholds.maxChildToolCalls, runSummary, "PI_CHALIN_EVAL_MAX_CHILD_TOOL_CALLS");
  const effectiveMaxChildActiveTokens = scaledSdkThreshold(thresholds.maxChildActiveTokens, runSummary, "PI_CHALIN_EVAL_MAX_CHILD_TOKENS");
  const effectiveMaxDuplicateReads = scaledSdkDuplicateReadThreshold(runSummary);
  if (thresholds.maxDurationMs !== null && durationMs > thresholds.maxDurationMs) failures.push(`duration ${durationMs}ms > ${thresholds.maxDurationMs}ms`);
  if (metrics.combinedUsage.cost.total > effectiveMaxCombinedCost) failures.push(`combined cost $${metrics.combinedUsage.cost.total.toFixed(4)} > $${effectiveMaxCombinedCost}`);
  if (metrics.childTools.totalCalls > effectiveMaxChildToolCalls) failures.push(`child tool calls ${metrics.childTools.totalCalls} > ${effectiveMaxChildToolCalls}`);
  const activeChildTokens = activeTokenTotal(metrics.childUsage);
  if (activeChildTokens > effectiveMaxChildActiveTokens) failures.push(`child active tokens ${activeChildTokens} > ${effectiveMaxChildActiveTokens}`);
  const blockingPolicyViolations = blockingPolicyViolationReasons(metrics.policy.violationReasons, runSummary);
  if (blockingPolicyViolations.length > thresholds.maxPolicyViolations) {
    failures.push(`blocking policy violations ${blockingPolicyViolations.length} > ${thresholds.maxPolicyViolations}: ${blockingPolicyViolations.slice(0, 5).join(", ")}`);
  }
  if (metrics.policy.duplicateReadCount > effectiveMaxDuplicateReads) failures.push(`duplicate reads ${metrics.policy.duplicateReadCount} > ${effectiveMaxDuplicateReads}`);
  if (testCase.expectedDecision === "chalin") {
    const allowedPreRouteBuiltIns = maxBuiltInsBeforeChalinForCase(testCase);
    if (metrics.tools.builtInCallsBeforeDecision > allowedPreRouteBuiltIns) {
      failures.push(`pre-decision built-ins ${metrics.tools.builtInCallsBeforeDecision} > ${allowedPreRouteBuiltIns} (${testCase.preRouteInspection ?? "forbidden"})`);
    }
  }
  return failures;
}

function scaledSdkThreshold(base: number, runSummary: EvalRunSummary | undefined, envName: string): number {
  if (!sdkRunner || process.env[envName] !== undefined || !runSummary || !Number.isFinite(base)) return base;
  const structuralLimit = base * Math.max(1, runSummary.stepCount);
  return Math.ceil(structuralLimit * 1.05);
}

function scaledSdkTimeout(base: number, runSummary: EvalRunSummary | undefined, envName: string): number {
  if (!sdkRunner || process.env[envName] !== undefined || !runSummary || !Number.isFinite(base)) return base;
  const structuralTimeout = base * Math.max(
    1,
    runSummary.workUnitCount,
    Math.ceil(runSummary.stepCount / 4),
    runSummary.materializedFanoutUnits,
  );
  const activeRunBudgetTimeout = runSummary.status === "running" && runSummary.runningStepCount > 0 && runSummary.budgetMaxSeconds
    ? runSummary.budgetMaxSeconds * 1_000
    : 0;
  return Math.max(structuralTimeout, activeRunBudgetTimeout);
}

function scaledSdkCostThreshold(runSummary: EvalRunSummary | undefined): number {
  if (!sdkRunner || process.env.PI_CHALIN_EVAL_MAX_COMBINED_COST !== undefined || !runSummary || !Number.isFinite(thresholds.maxCombinedCost)) return thresholds.maxCombinedCost;
  const structuralUnits = Math.max(
    1,
    runSummary.materializedFanoutUnits,
    Math.ceil(runSummary.stepCount / 4),
  );
  return thresholds.maxCombinedCost * structuralUnits;
}

function scaledSdkDuplicateReadThreshold(runSummary: EvalRunSummary | undefined): number {
  if (!sdkRunner || process.env.PI_CHALIN_EVAL_MAX_DUPLICATE_READS !== undefined || !runSummary) return thresholds.maxDuplicateReads;
  return Math.max(thresholds.maxDuplicateReads, runSummary.stepCount * 2);
}

function evalRunProgressSignature(summary: EvalRunSummary): string {
  return JSON.stringify({
    status: summary.status,
    workUnitStrategy: summary.workUnitStrategy,
    workUnitCount: summary.workUnitCount,
    materializedFanoutUnits: summary.materializedFanoutUnits,
    stepCount: summary.stepCount,
    runningStepCount: summary.runningStepCount,
  });
}

function blockingPolicyViolationReasons(reasons: string[], runSummary: EvalRunSummary | undefined): string[] {
  return reasons.filter((reason) => !isRecoverablePolicyAttempt(reason, runSummary));
}

function isRecoverablePolicyAttempt(reason: string, runSummary: EvalRunSummary | undefined): boolean {
  if (reason.startsWith("write_existing_file:") || reason.startsWith("large_edit_block:") || reason.startsWith("read_loop:")) return true;
  if (reason.startsWith("work_unit_scope_gap:")) return true;
  if (reason.startsWith("outside_workspace_path:") && runSummary?.status === "complete") return true;
  return false;
}

function maxBuiltInsBeforeChalinForCase(testCase: ChalinOrchestrationEvalCase): number {
  if (process.env.PI_CHALIN_EVAL_MAX_BUILTINS_BEFORE_CHALIN !== undefined) return thresholds.maxBuiltInsBeforeChalin;
  if (testCase.preRouteInspection === "minimal-if-needed") return 3;
  return 0;
}

function failureReason(testCase: ChalinOrchestrationEvalCase, actualDecision: string, actualTopology: string, agents: string[], status: number | null, signal: NodeJS.Signals | null, timeoutReason: string | undefined, stderr: string, thresholdFailures: string[]): string {
  if (timeoutReason) return timeoutReason;
  if (signal) return `pi was killed by ${signal}`;
  if (status !== 0) return `pi exited with ${status}: ${snippet(stderr, 500)}`;
  if (actualDecision !== testCase.expectedDecision) return `expected ${testCase.expectedDecision}, got ${actualDecision}`;
  if (!acceptedTopologies(testCase).some((topology) => topologyMatches(topology, actualTopology))) return `expected topology ${acceptedTopologies(testCase).join(" or ")}, got ${actualTopology}`;
  if (thresholdFailures.length) return `threshold failures: ${thresholdFailures.join("; ")}`;
  return `missing expected agent set: ${acceptedAgentSets(testCase).map((set) => `[${set.join(", ")}]`).join(" or ")}`;
}


function parseCliArgs(args: string[]): {
  runner?: "mock" | "sdk";
  limit?: string;
  timeoutMs?: string;
  startTimeoutMs?: string;
  idleTimeoutMs?: string;
  chalinToolTimeoutMs?: string;
  postChalinIdleTimeoutMs?: string;
} {
  const result: ReturnType<typeof parseCliArgs> = {};
  for (const arg of args) {
    const [rawKey, value = ""] = arg.replace(/^--/, "").split("=", 2);
    if (rawKey === "runner" && (value === "mock" || value === "sdk")) result.runner = value;
    else if (rawKey === "limit") result.limit = value;
    else if (rawKey === "timeout-ms") result.timeoutMs = value;
    else if (rawKey === "start-timeout-ms") result.startTimeoutMs = value;
    else if (rawKey === "idle-timeout-ms") result.idleTimeoutMs = value;
    else if (rawKey === "chalin-tool-timeout-ms") result.chalinToolTimeoutMs = value;
    else if (rawKey === "post-chalin-idle-timeout-ms") result.postChalinIdleTimeoutMs = value;
  }
  return result;
}

function selectCases(cases: ChalinOrchestrationEvalCase[]): ChalinOrchestrationEvalCase[] {
  const ids = process.env.PI_CHALIN_EVAL_CASES?.split(",").map((id) => id.trim()).filter(Boolean);
  if (!ids?.length) return cases;
  const allowed = new Set(ids);
  return cases.filter((testCase) => allowed.has(testCase.id));
}

function makeFixtureRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-chalin-eval-"));
  fs.mkdirSync(path.join(dir, "src", "auth"), { recursive: true });
  fs.mkdirSync(path.join(dir, "components"), { recursive: true });
  fs.mkdirSync(path.join(dir, "cmd", "api"), { recursive: true });
  fs.mkdirSync(path.join(dir, "internal", "auth"), { recursive: true });
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ scripts: { test: "bun test" }, dependencies: { vue: "^3.5.0", nuxt: "^3.15.0" }, devDependencies: {} }, null, 2));
  fs.writeFileSync(path.join(dir, "go.mod"), "module example.com/eval\n\ngo 1.24\n");
  fs.writeFileSync(path.join(dir, "README.md"), "# Eval fixture\n\nSmall Nuxt/Vue project used by pi-chalin orchestration evals.\n");
  fs.writeFileSync(path.join(dir, "src", "auth", "keycloak.ts"), "export function refreshToken(url: string) { return `${url}/token`; }\n");
  fs.writeFileSync(path.join(dir, "components", "LegacyWidget.vue"), "<script>export default { name: 'LegacyWidget', data: () => ({ open: false }) }</script>\n<template><button>Legacy</button></template>\n");
  fs.writeFileSync(path.join(dir, "cmd", "api", "main.go"), "package main\n\nfunc main() {}\n");
  fs.writeFileSync(path.join(dir, "internal", "auth", "refresh.go"), "package auth\n\nfunc RefreshURL(base string) string { return base + \"/token\" }\n");
  git(dir, ["init"]);
  git(dir, ["config", "user.email", "pi-chalin-eval@example.com"]);
  git(dir, ["config", "user.name", "pi-chalin Eval"]);
  git(dir, ["add", "."]);
  git(dir, ["commit", "-m", "initial fixture"]);
  fs.writeFileSync(path.join(dir, "src", "auth", "keycloak.ts"), "export function refreshToken(url: string) {\n  const normalized = url.replace(/\\/protocol\\/openid-connect\\/token$/, '');\n  return `${normalized}/protocol/openid-connect/token`;\n}\n");
  fs.writeFileSync(path.join(dir, "src", "auth", "keycloak.test.ts"), "import { expect, test } from 'bun:test';\nimport { refreshToken } from './keycloak';\ntest('normalizes token urls', () => { expect(refreshToken('https://id')).toContain('/token'); });\n");
  fs.writeFileSync(path.join(dir, "internal", "auth", "refresh_test.go"), "package auth\n\nimport \"testing\"\n\nfunc TestRefreshURL(t *testing.T) { if RefreshURL(\"https://id\") == \"\" { t.Fatal(\"empty\") } }\n");
  git(dir, ["checkout", "-b", "test/keycloak-refresh-token-url"]);
  git(dir, ["add", "."]);
  git(dir, ["commit", "-m", "fix keycloak refresh token url"]);
  return dir;
}

function git(cwd: string, args: string[]): void {
  const result = spawnSync("git", args, { cwd, encoding: "utf-8" });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
}

function extractMetrics(stdout: string, stderr: string): EvalMetrics {
  const responseIds = new Set<string>();
  const toolIds = new Set<string>();
  const toolOrder: string[] = [];
  const callsByName: Record<string, number> = {};
  const usage = emptyUsage();
  const childUsage = emptyUsage();
  const childCallsByName: Record<string, number> = {};
  let childToolCalls = 0;
  const policy = { violations: 0, violationReasons: [] as string[], budgetStops: 0, duplicateReadCount: 0, filesRead: 0 };
  let eventCount = 0;

  for (const line of stdout.split("\n")) {
    if (!line.trim()) continue;
    let event: unknown;
    try {
      event = JSON.parse(line) as unknown;
    } catch {
      continue;
    }
    eventCount += 1;
    const record = isRecord(event) ? event : {};
    if (record.type === "message_end") {
      const message = isRecord(record.message) ? record.message : undefined;
      if (message?.role === "assistant") addUsageOnce(message, responseIds, usage);
      if (message?.role === "toolResult" && message.toolName === "chalin_route") {
        const child = extractChildRunMetrics(message);
        addUsage(childUsage, child.usage);
        childToolCalls += child.toolCalls;
        for (const [name, count] of Object.entries(child.toolCallsByName)) childCallsByName[name] = (childCallsByName[name] ?? 0) + count;
        policy.violations += child.policyViolations;
        policy.violationReasons.push(...child.policyViolationReasons);
        policy.budgetStops += child.budgetStopCount;
        policy.duplicateReadCount += child.duplicateReadCount;
        policy.filesRead += child.filesRead;
      }
    }
    for (const call of findToolCalls(event)) {
      const id = call.id || `${call.name}-${toolIds.size}`;
      if (toolIds.has(id)) continue;
      toolIds.add(id);
      toolOrder.push(call.name);
      callsByName[call.name] = (callsByName[call.name] ?? 0) + 1;
    }
  }

  const decisionIndex = toolOrder.findIndex(isDecisionTool);
  const builtInCallsBeforeDecision = decisionIndex < 0 ? toolOrder.filter(isBuiltInTool).length : toolOrder.slice(0, decisionIndex).filter(isBuiltInTool).length;
  const totalCalls = toolOrder.length;
  const combinedUsage = cloneUsage(usage);
  addUsage(combinedUsage, childUsage);
  return {
    usage,
    childUsage,
    combinedUsage,
    tools: {
      totalCalls,
      chalinRouteCalls: callsByName.chalin_route ?? 0,
      builtInCalls: toolOrder.filter(isBuiltInTool).length,
      callsByName,
      firstTool: toolOrder[0],
      builtInCallsBeforeDecision,
    },
    childTools: { totalCalls: childToolCalls, callsByName: childCallsByName },
    policy,
    eventCount,
    stdoutBytes: Buffer.byteLength(stdout),
    stderrBytes: Buffer.byteLength(stderr),
  };
}

function summarizeMetrics(results: EvalResult[]) {
  const usage = emptyUsage();
  const childUsage = emptyUsage();
  const combinedUsage = emptyUsage();
  const callsByName: Record<string, number> = {};
  const childCallsByName: Record<string, number> = {};
  let totalToolCalls = 0;
  let chalinRouteCalls = 0;
  let builtInCalls = 0;
  let builtInCallsBeforeDecision = 0;
  let childToolCalls = 0;
  let policyViolations = 0;
  const policyViolationReasons: string[] = [];
  let budgetStops = 0;
  let duplicateReadCount = 0;
  let filesRead = 0;
  let durationMs = 0;
  let stdoutBytes = 0;
  let stderrBytes = 0;
  for (const result of results) {
    addUsage(usage, result.metrics.usage);
    addUsage(childUsage, result.metrics.childUsage);
    addUsage(combinedUsage, result.metrics.combinedUsage);
    childToolCalls += result.metrics.childTools.totalCalls;
    policyViolations += result.metrics.policy.violations;
    policyViolationReasons.push(...result.metrics.policy.violationReasons);
    budgetStops += result.metrics.policy.budgetStops;
    duplicateReadCount += result.metrics.policy.duplicateReadCount;
    filesRead += result.metrics.policy.filesRead;
    for (const [name, count] of Object.entries(result.metrics.childTools.callsByName)) childCallsByName[name] = (childCallsByName[name] ?? 0) + count;
    totalToolCalls += result.metrics.tools.totalCalls;
    chalinRouteCalls += result.metrics.tools.chalinRouteCalls;
    builtInCalls += result.metrics.tools.builtInCalls;
    builtInCallsBeforeDecision += result.metrics.tools.builtInCallsBeforeDecision;
    durationMs += result.durationMs;
    stdoutBytes += result.metrics.stdoutBytes;
    stderrBytes += result.metrics.stderrBytes;
    for (const [name, count] of Object.entries(result.metrics.tools.callsByName)) callsByName[name] = (callsByName[name] ?? 0) + count;
  }
  return {
    durationMs,
    averageDurationMs: results.length ? Math.round(durationMs / results.length) : 0,
    usage,
    childUsage,
    combinedUsage,
    tools: { totalToolCalls, chalinRouteCalls, builtInCalls, builtInCallsBeforeDecision, callsByName },
    childTools: { totalToolCalls: childToolCalls, callsByName: childCallsByName },
    policy: { violations: policyViolations, violationReasons: policyViolationReasons, budgetStops, duplicateReadCount, filesRead },
    io: { stdoutBytes, stderrBytes },
  };
}

function extractChildRunMetrics(message: Record<string, unknown>): { usage: UsageTotals; toolCalls: number; toolCallsByName: Record<string, number>; policyViolations: number; policyViolationReasons: string[]; budgetStopCount: number; duplicateReadCount: number; filesRead: number } {
  const usage = emptyUsage();
  const toolCallsByName: Record<string, number> = {};
  let toolCalls = 0;
  const details = isRecord(message.details) ? message.details : undefined;
  const result = isRecord(details?.result) ? details.result : undefined;
  const run = isRecord(result?.run) ? result.run : isRecord(details?.run) ? details.run : undefined;
  const metrics = isRecord(run?.metrics) ? run.metrics : undefined;
  if (isRecord(metrics?.usage)) addUsage(usage, usageFromUsageRecord(metrics.usage));
  toolCalls = numberValue(metrics?.toolCalls);
  if (isRecord(metrics?.toolCallsByName)) {
    for (const [name, count] of Object.entries(metrics.toolCallsByName)) toolCallsByName[name] = numberValue(count);
  }
  const policyViolationReasons = Array.isArray(metrics?.policyViolations)
    ? metrics.policyViolations.filter((item): item is string => typeof item === "string")
    : [];
  return {
    usage,
    toolCalls,
    toolCallsByName,
    policyViolations: policyViolationReasons.length,
    policyViolationReasons,
    budgetStopCount: numberValue(metrics?.budgetStopCount),
    duplicateReadCount: numberValue(metrics?.duplicateReadCount),
    filesRead: Array.isArray(metrics?.filesRead) ? metrics.filesRead.length : 0,
  };
}

function augmentMetricsWithPersistedRun(metrics: EvalMetrics, runSummary: EvalRunSummary | undefined): EvalMetrics {
  if (!runSummary?.runPath) return metrics;
  if (metrics.childUsage.totalTokens > 0 || metrics.childTools.totalCalls > 0) return metrics;
  const partial = extractPersistedRunMetrics(runSummary.runPath);
  if (!partial || (partial.usage.totalTokens === 0 && partial.toolCalls === 0)) return metrics;
  const childUsage = partial.usage;
  const combinedUsage = cloneUsage(metrics.usage);
  addUsage(combinedUsage, childUsage);
  return {
    ...metrics,
    childUsage,
    combinedUsage,
    childTools: { totalCalls: partial.toolCalls, callsByName: partial.toolCallsByName },
    policy: {
      violations: metrics.policy.violations + partial.policyViolations,
      violationReasons: [...metrics.policy.violationReasons, ...partial.policyViolationReasons],
      budgetStops: metrics.policy.budgetStops + partial.budgetStopCount,
      duplicateReadCount: metrics.policy.duplicateReadCount + partial.duplicateReadCount,
      filesRead: metrics.policy.filesRead + partial.filesRead,
    },
  };
}

function extractPersistedRunMetrics(file: string): ReturnType<typeof extractChildRunMetrics> | undefined {
  if (!fs.existsSync(file)) return undefined;
  const run = JSON.parse(fs.readFileSync(file, "utf-8")) as { metrics?: unknown; steps?: Array<{ metrics?: unknown }> };
  const stepMetrics = Array.isArray(run.steps)
    ? run.steps.map((step) => isRecord(step.metrics) ? step.metrics : undefined).filter((item): item is Record<string, unknown> => Boolean(item))
    : [];
  if (stepMetrics.length > 0) return aggregateRunMetrics(stepMetrics);
  return isRecord(run.metrics) ? aggregateRunMetrics([run.metrics]) : undefined;
}

function aggregateRunMetrics(items: Record<string, unknown>[]): ReturnType<typeof extractChildRunMetrics> {
  const usage = emptyUsage();
  const toolCallsByName: Record<string, number> = {};
  const policyViolationReasons: string[] = [];
  let toolCalls = 0;
  let budgetStopCount = 0;
  let duplicateReadCount = 0;
  let filesRead = 0;
  for (const metrics of items) {
    if (isRecord(metrics.usage)) addUsage(usage, usageFromUsageRecord(metrics.usage));
    toolCalls += numberValue(metrics.toolCalls);
    if (isRecord(metrics.toolCallsByName)) {
      for (const [name, count] of Object.entries(metrics.toolCallsByName)) toolCallsByName[name] = (toolCallsByName[name] ?? 0) + numberValue(count);
    }
    if (Array.isArray(metrics.policyViolations)) {
      policyViolationReasons.push(...metrics.policyViolations.filter((item): item is string => typeof item === "string"));
    }
    budgetStopCount += numberValue(metrics.budgetStopCount);
    duplicateReadCount += numberValue(metrics.duplicateReadCount);
    filesRead += Array.isArray(metrics.filesRead) ? metrics.filesRead.length : 0;
  }
  return {
    usage,
    toolCalls,
    toolCallsByName,
    policyViolations: policyViolationReasons.length,
    policyViolationReasons,
    budgetStopCount,
    duplicateReadCount,
    filesRead,
  };
}

function usageFromUsageRecord(raw: Record<string, unknown>): UsageTotals {
  const cost = isRecord(raw.cost) ? raw.cost : {};
  return {
    input: numberValue(raw.input),
    output: numberValue(raw.output),
    cacheRead: numberValue(raw.cacheRead),
    cacheWrite: numberValue(raw.cacheWrite),
    totalTokens: numberValue(raw.totalTokens),
    cost: { input: numberValue(cost.input), output: numberValue(cost.output), cacheRead: numberValue(cost.cacheRead), cacheWrite: numberValue(cost.cacheWrite), total: numberValue(cost.total) },
  };
}

function cloneUsage(source: UsageTotals): UsageTotals {
  return { input: source.input, output: source.output, cacheRead: source.cacheRead, cacheWrite: source.cacheWrite, totalTokens: source.totalTokens, cost: { ...source.cost } };
}

function emptyUsage(): UsageTotals {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
}

function addUsageOnce(message: Record<string, unknown>, responseIds: Set<string>, target: UsageTotals): void {
  const responseId = typeof message.responseId === "string" ? message.responseId : undefined;
  if (responseId && responseIds.has(responseId)) return;
  const rawUsage = isRecord(message.usage) ? message.usage : undefined;
  if (!rawUsage) return;
  if (responseId) responseIds.add(responseId);
  const usage: UsageTotals = {
    input: numberValue(rawUsage.input),
    output: numberValue(rawUsage.output),
    cacheRead: numberValue(rawUsage.cacheRead),
    cacheWrite: numberValue(rawUsage.cacheWrite),
    totalTokens: numberValue(rawUsage.totalTokens),
    cost: {
      input: numberValue(isRecord(rawUsage.cost) ? rawUsage.cost.input : undefined),
      output: numberValue(isRecord(rawUsage.cost) ? rawUsage.cost.output : undefined),
      cacheRead: numberValue(isRecord(rawUsage.cost) ? rawUsage.cost.cacheRead : undefined),
      cacheWrite: numberValue(isRecord(rawUsage.cost) ? rawUsage.cost.cacheWrite : undefined),
      total: numberValue(isRecord(rawUsage.cost) ? rawUsage.cost.total : undefined),
    },
  };
  addUsage(target, usage);
}

function addUsage(target: UsageTotals, source: UsageTotals): void {
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

function findToolCalls(value: unknown): Array<{ id?: string; name: string }> {
  const found: Array<{ id?: string; name: string }> = [];
  const visit = (node: unknown) => {
    if (Array.isArray(node)) {
      for (const item of node) visit(item);
      return;
    }
    if (!isRecord(node)) return;
    if (node.type === "toolCall" && typeof node.name === "string") {
      found.push({ id: typeof node.id === "string" ? node.id : undefined, name: node.name });
    }
    if (node.type === "toolcall_start" && isRecord(node.partial)) visit(node.partial);
    for (const value of Object.values(node)) {
      if (typeof value === "object" && value !== null) visit(value);
    }
  };
  visit(value);
  return found;
}

function isChalinRouteStartEvent(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return value.type === "tool_execution_start" && value.toolName === "chalin_route";
}

function isChalinRouteResultEvent(value: unknown): boolean {
  if (!isRecord(value)) return false;
  if (value.type === "tool_execution_end" && value.toolName === "chalin_route") return true;
  const message = isRecord(value.message) ? value.message : undefined;
  return value.type === "message_end" && message?.role === "toolResult" && message.toolName === "chalin_route";
}

function chalinRouteProgressSignature(value: unknown): string | undefined {
  if (!isRecord(value) || value.type !== "tool_execution_update" || value.toolName !== "chalin_route") return undefined;
  const partialResult = isRecord(value.partialResult) ? value.partialResult : undefined;
  const details = isRecord(partialResult?.details) ? partialResult.details : undefined;
  const run = isRecord(details?.run) ? details.run : undefined;
  if (!run) return undefined;
  const steps = Array.isArray(run.steps) ? run.steps.map((step) => {
    const item = isRecord(step) ? step : {};
    const handoff = typeof item.handoff === "string" ? item.handoff : "";
    return {
      id: item.id,
      agent: item.agent,
      status: item.status,
      workUnitId: item.workUnitId,
      handoffLength: handoff.length,
    };
  }) : [];
  const recoveryState = isRecord(run.recoveryState) ? run.recoveryState : undefined;
  return JSON.stringify({
    status: run.status,
    steps,
    pendingUnits: Array.isArray(recoveryState?.pendingUnits) ? recoveryState.pendingUnits : [],
    reviewersNotRun: Array.isArray(recoveryState?.reviewersNotRun) ? recoveryState.reviewersNotRun : [],
  });
}

function eventToolNameOf(value: unknown): string | undefined {
  if (!isRecord(value)) return undefined;
  if (typeof value.toolName === "string") return value.toolName;
  const message = isRecord(value.message) ? value.message : undefined;
  return typeof message?.toolName === "string" ? message.toolName : undefined;
}

function isDecisionTool(name: string): boolean {
  return DECISION_TOOL_NAMES.has(name);
}

function isBuiltInTool(name: string): boolean {
  return ["read", "bash", "grep", "find", "ls", "edit", "write"].includes(name);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function numberValue(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function positiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

function optionalPositiveInt(value: string | undefined): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : null;
}

function positiveNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

function positiveFloat(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function signalNumber(signal: NodeJS.Signals): number {
  if (signal === "SIGINT") return 2;
  if (signal === "SIGTERM") return 15;
  return 1;
}

function snippet(text: string, max = 1400): string {
  const normalized = text.replace(/\u001b\[[0-9;]*m/g, "").replace(/\s+/g, " ").trim();
  return normalized.length <= max ? normalized : `${normalized.slice(0, max - 1)}…`;
}

function stamp(value: string): string {
  return value.replace(/[:.]/g, "-");
}

function printReport(reportPath: string, results: EvalResult[]): void {
  const passed = results.filter((result) => result.pass).length;
  console.log(`pi-chalin orchestration evals: ${passed}/${results.length} passed`);
  console.log(`report: ${reportPath}`);
  for (const result of results) {
    const icon = result.pass ? "✓" : "✖";
    console.log(`${icon} ${result.id}: expected ${result.expectedDecision}/${result.expectedTopology}, got ${result.actualDecision}/${result.actualTopology} (${result.durationMs}ms)`);
    console.log(`  tools=${result.metrics.tools.totalCalls} chalin=${result.metrics.tools.chalinRouteCalls} builtins=${result.metrics.tools.builtInCalls} parentTokens=${result.metrics.usage.totalTokens} childTokens=${result.metrics.childUsage.totalTokens} combinedCost=$${result.metrics.combinedUsage.cost.total.toFixed(4)} policyViolations=${result.metrics.policy.violations} budgetStops=${result.metrics.policy.budgetStops}`);
    if (result.timeoutReason) console.log(`  timeout=${result.timeoutReason}`);
    if (result.thresholdFailures.length) console.log(`  thresholds: ${result.thresholdFailures.join("; ")}`);
    if (!result.pass) console.log(`  ${result.reason}`);
  }
}
