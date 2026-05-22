import type { AgentCapability, AgentDefinition, RouteKind, ToolBudgetProfile } from "./schemas.ts";
import { policyForStep } from "./budget.ts";
import { buildProjectDiscoveryIndex, formatProjectDiscoveryIndex } from "./discovery.ts";
import type { RunStepState } from "./schemas.ts";

export interface SdkPromptOptions {
  priorFilesRead?: string[];
  synthesisGapReadLimit?: number;
  memoryContext?: string;
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
  const deepProjectAnalysis = isDeepProjectAnalysisTask(task) || budgetProfile === "deep" || (typeof budget !== "number" && budget.profile === "deep");
  const handoffGapMode = isHandoffGapReadMode(agent, task, previous);
  const budgetPolicy = typeof budget === "number"
    ? policyForStep(agent, { agent: agent?.name ?? "agent", task, budget: budgetProfile }, "single-agent")
    : budget;
  const maxTools = typeof budget === "number" ? budget : budget.caps.maxToolCalls;
  const profile = typeof budget === "number" ? budgetProfile : budget.profile;
  return [
    compactAgentInstructions(agent),
    "",
    "## pi-chalin concern/capability policy",
    `- Concern: ${agent?.concern ?? "delegation"}.`,
    `- Capabilities: ${capabilities.join(", ") || "inspect-files, search-files"}.`,
    "- Runtime tools are derived from capabilities; do not assume a tool exists because another agent has it.",
    "",
    "## pi-chalin child tool policy",
    "- Use Pi-native tools directly: read/find/grep/ls for inspection, edit for minimal line-level changes.",
    "- Use chalin_project_discovery first for broad project understanding. It is a raw file index, not semantic truth; read evidence files before making claims.",
    "- Use chalin_project_snapshot only as legacy compact stack/git context or for branch-summary reconnaissance; never treat it as proof of architecture.",
    "- Bash is guarded and only for safe inspection or explicit validation commands: git status/log/diff/show/rev-parse, pwd, ls, find, grep/rg, cat for one explicit small file, and known test/typecheck commands.",
    "- Never create temporary Python/Node/shell scripts to read, inspect, summarize, or modify project files.",
    "- Never modify files through bash. No redirection, tee, sed -i, rm/cp/mv/mkdir/touch/chmod, or generated scripts.",
    "- For existing files, never rewrite the whole file when a targeted edit is possible. Use edit with the smallest exact old/new block. Use write only for new files.",
    "",
    "## pi-chalin runtime budget",
    `- Tool budget profile: ${profile}. Max tool calls for this child turn: ${maxTools}.`,
    `- Budget caps: ${budgetPolicy.caps.maxSeconds}s, $${budgetPolicy.caps.maxUsd}, ${budgetPolicy.caps.maxTurns} turns, ${budgetPolicy.caps.maxOutputChars} output chars, ${budgetPolicy.caps.maxReadBytes} read bytes, ${budgetPolicy.caps.maxFilesTouched} files touched, ${budgetPolicy.caps.maxRetriesPerTool} retries/tool.`,
    "- Stay bounded. Do not perform an exhaustive repository crawl unless the task explicitly requires it.",
    agent?.concern === "recon" || deepProjectAnalysis
      ? "- AGENTS/JIT-first: when the discovery index lists AGENTS.md, CONTEXT.md, ADRs, or package instruction files, read the root instructions first and then only the package instruction files relevant to the task before broad source reads."
      : undefined,
    profile === "tight"
      ? "- Tight profile: use the discovery index first, then inspect only the smallest evidence set needed to answer."
      : profile === "deep" || profile === "extended"
        ? "- Deep/autonomous profile: use the discovery index first, formulate an inspection plan, then inspect breadth-first with compact notes; checkpoint/compress at stage boundaries instead of exhaustive context stuffing."
        : "- Normal profile: use the discovery index first, then inspect the evidence files needed; avoid exhaustive crawls unless the task requires it.",
    "- Prefer concise findings with evidence. Stop after the highest-value actionable issues; do not spend budget proving low-value metadata already present in the snapshot.",
    `- Use at most ${maxTools} tool calls for this role. If you hit the budget, stop and report partial findings plus uncertainty.`,
    "- If you hit any budget cap, treat it as a checkpoint boundary, not a failure: return partial handoff, uncertainty, and the next split/continue recommendation.",
    "- For hours/days-long autonomous work, do not try to solve everything inside one child turn. Write artifacts/checkpoints, return a handoff, and let the orchestrator continue with another bounded stage.",
    "- Do not browse the web unless this agent role and task explicitly request fresh external context.",
    deepProjectAnalysis
      ? "- Output budget for deep analysis: `## Findings` max 10 evidence-backed bullets, `## Handoff` max 14 bullets or 2600 characters, `## Memory Candidates` max 3 bullets. Accuracy beats brevity; do not pad."
      : "- Output budget: `## Findings` max 5 bullets, `## Handoff` max 8 bullets or 1200 characters, `## Memory Candidates` max 3 bullets.",
    "- For long-running work, use chalin_artifact_write only at meaningful boundaries: feature-state at start, checkpoint after a completed handoff, validation-contract before reviewer/worker handoff, worker-skill for reusable feature-specific rules.",
    memoryPolicyForAgent(agent),
    "- Do not paste raw command output or long code snippets. Cite file paths and line-level evidence when useful.",
    deepProjectAnalysis ? deepProjectAnalysisContract() : undefined,
    handoffGapMode ? handoffGapReadContract(options, agent) : undefined,
    "",
    "## Stop conditions",
    stopConditionsForAgent(agent, task),
    "",
    previous ? "## Previous Handoff" : undefined,
    previous || undefined,
    previous ? "" : undefined,
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
    "- Only durable, human-readable project knowledge that will help future work.",
    "- Max 3 bullets.",
    "- Use 1-3 complete sentences per bullet. Prefer categories like `project-fact:`, `pattern:`, `tooling:`, `testing:`, `workflow:`, `bugfix:`, `decision:`, or `preference:`.",
    "- Good: `tooling: This project uses Bun for tests, and tests should avoid setTimeout-based waits because they are flaky.`",
    "- Good: `workflow: Long-running feature work should checkpoint validation contracts after each stage so later agents can resume safely.`",
    "- Bad: commands, logs, code snippets, raw stdout/stderr, stack traces, task completion notes, or obvious one-line facts.",
    "- Write `- None.` when there is nothing worth remembering.",
  ].filter(Boolean).join("\n");
}

