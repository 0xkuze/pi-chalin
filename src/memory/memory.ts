import * as fs from "node:fs";
import * as path from "node:path";
import initSqlJs from "sql.js-fts5/dist/sql-asm.js";
import { Context, Effect, Layer } from "effect";
import { resolveChalinPaths, type ChalinPathsOptions } from "../config/paths.ts";
import type { AgentConcern, MemoryAuditEvent, MemoryAuditEventType, MemoryCandidate, MemoryRecord } from "../domain/schemas.ts";
import { applyCurrentPolicy, buildFtsQuery, buildMemoryRecord, dedupeCandidates, dedupeRecords, estimateTokens, findMemoryUpdateTarget, mergeEvidence, mergeMemoryRecord, normalizeContent, normalizeForDedupe, sortMemoryRecords, stableHash } from "./memory-policy.ts";

export interface MemorySearchResult {
  record: MemoryRecord;
  score: number;
  highlights: string[];
}

export interface MemoryContextRequest {
  query: string;
  sourceAgent?: string;
  agentConcern?: AgentConcern;
  limit?: number;
  tokenBudget?: number;
  includeEvidence?: boolean;
}

export interface MemoryContextBundle {
  text: string;
  results: MemorySearchResult[];
  tokenBudget: number;
  estimatedTokens: number;
  omitted: number;
}

export interface MemoryRevisionInput {
  category?: string;
  content: string;
  sourceAgent: string;
  confidence?: number;
  evidence?: string;
  scope?: "project" | "user";
  topicKey?: string;
  reason?: string;
}

export interface MemoryStoreLike {
  submitCandidates(candidates: MemoryCandidate[]): Promise<MemoryRecord[]>;
  list(status?: MemoryRecord["status"]): Promise<MemoryRecord[]>;
  pendingCount(): Promise<number>;
  approve(id: string): Promise<MemoryRecord | undefined>;
  reject(id: string): Promise<MemoryRecord | undefined>;
  delete(id: string): Promise<boolean>;
  search(query: string, limit?: number): Promise<MemorySearchResult[]>;
  retrieve(request: MemoryContextRequest): Promise<MemoryContextBundle>;
  revise(id: string, input: MemoryRevisionInput): Promise<MemoryRecord | undefined>;
  events(recordId?: string): Promise<MemoryAuditEvent[]>;
}

type SqlJsStatic = any;
type SqlJsDatabase = any;

interface SqlJsService {
  readonly module: Effect.Effect<SqlJsStatic, unknown>;
}

class SqlJs extends Context.Tag("pi-chalin/SqlJs")<SqlJs, SqlJsService>() {}

const cachedSqlModule = Effect.runSync(Effect.cached(Effect.tryPromise(() => initSqlJs())));
const SqlJsLive = Layer.succeed(SqlJs, { module: cachedSqlModule });

interface MemoryStoreServiceShape {
  readonly store: MemoryStoreLike;
  readonly submitCandidates: (candidates: MemoryCandidate[]) => Effect.Effect<MemoryRecord[], unknown>;
  readonly list: (status?: MemoryRecord["status"]) => Effect.Effect<MemoryRecord[], unknown>;
  readonly pendingCount: Effect.Effect<number, unknown>;
  readonly approve: (id: string) => Effect.Effect<MemoryRecord | undefined, unknown>;
  readonly reject: (id: string) => Effect.Effect<MemoryRecord | undefined, unknown>;
  readonly delete: (id: string) => Effect.Effect<boolean, unknown>;
  readonly search: (query: string, limit?: number) => Effect.Effect<MemorySearchResult[], unknown>;
  readonly retrieve: (request: MemoryContextRequest) => Effect.Effect<MemoryContextBundle, unknown>;
  readonly revise: (id: string, input: MemoryRevisionInput) => Effect.Effect<MemoryRecord | undefined, unknown>;
  readonly events: (recordId?: string) => Effect.Effect<MemoryAuditEvent[], unknown>;
}

class MemoryStoreService extends Context.Tag("pi-chalin/MemoryStore")<MemoryStoreService, MemoryStoreServiceShape>() {}

