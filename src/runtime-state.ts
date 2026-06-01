import { Context, Effect, Layer, Ref } from "effect";
import type { RouteDecision, RunState } from "./schemas.ts";

export type ChalinRouteOutcome = "dry-run" | "ask" | "block" | "failed" | "paused" | "complete";
type DirectModeKind = "docs-only" | "lean-bounded-code-test" | "bounded-code-test" | "broken-test-triage" | "test-only" | "scaffold-greenfield" | "stateful-time" | "generic";
export type DirectToolEventPhase = "start" | "completed";
export type DirectNudgeKind =
  | "workspace-boundary"
  | "docs-shell"
  | "docs-prewrite-shell"
  | "pre-mutation-verification"
  | "post-verification-shell"
  | "post-verification-exploration"
  | "docs-evidence-loop"
  | "scaffold-evidence-loop"
  | "locator-loop"
  | "stateful-time"
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
  shouldDocsPreWriteShellNudge: boolean;
  shouldPreMutationVerificationNudge: boolean;
  shouldPostVerificationShellNudge: boolean;
  shouldPostVerificationExplorationNudge: boolean;
  shouldDocsEvidenceLoopNudge: boolean;
  shouldScaffoldEvidenceLoopNudge: boolean;
  shouldLocatorLoopNudge: boolean;
  shouldStatefulTimeNudge: boolean;
  shouldExistingFileRewriteNudge: boolean;
  shouldMutationLoopNudge: boolean;
  shouldSourceAndTestReadyNudge: boolean;
  shouldVerificationLoopNudge: boolean;
  shouldPostFailureEvidenceNudge: boolean;
  verificationCommand?: string;
  docsOnlyMutation: boolean;
  plan?: DirectNudgePlan;
}

type DirectNudgeFlag = Exclude<keyof DirectToolCompletionAdapter, "verificationCommand" | "docsOnlyMutation" | "plan">;

export type DirectNudgeSelectorInput = Omit<DirectToolCompletionAdapter, "plan">;

interface ChalinRouteInvocation {
  id: number;
  dryRun: boolean;
  route?: Pick<RouteDecision, "kind" | "agents" | "risk">;
  outcome?: ChalinRouteOutcome;
}

interface DirectCompletionState {
  directModeKind: DirectModeKind;
  docsOnlyPathPrompt: boolean;
  cwd?: string;
  toolEvents: DirectToolEvent[];
  mutationObserved: boolean;
  sourceMutationObserved: boolean;
  testMutationObserved: boolean;
  changedPaths: Set<string>;
  readPaths: Set<string>;
  promptCodePaths: Set<string>;
  deletedPaths: Set<string>;
  mutationToolCount: number;
  evidenceToolCount: number;
  searchToolCount: number;
  readToolCount: number;
  docsWriteAfterReadCount: number;
  docsPreMutationShellBudget: number;
  docsPreMutationShellCount: number;
  verificationAttemptCount: number;
  preMutationVerificationNudgeSent: boolean;
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
  statefulTimeNudgeSent: boolean;
  docsShellNudgeSent: boolean;
  docsPostWriteShellNudgeSent: boolean;
  docsPreWriteShellNudgeSent: boolean;
  postVerificationShellNudgeSent: boolean;
  postVerificationExplorationNudgeSent: boolean;
  readbackStopNudgeSent: boolean;
  docsEvidenceLoopNudgeSent: boolean;
  scaffoldEvidenceLoopNudgeSent: boolean;
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
  readonly directCompletion: Ref.Ref<DirectCompletionState>;
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
    directCompletion: yield* Ref.make(freshDirectCompletionState()),
    skillOverrides: yield* Ref.make<SkillOverrideState>(freshSkillOverrideState()),
  };
}));

const runtimeState = Effect.runSync(Effect.gen(function* () {
  return yield* RuntimeStateService;
}).pipe(Effect.provide(RuntimeStateLayer)));

const lastRunRef = runtimeState.lastRun;
const liveStepSessions = refBackedMap(runtimeState.liveStepSessions);
const routeInvocations = refBackedArray(runtimeState.routeInvocations);
const directCompletion = refBackedObject(runtimeState.directCompletion);
const skillOverridesRef = runtimeState.skillOverrides;

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
  replaceRefBackedObject(directCompletion, freshDirectCompletionState());
  clearSkillOverridesForTurn();
  directCompletion.cwd = options.cwd;
  directCompletion.directModeKind = classifyDirectModeKind(options.prompt ?? "");
  directCompletion.promptCodePaths = new Set(promptPathTokens(options.prompt ?? "").filter(isCodeLikePath).map(normalizeWorkflowPath));
  directCompletion.docsOnlyPathPrompt = directCompletion.directModeKind === "docs-only";
  directCompletion.docsWriteAfterReadCount = docsWriteAfterReadCount(options.prompt ?? "");
  directCompletion.docsPreMutationShellBudget = docsEvidenceShellBudget(options.prompt ?? "");
}

export function recordDirectToolStart(options: Omit<DirectToolEvent, "phase">): void {
  appendDirectToolEvent({ ...options, phase: "start" });
}

export function getDirectToolEventsForTests(): DirectToolEvent[] {
  return directCompletion.toolEvents.map((event) => ({ ...event }));
}

export function getDirectDerivedGapDiagnosticsForTests(): { weakTestCoverage: boolean; packageMetadata: boolean; parallelSurface?: { expected: string; actual: string[] } } {
  return {
    weakTestCoverage: directWeakTestCoverageGap(),
    packageMetadata: directPackageMetadataGap(),
    parallelSurface: directParallelSurfaceGap(),
  };
}

