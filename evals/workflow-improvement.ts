export interface WorkflowImprovementOutput {
  variant: string;
  runIndex: number;
  cwd?: string;
  durationMs?: number;
  finalText?: string;
  finalTextSnippet?: string;
  workspace?: { caseId?: string; pass?: boolean; score?: number };
  trace?: { pass?: boolean; score?: number };
  judge?: { pass?: boolean; score?: number };
  evidence?: {
    files?: Array<{
      path?: string;
      contentSnippet?: string;
    }>;
  };
  diagnostics?: {
    tokenTotal?: number;
    toolEvents?: number;
    toolCallsByName?: Record<string, number>;
    infrastructureFailure?: { kind?: string; message?: string };
    recoveredInfrastructureFailures?: Array<{ kind?: string; message?: string }>;
    verificationPassed?: boolean;
    finalAnswerMissing?: boolean;
    traceSummary?: {
      firstMutationEventIndex?: number;
      firstPassingVerificationEventIndex?: number;
      postVerificationExplorationCalls?: number;
      postVerificationShellCalls?: number;
      toolCallSequence?: string[];
    };
  };
  toolHistory?: {
    totalEvents?: number;
    events?: Array<{
      name?: string;
      phase?: string;
      isError?: boolean;
      argsSnippet?: string;
      resultSnippet?: string;
    }>;
  };
  agentHistory?: {
    totalRuns?: number;
    runs?: Array<{
      agents?: string[];
      totalSteps?: number;
      steps?: Array<{
        agent?: string;
        status?: string;
      }>;
    }>;
  };
}

export interface WorkflowImprovementJudge {
  caseId: string;
  runIndex: number;
  winnerVariant?: string;
  targetWins: boolean;
  targetRank?: number;
  skipped?: boolean;
  reason?: string;
  verdict?: string;
  critical?: string[];
  warnings?: string[];
}

export interface WorkflowImprovementRunSignal {
  caseId: string;
  runIndex: number;
  reportId?: string;
  reportPath?: string;
  winnerVariant?: string;
  targetRank?: number;
  classification: "target-win" | "quality-gap" | "efficiency-gap" | "infrastructure" | "judge-skipped" | "missing-data";
  qualityDelta: number;
  tokenDelta: number;
  durationDeltaMs: number;
  toolDelta: number;
  target: WorkflowImprovementVariantSignal;
  winner?: WorkflowImprovementVariantSignal;
  patterns: string[];
  recommendations: string[];
}

export interface WorkflowImprovementVariantSignal {
  variant: string;
  pass: boolean;
  workspaceScore: number;
  traceScore: number;
  judgeScore?: number;
  durationMs: number;
  tokens: number;
  toolEvents: number;
  finalTextChars: number;
  evidenceFileCount: number;
  evidenceSnippetChars: number;
  evidencePaths: string[];
  preMutationToolCalls: number;
  postVerificationToolCalls: number;
  toolSequence: string[];
  agentRuns: number;
  agentSteps: number;
  failedAgentSteps: number;
  agentSequence: string[];
  infrastructureFailure?: string;
}

export interface WorkflowImprovementSummary {
  comparisons: number;
  targetWins: number;
  targetLosses: number;
  skipped: number;
  qualityGaps: number;
  efficiencyGaps: number;
  infrastructureBlocked: number;
  signals: WorkflowImprovementRunSignal[];
  abstractRules: string[];
  patternCounts: Record<string, number>;
  caseSummaries: WorkflowImprovementCaseSummary[];
}

export interface WorkflowImprovementCaseSummary {
  caseId: string;
  comparisons: number;
  targetWins: number;
  targetLosses: number;
  qualityGaps: number;
  efficiencyGaps: number;
  infrastructureBlocked: number;
  skipped: number;
  missingData: number;
  winnerVariants: Record<string, number>;
  lossWinnerVariants: Record<string, number>;
  patternCounts: Record<string, number>;
  recommendationCounts: Record<string, number>;
  avgTokenPremium: number;
  maxTokenPremium: number;
  avgDurationPremiumMs: number;
  maxDurationPremiumMs: number;
  avgToolPremium: number;
  maxToolPremium: number;
}

export interface WorkflowImprovementReportInput {
  id?: string;
  reportPath?: string;
  model?: string;
  judgeModel?: string;
  outputs: readonly WorkflowImprovementOutput[];
  comparativeJudges?: readonly WorkflowImprovementJudge[];
}

export interface WorkflowImprovementReportsSummary {
  reports: number;
  comparisons: number;
  targetWins: number;
  targetLosses: number;
  skipped: number;
  qualityGaps: number;
  efficiencyGaps: number;
  infrastructureBlocked: number;
  signals: WorkflowImprovementRunSignal[];
  lossSignals: WorkflowImprovementRunSignal[];
  abstractRules: Record<string, number>;
  patternCounts: Record<string, number>;
  caseSummaries: WorkflowImprovementCaseSummary[];
  reportSummaries: Array<{
    id?: string;
    reportPath?: string;
    summary: WorkflowImprovementSummary;
  }>;
}

const targetVariant = "chalin";

export function summarizeWorkflowImprovementSignals(input: { outputs: readonly WorkflowImprovementOutput[]; comparativeJudges?: readonly WorkflowImprovementJudge[] }): WorkflowImprovementSummary {
  const judges = input.comparativeJudges ?? [];
  const signals = judges.length
    ? judges.map((judge) => signalFromJudge(judge, input.outputs))
    : signalsFromUnguidedOutputs(input.outputs);
  return summarizeWorkflowImprovementRunSignals(signals);
}

