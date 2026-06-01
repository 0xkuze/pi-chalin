import type { AgentDefinition } from "./schemas.ts";

export function buildCompactChalinResumeSystemPrompt(): string {
  return [
    "## pi-chalin resume orchestration (compact)",
    "The user is continuing an interrupted pi-chalin workflow. First action must be `chalin_resume`; do not answer from partial findings.",
    "Use the resumable-run context and the user's current intent; do not rely on literal phrase matching.",
    "Do not call `chalin_route` for the same work. Resume the persisted run, preserve completed handoffs, and continue only pending/stale subagent steps.",
    "After `chalin_resume` returns, answer from its Final answer material immediately.",
  ].join("\n");
}

export function buildChalinOrchestratorSystemPrompt(agents: readonly AgentDefinition[], prompt = ""): string {
  const selectedAgents = selectLikelyAgentsForPrompt(agents, prompt);
  const roster = selectedAgents.map(formatAgentForPrompt).join("\n") || "- none";
  return [
    "## pi-chalin orchestration",
    "You are the primary Pi agent.",
    "At the start choose one path: `DIRECT` or `ROUTE`.",
    "`DIRECT`: use normal Pi tools/support tools when work is bounded, local, and verifiable by the parent: small evidence passes, clear edits, read-only checks, or operational decisions. Escalate only if evidence shows breadth, risk, ambiguity, repeated failure, or context pressure.",
    "`ROUTE`: call `chalin_route` when reliability needs isolation: broad repo reconstruction, risky long-context mutation, independent ownership, staged work, implementation handoff, review, or synthesis beyond one agent.",
    "Task labels do not decide. Use `DIRECT` for closed-scope reading, decisions, clear edits, or operations; use `ROUTE` for inventory, global synthesis, fragile mutation, implementation risk, independent verification, or split responsibilities.",
    "Read-only evidence stays `DIRECT` when scope, boundary, and output are concrete enough for parent inspection; named/small surfaces stay direct even with risk labels. Route unknown workspace reconstruction, global synthesis, or split coverage.",
    "Tool-choice/policy questions stay `DIRECT`: explain the path; never route just to decide routing or because a tool/route name appears. Explicit no-execution/no-mutation decisions stay `DIRECT` unless visible evidence proves direct judgment unreliable.",
    "Long-file minimal mutations are `ROUTE` when correctness depends on narrow diffs, avoiding broad rewrites, or independent verification.",
    "If routing, choose `topology=sequential` for ordered dependencies or `topology=dag` for independent parallel stages before fan-in.",
    "Prefer `dag` when the user asks to split surfaces or independent surfaces need later synthesis, comparison, review, or merge.",
    "Pick agents by responsibility: evidence, planning, implementation, review, repair, research, or synthesis. Use the fewest agents that can prove the result. Routed file mutation needs a worker and a later reviewer.",
    "Use `chalin_interview` only when a human decision remains after discoverable context. Use memory/web support tools when they help; memory is a capability, not a route category.",
    "If resuming prior work, call `chalin_resume` before answering from partial findings. After `chalin_route` or `chalin_resume` returns final material, answer from it.",
    "Available pi-chalin agents:",
    roster,
  ].join("\n");
}

export function selectLikelyAgentsForPrompt(agents: readonly AgentDefinition[], _prompt: string): AgentDefinition[] {
  const prompt = _prompt.trim();
  if (!prompt) return [...agents];
  const tokens = semanticTokens(prompt);
  const ranked = agents
    .map((agent) => ({ agent, score: scoreAgentForPrompt(agent, tokens) }))
    .sort((left, right) => right.score - left.score || left.agent.name.localeCompare(right.agent.name));
  const topScore = ranked[0]?.score ?? 0;
  if (topScore < 2) return [...agents];

  const selected = ranked
    .filter((item) => item.score >= Math.max(2, topScore - 2))
    .slice(0, 5)
    .map((item) => item.agent);
  const selectedNames = new Set(selected.map((agent) => agent.name));
  if (selectedNames.has("worker")) {
    addByName(selected, agents, selectedNames, "reviewer");
  }
  if (selected.length < 2 && selectedNames.has("planner")) {
    addByName(selected, agents, selectedNames, "scout");
  }
  return selected.length > 0 ? selected : [...agents];
}

function formatAgentForPrompt(agent: AgentDefinition): string {
  return `- ${agent.name}: ${agent.concern}`;
}

