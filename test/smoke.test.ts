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
  assert.match(promptResult?.message?.customType === "pi-chalin-orchestration" ? JSON.stringify(promptResult.message) : "", /package runner coherence/i);
  assert.match(promptResult?.message?.customType === "pi-chalin-orchestration" ? JSON.stringify(promptResult.message) : "", /Evidence lock/i);
  assert.match(promptResult?.message?.customType === "pi-chalin-orchestration" ? JSON.stringify(promptResult.message) : "", /searched\/not-found/i);
  assert.doesNotMatch(promptResult?.message?.customType === "pi-chalin-orchestration" ? JSON.stringify(promptResult.message) : "", /dependency-free TypeScript/i);
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

test("compact global orchestration requires routing for broad analysis and keeps direct work cost-aware", async () => {
  const fake = createFakePi();
  registerPiChalin(fake.api as never);
  const beforeAgentStart = fake.handlers.get("before_agent_start")?.[0] as (event: unknown, ctx: unknown) => Promise<{ systemPrompt?: string; message?: { customType?: string; content?: string; display?: boolean } } | undefined>;

  const promptResult = await beforeAgentStart({
    type: "before_agent_start",
    prompt: "revisa este proyecto en profundidad y compara opciones de mejora de arquitectura",
    systemPrompt: "base",
    systemPromptOptions: {},
  }, {
    cwd: tempDir("pi-chalin-compact-global-"),
    hasUI: false,
    model: undefined,
    modelRegistry: { getAvailable: () => [] },
  });

  assert.equal(promptResult?.message?.customType, "pi-chalin-compact-orchestration");
  assert.match(promptResult?.systemPrompt ?? "", /^base/);
  assert.match(promptResult?.systemPrompt ?? "", /pi-chalin orchestration \(compact\)/i);
  assert.match(promptResult?.message?.content ?? "", /Call `chalin_route` as the first tool/i);
  assert.match(promptResult?.message?.content ?? "", /bounded read-only mini-project reviews that explicitly forbid file changes stay native/i);
  assert.match(promptResult?.message?.content ?? "", /risk\/security\/auth boundaries/i);
  assert.match(promptResult?.message?.content ?? "", /Bounded read-only auth\/security review/i);
  assert.match(promptResult?.message?.content ?? "", /avoid repeated ls\/find after source hits/i);
  assert.match(promptResult?.message?.content ?? "", /exploit\/request path or bypass chain/i);
  assert.match(promptResult?.message?.content ?? "", /project understanding/i);
  assert.match(promptResult?.message?.content ?? "", /project\/service structure with entrypoints or testing map/i);
  assert.match(promptResult?.message?.content ?? "", /deep project analysis/i);
  assert.match(promptResult?.message?.content ?? "", /independent option comparison/i);
  assert.match(promptResult?.message?.content ?? "", /explicit memory recall\/remembrance/i);
  assert.match(promptResult?.message?.content ?? "", /Spanish prompts like recuerda\/recordar\/memoria\/decidimos/i);
  assert.match(promptResult?.message?.content ?? "", /chalin_memory_search/i);
  assert.match(promptResult?.message?.content ?? "", /mode=list/i);
  assert.match(promptResult?.message?.content ?? "", /auth\/security\/token\/session behavior with tests/i);
  assert.match(promptResult?.message?.content ?? "", /choose topology deliberately from the prompt, agent roster, and evidence/i);
  assert.match(promptResult?.message?.content ?? "", /smallest workflow that can prove the result/i);
  assert.match(promptResult?.message?.content ?? "", /add discovery, planning, parallelism, or synthesis only when/i);
  assert.match(promptResult?.message?.content ?? "", /Do not route plain memory recall\/inventory/i);
  assert.match(promptResult?.message?.content ?? "", /Routed implementation\/file mutation must include worker execution plus a later reviewer/i);
  assert.match(promptResult?.message?.content ?? "", /reviewer FAIL\/GAP requires focused repair/i);
  assert.match(promptResult?.message?.content ?? "", /Bounded greenfield\/scaffold efficiency/i);
  assert.match(promptResult?.message?.content ?? "", /repeated bash without an intervening edit is invalid/i);
  assert.match(promptResult?.message?.content ?? "", /explicitly asks for direct\/native\/no-subagent work/i);
  assert.match(promptResult?.message?.content ?? "", /starter test imports win over function names/i);
  assert.match(promptResult?.message?.content ?? "", /parallel-module bug/i);
  assert.match(promptResult?.message?.content ?? "", /first mutation before source\/test surface evidence is invalid/i);
  assert.match(promptResult?.message?.content ?? "", /Parser\/scanner\/tokenizer direct work/i);
  assert.match(promptResult?.message?.content ?? "", /doubled single quotes/i);
  assert.match(promptResult?.message?.content ?? "", /Quality-equivalent bounded direct work/i);
  assert.match(promptResult?.message?.content ?? "", /lower cost\/time\/tool count/i);
  assert.match(promptResult?.message?.content ?? "", /node --test\/\.cjs uses require\('node:test'\) plus node:assert/i);
  assert.match(promptResult?.message?.content ?? "", /README\/API\/usage docs/i);
  assert.match(promptResult?.message?.content ?? "", /Predicate guards: cover each condition branch\/value class/i);
  assert.match(promptResult?.message?.content ?? "", /Domain-practical coverage means success plus distinct failure\/edge classes/i);
  assert.match(promptResult?.message?.content ?? "", /Canonical surface discipline/i);
  assert.match(promptResult?.message?.content ?? "", /do not create parallel modules\/tests/i);
  assert.match(promptResult?.message?.content ?? "", /Prefer standard-library parsers\/serializers for known wire formats/i);
  assert.match(promptResult?.message?.content ?? "", /extra helper files must buy clear ownership\/testability/i);
  assert.match(promptResult?.message?.content ?? "", /CLI packages need `bin`, test script, runnable start\/run script/i);
  assert.match(promptResult?.message?.content ?? "", /`module` field is not a substitute for `type: module`/i);
  assert.match(promptResult?.message?.content ?? "", /Publishable TypeScript libraries need a build script\/tsconfig/i);
  assert.match(promptResult?.message?.content ?? "", /runtime type validation should use a public signature broad enough/i);
  assert.match(promptResult?.message?.content ?? "", /Normalization used for validation must feed returned output/i);
  assert.match(promptResult?.message?.content ?? "", /existing source stubs, starter tests, imports, and prompt paths define the acceptance surface/i);
  assert.match(promptResult?.message?.content ?? "", /python -m unittest discover -s tests/i);
  assert.match(promptResult?.message?.content ?? "", /Normalized validation computes trimmed\/casefolded locals before regex\/type-domain checks/i);
  assert.match(promptResult?.message?.content ?? "", /Request\/API validators cover body missing\/null\/array/i);
  assert.match(promptResult?.message?.content ?? "", /explicit domain bounds such as 1-based, positive, max, cap, or finite/i);
  assert.match(promptResult?.message?.content ?? "", /Scaffold test-path symmetry/i);
  assert.match(promptResult?.message?.content ?? "", /Broken-test triage is not coverage expansion/i);
  assert.match(promptResult?.message?.content ?? "", /Final quality/i);
  assert.match(promptResult?.message?.content ?? "", /answer in the user's language/i);
});

test("bounded read-only auth reviews use a tiny native steering prompt", async () => {
  const fake = createFakePi();
  registerPiChalin(fake.api as never);
  const beforeAgentStart = fake.handlers.get("before_agent_start")?.[0] as (event: unknown, ctx: unknown) => Promise<{ message?: { customType?: string; content?: string; display?: boolean } } | undefined>;

  const promptResult = await beforeAgentStart({
    type: "before_agent_start",
    prompt: "Revisa este mini proyecto y dime si hay riesgo de seguridad en el boundary de auth. No modifiques archivos; entrega evidencia con paths concretos.",
    systemPrompt: "base",
    systemPromptOptions: {},
  }, {
    cwd: tempDir("pi-chalin-review-compact-"),
    hasUI: false,
    model: undefined,
    modelRegistry: { getAvailable: () => [] },
  });

  assert.equal(promptResult?.message?.customType, "pi-chalin-review-compact-orchestration");
  assert.match(promptResult?.message?.content ?? "", /compact bounded read-only review/i);
  assert.match(promptResult?.message?.content ?? "", /smallest manifest\/source evidence/i);
  assert.match(promptResult?.message?.content ?? "", /Do not start with chalin_project_discovery, chalin_project_snapshot, or chalin_route/i);
  assert.match(promptResult?.message?.content ?? "", /broad\/project-wide uncertainty/i);
  assert.match(promptResult?.message?.content ?? "", /direct auth\/session\/caller candidates/i);
  assert.match(promptResult?.message?.content ?? "", /one targeted find for auth, session, authorization, middleware, or caller surfaces/i);
  assert.match(promptResult?.message?.content ?? "", /No mutation, no bash, no tests\/docs/i);
  assert.match(promptResult?.message?.content ?? "", /Prioritize trust boundaries/i);
  assert.match(promptResult?.message?.content ?? "", /identity source/i);
  assert.match(promptResult?.message?.content ?? "", /authorization\/permission checks/i);
  assert.match(promptResult?.message?.content ?? "", /identity\/token input validation/i);
  assert.match(promptResult?.message?.content ?? "", /misleading guard APIs/i);
  assert.match(promptResult?.message?.content ?? "", /one verdict sentence using `riesgo de seguridad` or `security risk`/i);
  assert.match(promptResult?.message?.content ?? "", /one concrete exploit\/request path or bypass chain/i);
  assert.match(promptResult?.message?.content ?? "", /2-4 tight bullets/i);
  assert.match(promptResult?.message?.content ?? "", /no tables, no project tree, no code fences/i);
  assert.match(promptResult?.message?.content ?? "", /Include the boundary and caller paths when evidenced/i);
  assert.doesNotMatch(promptResult?.message?.content ?? "", /src\/auth\.ts|src\/server\.ts/i);
  assert.doesNotMatch(promptResult?.message?.content ?? "", /Bounded greenfield\/scaffold efficiency/i);
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
  const agentEnd = fake.handlers.get("agent_end")?.[0] as (event: unknown, ctx: unknown) => void;
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
  assert.match(promptResult?.message?.content ?? "", /Scaffold\/API/i);
  assert.match(promptResult?.message?.content ?? "", /exact files\/APIs/i);
  assert.match(promptResult?.message?.content ?? "", /current workspace root/i);
  assert.match(promptResult?.message?.content ?? "", /No pre-edit shell\/discovery or environment probes/i);
  assert.match(promptResult?.message?.content ?? "", /`which bun`\/`node`\/`npx`/i);
  assert.match(promptResult?.message?.content ?? "", /relative paths/i);
  assert.match(promptResult?.message?.content ?? "", /after the last requested mutation/i);
  assert.match(promptResult?.message?.content ?? "", /package\/bin\/config metadata/i);
  assert.match(promptResult?.message?.content ?? "", /module format metadata/i);
  assert.match(promptResult?.message?.content ?? "", /Source syntax and package metadata must agree/i);
  assert.match(promptResult?.message?.content ?? "", /language\/toolchain, and runner agree/i);
  assert.match(promptResult?.message?.content ?? "", /runner-discoverable cases/i);
  assert.match(promptResult?.message?.content ?? "", /preserve explicit requested test path\/glob\/extension/i);
  assert.match(promptResult?.message?.content ?? "", /mirror it with `test\/<entry>\.test\.\*`/i);
  assert.match(promptResult?.message?.content ?? "", /no fake builds/i);
  assert.doesNotMatch(promptResult?.message?.content ?? "", /compact TypeScript library scaffold path|prompt-named factory|Bun CLI|tsx/i);

  const tokenLibraryPrompt = await beforeAgentStart({
    type: "before_agent_start",
    prompt: "Crea una librería TypeScript pequeña readable-tokens con createToken(prefix, id), tests, package.json y README. Debe validar entradas vacías y devolver prefix-id en minúsculas.",
    systemPrompt: "base",
    systemPromptOptions: {},
  }, ctx);
  assert.equal(tokenLibraryPrompt?.message?.customType, "pi-chalin-path-compact-orchestration");
  assert.match(tokenLibraryPrompt?.message?.content ?? "", /Scaffold\/API/i);
  assert.match(tokenLibraryPrompt?.message?.content ?? "", /exact files\/APIs/i);
  assert.match(tokenLibraryPrompt?.message?.content ?? "", /Tests register runner-discoverable cases under root `test\/` or `tests\/`/i);
  assert.match(tokenLibraryPrompt?.message?.content ?? "", /do not put package tests in `src\/` or compiled publish output/i);
  assert.match(tokenLibraryPrompt?.message?.content ?? "", /requested public entrypoint as the API surface/i);
  assert.match(tokenLibraryPrompt?.message?.content ?? "", /minimal `tsconfig\.json`, build\/typecheck script/i);
  assert.match(tokenLibraryPrompt?.message?.content ?? "", /fields aligned to the generated surface/i);
  assert.match(tokenLibraryPrompt?.message?.content ?? "", /documented error surface/i);
  assert.match(tokenLibraryPrompt?.message?.content ?? "", /public signature broad enough for tested invalid inputs/i);
  assert.match(tokenLibraryPrompt?.message?.content ?? "", /trimmed locals feed returned\/composed output/i);
  assert.match(tokenLibraryPrompt?.message?.content ?? "", /cover one spaced-input output/i);
  assert.match(tokenLibraryPrompt?.message?.content ?? "", /package scripts use declared\/reproducible runners/i);
  assert.match(tokenLibraryPrompt?.message?.content ?? "", /no `npx`, experimental TS strip flags, or undeclared runner binaries/i);
  assert.match(tokenLibraryPrompt?.message?.content ?? "", /small custom errors help public validation APIs/i);
  assert.match(tokenLibraryPrompt?.message?.content ?? "", /No fake builds\/duplicate logic/i);
  assert.doesNotMatch(tokenLibraryPrompt?.message?.content ?? "", /createToken|TokenError|number overload|prefix`\/`id|compact TypeScript library scaffold path/i);

  const cliScaffoldPrompt = await beforeAgentStart({
    type: "before_agent_start",
    prompt: "Scaffoldea un CLI TypeScript mínimo llamado note-pack: package.json, src/cli.ts, README con uso, y test básico en test/cli.test.ts. Usa Bun para ejecutar el test TypeScript sin agregar frameworks de test externos. El comando debe aceptar un argumento de texto y devolverlo normalizado a minúsculas.",
    systemPrompt: "base",
    systemPromptOptions: {},
  }, ctx);
  assert.equal(cliScaffoldPrompt?.message?.customType, "pi-chalin-path-compact-orchestration");
  assert.match(cliScaffoldPrompt?.message?.content ?? "", /Scaffold\/API/i);
  assert.match(cliScaffoldPrompt?.message?.content ?? "", /ESM import\/export requires ESM package\/config/i);
  assert.match(cliScaffoldPrompt?.message?.content ?? "", /runnable start\/run script/i);
  assert.match(cliScaffoldPrompt?.message?.content ?? "", /not a substitute for `type: module`/i);
  assert.match(cliScaffoldPrompt?.message?.content ?? "", /Import-safe CLI modules are mandatory/i);
  assert.match(cliScaffoldPrompt?.message?.content ?? "", /guard process\.argv\/console\/process\.exit behind the runtime entrypoint check/i);
  assert.match(cliScaffoldPrompt?.message?.content ?? "", /import\.meta\.main/i);
  assert.match(cliScaffoldPrompt?.message?.content ?? "", /do not create a separate project in home/i);
  assert.match(cliScaffoldPrompt?.message?.content ?? "", /Write README\/docs before the first verification/i);
  assert.match(cliScaffoldPrompt?.message?.content ?? "", /Package bin targets must point to a delivered executable\/source file/i);
  assert.match(cliScaffoldPrompt?.message?.content ?? "", /extra helper files must buy clear ownership\/testability/i);
  assert.match(cliScaffoldPrompt?.message?.content ?? "", /must not broaden arbitrary behavior beyond the prompt/i);
  assert.match(cliScaffoldPrompt?.message?.content ?? "", /conventional config\/env string enums should trim\/casefold only prompt-named literals/i);
  assert.match(cliScaffoldPrompt?.message?.content ?? "", /CLI tests cover logic, real command path, exit status, stdout\/stderr, multi-word argument text, and no-input\/error behavior/i);
  assert.match(cliScaffoldPrompt?.message?.content ?? "", /process\.argv\.slice\(2\)\.join\(" "\)/i);
  assert.match(cliScaffoldPrompt?.message?.content ?? "", /mirror it with `test\/<entry>\.test\.\*`/i);
  assert.match(cliScaffoldPrompt?.message?.content ?? "", /do not run a separate post-test CLI smoke shell/i);
  assert.match(cliScaffoldPrompt?.message?.content ?? "", /Do not point bin at dist\/build output unless that artifact is generated and exercised/i);
  assert.doesNotMatch(cliScaffoldPrompt?.message?.content ?? "", /compact TypeScript CLI scaffold path|src\/normalize\.ts|bun test && bun src\/cli\.ts "HELLO"/i);

  const configScaffoldPrompt = await beforeAgentStart({
    type: "before_agent_start",
    prompt: "Scaffoldea una mini librería TypeScript de config: package.json, src/config.ts, tests y README. API esperada: loadConfig(env) devuelve { port, nodeEnv }, default port 3000, acepta development/test/production y rechaza ports inválidos. Sin dependencias externas.",
    systemPrompt: "base",
    systemPromptOptions: {},
  }, ctx);
  assert.equal(configScaffoldPrompt?.message?.customType, "pi-chalin-path-compact-orchestration");
  assert.match(configScaffoldPrompt?.message?.content ?? "", /Scaffold\/API/i);
  assert.match(configScaffoldPrompt?.message?.content ?? "", /API contract/i);
  assert.match(configScaffoldPrompt?.message?.content ?? "", /prompt-named exported functions, parameter names, examples, and return shape are acceptance criteria/i);
  assert.match(configScaffoldPrompt?.message?.content ?? "", /Write tests against that public shape before implementation choices/i);
  assert.match(configScaffoldPrompt?.message?.content ?? "", /dependency injection or helper seams may be additive/i);
  assert.match(configScaffoldPrompt?.message?.content ?? "", /must not replace or reinterpret the requested API/i);
  assert.match(configScaffoldPrompt?.message?.content ?? "", /API\/validation correctness outranks package finish/i);
  assert.match(configScaffoldPrompt?.message?.content ?? "", /do not drop source-map mode, overload\/union compatibility, or boundary validation to add build metadata/i);
  assert.match(configScaffoldPrompt?.message?.content ?? "", /support the conservative compatible union/i);
  assert.match(configScaffoldPrompt?.message?.content ?? "", /Keep README\/final centered on the requested public shape/i);
  assert.match(configScaffoldPrompt?.message?.content ?? "", /document alternate compatibility briefly/i);
  assert.match(configScaffoldPrompt?.message?.content ?? "", /Config\/env\/options APIs/i);
  assert.match(configScaffoldPrompt?.message?.content ?? "", /preserve prompt-named public parameter meaning/i);
  assert.match(configScaffoldPrompt?.message?.content ?? "", /do not silently retype a scalar\/domain parameter into a dependency map/i);
  assert.match(configScaffoldPrompt?.message?.content ?? "", /Put dependency injection in an `options`\/`source` object with a safe default empty object/i);
  assert.match(configScaffoldPrompt?.message?.content ?? "", /support both common meanings with overloads\/union/i);
  assert.match(configScaffoldPrompt?.message?.content ?? "", /keep the primary API simple in docs/i);
  assert.match(configScaffoldPrompt?.message?.content ?? "", /env name string and env-source map/i);
  assert.match(configScaffoldPrompt?.message?.content ?? "", /Source-map mode uses conventional `PORT`\/`NODE_ENV` keys as optional source keys/i);
  assert.match(configScaffoldPrompt?.message?.content ?? "", /do not make `NODE_ENV` required unless prompt\/repo evidence says required/i);
  assert.match(configScaffoldPrompt?.message?.content ?? "", /string-env mode injects PORT\/source through options/i);
  assert.match(configScaffoldPrompt?.message?.content ?? "", /Tests cover both env-source calls such as empty object\/defaults and string-env calls/i);
  assert.match(configScaffoldPrompt?.message?.content ?? "", /avoid reading global process state/i);
  assert.match(configScaffoldPrompt?.message?.content ?? "", /Package test scripts should discover the conventional test root\/glob/i);
  assert.match(configScaffoldPrompt?.message?.content ?? "", /instead of hard-coding only one visible test file/i);
  assert.match(configScaffoldPrompt?.message?.content ?? "", /Missing\/undefined config values may default independently/i);
  assert.match(configScaffoldPrompt?.message?.content ?? "", /absent `NODE_ENV` defaults to `development`/i);
  assert.match(configScaffoldPrompt?.message?.content ?? "", /absent `PORT` defaults to `3000`/i);
  assert.match(configScaffoldPrompt?.message?.content ?? "", /Do not read `process\.env` to fill missing values from an injected env object/i);
  assert.match(configScaffoldPrompt?.message?.content ?? "", /provided blank strings must pass through validation and fail/i);
  assert.match(configScaffoldPrompt?.message?.content ?? "", /plain object should return an immutable\/frozen config/i);
  assert.match(configScaffoldPrompt?.message?.content ?? "", /Finite validated string domains in TypeScript public APIs/i);
  assert.match(configScaffoldPrompt?.message?.content ?? "", /exported literal union types/i);
  assert.match(configScaffoldPrompt?.message?.content ?? "", /return canonical literals/i);
  assert.match(configScaffoldPrompt?.message?.content ?? "", /not plain `string`/i);
  assert.match(configScaffoldPrompt?.message?.content ?? "", /canonicalization or explicit exact-case policy/i);
  assert.match(configScaffoldPrompt?.message?.content ?? "", /trim\/casefold only prompt-named literals/i);
  assert.match(configScaffoldPrompt?.message?.content ?? "", /exact-case only when prompt\/repo evidence says case-sensitive/i);
  assert.match(configScaffoldPrompt?.message?.content ?? "", /Do not add aliases such as `dev`\/`prod` or short env names/i);
  assert.match(configScaffoldPrompt?.message?.content ?? "", /reject alias values in tests when the domain is finite/i);
  assert.match(configScaffoldPrompt?.message?.content ?? "", /Prefer zero-install native TS runners/i);
  assert.match(configScaffoldPrompt?.message?.content ?? "", /final in the user's language with 2-4 design decisions/i);
  assert.match(configScaffoldPrompt?.message?.content ?? "", /preserve explicit requested test path\/glob\/extension/i);
  assert.match(configScaffoldPrompt?.message?.content ?? "", /TypeScript library scaffolds with tests should deliver source tests such as `test\/<name>\.test\.ts`/i);
  assert.match(configScaffoldPrompt?.message?.content ?? "", /document package installation\/imports or expose `main`\/`types` should be publishable when it does not crowd out requested API\/validation/i);
  assert.match(configScaffoldPrompt?.message?.content ?? "", /use `src` source, `dist` main\/types, minimal `tsconfig\.json`, build\/typecheck script, and declared compiler devDependency/i);
  assert.match(configScaffoldPrompt?.message?.content ?? "", /unless the prompt explicitly asks for source-only\/no-build or no external tooling/i);
  assert.match(configScaffoldPrompt?.message?.content ?? "", /compiled or JS-only tests do not satisfy a TypeScript test artifact/i);
  assert.match(configScaffoldPrompt?.message?.content ?? "", /whole-string finite integer in 1\.\.65535/i);
  assert.match(configScaffoldPrompt?.message?.content ?? "", /reject 0, empty strings, whitespace-only values, leading\/trailing whitespace around digits, negatives, fractions, trailing text, `NaN`, and infinities/i);
  assert.match(configScaffoldPrompt?.message?.content ?? "", /do not use `parseInt` prefix parsing or trim before numeric validation/i);
  assert.match(configScaffoldPrompt?.message?.content ?? "", /compile `node:test`, `node:assert`, `process`, or other Node built-ins with `tsc`/i);
  assert.match(configScaffoldPrompt?.message?.content ?? "", /declare matching Node type metadata such as `@types\/node` before the first install\/test/i);
  assert.match(configScaffoldPrompt?.message?.content ?? "", /Dev-only type packages are not runtime dependencies/i);
  assert.doesNotMatch(configScaffoldPrompt?.message?.content ?? "", /compact TypeScript library scaffold path|present empty numeric config value is invalid|Do not write a defaulting test for an empty string/i);

  const rateLimitPrompt = await beforeAgentStart({
    type: "before_agent_start",
    prompt: "Implementa un rate limiter in-memory en src/rateLimit.ts con ventanas por key, límite configurable, reset por tiempo y tests.",
    systemPrompt: "base",
    systemPromptOptions: {},
  }, ctx);
  assert.equal(rateLimitPrompt?.message?.customType, "pi-chalin-path-compact-orchestration");
  assert.equal(rateLimitPrompt?.systemPrompt, "base");
  assert.match(rateLimitPrompt?.message?.content ?? "", /minimal bounded path/i);
  assert.match(rateLimitPrompt?.message?.content ?? "", /preserve public behavior/i);
  assert.match(rateLimitPrompt?.message?.content ?? "", /boundary\/counterexample/i);
  assert.match(rateLimitPrompt?.message?.content ?? "", /read `test\/rateLimit\.test\.ts` before search/i);
  assert.match(rateLimitPrompt?.message?.content ?? "", /copy primitive `limit`\/`windowMs` locals/i);
  assert.match(rateLimitPrompt?.message?.content ?? "", /Rate\/window limiters/i);
  assert.match(rateLimitPrompt?.message?.content ?? "", /explicit source\/test paths mean no ls\/find/i);
  assert.match(rateLimitPrompt?.message?.content ?? "", /finite positive integers inline or through a small shared helper/i);
  assert.match(rateLimitPrompt?.message?.content ?? "", /throw `RangeError`/i);
  assert.match(rateLimitPrompt?.message?.content ?? "", /8-10 visible named cases/i);
  assert.match(rateLimitPrompt?.message?.content ?? "", /allow\/block\/retryAfter/i);
  assert.match(rateLimitPrompt?.message?.content ?? "", /fractional limit\/windowMs/i);
  assert.match(rateLimitPrompt?.message?.content ?? "", /zero\/negative\/nonfinite/i);
  assert.match(rateLimitPrompt?.message?.content ?? "", /injected clock option\/closure/i);
  assert.match(rateLimitPrompt?.message?.content ?? "", /now\?: \(\) => number/i);
  assert.match(rateLimitPrompt?.message?.content ?? "", /over global `Date\.now` monkey-patching/i);
  assert.match(rateLimitPrompt?.message?.content ?? "", /never sleeps\/wall-clock/i);
  assert.match(rateLimitPrompt?.message?.content ?? "", /Manual reset only if prompt\/source\/tests say manual\/API reset/i);
  assert.match(rateLimitPrompt?.message?.content ?? "", /sin dependencias externas/i);
  assert.doesNotMatch(rateLimitPrompt?.message?.content ?? "", /Scaffold\/API/i);
  assert.doesNotMatch(rateLimitPrompt?.message?.content ?? "", /Collection\/key/i);
  assert.doesNotMatch(rateLimitPrompt?.message?.content ?? "", /Package bin targets must point/i);
  assert.doesNotMatch(rateLimitPrompt?.message?.content ?? "", /rate-limit config|non-integer config|integer limits\/windows/i);

  const webhookPrompt = await beforeAgentStart({
    type: "before_agent_start",
    prompt: "Implementa verifyWebhook en src/webhook.ts: HMAC sha256 sobre payload, timingSafeEqual, rechaza firma faltante/incorrecta. Añade tests con crypto stdlib.",
    systemPrompt: "base",
    systemPromptOptions: {},
  }, ctx);
  assert.equal(webhookPrompt?.message?.customType, "pi-chalin-path-compact-orchestration");
  assert.match(webhookPrompt?.message?.content ?? "", /Crypto\/webhook verification/i);
  assert.match(webhookPrompt?.message?.content ?? "", /missing, malformed\/non-hex, length-mismatch, well-formed-wrong, empty-payload, and tampered-payload signatures/i);
  assert.match(webhookPrompt?.message?.content ?? "", /decode received hex signatures to raw bytes/i);
  assert.match(webhookPrompt?.message?.content ?? "", /malformed\/non-hex/i);
  assert.match(webhookPrompt?.message?.content ?? "", /empty-payload/i);

  const middlewarePrompt = await beforeAgentStart({
    type: "before_agent_start",
    prompt: "Implementa un HTTP middleware en src/requestid.go que asigna request id, lo expone en header/context y añade tests con go test.",
    systemPrompt: "base",
    systemPromptOptions: {},
  }, ctx);
  assert.equal(middlewarePrompt?.message?.customType, "pi-chalin-path-compact-orchestration");
  assert.match(middlewarePrompt?.message?.content ?? "", /Auth\/middleware/i);
  assert.match(middlewarePrompt?.message?.content ?? "", /downstream handler\/next step/i);
  assert.match(middlewarePrompt?.message?.content ?? "", /generated request IDs or context values/i);
  assert.match(middlewarePrompt?.message?.content ?? "", /compact uniqueness sanity check/i);

  const errorMiddlewarePrompt = await beforeAgentStart({
    type: "before_agent_start",
    prompt: "Implementa error middleware estilo Koa en src/errorMiddleware.ts: catch errors, status/body, hide 500 y tests.",
    systemPrompt: "base",
    systemPromptOptions: {},
  }, ctx);
  assert.equal(errorMiddlewarePrompt?.message?.customType, "pi-chalin-path-compact-orchestration");
  assert.match(errorMiddlewarePrompt?.message?.content ?? "", /Error middleware/i);
  assert.match(errorMiddlewarePrompt?.message?.content ?? "", /catch as `unknown`/i);
  assert.match(errorMiddlewarePrompt?.message?.content ?? "", /type guards/i);
  assert.match(errorMiddlewarePrompt?.message?.content ?? "", /`expose=false`\/non-exposed client errors/i);
  assert.match(errorMiddlewarePrompt?.message?.content ?? "", /`status`\/`statusCode` fallbacks/i);

  const debouncerPrompt = await beforeAgentStart({
    type: "before_agent_start",
    prompt: "Implementa createDebouncer en src/debounce.ts con cancel, timer provider/fake clock y tests.",
    systemPrompt: "base",
    systemPromptOptions: {},
  }, ctx);
  assert.equal(debouncerPrompt?.message?.customType, "pi-chalin-path-compact-orchestration");
  assert.match(debouncerPrompt?.message?.content ?? "", /Debounce\/timer helpers/i);
  assert.match(debouncerPrompt?.message?.content ?? "", /reset\/reschedule/i);
  assert.match(debouncerPrompt?.message?.content ?? "", /call-after-cancel scheduling a fresh invocation/i);
  assert.match(debouncerPrompt?.message?.content ?? "", /argument preservation/i);

  const featureFlagPrompt = await beforeAgentStart({
    type: "before_agent_start",
    prompt: "Implementa evaluateFlag en src/flags.ts: default value, boolean rules por userId allowlist y percentage rollout determinístico. Añade tests, sin dependencias.",
    systemPrompt: "base",
    systemPromptOptions: {},
  }, ctx);
  assert.equal(featureFlagPrompt?.message?.customType, "pi-chalin-path-compact-orchestration");
  assert.match(featureFlagPrompt?.message?.content ?? "", /Feature flags\/rollouts/i);
  assert.match(featureFlagPrompt?.message?.content ?? "", /Use flag key\/salt only when prompt or starter API exposes one/i);
  assert.match(featureFlagPrompt?.message?.content ?? "", /do not add a required unrequested key field/i);
  assert.match(featureFlagPrompt?.message?.content ?? "", /runner-discovered path, not a skipped root duplicate/i);
  assert.match(featureFlagPrompt?.message?.content ?? "", /ordered rule entries/i);
  assert.match(featureFlagPrompt?.message?.content ?? "", /rule ordering\/short-circuit/i);

  const retryPrompt = await beforeAgentStart({
    type: "before_agent_start",
    prompt: "Implementa retry.Backoff(attempt, base, max) en Go: exponential backoff capped, attempt empieza en 1, sin sleep real ni dependencias. Añade tests.",
    systemPrompt: "base",
    systemPromptOptions: {},
  }, ctx);
  assert.equal(retryPrompt?.message?.customType, "pi-chalin-compact-orchestration");
  assert.match(retryPrompt?.message?.content ?? "", /Retry\/backoff/i);
  assert.match(retryPrompt?.message?.content ?? "", /attempt==max vs attempt>max/i);
  assert.match(retryPrompt?.message?.content ?? "", /max-attempts=1/i);
  assert.match(retryPrompt?.message?.content ?? "", /non-transient\/permanent failures with attempts remaining/i);
  assert.match(retryPrompt?.message?.content ?? "", /invalid attempt\/base\/max domains/i);

  const paginationPrompt = await beforeAgentStart({
    type: "before_agent_start",
    prompt: "Hay un helper de paginación incompleto. Completa paginator.py con page 1-based, errores claros y tests de bordes.",
    systemPrompt: "base",
    systemPromptOptions: {},
  }, ctx);
  assert.equal(paginationPrompt?.message?.customType, "pi-chalin-path-compact-orchestration");
  assert.match(paginationPrompt?.message?.content ?? "", /First-action invariant/i);
  assert.match(paginationPrompt?.message?.content ?? "", /first `write` before evidence creates parallel surfaces/i);
  assert.match(paginationPrompt?.message?.content ?? "", /Pagination helpers/i);
  assert.match(paginationPrompt?.message?.content ?? "", /do not create a sibling paginate\/paginator module pair/i);
  assert.match(paginationPrompt?.message?.content ?? "", /numeric strings and integer-equivalent numeric values/i);
  assert.match(paginationPrompt?.message?.content ?? "", /invalid argument\/domain errors separate from out-of-range empty-page errors/i);
  assert.match(paginationPrompt?.message?.content ?? "", /numeric coercion compatibility/i);
  assert.match(paginationPrompt?.message?.content ?? "", /large collection\/sample-volume case/i);
  assert.match(paginationPrompt?.message?.content ?? "", /empty-collection total_pages policy explicit/i);

  const queryParserPrompt = await beforeAgentStart({
    type: "before_agent_start",
    prompt: "Corrige parse_query(query) en request_parser.py inspirado en Flask request.args: soporta URL querystring, valores repetidos como lista y decode percent-encoding. Añade unittest.",
    systemPrompt: "base",
    systemPromptOptions: {},
  }, ctx);
  assert.equal(queryParserPrompt?.message?.customType, "pi-chalin-path-compact-orchestration");
  assert.match(queryParserPrompt?.message?.content ?? "", /Query parsers/i);
  assert.match(queryParserPrompt?.message?.content ?? "", /prefer the language stdlib query parser/i);
  assert.match(queryParserPrompt?.message?.content ?? "", /urllib\.parse\.parse_qs/i);

  const apiPrompt = await beforeAgentStart({
    type: "before_agent_start",
    prompt: "Corrige src/api/createUser.ts estilo Next API route: validate email y name, devuelve 400 con error para payload inválido y 201 con user normalizado. Añade tests sin instalar Next.",
    systemPrompt: "base",
    systemPromptOptions: {},
  }, ctx);
  assert.equal(apiPrompt?.message?.customType, "pi-chalin-path-compact-orchestration");
  assert.match(apiPrompt?.message?.content ?? "", /HTTP\/API payload validation/i);
  assert.match(apiPrompt?.message?.content ?? "", /canonical runner-discovered test path, not a sibling or nested parallel test/i);
  assert.match(apiPrompt?.message?.content ?? "", /Keep the package\/existing runner and assertion API/i);
  assert.match(apiPrompt?.message?.content ?? "", /Check body object-ness with a small type guard before destructuring/i);
  assert.match(apiPrompt?.message?.content ?? "", /Preserve the prompt\/starter error surface/i);
  assert.match(apiPrompt?.message?.content ?? "", /whole-string finite pattern, not `includes`\/substring checks/i);
  assert.match(apiPrompt?.message?.content ?? "", /no-at, no-dot-after-at, whitespace, and malformed tiny strings/i);
  assert.match(apiPrompt?.message?.content ?? "", /singular `error`/i);
  assert.match(apiPrompt?.message?.content ?? "", /status-discriminated response union/i);
  assert.match(apiPrompt?.message?.content ?? "", /narrow on `status` before reading body fields/i);
  assert.match(apiPrompt?.message?.content ?? "", /return it under that noun/i);

  const lruPrompt = await beforeAgentStart({
    type: "before_agent_start",
    prompt: "Implementa lru.Cache con Get/Set y capacidad fija. Debe evictar least-recently-used al superar capacidad, actualizar existing keys y tener tests. Sin dependencias.",
    systemPrompt: "base",
    systemPromptOptions: {},
  }, ctx);
  assert.equal(lruPrompt?.message?.customType, "pi-chalin-compact-orchestration");
  assert.match(lruPrompt?.message?.content ?? "", /Bounded caches\/LRU/i);
  assert.match(lruPrompt?.message?.content ?? "", /existing-key Set update that promotes without growth/i);
  assert.match(lruPrompt?.message?.content ?? "", /multiple consecutive evictions/i);

  const brokenTestPrompt = await beforeAgentStart({
    type: "before_agent_start",
    prompt: "El test está fallando. Encuentra la causa raíz en src/normalizeEmail.ts, corrígela y deja bun test pasando. No cambies el test para ocultar el bug.",
    systemPrompt: "base",
    systemPromptOptions: {},
  }, ctx);
  assert.equal(brokenTestPrompt?.message?.customType, "pi-chalin-path-compact-orchestration");
  assert.match(brokenTestPrompt?.message?.content ?? "", /compact broken-test triage path/i);
  assert.match(brokenTestPrompt?.message?.content ?? "", /The existing failing test is the contract/i);
  assert.match(brokenTestPrompt?.message?.content ?? "", /Direct test candidate: `test\/normalizeEmail\.test\.ts`/i);
  assert.match(brokenTestPrompt?.message?.content ?? "", /Edit source only/i);
  assert.match(brokenTestPrompt?.message?.content ?? "", /Do not add, rewrite, broaden, skip, or weaken tests/i);
  assert.match(brokenTestPrompt?.message?.content ?? "", /Do not add preservation\/no-op tests/i);
  assert.match(brokenTestPrompt?.message?.content ?? "", /same failing command or direct nearest test/i);

  const pricingPrompt = await beforeAgentStart({
    type: "before_agent_start",
    prompt: "Refactoriza src/pricing.ts para extraer funciones puras pequeñas, mantener el API calculateInvoice igual, y añade/actualiza tests relevantes.",
    systemPrompt: "base",
    systemPromptOptions: {},
  }, ctx);
  assert.equal(pricingPrompt?.message?.customType, "pi-chalin-path-compact-orchestration");
  assert.match(pricingPrompt?.message?.content ?? "", /minimal bounded path/i);
  assert.match(pricingPrompt?.message?.content ?? "", /Prompt path: `src\/pricing\.ts`/i);
  assert.match(pricingPrompt?.message?.content ?? "", /No pre-edit bash\/test unless existing tests already fail/i);
  assert.match(pricingPrompt?.message?.content ?? "", /preserve public behavior/i);
  assert.match(pricingPrompt?.message?.content ?? "", /assert changed behavior, one boundary\/counterexample, and one no-op\/preservation path/i);
  assert.match(pricingPrompt?.message?.content ?? "", /Refactors with tests preserve public API behavior/i);
  assert.match(pricingPrompt?.message?.content ?? "", /existing branches\/defaults\/formulas\/formatting/i);
  assert.match(pricingPrompt?.message?.content ?? "", /source-of-truth types/i);
  assert.match(pricingPrompt?.message?.content ?? "", /source-of-truth return types\/interfaces/i);
  assert.match(pricingPrompt?.message?.content ?? "", /broad casts, duplicate type definitions, or object-bag typing/i);
  assert.match(pricingPrompt?.message?.content ?? "", /extracted pure helpers/i);
  assert.match(pricingPrompt?.message?.content ?? "", /atomic per-entry\/per-step total helper/i);
  assert.match(pricingPrompt?.message?.content ?? "", /optional\/default inputs/i);
  assert.match(pricingPrompt?.message?.content ?? "", /helper owns that default/i);
  assert.match(pricingPrompt?.message?.content ?? "", /short responsibility comment/i);
  assert.match(pricingPrompt?.message?.content ?? "", /zero\/one\/many/i);
  assert.match(pricingPrompt?.message?.content ?? "", /composed public-API case/i);
  assert.match(pricingPrompt?.message?.content ?? "", /equivalence classes/i);
  assert.match(pricingPrompt?.message?.content ?? "", /neutral\/default value/i);
  assert.match(pricingPrompt?.message?.content ?? "", /meaningful extreme\/ceiling\/floor value/i);
  assert.match(pricingPrompt?.message?.content ?? "", /empty\/one\/many collection sizes/i);
  assert.match(pricingPrompt?.message?.content ?? "", /zero-value and zero-rate cases/i);
  assert.match(pricingPrompt?.message?.content ?? "", /Per-entry formula helpers should get direct zero-value and fractional-rate coverage/i);
  assert.match(pricingPrompt?.message?.content ?? "", /object-shaped public results should keep an explicit return type\/interface/i);
  assert.match(pricingPrompt?.message?.content ?? "", /rate, percentage, or value input/i);
  assert.match(pricingPrompt?.message?.content ?? "", /omitted\/undefined default and explicit zero/i);
  assert.match(pricingPrompt?.message?.content ?? "", /do not collapse all zero\/default behavior into one public smoke test/i);
  assert.match(pricingPrompt?.message?.content ?? "", /fractional values\/rates that force rounding/i);
  assert.match(pricingPrompt?.message?.content ?? "", /composed public-API proof/i);
  assert.match(pricingPrompt?.message?.content ?? "", /non-integer or threshold case/i);
  assert.match(pricingPrompt?.message?.content ?? "", /order-sensitive intermediates/i);
  assert.match(pricingPrompt?.message?.content ?? "", /approval-style API-level/i);
  assert.match(pricingPrompt?.message?.content ?? "", /API-level multi-input\/default\/rounding coverage/i);
  assert.doesNotMatch(pricingPrompt?.message?.content ?? "", /money-calculation|line amount|subtotal|discount|tax|100%|12\.5\/7\.25/i);

  const safeDividePrompt = await beforeAgentStart({
    type: "before_agent_start",
    prompt: "Añade un test unitario que cubra división por cero en src/safeDivide.ts. Si el comportamiento ya existe, no refactorices de más.",
    systemPrompt: "base",
    systemPromptOptions: {},
  }, ctx);
  assert.equal(safeDividePrompt?.message?.customType, "pi-chalin-path-compact-orchestration");
  assert.match(safeDividePrompt?.message?.content ?? "", /compact test-only path/i);
  assert.match(safeDividePrompt?.message?.content ?? "", /Prompt path: `src\/safeDivide\.ts`/i);
  assert.match(safeDividePrompt?.message?.content ?? "", /Read source once, then read or create nearest test `test\/safeDivide\.test\.ts`/i);
  assert.match(safeDividePrompt?.message?.content ?? "", /If source already has the requested behavior, do not refactor or edit source/i);
  assert.match(safeDividePrompt?.message?.content ?? "", /if an existing test already covers normal behavior, do not add another preservation case/i);
  assert.match(safeDividePrompt?.message?.content ?? "", /Singular\/unit-test request means one focused test change/i);
  assert.match(safeDividePrompt?.message?.content ?? "", /split semantically distinct guard branches into separate named test blocks/i);
  assert.match(safeDividePrompt?.message?.content ?? "", /compound guards\/predicates/i);
  assert.match(safeDividePrompt?.message?.content ?? "", /each condition branch and representative value class/i);
  assert.match(safeDividePrompt?.message?.content ?? "", /do not add alternate samples of the same class/i);
  assert.match(safeDividePrompt?.message?.content ?? "", /JS\/TS safe division or ratio tests/i);
  assert.match(safeDividePrompt?.message?.content ?? "", /include `-0` as a named zero-denominator assertion/i);
  assert.match(safeDividePrompt?.message?.content ?? "", /raw division by `-0` produces `-Infinity`/i);
  assert.match(safeDividePrompt?.message?.content ?? "", /if the guard explicitly uses finite-number policy such as `Number\.isFinite`/i);
  assert.match(safeDividePrompt?.message?.content ?? "", /add one compact non-finite denominator test block/i);
  assert.match(safeDividePrompt?.message?.content ?? "", /otherwise do not add NaN\/Infinity matrices/i);
  assert.match(safeDividePrompt?.message?.content ?? "", /Do not use bash\/cat to discover test files/i);
  assert.match(safeDividePrompt?.message?.content ?? "", /No ls\/find\/grep\/package\/config/i);
  assert.match(safeDividePrompt?.message?.content ?? "", /final in the user's language with exactly 3 bullets/i);
  assert.doesNotMatch(safeDividePrompt?.message?.content ?? "", /numeric test-only|denominator `0`|NaN, \+Infinity|safe arithmetic|missing behavior assertion/i);

  const pyUnitPrompt = await beforeAgentStart({
    type: "before_agent_start",
    prompt: "En Python, implementa parse_date en src/dateutil.py y cubre el caso invalido con unittest.",
    systemPrompt: "base",
    systemPromptOptions: {},
  }, ctx);
  assert.equal(pyUnitPrompt?.message?.customType, "pi-chalin-path-compact-orchestration");
  assert.match(pyUnitPrompt?.message?.content ?? "", /minimal bounded path/i);
  assert.match(pyUnitPrompt?.message?.content ?? "", /Python unittest: after target read/i);
  assert.match(pyUnitPrompt?.message?.content ?? "", /update `tests\/test_<stem>\.py` and run `python -m unittest discover -s tests`/i);
  assert.match(pyUnitPrompt?.message?.content ?? "", /use root `test_<stem>\.py` only when no tests root exists/i);
  assert.match(pyUnitPrompt?.message?.content ?? "", /no source-module rename from the function name/i);
  assert.match(pyUnitPrompt?.message?.content ?? "", /No pre-edit bash/i);
  assert.match(pyUnitPrompt?.message?.content ?? "", /edit source\+tests before the first verification/i);
  assert.match(pyUnitPrompt?.message?.content ?? "", /ls\/find\/config unless the target read fails/i);
  assert.match(pyUnitPrompt?.message?.content ?? "", /Large\/partial edit/i);
  assert.match(pyUnitPrompt?.message?.content ?? "", /tiny stubs replace once/i);
  assert.match(pyUnitPrompt?.message?.content ?? "", /Date\/format parsers/i);
  assert.match(pyUnitPrompt?.message?.content ?? "", /one single-line regex\/match capture/i);
  assert.match(pyUnitPrompt?.message?.content ?? "", /no newline inside regex/i);
  assert.match(pyUnitPrompt?.message?.content ?? "", /native UTC full component round-trip preferred/i);
  assert.match(pyUnitPrompt?.message?.content ?? "", /never use timestamp sign or day-only checks/i);
  assert.match(pyUnitPrompt?.message?.content ?? "", /no manual leap tables\/fallback parsing/i);
  assert.match(pyUnitPrompt?.message?.content ?? "", /Use 10-12 visible tests\/cases/i);
  assert.match(pyUnitPrompt?.message?.content ?? "", /valid normal date/i);
  assert.match(pyUnitPrompt?.message?.content ?? "", /valid pre-1970 date/i);
  assert.match(pyUnitPrompt?.message?.content ?? "", /invalid 30-day month/i);
  assert.match(pyUnitPrompt?.message?.content ?? "", /February overflow or non-leap day/i);
  assert.match(pyUnitPrompt?.message?.content ?? "", /month `00`\/`13`/i);
  assert.match(pyUnitPrompt?.message?.content ?? "", /leading\/trailing spaces rejected/i);
  assert.match(pyUnitPrompt?.message?.content ?? "", /ISO datetime\/trailing data rejected/i);
  assert.match(pyUnitPrompt?.message?.content ?? "", /empty\/non-date text/i);
  assert.match(pyUnitPrompt?.message?.content ?? "", /missing zero padding/i);
  assert.match(pyUnitPrompt?.message?.content ?? "", /do not assert UTC hours\/min\/sec/i);
  assert.match(pyUnitPrompt?.message?.content ?? "", /avoid broad calendar matrices/i);

  const datePrompt = await beforeAgentStart({
    type: "before_agent_start",
    prompt: "Corrige src/parseDate.ts para validar fechas YYYY-MM-DD con calendario real y añade tests bun test.",
    systemPrompt: "base",
    systemPromptOptions: {},
  }, ctx);
  assert.equal(datePrompt?.message?.customType, "pi-chalin-path-compact-orchestration");
  assert.match(datePrompt?.message?.content ?? "", /minimal bounded path/i);
  assert.match(datePrompt?.message?.content ?? "", /Date\/format parsers/i);
  assert.match(datePrompt?.message?.content ?? "", /one single-line regex\/match capture/i);
  assert.match(datePrompt?.message?.content ?? "", /native UTC full component round-trip preferred/i);
  assert.match(datePrompt?.message?.content ?? "", /never use timestamp sign or day-only checks/i);
  assert.match(datePrompt?.message?.content ?? "", /No manual leap tables\/fallback parsing/i);
  assert.match(datePrompt?.message?.content ?? "", /Use 10-12 visible tests\/cases/i);
  assert.match(datePrompt?.message?.content ?? "", /valid normal date/i);
  assert.match(datePrompt?.message?.content ?? "", /leap day/i);
  assert.match(datePrompt?.message?.content ?? "", /valid pre-1970 date/i);
  assert.match(datePrompt?.message?.content ?? "", /invalid 30-day month/i);
  assert.match(datePrompt?.message?.content ?? "", /February overflow or non-leap day/i);
  assert.match(datePrompt?.message?.content ?? "", /day `00`\/`32`/i);
  assert.match(datePrompt?.message?.content ?? "", /leading\/trailing spaces rejected/i);
  assert.match(datePrompt?.message?.content ?? "", /ISO datetime\/trailing data rejected/i);
  assert.match(datePrompt?.message?.content ?? "", /missing zero padding/i);
  assert.doesNotMatch(datePrompt?.message?.content ?? "", /tiny date-parser|`utc >= 0`/i);

  const delimiterPrompt = await beforeAgentStart({
    type: "before_agent_start",
    prompt: "Corrige lib/parseFlags.cjs para soportar --name=value y flags booleanas. Añade tests CommonJS.",
    systemPrompt: "base",
    systemPromptOptions: {},
  }, ctx);
  assert.equal(delimiterPrompt?.message?.customType, "pi-chalin-path-compact-orchestration");
  assert.match(delimiterPrompt?.message?.content ?? "", /minimal bounded path/i);
  assert.match(delimiterPrompt?.message?.content ?? "", /CommonJS\/CJS/i);
  assert.match(delimiterPrompt?.message?.content ?? "", /never `bun:test`/i);
  assert.match(delimiterPrompt?.message?.content ?? "", /If source\+test paths are known, no package\/config read before first edit/i);
  assert.match(delimiterPrompt?.message?.content ?? "", /Tiny source\/tests may be replaced once/i);
  assert.match(delimiterPrompt?.message?.content ?? "", /first-index\/slice/i);
  assert.match(delimiterPrompt?.message?.content ?? "", /embedded `=`/i);
  assert.match(delimiterPrompt?.message?.content ?? "", /bare boolean flags/i);
  assert.match(delimiterPrompt?.message?.content ?? "", /bare `--` as the standard end-of-options terminator/i);
  assert.match(delimiterPrompt?.message?.content ?? "", /empty value/i);
  assert.match(delimiterPrompt?.message?.content ?? "", /realistic mixed argv/i);
  assert.match(delimiterPrompt?.message?.content ?? "", /single-dash ignore/i);
  assert.match(delimiterPrompt?.message?.content ?? "", /duplicate-key policy/i);
  assert.match(delimiterPrompt?.message?.content ?? "", /unless prompt\/docs\/tests require/i);
  assert.doesNotMatch(delimiterPrompt?.message?.content ?? "", /tiny CJS delimiter|Low-entropy CJS parser fix|no `flags\[""\]`/i);

  const regexPrompt = await beforeAgentStart({
    type: "before_agent_start",
    prompt: "En Python, implementa slug normalizer en src/slug.py con tests unittest para espacios y puntuacion.",
    systemPrompt: "base",
    systemPromptOptions: {},
  }, ctx);
  assert.equal(regexPrompt?.message?.customType, "pi-chalin-path-compact-orchestration");
  assert.match(regexPrompt?.message?.content ?? "", /minimal bounded path/i);
  assert.match(regexPrompt?.message?.content ?? "", /Python unittest: after target read/i);
  assert.match(regexPrompt?.message?.content ?? "", /Regex normalizers/i);
  assert.match(regexPrompt?.message?.content ?? "", /avoid redundant cleanup passes unless a test proves they are needed/i);
  assert.match(regexPrompt?.message?.content ?? "", /separator collapse/i);
  assert.match(regexPrompt?.message?.content ?? "", /String\/slug normalizers/i);
  assert.match(regexPrompt?.message?.content ?? "", /No transliteration\/accent policy/i);
  assert.doesNotMatch(regexPrompt?.message?.content ?? "", /tiny Python slug path|one `re\.sub|unittest\.main/i);

  const explicitSlugifyPrompt = await beforeAgentStart({
    type: "before_agent_start",
    prompt: "En Python, implementa slugify.py con tests unittest.",
    systemPrompt: "base",
    systemPromptOptions: {},
  }, ctx);
  assert.equal(explicitSlugifyPrompt?.message?.customType, "pi-chalin-path-compact-orchestration");
  assert.match(explicitSlugifyPrompt?.message?.content ?? "", /String\/slug normalizers/i);
  assert.match(explicitSlugifyPrompt?.message?.content ?? "", /stdlib-only accent folding when available/i);
  assert.match(explicitSlugifyPrompt?.message?.content ?? "", /accented Latin example/i);
  assert.match(explicitSlugifyPrompt?.message?.content ?? "", /No external slugify dependency/i);
  assert.doesNotMatch(explicitSlugifyPrompt?.message?.content ?? "", /tiny Python slug path|NFKD ASCII folding/i);

  const goSlugPrompt = await beforeAgentStart({
    type: "before_agent_start",
    prompt: "Implementa slug.Slugify en Go: lowercase, espacios/puntuación a guiones, colapsa guiones y trim. Añade tests sin dependencias.",
    systemPrompt: "base",
    systemPromptOptions: {},
  }, ctx);
  assert.equal(goSlugPrompt?.message?.customType, "pi-chalin-compact-orchestration");
  assert.match(goSlugPrompt?.message?.content ?? "", /Go string\/slug normalizers/i);
  assert.match(goSlugPrompt?.message?.content ?? "", /strings\.Builder/i);
  assert.match(goSlugPrompt?.message?.content ?? "", /Grow\(len\(input\)\)/i);
  assert.match(goSlugPrompt?.message?.content ?? "", /unicode\.IsLetter/i);
  assert.match(goSlugPrompt?.message?.content ?? "", /strings\.Trim\(result, "-"\)/i);
  assert.match(goSlugPrompt?.message?.content ?? "", /WriteByte/i);
  assert.match(goSlugPrompt?.message?.content ?? "", /accented\/Unicode-letter input/i);
  assert.match(goSlugPrompt?.message?.content ?? "", /separate named tests/i);

  const activeToolSet = ["read", "bash", "edit", "write", "grep", "find", "ls", "chalin_project_discovery", "chalin_project_snapshot", "chalin_route"];
  fake.activeTools = [...activeToolSet];
  const clampPrompt = await beforeAgentStart({
    type: "before_agent_start",
    prompt: "Implementa packages/math/src/clamp.ts y su test package-local para min/max.",
    systemPrompt: "base",
    systemPromptOptions: {},
  }, ctx);
  assert.equal(clampPrompt?.message?.customType, "pi-chalin-lean-package-local-path");
  assert.match(clampPrompt?.message?.content ?? "", /lean package-local path/i);
  assert.match(clampPrompt?.message?.content ?? "", /No ls\/find\/grep or pre-test shell/i);
  assert.match(clampPrompt?.message?.content ?? "", /include one decimal/i);
  assert.match(clampPrompt?.message?.content ?? "", /min==max/i);
  assert.match(clampPrompt?.message?.content ?? "", /Do not invent RangeError, NaN, Infinity/i);
  assert.deepEqual(fake.activeTools, ["read", "bash", "edit", "write"]);
  assert.deepEqual(fake.toolSetHistory.at(-1), ["read", "bash", "edit", "write"]);
  agentEnd({}, ctx);
  assert.deepEqual(fake.activeTools, activeToolSet);

  const cautiousPackageLocalPrompt = await beforeAgentStart({
    type: "before_agent_start",
    prompt: "Implementa packages/math/src/clamp.ts y su test package-local para min/max, incluyendo reversed bounds.",
    systemPrompt: "base",
    systemPromptOptions: {},
  }, ctx);
  assert.equal(cautiousPackageLocalPrompt?.message?.customType, "pi-chalin-path-compact-orchestration");
  assert.match(cautiousPackageLocalPrompt?.message?.content ?? "", /if the prompt already names `packages\/<pkg>\/src\/<stem>\.\*`/i);
  assert.match(cautiousPackageLocalPrompt?.message?.content ?? "", /do not infer `<pkg>` or `<stem>` from words/i);
  assert.doesNotMatch(cautiousPackageLocalPrompt?.message?.content ?? "", /try before ls\/find/i);

  const uvPrompt = await beforeAgentStart({
    type: "before_agent_start",
    prompt: "En este workspace Rust inspirado en uv, corrige normalize_index_url en crates/index-url/src/lib.rs. Debe normalizar scheme/host case-insensitive, quitar credenciales, tratar /simple y /simple/ como equivalentes y preservar path final con slash. Añade/actualiza tests y deja cargo test pasando.",
    systemPrompt: "base",
    systemPromptOptions: {},
  }, ctx);
  assert.equal(uvPrompt?.message?.customType, "pi-chalin-path-compact-orchestration");
  assert.match(uvPrompt?.message?.content ?? "", /route-required path preflight/i);
  assert.match(uvPrompt?.message?.content ?? "", /Prompt paths: `crates\/index-url\/src\/lib\.rs`/i);
  assert.match(uvPrompt?.message?.content ?? "", /First tool must be `chalin_route`/i);
  assert.match(uvPrompt?.message?.content ?? "", /Implementation topology/i);
  assert.match(uvPrompt?.message?.content ?? "", /choose the smallest agent set/i);
  assert.match(uvPrompt?.message?.content ?? "", /Worker execution and a later reviewer are mandatory/i);
  assert.match(uvPrompt?.message?.content ?? "", /requested runner or nearest focused verification/i);
  assert.ok((uvPrompt?.message?.content?.length ?? Infinity) < 2200);
  assert.deepEqual(fake.activeTools, ["chalin_route"]);

  const cachePrompt = await beforeAgentStart({
    type: "before_agent_start",
    prompt: "En este workspace Rust, implementa build_cache_key en crates/cache-key/src/lib.rs. Debe normalizar package con trim + lowercase, normalizar version con trim sin cambiar su contenido, aplicar trim a markers, ignorar markers vacios despues del trim, ordenar markers, preservar case y duplicados de markers, producir una key deterministica y cubrirlo con tests. Deja cargo test pasando.",
    systemPrompt: "base",
    systemPromptOptions: {},
  }, ctx);
  assert.equal(cachePrompt?.message?.customType, "pi-chalin-path-compact-orchestration");
  assert.match(cachePrompt?.message?.content ?? "", /route-required path preflight/i);
  assert.match(cachePrompt?.message?.content ?? "", /Prompt paths: `crates\/cache-key\/src\/lib\.rs`/i);
  assert.match(cachePrompt?.message?.content ?? "", /First tool must be `chalin_route`/i);
  assert.match(cachePrompt?.message?.content ?? "", /choose the smallest agent set/i);
  assert.match(cachePrompt?.message?.content ?? "", /Worker execution and a later reviewer are mandatory/i);
  assert.ok((cachePrompt?.message?.content?.length ?? Infinity) < 2600);
  assert.deepEqual(fake.activeTools, ["chalin_route"]);

  const ttlPrompt = await beforeAgentStart({
    type: "before_agent_start",
    prompt: "Implementa TTL cache en cache/cache.go con reloj inyectable, expiracion lazy y tests go test.",
    systemPrompt: "base",
    systemPromptOptions: {},
  }, ctx);
  assert.match(ttlPrompt?.message?.content ?? "", /minimal bounded path/i);
  assert.match(ttlPrompt?.message?.content ?? "", /Go: read same-dir `<stem>_test\.go` directly before find\/ls/i);
  assert.match(ttlPrompt?.message?.content ?? "", /mutable local `now` variable/i);
  assert.match(ttlPrompt?.message?.content ?? "", /batch source\+test edits before one `go test`/i);
  assert.match(ttlPrompt?.message?.content ?? "", /Cache\/TTL/i);
  assert.match(ttlPrompt?.message?.content ?? "", /lazy expiry through `Get`/i);
  assert.match(ttlPrompt?.message?.content ?? "", /delete expired entries on access when using an internal store/i);
  assert.match(ttlPrompt?.message?.content ?? "", /Prefer precomputed expiresAt\+After/i);
  assert.match(ttlPrompt?.message?.content ?? "", /Exact TTL boundary valid unless evidenced otherwise/i);
  assert.match(ttlPrompt?.message?.content ?? "", /No sleeps, fakeClock structs, TTL=0\/noExpire, or sweeper semantics unless named/i);
  assert.match(ttlPrompt?.message?.content ?? "", /Use 5-6 compact tests/i);
  assert.match(ttlPrompt?.message?.content ?? "", /one expiry test covering before\/exact\/past TTL/i);
  assert.match(ttlPrompt?.message?.content ?? "", /Derive boundary test times from variables/i);
  assert.match(ttlPrompt?.message?.content ?? "", /Do not split before\/exact\/past into separate tests/i);
  assert.match(ttlPrompt?.message?.content ?? "", /overwrite value plus TTL renewal/i);
  assert.match(ttlPrompt?.message?.content ?? "", /independent entries/i);
  assert.match(ttlPrompt?.message?.content ?? "", /stagger/i);
  assert.doesNotMatch(ttlPrompt?.message?.content ?? "", /exactly 3 tests/i);
  assert.doesNotMatch(ttlPrompt?.message?.content ?? "", /No cleanup-after-delete/);
  assert.match(ttlPrompt?.message?.content ?? "", /Verify once: named script if requested, else nearest focused test/i);
  assert.doesNotMatch(ttlPrompt?.message?.content ?? "", /gofmt -w cache\/cache\.go cache\/cache_test\.go/i);
  assert.doesNotMatch(ttlPrompt?.message?.content ?? "", /bounded Go state\/time path|Direct test candidate: read `cache\/cache_test\.go`|Changed names both source and test paths/i);

  const implicitGoTestPrompt = await beforeAgentStart({
    type: "before_agent_start",
    prompt: "En este módulo Go implementa Cache.Get/Set en cache/cache.go con TTL y reloj inyectable para tests determinísticos. Añade tests para expiración y no uses goroutines ni dependencias externas.",
    systemPrompt: "base",
    systemPromptOptions: {},
  }, ctx);
  assert.match(implicitGoTestPrompt?.message?.content ?? "", /minimal bounded path/i);
  assert.match(implicitGoTestPrompt?.message?.content ?? "", /Cache\/TTL/i);
  assert.doesNotMatch(implicitGoTestPrompt?.message?.content ?? "", /bounded Go state\/time path|Final exactly 3 bullets/i);

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
  assert.match(cPrompt?.message?.content ?? "", /Do not read back after passing verification/i);
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
  assert.match(filterPrompt?.message?.content ?? "", /Direct test candidate: read `test\/filterTasks\.test\.ts`/i);
  assert.match(filterPrompt?.message?.content ?? "", /normalize the query once with trim\+lowercase/i);
  assert.match(filterPrompt?.message?.content ?? "", /10-12 visible named behaviors/i);
  assert.match(filterPrompt?.message?.content ?? "", /empty-string description/i);
  assert.match(filterPrompt?.message?.content ?? "", /no input-array mutation/i);
  assert.match(filterPrompt?.message?.content ?? "", /assert full returned object shape/i);
  assert.match(filterPrompt?.message?.content ?? "", /id-only assertions only as secondary order checks/i);
  assert.match(filterPrompt?.message?.content ?? "", /one behavior per test/i);
  assert.match(filterPrompt?.message?.content ?? "", /do not group blank\+whitespace/i);
  assert.match(filterPrompt?.message?.content ?? "", /existing nearest test file/i);
  assert.match(filterPrompt?.message?.content ?? "", /do not create a second sibling `src\/<stem>\.test\.\*` file/i);

  const sortPrompt = await beforeAgentStart({
    type: "before_agent_start",
    prompt: "Implementa sortTasks en src/sortTasks.ts: ordena por prioridad high > medium > low, luego por dueDate ascendente, conserva orden estable si empatan y no muta el array original. Añade tests.",
    systemPrompt: "base",
    systemPromptOptions: {},
  }, ctx);
  assert.equal(sortPrompt?.message?.customType, "pi-chalin-path-compact-orchestration");
  assert.match(sortPrompt?.message?.content ?? "", /minimal bounded path/i);
  assert.match(sortPrompt?.message?.content ?? "", /Stable sorts/i);
  assert.match(sortPrompt?.message?.content ?? "", /Direct test candidate: read `test\/sortTasks\.test\.ts` before search\/find/i);
  assert.match(sortPrompt?.message?.content ?? "", /copy before sort \(`\[\.\.\.items\]\.sort/i);
  assert.match(sortPrompt?.message?.content ?? "", /use original-index decorate only if runtime stability is unknown/i);
  assert.match(sortPrompt?.message?.content ?? "", /Compare ISO date\/datetime strings lexicographically/i);
  assert.match(sortPrompt?.message?.content ?? "", /test date-only and datetime ordering/i);
  assert.match(sortPrompt?.message?.content ?? "", /No structuredClone, broad matrices, readback, or second verification/i);
  assert.doesNotMatch(sortPrompt?.message?.content ?? "", /tiny stable-sort path|Low-entropy transform/i);
  assert.match(sortPrompt?.message?.content ?? "", /Multiple prompt criteria need visible assertions/i);
  assert.match(sortPrompt?.message?.content ?? "", /no smoke-only coverage/i);
  assert.match(sortPrompt?.message?.content ?? "", /Use 7-9 compact tests/i);
  assert.match(sortPrompt?.message?.content ?? "", /single\/no-op/i);
  assert.match(sortPrompt?.message?.content ?? "", /datetime secondary when applicable/i);
  assert.match(sortPrompt?.message?.content ?? "", /Use root direct test candidate/i);
  assert.match(sortPrompt?.message?.content ?? "", /no sibling `src\/<stem>\.test\.\*`/i);
  assert.match(sortPrompt?.message?.content ?? "", /Do not verify\/final on empty\/smoke-only tests/i);
  assert.match(sortPrompt?.message?.content ?? "", /combined primary\+secondary/i);
  assert.match(sortPrompt?.message?.content ?? "", /new reference/i);
  assert.match(sortPrompt?.message?.content ?? "", /import helper types with `import type`/i);
  assert.match(sortPrompt?.message?.content ?? "", /Verify once/i);
  assert.ok((sortPrompt?.message?.content ?? "").length < 2500);

  const dottedIdentifierPrompt = await beforeAgentStart({
    type: "before_agent_start",
    prompt: "Implementa lru.Cache con Get/Set y capacidad fija. Debe evictar least-recently-used al superar capacidad, actualizar existing keys y tener tests. Sin dependencias.",
    systemPrompt: "base",
    systemPromptOptions: {},
  }, ctx);
  assert.equal(dottedIdentifierPrompt?.message?.customType, "pi-chalin-compact-orchestration");
  assert.match(dottedIdentifierPrompt?.message?.content ?? "", /one small package\/module\/class\/function implementation with tests and no prompt paths/i);
  assert.match(dottedIdentifierPrompt?.message?.content ?? "", /do not guess directories from identifiers/i);
  assert.match(dottedIdentifierPrompt?.message?.content ?? "", /Use evidence-backed direct candidates only/i);
  assert.match(dottedIdentifierPrompt?.message?.content ?? "", /one targeted find\/rg by identifier/i);
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
  assert.match(promptResult?.message?.content ?? "", /bounded read-only mini-reviews that explicitly forbid file modification/i);
  assert.match(promptResult?.message?.content ?? "", /If parent context compaction becomes likely/i);
  assert.match(promptResult?.message?.content ?? "", /route or split work into subagents/i);
  assert.match(promptResult?.systemPrompt ?? "", /You are the primary Pi agent/i);
});

test("pi-chalin forces route-only tools for complex routed prompts while preserving bounded direct work", async () => {
  const prompt = "En esta base multi-lenguaje inspirada en Bun, haz un analisis profundo cross-language del fallo de `sync` con paquetes duplicados entre Zig y Rust. No cambies codigo: actualiza docs/lockfile-triage.md.";
  assert.equal(shouldUseCompactDirectOrchestrationPrompt(prompt), true);
  assert.equal(shouldUseCompactDirectOrchestrationPrompt("En este workspace Rust, implementa build_cache_key en crates/cache-key/src/lib.rs y deja cargo test pasando."), true);

  const fake = createFakePi();
  registerPiChalin(fake.api as never);
  const inputHandler = fake.handlers.get("input")?.[0] as (event: unknown, ctx: unknown) => Promise<{ action: string }>;
  const beforeAgentStart = fake.handlers.get("before_agent_start")?.[0] as (event: unknown, ctx: unknown) => Promise<{ systemPrompt?: string; message?: { customType?: string; content?: string; display?: boolean } } | undefined>;
  const agentEnd = fake.handlers.get("agent_end")?.[0] as (event: unknown, ctx: unknown) => void;
  const ctx = { cwd: tempDir("pi-chalin-cross-language-"), hasUI: false, model: undefined, modelRegistry: { getAvailable: () => [] } };
  const activeToolSet = ["chalin_project_discovery", "chalin_project_snapshot", "read", "bash", "grep", "find", "ls", "edit", "write", "chalin_interview", "chalin_route", "chalin_resume", "chalin_web_search", "chalin_memory_search"];
  const routeFirstToolSet = ["chalin_route"];
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
  assert.match(promptResult?.message?.content ?? "", /route broad architecture docs/i);
  assert.match(promptResult?.message?.content ?? "", /compact docs-artifact preflight/i);
  assert.match(promptResult?.message?.content ?? "", /Route-required architecture docs/i);
  assert.match(promptResult?.message?.content ?? "", /call `chalin_route` as the first tool/i);
  assert.match(promptResult?.message?.content ?? "", /choose the smallest agent set/i);
  assert.match(promptResult?.message?.content ?? "", /review evidence\/contract\/gaps\/readback/i);
  assert.match(promptResult?.message?.content ?? "", /not substitutes for route/i);
  assert.match(promptResult?.message?.content ?? "", /Do not start native just because the mutation target is one docs file/i);
  assert.match(promptResult?.message?.content ?? "", /The routed workflow still updates only the requested docs artifact/i);
  assert.match(promptResult?.message?.content ?? "", /Cross-language\/runtime plans/i);
  assert.match(promptResult?.message?.content ?? "", /ABI-stable fixed-width integers or bitfields/i);
  assert.doesNotMatch(promptResult?.message?.content ?? "", /Direct source candidate from prompt operation `sync`/i);
  assert.doesNotMatch(promptResult?.message?.content ?? "", /read `src\/sync\.ts` before any find/i);
  assert.doesNotMatch(promptResult?.message?.content ?? "", /Use fallback `src\/sync\.js` only if that direct read fails/i);
  assert.match(promptResult?.message?.content ?? "", /Native docs mode is only for bounded\/local docs artifacts/i);
  assert.match(promptResult?.message?.content ?? "", /first read the requested artifact, package\/build\/test script if present/i);
  assert.match(promptResult?.message?.content ?? "", /one concrete source surface per named responsibility/i);
  assert.match(promptResult?.message?.content ?? "", /bare filenames or public symbols without paths/i);
  assert.match(promptResult?.message?.content ?? "", /do not invent path candidates/i);
  assert.match(promptResult?.message?.content ?? "", /TODO\/TBD\/WIP\/placeholder/i);
  assert.doesNotMatch(promptResult?.message?.content ?? "", /at most 1 targeted `find` and 1 targeted `grep`/i);
  assert.match(promptResult?.message?.content ?? "", /After evidence, write the docs next/i);
  assert.match(promptResult?.message?.content ?? "", /One write, one readback, at most one corrective edit\+readback/i);
  assert.match(promptResult?.message?.content ?? "", /Native final should be concise but complete/i);
  assert.deepEqual(fake.activeTools, routeFirstToolSet);
  assert.deepEqual(fake.toolSetHistory.at(-1), routeFirstToolSet);

  agentEnd({}, ctx);
  assert.deepEqual(fake.activeTools, activeToolSet);

  const broadNoPath = await beforeAgentStart({
    type: "before_agent_start",
    prompt: "Revisa este proyecto en profundidad y compara opciones de mejora de arquitectura con riesgos, tradeoffs y proximos pasos.",
    systemPrompt: "base",
    systemPromptOptions: {},
  }, ctx);
  assert.equal(broadNoPath?.message?.customType, "pi-chalin-compact-orchestration");
  assert.match(broadNoPath?.message?.content ?? "", /Call `chalin_route` as the first tool/i);
  assert.match(broadNoPath?.message?.content ?? "", /deep project analysis/i);
  assert.deepEqual(fake.activeTools, routeFirstToolSet);

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
  assert.match(runtimePlan?.message?.content ?? "", /route broad architecture docs/i);
  assert.match(runtimePlan?.message?.content ?? "", /call `chalin_route` as the first tool/i);
  assert.match(runtimePlan?.message?.content ?? "", /Cross-language\/runtime plans/i);
  assert.match(runtimePlan?.message?.content ?? "", /ABI-stable fixed-width integers or bitfields/i);
  assert.match(runtimePlan?.message?.content ?? "", /compatibility wrappers/i);
  assert.deepEqual(fake.activeTools, routeFirstToolSet);

  agentEnd({}, ctx);
  assert.deepEqual(fake.activeTools, activeToolSet);

  const rustWorkspaceFeature = await beforeAgentStart({
    type: "before_agent_start",
    prompt: "En este workspace Rust, implementa build_cache_key en crates/cache-key/src/lib.rs y deja cargo test pasando.",
    systemPrompt: "base",
    systemPromptOptions: {},
  }, ctx);
  assert.equal(rustWorkspaceFeature?.message?.customType, "pi-chalin-path-compact-orchestration");
  assert.match(rustWorkspaceFeature?.message?.content ?? "", /route-required path preflight/i);
  assert.match(rustWorkspaceFeature?.message?.content ?? "", /First tool must be `chalin_route`/i);
  assert.match(rustWorkspaceFeature?.message?.content ?? "", /choose the smallest agent set/i);
  assert.match(rustWorkspaceFeature?.message?.content ?? "", /Worker execution and a later reviewer are mandatory/i);
  assert.match(rustWorkspaceFeature?.message?.content ?? "", /requested runner or nearest focused verification/i);
  assert.deepEqual(fake.activeTools, routeFirstToolSet);

  agentEnd({}, ctx);
  assert.deepEqual(fake.activeTools, activeToolSet);

  const diagnosticPlan = await beforeAgentStart({
    type: "before_agent_start",
    prompt: "En esta base C++ inspirada en LLVM/Clang, haz un analisis profundo de arquitectura para mover la responsabilidad de formateo de diagnostics fuera de Parser.cpp hacia DiagnosticEngine sin cambiar comportamiento. No implementes codigo: actualiza docs/diagnostic-refactor-plan.md con mapa de dependencias, plan por etapas, riesgos y pruebas.",
    systemPrompt: "base",
    systemPromptOptions: {},
  }, ctx);
  assert.equal(diagnosticPlan?.message?.customType, "pi-chalin-path-compact-orchestration");
  assert.match(diagnosticPlan?.message?.content ?? "", /Prompt paths: `docs\/diagnostic-refactor-plan\.md`/i);
  assert.doesNotMatch(diagnosticPlan?.message?.content ?? "", /Prompt paths: `Parser\.cpp`/i);
  assert.match(diagnosticPlan?.message?.content ?? "", /Named surfaces without exact paths: `Parser\.cpp`/i);
  assert.match(diagnosticPlan?.message?.content ?? "", /Treat these as search keys, not files to read directly/i);
  assert.match(diagnosticPlan?.message?.content ?? "", /A raw inventory or one targeted find\/rg is evidence/i);
  assert.match(diagnosticPlan?.message?.content ?? "", /conventional path candidates are not/i);
  assert.match(diagnosticPlan?.message?.content ?? "", /route broad architecture docs/i);
  assert.match(diagnosticPlan?.message?.content ?? "", /Route-required architecture docs/i);
  assert.match(diagnosticPlan?.message?.content ?? "", /responsibility\/ownership maps/i);
  assert.match(diagnosticPlan?.message?.content ?? "", /evidence-derived validation/i);
  assert.match(diagnosticPlan?.message?.content ?? "", /problem taxonomy with evidence/i);
  assert.match(diagnosticPlan?.message?.content ?? "", /data-flow\/coupling map/i);
  assert.match(diagnosticPlan?.message?.content ?? "", /ownership\/coupling-by-responsibility table/i);
  assert.match(diagnosticPlan?.message?.content ?? "", /design decision matrix with options\/recommendation/i);
  assert.match(diagnosticPlan?.message?.content ?? "", /dependency delta to add\/remove includes\/imports\/modules/i);
  assert.match(diagnosticPlan?.message?.content ?? "", /stage-0 golden-test capture/i);
  assert.match(diagnosticPlan?.message?.content ?? "", /reverse-dependency check/i);
  assert.match(diagnosticPlan?.message?.content ?? "", /target ownership\/layers/i);
  assert.match(diagnosticPlan?.message?.content ?? "", /staged migration with exit criteria/i);
  assert.match(diagnosticPlan?.message?.content ?? "", /risk register with severity and mitigation/i);
  assert.match(diagnosticPlan?.message?.content ?? "", /rollback strategy/i);
  assert.match(diagnosticPlan?.message?.content ?? "", /phase checklist/i);
  assert.match(diagnosticPlan?.message?.content ?? "", /out-of-scope boundaries/i);
  assert.match(diagnosticPlan?.message?.content ?? "", /literal TODO\/TBD\/WIP\/placeholder tokens/i);
  assert.match(diagnosticPlan?.message?.content ?? "", /bare filenames or public symbols without paths/i);
  assert.match(diagnosticPlan?.message?.content ?? "", /do not invent path candidates/i);
  assert.match(diagnosticPlan?.message?.content ?? "", /targeted find\/rg by exact basename or symbol/i);
  assert.match(diagnosticPlan?.message?.content ?? "", /Do not run wildcard `\*\*\/\*\.h`, `\*\*\/\*\.cpp`, docs, tests, or build-file searches/i);
  assert.match(diagnosticPlan?.message?.content ?? "", /roughly 80-120 lines/i);
  assert.match(diagnosticPlan?.message?.content ?? "", /call `chalin_route` as the first tool/i);
  assert.doesNotMatch(diagnosticPlan?.message?.content ?? "", /Diagnostic\/formatter planning|dependency-and-responsibility map/i);
  assert.deepEqual(fake.activeTools, routeFirstToolSet);
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
  assert.doesNotMatch(codePrompt?.message?.content ?? "", /Parsers\/scanners\/state machines/i);
  assert.match(codePrompt?.message?.content ?? "", /No placeholders\/TODO/i);
  assert.deepEqual(fake.activeTools, activeToolSet);
  agentEnd({}, ctx);
  assert.deepEqual(fake.activeTools, activeToolSet);
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

test("package-local bounded direct mode stays austere before verification", async () => {
  const fake = createFakePi();
  registerPiChalin(fake.api as never);
  const beforeAgentStart = fake.handlers.get("before_agent_start")?.[0] as (event: unknown, ctx: unknown) => Promise<{ message?: { content?: string; customType?: string } } | undefined>;
  const toolExecutionEnd = fake.handlers.get("tool_execution_end")?.[0] as (event: { toolName: string; isError?: boolean; args?: Record<string, unknown> }, ctx: unknown) => void;
  const ctx = {
    cwd: tempDir("pi-chalin-lean-package-local-"),
    hasUI: false,
    model: undefined,
    modelRegistry: { getAvailable: () => [] },
  };
  const promptResult = await beforeAgentStart({
    type: "before_agent_start",
    prompt: "En este mini monorepo, implementa packages/math/src/clamp.ts y su test package-local. Mantén bun test en el root.",
    systemPrompt: "base",
    systemPromptOptions: {},
  }, ctx);
  assert.match(promptResult?.message?.content ?? "", /First read `package\.json`, `packages\/math\/src\/clamp\.ts`/i);
  assert.doesNotMatch(promptResult?.message?.content ?? "", /try before ls\/find/i);

  toolExecutionEnd({ toolName: "chalin_project_discovery", isError: false }, ctx);
  toolExecutionEnd({ toolName: "read", isError: false, args: { path: "package.json" } }, ctx);
  toolExecutionEnd({ toolName: "read", isError: false, args: { path: "packages/math/src/clamp.ts" } }, ctx);
  toolExecutionEnd({ toolName: "read", isError: false, args: { path: "packages/math/test/clamp.test.ts" } }, ctx);
  toolExecutionEnd({ toolName: "edit", isError: false, args: { path: "packages/math/src/clamp.ts" } }, ctx);
  toolExecutionEnd({ toolName: "edit", isError: false, args: { path: "packages/math/test/clamp.test.ts" } }, ctx);
  assert.equal(fake.messages.some((item) => /pi-chalin-direct-(?:locator-loop|progress|source-test-ready)-nudge/.test((item.message as { customType?: string }).customType ?? "")), false);

  toolExecutionEnd({ toolName: "bash", isError: false, args: { command: "bun test" } }, ctx);
  const completion = fake.messages.filter((item) => (item.message as { customType?: string }).customType === "pi-chalin-direct-completion-nudge");
  assert.equal(completion.length, 1);
  const content = (completion[0]?.message as { content?: string }).content ?? "";
  assert.match(content, /package-local source\/test edit/i);
  assert.match(content, /No readback, rerun, broad discovery/i);
  assert.doesNotMatch(content, /README\/API\/usage docs/i);
});

test("bounded direct tool scopes hide unused search and orchestration tools", async () => {
  const fake = createFakePi();
  registerPiChalin(fake.api as never);
  const beforeAgentStart = fake.handlers.get("before_agent_start")?.[0] as (event: unknown, ctx: unknown) => Promise<unknown>;
  const agentEnd = fake.handlers.get("agent_end")?.[0] as (event: unknown, ctx: unknown) => void;
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
  assert.deepEqual(fake.activeTools, ["read", "bash", "edit", "write"]);
  agentEnd({}, ctx);
  assert.deepEqual(fake.activeTools, fullToolSet);

  fake.activeTools = [...fullToolSet];
  await beforeAgentStart({
    type: "before_agent_start",
    prompt: "Scaffoldea un CLI TypeScript mínimo llamado note-pack: package.json, src/cli.ts, README con uso, y test básico en test/cli.test.ts. Usa Bun.",
    systemPrompt: "base",
    systemPromptOptions: {},
  }, ctx);
  assert.deepEqual(fake.activeTools, ["bash", "edit", "write"]);
  agentEnd({}, ctx);
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

test("test-only direct mode uses terse verify and completion nudges", async () => {
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
  assert.match(progressContent, /Test-only edit done/i);
  assert.match(progressContent, /Run the nearest test now/i);
  assert.match(progressContent, /No readback, package\/config\/search/i);
  assert.doesNotMatch(progressContent, /Preserve compatibility and requested package\/CLI\/API metadata/i);

  toolExecutionEnd({ toolName: "bash", isError: false, args: { command: "bun test test/math.test.ts" } }, ctx);

  const completion = fake.messages.find((item) => (item.message as { customType?: string }).customType === "pi-chalin-direct-completion-nudge");
  const completionContent = (completion?.message as { content?: string }).content ?? "";
  assert.match(completionContent, /Test-only change verified/i);
  assert.match(completionContent, /Final now/i);
  assert.match(completionContent, /Do not read back, rerun tests, or explain a plan/i);
  assert.match(completionContent, /name the requested behavior and boundary/i);
  assert.doesNotMatch(completionContent, /README\/API\/usage docs/i);
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

  const promptResult = await beforeAgentStart({ type: "before_agent_start", prompt: "actualiza docs/plan.md sin tocar codigo", systemPrompt: "base", systemPromptOptions: {} }, ctx) as { message?: { content?: string } };
  assert.match(promptResult.message?.content ?? "", /do not answer with a route label/i);
  assert.match(promptResult.message?.content ?? "", /first read the requested artifact, package\/test script, and one obvious source surface/i);
  assert.match(promptResult.message?.content ?? "", /no ls\/find before those direct reads unless a read fails/i);
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

test("direct stateful/time drift gets a general coverage nudge", async () => {
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

  const ttlNudges = fake.messages.filter((item) => (item.message as { customType?: string }).customType === "pi-chalin-direct-stateful-time-nudge");
  assert.equal(ttlNudges.length, 1);
  assert.match((ttlNudges[0]?.message as { content?: string }).content ?? "", /Stateful\/time-sensitive task drift/i);
  assert.match((ttlNudges[0]?.message as { content?: string }).content ?? "", /stop discovery once source and nearest tests are known/i);
  assert.match((ttlNudges[0]?.message as { content?: string }).content ?? "", /happy path/i);
  assert.match((ttlNudges[0]?.message as { content?: string }).content ?? "", /before\/at\/after the state transition/i);
  assert.match((ttlNudges[0]?.message as { content?: string }).content ?? "", /state update or preservation/i);
  assert.match((ttlNudges[0]?.message as { content?: string }).content ?? "", /independent entries\/keys/i);
  assert.doesNotMatch((ttlNudges[0]?.message as { content?: string }).content ?? "", /exactly 3/i);
  assert.equal(fake.messages.filter((item) => (item.message as { customType?: string }).customType === "pi-chalin-direct-locator-loop-nudge").length, 0);
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
  assert.match((completion?.message as { content?: string }).content ?? "", /Docs readback complete with `read docs\/plan\.md`/i);
  assert.match((completion?.message as { content?: string }).content ?? "", /Final now\. Do not call tools/i);
  assert.match((completion?.message as { content?: string }).content ?? "", /Use exactly 3 bullets/i);
  assert.doesNotMatch((completion?.message as { content?: string }).content ?? "", /Checklist: requested API\/tests\/docs\/metadata/i);
  assert.doesNotMatch((completion?.message as { content?: string }).content ?? "", /escape hatches.*warning suppression/i);
});

test("direct runbook docs reject pre-write shell by default", async () => {
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
  assert.equal(fake.messages.filter((item) => (item.message as { customType?: string }).customType === "pi-chalin-docs-only-shell-nudge").length, 1);
  toolExecutionEnd({ toolName: "bash", isError: false, args: { command: "bun -e \"import './src/sync.ts'; console.log('ok')\"" } }, ctx);
  assert.equal(fake.messages.filter((item) => (item.message as { customType?: string }).customType === "pi-chalin-docs-only-shell-nudge").length, 1);

  toolExecutionEnd({ toolName: "bash", isError: false, args: { command: "bun test" } }, ctx);
  assert.equal(fake.messages.filter((item) => (item.message as { customType?: string }).customType === "pi-chalin-docs-only-shell-nudge").length, 1);

  toolExecutionEnd({ toolName: "write", isError: false, args: { path: "docs/runbook.md" } }, ctx);
  toolExecutionEnd({ toolName: "bash", isError: false, args: { command: "bun test" } }, ctx);
  assert.equal(fake.messages.filter((item) => (item.message as { customType?: string }).customType === "pi-chalin-docs-only-shell-nudge").length, 2);
});

test("direct runbook docs use read evidence by default before writing", async () => {
  const fake = createFakePi();
  registerPiChalin(fake.api as never);
  const beforeAgentStart = fake.handlers.get("before_agent_start")?.[0] as (event: unknown, ctx: unknown) => Promise<unknown>;
  const toolExecutionEnd = fake.handlers.get("tool_execution_end")?.[0] as (event: { toolName: string; isError?: boolean; args?: Record<string, unknown> }, ctx: unknown) => void;
  const ctx = {
    cwd: tempDir("pi-chalin-docs-prewrite-evidence-"),
    hasUI: false,
    model: undefined,
    modelRegistry: { getAvailable: () => [] },
  };

  const result = await beforeAgentStart({ type: "before_agent_start", prompt: "Actualiza docs/runbook.md explicando cómo ejecutar tests, diagnosticar fallo de sync y rollback seguro usando evidencia del repo. No cambies código.", systemPrompt: "base", systemPromptOptions: {} }, ctx) as { message?: { content?: string } };
  assert.match(result.message?.content ?? "", /Do not run shell before writing unless the user explicitly asks/i);
  assert.match(result.message?.content ?? "", /package\.json\/source evidence is enough to document how to run tests/i);
  toolExecutionEnd({ toolName: "read", isError: false, args: { path: "docs/runbook.md" } }, ctx);
  toolExecutionEnd({ toolName: "read", isError: false, args: { path: "package.json" } }, ctx);
  assert.equal(fake.messages.filter((item) => (item.message as { customType?: string }).customType === "pi-chalin-docs-prewrite-shell-nudge").length, 0);
  toolExecutionEnd({ toolName: "read", isError: false, args: { path: "src/sync.ts" } }, ctx);

  const nudges = fake.messages.filter((item) => (item.message as { customType?: string }).customType === "pi-chalin-docs-prewrite-shell-nudge");
  assert.equal(nudges.length, 0);
  const loopNudges = fake.messages.filter((item) => (item.message as { customType?: string }).customType === "pi-chalin-docs-evidence-loop-nudge");
  assert.equal(loopNudges.length, 1);
  assert.match((loopNudges[0]?.message as { content?: string }).content ?? "", /next tool must write or edit the requested docs artifact/i);
  assert.match((loopNudges[0]?.message as { content?: string }).content ?? "", /Stop ls\/find\/grep\/bash now/i);

  toolExecutionEnd({ toolName: "read", isError: false, args: { path: "src/other.ts" } }, ctx);
  assert.equal(fake.messages.filter((item) => (item.message as { customType?: string }).customType === "pi-chalin-docs-prewrite-shell-nudge").length, 0);
  assert.equal(fake.messages.filter((item) => (item.message as { customType?: string }).customType === "pi-chalin-docs-evidence-loop-nudge").length, 1);
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
  assert.equal(fake.messages.filter((item) => (item.message as { customType?: string }).customType === "pi-chalin-docs-only-shell-nudge").length, 1);
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

test("direct scaffold evidence loop nudges compact product creation", async () => {
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
  toolExecutionEnd({ toolName: "find", isError: false, args: { path: ".", pattern: "*.ts" } }, ctx);

  const nudges = fake.messages.filter((item) => (item.message as { customType?: string }).customType === "pi-chalin-scaffold-evidence-loop-nudge");
  assert.equal(nudges.length, 1);
  assert.match((nudges[0]?.message as { content?: string }).content ?? "", /enough scaffold\/greenfield evidence/i);
  assert.match((nudges[0]?.message as { content?: string }).content ?? "", /package\/bin\/export metadata/i);
  assert.match((nudges[0]?.message as { content?: string }).content ?? "", /runner-discoverable tests/i);
  assert.equal(fake.messages.filter((item) => (item.message as { customType?: string }).customType === "pi-chalin-direct-locator-loop-nudge").length, 0);
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
  assert.doesNotMatch(text, /Supporting findings:/);
  assert.ok(statuses.some((status) => status.startsWith("chalin ")));
  assert.ok(statuses.some((status) => status.includes("review")));
  assert.ok(widgets.every((args) => args[1] === undefined), "chalin_route may clear the legacy widget but must not create a duplicate persistent widget");
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

test("finalAnswerMaterial appends implementation evidence omitted by final reviewer wording", () => {
  const cwd = tempDir("pi-chalin-final-material-evidence-");
  const run = createRunState({
    kind: "multi-agent-chain",
    agents: ["scout", "worker", "reviewer"],
    risk: "medium",
    ambiguity: "low",
    needsMemory: false,
    needsArtifacts: true,
    reason: "Routed implementation.",
    plan: { kind: "chain", steps: [{ agent: "scout", task: "Map." }, { agent: "worker", task: "Implement." }, { agent: "reviewer", task: "Review." }] },
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