export function summarizeWorkflowImprovementRunSignals(signals: readonly WorkflowImprovementRunSignal[]): WorkflowImprovementSummary {
  return {
    comparisons: signals.filter((signal) => signal.classification !== "judge-skipped" && signal.classification !== "missing-data" && signal.classification !== "infrastructure").length,
    targetWins: signals.filter((signal) => signal.classification === "target-win").length,
    targetLosses: signals.filter((signal) => signal.classification === "quality-gap" || signal.classification === "efficiency-gap").length,
    skipped: signals.filter((signal) => signal.classification === "judge-skipped").length,
    qualityGaps: signals.filter((signal) => signal.classification === "quality-gap").length,
    efficiencyGaps: signals.filter((signal) => signal.classification === "efficiency-gap").length,
    infrastructureBlocked: signals.filter((signal) => signal.classification === "infrastructure").length,
    signals: [...signals],
    abstractRules: uniqueStrings(signals.flatMap((signal) => signal.recommendations)),
    patternCounts: countPatterns(signals),
    caseSummaries: summarizeWorkflowImprovementCaseSignals(signals),
  };
}

export function summarizeWorkflowImprovementReports(reports: readonly WorkflowImprovementReportInput[]): WorkflowImprovementReportsSummary {
  const reportSummaries = reports.map((report) => ({
    id: report.id,
    reportPath: report.reportPath,
    summary: summarizeWorkflowImprovementSignals({ outputs: report.outputs, comparativeJudges: report.comparativeJudges }),
  }));
  const abstractRules: Record<string, number> = {};
  for (const item of reportSummaries) {
    for (const rule of item.summary.abstractRules) abstractRules[rule] = (abstractRules[rule] ?? 0) + 1;
  }
  const allSignals = reportSummaries.flatMap((item) => item.summary.signals.map((signal) => ({
    ...signal,
    reportId: item.id,
    reportPath: item.reportPath,
  })));

  return {
    reports: reportSummaries.length,
    comparisons: sum(reportSummaries, (item) => item.summary.comparisons),
    targetWins: sum(reportSummaries, (item) => item.summary.targetWins),
    targetLosses: sum(reportSummaries, (item) => item.summary.targetLosses),
    skipped: sum(reportSummaries, (item) => item.summary.skipped),
    qualityGaps: sum(reportSummaries, (item) => item.summary.qualityGaps),
    efficiencyGaps: sum(reportSummaries, (item) => item.summary.efficiencyGaps),
    infrastructureBlocked: sum(reportSummaries, (item) => item.summary.infrastructureBlocked),
    signals: allSignals,
    lossSignals: allSignals.filter((signal) => signal.classification === "quality-gap" || signal.classification === "efficiency-gap"),
    abstractRules,
    patternCounts: countPatterns(allSignals),
    caseSummaries: summarizeWorkflowImprovementCaseSignals(allSignals),
    reportSummaries,
  };
}

function summarizeWorkflowImprovementCaseSignals(signals: readonly WorkflowImprovementRunSignal[]): WorkflowImprovementCaseSummary[] {
  const byCase = new Map<string, WorkflowImprovementRunSignal[]>();
  for (const signal of signals) byCase.set(signal.caseId, [...(byCase.get(signal.caseId) ?? []), signal]);
  return [...byCase.entries()]
    .map(([caseId, caseSignals]) => summarizeWorkflowImprovementCaseSignal(caseId, caseSignals))
    .sort((a, b) => b.targetLosses - a.targetLosses
      || b.qualityGaps - a.qualityGaps
      || b.efficiencyGaps - a.efficiencyGaps
      || b.maxTokenPremium - a.maxTokenPremium
      || a.caseId.localeCompare(b.caseId));
}

function summarizeWorkflowImprovementCaseSignal(caseId: string, signals: readonly WorkflowImprovementRunSignal[]): WorkflowImprovementCaseSummary {
  const losses = signals.filter((signal) => signal.classification === "quality-gap" || signal.classification === "efficiency-gap");
  const tokenPremiums = losses.map((signal) => Math.max(0, signal.tokenDelta));
  const durationPremiums = losses.map((signal) => Math.max(0, signal.durationDeltaMs));
  const toolPremiums = losses.map((signal) => Math.max(0, signal.toolDelta));
  const winnerVariants: Record<string, number> = {};
  const lossWinnerVariants: Record<string, number> = {};
  const patternCounts: Record<string, number> = {};
  const recommendationCounts: Record<string, number> = {};
  for (const signal of signals) {
    if (signal.winnerVariant) winnerVariants[signal.winnerVariant] = (winnerVariants[signal.winnerVariant] ?? 0) + 1;
    if ((signal.classification === "quality-gap" || signal.classification === "efficiency-gap") && signal.winnerVariant) {
      lossWinnerVariants[signal.winnerVariant] = (lossWinnerVariants[signal.winnerVariant] ?? 0) + 1;
    }
    for (const pattern of signal.patterns) patternCounts[pattern] = (patternCounts[pattern] ?? 0) + 1;
    for (const recommendation of signal.recommendations) recommendationCounts[recommendation] = (recommendationCounts[recommendation] ?? 0) + 1;
  }
  return {
    caseId,
    comparisons: signals.filter((signal) => signal.classification !== "judge-skipped" && signal.classification !== "missing-data" && signal.classification !== "infrastructure").length,
    targetWins: signals.filter((signal) => signal.classification === "target-win").length,
    targetLosses: losses.length,
    qualityGaps: signals.filter((signal) => signal.classification === "quality-gap").length,
    efficiencyGaps: signals.filter((signal) => signal.classification === "efficiency-gap").length,
    infrastructureBlocked: signals.filter((signal) => signal.classification === "infrastructure").length,
    skipped: signals.filter((signal) => signal.classification === "judge-skipped").length,
    missingData: signals.filter((signal) => signal.classification === "missing-data").length,
    winnerVariants,
    lossWinnerVariants,
    patternCounts,
    recommendationCounts,
    avgTokenPremium: round(avg(tokenPremiums)),
    maxTokenPremium: Math.max(0, ...tokenPremiums),
    avgDurationPremiumMs: round(avg(durationPremiums)),
    maxDurationPremiumMs: Math.max(0, ...durationPremiums),
    avgToolPremium: round(avg(toolPremiums)),
    maxToolPremium: Math.max(0, ...toolPremiums),
  };
}