function scoreAgentForPrompt(agent: AgentDefinition, tokens: Set<string>): number {
  let score = 0;
  const concernScore = overlap(tokens, concernTerms[agent.concern] ?? []);
  const namedAgent = tokens.has(agent.name.toLowerCase());
  if (agent.concern === "conflict-resolution" && concernScore === 0 && !namedAgent) return 0;
  score += concernScore * 2;
  if (agent.concern !== "conflict-resolution" && (agent.capabilities.includes("edit-files") || agent.capabilities.includes("write-new-files"))) {
    score += overlap(tokens, intentTerms.write);
  }
  if (agent.concern !== "conflict-resolution" && agent.capabilities.includes("validate")) {
    score += overlap(tokens, intentTerms.verify);
  }
  if (agent.capabilities.includes("external-context")) {
    score += overlap(tokens, intentTerms.external);
  }
  if (agent.capabilities.includes("coordinate")) {
    score += overlap(tokens, intentTerms.coordinate);
  }
  if (agent.capabilities.includes("memory-read") || agent.capabilities.includes("memory-write")) {
    score += overlap(tokens, intentTerms.memory);
  }
  if (namedAgent) score += 4;
  return score;
}

function addByName(selected: AgentDefinition[], agents: readonly AgentDefinition[], selectedNames: Set<string>, name: string): void {
  if (selectedNames.has(name)) return;
  const agent = agents.find((candidate) => candidate.name === name);
  if (!agent) return;
  selected.push(agent);
  selectedNames.add(name);
}

function semanticTokens(text: string): Set<string> {
  const normalized = text.toLowerCase();
  const tokens = new Set<string>();
  let current = "";
  for (const char of normalized) {
    if (isSemanticTokenChar(char)) {
      current += char;
      continue;
    }
    if (current.length >= 2) tokens.add(current);
    current = "";
  }
  if (current.length >= 2) tokens.add(current);
  return tokens;
}

function isSemanticTokenChar(char: string): boolean {
  return (char >= "a" && char <= "z")
    || (char >= "0" && char <= "9")
    || "áéíóúüñç_-.".includes(char);
}

function overlap(tokens: Set<string>, terms: readonly string[]): number {
  return terms.reduce((count, term) => count + (tokens.has(term) ? 1 : 0), 0);
}

const intentTerms = {
  write: ["implement", "implementation", "fix", "bugfix", "change", "update", "add", "write", "create", "patch", "repair", "edit", "modifica", "cambia", "actualiza", "agrega", "añade", "crea", "corrige", "arregla", "implementa", "refactoriza", "parchea", "repara"],
  verify: ["verify", "verification", "test", "tests", "coverage", "review", "validate", "validation", "verifica", "validacion", "validación", "prueba", "pruebas", "cobertura", "revisa"],
  external: ["web", "latest", "current", "fresh", "docs", "documentation", "paper", "research", "investiga", "actual", "reciente", "documentacion", "documentación"],
  coordinate: ["plan", "split", "delegate", "orchestrate", "route", "dag", "parallel", "parallelize", "divide", "coordina", "planifica", "delegar", "dividir"],
  memory: ["memory", "remember", "recall", "memoria", "recuerda"],
} as const;

const concernTerms: Partial<Record<AgentDefinition["concern"], readonly string[]>> = {
  recon: ["analyze", "understand", "inventory", "map", "repo", "project", "structure", "module", "modules", "analiza", "entiende", "estructura", "modulos", "módulos", "proyecto"],
  research: ["research", "web", "latest", "paper", "docs", "external", "investiga", "documentacion", "documentación", "actual"],
  "context-building": ["context", "handoff", "synthesize", "summary", "evidence", "contexto", "sintetiza", "evidencia"],
  planning: ["plan", "approach", "strategy", "migration", "compare", "recommend", "planner", "planifica", "migrar", "comparar", "recomienda"],
  implementation: intentTerms.write,
  review: ["review", "risk", "security", "audit", "coverage", "verdict", "bugs", "revisa", "riesgo", "seguridad", "audita", "cobertura"],
  "conflict-resolution": ["conflict", "merge", "rebase", "worktree", "conflicto", "fusion", "mergear"],
  "decision-consistency": ["decide", "consistent", "contradiction", "tradeoff", "decision", "decide", "consistencia", "contradiccion", "contradicción"],
  delegation: ["delegate", "route", "orchestrate", "subagent", "delegar", "orquestar"],
  "memory-curation": intentTerms.memory,
};
