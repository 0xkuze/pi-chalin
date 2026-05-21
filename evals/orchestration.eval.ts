#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
  ORCHESTRATION_EVAL_CASES,
  summarizeOrchestrationEvalCases,
  type MeshExpectedTopology,
  type MeshOrchestrationEvalCase,
} from "../src/orchestration.ts";

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
  meshRouteCalls: number;
  builtInCalls: number;
  callsByName: Record<string, number>;
  firstTool?: string;
  builtInCallsBeforeMesh: number;
}

interface EvalMetrics {
  usage: UsageTotals;
  childUsage: UsageTotals;
  combinedUsage: UsageTotals;
  tools: ToolMetrics;
  childTools: { totalCalls: number; callsByName: Record<string, number> };
  policy: { violations: number; budgetStops: number; duplicateReadCount: number; filesRead: number };
  eventCount: number;
  stdoutBytes: number;
  stderrBytes: number;
}

interface EvalResult {
  id: string;
  prompt: string;
  expectedDecision: string;
  expectedTopology: MeshExpectedTopology;
  actualDecision: "mesh" | "direct" | "error";
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
  metrics: EvalMetrics;
}

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const extensionPath = path.join(repoRoot, "src", "index.ts");
const cli = parseCliArgs(process.argv.slice(2));
const evalRunner = cli.runner ?? process.env.PI_MESH_EVAL_RUNNER ?? "mock";
const sdkRunner = evalRunner === "sdk";
const timeoutMs = positiveInt(cli.timeoutMs ?? process.env.PI_MESH_EVAL_TIMEOUT_MS, sdkRunner ? 75_000 : 60_000);
const startTimeoutMs = positiveInt(cli.startTimeoutMs ?? process.env.PI_MESH_EVAL_START_TIMEOUT_MS, timeoutMs);
const idleTimeoutMs = positiveInt(cli.idleTimeoutMs ?? process.env.PI_MESH_EVAL_IDLE_TIMEOUT_MS, sdkRunner ? 30_000 : 30_000);
const postMeshIdleTimeoutMs = positiveInt(cli.postMeshIdleTimeoutMs ?? process.env.PI_MESH_EVAL_POST_MESH_IDLE_TIMEOUT_MS, sdkRunner ? 8_000 : 5_000);
const meshToolTimeoutMs = positiveInt(cli.meshToolTimeoutMs ?? process.env.PI_MESH_EVAL_MESH_TOOL_TIMEOUT_MS, sdkRunner ? 60_000 : 30_000);
const thresholds = {
  maxDurationMs: positiveInt(process.env.PI_MESH_EVAL_MAX_DURATION_MS, timeoutMs),
  maxCombinedCost: positiveFloat(process.env.PI_MESH_EVAL_MAX_COMBINED_COST, sdkRunner ? 0.25 : Number.POSITIVE_INFINITY),
  maxChildToolCalls: positiveInt(process.env.PI_MESH_EVAL_MAX_CHILD_TOOL_CALLS, sdkRunner ? 30 : Number.POSITIVE_INFINITY),
  maxChildTokens: positiveInt(process.env.PI_MESH_EVAL_MAX_CHILD_TOKENS, sdkRunner ? 20_000 : Number.POSITIVE_INFINITY),
  maxPolicyViolations: positiveInt(process.env.PI_MESH_EVAL_MAX_POLICY_VIOLATIONS, 0),
  maxDuplicateReads: positiveInt(process.env.PI_MESH_EVAL_MAX_DUPLICATE_READS, 0),
  maxBuiltInsBeforeMesh: positiveInt(process.env.PI_MESH_EVAL_MAX_BUILTINS_BEFORE_MESH, 0),
};
const limit = positiveInt(cli.limit ?? process.env.PI_MESH_EVAL_LIMIT, ORCHESTRATION_EVAL_CASES.length);
const selected = selectCases(ORCHESTRATION_EVAL_CASES).slice(0, limit);
const fixture = makeFixtureRepo();
const startedAt = new Date().toISOString();
const results: EvalResult[] = [];

