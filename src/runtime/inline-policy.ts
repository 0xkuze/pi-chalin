export type InlineToolEventPhase = "start" | "completed";
export type InlineNudgeKind =
  | "workspace-boundary"
  | "docs-shell"
  | "terminal-completion"
  | "post-terminal-drift"
  | "post-verification-shell"
  | "post-verification-exploration"
  | "locator-loop"
  | "existing-file-rewrite"
  | "mutation-loop"
  | "source-and-test-ready"
  | "verification-loop"
  | "post-failure-evidence"
  | "progress"
  | "ready-to-verify"
  | "test-coverage"
  | "weak-test-coverage"
  | "package-metadata"
  | "parallel-surface"
  | "failure"
  | "completion";

export interface InlineToolEvent {
  phase: InlineToolEventPhase;
  toolName: string;
  isError?: boolean;
  command?: string;
  path?: string;
  argsText?: string;
  observation?: string;
}

export interface InlineNudgePlan {
  kind: InlineNudgeKind;
  verificationCommand?: string;
  docsOnlyMutation: boolean;
  judge: PolicyJudgeDecision;
}

export type PolicyJudgeNextAction = "continue" | "nudge" | "verify" | "repair" | "finalize" | "block";

export interface SemanticPolicyJudgeRequest {
  key: string;
  turnId: number;
  trigger: InlineNudgeKind | "uncertain-continue";
  reasons: string[];
  snapshot: InlinePolicySnapshot;
}

export interface SemanticPolicyJudgeResult {
  nextAction: PolicyJudgeNextAction;
  nudgeKind?: InlineNudgeKind;
  reason: string;
  confidence: number;
  blockingGap: boolean;
  requiredEvidence: string[];
  steerMessage?: string;
  trace?: SemanticPolicyJudgeTrace;
}

export interface SemanticPolicyJudgeTrace {
  mode: "tool-schema" | "json-fallback";
  api: string;
  provider: string;
  model: string;
  responseModel?: string;
  responseId?: string;
  stopReason: string;
  usage: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    totalTokens: number;
    cost: {
      input: number;
      output: number;
      cacheRead: number;
      cacheWrite: number;
      total: number;
    };
  };
}

export interface PolicyJudgeDecision {
  nextAction: PolicyJudgeNextAction;
  reason: string;
  confidence: number;
  blockingGap: boolean;
  nudgeKind?: InlineNudgeKind;
  source?: "deterministic" | "semantic";
  semanticReview?: SemanticPolicyJudgeRequest;
  semanticResult?: SemanticPolicyJudgeResult;
}

export interface InlineToolCompletionAdapter {
  shouldProgressNudge: boolean;
  shouldReadyToVerifyNudge: boolean;
  shouldFailureNudge: boolean;
  shouldCompletionNudge: boolean;
  shouldTestCoverageNudge: boolean;
  shouldWeakTestCoverageNudge: boolean;
  shouldPackageMetadataNudge: boolean;
  shouldParallelSurfaceNudge: boolean;
  shouldWorkspaceBoundaryNudge: boolean;
  shouldDocsShellNudge: boolean;
  shouldTerminalCompletionNudge: boolean;
  shouldPostTerminalDriftNudge: boolean;
  shouldPostVerificationShellNudge: boolean;
  shouldPostVerificationExplorationNudge: boolean;
  shouldLocatorLoopNudge: boolean;
  shouldExistingFileRewriteNudge: boolean;
  shouldMutationLoopNudge: boolean;
  shouldSourceAndTestReadyNudge: boolean;
  shouldVerificationLoopNudge: boolean;
  shouldPostFailureEvidenceNudge: boolean;
  verificationCommand?: string;
  docsOnlyMutation: boolean;
  plan?: InlineNudgePlan;
  policyJudge?: PolicyJudgeDecision;
}

type InlineNudgeFlag = Exclude<keyof InlineToolCompletionAdapter, "verificationCommand" | "docsOnlyMutation" | "plan" | "policyJudge">;

export type InlineNudgeSelectorInput = Omit<InlineToolCompletionAdapter, "plan" | "policyJudge">;

