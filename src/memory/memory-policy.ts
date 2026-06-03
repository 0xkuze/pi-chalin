import { isTransientVerificationStateClaim } from "../observability/evidence-claims.ts";
import type { MemoryCandidate, MemoryRecord } from "../domain/schemas.ts";

export function dedupeCandidates(candidates: MemoryCandidate[]): MemoryCandidate[] {
  const result: MemoryCandidate[] = [];
  for (const candidate of candidates) {
    const normalized = normalizeForDedupe(candidate.content);
    if (!normalized || result.some((existing) => isDuplicateMemoryContent(existing.content, candidate.content))) continue;
    result.push({ ...candidate, content: normalizeContent(candidate.content) });
  }
  return result;
}

export function dedupeRecords(records: MemoryRecord[]): MemoryRecord[] {
  const result: MemoryRecord[] = [];
  for (const record of records) {
    if (result.some((existing) => isDuplicateMemoryContent(existing.content, record.content))) continue;
    result.push(record);
  }
  return result;
}

export function sortMemoryRecords(records: MemoryRecord[]): MemoryRecord[] {
  const rank: Record<MemoryRecord["status"], number> = { pending: 0, quarantined: 1, active: 2, stale: 3, superseded: 4, rejected: 5 };
  return records.sort((a, b) => rank[a.status] - rank[b.status] || b.createdAt.localeCompare(a.createdAt));
}

export function applyCurrentPolicy(record: MemoryRecord): MemoryRecord | undefined {
  const assessment = assessMemoryCandidate(record);
  if (assessment.status === "rejected") return undefined;
  if (record.status === "rejected") return undefined;
  if (record.status === "active" && assessment.status === "pending") return { ...record, status: "pending", importance: assessment.importance, trigger: assessment.trigger };
  return { ...record, importance: record.importance || assessment.importance, trigger: record.trigger || assessment.trigger, topicKey: record.topicKey ?? assessment.topicKey };
}

export function normalizeContent(content: string): string {
  return content.replace(/\s+/g, " ").trim();
}

export function normalizeForDedupe(content: string): string {
  return normalizeContent(content)
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[`'".,;:!?()[\]{}]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function buildFtsQuery(query: string): string {
  const terms = tokenizeSearchTerms(query.toLowerCase());
  return terms.map((term) => `"${term.replaceAll('"', '""')}"`).join(" OR ");
}

export function stableHash(input: string): string {
  let hash = 5381;
  for (let index = 0; index < input.length; index++) hash = (hash * 33) ^ input.charCodeAt(index);
  return (hash >>> 0).toString(16);
}

export function buildMemoryRecord(candidate: MemoryCandidate, now: string): MemoryRecord {
  const content = normalizeContent(candidate.content);
  const assessment = assessMemoryCandidate({ ...candidate, content });
  return {
    ...candidate,
    content,
    category: candidate.category.toLowerCase(),
    status: assessment.status,
    ...(assessment.status !== "pending" ? { reviewedAt: now } : {}),
    ...(assessment.topicKey ? { topicKey: assessment.topicKey } : {}),
    importance: assessment.importance,
    trigger: assessment.trigger,
    lastSeenAt: now,
    duplicateCount: 1,
    revisionCount: 1,
    updatedAt: now,
    useCount: 0,
    utilityScore: assessment.importance * 0.5,
    tokenCostEstimate: estimateTokens(content),
  };
}

export function findMemoryUpdateTarget(record: MemoryRecord, records: MemoryRecord[]): MemoryRecord | undefined {
  const exact = records.find((existing) => normalizeForDedupe(existing.content) === normalizeForDedupe(record.content));
  if (exact) return exact;
  if (record.topicKey) {
    const sameTopic = records.find((existing) => existing.topicKey === record.topicKey);
    if (sameTopic) return sameTopic;
  }
  return records.find((existing) => isDuplicateMemoryContent(existing.content, record.content));
}

export function mergeMemoryRecord(existing: MemoryRecord, incoming: MemoryRecord, now: string): MemoryRecord {
  const exact = normalizeForDedupe(existing.content) === normalizeForDedupe(incoming.content);
  if (exact) {
    return {
      ...existing,
      confidence: Math.max(existing.confidence, incoming.confidence),
      evidence: mergeEvidence(existing.evidence, incoming.evidence),
      lastSeenAt: now,
      duplicateCount: existing.duplicateCount + 1,
      updatedAt: now,
      utilityScore: Math.min(1, Math.max(existing.utilityScore ?? 0, incoming.utilityScore ?? 0) + 0.02),
    };
  }
  const status = existing.status === "pending" || incoming.status === "pending" ? "pending" : incoming.status;
  return {
    ...existing,
    category: incoming.category,
    content: incoming.content,
    sourceAgent: incoming.sourceAgent,
    confidence: Math.max(existing.confidence, incoming.confidence),
    evidence: mergeEvidence(existing.evidence, incoming.evidence),
    status,
    reviewedAt: status === "pending" ? existing.reviewedAt : now,
    topicKey: incoming.topicKey ?? existing.topicKey,
    importance: Math.max(existing.importance, incoming.importance),
    trigger: incoming.trigger,
    lastSeenAt: now,
    updatedAt: now,
    tokenCostEstimate: estimateTokens(incoming.content),
    utilityScore: Math.min(1, Math.max(existing.utilityScore ?? 0, incoming.utilityScore ?? 0) + 0.04),
    duplicateCount: existing.duplicateCount,
    revisionCount: existing.revisionCount + 1,
  };
}

export function mergeEvidence(a: string | undefined, b: string | undefined): string | undefined {
  if (!a) return b;
  if (!b || a.includes(b)) return a;
  return `${a}; ${b}`.slice(0, 400);
}

export function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}

