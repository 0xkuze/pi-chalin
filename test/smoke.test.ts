import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, test } from "bun:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import registerPiChalin from "../src/index.ts";
import { resetAutorouteToolStateForTests } from "../src/autoroute.ts";
import { getDirectToolEventsForTests, getLatestRun, resetRuntimeState, setLatestRun, setLiveStepSession } from "../src/runtime-state.ts";
import { openAgentManager, openAgentModelPicker, openSkillManager } from "../src/ui-agents.ts";
import { openMemoryReview, openMemoryReviewWithLoading, openSmartPanel, openWebFetchAuditPanel, summarizeRuntimeGuards } from "../src/ui.ts";
import { finalAnswerMaterial, formatRoute } from "../src/route-format.ts";
import { formatChalinRoutePlanWidget, formatChalinRunWidget } from "../src/route-widget.ts";
import { createRunState, persistRun } from "../src/runner-state.ts";
import { chalinFooterText } from "../src/ui-status.ts";
import { createMemoryCandidate, MemoryStore } from "../src/memory.ts";
import { buildRunLifecycleSpans, redactTraceAttribute } from "../src/observability.ts";
import type { AgentDefinition, MemoryRecord, RunState } from "../src/schemas.ts";
import { SkillCatalog } from "../src/skills.ts";
import type { WebFetchAuditEntry } from "../src/webfetch.ts";

const tempDirs: string[] = [];
afterEach(() => {
  resetRuntimeState();
  resetAutorouteToolStateForTests();
  while (tempDirs.length > 0) fs.rmSync(tempDirs.pop()!, { recursive: true, force: true });
});
function tempDir(prefix: string): string { const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix)); tempDirs.push(dir); return dir; }
function writeSkillFileForSmoke(filePath: string, body: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, body.trimStart(), "utf-8");
}
function emptyTestUsage() {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}
function memoryRecord(overrides: Partial<MemoryRecord>): MemoryRecord {
  const now = new Date().toISOString();
  return {
    id: "memory-test",
    category: "workflow",
    content: "Long-running work should checkpoint after handoffs.",
    sourceAgent: "context-builder",
    confidence: 0.9,
    scope: "project",
    createdAt: now,
    status: "pending",
    importance: 0.6,
    trigger: "test",
    lastSeenAt: now,
    duplicateCount: 1,
    revisionCount: 1,
    ...overrides,
  };
}

function directSteerTypesSince(fake: ReturnType<typeof createFakePi>, fromIndex: number): string[] {
  return fake.messages
    .slice(fromIndex)
    .map((item) => (item.message as { customType?: string }).customType ?? "")
    .filter((customType) => customType.startsWith("pi-chalin-direct-") || customType.startsWith("pi-chalin-docs-"));
}

function createFakePi() {
  const commands = new Map<string, unknown>();
  const tools = new Map<string, unknown>();
  const handlers = new Map<string, unknown[]>();
  const fake = {
    commands,
    tools,
    handlers,
    activeTools: [] as string[],
    toolSetHistory: [] as string[][],
    messages: [] as Array<{ message: unknown; options: unknown }>,
    thinkingLevel: "minimal",
    thinkingHistory: [] as string[],
    api: {
      registerCommand(name: string, options: unknown) {
        commands.set(name, options);
      },
      registerTool(tool: { name: string }) {
        tools.set(tool.name, tool);
      },
      on(event: string, handler: unknown) {
        handlers.getOrInsertComputed(event, () => []).push(handler);
      },
      sendMessage(message: unknown, options?: unknown) {
        fake.messages.push({ message, options });
      },
      getActiveTools() {
        return [...fake.activeTools];
      },
      setActiveTools(toolNames: string[]) {
        fake.activeTools = [...toolNames];
        fake.toolSetHistory.push([...toolNames]);
      },
      getThinkingLevel() {
        return fake.thinkingLevel;
      },
      setThinkingLevel(level: string) {
        fake.thinkingLevel = level;
        fake.thinkingHistory.push(level);
      },
    },
  };
  return fake;
}

test("pi-chalin extension registers Phase 0 command and tool", () => {
  const fake = createFakePi();
  registerPiChalin(fake.api as never);

  assert.equal(fake.commands.has("chalin"), true);
  assert.equal(fake.tools.has("chalin_route"), true);
  assert.equal(fake.tools.has("chalin_resume"), true);
  assert.equal(fake.tools.has("chalin_interview"), true);
  assert.equal(fake.tools.has("chalin_project_discovery"), true);
  assert.equal(fake.tools.has("chalin_project_snapshot"), true);
  assert.equal(fake.tools.has("chalin_web_search"), true);
  assert.equal(fake.tools.has("chalin_memory_search"), true);
  assert.equal(fake.tools.has("chalin_memory_write"), true);
  assert.equal(fake.tools.has("chalin_memory_revise"), true);
  assert.equal(fake.handlers.has("session_start"), true);
  assert.equal(fake.handlers.has("input"), true);
});

test("pi-chalin recursion guard skips child registration", () => {
  const previous = process.env.PI_CHALIN_CHILD;
  process.env.PI_CHALIN_CHILD = "1";
  try {
    const fake = createFakePi();
    registerPiChalin(fake.api as never);
    assert.equal(fake.commands.size, 0);
    assert.equal(fake.tools.size, 0);
  } finally {
    if (previous === undefined) delete process.env.PI_CHALIN_CHILD;
    else process.env.PI_CHALIN_CHILD = previous;
  }
});


test("pi-chalin disabled env skips registration", () => {
  const previous = process.env.PI_CHALIN_DISABLED;
  process.env.PI_CHALIN_DISABLED = "1";
  try {
    const fake = createFakePi();
    registerPiChalin(fake.api as never);
    assert.equal(fake.commands.size, 0);
    assert.equal(fake.tools.size, 0);
  } finally {
    if (previous === undefined) delete process.env.PI_CHALIN_DISABLED;
    else process.env.PI_CHALIN_DISABLED = previous;
  }
});


test("pi-chalin keeps the native prompt and teaches the primary Pi agent to decide chalin usage", async () => {
  const fake = createFakePi();
  registerPiChalin(fake.api as never);
  const inputHandler = fake.handlers.get("input")?.[0] as (event: unknown, ctx: unknown) => Promise<{ action: string }>;
  const beforeAgentStart = fake.handlers.get("before_agent_start")?.[0] as (event: unknown, ctx: unknown) => Promise<{ systemPrompt?: string; message?: { customType?: string; display?: boolean } } | undefined>;
  const contextHandler = fake.handlers.get("context")?.[0] as (event: { type: "context"; messages: unknown[] }, ctx: unknown) => unknown;
  assert.equal(typeof inputHandler, "function");
  assert.equal(typeof beforeAgentStart, "function");
  assert.equal(typeof contextHandler, "function");
  assert.equal(await contextHandler({ type: "context", messages: [] }, { cwd: process.cwd() }), undefined, "context hook stays inert without a critical direct-work guard");

  const ctx = {
    cwd: tempDir("pi-chalin-auto-"),
    hasUI: true,
    model: undefined,
    modelRegistry: { getAvailable: () => [] },
    ui: {
      notify: () => {},
      setStatus: () => {},
      setWidget: () => {},
      setWorkingMessage: () => {},
      setWorkingVisible: () => {},
      setWorkingIndicator: () => {},
      confirm: async () => true,
      select: async () => undefined,
    },
  };

  const inputResult = await inputHandler({ type: "input", text: "review this project", source: "interactive" }, ctx);
  assert.equal(inputResult.action, "continue", "input hook must not consume the prompt, otherwise Pi hides the native user message");

  assert.equal(fake.messages.length, 0, "chalin should not create a separate follow-up turn");

  const promptResult = await beforeAgentStart({
    type: "before_agent_start",
    prompt: "review this project",
    systemPrompt: "base system prompt",
    systemPromptOptions: {},
  }, ctx);
  assert.match(promptResult?.systemPrompt ?? "", /primary Pi agent/i);
  assert.match(promptResult?.systemPrompt ?? "", /chalin_resume/i);
  assert.match(promptResult?.systemPrompt ?? "", /chalin_interview/i);
  assert.match(promptResult?.systemPrompt ?? "", /chalin_route/i);
  assert.match(promptResult?.systemPrompt ?? "", /At the start choose one path: `DIRECT` or `ROUTE`/i);
  assert.match(promptResult?.systemPrompt ?? "", /topology=sequential.*topology=dag/i);
  assert.match(promptResult?.systemPrompt ?? "", /memory is a capability, not a route category/i);
  assert.match(promptResult?.systemPrompt ?? "", /Routed file mutation needs a worker and a later reviewer/i);
  assert.doesNotMatch(promptResult?.systemPrompt ?? "", /branch\/diff\/PR/i);
  assert.match(promptResult?.systemPrompt ?? "", /scout/);
  assert.match(promptResult?.systemPrompt ?? "", /reviewer/);
  assert.equal(promptResult?.message?.customType, "pi-chalin-orchestration");
  assert.equal(promptResult?.message?.display, false);
  assert.match(JSON.stringify(promptResult?.message ?? {}), /Decide DIRECT or ROUTE/i);
});

test("pi-chalin forces high thinking only for the parent orchestration decision", async () => {
  const fake = createFakePi();
  fake.thinkingLevel = "minimal";
  registerPiChalin(fake.api as never);
  const beforeAgentStart = fake.handlers.get("before_agent_start")?.[0] as (event: unknown, ctx: unknown) => Promise<unknown>;
  const toolStart = fake.handlers.get("tool_execution_start")?.[0] as (event: unknown) => void;

  await beforeAgentStart({
    type: "before_agent_start",
    prompt: "Revisa este proyecto y dime su estructura.",
    systemPrompt: "base",
    systemPromptOptions: {},
  }, {
    cwd: tempDir("pi-chalin-thinking-router-"),
    hasUI: false,
    model: undefined,
    modelRegistry: { getAvailable: () => [] },
  });

  assert.equal(fake.thinkingLevel, "high");
  toolStart({ toolName: "chalin_route", args: {} });
  assert.equal(fake.thinkingLevel, "minimal");
  assert.deepEqual(fake.thinkingHistory.slice(-2), ["high", "minimal"]);
});

test("pi-chalin leaves general no-path routing decisions to the model with full tools", async () => {
  const fake = createFakePi();
  const fullToolSet = ["read", "bash", "grep", "find", "ls", "chalin_interview", "chalin_route", "chalin_web_search"];
  fake.activeTools = [...fullToolSet];
  fake.thinkingLevel = "low";
  registerPiChalin(fake.api as never);
  const beforeAgentStart = fake.handlers.get("before_agent_start")?.[0] as (event: unknown, ctx: unknown) => Promise<unknown>;
  const toolStart = fake.handlers.get("tool_execution_start")?.[0] as (event: unknown) => void;

  await beforeAgentStart({
    type: "before_agent_start",
    prompt: "Dime como esta organizado este proyecto y si conviene dividir responsabilidades.",
    systemPrompt: "base",
    systemPromptOptions: {},
  }, {
    cwd: tempDir("pi-chalin-mode-gate-"),
    hasUI: false,
    model: undefined,
    modelRegistry: { getAvailable: () => [] },
  });

  assert.equal(fake.thinkingLevel, "high");
  assert.deepEqual(fake.activeTools, fullToolSet);
  toolStart({ toolName: "chalin_route", args: {} });
  assert.equal(fake.thinkingLevel, "low");
  assert.deepEqual(fake.activeTools, fullToolSet);
  assert.deepEqual(fake.toolSetHistory, []);
});

test("primary Pi keeps interview and web search available for ambiguous URL/docs decisions without forcing route", async () => {
  const fake = createFakePi();
  const fullToolSet = ["read", "bash", "grep", "find", "ls", "edit", "write", "chalin_interview", "chalin_route", "chalin_web_search"];
  fake.activeTools = [...fullToolSet];
  registerPiChalin(fake.api as never);
  const beforeAgentStart = fake.handlers.get("before_agent_start")?.[0] as (event: unknown, ctx: unknown) => Promise<unknown>;
  const ctx = {
    cwd: tempDir("pi-chalin-main-webfetch-"),
    hasUI: false,
    model: undefined,
    modelRegistry: { getAvailable: () => [] },
  };

  await beforeAgentStart({
    type: "before_agent_start",
    prompt: "Actualiza docs/sdk-notes.md con los cambios puntuales de https://example.com/sdk-release-notes, preguntando si el alcance es ambiguo.",
    systemPrompt: "base",
    systemPromptOptions: {},
  }, ctx);

  assert.ok(fake.activeTools.includes("chalin_interview"));
  assert.ok(fake.activeTools.includes("chalin_web_search"));
  assert.ok(fake.activeTools.includes("read"));
  assert.ok(fake.activeTools.includes("edit"));
  assert.notDeepEqual(fake.activeTools, ["chalin_route"]);
});

test("bounded local prompts keep route and native tools available for model choice", async () => {
  const fake = createFakePi();
  const fullToolSet = ["read", "bash", "edit", "write", "grep", "find", "ls", "chalin_interview", "chalin_route", "chalin_web_search"];
  fake.activeTools = [...fullToolSet];
  registerPiChalin(fake.api as never);
  const beforeAgentStart = fake.handlers.get("before_agent_start")?.[0] as (event: unknown, ctx: unknown) => Promise<unknown>;

  await beforeAgentStart({
    type: "before_agent_start",
    prompt: "Actualiza src/cache.ts y test/cache.test.ts para corregir una clave compuesta local y deja bun test pasando.",
    systemPrompt: "base",
    systemPromptOptions: {},
  }, {
    cwd: tempDir("pi-chalin-local-no-webfetch-"),
    hasUI: false,
    model: undefined,
    modelRegistry: { getAvailable: () => [] },
  });

  assert.deepEqual(fake.activeTools, fullToolSet);
});

test("bounded release and git operations keep native and orchestration tools available", async () => {
  const prompts = [
    "hey bump the package json versions please, for the last merge that we do in the main branch",
    "sync manifest and lockfile version metadata for the changed packages",
    "move the current version bump changes to a release branch and open a fully documented PR",
    "create a release branch for the current staged changes and push it",
  ];

  for (const prompt of prompts) {
    const fake = createFakePi();
    const fullToolSet = ["read", "bash", "edit", "write", "grep", "find", "ls", "chalin_interview", "chalin_route", "chalin_web_search", "chalin_memory_search"];
    fake.activeTools = [...fullToolSet];
    registerPiChalin(fake.api as never);
    const beforeAgentStart = fake.handlers.get("before_agent_start")?.[0] as (event: unknown, ctx: unknown) => Promise<unknown>;

    await beforeAgentStart({
      type: "before_agent_start",
      prompt,
      systemPrompt: "base",
      systemPromptOptions: {},
    }, {
      cwd: tempDir("pi-chalin-bounded-release-direct-"),
      hasUI: false,
      model: undefined,
      modelRegistry: { getAvailable: () => [] },
    });

    assert.ok(fake.activeTools.includes("read"), prompt);
    assert.ok(fake.activeTools.includes("bash"), prompt);
    assert.ok(fake.activeTools.includes("edit"), prompt);
    assert.ok(fake.activeTools.includes("write"), prompt);
    assert.ok(fake.activeTools.includes("chalin_route"), prompt);
    assert.ok(fake.activeTools.includes("chalin_interview"), prompt);
    assert.deepEqual(fake.activeTools, fullToolSet, prompt);
  }
});

test("broad release and PR analysis are not programmatically forced to route-only", async () => {
  const prompts = [
    "review this PR and summarize architecture risks",
    "analiza la estrategia de release y compara opciones para todo el monorepo",
  ];

  for (const prompt of prompts) {
    const fake = createFakePi();
    const fullToolSet = ["read", "bash", "edit", "write", "grep", "find", "ls", "chalin_interview", "chalin_route", "chalin_web_search", "chalin_memory_search"];
    fake.activeTools = [...fullToolSet];
    registerPiChalin(fake.api as never);
    const beforeAgentStart = fake.handlers.get("before_agent_start")?.[0] as (event: unknown, ctx: unknown) => Promise<unknown>;

    await beforeAgentStart({
      type: "before_agent_start",
      prompt,
      systemPrompt: "base",
      systemPromptOptions: {},
    }, {
      cwd: tempDir("pi-chalin-broad-release-route-"),
      hasUI: false,
      model: undefined,
      modelRegistry: { getAvailable: () => [] },
    });

    assert.deepEqual(fake.activeTools, fullToolSet, prompt);
  }
});

test("pi-chalin keeps direct tools for bounded review, root docs edits, and explicit commands", async () => {
  const fake = createFakePi();
  const fullToolSet = ["read", "bash", "grep", "find", "ls", "edit", "write", "chalin_route"];
  registerPiChalin(fake.api as never);
  const beforeAgentStart = fake.handlers.get("before_agent_start")?.[0] as (event: unknown, ctx: unknown) => Promise<unknown>;
  const ctx = {
    cwd: tempDir("pi-chalin-direct-gate-exclusions-"),
    hasUI: false,
    model: undefined,
    modelRegistry: { getAvailable: () => [] },
  };

  const prompts = [
    { text: "Revisa este mini proyecto y dime si hay riesgo de seguridad en el boundary de auth. No modifiques archivos; entrega evidencia con paths concretos.", expected: fullToolSet },
    { text: "corrige un typo en el README", expected: fullToolSet },
    { text: "corre bun test y dime si pasa", expected: fullToolSet },
  ];
  for (const prompt of prompts) {
    fake.activeTools = [...fullToolSet];
    await beforeAgentStart({
      type: "before_agent_start",
      prompt: prompt.text,
      systemPrompt: "base",
      systemPromptOptions: {},
    }, ctx);
    assert.deepEqual(fake.activeTools, prompt.expected, prompt.text);
  }
});


test("resumable run context lets the parent decide chalin_resume without a prompt classifier", async () => {
  const fake = createFakePi();
  registerPiChalin(fake.api as never);
  const beforeAgentStart = fake.handlers.get("before_agent_start")?.[0] as (event: unknown, ctx: unknown) => Promise<{ systemPrompt?: string; message?: { customType?: string; content?: string; display?: boolean } } | undefined>;
  const cwd = tempDir("pi-chalin-resume-steer-");
  const route: RunState["route"] = {
    kind: "multi-agent-sequential",
    agents: ["scout", "planner", "worker"],
    risk: "medium",
    ambiguity: "low",
    needsMemory: false,
    needsArtifacts: true,
    reason: "interrupted workflow",
    plan: { kind: "sequential", steps: [{ agent: "scout", task: "scan" }, { agent: "planner", task: "plan" }, { agent: "worker", task: "implement" }] },
  };
  const stale = createRunState(route, cwd);
  stale.status = "running";
  stale.steps[0]!.status = "complete";
  stale.steps[0]!.output = { agent: "scout", text: "mapped", handoff: "Scout mapped the repo.", memoryCandidates: [], raw: "mapped", warnings: [] };
  stale.steps[1]!.status = "running";
  stale.steps[1]!.currentTool = "read";
  persistRun(stale);

  const promptResult = await beforeAgentStart({
    type: "before_agent_start",
    prompt: "continua",
    systemPrompt: "base",
    systemPromptOptions: {},
  }, {
    cwd,
    hasUI: true,
    model: undefined,
    modelRegistry: { getAvailable: () => [] },
    ui: { notify: () => {}, setStatus: () => {}, setWidget: () => {} },
  });

  assert.equal(promptResult?.message?.customType, "pi-chalin-orchestration");
  assert.equal(promptResult?.message?.display, false);
  assert.doesNotMatch(promptResult?.systemPrompt ?? "", /resume orchestration \(compact\)/i);
  assert.match(promptResult?.systemPrompt ?? "", /Available pi-chalin agents/i);
  assert.match(promptResult?.message?.content ?? "", /Resumable pi-chalin run available/i);
  assert.match(promptResult?.message?.content ?? "", /use LLM judgment/i);
  assert.match(promptResult?.message?.content ?? "", /call `chalin_resume`/i);
  assert.match(promptResult?.message?.content ?? "", new RegExp(stale.id));
  assert.match(promptResult?.message?.content ?? "", /"runId"/);

  const recovered = JSON.parse(fs.readFileSync(stale.logsPath!, "utf-8")) as RunState;
  assert.equal(recovered.status, "running");
  assert.doesNotMatch(recovered.warnings.join("\n"), /Recovered stale running run/);
});

test("new unrelated prompts do not inherit stale resumable run context", async () => {
  const fake = createFakePi();
  registerPiChalin(fake.api as never);
  const beforeAgentStart = fake.handlers.get("before_agent_start")?.[0] as (event: unknown, ctx: unknown) => Promise<{ systemPrompt?: string; message?: { customType?: string; content?: string; display?: boolean } } | undefined>;
  const cwd = tempDir("pi-chalin-resume-isolation-");
  const route: RunState["route"] = {
    kind: "multi-agent-sequential",
    agents: ["scout", "planner", "worker"],
    risk: "medium",
    ambiguity: "low",
    needsMemory: false,
    needsArtifacts: true,
    reason: "old interrupted workflow",
    plan: { kind: "sequential", steps: [{ agent: "scout", task: "scan" }, { agent: "planner", task: "plan" }, { agent: "worker", task: "implement" }] },
  };
  const stale = createRunState(route, cwd, "old docs spec task");
  stale.status = "paused";
  stale.steps[0]!.status = "complete";
  stale.steps[0]!.output = { agent: "scout", text: "mapped", handoff: "Old scout handoff.", memoryCandidates: [], raw: "mapped", warnings: [] };
  stale.steps[1]!.status = "paused";
  persistRun(stale);

  const promptResult = await beforeAgentStart({
    type: "before_agent_start",
    prompt: "hey haz un analisis full de este proyecto busca puntos debiles de mantenibilidad en profundidad",
    systemPrompt: "base",
    systemPromptOptions: {},
  }, {
    cwd,
    hasUI: true,
    model: undefined,
    modelRegistry: { getAvailable: () => [] },
    ui: { notify: () => {}, setStatus: () => {}, setWidget: () => {} },
  });

  assert.doesNotMatch(promptResult?.message?.content ?? "", /Resumable pi-chalin run available/i);
  assert.doesNotMatch(promptResult?.message?.content ?? "", new RegExp(stale.id));
});

test("session_start resets stale in-memory chalin run state", async () => {
  const fake = createFakePi();
  registerPiChalin(fake.api as never);
  const sessionStart = fake.handlers.get("session_start")?.[0] as (event: unknown, ctx: unknown) => void;
  const cwd = tempDir("pi-chalin-session-reset-");
  const run = createRunState({
    kind: "multi-agent-sequential",
    agents: ["worker"],
    risk: "low",
    ambiguity: "low",
    needsMemory: false,
    needsArtifacts: true,
    reason: "stale running state",
    plan: { kind: "sequential", steps: [{ agent: "worker", task: "old work" }] },
  }, cwd, "old task");
  setLatestRun(run);

  sessionStart({ type: "session_start" }, {
    cwd,
    hasUI: true,
    sessionManager: { getSessionDir: () => cwd, getSessionFile: () => path.join(cwd, "current.json"), getCwd: () => cwd },
    ui: { notify: () => {}, setStatus: () => {}, setWidget: () => {} },
  });

  assert.equal(getLatestRun(), undefined);
});


test("production autoroute prompts do not embed workflow fixture-specific shortcuts", () => {
  const productionPromptFiles = [
    path.join(process.cwd(), "src", "autoroute.ts"),
    path.join(process.cwd(), "src", "orchestration.ts"),
    path.join(process.cwd(), "src", "runtime-state.ts"),
    path.join(process.cwd(), "src", "runner-prompt.ts"),
  ];
  const combined = productionPromptFiles.map((file) => fs.readFileSync(file, "utf-8")).join("\n");
  for (const pattern of [
    /safeDivide/i,
    /calculateInvoice/i,
    /normalize_index_url/i,
    /build_cache_key/i,
    /ascii_trim/i,
    /count_sql_tokens/i,
    /DiagnosticEngine/i,
    /Parser\.cpp/i,
    /deny-net/i,
    /12\.5\/7\.25/i,
    /rate-limit config/i,
    /deterministic key builder/i,
    /normalization\/canonicalization/i,
    /C\/string bugfix/i,
    /syncRecords/i,
    /Diagnostic and diagn[oó]stico/i,
    /gofmt -w cache\/cache\.go cache\/cache_test\.go/i,
    /For clamp use/i,
    /bridge sentence using the manifest command/i,
  ]) {
    assert.doesNotMatch(combined, pattern);
  }

  const autorouteSource = fs.readFileSync(path.join(process.cwd(), "src", "autoroute.ts"), "utf-8");
  for (const pattern of [
    /looksLikeChalinOrchestrationWork/,
    /shouldUseCompactChalinCriticalPrompt/,
    /looksLikeScaffoldContract/,
    /looksLikeBoundedDocsOnlyArtifactPrompt/,
    /looksLikeSingleSymbolExistingVerification/,
    /en profundidad\|deep/,
    /cross-language\|multi-language/,
    /security review\|broad/,
  ]) {
    assert.doesNotMatch(autorouteSource, pattern);
  }
});

