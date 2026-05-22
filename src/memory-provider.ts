import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { DEFAULT_CONFIG, loadEffectiveConfig, type ChalinConfig, type MemoryProvider } from "./config.ts";
import type { ChalinPathsOptions } from "./paths.ts";
import type { MemoryAuditEvent, MemoryCandidate, MemoryRecord } from "./schemas.ts";
import {
  MemoryStore,
  prepareMemoryRecords,
  type MemoryContextBundle,
  type MemoryContextRequest,
  type MemoryRevisionInput,
  type MemorySearchResult,
  type MemoryStoreLike,
} from "./memory.ts";

export interface MemoryBackendStatus {
  configuredProvider: MemoryProvider;
  activeProvider: "engram" | "pi-chalin" | "unavailable";
  engramAvailable: boolean;
  summary: string;
  detail?: string;
}

interface EngramStoreOptions extends ChalinPathsOptions {
  config: ChalinConfig["memory"]["engram"];
  fallback?: MemoryStoreLike;
  forceStart?: boolean;
}

interface EngramObservation {
  id?: number | string;
  session_id?: string;
  type?: string;
  title?: string;
  content?: string;
  project?: string | null;
  scope?: string;
  topic_key?: string | null;
  revision_count?: number;
  duplicate_count?: number;
  last_seen_at?: string | null;
  created_at?: string;
  updated_at?: string;
  rank?: number;
}

interface EngramProjectResponse {
  project?: string;
  warning?: string;
  error_hint?: string;
}

interface EngramSyncStatus {
  enabled?: boolean;
  phase?: string;
  reason_code?: string;
  reason_message?: string;
}

const cloudSyncAttempts = new Map<string, { at: number; promise?: Promise<void> }>();

class AutoMemoryStore implements MemoryStoreLike {
  constructor(private readonly engram: EngramMemoryStore, private readonly local: MemoryStoreLike) {}

  private async target(): Promise<MemoryStoreLike> {
    return await this.engram.isAvailable(false) ? this.engram : this.local;
  }

  async submitCandidates(candidates: MemoryCandidate[]): Promise<MemoryRecord[]> {
    return (await this.target()).submitCandidates(candidates);
  }

  async list(status?: MemoryRecord["status"]): Promise<MemoryRecord[]> {
    return (await this.target()).list(status);
  }

  async pendingCount(): Promise<number> {
    return (await this.target()).pendingCount();
  }

  async approve(id: string): Promise<MemoryRecord | undefined> {
    return (await this.target()).approve(id);
  }

  async reject(id: string): Promise<MemoryRecord | undefined> {
    return (await this.target()).reject(id);
  }

  async delete(id: string): Promise<boolean> {
    return (await this.target()).delete(id);
  }

  async search(query: string, limit?: number): Promise<MemorySearchResult[]> {
    return (await this.target()).search(query, limit);
  }

  async retrieve(request: MemoryContextRequest): Promise<MemoryContextBundle> {
    return (await this.target()).retrieve(request);
  }

  async revise(id: string, input: MemoryRevisionInput): Promise<MemoryRecord | undefined> {
    return (await this.target()).revise(id, input);
  }

  async events(recordId?: string): Promise<MemoryAuditEvent[]> {
    return (await this.target()).events(recordId);
  }
}

export class EngramMemoryStore implements MemoryStoreLike {
  private readonly cwd: string;
  private readonly baseUrl: string;
  private readonly command: string;
  private readonly autoStart: boolean;
  private readonly autoSync: boolean;
  private readonly syncThrottleMs: number;
  private readonly timeoutMs: number;
  private readonly configuredProject?: string;
  private readonly fallback?: MemoryStoreLike;
  private readonly forceStart: boolean;
  private startAttempted = false;
  private projectCache?: string;
  private readonly knownSessions = new Set<string>();