function isDuplicateMemoryContent(a: string, b: string): boolean {
  const normalizedA = normalizeForDedupe(a);
  const normalizedB = normalizeForDedupe(b);
  if (!normalizedA || !normalizedB) return false;
  if (normalizedA === normalizedB) return true;
  const tokensA = memoryTokens(normalizedA);
  const tokensB = memoryTokens(normalizedB);
  if (tokensA.size < 5 || tokensB.size < 5) return false;
  const score = jaccard(tokensA, tokensB);
  if (score >= 0.42) return true;
  const entitiesA = memoryEntities(normalizedA);
  const entitiesB = memoryEntities(normalizedB);
  const sharedEntities = [...entitiesA].filter((entity) => entitiesB.has(entity));
  if (sharedEntities.length >= 2 && score >= 0.25) return true;
  if (sharedEntities.some((entity) => isStrongMemoryEntity(entity)) && score >= 0.2) return true;
  return false;
}

function memoryTokens(normalized: string): Set<string> {
  const stop = new Set([
    "the", "and", "for", "that", "this", "with", "from", "into", "using", "uses", "use", "under", "through", "when", "where", "should",
    "este", "esta", "esto", "para", "que", "con", "por", "desde", "hacia", "como", "usa", "usar", "usando", "debe", "deben", "del", "las", "los", "una", "uno", "mas", "más",
    "project", "proyecto", "pi", "chalin", "pi-chalin", "coding", "agent",
  ]);
  return new Set(splitWhitespace(normalized).map(canonicalMemoryToken).filter((token) => token.length >= 3 && !stop.has(token)));
}