test("direct bounded edits get one completion nudge after verification", async () => {
  const fake = createFakePi();
  registerPiChalin(fake.api as never);
  const beforeAgentStart = fake.handlers.get("before_agent_start")?.[0] as (event: unknown, ctx: unknown) => Promise<{ message?: { content?: string; customType?: string } } | undefined>;
  const contextHandler = fake.handlers.get("context")?.[0] as (event: { type: "context"; messages: unknown[] }, ctx: unknown) => unknown;
  const toolExecutionEnd = fake.handlers.get("tool_execution_end")?.[0] as (event: { toolName: string; isError?: boolean; args?: Record<string, unknown> }, ctx: unknown) => void;
  assert.equal(typeof beforeAgentStart, "function");
  assert.equal(typeof toolExecutionEnd, "function");

  const ctx = {
    cwd: tempDir("pi-chalin-direct-nudge-"),
    hasUI: false,
    model: undefined,
    modelRegistry: { getAvailable: () => [] },
  };
  await beforeAgentStart({ type: "before_agent_start", prompt: "fix src/parseDate.ts", systemPrompt: "base", systemPromptOptions: {} }, ctx);

  toolExecutionEnd({ toolName: "bash", isError: false, args: { command: "bun test" } }, ctx);
  assert.equal(fake.messages.some((item) => (item.message as { customType?: string }).customType === "pi-chalin-direct-completion-nudge"), false, "verification before mutation is not enough");

  toolExecutionEnd({ toolName: "edit", isError: false }, ctx);
  toolExecutionEnd({ toolName: "edit", isError: false, args: { path: "test/parseDate.test.ts" } }, ctx);
  const progressNudges = fake.messages.filter((item) => (item.message as { customType?: string }).customType === "pi-chalin-direct-progress-nudge");
  assert.equal(progressNudges.length, 1, "mutation gets a progress nudge");
  assert.match((progressNudges[0]?.message as { content?: string }).content ?? "", /Keep the loop proportional/i);
  assert.match((progressNudges[0]?.message as { content?: string }).content ?? "", /nearest source\/test contract/i);
  assert.match((progressNudges[0]?.message as { content?: string }).content ?? "", /first mutation happened before reading an existing source\/test surface/i);
  assert.match((progressNudges[0]?.message as { content?: string }).content ?? "", /add\/update the focused tests before the first verification/i);
  assert.match((progressNudges[0]?.message as { content?: string }).content ?? "", /Preserve compatibility/i);
  assert.match((progressNudges[0]?.message as { content?: string }).content ?? "", /runner-discoverable tests/i);
  assert.match((progressNudges[0]?.message as { content?: string }).content ?? "", /Do not read back just to summarize/i);
  assert.match((progressNudges[0]?.message as { content?: string }).content ?? "", /real command path/i);
  assert.match((progressNudges[0]?.message as { content?: string }).content ?? "", /supported claims/i);
  assert.equal(fake.messages.filter((item) => (item.message as { customType?: string }).customType === "pi-chalin-direct-ready-to-verify-nudge").length, 0, "first code edit is not treated as verification-ready");
  const sourceTestReady = fake.messages.filter((item) => (item.message as { customType?: string }).customType === "pi-chalin-direct-source-test-ready-nudge");
  assert.equal(sourceTestReady.length, 1, "source+test edits get one verify-now nudge");
  assert.match((sourceTestReady[0]?.message as { content?: string }).content ?? "", /Source and tests changed/i);
  assert.match((sourceTestReady[0]?.message as { content?: string }).content ?? "", /requested package\/API\/docs\/README metadata/i);
  assert.match((sourceTestReady[0]?.message as { content?: string }).content ?? "", /runner-compatible imports\/assertions/i);
  assert.match((sourceTestReady[0]?.message as { content?: string }).content ?? "", /requested test path\/glob\/extension/i);
  assert.match((sourceTestReady[0]?.message as { content?: string }).content ?? "", /only has an empty\/smoke\/no-op case/i);
  assert.match((sourceTestReady[0]?.message as { content?: string }).content ?? "", /assertions must visibly cover the named criteria/i);
  assert.match((sourceTestReady[0]?.message as { content?: string }).content ?? "", /Stop expanding scope/i);
  assert.match((sourceTestReady[0]?.message as { content?: string }).content ?? "", /nearest package verification/i);
  assert.match((sourceTestReady[0]?.message as { content?: string }).content ?? "", /text query blank\/no-match\/order/i);
  assert.match((sourceTestReady[0]?.message as { content?: string }).content ?? "", /API payload missing\/null\/array\/type\/blank\/format branches/i);
  assert.match((sourceTestReady[0]?.message as { content?: string }).content ?? "", /parser\/delimiter adjacency\/protected\/escaping\/EOF including SQL doubled-quote strings/i);
  assert.match((sourceTestReady[0]?.message as { content?: string }).content ?? "", /Python unittest discoverable `tests\/` path/i);
  assert.match((sourceTestReady[0]?.message as { content?: string }).content ?? "", /validation normalization-before-regex/i);
  assert.match((sourceTestReady[0]?.message as { content?: string }).content ?? "", /explicit numeric\/domain bounds fail fast/i);
  assert.match((sourceTestReady[0]?.message as { content?: string }).content ?? "", /time\/rate fake time with no sleeps/i);
  assert.match((sourceTestReady[0]?.message as { content?: string }).content ?? "", /sort primary\/secondary\/tie\/no mutation/i);
  assert.match((sourceTestReady[0]?.message as { content?: string }).content ?? "", /Tiny stubs may be replaced once/i);
  assert.match((sourceTestReady[0]?.message as { content?: string }).content ?? "", /existing large\/partial files stay targeted edits/i);
  assert.equal(fake.messages.some((item) => (item.message as { customType?: string }).customType === "pi-chalin-direct-completion-nudge"), false, "mutation alone is not enough for completion");

  toolExecutionEnd({ toolName: "bash", isError: true, args: { command: "bun test" } }, ctx);
  const failureNudges = fake.messages.filter((item) => (item.message as { customType?: string }).customType === "pi-chalin-direct-verification-failed-nudge");
  assert.equal(failureNudges.length, 1);
  assert.match((failureNudges[0]?.message as { content?: string }).content ?? "", /Do NOT answer as done yet/i);
  assert.match((failureNudges[0]?.message as { content?: string }).content ?? "", /bun test/i);
  assert.match((failureNudges[0]?.message as { content?: string }).content ?? "", /Use the latest failure as evidence/i);
  assert.match((failureNudges[0]?.message as { content?: string }).content ?? "", /Patch the exact failing source or assertion/i);
  assert.match((failureNudges[0]?.message as { content?: string }).content ?? "", /fewer tests than you wrote/i);
  assert.match((failureNudges[0]?.message as { content?: string }).content ?? "", /Do not grep\/find\/read broad surfaces for a known symbol/i);
  assert.match((failureNudges[0]?.message as { content?: string }).content ?? "", /at most one targeted read of an already changed file/i);
  assert.match((failureNudges[0]?.message as { content?: string }).content ?? "", /failure is superseded/i);
  assert.match((failureNudges[0]?.message as { content?: string }).content ?? "", /repo runner\/package manager/i);
  assert.match((failureNudges[0]?.message as { content?: string }).content ?? "", /node:test\/node:assert/i);
  assert.match((failureNudges[0]?.message as { content?: string }).content ?? "", /wrong-runner verification is invalid/i);
  assert.doesNotMatch((failureNudges[0]?.message as { content?: string }).content ?? "", /process\.env/i);

  toolExecutionEnd({ toolName: "bash", isError: false, args: { command: "bun test" } }, ctx);
  const nudges = fake.messages.filter((item) => (item.message as { customType?: string }).customType === "pi-chalin-direct-completion-nudge");
  assert.equal(nudges.length, 1);
  const nudgeContent = (nudges[0]?.message as { content?: string }).content ?? "";
  assert.match(nudgeContent, /Final now if the last edit output plus `bun test` already prove/i);
  assert.match(nudgeContent, /readback after pass is waste/i);
  assert.match(nudgeContent, /do not read `test\/parseDate\.test\.ts` just to summarize/i);
  assert.match(nudgeContent, /If requested API\/tests\/docs\/README\/manifest\/bin\/export\/toolchain/i);
  assert.match(nudgeContent, /package-runner coherence/i);
  assert.match(nudgeContent, /trivial smoke test is not enough/i);
  assert.match(nudgeContent, /README\/API\/usage docs/i);
  assert.match(nudgeContent, /package\/bin\/export\/module metadata/i);
  assert.match(nudgeContent, /no extra post-test shell is needed/i);
  assert.match(nudgeContent, /only says what you will do is invalid/i);
  assert.match(nudgeContent, /Verification: `bun test` passed/i);
  assert.match(nudgeContent, /do not run another shell\/test command/i);
  assert.match(nudgeContent, /concise but complete/i);
  assert.match(nudgeContent, /boundary\/preservation evidence/i);
  assert.match(nudgeContent, /test counts and paths must match the actual verification output/i);
  assert.deepEqual(nudges[0]?.options, { triggerTurn: false, deliverAs: "steer" });

  toolExecutionEnd({ toolName: "grep", isError: false, args: { path: "src", pattern: "parseIsoDate" } }, ctx);
  const postVerificationExploration = fake.messages.filter((item) => (item.message as { customType?: string }).customType === "pi-chalin-post-verification-exploration-nudge");
  assert.equal(postVerificationExploration.length, 1, "extra discovery after passing verification gets a stop nudge");
  assert.match((postVerificationExploration[0]?.message as { content?: string }).content ?? "", /Stop post-verification discovery/i);
  assert.match((postVerificationExploration[0]?.message as { content?: string }).content ?? "", /final now/i);
  assert.match((postVerificationExploration[0]?.message as { content?: string }).content ?? "", /Do not read back just to summarize/i);
  const postVerificationContext = contextHandler({ type: "context", messages: [] }, ctx) as { messages?: Array<{ customType?: string; content?: string }> } | undefined;
  const criticalGuard = postVerificationContext?.messages?.find((message) => message.customType === "pi-chalin-direct-critical-guard");
  assert.match(criticalGuard?.content ?? "", /verification already passed/i);
  assert.match(criticalGuard?.content ?? "", /final answer/i);
  assert.match(criticalGuard?.content ?? "", /Do not call more tools/i);

  toolExecutionEnd({ toolName: "read", isError: false, args: { path: "test/parseDate.test.ts" } }, ctx);
  const readbackNudges = fake.messages.filter((item) => (item.message as { customType?: string }).customType === "pi-chalin-direct-completion-nudge");
  assert.equal(readbackNudges.length, 2, "changed-file readback after a passing verification gets a final stop nudge");
  assert.match((readbackNudges[1]?.message as { content?: string }).content ?? "", /do not run another shell\/test command/i);

  toolExecutionEnd({ toolName: "bash", isError: false, args: { command: "bun test" } }, ctx);
  const postVerificationNudges = fake.messages.filter((item) => (item.message as { customType?: string }).customType === "pi-chalin-post-verification-shell-nudge");
  assert.equal(postVerificationNudges.length, 1, "extra shell after passing verification gets a stop nudge");
  assert.match((postVerificationNudges[0]?.message as { content?: string }).content ?? "", /Verification already passed/i);
  assert.match((postVerificationNudges[0]?.message as { content?: string }).content ?? "", /final now/i);
  assert.match((postVerificationNudges[0]?.message as { content?: string }).content ?? "", /Do not read back after pass just to summarize/i);

  toolExecutionEnd({ toolName: "edit", isError: false }, ctx);
  toolExecutionEnd({ toolName: "edit", isError: false, args: { path: "test/parseDate.test.ts" } }, ctx);
  assert.equal(fake.messages.filter((item) => (item.message as { customType?: string }).customType === "pi-chalin-direct-progress-nudge").length, 1, "progress nudge is sent once per turn");
  assert.equal(fake.messages.filter((item) => (item.message as { customType?: string }).customType === "pi-chalin-direct-ready-to-verify-nudge").length, 0, "source+test-ready steer replaces the generic verification-ready nudge");
  assert.equal(fake.messages.filter((item) => (item.message as { customType?: string }).customType === "pi-chalin-direct-source-test-ready-nudge").length, 2, "editing after verification invalidates stale verification and asks for a fresh check");

  toolExecutionEnd({ toolName: "bash", isError: false, args: { command: "bun test" } }, ctx);
  assert.equal(fake.messages.filter((item) => (item.message as { customType?: string }).customType === "pi-chalin-direct-completion-nudge").length, 3, "new edits after verification require a new completion nudge");
});

test("direct PR creation is terminal and stops pr body rewrite loops", async () => {
  const fake = createFakePi();
  registerPiChalin(fake.api as never);
  const beforeAgentStart = fake.handlers.get("before_agent_start")?.[0] as (event: unknown, ctx: unknown) => Promise<unknown>;
  const contextHandler = fake.handlers.get("context")?.[0] as (event: { type: "context"; messages: unknown[] }, ctx: unknown) => unknown;
  const toolExecutionEnd = fake.handlers.get("tool_execution_end")?.[0] as (event: { toolName: string; isError?: boolean; args?: Record<string, unknown> }, ctx: unknown) => void;
  const ctx = {
    cwd: tempDir("pi-chalin-pr-terminal-"),
    hasUI: false,
    model: undefined,
    modelRegistry: { getAvailable: () => [] },
  };
  await beforeAgentStart({
    type: "before_agent_start",
    prompt: "open a pull request fully detailed pointing main branch put labels and all the recommended thing in the description",
    systemPrompt: "base",
    systemPromptOptions: {},
  }, ctx);

  toolExecutionEnd({ toolName: "bash", isError: false, args: { command: "bun test" } }, ctx);
  toolExecutionEnd({ toolName: "write", isError: false, args: { path: "outputs/pr-body.md", content: "## Summary\n\nReady.\n" } }, ctx);
  toolExecutionEnd({
    toolName: "bash",
    isError: false,
    args: {
      command: "gh pr create --base main --head feat/smarter-orchestration-token-prompts --title \"feat: improve orchestration\" --body-file outputs/pr-body.md --label enhancement",
    },
  }, ctx);

  const terminalNudges = fake.messages.filter((item) => (item.message as { customType?: string }).customType === "pi-chalin-terminal-completion-nudge");
  assert.equal(terminalNudges.length, 1);
  assert.match((terminalNudges[0]?.message as { content?: string }).content ?? "", /external workflow completed successfully/i);
  assert.match((terminalNudges[0]?.message as { content?: string }).content ?? "", /Final now/i);
  assert.match((terminalNudges[0]?.message as { content?: string }).content ?? "", /rewrite PR body files/i);

  const terminalContext = contextHandler({ type: "context", messages: [] }, ctx) as { messages?: Array<{ customType?: string; content?: string }> } | undefined;
  const terminalGuard = terminalContext?.messages?.find((message) => message.customType === "pi-chalin-direct-critical-guard");
  assert.match(terminalGuard?.content ?? "", /external workflow already completed/i);
  assert.match(terminalGuard?.content ?? "", /gh pr create/i);
  assert.match(terminalGuard?.content ?? "", /Do not call more tools/i);

  toolExecutionEnd({ toolName: "write", isError: false, args: { path: "outputs/pr-body.md", content: "## Summary\n\nReady again.\n" } }, ctx);
  const driftNudges = fake.messages.filter((item) => (item.message as { customType?: string }).customType === "pi-chalin-post-terminal-drift-nudge");
  assert.equal(driftNudges.length, 1);
  assert.match((driftNudges[0]?.message as { content?: string }).content ?? "", /terminal external action already completed/i);
  assert.match((driftNudges[0]?.message as { content?: string }).content ?? "", /Do not mutate or rewrite support artifacts/i);
});


test("bounded direct prompts do not hide orchestration tools programmatically", async () => {
  const fake = createFakePi();
  registerPiChalin(fake.api as never);
  const beforeAgentStart = fake.handlers.get("before_agent_start")?.[0] as (event: unknown, ctx: unknown) => Promise<unknown>;
  const ctx = {
    cwd: tempDir("pi-chalin-direct-tool-scope-"),
    hasUI: false,
    model: undefined,
    modelRegistry: { getAvailable: () => [] },
  };
  const fullToolSet = ["read", "bash", "edit", "write", "grep", "find", "ls", "chalin_project_discovery", "chalin_project_snapshot", "chalin_route", "chalin_web_search"];

  fake.activeTools = [...fullToolSet];
  await beforeAgentStart({
    type: "before_agent_start",
    prompt: "Añade un test unitario que cubra división por cero en src/safeDivide.ts. Si el comportamiento ya existe, no refactorices de más.",
    systemPrompt: "base",
    systemPromptOptions: {},
  }, ctx);
  assert.deepEqual(fake.activeTools, fullToolSet);

  fake.activeTools = [...fullToolSet];
  await beforeAgentStart({
    type: "before_agent_start",
    prompt: "Scaffoldea un CLI TypeScript mínimo llamado note-pack: package.json, src/cli.ts, README con uso, y test básico en test/cli.test.ts. Usa Bun.",
    systemPrompt: "base",
    systemPromptOptions: {},
  }, ctx);
  assert.deepEqual(fake.activeTools, fullToolSet);
});

test("direct source and test edits reject trivial smoke coverage before final", async () => {
  const fake = createFakePi();
  registerPiChalin(fake.api as never);
  const beforeAgentStart = fake.handlers.get("before_agent_start")?.[0] as (event: unknown, ctx: unknown) => Promise<unknown>;
  const contextHandler = fake.handlers.get("context")?.[0] as (event: { type: "context"; messages: unknown[] }, ctx: unknown) => unknown;
  const toolExecutionEnd = fake.handlers.get("tool_execution_end")?.[0] as (event: { toolName: string; isError?: boolean; args?: Record<string, unknown> }, ctx: unknown) => void;
  const ctx = {
    cwd: tempDir("pi-chalin-weak-tests-"),
    hasUI: false,
    model: undefined,
    modelRegistry: { getAvailable: () => [] },
  };
  await beforeAgentStart({
    type: "before_agent_start",
    prompt: "Implementa sortItems en src/sortItems.ts con prioridad, fecha, estabilidad y tests.",
    systemPrompt: "base",
    systemPromptOptions: {},
  }, ctx);

  toolExecutionEnd({ toolName: "edit", isError: false, args: { path: "src/sortItems.ts" } }, ctx);
  toolExecutionEnd({
    toolName: "write",
    isError: false,
    args: {
      path: "test/sortItems.test.ts",
      content: [
        "import { test } from \"bun:test\";",
        "import assert from \"node:assert/strict\";",
        "test(\"empty list\", () => {",
        "  assert.deepEqual(sortItems([]), []);",
        "});",
      ].join("\n"),
    },
  }, ctx);
  toolExecutionEnd({ toolName: "bash", isError: false, args: { command: "bun test test/sortItems.test.ts" } }, ctx);

  const weakCoverage = fake.messages.filter((item) => (item.message as { customType?: string }).customType === "pi-chalin-direct-weak-test-coverage-nudge");
  assert.equal(weakCoverage.length, 1);
  assert.match((weakCoverage[0]?.message as { content?: string }).content ?? "", /trivial smoke\/empty coverage/i);
  assert.match((weakCoverage[0]?.message as { content?: string }).content ?? "", /Do NOT final yet/i);
  assert.match((weakCoverage[0]?.message as { content?: string }).content ?? "", /prompt-named criteria/i);
  assert.equal(fake.messages.filter((item) => (item.message as { customType?: string }).customType === "pi-chalin-direct-completion-nudge").length, 0);
  const weakGuardContext = await contextHandler({ type: "context", messages: [] }, ctx) as { messages?: Array<{ customType?: string; content?: string }> };
  assert.equal(weakGuardContext.messages?.at(-1)?.customType, "pi-chalin-direct-critical-guard");
  assert.match(weakGuardContext.messages?.at(-1)?.content ?? "", /final answer is invalid/i);
  assert.match(weakGuardContext.messages?.at(-1)?.content ?? "", /trivial smoke\/empty coverage/i);
  assert.match(weakGuardContext.messages?.at(-1)?.content ?? "", /next assistant action must be a tool call/i);

  toolExecutionEnd({
    toolName: "write",
    isError: false,
    args: {
      path: "test/sortItems.test.ts",
      content: [
        "import { test } from \"bun:test\";",
        "import assert from \"node:assert/strict\";",
        "test(\"priority then date\", () => { assert.deepEqual(sortItems(sample).map(x => x.id), [\"a\", \"b\"]); });",
        "test(\"stable ties\", () => { assert.deepEqual(sortItems(ties).map(x => x.id), [\"first\", \"second\"]); });",
        "test(\"does not mutate original\", () => { const items = [...sample]; sortItems(items); assert.deepEqual(items, sample); });",
      ].join("\n"),
    },
  }, ctx);
  toolExecutionEnd({ toolName: "bash", isError: false, args: { command: "bun test test/sortItems.test.ts" } }, ctx);
  assert.equal(fake.messages.filter((item) => (item.message as { customType?: string }).customType === "pi-chalin-direct-completion-nudge").length, 1);
  assert.equal(await contextHandler({ type: "context", messages: [] }, ctx), undefined);
});

test("direct rare gap diagnostics are derived from tool event history", async () => {
  const fake = createFakePi();
  registerPiChalin(fake.api as never);
  const beforeAgentStart = fake.handlers.get("before_agent_start")?.[0] as (event: unknown, ctx: unknown) => Promise<unknown>;
  const toolExecutionEnd = fake.handlers.get("tool_execution_end")?.[0] as (event: { toolName: string; isError?: boolean; args?: Record<string, unknown> }, ctx: unknown) => void;
  const { getDirectDerivedGapDiagnosticsForTests } = await import("../src/runtime-state.ts");
  const ctx = {
    cwd: tempDir("pi-chalin-derived-gaps-"),
    hasUI: false,
    model: undefined,
    modelRegistry: { getAvailable: () => [] },
  };
  await beforeAgentStart({
    type: "before_agent_start",
    prompt: "Create a TypeScript CLI package with package.json, src/cli.ts, tests, and real coverage.",
    systemPrompt: "base",
    systemPromptOptions: {},
  }, ctx);

  toolExecutionEnd({ toolName: "write", isError: false, args: { path: "src/cli.ts", content: "export function main() { return 1; }\n" } }, ctx);
  toolExecutionEnd({ toolName: "write", isError: false, args: { path: "test/cli.test.ts", content: "test('empty', () => expect(1).toBe(1));\n" } }, ctx);
  toolExecutionEnd({ toolName: "write", isError: false, args: { path: "package.json", content: JSON.stringify({ name: "demo", bin: { demo: "src/cli.ts" } }) } }, ctx);

  assert.deepEqual(getDirectDerivedGapDiagnosticsForTests(), {
    weakTestCoverage: true,
    packageMetadata: true,
    parallelSurface: undefined,
  });

  toolExecutionEnd({
    toolName: "write",
    isError: false,
    args: {
      path: "test/cli.test.ts",
      content: [
        "import { test, expect } from 'bun:test';",
        "test('prints help', () => expect(renderHelp()).toContain('Usage'));",
        "test('rejects blank input', () => expect(() => parseArgs([''])).toThrow());",
      ].join("\n"),
    },
  }, ctx);
  toolExecutionEnd({ toolName: "write", isError: false, args: { path: "package.json", content: JSON.stringify({ name: "demo", type: "module", bin: { demo: "src/cli.ts" } }) } }, ctx);

  assert.deepEqual(getDirectDerivedGapDiagnosticsForTests(), {
    weakTestCoverage: false,
    packageMetadata: false,
    parallelSurface: undefined,
  });
});

test("direct C tests with multiple assert calls are not mistaken for trivial empty coverage", async () => {
  const fake = createFakePi();
  registerPiChalin(fake.api as never);
  const beforeAgentStart = fake.handlers.get("before_agent_start")?.[0] as (event: unknown, ctx: unknown) => Promise<unknown>;
  const toolExecutionEnd = fake.handlers.get("tool_execution_end")?.[0] as (event: { toolName: string; isError?: boolean; args?: Record<string, unknown> }, ctx: unknown) => void;
  const ctx = {
    cwd: tempDir("pi-chalin-c-assert-coverage-"),
    hasUI: false,
    model: undefined,
    modelRegistry: { getAvailable: () => [] },
  };
  await beforeAgentStart({
    type: "before_agent_start",
    prompt: "Implementa en C una tabla TTL minima en src/expire_table.c con reloj inyectado y tests.",
    systemPrompt: "base",
    systemPromptOptions: {},
  }, ctx);

  toolExecutionEnd({ toolName: "edit", isError: false, args: { path: "src/expire_table.c" } }, ctx);
  toolExecutionEnd({
    toolName: "write",
    isError: false,
    args: {
      path: "tests/test_expire_table.c",
      content: [
        "#include <assert.h>",
        "#include <string.h>",
        "int main(void) {",
        "  /* empty table */",
        "  assert(expire_get(\"missing\", 0) == NULL);",
        "  expire_set(\"k\", \"v\", 100, 0);",
        "  assert(strcmp(expire_get(\"k\", 99), \"v\") == 0);",
        "  assert(expire_get(\"k\", 100) == NULL);",
        "  expire_set(\"a\", \"1\", 100, 0);",
        "  expire_set(\"b\", \"2\", 200, 50);",
        "  assert(expire_get(\"a\", 100) == NULL);",
        "  assert(strcmp(expire_get(\"b\", 100), \"2\") == 0);",
        "  return 0;",
        "}",
      ].join("\n"),
    },
  }, ctx);
  toolExecutionEnd({ toolName: "bash", isError: false, args: { command: "make test" } }, ctx);

  assert.equal(fake.messages.filter((item) => (item.message as { customType?: string }).customType === "pi-chalin-direct-weak-test-coverage-nudge").length, 0);
  const completion = fake.messages.filter((item) => (item.message as { customType?: string }).customType === "pi-chalin-direct-completion-nudge");
  assert.equal(completion.length, 1);
  assert.match((completion[0]?.message as { content?: string }).content ?? "", /Final now/i);
  assert.match((completion[0]?.message as { content?: string }).content ?? "", /make test/);
});

