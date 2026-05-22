import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, test } from "node:test";
import registerPiMesh from "../src/index.ts";
import { shouldUseCompactDirectOrchestrationPrompt, shouldUseCompactMeshCriticalPrompt } from "../src/autoroute.ts";
import { resetRuntimeState, setLatestRun } from "../src/runtime-state.ts";
import { meshFooterText, openMemoryReview, openSmartPanel, summarizeRuntimeGuards } from "../src/ui.ts";
import { finalAnswerMaterial, formatMeshRoutePlanWidget, formatMeshRunWidget } from "../src/tools.ts";
import { createRunState } from "../src/runner.ts";
import type { MemoryRecord, RunState } from "../src/schemas.ts";

const tempDirs: string[] = [];
afterEach(() => {
  resetRuntimeState();
  while (tempDirs.length > 0) fs.rmSync(tempDirs.pop()!, { recursive: true, force: true });
});
function tempDir(prefix: string): string { const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix)); tempDirs.push(dir); return dir; }
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
        handlers.set(event, [...(handlers.get(event) ?? []), handler]);
      },
      sendMessage(message: unknown, options?: unknown) {
        fake.messages.push({ message, options });
      },
    },
  };
  return fake;
}

test("pi-mesh extension registers Phase 0 command and tool", () => {
  const fake = createFakePi();
  registerPiMesh(fake.api as never);

  assert.equal(fake.commands.has("mesh"), true);
  assert.equal(fake.tools.has("mesh_route"), true);
  assert.equal(fake.tools.has("mesh_resume"), true);
  assert.equal(fake.tools.has("mesh_interview"), true);
  assert.equal(fake.tools.has("mesh_web_search"), true);
  assert.equal(fake.handlers.has("session_start"), true);
  assert.equal(fake.handlers.has("input"), true);
});

test("pi-mesh recursion guard skips child registration", () => {
  const previous = process.env.PI_MESH_CHILD;
  process.env.PI_MESH_CHILD = "1";
  try {
    const fake = createFakePi();
    registerPiMesh(fake.api as never);
    assert.equal(fake.commands.size, 0);
    assert.equal(fake.tools.size, 0);
  } finally {
    if (previous === undefined) delete process.env.PI_MESH_CHILD;
    else process.env.PI_MESH_CHILD = previous;
  }
});


test("pi-mesh disabled env skips registration", () => {
  const previous = process.env.PI_MESH_DISABLED;
  process.env.PI_MESH_DISABLED = "1";
  try {
    const fake = createFakePi();
    registerPiMesh(fake.api as never);
    assert.equal(fake.commands.size, 0);
    assert.equal(fake.tools.size, 0);
  } finally {
    if (previous === undefined) delete process.env.PI_MESH_DISABLED;
    else process.env.PI_MESH_DISABLED = previous;
  }
});