export function childToolNames(agent: AgentDefinition | undefined, task = "", needsArtifacts = false, hasPrevious = false): string[] {
  if (hasPrevious && shouldUseHandoffOnlyMode(task, agent)) return taskNeedsArtifactWrite(task) && needsArtifacts ? ["chalin_artifact_write"] : [];
  if (isSnapshotOnlyRecon(task, agent)) return ["chalin_project_discovery", "chalin_project_snapshot"];
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
  if (hasAnyCapability(agent, ["run-safe-bash", "validate"]) && taskNeedsBash(task, agent)) names.add("bash");
  if (hasAnyCapability(agent, ["edit-files"])) names.add("edit");
  if (hasAnyCapability(agent, ["write-new-files"])) names.add("write");
  if (hasAnyCapability(agent, ["external-context"]) && taskNeedsExternalContext(task, agent)) names.add("chalin_web_search");
  if (needsArtifacts && taskNeedsArtifactWrite(task) && hasAnyCapability(agent, ["memory-write", "coordinate", "validate", "edit-files"])) names.add("chalin_artifact_write");
  if (agent?.memory.read !== false && hasAnyCapability(agent, ["memory-read"])) names.add("chalin_memory_search");
  if (agent?.memory.write !== "never" && hasAnyCapability(agent, ["memory-write"])) {
    names.add("chalin_memory_write");
    names.add("chalin_memory_revise");
  }
  names.add("chalin_project_discovery");
  return [...names];
}

