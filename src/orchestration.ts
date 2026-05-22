import type { AgentDefinition } from "./schemas.ts";

export type MeshExpectedDecision = "mesh" | "direct";
export type MeshExpectedTopology = "single" | "chain" | "parallel" | "dag" | "memory-only" | "none";

export interface MeshOrchestrationEvalCase {
  id: string;
  prompt: string;
  expectedDecision: MeshExpectedDecision;
  expectedTopology: MeshExpectedTopology;
  expectedAgents: string[];
  category: string;
  reason: string;
}

export const ORCHESTRATION_EVAL_CASES: MeshOrchestrationEvalCase[] = [
  {
    id: "branch-summary-nontrivial",
    prompt: "hey what we do in this branch",
    expectedDecision: "mesh",
    expectedTopology: "chain",
    expectedAgents: ["scout", "context-builder"],
    category: "branch-analysis",
    reason: "Branch summaries require git/diff exploration plus synthesis; mesh should be considered before spending many native tool calls.",
  },
  {
    id: "project-understanding",
    prompt: "que hace este proyecto y cuales son sus modulos principales",
    expectedDecision: "mesh",
    expectedTopology: "chain",
    expectedAgents: ["scout", "context-builder"],
    category: "broad-local-analysis",
    reason: "Understanding an unknown project needs scoped exploration and then synthesis.",
  },
  {
    id: "deep-project-fanout",
    prompt: "entiende este proyecto en profundidad dividiendo el analisis por carpetas principales y luego sintetiza",
    expectedDecision: "mesh",
    expectedTopology: "dag",
    expectedAgents: ["scout", "context-builder", "reviewer"],
    category: "deep-local-analysis-fanout",
    reason: "Deep repository understanding should gather initial context, fan out folder analysis in parallel, and synthesize afterward.",
  },
  {
    id: "architecture-migration",
    prompt: "si tuvieras que migrar todos los componentes a Vue 3 como lo harias",
    expectedDecision: "mesh",
    expectedTopology: "chain",
    expectedAgents: ["scout", "planner", "reviewer"],
    category: "architecture-migration",
    reason: "Large migrations need local architecture discovery, planning, and risk review.",
  },
  {
    id: "project-review",
    prompt: "review this project and tell me the main architecture risks",
    expectedDecision: "mesh",
    expectedTopology: "chain",
    expectedAgents: ["scout", "reviewer"],
    category: "review",
    reason: "Project-wide review should not be done blind by the primary agent.",
  },
  {
    id: "multi-file-implementation",
    prompt: "implement a safer auth refresh flow and add tests",
    expectedDecision: "mesh",
    expectedTopology: "chain",
    expectedAgents: ["scout", "planner", "worker", "reviewer"],
    category: "implementation",
    reason: "Implementation touching behavior and tests needs context, plan, execution, and review.",
  },
  {
    id: "parallel-options",
    prompt: "compare two possible approaches for splitting the frontend modules and recommend one",
    expectedDecision: "mesh",
    expectedTopology: "parallel",
    expectedAgents: ["planner"],
    category: "parallel-analysis",
    reason: "Alternative evaluation benefits from independent perspectives before synthesis.",
  },
  {
    id: "parallel-independent-writers",
    prompt: "implementa dos cambios independientes en modulos separados: mejora auth y agrega tests de billing",
    expectedDecision: "mesh",
    expectedTopology: "dag",
    expectedAgents: ["worker"],
    category: "parallel-implementation",
    reason: "Independent implementation slices should use a staged DAG so discovery/planning can happen first, worker tasks can fan out in parallel with isolated ownership, and review can fan in afterward.",
  },
  {
    id: "memory-recall",
    prompt: "recuerda que decidimos sobre la memoria de pi-chalin",
    expectedDecision: "mesh",
    expectedTopology: "memory-only",
    expectedAgents: [],
    category: "memory",
    reason: "Explicit memory recall should use the mesh memory path.",
  },
  {
    id: "go-project-understanding",
    prompt: "analiza este servicio Go y dime su estructura principal, entrypoints y como se testea",
    expectedDecision: "mesh",
    expectedTopology: "chain",
    expectedAgents: ["scout", "context-builder"],
    category: "broad-local-analysis-go",
    reason: "Stack-agnostic project understanding should work for Go projects without relying on package.json.",
  },
  {
    id: "complex-go-implementation-plan",
    prompt: "implementa manejo seguro de refresh token en este servicio Go y agrega tests",
    expectedDecision: "mesh",
    expectedTopology: "chain",
    expectedAgents: ["scout", "planner", "worker", "reviewer"],
    category: "implementation-go",
    reason: "A multi-file Go implementation with tests needs context, plan, worker, and review.",
  },
  {
    id: "surgical-long-file-edit",
    prompt: "en un archivo largo cambia solo la validacion puntual de auth y evita reescribir el archivo completo",
    expectedDecision: "mesh",
    expectedTopology: "chain",
    expectedAgents: ["scout", "planner", "worker", "reviewer"],
    category: "surgical-edit",
    reason: "A risky long-file edit should use worker discipline and reviewer verification, not a broad rewrite.",
  },
  {
    id: "policy-aware-review",
    prompt: "revisa si los tests y comandos del proyecto estan bien configurados sin crear scripts temporales",
    expectedDecision: "mesh",
    expectedTopology: "chain",
    expectedAgents: ["scout", "reviewer"],
    category: "tool-discipline-review",
    reason: "A project-wide review of tests/commands should use mesh while preserving child tool discipline.",
  },
  {
    id: "bounded-read-only-mini-review",
    prompt: "Revisa este mini proyecto y dime si hay riesgo de seguridad en el boundary de auth. No modifiques archivos; entrega evidencia con paths concretos.",
    expectedDecision: "direct",
    expectedTopology: "none",
    expectedAgents: [],
    category: "bounded-read-only-review",
    reason: "A small read-only review that explicitly forbids mutation is cheaper and safer as direct native inspection; mesh approval adds overhead without quality gain.",
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

export function buildCompactMeshOrchestratorSystemPrompt(): string {
  return [
    "## pi-chalin orchestration (compact)",
    "You are the primary Pi agent. Choose direct native execution for safe bounded implementation/scaffolding/test/refactor tasks with explicit files or acceptance criteria. Use pi-chalin only when specialist context isolation is worth the latency.",
    "Direct bounded code work: do not narrate planning or emit visible analysis before tools; first inspect briefly, then write the requested implementation/test/docs promptly, ensure requested tests prove the behavior with non-trivial assertions rather than only starter smoke/empty coverage, run the nearest relevant verification command, fix failures, rerun verification after the final edit, and answer immediately with changed paths, verification result, and one note about the satisfied constraint. For timer behavior, prefer injected clocks/schedulers over brittle mock timer APIs; for Bun CLI subprocess tests, preserve process.env and derive paths directly from import.meta.url.",
    "If the prompt says review-only, docs-only, no code changes, or no mutations, obey that literally: do not add tests/source files or modify code unless explicitly requested. For dependency-free TypeScript scaffolding, use exact requested paths, export the requested API, use package.json test script `bun test`, keep tests under `test/`, avoid uninstalled runners/dependencies, declare package.json `bin` when scaffolding a CLI command; `bin` values must be executable file paths, not command strings, and verify before final answer.",
    "Call `mesh_route` for broad/deep project analysis, architecture/migration strategy, broad review, complex/risky multi-file work, risky long-file/surgical edits, parallel option comparison, or memory/continuation work. Call `mesh_interview` only when a real decision is ambiguous.",
    "If mesh_route returns, answer from its Final answer material immediately. Do not call mesh_route for bounded direct work merely because pi-chalin is available.",
  ].join("\n");
}

export function buildCompactMeshCriticalSystemPrompt(): string {
  return [
    "## pi-chalin orchestration (critical compact)",
    "This prompt requires pi-chalin before native tools. First action should be one `mesh_route` call; do not inspect files directly before routing.",
    "Use `chain` scout → planner → worker → reviewer for risky implementation, long-file/surgical edits, auth/security-sensitive mutations, or complex multi-file work.",
    "Use `dag` for independent implementation slices: discovery/planning first, parallel workers with non-overlapping ownership, then reviewer synthesis.",
    "For surgical/long-file edits: worker must use targeted edit discipline, not full rewrite; reviewer must verify scope and tests.",
    "After `mesh_route` returns, answer from Final answer material immediately. In non-interactive runs, the mesh result itself is the handoff; do not call native tools after mesh unless the tool result explicitly says a critical blocker remains.",
    "Available agents: scout, planner, worker, reviewer, context-builder, researcher, oracle.",
  ].join("\n");
}

export function buildMeshOrchestratorSystemPrompt(agents: AgentDefinition[]): string {
  const roster = agents.map(formatAgentForPrompt).join("\n") || "- none";
  return [
    "## pi-chalin orchestration",
    "You are the primary Pi agent. Decide whether to answer directly, call `mesh_interview`, or call `mesh_route` as an agents-as-tools runtime.",
    "pi-chalin is optional orchestration for work that benefits from specialist context isolation; the user does not need to invoke it.",
    "",
    "### Gate",
    "Before read/bash/grep/find/ls, decide whether this is repository orchestration work.",
    "MUST call `mesh_resume` first when the user asks to continue/resume and a prior pi-chalin run was paused, interrupted, or left stale by terminal shutdown. Do not answer from partial findings until resume has no resumable run.",
    "MUST call `mesh_interview` before `mesh_route` when the request is ambiguous, uses a term you cannot resolve from memory/codebase exploration, has missing scope/constraints, or contains an uncovered decision branch that would make subagents guess.",
    "MUST call `mesh_route` first for clear current branch/diff/PR summaries, what this project does, project structure, architecture/migration/project-wide refactor strategy, broad/project-wide review, security/correctness review over a broad surface, complex/risky multi-file implementation, risky long-file/surgical edits, or prior memory. Do NOT treat an explicit named-file refactor implementation as refactor strategy; that is bounded direct work unless the prompt says broad/risky/long-file.",
    "Hard direct gate: if the user names one to three target file paths and asks to refactor/fix/add/update/extract tests or helpers, do NOT call `mesh_route`; use native read/edit/write/bash directly. Calling mesh_route for that bounded case wastes latency and will be redirected back to direct execution.",
    "Hard direct gate: if the user asks for a bounded read-only mini-project review and explicitly says not to modify files, do NOT call `mesh_route`; inspect the small file set directly, answer with concrete path evidence, and perform no writes.",
    "Single-file is NOT automatically direct: if the user says the file is long, asks for a surgical/targeted behavior/auth validation change, or warns not to rewrite the whole file, use mesh_route with worker/reviewer discipline.",
    "You choose topology, agents, tasks, risk, memory use, interviews, and plan size. The code does not classify prompts for you.",
    "Call `mesh_interview` in batches of 1-5 concise questions with at most 5 concise answers each; mark the best answer as recommended and allow custom answers unless safety requires constrained choices.",
    "After `mesh_interview` returns, use its artifact answers as context. If still blocked, ask another interview batch; if ready, continue planning or call `mesh_route`.",
    "Call `mesh_route` at most once per user prompt after the needed interview context is available. After it returns, immediately write the final answer from its `Final answer material`; do not keep thinking, do not call another tool, and do not inspect files unless the handoff names a concrete blocking gap.",
    "For long-running/continuation work, use `mesh_resume` for interrupted runs; use `mesh_artifact_resume` when the user names an existing feature/task artifact; otherwise set `needsArtifacts: true` so pi-chalin records run summaries and handoffs.",
    "",
    "### Interview when",
    "Use `mesh_interview` when proceeding would require guessing user intent, unknown terminology, risk tolerance, target scope, accepted tradeoffs, or destructive/large-change boundaries.",
    "Do not interview for information that can be cheaply and safely discovered from the local codebase or existing pi-chalin memory; discover first, interview only for the remaining blocker.",
    "Persisted interview answers are artifacts and should be reused by the next route/subagents instead of asking again.",
    "",
    "### Direct answer when",
    "Use normal Pi for greetings, short clarifications, simple definitions without local inspection, one obvious command, one tiny isolated edit, bounded read-only mini-project reviews, explicit named-file bugfixes/refactors with tests, or bounded implementation/scaffolding with a clear file list and low risk. Direct execution still means full fidelity to every explicit acceptance criterion: if the user asks to extract helpers, add tests, preserve behavior, or avoid dependencies, do exactly that before final answer. If the user asks for tests, changing only implementation is incomplete even when existing tests pass; add or update the relevant test file before final verification. The test change must be behavior-bearing: assert requested outputs/effects and relevant edge/failure cases when applicable; merely preserving or renaming a starter smoke/empty test is incomplete. For time/window behavior, make tests deterministic with an injected or controlled clock when possible; avoid brittle mock timer APIs unless you verify the current Bun API in this project. Do not assert exact `Date.now()`-derived milliseconds against real wall time. For named-file bugfixes/refactors, inspect the target file and tests once, edit promptly, then verify. For dependency-free TypeScript scaffolding, write the exact requested files, keep requested APIs/exported helpers in the requested source file, prefer `bun test`, use `test/` unless the user explicitly asks otherwise, avoid uninstalled runners (`tsx`, `vitest`, `jest`), export requested APIs, declare requested package.json `bin` entries that point to executable file paths, never command strings, and fix verification failures and rerun verification after the final edit before final answer. For Bun CLI subprocess tests, preserve `process.env` and derive target paths directly from `import.meta.url`; do not strip PATH/NODE_OPTIONS or compute parent directories twice. After successful edits plus a passing verification command after the final edit, stop and answer immediately with changed files, verification result, and one note naming the requested behavior/constraint satisfied; do not keep exploring or run unrelated checks. Do NOT treat long-file, auth/validation mutation, broad behavior, or no-rewrite edits as tiny.",
    "",
    "### Default recipes",
    "- Branch/diff/project understanding: `chain` with scout → context-builder; context-builder should synthesize scout handoff without extra file reads unless exact line-level behavior is explicitly required.",
    "- Broad/deep project analysis MUST optimize for accuracy, not brevity. Require a Coverage Matrix and Evidence Table before synthesis; every critical surface must be marked covered with evidence, not present with evidence, or unknown/gap.",
    "- If the user asks what a project does in depth but does not explicitly request folder-by-folder fan-out, prefer `chain` with scout → context-builder using `budget: \"deep\"`; it is usually more accurate and faster than a large DAG.",
    "- Reserve `dag` for explicit staged fan-out/fan-in requests, e.g. the user asks to divide analysis by many folders/modules or the repo is clearly too large for one context-builder. Use scout first, parallel context-builder/reviewer/researcher tasks per independent area, then a final reviewer/context-builder synthesis stage. Give deep-analysis children `budget: \"deep\"` and ask them to preserve coverage/evidence, not just compact notes.",
    "- For memory/agent/orchestration repos, include domain-critical surfaces in the route tasks: local/project detection, memory persistence and sync, MCP/tool surface, HTTP/API routes, conflict surfacing, external integrations, UI/dashboard/cloud, and test/eval status.",
    "- Architecture/migration/project-wide refactor strategy: `chain` with scout → planner → reviewer. Explicit named-file refactor implementation is not this category; keep it direct when low-risk and bounded.",
    "- Project-wide review: `chain` with scout → reviewer.",
    "- Complex/risky multi-file implementation or requests that need broad discovery before code changes: use `chain` with scout → planner → worker → reviewer. Bounded scaffolding/greenfield/refactor/bugfix tasks with explicit files and simple acceptance criteria may stay direct to avoid orchestration overhead. In non-interactive print mode, do not convert safe bounded edits into dry-run reports; either edit directly or run a real mesh_route. When staying direct, satisfy each requested code-shape constraint, not just behavior. For TypeScript scaffolds in empty repos, use dependency-free Bun test infrastructure, exact requested paths, and exports in the requested source file instead of inventing external runners, alternate test folders, or moving the API elsewhere.",
    "- Risky long-file or surgical behavior edits, including prompts like 'archivo largo', 'validacion puntual', 'avoid rewrite', or 'no reescribir': MUST use `chain` with scout → planner → worker → reviewer and tell worker to use targeted edit, not full rewrite.",
    "- Alternative comparison with two approaches/options: MUST use plain `parallel` independent planners/reviewers, not `dag`, unless implementation or staged discovery is explicitly required.",
    "- Independent implementation slices: MUST include worker agents. Prefer `dag` with discovery/planning first, a fan-out stage of parallel worker tasks with explicit non-overlapping ownership scopes, then reviewer synthesis. Use plain `parallel` only for pure worker fan-out that needs no prior discovery/review stage.",
    "- Use `dag` when the workflow needs staged fan-out/fan-in, e.g. scout → parallel folder agents → reviewer synthesis.",
    "- Explicit recall: `memory-only`.",
    "- Long autonomous tasks: set `needsArtifacts: true`; subagents should leave compact handoffs, memory candidates, and validation contracts when relevant.",
    "- Tool budgets: each step may set `budget` to `tight`, `normal`, `deep`, or `extended`. Use `deep` for project-wide/folder fan-out analysis. Use `extended` only for a bounded long-running stage with artifacts/checkpoints; otherwise split the work into a DAG instead of inflating one child.",
    "",
    "### Cost, risk, and latency",
    "- Prefer 1 mesh call, 1-3 agents, and short handoffs over repeated orchestration loops.",
    "- Use `low` risk for read-only analysis/planning. Use `medium+` only for mutation, approvals, secrets, destructive actions, or security-sensitive execution.",
    "- Subagents should produce compact handoffs; you own the final answer.",
    "- After a successful mesh run, answer from the handoff in the user language. If `Final answer material` is present, treat it as sufficient and respond now.",
    "- Use `mesh_web_search` only for current external facts, docs, URLs, or explicit web research. It is available globally and to external-context agents; workers should not use it by default.",
    "- Do not send worker agents to browse the web by default.",
    "",
    "### Available pi-chalin agents",
    roster,
  ].join("\n");
}

export function summarizeOrchestrationEvalCases(cases: MeshOrchestrationEvalCase[] = ORCHESTRATION_EVAL_CASES) {
  const meshExpected = cases.filter((testCase) => testCase.expectedDecision === "mesh");
  const directExpected = cases.filter((testCase) => testCase.expectedDecision === "direct");
  const byTopology = new Map<MeshExpectedTopology, number>();
  for (const testCase of cases) byTopology.set(testCase.expectedTopology, (byTopology.get(testCase.expectedTopology) ?? 0) + 1);
  return {
    total: cases.length,
    meshExpected: meshExpected.length,
    directExpected: directExpected.length,
    meshExpectedRate: cases.length === 0 ? 0 : meshExpected.length / cases.length,
    byTopology: Object.fromEntries(byTopology.entries()),
  };
}

function formatAgentForPrompt(agent: AgentDefinition): string {
  const tools = agent.tools.length > 0 ? agent.tools.join(", ") : "none";
  const capabilities = agent.capabilities.length > 0 ? agent.capabilities.join(", ") : "none";
  return `- ${agent.name}: ${agent.description} concern=${agent.concern} thinking=${agent.thinking ?? "inherit"} capabilities=${capabilities} tools=${tools}`;
}
