import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Effect } from "effect";
import { AgentCatalog } from "../agents/agents.ts";
import { loadEffectiveConfig } from "../config/config.ts";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { buildChalinOrchestratorSystemPrompt } from "../orchestration/orchestration.ts";
import { chalinSessionIdFromContext, isUsableStepHandoff, loadResumableRunState } from "../runner/runner-state.ts";
import { buildCompletionGateContextMessage, buildCompletionGateSteer, completionGateDecisionKey, type CompletionGateDecision } from "../runtime/completion-gate.ts";
import { compactEvidenceObservation } from "../runtime/evidence-ledger.ts";
import { beginChalinTurn, getInlineChangedPaths, getInlineCompletionGatePayload, getInlineCriticalGuardContextMessage, isSemanticPolicyJudgeRequestFresh, recordCompletionGateBlock, recordInlineToolCompletion, recordInlineToolStart, recordSemanticPolicyJudgeResult } from "../runtime/state.ts";
import { runCompletionGateJudge, shouldApplyCompletionGateDecision, type CompletionGateJudgeInput } from "../skills/completion-gate-judge.ts";
import { formatSemanticPolicyJudgeSteer, runSemanticPolicyJudge, shouldApplySemanticPolicyJudgeResult } from "../skills/semantic-policy-judge.ts";
import type { InlineNudgeKind, PolicyJudgeDecision } from "../runtime/state.ts";
import type { RunState } from "../domain/schemas.ts";
import { setChalinStatus } from "../ui/ui-status.ts";
import { isRecord } from "../utils/guards.ts";

type PendingToolArgs = {
  command?: string;
  path?: string;
  argsText?: string;
};

type PendingHumanInputBlock = {
  prompt: string;
  questions: string[];
  reason?: string;
  createdAt: number;
};

const pendingToolStarts = new WeakMap<object, Map<string, PendingToolArgs[]>>();
const pendingHumanInputBlocks = new WeakMap<object, PendingHumanInputBlock>();
type PiThinkingLevel = ReturnType<ExtensionAPI["getThinkingLevel"]>;
const orchestratorThinkingRestore = new WeakMap<object, PiThinkingLevel>();
const completionGateEnabledForTurn = new WeakMap<object, boolean>();
const completionGateFollowupKeys = new WeakMap<object, Set<string>>();
const completionGateContextCache = new WeakMap<object, CompletionGateJudgeInput["context"]>();
const semanticPolicyJudgeControllers = new WeakMap<object, Set<AbortController>>();
type CompletionGateJudgeRunner = (input: CompletionGateJudgeInput) => Promise<CompletionGateDecision | undefined>;
type SemanticPolicyJudgeRunner = typeof runSemanticPolicyJudge;
let completionGateJudgeForTests: CompletionGateJudgeRunner | undefined;
let semanticPolicyJudgeForTests: SemanticPolicyJudgeRunner | undefined;

function runHookEffect<A>(span: string, run: () => A | Promise<A>): Promise<A> {
  return Effect.runPromise(Effect.tryPromise({ try: async () => run(), catch: (error) => error }).pipe(Effect.withSpan(span)));
}

