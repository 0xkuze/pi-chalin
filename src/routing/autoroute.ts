import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Effect } from "effect";
import { AgentCatalog } from "../agents/agents.ts";
import { loadEffectiveConfig } from "../config/config.ts";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { buildChalinOrchestratorSystemPrompt } from "../orchestration/orchestration.ts";
import { isUsableStepHandoff, loadResumableRunState } from "../runner/runner-state.ts";
import { beginChalinTurn, getInlineChangedPaths, getInlineCriticalGuardContextMessage, isSemanticPolicyJudgeRequestFresh, recordInlineToolCompletion, recordInlineToolStart, recordSemanticPolicyJudgeResult } from "../runtime/state.ts";
import { formatSemanticPolicyJudgeSteer, runSemanticPolicyJudge, shouldApplySemanticPolicyJudgeResult } from "../skills/semantic-policy-judge.ts";
import type { InlineNudgeKind, PolicyJudgeDecision } from "../runtime/state.ts";
import type { RunState } from "../domain/schemas.ts";
import { setChalinStatus } from "../ui/ui-status.ts";

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

function runHookEffect<A>(span: string, run: () => A | Promise<A>): Promise<A> {
  return Effect.runPromise(Effect.tryPromise({ try: async () => run(), catch: (error) => error }).pipe(Effect.withSpan(span)));
}

