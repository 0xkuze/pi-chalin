import type { AgentCapability, AgentDefinition, EvidenceClaim, ResolvedSkill, RouteExpectedEffect, RouteKind, RouteWorkUnitStrategy, ToolBudgetProfile } from "../domain/schemas.ts";
import { policyForStep } from "../budget/budget.ts";
import { buildProjectDiscoveryIndex, formatProjectDiscoveryIndex } from "../project/discovery.ts";
import type { RunStepState } from "../domain/schemas.ts";
import { formatActiveSkillsForPrompt } from "../skills/skills.ts";

export interface SdkPromptOptions {
  rootTask?: string;
  priorFilesRead?: string[];
  synthesisGapReadLimit?: number;
  memoryContext?: string;
  contextPacket?: string;
  previousClaims?: EvidenceClaim[];
  activeSkills?: ResolvedSkill[];
  suggestedSkills?: ResolvedSkill[];
  rejectedSkills?: Array<{ skill: { qualifiedName: string }; reason: string }>;
  workUnitStrategy?: RouteWorkUnitStrategy;
  expectedEffects?: RouteExpectedEffect[];
  fanoutAuthorized?: boolean;
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
  const capabilities = agent?.capabilities ?? [];
  const mutationRelevant = Boolean(agent && (
    agent.concern === "implementation"
    || agent.concern === "conflict-resolution"
    || capabilities.includes("edit-files")
    || capabilities.includes("write-new-files")
  ));
  const implementationReviewRelevant = agent?.concern === "review";
  const goalAwareScoutingRelevant = agent?.concern === "recon" && Boolean(options.rootTask?.trim());
  const expectedEffects = new Set(options.expectedEffects ?? []);
  const writeExpected = expectedEffects.has("write");
  const verifyExpected = expectedEffects.has("verify");
  const writeDiscoveryAuthorityRelevant = options.workUnitStrategy === "discover" && writeExpected;
  const fanoutAuthorized = options.fanoutAuthorized === true;
  const budgetPolicy = typeof budget === "number"
    ? policyForStep(agent, { agent: agent?.name ?? "agent", task, budget: budgetProfile }, "multi-agent-sequential")
    : budget;
  const maxTools = typeof budget === "number" ? budget : budget.caps.maxToolCalls;
  const profile = typeof budget === "number" ? budgetProfile : budget.profile;
  const discoveryIndex = previous
    ? "Discovery index omitted because Previous Handoff is available. Call chalin_project_discovery only if the handoff lacks required repo facts."
    : formatProjectDiscoveryIndex(buildProjectDiscoveryIndex(cwd, { maxEntries: 220 }), { maxEntries: promptDiscoveryEntryLimit(profile) });
  const deepProjectAnalysis = profile === "deep";
  const handoffGapMode = isHandoffGapReadMode(agent, previous, deepProjectAnalysis);
  const structuredHandoffRequired = requiresStructuredAgentHandoff(agent);
  return [
    compactAgentInstructions(agent),
    "",
    "## pi-chalin concern/capability policy",
    `- Concern: ${agent?.concern ?? "delegation"}.`,
    `- Capabilities: ${capabilities.join(", ") || "inspect-files, search-files"}.`,
    "- Tools follow capabilities; do not assume another agent's tools.",
    "",
    "## pi-chalin child tool policy",
    "- Inspect read/find/grep/ls/read-only git. Use `edit` for existing files, including full-content replacements; `write` only after evidence path is new; scratch in cwd. No git mutate: checkout/restore/switch/reset/add/commit/clean or mutating branch; rollback = in-scope edit or scope gap.",
    "- Use repo-relative tool paths; for cwd omit `path` or use `.`. Do not pass absolute cwd.",
    "- Discovery/snapshot: inventory/git history only; not run mutations. Read exact evidence before claims.",
    "- Bash is role-scoped full shell; use purposeful commands.",
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
    goalAwareScoutingRelevant
      ? "- Goal-aware scouting: map the source, tests, fixtures, config, docs, and verification evidence needed for the Original User Goal. Do not declare coverage sufficient without direct evidence for each requested criterion; hand off concrete gaps."
      : undefined,
    "- Prefer concise evidence; stop after high-value actionable issues.",
    options.workUnitStrategy && options.workUnitStrategy !== "none"
      ? `- WorkUnit strategy: ${options.workUnitStrategy}. Use bounded units when scope exceeds one reliable ownership boundary. Parallel units need independent ownership; shared mutable surfaces require merge or order.`
      : undefined,
    mutationRelevant || agent?.concern === "planning" || writeDiscoveryAuthorityRelevant
      ? fanoutAuthorized && writeDiscoveryAuthorityRelevant
        ? "- Human-input: fanout is already authorized for discovered independent targets. If at least two safe WorkUnits can proceed with bounded scope and verification, keep requiresHumanInput=false, emit those workUnits, and record blocked/omitted surfaces as risks/nextActions. Set requiresHumanInput=true, workUnits=[] only when no safe authorized unit can proceed or the user's required outcome depends on a human decision."
        : "- Human-input: if scope/API/security/arch/ownership or multi-target write lacks authority, requiresHumanInput=true, workUnits=[]."
      : undefined,
    !mutationRelevant && !writeDiscoveryAuthorityRelevant ? "- Read-only uncertainty: report evidenced unknowns/risks; do not set requiresHumanInput for exploitability/product-context questions." : undefined,
    evidenceClaimDiscipline(),
    "- Preserve failure triggers/counterexamples before adjacent findings.",
    mutationRelevant ? "- Impl/test: derive the contract from prompt+repo evidence. Tests are contract oracles: preserve existing assertions unless disproven; add focused criteria plus one meaningful boundary/counterexample. Preserve public compatibility unless evidence requires otherwise. Invalid/reject requirements are contract." : undefined,
    mutationRelevant ? "- Domain contracts: use active Skills or repo grammar/tests/docs/API evidence. If behavior/API is missing, stop with evidence and next human decision; do not invent." : undefined,
    mutationRelevant && previous?.trim() ? "- Upstream handoffs are context, not authority. Before skipping tests/docs, compare Original User Goal criteria against repo evidence." : undefined,
    mutationRelevant ? "- Code behavior changes update nearest tests unless existing assertions cover every criterion; final distinguishes edited tests from evidence-only tests. Test files register runner-discoverable cases; zero-test assertion scripts are invalid. A narrower step task cannot forbid tests unless the Original User Goal explicitly forbids test edits." : undefined,
    mutationRelevant ? "- Required invariants: if evidence shows an Original User Goal guarantee is unmet, fix it or report a blocking gap; never weaken tests or call unmet required behavior residual risk." : undefined,
    mutationRelevant && writeExpected ? "- Dependency/tooling installs are workspace mutations. Do not install or remove dependencies unless the current WorkUnit scope explicitly includes the package manifest and lockfile; otherwise report the missing scope/dependency and stop." : undefined,
    mutationRelevant ? "- Coverage breadth: multiple requested rules get separate compact tests per rule plus one composition/determinism case; do not collapse several requirements into one smoke test." : undefined,
    mutationRelevant && verifyExpected ? "- Verification setup hygiene: Clean transient outputs before handoff; list intentional generated files, dependency manifests, lockfiles, and checksum artifacts in changedFiles with rationale and verification." : undefined,
    mutationRelevant ? "- Public API contract comments: preserve exported docs; comment only cross-module/I/O/compat behavior." : undefined,
    mutationRelevant ? "- Prefer resource ownership; avoid leaks, globals, unsafe casts, warning suppression, arbitrary fixed caps, resource escape hatches unless evidenced." : undefined,
    mutationRelevant ? "- Bounded impl/test: small evidence, one impl/test edit when possible, avoid micro-edits, verify once after, one corrective edit/fail." : undefined,
    mutationRelevant ? "- Verify exact named command else nearest. If edit fails, reread and patch smallest exact block. After pass, one readback, then final; no more shell/tests unless edited again. Fix scope/warnings and rerun." : undefined,
    mutationRelevant && writeExpected ? "- Runtime write contract: `## Agent Handoff.changedFiles` lists every path personally edited; empty changedFiles fails writer steps." : undefined,
    mutationRelevant && verifyExpected ? "- Runtime verification contract: `## Agent Handoff.verification` lists exact command/readback/result evidence or concrete blocked reason; empty verification fails verification-responsible steps." : undefined,
    mutationRelevant ? "- Modified files: `## Handoff` includes `Changed:`, `Verification:`, `Notes:`, exact paths, readback, exact implementation and test/evidence source paths. Never write only local/existing tests, binaries, or commands." : "- Handoff cites exact evidence paths, unresolved uncertainty, and avoids raw logs or unsupported claims.",
    implementationReviewRelevant ? "- Implementation review gate: independently compare the actual run changed files against the Original User Goal, planner contract, and worker claims. Treat worker handoff and runner mutation evidence as the source for this run's changed files; git history, snapshot changed files, or ad hoc ranges like HEAD~1 are only historical context unless the runner gives that baseline. A worker deviation from a locked plan is a finding even when visible tests pass. Passing visible tests prove only observed behavior; flag untested or invented semantics that could fail hidden/broader cases." : undefined,
    implementationReviewRelevant ? "- Review economy: start from the handoff; re-read only changed/high-risk files needed for verdict. If duplicate-read policy blocks evidence, mark sampled/not rechecked." : undefined,
    implementationReviewRelevant ? "- Review contract-preserving transformations carefully. If the task says preserve specific content, format, order, or public behavior, broad casts, coercions, or lossy conversions are defects unless explicitly requested or evidenced." : undefined,
    implementationReviewRelevant ? "- Reviewer verdict is structured, not prose-parsed. Emit `## Reviewer Verdict` as JSON with verdict, blockingFindings, missingCoverage, evidence, residualRisks, and requiredRepair. For pass, blockingFindings, missingCoverage, and requiredRepair MUST be empty. Evidence items are structured records: {kind:\"reviewed-content\", paths:[...], summary:\"...\"} for reviewed files/content and, when verification is expected, {kind:\"verification\", command:\"...\", status:\"pass|fail|unknown\", result:\"...\"}. Use fail/gap for blocking bugs, missing requested criteria, verification blind spots, skipped scope, or insufficient permanent tests. Residual risks are optional/future-hardening only; unmet Original User Goal guarantees are blockingFindings or missingCoverage." : undefined,
    implementationReviewRelevant ? "- Review unavailable optional verification carefully: block only when the Original User Goal, planner acceptance criteria, or discovered repo commands require it. Otherwise put the non-blocking concern in residualRisks without inventing required repair." : undefined,
    implementationReviewRelevant && verifyExpected ? "- Runtime review contract: `## Agent Handoff.verification` cites verification evidence reviewed or names missing verification as a blocking gap." : undefined,
    implementationReviewRelevant && verifyExpected ? "- Review-only/no-mutation still allows running existing repo verification commands; a user ban on temporary scripts/files is not a ban on safe existing commands. PASS requires at least one Reviewer Verdict evidence record {kind:\"verification\", command:\"...\", status:\"pass\", result:\"observed output\"}. If you only inspected config or skipped required verification, use verdict:\"gap\" with missingCoverage/requiredRepair instead of PASS." : undefined,
    !mutationRelevant ? "- For project analysis, cite full relative paths from the repo root, not only basenames, and preserve exact runnable commands discovered in README, package manifests, Makefiles, CI, or test files; do not replace them with generic labels like tests exist." : undefined,
    !mutationRelevant ? "- When package scripts are present, report them as runnable invocations using the detected package manager, such as `pnpm test`, `npm run build`, or `yarn test`." : undefined,
    `- Treat ${maxTools} tool calls as the soft planning budget. Continue only when the next tool has clear expected value; stop with partial findings plus uncertainty once marginal value drops.`,
    "- Hard budget stop: checkpoint partial handoff, uncertainty, next split/continue. Soft warning: finish the current evidence thread and stop cleanly.",
    agent && hasAnyCapability(agent, ["coordinate"])
      ? "- Nested delegation is rare but required when evidence proves scope exceeds one worker's reliable ownership boundary. Split into worker-owned child units with evidence, dependencies for shared surfaces, success criteria, and fan-in review; stop at the two-level subagent depth limit."
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
    options.contextPacket ? "## Context Packet" : undefined,
    options.contextPacket || undefined,
    options.contextPacket ? "" : undefined,
    options.memoryContext ? "## Compact Memory Context" : undefined,
    options.memoryContext || undefined,
    options.memoryContext ? "" : undefined,
    "## Task",
    task,
    "",
    "## Cached Project Discovery Index",
    discoveryIndex,
    "",
    structuredHandoffRequired
      ? "Return concise sections. `## Agent Handoff` is a REQUIRED runtime contract:"
      : "Return a concise result with these sections when useful:",
    "## Findings",
    deepProjectAnalysis
      ? "- Evidence-backed discoveries that the orchestrator should show the user. Include claim + evidence; do not merge unsupported guesses."
      : "- Evidence-backed discoveries that the orchestrator should show the user. Max 5 bullets.",
    "## Handoff",
    deepProjectAnalysis
      ? "- Preserve the Coverage Matrix, Evidence Table, Unknowns/Gaps, and final synthesis material. Do not drop domain-critical subsystems."
      : "- A compact summary for the next agent or the orchestrator. Max 8 bullets or 1200 characters.",
    "## Agent Handoff",
    structuredHandoffRequired
      ? fanoutAuthorized && writeDiscoveryAuthorityRelevant
        ? "- JSON fields: summary, changedFiles, verification, evidenceClaims, risks, nextActions, requiresHumanInput, humanInputQuestions, workUnits. Writers fill changedFiles; verify steps fill verification. Full human block => requiresHumanInput=true, workUnits=[]. Partial blockers in authorized fanout => requiresHumanInput=false, safe workUnits=[...], blocked decisions in risks/nextActions."
        : "- JSON fields: summary, changedFiles, verification, evidenceClaims, risks, nextActions, requiresHumanInput, humanInputQuestions, workUnits. Writers fill changedFiles; verify steps fill verification; human block => requiresHumanInput=true, workUnits=[]."
      : "- JSON object: summary, changedFiles, verification, evidenceClaims, risks, nextActions, requiresHumanInput, humanInputQuestions, workUnits. Use [] for absent arrays.",
    options.workUnitStrategy === "discover" ? workUnitDiscoveryContract(writeExpected, fanoutAuthorized) : undefined,
    implementationReviewRelevant ? "## Reviewer Verdict" : undefined,
    implementationReviewRelevant ? "- REQUIRED JSON object for every reviewer, including read-only/config reviews: verdict, blockingFindings, missingCoverage, evidence, residualRisks, requiredRepair. Missing this section triggers evidence repair. PASS means blockingFindings=[], missingCoverage=[], requiredRepair=\"\"." : undefined,
    implementationReviewRelevant && verifyExpected ? "- Because this route expects verify, PASS evidence must include {kind:\"verification\", command:\"...\", status:\"pass\", result:\"observed output\"}; otherwise return GAP/FAIL, not PASS." : undefined,
    "## Memory Candidates",
    "- Only durable, human-readable project knowledge for future work. Max 3 bullets.",
    "- Prefer categories like `project-fact:`, `pattern:`, `tooling:`, `testing:`, `workflow:`, `bugfix:`, `decision:`, or `preference:`.",
    "- Avoid commands, logs, code snippets, raw stdout/stderr, stack traces, task completion notes, or obvious facts.",
    "- Write `- None.` when there is nothing worth remembering.",
    claimLedgerOutputContract(agent),
  ].filter(Boolean).join("\n");
}

