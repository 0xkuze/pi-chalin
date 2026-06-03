import { Context, Effect, Layer, Ref } from "effect";
import type { RouteDecision, RunState } from "../domain/schemas.ts";
import {
  INLINE_NUDGE_FLAGS,
  inlineNudgeFlagForKind,
  isSemanticJudgeRelevantNudge,
  judgeInlineCompletionPolicy,
} from "./inline-policy.ts";
import type {
  InlineNudgeKind,
  InlineNudgePlan,
  InlineNudgeSelectorInput,
  InlinePolicySnapshot,
  InlineToolCompletionAdapter,
  InlineToolEvent,
  InlineToolEventPhase,
  PolicyJudgeDecision,
  SemanticPolicyJudgeRequest,
  SemanticPolicyJudgeResult,
} from "./inline-policy.ts";
export { judgeInlineCompletionPolicy, selectInlineNudgePlan } from "./inline-policy.ts";
export type {
  InlineNudgeKind,
  InlineNudgePlan,
  InlineNudgeSelectorInput,
  InlinePolicySnapshot,
  InlineToolCompletionAdapter,
  InlineToolEvent,
  InlineToolEventPhase,
  PolicyJudgeDecision,
  PolicyJudgeNextAction,
  SemanticPolicyJudgeRequest,
  SemanticPolicyJudgeResult,
  SemanticPolicyJudgeTrace,
} from "./inline-policy.ts";

export type ChalinRouteOutcome = "dry-run" | "ask" | "block" | "failed" | "paused" | "complete";

interface ChalinRouteInvocation {
  id: number;
  dryRun: boolean;
  route?: Pick<RouteDecision, "kind" | "agents" | "risk">;
  outcome?: ChalinRouteOutcome;
}

interface InlineWorkState {
  turnId: number;
  cwd?: string;
  toolEvents: InlineToolEvent[];
  mutationObserved: boolean;
  sourceMutationObserved: boolean;
  testMutationObserved: boolean;
  changedPaths: Set<string>;
  readPaths: Set<string>;
  promptCodePaths: Set<string>;
  deletedPaths: Set<string>;
  semanticJudgeRequestKeys: Set<string>;
  semanticJudgeResults: SemanticPolicyJudgeResult[];
  mutationToolCount: number;
  evidenceToolCount: number;
  searchToolCount: number;
  readToolCount: number;
  verificationAttemptCount: number;
  preMutationVerificationNudgeSent: boolean;
  terminalActionObserved: boolean;
  terminalActionCommand?: string;
  terminalCompletionNudgeSent: boolean;
  postTerminalDriftNudgeSent: boolean;
  testCoverageNudgeSent: boolean;
  testCoverageReviewObserved: boolean;
  verificationObserved: boolean;
  verificationCommand?: string;
  weakTestCoverageNudgeSent: boolean;
  packageMetadataNudgeSent: boolean;
  parallelSurfaceNudgeSent: boolean;
  outOfWorkspaceMutationObserved: boolean;
  outOfWorkspaceMutationNudgeSent: boolean;
  outOfWorkspaceMutationPath?: string;
  progressNudgeSent: boolean;
  readyToVerifyNudgeSent: boolean;
  failedVerificationNudgeSent: boolean;
  locatorLoopNudgeSent: boolean;
  docsShellNudgeSent: boolean;
  docsPostWriteShellNudgeSent: boolean;
  postVerificationShellNudgeSent: boolean;
  postVerificationExplorationNudgeSent: boolean;
  readbackStopNudgeSent: boolean;
  existingFileRewriteNudgeSent: boolean;
  mutationLoopNudgeSent: boolean;
  sourceAndTestReadyNudgeSent: boolean;
  verificationLoopNudgeSent: boolean;
  postFailureEvidenceToolCount: number;
  postFailureEvidenceNudgeSent: boolean;
  nudgeSent: boolean;
}

export interface LiveStepSessionRef {
  runId: string;
  stepId: string;
  agent: string;
  cwd: string;
  startedAt: string;
  getMessages(): readonly unknown[];
}

interface RuntimeStateServiceShape {
  readonly lastRun: Ref.Ref<RunState | undefined>;
  readonly liveStepSessions: Ref.Ref<Map<string, LiveStepSessionRef>>;
  readonly routeInvocations: Ref.Ref<ChalinRouteInvocation[]>;
  readonly inlineWork: Ref.Ref<InlineWorkState>;
  readonly skillOverrides: Ref.Ref<SkillOverrideState>;
}

interface SkillOverrideState {
  explicit: Set<string>;
  disabled: Set<string>;
}

class RuntimeStateService extends Context.Tag("pi-chalin/RuntimeState")<RuntimeStateService, RuntimeStateServiceShape>() {}

const RuntimeStateLayer = Layer.effect(RuntimeStateService, Effect.gen(function* () {
  return {
    lastRun: yield* Ref.make<RunState | undefined>(undefined),
    liveStepSessions: yield* Ref.make(new Map<string, LiveStepSessionRef>()),
    routeInvocations: yield* Ref.make<ChalinRouteInvocation[]>([]),
    inlineWork: yield* Ref.make(freshInlineWorkState()),
    skillOverrides: yield* Ref.make<SkillOverrideState>(freshSkillOverrideState()),
  };
}));

const runtimeState = Effect.runSync(Effect.gen(function* () {
  return yield* RuntimeStateService;
}).pipe(Effect.provide(RuntimeStateLayer)));

const lastRunRef = runtimeState.lastRun;
const liveStepSessions = refBackedMap(runtimeState.liveStepSessions);
const routeInvocations = refBackedArray(runtimeState.routeInvocations);
const inlineWork = refBackedObject(runtimeState.inlineWork);
const skillOverridesRef = runtimeState.skillOverrides;
let inlineWorkTurnSequence = inlineWork.turnId;

function getRef<T>(ref: Ref.Ref<T>): T {
  return Effect.runSync(Ref.get(ref));
}

function setRef<T>(ref: Ref.Ref<T>, value: T): void {
  Effect.runSync(Ref.set(ref, value));
}

function refBackedArray<T>(ref: Ref.Ref<T[]>): T[] {
  return new Proxy([] as T[], {
    get(_target, property) {
      const value = Reflect.get(getRef(ref), property);
      return typeof value === "function" ? value.bind(getRef(ref)) : value;
    },
    set(_target, property, value) {
      const current = getRef(ref);
      Reflect.set(current, property, value);
      return true;
    },
    ownKeys() {
      return Reflect.ownKeys(getRef(ref));
    },
    getOwnPropertyDescriptor(_target, property) {
      return Reflect.getOwnPropertyDescriptor(getRef(ref), property);
    },
  });
}

function resetRefBackedArray<T>(array: T[]): void {
  array.splice(0, array.length);
}

function refBackedMap<K, V>(ref: Ref.Ref<Map<K, V>>): Map<K, V> {
  return new Proxy(new Map<K, V>(), {
    get(_target, property) {
      const value = Reflect.get(getRef(ref), property);
      return typeof value === "function" ? value.bind(getRef(ref)) : value;
    },
  });
}

function refBackedObject<T extends object>(ref: Ref.Ref<T>): T {
  return new Proxy({} as T, {
    get(_target, property) {
      return Reflect.get(getRef(ref), property);
    },
    set(_target, property, value) {
      Reflect.set(getRef(ref), property, value);
      return true;
    },
  });
}

function replaceRefBackedObject<T extends object>(target: T, next: T): void {
  for (const key of Object.keys(target) as Array<keyof T>) {
    delete target[key];
  }
  Object.assign(target, next);
}

export function setLatestRun(run: RunState | undefined): void {
  setRef(lastRunRef, run);
}

export function getLatestRun(): RunState | undefined {
  return getRef(lastRunRef);
}

export function getActiveRun(): RunState | undefined {
  const lastRun = getLatestRun();
  return lastRun?.status === "running" ? lastRun : undefined;
}

export function setLiveStepSession(ref: LiveStepSessionRef): void {
  liveStepSessions.set(liveStepKey(ref.runId, ref.stepId), ref);
}