  constructor(options: EngramStoreOptions) {
    this.cwd = path.resolve(options.cwd);
    this.baseUrl = resolveEngramBaseUrl(options.config);
    this.command = process.env.ENGRAM_BIN?.trim() || options.config.command;
    this.autoStart = options.config.autoStart;
    this.autoSync = options.config.autoSync;
    this.syncThrottleMs = options.config.syncThrottleMs;
    this.timeoutMs = options.config.timeoutMs;
    this.configuredProject = options.config.project?.trim() || undefined;
    this.fallback = options.fallback;
    this.forceStart = Boolean(options.forceStart);
  }

  async isAvailable(allowStart = this.autoStart || this.forceStart): Promise<boolean> {
    if (await this.health()) return true;
    if (!allowStart || this.startAttempted || process.env.ENGRAM_URL?.trim()) return false;
    this.startAttempted = true;
    if (!await spawnDetached(this.command, ["serve"], this.cwd)) return false;
    await wait(650);
    return this.health();
  }

  async submitCandidates(candidates: MemoryCandidate[]): Promise<MemoryRecord[]> {
    const now = new Date().toISOString();
    const records = prepareMemoryRecords(candidates, now);
    if (records.every((record) => record.status === "rejected")) return records;

    try {
      await this.ensureReady();
      const project = await this.projectName();
      await this.syncCloudProject(project, "import");
      const saved: MemoryRecord[] = [];
      for (const record of records) {
        if (record.status === "rejected") {
          saved.push(record);
          continue;
        }
        saved.push(await this.saveRecord(record, project));
      }
      await this.syncCloudProject(project, "export");
      return saved;
    } catch {
      return this.fallback ? this.fallback.submitCandidates(candidates) : [];
    }
  }

  async list(status?: MemoryRecord["status"]): Promise<MemoryRecord[]> {
    if (status && status !== "active") return [];
    try {
      await this.ensureReady();
      const project = await this.projectName();
      await this.syncCloudProject(project, "import");
      const rows = await this.request<EngramObservation[] | null>(`/observations/recent${queryString({ project, limit: 100 })}`);
      return observationRows(rows).map((row) => this.recordFromObservation(row));
    } catch {
      return [];
    }
  }

  async pendingCount(): Promise<number> {
    return 0;
  }

  async approve(id: string): Promise<MemoryRecord | undefined> {
    if (!isEngramRecordId(id)) return undefined;
    try {
      await this.ensureReady();
      return this.recordFromObservation(await this.request<EngramObservation>(`/observations/${encodeURIComponent(engramNumericId(id))}`));
    } catch {
      return undefined;
    }
  }

  async reject(id: string): Promise<MemoryRecord | undefined> {
    if (!isEngramRecordId(id)) return undefined;
    const record = await this.approve(id);
    if (record) await this.delete(id);
    return record ? { ...record, status: "rejected" } : undefined;
  }

  async delete(id: string): Promise<boolean> {
    if (!isEngramRecordId(id)) return this.fallback ? this.fallback.delete(id) : false;
    try {
      await this.ensureReady();
      const project = await this.projectName();
      await this.request(`/observations/${encodeURIComponent(engramNumericId(id))}`, { method: "DELETE" });
      await this.syncCloudProject(project, "export");
      return true;
    } catch {
      return false;
    }
  }

  async search(query: string, limit = 10): Promise<MemorySearchResult[]> {
    try {
      await this.ensureReady();
      const project = await this.projectName();
      await this.syncCloudProject(project, "import");
      const rows = await this.request<EngramObservation[] | null>(`/search${queryString({ q: query, project, limit })}`);
      return observationRows(rows).map((row) => ({
        record: this.recordFromObservation(row),
        score: Math.abs(Number(row.rank ?? 0)),
        highlights: [String(row.content ?? "").slice(0, 180)],
      }));
    } catch {
      return this.fallback ? this.fallback.search(query, limit) : [];
    }
  }

  async retrieve(request: MemoryContextRequest): Promise<MemoryContextBundle> {
    const tokenBudget = memoryTokenBudget(request);
    const results = await this.search(request.query, Math.max(request.limit ?? 8, 1));
    const selected = selectWithinBudget(results, tokenBudget, Boolean(request.includeEvidence));
    return {
      text: formatEngramContext(selected.results, tokenBudget, Boolean(request.includeEvidence)),
      results: selected.results,
      tokenBudget,
      estimatedTokens: selected.estimatedTokens,
      omitted: Math.max(0, results.length - selected.results.length),
    };
  }