function requiresStructuredAgentHandoff(agent: AgentDefinition | undefined): boolean {
  if (!agent) return false;
  if (agent.concern === "planning" || agent.concern === "context-building" || agent.concern === "review" || agent.concern === "decision-consistency" || agent.concern === "conflict-resolution") return true;
  return agent.concern === "implementation"
    || agent.capabilities.includes("edit-files")
    || agent.capabilities.includes("write-new-files")
    || agent.capabilities.includes("validate");
}

function promptDiscoveryEntryLimit(profile: ToolBudgetProfile): number {
  if (profile === "tight") return 90;
  if (profile === "deep" || profile === "extended") return 180;
  return 140;
}

function workUnitDiscoveryContract(writeExpected: boolean, fanoutAuthorized = false): string {
  return [
    "- Discovery contract: workUnits=[{id,title,scope:{files,purpose},dependencies,expectedEffects,acceptanceCriteria}] for bounded execution/review ownership only. expectedEffects is per unit, using read/write/verify; only units that must mutate the workspace should include write.",
    writeExpected && fanoutAuthorized ? "Authorized fanout: the user already authorized working discovered independent targets. Emit safe WorkUnits for bounded surfaces that can proceed; omit surfaces needing extra scope/API/security/arch/tooling decisions and report them as risks/nextActions instead of blocking the whole fanout." : undefined,
    writeExpected && !fanoutAuthorized ? "Discovered write units need user authority: if units are alternative owners for the same requested behavior and the user did not authorize all targets, set requiresHumanInput=true, humanInputQuestions=[...], workUnits=[] instead of fanout." : undefined,
    "scope.files is the only mutation authority for write units: include every expected source, test, docs, config, manifest, lock, generated, or verification-support file the unit may edit/create; do not write acceptance criteria that authorize files missing from scope.files. If needed files are uncertain, mark a scope gap instead of omitting them.",
    writeExpected ? "Do not invent new product/API/runtime behavior for inert placeholders or surfaces with no observable contract in code, tests, docs, config, routes, or caller evidence; omit them from runnable write WorkUnits or make them docs/read-only review only, and record the needed human decision in risks/nextActions." : undefined,
    "If a write unit may change an exported API/signature, include direct callers/update surfaces in scope.files or require compatibility in acceptanceCriteria.",
    "Use short stable ids and put only other unit ids or exact titles in dependencies; shared mutable surfaces require dependencies, not parallel-ready units.",
    "Mutation units need a credible verification path from discovered repo commands, direct readback, or an explicitly planned verification artifact; if setup/tooling commands may update repo files, include those versioned mutation surfaces in scope.files, split setup into a dependency unit, or report a scope gap before launching workers.",
    "Do not list dependency cache/install directories as deliverables unless the repo already versions them.",
  ].filter(Boolean).join(" ");
}