export function getLiveStepSession(runId: string, stepId: string): LiveStepSessionRef | undefined {
  return liveStepSessions.get(liveStepKey(runId, stepId));
}

export function clearLiveStepSession(runId: string, stepId: string, ref?: LiveStepSessionRef): void {
  const key = liveStepKey(runId, stepId);
  if (ref && liveStepSessions.get(key) !== ref) return;
  liveStepSessions.delete(key);
}

export function activateSkillForTurn(reference: string): SkillOverrideState {
  const current = getRef(skillOverridesRef);
  const next: SkillOverrideState = { explicit: new Set(current.explicit), disabled: new Set(current.disabled) };
  next.explicit.add(reference);
  next.disabled.delete(reference);
  setRef(skillOverridesRef, next);
  return cloneSkillOverrideState(next);
}

export function disableSkillForTurn(reference: string): SkillOverrideState {
  const current = getRef(skillOverridesRef);
  const next: SkillOverrideState = { explicit: new Set(current.explicit), disabled: new Set(current.disabled) };
  next.explicit.delete(reference);
  next.disabled.add(reference);
  setRef(skillOverridesRef, next);
  return cloneSkillOverrideState(next);
}

export function getSkillOverridesForTurn(): SkillOverrideState {
  return cloneSkillOverrideState(getRef(skillOverridesRef));
}

export function clearSkillOverridesForTurn(): void {
  setRef(skillOverridesRef, freshSkillOverrideState());
}

export function beginChalinTurn(options: { prompt?: string; cwd?: string } = {}): void {
  resetRefBackedArray(routeInvocations);
  replaceRefBackedObject(inlineWork, freshInlineWorkState(nextInlineWorkTurnId()));
  clearSkillOverridesForTurn();
  inlineWork.cwd = options.cwd;
  inlineWork.promptCodePaths = new Set(promptPathTokens(options.prompt ?? "").filter(isCodeLikePath).map(normalizeWorkflowPath));
}

export function recordInlineToolStart(options: Omit<InlineToolEvent, "phase">): void {
  appendInlineToolEvent({ ...options, phase: "start" });
}

export function hasInlineToolStarted(toolName: string): boolean {
  return inlineWork.toolEvents.some((event) => event.phase === "start" && event.toolName === toolName);
}

export function getInlineToolEventsForTests(): InlineToolEvent[] {
  return inlineWork.toolEvents.map((event) => ({ ...event }));
}

export function getInlinePolicySnapshot(): InlinePolicySnapshot {
  return inlinePolicySnapshot();
}

export function recordSemanticPolicyJudgeResult(result: SemanticPolicyJudgeResult): void {
  inlineWork.semanticJudgeResults.push(result);
  if (inlineWork.semanticJudgeResults.length > 20) {
    inlineWork.semanticJudgeResults.splice(0, inlineWork.semanticJudgeResults.length - 20);
  }
}

export function getSemanticPolicyJudgeResultsForTests(): SemanticPolicyJudgeResult[] {
  return inlineWork.semanticJudgeResults.map(cloneSemanticPolicyJudgeResult);
}

export function isSemanticPolicyJudgeRequestFresh(request: SemanticPolicyJudgeRequest): boolean {
  if (request.turnId !== inlineWork.turnId) return false;
  if (!inlineWork.semanticJudgeRequestKeys.has(request.key)) return false;
  return request.key === semanticPolicyJudgeRequestKey(request.trigger, {
    verificationCommand: inlineWork.verificationCommand,
    docsOnlyMutation: inlineDocsOnlyMutation(),
  });
}

export function getInlineDerivedGapDiagnosticsForTests(): { weakTestCoverage: boolean; packageMetadata: boolean; parallelSurface?: { expected: string; actual: string[] } } {
  return {
    weakTestCoverage: inlineWeakTestCoverageGap(),
    packageMetadata: inlinePackageMetadataGap(),
    parallelSurface: inlineParallelSurfaceGap(),
  };
}

