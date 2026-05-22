import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { setDefaultTimeout, test } from "bun:test";
import { createWorkflowFixture, listWorkflowCommunityCases, listWorkflowEvalCases, listWorkflowHoldoutCases, selectWorkflowPrompt } from "../evals/workflow-cases.ts";
import { resolveWorkflowShardArgs } from "../evals/workflow-sharded.eval.ts";
import { assertSdkRunBudget, buildWorkflowJudgePrompt, detectWorkflowInfrastructureFailure, detectWorkflowVerification, evaluateWorkflowRegressionGates, extractFinalText, observeTerminalAssistantAnswer, resolveCaseIds, resolveVariants, resolveWorkflowArgs, resolveWorkflowIdleTimeoutMs, resolveWorkflowInfraRetries, resolveWorkflowRunCount, resolveWorkflowTimeoutMs, shouldRetainWorkflowFixture, shouldRunWorkflowJudge, shouldStoreFullWorkflowOutput, summarizeComparison, summarizeWorkflowFailures, workflowRegressionGatesEnabled, workflowReportFilename, writeWorkflowReport, DEFAULT_WORKFLOW_IDLE_TIMEOUT_MS, MAX_WORKFLOW_RUNS, MAX_WORKFLOW_TIMEOUT_MS } from "../evals/workflow-quality.eval.ts";
import { scoreWorkflowWorkspace } from "../src/workflow-quality.ts";

setDefaultTimeout(60_000);

test("workflow eval case bank covers real task types", () => {
  const kinds = new Set(listWorkflowEvalCases().map((item) => item.kind));
  assert.deepEqual([...kinds].sort(), ["greenfield", "large-feature", "refactor", "scaffold", "small-feature", "test-writing"].sort());
  assert.ok(listWorkflowHoldoutCases().length >= 10);
  assert.deepEqual(new Set(listWorkflowHoldoutCases().map((item) => item.kind)), new Set(["bugfix", "small-feature", "scaffold", "review-only"]));
  assert.ok(listWorkflowHoldoutCases().some((item) => item.id === "holdout-python-slugify"));
  assert.ok(listWorkflowHoldoutCases().some((item) => item.id === "holdout-go-ttl-cache"));
  assert.ok(listWorkflowHoldoutCases().some((item) => item.id === "holdout-docs-runbook"));
  assert.ok(listWorkflowHoldoutCases().every((item) => item.suite === "holdout"));
});

test("workflow community case bank uses synthetic community-inspired projects only", () => {
  const cases = listWorkflowCommunityCases();
  assert.ok(cases.length >= 4);
  assert.ok(cases.every((item) => item.suite === "community"));
  assert.ok(cases.every((item) => item.sourceProfile?.kind === "community-inspired"));
  assert.ok(cases.every((item) => item.sourceProfile?.privateData === false));
  assert.ok(cases.every((item) => selectWorkflowPrompt(item, 0).count >= 3));
});

test("workflow prompt variants rotate deterministically by run index", () => {
  const evalCase = listWorkflowCommunityCases()[0]!;
  const first = selectWorkflowPrompt(evalCase, 0);
  const second = selectWorkflowPrompt(evalCase, 1);
  const wrapped = selectWorkflowPrompt(evalCase, first.count);
  assert.notEqual(first.prompt, second.prompt);
  assert.equal(first.prompt, wrapped.prompt);

  const fixture = createWorkflowFixture(evalCase.id, { promptVariantIndex: 1 });
  try {
    assert.equal(fixture.prompt, second.prompt);
    assert.equal(fixture.promptVariantIndex, 1);
    assert.equal(fixture.promptVariantCount, first.count);
  } finally {
    fs.rmSync(fixture.cwd, { recursive: true, force: true });
  }
});

test("workflow fixtures start with intentionally incomplete work", () => {
  for (const item of listWorkflowEvalCases({ includeHoldout: true, includeCommunity: true })) {
    const fixture = createWorkflowFixture(item.id);
    const report = scoreWorkflowWorkspace(fixture.cwd, fixture.case, { finalText: "" });
    assert.equal(report.pass, false, item.id);
    fs.rmSync(fixture.cwd, { recursive: true, force: true });
  }
});

test("workflow scorer passes a completed small-feature workspace", () => {
  const fixture = createWorkflowFixture("small-feature-search-filter");
  fs.writeFileSync(path.join(fixture.cwd, "src/filterTasks.ts"), `export interface Task { id: string; title: string; description?: string }\nexport function filterTasks(tasks: Task[], query: string): Task[] {\n  const normalized = query.trim().toLowerCase();\n  if (!normalized) return tasks;\n  return tasks.filter((task) => task.title.toLowerCase().includes(normalized) || (task.description ?? "").toLowerCase().includes(normalized));\n}\n`);
  fs.writeFileSync(path.join(fixture.cwd, "test/filterTasks.test.ts"), `import { expect, it } from "bun:test";\nimport { filterTasks } from "../src/filterTasks";\nit("filters by title and description case-insensitively", () => {\n  expect(filterTasks([{ id: "1", title: "Alpha", description: "Roadmap" }], "roadmap")).toHaveLength(1);\n  expect(filterTasks([{ id: "1", title: "Alpha" }], "ALPHA")).toHaveLength(1);\n});\n`);
  const report = scoreWorkflowWorkspace(fixture.cwd, fixture.case, { finalText: "Actualicé src/filterTasks.ts y test/filterTasks.test.ts", durationMs: 1000 });
  assert.equal(report.pass, true);
  assert.ok(report.score >= 80);
  assert.ok(report.metrics.semantic.exportChecksPassed >= 1);
  assert.equal(report.metrics.validation.status, "pass");
  fs.rmSync(fixture.cwd, { recursive: true, force: true });
});

test("workflow scorer accepts descriptive exported helper names for CLI scaffolds", () => {
  const fixture = createWorkflowFixture("scaffold-cli-tool");
  fs.writeFileSync(path.join(fixture.cwd, "package.json"), JSON.stringify({
    name: "note-pack",
    type: "module",
    bin: { "note-pack": "./src/cli.ts" },
    scripts: { test: "bun test" },
  }, null, 2));
  fs.mkdirSync(path.join(fixture.cwd, "src"), { recursive: true });
  fs.mkdirSync(path.join(fixture.cwd, "test"), { recursive: true });
  fs.writeFileSync(path.join(fixture.cwd, "src/cli.ts"), `#!/usr/bin/env bun\nexport function normalizeText(input: string): string { return input.toLowerCase(); }\nexport function main(argv = process.argv.slice(2)): void { process.stdout.write(normalizeText(argv.join(" ")) + "\\n"); }\nif (import.meta.url === \`file://\${process.argv[1]}\`) main();\n`);
  fs.writeFileSync(path.join(fixture.cwd, "test/cli.test.ts"), `import { test } from "bun:test";\nimport assert from "node:assert/strict";\nimport { normalizeText } from "../src/cli.ts";\ntest("normalizes lowercase", () => { assert.equal(normalizeText("HeLLo"), "hello"); });\n`);
  fs.writeFileSync(path.join(fixture.cwd, "README.md"), "# note-pack\n\n## Usage\n\nRun `note-pack HELLO` with Bun after install.\n");
  const report = scoreWorkflowWorkspace(fixture.cwd, fixture.case, {
    finalText: "Changed src/cli.ts, test/cli.test.ts, package.json, README.md. Verification: bun test passed.",
    durationMs: 1000,
    validateTests: true,
  });
  assert.equal(report.pass, true);
  assert.ok(report.matched.includes("semantic:export:src/*.ts"));
  assert.equal(report.metrics.semantic.packageBinTargetPassed, true);
  fs.rmSync(fixture.cwd, { recursive: true, force: true });
});