test("direct bounded edits hard-stop when prompt surface is bypassed by a parallel sibling", async () => {
  const fake = createFakePi();
  registerPiChalin(fake.api as never);
  const beforeAgentStart = fake.handlers.get("before_agent_start")?.[0] as (event: unknown, ctx: unknown) => Promise<unknown>;
  const contextHandler = fake.handlers.get("context")?.[0] as (event: { type: "context"; messages: unknown[] }, ctx: unknown) => unknown;
  const toolExecutionEnd = fake.handlers.get("tool_execution_end")?.[0] as (event: { toolName: string; isError?: boolean; args?: Record<string, unknown> }, ctx: unknown) => void;
  const ctx = {
    cwd: tempDir("pi-chalin-parallel-surface-"),
    hasUI: false,
    model: undefined,
    modelRegistry: { getAvailable: () => [] },
  };
  await beforeAgentStart({
    type: "before_agent_start",
    prompt: "Completa paginator.py con page 1-based, errores claros y tests de bordes.",
    systemPrompt: "base",
    systemPromptOptions: {},
  }, ctx);

  toolExecutionEnd({ toolName: "write", isError: false, args: { path: "paginator.py", content: "def paginate(items, page, page_size):\n    return {\"items\": list(items)}\n" } }, ctx);
  toolExecutionEnd({ toolName: "write", isError: false, args: { path: "tests/test_paginator.py", content: "import unittest\n\nclass TestPaginator(unittest.TestCase):\n    def test_stub(self):\n        self.assertEqual(1, 1)\n" } }, ctx);
  toolExecutionEnd({ toolName: "bash", isError: false, args: { command: "python3 -m unittest discover -s tests" } }, ctx);
  toolExecutionEnd({ toolName: "write", isError: false, args: { path: "paginate.py", content: "def paginate(items, page, page_size):\n    return {}\n" } }, ctx);
  toolExecutionEnd({ toolName: "write", isError: false, args: { path: "tests/test_paginate.py", content: "import unittest\nfrom paginate import paginate\n\nclass TestPaginate(unittest.TestCase):\n    def test_first_page(self):\n        self.assertEqual(paginate([1, 2, 3], 1, 2)[\"items\"], [1, 2])\n    def test_invalid_page(self):\n        with self.assertRaises(ValueError):\n            paginate([1, 2], 0, 2)\n" } }, ctx);
  toolExecutionEnd({ toolName: "bash", isError: false, args: { command: "python3 -m unittest discover -s tests" } }, ctx);

  assert.equal(fake.messages.filter((item) => (item.message as { customType?: string }).customType === "pi-chalin-direct-completion-nudge").length, 0);
  const parallelSurfaceNudges = fake.messages.filter((item) => (item.message as { customType?: string }).customType === "pi-chalin-direct-parallel-surface-nudge");
  assert.equal(parallelSurfaceNudges.length, 1);
  assert.match((parallelSurfaceNudges[0]?.message as { content?: string }).content ?? "", /parallel sibling surface/i);
  assert.match((parallelSurfaceNudges[0]?.message as { content?: string }).content ?? "", /Do NOT final yet/i);
  const guardContext = await contextHandler({ type: "context", messages: [] }, ctx) as { messages?: Array<{ customType?: string; content?: string }> };
  assert.equal(guardContext.messages?.at(-1)?.customType, "pi-chalin-direct-critical-guard");
  assert.match(guardContext.messages?.at(-1)?.content ?? "", /canonical surface `paginator\.py` was bypassed/i);
  assert.match(guardContext.messages?.at(-1)?.content ?? "", /`paginate\.py`/i);
  assert.match(guardContext.messages?.at(-1)?.content ?? "", /consolidate the implementation and tests/i);

  toolExecutionEnd({ toolName: "write", isError: false, args: { path: "paginator.py", content: "def paginate(items, page, page_size):\n    return {\"items\": items[:page_size]}\n" } }, ctx);
  toolExecutionEnd({ toolName: "write", isError: false, args: { path: "tests/test_paginator.py", content: "import unittest\nfrom paginator import paginate\n\nclass TestPaginator(unittest.TestCase):\n    def test_page(self):\n        self.assertEqual(paginate([1, 2, 3], 1, 2)[\"items\"], [1, 2])\n    def test_invalid_page(self):\n        with self.assertRaises(ValueError):\n            paginate([1, 2], 0, 2)\n" } }, ctx);
  toolExecutionEnd({ toolName: "bash", isError: false, args: { command: "rm paginate.py tests/test_paginate.py" } }, ctx);
  toolExecutionEnd({ toolName: "bash", isError: false, args: { command: "python3 -m unittest discover -s tests" } }, ctx);
  assert.equal(await contextHandler({ type: "context", messages: [] }, ctx), undefined);
});

test("direct bounded Python unittest edits hard-stop when root duplicate tests bypass tests root", async () => {
  const fake = createFakePi();
  registerPiChalin(fake.api as never);
  const beforeAgentStart = fake.handlers.get("before_agent_start")?.[0] as (event: unknown, ctx: unknown) => Promise<unknown>;
  const contextHandler = fake.handlers.get("context")?.[0] as (event: { type: "context"; messages: unknown[] }, ctx: unknown) => unknown;
  const toolExecutionEnd = fake.handlers.get("tool_execution_end")?.[0] as (event: { toolName: string; isError?: boolean; args?: Record<string, unknown> }, ctx: unknown) => void;
  const ctx = {
    cwd: tempDir("pi-chalin-python-root-duplicate-"),
    hasUI: false,
    model: undefined,
    modelRegistry: { getAvailable: () => [] },
  };
  await beforeAgentStart({
    type: "before_agent_start",
    prompt: "Implementa should_retry(attempt, max_attempts, exc) en retry_policy.py y añade unittest en tests.",
    systemPrompt: "base",
    systemPromptOptions: {},
  }, ctx);

  toolExecutionEnd({ toolName: "write", isError: false, args: { path: "retry_policy.py", content: "def should_retry(attempt, max_attempts, exc):\n    return attempt < max_attempts\n" } }, ctx);
  toolExecutionEnd({ toolName: "write", isError: false, args: { path: "tests/test_retry_policy.py", content: "import unittest\n\nclass RetryPolicyTest(unittest.TestCase):\n    def test_stub(self):\n        self.assertEqual(1, 1)\n" } }, ctx);
  toolExecutionEnd({ toolName: "write", isError: false, args: { path: "test_retry_policy.py", content: "import unittest\nfrom retry_policy import should_retry\n\nclass RetryPolicyRootTest(unittest.TestCase):\n    def test_transient_still_has_attempts(self):\n        self.assertTrue(should_retry(1, 3, ConnectionError()))\n    def test_max_attempts_stops(self):\n        self.assertFalse(should_retry(3, 3, ConnectionError()))\n" } }, ctx);
  toolExecutionEnd({ toolName: "bash", isError: false, args: { command: "python3 -m unittest discover -s tests" } }, ctx);

  assert.equal(fake.messages.filter((item) => (item.message as { customType?: string }).customType === "pi-chalin-direct-completion-nudge").length, 0);
  const parallelSurfaceNudges = fake.messages.filter((item) => (item.message as { customType?: string }).customType === "pi-chalin-direct-parallel-surface-nudge");
  assert.equal(parallelSurfaceNudges.length, 1);
  assert.match((parallelSurfaceNudges[0]?.message as { content?: string }).content ?? "", /parallel sibling surface/i);
  const guardContext = await contextHandler({ type: "context", messages: [] }, ctx) as { messages?: Array<{ customType?: string; content?: string }> };
  assert.equal(guardContext.messages?.at(-1)?.customType, "pi-chalin-direct-critical-guard");
  assert.match(guardContext.messages?.at(-1)?.content ?? "", /canonical surface `tests\/test_retry_policy\.py` was bypassed/i);
  assert.match(guardContext.messages?.at(-1)?.content ?? "", /`test_retry_policy\.py`/i);

  toolExecutionEnd({ toolName: "write", isError: false, args: { path: "tests/test_retry_policy.py", content: "import unittest\nfrom retry_policy import should_retry\n\nclass RetryPolicyTest(unittest.TestCase):\n    def test_transient_still_has_attempts(self):\n        self.assertTrue(should_retry(1, 3, ConnectionError()))\n    def test_max_attempts_stops(self):\n        self.assertFalse(should_retry(3, 3, ConnectionError()))\n" } }, ctx);
  toolExecutionEnd({ toolName: "bash", isError: false, args: { command: "rm test_retry_policy.py" } }, ctx);
  toolExecutionEnd({ toolName: "bash", isError: false, args: { command: "python3 -m unittest discover -s tests" } }, ctx);
  assert.equal(await contextHandler({ type: "context", messages: [] }, ctx), undefined);
});

test("direct scaffold edits require coherent package module metadata before final", async () => {
  const fake = createFakePi();
  registerPiChalin(fake.api as never);
  const beforeAgentStart = fake.handlers.get("before_agent_start")?.[0] as (event: unknown, ctx: unknown) => Promise<unknown>;
  const contextHandler = fake.handlers.get("context")?.[0] as (event: { type: "context"; messages: unknown[] }, ctx: unknown) => unknown;
  const toolExecutionEnd = fake.handlers.get("tool_execution_end")?.[0] as (event: { toolName: string; isError?: boolean; args?: Record<string, unknown> }, ctx: unknown) => void;
  const ctx = {
    cwd: tempDir("pi-chalin-package-metadata-"),
    hasUI: false,
    model: undefined,
    modelRegistry: { getAvailable: () => [] },
  };
  await beforeAgentStart({
    type: "before_agent_start",
    prompt: "Create a new TypeScript CLI package with package.json, src/cli.ts, README usage, and tests.",
    systemPrompt: "base",
    systemPromptOptions: {},
  }, ctx);

  toolExecutionEnd({
    toolName: "write",
    isError: false,
    args: {
      path: "package.json",
      content: JSON.stringify({ name: "demo-cli", bin: { demo: "src/cli.ts" }, scripts: { test: "bun test" } }, null, 2),
    },
  }, ctx);
  toolExecutionEnd({ toolName: "write", isError: false, args: { path: "src/cli.ts", content: "export function main() { return 1; }\n" } }, ctx);
  toolExecutionEnd({ toolName: "write", isError: false, args: { path: "test/cli.test.ts", content: "import { test, expect } from 'bun:test';\ntest('main', () => expect(1).toBe(1));\n" } }, ctx);
  toolExecutionEnd({ toolName: "bash", isError: false, args: { command: "bun test" } }, ctx);

  const packageNudges = fake.messages.filter((item) => (item.message as { customType?: string }).customType === "pi-chalin-direct-package-metadata-nudge");
  assert.equal(packageNudges.length, 1);
  assert.match((packageNudges[0]?.message as { content?: string }).content ?? "", /package metadata looks incomplete/i);
  assert.match((packageNudges[0]?.message as { content?: string }).content ?? "", /module format and delivered bin\/main\/exports agree/i);
  assert.equal(fake.messages.filter((item) => (item.message as { customType?: string }).customType === "pi-chalin-direct-completion-nudge").length, 0);
  const metadataGuardContext = await contextHandler({ type: "context", messages: [] }, ctx) as { messages?: Array<{ customType?: string; content?: string }> };
  assert.equal(metadataGuardContext.messages?.at(-1)?.customType, "pi-chalin-direct-critical-guard");
  assert.match(metadataGuardContext.messages?.at(-1)?.content ?? "", /final answer is invalid/i);
  assert.match(metadataGuardContext.messages?.at(-1)?.content ?? "", /package metadata/i);
  assert.match(metadataGuardContext.messages?.at(-1)?.content ?? "", /next assistant action must be a tool call/i);

  toolExecutionEnd({
    toolName: "write",
    isError: false,
    args: {
      path: "package.json",
      content: JSON.stringify({ name: "demo-cli", type: "module", bin: { demo: "src/cli.ts" }, scripts: { test: "bun test" } }, null, 2),
    },
  }, ctx);
  toolExecutionEnd({ toolName: "bash", isError: false, args: { command: "bun test" } }, ctx);
  assert.equal(fake.messages.filter((item) => (item.message as { customType?: string }).customType === "pi-chalin-direct-completion-nudge").length, 1);
  assert.equal(await contextHandler({ type: "context", messages: [] }, ctx), undefined);
});

test("direct scaffold mutations outside the current workspace get a hard-stop guard", async () => {
  const fake = createFakePi();
  registerPiChalin(fake.api as never);
  const beforeAgentStart = fake.handlers.get("before_agent_start")?.[0] as (event: unknown, ctx: unknown) => Promise<unknown>;
  const contextHandler = fake.handlers.get("context")?.[0] as (event: { type: "context"; messages: unknown[] }, ctx: unknown) => unknown;
  const toolExecutionEnd = fake.handlers.get("tool_execution_end")?.[0] as (event: { toolName: string; isError?: boolean; args?: Record<string, unknown> }, ctx: unknown) => void;
  const ctx = {
    cwd: tempDir("pi-chalin-workspace-boundary-"),
    hasUI: false,
    model: undefined,
    modelRegistry: { getAvailable: () => [] },
  };
  const outsideRoot = `${ctx.cwd}-outside`;

  await beforeAgentStart({
    type: "before_agent_start",
    prompt: "Create a new TypeScript CLI package with package.json, src/cli.ts, README usage, and tests.",
    systemPrompt: "base",
    systemPromptOptions: {},
  }, ctx);

  toolExecutionEnd({
    toolName: "write",
    isError: false,
    args: { path: `${outsideRoot}/package.json`, content: JSON.stringify({ name: "demo-cli", type: "module", scripts: { test: "bun test" } }) },
  }, ctx);
  const boundaryNudge = fake.messages.find((item) => (item.message as { customType?: string }).customType === "pi-chalin-direct-workspace-boundary-nudge");
  assert.match((boundaryNudge?.message as { content?: string }).content ?? "", /escaped the current workspace root/i);
  assert.match((boundaryNudge?.message as { content?: string }).content ?? "", /relative paths/i);

  toolExecutionEnd({ toolName: "bash", isError: false, args: { command: `cd ${outsideRoot} && bun test` } }, ctx);
  assert.equal(fake.messages.filter((item) => (item.message as { customType?: string }).customType === "pi-chalin-direct-completion-nudge").length, 0);
  const guardContext = await contextHandler({ type: "context", messages: [] }, ctx) as { messages?: Array<{ customType?: string; content?: string }> };
  assert.equal(guardContext.messages?.at(-1)?.customType, "pi-chalin-direct-critical-guard");
  assert.match(guardContext.messages?.at(-1)?.content ?? "", /outside the current workspace root/i);
  assert.match(guardContext.messages?.at(-1)?.content ?? "", /recreate or move the required artifacts under the current workspace root/i);

  toolExecutionEnd({ toolName: "write", isError: false, args: { path: "package.json", content: JSON.stringify({ name: "demo-cli", type: "module", scripts: { test: "bun test" } }) } }, ctx);
  toolExecutionEnd({ toolName: "write", isError: false, args: { path: "src/cli.ts", content: "export function main() { return 1; }\n" } }, ctx);
  toolExecutionEnd({ toolName: "write", isError: false, args: { path: "test/cli.test.ts", content: "import { test, expect } from 'bun:test';\ntest('main', () => expect(1).toBe(1));\n" } }, ctx);
  toolExecutionEnd({ toolName: "bash", isError: false, args: { command: "bun test" } }, ctx);
  assert.equal(fake.messages.filter((item) => (item.message as { customType?: string }).customType === "pi-chalin-direct-completion-nudge").length, 1);
  assert.equal(await contextHandler({ type: "context", messages: [] }, ctx), undefined);
});

test("test-only direct work uses generic evidence-based verify and completion nudges", async () => {
  const fake = createFakePi();
  registerPiChalin(fake.api as never);
  const beforeAgentStart = fake.handlers.get("before_agent_start")?.[0] as (event: unknown, ctx: unknown) => Promise<unknown>;
  const toolExecutionEnd = fake.handlers.get("tool_execution_end")?.[0] as (event: { toolName: string; isError?: boolean; args?: Record<string, unknown> }, ctx: unknown) => void;
  const ctx = {
    cwd: tempDir("pi-chalin-test-only-"),
    hasUI: false,
    model: undefined,
    modelRegistry: { getAvailable: () => [] },
  };

  await beforeAgentStart({
    type: "before_agent_start",
    prompt: "Añade un test unitario que cubra división por cero en src/math.ts.",
    systemPrompt: "base",
    systemPromptOptions: {},
  }, ctx);

  toolExecutionEnd({ toolName: "read", isError: false, args: { path: "src/math.ts" } }, ctx);
  toolExecutionEnd({ toolName: "read", isError: false, args: { path: "test/math.test.ts" } }, ctx);
  toolExecutionEnd({ toolName: "edit", isError: false, args: { path: "test/math.test.ts" } }, ctx);

  const progress = fake.messages.find((item) => (item.message as { customType?: string }).customType === "pi-chalin-direct-progress-nudge");
  const progressContent = (progress?.message as { content?: string }).content ?? "";
  assert.match(progressContent, /Files changed/i);
  assert.match(progressContent, /run one focused verification/i);
  assert.match(progressContent, /read changed files only for concrete missing evidence/i);

  toolExecutionEnd({ toolName: "bash", isError: false, args: { command: "bun test test/math.test.ts" } }, ctx);

  const completion = fake.messages.find((item) => (item.message as { customType?: string }).customType === "pi-chalin-direct-completion-nudge");
  const completionContent = (completion?.message as { content?: string }).content ?? "";
  assert.match(completionContent, /You changed files and ran `bun test test\/math\.test\.ts`/i);
  assert.match(completionContent, /Final should be concise but complete/i);
  assert.match(completionContent, /requested behavior\/constraints/i);
});

test("direct bounded code tasks nudge away from pre-mutation verification loops", async () => {
  const fake = createFakePi();
  registerPiChalin(fake.api as never);
  const beforeAgentStart = fake.handlers.get("before_agent_start")?.[0] as (event: unknown, ctx: unknown) => Promise<unknown>;
  const toolExecutionEnd = fake.handlers.get("tool_execution_end")?.[0] as (event: { toolName: string; isError?: boolean; args?: Record<string, unknown> }, ctx: unknown) => void;
  const ctx = {
    cwd: tempDir("pi-chalin-pre-mutation-verify-"),
    hasUI: false,
    model: undefined,
    modelRegistry: { getAvailable: () => [] },
  };

  await beforeAgentStart({ type: "before_agent_start", prompt: "Implementa sortTasks en src/sortTasks.ts y tests con bun test", systemPrompt: "base", systemPromptOptions: {} }, ctx);
  toolExecutionEnd({ toolName: "read", isError: false, args: { path: "src/sortTasks.ts" } }, ctx);
  toolExecutionEnd({ toolName: "bash", isError: false, args: { command: "bun test" } }, ctx);
  toolExecutionEnd({ toolName: "bash", isError: false, args: { command: "bun test test/sortTasks.test.ts" } }, ctx);

  const nudges = fake.messages.filter((item) => (item.message as { customType?: string }).customType === "pi-chalin-direct-pre-mutation-verification-nudge");
  assert.equal(nudges.length, 1);
  assert.match((nudges[0]?.message as { content?: string }).content ?? "", /ran verification before any edit/i);
  assert.match((nudges[0]?.message as { content?: string }).content ?? "", /Do not run another pre-edit test command/i);

  await beforeAgentStart({ type: "before_agent_start", prompt: "Implementa TTL cache en cache/cache.go con reloj inyectable, expiracion lazy y tests go test.", systemPrompt: "base", systemPromptOptions: {} }, ctx);
  toolExecutionEnd({ toolName: "read", isError: false, args: { path: "cache/cache.go" } }, ctx);
  toolExecutionEnd({ toolName: "bash", isError: false, args: { command: "go test ./..." } }, ctx);

  assert.equal(fake.messages.filter((item) => (item.message as { customType?: string }).customType === "pi-chalin-direct-pre-mutation-verification-nudge").length, 2);
});

test("direct code edits only get ready-to-verify nudge after post-edit drift", async () => {
  const fake = createFakePi();
  registerPiChalin(fake.api as never);
  const beforeAgentStart = fake.handlers.get("before_agent_start")?.[0] as (event: unknown, ctx: unknown) => Promise<unknown>;
  const toolExecutionEnd = fake.handlers.get("tool_execution_end")?.[0] as (event: { toolName: string; isError?: boolean; args?: Record<string, unknown> }, ctx: unknown) => void;
  const ctx = {
    cwd: tempDir("pi-chalin-direct-ready-drift-"),
    hasUI: false,
    model: undefined,
    modelRegistry: { getAvailable: () => [] },
  };

  await beforeAgentStart({ type: "before_agent_start", prompt: "fix src/cache.ts and tests", systemPrompt: "base", systemPromptOptions: {} }, ctx);
  toolExecutionEnd({ toolName: "edit", isError: false, args: { path: "src/cache.ts" } }, ctx);
  assert.equal(fake.messages.filter((item) => (item.message as { customType?: string }).customType === "pi-chalin-direct-ready-to-verify-nudge").length, 0);

  toolExecutionEnd({ toolName: "read", isError: false, args: { path: "src/cache.ts" } }, ctx);
  const ready = fake.messages.filter((item) => (item.message as { customType?: string }).customType === "pi-chalin-direct-ready-to-verify-nudge");
  assert.equal(ready.length, 1);
  assert.match((ready[0]?.message as { content?: string }).content ?? "", /Stop broad exploration/i);
  assert.match((ready[0]?.message as { content?: string }).content ?? "", /pending-verification steer is stale/i);
});

test("direct recovery edit after failed verification avoids duplicate stale nudges", async () => {
  const fake = createFakePi();
  registerPiChalin(fake.api as never);
  const beforeAgentStart = fake.handlers.get("before_agent_start")?.[0] as (event: unknown, ctx: unknown) => Promise<unknown>;
  const toolExecutionEnd = fake.handlers.get("tool_execution_end")?.[0] as (event: { toolName: string; isError?: boolean; args?: Record<string, unknown> }, ctx: unknown) => void;
  const ctx = {
    cwd: tempDir("pi-chalin-direct-recovery-nudge-"),
    hasUI: false,
    model: undefined,
    modelRegistry: { getAvailable: () => [] },
  };

  await beforeAgentStart({ type: "before_agent_start", prompt: "fix src/tokenizer.c and tests/test_tokenizer.c, leave make test passing", systemPrompt: "base", systemPromptOptions: {} }, ctx);
  toolExecutionEnd({ toolName: "edit", isError: false, args: { path: "src/tokenizer.c" } }, ctx);
  toolExecutionEnd({ toolName: "edit", isError: false, args: { path: "tests/test_tokenizer.c" } }, ctx);
  toolExecutionEnd({ toolName: "bash", isError: true, args: { command: "make test" } }, ctx);
  toolExecutionEnd({ toolName: "edit", isError: false, args: { path: "tests/test_tokenizer.c" } }, ctx);

  assert.equal(fake.messages.filter((item) => (item.message as { customType?: string }).customType === "pi-chalin-direct-mutation-loop-nudge").length, 0, "the corrective edit after a failure is not treated as a pre-verification mutation loop");
  assert.equal(fake.messages.filter((item) => (item.message as { customType?: string }).customType === "pi-chalin-direct-ready-to-verify-nudge").length, 0, "source+test-ready steer already covers verification after the recovery edit");

  toolExecutionEnd({ toolName: "bash", isError: false, args: { command: "make test" } }, ctx);
  assert.equal(fake.messages.filter((item) => (item.message as { customType?: string }).customType === "pi-chalin-direct-completion-nudge").length, 1);
});

test("direct bash without command args does not trigger duplicate verification nudge", async () => {
  const fake = createFakePi();
  registerPiChalin(fake.api as never);
  const beforeAgentStart = fake.handlers.get("before_agent_start")?.[0] as (event: unknown, ctx: unknown) => Promise<unknown>;
  const toolExecutionEnd = fake.handlers.get("tool_execution_end")?.[0] as (event: { toolName: string; isError?: boolean; args?: Record<string, unknown> }, ctx: unknown) => void;
  const ctx = {
    cwd: tempDir("pi-chalin-direct-bash-noargs-"),
    hasUI: false,
    model: undefined,
    modelRegistry: { getAvailable: () => [] },
  };

  await beforeAgentStart({ type: "before_agent_start", prompt: "fix src/tokenizer.c and leave make test passing", systemPrompt: "base", systemPromptOptions: {} }, ctx);
  toolExecutionEnd({ toolName: "edit", isError: false, args: { path: "src/tokenizer.c" } }, ctx);
  toolExecutionEnd({ toolName: "edit", isError: false, args: { path: "tests/test_tokenizer.c" } }, ctx);
  toolExecutionEnd({ toolName: "bash", isError: false }, ctx);

  assert.equal(fake.messages.filter((item) => (item.message as { customType?: string }).customType === "pi-chalin-direct-ready-to-verify-nudge").length, 0);
  assert.equal(fake.messages.filter((item) => (item.message as { customType?: string }).customType === "pi-chalin-direct-completion-nudge").length, 0);
});