export function recordInlineToolCompletion(options: { toolName: string; isError?: boolean; command?: string; path?: string; argsText?: string }): InlineToolCompletionAdapter {
  appendInlineToolEvent({ ...options, phase: "completed" });
  let shouldProgressNudge = false;
  let shouldWorkspaceBoundaryNudge = false;
  let shouldDocsShellNudge = false;
  let shouldPreMutationVerificationNudge = false;
  let shouldPostVerificationShellNudge = false;
  let shouldPostVerificationExplorationNudge = false;
  let shouldLocatorLoopNudge = false;
  let shouldExistingFileRewriteNudge = false;
  let shouldMutationLoopNudge = false;
  let shouldSourceAndTestReadyNudge = false;
  let shouldVerificationLoopNudge = false;
  let shouldPostFailureEvidenceNudge = false;
  let justMutated = false;
  let staleVerificationReset = false;
  if (options.toolName === "bash" && options.command) {
    recordDeletedPathsFromCommand(options.command);
  }
  let shouldTerminalCompletionNudge = false;
  let shouldPostTerminalDriftNudge = false;
  if (
    inlineWork.terminalActionObserved
    && !options.isError
    && isPostTerminalDriftTool(options.toolName)
    && !isAllowedTerminalFollowupCommand(options.command)
    && !inlineWork.postTerminalDriftNudgeSent
  ) {
    shouldPostTerminalDriftNudge = true;
    inlineWork.postTerminalDriftNudgeSent = true;
  }
  const coverageReviewWasRequested = inlineWork.testCoverageNudgeSent;
  if (!inlineWork.mutationObserved && !options.isError) {
    recordPreMutationEvidenceTool(options.toolName);
    if (shouldNudgeLocatorLoop()) {
      shouldLocatorLoopNudge = true;
      inlineWork.locatorLoopNudgeSent = true;
    }
  }
  if (options.toolName === "read" && options.path && !options.isError) {
    inlineWork.readPaths.add(normalizeWorkflowPath(options.path));
  }
  if (options.toolName === "edit" || options.toolName === "write") {
    if (options.isError) return inlineWorkAdapter({ shouldProgressNudge: false, shouldReadyToVerifyNudge: false, shouldFailureNudge: false, shouldCompletionNudge: false, shouldTestCoverageNudge: false, shouldWeakTestCoverageNudge: false, shouldPackageMetadataNudge: false, shouldParallelSurfaceNudge: false, shouldWorkspaceBoundaryNudge, shouldDocsShellNudge, shouldTerminalCompletionNudge, shouldPostTerminalDriftNudge, shouldPreMutationVerificationNudge, shouldPostVerificationShellNudge, shouldPostVerificationExplorationNudge, shouldLocatorLoopNudge, shouldExistingFileRewriteNudge, shouldMutationLoopNudge, shouldSourceAndTestReadyNudge, shouldVerificationLoopNudge, shouldPostFailureEvidenceNudge, docsOnlyMutation: inlineDocsOnlyMutation() });
    justMutated = true;
    const recoveringFromVerificationFailure = inlineWork.failedVerificationNudgeSent && !inlineWork.verificationObserved;
    inlineWork.mutationObserved = true;
    inlineWork.mutationToolCount += 1;
    if (!recoveringFromVerificationFailure && !inlineWork.mutationLoopNudgeSent && inlineWork.mutationToolCount >= 3 && !inlineWork.verificationObserved) {
      shouldMutationLoopNudge = true;
      inlineWork.mutationLoopNudgeSent = true;
    }
    const changedPath = options.path ?? extractPathFromArgsText(options.argsText);
    if (changedPath) {
      inlineWork.changedPaths.add(changedPath);
      if (markOutOfWorkspaceMutation(changedPath) && !inlineWork.outOfWorkspaceMutationNudgeSent) {
        shouldWorkspaceBoundaryNudge = true;
        inlineWork.outOfWorkspaceMutationNudgeSent = true;
      }
      if (
        options.toolName === "write"
        && !isDocsMarkdownPath(changedPath)
        && inlineWork.readPaths.has(normalizeWorkflowPath(changedPath))
        && !inlineWork.existingFileRewriteNudgeSent
        && !isSmallFullFileWrite(options.argsText)
      ) {
        shouldExistingFileRewriteNudge = true;
        inlineWork.existingFileRewriteNudgeSent = true;
      }
      if (isTestLikePath(changedPath)) {
        inlineWork.testMutationObserved = true;
        if (!inlineWeakTestCoverageGap()) inlineWork.weakTestCoverageNudgeSent = false;
      } else if (!isDocsMarkdownPath(changedPath)) {
        inlineWork.sourceMutationObserved = true;
      }
      if (isPackageJsonPath(changedPath)) {
        if (!inlinePackageMetadataGap()) inlineWork.packageMetadataNudgeSent = false;
      }
      if (coverageReviewWasRequested && !isDocsMarkdownPath(changedPath)) {
        inlineWork.testCoverageReviewObserved = true;
      }
    } else {
      inlineWork.sourceMutationObserved = true;
      if (coverageReviewWasRequested) inlineWork.testCoverageReviewObserved = true;
    }
    if (inlineWork.verificationObserved || inlineWork.verificationCommand || inlineWork.failedVerificationNudgeSent || inlineWork.nudgeSent) {
      staleVerificationReset = true;
      inlineWork.verificationObserved = false;
      inlineWork.verificationCommand = undefined;
      inlineWork.readyToVerifyNudgeSent = false;
      inlineWork.failedVerificationNudgeSent = false;
      inlineWork.postVerificationShellNudgeSent = false;
      inlineWork.postVerificationExplorationNudgeSent = false;
      inlineWork.readbackStopNudgeSent = false;
      inlineWork.verificationLoopNudgeSent = false;
      inlineWork.sourceAndTestReadyNudgeSent = false;
      inlineWork.postFailureEvidenceToolCount = 0;
      inlineWork.postFailureEvidenceNudgeSent = false;
      inlineWork.verificationAttemptCount = 0;
      inlineWork.weakTestCoverageNudgeSent = false;
      inlineWork.packageMetadataNudgeSent = false;
      inlineWork.parallelSurfaceNudgeSent = false;
      inlineWork.nudgeSent = false;
    }
    if (
      !inlineWork.sourceAndTestReadyNudgeSent
      && !inlineWork.verificationObserved
      && inlineWork.sourceMutationObserved
      && inlineWork.testMutationObserved
      && inlineWork.mutationToolCount >= 2
    ) {
      shouldSourceAndTestReadyNudge = true;
      inlineWork.sourceAndTestReadyNudgeSent = true;
    }
    shouldProgressNudge = !inlineWork.progressNudgeSent;
    if (shouldProgressNudge) inlineWork.progressNudgeSent = true;
  }
  let shouldFailureNudge = false;
  const docsOnlyMutation = inlineDocsOnlyMutation();
  const verificationLeftWorkspace = options.toolName === "bash"
    && inlineWork.mutationObserved
    && bashCommandLeavesWorkspace(options.command);
  if (verificationLeftWorkspace && !inlineWork.outOfWorkspaceMutationNudgeSent) {
    shouldWorkspaceBoundaryNudge = true;
    inlineWork.outOfWorkspaceMutationNudgeSent = true;
  }
  if (
    options.toolName === "bash"
    && !inlineWork.mutationObserved
    && inlineWork.promptCodePaths.size > 0
    && isVerificationCommand(options.command)
    && !inlineWork.preMutationVerificationNudgeSent
  ) {
    shouldPreMutationVerificationNudge = true;
    inlineWork.preMutationVerificationNudgeSent = true;
  }
  if (options.toolName === "read" && options.path && inlineWork.testCoverageNudgeSent && isCoverageReviewPath(options.path) && !options.isError) {
    inlineWork.testCoverageReviewObserved = true;
  }
  if (options.toolName === "bash" && docsOnlyMutation) {
      shouldDocsShellNudge = !inlineWork.docsPostWriteShellNudgeSent;
      inlineWork.docsPostWriteShellNudgeSent = true;
  }
  if (
    options.toolName === "bash"
    && inlineWork.mutationObserved
    && inlineWork.verificationObserved
    && !inlineDocsOnlyMutation()
    && !inlineWork.postVerificationShellNudgeSent
  ) {
    shouldPostVerificationShellNudge = true;
    inlineWork.postVerificationShellNudgeSent = true;
  }
  if (options.toolName === "read" && docsOnlyMutation && options.path && [...inlineWork.changedPaths].some((changedPath) => sameWorkflowPath(changedPath, options.path ?? "")) && !options.isError) {
    inlineWork.verificationObserved = true;
    inlineWork.verificationCommand = `read ${options.path}`;
  } else if (options.toolName === "bash" && docsOnlyMutation) {
    inlineWork.verificationObserved = false;
    inlineWork.verificationCommand = undefined;
  } else if (options.toolName === "bash" && inlineWork.mutationObserved && isVerificationCommand(options.command)) {
    inlineWork.verificationCommand = options.command?.trim();
    inlineWork.verificationAttemptCount += 1;
    if (verificationLeftWorkspace) {
      inlineWork.verificationObserved = false;
    } else if (options.isError) {
      shouldFailureNudge = !inlineWork.failedVerificationNudgeSent;
      if (shouldFailureNudge) inlineWork.failedVerificationNudgeSent = true;
      if (!inlineWork.verificationLoopNudgeSent && inlineWork.verificationAttemptCount >= 2) {
        shouldVerificationLoopNudge = true;
        inlineWork.verificationLoopNudgeSent = true;
      }
    } else {
      inlineWork.verificationObserved = true;
      if (inlineWork.outOfWorkspaceMutationObserved && hasInWorkspaceMutation()) {
        inlineWork.outOfWorkspaceMutationObserved = false;
        inlineWork.outOfWorkspaceMutationPath = undefined;
      }
      if (!inlineWork.verificationLoopNudgeSent && inlineWork.verificationAttemptCount >= 3) {
        shouldVerificationLoopNudge = true;
        inlineWork.verificationLoopNudgeSent = true;
      }
    }
  } else if (options.toolName === "bash" && inlineWork.mutationObserved && options.isError) {
    shouldFailureNudge = !inlineWork.failedVerificationNudgeSent;
    if (shouldFailureNudge) inlineWork.failedVerificationNudgeSent = true;
  } else if (options.isError) {
    return inlineWorkAdapter({ shouldProgressNudge, shouldReadyToVerifyNudge: false, shouldFailureNudge: false, shouldCompletionNudge: false, shouldTestCoverageNudge: false, shouldWeakTestCoverageNudge: false, shouldPackageMetadataNudge: false, shouldParallelSurfaceNudge: false, shouldWorkspaceBoundaryNudge, shouldDocsShellNudge, shouldTerminalCompletionNudge, shouldPostTerminalDriftNudge, shouldPreMutationVerificationNudge, shouldPostVerificationShellNudge, shouldPostVerificationExplorationNudge, shouldLocatorLoopNudge, shouldExistingFileRewriteNudge, shouldMutationLoopNudge, shouldSourceAndTestReadyNudge, shouldVerificationLoopNudge, shouldPostFailureEvidenceNudge, verificationCommand: inlineWork.verificationCommand, docsOnlyMutation });
  }
  if (options.toolName === "bash" && !options.isError && isTerminalExternalActionCommand(options.command)) {
    inlineWork.terminalActionObserved = true;
    inlineWork.terminalActionCommand = options.command?.trim();
    if (!inlineWork.terminalCompletionNudgeSent) {
      shouldTerminalCompletionNudge = true;
      inlineWork.terminalCompletionNudgeSent = true;
    }
  }
  if (
    inlineWork.failedVerificationNudgeSent
    && !inlineWork.verificationObserved
    && !justMutated
    && isPostFailureEvidenceTool(options.toolName, options.command)
    && !options.isError
  ) {
    inlineWork.postFailureEvidenceToolCount += 1;
    if (!inlineWork.postFailureEvidenceNudgeSent && inlineWork.postFailureEvidenceToolCount >= 2) {
      shouldPostFailureEvidenceNudge = true;
      inlineWork.postFailureEvidenceNudgeSent = true;
    }
  }
  const shouldReadyToVerifyNudge = inlineWork.mutationObserved
    && !inlineWork.verificationObserved
    && !inlineWork.readyToVerifyNudgeSent
    && options.toolName !== "bash"
    && !shouldSourceAndTestReadyNudge
    && (docsOnlyMutation || staleVerificationReset || (!justMutated && !shouldFailureNudge && !options.isError));
  if (shouldReadyToVerifyNudge) inlineWork.readyToVerifyNudgeSent = true;
  const needsWeakTestCoverageReview = inlineWork.verificationObserved
    && inlineWork.sourceMutationObserved
    && inlineWork.testMutationObserved
    && inlineWeakTestCoverageGap();
  const shouldWeakTestCoverageNudge = inlineWork.sourceMutationObserved
    && inlineWork.testMutationObserved
    && inlineWeakTestCoverageGap()
    && !inlineWork.weakTestCoverageNudgeSent
    && (justMutated || inlineWork.verificationObserved);
  if (shouldWeakTestCoverageNudge) inlineWork.weakTestCoverageNudgeSent = true;
  const needsPackageMetadataReview = inlineWork.verificationObserved
    && inlinePackageMetadataGap();
  const shouldPackageMetadataNudge = inlinePackageMetadataGap()
    && !inlineWork.packageMetadataNudgeSent
    && (justMutated || inlineWork.verificationObserved);
  if (shouldPackageMetadataNudge) inlineWork.packageMetadataNudgeSent = true;
  const parallelSurfaceGap = inlineParallelSurfaceGap();
  const shouldParallelSurfaceNudge = Boolean(parallelSurfaceGap) && !inlineWork.parallelSurfaceNudgeSent;
  if (shouldParallelSurfaceNudge) inlineWork.parallelSurfaceNudgeSent = true;
  const needsMissingTestCoverageReview = inlineWork.verificationObserved
    && sourceMutationWithoutTestMutation();
  const needsTestCoverageReview = needsMissingTestCoverageReview || needsWeakTestCoverageReview || needsPackageMetadataReview || Boolean(parallelSurfaceGap);
  const shouldTestCoverageNudge = needsMissingTestCoverageReview && !inlineWork.testCoverageNudgeSent;
  if (shouldTestCoverageNudge) inlineWork.testCoverageNudgeSent = true;
  const changedPathReadbackObserved = options.toolName === "read"
    && Boolean(options.path)
    && !options.isError
    && [...inlineWork.changedPaths].some((changedPath) => sameWorkflowPath(changedPath, options.path ?? ""));
  if (
    inlineWork.mutationObserved
    && inlineWork.verificationObserved
    && !needsTestCoverageReview
    && !changedPathReadbackObserved
    && !inlineDocsOnlyMutation()
    && isPostVerificationExplorationTool(options.toolName)
    && !inlineWork.postVerificationExplorationNudgeSent
  ) {
    shouldPostVerificationExplorationNudge = true;
    inlineWork.postVerificationExplorationNudgeSent = true;
  }
  let shouldCompletionNudge = inlineWork.mutationObserved
    && inlineWork.verificationObserved
    && !needsTestCoverageReview
    && !inlineWork.outOfWorkspaceMutationObserved
    && !inlineWork.nudgeSent;
  if (
    !shouldCompletionNudge
    && changedPathReadbackObserved
    && inlineWork.mutationObserved
    && inlineWork.verificationObserved
    && !needsTestCoverageReview
    && !inlineWork.outOfWorkspaceMutationObserved
    && !inlineDocsOnlyMutation()
    && !inlineWork.readbackStopNudgeSent
  ) {
    shouldCompletionNudge = true;
    inlineWork.readbackStopNudgeSent = true;
  }
  if (shouldCompletionNudge) inlineWork.nudgeSent = true;
  return inlineWorkAdapter({ shouldProgressNudge, shouldReadyToVerifyNudge, shouldFailureNudge, shouldCompletionNudge, shouldTestCoverageNudge, shouldWeakTestCoverageNudge, shouldPackageMetadataNudge, shouldParallelSurfaceNudge, shouldWorkspaceBoundaryNudge, shouldDocsShellNudge, shouldTerminalCompletionNudge, shouldPostTerminalDriftNudge, shouldPreMutationVerificationNudge, shouldPostVerificationShellNudge, shouldPostVerificationExplorationNudge, shouldLocatorLoopNudge, shouldExistingFileRewriteNudge, shouldMutationLoopNudge, shouldSourceAndTestReadyNudge, shouldVerificationLoopNudge, shouldPostFailureEvidenceNudge, verificationCommand: inlineWork.verificationCommand, docsOnlyMutation });
}