export function recordDirectToolCompletion(options: { toolName: string; isError?: boolean; command?: string; path?: string; argsText?: string }): DirectToolCompletionAdapter {
  appendDirectToolEvent({ ...options, phase: "completed" });
  let shouldProgressNudge = false;
  let shouldWorkspaceBoundaryNudge = false;
  let shouldDocsShellNudge = false;
  let shouldDocsPreWriteShellNudge = false;
  let shouldPreMutationVerificationNudge = false;
  let shouldPostVerificationShellNudge = false;
  let shouldPostVerificationExplorationNudge = false;
  let shouldDocsEvidenceLoopNudge = false;
  let shouldScaffoldEvidenceLoopNudge = false;
  let shouldLocatorLoopNudge = false;
  let shouldStatefulTimeNudge = false;
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
  const leanBoundedTurn = directCompletion.directModeKind === "lean-bounded-code-test";
  const coverageReviewWasRequested = directCompletion.testCoverageNudgeSent;
  if (!directCompletion.mutationObserved && !options.isError) {
    recordPreMutationEvidenceTool(options.toolName);
    if (shouldNudgeDocsPreWriteShell()) {
      shouldDocsPreWriteShellNudge = true;
      directCompletion.docsPreWriteShellNudgeSent = true;
    } else if (shouldNudgeDocsEvidenceLoop()) {
      shouldDocsEvidenceLoopNudge = true;
      directCompletion.docsEvidenceLoopNudgeSent = true;
    }
    if (shouldNudgeScaffoldEvidenceLoop()) {
      shouldScaffoldEvidenceLoopNudge = true;
      directCompletion.scaffoldEvidenceLoopNudgeSent = true;
    }
    if (!shouldScaffoldEvidenceLoopNudge && shouldNudgeLocatorLoop()) {
      shouldLocatorLoopNudge = true;
      directCompletion.locatorLoopNudgeSent = true;
    }
    if (shouldNudgeStatefulTimeDrift(options.toolName)) {
      shouldStatefulTimeNudge = true;
      directCompletion.statefulTimeNudgeSent = true;
    }
    if (leanBoundedTurn) {
      shouldDocsEvidenceLoopNudge = false;
      shouldScaffoldEvidenceLoopNudge = false;
      shouldLocatorLoopNudge = false;
      shouldStatefulTimeNudge = false;
    }
  }
  if (options.toolName === "read" && options.path && !options.isError) {
    directCompletion.readPaths.add(normalizeWorkflowPath(options.path));
  }
  if (options.toolName === "edit" || options.toolName === "write") {
    if (options.isError) return directCompletionAdapter({ shouldProgressNudge: false, shouldReadyToVerifyNudge: false, shouldFailureNudge: false, shouldCompletionNudge: false, shouldTestCoverageNudge: false, shouldWeakTestCoverageNudge: false, shouldPackageMetadataNudge: false, shouldParallelSurfaceNudge: false, shouldWorkspaceBoundaryNudge, shouldDocsShellNudge, shouldDocsPreWriteShellNudge, shouldPreMutationVerificationNudge, shouldPostVerificationShellNudge, shouldPostVerificationExplorationNudge, shouldDocsEvidenceLoopNudge, shouldScaffoldEvidenceLoopNudge, shouldLocatorLoopNudge, shouldStatefulTimeNudge, shouldExistingFileRewriteNudge, shouldMutationLoopNudge, shouldSourceAndTestReadyNudge, shouldVerificationLoopNudge, shouldPostFailureEvidenceNudge, docsOnlyMutation: directDocsOnlyMutation() });
    justMutated = true;
    const recoveringFromVerificationFailure = directCompletion.failedVerificationNudgeSent && !directCompletion.verificationObserved;
    directCompletion.mutationObserved = true;
    directCompletion.mutationToolCount += 1;
    if (!recoveringFromVerificationFailure && !directCompletion.mutationLoopNudgeSent && directCompletion.mutationToolCount >= 3 && !directCompletion.verificationObserved) {
      shouldMutationLoopNudge = true;
      directCompletion.mutationLoopNudgeSent = true;
    }
    const changedPath = options.path ?? extractPathFromArgsText(options.argsText);
    if (changedPath) {
      directCompletion.changedPaths.add(changedPath);
      if (markOutOfWorkspaceMutation(changedPath) && !directCompletion.outOfWorkspaceMutationNudgeSent) {
        shouldWorkspaceBoundaryNudge = true;
        directCompletion.outOfWorkspaceMutationNudgeSent = true;
      }
      if (
        options.toolName === "write"
        && !isDocsMarkdownPath(changedPath)
        && directCompletion.readPaths.has(normalizeWorkflowPath(changedPath))
        && !directCompletion.existingFileRewriteNudgeSent
        && !isSmallFullFileWrite(options.argsText)
      ) {
        shouldExistingFileRewriteNudge = true;
        directCompletion.existingFileRewriteNudgeSent = true;
      }
      if (isTestLikePath(changedPath)) {
        directCompletion.testMutationObserved = true;
        if (!directWeakTestCoverageGap()) directCompletion.weakTestCoverageNudgeSent = false;
      } else if (!isDocsMarkdownPath(changedPath)) {
        directCompletion.sourceMutationObserved = true;
      }
      if (isPackageJsonPath(changedPath) && directCompletion.directModeKind === "scaffold-greenfield") {
        if (!directPackageMetadataGap()) directCompletion.packageMetadataNudgeSent = false;
      }
      if (coverageReviewWasRequested && !isDocsMarkdownPath(changedPath)) {
        directCompletion.testCoverageReviewObserved = true;
      }
    } else {
      directCompletion.sourceMutationObserved = true;
      if (coverageReviewWasRequested) directCompletion.testCoverageReviewObserved = true;
    }
    if (directCompletion.verificationObserved || directCompletion.verificationCommand || directCompletion.failedVerificationNudgeSent || directCompletion.nudgeSent) {
      staleVerificationReset = true;
      directCompletion.verificationObserved = false;
      directCompletion.verificationCommand = undefined;
      directCompletion.readyToVerifyNudgeSent = false;
      directCompletion.failedVerificationNudgeSent = false;
      directCompletion.postVerificationShellNudgeSent = false;
      directCompletion.postVerificationExplorationNudgeSent = false;
      directCompletion.readbackStopNudgeSent = false;
      directCompletion.verificationLoopNudgeSent = false;
      directCompletion.sourceAndTestReadyNudgeSent = false;
      directCompletion.postFailureEvidenceToolCount = 0;
      directCompletion.postFailureEvidenceNudgeSent = false;
      directCompletion.verificationAttemptCount = 0;
      directCompletion.weakTestCoverageNudgeSent = false;
      directCompletion.packageMetadataNudgeSent = false;
      directCompletion.parallelSurfaceNudgeSent = false;
      directCompletion.nudgeSent = false;
    }
    if (
      !leanBoundedTurn
      && !directCompletion.sourceAndTestReadyNudgeSent
      && !directCompletion.verificationObserved
      && directCompletion.sourceMutationObserved
      && directCompletion.testMutationObserved
      && directCompletion.mutationToolCount >= 2
    ) {
      shouldSourceAndTestReadyNudge = true;
      directCompletion.sourceAndTestReadyNudgeSent = true;
    }
    shouldProgressNudge = !leanBoundedTurn && !directCompletion.progressNudgeSent;
    if (shouldProgressNudge) directCompletion.progressNudgeSent = true;
  }
  let shouldFailureNudge = false;
  const docsOnlyMutation = directDocsOnlyMutation();
  const verificationLeftWorkspace = options.toolName === "bash"
    && directCompletion.mutationObserved
    && bashCommandLeavesWorkspace(options.command);
  if (verificationLeftWorkspace && !directCompletion.outOfWorkspaceMutationNudgeSent) {
    shouldWorkspaceBoundaryNudge = true;
    directCompletion.outOfWorkspaceMutationNudgeSent = true;
  }
  if (
    options.toolName === "bash"
    && !directCompletion.mutationObserved
    && isDirectCodeTestMode(directCompletion.directModeKind)
    && isVerificationCommand(options.command)
    && !directCompletion.preMutationVerificationNudgeSent
  ) {
    shouldPreMutationVerificationNudge = true;
    directCompletion.preMutationVerificationNudgeSent = true;
  }
  if (options.toolName === "read" && options.path && directCompletion.testCoverageNudgeSent && isCoverageReviewPath(options.path) && !options.isError) {
    directCompletion.testCoverageReviewObserved = true;
  }
  if (options.toolName === "bash" && directCompletion.docsOnlyPathPrompt) {
    if (!docsOnlyMutation && shouldAllowDocsPreMutationShell(options.command, options.isError)) {
      directCompletion.docsPreMutationShellCount += 1;
    } else if (docsOnlyMutation) {
      shouldDocsShellNudge = !directCompletion.docsPostWriteShellNudgeSent;
      directCompletion.docsPostWriteShellNudgeSent = true;
    } else {
      shouldDocsShellNudge = !directCompletion.docsShellNudgeSent;
      directCompletion.docsShellNudgeSent = true;
    }
  }
  if (
    options.toolName === "bash"
    && directCompletion.mutationObserved
    && directCompletion.verificationObserved
    && !directDocsOnlyMutation()
    && !directCompletion.postVerificationShellNudgeSent
  ) {
    shouldPostVerificationShellNudge = true;
    directCompletion.postVerificationShellNudgeSent = true;
  }
  if (options.toolName === "read" && docsOnlyMutation && options.path && directCompletion.changedPaths.has(options.path) && !options.isError) {
    directCompletion.verificationObserved = true;
    directCompletion.verificationCommand = `read ${options.path}`;
  } else if (options.toolName === "bash" && docsOnlyMutation) {
    directCompletion.verificationObserved = false;
    directCompletion.verificationCommand = undefined;
  } else if (options.toolName === "bash" && directCompletion.mutationObserved && isVerificationCommand(options.command)) {
    directCompletion.verificationCommand = options.command?.trim();
    directCompletion.verificationAttemptCount += 1;
    if (verificationLeftWorkspace) {
      directCompletion.verificationObserved = false;
    } else if (options.isError) {
      shouldFailureNudge = !directCompletion.failedVerificationNudgeSent;
      if (shouldFailureNudge) directCompletion.failedVerificationNudgeSent = true;
      if (!directCompletion.verificationLoopNudgeSent && directCompletion.verificationAttemptCount >= 2) {
        shouldVerificationLoopNudge = true;
        directCompletion.verificationLoopNudgeSent = true;
      }
    } else {
      directCompletion.verificationObserved = true;
      if (directCompletion.outOfWorkspaceMutationObserved && hasInWorkspaceMutation()) {
        directCompletion.outOfWorkspaceMutationObserved = false;
        directCompletion.outOfWorkspaceMutationPath = undefined;
      }
      if (!directCompletion.verificationLoopNudgeSent && directCompletion.verificationAttemptCount >= 3) {
        shouldVerificationLoopNudge = true;
        directCompletion.verificationLoopNudgeSent = true;
      }
    }
  } else if (options.toolName === "bash" && directCompletion.mutationObserved && options.isError) {
    shouldFailureNudge = !directCompletion.failedVerificationNudgeSent;
    if (shouldFailureNudge) directCompletion.failedVerificationNudgeSent = true;
  } else if (options.isError) {
    return directCompletionAdapter({ shouldProgressNudge, shouldReadyToVerifyNudge: false, shouldFailureNudge: false, shouldCompletionNudge: false, shouldTestCoverageNudge: false, shouldWeakTestCoverageNudge: false, shouldPackageMetadataNudge: false, shouldParallelSurfaceNudge: false, shouldWorkspaceBoundaryNudge, shouldDocsShellNudge, shouldDocsPreWriteShellNudge, shouldPreMutationVerificationNudge, shouldPostVerificationShellNudge, shouldPostVerificationExplorationNudge, shouldDocsEvidenceLoopNudge, shouldScaffoldEvidenceLoopNudge, shouldLocatorLoopNudge, shouldStatefulTimeNudge, shouldExistingFileRewriteNudge, shouldMutationLoopNudge, shouldSourceAndTestReadyNudge, shouldVerificationLoopNudge, shouldPostFailureEvidenceNudge, verificationCommand: directCompletion.verificationCommand, docsOnlyMutation });
  }
  if (shouldNudgeStatefulTimeDrift(options.toolName)) {
    shouldStatefulTimeNudge = true;
    directCompletion.statefulTimeNudgeSent = true;
  }
  if (
    directCompletion.failedVerificationNudgeSent
    && !directCompletion.verificationObserved
    && !justMutated
    && isPostFailureEvidenceTool(options.toolName, options.command)
    && !options.isError
  ) {
    directCompletion.postFailureEvidenceToolCount += 1;
    if (!directCompletion.postFailureEvidenceNudgeSent && directCompletion.postFailureEvidenceToolCount >= 2) {
      shouldPostFailureEvidenceNudge = true;
      directCompletion.postFailureEvidenceNudgeSent = true;
    }
  }
  const shouldReadyToVerifyNudge = directCompletion.mutationObserved
    && !directCompletion.verificationObserved
    && !directCompletion.readyToVerifyNudgeSent
    && options.toolName !== "bash"
    && !shouldSourceAndTestReadyNudge
    && (docsOnlyMutation || staleVerificationReset || (!justMutated && !shouldFailureNudge && !options.isError));
  if (shouldReadyToVerifyNudge) directCompletion.readyToVerifyNudgeSent = true;
  const needsWeakTestCoverageReview = directCompletion.verificationObserved
    && directCompletion.sourceMutationObserved
    && directCompletion.testMutationObserved
    && directWeakTestCoverageGap();
  const shouldWeakTestCoverageNudge = directCompletion.sourceMutationObserved
    && directCompletion.testMutationObserved
    && directWeakTestCoverageGap()
    && !directCompletion.weakTestCoverageNudgeSent
    && (justMutated || directCompletion.verificationObserved);
  if (shouldWeakTestCoverageNudge) directCompletion.weakTestCoverageNudgeSent = true;
  const needsPackageMetadataReview = directCompletion.verificationObserved
    && directCompletion.directModeKind === "scaffold-greenfield"
    && directPackageMetadataGap();
  const shouldPackageMetadataNudge = directCompletion.directModeKind === "scaffold-greenfield"
    && directPackageMetadataGap()
    && !directCompletion.packageMetadataNudgeSent
    && (justMutated || directCompletion.verificationObserved);
  if (shouldPackageMetadataNudge) directCompletion.packageMetadataNudgeSent = true;
  const parallelSurfaceGap = directParallelSurfaceGap();
  const shouldParallelSurfaceNudge = Boolean(parallelSurfaceGap) && !directCompletion.parallelSurfaceNudgeSent;
  if (shouldParallelSurfaceNudge) directCompletion.parallelSurfaceNudgeSent = true;
  const needsMissingTestCoverageReview = directCompletion.verificationObserved
    && sourceMutationWithoutTestMutation();
  const needsTestCoverageReview = needsMissingTestCoverageReview || needsWeakTestCoverageReview || needsPackageMetadataReview || Boolean(parallelSurfaceGap);
  const shouldTestCoverageNudge = needsMissingTestCoverageReview && !directCompletion.testCoverageNudgeSent;
  if (shouldTestCoverageNudge) directCompletion.testCoverageNudgeSent = true;
  const changedPathReadbackObserved = options.toolName === "read"
    && Boolean(options.path)
    && !options.isError
    && [...directCompletion.changedPaths].some((changedPath) => sameWorkflowPath(changedPath, options.path ?? ""));
  if (
    directCompletion.mutationObserved
    && directCompletion.verificationObserved
    && !needsTestCoverageReview
    && !changedPathReadbackObserved
    && !directDocsOnlyMutation()
    && isPostVerificationExplorationTool(options.toolName)
    && !directCompletion.postVerificationExplorationNudgeSent
  ) {
    shouldPostVerificationExplorationNudge = true;
    directCompletion.postVerificationExplorationNudgeSent = true;
  }
  let shouldCompletionNudge = directCompletion.mutationObserved
    && directCompletion.verificationObserved
    && !needsTestCoverageReview
    && !directCompletion.outOfWorkspaceMutationObserved
    && !directCompletion.nudgeSent;
  if (
    !shouldCompletionNudge
    && changedPathReadbackObserved
    && directCompletion.mutationObserved
    && directCompletion.verificationObserved
    && !needsTestCoverageReview
    && !directCompletion.outOfWorkspaceMutationObserved
    && !directDocsOnlyMutation()
    && !directCompletion.readbackStopNudgeSent
  ) {
    shouldCompletionNudge = true;
    directCompletion.readbackStopNudgeSent = true;
  }
  if (shouldCompletionNudge) directCompletion.nudgeSent = true;
  return directCompletionAdapter({ shouldProgressNudge, shouldReadyToVerifyNudge, shouldFailureNudge, shouldCompletionNudge, shouldTestCoverageNudge, shouldWeakTestCoverageNudge, shouldPackageMetadataNudge, shouldParallelSurfaceNudge, shouldWorkspaceBoundaryNudge, shouldDocsShellNudge, shouldDocsPreWriteShellNudge, shouldPreMutationVerificationNudge, shouldPostVerificationShellNudge, shouldPostVerificationExplorationNudge, shouldDocsEvidenceLoopNudge, shouldScaffoldEvidenceLoopNudge, shouldLocatorLoopNudge, shouldStatefulTimeNudge, shouldExistingFileRewriteNudge, shouldMutationLoopNudge, shouldSourceAndTestReadyNudge, shouldVerificationLoopNudge, shouldPostFailureEvidenceNudge, verificationCommand: directCompletion.verificationCommand, docsOnlyMutation });
}

