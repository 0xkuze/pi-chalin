import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { resolveChalinPaths, type ChalinPathsOptions } from "./paths.ts";

const EXA_MCP_URL = "https://mcp.exa.ai/mcp?tools=web_search_exa,web_fetch_exa";
const SEARCH_TTL_MS = 6 * 60 * 60 * 1000;
const FETCH_TTL_MS = 24 * 60 * 60 * 1000;

export type WebFetchFreshness = "cache-ok" | "prefer-fresh" | "must-be-fresh";
export type WebFetchDepth = "snippets" | "content";

export interface WebSourceEvidence {
  title: string;
  url: string;
  content: string;
}

export interface WebContextBundle {
  query?: string;
  urls?: string[];
  provider: "exa-mcp";
  observedAt: string;
  cache: { hit: boolean; key: string; ttlMs: number };
  sources: WebSourceEvidence[];
  summary: string;
  warnings: string[];
}

export type WebFetchAuditFreshness = "fresh" | "stale" | "no-ttl";

export interface WebFetchAuditEntry {
  key: string;
  kind: "search" | "fetch" | "unknown";
  label: string;
  provider: WebContextBundle["provider"];
  observedAt: string;
  ageMs: number;
  ttlMs: number;
  freshness: WebFetchAuditFreshness;
  sourceCount: number;
  warnings: string[];
  sources: Array<Pick<WebSourceEvidence, "title" | "url">>;
}

export interface WebFetchAuditOptions extends ChalinPathsOptions {
  now?: number;
}

export interface WebSearchRequest extends ChalinPathsOptions {
  query: string;
  maxSources?: number;
  depth?: WebFetchDepth;
  freshness?: WebFetchFreshness;
  signal?: AbortSignal;
}

export interface WebFetchUrlRequest extends ChalinPathsOptions {
  urls: string[];
  freshness?: WebFetchFreshness;
  signal?: AbortSignal;
}

interface ExaMcpRpcResponse {
  result?: { content?: Array<{ type?: string; text?: string }>; isError?: boolean };
  error?: { code?: number; message?: string };
}

export async function searchWeb(request: WebSearchRequest): Promise<WebContextBundle> {
  const normalizedQuery = request.query.trim();
  if (!normalizedQuery) throw new Error("chalin_web_search requires a non-empty query.");
  const maxSources = clampInteger(request.maxSources, 1, 10, 5);
  const depth = request.depth ?? "snippets";
  const freshness = request.freshness ?? "cache-ok";
  const key = cacheKey("search", { query: normalizedQuery, maxSources, depth });
  const ttlMs = freshness === "must-be-fresh" ? 0 : SEARCH_TTL_MS;
  const cached = freshness !== "must-be-fresh" ? readCache(request, key, ttlMs) : undefined;
  if (cached && freshness === "cache-ok") return { ...cached, cache: { ...cached.cache, hit: true } };

  const text = await callExaMcp("web_search_exa", {
    query: normalizedQuery,
    numResults: maxSources,
    livecrawl: freshness === "must-be-fresh" ? "always" : "fallback",
    type: "auto",
    contextMaxCharacters: depth === "content" ? 20_000 : 3_000,
  }, request.signal);
  const sources = parseExaTextResults(text).slice(0, maxSources);
  const bundle = toBundle({ query: normalizedQuery, key, ttlMs, sources, warnings: sources.length === 0 ? ["Exa returned no parseable sources."] : [] });
  writeCache(request, key, bundle);
  return bundle;
}

export async function fetchWebUrls(request: WebFetchUrlRequest): Promise<WebContextBundle> {
  const urls = request.urls.map((url) => url.trim()).filter(Boolean).slice(0, 5);
  if (urls.length === 0) throw new Error("chalin_web_search fetch mode requires at least one URL.");
  const freshness = request.freshness ?? "cache-ok";
  const key = cacheKey("fetch", { urls });
  const ttlMs = freshness === "must-be-fresh" ? 0 : FETCH_TTL_MS;
  const cached = freshness !== "must-be-fresh" ? readCache(request, key, ttlMs) : undefined;
  if (cached && freshness === "cache-ok") return { ...cached, cache: { ...cached.cache, hit: true } };

  const text = await callExaMcp("web_fetch_exa", { urls }, request.signal);
  const sources = parseExaTextResults(text);
  const fallbackSources = sources.length > 0 ? sources : [{ title: urls[0] ?? "Web page", url: urls[0] ?? "", content: text.trim() }];
  const bundle = toBundle({ urls, key, ttlMs, sources: fallbackSources, warnings: [] });
  writeCache(request, key, bundle);
  return bundle;
}

