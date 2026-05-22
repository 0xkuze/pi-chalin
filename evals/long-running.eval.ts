#!/usr/bin/env bun
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { ArtifactStore } from "../src/artifacts.ts";
import { createRunState, loadResumableRunState, MockWorkerRunner } from "../src/runner.ts";
import type { AgentOutput, RouteDecision, RunState } from "../src/schemas.ts";

interface LongRunningCheck {
  id: string;
  pass: boolean;
  evidence: string;
  nextStep?: string;
}

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

if (isMain()) await main();

async function main(): Promise<void> {
  const startedAt = new Date().toISOString();
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-chalin-long-running-"));
  const checks: LongRunningCheck[] = [];

  try {
    writeSyntheticLongRunningProject(cwd);
    const store = new ArtifactStore({ cwd });
    const featureId = "long-running-checkpoint-resume";
    await store.initFeature({
      featureId,
      goal: "Synthetic 10-30 minute style migration: inspect, split work, checkpoint, resume, validate.",
      chain: ["scout", "planner", "worker", "worker", "reviewer"],
      currentStep: "Discovery",
    });
    await store.saveValidationContract(featureId, {
      id: "contract-regression",
      title: "Regression contract",
      commands: ["bun test"],
      successCriteria: ["resume keeps completed handoffs", "pending stages continue", "final review sees prior context"],
      files: ["package.json", "src/queue.ts", "test/queue.test.ts"],
    });
    await store.saveWorkerSkill(featureId, {
      name: "queue-migration-worker",
      summary: "Keep queue changes small, test first, and checkpoint handoff before continuing.",
      rules: ["Do not restart completed scout work", "Run bun test before final handoff", "Record checkpoint on every stage boundary"],
    });
    const checkpoint = await store.appendCheckpoint(featureId, {
      agent: "scout",
      title: "Discovery complete",
      summary: "Found queue implementation and regression tests; next stages can edit src/queue.ts and test/queue.test.ts without rescanning the repo.",
      status: "active",
      stage: "discover",
      validationRefs: ["contract-regression"],
    });

    checks.push({ id: "checkpoint-written", pass: Boolean(checkpoint.id), evidence: checkpoint.id });

    const route = syntheticLongRunningRoute();
    const interrupted = createInterruptedRun(route, cwd);
    writeRun(interrupted);
    const loaded = loadResumableRunState({ cwd, runId: interrupted.id });
    checks.push({
      id: "stale-run-recovers-as-paused",
      pass: loaded?.status === "paused",
      evidence: loaded ? `${loaded.id}:${loaded.status}:${loaded.warnings.join(" | ")}` : "no resumable run loaded",
      nextStep: "Verify .pi-chalin/runs contains a paused or stale running run with unfinished steps.",
    });

    const resumed = loaded ? await new MockWorkerRunner().resume(loaded, { cwd, agents: new Map() }) : undefined;
    checks.push({
      id: "resume-completes-pending-stages",
      pass: resumed?.status === "complete" && resumed.steps.every((step) => step.status === "complete"),
      evidence: resumed ? `${resumed.status}:${resumed.steps.map((step) => step.status).join(",")}` : "resume did not run",
      nextStep: "Inspect run summary and rerun resume targeted; completed handoffs must not be rerun.",
    });

    if (resumed) await store.recordRun(resumed);
    await store.appendCheckpoint(featureId, {
      agent: "reviewer",
      title: "Validation handoff complete",
      summary: "Synthetic long-running workflow resumed and reached final reviewer with validation contract still available.",
      status: "complete",
      stage: "review",
      validationRefs: ["contract-regression"],
    });
    const resumeContext = await store.resumeContext(featureId);
    checks.push({
      id: "resume-context-is-user-readable",
      pass: /Recent checkpoints:[\s\S]*Discovery complete/.test(resumeContext)
        && /Validation contracts:[\s\S]*contract-regression/.test(resumeContext)
        && /Worker skills:[\s\S]*queue-migration-worker/.test(resumeContext),
      evidence: resumeContext,
      nextStep: "The user-facing resume context should show checkpoint, validation contract, and worker skill without raw logs.",
    });

    const pass = checks.every((check) => check.pass);
    const report = {
      schemaVersion: 1,
      startedAt,
      finishedAt: new Date().toISOString(),
      pass,
      cwd,
      scenario: "long-running-checkpoint-resume",
      policy: {
        maxInteractiveWallMs: 120_000,
        purpose: "Exercise long-running foundations without sleeping for 10-30 minutes: checkpoint, terminal recovery, resume, validation contract, user-readable failure context.",
      },
      checks,
      failureUx: checks.filter((check) => !check.pass).map((check) => ({
        checkId: check.id,
        whatHappened: check.evidence,
        nextStep: check.nextStep ?? "Inspect the retained synthetic workspace and fix the harness root cause.",
      })),
    };
    const reportPath = writeReport(report);
    console.log(`pi-chalin long-running eval: ${pass ? "PASS" : "FAIL"}`);
    for (const check of checks) console.log(`${check.pass ? "PASS" : "FAIL"} ${check.id}: ${compact(check.evidence, 180)}`);
    console.log(`report: ${reportPath}`);
    if (!pass && process.env.PI_CHALIN_LONG_EVAL_ALLOW_FAIL !== "1") process.exit(1);
  } finally {
    if (process.env.PI_CHALIN_LONG_EVAL_KEEP_FIXTURE !== "1") fs.rmSync(cwd, { recursive: true, force: true });
  }
}