export function memoryStoreLayer(store: MemoryStoreLike): Layer.Layer<MemoryStoreService> {
  return Layer.succeed(MemoryStoreService, {
    store,
    submitCandidates: (candidates) => Effect.tryPromise(() => store.submitCandidates(candidates)),
    list: (status) => Effect.tryPromise(() => store.list(status)),
    pendingCount: Effect.tryPromise(() => store.pendingCount()),
    approve: (id) => Effect.tryPromise(() => store.approve(id)),
    reject: (id) => Effect.tryPromise(() => store.reject(id)),
    delete: (id) => Effect.tryPromise(() => store.delete(id)),
    search: (query, limit) => Effect.tryPromise(() => store.search(query, limit)),
    retrieve: (request) => Effect.tryPromise(() => store.retrieve(request)),
    revise: (id, input) => Effect.tryPromise(() => store.revise(id, input)),
    events: (recordId) => Effect.tryPromise(() => store.events(recordId)),
  });
}

export function createMemoryStoreLayer(options: ChalinPathsOptions): Layer.Layer<MemoryStoreService> {
  return memoryStoreLayer(new MemoryStore(options));
}

export class MemoryStore {
  private readonly dbPath: string;

  constructor(options: ChalinPathsOptions) {
    this.dbPath = path.join(resolveChalinPaths(options).projectRoot, ".pi-chalin", "memory.sqlite");
  }

