import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "vitest";
import { AgentCatalog } from "../src/agents/agents.ts";
import { routeFromPlan } from "../src/kernel/kernel.ts";
import { planChalinRoute, validateChalinRoutePlannerOutput } from "../src/routing/route-planner.ts";
import { formatChalinRouteRequestWidget } from "../src/routing/route-widget.ts";
import { loadFailedRunDiagnostic } from "../src/runner/run-recovery.ts";
import { createRunState, loadResumableRunState, persistRun } from "../src/runner/runner-state.ts";
import { beginChalinTurn, hasInlineToolStarted, recordInlineToolStart } from "../src/runtime/state.ts";

function tempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

test("routeFromPlan normalizes human budget aliases", () => {
  const cases = [
    ["small", "tight"],
    ["medium", "normal"],
    ["large", "deep"],
  ] as const;

  for (const [input, expected] of cases) {
    const route = routeFromPlan({
      topology: "sequential",
      expectedEffects: ["read"],
      steps: [
        {
          agent: "scout",
          task: "Map a bounded local evidence surface.",
          budget: input,
        },
      ],
    });

    assert.equal(route.plan?.kind, "sequential");
    assert.equal(route.plan?.kind === "sequential" ? route.plan.steps[0]?.budget : undefined, expected);
  }
});

test("runtime records whether chalin_route already started in the current turn", () => {
  beginChalinTurn({ prompt: "inspect repo", cwd: process.cwd() });

  assert.equal(hasInlineToolStarted("chalin_route"), false);
  recordInlineToolStart({ toolName: "chalin_route" });
  assert.equal(hasInlineToolStarted("chalin_route"), true);

  beginChalinTurn({ prompt: "new turn", cwd: process.cwd() });
  assert.equal(hasInlineToolStarted("chalin_route"), false);
});

test("resumable run lookup is isolated to the originating Pi session", () => {
  const cwd = tempDir("pi-chalin-session-resume-");
  const route = routeFromPlan({
    topology: "sequential",
    expectedEffects: ["read"],
    steps: [
      {
        agent: "scout",
        task: "Map a bounded local evidence surface.",
      },
    ],
  });
  const run = createRunState(route, cwd, "Map project", { sessionId: "session-a" });
  run.status = "paused";
  run.steps[0]!.status = "pending";
  persistRun(run);

  assert.equal(loadResumableRunState({ cwd, recoverStale: false, sessionId: "session-b" }), undefined);
  assert.equal(loadResumableRunState({ cwd, recoverStale: false, sessionId: "session-a" })?.id, run.id);
});

test("failed run diagnostics are isolated to the originating Pi session", () => {
  const cwd = tempDir("pi-chalin-session-failed-");
  const route = routeFromPlan({
    topology: "sequential",
    expectedEffects: ["read"],
    steps: [
      {
        agent: "scout",
        task: "Map a bounded local evidence surface.",
      },
    ],
  });
  const run = createRunState(route, cwd, "Map project", { sessionId: "session-a" });
  run.status = "failed";
  run.steps[0]!.status = "failed";
  run.steps[0]!.error = "tool validation failed";
  persistRun(run);

  assert.equal(loadFailedRunDiagnostic({ cwd, sessionId: "session-b" }), undefined);
  assert.equal(loadFailedRunDiagnostic({ cwd, sessionId: "session-a" })?.run.id, run.id);
});

test("route request widget avoids displaying a stale-looking execution plan", () => {
  const text = formatChalinRouteRequestWidget({
    task: "Triage GitHub PR #124 reviewer comments in this evgo repository.",
    topology: "auto",
    steps: [
      { agent: "scout", task: "Inspect PR comments with gh/git." },
      { agent: "planner", task: "Plan needed fixes." },
      { agent: "worker", task: "Apply fixes." },
      { agent: "reviewer", task: "Review changes." },
    ],
  });

  assert.match(text, /route requested/);
  assert.doesNotMatch(text, /Triage GitHub PR/);
  assert.doesNotMatch(text, /requested step/);
  assert.doesNotMatch(text, /0\/4/);
  assert.doesNotMatch(text, /scout .*planner .*worker .*reviewer/);
});

