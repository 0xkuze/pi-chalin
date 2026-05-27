import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { setDefaultTimeout, test } from "bun:test";
import { WORKFLOW_ORACLE_DIR, createWorkflowFixture, getWorkflowEvalCase, listWorkflowCommunityCases, listWorkflowComplexCases, listWorkflowEvalCases, listWorkflowHoldoutCases, selectWorkflowPrompt } from "../evals/workflow-cases.ts";
import { resolveWorkflowShardArgs } from "../evals/workflow-sharded.eval.ts";
import { assertSdkRunBudget, auditWorkflowProductionFastPaths, auditWorkflowTraceForCheating, buildWorkflowComparativeJudgePrompt, buildWorkflowJudgePrompt, collectWorkflowEvidence, detectWorkflowInfrastructureFailure, detectWorkflowVerification, effectiveWorkflowFinalText, evaluateWorkflowRegressionGates, extractFinalText, extractTokenTotal, extractWorkflowUsage, observeTerminalAssistantAnswer, parseJsonObjectFromText, resolveCaseIds, resolveComparativeJudgeMode, resolveGentlePiRoot, resolveVariants, resolveWorkflowArgs, resolveWorkflowIdleTimeoutMs, resolveWorkflowInfraRetries, resolveWorkflowRunCount, resolveWorkflowThinking, resolveWorkflowTimeoutMs, shouldRequireChalinRoute, shouldRetainWorkflowFixture, shouldRunWorkflowJudge, shouldStoreFullWorkflowOutput, summarizeComparison, summarizeWorkflowFailures, toolsForWorkflowVariant, workflowDiagnostics, workflowRegressionGatesEnabled, workflowReportFilename, writeWorkflowReport, DEFAULT_WORKFLOW_IDLE_TIMEOUT_MS, MAX_WORKFLOW_RUNS, MAX_WORKFLOW_TIMEOUT_MS } from "../evals/workflow-quality.eval.ts";
import { scoreWorkflowWorkspace } from "../evals/workflow-quality-lib.ts";

setDefaultTimeout(60_000);

function comparativeJudgeVerdict(caseId: string, candidates: Array<{
  variant: "simple" | "chalin" | "gentle";
  durationMs: number;
  tokens: number;
  toolCalls?: number;
  deterministicPass?: boolean;
  workspaceScore?: number;
  traceScore?: number;
  judgeScore?: number;
}>, winnerVariant: "simple" | "chalin" | "gentle" = "chalin") {
  const labeled = candidates.map((candidate, index) => ({ ...candidate, label: String.fromCharCode(65 + index) }));
  const winner = labeled.find((candidate) => candidate.variant === winnerVariant) ?? labeled[0]!;
  const ranking = [
    winner.label,
    ...labeled.filter((candidate) => candidate.label !== winner.label).map((candidate) => candidate.label),
  ];
  const scores = Object.fromEntries(ranking.map((label, index) => [label, 100 - index]));
  const targetLabel = labeled.find((candidate) => candidate.variant === "chalin")?.label;
  return {
    caseId,
    runIndex: 1,
    target: "chalin",
    candidates: labeled.map((candidate) => ({
      label: candidate.label,
      variant: candidate.variant,
      deterministicPass: candidate.deterministicPass ?? true,
      workspaceScore: candidate.workspaceScore ?? 100,
      traceScore: candidate.traceScore ?? 100,
      judgeScore: candidate.judgeScore,
      durationMs: candidate.durationMs,
      tokens: candidate.tokens,
      toolCalls: candidate.toolCalls,
    })),
    winnerLabel: winner.label,
    winnerVariant: winner.variant,
    ranking,
    scores,
    targetWins: winner.variant === "chalin",
    targetRank: targetLabel ? ranking.indexOf(targetLabel) + 1 : undefined,
    verdict: winner.variant === "chalin" ? "target produced the stronger output" : "competitor produced the stronger output",
    critical: [],
    warnings: [],
  } as never;
}

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

test("workflow complex case bank covers varied real-OSS-inspired surfaces", () => {
  const cases = listWorkflowComplexCases();
  const ids = cases.map((item) => item.id);
  const kinds = new Set(cases.map((item) => item.kind));
  const inspirations = cases.flatMap((item) => item.sourceProfile?.inspiredBy ?? []).join(" ");

  assert.ok(cases.length >= 8);
  assert.ok(cases.every((item) => item.suite === "complex"));
  assert.ok(cases.every((item) => item.sourceProfile?.kind === "real-oss-inspired"));
  assert.ok(cases.every((item) => item.sourceProfile?.privateData === false));
  assert.ok(kinds.has("review-only"));
  assert.ok(kinds.has("bugfix"));
  assert.ok(kinds.has("large-feature"));
  assert.ok(ids.some((id) => id.includes("bun-zig-rust")));
  assert.ok(ids.some((id) => id.includes("uv-rust")));
  assert.ok(ids.some((id) => id.includes("sqlite-c")));
  assert.ok(ids.some((id) => id.includes("redis-c")));
  assert.match(inspirations, /Bun/);
  assert.match(inspirations, /uv/);
  assert.match(inspirations, /SQLite|Redis|CPython|LLVM/);
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
  for (const item of listWorkflowEvalCases({ includeHoldout: true, includeCommunity: true, includeComplex: true })) {
    const fixture = createWorkflowFixture(item.id);
    const report = scoreWorkflowWorkspace(fixture.cwd, fixture.case, { finalText: "", validateTests: false });
    assert.equal(report.pass, false, item.id);
    fs.rmSync(fixture.cwd, { recursive: true, force: true });
  }
});

test("workflow fixtures keep oracle markers outside the visible task workspace", () => {
  const fixture = createWorkflowFixture("small-feature-search-filter");
  try {
    assert.equal(fs.existsSync(path.join(fixture.cwd, WORKFLOW_ORACLE_DIR, "README.md")), false);
    const evidence = collectWorkflowEvidence(fixture.cwd);
    assert.equal(evidence.files.some((item) => item.path.startsWith(WORKFLOW_ORACLE_DIR)), false);
  } finally {
    fs.rmSync(fixture.cwd, { recursive: true, force: true });
  }
});

test("workflow forbidden checks with explicit prompt contracts are visible to agents", () => {
  for (const item of listWorkflowEvalCases({ includeHoldout: true, includeCommunity: true, includeComplex: true })) {
    for (const forbidden of item.expected.forbiddenContent ?? []) {
      for (const pattern of forbidden.promptMustMention ?? []) {
        assert.match(item.prompt, new RegExp(pattern, "i"), `${item.id}: ${forbidden.label}`);
      }
    }
  }
});

test("workflow scorer requires pricing refactor tests for multiple line items", () => {
  const fixture = createWorkflowFixture("refactor-pricing");
  fs.writeFileSync(path.join(fixture.cwd, "src/pricing.ts"), `export interface LineItem { sku: string; quantity: number; unitPriceCents: number }\nexport interface InvoiceInput { items: LineItem[]; discountPercent?: number; taxRatePercent: number }\nfunction calculateLineSubtotal(item: LineItem): number { return item.quantity * item.unitPriceCents; }\nfunction calculateSubtotal(items: LineItem[]): number { return items.reduce((subtotal, item) => subtotal + calculateLineSubtotal(item), 0); }\nfunction calculatePercentageAmount(amountCents: number, percent: number): number { return Math.round(amountCents * (percent / 100)); }\nexport function calculateInvoice(input: InvoiceInput) {\n  const subtotal = calculateSubtotal(input.items);\n  const discount = calculatePercentageAmount(subtotal, input.discountPercent ?? 0);\n  const taxable = subtotal - discount;\n  const tax = calculatePercentageAmount(taxable, input.taxRatePercent);\n  const total = taxable + tax;\n  return { subtotal, discount, tax, total };\n}\n`);
  fs.writeFileSync(path.join(fixture.cwd, "test/pricing.test.ts"), `import { describe, it } from "bun:test";\nimport assert from "node:assert/strict";\nimport { calculateInvoice } from "../src/pricing.ts";\n\ndescribe("calculateInvoice", () => {\n  it("calculates totals with discount and tax", () => {\n    assert.deepEqual(calculateInvoice({ items: [{ sku: "book", quantity: 2, unitPriceCents: 1000 }], discountPercent: 10, taxRatePercent: 8 }), { subtotal: 2000, discount: 200, tax: 144, total: 1944 });\n  });\n  it("defaults missing discount to zero", () => {\n    assert.deepEqual(calculateInvoice({ items: [{ sku: "pen", quantity: 3, unitPriceCents: 199 }], taxRatePercent: 5 }), { subtotal: 597, discount: 0, tax: 30, total: 627 });\n  });\n  it("rounds discount and tax percentages", () => {\n    assert.deepEqual(calculateInvoice({ items: [{ sku: "sticker", quantity: 1, unitPriceCents: 999 }], discountPercent: 12.5, taxRatePercent: 7.25 }), { subtotal: 999, discount: 125, tax: 63, total: 937 });\n  });\n});\n`);
  const report = scoreWorkflowWorkspace(fixture.cwd, fixture.case, {
    finalText: "Changed src/pricing.ts and test/pricing.test.ts. Verification: bun test passed.",
    durationMs: 1000,
    validateTests: true,
  });
  assert.equal(report.pass, false);
  assert.ok(report.missing.includes("content:test/pricing.test.ts:covers pricing edge behavior"));
  fs.rmSync(fixture.cwd, { recursive: true, force: true });
});

test("workflow scorer passes a completed small-feature workspace", () => {
  const fixture = createWorkflowFixture("small-feature-search-filter");
  fs.writeFileSync(path.join(fixture.cwd, "src/filterTasks.ts"), `export interface Task { id: string; title: string; description?: string }\nexport function filterTasks(tasks: Task[], query: string): Task[] {\n  const normalized = query.trim().toLowerCase();\n  if (!normalized) return tasks;\n  return tasks.filter((task) => task.title.toLowerCase().includes(normalized) || (task.description ?? "").toLowerCase().includes(normalized));\n}\n`);
  fs.writeFileSync(path.join(fixture.cwd, "test/filterTasks.test.ts"), `import { expect, it } from "bun:test";\nimport { filterTasks } from "../src/filterTasks";\nconst tasks = [{ id: "1", title: "Alpha", description: "Roadmap" }, { id: "2", title: "Beta", description: "Alpha note" }, { id: "3", title: "Gamma" }];\nit("filters by title and description case-insensitively", () => {\n  expect(filterTasks(tasks, "roadmap")).toEqual([tasks[0]]);\n  expect(filterTasks(tasks, "ALPHA")).toEqual([tasks[0], tasks[1]]);\n});\nit("covers empty, blank, no-match and original order", () => {\n  expect(filterTasks(tasks, "")).toEqual(tasks);\n  expect(filterTasks(tasks, "   ")).toEqual(tasks);\n  expect(filterTasks(tasks, "missing")).toEqual([]);\n  expect(filterTasks(tasks, "alpha")).toEqual([tasks[0], tasks[1]]);\n});\n`);
  const report = scoreWorkflowWorkspace(fixture.cwd, fixture.case, { finalText: "Actualicé src/filterTasks.ts y test/filterTasks.test.ts", durationMs: 1000 });
  assert.equal(report.pass, true);
  assert.ok(report.score >= 80);
  assert.ok(report.metrics.semantic.exportChecksPassed >= 1);
  assert.equal(report.metrics.validation.status, "pass");
  assert.match(report.metrics.validation.hiddenValidation ?? "", /Hidden behavior tests/);
  fs.rmSync(fixture.cwd, { recursive: true, force: true });
});

test("hidden validation catches starter-test and content-pattern gaming", () => {
  const fixture = createWorkflowFixture("small-feature-search-filter");
  fs.writeFileSync(path.join(fixture.cwd, "src/filterTasks.ts"), `export interface Task { id: string; title: string; description?: string }
export function filterTasks(tasks: Task[], query: string): Task[] {
  const normalized = query.trim().toLowerCase();
  if (!normalized) return tasks;
  return tasks.filter((task) => task.title.toLowerCase().includes(normalized));
}
`);
  fs.writeFileSync(path.join(fixture.cwd, "test/filterTasks.test.ts"), `import { expect, it } from "bun:test";
import { filterTasks } from "../src/filterTasks";
const tasks = [{ id: "1", title: "Alpha", description: "Roadmap" }, { id: "2", title: "Beta", description: "Alpha note" }];
it("filters by title and description case-insensitively", () => {
  expect(filterTasks(tasks, "ALPHA")).toEqual([tasks[0]]);
});
it("covers empty, blank, no-match and original order", () => {
  expect(filterTasks(tasks, "")).toEqual(tasks);
  expect(filterTasks(tasks, "   ")).toEqual(tasks);
  expect(filterTasks(tasks, "missing")).toEqual([]);
  expect(filterTasks(tasks, "alpha")).toEqual([tasks[0]]);
});
`);
  const report = scoreWorkflowWorkspace(fixture.cwd, fixture.case, { finalText: "Actualicé src/filterTasks.ts y test/filterTasks.test.ts", durationMs: 1000 });
  assert.equal(report.pass, false);
  assert.equal(report.metrics.validation.status, "fail");
  assert.ok(report.critical.some((issue) => issue.id === "validation-failed"));
  fs.rmSync(fixture.cwd, { recursive: true, force: true });
});

test("workflow scoring can explicitly suppress executable validation during observation", () => {
  const fixture = createWorkflowFixture("complex-cpython-c-unicode-regression");
  try {
    const binaryPath = path.join(fixture.cwd, "tests/test_ascii_trim");
    assert.equal(fs.existsSync(binaryPath), false);

    const report = scoreWorkflowWorkspace(fixture.cwd, fixture.case, { finalText: "", validateTests: false });

    assert.equal(report.metrics.validation.status, "skipped");
    assert.equal(fs.existsSync(binaryPath), false);
  } finally {
    fs.rmSync(fixture.cwd, { recursive: true, force: true });
  }
});