  async revise(id: string, input: MemoryRevisionInput): Promise<MemoryRecord | undefined> {
    if (!isEngramRecordId(id)) return this.fallback?.revise(id, input);
    try {
      await this.ensureReady();
      const project = await this.projectName();
      const row = await this.request<EngramObservation>(`/observations/${encodeURIComponent(engramNumericId(id))}`, {
        method: "PATCH",
        body: {
          type: input.category ? engramTypeForCategory(input.category) : undefined,
          content: engramContent(input.content, input.evidence),
          scope: input.scope === "user" ? "personal" : input.scope,
          topic_key: input.topicKey,
        },
      });
      await this.syncCloudProject(project, "export");
      return this.recordFromObservation(row);
    } catch {
      return undefined;
    }
  }

  async events(recordId?: string): Promise<MemoryAuditEvent[]> {
    if (recordId && !isEngramRecordId(recordId)) return this.fallback ? this.fallback.events(recordId) : [];
    return [];
  }

  async cloudSyncDetail(): Promise<string | undefined> {
    if (!this.autoSync || !isLocalEngramBaseUrl(this.baseUrl)) return undefined;
    try {
      const project = await this.projectName();
      const status = await this.request<EngramSyncStatus>(`/sync/status${queryString({ project })}`);
      if (status?.enabled && !hasCloudSyncRuntimeAuth()) {
        return `Engram cloud sync is enabled for project "${project}", but this Pi process does not have ENGRAM_CLOUD_TOKEN. Export it before launching Pi.`;
      }
      if (status?.enabled && status.reason_code) {
        const message = status.reason_message ? `: ${status.reason_message}` : "";
        return `Engram cloud sync has a previous degraded state for project "${project}" (${status.reason_code}${message}); pi-chalin will retry automatically before reading memory.`;
      }
      if (!status?.enabled && status?.reason_code) {
        const message = status.reason_message ? `: ${status.reason_message}` : "";
        return `Engram cloud sync is blocked for project "${project}" (${status.reason_code}${message}).`;
      }
    } catch {
      return undefined;
    }
    return undefined;
  }

  private async ensureReady(): Promise<void> {
    if (!await this.isAvailable()) throw new Error(`Engram is unavailable at ${this.baseUrl}`);
  }

  private async health(): Promise<boolean> {
    try {
      const res = await fetch(`${this.baseUrl}/health`, { signal: AbortSignal.timeout(this.timeoutMs) });
      return res.ok;
    } catch {
      return false;
    }
  }