function canonicalMemoryToken(token: string): string {
  const aliases: Record<string, string> = {
    extension: "extension",
    extensionpackage: "extension",
    paqueteextension: "extension",
    extensiones: "extension",
    extensiontypescript: "extension",
    routing: "routing",
    routed: "routing",
    routes: "routing",
    route: "routing",
    enruta: "routing",
    rutea: "routing",
    convierte: "routing",
    prompts: "prompt",
    normales: "normal",
    normal: "normal",
    subagent: "subagent",
    subagents: "subagent",
    subagente: "subagent",
    subagentes: "subagent",
    memoria: "memory",
    memory: "memory",
    memorias: "memory",
    agentes: "agent",
    agents: "agent",
    agente: "agent",
    especializado: "specialized",
    especializados: "specialized",
    specialized: "specialized",
    workflows: "workflow",
    workflow: "workflow",
    automatico: "automatic",
    automatic: "automatic",
    principal: "main",
    main: "main",
    entrypoint: "entrypoint",
    entrada: "entrypoint",
    arquitectura: "architecture",
    architecture: "architecture",
    tests: "test",
    testing: "test",
    test: "test",
    pruebas: "test",
    prueba: "test",
    settimeout: "settimeout",
    timers: "timer",
    vitest: "vitest",
    node: "node",
    checkpoints: "checkpoint",
    checkpoint: "checkpoint",
    handoffs: "handoff",
    handoff: "handoff",
    resume: "resume",
    resumable: "resume",
    continuation: "resume",
    validation: "validation",
    validations: "validation",
    contract: "contract",
    contracts: "contract",
  };
  return aliases[token] ?? token;
}

function splitWhitespace(text: string): string[] {
  const tokens: string[] = [];
  let start: number | undefined;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    const whitespace = char === " " || char === "\t" || char === "\n" || char === "\r";
    if (whitespace) {
      if (start !== undefined) tokens.push(text.slice(start, index));
      start = undefined;
    } else if (start === undefined) {
      start = index;
    }
  }
  if (start !== undefined) tokens.push(text.slice(start));
  return tokens;
}

function trimEntityToken(token: string): string {
  let start = 0;
  let end = token.length;
  while (start < end && "`'\"([{<".includes(token[start] ?? "")) start += 1;
  while (end > start && "`'\".,:;!?)]}>".includes(token[end - 1] ?? "")) end -= 1;
  return token.slice(start, end);
}

function isPathLikeMemoryEntity(entity: string): boolean {
  if (!entity) return false;
  if (entity.includes("/")) {
    const parts = entity.split("/");
    return parts.length >= 2 && parts.every((part) => part.length > 0);
  }
  return hasMemoryFileExtension(entity);
}

function hasMemoryFileExtension(entity: string): boolean {
  const lower = entity.toLowerCase();
  return [".ts", ".tsx", ".js", ".jsx", ".json", ".md", ".sqlite"].some((extension) => lower.endsWith(extension));
}

function memoryEntities(normalized: string): Set<string> {
  const entities = new Set<string>();
  for (const token of splitWhitespace(normalized)) {
    const entity = trimEntityToken(token);
    if (isPathLikeMemoryEntity(entity)) entities.add(entity);
  }
  for (const token of ["chalinkernel", "agentcatalog", "memorystore", "typescript", "sqlite", "fts5", "tui", "sdk", "vitest", "node:test"]) {
    if (normalized.includes(token)) entities.add(token);
  }
  return entities;
}

function isStrongMemoryEntity(entity: string): boolean {
  return entity.includes("/") || hasMemoryFileExtension(entity) || ["chalinkernel", "agentcatalog", "memorystore", "sqlite", "fts5", "vitest", "node:test"].includes(entity);
}

function jaccard(a: Set<string>, b: Set<string>): number {
  let intersection = 0;
  for (const token of a) if (b.has(token)) intersection++;
  return intersection / (a.size + b.size - intersection);
}

function countLongWords(text: string): number {
  let count = 0;
  let length = 0;
  for (let index = 0; index <= text.length; index += 1) {
    const char = text[index] ?? " ";
    if (isLetter(char)) {
      length += 1;
      continue;
    }
    if (length >= 3) count += 1;
    length = 0;
  }
  return count;
}

function isLetter(char: string): boolean {
  if (!char) return false;
  return char.toLocaleLowerCase() !== char.toLocaleUpperCase();
}

function startsWithCodeLikePrefix(text: string): boolean {
  const normalized = text.trimStart().toLowerCase();
  return ["cmd", "env", "try", "except", "print", "return", "const", "let", "var", "import", "export", "function", "class", "if", "else", "for", "while", "sys.", "p =", "#"].some((prefix) => normalized.startsWith(prefix));
}