export function registerChalinAutoRouter(pi: ExtensionAPI): void {
  pi.on("input", (event, ctx) => Effect.runPromise(inputGuardEffect(event, ctx)));

  pi.on("before_agent_start", (event, ctx) => runHookEffect("autoroute.beforeAgentStart", async () => {
    abortSemanticPolicyJudges(pi);
    clearCompletionGateFollowups(pi);
    clearCompletionGateJudgeContext(pi);
    const loaded = loadEffectiveConfig({ cwd: ctx.cwd });
    if (!loaded.config.enabled) {
      setCompletionGateEnabledForTurn(pi, false);
      return;
    }
    setCompletionGateEnabledForTurn(pi, true);
    rememberCompletionGateJudgeContext(pi, ctx);
    const promptText = typeof event.prompt === "string" ? event.prompt : "";
    beginChalinTurn({ prompt: promptText, cwd: ctx.cwd });
    const catalog = AgentCatalog.load({ cwd: ctx.cwd });
    const sessionId = chalinSessionIdFromContext(ctx);
    const resumableRun = sessionId ? loadResumableRunState({ cwd: ctx.cwd, recoverStale: false, sessionId }) : undefined;
    const resumeContext = resumableRun ? compactResumeCandidateMessage(resumableRun) : undefined;
    const systemPrompt = [
      event.systemPrompt,
      buildChalinOrchestratorSystemPrompt(catalog.list()),
    ].filter((part): part is string => typeof part === "string" && part.trim().length > 0).join("\n\n");
    return {
      systemPrompt,
      message: resumeContext ? {
        customType: "pi-chalin-orchestration",
        content: resumeContext,
        display: false,
      } : undefined,
    };
  }));

  pi.on("before_provider_request", (event) => {
    const block = currentHumanInputBlock(pi);
    if (!block) return event.payload;
    return suppressProviderToolsForHumanInput(event.payload);
  });

  pi.on("context", (event) => {
    const messages = [...event.messages];
    if (isCompletionGateEnabledForTurn(pi) && !hasCustomMessage(messages, "pi-chalin-completion-gate")) {
      messages.push({
        role: "custom",
        customType: "pi-chalin-completion-gate",
        content: buildCompletionGateContextMessage(),
        display: false,
        timestamp: Date.now(),
      });
    }
    const criticalGuard = getInlineCriticalGuardContextMessage();
    if (criticalGuard && !hasCustomMessage(messages, "pi-chalin-inline-critical-guard")) {
      messages.push({
        role: "custom",
        customType: "pi-chalin-inline-critical-guard",
        content: criticalGuard,
        display: false,
        timestamp: Date.now(),
      });
    }
    if (messages.length === event.messages.length) return;
    return {
      messages,
    };
  });

  pi.on("message_end", (event, ctx) => runCompletionGateMessageEnd(pi, event, ctx));

  pi.on("agent_end", (_event, ctx) => {
    clearPendingToolStarts(pi);
    clearPendingHumanInputBlock(pi);
    abortSemanticPolicyJudges(pi);
    restoreOrchestratorThinking(pi);
    setChalinStatus(ctx, { kind: "idle" });
  });

  pi.on("tool_execution_start", (event) => {
    const startedArgs = rememberToolStart(pi, event);
    const toolName = (event as { toolName?: unknown }).toolName;
    if (typeof toolName === "string" && toolName) {
      const block = currentHumanInputBlock(pi);
      if (block) {
        pi.sendMessage({
          customType: "pi-chalin-human-input-tool-stop",
          content: [
            "Hard stop: an internal workflow already found that a human decision blocks safe progress.",
            "Do not call tools, inspect files, or modify the workspace. Ask the pending question(s) and wait for the user.",
            ...block.questions.map((question) => `- ${question}`),
          ].join("\n"),
          display: false,
        }, { triggerTurn: false, deliverAs: "steer" });
      }
      restoreOrchestratorThinking(pi);
      recordInlineToolStart({
        toolName,
        command: startedArgs?.command,
        path: startedArgs?.path,
        argsText: startedArgs?.argsText,
      });
    }
  });

  pi.on("tool_execution_end", (event, ctx) => {
    rememberCompletionGateJudgeContext(pi, ctx);
    if (event.toolName === "chalin_route" || event.toolName === "chalin_resume") {
      if (event.isError) return;
      const blockedReason = workflowBlockedReason(event);
      if (blockedReason) {
        pi.sendMessage({
          customType: "pi-chalin-route-blocked-nudge",
          content: `${event.toolName} did not execute work (${blockedReason}). Do not claim completion from that result. If the user's request is safe and bounded, continue in the primary thread with normal tools; otherwise explain the blocker.`,
          display: false,
        }, { triggerTurn: false, deliverAs: "steer" });
        return;
      }
      const delegatedPendingReason = delegatedMutableWorkPendingReason(event);
      if (delegatedPendingReason) {
        pi.sendMessage({
          customType: "pi-chalin-delegated-work-pending-nudge",
          content: [
            `${event.toolName} returned a paused delegated run with pending delegated workspace mutation (${delegatedPendingReason}).`,
            "Do not continue this delegated implementation inline with normal edit/write/bash tools.",
            "Ask pending human questions when present, then use chalin_resume for the same run. If resume cannot make progress, report the concrete harness blocker instead of bypassing the run.",
          ].join("\n"),
          display: false,
        }, { triggerTurn: false, deliverAs: "steer" });
        return;
      }
      pi.sendMessage({
        customType: "pi-chalin-synthesis-nudge",
        content: [
          `${event.toolName} finished. Answer the user's original prompt from the Final answer material in the tool result after the completion gate passes.`,
          "Do not call another tool unless that material explicitly names a critical blocking gap or the completion gate finds missing evidence.",
          buildCompletionGateSteer("route"),
        ].join("\n"),
        display: false,
      }, { triggerTurn: false, deliverAs: "steer" });
      scheduleNonInteractiveShutdown(ctx);
      return;
    }

    const eventArgs = (event as { args?: { command?: unknown; path?: unknown } }).args;
    const eventResult = (event as { result?: unknown }).result;
    const fallbackArgs = takeToolStart(pi, event.toolName);
    const { shouldProgressNudge, shouldReadyToVerifyNudge, shouldFailureNudge, shouldCompletionNudge, shouldTestCoverageNudge, shouldWeakTestCoverageNudge, shouldPackageMetadataNudge, shouldParallelSurfaceNudge, shouldWorkspaceBoundaryNudge, shouldDocsShellNudge, shouldTerminalCompletionNudge, shouldPostTerminalDriftNudge, shouldPostVerificationShellNudge, shouldPostVerificationExplorationNudge, shouldLocatorLoopNudge, shouldExistingFileRewriteNudge, shouldMutationLoopNudge, shouldSourceAndTestReadyNudge, shouldVerificationLoopNudge, shouldPostFailureEvidenceNudge, verificationCommand, docsOnlyMutation, policyJudge } = recordInlineToolCompletion({
      toolName: event.toolName,
      isError: event.isError,
      command: typeof eventArgs?.command === "string" ? eventArgs.command : fallbackArgs?.command,
      path: typeof eventArgs?.path === "string" ? eventArgs.path : fallbackArgs?.path,
      argsText: eventArgs ? JSON.stringify(eventArgs) : fallbackArgs?.argsText,
      observation: toolResultObservation(eventResult),
    });
    const semanticReviewScheduled = scheduleSemanticPolicyJudge(pi, ctx, policyJudge);
    const deferToSemantic = (kind: InlineNudgeKind): boolean => shouldDeferInlineNudgeToSemantic(policyJudge, kind, semanticReviewScheduled);
    if (shouldWorkspaceBoundaryNudge) {
      pi.sendMessage({
        customType: "pi-chalin-inline-workspace-boundary-nudge",
        content: "Hard stop: inline project work escaped the current workspace root. Do not write or verify in a home/sibling/tmp directory unless the user explicitly provided that absolute target. Recreate the required files under the current cwd using relative paths such as `package.json`, `src/...`, `test/...`, and `README.md`, then run verification from the current cwd. A final answer is invalid until the current workspace contains the delivered source, tests, docs, and manifest.",
        display: false,
      }, { triggerTurn: false, deliverAs: "steer" });
    }
    if (shouldLocatorLoopNudge && !deferToSemantic("locator-loop")) {
      pi.sendMessage({
        customType: "pi-chalin-inline-locator-loop-nudge",
        content: "You already have target read/search evidence before changing files. If the prompt names an exact path, after reading it, ls/find/grep variants are usually waste: edit the named file plus one nearby test/config path, or report the exact blocker. Stop trying locator variants: pick the highest-confidence source/test candidates from current output, read only a missing candidate if needed, then edit or report the exact blocker. Run another search only if the candidate read proves the symbol/API is absent.",
        display: false,
      }, { triggerTurn: false, deliverAs: "steer" });
    }
    if (shouldExistingFileRewriteNudge) {
      pi.sendMessage({
        customType: "pi-chalin-inline-existing-file-write-nudge",
        content: "You used write on an existing file already read this turn. Treat existing files as patch targets: keep unrelated sections byte-stable, prefer edit for follow-up changes, and read back the changed file before verification. If a full rewrite was necessary, final Notes must name the concrete reason.",
        display: false,
      }, { triggerTurn: false, deliverAs: "steer" });
    }
    if (shouldMutationLoopNudge) {
      pi.sendMessage({
        customType: "pi-chalin-inline-mutation-loop-nudge",
        content: "Several edits/writes happened before a passing verification. Stop rewriting whole files. Reuse the current changed files and last tool output, patch the smallest root-cause block, then run the nearest verification once. If you already have a later passing verification after the latest edit, final now instead of rerunning it. If the issue is data structure capacity, prefer resizing or explicit error handling over fixed caps or silent drops.",
        display: false,
      }, { triggerTurn: false, deliverAs: "steer" });
    }
    if (shouldSourceAndTestReadyNudge && !deferToSemantic("source-and-test-ready")) {
      pi.sendMessage({
        customType: "pi-chalin-inline-source-test-ready-nudge",
        content: "Source and tests changed. Run the nearest meaningful repo evidence now. Before bash, use LLM judgment: changed behavior, one meaningful boundary or preservation path, runner-compatible tests, and requested docs/package metadata must already be present when relevant. If coverage is only smoke/no-op, edit it first. If evidence fails, patch the concrete root cause and rerun once; if it passes, final after the completion gate.",
        display: false,
      }, { triggerTurn: false, deliverAs: "steer" });
    }
    if (shouldVerificationLoopNudge && !deferToSemantic("verification-loop")) {
      pi.sendMessage({
        customType: "pi-chalin-inline-verification-loop-nudge",
        content: "Evidence is looping. Do not run another check until one focused edit addresses the latest failure. If the latest evidence already covers the request, final after the completion gate.",
        display: false,
      }, { triggerTurn: false, deliverAs: "steer" });
    }
    if (shouldPostFailureEvidenceNudge && !deferToSemantic("post-failure-evidence")) {
      pi.sendMessage({
        customType: "pi-chalin-inline-post-failure-evidence-nudge",
        content: [
          "Evidence debt is still open: a post-mutation verification or shell check failed earlier.",
          "Do NOT final from narrower helper, parser, static, or diagnostic evidence unless it covers the same user-facing acceptance surface that failed or the user requested.",
          "Use LLM judgment over the failed output, changed code, and latest evidence. If the failure is behavioral, patch the smallest plausible root cause and run representative evidence for the requested behavior. If the failure is environment/tooling/config/dependency related, preserve the latest plausible implementation hypothesis, seek direct representative evidence or a faithful surrogate, and report the unresolved blocker instead of completion if that evidence cannot run.",
        ].join("\n"),
        display: false,
      }, { triggerTurn: false, deliverAs: "steer" });
    }
    if (shouldDocsShellNudge && !deferToSemantic("docs-shell")) {
      pi.sendMessage({
        customType: "pi-chalin-docs-only-shell-nudge",
        content: "This prompt names only docs artifacts. Stop running shell verification or build/test discovery. Gather minimal evidence before the docs write/edit; after the write, only read the updated docs artifact and answer. Document searched/not-found gaps instead of chasing more tools. Do not include failed/disallowed shell commands as final Verification.",
        display: false,
      }, { triggerTurn: false, deliverAs: "steer" });
    }
    if (shouldTerminalCompletionNudge) {
      pi.sendMessage({
        customType: "pi-chalin-terminal-completion-nudge",
        content: [
          "The requested external workflow completed successfully.",
          "Run the completion gate. If it passes, final now. Do not call tools, rewrite PR body files, rerun support commands, or keep polishing local artifacts.",
          "Use the user's language and give a compact receipt with the PR/action result, verification already run, and any important notes.",
          buildCompletionGateSteer("terminal"),
        ].join("\n"),
        display: false,
      }, { triggerTurn: false, deliverAs: "steer" });
    }
    if (shouldPostTerminalDriftNudge) {
      pi.sendMessage({
        customType: "pi-chalin-post-terminal-drift-nudge",
        content: [
          "Hard stop: a terminal external action already completed for this user request.",
          "Do not mutate or rewrite support artifacts such as PR body files after the PR/action is already created.",
          "Your next assistant action must be the final answer; include the completed PR/action and the verification already performed.",
        ].join("\n"),
        display: false,
      }, { triggerTurn: false, deliverAs: "steer" });
    }
    if (shouldPostVerificationShellNudge && !deferToSemantic("post-verification-shell")) {
      pi.sendMessage({
        customType: "pi-chalin-post-verification-shell-nudge",
        content: [
          "Post-mutation evidence already ran and no later edit was observed. Stop running shell commands just to gain confidence; final after the completion gate passes. If this command exposed a concrete defect, edit that root cause and rerun the nearest meaningful evidence once.",
          buildCompletionGateSteer("inline"),
        ].join("\n"),
        display: false,
      }, { triggerTurn: false, deliverAs: "steer" });
    }
    if (shouldPostVerificationExplorationNudge && !deferToSemantic("post-verification-exploration")) {
      pi.sendMessage({
        customType: "pi-chalin-post-verification-exploration-nudge",
        content: [
          "Post-mutation evidence already ran and no later edit was observed. Stop discovery just to summarize; final after the completion gate passes. If this tool exposed a concrete defect, patch that root cause and rerun the nearest meaningful evidence once.",
          buildCompletionGateSteer("inline"),
        ].join("\n"),
        display: false,
      }, { triggerTurn: false, deliverAs: "steer" });
    }
    if (shouldProgressNudge) {
      pi.sendMessage({
        customType: "pi-chalin-inline-progress-nudge",
        content: docsOnlyMutation
          ? "Docs changed. The next tool must be `read` on the updated docs artifact; do not run find/grep/bash after the write or continue polishing. Name unresolved surfaces as searched/not-found only after readback. If readback is complete, final in exactly three one-line bullets: Changed, Verification, Notes."
          : "Files changed. Keep the loop compact: finish the nearest source/test contract, run one focused verification, then patch only concrete failures. If you edited before reading an existing surface, read the starter source/test now. Add obvious focused tests before verification when behavior changed. After a pass, final; read files only for concrete missing evidence.",
        display: false,
      }, { triggerTurn: false, deliverAs: "steer" });
    }
    if (shouldReadyToVerifyNudge && !deferToSemantic("ready-to-verify")) {
      pi.sendMessage({
        customType: "pi-chalin-inline-ready-to-verify-nudge",
        content: docsOnlyMutation
          ? "Docs-only edit ready. No bash. Read updated docs: the next tool must be read on the updated docs artifact; revise only for unresolved named surfaces, otherwise final."
          : "Implementation changed and verification is pending. Stop broad exploration. If the work no longer fits a compact inline loop, delegate or ask with the concrete blocker. Otherwise run the nearest meaningful repo evidence once. A custom probe is enough only when it semantically covers the requested behavior plus relevant boundary or preservation context. If it fails, repair the root cause and rerun once.",
        display: false,
      }, { triggerTurn: false, deliverAs: "steer" });
    }
    if (shouldTestCoverageNudge && !deferToSemantic("test-coverage")) {
      pi.sendMessage({
        customType: "pi-chalin-inline-test-coverage-nudge",
        content: [
          "Verification passed after a source edit, but no separate test-path edit was observed.",
          "Do NOT final with command-only evidence. If focused assertions live inline in the changed source file, or exact existing tests already cover the requested behavior and boundary, cite the exact test/evidence path and assertions before finishing. Otherwise add the missing focused test(s) and rerun nearest verification once.",
          "Prefer one targeted boundary or preserve/no-op assertion over broad generated matrices.",
        ].join("\n"),
        display: false,
      }, { triggerTurn: false, deliverAs: "steer" });
    }
    if (shouldWeakTestCoverageNudge && !deferToSemantic("weak-test-coverage")) {
      pi.sendMessage({
        customType: "pi-chalin-inline-weak-test-coverage-nudge",
        content: [
          "Post-mutation evidence ran, but the latest test write looked like trivial smoke/empty coverage for a source change.",
          "Do NOT final yet. Edit the nearest test file so assertions visibly cover the prompt-named criteria plus one boundary or preservation path, then rerun the nearest meaningful evidence once.",
          "Keep it compact; do not broaden into an unrelated matrix.",
        ].join("\n"),
        display: false,
      }, { triggerTurn: false, deliverAs: "steer" });
    }
    if (shouldPackageMetadataNudge && !deferToSemantic("package-metadata")) {
      pi.sendMessage({
        customType: "pi-chalin-inline-package-metadata-nudge",
        content: [
          "Post-mutation evidence ran, but package metadata looks incomplete for the delivered scaffold entrypoints.",
          "Do NOT final yet. Patch package metadata so module format and delivered bin/main/exports agree with the source files, then rerun the nearest meaningful evidence once.",
          "Do not add build/dist indirection unless those artifacts are generated and tested.",
        ].join("\n"),
        display: false,
      }, { triggerTurn: false, deliverAs: "steer" });
    }
    if (shouldParallelSurfaceNudge && !deferToSemantic("parallel-surface")) {
      pi.sendMessage({
        customType: "pi-chalin-inline-parallel-surface-nudge",
        content: [
          "Verification passed, but the implementation/tests were placed in a parallel sibling surface instead of the prompt/starter surface.",
          "Do NOT final yet. Consolidate the implementation and substantive tests into the prompt-named or starter-imported source/test paths, remove the sibling duplicate files, then rerun the nearest verification once.",
          "Final evidence must name the canonical source and runner-discovered test path, not the skipped sibling.",
        ].join("\n"),
        display: false,
      }, { triggerTurn: false, deliverAs: "steer" });
    }
    if (shouldFailureNudge) {
      const commandText = verificationCommand ? `\`${verificationCommand}\`` : "the evidence command";
      pi.sendMessage({
        customType: "pi-chalin-inline-verification-failed-nudge",
        content: `${commandText} failed after file changes. Do NOT answer as done. Use LLM judgment to classify the failed output as behavioral evidence or environment/tooling/config/dependency blockage. If behavioral, fix the source or assertion only when prompt+repo evidence proves it wrong. If environment/tooling/config/dependency related, do not narrow, revert, or simplify a plausible source fix; preserve the hypothesis, run direct representative evidence or a faithful surrogate if possible, otherwise report the blocker. Rerun the nearest meaningful evidence after the final edit.`,
        display: false,
      }, { triggerTurn: false, deliverAs: "steer" });
    }
    if (!shouldCompletionNudge) return;
    const commandText = verificationCommand ? `\`${verificationCommand}\`` : "the evidence command";
    const changedPaths = getInlineChangedPaths();
    const changedPathText = changedPaths.length > 0
      ? changedPaths.map((item) => `\`${item}\``).join(", ")
      : "the changed files";
    const completionContent = docsOnlyMutation
      ? [
        `Docs readback complete with ${commandText}.`,
        "Run the completion gate. If it passes, final now with Changed, Evidence, and Notes. If evidence is missing, make the smallest docs correction or ask.",
        buildCompletionGateSteer("inline"),
      ].join("\n")
      : [
        `You changed files and ran ${commandText}.`,
        `Do not read ${changedPathText} just to summarize. If requested artifacts or evidence are missing, edit the smallest gap and rerun nearest meaningful evidence once. Otherwise final now with Changed, Evidence, and Notes.`,
        buildCompletionGateSteer("inline"),
      ].join("\n");
    pi.sendMessage({
      customType: "pi-chalin-inline-completion-nudge",
      content: completionContent,
      display: false,
    }, { triggerTurn: false, deliverAs: "steer" });
  });

  pi.on("session_shutdown", () => {
    abortSemanticPolicyJudges(pi);
    restoreOrchestratorThinking(pi);
    // No background workers are owned by this module across session shutdown.
    // Hidden subagent workflows run inside the current turn and honor Pi's
    // native abort signal.
  });
}