const DIRECT_NUDGE_FLAGS = [
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
  "shouldDocsPreWriteShellNudge",
  "shouldPreMutationVerificationNudge",
  "shouldPostVerificationShellNudge",
  "shouldPostVerificationExplorationNudge",
  "shouldDocsEvidenceLoopNudge",
  "shouldScaffoldEvidenceLoopNudge",
  "shouldLocatorLoopNudge",
  "shouldStatefulTimeNudge",
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
  ["completion", "shouldCompletionNudge"],
  ["docs-shell", "shouldDocsShellNudge"],
  ["docs-prewrite-shell", "shouldDocsPreWriteShellNudge"],
  ["pre-mutation-verification", "shouldPreMutationVerificationNudge"],
  ["post-verification-shell", "shouldPostVerificationShellNudge"],
  ["post-verification-exploration", "shouldPostVerificationExplorationNudge"],
  ["docs-evidence-loop", "shouldDocsEvidenceLoopNudge"],
  ["scaffold-evidence-loop", "shouldScaffoldEvidenceLoopNudge"],
  ["stateful-time", "shouldStatefulTimeNudge"],
  ["locator-loop", "shouldLocatorLoopNudge"],
  ["existing-file-rewrite", "shouldExistingFileRewriteNudge"],
  ["mutation-loop", "shouldMutationLoopNudge"],
  ["source-and-test-ready", "shouldSourceAndTestReadyNudge"],
  ["verification-loop", "shouldVerificationLoopNudge"],
  ["post-failure-evidence", "shouldPostFailureEvidenceNudge"],
  ["ready-to-verify", "shouldReadyToVerifyNudge"],
  ["progress", "shouldProgressNudge"],
] as const satisfies readonly (readonly [DirectNudgeKind, DirectNudgeFlag])[];

