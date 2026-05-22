import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import type { RunState } from "../src/schemas.ts";

const repoRoot = path.resolve(import.meta.dir, "..");
const extensionPath = path.join(repoRoot, "src", "index.ts");
const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "pi-chalin-resume-session-"));
const sessionDir = path.join(fixture, ".pi-sessions");
const startedAt = new Date().toISOString();

fs.writeFileSync(path.join(fixture, "README.md"), "# Resume fixture\n\nSmall project used to test interrupted pi-chalin workflows.\n");
fs.mkdirSync(path.join(fixture, "src"), { recursive: true });
fs.writeFileSync(path.join(fixture, "src", "index.ts"), "export function answer(): number { return 42; }\n");

const prompt = [
  "Analiza este mini proyecto en profundidad y usa un workflow de subagentes con scout, planner, worker y reviewer.",
  "La tarea debe dejar handoff suficiente para continuar si el proceso se interrumpe.",
].join(" ");

const report: Record<string, unknown> = {
  startedAt,
  fixture,
  sessionDir,
  extensionPath,
  command: "pi -p --session-dir <tmp> -e <extension> ...; kill; pi -p --session <parent-session> 'continua'",
  checks: [] as Array<{ id: string; pass: boolean; evidence?: string }>,
};

try {
  const first = spawnPi([
    "-p",
    "--mode",
    "json",
    "--no-context-files",
    "--no-skills",
    "--session-dir",
    sessionDir,
    "--tools",
    "chalin_route,chalin_resume",
    "--thinking",
    process.env.PI_CHALIN_EVAL_THINKING ?? "minimal",
    "-e",
    extensionPath,
    prompt,
  ], { mockDelayMs: 30_000 });

  const interrupted = await waitForInterruptedRun();
  addCheck("subagent-workflow-started", interrupted.run.status === "running" && interrupted.run.steps.some((step) => step.status === "running"), `${interrupted.run.id}:${interrupted.run.steps.map((step) => step.status).join(",")}`);
  addCheck("parent-session-file-created", Boolean(interrupted.parentSessionFile), interrupted.parentSessionFile);

  killProcessTree(first.child.pid, "SIGTERM");
  setTimeout(() => {
    if (first.child.exitCode === null) killProcessTree(first.child.pid, "SIGKILL");
  }, 1_000).unref();
  const firstResult = await first.result;
  addCheck("first-process-killed", firstResult.signal === "SIGTERM" || firstResult.signal === "SIGKILL" || firstResult.status !== 0, `status=${firstResult.status} signal=${firstResult.signal}`);

  const second = await runPi([
    "-p",
    "--mode",
    "json",
    "--no-context-files",
    "--no-skills",
    "--session-dir",
    sessionDir,
    "--session",
    interrupted.parentSessionFile,
    "--tools",
    "chalin_resume,chalin_route",
    "--thinking",
    process.env.PI_CHALIN_EVAL_THINKING ?? "minimal",
    "-e",
    extensionPath,
    "continua",
  ], { mockDelayMs: 5, timeoutMs: 160_000 });

  const latest = latestRun();
  const secondToolCalls = toolCalls(second.stdout);
  addCheck("resume-command-exited", second.status === 0, `status=${second.status} signal=${second.signal}\n${snippet(second.stderr)}`);
  addCheck("continua-called-chalin-resume", secondToolCalls.chalin_resume > 0, JSON.stringify(secondToolCalls));
  addCheck("continua-did-not-restart-route", (secondToolCalls.chalin_route ?? 0) === 0, JSON.stringify(secondToolCalls));
  addCheck("same-run-completed", latest?.id === interrupted.run.id && latest.status === "complete", latest ? `${latest.id}:${latest.status}:${latest.steps.map((step) => step.status).join(",")}` : "no latest run");
  addCheck("completed-handoffs-preserved", Boolean(latest?.steps.every((step) => step.status === "complete")), latest ? latest.steps.map((step) => `${step.agent}:${step.status}`).join(",") : "no latest run");

  finish();
} catch (error) {
  report.error = error instanceof Error ? error.stack ?? error.message : String(error);
  finish(1);
}

function spawnPi(args: string[], options: { mockDelayMs: number }): { child: ChildProcess; result: Promise<RunResult> } {
  const child = spawn("pi", argsWithModel(args), {
    cwd: fixture,
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
    env: envForRun(options.mockDelayMs),
  });

  let stdout = "";
  let stderr = "";
  child.stdout?.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
  child.stderr?.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });

  return {
    child,
    result: new Promise((resolve, reject) => {
      child.on("error", reject);
      child.on("close", (status, signal) => resolve({ stdout, stderr, status, signal }));
    }),
  };
}