test("workflow scorer accepts CLI bin adapters separate from exported source module", () => {
  const fixture = createWorkflowFixture("scaffold-cli-tool");
  fs.writeFileSync(path.join(fixture.cwd, "package.json"), JSON.stringify({
    name: "note-pack",
    type: "module",
    bin: { "note-pack": "./bin/note-pack" },
    scripts: { test: "bun test" },
  }, null, 2));
  fs.mkdirSync(path.join(fixture.cwd, "src"), { recursive: true });
  fs.mkdirSync(path.join(fixture.cwd, "bin"), { recursive: true });
  fs.mkdirSync(path.join(fixture.cwd, "test"), { recursive: true });
  fs.writeFileSync(path.join(fixture.cwd, "src/cli.ts"), `export function normalizeText(input: string): string { return input.toLowerCase(); }\n`);
  fs.writeFileSync(path.join(fixture.cwd, "bin/note-pack"), `#!/usr/bin/env bun\nimport { argv } from "node:process";\nimport { normalizeText } from "../src/cli.ts";\nconsole.log(normalizeText(argv.slice(2).join(" ")));\n`);
  fs.writeFileSync(path.join(fixture.cwd, "test/cli.test.ts"), `import { test } from "bun:test";\nimport assert from "node:assert/strict";\nimport { normalizeText } from "../src/cli.ts";\ntest("normalizes lowercase", () => { assert.equal(normalizeText("HeLLo"), "hello"); });\n`);
  fs.writeFileSync(path.join(fixture.cwd, "README.md"), "# note-pack\n\n## Uso\n\nRun `note-pack <texto>` with `bun bin/note-pack HOLA`.\n");
  const report = scoreWorkflowWorkspace(fixture.cwd, fixture.case, {
    finalText: "Changed package.json, src/cli.ts, bin/note-pack, test/cli.test.ts and README.md. Verification: bun test passed.",
    durationMs: 1000,
    validateTests: true,
  });
  assert.equal(report.pass, true);
  assert.equal(report.metrics.semantic.packageBinPassed, true);
  assert.equal(report.metrics.semantic.packageBinTargetPassed, true);
  assert.equal(report.critical.some((issue) => issue.id === "missing-required-content"), false);
  fs.rmSync(fixture.cwd, { recursive: true, force: true });
});

test("workflow scorer recognizes CommonJS module exports in community CLI cases", () => {
  const fixture = createWorkflowFixture("community-cli-env-validator");
  fs.writeFileSync(path.join(fixture.cwd, "package.json"), JSON.stringify({
    name: "validate-env",
    type: "commonjs",
    bin: { "validate-env": "./src/cli.ts" },
    scripts: { test: "bun test" },
  }, null, 2));
  fs.mkdirSync(path.join(fixture.cwd, "src"), { recursive: true });
  fs.mkdirSync(path.join(fixture.cwd, "test"), { recursive: true });
  fs.writeFileSync(path.join(fixture.cwd, "src/cli.ts"), `function getMissingEnvVariables(required, env = process.env) { return required.filter((name) => !env[name]); }\nfunction runCli(argv = process.argv.slice(2), env = process.env) { const missing = getMissingEnvVariables(argv, env); return { code: missing.length ? 1 : 0, output: missing.join(",") }; }\nif (require.main === module) { const result = runCli(); console.log(result.output); process.exit(result.code); }\nmodule.exports = { getMissingEnvVariables, runCli };\n`);
  fs.writeFileSync(path.join(fixture.cwd, "test/cli.test.ts"), `const { test } = require("bun:test");\nconst assert = require("node:assert/strict");\nconst { getMissingEnvVariables, runCli } = require("../src/cli.ts");\ntest("missing and present env vars", () => { assert.deepEqual(getMissingEnvVariables(["API_URL", "TOKEN"], { API_URL: "x" }), ["TOKEN"]); assert.equal(runCli(["API_URL"], { API_URL: "x" }).code, 0); });\n`);
  fs.writeFileSync(path.join(fixture.cwd, "README.md"), "# validate-env\n\n## Usage\n\nRun `validate-env API_URL TOKEN` to validate env variables.\n");
  const report = scoreWorkflowWorkspace(fixture.cwd, fixture.case, {
    finalText: "Changed package.json, src/cli.ts, test/cli.test.ts and README.md. Verification: bun test passed.",
    durationMs: 1000,
    validateTests: true,
  });
  assert.equal(report.pass, true);
  assert.ok(report.matched.includes("semantic:export:src/cli.ts"));
  fs.rmSync(fixture.cwd, { recursive: true, force: true });
});

test("workflow scorer rejects no-op implementation", () => {
  const fixture = createWorkflowFixture("large-feature-rate-limit");
  const report = scoreWorkflowWorkspace(fixture.cwd, fixture.case, { finalText: "done" });
  assert.equal(report.pass, false);
  assert.ok(report.critical.some((issue) => issue.id === "obvious-noop" || issue.id === "missing-required-content"));
  fs.rmSync(fixture.cwd, { recursive: true, force: true });
});

