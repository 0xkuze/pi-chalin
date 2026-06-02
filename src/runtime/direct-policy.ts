export type DirectToolEventPhase = "start" | "completed";
export type DirectNudgeKind =
  | "workspace-boundary"
  | "docs-shell"
  | "terminal-completion"
  | "post-terminal-drift"
  | "pre-mutation-verification"
  | "post-verification-shell"
  | "post-verification-exploration"
  | "docs-evidence-loop"
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

export interface DirectToolEvent {
  phase: DirectToolEventPhase;
  toolName: string;
  isError?: boolean;
  command?: string;
  path?: string;
  argsText?: string;
}

export interface DirectNudgePlan {
  kind: DirectNudgeKind;
  verificationCommand?: string;
  docsOnlyMutation: boolean;
  judge: PolicyJudgeDecision;
}

export type PolicyJudgeNextAction = "continue" | "nudge" | "verify" | "repair" | "finalize" | "block";

export interface SemanticPolicyJudgeRequest {
  key: string;
  turnId: number;
  trigger: DirectNudgeKind | "uncertain-continue";
  reasons: string[];
  snapshot: DirectPolicySnapshot;
}

export interface SemanticPolicyJudgeResult {
  nextAction: PolicyJudgeNextAction;
  reason: string;
  confidence: number;
  blockingGap: boolean;
  requiredEvidence: string[];
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
  nudgeKind?: DirectNudgeKind;
  source?: "deterministic" | "semantic";
  semanticReview?: SemanticPolicyJudgeRequest;
  semanticResult?: SemanticPolicyJudgeResult;
}

export interface DirectToolCompletionAdapter {
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
  shouldPreMutationVerificationNudge: boolean;
  shouldPostVerificationShellNudge: boolean;
  shouldPostVerificationExplorationNudge: boolean;
  shouldDocsEvidenceLoopNudge: boolean;
  shouldLocatorLoopNudge: boolean;
  shouldExistingFileRewriteNudge: boolean;
  shouldMutationLoopNudge: boolean;
  shouldSourceAndTestReadyNudge: boolean;
  shouldVerificationLoopNudge: boolean;
  shouldPostFailureEvidenceNudge: boolean;
  verificationCommand?: string;
  docsOnlyMutation: boolean;
  plan?: DirectNudgePlan;
  policyJudge?: PolicyJudgeDecision;
}

type DirectNudgeFlag = Exclude<keyof DirectToolCompletionAdapter, "verificationCommand" | "docsOnlyMutation" | "plan" | "policyJudge">;

export type DirectNudgeSelectorInput = Omit<DirectToolCompletionAdapter, "plan" | "policyJudge">;

export interface DirectPolicySnapshot {
  cwd?: string;
  docsOnlyPathPrompt: boolean;
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
  toolEvents: DirectToolEvent[];
  counters: {
    mutationToolCount: number;
    evidenceToolCount: number;
    searchToolCount: number;
    readToolCount: number;
    verificationAttemptCount: number;
    postFailureEvidenceToolCount: number;
  };
}

export const DIRECT_NUDGE_FLAGS = [
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
  "shouldPreMutationVerificationNudge",
  "shouldPostVerificationShellNudge",
  "shouldPostVerificationExplorationNudge",
  "shouldDocsEvidenceLoopNudge",
  "shouldLocatorLoopNudge",
  "shouldExistingFileRewriteNudge",
  "shouldMutationLoopNudge",
  "shouldSourceAndTestReadyNudge",
  "shouldVerificationLoopNudge",
  "shouldPostFailureEvidenceNudge",
] as const satisfies readonly DirectNudgeFlag[];

const DIRECT_NUDGE_PRIORITY = [
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
  ["pre-mutation-verification", "shouldPreMutationVerificationNudge"],
  ["post-verification-shell", "shouldPostVerificationShellNudge"],
  ["post-verification-exploration", "shouldPostVerificationExplorationNudge"],
  ["docs-evidence-loop", "shouldDocsEvidenceLoopNudge"],
  ["locator-loop", "shouldLocatorLoopNudge"],
  ["existing-file-rewrite", "shouldExistingFileRewriteNudge"],
  ["mutation-loop", "shouldMutationLoopNudge"],
  ["source-and-test-ready", "shouldSourceAndTestReadyNudge"],
  ["verification-loop", "shouldVerificationLoopNudge"],
  ["post-failure-evidence", "shouldPostFailureEvidenceNudge"],
  ["ready-to-verify", "shouldReadyToVerifyNudge"],
  ["progress", "shouldProgressNudge"],
] as const satisfies readonly (readonly [DirectNudgeKind, DirectNudgeFlag])[];