  async submitCandidates(candidates: MemoryCandidate[]): Promise<MemoryRecord[]> {
    const now = new Date().toISOString();
    const records = prepareMemoryRecords(candidates, now);

    await this.withDb(true, (db) => {
      const existingRecords = selectRows(db, "SELECT * FROM memory_records ORDER BY createdAt DESC")
        .map(rowToRecord)
        .map(applyCurrentPolicy)
        .filter((record): record is MemoryRecord => Boolean(record));
      const accepted = [...existingRecords];
      try {
        for (const record of records) {
          if (record.status === "rejected") {
            appendMemoryEvent(db, {
              recordId: record.id,
              type: "reject",
              actor: record.sourceAgent,
              at: now,
              summary: `Rejected memory candidate during WriteGuard: ${record.trigger}`,
              nextContent: record.content,
            });
            continue;
          }
          const target = findMemoryUpdateTarget(record, accepted);
          const next = target ? mergeMemoryRecord(target, record, now) : record;
          upsertMemoryRecord(db, next);
          appendMemoryEvent(db, {
            recordId: next.id,
            type: target ? (normalizeForDedupe(target.content) === normalizeForDedupe(record.content) ? "duplicate" : "revise") : "create",
            actor: record.sourceAgent,
            at: now,
            summary: target ? "Memory candidate merged into an existing record." : "Memory candidate accepted by WriteGuard.",
            previousContent: target?.content,
            nextContent: next.content,
            metadata: { category: next.category, status: next.status, topicKey: next.topicKey },
          });
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
        appendMemoryEvent(db, {
          recordId: record.id,
          type: "approve",
          actor: "human-review",
          at: record.reviewedAt ?? new Date().toISOString(),
          summary: "Memory approved for retrieval.",
          nextContent: record.content,
        });
      });
    }
    return record;
  }

  async reject(id: string): Promise<MemoryRecord | undefined> {
    const record = await this.updateStatus(id, "rejected");
    if (record) await this.withDb(true, (db) => {
      db.run("DELETE FROM memory_fts WHERE id = ?", [id]);
      appendMemoryEvent(db, {
        recordId: record.id,
        type: "reject",
        actor: "human-review",
        at: record.reviewedAt ?? new Date().toISOString(),
        summary: "Memory rejected and removed from retrieval.",
        previousContent: record.content,
      });
    });
    return record;
  }

  async delete(id: string): Promise<boolean> {
    const before = await this.rawCount();
    await this.withDb(true, (db) => {
      const record = selectRows(db, "SELECT * FROM memory_records WHERE id = ?", [id]).map(rowToRecord)[0];
      db.run("DELETE FROM memory_fts WHERE id = ?", [id]);
      db.run("DELETE FROM memory_records WHERE id = ?", [id]);
      appendMemoryEvent(db, {
        recordId: id,
        type: "delete",
        actor: "human-review",
        at: new Date().toISOString(),
        summary: "Memory deleted from the primary store.",
        previousContent: record?.content,
      });
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

  async retrieve(request: MemoryContextRequest): Promise<MemoryContextBundle> {
    const tokenBudget = memoryTokenBudget(request);
    const results = rerankMemoryResults(await this.search(request.query, Math.max(request.limit ?? 8, 1)), request);
    const selected = selectMemoryResultsWithinBudget(results, tokenBudget, Boolean(request.includeEvidence));
    const now = new Date().toISOString();
    if (selected.results.length > 0) {
      await this.withDb(true, (db) => {
        for (const result of selected.results) {
          db.run(
            "UPDATE memory_records SET lastUsedAt = ?, useCount = useCount + 1, utilityScore = MIN(1, utilityScore + 0.04) WHERE id = ?",
            [now, result.record.id],
          );
          appendMemoryEvent(db, {
            recordId: result.record.id,
            type: "retrieve",
            actor: request.sourceAgent ?? "memory-system",
            at: now,
            summary: `Retrieved for '${truncateText(request.query, 120)}'.`,
            metadata: { score: result.score, tokenBudget },
          });
        }
      });
    }
    return {
      text: formatMemoryContext(selected.results, tokenBudget, Boolean(request.includeEvidence)),
      results: selected.results,
      tokenBudget,
      estimatedTokens: selected.estimatedTokens,
      omitted: Math.max(0, results.length - selected.results.length),
    };
  }

  async revise(id: string, input: MemoryRevisionInput): Promise<MemoryRecord | undefined> {
    const now = new Date().toISOString();
    let revised: MemoryRecord | undefined;
    await this.withDb(true, (db) => {
      const existing = selectRows(db, "SELECT * FROM memory_records WHERE id = ?", [id]).map(rowToRecord)[0];
      if (!existing || existing.status === "rejected") return;
      const candidate = createMemoryCandidate({
        category: input.category ?? existing.category,
        content: input.content,
        sourceAgent: input.sourceAgent,
        confidence: input.confidence ?? existing.confidence,
        evidence: input.evidence,
        scope: input.scope ?? existing.scope,
        topicKey: input.topicKey ?? existing.topicKey,
      });
      const incoming = buildMemoryRecord(candidate, now);
      revised = {
        ...existing,
        category: incoming.category,
        content: incoming.content,
        sourceAgent: incoming.sourceAgent,
        confidence: Math.max(existing.confidence, incoming.confidence),
        evidence: mergeEvidence(existing.evidence, incoming.evidence),
        status: existing.status === "quarantined" ? "pending" : incoming.status,
        reviewedAt: incoming.status === "pending" ? existing.reviewedAt : now,
        topicKey: incoming.topicKey ?? existing.topicKey,
        importance: Math.max(existing.importance, incoming.importance),
        trigger: incoming.trigger,
        lastSeenAt: now,
        updatedAt: now,
        tokenCostEstimate: estimateTokens(incoming.content),
        revisionCount: existing.revisionCount + 1,
      };
      upsertMemoryRecord(db, revised);
      appendMemoryEvent(db, {
        recordId: existing.id,
        type: "revise",
        actor: input.sourceAgent,
        at: now,
        summary: input.reason ? `Memory revised: ${truncateText(input.reason, 180)}` : "Memory revised by autonomous memory policy.",
        previousContent: existing.content,
        nextContent: revised.content,
        metadata: { category: revised.category, status: revised.status, topicKey: revised.topicKey },
      });
    });
    return revised;
  }

  async events(recordId?: string): Promise<MemoryAuditEvent[]> {
    return this.withDb(false, (db) => selectRows(
      db,
      recordId ? "SELECT * FROM memory_events WHERE recordId = ? ORDER BY at ASC" : "SELECT * FROM memory_events ORDER BY at ASC",
      recordId ? [recordId] : [],
    ).map(rowToMemoryEvent));
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
    return Effect.runPromise(this.withDbEffect(write, fn));
  }

  private withDbEffect<T>(write: boolean, fn: (db: SqlJsDatabase) => T): Effect.Effect<T, unknown> {
    const self = this;
    return Effect.gen(function* () {
      fs.mkdirSync(path.dirname(self.dbPath), { recursive: true });
      const SQL = yield* getSqlModuleEffect();
      const db = fs.existsSync(self.dbPath) ? new SQL.Database(fs.readFileSync(self.dbPath)) : new SQL.Database();
      try {
        migrate(db);
        const result = fn(db);
        if (write) fs.writeFileSync(self.dbPath, Buffer.from(db.export()));
        return result;
      } finally {
        db.close();
      }
    }).pipe(Effect.withSpan("memory.withDb"));
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

export function prepareMemoryRecords(candidates: MemoryCandidate[], now = new Date().toISOString()): MemoryRecord[] {
  return dedupeCandidates(candidates).map((candidate) => buildMemoryRecord(candidate, now));
}

function getSqlModuleEffect(): Effect.Effect<SqlJsStatic, unknown> {
  return Effect.gen(function* () {
    const sql = yield* SqlJs;
    return yield* sql.module;
  }).pipe(Effect.provide(SqlJsLive), Effect.withSpan("memory.sql.init"));
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
      revisionCount INTEGER NOT NULL DEFAULT 1,
      updatedAt TEXT,
      lastUsedAt TEXT,
      useCount INTEGER NOT NULL DEFAULT 0,
      utilityScore REAL NOT NULL DEFAULT 0,
      tokenCostEstimate INTEGER NOT NULL DEFAULT 0,
      supersedesId TEXT,
      supersededBy TEXT
    );
    CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(
      id UNINDEXED,
      category,
      content,
      evidence,
      sourceAgent
    );
    CREATE TABLE IF NOT EXISTS memory_events (
      id TEXT PRIMARY KEY,
      recordId TEXT NOT NULL,
      type TEXT NOT NULL,
      actor TEXT NOT NULL,
      at TEXT NOT NULL,
      summary TEXT NOT NULL,
      previousContent TEXT,
      nextContent TEXT,
      metadata TEXT
    );
  `);
  addColumnIfMissing(db, "memory_records", "topicKey", "TEXT");
  addColumnIfMissing(db, "memory_records", "importance", "REAL NOT NULL DEFAULT 0");
  addColumnIfMissing(db, "memory_records", "trigger", "TEXT NOT NULL DEFAULT 'unknown'");
  addColumnIfMissing(db, "memory_records", "lastSeenAt", "TEXT");
  addColumnIfMissing(db, "memory_records", "duplicateCount", "INTEGER NOT NULL DEFAULT 1");
  addColumnIfMissing(db, "memory_records", "revisionCount", "INTEGER NOT NULL DEFAULT 1");
  addColumnIfMissing(db, "memory_records", "updatedAt", "TEXT");
  addColumnIfMissing(db, "memory_records", "lastUsedAt", "TEXT");
  addColumnIfMissing(db, "memory_records", "useCount", "INTEGER NOT NULL DEFAULT 0");
  addColumnIfMissing(db, "memory_records", "utilityScore", "REAL NOT NULL DEFAULT 0");
  addColumnIfMissing(db, "memory_records", "tokenCostEstimate", "INTEGER NOT NULL DEFAULT 0");
  addColumnIfMissing(db, "memory_records", "supersedesId", "TEXT");
  addColumnIfMissing(db, "memory_records", "supersededBy", "TEXT");
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
    status: memoryStatusFromRow(row.status),
    ...(row.reviewedAt ? { reviewedAt: String(row.reviewedAt) } : {}),
    ...(row.topicKey ? { topicKey: String(row.topicKey) } : {}),
    importance: Number(row.importance ?? 0),
    trigger: String(row.trigger ?? "unknown"),
    lastSeenAt: row.lastSeenAt ? String(row.lastSeenAt) : createdAt,
    duplicateCount: Number(row.duplicateCount ?? 1),
    revisionCount: Number(row.revisionCount ?? 1),
    ...(row.updatedAt ? { updatedAt: String(row.updatedAt) } : {}),
    ...(row.lastUsedAt ? { lastUsedAt: String(row.lastUsedAt) } : {}),
    useCount: Number(row.useCount ?? 0),
    utilityScore: Number(row.utilityScore ?? 0),
    tokenCostEstimate: Number(row.tokenCostEstimate ?? estimateTokens(String(row.content ?? ""))),
    ...(row.supersedesId ? { supersedesId: String(row.supersedesId) } : {}),
    ...(row.supersededBy ? { supersededBy: String(row.supersededBy) } : {}),
  };
}

function upsertMemoryRecord(db: SqlJsDatabase, record: MemoryRecord): void {
  const upsert = db.prepare(`
    INSERT INTO memory_records (id, category, content, sourceAgent, confidence, evidence, scope, createdAt, status, reviewedAt, topicKey, importance, trigger, lastSeenAt, duplicateCount, revisionCount, updatedAt, lastUsedAt, useCount, utilityScore, tokenCostEstimate, supersedesId, supersededBy)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
      revisionCount=excluded.revisionCount,
      updatedAt=excluded.updatedAt,
      lastUsedAt=excluded.lastUsedAt,
      useCount=excluded.useCount,
      utilityScore=excluded.utilityScore,
      tokenCostEstimate=excluded.tokenCostEstimate,
      supersedesId=excluded.supersedesId,
      supersededBy=excluded.supersededBy
  `);
  const deleteFts = db.prepare("DELETE FROM memory_fts WHERE id = ?");
  const insertFts = db.prepare("INSERT INTO memory_fts (id, category, content, evidence, sourceAgent) VALUES (?, ?, ?, ?, ?)");
  try {
    upsert.run([
      record.id,
      record.category,
      record.content,
      record.sourceAgent,
      record.confidence,
      record.evidence ?? null,
      record.scope,
      record.createdAt,
      record.status,
      record.reviewedAt ?? null,
      record.topicKey ?? null,
      record.importance,
      record.trigger,
      record.lastSeenAt,
      record.duplicateCount,
      record.revisionCount,
      record.updatedAt ?? record.lastSeenAt,
      record.lastUsedAt ?? null,
      record.useCount ?? 0,
      record.utilityScore ?? 0,
      record.tokenCostEstimate ?? estimateTokens(record.content),
      record.supersedesId ?? null,
      record.supersededBy ?? null,
    ]);
    deleteFts.run([record.id]);
    if (record.status === "active") insertFts.run([record.id, record.category, record.content, record.evidence ?? "", record.sourceAgent]);
  } finally {
    upsert.free();
    deleteFts.free();
    insertFts.free();
  }
}

function appendMemoryEvent(
  db: SqlJsDatabase,
  event: Omit<MemoryAuditEvent, "id"> & { id?: string },
): void {
  const id = event.id ?? `memory-event-${stableHash(`${event.recordId}:${event.type}:${event.at}:${event.summary}:${event.nextContent ?? ""}`)}`;
  db.run(
    "INSERT OR IGNORE INTO memory_events (id, recordId, type, actor, at, summary, previousContent, nextContent, metadata) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    [
      id,
      event.recordId,
      event.type,
      event.actor,
      event.at,
      event.summary,
      event.previousContent ?? null,
      event.nextContent ?? null,
      event.metadata ? JSON.stringify(event.metadata) : null,
    ],
  );
}

function rowToMemoryEvent(row: Record<string, unknown>): MemoryAuditEvent {
  return {
    id: String(row.id),
    recordId: String(row.recordId),
    type: memoryEventTypeFromRow(row.type),
    actor: String(row.actor),
    at: String(row.at),
    summary: String(row.summary),
    ...(row.previousContent ? { previousContent: String(row.previousContent) } : {}),
    ...(row.nextContent ? { nextContent: String(row.nextContent) } : {}),
    ...(row.metadata ? { metadata: parseMetadata(row.metadata) } : {}),
  };
}

function memoryEventTypeFromRow(value: unknown): MemoryAuditEventType {
  const text = String(value);
  if (["create", "duplicate", "revise", "approve", "reject", "delete", "retrieve", "quarantine", "stale"].includes(text)) return text as MemoryAuditEventType;
  return "revise";
}

function parseMetadata(value: unknown): Record<string, unknown> {
  if (typeof value !== "string") return {};
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function memoryStatusFromRow(value: unknown): MemoryRecord["status"] {
  const text = String(value);
  if (text === "pending" || text === "rejected" || text === "superseded" || text === "stale" || text === "quarantined") return text;
  return "active";
}

function memoryTokenBudget(request: MemoryContextRequest): number {
  if (Number.isFinite(request.tokenBudget) && (request.tokenBudget ?? 0) > 0) return Math.max(80, Math.min(1800, Math.floor(request.tokenBudget!)));
  if (request.agentConcern === "review" || request.agentConcern === "decision-consistency") return 900;
  if (request.agentConcern === "planning" || request.agentConcern === "context-building") return 700;
  if (request.agentConcern === "implementation" || request.agentConcern === "conflict-resolution") return 520;
  return 420;
}

function rerankMemoryResults(results: MemorySearchResult[], request: MemoryContextRequest): MemorySearchResult[] {
  const now = Date.now();
  return [...results].sort((a, b) => memoryResultRank(b, now, request) - memoryResultRank(a, now, request));
}

function memoryResultRank(result: MemorySearchResult, now: number, request: MemoryContextRequest): number {
  const record = result.record;
  const lastSeen = Date.parse(record.lastSeenAt || record.createdAt);
  const ageDays = Number.isFinite(lastSeen) ? Math.max(0, (now - lastSeen) / 86_400_000) : 30;
  const recency = 1 / (1 + ageDays / 30);
  const utility = record.utilityScore ?? 0;
  const useSignal = Math.min(0.2, (record.useCount ?? 0) * 0.02);
  const costPenalty = Math.min(0.25, (record.tokenCostEstimate ?? estimateTokens(record.content)) / Math.max(memoryTokenBudget(request), 1));
  return record.importance * 0.35 + record.confidence * 0.2 + recency * 0.15 + utility * 0.2 + useSignal - result.score * 0.02 - costPenalty;
}

function selectMemoryResultsWithinBudget(
  results: MemorySearchResult[],
  tokenBudget: number,
  includeEvidence: boolean,
): { results: MemorySearchResult[]; estimatedTokens: number } {
  const selected: MemorySearchResult[] = [];
  let used = 0;
  for (const result of results) {
    const tokens = estimateTokens(formatMemoryLine(result.record, includeEvidence));
    if (selected.length > 0 && used + tokens > tokenBudget) continue;
    selected.push(result);
    used += tokens;
    if (used >= tokenBudget) break;
  }
  return { results: selected, estimatedTokens: used };
}

function formatMemoryContext(results: MemorySearchResult[], tokenBudget: number, includeEvidence: boolean): string {
  if (results.length === 0) return "";
  const lines = [
    `Memory context (${results.length} records, <=${tokenBudget} token budget). Treat as guidance; current repo evidence wins.`,
    ...results.map((result) => `- ${formatMemoryLine(result.record, includeEvidence)}`),
  ];
  return lines.join("\n");
}

function formatMemoryLine(record: MemoryRecord, includeEvidence: boolean): string {
  const meta = [
    record.id,
    record.category,
    `${Math.round(record.confidence * 100)}%`,
    record.topicKey ? `topic=${record.topicKey}` : undefined,
    record.revisionCount > 1 ? `rev=${record.revisionCount}` : undefined,
  ].filter(Boolean).join(" · ");
  const content = truncateText(record.content, 260);
  const evidence = includeEvidence && record.evidence ? ` evidence=${truncateText(record.evidence, 120)}` : "";
  return `[${meta}] ${content}${evidence}`;
}

function truncateText(text: string, maxChars: number): string {
  const normalized = normalizeContent(text);
  if (normalized.length <= maxChars) return normalized;
  return `${normalized.slice(0, Math.max(0, maxChars - 1)).trimEnd()}…`;
}