function containsAnyInsensitive(text: string, needles: string[]): boolean {
  const lower = text.toLowerCase();
  return needles.some((needle) => lower.includes(needle.toLowerCase()));
}

function containsCompletedStepNoise(text: string): boolean {
  const lower = text.toLowerCase();
  return lower.includes("completed a ") && lower.includes(" step for");
}

function countChars(text: string, chars: Set<string>): number {
  let count = 0;
  for (const char of text) if (chars.has(char)) count += 1;
  return count;
}

function tokenizeSearchTerms(text: string): string[] {
  const terms: string[] = [];
  let current = "";
  for (const char of text) {
    if (isSearchTermChar(char)) {
      current += char;
      continue;
    }
    if (current) {
      terms.push(current);
      current = "";
    }
  }
  if (current) terms.push(current);
  return terms;
}

function isSearchTermChar(char: string): boolean {
  return char === "_" || char === "-" || isLetter(char) || (char >= "0" && char <= "9");
}

function isUsefulMemoryContent(content: string): boolean {
  const normalized = normalizeContent(content);
  if (normalized.length < 48 || normalized.length > 600) return false;
  if (countLongWords(normalized) < 6) return false;
  if (startsWithCodeLikePrefix(normalized)) return false;
  if (containsAnyInsensitive(normalized, ["subprocess", "os.environ", "PI_OFFLINE", "stdout", "stderr", "returncode", "TimeoutExpired", "sys.exit", "traceback", "stack trace"])) return false;
  if (containsAnyInsensitive(normalized, ["mock handoff", "previous handoff", "task:"])) return false;
  if (containsCompletedStepNoise(normalized)) return false;
  if (isTransientVerificationStateClaim(normalized)) return false;
  const codePunctuation = countChars(normalized, new Set(["=", ";", "{", "}", "(", ")", "[", "]"]));
  if (codePunctuation >= 4) return false;
  return true;
}

function assessMemoryCandidate(candidate: MemoryCandidate): { status: MemoryRecord["status"]; importance: number; trigger: string; topicKey?: string } {
  const category = candidate.category.toLowerCase();
  const topicKey = candidate.topicKey ?? genericTopicKey(category, candidate.content);
  if (!isUsefulMemoryContent(candidate.content)) return { status: "rejected", importance: 0, trigger: "noise-rejected", topicKey };
  if (candidate.confidence < 0.35) return { status: "rejected", importance: 0.1, trigger: "low-confidence", topicKey };
  if (["decision", "preference", "security", "safety", "architecture", "agent-note"].includes(category)) {
    return { status: "pending", importance: importanceForCategory(category), trigger: triggerForCategory(category), topicKey };
  }
  if (candidate.confidence < 0.85) return { status: "pending", importance: importanceForCategory(category), trigger: "needs-confidence-review", topicKey };
  return { status: "active", importance: importanceForCategory(category), trigger: triggerForCategory(category), topicKey };
}

function importanceForCategory(category: string): number {
  if (["security", "safety", "decision", "architecture"].includes(category)) return 0.95;
  if (["workflow", "testing", "tooling", "pattern", "failure", "bugfix"].includes(category)) return 0.8;
  if (category === "project-fact") return 0.7;
  return 0.55;
}

function triggerForCategory(category: string): string {
  const triggers: Record<string, string> = {
    "project-fact": "project-fact",
    pattern: "pattern-learning",
    tooling: "tooling-learning",
    testing: "testing-learning",
    workflow: "workflow-learning",
    bugfix: "bugfix-learning",
    failure: "failure-learning",
    decision: "decision-review",
    preference: "preference-review",
    architecture: "architecture-review",
    safety: "safety-review",
    security: "security-review",
    "agent-note": "manual-review",
  };
  return triggers[category] ?? "project-learning";
}

function genericTopicKey(category: string, content: string): string | undefined {
  const tokens = [...memoryTokens(normalizeForDedupe(content))].slice(0, 5);
  if (tokens.length < 3) return undefined;
  return `${category}:${tokens.join("-")}`;
}