test("direct bash end reuses command captured at tool start", async () => {
  const fake = createFakePi();
  registerPiChalin(fake.api as never);
  const beforeAgentStart = fake.handlers.get("before_agent_start")?.[0] as (event: unknown, ctx: unknown) => Promise<unknown>;
  const toolExecutionStart = fake.handlers.get("tool_execution_start")?.[0] as (event: { toolName: string; args?: Record<string, unknown> }, ctx: unknown) => void;
  const toolExecutionEnd = fake.handlers.get("tool_execution_end")?.[0] as (event: { toolName: string; isError?: boolean; args?: Record<string, unknown> }, ctx: unknown) => void;
  const ctx = {
    cwd: tempDir("pi-chalin-direct-bash-start-args-"),
    hasUI: false,
    model: undefined,
    modelRegistry: { getAvailable: () => [] },
  };

  await beforeAgentStart({ type: "before_agent_start", prompt: "fix src/tokenizer.c and leave make test passing", systemPrompt: "base", systemPromptOptions: {} }, ctx);
  toolExecutionEnd({ toolName: "edit", isError: false, args: { path: "src/tokenizer.c" } }, ctx);
  toolExecutionEnd({ toolName: "edit", isError: false, args: { path: "tests/test_tokenizer.c" } }, ctx);
  toolExecutionStart({ toolName: "bash", args: { command: "make test" } }, ctx);
  toolExecutionEnd({ toolName: "bash", isError: false }, ctx);

  assert.deepEqual(getDirectToolEventsForTests().map((event) => ({
    phase: event.phase,
    toolName: event.toolName,
    command: event.command,
    isError: event.isError,
  })).slice(-2), [
    { phase: "start", toolName: "bash", command: "make test", isError: undefined },
    { phase: "completed", toolName: "bash", command: "make test", isError: false },
  ]);

  const nudges = fake.messages.filter((item) => (item.message as { customType?: string }).customType === "pi-chalin-direct-completion-nudge");
  assert.equal(nudges.length, 1);
  assert.match((nudges[0]?.message as { content?: string }).content ?? "", /make test/);
  assert.equal(fake.messages.filter((item) => (item.message as { customType?: string }).customType === "pi-chalin-direct-ready-to-verify-nudge").length, 0);
});

test("direct failed bash without command args triggers contract failure nudge", async () => {
  const fake = createFakePi();
  registerPiChalin(fake.api as never);
  const beforeAgentStart = fake.handlers.get("before_agent_start")?.[0] as (event: unknown, ctx: unknown) => Promise<unknown>;
  const toolExecutionEnd = fake.handlers.get("tool_execution_end")?.[0] as (event: { toolName: string; isError?: boolean; args?: Record<string, unknown> }, ctx: unknown) => void;
  const ctx = {
    cwd: tempDir("pi-chalin-direct-bash-noargs-fail-"),
    hasUI: false,
    model: undefined,
    modelRegistry: { getAvailable: () => [] },
  };

  await beforeAgentStart({ type: "before_agent_start", prompt: "fix src/tokenizer.c and leave make test passing", systemPrompt: "base", systemPromptOptions: {} }, ctx);
  toolExecutionEnd({ toolName: "edit", isError: false, args: { path: "src/tokenizer.c" } }, ctx);
  toolExecutionEnd({ toolName: "edit", isError: false, args: { path: "tests/test_tokenizer.c" } }, ctx);
  toolExecutionEnd({ toolName: "bash", isError: true }, ctx);

  const nudges = fake.messages.filter((item) => (item.message as { customType?: string }).customType === "pi-chalin-direct-verification-failed-nudge");
  assert.equal(nudges.length, 1);
  assert.match((nudges[0]?.message as { content?: string }).content ?? "", /Use the latest failure as evidence/i);
  assert.match((nudges[0]?.message as { content?: string }).content ?? "", /Do not grep\/find\/read broad surfaces/i);
  assert.equal(fake.messages.filter((item) => (item.message as { customType?: string }).customType === "pi-chalin-direct-ready-to-verify-nudge").length, 0);
});



test("direct bounded edits recognize Python unittest verification and rerun after failed checks", async () => {
  const fake = createFakePi();
  registerPiChalin(fake.api as never);
  const beforeAgentStart = fake.handlers.get("before_agent_start")?.[0] as (event: unknown, ctx: unknown) => Promise<unknown>;
  const toolExecutionEnd = fake.handlers.get("tool_execution_end")?.[0] as (event: { toolName: string; isError?: boolean; args?: Record<string, unknown> }, ctx: unknown) => void;
  const ctx = {
    cwd: tempDir("pi-chalin-direct-python-nudge-"),
    hasUI: false,
    model: undefined,
    modelRegistry: { getAvailable: () => [] },
  };

  await beforeAgentStart({ type: "before_agent_start", prompt: "implementa slugify.py y tests con unittest", systemPrompt: "base", systemPromptOptions: {} }, ctx);
  toolExecutionEnd({ toolName: "edit", isError: false, args: { path: "slugify.py" } }, ctx);
  toolExecutionEnd({ toolName: "edit", isError: false, args: { path: "tests/test_slugify.py" } }, ctx);
  toolExecutionEnd({ toolName: "bash", isError: true, args: { command: "python -m unittest" } }, ctx);
  assert.equal(fake.messages.filter((item) => (item.message as { customType?: string }).customType === "pi-chalin-direct-verification-failed-nudge").length, 1);

  toolExecutionEnd({ toolName: "edit", isError: false, args: { path: "tests/test_slugify.py" } }, ctx);
  assert.equal(fake.messages.filter((item) => (item.message as { customType?: string }).customType === "pi-chalin-direct-ready-to-verify-nudge").length, 0);
  assert.equal(fake.messages.filter((item) => (item.message as { customType?: string }).customType === "pi-chalin-direct-source-test-ready-nudge").length, 2);
  const sourceReady = fake.messages.find((item) => (item.message as { customType?: string }).customType === "pi-chalin-direct-source-test-ready-nudge");
  assert.match((sourceReady?.message as { content?: string }).content ?? "", /string\/slug categories once/i);
  assert.match((sourceReady?.message as { content?: string }).content ?? "", /API payload missing\/null\/array\/type\/blank\/format branches/i);
  assert.match((sourceReady?.message as { content?: string }).content ?? "", /numeric below\/inside\/above/i);
  assert.match((sourceReady?.message as { content?: string }).content ?? "", /parser\/delimiter adjacency\/protected\/escaping\/EOF including SQL doubled-quote strings/i);
  assert.match((sourceReady?.message as { content?: string }).content ?? "", /Python unittest discoverable `tests\/` path/i);
  assert.match((sourceReady?.message as { content?: string }).content ?? "", /time\/rate fake time with no sleeps/i);
  assert.match((sourceReady?.message as { content?: string }).content ?? "", /sort primary\/secondary\/tie\/no mutation/i);
  assert.match((sourceReady?.message as { content?: string }).content ?? "", /one preservation\/no-op path/i);

  toolExecutionEnd({ toolName: "bash", isError: false, args: { command: "python -m unittest discover -s tests" } }, ctx);
  const nudges = fake.messages.filter((item) => (item.message as { customType?: string }).customType === "pi-chalin-direct-completion-nudge");
  assert.equal(nudges.length, 1);
  assert.match((nudges[0]?.message as { content?: string }).content ?? "", /python -m unittest discover -s tests/);
  assert.match((nudges[0]?.message as { content?: string }).content ?? "", /boundary\/preservation evidence/);
  assert.match((nudges[0]?.message as { content?: string }).content ?? "", /test counts and paths must match the actual verification output/);
});

test("direct bounded edits recognize Make verification without asking for a duplicate run", async () => {
  const fake = createFakePi();
  registerPiChalin(fake.api as never);
  const beforeAgentStart = fake.handlers.get("before_agent_start")?.[0] as (event: unknown, ctx: unknown) => Promise<unknown>;
  const toolExecutionEnd = fake.handlers.get("tool_execution_end")?.[0] as (event: { toolName: string; isError?: boolean; args?: { command?: string; path?: string } }, ctx: unknown) => void;
  const ctx = {
    cwd: tempDir("pi-chalin-make-verification-"),
    hasUI: false,
    model: undefined,
    modelRegistry: { getAvailable: () => [] },
  };

  await beforeAgentStart({ type: "before_agent_start", prompt: "implementa src/expire_table.c y deja make test pasando", systemPrompt: "base", systemPromptOptions: {} }, ctx);
  toolExecutionEnd({ toolName: "write", isError: false, args: { path: "src/expire_table.c" } }, ctx);
  toolExecutionEnd({ toolName: "bash", isError: false, args: { command: "make test" } }, ctx);

  assert.equal(fake.messages.filter((item) => (item.message as { customType?: string }).customType === "pi-chalin-direct-ready-to-verify-nudge").length, 0);
  const coverage = fake.messages.find((item) => (item.message as { customType?: string }).customType === "pi-chalin-direct-test-coverage-nudge");
  assert.match((coverage?.message as { content?: string }).content ?? "", /no separate test-path edit was observed/i);
  assert.match((coverage?.message as { content?: string }).content ?? "", /Do NOT final with command-only evidence/i);
  assert.match((coverage?.message as { content?: string }).content ?? "", /exact test\/evidence path/i);
  assert.match((coverage?.message as { content?: string }).content ?? "", /missing focused test/i);

  toolExecutionEnd({ toolName: "read", isError: false, args: { path: "tests/test_expire_table.c" } }, ctx);
  assert.equal(fake.messages.filter((item) => (item.message as { customType?: string }).customType === "pi-chalin-direct-completion-nudge").length, 0, "reading tests alone does not complete source behavior changes");

  toolExecutionEnd({ toolName: "edit", isError: false, args: { path: "tests/test_expire_table.c" } }, ctx);
  toolExecutionEnd({ toolName: "bash", isError: false, args: { command: "make test" } }, ctx);
  const completion = fake.messages.find((item) => (item.message as { customType?: string }).customType === "pi-chalin-direct-completion-nudge");
  assert.match((completion?.message as { content?: string }).content ?? "", /Verification: `make test` passed/i);
});

test("broken-test triage treats an existing read test as coverage evidence", async () => {
  const fake = createFakePi();
  registerPiChalin(fake.api as never);
  const beforeAgentStart = fake.handlers.get("before_agent_start")?.[0] as (event: unknown, ctx: unknown) => Promise<unknown>;
  const toolExecutionEnd = fake.handlers.get("tool_execution_end")?.[0] as (event: { toolName: string; isError?: boolean; args?: Record<string, unknown> }, ctx: unknown) => void;
  const ctx = {
    cwd: tempDir("pi-chalin-broken-test-existing-coverage-"),
    hasUI: false,
    model: undefined,
    modelRegistry: { getAvailable: () => [] },
  };

  await beforeAgentStart({ type: "before_agent_start", prompt: "El test está fallando. Encuentra la causa raíz en src/normalizeEmail.ts, corrígela y deja bun test pasando. No cambies el test para ocultar el bug.", systemPrompt: "base", systemPromptOptions: {} }, ctx);
  toolExecutionEnd({ toolName: "read", isError: false, args: { path: "src/normalizeEmail.ts" } }, ctx);
  toolExecutionEnd({ toolName: "read", isError: false, args: { path: "test/normalizeEmail.test.ts" } }, ctx);
  toolExecutionEnd({ toolName: "edit", isError: false, args: { path: "src/normalizeEmail.ts" } }, ctx);
  toolExecutionEnd({ toolName: "bash", isError: false, args: { command: "bun test test/normalizeEmail.test.ts" } }, ctx);

  assert.equal(fake.messages.filter((item) => (item.message as { customType?: string }).customType === "pi-chalin-direct-test-coverage-nudge").length, 0);
  const completion = fake.messages.find((item) => (item.message as { customType?: string }).customType === "pi-chalin-direct-completion-nudge");
  assert.match((completion?.message as { content?: string }).content ?? "", /bun test test\/normalizeEmail\.test\.ts/i);
});

test("direct completion nudges avoid prompt-regex test classification", async () => {
  const fake = createFakePi();
  registerPiChalin(fake.api as never);
  const beforeAgentStart = fake.handlers.get("before_agent_start")?.[0] as (event: unknown, ctx: unknown) => Promise<unknown>;
  const toolExecutionEnd = fake.handlers.get("tool_execution_end")?.[0] as (event: { toolName: string; isError?: boolean; args?: Record<string, unknown> }, ctx: unknown) => void;
  const ctx = {
    cwd: tempDir("pi-chalin-direct-tests-nudge-"),
    hasUI: false,
    model: undefined,
    modelRegistry: { getAvailable: () => [] },
  };

  await beforeAgentStart({ type: "before_agent_start", prompt: "implementa src/rateLimit.ts y añade tests", systemPrompt: "base", systemPromptOptions: {} }, ctx);
  toolExecutionEnd({ toolName: "edit", isError: false, args: { path: "src/rateLimit.ts" } }, ctx);
  toolExecutionEnd({ toolName: "bash", isError: false, args: { command: "bun test" } }, ctx);

  assert.equal(fake.messages.filter((item) => (item.message as { customType?: string }).customType === "pi-chalin-direct-tests-missing-nudge").length, 0);
  assert.equal(fake.messages.filter((item) => (item.message as { customType?: string }).customType === "pi-chalin-direct-test-coverage-nudge").length, 1);
  assert.equal(fake.messages.filter((item) => (item.message as { customType?: string }).customType === "pi-chalin-direct-completion-nudge").length, 0);

  toolExecutionEnd({ toolName: "read", isError: false, args: { path: "tests/rateLimit.test.ts" } }, ctx);
  assert.equal(fake.messages.filter((item) => (item.message as { customType?: string }).customType === "pi-chalin-direct-completion-nudge").length, 0, "reading old tests is not a completion signal");

  toolExecutionEnd({ toolName: "edit", isError: false, args: { path: "tests/rateLimit.test.ts" } }, ctx);
  toolExecutionEnd({ toolName: "bash", isError: false, args: { command: "bun test" } }, ctx);
  assert.equal(fake.messages.filter((item) => (item.message as { customType?: string }).customType === "pi-chalin-direct-completion-nudge").length, 1);
  const completion = fake.messages.find((item) => (item.message as { customType?: string }).customType === "pi-chalin-direct-completion-nudge");
  assert.match((completion?.message as { content?: string }).content ?? "", /concise but complete/i);
  assert.match((completion?.message as { content?: string }).content ?? "", /requested behavior\/constraints/i);
});

test("direct inline-test review can satisfy coverage nudge without looping", async () => {
  const fake = createFakePi();
  registerPiChalin(fake.api as never);
  const beforeAgentStart = fake.handlers.get("before_agent_start")?.[0] as (event: unknown, ctx: unknown) => Promise<unknown>;
  const toolExecutionEnd = fake.handlers.get("tool_execution_end")?.[0] as (event: { toolName: string; isError?: boolean; args?: Record<string, unknown> }, ctx: unknown) => void;
  const ctx = {
    cwd: tempDir("pi-chalin-inline-test-review-"),
    hasUI: false,
    model: undefined,
    modelRegistry: { getAvailable: () => [] },
  };

  await beforeAgentStart({ type: "before_agent_start", prompt: "implement build_cache_key in crates/cache-key/src/lib.rs and cover it with tests", systemPrompt: "base", systemPromptOptions: {} }, ctx);
  toolExecutionEnd({ toolName: "edit", isError: false, args: { path: "crates/cache-key/src/lib.rs" } }, ctx);
  toolExecutionEnd({ toolName: "bash", isError: false, args: { command: "cargo test -p cache-key" } }, ctx);
  assert.equal(fake.messages.filter((item) => (item.message as { customType?: string }).customType === "pi-chalin-direct-test-coverage-nudge").length, 1);
  assert.equal(fake.messages.filter((item) => (item.message as { customType?: string }).customType === "pi-chalin-direct-completion-nudge").length, 0);

  toolExecutionEnd({ toolName: "read", isError: false, args: { path: "./crates/cache-key/src/lib.rs" } }, ctx);
  const completion = fake.messages.filter((item) => (item.message as { customType?: string }).customType === "pi-chalin-direct-completion-nudge");
  assert.equal(completion.length, 1);
  assert.match((completion[0]?.message as { content?: string }).content ?? "", /cargo test -p cache-key/);

  toolExecutionEnd({ toolName: "bash", isError: false, args: { command: "cargo test -p cache-key" } }, ctx);
  assert.equal(fake.messages.filter((item) => (item.message as { customType?: string }).customType === "pi-chalin-direct-test-coverage-nudge").length, 1, "coverage review nudge is not repeated after inline-test readback");
});


test("direct docs-only evidence loop nudges artifact write and readback", async () => {
  const fake = createFakePi();
  registerPiChalin(fake.api as never);
  const beforeAgentStart = fake.handlers.get("before_agent_start")?.[0] as (event: unknown, ctx: unknown) => Promise<unknown>;
  const toolExecutionEnd = fake.handlers.get("tool_execution_end")?.[0] as (event: { toolName: string; isError?: boolean; args?: Record<string, unknown> }, ctx: unknown) => void;
  const ctx = {
    cwd: tempDir("pi-chalin-docs-evidence-loop-"),
    hasUI: false,
    model: undefined,
    modelRegistry: { getAvailable: () => [] },
  };

  await beforeAgentStart({ type: "before_agent_start", prompt: "actualiza docs/plan.md sin tocar codigo", systemPrompt: "base", systemPromptOptions: {} }, ctx);
  toolExecutionEnd({ toolName: "chalin_project_discovery", isError: false, args: {} }, ctx);
  toolExecutionEnd({ toolName: "read", isError: false, args: { path: "src/a.ts" } }, ctx);
  toolExecutionEnd({ toolName: "grep", isError: false, args: { path: "src", pattern: "runtime boundary" } }, ctx);
  toolExecutionEnd({ toolName: "read", isError: false, args: { path: "src/b.ts" } }, ctx);
  toolExecutionEnd({ toolName: "ls", isError: false, args: { path: "docs" } }, ctx);
  toolExecutionEnd({ toolName: "find", isError: false, args: { path: ".", pattern: "plan.md" } }, ctx);

  const nudges = fake.messages.filter((item) => (item.message as { customType?: string }).customType === "pi-chalin-docs-evidence-loop-nudge");
  assert.equal(nudges.length, 1);
  assert.match((nudges[0]?.message as { content?: string }).content ?? "", /Stop ls\/find\/grep\/bash now/i);
  assert.match((nudges[0]?.message as { content?: string }).content ?? "", /write or edit the requested docs artifact/i);
  assert.match((nudges[0]?.message as { content?: string }).content ?? "", /read back the artifact/i);

  toolExecutionEnd({ toolName: "grep", isError: false, args: { path: "src", pattern: "another pass" } }, ctx);
  assert.equal(fake.messages.filter((item) => (item.message as { customType?: string }).customType === "pi-chalin-docs-evidence-loop-nudge").length, 1, "loop nudge is sent once");
});

test("direct locator loops nudge reading candidates before more searches", async () => {
  const fake = createFakePi();
  registerPiChalin(fake.api as never);
  const beforeAgentStart = fake.handlers.get("before_agent_start")?.[0] as (event: unknown, ctx: unknown) => Promise<unknown>;
  const toolExecutionEnd = fake.handlers.get("tool_execution_end")?.[0] as (event: { toolName: string; isError?: boolean; args?: Record<string, unknown> }, ctx: unknown) => void;
  const ctx = {
    cwd: tempDir("pi-chalin-locator-loop-"),
    hasUI: false,
    model: undefined,
    modelRegistry: { getAvailable: () => [] },
  };

  await beforeAgentStart({ type: "before_agent_start", prompt: "corrige ascii_trim y deja make test pasando", systemPrompt: "base", systemPromptOptions: {} }, ctx);
  toolExecutionEnd({ toolName: "find", isError: false, args: { path: ".", pattern: "ascii_trim*" } }, ctx);
  toolExecutionEnd({ toolName: "grep", isError: false, args: { path: ".", pattern: "ascii_trim" } }, ctx);
  toolExecutionEnd({ toolName: "find", isError: false, args: { path: ".", pattern: "*trim*" } }, ctx);

  const nudges = fake.messages.filter((item) => (item.message as { customType?: string }).customType === "pi-chalin-direct-locator-loop-nudge");
  assert.equal(nudges.length, 1);
  assert.match((nudges[0]?.message as { content?: string }).content ?? "", /target read\/search evidence/i);
  assert.match((nudges[0]?.message as { content?: string }).content ?? "", /exact path/i);
  assert.match((nudges[0]?.message as { content?: string }).content ?? "", /usually waste/i);
  assert.match((nudges[0]?.message as { content?: string }).content ?? "", /read only a missing candidate/i);
  assert.match((nudges[0]?.message as { content?: string }).content ?? "", /Run another search only if/i);
});

test("direct locator nudge stops search variants after a target read", async () => {
  const fake = createFakePi();
  registerPiChalin(fake.api as never);
  const beforeAgentStart = fake.handlers.get("before_agent_start")?.[0] as (event: unknown, ctx: unknown) => Promise<unknown>;
  const toolExecutionEnd = fake.handlers.get("tool_execution_end")?.[0] as (event: { toolName: string; isError?: boolean; args?: Record<string, unknown> }, ctx: unknown) => void;
  const ctx = {
    cwd: tempDir("pi-chalin-locator-after-read-"),
    hasUI: false,
    model: undefined,
    modelRegistry: { getAvailable: () => [] },
  };

  await beforeAgentStart({ type: "before_agent_start", prompt: "implement build_cache_key in crates/cache-key/src/lib.rs and cover it with tests", systemPrompt: "base", systemPromptOptions: {} }, ctx);
  toolExecutionEnd({ toolName: "read", isError: false, args: { path: "crates/cache-key/src/lib.rs" } }, ctx);
  toolExecutionEnd({ toolName: "grep", isError: false, args: { path: ".", pattern: "build_cache_key" } }, ctx);

  const nudges = fake.messages.filter((item) => (item.message as { customType?: string }).customType === "pi-chalin-direct-locator-loop-nudge");
  assert.equal(nudges.length, 1);
  assert.match((nudges[0]?.message as { content?: string }).content ?? "", /Stop trying locator variants/i);
});

test("direct drift nudges use evidence loops instead of prompt stateful classification", async () => {
  const fake = createFakePi();
  registerPiChalin(fake.api as never);
  const beforeAgentStart = fake.handlers.get("before_agent_start")?.[0] as (event: unknown, ctx: unknown) => Promise<unknown>;
  const toolExecutionEnd = fake.handlers.get("tool_execution_end")?.[0] as (event: { toolName: string; isError?: boolean; args?: Record<string, unknown> }, ctx: unknown) => void;
  const ctx = {
    cwd: tempDir("pi-chalin-go-ttl-drift-"),
    hasUI: false,
    model: undefined,
    modelRegistry: { getAvailable: () => [] },
  };

  await beforeAgentStart({ type: "before_agent_start", prompt: "Implementa TTL cache en cache/cache.go con reloj inyectable, expiracion lazy y tests go test.", systemPrompt: "base", systemPromptOptions: {} }, ctx);
  toolExecutionEnd({ toolName: "read", isError: false, args: { path: "cache/cache.go" } }, ctx);
  toolExecutionEnd({ toolName: "read", isError: false, args: { path: "cache/cache_test.go" } }, ctx);
  toolExecutionEnd({ toolName: "grep", isError: false, args: { path: ".", pattern: "Cache" } }, ctx);

  assert.equal(fake.messages.filter((item) => (item.message as { customType?: string }).customType === "pi-chalin-direct-stateful-time-nudge").length, 0);
  const locatorNudges = fake.messages.filter((item) => (item.message as { customType?: string }).customType === "pi-chalin-direct-locator-loop-nudge");
  assert.equal(locatorNudges.length, 1);
  assert.match((locatorNudges[0]?.message as { content?: string }).content ?? "", /target read\/search evidence/i);
  assert.match((locatorNudges[0]?.message as { content?: string }).content ?? "", /Stop trying locator variants/i);
});

test("direct docs-only edits verify with read instead of shell nudges", async () => {
  const fake = createFakePi();
  registerPiChalin(fake.api as never);
  const beforeAgentStart = fake.handlers.get("before_agent_start")?.[0] as (event: unknown, ctx: unknown) => Promise<unknown>;
  const toolExecutionEnd = fake.handlers.get("tool_execution_end")?.[0] as (event: { toolName: string; isError?: boolean; args?: Record<string, unknown> }, ctx: unknown) => void;
  const ctx = {
    cwd: tempDir("pi-chalin-docs-read-nudge-"),
    hasUI: false,
    model: undefined,
    modelRegistry: { getAvailable: () => [] },
  };

  await beforeAgentStart({ type: "before_agent_start", prompt: "actualiza docs/plan.md sin tocar codigo", systemPrompt: "base", systemPromptOptions: {} }, ctx);
  toolExecutionEnd({ toolName: "bash", isError: false, args: { command: "cargo test" } }, ctx);
  assert.equal(fake.messages.filter((item) => (item.message as { customType?: string }).customType === "pi-chalin-docs-only-shell-nudge").length, 0);
  const beforeWriteMessages = fake.messages.length;
  toolExecutionEnd({ toolName: "write", isError: false, args: { path: "docs/plan.md" } }, ctx);

  assert.deepEqual(
    directSteerTypesSince(fake, beforeWriteMessages),
    ["pi-chalin-direct-ready-to-verify-nudge"],
    "a docs-only write gets one direct steer: read back the artifact",
  );
  const ready = fake.messages.find((item) => (item.message as { customType?: string }).customType === "pi-chalin-direct-ready-to-verify-nudge");
  assert.match((ready?.message as { content?: string }).content ?? "", /Read updated docs/i);

  toolExecutionEnd({ toolName: "bash", isError: false, args: { command: "cargo test" } }, ctx);
  assert.equal(fake.messages.filter((item) => (item.message as { customType?: string }).customType === "pi-chalin-direct-completion-nudge").length, 0, "post-write shell is not valid docs-only verification");
  assert.equal(fake.messages.filter((item) => (item.message as { customType?: string }).customType === "pi-chalin-docs-only-shell-nudge").length, 1, "post-write shell gets a docs-only correction");

  toolExecutionEnd({ toolName: "read", isError: false, args: { path: "docs/plan.md" } }, ctx);
  const completion = fake.messages.find((item) => (item.message as { customType?: string }).customType === "pi-chalin-direct-completion-nudge");
  assert.match((completion?.message as { content?: string }).content ?? "", /Docs readback complete with `read docs\/plan\.md`/i);
  assert.match((completion?.message as { content?: string }).content ?? "", /Final now\. Do not call tools/i);
  assert.match((completion?.message as { content?: string }).content ?? "", /Use exactly 3 bullets/i);
  assert.doesNotMatch((completion?.message as { content?: string }).content ?? "", /Checklist: requested API\/tests\/docs\/metadata/i);
  assert.doesNotMatch((completion?.message as { content?: string }).content ?? "", /escape hatches.*warning suppression/i);
});

