import * as fs from "node:fs";
import * as path from "node:path";
import initSqlJs from "sql.js-fts5/dist/sql-asm.js";
import { resolveMeshPaths, type MeshPathsOptions } from "./paths.ts";
import type { MemoryCandidate, MemoryRecord } from "./schemas.ts";

export interface MemorySearchResult {
  record: MemoryRecord;
  score: number;
  highlights: string[];
}

type SqlJsStatic = any;
type SqlJsDatabase = any;

let sqlModulePromise: Promise<SqlJsStatic> | undefined;

export class MemoryStore {
  private readonly dbPath: string;

  constructor(options: MeshPathsOptions) {
    this.dbPath = path.join(resolveMeshPaths(options).projectRoot, ".pi-chalin", "memory.sqlite");
  }

  async submitCandidates(candidates: MemoryCandidate[]): Promise<MemoryRecord[]> {
    const now = new Date().toISOString();
    const records = dedupeCandidates(candidates).map((candidate) => buildMemoryRecord(candidate, now));

    await this.withDb(true, (db) => {
      const existingRecords = selectRows(db, "SELECT * FROM memory_records ORDER BY createdAt DESC")
        .map(rowToRecord)
        .map(applyCurrentPolicy)
        .filter((record): record is MemoryRecord => Boolean(record));
      const accepted = [...existingRecords];
      try {
        for (const record of records) {
          if (record.status === "rejected") continue;
          const target = findMemoryUpdateTarget(record, accepted);
          const next = target ? mergeMemoryRecord(target, record, now) : record;
          upsertMemoryRecord(db, next);
          const index = accepted.findIndex((item) => item.id === next.id);
          if (index >= 0) accepted[index] = next;
          else accepted.push(next);
        }
      } finally {
        // Prepared statements live inside upsertMemoryRecord to keep mutation paths simple and atomic per record.
      }
    });

    return records;
  }

  async list(status?: MemoryRecord["status"]): Promise<MemoryRecord[]> {
    return this.withDb(false, (db) => {
      const rows = selectRows(
        db,
        status ? "SELECT * FROM memory_records WHERE status = ? ORDER BY createdAt DESC" : "SELECT * FROM memory_records ORDER BY createdAt DESC",
        status ? [status] : [],
      );
      return sortMemoryRecords(dedupeRecords(rows.map(rowToRecord).map(applyCurrentPolicy).filter((record): record is MemoryRecord => Boolean(record))));
    });
  }

  async pendingCount(): Promise<number> {
    return (await this.list("pending")).length;
  }

  async approve(id: string): Promise<MemoryRecord | undefined> {
    const record = await this.updateStatus(id, "active");
    if (record) {
      await this.withDb(true, (db) => {
        db.run("DELETE FROM memory_fts WHERE id = ?", [record.id]);
        db.run("INSERT INTO memory_fts (id, category, content, evidence, sourceAgent) VALUES (?, ?, ?, ?, ?)", [record.id, record.category, record.content, record.evidence ?? "", record.sourceAgent]);
      });
    }
    return record;
  }

  async reject(id: string): Promise<MemoryRecord | undefined> {
    const record = await this.updateStatus(id, "rejected");
    if (record) await this.withDb(true, (db) => db.run("DELETE FROM memory_fts WHERE id = ?", [id]));
    return record;
  }

  async delete(id: string): Promise<boolean> {
    const before = await this.rawCount();
    await this.withDb(true, (db) => {
      db.run("DELETE FROM memory_fts WHERE id = ?", [id]);
      db.run("DELETE FROM memory_records WHERE id = ?", [id]);
    });
    const after = await this.rawCount();
    return after < before;
  }