  private async request<T>(route: string, options: { method?: string; body?: unknown } = {}): Promise<T> {
    const res = await fetch(`${this.baseUrl}${route}`, {
      method: options.method ?? "GET",
      headers: options.body ? { "Content-Type": "application/json" } : undefined,
      body: options.body ? JSON.stringify(removeUndefined(options.body)) : undefined,
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    let data: unknown;
    try {
      data = await res.json();
    } catch {
      data = undefined;
    }
    if (!res.ok) {
      const message = isRecord(data) && typeof data.error === "string" ? data.error : `Engram HTTP ${res.status}`;
      throw new Error(message);
    }
    return data as T;
  }

  private async projectName(): Promise<string> {
    if (this.configuredProject) return this.configuredProject;
    if (this.projectCache) return this.projectCache;
    try {
      const detected = await this.request<EngramProjectResponse>(`/project/current${queryString({ cwd: this.cwd })}`);
      if (detected.project?.trim()) {
        this.projectCache = detected.project.trim();
        return this.projectCache;
      }
    } catch {
      // Older Engram versions or non-running servers can still use local config.
    }
    const configured = readEngramProjectConfig(this.cwd);
    this.projectCache = configured || path.basename(this.cwd).trim().toLowerCase() || "unknown";
    return this.projectCache;
  }

  private async ensureSession(project: string): Promise<string> {
    const sessionId = `pi-chalin-${stableHash(`${project}:${this.cwd}`)}`;
    const key = `${project}:${sessionId}`;
    if (this.knownSessions.has(key)) return sessionId;
    await this.request("/sessions", {
      method: "POST",
      body: { id: sessionId, project, directory: this.cwd },
    });
    this.knownSessions.add(key);
    return sessionId;
  }

  private async saveRecord(record: MemoryRecord, project: string): Promise<MemoryRecord> {
    const sessionId = await this.ensureSession(project);
    const response = await this.request<{ id?: number | string }>("/observations", {
      method: "POST",
      body: {
        session_id: sessionId,
        type: engramTypeForCategory(record.category),
        title: engramTitle(record),
        content: engramContent(record.content, record.evidence),
        project,
        scope: record.scope === "user" ? "personal" : "project",
        topic_key: record.topicKey,
      },
    });
    const id = response.id !== undefined ? `engram-${response.id}` : record.id;
    return { ...record, id, status: "active", reviewedAt: record.reviewedAt ?? new Date().toISOString() };
  }

  private async syncCloudProject(project: string, mode: "import" | "export"): Promise<void> {
    if (!this.autoSync || !project.trim() || !isLocalEngramBaseUrl(this.baseUrl) || !hasCloudSyncRuntimeAuth()) return;
    let status: EngramSyncStatus | undefined;
    try {
      status = await this.request<EngramSyncStatus>(`/sync/status${queryString({ project })}`);
    } catch {
      return;
    }
    if (!status?.enabled) return;

    const key = `${mode}:${this.command}:${this.cwd}:${project}`;
    const now = Date.now();
    const previous = cloudSyncAttempts.get(key);
    if (mode === "import" && previous && now - previous.at < this.syncThrottleMs) {
      if (previous.promise) await previous.promise.catch(() => undefined);
      return;
    }
    const args = ["sync", "--cloud", ...(mode === "import" ? ["--import"] : []), "--project", project];
    const promise = runEngramCommand(this.command, args, this.cwd, 20_000).then(() => undefined);
    cloudSyncAttempts.set(key, { at: now, promise });
    await promise.catch(() => undefined);
    cloudSyncAttempts.set(key, { at: Date.now() });
  }

  private recordFromObservation(row: EngramObservation): MemoryRecord {
    const createdAt = row.created_at ?? new Date().toISOString();
    const category = row.type || "memory";
    const content = row.content || row.title || "";
    return {
      id: row.id !== undefined ? `engram-${row.id}` : `engram-${stableHash(`${row.title}:${content}`)}`,
      category,
      content,
      sourceAgent: "engram",
      confidence: 0.9,
      scope: row.scope === "personal" ? "user" : "project",
      createdAt,
      status: "active",
      reviewedAt: row.updated_at ?? createdAt,
      ...(row.topic_key ? { topicKey: row.topic_key } : {}),
      importance: importanceForEngramType(category),
      trigger: "engram-memory",
      lastSeenAt: row.last_seen_at ?? row.updated_at ?? createdAt,
      duplicateCount: Number(row.duplicate_count ?? 1),
      revisionCount: Number(row.revision_count ?? 1),
      updatedAt: row.updated_at ?? createdAt,
      useCount: 0,
      utilityScore: 0.8,
      tokenCostEstimate: estimateTokens(content),
    };
  }
}

export function createConfiguredMemoryStore(options: ChalinPathsOptions, config = loadEffectiveConfig(options).config): MemoryStoreLike {
  const local = new MemoryStore(options);
  const provider = configuredMemoryProvider(config);
  if (provider === "pi-chalin") return local;
  const engram = new EngramMemoryStore({
    ...options,
    config: config.memory.engram,
    fallback: provider === "auto" ? local : undefined,
    forceStart: provider === "engram",
  });
  return provider === "engram" ? engram : new AutoMemoryStore(engram, local);
}

export async function resolveMemoryBackendStatus(options: ChalinPathsOptions, config = loadEffectiveConfig(options).config): Promise<MemoryBackendStatus> {
  const provider = configuredMemoryProvider(config);
  if (provider === "pi-chalin") {
    return {
      configuredProvider: provider,
      activeProvider: "pi-chalin",
      engramAvailable: false,
      summary: "pi-chalin local",
    };
  }
  const engram = new EngramMemoryStore({
    ...options,
    config: config.memory.engram,
    forceStart: provider === "engram",
  });
  const available = await engram.isAvailable(provider === "engram" || config.memory.engram.autoStart);
  const detail = available ? await engram.cloudSyncDetail() : undefined;
  if (!available && provider === "engram") {
    return {
      configuredProvider: provider,
      activeProvider: "unavailable",
      engramAvailable: false,
      summary: `engram unavailable (${engramBaseUrl(config)})`,
      detail: "Engram is selected; the memory panel shows Engram observations only when Engram is reachable.",
    };
  }
  return {
    configuredProvider: provider,
    activeProvider: available ? "engram" : "pi-chalin",
    engramAvailable: available,
    summary: available ? `engram (${engramBaseUrl(config)})` : `pi-chalin local (Engram unavailable at ${engramBaseUrl(config)})`,
    ...(detail ? { detail } : {}),
  };
}

function configuredMemoryProvider(config: ChalinConfig): MemoryProvider {
  const env = process.env.PI_CHALIN_MEMORY_PROVIDER?.trim();
  if (env === "auto" || env === "engram" || env === "pi-chalin") return env;
  return config.memory.provider;
}

function observationRows(rows: EngramObservation[] | null | undefined): EngramObservation[] {
  return Array.isArray(rows) ? rows : [];
}

function hasCloudSyncRuntimeAuth(): boolean {
  return Boolean(process.env.ENGRAM_CLOUD_TOKEN?.trim() || process.env.ENGRAM_CLOUD_INSECURE_NO_AUTH?.trim() === "1");
}

function isLocalEngramBaseUrl(baseUrl: string): boolean {
  try {
    const parsed = new URL(baseUrl);
    const host = parsed.hostname.toLowerCase();
    return host === "127.0.0.1" || host === "localhost" || host === "::1";
  } catch {
    return false;
  }
}

function engramBaseUrl(config: ChalinConfig): string {
  return resolveEngramBaseUrl(config.memory.engram);
}

function resolveEngramBaseUrl(config: ChalinConfig["memory"]["engram"]): string {
  const explicitUrl = process.env.ENGRAM_URL?.trim();
  if (explicitUrl) return explicitUrl.replace(/\/+$/, "");

  const configured = config.baseUrl.replace(/\/+$/, "");
  const defaultUrl = DEFAULT_CONFIG.memory.engram.baseUrl.replace(/\/+$/, "");
  const port = normalizedEngramPort(process.env.ENGRAM_PORT);
  if (port && configured === defaultUrl) return `http://127.0.0.1:${port}`;

  return configured;
}

function normalizedEngramPort(value: string | undefined): number | undefined {
  const port = Number.parseInt(value?.trim() ?? "", 10);
  return Number.isInteger(port) && port > 0 && port <= 65_535 ? port : undefined;
}

function readEngramProjectConfig(cwd: string): string | undefined {
  let current = path.resolve(cwd || ".");
  while (true) {
    const configPath = path.join(current, ".engram", "config.json");
    if (fs.existsSync(configPath)) {
      try {
        const parsed = JSON.parse(fs.readFileSync(configPath, "utf-8")) as { project_name?: unknown };
        const projectName = typeof parsed.project_name === "string" ? parsed.project_name.trim() : "";
        return projectName || undefined;
      } catch {
        return undefined;
      }
    }
    const parent = path.dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

function queryString(params: Record<string, unknown>): string {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === "") continue;
    query.set(key, String(value));
  }
  const encoded = query.toString();
  return encoded ? `?${encoded}` : "";
}

function removeUndefined(value: unknown): unknown {
  if (!isRecord(value)) return value;
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function spawnDetached(command: string, args: readonly string[], cwd: string): Promise<boolean> {
  return new Promise((resolve) => {
    try {
      const child = spawn(command, [...args], { cwd, detached: true, stdio: "ignore" });
      let settled = false;
      const settle = (started: boolean) => {
        if (settled) return;
        settled = true;
        resolve(started);
      };
      child.once("error", () => settle(false));
      child.once("spawn", () => {
        child.unref();
        settle(true);
      });
    } catch {
      resolve(false);
    }
  });
}

function runEngramCommand(command: string, args: readonly string[], cwd: string, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    try {
      const child = spawn(command, [...args], { cwd, env: process.env, stdio: "ignore" });
      let settled = false;
      const settle = (ok: boolean) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        resolve(ok);
      };
      const timeout = setTimeout(() => {
        child.kill("SIGTERM");
        settle(false);
      }, timeoutMs);
      child.once("error", () => settle(false));
      child.once("exit", (code) => settle(code === 0));
    } catch {
      resolve(false);
    }
  });
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isEngramRecordId(id: string): boolean {
  return /^engram-\d+$/.test(id);
}

function engramNumericId(id: string): string {
  return id.replace(/^engram-/, "");
}

function engramTypeForCategory(category: string): string {
  const normalized = category.toLowerCase();
  const mapped: Record<string, string> = {
    "project-fact": "discovery",
    "agent-note": "learning",
    tooling: "config",
    testing: "pattern",
    workflow: "pattern",
    failure: "bugfix",
    bugfix: "bugfix",
    preference: "preference",
    architecture: "architecture",
    decision: "decision",
    safety: "decision",
    security: "decision",
  };
  return mapped[normalized] ?? normalized;
}

function importanceForEngramType(type: string): number {
  if (["architecture", "decision", "preference"].includes(type)) return 0.95;
  if (["bugfix", "pattern", "config"].includes(type)) return 0.8;
  return 0.7;
}

function engramTitle(record: MemoryRecord): string {
  const prefix = record.topicKey ? record.topicKey.split("/").at(-1) ?? record.topicKey : record.category;
  return truncateText(`${prefix}: ${record.content}`, 90);
}

function engramContent(content: string, evidence?: string): string {
  if (!evidence) return content;
  return `${content}\n\nEvidence: ${evidence}`;
}

function memoryTokenBudget(request: MemoryContextRequest): number {
  if (Number.isFinite(request.tokenBudget) && (request.tokenBudget ?? 0) > 0) return Math.max(80, Math.min(1800, Math.floor(request.tokenBudget!)));
  return 520;
}

function selectWithinBudget(results: MemorySearchResult[], tokenBudget: number, includeEvidence: boolean): { results: MemorySearchResult[]; estimatedTokens: number } {
  const selected: MemorySearchResult[] = [];
  let used = 0;
  for (const result of results) {
    const tokens = estimateTokens(formatEngramLine(result.record, includeEvidence));
    if (selected.length > 0 && used + tokens > tokenBudget) continue;
    selected.push(result);
    used += tokens;
    if (used >= tokenBudget) break;
  }
  return { results: selected, estimatedTokens: used };
}

function formatEngramContext(results: MemorySearchResult[], tokenBudget: number, includeEvidence: boolean): string {
  if (results.length === 0) return "";
  return [
    `Engram memory context (${results.length} records, <=${tokenBudget} token budget). Treat as guidance; current repo evidence wins.`,
    ...results.map((result) => `- ${formatEngramLine(result.record, includeEvidence)}`),
  ].join("\n");
}

function formatEngramLine(record: MemoryRecord, includeEvidence: boolean): string {
  const meta = [
    record.id,
    record.category,
    record.topicKey ? `topic=${record.topicKey}` : undefined,
    record.revisionCount > 1 ? `rev=${record.revisionCount}` : undefined,
  ].filter(Boolean).join(" · ");
  const evidence = includeEvidence && record.evidence ? ` evidence=${truncateText(record.evidence, 120)}` : "";
  return `[${meta}] ${truncateText(record.content, 260)}${evidence}`;
}

function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}

function truncateText(text: string, maxChars: number): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxChars) return normalized;
  return `${normalized.slice(0, Math.max(0, maxChars - 1)).trimEnd()}...`;
}

function stableHash(input: string): string {
  let hash = 5381;
  for (let index = 0; index < input.length; index++) hash = (hash * 33) ^ input.charCodeAt(index);
  return (hash >>> 0).toString(16);
}
