import assert from "node:assert/strict";
import * as fs from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, test } from "bun:test";
import { createChildToolPolicy, createChildTools } from "../src/child-tools.ts";
import { DEFAULT_CONFIG, type ChalinConfig } from "../src/config.ts";
import { ChalinKernel, routeFromPlan } from "../src/kernel.ts";
import { createMemoryCandidate, MemoryStore } from "../src/memory.ts";
import { createConfiguredMemoryStore, EngramMemoryStore, resolveMemoryBackendStatus } from "../src/memory-provider.ts";
import type { WorkerRunner, WorkerRunnerContext } from "../src/runner.ts";
import type { RouteDecision, RunState } from "../src/schemas.ts";

const tempDirs: string[] = [];
const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  while (tempDirs.length > 0) fs.rmSync(tempDirs.pop()!, { recursive: true, force: true });
});

function tempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

test("EngramMemoryStore saves retrieves and revises through the Engram HTTP API", async () => {
  const fake = await startFakeEngram();
  const cwd = tempDir("pi-chalin-engram-");
  const store = new EngramMemoryStore({
    cwd,
    config: {
      baseUrl: fake.url,
      command: "engram",
      autoStart: false,
      autoSync: true,
      syncThrottleMs: 30_000,
      timeoutMs: 1_000,
      project: "fake-project",
    },
  });

  const [record] = await store.submitCandidates([
    createMemoryCandidate({
      category: "testing",
      content: "Retry tests should use deterministic coordination instead of wall-clock sleeps when asserting concurrent behavior.",
      sourceAgent: "reviewer",
      confidence: 0.94,
      evidence: "Fake Engram contract test",
      scope: "project",
      topicKey: "testing/retry-coordination",
    }),
  ]);

  assert.match(record?.id ?? "", /^engram-\d+$/);
  assert.equal(fake.observations[0]?.project, "fake-project");
  assert.equal(fake.observations[0]?.type, "pattern");

  const bundle = await store.retrieve({ query: "retry deterministic sleeps", sourceAgent: "worker", tokenBudget: 160, limit: 5 });
  assert.match(bundle.text, /Engram memory context/);
  assert.match(bundle.text, /Retry tests should use deterministic coordination/i);

  const revised = await store.revise(record!.id, {
    content: "Retry tests should use fake timers or channel barriers instead of wall-clock sleeps.",
    sourceAgent: "reviewer",
    confidence: 0.98,
    evidence: "Revision names concrete deterministic mechanisms.",
  });

  assert.match(revised?.content ?? "", /fake timers or channel barriers/);
  assert.equal(await store.delete(record!.id), true);
});

test("auto memory provider falls back to pi-chalin local storage when Engram is unavailable", async () => {
  const cwd = tempDir("pi-chalin-auto-memory-");
  const config: ChalinConfig = {
    ...structuredClone(DEFAULT_CONFIG),
    memory: {
      provider: "auto",
      engram: {
        ...structuredClone(DEFAULT_CONFIG.memory.engram),
        baseUrl: "http://127.0.0.1:9",
        timeoutMs: 100,
      },
    },
  };
  const store = createConfiguredMemoryStore({ cwd }, config);
  const [record] = await store.submitCandidates([
    createMemoryCandidate({
      category: "testing",
      content: "Project tests should keep temporary roots isolated so memory provider fallback checks do not share filesystem state.",
      sourceAgent: "reviewer",
      confidence: 0.95,
      scope: "project",
    }),
  ]);

  assert.ok(record);
  assert.doesNotMatch(record.id, /^engram-/);
  const results = await store.search("temporary roots isolated fallback");
  assert.equal(results.length, 1);

  const status = await resolveMemoryBackendStatus({ cwd }, config);
  assert.equal(status.activeProvider, "pi-chalin");
  assert.equal(status.engramAvailable, false);
});