test("direct docs shell guard is based on post-write docs mutation evidence", async () => {
  const fake = createFakePi();
  registerPiChalin(fake.api as never);
  const beforeAgentStart = fake.handlers.get("before_agent_start")?.[0] as (event: unknown, ctx: unknown) => Promise<unknown>;
  const toolExecutionEnd = fake.handlers.get("tool_execution_end")?.[0] as (event: { toolName: string; isError?: boolean; args?: Record<string, unknown> }, ctx: unknown) => void;
  const ctx = {
    cwd: tempDir("pi-chalin-docs-prewrite-shell-"),
    hasUI: false,
    model: undefined,
    modelRegistry: { getAvailable: () => [] },
  };

  await beforeAgentStart({ type: "before_agent_start", prompt: "Actualiza docs/runbook.md explicando cómo ejecutar tests, diagnosticar fallo de sync y rollback seguro usando evidencia del repo. No cambies código.", systemPrompt: "base", systemPromptOptions: {} }, ctx);
  toolExecutionEnd({ toolName: "bash", isError: false, args: { command: "bun test" } }, ctx);
  assert.equal(fake.messages.filter((item) => (item.message as { customType?: string }).customType === "pi-chalin-docs-only-shell-nudge").length, 0);
  toolExecutionEnd({ toolName: "bash", isError: false, args: { command: "bun -e \"import './src/sync.ts'; console.log('ok')\"" } }, ctx);
  assert.equal(fake.messages.filter((item) => (item.message as { customType?: string }).customType === "pi-chalin-docs-only-shell-nudge").length, 0);

  toolExecutionEnd({ toolName: "bash", isError: false, args: { command: "bun test" } }, ctx);
  assert.equal(fake.messages.filter((item) => (item.message as { customType?: string }).customType === "pi-chalin-docs-only-shell-nudge").length, 0);

  toolExecutionEnd({ toolName: "write", isError: false, args: { path: "docs/runbook.md" } }, ctx);
  toolExecutionEnd({ toolName: "bash", isError: false, args: { command: "bun test" } }, ctx);
  assert.equal(fake.messages.filter((item) => (item.message as { customType?: string }).customType === "pi-chalin-docs-only-shell-nudge").length, 1);
});


test("direct README docs-only prompts use readback verification", async () => {
  const fake = createFakePi();
  registerPiChalin(fake.api as never);
  const beforeAgentStart = fake.handlers.get("before_agent_start")?.[0] as (event: unknown, ctx: unknown) => Promise<unknown>;
  const toolExecutionEnd = fake.handlers.get("tool_execution_end")?.[0] as (event: { toolName: string; isError?: boolean; args?: Record<string, unknown> }, ctx: unknown) => void;
  const ctx = {
    cwd: tempDir("pi-chalin-readme-docs-nudge-"),
    hasUI: false,
    model: undefined,
    modelRegistry: { getAvailable: () => [] },
  };

  await beforeAgentStart({ type: "before_agent_start", prompt: "Actualiza README.md con uso real, solo docs y sin tocar codigo", systemPrompt: "base", systemPromptOptions: {} }, ctx);
  toolExecutionEnd({ toolName: "bash", isError: false, args: { command: "bun test" } }, ctx);
  assert.equal(fake.messages.filter((item) => (item.message as { customType?: string }).customType === "pi-chalin-docs-only-shell-nudge").length, 0);
  toolExecutionEnd({ toolName: "write", isError: false, args: { path: "README.md" } }, ctx);
  toolExecutionEnd({ toolName: "read", isError: false, args: { path: "README.md" } }, ctx);

  const completion = fake.messages.find((item) => (item.message as { customType?: string }).customType === "pi-chalin-direct-completion-nudge");
  assert.match((completion?.message as { content?: string }).content ?? "", /Docs readback complete with `read README\.md`/i);
  assert.match((completion?.message as { content?: string }).content ?? "", /Final now\. Do not call tools/i);
});

test("direct docs prompts with explicit shell validation are not treated as docs-only shell violations", async () => {
  const fake = createFakePi();
  registerPiChalin(fake.api as never);
  const beforeAgentStart = fake.handlers.get("before_agent_start")?.[0] as (event: unknown, ctx: unknown) => Promise<unknown>;
  const toolExecutionEnd = fake.handlers.get("tool_execution_end")?.[0] as (event: { toolName: string; isError?: boolean; args?: Record<string, unknown> }, ctx: unknown) => void;
  const ctx = {
    cwd: tempDir("pi-chalin-docs-explicit-shell-"),
    hasUI: false,
    model: undefined,
    modelRegistry: { getAvailable: () => [] },
  };

  await beforeAgentStart({ type: "before_agent_start", prompt: "Actualiza README.md y valida con bun test.", systemPrompt: "base", systemPromptOptions: {} }, ctx);
  toolExecutionEnd({ toolName: "bash", isError: false, args: { command: "bun test" } }, ctx);

  assert.equal(fake.messages.filter((item) => (item.message as { customType?: string }).customType === "pi-chalin-docs-only-shell-nudge").length, 0);
});

test("direct scaffold-like discovery uses the generic locator evidence loop", async () => {
  const fake = createFakePi();
  registerPiChalin(fake.api as never);
  const beforeAgentStart = fake.handlers.get("before_agent_start")?.[0] as (event: unknown, ctx: unknown) => Promise<unknown>;
  const toolExecutionEnd = fake.handlers.get("tool_execution_end")?.[0] as (event: { toolName: string; isError?: boolean; args?: Record<string, unknown> }, ctx: unknown) => void;
  const ctx = {
    cwd: tempDir("pi-chalin-scaffold-evidence-loop-"),
    hasUI: false,
    model: undefined,
    modelRegistry: { getAvailable: () => [] },
  };

  await beforeAgentStart({ type: "before_agent_start", prompt: "Create a new CLI package with package.json, README usage, src/cli.ts, and tests.", systemPrompt: "base", systemPromptOptions: {} }, ctx);
  toolExecutionEnd({ toolName: "ls", isError: false, args: { path: "." } }, ctx);
  toolExecutionEnd({ toolName: "read", isError: false, args: { path: "package.json" } }, ctx);
  toolExecutionEnd({ toolName: "read", isError: false, args: { path: "src/cli.ts" } }, ctx);
  toolExecutionEnd({ toolName: "find", isError: false, args: { path: ".", pattern: "*.ts" } }, ctx);

  const nudges = fake.messages.filter((item) => (item.message as { customType?: string }).customType === "pi-chalin-direct-locator-loop-nudge");
  assert.equal(nudges.length, 1);
  assert.match((nudges[0]?.message as { content?: string }).content ?? "", /target read\/search evidence/i);
  assert.match((nudges[0]?.message as { content?: string }).content ?? "", /Stop trying locator variants/i);
  assert.equal(fake.messages.filter((item) => (item.message as { customType?: string }).customType === "pi-chalin-scaffold-evidence-loop-nudge").length, 0);
});

test("direct edit and verification loops get reuse nudges without blocking tools", async () => {
  const fake = createFakePi();
  registerPiChalin(fake.api as never);
  const beforeAgentStart = fake.handlers.get("before_agent_start")?.[0] as (event: unknown, ctx: unknown) => Promise<unknown>;
  const toolExecutionEnd = fake.handlers.get("tool_execution_end")?.[0] as (event: { toolName: string; isError?: boolean; args?: Record<string, unknown> }, ctx: unknown) => void;
  const ctx = {
    cwd: tempDir("pi-chalin-direct-loop-nudge-"),
    hasUI: false,
    model: undefined,
    modelRegistry: { getAvailable: () => [] },
  };

  await beforeAgentStart({ type: "before_agent_start", prompt: "corrige src/expire_table.c y tests/test_expire_table.c y deja make test pasando", systemPrompt: "base", systemPromptOptions: {} }, ctx);
  toolExecutionEnd({ toolName: "edit", isError: false, args: { path: "src/expire_table.c" } }, ctx);
  toolExecutionEnd({ toolName: "edit", isError: false, args: { path: "tests/test_expire_table.c" } }, ctx);
  toolExecutionEnd({ toolName: "write", isError: false, args: { path: "src/expire_table.c" } }, ctx);
  toolExecutionEnd({ toolName: "edit", isError: false, args: { path: "src/expire_table.c" } }, ctx);

  const mutationNudges = fake.messages.filter((item) => (item.message as { customType?: string }).customType === "pi-chalin-direct-mutation-loop-nudge");
  assert.equal(mutationNudges.length, 1);
  assert.match((mutationNudges[0]?.message as { content?: string }).content ?? "", /Reuse the current changed files/i);
  assert.match((mutationNudges[0]?.message as { content?: string }).content ?? "", /smallest root-cause block/i);
  assert.match((mutationNudges[0]?.message as { content?: string }).content ?? "", /later passing verification/i);
  assert.match((mutationNudges[0]?.message as { content?: string }).content ?? "", /resizing or explicit error handling/i);

  toolExecutionEnd({ toolName: "bash", isError: true, args: { command: "make test" } }, ctx);
  toolExecutionEnd({ toolName: "bash", isError: true, args: { command: "make test" } }, ctx);
  const verificationNudges = fake.messages.filter((item) => (item.message as { customType?: string }).customType === "pi-chalin-direct-verification-loop-nudge");
  assert.equal(verificationNudges.length, 1);
  assert.match((verificationNudges[0]?.message as { content?: string }).content ?? "", /Do not run another check until one focused edit/i);
  assert.match((verificationNudges[0]?.message as { content?: string }).content ?? "", /latest failure/i);
});

test("direct failed verification allows only bounded diagnostic probing before edit", async () => {
  const fake = createFakePi();
  registerPiChalin(fake.api as never);
  const beforeAgentStart = fake.handlers.get("before_agent_start")?.[0] as (event: unknown, ctx: unknown) => Promise<unknown>;
  const toolExecutionEnd = fake.handlers.get("tool_execution_end")?.[0] as (event: { toolName: string; isError?: boolean; args?: Record<string, unknown> }, ctx: unknown) => void;
  const ctx = {
    cwd: tempDir("pi-chalin-post-failure-evidence-"),
    hasUI: false,
    model: undefined,
    modelRegistry: { getAvailable: () => [] },
  };

  await beforeAgentStart({ type: "before_agent_start", prompt: "corrige src/debounce.ts y test/debounce.test.ts y deja bun test pasando", systemPrompt: "base", systemPromptOptions: {} }, ctx);
  toolExecutionEnd({ toolName: "edit", isError: false, args: { path: "src/debounce.ts" } }, ctx);
  toolExecutionEnd({ toolName: "edit", isError: false, args: { path: "test/debounce.test.ts" } }, ctx);
  toolExecutionEnd({ toolName: "bash", isError: true, args: { command: "bun test test/debounce.test.ts" } }, ctx);
  toolExecutionEnd({ toolName: "bash", isError: false, args: { command: "bun -e \"console.log(Object.keys(globalThis))\"" } }, ctx);

  assert.equal(fake.messages.filter((item) => (item.message as { customType?: string }).customType === "pi-chalin-direct-post-failure-evidence-nudge").length, 0);

  toolExecutionEnd({ toolName: "grep", isError: false, args: { pattern: "useFakeTimers", path: "test" } }, ctx);

  const nudges = fake.messages.filter((item) => (item.message as { customType?: string }).customType === "pi-chalin-direct-post-failure-evidence-nudge");
  assert.equal(nudges.length, 1);
  assert.match((nudges[0]?.message as { content?: string }).content ?? "", /multiple tools investigating without editing/i);
  assert.match((nudges[0]?.message as { content?: string }).content ?? "", /Patch the smallest root cause/i);
});

test("direct write to previously read source nudges targeted patching", async () => {
  const fake = createFakePi();
  registerPiChalin(fake.api as never);
  const beforeAgentStart = fake.handlers.get("before_agent_start")?.[0] as (event: unknown, ctx: unknown) => Promise<unknown>;
  const toolExecutionEnd = fake.handlers.get("tool_execution_end")?.[0] as (event: { toolName: string; isError?: boolean; args?: Record<string, unknown> }, ctx: unknown) => void;
  const ctx = {
    cwd: tempDir("pi-chalin-existing-write-nudge-"),
    hasUI: false,
    model: undefined,
    modelRegistry: { getAvailable: () => [] },
  };

  await beforeAgentStart({ type: "before_agent_start", prompt: "implement build_cache_key in crates/cache-key/src/lib.rs and cover it with tests", systemPrompt: "base", systemPromptOptions: {} }, ctx);
  toolExecutionEnd({ toolName: "read", isError: false, args: { path: "crates/cache-key/src/lib.rs" } }, ctx);
  toolExecutionEnd({ toolName: "write", isError: false, args: { path: "./crates/cache-key/src/lib.rs" } }, ctx);

  const rewriteNudges = fake.messages.filter((item) => (item.message as { customType?: string }).customType === "pi-chalin-direct-existing-file-write-nudge");
  assert.equal(rewriteNudges.length, 1);
  assert.match((rewriteNudges[0]?.message as { content?: string }).content ?? "", /existing file already read/i);
  assert.match((rewriteNudges[0]?.message as { content?: string }).content ?? "", /keep unrelated sections byte-stable/i);
  assert.match((rewriteNudges[0]?.message as { content?: string }).content ?? "", /prefer edit/i);
});

test("direct small full-file writes to read stubs do not get rewrite nudges", async () => {
  const fake = createFakePi();
  registerPiChalin(fake.api as never);
  const beforeAgentStart = fake.handlers.get("before_agent_start")?.[0] as (event: unknown, ctx: unknown) => Promise<unknown>;
  const toolExecutionEnd = fake.handlers.get("tool_execution_end")?.[0] as (event: { toolName: string; isError?: boolean; args?: Record<string, unknown> }, ctx: unknown) => void;
  const ctx = {
    cwd: tempDir("pi-chalin-small-write-nudge-"),
    hasUI: false,
    model: undefined,
    modelRegistry: { getAvailable: () => [] },
  };

  await beforeAgentStart({ type: "before_agent_start", prompt: "Implementa lru.Cache con Get/Set y capacidad fija, evicción LRU, updates y tests. Sin dependencias.", systemPrompt: "base", systemPromptOptions: {} }, ctx);
  toolExecutionEnd({ toolName: "read", isError: false, args: { path: "lru/cache.go" } }, ctx);
  toolExecutionEnd({ toolName: "write", isError: false, args: { path: "lru/cache.go", content: "package lru\n\ntype Cache struct{}\n" } }, ctx);

  const rewriteNudges = fake.messages.filter((item) => (item.message as { customType?: string }).customType === "pi-chalin-direct-existing-file-write-nudge");
  assert.equal(rewriteNudges.length, 0);
});

test("primary memory tools search write and revise durable memories", async () => {
  const previousProvider = process.env.PI_CHALIN_MEMORY_PROVIDER;
  process.env.PI_CHALIN_MEMORY_PROVIDER = "pi-chalin";
  try {
    const fake = createFakePi();
    registerPiChalin(fake.api as never);
    const search = fake.tools.get("chalin_memory_search") as unknown as { execute: (...args: never[]) => Promise<{ content: Array<{ type: string; text: string }>; details: { results?: unknown[]; records?: MemoryRecord[]; total?: number } }> };
    const write = fake.tools.get("chalin_memory_write") as unknown as { execute: (...args: never[]) => Promise<{ content: Array<{ type: string; text: string }>; details: { record?: MemoryRecord } }> };
    const revise = fake.tools.get("chalin_memory_revise") as unknown as { execute: (...args: never[]) => Promise<{ content: Array<{ type: string; text: string }>; details: { record?: MemoryRecord } }> };
    const cwd = tempDir("pi-chalin-primary-memory-tools-");
    const ctx = { cwd, hasUI: false };

    const written = await write.execute(
      "memory-write" as never,
      {
        category: "testing",
        content: "Retry tests should use deterministic coordination instead of wall-clock sleeps when asserting concurrent behavior.",
        confidence: 0.94,
        evidence: "Primary memory tool smoke test",
      } as never,
      undefined as never,
      undefined as never,
      ctx as never,
    );
    assert.match(written.content.map((part) => part.text).join("\n"), /memory active|memory pending/);
    assert.ok(written.details.record);

    const found = await search.execute(
      "memory-search" as never,
      { query: "retry tests deterministic sleeps", tokenBudget: 120 } as never,
      undefined as never,
      undefined as never,
      ctx as never,
    );
    assert.match(found.content.map((part) => part.text).join("\n"), /Retry tests should use deterministic coordination/i);

    const revised = await revise.execute(
      "memory-revise" as never,
      {
        id: written.details.record!.id,
        content: "Retry tests should use deterministic coordination such as channel barriers or fake timers instead of wall-clock sleeps.",
        confidence: 0.98,
        evidence: "The revised wording names preferred deterministic mechanisms.",
        reason: "More specific and actionable than the prior memory.",
      } as never,
      undefined as never,
      undefined as never,
      ctx as never,
    );
    assert.match(revised.content.map((part) => part.text).join("\n"), /memory revised/);
    assert.match(revised.details.record?.content ?? "", /channel barriers or fake timers/);

    const inventoryCwd = tempDir("pi-chalin-primary-memory-inventory-");
    const inventoryStore = new MemoryStore({ cwd: inventoryCwd });
    await inventoryStore.submitCandidates([
      createMemoryCandidate({ category: "pattern", content: "Alpha telemetry pipelines prefer bounded retries before alerts because transient provider boot can delay local readiness.", sourceAgent: "scout", confidence: 0.95, scope: "project" }),
      createMemoryCandidate({ category: "tooling", content: "Bench harness adapters should keep task fixtures self contained so runner comparisons remain deterministic.", sourceAgent: "scout", confidence: 0.95, scope: "project" }),
      createMemoryCandidate({ category: "testing", content: "Regression checks should use fake timers or explicit barriers instead of wall clock sleeps in async suites.", sourceAgent: "reviewer", confidence: 0.95, scope: "project" }),
      createMemoryCandidate({ category: "workflow", content: "Long analyses should preserve compact handoffs after each phase so later resumptions avoid restarting exploration.", sourceAgent: "planner", confidence: 0.95, scope: "project" }),
    ]);

    const listed = await search.execute(
      "memory-list" as never,
      { query: "what elements you have in memory how much of thems", limit: 10 } as never,
      undefined as never,
      undefined as never,
      { cwd: inventoryCwd, hasUI: false } as never,
    );
    assert.match(listed.content.map((part) => part.text).join("\n"), /Memory inventory \(4\/4 records\)/);
    assert.equal(listed.details.total, 4);
    assert.equal(listed.details.records?.length, 4);
  } finally {
    if (previousProvider === undefined) delete process.env.PI_CHALIN_MEMORY_PROVIDER;
    else process.env.PI_CHALIN_MEMORY_PROVIDER = previousProvider;
  }
});

test("chalin_interview asks TUI questions and persists artifact answers", async () => {
  const fake = createFakePi();
  registerPiChalin(fake.api as never);
  const tool = fake.tools.get("chalin_interview") as unknown as { execute: (...args: never[]) => Promise<{ content: Array<{ type: string; text: string }>; details: { interview?: { featureId: string; answers: Array<{ answer: string; custom: boolean; recommended: boolean }> } } }> };
  const cwd = tempDir("pi-chalin-interview-");
  const titles: string[] = [];
  const optionsSeen: string[][] = [];
  const selected = ["MVP slice (RECOMMENDED)", "Custom answer…"];
  const customAnswers = ["Do not touch billing yet."];

  const result = await tool.execute(
    "tool-interview" as never,
    {
      featureId: "ambiguous-feature",
      task: "Implement the ambiguous feature.",
      reason: "Scope and exclusions are unknown.",
      questions: [
        { id: "scope", question: "What scope should pi-chalin implement first?", choices: [{ label: "MVP slice", recommended: true }, { label: "Full migration" }] },
        { id: "exclude", question: "Any area to exclude?", choices: [{ label: "No exclusions", recommended: true }, { label: "Auth only" }] },
      ],
    } as never,
    undefined as never,
    undefined as never,
    {
      cwd,
      hasUI: true,
      ui: {
        select: async (title: string, options: string[]) => {
          titles.push(title);
          optionsSeen.push(options);
          return selected.shift();
        },
        input: async () => customAnswers.shift(),
        notify: () => {},
      },
    } as never,
  );

  const text = result.content.map((part) => part.text).join("\n");
  assert.match(text, /chalin_interview answered/);
  assert.deepEqual(result.details.interview?.answers.map((answer) => answer.answer), ["MVP slice", "Do not touch billing yet."]);
  assert.equal(result.details.interview?.answers[0]?.recommended, true);
  assert.equal(result.details.interview?.answers[1]?.custom, true);

  const renderedResult = (tool as unknown as { renderResult: (...args: never[]) => { render(width: number): string[] } }).renderResult(
    result as never,
    {} as never,
    { fg: (_color: string, text: string) => text, bg: (_color: string, text: string) => text, bold: (text: string) => text } as never,
    {} as never,
  ).render(96).join("\n");
  assert.match(renderedResult, /answered · 2 answers/);
  assert.match(renderedResult, /scope: MVP slice/);
  assert.doesNotMatch(renderedResult, /reason:/);
  assert.equal(titles.length, 2);
  assert.ok(optionsSeen[0]?.includes("MVP slice (RECOMMENDED)"));
  assert.ok(optionsSeen[0]?.includes("Custom answer…"));

  const state = JSON.parse(fs.readFileSync(path.join(cwd, ".pi-chalin", "artifacts", "features", "ambiguous-feature", "state.json"), "utf-8"));
  assert.equal(state.interviewDecisions.length, 1);
  assert.match(JSON.stringify(state), /Do not touch billing yet/);
});

test("chalin_interview presents batched editable questions in a custom overlay", async () => {
  const fake = createFakePi();
  registerPiChalin(fake.api as never);
  const tool = fake.tools.get("chalin_interview") as unknown as { execute: (...args: never[]) => Promise<{ content: Array<{ type: string; text: string }>; details: { interview?: { answers: Array<{ answer: string; custom: boolean; recommended: boolean }> } } }> };
  const cwd = tempDir("pi-chalin-interview-overlay-");
  const renders: string[] = [];
  let customOptions: unknown;
  let selectCalled = false;
  let renderRequests = 0;
  const plainTheme = {
    fg: (_color: string, text: string) => text,
    bg: (_color: string, text: string) => text,
    bold: (text: string) => text,
  };

  const result = await tool.execute(
    "tool-interview" as never,
    {
      featureId: "editable-feature",
      task: "Implement the ambiguous feature.",
      reason: "Scope and exclusions are unknown.",
      questions: [
        { id: "scope", question: "What scope should pi-chalin implement first?", choices: [{ label: "MVP slice", recommended: true }, { label: "Full migration" }] },
        { id: "exclude", question: "Any area to exclude?", choices: [{ label: "No exclusions", recommended: true }, { label: "Auth only" }] },
      ],
    } as never,
    undefined as never,
    undefined as never,
    {
      cwd,
      hasUI: true,
      ui: {
        select: async () => {
          selectCalled = true;
          return undefined;
        },
        input: async () => undefined,
        notify: () => {},
        custom: async (factory: (tui: unknown, theme: unknown, keybindings: unknown, done: (result: unknown) => void) => { render(width: number): string[]; handleInput?(data: string): void }, options: unknown) => {
          customOptions = options;
          let overlayResult: unknown;
          const component = factory({ requestRender: () => { renderRequests += 1; } }, plainTheme, {}, (value) => { overlayResult = value; });
          renders.push(component.render(96).join("\n"));
          component.handleInput?.("\x1b[B");
          component.handleInput?.("\r");
          component.handleInput?.("\x1b[B");
          component.handleInput?.("\x1b[B");
          component.handleInput?.("\r");
          for (const char of "Do not touch billing yet.") component.handleInput?.(char);
          component.handleInput?.("\r");
          component.handleInput?.("\t");
          component.handleInput?.("\x1b[A");
          component.handleInput?.("\r");
          component.handleInput?.("\r");
          return overlayResult;
        },
      },
    } as never,
  );

  assert.equal(selectCalled, false);
  assert.match(JSON.stringify(customOptions), /"overlay":true/);
  assert.match(JSON.stringify(customOptions), /"anchor":"bottom-center"/);
  assert.match(JSON.stringify(customOptions), /"width":"100%"/);
  assert.match(renders[0] ?? "", /╭/);
  assert.match(renders[0] ?? "", /Interview/);
  assert.match(renders[0] ?? "", /←/);
  assert.match(renders[0] ?? "", /□ scope/);
  assert.match(renders[0] ?? "", /□ exclude/);
  assert.match(renders[0] ?? "", /✓ Submit/);
  assert.match(renders[0] ?? "", /What scope should pi-chalin implement first\?/);
  assert.doesNotMatch(renders[0] ?? "", /Any area to exclude\?/);
  assert.match(renders[0] ?? "", /❯ 1\. MVP slice/);
  assert.match(renders[0] ?? "", /recommended/);
  assert.match(renders[0] ?? "", /Tab switch/);
  assert.doesNotMatch(renders[0] ?? "", /chalin_interview/);
  for (const line of (renders[0] ?? "").split("\n")) assert.ok(visibleWidth(line) <= 96, `line exceeds overlay width: ${visibleWidth(line)} > 96`);
  assert.ok(renderRequests > 0);
  assert.deepEqual(result.details.interview?.answers.map((answer) => answer.answer), ["MVP slice", "Do not touch billing yet."]);
  assert.equal(result.details.interview?.answers[0]?.recommended, true);
  assert.equal(result.details.interview?.answers[1]?.custom, true);
});