function scheduleSemanticPolicyJudge(pi: ExtensionAPI, ctx: unknown, deterministic: ReturnType<typeof recordInlineToolCompletion>["policyJudge"]): boolean {
  const request = deterministic?.semanticReview;
  if (!deterministic || !request) return false;
  const context = semanticPolicyJudgeContext(ctx);
  if (!context.model || !context.modelRegistry) return false;
  const controller = createSemanticPolicyJudgeController(pi);
  const upstreamSignal = context.signal;
  const abortFromUpstream = () => controller.abort();
  if (upstreamSignal?.aborted) controller.abort();
  else upstreamSignal?.addEventListener("abort", abortFromUpstream, { once: true });
  void runHookEffect("autoroute.semanticPolicyJudge", async () => {
    try {
      const semantic = await runSemanticPolicyJudgeForTurn({
        deterministic,
        request,
        context: { ...context, signal: controller.signal },
      });
      if (!semantic || controller.signal.aborted) return;
      if (!isSemanticPolicyJudgeRequestFresh(request)) return;
      recordSemanticPolicyJudgeResult(semantic);
      if (!shouldApplySemanticPolicyJudgeResult(deterministic, semantic)) return;
      pi.sendMessage({
        customType: "pi-chalin-semantic-policy-judge",
        content: formatSemanticPolicyJudgeSteer(semantic),
        display: false,
      }, { triggerTurn: false, deliverAs: "steer" });
    } finally {
      upstreamSignal?.removeEventListener("abort", abortFromUpstream);
      forgetSemanticPolicyJudgeController(pi, controller);
    }
  }).catch(() => undefined);
  return true;
}