function inlineWorkAdapter(raw: InlineNudgeSelectorInput): InlineToolCompletionAdapter {
  const policyJudge = withAutomaticSemanticPolicyReview(judgeInlineCompletionPolicy(raw), raw);
  const plan = policyJudge.nudgeKind
    ? { kind: policyJudge.nudgeKind, verificationCommand: raw.verificationCommand, docsOnlyMutation: raw.docsOnlyMutation, judge: policyJudge }
    : undefined;
  const adapter: InlineToolCompletionAdapter = { ...raw, plan, policyJudge };
  for (const flag of INLINE_NUDGE_FLAGS) {
    adapter[flag] = false;
  }
  if (plan) adapter[inlineNudgeFlagForKind(plan.kind)] = true;
  return adapter;
}

function withAutomaticSemanticPolicyReview(judge: PolicyJudgeDecision, input: InlineNudgeSelectorInput): PolicyJudgeDecision {
  const request = semanticPolicyJudgeRequest(judge, input);
  return request ? { ...judge, semanticReview: request } : judge;
}

function semanticPolicyJudgeRequest(judge: PolicyJudgeDecision, input: InlineNudgeSelectorInput): SemanticPolicyJudgeRequest | undefined {
  const reasons = semanticPolicyJudgeReasons(judge, input);
  if (reasons.length === 0) return undefined;
  const trigger = judge.nudgeKind ?? "uncertain-continue";
  const key = semanticPolicyJudgeRequestKey(trigger, {
    verificationCommand: input.verificationCommand,
    docsOnlyMutation: input.docsOnlyMutation,
  });
  if (inlineWork.semanticJudgeRequestKeys.has(key)) return undefined;
  inlineWork.semanticJudgeRequestKeys.add(key);
  return {
    key,
    turnId: inlineWork.turnId,
    trigger,
    reasons,
    snapshot: inlinePolicySnapshot(),
  };
}

function semanticPolicyJudgeRequestKey(trigger: SemanticPolicyJudgeRequest["trigger"], options: { verificationCommand?: string; docsOnlyMutation: boolean }): string {
  return [
    inlineWork.turnId,
    trigger,
    options.verificationCommand ?? "",
    options.docsOnlyMutation ? "docs" : "code",
    [...inlineWork.changedPaths].sort().join(","),
    inlineWork.toolEvents.length,
  ].join("|");
}