test("workflow scorer does not flag legitimate rate limiter test expectations as no-op", () => {
  const fixture = createWorkflowFixture("large-feature-rate-limit");
  fs.writeFileSync(path.join(fixture.cwd, "src/rateLimit.ts"), `export interface RateLimitResult { allowed: boolean; remaining: number; retryAfterMs: number }\nexport function createRateLimiter(options: { limit: number; windowMs: number; now?: () => number }) {\n  const now = options.now ?? Date.now;\n  const windows = new Map<string, { start: number; count: number }>();\n  return { check(key: string): RateLimitResult {\n    const current = now();\n    const state = windows.get(key);\n    if (!state || current - state.start >= options.windowMs) { windows.set(key, { start: current, count: 1 }); return { allowed: true, remaining: Math.max(0, options.limit - 1), retryAfterMs: 0 }; }\n    if (state.count < options.limit) { state.count += 1; return { allowed: true, remaining: Math.max(0, options.limit - state.count), retryAfterMs: 0 }; }\n    return { allowed: false, remaining: 0, retryAfterMs: Math.max(0, options.windowMs - (current - state.start)) };\n  }};\n}\n`);
  fs.writeFileSync(path.join(fixture.cwd, "test/rateLimit.test.ts"), `import { describe, it } from "bun:test";\nimport assert from "node:assert/strict";\nimport { createRateLimiter } from "../src/rateLimit.ts";\ndescribe("createRateLimiter", () => {\n  it("covers allow block and reset", () => {\n    let current = 0;\n    const limiter = createRateLimiter({ limit: 2, windowMs: 1000, now: () => current });\n    assert.deepEqual(limiter.check("u"), { allowed: true, remaining: 1, retryAfterMs: 0 });\n    assert.equal(limiter.check("u").allowed, true);\n    assert.equal(limiter.check("u").allowed, false);\n    current = 1000;\n    assert.equal(limiter.check("u").allowed, true);\n  });\n});\n`);
  const report = scoreWorkflowWorkspace(fixture.cwd, fixture.case, {
    finalText: "Changed src/rateLimit.ts and test/rateLimit.test.ts. Verification: bun test passed. No external dependencies.",
    durationMs: 1000,
    validateTests: true,
  });
  assert.equal(report.critical.some((issue) => issue.id === "obvious-noop"), false);
  assert.equal(report.pass, true);
  fs.rmSync(fixture.cwd, { recursive: true, force: true });
});

test("workflow scorer accepts spread-copy sorting as non-mutating", () => {
  const fixture = createWorkflowFixture("holdout-small-feature-sort-tasks");
  fs.writeFileSync(path.join(fixture.cwd, "src/sortTasks.ts"), `export type Priority = "low" | "medium" | "high";
export interface Task { id: string; title: string; priority: Priority; dueDate: string }
const priorityOrder: Record<Priority, number> = { high: 0, medium: 1, low: 2 };
export function sortTasks(tasks: Task[]): Task[] {
  return [...tasks].sort((a, b) => {
    const priorityDiff = priorityOrder[a.priority] - priorityOrder[b.priority];
    if (priorityDiff !== 0) return priorityDiff;
    const dueDateDiff = a.dueDate.localeCompare(b.dueDate);
    if (dueDateDiff !== 0) return dueDateDiff;
    return 0;
  });
}
`);
  fs.writeFileSync(path.join(fixture.cwd, "test/sortTasks.test.ts"), `import { describe, it } from "bun:test";
import assert from "node:assert/strict";
import { sortTasks } from "../src/sortTasks.ts";
describe("sortTasks", () => {
  it("sorts by priority, dueDate, preserves stable order, and does not mutate original", () => {
    const tasks = [
      { id: "1", title: "low", priority: "low", dueDate: "2026-05-03" },
      { id: "2", title: "high later", priority: "high", dueDate: "2026-05-05" },
      { id: "3", title: "high earlier", priority: "high", dueDate: "2026-05-01" },
      { id: "4", title: "medium", priority: "medium", dueDate: "2026-05-02" },
      { id: "5", title: "high tie 1", priority: "high", dueDate: "2026-05-01" },
    ] as const;
    const original = [...tasks];
    const sorted = sortTasks(tasks as unknown as Parameters<typeof sortTasks>[0]);
    assert.deepEqual(sorted.map((task) => task.id), ["3", "5", "2", "4", "1"]);
    assert.deepEqual(tasks, original);
    assert.notStrictEqual(sorted, tasks);
  });
});
`);
  const report = scoreWorkflowWorkspace(fixture.cwd, fixture.case, {
    finalText: "Changed src/sortTasks.ts and test/sortTasks.test.ts. Verification: bun test passed.",
    durationMs: 1000,
    validateTests: true,
  });
  assert.equal(report.pass, true);
  assert.ok(report.matched.includes("content:src/sortTasks.ts:does not mutate original array"));
  fs.rmSync(fixture.cwd, { recursive: true, force: true });
});

test("workflow scorer accepts descriptive greenfield test filenames", () => {
  const fixture = createWorkflowFixture("greenfield-token-library");
  fs.mkdirSync(path.join(fixture.cwd, "src"), { recursive: true });
  fs.mkdirSync(path.join(fixture.cwd, "test"), { recursive: true });
  fs.writeFileSync(path.join(fixture.cwd, "package.json"), JSON.stringify({
    name: "token-legible",
    type: "module",
    scripts: { test: "bun test" },
  }, null, 2));
  fs.writeFileSync(path.join(fixture.cwd, "src/index.ts"), `export function createToken(prefix: string, id: string): string {
  if (!prefix.trim() || !id.trim()) throw new Error("prefix and id must not be empty");
  return \`\${prefix}-\${id}\`.toLowerCase();
}
`);
  fs.writeFileSync(path.join(fixture.cwd, "test/token.test.ts"), `import { test } from "bun:test";
import assert from "node:assert/strict";
import { createToken } from "../src/index.ts";
test("creates token", () => assert.equal(createToken("User", "ABC"), "user-abc"));
test("rejects invalid input", () => assert.throws(() => createToken("", "abc")));
`);
  fs.writeFileSync(path.join(fixture.cwd, "README.md"), "# token-legible\n\nUse `createToken(prefix, id)`.\n");
  const report = scoreWorkflowWorkspace(fixture.cwd, fixture.case, {
    finalText: "Changed package.json, src/index.ts, test/token.test.ts, README.md. Verification: bun test passed.",
    durationMs: 1000,
    validateTests: true,
  });
  assert.equal(report.pass, true);
  assert.ok(report.matched.includes("file:test/*.test.ts"));
  assert.ok(report.matched.includes("semantic:test:test/*.test.ts"));
  fs.rmSync(fixture.cwd, { recursive: true, force: true });
});