function runSemanticPolicyJudgeForTurn(input: Parameters<SemanticPolicyJudgeRunner>[0]): ReturnType<SemanticPolicyJudgeRunner> {
  const runner = semanticPolicyJudgeForTests ?? runSemanticPolicyJudge;
  return runner(input);
}

function createSemanticPolicyJudgeController(pi: ExtensionAPI): AbortController {
  const controller = new AbortController();
  const key = pi as unknown as object;
  const controllers = semanticPolicyJudgeControllers.get(key) ?? new Set<AbortController>();
  controllers.add(controller);
  semanticPolicyJudgeControllers.set(key, controllers);
  return controller;
}

function forgetSemanticPolicyJudgeController(pi: ExtensionAPI, controller: AbortController): void {
  const key = pi as unknown as object;
  const controllers = semanticPolicyJudgeControllers.get(key);
  controllers?.delete(controller);
  if (controllers && controllers.size === 0) semanticPolicyJudgeControllers.delete(key);
}

function abortSemanticPolicyJudges(pi: ExtensionAPI): void {
  const key = pi as unknown as object;
  const controllers = semanticPolicyJudgeControllers.get(key);
  if (!controllers) return;
  for (const controller of controllers) controller.abort();
  semanticPolicyJudgeControllers.delete(key);
}

