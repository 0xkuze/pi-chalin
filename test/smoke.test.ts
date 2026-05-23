import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, test } from "bun:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import registerPiChalin from "../src/index.ts";
import { looksLikeContinuationPrompt, shouldUseCompactDirectOrchestrationPrompt, shouldUseCompactChalinCriticalPrompt } from "../src/autoroute.ts";
import { resetRuntimeState, setLatestRun, setLiveStepSession } from "../src/runtime-state.ts";
import { openAgentManager, openAgentModelPicker } from "../src/ui-agents.ts";
import { openMemoryReview, openMemoryReviewWithLoading, openSmartPanel, openWebFetchAuditPanel, summarizeRuntimeGuards } from "../src/ui.ts";
import { finalAnswerMaterial } from "../src/route-format.ts";
import { formatChalinRoutePlanWidget, formatChalinRunWidget } from "../src/route-widget.ts";
import { createRunState, persistRun } from "../src/runner-state.ts";
import { chalinFooterText } from "../src/ui-status.ts";
import { createMemoryCandidate, MemoryStore } from "../src/memory.ts";
import type { AgentDefinition, MemoryRecord, RunState } from "../src/schemas.ts";
import type { WebFetchAuditEntry } from "../src/webfetch.ts";

const tempDirs: string[] = [];
afterEach(() => {
  resetRuntimeState();
  while (tempDirs.length > 0) fs.rmSync(tempDirs.pop()!, { recursive: true, force: true });
});
function tempDir(prefix: string): string { const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix)); tempDirs.push(dir); return dir; }
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

function createFakePi() {
  const commands = new Map<string, unknown>();
  const tools = new Map<string, unknown>();
  const handlers = new Map<string, unknown[]>();
  const fake = {
    commands,
    tools,
    handlers,
    messages: [] as Array<{ message: unknown; options: unknown }>,
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
  assert.equal(typeof inputHandler, "function");
  assert.equal(typeof beforeAgentStart, "function");
  assert.equal(fake.handlers.has("context"), false, "chalin should not register a hidden context auto-router");

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
  assert.match(promptResult?.systemPrompt ?? "", /MUST call `chalin_route` first/i);
  assert.match(promptResult?.message?.customType === "pi-chalin-orchestration" ? JSON.stringify(promptResult.message) : "", /named-file bugfixes/i);
  assert.match(promptResult?.message?.customType === "pi-chalin-orchestration" ? JSON.stringify(promptResult.message) : "", /named-file refactors/i);
  assert.match(promptResult?.message?.customType === "pi-chalin-orchestration" ? JSON.stringify(promptResult.message) : "", /Do not route or dry-run unless/i);
  assert.match(promptResult?.message?.customType === "pi-chalin-orchestration" ? JSON.stringify(promptResult.message) : "", /passing final verification/i);
  assert.match(promptResult?.message?.customType === "pi-chalin-orchestration" ? JSON.stringify(promptResult.message) : "", /bounded read-only mini-project reviews/i);
  assert.match(promptResult?.message?.customType === "pi-chalin-orchestration" ? JSON.stringify(promptResult.message) : "", /changing only implementation is incomplete/i);
  assert.match(promptResult?.message?.customType === "pi-chalin-orchestration" ? JSON.stringify(promptResult.message) : "", /dependency-free TypeScript scaffolding/i);
  assert.match(promptResult?.message?.customType === "pi-chalin-orchestration" ? JSON.stringify(promptResult.message) : "", /exact requested files/i);
  assert.match(promptResult?.message?.customType === "pi-chalin-orchestration" ? JSON.stringify(promptResult.message) : "", /bun test/i);
  assert.match(promptResult?.systemPrompt ?? "", /branch\/diff\/PR/i);
  assert.match(promptResult?.systemPrompt ?? "", /Architecture\/migration/i);
  assert.match(promptResult?.systemPrompt ?? "", /scout/);
  assert.match(promptResult?.systemPrompt ?? "", /reviewer/);
  assert.equal(promptResult?.message?.customType, "pi-chalin-orchestration");
  assert.equal(promptResult?.message?.display, false);
});

