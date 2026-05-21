import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, test } from "node:test";
import { formatWebBundle, formatWebFetchAudit, listWebFetchAudit, parseExaTextResults, searchWeb } from "../src/webfetch.ts";

const tempDirs: string[] = [];
afterEach(() => {
  while (tempDirs.length > 0) fs.rmSync(tempDirs.pop()!, { recursive: true, force: true });
});
function tempDir(prefix: string): string { const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix)); tempDirs.push(dir); return dir; }

test("parseExaTextResults extracts source evidence", () => {
  const results = parseExaTextResults("Title: Exa MCP\nURL: https://exa.ai/docs/reference/exa-mcp\nText: Exa MCP exposes web_search_exa and web_fetch_exa.\n---\n");
  assert.equal(results.length, 1);
  assert.equal(results[0]?.title, "Exa MCP");
  assert.equal(results[0]?.url, "https://exa.ai/docs/reference/exa-mcp");
  assert.match(results[0]?.content ?? "", /web_search_exa/);
});

test("searchWeb uses Exa MCP and caches compact source bundles", async () => {
  const cwd = tempDir("pi-mesh-webfetch-");
  const previousFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return new Response(`data: ${JSON.stringify({ result: { content: [{ type: "text", text: "Title: Exa MCP\nURL: https://exa.ai/docs/reference/exa-mcp\nText: Exa MCP connects assistants to search and fetch tools." }] } })}\n`);
  };
  try {
    const first = await searchWeb({ cwd, query: "Exa MCP tools", maxSources: 3 });
    const second = await searchWeb({ cwd, query: "Exa MCP tools", maxSources: 3 });
    assert.equal(calls, 1);
    assert.equal(first.cache.hit, false);
    assert.equal(second.cache.hit, true);
    assert.match(formatWebBundle(first), /Sources:/);
    assert.match(formatWebBundle(first), /https:\/\/exa.ai/);
  } finally {
    globalThis.fetch = previousFetch;
  }
});


test("WebFetch audit summarizes cache freshness and sources", async () => {
  const cwd = tempDir("pi-mesh-webfetch-audit-");
  const cacheDir = path.join(cwd, ".pi-mesh", "cache", "webfetch");
  fs.mkdirSync(cacheDir, { recursive: true });
  fs.writeFileSync(path.join(cacheDir, "search-a.json"), JSON.stringify({
    query: "Exa MCP",
    provider: "exa-mcp",
    observedAt: new Date().toISOString(),
    cache: { hit: false, key: "search-a", ttlMs: 60_000 },
    sources: [{ title: "Exa docs", url: "https://exa.ai/docs", content: "Exa docs content" }],
    summary: "- Exa docs: Exa docs content",
    warnings: [],
  }, null, 2));

  const entries = await listWebFetchAudit({ cwd, now: Date.now() });
  assert.equal(entries.length, 1);
  assert.equal(entries[0]?.kind, "search");
  assert.equal(entries[0]?.sourceCount, 1);
  assert.equal(entries[0]?.freshness, "fresh");

  const formatted = formatWebFetchAudit(entries);
  assert.match(formatted, /pi-mesh WebFetch Audit/);
  assert.match(formatted, /search · Exa MCP/);
  assert.match(formatted, /Exa docs/);
  assert.match(formatted, /https:\/\/exa.ai\/docs/);
});