function shouldDeferInlineNudgeToSemantic(policyJudge: PolicyJudgeDecision | undefined, kind: InlineNudgeKind, scheduled: boolean): boolean {
  if (!scheduled) return false;
  if (policyJudge?.nudgeKind !== kind) return false;
  if (kind === "completion" || kind === "ready-to-verify" || kind === "post-failure-evidence") return false;
  return true;
}

function semanticPolicyJudgeContext(ctx: unknown): Parameters<typeof runSemanticPolicyJudge>[0]["context"] {
  const value = ctx as { model?: unknown; modelRegistry?: unknown; signal?: AbortSignal };
  return {
    model: value.model as never,
    modelRegistry: value.modelRegistry as never,
    signal: value.signal,
  };
}

function completionGateJudgeContext(pi: ExtensionAPI, ctx: unknown): CompletionGateJudgeInput["context"] {
  const value = ctx as { cwd?: unknown; model?: unknown; modelRegistry?: unknown; signal?: AbortSignal };
  const cached = completionGateContextCache.get(pi as unknown as object);
  const model = value.model ?? cached?.model;
  const modelRegistry = value.modelRegistry ?? cached?.modelRegistry;
  return {
    cwd: typeof value.cwd === "string" ? value.cwd : cached?.cwd,
    model: model as never,
    modelRegistry: modelRegistry as never,
    signal: value.signal ?? cached?.signal,
  };
}

function rememberCompletionGateJudgeContext(pi: ExtensionAPI, ctx: unknown): void {
  const value = ctx as { cwd?: unknown; model?: unknown; modelRegistry?: unknown; signal?: AbortSignal };
  if (!value.model || !value.modelRegistry) return;
  completionGateContextCache.set(pi as unknown as object, {
    cwd: typeof value.cwd === "string" ? value.cwd : undefined,
    model: value.model as never,
    modelRegistry: value.modelRegistry as never,
    signal: value.signal,
  });
}

