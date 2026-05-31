#!/usr/bin/env node
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  buildTraceJudgePrompt,
  gradePiTrace,
  parseTraceJudgeVerdict,
  type TraceJudgeVerdict,
  type TraceQualityReport,
  type TraceVariant,
} from "./trace-quality.ts";

export const DEFAULT_JUDGE_MODEL = "anthropic-vibeproxy/claude-opus-4-7";
export const DEFAULT_JUDGE_TIMEOUT_MS = 120_000;
export const MAX_JUDGE_TIMEOUT_MS = 300_000;

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

if (isMain()) await main();

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const startedAt = new Date().toISOString();
  const traceInput = readTraceInput(args);
  const stdout = traceInput.stdout;
  const variant = parseVariant(args.variant ?? "chalin");
  const finalText = args.final ? fs.readFileSync(path.resolve(args.final), "utf-8") : args.finalText ?? traceInput.finalText;
  const report = gradePiTrace(stdout, {
    variant,
    finalText,
    status: args.status === undefined ? undefined : Number(args.status),
    signal: args.signal ?? null,
    timeoutReason: args.timeoutReason,
    durationMs: args.durationMs ? Number(args.durationMs) : undefined,
    maxDurationMs: args.maxDurationMs ? Number(args.maxDurationMs) : undefined,
  });

  const judgeMode = args.judge ?? "none";
  const judge = judgeMode === "pi" ? await runPiJudge(report, { stdout, finalText }, {
    cwd: path.resolve(args.cwd ?? process.cwd()),
    model: args.model ?? DEFAULT_JUDGE_MODEL,
    timeoutMs: resolveJudgeTimeoutMs(args.judgeTimeoutMs),
  }) : null;

  const pass = report.pass && (!judge || judge.pass);
  const output = {
    startedAt,
    finishedAt: new Date().toISOString(),
    pass,
    deterministic: report,
    judge,
  };

  const reportDir = path.join(repoRoot, ".pi-chalin", "evals");
  fs.mkdirSync(reportDir, { recursive: true });
  const reportPath = path.join(reportDir, `trace-quality-${stamp(startedAt)}.json`);
  fs.writeFileSync(reportPath, `${JSON.stringify(output, null, 2)}\n`);

  console.log(`pi-chalin trace quality: ${pass ? "PASS" : "FAIL"}`);
  console.log(`deterministic=${report.score} critical=${report.critical.length} warnings=${report.warnings.length} source=${report.effectiveAnswerSource}`);
  if (judge) console.log(`judge=${judge.score} pass=${judge.pass} verdict=${judge.verdict}`);
  console.log(`report: ${reportPath}`);
  if (!pass && process.env.PI_CHALIN_TRACE_ALLOW_FAIL !== "1") process.exit(1);
}

export function resolveJudgeTimeoutMs(value: string | undefined): number {
  const parsed = Number(value ?? DEFAULT_JUDGE_TIMEOUT_MS);
  return Number.isFinite(parsed) && parsed > 0 ? Math.min(Math.floor(parsed), MAX_JUDGE_TIMEOUT_MS) : DEFAULT_JUDGE_TIMEOUT_MS;
}

export async function runPiJudge(report: TraceQualityReport, material: { stdout: string; finalText?: string }, options: { cwd: string; model?: string; timeoutMs?: number }): Promise<TraceJudgeVerdict & { timeoutMs: number; model: string }> {
  const model = options.model ?? DEFAULT_JUDGE_MODEL;
  const timeoutMs = resolveJudgeTimeoutMs(String(options.timeoutMs ?? DEFAULT_JUDGE_TIMEOUT_MS));
  const prompt = buildTraceJudgePrompt({
    report,
    finalTextSnippet: snippet(material.finalText ?? "", 6000),
    stdoutSnippet: snippet(material.stdout, 8000),
  });
  const text = await runPiJsonPrompt(prompt, { cwd: options.cwd, model, timeoutMs });
  return { ...parseTraceJudgeVerdict(text), timeoutMs, model };
}

function readTraceInput(args: Record<string, string>): { stdout: string; finalText?: string } {
  if (args.stdout) return { stdout: fs.readFileSync(path.resolve(args.stdout), "utf-8") };
  if (args.report) {
    const report = JSON.parse(fs.readFileSync(path.resolve(args.report), "utf-8")) as { outputs?: Array<{ variant?: string; stdout?: string; finalText?: string }> };
    const variant = args.variant ?? "chalin";
    const output = report.outputs?.find((item) => item.variant === variant);
    if (!output) throw new Error(`Report does not contain output for variant ${variant}`);
    if (output.stdout) return { stdout: output.stdout, finalText: output.finalText };
    if (args.allowFinalOnly === "1" && output.finalText) return { stdout: output.finalText, finalText: output.finalText };
    throw new Error("Report output lacks stdout. Re-run quality eval with PI_CHALIN_QUALITY_STORE_FULL_OUTPUT=1 for real trace grading, or pass --allowFinalOnly=1 knowingly for degraded final-text-only grading.");
  }
  throw new Error("trace-quality eval requires --stdout=<file> or --report=<quality-report.json>");
}

function runPiJsonPrompt(prompt: string, options: { cwd: string; model: string; timeoutMs: number }): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("pi", [
      "-p",
      "--no-session",
      "--mode",
      "json",
      "--no-context-files",
      "--no-skills",
      "--tools",
      "read",
      "--model",
      options.model,
      "--thinking",
      "minimal",
      prompt,
    ], {
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
      else resolve(extractAssistantText(stdout) || stdout);
    };
    const timer = setTimeout(() => {
      killProcessTree(child.pid, "SIGTERM");
      setTimeout(() => child.exitCode === null && killProcessTree(child.pid, "SIGKILL"), 1_000).unref();
      finish(new Error(`judge timeout after ${options.timeoutMs}ms`));
    }, options.timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
    child.on("error", (error) => finish(error));
    child.on("close", (status) => {
      if (status === 0) finish();
      else finish(new Error(`judge exited with status ${status}: ${snippet(stderr, 1000)}`));
    });
  });
}

function extractAssistantText(stdout: string): string {
  const texts: string[] = [];
  let current = "";
  for (const line of stdout.split(/\r?\n/).filter(Boolean)) {
    try {
      const parsed = JSON.parse(line) as { type?: string; message?: { role?: string; content?: unknown }; assistantMessageEvent?: { type?: string; delta?: string; content?: string } };
      if (parsed.type === "message_start" && parsed.message?.role === "assistant") current = "";
      if (parsed.assistantMessageEvent?.type === "text_delta" && typeof parsed.assistantMessageEvent.delta === "string") current += parsed.assistantMessageEvent.delta;
      if (parsed.assistantMessageEvent?.type === "text_end" && typeof parsed.assistantMessageEvent.content === "string") current = parsed.assistantMessageEvent.content;
      if ((parsed.type === "message_end" || parsed.type === "turn_end") && parsed.message?.role === "assistant") {
        const messageText = contentToText(parsed.message.content) || current;
        if (messageText.trim()) texts.push(messageText.trim());
      }
    } catch {
      // Ignore progress lines.
    }
  }
  return texts.at(-1) ?? current.trim();
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

function parseVariant(value: string): TraceVariant {
  if (value === "simple" || value === "chalin" || value === "gentle") return value;
  throw new Error(`Unsupported trace variant: ${value}`);
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

function snippet(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}

function stamp(value: string): string {
  return value.replace(/[:.]/g, "-");
}

function isMain(): boolean {
  return Boolean(process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href);
}