test("primary Pi agent receives compact global memory context before direct or routed decisions", async () => {
  const fake = createFakePi();
  registerPiChalin(fake.api as never);
  const beforeAgentStart = fake.handlers.get("before_agent_start")?.[0] as (event: unknown, ctx: unknown) => Promise<{ systemPrompt?: string; message?: { customType?: string; content?: string; display?: boolean } } | undefined>;
  const cwd = tempDir("pi-chalin-global-memory-");
  const memory = new MemoryStore({ cwd });
  const [record] = await memory.submitCandidates([createMemoryCandidate({
    category: "testing",
    content: "Async retry tests should avoid time.Sleep and prefer channel barriers, deterministic fake timers, or promise hooks.",
    sourceAgent: "reviewer",
    confidence: 0.96,
    evidence: "Prior retry testing review",
    scope: "project",
  })]);
  assert.ok(record);

  const previousProvider = process.env.PI_CHALIN_MEMORY_PROVIDER;
  process.env.PI_CHALIN_MEMORY_PROVIDER = "pi-chalin";
  try {
    const promptResult = await beforeAgentStart({
      type: "before_agent_start",
      prompt: "Implementa una mejora pequeña en tests async retry evitando sleeps frágiles",
      systemPrompt: "base",
      systemPromptOptions: {},
    }, { cwd, hasUI: false, model: undefined, modelRegistry: { getAvailable: () => [] } });

    assert.match(promptResult?.systemPrompt ?? "", /pi-chalin global memory context/i);
    assert.match(promptResult?.systemPrompt ?? "", /Async retry tests should avoid time\.Sleep/i);
    const events = await memory.events(record.id);
    assert.ok(events.some((event) => event.type === "retrieve" && event.actor === "primary-pi-global"));
  } finally {
    if (previousProvider === undefined) delete process.env.PI_CHALIN_MEMORY_PROVIDER;
    else process.env.PI_CHALIN_MEMORY_PROVIDER = previousProvider;
  }
});