export interface InlinePolicySnapshot {
  cwd?: string;
  mutationObserved: boolean;
  sourceMutationObserved: boolean;
  testMutationObserved: boolean;
  verificationObserved: boolean;
  verificationCommand?: string;
  terminalActionCommand?: string;
  docsOnlyMutation: boolean;
  changedPaths: string[];
  readPaths: string[];
  promptCodePaths: string[];
  toolEvents: InlineToolEvent[];
  counters: {
    mutationToolCount: number;
    evidenceToolCount: number;
    searchToolCount: number;
    readToolCount: number;
    verificationAttemptCount: number;
    postFailureEvidenceToolCount: number;
  };
}

export const INLINE_NUDGE_FLAGS = [
  "shouldProgressNudge",
  "shouldReadyToVerifyNudge",
  "shouldFailureNudge",
  "shouldCompletionNudge",
  "shouldTestCoverageNudge",
  "shouldWeakTestCoverageNudge",
  "shouldPackageMetadataNudge",
  "shouldParallelSurfaceNudge",
  "shouldWorkspaceBoundaryNudge",
  "shouldDocsShellNudge",
  "shouldTerminalCompletionNudge",
  "shouldPostTerminalDriftNudge",
  "shouldPostVerificationShellNudge",
  "shouldPostVerificationExplorationNudge",
  "shouldLocatorLoopNudge",
  "shouldExistingFileRewriteNudge",
  "shouldMutationLoopNudge",
  "shouldSourceAndTestReadyNudge",
  "shouldVerificationLoopNudge",
  "shouldPostFailureEvidenceNudge",
] as const satisfies readonly InlineNudgeFlag[];

const INLINE_NUDGE_PRIORITY = [
  ["workspace-boundary", "shouldWorkspaceBoundaryNudge"],
  ["weak-test-coverage", "shouldWeakTestCoverageNudge"],
  ["package-metadata", "shouldPackageMetadataNudge"],
  ["parallel-surface", "shouldParallelSurfaceNudge"],
  ["test-coverage", "shouldTestCoverageNudge"],
  ["failure", "shouldFailureNudge"],
  ["post-terminal-drift", "shouldPostTerminalDriftNudge"],
  ["terminal-completion", "shouldTerminalCompletionNudge"],
  ["completion", "shouldCompletionNudge"],
  ["docs-shell", "shouldDocsShellNudge"],
  ["post-verification-shell", "shouldPostVerificationShellNudge"],
  ["post-verification-exploration", "shouldPostVerificationExplorationNudge"],
  ["locator-loop", "shouldLocatorLoopNudge"],
  ["existing-file-rewrite", "shouldExistingFileRewriteNudge"],
  ["mutation-loop", "shouldMutationLoopNudge"],
  ["source-and-test-ready", "shouldSourceAndTestReadyNudge"],
  ["verification-loop", "shouldVerificationLoopNudge"],
  ["post-failure-evidence", "shouldPostFailureEvidenceNudge"],
  ["ready-to-verify", "shouldReadyToVerifyNudge"],
  ["progress", "shouldProgressNudge"],
] as const satisfies readonly (readonly [InlineNudgeKind, InlineNudgeFlag])[];

const semanticJudgeRelevantNudges = new Set<InlineNudgeKind>([
  "docs-shell",
  "locator-loop",
  "source-and-test-ready",
  "ready-to-verify",
  "post-failure-evidence",
  "test-coverage",
  "weak-test-coverage",
  "package-metadata",
  "parallel-surface",
  "verification-loop",
  "post-verification-shell",
  "post-verification-exploration",
  "completion",
]);

export function selectInlineNudgePlan(input: InlineNudgeSelectorInput): InlineNudgePlan | undefined {
  const judge = judgeInlineCompletionPolicy(input);
  if (!judge.nudgeKind) return undefined;
  return { kind: judge.nudgeKind, verificationCommand: input.verificationCommand, docsOnlyMutation: input.docsOnlyMutation, judge };
}

