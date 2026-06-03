import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "vitest";
import { approvalDecision, DEFAULT_CONFIG } from "../src/config/config.ts";
import { createChildToolPolicy } from "../src/tools/child-tools.ts";
import type { RouteDecision } from "../src/domain/schemas.ts";

function route(risk: RouteDecision["risk"]): RouteDecision {
  return { kind: "multi-agent-sequential", agents: ["worker"], risk, ambiguity: "low", needsMemory: false, needsArtifacts: true, reason: "test", plan: { kind: "sequential", steps: [{ agent: "worker", task: "x" }] } };
}

test("approvalDecision allows low risk under balanced mode", () => {
  assert.equal(approvalDecision(DEFAULT_CONFIG, route("low")).action, "allow");
});

test("approvalDecision allows medium risk by default", () => {
  assert.equal(approvalDecision(DEFAULT_CONFIG, route("medium")).action, "allow");
});

test("approvalDecision can ask for medium risk when explicitly configured", () => {
  const config = {
    ...DEFAULT_CONFIG,
    safety: {
      ...DEFAULT_CONFIG.safety,
      approvalRiskThreshold: "medium" as const,
    },
  };
  assert.equal(approvalDecision(config, route("medium")).action, "ask");
});

test("approvalDecision blocks critical risk", () => {
  assert.equal(approvalDecision(DEFAULT_CONFIG, route("critical")).action, "block");
});

test("approvalDecision supports disabling approval prompts without disabling critical blocks", () => {
  const config = {
    ...DEFAULT_CONFIG,
    safety: {
      ...DEFAULT_CONFIG.safety,
      approvalRiskThreshold: "none" as const,
    },
  };

  assert.equal(approvalDecision(config, route("high")).action, "allow");
  assert.equal(approvalDecision(config, route("critical")).action, "block");
});

test("child policy compresses oversized tool output and records output/read budgets", () => {
  const policy = createChildToolPolicy({ cwd: process.cwd(), maxToolCalls: 4, allowedTools: ["read"] });
  assert.deepEqual(policy.beforeTool("read", { path: "src/index.ts" }), { allowed: true });

  const result = policy.afterTool("read", {
    content: [{ type: "text", text: "x".repeat(20_000) }],
    details: {},
  }) as { content: Array<{ text: string }>; details: { piChalinCompressed?: boolean } };

  assert.equal(result.details.piChalinCompressed, true);
  assert.ok(result.content[0]!.text.length < 7000);
  assert.match(result.content[0]!.text, /compressed by pi-chalin/);
  assert.equal(policy.metrics().outputTruncatedCount, 1);
  assert.ok(policy.metrics().readBytes < 7000);
  assert.equal(policy.metrics().outputCharsByToolName.read, policy.metrics().readBytes);
});

test("child policy tracks WebFetch output separately for tokenomics attribution", () => {
  const policy = createChildToolPolicy({ cwd: process.cwd(), maxToolCalls: 4, allowedTools: ["chalin_web_search"] });
  assert.deepEqual(policy.beforeTool("chalin_web_search", { url: "https://example.com/docs" }), { allowed: true });

  policy.afterTool("chalin_web_search", {
    content: [{ type: "text", text: "external docs evidence".repeat(100) }],
    details: {},
  });

  const metrics = policy.metrics();
  assert.ok((metrics.outputCharsByToolName.chalin_web_search ?? 0) > 0);
  assert.equal(metrics.outputCharsByToolName.chalin_web_search, metrics.outputChars);
});

