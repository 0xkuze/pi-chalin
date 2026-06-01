import type { AgentCapability, AgentDefinition, EvidenceClaim, ResolvedSkill, RouteKind, ToolBudgetProfile } from "./schemas.ts";
import { policyForStep } from "./budget.ts";
import { buildProjectDiscoveryIndex, formatProjectDiscoveryIndex } from "./discovery.ts";
import type { RunStepState } from "./schemas.ts";
import { formatActiveSkillsForPrompt } from "./skills.ts";

export interface SdkPromptOptions {
  rootTask?: string;
  priorFilesRead?: string[];
  synthesisGapReadLimit?: number;
  memoryContext?: string;
  previousClaims?: EvidenceClaim[];
  activeSkills?: ResolvedSkill[];
  suggestedSkills?: ResolvedSkill[];
  rejectedSkills?: Array<{ skill: { qualifiedName: string }; reason: string }>;
}

export interface ChildToolOptions {
  budgetProfile?: ToolBudgetProfile;
  routeKind?: RouteKind;
  memoryEnabled?: boolean;
  delegationDepth?: number;
  maxDelegationDepth?: number;
  previousClaimsNeedAudit?: boolean;
}

export function buildSdkPrompt(
  agent: AgentDefinition | undefined,
  task: string,
  cwd: string,
  previous?: string,
  budget: ReturnType<typeof policyForStep> | number = toolBudgetForAgent(agent),
  budgetProfile: ToolBudgetProfile = "normal",
  options: SdkPromptOptions = {},
): string {
  const discoveryIndex = formatProjectDiscoveryIndex(buildProjectDiscoveryIndex(cwd));
  const capabilities = agent?.capabilities ?? [];
  const mutationRelevant = Boolean(agent && (
    agent.concern === "implementation"
    || agent.concern === "conflict-resolution"
    || capabilities.includes("edit-files")
    || capabilities.includes("write-new-files")
  ));
  const implementationReviewRelevant = Boolean(agent?.concern === "review" && implementationReviewText([task, previous, options.rootTask].filter(Boolean).join("\n")));
  const contractText = [task, previous, options.rootTask].filter(Boolean).join("\n");
  const implementationContractRelevant = implementationReviewText(contractText);
  const scaffoldContractRelevant = /\b(scaffold|greenfield|package|package\.json|cli|bin|entrypoint|readme|build script|typescript|javascript|npm|pnpm|yarn|bun|crate|cargo)\b/i.test(contractText);
  const parserContractRelevant = /\b(parser|scanner|tokenizer|lexer|grammar|state machine|delimiter|escape|quote|quoted|string literal|comment|sql|sqlite|redis|unicode|ttl|expire)\b/i.test(contractText);
  const normalizationContractRelevant = /\b(sort|order|normaliz|canonical|case|casefold|lowercase|uppercase|duplicate|marker|key builder|filter|trim|preserv(?:e|ing)|retention)\b/i.test(contractText);
  const timeContractRelevant = /\b(time|date|retry|cache|rate|budget|ttl|expire|window|deadline|timeout)\b/i.test(contractText);
  const budgetPolicy = typeof budget === "number"
    ? policyForStep(agent, { agent: agent?.name ?? "agent", task, budget: budgetProfile }, "single-agent")
    : budget;
  const maxTools = typeof budget === "number" ? budget : budget.caps.maxToolCalls;
  const profile = typeof budget === "number" ? budgetProfile : budget.profile;
  const deepProjectAnalysis = profile === "deep";
  const handoffGapMode = isHandoffGapReadMode(agent, previous, deepProjectAnalysis);
  return [
    compactAgentInstructions(agent),
    "",
    "## pi-chalin concern/capability policy",
    `- Concern: ${agent?.concern ?? "delegation"}.`,
    `- Capabilities: ${capabilities.join(", ") || "inspect-files, search-files"}.`,
    "- Tools follow capabilities; do not assume another agent's tools.",
    "",
    "## pi-chalin child tool policy",
    "- Native read/find/grep/ls inspect; edit existing files; write new paths only. Prefer native diffs over shell.",
    "- chalin_project_discovery/snapshot are raw inventory only; read exact evidence before claims.",
    "- Bash is full shell access when this role has the capability; use judgment and purposeful commands.",
    "",
    formatActiveSkillsForPrompt(options.activeSkills ?? []),
    options.activeSkills?.length ? "" : undefined,
    "## pi-chalin runtime budget",
    `- Profile: ${profile}. Max tools: ${maxTools}.`,
    `- Caps: ${budgetPolicy.caps.maxSeconds}s, $${budgetPolicy.caps.maxUsd}, ${budgetPolicy.caps.maxTurns} turns, ${budgetPolicy.caps.maxFilesTouched} files, ${budgetPolicy.caps.maxRetriesPerTool} retries/tool.`,
    "- Stay bounded; avoid exhaustive crawls unless explicitly required.",
    agent?.concern === "recon" || deepProjectAnalysis
      ? "- AGENTS/JIT-first: when the discovery index lists AGENTS.md, CONTEXT.md, ADRs, or package instruction files, read the root instructions first and then only the package instruction files relevant to the task before broad source reads."
      : undefined,
    profile === "tight"
      ? "- Tight profile: use the discovery index first, then inspect only the smallest evidence set needed to answer."
      : profile === "deep" || profile === "extended"
        ? "- Deep/autonomous profile: discovery first, breadth-first compact notes, checkpoint/compress at stage boundaries."
        : "- Normal profile: discovery first, then inspect only needed evidence files.",
    profile === "deep" && agent?.concern === "recon"
      ? "- Deep recon is surface-complete, not file-exhaustive: select representative evidence for each architectural surface, prefer grep/find over adjacent full-file reads, and synthesize once the remaining reads would only add repetition."
      : undefined,
    agent?.concern === "context-building"
      ? "- Context handoff completeness: follow imports, callers, tests, fixtures, config, docs, and adjacent patterns until the implementation approach, risks, and validation path are evidence-backed; do not omit a domain-critical file/source just to keep the handoff short. Name remaining gaps explicitly."
      : undefined,
    agent?.concern === "recon" && implementationContractRelevant
      ? "- Implementation scouting: map source+test evidence per requested behavior. Do not call tests sufficient/as-is unless each criterion has a direct runner-discoverable assertion; hand off missing regressions."
      : undefined,
    "- Prefer concise evidence; stop after high-value actionable issues.",
    evidenceClaimDiscipline(),
    "- Preserve failure triggers/counterexamples before adjacent findings.",
    mutationRelevant ? "- Impl/test: derive the contract from prompt+repo evidence. Tests are contract oracles: preserve starter assertions unless disproven; add focused criteria plus one boundary/counterexample; cover changed and preservation/no-op/composition paths. Preserve public compatibility unless evidence requires. Narrow token/flag/path/format means local change plus adjacent preservation. Invalid/reject requirements are contract." : undefined,
    mutationRelevant && timeContractRelevant ? "- Time/window/retry/cache/rate/budget behavior prefers internal test seams or runner-native fake time without expanding public APIs; use Bun `setSystemTime`, Vitest fake timers, or the smallest scoped Date.now restore instead of ad hoc sleeps." : undefined,
    mutationRelevant && normalizationContractRelevant ? "- Normalization/filter contracts: capture normalized config so caller-side object mutation cannot alter runtime semantics. Text/query filters need trim/blank, no-match, order, and preservation assertions when relevant." : undefined,
    mutationRelevant && previous?.trim() ? "- Upstream handoffs are context, not authority. Before skipping tests/docs, compare Original User Goal criteria against repo evidence." : undefined,
    mutationRelevant ? "- Code behavior changes update nearest tests unless existing assertions cover every criterion; final distinguishes edited tests from evidence-only tests. Test files register runner-discoverable cases; zero-test assertion scripts are invalid. A narrower step task cannot forbid tests unless the Original User Goal explicitly forbids test edits." : undefined,
    mutationRelevant ? "- Coverage breadth: multiple requested rules get separate compact tests per rule plus one composition/determinism case; do not collapse several requirements into one smoke test." : undefined,
    mutationRelevant && normalizationContractRelevant ? "- Normalization/key APIs need 8-12 focused visible tests when the public contract has several rules, not one smoke." : undefined,
    mutationRelevant && scaffoldContractRelevant ? "- Scaffold/package work: requested files, metadata, entrypoints, build output, tests, docs, and language/toolchain agree. Tests use the runner's discoverable API. CLI bins target real executables; CLI tests cover API + real command path, with args/no-input when relevant." : undefined,
    mutationRelevant && parserContractRelevant ? "- Parser/scanner/state-machine changes follow repo grammar evidence. Name states/transitions; test adjacency, delimiter transitions, suffix/metadata preservation, termination, escaping/quoting, and EOF/error behavior. Protected spans such as quoted strings/comments are boundary states: when the prompt says the delimited segment is a separate token/entity, adjacency before and after non-whitespace must be tested as separation, not merged into neighbors, unless repo evidence explicitly says otherwise. Permanent repo tests must cover changed transitions; ad-hoc temp tests are not a substitute." : undefined,
    mutationRelevant && normalizationContractRelevant ? "- Sorting/normalization contracts: when preserving original case/content, sort/order trimmed originals with the language's normal lexicographic/ordinal comparison unless case-insensitive, natural, locale, or custom ordering is requested/evidenced. Do not lowercase/casefold a preserved value only for determinism. Tests separate mixed-case ordering, retention, duplicates, empty filtering, and reorder determinism." : undefined,
    mutationRelevant ? "- Public API contract comments: when editing/adding a public/exported function, preserve docs and add a concise contract doc comment when local style supports it, especially for serialization, normalization, validation, or cross-module APIs." : undefined,
    mutationRelevant ? "- Prefer low-allocation ownership/resources; avoid leaks, globals, unsafe casts, warning suppression, arbitrary fixed caps, or resource escape hatches unless evidence requires them." : undefined,
    mutationRelevant ? "- Bounded impl/test: small evidence, one impl/test edit when possible, avoid micro-edits, verify once after, one corrective edit/fail." : undefined,
    mutationRelevant ? "- Verify with exact named command else nearest. If edit fails, reread and patch smallest exact block. After pass, one readback, then final immediately; no more shell/tests or open-ended thinking unless edited again. Fix scope/warnings and rerun." : undefined,
    mutationRelevant ? "- Modified files: `## Handoff` includes `Changed:`, `Verification:`, `Notes:`, exact paths, readback, exact implementation and test/evidence source paths. Never write only local/existing tests, binaries, or commands." : "- Handoff cites exact evidence paths, unresolved uncertainty, and avoids raw logs or unsupported claims.",
    implementationReviewRelevant ? "- Implementation review gate: independently compare the actual changed files against the Original User Goal, the planner contract, and the worker's claims. A worker deviation from a locked plan is a finding even when visible tests pass. Passing visible tests prove only observed behavior; flag untested or invented semantics that could fail hidden/broader cases." : undefined,
    implementationReviewRelevant ? "- Review economy: start from the handoff; re-read only changed/high-risk files needed for verdict. If duplicate-read policy blocks evidence, mark sampled/not rechecked." : undefined,
    implementationReviewRelevant ? "- Review lossy normalization/coercion carefully. If the task says preserve case/content/format/order, lowercased helper keys, casefolding, broad casts, or lossy conversions are defects unless explicitly requested or evidenced. For sorted preserved values, prefer the language's normal lexicographic/ordinal sort and require a mixed-case ordering test." : undefined,
    implementationReviewRelevant ? "- Reviewer handoff says PASS only after checking changed file contents plus the verification command. If you find bugs, insufficient requested-criteria coverage, verification blind spots, skipped plan items, or code-standard concerns, start with Verdict: FAIL/GAP and exact evidence. Do not downgrade missing permanent tests for user-requested behavior to low severity just because ad-hoc temp checks passed." : undefined,
    !mutationRelevant ? "- For project analysis, cite full relative paths from the repo root, not only basenames, and preserve exact runnable commands discovered in README, package manifests, Makefiles, CI, or test files; do not replace them with generic labels like tests exist." : undefined,
    !mutationRelevant ? "- When package scripts are present, report them as runnable invocations using the detected package manager, such as `bun run test`, `npm run build`, or `pnpm test`." : undefined,
    `- Treat ${maxTools} tool calls as the soft planning budget. Continue only when the next tool has clear expected value; stop with partial findings plus uncertainty once marginal value drops.`,
    "- Hard budget stop: checkpoint partial handoff, uncertainty, next split/continue. Soft warning: finish the current evidence thread and stop cleanly.",
    agent && hasAnyCapability(agent, ["coordinate"])
      ? "- Nested delegation is rare. Use `chalin_delegate` only when current evidence proves the task became too ambiguous, long, or multi-surface to finish alone. Keep the child plan tiny, pass exact evidence/ownership/success criteria, and stop at the two-level subagent depth limit."
      : undefined,
    options.rootTask?.trim() ? "- The Original User Goal below is the contract. Step tasks and handoffs may be partial; preserve the user's exact failure trigger, constraints, requested output fields, and no-code/no-mutation boundaries over any narrower subtask wording." : undefined,
    "- No web unless this role needs fresh external context.",
    deepProjectAnalysis
      ? "- Output budget for deep analysis: `## Findings` max 10 evidence-backed bullets, `## Handoff` max 14 bullets or 2600 characters, `## Memory Candidates` max 3 bullets. Accuracy beats brevity; do not pad."
      : "- Output budget: `## Findings` max 5 bullets, `## Handoff` max 8 bullets or 1200 characters, `## Memory Candidates` max 3 bullets.",
    "- Use chalin_artifact_write only for long-running feature-state, checkpoints, validation contracts, or reusable worker skills.",
    memoryPolicyForAgent(agent),
    "- Do not paste raw command output or long code snippets; cite paths and line evidence when useful.",
    deepProjectAnalysis ? deepProjectAnalysisContract() : undefined,
    handoffGapMode ? handoffGapReadContract(options, agent) : undefined,
    "",
    "## Stop conditions",
    stopConditionsForAgent(agent, deepProjectAnalysis),
    "",
    previous ? "## Previous Handoff" : undefined,
    previous || undefined,
    previous ? "" : undefined,
    formatStructuredClaimAudit(options.previousClaims ?? []),
    options.previousClaims?.length ? "" : undefined,
    options.rootTask?.trim() ? "## Original User Goal" : undefined,
    options.rootTask?.trim() || undefined,
    options.rootTask?.trim() ? "" : undefined,
    previous && options.priorFilesRead?.length ? "## Already Covered Evidence Paths" : undefined,
    previous && options.priorFilesRead?.length ? formatPriorFilesRead(options.priorFilesRead) : undefined,
    previous && options.priorFilesRead?.length ? "" : undefined,
    options.memoryContext ? "## Compact Memory Context" : undefined,
    options.memoryContext || undefined,
    options.memoryContext ? "" : undefined,
    "## Task",
    task,
    "",
    "## Cached Project Discovery Index",
    previous ? "Discovery index omitted because Previous Handoff is available. Call chalin_project_discovery only if the handoff lacks required repo facts." : discoveryIndex,
    "",
    "Return a concise result with these sections when useful:",
    "## Findings",
    deepProjectAnalysis
      ? "- Evidence-backed discoveries that the orchestrator should show the user. Include claim + evidence; do not merge unsupported guesses."
      : "- Evidence-backed discoveries that the orchestrator should show the user. Max 5 bullets.",
    "## Handoff",
    deepProjectAnalysis
      ? "- Preserve the Coverage Matrix, Evidence Table, Unknowns/Gaps, and final synthesis material. Do not drop domain-critical subsystems."
      : "- A compact summary for the next agent or the orchestrator. Max 8 bullets or 1200 characters.",
    "## Memory Candidates",
    "- Only durable, human-readable project knowledge for future work. Max 3 bullets.",
    "- Prefer categories like `project-fact:`, `pattern:`, `tooling:`, `testing:`, `workflow:`, `bugfix:`, `decision:`, or `preference:`.",
    "- Avoid commands, logs, code snippets, raw stdout/stderr, stack traces, task completion notes, or obvious facts.",
    "- Write `- None.` when there is nothing worth remembering.",
    claimLedgerOutputContract(agent),
  ].filter(Boolean).join("\n");
}