export function judgeInlineCompletionPolicy(input: InlineNudgeSelectorInput): PolicyJudgeDecision {
  for (const [kind, flag] of INLINE_NUDGE_PRIORITY) {
    if (input[flag]) return policyJudgeForKind(kind, input);
  }
  return {
    nextAction: "continue",
    reason: "No inline-work policy gap is currently signaled by runtime telemetry.",
    confidence: 0.65,
    blockingGap: false,
    source: "deterministic",
  };
}

export function inlineNudgeFlagForKind(kind: InlineNudgeKind): InlineNudgeFlag {
  const matched = INLINE_NUDGE_PRIORITY.find(([item]) => item === kind);
  if (!matched) return "shouldProgressNudge";
  return matched[1];
}

export function isSemanticJudgeRelevantNudge(kind: InlineNudgeKind): boolean {
  return semanticJudgeRelevantNudges.has(kind);
}

function policyJudgeForKind(kind: InlineNudgeKind, input: InlineNudgeSelectorInput): PolicyJudgeDecision {
  const command = input.verificationCommand ? ` Latest evidence command: ${input.verificationCommand}.` : "";
  const docs = input.docsOnlyMutation ? " Docs-only mutation is active." : "";
  const reasonByKind: Record<InlineNudgeKind, string> = {
    "workspace-boundary": "A mutation or verification left the current workspace boundary.",
    "docs-shell": "Docs-only work needs readback evidence rather than shell activity.",
    "terminal-completion": "A terminal external action completed the user's external workflow.",
    "post-terminal-drift": "Tool use continued after a terminal external action already completed the user's external workflow.",
    "post-verification-shell": "Shell use continued after post-mutation evidence without a new mutation.",
    "post-verification-exploration": "Exploration continued after post-mutation evidence without a new mutation.",
    "locator-loop": "Locator/search activity is looping before mutation.",
    "existing-file-rewrite": "An existing file was rewritten through a write path after it had been read.",
    "mutation-loop": "Several mutations happened without post-mutation evidence.",
    "source-and-test-ready": "Source and test changes are both present; meaningful repo evidence should happen next.",
    "verification-loop": "Evidence attempts are repeating without a stable repair result.",
    "post-failure-evidence": "Evidence debt is open: a post-mutation failure has not been cleared by evidence covering the same acceptance surface.",
    "progress": "First mutation observed; keep the loop bounded and move toward verification.",
    "ready-to-verify": "Mutation is present and post-mutation evidence is still missing.",
    "test-coverage": "Source changed without observed permanent test coverage review.",
    "weak-test-coverage": "Changed tests look too weak to prove the requested behavior.",
    "package-metadata": "Package metadata does not agree with delivered entrypoints or module shape.",
    "parallel-surface": "A parallel source/test surface bypassed the expected canonical path.",
    "failure": "A shell or evidence command failed after mutation.",
    "completion": "Latest mutation has post-mutation evidence and no currently blocking runtime gap.",
  };
  return {
    nextAction: nextActionForNudge(kind),
    reason: `${reasonByKind[kind]}${command}${docs}`.trim(),
    confidence: confidenceForNudge(kind),
    blockingGap: blockingGapForNudge(kind),
    nudgeKind: kind,
    source: "deterministic",
  };
}

function nextActionForNudge(kind: InlineNudgeKind): PolicyJudgeNextAction {
  if (kind === "completion" || kind === "terminal-completion") return "finalize";
  if (kind === "ready-to-verify" || kind === "source-and-test-ready") return "verify";
  if (kind === "failure" || kind === "post-failure-evidence" || kind === "verification-loop") return "repair";
  if (kind === "workspace-boundary" || kind === "parallel-surface") return "block";
  return "nudge";
}

function confidenceForNudge(kind: InlineNudgeKind): number {
  if (kind === "completion" || kind === "terminal-completion" || kind === "workspace-boundary" || kind === "failure") return 0.9;
  if (kind === "weak-test-coverage" || kind === "package-metadata" || kind === "parallel-surface") return 0.82;
  if (kind === "progress") return 0.58;
  return 0.72;
}

function blockingGapForNudge(kind: InlineNudgeKind): boolean {
  return kind !== "progress" && kind !== "completion" && kind !== "terminal-completion";
}
