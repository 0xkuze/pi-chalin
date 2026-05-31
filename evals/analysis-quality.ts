export type AnalysisQualityProfile = "agent-tooling" | "go-service" | "frontend-app" | "monorepo";

export interface AnalysisQualityFact {
  id: string;
  label: string;
  points: number;
  patterns: RegExp[];
}

export interface AnalysisQualityScore {
  profile: AnalysisQualityProfile;
  score: number;
  rawScore: number;
  maxScore: number;
  pass: boolean;
  matchedFacts: string[];
  missingFacts: string[];
  matchedHallucinations: string[];
  hallucinationPenalty: number;
  accuracyPerKb: number;
}

const DEFAULT_PASS_SCORE = 75;

export const ENGRAM_ANALYSIS_FACTS: AnalysisQualityFact[] = [
  fact("purpose-local-first", "local-first memory for AI/coding agents", 9, [/local[- ]first/i, /memor(?:y|ia).{0,80}(agent|AI|IA)/i]),
  fact("sqlite-fts", "SQLite/FTS local source of truth", 9, [/SQLite/i, /\bFTS5?\b/i, /(source of truth|fuente de verdad|autoridad local)/i]),
  fact("store-core", "internal/store as memory core", 7, [/internal\/store/i, /(observations|observaciones)/i, /(dedup|deduplic|topic|relations?|relaciones)/i]),
  fact("mcp-tools", "MCP mem_* tool surface", 8, [/internal\/mcp|MCP/i, /mem_save/i, /mem_search/i, /mem_context/i]),
  fact("http-api", "local HTTP API/routes", 8, [/internal\/server|HTTP|API/i, /\/sessions/i, /\/observations/i, /\/search/i]),
  fact("cli-surface", "CLI command surface", 6, [/cmd\/engram|CLI|comandos?/i, /engram (mcp|serve|tui|save|search|context|sync|cloud|doctor)/i]),
  fact("local-sync", "local Git/chunk sync", 8, [/internal\/sync/i, /\.engram\/manifest\.json|manifest\.json/i, /chunks?\/.*jsonl\.gz|jsonl\.gz|sync local|Git/i]),
  fact("cloud-dashboard", "optional cloud/dashboard replication", 8, [/cloudserver|cloudstore|autosync|remote/i, /dashboard/i, /(Postgres|pgx|replicaci[oó]n|replication|opt[- ]in|opcional)/i]),
  fact("project-detection", "project detection", 6, [/internal\/project/i, /(cwd|git root|remote origin|\.engram\/config\.json|project detection|detecci[oó]n de proyecto)/i]),
  fact("conflict-surfacing", "semantic conflict surfacing", 7, [/conflicts?|conflictos?/i, /(mem_judge|mem_compare|conflicts_with|supersedes|BM25|semantic)/i]),
  fact("obsidian", "Obsidian integration/export", 5, [/internal\/obsidian|plugin\/obsidian|obsidian-export|Obsidian/i]),
  fact("agent-integrations", "agent/plugin integrations", 5, [/plugin\/(claude-code|opencode|pi)|AGENT-SETUP|integraciones?/i, /(Claude|Codex|Gemini|OpenCode|Pi)/i]),
  fact("stack-deps", "technical stack/dependencies", 7, [/Go\s*1\.25|go\.mod|modernc\.org\/sqlite|pgx\/v5|Bubbletea|Lipgloss|templ|HTMX/i]),
  fact("test-status", "test/eval status", 7, [/go test \.\/\.\.\.|tests? (pasa|pass|passes)|paquetes? con tests?|internal\/.*_test/i]),
];