function implementationReviewText(text: string): boolean {
  return /\b(implement|implementation|changed|worker|verification|tests?|edit|mutation|mutaci[oó]n|fix|bugfix|refactor|feature|scaffold|code|c[oó]digo|build|update|actualiza|modifica)\b/i.test(text);
}

function claimLedgerOutputContract(agent: AgentDefinition | undefined): string | undefined {
  if (!agent || agent.concern === "implementation" || agent.concern === "conflict-resolution") return undefined;
  return "## Claim Ledger\n- Optional JSON for auditable claims: `{kind,subject,summary,evidence,evidenceKind,confidence}`; kinds include `transient-status`, `negative-claim`, `unknown`, `contradiction`.";
}

export function childToolNames(agent: AgentDefinition | undefined, task = "", needsArtifacts = false, hasPrevious = false, options: ChildToolOptions = {}): string[] {
  const deepHandoff = options.budgetProfile === "deep" || options.budgetProfile === "extended" || options.routeKind === "multi-agent-dag";
  if (hasPrevious && shouldUseHandoffOnlyMode(agent, deepHandoff, task, Boolean(options.previousClaimsNeedAudit))) return [];
  if (!agent?.capabilities.length) {
    const fallback = new Set(agent?.tools.length ? agent.tools : ["read", "grep", "find", "ls"]);
    fallback.add("chalin_project_discovery");
    return [...fallback];
  }
  const names = new Set<string>();
  if (hasAnyCapability(agent, ["inspect-files"])) {
    names.add("read");
    names.add("ls");
  }
  if (hasAnyCapability(agent, ["search-files"])) {
    names.add("grep");
    names.add("find");
  }
  if (hasAnyCapability(agent, ["run-safe-bash", "validate"]) && taskNeedsBash(agent)) names.add("bash");
  if (hasAnyCapability(agent, ["edit-files"])) names.add("edit");
  if (hasAnyCapability(agent, ["write-new-files"])) names.add("write");
  if (hasAnyCapability(agent, ["external-context"]) && taskNeedsExternalContext(agent)) names.add("chalin_web_search");
  if (hasAnyCapability(agent, ["inspect-files", "validate"]) && taskNeedsSkillInspection(task)) names.add("chalin_skill");
  if (shouldExposeArtifactWrite(agent, needsArtifacts, options)) names.add("chalin_artifact_write");
  const memoryEnabled = options.memoryEnabled ?? true;
  if (memoryEnabled && agent?.memory.read !== false && hasAnyCapability(agent, ["memory-read"])) names.add("chalin_memory_search");
  if (memoryEnabled && agent?.memory.write !== "never" && hasAnyCapability(agent, ["memory-write"])) {
    names.add("chalin_memory_write");
    names.add("chalin_memory_revise");
  }
  const delegationDepth = options.delegationDepth ?? 1;
  const maxDelegationDepth = options.maxDelegationDepth ?? 2;
  if (hasAnyCapability(agent, ["coordinate"]) && delegationDepth < maxDelegationDepth && !hasPrevious) {
    names.add("chalin_delegate");
  }
  names.add("chalin_project_discovery");
  if (agent.concern === "recon") names.add("chalin_project_snapshot");
  return [...names];
}

