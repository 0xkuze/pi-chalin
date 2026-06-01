import type { RunState, RunStepMetrics } from "../src/schemas.ts";

export type TrajectoryFindingId =
  | "tool_misuse"
  | "verification_skipped"
  | "hallucinated_completion"
  | "looping"
  | "scope_expansion"
  | "rewrite_large_file"
  | "budget_waste"
  | "state_regression";

export interface TrajectoryFinding {
  id: TrajectoryFindingId;
  pass: boolean;
  severity: "info" | "warning" | "critical";
  reason: string;
  evidence: string[];
}

export interface TrajectoryReport {
  pass: boolean;
  score: number;
  findings: {
    toolMisuse: TrajectoryFinding;
    verificationSkipped: TrajectoryFinding;
    hallucinatedCompletion: TrajectoryFinding;
    looping: TrajectoryFinding;
    scopeExpansion: TrajectoryFinding;
    rewriteLargeFile: TrajectoryFinding;
    budgetWaste: TrajectoryFinding;
    stateRegression: TrajectoryFinding;
  };
}

export function analyzeTrajectory(run: RunState): TrajectoryReport {
  const findings: TrajectoryReport["findings"] = {
    toolMisuse: finding("tool_misuse", true, "critical", "No child tool policy misuse detected.", []),
    verificationSkipped: finding("verification_skipped", true, "warning", "Verification evidence exists or route did not mutate state.", []),
    hallucinatedCompletion: finding("hallucinated_completion", true, "critical", "Completed steps contain evidence or a handoff.", []),
    looping: finding("looping", true, "warning", "No repeated read/tool loop detected.", []),
    scopeExpansion: finding("scope_expansion", true, "warning", "Touched files stayed inside expected route scope.", []),
    rewriteLargeFile: finding("rewrite_large_file", true, "critical", "No large rewrite or existing-file write detected.", []),
    budgetWaste: finding("budget_waste", true, "warning", "Tool usage produced acceptable signal.", []),
    stateRegression: finding("state_regression", true, "critical", "Run state ended consistently.", []),
  };

  const steps = run.steps;
  const allMetrics = steps.map((step) => step.metrics).filter((metrics): metrics is RunStepMetrics => Boolean(metrics));
  const policyViolations = allMetrics.flatMap((metrics) => metrics.policyViolations ?? []);
  if (policyViolations.length > 0) {
    findings.toolMisuse = finding("tool_misuse", false, "critical", "A child attempted a tool action blocked by policy.", policyViolations.slice(0, 6));
  }

  const mutated = allMetrics.some((metrics) => (metrics.toolCallsByName.edit ?? 0) > 0 || (metrics.toolCallsByName.write ?? 0) > 0);
  const verified = allMetrics.some((metrics) => Boolean(metrics.utility?.verificationDone) || (metrics.successfulPostMutationShellCommands ?? metrics.postMutationShellCommands ?? 0) > 0);
  if (mutated && !verified) {
    findings.verificationSkipped = finding("verification_skipped", false, "warning", "A mutation trajectory completed without validation evidence.", ["edit/write happened but no successful post-mutation shell command or verification utility was recorded"]);
  }

  const weakComplete = steps.filter((step) => step.status === "complete" && !hasEvidence(step.output?.text) && !hasEvidence(step.output?.handoff));
  if (weakComplete.length > 0) {
    findings.hallucinatedCompletion = finding("hallucinated_completion", false, "critical", "A step reported complete without evidence-backed findings or handoff.", weakComplete.map((step) => `${step.agent}:${step.id}`));
  }

  const loopEvidence = allMetrics.filter((metrics) => (metrics.duplicateReadCount ?? 0) >= 3 || Object.values(metrics.toolCallsByName).some((count) => count >= Math.max(12, metrics.toolCalls * 0.65)));
  if (loopEvidence.length > 0) {
    findings.looping = finding("looping", false, "warning", "A step repeated reads or one tool family excessively.", loopEvidence.map(describeMetric).slice(0, 4));
  }

  const touched = allMetrics.flatMap((metrics) => metrics.filesTouched ?? []);
  if (touched.length > 12) {
    findings.scopeExpansion = finding("scope_expansion", false, "warning", "The run touched more files than a bounded route should touch.", touched.slice(0, 12));
  }

  const rewriteEvidence = allMetrics.flatMap((metrics) => metrics.policyViolations ?? []).filter((violation) => /large_edit_block|write_existing_file/i.test(violation));
  const writeHeavy = allMetrics.some((metrics) => (metrics.toolCallsByName.write ?? 0) > 0 && (metrics.filesTouched?.length ?? 1) > 0);
  if (rewriteEvidence.length > 0 || writeHeavy) {
    findings.rewriteLargeFile = finding("rewrite_large_file", false, "critical", "The trajectory risked rewriting existing files instead of surgical edits.", rewriteEvidence.length ? rewriteEvidence : ["write tool used in a mutation step"]);
  }

  const wasteEvidence = steps.filter((step) => {
    const metrics = step.metrics;
    if (!metrics) return false;
    const resumableCap = step.status === "checkpointed" && hasEvidence(step.output?.handoff) && (metrics.utility?.findingsPerTool ?? 0) >= 0.08;
    if (resumableCap) return false;
    const utility = metrics.utility;
    const hardBudgetStops = (metrics.budgetCapHits ?? []).some((hit) => hit.severity === "hard") || (metrics.budgetStopCount ?? 0) > 0;
    const softBudgetLowSignal = (metrics.budgetCapHits ?? []).some((hit) => hit.severity === "soft") && utility !== undefined && utility.findingsPerTool < 0.08 && metrics.toolCalls >= 10;
    return hardBudgetStops || softBudgetLowSignal || (utility && utility.findingsPerTool < 0.08 && metrics.toolCalls >= 10);
  });
  if (wasteEvidence.length > 0) {
    findings.budgetWaste = finding("budget_waste", false, "warning", "Budget was consumed with low signal or hit a cap without a useful checkpoint.", wasteEvidence.map((step) => describeMetric(step.metrics!)).slice(0, 4));
  }

  if (run.status === "complete" && steps.some((step) => step.status === "failed" || step.status === "paused")) {
    findings.stateRegression = finding("state_regression", false, "critical", "Run state says complete while a child step is failed/paused.", steps.filter((step) => step.status !== "complete").map((step) => `${step.id}:${step.status}`));
  }

  const report: TrajectoryReport = { pass: true, score: 1, findings };
  report.score = scoreTrajectory(report);
  report.pass = Object.values(findings).every((item) => item.pass);
  return report;
}

export function scoreTrajectory(report: Pick<TrajectoryReport, "findings">): number {
  const weights: Record<TrajectoryFinding["severity"], number> = { info: 0.03, warning: 0.1, critical: 0.22 };
  const penalty = Object.values(report.findings)
    .filter((finding) => !finding.pass)
    .reduce((sum, item) => sum + weights[item.severity], 0);
  return Math.max(0, Math.round((1 - penalty) * 1000) / 1000);
}

function finding(id: TrajectoryFindingId, pass: boolean, severity: TrajectoryFinding["severity"], reason: string, evidence: string[]): TrajectoryFinding {
  return { id, pass, severity, reason, evidence };
}

function hasEvidence(text: string | undefined): boolean {
  if (!text) return false;
  return /\b(src\/|test\/|docs\/|package\.json|## Findings|validation|passed|changed|uses|found|risk|evidence)\b/i.test(text);
}

function describeMetric(metrics: RunStepMetrics): string {
  const calls = Object.entries(metrics.toolCallsByName).map(([name, count]) => `${name}:${count}`).join(",");
  const utility = metrics.utility ? ` signal:${metrics.utility.findingsPerTool}` : "";
  return `tools:${metrics.toolCalls} ${calls}${utility}`;
}
