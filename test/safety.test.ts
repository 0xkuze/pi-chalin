import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "vitest";
import { ArtifactStore } from "../src/artifacts/artifacts.ts";
import { approvalDecision, DEFAULT_CONFIG } from "../src/config/config.ts";
import { createChildToolPolicy, createChildTools } from "../src/tools/child-tools.ts";
import { routeFromPlan } from "../src/kernel/kernel.ts";
import { normalizeRouteForExecution } from "../src/routing/route-guards.ts";
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

test("approvalDecision asks for critical risk instead of hard-blocking the route", () => {
  const decision = approvalDecision(DEFAULT_CONFIG, route("critical"));
  assert.equal(decision.action, "ask");
  assert.match(decision.reason, /one-time safety approval/i);
});

test("protected path mentions do not escalate routes before a destructive action occurs", () => {
  const route = routeFromPlan({
    topology: "sequential",
    expectedEffects: ["write", "verify"],
    risk: "low",
    steps: [
      {
        agent: "worker",
        task: "Delete Cargo.lock and uv.lock from the repository root.",
        files: ["Cargo.lock", "uv.lock"],
      },
    ],
  });

  const normalized = normalizeRouteForExecution(route, {
    requiresWorkspaceMutation: true,
  });

  assert.equal(normalized.risk, "low");
  assert.equal(approvalDecision(DEFAULT_CONFIG, normalized).action, "allow");
});

test("approvalDecision disables approval prompts only for non-critical routes", () => {
  const config = {
    ...DEFAULT_CONFIG,
    safety: {
      ...DEFAULT_CONFIG.safety,
      approvalRiskThreshold: "none" as const,
    },
  };

  assert.equal(approvalDecision(config, route("high")).action, "allow");
  assert.equal(approvalDecision(config, route("critical")).action, "ask");
});

test("child policy compresses oversized tool output and records output/read budgets", () => {
  const policy = createChildToolPolicy({ cwd: process.cwd(), allowedTools: ["read"] });
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
  const policy = createChildToolPolicy({ cwd: process.cwd(), allowedTools: ["chalin_web_search"] });
  assert.deepEqual(policy.beforeTool("chalin_web_search", { url: "https://example.com/docs" }), { allowed: true });

  policy.afterTool("chalin_web_search", {
    content: [{ type: "text", text: "external docs evidence".repeat(100) }],
    details: {},
  });

  const metrics = policy.metrics();
  assert.ok((metrics.outputCharsByToolName.chalin_web_search ?? 0) > 0);
  assert.equal(metrics.outputCharsByToolName.chalin_web_search, metrics.outputChars);
});