test("workflow scorer accepts specific Error subclasses for config validation", () => {
  const fixture = createWorkflowFixture("holdout-scaffold-config-loader");
  fs.mkdirSync(path.join(fixture.cwd, "src"), { recursive: true });
  fs.mkdirSync(path.join(fixture.cwd, "test"), { recursive: true });
  fs.writeFileSync(path.join(fixture.cwd, "package.json"), JSON.stringify({
    name: "mini-config-lib",
    type: "module",
    scripts: { test: "bun test" },
  }, null, 2));
  fs.writeFileSync(path.join(fixture.cwd, "src/config.ts"), `export type NodeEnv = "development" | "test" | "production";
export const loadConfig = (env: Record<string, string | undefined>) => {
  const port = env.PORT === undefined ? 3000 : Number(env.PORT);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new RangeError("Invalid PORT");
  const nodeEnv = env.NODE_ENV ?? "development";
  if (!["development", "test", "production"].includes(nodeEnv)) throw new RangeError("Invalid NODE_ENV");
  return { port, nodeEnv };
};
`);
  fs.writeFileSync(path.join(fixture.cwd, "test/config.test.ts"), `import { test } from "bun:test";
import assert from "node:assert/strict";
import { loadConfig } from "../src/config.ts";
test("defaults and validates", () => {
  assert.deepEqual(loadConfig({}), { port: 3000, nodeEnv: "development" });
  assert.equal(loadConfig({ PORT: "8080", NODE_ENV: "production" }).nodeEnv, "production");
  assert.throws(() => loadConfig({ PORT: "0" }), RangeError);
});
`);
  fs.writeFileSync(path.join(fixture.cwd, "README.md"), "# Config\n\nUse `loadConfig` with `PORT`, `NODE_ENV`, default port `3000`.\n");
  const report = scoreWorkflowWorkspace(fixture.cwd, fixture.case, {
    finalText: "Changed package.json, src/config.ts, test/config.test.ts, README.md. Verification: bun test passed.",
    durationMs: 1000,
    validateTests: true,
  });
  assert.equal(report.pass, true);
  fs.rmSync(fixture.cwd, { recursive: true, force: true });
});

test("workflow scorer accepts valid date coverage without hardcoding leap-day literal", () => {
  const fixture = createWorkflowFixture("holdout-bugfix-date-parser");
  fs.writeFileSync(path.join(fixture.cwd, "src/parseDate.ts"), `export function parseIsoDate(value: string): Date | null {
  const match = /^(\\d{4})-(\\d{2})-(\\d{2})$/.exec(value);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  return parsed.getUTCFullYear() === year && parsed.getUTCMonth() === month - 1 && parsed.getUTCDate() === day ? parsed : null;
}
`);
  fs.writeFileSync(path.join(fixture.cwd, "test/parseDate.test.ts"), `import { test } from "bun:test";
import assert from "node:assert/strict";
import { parseIsoDate } from "../src/parseDate.ts";
test("accepts valid ISO dates and rejects impossible dates", () => {
  assert.notEqual(parseIsoDate("2024-12-31"), null);
  assert.equal(parseIsoDate("2024-02-31"), null);
});
`);
  const report = scoreWorkflowWorkspace(fixture.cwd, fixture.case, {
    finalText: "Changed src/parseDate.ts and test/parseDate.test.ts. Verification: bun test passed.",
    durationMs: 1000,
    validateTests: true,
  });
  assert.equal(report.pass, true);
  fs.rmSync(fixture.cwd, { recursive: true, force: true });
});



test("workflow scorer runs dependency-free Python unittest validation", () => {
  const fixture = createWorkflowFixture("holdout-python-slugify");
  fs.writeFileSync(path.join(fixture.cwd, "slugify.py"), `import re

def slugify(text: str) -> str:
    value = re.sub(r"[^a-z0-9]+", "-", text.lower())
    return value.strip("-")
`);
  fs.writeFileSync(path.join(fixture.cwd, "tests/test_slugify.py"), `import unittest
from slugify import slugify

class SlugifyTest(unittest.TestCase):
    def test_punctuation_collapse_and_trim(self):
        self.assertEqual(slugify(" Hello,   Python--World!!! "), "hello-python-world")

if __name__ == "__main__":
    unittest.main()
`);
  const report = scoreWorkflowWorkspace(fixture.cwd, fixture.case, {
    finalText: "Changed slugify.py and tests/test_slugify.py. Verification: python3 -m unittest discover -s tests passed.",
    durationMs: 1000,
    validateTests: true,
  });
  assert.equal(report.metrics.validation.status, "pass");
  assert.match(report.metrics.validation.command ?? "", /python3 -m unittest discover -s tests/);
  assert.equal(report.pass, true);
  fs.rmSync(fixture.cwd, { recursive: true, force: true });
});

test("workflow scorer runs dependency-free Go validation", () => {
  const fixture = createWorkflowFixture("holdout-go-ttl-cache");
  fs.writeFileSync(path.join(fixture.cwd, "cache/cache.go"), `package cache

import "time"

type entry struct {
	value string
	expires time.Time
}

type Cache struct {
	ttl time.Duration
	now func() time.Time
	items map[string]entry
}

func New(ttl time.Duration, now func() time.Time) *Cache {
	if now == nil {
		now = time.Now
	}
	return &Cache{ttl: ttl, now: now, items: map[string]entry{}}
}

func (c *Cache) Set(key string, value string) {
	c.items[key] = entry{value: value, expires: c.now().Add(c.ttl)}
}

func (c *Cache) Get(key string) (string, bool) {
	item, ok := c.items[key]
	if !ok || !c.now().Before(item.expires) {
		delete(c.items, key)
		return "", false
	}
	return item.value, true
}
`);
  fs.writeFileSync(path.join(fixture.cwd, "cache/cache_test.go"), `package cache

import (
	"testing"
	"time"
)

func TestCacheTTLExpiry(t *testing.T) {
	now := time.Unix(0, 0)
	c := New(time.Second, func() time.Time { return now })
	c.Set("k", "v")
	if got, ok := c.Get("k"); !ok || got != "v" {
		t.Fatalf("expected hit before TTL")
	}
	now = now.Add(2 * time.Second)
	if _, ok := c.Get("k"); ok {
		t.Fatal("expected expired TTL miss")
	}
}
`);
  const report = scoreWorkflowWorkspace(fixture.cwd, fixture.case, {
    finalText: "Changed cache/cache.go and cache/cache_test.go. Verification: go test ./... passed.",
    durationMs: 1000,
    validateTests: true,
  });
  assert.equal(report.metrics.validation.status, "pass");
  assert.match(report.metrics.validation.command ?? "", /go test \.\/\.\.\./);
  assert.equal(report.pass, true);
  fs.rmSync(fixture.cwd, { recursive: true, force: true });
});





test("workflow scorer rejects docs-only cases that add test/code artifacts", () => {
  const fixture = createWorkflowFixture("holdout-docs-runbook");
  fs.mkdirSync(path.join(fixture.cwd, "test"), { recursive: true });
  fs.writeFileSync(path.join(fixture.cwd, "test/sync.test.ts"), `import { test } from "bun:test";
test("extra", () => {});
`);
  fs.writeFileSync(path.join(fixture.cwd, "docs/runbook.md"), `# Sync Runbook

Run \`bun test\`. Diagnostic and diagnóstico steps for sync in src/sync.ts. Rollback with git restore and verify package.json.
`);
  const report = scoreWorkflowWorkspace(fixture.cwd, fixture.case, {
    finalText: "Changed docs/runbook.md. Verification: bun test. Rollback documented.",
    durationMs: 1000,
    validateTests: false,
  });
  assert.equal(report.pass, false);
  assert.ok(report.critical.some((issue) => issue.id === "forbidden-file"));
  fs.rmSync(fixture.cwd, { recursive: true, force: true });
});

