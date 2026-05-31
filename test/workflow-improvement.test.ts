import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "bun:test";
import { filterWorkflowImprovementReports, parseWorkflowImprovementArgs, resolveWorkflowImprovementReportPaths, resolveWorkflowImprovementReportSelection, selectLatestWorkflowImprovementReportSelectionByCase, selectLatestWorkflowImprovementReportsByCase, workflowImprovementReportFilters } from "../evals/workflow-improvement.eval.ts";
import { summarizeWorkflowImprovementReports, summarizeWorkflowImprovementSignals } from "../evals/workflow-improvement.ts";

function output(variant: "simple" | "chalin" | "gentle", overrides: object = {}) {
  return {
    variant,
    runIndex: 1,
    durationMs: variant === "chalin" ? 16_000 : 9_000,
    finalTextSnippet: variant === "chalin" ? "Implemented and verified Chalin output." : "Implemented and verified baseline output.",
    workspace: { caseId: "holdout-go-ttl-cache", pass: true, score: 100 },
    trace: { pass: true, score: 100 },
    judge: { pass: true, score: 100 },
    evidence: {
      files: [
        { path: variant === "chalin" ? "src/cache.ts" : "src/cache.js", contentSnippet: "export function cache() {}" },
        { path: "test/cache.test.ts", contentSnippet: "it('covers cache behavior')" },
      ],
    },
    diagnostics: {
      tokenTotal: variant === "chalin" ? 38_000 : 20_000,
      toolEvents: variant === "chalin" ? 14 : 8,
      traceSummary: {
        firstMutationEventIndex: variant === "chalin" ? 4 : 2,
        postVerificationExplorationCalls: 0,
        postVerificationShellCalls: 0,
        toolCallSequence: variant === "chalin"
          ? ["ls", "read", "grep", "read", "edit", "edit", "bash"]
          : ["read", "read", "write", "bash"],
      },
    },
    ...overrides,
  };
}

test("workflow improvement signals classify quality-equivalent blind loss as efficiency gap", () => {
  const summary = summarizeWorkflowImprovementSignals({
    outputs: [output("simple"), output("chalin"), output("gentle", { durationMs: 20_000 })],
    comparativeJudges: [{
      caseId: "holdout-go-ttl-cache",
      runIndex: 1,
      winnerVariant: "simple",
      targetWins: false,
      targetRank: 2,
    }],
  });

  assert.equal(summary.comparisons, 1);
  assert.equal(summary.targetLosses, 1);
  assert.equal(summary.efficiencyGaps, 1);
  assert.equal(summary.qualityGaps, 0);
  assert.equal(summary.signals[0]?.classification, "efficiency-gap");
  assert.equal(summary.signals[0]?.tokenDelta, 18_000);
  assert.equal(summary.signals[0]?.durationDeltaMs, 7_000);
  assert.equal(summary.signals[0]?.target.finalTextChars, "Implemented and verified Chalin output.".length);
  assert.equal(summary.signals[0]?.target.evidenceFileCount, 2);
  assert.deepEqual(summary.signals[0]?.target.evidencePaths, ["src/cache.ts", "test/cache.test.ts"]);
  assert.ok(summary.abstractRules.some((rule) => /token premium/.test(rule)));
  assert.ok(summary.abstractRules.some((rule) => /Named-file prompts/.test(rule)));
  assert.equal(summary.caseSummaries[0]?.caseId, "holdout-go-ttl-cache");
  assert.equal(summary.caseSummaries[0]?.targetLosses, 1);
  assert.equal(summary.caseSummaries[0]?.efficiencyGaps, 1);
  assert.deepEqual(summary.caseSummaries[0]?.winnerVariants, { simple: 1 });
  assert.deepEqual(summary.caseSummaries[0]?.lossWinnerVariants, { simple: 1 });
  assert.equal(summary.caseSummaries[0]?.maxTokenPremium, 18_000);
  assert.equal(summary.caseSummaries[0]?.maxDurationPremiumMs, 7_000);
  assert.equal(summary.caseSummaries[0]?.maxToolPremium, 6);
  assert.equal(summary.patternCounts["quality-equivalent-cost-premium"], 1);
  assert.equal(summary.caseSummaries[0]?.patternCounts["quality-equivalent-cost-premium"], 1);
});

test("workflow improvement signals extract abstract blind-loss patterns from judge evidence", () => {
  const summary = summarizeWorkflowImprovementSignals({
    outputs: [
      output("simple", {
        workspace: { caseId: "generic-library-scaffold", pass: true, score: 100 },
        evidence: {
          files: [
            { path: "package.json", contentSnippet: '{ "main": "dist/index.js", "types": "dist/index.d.ts", "files": ["dist"] }' },
            { path: "src/index.ts", contentSnippet: "export class InputError extends Error {}" },
            { path: "test/index.test.ts", contentSnippet: "it('covers invalid non-string inputs')" },
          ],
        },
      }),
      output("chalin", {
        workspace: { caseId: "generic-library-scaffold", pass: true, score: 90 },
        evidence: {
          files: [
            { path: "package.json", contentSnippet: '{ "main": "src/index.ts", "types": "src/index.ts" }' },
            { path: "src/index.ts", contentSnippet: "throw new Error('invalid input')" },
            { path: "src/normalize.ts", contentSnippet: "export function normalize() {}" },
            { path: "test/index.test.ts", contentSnippet: "it('covers one edge case')" },
            { path: "README.md", contentSnippet: "API docs" },
          ],
        },
      }),
    ],
    comparativeJudges: [{
      caseId: "generic-library-scaffold",
      runIndex: 1,
      winnerVariant: "simple",
      targetWins: false,
      targetRank: 2,
      verdict: "The winner has better coverage of edge cases and non-string inputs. The target adds an extra file with scope creep and package.json points main/types at src instead of dist; a custom error class gives the public API a clearer validation contract.",
    }],
  });

  const signal = summary.signals[0];
  assert.equal(signal?.classification, "quality-gap");
  assert.deepEqual(signal?.patterns.sort(), [
    "branch-coverage-sample-gap",
    "publishable-library-contract-gap",
    "quality-equivalent-cost-premium",
    "scaffold-surface-contract-gap",
    "unjustified-artifact-split",
  ].sort());
  assert.ok(signal?.recommendations.some((item) => /cover each branch\/value class/.test(item)));
  assert.ok(signal?.recommendations.some((item) => /public entrypoint/.test(item)));
  assert.ok(signal?.recommendations.some((item) => /built surface/.test(item)));
  assert.ok(signal?.recommendations.some((item) => /Extra source artifacts/.test(item)));
});