function runPi(args: string[], options: { mockDelayMs: number; timeoutMs: number }): Promise<RunResult> {
  const started = spawnPi(args, options);
  const timeout = setTimeout(() => {
    killProcessTree(started.child.pid, "SIGTERM");
    setTimeout(() => {
      if (started.child.exitCode === null) killProcessTree(started.child.pid, "SIGKILL");
    }, 1_000).unref();
  }, options.timeoutMs);
  timeout.unref();
  return started.result.finally(() => clearTimeout(timeout));
}

async function waitForInterruptedRun(): Promise<{ run: RunState; parentSessionFile: string }> {
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    const run = latestRun();
    const parentSessionFile = latestParentSessionFile();
    if (run?.status === "running" && run.steps.some((step) => step.status === "running") && parentSessionFile) {
      return { run, parentSessionFile };
    }
    await sleep(250);
  }
  throw new Error(`Timed out waiting for interrupted run. latest=${JSON.stringify(latestRun())} sessions=${JSON.stringify(sessionFiles())}`);
}

function latestRun(): RunState | undefined {
  const runsDir = path.join(fixture, ".pi-chalin", "runs");
  if (!fs.existsSync(runsDir)) return undefined;
  const files = fs.readdirSync(runsDir)
    .filter((name) => name.endsWith(".json"))
    .map((name) => path.join(runsDir, name))
    .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
  for (const file of files) {
    try {
      return JSON.parse(fs.readFileSync(file, "utf-8")) as RunState;
    } catch {
      // Ignore transient writes while the subprocess is alive.
    }
  }
  return undefined;
}

function latestParentSessionFile(): string | undefined {
  return sessionFiles()
    .filter((file) => !file.includes(`${path.sep}pi-chalin${path.sep}`) && !file.includes(`${path.sep}.pi-chalin-hidden-child-sessions${path.sep}`))
    .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)[0];
}

function sessionFiles(): string[] {
  if (!fs.existsSync(sessionDir)) return [];
  const found: string[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith(".jsonl")) found.push(full);
    }
  };
  walk(sessionDir);
  return found;
}

function toolCalls(stdout: string): Record<string, number> {
  const calls: Record<string, number> = {};
  const seen = new Set<string>();
  for (const line of stdout.split("\n")) {
    if (!line.trim()) continue;
    try {
      collectToolCalls(JSON.parse(line), calls, seen);
    } catch {
      // Ignore non-JSON output.
    }
  }
  return calls;
}

function collectToolCalls(value: unknown, calls: Record<string, number>, seen: Set<string>): void {
  if (Array.isArray(value)) {
    for (const item of value) collectToolCalls(item, calls, seen);
    return;
  }
  if (!value || typeof value !== "object") return;
  const record = value as Record<string, unknown>;
  if (record.type === "toolCall" && typeof record.name === "string") {
    const id = typeof record.id === "string" ? record.id : `${record.name}-${seen.size}`;
    if (!seen.has(id)) {
      seen.add(id);
      calls[record.name] = (calls[record.name] ?? 0) + 1;
    }
  }
  for (const item of Object.values(record)) collectToolCalls(item, calls, seen);
}

function argsWithModel(args: string[]): string[] {
  const model = process.env.PI_CHALIN_EVAL_MODEL;
  return model ? ["--model", model, ...args] : args;
}

function envForRun(mockDelayMs: number): NodeJS.ProcessEnv {
  return {
    ...process.env,
    PI_CHALIN_RUNNER: "mock",
    PI_CHALIN_MOCK_STEP_DELAY_MS: String(mockDelayMs),
    PI_CHALIN_NONINTERACTIVE_SHUTDOWN_DELAY_MS: "0",
  };
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

function addCheck(id: string, pass: boolean, evidence?: string): void {
  (report.checks as Array<{ id: string; pass: boolean; evidence?: string }>).push({ id, pass, evidence });
}

function finish(forcedCode?: number): void {
  report.finishedAt = new Date().toISOString();
  const checks = report.checks as Array<{ id: string; pass: boolean; evidence?: string }>;
  const pass = forcedCode === undefined ? checks.every((check) => check.pass) : false;
  report.pass = pass;
  const reportDir = path.join(repoRoot, ".pi-chalin", "evals");
  fs.mkdirSync(reportDir, { recursive: true });
  const reportPath = path.join(reportDir, `resume-session-${startedAt.replace(/[:.]/g, "-")}.json`);
  fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf-8");
  console.log(`pi-chalin resume-session eval: ${pass ? "PASS" : "FAIL"}`);
  for (const check of checks) console.log(`${check.pass ? "PASS" : "FAIL"} ${check.id}: ${check.evidence ?? ""}`);
  console.log(`report: ${reportPath}`);
  if (!pass) process.exit(forcedCode ?? 1);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function snippet(text: string): string {
  return text.replace(/\s+/g, " ").slice(0, 800);
}

interface RunResult {
  stdout: string;
  stderr: string;
  status: number | null;
  signal: NodeJS.Signals | null;
}