test("pi-mesh keeps the native prompt and teaches the primary Pi agent to decide mesh usage", async () => {
  const fake = createFakePi();
  registerPiMesh(fake.api as never);
  const inputHandler = fake.handlers.get("input")?.[0] as (event: unknown, ctx: unknown) => Promise<{ action: string }>;
  const beforeAgentStart = fake.handlers.get("before_agent_start")?.[0] as (event: unknown, ctx: unknown) => Promise<{ systemPrompt?: string; message?: { customType?: string; display?: boolean } } | undefined>;
  assert.equal(typeof inputHandler, "function");
  assert.equal(typeof beforeAgentStart, "function");
  assert.equal(fake.handlers.has("context"), false, "mesh should not register a hidden context auto-router");

  const ctx = {
    cwd: tempDir("pi-mesh-auto-"),
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

  assert.equal(fake.messages.length, 0, "mesh should not create a separate follow-up turn");

  const promptResult = await beforeAgentStart({
    type: "before_agent_start",
    prompt: "review this project",
    systemPrompt: "base system prompt",
    systemPromptOptions: {},
  }, ctx);
  assert.match(promptResult?.systemPrompt ?? "", /primary Pi agent/i);
  assert.match(promptResult?.systemPrompt ?? "", /mesh_resume/i);
  assert.match(promptResult?.systemPrompt ?? "", /mesh_interview/i);
  assert.match(promptResult?.systemPrompt ?? "", /mesh_route/i);
  assert.match(promptResult?.systemPrompt ?? "", /MUST call `mesh_route` first/i);
  assert.match(promptResult?.message?.customType === "pi-mesh-orchestration" ? JSON.stringify(promptResult.message) : "", /named-file bugfixes/i);
  assert.match(promptResult?.message?.customType === "pi-mesh-orchestration" ? JSON.stringify(promptResult.message) : "", /named-file refactors/i);
  assert.match(promptResult?.message?.customType === "pi-mesh-orchestration" ? JSON.stringify(promptResult.message) : "", /Do not route or dry-run unless/i);
  assert.match(promptResult?.message?.customType === "pi-mesh-orchestration" ? JSON.stringify(promptResult.message) : "", /passing final verification/i);
  assert.match(promptResult?.message?.customType === "pi-mesh-orchestration" ? JSON.stringify(promptResult.message) : "", /bounded read-only mini-project reviews/i);
  assert.match(promptResult?.message?.customType === "pi-mesh-orchestration" ? JSON.stringify(promptResult.message) : "", /changing only implementation is incomplete/i);
  assert.match(promptResult?.message?.customType === "pi-mesh-orchestration" ? JSON.stringify(promptResult.message) : "", /dependency-free TypeScript scaffolding/i);
  assert.match(promptResult?.message?.customType === "pi-mesh-orchestration" ? JSON.stringify(promptResult.message) : "", /exact requested files/i);
  assert.match(promptResult?.message?.customType === "pi-mesh-orchestration" ? JSON.stringify(promptResult.message) : "", /node --experimental-strip-types --test test\/\*\.test\.ts/i);
  assert.match(promptResult?.systemPrompt ?? "", /branch\/diff\/PR/i);
  assert.match(promptResult?.systemPrompt ?? "", /Architecture\/migration/i);
  assert.match(promptResult?.systemPrompt ?? "", /scout/);
  assert.match(promptResult?.systemPrompt ?? "", /reviewer/);
  assert.equal(promptResult?.message?.customType, "pi-mesh-orchestration");
  assert.equal(promptResult?.message?.display, false);
});



test("pi-mesh uses compact orchestration context for bounded scaffold prompts", async () => {
  assert.equal(shouldUseCompactDirectOrchestrationPrompt("Scaffoldea una mini librería TypeScript de config: package.json, src/config.ts, tests y README. Sin dependencias externas."), true);
  assert.equal(shouldUseCompactDirectOrchestrationPrompt("revisa este proyecto dime que hace, en profundidad"), false);

  const fake = createFakePi();
  registerPiMesh(fake.api as never);
  const beforeAgentStart = fake.handlers.get("before_agent_start")?.[0] as (event: unknown, ctx: unknown) => Promise<{ systemPrompt?: string; message?: { customType?: string; content?: string; display?: boolean } } | undefined>;
  const ctx = {
    cwd: tempDir("pi-mesh-compact-direct-"),
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
  assert.equal(promptResult?.message?.customType, "pi-mesh-direct-compact-orchestration");
  assert.match(promptResult?.systemPrompt ?? "", /orchestration \(compact\)/i);
  assert.doesNotMatch(promptResult?.systemPrompt ?? "", /Available pi-mesh agents/i);
  assert.match(promptResult?.message?.content ?? "", /write promptly/i);
  assert.match(promptResult?.message?.content ?? "", /visible planning/i);
  assert.match(promptResult?.message?.content ?? "", /no uninstalled runners/i);
  assert.match(promptResult?.message?.content ?? "", /rerun verification after the final edit/i);
  assert.match(promptResult?.message?.content ?? "", /package\.json `bin`/i);
  assert.match(promptResult?.message?.content ?? "", /never `node \.\.\.` command strings/i);
  assert.match(promptResult?.message?.content ?? "", /injected clocks\/schedulers/i);
  assert.match(promptResult?.message?.content ?? "", /process\.env/i);
});



test("pi-mesh uses compact critical routing context for surgical long-file work", async () => {
  assert.equal(shouldUseCompactMeshCriticalPrompt("en un archivo largo cambia solo la validacion puntual de auth y evita reescribir el archivo completo"), true);
  assert.equal(shouldUseCompactDirectOrchestrationPrompt("en un archivo largo cambia solo la validacion puntual de auth y evita reescribir el archivo completo"), false);

  const fake = createFakePi();
  registerPiMesh(fake.api as never);
  const beforeAgentStart = fake.handlers.get("before_agent_start")?.[0] as (event: unknown, ctx: unknown) => Promise<{ systemPrompt?: string; message?: { customType?: string; content?: string; display?: boolean } } | undefined>;
  const ctx = { cwd: tempDir("pi-mesh-critical-"), hasUI: false, model: undefined, modelRegistry: { getAvailable: () => [] } };
  const promptResult = await beforeAgentStart({
    type: "before_agent_start",
    prompt: "en un archivo largo cambia solo la validacion puntual de auth y evita reescribir el archivo completo",
    systemPrompt: "base",
    systemPromptOptions: {},
  }, ctx);
  assert.equal(promptResult?.message?.customType, "pi-mesh-critical-compact-orchestration");
  assert.match(promptResult?.systemPrompt ?? "", /critical compact/i);
  assert.match(promptResult?.message?.content ?? "", /First action must be `mesh_route`/i);
  assert.doesNotMatch(promptResult?.systemPrompt ?? "", /Available pi-mesh agents\n/i);
});

test("direct bounded edits get one completion nudge after verification", async () => {
  const fake = createFakePi();
  registerPiMesh(fake.api as never);
  const beforeAgentStart = fake.handlers.get("before_agent_start")?.[0] as (event: unknown, ctx: unknown) => Promise<unknown>;
  const toolExecutionEnd = fake.handlers.get("tool_execution_end")?.[0] as (event: { toolName: string; isError?: boolean; args?: { command?: string } }, ctx: unknown) => void;
  assert.equal(typeof beforeAgentStart, "function");
  assert.equal(typeof toolExecutionEnd, "function");

  const ctx = {
    cwd: tempDir("pi-mesh-direct-nudge-"),
    hasUI: false,
    model: undefined,
    modelRegistry: { getAvailable: () => [] },
  };
  await beforeAgentStart({ type: "before_agent_start", prompt: "fix src/parseDate.ts", systemPrompt: "base", systemPromptOptions: {} }, ctx);

  toolExecutionEnd({ toolName: "bash", isError: false, args: { command: "npm test" } }, ctx);
  assert.equal(fake.messages.some((item) => (item.message as { customType?: string }).customType === "pi-mesh-direct-completion-nudge"), false, "verification before mutation is not enough");

  toolExecutionEnd({ toolName: "edit", isError: false }, ctx);
  assert.equal(fake.messages.filter((item) => (item.message as { customType?: string }).customType === "pi-mesh-direct-progress-nudge").length, 1, "mutation gets a progress nudge");
  assert.equal(fake.messages.some((item) => (item.message as { customType?: string }).customType === "pi-mesh-direct-completion-nudge"), false, "mutation alone is not enough for completion");

  toolExecutionEnd({ toolName: "bash", isError: true, args: { command: "npm test" } }, ctx);
  const failureNudges = fake.messages.filter((item) => (item.message as { customType?: string }).customType === "pi-mesh-direct-verification-failed-nudge");
  assert.equal(failureNudges.length, 1);
  assert.match((failureNudges[0]?.message as { content?: string }).content ?? "", /Do NOT answer as done yet/i);
  assert.match((failureNudges[0]?.message as { content?: string }).content ?? "", /node --experimental-strip-types --test test\/\*\.test\.ts/i);
  assert.match((failureNudges[0]?.message as { content?: string }).content ?? "", /wall-clock flakiness/i);
  assert.match((failureNudges[0]?.message as { content?: string }).content ?? "", /process\.env/i);

  toolExecutionEnd({ toolName: "bash", isError: false, args: { command: "npm test" } }, ctx);
  const nudges = fake.messages.filter((item) => (item.message as { customType?: string }).customType === "pi-mesh-direct-completion-nudge");
  assert.equal(nudges.length, 1);
  const nudgeContent = (nudges[0]?.message as { content?: string }).content ?? "";
  assert.match(nudgeContent, /answer now/i);
  assert.match(nudgeContent, /Verification: `npm test` passed/i);
  assert.match(nudgeContent, /Passing tests is not enough/i);
  assert.match(nudgeContent, /starter smoke\/empty path/i);
  assert.match(nudgeContent, /bin\/scripts/i);
  assert.match(nudgeContent, /Do not omit the Verification or Notes line/i);
  assert.deepEqual(nudges[0]?.options, { triggerTurn: false, deliverAs: "steer" });

  toolExecutionEnd({ toolName: "edit", isError: false }, ctx);
  assert.equal(fake.messages.filter((item) => (item.message as { customType?: string }).customType === "pi-mesh-direct-progress-nudge").length, 1, "progress nudge is sent once per turn");
  assert.equal(fake.messages.filter((item) => (item.message as { customType?: string }).customType === "pi-mesh-direct-ready-to-verify-nudge").length, 2, "editing after verification invalidates stale verification and asks for a fresh check");

  toolExecutionEnd({ toolName: "bash", isError: false, args: { command: "npm test" } }, ctx);
  assert.equal(fake.messages.filter((item) => (item.message as { customType?: string }).customType === "pi-mesh-direct-completion-nudge").length, 2, "new edits after verification require a new completion nudge");
});



test("direct bounded edits recognize Python unittest verification and rerun after failed checks", async () => {
  const fake = createFakePi();
  registerPiMesh(fake.api as never);
  const beforeAgentStart = fake.handlers.get("before_agent_start")?.[0] as (event: unknown, ctx: unknown) => Promise<unknown>;
  const toolExecutionEnd = fake.handlers.get("tool_execution_end")?.[0] as (event: { toolName: string; isError?: boolean; args?: Record<string, unknown> }, ctx: unknown) => void;
  const ctx = {
    cwd: tempDir("pi-mesh-direct-python-nudge-"),
    hasUI: false,
    model: undefined,
    modelRegistry: { getAvailable: () => [] },
  };

  await beforeAgentStart({ type: "before_agent_start", prompt: "implementa slugify.py y tests con unittest", systemPrompt: "base", systemPromptOptions: {} }, ctx);
  toolExecutionEnd({ toolName: "edit", isError: false, args: { path: "slugify.py" } }, ctx);
  toolExecutionEnd({ toolName: "edit", isError: false, args: { path: "tests/test_slugify.py" } }, ctx);
  toolExecutionEnd({ toolName: "bash", isError: true, args: { command: "python -m unittest" } }, ctx);
  assert.equal(fake.messages.filter((item) => (item.message as { customType?: string }).customType === "pi-mesh-direct-verification-failed-nudge").length, 1);

  toolExecutionEnd({ toolName: "edit", isError: false, args: { path: "tests/test_slugify.py" } }, ctx);
  assert.equal(fake.messages.filter((item) => (item.message as { customType?: string }).customType === "pi-mesh-direct-ready-to-verify-nudge").length, 2);

  toolExecutionEnd({ toolName: "bash", isError: false, args: { command: "python -m unittest discover -s tests" } }, ctx);
  const nudges = fake.messages.filter((item) => (item.message as { customType?: string }).customType === "pi-mesh-direct-completion-nudge");
  assert.equal(nudges.length, 1);
  assert.match((nudges[0]?.message as { content?: string }).content ?? "", /python -m unittest discover -s tests/);
  assert.match((nudges[0]?.message as { content?: string }).content ?? "", /starter smoke\/empty path/);
});

test("direct bounded edits do not complete when requested tests were not changed", async () => {
  const fake = createFakePi();
  registerPiMesh(fake.api as never);
  const beforeAgentStart = fake.handlers.get("before_agent_start")?.[0] as (event: unknown, ctx: unknown) => Promise<unknown>;
  const toolExecutionEnd = fake.handlers.get("tool_execution_end")?.[0] as (event: { toolName: string; isError?: boolean; args?: Record<string, unknown> }, ctx: unknown) => void;
  const ctx = {
    cwd: tempDir("pi-mesh-direct-tests-nudge-"),
    hasUI: false,
    model: undefined,
    modelRegistry: { getAvailable: () => [] },
  };

  await beforeAgentStart({ type: "before_agent_start", prompt: "implementa src/rateLimit.ts y añade tests", systemPrompt: "base", systemPromptOptions: {} }, ctx);
  toolExecutionEnd({ toolName: "edit", isError: false, args: { path: "src/rateLimit.ts" } }, ctx);
  toolExecutionEnd({ toolName: "bash", isError: false, args: { command: "npm test" } }, ctx);

  assert.equal(fake.messages.filter((item) => (item.message as { customType?: string }).customType === "pi-mesh-direct-tests-missing-nudge").length, 1);
  assert.equal(fake.messages.filter((item) => (item.message as { customType?: string }).customType === "pi-mesh-direct-completion-nudge").length, 0);
  const missingNudge = fake.messages.find((item) => (item.message as { customType?: string }).customType === "pi-mesh-direct-tests-missing-nudge");
  assert.deepEqual(missingNudge?.options, { triggerTurn: true, deliverAs: "steer" });
  assert.match((missingNudge?.message as { content?: string }).content ?? "", /next action must be an edit\/write/i);
  assert.match((missingNudge?.message as { content?: string }).content ?? "", /non-trivial assertions/i);

  toolExecutionEnd({ toolName: "edit", isError: false, args: { path: "test/rateLimit.test.ts" } }, ctx);
  assert.equal(fake.messages.filter((item) => (item.message as { customType?: string }).customType === "pi-mesh-direct-ready-to-verify-nudge").length, 1);
  toolExecutionEnd({ toolName: "bash", isError: false, args: { command: "npm test" } }, ctx);

  assert.equal(fake.messages.filter((item) => (item.message as { customType?: string }).customType === "pi-mesh-direct-completion-nudge").length, 1);
});

test("mesh_interview asks TUI questions and persists artifact answers", async () => {
  const fake = createFakePi();
  registerPiMesh(fake.api as never);
  const tool = fake.tools.get("mesh_interview") as unknown as { execute: (...args: never[]) => Promise<{ content: Array<{ type: string; text: string }>; details: { interview?: { featureId: string; answers: Array<{ answer: string; custom: boolean; recommended: boolean }> } } }> };
  const cwd = tempDir("pi-mesh-interview-");
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
        { id: "scope", question: "What scope should pi-mesh implement first?", choices: [{ label: "MVP slice", recommended: true }, { label: "Full migration" }] },
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
  assert.match(text, /pi-mesh interview · answered/);
  assert.deepEqual(result.details.interview?.answers.map((answer) => answer.answer), ["MVP slice", "Do not touch billing yet."]);
  assert.equal(result.details.interview?.answers[0]?.recommended, true);
  assert.equal(result.details.interview?.answers[1]?.custom, true);
  assert.equal(titles.length, 2);
  assert.ok(optionsSeen[0]?.includes("MVP slice (RECOMMENDED)"));
  assert.ok(optionsSeen[0]?.includes("Custom answer…"));

  const state = JSON.parse(fs.readFileSync(path.join(cwd, ".pi-mesh", "artifacts", "features", "ambiguous-feature", "state.json"), "utf-8"));
  assert.equal(state.interviewDecisions.length, 1);
  assert.match(JSON.stringify(state), /Do not touch billing yet/);
});

test("mesh_route executes the workflow chosen by the primary Pi agent", async () => {
  const fake = createFakePi();
  registerPiMesh(fake.api as never);
  const tool = fake.tools.get("mesh_route") as unknown as { execute: (...args: never[]) => Promise<{ content: Array<{ type: string; text: string }>; details: unknown }> };
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
      cwd: tempDir("pi-mesh-tool-"),
      hasUI: true,
      ui: { setStatus: (_key: string, value: string) => statuses.push(value), notify: () => {}, setWidget: (...args: unknown[]) => widgets.push(args) },
    } as never,
  );

  const text = result.content.map((part) => part.text).join("\n");
  assert.match(text, /pi-mesh completed: scout → reviewer/);
  assert.match(text, /status: complete/);
  assert.match(text, /Final answer material:/);
  assert.match(text, /Supporting findings:/);
  assert.ok(statuses.some((status) => status.startsWith("mesh ")));
  assert.ok(statuses.some((status) => status.includes("review")));
  assert.ok(widgets.every((args) => args[1] === undefined), "mesh_route may clear the legacy widget but must not create a duplicate persistent widget");
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
  }, tempDir("pi-mesh-final-material-"));
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