test("child policy guards repeated cross-step reads as a loop without budget stops", () => {
  const policy = createChildToolPolicy({
    cwd: process.cwd(),
    maxToolCalls: 10,
    allowedTools: ["read"],
    priorFilesRead: ["src/index.ts"],
    maxCrossStepDuplicateReads: 1,
  });

  assert.deepEqual(policy.beforeTool("read", { path: "src/index.ts" }), { allowed: true });
  const warned = policy.beforeTool("read", { path: "src/index.ts" });
  const stillAllowed = policy.beforeTool("read", { path: "src/index.ts" });
  const blocked = policy.beforeTool("read", { path: "src/index.ts" });

  assert.equal(warned.allowed, true);
  assert.equal(stillAllowed.allowed, true);
  assert.equal(blocked.allowed, false);
  assert.match(blocked.reason, /read_loop:src\/index\.ts/);
  assert.equal(policy.metrics().budgetStopCount, 0);
  assert.ok(policy.metrics().budgetCapHits.some((hit) => hit.name === "max_cross_step_duplicate_reads" && hit.severity === "soft"));
  assert.equal(policy.metrics().budgetCapHits.some((hit) => hit.name === "max_cross_step_duplicate_reads" && hit.severity === "hard"), false);
  assert.deepEqual(policy.metrics().policyViolations, ["read_loop:src/index.ts"]);
  assert.equal(policy.metrics().toolCalls, 3);
});

test("child policy guards same-file read loops inside one subagent", () => {
  const policy = createChildToolPolicy({
    cwd: process.cwd(),
    maxToolCalls: 100,
    allowedTools: ["read"],
  });

  assert.equal(policy.beforeTool("read", { path: "src/index.ts" }).allowed, true);
  assert.equal(policy.beforeTool("read", { path: "src/index.ts" }).allowed, true);
  assert.equal(policy.beforeTool("read", { path: "src/index.ts" }).allowed, true);
  assert.equal(policy.beforeTool("read", { path: "src/index.ts" }).allowed, true);
  const blocked = policy.beforeTool("read", { path: "src/index.ts" });

  assert.equal(blocked.allowed, false);
  assert.match(blocked.reason, /read_loop:src\/index\.ts/);
  assert.equal(policy.metrics().budgetStopCount, 0);
  assert.deepEqual(policy.metrics().policyViolations, ["read_loop:src/index.ts"]);
  assert.equal(policy.metrics().toolCalls, 4);
});

test("child policy allows bounded ranged reads of different same-file regions", () => {
  const policy = createChildToolPolicy({
    cwd: process.cwd(),
    maxToolCalls: 100,
    allowedTools: ["read"],
  });

  assert.equal(policy.beforeTool("read", { path: "src/index.ts", offset: 1, limit: 20 }).allowed, true);
  assert.equal(policy.beforeTool("read", { path: "src/index.ts", offset: 40, limit: 20 }).allowed, true);
  assert.equal(policy.beforeTool("read", { path: "src/index.ts", offset: 80, limit: 20 }).allowed, true);
  assert.equal(policy.beforeTool("read", { path: "src/index.ts", offset: 120, limit: 20 }).allowed, true);
  assert.equal(policy.beforeTool("read", { path: "src/index.ts", offset: 160, limit: 20 }).allowed, true);

  assert.deepEqual(policy.metrics().policyViolations, []);
  assert.equal(policy.metrics().duplicateReadCount, 4);
  assert.equal(policy.metrics().toolCalls, 5);
});