function signalFromJudge(judge: WorkflowImprovementJudge, outputs: readonly WorkflowImprovementOutput[]): WorkflowImprovementRunSignal {
  const target = outputs.find((output) => output.workspace?.caseId === judge.caseId && output.runIndex === judge.runIndex && output.variant === targetVariant);
  if (judge.skipped) return skippedSignal(judge, target);
  if (!target) return missingSignal(judge);
  const winner = judge.winnerVariant
    ? outputs.find((output) => output.workspace?.caseId === judge.caseId && output.runIndex === judge.runIndex && output.variant === judge.winnerVariant)
    : undefined;
  return buildSignal(judge, target, winner);
}

function signalsFromUnguidedOutputs(outputs: readonly WorkflowImprovementOutput[]): WorkflowImprovementRunSignal[] {
  const keys = uniqueStrings(outputs.map((output) => `${output.workspace?.caseId ?? "unknown"}:${output.runIndex}`));
  return keys.map((key) => {
    const [caseId = "unknown", runText = "0"] = key.split(":");
    const runIndex = Number(runText);
    const target = outputs.find((output) => output.workspace?.caseId === caseId && output.runIndex === runIndex && output.variant === targetVariant);
    const winner = outputs
      .filter((output) => output.workspace?.caseId === caseId && output.runIndex === runIndex && output.variant !== targetVariant)
      .sort(compareOutputsForUnguidedWinner)[0];
    if (!target) return missingSignal({ caseId, runIndex });
    return buildSignal({ caseId, runIndex, targetWins: false, winnerVariant: winner?.variant }, target, winner);
  });
}

function buildSignal(judge: WorkflowImprovementJudge, targetOutput: WorkflowImprovementOutput, winnerOutput: WorkflowImprovementOutput | undefined): WorkflowImprovementRunSignal {
  const target = variantSignal(targetOutput);
  const winner = winnerOutput ? variantSignal(winnerOutput) : undefined;
  const qualityDelta = winner ? targetQuality(target) - targetQuality(winner) : 0;
  const tokenDelta = winner ? target.tokens - winner.tokens : 0;
  const durationDeltaMs = winner ? target.durationMs - winner.durationMs : 0;
  const toolDelta = winner ? target.toolEvents - winner.toolEvents : 0;
  const classification = classifySignal(judge, target, winner, qualityDelta, tokenDelta, durationDeltaMs, toolDelta);
  const patterns = improvementPatternsForSignal(classification, judge, targetOutput, winnerOutput, target, winner, { tokenDelta, durationDeltaMs, toolDelta });
  return {
    caseId: judge.caseId,
    runIndex: judge.runIndex,
    winnerVariant: judge.winnerVariant,
    targetRank: judge.targetRank,
    classification,
    qualityDelta,
    tokenDelta,
    durationDeltaMs,
    toolDelta,
    target,
    winner,
    patterns,
    recommendations: uniqueStrings([
      ...recommendationsForSignal(classification, target, winner, { tokenDelta, durationDeltaMs, toolDelta }),
      ...recommendationsForPatterns(patterns),
    ]),
  };
}

function classifySignal(judge: WorkflowImprovementJudge, target: WorkflowImprovementVariantSignal, winner: WorkflowImprovementVariantSignal | undefined, qualityDelta: number, tokenDelta: number, durationDeltaMs: number, toolDelta: number): WorkflowImprovementRunSignal["classification"] {
  if (target.infrastructureFailure) return "infrastructure";
  if (judge.targetWins) return "target-win";
  if (!winner) return "missing-data";
  if (qualityDelta < 0 || !target.pass || (winner.pass && !target.pass)) return "quality-gap";
  const materiallyMoreExpensive = tokenDelta > Math.max(6_000, winner.tokens * 0.2)
    || durationDeltaMs > Math.max(3_000, winner.durationMs * 0.2)
    || toolDelta > 2;
  return materiallyMoreExpensive ? "efficiency-gap" : "quality-gap";
}

function recommendationsForSignal(classification: WorkflowImprovementRunSignal["classification"], target: WorkflowImprovementVariantSignal, winner: WorkflowImprovementVariantSignal | undefined, deltas: { tokenDelta: number; durationDeltaMs: number; toolDelta: number }): string[] {
  const rules: string[] = [];
  if (classification === "infrastructure") {
    rules.push("Do not tune prompts from provider/CLI/agent infrastructure failures; rerun after health is restored and keep the row out of blind quality win-rate.");
    return rules;
  }
  if (classification === "judge-skipped" || classification === "missing-data" || classification === "target-win") return rules;

  if (classification === "quality-gap") {
    rules.push("When blind judge prefers a competitor, inspect the winning artifact before adding rules; only promote behavior that generalizes across cases.");
  }
  if (winner && target.preMutationToolCalls > winner.preMutationToolCalls + 1) {
    rules.push("For bounded direct tasks, read exact source/test files and mutate before broad discovery; extra pre-mutation tools must buy missing evidence.");
  }
  if (target.postVerificationToolCalls > 0) {
    rules.push("After a passing verification command, stop tool use and deliver the final answer unless new concrete failure evidence appears.");
  }
  if (winner && target.toolSequence.some(isSearchTool) && !winner.toolSequence.some(isSearchTool)) {
    rules.push("Named-file prompts should avoid ls/grep/find when direct reads expose the implementation and tests.");
  }
  if (target.failedAgentSteps > 0) {
    rules.push("Failed subagent steps are reliability signals; recover with a narrower retry or classify the row before using it for quality tuning.");
  }
  if (winner && target.agentSteps > winner.agentSteps + 1 && deltas.toolDelta > 2) {
    rules.push("Agent routes must add concrete coverage; when a direct competitor matches quality with fewer steps, prefer native/direct execution.");
  }
  if (deltas.tokenDelta > 6_000) {
    rules.push("For quality-equivalent outputs, token premium is a regression; compress progress/final text and avoid redundant reads.");
  }
  if (deltas.durationDeltaMs > 3_000) {
    rules.push("For quality-equivalent outputs, run one focused verification after batched edits instead of extending the turn.");
  }
  if (deltas.toolDelta > 2) {
    rules.push("Tool count must track new evidence; repeated low-signal inspection should trigger an austerity nudge.");
  }
  return uniqueStrings(rules);
}