test("workflow scorer accepts docs runbook that documents bun run test", () => {
  const fixture = createWorkflowFixture("holdout-docs-runbook");
  fs.writeFileSync(path.join(fixture.cwd, "docs/runbook.md"), `# Sync Runbook

Run \`bun run test\`. Diagnostic and diagnóstico steps for sync in src/sync.ts. Rollback with git restore and verify package.json.
`);
  const report = scoreWorkflowWorkspace(fixture.cwd, fixture.case, {
    finalText: "Changed docs/runbook.md. Documented bun run test and rollback. Verification: documentation only.",
    durationMs: 1000,
    validateTests: false,
  });
  assert.equal(report.pass, true);
  fs.rmSync(fixture.cwd, { recursive: true, force: true });
});

test("workflow validation fails when Bun test command executes zero tests", () => {
  const fixture = createWorkflowFixture("scaffold-cli-tool");
  fs.writeFileSync(path.join(fixture.cwd, "package.json"), JSON.stringify({
    name: "note-pack",
    type: "module",
    scripts: { test: "bun test" },
  }, null, 2));
  fs.mkdirSync(path.join(fixture.cwd, "src"), { recursive: true });
  fs.writeFileSync(path.join(fixture.cwd, "src/cli.ts"), `export function normalizeText(input: string): string { return input.toLowerCase(); }
`);
  const report = scoreWorkflowWorkspace(fixture.cwd, fixture.case, {
    finalText: "Changed package.json and src/cli.ts. Verification: bun test passed.",
    durationMs: 1000,
    validateTests: true,
  });
  assert.equal(report.metrics.validation.status, "fail");
  assert.match(report.metrics.validation.reason ?? "", /zero tests|missing expected test artifact/);
  assert.equal(report.pass, false);
  fs.rmSync(fixture.cwd, { recursive: true, force: true });
});

test("workflow eval CLI helpers keep live runs bounded", () => {
  assert.equal(resolveWorkflowTimeoutMs("999999"), MAX_WORKFLOW_TIMEOUT_MS);
  assert.equal(resolveWorkflowTimeoutMs("1500"), 1500);
  assert.equal(resolveWorkflowRunCount("999"), MAX_WORKFLOW_RUNS);
  assert.equal(resolveWorkflowRunCount("3"), 3);
  assert.equal(resolveWorkflowIdleTimeoutMs(undefined), DEFAULT_WORKFLOW_IDLE_TIMEOUT_MS);
  assert.equal(resolveWorkflowIdleTimeoutMs("1000"), 5000);
  assert.equal(resolveWorkflowIdleTimeoutMs("999999", 60_000), 59_000);
  assert.equal(resolveWorkflowInfraRetries(undefined), 1);
  assert.equal(resolveWorkflowInfraRetries("99"), 2);
  assert.equal(resolveWorkflowInfraRetries("0"), 0);
  assert.deepEqual(resolveVariants(undefined), ["simple", "mesh"]);
  assert.deepEqual(resolveVariants("mesh"), ["mesh"]);
  assert.ok(resolveCaseIds("all").length >= 6);
  assert.deepEqual(resolveCaseIds("holdout"), listWorkflowHoldoutCases().map((item) => item.id));
  assert.deepEqual(resolveCaseIds("community"), listWorkflowCommunityCases().map((item) => item.id));
  assert.ok(resolveCaseIds("all-with-holdout").length >= 10);
  assert.ok(resolveCaseIds("all-realistic").length > resolveCaseIds("all-with-holdout").length);
  assert.deepEqual(resolveCaseIds("a,b"), ["a", "b"]);
});

test("workflow presets expand long package scripts without environment variables", () => {
  const matrix = resolveWorkflowArgs({ preset: "matrix" });
  assert.equal(matrix.mode, "sdk");
  assert.equal(matrix.case, "all-with-holdout");
  assert.equal(matrix.allowMulti, "1");
  assert.equal(matrix.allowLong, "1");
  assert.equal(matrix.gates, "1");
  assert.equal(matrix.model, "openai-codex/gpt-5.3-codex-spark");
  assert.equal(matrix.thinking, "low");
  assert.equal(matrix.matrixPath, "evals/results/workflow-quality-full-matrix.jsonl");
  assert.equal(resolveWorkflowArgs({ preset: "matrix", runs: "1" }).runs, "1");

  const community = resolveWorkflowArgs({ preset: "community" });
  assert.equal(community.case, "community");
  assert.equal(community.allowLong, "1");
  assert.equal(community.matrixPath, "evals/results/workflow-quality-community-matrix.jsonl");

  const sharded = resolveWorkflowShardArgs({ preset: "community" });
  assert.equal(sharded.case, "community");
  assert.equal(sharded.runs, "3");
  assert.equal(sharded.matrixPath, "evals/results/workflow-quality-community-sharded-matrix.jsonl");
  assert.equal(resolveWorkflowShardArgs({ preset: "community", concurrency: "2" }).concurrency, "2");

  assert.throws(() => resolveWorkflowArgs({ preset: "unknown" }), /Unsupported workflow preset/);
  assert.throws(() => resolveWorkflowShardArgs({ preset: "unknown" }), /Unsupported workflow shard preset/);
});

test("workflow SDK budget guard rejects accidental long matrices", () => {
  assert.throws(() => assertSdkRunBudget({
    caseIds: resolveCaseIds("all-with-holdout"),
    variants: ["simple", "mesh"],
    runs: 3,
    timeoutMs: 30_000,
    args: {},
  }), /Refusing long SDK matrix by default/);
  assert.doesNotThrow(() => assertSdkRunBudget({
    caseIds: ["large-feature-rate-limit"],
    variants: ["mesh"],
    runs: 3,
    timeoutMs: 30_000,
    args: {},
  }));
  assert.doesNotThrow(() => assertSdkRunBudget({
    caseIds: resolveCaseIds("all-with-holdout"),
    variants: ["simple", "mesh"],
    runs: 3,
    timeoutMs: 30_000,
    args: { allowLong: "1" },
  }));
});

test("workflow report filenames include case variant run and unique token", () => {
  const filename = workflowReportFilename({
    startedAt: "2026-05-20T22:47:43.785Z",
    mode: "sdk",
    cases: ["holdout-scaffold-config-loader"],
    variants: ["mesh"],
    runs: 3,
    token: "pid-1234",
  });
  assert.equal(filename, "workflow-quality-2026-05-20T22-47-43-785Z-sdk-holdout-scaffold-config-loader-mesh-r3-pid-1234.json");
});