function taskNeedsSkillInspection(task: string): boolean {
  return /\b(SKILL\.md|skill governance|skill audit|promote skill|untrusted skill|generated skill|reusable procedure)\b/i.test(task);
}

function shouldExposeArtifactWrite(agent: AgentDefinition, needsArtifacts: boolean, options: ChildToolOptions): boolean {
  if (!needsArtifacts) return false;
  if (!hasAnyCapability(agent, ["memory-write", "coordinate", "validate", "edit-files"])) return false;
  if (options.budgetProfile === "deep" || options.budgetProfile === "extended") return true;
  if (options.routeKind === "multi-agent-dag") return true;
  return false;
}

export function toolBudgetForStep(agent: AgentDefinition | undefined, step: Pick<RunStepState, "agent" | "task" | "budget">, routeKind: RouteKind = "single-agent"): number {
  const env = Number(process.env.PI_CHALIN_CHILD_TOOL_BUDGET);
  if (Number.isFinite(env) && env > 0) return Math.floor(env);
  return policyForStep(agent, step, routeKind).caps.maxToolCalls;
}

export function resolveStepCompletionStatus(step: Pick<RunStepState, "metrics" | "output" | "error">): RunStepState["status"] {
  if (step.error) return "failed";
  if (!step.metrics?.budgetStopCount) return "complete";
  if (hasUsableHandoff(step)) return "complete";
  return "checkpointed";
}

