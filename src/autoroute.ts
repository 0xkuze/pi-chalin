import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { AgentCatalog } from "./agents.ts";
import { loadEffectiveConfig } from "./config.ts";
import { createConfiguredMemoryStore } from "./memory-provider.ts";
import { buildCompactChalinCriticalSystemPrompt, buildCompactChalinOrchestratorSystemPrompt, buildCompactChalinResumeSystemPrompt, buildChalinOrchestratorSystemPrompt } from "./orchestration.ts";
import { isUsableStepHandoff, loadResumableRunState } from "./runner-state.ts";
import { beginChalinTurn, recordDirectToolCompletion } from "./runtime-state.ts";
import type { RunState } from "./schemas.ts";
import { setChalinStatus } from "./ui-status.ts";

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
    const resumableRun = looksLikeContinuationPrompt(promptText) ? loadResumableRunState({ cwd: ctx.cwd }) : undefined;
    const useCompactResumePrompt = Boolean(resumableRun);
    const useCompactPrompt = shouldUseCompactDirectOrchestrationPrompt(promptText);
    const useCompactCriticalPrompt = !useCompactResumePrompt && !useCompactPrompt && shouldUseCompactChalinCriticalPrompt(promptText);
    const catalog = useCompactResumePrompt || useCompactPrompt || useCompactCriticalPrompt ? undefined : AgentCatalog.load({ cwd: ctx.cwd });
    const orchestrationPrompt = useCompactResumePrompt
      ? buildCompactChalinResumeSystemPrompt()
      : useCompactPrompt
      ? buildCompactChalinOrchestratorSystemPrompt()
      : useCompactCriticalPrompt ? buildCompactChalinCriticalSystemPrompt() : buildChalinOrchestratorSystemPrompt(catalog?.list() ?? []);
    const memoryContext = useCompactResumePrompt ? undefined : await globalMemoryContextForPrompt(ctx.cwd, promptText);
    return {
      systemPrompt: `${event.systemPrompt}\n\n${orchestrationPrompt}${memoryContext ? `\n\n${memoryContext}` : ""}`,
      message: {
        customType: useCompactResumePrompt ? "pi-chalin-resume-orchestration" : useCompactPrompt ? "pi-chalin-direct-compact-orchestration" : useCompactCriticalPrompt ? "pi-chalin-critical-compact-orchestration" : "pi-chalin-orchestration",
        content: useCompactResumePrompt && resumableRun ? compactResumeSteeringMessage(resumableRun) : useCompactPrompt ? compactDirectSteeringMessage(ctx.hasUI) : useCompactCriticalPrompt ? compactCriticalSteeringMessage(ctx.hasUI) : [
          "If the user says continue/resume/continua/continúa/sigue/reanuda/retoma after an interrupted pi-chalin run, call chalin_resume before answering from partial findings.",
          "pi-chalin preflight: if this is branch/project analysis, architecture/planning, broad/project-wide review, project-wide refactor strategy, complex/risky multi-file implementation, or memory recall, call chalin_route first. Bounded read-only mini-project reviews, bounded scaffolding, named-file bugfixes, named-file refactors, and simple implementation with explicit acceptance criteria should stay direct.",
          "For explicit small bugfix/test requests with named files, inspect the target files once, edit promptly, and verify. Do not route or dry-run unless the change is broad, destructive, a security-sensitive mutation, or ambiguous.",
          "Also call chalin_route for risky surgical/long-file edits; use scout → planner → worker → reviewer so the edit stays targeted and verified.",
          "If the user asks to compare independent approaches/options, choose chalin_route with parallel planners/reviewers and synthesize the recommendation afterward.",
          "Choose topology/agents yourself. Use one chalin_route call only, then synthesize from its handoff; do not inspect files directly unless a concrete gap remains.",
          ctx.hasUI ? undefined : "Non-interactive mode: avoid dry-run for safe bounded edits; either edit directly or run a real chalin_route. Use dryRun only for destructive/high-risk/ambiguous work that genuinely needs user review.",
          "Simple chat, definitions, one obvious command, tiny isolated edits, bounded read-only mini-project reviews, named-file bugfixes, or bounded scaffolding/simple implementation tasks with explicit files stay direct. Direct mode must still satisfy every explicit acceptance criterion exactly, including requested helper extraction, tests, no dependency additions, and behavior preservation. If the user asks for tests, changing only implementation is incomplete even when existing tests pass; add or update the relevant test file before final verification. Those tests must prove the requested behavior with at least one non-trivial positive case and one meaningful edge/failure case when applicable; merely renaming or preserving a starter smoke/empty test is incomplete. For time/window behavior, make tests deterministic with an injected or controlled clock when possible; avoid brittle mock timer APIs unless you verify the current Bun API in this project. Do not assert exact `Date.now()`-derived milliseconds against real wall time. For dependency-free TypeScript scaffolding, write the exact requested files, keep requested APIs/exported helpers in the requested source file, prefer package.json test script `bun test`, put tests under `test/`, avoid uninstalled runners like tsx/vitest/jest, export the requested API, declare requested package.json `bin` entries that point to executable file paths, never command strings, and fix verification failures and rerun verification after the final edit before answering. For Bun CLI subprocess tests, derive target paths directly with `import.meta.url` and pass `env: { ...process.env, ...overrides }` so stripped PATH/NODE_OPTIONS cannot create false failures. After edits plus a passing final verification, answer immediately with changed files, verification result, and one note naming the requested behavior/constraint satisfied.",
        ].filter((line): line is string => Boolean(line)).join("\n"),
        display: false,
      },
    };
  });

  pi.on("agent_end", (_event, ctx) => {
    setChalinStatus(ctx, { kind: "idle" });
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

    const eventArgs = (event as { args?: { command?: unknown } }).args;
    const { shouldProgressNudge, shouldReadyToVerifyNudge, shouldFailureNudge, shouldMissingTestNudge, shouldCompletionNudge, verificationCommand } = recordDirectToolCompletion({
      toolName: event.toolName,
      isError: event.isError,
      command: typeof eventArgs?.command === "string" ? eventArgs.command : undefined,
      argsText: eventArgs ? JSON.stringify(eventArgs) : undefined,
    });
    if (shouldProgressNudge) {
      pi.sendMessage({
        customType: "pi-chalin-direct-progress-nudge",
        content: "You have changed files for a bounded direct task. If the user asked for tests and you have not changed a test/spec file, add or update the relevant test before verification. Tests must prove the requested behavior with non-trivial assertions, not only keep or rename the starter smoke/empty test. For timer code, prefer injected clocks/schedulers over brittle mock timer APIs; for Bun CLI subprocess tests, preserve process.env and derive target file URLs directly. Then run the nearest relevant verification command. If it fails, fix only the root cause and rerun verification after the last edit; then answer. The final answer must name the changed file paths and the exact verification command/result. Do not continue exploring unless a concrete acceptance criterion is still missing.",
        display: false,
      }, { triggerTurn: false, deliverAs: "steer" });
    }
    if (shouldReadyToVerifyNudge) {
      pi.sendMessage({
        customType: "pi-chalin-direct-ready-to-verify-nudge",
        content: [
          "Implementation and required test/doc edits are now in place for this bounded direct task.",
          "Before verification, sanity-check that requested tests are behavior-bearing: they should assert the requested outputs/effects and relevant edge cases, not only a starter empty/smoke path.",
          "Stop planning/exploring. Run the nearest relevant verification command now, normally `bun test` for dependency-free Bun fixtures. If it passes, answer immediately.",
          "If verification fails, fix only the root cause and rerun the same nearest verification after the final edit. A final answer with a failed/stale Verification is invalid.",
        ].join("\n"),
        display: false,
      }, { triggerTurn: false, deliverAs: "steer" });
    }
    if (shouldFailureNudge) {
      const commandText = verificationCommand ? `\`${verificationCommand}\`` : "the verification command";
      pi.sendMessage({
        customType: "pi-chalin-direct-verification-failed-nudge",
        content: [
          `${commandText} failed after file changes.`,
          "Do NOT answer as done yet. Read the failure, fix the root cause, and rerun the nearest relevant verification after the final edit. You may not answer with a failed or stale Verification result.",
          "If this is dependency-free TypeScript scaffolding, do not add uninstalled runners; write the exact requested files, keep requested APIs/exported helpers in the requested source file, use Bun's test runner with `bun test`, keep tests in `test/`, and fix imports/scripts so `bun test` passes.",
          "If the failure involves time/window logic, remove wall-clock flakiness: inject/control the clock or make assertions tolerant before rerunning verification. Prefer an injected scheduler over mock timer APIs unless you verify the current Bun mock timer API.",
          "If the failure is a Bun CLI subprocess test, preserve the parent environment with `env: { ...process.env, ...overrides }` and derive the CLI path directly from `import.meta.url`; do not compute a parent directory twice.",
        ].join("\n"),
        display: false,
      }, { triggerTurn: false, deliverAs: "steer" });
    }
    if (shouldMissingTestNudge) {
      pi.sendMessage({
        customType: "pi-chalin-direct-tests-missing-nudge",
        content: [
          "The user requested tests, but the changed files so far do not include a test/spec file.",
          "Do NOT answer as done yet. Your next action must be an edit/write to the relevant test/spec file, not a final answer.",
          "Add or update the test so it proves the requested behavior with non-trivial assertions and meaningful edge/failure coverage where applicable, rerun the nearest verification command, then answer with changed implementation and test paths.",
        ].join("\n"),
        display: false,
      }, { triggerTurn: true, deliverAs: "steer" });
    }
    if (!shouldCompletionNudge) return;
    const commandText = verificationCommand ? `\`${verificationCommand}\`` : "the verification command";
    pi.sendMessage({
      customType: "pi-chalin-direct-completion-nudge",
      content: [
        `You changed files and ${commandText} passed.`,
        "If the user's acceptance criteria are satisfied and this passing verification happened after the last edit, answer now using this exact compact evidence format:",
        "Passing tests is not enough by itself: before answering, compare the changed files against every explicit prompt requirement, including requested package metadata, bin/scripts, docs, tests, public API, and no-dependency constraints. If tests were requested but they only cover a starter smoke/empty path instead of the requested behavior, do not answer yet; improve the tests and rerun verification.",
        "- Changed: `path/to/file`[, `path/to/test`]",
        `- Verification: ${commandText} passed`,
        "- Notes: one short sentence naming the requested behavior/constraint you satisfied, such as edge case covered, no external dependencies, or time reset behavior",
        "Do not omit the Verification or Notes line. Do not call more tools unless a concrete requested requirement is still missing.",
      ].join("\n"),
      display: false,
    }, { triggerTurn: false, deliverAs: "steer" });
  });

  pi.on("session_shutdown", () => {
    // No background auto-routing workers are owned by this module anymore.
    // Subagent execution is driven through the chalin_route tool and Pi's native
    // abort signal.
  });
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

