import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { AgentCatalog } from "./agents.ts";
import { loadEffectiveConfig } from "./config.ts";
import { createConfiguredMemoryStore } from "./memory-provider.ts";
import { buildCompactChalinOrchestratorSystemPrompt, buildChalinOrchestratorSystemPrompt } from "./orchestration.ts";
import { isUsableStepHandoff, loadResumableRunState } from "./runner-state.ts";
import { beginChalinTurn, getDirectChangedPaths, recordDirectToolCompletion } from "./runtime-state.ts";
import type { RunState } from "./schemas.ts";
import { setChalinStatus } from "./ui-status.ts";

type PendingToolArgs = {
  command?: string;
  path?: string;
  argsText?: string;
};

const pendingToolStarts = new WeakMap<object, Map<string, PendingToolArgs[]>>();

export function registerChalinAutoRouter(pi: ExtensionAPI): void {
  pi.on("input", async (event) => {
    if (event.source === "extension") return { action: "continue" };
    const text = event.text.trim();
    if (!text || text.startsWith("/") || text.startsWith("!")) return { action: "continue" };

    // Never consume the user prompt. The primary Pi agent stays in control and
    // decides whether to call chalin_route as one of its normal tools.
    return { action: "continue" };
  });

  pi.on("before_agent_start", async (event, ctx) => {
    beginChalinTurn({ prompt: typeof event.prompt === "string" ? event.prompt : undefined });
    const loaded = loadEffectiveConfig({ cwd: ctx.cwd });
    if (!loaded.config.enabled) return;
    const promptText = typeof event.prompt === "string" ? event.prompt : "";
    const resumableRun = loadResumableRunState({ cwd: ctx.cwd, recoverStale: false });
    const resumeContext = resumableRun ? compactResumeCandidateMessage(resumableRun) : undefined;
    const useCompactPrompt = shouldUseCompactDirectOrchestrationPrompt(promptText);
    const useCompactGeneralPrompt = !ctx.hasUI && !useCompactPrompt;
    const catalog = useCompactPrompt || useCompactGeneralPrompt ? undefined : AgentCatalog.load({ cwd: ctx.cwd });
    const orchestrationPrompt = useCompactGeneralPrompt
      ? buildCompactChalinOrchestratorSystemPrompt()
      : useCompactPrompt
      ? ""
      : buildChalinOrchestratorSystemPrompt(catalog?.list() ?? []);
    const memoryContext = useCompactPrompt ? undefined : await globalMemoryContextForPrompt(ctx.cwd, promptText);
    const systemPrompt = [event.systemPrompt, orchestrationPrompt, memoryContext].filter((item) => item?.trim()).join("\n\n");
    return {
      systemPrompt,
      message: {
        customType: useCompactPrompt ? "pi-chalin-path-compact-orchestration" : useCompactGeneralPrompt ? "pi-chalin-compact-orchestration" : "pi-chalin-orchestration",
        content: useCompactPrompt ? [resumeContext, compactPathSteeringMessage(promptText, ctx.hasUI)].filter(Boolean).join("\n\n") : useCompactGeneralPrompt ? [resumeContext, compactGeneralSteeringMessage()].filter(Boolean).join("\n\n") : [
          resumeContext,
          "If the current user intent is to continue an interrupted pi-chalin run, call chalin_resume before answering from partial findings.",
          "pi-chalin preflight: if this is branch/project analysis, architecture/planning, broad/project-wide review, project-wide refactor strategy, complex/risky multi-file implementation, stateful parser/scanner/tokenizer work with broad grammar/ownership uncertainty, or memory recall, call chalin_route first. Bounded docs-only artifacts, bounded read-only mini-project reviews, bounded scaffolding, named-file bugfixes, named-file refactors, and simple implementation with explicit acceptance criteria should stay direct unless evidence shows state/risk beyond native work.",
          "Docs/no-code with one explicit docs artifact starts native: gather a bounded evidence set, update only that artifact, read it back, and answer. Escalate to chalin_route only after concrete evidence shows the artifact needs broad/unbounded synthesis that would pressure parent context. Architecture/refactor docs need a current→target responsibility/ownership map and evidence-derived validation, not a generic code-edit checklist. Final Verification is the updated docs readback; searches/grep are Notes.",
          "For explicit small bugfix/test requests with named files, inspect the target files once, edit promptly, and verify. Do not route or dry-run unless the change is broad, destructive, a security-sensitive mutation, or ambiguous.",
          "Also call chalin_route for risky surgical/long-file edits or stateful grammar/scanner changes only after a cheap target read shows broad grammar coupling, ambiguous transition ownership, unsafe surgery, or repeated local verification failure; use scout → planner → worker → reviewer so the edit stays targeted and verified.",
          "If the user asks to compare independent approaches/options, choose chalin_route with parallel planners/reviewers and synthesize the recommendation afterward.",
          "Choose topology/agents yourself. Use one chalin_route call only, then synthesize from its handoff; do not inspect files directly unless a concrete gap remains.",
          ctx.hasUI ? undefined : "Non-interactive mode: avoid dry-run for safe bounded edits; either edit directly or run a real chalin_route. Use dryRun only for destructive/high-risk/ambiguous work that genuinely needs user review.",
          "Simple chat, definitions, one obvious command, tiny isolated edits, bounded read-only mini-project reviews, named-file bugfixes/refactors, or bounded scaffolding/simple implementation with explicit files stay direct. Direct mode must satisfy every explicit criterion: requested helpers/tests/docs, requested language/toolchain, no unrequested deps, behavior preservation, existing conventions, exact requested files/APIs, executable metadata, runner-discoverable tests, and fixed verification failures.",
          "For behavior changes, derive the contract from prompt+repo evidence before coding. Tests are contract oracles: preserve starter assertions unless disproven, add focused independent assertions plus one representative boundary/counterexample when tests are requested or existing coverage is insufficient, cover changed behavior and preservation/no-op paths, and change implementation before changing expectations unless evidence proves the expectation wrong. For broken-test triage where the existing failing test already captures the user-visible bug and the user did not ask for new tests, fix the implementation and rerun that test before expanding coverage. Preserve public compatibility by default: do not add stricter throws/panics, normalization, mutation, or API-shape changes unless prompt, existing tests, docs, or domain evidence require them. If the prompt names a narrow token, flag, path segment, format, or subdomain, change only that subdomain and add one adjacent non-target preservation assertion. When changing one component inside a structured value, split it from adjacent metadata before comparing, normalize only that component, then recombine unchanged metadata. If a delimiter/quoted/protected segment must be a separate token/entity even when adjacent, tests must prove it separates from both previous and next unprotected text instead of merging with either side. Specific equivalence examples do not imply a whole-family rewrite; preservation means keep existing unrelated suffixes/delimiters, not invent them globally. Text/query filters: test trim/blank, no-match, and order when relevant.",
          "For path-bounded code+test work, keep the loop tight: small evidence set, one combined implementation/test edit when possible, one nearest verification, one focused corrective edit per failed verification, then final. Use changed-file readback only when the latest edit output is incomplete or a specific final claim needs evidence. Final must cite exact implementation path plus test/evidence path; command-only verification evidence is incomplete after code changes. Existing large/partial files use targeted edits; tiny fully read stub files may be full-file replaced once when simpler than brittle patching. Prefer idiomatic ownership/resources; avoid leaks, globals, arbitrary fixed caps, unsafe casts, warning suppression, or resource escape hatches unless evidence requires them.",
        ].filter((line): line is string => Boolean(line)).join("\n"),
        display: false,
      },
    };
  });

  pi.on("agent_end", (_event, ctx) => {
    clearPendingToolStarts(pi);
    setChalinStatus(ctx, { kind: "idle" });
  });

  pi.on("tool_execution_start", (event) => {
    rememberToolStart(pi, event);
  });

  pi.on("tool_execution_end", (event, ctx) => {
    if (["chalin_route", "chalin_resume"].includes(event.toolName)) {
      if (event.isError) return;
      const blockedReason = chalinRouteBlockedReason(event);
      if (blockedReason) {
        pi.sendMessage({
          customType: "pi-chalin-route-blocked-nudge",
          content: `${event.toolName} did not execute work (${blockedReason}). Do not claim completion from that result. If the user's request is a safe explicit edit, continue directly with native tools; otherwise explain the blocker.`,
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
    const { shouldProgressNudge, shouldReadyToVerifyNudge, shouldFailureNudge, shouldCompletionNudge, shouldTestCoverageNudge, shouldDocsShellNudge, shouldPostVerificationShellNudge, shouldPostVerificationExplorationNudge, shouldDocsEvidenceLoopNudge, shouldLocatorLoopNudge, shouldExistingFileRewriteNudge, shouldMutationLoopNudge, shouldSourceAndTestReadyNudge, shouldVerificationLoopNudge, shouldPostFailureEvidenceNudge, verificationCommand, docsOnlyMutation } = recordDirectToolCompletion({
      toolName: event.toolName,
      isError: event.isError,
      command: typeof eventArgs?.command === "string" ? eventArgs.command : fallbackArgs?.command,
      path: typeof eventArgs?.path === "string" ? eventArgs.path : fallbackArgs?.path,
      argsText: eventArgs ? JSON.stringify(eventArgs) : fallbackArgs?.argsText,
    });
    if (shouldDocsEvidenceLoopNudge) {
      pi.sendMessage({
        customType: "pi-chalin-docs-evidence-loop-nudge",
        content: "You have already gathered enough docs evidence/search surfaces before editing. Stop ls/find/grep now: write the requested docs artifact, name unresolved surfaces as searched/not-found, then read back the artifact. Do not restart discovery unless readback proves a specific missing required field.",
        display: false,
      }, { triggerTurn: false, deliverAs: "steer" });
    }
    if (shouldLocatorLoopNudge) {
      pi.sendMessage({
        customType: "pi-chalin-direct-locator-loop-nudge",
        content: "You already have target read/search evidence before changing files. Stop trying locator variants: pick the highest-confidence source/test candidates from current output, read only a missing candidate if needed, then edit or report the exact blocker. Run another search only if the candidate read proves the symbol/API is absent.",
        display: false,
      }, { triggerTurn: false, deliverAs: "steer" });
    }
    if (shouldExistingFileRewriteNudge) {
      pi.sendMessage({
        customType: "pi-chalin-direct-existing-file-write-nudge",
        content: "You used write on an existing file already read this turn. Treat existing files as patch targets: keep unrelated sections byte-stable, prefer edit for follow-up changes, and read back the changed file before verification. If a full rewrite was necessary, final Notes must name the concrete reason.",
        display: false,
      }, { triggerTurn: false, deliverAs: "steer" });
    }
    if (shouldMutationLoopNudge) {
      pi.sendMessage({
        customType: "pi-chalin-direct-mutation-loop-nudge",
        content: "Several edits/writes happened before a passing verification. Stop rewriting whole files. Reuse the current changed files and last tool output, patch the smallest root-cause block, then run the nearest verification once. If you already have a later passing verification after the latest edit, final now instead of rerunning it. If the issue is data structure capacity, prefer resizing or explicit error handling over fixed caps or silent drops.",
        display: false,
      }, { triggerTurn: false, deliverAs: "steer" });
    }
    if (shouldSourceAndTestReadyNudge) {
      pi.sendMessage({
        customType: "pi-chalin-direct-source-test-ready-nudge",
        content: [
          "Source and tests changed. Stop expanding scope and verify the actual contract now.",
          "Before verification, convert the contract into assertions: changed behavior, one boundary/counterexample, and one preservation/no-op path. For user text/query input, blank means whitespace-only too; do not treat only the empty string as coverage.",
          "For text/query filters, visible assertions must cover blank/whitespace, no-match empty result, optional/missing fields when applicable, and order preservation. No-op tests assert behavior/order, not object/array identity unless identity is explicit contract. Before bash, manually check expected IDs/rows against fixture terms; avoid broad one-character queries unless every intended match was computed.",
          "For parser/scanner/tokenizer/state-machine work, visible tests must cover each changed delimiter/state: adjacency before and after unprotected text, protected text, termination, escaping/quoting, EOF/error behavior, and delimiter-like text inside protected states when supported. Do not add unrelated token families such as punctuation splitting unless the prompt requires them.",
          "Make sure requested package/API/docs metadata exists when relevant.",
          "If this steer arrives after a later passing verification for the latest edit, treat the contract as satisfied and final now; do not rerun verification just because this message says verify.",
          "Do not read/rewrite more files before verification just to inspect your own edits. Existing files remain patch targets; no full rewrite after source+test edits unless the edit output was incomplete.",
          "If verification fails, use that concrete failure for one focused root-cause patch. If it passes, final immediately; use one changed-file readback only when the latest edit output is incomplete or a specific final claim needs evidence.",
        ].join("\n"),
        display: false,
      }, { triggerTurn: false, deliverAs: "steer" });
    }
    if (shouldVerificationLoopNudge) {
      pi.sendMessage({
        customType: "pi-chalin-direct-verification-loop-nudge",
        content: "Verification is looping. Do not run another check until one focused edit addresses the latest failure. If the latest verification passed, use one changed-file readback and final.",
        display: false,
      }, { triggerTurn: false, deliverAs: "steer" });
    }
    if (shouldPostFailureEvidenceNudge) {
      pi.sendMessage({
        customType: "pi-chalin-direct-post-failure-evidence-nudge",
        content: [
          "A verification failure already gave you a concrete signal, and you have now spent multiple tools investigating without editing.",
          "Stop diagnostic probing. Patch the smallest root cause from the failure plus current evidence, then rerun the nearest verification once. If the needed API is still unknown, use one targeted read of official/local docs or existing tests, not more exploratory shell probes.",
        ].join("\n"),
        display: false,
      }, { triggerTurn: false, deliverAs: "steer" });
    }
    if (shouldDocsShellNudge) {
      pi.sendMessage({
        customType: "pi-chalin-docs-only-shell-nudge",
        content: "This prompt names only docs artifacts. Stop running shell verification or build/test discovery. Gather minimal evidence before the docs write/edit; after the write, only read the updated docs artifact and answer. Document searched/not-found gaps instead of chasing more tools. Do not include failed/disallowed shell commands as final Verification.",
        display: false,
      }, { triggerTurn: false, deliverAs: "steer" });
    }
    if (shouldPostVerificationShellNudge) {
      pi.sendMessage({
        customType: "pi-chalin-post-verification-shell-nudge",
        content: "Verification already passed and no later edit was observed. Stop running shell/test commands; final now. Use changed-file readback only when the previous edit result was incomplete or a specific final claim lacks evidence. If this command exposed a concrete defect, edit that root cause and rerun the nearest verification once.",
        display: false,
      }, { triggerTurn: false, deliverAs: "steer" });
    }
    if (shouldPostVerificationExplorationNudge) {
      pi.sendMessage({
        customType: "pi-chalin-post-verification-exploration-nudge",
        content: "Verification already passed and no later edit was observed. Stop post-verification discovery: final now. Do not read back just to summarize; use changed-file readback only when the previous edit result was incomplete or a specific final claim lacks evidence. If this tool exposed a concrete defect, patch that root cause and rerun the nearest verification once.",
        display: false,
      }, { triggerTurn: false, deliverAs: "steer" });
    }
    if (shouldProgressNudge) {
      pi.sendMessage({
        customType: "pi-chalin-direct-progress-nudge",
        content: docsOnlyMutation
          ? "Docs changed. Read the updated artifact next; do not run find/grep/bash after the write. If a named surface is still unresolved, mark it searched/not-found from gathered evidence. Then final with Changed, Verification, Notes naming exact evidence paths."
          : [
            "Files changed. Keep the loop proportional: finish the nearest source/test contract, run one focused verification, then use only concrete failures for one root-cause patch.",
            "If the user requested tests or the test path is known/obvious, do not run the first verification after a source-only edit; edit or add the focused tests first.",
            "For inline source tests on collection/key transforms, manually check expected outputs retain every non-empty input exactly once unless dedupe/drop is explicit.",
            "Preserve compatibility unless repo evidence or the prompt requires a narrower behavior change. For package/CLI/API work, verify metadata, exports, real command path, and runner-discoverable tests when relevant.",
            "After a passing verification, final with supported claims instead of restarting discovery. Do not read back just to summarize; read changed files only for concrete missing evidence.",
          ].join("\n"),
        display: false,
      }, { triggerTurn: false, deliverAs: "steer" });
    }
    if (shouldReadyToVerifyNudge) {
      pi.sendMessage({
        customType: "pi-chalin-direct-ready-to-verify-nudge",
        content: docsOnlyMutation
          ? "Docs-only edit ready. No bash. Read updated docs; revise only for unresolved named surfaces, otherwise final."
          : [
            "Implementation changed and verification is pending. Stop broad exploration. Escalate to chalin_route only if the latest evidence proves real breadth, ambiguity, repeated failure, or context pressure.",
            "If a later verification after the latest edit already passed, this pending-verification steer is stale: final now and do not run another shell/test command.",
            "Run the nearest meaningful verification once. If it fails, fix only the root cause and rerun after the final edit.",
          ].join("\n"),
        display: false,
      }, { triggerTurn: false, deliverAs: "steer" });
    }
    if (shouldTestCoverageNudge) {
      pi.sendMessage({
        customType: "pi-chalin-direct-test-coverage-nudge",
        content: [
          "Verification passed after a source edit, but no separate test-path edit was observed.",
          "Do NOT final with command-only evidence. If focused assertions live inline in the changed source file, or exact existing tests already cover the requested behavior and boundary, cite the exact test/evidence path and assertions before finishing. Otherwise add the missing focused test(s) and rerun nearest verification once.",
          "Prefer one targeted boundary or preserve/no-op assertion over broad generated matrices.",
        ].join("\n"),
        display: false,
      }, { triggerTurn: false, deliverAs: "steer" });
    }
    if (shouldFailureNudge) {
      const commandText = verificationCommand ? `\`${verificationCommand}\`` : "the verification command";
      pi.sendMessage({
        customType: "pi-chalin-direct-verification-failed-nudge",
        content: [
          `${commandText} failed after file changes. Do NOT answer as done yet.`,
          "Use the latest failure as evidence. Change tests only when prompt+repo evidence proves the expectation is wrong; otherwise fix implementation. Do not broaden parser/tokenizer behavior to unrelated token classes just to satisfy one failing assertion.",
          "Patch the exact failing source or assertion from the error output. Do not grep/find/read broad surfaces for a known symbol; use at most one targeted read of an already changed file only if the failure output is insufficient.",
          "If you already made a later edit and the nearest verification after that edit passed, this failure is superseded: final now instead of rerunning the same command.",
          "Keep the repo runner/package manager and requested files/APIs/toolchain coherent. Rerun nearest verification after the final edit; stale or failed verification is invalid.",
        ].join("\n"),
        display: false,
      }, { triggerTurn: false, deliverAs: "steer" });
    }
    if (!shouldCompletionNudge) return;
    const commandText = verificationCommand ? `\`${verificationCommand}\`` : "the verification command";
    const changedPaths = getDirectChangedPaths();
    const changedPathText = changedPaths.length > 0
      ? changedPaths.map((item) => `\`${item}\``).join(", ")
      : "the changed files";
    const completionContent = docsOnlyMutation
      ? [
        `You changed docs and verified them with ${commandText}.`,
        `Readback required before final: ${changedPathText}. If the latest readback was before the final edit, read the updated artifact now; do not run shell/build/test commands for docs-only work.`,
        "If requested fields are missing, placeholder/TODO, or inconsistent with evidence, edit once and read back again. Otherwise answer now.",
        "Final should be high-signal and evidence-backed, not artificially tiny:",
        "- Changed: `docs/path.md` plus the substantive artifact fields updated",
        `- Verification: ${commandText} readback`,
        "- Notes: exact evidence paths, current symbols/APIs used, and any unresolved searched/not-found surface.",
      ].join("\n")
      : [
        `You changed files and ran ${commandText}.`,
        `Final now if the last edit output plus ${commandText} already prove the requested behavior. For one-file/path-bounded tasks with visible edit output and a passing runner, readback after pass is waste. Use one changed-file readback (${changedPathText}) only when the latest edit output is incomplete or a specific final claim needs evidence.`,
        "If requested API/tests/docs/manifest/bin/export/toolchain or verification evidence is missing, edit it and rerun verification. Otherwise answer now; do not run another shell/test command unless you edit again or the last output was not passing.",
        "Final should be concise but complete enough for review; do not hide meaningful evidence just to be short:",
        "- Changed: `path/to/file`[, `path/to/test`]",
        `- Verification: ${commandText} passed only if the command output showed success and no failure/assertion/error appeared`,
        "- Notes: requested behavior/constraints, exact implementation path, and important boundary/preservation evidence.",
      ].join("\n");
    pi.sendMessage({
      customType: "pi-chalin-direct-completion-nudge",
      content: completionContent,
      display: false,
    }, { triggerTurn: false, deliverAs: "steer" });
  });

  pi.on("session_shutdown", () => {
    // No background auto-routing workers are owned by this module anymore.
    // Subagent execution is driven through the chalin_route tool and Pi's native
    // abort signal.
  });
}

export function resetAutorouteToolStateForTests(): void {
  // WeakMap intentionally has no clear(); tests use fresh fake APIs, so this is
  // a marker hook for symmetry with runtime-state resets.
}

function rememberToolStart(pi: ExtensionAPI, event: unknown): void {
  const toolName = (event as { toolName?: unknown }).toolName;
  if (typeof toolName !== "string" || !toolName) return;
  const args = (event as { args?: unknown }).args;
  if (!args || typeof args !== "object") return;
  const pending = pendingArgsFor(pi);
  const queue = pending.get(toolName) ?? [];
  queue.push({
    command: stringArg(args, "command"),
    path: stringArg(args, "path") ?? stringArg(args, "filePath") ?? stringArg(args, "file"),
    argsText: JSON.stringify(args),
  });
  pending.set(toolName, queue);
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

async function globalMemoryContextForPrompt(cwd: string, prompt: string): Promise<string | undefined> {
  const query = prompt.trim();
  if (query.length < 8) return undefined;
  try {
    const bundle = await createConfiguredMemoryStore({ cwd }).retrieve({
      query,
      sourceAgent: "primary-pi-global",
      limit: 5,
      tokenBudget: 520,
    });
    if (bundle.results.length === 0 || !bundle.text.trim()) return undefined;
    return [
      "## pi-chalin global memory context",
      bundle.text,
      "Use these memories as soft guidance for this turn, including direct-mode work. Current repository evidence and explicit user instructions override memory; if evidence contradicts memory, prefer the evidence and repair memory when a memory tool is available.",
    ].join("\n");
  } catch {
    return undefined;
  }
}

export function shouldUseCompactDirectOrchestrationPrompt(prompt: string): boolean {
  if (!prompt.trim()) return false;
  const pathMentions = promptPathMentions(prompt);
  return pathMentions.length > 0 && pathMentions.length <= 6;
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

function compactGeneralSteeringMessage(): string {
  return [
    "pi-chalin compact orchestration: use LLM judgment; the code does not classify prompts for you.",
    "Mode gate: First decide route, then tools. `chalin_route` is orchestrated mode and must be the first tool when chosen; native tools mean lean direct mode. Do not spend read/bash/grep/find/ls calls deciding what the route tool is for.",
    "Use `chalin_route` only when context isolation is likely to improve quality or reduce parent context pressure: current branch/diff/PR summaries, project understanding, deep project analysis, architecture/migration, broad review/audit, risky multi-file implementation, risky surgical/long-file edits, parser/scanner/tokenizer changes with broad grammar/ownership uncertainty, independent option comparison, explicit memory recall, continuation/resume intent, or unresolved ambiguity. If parent context that compaction becomes likely, route or split work into subagents.",
    "Stay native for simple chat, one obvious command, bounded read-only mini-reviews that explicitly forbid file modification should stay native, tiny isolated edits, named-file bugfixes/refactors, a specific function/symbol/API plus local verification, and one small package/module/class/function implementation with tests and no prompt paths stays native.",
    "For small bounded package/class/function work without prompt paths, Infer conventional paths from prompt identifiers before searching; read likely source+tests once, edit source+tests together, then verify. Parser/scanner/tokenizer is not a routing keyword; route only after evidence proves broad grammar ownership, unsafe transition coupling, repeated local verification failure, or parent context pressure.",
    "Lean direct loop: exact target read(s), no broad crawl, batch implementation+tests, run nearest verification once, one root-cause rerun if needed, then final. Existing large/partial files use targeted edits; tiny fully read stubs may be replaced in one write per file. Use changed-file readback only for concrete missing evidence.",
    "Direct quality contract: derive expected behavior before coding; preserve public behavior unless evidence requires change; cover changed behavior plus no-op/boundary/error paths. For broken-test triage with an existing failing test and no request for new tests, fix the source and rerun that test before adding coverage. Strict decoders/parsers consume the full input: whitespace-only counts as empty, and trailing non-whitespace data after a valid value is an error. If capacity/limit, cover negative/zero/one and update-without-growth. Go exported APIs get concise doc comments when local style expects them. Text/query filters: trim/blank, no-match, order.",
    "Scaffolds need exact requested files, package/bin/config metadata, exports, runner-discoverable cases, real command path, docs when requested, no placeholders/TODO, no fake builds, and no zero-test assertion scripts. Prefer separate named tests for critical branches over table helpers that collapse many cases into one reported runtime test. Security/crypto/auth validation gets missing/invalid/negative tests and constant-time/resource-safe APIs when the domain calls for it; HMAC SHA-256 hex signatures are exactly 64 hex chars and need a well-formed-but-wrong signature test.",
    "Time/window/retry/cache/rate/budget: use internal test seams or runner-native fake timers over global monkeypatches and wall-clock sleeps; if the runner exposes `vi`, prefer `vi.useFakeTimers`/`advanceTimersByTime` over invented timer APIs.",
  ].join("\n");
}

function compactPathSteeringMessage(prompt: string, hasUI?: boolean): string {
  const promptPaths = promptPathMentions(prompt);
  const onlyDocsPaths = promptPaths.length > 0 && promptPaths.every(isDocsMarkdownPath);
  const hasDocsPath = promptPaths.some(isDocsMarkdownPath);
  const pathContract = promptPaths.length > 0
    ? `Prompt paths: ${promptPaths.map((item) => `\`${item}\``).join(", ")}. Use per user wording`
    : "No prompt paths were extracted; use the full orchestration prompt on the next turn if scope is unclear.";
  if (onlyDocsPaths) {
    return [
      "pi-chalin compact docs-artifact preflight: code supplied only structural path evidence; use LLM judgment for intent and risk.",
      hasUI ? undefined : pathContract,
      "First decide route, then tools. Docs-only work with one explicit docs artifact should start native: do one bounded evidence pass, update only the requested artifact, read it back, and finish. Escalate to `chalin_route` only after concrete evidence shows broad synthesis, multiple independent ownership surfaces, or parent-context pressure that native work cannot handle cleanly.",
      "Suggested route after native evidence proves escalation is needed: scout tight evidence map -> planner or reviewer when design judgment is needed -> worker updates only requested docs -> reviewer/readback if risk is nontrivial.",
      "Docs/no-code: update only requested docs artifacts; do not change product code.",
      "A final answer that only says what you will do is invalid for a requested docs mutation; write/edit the artifact and read it back first, or report a concrete blocker if mutation is impossible.",
      "Native docs mode: one compact discovery pass, read the smallest credible evidence set, avoid repeated find/grep/ls variants, and make searched/not-found gaps explicit. For cross-language/runtime docs plans, before writing read and cite one concrete source file per named surface (CLI, binding, runtime, parser, resolver, etc.); if a surface is missing, use one targeted find for that surface, then write with explicit searched/not-found notes.",
      "Preserve the user's explicit scenario, failure trigger, and requested artifact fields. Do not substitute an easier adjacent issue for the requested one.",
      "Causal consistency check: the artifact's current state, root cause, reproduction, fix plan, validation, and rollback must all point back to the user's exact failure trigger/counterexample.",
      "The docs artifact must be polished, self-contained, and proportional. Depth means causal precision and evidence, not repetitive section count; prefer compact sections that cover each requested field once. Include current state, target state, staged plan, risks, rollback/compatibility strategy, validation, ownership/responsibility, and acceptance criteria when requested or implied.",
      "If staying native, after writing docs the next tool must be `read` on the updated docs artifact. Treat readback as a quality gate: truncated, mid-sentence final lines, dangling headings/lists, placeholder/TODO, missing requested fields, or scenario drift means edit once and read back again before final.",
      "Native final should be concise but complete: Changed, Verification, and Notes with exact evidence paths, requested artifact fields covered, substantive conclusions, and unresolved searched/not-found gaps when relevant. Do not add shell/build/test claims for docs-only work.",
    ].filter((line): line is string => Boolean(line)).join("\n");
  }
  if (shouldUseMinimalBoundedPathSteering(prompt, promptPaths)) {
    return minimalBoundedPathSteeringMessage(promptPaths, hasUI);
  }
  return [
    "pi-chalin compact path preflight: use LLM judgment; paths structural. Mode gate: `chalin_route` is orchestrated mode and should be first if chosen; native tools mean lean direct mode.",
    "Named source/test/config plus local verification start native: read exact files; route only if reads prove broad ownership, migration, generated/cross-runtime coupling, unsafe long-file or grammar risk.",
    "Code+test direct preference: one behavior starts native; escalate to `chalin_route` only when evidence proves broader scope, repeated failure, context pressure, or parser/scanner/tokenizer transition risk that cannot be validated locally.",
    "If scope broadens, name the unresolved surface; do not broad-scan.",
    hasUI ? undefined : pathContract,
    hasUI ? undefined : "Bounded native: first tool `read` listed files; no parent `ls`. Read nearest test/include; if unnamed, try `test/<stem>.test.*` before find. If target read shows inline tests/test module, update there; no find/ls for separate tests. With exact source/runner, skip grep/find/ls and manifest/config; after reading named source, do not grep the same symbol/file. Existing large/partial files use targeted edits; tiny fully read stubs may be replaced once. Tests requested: batch implementation+tests before first verification. One focused verification, one root-cause rerun, then final. Readback only for concrete missing evidence.",
    hasDocsPath ? "Docs/no-code: write requested docs only, use one bounded discovery pass, cite exact existing evidence paths and current symbols/APIs, include rollback/compatibility and responsibility/ownership maps when requested, use evidence-derived validation not generic code-edit checklists, then read the artifact and final; no shell/build/test unless explicitly requested." : undefined,
    directWorkContract(),
    "Scaffold/API: exact files/APIs, package/bin/config metadata, exports, language/toolchain, and runner agree. Tests register runner-discoverable cases; zero-test assertion scripts are invalid. Prefer separate named tests for critical branches over table helpers that collapse many cases into one reported runtime test. CLI tests cover logic, real command path, and argument/no-input. Respect implied dirs/extensions/languages/runners; TypeScript unless convention proves otherwise. No fake builds/duplicate logic. No placeholders/TODO. Security/crypto/auth validation gets missing/invalid/negative tests and constant-time/resource-safe APIs when the domain calls for it; HMAC SHA-256 hex signatures are exactly 64 hex chars and need a well-formed-but-wrong signature test. Timer tests use runner-native fake timers; if `vi` exists, prefer `vi.useFakeTimers`/`advanceTimersByTime` over invented timer APIs.",
    "Final: Changed, Verification, Notes. Cite implementation and test/evidence paths plus key boundary/preservation tests. Stop after pass/docs verification.",
  ].filter((line): line is string => Boolean(line)).join("\n");
}

function shouldUseMinimalBoundedPathSteering(prompt: string, promptPaths: string[]): boolean {
  return promptPaths.length === 1
    && !isDocsMarkdownPath(promptPaths[0] ?? "")
    && hasExplicitVerificationRunner(prompt)
    && looksLikeSourceOrTestPath(promptPaths[0] ?? "");
}

function minimalBoundedPathSteeringMessage(promptPaths: string[], hasUI?: boolean): string {
  const pathContract = promptPaths.length > 0 ? `Prompt path: \`${promptPaths[0]}\`.` : undefined;
  return [
    "pi-chalin minimal bounded path: stay native unless target read proves broad ownership, generated/cross-runtime coupling, unsafe surgery, or repeated verification failure.",
    hasUI ? undefined : pathContract,
    "Use the named runner. First tool `read` the prompt path. Inline tests/test module: edit there; no separate-test search. Otherwise read nearest obvious test path, then edit implementation+tests before first verification. Existing prompt path uses edit, not write. No ls/grep/find/manifest unless target read/runner failure proves a missing path. Do not loop baseline verification before mutation.",
    "Contract from prompt+repo: preserve public behavior; assert changed behavior, one boundary/counterexample, and one no-op/preservation path. No-op means behavior/order, not reference identity.",
    "Collection/text/key transforms: assert trim/blank/no-match when relevant, deterministic order, same output for shuffled input order, duplicate/case preservation when requested, and every retained input once unless dedupe/drop is explicit. Keep determinism/order as its own visible assertion.",
    "URL/path/string normalizers: test query/fragment composition, non-target/no-path preservation, and credentials/metadata removal.",
    "Rust: prefer full lowercase unless ASCII-only, borrowed &str after trim when output permits, and sort_unstable unless stable ordering is required. No Box::leak/static leaks/unsafe escape hatches for string parsing; assemble owned String output. Warnings such as unused mut/imports/dead code count as defects; clean them before final.",
    "Run one focused verification, patch one root cause if it fails or warns, rerun once, then final. Read back changed files only for concrete missing evidence.",
  ].filter((line): line is string => Boolean(line)).join("\n");
}

function directWorkContract(): string {
  return [
    "Contract: derive expected behavior before coding; preserve public behavior unless evidence requires change. Tests keep starter assertions and add focused criteria plus one boundary/counterexample when requested or coverage is insufficient; for broken-test triage with an existing failing test and no request for new tests, source fix plus passing original failure can be enough. No-op assertions check behavior/order, not reference identity unless explicit. Validation splits empty, type/bound, and relational failures. Narrow token/flag/path/format/subdomain -> change only it and add adjacent preservation.",
    "Capture normalized config so caller mutation cannot change runtime semantics. Strict decoders/parsers consume the full input: whitespace-only counts as empty, and trailing non-whitespace data after a valid value is an error. Time/window/retry/cache/rate/budget prefers internal test seams or runner-native fake timers over global monkeypatches/wall-clock sleeps; if the runner exposes `vi`, prefer `vi.useFakeTimers`/`advanceTimersByTime` over invented fake-clock APIs. Do not expand public APIs unless evidence requires it. When the prompt names capacity/limit, cover negative/zero/one and update-without-growth boundaries.",
    "For transformations, test changed behavior, representative preservation/no-op behavior, boundaries, composition with nearby metadata/suffixes, and exact ordered output for deterministic/sorted contracts. Collection/key transforms cover normalization, empty filtering, duplicate/case preservation, same output for shuffled input order, and every retained input once unless dedupe/drop is explicit.",
    "Before verification, preflight new assertions: syntax/brackets compile, fixture terms hit intended rows, and expected sorted/filtered order follows the contract.",
    "For parsers/scanners/state machines, cover states/transitions, adjacency/protected text, termination, escaping, EOF/error, and previous/next separation. Do not invent unrelated token families such as punctuation splitting unless explicitly required.",
    "Text/query filters test blank/whitespace, no-match, optional/missing fields, and order preservation without adding broad matrices.",
    "Prefer low-allocation ownership; collections/tables resize or surface errors instead of fixed caps/silent drops; no leaks/unsafe without evidence. Go exported APIs get concise doc comments when you write them unless local style omits comments. In Rust text transforms, use full lowercase unless ASCII-only is required, prefer borrowed &str collections after trim when join/output permits, and use sort_unstable when stable ordering is not required.",
  ].join(" ");
}

function hasExplicitVerificationRunner(prompt: string): boolean {
  return /\b(cargo\s+test|bun\s+test|npm\s+(?:run\s+)?test|pnpm\s+(?:run\s+)?test|yarn\s+(?:run\s+)?test|make\s+(?:test|check)|go\s+test|pytest|vitest|jest|tsc\s+--noEmit)\b/i.test(prompt);
}

function looksLikeSourceOrTestPath(value: string): boolean {
  const normalized = value.replaceAll("\\", "/");
  const basename = pathBasename(normalized).toLowerCase();
  return normalized.includes("/src/")
    || normalized.startsWith("src/")
    || normalized.includes("/test/")
    || normalized.includes("/tests/")
    || basename.includes(".test.")
    || basename.includes(".spec.")
    || basename.startsWith("test_")
    || basename.endsWith("_test.rs")
    || basename.endsWith("_test.go")
    || basename.endsWith("_test.c")
    || basename.endsWith("_test.cc")
    || basename.endsWith("_test.cpp");
}

function promptPathMentions(prompt: string): string[] {
  const mentions = new Set<string>();
  for (const token of splitWhitespace(prompt)) {
    const value = trimTokenPunctuation(token);
    if (isPromptPathMention(value)) mentions.add(value);
  }
  return [...mentions];
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
  while (end > start && "`'\".,:;!?)]}>".includes(token[end - 1] ?? "")) end -= 1;
  return token.slice(start, end);
}

function isPromptPathMention(value: string): boolean {
  if (!value) return false;
  const normalized = value.replaceAll("\\", "/");
  if (normalized.includes("://")) return false;
  const segments = normalized.split("/");
  if (segments.some((segment) => segment.length === 0)) return false;
  const fileName = segments.at(-1) ?? "";
  if (!normalized.includes("/")) return looksLikeFileBasename(fileName);
  return fileName.includes(".");
}

function looksLikeFileBasename(fileName: string): boolean {
  return /\.(?:bash|c|cc|cjs|cpp|cs|css|go|h|hpp|html|java|js|json|jsx|kt|lock|md|mjs|php|py|rb|rs|scss|sh|sql|swift|toml|ts|tsx|txt|xml|ya?ml|zig)$/i.test(fileName);
}

function isDocsMarkdownPath(value: string): boolean {
  return value.startsWith("docs/") && value.endsWith(".md");
}

function pathBasename(value: string): string {
  const normalized = value.replaceAll("\\", "/");
  const segments = normalized.split("/");
  return segments.at(-1) ?? normalized;
}

function chalinRouteBlockedReason(event: unknown): string | undefined {
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
