import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, test } from "bun:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { chalinChildSessionDir, createChalinChildSessionManager, hideLegacyTopLevelChildSessions } from "../src/runtime/child-sessions.ts";
import { policyForStep } from "../src/budget/budget.ts";
import { resolveAgentModel, resolveAgentThinking, resolveInheritedModelFallback } from "../src/runner/model-resolution.ts";
import { buildSdkPrompt, childToolNames, resolveStepCompletionStatus, synthesisCrossStepDuplicateReadLimit, toolBudgetForStep } from "../src/runner/runner-prompt.ts";
import { DEFAULT_SDK_STEP_IDLE_STALL_MS, MockWorkerRunner, allowedToolsForStep, applyConflictResolverRepair, applyStructuredHandoffContract, budgetPolicyForSdkStep, buildConflictResolverTask, cleanTransientGeneratedWorkspaceOutputs, declaredFilesByIsolatedStepId, extractAssistantRuntimeError, hasBlockingCheckpointedSteps, hasUnrecoverableFailedSteps, normalizeThinkingForBudget, parseAgentOutput, promptTokenomicsPhaseForStep, reconcileDeclaredGeneratedScopeViolations, recoverPausedReadOnlyDagStage, reviewerHandoffNeedsRepair, runWithIdleStallMonitor, sanitizePromptWorkspaceText, sdkStepIdleStallMs, shouldRecordMutationLedgerEntry, shouldStopAfterDagStage, terminalRunStatusForSteps, workUnitMutationScopeForStep, workspaceDirtyEntriesFromStatus, workspaceDirtyPathsFromStatus, workspaceHygieneProblemsForDirtyPaths } from "../src/runner/runner.ts";
import { buildContextPacket, formatContextPacket } from "../src/runner/context-packet.ts";
import { loadFailedRunDiagnostic, markBlockedDependentsSkipped, repairOptionsFor } from "../src/runner/run-recovery.ts";
import { createRunState, loadResumableRunState, persistRun, prepareRunForResume } from "../src/runner/runner-state.ts";
import { expandWorkUnitsFromBestHandoff, expandWorkUnitsFromHandoff } from "../src/runner/work-units.ts";
import { isUsableStepStatus as runtimeIsUsableStepStatus } from "../src/runtime/status.ts";
import type { AgentDefinition, RouteDecision, RunState, RunStepMetrics, RunStepState } from "../src/domain/schemas.ts";
import { SkillCatalog } from "../src/skills/skills.ts";

const tempDirs: string[] = [];
afterEach(() => { while (tempDirs.length > 0) fs.rmSync(tempDirs.pop()!, { recursive: true, force: true }); });
function tempDir(prefix: string): string { const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix)); tempDirs.push(dir); return dir; }
function git(cwd: string, args: string[]) {
  const result = spawnSync("git", args, { cwd, encoding: "utf-8" });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}
function agent(name: string, caps: AgentDefinition["capabilities"]): AgentDefinition {
  return { name, scope: "built-in", concern: "implementation", capabilities: caps, description: name, model: "inherit", tools: [], memory: { read: false, write: "never", categories: [] }, systemPrompt: "", diagnostics: [] };
}

function emptyUsage() {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

function userMessage(content: string): Parameters<SessionManager["appendMessage"]>[0] {
  return { role: "user", content } as Parameters<SessionManager["appendMessage"]>[0];
}

function assistantMessage(content: string): Parameters<SessionManager["appendMessage"]>[0] {
  return { role: "assistant", content } as unknown as Parameters<SessionManager["appendMessage"]>[0];
}

function readOnlyAgent(name: string, concern: AgentDefinition["concern"] = "context-building"): AgentDefinition {
  return { name, scope: "built-in", concern, capabilities: ["inspect-files", "search-files"], description: name, model: "inherit", tools: [], memory: { read: false, write: "never", categories: [] }, systemPrompt: "", diagnostics: [] };
}

function activeSkillsFor(task: string, agent: AgentDefinition) {
  const catalog = SkillCatalog.load({ cwd: process.cwd() });
  const result = catalog.search(task, { agent });
  assert.deepEqual(catalog.diagnostics.errors, []);
  return result.active;
}

test("promptTokenomicsPhaseForStep does not treat normal repair tasks as review repair phases", () => {
  const worker = agent("worker", ["edit-files"]);
  const reviewer = { ...agent("reviewer", ["inspect-files"]), concern: "review" as const };

  assert.equal(promptTokenomicsPhaseForStep({ id: "step-1", agent: "worker" }, worker), "childPrompt");
  assert.equal(promptTokenomicsPhaseForStep({ id: "repair-parser-bug:step-1", agent: "worker" }, worker), "childPrompt");
  assert.equal(promptTokenomicsPhaseForStep({ id: "step-2", agent: "reviewer" }, reviewer), "reviewer");
  assert.equal(promptTokenomicsPhaseForStep({ id: "review-repair-1-worker", agent: "worker" }, worker), "repair");
  assert.equal(promptTokenomicsPhaseForStep({ id: "review-repair-1-reviewer", agent: "reviewer" }, reviewer), "repair");
});

function stepMetrics(overrides: Partial<RunStepMetrics> = {}): RunStepMetrics {
  return {
    durationMs: 1,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    toolCalls: 0,
    toolCallsByName: {},
    ...overrides,
  };
}

type ReviewerOutputOverrides = Omit<Partial<NonNullable<ReturnType<typeof parseAgentOutput>["reviewerVerdict"]>>, "evidence"> & { evidence?: unknown[] };

function reviewerOutput(verdict: "pass" | "fail" | "gap", overrides: ReviewerOutputOverrides = {}) {
  const blockingFindings = overrides.blockingFindings ?? (verdict === "fail" ? ["blocking implementation gap"] : []);
  const missingCoverage = overrides.missingCoverage ?? (verdict === "gap" ? ["missing permanent coverage"] : []);
  const evidence = overrides.evidence ?? [
    { kind: "reviewed-content", paths: ["src/parser.c", "tests/test_parser.c"], summary: "Reviewed changed implementation and tests." },
    { kind: "verification", command: "make test", status: "pass", result: "Exited 0." },
  ];
  return parseAgentOutput("reviewer", [
    "## Handoff",
    "- Structured reviewer handoff.",
    "## Reviewer Verdict",
    JSON.stringify({
      verdict,
      blockingFindings,
      missingCoverage,
      evidence,
      residualRisks: overrides.residualRisks ?? [],
      requiredRepair: overrides.requiredRepair,
    }),
  ].join("\n"));
}

test("parseAgentOutput extracts categorized human-readable memory candidates", () => {
  const output = parseAgentOutput("planner", "## Handoff\nUse worker next\n\n## Memory Candidates\n- tooling: This project uses Bun for tests, and tests should avoid setTimeout-based waits because they make the suite flaky.");
  assert.equal(output.handoff, "Use worker next");
  assert.equal(output.memoryCandidates.length, 1);
  assert.equal(output.memoryCandidates[0]?.category, "tooling");
});

test("parseAgentOutput parses tagged memory candidates wrapped in backticks", () => {
  const output = parseAgentOutput("scout", "## Memory Candidates\n- `project-fact: evgo is a Go monorepo for Evaluar microservices.`\n- `pattern: Pattern B to Pattern A migration requires a new ADR.`");
  assert.deepEqual(output.memoryCandidates.map((candidate) => candidate.category), ["project-fact", "pattern"]);
  assert.equal(output.memoryCandidates[0]?.confidence, 0.9);
  assert.doesNotMatch(output.memoryCandidates[0]?.content ?? "", /^`/);
});

test("parseAgentOutput ignores non-bullet memory blocks and None", () => {
  const codeOutput = parseAgentOutput("scout", "## Memory Candidates\ncmd = ['pi', '-e', 'src/index.ts']\nprint('--- stdout ---')");
  const noneOutput = parseAgentOutput("scout", "## Memory Candidates\n- None.");

  assert.equal(codeOutput.memoryCandidates.length, 0);
  assert.match(codeOutput.warnings.join("\n"), /no valid bullet candidates/);
  assert.equal(noneOutput.memoryCandidates.length, 0);
});

test("parseAgentOutput drops transient verification status memory candidates", () => {
  const output = parseAgentOutput("scout", [
    "## Findings",
    "- `bun test --dry-run` printed test inventory.",
    "## Memory Candidates",
    "- testing: 538 tests from dry-run, 138 currently failing in smoke integration.",
    "- tooling: Project tests use Bun's test runner and permanent regression tests should use bun:test APIs.",
  ].join("\n"));

  assert.deepEqual(output.memoryCandidates.map((candidate) => candidate.category), ["tooling"]);
  assert.doesNotMatch(output.memoryCandidates.map((candidate) => candidate.content).join("\n"), /currently failing|dry-run/i);
  assert.match(output.warnings.join("\n"), /transient verification status/i);
});

test("parseAgentOutput uses structured claim ledger before lexical transient detection", () => {
  const output = parseAgentOutput("scout", [
    "## Findings",
    "- Observacion parcial de validacion en progreso.",
    "## Claim Ledger",
    "```json",
    JSON.stringify([
      {
        kind: "transient-status",
        subject: "regression suite",
        summary: "La suite quedo roja durante una observacion parcial.",
        evidence: ["partial SDK observation"],
        confidence: 0.52,
      },
      {
        kind: "stable-fact",
        subject: "test runner",
        summary: "Project verification uses Bun scripts from package.json.",
        evidence: ["package.json"],
        confidence: 0.91,
      },
    ]),
    "```",
    "## Memory Candidates",
    "- testing: La suite quedo roja durante una observacion parcial.",
    "- tooling: Project verification uses Bun scripts from package.json.",
  ].join("\n"));

  assert.deepEqual((output.claims ?? []).map((claim) => claim.kind), ["transient-status", "stable-fact"]);
  assert.deepEqual(output.memoryCandidates.map((candidate) => candidate.category), ["tooling"]);
  assert.match(output.warnings.join("\n"), /structured transient verification claim/i);
});

test("parseAgentOutput extracts structured handoff and reviewer verdict contracts", () => {
  const output = parseAgentOutput("reviewer", [
    "## Agent Handoff",
    JSON.stringify({
      summary: "Review found one blocking acceptance gap.",
      changedFiles: ["src/parser.c"],
      verification: ["make test"],
      evidenceClaims: [{
        kind: "stable-fact",
        subject: "parser tests",
        summary: "The permanent suite omits EOF comments.",
        evidence: ["tests/test_parser.c"],
        confidence: 0.82,
      }],
      risks: ["EOF comment regression"],
      nextActions: ["Add permanent EOF test"],
    }),
    "## Reviewer Verdict",
    JSON.stringify({
      verdict: "gap",
      blockingFindings: ["EOF comments are not covered."],
      missingCoverage: ["tests/test_parser.c lacks EOF comment case."],
      evidence: ["src/parser.c", "tests/test_parser.c"],
      requiredRepair: "Add a runner-discoverable EOF comment regression.",
    }),
    "## Memory Candidates",
    "- None.",
  ].join("\n"));

  assert.equal(output.structuredHandoff?.summary, "Review found one blocking acceptance gap.");
  assert.equal(output.structuredHandoff?.evidenceClaims[0]?.kind, "stable-fact");
  assert.equal(output.reviewerVerdict?.verdict, "gap");
  assert.match(output.handoff ?? "", /Review found one blocking acceptance gap/);
});

test("parseAgentOutput preserves structured reviewer blocking finding objects", () => {
  const output = parseAgentOutput("reviewer", [
    "## Agent Handoff",
    JSON.stringify({
      summary: "Review failed with structured findings.",
      changedFiles: [],
      verification: ["reviewed implementation"],
      evidenceClaims: [],
      risks: [],
      nextActions: ["Repair blocking findings."],
    }),
    "## Reviewer Verdict",
    JSON.stringify({
      verdict: "fail",
      blockingFindings: [{
        id: "BF-1",
        severity: "high",
        file: "src/token.ts",
        summary: "Token lookup uses the unsafe identifier.",
        requiredRepair: "Key lookup by the derived safe identifier.",
      }],
      missingCoverage: [{
        file: "src/token.test.ts",
        summary: "No regression covers concurrent rotation.",
      }],
      evidence: [{
        kind: "reviewed-content",
        paths: ["src/token.ts", "src/token.test.ts"],
        summary: "Reviewed implementation and tests.",
      }],
      residualRisks: [],
      requiredRepair: "Repair the unsafe lookup and add concurrency coverage.",
    }),
  ].join("\n"));

  assert.equal(output.reviewerVerdict?.verdict, "fail");
  assert.match(output.reviewerVerdict?.blockingFindings[0] ?? "", /BF-1/);
  assert.match(output.reviewerVerdict?.blockingFindings[0] ?? "", /Token lookup uses the unsafe identifier/);
  assert.match(output.reviewerVerdict?.missingCoverage[0] ?? "", /concurrent rotation/);
  assert.deepEqual(output.reviewerVerdict?.repairFiles, ["src/token.ts", "src/token.test.ts"]);
});

test("parseAgentOutput extracts fenced Agent Handoff JSON even with leading section prose", () => {
  const output = parseAgentOutput("planner", [
    "## Agent Handoff",
    "Plan JSON follows.",
    "```json",
    JSON.stringify({
      summary: "Planner produced bounded units.",
      changedFiles: [],
      verification: [],
      evidenceClaims: [],
      risks: [],
      nextActions: ["Run workers."],
      workUnits: [
        {
          id: "unit-one",
          title: "Unit one",
          scope: { files: ["src/one.ts"], purpose: "Bounded responsibility" },
          dependencies: [],
          acceptanceCriteria: ["Verify unit one."],
        },
      ],
    }),
    "```",
  ].join("\n"));

  assert.equal(output.handoffContract, "structured");
  assert.equal(output.structuredHandoff?.workUnits?.length, 1);
  assert.deepEqual(output.structuredHandoff?.workUnits?.[0]?.files, ["src/one.ts"]);
});

test("parseAgentOutput preserves reviewer residual risks separately from blocking gaps", () => {
  const output = parseAgentOutput("reviewer", [
    "## Reviewer Verdict",
    JSON.stringify({
      verdict: "pass",
      blockingFindings: [],
      missingCoverage: [],
      evidence: ["reviewed src/parser.c", "make test exited 0"],
      residualRisks: ["Optional broader validation was not available in the fixture."],
    }),
    "## Handoff",
    "- Structured reviewer contract.",
  ].join("\n"));

  assert.equal(output.reviewerVerdict?.verdict, "pass");
  assert.deepEqual(output.reviewerVerdict?.missingCoverage, []);
  assert.deepEqual(output.reviewerVerdict?.residualRisks, ["Optional broader validation was not available in the fixture."]);
});

test("parseAgentOutput normalizes contradictory reviewer pass verdicts with blocking fields", () => {
  const output = parseAgentOutput("reviewer", [
    "## Reviewer Verdict",
    JSON.stringify({
      verdict: "pass",
      blockingFindings: [],
      missingCoverage: ["Required coverage is still absent."],
      evidence: ["reviewed src/parser.c", "make test exited 0"],
      residualRisks: [],
    }),
    "## Handoff",
    "- Structured reviewer contract.",
  ].join("\n"));

  assert.equal(output.reviewerVerdict?.verdict, "gap");
  assert.deepEqual(output.reviewerVerdict?.missingCoverage, ["Required coverage is still absent."]);
  assert.match(output.warnings.join("\n"), /normalized verdict/i);
});

test("parseAgentOutput accepts scalar strings for structured handoff list fields", () => {
  const output = parseAgentOutput("worker", [
    "## Agent Handoff",
    JSON.stringify({
      summary: "Patched auth validation.",
      changedFiles: "src/auth/keycloak.ts",
      verification: "npx vitest run src/auth/keycloak.test.ts -> pass",
      evidenceClaims: [],
      risks: "No known remaining risk.",
      nextActions: "Reviewer should inspect auth boundary behavior.",
      workUnits: [],
    }),
  ].join("\n"));

  assert.deepEqual(output.structuredHandoff?.changedFiles, ["src/auth/keycloak.ts"]);
  assert.deepEqual(output.structuredHandoff?.verification, ["npx vitest run src/auth/keycloak.test.ts -> pass"]);
  assert.deepEqual(output.structuredHandoff?.risks, ["No known remaining risk."]);
  assert.deepEqual(output.structuredHandoff?.nextActions, ["Reviewer should inspect auth boundary behavior."]);
});

test("parseAgentOutput preserves structured WorkUnit scope files", () => {
  const output = parseAgentOutput("planner", [
    "## Agent Handoff",
    JSON.stringify({
      summary: "Planned bounded work.",
      changedFiles: [],
      verification: ["read project files"],
      evidenceClaims: [],
      risks: [],
      nextActions: [],
      workUnits: [
        {
          id: "unit-a",
          title: "Unit A",
          scope: {
            files: ["src/a.ts", "src/a.test.ts"],
            purpose: "Own feature A implementation and tests.",
          },
          dependencies: [],
          expectedEffects: ["read", "write", "verify"],
          acceptanceCriteria: ["tests pass"],
        },
      ],
    }),
  ].join("\n"));

  const unit = output.structuredHandoff?.workUnits?.[0];
  assert.deepEqual(unit?.scope, ["Own feature A implementation and tests."]);
  assert.deepEqual(unit?.files, ["src/a.ts", "src/a.test.ts"]);
  assert.deepEqual(unit?.expectedEffects, ["read", "write", "verify"]);
});

test("parseAgentOutput extracts WorkUnit files from structured scope file objects", () => {
  const output = parseAgentOutput("planner", [
    "## Agent Handoff",
    JSON.stringify({
      summary: "Planned bounded work.",
      changedFiles: [],
      verification: ["read project files"],
      evidenceClaims: [],
      risks: [],
      nextActions: [],
      workUnits: [
        {
          id: "unit-a",
          title: "Unit A",
          scope: {
            files: [
              { path: "src/a.ts", action: "modify" },
              { file: "src/a.test.ts", change: "add focused tests" },
            ],
            purpose: "Own feature A implementation and tests.",
          },
          dependencies: [],
          acceptanceCriteria: ["tests pass"],
        },
      ],
    }),
  ].join("\n"));

  const unit = output.structuredHandoff?.workUnits?.[0];
  assert.deepEqual(unit?.scope, ["Own feature A implementation and tests."]);
  assert.deepEqual(unit?.files, ["src/a.ts", "src/a.test.ts"]);
});

test("parseAgentOutput normalizes structured verification evidence objects", () => {
  const output = parseAgentOutput("conflict-resolver", [
    "## Agent Handoff",
    JSON.stringify({
      summary: "Resolved isolated worktree conflict.",
      changedFiles: ["cmd/api/main.go"],
      verification: [
        { command: "go test ./...", result: "pass", evidence: ["cmd/api", "internal/auth"] },
        { readback: ["cmd/api/main.go", "cmd/api/main_test.go"], result: "confirmed" },
      ],
      evidenceClaims: [],
      risks: [],
      nextActions: [],
      workUnits: [],
    }),
  ].join("\n"));

  assert.match(output.structuredHandoff?.verification[0] ?? "", /command: go test \.\/\.\.\./);
  assert.match(output.structuredHandoff?.verification[0] ?? "", /result: pass/);
  assert.match(output.structuredHandoff?.verification[1] ?? "", /readback: cmd\/api\/main\.go, cmd\/api\/main_test\.go/);
});

test("parseAgentOutput accepts scalar structured verification objects", () => {
  const output = parseAgentOutput("worker", [
    "## Agent Handoff",
    JSON.stringify({
      summary: "Verification-only repair completed.",
      changedFiles: ["package.json"],
      verification: { command: "npm run test", result: "pass" },
      evidenceClaims: [],
      risks: [],
      nextActions: [],
      workUnits: [],
    }),
  ].join("\n"));

  assert.equal(output.structuredHandoff?.verification.length, 1);
  assert.match(output.structuredHandoff?.verification[0] ?? "", /command: npm run test/);
  assert.match(output.structuredHandoff?.verification[0] ?? "", /result: pass/);
});

test("parseAgentOutput rejects empty reviewer pass verdicts", () => {
  const output = parseAgentOutput("reviewer", [
    "## Handoff",
    "- Reviewed the implementation.",
    "## Reviewer Verdict",
    JSON.stringify({
      verdict: "pass",
      blockingFindings: [],
      missingCoverage: [],
      evidence: [],
    }),
  ].join("\n"));

  assert.equal(output.reviewerVerdict, undefined);
  assert.match(output.warnings.join("\n"), /pass omitted evidence/i);
  assert.equal(reviewerHandoffNeedsRepair({ agent: "reviewer", status: "complete", output }), true);
});

test("parseAgentOutput marks legacy handoff fallback as degraded", () => {
  const output = parseAgentOutput("planner", [
    "## Handoff",
    "- Legacy text summary for downstream synthesis.",
    "## Memory Candidates",
    "- None.",
  ].join("\n"));

  assert.equal(output.structuredHandoff, undefined);
  assert.equal(output.handoffContract, "legacy-degraded");
  assert.match(output.handoff ?? "", /Legacy text summary/);
});

test("applyStructuredHandoffContract validates structured handoff fields by role and expected effects", () => {
  const cwd = tempDir("pi-chalin-handoff-fields-");
  const writerRoute: RouteDecision = {
    kind: "multi-agent-sequential",
    agents: ["worker"],
    risk: "medium",
    ambiguity: "low",
    needsMemory: false,
    needsArtifacts: true,
    expectedEffects: ["read", "write", "verify"],
    reason: "implementation handoff field contract",
    plan: { kind: "sequential", steps: [{ agent: "worker", task: "implement and verify" }] },
  };
  const writerRun = createRunState(writerRoute, cwd);
  const writer = agent("worker", ["edit-files"]);
  writerRun.steps[0]!.status = "complete";
  writerRun.steps[0]!.output = parseAgentOutput("worker", [
    "## Agent Handoff",
    JSON.stringify({ summary: "Implementation completed.", changedFiles: [], verification: [], evidenceClaims: [], risks: [], nextActions: [] }),
  ].join("\n"));

  assert.equal(applyStructuredHandoffContract(writerRun, writerRun.steps[0]!, writer), "fail");
  assert.equal(writerRun.steps[0]!.status, "failed");
  assert.match(writerRun.steps[0]!.error ?? "", /changedFiles/i);
  assert.match(writerRun.steps[0]!.error ?? "", /verification/i);

  const verificationRepairRun = createRunState(writerRoute, cwd);
  verificationRepairRun.steps[0]!.status = "complete";
  verificationRepairRun.steps[0]!.repairCycle = 1;
  verificationRepairRun.steps[0]!.metrics = stepMetrics({ filesTouched: [] });
  verificationRepairRun.steps[0]!.output = parseAgentOutput("worker", [
    "## Agent Handoff",
    JSON.stringify({
      summary: "Repair verified the final commands; no file edits were required.",
      changedFiles: [],
      verification: ["npm run test and npm run build passed after dependency install."],
      evidenceClaims: [],
      risks: [],
      nextActions: [],
    }),
  ].join("\n"));

  assert.equal(applyStructuredHandoffContract(verificationRepairRun, verificationRepairRun.steps[0]!, writer), "accept");
  assert.equal(verificationRepairRun.steps[0]!.status, "complete");

  const verifiedNoopRun = createRunState(writerRoute, cwd);
  verifiedNoopRun.steps[0]!.status = "complete";
  verifiedNoopRun.steps[0]!.metrics = stepMetrics({ filesTouched: [] });
  verifiedNoopRun.steps[0]!.output = parseAgentOutput("worker", [
    "## Agent Handoff",
    JSON.stringify({
      summary: "The unit was already satisfied by a prior repair; no edits were required.",
      changedFiles: [],
      verification: [{ commands: ["npm test"], result: "pass", readback: "target file already contains the required section" }],
      evidenceClaims: [],
      risks: [],
      nextActions: [],
    }),
  ].join("\n"));

  assert.equal(applyStructuredHandoffContract(verifiedNoopRun, verifiedNoopRun.steps[0]!, writer), "accept");
  assert.equal(verifiedNoopRun.steps[0]!.status, "complete");

  const blockedNoopRun = createRunState(writerRoute, cwd);
  blockedNoopRun.steps[0]!.status = "complete";
  blockedNoopRun.steps[0]!.metrics = stepMetrics({ filesTouched: [] });
  blockedNoopRun.steps[0]!.output = parseAgentOutput("worker", [
    "## Agent Handoff",
    JSON.stringify({
      summary: "No edits were made because a human scope decision is still required.",
      changedFiles: [],
      verification: ["Workspace inspection confirmed the target does not exist."],
      evidenceClaims: [],
      risks: ["Proceeding would require inventing product behavior."],
      nextActions: ["Ask the user to choose the scope before implementation."],
    }),
  ].join("\n"));

  assert.equal(applyStructuredHandoffContract(blockedNoopRun, blockedNoopRun.steps[0]!, writer), "fail");
  assert.match(blockedNoopRun.steps[0]!.error ?? "", /changedFiles/i);

  const missingChangedFilesRun = createRunState(writerRoute, cwd);
  missingChangedFilesRun.steps[0]!.status = "complete";
  missingChangedFilesRun.steps[0]!.metrics = stepMetrics({ filesTouched: ["src/index.ts"] });
  missingChangedFilesRun.steps[0]!.output = parseAgentOutput("worker", [
    "## Agent Handoff",
    JSON.stringify({
      summary: "Implementation completed but changedFiles was omitted.",
      changedFiles: [],
      verification: ["npm test passed."],
      evidenceClaims: [],
      risks: [],
      nextActions: [],
    }),
  ].join("\n"));

  assert.equal(applyStructuredHandoffContract(missingChangedFilesRun, missingChangedFilesRun.steps[0]!, writer), "fail");
  assert.match(missingChangedFilesRun.steps[0]!.error ?? "", /changedFiles/i);

  const reviewRoute: RouteDecision = {
    kind: "multi-agent-sequential",
    agents: ["reviewer"],
    risk: "medium",
    ambiguity: "low",
    needsMemory: false,
    needsArtifacts: true,
    expectedEffects: ["read", "verify"],
    reason: "review handoff field contract",
    plan: { kind: "sequential", steps: [{ agent: "reviewer", task: "review verification evidence" }] },
  };
  const reviewRun = createRunState(reviewRoute, cwd);
  const reviewer = readOnlyAgent("reviewer", "review");
  reviewRun.steps[0]!.status = "complete";
  reviewRun.steps[0]!.output = parseAgentOutput("reviewer", [
    "## Agent Handoff",
    JSON.stringify({ summary: "Review completed.", changedFiles: [], verification: [], evidenceClaims: [], risks: [], nextActions: [] }),
    "## Reviewer Verdict",
    JSON.stringify({ verdict: "gap", blockingFindings: [], missingCoverage: ["No verification evidence."], evidence: ["src/parser.c"] }),
  ].join("\n"));

  assert.equal(applyStructuredHandoffContract(reviewRun, reviewRun.steps[0]!, reviewer), "accept");
  assert.equal(reviewRun.steps[0]!.status, "complete");
  assert.equal(reviewerHandoffNeedsRepair(reviewRun.steps[0], { expectsVerify: true }), true);

  const verdictOnlyReviewRun = createRunState(reviewRoute, cwd);
  verdictOnlyReviewRun.steps[0]!.status = "complete";
  verdictOnlyReviewRun.steps[0]!.output = parseAgentOutput("reviewer", [
    "## Reviewer Verdict",
    JSON.stringify({
      verdict: "pass",
      blockingFindings: [],
      missingCoverage: [],
      evidence: ["src/auth/token.ts reviewed", "bun test passed"],
      residualRisks: ["Optional integration coverage can be expanded later."],
    }),
  ].join("\n"));

  assert.equal(applyStructuredHandoffContract(verdictOnlyReviewRun, verdictOnlyReviewRun.steps[0]!, reviewer), "accept");
  assert.equal(verdictOnlyReviewRun.steps[0]!.status, "complete");

  const scoutRoute: RouteDecision = {
    kind: "multi-agent-dag",
    agents: ["scout", "worker", "reviewer"],
    risk: "medium",
    ambiguity: "low",
    needsMemory: false,
    needsArtifacts: true,
    expectedEffects: ["read", "write", "verify"],
    reason: "fanout discovery should not inherit final verification obligation",
    plan: {
      kind: "dag",
        stages: [{ id: "discover", tasks: [{ agent: "scout", task: "Locate all review notes without editing." }] }],
    },
  };
  const scoutRun = createRunState(scoutRoute, cwd);
  const scout = readOnlyAgent("scout", "recon");
  scoutRun.steps[0]!.status = "complete";
  scoutRun.steps[0]!.output = parseAgentOutput("scout", [
    "## Agent Handoff",
    JSON.stringify({ summary: "Found review notes.", changedFiles: [], verification: [], evidenceClaims: [], risks: [], nextActions: [] }),
  ].join("\n"));

  assert.equal(applyStructuredHandoffContract(scoutRun, scoutRun.steps[0]!, scout), "accept");
  assert.equal(scoutRun.steps[0]!.status, "complete");
});