function semanticPolicyJudgeReasons(judge: PolicyJudgeDecision, input: InlineNudgeSelectorInput): string[] {
  const reasons: string[] = [];
  if (judge.nudgeKind && isSemanticJudgeRelevantNudge(judge.nudgeKind)) {
    reasons.push(`runtime signal '${judge.nudgeKind}' depends on semantic quality or evidence sufficiency, not only a mechanical invariant`);
  }
  if (input.shouldDocsShellNudge) reasons.push("decide whether docs-only work really needs no shell command now, or whether the command provided necessary evidence");
  if (input.shouldLocatorLoopNudge) reasons.push("decide whether search/read activity is genuinely stuck before mutation or still gathering necessary target evidence");
  if (input.shouldSourceAndTestReadyNudge) reasons.push("decide whether source and tests are ready for verification or whether a required artifact/source/test is still missing");
  if (input.shouldReadyToVerifyNudge) reasons.push("decide whether the next safe action is verification, a focused repair, a clarification, or no steer");
  if (input.shouldWeakTestCoverageNudge) reasons.push("judge whether changed tests substantively cover the user-requested behavior and at least one meaningful boundary/preservation path");
  if (input.shouldPackageMetadataNudge) reasons.push("judge whether package metadata is actually incoherent with delivered entrypoints/module shape or the signal is a false positive");
  if (input.shouldParallelSurfaceNudge) reasons.push("judge whether the changed files bypassed the prompt/starter surface or whether the alternate surface is legitimate for this repo");
  if (input.shouldVerificationLoopNudge) reasons.push("decide whether repeated verification needs a repair before another command");
  if (input.shouldPostFailureEvidenceNudge) reasons.push("decide whether post-failure evidence gathering should stop and convert into a focused repair");
  if (input.shouldPostVerificationShellNudge || input.shouldPostVerificationExplorationNudge) reasons.push("decide whether verification already proved the latest mutation and finalization is safer than more tool use");
  if (input.shouldCompletionNudge && inlineWork.sourceMutationObserved && !inlineWork.testMutationObserved) {
    reasons.push("completion was reached after source mutation without observed permanent test mutation; decide if existing/inline tests are still sufficient");
  } else if (input.shouldCompletionNudge) {
    reasons.push("completion was reached; audit whether finalization is supported by the latest mutation and verification evidence");
  }
  return reasons;
}

export function getInlineChangedPaths(): string[] {
  return [...inlineWork.changedPaths].sort((left, right) => normalizeWorkflowPath(left).localeCompare(normalizeWorkflowPath(right)));
}

export function getInlineCriticalGuardContextMessage(): string | undefined {
  if (inlineWork.terminalActionObserved) {
    const command = inlineWork.terminalActionCommand ? ` with \`${inlineWork.terminalActionCommand}\`` : "";
    const drift = inlineWork.postTerminalDriftNudgeSent
      ? " Later tool use already tried to mutate or inspect support artifacts after that terminal action."
      : "";
    return [
      "pi-chalin critical inline-work guard.",
      `Hard stop: the user's external workflow already completed${command}.${drift}`,
      "Your next assistant action must be the final answer in the user's language with the resulting PR/action, verification already performed, and compact notes.",
      "Do not call more tools, rewrite PR body files, rerun support commands, or keep polishing local artifacts after the external action succeeded.",
    ].join("\n");
  }
  if (!inlineWork.verificationObserved && !inlineWork.outOfWorkspaceMutationObserved) return undefined;
  const reasons: string[] = [];
  const parallelSurfaceGap = promptCanonicalSurfaceBypassed() ?? pythonRootDuplicateTestSurface();
  if (inlineWork.outOfWorkspaceMutationObserved) {
    const path = inlineWork.outOfWorkspaceMutationPath ? ` (${inlineWork.outOfWorkspaceMutationPath})` : "";
    reasons.push(`a mutation or verification targeted a path outside the current workspace root${path}`);
  }
  if (
    inlineWork.sourceMutationObserved
    && inlineWork.testMutationObserved
    && inlineWeakTestCoverageGap()
  ) {
    reasons.push("the changed tests still look like trivial smoke/empty coverage instead of assertions for the requested behavior");
  }
  if (inlinePackageMetadataGap()) {
    reasons.push("the scaffold package metadata still does not agree with delivered bin/main/export/module entrypoints");
  }
  if (parallelSurfaceGap) {
    reasons.push(`the canonical surface \`${parallelSurfaceGap.expected}\` was bypassed by parallel file(s) ${parallelSurfaceGap.actual.map((path) => `\`${path}\``).join(", ")}`);
  }
  if (
    reasons.length === 0
    && inlineWork.verificationObserved
    && (inlineWork.postVerificationShellNudgeSent || inlineWork.postVerificationExplorationNudgeSent)
  ) {
    const command = inlineWork.verificationCommand ? ` with \`${inlineWork.verificationCommand}\`` : "";
    return [
      "pi-chalin critical inline-work guard.",
      `Hard stop: verification already passed${command} after the latest mutation, and later tool use did not include a new edit.`,
      "Your next assistant action must be the final answer in the user's language with changed files, verification, and compact notes.",
      "Do not call more tools, rerun tests, or read files just to summarize. If a later tool exposed a concrete defect, patch only that root cause and rerun the nearest verification once before final.",
    ].join("\n");
  }
  if (reasons.length === 0) return undefined;
  return [
    "pi-chalin critical inline-work guard.",
    `Hard stop: a final answer is invalid because ${reasons.join(" and ")}.`,
    inlineWork.outOfWorkspaceMutationObserved
      ? "Your next assistant action must recreate or move the required artifacts under the current workspace root using relative paths, then rerun the nearest verification from that root."
      : parallelSurfaceGap
      ? "Your next assistant action must consolidate the implementation and tests into the prompt/starter source and runner-discovered test paths, remove the parallel sibling files, then rerun the nearest verification once."
      : "Your next assistant action must be a tool call that patches the smallest missing source/test/package evidence, then reruns the nearest verification once.",
    "Do not claim completion, summarize, or explain intent until that corrective verification passes after the patch.",
  ].join("\n");
}

export function beginChalinRouteInvocation(options: { dryRun: boolean; route: RouteDecision }): { allowed: boolean; reason?: string; invocationId?: number } {
  const committed = routeInvocations.find((call) => call.outcome === "complete" || call.outcome === "paused");
  if (!options.dryRun && committed) {
    return {
      allowed: false,
      reason: "chalin_route already executed for this user prompt. Synthesize the existing result instead of launching another chalin workflow. A second call is allowed only after dryRun, ask, block, or failed outcomes.",
    };
  }

  const invocation: ChalinRouteInvocation = {
    id: routeInvocations.length + 1,
    dryRun: options.dryRun,
    route: { kind: options.route.kind, agents: options.route.agents, risk: options.route.risk },
  };
  routeInvocations.push(invocation);
  return { allowed: true, invocationId: invocation.id };
}

export function finishChalinRouteInvocation(invocationId: number | undefined, outcome: ChalinRouteOutcome): void {
  if (invocationId === undefined) return;
  const invocation = routeInvocations.find((call) => call.id === invocationId);
  if (invocation) invocation.outcome = outcome;
}

export function getChalinRouteInvocations(): readonly ChalinRouteInvocation[] {
  return routeInvocations;
}

export function resetRuntimeState(): void {
  setLatestRun(undefined);
  liveStepSessions.clear();
  resetRefBackedArray(routeInvocations);
  replaceRefBackedObject(inlineWork, freshInlineWorkState(nextInlineWorkTurnId()));
  clearSkillOverridesForTurn();
}

function liveStepKey(runId: string, stepId: string): string {
  return `${runId}:${stepId}`;
}

function nextInlineWorkTurnId(): number {
  inlineWorkTurnSequence += 1;
  return inlineWorkTurnSequence;
}

