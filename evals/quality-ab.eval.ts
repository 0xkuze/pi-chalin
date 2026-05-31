#!/usr/bin/env node
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { type AnalysisQualityProfile, scoreAnalysisAnswer } from "./analysis-quality.ts";
import {
  createSyntheticQualityFixture,
  type SyntheticQualityFixture,
  type SyntheticQualityFixtureProfile,
} from "./quality-fixtures.ts";

export type Variant = "simple" | "chalin";

interface RunDiagnostics {
  stdoutBytes: number;
  stderrBytes: number;
  jsonEvents: number;
  assistantTextChars: number;
  toolResultEvents: number;
  chalinToolResultChars: number;
  lastEventType?: string;
  lastProgressAt: string;
}

interface RunOutput {
  variant: Variant;
  stdout: string;
  stderr: string;
  finalText: string;
  status: number | null;
  signal: NodeJS.Signals | null;
  timeoutReason?: string;
  durationMs: number;
  diagnostics?: RunDiagnostics;
}

export const DEFAULT_VARIANT_TIMEOUT_MS = 60_000;
export const MAX_VARIANT_TIMEOUT_MS = 60_000;

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const extensionPath = path.join(repoRoot, "src", "index.ts");

if (isMain()) await main();

async function main(): Promise<void> {
  const args = parseQualityArgs(process.argv.slice(2));
  const startedAt = new Date().toISOString();
  const mode = args.mode ?? process.env.PI_CHALIN_QUALITY_MODE ?? "files";
  const requestedTimeoutMs = args.timeoutMs ?? process.env.PI_CHALIN_QUALITY_TIMEOUT_MS;
  const variantTimeoutMs = resolveVariantTimeoutMs(requestedTimeoutMs);
  const variantsToRun = resolveVariantsToRun(args.variant ?? args.only ?? process.env.PI_CHALIN_QUALITY_VARIANT);
  const fixture = createFixtureFromArgs(args.fixture ?? process.env.PI_CHALIN_QUALITY_FIXTURE);
  if (fixture && process.env.PI_CHALIN_QUALITY_KEEP_FIXTURE !== "1") {
    process.on("exit", () => fs.rmSync(fixture.cwd, { recursive: true, force: true }));
  }
  const profile = parseProfile(args.profile ?? process.env.PI_CHALIN_QUALITY_PROFILE ?? fixture?.profile ?? "agent-tooling");
  const prompt = args.prompt ?? process.env.PI_CHALIN_QUALITY_PROMPT ?? fixture?.prompt ?? "revisa este proyecto dime que hace, en profundidad";

  const simplePath = args.simple ?? process.env.PI_CHALIN_QUALITY_SIMPLE_FILE;
  const chalinPath = args.chalin ?? process.env.PI_CHALIN_QUALITY_CHALIN_FILE;
  const targetCwd = path.resolve(args.cwd ?? process.env.PI_CHALIN_QUALITY_CWD ?? fixture?.cwd ?? process.cwd());

  const outputs = mode === "sdk"
    ? await runSdkComparison({ prompt, targetCwd, variantTimeoutMs, variantsToRun })
    : readFileComparison(simplePath, chalinPath, variantsToRun);

  const scores = Object.fromEntries(outputs.map((item) => [
    item.variant,
    scoreAnalysisAnswer(item.finalText, { profile }),
  ])) as Partial<Record<Variant, ReturnType<typeof scoreAnalysisAnswer>>>;
  const timedOut = outputs.some((item) => item.timeoutReason);
  const simpleScore = scores.simple;
  const chalinScore = scores.chalin;
  const pass = !timedOut && (simpleScore && chalinScore
    ? chalinScore.pass && chalinScore.score >= simpleScore.score
    : outputs.every((item) => scores[item.variant]?.pass));
  const report = {
    startedAt,
    finishedAt: new Date().toISOString(),
    mode,
    profile,
    variantsToRun,
    fixture: fixture ? { profile: fixture.profile, cwd: fixture.cwd } : null,
    prompt,
    targetCwd,
    extensionPath,
    pass,
    timeoutPolicy: mode === "sdk" ? {
      requestedTimeoutMs: requestedTimeoutMs ? Number(requestedTimeoutMs) : null,
      variantTimeoutMs,
      maxVariantTimeoutMs: MAX_VARIANT_TIMEOUT_MS,
      reason: "Live SDK quality evals must fail fast; >2 minutes total for simple+chalin indicates a performance or hang issue to investigate.",
    } : null,
    comparison: simpleScore && chalinScore ? {
      simple: simpleScore,
      chalin: chalinScore,
      scoreDelta: chalinScore.score - simpleScore.score,
      chalinBeatsSimple: chalinScore.score >= simpleScore.score,
    } : null,
    scores,
    outputs: outputs.map((item) => ({
      variant: item.variant,
      status: item.status,
      signal: item.signal,
      timeoutReason: item.timeoutReason,
      durationMs: item.durationMs,
      diagnostics: item.diagnostics,
      finalTextChars: item.finalText.length,
      finalTextSnippet: snippet(item.finalText, 1600),
      stderrSnippet: snippet(item.stderr, 1000),
      ...(process.env.PI_CHALIN_QUALITY_STORE_FULL_OUTPUT === "1"
        ? { finalText: item.finalText, stdout: item.stdout, stderr: item.stderr }
        : {}),
    })),
  };

  const reportDir = path.join(repoRoot, ".pi-chalin", "evals");
  fs.mkdirSync(reportDir, { recursive: true });
  const reportPath = path.join(reportDir, `quality-ab-${stamp(startedAt)}.json`);
  fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);

  console.log(`pi-chalin quality A/B: ${pass ? "PASS" : "FAIL"}`);
  if (simpleScore && chalinScore) {
    console.log(`simple=${simpleScore.score} chalin=${chalinScore.score} delta=${chalinScore.score - simpleScore.score}`);
    console.log(`simple missing: ${simpleScore.missingFacts.join(", ") || "none"}`);
    console.log(`chalin missing: ${chalinScore.missingFacts.join(", ") || "none"}`);
  } else {
    for (const variant of variantsToRun) {
      const score = scores[variant];
      if (!score) continue;
      console.log(`${variant}=${score.score}`);
      console.log(`${variant} missing: ${score.missingFacts.join(", ") || "none"}`);
    }
  }
  if (timedOut) console.log(`timeout: ${outputs.filter((item) => item.timeoutReason).map((item) => `${item.variant}: ${item.timeoutReason}`).join("; ")}`);
  console.log(`report: ${reportPath}`);

  if (!pass && process.env.PI_CHALIN_QUALITY_ALLOW_FAIL !== "1") process.exit(1);
}

