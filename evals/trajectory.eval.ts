#!/usr/bin/env bun
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { analyzeTrajectory, scoreTrajectory, type TrajectoryReport } from "../src/trajectory.ts";
import type { RunState, TokenUsageSummary } from "../src/schemas.ts";

interface TrajectoryEvalResult {
  id: string;
  pass: boolean;
  expectedPass: boolean;
  score: number;
  threshold: number;
  failedFindings: string[];
  report: TrajectoryReport;
}

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const startedAt = new Date().toISOString();
const threshold = positiveFloat(process.env.PI_CHALIN_TRAJECTORY_EVAL_MIN_SCORE, 0.86);
const cases = [
  {
    id: "healthy-verified-mutation",
    expectedPass: true,
    run: healthyRun(),
  },
  {
    id: "blocked-script-no-verification-budget-waste",
    expectedPass: false,
    run: badRun(),
  },
  {
    id: "budget-capped-checkpoint-is-not-failure",
    expectedPass: true,
    run: budgetCheckpointRun(),
  },
];

const results = cases.map(({ id, expectedPass, run }): TrajectoryEvalResult => {
  const report = analyzeTrajectory(run);
  const score = scoreTrajectory(report);
  const failedFindings = Object.values(report.findings).filter((finding) => !finding.pass).map((finding) => finding.id);
  const pass = expectedPass ? report.pass && score >= threshold : !report.pass && failedFindings.length > 0;
  return { id, pass, expectedPass, score, threshold, failedFindings, report };
});

const passed = results.filter((result) => result.pass).length;
const failed = results.length - passed;
const report = {
  startedAt,
  finishedAt: new Date().toISOString(),
  passed,
  failed,
  threshold,
  checks: ["tool_misuse", "verification_skipped", "hallucinated_completion", "looping", "scope_expansion", "rewrite_large_file", "budget_waste", "state_regression"],
  results,
};

const reportDir = path.join(repoRoot, ".pi-chalin", "evals");
fs.mkdirSync(reportDir, { recursive: true });
const reportPath = path.join(reportDir, `trajectory-${stamp(startedAt)}.json`);
fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);

console.log(`pi-chalin trajectory evals: ${passed}/${results.length} passed`);
for (const result of results) {
  console.log(`${result.pass ? "✓" : "✗"} ${result.id} · score=${result.score} · findings=${result.failedFindings.join(",") || "none"}`);
}
console.log(`report: ${reportPath}`);
if (failed > 0 && process.env.PI_CHALIN_TRAJECTORY_EVAL_ALLOW_FAIL !== "1") process.exit(1);

function healthyRun(): RunState {
  return baseRun("complete", [
    step("scout", "complete", { read: 2, grep: 1 }, { text: "## Findings\n- src/index.ts defines the extension entrypoint.", filesRead: ["src/index.ts"] }),
    step("worker", "complete", { read: 1, edit: 1 }, { text: "Changed one bounded line in src/index.ts.", filesRead: ["src/index.ts"], filesTouched: ["src/index.ts"] }),
    step("reviewer", "complete", { bash: 1 }, { text: "Validation passed with bun test.", verificationDone: true }),
  ]);
}

function badRun(): RunState {
  return baseRun("complete", [
    step("worker", "complete", { bash: 2, read: 18, write: 1 }, {
      text: "Done.",
      filesRead: ["a.ts", "a.ts", "a.ts", "b.ts", "b.ts", "c.ts"],
      filesTouched: ["a.ts"],
      policyViolations: ["bash_policy:python scan.py", "write_existing_file:a.ts"],
      duplicateReadCount: 3,
      budgetStopCount: 2,
      findingsPerTool: 0,
      verificationDone: false,
    }),
  ]);
}

function budgetCheckpointRun(): RunState {
  return baseRun("budget-capped", [
    step("context-builder", "budget-capped", { mesh_project_snapshot: 1, read: 8 }, {
      text: "## Findings\n- src/kernel.ts owns route execution.\n## Handoff\nPartial but useful handoff. Continue with reviewer.",
      filesRead: ["src/kernel.ts", "src/runner.ts"],
      budgetStopCount: 1,
      findingsPerTool: 0.11,
    }),
  ]);
}

function baseRun(status: RunState["status"], steps: RunState["steps"]): RunState {
  return {
    id: `trajectory-${status}`,
    status,
    startedAt: new Date().toISOString(),
    endedAt: new Date().toISOString(),
    warnings: [],
    route: {
      kind: "multi-agent-chain",
      agents: steps.map((item) => item.agent),
      risk: "medium",
      ambiguity: "low",
      needsMemory: true,
      needsArtifacts: true,
      reason: "trajectory eval",
    },
    steps,
    metrics: {
      durationMs: 100,
      usage: usage(),
      toolCalls: steps.reduce((sum, item) => sum + (item.metrics?.toolCalls ?? 0), 0),
      toolCallsByName: {},
    },
  };
}

function step(agent: string, status: RunState["status"], callsByName: Record<string, number>, options: {
  text: string;
  filesRead?: string[];
  filesTouched?: string[];
  policyViolations?: string[];
  duplicateReadCount?: number;
  budgetStopCount?: number;
  findingsPerTool?: number;
  verificationDone?: boolean;
}): RunState["steps"][number] {
  const toolCalls = Object.values(callsByName).reduce((sum, value) => sum + value, 0);
  return {
    id: `${agent}-1`,
    agent,
    task: `${agent} task`,
    status,
    output: { agent, text: options.text, handoff: options.text, raw: options.text, warnings: [], memoryCandidates: [] },
    metrics: {
      durationMs: 10,
      usage: usage(),
      toolCalls,
      maxToolCalls: 24,
      toolCallsByName: callsByName,
      filesRead: options.filesRead,
      filesTouched: options.filesTouched,
      policyViolations: options.policyViolations,
      duplicateReadCount: options.duplicateReadCount,
      budgetStopCount: options.budgetStopCount,
      utility: {
        findingsPerTool: options.findingsPerTool ?? 0.25,
        filesReadPerFinding: 1,
        duplicateReads: options.duplicateReadCount ?? 0,
        toolCallsBeforeFirstSignal: options.findingsPerTool === 0 ? toolCalls : 1,
        verificationDone: Boolean(options.verificationDone),
        memoryCandidatesQuality: 0.8,
      },
    },
  };
}

function usage(): TokenUsageSummary {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
}

function positiveFloat(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function stamp(value: string): string {
  return value.replace(/[:.]/g, "-");
}