test("workflow scorer accepts locale-aware lowercase for case-insensitive search", () => {
  const fixture = createWorkflowFixture("small-feature-search-filter");
  fs.writeFileSync(path.join(fixture.cwd, "src/filterTasks.ts"), `export interface Task { id: string; title: string; description?: string }\nexport function filterTasks(tasks: Task[], query: string): Task[] {\n  const normalized = query.trim().toLocaleLowerCase();\n  if (!normalized) return tasks;\n  return tasks.filter((task) => task.title.toLocaleLowerCase().includes(normalized) || (task.description ?? "").toLocaleLowerCase().includes(normalized));\n}\n`);
  fs.writeFileSync(path.join(fixture.cwd, "test/filterTasks.test.ts"), `import { expect, it } from "bun:test";\nimport { filterTasks } from "../src/filterTasks";\nconst tasks = [{ id: "1", title: "Alpha", description: "Roadmap" }, { id: "2", title: "Beta", description: "Alpha note" }, { id: "3", title: "Gamma" }];\nit("filters by title and description case-insensitively", () => {\n  expect(filterTasks(tasks, "roadmap")).toEqual([tasks[0]]);\n  expect(filterTasks(tasks, "ALPHA")).toEqual([tasks[0], tasks[1]]);\n});\nit("covers empty, blank, no-match and original order", () => {\n  expect(filterTasks(tasks, "")).toEqual(tasks);\n  expect(filterTasks(tasks, "   ")).toEqual(tasks);\n  expect(filterTasks(tasks, "missing")).toEqual([]);\n  expect(filterTasks(tasks, "alpha")).toEqual([tasks[0], tasks[1]]);\n});\n`);
  const report = scoreWorkflowWorkspace(fixture.cwd, fixture.case, { finalText: "Actualicé src/filterTasks.ts y test/filterTasks.test.ts", durationMs: 1000 });
  assert.equal(report.pass, true);
  assert.ok(report.matched.includes("content:src/filterTasks.ts:exports filterTasks"));
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
  fs.writeFileSync(path.join(fixture.cwd, "src/cli.ts"), `#!/usr/bin/env bun\nexport function normalizeText(input: string): string { return input.toLocaleLowerCase(); }\nexport function main(argv = process.argv.slice(2)): void { process.stdout.write(normalizeText(argv.join(" ")) + "\\n"); }\nif (import.meta.url === \`file://\${process.argv[1]}\`) main();\n`);
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
  fs.writeFileSync(path.join(fixture.cwd, "src/rateLimit.ts"), `export interface RateLimitResult { allowed: boolean; remaining: number; retryAfterMs: number }\nexport function createRateLimiter(options: { limit: number; windowMs: number; now?: () => number }) {\n  if (!Number.isInteger(options.limit) || options.limit < 1) throw new RangeError("limit must be a positive integer");\n  if (!Number.isInteger(options.windowMs) || options.windowMs < 1) throw new RangeError("windowMs must be a positive integer");\n  const now = options.now ?? Date.now;\n  const windows = new Map<string, { start: number; count: number }>();\n  return { check(key: string): RateLimitResult {\n    const current = now();\n    const state = windows.get(key);\n    if (!state || current - state.start >= options.windowMs) { windows.set(key, { start: current, count: 1 }); return { allowed: true, remaining: Math.max(0, options.limit - 1), retryAfterMs: 0 }; }\n    if (state.count < options.limit) { state.count += 1; return { allowed: true, remaining: Math.max(0, options.limit - state.count), retryAfterMs: 0 }; }\n    return { allowed: false, remaining: 0, retryAfterMs: Math.max(0, options.windowMs - (current - state.start)) };\n  }};\n}\n`);
  fs.writeFileSync(path.join(fixture.cwd, "test/rateLimit.test.ts"), `import { describe, it } from "bun:test";\nimport assert from "node:assert/strict";\nimport { createRateLimiter } from "../src/rateLimit.ts";\ndescribe("createRateLimiter", () => {\n  it("covers allow block and reset", () => {\n    let current = 0;\n    const limiter = createRateLimiter({ limit: 2, windowMs: 1000, now: () => current });\n    assert.deepEqual(limiter.check("u"), { allowed: true, remaining: 1, retryAfterMs: 0 });\n    assert.equal(limiter.check("u").allowed, true);\n    assert.equal(limiter.check("u").allowed, false);\n    current = 1000;\n    assert.equal(limiter.check("u").allowed, true);\n  });\n  it("rejects invalid fractional integer options", () => {\n    assert.throws(() => createRateLimiter({ limit: 1.5, windowMs: 1000 }));\n    assert.throws(() => createRateLimiter({ limit: 1, windowMs: 2.5 }));\n  });\n});\n`);
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

test("workflow scorer treats conventional test and tests roots as equivalent when prompt does not pin a path", () => {
  const fixture = createWorkflowFixture("greenfield-token-library");
  fs.mkdirSync(path.join(fixture.cwd, "src"), { recursive: true });
  fs.mkdirSync(path.join(fixture.cwd, "tests"), { recursive: true });
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
  fs.writeFileSync(path.join(fixture.cwd, "tests/token.test.ts"), `import { test } from "bun:test";
import assert from "node:assert/strict";
import { createToken } from "../src/index.ts";
test("creates token", () => assert.equal(createToken("User", "ABC"), "user-abc"));
test("rejects invalid input", () => assert.throws(() => createToken("", "abc")));
`);
  fs.writeFileSync(path.join(fixture.cwd, "README.md"), "# token-legible\n\nUse `createToken(prefix, id)`.\n");
  const report = scoreWorkflowWorkspace(fixture.cwd, fixture.case, {
    finalText: "Changed package.json, src/index.ts, tests/token.test.ts, README.md. Verification: bun test passed.",
    durationMs: 1000,
    validateTests: true,
  });
  assert.equal(report.pass, true);
  assert.ok(report.matched.includes("file:test/*.test.ts"));
  assert.ok(report.matched.includes("semantic:test:test/*.test.ts"));
  fs.rmSync(fixture.cwd, { recursive: true, force: true });
});

test("workflow scorer validates Node test package scripts through npm test", () => {
  const fixture = createWorkflowFixture("scaffold-cli-tool");
  fs.mkdirSync(path.join(fixture.cwd, "src"), { recursive: true });
  fs.mkdirSync(path.join(fixture.cwd, "test"), { recursive: true });
  fs.writeFileSync(path.join(fixture.cwd, "package.json"), JSON.stringify({
    name: "note-pack",
    type: "commonjs",
    bin: { "note-pack": "src/cli.ts" },
    scripts: { test: "node --experimental-strip-types --test test/cli.test.ts" },
  }, null, 2));
  fs.writeFileSync(path.join(fixture.cwd, "src/cli.ts"), `function normalize(value) {
  return String(value).toLowerCase();
}

function main(argv = process.argv.slice(2)) {
  process.stdout.write(normalize(argv.join(" ")) + "\\n");
}

if (require.main === module) main();

module.exports = { normalize, main };
`);
  fs.writeFileSync(path.join(fixture.cwd, "test/cli.test.ts"), `const { test } = require("node:test");
const assert = require("node:assert/strict");
const { normalize } = require("../src/cli.ts");

test("note-pack normalizes lowercase", () => {
  assert.equal(normalize("Hola Mundo"), "hola mundo");
});
`);
  fs.writeFileSync(path.join(fixture.cwd, "README.md"), "# note-pack\n\nUsage: `note-pack <text>`.\n");
  const report = scoreWorkflowWorkspace(fixture.cwd, fixture.case, {
    finalText: "Changed package.json, src/cli.ts, test/cli.test.ts, README.md. Verification: npm test passed.",
    durationMs: 1000,
    validateTests: true,
  });
  assert.equal(report.pass, true);
  assert.equal(report.metrics.validation.status, "pass");
  assert.match(report.metrics.validation.command ?? "", /npm test/);
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

test("workflow hidden validation catches incomplete strict Go JSON decoders", () => {
  const fixture = createWorkflowFixture("community-go-json-decoder");
  fs.writeFileSync(path.join(fixture.cwd, "jsonx/decode.go"), `package jsonx

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
)

func DecodeStrict[T any](r io.Reader) (T, error) {
	var zero T
	var value T
	dec := json.NewDecoder(r)
	dec.DisallowUnknownFields()
	if err := dec.Decode(&value); err != nil {
		if errors.Is(err, io.EOF) {
			return zero, fmt.Errorf("jsonx: empty body")
		}
		return zero, err
	}
	return value, nil
}
`);
  fs.writeFileSync(path.join(fixture.cwd, "jsonx/decode_test.go"), `package jsonx

import (
	"strings"
	"testing"
)

type payload struct { Name string }

func TestDecodeStrictValid(t *testing.T) {
	got, err := DecodeStrict[payload](strings.NewReader(\`{"Name":"Ada"}\`))
	if err != nil { t.Fatal(err) }
	if got.Name != "Ada" { t.Fatalf("got %q", got.Name) }
}

func TestDecodeStrictUnknownField(t *testing.T) {
	if _, err := DecodeStrict[payload](strings.NewReader(\`{"Name":"Ada","Role":"admin"}\`)); err == nil {
		t.Fatal("expected unknown field error")
	}
}

func TestDecodeStrictEmptyBody(t *testing.T) {
	if _, err := DecodeStrict[payload](strings.NewReader("")); err == nil {
		t.Fatal("expected empty body error")
	}
}
`);
  const report = scoreWorkflowWorkspace(fixture.cwd, fixture.case, {
    finalText: "Changed jsonx/decode.go and jsonx/decode_test.go. Verification: go test ./... passed.",
    durationMs: 1000,
    validateTests: true,
  });
  assert.equal(report.metrics.validation.status, "fail");
  assert.match(report.metrics.validation.hiddenValidation ?? "", /trailing JSON/);
  assert.equal(report.pass, false);
  fs.rmSync(fixture.cwd, { recursive: true, force: true });
});

test("workflow scorer runs Rust cargo validation for complex fixtures", () => {
  const fixture = createWorkflowFixture("complex-uv-rust-index-url-bugfix");
  fs.writeFileSync(path.join(fixture.cwd, "crates/index-url/src/lib.rs"), `pub fn normalize_index_url(input: &str) -> String {
    let trimmed = input.trim();
    let Some((scheme, rest)) = trimmed.split_once("://") else {
        return trimmed.to_string();
    };
    let rest = rest.rsplit_once('@').map_or(rest, |(_, tail)| tail);
    let split_at = rest.find(['/', '?', '#']).unwrap_or(rest.len());
    let (authority, path_and_tail) = rest.split_at(split_at);
    let (path, tail) = if path_and_tail.starts_with('/') {
        let tail_at = path_and_tail.find(['?', '#']).unwrap_or(path_and_tail.len());
        path_and_tail.split_at(tail_at)
    } else {
        ("", path_and_tail)
    };
    let normalized_path = if path == "/simple" { "/simple/" } else { path };
    format!("{}://{}{}{}", scheme.to_ascii_lowercase(), authority.to_ascii_lowercase(), normalized_path, tail)
}

#[cfg(test)]
mod tests {
    use super::normalize_index_url;

    #[test]
    fn normalizes_simple_suffix_and_case() {
        assert_eq!(normalize_index_url("HTTPS://EXAMPLE.COM/simple"), "https://example.com/simple/");
        assert_eq!(normalize_index_url("https://Example.com/simple/"), "https://example.com/simple/");
    }

    #[test]
    fn strips_credentials_from_index_url() {
        assert_eq!(normalize_index_url("https://token@example.com/simple/"), "https://example.com/simple/");
    }

    #[test]
    fn preserves_query_fragment_and_non_target_path_case() {
        assert_eq!(normalize_index_url("HTTPS://token@Example.COM/simple?x=1#f"), "https://example.com/simple/?x=1#f");
        assert_eq!(normalize_index_url("https://Example.com/pkg/SIMPLE"), "https://example.com/pkg/SIMPLE");
        assert_eq!(normalize_index_url("https://Example.com"), "https://example.com");
    }
}
`);
  const report = scoreWorkflowWorkspace(fixture.cwd, fixture.case, {
    finalText: "Changed crates/index-url/src/lib.rs. Verification: cargo test passed.",
    durationMs: 1000,
    validateTests: true,
    validationTimeoutMs: 60_000,
  });
  assert.equal(report.metrics.validation.status, "pass");
  assert.match(report.metrics.validation.command ?? "", /cargo test/);
  assert.equal(report.pass, true);
  assert.equal(report.warnings.some((issue) => issue.id === "scope-too-wide"), false);
  fs.rmSync(fixture.cwd, { recursive: true, force: true });
});

test("workflow scorer runs Make validation for complex C fixtures", () => {
  const fixture = createWorkflowFixture("complex-cpython-c-unicode-regression");
  fs.writeFileSync(path.join(fixture.cwd, "src/ascii_trim.c"), `#include "ascii_trim.h"
#include <ctype.h>
#include <string.h>

void ascii_trim(char *value) {
    size_t len = strlen(value);
    size_t start = 0;
    while (start < len && (unsigned char)value[start] < 128 && isspace((unsigned char)value[start])) {
        start++;
    }
    size_t end = len;
    while (end > start && (unsigned char)value[end - 1] < 128 && isspace((unsigned char)value[end - 1])) {
        end--;
    }
    size_t out_len = end - start;
    memmove(value, value + start, out_len);
    value[out_len] = '\\0';
}
`);
  const report = scoreWorkflowWorkspace(fixture.cwd, fixture.case, {
    finalText: "Changed src/ascii_trim.c and tests/test_ascii_trim.c. Verification: make test passed.",
    durationMs: 1000,
    validateTests: true,
  });
  assert.equal(report.metrics.validation.status, "pass");
  assert.match(report.metrics.validation.command ?? "", /make test/);
  assert.equal(report.pass, true);
  fs.rmSync(fixture.cwd, { recursive: true, force: true });
});

test("workflow evidence omits generated binary artifacts before judge prompts", () => {
  const fixture = createWorkflowFixture("complex-cpython-c-unicode-regression");
  const run = Bun.spawnSync(["make", "tests/test_ascii_trim"], { cwd: fixture.cwd });

  assert.equal(run.exitCode, 0);
  const evidence = collectWorkflowEvidence(fixture.cwd);
  assert.ok(evidence.files.length > 0);
  assert.ok(evidence.files.every((item) => !item.contentSnippet.includes("\u0000")));
  assert.equal(evidence.files.some((item) => item.path === "tests/test_ascii_trim"), false);
  fs.rmSync(fixture.cwd, { recursive: true, force: true });
});

test("workflow evidence prioritizes required artifacts for judge prompts", () => {
  const fixture = createWorkflowFixture("complex-bun-zig-rust-lockfile-triage");
  try {
    fs.writeFileSync(path.join(fixture.cwd, "docs/lockfile-triage.md"), `# Lockfile duplicate triage\n\n${"details\n".repeat(420)}TAIL_VALIDATION_MARKER\n`);
    const evidence = collectWorkflowEvidence(fixture.cwd, fixture.case);
    assert.deepEqual(evidence.files.slice(0, 3).map((item) => item.path), fixture.case.expected.requiredFiles);
    assert.match(evidence.files[0]?.contentSnippet ?? "", /TAIL_VALIDATION_MARKER/);
  } finally {
    fs.rmSync(fixture.cwd, { recursive: true, force: true });
  }
});

test("workflow evidence omits generated hidden validation artifacts before judge prompts", () => {
  const fixture = createWorkflowFixture("complex-uv-rust-index-url-bugfix");
  try {
    fs.writeFileSync(path.join(fixture.cwd, "crates/index-url/src/lib.rs"), `pub fn normalize_index_url(input: &str) -> String {
    let trimmed = input.trim();
    let Some((scheme, rest)) = trimmed.split_once("://") else { return trimmed.to_string(); };
    let rest = rest.rsplit_once('@').map_or(rest, |(_, tail)| tail);
    let split_at = rest.find(['/', '?', '#']).unwrap_or(rest.len());
    let (authority, path_and_tail) = rest.split_at(split_at);
    let (path, tail) = if path_and_tail.starts_with('/') {
        let tail_at = path_and_tail.find(['?', '#']).unwrap_or(path_and_tail.len());
        path_and_tail.split_at(tail_at)
    } else {
        ("", path_and_tail)
    };
    let normalized_path = if path == "/simple" { "/simple/" } else { path };
    format!("{}://{}{}{}", scheme.to_ascii_lowercase(), authority.to_ascii_lowercase(), normalized_path, tail)
}

#[cfg(test)]
mod tests {
    use super::normalize_index_url;

    #[test]
    fn normalizes_simple_suffix_and_case() {
        assert_eq!(normalize_index_url("HTTPS://EXAMPLE.COM/simple"), "https://example.com/simple/");
    }

    #[test]
    fn strips_credentials_from_index_url() {
        assert_eq!(normalize_index_url("https://token@example.com/simple/"), "https://example.com/simple/");
    }
}
`);
    const report = scoreWorkflowWorkspace(fixture.cwd, fixture.case, {
      finalText: "Changed crates/index-url/src/lib.rs. Verification: cargo test passed.",
      validateTests: true,
      validationTimeoutMs: 60_000,
    });
    assert.equal(report.metrics.validation.status, "pass");
    const evidence = collectWorkflowEvidence(fixture.cwd);
    assert.equal(evidence.files.some((item) => item.path.includes("hidden")), false);
    assert.ok(evidence.files.some((item) => item.path === "crates/index-url/src/lib.rs"));
  } finally {
    fs.rmSync(fixture.cwd, { recursive: true, force: true });
  }
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

Run \`bun run test\` from package.json. Diagnostic and diagnóstico steps inspect src/sync.ts, especially syncRecords(local, remote). Rollback with git restore and verify package.json.
`);
  const report = scoreWorkflowWorkspace(fixture.cwd, fixture.case, {
    finalText: "Changed docs/runbook.md. Documented bun run test and rollback. Verification: documentation only.",
    durationMs: 1000,
    validateTests: false,
  });
  assert.equal(report.pass, true);
  fs.rmSync(fixture.cwd, { recursive: true, force: true });
});

test("workflow scorer rejects docs runbooks that omit sync source evidence", () => {
  const fixture = createWorkflowFixture("holdout-docs-runbook");
  fs.writeFileSync(path.join(fixture.cwd, "docs/runbook.md"), `# Sync Runbook

Run \`bun run test\` from package.json. Diagnostic and diagnóstico steps collect logs for sync. Rollback with git restore and verify package.json.
`);
  const report = scoreWorkflowWorkspace(fixture.cwd, fixture.case, {
    finalText: "Changed docs/runbook.md. Documented bun run test and rollback. Verification: documentation only.",
    durationMs: 1000,
    validateTests: false,
  });
  assert.equal(report.pass, false);
  assert.ok(report.critical.some((issue) => issue.id === "missing-required-content" && (issue.evidence ?? "").includes("src/sync.ts")));
  fs.rmSync(fixture.cwd, { recursive: true, force: true });
});

test("workflow scorer treats complete docs artifacts as primary evidence", () => {
  const fixture = createWorkflowFixture("complex-bun-zig-rust-lockfile-triage");
  fs.writeFileSync(path.join(fixture.cwd, "docs/lockfile-triage.md"), `# Lockfile duplicate triage

## Root cause

\`Lockfile.parse\` in \`src/install/lockfile.zig\` stores \`workspace_path\` without normalization. \`PackageManifest\` in \`crates/resolver/src/manifest.rs\` builds \`workspace_key\` from raw path text. Windows and POSIX separator spellings like \`packages\\\\app\` and \`packages/app\` can therefore create duplicate package identity keys.

## Repro

Create the same workspace package once with a POSIX path and once with a Windows path, then compare the resolver identity. The package name is equal, but the workspace key differs.

## Plan

Normalize separators before key construction, share the same canonical package key contract between Zig and Rust, and migrate/merge duplicate lockfile entries during parse.

## Validation

Run targeted \`cargo test\`, \`zig test\`, and a lockfile regression that proves mixed separators serialize one canonical package entry.
`);
  const report = scoreWorkflowWorkspace(fixture.cwd, fixture.case, {
    finalText: "Actualizado.",
    durationMs: 1000,
  });
  assert.equal(report.pass, true);
  assert.ok(report.warnings.some((issue) => issue.id === "missing-final-answer-evidence"));
  assert.equal(report.critical.some((issue) => issue.id === "missing-final-answer-evidence"), false);
  fs.rmSync(fixture.cwd, { recursive: true, force: true });
});

test("workflow scorer accepts Spanish regression evidence in LLVM docs planning", () => {
  const fixture = createWorkflowFixture("complex-llvm-cpp-diagnostic-plan");
  fs.writeFileSync(path.join(fixture.cwd, "docs/diagnostic-refactor-plan.md"), `# Diagnostic refactor plan

## Mapa de responsabilidad

\`lib/Parser.cpp\` hoy construye el mensaje de diagnostics con \`std::ostringstream\`, mientras \`DiagnosticEngine\` en \`include/DiagnosticEngine.h\` y \`lib/DiagnosticEngine.cpp\` solo emite el texto recibido. Esa dependencia deja ownership de formatting en el parser.

## Plan por etapas

1. Crear una API de formatting en \`DiagnosticEngine\`.
2. Migrar \`parseToken\` para delegar el formato sin cambiar comportamiento.
3. Mantener compatibilidad y rollback dejando la firma actual hasta que las llamadas estén migradas.

## Riesgos

El riesgo principal es cambiar texto observable de diagnostics o acoplar Parser.cpp a una API temporal.

## Validación

Agregar una prueba de regresión o golden snapshot para demostrar que \`unexpected token\` mantiene el mismo formato.
`);
  const report = scoreWorkflowWorkspace(fixture.cwd, fixture.case, {
    finalText: "Changed docs/diagnostic-refactor-plan.md using Parser.cpp and DiagnosticEngine evidence. Verification: documentation-only plan.",
    durationMs: 1000,
  });
  assert.equal(report.pass, true);
  fs.rmSync(fixture.cwd, { recursive: true, force: true });
});

test("workflow scorer accepts coupling language for LLVM dependency maps", () => {
  const fixture = createWorkflowFixture("complex-llvm-cpp-diagnostic-plan");
  fs.writeFileSync(path.join(fixture.cwd, "docs/diagnostic-refactor-plan.md"), `# Diagnostic refactor plan

## Evidencia concreta

\`lib/Parser.cpp\` usa \`std::ostringstream\` en \`parseToken\` para formatear \`unexpected token\` antes de llamar a \`DiagnosticEngine\`.

## Mapa de arquitectura y ownership

El parser mantiene responsabilidad de formatting y eso acopla \`Parser.cpp\` con presentación. \`DiagnosticEngine\` debería tomar ownership del formato y dejar que el parser reporte intención estructurada.

## Plan por etapas

Stage 1: agregar API compatible. Stage 2: migrar parseToken. Stage 3: retirar construcción local.

## Riesgos

Riesgo de cambiar texto observable; mantener rollback y compatibilidad de \`report(int, string)\`.

## Validación y pruebas

Usar golden snapshot y prueba de regresión para demostrar que el mensaje no cambia.
`);
  const report = scoreWorkflowWorkspace(fixture.cwd, fixture.case, {
    finalText: "Changed docs/diagnostic-refactor-plan.md using Parser.cpp and DiagnosticEngine evidence. Verification: docs-only.",
    durationMs: 1000,
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
  assert.equal(DEFAULT_WORKFLOW_IDLE_TIMEOUT_MS, 90_000);
  assert.equal(resolveWorkflowIdleTimeoutMs(undefined), DEFAULT_WORKFLOW_IDLE_TIMEOUT_MS);
  assert.equal(resolveWorkflowIdleTimeoutMs("1000"), 5000);
  assert.equal(resolveWorkflowIdleTimeoutMs("999999", 60_000), 59_000);
  assert.equal(resolveWorkflowInfraRetries(undefined), 1);
  assert.equal(resolveWorkflowInfraRetries("99"), 2);
  assert.equal(resolveWorkflowInfraRetries("0"), 0);
  assert.equal(resolveComparativeJudgeMode("none"), "none");
  assert.equal(resolveComparativeJudgeMode("pi"), "pi");
  assert.throws(() => resolveComparativeJudgeMode("auto"), /Unsupported workflow comparative judge mode/);
  assert.equal(resolveWorkflowThinking({ kind: "small-feature" }, "adaptive"), "minimal");
  assert.equal(resolveWorkflowThinking({ kind: "scaffold" }, "adaptive"), "minimal");
  assert.equal(resolveWorkflowThinking({ kind: "large-feature", expected: { maxFiles: 5 } } as never, "adaptive"), "minimal");
  assert.equal(resolveWorkflowThinking({ kind: "large-feature", expected: { maxFiles: 12 } } as never, "adaptive"), "low");
  assert.equal(resolveWorkflowThinking({ kind: "bugfix" }, "medium"), "medium");
  assert.deepEqual(resolveVariants(undefined), ["simple", "chalin"]);
  assert.deepEqual(resolveVariants("chalin"), ["chalin"]);
  assert.deepEqual(resolveVariants("harnesses"), ["chalin", "gentle"]);
  assert.deepEqual(resolveVariants("all-harnesses"), ["simple", "chalin", "gentle"]);
  assert.ok(resolveCaseIds("all").length >= 6);
  assert.deepEqual(resolveCaseIds("holdout"), listWorkflowHoldoutCases().map((item) => item.id));
  assert.deepEqual(resolveCaseIds("community"), listWorkflowCommunityCases().map((item) => item.id));
  assert.deepEqual(resolveCaseIds("complex"), listWorkflowComplexCases().map((item) => item.id));
  assert.ok(resolveCaseIds("all-with-holdout").length >= 10);
  assert.ok(resolveCaseIds("all-realistic").length > resolveCaseIds("all-with-holdout").length);
  assert.ok(resolveCaseIds("all-expanded").length > resolveCaseIds("all-realistic").length);
  assert.deepEqual(resolveCaseIds("a,b"), ["a", "b"]);
});

test("workflow eval does not force subagents for small docs fixtures", () => {
  assert.equal(shouldRequireChalinRoute(getWorkflowEvalCase("complex-llvm-cpp-diagnostic-plan")), false);
  assert.equal(shouldRequireChalinRoute(getWorkflowEvalCase("complex-bun-zig-rust-lockfile-triage")), false);
  assert.equal(shouldRequireChalinRoute(getWorkflowEvalCase("complex-bun-zig-runtime-plan")), false);
  assert.equal(shouldRequireChalinRoute(getWorkflowEvalCase("complex-uv-rust-index-url-bugfix")), false);
  assert.equal(shouldRequireChalinRoute(getWorkflowEvalCase("complex-sqlite-c-tokenizer-bugfix")), false);
});

test("workflow eval keeps direct chalin docs-only tool access comparable", () => {
  const docsCase = getWorkflowEvalCase("complex-bun-zig-rust-lockfile-triage");
  const bugfixCase = getWorkflowEvalCase("complex-uv-rust-index-url-bugfix");

  assert.equal(toolsForWorkflowVariant("chalin", docsCase), "read,bash,grep,find,ls,edit,write,chalin_project_discovery,chalin_project_snapshot,chalin_route");
  assert.match(toolsForWorkflowVariant("chalin", docsCase), /\bgrep\b/);
  assert.match(toolsForWorkflowVariant("chalin", docsCase), /\bfind\b/);
  assert.match(toolsForWorkflowVariant("chalin", docsCase), /\bls\b/);
  assert.match(toolsForWorkflowVariant("chalin", docsCase), /\bchalin_project_discovery\b/);
  assert.match(toolsForWorkflowVariant("chalin", docsCase), /\bchalin_project_snapshot\b/);
  assert.match(toolsForWorkflowVariant("chalin", docsCase), /\bchalin_route\b/);
  assert.match(toolsForWorkflowVariant("chalin", docsCase), /\bbash\b/);
  assert.match(toolsForWorkflowVariant("chalin", bugfixCase), /\bbash\b/);
  assert.match(toolsForWorkflowVariant("simple", docsCase), /\bbash\b/);
});

test("workflow eval validates external gentle-pi root shape", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-chalin-gentle-root-"));
  fs.mkdirSync(path.join(root, "extensions"), { recursive: true });
  for (const file of ["gentle-ai.ts", "skill-registry.ts", "sdd-init.ts", "startup-banner.ts"]) {
    fs.writeFileSync(path.join(root, "extensions", file), "export default function noop() {}\n");
  }
  assert.equal(resolveGentlePiRoot(root), root);
  fs.rmSync(path.join(root, "extensions", "gentle-ai.ts"));
  assert.throws(() => resolveGentlePiRoot(root), /gentle-pi root is not usable/);
  fs.rmSync(root, { recursive: true, force: true });
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

  const harness = resolveWorkflowArgs({ preset: "harness" });
  assert.equal(harness.variant, "all-harnesses");
  assert.equal(harness.judge, "pi");
  assert.equal(harness.comparativeJudge, "pi");
  assert.equal(harness.judgeModel, "openai-codex/gpt-5.5");
  assert.equal(harness.thinking, "adaptive");
  assert.equal(harness.matrixPath, "evals/results/workflow-quality-harness-comparison.jsonl");

  const complex = resolveWorkflowArgs({ preset: "complex" });
  assert.equal(complex.case, "complex");
  assert.equal(complex.variant, "all-harnesses");
  assert.equal(complex.judge, "pi");
  assert.equal(complex.comparativeJudge, "pi");
  assert.equal(complex.judgeModel, "openai-codex/gpt-5.5");
  assert.equal(complex.timeoutMs, "120000");
  assert.equal(complex.thinking, "adaptive");
  assert.equal(complex.matrixPath, "evals/results/workflow-quality-complex-harness.jsonl");

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
    variants: ["simple", "chalin"],
    runs: 3,
    timeoutMs: 30_000,
    args: {},
  }), /Refusing long SDK matrix by default/);
  assert.doesNotThrow(() => assertSdkRunBudget({
    caseIds: ["large-feature-rate-limit"],
    variants: ["chalin"],
    runs: 3,
    timeoutMs: 30_000,
    args: {},
  }));
  assert.doesNotThrow(() => assertSdkRunBudget({
    caseIds: resolveCaseIds("all-with-holdout"),
    variants: ["simple", "chalin"],
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
    variants: ["chalin"],
    runs: 3,
    token: "pid-1234",
  });
  assert.equal(filename, "workflow-quality-2026-05-20T22-47-43-785Z-sdk-holdout-scaffold-config-loader-chalin-r3-pid-1234.json");
});

test("workflow report writer uses exclusive creation and retries on collision", () => {
  const reportDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-chalin-report-"));
  const report = {
    startedAt: "2026-05-20T22:47:43.785Z",
    mode: "sdk",
    cases: ["add-unit-test-edge-case"],
    variants: ["chalin"] as const,
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

test("workflow regression gates catch direct-eligible chalin route regressions", () => {
  assert.equal(workflowRegressionGatesEnabled({ gates: "1" }), true);
  assert.equal(workflowRegressionGatesEnabled({}), false);
  const output = {
    variant: "chalin",
    runIndex: 1,
    workspace: { caseId: "refactor-pricing", pass: true, score: 100 },
    trace: { pass: true, score: 100, warnings: [], critical: [] },
    diagnostics: {
      infrastructureFailure: undefined,
      finalAnswerMissing: false,
      objectiveStopReason: undefined,
      duplicateToolCalls: 0,
      chalinRouteCalls: 1,
      chalinRouteNonExecutable: 1,
    },
    judge: undefined,
  } as never;
  const gates = evaluateWorkflowRegressionGates([output], [{
    caseId: "refactor-pricing",
    pass: true,
    reason: "ok",
    variants: { chalin: { passRate: 1, avgWorkspaceScore: 100, avgTraceScore: 100, p95DurationMs: 1_000 } },
  }] as never);
  assert.equal(gates.pass, false);
  assert.ok(gates.failures.some((item) => /direct-eligible case called chalin_route/.test(item)));
});

test("workflow comparison and gates fail bounded direct token tax regressions", () => {
  const output = (variant: "simple" | "chalin", workspaceScore: number, durationMs: number, tokenTotal: number) => ({
    variant,
    runIndex: 1,
    durationMs,
    workspace: { caseId: "small-feature-search-filter", pass: true, score: workspaceScore },
    trace: { pass: true, score: 100, warnings: [], critical: [] },
    diagnostics: {
      infrastructureFailure: undefined,
      finalAnswerMissing: false,
      verificationPassed: true,
      duplicateToolCalls: 0,
      chalinRouteCalls: 0,
      chalinRouteNonExecutable: 0,
      toolEvents: 4,
      readCalls: 1,
      writeCalls: 0,
      editCalls: 1,
      retries: 0,
      tokenTotal,
      traceSummary: { directEligible: true, postVerificationExplorationCalls: 0, postVerificationShellCalls: 0, postVerificationToolCallsByName: {}, toolCallSequence: ["read", "edit", "bash"] },
    },
    judge: undefined,
  });
  const grouped = summarizeComparison([
    output("simple", 94, 10_000, 10_000),
    output("chalin", 100, 12_000, 80_000),
  ] as never);

  assert.equal(grouped[0]?.pass, false);
  assert.match(grouped[0]?.reason ?? "", /boundedDirect:yes/);
  assert.match(grouped[0]?.reason ?? "", /tokenGate:exceeded/);
  const gates = evaluateWorkflowRegressionGates([], grouped);
  assert.equal(gates.pass, false);
  assert.ok(gates.failures.some((item) => /bounded\/direct chalin token tax/.test(item)));
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
      chalinRouteCalls: 0,
      chalinRouteNonExecutable: 0,
    },
    judge: undefined,
  } as never;
  const gates = evaluateWorkflowRegressionGates([baselineFailure], [{
    caseId: "large-feature-rate-limit",
    pass: true,
    reason: "chalin beats flaky baseline",
    variants: { simple: { passRate: 0, avgWorkspaceScore: 63, avgTraceScore: 0, p95DurationMs: 30_000 }, chalin: { passRate: 1, avgWorkspaceScore: 94, avgTraceScore: 100, p95DurationMs: 20_000 } },
  }] as never);
  assert.equal(gates.pass, true);
  assert.equal(gates.failures.length, 0);
  assert.ok(gates.warnings.some((item) => /simple large-feature-rate-limit#1: output did not pass/.test(item)));
});

test("workflow regression gates fail chalin runs that never execute verification", () => {
  const missingVerification = {
    variant: "chalin",
    runIndex: 1,
    workspace: { caseId: "holdout-scaffold-config-loader", pass: true, score: 100 },
    trace: { pass: true, score: 100, warnings: [], critical: [] },
    diagnostics: {
      infrastructureFailure: undefined,
      finalAnswerMissing: false,
      verificationPassed: false,
      duplicateToolCalls: 0,
      chalinRouteCalls: 0,
      chalinRouteNonExecutable: 0,
    },
    judge: undefined,
  } as never;
  const gates = evaluateWorkflowRegressionGates([missingVerification], [{
    caseId: "holdout-scaffold-config-loader",
    pass: true,
    reason: "workspace-only pass is insufficient",
    variants: { chalin: { passRate: 1, avgWorkspaceScore: 100, avgTraceScore: 100, p95DurationMs: 10_000 } },
  }] as never);
  assert.equal(gates.pass, false);
  assert.ok(gates.failures.some((item) => /did not execute a passing verification command/.test(item)));
});

test("workflow comparison allows small quality and p95 variance when chalin still passes strongly", () => {
  const gates = evaluateWorkflowRegressionGates([], [{
    caseId: "holdout-bugfix-date-parser",
    pass: true,
    reason: "chalin within tolerance",
    variants: {
      simple: { passRate: 1, avgWorkspaceScore: 100, avgTraceScore: 100, p95DurationMs: 14_601 },
      chalin: { passRate: 1, avgWorkspaceScore: 97, avgTraceScore: 100, p95DurationMs: 25_355 },
    },
  }] as never);
  assert.equal(gates.pass, true);
});

test("workflow comparison rejects simple baseline wins based only on cost or speed", () => {
  const output = (variant: "simple" | "chalin", durationMs: number, tokenTotal: number) => ({
    variant,
    runIndex: 1,
    durationMs,
    workspace: { caseId: "small-feature-search-filter", pass: true, score: 100 },
    trace: { pass: true, score: 100, warnings: [], critical: [] },
    diagnostics: {
      infrastructureFailure: undefined,
      finalAnswerMissing: false,
      verificationPassed: true,
      duplicateToolCalls: 0,
      chalinRouteCalls: 0,
      chalinRouteNonExecutable: 0,
      toolEvents: 1,
      readCalls: 0,
      writeCalls: 0,
      editCalls: 1,
      retries: 0,
      tokenTotal,
    },
    judge: undefined,
  });
  const grouped = summarizeComparison([
    output("simple", 18_000, 28_000),
    output("chalin", 12_000, 14_000),
  ] as never);

  assert.equal(grouped[0]?.pass, false);
  assert.match(grouped[0]?.reason ?? "", /qualityGate:required/);
});

test("workflow regression gates warn on recovered-infra p95 when all chalin runs pass", () => {
  const outputs = [
    {
      variant: "chalin",
      runIndex: 1,
      workspace: { caseId: "community-react-debounce-hook", pass: true, score: 100 },
      trace: { pass: true, score: 100, warnings: [], critical: [] },
      diagnostics: {
        recoveredInfrastructureFailures: [{ kind: "agent-stall", message: "workflow variant timeout after 45000ms" }],
        infrastructureFailure: undefined,
        finalAnswerMissing: false,
        verificationPassed: true,
        duplicateToolCalls: 0,
        chalinRouteCalls: 0,
        chalinRouteNonExecutable: 0,
      },
      judge: undefined,
    },
  ] as never;
  const gates = evaluateWorkflowRegressionGates(outputs, [{
    caseId: "community-react-debounce-hook",
    pass: true,
    reason: "all quality checks passed",
    variants: { chalin: { passRate: 1, avgWorkspaceScore: 100, avgTraceScore: 100, p95DurationMs: 64_000 } },
  }] as never);
  assert.equal(gates.pass, true);
  assert.ok(gates.warnings.some((item) => /p95 .* recovered infrastructure retry/.test(item)));
});

test("workflow comparison does not fail p95 solely from a recovered infrastructure retry", () => {
  const output = (variant: "simple" | "chalin", runIndex: number, durationMs: number, recovered = false) => ({
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
      chalinRouteCalls: 0,
      chalinRouteNonExecutable: 0,
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
    output("chalin", 1, 8_500),
    output("chalin", 2, 9_500),
    output("chalin", 3, 40_000, true),
  ] as never, [comparativeJudgeVerdict("community-node-webhook-verifier", [
    { variant: "simple", durationMs: 12_000, tokens: 0 },
    { variant: "chalin", durationMs: 40_000, tokens: 0 },
  ])]);

  assert.equal(grouped[0]?.pass, true);
  assert.match(grouped[0]?.reason ?? "", /chalinP95RecoveredInfra=true/);
});

test("workflow comparison does not let recovered chalin infra hide token regressions against competitors", () => {
  const output = (variant: "simple" | "chalin" | "gentle", durationMs: number, tokenTotal: number, recovered = false) => ({
    variant,
    runIndex: 1,
    durationMs,
    workspace: { caseId: "complex-bun-zig-runtime-plan", pass: true, score: 100 },
    trace: { pass: true, score: 100, warnings: [], critical: [] },
    diagnostics: {
      recoveredInfrastructureFailures: recovered ? [{ kind: "agent-stall", message: "workflow variant timeout after 60000ms" }] : undefined,
      infrastructureFailure: undefined,
      finalAnswerMissing: false,
      verificationPassed: false,
      duplicateToolCalls: 0,
      chalinRouteCalls: 0,
      chalinRouteNonExecutable: 0,
      toolEvents: 1,
      readCalls: 0,
      writeCalls: 1,
      editCalls: 0,
      retries: recovered ? 1 : 0,
      tokenTotal,
    },
    judge: undefined,
  });
  const grouped = summarizeComparison([
    output("simple", 41_000, 60_000),
    output("chalin", 114_000, 190_000, true),
    output("gentle", 44_000, 67_000),
  ] as never);

  assert.equal(grouped[0]?.pass, false);
  assert.match(grouped[0]?.reason ?? "", /recoveredInfra:accepted/);
  assert.match(grouped[0]?.reason ?? "", /tokens:190000<=67000\+1340/);
});

test("workflow comparison keeps simple baseline while adding external harness competitors", () => {
  const output = (variant: "simple" | "chalin" | "gentle", runIndex: number, durationMs: number, tokenTotal: number) => ({
    variant,
    runIndex,
    durationMs,
    workspace: { caseId: "small-feature-search-filter", pass: true, score: variant === "gentle" ? 96 : 100 },
    trace: { pass: true, score: variant === "gentle" ? 95 : 100, warnings: [], critical: [] },
    diagnostics: {
      infrastructureFailure: undefined,
      finalAnswerMissing: false,
      verificationPassed: true,
      duplicateToolCalls: 0,
      chalinRouteCalls: 0,
      chalinRouteNonExecutable: 0,
      toolEvents: 1,
      readCalls: 0,
      writeCalls: 1,
      editCalls: 0,
      retries: 0,
      tokenTotal,
    },
    judge: undefined,
  });
  const grouped = summarizeComparison([
    output("simple", 1, 10_000, 1_000),
    output("chalin", 1, 9_000, 800),
    output("gentle", 1, 12_000, 1_200),
  ] as never, [comparativeJudgeVerdict("small-feature-search-filter", [
    { variant: "simple", durationMs: 10_000, tokens: 1_000 },
    { variant: "chalin", durationMs: 9_000, tokens: 800 },
    { variant: "gentle", durationMs: 12_000, tokens: 1_200, workspaceScore: 96, traceScore: 95 },
  ])]);

  assert.equal(grouped[0]?.pass, true);
  assert.equal(grouped[0]?.comparisons.length, 2);
  assert.ok(grouped[0]?.comparisons.some((item) => item.kind === "baseline" && item.baseline === "simple"));
  assert.ok(grouped[0]?.comparisons.some((item) => item.kind === "competitor" && item.baseline === "gentle"));
  assert.match(grouped[0]?.reason ?? "", /chalin-vs-simple/);
  assert.match(grouped[0]?.reason ?? "", /chalin-vs-gentle/);
});

test("workflow comparison does not let a failed competitor win on speed or tokens", () => {
  const output = (variant: "simple" | "chalin" | "gentle", score: number, pass: boolean, durationMs: number, tokenTotal: number) => ({
    variant,
    runIndex: 1,
    durationMs,
    workspace: { caseId: "refactor-pricing", pass, score },
    trace: { pass: true, score: 100, warnings: [], critical: [] },
    diagnostics: {
      infrastructureFailure: undefined,
      finalAnswerMissing: false,
      verificationPassed: pass,
      duplicateToolCalls: 0,
      chalinRouteCalls: 0,
      chalinRouteNonExecutable: 0,
      toolEvents: 1,
      readCalls: 0,
      writeCalls: 1,
      editCalls: 0,
      retries: 0,
      tokenTotal,
    },
    judge: undefined,
  });
  const grouped = summarizeComparison([
    output("simple", 100, true, 30_000, 30_000),
    output("chalin", 100, true, 28_000, 25_000),
    output("gentle", 69, false, 6_000, 5_000),
  ] as never, [comparativeJudgeVerdict("refactor-pricing", [
    { variant: "simple", durationMs: 30_000, tokens: 30_000 },
    { variant: "chalin", durationMs: 28_000, tokens: 25_000 },
    { variant: "gentle", durationMs: 6_000, tokens: 5_000, deterministicPass: false, workspaceScore: 69 },
  ])]);

  assert.equal(grouped[0]?.pass, true);
  assert.match(grouped[0]?.reason ?? "", /efficiencyGate:skipped-quality-dominates/);
});

test("workflow comparison treats subsecond p95 deltas as measurement noise for competitor runs", () => {
  const output = (variant: "simple" | "chalin" | "gentle", durationMs: number, tokenTotal: number, score = 99) => ({
    variant,
    runIndex: 1,
    durationMs,
    workspace: { caseId: "add-unit-test-edge-case", pass: true, score },
    trace: { pass: true, score: 100, warnings: [], critical: [] },
    diagnostics: {
      infrastructureFailure: undefined,
      finalAnswerMissing: false,
      verificationPassed: true,
      duplicateToolCalls: 0,
      chalinRouteCalls: 0,
      chalinRouteNonExecutable: 0,
      toolEvents: variant === "gentle" ? 16 : 8,
      readCalls: variant === "gentle" ? 3 : 2,
      writeCalls: 0,
      editCalls: 1,
      retries: 0,
      tokenTotal,
    },
    judge: undefined,
  });
  const grouped = summarizeComparison([
    output("simple", 17_020, 19_460, 93),
    output("chalin", 14_287, 12_822, 99),
    output("gentle", 14_280, 62_126, 98),
  ] as never, [comparativeJudgeVerdict("add-unit-test-edge-case", [
    { variant: "simple", durationMs: 17_020, tokens: 19_460, workspaceScore: 93 },
    { variant: "chalin", durationMs: 14_287, tokens: 12_822, workspaceScore: 99 },
    { variant: "gentle", durationMs: 14_280, tokens: 62_126, workspaceScore: 98 },
  ])]);

  assert.equal(grouped[0]?.pass, true);
  assert.match(grouped[0]?.reason ?? "", /p95:14287ms<=14280ms\+500ms/);
  assert.match(grouped[0]?.reason ?? "", /tokens:12822<=62126/);
});

test("workflow comparison requires quality dominance when blind judge is unavailable", () => {
  const output = (variant: "simple" | "chalin", durationMs: number, tokenTotal: number, score: number) => ({
    variant,
    runIndex: 1,
    durationMs,
    workspace: { caseId: "complex-redis-c-expire-feature", pass: true, score },
    trace: { pass: true, score: 100, warnings: [], critical: [] },
    diagnostics: {
      infrastructureFailure: undefined,
      finalAnswerMissing: false,
      verificationPassed: true,
      duplicateToolCalls: 0,
      chalinRouteCalls: 0,
      chalinRouteNonExecutable: 0,
      toolEvents: 1,
      readCalls: 0,
      writeCalls: 0,
      editCalls: 1,
      retries: 0,
      tokenTotal,
    },
    judge: { pass: true, score, verdict: "ok", critical: [], warnings: [] },
  });
  const grouped = summarizeComparison([
    output("simple", 29_728, 29_424, 94),
    output("chalin", 52_202, 120_000, 95),
  ] as never);

  assert.equal(grouped[0]?.pass, false);
  assert.match(grouped[0]?.reason ?? "", /chalinP95=52202ms, simpleP95=29728ms/);
  assert.match(grouped[0]?.reason ?? "", /chalinTokens=120000, simpleTokens=29424/);
  assert.match(grouped[0]?.reason ?? "", /qualityGate:required/);
  assert.match(grouped[0]?.reason ?? "", /tokenGate:exceeded/);
});

test("workflow comparison does not let failed simple baseline win on token cost", () => {
  const output = (variant: "simple" | "chalin", durationMs: number, tokenTotal: number, score: number, pass: boolean) => ({
    variant,
    runIndex: 1,
    durationMs,
    workspace: { caseId: "complex-sqlite-c-tokenizer-bugfix", pass, score },
    trace: { pass: true, score: 100, warnings: [], critical: [] },
    diagnostics: {
      infrastructureFailure: undefined,
      finalAnswerMissing: false,
      verificationPassed: pass,
      duplicateToolCalls: 0,
      chalinRouteCalls: 0,
      chalinRouteNonExecutable: 0,
      toolEvents: 1,
      readCalls: 0,
      writeCalls: 0,
      editCalls: 1,
      retries: 0,
      tokenTotal,
    },
    judge: { pass, score, verdict: "ok", critical: [], warnings: [] },
  });
  const grouped = summarizeComparison([
    output("simple", 5_158, 3_472, 27, false),
    output("chalin", 18_901, 73_977, 100, true),
  ] as never);

  assert.equal(grouped[0]?.pass, true);
  assert.match(grouped[0]?.reason ?? "", /reliabilityDominates:yes/);
  assert.match(grouped[0]?.reason ?? "", /tokenGate:skipped-reliability-dominates/);
});

test("workflow comparison does not let failed simple baseline win solely on speed when chalin is within case budget", () => {
  const output = (variant: "simple" | "chalin", durationMs: number, tokenTotal: number, score: number, pass: boolean) => ({
    variant,
    runIndex: 1,
    durationMs,
    workspace: { caseId: "small-feature-search-filter", pass, score },
    trace: { pass: true, score: 100, warnings: [], critical: [] },
    diagnostics: {
      infrastructureFailure: undefined,
      finalAnswerMissing: false,
      verificationPassed: pass,
      duplicateToolCalls: 0,
      chalinRouteCalls: 0,
      chalinRouteNonExecutable: 0,
      toolEvents: 1,
      readCalls: 0,
      writeCalls: 0,
      editCalls: 1,
      retries: 0,
      tokenTotal,
    },
    judge: { pass, score, verdict: "ok", critical: [], warnings: [] },
  });
  const grouped = summarizeComparison([
    output("simple", 9_424, 30_182, 60, false),
    output("chalin", 30_807, 39_317, 100, true),
  ] as never);

  assert.equal(grouped[0]?.pass, true);
  assert.match(grouped[0]?.reason ?? "", /reliabilityDominates:yes/);
  assert.match(grouped[0]?.reason ?? "", /efficiencyGate:case-budget-dominance/);
});

test("workflow comparison allows quality gains over simple within a reasonable token budget", () => {
  const output = (variant: "simple" | "chalin", durationMs: number, tokenTotal: number, score: number) => ({
    variant,
    runIndex: 1,
    durationMs,
    workspace: { caseId: "complex-sqlite-c-tokenizer-bugfix", pass: true, score },
    trace: { pass: true, score: 100, warnings: [], critical: [] },
    diagnostics: {
      infrastructureFailure: undefined,
      finalAnswerMissing: false,
      verificationPassed: true,
      duplicateToolCalls: 0,
      chalinRouteCalls: 0,
      chalinRouteNonExecutable: 0,
      toolEvents: 1,
      readCalls: 0,
      writeCalls: 0,
      editCalls: 1,
      retries: 0,
      tokenTotal,
    },
    judge: { pass: true, score, verdict: "ok", critical: [], warnings: [] },
  });
  const grouped = summarizeComparison([
    output("simple", 21_898, 27_646, 94),
    output("chalin", 36_000, 45_132, 100),
  ] as never);

  assert.equal(grouped[0]?.pass, true);
  assert.match(grouped[0]?.reason ?? "", /qualityDominates:yes/);
  assert.match(grouped[0]?.reason ?? "", /chalinTokens=45132, simpleTokens=27646/);
  assert.match(grouped[0]?.reason ?? "", /simpleTokenBudget=/);
});

test("workflow comparison accepts major token savings with comparable p95", () => {
  const output = (variant: "simple" | "chalin" | "gentle", durationMs: number, tokenTotal: number) => ({
    variant,
    runIndex: 1,
    durationMs,
    workspace: { caseId: "complex-uv-rust-index-url-bugfix", pass: true, score: 100 },
    trace: { pass: true, score: 100, warnings: [], critical: [] },
    diagnostics: {
      infrastructureFailure: undefined,
      finalAnswerMissing: false,
      verificationPassed: true,
      duplicateToolCalls: 0,
      chalinRouteCalls: 0,
      chalinRouteNonExecutable: 0,
      toolEvents: 1,
      readCalls: 0,
      writeCalls: 1,
      editCalls: 0,
      retries: 0,
      tokenTotal,
    },
    judge: undefined,
  });
  const grouped = summarizeComparison([
    output("simple", 38_000, 30_000),
    output("chalin", 36_700, 20_000),
    output("gentle", 33_500, 93_000),
  ] as never, [comparativeJudgeVerdict("complex-uv-rust-index-url-bugfix", [
    { variant: "simple", durationMs: 38_000, tokens: 30_000 },
    { variant: "chalin", durationMs: 36_700, tokens: 20_000 },
    { variant: "gentle", durationMs: 33_500, tokens: 93_000 },
  ])]);

  assert.equal(grouped[0]?.pass, true);
  assert.match(grouped[0]?.reason ?? "", /costPerfTradeoff:accepted/);
});

test("workflow comparison accepts strong token savings against gentle with reasonable p95 tradeoff", () => {
  const output = (variant: "simple" | "chalin" | "gentle", durationMs: number, tokenTotal: number) => ({
    variant,
    runIndex: 1,
    durationMs,
    workspace: { caseId: "complex-uv-rust-index-url-bugfix", pass: true, score: 100 },
    trace: { pass: true, score: 100, warnings: [], critical: [] },
    diagnostics: {
      infrastructureFailure: undefined,
      finalAnswerMissing: false,
      verificationPassed: true,
      duplicateToolCalls: 0,
      chalinRouteCalls: 0,
      chalinRouteNonExecutable: 0,
      toolEvents: 1,
      readCalls: 0,
      writeCalls: 1,
      editCalls: 0,
      retries: 0,
      tokenTotal,
    },
    judge: undefined,
  });
  const grouped = summarizeComparison([
    output("simple", 17_200, 44_900),
    output("chalin", 17_700, 69_500),
    output("gentle", 14_400, 90_200),
  ] as never, [comparativeJudgeVerdict("complex-uv-rust-index-url-bugfix", [
    { variant: "simple", durationMs: 17_200, tokens: 44_900 },
    { variant: "chalin", durationMs: 17_700, tokens: 69_500 },
    { variant: "gentle", durationMs: 14_400, tokens: 90_200 },
  ])]);

  assert.equal(grouped[0]?.pass, true);
  assert.match(grouped[0]?.reason ?? "", /tokensStronglyBetter:yes/);
  assert.match(grouped[0]?.reason ?? "", /tokensStronglyBetterWithReasonableP95:yes/);
});

test("workflow comparison accepts major token savings against gentle when latency remains bounded", () => {
  const output = (variant: "simple" | "chalin" | "gentle", durationMs: number, tokenTotal: number) => ({
    variant,
    runIndex: 1,
    durationMs,
    workspace: { caseId: "complex-bun-zig-runtime-plan", pass: true, score: 100 },
    trace: { pass: true, score: 100, warnings: [], critical: [] },
    diagnostics: {
      infrastructureFailure: undefined,
      finalAnswerMissing: false,
      verificationPassed: true,
      duplicateToolCalls: 0,
      chalinRouteCalls: 0,
      chalinRouteNonExecutable: 0,
      toolEvents: 1,
      readCalls: 0,
      writeCalls: 1,
      editCalls: 0,
      retries: 0,
      tokenTotal,
    },
    judge: undefined,
  });
  const grouped = summarizeComparison([
    output("simple", 21_000, 36_000),
    output("chalin", 32_000, 62_000),
    output("gentle", 16_000, 118_000),
  ] as never, [comparativeJudgeVerdict("complex-bun-zig-runtime-plan", [
    { variant: "simple", durationMs: 21_000, tokens: 36_000 },
    { variant: "chalin", durationMs: 32_000, tokens: 62_000 },
    { variant: "gentle", durationMs: 16_000, tokens: 118_000 },
  ])]);

  assert.equal(grouped[0]?.pass, true);
  assert.match(grouped[0]?.reason ?? "", /tokensStronglyBetter:yes/);
  assert.match(grouped[0]?.reason ?? "", /majorTokenSavingsBoundedLatency:accepted/);
});

test("workflow comparison accepts judge quality dominance with lower token cost", () => {
  const output = (variant: "simple" | "chalin" | "gentle", durationMs: number, tokenTotal: number, judgeScore: number) => ({
    variant,
    runIndex: 1,
    durationMs,
    workspace: { caseId: "complex-uv-rust-index-url-bugfix", pass: true, score: 100 },
    trace: { pass: true, score: 100, warnings: [], critical: [] },
    diagnostics: {
      infrastructureFailure: undefined,
      finalAnswerMissing: false,
      verificationPassed: true,
      duplicateToolCalls: 0,
      chalinRouteCalls: 0,
      chalinRouteNonExecutable: 0,
      toolEvents: 1,
      readCalls: 0,
      writeCalls: 0,
      editCalls: 1,
      retries: 0,
      tokenTotal,
    },
    judge: { pass: true, score: judgeScore, verdict: "ok", critical: [], warnings: [] },
  });
  const grouped = summarizeComparison([
    output("simple", 34_000, 33_000, 60),
    output("chalin", 44_000, 20_000, 96),
    output("gentle", 36_000, 93_000, 85),
  ] as never);

  assert.equal(grouped[0]?.pass, true);
  assert.equal(grouped[0]?.variants.chalin?.avgJudgeScore, 96);
  assert.match(grouped[0]?.reason ?? "", /judgeQualityDominates:accepted/);
});

test("workflow comparison accepts blind-judge quality lead with lower token cost", () => {
  const output = (variant: "simple" | "chalin" | "gentle", durationMs: number, tokenTotal: number) => ({
    variant,
    runIndex: 1,
    durationMs,
    workspace: { caseId: "complex-rust-workspace-cache-feature", pass: true, score: 100 },
    trace: { pass: true, score: 100, warnings: [], critical: [] },
    diagnostics: {
      infrastructureFailure: undefined,
      finalAnswerMissing: false,
      verificationPassed: true,
      duplicateToolCalls: 0,
      chalinRouteCalls: 0,
      chalinRouteNonExecutable: 0,
      toolEvents: 1,
      readCalls: 0,
      writeCalls: 0,
      editCalls: 1,
      retries: 0,
      tokenTotal,
    },
    judge: { pass: true, score: 100, verdict: "ok", critical: [], warnings: [] },
  });
  const grouped = summarizeComparison([
    output("simple", 21_700, 20_100),
    output("chalin", 13_000, 30_000),
    output("gentle", 9_600, 39_400),
  ] as never, [{
    caseId: "complex-rust-workspace-cache-feature",
    runIndex: 1,
    target: "chalin",
    candidates: [
      { label: "A", variant: "simple", deterministicPass: true, workspaceScore: 100, traceScore: 100, judgeScore: 100, durationMs: 21_700, tokens: 20_100 },
      { label: "B", variant: "gentle", deterministicPass: true, workspaceScore: 100, traceScore: 100, judgeScore: 100, durationMs: 9_600, tokens: 39_400 },
      { label: "C", variant: "chalin", deterministicPass: true, workspaceScore: 100, traceScore: 100, judgeScore: 100, durationMs: 13_000, tokens: 37_200 },
    ],
    winnerLabel: "C",
    winnerVariant: "chalin",
    ranking: ["C", "B", "A"],
    scores: { A: 98, B: 99, C: 100 },
    targetWins: true,
    targetRank: 1,
    verdict: "target has better local test coverage",
    critical: [],
    warnings: [],
  } as never]);

  assert.equal(grouped[0]?.pass, true);
  assert.match(grouped[0]?.reason ?? "", /blindJudgeQualityDominates:accepted/);
  assert.match(grouped[0]?.reason ?? "", /tokensStronglyBetter:yes/);
});

test("workflow comparison applies blind judge quality lead against simple baseline", () => {
  const output = (variant: "simple" | "chalin", durationMs: number, tokenTotal: number) => ({
    variant,
    runIndex: 1,
    durationMs,
    workspace: { caseId: "complex-bun-zig-runtime-plan", pass: true, score: 100 },
    trace: { pass: true, score: 100, warnings: [], critical: [] },
    diagnostics: {
      infrastructureFailure: undefined,
      finalAnswerMissing: false,
      verificationPassed: false,
      duplicateToolCalls: 0,
      chalinRouteCalls: 0,
      chalinRouteNonExecutable: 0,
      toolEvents: 1,
      readCalls: 0,
      writeCalls: 1,
      editCalls: 0,
      retries: 0,
      tokenTotal,
    },
    judge: { pass: true, score: 100, verdict: "ok", critical: [], warnings: [] },
  });
  const grouped = summarizeComparison([
    output("simple", 15_000, 42_000),
    output("chalin", 30_000, 61_000),
  ] as never, [{
    caseId: "complex-bun-zig-runtime-plan",
    runIndex: 1,
    target: "chalin",
    candidates: [
      { label: "A", variant: "simple", deterministicPass: true, workspaceScore: 100, traceScore: 100, durationMs: 15_000, tokens: 42_000 },
      { label: "B", variant: "chalin", deterministicPass: true, workspaceScore: 100, traceScore: 100, durationMs: 30_000, tokens: 61_000 },
    ],
    winnerLabel: "B",
    winnerVariant: "chalin",
    ranking: ["B", "A"],
    scores: { A: 98, B: 100 },
    targetWins: true,
    targetRank: 1,
    verdict: "target produced the stronger plan",
    critical: [],
    warnings: [],
  } as never]);

  assert.equal(grouped[0]?.pass, true);
  assert.match(grouped[0]?.reason ?? "", /blindJudgeQualityDominates:accepted/);
});

test("workflow comparison accepts a token premium when blind judge prefers chalin quality", () => {
  const output = (variant: "simple" | "chalin" | "gentle", workspaceScore: number, durationMs: number, tokenTotal: number) => ({
    variant,
    runIndex: 1,
    durationMs,
    workspace: { caseId: "complex-bun-zig-rust-lockfile-triage", pass: true, score: workspaceScore },
    trace: { pass: true, score: 100, warnings: [], critical: [] },
    diagnostics: {
      infrastructureFailure: undefined,
      finalAnswerMissing: false,
      verificationPassed: true,
      duplicateToolCalls: 0,
      chalinRouteCalls: 0,
      chalinRouteNonExecutable: 0,
      toolEvents: 1,
      readCalls: 0,
      writeCalls: 1,
      editCalls: 0,
      retries: 0,
      tokenTotal,
    },
    judge: { pass: true, score: workspaceScore, verdict: "ok", critical: [], warnings: [] },
  });
  const grouped = summarizeComparison([
    output("simple", 100, 14_900, 43_000),
    output("chalin", 100, 21_700, 86_000),
    output("gentle", 94, 14_100, 75_000),
  ] as never, [comparativeJudgeVerdict("complex-bun-zig-rust-lockfile-triage", [
    { variant: "simple", durationMs: 14_900, tokens: 43_000 },
    { variant: "chalin", durationMs: 21_700, tokens: 86_000 },
    { variant: "gentle", durationMs: 14_100, tokens: 75_000, workspaceScore: 94 },
  ])]);

  assert.equal(grouped[0]?.pass, true);
  assert.match(grouped[0]?.reason ?? "", /efficiencyGate:skipped-quality-dominates/);
  assert.match(grouped[0]?.reason ?? "", /tokensAcceptableWithQualityLead:yes/);
  assert.match(grouped[0]?.reason ?? "", /tokensStronglyBetter:no/);
  assert.match(grouped[0]?.reason ?? "", /costGate:strong-vs-gentle/);
  assert.match(grouped[0]?.reason ?? "", /blindJudgeQualityDominates:accepted/);
});

test("workflow comparison follows blind judge recommendation over deterministic quality heuristics", () => {
  const output = (variant: "simple" | "chalin" | "gentle", workspaceScore: number, durationMs: number, tokenTotal: number) => ({
    variant,
    runIndex: 1,
    durationMs,
    workspace: { caseId: "complex-bun-zig-rust-lockfile-triage", pass: true, score: workspaceScore },
    trace: { pass: true, score: 100, warnings: [], critical: [] },
    diagnostics: {
      infrastructureFailure: undefined,
      finalAnswerMissing: false,
      verificationPassed: true,
      duplicateToolCalls: 0,
      chalinRouteCalls: 0,
      chalinRouteNonExecutable: 0,
      toolEvents: 1,
      readCalls: 0,
      writeCalls: 1,
      editCalls: 0,
      retries: 0,
      tokenTotal,
    },
    judge: { pass: true, score: workspaceScore, verdict: "ok", critical: [], warnings: [] },
  });
  const grouped = summarizeComparison([
    output("simple", 94, 18_000, 28_000),
    output("chalin", 100, 22_000, 38_000),
    output("gentle", 95, 17_000, 34_000),
  ] as never, [comparativeJudgeVerdict("complex-bun-zig-rust-lockfile-triage", [
    { variant: "simple", durationMs: 18_000, tokens: 28_000, workspaceScore: 94 },
    { variant: "chalin", durationMs: 22_000, tokens: 38_000, workspaceScore: 100 },
    { variant: "gentle", durationMs: 17_000, tokens: 34_000, workspaceScore: 95 },
  ], "gentle")]);

  assert.equal(grouped[0]?.pass, false);
  assert.match(grouped[0]?.reason ?? "", /blindJudgeQualityDominates:rejected/);
  assert.match(grouped[0]?.comparativeJudges?.[0]?.winnerVariant ?? "", /gentle/);
});

test("workflow comparison accepts pareto quality and cost lead over gentle", () => {
  const output = (variant: "simple" | "chalin" | "gentle", workspaceScore: number, durationMs: number, tokenTotal: number, judgeScore: number) => ({
    variant,
    runIndex: 1,
    durationMs,
    workspace: { caseId: "complex-cpython-c-unicode-regression", pass: true, score: workspaceScore },
    trace: { pass: true, score: 100, warnings: [], critical: [] },
    diagnostics: {
      infrastructureFailure: undefined,
      finalAnswerMissing: false,
      verificationPassed: true,
      duplicateToolCalls: 0,
      chalinRouteCalls: 0,
      chalinRouteNonExecutable: 0,
      toolEvents: 1,
      readCalls: 0,
      writeCalls: 0,
      editCalls: 1,
      retries: 0,
      tokenTotal,
    },
    judge: { pass: true, score: judgeScore, verdict: "ok", critical: [], warnings: [] },
  });
  const grouped = summarizeComparison([
    output("simple", 100, 12_798, 29_254, 92),
    output("chalin", 100, 14_195, 62_784, 98),
    output("gentle", 87, 15_942, 67_768, 94),
  ] as never);

  assert.equal(grouped[0]?.pass, true);
  assert.match(grouped[0]?.reason ?? "", /paretoQualityCostLead:accepted/);
  assert.match(grouped[0]?.reason ?? "", /costGate:strong-vs-gentle/);
});

test("workflow comparison does not let a failed gentle run win only by cheap tokens", () => {
  const output = (variant: "chalin" | "gentle", pass: boolean, workspaceScore: number, durationMs: number, tokenTotal: number) => ({
    variant,
    runIndex: 1,
    durationMs,
    workspace: { caseId: "complex-sqlite-c-tokenizer-bugfix", pass, score: workspaceScore },
    trace: { pass, score: pass ? 100 : 65, warnings: [], critical: pass ? [] : [{ id: "workspace-quality" }] },
    diagnostics: {
      infrastructureFailure: undefined,
      finalAnswerMissing: false,
      verificationPassed: pass,
      duplicateToolCalls: 0,
      chalinRouteCalls: 0,
      chalinRouteNonExecutable: 0,
      toolEvents: 1,
      readCalls: 0,
      writeCalls: 0,
      editCalls: pass ? 1 : 0,
      retries: 0,
      tokenTotal,
    },
    judge: undefined,
  });
  const grouped = summarizeComparison([
    output("chalin", true, 100, 34_000, 72_000),
    output("gentle", false, 21, 2_000, 6_000),
  ] as never);

  assert.equal(grouped[0]?.pass, true);
  assert.match(grouped[0]?.reason ?? "", /reliabilityDominates:yes/);
  assert.match(grouped[0]?.reason ?? "", /costGate:strong-vs-gentle/);
});

test("workflow comparison treats perfect workspace quality as dominant over sub-95 competitors", () => {
  const output = (variant: "chalin" | "gentle", workspaceScore: number, traceScore: number, durationMs: number, tokenTotal: number, recovered = false) => ({
    variant,
    runIndex: 1,
    durationMs,
    workspace: { caseId: "complex-redis-c-expire-feature", pass: true, score: workspaceScore },
    trace: {
      pass: true,
      score: traceScore,
      warnings: recovered ? [{ id: "duration-budget-exceeded" }] : [],
      critical: [],
    },
    diagnostics: {
      recoveredInfrastructureFailures: recovered ? [{ kind: "agent-stall", message: "workflow variant timeout after 60000ms" }] : undefined,
      infrastructureFailure: undefined,
      finalAnswerMissing: false,
      verificationPassed: true,
      duplicateToolCalls: 0,
      chalinRouteCalls: 0,
      chalinRouteNonExecutable: 0,
      toolEvents: 1,
      readCalls: 0,
      writeCalls: 1,
      editCalls: 0,
      retries: recovered ? 1 : 0,
      tokenTotal,
    },
    judge: undefined,
  });
  const grouped = summarizeComparison([
    output("chalin", 100, 88, 52_000, 50_000, true),
    output("gentle", 94, 100, 34_000, 118_000),
  ] as never);

  assert.equal(grouped[0]?.pass, true);
  assert.equal(grouped[0]?.variants.chalin?.avgTraceScore, 100);
  assert.match(grouped[0]?.reason ?? "", /efficiencyGate:skipped-quality-dominates/);
});

test("workflow comparative judge prompt is blind to harness names", () => {
  const output = (variant: "simple" | "chalin", score: number, durationMs: number, tokenTotal: number) => ({
    variant,
    runIndex: 1,
    durationMs,
    finalText: "Changed src/filterTasks.ts and test/filterTasks.test.ts. Verification: bun test passed.",
    evidence: { files: [{ path: "src/filterTasks.ts", contentSnippet: "export function filterTasks() { return []; }" }] },
    workspace: { caseId: "small-feature-search-filter", kind: "small-feature", suite: "calibration", pass: true, qualityScore: score, efficiencyScore: 100, score, matched: [], missing: [], metrics: { validation: { status: "pass" } }, critical: [], warnings: [] },
    trace: {
      pass: true,
      score: 100,
      effectiveAnswerSource: variant === "chalin" ? "chalin_route" : "assistant",
      effectiveAnswerChars: 80,
      metrics: { toolEvents: 4, chalinRouteStarts: variant === "chalin" ? 1 : 0 },
      critical: variant === "chalin" ? [{ id: "missing-chalin-route-result", severity: "critical", message: "No hay texto final evaluable ni material de `chalin_route`.", penalty: 45 }] : [],
      warnings: variant === "chalin" ? [{ id: "parent-tools-after-chalin", severity: "warning", message: "El parent siguió explorando con tools directas después de terminar `chalin_route`.", evidence: "1 exploratory tool event", penalty: 10 }] : [],
    },
    diagnostics: { infrastructureFailure: undefined, finalAnswerMissing: false, verificationPassed: true, duplicateToolCalls: 0, chalinRouteCalls: 0, chalinRouteNonExecutable: 0, toolEvents: 4, tokenTotal, readCalls: 1, writeCalls: 0, editCalls: 1, retries: 0 },
    judge: { pass: true, score, verdict: "ok", critical: [], warnings: [] },
  });
  const fixture = createWorkflowFixture("small-feature-search-filter");
  try {
    const prompt = buildWorkflowComparativeJudgePrompt(fixture.case, [
      { label: "A", output: output("simple", 99, 20_000, 25_000) as never },
      { label: "B", output: output("chalin", 100, 18_000, 20_000) as never },
    ]);

    assert.match(prompt, /juez ciego/i);
    assert.match(prompt, /Candidate A/);
    assert.match(prompt, /Candidate B/);
    assert.match(prompt, /calidad como criterio dominante/i);
    assert.match(prompt, /tokens consumidos, duración y tool calls/i);
    assert.match(prompt, /Efficiency metrics: durationMs=20000; tokens=25000; toolCalls=4/i);
    assert.doesNotMatch(prompt, /NO uses duración, tokens o número de tools/i);
    assert.doesNotMatch(prompt, /"durationMs"|"tokens"|tokenTotal|"toolEvents"|chalinRoute|effectiveAnswerSource/i);
    assert.doesNotMatch(prompt, /\b(simple|chalin|gentle|chalin_route|pi-chalin)\b/i);
    assert.match(prompt, /route tool/i);
  } finally {
    fs.rmSync(fixture.cwd, { recursive: true, force: true });
  }
});

test("workflow production fast-path audit scans prod harness surfaces for eval markers", () => {
  const audit = auditWorkflowProductionFastPaths(process.cwd());
  assert.equal(audit.pass, true);
  assert.ok(audit.scannedFiles > 0);

  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-chalin-fast-path-audit-"));
  try {
    fs.mkdirSync(path.join(root, "src"), { recursive: true });
    fs.writeFileSync(path.join(root, "src", "autoroute.ts"), "export const shortcut = 'small-feature-search-filter';\n");
    const poisoned = auditWorkflowProductionFastPaths(root);
    assert.equal(poisoned.pass, false);
    assert.ok(poisoned.critical.some((item) => /small-feature-search-filter/.test(item)));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("workflow judge JSON parser extracts balanced judge object from prose", () => {
  const parsed = parseJsonObjectFromText([
    "```json",
    "{\"example\":true}",
    "```",
    "Final verdict:",
    "{\"winner\":\"C\",\"ranking\":[\"C\",\"A\",\"B\"],\"scores\":{\"A\":98,\"B\":97,\"C\":100},\"verdict\":\"uses braces {inside text} safely\",\"critical\":[],\"warnings\":[]}",
  ].join("\n"));

  assert.equal(parsed.winner, "C");
  assert.deepEqual(parsed.ranking, ["C", "A", "B"]);
  assert.equal((parsed.scores as Record<string, number>).C, 100);
});

test("workflow gates fail when blind judge win rate is below target", () => {
  const output = (variant: "simple" | "chalin", score: number, durationMs: number, tokenTotal: number) => ({
    variant,
    runIndex: 1,
    durationMs,
    workspace: { caseId: "small-feature-search-filter", pass: true, score },
    trace: { pass: true, score: 100, warnings: [], critical: [] },
    diagnostics: {
      infrastructureFailure: undefined,
      finalAnswerMissing: false,
      verificationPassed: true,
      duplicateToolCalls: 0,
      chalinRouteCalls: 0,
      chalinRouteNonExecutable: 0,
      toolEvents: 1,
      readCalls: 0,
      writeCalls: 1,
      editCalls: 0,
      retries: 0,
      tokenTotal,
    },
    judge: undefined,
  });
  const grouped = summarizeComparison([
    output("simple", 94, 10_000, 1_000),
    output("chalin", 100, 9_000, 800),
  ] as never, [{
    caseId: "small-feature-search-filter",
    runIndex: 1,
    target: "chalin",
    candidates: [
      { label: "A", variant: "simple", deterministicPass: true, workspaceScore: 94, traceScore: 100, durationMs: 10_000, tokens: 1_000 },
      { label: "B", variant: "chalin", deterministicPass: true, workspaceScore: 100, traceScore: 100, durationMs: 9_000, tokens: 800 },
    ],
    winnerLabel: "A",
    winnerVariant: "simple",
    ranking: ["A", "B"],
    scores: { A: 100, B: 99 },
    targetWins: false,
    targetRank: 2,
    verdict: "competitor was better",
    critical: [],
    warnings: [],
  } as never]);

  assert.equal(grouped[0]?.pass, false);
  assert.match(grouped[0]?.reason ?? "", /blind-judge/);
  assert.match(grouped[0]?.reason ?? "", /blindJudgeQualityDominates:rejected/);
  assert.equal(grouped[0]?.comparativeJudges?.[0]?.winnerVariant, "simple");
  const gates = evaluateWorkflowRegressionGates([], grouped);
  assert.equal(gates.pass, false);
  assert.ok(gates.failures.some((item) => /comparison gate failed/.test(item)));
  assert.ok(gates.failures.some((item) => /blind judge chalin winRate 0/.test(item)));
});

test("workflow gates warn on single-sample blind judge wins and fail split case stability", () => {
  const output = (variant: "simple" | "chalin", runIndex: number) => ({
    variant,
    runIndex,
    durationMs: variant === "chalin" ? 9_000 : 12_000,
    workspace: { caseId: "complex-bun-zig-runtime-plan", pass: true, score: 100 },
    trace: { pass: true, score: 100, warnings: [], critical: [] },
    diagnostics: {
      infrastructureFailure: undefined,
      finalAnswerMissing: false,
      verificationPassed: false,
      duplicateToolCalls: 0,
      chalinRouteCalls: 0,
      chalinRouteNonExecutable: 0,
      toolEvents: 4,
      readCalls: 2,
      writeCalls: 0,
      editCalls: 1,
      retries: 0,
      tokenTotal: variant === "chalin" ? 50_000 : 55_000,
      traceSummary: { directEligible: true, postVerificationExplorationCalls: 0, postVerificationShellCalls: 0, postVerificationToolCallsByName: {}, toolCallSequence: ["read", "edit"] },
    },
    judge: undefined,
  });
  const single = summarizeComparison([
    output("simple", 1),
    output("chalin", 1),
  ] as never, [comparativeJudgeVerdict("complex-bun-zig-runtime-plan", [
    { variant: "simple", durationMs: 12_000, tokens: 55_000 },
    { variant: "chalin", durationMs: 9_000, tokens: 50_000 },
  ], "chalin")]);
  const singleGates = evaluateWorkflowRegressionGates([], single);
  assert.equal(singleGates.pass, true);
  assert.ok(singleGates.warnings.some((item) => /single-sample/.test(item)));

  const split = summarizeComparison([
    output("simple", 1),
    output("chalin", 1),
    output("simple", 2),
    output("chalin", 2),
  ] as never, [
    comparativeJudgeVerdict("complex-bun-zig-runtime-plan", [
      { variant: "simple", durationMs: 12_000, tokens: 55_000 },
      { variant: "chalin", durationMs: 9_000, tokens: 50_000 },
    ], "chalin"),
    Object.assign(comparativeJudgeVerdict("complex-bun-zig-runtime-plan", [
      { variant: "simple", durationMs: 11_000, tokens: 45_000 },
      { variant: "chalin", durationMs: 10_000, tokens: 72_000 },
    ], "simple") as object, { runIndex: 2 }) as never,
  ]);
  const splitGates = evaluateWorkflowRegressionGates([], split);
  assert.equal(splitGates.pass, false);
  assert.ok(splitGates.failures.some((item) => /blind judge case winRate 0.5/.test(item)));
});

test("workflow comparison keeps competitor infrastructure failures as warnings outside target gate", () => {
  const output = (variant: "simple" | "chalin" | "gentle", runIndex: number, durationMs: number, score: number, infra = false) => ({
    variant,
    runIndex,
    durationMs,
    workspace: { caseId: "holdout-scaffold-config-loader", pass: !infra, score },
    trace: { pass: !infra, score: infra ? 0 : 100, warnings: [], critical: infra ? [{ id: "timeout" }] : [] },
    diagnostics: {
      infrastructureFailure: infra ? { kind: "agent-stall", message: "workflow variant timeout after 60000ms" } : undefined,
      finalAnswerMissing: infra,
      verificationPassed: !infra,
      duplicateToolCalls: 0,
      chalinRouteCalls: 0,
      chalinRouteNonExecutable: 0,
      toolEvents: 1,
      readCalls: 0,
      writeCalls: 1,
      editCalls: 0,
      retries: 0,
      tokenTotal: durationMs,
    },
    judge: undefined,
  });
  const grouped = summarizeComparison([
    output("simple", 1, 90_000, 2, true),
    output("chalin", 1, 30_000, 100),
    output("gentle", 1, 80_000, 16, true),
  ] as never);

  assert.equal(grouped[0]?.pass, true);
  assert.doesNotMatch(grouped[0]?.reason ?? "", /infrastructure-failure/);
  assert.ok(grouped[0]?.comparisons.every((item) => item.pass));
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

test("workflow workspace scoring flags incomplete or truncated review-only docs plans", () => {
  const fixture = createWorkflowFixture("complex-bun-zig-runtime-plan");
  try {
    fs.writeFileSync(path.join(fixture.cwd, "docs", "deny-net-plan.md"), [
      "# deny-net plan",
      "",
      "Estado actual: src/cli.zig parses CLI options and src/bindings/runtime.zig bridges into crates/runtime/src/permissions.rs.",
      "Arquitectura target: carry deny-net across the FFI boundary into RuntimePermissions.",
      "Pasos incrementales: parse flag, extend binding payload, map runtime permissions.",
      "Riesgos: FFI compatibility and CLI/runtime drift.",
      "Validacion: add CLI parser tests, binding tests and runtime permission tests.",
      "## Rollback",
    ].join("\n"));

    const report = scoreWorkflowWorkspace(fixture.cwd, fixture.case, { finalText: "Updated docs/deny-net-plan.md with validation.", validateTests: false });

    assert.equal(report.metrics.documentationPlan.checked, true);
    assert.equal(report.metrics.documentationPlan.truncated, true);
    assert.ok(report.warnings.some((item) => item.id === "documentation-plan-truncated"));
  } finally {
    fs.rmSync(fixture.cwd, { recursive: true, force: true });
  }
});





test("workflow failure UX summarizes what happened and the next step", () => {
  const failures = summarizeWorkflowFailures([{
    variant: "chalin",
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

test("workflow gates report late provider errors as infra warnings when output is already valid", () => {
  const output = {
    variant: "chalin",
    runIndex: 1,
    workspace: {
      caseId: "complex-llvm-cpp-diagnostic-plan",
      pass: true,
      score: 100,
      qualityScore: 100,
      efficiencyScore: 100,
      matched: [],
      missing: [],
      critical: [],
      warnings: [],
      metrics: { validation: { status: "skipped" } },
    },
    trace: { pass: true, score: 100, warnings: [], critical: [] },
    diagnostics: {
      infrastructureFailure: { kind: "provider-error", message: "provider error after terminal final" },
      recoveredInfrastructureFailures: undefined,
      finalAnswerMissing: false,
      verificationPassed: false,
      duplicateToolCalls: 0,
      chalinRouteCalls: 0,
      chalinRouteValidationErrors: 0,
      antiCheat: { pass: true, critical: [], warnings: [], accessed: [] },
    },
    judge: { pass: true, score: 95, verdict: "valid", critical: [], warnings: [] },
  } as never;

  const gates = evaluateWorkflowRegressionGates([output], []);
  assert.equal(gates.pass, true);
  assert.ok(gates.warnings.some((item) => /infrastructure failure provider-error/.test(item)));
  assert.equal(gates.failures.some((item) => /output did not pass|infrastructure failure/.test(item)), false);
});

test("workflow gates do not count skipped blind judges against win rate", () => {
  const grouped = [{
    caseId: "community-go-retry-backoff",
    pass: true,
    reason: "all deterministic checks passed",
    variants: {
      chalin: {
        runs: 1,
        passCount: 1,
        passRate: 1,
        infrastructureFailures: 0,
        avgWorkspaceScore: 100,
        avgTraceScore: 100,
        avgDurationMs: 20_000,
        p95DurationMs: 20_000,
        verificationPassRate: 1,
        avgToolCalls: 8,
        avgReadCalls: 2,
        avgWriteCalls: 0,
        avgEditCalls: 1,
        avgRetries: 0,
        avgAgentRetries: 0,
        avgInfraRetries: 0,
        avgAntiCheatCriticals: 0,
        avgChalinRouteCalls: 0,
        avgChalinRouteNonExecutable: 0,
        avgChalinRouteValidationErrors: 0,
        avgDuplicateToolCalls: 0,
        avgTokens: 10_000,
        totalTokens: 10_000,
        estimatedCostUsd: 0.05,
        flakiness: 0,
      },
    },
    comparisons: [],
    comparativeJudges: [{
      caseId: "community-go-retry-backoff",
      runIndex: 1,
      target: "chalin",
      candidates: [],
      ranking: [],
      scores: {},
      targetWins: false,
      verdict: "Comparative judge skipped after infrastructure failure",
      critical: [],
      warnings: ["workflow judge timeout after 45000ms"],
      skipped: true,
      reason: "judge-infrastructure",
    }],
  }] as never;

  const gates = evaluateWorkflowRegressionGates([], grouped);
  assert.equal(gates.pass, true);
  assert.ok(gates.warnings.some((item) => /blind judge skipped/.test(item)));
  assert.equal(gates.failures.some((item) => /blind judge chalin winRate/.test(item)), false);
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

test("workflow anti-cheat audit fails explicit oracle access in tool arguments", () => {
  const stdout = [
    JSON.stringify({ type: "tool_execution_start", toolName: "read", args: { path: `${WORKFLOW_ORACLE_DIR}/README.md` } }),
    JSON.stringify({ type: "tool_execution_end", toolName: "read", isError: false, result: { content: "oracle canary" } }),
  ].join("\n");
  const report = auditWorkflowTraceForCheating(stdout, getWorkflowEvalCase("small-feature-search-filter"));
  assert.equal(report.pass, false);
  assert.equal(report.accessed[0]?.surface, "arguments");
  assert.match(report.critical.join("\n"), /forbidden marker/);
});

test("workflow anti-cheat audit fails forbidden markers exposed by tool results", () => {
  const stdout = [
    JSON.stringify({ type: "tool_execution_start", toolName: "bash", args: { cmd: "find . -maxdepth 2 -type f" } }),
    JSON.stringify({ type: "tool_execution_end", toolName: "bash", isError: false, result: { stdout: `./${WORKFLOW_ORACLE_DIR}/answer-key.json\n./src/filterTasks.ts` } }),
  ].join("\n");
  const report = auditWorkflowTraceForCheating(stdout, getWorkflowEvalCase("small-feature-search-filter"));
  assert.equal(report.pass, false);
  assert.equal(report.accessed[0]?.surface, "result");
  assert.match(report.critical.join("\n"), /result exposed forbidden marker/);
});

test("workflow anti-cheat audit fails forbidden markers leaked in assistant output", () => {
  const stdout = [
    JSON.stringify({ type: "message_delta", assistantMessageEvent: { type: "text_delta", delta: `I used ${WORKFLOW_ORACLE_DIR}/answer-key.json` } }),
    JSON.stringify({ type: "message_end", message: { role: "assistant", content: `I used ${WORKFLOW_ORACLE_DIR}/answer-key.json`, stopReason: "stop" } }),
  ].join("\n");
  const report = auditWorkflowTraceForCheating(stdout, getWorkflowEvalCase("small-feature-search-filter"));
  assert.equal(report.pass, false);
  assert.equal(report.accessed[0]?.surface, "assistant");
  assert.match(report.critical.join("\n"), /assistant output referenced forbidden marker/);
});

test("workflow token accounting uses the final cumulative usage per response", () => {
  const childUsage = { input: 20, output: 10, cacheRead: 0, cacheWrite: 0, totalTokens: 30, cost: { input: 0.02, output: 0.03, cacheRead: 0, cacheWrite: 0, total: 0.05 } };
  const stdout = [
    JSON.stringify({ type: "message_update", message: { responseId: "r1", usage: { input: 1, output: 9, totalTokens: 10 } } }),
    JSON.stringify({ type: "message_end", message: { role: "assistant", responseId: "r1", usage: { input: 10, output: 15, totalTokens: 25, cost: { input: 0.01, output: 0.015, total: 0.025 } } } }),
    JSON.stringify({ type: "turn_end", messages: [{ role: "assistant", responseId: "r1", usage: { input: 10, output: 15, totalTokens: 25, cost: { input: 0.01, output: 0.015, total: 0.025 } } }] }),
    JSON.stringify({ type: "message_update", assistantMessageEvent: { partial: { responseId: "r2", usage: { input: 3, output: 4, totalTokens: 7 } } } }),
    JSON.stringify({ type: "message_end", message: { role: "assistant", responseId: "r2", usage: { input: 5, output: 7, totalTokens: 12, cost: { input: 0.005, output: 0.007, total: 0.012 } } } }),
    JSON.stringify({ type: "message_end", message: { role: "toolResult", toolCallId: "tool-1", details: { result: { run: { id: "child-run-1", metrics: { usage: childUsage } } } } } }),
    JSON.stringify({ type: "tool_execution_end", toolCallId: "tool-1", result: { details: { result: { run: { id: "child-run-1", metrics: { usage: childUsage } } } } } }),
  ].join("\n");
  const usage = extractWorkflowUsage(stdout);
  assert.equal(extractTokenTotal(stdout), 67);
  assert.equal(usage.input, 35);
  assert.equal(usage.output, 32);
  assert.ok(Math.abs(usage.cost.total - 0.087) < 0.000001);
});

test("workflow gates fail Chalin outputs with anti-cheat criticals", () => {
  const gates = evaluateWorkflowRegressionGates([{
    variant: "chalin",
    runIndex: 1,
    workspace: { caseId: "small-feature-search-filter", pass: true, score: 100 },
    trace: { pass: true, score: 100, critical: [], warnings: [] },
    diagnostics: {
      infrastructureFailure: undefined,
      recoveredInfrastructureFailures: undefined,
      finalAnswerMissing: false,
      verificationPassed: true,
      duplicateToolCalls: 0,
      chalinRouteCalls: 0,
      chalinRouteValidationErrors: 0,
      antiCheat: { pass: false, critical: [`read arguments referenced forbidden marker ${WORKFLOW_ORACLE_DIR}`], warnings: [], accessed: [] },
    },
    judge: undefined,
  } as never], []);
  assert.equal(gates.pass, false);
  assert.ok(gates.failures.some((item) => /anti-cheat boundary violation/.test(item)));
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
  assert.equal(terminal.terminalWithoutAnswer, false);
  assert.equal(extractFinalText(JSON.stringify({
    type: "message_end",
    message: { role: "assistant", content: [{ type: "text", text: "Hecho final" }] },
  }) + "\n"), "Hecho final");

  const emptyTerminal = observeTerminalAssistantAnswer(JSON.stringify({
    type: "message_end",
    message: { role: "assistant", stopReason: "stop", content: [] },
  }) + "\n");
  assert.equal(emptyTerminal.terminalAnswer, false);
  assert.equal(emptyTerminal.terminalWithoutAnswer, true);
  assert.equal(detectWorkflowInfrastructureFailure("", "", "workflow empty assistant response without final evidence")?.kind, "agent-stall");

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

test("workflow eval uses executable chalin_route material as effective final answer", () => {
  const routeMaterial = "Final answer material:\nChanged: docs/plan.md\nVerification: docs read\nNotes: source evidence covered.";
  const stdout = [
    JSON.stringify({ type: "tool_execution_start", toolName: "chalin_route", args: { topology: "chain" } }),
    JSON.stringify({ type: "tool_execution_end", toolName: "chalin_route", isError: false, result: { content: [{ type: "text", text: routeMaterial }] } }),
  ].join("\n");

  assert.equal(extractFinalText(stdout), "");
  assert.equal(effectiveWorkflowFinalText(stdout, "", "chalin"), routeMaterial);
  assert.equal(effectiveWorkflowFinalText(stdout, "", "simple"), "");
});

test("workflow diagnostics count tool execution updates as progress, not duplicate calls", () => {
  const stdout = [
    JSON.stringify({ type: "tool_execution_start", toolName: "chalin_route", args: { topology: "chain", task: "docs" } }),
    JSON.stringify({ type: "tool_execution_update", toolName: "chalin_route", args: { topology: "chain", task: "docs" } }),
    JSON.stringify({ type: "tool_execution_update", toolName: "chalin_route", args: { topology: "chain", task: "docs" } }),
    JSON.stringify({ type: "tool_execution_end", toolName: "chalin_route", isError: false, result: { content: [{ type: "text", text: "Final answer material: done" }] } }),
  ].join("\n");

  const diagnostics = workflowDiagnostics(getWorkflowEvalCase("complex-bun-zig-rust-lockfile-triage"), stdout, "", undefined, undefined, undefined, false);
  assert.equal(diagnostics.chalinRouteCalls, 1);
  assert.equal(diagnostics.duplicateToolCalls, 0);
});

test("workflow diagnostics summarize post-verification exploration waste", () => {
  const stdout = [
    JSON.stringify({ type: "tool_execution_start", toolName: "read", args: { path: "src/filterTasks.ts" } }),
    JSON.stringify({ type: "tool_execution_end", toolName: "read", isError: false, result: { content: "source" } }),
    JSON.stringify({ type: "tool_execution_start", toolName: "edit", args: { path: "src/filterTasks.ts" } }),
    JSON.stringify({ type: "tool_execution_end", toolName: "edit", isError: false, result: { content: "ok" } }),
    JSON.stringify({ type: "tool_execution_start", toolName: "bash", args: { command: "bun test" } }),
    JSON.stringify({ type: "tool_execution_end", toolName: "bash", isError: false, result: { content: "pass" } }),
    JSON.stringify({ type: "tool_execution_start", toolName: "grep", args: { pattern: "filterTasks" } }),
    JSON.stringify({ type: "tool_execution_end", toolName: "grep", isError: false, result: { content: "hit" } }),
    JSON.stringify({ type: "tool_execution_start", toolName: "bash", args: { command: "git diff -- src/filterTasks.ts" } }),
  ].join("\n");

  const diagnostics = workflowDiagnostics(getWorkflowEvalCase("small-feature-search-filter"), stdout, "", undefined, undefined, undefined, false);
  assert.equal(diagnostics.traceSummary.directEligible, true);
  assert.equal(diagnostics.traceSummary.firstMutationEventIndex, 2);
  assert.equal(diagnostics.traceSummary.firstPassingVerificationEventIndex, 5);
  assert.equal(diagnostics.traceSummary.postVerificationExplorationCalls, 1);
  assert.equal(diagnostics.traceSummary.postVerificationShellCalls, 1);
  assert.deepEqual(diagnostics.traceSummary.postVerificationToolCallsByName, { bash: 1, grep: 1 });
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
  const prompt = buildWorkflowJudgePrompt({ variant: "chalin", finalText: "done", workspace, trace: output.trace, diagnostics: output.diagnostics, evidence: collectWorkflowEvidence(fixture.cwd) } as unknown as never, fixture.case);
  assert.match(prompt, /SOLO JSON/);
  assert.match(prompt, /Snippets de archivos/);
  assert.match(prompt, /src\/filterTasks\.ts/);
  fs.rmSync(fixture.cwd, { recursive: true, force: true });
});

test("workflow scorer lets hidden validation resolve source-content heuristic misses", () => {
  const fixture = createWorkflowFixture("complex-sqlite-c-tokenizer-bugfix");
  try {
    fs.writeFileSync(path.join(fixture.cwd, "src/sql_tokenizer.c"), `#include "sql_tokenizer.h"
#include <ctype.h>

int count_sql_tokens(const char *sql) {
    int tokens = 0;
    int in_token = 0;
    int in_single_quote = 0;

    for (const char *p = sql; *p; ++p) {
        if (in_single_quote) {
            if (*p == '\\'') {
                if (*(p + 1) == '\\'') {
                    ++p;
                    continue;
                }
                in_single_quote = 0;
            }
            continue;
        }

        if (isspace((unsigned char)*p)) {
            in_token = 0;
            continue;
        }

        if (*p == '-' && *(p + 1) == '-') {
            in_token = 0;
            ++p;
            while (p[1] && p[1] != '\\n') ++p;
            continue;
        }

        if (*p == '\\'') {
            ++tokens;
            in_single_quote = 1;
            in_token = 0;
            continue;
        }

        if (!in_token) {
            ++tokens;
            in_token = 1;
        }
    }

    return tokens;
}
`);
    const workspace = scoreWorkflowWorkspace(fixture.cwd, fixture.case, {
      finalText: "Changed src/sql_tokenizer.c and tests/test_sql_tokenizer.c. Verification: make test passed.",
      validateTests: true,
      durationMs: 1000,
    });
    assert.equal(workspace.pass, true);
    assert.equal(workspace.score, 100);
    assert.equal(workspace.critical.some((issue) => issue.id === "missing-required-content"), false);
    assert.ok(workspace.warnings.some((issue) => issue.id === "static-content-evidence-missing"));
    assert.equal(workspace.warnings.find((issue) => issue.id === "static-content-evidence-missing")?.penalty, 0);

    const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
    const output = {
      variant: "chalin",
      runIndex: 1,
      cwd: fixture.cwd,
      stdout: "",
      stderr: "",
      finalText: "done",
      status: 0,
      signal: null,
      durationMs: 1000,
      workspace,
      trace: { pass: true, score: 100, effectiveAnswerSource: "provided-final", effectiveAnswerChars: 4, metrics: {}, critical: [], warnings: [], suggestions: [] },
      diagnostics: {
        jsonEvents: 0,
        toolEvents: 0,
        toolCallsByName: {},
        chalinRouteCalls: 0,
        chalinRouteNonExecutable: 0,
        chalinRouteValidationErrors: 0,
        toolValidationErrors: 0,
        duplicateToolCalls: 0,
        readCalls: 0,
        writeCalls: 0,
        editCalls: 0,
        retries: 0,
        agentRetries: 0,
        infraRetries: 0,
        usage,
        tokenTotal: 0,
        verificationPassed: true,
        verificationToolCalls: 1,
        finalAnswerMissing: false,
      },
      judge: { pass: true, score: 92, verdict: "evidence passes", critical: [], warnings: [] },
    } as unknown as Parameters<typeof summarizeComparison>[0][number];

    const [summary] = summarizeComparison([output]);
    assert.equal(summary?.pass, true);
    assert.equal(summary?.variants.chalin?.passRate, 1);
    assert.ok((summary?.variants.chalin?.avgWorkspaceScore ?? 0) >= 90);
  } finally {
    fs.rmSync(fixture.cwd, { recursive: true, force: true });
  }
});

test("workflow comparison does not let judge override missing required artifacts", () => {
  const fixture = createWorkflowFixture("scaffold-cli-tool");
  try {
    fs.writeFileSync(path.join(fixture.cwd, "package.json"), JSON.stringify({
      scripts: { test: "node --test test/*.test.js" },
      bin: { "note-pack": "src/cli.ts" },
      type: "commonjs",
    }, null, 2));
    fs.mkdirSync(path.join(fixture.cwd, "src"), { recursive: true });
    fs.writeFileSync(path.join(fixture.cwd, "src/cli.ts"), "export function normalizeNoteText(text: string) { return text.toLowerCase(); }\n");
    fs.mkdirSync(path.join(fixture.cwd, "test"), { recursive: true });
    fs.writeFileSync(path.join(fixture.cwd, "test/cli.test.js"), "const test = require('node:test');\nconst assert = require('node:assert/strict');\ntest('normalizes', () => assert.equal('A'.toLowerCase(), 'a'));\n");
    const workspace = scoreWorkflowWorkspace(fixture.cwd, fixture.case, {
      finalText: "Changed package.json, src/cli.ts, README.md, test/cli.test.js. Verification: npm test passed.",
      validateTests: true,
      durationMs: 1000,
    });
    assert.equal(workspace.pass, false);
    assert.ok(workspace.critical.some((issue) => issue.id === "missing-required-file" || issue.id === "validation-failed"));

    const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
    const output = {
      variant: "chalin",
      runIndex: 1,
      cwd: fixture.cwd,
      stdout: "",
      stderr: "",
      finalText: "done",
      status: 0,
      signal: null,
      durationMs: 1000,
      workspace,
      trace: { pass: true, score: 100, effectiveAnswerSource: "provided-final", effectiveAnswerChars: 4, metrics: {}, critical: [], warnings: [], suggestions: [] },
      diagnostics: {
        jsonEvents: 0,
        toolEvents: 0,
        toolCallsByName: {},
        chalinRouteCalls: 0,
        chalinRouteNonExecutable: 0,
        chalinRouteValidationErrors: 0,
        toolValidationErrors: 0,
        duplicateToolCalls: 0,
        readCalls: 0,
        writeCalls: 0,
        editCalls: 0,
        retries: 0,
        agentRetries: 0,
        infraRetries: 0,
        usage,
        tokenTotal: 0,
        verificationPassed: true,
        verificationToolCalls: 1,
        finalAnswerMissing: false,
      },
      judge: { pass: true, score: 95, verdict: "alternative evidence passes", critical: [], warnings: [] },
    } as unknown as Parameters<typeof summarizeComparison>[0][number];

    const [summary] = summarizeComparison([output]);
    assert.equal(summary?.pass, false);
    assert.equal(summary?.variants.chalin?.passRate, 0);
  } finally {
    fs.rmSync(fixture.cwd, { recursive: true, force: true });
  }
});

test("workflow hidden validation catches narrowed tokenizer comment contracts", () => {
  const fixture = createWorkflowFixture("complex-sqlite-c-tokenizer-bugfix");
  try {
    fs.writeFileSync(path.join(fixture.cwd, "src/sql_tokenizer.c"), `#include "sql_tokenizer.h"
#include <ctype.h>

int count_sql_tokens(const char *sql) {
    int tokens = 0;
    const char *p = sql;

    while (*p) {
        if (isspace((unsigned char)*p)) {
            ++p;
            continue;
        }

        if (*p == '-' && p[1] == '-' && (p[2] == '\\0' || isspace((unsigned char)p[2]))) {
            while (*p && *p != '\\n') ++p;
            continue;
        }

        ++tokens;
        while (*p && !isspace((unsigned char)*p) && !(*p == '-' && p[1] == '-' && (p[2] == '\\0' || isspace((unsigned char)p[2])))) ++p;
    }

    return tokens;
}
`);

    const report = scoreWorkflowWorkspace(fixture.cwd, fixture.case, {
      finalText: "Changed src/sql_tokenizer.c and tests/test_sql_tokenizer.c. Verification: make test passed.",
      validateTests: true,
      durationMs: 1000,
    });

    assert.equal(report.pass, false);
    assert.equal(report.metrics.validation.status, "fail");
    assert.match(report.metrics.validation.hiddenValidation ?? "", /Hidden SQL tokenizer behavior tests/);
  } finally {
    fs.rmSync(fixture.cwd, { recursive: true, force: true });
  }
});

test("workflow hidden validation does not overwrite agent-visible evidence", () => {
  const fixture = createWorkflowFixture("complex-sqlite-c-tokenizer-bugfix");
  try {
    fs.writeFileSync(path.join(fixture.cwd, "src/sql_tokenizer.c"), `#include "sql_tokenizer.h"
#include <ctype.h>

int count_sql_tokens(const char *sql) {
    int tokens = 0;

    for (const char *p = sql; *p; ) {
        if (isspace((unsigned char)*p)) {
            ++p;
            continue;
        }
        if (p[0] == '-' && p[1] == '-') {
            p += 2;
            while (*p && *p != '\\n') ++p;
            continue;
        }
        ++tokens;
        if (*p == '\\'') {
            ++p;
            while (*p) {
                if (*p == '\\'') {
                    if (p[1] == '\\'') {
                        p += 2;
                        continue;
                    }
                    ++p;
                    break;
                }
                ++p;
            }
            continue;
        }
        while (*p && !isspace((unsigned char)*p) && !(p[0] == '-' && p[1] == '-')) ++p;
    }

    return tokens;
}
`);
    const visibleTests = `#include "sql_tokenizer.h"
#include <assert.h>

int main(void) {
    assert(count_sql_tokens("select 'visible test' from t") == 4);
    assert(count_sql_tokens("select a--visible comment\\nfrom t") == 4);
    return 0;
}
`;
    const testPath = path.join(fixture.cwd, "tests/test_sql_tokenizer.c");
    fs.writeFileSync(testPath, visibleTests);

    const report = scoreWorkflowWorkspace(fixture.cwd, fixture.case, {
      finalText: "Changed src/sql_tokenizer.c and tests/test_sql_tokenizer.c. Verification: make test passed.",
      validateTests: true,
      durationMs: 1000,
    });

    assert.equal(report.metrics.validation.hiddenValidation, "Hidden SQL tokenizer behavior tests cover unrestricted line comments, EOF comments, escaped quotes, quoted comment markers, and quote-delimited tokens adjacent to normal token characters.");
    assert.equal(fs.readFileSync(testPath, "utf8"), visibleTests);
    assert.doesNotMatch(fs.readFileSync(testPath, "utf8"), /comment at eof|it''s -- not comment/);
  } finally {
    fs.rmSync(fixture.cwd, { recursive: true, force: true });
  }
});

test("workflow forbidden call scoring does not match helper identifier substrings", () => {
  const fixture = createWorkflowFixture("complex-redis-c-expire-feature");
  try {
    fs.writeFileSync(path.join(fixture.cwd, "src/expire_table.c"), `#include "expire_table.h"
#include <string.h>

static long long exp_time(long long now_ms, long long ttl_ms) {
    return now_ms + ttl_ms;
}

void expire_set(const char *key, const char *value, long long ttl_ms, long long now_ms) {
    (void)key; (void)value; (void)ttl_ms; (void)now_ms;
    long long expires = exp_time(now_ms, ttl_ms);
    (void)expires;
}

const char *expire_get(const char *key, long long now_ms) {
    (void)key; (void)now_ms;
    return 0;
}

void expire_sweep(long long now_ms) { (void)now_ms; }
void expire_clear(void) {}
`);

    const report = scoreWorkflowWorkspace(fixture.cwd, fixture.case, {
      finalText: "Changed src/expire_table.c and tests/test_expire_table.c. Verification: make test.",
    });

    assert.equal(report.critical.some((issue) => issue.id === "forbidden-content"), false);
  } finally {
    fs.rmSync(fixture.cwd, { recursive: true, force: true });
  }
});

test("workflow forbidden call scoring flags actual wall-clock calls", () => {
  const fixture = createWorkflowFixture("complex-redis-c-expire-feature");
  try {
    fs.writeFileSync(path.join(fixture.cwd, "src/expire_table.c"), `#include "expire_table.h"
#include <time.h>

void expire_set(const char *key, const char *value, long long ttl_ms, long long now_ms) {
    (void)key; (void)value; (void)ttl_ms; (void)now_ms;
    long long expires = (long long)time(NULL);
    (void)expires;
}

const char *expire_get(const char *key, long long now_ms) {
    (void)key; (void)now_ms;
    return 0;
}

void expire_sweep(long long now_ms) { (void)now_ms; }
void expire_clear(void) {}
`);

    const report = scoreWorkflowWorkspace(fixture.cwd, fixture.case, {
      finalText: "Changed src/expire_table.c and tests/test_expire_table.c. Verification: make test.",
    });

    const forbidden = report.critical.find((issue) => issue.id === "forbidden-content");
    assert.ok(forbidden);
    assert.match(forbidden.evidence ?? "", /time\\\(/);
  } finally {
    fs.rmSync(fixture.cwd, { recursive: true, force: true });
  }
});

test("workflow Redis expire scoring rejects arbitrary fixed table caps", () => {
  const fixture = createWorkflowFixture("complex-redis-c-expire-feature");
  try {
    fs.writeFileSync(path.join(fixture.cwd, "src/expire_table.c"), `#include "expire_table.h"
#include <string.h>

#define MAX_EXPIRE_ENTRIES 128

typedef struct {
    char key[64];
    char value[64];
    long long expires_at_ms;
    int used;
} expire_entry_t;

static expire_entry_t entries[MAX_EXPIRE_ENTRIES];

void expire_set(const char *key, const char *value, long long ttl_ms, long long now_ms) {
    (void)key; (void)value; (void)ttl_ms; (void)now_ms; (void)entries;
}

const char *expire_get(const char *key, long long now_ms) {
    (void)key; (void)now_ms;
    return 0;
}

void expire_sweep(long long now_ms) { (void)now_ms; }
void expire_clear(void) {}
`);

    const report = scoreWorkflowWorkspace(fixture.cwd, fixture.case, {
      finalText: "Changed src/expire_table.c and tests/test_expire_table.c. Verification: make test.",
    });

    const forbidden = report.critical.find((issue) => issue.id === "forbidden-content" && /fixed-size table cap/.test(issue.message + issue.evidence));
    assert.ok(forbidden);
  } finally {
    fs.rmSync(fixture.cwd, { recursive: true, force: true });
  }
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
      stats: { chalin: { runs: 1, passCount: 0, passRate: 0, avgWorkspaceScore: 60, p95DurationMs: 40_000, totalTokens: 10, estimatedCostUsd: 0.1, infrastructureFailures: 1 } },
    },
    {
      caseId: "case-a",
      pass: true,
      stats: { chalin: { runs: 3, passCount: 3, passRate: 1, avgWorkspaceScore: 100, p95DurationMs: 20_000, totalTokens: 90, estimatedCostUsd: 0.9, infrastructureFailures: 0 } },
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
  assert.equal(aggregate.variants.chalin?.runs, 3);
  assert.equal(aggregate.variants.chalin?.passRate, 1);
  assert.equal(aggregate.variants.chalin?.p95DurationMs, 20_000);
  assert.equal(aggregate.variants.simple?.passRate, 0.667);
  assert.deepEqual(aggregate.warnings, ["case-a: recovered infra"]);
});

test("workflow matrix aggregate does not spread shard-level gate failure across passing case rows", async () => {
  const { summarizeWorkflowMatrixRows } = await import("../evals/workflow-matrix.ts");
  const aggregate = summarizeWorkflowMatrixRows([
    {
      caseId: "case-a",
      pass: true,
      stats: { chalin: { runs: 3, passCount: 3, passRate: 1, avgWorkspaceScore: 100, p95DurationMs: 10_000, totalTokens: 10, estimatedCostUsd: 0.1 } },
      regressionGates: { pass: false, failures: ["case-b failed in same shard"] },
    },
    {
      caseId: "case-b",
      pass: false,
      stats: { chalin: { runs: 3, passCount: 2, passRate: 0.667, avgWorkspaceScore: 80, p95DurationMs: 20_000, totalTokens: 20, estimatedCostUsd: 0.2 } },
      regressionGates: { pass: false, failures: ["case-b failed"] },
    },
  ]);

  assert.equal(aggregate.pass, false);
  assert.deepEqual(aggregate.failedCases, ["case-b"]);
});