export function toolBudgetForStep(agent: AgentDefinition | undefined, step: Pick<RunStepState, "agent" | "task" | "budget">, routeKind: RouteKind = "single-agent"): number {
  const env = Number(process.env.PI_CHALIN_CHILD_TOOL_BUDGET);
  if (Number.isFinite(env) && env > 0) return Math.floor(env);
  return policyForStep(agent, step, routeKind).caps.maxToolCalls;
}

export function resolveStepCompletionStatus(step: Pick<RunStepState, "metrics" | "output" | "error">): RunStepState["status"] {
  if (!step.metrics?.budgetStopCount) return "complete";
  if (hasUsableHandoff(step)) return "complete";
  return "budget-capped";
}

export function isHandoffGapReadMode(agent: AgentDefinition | undefined, task: string, previous?: string): boolean {
  return isSynthesisGapReadMode(agent, task, previous) || isReviewGapReadMode(agent, task, previous);
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
      ? "- You may use `chalin_memory_search` without waiting for a human instruction when prior decisions, project facts, workflows, or preferences can reduce exploration or prevent repeated mistakes."
      : undefined,
    agent.memory.write !== "never"
      ? "- You may use `chalin_memory_write` for compact durable knowledge and `chalin_memory_revise` when current evidence proves a memory stale or wrong. The WriteGuard decides active, pending, or rejected."
      : undefined,
    "- Keep memory token spend low: search with short queries, request evidence only for review/contradiction work, and never write logs, command output, code dumps, or trivial completion notes.",
    "- Memory is guidance, not proof. Current repository evidence and explicit user instructions override retrieved memory.",
  ].filter(Boolean).join("\n");
}

function extractAgentSection(text: string, start: string, end: string): string {
  const pattern = new RegExp(`${RegExp.escape(start)}:\\s*([\\s\\S]*?)(?:\\n\\s*${RegExp.escape(end)}:|$)`, "i");
  return pattern.exec(text)?.[1]?.trim() ?? "";
}

function isSnapshotOnlyRecon(task: string, agent: AgentDefinition | undefined): boolean {
  return agent?.concern === "recon"
    && /\b(branch|diff|git state|status|recent commits?|changed files?)\b/i.test(task)
    && !/\b(implement|fix|edit|security|deep|exact behavior|line-level)\b/i.test(task);
}

function shouldUseHandoffOnlyMode(task: string, agent: AgentDefinition | undefined): boolean {
  if (!agent || agent.concern === "implementation") return false;
  if (isDeepProjectAnalysisTask(task)) return false;
  const explicitDeepInspection = /\b(exact line|line-level|verify|validate|run tests?|execute tests?|security|correctness|must inspect|full review)\b/i.test(task);
  if (explicitDeepInspection) return false;
  if (agent.concern === "context-building") return /\b(synthesize|summarize|explain|final answer|answer material|consolidate|plain language|package|using scout findings|changed files enough)\b/i.test(task);
  return /\b(synthesize|summarize|explain|final answer|answer material|consolidate|package)\b/i.test(task);
}

function taskNeedsArtifactWrite(task: string): boolean {
  return /\b(artifact|checkpoint|validation contract|worker skill|resume|continuation|long-running|long running)\b/i.test(task);
}

function taskNeedsExternalContext(task: string, agent: AgentDefinition): boolean {
  if (agent.concern === "research") return true;
  return /\b(web|internet|online|current|latest|recent|docs?|url|https?:\/\/|exa|source|sources)\b/i.test(task);
}

function taskNeedsBash(task: string, agent: AgentDefinition): boolean {
  if (agent.concern === "implementation") return true;
  return /\b(test|validate|validation|lint|typecheck|git|branch|diff|commit|status|log)\b/i.test(task);
}

function toolBudgetForAgent(agent: AgentDefinition | undefined, fallbackName?: string): number {
  const env = Number(process.env.PI_CHALIN_CHILD_TOOL_BUDGET);
  if (Number.isFinite(env) && env > 0) return Math.floor(env);
  return baseToolBudget(agent, fallbackName);
}