export async function callExaMcp(toolName: "web_search_exa" | "web_fetch_exa", args: Record<string, unknown>, signal?: AbortSignal): Promise<string> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "Accept": "application/json, text/event-stream",
  };
  if (process.env.EXA_API_KEY) headers["x-api-key"] = process.env.EXA_API_KEY;
  const response = await fetch(EXA_MCP_URL, {
    method: "POST",
    headers,
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: toolName, arguments: args } }),
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(45_000)]) : AbortSignal.timeout(45_000),
  });
  if (!response.ok) throw new Error(`Exa MCP error ${response.status}: ${(await response.text()).slice(0, 300)}`);
  const body = await response.text();
  const parsed = parseMcpBody(body);
  if (parsed.error) throw new Error(`Exa MCP error${parsed.error.code ? ` ${parsed.error.code}` : ""}: ${parsed.error.message ?? "Unknown error"}`);
  const text = parsed.result?.content?.find((item) => item.type === "text" && item.text?.trim())?.text?.trim();
  if (parsed.result?.isError) throw new Error(text || "Exa MCP returned an error.");
  if (!text) throw new Error("Exa MCP returned empty content.");
  return text;
}

export function formatWebBundle(bundle: WebContextBundle): string {
  const lines = [
    bundle.query ? `chalin web search · ${bundle.query}` : `chalin web fetch · ${bundle.urls?.join(", ")}`,
    `provider: ${bundle.provider} · cache: ${bundle.cache.hit ? "hit" : "miss"} · sources: ${bundle.sources.length}`,
    bundle.warnings.length > 0 ? `warnings: ${bundle.warnings.join("; ")}` : undefined,
    "",
    "Summary:",
    bundle.summary || "No summary available.",
    "",
    "Sources:",
    ...bundle.sources.map((source, index) => `${index + 1}. ${source.title || source.url}\n   ${source.url}\n   ${truncate(source.content, 420)}`),
  ];
  return lines.filter((line): line is string => line !== undefined).join("\n");
}

export async function listWebFetchAudit(options: WebFetchAuditOptions): Promise<WebFetchAuditEntry[]> {
  const dir = path.join(resolveChalinPaths(options).projectRoot, ".pi-chalin", "cache", "webfetch");
  if (!fs.existsSync(dir)) return [];
  const now = options.now ?? Date.now();
  const entries: WebFetchAuditEntry[] = [];
  for (const fileName of fs.readdirSync(dir).filter((file) => file.endsWith(".json"))) {
    const file = path.join(dir, fileName);
    try {
      const bundle = JSON.parse(fs.readFileSync(file, "utf-8")) as WebContextBundle;
      if (!bundle || bundle.provider !== "exa-mcp" || !bundle.cache?.key) continue;
      const observedMs = Date.parse(bundle.observedAt);
      const ageMs = Number.isFinite(observedMs) ? Math.max(0, now - observedMs) : 0;
      const ttlMs = Number(bundle.cache.ttlMs ?? 0);
      entries.push({
        key: bundle.cache.key,
        kind: bundle.cache.key.startsWith("search-") ? "search" : bundle.cache.key.startsWith("fetch-") ? "fetch" : "unknown",
        label: bundle.query ?? bundle.urls?.join(", ") ?? bundle.cache.key,
        provider: bundle.provider,
        observedAt: bundle.observedAt,
        ageMs,
        ttlMs,
        freshness: ttlMs <= 0 ? "no-ttl" : ageMs <= ttlMs ? "fresh" : "stale",
        sourceCount: bundle.sources.length,
        warnings: bundle.warnings,
        sources: bundle.sources.slice(0, 5).map((source) => ({ title: source.title, url: source.url })),
      });
    } catch {
      // Ignore corrupt cache entries; WebFetch should never fail because diagnostics are dirty.
    }
  }
  return entries.sort((a, b) => Date.parse(b.observedAt) - Date.parse(a.observedAt));
}

