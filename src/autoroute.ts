import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Effect } from "effect";
import { AgentCatalog } from "./agents.ts";
import { loadEffectiveConfig, type ChalinConfig } from "./config.ts";
import { createConfiguredMemoryStore } from "./memory-provider.ts";
import { buildCompactChalinOrchestratorSystemPrompt, buildChalinOrchestratorSystemPrompt } from "./orchestration.ts";
import { isUsableStepHandoff, loadResumableRunState } from "./runner-state.ts";
import { beginChalinTurn, getDirectChangedPaths, getDirectCriticalGuardContextMessage, getSkillOverridesForTurn, isDirectLeanBoundedTurn, isDirectStatefulTimeTurn, isDirectTestOnlyTurn, recordDirectToolCompletion } from "./runtime-state.ts";
import type { RunState } from "./schemas.ts";
import { SkillCatalog, formatActiveSkillsForPrompt } from "./skills.ts";
import { setChalinStatus } from "./ui-status.ts";

type PendingToolArgs = {
  command?: string;
  path?: string;
  argsText?: string;
};

const pendingToolStarts = new WeakMap<object, Map<string, PendingToolArgs[]>>();
const scopedToolSetRestore = new WeakMap<object, string[]>();
type ToolScopeRestoreMode = "decision" | "turn";
const scopedToolSetRestoreMode = new WeakMap<object, ToolScopeRestoreMode>();
type PiThinkingLevel = ReturnType<ExtensionAPI["getThinkingLevel"]>;
const orchestratorThinkingRestore = new WeakMap<object, PiThinkingLevel>();
const DIRECT_CHALIN_TOOL_NAMES = [
  "chalin_interview",
  "chalin_project_discovery",
  "chalin_project_snapshot",
  "chalin_route",
  "chalin_resume",
  "chalin_web_search",
  "chalin_memory_search",
  "chalin_memory_write",
  "chalin_memory_revise",
];
const BOUNDED_DIRECT_HIDDEN_TOOLS = new Set([...DIRECT_CHALIN_TOOL_NAMES, "grep", "find", "ls"]);
const GREENFIELD_DIRECT_HIDDEN_TOOLS = new Set([...DIRECT_CHALIN_TOOL_NAMES, "read", "grep", "find", "ls"]);
const ROUTE_ONLY_TOOLS = new Set(["chalin_route"]);

function runHookEffect<A>(span: string, run: () => A | Promise<A>): Promise<A> {
  return Effect.runPromise(Effect.tryPromise({ try: async () => run(), catch: (error) => error }).pipe(Effect.withSpan(span)));
}