export function isHandoffGapReadMode(agent: AgentDefinition | undefined, previous?: string, deepProjectAnalysis = false): boolean {
  return isSynthesisGapReadMode(agent, previous, deepProjectAnalysis) || isReviewGapReadMode(agent, previous);
}

export function synthesisToolCallLimit(): number {
  const parsed = Number(process.env.PI_CHALIN_SYNTHESIS_TOOL_LIMIT);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 35;
}

export function handoffReviewToolCallLimit(): number {
  const parsed = Number(process.env.PI_CHALIN_REVIEW_TOOL_LIMIT);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 12;
}

export function synthesisGapReadLimit(): number {
  const parsed = Number(process.env.PI_CHALIN_SYNTHESIS_GAP_READ_LIMIT);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 12;
}

export function synthesisCrossStepDuplicateReadLimit(agent?: AgentDefinition): number {
  const parsed = Number(process.env.PI_CHALIN_SYNTHESIS_CROSS_READ_LIMIT);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : agent?.concern === "review" ? 1 : 3;
}

function compactAgentInstructions(agent: AgentDefinition | undefined): string | undefined {
  if (!agent) return undefined;
  const rules = extractAgentSection(agent.systemPrompt, "Rules", "Tool discipline")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("-"))
    .slice(0, 4);
  return [
    `You are pi-chalin ${agent.name}: ${agent.description}`,
    rules.length ? "Role rules:" : undefined,
    ...rules,
  ].filter(Boolean).join("\n");
}