export function selectDirectNudgePlan(input: DirectNudgeSelectorInput): DirectNudgePlan | undefined {
  for (const [kind, flag] of DIRECT_NUDGE_PRIORITY) {
    if (input[flag]) return { kind, verificationCommand: input.verificationCommand, docsOnlyMutation: input.docsOnlyMutation };
  }
  return undefined;
}

function directCompletionAdapter(raw: DirectNudgeSelectorInput): DirectToolCompletionAdapter {
  const plan = selectDirectNudgePlan(raw);
  const adapter: DirectToolCompletionAdapter = { ...raw, plan };
  for (const flag of DIRECT_NUDGE_FLAGS) {
    adapter[flag] = false;
  }
  if (plan) adapter[directNudgeFlagForKind(plan.kind)] = true;
  return adapter;
}

function directNudgeFlagForKind(kind: DirectNudgeKind): DirectNudgeFlag {
  const matched = DIRECT_NUDGE_PRIORITY.find(([item]) => item === kind);
  if (!matched) return "shouldProgressNudge";
  return matched[1];
}

export function getDirectChangedPaths(): string[] {
  return [...directCompletion.changedPaths].sort((left, right) => normalizeWorkflowPath(left).localeCompare(normalizeWorkflowPath(right)));
}

export function isDirectStatefulTimeTurn(): boolean {
  return directCompletion.directModeKind === "stateful-time";
}