test("chalin_route executes the workflow chosen by the primary Pi agent", async () => {
  const fake = createFakePi();
  registerPiChalin(fake.api as never);
  const tool = fake.tools.get("chalin_route") as unknown as { execute: (...args: never[]) => Promise<{ content: Array<{ type: string; text: string }>; details: unknown }> };
  assert.equal(typeof tool.execute, "function");

  const statuses: string[] = [];
  const updates: unknown[] = [];
  const widgets: unknown[][] = [];
  const result = await tool.execute(
    "tool-1" as never,
    {
      task: "review this project",
      topology: "sequential",
      steps: [
        { agent: "scout", task: "Map project structure and testing signals." },
        { agent: "reviewer", task: "Review architecture and risks using scout findings." },
      ],
      expectedEffects: ["read", "verify"],
      risk: "low",
      reason: "Broad review benefits from isolated context gathering before review.",
    } as never,
    new AbortController().signal as never,
    ((update: unknown) => updates.push(update)) as never,
    {
      cwd: tempDir("pi-chalin-tool-"),
      hasUI: true,
      ui: { setStatus: (_key: string, value: string) => statuses.push(value), notify: () => {}, setWidget: (...args: unknown[]) => widgets.push(args) },
    } as never,
  );

  const text = result.content.map((part) => part.text).join("\n");
  assert.match(text, /pi-chalin completed: scout → reviewer/);
  assert.match(text, /status: complete/);
  assert.match(text, /Final answer material:/);
  assert.doesNotMatch(text, /Supporting findings:/);
  assert.ok(statuses.some((status) => status.startsWith("chalin ")));
  assert.ok(statuses.some((status) => status.includes("review")));
  assert.ok(widgets.every((args) => args[1] === undefined), "chalin_route may clear the legacy widget but must not create a duplicate persistent widget");
});

test("chalin_route rejects public calls without expectedEffects", async () => {
  const fake = createFakePi();
  registerPiChalin(fake.api as never);
  const tool = fake.tools.get("chalin_route") as unknown as { execute: (...args: never[]) => Promise<{ content: Array<{ type: string; text: string }>; isError?: boolean }> };

  const result = await tool.execute(
    "tool-1" as never,
    {
      task: "review this project",
      topology: "sequential",
      steps: [{ agent: "reviewer", task: "Review architecture and risks." }],
      risk: "low",
    } as never,
    new AbortController().signal as never,
    (() => {}) as never,
    { cwd: tempDir("pi-chalin-tool-missing-effects-"), hasUI: false } as never,
  );

  const text = result.content.map((part) => part.text).join("\n");
  assert.equal(result.isError, true);
  assert.match(text, /requires expectedEffects/i);
});

test("chalin_route schema requires non-empty expectedEffects", () => {
  const fake = createFakePi();
  registerPiChalin(fake.api as never);
  const tool = fake.tools.get("chalin_route") as unknown as {
    parameters: { required?: string[]; properties?: Record<string, { minItems?: number }> };
  };

  assert.ok(tool.parameters.required?.includes("expectedEffects"));
  assert.equal(tool.parameters.properties?.expectedEffects?.minItems, 1);
});

test("observability lifecycle spans cover run stage review repair checkpoint interview webfetch with redacted attributes", () => {
  const startedAt = Date.now();
  const run: RunState = {
    id: "chalin-observe",
    route: {
      kind: "multi-agent-dag",
      agents: ["worker", "reviewer"],
      risk: "medium",
      ambiguity: "high",
      needsMemory: false,
      needsArtifacts: true,
      reason: "Implement with review and repair.",
      plan: {
        kind: "dag",
        stages: [
          { id: "implementation", tasks: [{ agent: "worker", task: "Implement." }] },
          { id: "review", tasks: [{ agent: "reviewer", task: "Review." }] },
        ],
      },
    },
    rootTask: "Use token sk-live-secret against https://example.com/private?api_key=abc",
    status: "paused",
    startedAt: new Date(startedAt).toISOString(),
    endedAt: new Date(startedAt + 25).toISOString(),
    logsPath: "/tmp/chalin-observe.json",
    warnings: ["checkpointed partial handoff", "review repair queued"],
    steps: [
      {
        id: "implementation:step-1",
        agent: "worker",
        task: "Implement.",
        status: "checkpointed",
        checkpoint: { kind: "budget-cap", reason: "Budget cap reached during SDK child execution.", continuation: "continue" },
        metrics: {
          durationMs: 10,
          usage: emptyTestUsage(),
          toolCalls: 2,
          toolCallsByName: { chalin_web_search: 1, chalin_artifact_write: 1 },
          budgetStopCount: 1,
          spans: [
            { id: "webfetch-1", parentId: "implementation:step-1", name: "https://example.com/private?api_key=abc", kind: "webfetch", startedAt, endedAt: startedAt + 1, attributes: { url: "https://example.com/private?api_key=abc" } },
            { id: "checkpoint-1", parentId: "implementation:step-1", name: "checkpoint", kind: "checkpoint", startedAt: startedAt + 2, endedAt: startedAt + 3 },
          ],
        },
      },
      {
        id: "review-repair-1-worker",
        agent: "worker",
        task: "Repair.",
        status: "complete",
        metrics: {
          durationMs: 7,
          usage: emptyTestUsage(),
          toolCalls: 1,
          toolCallsByName: { chalin_interview: 1 },
          spans: [
            { id: "interview-1", parentId: "review-repair-1-worker", name: "clarify token sk-live-secret", kind: "interview", startedAt: startedAt + 4, endedAt: startedAt + 5, attributes: { prompt: "token sk-live-secret" } },
          ],
        },
      },
      {
        id: "review-repair-1-reviewer",
        agent: "reviewer",
        task: "Review repair.",
        status: "complete",
        metrics: {
          durationMs: 8,
          usage: emptyTestUsage(),
          toolCalls: 0,
          toolCallsByName: {},
        },
      },
    ],
  };

  const spans = buildRunLifecycleSpans(run);
  const kinds = new Set(spans.map((span) => span.kind));
  assert.ok(kinds.has("run"));
  assert.ok(kinds.has("stage"));
  assert.ok(kinds.has("handoff"));
  assert.ok(kinds.has("review"));
  assert.ok(kinds.has("repair"));
  assert.ok(kinds.has("checkpoint"));
  assert.ok(kinds.has("interview"));
  assert.ok(kinds.has("webfetch"));
  assert.equal(redactTraceAttribute("token", "sk-live-secret"), "[REDACTED]");
  assert.doesNotMatch(JSON.stringify(spans), /sk-live-secret|api_key=abc/);
});

test("observability does not create lifecycle spans for DAG stages that never started", () => {
  const startedAt = Date.now();
  const route: RunState["route"] = {
    kind: "multi-agent-dag",
    agents: ["scout", "planner"],
    risk: "low",
    ambiguity: "low",
    needsMemory: false,
    needsArtifacts: true,
    reason: "Analyze and synthesize.",
    plan: {
      kind: "dag",
      stages: [
        { id: "evidence", tasks: [{ agent: "scout", task: "Map evidence." }] },
        { id: "synthesis", tasks: [{ agent: "planner", task: "Synthesize." }] },
      ],
    },
  };
  const run = createRunState(route, tempDir("pi-chalin-observe-pending-stage-"));
  run.status = "paused";
  run.startedAt = new Date(startedAt).toISOString();
  run.endedAt = new Date(startedAt + 120000).toISOString();
  run.steps[0]!.status = "complete";
  run.steps[0]!.startedAt = new Date(startedAt).toISOString();
  run.steps[0]!.endedAt = new Date(startedAt + 1000).toISOString();
  run.steps[0]!.output = { agent: "scout", text: "mapped", handoff: "mapped", raw: "", memoryCandidates: [], warnings: [] };
  run.steps[1]!.status = "pending";

  const stageIds = buildRunLifecycleSpans(run)
    .filter((span) => span.kind === "stage")
    .map((span) => span.attributes?.stageId);

  assert.deepEqual(stageIds, ["evidence"]);
});

test("finalAnswerMaterial preserves multi-agent analysis evidence instead of only last handoff", () => {
  const cwd = tempDir("pi-chalin-final-material-evidence-");
  const run = createRunState({
    kind: "multi-agent-dag",
    agents: ["scout", "context-builder", "reviewer"],
    risk: "low",
    ambiguity: "low",
    needsMemory: false,
    needsArtifacts: false,
    reason: "Deep project analysis with coverage matrix.",
    plan: {
      kind: "dag",
      stages: [
        { id: "discover", tasks: [{ agent: "scout", task: "Map entrypoints and tools." }] },
        { id: "fanout", tasks: [{ agent: "context-builder", task: "Analyze storage and sync." }] },
        { id: "synthesis", tasks: [{ agent: "reviewer", task: "Synthesize deep project analysis." }] },
      ],
    },
  }, tempDir("pi-chalin-final-material-"));
  run.status = "complete";
  run.steps[0]!.status = "complete";
  run.steps[0]!.output = { agent: "scout", text: "Coverage Matrix: runtime/entrypoints covered with evidence in cmd/app.ts.", handoff: "truncated scout", raw: "", memoryCandidates: [], warnings: [] };
  run.steps[1]!.status = "complete";
  run.steps[1]!.output = { agent: "context-builder", text: "Evidence Table: storage/sync claim -> src/sync.ts.", handoff: "truncated context", raw: "", memoryCandidates: [], warnings: [] };
  run.steps[2]!.status = "complete";
  run.steps[2]!.output = { agent: "reviewer", text: "Final synthesis: project purpose and risks.", handoff: "truncated reviewer", raw: "", memoryCandidates: [], warnings: [] };

  const material = finalAnswerMaterial(run);

  assert.match(material ?? "", /Coverage Matrix/);
  assert.match(material ?? "", /Evidence Table/);
  assert.match(material ?? "", /Final synthesis/);
  assert.doesNotMatch(material ?? "", /truncated reviewer/);
});

test("finalAnswerMaterial prefers final synthesis and keeps prior evidence compact", () => {
  const run = createRunState({
    kind: "multi-agent-dag",
    agents: ["scout", "researcher", "planner"],
    risk: "low",
    ambiguity: "low",
    needsMemory: false,
    needsArtifacts: false,
    reason: "Deep analysis.",
    plan: {
      kind: "dag",
      stages: [
        { id: "evidence", tasks: [{ agent: "scout", task: "Map repo." }, { agent: "researcher", task: "Check docs." }] },
        { id: "synthesis", tasks: [{ agent: "planner", task: "Synthesize." }] },
      ],
    },
  }, tempDir("pi-chalin-final-material-synthesis-"));
  run.status = "complete";
  run.steps[0]!.status = "complete";
  run.steps[0]!.output = {
    agent: "scout",
    text: `Coverage Matrix: runtime covered in src/index.ts.\n${"raw scout crawl ".repeat(500)}\nEvidence Table: src/runner.ts owns execution.`,
    handoff: "scout handoff",
    raw: "",
    memoryCandidates: [],
    warnings: [],
  };
  run.steps[1]!.status = "complete";
  run.steps[1]!.output = {
    agent: "researcher",
    text: "Effect evidence: Layer and Schedule are applicable.",
    handoff: "research handoff",
    raw: "",
    memoryCandidates: [],
    warnings: [],
  };
  run.steps[2]!.status = "complete";
  run.steps[2]!.output = {
    agent: "planner",
    text: "Final synthesis: prioritize runner and memory boundaries.",
    handoff: "planner handoff",
    raw: "",
    memoryCandidates: [],
    warnings: [],
  };

  const material = finalAnswerMaterial(run) ?? "";

  assert.ok(material.startsWith("Final synthesis"));
  assert.match(material, /Supporting evidence/);
  assert.match(material, /Coverage Matrix/);
  assert.match(material, /Effect evidence/);
  assert.doesNotMatch(material, /raw scout crawl raw scout crawl raw scout crawl raw scout crawl raw scout crawl/);
});

test("paused DAGs do not expose partial evidence as final answer material", () => {
  const route: RunState["route"] = {
    kind: "multi-agent-dag",
    agents: ["scout", "reviewer", "researcher", "planner"],
    risk: "low",
    ambiguity: "low",
    needsMemory: false,
    needsArtifacts: true,
    reason: "Deep project analysis.",
    plan: {
      kind: "dag",
      stages: [
        { id: "evidence", tasks: [{ agent: "scout", task: "Map repo." }, { agent: "reviewer", task: "Review maintainability." }, { agent: "researcher", task: "Research external context." }] },
        { id: "synthesis", tasks: [{ agent: "planner", task: "Synthesize final plan." }] },
      ],
    },
  };
  const run = createRunState(route, tempDir("pi-chalin-paused-final-material-"));
  run.status = "paused";
  run.steps[0]!.status = "complete";
  run.steps[0]!.output = { agent: "scout", text: "Scout evidence.", handoff: "Scout evidence.", raw: "", memoryCandidates: [], warnings: [] };
  run.steps[1]!.status = "complete";
  run.steps[1]!.output = { agent: "reviewer", text: "Reviewer evidence.", handoff: "Reviewer evidence.", raw: "", memoryCandidates: [], warnings: [] };
  run.steps[2]!.status = "paused";
  run.steps[2]!.pauseReason = "idle-stall";
  run.steps[2]!.error = "SDK runner idle stalled for researcher after 120000ms without activity";
  run.steps[3]!.status = "pending";

  const text = formatRoute(route, { route, approval: { action: "allow", reason: "test" }, run, memories: [], diagnostics: [] });

  assert.equal(finalAnswerMaterial(run), undefined);
  assert.match(text, /pi-chalin paused: scout → reviewer → researcher → planner/);
  assert.doesNotMatch(text, /pi-chalin completed/);
  assert.doesNotMatch(text, /Final answer material:/);
  assert.doesNotMatch(text, /Supporting findings:/);
  assert.doesNotMatch(text, /Subagent handoff:/);
  assert.match(text, /Partial subagent summary:/);
  assert.equal((text.match(/Scout evidence/g) ?? []).length, 1);
  assert.match(text, /researcher: SDK runner idle stalled/);
  assert.match(text, /planner: waiting for resume/);
  assert.ok(text.length < 1200);
});

test("finalAnswerMaterial uses structured claim evidence without heading-specific text", () => {
  const run = createRunState({
    kind: "multi-agent-dag",
    agents: ["scout", "planner"],
    risk: "low",
    ambiguity: "low",
    needsMemory: false,
    needsArtifacts: false,
    reason: "Deep analysis.",
    plan: {
      kind: "dag",
      stages: [
        { id: "evidence", tasks: [{ agent: "scout", task: "Map repo." }] },
        { id: "synthesis", tasks: [{ agent: "planner", task: "Synthesize." }] },
      ],
    },
  }, tempDir("pi-chalin-final-material-claims-"));
  run.status = "complete";
  run.steps[0]!.status = "complete";
  run.steps[0]!.output = {
    agent: "scout",
    text: "Notas compactas sin encabezados convencionales.",
    handoff: "Notas compactas sin encabezados convencionales.",
    raw: "",
    memoryCandidates: [],
    warnings: [],
    claims: [{
      kind: "negative-claim",
      subject: "browser automation capability",
      summary: "No direct browser automation entrypoint was found in the repo surface.",
      evidence: ["src/tools.ts", "src/child-tools.ts"],
      confidence: 0.72,
    }],
  } as never;
  run.steps[1]!.status = "complete";
  run.steps[1]!.output = {
    agent: "planner",
    text: "Final synthesis: keep direct capability checks in the orchestrator.",
    handoff: "Final synthesis: keep direct capability checks in the orchestrator.",
    raw: "",
    memoryCandidates: [],
    warnings: [],
  };

  const material = finalAnswerMaterial(run) ?? "";

  assert.match(material, /browser automation capability/);
  assert.match(material, /src\/tools\.ts/);
  assert.doesNotMatch(material, /Notas compactas sin encabezados convencionales/);
});

test("finalAnswerMaterial preserves single scout analysis instead of compact handoff", () => {
  const run = createRunState({
    kind: "multi-agent-sequential",
    agents: ["scout"],
    risk: "low",
    ambiguity: "low",
    needsMemory: false,
    needsArtifacts: false,
    reason: "Deep project analysis.",
    plan: { kind: "sequential", steps: [{ agent: "scout", task: "Analyze project.", budget: "deep" }] },
  }, tempDir("pi-chalin-single-final-material-"));
  run.status = "complete";
  run.steps[0]!.status = "complete";
  run.steps[0]!.output = {
    agent: "scout",
    text: "Coverage Matrix: cmd/api/main.go, internal/http/routes.go, migrations/001_init.sql, routes_test.go.",
    handoff: "compact risk-only handoff",
    raw: "",
    memoryCandidates: [],
    warnings: [],
  };

  const material = finalAnswerMaterial(run);

  assert.match(material ?? "", /Coverage Matrix/);
  assert.match(material ?? "", /cmd\/api\/main\.go/);
  assert.doesNotMatch(material ?? "", /compact risk-only handoff/);
});

test("finalAnswerMaterial appends implementation evidence omitted by final reviewer wording", () => {
  const cwd = tempDir("pi-chalin-final-material-evidence-");
  const run = createRunState({
    kind: "multi-agent-sequential",
    agents: ["scout", "worker", "reviewer"],
    risk: "medium",
    ambiguity: "low",
    needsMemory: false,
    needsArtifacts: true,
    reason: "Routed implementation.",
    plan: { kind: "sequential", steps: [{ agent: "scout", task: "Map." }, { agent: "worker", task: "Implement." }, { agent: "reviewer", task: "Review." }] },
  }, cwd);
  run.status = "complete";
  run.steps[0]!.status = "complete";
  run.steps[0]!.output = { agent: "scout", text: "mapped", handoff: "mapped", raw: "", memoryCandidates: [], warnings: [] };
  run.steps[1]!.status = "complete";
  run.steps[1]!.output = { agent: "worker", text: "Changed code and tests.", handoff: "Changed code and tests.", raw: "", memoryCandidates: [], warnings: [] };
  run.steps[1]!.metrics = {
    durationMs: 1,
    usage: emptyTestUsage(),
    toolCalls: 3,
    toolCallsByName: { edit: 2, bash: 1 },
    filesTouched: ["src/sql_tokenizer.c", "tests/test_sql_tokenizer.c"],
    shellCommands: [`cd ${cwd} && make clean && make test 2>&1`, "make clean && make test"],
  };
  run.steps[2]!.status = "complete";
  run.steps[2]!.output = {
    agent: "reviewer",
    text: "Verdict: PASS. All criteria are covered.",
    handoff: "Verdict: PASS. All criteria are covered.",
    raw: "",
    memoryCandidates: [],
    warnings: [],
  };

  const material = finalAnswerMaterial(run);

  assert.match(material ?? "", /Verdict: PASS/);
  assert.match(material ?? "", /src\/sql_tokenizer\.c/);
  assert.match(material ?? "", /tests\/test_sql_tokenizer\.c/);
  assert.match(material ?? "", /make clean && make test/);
  assert.doesNotMatch(material ?? "", /pi-chalin-final-material-evidence-/);
});