export function looksLikeContinuationPrompt(prompt: string): boolean {
  const text = prompt.trim().toLowerCase();
  if (!text) return false;
  return /^(continua|continúa|continuar|continue|resume|resumir|reanuda|reanudar|retoma|retomar|sigue|seguir|dale|go on|keep going)(?:\b|[.!?]*)/i.test(text);
}

export function shouldUseCompactDirectOrchestrationPrompt(prompt: string): boolean {
  const text = prompt.toLowerCase();
  if (!text.trim()) return false;
  if (looksLikeChalinOrchestrationWork(text)) return false;
  const pathMentions = countPathMentions(prompt);
  const hasDirectMutationVerb = /\b(implementa|implementar|implement|fix|corrige|corregir|refactor|refactoriza|añade|agrega|add|update|actualiza|scaffold|scaffoldea|crea|create|write|escribe)\b/i.test(prompt);
  const hasScaffoldContract = /\b(scaffold|scaffoldea|greenfield|desde cero|librer[ií]a|cli|package\.json|readme|sin dependencias|no external dependencies)\b/i.test(prompt)
    && /\b(test|tests|prueba|pruebas|src\/|package\.json|readme|api|export)\b/i.test(prompt);
  return (hasDirectMutationVerb && pathMentions > 0 && pathMentions <= 6) || hasScaffoldContract;
}