export function isDirectTestOnlyTurn(): boolean {
  return directCompletion.directModeKind === "test-only";
}

export function isDirectLeanBoundedTurn(): boolean {
  return directCompletion.directModeKind === "lean-bounded-code-test";
}

export function getDirectCriticalGuardContextMessage(): string | undefined {
  if (!directCompletion.verificationObserved && !directCompletion.outOfWorkspaceMutationObserved) return undefined;
  const reasons: string[] = [];
  const parallelSurfaceGap = promptCanonicalSurfaceBypassed() ?? pythonRootDuplicateTestSurface();
  if (directCompletion.outOfWorkspaceMutationObserved) {
    const path = directCompletion.outOfWorkspaceMutationPath ? ` (${directCompletion.outOfWorkspaceMutationPath})` : "";
    reasons.push(`a mutation or verification targeted a path outside the current workspace root${path}`);
  }
  if (
    directCompletion.sourceMutationObserved
    && directCompletion.testMutationObserved
    && directWeakTestCoverageGap()
  ) {
    reasons.push("the changed tests still look like trivial smoke/empty coverage instead of assertions for the requested behavior");
  }
  if (
    directCompletion.directModeKind === "scaffold-greenfield"
    && directPackageMetadataGap()
  ) {
    reasons.push("the scaffold package metadata still does not agree with delivered bin/main/export/module entrypoints");
  }
  if (parallelSurfaceGap) {
    reasons.push(`the canonical surface \`${parallelSurfaceGap.expected}\` was bypassed by parallel file(s) ${parallelSurfaceGap.actual.map((path) => `\`${path}\``).join(", ")}`);
  }
  if (
    reasons.length === 0
    && directCompletion.verificationObserved
    && (directCompletion.postVerificationShellNudgeSent || directCompletion.postVerificationExplorationNudgeSent)
  ) {
    const command = directCompletion.verificationCommand ? ` with \`${directCompletion.verificationCommand}\`` : "";
    return [
      "pi-chalin critical direct-work guard.",
      `Hard stop: verification already passed${command} after the latest mutation, and later tool use did not include a new edit.`,
      "Your next assistant action must be the final answer in the user's language with changed files, verification, and compact notes.",
      "Do not call more tools, rerun tests, or read files just to summarize. If a later tool exposed a concrete defect, patch only that root cause and rerun the nearest verification once before final.",
    ].join("\n");
  }
  if (reasons.length === 0) return undefined;
  return [
    "pi-chalin critical direct-work guard.",
    `Hard stop: a final answer is invalid because ${reasons.join(" and ")}.`,
    directCompletion.outOfWorkspaceMutationObserved
      ? "Your next assistant action must recreate or move the required artifacts under the current workspace root using relative paths, then rerun the nearest verification from that root."
      : parallelSurfaceGap
      ? "Your next assistant action must consolidate the implementation and tests into the prompt/starter source and runner-discovered test paths, remove the parallel sibling files, then rerun the nearest verification once."
      : "Your next assistant action must be a tool call that patches the smallest missing source/test/package evidence, then reruns the nearest verification once.",
    "Do not claim completion, summarize, or explain intent until that corrective verification passes after the patch.",
  ].join("\n");
}