function hasUsableHandoff(step: Pick<RunStepState, "output" | "error">): boolean {
  const text = [step.output?.handoff, step.output?.text].filter(Boolean).join("\n").trim();
  if (text.length < 80) return false;
  if (/^(done|complete|ok|no output)\.?$/i.test(text)) return false;
  return /\b(file|path|module|test|risk|finding|because|uses|contains|should|next|changed|review|implementation|architecture|project)\b/i.test(text);
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

function stopConditionsForAgent(agent: AgentDefinition | undefined, task = ""): string {
  if (isDeepProjectAnalysisTask(task) && agent?.concern === "recon") {
    return "- Stop only after producing a coverage map across top-level functional areas: entrypoints, commands/tools/routes, storage/sync, integrations, UI/cloud surfaces, tests/evals/tooling, and explicit unknowns.";
  }
  if (isDeepProjectAnalysisTask(task) && (agent?.concern === "context-building" || agent?.concern === "review")) {
    return "- Stop only after the Coverage Matrix marks each critical surface as covered with evidence, not present with evidence, or unknown/gap.";
  }
  if (agent?.concern === "recon") return "- Stop once stack signals, test/build commands, entrypoints, changed files, and 3-5 high-signal files are identified.";
  if (agent?.concern === "context-building") return "- Stop once the next agent has enough facts, constraints, relevant paths, and uncertainties to act without re-scanning.";
  if (agent?.concern === "planning") return "- Stop once the plan has ordered phases, likely files, validation, risks, and rollback notes; do not inspect implementation details deeply.";
  if (agent?.concern === "review") return "- Stop after the top 3-5 evidence-backed risks/findings; do not keep searching for marginal issues.";
  if (agent?.concern === "implementation") return "- Stop after the scoped change and nearest validation are complete; do not broaden scope or rewrite unrelated code.";
  if (agent?.concern === "research") return "- Stop after current sourced context is enough; do not browse or fetch beyond the task scope.";
  return "- Stop when the bounded task can be answered with evidence and remaining uncertainty is explicit.";
}

function isDeepProjectAnalysisTask(task: string): boolean {
  return /\b(deep|thorough|in[- ]depth|profundidad|profundo|profunda|revisa este proyecto|review this project|what (does|is) this project|que hace este proyecto|analiza este (repo|proyecto)|understand this project|project analysis)\b/i.test(task);
}

function deepProjectAnalysisContract(): string {
  return [
    "",
    "## Deep project analysis accuracy contract",
    "- Optimize for accuracy, not length. A short answer that misses core subsystems is wrong; a long answer without evidence is also wrong.",
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

function isSynthesisGapReadMode(agent: AgentDefinition | undefined, task: string, previous?: string): boolean {
  if (!previous?.trim()) return false;
  if (agent?.concern !== "context-building") return false;
  return isDeepProjectAnalysisTask(task) || /\b(synthesize|summarize|explain|final answer|answer material|consolidate|context-builder|a partir del handoff|scout findings|síntesis|sintetiza|resumen)\b/i.test(task);
}

function isReviewGapReadMode(agent: AgentDefinition | undefined, task: string, previous?: string): boolean {
  if (!previous?.trim()) return false;
  if (agent?.concern !== "review") return false;
  return isDeepProjectAnalysisTask(task) || /\b(review|validate|verify|audit|risk|gap|quality|correctness|revisa|verifica|valida|riesgos?|gaps?)\b/i.test(task);
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
    reviewMode ? "- For review, sample only the highest-risk or least-supported claims. Prefer grep/find for exact symbols/config keys; avoid full reads of already-covered files." : undefined,
    "- Do not reread files listed in `Already Covered Evidence Paths` unless you name the specific missing symbol/line/claim you are verifying.",
    "- If a read is blocked by the cross-step duplicate-read policy, do not retry variants of the same evidence path; use the handoff evidence and mark the claim as sampled/not rechecked.",
    "- Prefer citing evidence already present in the handoff. Use new reads only to close explicit gaps, then stop.",
    "- If coverage is incomplete, say exactly what remains unknown instead of expanding into a broad crawl.",
    "- Return final answer material plus a compact handoff; do not emit a second raw exploration log.",
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