  async search(query: string, limit = 10): Promise<MemorySearchResult[]> {
    const ftsQuery = buildFtsQuery(query);
    if (!ftsQuery) return [];

    return this.withDb(false, (db) => {
      const rows = selectRows(
        db,
        `SELECT r.*, bm25(memory_fts) AS score
         FROM memory_fts
         JOIN memory_records r ON r.id = memory_fts.id
         WHERE memory_fts MATCH ?
         ORDER BY score ASC, r.createdAt DESC
         LIMIT ?`,
        [ftsQuery, Math.max(limit * 3, limit)],
      );
      return rows
        .map((row) => {
          const record = applyCurrentPolicy(rowToRecord(row));
          return record ? { record, score: Math.abs(Number(row.score ?? 0)), highlights: [String(row.content ?? "").slice(0, 180)] } : undefined;
        })
        .filter((result): result is MemorySearchResult => result !== undefined)
        .filter((result) => result.record.status === "active")
        .slice(0, limit);
    });
  }

  private async rawCount(): Promise<number> {
    return this.withDb(false, (db) => Number(selectRows(db, "SELECT COUNT(*) AS count FROM memory_records")[0]?.count ?? 0));
  }

  private async updateStatus(id: string, status: MemoryRecord["status"]): Promise<MemoryRecord | undefined> {
    const reviewedAt = new Date().toISOString();
    await this.withDb(true, (db) => db.run("UPDATE memory_records SET status = ?, reviewedAt = ? WHERE id = ?", [status, reviewedAt, id]));
    return this.withDb(false, (db) => selectRows(db, "SELECT * FROM memory_records WHERE id = ?", [id]).map(rowToRecord)[0]);
  }

  private async withDb<T>(write: boolean, fn: (db: SqlJsDatabase) => T): Promise<T> {
    fs.mkdirSync(path.dirname(this.dbPath), { recursive: true });
    const SQL = await getSqlModule();
    const db = fs.existsSync(this.dbPath) ? new SQL.Database(fs.readFileSync(this.dbPath)) : new SQL.Database();
    try {
      migrate(db);
      const result = fn(db);
      if (write) fs.writeFileSync(this.dbPath, Buffer.from(db.export()));
      return result;
    } finally {
      db.close();
    }
  }
}

export function createMemoryCandidate(input: Omit<MemoryCandidate, "id" | "createdAt"> & { id?: string; createdAt?: string }): MemoryCandidate {
  const createdAt = input.createdAt ?? new Date().toISOString();
  const content = normalizeContent(input.content);
  return {
    ...input,
    content,
    id: input.id ?? `memory-${stableHash(normalizeForDedupe(content))}`,
    createdAt,
  };
}

async function getSqlModule(): Promise<SqlJsStatic> {
  sqlModulePromise ??= initSqlJs();
  return sqlModulePromise;
}

function migrate(db: SqlJsDatabase): void {
  db.run(`
    CREATE TABLE IF NOT EXISTS memory_records (
      id TEXT PRIMARY KEY,
      category TEXT NOT NULL,
      content TEXT NOT NULL,
      sourceAgent TEXT NOT NULL,
      confidence REAL NOT NULL,
      evidence TEXT,
      scope TEXT NOT NULL,
      createdAt TEXT NOT NULL,
      status TEXT NOT NULL,
      reviewedAt TEXT,
      topicKey TEXT,
      importance REAL NOT NULL DEFAULT 0,
      trigger TEXT NOT NULL DEFAULT 'unknown',
      lastSeenAt TEXT,
      duplicateCount INTEGER NOT NULL DEFAULT 1,
      revisionCount INTEGER NOT NULL DEFAULT 1
    );
    CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(
      id UNINDEXED,
      category,
      content,
      evidence,
      sourceAgent
    );
  `);
  addColumnIfMissing(db, "memory_records", "topicKey", "TEXT");
  addColumnIfMissing(db, "memory_records", "importance", "REAL NOT NULL DEFAULT 0");
  addColumnIfMissing(db, "memory_records", "trigger", "TEXT NOT NULL DEFAULT 'unknown'");
  addColumnIfMissing(db, "memory_records", "lastSeenAt", "TEXT");
  addColumnIfMissing(db, "memory_records", "duplicateCount", "INTEGER NOT NULL DEFAULT 1");
  addColumnIfMissing(db, "memory_records", "revisionCount", "INTEGER NOT NULL DEFAULT 1");
}