export function registerChalinAutoRouter(pi: ExtensionAPI): void {
  pi.on("input", (event) => Effect.runPromise(inputGuardEffect(event)));

  pi.on("before_agent_start", (event, ctx) => runHookEffect("autoroute.beforeAgentStart", async () => {
    restoreScopedToolSet(pi);
    beginChalinTurn({ prompt: typeof event.prompt === "string" ? event.prompt : undefined, cwd: ctx.cwd });
    const loaded = loadEffectiveConfig({ cwd: ctx.cwd });
    if (!loaded.config.enabled) return;
    forceOrchestratorThinkingHigh(pi);
    const promptText = typeof event.prompt === "string" ? event.prompt : "";
    const resumableRun = loadResumableRunState({ cwd: ctx.cwd, recoverStale: false });
    const resumeContext = resumableRun ? compactResumeCandidateMessage(resumableRun) : undefined;
    const forceRouteFirst = shouldForceRouteFirst(promptText, Boolean(resumeContext));
    const useModeGate = shouldUseOrchestrationModeGate(promptText, Boolean(resumeContext), forceRouteFirst);
    const hiddenDirectTools = forceRouteFirst ? undefined : hiddenDirectToolsForPrompt(promptText, Boolean(resumeContext));
    if (forceRouteFirst) {
      applyToolAllowlist(pi, ROUTE_ONLY_TOOLS);
    } else if (useModeGate) {
      applyDecisionToolAllowlist(pi, ROUTE_ONLY_TOOLS);
    } else if (hiddenDirectTools) {
      applyDirectToolScope(pi, hiddenDirectTools);
    }
    const skipCompactPrompt = shouldSkipCompactPathPrompt(promptText, Boolean(resumeContext));
    if (skipCompactPrompt) {
      return {
        systemPrompt: event.systemPrompt,
        message: {
          customType: "pi-chalin-lean-package-local-path",
          content: leanPackageLocalPathSteeringMessage(promptText),
          display: false,
        },
      };
    }
    const useCompactPathPrompt = shouldUseCompactDirectOrchestrationPrompt(promptText);
    const useCompactBoundedReviewPrompt = !ctx.hasUI && !useCompactPathPrompt && promptLooksBoundedReadOnlyReview(promptText);
    const useCompactPrompt = useCompactPathPrompt || useCompactBoundedReviewPrompt;
    const useCompactGeneralPrompt = !ctx.hasUI && !useCompactPrompt;
    const catalog = useCompactPrompt || useCompactGeneralPrompt ? undefined : AgentCatalog.load({ cwd: ctx.cwd });
    const orchestrationPrompt = useCompactGeneralPrompt
      ? buildCompactChalinOrchestratorSystemPrompt()
      : useCompactPrompt
      ? ""
      : buildChalinOrchestratorSystemPrompt(catalog?.list() ?? []);
    const memoryContext = useCompactPrompt ? undefined : await globalMemoryContextForPrompt(ctx.cwd, promptText);
    const skillSignal = buildSkillSteeringMessage(ctx.cwd, loaded.config, promptText);
    const systemPrompt = [event.systemPrompt, orchestrationPrompt, memoryContext].filter((item) => item?.trim()).join("\n\n");
    return {
      systemPrompt,
      message: {
        customType: useCompactBoundedReviewPrompt ? "pi-chalin-review-compact-orchestration" : useCompactPathPrompt ? "pi-chalin-path-compact-orchestration" : useCompactGeneralPrompt ? "pi-chalin-compact-orchestration" : "pi-chalin-orchestration",
        content: useCompactBoundedReviewPrompt ? [resumeContext, skillSignal, compactBoundedReadOnlyReviewSteeringMessage(promptText, ctx.hasUI)].filter(Boolean).join("\n\n") : useCompactPathPrompt ? [resumeContext, skillSignal, compactPathSteeringMessage(promptText, ctx.hasUI)].filter(Boolean).join("\n\n") : useCompactGeneralPrompt ? [resumeContext, skillSignal, compactGeneralSteeringMessage(promptText)].filter(Boolean).join("\n\n") : [
          resumeContext,
          skillSignal,
          "If the current user intent is to continue an interrupted pi-chalin run, call chalin_resume before answering from partial findings.",
          "pi-chalin preflight: if this is branch/project analysis, current diff/PR/branch analysis, project/service structure with entrypoints or testing map, architecture/planning, broad/project-wide review, project-wide refactor strategy, complex/risky multi-file implementation, auth/security/token/session behavior with tests and no explicit source path, stateful parser/scanner/tokenizer work with broad grammar/ownership uncertainty, or independent option comparison, call chalin_route as the first tool unless the user explicitly asks for direct/native/no-subagent work. For explicit memory recall/remembrance or memory inventory/counts, including Spanish prompts like recuerda/recordar/memoria/decidimos, call chalin_memory_search as the first tool; use mode=list for inventory/count questions. Bounded docs-only artifacts, bounded read-only mini-project reviews, bounded scaffolding, named-file bugfixes, named-file refactors, and simple implementation with explicit acceptance criteria should stay direct unless evidence shows state/risk beyond native work.",
          "Direct exception: bounded read-only mini-project reviews that explicitly forbid file changes stay native even when they mention risk/security/auth boundaries. Gather bounded evidence and cite concrete paths; route only if the prompt also asks for deep/project-wide/exhaustive analysis or evidence proves the review is not actually bounded.",
          "Bounded read-only auth/security review: stay native when the prompt asks to review/analyze and not edit. Read package/manifest plus obvious auth/session/server/route files once; avoid repeated ls/find after source hits. Final findings-first and concise: code-proven core risks plus direct secondary risks only, severity, exact path/function evidence, exploit or bypass, impact, and remediation. No code changes, no tests, no broad project scan, no tutorial.",
          "Docs/no-code with one explicit docs artifact starts native only when the requested artifact is bounded/local. Deep architecture, migration, cross-language/runtime, dependency-map, ownership/responsibility, staged-plan, or project-wide refactor docs are routed work even when the mutation target is one docs file: call chalin_route first and have the routed workflow update only that artifact. For routed docs artifact mutations, choose the smallest agent set that can gather evidence, update only the artifact, and review artifact contract/evidence/gaps/readback. Evidence lock: docs may only claim concepts shown by prompt/source/test evidence; mark missing surfaces as searched/not-found instead of inventing fields or states. Completed docs must not contain literal TODO/TBD/WIP/placeholder tokens, even when describing the previous artifact state; omit that history or say previous stub without placeholder words. Architecture/refactor docs need a current→target responsibility/ownership map and evidence-derived validation, not a generic code-edit checklist. Deep architecture docs also need a problem taxonomy with evidence, data-flow/coupling map, target ownership/layers, staged migration with exit criteria, risk register with severity and mitigation, rollback strategy, phase checklist, and out-of-scope boundaries; future abstractions are useful only when clearly marked future or out-of-scope. Operational runbooks need evidenced current command/source state, concrete steps, test/typecheck commands only when evidenced, failure-mode diagnosis, isolated reproduction or smoke check, rollback options with VCS caveats, and unresolved gaps separated from bugs. Final Verification is the updated docs readback; searches/grep are Notes.",
          "For explicit small bugfix/test requests with named files, inspect the target files once, edit promptly, and verify. Do not route or dry-run unless the change is broad, destructive, a security-sensitive mutation, or ambiguous.",
          "Also call chalin_route for risky surgical/long-file edits or stateful grammar/scanner changes only after a cheap target read shows broad grammar coupling, ambiguous transition ownership, unsafe surgery, or repeated local verification failure; choose agents from the evidence and require worker execution plus final reviewer verification for any routed mutation.",
          "If the user asks to compare independent approaches/options, choose chalin_route with parallel planners/reviewers and synthesize the recommendation afterward.",
          "When routing, choose topology deliberately from the user prompt, available agents, and evidence. Use the smallest workflow that can prove the answer; add discovery, planning, parallelism, or synthesis only when it materially improves coverage or risk control. Do not route plain memory recall/inventory; use chalin_memory_search. Routed implementation/file mutation must include worker execution plus a later reviewer; if reviewer reports FAIL/GAP, continue with focused repair instead of finalizing.",
          "Choose topology/agents yourself. Use one chalin_route call only, then synthesize from its handoff; do not inspect files directly unless a concrete gap remains.",
          ctx.hasUI ? undefined : "Non-interactive mode: avoid dry-run for safe bounded edits; either edit directly or run a real chalin_route. Use dryRun only for destructive/high-risk/ambiguous work that genuinely needs user review.",
          "Simple chat, definitions, one obvious command, tiny isolated edits, bounded read-only mini-project reviews, named-file bugfixes/refactors, or bounded scaffolding/simple implementation with explicit files stay direct. Quality-equivalent bounded direct work should prefer lower cost/time/tool count over orchestration. Direct mode must satisfy every explicit criterion: requested helpers/tests/docs/README, requested language/toolchain, package runner coherence, no unrequested deps, behavior preservation, existing conventions, exact requested files/APIs, executable metadata, runner-discoverable tests, and fixed verification failures.",
          "For behavior changes, derive the contract from prompt+repo evidence before coding. Tests are contract oracles: preserve starter assertions unless disproven, add focused independent assertions plus one representative boundary/counterexample when tests are requested or existing coverage is insufficient, cover changed behavior and preservation/no-op paths, and change implementation before changing expectations unless evidence proves the expectation wrong. Canonical surface discipline: existing source stubs, starter test imports, exact prompt paths, and runner-discovered test files define the delivered surface; do not create parallel modules/tests with near-identical names just because a function name suggests another filename. Broken-test triage is not a coverage expansion task: if the existing failing test already captures the user-visible bug and the user did not ask for new tests, run/observe that failure if needed, fix the implementation, rerun the same nearest test, and final with source+test evidence; add tests only when the failing test is absent/inadequate or the prompt asks for coverage. Refactors improve internal structure without shrinking the typed/public contract: capture current behavior with approval-style API tests, triangulate with different inputs/outputs, prefer pure helpers where feasible, and keep type safety anchored in source-of-truth types rather than broad casts, duplicate type definitions, or object-bag typing. Typed refactors with object-shaped public returns should preserve an explicit source-of-truth return type/signature when local style allows it. Newly public/exported helpers should own their boundary semantics such as optional/default inputs when that makes the helper independently testable, get a short responsibility comment when expanding public surface and local style allows it, and be triangulated with zero/one/many or equivalent distinct cases plus one composed public-API case. If an extracted helper covers an optional/default public input, the helper owns that default so its unit tests can call the boundary directly. For formula, aggregation, or ratio refactors, derive equivalence classes from the existing operations: neutral/default value, meaningful extreme/ceiling/floor value, empty/one/many collection sizes when collections exist, rounding/formatting branch when present, and one composed public-API proof that helpers preserve the orchestration result. Each extracted formula helper with rounding/formatting/threshold logic needs its own non-integer or threshold case; the composed API proof should expose order-sensitive intermediates when operation order is part of the contract. Prefer standard-library parsers/serializers for known wire formats before hand-written split/regex logic, then layer prompt-specific normalization on top. Preserve public compatibility by default: do not add stricter throws/panics, normalization, mutation, or API-shape changes unless prompt, existing tests, docs, or domain evidence require them. If the prompt names a narrow token, flag, path segment, format, or subdomain, change only that subdomain and add one adjacent non-target preservation assertion. When changing one component inside a structured value, split it from adjacent metadata before comparing, normalize only that component, then recombine unchanged metadata. If a delimiter/quoted/protected segment must be a separate token/entity even when adjacent, tests must prove it separates from both previous and next unprotected text instead of merging with either side. Specific equivalence examples do not imply a whole-family rewrite; preservation means keep existing unrelated suffixes/delimiters, not invent them globally. Text/query filters: test trim/blank, no-match, and order when relevant.",
          "For path-bounded code+test work, keep the loop tight: small evidence set, one combined implementation/test edit when possible, one nearest verification, one focused corrective edit per failed verification, then final. Before writing tests/imports, infer the package runner from package.json/config/existing tests and keep assertion APIs compatible with the command that will run: node --test uses node:test/node:assert, bun test may use bun:test, Vitest uses vitest. Do not read back after passing verification just to build the final; use changed-file readback before verification only when the latest edit output is incomplete or a specific claim needs evidence. Final must cite exact implementation path plus test/evidence path; command-only verification evidence is incomplete after code changes. Existing large/partial files use targeted edits; tiny fully read stub files may be full-file replaced once when simpler than brittle patching. Prefer idiomatic ownership/resources; avoid leaks, globals, arbitrary fixed caps, unsafe casts, warning suppression, or resource escape hatches unless evidence requires them.",
        ].filter((line): line is string => Boolean(line)).join("\n"),
        display: false,
      },
    };
  }));

  pi.on("context", (event) => {
    const criticalGuard = getDirectCriticalGuardContextMessage();
    if (!criticalGuard) return;
    return {
      messages: [
        ...event.messages,
        {
          role: "custom",
          customType: "pi-chalin-direct-critical-guard",
          content: criticalGuard,
          display: false,
          timestamp: Date.now(),
        },
      ],
    };
  });

  pi.on("agent_end", (_event, ctx) => {
    clearPendingToolStarts(pi);
    restoreScopedToolSet(pi);
    restoreOrchestratorThinking(pi);
    setChalinStatus(ctx, { kind: "idle" });
  });

  pi.on("tool_execution_start", (event) => {
    restoreOrchestratorThinking(pi);
    restoreDecisionToolSet(pi);
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
    const { shouldProgressNudge, shouldReadyToVerifyNudge, shouldFailureNudge, shouldCompletionNudge, shouldTestCoverageNudge, shouldWeakTestCoverageNudge, shouldPackageMetadataNudge, shouldParallelSurfaceNudge, shouldWorkspaceBoundaryNudge, shouldDocsShellNudge, shouldDocsPreWriteShellNudge, shouldPreMutationVerificationNudge, shouldPostVerificationShellNudge, shouldPostVerificationExplorationNudge, shouldDocsEvidenceLoopNudge, shouldScaffoldEvidenceLoopNudge, shouldLocatorLoopNudge, shouldStatefulTimeNudge, shouldExistingFileRewriteNudge, shouldMutationLoopNudge, shouldSourceAndTestReadyNudge, shouldVerificationLoopNudge, shouldPostFailureEvidenceNudge, verificationCommand, docsOnlyMutation } = recordDirectToolCompletion({
      toolName: event.toolName,
      isError: event.isError,
      command: typeof eventArgs?.command === "string" ? eventArgs.command : fallbackArgs?.command,
      path: typeof eventArgs?.path === "string" ? eventArgs.path : fallbackArgs?.path,
      argsText: eventArgs ? JSON.stringify(eventArgs) : fallbackArgs?.argsText,
    });
    const statefulTimeTurn = isDirectStatefulTimeTurn();
    const testOnlyTurn = isDirectTestOnlyTurn();
    const leanDirectTurn = isDirectLeanBoundedTurn();
    if (shouldWorkspaceBoundaryNudge) {
      pi.sendMessage({
        customType: "pi-chalin-direct-workspace-boundary-nudge",
        content: "Hard stop: direct project work escaped the current workspace root. Do not write or verify in a home/sibling/tmp directory unless the user explicitly provided that absolute target. Recreate the required files under the current cwd using relative paths such as `package.json`, `src/...`, `test/...`, and `README.md`, then run verification from the current cwd. A final answer is invalid until the current workspace contains the delivered source, tests, docs, and manifest.",
        display: false,
      }, { triggerTurn: false, deliverAs: "steer" });
    }
    if (shouldDocsPreWriteShellNudge) {
      pi.sendMessage({
        customType: "pi-chalin-docs-prewrite-shell-nudge",
        content: "Docs runbook compact mode. Shell is allowed only because the user explicitly asked to validate/execute a command. Run at most one pre-write shell total: package test/diagnostic when available, or `git status` if VCS rollback evidence matters more. After that command evidence, write the docs artifact next: no find/grep/test discovery, second diagnostic, or second pre-write shell just to improve confidence. Cite the manifest/source paths that prove commands and behavior. Evidence lock: only claim prompt/source/test facts; do not invent timestamps, versions, labels, or state. Artifact shape: `Estado actual`/`Current state`, `Pasos`/`Steps`, rollback, quick reference, one inline smoke command with expected output, a 3-row symptom/cause/next-check table, compact cases/invariants only when they apply, and typecheck command only when `tsconfig` or script evidence exists. Test-file examples must use the evidenced test root such as `test/`. Rollback must be factual: if `git status` was not run or says not-a-git-repo, say VCS was not verified and do not present `git restore`/`git stash`/`git revert` as runnable current-repo steps; git belongs only in an optional initialize-git/checkpoint flow. One write, one readback, at most one corrective edit+readback for missing required facts; do not iterate on polish. End with one complete prose sentence; no shell after docs mutation.",
        display: false,
      }, { triggerTurn: false, deliverAs: "steer" });
    }
    if (shouldPreMutationVerificationNudge) {
      pi.sendMessage({
        customType: "pi-chalin-direct-pre-mutation-verification-nudge",
        content: "This bounded code+test task ran verification before any edit. Stop baseline checks now: edit the requested source plus focused tests, then run one nearest verification after mutation. Do not run another pre-edit test command.",
        display: false,
      }, { triggerTurn: false, deliverAs: "steer" });
    }
    if (shouldDocsEvidenceLoopNudge) {
      pi.sendMessage({
        customType: "pi-chalin-docs-evidence-loop-nudge",
        content: "You have enough docs evidence to mutate now. For operational docs/runbooks, after reading the requested artifact, manifest/package evidence, and one direct source/test/config surface, the next tool must write or edit the requested docs artifact. Stop ls/find/grep/bash now; name unresolved surfaces as searched/not-found, keep diagnosis tied to observed source/test concepts, then read back the artifact. Completed docs must not contain literal TODO/TBD/WIP/placeholder tokens, even as history about the old file. Do not restart discovery unless readback proves a specific missing required field.",
        display: false,
      }, { triggerTurn: false, deliverAs: "steer" });
    }
    if (shouldScaffoldEvidenceLoopNudge) {
      pi.sendMessage({
        customType: "pi-chalin-scaffold-evidence-loop-nudge",
        content: "You have enough scaffold/greenfield evidence before writing. Stop discovery now: create the requested product files in one compact pass, including package/bin/export metadata, README/API/usage docs when implied, and runner-discoverable tests. After the first verification, edit the exact root cause before any second bash.",
        display: false,
      }, { triggerTurn: false, deliverAs: "steer" });
    }
    if (shouldStatefulTimeNudge) {
      pi.sendMessage({
        customType: "pi-chalin-direct-stateful-time-nudge",
        content: [
          "Stateful/time-sensitive task drift: stop discovery once source and nearest tests are known.",
          "Batch source plus focused tests before the first verification. Cover the happy path, before/at/after the state transition when meaningful, and one state update or preservation path when the contract mutates stored state; overwrites should prove value plus deadline/window renewal when time matters. Derive boundary times from variables such as `expiresAt := setTime.Add(ttl)` and then use before/exact/past values from that variable; do not rely on mental timestamp arithmetic. Include independent entries/keys when public behavior can diverge per entry, and stagger their set times/windows when expecting one valid and one expired.",
          "Use fake/injected time or local deterministic state; no sleeps, broad matrices, or invented policy. Then run the nearest verification once and final from evidence.",
        ].join("\n"),
        display: false,
      }, { triggerTurn: false, deliverAs: "steer" });
    }
    if (shouldLocatorLoopNudge && !shouldStatefulTimeNudge) {
      pi.sendMessage({
        customType: "pi-chalin-direct-locator-loop-nudge",
        content: "You already have target read/search evidence before changing files. If the prompt names an exact path, after reading it, ls/find/grep variants are usually waste: edit the named file plus one direct test/config path, or report the exact blocker. Stop trying locator variants: pick the highest-confidence source/test candidates from current output, read only a missing candidate if needed, then edit or report the exact blocker. Run another search only if the candidate read proves the symbol/API is absent.",
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
        content: statefulTimeTurn ? [
          "Stateful/time source+test changed. Run one nearest verification now.",
          "Before running it, self-check: happy path, boundary at/around transition derived from variables, state update/preservation, deterministic fake/injected time or state, independent entries staggered when asserting divergent expiry, and no invented policy. If verification fails, patch one concrete root cause, rerun once, then final.",
        ].join("\n") : [
          "Source and tests changed. Stop expanding scope and run the nearest package verification now.",
          "Self-check before bash: changed behavior, one boundary/counterexample, one preservation/no-op path, runner-compatible imports/assertions, requested test path/glob/extension, and requested package/API/docs/README metadata when relevant. For scaffolds, docs/README are part of the pre-verification batch; do not add them after a passing test.",
          "If the changed test file only has an empty/smoke/no-op case while the prompt names several criteria, edit tests now instead of running bash; assertions must visibly cover the named criteria.",
          "Domain check only if relevant: text query blank/no-match/order; API payload missing/null/array/type/blank/format branches; parser/delimiter adjacency/protected/escaping/EOF including SQL doubled-quote strings when SQL-like; Python unittest discoverable `tests/` path; validation normalization-before-regex; explicit numeric/domain bounds fail fast; time/rate fake time with no sleeps; sort primary/secondary/tie/no mutation; string/slug categories once; numeric below/inside/above.",
          "Do not read/rewrite more files just to inspect your own edits. Tiny stubs may be replaced once; existing large/partial files stay targeted edits.",
          "If verification fails, patch the concrete root cause and rerun once. If it passes, final immediately; no changed-file readback after pass unless the verification output itself proves a concrete missing-artifact gap.",
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
        content: "Verification already passed and no later edit was observed. Stop running shell/test commands; final now. Do not read back after pass just to summarize; if this command exposed a concrete defect, edit that root cause and rerun the nearest verification once.",
        display: false,
      }, { triggerTurn: false, deliverAs: "steer" });
    }
    if (shouldPostVerificationExplorationNudge) {
      pi.sendMessage({
        customType: "pi-chalin-post-verification-exploration-nudge",
        content: "Verification already passed and no later edit was observed. Stop post-verification discovery: final now. Do not read back just to summarize; if this tool exposed a concrete defect, patch that root cause and rerun the nearest verification once.",
        display: false,
      }, { triggerTurn: false, deliverAs: "steer" });
    }
    if (shouldProgressNudge) {
      pi.sendMessage({
        customType: "pi-chalin-direct-progress-nudge",
        content: statefulTimeTurn
          ? "Stateful/time files changed. If nearest tests have not changed in this turn, the next tool must edit that test file now; do not final or run bash from source-only work. Keep tests compact for happy path, boundary, and state update/preservation, then run one nearest verification and final in 3 short bullets."
          : testOnlyTurn
          ? "Test-only edit done. Run the nearest test now, preferably the direct changed test file. No readback, package/config/search, or second edit unless that verification fails. After pass, final in exactly 3 bullets: Changed, Verification, Notes."
          : docsOnlyMutation
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
    if (shouldReadyToVerifyNudge) {
      pi.sendMessage({
        customType: "pi-chalin-direct-ready-to-verify-nudge",
        content: statefulTimeTurn
          ? "Stateful/time edit is ready only after source and nearest tests changed. If tests are still unchanged, edit them now; otherwise run one nearest verification now. No extra reads/search; after pass, final in 3 short bullets."
          : testOnlyTurn
          ? "Test-only edit is ready. Run the direct test file once now. If it passes, final immediately in 3 bullets; do not inspect files again just to summarize."
          : docsOnlyMutation
          ? "Docs-only edit ready. No bash. Read updated docs: the next tool must be read on the updated docs artifact; revise only for unresolved named surfaces, otherwise final."
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
    if (shouldWeakTestCoverageNudge) {
      pi.sendMessage({
        customType: "pi-chalin-direct-weak-test-coverage-nudge",
        content: [
          "Verification passed, but the latest test write looked like trivial smoke/empty coverage for a source change.",
          "Do NOT final yet. Edit the nearest test file so assertions visibly cover the prompt-named criteria plus one boundary or preservation path, then rerun the nearest verification once.",
          "Keep it compact; do not broaden into an unrelated matrix.",
        ].join("\n"),
        display: false,
      }, { triggerTurn: false, deliverAs: "steer" });
    }
    if (shouldPackageMetadataNudge) {
      pi.sendMessage({
        customType: "pi-chalin-direct-package-metadata-nudge",
        content: [
          "Verification passed, but package metadata looks incomplete for the delivered scaffold entrypoints.",
          "Do NOT final yet. Patch package metadata so module format and delivered bin/main/exports agree with the source files, then rerun the nearest package verification once.",
          "Do not add build/dist indirection unless those artifacts are generated and tested.",
        ].join("\n"),
        display: false,
      }, { triggerTurn: false, deliverAs: "steer" });
    }
    if (shouldParallelSurfaceNudge) {
      pi.sendMessage({
        customType: "pi-chalin-direct-parallel-surface-nudge",
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
        customType: "pi-chalin-direct-verification-failed-nudge",
        content: [
          `${commandText} failed after file changes. Do NOT answer as done yet.`,
          "Use the latest failure as evidence. Change tests only when prompt+repo evidence proves the expectation is wrong; otherwise fix implementation. Do not broaden parser/tokenizer behavior to unrelated token classes just to satisfy one failing assertion.",
          "Patch the exact failing source or assertion from the error output. Do not grep/find/read broad surfaces for a known symbol; use at most one targeted read of an already changed file only if the failure output is insufficient.",
          "If verification discovers fewer tests than you wrote, move/merge the substantive coverage into the runner-discovered test path before claiming completion.",
          "If you already made a later edit and the nearest verification after that edit passed, this failure is superseded: final now instead of rerunning the same command.",
          "Keep the repo runner/package manager and requested files/APIs/toolchain coherent. If package.json/config says `npm test` -> `node --test`, tests must use node:test/node:assert instead of bun:test; if the package runner is bun test or Vitest, use compatible imports. Rerun the package/nearest verification after the final edit; stale, failed, or wrong-runner verification is invalid.",
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
    const completionContent = statefulTimeTurn
      ? [
        `Stateful/time changed files and ${commandText} passed.`,
        "Final now: exactly 3 bullets.",
        "Use the user's language; translate bullet labels when appropriate.",
        "- Changed: source and nearest tests",
        `- Verification: ${commandText} passed`,
        "- Notes: happy path, boundary, and state update/preservation covered without wall-clock sleeps or invented policy.",
      ].join("\n")
      : testOnlyTurn
      ? [
        `Test-only change verified with ${commandText}.`,
        "Final now. Do not read back, rerun tests, or explain a plan.",
        "Use the user's language; translate bullet labels when appropriate.",
        "- Changed: test path only, unless source actually changed",
        `- Verification: ${commandText} passed`,
        "- Notes: source behavior preserved when unchanged; name the requested behavior and boundary covered.",
      ].join("\n")
      : leanDirectTurn
      ? [
        `${commandText} passed after the requested package-local source/test edit.`,
        "Final now in exactly 3 bullets: Changed, Verification, Notes.",
        "Use the user's language; translate bullet labels when appropriate.",
        "No readback, rerun, broad discovery, or test-matrix recap unless a concrete failure appears.",
      ].join("\n")
      : docsOnlyMutation
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
      customType: "pi-chalin-direct-completion-nudge",
      content: completionContent,
      display: false,
    }, { triggerTurn: false, deliverAs: "steer" });
  });

  pi.on("session_shutdown", () => {
    restoreScopedToolSet(pi);
    restoreOrchestratorThinking(pi);
    // No background auto-routing workers are owned by this module anymore.
    // Subagent execution is driven through the chalin_route tool and Pi's native
    // abort signal.
  });
}

function forceOrchestratorThinkingHigh(pi: ExtensionAPI): void {
  try {
    const key = pi as unknown as object;
    if (!orchestratorThinkingRestore.has(key)) orchestratorThinkingRestore.set(key, pi.getThinkingLevel());
    pi.setThinkingLevel("high");
  } catch {
    // Older or test extension APIs may not expose thinking controls.
  }
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

function inputGuardEffect(event: { source?: string; text: string }): Effect.Effect<{ action: "continue" }> {
  return Effect.gen(function* () {
    if (event.source === "extension") return { action: "continue" as const };
    const text = event.text.trim();
    yield* Effect.filterOrFail(
      Effect.succeed(text),
      (value) => Boolean(value) && !value.startsWith("/") && !value.startsWith("!"),
      () => new Error("pi-chalin input guard skipped non-user prompt text."),
    ).pipe(Effect.catchAll(() => Effect.succeed(text)));

    // Never consume the user prompt. The primary Pi agent stays in control and
    // decides whether to call chalin_route as one of its normal tools.
    return { action: "continue" as const };
  }).pipe(Effect.withSpan("autoroute.inputGuard"));
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

function applyDirectToolScope(pi: ExtensionAPI, hiddenTools: ReadonlySet<string>): void {
  const toolApi = pi as unknown as { getActiveTools?: () => string[]; setActiveTools?: (toolNames: string[]) => void };
  if (typeof toolApi.getActiveTools !== "function" || typeof toolApi.setActiveTools !== "function") return;
  const activeTools = toolApi.getActiveTools();
  if (activeTools.length === 0) return;
  const filtered = activeTools.filter((name) => !hiddenTools.has(name));
  if (filtered.length === activeTools.length) return;
  rememberScopedToolSet(pi, activeTools, "turn");
  toolApi.setActiveTools(filtered);
}

function applyToolAllowlist(pi: ExtensionAPI, allowedTools: ReadonlySet<string>): void {
  applyScopedToolAllowlist(pi, allowedTools, "turn");
}

function applyDecisionToolAllowlist(pi: ExtensionAPI, allowedTools: ReadonlySet<string>): void {
  applyScopedToolAllowlist(pi, allowedTools, "decision");
}

function applyScopedToolAllowlist(pi: ExtensionAPI, allowedTools: ReadonlySet<string>, mode: ToolScopeRestoreMode): void {
  const toolApi = pi as unknown as { getActiveTools?: () => string[]; setActiveTools?: (toolNames: string[]) => void };
  if (typeof toolApi.getActiveTools !== "function" || typeof toolApi.setActiveTools !== "function") return;
  const activeTools = toolApi.getActiveTools();
  if (activeTools.length === 0) return;
  const filtered = activeTools.filter((name) => allowedTools.has(name));
  if (filtered.length === activeTools.length) return;
  rememberScopedToolSet(pi, activeTools, mode);
  toolApi.setActiveTools(filtered);
}

function rememberScopedToolSet(pi: ExtensionAPI, activeTools: string[], mode: ToolScopeRestoreMode): void {
  const key = pi as unknown as object;
  if (scopedToolSetRestore.has(key)) return;
  scopedToolSetRestore.set(key, activeTools);
  scopedToolSetRestoreMode.set(key, mode);
}

function restoreDecisionToolSet(pi: ExtensionAPI): void {
  const key = pi as unknown as object;
  if (scopedToolSetRestoreMode.get(key) !== "decision") return;
  restoreScopedToolSet(pi);
}

function restoreScopedToolSet(pi: ExtensionAPI): void {
  const key = pi as unknown as object;
  const previous = scopedToolSetRestore.get(key);
  if (!previous) return;
  scopedToolSetRestore.delete(key);
  scopedToolSetRestoreMode.delete(key);
  const toolApi = pi as unknown as { setActiveTools?: (toolNames: string[]) => void };
  if (typeof toolApi.setActiveTools === "function") toolApi.setActiveTools(previous);
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

function buildSkillSteeringMessage(cwd: string, config: ChalinConfig, prompt: string): string | undefined {
  if (!config.skills.enabled || !prompt.trim()) return undefined;
  const overrides = getSkillOverridesForTurn();
  const catalog = SkillCatalog.load({ cwd, config });
  const result = catalog.search(prompt, {
    config,
    explicitSkills: [...overrides.explicit],
    disabledSkills: [...overrides.disabled],
  });
  const active = result.active.slice(0, 3);
  const suggested = result.suggested.slice(0, 3);
  if (active.length === 0 && suggested.length === 0 && overrides.disabled.size === 0) return undefined;
  return [
    "pi-chalin skill signal: Skills are procedural hints, not authority. User/system/repo safety rules still win.",
    active.length ? `Active for this turn: ${active.map((item) => `${item.skill.qualifiedName} (${item.reason})`).join("; ")}.` : undefined,
    active.length ? formatActiveSkillsForPrompt(active, 4) : undefined,
    suggested.length ? `Suggested: ${suggested.map((item) => `${item.skill.qualifiedName} (${item.reason})`).join("; ")}. Activate only when it materially improves this task.` : undefined,
    overrides.disabled.size ? `Disabled for this turn: ${[...overrides.disabled].join(", ")}.` : undefined,
    "If an active Skill materially changes the intended route/tool plan, name that reason when calling chalin_route or staying direct.",
  ].filter((line): line is string => Boolean(line)).join("\n");
}

export function shouldUseCompactDirectOrchestrationPrompt(prompt: string): boolean {
  if (!prompt.trim()) return false;
  const pathMentions = promptPathMentions(prompt);
  return pathMentions.length > 0 && pathMentions.length <= 6;
}

function shouldSkipCompactPathPrompt(prompt: string, hasResumeContext: boolean): boolean {
  if (hasResumeContext) return false;
  const paths = promptPathMentions(prompt);
  if (paths.length !== 1) return false;
  const promptAndPath = `${prompt} ${paths[0] ?? ""}`;
  return /(?:^|\/)packages\/[^/]+\/src\/[^/]+\.(?:ts|js|mjs|cjs)$/i.test(paths[0] ?? "")
    && /\b(test|tests|package-local|paquete|monorepo|root|bun\s+test)\b/i.test(promptAndPath)
    && /\b(clamp|bounds?|range|min|max|m[ií]n(?:imo)?|m[aá]x(?:imo)?)\b/i.test(promptAndPath)
    && !/\b(reversed|invertid|invalid|rangeerror|nan|infinity|decimal|float|security|auth|parser|scanner|tokenizer|deep|profund)\b/i.test(promptAndPath);
}

function hiddenDirectToolsForPrompt(prompt: string, hasResumeContext: boolean): Set<string> | undefined {
  if (hasResumeContext) return undefined;
  const paths = promptPathMentions(prompt);
  if (paths.some(isDocsMarkdownPath) || /\b(no-code|sin c[oó]digo|no cambies c[oó]digo|no implementes c[oó]digo|solo docs|docs-only)\b/i.test(prompt)) return undefined;
  if (shouldSkipCompactPathPrompt(prompt, hasResumeContext) || shouldUseLeanDirectToolScope(prompt, hasResumeContext) || looksLikeTestOnlyPathContract(prompt, paths)) {
    return BOUNDED_DIRECT_HIDDEN_TOOLS;
  }
  if (promptLooksScaffoldPathContract(prompt)) {
    return GREENFIELD_DIRECT_HIDDEN_TOOLS;
  }
  return undefined;
}

function shouldForceRouteFirst(prompt: string, hasResumeContext: boolean): boolean {
  if (hasResumeContext) return false;
  if (/\b(direct|native|sin subagentes|sin subagents|no-subagent|no subagent|sin route|no route)\b/i.test(prompt)) return false;
  if (promptLooksBoundedReadOnlyReview(prompt)) return false;
  const paths = promptPathMentions(prompt);
  if (looksLikeTestOnlyPathContract(prompt, paths)) return false;
  if (shouldSkipCompactPathPrompt(prompt, hasResumeContext) || shouldUseLeanDirectToolScope(prompt, hasResumeContext)) return false;
  if (paths.some(isDocsMarkdownPath) && promptLooksArchitectureDocsArtifact(prompt)) return true;
  if (promptLooksBroadOrchestrationWork(prompt)) return true;
  return promptLooksRiskyImplementationRoute(prompt, paths);
}

function shouldUseOrchestrationModeGate(prompt: string, hasResumeContext: boolean, forceRouteFirst: boolean): boolean {
  if (hasResumeContext || forceRouteFirst || !prompt.trim()) return false;
  if (promptLooksBoundedReadOnlyReview(prompt)) return false;
  if (hasExplicitVerificationRunner(prompt)) return false;
  if (shouldSkipCompactPathPrompt(prompt, hasResumeContext)) return false;
  if (shouldUseCompactDirectOrchestrationPrompt(prompt)) return false;
  return promptPathMentions(prompt).length === 0;
}

function promptLooksBroadOrchestrationWork(prompt: string): boolean {
  if (/\b(simple|tiny|pequeñ[ao]|puntual|small|bounded|acotad[ao]|mini)\b/i.test(prompt)
    && !/\b(deep|profund|project[- ]wide|proyecto completo|arquitectura|architecture|migration|migraci[oó]n|audit|auditor[ií]a)\b/i.test(prompt)) {
    return false;
  }
  return /\b(deep|profund|exhaustiv|project[- ]wide|proyecto completo|whole project|current branch|current diff|pull request|pr\b|arquitectura|architecture|migration|migraci[oó]n|dependency map|mapa de dependencias|ownership|responsibility|responsabilidad|service structure|project structure|entrypoints?|testing map|audit|auditor[ií]a|compar(?:a|e) opciones|compare options|independent approaches|opciones independientes|multi[- ]?surface|cross[- ]?language|multi[- ]?language|cross[- ]?runtime|multi[- ]?runtime|ffi|abi)\b/i.test(prompt);
}

function promptLooksRiskyImplementationRoute(prompt: string, paths: string[]): boolean {
  const text = `${prompt} ${paths.join(" ")}`;
  if (!/\b(implement|implementa|corrige|fix|arregla|refactor|refactoriza|actualiza|update|change|cambia|añade|agrega)\b/i.test(text)) return false;
  if (promptLooksScaffoldPathContract(prompt)) return false;
  if (paths.length > 0 && paths.length <= 2 && !/\b(workspace|monorepo|multi[- ]?crate|multi[- ]?package|cross[- ]?language|cross[- ]?runtime|ffi|abi|runtime|parser|scanner|tokenizer|state machine|tabla ttl|ttl table|expire table|unicode regression|compiler|database|low[- ]?level|c\b|rust|cargo test|make test)\b/i.test(text)) {
    return false;
  }
  return /\b(workspace|monorepo|multi[- ]?crate|multi[- ]?package|cross[- ]?language|multi[- ]?language|cross[- ]?runtime|multi[- ]?runtime|ffi|abi|runtime|permissions?|parser|scanner|tokenizer|state machine|lexer|compiler|database|sql|sqlite|redis|tabla ttl|ttl table|expire table|unicode|low[- ]?level|crates\/|cargo\s+test|make\s+test|go\s+test\s+\.\/\.\.\.)\b/i.test(text);
}

function shouldUseLeanDirectToolScope(prompt: string, hasResumeContext: boolean): boolean {
  if (hasResumeContext || prompt.length > 700) return false;
  const paths = promptPathMentions(prompt).filter(looksLikeSourceOrTestPath);
  if (paths.length !== 1) return false;
  const promptAndPath = `${prompt} ${paths[0] ?? ""}`;
  return /(?:^|\/)packages\/[^/]+\/src\/[^/]+\.(?:ts|tsx|js|jsx|mjs|cjs)$/i.test(paths[0] ?? "")
    && /\b(test|tests|package-local|paquete|root|bun\s+test|node --test|npm\s+(?:run\s+)?test|pnpm\s+(?:run\s+)?test|yarn\s+(?:run\s+)?test)\b/i.test(promptAndPath)
    && /\b(implement|implementa|fix|corrige|arregla|update|actualiza|change|cambia|test|tests)\b/i.test(promptAndPath)
    && !/\b(project-wide|deep|profund|exhaustiv|architecture|arquitectura|migration|migraci[oó]n|security|seguridad|auth|authorization|parser|scanner|tokenizer|state machine|cross[- ]?language|multi[- ]?language)\b/i.test(promptAndPath);
}

function leanPackageLocalPathSteeringMessage(prompt: string): string {
  const sourcePath = promptPathMentions(prompt).find(looksLikeSourceOrTestPath) ?? "";
  const testPath = packageLocalTestCandidateForPath(sourcePath);
  const testHint = testPath ? `read \`${testPath}\`` : "read the package-local test candidate";
  return [
    "pi-chalin lean package-local path: exact source/test work; broad discovery/search tools are out of scope.",
    `First read \`package.json\`, \`${sourcePath}\`, and ${testHint}. No ls/find/grep or pre-test shell unless a direct read fails.`,
    "Edit source plus the existing test once. For numeric bounds, cover inside (include one decimal when the API accepts general numbers), below, above, exact min/max, min==max, and one signed/range case. Do not invent RangeError, NaN, Infinity, or reversed-bound policy without evidence.",
    "Run the package/root test command once, then final in exactly 3 bullets: Changed, Verification, Notes. No readback or matrix recap after pass.",
  ].join("\n");
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

function compactGeneralSteeringMessage(prompt = ""): string {
  return [
    "pi-chalin compact orchestration: use LLM judgment; the code does not classify prompts for you.",
    "Mode gate: First decide route, then tools. `chalin_route` is orchestrated mode and must be the first tool when chosen; native tools mean lean direct mode. Do not spend read/bash/grep/find/ls calls deciding what the route tool is for.",
    "Direct exception: bounded read-only mini-project reviews that explicitly forbid file changes stay native even when they mention risk/security/auth boundaries. Gather bounded evidence and cite concrete paths; route only if the prompt also asks for deep/project-wide/exhaustive analysis or evidence proves the review is not actually bounded.",
    "Bounded read-only auth/security review: stay native when the prompt asks to review/analyze and not edit. Read package/manifest plus obvious auth/session/server/route files once; avoid repeated ls/find after source hits. Final findings-first and concise: code-proven core risks plus direct secondary risks only, severity, exact path/function evidence, one concrete exploit/request path or bypass chain when supported, impact, and remediation. No code changes, no tests, no broad project scan, no tutorial.",
    "Call `chalin_route` as the first tool for current branch/diff/PR summaries, project understanding, project/service structure with entrypoints or testing map, deep project analysis, architecture/migration, broad review/audit, project-wide test/tooling/command/policy audit, risky multi-file implementation, auth/security/token/session behavior with tests and no explicit source path, risky surgical/long-file edits, parser/scanner/tokenizer changes with broad grammar/ownership uncertainty, independent option comparison, independent implementation slices, continuation/resume intent, or unresolved ambiguity unless the user explicitly asks for direct/native/no-subagent work. For explicit memory recall/remembrance or memory inventory/counts, including Spanish prompts like recuerda/recordar/memoria/decidimos, call `chalin_memory_search` first; use mode=list for inventory/count questions. If parent context compaction becomes likely, route or split work into subagents.",
    "When routing, choose topology deliberately from the prompt, agent roster, and evidence. Use the smallest workflow that can prove the result; add discovery, planning, parallelism, or synthesis only when it materially improves coverage or risk control. Do not route plain memory recall/inventory; use chalin_memory_search. Routed implementation/file mutation must include worker execution plus a later reviewer; reviewer FAIL/GAP requires focused repair instead of finalization.",
    "Compact topology defaults unless evidence clearly says otherwise: branch/project/service understanding and high-level architecture-risk overview -> single scout; deep project analysis split by folders/modules -> DAG with scout/context-builder fan-out; architecture or migration across many components -> chain scout -> planner; local module-splitting/options comparison -> chain scout -> planner or single planner when evidence is already obvious; formal project-wide audit/test-command-policy review -> single reviewer; risky implementation with tests -> chain worker -> reviewer; risky long-file/surgical edit -> chain worker -> reviewer, adding planner only when target-region planning is nontrivial; independent writer slices -> DAG with parallel worker ownership and reviewer fan-in; explicit memory recall/inventory -> memory-only route if the memory tool is not available in this turn.",
    "Choose roles by responsibility, not by habit: scout gathers evidence for understanding and high-level risk overview; planner makes strategy/options; reviewer critiques formal audits/configuration; worker mutates files. Add extra roles only when the current role cannot responsibly cover the next responsibility.",
    "Use DAG only for independent slices that can run concurrently, such as folder fan-out or independent writers. Do not use DAG merely because the question is broad; use one planner/reviewer when one role can inspect evidence directly.",
    "Stay native for simple chat, one obvious command, bounded read-only mini-reviews that explicitly forbid file modification, tiny isolated edits, named-file bugfixes/refactors, a specific function/symbol/API plus local verification, and one small package/module/class/function implementation with tests and no prompt paths. Quality-equivalent bounded direct work should prefer lower cost/time/tool count over orchestration.",
    "For small bounded package/class/function work without prompt paths, do not guess directories from identifiers. Use evidence-backed direct candidates only: read a manifest/config or exact local convention when already evident; otherwise use one targeted find/rg by identifier, then read exact source+tests from the result. Existing module names and starter test imports win over function names: if a starter test imports `module_name`, edit `module_name.<ext>` and its matching runner-discovered test; creating a new `<function_name>.<ext>` module or test sibling is a parallel-module bug. If the repo is not explicitly empty/greenfield, a first mutation before source/test surface evidence is invalid: stop, read the starter import/stub/test surface, then patch that surface. Edit source+tests/docs together when requested or implied, then verify. Parser/scanner/tokenizer is not a routing keyword; route only after evidence proves broad grammar ownership, unsafe transition coupling, repeated local verification failure, or parent context pressure.",
    "Parser/scanner/tokenizer direct work: after source+test evidence, cover token boundaries, adjacency before/after protected spans, comments/markers inside protected text, escaped delimiters, and EOF termination. For SQL/SQLite-like single-quoted strings, doubled single quotes (`''`) are part of the string token, not the closing quote; `--` inside such strings is data, while `--` outside strings comments through newline or EOF.",
    "Bounded greenfield/scaffold efficiency: avoid deep repo discovery when the workspace is intentionally tiny or empty. Write all requested source/test/docs/manifest files inside the current workspace root using relative paths and preserve explicit requested file globs/extensions; if the prompt asks for `test/*.test.ts`, deliver a `.ts` test and choose a package script that runs it instead of silently switching to `.mjs`. Never create or verify a home/sibling/tmp project directory unless the user explicitly provided that absolute target. Write source, tests, docs/README, and manifest in one compact pass, then run the package test script once from the current cwd; verification must happen after the last requested mutation. Choose one coherent runner up front: prefer package-native tests or the runner named by the prompt, and avoid framework+loader chains, node_modules binary probing, or install/rewrite loops unless repo evidence requires them. For TS packages, test scripts must be reproducible package scripts: no `npx`, experimental host-only TS flags, or undeclared runner binaries; declare the runner in devDependencies or use a dependency-free runner the package script can execute. After a failed build/test/install, edit the exact root cause before any second bash; repeated bash without an intervening edit is invalid. After tests pass, do not edit metadata/docs/tests just to improve presentation.",
    "Lean direct loop: exact target read(s), no broad crawl, batch implementation+tests, run nearest verification once, one root-cause rerun if needed, then final. Existing large/partial files use targeted edits; tiny fully read stubs may be replaced in one write per file. Do not read back after passing verification just to summarize.",
    "Surface/verification hardening: Canonical surface discipline means existing source stubs, starter tests, imports, and prompt paths define the acceptance surface; edit that module/file and its runner-discovered tests instead of creating parallel modules/tests from a function name or package name; do not create parallel modules/tests for one canonical helper. Python unittest with an existing `tests/` root updates `tests/test_<stem>.py` and verifies with `python -m unittest discover -s tests`; do not create a root duplicate test file or claim root-only tests as suite coverage. Normalized validation computes trimmed/casefolded locals before regex/type-domain checks and returns those same locals; include a whitespace-wrapped valid-input assertion. Request/API validators cover body missing/null/array, field missing, wrong type, blank-after-trim, format error, and success normalization as separate named assertions with a small documented error surface. New public helpers with explicit domain bounds such as 1-based, positive, max, cap, or finite should reject/fail fast for out-of-domain inputs instead of silently coercing them to a valid case unless existing behavior says otherwise.",
    "Direct quality contract: derive expected behavior before coding; preserve public behavior unless evidence requires change; cover changed behavior plus no-op/boundary/error paths. Refactors change structure, not behavior: identify existing branches/defaults/formulas/formatting from source and tests, then preserve at least one uncovered edge or branch in executable coverage when tests are requested. For typed refactors, treat tests as API/contract design: use approval-style public API tests, triangulate with different inputs/outputs, prefer pure helpers where feasible, and keep type safety anchored in source-of-truth types instead of broad casts, duplicate type definitions, or object-bag typing. Typed refactors with object-shaped public returns should preserve an explicit source-of-truth return type/signature when local style allows it. Newly public/exported helpers should own their boundary semantics such as optional/default inputs when that makes the helper independently testable, get a short responsibility comment when expanding public surface and local style allows it, and be triangulated with zero/one/many or equivalent distinct cases plus one composed public-API case. If an extracted helper covers an optional/default public input, the helper owns that default so its unit tests can call the boundary directly. Formula, aggregation, or ratio refactors must derive equivalence classes from existing operations: neutral/default value, meaningful extreme/ceiling/floor value, empty/one/many collection sizes when collections exist, rounding/formatting branch when present, and one composed public-API proof that helpers preserve the orchestration result. Each independent optional/default rate, percentage, or value input in a formula needs distinct omitted/undefined-default and explicit-zero coverage when that boundary is public or helper-owned; cover at least one composed public API case where different zero/default inputs affect different formula steps. Each extracted formula helper with rounding/formatting/threshold logic needs its own non-integer or threshold case; the composed API proof should expose order-sensitive intermediates when operation order is part of the contract. Predicate guards: cover each condition branch/value class. Domain-practical coverage means success plus distinct failure/edge classes that callers actually observe: middleware/auth side effects, API structural payload errors, crypto malformed-vs-wrong signatures, rollout/hash independence, cache/update/eviction behavior, retry/backoff invalid domains, pagination/request parsing repeated/empty/encoded cases. Prefer standard-library parsers/serializers for known wire formats before hand-written split/regex logic, then layer prompt-specific normalization on top. Before writing tests/imports, infer the package runner from package.json/config/existing tests and keep assertion APIs compatible with the command that will run: node --test/.cjs uses require('node:test') plus node:assert, bun test may use bun:test, Vitest uses vitest. Do not validate with a different runner than the package/test script unless the user explicitly asked. Broken-test triage is not coverage expansion: with an existing failing test and no request for new tests, fix source and rerun that same nearest test; add coverage only when the failing test is absent/inadequate or requested. Strict decoders/parsers consume the full input: whitespace-only counts as empty, and trailing non-whitespace data after a valid value is an error. Normalization used for validation must feed returned output; whitespace validation means trimmed locals are the values returned/composed, and one spaced-input output assertion is required when trim/lowercase is part of the contract. If capacity/limit, cover negative/zero/one and update-without-growth. Go exported APIs get concise doc comments when local style expects them. Text/query filters: trim/blank, no-match, order.",
    "Scaffolds and greenfield package/library/CLI work need exact requested files inside the current cwd, package/bin/config metadata, module format metadata, exports, README/API/usage docs when requested or implied by package/library/CLI shape, runner-discoverable cases, real command path, no placeholders/TODO, no fake builds, and no zero-test assertion scripts. Source syntax and package metadata must agree: ESM import/export requires ESM package/config, CommonJS requires CommonJS tests/entrypoints, and bin/main/exports must point at delivered files. CLI packages need `bin`, test script, runnable start/run script when usage is documented, and real module-format metadata; a `module` field is not a substitute for `type: module`. Package/scaffold tests are root artifacts under `test/` or `tests/` unless prompt or repo convention explicitly asks for inline/source tests; when the prompt names a test path/glob/extension, create that exact surface and choose the package script to execute it instead of changing the extension. Do not put package tests in `src/` or compile them into the published surface. Prefer the requested public entrypoint as the API surface; extra helper files must buy clear ownership/testability and must not broaden behavior such as trimming/normalization beyond the prompt. Config/env/options APIs should treat an injected env/options parameter as the source of truth and avoid reading global process state inside the library helper unless the prompt asks for a global loader. Publishable TypeScript libraries need a build script/tsconfig when `main`/`types`/`files` point to generated output; keep those fields aligned to the generated surface. When validation is part of the public contract, expose a small documented error surface when useful; runtime type validation should use a public signature broad enough for tested invalid inputs. For new TS packages, prefer runner-native tests or the prompt-named runner before adding framework+loader chains; no `npx`, experimental TS strip flags, or undeclared runner binaries in package scripts. A small custom error class is useful when validation is public API. Package bin targets must point to a delivered executable/source file and be verified through that real path; do not point bin at dist/build output unless that artifact is generated and exercised. CLI command behavior belongs in runner tests when possible: spawn the delivered bin/entrypoint and assert exit status plus stdout/stderr for normal, multi-word, and no-input/error paths; free-text commands should collect all text args with `process.argv.slice(2).join(\" \")` or equivalent. After package tests pass, avoid separate post-test CLI smoke shells. Prefer separate named tests for critical branches over table helpers that collapse many cases into one reported runtime test. Security/crypto/auth validation gets missing/invalid/negative tests and constant-time/resource-safe APIs when the domain calls for it; HMAC SHA-256 hex signatures are exactly 64 hex chars and need a well-formed-but-wrong signature test.",
    "Scaffold test-path symmetry: if the prompt names `src/<entry>.*` but not an exact test file, create `test/<entry>.test.*` by default so the test mirrors the public entrypoint. If the package script discovers `test/` or `tests/`, place the substantive assertions there; do not hide stronger coverage in a root sibling that the package runner will skip.",
    "Time/window/retry/cache/rate/budget: use internal test seams or runner-native fake time over ad hoc sleeps; Bun tests can use `setSystemTime`, Vitest can use `vi.setSystemTime`/fake timers, otherwise use the smallest scoped Date.now restore. When tests expect independent entries to diverge, stagger their set times/windows or TTLs; entries set at the same time with the same TTL expire together.",
    ...domainSpecificDirectContracts(prompt),
    "Final quality: answer in the user's language and keep it compact but evaluable. Name changed files, exact verification, and 2-4 evidence-backed design decisions or boundary tests that explain why the result is correct. More text is not the goal; useful contract evidence is.",
  ].join("\n");
}

function promptLooksBoundedReadOnlyReview(prompt: string): boolean {
  if (!prompt.trim() || promptPathMentions(prompt).length > 0) return false;
  if (!/\b(review|revisa|analiza|analizar|audit|audita|dime si hay|riesgo|risk)\b/i.test(prompt)) return false;
  if (!/\b(auth|security|seguridad|boundary|frontera|riesgo|risk|authorization|autorizaci[oó]n)\b/i.test(prompt)) return false;
  if (!/\b(no modifiques|no cambies|sin modificar|sin cambios|read-only|solo lectura|do not modify|don't modify|do not change|don't change)\b/i.test(prompt)) return false;
  if (/\b(test|tests|implement|implementa|fix|corrige|cambia|modifica|añade|agrega|add|write|edita)\b/i.test(prompt)) return false;
  if (/\b(deep|profund|exhaustiv|project-wide|proyecto completo|arquitectura|architecture|migration|migraci[oó]n)\b/i.test(prompt)) return false;
  return true;
}

function compactBoundedReadOnlyReviewSteeringMessage(prompt: string, hasUI?: boolean): string {
  return [
    "pi-chalin compact bounded read-only review: native; route only if direct evidence proves deep/project-wide scope or implementation is requested.",
    hasUI ? undefined : "First tools: use native read/ls only for the smallest manifest/source evidence needed, then direct auth/session/caller candidates from repo conventions. Do not start with chalin_project_discovery, chalin_project_snapshot, or chalin_route for bounded reviews; those are for broad/project-wide uncertainty. If direct reads fail, use one targeted find for auth, session, authorization, middleware, or caller surfaces. No repeated ls/find after source hits.",
    "No mutation, no bash, no tests/docs. Evidence is source text plus paths.",
    "Scope: code-proven risks only. Prioritize trust boundaries: identity source, authorization/permission checks before sensitive actions, identity/token input validation, and misleading guard APIs that return nullable/falsey values. No speculative session/replay/rate-limit gaps without code evidence.",
    "Final: one verdict sentence using `riesgo de seguridad` or `security risk`, then 2-4 tight bullets, no tables, no project tree, no code fences. Each bullet: severity, path/function, inline evidence, one concrete exploit/request path or bypass chain when evidenced, impact, remediation. Include the boundary and caller paths when evidenced.",
  ].filter((line): line is string => Boolean(line)).join("\n");
}

function compactPathSteeringMessage(prompt: string, hasUI?: boolean): string {
  const promptMentions = promptPathMentions(prompt);
  const docsOrNoCodeIntent = promptMentions.some(isDocsMarkdownPath) || /\b(no-code|sin c[oó]digo|no cambies c[oó]digo|no implementes c[oó]digo|solo docs|docs-only)\b/i.test(prompt);
  const promptPaths = docsOrNoCodeIntent ? promptMentions.filter(isExactPromptPathMention) : promptMentions;
  const bareNamedSurfaces = docsOrNoCodeIntent ? promptMentions.filter((mention) => !isExactPromptPathMention(mention)) : [];
  const onlyDocsPaths = promptPaths.length > 0 && promptPaths.every(isDocsMarkdownPath);
  const hasDocsPath = promptPaths.some(isDocsMarkdownPath);
  const hasScaffoldIntent = promptLooksScaffoldPathContract(prompt);
  const bareSurfaceContract = bareNamedSurfaces.length > 0
    ? `Named surfaces without exact paths: ${bareNamedSurfaces.map((item) => `\`${item}\``).join(", ")}. Treat these as search keys, not files to read directly. A raw inventory or one targeted find/rg is evidence; conventional path candidates are not. After the first hit, read exact paths from evidence rather than trying directory guesses.`
    : undefined;
  const extraBareSurfaceContract = promptPaths.length > 0 ? bareSurfaceContract : undefined;
  const pathContract = promptPaths.length > 0
    ? `Prompt paths: ${promptPaths.map((item) => `\`${item}\``).join(", ")}. Use per user wording`
    : bareSurfaceContract ?? "No prompt paths were extracted; use the full orchestration prompt on the next turn if scope is unclear.";
  if (onlyDocsPaths) {
    if (promptLooksArchitectureDocsArtifact(prompt)) {
      return compactArchitectureDocsSteeringMessage(pathContract, hasUI, extraBareSurfaceContract);
    }
    if (promptLooksOperationalDocsArtifact(prompt)) {
      return compactOperationalDocsSteeringMessage(prompt, pathContract, hasUI, extraBareSurfaceContract);
    }
    return [
      "pi-chalin compact docs-artifact preflight: use LLM judgment for intent and risk; paths are structural.",
      hasUI ? undefined : pathContract,
      hasUI ? undefined : extraBareSurfaceContract,
      docsDirectSourceCandidateMessage(prompt),
      "Operational docs deadline: for runbook, rollback, diagnostic, how-to-run-tests, or incident/sync docs, first read the requested docs artifact, package/manifest evidence, and the direct source/test/config candidate. If those reads succeed, the next tool must write or edit the requested docs artifact. Do not call find/grep/ls/bash between successful direct evidence reads and the docs mutation; use one targeted find only when a direct read fails, then write.",
      "Mandatory docs mutation: do not answer with a route label, plan-only note, or promise. Start native. Escalate to `chalin_route` only after concrete evidence proves broad synthesis, multiple ownership surfaces, or parent-context pressure; the routed workflow still updates only the requested docs artifact. Causal consistency check: A final answer that only says what you will do is invalid; do not change product code.",
      "Native docs mode: first read the requested artifact, package/test script, and one obvious source surface for each named operation; no ls/find before those direct reads unless a read fails. If an operation name maps to a conventional source path such as `src/<name>.ts` or `src/<name>.js`, read that direct candidate before find. If the prompt names a bare filename or public symbol without a path, do not invent path candidates; use one targeted find/rg by exact basename or symbol, then read the highest-confidence result. Do not use find/grep only to prove tests are absent; package.json/source evidence is enough to document how to run tests. Do not run shell before writing unless the user explicitly asks to validate/execute a command. After package/source evidence or one explicit validation shell, write the artifact next; do not search for tests, run find/grep, or run a second shell. Use one concrete source file per named surface and one targeted find for that surface when a direct read misses. Preserve the user's scenario/failure trigger. Do not create a separate evidence/gaps section unless a missing surface blocks use; otherwise mention only blocking searched/not-found gaps.",
      "Operational docs compact mode: keep the user's language and make the artifact operational, not exhaustive. Required headings: `Estado actual`/`Current state`, `Pasos`/`Steps`, rollback, quick reference. Before writing, use read evidence by default. Run at most one pre-write shell total only when the user explicitly asks to validate/execute a command: package test/diagnostic when possible, or `git status` if VCS rollback evidence matters more. After evidence, the next mutation must be the docs write. The artifact text itself must name the manifest path that proves the test command, such as `package.json`, `Cargo.toml`, or `pyproject.toml`, plus the source path that proves the operation. Call out ambiguous no-tests vs failed-assertion output, and never call no-test discovery a passing suite. Include one inline smoke command with expected output, a 3-row symptom/cause/next-check table, compact cases/invariants only from source facts, known gaps separated from bugs, typecheck command only when `tsconfig`/script evidence exists, and one applicable assertion/test example in the evidenced test root when tests are mentioned. Rollback targets the named operation/system/change; if VCS is absent or not evidenced, say so and do not present `git restore`/`git stash`/`git revert` as runnable current-repo steps. Use manual backup/restore plus optional initialize-git checkpoint, and application-level retry/re-run only for pure/no-side-effect source behavior. Evidence lock: for collection reconciliation operations, use duplicate/order examples; do not invent timestamps, versions, labels, or state. One write, one readback, at most one corrective edit+readback for missing required facts; do not iterate on polish.",
      "If staying native, after writing docs the next tool must be `read` on the updated docs artifact. Treat readback as a quality gate: truncated, mid-sentence final lines, dangling headings/lists, literal TODO/TBD/WIP/placeholder tokens anywhere, missing requested fields, scenario drift, or a final visible block that is a table/list/code fence means edit once and read back again before final. End with one complete prose sentence.",
      "Native final should be concise but complete: Changed, Verification, and Notes in no more than 5 lines, with exact evidence paths, requested artifact fields covered, substantive conclusions, pre-write evidence commands when actually run, and unresolved searched/not-found gaps only when relevant. Do not restate every successful search/read. Do not add post-write shell/build/test claims for docs-only work.",
    ].filter((line): line is string => Boolean(line)).join("\n");
  }
  if (hasScaffoldIntent) {
    return compactScaffoldPathSteeringMessage(pathContract, hasUI, extraBareSurfaceContract);
  }
  if (looksLikeTestOnlyPathContract(prompt, promptPaths)) {
    return compactTestOnlyPathSteeringMessage(prompt, promptPaths, hasUI);
  }
  if (shouldForceRouteFirst(prompt, false)) {
    return compactRouteFirstPathSteeringMessage(prompt, pathContract, hasUI, extraBareSurfaceContract);
  }
  if (shouldUseMinimalBoundedPathSteering(prompt, promptPaths)) {
    return minimalBoundedPathSteeringMessage(prompt, promptPaths, hasUI);
  }
  return [
    "pi-chalin compact path preflight: use LLM judgment; paths structural. Mode gate: `chalin_route` is orchestrated mode and should be first if chosen; native tools mean lean direct mode.",
    "First-action invariant for non-greenfield code: if the prompt names a source/test path or bare source surface, gather exact surface evidence before mutation. Exact prompt paths use `read`; bare filenames/symbols use one targeted find/rg, then read the hit. A first `write` before target/starter source+test evidence is invalid because it creates parallel surfaces.",
    "Named source/test/config plus local verification start native: read exact files; route only if reads prove broad ownership, migration, generated/cross-runtime coupling, unsafe long-file or grammar risk.",
    "Code+test direct preference: one behavior starts native; escalate to `chalin_route` only when evidence proves broader scope, repeated failure, context pressure, or parser/scanner/tokenizer transition risk that cannot be validated locally.",
    "If scope broadens, name the unresolved surface; do not broad-scan.",
    hasUI ? undefined : pathContract,
    hasUI ? undefined : extraBareSurfaceContract,
    hasUI ? undefined : "Bounded native: first tool `read` listed files; no parent `ls`. Read nearest test/include; if unnamed, try `test/<stem>.test.*` before find. If target read shows inline tests/test module, update there; no find/ls for separate tests. With exact source/runner, skip grep/find/ls and manifest/config; after reading named source, do not grep the same symbol/file. Existing large/partial files use targeted edits; tiny fully read stubs may be replaced once. Tests requested: batch implementation+tests before first verification. No baseline verification before the first edit unless the user says existing tests are failing/triage. One focused verification, one root-cause rerun, then final. Readback only for concrete missing evidence.",
    hasDocsPath ? "Docs/no-code compact: write requested docs only after one bounded evidence pass. Read package/test script plus one obvious source surface for each named operation. If prompt names bare filenames or public symbols without paths, do not invent path candidates; use one targeted find/rg by exact basename or symbol, then read the highest-confidence result. For architecture/refactor docs, include current->target responsibility/ownership maps and evidence-derived validation when requested; for deep architecture docs, add problem taxonomy, data-flow/coupling map, ownership/coupling-by-responsibility table, design decision matrix with options/recommendation, dependency delta, stage-0 golden-test capture, reverse-dependency check, staged migration, risks, rollback, phase checklist, and out-of-scope boundaries. Mark future abstractions as future/out-of-scope instead of slipping them into the immediate plan. For execution/diagnosis docs, use `Estado actual`/`Current state`, `Pasos`/`Steps`, rollback, quick reference; use read evidence by default and run at most one pre-write shell only when the user explicitly asks to validate/execute a command. Without VCS evidence, do not give `git restore`/`git stash`/`git revert` as runnable current-repo steps. After evidence, write the docs next: no find/grep/test discovery, diagnostic shell, or second pre-write shell. The artifact must cite the manifest/source paths that prove its commands and behavior, distinguish no-tests output from failed assertions, include one inline smoke command with expected output, a 3-row symptom/cause/next-check table, compact case/invariant table only from source facts, typecheck command only with `tsconfig`/script evidence, known gaps separated from bugs, and manual/application rollback only when evidenced. Evidence lock: for collection reconciliation operations, use duplicate/order examples; do not invent timestamps, versions, labels, state, npm/yarn commands in Bun-only repos, test paths outside the evidenced test root, code-change plans, or literal TODO/TBD/WIP/placeholder tokens even when describing the old artifact. One write, one readback, at most one corrective edit+readback; no post-write shell/build/test; final <=5 lines." : undefined,
    directWorkContract(prompt),
    "Final in the user's language: Changed, Verification, Notes. Cite implementation and test/evidence paths plus 2-4 compact design/boundary decisions that prove the contract: public API/response shape, domain primitive/stdlib choice, edge cases covered, and canonical surface/no duplicate helper files. Stop after pass/docs verification.",
  ].filter((line): line is string => Boolean(line)).join("\n");
}

function compactRouteFirstPathSteeringMessage(prompt: string, pathContract: string, hasUI?: boolean, bareSurfaceContract?: string): string {
  const implementationRoute = promptLooksRiskyImplementationRoute(prompt, promptPathMentions(prompt));
  return [
    "pi-chalin route-required path preflight: this prompt is broad, risky, cross-surface, or stateful enough for orchestrated mode.",
    hasUI ? undefined : pathContract,
    hasUI ? undefined : bareSurfaceContract,
    "First tool must be `chalin_route`. Do not inspect, edit, or run shell in the parent before routing; the routed workflow owns evidence gathering, implementation when requested, verification, and handoff.",
    implementationRoute
      ? "Implementation topology: choose the smallest agent set that can gather necessary evidence, implement, verify, and review. Worker execution and a later reviewer are mandatory for routed mutation; discovery/planning/parallelism are optional tools when they materially reduce risk."
      : "Analysis/docs topology: choose agents for evidence, planning, artifact mutation, and review only when each role adds value; routed file mutations still need worker execution plus later reviewer.",
    "Scope lock: keep explicit prompt paths and named surfaces as acceptance surfaces; subagents may search only to resolve exact ownership gaps. Do not broaden into unrelated refactors or rewrite plans.",
    "Verification contract: implementation routes need the requested runner or nearest focused verification plus relevant boundary tests; docs/analysis routes need artifact readback and evidence-derived claims. Final answer synthesizes the route handoff in the user's language.",
  ].filter((line): line is string => Boolean(line)).join("\n");
}

function compactScaffoldPathSteeringMessage(pathContract: string, hasUI?: boolean, bareSurfaceContract?: string): string {
  return [
    "pi-chalin compact path preflight for scaffold: stay native; write the requested package inside the current workspace root.",
    hasUI ? undefined : pathContract,
    hasUI ? undefined : bareSurfaceContract,
    "Scaffold/API: exact files/APIs use relative paths only; do not create a separate project in home, sibling, or tmp. No pre-edit shell/discovery or environment probes (`which bun`/`node`/`npx`) for tiny/new packages unless a direct requested path read fails. Write source, tests, docs/README, manifest/config in one compact pass; verify once from cwd after the last requested mutation; patch one concrete failure if needed, then final in the user's language with 2-4 design decisions.",
    "Coherence: package/bin/config metadata, module format metadata, exports, README/API/usage docs, language/toolchain, and runner agree. Source syntax and package metadata must agree: ESM import/export requires ESM package/config; CommonJS requires CommonJS tests/entrypoints. CLI packages need `bin`, test script, runnable start/run script when usage is documented, and real module-format metadata; a `module` field is not a substitute for `type: module`.",
    "API contract: prompt-named exported functions, parameter names, examples, and return shape are acceptance criteria. Write tests against that public shape before implementation choices; dependency injection or helper seams may be additive, but must not replace or reinterpret the requested API. API/validation correctness outranks package finish: do not drop source-map mode, overload/union compatibility, or boundary validation to add build metadata. If a public parameter is plausibly ambiguous in a non-interactive run, preserve the named surface and support the conservative compatible union instead of choosing one meaning silently. Keep README/final centered on the requested public shape; document alternate compatibility briefly, not as a second primary API unless the prompt asks.",
    "API surface: use the requested public entrypoint as the API surface; extra helper files must buy clear ownership/testability and must not broaden arbitrary behavior beyond the prompt. Import-safe CLI modules are mandatory when tests import the CLI file: export pure logic and guard process.argv/console/process.exit behind the runtime entrypoint check such as `import.meta.main`. Package bin targets must point to a delivered executable/source file and be verified through that real path. Do not point bin at dist/build output unless that artifact is generated and exercised.",
    "Tests/docs: Write README/docs before the first verification when requested/implied. Tests register runner-discoverable cases under root `test/` or `tests/`; preserve explicit requested test path/glob/extension. When a scaffold names `src/<entry>.*` but only says tests, mirror it with `test/<entry>.test.*` instead of a package-name test that obscures the public entrypoint. Package test scripts should discover the conventional test root/glob instead of hard-coding only one visible test file. Do not put package tests in `src/` or compiled publish output. CLI tests cover logic, real command path, exit status, stdout/stderr, multi-word argument text, and no-input/error behavior; free-text CLI commands should parse `process.argv.slice(2).join(\" \")` or equivalent when command accepts a text argument. Do not run a separate post-test CLI smoke shell. Zero-test scripts are invalid.",
    "TypeScript packages: TypeScript library scaffolds with tests should deliver source tests such as `test/<name>.test.ts` unless another path/extension is named; compiled or JS-only tests do not satisfy a TypeScript test artifact. TypeScript library/package scaffolds that document package installation/imports or expose `main`/`types` should be publishable when it does not crowd out requested API/validation: use `src` source, `dist` main/types, minimal `tsconfig.json`, build/typecheck script, and declared compiler devDependency unless the prompt explicitly asks for source-only/no-build or no external tooling. Keep package fields aligned to the generated surface. When packages compile `node:test`, `node:assert`, `process`, or other Node built-ins with `tsc`, declare matching Node type metadata such as `@types/node` before the first install/test; dev-only type packages are not runtime dependencies. For new tiny TS packages with no runner named, package scripts use declared/reproducible runners and choose one runner immediately: prefer zero-install native TS runners already available in the repo/toolchain such as `bun test`; `bun test` runs TS source tests directly, so do not add tsconfig/build output just to execute tests. Use declared `tsc` + `node --test` only when Bun is unavailable or publishable build output is requested. Do not deliberate between third-party TS loaders and experimental TS strip flags; no `npx`, experimental TS strip flags, or undeclared runner binaries.",
    "Config/env/options APIs: preserve prompt-named public parameter meaning; do not silently retype a scalar/domain parameter into a dependency map. Put dependency injection in an `options`/`source` object with a safe default empty object, and avoid reading global process state below that boundary. If a config `env` parameter is ambiguous, support both common meanings with overloads/union: env name string and env-source map, but keep the primary API simple in docs. Source-map mode uses conventional `PORT`/`NODE_ENV` keys as optional source keys when defaults are part of the contract; do not make `NODE_ENV` required unless prompt/repo evidence says required. String-env mode injects PORT/source through options. Tests cover both env-source calls such as empty object/defaults and string-env calls when both are plausible. Missing/undefined config values may default independently; for conventional development/test/production envs, absent `NODE_ENV` defaults to `development` unless prompt/repo evidence says required, and absent `PORT` defaults to `3000`. Do not read `process.env` to fill missing values from an injected env object. Provided blank strings must pass through validation and fail unless explicitly allowed. Config loaders returning a plain object should return an immutable/frozen config when local runtime supports it. Finite validated string domains in TypeScript public APIs expose exported literal union types and return canonical literals, not plain `string`; conventional config/env string enums should trim/casefold only prompt-named literals and return canonical values with tests, using exact-case only when prompt/repo evidence says case-sensitive. Do not add aliases such as `dev`/`prod` or short env names unless prompt or repo evidence asks for them; reject alias values in tests when the domain is finite. Tests cover canonicalization or explicit exact-case policy.",
    "Validation: App/network `PORT` validation means a whole-string finite integer in 1..65535: reject 0, empty strings, whitespace-only values, leading/trailing whitespace around digits, negatives, fractions, trailing text, `NaN`, and infinities; do not use `parseInt` prefix parsing or trim before numeric validation. Validation contracts get a documented error surface when useful; runtime type validation should use a public signature broad enough for tested invalid inputs; small custom errors help public validation APIs. Whitespace validation means trimmed locals feed returned/composed output; cover one spaced-input output when relevant. Respect dirs/extensions/runners; No fake builds/duplicate logic/TODO.",
    "Final in the user's language: Changed, Verification, Notes. Cite implementation and test/evidence paths plus key boundary/preservation tests. Stop after pass/docs verification.",
  ].filter((line): line is string => Boolean(line)).join("\n");
}

function compactArchitectureDocsSteeringMessage(pathContract: string, hasUI?: boolean, bareSurfaceContract?: string): string {
  return [
    "pi-chalin compact docs-artifact preflight: route broad architecture docs; paths are structural.",
    hasUI ? undefined : pathContract,
    hasUI ? undefined : bareSurfaceContract,
    "Route-required architecture docs: if the prompt asks for deep/broad architecture, migration, cross-language/runtime, dependency-map, ownership/responsibility, staged-plan, or multi-surface refactor docs, call `chalin_route` as the first tool when route quality is needed. For docs artifact mutation, choose the smallest agent set that can gather evidence, update only the requested artifact, and review evidence/contract/gaps/readback. `chalin_project_discovery` and `chalin_project_snapshot` are not substitutes for route. The routed workflow still updates only the requested docs artifact. Do not start native just because the mutation target is one docs file.",
    "Native docs mode is only for bounded/local docs artifacts. If staying native, write the requested docs artifact after one bounded evidence pass: first read the requested artifact, package/build/test script if present, and one concrete source surface per named responsibility. If prompt names bare filenames or public symbols without paths, do not invent path candidates; use a raw inventory or one targeted find/rg by exact basename or symbol, then read the highest-confidence result.",
    "Architecture/refactor docs must include current->target responsibility/ownership maps and evidence-derived validation when requested. For deep architecture docs, add problem taxonomy with evidence, data-flow/coupling map, ownership/coupling-by-responsibility table, design decision matrix with options/recommendation, dependency delta to add/remove includes/imports/modules, stage-0 golden-test capture before behavior changes, reverse-dependency check, target ownership/layers, staged migration with exit criteria, risk register with severity and mitigation, rollback strategy, phase checklist, and out-of-scope boundaries.",
    "Cross-language/runtime plans: do not pass raw language `bool` or layout-sensitive types across FFI without local ABI evidence. Prefer ABI-stable fixed-width integers or bitfields (`u8`, `c_uint`, `u32 flags`) at the boundary, convert inside safe wrappers, keep old exported symbols as compatibility wrappers when changing signatures, and name explicit ABI/build/link validation plus rollback.",
    "Evidence lock: derive the plan from read paths only; mark future abstractions as future/out-of-scope instead of slipping them into the immediate plan. Do not run wildcard `**/*.h`, `**/*.cpp`, docs, tests, or build-file searches just to inventory absence; mention gaps only when a targeted search was needed. Do not invent commands, owners, timestamps, versions, test paths, code-change diffs, or literal TODO/TBD/WIP/placeholder tokens even when describing the old artifact.",
    "Document shape: compact but complete, roughly 80-120 lines; prefer dense tables/bullets over decorative diagrams and use at most one API/code sketch unless the prompt asks for more.",
    "After evidence, write the docs next: no broad find/grep/test discovery, diagnostic shell, or second pre-write shell. One write, one readback, at most one corrective edit+readback; readback defects include truncation, missing requested sections, scenario drift, dangling final blocks, and TODO/TBD/WIP/placeholder tokens.",
    "Native final should be concise but complete: Changed, Verification, and Notes in no more than 5 lines, with exact evidence paths, requested artifact fields covered, substantive conclusions, and unresolved searched/not-found gaps only when relevant.",
  ].filter((line): line is string => Boolean(line)).join("\n");
}

function compactOperationalDocsSteeringMessage(prompt: string, pathContract: string, hasUI?: boolean, bareSurfaceContract?: string): string {
  return [
    "pi-chalin compact operational docs path: stay native; route only after concrete evidence proves broad ownership or parent-context pressure.",
    hasUI ? undefined : pathContract,
    hasUI ? undefined : bareSurfaceContract,
    docsDirectSourceCandidateMessage(prompt),
    "Deadline: first read the requested docs artifact, package/manifest evidence, and the direct source/test/config candidate. Do not run shell before writing unless the user explicitly asks to validate/execute a command. package.json/source evidence is enough to document how to run tests. If those direct reads succeed, the next tool must write or edit the requested docs artifact. Use one targeted find only when a direct read fails; no grep/ls/bash/test discovery before the docs mutation.",
    "Artifact cap: concise runbook, roughly 40-75 lines. Use headings in the user's language for current state, steps, test execution, failure diagnosis, safe rollback, and quick reference. The visible document must explicitly name the manifest path that proves the command, the source path, and the observed operation/function in normal prose without copying template sentences. Include one smoke command with expected output, one 3-row symptom/cause/next-check table, and compact invariants only from source facts. No long examples, placeholders/TODO, invented timestamps, versions, labels, npm/yarn in Bun-only repos, or path typos.",
    "Tests/rollback: if examples are needed, use runner-compatible imports and the evidenced test root; if no test root exists, label the snippet as suggested under `test/` and keep it tiny. If git was not evidenced, say VCS was not verified and use manual backup/restore plus optional initialize-git checkpoint; do not present `git restore`/`git stash`/`git revert` as runnable current-repo steps.",
    "After the docs write, the next tool must be `read` on that same artifact. If readback has no TODO/placeholder, missing requested field, dangling list/table/code fence, or scenario drift, final immediately in exactly 3 bullets: Changed, Verification, Notes. No bash after docs mutation.",
  ].filter((line): line is string => Boolean(line)).join("\n");
}

function compactScaffoldDirectContract(): string {
  return "Contract: bounded scaffold/greenfield stays native. The current cwd is the project root: write only relative in-workspace paths such as `package.json`, `src/...`, `test/...`, and `README.md`; never create a home/sibling/tmp project directory unless the user explicitly provided that absolute target. Prompt-named exported functions, parameter names, examples, and return shape are acceptance criteria; tests call that public shape before implementation choices, and dependency injection/helper seams may be additive but must not replace the requested API. API/validation correctness outranks package finish; do not drop compatibility or boundary validation to add build metadata. TypeScript library scaffolds that expose package imports/main/types should be publishable when that does not crowd out the requested API/validation, with `dist` main/types, minimal tsconfig/build, and declared compiler devDependency unless source-only/no-build/no external tooling is explicit. In tiny/new packages, no pre-edit shell/discovery or `which bun`/`node`/`npx` probes unless a direct requested path read fails; write requested source/test/docs/manifest together, choose one coherent runner, verify once with the package script from the current cwd after the last requested mutation, patch one concrete failure if needed, then final in the user's language with 2-4 design decisions. If README/docs/metadata are requested or implied, they must be written before first verification; do not add them after a passing test just for presentation. Package test scripts should discover the conventional test root/glob instead of hard-coding one visible file, and when only `src/<entry>.*` is named the default test path is `test/<entry>.test.*`. Missing/undefined config values may default independently; conventional development/test/production env maps default absent NODE_ENV to development and absent PORT to 3000 unless prompt/repo evidence says required; injected env maps must not read process.env for missing values. Provided blank strings must validate and fail unless explicitly allowed. Finite validated string domains in TypeScript public APIs use exported literal union types and canonical returned literals; conventional env/config string enums should trim/casefold only prompt-named literals and reject aliases such as dev/prod unless prompt/repo evidence asks. Prefer zero-install native TS runners already available in the repo/toolchain over adding loader/framework dev deps just to execute tests. CLI tests should spawn the delivered bin/entrypoint and assert exit status plus stdout/stderr for normal, multi-word, and no-input/error paths; free-text commands should collect all text args with `process.argv.slice(2).join(\" \")` or equivalent. CLI files that export testable functions must guard command execution with the runtime entrypoint check such as `import.meta.main` before the first test run.";
}

function looksLikeTestOnlyPathContract(prompt: string, promptPaths: string[]): boolean {
  if (promptPaths.length !== 1 || !looksLikeSourceOrTestPath(promptPaths[0] ?? "")) return false;
  return /\b(test|tests|unitario|unitaria|unit|prueba|pruebas)\b/i.test(prompt)
    && /\b(add|a[ñn]ade|agrega|cover|cubre|cubrir)\b/i.test(prompt)
    && !/\b(implement|implementa|fix|corrige|arregla|refactor|refactoriza|change|cambia|modifica)\b/i.test(prompt);
}

function compactTestOnlyPathSteeringMessage(prompt: string, promptPaths: string[], hasUI?: boolean): string {
  const promptPath = promptPaths[0] ?? "";
  const directTestCandidate = sourceTestCandidateForPath(promptPath);
  const promptAndPath = `${prompt} ${promptPath}`;
  const includeJsZeroDivision = /\.(?:ts|tsx|js|jsx|mjs|cjs)$/i.test(promptPath)
    && /\b(divid|division|divisi[oó]n|ratio|quotient|denominator|denominador|divide)\b/i.test(promptAndPath)
    && /\b(zero|cero|0)\b/i.test(promptAndPath);
  return [
    "pi-chalin compact test-only path: stay native; do not route.",
    hasUI ? undefined : `Prompt path: \`${promptPath}\`.`,
    directTestCandidate ? `Read source once, then read or create nearest test \`${directTestCandidate}\`.` : "Read source once, then read or create the nearest runner-discoverable test.",
    "If source already has the requested behavior, do not refactor or edit source. Add only focused tests for the requested behavior; if an existing test already covers normal behavior, do not add another preservation case. Singular/unit-test request means one focused test change, not a refactor; split semantically distinct guard branches into separate named test blocks when it improves failure diagnosis. For compound guards/predicates, cover each condition branch and representative value class with compact assertions, but do not add alternate samples of the same class or unrelated preservation cases.",
    includeJsZeroDivision ? "JS/TS safe division or ratio tests: include `-0` as a named zero-denominator assertion because `-0 === 0` but raw division by `-0` produces `-Infinity`. After reading source, if the guard explicitly uses finite-number policy such as `Number.isFinite`, add one compact non-finite denominator test block for `NaN` and infinities; otherwise do not add NaN/Infinity matrices." : undefined,
    "No ls/find/grep/package/config unless the direct source or test read fails. Do not use bash/cat to discover test files; use `read` on the direct test candidate and create it only if that read fails. No baseline bash. Run the nearest test once, patch only failures, then final in the user's language with exactly 3 bullets: Changed, Verification, Notes.",
  ].filter((line): line is string => Boolean(line)).join("\n");
}

function shouldUseMinimalBoundedPathSteering(prompt: string, promptPaths: string[]): boolean {
  const promptPath = promptPaths[0] ?? "";
  const smallSinglePathCodeTest = looksLikeSmallSinglePathCodeTestPrompt(prompt, promptPath);
  const namedRefactorWithTests = looksLikeSourceOrTestPath(promptPath)
    && /\b(refactor|refactoriza|refactoring|extract|extraer)\b/i.test(prompt)
    && /\b(test|tests|testing|prueba|pruebas)\b/i.test(prompt);
  const goStatefulPath = /\.go\b/i.test(promptPath)
    && /\b(ttl|expiry|expire|expiration|cache|clock|reloj|expiraci[oó]n|state|estado|time|timer)\b/i.test(prompt)
    && /\b(test|tests|testing|prueba|pruebas)\b/i.test(prompt);
  return promptPaths.length === 1
    && !isDocsMarkdownPath(promptPath)
    && (looksLikeSourceOrTestPath(promptPath) || smallSinglePathCodeTest || goStatefulPath)
    && (hasExplicitVerificationRunner(prompt) || smallSinglePathCodeTest || goStatefulPath || namedRefactorWithTests);
}

function promptLooksScaffoldPathContract(prompt: string): boolean {
  return /\b(scaffold|greenfield|from scratch|new package|new cli|create (?:a )?(?:package|library|cli|tool)|(?:create|new|crea(?:r)?|nuevo|nueva).{0,40}\b(?:package|library|cli|tool|paquete|librer[ií]a|herramienta)|crea(?:r)? (?:un|una)? ?(?:paquete|librer[ií]a|cli|tool|herramienta)|package\.json|bin|exports?|readme|usage|uso)\b/i.test(prompt)
    && /\b(test|tests|readme|package|bin|exports?|runner|usage|uso|api|cli|library|librer[ií]a|tool|herramienta)\b/i.test(prompt);
}

function promptLooksOperationalDocsArtifact(prompt: string): boolean {
  if (/\b(architecture|arquitectura|refactor|refactoriza|migration|migraci[oó]n|deep|profund|mapa de dependencias|dependency map|plan por etapas|staged plan|cross[- ]?language|multi[- ]?language|cross[- ]?runtime|multi[- ]?runtime|runtime|ffi|ownership|responsibility|responsabilidad|owner|propietario)\b/i.test(prompt)) return false;
  return /\b(runbook|rollback|diagn[oó]stic|diagnos|diagnosticar|diagnose|troubleshoot|how to run|c[oó]mo ejecutar|ejecutar tests?|run tests?|smoke|operational|operativo)\b/i.test(prompt)
    && /\b(actualiza|update|docs?|documentation|runbook|sin c[oó]digo|no code|no cambies c[oó]digo)\b/i.test(prompt);
}

function promptLooksArchitectureDocsArtifact(prompt: string): boolean {
  return /\b(architecture|arquitectura|refactor|refactoriza|migration|migraci[oó]n|deep|profund|design|dise[ñn]o|dependency map|mapa de dependencias|ownership|responsibility|responsabilidad|plan por etapas|staged plan|layers?|capas|cross[- ]?language|multi[- ]?language|cross[- ]?runtime|multi[- ]?runtime|runtime|ffi|owner|propietario)\b/i.test(prompt)
    && /\b(actualiza|update|docs?|documentation|sin c[oó]digo|no code|no cambies c[oó]digo|no implementes c[oó]digo)\b/i.test(prompt);
}

function minimalBoundedPathSteeringMessage(prompt: string, promptPaths: string[], hasUI?: boolean): string {
  const pathContract = promptPaths.length > 0 ? `Prompt path: \`${promptPaths[0]}\`.` : undefined;
  const promptAndPath = `${prompt} ${promptPaths.join(" ")}`;
  const includeTextQuery = /\b(filter|search|query|text|texto|b[úu]squeda|title|description|descripcion|descripci[oó]n)\b/i.test(promptAndPath);
  const includeCacheTtl = /\b(ttl|expiry|expire|expiration|cache entry|clock|reloj|expiraci[oó]n)\b/i.test(promptAndPath);
  const includeStableSort = /\b(stable sort|stable sorting|orden estable|estable)\b/i.test(promptAndPath);
  const includeRateWindow = /\b(rate[- ]?limit|rate[- ]?limiter|ventanas?|windowMs|retryAfter|budget|l[ií]mite configurable)\b/i.test(promptAndPath);
  const includeCollectionKey = !includeStableSort
    && !includeRateWindow
    && /\b(collection|key|cache|marker|sort|ordenar|deterministic|deterministica|determin[ií]stica|duplicate|duplicados|case preservation|preservar case)\b/i.test(promptAndPath);
  const includeUrlPathString = /\b(url|path|scheme|host|credential|credenciales)\b/i.test(promptAndPath);
  const includeStringNormalizer = !includeUrlPathString
    && !includeCollectionKey
    && /\b(string|normalize|normaliza|normalizar|slug|slugify|saniti[sz]e|limpiar)\b/i.test(promptAndPath);
  const includeDateFormatParser = /\b(fecha|iso|yyyy-mm-dd|calendar|calendario)\b|(?:^|[_\W])date(?:$|[_\W])/i.test(promptAndPath);
  const includeNumericBounds = /\b(clamp|bounds?|range|rango|min|max|minimum|maximum|m[ií]nimo|m[aá]ximo)\b/i.test(promptAndPath);
  const includePredicateGuardCoverage = includeNumericBounds || /\b(predicate|predicado|guard|guarda|condition|condici[oó]n|branch|rama|if\b|validation|validaci[oó]n)\b/i.test(promptAndPath);
  const includeRefactorPreservation = /\b(refactor|refactoriza|refactoring|extract|extraer)\b/i.test(promptAndPath)
    && /\b(test|tests|testing|prueba|pruebas)\b/i.test(promptAndPath);
  const includeRust = /\.rs\b/i.test(promptPaths[0] ?? "") || /\b(rust|cargo)\b/i.test(prompt);
  const includeGo = /\.go\b/i.test(promptPaths[0] ?? "") || /\b(go test|golang)\b/i.test(prompt);
  const includeCommonJs = /\.cjs\b/i.test(promptPaths[0] ?? "") || /\b(commonjs|cjs|node:test|node --test)\b/i.test(prompt);
  const includePythonUnittest = /\.py\b/i.test(promptPaths[0] ?? "") && /\bunittest\b/i.test(prompt);
  const includeDelimiterParser = /\b(flag|argv|delimiter|delimitador)\b|--\w+=/.test(promptAndPath);
  const includeRegexNormalizer = /\b(regex|slug|slugify|saniti[sz]e|limpiar)\b/i.test(promptAndPath);
  const includeSlugifyDomain = /\bslugify\b/i.test(promptAndPath);
  const includeBrokenTestTriage = /\b(test|tests|bun\s+test|failing|fallando|falla|triage)\b/i.test(promptAndPath)
    && /\b(root cause|causa ra[ií]z|corrige|corrigela|corrígela|fix|deja(?:r)? .{0,30}pasando)\b/i.test(promptAndPath)
    && /\b(no cambies|no modifiques|do not change|don't change|do not modify|don't modify).{0,40}\btest\b/i.test(promptAndPath);
  const editPolicy = "Large/partial edit; tiny stubs replace once.";
  const includePackageLocalConvention = /(?:^|\/)packages\/[^/]+\/src\//.test(promptPaths[0] ?? "") || /\bpackage-local\b/i.test(promptAndPath);
  const directTestPaths = includePackageLocalConvention
    ? "test/<stem>.test.*, tests/test_<stem>.py, or package-local test/<stem>.test.*"
    : "test/<stem>.test.* or tests/test_<stem>.py";
  const packageLocalConvention = includePackageLocalConvention
    ? " Package-local convention: if the prompt already names `packages/<pkg>/src/<stem>.*`, read root `package.json` + `packages/<pkg>/test/<stem>.test.*`; if `package-local` is only a label, do not infer `<pkg>` or `<stem>` from words. Use one targeted manifest/path lookup first."
    : "";
  const genericDirectTestCandidate = includePackageLocalConvention ? undefined : sourceTestCandidateForPath(promptPaths[0] ?? "");
  if (includeBrokenTestTriage) {
    const directTestCandidate = sourceTestCandidateForPath(promptPaths[0] ?? "");
    return [
      "pi-chalin compact broken-test triage path: stay native; route only after concrete repeated verification failure.",
      hasUI ? undefined : pathContract,
      directTestCandidate ? `Direct test candidate: \`${directTestCandidate}\`.` : undefined,
      "The existing failing test is the contract. If the failing command/test path is unknown, run the user-named command once first; otherwise read source and the direct test candidate. No find/ls/manifest unless the direct source/test path fails.",
      "Edit source only. Do not add, rewrite, broaden, skip, or weaken tests unless the failing test is absent/inadequate or repo evidence proves the expectation wrong. Do not add preservation/no-op tests when the user asked only to fix a failing test.",
      "Verify once with the same failing command or direct nearest test. If it passes, final immediately; no second edit/bash/readback. Final exactly 3 bullets: Changed source path, Verification command + test path, Notes with root cause and unchanged-test evidence.",
    ].filter((line): line is string => Boolean(line)).join("\n");
  }
  return [
    "pi-chalin minimal bounded path: stay native; route only after target read proves broad ownership, generated/cross-runtime, unsafe surgery, or repeated failure.",
    hasUI ? undefined : pathContract,
    /\b(paginate|pagination|page_size|total_pages|has_next|has_prev|1-based)\b/i.test(promptAndPath) || includePythonUnittest ? "First-action invariant: read target/test evidence before write; first `write` before evidence creates parallel surfaces." : undefined,
    (includeRateWindow || includeTextQuery || includeStableSort) && genericDirectTestCandidate ? `Direct test candidate: read \`${genericDirectTestCandidate}\` before search/find.` : undefined,
    `Use named runner. First tool \`read\` the prompt path. No pre-edit bash/test unless existing tests already fail or triage. Match runner imports: node --test/.cjs => require('node:test')+node:assert, bun => bun:test, Python unittest => unittest. Inline tests/test module: edit there; else read direct test path (${directTestPaths}) before search.${packageLocalConvention} If an existing test file is read, update it; no duplicate test file. Root tests win for \`src/<stem>.*\`: use/merge into \`test/<stem>.test.*\`; no source sibling test unless tests are inline. ${editPolicy} Max 2 reads; no ls/grep/find/manifest unless target/test/runner read fails. No baseline loop.`,
    includeCommonJs ? "CommonJS/CJS: low-entropy parser fixes use `require('node:test')` plus `node:assert`; never `bun:test`. If source+test paths are known, no package/config read before first edit. Tiny source/tests may be replaced once; no write after failed verification. Cover `--name=value`, empty value, embedded `=`, boolean(s), realistic mixed argv/non-flag ignore, bare `--` as a parse terminator, empty-name boundary, single-dash ignore, and duplicate last-wins only if inherent object assignment handles it; do not add `--no-*` unless prompted. Final Verification names one `node --test`/package command." : undefined,
    includeGo ? "Go: read same-dir `<stem>_test.go` directly before find/ls; after reading source+test, no find/grep/readback before the first `go test`. After reading existing Go files use edit, not write; use simple closure fake clocks (`now := time.Unix...`, mutate `now`) instead of fakeClock structs; batch source+test edits before one `go test`." : undefined,
    includePythonUnittest ? "Python unittest: after target read, use unittest assertions; if `tests/` exists or a starter test imports the target module, update `tests/test_<stem>.py` and run `python -m unittest discover -s tests`; use root `test_<stem>.py` only when no tests root exists. No duplicate test file, no source-module rename from the function name, no pre-edit bash/ls/find/config unless the target read fails; edit source+tests before the first verification." : undefined,
    `Contract: preserve public behavior; assert changed behavior, one boundary/counterexample, and one no-op/preservation path. Multiple prompt criteria need visible assertions; no smoke-only coverage. ${includePredicateGuardCoverage ? "Predicate guards: cover each condition branch/value class. " : ""}Avoid edge matrices unless named; no-op checks behavior/order.`,
    includeRefactorPreservation ? "Refactors with tests preserve public API behavior: identify existing branches/defaults/formulas/formatting from source/tests and add one uncovered preservation edge at the public API level when coverage is thin. In typed code, keep type safety anchored in source-of-truth types rather than broad casts, duplicate type definitions, or object-bag typing; preserve explicit source-of-truth return types/interfaces for object-shaped public APIs when local style allows. Use extracted pure helpers where they enforce a real invariant; for formula/aggregation work, prefer an atomic per-entry/per-step total helper when it makes recomposition clearer. Newly public/exported helpers should own their boundary semantics such as optional/default inputs when that makes the helper independently testable, get a short responsibility comment when expanding public surface and local style allows it, and be triangulated with zero/one/many or equivalent distinct cases plus one composed public-API case. If an extracted helper covers an optional/default public input, the helper owns that default so its unit tests can call the boundary directly. Formula/aggregation/ratio refactors derive equivalence classes from existing operations: neutral/default value, meaningful extreme/ceiling/floor value, empty/one/many collection sizes when collections exist, zero-value and zero-rate cases when present, fractional values/rates that force rounding, rounding/formatting branch when present, and one composed public-API proof that helpers preserve the orchestration result. Per-entry formula helpers should get direct zero-value and fractional-rate coverage when those inputs exist; object-shaped public results should keep an explicit return type/interface when local style allows. Each independent optional/default rate, percentage, or value input in a formula gets its own visible case for omitted/undefined default and explicit zero when helper-owned; do not collapse all zero/default behavior into one public smoke test. Each extracted formula helper with rounding/formatting/threshold logic needs its own non-integer or threshold case; the composed API proof should expose order-sensitive intermediates when operation order is part of the contract. Helper-unit tests are useful, but they do not replace approval-style API-level multi-input/default/rounding coverage when those concepts already exist." : undefined,
    includeDelimiterParser ? "Delimiter parsers: split only the target delimiter with first-index/slice, preserve embedded delimiters in values, and cover empty-name/prefix boundary. For argv/CLI flags, implement requested `--name=value` and bare boolean flags, preserve existing non-flag behavior, and treat bare `--` as the standard end-of-options terminator while leaving following positionals uncollected. Do not add positional `_`, duplicate-key policy, array guards, or unrelated token families unless prompt/docs/tests require them." : undefined,
    includeRegexNormalizer ? "Regex normalizers: prefer one quantifier-based substitution when it already collapses runs; avoid redundant cleanup passes unless a test proves they are needed." : undefined,
    includeStringNormalizer ? includeSlugifyDomain
      ? "String/slug normalizers: explicit slugify helpers carry a small conventional URL-slug contract. Use stdlib-only accent folding when available, then lowercase plus one regex collapse/trim; add separate compact tests for lowercase, spaces/punctuation, separator collapse, edge trim, already-clean/digits preservation, empty string, only separators/no-alnum, and one accented Latin example. No external slugify dependency, docstrings, type guards, or broad matrices."
      : "String/slug normalizers: keep implementation to lowercase plus one regex collapse/trim. Use 6-8 separate compact tests for lowercase, spaces/punctuation, separator collapse, edge trim, already-clean/digits preservation, empty string, and only separators/no-alnum. No transliteration/accent policy, docstrings, type guards, or broad matrices unless named; final Notes mention no external dependencies when true." : undefined,
    includeDateFormatParser ? "Date/format parsers: exact full-string grammar, one single-line regex/match capture (no newline inside regex; no duplicate `.test`+`.match`), native UTC full component round-trip preferred: create one Date, verify year/month/day, return that object, and never use timestamp sign or day-only checks. No manual leap tables/fallback parsing. Use 10-12 visible tests/cases: valid normal date, leap day, valid pre-1970 date, impossible day overflow, invalid 30-day month, February overflow or non-leap day, month `00`/`13`, day `00`/`32`, leading/trailing spaces rejected unless existing behavior trims, ISO datetime/trailing data rejected, slash/timestamp malformed input, empty/non-date text, and missing zero padding. Avoid broad calendar matrices and do not assert UTC hours/min/sec." : undefined,
    includeNumericBounds ? "Numeric bounds/clamp/range: use the simplest min/max branch or `Math.min(Math.max(...))`. Use separate compact tests for below, inside, above, exact min, and exact max when min/max inclusivity is the contract; negative range only when the prompt or source evidence makes signed ranges distinct. Zero-width/no-op extras only when named or source evidence makes them distinct; inside-range already proves ordinary preservation. Do not invent reversed-bound, decimal, or non-finite policy unless evidence requires it." : undefined,
    includeTextQuery ? "Text/query filters: normalize the query once with trim+lowercase, return all items for blank/whitespace, and test 10-12 visible named behaviors in the existing nearest test file: empty query, whitespace query, title match, description match, case-insensitive title, case-insensitive description, partial match, no-match, optional/missing description, empty-string description, order preservation, and no input-array mutation. When the API returns objects, assert full returned object shape with `deepEqual` for representative matches and no-match/blank cases; use id-only assertions only as secondary order checks. Keep one behavior per test when tiny; do not group blank+whitespace or no-match+missing-field+order into combined diagnostics. If a root `test/<stem>.test.*` exists, extend it and keep its assertion API; do not create a second sibling `src/<stem>.test.*` file." : undefined,
    includeCollectionKey ? "Collection/key: split top-level vs collection segment; derive separators from prompt/source/tests; default to conventional comma-separated list segments when no repo format exists. If sorting while preserving case, sort trimmed originals lexicographically unless case-insensitive is evidenced; never lowercase/casefold the sort key just for determinism. Tests use separate named cases for full serialized key format, empty collection/segment shape, package normalization, version trim plus case/content retention, marker trim, multiple empty/whitespace filtering, ordering, case preservation, duplicate retention, and reorder determinism; do not hide case+duplicates or trim+filter+sort except one end-to-end determinism case." : undefined,
    includeCacheTtl ? "Cache/TTL: fake clock, lazy expiry through `Get`, and compact boundary coverage. Prefer a mutable local `now` variable closure; do not rewrite cache fields in tests. Prefer precomputed expiresAt+After when no createdAt contract exists; createdAt+Sub is acceptable when simpler. Exact TTL boundary valid unless evidenced otherwise, and delete expired entries on access when using an internal store. Use 5-6 compact tests: empty, set/get, overwrite value plus TTL renewal, one expiry test covering before/exact/past TTL, lazy deletion when same-package tests can inspect the map, and independent entries. Derive boundary test times from variables (`expiresAt := setTime.Add(ttl)`, then before/exact/past) instead of mental timestamp arithmetic. When independent entries should diverge, stagger their set times/windows; same-time entries with the same TTL expire together. Do not split before/exact/past into separate tests. No sleeps, fakeClock structs, TTL=0/noExpire, or sweeper semantics unless named." : undefined,
    includeStableSort ? "Stable sorts: JS/TS copy before sort (`[...items].sort`/`slice().sort`) with rank map; use original-index decorate only if runtime stability is unknown. Compare ISO date/datetime strings lexicographically; if a date field is `string`, test date-only and datetime ordering. Do not parse Date unless timezone/calendar semantics are required. Use 7-9 compact tests: empty, single/no-op, primary, secondary, combined primary+secondary, stable tie, no mutation, new reference, datetime secondary when applicable; import helper types with `import type`. Use root direct test candidate; extend existing tests, no sibling `src/<stem>.test.*`. Do not verify/final on empty/smoke-only tests. No structuredClone, broad matrices, readback, or second verification unless first fails." : undefined,
    includeRateWindow ? "Rate/window limiters: explicit source/test paths mean no ls/find. Use `options`, copy primitive `limit`/`windowMs` locals, validate both as finite positive integers inline or through a small shared helper, throw `RangeError`, no unused bucket fields, and check block before mutating. Prefer an injected clock option/closure (`now?: () => number`) over global `Date.now` monkey-patching; otherwise use runner-native fake time, never sleeps/wall-clock. Tests: 8-10 visible named cases across option validation and behavior: valid options, fractional limit/windowMs, zero/negative/nonfinite, allow/block/retryAfter, allowed retryAfter=0, independent key, and window reset. Manual reset only if prompt/source/tests say manual/API reset; reset by time means automatic window expiry. Final Notes include `sin dependencias externas` or `no external dependencies`." : undefined,
    includeUrlPathString ? "URL/path normalizers: test query/fragment, credentials, exact target path, adjacent non-target path containing the same suffix, and no-path ?/# tails. Use small helpers for authority and path/query/fragment split when recomposition is nontrivial. If the prompt names one path, do not use suffix-family matching unless repo evidence says all such suffixes normalize." : undefined,
    includeRust ? "Rust: public fns get `///`; borrowed &str after trim; no leaks/unsafe; warnings are defects. If prompt says `cargo test`, run full `cargo test` or `cargo test --workspace`; not a package-filtered command. Sorted preserved values use default lexicographic order unless the contract says case-insensitive; do not lowercase preserved values just to sort." : undefined,
    ...domainSpecificDirectContracts(promptAndPath),
    "Read back changed files only for concrete missing evidence. Verify once: named script if requested, else nearest focused test. After pass, no second run. Fail/warn: patch/rerun once. Final: Changed, Verification, Notes with 2-4 compact design/boundary decisions; no recap.",
  ].filter((line): line is string => Boolean(line)).join("\n");
}

function looksLikeSmallSinglePathCodeTestPrompt(prompt: string, promptPath: string): boolean {
  if (prompt.length > 520) return false;
  if (!/\b(test|tests|testing|unittest|commonjs|cjs|node:test|node --test|assert)\b/i.test(prompt)) return false;
  if (/\b(refactor|refactoriza|refactoring|extraer|extract|arquitectura|architecture|migration|migraci[oó]n|project-wide|proyecto completo|monorepo|multi-file|m[úu]ltiples archivos|deep|profundidad|exhaustive|exhaustivo)\b/i.test(prompt)) return false;
  if (/\b(auth|security|seguridad|token|session|refresh|cache|ttl|parser\/scanner|state machine|scanner|tokenizer)\b/i.test(prompt)) return false;
  const basename = pathBasename(promptPath).toLowerCase();
  return /\.(?:cjs|js|mjs|ts|tsx|py|rb|go|rs|c|cc|cpp)$/.test(basename);
}

function domainSpecificDirectContracts(promptAndPath: string): string[] {
  const rules: string[] = [];
  if (/\b(auth|authorization|authorize|role|roles|middleware|401|403|req\.user|next\()/i.test(promptAndPath)) {
    rules.push("Auth/middleware: test unauthenticated, unauthorized, authorized, missing/empty role collections, `next` not called on denial, response status/body on denial, and no response mutation on success when observable. HTTP middleware side effects must be observable inside the downstream handler/next step, not only after the chain returns; generated request IDs or context values need absent/present propagation plus a compact uniqueness sanity check when generation is part of the contract.");
  }
  if (/\b(error middleware|koa|catch errores|catch errors|status\/body|hide|oculta|500)\b/i.test(promptAndPath)) {
    rules.push("Error middleware: catch as `unknown` when the language supports it, narrow with type guards, and test async `next` success, explicit 4xx preservation, hidden 500 message, `expose=false`/non-exposed client errors, non-Error thrown values, and no body/status overwrite when no error is thrown. Preserve framework-style `status`/`statusCode` fallbacks when starter code or local convention exposes both.");
  }
  if (/\b(webhook|hmac|timingSafeEqual|signature|firma|sha256)\b/i.test(promptAndPath)) {
    rules.push("Crypto/webhook verification: compute expected signatures in tests from stdlib, decode received hex signatures to raw bytes before constant-time comparison, and separately cover valid, missing, malformed/non-hex, length-mismatch, well-formed-wrong, empty-payload, and tampered-payload signatures without throwing or leaking timing errors.");
  }
  if (/\b(debounce|debouncer|cancel|timer provider|fake clock|fake timer|clock)\b/i.test(promptAndPath)) {
    rules.push("Debounce/timer helpers: use an injected or fake clock, test delayed call, reset/reschedule, cancel-before-fire, call-after-cancel scheduling a fresh invocation, argument preservation, and no wall-clock sleeps. Public timer/provider surfaces get concise responsibility comments when local style allows.");
  }
  if (/\bgo\b/i.test(promptAndPath) && /\b(slug|slugify|string normalizer|normalize|normalizer)\b/i.test(promptAndPath)) {
    rules.push("Go string/slug normalizers: when building output rune-by-rune, use `strings.Builder` with `Grow(len(input))` when practical, `unicode.IsLetter`/`IsDigit` for rune-aware keepers unless ASCII-only is required, final `strings.Trim(result, \"-\")` when simpler, write ASCII separators with `WriteByte`, and keep separate named tests for lowercase, punctuation/space replacement, collapse, trim, already-clean/digits, empty, no-alphanumeric, and one accented/Unicode-letter input.");
  }
  if (/\b(api|handler|route|request|payload|body|http|next)\b/i.test(promptAndPath) && /\b(validat|validaci[oó]n|invalid|inv[aá]lid|400|email|name|payload|body)\b/i.test(promptAndPath)) {
    rules.push("HTTP/API payload validation: update the canonical runner-discovered test path, not a sibling or nested parallel test, and success tests must assert the returned body, not only status. Keep the package/existing runner and assertion API; do not introduce alternate `npx`/tsx/node:test validation when the repo uses another runner. Check body object-ness with a small type guard before destructuring, use normalized locals for returned output, reject missing/non-object/null/array bodies separately, split missing-field, wrong-type, blank-after-trim, and format errors into separate named tests, and keep error messages specific enough for callers to diagnose bad input. Email validation should use a whole-string finite pattern, not `includes`/substring checks; cover no-at, no-dot-after-at, whitespace, and malformed tiny strings when email is part of the contract. Preserve the prompt/starter error surface: if it says singular `error` and no schema says otherwise, return `{ error: string }` rather than inventing an errors array or multi-error collection. TypeScript handlers benefit from an explicit status-discriminated response union, and tests should narrow on `status` before reading body fields instead of using broad casts. Email normalization means trim plus lowercase unless starter tests or local convention explicitly preserve case. When the prompt names a created resource noun such as user/order/session, return it under that noun unless starter tests or local convention prove a flat response.");
  }
  if (/\b(feature flag|feature flags|flag evaluator|evaluateFlag|evaluate_flag|rollout|percentage|allowlist|LaunchDarkly)\b/i.test(promptAndPath)) {
    rules.push("Feature flags/rollouts: preserve prompt/starter field names and the canonical test path first (`defaultValue`, allowlist/userIds, percentage/rollout, key). Ordered rule entries are allowed only as a backward-compatible additive shape, not as a replacement for the starter API. In TypeScript, model multiple rule kinds with discriminated unions or explicit interfaces instead of a bag of optional fields and casts. Use flag key/salt only when prompt or starter API exposes one; otherwise hash deterministically by user id alone and do not add a required unrequested key field. Put substantive tests in the runner-discovered path, not a skipped root duplicate. Test default, allowlist override, rule ordering/short-circuit when rules exist, 0/100 percent boundaries, stable repeatability, non-allowlisted rollout, and a cheap distribution sanity check for percentage rollout when deterministic sampling is easy.");
  }
  if (/\b(retry|backoff|attempt)\b/i.test(promptAndPath)) {
    rules.push("Retry/backoff: test attempt 1, later exponential growth, cap, attempt==max vs attempt>max, max-attempts=1, non-transient/permanent failures with attempts remaining, invalid attempt/base/max domains, and overflow-safe capping; no sleeps or wall-clock time.");
  }
  if (/\b(lru|least[- ]recently[- ]used|capacity|evict|cache)\b/i.test(promptAndPath) && /\b(Get|Set|evict|capacity|lru)\b/i.test(promptAndPath)) {
    rules.push("Bounded caches/LRU: test miss/set/get, capacity eviction, recency promotion on Get, existing-key Set update that promotes without growth, multiple consecutive evictions, capacity zero/negative explicit contract, and no arbitrary fixed caps or silent clamps.");
  }
  if (/\b(paginate|pagination|page_size|total_pages|has_next|has_prev|1-based)\b/i.test(promptAndPath)) {
    rules.push("Pagination helpers: preserve the starter module/import surface and test file; do not create a sibling paginate/paginator module pair. Return the prompt-shaped object/dict; for framework-style pagination, include compatible metadata (`page_size`, `total_items`, and optional next/prev page numbers) unless prompt/repo evidence forbids it. Framework/Django-inspired page parameters often arrive from request strings: use the local framework/language coercion convention for numeric strings and integer-equivalent numeric values, but reject non-numeric, lossy, boolean, or non-finite values unless repo evidence accepts them. Accept ordinary sequences when the language makes that cheap, reject non-sequences, and test one non-list sequence plus one invalid item source. Django-style pagination benefits from a small exception hierarchy: invalid argument/domain errors separate from out-of-range empty-page errors, both rooted in a caller-catchable base such as ValueError when local style allows. Empty-collection total_pages policy explicit: for Django-style pagination, empty collection normally allows page 1 with total_pages=1 unless prompt/repo evidence says no empty first page; page > total_pages remains invalid unless the prompt explicitly allows overrun empty pages. Always test first/middle/last, empty collection, out-of-range, invalid page/page_size, numeric coercion compatibility, and one large collection/sample-volume case separately.");
  }
  if (/\b(parse_query|querystring|request\.args|percent-encoding|repeated values|valores repetidos)\b/i.test(promptAndPath)) {
    rules.push("Query parsers: preserve the starter module/import surface; prefer the language stdlib query parser (`urllib.parse.parse_qs`, URLSearchParams, etc.) over hand-splitting, then normalize single vs repeated values. Put unittest coverage where discovery runs it, and test empty query, repeated values, percent decoding including literal percent/unicode, blank value, plus keys with single vs repeated values.");
  }
  return rules;
}

function directWorkContract(prompt: string): string {
  const includeStateful = /\b(time|window|retry|cache|ttl|rate|budget|capacity|limit|l[ií]mite|ventana|debounce)\b/i.test(prompt);
  const includeRate = /\b(rate[- ]?limit|rate[- ]?limiter|windowMs|retryAfter|ventanas? por key|l[ií]mite configurable)\b/i.test(prompt);
  const includeTransform = /\b(sort|orden|filter|search|query|normalize|normaliza|slug|string|text|texto|date|fecha|clamp|range|bounds?|collection|key|clave|marker)\b/i.test(prompt);
  const includeDateFormatParser = /\b(fecha|iso|yyyy-mm-dd|calendar|calendario)\b|(?:^|[_\W])date(?:$|[_\W])/i.test(prompt);
  const includeParser = /\b(parser|scanner|tokenizer|state machine|flag|argv|delimiter|delimitador)\b/i.test(prompt);
  const includeTextQuery = /\b(filter|search|query|text|texto|title|description|descripci[oó]n)\b/i.test(prompt);
  const includeApiValidation = /\b(api|handler|route|request|payload|body|http|next)\b/i.test(prompt)
    && /\b(validat|validaci[oó]n|invalid|inv[aá]lid|400|email|name|payload|body)\b/i.test(prompt);
  const includeRust = /\.rs\b|\brust|cargo\b/i.test(prompt);
  const includeGo = /\.go\b|\bgo test|golang\b/i.test(prompt);
  const includePython = /\.py\b|\bpython|unittest\b/i.test(prompt);
  return [
    "Contract: derive expected behavior before coding; preserve public behavior unless evidence requires change. Tests keep starter assertions and add focused criteria plus one boundary/counterexample when requested or coverage is insufficient; predicate guards cover each condition branch/value class. Broken-test triage is source-fix first when no new tests were requested: run/observe the failing command if needed, edit implementation, rerun that same nearest test, and add coverage only if the existing failing test is absent/inadequate. Before writing tests/imports, infer the package runner and keep assertion APIs compatible: node --test/.cjs uses require('node:test') plus node:assert, bun test may use bun:test, Vitest uses vitest. Do not validate with a different runner. No placeholders/TODO. No-op assertions check behavior/order, not identity unless explicit, and may be satisfied by a normal unchanged case. Narrow token/flag/path/format/subdomain -> change only it and add adjacent preservation.",
    includeStateful ? "Stateful/time work: copy primitive config into locals when caller mutation would otherwise affect later reads; do not add caller-mutation tests unless retained options are reread. Prefer runner-native fake time (`setSystemTime` in bun:test, `vi.setSystemTime`/fake timers in Vitest), injected/fake clocks, or simple closure fake clocks over wall-clock sleeps. Cache/TTL uses lazy expiry through public Get unless a sweeper is requested; remove expired entries on access when using an internal store; use precomputed expiresAt, before/past-expiry coverage derived from variables, overwrite renewal when Set exists, and independent stored-state coverage when multiple entries are public behavior; stagger independent entries when asserting divergent expiry; do not invent exact-expiry or TTL=0/noExpire unless evidenced. Capacity/limit covers negative/zero/one and update-without-growth boundaries; no fixed caps or silent drops." : undefined,
    includeRate ? "Rate/window limiters: copy primitive `limit`/`windowMs` locals, keep the per-key bucket minimal, validate both as finite positive integers inline or through a small shared helper, throw `RangeError`, and check block before mutating. Prefer injected clock option/closure (`now?: () => number`) over global Date monkey-patching; runner-native fake time is the fallback, sleeps are invalid. Tests use visible names for option validation plus behavior: valid options, fractional limit/windowMs, zero/negative/nonfinite, allow/block/retryAfter, independent key, allowed retryAfter=0, and reset window. Manual reset only when evidenced. Final Notes say `sin dependencias externas` or `no external dependencies`." : undefined,
    includeTransform ? "For transformations: test changed behavior, representative preservation/no-op behavior, boundaries, composition with nearby metadata/suffixes, and exact ordered output when deterministic. String/slug normalizers use obvious ASCII punctuation+space, collapse/trim, already-clean/digits, empty/no-alnum, and one Unicode/accented-letter preservation case when using rune/unicode classification; no transliteration unless named. Numeric bounds cover below/inside/above plus exact min/exact max when min/max inclusivity is the contract; add negative/range cases only when prompt/source evidence makes them distinct, and do not invent reversed-bound, decimal, or non-finite policy unless evidence requires it. Collection/key transforms cover the full serialized format/delimiter, normalization, empty filtering, duplicate/case preservation, and retained inputs once unless dedupe/drop is explicit; sort preserved values by their original normalized output string unless evidence requires case-insensitive ordering; split prompt-named trim/case/filter/sort/duplicate/determinism rules into separate named tests when cheap. Stable sorts use tiny separate tests for priority, secondary order, tie stability, and no mutation without timestamp samples unless evidenced." : undefined,
    includeParser ? "Parsers/scanners/state machines cover states/transitions, adjacency/protected text, termination, escaping, EOF/error, previous/next separation, and do not invent unrelated token families unless requested. Delimited spans need tests for delimiter at EOF or missing terminator, escaped delimiters inside the span, marker text inside quotes/protected text, and adjacency on both sides when the prompt names adjacent tokens. SQL/SQLite-like single-quoted string tokenizers consume doubled single quotes (`''`) as an escaped quote before looking for the closing quote, so `--` inside that string is data rather than a comment." : undefined,
    includeDateFormatParser ? "Date/format parser coverage is strict but bounded: exact full-string grammar, native component round-trip, valid normal/leap/pre-epoch dates, invalid 30-day month, February overflow/non-leap day, month/day range errors, leading/trailing spaces unless trimming is evidenced, ISO datetime/trailing data, malformed separators, empty/non-date text, and missing zero padding." : undefined,
    includeTextQuery ? "Text/query filters trim the query before matching and test 10-12 visible named behaviors without broad matrices: empty, whitespace, title, description, case-insensitive title, case-insensitive description, partial, no-match, optional/missing fields, empty-string optional fields, order preservation, and no input mutation. Object-returning filters need full-shape `deepEqual` assertions for representative matches, not only mapped ids; id-only checks are fine as secondary order checks. Keep one behavior per test when tiny; extend the existing nearest test file and assertion style when one is present." : undefined,
    includeApiValidation ? "HTTP/API payload validation: update the canonical runner-discovered test path, not a sibling or nested parallel test, and success tests must assert the returned body, not only status. Keep the package/existing runner and assertion API; do not introduce alternate `npx`/tsx/node:test validation when the repo uses another runner. Check body object-ness with a small type guard before destructuring, use normalized locals for returned output, reject missing/non-object/null/array bodies separately, split missing-field, wrong-type, blank-after-trim, and format errors into separate named tests, and keep error messages specific enough for callers to diagnose bad input. Email validation should use a whole-string finite pattern, not `includes`/substring checks; cover no-at, no-dot-after-at, whitespace, and malformed tiny strings when email is part of the contract. Preserve the prompt/starter error surface: if it says singular `error` and no schema says otherwise, return `{ error: string }` rather than inventing an errors array or multi-error collection. TypeScript handlers benefit from an explicit status-discriminated response union, and tests should narrow on `status` before reading body fields instead of using broad casts. Email normalization means trim plus lowercase unless starter tests or local convention explicitly preserve case. When the prompt names a created resource noun such as user/order/session, return it under that noun (for example `{ user: normalizedUser }`) unless starter tests or local convention prove a flat response; add generated resource IDs only when prompt or existing convention says created resources include IDs." : undefined,
    includeRust ? "Rust text transforms: public fns get `///`, prefer borrowed &str after trim, no leaks/unsafe, warnings are defects. Preserve case/duplicates when the contract names them; sort preserved values with default lexicographic order unless the contract says case-insensitive. If the prompt says `cargo test`, verify with full `cargo test` or `cargo test --workspace`, not only a package-filtered command." : undefined,
    includeGo ? "Go exported APIs get concise doc comments when local style expects them; read same-dir `<stem>_test.go` directly before find/ls; after source+test reads, no find/grep/readback before the first `go test`; after reading existing Go files use edit, not write." : undefined,
    includePython ? "Python/unittest: preserve the module path proven by starter imports or existing stubs. If a `tests/` root exists, put substantive unittest coverage in `tests/test_<stem>.py` and verify with `python -m unittest discover -s tests`; do not create a root duplicate that the runner skips." : undefined,
    ...domainSpecificDirectContracts(prompt),
    "Validation ordering: if returned output is trimmed/lowercased/normalized, validate the normalized local rather than rejecting a raw but normalizable value. Explicit numeric/domain bounds such as positive, finite, max, cap, or 1-based are validation contracts for new helpers; fail fast for out-of-domain inputs unless existing behavior requires compatibility coercion.",
    "Before verification, preflight new assertions: syntax/brackets compile, test data terms hit intended rows, expected sorted/filtered order follows the contract, and the verification command matches the repo/package runner.",
  ].filter((line): line is string => Boolean(line)).join(" ");
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

function docsDirectSourceCandidateMessage(prompt: string): string | undefined {
  const operationNames = docsOperationNames(prompt);
  if (operationNames.length === 0) return undefined;
  const candidates = operationNames.flatMap(sourceCandidatesForOperation).slice(0, 4);
  if (candidates.length === 0) return undefined;
  const primary = candidates[0];
  const fallbackCandidates = candidates.slice(1);
  const quotedFallbacks = fallbackCandidates.map((candidate) => `\`${candidate}\``).join(", ");
  const quotedNames = operationNames.map((name) => `\`${name}\``).join(", ");
  return `Direct source candidate from prompt operation ${quotedNames}: read \`${primary}\` before any find. Use fallback ${quotedFallbacks || "source candidates"} only if that direct read fails. Do not read every extension variant after a hit, do not glob source/test trees, and do not run test globs before the package runner.`;
}

function docsOperationNames(prompt: string): string[] {
  const names = new Set<string>();
  const patterns = [
    /\bfallo\s+(?:de|del|en)\s+([A-Za-z_][A-Za-z0-9_-]{2,})/gi,
    /\bfailure\s+(?:of|in|for)\s+([A-Za-z_][A-Za-z0-9_-]{2,})/gi,
    /\bdiagnosticar\s+(?:fallo\s+(?:de|del|en)\s+)?([A-Za-z_][A-Za-z0-9_-]{2,})/gi,
    /\bdiagnose\s+(?:failure\s+(?:of|in|for)\s+)?([A-Za-z_][A-Za-z0-9_-]{2,})/gi,
    /\b(?:debug|troubleshoot)\s+([A-Za-z_][A-Za-z0-9_-]{2,})/gi,
    /`([A-Za-z_][A-Za-z0-9_-]{2,})`/g,
  ];
  for (const pattern of patterns) {
    for (const match of prompt.matchAll(pattern)) {
      const name = normalizeOperationName(match[1] ?? "");
      if (name && !DOCS_OPERATION_STOP_WORDS.has(name.toLowerCase())) names.add(name);
    }
  }
  return [...names].slice(0, 2);
}

const DOCS_OPERATION_STOP_WORDS = new Set([
  "artifact",
  "codigo",
  "code",
  "docs",
  "document",
  "evidencia",
  "evidence",
  "failure",
  "fallo",
  "package",
  "repo",
  "rollback",
  "runbook",
  "seguro",
  "source",
  "test",
  "tests",
]);

function normalizeOperationName(value: string): string {
  return value.replace(/^[`'"]+|[`'".,;:!?]+$/g, "").trim();
}

function sourceCandidatesForOperation(name: string): string[] {
  const variants = new Set([name]);
  const kebab = name.replace(/([a-z0-9])([A-Z])/g, "$1-$2").replaceAll("_", "-").toLowerCase();
  if (kebab !== name) variants.add(kebab);
  const lower = name.toLowerCase();
  if (lower !== name && lower !== kebab) variants.add(lower);
  const candidates: string[] = [];
  for (const variant of variants) {
    candidates.push(`src/${variant}.ts`, `src/${variant}.js`);
  }
  return candidates;
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
  if (!normalized.includes("/")) return looksLikeFileBasename(fileName) || isRootExactPathBasename(fileName);
  return fileName.includes(".");
}

function isExactPromptPathMention(value: string): boolean {
  if (!value) return false;
  const normalized = value.replaceAll("\\", "/");
  if (normalized.includes("://")) return false;
  if (normalized.startsWith("./")) return true;
  if (normalized.includes("/")) return true;
  return isRootExactPathBasename(normalized);
}

function isRootExactPathBasename(value: string): boolean {
  return /^(?:AGENTS\.md|CHANGELOG\.md|README(?:\.md)?|bun\.lock|bun\.lockb|Cargo\.lock|Cargo\.toml|composer\.json|deno\.jsonc?|go\.mod|go\.sum|package-lock\.json|package\.json|pnpm-lock\.yaml|pyproject\.toml|requirements(?:-[A-Za-z0-9_.-]+)?\.txt|tsconfig(?:\.[A-Za-z0-9_-]+)?\.json|uv\.lock|yarn\.lock)$/i.test(value);
}

function looksLikeFileBasename(fileName: string): boolean {
  return /\.(?:bash|c|cc|cjs|cpp|cs|css|go|h|hpp|html|java|js|json|jsx|kt|lock|md|mjs|php|py|rb|rs|scss|sh|sql|swift|toml|ts|tsx|txt|xml|ya?ml|zig)$/i.test(fileName);
}

function isDocsMarkdownPath(value: string): boolean {
  const normalized = value.replaceAll("\\", "/");
  const relative = normalized.startsWith("./") ? normalized.slice(2) : normalized;
  return relative.endsWith(".md");
}

function pathBasename(value: string): string {
  const normalized = value.replaceAll("\\", "/");
  const segments = normalized.split("/");
  return segments.at(-1) ?? normalized;
}

function sourceTestCandidateForPath(value: string): string | undefined {
  const normalized = value.replaceAll("\\", "/");
  const basename = pathBasename(normalized);
  const match = basename.match(/^(.+)\.(ts|tsx|js|jsx|mjs|cjs)$/i);
  if (!match) return undefined;
  const [, stem, extension] = match;
  if (!stem || !extension) return undefined;
  return `test/${stem}.test.${extension}`;
}

function packageLocalTestCandidateForPath(value: string): string | undefined {
  const normalized = value.replaceAll("\\", "/");
  const match = normalized.match(/^(.*\/packages\/[^/]+|packages\/[^/]+)\/src\/([^/]+)\.(ts|tsx|js|jsx|mjs|cjs)$/i);
  if (!match) return undefined;
  const [, packageRoot, stem, extension] = match;
  if (!packageRoot || !stem || !extension) return undefined;
  return `${packageRoot}/test/${stem}.test.${extension}`;
}

function goTestPathForSource(value: string): string | undefined {
  const normalized = value.replaceAll("\\", "/");
  if (!/\.go$/i.test(normalized) || /_test\.go$/i.test(normalized)) return undefined;
  const directory = normalized.includes("/") ? normalized.slice(0, normalized.lastIndexOf("/")) : "";
  const basename = pathBasename(normalized).replace(/\.go$/i, "_test.go");
  return directory ? `${directory}/${basename}` : basename;
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
