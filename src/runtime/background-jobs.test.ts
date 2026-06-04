import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawn } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { BackgroundJobManager, registerBackgroundJobCompletionNotifier } from "./background-jobs.ts";

const managers: BackgroundJobManager[] = [];

afterEach(() => {
  for (const manager of managers.splice(0)) manager.dispose();
});

describe("BackgroundJobManager", () => {
  it("runs a background command and persists output", async () => {
    const cwd = tempCwd();
    const manager = createManager(cwd);

    const job = manager.startJob({ command: `${process.execPath} -e "console.log('ok')"`, requiredEvidence: true });
    expect(["queued", "running", "succeeded"]).toContain(job.status);

    const completed = await manager.awaitJob(job.id, 5_000);
    expect(completed.status).toBe("succeeded");
    expect(completed.exitCode).toBe(0);
    expect(manager.readJobOutput(job.id)).toContain("ok");
    expect(fs.existsSync(completed.outputLogPath)).toBe(true);
  });

  it("accepts a safe caller-provided job id for follow-up actions", async () => {
    const cwd = tempCwd();
    const manager = createManager(cwd);

    const job = manager.startJob({ jobId: "verify-smoke", command: `${process.execPath} -e "console.log('custom-id-ok')"` });
    const completed = await manager.awaitJob("verify-smoke", 5_000);

    expect(job.id).toBe("verify-smoke");
    expect(completed.status).toBe("succeeded");
    expect(manager.readJobOutput("verify-smoke")).toContain("custom-id-ok");
  });

  it("can wake the owning Pi thread when a resume job completes", async () => {
    const cwd = tempCwd();
    const manager = createManager(cwd);
    const pi = new FakePi();
    registerBackgroundJobCompletionNotifier(pi as never);

    const job = manager.startJob({
      jobId: "wake-on-finish",
      command: `${process.execPath} -e "console.log('wake-ok')"`,
      requiredEvidence: true,
      completionAction: "resume",
    });
    await manager.awaitJob(job.id, 5_000);
    await waitFor(() => pi.messages.some((message) => message.message.customType === "pi-chalin-background-job"));

    const message = pi.messages.find((item) => item.message.customType === "pi-chalin-background-job");
    expect(message?.options.triggerTurn).toBe(true);
    expect(message?.options.deliverAs).toBeUndefined();
    expect(message?.message.content).toContain("wake-ok");
    expect(message?.message.details.completionAction).toBe("resume");
  });

  it("does not crash when a resume notification targets a stale session", async () => {
    const cwd = tempCwd();
    const manager = createManager(cwd);
    registerBackgroundJobCompletionNotifier(new ThrowingPi() as never);

    const job = manager.startJob({
      jobId: "stale-session-finish",
      command: `${process.execPath} -e "console.log('stale-ok')"`,
      requiredEvidence: true,
      completionAction: "resume",
    });
    const completed = await manager.awaitJob(job.id, 5_000);

    expect(completed.status).toBe("succeeded");
    expect(manager.readJobOutput(job.id)).toContain("stale-ok");
  });

  it("marks failed commands without treating them as passing evidence", async () => {
    const cwd = tempCwd();
    const manager = createManager(cwd);

    const job = manager.startJob({ command: `${process.execPath} -e "process.exit(7)"`, requiredEvidence: true });
    const completed = await manager.awaitJob(job.id, 5_000);

    expect(completed.status).toBe("failed");
    expect(completed.exitCode).toBe(7);
    expect(completed.requiredEvidence).toBe(true);
  });

  it("times out long-running jobs", async () => {
    const cwd = tempCwd();
    const manager = createManager(cwd);

    const job = manager.startJob({ command: `${process.execPath} -e "setTimeout(() => {}, 5000)"`, timeoutSeconds: 1 });
    const completed = await manager.awaitJob(job.id, 5_000);

    expect(completed.status).toBe("timed_out");
    expect(completed.error).toContain("timed out");
  });

  it("terminates jobs that exceed the output limit", async () => {
    const cwd = tempCwd();
    const manager = createManager(cwd);

    const job = manager.startJob({
      command: `${process.execPath} -e "console.log('x'.repeat(4096))"`,
      maxOutputBytes: 1024,
    });
    const completed = await manager.awaitJob(job.id, 5_000);

    expect(completed.status).toBe("failed");
    expect(completed.error).toContain("output exceeded");
    expect(manager.readJobOutput(job.id)).toContain("output exceeded 1024 bytes");
  });

  it("queues jobs when global concurrency is saturated", async () => {
    const cwd = tempCwd();
    const manager = createManager(cwd, { maxConcurrentGlobal: 1 });

    const first = manager.startJob({ command: `${process.execPath} -e "setTimeout(() => {}, 500)"` });
    const second = manager.startJob({ command: `${process.execPath} -e "console.log('second')"` });

    expect(manager.getJob(first.id)?.status).toBe("running");
    expect(manager.getJob(second.id)?.status).toBe("queued");

    await manager.awaitJob(first.id, 5_000);
    const completedSecond = await manager.awaitJob(second.id, 5_000);

    expect(completedSecond.status).toBe("succeeded");
    expect(manager.readJobOutput(second.id)).toContain("second");
  });

  it("emits a single completion event when cancelling a running job", async () => {
    const cwd = tempCwd();
    const manager = createManager(cwd);
    const job = manager.startJob({ command: `${process.execPath} -e "process.on('SIGTERM', () => process.exit(0)); setTimeout(() => {}, 5000)"` });
    await waitFor(() => manager.getJob(job.id)?.status === "running");
    let completedEvents = 0;
    manager.onJobChange((changed, event) => {
      if (changed.id === job.id && event === "completed") completedEvents += 1;
    });

    const cancelled = manager.cancelJob(job.id);
    await sleep(300);

    expect(cancelled.status).toBe("cancelled");
    expect(manager.getJob(job.id)?.status).toBe("cancelled");
    expect(completedEvents).toBe(1);
  });

  it("recovers unattached running jobs as orphaned", () => {
    const cwd = tempCwd();
    const jobsDir = path.join(cwd, ".pi-chalin", "background-jobs");
    fs.mkdirSync(jobsDir, { recursive: true });
    fs.writeFileSync(path.join(jobsDir, "bg-orphan.json"), `${JSON.stringify({
      id: "bg-orphan",
      command: "sleep 100",
      cwd,
      status: "running",
      owner: {},
      requiredEvidence: false,
      notifyOnCompletion: true,
      createdAt: new Date().toISOString(),
      startedAt: new Date().toISOString(),
      pid: 99999999,
      outputLogPath: path.join(jobsDir, "bg-orphan.log"),
      outputBytes: 0,
      tail: "",
      truncated: false,
    }, null, 2)}\n`, "utf-8");

    const recovered = new BackgroundJobManager({ cwd, monitorMs: 1_000 });
    managers.push(recovered);

    const orphan = recovered.getJob("bg-orphan");
    expect(orphan?.status).toBe("orphaned");
  });

  it("can cancel an orphaned job when its pid is still alive", () => {
    const cwd = tempCwd();
    const jobsDir = path.join(cwd, ".pi-chalin", "background-jobs");
    fs.mkdirSync(jobsDir, { recursive: true });
    const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 5000)"], {
      detached: process.platform !== "win32",
      stdio: "ignore",
    });
    child.unref();
    if (!child.pid) throw new Error("expected child process pid");
    try {
      fs.writeFileSync(path.join(jobsDir, "bg-orphan-live.json"), `${JSON.stringify({
        id: "bg-orphan-live",
        command: "node -e \"setTimeout(() => {}, 5000)\"",
        cwd,
        status: "orphaned",
        owner: {},
        requiredEvidence: false,
        notifyOnCompletion: true,
        createdAt: new Date().toISOString(),
        startedAt: new Date().toISOString(),
        finishedAt: new Date().toISOString(),
        pid: child.pid,
        outputLogPath: path.join(jobsDir, "bg-orphan-live.log"),
        outputBytes: 0,
        tail: "",
        truncated: false,
      }, null, 2)}\n`, "utf-8");

      const manager = createManager(cwd);
      const cancelled = manager.cancelJob("bg-orphan-live");

      expect(cancelled.status).toBe("cancelled");
      expect(cancelled.error).toContain("cancelled");
    } finally {
      killBestEffort(child.pid);
    }
  });
});