test("ChalinKernel uses Engram across a chained subagent route", async () => {
  const fake = await startFakeEngram();
  const cwd = tempDir("pi-chalin-engram-chain-");
  fake.observations.push(fakeObservation({
    id: 1,
    type: "architecture",
    title: "Provider migration risks",
    content: "Provider migration risks require preserving Engram retrieval and pi-chalin local fallback during chained subagent orchestration.",
  }));
  const config = engramConfig(fake.url);
  const route = routeFromPlan({
    topology: "chain",
    needsMemory: true,
    needsArtifacts: false,
    steps: [
      { agent: "scout", task: "Recall provider migration risks and map relevant constraints." },
      { agent: "reviewer", task: "Review the memory-backed provider plan." },
    ],
  });
  const runner: WorkerRunner = {
    async run(inputRoute: RouteDecision, context: WorkerRunnerContext): Promise<RunState> {
      assert.ok(context.agents.has("scout"));
      assert.ok(context.agents.has("reviewer"));
      const now = new Date().toISOString();
      return {
        id: "engram-chain-run",
        route: inputRoute,
        status: "complete",
        startedAt: now,
        endedAt: now,
        warnings: [],
        steps: [
          {
            id: "step-1",
            agent: "scout",
            task: "Recall provider migration risks and map relevant constraints.",
            status: "complete",
            output: {
              agent: "scout",
              text: "Scout used Engram-backed memory before planning.",
              handoff: "Engram-backed memory says preserve local fallback during provider migration.",
              raw: "",
              warnings: [],
              memoryCandidates: [createMemoryCandidate({
                category: "architecture",
                content: "Engram provider integration should preserve pi-chalin local fallback during chained subagent routing.",
                sourceAgent: "scout",
                confidence: 0.96,
                scope: "project",
                topicKey: "architecture/memory-provider-fallback",
              })],
            },
          },
          {
            id: "step-2",
            agent: "reviewer",
            task: "Review the memory-backed provider plan.",
            status: "complete",
            output: {
              agent: "reviewer",
              text: "Reviewer validated that Engram is advisory and repo evidence still wins.",
              handoff: "Final answer should mention Engram retrieval, fallback, and tests.",
              raw: "",
              warnings: [],
              memoryCandidates: [createMemoryCandidate({
                category: "testing",
                content: "Engram provider tests should cover chained subagent retrieval before execution and candidate persistence after execution.",
                sourceAgent: "reviewer",
                confidence: 0.95,
                scope: "project",
                topicKey: "testing/engram-provider-chain",
              })],
            },
          },
        ],
      };
    },
  };

  const result = await new ChalinKernel({ cwd, config, runner }).handleRoute(route, "provider migration risks", { cwd });

  assert.equal(result.approval.action, "allow");
  assert.equal(result.run?.status, "complete");
  assert.equal(result.memories[0]?.id, "engram-1");
  assert.match(result.memories[0]?.content ?? "", /chained subagent orchestration/);
  assert.ok(fake.requests.some((request) => request.startsWith("GET /search?q=provider")));
  assert.ok(fake.observations.some((observation) => observation.content.includes("chained subagent routing")));
  assert.ok(fake.observations.some((observation) => observation.content.includes("candidate persistence after execution")));
});

test("subagent memory tools honor project-configured Engram provider", async () => {
  const fake = await startFakeEngram();
  const cwd = tempDir("pi-chalin-engram-child-tools-");
  writeJson(path.join(cwd, ".pi-chalin", "config.json"), { memory: engramConfig(fake.url).memory });
  fake.observations.push(fakeObservation({
    id: 1,
    type: "pattern",
    title: "Bun async retry assertions",
    content: "Bun async retry assertions should use deterministic fake timers or promise hooks instead of setTimeout sleeps.",
  }));
  const policy = createChildToolPolicy({
    cwd,
    maxToolCalls: 6,
    agentName: "worker",
    allowedTools: ["chalin_memory_search", "chalin_memory_write", "chalin_memory_revise"],
  });
  const tools = createChildTools(policy);
  const search = tools.find((tool) => tool.name === "chalin_memory_search");
  const write = tools.find((tool) => tool.name === "chalin_memory_write");
  const revise = tools.find((tool) => tool.name === "chalin_memory_revise");
  assert.ok(search);
  assert.ok(write);
  assert.ok(revise);

  const found = await search.execute("mem-1", { query: "Bun async retry assertions", tokenBudget: 160 }, undefined, undefined, undefined as never);
  assert.match(String((found.content?.[0] as { text?: string } | undefined)?.text ?? ""), /Engram memory context/);

  const written = await write.execute("mem-2", {
    category: "workflow",
    content: "Worker subagents should retrieve Engram memory before repeating broad repository discovery on provider-sensitive tasks.",
    confidence: 0.94,
    evidence: "subagent Engram provider contract test",
    topicKey: "workflow/engram-before-discovery",
  }, undefined, undefined, undefined as never);
  const record = (written.details as { record?: { id?: string } } | undefined)?.record;
  assert.match(String(record?.id ?? ""), /^engram-\d+$/);

  const revised = await revise.execute("mem-3", {
    id: record!.id,
    content: "Worker subagents should retrieve Engram memory before repeating broad repository discovery, then revise stale memories when evidence changes.",
    evidence: "subagent revise path through Engram",
    reason: "The revised memory includes the stale-memory correction behavior.",
  }, undefined, undefined, undefined as never);
  assert.match(String((revised.content?.[0] as { text?: string } | undefined)?.text ?? ""), /memory revised/);
  assert.ok(fake.requests.some((request) => request.startsWith("PATCH /observations/")));
  assert.equal(policy.metrics().toolCalls, 3);
});

