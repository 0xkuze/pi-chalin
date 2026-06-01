import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, test } from "bun:test";
import { formatWebBundle, formatWebBundleProgressWidget, formatWebBundleWidget, formatWebFetchAudit, listWebFetchAudit, parseExaTextResults, searchWeb } from "../src/webfetch.ts";

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
  const cwd = tempDir("pi-chalin-webfetch-");
  const previousFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async () => {
    calls += 1;
    return new Response(`data: ${JSON.stringify({ result: { content: [{ type: "text", text: "Title: Exa MCP\nURL: https://exa.ai/docs/reference/exa-mcp\nText: Exa MCP connects assistants to search and fetch tools." }] } })}\n`);
  }) as unknown as typeof fetch;
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

test("formatWebBundleWidget renders compact progress and source title bullets", () => {
  const widget = formatWebBundleWidget({
    query: "Effect TypeScript docs",
    provider: "exa-mcp",
    observedAt: new Date().toISOString(),
    cache: { hit: false, key: "search-test", ttlMs: 60_000 },
    sources: [
      { title: "Effect - The best way to build robust apps in TypeScript", url: "https://effect.website/", content: "Very long extracted content that should not be shown in the visual widget." },
      { title: "Creating Effects | Effect Documentation", url: "https://effect.website/docs", content: "More extracted content that belongs to the model result only." },
    ],
    summary: "- Effect: long summary that should stay out of the visual widget.",
    warnings: [],
  });

  assert.match(widget, /^Web search · Effect TypeScript docs/m);
  assert.match(widget, /Fetched: \[██████████\] 2\/2/);
  assert.match(widget, /Sources:/);
  assert.match(widget, /- Effect - The best way to build robust apps in TypeScript/);
  assert.match(widget, /effect\.website/);
  assert.match(widget, /- Creating Effects \| Effect Documentation/);
  assert.doesNotMatch(widget, /^chalin_web_search$/m);
  assert.doesNotMatch(widget, /provider: .*cache: .*sources:/);
  assert.doesNotMatch(widget, /Summary:/);
  assert.doesNotMatch(widget, /Very long extracted content/);
  assert.doesNotMatch(widget, /https:\/\/effect\.website\//);
});

test("formatWebBundleProgressWidget renders a minimal in-flight fetch view", () => {
  const widget = formatWebBundleProgressWidget({
    mode: "fetch",
    label: "https://www.youtube.com/watch?v=9kxx5xp5nTQ",
    requested: ["https://www.youtube.com/watch?v=9kxx5xp5nTQ"],
    done: 0,
    total: 1,
  });

  assert.match(widget, /^Web fetch · https:\/\/www\.youtube\.com\/watch\?v=9kxx5xp5nTQ/m);
  assert.match(widget, /Fetching: \[░░░░░░░░░░\] 0\/1/);
  assert.match(widget, /Requested:/);
  assert.match(widget, /- https:\/\/www\.youtube\.com\/watch\?v=9kxx5xp5nTQ/);
  assert.doesNotMatch(widget, /provider:/);
  assert.doesNotMatch(widget, /Summary:/);
});


test("WebFetch audit summarizes cache freshness and sources", async () => {
  const cwd = tempDir("pi-chalin-webfetch-audit-");
  const cacheDir = path.join(cwd, ".pi-chalin", "cache", "webfetch");
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
  assert.match(formatted, /WebFetch Audit/);
  assert.match(formatted, /search · Exa MCP/);
  assert.match(formatted, /Exa docs/);
  assert.match(formatted, /https:\/\/exa.ai\/docs/);
});