class FakePi {
  readonly handlers = new Map<string, ((event: any, ctx: any) => void)[]>();
  readonly messages: Array<{ message: any; options: any }> = [];

  on(event: string, handler: (event: any, ctx: any) => void): void {
    const handlers = this.handlers.get(event) ?? [];
    handlers.push(handler);
    this.handlers.set(event, handlers);
  }

  sendMessage(message: any, options: any): void {
    this.messages.push({ message, options });
  }
}

class ThrowingPi extends FakePi {
  override sendMessage(): void {
    throw new Error("stale session");
  }
}

function createManager(cwd: string, options: { maxConcurrentGlobal?: number } = {}): BackgroundJobManager {
  const manager = new BackgroundJobManager({
    cwd,
    monitorMs: 1_000,
    maxConcurrentGlobal: options.maxConcurrentGlobal,
    maxConcurrentPerRun: 2,
    tailChars: 4_000,
  });
  managers.push(manager);
  return manager;
}

function tempCwd(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "pi-chalin-bg-"));
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > 2_000) throw new Error("timed out waiting for condition");
    await sleep(25);
  }
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function killBestEffort(pid: number | undefined): void {
  if (!pid) return;
  try {
    if (process.platform === "win32") {
      spawn("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore" });
      return;
    }
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      process.kill(pid, "SIGKILL");
    }
  } catch {
    // Best-effort cleanup for the synthetic orphan process.
  }
}