export function shouldUseCompactChalinCriticalPrompt(prompt: string): boolean {
  const text = prompt.toLowerCase();
  return /\b(long-file|archivo largo|surgical|quir[uú]rgic|evita reescribir|avoid rewrite|auth|refresh token|security-sensitive|seguridad|dos cambios independientes|independent implementation|modulos separados|m[oó]dulos separados)\b/i.test(text)
    && /\b(implementa|implement|cambia|change|fix|corrige|agrega|add|tests|pruebas|worker|parallel|paralel)\b/i.test(text);
}

function compactResumeSteeringMessage(run: RunState): string {
  const completed = run.steps.filter((step) => isUsableStepHandoff(step)).length;
  const total = Math.max(run.steps.length, 1);
  const next = run.steps.find((step) => !isUsableStepHandoff(step));
  return [
    "Continuation intent detected and a resumable pi-chalin run exists.",
    `Run id: ${run.id}. Status: ${run.status}. Progress: ${completed}/${total}. Next agent: ${next?.agent ?? "unknown"}.`,
    `First action MUST be \`chalin_resume\` with {"runId":"${run.id}"}.`,
    "Do not call `chalin_route`; do not restart the workflow; do not answer from partial findings.",
    "After `chalin_resume` returns, answer the user from its Final answer material.",
  ].join("\n");
}