export function resolveVariantTimeoutMs(value: string | undefined): number {
  const parsed = positiveInt(value, DEFAULT_VARIANT_TIMEOUT_MS);
  return Math.min(parsed, MAX_VARIANT_TIMEOUT_MS);
}

export function resolveVariantsToRun(value: string | undefined): Variant[] {
  if (!value || value === "both" || value === "all") return ["simple", "chalin"];
  if (value === "simple" || value === "chalin") return [value];
  throw new Error(`Unsupported quality eval variant: ${value}`);
}

function createFixtureFromArgs(value: string | undefined): SyntheticQualityFixture | undefined {
  if (!value) return undefined;
  return createSyntheticQualityFixture(parseSyntheticFixtureProfile(value));
}

function parseProfile(value: string): AnalysisQualityProfile {
  if (value === "agent-tooling" || value === "go-service" || value === "frontend-app" || value === "monorepo") return value;
  throw new Error(`Unsupported quality profile: ${value}`);
}

function parseSyntheticFixtureProfile(value: string): SyntheticQualityFixtureProfile {
  if (value === "go-service" || value === "frontend-app" || value === "monorepo") return value;
  throw new Error(`Unsupported synthetic fixture profile: ${value}`);
}

function readFileComparison(simpleFile: string | undefined, chalinFile: string | undefined, variantsToRun: Variant[]): RunOutput[] {
  const paths: Record<Variant, string | undefined> = { simple: simpleFile, chalin: chalinFile };
  const missing = variantsToRun.filter((variant) => !paths[variant]);
  if (missing.length > 0) {
    throw new Error(`files mode requires output files for: ${missing.join(", ")}`);
  }
  return variantsToRun.map((variant) => fileOutput(variant, paths[variant]!));
}

function fileOutput(variant: Variant, file: string): RunOutput {
  const finalText = fs.readFileSync(file, "utf-8");
  return { variant, stdout: finalText, stderr: "", finalText, status: 0, signal: null, durationMs: 0 };
}

async function runSdkComparison(config: { prompt: string; targetCwd: string; variantTimeoutMs: number; variantsToRun: Variant[] }): Promise<RunOutput[]> {
  const outputs: RunOutput[] = [];
  for (const variant of config.variantsToRun) outputs.push(await runPiVariant(variant, config));
  return outputs;
}