test("Engram provider suppresses local approve reject review flow", async () => {
  const fake = await startFakeEngram();
  const cwd = tempDir("pi-chalin-engram-no-review-");
  const local = new MemoryStore({ cwd });
  const [active] = await local.submitCandidates([createMemoryCandidate({
    category: "project-fact",
    content: "Local active memories should not appear in the memory panel while Engram is the configured memory provider.",
    sourceAgent: "reviewer",
    confidence: 0.97,
    scope: "project",
  })]);
  const [pending] = await local.submitCandidates([createMemoryCandidate({
    category: "decision",
    content: "Local pending decisions should not appear in the approval review flow while Engram is the configured memory provider.",
    sourceAgent: "planner",
    confidence: 0.92,
    scope: "project",
  })]);
  assert.equal(pending?.status, "pending");
  fake.observations.push(fakeObservation({
    id: 1,
    type: "architecture",
    title: "Engram active observation",
    content: "Engram active observations are shown directly without pi-chalin approve or reject workflow.",
  }), fakeObservation({
    id: 2,
    type: "manual",
    title: "Personal cloud observation",
    content: "Personal cloud Engram observations should appear in pi-chalin memory when Engram is the selected provider.",
    scope: "personal",
  }));

  const store = createConfiguredMemoryStore({ cwd }, engramConfig(fake.url));

  assert.equal(active?.status, "active");
  assert.equal(await store.pendingCount(), 0);
  assert.deepEqual(await store.list("pending"), []);
  assert.equal(await store.approve(pending!.id), undefined);
  assert.equal(await store.reject(pending!.id), undefined);
  const records = await store.list();
  assert.deepEqual(records.map((record) => record.id), ["engram-1", "engram-2"]);
  assert.equal(records.some((record) => record.id === active!.id), false);
  assert.equal(records.some((record) => record.status === "pending"), false);
  assert.equal(records.find((record) => record.id === "engram-2")?.scope, "user");
  assert.ok(fake.requests.some((request) => request.startsWith("GET /observations/recent?project=fake-project&limit=100")));
  assert.equal(fake.requests.some((request) => request.startsWith("GET /observations/recent") && request.includes("scope=")), false);

  const search = await store.search("personal cloud");
  assert.deepEqual(search.map((result) => result.record.id), ["engram-2"]);
  assert.equal(fake.requests.some((request) => request.startsWith("GET /search") && request.includes("scope=")), false);
});

test("Engram preferred memory stays Engram-only when Engram is unavailable", async () => {
  const cwd = tempDir("pi-chalin-engram-fallback-no-review-");
  const local = new MemoryStore({ cwd });
  const [active] = await local.submitCandidates([createMemoryCandidate({
    category: "project-fact",
    content: "Local active fallback memory may still be retrieved when Engram is unavailable in preferred-provider mode.",
    sourceAgent: "reviewer",
    confidence: 0.95,
    scope: "project",
  })]);
  const [pending] = await local.submitCandidates([createMemoryCandidate({
    category: "decision",
    content: "Local pending fallback memory should stay hidden because Engram mode does not expose approve or reject review semantics.",
    sourceAgent: "planner",
    confidence: 0.95,
    scope: "project",
  })]);

  const config = engramConfig("http://127.0.0.1:9");
  config.memory.engram.timeoutMs = 100;
  const store = createConfiguredMemoryStore({ cwd }, config);

  assert.equal(active?.status, "active");
  assert.equal(pending?.status, "pending");
  assert.equal(await store.pendingCount(), 0);
  assert.deepEqual(await store.list("pending"), []);
  const records = await store.list();
  assert.deepEqual(records, []);

  const fallbackResults = await store.search("fallback memory unavailable preferred-provider");
  assert.deepEqual(fallbackResults, []);
  const saved = await store.submitCandidates([createMemoryCandidate({
    category: "testing",
    content: "Engram-preferred writes should not claim local persistence when Engram is unavailable.",
    sourceAgent: "reviewer",
    confidence: 0.96,
    scope: "project",
  })]);
  assert.deepEqual(saved, []);
  const status = await resolveMemoryBackendStatus({ cwd }, config);
  assert.equal(status.configuredProvider, "engram");
  assert.equal(status.activeProvider, "unavailable");
  assert.match(status.summary, /engram unavailable/);
});