async function runCompletionGateJudgeForTurn(input: CompletionGateJudgeInput): Promise<CompletionGateDecision | undefined> {
  const runner = completionGateJudgeForTests ?? runCompletionGateJudge;
  return runner(input);
}

function runCompletionGateMessageEnd(pi: ExtensionAPI, event: unknown, ctx: unknown): Promise<{ message: any } | undefined> {
  return runHookEffect("autoroute.completionGate", async () => {
    if (!isCompletionGateEnabledForTurn(pi)) return;
    const finalAnswer = assistantTextOnlyFinal(event);
    if (!finalAnswer) return;
    const payload = getInlineCompletionGatePayload({ finalAnswer });
    if (!shouldRunCompletionGate(payload)) return;
    const decision = await runCompletionGateJudgeForTurn({ payload, context: completionGateJudgeContext(pi, ctx) });
    if (!decision) {
      const key = completionGateUnavailableKey(payload);
      if (!hasCompletionGateFollowup(pi, key)) {
        rememberCompletionGateFollowup(pi, key);
        sendCompletionGateUnavailableDiagnostic(pi, payload);
      }
      return completionGateUnavailableReplacement(event);
    }
    const key = completionGateDecisionKey(payload, decision);
    if (!hasCompletionGateFollowup(pi, key)) {
      rememberCompletionGateFollowup(pi, key);
      sendCompletionGateAudit(pi, decision);
    }
    if (!shouldApplyCompletionGateDecision(decision)) return;
    recordCompletionGateBlock(decision);
    return completionGateContinuationReplacement(event, decision);
  });
}

function sendCompletionGateAudit(pi: ExtensionAPI, decision: CompletionGateDecision): void {
  pi.appendEntry("pi-chalin-completion-gate-decision", {
    canFinalize: decision.canFinalize,
    confidence: decision.confidence,
    nextAction: decision.nextAction,
    reason: decision.reason,
    missingEvidence: decision.missingEvidence,
    requiredEvidence: decision.requiredEvidence ?? [],
    timestamp: Date.now(),
  });
}

function sendCompletionGateUnavailableDiagnostic(pi: ExtensionAPI, payload: ReturnType<typeof getInlineCompletionGatePayload>): void {
  pi.appendEntry("pi-chalin-completion-gate-diagnostic", {
    status: "judge-unavailable",
    changedPaths: payload.state.changedPaths,
    verificationObserved: payload.state.verificationObserved,
    evidenceAfterLatestMutation: payload.ledger.evidenceAfterLatestMutation,
    commandCount: payload.ledger.commandRecords.length,
    timestamp: Date.now(),
  });
}

function completionGateUnavailableKey(payload: ReturnType<typeof getInlineCompletionGatePayload>): string {
  return JSON.stringify({
    status: "judge-unavailable",
    prompt: payload.originalPrompt,
    changedPaths: payload.state.changedPaths,
    readPaths: payload.state.readPaths,
    evidenceAfterLatestMutation: payload.ledger.evidenceAfterLatestMutation,
    mutations: payload.ledger.mutationRecords.map((record) => [record.toolName, record.status, record.afterFailedCommand, record.path ?? "", record.args ?? "", record.observation ?? ""]),
    commands: payload.ledger.commandRecords.map((record) => [record.command, record.status, record.afterLatestMutation]),
    failedCommandsAfterMutation: payload.ledger.failedCommandsAfterMutation.map((record) => [record.command, record.status, record.afterLatestMutation]),
    postFailureMutations: payload.ledger.postFailureMutationRecords.map((record) => [record.toolName, record.status, record.path ?? "", record.args ?? "", record.observation ?? ""]),
    observations: payload.ledger.observations.map((record) => [record.toolName, record.status, record.afterLatestMutation, record.path ?? "", record.command ?? "", record.text]),
  });
}

function completionGateContinuationReplacement(event: unknown, decision: CompletionGateDecision): { message: any } | undefined {
  const message = (event as { message?: unknown }).message;
  if (!isRecord(message) || message.role !== "assistant") return undefined;
  const missing = compactDecisionItems(decision.missingEvidence);
  const required = compactDecisionItems(decision.requiredEvidence ?? []);
  return {
    message: {
      ...message,
      content: [{
        type: "text",
        text: [
          "Completion gate: I cannot call this complete yet.",
          missing ? `Missing evidence: ${missing}.` : undefined,
          required ? `Required evidence: ${required}.` : undefined,
          `Next action: ${decision.nextAction}.`,
          `Reason: ${compactDecisionText(decision.reason)}.`,
        ].filter(Boolean).join("\n"),
      }],
    },
  };
}

function completionGateUnavailableReplacement(event: unknown): { message: any } | undefined {
  const message = (event as { message?: unknown }).message;
  if (!isRecord(message) || message.role !== "assistant") return undefined;
  return {
    message: {
      ...message,
      content: [{
        type: "text",
        text: [
          "Completion gate: I cannot call this complete yet because the pre-final evidence check was unavailable.",
          "Use direct repo/spec evidence or report the concrete blocker before finalizing.",
        ].join("\n"),
      }],
    },
  };
}

function compactDecisionItems(items: readonly string[]): string {
  return items
    .map((item) => compactDecisionText(item, 120))
    .filter(Boolean)
    .slice(0, 3)
    .join("; ");
}