async function runPiVariant(variant: Variant, config: { prompt: string; targetCwd: string; variantTimeoutMs: number }): Promise<RunOutput> {
  const started = Date.now();
  const args = [
    "-p",
    "--no-session",
    "--mode",
    "json",
    "--no-context-files",
    "--no-skills",
    "--tools",
    variant === "chalin" ? "read,bash,grep,find,ls,chalin_route" : "read,bash,grep,find,ls",
  ];
  if (variant === "chalin") args.push("-e", extensionPath);
  const model = process.env.PI_CHALIN_QUALITY_MODEL;
  if (model) args.push("--model", model);
  const thinking = process.env.PI_CHALIN_QUALITY_THINKING ?? "minimal";
  if (thinking) args.push("--thinking", thinking);
  args.push(config.prompt);

  const run = await runPi(args, config.targetCwd, config.variantTimeoutMs, { finishOnChalinToolEnd: variant === "chalin" });
  const finalText = variant === "chalin"
    ? extractChalinToolResultText(run.stdout) || extractFinalText(run.stdout) || run.stdout
    : extractFinalText(run.stdout) || run.stdout;
  return { variant, ...run, finalText, durationMs: Date.now() - started };
}

function runPi(args: string[], cwd: string, variantTimeoutMs: number, options: { finishOnChalinToolEnd?: boolean } = {}): Promise<{ stdout: string; stderr: string; status: number | null; signal: NodeJS.Signals | null; timeoutReason?: string; diagnostics: RunDiagnostics }> {
  return new Promise((resolve, reject) => {
    const child = spawn("pi", args, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
      env: { ...process.env, PI_TELEMETRY: "0" },
    });
    let stdout = "";
    let stderr = "";
    let stdoutRemainder = "";
    let timeoutReason: string | undefined;
    let settled = false;
    let terminalEventTimer: NodeJS.Timeout | undefined;
    const diagnostics: RunDiagnostics = {
      stdoutBytes: 0,
      stderrBytes: 0,
      jsonEvents: 0,
      assistantTextChars: 0,
      toolResultEvents: 0,
      chalinToolResultChars: 0,
      lastProgressAt: new Date().toISOString(),
    };
    const markProgress = () => { diagnostics.lastProgressAt = new Date().toISOString(); };
    const finish = (status: number | null, signal: NodeJS.Signals | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (terminalEventTimer) clearTimeout(terminalEventTimer);
      resolve({ stdout, stderr, status, signal, timeoutReason, diagnostics });
    };
    const kill = () => {
      timeoutReason = `variant timeout after ${variantTimeoutMs}ms`;
      killProcessTree(child.pid, "SIGTERM");
      setTimeout(() => child.exitCode === null && killProcessTree(child.pid, "SIGKILL"), 1_000).unref();
    };
    const timer = setTimeout(kill, variantTimeoutMs);
    child.stdout.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      stdout += text;
      diagnostics.stdoutBytes += chunk.length;
      stdoutRemainder = observeJsonLines(stdoutRemainder + text, diagnostics);
      markProgress();
      if (options.finishOnChalinToolEnd && diagnostics.chalinToolResultChars > 0 && !terminalEventTimer) {
        terminalEventTimer = setTimeout(() => {
          if (child.exitCode === null) killProcessTree(child.pid, "SIGTERM");
          finish(0, null);
        }, 100);
        terminalEventTimer.unref?.();
      }
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
      diagnostics.stderrBytes += chunk.length;
      markProgress();
    });
    child.on("error", (error) => settled ? undefined : reject(error));
    child.on("close", (status, signal) => {
      observeJsonLines(`${stdoutRemainder}\n`, diagnostics);
      finish(status, signal);
    });
  });
}

function observeJsonLines(buffer: string, diagnostics: RunDiagnostics): string {
  const lines = buffer.split(/\r?\n/);
  const remainder = lines.pop() ?? "";
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line) as {
        type?: unknown;
        toolName?: unknown;
        result?: unknown;
        assistantMessageEvent?: { type?: unknown; delta?: unknown; content?: unknown };
        toolResults?: unknown[];
      };
      diagnostics.jsonEvents += 1;
      if (typeof parsed.type === "string") diagnostics.lastEventType = parsed.type;
      if (parsed.assistantMessageEvent?.type === "text_delta" && typeof parsed.assistantMessageEvent.delta === "string") {
        diagnostics.assistantTextChars += parsed.assistantMessageEvent.delta.length;
      }
      if (parsed.assistantMessageEvent?.type === "text_end" && typeof parsed.assistantMessageEvent.content === "string") {
        diagnostics.assistantTextChars = Math.max(diagnostics.assistantTextChars, parsed.assistantMessageEvent.content.length);
      }
      if (Array.isArray(parsed.toolResults)) diagnostics.toolResultEvents += parsed.toolResults.length;
      if (parsed.type === "tool_execution_end" && parsed.toolName === "chalin_route") {
        const text = toolResultToText(parsed.result);
        if (text.trim()) {
          diagnostics.toolResultEvents += 1;
          diagnostics.chalinToolResultChars = Math.max(diagnostics.chalinToolResultChars, text.length);
        }
      }
    } catch {
      // Non-JSON progress lines are ignored.
    }
  }
  return remainder;
}