for (const testCase of selected) {
  console.log(`pi-mesh orchestration eval: ${testCase.id}…`);
  const result = await runCase(testCase);
  results.push(result);
  console.log(`${result.pass ? "✓" : "✗"} ${testCase.id} · ${result.actualDecision}/${result.actualTopology} · ${result.durationMs}ms`);
}

const passed = results.filter((result) => result.pass).length;
const failed = results.length - passed;
const meshActual = results.filter((result) => result.actualDecision === "mesh").length;
const directActual = results.filter((result) => result.actualDecision === "direct").length;
const metrics = summarizeMetrics(results);
const report = {
  startedAt,
  finishedAt: new Date().toISOString(),
  fixture,
  extensionPath,
  expected: summarizeOrchestrationEvalCases(selected),
  actual: { total: results.length, passed, failed, meshActual, directActual },
  metrics,
  thresholds,
  timeouts: { hardTimeoutMs: timeoutMs, startTimeoutMs, idleTimeoutMs, meshToolTimeoutMs, postMeshIdleTimeoutMs },
  command: "pi -p --no-session --mode json --no-context-files --no-skills --tools read,bash,grep,find,ls,mesh_route -e <extension> <prompt>",
  results,
};

const reportDir = path.join(repoRoot, ".pi-mesh", "evals");
fs.mkdirSync(reportDir, { recursive: true });
const reportPath = path.join(reportDir, `orchestration-${stamp(startedAt)}.json`);
fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf-8");

printReport(reportPath, results);

if (failed > 0 && process.env.PI_MESH_EVAL_ALLOW_FAIL !== "1") process.exit(1);

async function runCase(testCase: MeshOrchestrationEvalCase): Promise<EvalResult> {
  const started = Date.now();
  const args = [
    "-p",
    "--no-session",
    "--mode",
    "json",
    "--no-context-files",
    "--no-skills",
    "--tools",
    "read,bash,grep,find,ls,mesh_route",
    "-e",
    extensionPath,
  ];
  const model = process.env.PI_MESH_EVAL_MODEL;
  if (model) args.push("--model", model);
  const thinking = process.env.PI_MESH_EVAL_THINKING ?? "minimal";
  if (thinking) args.push("--thinking", thinking);
  args.push(testCase.prompt);

  const run = await runPi(args);

  const stdout = run.stdout;
  const stderr = run.stderr;
  const metrics = extractMetrics(stdout, stderr);
  const detectedDecision = detectDecision(stdout);
  const actualDecision = run.status === 0 || detectedDecision === "mesh" ? detectedDecision : "error";
  const actualTopology = detectTopology(stdout);
  const matchedExpectedAgents = testCase.expectedAgents.filter((agent) => hasAgent(stdout, agent));
  const durationMs = Date.now() - started;
  const topologyPass = testCase.expectedTopology === "none" ? actualTopology === "none" : topologyMatches(testCase.expectedTopology, actualTopology);
  const agentsPass = testCase.expectedAgents.length === 0 || matchedExpectedAgents.length === testCase.expectedAgents.length;
  const decisionPass = actualDecision === testCase.expectedDecision;
  const executionPass = run.status === 0 && !run.signal && !run.timeoutReason;
  const thresholdFailures = evaluateThresholds(testCase, metrics, durationMs);
  const pass = executionPass && decisionPass && topologyPass && agentsPass && thresholdFailures.length === 0;

  return {
    id: testCase.id,
    prompt: testCase.prompt,
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
    metrics,
  };
}

