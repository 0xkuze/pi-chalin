import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, test } from "bun:test";
import { ChalinKernel, routeFromPlan } from "../src/kernel.ts";
import { createMemoryCandidate, MemoryStore } from "../src/memory.ts";
import type { WorkerRunner, WorkerRunnerContext } from "../src/runner.ts";
import type { RouteDecision, RunState } from "../src/schemas.ts";

const tempDirs: string[] = [];
afterEach(() => { while (tempDirs.length > 0) fs.rmSync(tempDirs.pop()!, { recursive: true, force: true }); });
function tempDir(prefix: string): string { const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix)); tempDirs.push(dir); return dir; }

test("ChalinKernel no longer hard-codes prompt routing decisions", () => {
  const route = new ChalinKernel({ cwd: tempDir("pi-chalin-kernel-") }).classify("review this project");
  assert.equal(route.kind, "bypass");
  assert.deepEqual(route.agents, []);
  assert.match(route.reason, /LLM-first routing/i);
});

test("routeFromPlan builds a dynamic chain chosen by the primary Pi agent", () => {
  const route = routeFromPlan({ topology: "chain" });
  assert.equal(route.kind, "ask-user");
});

test("routeFromPlan builds chain, parallel, single, and memory-only workflows", () => {
  const chain = routeFromPlan({
    topology: "chain",
    steps: [
      { agent: "scout", task: "Map project structure and constraints." },
      { agent: "reviewer", task: "Review high-signal findings." },
    ],
    reason: "Need scoped context before review.",
  });
  assert.equal(chain.kind, "multi-agent-chain");
  assert.deepEqual(chain.agents, ["scout", "reviewer"]);
  assert.equal(chain.plan?.kind, "chain");

  const parallel = routeFromPlan({
    topology: "parallel",
    steps: [
      { agent: "scout", task: "Inspect local architecture." },
      { agent: "planner", task: "Evaluate improvement paths." },
    ],
  });
  assert.equal(parallel.kind, "multi-agent-parallel");
  assert.equal(parallel.plan?.kind, "parallel");

  const single = routeFromPlan({ topology: "single", steps: [{ agent: "reviewer", task: "Review this diff." }] });
  assert.equal(single.kind, "single-agent");
  assert.equal(single.plan?.kind, "single");

  const memory = routeFromPlan({ topology: "memory-only" });
  assert.equal(memory.kind, "memory-only");
  assert.equal(memory.needsMemory, true);
});

test("routeFromPlan builds staged DAG workflows chosen by the primary Pi agent", () => {
  const dag = routeFromPlan({
    topology: "dag",
    stages: [
      { id: "discover", tasks: [{ agent: "scout", task: "Map project modules." }] },
      {
        id: "fanout",
        tasks: [
          { agent: "context-builder", task: "Analyze src/auth." },
          { agent: "context-builder", task: "Analyze src/billing." },
        ],
      },
      { id: "review", tasks: [{ agent: "reviewer", task: "Synthesize risks." }] },
    ],
  });

  assert.equal(dag.kind, "multi-agent-dag");
  assert.deepEqual(dag.agents, ["scout", "context-builder", "context-builder", "reviewer"]);
  assert.equal(dag.plan?.kind, "dag");
  assert.deepEqual(dag.plan?.stages.map((stage) => stage.id), ["discover", "fanout", "review"]);
});

test("ChalinKernel executes an LLM-planned mock route", async () => {
  const cwd = tempDir("pi-chalin-kernel-");
  const route = routeFromPlan({ topology: "single", steps: [{ agent: "reviewer", task: "Review this diff for bugs." }] });
  const result = await new ChalinKernel({ cwd }).handleRoute(route, "review this diff for bugs", { cwd });
  assert.equal(result.route.kind, "single-agent");
  assert.equal(result.approval.action, "allow");
  assert.equal(result.run?.status, "complete");
  assert.equal(result.run?.steps[0]?.agent, "reviewer");
});

test("ChalinKernel does not block SDK tool results on memory persistence", async () => {
  const cwd = tempDir("pi-chalin-kernel-memory-");
  const route = routeFromPlan({ topology: "single", steps: [{ agent: "reviewer", task: "Summarize findings." }] });
  const previousDelay = process.env.PI_CHALIN_MEMORY_PERSIST_DELAY_MS;
  process.env.PI_CHALIN_MEMORY_PERSIST_DELAY_MS = "0";
  let memoryPersisted = false;
  try {
    class SlowMemoryStore extends MemoryStore {
      override async submitCandidates() {
        await new Promise((resolve) => setTimeout(resolve, 150));
        memoryPersisted = true;
        return [];
      }
    }
    const runner: WorkerRunner = {
      async run(inputRoute: RouteDecision, _context: WorkerRunnerContext): Promise<RunState> {
        return {
          id: "chalin-test",
          route: inputRoute,
          status: "complete",
          startedAt: new Date().toISOString(),
          endedAt: new Date().toISOString(),
          warnings: [],
          steps: [{
            id: "step-1",
            agent: "reviewer",
            task: "Summarize findings.",
            status: "complete",
            output: {
              agent: "reviewer",
              text: "Use exact URL normalization tests.",
              handoff: "Use exact URL normalization tests.",
              raw: "## Memory Candidates\n- tooling: This project should keep auth URL normalization tests exact and idempotent.",
              warnings: [],
              memoryCandidates: [createMemoryCandidate({
                category: "tooling",
                content: "This project should keep auth URL normalization tests exact and idempotent.",
                sourceAgent: "reviewer",
                confidence: 0.8,
                scope: "project",
              })],
            },
          }],
        };
      },
    };

    const startedAt = Date.now();
    const result = await new ChalinKernel({ cwd, memory: new SlowMemoryStore({ cwd }), sdkRunner: runner }).handleRoute(route, "summarize", {
      cwd,
      extensionContext: { cwd, hasUI: false } as never,
    });

    assert.equal(result.run?.status, "complete");
    assert.ok(Date.now() - startedAt < 100, "SDK route should return before slow memory persistence finishes");
    await new Promise((resolve) => setTimeout(resolve, 170));
    assert.equal(memoryPersisted, true);
  } finally {
    if (previousDelay === undefined) delete process.env.PI_CHALIN_MEMORY_PERSIST_DELAY_MS;
    else process.env.PI_CHALIN_MEMORY_PERSIST_DELAY_MS = previousDelay;
  }
});
