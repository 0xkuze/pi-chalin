import type { RouteDecision, RunState } from "./schemas.ts";

let lastRun: RunState | undefined;
let routeInvocations: MeshRouteInvocation[] = [];
let directCompletion: DirectCompletionState = freshDirectCompletionState();

export type MeshRouteOutcome = "dry-run" | "ask" | "block" | "failed" | "paused" | "complete";

interface MeshRouteInvocation {
  id: number;
  dryRun: boolean;
  route?: Pick<RouteDecision, "kind" | "agents" | "risk">;
  outcome?: MeshRouteOutcome;
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

export function setLatestRun(run: RunState | undefined): void {
  lastRun = run;
}

export function getLatestRun(): RunState | undefined {
  return lastRun;
}

export function getActiveRun(): RunState | undefined {
  return lastRun?.status === "running" ? lastRun : undefined;
}

export function beginMeshTurn(options: { prompt?: string } = {}): void {
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

export function beginMeshRouteInvocation(options: { dryRun: boolean; route: RouteDecision }): { allowed: boolean; reason?: string; invocationId?: number } {
  const committed = routeInvocations.find((call) => call.outcome === "complete" || call.outcome === "paused");
  if (!options.dryRun && committed) {
    return {
      allowed: false,
      reason: "mesh_route already executed for this user prompt. Synthesize the existing result instead of launching another mesh workflow. A second call is allowed only after dryRun, ask, block, or failed outcomes.",
    };
  }

  const invocation: MeshRouteInvocation = {
    id: routeInvocations.length + 1,
    dryRun: options.dryRun,
    route: { kind: options.route.kind, agents: options.route.agents, risk: options.route.risk },
  };
  routeInvocations.push(invocation);
  return { allowed: true, invocationId: invocation.id };
}

export function finishMeshRouteInvocation(invocationId: number | undefined, outcome: MeshRouteOutcome): void {
  if (invocationId === undefined) return;
  const invocation = routeInvocations.find((call) => call.id === invocationId);
  if (invocation) invocation.outcome = outcome;
}

export function getMeshRouteInvocations(): readonly MeshRouteInvocation[] {
  return routeInvocations;
}

export function resetRuntimeState(): void {
  lastRun = undefined;
  routeInvocations = [];
  directCompletion = freshDirectCompletionState();
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