function skippedSignal(judge: WorkflowImprovementJudge, target: WorkflowImprovementOutput | undefined): WorkflowImprovementRunSignal {
  const targetSignal = target ? variantSignal(target) : emptyVariantSignal(targetVariant);
  return {
    caseId: judge.caseId,
    runIndex: judge.runIndex,
    winnerVariant: judge.winnerVariant,
    targetRank: judge.targetRank,
    classification: targetSignal.infrastructureFailure ? "infrastructure" : "judge-skipped",
    qualityDelta: 0,
    tokenDelta: 0,
    durationDeltaMs: 0,
    toolDelta: 0,
    target: targetSignal,
    patterns: [],
    recommendations: targetSignal.infrastructureFailure
      ? ["Do not tune prompts from provider/CLI/agent infrastructure failures; rerun after health is restored and keep the row out of blind quality win-rate."]
      : [],
  };
}

function missingSignal(judge: Pick<WorkflowImprovementJudge, "caseId" | "runIndex" | "winnerVariant" | "targetRank">): WorkflowImprovementRunSignal {
  return {
    caseId: judge.caseId,
    runIndex: judge.runIndex,
    winnerVariant: judge.winnerVariant,
    targetRank: judge.targetRank,
    classification: "missing-data",
    qualityDelta: 0,
    tokenDelta: 0,
    durationDeltaMs: 0,
    toolDelta: 0,
    target: emptyVariantSignal(targetVariant),
    patterns: [],
    recommendations: [],
  };
}