test("Engram preferred memory treats null Engram collections as empty without local fallback", async () => {
  const fake = await startFakeEngram({ nullCollections: true });
  const cwd = tempDir("pi-chalin-engram-null-collections-");
  const local = new MemoryStore({ cwd });
  const [active] = await local.submitCandidates([createMemoryCandidate({
    category: "project-fact",
    content: "Local active records must not leak into Engram-preferred retrieval when Engram returns an empty collection.",
    sourceAgent: "reviewer",
    confidence: 0.96,
    scope: "project",
  })]);
  const store = createConfiguredMemoryStore({ cwd }, engramConfig(fake.url));

  assert.equal(active?.status, "active");
  assert.deepEqual(await store.list(), []);
  assert.deepEqual(await store.search("Local active records must not leak"), []);
  const bundle = await store.retrieve({ query: "Local active records must not leak", sourceAgent: "worker", limit: 5, tokenBudget: 200 });
  assert.deepEqual(bundle.results, []);
  assert.equal(await store.pendingCount(), 0);
});

test("Engram provider honors ENGRAM_PORT like gentle-engram", async () => {
  const fake = await startFakeEngram();
  const cwd = tempDir("pi-chalin-engram-env-port-");
  fake.observations.push(fakeObservation({
    id: 1,
    type: "workflow",
    title: "Shared Engram port",
    content: "pi-chalin should use the same ENGRAM_PORT contract as gentle-engram when ENGRAM_URL is not set.",
  }));
  const previousUrl = process.env.ENGRAM_URL;
  const previousPort = process.env.ENGRAM_PORT;
  delete process.env.ENGRAM_URL;
  process.env.ENGRAM_PORT = new URL(fake.url).port;

  try {
    const config = engramConfig(DEFAULT_CONFIG.memory.engram.baseUrl);
    const status = await resolveMemoryBackendStatus({ cwd }, config);
    const store = createConfiguredMemoryStore({ cwd }, config);
    const records = await store.list();

    assert.equal(status.activeProvider, "engram");
    assert.equal(status.summary, `engram (${fake.url})`);
    assert.deepEqual(records.map((record) => record.id), ["engram-1"]);
  } finally {
    if (previousUrl === undefined) delete process.env.ENGRAM_URL;
    else process.env.ENGRAM_URL = previousUrl;
    if (previousPort === undefined) delete process.env.ENGRAM_PORT;
    else process.env.ENGRAM_PORT = previousPort;
  }
});

test("Engram status explains when cloud sync is enabled but Pi lacks runtime token", async () => {
  const fake = await startFakeEngram({ syncEnabled: true });
  const cwd = tempDir("pi-chalin-engram-cloud-token-diagnostic-");
  const previousToken = process.env.ENGRAM_CLOUD_TOKEN;
  const previousInsecure = process.env.ENGRAM_CLOUD_INSECURE_NO_AUTH;
  delete process.env.ENGRAM_CLOUD_TOKEN;
  delete process.env.ENGRAM_CLOUD_INSECURE_NO_AUTH;

  try {
    const status = await resolveMemoryBackendStatus({ cwd }, engramConfig(fake.url));

    assert.equal(status.activeProvider, "engram");
    assert.match(status.detail ?? "", /ENGRAM_CLOUD_TOKEN/);
    assert.match(status.detail ?? "", /fake-project/);
  } finally {
    if (previousToken === undefined) delete process.env.ENGRAM_CLOUD_TOKEN;
    else process.env.ENGRAM_CLOUD_TOKEN = previousToken;
    if (previousInsecure === undefined) delete process.env.ENGRAM_CLOUD_INSECURE_NO_AUTH;
    else process.env.ENGRAM_CLOUD_INSECURE_NO_AUTH = previousInsecure;
  }
});

