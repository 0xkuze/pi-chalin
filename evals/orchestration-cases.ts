export type ChalinExpectedDecision = "chalin" | "direct";
export type ChalinExpectedTopology = "sequential" | "dag" | "none";
export type ChalinPreRouteInspection = "forbidden" | "minimal-if-needed";

export interface ChalinOrchestrationEvalCase {
  id: string;
  prompt: string;
  expectedDecision: ChalinExpectedDecision;
  expectedTopology: ChalinExpectedTopology;
  expectedWorkUnitStrategy?: "none" | "discover" | "planned";
  minWorkUnits?: number;
  minMaterializedWorkUnits?: number;
  acceptedTopologies?: ChalinExpectedTopology[];
  expectedAgents: string[];
  acceptedAgentSets?: string[][];
  preRouteInspection?: ChalinPreRouteInspection;
  category: string;
  reason: string;
}

export const ORCHESTRATION_EVAL_CASES: ChalinOrchestrationEvalCase[] = [
  {
    id: "branch-summary-nontrivial",
    prompt: "hey what we do in this branch",
    expectedDecision: "chalin",
    expectedTopology: "sequential",
    expectedAgents: ["scout"],
    preRouteInspection: "forbidden",
    category: "branch-analysis",
    reason: "Branch summaries require git/diff exploration, but a single scout can provide the evidence handoff while the primary agent synthesizes the user-facing answer.",
  },
  {
    id: "project-understanding",
    prompt: "que hace este proyecto y cuales son sus modulos principales",
    expectedDecision: "chalin",
    expectedTopology: "sequential",
    acceptedTopologies: ["sequential", "dag"],
    expectedAgents: ["scout"],
    acceptedAgentSets: [["scout"], ["context-builder"]],
    preRouteInspection: "forbidden",
    category: "broad-local-analysis",
    reason: "Understanding an unknown project needs scoped exploration; sequential and DAG are both valid depending on whether the router keeps the map as one ordered pass or splits independent surfaces before synthesis.",
  },
  {
    id: "deep-project-fanout",
    prompt: "entiende este proyecto en profundidad dividiendo el analisis por carpetas principales y luego sintetiza",
    expectedDecision: "chalin",
    expectedTopology: "dag",
    acceptedTopologies: ["dag", "sequential"],
    expectedAgents: ["scout", "context-builder"],
    preRouteInspection: "forbidden",
    category: "deep-local-analysis-fanout",
    reason: "Deep repository understanding should gather scoped context and synthesize afterward; DAG is preferred when the router splits independent surfaces, while sequential is still valid when it preserves a coherent ordered analysis.",
  },
  {
    id: "architecture-migration",
    prompt: "si tuvieras que migrar todos los componentes a Vue 3 como lo harias",
    expectedDecision: "chalin",
    expectedTopology: "sequential",
    expectedAgents: ["scout", "planner"],
    preRouteInspection: "forbidden",
    category: "architecture-migration",
    reason: "A migration across all components benefits from inventory then planning; a separate reviewer is optional overhead unless risk review is requested.",
  },
  {
    id: "project-review",
    prompt: "review this project and tell me the main architecture risks",
    expectedDecision: "chalin",
    expectedTopology: "sequential",
    acceptedTopologies: ["sequential", "dag"],
    expectedAgents: ["scout"],
    preRouteInspection: "forbidden",
    category: "review",
    reason: "A high-level architecture-risk overview needs routed evidence; sequential and DAG are both valid depending on whether the router keeps one scout pass or splits independent surfaces before synthesis.",
  },
  {
    id: "multi-file-implementation",
    prompt: "implement a safer auth refresh flow and add tests",
    expectedDecision: "chalin",
    expectedTopology: "sequential",
    acceptedTopologies: ["sequential", "dag"],
    expectedAgents: ["worker", "reviewer"],
    acceptedAgentSets: [
      ["worker", "reviewer"],
      ["scout", "planner", "worker", "reviewer"],
    ],
    preRouteInspection: "forbidden",
    category: "implementation",
    reason: "A behavior-and-test implementation needs routed execution and review. The workflow may stay sequential or add discovery/planning/DAG decomposition when the model finds unclear ownership boundaries.",
  },
  {
    id: "explicit-unit-fanout",
    prompt: "este cambio va a ser grande: mejora el comportamiento, las pruebas y la documentacion de las partes independientes del repo; primero identifica superficies que se puedan trabajar sin pisarse, ejecuta cada parte por separado, valida cada resultado y cierra con una revision global",
    expectedDecision: "chalin",
    expectedTopology: "dag",
    expectedWorkUnitStrategy: "discover",
    minMaterializedWorkUnits: 2,
    expectedAgents: ["scout", "worker", "reviewer"],
    preRouteInspection: "forbidden",
    category: "explicit-decomposition",
    reason: "A broad implementation request with concrete quality goals must preserve independent execution intent: first discover bounded parts, then execute and review them separately instead of collapsing everything into one generic worker.",
  },
  {
    id: "explicit-boundary-fanout",
    prompt: "haz una mejora amplia en este proyecto, pero dividela por limites reales de responsabilidad del codigo; cada parte debe avanzar aislada, tener verificacion propia y luego una comprobacion final de consistencia",
    expectedDecision: "chalin",
    expectedTopology: "dag",
    expectedWorkUnitStrategy: "discover",
    minMaterializedWorkUnits: 2,
    expectedAgents: ["scout", "worker", "reviewer"],
    preRouteInspection: "forbidden",
    category: "explicit-decomposition",
    reason: "The user explicitly defines work by responsibility boundary; pi-chalin should discover concrete bounded parts and preserve separate execution/review.",
  },
  {
    id: "explicit-scope-fanout",
    prompt: "quiero una implementacion amplia, no una sola pasada gigante; separa el trabajo por areas independientes que encuentres en el workspace, comprueba cada area y despues integra el resultado",
    expectedDecision: "chalin",
    expectedTopology: "dag",
    expectedWorkUnitStrategy: "discover",
    minMaterializedWorkUnits: 2,
    expectedAgents: ["scout", "worker", "reviewer"],
    preRouteInspection: "forbidden",
    category: "explicit-decomposition",
    reason: "The user explicitly asks for independent-area decomposition; routing should remain unit-agnostic and use discovery plus separate execution/review.",
  },
  {
    id: "large-work-decomposition",
    prompt: "en este workspace, implementa un plan de cambios reales que excede un worker unico; descomponlo en unidades pequenas descubiertas, ejecuta subagentes aislados y revisa el fan-in",
    expectedDecision: "chalin",
    expectedTopology: "dag",
    expectedWorkUnitStrategy: "discover",
    minMaterializedWorkUnits: 2,
    expectedAgents: ["scout", "worker", "reviewer"],
    preRouteInspection: "forbidden",
    category: "large-work-decomposition",
    reason: "Implementation that exceeds one worker ownership boundary should not be assigned to one oversized worker; it needs discovery/planning, bounded worker-owned units, and fan-in review.",
  },
  {
    id: "parallel-options",
    prompt: "compare two possible approaches for splitting the frontend modules and recommend one",
    expectedDecision: "chalin",
    expectedTopology: "sequential",
    expectedAgents: ["planner"],
    preRouteInspection: "minimal-if-needed",
    category: "parallel-analysis",
    reason: "A local module-splitting comparison can use compact evidence then planning; parallel planners are reserved for explicitly independent perspectives or high-stakes disagreement.",
  },
  {
    id: "parallel-independent-writers",
    prompt: "implementa dos cambios independientes en modulos separados: mejora auth y agrega tests de billing",
    expectedDecision: "chalin",
    expectedTopology: "dag",
    expectedWorkUnitStrategy: "planned",
    expectedAgents: ["worker"],
    preRouteInspection: "forbidden",
    category: "parallel-implementation",
    reason: "Independent implementation slices already named by the user should use a planned DAG with isolated worker ownership and later review, instead of dynamic discovery fanout.",
  },
  {
    id: "memory-recall",
    prompt: "recuerda que decidimos sobre la memoria de pi-chalin",
    expectedDecision: "direct",
    expectedTopology: "none",
    expectedAgents: [],
    category: "memory",
    reason: "Explicit memory recall should use direct memory search when available; memory is a capability, not a route topology.",
  },
  {
    id: "go-project-understanding",
    prompt: "analiza este servicio Go y dime su estructura principal, entrypoints y como se testea",
    expectedDecision: "chalin",
    expectedTopology: "sequential",
    expectedAgents: ["scout"],
    preRouteInspection: "forbidden",
    category: "broad-local-analysis-go",
    reason: "Stack-agnostic project understanding should use scout evidence without assuming a Node-style package manifest or paying for avoidable synthesis overhead.",
  },
  {
    id: "complex-go-implementation-plan",
    prompt: "implementa manejo seguro de refresh token en este servicio Go y agrega tests",
    expectedDecision: "chalin",
    expectedTopology: "sequential",
    acceptedTopologies: ["sequential", "dag"],
    minWorkUnits: 2,
    expectedAgents: ["worker", "reviewer"],
    preRouteInspection: "forbidden",
    category: "implementation-go",
    reason: "A Go implementation with tests needs worker execution, review, persisted checkpointing, and bounded WorkUnits. Sequential and DAG are both valid: ordered units should stay sequential, while independent ownership boundaries may fan out before integration review.",
  },
  {
    id: "surgical-long-file-edit",
    prompt: "en un archivo largo cambia solo la validacion puntual de auth y evita reescribir el archivo completo",
    expectedDecision: "chalin",
    expectedTopology: "sequential",
    expectedAgents: ["worker", "reviewer"],
    preRouteInspection: "forbidden",
    category: "surgical-edit",
    reason: "A long-file no-rewrite edit needs disciplined worker mutation and reviewer verification; a separate planner is useful only when target-region planning is nontrivial.",
  },
  {
    id: "policy-aware-review",
    prompt: "revisa si los tests y comandos del proyecto estan bien configurados sin crear scripts temporales",
    expectedDecision: "chalin",
    expectedTopology: "sequential",
    expectedAgents: ["reviewer"],
    preRouteInspection: "forbidden",
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