function isDirectCodeTestMode(kind: DirectModeKind): boolean {
  return kind === "lean-bounded-code-test" || kind === "bounded-code-test" || kind === "broken-test-triage" || kind === "test-only" || kind === "stateful-time";
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
  replaceRefBackedObject(directCompletion, freshDirectCompletionState());
  clearSkillOverridesForTurn();
}

function liveStepKey(runId: string, stepId: string): string {
  return `${runId}:${stepId}`;
}

function freshDirectCompletionState(): DirectCompletionState {
  return {
    directModeKind: "generic",
    docsOnlyPathPrompt: false,
    cwd: undefined,
    toolEvents: [],
    mutationObserved: false,
    sourceMutationObserved: false,
    testMutationObserved: false,
    changedPaths: new Set(),
    readPaths: new Set(),
    promptCodePaths: new Set(),
    deletedPaths: new Set(),
    mutationToolCount: 0,
    evidenceToolCount: 0,
    searchToolCount: 0,
    readToolCount: 0,
    docsWriteAfterReadCount: 0,
    docsPreMutationShellBudget: 0,
    docsPreMutationShellCount: 0,
    verificationAttemptCount: 0,
    preMutationVerificationNudgeSent: false,
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
    statefulTimeNudgeSent: false,
    docsShellNudgeSent: false,
    docsPostWriteShellNudgeSent: false,
    docsPreWriteShellNudgeSent: false,
    postVerificationShellNudgeSent: false,
    postVerificationExplorationNudgeSent: false,
    readbackStopNudgeSent: false,
    docsEvidenceLoopNudgeSent: false,
    scaffoldEvidenceLoopNudgeSent: false,
    existingFileRewriteNudgeSent: false,
    mutationLoopNudgeSent: false,
    sourceAndTestReadyNudgeSent: false,
    verificationLoopNudgeSent: false,
    postFailureEvidenceToolCount: 0,
    postFailureEvidenceNudgeSent: false,
    nudgeSent: false,
  };
}

function appendDirectToolEvent(event: DirectToolEvent): void {
  directCompletion.toolEvents.push(event);
  if (directCompletion.toolEvents.length > 200) {
    directCompletion.toolEvents.splice(0, directCompletion.toolEvents.length - 200);
  }
}

function directWeakTestCoverageGap(): boolean {
  const latestByPath = latestChangedFileContents((path) => isTestLikePath(path));
  return [...latestByPath.values()].some((content) => looksLikeWeakTestCoverage(content));
}

function directPackageMetadataGap(): boolean {
  if (directCompletion.directModeKind !== "scaffold-greenfield") return false;
  const latestPackage = [...latestChangedFileContents((path) => isPackageJsonPath(path)).values()].at(-1);
  return latestPackage !== undefined && packageJsonLikelyNeedsModuleType(latestPackage);
}

function directParallelSurfaceGap(): { expected: string; actual: string[] } | undefined {
  if (!directCompletion.verificationObserved) return undefined;
  return promptCanonicalSurfaceBypassed() ?? pythonRootDuplicateTestSurface();
}

function latestChangedFileContents(predicate: (path: string) => boolean): Map<string, string> {
  const latest = new Map<string, string>();
  for (const event of directCompletion.toolEvents) {
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
  return ["read", "grep", "find", "ls", "chalin_project_discovery", "chalin_project_snapshot"].includes(toolName);
}

function isPostFailureEvidenceTool(toolName: string, command: string | undefined): boolean {
  if (["read", "grep", "find", "ls", "chalin_project_discovery", "chalin_project_snapshot"].includes(toolName)) return true;
  return toolName === "bash" && !isVerificationCommand(command);
}

function recordPreMutationEvidenceTool(toolName: string): void {
  if (!["read", "grep", "find", "ls", "chalin_project_discovery", "chalin_project_snapshot"].includes(toolName)) return;
  directCompletion.evidenceToolCount += 1;
  if (["grep", "find", "ls", "chalin_project_discovery", "chalin_project_snapshot"].includes(toolName)) {
    directCompletion.searchToolCount += 1;
  }
  if (toolName === "read") {
    directCompletion.readToolCount += 1;
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
      directCompletion.deletedPaths.add(normalizeWorkflowPath(word));
    }
  }
}

function shouldNudgeDocsEvidenceLoop(): boolean {
  const reachedReadDeadline = directCompletion.docsWriteAfterReadCount > 0
    && directCompletion.readToolCount >= directCompletion.docsWriteAfterReadCount;
  return directCompletion.docsOnlyPathPrompt
    && !directCompletion.docsEvidenceLoopNudgeSent
    && !directCompletion.mutationObserved
    && (
      reachedReadDeadline
      ||
      (directCompletion.evidenceToolCount >= 4 && directCompletion.searchToolCount >= 1 && directCompletion.readToolCount >= 2)
      || (directCompletion.evidenceToolCount >= 5 && directCompletion.searchToolCount >= 3 && directCompletion.readToolCount >= 1)
    );
}

