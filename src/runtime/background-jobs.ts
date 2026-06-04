import * as fs from "node:fs";
import * as path from "node:path";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { getShellConfig, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { resolveChalinPaths } from "../config/paths.ts";
import { chalinSessionIdFromContext } from "../runner/runner-state.ts";
import { recordBackgroundJobCompletionForTurn } from "./state.ts";

export type BackgroundBashJobStatus = "queued" | "running" | "succeeded" | "failed" | "cancelled" | "timed_out" | "orphaned" | "stale";
export type BackgroundBashJobCompletionAction = "notify" | "resume" | "none";

export interface BackgroundBashJobOwner {
  runId?: string;
  stepId?: string;
  agent?: string;
  sessionId?: string;
  parentRunId?: string;
  parentStepId?: string;
  childSessionFile?: string;
}

export interface BackgroundBashJobRecord {
  id: string;
  command: string;
  cwd: string;
  status: BackgroundBashJobStatus;
  owner: BackgroundBashJobOwner;
  requiredEvidence: boolean;
  notifyOnCompletion: boolean;
  completionAction: BackgroundBashJobCompletionAction;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  timeoutSeconds?: number;
  maxOutputBytes?: number;
  pid?: number;
  exitCode?: number | null;
  signal?: NodeJS.Signals | string | null;
  error?: string;
  staleReason?: string;
  workspaceBaseline?: WorkspaceBaseline;
  outputLogPath: string;
  outputBytes: number;
  tail: string;
  truncated: boolean;
}

export interface BackgroundBashJobSummary {
  id: string;
  command: string;
  cwd: string;
  status: BackgroundBashJobStatus;
  owner: BackgroundBashJobOwner;
  requiredEvidence: boolean;
  notifyOnCompletion: boolean;
  completionAction: BackgroundBashJobCompletionAction;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  timeoutSeconds?: number;
  maxOutputBytes?: number;
  pid?: number;
  exitCode?: number | null;
  signal?: NodeJS.Signals | string | null;
  error?: string;
  staleReason?: string;
  outputLogPath: string;
  outputBytes: number;
  tail: string;
  truncated: boolean;
}

export interface BackgroundBashJobStartInput {
  command: string;
  jobId?: string;
  timeoutSeconds?: number;
  maxOutputBytes?: number;
  requiredEvidence?: boolean;
  notifyOnCompletion?: boolean;
  completionAction?: BackgroundBashJobCompletionAction;
  owner?: BackgroundBashJobOwner;
}

export type BackgroundJobEvent = "queued" | "started" | "updated" | "completed";
export type BackgroundJobListener = (job: BackgroundBashJobRecord, event: BackgroundJobEvent) => void;

interface WorkspaceBaseline {
  capturedAt: string;
  gitStatusHash?: string;
  gitStatus?: string;
}

interface RunningJob {
  child: ChildProcess;
  stream: fs.WriteStream;
  timeout?: ReturnType<typeof setTimeout>;
  timedOut?: boolean;
  outputLimitExceeded?: boolean;
}

interface BackgroundJobManagerOptions {
  cwd: string;
  monitorMs?: number;
  maxConcurrentGlobal?: number;
  maxConcurrentPerRun?: number;
  tailChars?: number;
}

const DEFAULT_MONITOR_MS = 60_000;
const DEFAULT_MAX_GLOBAL = 4;
const DEFAULT_MAX_PER_RUN = 2;
const DEFAULT_TAIL_CHARS = 16_000;
const DEFAULT_MAX_OUTPUT_BYTES = 100 * 1024 * 1024;

const managers = new Map<string, BackgroundJobManager>();
const globalListeners = new Set<BackgroundJobListener>();
const notifierSessions = new WeakMap<object, string | undefined>();
const notifierRegistered = new WeakSet<object>();

export function getBackgroundJobManager(cwd: string): BackgroundJobManager {
  const key = path.resolve(cwd);
  const existing = managers.get(key);
  if (existing) return existing;
  const manager = new BackgroundJobManager({ cwd: key });
  managers.set(key, manager);
  return manager;
}

export function onAnyBackgroundJobChange(listener: BackgroundJobListener): () => void {
  globalListeners.add(listener);
  return () => globalListeners.delete(listener);
}

export function listBackgroundJobs(cwd: string): BackgroundBashJobSummary[] {
  return getBackgroundJobManager(cwd).listJobs().map(backgroundJobSummary);
}

export function backgroundJobSummary(job: BackgroundBashJobRecord): BackgroundBashJobSummary {
  return {
    id: job.id,
    command: job.command,
    cwd: job.cwd,
    status: job.status,
    owner: { ...job.owner },
    requiredEvidence: job.requiredEvidence,
    notifyOnCompletion: job.notifyOnCompletion,
    completionAction: normalizedCompletionAction(job),
    createdAt: job.createdAt,
    ...(job.startedAt ? { startedAt: job.startedAt } : {}),
    ...(job.finishedAt ? { finishedAt: job.finishedAt } : {}),
    ...(job.timeoutSeconds !== undefined ? { timeoutSeconds: job.timeoutSeconds } : {}),
    ...(job.maxOutputBytes !== undefined ? { maxOutputBytes: job.maxOutputBytes } : {}),
    ...(job.pid !== undefined ? { pid: job.pid } : {}),
    ...(job.exitCode !== undefined ? { exitCode: job.exitCode } : {}),
    ...(job.signal !== undefined ? { signal: job.signal } : {}),
    ...(job.error ? { error: job.error } : {}),
    ...(job.staleReason ? { staleReason: job.staleReason } : {}),
    outputLogPath: job.outputLogPath,
    outputBytes: job.outputBytes,
    tail: job.tail,
    truncated: job.truncated,
  };
}

export function backgroundJobIsTerminal(status: BackgroundBashJobStatus): boolean {
  return status !== "queued" && status !== "running";
}

export function requireBackgroundJob(manager: BackgroundJobManager, jobId: string | undefined): BackgroundBashJobRecord {
  const id = jobId?.trim();
  if (!id) throw new Error("chalin_bash_job requires jobId for this action.");
  const job = manager.getJob(id);
  if (!job) throw new Error(`background job not found: ${id}`);
  return job;
}

export function formatBackgroundJobToolResult(job: BackgroundBashJobRecord): string {
  const completionAction = normalizedCompletionAction(job);
  const lines = [
    `background job ${job.id}: ${job.status}`,
    `command: ${job.command}`,
    `cwd: ${job.cwd}`,
    job.owner.agent ? `owner: ${job.owner.agent}${job.owner.runId ? ` · run ${job.owner.runId}` : ""}${job.owner.stepId ? ` · step ${job.owner.stepId}` : ""}` : undefined,
    job.pid ? `pid: ${job.pid}` : undefined,
    job.requiredEvidence ? "requiredEvidence: true" : "requiredEvidence: false",
    `completionAction: ${completionAction}`,
    job.maxOutputBytes !== undefined ? `maxOutputBytes: ${job.maxOutputBytes}` : undefined,
    job.startedAt ? `startedAt: ${job.startedAt}` : undefined,
    job.finishedAt ? `finishedAt: ${job.finishedAt}` : undefined,
    job.exitCode !== undefined ? `exitCode: ${job.exitCode}` : undefined,
    job.error ? `error: ${job.error}` : undefined,
    job.staleReason ? `stale: ${job.staleReason}` : undefined,
    `outputLogPath: ${job.outputLogPath}`,
    job.tail.trim() ? `tail:\n${job.tail.trim().slice(-2000)}` : "tail: (no output yet)",
    !backgroundJobIsTerminal(job.status)
      ? completionAction === "resume"
        ? "This job will attempt to wake the owning Pi thread when it completes. Continue independent work or finish with a pending-job note; do not poll unless the result is needed immediately."
        : "Continue other independent work, then call chalin_bash_job status/read/await before using this as evidence."
      : undefined,
  ];
  return lines.filter((line): line is string => Boolean(line)).join("\n");
}

export function formatBackgroundJobRead(job: BackgroundBashJobRecord, output: string): string {
  return [
    `background job ${job.id}: ${job.status}`,
    `command: ${job.command}`,
    `outputLogPath: ${job.outputLogPath}`,
    output.trim() ? output.trim() : "(no output)",
  ].join("\n");
}

export function formatBackgroundJobList(jobs: BackgroundBashJobRecord[]): string {
  if (jobs.length === 0) return "No pi-chalin background bash jobs.";
  return jobs.slice(0, 30).map((job) => {
    const owner = job.owner.agent ? ` · ${job.owner.agent}${job.owner.stepId ? `/${job.owner.stepId}` : ""}` : "";
    const evidence = job.requiredEvidence ? " · evidence" : "";
    const completion = normalizedCompletionAction(job);
    const followup = completion !== "notify" ? ` · ${completion}` : "";
    const exit = job.exitCode !== undefined ? ` · exit ${job.exitCode}` : "";
    return `- ${job.id}: ${job.status}${exit}${evidence}${followup}${owner} · ${job.command}`;
  }).join("\n");
}

export function backgroundJobCounts(cwd: string): { queued: number; running: number; done: number; failed: number; total: number } {
  const jobs = listBackgroundJobs(cwd);
  const recentAttentionCutoff = Date.now() - 10 * 60_000;
  return {
    queued: jobs.filter((job) => job.status === "queued").length,
    running: jobs.filter((job) => job.status === "running").length,
    done: jobs.filter((job) => job.status === "succeeded").length,
    failed: jobs.filter((job) => (
      ["failed", "timed_out", "cancelled", "orphaned", "stale"].includes(job.status)
      && (!job.finishedAt || Date.parse(job.finishedAt) >= recentAttentionCutoff)
    )).length,
    total: jobs.length,
  };
}

export function summarizeBackgroundJobsForFooter(cwd: string): string | undefined {
  const counts = backgroundJobCounts(cwd);
  if (counts.running === 0 && counts.queued === 0 && counts.failed === 0) return undefined;
  const parts = [
    counts.running > 0 ? `${counts.running} running` : undefined,
    counts.queued > 0 ? `${counts.queued} queued` : undefined,
    counts.failed > 0 ? `${counts.failed} attention` : undefined,
  ].filter((part): part is string => Boolean(part));
  return parts.length ? `jobs ${parts.join(", ")}` : undefined;
}

export function registerBackgroundJobCompletionNotifier(pi: ExtensionAPI): void {
  const key = pi as unknown as object;
  if (notifierRegistered.has(key)) return;
  notifierRegistered.add(key);
  pi.on("session_start", (_event, ctx) => {
    notifierSessions.set(key, chalinSessionIdFromContext(ctx));
  });
  onAnyBackgroundJobChange((job, event) => {
    if (event !== "completed") return;
    const action = normalizedCompletionAction(job);
    if (action === "none") return;
    const currentSessionId = notifierSessions.get(key);
    if (currentSessionId && job.owner.sessionId && currentSessionId !== job.owner.sessionId) return;
    recordBackgroundJobCompletionForTurn({
      id: job.id,
      command: job.command,
      status: job.status,
      requiredEvidence: job.requiredEvidence,
      completionAction: action,
      observation: formatBackgroundJobCompletionSteer(job),
    });
    try {
      pi.sendMessage({
        customType: "pi-chalin-background-job",
        content: formatBackgroundJobCompletionSteer(job),
        display: true,
        details: backgroundJobSummary(job),
      }, action === "resume" ? { triggerTurn: true } : { triggerTurn: false, deliverAs: "steer" });
    } catch {
      // The owning session can be gone in non-interactive/print mode by the time
      // a detached job completes. The persisted job record and output log remain
      // authoritative; notification is best-effort.
    }
  });
}

export function formatBackgroundJobCompletionSteer(job: BackgroundBashJobRecord): string {
  const owner = [job.owner.agent, job.owner.runId, job.owner.stepId].filter(Boolean).join("/");
  return [
    "pi-chalin background bash job finished.",
    `job: ${job.id}`,
    owner ? `owner: ${owner}` : undefined,
    `status: ${job.status}${job.exitCode !== undefined ? ` · exit ${job.exitCode}` : ""}`,
    `command: ${job.command}`,
    job.staleReason ? `stale: ${job.staleReason}` : undefined,
    job.error ? `error: ${job.error}` : undefined,
    job.tail.trim() ? `tail:\n${job.tail.trim().slice(-2000)}` : "tail: (no output)",
    normalizedCompletionAction(job) === "resume"
      ? "This message woke the owning Pi thread. Process the result now: if it is succeeded and not stale, use it as evidence; if it failed/stale/timed out, repair or report the concrete blocker."
      : "Use chalin_bash_job status/read/await if you need more detail before claiming verification.",
  ].filter((line): line is string => Boolean(line)).join("\n");
}

export function normalizedCompletionAction(job: { completionAction?: unknown; notifyOnCompletion?: boolean }): BackgroundBashJobCompletionAction {
  if (job.completionAction === "notify" || job.completionAction === "resume" || job.completionAction === "none") return job.completionAction;
  return job.notifyOnCompletion ? "notify" : "none";
}

export function resolveCompletionAction(input: {
  completionAction?: BackgroundBashJobCompletionAction;
  notifyOnCompletion?: boolean;
}): BackgroundBashJobCompletionAction {
  if (input.completionAction === "notify" || input.completionAction === "resume" || input.completionAction === "none") return input.completionAction;
  return input.notifyOnCompletion === false ? "none" : "notify";
}

export class BackgroundJobManager {
  private readonly root: string;
  private readonly monitor: ReturnType<typeof setInterval>;
  private readonly maxConcurrentGlobal: number;
  private readonly maxConcurrentPerRun: number;
  private readonly tailChars: number;
  private readonly running = new Map<string, RunningJob>();
  private readonly listeners = new Set<BackgroundJobListener>();

  constructor(options: BackgroundJobManagerOptions) {
    this.root = path.join(resolveChalinPaths({ cwd: options.cwd }).projectRoot, ".pi-chalin", "background-jobs");
    this.maxConcurrentGlobal = options.maxConcurrentGlobal ?? DEFAULT_MAX_GLOBAL;
    this.maxConcurrentPerRun = options.maxConcurrentPerRun ?? DEFAULT_MAX_PER_RUN;
    this.tailChars = options.tailChars ?? DEFAULT_TAIL_CHARS;
    fs.mkdirSync(this.root, { recursive: true });
    this.recoverPersistedJobs();
    this.monitor = setInterval(() => this.monitorTick(), options.monitorMs ?? DEFAULT_MONITOR_MS);
    this.monitor.unref?.();
  }

  dispose(): void {
    clearInterval(this.monitor);
    for (const [id] of this.running) this.cancelJob(id);
    this.listeners.clear();
  }

  onJobChange(listener: BackgroundJobListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  watchJob(jobId: string, listener: BackgroundJobListener): () => void {
    const unsubscribe = this.onJobChange((job, event) => {
      if (job.id !== jobId) return;
      listener(job, event);
      if (event === "completed") unsubscribe();
    });
    return unsubscribe;
  }

  startJob(input: BackgroundBashJobStartInput): BackgroundBashJobRecord {
    const command = input.command.trim();
    if (!command) throw new Error("background bash job requires a command.");
    const now = new Date().toISOString();
    const id = this.resolveStartJobId(input.jobId);
    const logPath = path.join(this.root, `${id}.log`);
    const job: BackgroundBashJobRecord = {
      id,
      command,
      cwd: path.dirname(path.dirname(this.root)),
      status: "queued",
      owner: input.owner ? { ...input.owner } : {},
      requiredEvidence: input.requiredEvidence === true,
      notifyOnCompletion: resolveCompletionAction(input) !== "none",
      completionAction: resolveCompletionAction(input),
      createdAt: now,
      ...(input.timeoutSeconds !== undefined ? { timeoutSeconds: Math.max(1, Math.floor(input.timeoutSeconds)) } : {}),
      maxOutputBytes: normalizeMaxOutputBytes(input.maxOutputBytes),
      workspaceBaseline: captureWorkspaceBaseline(path.dirname(path.dirname(this.root))),
      outputLogPath: logPath,
      outputBytes: 0,
      tail: "",
      truncated: false,
    };
    this.saveJob(job);
    this.emit(job, "queued");
    this.pumpQueue();
    return this.getJob(id) ?? job;
  }

  private resolveStartJobId(requestedId: string | undefined): string {
    const trimmed = requestedId?.trim();
    if (!trimmed) return generatedBackgroundJobId();
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/.test(trimmed)) {
      throw new Error("background job id must be 1-80 chars and contain only letters, numbers, dots, underscores, or dashes.");
    }
    if (trimmed === "." || trimmed === ".." || trimmed.includes("..")) {
      throw new Error("background job id must not contain path traversal segments.");
    }
    if (fs.existsSync(path.join(this.root, `${trimmed}.json`)) || fs.existsSync(path.join(this.root, `${trimmed}.log`))) {
      throw new Error(`background job id already exists: ${trimmed}`);
    }
    return trimmed;
  }

  getJob(id: string): BackgroundBashJobRecord | undefined {
    return this.readJobRecord(id);
  }

  listJobs(options: { ownerRunId?: string; includeCompleted?: boolean } = {}): BackgroundBashJobRecord[] {
    this.recoverPersistedJobs();
    const jobs = fs.readdirSync(this.root)
      .filter((name) => name.endsWith(".json"))
      .flatMap((name) => {
        const job = this.readJobFile(path.join(this.root, name));
        return job ? [job] : [];
      })
      .filter((job) => !options.ownerRunId || job.owner.runId === options.ownerRunId)
      .filter((job) => options.includeCompleted !== false || !backgroundJobIsTerminal(job.status))
      .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
    return jobs;
  }

  readJobOutput(id: string, maxChars = 16_000): string {
    const job = this.getJob(id);
    if (!job) throw new Error(`background job not found: ${id}`);
    if (!fs.existsSync(job.outputLogPath)) return "";
    const stat = fs.statSync(job.outputLogPath);
    const start = Math.max(0, stat.size - Math.max(1, maxChars));
    const fd = fs.openSync(job.outputLogPath, "r");
    try {
      const buffer = Buffer.alloc(stat.size - start);
      fs.readSync(fd, buffer, 0, buffer.length, start);
      return buffer.toString("utf-8");
    } finally {
      fs.closeSync(fd);
    }
  }

  async awaitJob(id: string, timeoutMs = 30_000): Promise<BackgroundBashJobRecord> {
    const start = Date.now();
    for (;;) {
      const job = this.getJob(id);
      if (!job) throw new Error(`background job not found: ${id}`);
      if (backgroundJobIsTerminal(job.status)) return job;
      if (Date.now() - start >= timeoutMs) return job;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }

  cancelJob(id: string): BackgroundBashJobRecord {
    const job = this.getJob(id);
    if (!job) throw new Error(`background job not found: ${id}`);
    const terminalButStillKillable = job.status === "orphaned" && job.pid !== undefined && processExists(job.pid);
    if (backgroundJobIsTerminal(job.status) && !terminalButStillKillable) return job;
    const running = this.running.get(id);
    if (running) {
      killProcessTree(job.pid);
      if (running.timeout) clearTimeout(running.timeout);
      running.stream.end();
      this.running.delete(id);
    } else if (job.pid) {
      killProcessTree(job.pid);
    }
    const cancelled: BackgroundBashJobRecord = {
      ...job,
      status: "cancelled",
      finishedAt: new Date().toISOString(),
      error: "cancelled by user or agent",
    };
    this.saveJob(cancelled);
    this.emit(cancelled, "completed");
    this.pumpQueue();
    return cancelled;
  }

  private monitorTick(): void {
    this.recoverPersistedJobs();
    this.pumpQueue();
  }

  private pumpQueue(): void {
    for (const job of this.listJobs({ includeCompleted: false }).reverse()) {
      if (job.status !== "queued") continue;
      if (!this.canStart(job)) continue;
      this.launch(job);
    }
  }

  private canStart(job: BackgroundBashJobRecord): boolean {
    if (this.running.size >= this.maxConcurrentGlobal) return false;
    const runId = job.owner.runId;
    if (!runId) return true;
    const runningForRun = [...this.running.keys()]
      .map((id) => this.getJob(id))
      .filter((candidate) => candidate?.owner.runId === runId).length;
    return runningForRun < this.maxConcurrentPerRun;
  }

  private launch(job: BackgroundBashJobRecord): void {
    const { shell, args } = getShellConfig();
    fs.mkdirSync(path.dirname(job.outputLogPath), { recursive: true });
    const stream = fs.createWriteStream(job.outputLogPath, { flags: "a" });
    const started: BackgroundBashJobRecord = {
      ...job,
      status: "running",
      startedAt: new Date().toISOString(),
      workspaceBaseline: job.workspaceBaseline ?? captureWorkspaceBaseline(job.cwd),
    };
    stream.write(formatLogHeader(started));
    try {
      const child = spawn(shell, [...args, job.command], {
        cwd: job.cwd,
        detached: process.platform !== "win32",
        env: process.env,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
      started.pid = child.pid;
      this.saveJob(started);
      this.emit(started, "started");
      const running: RunningJob = { child, stream };
      this.running.set(job.id, running);
      if (started.timeoutSeconds !== undefined && started.timeoutSeconds > 0) {
        running.timeout = setTimeout(() => {
          running.timedOut = true;
          killProcessTree(started.pid);
        }, started.timeoutSeconds * 1000);
        running.timeout.unref?.();
      }
      child.stdout.on("data", (data: Buffer) => this.appendOutput(started.id, data));
      child.stderr.on("data", (data: Buffer) => this.appendOutput(started.id, data));
      child.on("error", (error) => this.finishJob(started.id, { status: "failed", error: error.message }));
      child.on("close", (code, signal) => {
        const current = this.getJob(started.id);
        if (current?.status === "cancelled") return;
        if (running.timedOut) {
          this.finishJob(started.id, { status: "timed_out", exitCode: code, signal, error: `timed out after ${started.timeoutSeconds} seconds` });
          return;
        }
        if (running.outputLimitExceeded) {
          const latest = this.getJob(started.id);
          this.finishJob(started.id, {
            status: "failed",
            exitCode: code,
            signal,
            error: `output exceeded ${latest?.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES} bytes`,
          });
          return;
        }
        this.finishJob(started.id, { status: code === 0 ? "succeeded" : "failed", exitCode: code, signal, error: code === 0 ? undefined : `command exited with code ${code}` });
      });
    } catch (error) {
      stream.end();
      this.finishJob(started.id, { status: "failed", error: error instanceof Error ? error.message : String(error) });
    }
  }

  private appendOutput(id: string, data: Buffer): void {
    const running = this.running.get(id);
    const job = this.getJob(id);
    if (!job || !running) return;
    const maxOutputBytes = job.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
    const remaining = Math.max(0, maxOutputBytes - job.outputBytes);
    const limitedData = data.length > remaining ? data.subarray(0, remaining) : data;
    const limitExceeded = data.length > remaining;
    const limitNote = limitExceeded
      ? Buffer.from(`\n[pi-chalin] background job output exceeded ${maxOutputBytes} bytes; terminating process.\n`, "utf-8")
      : undefined;
    if (limitedData.length > 0) running.stream.write(limitedData);
    if (limitNote) running.stream.write(limitNote);
    const text = `${limitedData.toString("utf-8")}${limitNote ? limitNote.toString("utf-8") : ""}`;
    const outputBytes = job.outputBytes + limitedData.length + (limitNote?.length ?? 0);
    const tail = `${job.tail}${text}`.slice(-this.tailChars);
    const updated: BackgroundBashJobRecord = {
      ...job,
      outputBytes,
      tail,
      truncated: job.truncated || outputBytes > this.tailChars || limitExceeded,
    };
    this.saveJob(updated);
    this.emit(updated, "updated");
    if (limitExceeded) {
      running.outputLimitExceeded = true;
      killProcessTree(job.pid);
    }
  }

  private finishJob(id: string, result: {
    status: BackgroundBashJobStatus;
    exitCode?: number | null;
    signal?: NodeJS.Signals | string | null;
    error?: string;
  }): void {
    const running = this.running.get(id);
    if (running?.timeout) clearTimeout(running.timeout);
    running?.stream.end();
    this.running.delete(id);
    const current = this.getJob(id);
    if (!current) return;
    const staleReason = current.requiredEvidence && result.status === "succeeded"
      ? staleReasonForWorkspace(current.cwd, current.workspaceBaseline)
      : undefined;
    const finished: BackgroundBashJobRecord = {
      ...current,
      status: staleReason ? "stale" : result.status,
      finishedAt: new Date().toISOString(),
      ...(result.exitCode !== undefined ? { exitCode: result.exitCode } : {}),
      ...(result.signal !== undefined ? { signal: result.signal } : {}),
      ...(result.error ? { error: result.error } : {}),
      ...(staleReason ? { staleReason } : {}),
    };
    this.saveJob(finished);
    this.emit(finished, "completed");
    this.pumpQueue();
  }

  private recoverPersistedJobs(): void {
    if (!fs.existsSync(this.root)) return;
    for (const job of this.listJobRecordsNoRecover()) {
      if (job.status === "running" && !this.running.has(job.id)) {
        const orphaned: BackgroundBashJobRecord = {
          ...job,
          status: "orphaned",
          finishedAt: job.finishedAt ?? new Date().toISOString(),
          error: job.pid && processExists(job.pid)
            ? "process survived extension restart; output is no longer attached"
            : "process ended while extension was not attached",
        };
        this.saveJob(orphaned);
        this.emit(orphaned, "completed");
      }
    }
  }

  private listJobRecordsNoRecover(): BackgroundBashJobRecord[] {
    return fs.readdirSync(this.root)
      .filter((name) => name.endsWith(".json"))
      .flatMap((name) => {
        const job = this.readJobFile(path.join(this.root, name));
        return job ? [job] : [];
      });
  }

  private readJobRecord(id: string): BackgroundBashJobRecord | undefined {
    return this.readJobFile(path.join(this.root, `${id}.json`));
  }

  private readJobFile(file: string): BackgroundBashJobRecord | undefined {
    try {
      const parsed = JSON.parse(fs.readFileSync(file, "utf-8")) as BackgroundBashJobRecord;
      if (!parsed?.id || !parsed.command || !parsed.cwd) return undefined;
      const completionAction = normalizedCompletionAction(parsed);
      return {
        ...parsed,
        completionAction,
        notifyOnCompletion: completionAction !== "none",
      };
    } catch {
      return undefined;
    }
  }

  private saveJob(job: BackgroundBashJobRecord): void {
    fs.mkdirSync(this.root, { recursive: true });
    fs.writeFileSync(path.join(this.root, `${job.id}.json`), `${JSON.stringify(job, null, 2)}\n`, "utf-8");
  }

  private emit(job: BackgroundBashJobRecord, event: BackgroundJobEvent): void {
    for (const listener of this.listeners) listener(job, event);
    for (const listener of globalListeners) listener(job, event);
  }
}

function captureWorkspaceBaseline(cwd: string): WorkspaceBaseline | undefined {
  const status = gitStatus(cwd);
  if (status === undefined) return undefined;
  return {
    capturedAt: new Date().toISOString(),
    gitStatus: status,
    gitStatusHash: createHash("sha256").update(status).digest("hex"),
  };
}

function staleReasonForWorkspace(cwd: string, baseline: WorkspaceBaseline | undefined): string | undefined {
  if (!baseline?.gitStatusHash) return undefined;
  const status = gitStatus(cwd);
  if (status === undefined) return undefined;
  const hash = createHash("sha256").update(status).digest("hex");
  return hash === baseline.gitStatusHash ? undefined : "workspace git status changed after the background verification started";
}

function gitStatus(cwd: string): string | undefined {
  const result = spawnSync("git", ["status", "--short", "--untracked-files=all"], { cwd, encoding: "utf-8" });
  if (result.status !== 0) return undefined;
  return result.stdout;
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function generatedBackgroundJobId(): string {
  return `bg-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function normalizeMaxOutputBytes(value: number | undefined): number {
  if (!Number.isFinite(value) || value === undefined) return DEFAULT_MAX_OUTPUT_BYTES;
  return Math.max(1024, Math.floor(value));
}

function killProcessTree(pid: number | undefined): void {
  if (!pid) return;
  try {
    if (process.platform === "win32") {
      spawnSync("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore" });
      return;
    }
    try {
      process.kill(-pid, "SIGTERM");
    } catch {
      process.kill(pid, "SIGTERM");
    }
    setTimeout(() => {
      try {
        process.kill(-pid, "SIGKILL");
      } catch {
        try {
          process.kill(pid, "SIGKILL");
        } catch {
          // Process already exited.
        }
      }
    }, 1500).unref?.();
  } catch {
    // Best-effort cancellation; close/error handlers will settle if attached.
  }
}

function formatLogHeader(job: BackgroundBashJobRecord): string {
  return [
    `# pi-chalin background bash job ${job.id}`,
    `# cwd: ${job.cwd}`,
    `# command: ${job.command}`,
    `# startedAt: ${job.startedAt ?? ""}`,
    "",
  ].join("\n");
}