function addColumnIfMissing(db: SqlJsDatabase, table: string, column: string, definition: string): void {
  const columns = selectRows(db, `PRAGMA table_info(${table})`).map((row) => String(row.name));
  if (!columns.includes(column)) db.run(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

function selectRows(db: SqlJsDatabase, sql: string, params: unknown[] = []): Array<Record<string, unknown>> {
  const stmt = db.prepare(sql);
  const rows: Array<Record<string, unknown>> = [];
  try {
    stmt.bind(params);
    while (stmt.step()) rows.push(stmt.getAsObject() as Record<string, unknown>);
  } finally {
    stmt.free();
  }
  return rows;
}

function dedupeCandidates(candidates: MemoryCandidate[]): MemoryCandidate[] {
  const result: MemoryCandidate[] = [];
  for (const candidate of candidates) {
    const normalized = normalizeForDedupe(candidate.content);
    if (!normalized || result.some((existing) => isDuplicateMemoryContent(existing.content, candidate.content))) continue;
    result.push({ ...candidate, content: normalizeContent(candidate.content) });
  }
  return result;
}


function dedupeRecords(records: MemoryRecord[]): MemoryRecord[] {
  const result: MemoryRecord[] = [];
  for (const record of records) {
    if (result.some((existing) => isDuplicateMemoryContent(existing.content, record.content))) continue;
    result.push(record);
  }
  return result;
}

function sortMemoryRecords(records: MemoryRecord[]): MemoryRecord[] {
  const rank: Record<MemoryRecord["status"], number> = { pending: 0, active: 1, rejected: 2 };
  return records.sort((a, b) => rank[a.status] - rank[b.status] || b.createdAt.localeCompare(a.createdAt));
}

function applyCurrentPolicy(record: MemoryRecord): MemoryRecord | undefined {
  const assessment = assessMemoryCandidate(record);
  if (assessment.status === "rejected") return undefined;
  if (record.status === "rejected") return undefined;
  if (record.status === "active" && assessment.status === "pending") return { ...record, status: "pending", importance: assessment.importance, trigger: assessment.trigger };
  return { ...record, importance: record.importance || assessment.importance, trigger: record.trigger || assessment.trigger, topicKey: record.topicKey ?? assessment.topicKey };
}

function normalizeContent(content: string): string {
  return content.replace(/\s+/g, " ").trim();
}

function normalizeForDedupe(content: string): string {
  return normalizeContent(content)
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[`'".,;:!?()[\]{}]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function isDuplicateMemoryContent(a: string, b: string): boolean {
  const normalizedA = normalizeForDedupe(a);
  const normalizedB = normalizeForDedupe(b);
  if (!normalizedA || !normalizedB) return false;
  if (normalizedA === normalizedB) return true;
  const topicA = memoryTopicKey(normalizedA);
  const topicB = memoryTopicKey(normalizedB);
  if (topicA && topicA === topicB) return true;
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

function memoryTopicKey(normalized: string): string | undefined {
  const tokens = memoryTokens(normalized);
  if (tokens.has("bun") && tokens.has("test") && tokens.has("settimeout")) return "testing:bun-no-settimeout";
  if ((tokens.has("nodetest") || normalized.includes("node:test")) && tokens.has("test")) return "testing:node-test";
  if (tokens.has("checkpoint") && (tokens.has("handoff") || tokens.has("resume"))) return "workflow:handoff-checkpoints";
  if (tokens.has("validation") && tokens.has("contract")) return "workflow:validation-contracts";
  const has = (...items: string[]) => items.every((item) => tokens.has(item) || normalized.includes(item));
  if (has("extension", "routing", "subagent")) return "extension-routing-subagents";
  if (normalized.includes("memory.sqlite") || (has("memory") && (tokens.has("sqlite") || tokens.has("fts5") || normalized.includes("sql.js-fts5")))) return "memory-store";
  if ((normalized.includes("agents/") || normalized.includes("agents*.md") || normalized.includes("agents/*.md")) && has("agent")) return "agent-catalog";
  if (normalized.includes(".pi-chalin/runs") || normalized.includes("runs/<id>.json") || normalized.includes("runs/*.json")) return "run-persistence";
  if (normalized.includes("src/commands.ts") || normalized.includes("/mesh")) return "mesh-commands";
  if (normalized.includes("src/index.ts")) return "runtime-entrypoint";
  if (normalized.includes("src/kernel.ts") || tokens.has("meshkernel")) return "kernel-routing";
  if (tokens.has("architecture") || tokens.has("monolith") || tokens.has("monolito")) return "architecture";
  if (tokens.has("tui") && (tokens.has("modelos") || tokens.has("models") || tokens.has("rutas") || tokens.has("memory"))) return "tui-surface";
  return undefined;
}

function memoryTokens(normalized: string): Set<string> {
  const stop = new Set([
    "the", "and", "for", "that", "this", "with", "from", "into", "using", "uses", "use", "under", "through", "when", "where", "should",
    "este", "esta", "esto", "para", "que", "con", "por", "desde", "hacia", "como", "usa", "usar", "usando", "debe", "deben", "del", "las", "los", "una", "uno", "mas", "más",
    "project", "proyecto", "pi", "mesh", "pi-chalin", "coding", "agent",
  ]);
  return new Set(normalized.split(/\s+/).map(canonicalMemoryToken).filter((token) => token.length >= 3 && !stop.has(token)));
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
    bun: "bun",
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

function memoryEntities(normalized: string): Set<string> {
  const entities = new Set<string>();
  for (const match of normalized.matchAll(/[\w.-]+\/[\w./-]+|[\w.-]+\.(?:ts|tsx|js|jsx|json|md|sqlite)/g)) entities.add(match[0]);
  for (const token of ["meshkernel", "agentcatalog", "memorystore", "typescript", "sqlite", "fts5", "tui", "sdk", "bun", "node:test"]) {
    if (normalized.includes(token)) entities.add(token);
  }
  return entities;
}

function isStrongMemoryEntity(entity: string): boolean {
  return entity.includes("/") || /\.(?:ts|tsx|js|jsx|json|md|sqlite)$/.test(entity) || ["meshkernel", "agentcatalog", "memorystore", "sqlite", "fts5", "bun", "node:test"].includes(entity);
}

function jaccard(a: Set<string>, b: Set<string>): number {
  let intersection = 0;
  for (const token of a) if (b.has(token)) intersection++;
  return intersection / (a.size + b.size - intersection);
}

function isUsefulMemoryContent(content: string): boolean {
  const normalized = normalizeContent(content);
  if (normalized.length < 48 || normalized.length > 600) return false;
  if ((normalized.match(/[A-Za-zÁÉÍÓÚÜÑáéíóúüñ]{3,}/g) ?? []).length < 6) return false;
  if (/^(cmd|env|try|except|print|return|const|let|var|import|export|function|class|if|else|for|while|sys\.|p\s*=|#)/i.test(normalized)) return false;
  if (/\b(subprocess|os\.environ|PI_OFFLINE|stdout|stderr|returncode|TimeoutExpired|sys\.exit|traceback|stack trace)\b/i.test(normalized)) return false;
  if (/\b(completed a .* step for|mock handoff|previous handoff|task:)\b/i.test(normalized)) return false;
  const codePunctuation = (normalized.match(/[=;{}()[\]]/g) ?? []).length;
  if (codePunctuation >= 4) return false;
  return true;
}


function assessMemoryCandidate(candidate: MemoryCandidate): { status: MemoryRecord["status"]; importance: number; trigger: string; topicKey?: string } {
  const category = candidate.category.toLowerCase();
  const topicKey = candidate.topicKey ?? memoryTopicKey(normalizeForDedupe(candidate.content)) ?? genericTopicKey(category, candidate.content);
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

function buildFtsQuery(query: string): string {
  const terms = query.toLowerCase().match(/[\p{L}\p{N}_-]+/gu) ?? [];
  return terms.map((term) => `"${term.replaceAll('"', '""')}"`).join(" OR ");
}

function stableHash(input: string): string {
  let hash = 5381;
  for (let index = 0; index < input.length; index++) hash = (hash * 33) ^ input.charCodeAt(index);
  return (hash >>> 0).toString(16);
}

function rowToRecord(row: Record<string, unknown>): MemoryRecord {
  const createdAt = String(row.createdAt);
  return {
    id: String(row.id),
    category: String(row.category),
    content: String(row.content),
    sourceAgent: String(row.sourceAgent),
    confidence: Number(row.confidence),
    ...(row.evidence ? { evidence: String(row.evidence) } : {}),
    scope: row.scope === "user" ? "user" : "project",
    createdAt,
    status: row.status === "rejected" ? "rejected" : row.status === "pending" ? "pending" : "active",
    ...(row.reviewedAt ? { reviewedAt: String(row.reviewedAt) } : {}),
    ...(row.topicKey ? { topicKey: String(row.topicKey) } : {}),
    importance: Number(row.importance ?? 0),
    trigger: String(row.trigger ?? "unknown"),
    lastSeenAt: row.lastSeenAt ? String(row.lastSeenAt) : createdAt,
    duplicateCount: Number(row.duplicateCount ?? 1),
    revisionCount: Number(row.revisionCount ?? 1),
  };
}

function buildMemoryRecord(candidate: MemoryCandidate, now: string): MemoryRecord {
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
  };
}

function findMemoryUpdateTarget(record: MemoryRecord, records: MemoryRecord[]): MemoryRecord | undefined {
  const exact = records.find((existing) => normalizeForDedupe(existing.content) === normalizeForDedupe(record.content));
  if (exact) return exact;
  if (record.topicKey) {
    const sameTopic = records.find((existing) => existing.topicKey === record.topicKey);
    if (sameTopic) return sameTopic;
  }
  return records.find((existing) => isDuplicateMemoryContent(existing.content, record.content));
}

function mergeMemoryRecord(existing: MemoryRecord, incoming: MemoryRecord, now: string): MemoryRecord {
  const exact = normalizeForDedupe(existing.content) === normalizeForDedupe(incoming.content);
  if (exact) {
    return {
      ...existing,
      confidence: Math.max(existing.confidence, incoming.confidence),
      evidence: mergeEvidence(existing.evidence, incoming.evidence),
      lastSeenAt: now,
      duplicateCount: existing.duplicateCount + 1,
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
    duplicateCount: existing.duplicateCount,
    revisionCount: existing.revisionCount + 1,
  };
}

function mergeEvidence(a: string | undefined, b: string | undefined): string | undefined {
  if (!a) return b;
  if (!b || a.includes(b)) return a;
  return `${a}; ${b}`.slice(0, 400);
}

function upsertMemoryRecord(db: SqlJsDatabase, record: MemoryRecord): void {
  const upsert = db.prepare(`
    INSERT INTO memory_records (id, category, content, sourceAgent, confidence, evidence, scope, createdAt, status, reviewedAt, topicKey, importance, trigger, lastSeenAt, duplicateCount, revisionCount)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      category=excluded.category,
      content=excluded.content,
      sourceAgent=excluded.sourceAgent,
      confidence=excluded.confidence,
      evidence=excluded.evidence,
      scope=excluded.scope,
      status=excluded.status,
      reviewedAt=excluded.reviewedAt,
      topicKey=excluded.topicKey,
      importance=excluded.importance,
      trigger=excluded.trigger,
      lastSeenAt=excluded.lastSeenAt,
      duplicateCount=excluded.duplicateCount,
      revisionCount=excluded.revisionCount
  `);
  const deleteFts = db.prepare("DELETE FROM memory_fts WHERE id = ?");
  const insertFts = db.prepare("INSERT INTO memory_fts (id, category, content, evidence, sourceAgent) VALUES (?, ?, ?, ?, ?)");
  try {
    upsert.run([record.id, record.category, record.content, record.sourceAgent, record.confidence, record.evidence ?? null, record.scope, record.createdAt, record.status, record.reviewedAt ?? null, record.topicKey ?? null, record.importance, record.trigger, record.lastSeenAt, record.duplicateCount, record.revisionCount]);
    deleteFts.run([record.id]);
    if (record.status === "active") insertFts.run([record.id, record.category, record.content, record.evidence ?? "", record.sourceAgent]);
  } finally {
    upsert.free();
    deleteFts.free();
    insertFts.free();
  }
}
