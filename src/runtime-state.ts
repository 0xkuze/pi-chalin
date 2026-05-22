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
  prompt: string;
  mutationObserved: boolean;
  testMutationObserved: boolean;
  verificationObserved: boolean;
  verificationCommand?: string;
  progressNudgeSent: boolean;
  readyToVerifyNudgeSent: boolean;
  failedVerificationNudgeSent: boolean;
  missingTestNudgeSent: boolean;
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
  directCompletion.prompt = options.prompt ?? "";
}

export function recordDirectToolCompletion(options: { toolName: string; isError?: boolean; command?: string; argsText?: string }): { shouldProgressNudge: boolean; shouldReadyToVerifyNudge: boolean; shouldFailureNudge: boolean; shouldMissingTestNudge: boolean; shouldCompletionNudge: boolean; verificationCommand?: string } {
  let shouldProgressNudge = false;
  if (options.toolName === "edit" || options.toolName === "write") {
    if (options.isError) return { shouldProgressNudge: false, shouldReadyToVerifyNudge: false, shouldFailureNudge: false, shouldMissingTestNudge: false, shouldCompletionNudge: false };
    directCompletion.mutationObserved = true;
    if (directCompletion.verificationObserved || directCompletion.verificationCommand || directCompletion.failedVerificationNudgeSent || directCompletion.nudgeSent) {
      directCompletion.verificationObserved = false;
      directCompletion.verificationCommand = undefined;
      directCompletion.readyToVerifyNudgeSent = false;
      directCompletion.failedVerificationNudgeSent = false;
      directCompletion.missingTestNudgeSent = false;
      directCompletion.nudgeSent = false;
    }
    if (isTestMutation(options.argsText)) directCompletion.testMutationObserved = true;
    shouldProgressNudge = !directCompletion.progressNudgeSent;
    if (shouldProgressNudge) directCompletion.progressNudgeSent = true;
  }
  let shouldFailureNudge = false;
  if (options.toolName === "bash" && directCompletion.mutationObserved && isVerificationCommand(options.command)) {
    directCompletion.verificationCommand = options.command?.trim();
    if (options.isError) {
      shouldFailureNudge = !directCompletion.failedVerificationNudgeSent;
      if (shouldFailureNudge) directCompletion.failedVerificationNudgeSent = true;
    } else {
      directCompletion.verificationObserved = true;
    }
  } else if (options.isError) {
    return { shouldProgressNudge, shouldReadyToVerifyNudge: false, shouldFailureNudge: false, shouldMissingTestNudge: false, shouldCompletionNudge: false, verificationCommand: directCompletion.verificationCommand };
  }
  const shouldReadyToVerifyNudge = directCompletion.mutationObserved
    && !directCompletion.verificationObserved
    && !directCompletion.readyToVerifyNudgeSent
    && (!taskRequiresTests(directCompletion.prompt) || directCompletion.testMutationObserved);
  if (shouldReadyToVerifyNudge) directCompletion.readyToVerifyNudgeSent = true;
  const shouldMissingTestNudge = directCompletion.mutationObserved
    && directCompletion.verificationObserved
    && taskRequiresTests(directCompletion.prompt)
    && !directCompletion.testMutationObserved
    && !directCompletion.missingTestNudgeSent;
  if (shouldMissingTestNudge) directCompletion.missingTestNudgeSent = true;
  const shouldCompletionNudge = directCompletion.mutationObserved
    && directCompletion.verificationObserved
    && !shouldMissingTestNudge
    && !(taskRequiresTests(directCompletion.prompt) && !directCompletion.testMutationObserved)
    && !directCompletion.nudgeSent;
  if (shouldCompletionNudge) directCompletion.nudgeSent = true;
  return { shouldProgressNudge, shouldReadyToVerifyNudge, shouldFailureNudge, shouldMissingTestNudge, shouldCompletionNudge, verificationCommand: directCompletion.verificationCommand };
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
  return { prompt: "", mutationObserved: false, testMutationObserved: false, verificationObserved: false, verificationCommand: undefined, progressNudgeSent: false, readyToVerifyNudgeSent: false, failedVerificationNudgeSent: false, missingTestNudgeSent: false, nudgeSent: false };
}

function isVerificationCommand(command: string | undefined): boolean {
  if (!command) return false;
  return /\b(npm|pnpm|yarn|bun)\s+(test|run\s+(test|typecheck|lint|check)|exec\s+(vitest|jest|tsc|eslint))\b/i.test(command)
    || /\b(node\s+.*--test|python3?\s+-m\s+unittest(?:\s+discover)?|go\s+test|cargo\s+test|pytest|vitest|jest|tsc\s+--noEmit|eslint)\b/i.test(command);
}

function taskRequiresTests(prompt: string): boolean {
  return /\b(test|tests|prueba|pruebas|spec|specs|coverage|cobertura)\b/i.test(prompt);
}

function isTestMutation(argsText: string | undefined): boolean {
  return Boolean(argsText && /\b(test|tests|spec|__tests__)\/|\.test\.|\.spec\./i.test(argsText));
}