const PROFILE_FACTS: Record<AnalysisQualityProfile, AnalysisQualityFact[]> = {
  "agent-tooling": ENGRAM_ANALYSIS_FACTS,
  "go-service": [
    fact("go-entrypoint", "Go service entrypoint", 14, [/Go/i, /cmd\/api\/main\.go|cmd\/.*main\.go/i]),
    fact("http-routes", "HTTP route surface", 18, [/\/health/i, /\/v1\/auth\/refresh/i, /\/v1\/orders/i]),
    fact("domain-adapters", "domain and adapter split", 16, [/internal\/domain/i, /internal\/http/i, /internal\/postgres/i]),
    fact("postgres-migrations", "Postgres persistence/migrations", 16, [/Postgres|PostgreSQL/i, /migrations\/001_init\.sql|migrations/i]),
    fact("config-env", "runtime configuration", 12, [/DATABASE_URL/i, /JWT_SECRET/i, /\bPORT\b/i]),
    fact("go-tests", "Go test command and behavior", 14, [/go test \.\/\.\.\./i, /(refresh[- ]token|auth).*tests?|tests?.*(refresh[- ]token|auth)/i]),
    fact("risk-signal", "quality/risk insight", 10, [/(refresh[- ]token|auth)/i, /(risk|riesgo|coverage|cobertura|validation|validaci[oó]n)/i]),
  ],
  "frontend-app": [
    fact("vite-react", "Vite React TypeScript stack", 16, [/Vite/i, /React/i, /TypeScript|TS/i]),
    fact("frontend-entrypoints", "frontend entrypoints", 14, [/src\/main\.tsx/i, /src\/App\.tsx/i]),
    fact("routes", "client routes", 16, [/\/login/i, /\/dashboard/i, /\/settings/i]),
    fact("state-api", "state/API module", 16, [/src\/lib\/api\.ts/i, /src\/features\/auth\/useSession\.ts/i]),
    fact("testing", "frontend test stack", 16, [/Vitest/i, /React Testing Library|Testing Library|testing-library/i]),
    fact("scripts", "frontend scripts", 12, [/(?:npm|bun) run dev/i, /(?:npm|bun) run build/i, /(?:npm|bun) run test/i]),
    fact("risk-signal", "frontend risk insight", 10, [/(auth|session|dashboard)/i, /(risk|riesgo|coverage|cobertura|validation|validaci[oó]n)/i]),
  ],
  monorepo: [
    fact("workspace-shape", "workspace structure", 16, [/apps\/web/i, /services\/api/i, /packages\/ui/i]),
    fact("package-manager", "workspace package manager", 12, [/pnpm-workspace\.yaml|pnpm workspace|pnpm/i]),
    fact("web-stack", "web application stack", 14, [/apps\/web/i, /Next\.js|NextJS|React/i]),
    fact("api-stack", "API service stack", 14, [/services\/api/i, /Fastify|Express|Hono|Node/i]),
    fact("shared-package", "shared package/library", 12, [/packages\/ui/i, /(shared|design system|component library|biblioteca)/i]),
    fact("tests", "monorepo test/build commands", 16, [/pnpm test/i, /pnpm build/i, /(affected|workspace|filter)/i]),
    fact("risk-signal", "monorepo integration risk", 16, [/(contract|contrato|shared types|tipos compartidos|API boundary|frontera)/i, /(risk|riesgo|coverage|cobertura|integration|integraci[oó]n)/i]),
  ],
};

