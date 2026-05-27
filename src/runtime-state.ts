import type { RouteDecision, RunState } from "./schemas.ts";

let lastRun: RunState | undefined;
const liveStepSessions = new Map<string, LiveStepSessionRef>();
let routeInvocations: ChalinRouteInvocation[] = [];
let directCompletion: DirectCompletionState = freshDirectCompletionState();

export type ChalinRouteOutcome = "dry-run" | "ask" | "block" | "failed" | "paused" | "complete";

interface ChalinRouteInvocation {
  id: number;
  dryRun: boolean;
  route?: Pick<RouteDecision, "kind" | "agents" | "risk">;
  outcome?: ChalinRouteOutcome;
}

interface DirectCompletionState {
  docsOnlyPathPrompt: boolean;
  mutationObserved: boolean;
  sourceMutationObserved: boolean;
  testMutationObserved: boolean;
  changedPaths: Set<string>;
  readPaths: Set<string>;
  mutationToolCount: number;
  evidenceToolCount: number;
  searchToolCount: number;
  readToolCount: number;
  verificationAttemptCount: number;
  testCoverageNudgeSent: boolean;
  testCoverageReviewObserved: boolean;
  verificationObserved: boolean;
  verificationCommand?: string;
  progressNudgeSent: boolean;
  readyToVerifyNudgeSent: boolean;
  failedVerificationNudgeSent: boolean;
  locatorLoopNudgeSent: boolean;
  docsShellNudgeSent: boolean;
  docsPostWriteShellNudgeSent: boolean;
  postVerificationShellNudgeSent: boolean;
  postVerificationExplorationNudgeSent: boolean;
  readbackStopNudgeSent: boolean;
  docsEvidenceLoopNudgeSent: boolean;
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

export function setLatestRun(run: RunState | undefined): void {
  lastRun = run;
}

export function getLatestRun(): RunState | undefined {
  return lastRun;
}

export function getActiveRun(): RunState | undefined {
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

export function beginChalinTurn(options: { prompt?: string } = {}): void {
  routeInvocations = [];
  directCompletion = freshDirectCompletionState();
  directCompletion.docsOnlyPathPrompt = promptHasOnlyDocsPaths(options.prompt ?? "");
}

export function recordDirectToolCompletion(options: { toolName: string; isError?: boolean; command?: string; path?: string; argsText?: string }): { shouldProgressNudge: boolean; shouldReadyToVerifyNudge: boolean; shouldFailureNudge: boolean; shouldCompletionNudge: boolean; shouldTestCoverageNudge: boolean; shouldDocsShellNudge: boolean; shouldPostVerificationShellNudge: boolean; shouldPostVerificationExplorationNudge: boolean; shouldDocsEvidenceLoopNudge: boolean; shouldLocatorLoopNudge: boolean; shouldExistingFileRewriteNudge: boolean; shouldMutationLoopNudge: boolean; shouldSourceAndTestReadyNudge: boolean; shouldVerificationLoopNudge: boolean; shouldPostFailureEvidenceNudge: boolean; verificationCommand?: string; docsOnlyMutation: boolean } {
  let shouldProgressNudge = false;
  let shouldDocsShellNudge = false;
  let shouldPostVerificationShellNudge = false;
  let shouldPostVerificationExplorationNudge = false;
  let shouldDocsEvidenceLoopNudge = false;
  let shouldLocatorLoopNudge = false;
  let shouldExistingFileRewriteNudge = false;
  let shouldMutationLoopNudge = false;
  let shouldSourceAndTestReadyNudge = false;
  let shouldVerificationLoopNudge = false;
  let shouldPostFailureEvidenceNudge = false;
  let justMutated = false;
  let staleVerificationReset = false;
  const coverageReviewWasRequested = directCompletion.testCoverageNudgeSent;
  if (!directCompletion.mutationObserved && !options.isError) {
    recordPreMutationEvidenceTool(options.toolName);
    if (shouldNudgeDocsEvidenceLoop()) {
      shouldDocsEvidenceLoopNudge = true;
      directCompletion.docsEvidenceLoopNudgeSent = true;
    }
    if (shouldNudgeLocatorLoop()) {
      shouldLocatorLoopNudge = true;
      directCompletion.locatorLoopNudgeSent = true;
    }
  }
  if (options.toolName === "read" && options.path && !options.isError) {
    directCompletion.readPaths.add(normalizeWorkflowPath(options.path));
  }
  if (options.toolName === "edit" || options.toolName === "write") {
    if (options.isError) return { shouldProgressNudge: false, shouldReadyToVerifyNudge: false, shouldFailureNudge: false, shouldCompletionNudge: false, shouldTestCoverageNudge: false, shouldDocsShellNudge, shouldPostVerificationShellNudge, shouldPostVerificationExplorationNudge, shouldDocsEvidenceLoopNudge, shouldLocatorLoopNudge, shouldExistingFileRewriteNudge, shouldMutationLoopNudge, shouldSourceAndTestReadyNudge, shouldVerificationLoopNudge, shouldPostFailureEvidenceNudge, docsOnlyMutation: directDocsOnlyMutation() };
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
      } else if (!isDocsMarkdownPath(changedPath)) {
        directCompletion.sourceMutationObserved = true;
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
      directCompletion.nudgeSent = false;
    }
    if (
      !directCompletion.sourceAndTestReadyNudgeSent
      && !directCompletion.verificationObserved
      && directCompletion.sourceMutationObserved
      && directCompletion.testMutationObserved
      && directCompletion.mutationToolCount >= 2
    ) {
      shouldSourceAndTestReadyNudge = true;
      directCompletion.sourceAndTestReadyNudgeSent = true;
    }
    shouldProgressNudge = !directCompletion.progressNudgeSent;
    if (shouldProgressNudge) directCompletion.progressNudgeSent = true;
  }
  let shouldFailureNudge = false;
  const docsOnlyMutation = directDocsOnlyMutation();
  if (options.toolName === "read" && options.path && directCompletion.testCoverageNudgeSent && isCoverageReviewPath(options.path) && !options.isError) {
    directCompletion.testCoverageReviewObserved = true;
  }
  if (options.toolName === "bash" && directCompletion.docsOnlyPathPrompt) {
    if (docsOnlyMutation) {
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
    if (options.isError) {
      shouldFailureNudge = !directCompletion.failedVerificationNudgeSent;
      if (shouldFailureNudge) directCompletion.failedVerificationNudgeSent = true;
      if (!directCompletion.verificationLoopNudgeSent && directCompletion.verificationAttemptCount >= 2) {
        shouldVerificationLoopNudge = true;
        directCompletion.verificationLoopNudgeSent = true;
      }
    } else {
      directCompletion.verificationObserved = true;
      if (!directCompletion.verificationLoopNudgeSent && directCompletion.verificationAttemptCount >= 3) {
        shouldVerificationLoopNudge = true;
        directCompletion.verificationLoopNudgeSent = true;
      }
    }
  } else if (options.toolName === "bash" && directCompletion.mutationObserved && options.isError) {
    shouldFailureNudge = !directCompletion.failedVerificationNudgeSent;
    if (shouldFailureNudge) directCompletion.failedVerificationNudgeSent = true;
  } else if (options.isError) {
    return { shouldProgressNudge, shouldReadyToVerifyNudge: false, shouldFailureNudge: false, shouldCompletionNudge: false, shouldTestCoverageNudge: false, shouldDocsShellNudge, shouldPostVerificationShellNudge, shouldPostVerificationExplorationNudge, shouldDocsEvidenceLoopNudge, shouldLocatorLoopNudge, shouldExistingFileRewriteNudge, shouldMutationLoopNudge, shouldSourceAndTestReadyNudge, shouldVerificationLoopNudge, shouldPostFailureEvidenceNudge, verificationCommand: directCompletion.verificationCommand, docsOnlyMutation };
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
  const needsTestCoverageReview = directCompletion.verificationObserved
    && sourceMutationWithoutTestMutation();
  const shouldTestCoverageNudge = needsTestCoverageReview && !directCompletion.testCoverageNudgeSent;
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
    && !directCompletion.nudgeSent;
  if (
    !shouldCompletionNudge
    && changedPathReadbackObserved
    && directCompletion.mutationObserved
    && directCompletion.verificationObserved
    && !needsTestCoverageReview
    && !directDocsOnlyMutation()
    && !directCompletion.readbackStopNudgeSent
  ) {
    shouldCompletionNudge = true;
    directCompletion.readbackStopNudgeSent = true;
  }
  if (shouldCompletionNudge) directCompletion.nudgeSent = true;
  return { shouldProgressNudge, shouldReadyToVerifyNudge, shouldFailureNudge, shouldCompletionNudge, shouldTestCoverageNudge, shouldDocsShellNudge, shouldPostVerificationShellNudge, shouldPostVerificationExplorationNudge, shouldDocsEvidenceLoopNudge, shouldLocatorLoopNudge, shouldExistingFileRewriteNudge, shouldMutationLoopNudge, shouldSourceAndTestReadyNudge, shouldVerificationLoopNudge, shouldPostFailureEvidenceNudge, verificationCommand: directCompletion.verificationCommand, docsOnlyMutation };
}

export function getDirectChangedPaths(): string[] {
  return [...directCompletion.changedPaths].sort((left, right) => normalizeWorkflowPath(left).localeCompare(normalizeWorkflowPath(right)));
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
  lastRun = undefined;
  liveStepSessions.clear();
  routeInvocations = [];
  directCompletion = freshDirectCompletionState();
}

function liveStepKey(runId: string, stepId: string): string {
  return `${runId}:${stepId}`;
}

function freshDirectCompletionState(): DirectCompletionState {
  return {
    docsOnlyPathPrompt: false,
    mutationObserved: false,
    sourceMutationObserved: false,
    testMutationObserved: false,
    changedPaths: new Set(),
    readPaths: new Set(),
    mutationToolCount: 0,
    evidenceToolCount: 0,
    searchToolCount: 0,
    readToolCount: 0,
    verificationAttemptCount: 0,
    testCoverageNudgeSent: false,
    testCoverageReviewObserved: false,
    verificationObserved: false,
    verificationCommand: undefined,
    progressNudgeSent: false,
    readyToVerifyNudgeSent: false,
    failedVerificationNudgeSent: false,
    locatorLoopNudgeSent: false,
    docsShellNudgeSent: false,
    docsPostWriteShellNudgeSent: false,
    postVerificationShellNudgeSent: false,
    postVerificationExplorationNudgeSent: false,
    readbackStopNudgeSent: false,
    docsEvidenceLoopNudgeSent: false,
    existingFileRewriteNudgeSent: false,
    mutationLoopNudgeSent: false,
    sourceAndTestReadyNudgeSent: false,
    verificationLoopNudgeSent: false,
    postFailureEvidenceToolCount: 0,
    postFailureEvidenceNudgeSent: false,
    nudgeSent: false,
  };
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

function shouldNudgeDocsEvidenceLoop(): boolean {
  return directCompletion.docsOnlyPathPrompt
    && !directCompletion.docsEvidenceLoopNudgeSent
    && !directCompletion.mutationObserved
    && (
      (directCompletion.evidenceToolCount >= 4 && directCompletion.searchToolCount >= 1 && directCompletion.readToolCount >= 2)
      || (directCompletion.evidenceToolCount >= 5 && directCompletion.searchToolCount >= 3 && directCompletion.readToolCount >= 1)
    );
}

function shouldNudgeLocatorLoop(): boolean {
  return !directCompletion.docsOnlyPathPrompt
    && !directCompletion.locatorLoopNudgeSent
    && !directCompletion.mutationObserved
    && (
      directCompletion.searchToolCount >= 3
      || (directCompletion.readToolCount >= 1 && directCompletion.searchToolCount >= 1)
    );
}

function directDocsOnlyMutation(): boolean {
  return directCompletion.changedPaths.size > 0
    && !directCompletion.sourceMutationObserved
    && !directCompletion.testMutationObserved
    && [...directCompletion.changedPaths].every(isDocsMarkdownPath);
}

function sourceMutationWithoutTestMutation(): boolean {
  return directCompletion.sourceMutationObserved && !directCompletion.testMutationObserved && !directCompletion.testCoverageReviewObserved;
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

function isDocsMarkdownPath(value: string): boolean {
  const normalized = value.replaceAll("\\", "/");
  const relative = normalized.startsWith("./") ? normalized.slice(2) : normalized;
  return relative.startsWith("docs/") && relative.endsWith(".md");
}

function promptHasOnlyDocsPaths(prompt: string): boolean {
  const paths = splitWhitespace(prompt)
    .map((token) => trimTokenPunctuation(token))
    .filter((token) => token.includes("/") && token.includes("."));
  return paths.length > 0 && paths.every(isDocsMarkdownPath);
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