test("workflow improvement signals detect normalization/type contract and low-value overcoverage gaps", () => {
  const librarySummary = summarizeWorkflowImprovementSignals({
    outputs: [
      output("simple", {
        workspace: { caseId: "generic-token-library", pass: true, score: 100 },
        evidence: { files: [{ path: "package.json", contentSnippet: '{ "main": "dist/index.js", "types": "dist/index.d.ts", "files": ["dist"] }' }] },
      }),
      output("chalin", {
        workspace: { caseId: "generic-token-library", pass: true, score: 100 },
        evidence: { files: [{ path: "package.json", contentSnippet: '{ "main": "src/index.ts", "types": "src/index.ts" }' }, { path: "src/index.ts", contentSnippet: "export function createValue(prefix: string, id: string) { return `${prefix}-${id}`.toLowerCase(); }" }] },
      }),
    ],
    comparativeJudges: [{
      caseId: "generic-token-library",
      runIndex: 1,
      winnerVariant: "simple",
      targetWins: false,
      verdict: "The winner trims inputs before concatenating and returns normalized output. The target validates trim for blanks but returns untrimmed values. The winner uses unknown parameters for runtime validation, while target's public signature is string despite non-string checks. package.json main/types point to dist/files.",
    }],
  });
  const libraryPatterns = librarySummary.signals[0]?.patterns ?? [];
  assert.equal(libraryPatterns.includes("normalization-output-contract-gap"), true);
  assert.equal(libraryPatterns.includes("runtime-validation-type-contract-gap"), true);
  assert.equal(libraryPatterns.includes("publishable-library-contract-gap"), true);
  assert.ok(librarySummary.signals[0]?.recommendations.some((item) => /normalized locals/.test(item)));
  assert.ok(librarySummary.signals[0]?.recommendations.some((item) => /public parameter type/.test(item)));

  const clampSummary = summarizeWorkflowImprovementSignals({
    outputs: [
      output("simple", { workspace: { caseId: "generic-clamp", pass: true, score: 100 }, diagnostics: { tokenTotal: 12_000 } }),
      output("chalin", { workspace: { caseId: "generic-clamp", pass: true, score: 100 }, diagnostics: { tokenTotal: 24_000 } }),
    ],
    comparativeJudges: [{
      caseId: "generic-clamp",
      runIndex: 1,
      winnerVariant: "simple",
      targetWins: false,
      verdict: "Quality is equivalent; target adds marginal extra coverage for a trivial transform, but it does not move practical quality and costs more tokens.",
    }],
  });
  assert.equal(clampSummary.signals[0]?.patterns.includes("low-value-overcoverage-cost-gap"), true);
  assert.ok(clampSummary.signals[0]?.recommendations.some((item) => /redundant edge tests/.test(item)));

  const statefulSummary = summarizeWorkflowImprovementSignals({
    outputs: [
      output("simple", { diagnostics: { tokenTotal: 12_000 }, workspace: { caseId: "generic-ttl", pass: true, score: 100 } }),
      output("chalin", { diagnostics: { tokenTotal: 20_000 }, workspace: { caseId: "generic-ttl", pass: true, score: 100 } }),
    ],
    comparativeJudges: [{
      caseId: "generic-ttl",
      runIndex: 1,
      winnerVariant: "simple",
      targetWins: false,
      verdict: "The winner has an overwrite test that verifies reset of the TTL deadline/window; target has no explicit coverage for renewed expiry after update.",
    }],
  });
  assert.equal(statefulSummary.signals[0]?.patterns.includes("stateful-update-coverage-gap"), true);
  assert.ok(statefulSummary.signals[0]?.recommendations.some((item) => /renewed deadline\/window/.test(item)));

  const stableSortSummary = summarizeWorkflowImprovementSignals({
    outputs: [
      output("simple", {
        workspace: { caseId: "generic-sort", pass: true, score: 100 },
        evidence: { files: [{ path: "test/sort.test.ts", contentSnippet: "sortTasks high medium low dueDate stable original" }] },
      }),
      output("chalin", {
        workspace: { caseId: "generic-sort", pass: true, score: 100 },
        evidence: { files: [{ path: "test/sort.test.ts", contentSnippet: "sortTasks high medium low dueDate stable original" }] },
      }),
    ],
    comparativeJudges: [{
      caseId: "generic-sort",
      runIndex: 1,
      winnerVariant: "simple",
      targetWins: false,
      verdict: "The winner adds meaningful stable sort coverage: a single element edge and ISO datetime strings with a time component for lexicographic dueDate secondary ordering.",
    }],
  });
  assert.equal(stableSortSummary.signals[0]?.patterns.includes("stable-sort-edge-coverage-gap"), true);
  assert.ok(stableSortSummary.signals[0]?.recommendations.some((item) => /ISO datetime-string ordering/.test(item)));

  const objectFilterSummary = summarizeWorkflowImprovementSignals({
    outputs: [
      output("simple", {
        workspace: { caseId: "generic-filter", pass: true, score: 100 },
        evidence: { files: [{ path: "test/filter.test.ts", contentSnippet: "assert.deepEqual(result, [{ id: '1', title: 'Pay rent' }]);" }] },
      }),
      output("chalin", {
        workspace: { caseId: "generic-filter", pass: true, score: 100 },
        evidence: { files: [{ path: "test/filter.test.ts", contentSnippet: "assert.deepEqual(result.map(t => t.id), ['1']);" }] },
      }),
    ],
    comparativeJudges: [{
      caseId: "generic-filter",
      runIndex: 1,
      winnerVariant: "simple",
      targetWins: false,
      verdict: "The winner uses deepEqual to verify full object structure for returned filter results, not only mapped IDs, so the return contract is better covered.",
    }],
  });
  assert.equal(objectFilterSummary.signals[0]?.patterns.includes("object-filter-return-shape-assertion-gap"), true);
  assert.ok(objectFilterSummary.signals[0]?.recommendations.some((item) => /full-shape deepEqual assertions/.test(item)));

  const objectFilterBoundarySummary = summarizeWorkflowImprovementSignals({
    outputs: [
      output("simple", {
        workspace: { caseId: "generic-filter", pass: true, score: 100 },
        evidence: { files: [{ path: "test/filter.test.ts", contentSnippet: "assert.deepEqual(tasks, originalTasks); assert.deepEqual(search([{ description: '' }], 'rent'), []);" }] },
      }),
      output("chalin", {
        workspace: { caseId: "generic-filter", pass: true, score: 100 },
        evidence: { files: [{ path: "test/filter.test.ts", contentSnippet: "assert.deepEqual(search(tasks, 'rent'), [{ id: '1', title: 'Pay rent' }]);" }] },
      }),
    ],
    comparativeJudges: [{
      caseId: "generic-filter",
      runIndex: 1,
      winnerVariant: "simple",
      targetWins: false,
      verdict: "Both are correct, but the winner adds no-mutation coverage for the original array and proves description: \"\" empty string does not cause false positives in the search filter.",
    }],
  });
  assert.equal(objectFilterBoundarySummary.signals[0]?.patterns.includes("object-filter-boundary-mutation-gap"), true);
  assert.ok(objectFilterBoundarySummary.signals[0]?.recommendations.some((item) => /empty-string forms/.test(item)));
  assert.ok(objectFilterBoundarySummary.signals[0]?.recommendations.some((item) => /original input array is not mutated/.test(item)));
});