function runPi(args: string[]): Promise<{ stdout: string; stderr: string; status: number | null; signal: NodeJS.Signals | null; timeoutReason?: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn("pi", args, {
      cwd: fixture,
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
      env: {
      ...process.env,
      PI_MESH_RUNNER: evalRunner,
      PI_MESH_MOCK_STEP_DELAY_MS: "0",
      PI_TELEMETRY: "0",
    },
  });

    let stdout = "";
    let stderr = "";
    let timeoutReason: string | undefined;
    let settled = false;
    let meshResultTimer: NodeJS.Timeout | undefined;
    let lastOutputAt = Date.now();
    let sawOutput = false;
    let meshToolStartedAt: number | undefined;
    let sawMeshResult = false;
    const maxBytes = 20 * 1024 * 1024;

    const finish = (status: number | null, signal: NodeJS.Signals | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(hardTimer);
      clearInterval(progressTimer);
      if (meshResultTimer) clearTimeout(meshResultTimer);
      resolve({ stdout, stderr, status, signal, timeoutReason });
    };

    const finishAfterMeshResult = () => {
      if (settled || meshResultTimer) return;
      meshResultTimer = setTimeout(() => {
        if (child.exitCode === null) killProcessTree(child.pid, "SIGTERM");
        finish(0, null);
      }, 150);
      meshResultTimer.unref?.();
    };

    const kill = (reason: string) => {
      if (timeoutReason || settled) return;
      timeoutReason = reason;
      killProcessTree(child.pid, "SIGTERM");
      setTimeout(() => {
        if (child.exitCode === null) killProcessTree(child.pid, "SIGKILL");
      }, 1_000).unref();
    };

    const hardTimer = setTimeout(() => kill(`hard timeout after ${timeoutMs}ms`), timeoutMs);
    const progressTimer = setInterval(() => {
      const idleFor = Date.now() - lastOutputAt;
      if (!sawOutput && idleFor > startTimeoutMs) kill(`startup timeout after ${idleFor}ms without output`);
      else if (meshToolStartedAt && !sawMeshResult && idleFor > meshToolTimeoutMs) kill(`mesh_route idle timeout after ${idleFor}ms`);
      else if (sawMeshResult && idleFor > postMeshIdleTimeoutMs) kill(`post-mesh idle timeout after ${idleFor}ms`);
      else if (sawOutput && !meshToolStartedAt && idleFor > idleTimeoutMs) kill(`idle timeout after ${idleFor}ms`);
    }, 500);

    const append = (target: "stdout" | "stderr", chunk: Buffer) => {
      const text = chunk.toString();
      lastOutputAt = Date.now();
      sawOutput = true;
      if (target === "stdout") stdout += text;
      else stderr += text;
      if (stdout.length + stderr.length > maxBytes) kill(`output exceeded ${maxBytes} bytes`);
      const recent = stdout.slice(-20000);
      if (!meshToolStartedAt && /\"(?:name|toolName)\":\"mesh_route\"|Mesh workflow:/i.test(recent)) {
        meshToolStartedAt = Date.now();
      }
      if (/\"role\":\"toolResult\"[\s\S]*\"toolName\":\"mesh_route\"|\"toolName\":\"mesh_route\"[\s\S]*\"role\":\"toolResult\"|\"type\":\"tool_execution_end\"[\s\S]*\"toolName\":\"mesh_route\"|pi-mesh completed:/i.test(recent)) {
        sawMeshResult = true;
        finishAfterMeshResult();
      }
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

function detectDecision(stdout: string): "mesh" | "direct" {
  return /"(?:name|toolName)":"mesh_route"|Mesh workflow:|Subagent results:/i.test(stdout) ? "mesh" : "direct";
}

function detectTopology(stdout: string): string {
  const routeKinds = Array.from(stdout.matchAll(/"kind":"(single-agent|multi-agent-chain|multi-agent-parallel|multi-agent-dag|memory-only)"/gi), (match) => match[1]?.trim()).filter(Boolean);
  const routeKind = routeKinds.at(-1);
  if (routeKind) return routeKind;

  const topologies = Array.from(stdout.matchAll(/"topology":"(single|chain|parallel|dag|memory-only)"/gi), (match) => match[1]?.trim()).filter(Boolean);
  const topology = topologies.at(-1);
  if (topology === "single") return "single-agent";
  if (topology === "chain") return "multi-agent-chain";
  if (topology === "parallel") return "multi-agent-parallel";
  if (topology === "dag") return "multi-agent-dag";
  if (topology === "memory-only") return "memory-only";

  const workflow = stdout.match(/Mesh workflow:\s*([^\\n"]+)/i)?.[1]?.trim();
  if (workflow) return workflow;
  return "none";
}

function topologyMatches(expected: MeshExpectedTopology, actual: string): boolean {
  if (expected === "single") return actual === "single-agent";
  if (expected === "chain") return actual === "multi-agent-chain";
  if (expected === "parallel") return actual === "multi-agent-parallel" || actual === "multi-agent-dag";
  if (expected === "dag") return actual === "multi-agent-dag";
  if (expected === "memory-only") return actual === "memory-only";
  return actual === "none";
}

function hasAgent(stdout: string, agent: string): boolean {
  const escaped = escapeRegExp(agent);
  return new RegExp(`"agent":"${escaped}"|"agents":\\[[^\\]]*"${escaped}"`, "i").test(stdout);
}

function evaluateThresholds(testCase: MeshOrchestrationEvalCase, metrics: EvalMetrics, durationMs: number): string[] {
  const failures: string[] = [];
  if (durationMs > thresholds.maxDurationMs) failures.push(`duration ${durationMs}ms > ${thresholds.maxDurationMs}ms`);
  if (metrics.combinedUsage.cost.total > thresholds.maxCombinedCost) failures.push(`combined cost $${metrics.combinedUsage.cost.total.toFixed(4)} > $${thresholds.maxCombinedCost}`);
  if (metrics.childTools.totalCalls > thresholds.maxChildToolCalls) failures.push(`child tool calls ${metrics.childTools.totalCalls} > ${thresholds.maxChildToolCalls}`);
  if (metrics.childUsage.totalTokens > thresholds.maxChildTokens) failures.push(`child tokens ${metrics.childUsage.totalTokens} > ${thresholds.maxChildTokens}`);
  if (metrics.policy.violations > thresholds.maxPolicyViolations) failures.push(`policy violations ${metrics.policy.violations} > ${thresholds.maxPolicyViolations}`);
  if (metrics.policy.duplicateReadCount > thresholds.maxDuplicateReads) failures.push(`duplicate reads ${metrics.policy.duplicateReadCount} > ${thresholds.maxDuplicateReads}`);
  if (testCase.expectedDecision === "mesh" && metrics.tools.builtInCallsBeforeMesh > thresholds.maxBuiltInsBeforeMesh) failures.push(`built-ins before mesh ${metrics.tools.builtInCallsBeforeMesh} > ${thresholds.maxBuiltInsBeforeMesh}`);
  return failures;
}

function failureReason(testCase: MeshOrchestrationEvalCase, actualDecision: string, actualTopology: string, agents: string[], status: number | null, signal: NodeJS.Signals | null, timeoutReason: string | undefined, stderr: string, thresholdFailures: string[]): string {
  if (timeoutReason) return timeoutReason;
  if (signal) return `pi was killed by ${signal}`;
  if (status !== 0) return `pi exited with ${status}: ${snippet(stderr, 500)}`;
  if (actualDecision !== testCase.expectedDecision) return `expected ${testCase.expectedDecision}, got ${actualDecision}`;
  if (!topologyMatches(testCase.expectedTopology, actualTopology)) return `expected topology ${testCase.expectedTopology}, got ${actualTopology}`;
  if (thresholdFailures.length) return `threshold failures: ${thresholdFailures.join("; ")}`;
  return `missing expected agents: ${testCase.expectedAgents.filter((agent) => !agents.includes(agent)).join(", ")}`;
}


function parseCliArgs(args: string[]): {
  runner?: "mock" | "sdk";
  limit?: string;
  timeoutMs?: string;
  startTimeoutMs?: string;
  idleTimeoutMs?: string;
  meshToolTimeoutMs?: string;
  postMeshIdleTimeoutMs?: string;
} {
  const result: ReturnType<typeof parseCliArgs> = {};
  for (const arg of args) {
    const [rawKey, value = ""] = arg.replace(/^--/, "").split("=", 2);
    if (rawKey === "runner" && (value === "mock" || value === "sdk")) result.runner = value;
    else if (rawKey === "limit") result.limit = value;
    else if (rawKey === "timeout-ms") result.timeoutMs = value;
    else if (rawKey === "start-timeout-ms") result.startTimeoutMs = value;
    else if (rawKey === "idle-timeout-ms") result.idleTimeoutMs = value;
    else if (rawKey === "mesh-tool-timeout-ms") result.meshToolTimeoutMs = value;
    else if (rawKey === "post-mesh-idle-timeout-ms") result.postMeshIdleTimeoutMs = value;
  }
  return result;
}

function selectCases(cases: MeshOrchestrationEvalCase[]): MeshOrchestrationEvalCase[] {
  const ids = process.env.PI_MESH_EVAL_CASES?.split(",").map((id) => id.trim()).filter(Boolean);
  if (!ids?.length) return cases;
  const allowed = new Set(ids);
  return cases.filter((testCase) => allowed.has(testCase.id));
}

function makeFixtureRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-mesh-eval-"));
  fs.mkdirSync(path.join(dir, "src", "auth"), { recursive: true });
  fs.mkdirSync(path.join(dir, "components"), { recursive: true });
  fs.mkdirSync(path.join(dir, "cmd", "api"), { recursive: true });
  fs.mkdirSync(path.join(dir, "internal", "auth"), { recursive: true });
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ scripts: { test: "vitest run" }, dependencies: { vue: "^3.5.0", nuxt: "^3.15.0" }, devDependencies: { vitest: "^2.0.0" } }, null, 2));
  fs.writeFileSync(path.join(dir, "go.mod"), "module example.com/eval\n\ngo 1.24\n");
  fs.writeFileSync(path.join(dir, "README.md"), "# Eval fixture\n\nSmall Nuxt/Vue project used by pi-mesh orchestration evals.\n");
  fs.writeFileSync(path.join(dir, "src", "auth", "keycloak.ts"), "export function refreshToken(url: string) { return `${url}/token`; }\n");
  fs.writeFileSync(path.join(dir, "components", "LegacyWidget.vue"), "<script>export default { name: 'LegacyWidget', data: () => ({ open: false }) }</script>\n<template><button>Legacy</button></template>\n");
  fs.writeFileSync(path.join(dir, "cmd", "api", "main.go"), "package main\n\nfunc main() {}\n");
  fs.writeFileSync(path.join(dir, "internal", "auth", "refresh.go"), "package auth\n\nfunc RefreshURL(base string) string { return base + \"/token\" }\n");
  git(dir, ["init"]);
  git(dir, ["config", "user.email", "pi-mesh-eval@example.com"]);
  git(dir, ["config", "user.name", "pi-mesh Eval"]);
  git(dir, ["add", "."]);
  git(dir, ["commit", "-m", "initial fixture"]);
  fs.writeFileSync(path.join(dir, "src", "auth", "keycloak.ts"), "export function refreshToken(url: string) {\n  const normalized = url.replace(/\\/protocol\\/openid-connect\\/token$/, '');\n  return `${normalized}/protocol/openid-connect/token`;\n}\n");
  fs.writeFileSync(path.join(dir, "src", "auth", "keycloak.test.ts"), "import { refreshToken } from './keycloak';\ntest('normalizes token urls', () => { expect(refreshToken('https://id')).toContain('/token'); });\n");
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
  const policy = { violations: 0, budgetStops: 0, duplicateReadCount: 0, filesRead: 0 };
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
      if (message?.role === "toolResult" && message.toolName === "mesh_route") {
        const child = extractChildRunMetrics(message);
        addUsage(childUsage, child.usage);
        childToolCalls += child.toolCalls;
        for (const [name, count] of Object.entries(child.toolCallsByName)) childCallsByName[name] = (childCallsByName[name] ?? 0) + count;
        policy.violations += child.policyViolations;
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

  const meshIndex = toolOrder.indexOf("mesh_route");
  const builtInCallsBeforeMesh = meshIndex < 0 ? 0 : toolOrder.slice(0, meshIndex).filter(isBuiltInTool).length;
  const totalCalls = toolOrder.length;
  const combinedUsage = cloneUsage(usage);
  addUsage(combinedUsage, childUsage);
  return {
    usage,
    childUsage,
    combinedUsage,
    tools: {
      totalCalls,
      meshRouteCalls: callsByName.mesh_route ?? 0,
      builtInCalls: toolOrder.filter(isBuiltInTool).length,
      callsByName,
      firstTool: toolOrder[0],
      builtInCallsBeforeMesh,
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
  let meshRouteCalls = 0;
  let builtInCalls = 0;
  let builtInCallsBeforeMesh = 0;
  let childToolCalls = 0;
  let policyViolations = 0;
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
    budgetStops += result.metrics.policy.budgetStops;
    duplicateReadCount += result.metrics.policy.duplicateReadCount;
    filesRead += result.metrics.policy.filesRead;
    for (const [name, count] of Object.entries(result.metrics.childTools.callsByName)) childCallsByName[name] = (childCallsByName[name] ?? 0) + count;
    totalToolCalls += result.metrics.tools.totalCalls;
    meshRouteCalls += result.metrics.tools.meshRouteCalls;
    builtInCalls += result.metrics.tools.builtInCalls;
    builtInCallsBeforeMesh += result.metrics.tools.builtInCallsBeforeMesh;
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
    tools: { totalToolCalls, meshRouteCalls, builtInCalls, builtInCallsBeforeMesh, callsByName },
    childTools: { totalToolCalls: childToolCalls, callsByName: childCallsByName },
    policy: { violations: policyViolations, budgetStops, duplicateReadCount, filesRead },
    io: { stdoutBytes, stderrBytes },
  };
}

function extractChildRunMetrics(message: Record<string, unknown>): { usage: UsageTotals; toolCalls: number; toolCallsByName: Record<string, number>; policyViolations: number; budgetStopCount: number; duplicateReadCount: number; filesRead: number } {
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
  return {
    usage,
    toolCalls,
    toolCallsByName,
    policyViolations: Array.isArray(metrics?.policyViolations) ? metrics.policyViolations.length : 0,
    budgetStopCount: numberValue(metrics?.budgetStopCount),
    duplicateReadCount: numberValue(metrics?.duplicateReadCount),
    filesRead: Array.isArray(metrics?.filesRead) ? metrics.filesRead.length : 0,
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

function positiveFloat(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function snippet(text: string, max = 1400): string {
  const normalized = text.replace(/\u001b\[[0-9;]*m/g, "").replace(/\s+/g, " ").trim();
  return normalized.length <= max ? normalized : `${normalized.slice(0, max - 1)}…`;
}

function stamp(value: string): string {
  return value.replace(/[:.]/g, "-");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function printReport(reportPath: string, results: EvalResult[]): void {
  const passed = results.filter((result) => result.pass).length;
  console.log(`pi-mesh orchestration evals: ${passed}/${results.length} passed`);
  console.log(`report: ${reportPath}`);
  for (const result of results) {
    const icon = result.pass ? "✓" : "✖";
    console.log(`${icon} ${result.id}: expected ${result.expectedDecision}/${result.expectedTopology}, got ${result.actualDecision}/${result.actualTopology} (${result.durationMs}ms)`);
    console.log(`  tools=${result.metrics.tools.totalCalls} mesh=${result.metrics.tools.meshRouteCalls} builtins=${result.metrics.tools.builtInCalls} parentTokens=${result.metrics.usage.totalTokens} childTokens=${result.metrics.childUsage.totalTokens} combinedCost=$${result.metrics.combinedUsage.cost.total.toFixed(4)} policyViolations=${result.metrics.policy.violations} budgetStops=${result.metrics.policy.budgetStops}`);
    if (result.timeoutReason) console.log(`  timeout=${result.timeoutReason}`);
    if (result.thresholdFailures.length) console.log(`  thresholds: ${result.thresholdFailures.join("; ")}`);
    if (!result.pass) console.log(`  ${result.reason}`);
  }
}