test("chalin_route completion nudges the parent agent to synthesize", async () => {
  const fake = createFakePi();
  registerPiChalin(fake.api as never);
  const handler = fake.handlers.get("tool_execution_end")?.[0] as (event: unknown, ctx: unknown) => void;
  assert.equal(typeof handler, "function");

  handler({ type: "tool_execution_end", toolName: "chalin_route", isError: false, result: {} }, {});

  assert.equal(fake.messages.length, 1);
  assert.deepEqual(fake.messages[0]?.options, { triggerTurn: false, deliverAs: "steer" });
  assert.match(String((fake.messages[0]?.message as { content?: unknown }).content), /Answer the user's original prompt now/);
});

test("chalin_route approval blocks do not trigger synthesis shutdown", async () => {
  const fake = createFakePi();
  registerPiChalin(fake.api as never);
  const handler = fake.handlers.get("tool_execution_end")?.[0] as (event: unknown, ctx: unknown) => void;
  let shutdownCalled = false;

  handler(
    {
      type: "tool_execution_end",
      toolName: "chalin_route",
      isError: false,
      result: { details: { approval: { action: "ask", reason: "Route risk medium needs approval." } } },
    },
    { hasUI: false, shutdown: () => { shutdownCalled = true; } },
  );

  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(shutdownCalled, false);
  assert.equal(fake.messages.length, 1);
  assert.equal((fake.messages[0]?.message as { customType?: string }).customType, "pi-chalin-route-blocked-nudge");
  assert.match(String((fake.messages[0]?.message as { content?: unknown }).content), /did not execute work/i);
});

test("chalin_route completion exits non-interactive print mode after the tool result", async () => {
  const previousDelay = process.env.PI_CHALIN_NONINTERACTIVE_SHUTDOWN_DELAY_MS;
  process.env.PI_CHALIN_NONINTERACTIVE_SHUTDOWN_DELAY_MS = "0";
  try {
    const fake = createFakePi();
    registerPiChalin(fake.api as never);
    const handler = fake.handlers.get("tool_execution_end")?.[0] as (event: unknown, ctx: unknown) => void;
    let shutdownCalled = false;

    handler(
      { type: "tool_execution_end", toolName: "chalin_route", isError: false, result: {} },
      { hasUI: false, shutdown: () => { shutdownCalled = true; } },
    );

    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(shutdownCalled, true);
  } finally {
    if (previousDelay === undefined) delete process.env.PI_CHALIN_NONINTERACTIVE_SHUTDOWN_DELAY_MS;
    else process.env.PI_CHALIN_NONINTERACTIVE_SHUTDOWN_DELAY_MS = previousDelay;
  }
});



test("chalin_route rejects a second committed workflow in the same prompt", async () => {
  const fake = createFakePi();
  registerPiChalin(fake.api as never);
  const beforeAgentStart = fake.handlers.get("before_agent_start")?.[0] as (event: unknown, ctx: unknown) => Promise<{ systemPrompt?: string } | undefined>;
  const tool = fake.tools.get("chalin_route") as unknown as { execute: (...args: never[]) => Promise<{ content: Array<{ type: string; text: string }>; details: unknown }> };
  const ctx = {
    cwd: tempDir("pi-chalin-double-route-"),
    hasUI: true,
    ui: { setStatus: () => {}, notify: () => {}, setWidget: () => {} },
  } as never;

  await beforeAgentStart({ type: "before_agent_start", prompt: "review this project", systemPrompt: "base", systemPromptOptions: {} }, ctx);
  const first = await tool.execute(
    "tool-1" as never,
    { task: "review this project", topology: "sequential", expectedEffects: ["read"], steps: [{ agent: "scout", task: "Map the project." }], risk: "low" } as never,
    new AbortController().signal as never,
    (() => {}) as never,
    ctx,
  );
  const second = await tool.execute(
    "tool-2" as never,
    { task: "review this project again", topology: "sequential", expectedEffects: ["read", "verify"], steps: [{ agent: "reviewer", task: "Review the project." }], risk: "low" } as never,
    new AbortController().signal as never,
    (() => {}) as never,
    ctx,
  );

  assert.match(first.content.map((part) => part.text).join("\n"), /pi-chalin completed: scout/);
  assert.match(second.content.map((part) => part.text).join("\n"), /already executed for this user prompt/);
});

test("chalin_resume continues the latest persisted paused run instead of returning partial findings", async () => {
  const fake = createFakePi();
  registerPiChalin(fake.api as never);
  const tool = fake.tools.get("chalin_resume") as unknown as { execute: (...args: never[]) => Promise<{ content: Array<{ type: string; text: string }>; details: { run?: RunState } }> };
  const cwd = tempDir("pi-chalin-resume-tool-");
  const route: RunState["route"] = {
    kind: "multi-agent-sequential",
    agents: ["scout", "reviewer"],
    risk: "low",
    ambiguity: "low",
    needsMemory: false,
    needsArtifacts: true,
    reason: "resume smoke",
    plan: { kind: "sequential", steps: [{ agent: "scout", task: "scan" }, { agent: "reviewer", task: "review" }] },
  };
  const paused = createRunState(route, cwd);
  paused.status = "paused";
  paused.steps[0]!.status = "complete";
  paused.steps[0]!.output = { agent: "scout", text: "mapped", handoff: "Scout already mapped the project.", memoryCandidates: [], raw: "mapped", warnings: [] };
  paused.steps[1]!.status = "paused";
  paused.steps[1]!.error = "pi-chalin run stopped by user.";
  fs.mkdirSync(path.dirname(paused.logsPath!), { recursive: true });
  fs.writeFileSync(paused.logsPath!, `${JSON.stringify(paused, null, 2)}\n`);

  const updates: unknown[] = [];
  const result = await tool.execute(
    "resume-1" as never,
    {} as never,
    undefined as never,
    ((update: unknown) => { updates.push(update); }) as never,
    {
      cwd,
      hasUI: true,
      model: undefined,
      modelRegistry: { getAvailable: () => [] },
      ui: { setStatus: () => {}, notify: () => {}, setWidget: () => {} },
    } as never,
  );

  const text = result.content.map((part) => part.text).join("\n");
  assert.match(text, /Subagent results|Final answer material/);
  assert.equal(result.details.run?.id, paused.id);
  assert.equal(result.details.run?.status, "complete");
  assert.deepEqual(result.details.run?.steps.map((step) => step.status), ["complete", "complete"]);
  assert.ok(updates.length > 0);
});


test("chalin footer text is compact and animated", () => {
  assert.equal(chalinFooterText({ kind: "idle" }), "chalin ◦ idle");
  assert.equal(chalinFooterText({ kind: "off" }), "chalin × off");
  assert.equal(chalinFooterText({ kind: "running", intent: "branch summary", agent: "scout", completed: 0, total: 2 }, 0), "chalin ◆ branch summary · scout 0/2");
  assert.equal(chalinFooterText({ kind: "running", intent: "branch summary", agent: "scout", completed: 0, total: 2 }, 1), "chalin ◇ branch summary · scout 0/2");
  assert.equal(chalinFooterText({ kind: "synthesizing" }, 1), "chalin ◇ synthesizing");
  assert.equal(chalinFooterText({ kind: "complete", intent: "review project" }), "chalin ✓ review project");
});

test("pi-chalin input hook lets normal prompts continue", async () => {
  const fake = createFakePi();
  registerPiChalin(fake.api as never);
  const handler = fake.handlers.get("input")?.[0] as (event: unknown, ctx: unknown) => Promise<{ action: string }>;
  const result = await handler(
    { type: "input", text: "hello chalin", source: "interactive" },
    { cwd: tempDir("pi-chalin-auto-"), hasUI: false, ui: { notify: () => {}, setStatus: () => {} }, modelRegistry: { getAvailable: () => [] } },
  );
  assert.equal(result.action, "continue");
});

test("/chalin shows active run status while subagents are running", async () => {
  const fake = createFakePi();
  registerPiChalin(fake.api as never);
  const command = fake.commands.get("chalin") as { handler: (args: string, ctx: unknown) => Promise<void>; getArgumentCompletions?: (prefix: string) => Array<{ value: string; label: string }> | null };
  assert.equal(typeof command.handler, "function");

  const run: RunState = {
    id: "chalin-live",
    route: {
      kind: "multi-agent-sequential",
      agents: ["scout", "reviewer"],
      risk: "low",
      ambiguity: "low",
      needsMemory: false,
      needsArtifacts: true,
      reason: "test active run",
      plan: { kind: "sequential", steps: [] },
    },
    status: "running",
    startedAt: new Date().toISOString(),
    steps: [
      { id: "step-1", agent: "scout", task: "Map project", status: "complete" },
      { id: "step-2", agent: "reviewer", task: "Review project", status: "running" },
    ],
    logsPath: "/tmp/chalin-live.json",
    warnings: [],
  };
  setLatestRun(run);

  const notifications: string[] = [];
  const selectedTitles: string[] = [];
  const widgets: Array<{ key: string; content: unknown; options?: unknown }> = [];
  const statuses: string[] = [];
  await command.handler("", {
    cwd: tempDir("pi-chalin-command-"),
    hasUI: true,
    ui: {
      notify: (message: string) => notifications.push(message),
      setStatus: (_key: string, value: string) => statuses.push(value),
      setWidget: (key: string, content: unknown, options?: unknown) => widgets.push({ key, content, options }),
      select: async (title: string) => {
        selectedTitles.push(title);
        return undefined;
      },
    },
  });

  assert.deepEqual(notifications, [], "active /chalin should open controls without printing into the transcript");
  assert.deepEqual(selectedTitles, ["Control"]);
  assert.ok(widgets.every((entry) => entry.content === undefined), "/chalin may clear the legacy widget but must not create a second persistent widget; the tool-result tree is the single live surface");
  assert.match(statuses.join("\n"), /chalin .*reviewer 1\/2/);
  assert.doesNotMatch(notifications.join("\n"), /Abort \(placeholder\)|run: chalin-live|step-2 running reviewer/);
});

test("Live status opens a tabbed overlay with current subagent history", async () => {
  const fake = createFakePi();
  registerPiChalin(fake.api as never);
  const command = fake.commands.get("chalin") as { handler: (args: string, ctx: unknown) => Promise<void> };
  const run: RunState = {
    id: "chalin-live-overlay",
    route: {
      kind: "multi-agent-dag",
      agents: ["worker", "reviewer"],
      risk: "low",
      ambiguity: "low",
      needsMemory: true,
      needsArtifacts: true,
      reason: "test live overlay",
      plan: { kind: "dag", stages: [] },
    },
    status: "running",
    startedAt: new Date().toISOString(),
    steps: [
      {
        id: "step-1",
        agent: "worker",
        task: "Implement retry test improvement",
        status: "running",
      },
      {
        id: "step-2",
        agent: "reviewer",
        task: "Review retry test improvement",
        status: "running",
      },
    ],
    warnings: [],
  };
  setLatestRun(run);
  setLiveStepSession({
    runId: run.id,
    stepId: "step-1",
    agent: "worker",
    cwd: tempDir("pi-chalin-live-worker-"),
    startedAt: new Date().toISOString(),
    getMessages: () => [
      { role: "user", content: "Implement retry test improvement", timestamp: Date.now() },
      {
        role: "assistant",
        content: [
          { type: "text", text: "I am inspecting async retry tests and avoiding sleeps." },
          { type: "toolCall", id: "call-1", name: "read", arguments: { path: "src/example.ts", offset: 1, limit: 35 } },
        ],
        api: "openai-responses",
        provider: "openai",
        model: "gpt-5.5",
        usage: emptyTestUsage(),
        stopReason: "toolUse",
        timestamp: Date.now(),
      },
      {
        role: "toolResult",
        toolCallId: "call-1",
        toolName: "read",
        content: [{ type: "text", text: Array.from({ length: 35 }, (_item, index) => `line-${String(index + 1).padStart(2, "0")} retry fixture content`).join("\n") }],
        isError: false,
        timestamp: Date.now(),
      },
    ],
  });
  setLiveStepSession({
    runId: run.id,
    stepId: "step-2",
    agent: "reviewer",
    cwd: tempDir("pi-chalin-live-reviewer-"),
    startedAt: new Date().toISOString(),
    getMessages: () => [
      {
        role: "assistant",
        content: [{ type: "text", text: "I am checking guardrails and validation evidence." }],
        api: "openai-responses",
        provider: "openai",
        model: "gpt-5.5",
        usage: emptyTestUsage(),
        stopReason: "stop",
        timestamp: Date.now(),
      },
    ],
  });

  const selectedTitles: string[] = [];
  const renders: string[] = [];
  let customOptions: unknown;
  let requestRenderCount = 0;
  const plainTheme = {
    fg: (_color: string, text: string) => text,
    bg: (_color: string, text: string) => text,
    bold: (text: string) => text,
  };

  await command.handler("", {
    cwd: tempDir("pi-chalin-live-overlay-"),
    hasUI: true,
    ui: {
      notify: () => {},
      setStatus: () => {},
      setWidget: () => {},
      select: async (title: string) => {
        selectedTitles.push(title);
        return "Live status";
      },
      custom: async (factory: (tui: unknown, theme: unknown, keybindings: unknown, done: (result: undefined) => void) => { render(width: number): string[]; handleInput?(data: string): void; dispose?(): void }, options: unknown) => {
        customOptions = options;
        const component = factory({ requestRender: () => { requestRenderCount += 1; } }, plainTheme, {}, () => undefined);
        renders.push(component.render(96).join("\n"));
        component.handleInput?.("\x0f");
        renders.push(component.render(96).join("\n"));
        component.handleInput?.("\x1b[B");
        renders.push(component.render(96).join("\n"));
        component.handleInput?.("\t");
        renders.push(component.render(96).join("\n"));
        component.handleInput?.("\x1b");
        component.dispose?.();
      },
    },
  });

  assert.deepEqual(selectedTitles, ["Control"]);
  assert.match(JSON.stringify(customOptions), /"overlay":true/);
  assert.match(renders[0] ?? "", /\bLive\b/);
  assert.doesNotMatch(renders[0] ?? "", /pi-chalin Live Status/);
  assert.match(renders[0] ?? "", /worker/);
  assert.match(renders[0] ?? "", /I am inspecting async retry tests/);
  assert.match(renders[0] ?? "", /ctrl\+o tools/);
  assert.match(renders[0] ?? "", /\$ read|read src\/example\.ts:1-35/);
  assert.match(renders[0] ?? "", /src\/example\.ts/);
  assert.match(renders[0] ?? "", /line-01 retry fixture content/);
  assert.doesNotMatch(renders[0] ?? "", /line-20 retry fixture content/);
  assert.match(renders[0] ?? "", /more lines/);
  assert.match(renders[1] ?? "", /line-35 retry fixture content/);
  assert.match(renders[3] ?? "", /reviewer/);
  assert.match(renders[3] ?? "", /guardrails and validation evidence/);
  assert.ok(requestRenderCount > 0);
  for (const render of renders) {
    for (const line of render.split("\n")) assert.ok(visibleWidth(line) <= 96, `line exceeds overlay width: ${visibleWidth(line)} > 96`);
  }
});

test("chalin result widget counts checkpointed steps as progressed work", () => {
  const run: RunState = {
    id: "chalin-budget-panel",
    route: { kind: "multi-agent-dag", agents: ["scout", "context-builder"], risk: "low", ambiguity: "low", needsMemory: false, needsArtifacts: true, reason: "test" },
    status: "running",
    startedAt: new Date().toISOString(),
    warnings: [],
    steps: [
      { id: "discover:step-1", agent: "scout", task: "Map project", status: "checkpointed", checkpoint: { kind: "budget-cap", reason: "Budget cap reached during SDK child execution.", continuation: "continue" }, output: { agent: "scout", text: "partial", handoff: "Project mapped enough to continue.", memoryCandidates: [], raw: "partial", warnings: [] } },
      { id: "fanout:step-1", agent: "context-builder", task: "Analyze backend", status: "running" },
    ],
  };

  const preview = formatChalinRunWidget(run);

  assert.match(preview, /1\/2/);
  assert.match(preview, /✓ scout — Map project/);
  assert.doesNotMatch(preview, /Project mapped enough to continue/);
  assert.match(preview, /budget limit reached/);
});

test("/chalin Smart Panel does not auto-open memory when pending memories exist", async () => {
  const selectedTitles: string[] = [];
  const selectedOptions: string[][] = [];
  let memoryOpened = false;

  await openSmartPanel({
    cwd: tempDir("pi-chalin-smart-memory-"),
    hasUI: true,
    ui: {
      setStatus: () => {},
      notify: () => {},
      select: async (title: string, options: string[]) => {
        selectedTitles.push(title);
        selectedOptions.push(options);
        return "Close";
      },
    },
  } as never, {
    state: {
      autoRoutingEnabled: true,
      pendingApprovals: 0,
      activeRuns: 0,
      pendingMemoryCandidates: 1,
    },
    agents: [],
    diagnostics: [],
    pendingMemories: [memoryRecord({ status: "pending", category: "architecture", content: "The API layer owns synchronization boundaries and workers should not bypass it." })],
    onSelectAgents: async () => {},
    onSelectActivity: async () => {},
    onSelectMemory: async () => { memoryOpened = true; },
  });

  assert.deepEqual(selectedTitles, ["Smart Panel"]);
  assert.equal(memoryOpened, false);
  assert.ok(selectedOptions[0]?.some((option) => option === "Memory · 1 pending"));
});

test("Agent model picker refreshes Pi registry and persisted selection reappears in agent list", async () => {
  const cwd = tempDir("pi-chalin-agent-model-ui-");
  const agent: AgentDefinition = {
    name: "worker",
    scope: "built-in",
    concern: "implementation",
    capabilities: [],
    description: "Worker",
    model: "inherit",
    thinking: "high",
    tools: [],
    memory: { read: false, write: "never", categories: [] },
    systemPrompt: "",
    diagnostics: [],
  };
  const sessionOverrides = new Map<string, string>();
  const notifications: string[] = [];
  let renderedPicker = "";
  let renderCount = 0;
  let refreshCount = 0;

  await openAgentModelPicker({
    cwd,
    hasUI: true,
    modelRegistry: {
      refresh: () => { refreshCount += 1; },
      getAvailable: () => refreshCount > 0
        ? [
          { provider: "legacy", id: "old-model", name: "Old Model" },
          { provider: "local", id: "new-model", name: "New Model" },
        ]
        : [],
    },
    ui: {
      custom: async (factory: any) => {
        const theme = {
          fg: (_color: string, text: string) => text,
          bold: (text: string) => text,
        };
        const component = await factory({ requestRender: () => { renderCount += 1; } }, theme, {}, () => {});
        component.handleInput("n");
        component.handleInput("e");
        component.handleInput("w");
        renderedPicker = component.render(120).join("\n");
        return "local/new-model";
      },
      select: async () => "project",
      notify: (message: string) => notifications.push(message),
    },
  } as never, agent, sessionOverrides);

  assert.equal(refreshCount, 1);
  assert.ok(renderCount >= 3);
  assert.match(renderedPicker, /local\/new-model/);
  assert.doesNotMatch(renderedPicker, /legacy\/old-model/);
  assert.equal(sessionOverrides.get("built-in/worker"), undefined);

  const projectConfig = JSON.parse(fs.readFileSync(path.join(cwd, ".pi-chalin", "config.json"), "utf-8")) as {
    agents: { modelOverrides: Record<string, string>; thinkingOverrides?: Record<string, never> };
  };
  assert.equal(projectConfig.agents.modelOverrides["built-in/worker"], "local/new-model");

  const agentListSelections: Array<{ title: string; options: string[] }> = [];
  await openAgentManager({
    cwd,
    hasUI: true,
    ui: {
      select: async (title: string, options: string[]) => {
        agentListSelections.push({ title, options });
        return undefined;
      },
      notify: () => {},
    },
  } as never, [agent], sessionOverrides, new Map(), projectConfig.agents.modelOverrides, {});

  assert.match(agentListSelections[0]?.options.join("\n") ?? "", /built-in\/worker · implementation · local\/new-model · thinking high/);
  assert.match(notifications.join("\n"), /built-in\/worker model set to local\/new-model \(project\)/);
});

test("Agent manager confirms reset actions before removing overrides", async () => {
  const cwd = tempDir("pi-chalin-agent-reset-ui-");
  const agent: AgentDefinition = {
    name: "worker",
    scope: "project",
    concern: "implementation",
    capabilities: [],
    description: "Worker",
    model: "inherit",
    thinking: "high",
    tools: [],
    memory: { read: false, write: "never", categories: [] },
    systemPrompt: "",
    diagnostics: [],
  };
  const sessionOverrides = new Map<string, string>([["project/worker", "local/custom-model"]]);
  const confirmations: Array<{ title: string; message: string }> = [];
  const notifications: string[] = [];

  await openAgentManager({
    cwd,
    hasUI: true,
    ui: {
      select: async (title: string, options: string[]) => title === "Agents" ? options[0] : "Reset model",
      confirm: async (title: string, message: string) => {
        confirmations.push({ title, message });
        return false;
      },
      notify: (message: string) => notifications.push(message),
    },
  } as never, [agent], sessionOverrides, new Map(), { "project/worker": "local/custom-model" }, {});

  assert.equal(confirmations[0]?.title, "Reset Agent Model");
  assert.match(confirmations[0]?.message ?? "", /removes the saved model override/);
  assert.equal(sessionOverrides.get("project/worker"), "local/custom-model");
  assert.equal(notifications.length, 0);

  await openAgentManager({
    cwd,
    hasUI: true,
    ui: {
      select: async (title: string, options: string[]) => title === "Agents" ? options[0] : "Reset model",
      confirm: async () => true,
      notify: (message: string) => notifications.push(message),
    },
  } as never, [agent], sessionOverrides, new Map(), { "project/worker": "local/custom-model" }, {});

  assert.equal(sessionOverrides.get("project/worker"), undefined);
  assert.match(notifications.join("\n"), /project\/worker reset to inherit/);
});

test("Skill manager shows governance fields and supports per-turn activation", async () => {
  const cwd = tempDir("pi-chalin-skill-manager-ui-");
  const packageRoot = tempDir("pi-chalin-skill-manager-package-");
  writeSkillFileForSmoke(path.join(packageRoot, "skills", "review-final-gate", "SKILL.md"), `
---
name: review-final-gate
description: Reviewer checklist that requires implementation evidence and verifier evidence.
scope: built-in
extends:
  - reviewer
concerns:
  - review
capabilities:
  - validate
activation: auto
triggers:
  - review
risk: medium
allowedTools:
  - read
deniedTools:
  - bash
requiresReview: false
scripts: disabled
trust: trusted
lifecycle: active
version: 1
lastVerifiedAt: "2026-05-31T00:00:00.000Z"
commandEvidence:
  - "bun test"
---
Check implementation evidence, verifier evidence, and final answer honesty.
`);
  const catalog = SkillCatalog.load({ cwd, packageRoot });
  const selections: Array<{ title: string; options: string[] }> = [];
  const notifications: string[] = [];

  await openSkillManager({
    cwd,
    hasUI: true,
    ui: {
      select: async (title: string, options: string[]) => {
        selections.push({ title, options });
        return title === "Skills" ? options[0] : "Use this turn";
      },
      notify: (message: string) => notifications.push(message),
    },
  } as never, catalog);

  assert.match(selections[0]?.options.join("\n") ?? "", /built-in:review-final-gate · built-in · trust trusted · life active · activation auto · agents reviewer · verified 2026-05-31T00:00:00.000Z · 1 evidence/);
  assert.match(notifications.join("\n"), /skill activated for this turn: built-in:review-final-gate/);
});

test("Memory Review uses compact list items and a detail drill-down", async () => {
  const record = memoryRecord({
    status: "pending",
    category: "agent-note",
    content: "`project-fact:` Engram is local-first; internal/store with SQLite is the source of truth for persistent project memory.",
  });
  const selections: Array<{ title: string; options: string[] }> = [];
  const notifications: string[] = [];
  const approved: string[] = [];

  await openMemoryReview({
    cwd: tempDir("pi-chalin-memory-ui-"),
    hasUI: true,
    ui: {
      notify: (message: string) => notifications.push(message),
      select: async (title: string, options: string[]) => {
        selections.push({ title, options });
        return selections.length === 1 ? options[0] : "Details";
      },
    },
  } as never, [record], {
    approve: (id) => approved.push(id),
    reject: () => {},
    delete: () => {},
  });

  assert.equal(selections[0]?.title, "Memory");
  assert.equal(selections[0]?.options.length, 2);
  assert.match(selections[0]?.options[0] ?? "", /^○ pending · agent-note · context-builder · Engram is local-first/);
  assert.doesNotMatch(selections[0]?.options[0] ?? "", /SQLite is the source of truth for persistent project memory\.$/);
  assert.match(selections[1]?.title ?? "", /^Memory · Engram is local-first/);
  assert.deepEqual(selections[1]?.options, ["Details", "Approve", "Reject", "Delete", "Close"]);
  assert.match(notifications.join("\n"), /status: pending/);
  assert.match(notifications.join("\n"), /category: agent-note/);
  assert.deepEqual(approved, []);
});

test("Memory Review confirms destructive select actions", async () => {
  const record = memoryRecord({
    status: "active",
    category: "project-fact",
    content: "Deleting memory should require an explicit confirmation step.",
  });
  const selections: Array<{ title: string; options: string[] }> = [];
  const confirmations: Array<{ title: string; message: string }> = [];
  const notifications: string[] = [];
  const deleted: string[] = [];

  await openMemoryReview({
    cwd: tempDir("pi-chalin-memory-confirm-"),
    hasUI: true,
    ui: {
      notify: (message: string) => notifications.push(message),
      select: async (title: string, options: string[]) => {
        selections.push({ title, options });
        return selections.length === 1 ? options[0] : "Delete";
      },
      confirm: async (title: string, message: string) => {
        confirmations.push({ title, message });
        return false;
      },
    },
  } as never, [record], {
    approve: () => {},
    reject: () => {},
    delete: (id) => deleted.push(id),
  });

  assert.equal(confirmations[0]?.title, "Delete Memory");
  assert.match(confirmations[0]?.message ?? "", /permanently removes/);
  assert.deepEqual(deleted, []);
  assert.doesNotMatch(notifications.join("\n"), /Memory deleted/);
});

test("Memory Review uses a searchable overlay for large memory sets", async () => {
  const records = Array.from({ length: 64 }, (_, index) => memoryRecord({
    id: `memory-${index + 1}`,
    status: index === 17 ? "pending" : "active",
    category: index === 17 ? "workflow" : "project-fact",
    sourceAgent: index === 17 ? "reviewer" : "context-builder",
    createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, 0, 64 - index)).toISOString(),
    content: index === 17
      ? "needle memory overlay should be easy to find without rendering every memory as a select option."
      : `Routine memory ${index + 1} stays available without bloating the select menu.`,
  }));
  const renders: string[] = [];
  const approved: string[] = [];
  let selectCalled = false;
  let customOptions: unknown;
  let requestRenderCount = 0;
  const plainTheme = {
    fg: (_color: string, text: string) => text,
    bg: (_color: string, text: string) => text,
    bold: (text: string) => text,
  };

  await openMemoryReview({
    cwd: tempDir("pi-chalin-memory-overlay-"),
    hasUI: true,
    ui: {
      notify: () => {},
      select: async () => {
        selectCalled = true;
        return undefined;
      },
      custom: async (factory: (tui: unknown, theme: unknown, keybindings: unknown, done: (result: { action: string; id: string } | undefined) => void) => { render(width: number): string[]; handleInput?(data: string): void }, options: unknown) => {
        customOptions = options;
        let result: { action: string; id: string } | undefined;
        const component = factory({ requestRender: () => { requestRenderCount += 1; } }, plainTheme, {}, (value) => { result = value; });
        renders.push(component.render(110).join("\n"));
        for (const char of "needle") component.handleInput?.(char);
        renders.push(component.render(110).join("\n"));
        component.handleInput?.("\x15");
        for (const char of "category:workflow source:reviewer") component.handleInput?.(char);
        renders.push(component.render(110).join("\n"));
        component.handleInput?.("\x15");
        component.handleInput?.("A");
        renders.push(component.render(110).join("\n"));
        component.handleInput?.("\x15");
        for (const char of "category:workflow source:reviewer") component.handleInput?.(char);
        component.handleInput?.("\r");
        renders.push(component.render(110).join("\n"));
        component.handleInput?.("A");
        return result;
      },
    },
  } as never, records, {
    approve: (id) => approved.push(id),
    reject: () => {},
    delete: () => {},
  });

  assert.equal(selectCalled, false);
  assert.match(JSON.stringify(customOptions), /"overlay":true/);
  assert.match(renders[0] ?? "", /\bMemory\b/);
  assert.doesNotMatch(renders[0] ?? "", /pi-chalin Memory/);
  assert.match(renders[0] ?? "", /64\/64 records/);
  assert.doesNotMatch(renders[0] ?? "", /Routine memory 64/);
  assert.match(renders[1] ?? "", /1\/64 records/);
  assert.match(renders[1] ?? "", /Search: needle/);
  assert.match(renders[1] ?? "", /needle memory overlay/);
  assert.match(renders[1] ?? "", /Enter open\/action/);
  assert.doesNotMatch(renders[1] ?? "", /A approve/);
  assert.doesNotMatch(renders[1] ?? "", /R reject/);
  assert.doesNotMatch(renders[1] ?? "", /D delete/);
  assert.match(renders[1] ?? "", /cat\/source\/status:value/);
  assert.match(renders[1] ?? "", /Tab status/);
  assert.match(renders[1] ?? "", /Enter/);
  assert.doesNotMatch(renders[1] ?? "", /A\/R\/D action/);
  assert.doesNotMatch(renders[1] ?? "", /workflow\s+reviewer/);
  assert.match(renders[2] ?? "", /1\/64 records/);
  assert.match(renders[2] ?? "", /Search: category:workflow source:reviewer/);
  assert.match(renders[2] ?? "", /needle memory overlay/);
  assert.doesNotMatch(renders[2] ?? "", /Routine memory 1/);
  assert.match(renders[3] ?? "", /Search: A/);
  assert.doesNotMatch(renders[3] ?? "", /Memory detail/);
  assert.match(renders[4] ?? "", /Memory detail/);
  assert.match(renders[4] ?? "", /workflow · project · reviewer/);
  assert.match(renders[4] ?? "", /A approve · R reject · D delete/);
  assert.match(renders[4] ?? "", /Esc back/);
  assert.deepEqual(approved, ["memory-18"]);
  assert.ok(requestRenderCount > 0);
  for (const render of renders) {
    for (const line of render.split("\n")) assert.ok(visibleWidth(line) <= 110, `line exceeds overlay width: ${visibleWidth(line)} > 110`);
  }
});