function memoryPolicyForAgent(agent: AgentDefinition | undefined): string | undefined {
  if (!agent || (!agent.memory.read && agent.memory.write === "never")) return undefined;
  return [
    "## pi-chalin autonomous memory policy",
    agent.memory.read
      ? "- You may use `chalin_memory_search` autonomously when prior decisions/facts/workflows/preferences can reduce exploration or repeated mistakes."
      : undefined,
    agent.memory.write !== "never"
      ? "- Use `chalin_memory_write` for compact durable knowledge and `chalin_memory_revise` when evidence proves memory stale/wrong. WriteGuard decides active/pending/rejected."
      : undefined,
    "- Keep memory token spend low: short queries, evidence only for review/contradiction, never logs/output/code dumps/trivial notes.",
    "- No memory candidates for transient pass/fail/current-status claims from tests, builds, evals, CI, dry-runs, partial logs, previews, or unexecuted commands. Record stable commands/conventions instead.",
    "- Memory is guidance, not proof; current repo evidence and explicit user instructions win.",
  ].filter(Boolean).join("\n");
}

function evidenceClaimDiscipline(): string {
  return [
    "- Evidence-grade claims: Dry-runs, inventory commands, grep counts, and partial logs are not live verification; report them as inventory or partial evidence, never as current pass/fail status.",
    "- Before saying a feature, API, file, route, command, dependency, or pattern is absent, perform a targeted local search/read or label it unknown/gap. Negative claims require evidence just like positive claims.",
    "- Reconcile contradictions between handoffs before synthesis. If evidence conflicts, say what is unresolved and what check would settle it; do not concatenate raw upstream output as if all claims were simultaneously true.",
    "- Do not write memory candidates for transient pass/fail/current-status claims. Durable memory may describe stable commands, conventions, or workflow rules.",
  ].join("\n");
}