function claimLedgerOutputContract(agent: AgentDefinition | undefined): string | undefined {
  if (!agent || agent.concern === "implementation" || agent.concern === "conflict-resolution") return undefined;
  return "## Claim Ledger\n- Optional JSON for auditable claims: `{kind,subject,summary,evidence,evidenceKind,confidence}`; kinds include `transient-status`, `negative-claim`, `unknown`, `contradiction`.";
}

export function childToolNames(agent: AgentDefinition | undefined, task = "", needsArtifacts = false, hasPrevious = false, options: ChildToolOptions = {}): string[] {
  const deepHandoff = options.budgetProfile === "deep" || options.budgetProfile === "extended";
  if (hasPrevious && shouldUseHandoffOnlyMode(agent, deepHandoff, Boolean(options.previousClaimsNeedAudit))) return [];
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

export function toolBudgetForStep(agent: AgentDefinition | undefined, step: Pick<RunStepState, "agent" | "task" | "budget">, routeKind: RouteKind = "multi-agent-sequential"): number {
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
  return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : agent?.concern === "review" ? 8 : 4;
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
    "- Evidence-grade claims: dry-runs, inventories, grep counts, and partial logs are not live verification; numeric counts need observed output or omission.",
    "- Before claiming absence or exact ids/versions/modules/packages/counts/commands, cite handoff/context evidence or a fresh read; otherwise mark unknown/omit.",
    "- Reconcile contradictions between handoffs before synthesis. If evidence conflicts, say what is unresolved and what check would settle it; do not concatenate raw upstream output as if all claims were simultaneously true.",
    "- Do not write memory candidates for transient pass/fail/current-status claims. Durable memory may describe stable commands, conventions, or workflow rules.",
  ].join("\n");
}