test("child policy blocks absolute and internal harness paths", () => {
  const cwd = process.cwd();
  const outside = path.dirname(cwd);
  const policy = createChildToolPolicy({ cwd, maxToolCalls: 10, allowedTools: ["read", "bash"] });

  const blockedAbsoluteRead = policy.beforeTool("read", { path: path.join(cwd, "src/index.ts") });
  const blockedRead = policy.beforeTool("read", { path: path.join(outside, "outside.ts") });
  const blockedBash = policy.beforeTool("bash", { command: `cd ${outside} && ls` });
  const allowedWorkspaceCdBash = policy.beforeTool("bash", { command: `cd ${cwd} && ls` });
  const blockedInternalRead = policy.beforeTool("read", { path: ".pi-chalin/runs/run.json" });
  const blockedInternalBash = policy.beforeTool("bash", { command: "grep -R chalin_memory_write .pi-chalin/child-sessions" });
  const allowedInternalExclusionFind = policy.beforeTool("bash", { command: "find . -type f -not -path './.git/*' -not -path './.pi-chalin/*' | sort" });
  const allowedRelativeSlash = policy.beforeTool("bash", { command: "cat src/auth/keycloak.ts" });
  const allowedRedirect = policy.beforeTool("bash", { command: "git status --short 2>/dev/null" });
  const allowedRedirectTerminated = policy.beforeTool("bash", { command: "git status --short 2>/dev/null; git diff --stat" });
  const allowedStdin = policy.beforeTool("bash", { command: "cat </dev/stdin >/dev/stdout 2>/dev/stderr" });
  const allowedSlashPattern = policy.beforeTool("bash", { command: "grep -R // src" });
  const allowedDoubleSlashMarker = policy.beforeTool("bash", { command: "grep -R //nolint internal" });
  const allowedClosingTag = policy.beforeTool("bash", { command: "grep -R '</button>' components" });
  const allowedScopedPackage = policy.beforeTool("bash", { command: "node -e \"require('@vue/compiler-sfc')\"" });
  const allowedRegexLiteral = policy.beforeTool("bash", { command: "node -e \"const re = /compile\\w+/; console.log(re.test('compileTemplate'))\"" });
  const allowedQuotedJsComment = policy.beforeTool("bash", { command: "node -e \"// Setup globals FIRST, before imports\nconst path = '/healthz'; console.log(path)\"" });
  const allowedHeredocRegex = policy.beforeTool("bash", {
    command: "cat > components/ExistingWidget.test.ts << 'EOF'\nconst scriptMatch = source.match(/<script>([\\s\\S]*?)<\\/script>/)\nEOF",
  });
  const allowedJsDocHeredoc = policy.beforeTool("bash", {
    command: "cat > components/existing-data.ts << 'EOF'\n/** Reactive data factory for inline tests. */\nexport function createExistingData() { return { open: false } }\nEOF",
  });
  const allowedHttpPathHeredoc = policy.beforeTool("bash", {
    command: "tee cmd/api/main_test.go << 'EOF'\nconst path = \"/healthz\"\nassert.equal(path, \"/healthz\")\nEOF",
  });
  const allowedInlineHttpPath = policy.beforeTool("bash", {
    command: "python3 -c \"content = 'req = httptest.NewRequest(method, \\\"/healthz\\\", nil)'; print(content)\"",
  });
  const blockedTmpWrite = policy.beforeTool("bash", { command: "echo test > /tmp/pi-chalin-outside.txt" });
  const blockedShellHeredoc = policy.beforeTool("bash", { command: "bash << 'EOF'\ncat /tmp/pi-chalin-outside.txt\nEOF" });

  assert.equal(blockedAbsoluteRead.allowed, false);
  assert.match(blockedAbsoluteRead.reason, /absolute_workspace_path:src\/index\.ts/);
  assert.equal(blockedRead.allowed, false);
  assert.match(blockedRead.reason, /outside_workspace_path/);
  assert.equal(blockedBash.allowed, false);
  assert.match(blockedBash.reason, /outside_workspace_path/);
  assert.equal(allowedWorkspaceCdBash.allowed, true);
  assert.equal(blockedInternalRead.allowed, false);
  assert.match(blockedInternalRead.reason, /internal_harness_path:\.pi-chalin\/runs\/run\.json/);
  assert.equal(blockedInternalBash.allowed, false);
  assert.match(blockedInternalBash.reason, /internal_harness_path:\.pi-chalin\/child-sessions/);
  assert.equal(allowedInternalExclusionFind.allowed, true);
  assert.equal(allowedRelativeSlash.allowed, true);
  assert.equal(allowedRedirect.allowed, true);
  assert.equal(allowedRedirectTerminated.allowed, true);
  assert.equal(allowedStdin.allowed, true);
  assert.equal(allowedSlashPattern.allowed, true);
  assert.equal(allowedDoubleSlashMarker.allowed, true);
  assert.equal(allowedClosingTag.allowed, true);
  assert.equal(allowedScopedPackage.allowed, true);
  assert.equal(allowedRegexLiteral.allowed, true);
  assert.equal(allowedQuotedJsComment.allowed, true);
  assert.equal(allowedHeredocRegex.allowed, true);
  assert.equal(allowedJsDocHeredoc.allowed, true);
  assert.equal(allowedHttpPathHeredoc.allowed, true);
  assert.equal(allowedInlineHttpPath.allowed, true);
  assert.equal(blockedTmpWrite.allowed, false);
  assert.match(blockedTmpWrite.reason, /outside_workspace_path:\/tmp\/pi-chalin-outside\.txt/);
  assert.equal(blockedShellHeredoc.allowed, false);
  assert.match(blockedShellHeredoc.reason, /outside_workspace_path:\/tmp\/pi-chalin-outside\.txt/);
});