const semanticJudgeRelevantNudges = new Set<DirectNudgeKind>([
  "docs-evidence-loop",
  "locator-loop",
  "post-failure-evidence",
  "test-coverage",
  "weak-test-coverage",
  "package-metadata",
  "verification-loop",
]);

export function selectDirectNudgePlan(input: DirectNudgeSelectorInput): DirectNudgePlan | undefined {
  const judge = judgeDirectCompletionPolicy(input);
  if (!judge.nudgeKind) return undefined;
  return { kind: judge.nudgeKind, verificationCommand: input.verificationCommand, docsOnlyMutation: input.docsOnlyMutation, judge };
}

export function judgeDirectCompletionPolicy(input: DirectNudgeSelectorInput): PolicyJudgeDecision {
  for (const [kind, flag] of DIRECT_NUDGE_PRIORITY) {
    if (input[flag]) return policyJudgeForKind(kind, input);
  }
  return {
    nextAction: "continue",
    reason: "No direct-work policy gap is currently signaled by runtime telemetry.",
    confidence: 0.65,
    blockingGap: false,
    source: "deterministic",
  };
}

export function directNudgeFlagForKind(kind: DirectNudgeKind): DirectNudgeFlag {
  const matched = DIRECT_NUDGE_PRIORITY.find(([item]) => item === kind);
  if (!matched) return "shouldProgressNudge";
  return matched[1];
}

export function isSemanticJudgeRelevantNudge(kind: DirectNudgeKind): boolean {
  return semanticJudgeRelevantNudges.has(kind);
}

function policyJudgeForKind(kind: DirectNudgeKind, input: DirectNudgeSelectorInput): PolicyJudgeDecision {
  const command = input.verificationCommand ? ` Latest verification: ${input.verificationCommand}.` : "";
  const docs = input.docsOnlyMutation ? " Docs-only mutation is active." : "";
  const reasonByKind: Record<DirectNudgeKind, string> = {
    "workspace-boundary": "A mutation or verification left the current workspace boundary.",
    "docs-shell": "Docs-only work needs readback evidence rather than shell activity.",
    "terminal-completion": "A terminal direct action completed the user's external workflow.",
    "post-terminal-drift": "Tool use continued after a terminal direct action already completed the user's external workflow.",
    "pre-mutation-verification": "Verification ran before any mutation, so it cannot prove the requested change.",
    "post-verification-shell": "Shell use continued after passing verification without a new mutation.",
    "post-verification-exploration": "Exploration continued after passing verification without a new mutation.",
    "docs-evidence-loop": "Read-only docs evidence is looping without converging on the requested change.",
    "locator-loop": "Locator/search activity is looping before mutation.",
    "existing-file-rewrite": "An existing file was rewritten through a write path after it had been read.",
    "mutation-loop": "Several mutations happened without verification.",
    "source-and-test-ready": "Source and test changes are both present; verification should happen next.",
    "verification-loop": "Verification attempts are repeating without a stable repair result.",
    "post-failure-evidence": "Evidence gathering continued after failed verification without a repair.",
    "progress": "First mutation observed; keep the loop bounded and move toward verification.",
    "ready-to-verify": "Mutation is present and verification is still missing.",
    "test-coverage": "Source changed without observed permanent test coverage review.",
    "weak-test-coverage": "Changed tests look too weak to prove the requested behavior.",
    "package-metadata": "Package metadata does not agree with delivered entrypoints or module shape.",
    "parallel-surface": "A parallel source/test surface bypassed the expected canonical path.",
    "failure": "A verification or shell command failed after mutation.",
    "completion": "Latest mutation has passing verification and no currently blocking runtime gap.",
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

function nextActionForNudge(kind: DirectNudgeKind): PolicyJudgeNextAction {
  if (kind === "completion" || kind === "terminal-completion") return "finalize";
  if (kind === "ready-to-verify" || kind === "source-and-test-ready" || kind === "pre-mutation-verification") return "verify";
  if (kind === "failure" || kind === "post-failure-evidence" || kind === "verification-loop") return "repair";
  if (kind === "workspace-boundary" || kind === "parallel-surface") return "block";
  return "nudge";
}

function confidenceForNudge(kind: DirectNudgeKind): number {
  if (kind === "completion" || kind === "terminal-completion" || kind === "workspace-boundary" || kind === "failure") return 0.9;
  if (kind === "weak-test-coverage" || kind === "package-metadata" || kind === "parallel-surface") return 0.82;
  if (kind === "progress") return 0.58;
  return 0.72;
}

function blockingGapForNudge(kind: DirectNudgeKind): boolean {
  return kind !== "progress" && kind !== "completion" && kind !== "terminal-completion";
}