test("workflow report writer uses exclusive creation and retries on collision", () => {
  const reportDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-chalin-report-"));
  const report = {
    startedAt: "2026-05-20T22:47:43.785Z",
    mode: "sdk",
    cases: ["add-unit-test-edge-case"],
    variants: ["mesh"] as const,
    runs: 3,
  };
  const first = writeWorkflowReport(reportDir, report, { tokenFactory: () => "same-token", content: "first\n" });
  const second = writeWorkflowReport(reportDir, report, {
    tokenFactory: (attempt) => attempt === 0 ? "same-token" : "same-token-retry",
    content: "second\n",
  });
  assert.notEqual(first, second);
  assert.equal(fs.readFileSync(first, "utf-8"), "first\n");
  assert.equal(fs.readFileSync(second, "utf-8"), "second\n");
  assert.equal(fs.readdirSync(reportDir).length, 2);
  fs.rmSync(reportDir, { recursive: true, force: true });
});

test("workflow regression gates catch direct-eligible mesh route regressions", () => {
  assert.equal(workflowRegressionGatesEnabled({ gates: "1" }), true);
  assert.equal(workflowRegressionGatesEnabled({}), false);
  const output = {
    variant: "mesh",
    runIndex: 1,
    workspace: { caseId: "refactor-pricing", pass: true, score: 100 },
    trace: { pass: true, score: 100, warnings: [], critical: [] },
    diagnostics: {
      infrastructureFailure: undefined,
      finalAnswerMissing: false,
      objectiveStopReason: undefined,
      duplicateToolCalls: 0,
      meshRouteCalls: 1,
      meshRouteNonExecutable: 1,
    },
    judge: undefined,
  } as never;
  const gates = evaluateWorkflowRegressionGates([output], [{
    caseId: "refactor-pricing",
    pass: true,
    reason: "ok",
    variants: { mesh: { passRate: 1, avgWorkspaceScore: 100, avgTraceScore: 100, p95DurationMs: 1_000 } },
  }] as never);
  assert.equal(gates.pass, false);
  assert.ok(gates.failures.some((item) => /direct-eligible case called mesh_route/.test(item)));
});