export function syntheticLongRunningRoute(): RouteDecision {
  return {
    kind: "multi-agent-dag",
    agents: ["scout", "planner", "worker", "worker", "reviewer"],
    risk: "medium",
    ambiguity: "medium",
    needsMemory: true,
    needsArtifacts: true,
    reason: "Long-running synthetic migration with checkpoints, resume, validation and final review.",
    plan: {
      kind: "dag",
      stages: [
        { id: "discover", tasks: [{ agent: "scout", task: "Map queue module, tests, and rollback surface.", budget: "normal" }] },
        { id: "plan", tasks: [{ agent: "planner", task: "Split the migration into checkpointed implementation slices.", budget: "normal" }] },
        { id: "implement", tasks: [
          { agent: "worker", task: "Implement queue visibility timeout slice and update focused tests.", budget: "extended" },
          { agent: "worker", task: "Implement idempotent ack slice and update focused tests.", budget: "extended" },
        ] },
        { id: "validate", tasks: [{ agent: "reviewer", task: "Validate test evidence and produce user-readable next step.", budget: "normal" }] },
      ],
    },
  };
}

function createInterruptedRun(route: RouteDecision, cwd: string): RunState {
  const run = createRunState(route, cwd);
  run.status = "running";
  const first = run.steps[0]!;
  first.status = "complete";
  first.startedAt = new Date().toISOString();
  first.endedAt = new Date().toISOString();
  first.output = completedOutput("scout", "Queue module mapped; tests and rollback surface identified.");
  for (const step of run.steps.slice(1)) {
    step.status = "running";
    step.startedAt = new Date().toISOString();
    step.currentTool = "read";
  }
  return run;
}

function completedOutput(agent: string, text: string): AgentOutput {
  return { agent, text, handoff: text, raw: text, warnings: [], memoryCandidates: [] };
}

function writeRun(run: RunState): void {
  fs.mkdirSync(path.dirname(run.logsPath!), { recursive: true });
  fs.writeFileSync(run.logsPath!, `${JSON.stringify(run, null, 2)}\n`);
}

function writeSyntheticLongRunningProject(cwd: string): void {
  write(cwd, "package.json", JSON.stringify({
    name: "synthetic-long-running-queue",
    private: true,
    type: "module",
    scripts: { test: "bun test" },
  }, null, 2));
  write(cwd, "src/queue.ts", `export interface Job { id: string; payload: string }\nexport class Queue {\n  private jobs: Job[] = [];\n  enqueue(job: Job): void { this.jobs.push(job); }\n  dequeue(): Job | undefined { return this.jobs.shift(); }\n}\n`);
  write(cwd, "test/queue.test.ts", `import { test } from "bun:test";\nimport assert from "node:assert/strict";\nimport { Queue } from "../src/queue.ts";\n\ntest("dequeues FIFO", () => {\n  const queue = new Queue();\n  queue.enqueue({ id: "1", payload: "a" });\n  assert.equal(queue.dequeue()?.id, "1");\n});\n`);
  write(cwd, "docs/runbook.md", "# Queue migration runbook\n\nRollback: revert src/queue.ts and rerun bun test.\n");
}

function write(cwd: string, relativePath: string, content: string): void {
  const file = path.join(cwd, relativePath);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

function writeReport(report: object): string {
  const dir = path.join(repoRoot, ".pi-chalin", "evals");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `long-running-${new Date().toISOString().replace(/[:.]/g, "-")}-${process.pid}.json`);
  fs.writeFileSync(file, `${JSON.stringify(report, null, 2)}\n`);
  return file;
}

function compact(value: string, max: number): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length <= max ? normalized : `${normalized.slice(0, max - 1)}…`;
}

function isMain(): boolean {
  return process.argv[1] ? path.resolve(process.argv[1]) === fileURLToPath(import.meta.url) : false;
}