export function registerChalinAutoRouter(pi: ExtensionAPI): void {
  pi.on("input", (event, ctx) => Effect.runPromise(inputGuardEffect(pi, event, ctx)));

  pi.on("before_agent_start", (event, ctx) => runHookEffect("autoroute.beforeAgentStart", async () => {
    const loaded = loadEffectiveConfig({ cwd: ctx.cwd });
    if (!loaded.config.enabled) return;
    const promptText = typeof event.prompt === "string" ? event.prompt : "";
    beginChalinTurn({ prompt: promptText, cwd: ctx.cwd });
    const catalog = AgentCatalog.load({ cwd: ctx.cwd });
    const resumableRun = loadResumableRunState({ cwd: ctx.cwd, recoverStale: false });
    const resumeContext = resumableRun ? compactResumeCandidateMessage(resumableRun) : undefined;
    const systemPrompt = [
      event.systemPrompt,
      buildChalinOrchestratorSystemPrompt(catalog.list(), promptText),
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
    const criticalGuard = getInlineCriticalGuardContextMessage();
    if (!criticalGuard) return;
    return {
      messages: [
        ...event.messages,
        {
          role: "custom",
          customType: "pi-chalin-inline-critical-guard",
          content: criticalGuard,
          display: false,
          timestamp: Date.now(),
        },
      ],
    };
  });

  pi.on("agent_end", (_event, ctx) => {
    clearPendingToolStarts(pi);
    clearPendingHumanInputBlock(pi);
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
      pi.sendMessage({
        customType: "pi-chalin-synthesis-nudge",
        content: `${event.toolName} finished. Answer the user's original prompt now from the Final answer material in the tool result. Do not call another tool unless that material explicitly names a critical blocking gap.`,
        display: false,
      }, { triggerTurn: false, deliverAs: "steer" });
      scheduleNonInteractiveShutdown(ctx);
      return;
    }

    const eventArgs = (event as { args?: { command?: unknown; path?: unknown } }).args;
    const fallbackArgs = takeToolStart(pi, event.toolName);
    const { shouldProgressNudge, shouldReadyToVerifyNudge, shouldFailureNudge, shouldCompletionNudge, shouldTestCoverageNudge, shouldWeakTestCoverageNudge, shouldPackageMetadataNudge, shouldParallelSurfaceNudge, shouldWorkspaceBoundaryNudge, shouldDocsShellNudge, shouldTerminalCompletionNudge, shouldPostTerminalDriftNudge, shouldPreMutationVerificationNudge, shouldPostVerificationShellNudge, shouldPostVerificationExplorationNudge, shouldLocatorLoopNudge, shouldExistingFileRewriteNudge, shouldMutationLoopNudge, shouldSourceAndTestReadyNudge, shouldVerificationLoopNudge, shouldPostFailureEvidenceNudge, verificationCommand, docsOnlyMutation, policyJudge } = recordInlineToolCompletion({
      toolName: event.toolName,
      isError: event.isError,
      command: typeof eventArgs?.command === "string" ? eventArgs.command : fallbackArgs?.command,
      path: typeof eventArgs?.path === "string" ? eventArgs.path : fallbackArgs?.path,
      argsText: eventArgs ? JSON.stringify(eventArgs) : fallbackArgs?.argsText,
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
    if (shouldPreMutationVerificationNudge) {
      pi.sendMessage({
        customType: "pi-chalin-inline-pre-mutation-verification-nudge",
        content: "This bounded code+test task ran verification before any edit. Stop baseline checks now: edit the requested source plus focused tests, then run one nearest verification after mutation. Do not run another pre-edit test command.",
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
        content: [
          "Source and tests changed. Stop expanding scope and run the nearest package verification now.",
          "Self-check before bash: changed behavior, one boundary/counterexample, one preservation/no-op path, runner-compatible imports/assertions, requested test path/glob/extension, and requested package/API/docs/README metadata when relevant. For scaffolds, docs/README are part of the pre-verification batch; do not add them after a passing test.",
          "If the changed test file only has an empty/smoke/no-op case while the prompt names several criteria, edit tests now instead of running bash; assertions must visibly cover the named criteria.",
          "Coverage check only if relevant: derive edge cases from the user's contract and changed code, then cover normal behavior, invalid/empty/external inputs, boundaries, ordering/idempotence/mutation invariants, preservation paths, runner discoverability, and deterministic async/time behavior. Do not copy a memorized domain checklist; choose the smallest evidence set that proves the requested behavior.",
          "Do not read/rewrite more files just to inspect your own edits. Tiny stubs may be replaced once; existing large/partial files stay targeted edits.",
          "If verification fails, patch the concrete root cause and rerun once. If it passes, final immediately; no changed-file readback after pass unless the verification output itself proves a concrete missing-artifact gap.",
        ].join("\n"),
        display: false,
      }, { triggerTurn: false, deliverAs: "steer" });
    }
    if (shouldVerificationLoopNudge && !deferToSemantic("verification-loop")) {
      pi.sendMessage({
        customType: "pi-chalin-inline-verification-loop-nudge",
        content: "Verification is looping. Do not run another check until one focused edit addresses the latest failure. If the latest verification passed, use one changed-file readback and final.",
        display: false,
      }, { triggerTurn: false, deliverAs: "steer" });
    }
    if (shouldPostFailureEvidenceNudge && !deferToSemantic("post-failure-evidence")) {
      pi.sendMessage({
        customType: "pi-chalin-inline-post-failure-evidence-nudge",
        content: [
          "A verification failure already gave you a concrete signal, and you have now spent multiple tools investigating without editing.",
          "Stop diagnostic probing. Patch the smallest root cause from the failure plus current evidence, then rerun the nearest verification once. If the needed API is still unknown, use one targeted read of official/local docs or existing tests, not more exploratory shell probes.",
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
          "Final now. Do not call tools, rewrite PR body files, rerun support commands, or keep polishing local artifacts.",
          "Use the user's language and give a compact receipt with the PR/action result, verification already run, and any important notes.",
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
        content: "Verification already passed and no later edit was observed. Stop running shell/test commands; final now. Do not read back after pass just to summarize; if this command exposed a concrete defect, edit that root cause and rerun the nearest verification once.",
        display: false,
      }, { triggerTurn: false, deliverAs: "steer" });
    }
    if (shouldPostVerificationExplorationNudge && !deferToSemantic("post-verification-exploration")) {
      pi.sendMessage({
        customType: "pi-chalin-post-verification-exploration-nudge",
        content: "Verification already passed and no later edit was observed. Stop post-verification discovery: final now. Do not read back just to summarize; if this tool exposed a concrete defect, patch that root cause and rerun the nearest verification once.",
        display: false,
      }, { triggerTurn: false, deliverAs: "steer" });
    }
    if (shouldProgressNudge) {
      pi.sendMessage({
        customType: "pi-chalin-inline-progress-nudge",
        content: docsOnlyMutation
          ? "Docs changed. The next tool must be `read` on the updated docs artifact; do not run find/grep/bash after the write or continue polishing. Name unresolved surfaces as searched/not-found only after readback. If readback is complete, final in exactly three one-line bullets: Changed, Verification, Notes."
          : [
            "Files changed. Keep the loop proportional: complete the nearest source/test contract, run one focused verification, then patch only concrete failures.",
            "If the first mutation happened before reading an existing source/test surface and this is not explicit empty greenfield work, pause and read the starter imports/stubs now; existing modules and runner-discovered tests define the acceptance surface.",
            "If tests were requested or the test path is obvious, add/update the focused tests before the first verification after a source edit. Put coverage where the runner discovers it; for Python unittest prefer `tests/test_<stem>.py` plus `python -m unittest discover -s tests` when a `tests/` root exists. If you wrote a sibling module/test before reading the starter surface, consolidate to the starter import/path and remove the duplicate before verification.",
            "Preserve compatibility and requested package/CLI/API metadata, exports, real command path, requested test paths/extensions, and runner-discoverable tests when relevant.",
            "After a passing verification, final with supported claims. Do not read back just to summarize; read changed files only for concrete missing evidence.",
          ].join("\n"),
        display: false,
      }, { triggerTurn: false, deliverAs: "steer" });
    }
    if (shouldReadyToVerifyNudge && !deferToSemantic("ready-to-verify")) {
      pi.sendMessage({
        customType: "pi-chalin-inline-ready-to-verify-nudge",
        content: docsOnlyMutation
          ? "Docs-only edit ready. No bash. Read updated docs: the next tool must be read on the updated docs artifact; revise only for unresolved named surfaces, otherwise final."
          : [
            "Implementation changed and verification is pending. Stop broad exploration. If the latest evidence proves real breadth, ambiguity, repeated failure, or context pressure, stop inline work and explain the concrete blocker instead of improvising a broader workflow.",
            "If a later verification after the latest edit already passed, this pending-verification steer is stale: final now and do not run another shell/test command.",
            "Run the nearest meaningful verification once. If it fails, fix only the root cause and rerun after the final edit.",
          ].join("\n"),
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
          "Verification passed, but the latest test write looked like trivial smoke/empty coverage for a source change.",
          "Do NOT final yet. Edit the nearest test file so assertions visibly cover the prompt-named criteria plus one boundary or preservation path, then rerun the nearest verification once.",
          "Keep it compact; do not broaden into an unrelated matrix.",
        ].join("\n"),
        display: false,
      }, { triggerTurn: false, deliverAs: "steer" });
    }
    if (shouldPackageMetadataNudge && !deferToSemantic("package-metadata")) {
      pi.sendMessage({
        customType: "pi-chalin-inline-package-metadata-nudge",
        content: [
          "Verification passed, but package metadata looks incomplete for the delivered scaffold entrypoints.",
          "Do NOT final yet. Patch package metadata so module format and delivered bin/main/exports agree with the source files, then rerun the nearest package verification once.",
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
      const commandText = verificationCommand ? `\`${verificationCommand}\`` : "the verification command";
      pi.sendMessage({
        customType: "pi-chalin-inline-verification-failed-nudge",
        content: [
          `${commandText} failed after file changes. Do NOT answer as done yet.`,
          "Use the latest failure as evidence. Change tests only when prompt+repo evidence proves the expectation is wrong; otherwise fix implementation. Do not broaden parser/tokenizer behavior to unrelated token classes just to satisfy one failing assertion.",
          "Patch the exact failing source or assertion from the error output. Do not grep/find/read broad surfaces for a known symbol; use at most one targeted read of an already changed file only if the failure output is insufficient.",
          "If verification discovers fewer tests than you wrote, move/merge the substantive coverage into the runner-discovered test path before claiming completion.",
          "If you already made a later edit and the nearest verification after that edit passed, this failure is superseded: final now instead of rerunning the same command.",
          "Keep the repo runner/package manager and requested files/APIs/toolchain coherent. If package.json/config says `npm test` -> `node --test`, tests must use node:test/node:assert; if the package runner is Vitest, use compatible imports. Rerun the package/nearest verification after the final edit; stale, failed, or wrong-runner verification is invalid.",
        ].join("\n"),
        display: false,
      }, { triggerTurn: false, deliverAs: "steer" });
    }
    if (!shouldCompletionNudge) return;
    const commandText = verificationCommand ? `\`${verificationCommand}\`` : "the verification command";
    const changedPaths = getInlineChangedPaths();
    const changedPathText = changedPaths.length > 0
      ? changedPaths.map((item) => `\`${item}\``).join(", ")
      : "the changed files";
    const completionContent = docsOnlyMutation
      ? [
        `Docs readback complete with ${commandText}.`,
        "Final now. Do not call tools, do not keep thinking, and do not write a plan.",
        "Use the user's language; translate bullet labels when appropriate.",
        "Use exactly 3 bullets, one line each:",
        `- Changed: ${changedPathText} updated with the requested operational fields`,
        `- Verification: ${commandText}`,
        "- Notes: cite the manifest/source evidence paths and only mention unresolved searched/not-found gaps if relevant.",
      ].join("\n")
      : [
        `You changed files and ran ${commandText}.`,
        `Final now if the last edit output plus ${commandText} already prove the requested behavior. For one-file/path-bounded tasks with visible edit output and a passing runner, readback after pass is waste; do not read ${changedPathText} just to summarize.`,
        "If requested API/tests/docs/README/manifest/bin/export/toolchain, package-runner coherence, or verification evidence is missing, edit it and rerun verification. Otherwise answer now; do not run another shell/test command unless you edit again or the last output was not passing.",
        "For transformations and refactors, tests must visibly cover the named criteria plus one boundary/preservation path; command-only success with a trivial smoke test is not enough.",
        "For greenfield package/library/CLI work, README/API/usage docs and package/bin/export/module metadata are required when requested or implied by the package shape. If runner tests already cover the CLI command path, no extra post-test shell is needed. A final answer that only says what you will do is invalid for a mutation request.",
        "Use the user's language; translate bullet labels when appropriate.",
        "Final should be concise but complete: a compact receipt, not a test-matrix recap. Use exactly three bullets, one line each:",
        "- Changed: `path/to/file`[, `path/to/test`]",
        `- Verification: ${commandText} passed only if the command output showed success and no failure/assertion/error appeared`,
        "- Notes: one sentence with requested behavior/constraints, boundary/preservation evidence, and 2-4 useful design/boundary facts: public response/API shape, standard-library/domain primitive used, most important edge tests, and no duplicate or skipped helper surface; test counts and paths must match the actual verification output, not a skipped helper file.",
      ].join("\n");
    pi.sendMessage({
      customType: "pi-chalin-inline-completion-nudge",
      content: completionContent,
      display: false,
    }, { triggerTurn: false, deliverAs: "steer" });
  });

  pi.on("session_shutdown", () => {
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
  void runHookEffect("autoroute.semanticPolicyJudge", async () => {
    const semantic = await runSemanticPolicyJudge({
      deterministic,
      request,
      context,
    });
    if (!semantic) return;
    if (!isSemanticPolicyJudgeRequestFresh(request)) return;
    recordSemanticPolicyJudgeResult(semantic);
    if (!shouldApplySemanticPolicyJudgeResult(deterministic, semantic)) return;
    pi.sendMessage({
      customType: "pi-chalin-semantic-policy-judge",
      content: formatSemanticPolicyJudgeSteer(semantic),
      display: false,
    }, { triggerTurn: false, deliverAs: "steer" });
  }).catch(() => undefined);
  return true;
}

function shouldDeferInlineNudgeToSemantic(policyJudge: PolicyJudgeDecision | undefined, kind: InlineNudgeKind, scheduled: boolean): boolean {
  if (!scheduled) return false;
  if (policyJudge?.nudgeKind !== kind) return false;
  return kind !== "completion";
}

function semanticPolicyJudgeContext(ctx: unknown): Parameters<typeof runSemanticPolicyJudge>[0]["context"] {
  const value = ctx as { model?: unknown; modelRegistry?: unknown; signal?: AbortSignal };
  return {
    model: value.model as never,
    modelRegistry: value.modelRegistry as never,
    signal: value.signal,
  };
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

function inputGuardEffect(pi: ExtensionAPI, event: { source?: string; text: string }, ctx: ExtensionContext): Effect.Effect<{ action: "continue" } | { action: "handled" }, unknown> {
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
  const next: Record<string, unknown> = { ...payload, tools: [] };
  if ("tool_choice" in next) next.tool_choice = "none";
  if ("toolChoice" in next) next.toolChoice = "none";
  return next;
}

export function resetAutorouteToolStateForTests(): void {
  // WeakMap intentionally has no clear(); tests use fresh fake APIs, so this is
  // a marker hook for symmetry with runtime-state resets.
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function compactResumeCandidateMessage(run: RunState): string {
  const completed = run.steps.filter((step) => isUsableStepHandoff(step)).length;
  const total = Math.max(run.steps.length, 1);
  const next = run.steps.find((step) => !isUsableStepHandoff(step));
  return [
    "Resumable pi-chalin run available; use LLM judgment for whether the current user intent is continuation.",
    `Run id: ${run.id}. Status: ${run.status}. Progress: ${completed}/${total}. Next agent: ${next?.agent ?? "unknown"}.`,
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

function scheduleNonInteractiveShutdown(ctx: { hasUI?: boolean; abort?: () => void; shutdown?: () => void }): void {
  if (ctx.hasUI || typeof ctx.shutdown !== "function" || process.env.PI_CHALIN_NONINTERACTIVE_SHUTDOWN === "0") return;
  const abort = ctx.abort;
  const shutdown = ctx.shutdown;
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