export function extractFinalText(stdout: string): string {
  const lines = stdout.split(/\r?\n/).filter(Boolean);
  const assistantTexts: string[] = [];
  let currentAssistantText = "";
  for (const line of lines) {
    try {
      const parsed = JSON.parse(line) as {
        role?: unknown;
        content?: unknown;
        type?: unknown;
        text?: unknown;
        message?: { role?: unknown; content?: unknown };
        assistantMessageEvent?: { type?: unknown; delta?: unknown; content?: unknown };
      };

      if (parsed.type === "message_start" && parsed.message?.role === "assistant") currentAssistantText = "";

      if (parsed.type === "message_update") {
        if (parsed.assistantMessageEvent?.type === "text_delta" && typeof parsed.assistantMessageEvent.delta === "string") {
          currentAssistantText += parsed.assistantMessageEvent.delta;
        }
        if (parsed.assistantMessageEvent?.type === "text_end" && typeof parsed.assistantMessageEvent.content === "string") {
          currentAssistantText = parsed.assistantMessageEvent.content;
        }
        const updateText = contentToText(parsed.message?.content);
        if (updateText.trim()) currentAssistantText = updateText;
      }

      if ((parsed.type === "message_end" || parsed.type === "turn_end") && parsed.message?.role === "assistant") {
        const messageText = contentToText(parsed.message.content) || currentAssistantText;
        if (messageText.trim()) assistantTexts.push(messageText);
      }

      const content = parsed.content ?? parsed.text ?? parsed.message?.content;
      if (parsed.role === "assistant") {
        const directText = contentToText(content);
        if (directText.trim()) assistantTexts.push(directText);
      }
    } catch {
      // Non-JSON progress lines are ignored.
    }
  }
  return (assistantTexts.at(-1) || currentAssistantText).trim();
}

export function extractChalinToolResultText(stdout: string): string {
  const results: string[] = [];
  for (const line of stdout.split(/\r?\n/).filter(Boolean)) {
    try {
      const parsed = JSON.parse(line) as { type?: unknown; toolName?: unknown; result?: unknown };
      if (parsed.type === "tool_execution_end" && parsed.toolName === "chalin_route") {
        const text = toolResultToText(parsed.result);
        if (text.trim()) results.push(text);
      }
    } catch {
      // Non-JSON progress lines are ignored.
    }
  }
  return results.at(-1)?.trim() ?? "";
}

function toolResultToText(result: unknown): string {
  if (!result || typeof result !== "object") return "";
  const content = (result as { content?: unknown }).content;
  if (!Array.isArray(content)) return "";
  return content.map((part) => {
    if (typeof part === "string") return part;
    if (part && typeof part === "object" && "text" in part && typeof part.text === "string") return part.text;
    return "";
  }).join("");
}

function contentToText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((part) => {
    if (typeof part === "string") return part;
    if (part && typeof part === "object" && "text" in part && typeof part.text === "string") return part.text;
    return "";
  }).join("");
}

function killProcessTree(pid: number | undefined, signal: NodeJS.Signals): void {
  if (!pid) return;
  try {
    process.kill(-pid, signal);
  } catch {
    try {
      process.kill(pid, signal);
    } catch {
      // Already exited.
    }
  }
}

export function parseQualityArgs(items: string[]): Record<string, string> {
  const result: Record<string, string> = {};
  for (let index = 0; index < items.length; index += 1) {
    const item = items[index] ?? "";
    const match = item.match(/^--([^=]+)=(.+)$/);
    if (match?.[1] && match[2]) {
      result[match[1]] = match[2];
      continue;
    }
    const flag = item.match(/^--(.+)$/);
    const next = items[index + 1];
    if (flag?.[1] && next && !next.startsWith("--")) {
      result[flag[1]] = next;
      index += 1;
    }
  }
  return result;
}

function positiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

function snippet(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}

function stamp(value: string): string {
  return value.replace(/[:.]/g, "-");
}

function isMain(): boolean {
  return Boolean(process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href);
}