test("spanish continuation prompt steers the resumed parent session to chalin_resume", async () => {
  assert.equal(looksLikeContinuationPrompt("continua"), true);
  assert.equal(looksLikeContinuationPrompt("continúa donde se quedaron"), true);
  assert.equal(looksLikeContinuationPrompt("sigue con el workflow"), true);

  const fake = createFakePi();
  registerPiChalin(fake.api as never);
  const beforeAgentStart = fake.handlers.get("before_agent_start")?.[0] as (event: unknown, ctx: unknown) => Promise<{ systemPrompt?: string; message?: { customType?: string; content?: string; display?: boolean } } | undefined>;
  const cwd = tempDir("pi-chalin-resume-steer-");
  const route: RunState["route"] = {
    kind: "multi-agent-chain",
    agents: ["scout", "planner", "worker"],
    risk: "medium",
    ambiguity: "low",
    needsMemory: false,
    needsArtifacts: true,
    reason: "interrupted workflow",
    plan: { kind: "chain", steps: [{ agent: "scout", task: "scan" }, { agent: "planner", task: "plan" }, { agent: "worker", task: "implement" }] },
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

  assert.equal(promptResult?.message?.customType, "pi-chalin-resume-orchestration");
  assert.equal(promptResult?.message?.display, false);
  assert.match(promptResult?.systemPrompt ?? "", /resume orchestration \(compact\)/i);
  assert.match(promptResult?.systemPrompt ?? "", /continua/i);
  assert.doesNotMatch(promptResult?.systemPrompt ?? "", /Available pi-chalin agents/i);
  assert.match(promptResult?.message?.content ?? "", /First action MUST be `chalin_resume`/);
  assert.match(promptResult?.message?.content ?? "", new RegExp(stale.id));
  assert.match(promptResult?.message?.content ?? "", /"runId"/);

  const recovered = JSON.parse(fs.readFileSync(stale.logsPath!, "utf-8")) as RunState;
  assert.equal(recovered.status, "paused");
  assert.match(recovered.warnings.join("\n"), /Recovered stale running run/);
});

test("pi-chalin uses compact orchestration context for bounded scaffold prompts", async () => {
  assert.equal(shouldUseCompactDirectOrchestrationPrompt("Scaffoldea una mini librería TypeScript de config: package.json, src/config.ts, tests y README. Sin dependencias externas."), true);
  assert.equal(shouldUseCompactDirectOrchestrationPrompt("revisa este proyecto dime que hace, en profundidad"), false);

  const fake = createFakePi();
  registerPiChalin(fake.api as never);
  const beforeAgentStart = fake.handlers.get("before_agent_start")?.[0] as (event: unknown, ctx: unknown) => Promise<{ systemPrompt?: string; message?: { customType?: string; content?: string; display?: boolean } } | undefined>;
  const ctx = {
    cwd: tempDir("pi-chalin-compact-direct-"),
    hasUI: false,
    model: undefined,
    modelRegistry: { getAvailable: () => [] },
  };
  const promptResult = await beforeAgentStart({
    type: "before_agent_start",
    prompt: "Scaffoldea una mini librería TypeScript de config: package.json, src/config.ts, tests y README. Sin dependencias externas.",
    systemPrompt: "base",
    systemPromptOptions: {},
  }, ctx);
  assert.equal(promptResult?.message?.customType, "pi-chalin-direct-compact-orchestration");
  assert.match(promptResult?.systemPrompt ?? "", /orchestration \(compact\)/i);
  assert.doesNotMatch(promptResult?.systemPrompt ?? "", /Available pi-chalin agents/i);
  assert.match(promptResult?.message?.content ?? "", /write promptly/i);
  assert.match(promptResult?.message?.content ?? "", /visible planning/i);
  assert.match(promptResult?.message?.content ?? "", /no uninstalled runners/i);
  assert.match(promptResult?.message?.content ?? "", /rerun verification after the final edit/i);
  assert.match(promptResult?.message?.content ?? "", /package\.json `bin`/i);
  assert.match(promptResult?.message?.content ?? "", /never runtime command strings/i);
  assert.match(promptResult?.message?.content ?? "", /injected clocks\/schedulers/i);
  assert.match(promptResult?.message?.content ?? "", /process\.env/i);
});



test("pi-chalin uses compact critical routing context for surgical long-file work", async () => {
  assert.equal(shouldUseCompactChalinCriticalPrompt("en un archivo largo cambia solo la validacion puntual de auth y evita reescribir el archivo completo"), true);
  assert.equal(shouldUseCompactDirectOrchestrationPrompt("en un archivo largo cambia solo la validacion puntual de auth y evita reescribir el archivo completo"), false);

  const fake = createFakePi();
  registerPiChalin(fake.api as never);
  const beforeAgentStart = fake.handlers.get("before_agent_start")?.[0] as (event: unknown, ctx: unknown) => Promise<{ systemPrompt?: string; message?: { customType?: string; content?: string; display?: boolean } } | undefined>;
  const ctx = { cwd: tempDir("pi-chalin-critical-"), hasUI: false, model: undefined, modelRegistry: { getAvailable: () => [] } };
  const promptResult = await beforeAgentStart({
    type: "before_agent_start",
    prompt: "en un archivo largo cambia solo la validacion puntual de auth y evita reescribir el archivo completo",
    systemPrompt: "base",
    systemPromptOptions: {},
  }, ctx);
  assert.equal(promptResult?.message?.customType, "pi-chalin-critical-compact-orchestration");
  assert.match(promptResult?.systemPrompt ?? "", /critical compact/i);
  assert.match(promptResult?.message?.content ?? "", /First action must be `chalin_route`/i);
  assert.doesNotMatch(promptResult?.systemPrompt ?? "", /Available pi-chalin agents\n/i);
});

test("direct bounded edits get one completion nudge after verification", async () => {
  const fake = createFakePi();
  registerPiChalin(fake.api as never);
  const beforeAgentStart = fake.handlers.get("before_agent_start")?.[0] as (event: unknown, ctx: unknown) => Promise<unknown>;
  const toolExecutionEnd = fake.handlers.get("tool_execution_end")?.[0] as (event: { toolName: string; isError?: boolean; args?: { command?: string } }, ctx: unknown) => void;
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
  assert.equal(fake.messages.filter((item) => (item.message as { customType?: string }).customType === "pi-chalin-direct-progress-nudge").length, 1, "mutation gets a progress nudge");
  assert.equal(fake.messages.some((item) => (item.message as { customType?: string }).customType === "pi-chalin-direct-completion-nudge"), false, "mutation alone is not enough for completion");

  toolExecutionEnd({ toolName: "bash", isError: true, args: { command: "bun test" } }, ctx);
  const failureNudges = fake.messages.filter((item) => (item.message as { customType?: string }).customType === "pi-chalin-direct-verification-failed-nudge");
  assert.equal(failureNudges.length, 1);
  assert.match((failureNudges[0]?.message as { content?: string }).content ?? "", /Do NOT answer as done yet/i);
  assert.match((failureNudges[0]?.message as { content?: string }).content ?? "", /bun test/i);
  assert.match((failureNudges[0]?.message as { content?: string }).content ?? "", /wall-clock flakiness/i);
  assert.match((failureNudges[0]?.message as { content?: string }).content ?? "", /process\.env/i);

  toolExecutionEnd({ toolName: "bash", isError: false, args: { command: "bun test" } }, ctx);
  const nudges = fake.messages.filter((item) => (item.message as { customType?: string }).customType === "pi-chalin-direct-completion-nudge");
  assert.equal(nudges.length, 1);
  const nudgeContent = (nudges[0]?.message as { content?: string }).content ?? "";
  assert.match(nudgeContent, /answer now/i);
  assert.match(nudgeContent, /Verification: `bun test` passed/i);
  assert.match(nudgeContent, /Passing tests is not enough/i);
  assert.match(nudgeContent, /starter smoke\/empty path/i);
  assert.match(nudgeContent, /bin\/scripts/i);
  assert.match(nudgeContent, /Do not omit the Verification or Notes line/i);
  assert.deepEqual(nudges[0]?.options, { triggerTurn: false, deliverAs: "steer" });

  toolExecutionEnd({ toolName: "edit", isError: false }, ctx);
  assert.equal(fake.messages.filter((item) => (item.message as { customType?: string }).customType === "pi-chalin-direct-progress-nudge").length, 1, "progress nudge is sent once per turn");
  assert.equal(fake.messages.filter((item) => (item.message as { customType?: string }).customType === "pi-chalin-direct-ready-to-verify-nudge").length, 2, "editing after verification invalidates stale verification and asks for a fresh check");

  toolExecutionEnd({ toolName: "bash", isError: false, args: { command: "bun test" } }, ctx);
  assert.equal(fake.messages.filter((item) => (item.message as { customType?: string }).customType === "pi-chalin-direct-completion-nudge").length, 2, "new edits after verification require a new completion nudge");
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
  assert.equal(fake.messages.filter((item) => (item.message as { customType?: string }).customType === "pi-chalin-direct-ready-to-verify-nudge").length, 2);

  toolExecutionEnd({ toolName: "bash", isError: false, args: { command: "python -m unittest discover -s tests" } }, ctx);
  const nudges = fake.messages.filter((item) => (item.message as { customType?: string }).customType === "pi-chalin-direct-completion-nudge");
  assert.equal(nudges.length, 1);
  assert.match((nudges[0]?.message as { content?: string }).content ?? "", /python -m unittest discover -s tests/);
  assert.match((nudges[0]?.message as { content?: string }).content ?? "", /starter smoke\/empty path/);
});

test("direct bounded edits do not complete when requested tests were not changed", async () => {
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

  assert.equal(fake.messages.filter((item) => (item.message as { customType?: string }).customType === "pi-chalin-direct-tests-missing-nudge").length, 1);
  assert.equal(fake.messages.filter((item) => (item.message as { customType?: string }).customType === "pi-chalin-direct-completion-nudge").length, 0);
  const missingNudge = fake.messages.find((item) => (item.message as { customType?: string }).customType === "pi-chalin-direct-tests-missing-nudge");
  assert.deepEqual(missingNudge?.options, { triggerTurn: true, deliverAs: "steer" });
  assert.match((missingNudge?.message as { content?: string }).content ?? "", /next action must be an edit\/write/i);
  assert.match((missingNudge?.message as { content?: string }).content ?? "", /non-trivial assertions/i);

  toolExecutionEnd({ toolName: "edit", isError: false, args: { path: "test/rateLimit.test.ts" } }, ctx);
  assert.equal(fake.messages.filter((item) => (item.message as { customType?: string }).customType === "pi-chalin-direct-ready-to-verify-nudge").length, 1);
  toolExecutionEnd({ toolName: "bash", isError: false, args: { command: "bun test" } }, ctx);

  assert.equal(fake.messages.filter((item) => (item.message as { customType?: string }).customType === "pi-chalin-direct-completion-nudge").length, 1);
});

test("primary memory tools search write and revise durable memories", async () => {
  const fake = createFakePi();
  registerPiChalin(fake.api as never);
  const search = fake.tools.get("chalin_memory_search") as unknown as { execute: (...args: never[]) => Promise<{ content: Array<{ type: string; text: string }>; details: { results?: unknown[] } }> };
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
  assert.match(text, /pi-chalin interview · answered/);
  assert.deepEqual(result.details.interview?.answers.map((answer) => answer.answer), ["MVP slice", "Do not touch billing yet."]);
  assert.equal(result.details.interview?.answers[0]?.recommended, true);
  assert.equal(result.details.interview?.answers[1]?.custom, true);
  assert.equal(titles.length, 2);
  assert.ok(optionsSeen[0]?.includes("MVP slice (RECOMMENDED)"));
  assert.ok(optionsSeen[0]?.includes("Custom answer…"));

  const state = JSON.parse(fs.readFileSync(path.join(cwd, ".pi-chalin", "artifacts", "features", "ambiguous-feature", "state.json"), "utf-8"));
  assert.equal(state.interviewDecisions.length, 1);
  assert.match(JSON.stringify(state), /Do not touch billing yet/);
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
      topology: "chain",
      steps: [
        { agent: "scout", task: "Map project structure and testing signals." },
        { agent: "reviewer", task: "Review architecture and risks using scout findings." },
      ],
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
  assert.match(text, /Supporting findings:/);
  assert.ok(statuses.some((status) => status.startsWith("chalin ")));
  assert.ok(statuses.some((status) => status.includes("review")));
  assert.ok(widgets.every((args) => args[1] === undefined), "chalin_route may clear the legacy widget but must not create a duplicate persistent widget");
});

test("finalAnswerMaterial preserves multi-agent analysis evidence instead of only last handoff", () => {
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
    { task: "review this project", topology: "single", steps: [{ agent: "scout", task: "Map the project." }], risk: "low" } as never,
    new AbortController().signal as never,
    (() => {}) as never,
    ctx,
  );
  const second = await tool.execute(
    "tool-2" as never,
    { task: "review this project again", topology: "single", steps: [{ agent: "reviewer", task: "Review the project." }], risk: "low" } as never,
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
    kind: "multi-agent-chain",
    agents: ["scout", "reviewer"],
    risk: "low",
    ambiguity: "low",
    needsMemory: false,
    needsArtifacts: true,
    reason: "resume smoke",
    plan: { kind: "chain", steps: [{ agent: "scout", task: "scan" }, { agent: "reviewer", task: "review" }] },
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
      kind: "multi-agent-chain",
      agents: ["scout", "reviewer"],
      risk: "low",
      ambiguity: "low",
      needsMemory: false,
      needsArtifacts: true,
      reason: "test active run",
      plan: { kind: "chain", steps: [] },
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
  assert.match(statuses.join("\n"), /chalin .*chain.*reviewer 1\/2/);
  assert.doesNotMatch(notifications.join("\n"), /Abort \(placeholder\)|run: chalin-live|step-2 running reviewer/);
});

test("Live status opens a tabbed overlay with current subagent history", async () => {
  const fake = createFakePi();
  registerPiChalin(fake.api as never);
  const command = fake.commands.get("chalin") as { handler: (args: string, ctx: unknown) => Promise<void> };
  const run: RunState = {
    id: "chalin-live-overlay",
    route: {
      kind: "multi-agent-parallel",
      agents: ["worker", "reviewer"],
      risk: "low",
      ambiguity: "low",
      needsMemory: true,
      needsArtifacts: true,
      reason: "test live overlay",
      plan: { kind: "parallel", tasks: [] },
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

test("chalin result widget counts budget-capped checkpoints as progressed work", () => {
  const run: RunState = {
    id: "chalin-budget-panel",
    route: { kind: "multi-agent-dag", agents: ["scout", "context-builder"], risk: "low", ambiguity: "low", needsMemory: false, needsArtifacts: true, reason: "test" },
    status: "running",
    startedAt: new Date().toISOString(),
    warnings: [],
    steps: [
      { id: "discover:step-1", agent: "scout", task: "Map project", status: "budget-capped", output: { agent: "scout", text: "partial", handoff: "Project mapped enough to continue.", memoryCandidates: [], raw: "partial", warnings: [] } },
      { id: "fanout:step-1", agent: "context-builder", task: "Analyze backend", status: "running" },
    ],
  };

  const preview = formatChalinRunWidget(run);

  assert.match(preview, /1\/2/);
  assert.match(preview, /✓ scout/);
  assert.match(preview, /Project mapped enough to continue/);
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
  const selections = ["Safety · approvals from medium", "Approval threshold · from medium", "None · do not ask for approvals"];
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
    route: { kind: "multi-agent-parallel", agents: ["worker"], risk: "medium", ambiguity: "low", needsMemory: false, needsArtifacts: true, reason: "test" },
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
      duplicateReadCount: 0,
    },
  });

  assert.match(lines.join("\n"), /guards: attention/);
  assert.match(lines.join("\n"), /policy violations: 1/);
  assert.match(lines.join("\n"), /budget: limit reached \(1 stops\)/);
  assert.match(lines.join("\n"), /worktrees: isolated writers/);
  assert.match(lines.join("\n"), /model fallback: 1/);
});


test("chalin_route renders a compact agent tree widget instead of a plain tool label", () => {
  const planned = formatChalinRoutePlanWidget({
    task: "revisa este proyecto en profundidad",
    topology: "chain",
    steps: [
      { agent: "scout", task: "Map project structure and high-signal files." },
      { agent: "context-builder", task: "Synthesize findings for the user." },
    ],
  });

  assert.match(planned, /pi-chalin · chain/);
  assert.match(planned, /├ ○ scout/);
  assert.match(planned, /└ ○ context-builder/);
  assert.doesNotMatch(planned, /^chalin_route$/m);

  const running = formatChalinRunWidget({
    id: "chalin-test",
    route: { kind: "multi-agent-chain", agents: ["scout", "context-builder"], risk: "low", ambiguity: "low", needsMemory: false, needsArtifacts: true, reason: "test" },
    status: "running",
    startedAt: new Date().toISOString(),
    warnings: [],
    steps: [
      { id: "step-1", agent: "scout", task: "Map project.", status: "complete", output: { agent: "scout", text: "mapped", handoff: "src/index.ts is the entrypoint", memoryCandidates: [], raw: "mapped", warnings: [] } },
      { id: "step-2", agent: "context-builder", task: "Synthesize.", status: "running" },
    ],
  });

  assert.match(running, /pi-chalin · understand · running · 1\/2/);
  assert.match(running, /├ ✓ scout/);
  assert.match(running, /└ ◆ context-builder/);
  assert.match(running, /tools: 0 · guards: checking/);
});

test("chalin_route marks budget-capped handoff steps as checkpointed, not pending", () => {
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
      { id: "discover:step-1", agent: "scout", task: "Map project.", status: "budget-capped", output: { agent: "scout", text: "Partial map", handoff: "README and docs mapped; continue with backend.", memoryCandidates: [], raw: "Partial map", warnings: [] } },
      { id: "fanout:step-1", agent: "context-builder", task: "Analyze backend.", status: "running" },
    ],
  });

  assert.match(running, /running · 1\/2/);
  assert.match(running, /├ ✓ scout — README and docs mapped/);
  assert.match(running, /budget limit reached/);
  assert.match(running, /└ ◆ context-builder/);
  assert.doesNotMatch(running, /├ ○ scout/);
});