function freshInlineWorkState(turnId = 0): InlineWorkState {
  return {
    turnId,
    cwd: undefined,
    toolEvents: [],
    mutationObserved: false,
    sourceMutationObserved: false,
    testMutationObserved: false,
    changedPaths: new Set(),
    readPaths: new Set(),
    promptCodePaths: new Set(),
    deletedPaths: new Set(),
    semanticJudgeRequestKeys: new Set(),
    semanticJudgeResults: [],
    mutationToolCount: 0,
    evidenceToolCount: 0,
    searchToolCount: 0,
    readToolCount: 0,
    verificationAttemptCount: 0,
    preMutationVerificationNudgeSent: false,
    terminalActionObserved: false,
    terminalActionCommand: undefined,
    terminalCompletionNudgeSent: false,
    postTerminalDriftNudgeSent: false,
    testCoverageNudgeSent: false,
    testCoverageReviewObserved: false,
    verificationObserved: false,
    verificationCommand: undefined,
    weakTestCoverageNudgeSent: false,
    packageMetadataNudgeSent: false,
    parallelSurfaceNudgeSent: false,
    outOfWorkspaceMutationObserved: false,
    outOfWorkspaceMutationNudgeSent: false,
    outOfWorkspaceMutationPath: undefined,
    progressNudgeSent: false,
    readyToVerifyNudgeSent: false,
    failedVerificationNudgeSent: false,
    locatorLoopNudgeSent: false,
    docsShellNudgeSent: false,
    docsPostWriteShellNudgeSent: false,
    postVerificationShellNudgeSent: false,
    postVerificationExplorationNudgeSent: false,
    readbackStopNudgeSent: false,
    existingFileRewriteNudgeSent: false,
    mutationLoopNudgeSent: false,
    sourceAndTestReadyNudgeSent: false,
    verificationLoopNudgeSent: false,
    postFailureEvidenceToolCount: 0,
    postFailureEvidenceNudgeSent: false,
    nudgeSent: false,
  };
}

function cloneSemanticPolicyJudgeResult(result: SemanticPolicyJudgeResult): SemanticPolicyJudgeResult {
  return {
    ...result,
    requiredEvidence: [...result.requiredEvidence],
    trace: result.trace
      ? {
        ...result.trace,
        usage: {
          ...result.trace.usage,
          cost: { ...result.trace.usage.cost },
        },
      }
      : undefined,
  };
}

function inlinePolicySnapshot(): InlinePolicySnapshot {
  return {
    cwd: inlineWork.cwd,
    mutationObserved: inlineWork.mutationObserved,
    sourceMutationObserved: inlineWork.sourceMutationObserved,
    testMutationObserved: inlineWork.testMutationObserved,
    verificationObserved: inlineWork.verificationObserved,
    verificationCommand: inlineWork.verificationCommand,
    terminalActionCommand: inlineWork.terminalActionCommand,
    docsOnlyMutation: inlineDocsOnlyMutation(),
    changedPaths: [...inlineWork.changedPaths].sort(),
    readPaths: [...inlineWork.readPaths].sort(),
    promptCodePaths: [...inlineWork.promptCodePaths].sort(),
    toolEvents: inlineWork.toolEvents.slice(-16).map((event) => ({ ...event })),
    counters: {
      mutationToolCount: inlineWork.mutationToolCount,
      evidenceToolCount: inlineWork.evidenceToolCount,
      searchToolCount: inlineWork.searchToolCount,
      readToolCount: inlineWork.readToolCount,
      verificationAttemptCount: inlineWork.verificationAttemptCount,
      postFailureEvidenceToolCount: inlineWork.postFailureEvidenceToolCount,
    },
  };
}

function appendInlineToolEvent(event: InlineToolEvent): void {
  inlineWork.toolEvents.push(event);
  if (inlineWork.toolEvents.length > 200) {
    inlineWork.toolEvents.splice(0, inlineWork.toolEvents.length - 200);
  }
}

function inlineWeakTestCoverageGap(): boolean {
  const latestByPath = latestChangedFileContents((path) => isTestLikePath(path));
  return [...latestByPath.values()].some((content) => looksLikeWeakTestCoverage(content));
}

function inlinePackageMetadataGap(): boolean {
  const latestPackage = [...latestChangedFileContents((path) => isPackageJsonPath(path)).values()].at(-1);
  return latestPackage !== undefined && packageJsonLikelyNeedsModuleType(latestPackage);
}

function inlineParallelSurfaceGap(): { expected: string; actual: string[] } | undefined {
  if (!inlineWork.verificationObserved) return undefined;
  return promptCanonicalSurfaceBypassed() ?? pythonRootDuplicateTestSurface();
}

function latestChangedFileContents(predicate: (path: string) => boolean): Map<string, string> {
  const latest = new Map<string, string>();
  for (const event of inlineWork.toolEvents) {
    if (event.phase !== "completed" || event.isError || (event.toolName !== "edit" && event.toolName !== "write")) continue;
    const path = normalizeWorkflowPath(event.path ?? extractPathFromArgsText(event.argsText) ?? "");
    if (!path || !predicate(path)) continue;
    const content = extractContentFromArgsText(event.argsText);
    if (content !== undefined) latest.set(path, content);
  }
  return latest;
}

function freshSkillOverrideState(): SkillOverrideState {
  return { explicit: new Set(), disabled: new Set() };
}

function cloneSkillOverrideState(state: SkillOverrideState): SkillOverrideState {
  return { explicit: new Set(state.explicit), disabled: new Set(state.disabled) };
}

function isPostVerificationExplorationTool(toolName: string): boolean {
  return ["read", "grep", "find", "ls", "chalin_project_discovery"].includes(toolName);
}

function isPostTerminalDriftTool(toolName: string): boolean {
  return ["bash", "read", "grep", "find", "ls", "edit", "write", "chalin_project_discovery"].includes(toolName);
}

function isAllowedTerminalFollowupCommand(command: string | undefined): boolean {
  const match = ghPrCommand(command);
  return match?.subcommand === "view";
}

function isTerminalExternalActionCommand(command: string | undefined): boolean {
  const match = ghPrCommand(command);
  return match?.subcommand === "create" && !match.args.includes("--dry-run");
}

function ghPrCommand(command: string | undefined): { subcommand: string; args: string[] } | undefined {
  if (!command) return undefined;
  const tokens = shellWords(command).map((token) => token.toLowerCase());
  for (let index = 0; index < tokens.length - 2; index += 1) {
    if (!isGhExecutableToken(tokens[index] ?? "") || tokens[index + 1] !== "pr") continue;
    const subcommand = tokens[index + 2];
    if (!subcommand) return undefined;
    return { subcommand, args: tokens.slice(index + 3) };
  }
  return undefined;
}

function isGhExecutableToken(token: string): boolean {
  return token === "gh" || token.endsWith("/gh");
}

function isPostFailureEvidenceTool(toolName: string, command: string | undefined): boolean {
  if (["read", "grep", "find", "ls", "chalin_project_discovery"].includes(toolName)) return true;
  return toolName === "bash" && !isVerificationCommand(command);
}

function recordPreMutationEvidenceTool(toolName: string): void {
  if (!["read", "grep", "find", "ls", "chalin_project_discovery"].includes(toolName)) return;
  inlineWork.evidenceToolCount += 1;
  if (["grep", "find", "ls", "chalin_project_discovery"].includes(toolName)) {
    inlineWork.searchToolCount += 1;
  }
  if (toolName === "read") {
    inlineWork.readToolCount += 1;
  }
}

function recordDeletedPathsFromCommand(command: string): void {
  const words = shellWords(command);
  for (let index = 0; index < words.length; index += 1) {
    if (words[index] !== "rm") continue;
    for (let pathIndex = index + 1; pathIndex < words.length; pathIndex += 1) {
      const word = words[pathIndex] ?? "";
      if (!word || word === "&&" || word === ";" || word === "||") break;
      if (word.startsWith("-")) continue;
      inlineWork.deletedPaths.add(normalizeWorkflowPath(word));
    }
  }
}

function shouldNudgeLocatorLoop(): boolean {
  return !inlineWork.locatorLoopNudgeSent
    && !inlineWork.mutationObserved
    && (
      inlineWork.searchToolCount >= 3
      || (inlineWork.promptCodePaths.size > 0
        ? hasSearchAfterPromptCodePathRead()
        : inlineWork.readToolCount >= 1 && inlineWork.searchToolCount >= 1)
    );
}

function hasSearchAfterPromptCodePathRead(): boolean {
  let promptPathRead = false;
  for (const event of inlineWork.toolEvents) {
    if (event.phase !== "completed" || event.isError) continue;
    if (event.toolName === "read" && event.path) {
      const readPath = normalizeWorkflowPath(event.path);
      if ([...inlineWork.promptCodePaths].some((promptPath) => sameWorkflowPath(promptPath, readPath))) {
        promptPathRead = true;
      }
      continue;
    }
    if (promptPathRead && ["grep", "find", "ls", "chalin_project_discovery"].includes(event.toolName)) return true;
  }
  return false;
}