test("Engram provider imports enrolled cloud memory before local reads", async () => {
  const fake = await startFakeEngram({ syncEnabled: true });
  const cwd = tempDir("pi-chalin-engram-auto-import-");
  const spy = writeSyncSpy(cwd);
  const config = engramConfig(fake.url);
  config.memory.engram.command = spy.command;
  config.memory.engram.syncThrottleMs = 0;
  fake.observations.push(fakeObservation({
    id: 1,
    type: "testing",
    title: "Imported cloud observation",
    content: "Imported cloud observations should be visible after pi-chalin triggers Engram cloud import.",
  }));
  const previousToken = process.env.ENGRAM_CLOUD_TOKEN;
  const previousLog = process.env.ENGRAM_SYNC_LOG;
  process.env.ENGRAM_CLOUD_TOKEN = "test-token";
  process.env.ENGRAM_SYNC_LOG = spy.log;

  try {
    const store = createConfiguredMemoryStore({ cwd }, config);
    const records = await store.list();

    assert.deepEqual(records.map((record) => record.id), ["engram-1"]);
    assert.match(fs.readFileSync(spy.log, "utf-8"), /sync --cloud --import --project fake-project/);
    assert.ok(fake.requests.some((request) => request.startsWith("GET /sync/status?project=fake-project")));
  } finally {
    if (previousToken === undefined) delete process.env.ENGRAM_CLOUD_TOKEN;
    else process.env.ENGRAM_CLOUD_TOKEN = previousToken;
    if (previousLog === undefined) delete process.env.ENGRAM_SYNC_LOG;
    else process.env.ENGRAM_SYNC_LOG = previousLog;
  }
});

test("Engram provider retries cloud import when sync status has stale degraded reason", async () => {
  const fake = await startFakeEngram({
    syncEnabled: true,
    syncReasonCode: "blocked_unenrolled",
    syncReasonMessage: "project \"fake-project\" is not enrolled for cloud sync",
  });
  const cwd = tempDir("pi-chalin-engram-stale-sync-reason-");
  const spy = writeSyncSpy(cwd);
  const config = engramConfig(fake.url);
  config.memory.engram.command = spy.command;
  config.memory.engram.syncThrottleMs = 0;
  fake.observations.push(fakeObservation({
    id: 1,
    type: "workflow",
    title: "Stale sync reason",
    content: "pi-chalin should retry cloud import when Engram reports enabled sync with an old degraded reason.",
  }));
  const previousToken = process.env.ENGRAM_CLOUD_TOKEN;
  const previousLog = process.env.ENGRAM_SYNC_LOG;
  process.env.ENGRAM_CLOUD_TOKEN = "test-token";
  process.env.ENGRAM_SYNC_LOG = spy.log;

  try {
    const status = await resolveMemoryBackendStatus({ cwd }, config);
    const store = createConfiguredMemoryStore({ cwd }, config);
    const records = await store.list();

    assert.match(status.detail ?? "", /previous degraded state/);
    assert.deepEqual(records.map((record) => record.id), ["engram-1"]);
    assert.match(fs.readFileSync(spy.log, "utf-8"), /sync --cloud --import --project fake-project/);
  } finally {
    if (previousToken === undefined) delete process.env.ENGRAM_CLOUD_TOKEN;
    else process.env.ENGRAM_CLOUD_TOKEN = previousToken;
    if (previousLog === undefined) delete process.env.ENGRAM_SYNC_LOG;
    else process.env.ENGRAM_SYNC_LOG = previousLog;
  }
});

interface FakeObservation {
  id: number;
  session_id: string;
  type: string;
  title: string;
  content: string;
  project: string;
  scope: string;
  topic_key?: string;
  revision_count: number;
  duplicate_count: number;
  created_at: string;
  updated_at: string;
}