test("workflow regression gates treat simple baseline failures as warnings", () => {
  const baselineFailure = {
    variant: "simple",
    runIndex: 1,
    workspace: { caseId: "large-feature-rate-limit", pass: false, score: 63 },
    trace: { pass: false, score: 0, warnings: [], critical: [{ id: "missing-answer" }] },
    diagnostics: {
      infrastructureFailure: undefined,
      finalAnswerMissing: true,
      objectiveStopReason: undefined,
      duplicateToolCalls: 0,
      meshRouteCalls: 0,
      meshRouteNonExecutable: 0,
    },
    judge: undefined,
  } as never;
  const gates = evaluateWorkflowRegressionGates([baselineFailure], [{
    caseId: "large-feature-rate-limit",
    pass: true,
    reason: "mesh beats flaky baseline",
    variants: { simple: { passRate: 0, avgWorkspaceScore: 63, avgTraceScore: 0, p95DurationMs: 30_000 }, mesh: { passRate: 1, avgWorkspaceScore: 94, avgTraceScore: 100, p95DurationMs: 20_000 } },
  }] as never);
  assert.equal(gates.pass, true);
  assert.equal(gates.failures.length, 0);
  assert.ok(gates.warnings.some((item) => /simple large-feature-rate-limit#1: output did not pass/.test(item)));
});

test("workflow regression gates fail mesh runs that never execute verification", () => {
  const missingVerification = {
    variant: "mesh",
    runIndex: 1,
    workspace: { caseId: "holdout-scaffold-config-loader", pass: true, score: 100 },
    trace: { pass: true, score: 100, warnings: [], critical: [] },
    diagnostics: {
      infrastructureFailure: undefined,
      finalAnswerMissing: false,
      verificationPassed: false,
      duplicateToolCalls: 0,
      meshRouteCalls: 0,
      meshRouteNonExecutable: 0,
    },
    judge: undefined,
  } as never;
  const gates = evaluateWorkflowRegressionGates([missingVerification], [{
    caseId: "holdout-scaffold-config-loader",
    pass: true,
    reason: "workspace-only pass is insufficient",
    variants: { mesh: { passRate: 1, avgWorkspaceScore: 100, avgTraceScore: 100, p95DurationMs: 10_000 } },
  }] as never);
  assert.equal(gates.pass, false);
  assert.ok(gates.failures.some((item) => /did not execute a passing verification command/.test(item)));
});

test("workflow comparison allows small quality and p95 variance when mesh still passes strongly", () => {
  const gates = evaluateWorkflowRegressionGates([], [{
    caseId: "holdout-bugfix-date-parser",
    pass: true,
    reason: "mesh within tolerance",
    variants: {
      simple: { passRate: 1, avgWorkspaceScore: 100, avgTraceScore: 100, p95DurationMs: 14_601 },
      mesh: { passRate: 1, avgWorkspaceScore: 97, avgTraceScore: 100, p95DurationMs: 25_355 },
    },
  }] as never);
  assert.equal(gates.pass, true);
});

test("workflow regression gates warn on recovered-infra p95 when all mesh runs pass", () => {
  const outputs = [
    {
      variant: "mesh",
      runIndex: 1,
      workspace: { caseId: "community-react-debounce-hook", pass: true, score: 100 },
      trace: { pass: true, score: 100, warnings: [], critical: [] },
      diagnostics: {
        recoveredInfrastructureFailures: [{ kind: "agent-stall", message: "workflow variant timeout after 45000ms" }],
        infrastructureFailure: undefined,
        finalAnswerMissing: false,
        verificationPassed: true,
        duplicateToolCalls: 0,
        meshRouteCalls: 0,
        meshRouteNonExecutable: 0,
      },
      judge: undefined,
    },
  ] as never;
  const gates = evaluateWorkflowRegressionGates(outputs, [{
    caseId: "community-react-debounce-hook",
    pass: true,
    reason: "all quality checks passed",
    variants: { mesh: { passRate: 1, avgWorkspaceScore: 100, avgTraceScore: 100, p95DurationMs: 64_000 } },
  }] as never);
  assert.equal(gates.pass, true);
  assert.ok(gates.warnings.some((item) => /p95 .* recovered infrastructure retry/.test(item)));
});

test("workflow comparison does not fail p95 solely from a recovered infrastructure retry", () => {
  const output = (variant: "simple" | "mesh", runIndex: number, durationMs: number, recovered = false) => ({
    variant,
    runIndex,
    durationMs,
    workspace: { caseId: "community-node-webhook-verifier", pass: true, score: 100 },
    trace: { pass: true, score: 100, warnings: [], critical: [] },
    diagnostics: {
      recoveredInfrastructureFailures: recovered ? [{ kind: "agent-stall", message: "workflow variant timeout after 45000ms" }] : undefined,
      infrastructureFailure: undefined,
      finalAnswerMissing: false,
      verificationPassed: true,
      duplicateToolCalls: 0,
      meshRouteCalls: 0,
      meshRouteNonExecutable: 0,
      toolEvents: 1,
      readCalls: 0,
      writeCalls: 0,
      editCalls: 0,
      retries: 0,
      tokenTotal: 0,
    },
    judge: undefined,
  });
  const grouped = summarizeComparison([
    output("simple", 1, 8_000),
    output("simple", 2, 9_000),
    output("simple", 3, 12_000),
    output("mesh", 1, 8_500),
    output("mesh", 2, 9_500),
    output("mesh", 3, 40_000, true),
  ] as never);

  assert.equal(grouped[0]?.pass, true);
  assert.match(grouped[0]?.reason ?? "", /meshP95RecoveredInfra=true/);
});

test("workflow fixture retention keeps failed SDK workspaces for root-cause analysis", () => {
  const passing = {
    workspace: { pass: true },
    trace: { pass: true, critical: [] },
    diagnostics: { infrastructureFailure: undefined },
    judge: undefined,
  } as never;
  const failing = {
    workspace: { pass: false },
    trace: { pass: true, critical: [] },
    diagnostics: { infrastructureFailure: undefined },
    judge: undefined,
  } as never;
  assert.equal(shouldRetainWorkflowFixture(passing, {}), false);
  assert.equal(shouldRetainWorkflowFixture(failing, {}), true);
  assert.equal(shouldRetainWorkflowFixture(failing, { PI_CHALIN_WORKFLOW_KEEP_FAILED_FIXTURE: "0" }), false);
  assert.equal(shouldRetainWorkflowFixture(passing, { PI_CHALIN_WORKFLOW_KEEP_FIXTURE: "1" }), true);
});





test("workflow failure UX summarizes what happened and the next step", () => {
  const failures = summarizeWorkflowFailures([{
    variant: "mesh",
    runIndex: 2,
    retainedFixturePath: "/tmp/pi-chalin-fixture",
    workspace: { caseId: "holdout-scaffold-config-loader", pass: true, score: 100 },
    trace: { pass: false, score: 75, critical: [] },
    diagnostics: {
      infrastructureFailure: undefined,
      finalAnswerMissing: true,
      verificationPassed: true,
      duplicateToolCalls: 0,
    },
    judge: undefined,
  } as never]) as Array<{ mode: string; userMessage: string; nextStep: string; retainedFixturePath?: string }>;

  assert.equal(failures.length, 1);
  assert.equal(failures[0]?.mode, "final-answer-evidence");
  assert.match(failures[0]?.userMessage ?? "", /trace\/final-answer evidence|final-answer evidence|evidence/i);
  assert.match(failures[0]?.nextStep ?? "", /Inspect retained fixture/);
  assert.equal(failures[0]?.retainedFixturePath, "/tmp/pi-chalin-fixture");
});

test("workflow reports keep full output for failed SDK runs by default", () => {
  const passing = {
    workspace: { caseId: "holdout-scaffold-config-loader", pass: true },
    trace: { pass: true, critical: [] },
    diagnostics: { infrastructureFailure: undefined, finalAnswerMissing: false, verificationPassed: true },
    judge: undefined,
  } as never;
  const failing = {
    workspace: { caseId: "holdout-scaffold-config-loader", pass: false },
    trace: { pass: false, critical: [{ id: "timeout" }] },
    diagnostics: { infrastructureFailure: undefined, finalAnswerMissing: true, verificationPassed: false },
    judge: undefined,
  } as never;
  assert.equal(shouldStoreFullWorkflowOutput(passing, {}), false);
  assert.equal(shouldStoreFullWorkflowOutput(failing, {}), true);
  assert.equal(shouldStoreFullWorkflowOutput(failing, { PI_CHALIN_WORKFLOW_STORE_FAILED_OUTPUT: "0" }), false);
  assert.equal(shouldStoreFullWorkflowOutput(passing, { PI_CHALIN_WORKFLOW_STORE_FULL_OUTPUT: "1" }), true);
});

test("workflow diagnostics classify provider failures as infrastructure", () => {
  const stdout = [
    JSON.stringify({ type: "message_start", message: { role: "assistant", content: [], stopReason: "error", errorMessage: "400 {\"type\":\"error\",\"error\":{\"type\":\"invalid_request_error\",\"message\":\"This organization has been disabled.\"}}" } }),
    JSON.stringify({ type: "message_end", message: { role: "assistant", content: [], stopReason: "error", errorMessage: "400 invalid_request_error" } }),
  ].join("\n");
  const failure = detectWorkflowInfrastructureFailure(stdout);
  assert.equal(failure?.kind, "provider-error");
  assert.match(failure?.message ?? "", /organization has been disabled|invalid_request_error/i);
});

test("workflow diagnostics classify SDK idle stalls as infrastructure", () => {
  const failure = detectWorkflowInfrastructureFailure("", "", "workflow idle timeout after 25000ms without SDK events");
  assert.equal(failure?.kind, "agent-stall");
  assert.match(failure?.message ?? "", /idle timeout/i);
});

test("workflow diagnostics classify bounded variant timeouts as retryable infrastructure", () => {
  const failure = detectWorkflowInfrastructureFailure("", "", "workflow variant timeout after 45000ms");
  assert.equal(failure?.kind, "agent-stall");
  assert.match(failure?.message ?? "", /variant timeout/i);
});

test("workflow runner only treats terminal assistant events as final answers", () => {
  const partial = observeTerminalAssistantAnswer(JSON.stringify({
    type: "message_update",
    assistantMessageEvent: { type: "text_delta", delta: "Hecho." },
  }) + "\n");
  assert.equal(partial.terminalAnswer, false);
  assert.equal(extractFinalText(JSON.stringify({
    type: "message_update",
    assistantMessageEvent: { type: "text_delta", delta: "Hecho parcial" },
  }) + "\n"), "");

  const terminal = observeTerminalAssistantAnswer(JSON.stringify({
    type: "message_end",
    message: { role: "assistant", content: [{ type: "text", text: "Hecho.\n\n- Verification: `bun test` passed" }] },
  }) + "\n");
  assert.equal(terminal.terminalAnswer, true);
  assert.equal(extractFinalText(JSON.stringify({
    type: "message_end",
    message: { role: "assistant", content: [{ type: "text", text: "Hecho final" }] },
  }) + "\n"), "Hecho final");

  const toolUseEnd = JSON.stringify({
    type: "message_end",
    message: {
      role: "assistant",
      stopReason: "toolUse",
      content: [{ type: "text", text: JSON.stringify({ path: "src/parseDate.ts", oldText: "x", newText: "y" }) }],
    },
  }) + "\n";
  assert.equal(observeTerminalAssistantAnswer(toolUseEnd).terminalAnswer, false);
  assert.equal(extractFinalText(toolUseEnd), "");

  const rawToolArgsTextEnd = JSON.stringify({
    type: "message_update",
    assistantMessageEvent: { type: "text_end", content: JSON.stringify({ path: "src/parseDate.ts", oldText: "x", newText: "y" }) },
  }) + "\n";
  assert.equal(observeTerminalAssistantAnswer(rawToolArgsTextEnd).terminalAnswer, false);
  assert.equal(extractFinalText(rawToolArgsTextEnd), "");
});

test("workflow verification detector requires a passing verification bash call", () => {
  const stdout = [
    JSON.stringify({ type: "tool_execution_start", toolName: "bash", args: { command: "bun test" } }),
    JSON.stringify({ type: "tool_execution_end", toolName: "bash", isError: false, result: { content: "pass" } }),
  ].join("\n");
  assert.deepEqual(detectWorkflowVerification(stdout), { passed: true, calls: 1 });

  const failed = [
    JSON.stringify({ type: "tool_execution_start", toolName: "bash", args: { command: "bun test" } }),
    JSON.stringify({ type: "tool_execution_end", toolName: "bash", isError: true, result: { content: "fail" } }),
  ].join("\n");
  assert.deepEqual(detectWorkflowVerification(failed), { passed: false, calls: 1 });

  const nonVerification = [
    JSON.stringify({ type: "tool_execution_start", toolName: "bash", args: { command: "pwd" } }),
    JSON.stringify({ type: "tool_execution_end", toolName: "bash", isError: false, result: { content: "/tmp" } }),
  ].join("\n");
  assert.deepEqual(detectWorkflowVerification(nonVerification), { passed: false, calls: 0 });
});

test("workflow judge auto mode only triggers for ambiguous deterministic passes", () => {
  const fixture = createWorkflowFixture("small-feature-search-filter");
  fs.writeFileSync(path.join(fixture.cwd, "src/filterTasks.ts"), `export interface Task { id: string; title: string; description?: string }\nexport function filterTasks(tasks: Task[], query: string): Task[] { return tasks.filter((task) => task.title.toLowerCase().includes(query.toLowerCase()) || (task.description ?? "").toLowerCase().includes(query.toLowerCase())); }\n`);
  fs.writeFileSync(path.join(fixture.cwd, "test/filterTasks.test.ts"), `import { expect, it } from "bun:test";\nimport { filterTasks } from "../src/filterTasks";\nit("filters by title and description case-insensitively", () => { expect(filterTasks([{ id: "1", title: "Alpha", description: "Roadmap" }], "roadmap")).toHaveLength(1); });\n`);
  const workspace = scoreWorkflowWorkspace(fixture.cwd, fixture.case, { finalText: "src/filterTasks.ts test/filterTasks.test.ts" });
  const output = { workspace, trace: { pass: true, score: 100, warnings: [] }, diagnostics: { jsonEvents: 0, toolEvents: 0, toolCallsByName: {}, duplicateToolCalls: 0, readCalls: 0, writeCalls: 0, editCalls: 0, retries: 0, tokenTotal: 0 } } as unknown as Parameters<typeof shouldRunWorkflowJudge>[0];
  assert.equal(shouldRunWorkflowJudge(output), workspace.metrics.validation.status === "skipped");
  const prompt = buildWorkflowJudgePrompt({ variant: "mesh", finalText: "done", workspace, trace: output.trace, diagnostics: output.diagnostics } as unknown as never, fixture.case);
  assert.match(prompt, /SOLO JSON/);
  fs.rmSync(fixture.cwd, { recursive: true, force: true });
});

test("workflow matrix sharding partitions cases deterministically and skips empty shards", async () => {
  const { partitionWorkflowCases, selectWorkflowShard } = await import("../evals/workflow-matrix.ts");
  const shards = partitionWorkflowCases(["a", "b", "c", "d", "e"], 3);
  assert.deepEqual(shards.map((item) => item.caseIds), [["a", "d"], ["b", "e"], ["c"]]);
  assert.equal(selectWorkflowShard(["a", "b", "c", "d", "e"], 3, 2).caseIds.join(","), "b,e");
  assert.throws(() => selectWorkflowShard(["a"], 3, 3), /has no cases/);
});

test("workflow matrix aggregate uses latest row per case and reports variant efficiency", async () => {
  const { summarizeWorkflowMatrixRows } = await import("../evals/workflow-matrix.ts");
  const aggregate = summarizeWorkflowMatrixRows([
    {
      caseId: "case-a",
      pass: false,
      stats: { mesh: { runs: 1, passCount: 0, passRate: 0, avgWorkspaceScore: 60, p95DurationMs: 40_000, totalTokens: 10, estimatedCostUsd: 0.1, infrastructureFailures: 1 } },
    },
    {
      caseId: "case-a",
      pass: true,
      stats: { mesh: { runs: 3, passCount: 3, passRate: 1, avgWorkspaceScore: 100, p95DurationMs: 20_000, totalTokens: 90, estimatedCostUsd: 0.9, infrastructureFailures: 0 } },
      regressionGates: { pass: true, warnings: ["recovered infra"] },
    },
    {
      caseId: "case-b",
      pass: true,
      stats: { simple: { runs: 3, passCount: 2, passRate: 0.667, avgWorkspaceScore: 88, p95DurationMs: 30_000, totalTokens: 60, estimatedCostUsd: 0.6, infrastructureFailures: 0 } },
    },
  ]);

  assert.equal(aggregate.pass, true);
  assert.equal(aggregate.cases, 2);
  assert.equal(aggregate.variants.mesh?.runs, 3);
  assert.equal(aggregate.variants.mesh?.passRate, 1);
  assert.equal(aggregate.variants.mesh?.p95DurationMs, 20_000);
  assert.equal(aggregate.variants.simple?.passRate, 0.667);
  assert.deepEqual(aggregate.warnings, ["case-a: recovered infra"]);
});

test("workflow matrix aggregate does not spread shard-level gate failure across passing case rows", async () => {
  const { summarizeWorkflowMatrixRows } = await import("../evals/workflow-matrix.ts");
  const aggregate = summarizeWorkflowMatrixRows([
    {
      caseId: "case-a",
      pass: true,
      stats: { mesh: { runs: 3, passCount: 3, passRate: 1, avgWorkspaceScore: 100, p95DurationMs: 10_000, totalTokens: 10, estimatedCostUsd: 0.1 } },
      regressionGates: { pass: false, failures: ["case-b failed in same shard"] },
    },
    {
      caseId: "case-b",
      pass: false,
      stats: { mesh: { runs: 3, passCount: 2, passRate: 0.667, avgWorkspaceScore: 80, p95DurationMs: 20_000, totalTokens: 20, estimatedCostUsd: 0.2 } },
      regressionGates: { pass: false, failures: ["case-b failed"] },
    },
  ]);

  assert.equal(aggregate.pass, false);
  assert.deepEqual(aggregate.failedCases, ["case-b"]);
});