function extractAgentSection(text: string, start: string, end: string): string {
  const pattern = new RegExp(`${RegExp.escape(start)}:\\s*([\\s\\S]*?)(?:\\n\\s*${RegExp.escape(end)}:|$)`, "i");
  return pattern.exec(text)?.[1]?.trim() ?? "";
}

function shouldUseHandoffOnlyMode(agent: AgentDefinition | undefined, deepHandoff: boolean, task = "", previousClaimsNeedAudit = false): boolean {
  if (!agent || deepHandoff) return false;
  if (previousClaimsNeedAudit) return false;
  if (taskNeedsCriticalHandoffAudit(task)) return false;
  return agent.concern === "context-building";
}

function formatStructuredClaimAudit(claims: EvidenceClaim[]): string | undefined {
  if (claims.length === 0) return undefined;
  const lines = claims.slice(0, 12).map((claim) => {
    const evidence = claim.evidence.length > 0 ? `evidence=${claim.evidence.slice(0, 4).join(", ")}` : "evidence=missing";
    const evidenceKind = claim.evidenceKind ? ` evidenceKind=${claim.evidenceKind}` : "";
    return `- ${claim.kind} · ${claim.subject} · confidence=${claim.confidence}${evidenceKind} · ${evidence} · ${claim.summary}`;
  });
  return [
    "## Structured claim audit",
    "- Previous agents marked these claims as needing audit or careful synthesis. Prefer this metadata over wording heuristics.",
    "- Recheck only claims that affect the final answer; if you cannot recheck, preserve the uncertainty explicitly.",
    ...lines,
  ].join("\n");
}

function taskNeedsCriticalHandoffAudit(task: string): boolean {
  return /\b(contradict|contradicci[oó]n|conflict|conflicto|critical claim|claim check|fact[- ]?check|reconcile|reconciliar|no existe|not present|absent|missing evidence|unknown|gap|unresolved)\b/i.test(task);
}