test("applyStructuredHandoffContract degrades missing structured handoffs by role and risk", () => {
  const cwd = tempDir("pi-chalin-handoff-contract-");
  const route: RouteDecision = {
    kind: "multi-agent-sequential",
    agents: ["scout", "planner", "worker"],
    risk: "low",
    ambiguity: "low",
    needsMemory: false,
    needsArtifacts: true,
    expectedEffects: ["read"],
    reason: "test handoff policy",
    plan: { kind: "sequential", steps: [{ agent: "scout", task: "map" }, { agent: "planner", task: "plan" }, { agent: "worker", task: "implement" }] },
  };
  const run = createRunState(route, cwd);
  const scout = readOnlyAgent("scout", "recon");
  const planner = readOnlyAgent("planner", "planning");
  const writer = agent("worker", ["edit-files"]);

  run.steps[0]!.status = "complete";
  run.steps[0]!.output = parseAgentOutput("scout", "## Handoff\n- legacy read-only map");
  run.steps[1]!.status = "complete";
  run.steps[1]!.output = parseAgentOutput("planner", "## Handoff\n- legacy plan");
  run.steps[2]!.status = "complete";
  run.steps[2]!.output = parseAgentOutput("worker", "## Handoff\n- legacy implementation receipt");

  assert.equal(applyStructuredHandoffContract(run, run.steps[0]!, scout), "warn");
  assert.equal(run.steps[0]!.status, "complete");
  assert.equal(applyStructuredHandoffContract(run, run.steps[1]!, planner), "checkpoint");
  assert.equal(run.steps[1]!.status, "checkpointed");
  assert.equal(run.steps[1]!.checkpoint?.kind, "handoff-contract");
  assert.equal(applyStructuredHandoffContract(run, run.steps[2]!, writer), "fail");
  assert.equal(run.steps[2]!.status, "failed");
  assert.match(run.steps[2]!.error ?? "", /structured ## Agent Handoff/i);
  assert.ok(run.warnings.some((warning) => /legacy ## Handoff text/.test(warning)));
});

test("mutation ledger records real write responsibility, not planner file plans", () => {
  assert.equal(shouldRecordMutationLedgerEntry({
    id: "step-1",
    agent: "planner",
    task: "Plan files to edit.",
    status: "complete",
    metrics: stepMetrics({ filesTouched: [] }),
  }), false);

  assert.equal(shouldRecordMutationLedgerEntry({
    id: "step-2",
    agent: "planner",
    task: "Plan files to edit.",
    status: "complete",
    metrics: stepMetrics({ filesTouched: ["src/planned.ts"] }),
  }), true);

  assert.equal(shouldRecordMutationLedgerEntry({
    id: "step-3",
    agent: "worker",
    task: "Implement planned files.",
    status: "complete",
    metrics: stepMetrics({ filesTouched: [] }),
  }), true);
});

test("buildSdkPrompt requires evidence-grade handling for transient and negative claims", () => {
  const scout = readOnlyAgent("scout", "recon");
  const planner = readOnlyAgent("planner", "planning");
  const scoutPrompt = buildSdkPrompt(scout, "Analyze project tests and Effect usage.", tempDir("pi-chalin-prompt-evidence-"), undefined, 12, "deep");
  const plannerPrompt = buildSdkPrompt(planner, "Synthesize prior handoff.", tempDir("pi-chalin-prompt-synthesis-"), "scout: claims no Schedule is used.", 12, "deep", {
    priorFilesRead: ["src/webfetch/webfetch.ts"],
  });

  assert.match(scoutPrompt, /Dry-runs, inventory commands, grep counts, and partial logs are not live verification/i);
  assert.match(scoutPrompt, /Do not write memory candidates for transient pass\/fail/i);
  assert.match(scoutPrompt, /Before saying a feature, API, file, route, command, dependency, or pattern is absent/i);
  assert.match(plannerPrompt, /reconcile contradictions/i);
  assert.match(plannerPrompt, /do not concatenate raw upstream output/i);
});

test("buildSdkPrompt carries structured claim audit context without relying on wording", () => {
  const planner = readOnlyAgent("planner", "planning");
  const prompt = buildSdkPrompt(planner, "Synthesize final answer material.", tempDir("pi-chalin-prompt-claims-"), "Prior handoff text.", 12, "normal", {
    previousClaims: [{
      kind: "negative-claim",
      subject: "browser automation capability",
      summary: "Prior handoff says browser control is unavailable.",
      evidence: [],
      confidence: 0.44,
    }],
  } as never);

  assert.match(prompt, /Structured claim audit/i);
  assert.match(prompt, /browser automation capability/i);
  assert.match(prompt, /negative-claim/i);
});

test("workspace hygiene parser flags dirty generated files not declared in changedFiles", () => {
  const dirty = workspaceDirtyPathsFromStatus([
    " M src/auth/keycloak.ts",
    "?? .output/public/index.html",
    "?? package-lock.json",
    "?? .pi-chalin/runs/run.json",
    "R  old/name.ts -> src/new-name.ts",
  ].join("\n"));

  assert.deepEqual(dirty, [
    "src/auth/keycloak.ts",
    ".output/public/index.html",
    "package-lock.json",
    ".pi-chalin/runs/run.json",
    "src/new-name.ts",
  ]);
  assert.deepEqual(
    workspaceHygieneProblemsForDirtyPaths(dirty, ["src/auth/keycloak.ts", "src/new-name.ts"]),
    [".output/public/index.html", "package-lock.json"],
  );
});

test("workspace hygiene cleans only undeclared binary outputs that were not edited directly", () => {
  const cwd = tempDir("pi-chalin-hygiene-clean-");
  fs.mkdirSync(path.join(cwd, "src"), { recursive: true });
  fs.writeFileSync(path.join(cwd, "artifact"), Buffer.from([0xca, 0xfe, 0x00, 0x00]));
  fs.writeFileSync(path.join(cwd, "src", "new.ts"), "export const value = 1;\n");
  fs.writeFileSync(path.join(cwd, "touched-binary"), Buffer.from([0xca, 0xfe, 0x00, 0x01]));

  const dirty = workspaceDirtyEntriesFromStatus([
    "?? artifact",
    "?? src/new.ts",
    "?? touched-binary",
  ].join("\n"));

  assert.deepEqual(
    cleanTransientGeneratedWorkspaceOutputs(cwd, dirty, ["touched-binary"]),
    ["artifact"],
  );
  assert.equal(fs.existsSync(path.join(cwd, "artifact")), false);
  assert.equal(fs.existsSync(path.join(cwd, "src", "new.ts")), true);
  assert.equal(fs.existsSync(path.join(cwd, "touched-binary")), true);
});

test("reviewerHandoffNeedsRepair detects blocking implementation review gaps", () => {
  const verdictOutput = (verdict: unknown) => parseAgentOutput("reviewer", [
    "## Reviewer Verdict",
    JSON.stringify(verdict),
    "## Handoff",
    "- Structured reviewer contract.",
  ].join("\n"));
  const failing = verdictOutput({ verdict: "fail", blockingFindings: ["Implementation misses adjacent-token requirement."], missingCoverage: [], evidence: ["src/parser.c"], requiredRepair: "Patch parser." });
  const gap = verdictOutput({ verdict: "gap", blockingFindings: [], missingCoverage: ["Permanent tests omit EOF comments."], evidence: ["tests/test_parser.c"], requiredRepair: "Add test." });
  const passing = verdictOutput({
    verdict: "pass",
    blockingFindings: [],
    missingCoverage: [],
    evidence: [
      { kind: "reviewed-content", paths: ["src/parser.c"], summary: "Reviewed parser implementation." },
      { kind: "verification", command: "make test", status: "pass", result: "Exited 0." },
    ],
  });
  const legacyProse = parseAgentOutput("reviewer", "## Handoff\nVerdict: FAIL — legacy prose is not a structured contract.");

  assert.equal(reviewerHandoffNeedsRepair({ agent: "reviewer", status: "complete", output: failing }), true);
  assert.equal(reviewerHandoffNeedsRepair({ agent: "reviewer", status: "complete", output: gap }), true);
  assert.equal(reviewerHandoffNeedsRepair({ agent: "reviewer", status: "complete", output: passing }), false);
  assert.equal(reviewerHandoffNeedsRepair({ agent: "reviewer", status: "complete", output: legacyProse }), true);
  assert.match(legacyProse.warnings.join("\n"), /structured Reviewer Verdict/i);
  assert.equal(reviewerHandoffNeedsRepair({ agent: "worker", status: "complete", output: failing }), false);
});

test("reviewerHandoffNeedsRepair does not treat residual risks as repair blockers", () => {
  const passingWithResidualRisk = reviewerOutput("pass", {
    residualRisks: ["Optional external validation was unavailable."],
  });
  const contradictoryPassWithMissingCoverage = reviewerOutput("pass", {
    evidence: ["reviewed src/parser.c implementation changes", "make test exited 0"],
    missingCoverage: ["Required contract coverage is still absent."],
  });

  assert.equal(reviewerHandoffNeedsRepair({ agent: "reviewer", status: "complete", output: passingWithResidualRisk }, { expectsReviewedContent: true, expectsVerify: true }), false);
  assert.equal(reviewerHandoffNeedsRepair({ agent: "reviewer", status: "complete", output: contradictoryPassWithMissingCoverage }, { expectsReviewedContent: true, expectsVerify: true }), true);
});

test("reviewerHandoffNeedsRepair requires real verification evidence when verify is expected", () => {
  const weakPass = reviewerOutput("pass", {
    evidence: ["src/parser.c", "worker said tests pass"],
  });
  const realPass = reviewerOutput("pass", {
    evidence: [
      { kind: "reviewed-content", paths: ["src/parser.c"], summary: "Reviewed parser implementation." },
      { kind: "verification", command: "make test", status: "pass", result: "Exited 0." },
    ],
  });

  assert.equal(reviewerHandoffNeedsRepair({ agent: "reviewer", status: "complete", output: weakPass }, { expectsVerify: true }), true);
  assert.match(weakPass.warnings.join("\n"), /real verification evidence/i);
  assert.equal(reviewerHandoffNeedsRepair({ agent: "reviewer", status: "complete", output: realPass }, { expectsVerify: true }), false);
});

test("reviewerHandoffNeedsRepair requires structured reviewed file evidence for implementation pass verdicts", () => {
  const commandOnlyPass = reviewerOutput("pass", {
    evidence: ["make test exited 0"],
  });
  const commandWithPathPass = reviewerOutput("pass", {
    evidence: ["bun test test/runner.test.ts exited 0"],
  });
  const reportedPathPass = reviewerOutput("pass", {
    evidence: ["worker reported src/parser.c", "make test exited 0"],
  });
  const reviewedFilePass = reviewerOutput("pass", {
    evidence: ["reviewed src/parser.c parser changes", "make test exited 0"],
  });
  const reviewedWorkerFilePass = reviewerOutput("pass", {
    evidence: ["reviewed src/worker.ts implementation changes", "make test exited 0"],
  });
  const structuredPass = reviewerOutput("pass", {
    evidence: [
      { kind: "reviewed-content", paths: ["src/worker.ts"], summary: "Reviewed worker implementation." },
      { kind: "verification", command: "make test", status: "pass", result: "Exited 0." },
    ],
  });

  assert.equal(reviewerHandoffNeedsRepair({ agent: "reviewer", status: "complete", output: commandOnlyPass }, { expectsReviewedContent: true }), true);
  assert.match(commandOnlyPass.warnings.join("\n"), /reviewed files or content/i);
  assert.equal(reviewerHandoffNeedsRepair({ agent: "reviewer", status: "complete", output: commandWithPathPass }, { expectsReviewedContent: true }), true);
  assert.equal(reviewerHandoffNeedsRepair({ agent: "reviewer", status: "complete", output: reportedPathPass }, { expectsReviewedContent: true }), true);
  assert.equal(reviewerHandoffNeedsRepair({ agent: "reviewer", status: "complete", output: reviewedFilePass }, { expectsReviewedContent: true, expectsVerify: true }), true);
  assert.equal(reviewerHandoffNeedsRepair({ agent: "reviewer", status: "complete", output: reviewedWorkerFilePass }, { expectsReviewedContent: true, expectsVerify: true }), true);
  assert.equal(reviewerHandoffNeedsRepair({ agent: "reviewer", status: "complete", output: structuredPass }, { expectsReviewedContent: true, expectsVerify: true }), false);
});

test("reviewerHandoffNeedsRepair accepts structured object evidence with reviewed files and verification", () => {
  const output = parseAgentOutput("reviewer", [
    "## Reviewer Verdict",
    JSON.stringify({
      verdict: "pass",
      blockingFindings: [],
      missingCoverage: [],
      evidence: [
        { kind: "reviewed-content", paths: ["internal/auth/refresh.go", "src/auth/keycloak.ts"], summary: "Reviewed changed auth implementations." },
        { kind: "verification", command: "go test ./internal/auth/... && bun test", status: "pass", result: "Both commands exited 0." },
      ],
      residualRisks: ["Optional integration coverage can be expanded later."],
    }),
  ].join("\n"));

  assert.equal(reviewerHandoffNeedsRepair({ agent: "reviewer", status: "complete", output }, { expectsReviewedContent: true, expectsVerify: true }), false);
});

test("buildConflictResolverTask creates a bounded surgical conflict task", () => {
  const task = buildConflictResolverTask({
    agent: "worker-a",
    reason: "patch would not apply",
    patch: "diff --git a/a.txt b/a.txt\n+isolated writer change\n",
  });

  assert.match(task, /worker-a/);
  assert.match(task, /patch would not apply/);
  assert.match(task, /surgical/i);
  assert.match(task, /isolated writer change/);
  assert.match(task, /precise evidence and diffs/i);
});

test("applyConflictResolverRepair recovers a failed unit only with resolver mutation and verification evidence", () => {
  const route: RouteDecision = {
    kind: "multi-agent-dag",
    agents: ["worker", "reviewer"],
    risk: "medium",
    ambiguity: "low",
    needsMemory: false,
    needsArtifacts: true,
    expectedEffects: ["read", "write", "verify"],
    reason: "parallel implementation",
    plan: {
      kind: "dag",
      stages: [
        { id: "work", tasks: [{ agent: "worker", task: "Implement unit." }] },
        { id: "review", tasks: [{ agent: "reviewer", task: "Review unit." }] },
      ],
    },
  };
  const run = createRunState(route, tempDir("pi-chalin-conflict-repair-"));
  const failedStep = run.steps[0]!;
  failedStep.status = "failed";
  failedStep.error = "Worktree merge conflict: patch would not apply";
  failedStep.output = parseAgentOutput("worker", [
    "## Agent Handoff",
    JSON.stringify({
      summary: "Implemented isolated change.",
      changedFiles: ["src/auth.ts"],
      verification: ["bun test test/auth.test.ts exited 0"],
      risks: [],
    }),
  ].join("\n"));
  const resolverStep = {
    id: "conflict:step-1",
    agent: "conflict-resolver",
    task: "Resolve conflict.",
    status: "complete",
    workUnitId: failedStep.workUnitId,
    output: parseAgentOutput("conflict-resolver", [
      "## Agent Handoff",
      JSON.stringify({
        summary: "Applied the intended change in the primary worktree.",
        changedFiles: ["src/auth.ts"],
        verification: ["bun test test/auth.test.ts exited 0"],
        risks: [],
      }),
    ].join("\n")),
  } satisfies RunStepState;
  run.steps.push(resolverStep);

  const repaired = applyConflictResolverRepair(run, failedStep, resolverStep);

  assert.equal(repaired, true);
  assert.equal(failedStep.status, "complete");
  assert.equal(failedStep.error, undefined);
  assert.equal(failedStep.repairCycle, 1);
  assert.match(failedStep.output?.warnings.join("\n") ?? "", /Recovered by conflict-resolver\/conflict:step-1/);
  assert.equal(run.workUnits?.find((unit) => unit.id === failedStep.workUnitId)?.status, "complete");
  assert.equal(run.recoveryState?.failedStepId, undefined);
  assert.equal(run.recoveryState?.resumeKind, "none");
});

test("applyConflictResolverRepair refuses resolver handoffs without concrete mutation evidence", () => {
  const route: RouteDecision = {
    kind: "multi-agent-dag",
    agents: ["worker"],
    risk: "medium",
    ambiguity: "low",
    needsMemory: false,
    needsArtifacts: true,
    expectedEffects: ["read", "write", "verify"],
    reason: "parallel implementation",
    plan: { kind: "dag", stages: [{ id: "work", tasks: [{ agent: "worker", task: "Implement unit." }] }] },
  };
  const run = createRunState(route, tempDir("pi-chalin-conflict-no-evidence-"));
  const failedStep = run.steps[0]!;
  failedStep.status = "failed";
  failedStep.error = "Worktree merge conflict: patch would not apply";
  const resolverStep = {
    id: "conflict:step-1",
    agent: "conflict-resolver",
    task: "Resolve conflict.",
    status: "complete",
    output: parseAgentOutput("conflict-resolver", [
      "## Agent Handoff",
      JSON.stringify({
        summary: "Explained the conflict.",
        changedFiles: [],
        verification: [],
        risks: ["Needs a human decision."],
      }),
    ].join("\n")),
  } satisfies RunStepState;

  const repaired = applyConflictResolverRepair(run, failedStep, resolverStep);

  assert.equal(repaired, false);
  assert.equal(failedStep.status, "failed");
  assert.equal(failedStep.error, "Worktree merge conflict: patch would not apply");
});

test("MockWorkerRunner runs chain plans in order", async () => {
  const route: RouteDecision = {
    kind: "multi-agent-sequential",
    agents: ["scout", "planner"],
    risk: "medium",
    ambiguity: "low",
    needsMemory: false,
    needsArtifacts: true,
    reason: "test",
    plan: { kind: "sequential", steps: [{ agent: "scout", task: "scan" }, { agent: "planner", task: "plan" }] },
  };
  const run = await new MockWorkerRunner().run(route, { cwd: tempDir("pi-chalin-runner-"), agents: new Map() });
  assert.equal(run.status, "complete");
  assert.deepEqual(run.steps.map((step) => step.status), ["complete", "complete"]);
  assert.match(run.steps[1]?.output?.raw ?? "", /Previous handoff/);
});

test("MockWorkerRunner stops sequential routes after a failed writer step", async () => {
  const route: RouteDecision = {
    kind: "multi-agent-sequential",
    agents: ["writer", "reviewer"],
    risk: "medium",
    ambiguity: "low",
    needsMemory: false,
    needsArtifacts: true,
    expectedEffects: ["read", "write", "verify"],
    reason: "implementation route",
    plan: { kind: "sequential", steps: [{ agent: "writer", task: "implement" }, { agent: "reviewer", task: "review" }] },
  };
  const agents = new Map<string, AgentDefinition>([
    ["writer", agent("writer", ["edit-files"])],
    ["reviewer", { ...readOnlyAgent("reviewer", "review"), capabilities: ["inspect-files", "validate"] }],
  ]);

  const run = await new MockWorkerRunner().run(route, { cwd: tempDir("pi-chalin-sequential-failed-writer-"), agents });

  assert.equal(run.status, "failed");
  assert.equal(run.steps[0]?.status, "failed");
  assert.match(run.steps[0]?.error ?? "", /changedFiles/i);
  assert.equal(run.steps[1]?.status, "skipped");
  assert.match(run.steps[1]?.skipReason ?? "", /upstream .* failed/i);
});

test("MockWorkerRunner resumes reviewer FAIL/GAP with bounded repair cycles", async () => {
  const cwd = tempDir("pi-chalin-review-repair-chain-");
  const run = createRunState({
    kind: "multi-agent-sequential",
    agents: ["worker", "reviewer"],
    risk: "medium",
    ambiguity: "low",
    needsMemory: false,
    needsArtifacts: true,
    reason: "implementation route",
    plan: { kind: "sequential", steps: [{ agent: "worker", task: "implement" }, { agent: "reviewer", task: "review" }] },
  }, cwd, "Implement parser behavior and tests.");
  run.status = "paused";
  run.steps[0]!.status = "complete";
  run.steps[0]!.output = parseAgentOutput("worker", "## Handoff\nChanged: src/parser.c. Verification: `make test` exits 0.");
  run.steps[1]!.status = "complete";
  run.steps[1]!.output = reviewerOutput("fail", {
    blockingFindings: ["Tests miss EOF comments and adjacent-token behavior."],
    requiredRepair: "Add permanent coverage.",
  });

  const resumed = await new MockWorkerRunner().resume(run, { cwd, agents: new Map() });

  assert.equal(resumed.status, "complete");
  assert.deepEqual(resumed.steps.map((step) => step.agent), ["worker", "reviewer", "worker", "reviewer"]);
  assert.equal(resumed.steps[2]?.id, "review-repair-1-worker");
  assert.equal(resumed.steps[3]?.id, "review-repair-1-reviewer");
  assert.match(resumed.steps[2]?.task ?? "", /Read only the changed implementation\/test files/i);
  assert.match(resumed.steps[3]?.task ?? "", /Previous reviewer findings/i);
  assert.match(resumed.warnings.join("\n"), /queued repair cycle 1\/2/i);
});

test("DAG implementation review repair keeps target WorkUnit ownership", async () => {
  const cwd = tempDir("pi-chalin-dag-review-repair-ownership-");
  const route: RouteDecision = {
    kind: "multi-agent-dag",
    agents: ["worker", "reviewer", "context-builder"],
    risk: "medium",
    ambiguity: "low",
    needsMemory: false,
    needsArtifacts: true,
    expectedEffects: ["read", "write", "verify"],
    reason: "implementation route",
    plan: {
      kind: "dag",
      stages: [
        { id: "workers", tasks: [{ id: "feature", agent: "worker", task: "Implement bounded feature." }] },
        { id: "reviewers", tasks: [{ id: "feature-review", agent: "reviewer", task: "Review bounded feature." }] },
        { id: "aggregate", tasks: [{ id: "aggregate", agent: "context-builder", task: "Aggregate outcomes." }] },
      ],
    },
  };
  const run = createRunState(route, cwd, "Implement bounded feature and verify it.");
  const workerStep = run.steps[0]!;
  const reviewerStep = run.steps[1]!;
  const targetUnitId = workerStep.workUnitId!;
  reviewerStep.workUnitId = targetUnitId;
  const targetUnit = run.workUnits?.find((unit) => unit.id === targetUnitId);
  assert.ok(targetUnit);
  targetUnit!.reviewerStepId = reviewerStep.id;
  run.status = "paused";
  workerStep.status = "complete";
  workerStep.output = parseAgentOutput("worker", [
    "## Agent Handoff",
    JSON.stringify({ summary: "Implemented bounded feature.", changedFiles: ["src/parser.c"], verification: ["make test exited 0"], evidenceClaims: [], risks: [], nextActions: [] }),
  ].join("\n"));
  reviewerStep.status = "complete";
  reviewerStep.output = reviewerOutput("gap", {
    missingCoverage: ["Permanent coverage misses a required edge."],
    requiredRepair: "Add focused regression coverage.",
  });

  const resumed = await new MockWorkerRunner().resume(run, { cwd, agents: new Map() });
  const repairWorker = resumed.steps.find((step) => step.id === "review-repair-1-worker:step-1");
  const repairReviewer = resumed.steps.find((step) => step.id === "review-repair-1-reviewer:step-1");

  assert.equal(resumed.status, "complete");
  assert.equal(repairWorker?.stageId, "review-repair-1-worker");
  assert.equal(repairReviewer?.stageId, "review-repair-1-reviewer");
  assert.equal(repairWorker?.workUnitId, targetUnitId);
  assert.equal(repairReviewer?.workUnitId, targetUnitId);
  assert.deepEqual(repairWorker?.dependencies, [reviewerStep.id]);
  assert.deepEqual(repairReviewer?.dependencies, [repairWorker?.id]);
  assert.equal(resumed.mutationLedger?.find((entry) => entry.stepId === repairWorker?.id)?.unitId, targetUnitId);
  assert.equal(resumed.verificationLedger?.find((entry) => entry.stepId === repairReviewer?.id)?.unitId, targetUnitId);
});

test("DAG implementation repair maps reviewer gaps to the matching parallel worker unit", async () => {
  const cwd = tempDir("pi-chalin-dag-review-repair-parallel-unit-");
  const route: RouteDecision = {
    kind: "multi-agent-dag",
    agents: ["worker", "worker", "reviewer", "reviewer", "context-builder"],
    risk: "medium",
    ambiguity: "low",
    needsMemory: false,
    needsArtifacts: true,
    expectedEffects: ["read", "write", "verify"],
    reason: "parallel implementation route",
    plan: {
      kind: "dag",
      stages: [
        {
          id: "workers",
          tasks: [
            { id: "unit-a", agent: "worker", task: "Implement unit A." },
            { id: "unit-b", agent: "worker", task: "Implement unit B." },
          ],
        },
        {
          id: "reviewers",
          tasks: [
            { id: "unit-a-review", agent: "reviewer", task: "Review unit A." },
            { id: "unit-b-review", agent: "reviewer", task: "Review unit B." },
          ],
        },
        { id: "aggregate", tasks: [{ id: "aggregate", agent: "context-builder", task: "Aggregate outcomes." }] },
      ],
    },
  };
  const run = createRunState(route, cwd, "Implement two independent units and verify them.");
  const [workerA, workerB, reviewerA, reviewerB] = run.steps;
  assert.ok(workerA?.workUnitId);
  assert.ok(workerB?.workUnitId);
  reviewerA!.workUnitId = workerA!.workUnitId;
  reviewerB!.workUnitId = workerB!.workUnitId;
  run.status = "paused";
  workerA!.status = "complete";
  workerA!.output = parseAgentOutput("worker", `## Agent Handoff\n${JSON.stringify({ summary: "Implemented A.", changedFiles: ["src/a.ts"], verification: ["test A pass"], evidenceClaims: [], risks: [], nextActions: [] })}`);
  workerB!.status = "complete";
  workerB!.output = parseAgentOutput("worker", `## Agent Handoff\n${JSON.stringify({ summary: "Implemented B.", changedFiles: ["src/b.ts"], verification: ["test B pass"], evidenceClaims: [], risks: [], nextActions: [] })}`);
  reviewerA!.status = "complete";
  reviewerA!.output = reviewerOutput("gap", {
    missingCoverage: ["Unit A misses an edge case."],
    requiredRepair: "Repair unit A only.",
  });
  reviewerB!.status = "complete";
  reviewerB!.output = reviewerOutput("pass");

  const resumed = await new MockWorkerRunner().resume(run, { cwd, agents: new Map() });
  const repairWorker = resumed.steps.find((step) => step.id === "review-repair-1-worker:step-1");
  const repairReviewer = resumed.steps.find((step) => step.id === "review-repair-1-reviewer:step-1");

  assert.equal(resumed.status, "complete");
  assert.equal(repairWorker?.workUnitId, workerA!.workUnitId);
  assert.notEqual(repairWorker?.workUnitId, workerB!.workUnitId);
  assert.equal(repairReviewer?.workUnitId, workerA!.workUnitId);
  assert.deepEqual(repairWorker?.dependencies, [reviewerA!.id]);
});

test("DAG implementation repair maps review-unit gaps by structured repair files", async () => {
  const cwd = tempDir("pi-chalin-dag-review-repair-file-owner-");
  const route: RouteDecision = {
    kind: "multi-agent-dag",
    agents: ["worker", "worker", "reviewer", "reviewer", "context-builder"],
    risk: "medium",
    ambiguity: "low",
    needsMemory: false,
    needsArtifacts: true,
    expectedEffects: ["read", "write", "verify"],
    reason: "parallel implementation route with independent review units",
    plan: {
      kind: "dag",
      stages: [
        {
          id: "workers",
          tasks: [
            { id: "auth", agent: "worker", task: "Implement auth." },
            { id: "billing", agent: "worker", task: "Implement billing." },
          ],
        },
        {
          id: "reviewers",
          tasks: [
            { id: "auth-review", agent: "reviewer", task: "Review auth." },
            { id: "billing-review", agent: "reviewer", task: "Review billing." },
          ],
        },
        { id: "aggregate", tasks: [{ id: "aggregate", agent: "context-builder", task: "Aggregate outcomes." }] },
      ],
    },
  };
  const run = createRunState(route, cwd, "Implement two independent units and verify them.");
  const [workerA, workerB, reviewerA, reviewerB] = run.steps;
  assert.ok(workerA?.workUnitId);
  assert.ok(workerB?.workUnitId);
  assert.notEqual(reviewerA?.workUnitId, workerA?.workUnitId);
  run.status = "paused";
  workerA!.status = "complete";
  workerA!.output = parseAgentOutput("worker", `## Agent Handoff\n${JSON.stringify({ summary: "Implemented auth.", changedFiles: ["src/auth.ts"], verification: ["auth tests pass"], evidenceClaims: [], risks: [], nextActions: [] })}`);
  workerB!.status = "complete";
  workerB!.output = parseAgentOutput("worker", `## Agent Handoff\n${JSON.stringify({ summary: "Implemented billing.", changedFiles: ["src/billing.ts"], verification: ["billing tests pass"], evidenceClaims: [], risks: [], nextActions: [] })}`);
  reviewerA!.status = "complete";
  reviewerA!.output = reviewerOutput("gap", {
    blockingFindings: ["src/auth.ts: Auth edge case is missing."],
    missingCoverage: ["Auth edge case lacks coverage."],
    requiredRepair: "Repair auth behavior.",
  });
  reviewerB!.status = "complete";
  reviewerB!.output = reviewerOutput("pass");

  const resumed = await new MockWorkerRunner().resume(run, { cwd, agents: new Map() });
  const repairWorker = resumed.steps.find((step) => step.id === "review-repair-1-worker:step-1");
  const repairReviewer = resumed.steps.find((step) => step.id === "review-repair-1-reviewer:step-1");

  assert.equal(resumed.status, "complete");
  assert.equal(repairWorker?.workUnitId, workerA!.workUnitId);
  assert.notEqual(repairWorker?.workUnitId, workerB!.workUnitId);
  assert.equal(repairReviewer?.workUnitId, workerA!.workUnitId);
  assert.deepEqual(repairWorker?.dependencies, [reviewerA!.id]);
});

test("DAG implementation repair creates a bounded repair WorkUnit for cross-unit reviewer findings", async () => {
  const cwd = tempDir("pi-chalin-dag-cross-unit-repair-");
  const route: RouteDecision = {
    kind: "multi-agent-dag",
    agents: ["worker", "reviewer"],
    risk: "medium",
    ambiguity: "low",
    needsMemory: false,
    needsArtifacts: true,
    expectedEffects: ["read", "write", "verify"],
    reason: "bounded implementation route",
    plan: {
      kind: "dag",
      stages: [
        { id: "implement", tasks: [{ id: "http", agent: "worker", task: "Implement HTTP surface." }] },
        { id: "review", tasks: [{ id: "http-review", agent: "reviewer", task: "Review HTTP surface." }] },
      ],
    },
  };
  const run = createRunState(route, cwd, "Implement a bounded feature and tests.");
  const worker = run.steps[0]!;
  const reviewer = run.steps[1]!;
  const baseUnit = run.workUnits?.find((unit) => unit.id === worker.workUnitId);
  assert.ok(baseUnit);
  baseUnit!.files = ["src/handler.ts"];
  reviewer.workUnitId = baseUnit!.id;
  run.status = "paused";
  worker.status = "complete";
  worker.output = parseAgentOutput("worker", `## Agent Handoff\n${JSON.stringify({ summary: "Implemented HTTP surface.", changedFiles: ["src/handler.ts"], verification: ["test pass"], evidenceClaims: [], risks: [], nextActions: [] })}`);
  reviewer.status = "complete";
  reviewer.output = parseAgentOutput("reviewer", [
    "## Agent Handoff",
    JSON.stringify({ summary: "Review found cross-boundary gaps.", changedFiles: ["src/handler.ts"], verification: ["test fail"], evidenceClaims: [], risks: [], nextActions: ["Repair blocking findings."] }),
    "## Reviewer Verdict",
    JSON.stringify({
      verdict: "gap",
      blockingFindings: [{ file: "src/core.ts", summary: "Core ownership check is missing." }],
      missingCoverage: [{ file: "tests/handler.test.ts", summary: "Missing regression coverage." }],
      evidence: [{ kind: "reviewed-content", paths: ["src/handler.ts", "src/core.ts"], summary: "Reviewed implementation surfaces." }],
      requiredRepair: "Repair the cross-boundary security gap and add regression coverage.",
    }),
  ].join("\n"));

  const resumed = await new MockWorkerRunner().resume(run, { cwd, agents: new Map() });
  const repairUnit = resumed.workUnits?.find((unit) => unit.kind === "repair");
  const repairWorker = resumed.steps.find((step) => step.id === "review-repair-1-worker:step-1");
  const repairReviewer = resumed.steps.find((step) => step.id === "review-repair-1-reviewer:step-1");

  assert.equal(resumed.status, "complete");
  assert.ok(repairUnit);
  assert.notEqual(repairUnit!.id, baseUnit!.id);
  assert.deepEqual(repairUnit!.files, ["src/handler.ts", "src/core.ts", "tests/handler.test.ts"]);
  assert.equal(repairWorker?.workUnitId, repairUnit!.id);
  assert.equal(repairReviewer?.workUnitId, repairUnit!.id);
  assert.match(repairWorker?.task ?? "", /Repair WorkUnit scope/i);
  assert.match(resumed.warnings.join("\n"), /Created cross-WorkUnit repair scope/i);
});

test("DAG worker WorkUnit scope gaps queue bounded repair instead of finalizing as residual risk", async () => {
  const cwd = tempDir("pi-chalin-dag-worker-scope-gap-repair-");
  const route: RouteDecision = {
    kind: "multi-agent-dag",
    agents: ["worker"],
    risk: "medium",
    ambiguity: "low",
    needsMemory: false,
    needsArtifacts: true,
    expectedEffects: ["read", "write", "verify"],
    reason: "bounded implementation route",
    plan: {
      kind: "dag",
      stages: [
        { id: "tests", tasks: [{ id: "auth-tests", agent: "worker", task: "Write bounded tests." }] },
      ],
    },
  };
  const run = createRunState(route, cwd, "Implement behavior and tests.");
  const worker = run.steps[0]!;
  const baseUnit = run.workUnits?.find((unit) => unit.id === worker.workUnitId);
  assert.ok(baseUnit);
  baseUnit!.files = ["tests/auth.test.ts"];
  run.status = "paused";
  worker.status = "complete";
  worker.metrics = stepMetrics({ policyViolations: ["work_unit_scope_gap:src/auth.ts"] });
  worker.output = parseAgentOutput("worker", `## Agent Handoff\n${JSON.stringify({
    summary: "Tests exposed an implementation gap that needs a source repair.",
    changedFiles: ["tests/auth.test.ts"],
    verification: ["test command identifies source behavior gap"],
    evidenceClaims: [],
    risks: ["Source behavior remains incomplete until the scope gap is repaired."],
    nextActions: ["Patch src/auth.ts and rerun the focused tests."],
  })}`);

  const resumed = await new MockWorkerRunner().resume(run, { cwd, agents: new Map() });
  const repairUnit = resumed.workUnits?.find((unit) => unit.kind === "repair");
  const repairWorker = resumed.steps.find((step) => step.id === "review-repair-1-worker:step-1");
  const repairReviewer = resumed.steps.find((step) => step.id === "review-repair-1-reviewer:step-1");

  assert.equal(resumed.status, "complete");
  assert.ok(repairUnit);
  assert.deepEqual(repairUnit!.files, ["tests/auth.test.ts", "src/auth.ts"]);
  assert.equal(repairWorker?.workUnitId, repairUnit!.id);
  assert.equal(repairReviewer?.workUnitId, repairUnit!.id);
  assert.match(repairWorker?.task ?? "", /Repair the worker-reported WorkUnit scope gap/i);
  assert.match(resumed.warnings.join("\n"), /Worker reported WorkUnit scope gap/);
});

test("MockWorkerRunner re-runs reviewer when PASS lacks contractual evidence", async () => {
  const cwd = tempDir("pi-chalin-review-pass-content-evidence-");
  const run = createRunState({
    kind: "multi-agent-sequential",
    agents: ["worker", "reviewer"],
    risk: "medium",
    ambiguity: "low",
    needsMemory: false,
    needsArtifacts: true,
    expectedEffects: ["read", "write", "verify"],
    reason: "implementation route",
    plan: { kind: "sequential", steps: [{ agent: "worker", task: "implement" }, { agent: "reviewer", task: "review" }] },
  }, cwd, "Implement parser behavior and verify it.");
  run.status = "paused";
  run.steps[0]!.status = "complete";
  run.steps[0]!.output = parseAgentOutput("worker", "## Handoff\nChanged: src/parser.c. Verification: `make test` exits 0.");
  run.steps[1]!.status = "complete";
  run.steps[1]!.output = reviewerOutput("pass", {
    evidence: ["make test exited 0"],
  });

  const resumed = await new MockWorkerRunner().resume(run, { cwd, agents: new Map() });

  assert.equal(resumed.status, "complete");
  assert.deepEqual(resumed.steps.map((step) => step.agent), ["worker", "reviewer", "reviewer"]);
  assert.match(resumed.steps[1]?.output?.warnings.join("\n") ?? "", /reviewed files or content/i);
  assert.match(resumed.steps[2]?.task ?? "", /Re-audit the previous implementation review evidence/i);
  assert.match(resumed.steps[2]?.task ?? "", /Known prior verification evidence from run ledgers/i);
  assert.match(resumed.steps[2]?.task ?? "", /make test exited 0/i);
  assert.match(resumed.warnings.join("\n"), /reviewer pass lacked required evidence; queued reviewer evidence repair cycle 1\/2/i);
});

test("MockWorkerRunner re-runs reviewer-only routes when structured verdict is missing", async () => {
  const cwd = tempDir("pi-chalin-review-only-missing-verdict-");
  const run = createRunState({
    kind: "multi-agent-sequential",
    agents: ["scout", "reviewer"],
    risk: "medium",
    ambiguity: "low",
    needsMemory: false,
    needsArtifacts: true,
    expectedEffects: ["read", "verify"],
    reason: "read-only review route",
    plan: { kind: "sequential", steps: [{ agent: "scout", task: "inspect config" }, { agent: "reviewer", task: "review config" }] },
  }, cwd, "Review test commands without mutating files.");
  run.status = "paused";
  run.steps[0]!.status = "complete";
  run.steps[0]!.output = parseAgentOutput("scout", `## Agent Handoff\n${JSON.stringify({ summary: "Found configs.", changedFiles: [], verification: ["read package.json"], evidenceClaims: [], risks: [], nextActions: [] })}`);
  run.steps[1]!.status = "complete";
  run.steps[1]!.output = parseAgentOutput("reviewer", `## Agent Handoff\n${JSON.stringify({ summary: "Review found command gaps.", changedFiles: [], verification: ["read package.json"], evidenceClaims: [], risks: ["Missing lockfile."], nextActions: ["Report gap."] })}`);

  const resumed = await new MockWorkerRunner().resume(run, { cwd, agents: new Map() });
  const repairReviewer = resumed.steps.find((step) => step.id === "review-repair-1-reviewer");

  assert.equal(resumed.status, "complete");
  assert.deepEqual(resumed.steps.map((step) => step.agent), ["scout", "reviewer", "reviewer"]);
  assert.ok(repairReviewer);
  assert.equal(repairReviewer?.workUnitId, run.steps[1]!.workUnitId);
  assert.match(repairReviewer?.task ?? "", /Re-audit the previous implementation review evidence/i);
  assert.match(resumed.warnings.join("\n"), /Reviewer omitted the structured verdict contract; queued reviewer evidence repair cycle 1\/2/i);
});

test("MockWorkerRunner classifies exhausted reviewer evidence repair as missing evidence", async () => {
  const cwd = tempDir("pi-chalin-review-evidence-max-");
  const run = createRunState({
    kind: "multi-agent-sequential",
    agents: ["worker", "reviewer", "worker", "reviewer", "reviewer"],
    risk: "medium",
    ambiguity: "low",
    needsMemory: false,
    needsArtifacts: true,
    expectedEffects: ["read", "write", "verify"],
    reason: "implementation route",
    plan: {
      kind: "sequential",
      steps: [
        { agent: "worker", task: "implement" },
        { agent: "reviewer", task: "review" },
        { agent: "worker", task: "repair once" },
        { agent: "reviewer", task: "review repair once" },
        { agent: "reviewer", task: "re-audit review evidence" },
      ],
    },
  }, cwd, "Implement parser behavior and verify it.");
  const ids = ["step-1", "step-2", "review-repair-1-worker", "review-repair-1-reviewer", "review-repair-2-reviewer"];
  run.status = "paused";
  run.steps.forEach((step, index) => {
    step.id = ids[index]!;
    step.status = "complete";
  });
  run.steps[0]!.output = parseAgentOutput("worker", "## Handoff\nChanged: src/parser.c. Verification: `make test` exits 0.");
  run.steps[1]!.output = reviewerOutput("gap", {
    missingCoverage: ["Coverage is insufficient."],
    requiredRepair: "Add coverage.",
  });
  run.steps[2]!.output = parseAgentOutput("worker", "## Handoff\nChanged: src/parser.c, tests/parser.test.c. Verification: `make test` exits 0.");
  run.steps[3]!.output = reviewerOutput("pass", {
    evidence: ["src/parser.c reviewed", "tests/parser.test.c reviewed"],
  });
  run.steps[4]!.output = reviewerOutput("pass", {
    evidence: ["src/parser.c reviewed", "tests/parser.test.c reviewed"],
  });

  const resumed = await new MockWorkerRunner().resume(run, { cwd, agents: new Map() });
  const finalStep = resumed.steps.at(-1);
  const finalEntry = resumed.verificationLedger?.find((entry) => entry.stepId === "review-repair-2-reviewer");

  assert.equal(resumed.status, "failed");
  assert.equal(finalStep?.status, "failed");
  assert.equal(finalStep?.reviewGate, "missing-evidence");
  assert.equal(finalEntry?.status, "gap");
  assert.match(finalStep?.error ?? "", /missing required review evidence/i);
  assert.doesNotMatch(finalStep?.error ?? "", /blocking FAIL\/GAP/i);
});

test("MockWorkerRunner records reviewer missing verdict as verification gap", async () => {
  const cwd = tempDir("pi-chalin-review-missing-verdict-ledger-");
  const run = createRunState({
    kind: "multi-agent-sequential",
    agents: ["worker", "reviewer"],
    risk: "medium",
    ambiguity: "low",
    needsMemory: false,
    needsArtifacts: true,
    expectedEffects: ["read", "write", "verify"],
    reason: "implementation route",
    plan: { kind: "sequential", steps: [{ agent: "worker", task: "implement" }, { agent: "reviewer", task: "review" }] },
  }, cwd, "Implement parser behavior and verify it.");
  run.status = "paused";
  run.steps[0]!.status = "complete";
  run.steps[0]!.output = parseAgentOutput("worker", [
    "## Agent Handoff",
    JSON.stringify({ summary: "Implemented parser.", changedFiles: ["src/parser.c"], verification: ["make test exited 0"], evidenceClaims: [], risks: [], nextActions: [] }),
  ].join("\n"));
  run.steps[1]!.status = "complete";
  run.steps[1]!.output = parseAgentOutput("reviewer", [
    "## Agent Handoff",
    JSON.stringify({
      summary: "Review found a missing edge case despite green verification.",
      changedFiles: ["src/parser.c"],
      verification: ["make test exited 0"],
      evidenceClaims: [],
      risks: ["Missing EOF coverage."],
      nextActions: ["Add EOF coverage."],
    }),
  ].join("\n"));

  const resumed = await new MockWorkerRunner().resume(run, { cwd, agents: new Map() });
  const reviewEntry = resumed.verificationLedger?.find((entry) => entry.stepId === "step-2");
  const repairWorker = resumed.steps.find((step) => step.id === "review-repair-1-worker");
  const repairReviewer = resumed.steps.find((step) => step.id === "review-repair-1-reviewer");

  assert.equal(reviewEntry?.status, "gap");
  assert.equal(resumed.steps[1]?.reviewGate, "gap");
  assert.equal(repairWorker, undefined);
  assert.equal(repairReviewer?.agent, "reviewer");
  assert.match(resumed.warnings.join("\n"), /omitted the structured verdict contract; queued reviewer evidence repair cycle 1\/2/i);
});

test("MockWorkerRunner ignores out-of-scope gaps from reviewer evidence repair", async () => {
  const cwd = tempDir("pi-chalin-review-evidence-out-of-scope-");
  const run = createRunState({
    kind: "multi-agent-sequential",
    agents: ["worker", "reviewer", "reviewer"],
    risk: "medium",
    ambiguity: "low",
    needsMemory: false,
    needsArtifacts: true,
    expectedEffects: ["read", "write", "verify"],
    reason: "implementation route",
    plan: { kind: "sequential", steps: [{ agent: "worker", task: "implement W1" }, { agent: "reviewer", task: "review W1" }, { agent: "reviewer", task: "repair W1 review evidence" }] },
  }, cwd, "Implement independent work units.");
  run.status = "paused";
  run.workUnits = [{
    id: "unit-w1",
    title: "Go auth",
    kind: "implementation",
    status: "complete",
    scope: ["Harden RefreshURL."],
    files: ["internal/auth/refresh.go", "internal/auth/refresh_test.go"],
    dependencies: [],
    expectedEffects: ["read", "write", "verify"],
    acceptanceCriteria: ["go test ./internal/auth/... passes"],
    createdFrom: "fanout",
  }];
  const ids = ["step-1", "step-2", "review-repair-1-reviewer"];
  run.steps.forEach((step, index) => {
    step.id = ids[index]!;
    step.workUnitId = "unit-w1";
    step.status = "complete";
  });
  run.steps[0]!.output = parseAgentOutput("worker", [
    "## Agent Handoff",
    JSON.stringify({ summary: "Implemented W1.", changedFiles: ["internal/auth/refresh.go", "internal/auth/refresh_test.go"], verification: ["go test ./internal/auth/... passed"], evidenceClaims: [], risks: [], nextActions: [] }),
  ].join("\n"));
  run.steps[1]!.output = parseAgentOutput("reviewer", "## Agent Handoff\nW1 looks good but reviewer omitted structured verdict.");
  run.steps[2]!.output = reviewerOutput("gap", {
    missingCoverage: ["cmd/api/main.go has no behavior", "README.md has no documentation"],
    evidence: [
      { kind: "verification", command: "go test ./internal/auth/...", status: "pass", result: "PASS" },
      { kind: "reviewed-content", paths: ["internal/auth/refresh.go", "internal/auth/refresh_test.go"], summary: "W1 implementation reviewed and correct." },
      { kind: "verification", command: "go test ./cmd/api/...", status: "fail", result: "no test files" },
      { kind: "reviewed-content", paths: ["cmd/api/main.go", "README.md"], summary: "Unrelated pending units are incomplete." },
    ],
  });

  const resumed = await new MockWorkerRunner().resume(run, { cwd, agents: new Map() });
  const secondRepairWorker = resumed.steps.find((step) => step.id === "review-repair-2-worker");
  const evidenceRepair = resumed.steps.find((step) => step.id === "review-repair-1-reviewer");

  assert.equal(secondRepairWorker, undefined);
  assert.equal(evidenceRepair?.output?.reviewerVerdict?.verdict, "pass");
  assert.deepEqual(evidenceRepair?.output?.reviewerVerdict?.missingCoverage, []);
  assert.match(resumed.warnings.join("\n"), /out-of-scope gap/i);
});

test("verification ledger records handoff risks separately from blocking gaps", async () => {
  const cwd = tempDir("pi-chalin-ledger-risks-");
  const run = createRunState({
    kind: "multi-agent-sequential",
    agents: ["worker"],
    risk: "medium",
    ambiguity: "low",
    needsMemory: false,
    needsArtifacts: true,
    expectedEffects: ["read", "write", "verify"],
    reason: "implementation route",
    plan: { kind: "sequential", steps: [{ agent: "worker", task: "implement" }] },
  }, cwd, "Implement parser behavior and verify it.");
  run.status = "paused";
  run.steps[0]!.status = "complete";
  run.steps[0]!.output = parseAgentOutput("worker", [
    "## Agent Handoff",
    JSON.stringify({
      summary: "Implemented parser behavior.",
      changedFiles: ["src/parser.c"],
      verification: ["make test exited 0"],
      evidenceClaims: [],
      risks: ["Optional broader integration validation is not available locally."],
      nextActions: [],
    }),
  ].join("\n"));

  const resumed = await new MockWorkerRunner().resume(run, { cwd, agents: new Map() });
  const entry = resumed.verificationLedger?.find((candidate) => candidate.stepId === "step-1");

  assert.equal(entry?.status, "pass");
  assert.deepEqual(entry?.gaps, []);
  assert.deepEqual(entry?.risks, ["Optional broader integration validation is not available locally."]);
});

test("MockWorkerRunner repairs implementation routes that changed code without permanent tests", async () => {
  const cwd = tempDir("pi-chalin-review-permanent-tests-");
  const run = createRunState({
    kind: "multi-agent-sequential",
    agents: ["worker", "reviewer"],
    risk: "medium",
    ambiguity: "low",
    needsMemory: false,
    needsArtifacts: true,
    reason: "implementation route",
    plan: { kind: "sequential", steps: [{ agent: "worker", task: "implement" }, { agent: "reviewer", task: "review" }] },
  }, cwd, "Implement parser behavior and keep make test passing.");
  run.status = "paused";
  run.steps[0]!.status = "complete";
  run.steps[0]!.output = parseAgentOutput("worker", "## Handoff\nChanged: src/parser.c. Verification: `make test` exits 0.");
  run.steps[0]!.metrics = stepMetrics({ filesRead: ["src/parser.c", "tests/test_parser.c"], filesTouched: ["src/parser.c"] });
  run.steps[1]!.status = "complete";
  run.steps[1]!.output = reviewerOutput("pass");
  run.steps[1]!.metrics = stepMetrics({ filesRead: ["src/parser.c", "tests/test_parser.c"] });

  const resumed = await new MockWorkerRunner().resume(run, { cwd, agents: new Map() });

  assert.equal(resumed.status, "complete");
  assert.deepEqual(resumed.steps.map((step) => step.agent), ["worker", "reviewer", "worker", "reviewer"]);
  assert.equal(resumed.steps[2]?.id, "review-repair-1-worker");
  assert.match(resumed.steps[2]?.task ?? "", /permanent runner-discoverable tests/i);
  assert.match(resumed.steps[2]?.task ?? "", /narrower step wording that prohibited tests/i);
  assert.match(resumed.warnings.join("\n"), /without permanent test coverage; queued repair cycle 1\/2/i);
});

test("MockWorkerRunner allows no-test implementation only when tests changed or user forbids them", async () => {
  const withTestEditCwd = tempDir("pi-chalin-review-tests-edited-");
  const withTestEdit = createRunState({
    kind: "multi-agent-sequential",
    agents: ["worker", "reviewer"],
    risk: "medium",
    ambiguity: "low",
    needsMemory: false,
    needsArtifacts: true,
    reason: "implementation route",
    plan: { kind: "sequential", steps: [{ agent: "worker", task: "implement" }, { agent: "reviewer", task: "review" }] },
  }, withTestEditCwd, "Implement parser behavior.");
  withTestEdit.status = "paused";
  withTestEdit.steps[0]!.status = "complete";
  withTestEdit.steps[0]!.output = parseAgentOutput("worker", "## Handoff\nChanged: src/parser.c, tests/test_parser.c. Verification: `make test` exits 0.");
  withTestEdit.steps[0]!.metrics = stepMetrics({ filesRead: ["src/parser.c", "tests/test_parser.c"], filesTouched: ["src/parser.c", "tests/test_parser.c"] });
  withTestEdit.steps[1]!.status = "complete";
  withTestEdit.steps[1]!.output = reviewerOutput("pass");
  withTestEdit.steps[1]!.metrics = stepMetrics({ filesRead: ["src/parser.c", "tests/test_parser.c"] });

  const resumedWithTestEdit = await new MockWorkerRunner().resume(withTestEdit, { cwd: withTestEditCwd, agents: new Map() });
  assert.deepEqual(resumedWithTestEdit.steps.map((step) => step.agent), ["worker", "reviewer"]);

  const forbiddenCwd = tempDir("pi-chalin-review-tests-forbidden-");
  const forbidden = createRunState({
    kind: "multi-agent-sequential",
    agents: ["worker", "reviewer"],
    risk: "medium",
    ambiguity: "low",
    needsMemory: false,
    needsArtifacts: true,
    reason: "implementation route",
    plan: { kind: "sequential", steps: [{ agent: "worker", task: "implement" }, { agent: "reviewer", task: "review" }] },
  }, forbiddenCwd, "Do not edit tests; implement the parser fix only.");
  forbidden.status = "paused";
  forbidden.steps[0]!.status = "complete";
  forbidden.steps[0]!.output = parseAgentOutput("worker", "## Handoff\nChanged: src/parser.c. Verification: `make test` exits 0.");
  forbidden.steps[0]!.metrics = stepMetrics({ filesRead: ["src/parser.c", "tests/test_parser.c"], filesTouched: ["src/parser.c"] });
  forbidden.steps[1]!.status = "complete";
  forbidden.steps[1]!.output = reviewerOutput("pass");
  forbidden.steps[1]!.metrics = stepMetrics({ filesRead: ["src/parser.c", "tests/test_parser.c"] });

  const resumedForbidden = await new MockWorkerRunner().resume(forbidden, { cwd: forbiddenCwd, agents: new Map() });
  assert.deepEqual(resumedForbidden.steps.map((step) => step.agent), ["worker", "reviewer"]);
});

test("MockWorkerRunner fails instead of finalizing after repeated reviewer repair gaps", async () => {
  const cwd = tempDir("pi-chalin-review-repair-max-");
  const run = createRunState({
    kind: "multi-agent-sequential",
    agents: ["worker", "reviewer", "worker", "reviewer", "worker", "reviewer"],
    risk: "medium",
    ambiguity: "low",
    needsMemory: false,
    needsArtifacts: true,
    reason: "implementation route",
    plan: {
      kind: "sequential",
      steps: [
        { agent: "worker", task: "implement" },
        { agent: "reviewer", task: "review" },
        { agent: "worker", task: "repair once" },
        { agent: "reviewer", task: "review repair once" },
        { agent: "worker", task: "repair twice" },
        { agent: "reviewer", task: "review repair twice" },
      ],
    },
  }, cwd, "Implement parser behavior and tests.");
  const ids = ["step-1", "step-2", "review-repair-1-worker", "review-repair-1-reviewer", "review-repair-2-worker", "review-repair-2-reviewer"];
  run.status = "paused";
  run.steps.forEach((step, index) => {
    step.id = ids[index]!;
    step.status = "complete";
    step.output = parseAgentOutput(step.agent, step.agent === "reviewer"
      ? [
        "## Handoff",
        "- Structured reviewer handoff.",
        "## Reviewer Verdict",
        JSON.stringify({
          verdict: "fail",
          blockingFindings: ["Required parser behavior is missing."],
          missingCoverage: [],
          evidence: ["src/parser.c"],
          requiredRepair: "Repair parser behavior.",
        }),
      ].join("\n")
      : "## Handoff\nChanged: src/parser.c. Verification: `make test` exits 0.");
  });

  const resumed = await new MockWorkerRunner().resume(run, { cwd, agents: new Map() });

  assert.equal(resumed.status, "failed");
  assert.equal(resumed.steps.at(-1)?.status, "failed");
  assert.match(resumed.steps.at(-1)?.error ?? "", /after 2 repair cycle/i);
  assert.match(resumed.warnings.join("\n"), /Stopping instead of finalizing incomplete routed implementation/i);
});

test("MockWorkerRunner queues reviewer repair stages for DAG implementation routes", async () => {
  const cwd = tempDir("pi-chalin-review-repair-dag-");
  const run = createRunState({
    kind: "multi-agent-dag",
    agents: ["worker", "reviewer"],
    risk: "medium",
    ambiguity: "low",
    needsMemory: false,
    needsArtifacts: true,
    reason: "dag implementation route",
    plan: {
      kind: "dag",
      stages: [
        { id: "implement", tasks: [{ agent: "worker", task: "implement" }] },
        { id: "review", tasks: [{ agent: "reviewer", task: "review" }] },
      ],
    },
  }, cwd, "Implement parser behavior and tests.");
  run.status = "paused";
  run.steps[0]!.status = "complete";
  run.steps[0]!.output = parseAgentOutput("worker", "## Handoff\nChanged: src/parser.c. Verification: `make test` exits 0.");
  run.steps[1]!.status = "complete";
  run.steps[1]!.output = reviewerOutput("gap", {
    missingCoverage: ["Coverage is insufficient for EOF comments."],
    requiredRepair: "Add EOF coverage.",
  });

  const resumed = await new MockWorkerRunner().resume(run, { cwd, agents: new Map() });

  assert.equal(resumed.status, "complete");
  assert.deepEqual(resumed.route.plan?.kind === "dag" ? resumed.route.plan.stages.map((stage) => stage.id) : [], [
    "implement",
    "review",
    "review-repair-1-worker",
    "review-repair-1-reviewer",
  ]);
  assert.deepEqual(resumed.steps.map((step) => step.id), [
    "implement:step-1",
    "review:step-1",
    "review-repair-1-worker:step-1",
    "review-repair-1-reviewer:step-1",
  ]);
  assert.match(resumed.steps[2]?.task ?? "", /check workspace status and clean transient generated outputs/i);
  assert.match(resumed.steps[2]?.task ?? "", /intentional deliverables listed in changedFiles/i);
  assert.match(resumed.steps[3]?.task ?? "", /Verify workspace hygiene/i);
});

test("MockWorkerRunner inserts DAG reviewer repair before downstream fan-in stages", async () => {
  const cwd = tempDir("pi-chalin-review-repair-dag-order-");
  const run = createRunState({
    kind: "multi-agent-dag",
    agents: ["worker", "reviewer", "context-builder", "reviewer"],
    risk: "medium",
    ambiguity: "low",
    needsMemory: false,
    needsArtifacts: true,
    reason: "dag implementation route with downstream synthesis",
    plan: {
      kind: "dag",
      stages: [
        { id: "implement", tasks: [{ agent: "worker", task: "implement" }] },
        { id: "unit-review", tasks: [{ agent: "reviewer", task: "review unit" }] },
        { id: "aggregate", tasks: [{ agent: "context-builder", task: "aggregate units" }] },
        { id: "final-review", tasks: [{ agent: "reviewer", task: "final review" }] },
      ],
    },
  }, cwd, "Implement parser behavior and tests.");
  run.status = "paused";
  run.steps[0]!.status = "complete";
  run.steps[0]!.output = parseAgentOutput("worker", "## Handoff\nChanged: src/parser.c. Verification: `make test` exits 0.");
  run.steps[1]!.status = "complete";
  run.steps[1]!.output = reviewerOutput("gap", {
    missingCoverage: ["Coverage is insufficient for EOF comments."],
    requiredRepair: "Add EOF coverage before aggregate/final review.",
  });

  const resumed = await new MockWorkerRunner().resume(run, { cwd, agents: new Map() });

  assert.equal(resumed.status, "complete");
  assert.deepEqual(resumed.route.plan?.kind === "dag" ? resumed.route.plan.stages.map((stage) => stage.id) : [], [
    "implement",
    "unit-review",
    "review-repair-1-worker",
    "review-repair-1-reviewer",
    "aggregate",
    "final-review",
  ]);
  assert.deepEqual(resumed.steps.map((step) => step.id), [
    "implement:step-1",
    "unit-review:step-1",
    "review-repair-1-worker:step-1",
    "review-repair-1-reviewer:step-1",
    "aggregate:step-1",
    "final-review:step-1",
  ]);
  assert.deepEqual(resumed.steps.map((step) => step.status), ["complete", "complete", "complete", "complete", "complete", "complete"]);
});

test("MockWorkerRunner stops promptly when Pi abort signal is raised", async () => {
  const previousDelay = process.env.PI_CHALIN_MOCK_STEP_DELAY_MS;
  process.env.PI_CHALIN_MOCK_STEP_DELAY_MS = "100";
  try {
    const route: RouteDecision = {
      kind: "multi-agent-sequential",
      agents: ["scout", "planner"],
      risk: "medium",
      ambiguity: "low",
      needsMemory: false,
      needsArtifacts: true,
      reason: "test",
      plan: { kind: "sequential", steps: [{ agent: "scout", task: "scan" }, { agent: "planner", task: "plan" }] },
    };
    const controller = new AbortController();
    const updates: string[] = [];
    const promise = new MockWorkerRunner().run(route, {
      cwd: tempDir("pi-chalin-runner-abort-"),
      agents: new Map(),
      signal: controller.signal,
      onUpdate: (run) => updates.push(run.status),
    });
    setTimeout(() => controller.abort(), 10);

    const run = await promise;

    assert.equal(run.status, "paused");
    assert.ok(run.steps.some((step) => step.status === "paused"));
    assert.match(run.warnings.join("\n"), /stopped by user/);
    assert.ok(updates.includes("paused"));
  } finally {
    if (previousDelay === undefined) delete process.env.PI_CHALIN_MOCK_STEP_DELAY_MS;
    else process.env.PI_CHALIN_MOCK_STEP_DELAY_MS = previousDelay;
  }
});

test("MockWorkerRunner persists in-flight run state for terminal/process recovery", async () => {
  const previousDelay = process.env.PI_CHALIN_MOCK_STEP_DELAY_MS;
  process.env.PI_CHALIN_MOCK_STEP_DELAY_MS = "100";
  try {
    const cwd = tempDir("pi-chalin-runner-live-persist-");
    const route: RouteDecision = {
      kind: "multi-agent-sequential",
      agents: ["scout", "planner"],
      risk: "medium",
      ambiguity: "low",
      needsMemory: false,
      needsArtifacts: true,
      reason: "test recovery",
      plan: { kind: "sequential", steps: [{ agent: "scout", task: "scan" }, { agent: "planner", task: "plan" }] },
    };
    const controller = new AbortController();
    const promise = new MockWorkerRunner().run(route, {
      cwd,
      agents: new Map(),
      signal: controller.signal,
    });

    await new Promise((resolve) => setTimeout(resolve, 20));
    const recoveredDuringRun = loadResumableRunState({ cwd });
    controller.abort();
    const finalRun = await promise;

    assert.equal(recoveredDuringRun?.status, "paused");
    assert.match(recoveredDuringRun?.warnings.join("\n") ?? "", /Recovered stale running run/);
    assert.ok(recoveredDuringRun?.steps.some((step) => step.status === "running" || step.status === "pending"));
    assert.equal(finalRun.status, "paused");
  } finally {
    if (previousDelay === undefined) delete process.env.PI_CHALIN_MOCK_STEP_DELAY_MS;
    else process.env.PI_CHALIN_MOCK_STEP_DELAY_MS = previousDelay;
  }
});

test("pi-chalin child sessions are stored outside Pi resume top-level index", async () => {
  const cwd = tempDir("pi-chalin-child-cwd-");
  const parentSessionDir = tempDir("pi-chalin-parent-sessions-");
  const parent = SessionManager.create(cwd, parentSessionDir);
  parent.appendMessage(userMessage("Implement a parent orchestrator task"));
  parent.appendMessage(assistantMessage("Parent orchestrator response"));
  const parentSessionFile = parent.getSessionFile();
  assert.ok(parentSessionFile);

  const step = { id: "step:1", agent: "worker", task: "implement", status: "pending" as const };
  const child = createChalinChildSessionManager({
    cwd,
    runId: "run-123",
    step,
    extensionContext: { sessionManager: parent },
  });
  child.appendMessage(userMessage("You are pi-chalin worker: Single-write implementation agent for approved scoped changes."));
  child.appendMessage(assistantMessage("Child worker response"));

  const topLevelSessions = await SessionManager.list(cwd, parentSessionDir);
  assert.deepEqual(topLevelSessions.map((session) => session.path), [parentSessionFile]);
  assert.equal(topLevelSessions.some((session) => session.firstMessage.includes("You are pi-chalin worker")), false);

  const childSessionDir = child.getSessionDir();
  const expectedChildRoot = path.join(parentSessionDir, path.basename(parentSessionFile, ".jsonl"), "pi-chalin", "run-123");
  assert.ok(childSessionDir.startsWith(expectedChildRoot + path.sep), childSessionDir);

  const nestedSessions = await SessionManager.list(cwd, childSessionDir);
  assert.equal(nestedSessions.length, 1);
  assert.equal(nestedSessions[0]?.parentSessionPath, parentSessionFile);
});

test("pi-chalin child session fallback stays in project-local hidden state", () => {
  const cwd = tempDir("pi-chalin-child-fallback-");
  const sessionDir = chalinChildSessionDir({
    cwd,
    runId: "run:with/spaces",
    stepId: "stage:2/reviewer",
    agent: "reviewer",
  });

  assert.equal(
    sessionDir,
    path.join(cwd, ".pi-chalin", "child-sessions", "run-with-spaces", "stage-2-reviewer-reviewer"),
  );
});

test("legacy top-level child sessions are hidden without moving parent sessions", async () => {
  const cwd = tempDir("pi-chalin-legacy-cwd-");
  const parentSessionDir = tempDir("pi-chalin-legacy-sessions-");
  const parent = SessionManager.create(cwd, parentSessionDir);
  parent.appendMessage(userMessage("Parent task visible in resume"));
  parent.appendMessage(assistantMessage("Parent response"));

  const legacyChild = SessionManager.create(cwd, parentSessionDir);
  legacyChild.appendMessage(userMessage("You are pi-chalin planner: Turns context into an implementation plan."));
  legacyChild.appendMessage(assistantMessage("Planner response"));
  const legacyChildFile = legacyChild.getSessionFile();
  assert.ok(legacyChildFile);

  const cleanup = await hideLegacyTopLevelChildSessions({ sessionManager: parent });
  assert.equal(cleanup.moved.length, 1);
  assert.equal(cleanup.failed.length, 0);
  assert.equal(fs.existsSync(legacyChildFile), false);
  assert.equal(fs.existsSync(cleanup.moved[0]!), true);

  const topLevelSessions = await SessionManager.list(cwd, parentSessionDir);
  assert.deepEqual(topLevelSessions.map((session) => session.firstMessage), ["Parent task visible in resume"]);
});

test("MockWorkerRunner prepares and cleans isolated worktrees for parallel writer routes", async () => {
  const cwd = tempDir("pi-chalin-runner-worktrees-");
  git(cwd, ["init"]);
  git(cwd, ["config", "user.email", "pi-chalin@example.com"]);
  git(cwd, ["config", "user.name", "pi-chalin"]);
  fs.writeFileSync(path.join(cwd, "a.txt"), "one\n");
  git(cwd, ["add", "."]);
  git(cwd, ["commit", "-m", "init"]);

  const route: RouteDecision = {
    kind: "multi-agent-dag",
    agents: ["worker-a", "worker-b"],
    risk: "medium",
    ambiguity: "low",
    needsMemory: false,
    needsArtifacts: true,
    reason: "test",
    plan: {
      kind: "dag",
      stages: [{ id: "fanout", tasks: [{ agent: "worker-a", task: "edit a" }, { agent: "worker-b", task: "edit b" }] }],
    },
  };
  const agents = new Map([
    ["worker-a", agent("worker-a", ["inspect-files", "edit-files"])],
    ["worker-b", agent("worker-b", ["inspect-files", "write-new-files"])],
  ]);

  const run = await new MockWorkerRunner().run(route, { cwd, agents });

  assert.equal(run.status, "complete");
  assert.match(run.warnings.join("\n"), /worktree isolation active/i);
  assert.doesNotMatch(run.warnings.join("\n"), /gated|before real concurrent writes/i);
  assert.equal(git(cwd, ["branch", "--list", "pi-chalin/*"]), "");
});

test("MockWorkerRunner runs staged DAGs with parallel fan-out and downstream synthesis", async () => {
  const route: RouteDecision = {
    kind: "multi-agent-dag",
    agents: ["scout", "context-builder", "context-builder", "reviewer"],
    risk: "low",
    ambiguity: "low",
    needsMemory: false,
    needsArtifacts: true,
    reason: "test dag",
    plan: {
      kind: "dag",
      stages: [
        { id: "discover", tasks: [{ agent: "scout", task: "Map modules." }] },
        { id: "fanout", tasks: [{ agent: "context-builder", task: "Analyze auth." }, { agent: "context-builder", task: "Analyze billing." }] },
        { id: "review", tasks: [{ agent: "reviewer", task: "Synthesize final answer." }] },
      ],
    },
  };

  const run = await new MockWorkerRunner().run(route, { cwd: tempDir("pi-chalin-runner-dag-"), agents: new Map() });

  assert.equal(run.status, "complete");
  assert.deepEqual(run.steps.map((step) => step.status), ["complete", "complete", "complete", "complete"]);
  assert.match(run.steps[1]?.output?.raw ?? "", /Previous handoff/);
  assert.match(run.steps[2]?.output?.raw ?? "", /Previous handoff/);
  assert.match(run.steps[3]?.output?.raw ?? "", /context-builder/);
});

test("createRunState preserves single-step sequential budget metadata", () => {
  const route: RouteDecision = {
    kind: "multi-agent-sequential",
    agents: ["scout"],
    risk: "low",
    ambiguity: "low",
    needsMemory: false,
    needsArtifacts: false,
    reason: "deep recon",
    plan: { kind: "sequential", steps: [{ agent: "scout", task: "Map project.", budget: "deep" }] },
  };

  const run = createRunState(route, tempDir("pi-chalin-single-budget-"));

  assert.equal(run.steps[0]?.budget, "deep");
});

test("createRunState records schema v3 work units and intent contract metadata", () => {
  const route: RouteDecision = {
    kind: "multi-agent-dag",
    agents: ["scout"],
    risk: "medium",
    ambiguity: "low",
    needsMemory: false,
    needsArtifacts: true,
    expectedEffects: ["read", "write", "verify"],
    reason: "structured discovery route",
    plan: { kind: "dag", stages: [{ id: "discover", tasks: [{ id: "discover", agent: "scout", task: "Map work units from the route contract." }] }] },
  };

  const run = createRunState(route, tempDir("pi-chalin-work-units-"), "Use the structured route contract.");

  assert.equal(run.schemaVersion, 3);
  assert.equal(run.intentContract?.workUnitDiscoveryRequested, true);
  assert.equal(run.intentContract?.decompositionTarget, "work unit");
  assert.equal(run.intentContract?.explicitFanoutRequest, undefined);
  assert.deepEqual(run.intentContract?.forbiddenPaths, []);
  assert.equal(run.workUnits?.length, 1);
  assert.equal(run.steps[0]?.workUnitId, run.workUnits?.[0]?.id);
});

test("expandWorkUnitsFromHandoff materializes requested work unit discovery only once", () => {
  const route: RouteDecision = {
    kind: "multi-agent-dag",
    agents: ["scout", "worker", "reviewer"],
    risk: "medium",
    ambiguity: "low",
    needsMemory: false,
    needsArtifacts: true,
    expectedEffects: ["read", "write", "verify"],
    reason: "structured work unit discovery",
    plan: {
      kind: "dag",
      stages: [{ id: "discover", tasks: [{ agent: "scout", task: "Find independent work units." }] }],
    },
  };
  const run = createRunState(route, tempDir("pi-chalin-fanout-once-"), "Use one worker per unit and reviewer per unit.");
  run.steps[0]!.status = "complete";
  run.steps[0]!.output = parseAgentOutput("scout", [
    "## Agent Handoff",
    JSON.stringify({
      summary: "Discovered bounded units for independent execution.",
      changedFiles: [],
      verification: [],
      evidenceClaims: [],
      risks: [],
      nextActions: [],
      workUnits: [
        {
          title: "Unit Alpha",
          scope: ["Alpha ownership boundary"],
          dependencies: [],
          acceptanceCriteria: ["Alpha is implemented and verified independently."],
        },
        {
          title: "Unit Beta",
          scope: ["Beta ownership boundary"],
          dependencies: [],
          acceptanceCriteria: ["Beta is implemented and verified independently."],
        },
      ],
    }),
  ].join("\n"));

  assert.equal(expandWorkUnitsFromHandoff(run, run.steps[0]!), true);
  const firstStepCount = run.steps.length;
  const firstFanoutUnitCount = run.workUnits?.filter((unit) => unit.createdFrom === "fanout").length;
  const aggregateStep = run.steps.find((step) => step.agent === "context-builder" && step.stageId?.includes("aggregate"));
  assert.ok(aggregateStep);
  aggregateStep!.status = "complete";
  aggregateStep!.output = parseAgentOutput("context-builder", [
    "## Agent Handoff",
    JSON.stringify({
      summary: "Aggregate output is not another decomposition request.",
      changedFiles: [],
      verification: [],
      evidenceClaims: [],
      risks: [],
      nextActions: [],
      workUnits: [
        {
          title: "Aggregate Unit",
          scope: ["Aggregate-only responsibility"],
          dependencies: [],
          acceptanceCriteria: ["Aggregation is complete."],
        },
      ],
    }),
  ].join("\n"));

  assert.equal(expandWorkUnitsFromHandoff(run, aggregateStep!), false);
  assert.equal(run.steps.length, firstStepCount);
  assert.equal(run.workUnits?.filter((unit) => unit.createdFrom === "fanout").length, firstFanoutUnitCount);
  assert.equal(run.warnings.filter((warning) => /Expanded fanout\/decomposition/i.test(warning)).length, 1);
});

test("expandWorkUnitsFromBestHandoff prefers later planning contracts over early scouting contracts in a stage", () => {
  const route: RouteDecision = {
    kind: "multi-agent-dag",
    agents: ["scout", "planner", "worker", "reviewer"],
    risk: "medium",
    ambiguity: "low",
    needsMemory: false,
    needsArtifacts: true,
    expectedEffects: ["read", "write", "verify"],
    workUnitStrategy: "discover",
    reason: "stage has discovery and planning contracts",
    plan: {
      kind: "dag",
      stages: [{ id: "discover", tasks: [{ agent: "scout", task: "Discover rough units." }, { agent: "planner", task: "Refine units." }] }],
    },
  };
  const run = createRunState(route, tempDir("pi-chalin-best-fanout-source-"), "Use bounded decomposition.");
  run.steps[0]!.status = "complete";
  run.steps[0]!.output = parseAgentOutput("scout", [
    "## Agent Handoff",
    JSON.stringify({
      summary: "Rough discovery units.",
      changedFiles: [],
      verification: [],
      evidenceClaims: [],
      risks: [],
      nextActions: [],
      workUnits: [
        { id: "rough-a", title: "Rough A", scope: { files: ["src/rough-a.ts"], purpose: "rough A" }, dependencies: [], acceptanceCriteria: ["rough A"] },
        { id: "rough-b", title: "Rough B", scope: { files: ["src/rough-b.ts"], purpose: "rough B" }, dependencies: [], acceptanceCriteria: ["rough B"] },
      ],
    }),
  ].join("\n"));
  run.steps[1]!.status = "complete";
  run.steps[1]!.output = parseAgentOutput("planner", [
    "## Agent Handoff",
    JSON.stringify({
      summary: "Refined planning units.",
      changedFiles: [],
      verification: ["planning contract reviewed"],
      evidenceClaims: [],
      risks: [],
      nextActions: [],
      workUnits: [
        { id: "planned-a", title: "Planned A", scope: { files: ["src/planned-a.ts"], purpose: "planned A" }, dependencies: [], acceptanceCriteria: ["planned A"] },
        { id: "planned-b", title: "Planned B", scope: { files: ["src/planned-b.ts"], purpose: "planned B" }, dependencies: [], acceptanceCriteria: ["planned B"] },
      ],
    }),
  ].join("\n"));

  assert.equal(expandWorkUnitsFromBestHandoff(run, run.steps), true);

  const fanoutTitles = run.workUnits?.filter((unit) => unit.createdFrom === "fanout" && unit.kind === "implementation").map((unit) => unit.title) ?? [];
  assert.deepEqual(fanoutTitles, ["Planned A", "Planned B"]);
  assert.match(run.warnings.at(-1) ?? "", /planner\/discover:step-2/);
});

test("expandWorkUnitsFromBestHandoff defers scout fanout while a planner contract is still pending", () => {
  const route: RouteDecision = {
    kind: "multi-agent-dag",
    agents: ["scout", "planner", "worker", "reviewer"],
    risk: "medium",
    ambiguity: "low",
    needsMemory: false,
    needsArtifacts: true,
    expectedEffects: ["read", "write", "verify"],
    workUnitStrategy: "discover",
    reason: "planner should refine scout units",
    plan: {
      kind: "dag",
      stages: [
        { id: "recon", tasks: [{ agent: "scout", task: "Discover rough units." }] },
        { id: "planning", tasks: [{ agent: "planner", task: "Refine units." }] },
      ],
    },
  };
  const run = createRunState(route, tempDir("pi-chalin-defer-scout-fanout-"), "Use bounded decomposition.");
  run.steps[0]!.status = "complete";
  run.steps[0]!.output = parseAgentOutput("scout", [
    "## Agent Handoff",
    JSON.stringify({
      summary: "Rough discovery units.",
      changedFiles: [],
      verification: [],
      evidenceClaims: [],
      risks: [],
      nextActions: [],
      workUnits: [
        { id: "rough-a", title: "Rough A", scope: { files: ["src/rough-a.ts"], purpose: "rough A" }, dependencies: [], acceptanceCriteria: ["rough A"] },
        { id: "rough-b", title: "Rough B", scope: { files: ["src/rough-b.ts"], purpose: "rough B" }, dependencies: [], acceptanceCriteria: ["rough B"] },
      ],
    }),
  ].join("\n"));

  assert.equal(expandWorkUnitsFromBestHandoff(run, [run.steps[0]!]), false);
  assert.equal(run.workUnits?.filter((unit) => unit.createdFrom === "fanout").length, 0);

  run.steps[1]!.status = "complete";
  run.steps[1]!.output = parseAgentOutput("planner", [
    "## Agent Handoff",
    JSON.stringify({
      summary: "Refined planning units.",
      changedFiles: [],
      verification: ["planning contract reviewed"],
      evidenceClaims: [],
      risks: [],
      nextActions: [],
      workUnits: [
        { id: "planned-a", title: "Planned A", scope: { files: ["src/planned-a.ts"], purpose: "planned A" }, dependencies: [], acceptanceCriteria: ["planned A"] },
        { id: "planned-b", title: "Planned B", scope: { files: ["src/planned-b.ts"], purpose: "planned B" }, dependencies: [], acceptanceCriteria: ["planned B"] },
      ],
    }),
  ].join("\n"));

  assert.equal(expandWorkUnitsFromBestHandoff(run, [run.steps[1]!]), true);
  const fanoutTitles = run.workUnits?.filter((unit) => unit.createdFrom === "fanout" && unit.kind === "implementation").map((unit) => unit.title) ?? [];
  assert.deepEqual(fanoutTitles, ["Planned A", "Planned B"]);
});

test("expandWorkUnitsFromHandoff materializes structured WorkUnit dependencies as ordered stages", () => {
  const route: RouteDecision = {
    kind: "multi-agent-dag",
    agents: ["planner", "worker", "reviewer"],
    risk: "medium",
    ambiguity: "low",
    needsMemory: false,
    needsArtifacts: true,
    expectedEffects: ["read", "write", "verify"],
    workUnitStrategy: "discover",
    reason: "dependent fanout units",
    plan: { kind: "dag", stages: [{ id: "discover", tasks: [{ agent: "planner", task: "Plan dependent units." }] }] },
  };
  const run = createRunState(route, tempDir("pi-chalin-fanout-dependencies-"), "Use bounded decomposition with dependencies.");
  run.steps[0]!.status = "complete";
  run.steps[0]!.output = parseAgentOutput("planner", [
    "## Agent Handoff",
    JSON.stringify({
      summary: "Planned dependent units.",
      changedFiles: [],
      verification: ["dependency contract reviewed"],
      evidenceClaims: [],
      risks: [],
      nextActions: [],
      workUnits: [
        { id: "base", title: "Base Unit", scope: { files: ["src/base.ts", "test/base.test.ts"], purpose: "base" }, dependencies: [], acceptanceCriteria: ["base done"] },
        { id: "dependent", title: "Dependent Unit", scope: { files: ["src/dependent.ts"], purpose: "dependent" }, dependencies: ["base"], acceptanceCriteria: ["dependent done"] },
      ],
    }),
  ].join("\n"));

  assert.equal(expandWorkUnitsFromHandoff(run, run.steps[0]!), true);

  const base = run.workUnits?.find((unit) => unit.title === "Base Unit");
  const dependent = run.workUnits?.find((unit) => unit.title === "Dependent Unit");
  assert.ok(base?.reviewerStepId);
  assert.deepEqual(base?.files, ["src/base.ts", "test/base.test.ts"]);
  assert.ok(dependent?.workerStepId);
  assert.deepEqual(dependent?.dependencies, [run.steps[0]?.workUnitId, base?.id]);
  const dependentWorker = run.steps.find((step) => step.id === dependent?.workerStepId);
  assert.deepEqual(dependentWorker?.dependencies, [run.steps[0]?.id, base?.reviewerStepId]);
  assert.match(dependentWorker?.task ?? "", /Scope: dependent\./);
  assert.match(dependentWorker?.task ?? "", /Change only files in this WorkUnit scope/i);
  const baseWorker = run.steps.find((step) => step.id === base?.workerStepId);
  assert.ok((baseWorker?.task ?? "").includes("Files: src/base.ts; test/base.test.ts."));
  assert.ok((baseWorker?.task ?? "").includes("Use edit for listed files that already exist"));
  const stageIds = run.route.plan?.kind === "dag" ? run.route.plan.stages.map((stage) => stage.id) : [];
  assert.ok(stageIds.indexOf("fanout-discover-step-1-workers-1") < stageIds.indexOf("fanout-discover-step-1-workers-2"));
});

test("expandWorkUnitsFromHandoff serializes work units that declare overlapping files", () => {
  const route: RouteDecision = {
    kind: "multi-agent-dag",
    agents: ["planner", "worker", "reviewer"],
    risk: "medium",
    ambiguity: "low",
    needsMemory: false,
    needsArtifacts: true,
    expectedEffects: ["read", "write", "verify"],
    workUnitStrategy: "discover",
    reason: "overlap-aware fanout units",
    plan: { kind: "dag", stages: [{ id: "discover", tasks: [{ agent: "planner", task: "Plan units." }] }] },
  };
  const run = createRunState(route, tempDir("pi-chalin-fanout-overlap-"), "Use bounded decomposition with no file overlap.");
  run.steps[0]!.status = "complete";
  run.steps[0]!.output = parseAgentOutput("planner", [
    "## Agent Handoff",
    JSON.stringify({
      summary: "Planned units with a shared documentation file.",
      changedFiles: [],
      verification: [],
      evidenceClaims: [],
      risks: [],
      nextActions: [],
      workUnits: [
        { id: "a", title: "Unit A", scope: { files: ["src/a.ts", "README.md"], purpose: "A" }, dependencies: [], acceptanceCriteria: ["A done"] },
        { id: "b", title: "Unit B", scope: { files: ["src/b.ts", "./README.md"], purpose: "B" }, dependencies: [], acceptanceCriteria: ["B done"] },
        { id: "c", title: "Unit C", scope: { files: ["src/c.ts"], purpose: "C" }, dependencies: [], acceptanceCriteria: ["C done"] },
      ],
    }),
  ].join("\n"));

  assert.equal(expandWorkUnitsFromHandoff(run, run.steps[0]!), true);

  const unitA = run.workUnits?.find((unit) => unit.title === "Unit A");
  const unitB = run.workUnits?.find((unit) => unit.title === "Unit B");
  const unitC = run.workUnits?.find((unit) => unit.title === "Unit C");
  assert.ok(unitA?.reviewerStepId);
  assert.deepEqual(unitB?.dependencies, [run.steps[0]?.workUnitId, unitA?.id]);
  assert.deepEqual(unitC?.dependencies, [run.steps[0]?.workUnitId]);
  const unitBWorker = run.steps.find((step) => step.id === unitB?.workerStepId);
  assert.deepEqual(unitBWorker?.dependencies, [run.steps[0]?.id, unitA?.reviewerStepId]);
  assert.match(run.warnings.join("\n"), /overlapping declared files/i);
});

test("expandWorkUnitsFromHandoff supports review units without forcing workspace mutation", () => {
  const route: RouteDecision = {
    kind: "multi-agent-sequential",
    agents: ["scout"],
    risk: "low",
    ambiguity: "low",
    needsMemory: false,
    needsArtifacts: true,
    expectedEffects: ["read", "verify"],
    workUnitStrategy: "discover",
    reason: "large review needs discovered units",
    plan: { kind: "sequential", steps: [{ agent: "scout", task: "Discover review units." }] },
  };
  const run = createRunState(route, tempDir("pi-chalin-review-units-"), "Review a large scope by bounded units.");
  run.steps[0]!.status = "complete";
  run.steps[0]!.output = parseAgentOutput("scout", [
    "## Agent Handoff",
    JSON.stringify({
      summary: "Discovered bounded review units.",
      changedFiles: [],
      verification: [],
      evidenceClaims: [],
      risks: [],
      nextActions: [],
      workUnits: [
        {
          title: "Unit Alpha",
          scope: ["Alpha review boundary"],
          dependencies: [],
          acceptanceCriteria: ["Alpha has explicit evidence and gaps."],
        },
        {
          title: "Unit Beta",
          scope: ["Beta review boundary"],
          dependencies: [],
          acceptanceCriteria: ["Beta has explicit evidence and gaps."],
        },
      ],
    }),
  ].join("\n"));

  assert.equal(expandWorkUnitsFromHandoff(run, run.steps[0]!), true);
  const fanoutSteps = run.steps.filter((step) => step.id.startsWith("fanout-"));

  assert.ok(fanoutSteps.some((step) => step.agent === "reviewer"));
  assert.equal(fanoutSteps.some((step) => step.agent === "worker"), false);
  assert.deepEqual(run.route.expectedEffects, ["read", "verify"]);
});

test("expandWorkUnitsFromHandoff keeps verification-only units read-only inside mutating routes", () => {
  const route: RouteDecision = {
    kind: "multi-agent-dag",
    agents: ["planner", "worker", "reviewer"],
    risk: "medium",
    ambiguity: "low",
    needsMemory: false,
    needsArtifacts: true,
    expectedEffects: ["read", "write", "verify"],
    workUnitStrategy: "discover",
    reason: "mixed implementation and verification units",
    plan: { kind: "dag", stages: [{ id: "discover", tasks: [{ agent: "planner", task: "Plan bounded units." }] }] },
  };
  const run = createRunState(route, tempDir("pi-chalin-mixed-unit-effects-"), "Decompose a broad implementation.");
  run.steps[0]!.status = "complete";
  run.steps[0]!.output = parseAgentOutput("planner", [
    "## Agent Handoff",
    JSON.stringify({
      summary: "Planned implementation units plus a final validation unit.",
      changedFiles: [],
      verification: ["planning contract reviewed"],
      evidenceClaims: [],
      risks: [],
      nextActions: [],
      workUnits: [
        {
          id: "implementation-a",
          title: "Implementation A",
          scope: { files: ["src/a.ts", "src/a.test.ts"], purpose: "A implementation boundary" },
          dependencies: [],
          expectedEffects: ["read", "write", "verify"],
          acceptanceCriteria: ["A is implemented and verified."],
        },
        {
          id: "global-validation",
          title: "Global validation",
          scope: ["Validate integrated behavior after unit work."],
          dependencies: ["implementation-a"],
          expectedEffects: ["read", "verify"],
          acceptanceCriteria: ["Integrated checks have evidence."],
        },
      ],
    }),
  ].join("\n"));

  assert.equal(expandWorkUnitsFromHandoff(run, run.steps[0]!), true);

  const implementation = run.workUnits?.find((unit) => unit.title === "Implementation A");
  const validation = run.workUnits?.find((unit) => unit.title === "Global validation");
  assert.deepEqual(implementation?.expectedEffects, ["read", "write", "verify"]);
  assert.equal(implementation?.kind, "implementation");
  assert.ok(implementation?.reviewerStepId);
  assert.deepEqual(validation?.expectedEffects, ["read", "verify"]);
  assert.equal(validation?.kind, "review");
  assert.equal(validation?.reviewerStepId, undefined);
  const validationStep = run.steps.find((step) => step.id === validation?.workerStepId);
  assert.equal(validationStep?.agent, "reviewer");
  assert.deepEqual(validationStep?.dependencies, [run.steps[0]?.id, implementation?.reviewerStepId]);
  assert.deepEqual(run.workUnits?.find((unit) => unit.title === "Aggregate fanout results")?.dependencies, [implementation?.reviewerStepId, validation?.workerStepId]);
});

test("expandWorkUnitsFromHandoff does not infer work units from prose or evidence claims", () => {
  const route: RouteDecision = {
    kind: "multi-agent-dag",
    agents: ["scout", "worker", "reviewer"],
    risk: "medium",
    ambiguity: "low",
    needsMemory: false,
    needsArtifacts: true,
    expectedEffects: ["read", "write", "verify"],
    workUnitStrategy: "discover",
    reason: "decomposition requires structured units",
    plan: {
      kind: "dag",
      stages: [{ id: "discover", tasks: [{ agent: "scout", task: "Discover bounded work units." }] }],
    },
  };
  const run = createRunState(route, tempDir("pi-chalin-fanout-structured-only-"), "Use bounded decomposition.");
  run.steps[0]!.status = "complete";
  run.steps[0]!.output = parseAgentOutput("scout", [
    "## Agent Handoff",
    JSON.stringify({
      summary: "The analysis contains several markdown sections and candidate observations, but no structured units.",
      changedFiles: [],
      verification: [],
      evidenceClaims: [
        {
          kind: "stable-fact",
          subject: "Candidate A",
          summary: "A possible ownership area exists.",
          evidence: ["scout evidence"],
          confidence: 0.8,
        },
        {
          kind: "stable-fact",
          subject: "Candidate B",
          summary: "Another possible ownership area exists.",
          evidence: ["scout evidence"],
          confidence: 0.8,
        },
      ],
      risks: [],
      nextActions: [],
      workUnits: [],
    }),
    "## Findings",
    "- Candidate A",
    "- Candidate B",
  ].join("\n"));

  assert.equal(expandWorkUnitsFromHandoff(run, run.steps[0]!), false);
  assert.equal(run.workUnits?.filter((unit) => unit.createdFrom === "fanout").length, 0);
  assert.equal(run.recoveryState?.blockedByHumanInput, true);
  assert.deepEqual(run.recoveryState?.repairOptions, ["Ask the user to clarify or approve the bounded work units before launching implementation workers."]);
});

test("createRunState records routed parallel work without inventing discovery intent", () => {
  const route: RouteDecision = {
    kind: "multi-agent-dag",
    agents: ["worker", "worker", "reviewer"],
    risk: "medium",
    ambiguity: "low",
    needsMemory: false,
    needsArtifacts: true,
    expectedEffects: ["read", "write", "verify"],
    reason: "route decomposes independently owned work",
    plan: {
      kind: "dag",
      stages: [
        { id: "implement", tasks: [{ agent: "worker", task: "Implement unit A." }, { agent: "worker", task: "Implement unit B." }] },
        { id: "review", tasks: [{ agent: "reviewer", task: "Review fan-in." }] },
      ],
    },
  };

  const run = createRunState(route, tempDir("pi-chalin-routed-decomposition-"), "Implement the routed plan.");

  assert.notEqual(run.intentContract?.explicitFanoutRequest, true);
  assert.notEqual(run.intentContract?.workUnitDiscoveryRequested, true);
  assert.equal(run.workUnits?.length, 3);
  assert.equal(run.steps[0]?.dependencies?.length, 0);
  assert.deepEqual(run.steps[2]?.dependencies, ["implement:step-1", "implement:step-2"]);
});

test("createRunState scopes planned WorkUnit effects by step responsibility", () => {
  const route: RouteDecision = {
    kind: "multi-agent-dag",
    agents: ["worker", "reviewer", "context-builder"],
    risk: "medium",
    ambiguity: "low",
    needsMemory: false,
    needsArtifacts: true,
    expectedEffects: ["read", "write", "verify"],
    reason: "planned effects by responsibility",
    plan: {
      kind: "dag",
      stages: [
        { id: "implement", tasks: [{ id: "worker", agent: "worker", task: "Implement." }] },
        { id: "review", tasks: [{ id: "reviewer", agent: "reviewer", task: "Review." }] },
        { id: "aggregate", tasks: [{ id: "aggregate", agent: "context-builder", task: "Aggregate." }] },
      ],
    },
  };

  const run = createRunState(route, tempDir("pi-chalin-planned-effects-"), "Implement and review.");

  const workerUnit = run.workUnits?.find((unit) => unit.title === "worker");
  const reviewerUnit = run.workUnits?.find((unit) => unit.title === "reviewer");
  const aggregateUnit = run.workUnits?.find((unit) => unit.title === "aggregate");
  assert.deepEqual(workerUnit?.expectedEffects, ["read", "write", "verify"]);
  assert.deepEqual(reviewerUnit?.expectedEffects, ["read", "verify"]);
  assert.deepEqual(aggregateUnit?.expectedEffects, ["read"]);
});

test("skipped steps are not usable handoffs and recovery records reviewers not run", () => {
  assert.equal(runtimeIsUsableStepStatus("complete"), true);
  assert.equal(runtimeIsUsableStepStatus("checkpointed"), true);
  assert.equal(runtimeIsUsableStepStatus("skipped"), false);

  const route: RouteDecision = {
    kind: "multi-agent-sequential",
    agents: ["worker", "reviewer"],
    risk: "medium",
    ambiguity: "low",
    needsMemory: false,
    needsArtifacts: true,
    expectedEffects: ["read", "write", "verify"],
    reason: "implementation with reviewer",
    plan: { kind: "sequential", steps: [{ agent: "worker", task: "Implement." }, { agent: "reviewer", task: "Review." }] },
  };
  const run = createRunState(route, tempDir("pi-chalin-skipped-"));
  run.steps[0]!.status = "failed";
  run.steps[0]!.error = "handoff missing verification";
  run.steps[0]!.metrics = stepMetrics({ policyViolations: ["outside_work_unit_scope:config/test-support.ts"] });

  const skipped = markBlockedDependentsSkipped(run, run.steps[0]);

  assert.equal(skipped, 1);
  assert.equal(run.steps[1]?.status, "skipped");
  assert.match(run.steps[1]?.skipReason ?? "", /upstream worker\/step-1 failed/i);
  assert.deepEqual(run.recoveryState?.reviewersNotRun, ["step-2"]);
  assert.equal(run.recoveryState?.resumeKind, "repair");
  assert.match(run.recoveryState?.repairOptions.join("\n") ?? "", /scope repair route/i);
});

test("repair options identify WorkUnit scope contract failures", () => {
  const route: RouteDecision = {
    kind: "multi-agent-sequential",
    agents: ["worker"],
    risk: "medium",
    ambiguity: "low",
    needsMemory: false,
    needsArtifacts: true,
    expectedEffects: ["read", "write", "verify"],
    reason: "implementation",
    plan: { kind: "sequential", steps: [{ agent: "worker", task: "Implement." }] },
  };
  const run = createRunState(route, tempDir("pi-chalin-repair-scope-"));
  const step = run.steps[0]!;
  step.status = "failed";
  step.error = "Tool policy violation(s): outside_work_unit_scope:config/test-support.ts.";
  step.metrics = stepMetrics({ policyViolations: ["outside_work_unit_scope:config/test-support.ts"] });

  assert.match(repairOptionsFor(run, step).join("\n"), /updates or splits the failed WorkUnit contract/i);
});

test("skipped propagation follows dependencies without skipping independent DAG siblings", () => {
  const route: RouteDecision = {
    kind: "multi-agent-dag",
    agents: ["worker", "worker", "reviewer"],
    risk: "medium",
    ambiguity: "low",
    needsMemory: false,
    needsArtifacts: true,
    expectedEffects: ["read", "write", "verify"],
    reason: "parallel work with fan-in review",
    plan: {
      kind: "dag",
      stages: [
        { id: "work", tasks: [{ agent: "worker", task: "Implement unit A." }, { agent: "worker", task: "Implement unit B." }] },
        { id: "review", tasks: [{ agent: "reviewer", task: "Review fan-in." }] },
      ],
    },
  };
  const run = createRunState(route, tempDir("pi-chalin-skip-dag-"));
  run.steps[0]!.status = "failed";
  run.steps[0]!.error = "unit A failed";

  const skipped = markBlockedDependentsSkipped(run, run.steps[0]);

  assert.equal(skipped, 1);
  assert.equal(run.steps[1]?.status, "pending");
  assert.equal(run.steps[2]?.status, "skipped");
  assert.deepEqual(run.recoveryState?.reviewersNotRun, ["review:step-1"]);
});

test("ContextPacket carries completed and checkpointed evidence without treating skipped as usable", () => {
  const route: RouteDecision = {
    kind: "multi-agent-sequential",
    agents: ["scout", "planner", "reviewer", "worker"],
    risk: "low",
    ambiguity: "low",
    needsMemory: false,
    needsArtifacts: true,
    expectedEffects: ["read", "write", "verify"],
    reason: "context packet",
    plan: {
      kind: "sequential",
      steps: [
        { agent: "scout", task: "Map repo." },
        { agent: "planner", task: "Plan." },
        { agent: "reviewer", task: "Review." },
        { agent: "worker", task: "Implement." },
      ],
    },
  };
  const run = createRunState(route, tempDir("pi-chalin-context-packet-"));
  run.steps[0]!.status = "complete";
  run.steps[0]!.output = parseAgentOutput("scout", `## Agent Handoff\n${JSON.stringify({ summary: "Mapped src/index.ts.", changedFiles: [], verification: [], evidenceClaims: [], risks: [], nextActions: [] })}`);
  run.steps[0]!.metrics = { durationMs: 1, usage: emptyUsage(), toolCalls: 1, toolCallsByName: {}, filesRead: ["src/index.ts"] };
  run.steps[1]!.status = "checkpointed";
  run.steps[1]!.output = parseAgentOutput("planner", `## Agent Handoff\n${JSON.stringify({ summary: "Plan requires tests.", changedFiles: [], verification: [], evidenceClaims: [], risks: ["tests unknown"], nextActions: [] })}`);
  run.steps[2]!.status = "skipped";
  run.steps[2]!.skipReason = "Skipped because upstream failed.";

  const packet = buildContextPacket(run, run.steps[3]!, "prior compact handoff");

  assert.ok(packet);
  assert.match(packet!.summary, /prior compact handoff/);
  assert.deepEqual(packet!.filesRead, ["src/index.ts"]);
  assert.deepEqual(packet!.knownGaps, ["tests unknown", "Skipped because upstream failed."]);
  assert.ok(packet!.workUnitIds.includes(run.steps[0]!.workUnitId!));
});

test("ContextPacket sanitizes absolute paths outside the active workspace", () => {
  const cwd = tempDir("pi-chalin-context-paths-");
  const outsidePath = path.join(path.dirname(cwd), "other-project", "src/index.ts");
  const insidePath = path.join(cwd, "src/index.ts");
  const route: RouteDecision = {
    kind: "multi-agent-sequential",
    agents: ["scout", "worker"],
    risk: "medium",
    ambiguity: "low",
    needsMemory: false,
    needsArtifacts: true,
    expectedEffects: ["read", "write", "verify"],
    reason: "context packet path hygiene",
    plan: { kind: "sequential", steps: [{ agent: "scout", task: "Map repo." }, { agent: "worker", task: "Implement." }] },
  };
  const run = createRunState(route, cwd);
  run.steps[0]!.status = "complete";
  run.steps[0]!.metrics = { durationMs: 1, usage: emptyUsage(), toolCalls: 1, toolCallsByName: {}, filesRead: [insidePath, outsidePath] };
  run.steps[0]!.output = parseAgentOutput("scout", `## Agent Handoff\n${JSON.stringify({ summary: "Mapped paths.", changedFiles: [insidePath, outsidePath], verification: [], evidenceClaims: [], risks: [], nextActions: [] })}`);

  const packet = buildContextPacket(run, run.steps[1]!, `Read src/auth/keycloak.ts, ${insidePath}, and ${outsidePath}.`, 900, cwd);

  assert.ok(packet);
  assert.deepEqual(packet!.filesRead, ["src/index.ts"]);
  assert.deepEqual(packet!.changedFiles, ["src/index.ts"]);
  assert.match(packet!.summary, /src\/index\.ts/);
  assert.match(packet!.summary, /src\/auth\/keycloak\.ts/);
  assert.match(packet!.summary, /\[outside-workspace-path\]/);
  assert.doesNotMatch(packet!.summary, new RegExp(outsidePath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});

test("ContextPacket sanitizes original workspace paths for isolated worker handoffs", () => {
  const original = tempDir("pi-chalin-context-original-");
  const worktree = tempDir("pi-chalin-context-worktree-");
  const outside = tempDir("pi-chalin-context-outside-");
  const originalGoMod = path.join(original, "go.mod");
  const worktreeGoMod = path.join(worktree, "go.mod");
  fs.writeFileSync(originalGoMod, "module example.com/original\n");
  fs.writeFileSync(worktreeGoMod, "module example.com/worktree\n");
  const route: RouteDecision = {
    kind: "multi-agent-sequential",
    agents: ["scout", "worker"],
    risk: "medium",
    ambiguity: "low",
    needsMemory: false,
    needsArtifacts: true,
    expectedEffects: ["read", "write", "verify"],
    reason: "context packet isolated path hygiene",
    plan: { kind: "sequential", steps: [{ agent: "scout", task: "Map repo." }, { agent: "worker", task: "Implement." }] },
  };
  const run = createRunState(route, original);
  run.steps[0]!.status = "complete";
  run.steps[0]!.output = parseAgentOutput("scout", `## Agent Handoff\n${JSON.stringify({
    summary: `Mapped ${originalGoMod}.`,
    changedFiles: [],
    verification: [`cd ${original} && go test ./...`],
    evidenceClaims: [],
    risks: [`Original workspace command mentioned ${originalGoMod}; unrelated ${path.join(outside, "secret.txt")}`],
    nextActions: [],
  })}`);

  const packet = buildContextPacket(run, run.steps[1]!, `Previous used ${originalGoMod}.`, 900, worktree, original);

  assert.ok(packet);
  assert.deepEqual(packet!.verification, ["cd . && go test ./..."]);
  assert.match(packet!.knownGaps.join("\n"), /go\.mod/);
  assert.match(packet!.knownGaps.join("\n"), /\[outside-workspace-path\]/);
  assert.doesNotMatch(formatContextPacket(packet) ?? "", new RegExp(original.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});

test("MockWorkerRunner resumes paused DAG runs without rerunning completed steps", async () => {
  const cwd = tempDir("pi-chalin-runner-resume-dag-");
  const route: RouteDecision = {
    kind: "multi-agent-dag",
    agents: ["scout", "context-builder", "context-builder"],
    risk: "low",
    ambiguity: "low",
    needsMemory: false,
    needsArtifacts: true,
    reason: "test resume dag",
    plan: {
      kind: "dag",
      stages: [
        { id: "discover", tasks: [{ agent: "scout", task: "Map modules." }] },
        { id: "fanout", tasks: [{ agent: "context-builder", task: "Analyze auth." }, { agent: "context-builder", task: "Analyze billing." }] },
        { id: "synthesis", tasks: [{ agent: "context-builder", task: "Synthesize final answer." }] },
      ],
    },
  };
  const run = createRunState(route, cwd);
  run.steps[0]!.status = "complete";
  run.steps[0]!.startedAt = new Date().toISOString();
  run.steps[0]!.endedAt = new Date().toISOString();
  run.steps[0]!.output = { agent: "scout", text: "Scout handoff", handoff: "Scout mapped README and src.", memoryCandidates: [], raw: "Scout handoff", warnings: [] };
  for (const step of run.steps.slice(1)) {
    step.status = "paused";
    step.error = "pi-chalin run stopped by user.";
  }
  run.status = "paused";

  const resumed = await new MockWorkerRunner().resume(run, { cwd, agents: new Map() });

  assert.equal(resumed.id, run.id);
  assert.equal(resumed.status, "complete");
  assert.deepEqual(resumed.steps.map((step) => step.status), ["complete", "complete", "complete", "complete"]);
  assert.equal(resumed.steps[0]?.output?.handoff, "Scout mapped README and src.");
  assert.match(resumed.warnings.join("\n"), /Resumed paused pi-chalin run/);
  assert.match(fs.readFileSync(resumed.logsPath!, "utf-8"), /Synthesize final answer/);
});

test("loadResumableRunState recovers latest paused or stale running run from disk", () => {
  const cwd = tempDir("pi-chalin-resumable-load-");
  const paused = createRunState({
    kind: "multi-agent-sequential",
    agents: ["scout", "reviewer"],
    risk: "low",
    ambiguity: "low",
    needsMemory: false,
    needsArtifacts: true,
    reason: "paused",
    plan: { kind: "sequential", steps: [{ agent: "scout", task: "scan" }, { agent: "reviewer", task: "review" }] },
  }, cwd);
  paused.status = "paused";
  paused.steps[0]!.status = "complete";
  paused.steps[0]!.output = { agent: "scout", text: "done", handoff: "done", memoryCandidates: [], raw: "done", warnings: [] };
  paused.steps[1]!.status = "paused";
  fs.mkdirSync(path.dirname(paused.logsPath!), { recursive: true });
  fs.writeFileSync(paused.logsPath!, `${JSON.stringify(paused, null, 2)}\n`);

  const loaded = loadResumableRunState({ cwd });

  assert.equal(loaded?.id, paused.id);
  assert.equal(loaded?.status, "paused");

  const stale = createRunState(paused.route, cwd);
  stale.status = "running";
  stale.steps[0]!.status = "complete";
  stale.steps[0]!.output = { agent: "scout", text: "done", handoff: "done", memoryCandidates: [], raw: "done", warnings: [] };
  stale.steps[1]!.status = "running";
  fs.writeFileSync(stale.logsPath!, `${JSON.stringify(stale, null, 2)}\n`);

  const loadedStale = loadResumableRunState({ cwd, runId: stale.id });
  assert.equal(loadedStale?.status, "paused");
  assert.match(loadedStale?.warnings.join("\n") ?? "", /Recovered stale running run/);

  const completedStale = createRunState(paused.route, cwd);
  completedStale.status = "running";
  completedStale.steps[0]!.status = "complete";
  completedStale.steps[0]!.output = { agent: "scout", text: "done", handoff: "done", memoryCandidates: [], raw: "done", warnings: [] };
  completedStale.steps[1]!.status = "complete";
  completedStale.steps[1]!.output = { agent: "reviewer", text: "reviewed", handoff: "reviewed", memoryCandidates: [], raw: "reviewed", warnings: [] };
  fs.writeFileSync(completedStale.logsPath!, `${JSON.stringify(completedStale, null, 2)}\n`);

  const loadedCompletedStale = loadResumableRunState({ cwd, runId: completedStale.id });
  assert.equal(loadedCompletedStale?.status, "paused");
  assert.deepEqual(loadedCompletedStale?.steps.map((step) => step.status), ["complete", "complete"]);
});

test("loadFailedRunDiagnostic explains failed runs instead of pretending no run exists", () => {
  const cwd = tempDir("pi-chalin-failed-diagnostic-");
  const route: RouteDecision = {
    kind: "multi-agent-sequential",
    agents: ["worker", "reviewer"],
    risk: "medium",
    ambiguity: "low",
    needsMemory: false,
    needsArtifacts: true,
    expectedEffects: ["read", "write", "verify"],
    reason: "failed route",
    plan: { kind: "sequential", steps: [{ agent: "worker", task: "Implement." }, { agent: "reviewer", task: "Review." }] },
  };
  const run = createRunState(route, cwd);
  run.status = "failed";
  run.steps[0]!.status = "failed";
  run.steps[0]!.error = "structured handoff missing verification";
  persistRun(run);

  const diagnostic = loadFailedRunDiagnostic({ cwd });

  assert.equal(diagnostic?.run.id, run.id);
  assert.match(diagnostic?.message ?? "", /Latest matching run failed/);
  assert.match(diagnostic?.message ?? "", /worker\/step-1/);
  assert.match(diagnostic?.message ?? "", /repair options/i);
});

test("prepareRunForResume resets interrupted work but keeps completed handoffs", () => {
  const cwd = tempDir("pi-chalin-prepare-resume-");
  const run = createRunState({
    kind: "multi-agent-sequential",
    agents: ["scout", "reviewer"],
    risk: "low",
    ambiguity: "low",
    needsMemory: false,
    needsArtifacts: true,
    reason: "resume",
    plan: { kind: "sequential", steps: [{ agent: "scout", task: "scan" }, { agent: "reviewer", task: "review" }] },
  }, cwd);
  run.status = "paused";
  run.endedAt = new Date().toISOString();
  run.steps[0]!.status = "complete";
  run.steps[0]!.output = { agent: "scout", text: "done", handoff: "done", memoryCandidates: [], raw: "done", warnings: [] };
  run.steps[1]!.status = "paused";
  run.steps[1]!.error = "stopped";
  run.steps[1]!.endedAt = new Date().toISOString();

  prepareRunForResume(run);

  assert.equal(run.status, "running");
  assert.equal(run.endedAt, undefined);
  assert.equal(run.steps[0]?.status, "complete");
  assert.equal(run.steps[1]?.status, "pending");
  assert.equal(run.steps[1]?.error, undefined);
});

test("SDK DAG can continue synthesis after a partial read-only fan-out idle stall", () => {
  const agents = new Map([
    ["context-builder", readOnlyAgent("context-builder")],
    ["reviewer", readOnlyAgent("reviewer", "review")],
  ]);

  const shouldStop = shouldStopAfterDagStage([
    { agent: "context-builder", status: "failed", error: "SDK runner idle stalled for context-builder after 90000ms without activity" },
    {
      agent: "context-builder",
      status: "complete",
      output: { agent: "context-builder", text: "Frontend mapped", handoff: "Frontend mapped.", memoryCandidates: [], raw: "", warnings: [] },
    },
    {
      agent: "reviewer",
      status: "complete",
      output: { agent: "reviewer", text: "Docs reviewed", handoff: "Docs reviewed.", memoryCandidates: [], raw: "", warnings: [] },
    },
  ], agents);

  assert.equal(shouldStop, false);
});

test("SDK DAG converts recoverable read-only idle pauses into coverage gaps before synthesis", () => {
  const agents = new Map([
    ["researcher", readOnlyAgent("researcher", "research")],
    ["reviewer", readOnlyAgent("reviewer", "review")],
  ]);
  const stageSteps: RunState["steps"] = [
    {
      id: "evidence:researcher",
      agent: "researcher",
      task: "Research external context.",
      status: "paused",
      pauseReason: "idle-stall",
      error: "SDK runner idle stalled for researcher after 120000ms without activity",
    },
    {
      id: "evidence:reviewer",
      agent: "reviewer",
      task: "Review local evidence.",
      status: "complete",
      output: { agent: "reviewer", text: "Local evidence reviewed.", handoff: "Local evidence reviewed.", memoryCandidates: [], raw: "", warnings: [] },
    },
  ];

  const recovered = recoverPausedReadOnlyDagStage(stageSteps, agents);

  assert.equal(recovered, 1);
  assert.equal(stageSteps[0]?.status, "failed");
  assert.equal(stageSteps[0]?.pauseReason, undefined);
  assert.equal(shouldStopAfterDagStage(stageSteps, agents), false);
});

test("SDK DAG keeps writer idle pauses resumable instead of synthesizing unsafe partial work", () => {
  const agents = new Map([
    ["worker", agent("worker", ["inspect-files", "edit-files"])],
    ["reviewer", readOnlyAgent("reviewer", "review")],
  ]);
  const stageSteps: RunState["steps"] = [
    {
      id: "implementation:worker",
      agent: "worker",
      task: "Edit files.",
      status: "paused",
      pauseReason: "idle-stall",
      error: "SDK runner idle stalled for worker after 120000ms without activity",
    },
    {
      id: "implementation:reviewer",
      agent: "reviewer",
      task: "Review design.",
      status: "complete",
      output: { agent: "reviewer", text: "Review partial.", handoff: "Review partial.", memoryCandidates: [], raw: "", warnings: [] },
    },
  ];

  const recovered = recoverPausedReadOnlyDagStage(stageSteps, agents);

  assert.equal(recovered, 0);
  assert.equal(stageSteps[0]?.status, "paused");
  assert.equal(shouldStopAfterDagStage(stageSteps, agents), true);
});

test("SDK child idle guard is based on idle time, not total wall-clock while a tool is active", async () => {
  let active = 1;
  const result = await runWithIdleStallMonitor(
    new Promise<string>((resolve) => setTimeout(() => {
      active = 0;
      resolve("finished");
    }, 55)),
    {
      idleStallMs: 20,
      pollMs: 5,
      message: "idle guard",
      activeOperations: () => active,
    },
  );

  assert.equal(result, "finished");
});

test("SDK child idle guard rejects when no tool or message activity occurs", async () => {
  await assert.rejects(
    runWithIdleStallMonitor(new Promise(() => undefined), {
      idleStallMs: 20,
      pollMs: 5,
      message: "idle guard",
      activeOperations: () => 0,
    }),
    /idle guard after 20ms without activity/,
  );
});

test("SDK child idle stall window defaults to 120s and scales with thinking inside step budget", () => {
  const previousStall = process.env.PI_CHALIN_SDK_STEP_IDLE_STALL_MS;
  try {
    delete process.env.PI_CHALIN_SDK_STEP_IDLE_STALL_MS;
    assert.equal(DEFAULT_SDK_STEP_IDLE_STALL_MS, 120_000);
    assert.equal(sdkStepIdleStallMs(), DEFAULT_SDK_STEP_IDLE_STALL_MS);
    assert.equal(sdkStepIdleStallMs({ thinkingLevel: "minimal", budgetMaxSeconds: 900 }), DEFAULT_SDK_STEP_IDLE_STALL_MS);
    assert.equal(sdkStepIdleStallMs({ thinkingLevel: "high", budgetMaxSeconds: 900 }), 480_000);
    assert.equal(sdkStepIdleStallMs({ thinkingLevel: "high", budgetMaxSeconds: 180 }), 180_000);

    process.env.PI_CHALIN_SDK_STEP_IDLE_STALL_MS = "45000";
    assert.equal(sdkStepIdleStallMs({ thinkingLevel: "high", budgetMaxSeconds: 900 }), 45_000);
  } finally {
    if (previousStall === undefined) delete process.env.PI_CHALIN_SDK_STEP_IDLE_STALL_MS;
    else process.env.PI_CHALIN_SDK_STEP_IDLE_STALL_MS = previousStall;
  }
});

test("SDK DAG stops after writer failures to avoid unsafe partial merges", () => {
  const agents = new Map([
    ["worker", agent("worker", ["inspect-files", "edit-files"])],
    ["reviewer", readOnlyAgent("reviewer", "review")],
  ]);

  const shouldStop = shouldStopAfterDagStage([
    { agent: "worker", status: "failed", error: "patch failed" },
    {
      agent: "reviewer",
      status: "complete",
      output: { agent: "reviewer", text: "Review done", handoff: "Review done.", memoryCandidates: [], raw: "", warnings: [] },
    },
  ], agents);

  assert.equal(shouldStop, true);
});

test("isolated worktree merge declarations exclude failed or fatal-policy steps", () => {
  const complete = {
    id: "fanout:step-1",
    agent: "worker",
    task: "Implement safe unit.",
    status: "complete",
    output: parseAgentOutput("worker", `## Agent Handoff\n${JSON.stringify({ summary: "done", changedFiles: ["src/ok.ts"], verification: ["readback"], evidenceClaims: [], risks: [], nextActions: [] })}`),
  } satisfies RunStepState;
  const failed = {
    id: "fanout:step-2",
    agent: "worker",
    task: "Failed unit.",
    status: "failed",
    output: parseAgentOutput("worker", `## Agent Handoff\n${JSON.stringify({ summary: "failed", changedFiles: ["src/failed.ts"], verification: ["readback"], evidenceClaims: [], risks: [], nextActions: [] })}`),
  } satisfies RunStepState;
  const fatalPolicy = {
    id: "fanout:step-3",
    agent: "worker",
    task: "Fatal policy unit.",
    status: "complete",
    metrics: stepMetrics({ policyViolations: ["outside_work_unit_scope:generated.lock"] }),
    output: parseAgentOutput("worker", `## Agent Handoff\n${JSON.stringify({ summary: "done", changedFiles: ["generated.lock"], verification: ["readback"], evidenceClaims: [], risks: [], nextActions: [] })}`),
  } satisfies RunStepState;

  const declared = declaredFilesByIsolatedStepId([complete, failed, fatalPolicy]);

  assert.deepEqual([...declared.entries()], [["step-1", ["src/ok.ts"]]]);
});

test("recovered read-only DAG failures do not poison the final run status", () => {
  const agents = new Map([
    ["context-builder", readOnlyAgent("context-builder")],
    ["reviewer", readOnlyAgent("reviewer", "review")],
  ]);
  const run: Pick<RunState, "steps"> = {
    steps: [
      { id: "discover:step-1", agent: "context-builder", task: "Map project.", status: "complete", output: { agent: "context-builder", text: "map", handoff: "map", memoryCandidates: [], raw: "", warnings: [] } },
      { id: "fanout:step-1", agent: "context-builder", task: "Analyze backend.", status: "failed", error: "SDK runner idle stalled for context-builder after 90000ms without activity" },
      { id: "fanout:step-2", agent: "context-builder", task: "Analyze UI.", status: "complete", output: { agent: "context-builder", text: "ui", handoff: "ui", memoryCandidates: [], raw: "", warnings: [] } },
      { id: "synthesis:step-1", agent: "context-builder", task: "Synthesize.", status: "complete", output: { agent: "context-builder", text: "final", handoff: "final", memoryCandidates: [], raw: "", warnings: [] } },
    ],
  };

  assert.equal(hasUnrecoverableFailedSteps(run, agents), false);
});

test("unrecovered read-only DAG failures remain failed until a downstream stage synthesizes", () => {
  const agents = new Map([["context-builder", readOnlyAgent("context-builder")]]);
  const run: Pick<RunState, "steps"> = {
    steps: [
      { id: "discover:step-1", agent: "context-builder", task: "Map project.", status: "complete", output: { agent: "context-builder", text: "map", handoff: "map", memoryCandidates: [], raw: "", warnings: [] } },
      { id: "fanout:step-1", agent: "context-builder", task: "Analyze backend.", status: "failed", error: "SDK runner idle stalled for context-builder after 90000ms without activity" },
      { id: "fanout:step-2", agent: "context-builder", task: "Analyze UI.", status: "complete", output: { agent: "context-builder", text: "ui", handoff: "ui", memoryCandidates: [], raw: "", warnings: [] } },
    ],
  };

  assert.equal(hasUnrecoverableFailedSteps(run, agents), true);
});

test("terminalRunStatusForSteps completes when an early checkpoint is superseded by later usable handoffs", () => {
  const agents = new Map([
    ["scout", readOnlyAgent("scout")],
    ["planner", readOnlyAgent("planner", "planning")],
    ["worker", agent("worker", ["edit-files"])],
    ["reviewer", readOnlyAgent("reviewer", "review")],
  ]);
  const run: Pick<RunState, "steps"> = {
    steps: [
      {
        id: "discover:step-1",
        agent: "scout",
        task: "Scout workspace.",
        status: "checkpointed",
        checkpoint: { kind: "handoff-contract", continuation: "resume", reason: "Missing structured handoff." },
      },
      { id: "plan:step-1", agent: "planner", task: "Plan work units.", status: "complete", output: { agent: "planner", text: "plan", handoff: "plan", memoryCandidates: [], raw: "", warnings: [] } },
      { id: "implement:step-1", agent: "worker", task: "Implement unit.", status: "complete", output: { agent: "worker", text: "done", handoff: "done", memoryCandidates: [], raw: "", warnings: [] } },
      { id: "review:step-1", agent: "reviewer", task: "Review unit.", status: "complete", output: { agent: "reviewer", text: "pass", handoff: "pass", memoryCandidates: [], raw: "", warnings: [] } },
    ],
  };

  assert.equal(hasBlockingCheckpointedSteps(run), false);
  assert.equal(terminalRunStatusForSteps(run, agents), "complete");
});

test("terminalRunStatusForSteps pauses when the final useful handoff is checkpointed", () => {
  const agents = new Map([
    ["worker", agent("worker", ["edit-files"])],
    ["reviewer", readOnlyAgent("reviewer", "review")],
  ]);
  const run: Pick<RunState, "steps"> = {
    steps: [
      { id: "implement:step-1", agent: "worker", task: "Implement unit.", status: "complete", output: { agent: "worker", text: "done", handoff: "done", memoryCandidates: [], raw: "", warnings: [] } },
      {
        id: "review:step-1",
        agent: "reviewer",
        task: "Review unit.",
        status: "checkpointed",
        checkpoint: { kind: "budget-cap", continuation: "continue", reason: "Review hit budget before verdict." },
      },
    ],
  };

  assert.equal(hasBlockingCheckpointedSteps(run), true);
  assert.equal(terminalRunStatusForSteps(run, agents), "paused");
});

test("parseAgentOutput accepts richer memory categories for long-running work", () => {
  const output = parseAgentOutput("planner", "## Memory Candidates\n- testing: This project runs regression tests with bun:test and isolated temp directories, so feature tests should not share filesystem state.\n- workflow: Long-running chalin features should checkpoint handoffs and validation contracts after each stage so later agents can resume safely.");
  assert.deepEqual(output.memoryCandidates.map((candidate) => candidate.category), ["testing", "workflow"]);
});

test("parseAgentOutput preserves larger scout handoffs for downstream synthesis", () => {
  const longHandoff = `## Handoff\n${"Evidence path src/index.ts supports runtime entrypoint. ".repeat(45)}\n## Memory Candidates\n- None.`;
  const scout = parseAgentOutput("scout", longHandoff);
  const worker = parseAgentOutput("worker", longHandoff);
  assert.ok((scout.handoff?.length ?? 0) > 1800);
  assert.ok((worker.handoff?.length ?? 0) <= 1200);
});

test("buildSdkPrompt compresses repeated policy when previous handoff is available", () => {
  const agent: AgentDefinition = {
    name: "context-builder",
    scope: "built-in",
    concern: "context-building",
    capabilities: ["inspect-files", "search-files", "memory-read", "memory-write"],
    description: "Packages repo facts for the next agent.",
    model: "inherit",
    budget: { baseToolCalls: 60 },
    tools: [],
    memory: { read: true, write: "candidate", categories: [] },
    systemPrompt: "You are verbose.\n\nRules:\n- Keep facts.\n- Do not edit.\n\nTool discipline:\n- duplicated tool rule.\n\nStop condition:\n- duplicated stop.",
    diagnostics: [],
  };
  const prompt = buildSdkPrompt(agent, "Summarize scout handoff.", tempDir("pi-chalin-prompt-"), "Scout found package.json and src/index.ts.");
  assert.match(prompt, /Packages repo facts/);
  assert.match(prompt, /Previous Handoff/);
  assert.match(prompt, /Discovery index omitted/i);
  assert.doesNotMatch(prompt, /duplicated tool rule/);
  assert.ok(prompt.length < 6500, `prompt should stay compact, got ${prompt.length}`);
});

test("buildSdkPrompt injects compact memory context without bloating discovery", () => {
  const agent: AgentDefinition = {
    name: "worker",
    scope: "built-in",
    concern: "implementation",
    capabilities: ["inspect-files", "search-files", "memory-read", "memory-write"],
    description: "Implements scoped changes.",
    model: "inherit",
    tools: [],
    memory: { read: true, write: "candidate", categories: [] },
    systemPrompt: "",
    diagnostics: [],
  };
  const prompt = buildSdkPrompt(
    agent,
    "Fix async retry tests.",
    tempDir("pi-chalin-memory-prompt-"),
    undefined,
    80,
    "normal",
    { memoryContext: "Memory context (1 records, <=120 token budget). Treat as guidance; current repo evidence wins.\n- [memory-1 · testing · 95%] Project tests use Bun and avoid setTimeout sleeps." },
  );

  assert.match(prompt, /edit existing; write new paths/i);
  assert.match(prompt, /git; edit existing/i);
  assert.match(prompt, /block git mutate/i);
  assert.match(prompt, /autonomous memory policy/i);
  assert.match(prompt, /Compact Memory Context/);
  assert.match(prompt, /Changed:/);
  assert.match(prompt, /Verification:/);
  assert.match(prompt, /exact implementation and test\/evidence source paths/i);
  assert.match(prompt, /Never write only local\/existing tests/i);
  assert.match(prompt, /derive the contract from prompt\+repo evidence/i);
  assert.match(prompt, /Tests are contract oracles/i);
  assert.match(prompt, /one meaningful boundary\/counterexample/i);
  assert.match(prompt, /Domain contracts/i);
  assert.match(prompt, /use active Skills/i);
  assert.match(prompt, /do not invent/i);
  assert.match(prompt, /Preserve public compatibility/i);
  assert.match(prompt, /Code behavior changes update nearest tests/i);
  assert.match(prompt, /Coverage breadth/i);
  assert.match(prompt, /separate compact tests per rule/i);
  assert.match(prompt, /evidence-only tests/i);
  assert.match(prompt, /runner-discoverable cases/i);
  assert.match(prompt, /zero-test assertion scripts/i);
  assert.doesNotMatch(prompt, /Scaffold\/package work/i);
  assert.doesNotMatch(prompt, /Parser\/scanner\/state-machine changes/i);
  assert.doesNotMatch(prompt, /Sorting\/normalization contracts/i);
  assert.doesNotMatch(prompt, /Normalization\/key APIs need 8-12/i);
  assert.doesNotMatch(prompt, /Bun `setSystemTime`/i);
  assert.doesNotMatch(prompt, /scoped Date\.now restore/i);
  assert.doesNotMatch(prompt, /internal test seams or runner-native fake time/i);
  assert.match(prompt, /resource escape hatches/i);
  assert.match(prompt, /arbitrary fixed caps/i);
  assert.match(prompt, /small evidence/i);
  assert.match(prompt, /one impl\/test edit/i);
  assert.match(prompt, /avoid micro-edits/i);
  assert.match(prompt, /smallest exact block/i);
  assert.match(prompt, /one corrective edit\/fail/i);
  assert.match(prompt, /After pass, one readback/i);
  assert.match(prompt, /exact named command/i);
  assert.match(prompt, /Project tests use Bun/);
  assert.ok(prompt.length < 7000, `prompt should stay compact, got ${prompt.length}`);
});

test("buildSdkPrompt keeps domain contracts out of the base prompt and injects them through active skills", () => {
  const agent: AgentDefinition = {
    name: "worker",
    scope: "built-in",
    concern: "implementation",
    capabilities: ["inspect-files", "search-files", "edit-files", "run-safe-bash", "validate"],
    description: "Implements scoped changes.",
    model: "inherit",
    tools: [],
    memory: { read: false, write: "never", categories: [] },
    systemPrompt: "",
    diagnostics: [],
  };

  const task = "Fix SQL tokenizer string literal comments, delimiter adjacency, EOF behavior, and package CLI tests.";
  const basePrompt = buildSdkPrompt(agent, task, tempDir("pi-chalin-base-contract-"));
  assert.doesNotMatch(basePrompt, /Parser, scanner, tokenizer, and state-machine work/i);
  assert.doesNotMatch(basePrompt, /Scaffold, package, CLI, and entrypoint work/i);
  assert.doesNotMatch(basePrompt, /Normalization, sorting, filtering, and key-builder work/i);
  assert.doesNotMatch(basePrompt, /Time, retry, cache, rate, budget, and window behavior/i);

  const activeSkills = activeSkillsFor(task, agent);
  assert.ok(activeSkills.some(({ skill }) => skill.name === "implementation-contract-edges"));
  const skilledPrompt = buildSdkPrompt(agent, task, tempDir("pi-chalin-skill-contract-"), undefined, 80, "normal", { activeSkills });
  assert.match(skilledPrompt, /implementation-contract-edges/i);
  assert.match(skilledPrompt, /Parser, scanner, tokenizer, and state-machine work names changed states\/transitions/i);
  assert.match(skilledPrompt, /tests changed boundaries, termination, protected spans, and error\/EOF behavior/i);
  assert.match(skilledPrompt, /Scaffold, package, CLI, and entrypoint work keeps metadata/i);
  assert.match(skilledPrompt, /real command path/i);
});

test("buildSdkPrompt preserves the original user goal across routed step prompts", () => {
  const agent: AgentDefinition = {
    name: "worker",
    scope: "built-in",
    concern: "implementation",
    capabilities: ["inspect-files", "search-files", "edit-files"],
    description: "Implements scoped changes.",
    model: "inherit",
    tools: [],
    memory: { read: false, write: "never", categories: [] },
    systemPrompt: "",
    diagnostics: [],
  };
  const prompt = buildSdkPrompt(
    agent,
    "Update the docs artifact with the requested fields.",
    tempDir("pi-chalin-root-task-prompt-"),
    "Scout found a neighboring identity issue.",
    25,
    "tight",
    { rootTask: "Analyze duplicate packages when workspace paths mix Windows/POSIX separators. Do not change code." },
  );

  assert.match(prompt, /Original User Goal/);
  assert.match(prompt, /workspace paths mix Windows\/POSIX separators/i);
  assert.match(prompt, /Original User Goal below is the contract/i);
  assert.match(prompt, /preserve the user's exact failure trigger/i);
});

test("buildSdkPrompt puts context-builder into handoff-first gap-read mode", () => {
  const agent: AgentDefinition = {
    name: "context-builder",
    scope: "built-in",
    concern: "context-building",
    capabilities: ["inspect-files", "search-files", "memory-read", "memory-write"],
    description: "Packages repo facts for the next agent.",
    model: "inherit",
    tools: [],
    memory: { read: true, write: "candidate", categories: [] },
    systemPrompt: "",
    diagnostics: [],
  };

  const prompt = buildSdkPrompt(
    agent,
    "A partir del handoff del scout, sintetiza qué hace el proyecto en profundidad.",
    tempDir("pi-chalin-gap-read-prompt-"),
    "Coverage Matrix: runtime covered with evidence in src/index.ts.",
    120,
    "deep",
    { priorFilesRead: ["package.json", "src/index.ts"], synthesisGapReadLimit: 7 },
  );

  assert.match(prompt, /Handoff-first synthesis/i);
  assert.match(prompt, /at most 7 gap reads/i);
  assert.match(prompt, /Already Covered Evidence Paths/);
  assert.match(prompt, /src\/index\.ts/);
  assert.match(prompt, /primary evidence map/i);
  assert.match(prompt, /Context handoff completeness/i);
  assert.match(prompt, /follow imports, callers, tests, fixtures, config, docs, and adjacent patterns/i);
  assert.match(prompt, /do not omit a domain-critical file\/source just to keep the handoff short/i);
});

test("buildSdkPrompt puts reviewer into sampled audit mode after handoff", () => {
  const agent: AgentDefinition = {
    name: "reviewer",
    scope: "built-in",
    concern: "review",
    capabilities: ["inspect-files", "search-files", "validate"],
    description: "Reviews synthesized repo facts.",
    model: "inherit",
    tools: [],
    memory: { read: false, write: "never", categories: [] },
    systemPrompt: "",
    diagnostics: [],
  };

  const prompt = buildSdkPrompt(
    agent,
    "Review risks/gaps in this deep project analysis.",
    tempDir("pi-chalin-review-gap-prompt-"),
    "Coverage Matrix: runtime covered with evidence in nuxt.config.js; auth covered in middleware/auth.js.",
    120,
    "deep",
    { priorFilesRead: ["nuxt.config.js", "middleware/auth.js"], synthesisGapReadLimit: 5 },
  );

  assert.match(prompt, /Handoff-first review/i);
  assert.match(prompt, /sample only the highest-risk/i);
  assert.match(prompt, /re-read the exact covered file or region once/i);
  assert.match(prompt, /at most 5 gap reads/i);
  assert.match(prompt, /Already Covered Evidence Paths/);
  assert.match(prompt, /middleware\/auth\.js/);
});

test("buildSdkPrompt includes sorting contracts only through active skills", () => {
  const agent: AgentDefinition = {
    name: "worker",
    scope: "built-in",
    concern: "implementation",
    capabilities: ["inspect-files", "edit-files", "run-safe-bash", "validate"],
    description: "Implements bounded changes.",
    model: "inherit",
    tools: [],
    memory: { read: false, write: "never", categories: [] },
    systemPrompt: "",
    diagnostics: [],
  };
  const task = "Implement a deterministic key builder that sorts markers while preserving case and duplicates.";

  const basePrompt = buildSdkPrompt(
    agent,
    task,
    tempDir("pi-chalin-impl-sort-contract-"),
    undefined,
    80,
    "normal",
    { rootTask: "Sort markers, preserve case and duplicates, and cover it with tests." },
  );

  assert.doesNotMatch(basePrompt, /Sorting\/normalization contracts/i);
  assert.doesNotMatch(basePrompt, /language's normal lexicographic\/ordinal comparison/i);
  assert.doesNotMatch(basePrompt, /Do not lowercase\/casefold a preserved value/i);
  assert.match(basePrompt, /Domain contracts/i);
  assert.match(basePrompt, /use active Skills/i);
  assert.match(basePrompt, /do not invent/i);

  const activeSkills = activeSkillsFor(task, agent);
  const skilledPrompt = buildSdkPrompt(agent, task, tempDir("pi-chalin-impl-sort-skill-contract-"), undefined, 80, "normal", {
    rootTask: "Sort markers, preserve case and duplicates, and cover it with tests.",
    activeSkills,
  });
  assert.match(skilledPrompt, /Normalization, sorting, filtering, and key-builder work separates trim\/blank handling/i);
  assert.match(skilledPrompt, /preservation, duplicates, ordering, no-op\/invalid behavior, and composition\/determinism/i);
  assert.match(skilledPrompt, /Public API contract comments/i);
});

test("review-only final gate does not activate for implementation workers from routed root goals", () => {
  const worker: AgentDefinition = {
    name: "worker",
    scope: "built-in",
    concern: "implementation",
    capabilities: ["inspect-files", "search-files", "edit-files", "write-new-files", "run-safe-bash", "validate"],
    description: "Implements bounded changes.",
    model: "inherit",
    tools: [],
    memory: { read: false, write: "never", categories: [] },
    systemPrompt: "",
    diagnostics: [],
  };

  const activeSkills = activeSkillsFor("Implement a bounded unit, then review each unit and synthesize fan-in.", worker);

  assert.equal(activeSkills.some(({ skill }) => skill.name === "review-final-gate"), false);
});

test("buildSdkPrompt makes implementation scouting and worker handoffs audit test sufficiency", () => {
  const scout: AgentDefinition = {
    name: "scout",
    scope: "built-in",
    concern: "recon",
    capabilities: ["inspect-files", "search-files", "run-safe-bash"],
    description: "Maps implementation evidence.",
    model: "inherit",
    tools: [],
    memory: { read: false, write: "never", categories: [] },
    systemPrompt: "",
    diagnostics: [],
  };
  const worker: AgentDefinition = {
    name: "worker",
    scope: "built-in",
    concern: "implementation",
    capabilities: ["inspect-files", "search-files", "edit-files", "run-safe-bash", "validate"],
    description: "Implements scoped changes.",
    model: "inherit",
    tools: [],
    memory: { read: false, write: "never", categories: [] },
    systemPrompt: "",
    diagnostics: [],
  };

  const rootTask = "Fix parser handling and add tests for comments, quoted strings, adjacency, and EOF behavior.";
  const scoutPrompt = buildSdkPrompt(scout, "Map source and tests before implementation.", tempDir("pi-chalin-scout-test-map-"), undefined, 40, "normal", { rootTask });
  assert.match(scoutPrompt, /Goal-aware scouting/i);
  assert.match(scoutPrompt, /map the source, tests, fixtures, config, docs, and verification evidence/i);
  assert.match(scoutPrompt, /Do not declare coverage sufficient without direct evidence/i);
  assert.doesNotMatch(scoutPrompt, /Implementation scouting/i);

  const workerPrompt = buildSdkPrompt(worker, "Implement from scout handoff.", tempDir("pi-chalin-worker-test-map-"), "Scout says tests are correct as-is.", 40, "normal", { rootTask });
  assert.match(workerPrompt, /Upstream handoffs are context, not authority/i);
  assert.match(workerPrompt, /compare Original User Goal criteria/i);
});

test("buildSdkPrompt injects write and verification handoff contracts from route effects", () => {
  const worker: AgentDefinition = {
    name: "worker",
    scope: "built-in",
    concern: "implementation",
    capabilities: ["inspect-files", "search-files", "edit-files", "write-new-files", "run-safe-bash", "validate"],
    description: "Implements scoped changes.",
    model: "inherit",
    tools: [],
    memory: { read: false, write: "never", categories: [] },
    systemPrompt: "",
    diagnostics: [],
  };

  const readOnlyPrompt = buildSdkPrompt(worker, "Implement and verify the assigned unit.", tempDir("pi-chalin-worker-read-contract-"), undefined, 40, "normal", { expectedEffects: ["read"] });
  const mutatingPrompt = buildSdkPrompt(worker, "Implement the assigned unit.", tempDir("pi-chalin-worker-route-contract-"), undefined, 40, "normal", { expectedEffects: ["read", "write", "verify"] });

  assert.doesNotMatch(readOnlyPrompt, /Runtime write contract/i);
  assert.doesNotMatch(readOnlyPrompt, /Runtime verification contract/i);
  assert.match(mutatingPrompt, /Runtime write contract/i);
  assert.match(mutatingPrompt, /changedFiles` lists every path personally edited/i);
  assert.match(mutatingPrompt, /Runtime verification contract/i);
  assert.match(mutatingPrompt, /empty verification fails verification-responsible steps/i);
  assert.match(mutatingPrompt, /Verification setup hygiene/i);
  assert.match(mutatingPrompt, /Clean transient outputs before handoff/i);
  assert.match(mutatingPrompt, /dependency manifests, lockfiles, and checksum artifacts/i);
  assert.match(mutatingPrompt, /behavior\/API is missing/i);
  assert.match(mutatingPrompt, /next human decision/i);
  assert.match(mutatingPrompt, /do not invent/i);
  assert.match(mutatingPrompt, /do not weaken tests or downgrade unmet required behavior to residual risk/i);
  assert.match(mutatingPrompt, /scratch in cwd/i);
});

test("buildSdkPrompt makes implementation reviewers audit plan gaps instead of rubber-stamping tests", () => {
  const agent: AgentDefinition = {
    name: "reviewer",
    scope: "built-in",
    concern: "review",
    capabilities: ["inspect-files", "search-files", "validate"],
    description: "Reviews implementation output.",
    model: "inherit",
    tools: [],
    memory: { read: false, write: "never", categories: [] },
    systemPrompt: "",
    diagnostics: [],
  };

  const prompt = buildSdkPrompt(
    agent,
    "Verify the worker implementation and tests.",
    tempDir("pi-chalin-review-impl-contract-"),
    "Worker changed src/key.rs and says tests pass. Planner contract said sort original values lexicographically.",
    80,
    "normal",
    { rootTask: "Implement a key builder that preserves marker case and duplicates." },
  );

  assert.match(prompt, /Implementation review gate/i);
  assert.match(prompt, /worker deviation from a locked plan is a finding/i);
  assert.match(prompt, /Passing visible tests prove only observed behavior/i);
  assert.match(prompt, /Review contract-preserving transformations carefully/i);
  assert.match(prompt, /lossy conversions are defects unless explicitly requested or evidenced/i);
  assert.match(prompt, /Review economy/i);
  assert.match(prompt, /re-read only changed\/high-risk files/i);
  assert.match(prompt, /Reviewer verdict is structured/i);
  assert.match(prompt, /## Agent Handoff` is a REQUIRED runtime contract/i);
  assert.match(prompt, /Writers fill changedFiles; verify steps fill verification/i);
  assert.doesNotMatch(prompt, /Return a concise result with these sections when useful/i);
  assert.match(prompt, /## Reviewer Verdict/i);
  assert.match(prompt, /blockingFindings, missingCoverage, evidence, residualRisks, and requiredRepair/i);
  assert.match(prompt, /blockingFindings, missingCoverage, and requiredRepair MUST be empty/i);
  assert.match(prompt, /Evidence items are structured records/i);
  assert.match(prompt, /kind:"reviewed-content"/i);
  assert.match(prompt, /kind:"verification"/i);
  assert.match(prompt, /Review unavailable optional verification carefully/i);
  assert.match(prompt, /block only when the Original User Goal, planner acceptance criteria, or discovered repo commands require it/i);
  assert.match(prompt, /non-blocking concern in residualRisks/i);
  assert.match(prompt, /Residual risks are only for optional or future-hardening concerns/i);
  assert.match(prompt, /contradicts an explicit Original User Goal guarantee/i);
});

test("buildSdkPrompt asks discovery planners for verifiable WorkUnits without case-specific fanout rules", () => {
  const planner: AgentDefinition = {
    name: "planner",
    scope: "built-in",
    concern: "planning",
    capabilities: ["inspect-files", "search-files"],
    description: "Plans bounded work.",
    model: "inherit",
    tools: [],
    memory: { read: false, write: "never", categories: [] },
    systemPrompt: "",
    diagnostics: [],
  };

  const prompt = buildSdkPrompt(planner, "Plan a large implementation from discovered evidence.", tempDir("pi-chalin-discover-verifiable-units-"), "Workspace inventory handoff.", 80, "normal", { workUnitStrategy: "discover" });

  assert.match(prompt, /Discovery contract/i);
  assert.match(prompt, /expectedEffects is per unit/i);
  assert.match(prompt, /Mutation units need a credible verification path/i);
  assert.match(prompt, /discovered repo commands, direct readback, or an explicitly planned verification artifact/i);
  assert.doesNotMatch(prompt, /one subagent per comment/i);
  assert.doesNotMatch(prompt, /por comentario/i);
});

test("buildSdkPrompt adds a coverage and evidence contract for deep project analysis", () => {
  const agent: AgentDefinition = {
    name: "context-builder",
    scope: "built-in",
    concern: "context-building",
    capabilities: ["inspect-files", "search-files", "memory-read", "memory-write"],
    description: "Packages repo facts for the next agent.",
    model: "inherit",
    tools: [],
    memory: { read: true, write: "candidate", categories: [] },
    systemPrompt: "",
    diagnostics: [],
  };

  const prompt = buildSdkPrompt(
    agent,
    "Revisa este proyecto en profundidad y sintetiza qué hace, módulos, riesgos y cómo se testea.",
    tempDir("pi-chalin-deep-analysis-prompt-"),
    undefined,
    120,
    "deep",
  );

  assert.match(prompt, /Deep project analysis accuracy contract/i);
  assert.match(prompt, /Coverage Matrix/i);
  assert.match(prompt, /Evidence Table/i);
  assert.match(prompt, /tests\/evals\/tooling/i);
  assert.match(prompt, /claim.+evidence/i);
});

test("childToolNames removes inspection tools for handoff-only synthesis steps", () => {
  const agent: AgentDefinition = {
    name: "context-builder",
    scope: "built-in",
    concern: "context-building",
    capabilities: ["inspect-files", "search-files", "memory-read", "memory-write"],
    description: "Synthesize context.",
    model: "inherit",
    tools: [],
    memory: { read: true, write: "candidate", categories: [] },
    systemPrompt: "",
    diagnostics: [],
  };

  assert.deepEqual(childToolNames(agent, "Synthesize scout findings into final answer material.", true, true), []);
  assert.deepEqual(childToolNames(agent, "Aggregate WorkUnit handoffs into a compact summary.", true, true, { routeKind: "multi-agent-dag" }), []);
  assert.ok(childToolNames(agent, "Save a checkpoint for this long-running feature.", true, true, { budgetProfile: "extended" }).includes("chalin_artifact_write"));
});

test("childToolNames keeps inspection tools for structured handoff claim audits", () => {
  const agent: AgentDefinition = {
    name: "context-builder",
    scope: "built-in",
    concern: "context-building",
    capabilities: ["inspect-files", "search-files", "memory-read", "memory-write"],
    description: "Synthesize context.",
    model: "inherit",
    tools: [],
    memory: { read: true, write: "candidate", categories: [] },
    systemPrompt: "",
    diagnostics: [],
  };

  const lexicalOnly = childToolNames(agent, "Reconcile contradiction in previous handoff.", true, true);
  const tools = childToolNames(agent, "Synthesize final answer material.", true, true, { previousClaimsNeedAudit: true } as never);

  assert.deepEqual(lexicalOnly, []);
  assert.ok(tools.includes("read"));
  assert.ok(tools.includes("grep"));
  assert.ok(tools.includes("find"));
});

test("synthesisCrossStepDuplicateReadLimit gives reviewers room for sampled audit", () => {
  const reviewer: AgentDefinition = {
    name: "reviewer",
    scope: "built-in",
    concern: "review",
    capabilities: ["inspect-files"],
    description: "Review implementation evidence.",
    model: "inherit",
    tools: [],
    memory: { read: false, write: "never", categories: [] },
    systemPrompt: "",
    diagnostics: [],
  };

  assert.equal(synthesisCrossStepDuplicateReadLimit(reviewer), 8);
});

test("createRunState excludes pi-chalin runtime artifacts from local git status", () => {
  const cwd = tempDir("pi-chalin-git-exclude-");
  git(cwd, ["init"]);
  const route: RouteDecision = {
    kind: "multi-agent-sequential",
    agents: ["worker"],
    risk: "medium",
    ambiguity: "low",
    needsMemory: false,
    needsArtifacts: false,
    expectedEffects: ["read", "write"],
    reason: "write in a git repo",
    plan: { kind: "sequential", steps: [{ agent: "worker", task: "Edit existing files." }] },
  };

  createRunState(route, cwd);

  const exclude = fs.readFileSync(path.join(cwd, ".git", "info", "exclude"), "utf-8");
  assert.ok(exclude.split(/\r?\n/).includes(".pi-chalin/"));
});

test("allowedToolsForStep removes write when structured WorkUnit files already exist", () => {
  const cwd = tempDir("pi-chalin-existing-unit-files-");
  fs.mkdirSync(path.join(cwd, "src"), { recursive: true });
  fs.writeFileSync(path.join(cwd, "src/a.ts"), "export const a = 1;\n");
  const run: Pick<RunState, "workUnits"> = {
    workUnits: [{
      id: "unit-a",
      title: "Unit A",
      kind: "implementation",
      status: "pending",
      scope: ["A"],
      files: ["src/a.ts"],
      dependencies: [],
      expectedEffects: ["read", "write", "verify"],
      acceptanceCriteria: ["done"],
      createdFrom: "fanout",
    }],
  };

  assert.deepEqual(allowedToolsForStep(["read", "edit", "write"], run, { workUnitId: "unit-a" }, cwd), ["read", "edit"]);
});

test("allowedToolsForStep keeps write when structured WorkUnit includes a new file", () => {
  const cwd = tempDir("pi-chalin-new-unit-files-");
  const run: Pick<RunState, "workUnits"> = {
    workUnits: [{
      id: "unit-a",
      title: "Unit A",
      kind: "implementation",
      status: "pending",
      scope: ["A"],
      files: ["src/new.ts"],
      dependencies: [],
      expectedEffects: ["read", "write", "verify"],
      acceptanceCriteria: ["done"],
      createdFrom: "fanout",
    }],
  };

  assert.deepEqual(allowedToolsForStep(["read", "edit", "write"], run, { workUnitId: "unit-a" }, cwd), ["read", "edit", "write"]);
});

test("workUnitMutationScopeForStep derives strict mutation scope from WorkUnit files", () => {
  const run: Pick<RunState, "workUnits"> = {
    workUnits: [{
      id: "unit-a",
      title: "Unit A",
      kind: "implementation",
      status: "pending",
      scope: ["A"],
      files: ["src/a.ts", "src/a.test.ts"],
      dependencies: [],
      expectedEffects: ["read", "write", "verify"],
      acceptanceCriteria: ["done"],
      createdFrom: "fanout",
    }],
  };

  assert.deepEqual(workUnitMutationScopeForStep(run, { workUnitId: "unit-a" }), {
    files: ["src/a.ts", "src/a.test.ts"],
    mode: "strict",
    bash: "allow-with-postcheck",
  });
  assert.equal(workUnitMutationScopeForStep(run, { workUnitId: "missing" }), undefined);
});

test("reconcileDeclaredGeneratedScopeViolations expands only verified generated outputs", () => {
  const route: RouteDecision = {
    kind: "multi-agent-sequential",
    agents: ["worker"],
    risk: "medium",
    ambiguity: "low",
    needsMemory: false,
    needsArtifacts: true,
    expectedEffects: ["read", "write", "verify"],
    reason: "implementation",
    plan: { kind: "sequential", steps: [{ agent: "worker", task: "Implement unit." }] },
  };
  const run = createRunState(route, tempDir("pi-chalin-reconcile-generated-scope-"));
  run.workUnits = [{
    id: "unit-a",
    title: "Unit A",
    kind: "implementation",
    status: "pending",
    scope: ["A"],
    files: ["package.json"],
    dependencies: [],
    expectedEffects: ["read", "write", "verify"],
    acceptanceCriteria: ["done"],
    createdFrom: "fanout",
  }];
  const step = run.steps[0]!;
  step.workUnitId = "unit-a";
  step.status = "complete";
  step.metrics = stepMetrics({
    filesTouched: ["package.json"],
    policyViolations: ["outside_work_unit_scope:generated.lock", "work_unit_scope_gap:tooling.toml"],
  });
  step.output = parseAgentOutput("worker", `## Agent Handoff\n${JSON.stringify({
    summary: "Generated dependency artifact from setup.",
    changedFiles: ["package.json", "generated.lock"],
    verification: ["test command passed"],
    evidenceClaims: [],
    risks: [],
    nextActions: [],
  })}`);

  const resolved = reconcileDeclaredGeneratedScopeViolations(run, step);

  assert.deepEqual(resolved, ["generated.lock"]);
  assert.deepEqual(step.metrics.policyViolations, ["work_unit_scope_gap:tooling.toml"]);
  assert.deepEqual(run.workUnits[0]?.files, ["package.json", "generated.lock"]);
  assert.match(step.output.warnings.join("\n"), /Expanded WorkUnit scope from declared generated output/);
});

test("reconcileDeclaredGeneratedScopeViolations adopts observed generated paths when handoff names them incorrectly", () => {
  const route: RouteDecision = {
    kind: "multi-agent-sequential",
    agents: ["worker"],
    risk: "medium",
    ambiguity: "low",
    needsMemory: false,
    needsArtifacts: true,
    expectedEffects: ["read", "write", "verify"],
    reason: "implementation",
    plan: { kind: "sequential", steps: [{ agent: "worker", task: "Implement setup." }] },
  };
  const run = createRunState(route, tempDir("pi-chalin-reconcile-observed-scope-"));
  run.workUnits = [{
    id: "unit-a",
    title: "Unit A",
    kind: "implementation",
    status: "pending",
    scope: ["A"],
    files: ["package.json"],
    dependencies: [],
    expectedEffects: ["read", "write", "verify"],
    acceptanceCriteria: ["done"],
    createdFrom: "fanout",
  }];
  const step = run.steps[0]!;
  step.workUnitId = "unit-a";
  step.status = "complete";
  step.metrics = stepMetrics({
    filesTouched: ["package.json"],
    policyViolations: ["outside_work_unit_scope:generated.lock"],
  });
  step.output = parseAgentOutput("worker", `## Agent Handoff\n${JSON.stringify({
    summary: "Generated dependency artifact from setup.",
    changedFiles: ["package.json", "generated.lock.old"],
    verification: ["test command passed"],
    evidenceClaims: [],
    risks: [],
    nextActions: [],
  })}`);

  assert.deepEqual(reconcileDeclaredGeneratedScopeViolations(run, step), ["generated.lock"]);
  assert.deepEqual(step.metrics.policyViolations, []);
  assert.deepEqual(run.workUnits[0]?.files, ["package.json", "generated.lock"]);
  assert.deepEqual(step.output.structuredHandoff?.changedFiles, ["package.json", "generated.lock.old", "generated.lock"]);
});

test("reconcileDeclaredGeneratedScopeViolations keeps conflicting ownership fatal", () => {
  const route: RouteDecision = {
    kind: "multi-agent-sequential",
    agents: ["worker"],
    risk: "medium",
    ambiguity: "low",
    needsMemory: false,
    needsArtifacts: true,
    expectedEffects: ["read", "write", "verify"],
    reason: "implementation",
    plan: { kind: "sequential", steps: [{ agent: "worker", task: "Implement unit." }] },
  };
  const run = createRunState(route, tempDir("pi-chalin-reconcile-conflict-scope-"));
  run.workUnits = [
    {
      id: "unit-a",
      title: "Unit A",
      kind: "implementation",
      status: "pending",
      scope: ["A"],
      files: ["package.json"],
      dependencies: [],
      expectedEffects: ["read", "write", "verify"],
      acceptanceCriteria: ["done"],
      createdFrom: "fanout",
    },
    {
      id: "unit-b",
      title: "Unit B",
      kind: "implementation",
      status: "pending",
      scope: ["B"],
      files: ["generated.lock"],
      dependencies: [],
      expectedEffects: ["read", "write", "verify"],
      acceptanceCriteria: ["done"],
      createdFrom: "fanout",
    },
  ];
  const step = run.steps[0]!;
  step.workUnitId = "unit-a";
  step.status = "complete";
  step.metrics = stepMetrics({ policyViolations: ["outside_work_unit_scope:generated.lock"] });
  step.output = parseAgentOutput("worker", `## Agent Handoff\n${JSON.stringify({
    summary: "Generated dependency artifact from setup.",
    changedFiles: ["generated.lock"],
    verification: ["test command passed"],
    evidenceClaims: [],
    risks: [],
    nextActions: [],
  })}`);

  assert.deepEqual(reconcileDeclaredGeneratedScopeViolations(run, step), []);
  assert.deepEqual(step.metrics.policyViolations, ["outside_work_unit_scope:generated.lock"]);
  assert.deepEqual(run.workUnits[0]?.files, ["package.json"]);
});

test("reconcileDeclaredGeneratedScopeViolations ignores transient dependency artifacts without manifest ownership", () => {
  const route: RouteDecision = {
    kind: "multi-agent-sequential",
    agents: ["worker"],
    risk: "medium",
    ambiguity: "low",
    needsMemory: false,
    needsArtifacts: true,
    expectedEffects: ["read", "write", "verify"],
    reason: "implementation",
    plan: { kind: "sequential", steps: [{ agent: "worker", task: "Implement unit." }] },
  };
  const run = createRunState(route, tempDir("pi-chalin-reconcile-transient-lock-"));
  run.workUnits = [
    {
      id: "unit-a",
      title: "Unit A",
      kind: "implementation",
      status: "pending",
      scope: ["A"],
      files: ["src/auth/keycloak.ts", "src/auth/keycloak.test.ts"],
      dependencies: [],
      expectedEffects: ["read", "write", "verify"],
      acceptanceCriteria: ["done"],
      createdFrom: "fanout",
    },
    {
      id: "unit-b",
      title: "Unit B",
      kind: "implementation",
      status: "pending",
      scope: ["B"],
      files: ["components/LegacyWidget.vue", "components/LegacyWidget.test.ts", "package.json"],
      dependencies: [],
      expectedEffects: ["read", "write", "verify"],
      acceptanceCriteria: ["done"],
      createdFrom: "fanout",
    },
  ];
  const step = run.steps[0]!;
  step.workUnitId = "unit-a";
  step.status = "complete";
  step.metrics = stepMetrics({
    filesTouched: ["src/auth/keycloak.ts"],
    policyViolations: ["outside_work_unit_scope:bun.lock"],
  });
  step.output = parseAgentOutput("worker", `## Agent Handoff\n${JSON.stringify({
    summary: "Installed dependencies only to verify this unit.",
    changedFiles: ["src/auth/keycloak.ts", "src/auth/keycloak.test.ts", "bun.lock"],
    verification: ["bun test src/auth/keycloak.test.ts passed"],
    evidenceClaims: [],
    risks: [],
    nextActions: [],
  })}`);

  assert.deepEqual(reconcileDeclaredGeneratedScopeViolations(run, step), []);
  assert.deepEqual(step.metrics.policyViolations, []);
  assert.deepEqual(run.workUnits[0]?.files, ["src/auth/keycloak.ts", "src/auth/keycloak.test.ts"]);
  assert.deepEqual(step.output.structuredHandoff?.changedFiles, ["src/auth/keycloak.ts", "src/auth/keycloak.test.ts"]);
  assert.match(step.output.warnings.join("\n"), /Ignored transient dependency artifact/);
});

test("reconcileDeclaredGeneratedScopeViolations expands dependency artifacts for manifest-owning units", () => {
  const route: RouteDecision = {
    kind: "multi-agent-sequential",
    agents: ["worker"],
    risk: "medium",
    ambiguity: "low",
    needsMemory: false,
    needsArtifacts: true,
    expectedEffects: ["read", "write", "verify"],
    reason: "implementation",
    plan: { kind: "sequential", steps: [{ agent: "worker", task: "Implement unit." }] },
  };
  const run = createRunState(route, tempDir("pi-chalin-reconcile-owned-lock-"));
  run.workUnits = [{
    id: "unit-a",
    title: "Unit A",
    kind: "implementation",
    status: "pending",
    scope: ["A"],
    files: ["components/LegacyWidget.vue", "components/LegacyWidget.test.ts", "package.json"],
    dependencies: [],
    expectedEffects: ["read", "write", "verify"],
    acceptanceCriteria: ["done"],
    createdFrom: "fanout",
  }];
  const step = run.steps[0]!;
  step.workUnitId = "unit-a";
  step.status = "complete";
  step.metrics = stepMetrics({
    filesTouched: ["components/LegacyWidget.test.ts", "package.json"],
    policyViolations: ["outside_work_unit_scope:bun.lock"],
  });
  step.output = parseAgentOutput("worker", `## Agent Handoff\n${JSON.stringify({
    summary: "Added dependency and verified component tests.",
    changedFiles: ["components/LegacyWidget.test.ts", "package.json", "bun.lock"],
    verification: ["bun test passed"],
    evidenceClaims: [],
    risks: [],
    nextActions: [],
  })}`);

  assert.deepEqual(reconcileDeclaredGeneratedScopeViolations(run, step), ["bun.lock"]);
  assert.deepEqual(step.metrics.policyViolations, []);
  assert.deepEqual(run.workUnits[0]?.files, ["components/LegacyWidget.vue", "components/LegacyWidget.test.ts", "package.json", "bun.lock"]);
  assert.match(step.output.warnings.join("\n"), /Expanded WorkUnit scope from declared generated output/);
});

test("reconcileDeclaredGeneratedScopeViolations ignores removed generated artifacts", () => {
  const route: RouteDecision = {
    kind: "multi-agent-sequential",
    agents: ["worker"],
    risk: "medium",
    ambiguity: "low",
    needsMemory: false,
    needsArtifacts: true,
    expectedEffects: ["read", "write", "verify"],
    reason: "implementation",
    plan: { kind: "sequential", steps: [{ agent: "worker", task: "Repair unit." }] },
  };
  const cwd = tempDir("pi-chalin-reconcile-removed-generated-");
  fs.mkdirSync(path.join(cwd, "components"), { recursive: true });
  fs.writeFileSync(path.join(cwd, "components", "LegacyWidget.test.ts"), "test\n");
  const run = createRunState(route, cwd);
  run.workUnits = [{
    id: "unit-a",
    title: "Unit A",
    kind: "implementation",
    status: "pending",
    scope: ["A"],
    files: ["components/LegacyWidget.test.ts"],
    dependencies: [],
    expectedEffects: ["read", "write", "verify"],
    acceptanceCriteria: ["done"],
    createdFrom: "fanout",
  }];
  const step = run.steps[0]!;
  step.workUnitId = "unit-a";
  step.status = "complete";
  step.metrics = stepMetrics({
    filesTouched: ["components/LegacyWidget.test.ts"],
    policyViolations: ["outside_work_unit_scope:_tmp_plugin_test.ts"],
  });
  step.output = parseAgentOutput("worker", `## Agent Handoff\n${JSON.stringify({
    summary: "Used a temporary verification script and removed it.",
    changedFiles: ["components/LegacyWidget.test.ts", "_tmp_plugin_test.ts"],
    verification: ["bun test passed; temporary script removed"],
    evidenceClaims: [],
    risks: [],
    nextActions: [],
  })}`);

  assert.deepEqual(reconcileDeclaredGeneratedScopeViolations(run, step, cwd), []);
  assert.deepEqual(step.metrics.policyViolations, []);
  assert.deepEqual(run.workUnits[0]?.files, ["components/LegacyWidget.test.ts"]);
  assert.deepEqual(step.output.structuredHandoff?.changedFiles, ["components/LegacyWidget.test.ts"]);
  assert.match(step.output.warnings.join("\n"), /Ignored removed generated artifact/);
});

test("sanitizePromptWorkspaceText maps original workspace absolute paths to relative paths for isolated workers", () => {
  const original = tempDir("pi-chalin-original-workspace-");
  const worktree = tempDir("pi-chalin-isolated-worktree-");
  const outside = tempDir("pi-chalin-outside-workspace-");
  fs.mkdirSync(path.join(original, "internal", "auth"), { recursive: true });
  fs.mkdirSync(path.join(worktree, "internal", "auth"), { recursive: true });
  fs.writeFileSync(path.join(original, "internal", "auth", "refresh.go"), "package auth\n");
  fs.writeFileSync(path.join(worktree, "internal", "auth", "refresh.go"), "package auth\n");
  fs.writeFileSync(path.join(outside, "secret.txt"), "secret\n");

  const text = [
    `Original path: ${path.join(original, "internal", "auth", "refresh.go")}.`,
    `Current path: ${path.join(worktree, "internal", "auth", "refresh.go")}.`,
    `Root: ${original}.`,
    `Outside: ${path.join(outside, "secret.txt")}.`,
  ].join(" ");

  assert.equal(
    sanitizePromptWorkspaceText(text, worktree, original),
    "Original path: internal/auth/refresh.go. Current path: internal/auth/refresh.go. Root: . Outside: [outside-workspace-path].",
  );
});

test("childToolNames uses structured handoff audit signal before task wording", () => {
  const agent: AgentDefinition = {
    name: "context-builder",
    scope: "built-in",
    concern: "context-building",
    capabilities: ["inspect-files", "search-files", "memory-read", "memory-write"],
    description: "Synthesize context.",
    model: "inherit",
    tools: [],
    memory: { read: true, write: "candidate", categories: [] },
    systemPrompt: "",
    diagnostics: [],
  };

  const tools = childToolNames(agent, "Synthesize final answer material.", true, true, { previousClaimsNeedAudit: true } as never);

  assert.ok(tools.includes("read"));
  assert.ok(tools.includes("grep"));
  assert.ok(tools.includes("find"));
});

test("childToolNames keeps inspection tools for deep synthesis with possible coverage gaps", () => {
  const agent: AgentDefinition = {
    name: "context-builder",
    scope: "built-in",
    concern: "context-building",
    capabilities: ["inspect-files", "search-files", "memory-read", "memory-write"],
    description: "Synthesize context.",
    model: "inherit",
    tools: [],
    memory: { read: true, write: "candidate", categories: [] },
    systemPrompt: "",
    diagnostics: [],
  };

  const tools = childToolNames(agent, "Synthesize deep project analysis in-depth into final answer material.", true, true, { budgetProfile: "deep" });

  assert.ok(tools.includes("read"));
  assert.ok(tools.includes("grep"));
  assert.ok(tools.includes("find"));
  assert.ok(tools.includes("ls"));
});

test("childToolNames exposes autonomous memory tools only to memory-capable agents", () => {
  const memoryAgent: AgentDefinition = {
    name: "worker",
    scope: "built-in",
    concern: "implementation",
    capabilities: ["inspect-files", "search-files", "memory-read", "memory-write"],
    description: "Memory capable.",
    model: "inherit",
    tools: [],
    memory: { read: true, write: "candidate", categories: [] },
    systemPrompt: "",
    diagnostics: [],
  };
  const noMemoryAgent: AgentDefinition = { ...memoryAgent, capabilities: ["inspect-files", "search-files"], memory: { read: false, write: "never", categories: [] } };

  const memoryTools = childToolNames(memoryAgent, "Implement feature with prior project rules.", true, false);
  assert.ok(memoryTools.includes("chalin_memory_search"));
  assert.ok(memoryTools.includes("chalin_memory_write"));
  assert.ok(memoryTools.includes("chalin_memory_revise"));
  assert.equal(childToolNames(noMemoryAgent, "Implement feature.", true, false).some((tool) => tool.startsWith("chalin_memory_")), false);
});

test("childToolNames exposes nested delegation only to coordinating subagents below depth limit", () => {
  const worker: AgentDefinition = {
    name: "worker",
    scope: "built-in",
    concern: "implementation",
    capabilities: ["inspect-files", "search-files", "edit-files", "coordinate"],
    description: "Coordinating worker.",
    model: "inherit",
    tools: [],
    memory: { read: false, write: "never", categories: [] },
    systemPrompt: "",
    diagnostics: [],
  };
  const noCoordinate: AgentDefinition = { ...worker, capabilities: ["inspect-files", "search-files", "edit-files"] };

  assert.ok(childToolNames(worker, "Implement broad change.", true, false, { delegationDepth: 1, maxDelegationDepth: 2 }).includes("chalin_delegate"));
  assert.equal(childToolNames(worker, "Implement broad change.", true, false, { delegationDepth: 2, maxDelegationDepth: 2 }).includes("chalin_delegate"), false);
  assert.equal(childToolNames(worker, "Synthesize previous handoff.", true, true, { delegationDepth: 1, maxDelegationDepth: 2 }).includes("chalin_delegate"), false);
  assert.equal(childToolNames(noCoordinate, "Implement broad change.", true, false, { delegationDepth: 1, maxDelegationDepth: 2 }).includes("chalin_delegate"), false);
  assert.equal(childToolNames(worker, "Implement focused change.", true, false, { budgetProfile: "normal" }).includes("chalin_artifact_write"), false);
  assert.equal(childToolNames(worker, "Implement long checkpointed change.", true, false, { budgetProfile: "extended" }).includes("chalin_artifact_write"), true);

  const prompt = buildSdkPrompt(
    worker,
    "Implement a scope that exceeds one worker ownership boundary.",
    tempDir("pi-chalin-nested-worker-contract-"),
    undefined,
    120,
    "extended",
  );
  assert.match(prompt, /ownership boundary/i);
  assert.match(prompt, /worker-owned child units/i);
  assert.match(prompt, /fan-in review/i);
});

test("childToolNames respects route-level memory gating", () => {
  const memoryAgent: AgentDefinition = {
    name: "scout",
    scope: "built-in",
    concern: "recon",
    capabilities: ["inspect-files", "search-files", "memory-read", "memory-write"],
    description: "Memory capable scout.",
    model: "inherit",
    tools: [],
    memory: { read: true, write: "candidate", categories: [] },
    systemPrompt: "",
    diagnostics: [],
  };

  const tools = childToolNames(memoryAgent, "Map project.", false, false, { memoryEnabled: false });

  assert.equal(tools.some((tool) => tool.startsWith("chalin_memory_")), false);
  assert.ok(tools.includes("chalin_project_discovery"));
});

test("childToolNames exposes discovery plus snapshot for recon without semantic branch classification", () => {
  const agent: AgentDefinition = {
    name: "scout",
    scope: "built-in",
    concern: "recon",
    capabilities: ["inspect-files", "search-files", "memory-read", "memory-write"],
    description: "Recon.",
    model: "inherit",
    tools: [],
    memory: { read: true, write: "candidate", categories: [] },
    systemPrompt: "",
    diagnostics: [],
  };

  const tools = childToolNames(agent, "Inspect current git branch, status, recent commits, and diff against base.", false, false);
  assert.ok(tools.includes("chalin_project_discovery"));
  assert.ok(tools.includes("chalin_project_snapshot"));
  assert.ok(tools.includes("read"));
  assert.ok(tools.includes("grep"));
});


test("resolveAgentModel records fallback attempts and selects next configured candidate", () => {
  const candidate = { provider: "openai", id: "gpt-5-mini" };
  const registry = {
    find(provider: string, id: string) {
      if (provider === "openai" && id === "gpt-5-mini") return candidate;
      return undefined;
    },
    hasConfiguredAuth(model: { provider: string; id: string }) {
      return model.id === "gpt-5-mini";
    },
  };
  const agentDef = agent("reviewer", ["inspect-files"]);
  agentDef.model = "anthropic/missing-model";

  const resolved = resolveAgentModel(agentDef, "reviewer", {
    cwd: tempDir("pi-chalin-model-resolution-"),
    agents: new Map(),
    modelOverrides: { "tier/balanced": "openai/gpt-5-mini" },
    extensionContext: { model: { provider: "openai", id: "fallback-active" }, modelRegistry: registry } as never,
  });

  assert.equal(resolved.label, "openai/gpt-5-mini");
  assert.equal(resolved.resolution.selected, "openai/gpt-5-mini");
  assert.ok(resolved.resolution.attempts.some((attempt) => attempt.status === "unavailable" && attempt.ref === "anthropic/missing-model"));
  assert.ok(resolved.warnings.some((warning) => /model fallback/i.test(warning)));
});

test("resolveAgentModel lets evals force child agent model over local overrides", () => {
  const forced = { provider: "openai-codex", id: "gpt-5.5" };
  const registry = {
    find(provider: string, id: string) {
      if (provider === forced.provider && id === forced.id) return forced;
      return undefined;
    },
    hasConfiguredAuth(model: { provider: string; id: string }) {
      return model.id === forced.id;
    },
  };
  const previous = process.env.PI_CHALIN_EVAL_AGENT_MODEL;
  process.env.PI_CHALIN_EVAL_AGENT_MODEL = "openai-codex/gpt-5.5";
  try {
    const resolved = resolveAgentModel(agent("worker", ["inspect-files"]), "worker", {
      cwd: tempDir("pi-chalin-model-force-"),
      agents: new Map(),
      modelOverrides: { worker: "opencode/kimi-k2.6" },
      extensionContext: { model: { provider: "openai", id: "fallback-active" }, modelRegistry: registry } as never,
    });

    assert.equal(resolved.label, "openai-codex/gpt-5.5");
    assert.equal(resolved.resolution.attempts[0]?.ref, "openai-codex/gpt-5.5");
  } finally {
    if (previous === undefined) delete process.env.PI_CHALIN_EVAL_AGENT_MODEL;
    else process.env.PI_CHALIN_EVAL_AGENT_MODEL = previous;
  }
});

test("resolveInheritedModelFallback switches any subagent runtime provider failure to active inherited model", () => {
  const active = { provider: "openai", id: "gpt-5.5" };
  const override = { provider: "opencode", id: "kimi-k2.6" };
  const registry = {
    find(provider: string, id: string) {
      if (provider === active.provider && id === active.id) return active;
      if (provider === override.provider && id === override.id) return override;
      return undefined;
    },
    hasConfiguredAuth() {
      return true;
    },
  };

  for (const agentName of ["scout", "reviewer", "worker"]) {
    const resolved = resolveAgentModel(agent(agentName, ["inspect-files"]), agentName, {
      cwd: tempDir(`pi-chalin-runtime-model-fallback-${agentName}-`),
      agents: new Map(),
      modelOverrides: { [agentName]: "opencode/kimi-k2.6" },
      extensionContext: { model: active, modelRegistry: registry } as never,
    });

    const fallback = resolveInheritedModelFallback(resolved, agentName, {
      cwd: tempDir(`pi-chalin-runtime-model-fallback-inherit-${agentName}-`),
      agents: new Map(),
      extensionContext: { model: active, modelRegistry: registry } as never,
    }, "401 Insufficient balance");

    assert.ok(fallback);
    assert.equal(fallback.model, active);
    assert.equal(fallback.resolution.selected, "openai/gpt-5.5");
    assert.ok(fallback.resolution.attempts.some((attempt) => attempt.status === "runtime-error" && attempt.model === "opencode/kimi-k2.6"));
    assert.equal(fallback.resolution.attempts.at(-1)?.source, "inherit");
    assert.match(fallback.warnings.join("\n"), new RegExp(`runtime fallback for ${agentName}`, "i"));
  }
});

test("extractAssistantRuntimeError detects structural SDK provider errors", () => {
  const error = extractAssistantRuntimeError([
    { role: "user", content: "Task" },
    { role: "assistant", content: [], stopReason: "error", errorMessage: "401 Insufficient balance" },
  ]);

  assert.equal(error, "401 Insufficient balance");
});

test("resolveAgentThinking uses overrides, agent defaults, and model suffixes", () => {
  const agentDef = agent("reviewer", ["inspect-files"]);
  agentDef.model = "openai/gpt-5-mini:high";
  agentDef.thinking = "medium";

  const modelSuffix = resolveAgentThinking({ ...agentDef, thinking: "inherit" }, "reviewer", {
    cwd: tempDir("pi-chalin-thinking-suffix-"),
    agents: new Map(),
  }, {
    selected: "openai/gpt-5-mini",
    tier: "balanced",
    attempts: [{ source: "agent", ref: "openai/gpt-5-mini:high", status: "selected", model: "openai/gpt-5-mini" }],
  });
  const agentDefault = resolveAgentThinking(agentDef, "reviewer", { cwd: tempDir("pi-chalin-thinking-agent-"), agents: new Map() });
  const override = resolveAgentThinking(agentDef, "reviewer", {
    cwd: tempDir("pi-chalin-thinking-override-"),
    agents: new Map(),
    thinkingOverrides: { "built-in/reviewer": "xhigh" },
  });

  assert.equal(modelSuffix.level, "high");
  assert.equal(agentDefault.level, "medium");
  assert.equal(override.level, "xhigh");
});

test("normalizeThinkingForBudget avoids upward SDK clamps for efficient evidence work", () => {
  const deepseekLikeModel = {
    reasoning: true,
    thinkingLevelMap: { minimal: null, low: null, medium: null, high: "high", xhigh: "max" },
  };
  const scout = agent("scout", ["inspect-files"]);
  scout.concern = "recon";
  const contextBuilder = agent("context-builder", ["inspect-files"]);
  contextBuilder.concern = "context-building";
  const worker = agent("worker", ["edit-files"]);
  worker.concern = "implementation";

  const scoutThinking = normalizeThinkingForBudget({ level: "low", label: "low" }, "normal", {
    agent: scout,
    model: deepseekLikeModel as never,
  });
  const synthesisThinking = normalizeThinkingForBudget({ level: "medium", label: "medium" }, "deep", {
    agent: contextBuilder,
    hasPrevious: true,
    model: deepseekLikeModel as never,
  });
  const implementationThinking = normalizeThinkingForBudget({ level: "high", label: "high" }, "deep", {
    agent: worker,
    model: deepseekLikeModel as never,
  });
  const normalWorkerThinking = normalizeThinkingForBudget({ level: "high", label: "high" }, "normal", {
    agent: worker,
    model: {
      reasoning: true,
      thinkingLevelMap: { minimal: null, low: null, medium: "medium", high: "high", xhigh: "max" },
    } as never,
  });
  const unsupportedNormalWorkerThinking = normalizeThinkingForBudget({ level: "high", label: "high" }, "normal", {
    agent: worker,
    model: deepseekLikeModel as never,
  });

  assert.equal(scoutThinking.level, "off");
  assert.equal(synthesisThinking.level, "off");
  assert.equal(implementationThinking.level, "high");
  assert.equal(normalWorkerThinking.level, "medium");
  assert.equal(unsupportedNormalWorkerThinking.level, "high");
});


test("toolBudgetForStep supports LLM-chosen profiles and deep DAG defaults", () => {
  const contextAgent: AgentDefinition = {
    name: "context-builder",
    scope: "built-in",
    concern: "context-building",
    capabilities: ["inspect-files", "search-files"],
    description: "Context builder",
    model: "inherit",
    budget: { baseToolCalls: 60 },
    tools: [],
    memory: { read: true, write: "candidate", categories: [] },
    systemPrompt: "",
    diagnostics: [],
  };

  assert.equal(toolBudgetForStep(contextAgent, { agent: "context-builder", task: "Summarize bounded handoff.", budget: "tight" }, "multi-agent-sequential"), 30);
  assert.equal(toolBudgetForStep(contextAgent, { agent: "context-builder", task: "Analyze one module." }, "multi-agent-sequential"), 60);
  assert.equal(toolBudgetForStep(contextAgent, { agent: "context-builder", task: "Analyze folder deeply." }, "multi-agent-dag"), 120);
  assert.equal(toolBudgetForStep(contextAgent, { agent: "context-builder", task: "Long autonomous stage with checkpoints.", budget: "extended" }, "multi-agent-dag"), 240);
});

test("budgetPolicyForSdkStep keeps deep recon surface-complete instead of file-exhaustive", () => {
  const scout = readOnlyAgent("scout", "recon");
  const base = policyForStep(scout, { agent: "scout", task: "Map the whole project.", budget: "deep" }, "multi-agent-sequential", "low");
  const sdk = budgetPolicyForSdkStep(base, scout);

  assert.equal(base.caps.maxToolCalls, 80);
  assert.equal(sdk.caps.maxToolCalls, 12);
  assert.equal(sdk.caps.maxTurns, 5);
  assert.equal(sdk.caps.maxReadBytes, 260_000);
  assert.match(sdk.id, /surface-recon/);
});

test("buildSdkPrompt tells deep recon to cover surfaces without exhaustive crawling", () => {
  const scout = readOnlyAgent("scout", "recon");
  const policy = budgetPolicyForSdkStep(policyForStep(scout, { agent: "scout", task: "Map the project.", budget: "deep" }, "multi-agent-sequential", "low"), scout);
  const prompt = buildSdkPrompt(scout, "Map the project.", tempDir("prompt-recon-"), undefined, policy);

  assert.match(prompt, /Deep recon is surface-complete, not file-exhaustive/);
  assert.match(prompt, /Coverage means representative evidence per surface/);
  assert.match(prompt, /cite full relative paths from the repo root/);
  assert.match(prompt, /preserve exact runnable commands discovered in README/);
  assert.match(prompt, /report them as runnable invocations/);
});

test("resolveStepCompletionStatus turns budget-capped SDK stops into checkpointed handoffs", () => {
  const useful = resolveStepCompletionStatus({
    metrics: {
      durationMs: 100,
      usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      toolCalls: 60,
      toolCallsByName: { read: 60 },
      budgetStopCount: 1,
    },
    output: {
      agent: "scout",
      text: "Project finding: the repository uses TypeScript modules and tests in test/*.test.ts; next step should review src/runner/runner.ts budget handling with file-level evidence.",
      handoff: "Project finding: review src/runner/runner.ts and src/budget/budget.ts because budget policy controls subagent autonomy and checkpoint behavior.",
      memoryCandidates: [],
      raw: "",
      warnings: [],
    },
  });

  const empty = resolveStepCompletionStatus({
    metrics: {
      durationMs: 100,
      usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      toolCalls: 60,
      toolCallsByName: { read: 60 },
      budgetStopCount: 1,
    },
    output: { agent: "scout", text: "done", memoryCandidates: [], raw: "done", warnings: [] },
  });

  assert.equal(useful, "complete");
  assert.equal(empty, "checkpointed");
});

test("loadResumableRunState normalizes legacy budget-capped steps at the storage edge", () => {
  const cwd = tempDir("legacy-budget-run-");
  const runId = "chalin-legacy-budget";
  const runsDir = path.join(cwd, ".pi-chalin", "runs");
  fs.mkdirSync(runsDir, { recursive: true });
  fs.writeFileSync(path.join(runsDir, `${runId}.json`), JSON.stringify({
    id: runId,
    route: {
      kind: "multi-agent-sequential",
      agents: ["scout", "worker"],
      risk: "low",
      ambiguity: "low",
      needsMemory: false,
      needsArtifacts: true,
      reason: "legacy budget checkpoint",
      plan: { kind: "sequential", steps: [
        { agent: "scout", task: "Map", budget: "tight" },
        { agent: "worker", task: "Implement", budget: "normal" },
      ] },
    },
    status: "paused",
    startedAt: new Date().toISOString(),
    warnings: [],
    steps: [
      {
        id: "step-1",
        agent: "scout",
        task: "Map",
        status: "budget-capped",
        output: { agent: "scout", text: "partial", handoff: "Mapped enough to continue.", memoryCandidates: [], raw: "partial", warnings: [] },
      },
      { id: "step-2", agent: "worker", task: "Implement", status: "pending" },
    ],
  }, null, 2), "utf-8");

  const loaded = loadResumableRunState({ cwd, runId });

  assert.equal(loaded?.steps[0]?.status, "checkpointed");
  assert.deepEqual(loaded?.steps[0]?.checkpoint, {
    kind: "budget-cap",
    reason: "legacy budget-capped step status",
    continuation: "continue",
    legacyStatus: "budget-capped",
  });
});

test("resolveStepCompletionStatus fails errored child steps even without budget caps", () => {
  const status = resolveStepCompletionStatus({
    error: "SDK runner failed for worker: 401 Insufficient balance",
    metrics: {
      durationMs: 1,
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      toolCalls: 0,
      toolCallsByName: {},
    },
    output: undefined,
  });

  assert.equal(status, "failed");
});