const PROFILE_HALLUCINATIONS: Record<AnalysisQualityProfile, Array<{ id: string; penalty: number; pattern: RegExp }>> = {
  "agent-tooling": [
    { id: "react-next-app", penalty: -10, pattern: /\b(React|Next\.js|NextJS)\b/i },
    { id: "mongodb", penalty: -10, pattern: /\bMongoDB\b/i },
    { id: "redis", penalty: -8, pattern: /\bRedis\b/i },
    { id: "kubernetes", penalty: -8, pattern: /\bKubernetes|k8s\b/i },
    { id: "no-tests", penalty: -10, pattern: /\b(no hay|no tiene|no existen|does not have|doesn't have|has no|sin)\s+(tests?|pruebas?)\b/i },
    { id: "node-core", penalty: -8, pattern: /\b(Node\.js|Express|NestJS)\b.{0,80}\b(core|backend principal|main backend)\b/i },
  ],
  "go-service": [
    { id: "frontend-framework", penalty: -10, pattern: /\b(React|Vue|Svelte|Next\.js|Vite)\b/i },
    { id: "mongodb", penalty: -10, pattern: /\bMongoDB\b/i },
    { id: "no-tests", penalty: -10, pattern: /\b(no hay|no tiene|no existen|does not have|doesn't have|has no|sin)\s+(tests?|pruebas?)\b/i },
  ],
  "frontend-app": [
    { id: "go-backend", penalty: -10, pattern: /\bGo service|cmd\/api\/main\.go|Postgres migrations\b/i },
    { id: "mongodb", penalty: -8, pattern: /\bMongoDB\b/i },
    { id: "no-tests", penalty: -10, pattern: /\b(no hay|no tiene|no existen|does not have|doesn't have|has no|sin)\s+(tests?|pruebas?)\b/i },
  ],
  monorepo: [
    { id: "single-service", penalty: -8, pattern: /\b(single service|solo un servicio|only one app)\b/i },
    { id: "go-core", penalty: -8, pattern: /\bGo\b.{0,50}\b(core|principal|main)\b/i },
    { id: "no-tests", penalty: -10, pattern: /\b(no hay|no tiene|no existen|does not have|doesn't have|has no|sin)\s+(tests?|pruebas?)\b/i },
  ],
};

export function getAnalysisFacts(profile: AnalysisQualityProfile = "agent-tooling"): AnalysisQualityFact[] {
  return PROFILE_FACTS[profile];
}

export function scoreAnalysisAnswer(answer: string, options: {
  facts?: AnalysisQualityFact[];
  passScore?: number;
  profile?: AnalysisQualityProfile;
} = {}): AnalysisQualityScore {
  const profile = options.profile ?? "agent-tooling";
  const facts = options.facts ?? getAnalysisFacts(profile);
  const maxScore = facts.reduce((sum, item) => sum + item.points, 0);
  const matchedFacts: string[] = [];
  const missingFacts: string[] = [];
  let rawScore = 0;

  for (const item of facts) {
    if (item.patterns.every((pattern) => pattern.test(answer))) {
      matchedFacts.push(item.id);
      rawScore += item.points;
    } else {
      missingFacts.push(item.id);
    }
  }

  const matchedHallucinations: string[] = [];
  let hallucinationPenalty = 0;
  for (const hallucination of PROFILE_HALLUCINATIONS[profile]) {
    if (hallucination.id === "no-tests" && hasTestEvidence(answer, profile)) continue;
    const match = matchPattern(answer, hallucination.pattern);
    if (match && (hallucination.id === "no-tests" || !isNegatedHallucination(answer, match.index))) {
      matchedHallucinations.push(hallucination.id);
      hallucinationPenalty += hallucination.penalty;
    }
  }

  const score = clamp(rawScore + hallucinationPenalty, 0, maxScore);
  const answerKb = Math.max(answer.length / 1024, 1);
  const normalizedScore = Math.round((score / maxScore) * 100);
  return {
    profile,
    score: normalizedScore,
    rawScore: score,
    maxScore,
    pass: normalizedScore >= (options.passScore ?? DEFAULT_PASS_SCORE) && matchedHallucinations.length === 0,
    matchedFacts,
    missingFacts,
    matchedHallucinations,
    hallucinationPenalty,
    accuracyPerKb: Math.round((normalizedScore / answerKb) * 100) / 100,
  };
}

function fact(id: string, label: string, points: number, patterns: RegExp[]): AnalysisQualityFact {
  return { id, label, points, patterns };
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function hasTestEvidence(answer: string, profile: AnalysisQualityProfile): boolean {
  const profileEvidence: Record<AnalysisQualityProfile, RegExp[]> = {
    "agent-tooling": [/go test \.\/\.\.\./i, /_test\.go/i, /internal\/.*test/i],
    "go-service": [/go test \.\/\.\.\./i, /_test\.go/i, /routes_test\.go/i],
    "frontend-app": [/Vitest/i, /React Testing Library|Testing Library|testing-library/i, /\.test\.tsx/i, /(?:npm|bun) run test/i],
    monorepo: [/pnpm test/i, /pnpm -r test/i, /Vitest/i, /\.test\.(ts|tsx|js|jsx)/i],
  };
  return profileEvidence[profile].some((pattern) => pattern.test(answer));
}

function matchPattern(answer: string, pattern: RegExp): RegExpExecArray | null {
  pattern.lastIndex = 0;
  return pattern.exec(answer);
}

function isNegatedHallucination(answer: string, matchIndex: number): boolean {
  const prefix = answer.slice(Math.max(0, matchIndex - 72), matchIndex).toLowerCase();
  return /(?:\bno\b|\bnot\b|\bwithout\b|\bsin\b|does(?:\s+not|n't)|has\s+no)\s+(?:usa|use|using|utiliza|incluye|include|have|has|es|is|hay|tiene|stack|core|principal|backend|app|aplicaci[oó]n|framework|db|database|base)?[\s:;,/.-]*$/.test(prefix);
}