function extractAgentSection(text: string, start: string, end: string): string {
  const pattern = new RegExp(`${RegExp.escape(start)}:\\s*([\\s\\S]*?)(?:\\n\\s*${RegExp.escape(end)}:|$)`, "i");
  return pattern.exec(text)?.[1]?.trim() ?? "";
}

function shouldUseHandoffOnlyMode(agent: AgentDefinition | undefined, deepHandoff: boolean, previousClaimsNeedAudit = false): boolean {
  if (!agent || deepHandoff) return false;
  if (previousClaimsNeedAudit) return false;
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
    "- Produce a Coverage Matrix before synthesis. Required surfaces are structural, not domain-specific: runtime/entrypoints; command/tool/route surfaces; persistence/sync/state; project/environment detection; external integrations/protocol adapters; API/service boundaries; user-facing surfaces; governance/conflict/safety mechanisms; tests/evals/tooling; known gaps.",
    "- Mark every Coverage Matrix item as one of: covered with evidence, not present with evidence, or unknown/gap. Do not pretend an unknown is absent.",
    "- Produce an Evidence Table using claim + evidence + confidence + gap. Evidence should include file paths and symbol/function/route/config keys when available.",
    "- If the project has specialized subsystems, map them to those structural surfaces instead of assuming a fixed product category.",
    "- For command/tool/route surfaces, cite representative concrete identifiers discovered in the repo instead of generic labels only.",
    "- For persistence/sync/state, state what is the source of truth and name concrete artifacts discovered in the repo when present.",
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
    "- Empty memory results are not a coverage gap when Previous Handoff or Context Packet already contains the evidence map; synthesize from those handoffs and mark memory as unavailable.",
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
