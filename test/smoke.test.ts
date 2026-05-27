import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, test } from "bun:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import registerPiChalin from "../src/index.ts";
import { resetAutorouteToolStateForTests, shouldUseCompactDirectOrchestrationPrompt } from "../src/autoroute.ts";
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
  resetAutorouteToolStateForTests();
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
    activeTools: [] as string[],
    toolSetHistory: [] as string[][],
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
      getActiveTools() {
        return [...fake.activeTools];
      },
      setActiveTools(toolNames: string[]) {
        fake.activeTools = [...toolNames];
        fake.toolSetHistory.push([...toolNames]);
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
  assert.match(promptResult?.systemPrompt ?? "", /Call `chalin_route` first when specialist context isolation/i);
  assert.match(promptResult?.message?.customType === "pi-chalin-orchestration" ? JSON.stringify(promptResult.message) : "", /named-file bugfixes/i);
  assert.match(promptResult?.message?.customType === "pi-chalin-orchestration" ? JSON.stringify(promptResult.message) : "", /named-file refactors/i);
  assert.match(promptResult?.message?.customType === "pi-chalin-orchestration" ? JSON.stringify(promptResult.message) : "", /Do not route or dry-run unless/i);
  assert.match(promptResult?.message?.customType === "pi-chalin-orchestration" ? JSON.stringify(promptResult.message) : "", /changed-file readback/i);
  assert.match(promptResult?.message?.customType === "pi-chalin-orchestration" ? JSON.stringify(promptResult.message) : "", /bounded read-only mini-project reviews/i);
  assert.match(promptResult?.message?.customType === "pi-chalin-orchestration" ? JSON.stringify(promptResult.message) : "", /must satisfy every explicit criterion/i);
  assert.match(promptResult?.message?.customType === "pi-chalin-orchestration" ? JSON.stringify(promptResult.message) : "", /exact requested files\/APIs/i);
  assert.match(promptResult?.message?.customType === "pi-chalin-orchestration" ? JSON.stringify(promptResult.message) : "", /nearest verification/i);
  assert.match(promptResult?.message?.customType === "pi-chalin-orchestration" ? JSON.stringify(promptResult.message) : "", /test\/evidence path/i);
  assert.match(promptResult?.message?.customType === "pi-chalin-orchestration" ? JSON.stringify(promptResult.message) : "", /command-only verification evidence is incomplete/i);
  assert.doesNotMatch(promptResult?.message?.customType === "pi-chalin-orchestration" ? JSON.stringify(promptResult.message) : "", /dependency-free TypeScript|bun test/i);
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

test("resumable run context lets the parent decide chalin_resume without a prompt classifier", async () => {
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

test("pi-chalin uses compact orchestration context for bounded scaffold prompts", async () => {
  assert.equal(shouldUseCompactDirectOrchestrationPrompt("Scaffoldea una mini librería TypeScript de config: package.json, src/config.ts, tests y README. Sin dependencias externas."), true);
  assert.equal(shouldUseCompactDirectOrchestrationPrompt("Implementa un rate limiter in-memory en src/rateLimit.ts con ventanas por key, límite configurable, reset por tiempo y tests."), true);
  assert.equal(shouldUseCompactDirectOrchestrationPrompt("Implementa lru.Cache con Get/Set y capacidad fija, evicción LRU, updates y tests. Sin dependencias."), false);
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
  assert.equal(promptResult?.message?.customType, "pi-chalin-path-compact-orchestration");
  assert.equal(promptResult?.systemPrompt, "base");
  assert.doesNotMatch(promptResult?.systemPrompt ?? "", /Available pi-chalin agents/i);
  assert.match(promptResult?.message?.content ?? "", /compact path preflight/i);
  assert.match(promptResult?.message?.content ?? "", /use LLM judgment/i);
  assert.match(promptResult?.message?.content ?? "", /Respect implied dirs\/extensions\/languages\/runners/i);
  assert.match(promptResult?.message?.content ?? "", /one root-cause rerun/i);
  assert.match(promptResult?.message?.content ?? "", /package\/bin\/config metadata/i);
  assert.match(promptResult?.message?.content ?? "", /runner-discoverable cases/i);
  assert.match(promptResult?.message?.content ?? "", /zero-test assertion scripts are invalid/i);
  assert.match(promptResult?.message?.content ?? "", /real command path/i);
  assert.match(promptResult?.message?.content ?? "", /argument\/no-input/i);
  assert.match(promptResult?.message?.content ?? "", /runner agree/i);
  assert.doesNotMatch(promptResult?.message?.content ?? "", /Bun CLI|process\.env|tsx|vitest|jest/i);

  const rateLimitPrompt = await beforeAgentStart({
    type: "before_agent_start",
    prompt: "Implementa un rate limiter in-memory en src/rateLimit.ts con ventanas por key, límite configurable, reset por tiempo y tests.",
    systemPrompt: "base",
    systemPromptOptions: {},
  }, ctx);
  assert.equal(rateLimitPrompt?.message?.customType, "pi-chalin-path-compact-orchestration");
  assert.equal(rateLimitPrompt?.systemPrompt, "base");
  assert.match(rateLimitPrompt?.message?.content ?? "", /Bounded native/i);
  assert.match(rateLimitPrompt?.message?.content ?? "", /preserve public behavior/i);
  assert.match(rateLimitPrompt?.message?.content ?? "", /boundary\/counterexample/i);
  assert.match(rateLimitPrompt?.message?.content ?? "", /Capture normalized config/i);
  assert.match(rateLimitPrompt?.message?.content ?? "", /caller mutation/i);
  assert.match(rateLimitPrompt?.message?.content ?? "", /internal test seams or runner-native fake timers/i);
  assert.match(rateLimitPrompt?.message?.content ?? "", /do not expand public APIs/i);
  assert.match(rateLimitPrompt?.message?.content ?? "", /global monkeypatches/i);
  assert.match(rateLimitPrompt?.message?.content ?? "", /wall-clock sleeps/i);
  assert.doesNotMatch(rateLimitPrompt?.message?.content ?? "", /rate-limit config|non-integer config|integer limits\/windows/i);

  const pricingPrompt = await beforeAgentStart({
    type: "before_agent_start",
    prompt: "Refactoriza src/pricing.ts para extraer funciones puras pequeñas, mantener el API calculateInvoice igual, y añade/actualiza tests relevantes.",
    systemPrompt: "base",
    systemPromptOptions: {},
  }, ctx);
  assert.equal(pricingPrompt?.message?.customType, "pi-chalin-path-compact-orchestration");
  assert.match(pricingPrompt?.message?.content ?? "", /preserve public behavior/i);
  assert.match(pricingPrompt?.message?.content ?? "", /derive expected behavior before coding/i);
  assert.match(pricingPrompt?.message?.content ?? "", /No placeholders\/TODO/i);
  assert.doesNotMatch(pricingPrompt?.message?.content ?? "", /multiple line items|omitted optional discount|fractional-rate rounding/i);
  assert.doesNotMatch(pricingPrompt?.message?.content ?? "", /12\.5\/7\.25/i);

  const safeDividePrompt = await beforeAgentStart({
    type: "before_agent_start",
    prompt: "Añade un test unitario que cubra división por cero en src/safeDivide.ts. Si el comportamiento ya existe, no refactorices de más.",
    systemPrompt: "base",
    systemPromptOptions: {},
  }, ctx);
  assert.equal(safeDividePrompt?.message?.customType, "pi-chalin-path-compact-orchestration");
  assert.match(safeDividePrompt?.message?.content ?? "", /first tool `read` listed files/i);
  assert.match(safeDividePrompt?.message?.content ?? "", /no parent `ls`/i);
  assert.match(safeDividePrompt?.message?.content ?? "", /try `test\/<stem>\.test\.\*`/i);
  assert.match(safeDividePrompt?.message?.content ?? "", /skip grep\/find\/ls and manifest\/config/i);
  assert.match(safeDividePrompt?.message?.content ?? "", /do not grep the same symbol\/file/i);
  assert.match(safeDividePrompt?.message?.content ?? "", /inline tests\/test module/i);
  assert.match(safeDividePrompt?.message?.content ?? "", /Existing large\/partial files use targeted edits/i);
  assert.match(safeDividePrompt?.message?.content ?? "", /tiny fully read stubs may be replaced once/i);
  assert.match(safeDividePrompt?.message?.content ?? "", /batch implementation\+tests before first verification/i);
  assert.match(safeDividePrompt?.message?.content ?? "", /add focused criteria/i);
  assert.match(safeDividePrompt?.message?.content ?? "", /no parent `ls`/i);
  assert.doesNotMatch(safeDividePrompt?.message?.content ?? "", /safe arithmetic|nearest existing test file|missing behavior assertion/i);
  assert.doesNotMatch(safeDividePrompt?.message?.content ?? "", /test\/safeDivide\.test\.ts/i);

  const uvPrompt = await beforeAgentStart({
    type: "before_agent_start",
    prompt: "En este workspace Rust inspirado en uv, corrige normalize_index_url en crates/index-url/src/lib.rs. Debe normalizar scheme/host case-insensitive, quitar credenciales, tratar /simple y /simple/ como equivalentes y preservar path final con slash. Añade/actualiza tests y deja cargo test pasando.",
    systemPrompt: "base",
    systemPromptOptions: {},
  }, ctx);
  assert.equal(uvPrompt?.message?.customType, "pi-chalin-path-compact-orchestration");
  assert.match(uvPrompt?.message?.content ?? "", /minimal bounded path/i);
  assert.match(uvPrompt?.message?.content ?? "", /Prompt path: `crates\/index-url\/src\/lib\.rs`/i);
  assert.match(uvPrompt?.message?.content ?? "", /named runner/i);
  assert.match(uvPrompt?.message?.content ?? "", /First tool `read` the prompt path/i);
  assert.match(uvPrompt?.message?.content ?? "", /No ls\/grep\/find\/manifest/i);
  assert.match(uvPrompt?.message?.content ?? "", /Existing prompt path uses edit, not write/i);
  assert.match(uvPrompt?.message?.content ?? "", /Do not loop baseline verification before mutation/i);
  assert.match(uvPrompt?.message?.content ?? "", /assert changed behavior/i);
  assert.match(uvPrompt?.message?.content ?? "", /one boundary\/counterexample/i);
  assert.match(uvPrompt?.message?.content ?? "", /No Box::leak\/static leaks\/unsafe escape hatches/i);
  assert.match(uvPrompt?.message?.content ?? "", /URL\/path\/string normalizers/i);
  assert.match(uvPrompt?.message?.content ?? "", /query\/fragment composition/i);
  assert.match(uvPrompt?.message?.content ?? "", /Read back changed files only for concrete missing evidence/i);
  assert.ok((uvPrompt?.message?.content?.length ?? Infinity) < 1800);
  assert.doesNotMatch(uvPrompt?.message?.content ?? "", /normalization\/canonicalization|path\/query\/fragment\/port\/identity|non-target input/i);

  const cachePrompt = await beforeAgentStart({
    type: "before_agent_start",
    prompt: "En este workspace Rust, implementa build_cache_key en crates/cache-key/src/lib.rs. Debe normalizar package con trim + lowercase, normalizar version con trim sin cambiar su contenido, aplicar trim a markers, ignorar markers vacios despues del trim, ordenar markers, preservar case y duplicados de markers, producir una key deterministica y cubrirlo con tests. Deja cargo test pasando.",
    systemPrompt: "base",
    systemPromptOptions: {},
  }, ctx);
  assert.equal(cachePrompt?.message?.customType, "pi-chalin-path-compact-orchestration");
  assert.match(cachePrompt?.message?.content ?? "", /preserve public behavior/i);
  assert.match(cachePrompt?.message?.content ?? "", /boundary\/counterexample/i);
  assert.match(cachePrompt?.message?.content ?? "", /minimal bounded path/i);
  assert.match(cachePrompt?.message?.content ?? "", /Prompt path: `crates\/cache-key\/src\/lib\.rs`/i);
  assert.match(cachePrompt?.message?.content ?? "", /implementation\+tests before first verification/i);
  assert.match(cachePrompt?.message?.content ?? "", /inline tests\/test module/i);
  assert.match(cachePrompt?.message?.content ?? "", /deterministic order/i);
  assert.match(cachePrompt?.message?.content ?? "", /same output for shuffled input order/i);
  assert.match(cachePrompt?.message?.content ?? "", /duplicate\/case preservation/i);
  assert.match(cachePrompt?.message?.content ?? "", /every retained input once/i);
  assert.match(cachePrompt?.message?.content ?? "", /own visible assertion/i);
  assert.match(cachePrompt?.message?.content ?? "", /Rust:/i);
  assert.match(cachePrompt?.message?.content ?? "", /full lowercase/i);
  assert.match(cachePrompt?.message?.content ?? "", /borrowed &str/i);
  assert.match(cachePrompt?.message?.content ?? "", /sort_unstable/i);
  assert.match(cachePrompt?.message?.content ?? "", /unused mut\/imports\/dead code count as defects/i);
  assert.match(cachePrompt?.message?.content ?? "", /fails or warns/i);
  assert.ok((cachePrompt?.message?.content?.length ?? Infinity) < 1800);
  assert.doesNotMatch(cachePrompt?.message?.content ?? "", /deterministic key builder|semantic content\/case/i);

  const cPrompt = await beforeAgentStart({
    type: "before_agent_start",
    prompt: "Corrige la regresión C de unicode: ascii_trim debe recortar whitespace ASCII sin tocar bytes UTF-8 ni espacios Unicode. Deja make test pasando.",
    systemPrompt: "base",
    systemPromptOptions: {},
  }, ctx);
  assert.equal(cPrompt?.message?.customType, "pi-chalin-compact-orchestration");
  assert.match(cPrompt?.message?.content ?? "", /the code does not classify prompts for you/i);
  assert.match(cPrompt?.message?.content ?? "", /First decide route, then tools/i);
  assert.match(cPrompt?.message?.content ?? "", /Stay native for simple chat, one obvious command/i);
  assert.match(cPrompt?.message?.content ?? "", /specific function\/symbol\/API plus local verification/i);
  assert.match(cPrompt?.message?.content ?? "", /small bounded package\/class\/function work without prompt paths/i);
  assert.match(cPrompt?.message?.content ?? "", /edit source\+tests/i);
  assert.match(cPrompt?.message?.content ?? "", /tiny fully read stubs may be replaced in one write per file/i);
  assert.match(cPrompt?.message?.content ?? "", /not a routing keyword/i);
  assert.match(cPrompt?.message?.content ?? "", /no-op\/boundary\/error paths/i);
  assert.match(cPrompt?.message?.content ?? "", /Strict decoders\/parsers consume the full input/i);
  assert.match(cPrompt?.message?.content ?? "", /trailing non-whitespace data after a valid value is an error/i);
  assert.match(cPrompt?.message?.content ?? "", /capacity\/limit, cover negative\/zero\/one and update-without-growth/i);
  assert.match(cPrompt?.message?.content ?? "", /Go exported APIs get concise doc comments/i);
  assert.match(cPrompt?.message?.content ?? "", /changed-file readback/i);
  assert.match(cPrompt?.systemPrompt ?? "", /You are the primary Pi agent/i);
  assert.doesNotMatch(cPrompt?.message?.content ?? "", /C\/string bugfix|preserve bytes outside the requested mutation/i);

  const filterPrompt = await beforeAgentStart({
    type: "before_agent_start",
    prompt: "Implementa filterTasks en src/filterTasks.ts y tests para búsqueda por texto en title/description.",
    systemPrompt: "base",
    systemPromptOptions: {},
  }, ctx);
  assert.equal(filterPrompt?.message?.customType, "pi-chalin-path-compact-orchestration");
  assert.match(filterPrompt?.message?.content ?? "", /Text\/query filters/i);
  assert.match(filterPrompt?.message?.content ?? "", /blank\/whitespace, no-match, optional\/missing fields, and order preservation/i);

  const dottedIdentifierPrompt = await beforeAgentStart({
    type: "before_agent_start",
    prompt: "Implementa lru.Cache con Get/Set y capacidad fija. Debe evictar least-recently-used al superar capacidad, actualizar existing keys y tener tests. Sin dependencias.",
    systemPrompt: "base",
    systemPromptOptions: {},
  }, ctx);
  assert.equal(dottedIdentifierPrompt?.message?.customType, "pi-chalin-compact-orchestration");
  assert.match(dottedIdentifierPrompt?.message?.content ?? "", /one small package\/module\/class\/function implementation with tests and no prompt paths stays native/i);
  assert.match(dottedIdentifierPrompt?.message?.content ?? "", /Infer conventional paths from prompt identifiers/i);
  assert.doesNotMatch(dottedIdentifierPrompt?.message?.content ?? "", /Prompt paths: `lru\.Cache`/i);
});



test("pi-chalin leaves surgical no-path routing to the model instead of a regex fast path", async () => {
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
  assert.equal(promptResult?.message?.customType, "pi-chalin-compact-orchestration");
  assert.match(promptResult?.message?.content ?? "", /the code does not classify prompts for you/i);
  assert.match(promptResult?.message?.content ?? "", /risky surgical\/long-file edits/i);
  assert.match(promptResult?.message?.content ?? "", /bounded read-only mini-reviews that explicitly forbid file modification should stay native/i);
  assert.match(promptResult?.message?.content ?? "", /context that compaction becomes likely/i);
  assert.match(promptResult?.message?.content ?? "", /route or split work into subagents/i);
  assert.match(promptResult?.systemPrompt ?? "", /You are the primary Pi agent/i);
});

test("pi-chalin keeps bounded path prompts compact without hiding route autonomy", async () => {
  const prompt = "En esta base multi-lenguaje inspirada en Bun, haz un analisis profundo cross-language del bug de paquetes duplicados entre Zig y Rust. No cambies codigo: actualiza docs/lockfile-triage.md.";
  assert.equal(shouldUseCompactDirectOrchestrationPrompt(prompt), true);
  assert.equal(shouldUseCompactDirectOrchestrationPrompt("En este workspace Rust, implementa build_cache_key en crates/cache-key/src/lib.rs y deja cargo test pasando."), true);

  const fake = createFakePi();
  registerPiChalin(fake.api as never);
  const inputHandler = fake.handlers.get("input")?.[0] as (event: unknown, ctx: unknown) => Promise<{ action: string }>;
  const beforeAgentStart = fake.handlers.get("before_agent_start")?.[0] as (event: unknown, ctx: unknown) => Promise<{ systemPrompt?: string; message?: { customType?: string; content?: string; display?: boolean } } | undefined>;
  const agentEnd = fake.handlers.get("agent_end")?.[0] as (event: unknown, ctx: unknown) => void;
  const ctx = { cwd: tempDir("pi-chalin-cross-language-"), hasUI: false, model: undefined, modelRegistry: { getAvailable: () => [] } };
  const activeToolSet = ["chalin_project_discovery", "chalin_project_snapshot", "read", "bash", "grep", "find", "ls", "edit", "write", "chalin_interview", "chalin_route", "chalin_resume", "chalin_web_search", "chalin_memory_search"];
  fake.activeTools = [...activeToolSet];
  const inputResult = await inputHandler({ type: "input", text: prompt, source: "interactive" }, ctx);
  assert.equal(inputResult.action, "continue");
  assert.deepEqual(fake.activeTools, activeToolSet);
  const promptResult = await beforeAgentStart({
    type: "before_agent_start",
    prompt,
    systemPrompt: "base",
    systemPromptOptions: {},
  }, ctx);

  assert.equal(promptResult?.message?.customType, "pi-chalin-path-compact-orchestration");
  assert.match(promptResult?.message?.content ?? "", /use LLM judgment for intent and risk/i);
  assert.match(promptResult?.message?.content ?? "", /compact docs-artifact preflight/i);
  assert.match(promptResult?.message?.content ?? "", /First decide route, then tools/i);
  assert.match(promptResult?.message?.content ?? "", /Docs-only work with one explicit docs artifact should start native/i);
  assert.match(promptResult?.message?.content ?? "", /Escalate to `chalin_route` only after concrete evidence/i);
  assert.match(promptResult?.message?.content ?? "", /Suggested route after native evidence proves escalation is needed/i);
  assert.match(promptResult?.message?.content ?? "", /Causal consistency check/i);
  assert.match(promptResult?.message?.content ?? "", /Native docs mode/i);
  assert.match(promptResult?.message?.content ?? "", /A final answer that only says what you will do is invalid/i);
  assert.match(promptResult?.message?.content ?? "", /one compact discovery pass/i);
  assert.match(promptResult?.message?.content ?? "", /avoid repeated find\/grep\/ls variants/i);
  assert.match(promptResult?.message?.content ?? "", /one concrete source file per named surface/i);
  assert.match(promptResult?.message?.content ?? "", /one targeted find for that surface/i);
  assert.match(promptResult?.message?.content ?? "", /Treat readback as a quality gate/i);
  assert.match(promptResult?.message?.content ?? "", /mid-sentence final lines/i);
  assert.match(promptResult?.message?.content ?? "", /placeholder\/TODO/i);
  assert.match(promptResult?.message?.content ?? "", /do not change product code/i);
  assert.doesNotMatch(promptResult?.message?.content ?? "", /at most 1 targeted `find` and 1 targeted `grep`/i);
  assert.match(promptResult?.message?.content ?? "", /If staying native, after writing docs the next tool must be `read`/i);
  assert.match(promptResult?.message?.content ?? "", /rollback\/compatibility strategy/i);
  assert.match(promptResult?.message?.content ?? "", /ownership\/responsibility/i);
  assert.match(promptResult?.message?.content ?? "", /Native final should be concise but complete/i);
  assert.deepEqual(fake.activeTools, activeToolSet);
  assert.equal(fake.toolSetHistory.length, 0);

  agentEnd({}, ctx);
  assert.deepEqual(fake.activeTools, activeToolSet);

  const runtimePlan = await beforeAgentStart({
    type: "before_agent_start",
    prompt: "En esta base multi-lenguaje inspirada en Bun, planifica una implementacion segura y cross-language para propagar un nuevo runtime flag `--deny-net` desde CLI Zig hasta el runtime Rust. No escribas codigo: actualiza docs/deny-net-plan.md con arquitectura, archivos tocados, riesgos, pasos incrementales y validacion.",
    systemPrompt: "base",
    systemPromptOptions: {},
  }, ctx);
  assert.equal(runtimePlan?.message?.customType, "pi-chalin-path-compact-orchestration");
  assert.match(runtimePlan?.message?.content ?? "", /Prompt paths: `docs\/deny-net-plan\.md`/i);
  assert.match(runtimePlan?.message?.content ?? "", /exact evidence paths, requested artifact fields covered/i);
  assert.match(runtimePlan?.message?.content ?? "", /broad synthesis/i);
  assert.doesNotMatch(runtimePlan?.message?.content ?? "", /Cross-language\/runtime plan|ABI-stable fixed-width primitives/i);
  assert.deepEqual(fake.activeTools, activeToolSet);

  agentEnd({}, ctx);
  assert.deepEqual(fake.activeTools, activeToolSet);

  const diagnosticPlan = await beforeAgentStart({
    type: "before_agent_start",
    prompt: "En esta base C++ inspirada en LLVM/Clang, haz un analisis profundo de arquitectura para mover la responsabilidad de formateo de diagnostics fuera de Parser.cpp hacia DiagnosticEngine sin cambiar comportamiento. No implementes codigo: actualiza docs/diagnostic-refactor-plan.md con mapa de dependencias, plan por etapas, riesgos y pruebas.",
    systemPrompt: "base",
    systemPromptOptions: {},
  }, ctx);
  assert.equal(diagnosticPlan?.message?.customType, "pi-chalin-path-compact-orchestration");
  assert.match(diagnosticPlan?.message?.content ?? "", /use LLM judgment/i);
  assert.match(diagnosticPlan?.message?.content ?? "", /Docs\/no-code/i);
  assert.match(diagnosticPlan?.message?.content ?? "", /responsibility\/ownership maps/i);
  assert.match(diagnosticPlan?.message?.content ?? "", /evidence-derived validation/i);
  assert.doesNotMatch(diagnosticPlan?.message?.content ?? "", /Diagnostic\/formatter planning|dependency-and-responsibility map/i);
  agentEnd({}, ctx);
  assert.deepEqual(fake.activeTools, activeToolSet);

  const codePrompt = await beforeAgentStart({
    type: "before_agent_start",
    prompt: "Actualiza src/cache.ts y test/cache.test.ts para corregir la clave compuesta y deja bun test test/cache.test.ts pasando.",
    systemPrompt: "base",
    systemPromptOptions: {},
  }, ctx);
  assert.equal(codePrompt?.message?.customType, "pi-chalin-path-compact-orchestration");
  assert.match(codePrompt?.message?.content ?? "", /Code\+test direct preference/i);
  assert.match(codePrompt?.message?.content ?? "", /escalate to `chalin_route` only when evidence proves broader scope/i);
  assert.match(codePrompt?.message?.content ?? "", /batch implementation\+tests/i);
  assert.match(codePrompt?.message?.content ?? "", /skip grep\/find\/ls and manifest\/config/i);
  assert.match(codePrompt?.message?.content ?? "", /do not grep the same symbol\/file/i);
  assert.match(codePrompt?.message?.content ?? "", /one root-cause rerun/i);
  assert.match(codePrompt?.message?.content ?? "", /For transformations/i);
  assert.match(codePrompt?.message?.content ?? "", /For parsers\/scanners\/state machines/i);
  assert.match(codePrompt?.message?.content ?? "", /No placeholders\/TODO/i);
  assert.deepEqual(fake.activeTools, activeToolSet);
  agentEnd({}, ctx);
  assert.deepEqual(fake.activeTools, activeToolSet);
});

test("production autoroute prompts do not embed workflow fixture-specific shortcuts", () => {
  const productionPromptFiles = [
    path.join(process.cwd(), "src", "autoroute.ts"),
    path.join(process.cwd(), "src", "orchestration.ts"),
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
  const beforeAgentStart = fake.handlers.get("before_agent_start")?.[0] as (event: unknown, ctx: unknown) => Promise<unknown>;
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
  assert.match((progressNudges[0]?.message as { content?: string }).content ?? "", /do not run the first verification after a source-only edit/i);
  assert.match((progressNudges[0]?.message as { content?: string }).content ?? "", /retain every non-empty input exactly once/i);
  assert.match((progressNudges[0]?.message as { content?: string }).content ?? "", /Preserve compatibility/i);
  assert.match((progressNudges[0]?.message as { content?: string }).content ?? "", /runner-discoverable tests/i);
  assert.match((progressNudges[0]?.message as { content?: string }).content ?? "", /Do not read back just to summarize/i);
  assert.match((progressNudges[0]?.message as { content?: string }).content ?? "", /real command path/i);
  assert.match((progressNudges[0]?.message as { content?: string }).content ?? "", /supported claims/i);
  assert.equal(fake.messages.filter((item) => (item.message as { customType?: string }).customType === "pi-chalin-direct-ready-to-verify-nudge").length, 0, "first code edit is not treated as verification-ready");
  const sourceTestReady = fake.messages.filter((item) => (item.message as { customType?: string }).customType === "pi-chalin-direct-source-test-ready-nudge");
  assert.equal(sourceTestReady.length, 1, "source+test edits get one verify-now nudge");
  assert.match((sourceTestReady[0]?.message as { content?: string }).content ?? "", /Source and tests changed/i);
  assert.match((sourceTestReady[0]?.message as { content?: string }).content ?? "", /requested package\/API\/docs metadata/i);
  assert.match((sourceTestReady[0]?.message as { content?: string }).content ?? "", /Stop expanding scope/i);
  assert.match((sourceTestReady[0]?.message as { content?: string }).content ?? "", /verify the actual contract/i);
  assert.match((sourceTestReady[0]?.message as { content?: string }).content ?? "", /text\/query filters/i);
  assert.match((sourceTestReady[0]?.message as { content?: string }).content ?? "", /no-match empty result/i);
  assert.match((sourceTestReady[0]?.message as { content?: string }).content ?? "", /not object\/array identity/i);
  assert.match((sourceTestReady[0]?.message as { content?: string }).content ?? "", /manually check expected IDs\/rows/i);
  assert.match((sourceTestReady[0]?.message as { content?: string }).content ?? "", /parser\/scanner\/tokenizer\/state-machine/i);
  assert.match((sourceTestReady[0]?.message as { content?: string }).content ?? "", /delimiter-like text inside protected states/i);
  assert.match((sourceTestReady[0]?.message as { content?: string }).content ?? "", /after a later passing verification/i);
  assert.match((sourceTestReady[0]?.message as { content?: string }).content ?? "", /Do not read\/rewrite more files before verification/i);
  assert.match((sourceTestReady[0]?.message as { content?: string }).content ?? "", /no full rewrite after source\+test edits/i);
  assert.equal(fake.messages.some((item) => (item.message as { customType?: string }).customType === "pi-chalin-direct-completion-nudge"), false, "mutation alone is not enough for completion");

  toolExecutionEnd({ toolName: "bash", isError: true, args: { command: "bun test" } }, ctx);
  const failureNudges = fake.messages.filter((item) => (item.message as { customType?: string }).customType === "pi-chalin-direct-verification-failed-nudge");
  assert.equal(failureNudges.length, 1);
  assert.match((failureNudges[0]?.message as { content?: string }).content ?? "", /Do NOT answer as done yet/i);
  assert.match((failureNudges[0]?.message as { content?: string }).content ?? "", /bun test/i);
  assert.match((failureNudges[0]?.message as { content?: string }).content ?? "", /Use the latest failure as evidence/i);
  assert.match((failureNudges[0]?.message as { content?: string }).content ?? "", /Patch the exact failing source or assertion/i);
  assert.match((failureNudges[0]?.message as { content?: string }).content ?? "", /Do not grep\/find\/read broad surfaces for a known symbol/i);
  assert.match((failureNudges[0]?.message as { content?: string }).content ?? "", /at most one targeted read of an already changed file/i);
  assert.match((failureNudges[0]?.message as { content?: string }).content ?? "", /failure is superseded/i);
  assert.match((failureNudges[0]?.message as { content?: string }).content ?? "", /repo runner\/package manager/i);
  assert.doesNotMatch((failureNudges[0]?.message as { content?: string }).content ?? "", /process\.env/i);

  toolExecutionEnd({ toolName: "bash", isError: false, args: { command: "bun test" } }, ctx);
  const nudges = fake.messages.filter((item) => (item.message as { customType?: string }).customType === "pi-chalin-direct-completion-nudge");
  assert.equal(nudges.length, 1);
  const nudgeContent = (nudges[0]?.message as { content?: string }).content ?? "";
  assert.match(nudgeContent, /Final now if the last edit output plus `bun test` already prove/i);
  assert.match(nudgeContent, /readback after pass is waste/i);
  assert.match(nudgeContent, /changed-file readback \(`test\/parseDate\.test\.ts`\) only when/i);
  assert.match(nudgeContent, /If requested API\/tests\/docs\/manifest\/bin\/export\/toolchain/i);
  assert.match(nudgeContent, /Verification: `bun test` passed/i);
  assert.match(nudgeContent, /do not run another shell\/test command/i);
  assert.match(nudgeContent, /concise but complete/i);
  assert.match(nudgeContent, /boundary\/preservation evidence/i);
  assert.deepEqual(nudges[0]?.options, { triggerTurn: false, deliverAs: "steer" });

  toolExecutionEnd({ toolName: "grep", isError: false, args: { path: "src", pattern: "parseIsoDate" } }, ctx);
  const postVerificationExploration = fake.messages.filter((item) => (item.message as { customType?: string }).customType === "pi-chalin-post-verification-exploration-nudge");
  assert.equal(postVerificationExploration.length, 1, "extra discovery after passing verification gets a stop nudge");
  assert.match((postVerificationExploration[0]?.message as { content?: string }).content ?? "", /Stop post-verification discovery/i);
  assert.match((postVerificationExploration[0]?.message as { content?: string }).content ?? "", /final now/i);
  assert.match((postVerificationExploration[0]?.message as { content?: string }).content ?? "", /Do not read back just to summarize/i);

  toolExecutionEnd({ toolName: "read", isError: false, args: { path: "test/parseDate.test.ts" } }, ctx);
  const readbackNudges = fake.messages.filter((item) => (item.message as { customType?: string }).customType === "pi-chalin-direct-completion-nudge");
  assert.equal(readbackNudges.length, 2, "changed-file readback after a passing verification gets a final stop nudge");
  assert.match((readbackNudges[1]?.message as { content?: string }).content ?? "", /do not run another shell\/test command/i);

  toolExecutionEnd({ toolName: "bash", isError: false, args: { command: "bun test" } }, ctx);
  const postVerificationNudges = fake.messages.filter((item) => (item.message as { customType?: string }).customType === "pi-chalin-post-verification-shell-nudge");
  assert.equal(postVerificationNudges.length, 1, "extra shell after passing verification gets a stop nudge");
  assert.match((postVerificationNudges[0]?.message as { content?: string }).content ?? "", /Verification already passed/i);
  assert.match((postVerificationNudges[0]?.message as { content?: string }).content ?? "", /final now/i);
  assert.match((postVerificationNudges[0]?.message as { content?: string }).content ?? "", /previous edit result was incomplete/i);

  toolExecutionEnd({ toolName: "edit", isError: false }, ctx);
  toolExecutionEnd({ toolName: "edit", isError: false, args: { path: "test/parseDate.test.ts" } }, ctx);
  assert.equal(fake.messages.filter((item) => (item.message as { customType?: string }).customType === "pi-chalin-direct-progress-nudge").length, 1, "progress nudge is sent once per turn");
  assert.equal(fake.messages.filter((item) => (item.message as { customType?: string }).customType === "pi-chalin-direct-ready-to-verify-nudge").length, 0, "source+test-ready steer replaces the generic verification-ready nudge");
  assert.equal(fake.messages.filter((item) => (item.message as { customType?: string }).customType === "pi-chalin-direct-source-test-ready-nudge").length, 2, "editing after verification invalidates stale verification and asks for a fresh check");

  toolExecutionEnd({ toolName: "bash", isError: false, args: { command: "bun test" } }, ctx);
  assert.equal(fake.messages.filter((item) => (item.message as { customType?: string }).customType === "pi-chalin-direct-completion-nudge").length, 3, "new edits after verification require a new completion nudge");
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

  toolExecutionEnd({ toolName: "bash", isError: false, args: { command: "python -m unittest discover -s tests" } }, ctx);
  const nudges = fake.messages.filter((item) => (item.message as { customType?: string }).customType === "pi-chalin-direct-completion-nudge");
  assert.equal(nudges.length, 1);
  assert.match((nudges[0]?.message as { content?: string }).content ?? "", /python -m unittest discover -s tests/);
  assert.match((nudges[0]?.message as { content?: string }).content ?? "", /boundary\/preservation evidence/);
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

test("direct docs-only evidence gathering does not use fixed evidence-count nudges", async () => {
  const fake = createFakePi();
  registerPiChalin(fake.api as never);
  const beforeAgentStart = fake.handlers.get("before_agent_start")?.[0] as (event: unknown, ctx: unknown) => Promise<unknown>;
  const toolExecutionEnd = fake.handlers.get("tool_execution_end")?.[0] as (event: { toolName: string; isError?: boolean; args?: Record<string, unknown> }, ctx: unknown) => void;
  const ctx = {
    cwd: tempDir("pi-chalin-docs-evidence-nudge-"),
    hasUI: false,
    model: undefined,
    modelRegistry: { getAvailable: () => [] },
  };

  await beforeAgentStart({ type: "before_agent_start", prompt: "actualiza docs/plan.md sin tocar codigo", systemPrompt: "base", systemPromptOptions: {} }, ctx);
  toolExecutionEnd({ toolName: "chalin_project_discovery", isError: false, args: {} }, ctx);
  toolExecutionEnd({ toolName: "read", isError: false, args: { path: "src/a.ts" } }, ctx);
  assert.equal(fake.messages.filter((item) => (item.message as { customType?: string }).customType === "pi-chalin-docs-evidence-ready-nudge").length, 0);
  toolExecutionEnd({ toolName: "read", isError: false, args: { path: "src/b.ts" } }, ctx);
  assert.equal(fake.messages.filter((item) => (item.message as { customType?: string }).customType === "pi-chalin-docs-evidence-ready-nudge").length, 0);
  toolExecutionEnd({ toolName: "read", isError: false, args: { path: "src/c.ts" } }, ctx);
  toolExecutionEnd({ toolName: "grep", isError: false, args: { path: "src", pattern: "x" } }, ctx);

  const nudges = fake.messages.filter((item) => (item.message as { customType?: string }).customType === "pi-chalin-docs-evidence-ready-nudge");
  assert.equal(nudges.length, 0);
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
  assert.match((nudges[0]?.message as { content?: string }).content ?? "", /Stop ls\/find\/grep now/i);
  assert.match((nudges[0]?.message as { content?: string }).content ?? "", /write the requested docs artifact/i);
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
  const shellNudge = fake.messages.find((item) => (item.message as { customType?: string }).customType === "pi-chalin-docs-only-shell-nudge");
  assert.match((shellNudge?.message as { content?: string }).content ?? "", /names only docs artifacts/i);
  assert.match((shellNudge?.message as { content?: string }).content ?? "", /Stop running shell verification/i);
  toolExecutionEnd({ toolName: "write", isError: false, args: { path: "docs/plan.md" } }, ctx);

  const progress = fake.messages.find((item) => (item.message as { customType?: string }).customType === "pi-chalin-direct-progress-nudge");
  assert.match((progress?.message as { content?: string }).content ?? "", /Docs changed/i);
  assert.match((progress?.message as { content?: string }).content ?? "", /do not run find\/grep\/bash after the write/i);
  assert.match((progress?.message as { content?: string }).content ?? "", /searched\/not-found/i);

  const ready = fake.messages.find((item) => (item.message as { customType?: string }).customType === "pi-chalin-direct-ready-to-verify-nudge");
  assert.match((ready?.message as { content?: string }).content ?? "", /Read updated docs/i);

  toolExecutionEnd({ toolName: "bash", isError: false, args: { command: "cargo test" } }, ctx);
  assert.equal(fake.messages.filter((item) => (item.message as { customType?: string }).customType === "pi-chalin-direct-completion-nudge").length, 0, "post-write shell is not valid docs-only verification");
  assert.equal(fake.messages.filter((item) => (item.message as { customType?: string }).customType === "pi-chalin-docs-only-shell-nudge").length, 2, "post-write shell gets a second docs-only correction");

  toolExecutionEnd({ toolName: "read", isError: false, args: { path: "docs/plan.md" } }, ctx);
  const completion = fake.messages.find((item) => (item.message as { customType?: string }).customType === "pi-chalin-direct-completion-nudge");
  assert.match((completion?.message as { content?: string }).content ?? "", /verified them with `read docs\/plan\.md`/i);
  assert.match((completion?.message as { content?: string }).content ?? "", /substantive artifact fields/i);
  assert.doesNotMatch((completion?.message as { content?: string }).content ?? "", /Checklist: requested API\/tests\/docs\/metadata/i);
  assert.doesNotMatch((completion?.message as { content?: string }).content ?? "", /escape hatches.*warning suppression/i);
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

test("finalAnswerMaterial preserves single scout analysis instead of compact handoff", () => {
  const run = createRunState({
    kind: "single-agent",
    agents: ["scout"],
    risk: "low",
    ambiguity: "low",
    needsMemory: false,
    needsArtifacts: false,
    reason: "Deep project analysis.",
    plan: { kind: "single", agent: "scout", task: "Analyze project.", budget: "deep" },
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
  assert.match(lines.join("\n"), /budget: stopped max_tool_calls 3\/2 via read \(1 stops\)/);
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