async function startFakeEngram(options: { nullCollections?: boolean; syncEnabled?: boolean; syncReasonCode?: string; syncReasonMessage?: string } = {}): Promise<{ url: string; observations: FakeObservation[]; requests: string[] }> {
  const observations: FakeObservation[] = [];
  const requests: string[] = [];
  const server = createServer(async (req, res) => {
    requests.push(`${req.method ?? "GET"} ${req.url ?? "/"}`);
    try {
      await handleFakeEngram(req, res, observations, options);
    } catch (error) {
      json(res, 500, { error: error instanceof Error ? error.message : String(error) });
    }
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return { url: `http://127.0.0.1:${address.port}`, observations, requests };
}

async function handleFakeEngram(req: IncomingMessage, res: ServerResponse, observations: FakeObservation[], options: { nullCollections?: boolean; syncEnabled?: boolean; syncReasonCode?: string; syncReasonMessage?: string }): Promise<void> {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  if (req.method === "GET" && url.pathname === "/health") return json(res, 200, { status: "ok", service: "engram" });
  if (req.method === "GET" && url.pathname === "/project/current") return json(res, 200, { project: "fake-project" });
  if (req.method === "GET" && url.pathname === "/sync/status") {
    return json(res, 200, {
      enabled: Boolean(options.syncEnabled),
      phase: options.syncEnabled ? "pending" : "disabled",
      reason_code: options.syncReasonCode ?? "",
      reason_message: options.syncReasonMessage ?? "",
    });
  }
  if (req.method === "POST" && url.pathname === "/sessions") return json(res, 201, { status: "created" });
  if (req.method === "POST" && url.pathname === "/observations") {
    const body = await readJson(req);
    const now = new Date().toISOString();
    const observation: FakeObservation = {
      id: observations.length + 1,
      session_id: String(body.session_id),
      type: String(body.type),
      title: String(body.title),
      content: String(body.content),
      project: String(body.project),
      scope: String(body.scope),
      ...(body.topic_key ? { topic_key: String(body.topic_key) } : {}),
      revision_count: 1,
      duplicate_count: 1,
      created_at: now,
      updated_at: now,
    };
    observations.push(observation);
    return json(res, 201, { id: observation.id, status: "saved" });
  }
  if (req.method === "GET" && url.pathname === "/search") {
    if (options.nullCollections) return json(res, 200, null);
    const query = (url.searchParams.get("q") ?? "").toLowerCase();
    const terms = query.split(/\s+/).filter(Boolean);
    const results = filterFakeObservations(observations, url)
      .filter((observation) => terms.every((term) => `${observation.title} ${observation.content}`.toLowerCase().includes(term)))
      .map((observation) => ({ ...observation, rank: -1 }));
    return json(res, 200, results);
  }
  if (req.method === "GET" && url.pathname === "/observations/recent") return json(res, 200, options.nullCollections ? null : filterFakeObservations(observations, url));
  const observationMatch = url.pathname.match(/^\/observations\/(\d+)$/);
  if (observationMatch) {
    const id = Number(observationMatch[1]);
    const observation = observations.find((candidate) => candidate.id === id);
    if (!observation) return json(res, 404, { error: "not found" });
    if (req.method === "GET") return json(res, 200, observation);
    if (req.method === "PATCH") {
      const body = await readJson(req);
      if (body.type) observation.type = String(body.type);
      if (body.content) observation.content = String(body.content);
      if (body.topic_key) observation.topic_key = String(body.topic_key);
      observation.revision_count += 1;
      observation.updated_at = new Date().toISOString();
      return json(res, 200, observation);
    }
    if (req.method === "DELETE") {
      observations.splice(observations.indexOf(observation), 1);
      return json(res, 200, { id, status: "deleted" });
    }
  }
  return json(res, 404, { error: "not found" });
}

function filterFakeObservations(observations: FakeObservation[], url: URL): FakeObservation[] {
  const project = url.searchParams.get("project");
  const scope = url.searchParams.get("scope");
  return observations.filter((observation) => {
    if (project && observation.project !== project) return false;
    if (scope && observation.scope !== scope) return false;
    return true;
  });
}

function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let body = "";
    req.setEncoding("utf-8");
    req.on("data", (chunk) => { body += chunk; });
    req.on("error", reject);
    req.on("end", () => {
      try {
        resolve(body ? JSON.parse(body) as Record<string, unknown> : {});
      } catch (error) {
        reject(error);
      }
    });
  });
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

function engramConfig(baseUrl: string): ChalinConfig {
  return {
    ...structuredClone(DEFAULT_CONFIG),
    memory: {
      provider: "engram",
      engram: {
        ...structuredClone(DEFAULT_CONFIG.memory.engram),
        baseUrl,
        timeoutMs: 1_000,
        project: "fake-project",
      },
    },
  };
}

function fakeObservation(input: Pick<FakeObservation, "id" | "type" | "title" | "content"> & Partial<FakeObservation>): FakeObservation {
  const now = new Date().toISOString();
  return {
    session_id: "seed-session",
    project: "fake-project",
    scope: "project",
    revision_count: 1,
    duplicate_count: 1,
    created_at: now,
    updated_at: now,
    ...input,
  };
}

function writeJson(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf-8");
}

function writeSyncSpy(dir: string): { command: string; log: string } {
  const command = path.join(dir, "engram-sync-spy.sh");
  const log = path.join(dir, "engram-sync.log");
  fs.writeFileSync(command, "#!/bin/sh\nprintf '%s\\n' \"$*\" >> \"$ENGRAM_SYNC_LOG\"\n", "utf-8");
  fs.chmodSync(command, 0o755);
  return { command, log };
}