test("auto route does not fabricate a hardcoded plan when the structured planner is unavailable", async () => {
  const catalog = AgentCatalog.load({ cwd: process.cwd() });
  const result = await planChalinRoute({
    task: "Triage GitHub PR #124 reviewer comments, validate unresolved comments, implement needed fixes, and verify the result.",
    topology: "auto",
  }, {
    cwd: process.cwd(),
    catalog,
  });

  assert.equal(result.source, "failed");
  assert.equal(result.route.plan, undefined);
  assert.match(result.route.reason, /route planning blocked/i);
});

test("structured route planner output validates into a route plan without task-type mapping", () => {
  const catalog = AgentCatalog.load({ cwd: process.cwd() });
  const output = validateChalinRoutePlannerOutput({
    topology: "sequential",
    steps: [
      {
        id: "inspect",
        agent: "scout",
        task: "Inspect the exact files, tests, and repository evidence needed for this delegated change.",
        budget: "normal",
      },
      {
        id: "apply",
        agent: "worker",
        task: "Apply the validated change inside the discovered file scope and run focused verification.",
        budget: "normal",
      },
      {
        id: "review",
        agent: "reviewer",
        task: "Review the resulting diff and verification evidence before final synthesis.",
        budget: "normal",
      },
    ],
    risk: "medium",
    needsMemory: false,
    needsArtifacts: true,
    expectedEffects: ["read", "write", "verify"],
    requiresWorkspaceMutation: true,
    reason: "The task needs evidence, mutation, and independent validation.",
  }, catalog);

  assert.equal(output?.plan.topology, "sequential");
  assert.deepEqual(output?.plan.steps?.map((step) => step.agent), ["scout", "worker", "reviewer"]);
});

test("structured route planner rejects extra fields, incoherent effects, and unknown agents", () => {
  const catalog = AgentCatalog.load({ cwd: process.cwd() });
  const base = {
    topology: "sequential",
    steps: [
      {
        agent: "scout",
        task: "Inspect the exact files and tests needed for this delegated task.",
      },
    ],
    risk: "low",
    needsMemory: false,
    needsArtifacts: false,
    expectedEffects: ["read"],
    requiresWorkspaceMutation: false,
    reason: "The task only needs bounded read-only evidence.",
  };

  assert.equal(validateChalinRoutePlannerOutput({ ...base, extra: "nope" }, catalog), undefined);
  assert.equal(validateChalinRoutePlannerOutput({ ...base, expectedEffects: ["read"], requiresWorkspaceMutation: true }, catalog), undefined);
  assert.equal(validateChalinRoutePlannerOutput({
    ...base,
    steps: [
      {
        agent: "made-up-agent",
        task: "Inspect the exact files and tests needed for this delegated task.",
      },
    ],
  }, catalog), undefined);
});

test("auto route uses the injected structured planner output as the selected route", async () => {
  const catalog = AgentCatalog.load({ cwd: process.cwd() });
  const result = await planChalinRoute({
    task: "Fix the parser bug and update the nearest regression test.",
    topology: "auto",
  }, {
    cwd: process.cwd(),
    catalog,
    planner: async () => ({
      diagnostics: ["stub structured planner"],
      output: {
        requiresWorkspaceMutation: true,
        plan: {
          topology: "sequential",
          steps: [
            {
              agent: "worker",
              task: "Implement the parser fix and update the nearest regression test.",
              budget: "normal",
            },
            {
              agent: "reviewer",
              task: "Review the diff and focused test output for correctness.",
              budget: "normal",
            },
          ],
          risk: "medium",
          needsMemory: false,
          needsArtifacts: true,
          expectedEffects: ["read", "write", "verify"],
          reason: "Injected structured planner route for a mutation task.",
        },
      },
    }),
  });

  assert.equal(result.source, "llm");
  assert.deepEqual(result.route.agents, ["worker", "reviewer"]);
  assert.deepEqual(result.diagnostics, ["stub structured planner"]);
});