function improvementPatternsForSignal(classification: WorkflowImprovementRunSignal["classification"], judge: WorkflowImprovementJudge, targetOutput: WorkflowImprovementOutput, winnerOutput: WorkflowImprovementOutput | undefined, target: WorkflowImprovementVariantSignal, winner: WorkflowImprovementVariantSignal | undefined, deltas: { tokenDelta: number; durationDeltaMs: number; toolDelta: number }): string[] {
  if (classification !== "quality-gap" && classification !== "efficiency-gap") return [];
  const verdict = [
    judge.reason,
    judge.verdict,
    ...(judge.critical ?? []),
    ...(judge.warnings ?? []),
  ].filter((item): item is string => Boolean(item)).join("\n");
  const verdictLower = verdict.toLowerCase();
  const targetEvidence = workflowImprovementEvidenceText(targetOutput).toLowerCase();
  const winnerEvidence = winnerOutput ? workflowImprovementEvidenceText(winnerOutput).toLowerCase() : "";
  const targetSourceCount = target.evidencePaths.filter(isSourceEvidencePath).length;
  const winnerSourceCount = winner?.evidencePaths.filter(isSourceEvidencePath).length ?? 0;
  const patterns: string[] = [];

  if (
    /\b(coverage|cobertura|edge cases?|edge[- ]?case|variations?|variaciones|numerator|negative|negativ[oa]|\binfinity\b|-infinity|más tests?|more tests?)\b/i.test(verdict)
    && target.evidencePaths.some(isTestEvidencePath)
  ) {
    patterns.push("branch-coverage-sample-gap");
  }
  if (
    /\b(scope creep|extra file|fichero extra|archivo extra|metadata|package\.json|readme|api|start script|bin|exports?|main|types|dist|files)\b/i.test(verdict)
    && target.evidencePaths.some((item) => /package\.json|readme/i.test(item))
  ) {
    patterns.push("scaffold-surface-contract-gap");
  }
  if (
    /\b(test file|tests? (?:are )?placed|src\/.*test|test\/\*|tests\/|required test|missing expected test|compiled publish output|published surface|runner-discoverable)\b/i.test(verdict)
    && /\b(src\/|test\/|tests\/|dist|publish|package)\b/i.test(verdict)
  ) {
    patterns.push("scaffold-test-surface-path-gap");
  }
  if (
    /\b(not discovered|not discover(?:ed|able)|runner did not|discover -s tests|unittest discover|root test|ra[ií]z|wrong (?:test )?directory|skipped by (?:the )?runner|ran \d+ tests?|only \d+ tests?)\b/i.test(verdict)
    && /\b(test|tests|unittest|runner|discover|coverage|cobertura)\b/i.test(verdict)
  ) {
    patterns.push("runner-discovered-test-gap");
  }
  if (
    /\b(custom error|tokenerror|non-string|no-string|not a string|public API|api pública|main\/types|types.*dist|files.*dist|package\.json)\b/i.test(verdict)
    && /(?:\bthrow\b|\berror\b|main|types|dist|files)/i.test(targetEvidence + "\n" + winnerEvidence)
  ) {
    patterns.push("publishable-library-contract-gap");
  }
  if (
    /\b(trim|trims|trimmed|normaliz|lowercase|lower-case|lowercased|min[úu]scul)\b/i.test(verdict)
    && /\b(return|returns|output|result|retorno|salida|concatenat|compose|joined|produce|produces|devuelve)\b/i.test(verdict)
  ) {
    patterns.push("normalization-output-contract-gap");
  }
  if (
    /\b(before|antes)\b.{0,80}\b(trim|normaliz|lowercase|casefold|regex|validat|validaci[oó]n)\b|\b(trim|normaliz|lowercase|casefold|regex|validat|validaci[oó]n)\b.{0,80}\b(before|antes)\b/i.test(verdict)
  ) {
    patterns.push("normalization-validation-order-gap");
  }
  const targetToolHistory = workflowImprovementToolHistoryText(targetOutput);
  if (
    outputTouchesOutsideWorkspace(targetOutput)
    || (
      /\b(outside (?:the )?workspace|fuera del workspace|home\/sibling|sibling directory|did not persist|missing expected test artifact|solo qued[oó] un readme|only .*readme)\b/i.test(verdict)
      && /(?:\/Users\/|\/home\/|cd\s+\/|successfully wrote .*\/)/i.test(targetToolHistory)
    )
  ) {
    patterns.push("workspace-boundary-mutation-gap");
  }
  if (
    /\b(runner|loader|framework|node_modules|module_not_found|zero tests?|0 tests?|tool calls?|sobreprocesamiento|install|dependency|dependenc|experimental|skipped|validaci[oó]n skipped)\b/i.test(verdict + "\n" + targetToolHistory)
    && /\b(node_modules|npx|experimental-strip-types|ts-node|tsx|uvu|vitest|jest|mocha|loader|register)\b/i.test(targetToolHistory)
    && (target.toolSequence.filter((name) => name === "bash").length >= 2 || deltas.tokenDelta > 6_000 || deltas.durationDeltaMs > 3_000)
  ) {
    patterns.push("greenfield-runner-chain-drift");
  }
  if (
    /\b(unknown|runtime validation|validaci[oó]n runtime|type validation|public signature|firma)\b/i.test(verdict)
    && /\b(non-string|no-string|not a string|string|number|checks?|validaci[oó]n)\b/i.test(verdict)
  ) {
    patterns.push("runtime-validation-type-contract-gap");
  }
  if (
    /\b(exploit|bypass|curl|attack chain|cadena de ataque|request shape|suplantaci[oó]n|impersonation)\b/i.test(verdict)
    && /\b(auth|security|seguridad|boundary|frontera|vulnerab|risk|riesgo)\b/i.test(verdict)
  ) {
    patterns.push("security-review-actionability-gap");
  }
  if (
    /\b(decision matrix|design decisions?|decisiones? de dise[ñn]o|coupling|ownership|dependency delta|reverse[- ]dependency|golden[- ]?test|stage 0|plan ejecutable|actionable plan)\b/i.test(verdict)
    && (/\b(architecture|arquitectura|migration|migraci[oó]n|refactor|plan)\b/i.test(verdict) || target.evidencePaths.some(isDocsEvidencePath))
  ) {
    patterns.push("architecture-plan-actionability-gap");
  }
  if (
    /\b(omit|omits|omiti[oó]|missing relevant|relevant file|domain-critical|critical file|not enough evidence|insufficient evidence|rediscover|caller|callers|imports?|tests?|fixtures?|config|docs?|adjacent patterns?)\b/i.test(verdict)
    && /\b(handoff|context|evidence|coverage|read|source|archivo|file)\b/i.test(verdict)
  ) {
    patterns.push("context-handoff-coverage-gap");
  }
  if (
    /\b(simple|simpler|conventional|mini(?:\s|-)library|mini librer[ií]a|overload|sobrecarga|flexibility|flexibilidad|complexity|complejidad|second primary api)\b/i.test(verdict)
    && /\b(api|public|parameter|par[aá]metro|env[- ]?map|options?|config|library|librer[ií]a)\b/i.test(verdict)
  ) {
    patterns.push("api-simplicity-contract-gap");
  }
  if (target.toolSequence.some((name, index) => name === "bash" && index < firstMutationIndex(target.toolSequence))) {
    patterns.push("pre-mutation-verification-loop");
  }
  if (
    target.toolSequence.slice(0, firstMutationIndex(target.toolSequence)).some((name) => name === "chalin_project_discovery" || name === "chalin_project_snapshot")
    && (deltas.tokenDelta > 6_000 || deltas.durationDeltaMs > 3_000 || deltas.toolDelta > 0)
  ) {
    patterns.push("bounded-discovery-tool-tax");
  }
  if (target.toolSequence.filter((name) => name === "bash").length >= 2 && target.toolSequence.filter((name) => name === "edit" || name === "write").length >= 2 && (deltas.durationDeltaMs > 3_000 || deltas.tokenDelta > 6_000)) {
    patterns.push("second-pass-verification-cost");
  }
  if (winner && targetSourceCount > winnerSourceCount && targetQuality(target) <= targetQuality(winner)) {
    patterns.push("unjustified-artifact-split");
  }
  if (
    /\b(marginal extra coverage|extra coverage|redundant|trivial|same 100|quality is equivalent|calidad equivalente|doesn'?t move practical quality|no mueve)\b/i.test(verdict)
    && (deltas.tokenDelta > 6_000 || deltas.durationDeltaMs > 3_000)
  ) {
    patterns.push("low-value-overcoverage-cost-gap");
  }
  if (
    /\b(single unit|unit test|test unitario|not do more|no hagas? de m[aá]s|no refactorices? de m[aá]s|scope solicitado|scope pedido|extra assertions?|aserciones extra|combinaciones extra|same class|sign|signo|preservation)\b/i.test(verdict)
    && target.evidencePaths.some(isTestEvidencePath)
  ) {
    patterns.push("focused-test-scope-creep");
  }
  if (
    /\b(clamp|bounds?|range|rango|trivial|one[- ]line|una l[ií]nea|exact min|exact max|l[ií]mites exactos|negative range|rangos negativos|min>max|reversed)\b/i.test(verdict)
    && /\b(extra tests?|7 tests?|more tests?|marginal|equivalent|calidad equivalente|quality is equivalent)\b/i.test(verdict)
    && target.evidencePaths.some(isTestEvidencePath)
  ) {
    patterns.push("trivial-bounds-overcoverage");
  }
  if (
    /\b(overwrite|sobrescrib|reset(?:s|ear)?|renew|renueva|deadline|expiresAt|expiry|ttl|window)\b/i.test(verdict)
    && /\b(coverage|cobertura|test|verifica|verifies|no tiene|missing|falta)\b/i.test(verdict)
  ) {
    patterns.push("stateful-update-coverage-gap");
  }
  if (
    /\b(single element|one element|singleton|un solo elemento|iso datetime|datetime strings?|fecha(?:s)? con hora|componente de tiempo|lexicographic(?:al)?|lexicogr[aá]fic)\b/i.test(verdict)
    && /\b(stable sort|sorts?|sorting|orden estable|priority|prioridad|dueDate|secondary order|orden secundario|coverage|tests?)\b/i.test(verdict)
  ) {
    patterns.push("stable-sort-edge-coverage-gap");
  }
  if (
    /\b(deepEqual|deep equal|full (?:object|returned object|structure|shape)|estructura completa|objetos? completos?|not only (?:the )?IDs?|solo los IDs?|mapped ids?|map\([^)]*id)\b/i.test(verdict)
    && /\b(filter|query|search|filtro|b[uú]squeda|returned objects?|return contract|contrato de retorno|assertions?|tests?)\b/i.test(verdict)
  ) {
    patterns.push("object-filter-return-shape-assertion-gap");
  }
  if (
    /\b(no[- ]?mutation|input[- ]array mutation|input mutation|original array|preserve(?:s|d)? input|mutaci[oó]n|mutar|inmutabilidad)\b/i.test(verdict)
    && /\b(empty[- ]?string|empty description|description:\s*["'`]{2}|description\s+""|descripci[oó]n vac[ií]a|string vac[ií]o|cadena vac[ií]a|optional\/missing|missing description|optional fields?)\b/i.test(verdict)
    && /\b(filter|query|search|filtro|b[uú]squeda|title|description|descripci[oó]n|tests?|coverage|cobertura)\b/i.test(verdict)
  ) {
    patterns.push("object-filter-boundary-mutation-gap");
  }
  if (deltas.tokenDelta > 6_000 || deltas.durationDeltaMs > 3_000 || deltas.toolDelta > 2) {
    patterns.push("quality-equivalent-cost-premium");
  }
  return uniqueStrings(patterns);
}

function recommendationsForPatterns(patterns: readonly string[]): string[] {
  const rules: string[] = [];
  if (patterns.includes("branch-coverage-sample-gap")) {
    rules.push("For test-only or focused coverage work, inspect the predicate and cover each branch/value class with compact assertions; one nominal sample per branch is not enough for compound guards.");
  }
  if (patterns.includes("scaffold-surface-contract-gap")) {
    rules.push("For scaffold/API work, keep the requested public entrypoint as the API surface; avoid helper-file splits and behavior broadening unless the prompt or local convention requires them.");
  }
  if (patterns.includes("scaffold-test-surface-path-gap")) {
    rules.push("For package scaffolds, place tests under root test/ or tests/ unless prompt or repo convention asks inline; do not compile tests into the published source surface.");
  }
  if (patterns.includes("runner-discovered-test-gap")) {
    rules.push("Executable coverage must live where the verification runner discovers it; for Python unittest with a tests/ root, update tests/test_<stem>.py and verify with python -m unittest discover -s tests instead of creating root duplicate tests.");
  }
  if (patterns.includes("publishable-library-contract-gap")) {
    rules.push("For publishable libraries, align package metadata with the built surface and expose a documented error surface when input validation is part of the public API contract.");
  }
  if (patterns.includes("normalization-output-contract-gap")) {
    rules.push("When validation trims or normalizes values, reuse those normalized locals in returned output and cover one spaced-input output assertion.");
  }
  if (patterns.includes("normalization-validation-order-gap")) {
    rules.push("When trim/lowercase normalization is part of the contract, normalize into locals before regex/domain validation and test a whitespace-wrapped valid input.");
  }
  if (patterns.includes("greenfield-runner-chain-drift")) {
    rules.push("For new packages, choose one reproducible runner before writing files; package scripts must not rely on npx, experimental TS strip flags, undeclared binaries, or node_modules probing.");
  }
  if (patterns.includes("workspace-boundary-mutation-gap")) {
    rules.push("For direct scaffold/project work, mutate and verify only inside the current workspace root using relative paths; if a tool writes or verifies outside cwd, recreate the artifacts under cwd before final.");
  }
  if (patterns.includes("runtime-validation-type-contract-gap")) {
    rules.push("For public TypeScript APIs with runtime invalid-type tests, use a broad enough public parameter type or do not claim/test unreachable runtime validation.");
  }
  if (patterns.includes("security-review-actionability-gap")) {
    rules.push("For bounded security reviews, include one concrete exploit/request path or attack chain plus impact and remediation; drop filler risks that are not code-proven.");
  }
  if (patterns.includes("architecture-plan-actionability-gap")) {
    rules.push("For architecture/refactor docs, make the plan executable: include design options with a recommendation, responsibility/coupling ownership, dependency deltas, stage-0 golden tests, reverse-dependency checks, staged exit criteria, risks, rollback, and explicit out-of-scope boundaries.");
  }
  if (patterns.includes("context-handoff-coverage-gap")) {
    rules.push("For context-builder handoffs, follow imports, callers, tests, fixtures, config, docs, and adjacent patterns until the approach, risks, and validation path are evidence-backed; do not omit a domain-critical file just to keep the handoff short.");
  }
  if (patterns.includes("api-simplicity-contract-gap")) {
    rules.push("For small public libraries, keep the prompt-named API simple and conventional first; support compatibility unions only when ambiguity is real, and document alternate forms as secondary rather than the main API.");
  }
  if (patterns.includes("pre-mutation-verification-loop")) {
    rules.push("For bounded direct implementation, do not run baseline verification before the first edit unless the task is explicit failing-test triage.");
  }
  if (patterns.includes("bounded-discovery-tool-tax")) {
    rules.push("For exact package-local source/test work, broad discovery tools should be out of scope; read the manifest, source, and direct test candidate instead.");
  }
  if (patterns.includes("second-pass-verification-cost")) {
    rules.push("After a failed verification, patch one concrete root cause and rerun once; avoid read/verify loops that do not buy new evidence.");
  }
  if (patterns.includes("unjustified-artifact-split")) {
    rules.push("Extra source artifacts must buy clear ownership or testability; otherwise keep the implementation in the requested public surface.");
  }
  if (patterns.includes("low-value-overcoverage-cost-gap")) {
    rules.push("For trivial transforms, do not add redundant edge tests after the core contract is covered; an ordinary unchanged case can satisfy preservation.");
  }
  if (patterns.includes("focused-test-scope-creep")) {
    rules.push("When the user asks for one focused test or says not to do more, make one focused test change: split distinct guard branches into named blocks only when it improves failure diagnosis, and avoid duplicate samples or unrelated preservation assertions.");
  }
  if (patterns.includes("trivial-bounds-overcoverage")) {
    rules.push("For trivial package-local bounds helpers, cover inside/below/above/exact min/exact max/min==max plus one signed/range case and one decimal when the public API accepts general numbers; do not add reversed-bound, non-finite, or new error policy unless prompt or source evidence requires it.");
  }
  if (patterns.includes("stateful-update-coverage-gap")) {
    rules.push("For stateful/time work, overwrite/update tests must prove both the new value and renewed deadline/window when the public contract depends on time.");
  }
  if (patterns.includes("stable-sort-edge-coverage-gap")) {
    rules.push("For stable sort helpers, cover empty and singleton/no-op inputs, primary and secondary ordering, tie stability, no mutation/new reference, and ISO datetime-string ordering when date fields are generic strings.");
  }
  if (patterns.includes("object-filter-return-shape-assertion-gap")) {
    rules.push("For object-returning filter/search helpers, use full-shape deepEqual assertions for representative returned objects and no-match/blank cases; mapped-id checks should be secondary order checks, not the only contract proof.");
  }
  if (patterns.includes("object-filter-boundary-mutation-gap")) {
    rules.push("For object-returning filter/search helpers, cover optional text fields in both missing and empty-string forms, preserve input order, and assert the original input array is not mutated.");
  }
  return rules;
}

function variantSignal(output: WorkflowImprovementOutput): WorkflowImprovementVariantSignal {
  const historySequence = output.toolHistory?.events
    ?.filter((event) => event.phase !== "end")
    .map((event) => event.name)
    .filter((name): name is string => typeof name === "string") ?? [];
  const sequence = output.diagnostics?.traceSummary?.toolCallSequence ?? historySequence;
  const firstMutation = output.diagnostics?.traceSummary?.firstMutationEventIndex;
  const preMutationToolCalls = typeof firstMutation === "number" ? sequence.slice(0, Math.max(0, firstMutation)).length : sequence.length;
  const postVerificationToolCalls = (output.diagnostics?.traceSummary?.postVerificationExplorationCalls ?? 0)
    + (output.diagnostics?.traceSummary?.postVerificationShellCalls ?? 0);
  const infrastructureFailure = output.diagnostics?.infrastructureFailure;
  const recoveredInfrastructureFailure = output.diagnostics?.recoveredInfrastructureFailures?.[0];
  const agentHistory = workflowImprovementAgentHistoryStats(output);
  const evidence = workflowImprovementEvidenceStats(output);
  const finalText = output.finalText ?? output.finalTextSnippet ?? "";
  return {
    variant: output.variant,
    pass: Boolean(output.workspace?.pass && output.trace?.pass && output.judge?.pass !== false),
    workspaceScore: output.workspace?.score ?? 0,
    traceScore: output.trace?.score ?? 0,
    judgeScore: output.judge?.score,
    durationMs: output.durationMs ?? 0,
    tokens: output.diagnostics?.tokenTotal ?? 0,
    toolEvents: output.diagnostics?.toolEvents ?? output.toolHistory?.totalEvents ?? sequence.length,
    finalTextChars: finalText.length,
    evidenceFileCount: evidence.count,
    evidenceSnippetChars: evidence.snippetChars,
    evidencePaths: evidence.paths,
    preMutationToolCalls,
    postVerificationToolCalls,
    toolSequence: sequence,
    agentRuns: agentHistory.runs,
    agentSteps: agentHistory.steps,
    failedAgentSteps: agentHistory.failedSteps,
    agentSequence: agentHistory.sequence,
    infrastructureFailure: infrastructureFailure
      ? `${infrastructureFailure.kind ?? "unknown"}: ${infrastructureFailure.message ?? "unknown"}`
      : recoveredInfrastructureFailure
      ? `recovered-${recoveredInfrastructureFailure.kind ?? "unknown"}: ${recoveredInfrastructureFailure.message ?? "unknown"}`
      : undefined,
  };
}

function workflowImprovementEvidenceStats(output: WorkflowImprovementOutput): { count: number; snippetChars: number; paths: string[] } {
  const files = output.evidence?.files ?? [];
  return {
    count: files.length,
    snippetChars: files.reduce((total, file) => total + (file.contentSnippet?.length ?? 0), 0),
    paths: uniqueStrings(files.map((file) => file.path).filter((path): path is string => typeof path === "string" && path.length > 0)).slice(0, 40),
  };
}

function workflowImprovementEvidenceText(output: WorkflowImprovementOutput | undefined): string {
  return output?.evidence?.files?.map((file) => [file.path, file.contentSnippet].filter(Boolean).join("\n")).join("\n") ?? "";
}

function workflowImprovementToolHistoryText(output: WorkflowImprovementOutput | undefined): string {
  return output?.toolHistory?.events
    ?.map((event) => [event.name, event.argsSnippet, event.resultSnippet].filter(Boolean).join("\n"))
    .join("\n") ?? "";
}

function outputTouchesOutsideWorkspace(output: WorkflowImprovementOutput): boolean {
  const cwd = normalizeComparablePath(output.cwd);
  if (!cwd) return false;
  const text = workflowImprovementToolHistoryText(output);
  const candidates = [
    ...[...text.matchAll(/"(?:path|filePath|cwd)"\s*:\s*"([^"]+)"/g)].map((match) => match[1] ?? ""),
    ...[...text.matchAll(/(?:^|\s)cd\s+(?:"([^"]+)"|'([^']+)'|([/\w][^\s;&|]+))/g)].map((match) => match[1] ?? match[2] ?? match[3] ?? ""),
    ...[...text.matchAll(/Successfully wrote \d+ bytes to ([^\s]+)/g)].map((match) => match[1] ?? ""),
  ];
  return candidates.some((candidate) => pathOutsideWorkspace(candidate, cwd));
}

function pathOutsideWorkspace(value: string, cwd: string): boolean {
  const candidate = normalizeComparablePath(value);
  if (!candidate) return false;
  if (candidate.startsWith("~/")) return true;
  if (!candidate.startsWith("/")) return false;
  return candidate !== cwd && !candidate.startsWith(`${cwd}/`);
}

function normalizeComparablePath(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const normalized = value.trim().replace(/^['"]|['"]$/g, "").replaceAll("\\", "/").replace(/^\/private\//, "/").replace(/\/+$/g, "");
  return normalized || undefined;
}

function workflowImprovementAgentHistoryStats(output: WorkflowImprovementOutput): { runs: number; steps: number; failedSteps: number; sequence: string[] } {
  const runs = output.agentHistory?.runs ?? [];
  const sequence = runs.flatMap((run) => run.steps?.map((step) => step.agent).filter((agent): agent is string => typeof agent === "string" && agent.length > 0) ?? run.agents ?? []);
  const steps = runs.reduce((total, run) => total + (run.totalSteps ?? run.steps?.length ?? 0), 0);
  const failedSteps = runs.reduce((total, run) => total + (run.steps?.filter((step) => isFailedAgentStepStatus(step.status)).length ?? 0), 0);
  return {
    runs: output.agentHistory?.totalRuns ?? runs.length,
    steps,
    failedSteps,
    sequence,
  };
}

function isFailedAgentStepStatus(status: string | undefined): boolean {
  return Boolean(status && /fail|error|timeout|cancel|stale/i.test(status));
}

function emptyVariantSignal(variant: string): WorkflowImprovementVariantSignal {
  return {
    variant,
    pass: false,
    workspaceScore: 0,
    traceScore: 0,
    durationMs: 0,
    tokens: 0,
    toolEvents: 0,
    finalTextChars: 0,
    evidenceFileCount: 0,
    evidenceSnippetChars: 0,
    evidencePaths: [],
    preMutationToolCalls: 0,
    postVerificationToolCalls: 0,
    toolSequence: [],
    agentRuns: 0,
    agentSteps: 0,
    failedAgentSteps: 0,
    agentSequence: [],
  };
}

function targetQuality(signal: WorkflowImprovementVariantSignal): number {
  return Math.min(signal.workspaceScore, signal.traceScore, signal.judgeScore ?? signal.workspaceScore);
}

function compareOutputsForUnguidedWinner(a: WorkflowImprovementOutput, b: WorkflowImprovementOutput): number {
  const aSignal = variantSignal(a);
  const bSignal = variantSignal(b);
  return targetQuality(bSignal) - targetQuality(aSignal)
    || Number(bSignal.pass) - Number(aSignal.pass)
    || aSignal.tokens - bSignal.tokens
    || aSignal.durationMs - bSignal.durationMs;
}

function isSearchTool(name: string): boolean {
  return name === "ls" || name === "grep" || name === "find" || name === "chalin_project_discovery" || name === "chalin_project_snapshot";
}

function firstMutationIndex(sequence: readonly string[]): number {
  const index = sequence.findIndex((name) => name === "edit" || name === "write");
  return index === -1 ? sequence.length : index;
}

function isTestEvidencePath(value: string): boolean {
  const normalized = value.replaceAll("\\", "/").toLowerCase();
  const file = normalized.split("/").at(-1) ?? "";
  return normalized.includes("/test/")
    || normalized.includes("/tests/")
    || file.includes(".test.")
    || file.includes(".spec.")
    || file.startsWith("test_")
    || file.endsWith("_test.go")
    || file.endsWith("_test.rs");
}

function isSourceEvidencePath(value: string): boolean {
  const normalized = value.replaceAll("\\", "/").toLowerCase();
  if (isTestEvidencePath(normalized)) return false;
  if (normalized === "package.json" || normalized.endsWith("/package.json")) return false;
  if (normalized.endsWith(".md") || normalized.endsWith(".json") || normalized.endsWith(".lock")) return false;
  return /\.(?:cjs|mjs|js|jsx|ts|tsx|py|go|rs|c|cc|cpp|h|hpp|java|kt|cs|php)$/.test(normalized);
}

function isDocsEvidencePath(value: string): boolean {
  return /\.mdx?$/i.test(value.replaceAll("\\", "/"));
}

function countPatterns(signals: readonly WorkflowImprovementRunSignal[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const signal of signals) {
    for (const pattern of signal.patterns) counts[pattern] = (counts[pattern] ?? 0) + 1;
  }
  return counts;
}

function uniqueStrings(items: string[]): string[] {
  return [...new Set(items)];
}

function sum<T>(items: readonly T[], pick: (item: T) => number): number {
  return items.reduce((total, item) => total + pick(item), 0);
}

function avg(items: readonly number[]): number {
  return items.length > 0 ? items.reduce((total, item) => total + item, 0) / items.length : 0;
}

function round(value: number): number {
  return Math.round(value);
}