function compactCriticalSteeringMessage(hasUI?: boolean): string {
  return [
    "pi-chalin critical preflight: this is risky/complex/surgical work. First action must be `chalin_route`; do not answer direct and do not inspect with native tools first.",
    hasUI ? undefined : "Non-interactive mode: one real chalin_route, then stop from the chalin handoff; no post-chalin native exploration.",
    "Use worker/reviewer discipline: decompose, assign ownership, verify, and preserve a compact final handoff.",
  ].filter((line): line is string => Boolean(line)).join("\n");
}

function compactDirectSteeringMessage(hasUI?: boolean): string {
  return [
    "pi-chalin compact preflight: this looks like bounded direct work. Prefer native tools; do not spend budget on orchestration prose or visible planning before tool calls.",
    hasUI ? undefined : "Non-interactive mode: first action should be a relevant tool call; inspect briefly, write promptly, verify, fix failures, rerun verification after the final edit, then final answer.",
    "For dependency-free TypeScript scaffolding: exact requested files, Bun test runner, tests under test/, no uninstalled runners/dependencies, exported requested API. If it is a CLI package, declare the requested command in package.json `bin`, not only in `scripts`; `bin` values must be executable file paths such as `./src/cli.ts` or `./bin/name`, never runtime command strings.",
    "If tests are requested, make them behavior-bearing: assert requested outputs/effects and edge/failure cases instead of only preserving starter smoke/empty tests.",
    "For timer behavior, prefer injected clocks/schedulers over brittle mock timer APIs. For Bun CLI subprocess tests, preserve process.env and derive paths directly from import.meta.url.",
    "If the prompt says review-only, docs-only, no code changes, or no mutations, obey that literally: do not add tests/source files or modify code unless the user explicitly asks.",
    "Final answer must include Changed, Verification, and Notes. Do not continue exploring after verification passes.",
  ].filter((line): line is string => Boolean(line)).join("\n");
}

function looksLikeChalinOrchestrationWork(text: string): boolean {
  return /\b(en profundidad|deep|todo el proyecto|project-wide|arquitectura|architecture|migration|migraci[oó]n|strategy|estrategia|review completo|security review|broad|riesgoso|risky|long-file|archivo largo|surgical|quir[uú]rgic|paralel|parallel|compare approaches|opciones|resume|contin[uú]a|memory|memoria)\b/i.test(text);
}

function countPathMentions(prompt: string): number {
  const matches = prompt.match(/(?:^|[\s`'"])(?:[\w.-]+\/)+[\w.@-]+|(?:^|[\s`'"])(?:package\.json|README\.md|tsconfig\.json|pyproject\.toml|Cargo\.toml|go\.mod)(?=$|[\s`'".,:;)]|)/gi);
  return matches?.length ?? 0;
}

function chalinRouteBlockedReason(event: unknown): string | undefined {
  const details = (event as { result?: { details?: { approval?: { action?: unknown; reason?: unknown }; routeGuard?: { action?: unknown; reason?: unknown } } } }).result?.details;
  if (details?.routeGuard?.action === "direct-recommended") {
    const reason = details.routeGuard.reason;
    return typeof reason === "string" && reason.trim() ? `direct-recommended: ${reason}` : "direct-recommended";
  }
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