function taskNeedsExternalContext(agent: AgentDefinition): boolean {
  if (agent.concern === "research") return true;
  return false;
}

function taskNeedsBash(agent: AgentDefinition): boolean {
  if (agent.concern === "implementation") return true;
  if (agent.capabilities.includes("run-safe-bash")) return true;
  return agent.capabilities.includes("validate");
}

function toolBudgetForAgent(agent: AgentDefinition | undefined, fallbackName?: string): number {
  const env = Number(process.env.PI_CHALIN_CHILD_TOOL_BUDGET);
  if (Number.isFinite(env) && env > 0) return Math.floor(env);
  return baseToolBudget(agent, fallbackName);
}

function hasUsableHandoff(step: Pick<RunStepState, "output" | "error">): boolean {
  const text = [step.output?.handoff, step.output?.text].filter(Boolean).join("\n").trim();
  if (text.length < 80) return false;
  if (isPlaceholderHandoff(text)) return false;
  return hasMarkdownSection(text, "Handoff") || hasMarkdownSection(text, "Findings") || countBullets(text) >= 2 || text.includes("/");
}

function isPlaceholderHandoff(text: string): boolean {
  const normalized = text.trim().toLowerCase();
  const withoutTerminalPeriod = normalized.endsWith(".") ? normalized.slice(0, -1) : normalized;
  return ["done", "complete", "ok", "no output"].includes(withoutTerminalPeriod);
}

function hasMarkdownSection(text: string, title: string): boolean {
  const heading = `## ${title.toLowerCase()}`;
  return text
    .split("\n")
    .some((line) => line.trim().toLowerCase() === heading);
}

function countBullets(text: string): number {
  return text
    .split("\n")
    .filter((line) => {
      const trimmed = line.trimStart();
      return trimmed.startsWith("- ") || trimmed.startsWith("* ");
    })
    .length;
}

function baseToolBudget(agent: AgentDefinition | undefined, fallbackName?: string): number {
  if (agent?.concern === "recon") return 40;
  if (agent?.concern === "context-building") return 60;
  if (agent?.concern === "planning") return 25;
  if (agent?.concern === "review") return 50;
  if (agent?.concern === "implementation") return 80;
  if (agent?.concern === "research") return 60;
  if (agent?.concern === "decision-consistency") return 8;
  if (agent?.concern === "conflict-resolution") return 16;
  if (fallbackName === "scout") return 40;
  if (fallbackName === "context-builder") return 60;
  if (fallbackName === "planner") return 25;
  if (fallbackName === "reviewer") return 50;
  if (fallbackName === "worker") return 80;
  return 40;
}

function stopConditionsForAgent(agent: AgentDefinition | undefined, deepProjectAnalysis = false): string {
  if (deepProjectAnalysis && agent?.concern === "recon") {
    return "- Stop after producing a coverage map across top-level functional areas: entrypoints, commands/tools/routes, storage/sync, integrations, UI/cloud surfaces, tests/evals/tooling, and explicit unknowns. Coverage means representative evidence per surface, not every adjacent file.";
  }
  if (deepProjectAnalysis && (agent?.concern === "context-building" || agent?.concern === "review")) {
    return "- Stop only after the Coverage Matrix marks each critical surface as covered with evidence, not present with evidence, or unknown/gap.";
  }
  if (agent?.concern === "recon") return "- Stop once raw inventory, changed files, exact evidence paths, and explicit unknowns are enough for the next agent to reason without guessing.";
  if (agent?.concern === "context-building") return "- Stop once the next agent has enough facts, constraints, relevant paths, and uncertainties to act without re-scanning.";
  if (agent?.concern === "planning") return "- Stop once the plan has ordered phases, likely files, validation, risks, and rollback notes; do not inspect implementation details deeply.";
  if (agent?.concern === "review") return "- Stop after the top 3-5 evidence-backed risks/findings; do not keep searching for marginal issues.";
  if (agent?.concern === "implementation") return "- Stop after the scoped change and nearest validation are complete; do not broaden scope or rewrite unrelated code.";
  if (agent?.concern === "research") return "- Stop after current sourced context is enough; do not browse or fetch beyond the task scope.";
  return "- Stop when the bounded task can be answered with evidence and remaining uncertainty is explicit.";
}