function shouldNudgeDocsPreWriteShell(): boolean {
  return directCompletion.docsOnlyPathPrompt
    && !directCompletion.docsPreWriteShellNudgeSent
    && !directCompletion.mutationObserved
    && directCompletion.docsPreMutationShellBudget > 0
    && directCompletion.docsPreMutationShellCount === 0
    && directCompletion.readToolCount >= 3;
}

function shouldAllowDocsPreMutationShell(command: string | undefined, isError: boolean | undefined): boolean {
  return !isError
    && directCompletion.docsPreMutationShellCount < directCompletion.docsPreMutationShellBudget
    && isDocsEvidenceCommand(command);
}

function docsWriteAfterReadCount(prompt: string): number {
  if (!promptLooksDocsOnly(prompt)) return 0;
  return promptLooksOperationalDocsArtifact(prompt) ? 3 : 0;
}

function docsEvidenceShellBudget(prompt: string): number {
  if (!promptLooksDocsOnly(prompt)) return 0;
  if (
    /\b(valida|validar|validate|verifica|verificar|verify|comprueba|check)\b/i.test(prompt)
    && /\b(bun|npm|pnpm|yarn|node|python|python3|go|cargo|make|test|check|diagn[oó]stic|diagnos|git\s+status)\b/i.test(prompt)
  ) return 1;
  if (/\b(ejecuta|corre|run)\b.{0,40}\b(bun|npm|pnpm|yarn|node|python|python3|go|cargo|make|git\s+status)\b/i.test(prompt)) return 1;
  return 0;
}

function isDocsEvidenceCommand(command: string | undefined): boolean {
  if (!command) return false;
  if (/\bgit\s+status\b/i.test(command)) return true;
  return /\b(bun|npm|pnpm|yarn|node|python|python3|go|cargo|make)\b/i.test(command)
    && /\b(test|check|assert|import|require|--test|-e)\b/i.test(command);
}

function shouldNudgeScaffoldEvidenceLoop(): boolean {
  return directCompletion.directModeKind === "scaffold-greenfield"
    && !directCompletion.scaffoldEvidenceLoopNudgeSent
    && !directCompletion.mutationObserved
    && directCompletion.evidenceToolCount >= 3
    && directCompletion.searchToolCount >= 1;
}

function shouldNudgeLocatorLoop(): boolean {
  return !directCompletion.docsOnlyPathPrompt
    && directCompletion.directModeKind !== "scaffold-greenfield"
    && !directCompletion.locatorLoopNudgeSent
    && !directCompletion.mutationObserved
    && (
      directCompletion.searchToolCount >= 3
      || (directCompletion.readToolCount >= 1 && directCompletion.searchToolCount >= 1)
    );
}

function shouldNudgeStatefulTimeDrift(toolName: string): boolean {
  if (directCompletion.directModeKind !== "stateful-time" || directCompletion.statefulTimeNudgeSent || directCompletion.verificationObserved) return false;
  if (!directCompletion.mutationObserved) {
    return directCompletion.searchToolCount >= 1 || directCompletion.readToolCount >= 3;
  }
  return ["read", "grep", "find", "ls"].includes(toolName);
}

function directDocsOnlyMutation(): boolean {
  return directCompletion.changedPaths.size > 0
    && !directCompletion.sourceMutationObserved
    && !directCompletion.testMutationObserved
    && [...directCompletion.changedPaths].every(isDocsMarkdownPath);
}

function sourceMutationWithoutTestMutation(): boolean {
  return directCompletion.sourceMutationObserved
    && !directCompletion.testMutationObserved
    && !directCompletion.testCoverageReviewObserved
    && !(directCompletion.directModeKind === "broken-test-triage" && [...directCompletion.readPaths].some(isTestLikePath));
}

function promptCanonicalSurfaceBypassed(): { expected: string; actual: string[] } | undefined {
  const expectedSources = [...directCompletion.promptCodePaths]
    .filter((path) => isCodeLikePath(path) && !isTestLikePath(path) && !isDocsMarkdownPath(path));
  if (expectedSources.length === 0) return undefined;
  const changedSources = [...directCompletion.changedPaths]
    .map(normalizeWorkflowPath)
    .filter((path) => !directCompletion.deletedPaths.has(path))
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
  const changedTests = [...directCompletion.changedPaths]
    .map(normalizeWorkflowPath)
    .filter((path) => !directCompletion.deletedPaths.has(path))
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
  return [...directCompletion.changedPaths]
    .map(normalizeWorkflowPath)
    .filter((path) => !directCompletion.deletedPaths.has(path))
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
  const relative = normalized.startsWith("./") ? normalized.slice(2) : normalized;
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
  return [...directCompletion.changedPaths].some((changedPath) => sameWorkflowPath(changedPath, value));
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
  const normalized = value.replaceAll("\\", "/");
  return normalized.startsWith("./") ? normalized.slice(2) : normalized;
}

function markOutOfWorkspaceMutation(value: string): boolean {
  if (!pathIsOutsideCurrentWorkspace(value)) return false;
  directCompletion.outOfWorkspaceMutationObserved = true;
  directCompletion.outOfWorkspaceMutationPath ??= value;
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
  const cwd = normalizeFilesystemPath(directCompletion.cwd);
  if (!cwd) return false;
  const target = normalizeFilesystemPath(value);
  if (!target) return false;
  if (target.startsWith("~/")) return true;
  if (!isAbsoluteFilesystemPath(target)) return false;
  return target !== cwd && !target.startsWith(`${cwd}/`);
}

function hasInWorkspaceMutation(): boolean {
  return [...directCompletion.changedPaths].some((changedPath) => !pathIsOutsideCurrentWorkspace(changedPath));
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
  const relative = normalized.startsWith("./") ? normalized.slice(2) : normalized;
  return relative.endsWith(".md");
}

