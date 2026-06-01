export type ChalinExpectedDecision = "chalin" | "direct";
export type ChalinExpectedTopology = "single" | "chain" | "parallel" | "dag" | "memory-only" | "none";

export interface ChalinOrchestrationEvalCase {
  id: string;
  prompt: string;
  expectedDecision: ChalinExpectedDecision;
  expectedTopology: ChalinExpectedTopology;
  expectedAgents: string[];
  category: string;
  reason: string;
}

export const ORCHESTRATION_EVAL_CASES: ChalinOrchestrationEvalCase[] = [
  {
    id: "branch-summary-nontrivial",
    prompt: "hey what we do in this branch",
    expectedDecision: "chalin",
    expectedTopology: "single",
    expectedAgents: ["scout"],
    category: "branch-analysis",
    reason: "Branch summaries require git/diff exploration, but a single scout can provide the evidence handoff while the primary agent synthesizes the user-facing answer.",
  },
  {
    id: "project-understanding",
    prompt: "que hace este proyecto y cuales son sus modulos principales",
    expectedDecision: "chalin",
    expectedTopology: "single",
    expectedAgents: ["scout"],
    category: "broad-local-analysis",
    reason: "Understanding an unknown project needs scoped exploration; the primary agent can synthesize from a scout handoff without a second subagent unless gap reads are required.",
  },
  {
    id: "deep-project-fanout",
    prompt: "entiende este proyecto en profundidad dividiendo el analisis por carpetas principales y luego sintetiza",
    expectedDecision: "chalin",
    expectedTopology: "dag",
    expectedAgents: ["scout", "context-builder"],
    category: "deep-local-analysis-fanout",
    reason: "Deep repository understanding should gather initial context, fan out folder analysis in parallel, and synthesize afterward.",
  },
  {
    id: "architecture-migration",
    prompt: "si tuvieras que migrar todos los componentes a Vue 3 como lo harias",
    expectedDecision: "chalin",
    expectedTopology: "chain",
    expectedAgents: ["scout", "planner"],
    category: "architecture-migration",
    reason: "A migration across all components benefits from inventory then planning; a separate reviewer is optional overhead unless risk review is requested.",
  },
  {
    id: "project-review",
    prompt: "review this project and tell me the main architecture risks",
    expectedDecision: "chalin",
    expectedTopology: "single",
    expectedAgents: ["scout"],
    category: "review",
    reason: "A high-level architecture-risk overview can be handled by one scout handoff plus primary synthesis; formal audits should use reviewer.",
  },
  {
    id: "multi-file-implementation",
    prompt: "implement a safer auth refresh flow and add tests",
    expectedDecision: "chalin",
    expectedTopology: "chain",
    expectedAgents: ["worker", "reviewer"],
    category: "implementation",
    reason: "Implementation touching behavior and tests needs an executor and a later review; the worker can gather local context unless evidence proves a separate scout/planner is needed.",
  },
  {
    id: "parallel-options",
    prompt: "compare two possible approaches for splitting the frontend modules and recommend one",
    expectedDecision: "chalin",
    expectedTopology: "chain",
    expectedAgents: ["planner"],
    category: "parallel-analysis",
    reason: "A local module-splitting comparison can use compact evidence then planning; parallel planners are reserved for explicitly independent perspectives or high-stakes disagreement.",
  },
  {
    id: "parallel-independent-writers",
    prompt: "implementa dos cambios independientes en modulos separados: mejora auth y agrega tests de billing",
    expectedDecision: "chalin",
    expectedTopology: "dag",
    expectedAgents: ["worker"],
    category: "parallel-implementation",
    reason: "Independent implementation slices should use a staged DAG so discovery/planning can happen first, worker tasks can fan out in parallel with isolated ownership, and review can fan in afterward.",
  },
  {
    id: "memory-recall",
    prompt: "recuerda que decidimos sobre la memoria de pi-chalin",
    expectedDecision: "chalin",
    expectedTopology: "memory-only",
    expectedAgents: [],
    category: "memory",
    reason: "Explicit memory recall should use the chalin memory path.",
  },
  {
    id: "go-project-understanding",
    prompt: "analiza este servicio Go y dime su estructura principal, entrypoints y como se testea",
    expectedDecision: "chalin",
    expectedTopology: "single",
    expectedAgents: ["scout"],
    category: "broad-local-analysis-go",
    reason: "Stack-agnostic project understanding should use scout evidence without assuming a Node-style package manifest or paying for avoidable synthesis overhead.",
  },
  {
    id: "complex-go-implementation-plan",
    prompt: "implementa manejo seguro de refresh token en este servicio Go y agrega tests",
    expectedDecision: "chalin",
    expectedTopology: "chain",
    expectedAgents: ["worker", "reviewer"],
    category: "implementation-go",
    reason: "A Go implementation with tests needs worker execution and review; extra planning/discovery agents are optional when the route discovers broader risk.",
  },
  {
    id: "surgical-long-file-edit",
    prompt: "en un archivo largo cambia solo la validacion puntual de auth y evita reescribir el archivo completo",
    expectedDecision: "chalin",
    expectedTopology: "chain",
    expectedAgents: ["worker", "reviewer"],
    category: "surgical-edit",
    reason: "A long-file no-rewrite edit needs disciplined worker mutation and reviewer verification; a separate planner is useful only when target-region planning is nontrivial.",
  },
  {
    id: "policy-aware-review",
    prompt: "revisa si los tests y comandos del proyecto estan bien configurados sin crear scripts temporales",
    expectedDecision: "chalin",
    expectedTopology: "single",
    expectedAgents: ["reviewer"],
    category: "tool-discipline-review",
    reason: "A reviewer can inspect test and command configuration directly; extra scout handoff is optional overhead.",
  },
  {
    id: "bounded-release-metadata-bump",
    prompt: "Without modifying files, decide whether bumping package.json versions for the latest merge on main should be handled through direct work or chalin_route.",
    expectedDecision: "direct",
    expectedTopology: "none",
    expectedAgents: [],
    category: "bounded-release-metadata",
    reason: "A local version/metadata bump from git evidence is an operational chore: native git/package inspection plus focused metadata edits are cheaper than subagent orchestration unless the user asks for release strategy or broad analysis.",
  },
  {
    id: "bounded-release-branch-pr",
    prompt: "Without running git or GitHub commands, decide whether moving existing version-bump changes to a release branch and opening a documented PR should be handled through direct work or chalin_route.",
    expectedDecision: "direct",
    expectedTopology: "none",
    expectedAgents: [],
    category: "bounded-release-ops",
    reason: "Moving existing local changes to a branch and opening a PR is a bounded git/release operation, not PR analysis; direct bash/git/gh work should handle it unless deeper review is requested.",
  },
  {
    id: "bounded-read-only-mini-review",
    prompt: "Revisa este mini proyecto y dime si hay riesgo de seguridad en el boundary de auth. No modifiques archivos; entrega evidencia con paths concretos.",
    expectedDecision: "direct",
    expectedTopology: "none",
    expectedAgents: [],
    category: "bounded-read-only-review",
    reason: "A small read-only review that explicitly forbids mutation is cheaper and safer as direct native inspection; chalin approval adds overhead without quality gain.",
  },
  {
    id: "simple-greeting",
    prompt: "hola",
    expectedDecision: "direct",
    expectedTopology: "none",
    expectedAgents: [],
    category: "simple",
    reason: "A greeting does not need subagents.",
  },
  {
    id: "simple-definition",
    prompt: "que es un composable en Vue",
    expectedDecision: "direct",
    expectedTopology: "none",
    expectedAgents: [],
    category: "simple",
    reason: "General knowledge explanation is best answered directly.",
  },
  {
    id: "small-single-file-edit",
    prompt: "corrige un typo en el README",
    expectedDecision: "direct",
    expectedTopology: "none",
    expectedAgents: [],
    category: "small-edit",
    reason: "A trivial isolated edit does not need orchestration overhead.",
  },
  {
    id: "clarification",
    prompt: "puedes explicarlo mas simple?",
    expectedDecision: "direct",
    expectedTopology: "none",
    expectedAgents: [],
    category: "conversation",
    reason: "Conversational clarification should not spawn agents.",
  },
  {
    id: "single-command",
    prompt: "corre bun test y dime si pasa",
    expectedDecision: "direct",
    expectedTopology: "none",
    expectedAgents: [],
    category: "single-command",
    reason: "A single direct command is cheaper and clearer as native Pi work unless failures require deeper investigation.",
  },
];

export function summarizeOrchestrationEvalCases(cases: ChalinOrchestrationEvalCase[] = ORCHESTRATION_EVAL_CASES) {
  const chalinExpected = cases.filter((testCase) => testCase.expectedDecision === "chalin");
  const directExpected = cases.filter((testCase) => testCase.expectedDecision === "direct");
  const byTopology = new Map<ChalinExpectedTopology, number>();
  for (const testCase of cases) {
    byTopology.set(testCase.expectedTopology, byTopology.getOrInsert(testCase.expectedTopology, 0) + 1);
  }
  return {
    total: cases.length,
    chalinExpected: chalinExpected.length,
    directExpected: directExpected.length,
    chalinExpectedRate: cases.length === 0 ? 0 : chalinExpected.length / cases.length,
    byTopology: Object.fromEntries(byTopology.entries()),
  };
}