test("mesh_route completion nudges the parent agent to synthesize", async () => {
  const fake = createFakePi();
  registerPiMesh(fake.api as never);
  const handler = fake.handlers.get("tool_execution_end")?.[0] as (event: unknown, ctx: unknown) => void;
  assert.equal(typeof handler, "function");

  handler({ type: "tool_execution_end", toolName: "mesh_route", isError: false, result: {} }, {});

  assert.equal(fake.messages.length, 1);
  assert.deepEqual(fake.messages[0]?.options, { triggerTurn: false, deliverAs: "steer" });
  assert.match(String((fake.messages[0]?.message as { content?: unknown }).content), /Answer the user's original prompt now/);
});

test("mesh_route approval blocks do not trigger synthesis shutdown", async () => {
  const fake = createFakePi();
  registerPiMesh(fake.api as never);
  const handler = fake.handlers.get("tool_execution_end")?.[0] as (event: unknown, ctx: unknown) => void;
  let shutdownCalled = false;

  handler(
    {
      type: "tool_execution_end",
      toolName: "mesh_route",
      isError: false,
      result: { details: { approval: { action: "ask", reason: "Route risk medium needs approval." } } },
    },
    { hasUI: false, shutdown: () => { shutdownCalled = true; } },
  );

  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(shutdownCalled, false);
  assert.equal(fake.messages.length, 1);
  assert.equal((fake.messages[0]?.message as { customType?: string }).customType, "pi-mesh-route-blocked-nudge");
  assert.match(String((fake.messages[0]?.message as { content?: unknown }).content), /did not execute work/i);
});

test("mesh_route completion exits non-interactive print mode after the tool result", async () => {
  const previousDelay = process.env.PI_MESH_NONINTERACTIVE_SHUTDOWN_DELAY_MS;
  process.env.PI_MESH_NONINTERACTIVE_SHUTDOWN_DELAY_MS = "0";
  try {
    const fake = createFakePi();
    registerPiMesh(fake.api as never);
    const handler = fake.handlers.get("tool_execution_end")?.[0] as (event: unknown, ctx: unknown) => void;
    let shutdownCalled = false;

    handler(
      { type: "tool_execution_end", toolName: "mesh_route", isError: false, result: {} },
      { hasUI: false, shutdown: () => { shutdownCalled = true; } },
    );

    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(shutdownCalled, true);
  } finally {
    if (previousDelay === undefined) delete process.env.PI_MESH_NONINTERACTIVE_SHUTDOWN_DELAY_MS;
    else process.env.PI_MESH_NONINTERACTIVE_SHUTDOWN_DELAY_MS = previousDelay;
  }
});



test("mesh_route rejects a second committed workflow in the same prompt", async () => {
  const fake = createFakePi();
  registerPiMesh(fake.api as never);
  const beforeAgentStart = fake.handlers.get("before_agent_start")?.[0] as (event: unknown, ctx: unknown) => Promise<{ systemPrompt?: string } | undefined>;
  const tool = fake.tools.get("mesh_route") as unknown as { execute: (...args: never[]) => Promise<{ content: Array<{ type: string; text: string }>; details: unknown }> };
  const ctx = {
    cwd: tempDir("pi-mesh-double-route-"),
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

  assert.match(first.content.map((part) => part.text).join("\n"), /pi-mesh completed: scout/);
  assert.match(second.content.map((part) => part.text).join("\n"), /already executed for this user prompt/);
});

test("mesh_resume continues the latest persisted paused run instead of returning partial findings", async () => {
  const fake = createFakePi();
  registerPiMesh(fake.api as never);
  const tool = fake.tools.get("mesh_resume") as unknown as { execute: (...args: never[]) => Promise<{ content: Array<{ type: string; text: string }>; details: { run?: RunState } }> };
  const cwd = tempDir("pi-mesh-resume-tool-");
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
  paused.steps[1]!.error = "pi-mesh run stopped by user.";
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


test("mesh footer text is compact and animated", () => {
  assert.equal(meshFooterText({ kind: "idle" }), "mesh ◦ idle");
  assert.equal(meshFooterText({ kind: "off" }), "mesh × off");
  assert.equal(meshFooterText({ kind: "running", intent: "branch summary", agent: "scout", completed: 0, total: 2 }, 0), "mesh ◆ branch summary · scout 0/2");
  assert.equal(meshFooterText({ kind: "running", intent: "branch summary", agent: "scout", completed: 0, total: 2 }, 1), "mesh ◇ branch summary · scout 0/2");
  assert.equal(meshFooterText({ kind: "synthesizing" }, 1), "mesh ◇ synthesizing");
  assert.equal(meshFooterText({ kind: "complete", intent: "review project" }), "mesh ✓ review project");
});

test("pi-mesh input hook lets normal prompts continue", async () => {
  const fake = createFakePi();
  registerPiMesh(fake.api as never);
  const handler = fake.handlers.get("input")?.[0] as (event: unknown, ctx: unknown) => Promise<{ action: string }>;
  const result = await handler(
    { type: "input", text: "hello mesh", source: "interactive" },
    { cwd: tempDir("pi-mesh-auto-"), hasUI: false, ui: { notify: () => {}, setStatus: () => {} }, modelRegistry: { getAvailable: () => [] } },
  );
  assert.equal(result.action, "continue");
});

test("/mesh shows active run status while subagents are running", async () => {
  const fake = createFakePi();
  registerPiMesh(fake.api as never);
  const command = fake.commands.get("mesh") as { handler: (args: string, ctx: unknown) => Promise<void>; getArgumentCompletions?: (prefix: string) => Array<{ value: string; label: string }> | null };
  assert.equal(typeof command.handler, "function");

  const run: RunState = {
    id: "mesh-live",
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
    logsPath: "/tmp/mesh-live.json",
    warnings: [],
  };
  setLatestRun(run);

  const notifications: string[] = [];
  const selectedTitles: string[] = [];
  const widgets: Array<{ key: string; content: unknown; options?: unknown }> = [];
  const statuses: string[] = [];
  await command.handler("", {
    cwd: tempDir("pi-mesh-command-"),
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

  assert.deepEqual(notifications, [], "active /mesh should open controls without printing into the transcript");
  assert.deepEqual(selectedTitles, ["pi-mesh Control"]);
  assert.ok(widgets.every((entry) => entry.content === undefined), "/mesh may clear the legacy widget but must not create a second persistent widget; the tool-result tree is the single live surface");
  assert.match(statuses.join("\n"), /mesh .*chain.*reviewer 1\/2/);
  assert.doesNotMatch(notifications.join("\n"), /Abort \(placeholder\)|run: mesh-live|step-2 running reviewer/);
});

test("mesh result widget counts budget-capped checkpoints as progressed work", () => {
  const run: RunState = {
    id: "mesh-budget-panel",
    route: { kind: "multi-agent-dag", agents: ["scout", "context-builder"], risk: "low", ambiguity: "low", needsMemory: false, needsArtifacts: true, reason: "test" },
    status: "running",
    startedAt: new Date().toISOString(),
    warnings: [],
    steps: [
      { id: "discover:step-1", agent: "scout", task: "Map project", status: "budget-capped", output: { agent: "scout", text: "partial", handoff: "Project mapped enough to continue.", memoryCandidates: [], raw: "partial", warnings: [] } },
      { id: "fanout:step-1", agent: "context-builder", task: "Analyze backend", status: "running" },
    ],
  };

  const preview = formatMeshRunWidget(run);

  assert.match(preview, /1\/2/);
  assert.match(preview, /✓ scout/);
  assert.match(preview, /Project mapped enough to continue/);
});

test("/mesh Smart Panel does not auto-open memory when pending memories exist", async () => {
  const selectedTitles: string[] = [];
  const selectedOptions: string[][] = [];
  let memoryOpened = false;

  await openSmartPanel({
    cwd: tempDir("pi-mesh-smart-memory-"),
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

  assert.deepEqual(selectedTitles, ["pi-mesh Smart Panel"]);
  assert.equal(memoryOpened, false);
  assert.ok(selectedOptions[0]?.some((option) => option === "Memory · 1 pending"));
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
    cwd: tempDir("pi-mesh-memory-ui-"),
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

  assert.equal(selections[0]?.title, "pi-mesh Memory");
  assert.equal(selections[0]?.options.length, 2);
  assert.match(selections[0]?.options[0] ?? "", /^○ pending · agent-note · context-builder · Engram is local-first/);
  assert.doesNotMatch(selections[0]?.options[0] ?? "", /SQLite is the source of truth for persistent project memory\.$/);
  assert.match(selections[1]?.title ?? "", /^Memory · Engram is local-first/);
  assert.deepEqual(selections[1]?.options, ["Details", "Approve", "Reject", "Delete", "Close"]);
  assert.match(notifications.join("\n"), /status: pending/);
  assert.match(notifications.join("\n"), /category: agent-note/);
  assert.deepEqual(approved, []);
});


test("/mesh completions expose Activity instead of technical Runs", () => {
  const fake = createFakePi();
  registerPiMesh(fake.api as never);
  const command = fake.commands.get("mesh") as { getArgumentCompletions?: (prefix: string) => Array<{ value: string; label: string }> | null };
  const completions = command.getArgumentCompletions?.("") ?? [];

  assert.ok(completions.some((item) => item.value === "activity"));
  assert.ok(!completions.some((item) => item.value === "runs"));
});


test("summarizeRuntimeGuards surfaces policy, budget, worktree, and model fallback state", () => {
  const lines = summarizeRuntimeGuards({
    id: "mesh-test",
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


test("mesh_route renders a compact agent tree widget instead of a plain tool label", () => {
  const planned = formatMeshRoutePlanWidget({
    task: "revisa este proyecto en profundidad",
    topology: "chain",
    steps: [
      { agent: "scout", task: "Map project structure and high-signal files." },
      { agent: "context-builder", task: "Synthesize findings for the user." },
    ],
  });

  assert.match(planned, /pi-mesh · chain/);
  assert.match(planned, /├ ○ scout/);
  assert.match(planned, /└ ○ context-builder/);
  assert.doesNotMatch(planned, /^mesh_route$/m);

  const running = formatMeshRunWidget({
    id: "mesh-test",
    route: { kind: "multi-agent-chain", agents: ["scout", "context-builder"], risk: "low", ambiguity: "low", needsMemory: false, needsArtifacts: true, reason: "test" },
    status: "running",
    startedAt: new Date().toISOString(),
    warnings: [],
    steps: [
      { id: "step-1", agent: "scout", task: "Map project.", status: "complete", output: { agent: "scout", text: "mapped", handoff: "src/index.ts is the entrypoint", memoryCandidates: [], raw: "mapped", warnings: [] } },
      { id: "step-2", agent: "context-builder", task: "Synthesize.", status: "running" },
    ],
  });

  assert.match(running, /pi-mesh · understand · running · 1\/2/);
  assert.match(running, /├ ✓ scout/);
  assert.match(running, /└ ◆ context-builder/);
  assert.match(running, /tools: 0 · guards: checking/);
});

test("mesh_route marks budget-capped handoff steps as checkpointed, not pending", () => {
  const running = formatMeshRunWidget({
    id: "mesh-budget-live",
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

test("mesh_route failed DAG highlights the failed step and marks downstream pending work as skipped", () => {
  const failed = formatMeshRunWidget({
    id: "mesh-failed-dag",
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

  assert.match(failed, /pi-mesh · understand · failed · 1\/3/);
  assert.match(failed, /blocked: context-builder — SDK runner timed out/);
  assert.match(failed, /× context-builder — SDK runner timed out/);
  assert.match(failed, /○ context-builder — skipped after failure/);
  assert.doesNotMatch(failed, /current: context-builder — Synthesize final answer/);
  assert.doesNotMatch(failed, /context-builder — working/);
});


test("summarizeRuntimeGuards labels budget-only caps without scary attention", () => {
  const lines = summarizeRuntimeGuards({
    id: "mesh-budget",
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