function classifyDirectModeKind(prompt: string): DirectModeKind {
  if (promptLooksDocsOnly(prompt)) return "docs-only";
  if (promptLooksScaffoldGreenfield(prompt)) return "scaffold-greenfield";
  if (promptLooksStatefulTime(prompt)) return "stateful-time";
  if (promptLooksBrokenTestTriage(prompt)) return "broken-test-triage";
  if (promptLooksTestOnly(prompt)) return "test-only";
  if (promptLooksLeanBoundedCodeTest(prompt)) return "lean-bounded-code-test";
  if (promptLooksBoundedCodeTest(prompt)) return "bounded-code-test";
  return "generic";
}

function promptLooksStatefulTime(prompt: string): boolean {
  return promptRequestsShellVerification(prompt)
    && /\b(ttl|cache|clock|reloj|expiry|expire|expiration|expiraci[oó]n|time|timer|window|rate|limit|retry|backoff|budget|state|estado|refresh|renew|reset|caducidad|expira)\b/i.test(prompt);
}

function promptLooksDocsOnly(prompt: string): boolean {
  const paths = promptPathTokens(prompt);
  if (paths.length > 0 && paths.every(isDocsMarkdownPath)) return !promptRequestsShellVerification(prompt);
  return paths.some(isDocsMarkdownPath)
    && /\b(docs?|documentation|readme|runbook|adr|plan|no-code|sin c[oó]digo|solo docs|docs-only)\b/i.test(prompt)
    && !promptRequestsShellVerification(prompt)
    && !/\b(implement|fix|corrige|code|c[oó]digo|test|tests|unit|integration)\b/i.test(prompt);
}

function promptLooksOperationalDocsArtifact(prompt: string): boolean {
  return /\b(runbook|rollback|diagn[oó]stic|diagnos|diagnosticar|diagnose|troubleshoot|how to run|c[oó]mo ejecutar|ejecutar tests?|run tests?|smoke|operational|operativo)\b/i.test(prompt)
    && /\b(actualiza|update|docs?|documentation|runbook|sin c[oó]digo|no code|no cambies c[oó]digo)\b/i.test(prompt);
}

function promptLooksScaffoldGreenfield(prompt: string): boolean {
  return /\b(scaffold|greenfield|from scratch|new package|new cli|create (?:a )?(?:package|library|cli|tool)|(?:create|new|crea(?:r)?|nuevo|nueva).{0,40}\b(?:package|library|cli|tool|paquete|librer[ií]a|herramienta)|crea(?:r)? (?:un|una)? ?(?:paquete|librer[ií]a|cli|tool|herramienta))\b/i.test(prompt)
    && /\b(test|tests|readme|package|bin|exports?|runner|usage|uso|api|cli|library|librer[ií]a)\b/i.test(prompt);
}

function promptRequestsShellVerification(prompt: string): boolean {
  return /\b(cargo\s+test|bun\s+test|npm\s+(?:run\s+)?test|pnpm\s+(?:run\s+)?test|yarn\s+(?:run\s+)?test|make\s+(?:test|check)|go\s+test|pytest|vitest|jest|tsc\s+--noEmit|valida(?:r)? con|verify with|deja(?:r)? .{0,40} pasando)\b/i.test(prompt);
}

function promptLooksBrokenTestTriage(prompt: string): boolean {
  return promptRequestsShellVerification(prompt)
    && /\b(test|tests|failing|fallando|falla|triage)\b/i.test(prompt)
    && /\b(root cause|causa ra[ií]z|corrige|corrigela|corrígela|fix|arregla|deja(?:r)? .{0,30}pasando)\b/i.test(prompt)
    && /\b(no cambies|no modifiques|do not change|don't change|do not modify|don't modify).{0,60}\btest\b/i.test(prompt);
}

function promptLooksTestOnly(prompt: string): boolean {
  const paths = promptPathTokens(prompt);
  return paths.filter(isCodeLikePath).length === 1
    && /\b(test|tests|unitario|unitaria|unit|prueba|pruebas)\b/i.test(prompt)
    && /\b(add|a[ñn]ade|agrega|cover|cubre|cubrir)\b/i.test(prompt)
    && !/\b(implement|implementa|fix|corrige|arregla|refactor|refactoriza|change|cambia|modifica)\b/i.test(prompt);
}

function promptLooksBoundedCodeTest(prompt: string): boolean {
  const paths = promptPathTokens(prompt);
  return paths.filter(isCodeLikePath).length === 1
    && /\b(test|tests|unittest|node --test|bun test|cargo test|go test|pytest|make test)\b/i.test(prompt)
    && !/\b(project-wide|monorepo|multi-file|m[úu]ltiples archivos|architecture|arquitectura|migration|migraci[oó]n)\b/i.test(prompt);
}

function promptLooksLeanBoundedCodeTest(prompt: string): boolean {
  if (prompt.length > 700) return false;
  const paths = promptPathTokens(prompt).filter(isCodeLikePath);
  if (paths.length !== 1) return false;
  const path = paths[0] ?? "";
  const promptAndPath = `${prompt} ${path}`;
  return /(?:^|\/)packages\/[^/]+\/src\/[^/]+\.(?:ts|tsx|js|jsx|mjs|cjs)$/i.test(path)
    && /\b(test|tests|package-local|paquete|root|bun\s+test|node --test|npm\s+(?:run\s+)?test|pnpm\s+(?:run\s+)?test|yarn\s+(?:run\s+)?test)\b/i.test(promptAndPath)
    && /\b(implement|implementa|fix|corrige|arregla|update|actualiza|change|cambia|test|tests)\b/i.test(promptAndPath)
    && !/\b(project-wide|deep|profund|exhaustiv|architecture|arquitectura|migration|migraci[oó]n|security|seguridad|auth|authorization|parser|scanner|tokenizer|state machine|cross[- ]?language|multi[- ]?language)\b/i.test(promptAndPath);
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
  if (["npm", "pnpm", "yarn", "bun"].includes(commandName)) {
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