test("child policy normalizes redundant absolute cwd before bash execution", () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-chalin-safe-cwd-cd-"));
  try {
    const policy = createChildToolPolicy({ cwd, maxToolCalls: 10, allowedTools: ["bash"] });
    const params = { command: `cd ${cwd} && git diff HEAD -- src/auth/longAuthPolicy.ts 2>/dev/null || echo no-diff` };

    const gate = policy.beforeTool("bash", params);

    assert.equal(gate.allowed, true);
    assert.equal(params.command, "git diff HEAD -- src/auth/longAuthPolicy.ts 2>/dev/null || echo no-diff");
    assert.deepEqual(policy.metrics().shellCommands, [params.command]);
    assert.deepEqual(policy.metrics().policyViolations, []);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test("child policy reports blocked tool reason and safe params summary", () => {
  const activity: Array<{ toolName: string; phase: string; reason?: string; paramsSummary?: string }> = [];
  const cwd = process.cwd();
  const outside = path.dirname(cwd);
  const policy = createChildToolPolicy({
    cwd,
    maxToolCalls: 10,
    allowedTools: ["bash"],
    onActivity: (event) => activity.push(event),
  });

  const blocked = policy.beforeTool("bash", { command: `cd ${outside} && ls` });

  assert.equal(blocked.allowed, false);
  assert.equal(activity.length, 1);
  assert.equal(activity[0]!.toolName, "bash");
  assert.equal(activity[0]!.phase, "blocked");
  assert.match(activity[0]!.reason ?? "", /outside_workspace_path/);
  assert.match(activity[0]!.paramsSummary ?? "", /cd /);
});

test("child policy enforces WorkUnit mutation scope for edit/write", () => {
  const policy = createChildToolPolicy({
    cwd: process.cwd(),
    maxToolCalls: 10,
    allowedTools: ["edit", "write"],
    workUnitScope: { files: ["src/allowed.ts"], mode: "strict", bash: "allow-with-postcheck" },
  });

  assert.equal(policy.beforeTool("edit", { path: "src/allowed.ts", edits: [] }).allowed, true);
  const blockedEdit = policy.beforeTool("edit", { path: "src/other.ts", edits: [] });
  const stoppedWrite = policy.beforeTool("write", { path: "src/generated.ts", content: "" });
  const writePolicy = createChildToolPolicy({
    cwd: process.cwd(),
    maxToolCalls: 10,
    allowedTools: ["write"],
    workUnitScope: { files: ["src/allowed.ts"], mode: "strict", bash: "allow-with-postcheck" },
  });
  const blockedWrite = writePolicy.beforeTool("write", { path: "src/generated.ts", content: "" });

  assert.equal(blockedEdit.allowed, false);
  assert.equal(stoppedWrite.allowed, false);
  assert.equal(blockedWrite.allowed, false);
  assert.match(blockedEdit.reason, /work_unit_scope_gap:src\/other\.ts/);
  assert.match(stoppedWrite.reason, /policy_stopped_after_scope_violation:work_unit_scope_gap:src\/other\.ts/);
  assert.match(blockedWrite.reason, /work_unit_scope_gap:src\/generated\.ts/);
});

test("child policy records bash-created files outside WorkUnit scope", () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-chalin-scope-"));
  try {
    assert.equal(spawnSync("git", ["init"], { cwd }).status, 0);
    const policy = createChildToolPolicy({
      cwd,
      maxToolCalls: 10,
      allowedTools: ["bash"],
      workUnitScope: { files: ["allowed.ts"], mode: "strict", bash: "allow-with-postcheck" },
    });

    const allowedBash = policy.beforeTool("bash", { command: "printf 'ok' > allowed.ts" });
    assert.equal(allowedBash.allowed, true);
    assert.equal(spawnSync("sh", ["-c", "printf 'ok' > allowed.ts"], { cwd }).status, 0);
    policy.afterTool("bash", { content: [{ type: "text", text: "" }], details: {} });
    assert.deepEqual(policy.metrics().policyViolations, []);

    const blockedBash = policy.beforeTool("bash", { command: "printf 'no' > extra.ts" });
    assert.equal(blockedBash.allowed, true);
    assert.equal(spawnSync("sh", ["-c", "printf 'no' > extra.ts"], { cwd }).status, 0);
    const result = policy.afterTool("bash", { content: [{ type: "text", text: "" }], details: {} });
    const stopped = policy.beforeTool("bash", { command: "printf 'ok' > allowed.ts" });

    assert.deepEqual(policy.metrics().policyViolations, [
      "outside_work_unit_scope:extra.ts",
      "policy_stopped_after_scope_violation:outside_work_unit_scope:extra.ts",
    ]);
    assert.equal((result as { isError?: boolean }).isError, true);
    assert.match(JSON.stringify(result), /outside_work_unit_scope:extra\.ts/);
    assert.match(JSON.stringify(result), /Stop and report the missing scope/);
    assert.equal(stopped.allowed, false);
    assert.match(stopped.reason, /policy_stopped_after_scope_violation:outside_work_unit_scope:extra\.ts/);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test("child policy ignores untracked binary outputs for WorkUnit bash postcheck", () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-chalin-scope-binary-"));
  try {
    assert.equal(spawnSync("git", ["init"], { cwd }).status, 0);
    const policy = createChildToolPolicy({
      cwd,
      maxToolCalls: 10,
      allowedTools: ["bash"],
      workUnitScope: { files: ["allowed.ts"], mode: "strict", bash: "allow-with-postcheck" },
    });

    const gate = policy.beforeTool("bash", { command: "printf binary > generated" });
    assert.equal(gate.allowed, true);
    fs.writeFileSync(path.join(cwd, "generated"), Buffer.from([0xca, 0xfe, 0x00, 0x00]));
    policy.afterTool("bash", { content: [{ type: "text", text: "" }], details: {} });

    assert.deepEqual(policy.metrics().policyViolations, []);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test("child policy blocks mutating git commands but allows git inspection", () => {
  const policy = createChildToolPolicy({ cwd: process.cwd(), maxToolCalls: 10, allowedTools: ["bash"] });

  for (const command of [
    "git status --short && git diff --stat",
    "git log --oneline -3; git branch --show-current",
    "git branch",
    "git branch -a",
    "git branch --all",
    "git branch -r",
    "git branch --remotes",
    "git branch -avv",
    "git branch --contains HEAD",
    "git branch --no-contains HEAD",
    "git branch --merged main",
    "git branch --no-merged origin/main",
    "git branch --format='%(refname:short)'",
    "git branch --format '%(refname:short)' --sort=-committerdate",
    "git branch --list 'feature/*'",
    "git branch -a 2>/dev/null | head -10",
    "git branch --show-current > current-branch.txt",
  ]) {
    assert.equal(policy.beforeTool("bash", { command }).allowed, true, command);
  }

  for (const command of [
    "git branch feature/new",
    "git branch feature/new HEAD",
    "git branch -d old",
    "git branch -D old",
    "git branch -m old new",
    "git branch -M old new",
    "git branch -c old copy",
    "git branch -C old copy",
    "git branch -f main HEAD",
    "git branch --set-upstream-to origin/main main",
    "git branch --unset-upstream main",
    "git branch --edit-description main",
    "git branch --list -D old",
    "git branch feature/new 2>/dev/null | head -10",
    "git branch -a | git checkout main",
    "git checkout main",
    "git switch main",
    "git add .",
    "git commit -m fix",
    "git reset --hard HEAD",
  ]) {
    const blocked = policy.beforeTool("bash", { command });
    assert.equal(blocked.allowed, false, command);
    assert.match(blocked.reason, /mutating_git_command/);
  }
});