function inlineDocsOnlyMutation(): boolean {
  return inlineWork.changedPaths.size > 0
    && !inlineWork.sourceMutationObserved
    && !inlineWork.testMutationObserved
    && [...inlineWork.changedPaths].every(isDocsMarkdownPath);
}

function sourceMutationWithoutTestMutation(): boolean {
  return inlineWork.sourceMutationObserved
    && !inlineWork.testMutationObserved
    && !inlineWork.testCoverageReviewObserved
    && !passingVerificationTargetsReadTest();
}

function passingVerificationTargetsReadTest(): boolean {
  const command = inlineWork.verificationCommand;
  if (!command) return false;
  return [...inlineWork.readPaths]
    .filter(isTestLikePath)
    .some((path) => commandMentionsPath(command, path));
}

function commandMentionsPath(command: string, path: string): boolean {
  const normalizedCommand = command.replaceAll("\\", "/");
  const normalizedPath = normalizeWorkflowPath(path);
  const basename = normalizedPath.split("/").at(-1) ?? normalizedPath;
  return splitWhitespace(normalizedCommand)
    .map(trimTokenPunctuation)
    .some((token) => normalizeWorkflowPath(token) === normalizedPath || token === basename);
}

function promptCanonicalSurfaceBypassed(): { expected: string; actual: string[] } | undefined {
  const expectedSources = [...inlineWork.promptCodePaths]
    .filter((path) => isCodeLikePath(path) && !isTestLikePath(path) && !isDocsMarkdownPath(path));
  if (expectedSources.length === 0) return undefined;
  const changedSources = [...inlineWork.changedPaths]
    .map(normalizeWorkflowPath)
    .filter((path) => !inlineWork.deletedPaths.has(path))
    .filter((path) => isCodeLikePath(path) && !isTestLikePath(path) && !isDocsMarkdownPath(path));
  if (changedSources.length === 0) return undefined;

  for (const expected of expectedSources) {
    const actual = changedSources.filter((path) => looksLikeParallelSourceSurface(expected, path));
    const actualWithSiblingTests = actual.filter((path) => sourceHasMatchingChangedTest(path));
    if (actualWithSiblingTests.length > 0) return { expected, actual: actualWithSiblingTests };
    if (changedSources.some((path) => sameWorkflowPath(path, expected))) continue;
    if (actual.length > 0) return { expected, actual };
  }
  return undefined;
}

function pythonRootDuplicateTestSurface(): { expected: string; actual: string[] } | undefined {
  const changedTests = [...inlineWork.changedPaths]
    .map(normalizeWorkflowPath)
    .filter((path) => !inlineWork.deletedPaths.has(path))
    .filter((path) => path.endsWith(".py") && isTestLikePath(path));
  const runnerDiscovered = changedTests.filter((path) => /^tests\/test_[^/]+\.py$/i.test(path));
  const rootDuplicates = changedTests.filter((path) => /^test_[^/]+\.py$/i.test(path));
  for (const expected of runnerDiscovered) {
    const expectedBasename = normalizeWorkflowPath(expected).split("/").at(-1);
    const root = rootDuplicates.filter((path) => normalizeWorkflowPath(path).split("/").at(-1) === expectedBasename);
    if (root.length > 0) return { expected, actual: root };
  }
  return undefined;
}

function looksLikeParallelSourceSurface(expected: string, actual: string): boolean {
  if (sameWorkflowPath(expected, actual)) return false;
  if (pathExtension(expected) !== pathExtension(actual)) return false;
  if (pathDirectory(expected) !== pathDirectory(actual)) return false;
  return looksLikeSiblingStem(pathStem(expected), pathStem(actual));
}

function sourceHasMatchingChangedTest(sourcePath: string): boolean {
  const sourceStem = pathStem(sourcePath);
  return [...inlineWork.changedPaths]
    .map(normalizeWorkflowPath)
    .filter((path) => !inlineWork.deletedPaths.has(path))
    .filter(isTestLikePath)
    .some((testPath) => testStemMatchesSourceStem(pathStem(testPath), sourceStem));
}

function testStemMatchesSourceStem(testStem: string, sourceStem: string): boolean {
  const normalized = testStem
    .replace(/^test[_-]/, "")
    .replace(/[._-](?:test|spec)$/, "")
    .replace(/[_-]test$/, "");
  return normalized === sourceStem || looksLikeSiblingStem(sourceStem, normalized);
}

function pathDirectory(path: string): string {
  const normalized = normalizeWorkflowPath(path);
  const index = normalized.lastIndexOf("/");
  return index >= 0 ? normalized.slice(0, index) : "";
}

function pathExtension(path: string): string {
  const basename = normalizeWorkflowPath(path).split("/").at(-1) ?? "";
  const index = basename.lastIndexOf(".");
  return index >= 0 ? basename.slice(index).toLowerCase() : "";
}

function pathStem(path: string): string {
  const basename = normalizeWorkflowPath(path).split("/").at(-1) ?? "";
  const index = basename.lastIndexOf(".");
  return (index >= 0 ? basename.slice(0, index) : basename).toLowerCase();
}

function looksLikeSiblingStem(expected: string, actual: string): boolean {
  if (!expected || !actual || expected === actual) return false;
  if (expected.includes(actual) || actual.includes(expected)) return true;
  const minLength = Math.min(expected.length, actual.length);
  let prefix = 0;
  while (prefix < minLength && expected[prefix] === actual[prefix]) prefix += 1;
  if (prefix >= Math.min(6, Math.max(3, minLength - 1))) return true;
  return levenshteinDistance(expected, actual) <= 3;
}

function levenshteinDistance(left: string, right: string): number {
  const previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  const current = new Array<number>(right.length + 1);
  for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
    current[0] = leftIndex;
    for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
      const cost = left[leftIndex - 1] === right[rightIndex - 1] ? 0 : 1;
      current[rightIndex] = Math.min(
        current[rightIndex - 1] + 1,
        previous[rightIndex] + 1,
        previous[rightIndex - 1] + cost,
      );
    }
    for (let index = 0; index < current.length; index += 1) previous[index] = current[index] ?? 0;
  }
  return previous[right.length] ?? 0;
}

function extractPathFromArgsText(argsText: string | undefined): string | undefined {
  if (!argsText) return undefined;
  try {
    const parsed = JSON.parse(argsText) as { path?: unknown; filePath?: unknown; file?: unknown };
    for (const value of [parsed.path, parsed.filePath, parsed.file]) {
      if (typeof value === "string" && value.trim()) return value;
    }
  } catch {
    return undefined;
  }
  return undefined;
}

function extractContentFromArgsText(argsText: string | undefined): string | undefined {
  if (!argsText) return undefined;
  try {
    const parsed = JSON.parse(argsText) as { content?: unknown; newText?: unknown; replacement?: unknown };
    for (const value of [parsed.content, parsed.newText, parsed.replacement]) {
      if (typeof value === "string" && value.trim()) return value;
    }
  } catch {
    return undefined;
  }
  return undefined;
}