function deepProjectAnalysisContract(): string {
  return [
    "",
    "## Deep project analysis accuracy contract",
    "- Optimize for accuracy, not length. A short answer that misses core subsystems is wrong; a long answer without evidence is also wrong.",
    "- Surface coverage is architectural coverage. Use discovery, manifests, docs, entrypoints, representative modules, tests, and targeted search to cover the shape of the system without crawling same-purpose files.",
    "- Produce a Coverage Matrix before synthesis. Required surfaces: runtime/entrypoints; commands/tools/routes; data/storage/sync; local project detection; external integrations/MCP/tools; HTTP/API routes; UI/dashboard/cloud surfaces; memory/conflict/governance; tests/evals/tooling; known gaps.",
    "- Mark every Coverage Matrix item as one of: covered with evidence, not present with evidence, or unknown/gap. Do not pretend an unknown is absent.",
    "- Produce an Evidence Table using claim + evidence + confidence + gap. Evidence should include file paths and symbol/function/route/config keys when available.",
    "- For memory/agent/orchestration projects, explicitly check: local/project detection, memory persistence and sync, MCP/tool surface, HTTP/API surface, conflict detection/surfacing, external integrations, UI/dashboard/cloud, and test/eval status.",
    "- For command/tool/route surfaces, include representative exact commands, endpoints, and tool names (for example `engram mcp`, `/observations`, or `mem_save`) instead of generic labels only.",
    "- For local-first persistence/sync, state what is the source of truth and name concrete sync artifacts such as manifests/chunks when present.",
    "- Do not merge a claim into final synthesis unless it has evidence or is explicitly labeled as inference.",
    "- Final synthesis must preserve domain-critical subsystems discovered in docs, routes, tools, tests, or config.",
  ].join("\n");
}

function isSynthesisGapReadMode(agent: AgentDefinition | undefined, previous?: string, deepProjectAnalysis = false): boolean {
  if (!previous?.trim()) return false;
  if (agent?.concern !== "context-building") return false;
  return deepProjectAnalysis;
}

function isReviewGapReadMode(agent: AgentDefinition | undefined, previous?: string): boolean {
  if (!previous?.trim()) return false;
  if (agent?.concern !== "review") return false;
  return true;
}

function handoffGapReadContract(options: SdkPromptOptions, agent: AgentDefinition | undefined): string {
  const gapReadLimit = options.synthesisGapReadLimit ?? synthesisGapReadLimit();
  const reviewMode = agent?.concern === "review";
  return [
    "",
    reviewMode ? "## Handoff-first review / sampled-audit contract" : "## Handoff-first synthesis / gap-read contract",
    reviewMode
      ? "- Treat `Previous Handoff` as the primary evidence map. Your job is targeted quality audit, not a second repository crawl."
      : "- Treat `Previous Handoff` as the primary evidence map. Your job is synthesis, not a second repository crawl.",
    `- You may do at most ${gapReadLimit} gap reads/searches when the handoff has a concrete unknown, contradiction, or missing evidence needed for the final answer.`,
    reviewMode ? "- For review, sample only the highest-risk or least-supported claims. If a safety/correctness verdict depends on exact code, re-read the exact covered file or region once; otherwise prefer grep/find for exact symbols/config keys and avoid full reads of already-covered files." : undefined,
    "- Do not reread files listed in `Already Covered Evidence Paths` unless you name the specific missing symbol/line/claim you are verifying.",
    "- If a read is blocked by the cross-step duplicate-read policy, do not retry variants of the same evidence path; use the handoff evidence and mark the claim as sampled/not rechecked.",
    "- Prefer citing evidence already present in the handoff. Use new reads only to close explicit gaps, then stop.",
    "- If coverage is incomplete, say exactly what remains unknown instead of expanding into a broad crawl.",
    "- Reconcile contradictions before final handoff and do not concatenate raw upstream output; produce final answer material plus a compact handoff, not a second exploration log.",
  ].filter((line): line is string => Boolean(line)).join("\n");
}

function formatPriorFilesRead(files: string[]): string {
  const unique = [...new Set(files)].slice(0, 40);
  const extra = files.length > unique.length ? `\n- …${files.length - unique.length} more` : "";
  return `${unique.map((file) => `- ${file}`).join("\n")}${extra}`;
}

function hasAnyCapability(agent: AgentDefinition, capabilities: AgentCapability[]): boolean {
  return capabilities.some((capability) => agent.capabilities.includes(capability));
}