test("Memory Review shows a loading overlay before records resolve", async () => {
  const record = memoryRecord({
    id: "memory-loading-1",
    status: "active",
    category: "testing",
    content: "Memory loading overlay should open immediately before Engram records finish syncing.",
  });
  let resolveLoad: (records: MemoryRecord[]) => void = () => {};
  const pendingRecords = new Promise<MemoryRecord[]>((resolve) => { resolveLoad = resolve; });
  const renders: string[] = [];
  const deleted: string[] = [];
  let customOptions: unknown;
  let requestRenderCount = 0;
  const plainTheme = {
    fg: (_color: string, text: string) => text,
    bg: (_color: string, text: string) => text,
    bold: (text: string) => text,
  };

  await openMemoryReviewWithLoading({
    cwd: tempDir("pi-chalin-memory-loading-"),
    hasUI: true,
    ui: {
      notify: () => {},
      select: async () => undefined,
      custom: async (factory: (tui: unknown, theme: unknown, keybindings: unknown, done: (result: { action: string; id: string; memories?: MemoryRecord[] } | undefined) => void) => { render(width: number): string[]; handleInput?(data: string): void; dispose?(): void }, options: unknown) => {
        customOptions = options;
        let result: { action: string; id: string; memories?: MemoryRecord[] } | undefined;
        const component = factory({ requestRender: () => { requestRenderCount += 1; } }, plainTheme, {}, (value) => { result = value; });
        renders.push(component.render(96).join("\n"));
        resolveLoad([record]);
        for (let index = 0; index < 10 && requestRenderCount === 0; index += 1) await Promise.resolve();
        renders.push(component.render(96).join("\n"));
        component.handleInput?.("\r");
        renders.push(component.render(96).join("\n"));
        component.handleInput?.("D");
        renders.push(component.render(96).join("\n"));
        component.handleInput?.("\r");
        component.dispose?.();
        return result;
      },
    },
  } as never, async () => pendingRecords, {
    approve: () => {},
    reject: () => {},
    delete: (id) => deleted.push(id),
  }, { title: "Engram Memory", loadingMessage: "Loading memory records...", showStatusFilter: false });

  assert.match(JSON.stringify(customOptions), /"overlay":true/);
  assert.match(renders[0] ?? "", /╭/);
  assert.match(renders[0] ?? "", /\bMemory\b/);
  assert.doesNotMatch(renders[0] ?? "", /Engram Memory/);
  assert.match(renders[0] ?? "", /Loading memory records/);
  assert.match(renders[1] ?? "", /Memory loading overlay should open immediately/);
  assert.match(renders[1] ?? "", /Search: type text or filters/);
  assert.doesNotMatch(renders[1] ?? "", /Tab status/);
  assert.doesNotMatch(renders[1] ?? "", /D delete/);
  assert.doesNotMatch(renders[1] ?? "", /A approve/);
  assert.match(renders[2] ?? "", /Memory detail/);
  assert.match(renders[2] ?? "", /D delete/);
  assert.match(renders[3] ?? "", /Confirm Delete/);
  assert.match(renders[3] ?? "", /Enter\/Y confirm/);
  assert.deepEqual(deleted, ["memory-loading-1"]);
  assert.ok(requestRenderCount > 0);
  for (const render of renders) {
    for (const line of render.split("\n")) assert.ok(visibleWidth(line) <= 96, `line exceeds overlay width: ${visibleWidth(line)} > 96`);
  }
});

test("WebFetch Audit uses a searchable overlay with detail drill-down", async () => {
  const observedAt = new Date().toISOString();
  const entries: WebFetchAuditEntry[] = [
    {
      key: "search-localstack-sqs",
      kind: "search",
      label: "AWS SQS local development LocalStack queues DLQ FIFO best practices",
      provider: "exa-mcp",
      observedAt,
      ageMs: 8 * 60 * 60 * 1000,
      ttlMs: 6 * 60 * 60 * 1000,
      freshness: "stale",
      sourceCount: 2,
      warnings: ["Cache entry is stale; prefer fresh evidence before making architectural claims."],
      sources: [
        { title: "LocalStack SQS developer guide", url: "https://docs.localstack.cloud/user-guide/aws/sqs/" },
        { title: "AWS SQS dead-letter queue best practices", url: "https://docs.aws.amazon.com/AWSSimpleQueueService/latest/SQSDeveloperGuide/sqs-dead-letter-queues.html" },
      ],
    },
    {
      key: "fetch-go-blog",
      kind: "fetch",
      label: "https://go.dev/blog/all",
      provider: "exa-mcp",
      observedAt,
      ageMs: 10 * 1000,
      ttlMs: 24 * 60 * 60 * 1000,
      freshness: "fresh",
      sourceCount: 1,
      warnings: [],
      sources: [{ title: "The Go Blog", url: "https://go.dev/blog/all" }],
    },
    {
      key: "search-golang-news",
      kind: "search",
      label: "Go programming language community news May 2026 latest",
      provider: "exa-mcp",
      observedAt,
      ageMs: 0,
      ttlMs: 0,
      freshness: "no-ttl",
      sourceCount: 1,
      warnings: [],
      sources: [{ title: "Golang Weekly", url: "https://golangweekly.com/" }],
    },
  ];
  const renders: string[] = [];
  let selectCalled = false;
  let customOptions: unknown;
  let requestRenderCount = 0;
  const plainTheme = {
    fg: (_color: string, text: string) => text,
    bg: (_color: string, text: string) => text,
    bold: (text: string) => text,
  };

  await openWebFetchAuditPanel({
    cwd: tempDir("pi-chalin-webfetch-overlay-"),
    hasUI: true,
    ui: {
      notify: () => {},
      select: async () => {
        selectCalled = true;
        return undefined;
      },
      custom: async (factory: (tui: unknown, theme: unknown, keybindings: unknown, done: (result: undefined) => void) => { render(width: number): string[]; handleInput?(data: string): void }, options: unknown) => {
        customOptions = options;
        const component = factory({ requestRender: () => { requestRenderCount += 1; } }, plainTheme, {}, () => undefined);
        renders.push(component.render(112).join("\n"));
        for (const char of "kind:search localstack") component.handleInput?.(char);
        renders.push(component.render(112).join("\n"));
        component.handleInput?.("\r");
        renders.push(component.render(112).join("\n"));
        component.handleInput?.("\x1b");
        component.handleInput?.("\t");
        renders.push(component.render(112).join("\n"));
      },
    },
  } as never, entries);

  assert.equal(selectCalled, false);
  assert.match(JSON.stringify(customOptions), /"overlay":true/);
  assert.match(renders[0] ?? "", /\bArticles\b/);
  assert.doesNotMatch(renders[0] ?? "", /pi-chalin WebFetch Audit/);
  assert.match(renders[0] ?? "", /3\/3 bundles/);
  assert.match(renders[0] ?? "", /Search: type text or filters like kind:search source:github/);
  assert.match(renders[0] ?? "", /Enter details/);
  assert.match(renders[0] ?? "", /Tab freshness/);
  assert.doesNotMatch(renders[0] ?? "", /Summary\nClose/);
  assert.match(renders[1] ?? "", /1\/3 bundles/);
  assert.match(renders[1] ?? "", /Search: kind:search localstack/);
  assert.match(renders[1] ?? "", /LocalStack queues DLQ FIFO/);
  assert.doesNotMatch(renders[1] ?? "", /The Go Blog/);
  assert.match(renders[2] ?? "", /WebFetch detail/);
  assert.match(renders[2] ?? "", /Cache entry is stale/);
  assert.match(renders[2] ?? "", /LocalStack SQS developer guide/);
  assert.match(renders[2] ?? "", /https:\/\/docs\.localstack\.cloud\/user-guide\/aws\/sqs\//);
  assert.match(renders[2] ?? "", /Esc back/);
  assert.match(renders[3] ?? "", /fresh/);
  assert.ok(requestRenderCount > 0);
  for (const render of renders) {
    for (const line of render.split("\n")) assert.ok(visibleWidth(line) <= 112, `line exceeds overlay width: ${visibleWidth(line)} > 112`);
  }
});


test("/chalin completions expose Activity instead of technical Runs", () => {
  const fake = createFakePi();
  registerPiChalin(fake.api as never);
  const command = fake.commands.get("chalin") as { getArgumentCompletions?: (prefix: string) => Array<{ value: string; label: string }> | null };
  const completions = command.getArgumentCompletions?.("") ?? [];

  assert.ok(completions.some((item) => item.value === "activity"));
  assert.ok(completions.some((item) => item.value === "settings"));
  assert.ok(!completions.some((item) => item.value === "runs"));
});

test("/chalin settings persists the selected memory provider", async () => {
  const fake = createFakePi();
  registerPiChalin(fake.api as never);
  const command = fake.commands.get("chalin") as { handler: (args: string, ctx: unknown) => Promise<void> };
  const cwd = tempDir("pi-chalin-settings-");
  const selections = ["Memory provider · auto", "Engram · native Engram memory"];
  const notifications: string[] = [];
  const previousEngramUrl = process.env.ENGRAM_URL;
  process.env.ENGRAM_URL = "http://127.0.0.1:9";

  try {
    await command.handler("settings", {
      cwd,
      hasUI: true,
      ui: {
        select: async () => selections.shift(),
        notify: (message: string) => notifications.push(message),
        setStatus: () => {},
      },
    });
  } finally {
    if (previousEngramUrl === undefined) delete process.env.ENGRAM_URL;
    else process.env.ENGRAM_URL = previousEngramUrl;
  }

  const config = JSON.parse(fs.readFileSync(path.join(cwd, ".pi-chalin", "config.json"), "utf-8")) as { memory?: { provider?: string } };
  assert.equal(config.memory?.provider, "engram");
  assert.match(notifications.join("\n"), /Memory provider set to engram/);
});

test("/chalin settings persists disabled approval prompts", async () => {
  const fake = createFakePi();
  registerPiChalin(fake.api as never);
  const command = fake.commands.get("chalin") as { handler: (args: string, ctx: unknown) => Promise<void> };
  const cwd = tempDir("pi-chalin-settings-");
  const selections = ["Safety · approvals disabled", "Approval threshold · disabled", "None · do not ask for approvals"];
  const notifications: string[] = [];

  await command.handler("settings", {
    cwd,
    hasUI: true,
    ui: {
      select: async () => selections.shift(),
      notify: (message: string) => notifications.push(message),
      setStatus: () => {},
    },
  });

  const config = JSON.parse(fs.readFileSync(path.join(cwd, ".pi-chalin", "config.json"), "utf-8")) as { safety?: { approvalRiskThreshold?: string } };
  assert.equal(config.safety?.approvalRiskThreshold, "none");
  assert.match(notifications.join("\n"), /Approval threshold set to disabled/);
});

test("/chalin settings persists routing autonomy", async () => {
  const fake = createFakePi();
  registerPiChalin(fake.api as never);
  const command = fake.commands.get("chalin") as { handler: (args: string, ctx: unknown) => Promise<void> };
  const cwd = tempDir("pi-chalin-settings-routing-");
  const selections = ["Routing · on · balanced", "Autonomy · balanced", "High · fewer interruptions"];
  const notifications: string[] = [];

  await command.handler("settings", {
    cwd,
    hasUI: true,
    ui: {
      select: async () => selections.shift(),
      notify: (message: string) => notifications.push(message),
      setStatus: () => {},
    },
  });

  const config = JSON.parse(fs.readFileSync(path.join(cwd, ".pi-chalin", "config.json"), "utf-8")) as { autonomy?: string };
  assert.equal(config.autonomy, "high");
  assert.match(notifications.join("\n"), /Autonomy set to high/);
});

test("/chalin settings exposes agents diagnostics and maintenance", async () => {
  const fake = createFakePi();
  registerPiChalin(fake.api as never);
  const command = fake.commands.get("chalin") as { handler: (args: string, ctx: unknown) => Promise<void> };
  const cwd = tempDir("pi-chalin-settings-sections-");
  fs.mkdirSync(path.join(cwd, ".pi-chalin", "cache", "webfetch"), { recursive: true });
  fs.writeFileSync(path.join(cwd, ".pi-chalin", "cache", "webfetch", "bundle.json"), "{}\n", "utf-8");
  fs.writeFileSync(path.join(cwd, ".pi-chalin", "cache", "project-snapshot.json"), "{}\n", "utf-8");
  fs.mkdirSync(path.join(cwd, ".pi-chalin"), { recursive: true });
  fs.writeFileSync(path.join(cwd, ".pi-chalin", "config.json"), JSON.stringify({
    agents: { modelOverrides: { "built-in/worker": "local/custom-model" } },
  }), "utf-8");

  const notifications: string[] = [];
  const confirmations: string[] = [];
  const selectAgentsSummary = async (title: string, options: string[]) => {
    if (title === "Settings") return options.find((option) => option.startsWith("Agents ·"));
    if (title === "Agents") return "Override summary";
    return undefined;
  };
  await command.handler("settings", {
    cwd,
    hasUI: true,
    ui: {
      select: selectAgentsSummary,
      notify: (message: string) => notifications.push(message),
      setStatus: () => {},
    },
  });
  assert.match(notifications.join("\n"), /model overrides: \d+/);
  assert.match(notifications.join("\n"), /thinking overrides: \d+/);

  notifications.length = 0;
  await command.handler("settings", {
    cwd,
    hasUI: true,
    ui: {
      select: async (title: string, options: string[]) => {
        if (title === "Settings") return options.find((option) => option.startsWith("Skills ·"));
        if (title === "Skills") return "Policy summary";
        return undefined;
      },
      notify: (message: string) => notifications.push(message),
      setStatus: () => {},
    },
  });
  assert.match(notifications.join("\n"), /Skill policy/);
  assert.match(notifications.join("\n"), /on-demand skills: on/);

  notifications.length = 0;
  await command.handler("settings", {
    cwd,
    hasUI: true,
    ui: {
      select: async (title: string, options: string[]) => {
        if (title === "Settings") return "Maintenance";
        if (title === "Maintenance") return options.find((option) => option.startsWith("Clear WebFetch cache"));
        return undefined;
      },
      confirm: async (title: string) => {
        confirmations.push(title);
        return true;
      },
      notify: (message: string) => notifications.push(message),
      setStatus: () => {},
    },
  });
  assert.deepEqual(confirmations, ["Clear WebFetch Cache"]);
  assert.equal(fs.existsSync(path.join(cwd, ".pi-chalin", "cache", "webfetch")), false);
  assert.match(notifications.join("\n"), /Cleared 1 WebFetch cache file/);

  notifications.length = 0;
  await command.handler("settings", {
    cwd,
    hasUI: true,
    ui: {
      select: async (title: string, options: string[]) => title === "Settings" ? options.find((option) => option.startsWith("Diagnostics ·")) : undefined,
      notify: (message: string) => notifications.push(message),
      setStatus: () => {},
    },
  });
  assert.match(notifications.join("\n"), /No pi-chalin diagnostics/);
});


test("summarizeRuntimeGuards surfaces policy, budget, worktree, and model fallback state", () => {
  const lines = summarizeRuntimeGuards({
    id: "chalin-test",
    route: { kind: "multi-agent-dag", agents: ["worker"], risk: "medium", ambiguity: "low", needsMemory: false, needsArtifacts: true, reason: "test" },
    status: "complete",
    startedAt: new Date().toISOString(),
    steps: [{
      id: "step-1",
      agent: "worker",
      task: "edit",
      status: "complete",
      model: "openai/gpt-5-mini",
      modelResolution: { selected: "openai/gpt-5-mini", tier: "strong", attempts: [{ source: "agent", ref: "anthropic/missing", status: "unavailable" }, { source: "tier", ref: "openai/gpt-5-mini", status: "selected", model: "openai/gpt-5-mini" }] },
      metrics: {
        durationMs: 100,
        usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        toolCalls: 2,
        toolCallsByName: { read: 1, edit: 1 },
        policyViolations: ["write_existing_file:src/index.ts"],
        budgetStopCount: 1,
        budgetCapHits: [{ name: "max_tool_calls", used: 3, limit: 2, severity: "hard", phase: "pre-tool", toolName: "read" }],
        duplicateReadCount: 0,
      },
    }],
    warnings: ["Parallel writer worktree isolation active; writer agents run in isolated git worktrees and merge back with git apply --3way.", "Model fallback for worker: anthropic/missing unavailable; selected openai/gpt-5-mini."],
    metrics: {
      durationMs: 100,
      usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      toolCalls: 2,
      toolCallsByName: { read: 1, edit: 1 },
      policyViolations: ["write_existing_file:src/index.ts"],
      budgetStopCount: 1,
      budgetCapHits: [{ name: "max_tool_calls", used: 3, limit: 2, severity: "hard", phase: "pre-tool", toolName: "read" }],
      duplicateReadCount: 0,
    },
  });

  assert.match(lines.join("\n"), /guards: attention/);
  assert.match(lines.join("\n"), /policy violations: 1/);
  assert.match(lines.join("\n"), /budget: limit reached max_tool_calls 3\/2 via read \(1 legacy stops\)/);
  assert.match(lines.join("\n"), /worktrees: isolated writers/);
  assert.match(lines.join("\n"), /model fallback: 1/);
});


test("chalin_route renders a compact agent tree widget instead of a plain tool label", () => {
  const planned = formatChalinRoutePlanWidget({
    task: "revisa este proyecto en profundidad",
    topology: "sequential",
    steps: [
      { agent: "scout", task: "Map project structure and high-signal files. Include package entrypoints and test commands." },
      { agent: "context-builder", task: "**Synthesize findings for the user:** include risks, modules, and validation." },
    ],
  });

  assert.match(planned, /pi-chalin · sequential/);
  assert.match(planned, /├ ○ scout — Map project structure/);
  assert.match(planned, /└ ○ context-builder — Synthesize findings for the user/);
  assert.doesNotMatch(planned, /^chalin_route$/m);
  assert.doesNotMatch(planned, /\*\*/);
  assert.doesNotMatch(planned, /Include package entrypoints/);

  const running = formatChalinRunWidget({
    id: "chalin-test",
    route: { kind: "multi-agent-sequential", agents: ["scout", "context-builder"], risk: "low", ambiguity: "low", needsMemory: false, needsArtifacts: true, reason: "test" },
    status: "running",
    startedAt: new Date().toISOString(),
    warnings: [],
    steps: [
      { id: "step-1", agent: "scout", task: "Map project structure and high-signal files. Include package entrypoints.", status: "complete", output: { agent: "scout", text: "mapped", handoff: "src/index.ts is the entrypoint", memoryCandidates: [], raw: "mapped", warnings: [] } },
      { id: "step-2", agent: "context-builder", task: "Synthesize findings for the user. Include risks and validation.", status: "running" },
    ],
  });

  assert.match(running, /pi-chalin · understand · running · 1\/2/);
  assert.match(running, /current: context-builder — Synthesize findings for the user/);
  assert.match(running, /├ ✓ scout — Map project structure/);
  assert.match(running, /└ ◆ context-builder — Synthesize findings for the user/);
  assert.doesNotMatch(running, /src\/index\.ts is the entrypoint/);
  assert.doesNotMatch(running, /Include risks/);
  assert.match(running, /tools: 0 · guards: checking/);
});

test("chalin_route marks budget checkpoint handoff steps as checkpointed, not pending", () => {
  const running = formatChalinRunWidget({
    id: "chalin-budget-live",
    route: { kind: "multi-agent-dag", agents: ["scout", "context-builder"], risk: "low", ambiguity: "low", needsMemory: false, needsArtifacts: true, reason: "test" },
    status: "running",
    startedAt: new Date().toISOString(),
    warnings: [],
    metrics: {
      durationMs: 100,
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      toolCalls: 12,
      toolCallsByName: { read: 12 },
      budgetStopCount: 1,
    },
    steps: [
      { id: "discover:step-1", agent: "scout", task: "Map project.", status: "checkpointed", checkpoint: { kind: "budget-cap", reason: "Budget cap reached during SDK child execution.", continuation: "continue" }, output: { agent: "scout", text: "Partial map", handoff: "README and docs mapped; continue with backend.", memoryCandidates: [], raw: "Partial map", warnings: [] } },
      { id: "fanout:step-1", agent: "context-builder", task: "Analyze backend.", status: "running" },
    ],
  });

  assert.match(running, /running · 1\/2/);
  assert.match(running, /├ ✓ scout — Map project/);
  assert.match(running, /budget limit reached/);
  assert.match(running, /└ ◆ context-builder — Analyze backend/);
  assert.doesNotMatch(running, /├ ○ scout/);
});

test("chalin_route failed DAG highlights the failed step and marks downstream pending work as skipped", () => {
  const failed = formatChalinRunWidget({
    id: "chalin-failed-dag",
    route: { kind: "multi-agent-dag", agents: ["scout", "context-builder", "context-builder"], risk: "low", ambiguity: "low", needsMemory: false, needsArtifacts: true, reason: "test" },
    status: "failed",
    startedAt: new Date().toISOString(),
    warnings: ["SDK runner failed for context-builder: SDK runner idle stalled for context-builder after 90000ms without activity"],
    metrics: {
      durationMs: 90000,
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      toolCalls: 0,
      toolCallsByName: {},
    },
    steps: [
      { id: "discover:step-1", agent: "scout", task: "Map project.", status: "complete", output: { agent: "scout", text: "mapped", handoff: "README mapped.", memoryCandidates: [], raw: "mapped", warnings: [] } },
      { id: "fanout:step-1", agent: "context-builder", task: "Analyze backend.", status: "failed", error: "SDK runner idle stalled for context-builder after 90000ms without activity" },
      { id: "synthesis:step-1", agent: "context-builder", task: "Synthesize final answer.", status: "pending" },
    ],
  });

  assert.match(failed, /pi-chalin · understand · failed · 1\/3/);
  assert.match(failed, /blocked: context-builder — SDK runner idle stalled/);
  assert.match(failed, /× context-builder — SDK runner idle stalled/);
  assert.match(failed, /○ context-builder — skipped after failure/);
  assert.doesNotMatch(failed, /current: context-builder — Synthesize final answer/);
  assert.doesNotMatch(failed, /context-builder — working/);
});

test("chalin_route paused DAG shows pending downstream work as waiting for resume", () => {
  const paused = formatChalinRunWidget({
    id: "chalin-paused-dag",
    route: { kind: "multi-agent-dag", agents: ["scout", "reviewer", "researcher", "planner"], risk: "low", ambiguity: "low", needsMemory: false, needsArtifacts: true, reason: "test" },
    status: "paused",
    startedAt: new Date().toISOString(),
    warnings: ["SDK runner paused researcher: SDK runner idle stalled for researcher after 120000ms without activity."],
    metrics: {
      durationMs: 120000,
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      toolCalls: 0,
      toolCallsByName: {},
    },
    steps: [
      { id: "evidence:scout", agent: "scout", task: "Map project.", status: "complete", output: { agent: "scout", text: "mapped", handoff: "mapped", memoryCandidates: [], raw: "mapped", warnings: [] } },
      { id: "evidence:reviewer", agent: "reviewer", task: "Review project.", status: "complete", output: { agent: "reviewer", text: "reviewed", handoff: "reviewed", memoryCandidates: [], raw: "reviewed", warnings: [] } },
      { id: "evidence:researcher", agent: "researcher", task: "Research context.", status: "paused", error: "SDK runner idle stalled for researcher after 120000ms without activity" },
      { id: "synthesis:planner", agent: "planner", task: "Synthesize final answer.", status: "pending" },
    ],
  });

  assert.match(paused, /pi-chalin · review · paused · 2\/4/);
  assert.match(paused, /paused: researcher — SDK runner idle stalled/);
  assert.match(paused, /■ researcher — SDK runner idle stalled/);
  assert.match(paused, /○ planner — waiting for resume/);
  assert.doesNotMatch(paused, /planner — working/);
  assert.doesNotMatch(paused, /current: planner/);
});


test("summarizeRuntimeGuards labels budget-only caps without scary attention", () => {
  const lines = summarizeRuntimeGuards({
    id: "chalin-budget",
    route: { kind: "multi-agent-dag", agents: ["scout"], risk: "low", ambiguity: "low", needsMemory: false, needsArtifacts: true, reason: "test" },
    status: "complete",
    startedAt: new Date().toISOString(),
    warnings: [],
    steps: [],
    metrics: {
      durationMs: 100,
      usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      toolCalls: 43,
      toolCallsByName: { read: 24 },
      budgetCapHits: [{ name: "max_tool_calls", used: 43, limit: 40, severity: "soft", phase: "post-step", toolName: "read" }],
      duplicateReadCount: 0,
    },
  });

  assert.match(lines.join("\n"), /guards: ok/);
  assert.match(lines.join("\n"), /budget: warning max_tool_calls 43\/40 via read/);
  assert.doesNotMatch(lines.join("\n"), /guards: attention/);
});

test("runtime and route widgets surface inefficient late-signal evidence loops", () => {
  const run: RunState = {
    id: "chalin-inefficient",
    route: { kind: "multi-agent-dag", agents: ["scout"], risk: "low", ambiguity: "low", needsMemory: false, needsArtifacts: true, reason: "test" },
    status: "complete",
    startedAt: new Date().toISOString(),
    warnings: [],
    steps: [{
      id: "step-1",
      agent: "scout",
      task: "Map project.",
      status: "complete",
      output: { agent: "scout", text: "mapped", handoff: "mapped", memoryCandidates: [], raw: "mapped", warnings: [] },
      metrics: {
        durationMs: 100,
        usage: emptyTestUsage(),
        toolCalls: 12,
        toolCallsByName: { read: 10, grep: 2 },
        crossStepDuplicateReadCount: 2,
        utility: {
          findingsPerTool: 0.167,
          filesReadPerFinding: 2,
          duplicateReads: 0,
          toolCallsBeforeFirstSignal: 10,
          verificationDone: false,
          memoryCandidatesQuality: 0,
        },
      },
    }],
    metrics: {
      durationMs: 100,
      usage: emptyTestUsage(),
      toolCalls: 12,
      toolCallsByName: { read: 10, grep: 2 },
      crossStepDuplicateReadCount: 2,
      crossStepDuplicateReads: ["src/index.ts", "src/tools.ts"],
    },
  };

  assert.match(summarizeRuntimeGuards(run).join("\n"), /late signal: 10 calls/);
  assert.match(summarizeRuntimeGuards(run).join("\n"), /cross-step duplicates: 2/);
  assert.match(formatChalinRunWidget(run), /guards: inefficient/);
  assert.match(formatChalinRunWidget(run), /cross-step duplicate reads: 2/);
});