function looksLikeWeakTestCoverage(content: string): boolean {
  const jsTestCaseCount = (content.match(/\b(?:it|test)\s*\(/g) ?? []).length;
  const pythonTestCaseCount = (content.match(/\bdef\s+test_\w+\s*\(/g) ?? []).length;
  const testCaseCount = jsTestCaseCount + pythonTestCaseCount;
  const assertionCount = (content.match(/\b(?:assert(?:\.\w+)?|expect|self\.assert\w+|ck_assert(?:_\w+)?|CU_ASSERT(?:_\w+)?|g_assert(?:_\w+)?)\s*\(/g) ?? []).length;
  const trivialIntent = /\b(empty|smoke|noop|no-op|placeholder|trivial|stub)\b/i.test(content);
  const tautologicalAssertion = /\b(?:assert\.\w+|expect|self\.assert\w+)\s*\(\s*(?:1\s*,\s*1|true\s*,\s*true|True\s*,\s*True)/i.test(content);
  return (trivialIntent || tautologicalAssertion) && testCaseCount <= 1 && assertionCount <= 1;
}

function isPackageJsonPath(value: string): boolean {
  const normalized = value.replaceAll("\\", "/");
  return normalized.endsWith("package.json");
}

function packageJsonLikelyNeedsModuleType(content: string): boolean {
  try {
    const pkg = JSON.parse(content) as Record<string, unknown>;
    if (typeof pkg.type === "string" && pkg.type.trim()) return false;
    const metadata = JSON.stringify({
      bin: pkg.bin,
      main: pkg.main,
      exports: pkg.exports,
      module: pkg.module,
    });
    return /\.ts(?:["\\}]|$)/i.test(metadata) || /\.mjs(?:["\\}]|$)/i.test(metadata);
  } catch {
    return false;
  }
}

function isTestLikePath(value: string): boolean {
  const normalized = value.replaceAll("\\", "/");
  const relative = normalized.startsWith("../") ? normalized.slice(2) : normalized;
  const parts = relative.split("/").filter(Boolean).map((part) => part.toLowerCase());
  const file = parts.at(-1) ?? "";
  if (parts.some((part) => ["test", "tests", "spec", "specs", "__tests__"].includes(part))) return true;
  return file.includes(".test.")
    || file.includes(".spec.")
    || file.startsWith("test_")
    || file.endsWith("_test.c")
    || file.endsWith("_test.cc")
    || file.endsWith("_test.cpp")
    || file.endsWith("_test.go")
    || file.endsWith("_test.rs");
}

function isCoverageReviewPath(value: string): boolean {
  return [...inlineWork.changedPaths].some((changedPath) => sameWorkflowPath(changedPath, value));
}

function isSmallFullFileWrite(argsText: string | undefined): boolean {
  if (!argsText) return false;
  try {
    const parsed = JSON.parse(argsText) as { content?: unknown };
    if (typeof parsed.content !== "string") return false;
    const content = parsed.content;
    return content.length > 0 && content.length <= 6000 && content.split(/\r?\n/).length <= 180;
  } catch {
    return false;
  }
}

function sameWorkflowPath(left: string, right: string): boolean {
  return normalizeWorkflowPath(left) === normalizeWorkflowPath(right);
}

function normalizeWorkflowPath(value: string): string {
  let normalized = value.replaceAll("\\", "/").trim();
  while (normalized.startsWith("./")) normalized = normalized.slice(2);
  while (normalized.startsWith("../")) normalized = normalized.slice(3);
  return normalized;
}

function markOutOfWorkspaceMutation(value: string): boolean {
  if (!pathIsOutsideCurrentWorkspace(value)) return false;
  inlineWork.outOfWorkspaceMutationObserved = true;
  inlineWork.outOfWorkspaceMutationPath ??= value;
  return true;
}

function bashCommandLeavesWorkspace(command: string | undefined): boolean {
  if (!command) return false;
  const cdMatches = command.matchAll(/(?:^|[;&|]\s*)cd\s+(?:"([^"]+)"|'([^']+)'|([^\s;&|]+))/g);
  for (const match of cdMatches) {
    if (markOutOfWorkspaceMutation(match[1] ?? match[2] ?? match[3] ?? "")) return true;
  }
  const cwdFlagMatches = command.matchAll(/(?:--cwd|--prefix)\s+(?:"([^"]+)"|'([^']+)'|([^\s;&|]+))/g);
  for (const match of cwdFlagMatches) {
    if (markOutOfWorkspaceMutation(match[1] ?? match[2] ?? match[3] ?? "")) return true;
  }
  return false;
}

function pathIsOutsideCurrentWorkspace(value: string): boolean {
  const cwd = normalizeFilesystemPath(inlineWork.cwd);
  if (!cwd) return false;
  const target = normalizeFilesystemPath(value);
  if (!target) return false;
  if (target.startsWith("~/")) return true;
  if (!isAbsoluteFilesystemPath(target)) return false;
  return target !== cwd && !target.startsWith(`${cwd}/`);
}

function hasInWorkspaceMutation(): boolean {
  return [...inlineWork.changedPaths].some((changedPath) => !pathIsOutsideCurrentWorkspace(changedPath));
}

function normalizeFilesystemPath(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const trimmed = value.trim().replace(/^['"]|['"]$/g, "");
  if (!trimmed) return undefined;
  const normalized = trimmed.replaceAll("\\", "/").replace(/^\/private\//, "/").replace(/\/+$/g, "");
  return normalized || "/";
}

function isAbsoluteFilesystemPath(value: string): boolean {
  return value.startsWith("/") || /^[A-Za-z]:\//.test(value);
}

function isDocsMarkdownPath(value: string): boolean {
  const normalized = value.replaceAll("\\", "/");
  const relative = normalized.startsWith("../") ? normalized.slice(2) : normalized;
  return relative.endsWith(".md");
}

function promptPathTokens(prompt: string): string[] {
  return splitWhitespace(prompt)
    .map((token) => trimTokenPunctuation(token))
    .filter((token) => token.includes(".") && !token.includes("://"));
}

function isCodeLikePath(value: string): boolean {
  const basename = value.replaceAll("\\", "/").split("/").at(-1)?.toLowerCase() ?? "";
  return /\.(?:cjs|mjs|js|jsx|ts|tsx|py|rb|go|rs|c|h|cc|hh|cpp|hpp|zig|java|kt|cs|php)$/.test(basename);
}

function splitWhitespace(text: string): string[] {
  const tokens: string[] = [];
  let start: number | undefined;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    const whitespace = char === " " || char === "\t" || char === "\n" || char === "\r";
    if (whitespace) {
      if (start !== undefined) tokens.push(text.slice(start, index));
      start = undefined;
    } else if (start === undefined) {
      start = index;
    }
  }
  if (start !== undefined) tokens.push(text.slice(start));
  return tokens;
}

function trimTokenPunctuation(token: string): string {
  let start = 0;
  let end = token.length;
  while (start < end && "`'\"([{<".includes(token[start] ?? "")) start += 1;
  while (end > start && "`'\".,;:!?)]}>".includes(token[end - 1] ?? "")) end -= 1;
  return token.slice(start, end);
}

function isVerificationCommand(command: string | undefined): boolean {
  if (!command) return false;
  const tokens = shellWords(command).map((token) => token.toLowerCase());
  const commandName = tokens[0];
  if (!commandName) return false;
  const args = tokens.slice(1);
  if (["npm", "pnpm", "yarn"].includes(commandName)) {
    if (args[0] === "test") return true;
    if (args[0] === "run" && ["test", "typecheck", "lint", "check"].includes(args[1] ?? "")) return true;
    if (args[0] === "exec" && ["vitest", "jest", "tsc", "eslint"].includes(args[1] ?? "")) return true;
    return false;
  }
  if (commandName === "node") return args.includes("--test");
  if ((commandName === "python" || commandName === "python3") && args[0] === "-m" && args[1] === "unittest") return true;
  if (commandName === "go") return args[0] === "test";
  if (commandName === "cargo") return args[0] === "test";
  if (commandName === "make") return args.length === 0 || args.includes("test") || args.includes("check");
  if (["pytest", "vitest", "jest", "eslint"].includes(commandName)) return true;
  if (commandName === "tsc") return args.includes("--noemit");
  return false;
}

function shellWords(command: string): string[] {
  const words: string[] = [];
  let current = "";
  let quote: "'" | "\"" | undefined;
  for (let index = 0; index < command.length; index += 1) {
    const char = command[index] ?? "";
    if (quote) {
      if (char === quote) quote = undefined;
      else current += char;
      continue;
    }
    if (char === "'" || char === "\"") {
      quote = char;
      continue;
    }
    if (char === " " || char === "\t" || char === "\n" || char === "\r") {
      if (current) {
        words.push(current);
        current = "";
      }
      continue;
    }
    current += char;
  }
  if (current) words.push(current);
  return words;
}