function compactDecisionText(value: string, max = 180): string {
  const text = value.trim();
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 3)).trimEnd()}...`;
}

function shouldRunCompletionGate(payload: ReturnType<typeof getInlineCompletionGatePayload>): boolean {
  if (payload.state.terminalActionObserved) return true;
  if (!payload.state.mutationObserved) return false;
  if (payload.state.docsOnlyMutation) return true;
  if (payload.state.sourceMutationObserved || payload.state.testMutationObserved) return true;
  return payload.ledger.evidenceAfterLatestMutation;
}

function assistantTextOnlyFinal(event: unknown): string | undefined {
  const message = isRecord(event) ? event.message : undefined;
  if (!isRecord(message) || message.role !== "assistant") return undefined;
  const content = message.content;
  if (typeof content === "string") return content.trim() || undefined;
  if (!Array.isArray(content)) return undefined;
  const chunks: string[] = [];
  for (const block of content) {
    if (!isRecord(block)) continue;
    if (block.type === "toolCall") return undefined;
    if (block.type === "text" && typeof block.text === "string") chunks.push(block.text);
  }
  const text = chunks.join("\n").trim();
  return text || undefined;
}

function restoreOrchestratorThinking(pi: ExtensionAPI): void {
  const key = pi as unknown as object;
  const previous = orchestratorThinkingRestore.get(key);
  if (!previous) return;
  orchestratorThinkingRestore.delete(key);
  try {
    pi.setThinkingLevel(previous);
  } catch {
    // Best-effort restoration; the host may have been torn down.
  }
}

function inputGuardEffect(event: { source?: string; text: string }, ctx: ExtensionContext): Effect.Effect<{ action: "continue" } | { action: "handled" }, unknown> {
  return Effect.tryPromise(async () => {
    if (event.source === "extension") return { action: "continue" as const };
    const text = event.text.trim();
    beginChalinTurn({ prompt: text, cwd: ctx.cwd });
    return { action: "continue" as const };
  }).pipe(Effect.withSpan("autoroute.inputGuard"));
}

function setPendingHumanInputBlock(pi: ExtensionAPI, block: PendingHumanInputBlock): void {
  pendingHumanInputBlocks.set(pi as unknown as object, block);
}

function clearPendingHumanInputBlock(pi: ExtensionAPI): void {
  pendingHumanInputBlocks.delete(pi as unknown as object);
}

function currentHumanInputBlock(pi: ExtensionAPI): PendingHumanInputBlock | undefined {
  const block = pendingHumanInputBlocks.get(pi as unknown as object);
  if (!block) return undefined;
  if (Date.now() - block.createdAt > 10 * 60_000) {
    clearPendingHumanInputBlock(pi);
    return undefined;
  }
  return block;
}

function suppressProviderToolsForHumanInput(payload: unknown): unknown {
  if (!isRecord(payload) || !Array.isArray(payload.tools)) return payload;
  return { ...payload, tools: [] };
}

function hasCustomMessage(messages: readonly unknown[], customType: string): boolean {
  return messages.some((message) => isRecord(message) && message.customType === customType);
}

function setCompletionGateEnabledForTurn(pi: ExtensionAPI, enabled: boolean): void {
  completionGateEnabledForTurn.set(pi as unknown as object, enabled);
}

function isCompletionGateEnabledForTurn(pi: ExtensionAPI): boolean {
  return completionGateEnabledForTurn.get(pi as unknown as object) === true;
}

function clearCompletionGateEnabledForTurn(pi: ExtensionAPI): void {
  completionGateEnabledForTurn.delete(pi as unknown as object);
}

export function resetAutorouteToolStateForTests(): void {
  // WeakMap intentionally has no clear(); tests use fresh fake APIs, so this is
  // a marker hook for symmetry with runtime-state resets.
  completionGateJudgeForTests = undefined;
  semanticPolicyJudgeForTests = undefined;
}

export function setCompletionGateJudgeForTests(judge: CompletionGateJudgeRunner | undefined): void {
  completionGateJudgeForTests = judge;
}

export function setSemanticPolicyJudgeForTests(judge: SemanticPolicyJudgeRunner | undefined): void {
  semanticPolicyJudgeForTests = judge;
}

function completionGateFollowupsFor(pi: ExtensionAPI): Set<string> {
  const key = pi as unknown as object;
  const existing = completionGateFollowupKeys.get(key);
  if (existing) return existing;
  const created = new Set<string>();
  completionGateFollowupKeys.set(key, created);
  return created;
}

function hasCompletionGateFollowup(pi: ExtensionAPI, key: string): boolean {
  return completionGateFollowupsFor(pi).has(key);
}

function rememberCompletionGateFollowup(pi: ExtensionAPI, key: string): void {
  completionGateFollowupsFor(pi).add(key);
}

function clearCompletionGateFollowups(pi: ExtensionAPI): void {
  completionGateFollowupKeys.delete(pi as unknown as object);
}

function clearCompletionGateJudgeContext(pi: ExtensionAPI): void {
  completionGateContextCache.delete(pi as unknown as object);
}

export function setAutorouteHumanInputBlockForTests(pi: ExtensionAPI, block: Omit<PendingHumanInputBlock, "createdAt"> & { createdAt?: number }): void {
  setPendingHumanInputBlock(pi, { ...block, createdAt: block.createdAt ?? Date.now() });
}

function rememberToolStart(pi: ExtensionAPI, event: unknown): PendingToolArgs | undefined {
  const toolName = (event as { toolName?: unknown }).toolName;
  if (typeof toolName !== "string" || !toolName) return undefined;
  const args = (event as { args?: unknown }).args;
  if (!args || typeof args !== "object") return undefined;
  const pending = pendingArgsFor(pi);
  const queue = pending.get(toolName) ?? [];
  const captured = {
    command: stringArg(args, "command"),
    path: stringArg(args, "path") ?? stringArg(args, "filePath") ?? stringArg(args, "file"),
    argsText: JSON.stringify(args),
  };
  queue.push(captured);
  pending.set(toolName, queue);
  return captured;
}

function takeToolStart(pi: ExtensionAPI, toolName: string): PendingToolArgs | undefined {
  const pending = pendingToolStarts.get(pi as unknown as object);
  const queue = pending?.get(toolName);
  const next = queue?.shift();
  if (queue && queue.length === 0) pending?.delete(toolName);
  return next;
}

function clearPendingToolStarts(pi: ExtensionAPI): void {
  pendingToolStarts.delete(pi as unknown as object);
}

function pendingArgsFor(pi: ExtensionAPI): Map<string, PendingToolArgs[]> {
  const key = pi as unknown as object;
  const existing = pendingToolStarts.get(key);
  if (existing) return existing;
  const created = new Map<string, PendingToolArgs[]>();
  pendingToolStarts.set(key, created);
  return created;
}

function stringArg(args: object, key: string): string | undefined {
  const value = (args as Record<string, unknown>)[key];
  return typeof value === "string" && value.trim() ? value : undefined;
}

function toolResultObservation(result: unknown): string | undefined {
  if (typeof result === "string") return compactEvidenceObservation(result);
  if (!isRecord(result)) return undefined;
  const content = result.content;
  if (!Array.isArray(content)) return undefined;
  const chunks: string[] = [];
  for (const block of content) {
    if (!isRecord(block)) continue;
    if (block.type === "text" && typeof block.text === "string" && block.text.trim()) {
      chunks.push(block.text);
    }
  }
  return compactEvidenceObservation(chunks.join("\n"));
}

function compactResumeCandidateMessage(run: RunState): string {
  const completed = run.steps.filter((step) => isUsableStepHandoff(step)).length;
  const total = Math.max(run.steps.length, 1);
  const next = run.steps.find((step) => !isUsableStepHandoff(step));
  const blockingQuestions = run.recoveryState?.blockedByHumanInput ? (run.recoveryState.repairOptions ?? []).filter(Boolean) : [];
  if (blockingQuestions.length || run.intentContract?.requiresInterview) {
    return [
      "Paused pi-chalin run is blocked on user input in this same session.",
      `Run id: ${run.id}. Status: ${run.status}. Progress: ${completed}/${total}. Next agent: ${next?.agent ?? "unknown"}.`,
      "Do not start another chalin_route for the same work. Ask the user the blocking question(s), then continue this run after the answer.",
      blockingQuestions.length ? "Blocking question(s):" : undefined,
      ...blockingQuestions.slice(0, 5).map((question) => `- ${question}`),
      "If the user is asking for new unrelated work, ignore this resume context.",
    ].filter((line): line is string => Boolean(line)).join("\n");
  }
  return [
    "Resumable pi-chalin run available; use LLM judgment for whether the current user intent is continuation.",
    `Run id: ${run.id}. Status: ${run.status}. Progress: ${completed}/${total}. Next agent: ${next?.agent ?? "unknown"}.`,
    "Do not start another chalin_route for the same work.",
    `If the user wants to continue that run, call \`chalin_resume\` with {"runId":"${run.id}"} before answering from partial findings.`,
    "If the user is asking for new unrelated work, ignore this resume context.",
  ].join("\n");
}