test("workflow improvement signals detect runner drift and focused overcoverage", () => {
  const runnerSummary = summarizeWorkflowImprovementSignals({
    outputs: [
      output("simple", {
        workspace: { caseId: "generic-greenfield-library", pass: true, score: 100 },
        diagnostics: { tokenTotal: 32_000, toolEvents: 18 },
      }),
      output("chalin", {
        workspace: { caseId: "generic-greenfield-library", pass: true, score: 84 },
        diagnostics: {
          tokenTotal: 122_000,
          toolEvents: 38,
          traceSummary: { firstMutationEventIndex: 0, postVerificationExplorationCalls: 0, postVerificationShellCalls: 0, toolCallSequence: ["write", "write", "write", "bash", "bash", "edit", "bash"] },
        },
        toolHistory: {
          events: [
            { name: "bash", phase: "start", argsSnippet: "npm install uvu ts-node" },
            { name: "bash", phase: "end", resultSnippet: "Total: 0 Passed: 0" },
            { name: "bash", phase: "start", argsSnippet: "node -r ts-node/register node_modules/uvu/bin/uvu" },
            { name: "bash", phase: "end", resultSnippet: "MODULE_NOT_FOUND node_modules/uvu/bin/uvu" },
          ],
        },
      }),
    ],
    comparativeJudges: [{
      caseId: "generic-greenfield-library",
      runIndex: 1,
      winnerVariant: "simple",
      targetWins: false,
      verdict: "Target has runner/loader churn, zero tests from the first command, module_not_found from node_modules, 38 tool calls, and far more tokens.",
    }],
  });
  assert.equal(runnerSummary.signals[0]?.patterns.includes("greenfield-runner-chain-drift"), true);
  assert.ok(runnerSummary.signals[0]?.recommendations.some((item) => /choose one reproducible runner/.test(item)));
  const testSurfaceSummary = summarizeWorkflowImprovementSignals({
    outputs: [
      output("simple", { workspace: { caseId: "generic-scaffold-tests", pass: true, score: 100 } }),
      output("chalin", { workspace: { caseId: "generic-scaffold-tests", pass: false, score: 14 } }),
    ],
    comparativeJudges: [{
      caseId: "generic-scaffold-tests",
      runIndex: 1,
      winnerVariant: "simple",
      targetWins: false,
      verdict: "Target placed the test file in src/index.test.ts instead of required test/*.test.ts, so runner-discoverable package tests are missing from the expected root test surface.",
    }],
  });
  assert.equal(testSurfaceSummary.signals[0]?.patterns.includes("scaffold-test-surface-path-gap"), true);
  assert.ok(testSurfaceSummary.signals[0]?.recommendations.some((item) => /root test\/ or tests\//.test(item)));

  const runnerDiscoverSummary = summarizeWorkflowImprovementSignals({
    outputs: [
      output("simple", { workspace: { caseId: "generic-python-unittest", pass: true, score: 100 } }),
      output("chalin", { workspace: { caseId: "generic-python-unittest", pass: false, score: 55 } }),
    ],
    comparativeJudges: [{
      caseId: "generic-python-unittest",
      runIndex: 1,
      winnerVariant: "simple",
      targetWins: false,
      verdict: "Target wrote 9 useful root tests, but unittest discover -s tests only ran 1 test, so the substantive coverage was not discovered by the runner.",
    }],
  });
  assert.equal(runnerDiscoverSummary.signals[0]?.patterns.includes("runner-discovered-test-gap"), true);
  assert.ok(runnerDiscoverSummary.signals[0]?.recommendations.some((item) => /python -m unittest discover -s tests/.test(item)));

  const normalizationOrderSummary = summarizeWorkflowImprovementSignals({
    outputs: [
      output("simple", { workspace: { caseId: "generic-normalized-validation", pass: true, score: 100 } }),
      output("chalin", { workspace: { caseId: "generic-normalized-validation", pass: true, score: 90 } }),
    ],
    comparativeJudges: [{
      caseId: "generic-normalized-validation",
      runIndex: 1,
      winnerVariant: "simple",
      targetWins: false,
      verdict: "Target validates the email with regex before trim/lowercase normalization, rejecting a whitespace-wrapped valid input that should be normalized first.",
    }],
  });
  assert.equal(normalizationOrderSummary.signals[0]?.patterns.includes("normalization-validation-order-gap"), true);
  assert.ok(normalizationOrderSummary.signals[0]?.recommendations.some((item) => /normalize into locals before regex/.test(item)));

  const focusedSummary = summarizeWorkflowImprovementSignals({
    outputs: [
      output("simple", { workspace: { caseId: "generic-focused-test", pass: true, score: 99 }, diagnostics: { tokenTotal: 12_000 } }),
      output("chalin", { workspace: { caseId: "generic-focused-test", pass: true, score: 99 }, diagnostics: { tokenTotal: 22_000 } }),
    ],
    comparativeJudges: [{
      caseId: "generic-focused-test",
      runIndex: 1,
      winnerVariant: "simple",
      targetWins: false,
      verdict: "The user asked for one unit test and not to do more. Target adds extra assertions, sign preservation, and duplicate samples beyond the requested edge.",
    }],
  });
  assert.equal(focusedSummary.signals[0]?.patterns.includes("focused-test-scope-creep"), true);
  assert.ok(focusedSummary.signals[0]?.recommendations.some((item) => /one focused test change/.test(item)));

  const boundsSummary = summarizeWorkflowImprovementSignals({
    outputs: [
      output("simple", { workspace: { caseId: "generic-bounds", pass: true, score: 100 }, diagnostics: { tokenTotal: 16_000 } }),
      output("chalin", { workspace: { caseId: "generic-bounds", pass: true, score: 100 }, diagnostics: { tokenTotal: 29_000 } }),
    ],
    comparativeJudges: [{
      caseId: "generic-bounds",
      runIndex: 1,
      winnerVariant: "simple",
      targetWins: false,
      verdict: "Quality is equivalent for this trivial one-line clamp. Target has 7 tests with exact min/max, negative range, and min>max, all marginal extra tests.",
    }],
  });
  assert.equal(boundsSummary.signals[0]?.patterns.includes("trivial-bounds-overcoverage"), true);
  assert.ok(boundsSummary.signals[0]?.recommendations.some((item) => /exact min\/exact max/.test(item)));
});

test("workflow improvement signals monitor pre-mutation and second-pass verification cost", () => {
  const summary = summarizeWorkflowImprovementSignals({
    outputs: [
      output("simple", {
        diagnostics: {
          tokenTotal: 12_000,
          toolEvents: 8,
          traceSummary: { firstMutationEventIndex: 3, postVerificationExplorationCalls: 0, postVerificationShellCalls: 0, toolCallSequence: ["read", "read", "edit", "bash"] },
        },
      }),
      output("chalin", {
        diagnostics: {
          tokenTotal: 28_000,
          toolEvents: 18,
          traceSummary: { firstMutationEventIndex: 5, postVerificationExplorationCalls: 0, postVerificationShellCalls: 0, toolCallSequence: ["read", "bash", "read", "bash", "edit", "edit", "bash", "read", "edit", "bash"] },
        },
      }),
    ],
    comparativeJudges: [{ caseId: "holdout-go-ttl-cache", runIndex: 1, winnerVariant: "simple", targetWins: false }],
  });

  const signal = summary.signals[0];
  assert.equal(signal?.classification, "efficiency-gap");
  assert.equal(signal?.patterns.includes("pre-mutation-verification-loop"), true);
  assert.equal(signal?.patterns.includes("second-pass-verification-cost"), true);
  assert.equal(signal?.patterns.includes("quality-equivalent-cost-premium"), true);
  assert.ok(signal?.recommendations.some((item) => /do not run baseline verification/.test(item)));
  assert.ok(signal?.recommendations.some((item) => /patch one concrete root cause/.test(item)));
});

test("workflow improvement signals extract Gentle-style architecture, handoff, and API simplicity lessons", () => {
  const architectureSummary = summarizeWorkflowImprovementSignals({
    outputs: [
      output("gentle", {
        workspace: { caseId: "generic-architecture-docs", pass: true, score: 94 },
        evidence: { files: [{ path: "docs/architecture.md", contentSnippet: "## Decision matrix\n## Dependency delta\n## Stage 0 golden tests" }] },
      }),
      output("chalin", {
        workspace: { caseId: "generic-architecture-docs", pass: true, score: 86 },
        evidence: { files: [{ path: "docs/architecture.md", contentSnippet: "## Migration plan\nGeneric phases." }] },
      }),
    ],
    comparativeJudges: [{
      caseId: "generic-architecture-docs",
      runIndex: 1,
      winnerVariant: "gentle",
      targetWins: false,
      verdict: "The winner has stronger architecture output: a decision matrix, ownership/coupling table, dependency delta, stage 0 golden-test capture, and reverse-dependency checks. Target is correct but less actionable as an architecture plan.",
    }],
  });
  assert.equal(architectureSummary.signals[0]?.patterns.includes("architecture-plan-actionability-gap"), true);
  assert.ok(architectureSummary.signals[0]?.recommendations.some((item) => /design options with a recommendation/.test(item)));

  const handoffSummary = summarizeWorkflowImprovementSignals({
    outputs: [
      output("gentle", {
        workspace: { caseId: "generic-context-handoff", pass: true, score: 93 },
        evidence: { files: [{ path: "src/service.ts", contentSnippet: "caller evidence" }, { path: "test/service.test.ts", contentSnippet: "validation path" }] },
      }),
      output("chalin", {
        workspace: { caseId: "generic-context-handoff", pass: true, score: 84 },
        evidence: { files: [{ path: "src/service.ts", contentSnippet: "single source read" }] },
      }),
    ],
    comparativeJudges: [{
      caseId: "generic-context-handoff",
      runIndex: 1,
      winnerVariant: "gentle",
      targetWins: false,
      verdict: "Target handoff omits a relevant file and leaves insufficient evidence: it does not follow callers, tests, config, docs, or adjacent patterns, so the next agent would rediscover the validation path.",
    }],
  });
  assert.equal(handoffSummary.signals[0]?.patterns.includes("context-handoff-coverage-gap"), true);
  assert.ok(handoffSummary.signals[0]?.recommendations.some((item) => /do not omit a domain-critical file/.test(item)));

  const apiSummary = summarizeWorkflowImprovementSignals({
    outputs: [
      output("gentle", {
        workspace: { caseId: "generic-mini-config-loader", pass: true, score: 92 },
        evidence: { files: [{ path: "src/index.ts", contentSnippet: "export function loadConfig(env: EnvMap)" }] },
      }),
      output("chalin", {
        workspace: { caseId: "generic-mini-config-loader", pass: true, score: 88 },
        evidence: { files: [{ path: "src/index.ts", contentSnippet: "export function loadConfig(env: string | EnvMap, options?: Options)" }] },
      }),
    ],
    comparativeJudges: [{
      caseId: "generic-mini-config-loader",
      runIndex: 1,
      winnerVariant: "gentle",
      targetWins: false,
      verdict: "The winner uses a simpler conventional public API for a mini library: env-map as the primary parameter. Target's overload flexibility and second primary API add complexity that the prompt did not ask for.",
    }],
  });
  assert.equal(apiSummary.signals[0]?.patterns.includes("api-simplicity-contract-gap"), true);
  assert.ok(apiSummary.signals[0]?.recommendations.some((item) => /prompt-named API simple and conventional first/.test(item)));
});

test("workflow improvement signals flag broad discovery tax on exact package-local work", () => {
  const summary = summarizeWorkflowImprovementSignals({
    outputs: [
      output("simple", {
        workspace: { caseId: "generic-package-local-helper", pass: true, score: 100 },
        diagnostics: {
          tokenTotal: 12_000,
          toolEvents: 8,
          traceSummary: { firstMutationEventIndex: 3, postVerificationExplorationCalls: 0, postVerificationShellCalls: 0, toolCallSequence: ["read", "read", "read", "edit", "edit", "bash"] },
        },
      }),
      output("chalin", {
        workspace: { caseId: "generic-package-local-helper", pass: true, score: 100 },
        diagnostics: {
          tokenTotal: 24_000,
          toolEvents: 14,
          traceSummary: { firstMutationEventIndex: 4, postVerificationExplorationCalls: 0, postVerificationShellCalls: 0, toolCallSequence: ["chalin_project_discovery", "read", "read", "read", "edit", "edit", "bash"] },
        },
      }),
    ],
    comparativeJudges: [{
      caseId: "generic-package-local-helper",
      runIndex: 1,
      winnerVariant: "simple",
      targetWins: false,
      verdict: "Quality is equivalent; target spends more tokens for the same package-local source and test result.",
    }],
  });

  const signal = summary.signals[0];
  assert.equal(signal?.patterns.includes("bounded-discovery-tool-tax"), true);
  assert.ok(signal?.recommendations.some((item) => /broad discovery tools should be out of scope/.test(item)));
  assert.ok(signal?.recommendations.some((item) => /Named-file prompts/.test(item)));
});

test("workflow improvement signals detect workspace boundary mutations", () => {
  const summary = summarizeWorkflowImprovementSignals({
    outputs: [
      output("simple", {
        workspace: { caseId: "generic-cli-scaffold", pass: true, score: 100 },
        diagnostics: { tokenTotal: 14_000, toolEvents: 8 },
      }),
      output("chalin", {
        cwd: "/var/folders/tmp/pi-chalin-workflow-generic-cli",
        workspace: { caseId: "generic-cli-scaffold", pass: false, score: 22 },
        diagnostics: {
          tokenTotal: 12_000,
          toolEvents: 10,
          traceSummary: { firstMutationEventIndex: 0, postVerificationExplorationCalls: 0, postVerificationShellCalls: 0, toolCallSequence: ["write", "write", "bash"] },
        },
        toolHistory: {
          events: [
            { name: "write", phase: "start", argsSnippet: "{\"path\":\"/Users/cristianfonseca/note-pack/package.json\"}" },
            { name: "write", phase: "end", resultSnippet: "Successfully wrote 276 bytes to /Users/cristianfonseca/note-pack/package.json" },
            { name: "bash", phase: "start", argsSnippet: "{\"command\":\"cd /Users/cristianfonseca/note-pack && bun test\"}" },
          ],
        },
      }),
    ],
    comparativeJudges: [{
      caseId: "generic-cli-scaffold",
      runIndex: 1,
      winnerVariant: "simple",
      targetWins: false,
      verdict: "Target did not persist the scaffolded files in the evaluated workspace; validation saw only README and missing expected test artifact.",
    }],
  });

  const signal = summary.signals[0];
  assert.equal(signal?.classification, "quality-gap");
  assert.equal(signal?.patterns.includes("workspace-boundary-mutation-gap"), true);
  assert.ok(signal?.recommendations.some((item) => /current workspace root/.test(item)));
  assert.ok(signal?.recommendations.some((item) => /relative paths/.test(item)));
});

test("workflow improvement signals keep provider limits out of quality advice", () => {
  const summary = summarizeWorkflowImprovementSignals({
    outputs: [output("simple"), output("chalin", {
      workspace: { caseId: "holdout-go-ttl-cache", pass: false, score: 44 },
      trace: { pass: false, score: 0 },
      judge: { pass: false, score: 8 },
      diagnostics: {
        tokenTotal: 0,
        toolEvents: 0,
        infrastructureFailure: { kind: "provider-error", message: "usage_limit_reached" },
        traceSummary: { toolCallSequence: [] },
      },
    })],
    comparativeJudges: [{
      caseId: "holdout-go-ttl-cache",
      runIndex: 1,
      targetWins: false,
      skipped: true,
      reason: "target-infrastructure",
    }],
  });

  assert.equal(summary.comparisons, 0);
  assert.equal(summary.infrastructureBlocked, 1);
  assert.equal(summary.skipped, 0);
  assert.equal(summary.signals[0]?.classification, "infrastructure");
  assert.deepEqual(summary.abstractRules, [
    "Do not tune prompts from provider/CLI/agent infrastructure failures; rerun after health is restored and keep the row out of blind quality win-rate.",
  ]);
});

test("workflow improvement treats recovered target infrastructure as infrastructure noise", () => {
  const summary = summarizeWorkflowImprovementSignals({
    outputs: [output("simple"), output("chalin", {
      diagnostics: {
        tokenTotal: 130_000,
        toolEvents: 40,
        recoveredInfrastructureFailures: [{ kind: "agent-stall", message: "workflow variant timeout after 180000ms" }],
        traceSummary: { toolCallSequence: ["read", "edit", "bash"] },
      },
    })],
    comparativeJudges: [{
      caseId: "holdout-go-ttl-cache",
      runIndex: 1,
      winnerVariant: "simple",
      targetWins: false,
    }],
  });

  assert.equal(summary.comparisons, 0);
  assert.equal(summary.infrastructureBlocked, 1);
  assert.equal(summary.targetLosses, 0);
  assert.equal(summary.signals[0]?.classification, "infrastructure");
  assert.match(summary.signals[0]?.target.infrastructureFailure ?? "", /recovered-agent-stall/);
});

test("workflow improvement signals fall back to structured tool history when trace summary is absent", () => {
  const summary = summarizeWorkflowImprovementSignals({
    outputs: [
      output("simple", {
        diagnostics: { tokenTotal: 10_000 },
        toolHistory: {
          totalEvents: 2,
          events: [
            { name: "read", phase: "start" },
            { name: "bash", phase: "start" },
          ],
        },
      }),
      output("chalin", {
        diagnostics: { tokenTotal: 20_000 },
        toolHistory: {
          totalEvents: 8,
          events: [
            { name: "ls", phase: "start" },
            { name: "grep", phase: "start" },
            { name: "read", phase: "start" },
            { name: "edit", phase: "start" },
            { name: "bash", phase: "start" },
          ],
        },
      }),
    ],
    comparativeJudges: [{ caseId: "holdout-go-ttl-cache", runIndex: 1, winnerVariant: "simple", targetWins: false }],
  });

  assert.equal(summary.efficiencyGaps, 1);
  assert.equal(summary.signals[0]?.target.toolEvents, 8);
  assert.deepEqual(summary.signals[0]?.target.toolSequence, ["ls", "grep", "read", "edit", "bash"]);
  assert.ok(summary.abstractRules.some((rule) => /Named-file prompts/.test(rule)));
});

test("workflow improvement signals use agent history to flag orchestration overhead", () => {
  const summary = summarizeWorkflowImprovementSignals({
    outputs: [
      output("simple", {
        diagnostics: {
          tokenTotal: 12_000,
          toolEvents: 4,
          traceSummary: { firstMutationEventIndex: 1, postVerificationExplorationCalls: 0, postVerificationShellCalls: 0, toolCallSequence: ["read", "edit", "bash"] },
        },
      }),
      output("chalin", {
        diagnostics: {
          tokenTotal: 25_000,
          toolEvents: 12,
          traceSummary: { firstMutationEventIndex: 2, postVerificationExplorationCalls: 0, postVerificationShellCalls: 0, toolCallSequence: ["read", "chalin_route", "edit", "bash"] },
        },
        agentHistory: {
          totalRuns: 1,
          runs: [{
            agents: ["scout", "worker", "reviewer"],
            totalSteps: 3,
            steps: [
              { agent: "scout", status: "complete" },
              { agent: "worker", status: "complete" },
              { agent: "reviewer", status: "failed" },
            ],
          }],
        },
      }),
    ],
    comparativeJudges: [{ caseId: "holdout-go-ttl-cache", runIndex: 1, winnerVariant: "simple", targetWins: false }],
  });

  assert.equal(summary.efficiencyGaps, 1);
  assert.equal(summary.signals[0]?.target.agentRuns, 1);
  assert.equal(summary.signals[0]?.target.agentSteps, 3);
  assert.equal(summary.signals[0]?.target.failedAgentSteps, 1);
  assert.deepEqual(summary.signals[0]?.target.agentSequence, ["scout", "worker", "reviewer"]);
  assert.ok(summary.abstractRules.some((rule) => /Failed subagent steps/.test(rule)));
  assert.ok(summary.abstractRules.some((rule) => /Agent routes must add concrete coverage/.test(rule)));
});

test("workflow improvement CLI accumulates repeated matrix flags", () => {
  assert.deepEqual(parseWorkflowImprovementArgs([
    "--matrix=first.jsonl",
    "--matrix=second.jsonl",
    "--report=one.json,two.json",
    "third.json",
  ]), {
    matrix: "first.jsonl,second.jsonl",
    report: "one.json,two.json",
    _: "third.json",
  });
});

test("workflow improvement filters report inputs by model and judge model", () => {
  const args = parseWorkflowImprovementArgs([
    "--model=zai/glm-5.1",
    "--judgeModel=zai/glm-5.1",
  ]);
  const reports = [
    { id: "glm", reportPath: "/tmp/glm.json", model: "zai/glm-5.1", judgeModel: "zai/glm-5.1", outputs: [output("chalin")] },
    { id: "spark", reportPath: "/tmp/spark.json", model: "openai-codex/gpt-5.3-codex-spark", judgeModel: "zai/glm-5.1", outputs: [output("chalin")] },
    { id: "other-judge", reportPath: "/tmp/other-judge.json", model: "zai/glm-5.1", judgeModel: "anthropic-vibeproxy/claude-opus-4-7", outputs: [output("chalin")] },
    { id: "legacy", reportPath: "/tmp/legacy.json", outputs: [output("chalin")] },
  ];

  assert.deepEqual(filterWorkflowImprovementReports(reports, workflowImprovementReportFilters(args)).map((report) => report.id), ["glm"]);
});

test("workflow improvement model filters support repeated flags", () => {
  const args = parseWorkflowImprovementArgs([
    "--model=zai/glm-5.1",
    "--model=openai-codex/gpt-5.3-codex-spark",
  ]);

  assert.deepEqual(workflowImprovementReportFilters(args), {
    model: ["zai/glm-5.1", "openai-codex/gpt-5.3-codex-spark"],
    judgeModel: undefined,
  });
});

test("workflow improvement latest-per-case filters multi-case reports by current case", () => {
  const older = {
    id: "2026-05-27T10:00:00.000Z",
    reportPath: "/tmp/older.json",
    outputs: [
      output("simple", { workspace: { caseId: "case-a", pass: true, score: 100 } }),
      output("chalin", { workspace: { caseId: "case-a", pass: true, score: 100 } }),
      output("simple", { workspace: { caseId: "case-b", pass: true, score: 100 } }),
    ],
    comparativeJudges: [
      { caseId: "case-a", runIndex: 1, winnerVariant: "simple", targetWins: false },
      { caseId: "case-b", runIndex: 1, winnerVariant: "simple", targetWins: false },
    ],
  };
  const newer = {
    id: "2026-05-27T11:00:00.000Z",
    reportPath: "/tmp/newer.json",
    outputs: [
      output("simple", { workspace: { caseId: "case-a", pass: true, score: 100 } }),
      output("chalin", { workspace: { caseId: "case-a", pass: true, score: 100 } }),
    ],
    comparativeJudges: [{ caseId: "case-a", runIndex: 1, winnerVariant: "chalin", targetWins: true }],
  };

  const selected = selectLatestWorkflowImprovementReportsByCase([older, newer]);

  assert.deepEqual(selected.map((report) => report.reportPath), ["/tmp/newer.json", "/tmp/older.json"]);
  assert.deepEqual(selected.map((report) => report.outputs.map((item) => item.workspace?.caseId)), [["case-a", "case-a"], ["case-b"]]);
  assert.deepEqual(selected.map((report) => report.comparativeJudges?.map((judge) => judge.caseId)), [["case-a"], ["case-b"]]);
});

test("workflow improvement latest-per-case keeps prior analyzable report when latest is infrastructure-only", () => {
  const analyzable = {
    id: "2026-05-27T10:00:00.000Z",
    reportPath: "/tmp/analyzable.json",
    outputs: [output("simple"), output("chalin")],
    comparativeJudges: [{ caseId: "holdout-go-ttl-cache", runIndex: 1, winnerVariant: "chalin", targetWins: true }],
  };
  const providerBlocked = {
    id: "2026-05-27T11:00:00.000Z",
    reportPath: "/tmp/provider-blocked.json",
    outputs: [output("chalin", {
      workspace: { caseId: "holdout-go-ttl-cache", pass: false, score: 44 },
      trace: { pass: false, score: 0 },
      judge: undefined,
      diagnostics: {
        tokenTotal: 0,
        toolEvents: 0,
        infrastructureFailure: { kind: "provider-error", message: "usage_limit_reached" },
        traceSummary: { toolCallSequence: [] },
      },
    })],
    comparativeJudges: [{ caseId: "holdout-go-ttl-cache", runIndex: 1, targetWins: false, skipped: true, reason: "target-infrastructure" }],
  };

  const selection = selectLatestWorkflowImprovementReportSelectionByCase([analyzable, providerBlocked]);

  assert.deepEqual(selection.reports.map((report) => report.reportPath), ["/tmp/analyzable.json"]);
  assert.deepEqual(selection.infrastructureFallbacks, [{
    caseId: "holdout-go-ttl-cache",
    latestReportId: "2026-05-27T11:00:00.000Z",
    latestReportPath: "/tmp/provider-blocked.json",
    fallbackReportId: "2026-05-27T10:00:00.000Z",
    fallbackReportPath: "/tmp/analyzable.json",
  }]);
});

test("workflow improvement report summary aggregates repeated abstract rules", () => {
  const first = summarizeWorkflowImprovementSignals({
    outputs: [output("simple"), output("chalin")],
    comparativeJudges: [{ caseId: "holdout-go-ttl-cache", runIndex: 1, winnerVariant: "simple", targetWins: false }],
  });
  assert.equal(first.efficiencyGaps, 1);

  const summary = summarizeWorkflowImprovementReports([
    {
      id: "r1",
      reportPath: "/tmp/r1.json",
      outputs: [output("simple"), output("chalin")],
      comparativeJudges: [{ caseId: "holdout-go-ttl-cache", runIndex: 1, winnerVariant: "simple", targetWins: false }],
    },
    {
      id: "r2",
      reportPath: "/tmp/r2.json",
      outputs: [output("simple"), output("chalin")],
      comparativeJudges: [{ caseId: "holdout-go-ttl-cache", runIndex: 1, winnerVariant: "simple", targetWins: false }],
    },
  ]);

  assert.equal(summary.reports, 2);
  assert.equal(summary.comparisons, 2);
  assert.equal(summary.efficiencyGaps, 2);
  assert.equal(summary.signals.length, 2);
  assert.equal(summary.lossSignals.length, 2);
  assert.equal(summary.lossSignals[0]?.classification, "efficiency-gap");
  assert.equal(summary.lossSignals[0]?.reportId, "r1");
  assert.equal(summary.lossSignals[0]?.reportPath, "/tmp/r1.json");
  assert.equal(summary.lossSignals[1]?.reportId, "r2");
  assert.equal(summary.lossSignals[1]?.reportPath, "/tmp/r2.json");
  assert.equal(summary.abstractRules["For quality-equivalent outputs, token premium is a regression; compress progress/final text and avoid redundant reads."], 2);
  assert.equal(summary.caseSummaries[0]?.caseId, "holdout-go-ttl-cache");
  assert.equal(summary.caseSummaries[0]?.comparisons, 2);
  assert.equal(summary.caseSummaries[0]?.targetLosses, 2);
  assert.deepEqual(summary.caseSummaries[0]?.winnerVariants, { simple: 2 });
  assert.deepEqual(summary.caseSummaries[0]?.lossWinnerVariants, { simple: 2 });
  assert.equal(summary.reportSummaries[0]?.reportPath, "/tmp/r1.json");
});

test("workflow improvement CLI resolves unique report paths from matrices", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-chalin-improvement-"));
  try {
    const firstReport = path.join(dir, "first.json");
    const secondReport = path.join(dir, "second.json");
    const legacyReport = path.join(dir, "workflow-quality-legacy.json");
    const matrix = path.join(dir, "matrix.jsonl");
    fs.writeFileSync(legacyReport, JSON.stringify({
      startedAt: "2026-05-27T22:13:40.651Z",
      mode: "sdk",
      cases: ["case-d"],
      variants: ["simple", "chalin", "gentle"],
      runs: 2,
      outputs: [],
    }));
    fs.writeFileSync(matrix, [
      JSON.stringify({ caseId: "case-a", pass: true, reportPath: firstReport, stats: {} }),
      JSON.stringify({ caseId: "case-b", pass: true, reportPath: secondReport, stats: {} }),
      JSON.stringify({ caseId: "case-c", pass: true, reportPath: firstReport, stats: {} }),
      JSON.stringify({ caseId: "case-d", pass: true, startedAt: "2026-05-27T22:13:40.651Z", mode: "sdk", variants: ["simple", "chalin", "gentle"], runs: 2, stats: {} }),
    ].join("\n") + "\n");

    const args = {
      report: firstReport,
      matrix,
      _: secondReport,
    };

    assert.deepEqual(resolveWorkflowImprovementReportPaths(args, { reportDir: dir }), [firstReport, secondReport, legacyReport]);
    assert.deepEqual(resolveWorkflowImprovementReportSelection(args, { reportDir: dir }).matrixResolution, {
      matrixPaths: [matrix],
      matrixRows: 4,
      selectedMatrixRows: 4,
      latestPerCase: false,
      rowsWithReportPath: 3,
      rowsInferredReportPath: 1,
      unresolvedRows: [],
    });
    assert.deepEqual(resolveWorkflowImprovementReportSelection({ matrix, latestPerCase: "1" }, { reportDir: dir }).matrixResolution, {
      matrixPaths: [matrix],
      matrixRows: 4,
      selectedMatrixRows: 4,
      latestPerCase: true,
      rowsWithReportPath: 3,
      rowsInferredReportPath: 1,
      unresolvedRows: [],
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("workflow improvement latest matrix selection uses row timestamps", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-chalin-improvement-latest-"));
  try {
    const olderReport = path.join(dir, "older.json");
    const newerReport = path.join(dir, "newer.json");
    const matrix = path.join(dir, "matrix.jsonl");
    fs.writeFileSync(matrix, [
      JSON.stringify({ caseId: "case-a", recordedAt: "2026-05-27T10:00:00.000Z", reportPath: newerReport, pass: true, stats: {} }),
      JSON.stringify({ caseId: "case-a", recordedAt: "2026-05-27T09:00:00.000Z", reportPath: olderReport, pass: true, stats: {} }),
    ].join("\n") + "\n");

    const selection = resolveWorkflowImprovementReportSelection({ matrix, latestPerCase: "1" }, { reportDir: dir });
    assert.deepEqual(selection.reportPaths, [newerReport]);
    assert.equal(selection.matrixResolution.matrixRows, 2);
    assert.equal(selection.matrixResolution.selectedMatrixRows, 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