test("memory tool lets durable memory policy reject raw runtime noise instead of word-blocking", async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-chalin-memory-tool-policy-"));
  try {
    const policy = createChildToolPolicy({
      cwd,
      agentName: "scout",
      allowedTools: ["chalin_memory_write"],
    });
    const tool = createChildTools(policy).find((item) => item.name === "chalin_memory_write");
    assert.ok(tool);

    const result = await tool.execute("mem-raw", {
      category: "agent-note",
      content: "print stdout returncode traceback from a temporary local debug command should not become durable project memory.",
      confidence: 0.9,
    }, undefined, undefined, undefined as never);
    const text = String((result.content?.[0] as { text?: string } | undefined)?.text ?? "");

    assert.doesNotMatch(text, /Blocked by pi-chalin child policy/);
    assert.match(text, /memory rejected/);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test("child tool lets subagents declare one-shot approval requests semantically", async () => {
  const policy = createChildToolPolicy({ cwd: process.cwd(), allowedTools: ["bash"] });
  const approvalTool = createChildTools(policy).find((tool) => tool.name === "chalin_request_approval");
  assert.ok(approvalTool);

  const result = await approvalTool.execute("approval-request", {
    targetToolName: "bash",
    command: "git reset --hard HEAD",
    reason: "The subagent judges this as a risky state-changing action.",
    risk: "high",
    actionDescription: "bash: git reset --hard HEAD",
  }, undefined, undefined, undefined as never);
  const text = String((result.content?.[0] as { text?: string } | undefined)?.text ?? "");
  const pending = policy.pendingApproval();

  assert.match(text, /approval required/i);
  assert.ok(pending);
  assert.equal(pending.toolName, "bash");
  assert.equal(pending.risk, "high");
  assert.match(pending.reason, /^llm_declared_risky_action:/);
  assert.match(pending.actionDescription, /git reset --hard HEAD/);
  assert.equal(policy.metrics().approvalRequests.length, 1);
});

test("child policy consumes approved one-shot actions exactly once", () => {
  const policy = createChildToolPolicy({ cwd: process.cwd(), allowedTools: ["bash"] });
  const request = policy.requestApproval({
    targetToolName: "bash",
    command: "git reset --hard HEAD",
    reason: "The subagent judged this action unsafe without human approval.",
    risk: "high",
    actionDescription: "bash: git reset --hard HEAD",
  });
  assert.ok(request);

  const pending = policy.beforeTool("bash", { command: "git reset --hard HEAD" });
  assert.equal(pending.allowed, false);
  assert.ok(pending.approvalRequired);

  policy.approveAction({
    requestId: request.id,
    approvedAction: request.actionDescription,
    retriedAction: "git reset --hard HEAD",
    equivalenceReason: "exact normalized command retry",
    decidedBy: "worker",
  });

  assert.equal(policy.beforeTool("bash", { command: "git reset --hard HEAD" }).allowed, true);
  const second = policy.beforeTool("bash", { command: "git reset --hard HEAD" });
  assert.equal(second.allowed, false);
  assert.match(second.reason, /^approval_required:/);
  assert.equal(policy.metrics().approvalDecisions[0]?.decision, "approved");
  assert.equal(policy.metrics().approvalDecisions[0]?.consumed, true);
});

test("child policy hard-blocks secret read intent instead of asking approval", () => {
  const policy = createChildToolPolicy({ cwd: process.cwd(), allowedTools: ["read", "bash"] });

  const readEnv = policy.beforeTool("read", { path: ".env" });
  const catEnv = policy.beforeTool("bash", { command: "cat .env" });

  assert.equal(readEnv.allowed, false);
  assert.match(readEnv.reason, /secret_read_intent/);
  assert.equal(readEnv.approvalRequired, undefined);
  assert.equal(catEnv.allowed, false);
  assert.match(catEnv.reason, /secret_read_intent/);
});

test("child tools always expose chalin_interview for approvals", () => {
  const policy = createChildToolPolicy({ cwd: process.cwd(), allowedTools: ["bash"] });

  assert.equal(policy.allowedTools.has("chalin_interview"), true);
  assert.equal(policy.allowedTools.has("chalin_request_approval"), true);
  assert.ok(createChildTools(policy).some((tool) => tool.name === "chalin_interview"));
  assert.ok(createChildTools(policy).some((tool) => tool.name === "chalin_request_approval"));
});

test("chalin_interview persists action approval artifacts and unlocks one retry", async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-chalin-approval-interview-"));
  try {
    const policy = createChildToolPolicy({ cwd, agentName: "worker", allowedTools: ["bash"] });
    const request = policy.requestApproval({
      targetToolName: "bash",
      command: "git reset --hard HEAD",
      reason: "The subagent judged this action unsafe without human approval.",
      risk: "high",
      actionDescription: "bash: git reset --hard HEAD",
    });
    assert.ok(request);

    const interview = createChildTools(policy).find((tool) => tool.name === "chalin_interview");
    assert.ok(interview);
    await interview.execute("approval", {
      task: "Run risky git command.",
      reason: "git reset needs user approval.",
      questions: [],
    }, undefined, undefined, {
      cwd,
      hasUI: true,
      ui: {
        select: async (_title: string, options: string[]) => options[0],
        notify: () => undefined,
      },
    } as never);

    assert.equal(policy.beforeTool("bash", { command: "git reset --hard HEAD" }).allowed, true);
    assert.equal(policy.beforeTool("bash", { command: "git reset --hard HEAD" }).allowed, false);

    const features = await new ArtifactStore({ cwd }).listFeatures();
    const approvalFeature = features.find((feature) => feature.approvalDecisions.length > 0);
    assert.ok(approvalFeature);
    assert.equal(approvalFeature.approvalDecisions[0]?.decision, "approved");
    assert.equal(approvalFeature.approvalDecisions[0]?.subagentId, "worker");
    assert.match(approvalFeature.approvalDecisions[0]?.approvedAction ?? "", /git reset --hard HEAD/);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test("chalin_interview preserves localized approval question labels from the subagent", async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-chalin-approval-language-"));
  try {
    const policy = createChildToolPolicy({ cwd, agentName: "worker", allowedTools: ["bash"] });
    const request = policy.requestApproval({
      targetToolName: "bash",
      command: "git reset --hard HEAD",
      reason: "El subagente juzgó que esta acción necesita aprobación.",
      risk: "high",
      actionDescription: "bash: git reset --hard HEAD",
    });
    assert.ok(request);

    const interview = createChildTools(policy).find((tool) => tool.name === "chalin_interview");
    assert.ok(interview);
    const seen: { title?: string; options?: string[] } = {};
    await interview.execute("approval", {
      task: "Ejecutar comando riesgoso.",
      reason: "El comando necesita aprobación del usuario.",
      questions: [{
        id: "approval",
        question: "¿Apruebas ejecutar este comando una sola vez?",
        allowCustom: false,
        choices: [
          { label: "Aprobar una vez", value: "approve", recommended: true },
          { label: "Rechazar", value: "reject" },
        ],
      }],
    }, undefined, undefined, {
      cwd,
      hasUI: true,
      ui: {
        select: async (title: string, options: string[]) => {
          seen.title = title;
          seen.options = options;
          return options[0];
        },
        notify: () => undefined,
      },
    } as never);

    assert.match(seen.title ?? "", /¿Apruebas ejecutar este comando/);
    assert.ok(seen.options?.some((option) => option.includes("Aprobar una vez")));
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test("child policy guards repeated cross-step reads as a loop without hard budget stops", () => {
  const policy = createChildToolPolicy({
    cwd: process.cwd(),
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
  assert.ok(policy.metrics().budgetCapHits.some((hit) => hit.name === "max_cross_step_duplicate_reads" && hit.severity === "soft"));
  assert.equal(policy.metrics().budgetCapHits.some((hit) => hit.name === "max_cross_step_duplicate_reads" && hit.severity === "hard"), false);
  assert.deepEqual(policy.metrics().policyViolations, ["read_loop:src/index.ts"]);
  assert.equal(policy.metrics().toolCalls, 3);
});

test("child policy guards same-file read loops inside one subagent", () => {
  const policy = createChildToolPolicy({
    cwd: process.cwd(),
    allowedTools: ["read"],
  });

  assert.equal(policy.beforeTool("read", { path: "src/index.ts" }).allowed, true);
  assert.equal(policy.beforeTool("read", { path: "src/index.ts" }).allowed, true);
  assert.equal(policy.beforeTool("read", { path: "src/index.ts" }).allowed, true);
  assert.equal(policy.beforeTool("read", { path: "src/index.ts" }).allowed, true);
  const blocked = policy.beforeTool("read", { path: "src/index.ts" });

  assert.equal(blocked.allowed, false);
  assert.match(blocked.reason, /read_loop:src\/index\.ts/);
  assert.deepEqual(policy.metrics().policyViolations, ["read_loop:src/index.ts"]);
  assert.equal(policy.metrics().toolCalls, 4);
});

test("child policy allows bounded ranged reads of different same-file regions", () => {
  const policy = createChildToolPolicy({
    cwd: process.cwd(),
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

test("child policy asks approval for internal or outside workspace paths while keeping relative workspace access clean", () => {
  const cwd = process.cwd();
  const outside = path.dirname(cwd);
  const beforeTool = (toolName: "read" | "bash", params: Record<string, unknown>) =>
    createChildToolPolicy({ cwd, allowedTools: ["read", "bash"] }).beforeTool(toolName, params);

  const absoluteReadParams = { path: path.join(cwd, "src/index.ts") };
  const allowedAbsoluteRead = beforeTool("read", absoluteReadParams);
  const blockedRead = beforeTool("read", { path: path.join(outside, "outside.ts") });
  const blockedBash = beforeTool("bash", { command: `cd ${outside} && ls` });
  const allowedWorkspaceCdBash = beforeTool("bash", { command: `cd ${cwd} && ls` });
  const allowedWorkspaceAbsoluteBash = beforeTool("bash", { command: `ls ${path.join(cwd, "src")}` });
  const blockedInternalRead = beforeTool("read", { path: ".pi-chalin/runs/run.json" });
  const blockedInternalBash = beforeTool("bash", { command: "grep -R chalin_memory_write .pi-chalin/child-sessions" });
  const allowedInternalExclusionFind = beforeTool("bash", { command: "find . -type f -not -path './.git/*' -not -path './.pi-chalin/*' | sort" });
  const allowedRelativeSlash = beforeTool("bash", { command: "cat src/auth/keycloak.ts" });
  const allowedRedirect = beforeTool("bash", { command: "git status --short 2>/dev/null" });
  const allowedRedirectTerminated = beforeTool("bash", { command: "git status --short 2>/dev/null; git diff --stat" });
  const allowedStdin = beforeTool("bash", { command: "cat </dev/stdin >/dev/stdout 2>/dev/stderr" });
  const allowedSlashPattern = beforeTool("bash", { command: "grep -R // src" });
  const allowedDoubleSlashMarker = beforeTool("bash", { command: "grep -R //nolint internal" });
  const allowedClosingTag = beforeTool("bash", { command: "grep -R '</button>' components" });
  const allowedScopedPackage = beforeTool("bash", { command: "node -e \"require('@vue/compiler-sfc')\"" });
  const allowedRegexLiteral = beforeTool("bash", { command: "node -e \"const re = /compile\\w+/; console.log(re.test('compileTemplate'))\"" });
  const allowedQuotedJsComment = beforeTool("bash", { command: "node -e \"// Setup globals FIRST, before imports\nconst path = '/healthz'; console.log(path)\"" });
  const allowedHeredocRegex = beforeTool("bash", {
    command: "cat > components/ExistingWidget.test.ts << 'EOF'\nconst scriptMatch = source.match(/<script>([\\s\\S]*?)<\\/script>/)\nEOF",
  });
  const allowedJsDocHeredoc = beforeTool("bash", {
    command: "cat > components/existing-data.ts << 'EOF'\n/** Reactive data factory for inline tests. */\nexport function createExistingData() { return { open: false } }\nEOF",
  });
  const allowedHttpPathHeredoc = beforeTool("bash", {
    command: "tee cmd/api/main_test.go << 'EOF'\nconst path = \"/healthz\"\nassert.equal(path, \"/healthz\")\nEOF",
  });
  const allowedInlineHttpPath = beforeTool("bash", {
    command: "python3 -c \"content = 'req = httptest.NewRequest(method, \\\"/healthz\\\", nil)'; print(content)\"",
  });
  const blockedTmpWrite = beforeTool("bash", { command: "echo test > /tmp/pi-chalin-outside.txt" });
  const blockedShellHeredoc = beforeTool("bash", { command: "bash << 'EOF'\ncat /tmp/pi-chalin-outside.txt\nEOF" });

  assert.equal(allowedAbsoluteRead.allowed, true);
  assert.equal(absoluteReadParams.path, "src/index.ts");
  assert.equal(blockedRead.allowed, false);
  assert.match(blockedRead.reason, /^approval_required:/);
  assert.equal(blockedBash.allowed, false);
  assert.match(blockedBash.reason, /^approval_required:/);
  assert.equal(allowedWorkspaceCdBash.allowed, true);
  assert.equal(allowedWorkspaceAbsoluteBash.allowed, true);
  assert.equal(blockedInternalRead.allowed, false);
  assert.match(blockedInternalRead.reason, /^approval_required:/);
  assert.equal(blockedInternalBash.allowed, false);
  assert.match(blockedInternalBash.reason, /^approval_required:/);
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
  assert.match(blockedTmpWrite.reason, /^approval_required:/);
  assert.equal(blockedShellHeredoc.allowed, false);
  assert.match(blockedShellHeredoc.reason, /^approval_required:/);
});

test("child policy normalizes redundant absolute cwd before bash execution", () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-chalin-safe-cwd-cd-"));
  try {
    const policy = createChildToolPolicy({ cwd, allowedTools: ["bash"] });
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
    allowedTools: ["bash"],
    onActivity: (event) => activity.push(event),
  });

  const blocked = policy.beforeTool("bash", { command: `cd ${outside} && ls` });

  assert.equal(blocked.allowed, false);
  assert.equal(activity.length, 1);
  assert.equal(activity[0]!.toolName, "bash");
  assert.equal(activity[0]!.phase, "approval");
  assert.match(activity[0]!.reason ?? "", /outside_workspace_path/);
  assert.match(activity[0]!.paramsSummary ?? "", /cd /);
});

test("child policy enforces WorkUnit mutation scope for edit/write", () => {
  const policy = createChildToolPolicy({
    cwd: process.cwd(),
    allowedTools: ["edit", "write"],
    workUnitScope: { files: ["src/allowed.ts"], mode: "strict", bash: "allow-with-postcheck" },
  });

  assert.equal(policy.beforeTool("edit", { path: "src/allowed.ts", edits: [] }).allowed, true);
  const blockedEdit = policy.beforeTool("edit", { path: "src/other.ts", edits: [] });
  const stoppedWrite = policy.beforeTool("write", { path: "src/generated.ts", content: "" });
  const writePolicy = createChildToolPolicy({
    cwd: process.cwd(),
    allowedTools: ["write"],
    workUnitScope: { files: ["src/allowed.ts"], mode: "strict", bash: "allow-with-postcheck" },
  });
  const blockedWrite = writePolicy.beforeTool("write", { path: "src/generated.ts", content: "" });

  assert.equal(blockedEdit.allowed, false);
  assert.equal(stoppedWrite.allowed, false);
  assert.equal(blockedWrite.allowed, false);
  assert.match(blockedEdit.reason, /^approval_required:/);
  assert.match(stoppedWrite.reason, /^approval_required:/);
  assert.match(blockedWrite.reason, /^approval_required:/);
});

test("child policy records bash-created files outside WorkUnit scope", () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-chalin-scope-"));
  try {
    assert.equal(spawnSync("git", ["init"], { cwd }).status, 0);
    const policy = createChildToolPolicy({
      cwd,
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

    assert.deepEqual(policy.metrics().policyViolations, ["approval_required:outside_work_unit_scope:extra.ts"]);
    assert.equal((result as { isError?: boolean }).isError, undefined);
    assert.match(JSON.stringify(result), /outside_work_unit_scope:extra\.ts/);
    assert.match(JSON.stringify(result), /Call chalin_interview now/);
    assert.equal(stopped.allowed, false);
    assert.match(stopped.reason, /^approval_required:/);
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

test("child policy leaves git command risk classification to subagent-declared approval", () => {
  const policy = createChildToolPolicy({ cwd: process.cwd(), allowedTools: ["bash"] });

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

  assert.equal(policy.beforeTool("bash", { command: "git reset --hard HEAD" }).allowed, true);
  const request = policy.requestApproval({
    targetToolName: "bash",
    command: "git reset --hard HEAD",
    reason: "The subagent judged this state-changing repository action unsafe without confirmation.",
    risk: "high",
  });
  assert.ok(request);
  const gated = policy.beforeTool("bash", { command: "git reset --hard HEAD" });
  assert.equal(gated.allowed, false);
  assert.match(gated.reason, /^approval_required:/);
});