function workflowBlockedReason(event: unknown): string | undefined {
  const details = (event as { result?: { details?: { approval?: { action?: unknown; reason?: unknown } } } }).result?.details;
  const action = details?.approval?.action;
  if (typeof action === "string" && action !== "allow") {
    const reason = details?.approval?.reason;
    return typeof reason === "string" && reason.trim() ? `${action}: ${reason}` : action;
  }
  return undefined;
}

function delegatedMutableWorkPendingReason(event: unknown): string | undefined {
  const run = delegatedRunFromEvent(event);
  if (!run || run.status !== "paused") return undefined;
  if (run.intentContract?.requiresInterview || run.recoveryState?.blockedByHumanInput) {
    const question = run.recoveryState?.repairOptions?.find((item) => item.trim());
    return question ? `human input required: ${compactDecisionText(question, 120)}` : "human input required";
  }
  const units = Array.isArray(run.workUnits) ? run.workUnits : [];
  const pendingWriteUnits = units.filter((unit) => {
    if (!isPendingDelegatedStatus(unit.status)) return false;
    return unit.expectedEffects.includes("write");
  });
  if (pendingWriteUnits.length === 0) return undefined;
  return pendingWriteUnits
    .slice(0, 3)
    .map((unit) => compactDecisionText(unit.title || unit.id, 80))
    .join("; ");
}

function delegatedRunFromEvent(event: unknown): RunState | undefined {
  const result = (event as { result?: unknown }).result;
  if (!isRecord(result)) return undefined;
  const details = result.details;
  if (!isRecord(details)) return undefined;
  const run = details.run;
  if (!isRecord(run)) return undefined;
  if (typeof run.id !== "string" || typeof run.status !== "string") return undefined;
  if (!Array.isArray(run.steps)) return undefined;
  return run as unknown as RunState;
}

function isPendingDelegatedStatus(status: unknown): boolean {
  return status === "pending" || status === "running" || status === "paused" || status === "checkpointed" || status === "skipped";
}

export function shouldScheduleNonInteractiveShutdown(ctx: { hasUI?: boolean; shutdown?: () => void }): boolean {
  return !ctx.hasUI && typeof ctx.shutdown === "function" && process.env.PI_CHALIN_NONINTERACTIVE_SHUTDOWN === "1";
}

function scheduleNonInteractiveShutdown(ctx: { hasUI?: boolean; abort?: () => void; shutdown?: () => void }): void {
  if (!shouldScheduleNonInteractiveShutdown(ctx)) return;
  const abort = ctx.abort;
  const shutdown = ctx.shutdown;
  if (typeof shutdown !== "function") return;
  const configuredDelay = Number(process.env.PI_CHALIN_NONINTERACTIVE_SHUTDOWN_DELAY_MS);
  const delayMs = Number.isFinite(configuredDelay) && configuredDelay >= 0 ? configuredDelay : 0;
  const timer = setTimeout(() => {
    try {
      abort?.();
      shutdown();
    } catch {
      // Pi can mark extension contexts stale while a print-mode turn exits.
      // The tool result has already been emitted, so stale shutdown is safe to ignore.
    }
  }, delayMs);
  timer.unref?.();
}
