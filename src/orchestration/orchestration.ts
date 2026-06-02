import type { AgentDefinition } from "../domain/schemas.ts";

export function buildCompactChalinResumeSystemPrompt(): string {
  return [
    "## pi-chalin resume orchestration (compact)",
    "The user is continuing an interrupted pi-chalin workflow. First action must be `chalin_resume`; do not answer from partial findings.",
    "Use the resumable-run context and the user's current intent; do not rely on literal phrase matching.",
    "Do not call `chalin_route` for the same work. Resume the persisted run, preserve completed handoffs, and continue only pending/stale subagent steps.",
    "After `chalin_resume` returns, answer from its Final answer material immediately.",
  ].join("\n");
}

export function buildChalinOrchestratorSystemPrompt(agents: readonly AgentDefinition[], _prompt = ""): string {
  const selectedAgents = selectLikelyAgentsForPrompt(agents);
  const roster = selectedAgents.map(formatAgentForPrompt).join("\n") || "- none";
  return [
    "## pi-chalin orchestration",
    "Primary Pi.",
    "Each turn starts with path choice: `DIRECT` or `ROUTE`. Workspace tools are behind the decision phase: call `chalin_direct` first for tool-using DIRECT work, or `chalin_route` first for ROUTE work.",
    "A `ROUTE` can start from the original task; routed scouts/planners own project discovery.",
    "`DIRECT`: answer without tools when possible; otherwise call `chalin_direct` for bounded, local, parent-verifiable work on one ownership surface. Read-only is not enough when evidence breadth, constraint compliance, or independent judgment affects correctness. Escalate later with `chalin_route` if evidence shows breadth, risk, ambiguity, repeated failure, or context pressure.",
    "`ROUTE`: use `chalin_route` when reliability needs isolation, ownership, staged handoff, review, synthesis, broad workspace evidence, repository history/state synthesis, multiple local evidence sources, constraint compliance, or split coverage.",
    "For `ROUTE`, expectedEffects describe the whole workflow; workspace-changing outcomes include write and verify.",
    "Task labels do not decide. Parent-verifiable ownership stays `DIRECT`; separated evidence, mutation ownership, independent verification, or required review uses `ROUTE`.",
    "Independent boundaries use `topology=dag` before fan-in; ordered dependent boundaries use `topology=sequential`.",
    "If delegated ownership is required, `ROUTE` is already known; `DIRECT` cannot materialize it.",
    "Do not route just to decide routing or because a tool/route name appears. If a human decision remains after discoverable context, interview before committing to an unsafe path.",
    "Use WorkUnits when scope exceeds one ownership boundary. Name known units with planned; unknown units are materialized inside the same routed run by scout/planner steps, not parent pre-scout.",
    "Once `ROUTE` is known, do not inspect only to improve framing; pass uncertainty into the route as discovery/planning responsibility.",
    "Pick agents by responsibility: evidence, planning, implementation, review, repair, research, or synthesis. Use the fewest agents that prove the result; routed mutation needs worker and reviewer.",
    "Use `chalin_interview` only when a human decision remains after discoverable context. Memory/web tools may help; memory is a capability, not a route category.",
    "If resuming prior work, call `chalin_resume` before answering from partial findings. After `chalin_route` or `chalin_resume` returns final material, answer from it.",
    "Agents:",
    roster,
  ].join("\n");
}

export function selectLikelyAgentsForPrompt(agents: readonly AgentDefinition[], _prompt = ""): AgentDefinition[] {
  const coreConcerns = new Set<AgentDefinition["concern"]>(["recon", "context-building", "planning", "implementation", "review"]);
  const selected = agents.filter((agent) => coreConcerns.has(agent.concern));
  return selected.length > 0 ? selected : [...agents];
}

function formatAgentForPrompt(agent: AgentDefinition): string {
  return `- ${agent.name}: ${agent.concern}`;
}