export function formatWebFetchAudit(entries: WebFetchAuditEntry[]): string {
  if (entries.length === 0) return "WebFetch Audit\nNo cached WebFetch bundles yet.";
  const lines = [
    "WebFetch Audit",
    `cached bundles: ${entries.length}`,
    "",
    ...entries.flatMap((entry) => [
      `${freshnessIcon(entry.freshness)} ${entry.kind} · ${entry.label} · ${entry.sourceCount} source${entry.sourceCount === 1 ? "" : "s"} · ${formatAge(entry.ageMs)} old · ${entry.freshness}`,
      `  provider: ${entry.provider} · key: ${entry.key}`,
      entry.warnings.length ? `  warnings: ${entry.warnings.join("; ")}` : undefined,
      ...entry.sources.slice(0, 3).map((source, index) => `  ${index + 1}. ${source.title || source.url} — ${source.url}`),
    ].filter((line): line is string => Boolean(line))),
  ];
  return lines.join("\n");
}

export function parseExaTextResults(text: string): WebSourceEvidence[] {
  const blocks = text.split(/(?=^Title: )/m).filter((block) => block.trim().length > 0);
  const parsed = blocks.map((block, index) => {
    const title = block.match(/^Title:\s*(.+)$/m)?.[1]?.trim() ?? `Source ${index + 1}`;
    const url = block.match(/^URL:\s*(.+)$/m)?.[1]?.trim() ?? "";
    let content = "";
    const textStart = block.indexOf("\nText: ");
    if (textStart >= 0) content = block.slice(textStart + 7).trim();
    else {
      const highlights = block.match(/\nHighlights:\s*\n/);
      if (highlights?.index !== undefined) content = block.slice(highlights.index + highlights[0].length).trim();
    }
    return { title, url, content: normalizeContent(content.replace(/\n---\s*$/, "")) };
  }).filter((source) => source.url && source.content);
  if (parsed.length > 0) return parsed;
  return [];
}

function parseMcpBody(body: string): ExaMcpRpcResponse {
  for (const line of body.split("\n")) {
    if (!line.startsWith("data:")) continue;
    const payload = line.slice(5).trim();
    if (!payload) continue;
    try {
      const candidate = JSON.parse(payload) as ExaMcpRpcResponse;
      if (candidate.result || candidate.error) return candidate;
    } catch {}
  }
  try {
    return JSON.parse(body) as ExaMcpRpcResponse;
  } catch {
    throw new Error("Exa MCP returned an unparseable response.");
  }
}

function toBundle(input: { query?: string; urls?: string[]; key: string; ttlMs: number; sources: WebSourceEvidence[]; warnings: string[] }): WebContextBundle {
  return {
    query: input.query,
    urls: input.urls,
    provider: "exa-mcp",
    observedAt: new Date().toISOString(),
    cache: { hit: false, key: input.key, ttlMs: input.ttlMs },
    sources: input.sources,
    summary: input.sources.map((source) => `- ${source.title}: ${truncate(source.content, 220)}`).join("\n"),
    warnings: input.warnings,
  };
}

function readCache(options: ChalinPathsOptions, key: string, ttlMs: number): WebContextBundle | undefined {
  const file = cachePath(options, key);
  if (!fs.existsSync(file)) return undefined;
  try {
    const bundle = JSON.parse(fs.readFileSync(file, "utf-8")) as WebContextBundle;
    if (ttlMs > 0 && Date.now() - Date.parse(bundle.observedAt) > ttlMs) return undefined;
    return bundle;
  } catch {
    return undefined;
  }
}

function writeCache(options: ChalinPathsOptions, key: string, bundle: WebContextBundle): void {
  const file = cachePath(options, key);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(bundle, null, 2)}\n`, "utf-8");
}

function cachePath(options: ChalinPathsOptions, key: string): string {
  return path.join(resolveChalinPaths(options).projectRoot, ".pi-chalin", "cache", "webfetch", `${key}.json`);
}

function cacheKey(kind: string, payload: unknown): string {
  return `${kind}-${crypto.createHash("sha256").update(JSON.stringify(payload)).digest("hex").slice(0, 24)}`;
}

function normalizeContent(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

function freshnessIcon(freshness: WebFetchAuditFreshness): string {
  if (freshness === "fresh") return "✓";
  if (freshness === "stale") return "!";
  return "·";
}

function formatAge(ms: number): string {
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m`;
  if (ms < 86_400_000) return `${Math.round(ms / 3_600_000)}h`;
  return `${Math.round(ms / 86_400_000)}d`;
}

function clampInteger(value: number | undefined, min: number, max: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(value!)));
}