test("chalin_route failed DAG highlights the failed step and marks downstream pending work as skipped", () => {
  const failed = formatChalinRunWidget({
    id: "chalin-failed-dag",
    route: { kind: "multi-agent-dag", agents: ["scout", "context-builder", "context-builder"], risk: "low", ambiguity: "low", needsMemory: false, needsArtifacts: true, reason: "test" },
    status: "failed",
    startedAt: new Date().toISOString(),
    warnings: ["SDK runner failed for context-builder: SDK runner timed out for context-builder after 180000ms"],
    metrics: {
      durationMs: 180000,
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      toolCalls: 0,
      toolCallsByName: {},
    },
    steps: [
      { id: "discover:step-1", agent: "scout", task: "Map project.", status: "complete", output: { agent: "scout", text: "mapped", handoff: "README mapped.", memoryCandidates: [], raw: "mapped", warnings: [] } },
      { id: "fanout:step-1", agent: "context-builder", task: "Analyze backend.", status: "failed", error: "SDK runner timed out for context-builder after 180000ms" },
      { id: "synthesis:step-1", agent: "context-builder", task: "Synthesize final answer.", status: "pending" },
    ],
  });

  assert.match(failed, /pi-chalin · understand · failed · 1\/3/);
  assert.match(failed, /blocked: context-builder — SDK runner timed out/);
  assert.match(failed, /× context-builder — SDK runner timed out/);
  assert.match(failed, /○ context-builder — skipped after failure/);
  assert.doesNotMatch(failed, /current: context-builder — Synthesize final answer/);
  assert.doesNotMatch(failed, /context-builder — working/);
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
      budgetStopCount: 18,
      duplicateReadCount: 0,
    },
  });

  assert.match(lines.join("\n"), /guards: ok/);
  assert.match(lines.join("\n"), /budget: limit reached/);
  assert.doesNotMatch(lines.join("\n"), /guards: attention/);
});
