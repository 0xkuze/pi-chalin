import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "vitest";
import { AgentCatalog } from "../src/agents/agents.ts";
import type { AgentDefinition } from "../src/domain/schemas.ts";
import { routeFromPlan } from "../src/kernel/kernel.ts";
import { normalizeRouteForExecution } from "../src/routing/route-guards.ts";
import { shouldScheduleNonInteractiveShutdown } from "../src/routing/autoroute.ts";
import { planChalinRoute, validateChalinRoutePlannerOutput } from "../src/routing/route-planner.ts";
import { formatChalinRouteRequestWidget, formatChalinRunWidgetFromDetails } from "../src/routing/route-widget.ts";
import { loadFailedRunDiagnostic } from "../src/runner/run-recovery.ts";
import { createRunState, loadResumableRunState, persistRun } from "../src/runner/runner-state.ts";
import { MockWorkerRunner, planNestedDelegationRoute } from "../src/runner/runner.ts";
import { expandWorkUnitsFromHandoff, planStepsWithWorkUnits } from "../src/runner/work-units.ts";
import { beginChalinTurn, hasInlineToolStarted, recordInlineToolStart } from "../src/runtime/state.ts";

function tempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function executableAgents(catalog: AgentCatalog): Map<string, AgentDefinition> {
  const result = new Map<string, AgentDefinition>();
  for (const agent of catalog.listExecutable()) {
    result.set(agent.name, agent);
    result.set(`${agent.scope}/${agent.name}`, agent);
  }
  return result;
}

function customAgent(name: string, concern: AgentDefinition["concern"], capabilities: AgentDefinition["capabilities"]): AgentDefinition {
  return {
    name,
    scope: "project",
    concern,
    capabilities,
    description: name,
    model: "inherit",
    tools: [],
    memory: { read: false, write: "never", categories: [] },
    systemPrompt: "",
    diagnostics: [],
  };
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

test("run widget shows approval pauses explicitly", () => {
  const text = formatChalinRunWidgetFromDetails({
    route: routeFromPlan({
      topology: "sequential",
      expectedEffects: ["write"],
      steps: [{ id: "worker", agent: "worker", task: "Run guarded migration." }],
    }),
    run: {
      id: "run-approval",
      rootTask: "Run guarded migration.",
      status: "paused",
      steps: [{
        id: "worker",
        agent: "worker",
        task: "Run guarded migration.",
        status: "paused",
        pauseReason: "awaiting-approval",
      }],
      warnings: ["Awaiting one-shot approval for bash: pnpm db:migrate --prod."],
    },
  });

  assert.match(text, /chalin · worker · paused · 0\/1/);
  assert.match(text, /awaiting approval/);
});

test("non-interactive chalin route shutdown is opt-in so final synthesis is not aborted", () => {
  const previous = process.env.PI_CHALIN_NONINTERACTIVE_SHUTDOWN;
  try {
    delete process.env.PI_CHALIN_NONINTERACTIVE_SHUTDOWN;
    assert.equal(shouldScheduleNonInteractiveShutdown({ hasUI: false, shutdown: () => undefined }), false);

    process.env.PI_CHALIN_NONINTERACTIVE_SHUTDOWN = "1";
    assert.equal(shouldScheduleNonInteractiveShutdown({ hasUI: false, shutdown: () => undefined }), true);
  } finally {
    if (previous === undefined) delete process.env.PI_CHALIN_NONINTERACTIVE_SHUTDOWN;
    else process.env.PI_CHALIN_NONINTERACTIVE_SHUTDOWN = previous;
  }
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

  assert.equal(text.split("\n")[0], "chalin · running · 0/1");
  assert.equal(text.split("\n")[1], "Triage GitHub PR #124 reviewer comments in this...");
  assert.equal(text.includes("route requested"), false);
  assert.equal(text.includes("policy"), false);
  assert.equal(text.includes("normalization"), false);
  assert.equal(text.includes("requested step"), false);
  assert.equal(text.includes("0/4"), false);
  assert.equal(text.includes("scout → planner → worker → reviewer"), false);
});

test("run widget renders WorkUnits as a compact product tree without harness internals", () => {
  const text = formatChalinRunWidgetFromDetails({
    route: routeFromPlan({
      topology: "dag",
      expectedEffects: ["read", "write", "verify"],
      steps: [
        { id: "scan-comments", agent: "scout", task: "Review unresolved reviewer comments and collect evidence." },
        { id: "map-diff", agent: "scout", task: "Map current diff against reviewer concerns." },
      ],
      reason: "Triage PR comments, validate each requested change, and prepare bounded fixes.",
    }),
    run: {
      id: "run-1",
      rootTask: "Reviewing comments on PR #124 and validating unresolved reviewer feedback before fixes.",
      status: "running",
      metrics: {
        durationMs: 100,
        usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        toolCalls: 7,
        toolCallsByName: { read: 4, bash: 3 },
        budgetCapHits: [{ name: "max_output_chars", used: 7_500, limit: 7_000, severity: "soft", phase: "post-tool" }],
      },
      warnings: ["hidden warning"],
      recoveryState: { pendingUnits: ["unit-map-diff"], reviewersNotRun: [], resumeKind: "none", repairOptions: [] },
      workUnits: [
        {
          id: "Unit Scan Comments",
          title: "Comments scan should be normalized and short enough for the terminal tree",
          kind: "discovery",
          status: "complete",
          scope: ["Review comments"],
          dependencies: [],
          expectedEffects: ["read"],
          acceptanceCriteria: ["Evidence collected"],
          workerStepId: "scan",
          createdFrom: "route-plan",
        },
        {
          id: "Unit Map Diff",
          title: "Diff map",
          kind: "discovery",
          status: "running",
          scope: ["Map diff"],
          dependencies: ["Unit Scan Comments"],
          expectedEffects: ["read"],
          acceptanceCriteria: ["Diff mapped"],
          workerStepId: "map",
          createdFrom: "route-plan",
        },
      ],
      steps: [
        {
          id: "scan",
          agent: "scout",
          task: "Review unresolved reviewer comments and collect evidence.",
          status: "complete",
          skills: ["github-pr-review"],
          workUnitId: "Unit Scan Comments",
        },
        {
          id: "map",
          agent: "scout",
          task: "Map current diff against reviewer concerns.",
          status: "running",
          skills: ["git-audit"],
          workUnitId: "Unit Map Diff",
        },
      ],
    },
  });

  const lines = text.split("\n");
  assert.equal(lines[0], "chalin · scout · running · 1/2");
  assert.equal(lines[1], "current: scout - Diff map");
  assert.equal(lines[2], "├ ✓ scout - unit-scan-comments — Comments scan should be normalized and short enough for the...");
  assert.equal(lines[3], "└ ◆ scout - unit-map-diff — Diff map");
  assert.equal(text.includes("tools:"), false);
  assert.equal(text.includes("guards:"), false);
  assert.equal(text.includes("budget"), false);
  assert.equal(text.includes("skills:"), false);
  assert.equal(text.includes("recovery:"), false);
  assert.equal(text.includes("policy"), false);
});

test("run widget auto-collapses completed WorkUnit trees into a concise summary", () => {
  const text = formatChalinRunWidgetFromDetails({
    route: routeFromPlan({
      topology: "sequential",
      expectedEffects: ["read", "verify"],
      steps: [
        { id: "comments", agent: "scout", task: "Review comments." },
        { id: "synthesis", agent: "planner", task: "Synthesize result." },
      ],
    }),
    run: {
      id: "run-2",
      rootTask: "Review PR comments.",
      status: "complete",
      steps: [
        { id: "comments", agent: "scout", task: "Review comments.", status: "complete", workUnitId: "unit-comments" },
        { id: "synthesis", agent: "planner", task: "Synthesize result.", status: "complete", workUnitId: "unit-synthesis" },
      ],
      workUnits: [
        {
          id: "unit-comments",
          title: "Comments",
          kind: "discovery",
          status: "complete",
          scope: ["Review comments"],
          dependencies: [],
          expectedEffects: ["read"],
          acceptanceCriteria: ["Comments reviewed"],
          workerStepId: "comments",
          createdFrom: "route-plan",
        },
        {
          id: "unit-synthesis",
          title: "Synthesis",
          kind: "synthesis",
          status: "complete",
          scope: ["Synthesize"],
          dependencies: ["unit-comments"],
          expectedEffects: ["verify"],
          acceptanceCriteria: ["Result synthesized"],
          workerStepId: "synthesis",
          createdFrom: "route-plan",
        },
      ],
    },
  });

  assert.deepEqual(text.split("\n"), [
    "chalin · scout · done · 2/2",
    "2 tasks done",
  ]);
});

test("run widget keeps failed replaced attempts out of the normal tree and counts the WorkUnit once", () => {
  const text = formatChalinRunWidgetFromDetails({
    route: routeFromPlan({
      topology: "sequential",
      expectedEffects: ["read"],
      steps: [{ id: "comments", agent: "scout", task: "Review comments." }],
    }),
    run: {
      id: "run-3",
      rootTask: "Review comments.",
      status: "running",
      steps: [
        { id: "comments-attempt-1", agent: "scout", task: "Review comments.", status: "failed", error: "tool failed", workUnitId: "unit-comments" },
        { id: "comments-attempt-2", agent: "scout", task: "Review comments with recovered state.", status: "running", workUnitId: "unit-comments" },
      ],
      workUnits: [
        {
          id: "unit-comments",
          title: "Comments",
          kind: "discovery",
          status: "running",
          scope: ["Review comments"],
          dependencies: [],
          expectedEffects: ["read"],
          acceptanceCriteria: ["Comments reviewed"],
          workerStepId: "comments-attempt-2",
          createdFrom: "repair",
          failureReason: "tool failed",
        },
      ],
    },
  });

  assert.deepEqual(text.split("\n"), [
    "chalin · scout · running · 0/1",
    "current: scout - Comments",
    "└ ◆ scout - unit-comments — Comments",
  ]);
  assert.equal(text.includes("tool failed"), false);
  assert.equal(text.includes("comments-attempt-1"), false);
});

test("run widget normalizes duplicate WorkUnit display ids without changing language", () => {
  const text = formatChalinRunWidgetFromDetails({
    route: routeFromPlan({
      topology: "sequential",
      expectedEffects: ["read"],
      steps: [{ id: "revision", agent: "scout", task: "Revisar API." }],
    }),
    run: {
      id: "run-4",
      rootTask: "Revisar API.",
      status: "running",
      steps: [
        { id: "first", agent: "scout", task: "Revisar API.", status: "running", workUnitId: "Revisión API" },
        { id: "second", agent: "planner", task: "Revisar API alternativa.", status: "pending", workUnitId: "revisión api" },
      ],
      workUnits: [
        {
          id: "Revisión API",
          title: "Revisión API",
          kind: "discovery",
          status: "running",
          scope: ["Revisar API"],
          dependencies: [],
          expectedEffects: ["read"],
          acceptanceCriteria: ["API revisada"],
          workerStepId: "first",
          createdFrom: "route-plan",
        },
        {
          id: "revisión api",
          title: "Revisión API alternativa",
          kind: "planning",
          status: "pending",
          scope: ["Revisar API alternativa"],
          dependencies: ["Revisión API"],
          expectedEffects: ["read"],
          acceptanceCriteria: ["Alternativa revisada"],
          workerStepId: "second",
          createdFrom: "route-plan",
        },
      ],
    },
  });

  assert.deepEqual(text.split("\n"), [
    "chalin · scout · running · 0/2",
    "current: scout - Revisión API",
    "├ ◆ scout - revisión-api — Revisión API",
    "└ ○ planner - revisión-api-2 — Revisión API alternativa",
  ]);
});

test("run widget renders one visible nested subagent level from parent step traces", () => {
  const text = formatChalinRunWidgetFromDetails({
    route: routeFromPlan({
      topology: "sequential",
      expectedEffects: ["read", "write", "verify"],
      steps: [{ id: "review-comments", agent: "scout", task: "Review comments." }],
    }),
    run: {
      id: "run-nested",
      rootTask: "Reviewing PR comments.",
      status: "running",
      steps: [
        {
          id: "review-comments",
          agent: "scout",
          task: "Review comments.",
          status: "running",
          workUnitId: "unit-review-comments",
          nestedRuns: [
            {
              id: "nested-1",
              status: "running",
              rootTask: "Inspect unresolved review comments in GitHub.",
              steps: [
                {
                  id: "comments-scan",
                  agent: "scout",
                  task: "Inspect unresolved review comments in GitHub.",
                  status: "running",
                  workUnitId: "nested-comments-scan",
                },
              ],
              workUnits: [
                {
                  id: "nested-comments-scan",
                  title: "Comments scan",
                  kind: "discovery",
                  status: "running",
                  scope: ["Inspect unresolved comments"],
                  dependencies: [],
                  expectedEffects: ["read"],
                  acceptanceCriteria: ["Comments inspected"],
                  workerStepId: "comments-scan",
                  createdFrom: "route-plan",
                },
              ],
            },
          ],
        },
      ],
      workUnits: [
        {
          id: "unit-review-comments",
          title: "Review comments",
          kind: "discovery",
          status: "running",
          scope: ["Review comments"],
          dependencies: [],
          expectedEffects: ["read", "write", "verify"],
          acceptanceCriteria: ["Comments reviewed"],
          workerStepId: "review-comments",
          createdFrom: "route-plan",
        },
      ],
    },
  });

  assert.deepEqual(text.split("\n"), [
    "chalin · scout · running · 0/1",
    "current: scout - Review comments",
    "└ ◆ scout - unit-review-comments — Review comments",
    "   └ ◆ scout - nested-comments-scan — Comments scan",
  ]);
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
      },
      {
        id: "apply",
        agent: "worker",
        task: "Apply the validated change inside the discovered file scope and run focused verification.",
      },
      {
        id: "review",
        agent: "reviewer",
        task: "Review the resulting diff and verification evidence before final synthesis.",
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

test("structured route planner rejects extra fields, step budgets, incoherent effects, and unknown agents", () => {
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
        agent: "scout",
        task: "Inspect the exact files and tests needed for this delegated task.",
        budget: "normal",
      },
    ],
  }, catalog), undefined);
  assert.equal(validateChalinRoutePlannerOutput({
    ...base,
    steps: [
      {
        agent: "made-up-agent",
        task: "Inspect the exact files and tests needed for this delegated task.",
      },
    ],
  }, catalog), undefined);
  assert.equal(validateChalinRoutePlannerOutput({
    ...base,
    steps: [
      {
        agent: "scout",
        task: "Inspect the exact files and tests needed for this delegated task.",
        expectedEffects: ["delete"],
      },
    ],
  }, catalog), undefined);
});

test("planned WorkUnits use LLM step expectedEffects instead of agent-name heuristics", () => {
  const catalog = AgentCatalog.load({ cwd: process.cwd() });
  const output = validateChalinRoutePlannerOutput({
    topology: "sequential",
    steps: [
      {
        id: "mutate-with-custom-agent",
        agent: "scout",
        task: "Apply the bounded implementation change and capture concrete verification evidence.",
        expectedEffects: ["read", "write", "verify"],
        files: ["src/parser.ts", "test/parser.test.ts"],
      },
      {
        id: "verify-with-custom-agent",
        agent: "worker",
        task: "Independently verify the changed behavior and report exact evidence.",
        expectedEffects: ["read", "verify"],
      },
    ],
    risk: "medium",
    needsMemory: false,
    needsArtifacts: true,
    expectedEffects: ["read", "write", "verify"],
    requiresWorkspaceMutation: true,
    reason: "The LLM assigned effects explicitly, so the harness should not infer responsibility from names.",
  }, catalog);

  assert.deepEqual(output?.plan.steps?.map((step) => step.expectedEffects), [
    ["read", "write", "verify"],
    ["read", "verify"],
  ]);

  const route = routeFromPlan(output!.plan);
  const planned = planStepsWithWorkUnits(route);

  assert.equal(planned.workUnits[0]?.kind, "implementation");
  assert.deepEqual(planned.workUnits[0]?.expectedEffects, ["read", "write", "verify"]);
  assert.equal(planned.workUnits[0]?.workerStepId, "step-1");
  assert.equal(planned.workUnits[0]?.reviewerStepId, undefined);
  assert.equal(planned.workUnits[1]?.kind, "review");
  assert.deepEqual(planned.workUnits[1]?.expectedEffects, ["read", "verify"]);
  assert.equal(planned.workUnits[1]?.workerStepId, undefined);
  assert.equal(planned.workUnits[1]?.reviewerStepId, "step-2");
});

test("primary supplied route steps are proposals and do not bypass the structured planner", async () => {
  const catalog = AgentCatalog.load({ cwd: process.cwd() });
  let plannerCalled = false;
  const result = await planChalinRoute({
    task: "Inspect the routing module and produce a read-only recommendation.",
    topology: "sequential",
    expectedEffects: ["read"],
    steps: [
      {
        agent: "scout",
        task: "Primary-proposed step that must not be treated as authoritative.",
      },
    ],
  }, {
    cwd: process.cwd(),
    catalog,
    planner: async () => {
      plannerCalled = true;
      return {
        diagnostics: ["planner chose semantic route"],
        output: {
          requiresWorkspaceMutation: false,
          plan: {
            topology: "sequential",
            steps: [
              {
                agent: "planner",
                task: "Inspect routing evidence and produce the bounded read-only recommendation.",
              },
            ],
            risk: "low",
            needsMemory: false,
            needsArtifacts: false,
            expectedEffects: ["read"],
            reason: "The delegated task needs a read-only planning recommendation, not the primary proposal.",
          },
        },
      };
    },
  });

  assert.equal(plannerCalled, true);
  assert.equal(result.source, "llm");
  assert.deepEqual(result.route.agents, ["planner"]);
  assert.deepEqual(result.diagnostics, ["planner chose semantic route"]);
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
            },
            {
              agent: "reviewer",
              task: "Review the diff and focused test output for correctness.",
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

test("route guards validate mutation coverage without inventing worker or reviewer steps", () => {
  const catalog = AgentCatalog.load({ cwd: process.cwd() });
  const route = routeFromPlan({
    topology: "sequential",
    expectedEffects: ["read", "write", "verify"],
    steps: [
      {
        agent: "scout",
        task: "Inspect the files that would need mutation without actually editing them.",
      },
    ],
    reason: "Invalid mutation route for guard validation.",
  });

  const normalized = normalizeRouteForExecution(route, {
    requiresWorkspaceMutation: true,
    agents: executableAgents(catalog),
  });

  assert.equal(normalized.kind, "ask-user");
  assert.equal(normalized.plan, undefined);
  assert.match(normalized.reason, /missing write-capable/i);
  assert.doesNotMatch(normalized.reason, /added worker|added reviewer/i);
});

test("route guards defer mutation coverage for discovered WorkUnits without stripping LLM-selected steps", () => {
  const catalog = AgentCatalog.load({ cwd: process.cwd() });
  const route = routeFromPlan({
    topology: "sequential",
    expectedEffects: ["read", "write", "verify"],
    workUnitStrategy: "discover",
    fanoutAuthorized: true,
    steps: [
      {
        agent: "scout",
        task: "Discover independent bounded work units before mutation.",
      },
      {
        agent: "planner",
        task: "Validate discovered work unit boundaries and dependency ordering.",
      },
    ],
    reason: "The route must discover WorkUnits before deciding executable mutation coverage.",
  });

  const normalized = normalizeRouteForExecution(route, {
    requiresWorkspaceMutation: true,
    agents: executableAgents(catalog),
  });

  assert.equal(normalized.kind, "multi-agent-sequential");
  assert.deepEqual(normalized.agents, ["scout", "planner"]);
  assert.equal(normalized.plan?.kind, "sequential");
  assert.deepEqual(normalized.plan?.kind === "sequential" ? normalized.plan.steps.map((step) => step.agent) : [], ["scout", "planner"]);
  assert.equal(normalized.reason.includes("removed"), false);
  assert.equal(normalized.reason.includes("missing write-capable"), false);
});

test("route guards do not escalate risk from protected path mentions before an action occurs", () => {
  const catalog = AgentCatalog.load({ cwd: process.cwd() });
  const route = routeFromPlan({
    topology: "sequential",
    expectedEffects: ["read"],
    risk: "low",
    steps: [
      {
        agent: "scout",
        task: "Read docs that mention deleting .env files and explain the safety implications.",
      },
    ],
    reason: "Read-only safety analysis can mention protected paths without executing a destructive action.",
  });

  const normalized = normalizeRouteForExecution(route, {
    requiresWorkspaceMutation: false,
    agents: executableAgents(catalog),
  });

  assert.equal(normalized.kind, "multi-agent-sequential");
  assert.equal(normalized.risk, "low");
  assert.deepEqual(normalized.agents, ["scout"]);
});

test("discovered WorkUnits materialize planner handoff instead of hardcoded executor and reviewer agents", () => {
  const cwd = tempDir("pi-chalin-fanout-planner-");
  try {
    const route = routeFromPlan({
      topology: "sequential",
      expectedEffects: ["read", "write", "verify"],
      workUnitStrategy: "discover",
      fanoutAuthorized: true,
      steps: [
        {
          agent: "scout",
          task: "Discover independent bounded work units for the requested mutation.",
        },
      ],
      reason: "Discover bounded work units before execution.",
    });
    const run = createRunState(route, cwd, "Apply the discovered independent changes.");
    const source = run.steps[0]!;
    source.status = "complete";
    source.output = {
      agent: "scout",
      text: "Discovered two independent write units.",
      handoff: "Discovered two independent write units.",
      structuredHandoff: {
        summary: "Two independent units were found.",
        changedFiles: [],
        verification: [],
        evidenceClaims: [],
        risks: [],
        nextActions: [],
        requiresHumanInput: false,
        humanInputQuestions: [],
        workUnits: [
          {
            id: "parser",
            title: "Parser regression",
            scope: ["Fix parser behavior"],
            files: ["src/parser.ts", "test/parser.test.ts"],
            dependencies: [],
            expectedEffects: ["read", "write", "verify"],
            acceptanceCriteria: ["Parser regression test passes."],
          },
          {
            id: "docs",
            title: "Docs update",
            scope: ["Update parser documentation"],
            files: ["README.md"],
            dependencies: [],
            expectedEffects: ["read", "write", "verify"],
            acceptanceCriteria: ["Docs reflect parser behavior."],
          },
        ],
      },
      memoryCandidates: [],
      raw: "Discovered two independent write units.",
      warnings: [],
    };

    assert.equal(expandWorkUnitsFromHandoff(run, source), true);
    const fanoutSteps = run.steps.filter((step) => step.id !== source.id);

    assert.equal(fanoutSteps.length, 1);
    assert.equal(fanoutSteps[0]?.agent, "planner");
    assert.match(fanoutSteps[0]?.task ?? "", /decide the executable route/i);
    assert.notDeepEqual(fanoutSteps.map((step) => step.agent), ["worker", "reviewer"]);
    assert.equal(run.workUnits?.filter((unit) => unit.createdFrom === "fanout" && unit.kind !== "planning").length, 2);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test("nested delegation delegates intent to the structured planner and does not choose a fallback route when planner is unavailable", async () => {
  const catalog = AgentCatalog.load({ cwd: process.cwd() });
  const agents = executableAgents(catalog);
  let plannerCalled = false;

  const planned = await planNestedDelegationRoute({
    task: "Resolve the nested parser and docs work with verification.",
    reason: "The current worker discovered independently bounded ownership.",
    requiresWorkspaceMutation: true,
  }, {
    cwd: process.cwd(),
    agents,
    planner: async () => {
      plannerCalled = true;
      return {
        diagnostics: ["nested planner selected route"],
        output: {
          requiresWorkspaceMutation: true,
          plan: {
            topology: "sequential",
            steps: [
              {
                agent: "worker",
                task: "Implement the nested parser and docs work with focused verification.",
              },
              {
                agent: "reviewer",
                task: "Review the nested diff and verification evidence.",
              },
            ],
            risk: "medium",
            needsMemory: false,
            needsArtifacts: true,
            expectedEffects: ["read", "write", "verify"],
            reason: "Nested delegation requires mutation and independent verification.",
          },
        },
      };
    },
  });

  assert.equal(plannerCalled, true);
  assert.equal(planned.source, "llm");
  assert.deepEqual(planned.route.agents, ["worker", "reviewer"]);

  const unavailable = await planNestedDelegationRoute({
    task: "Resolve the nested parser and docs work with verification.",
    reason: "The current worker discovered independently bounded ownership.",
    requiresWorkspaceMutation: true,
  }, {
    cwd: process.cwd(),
    agents,
    planner: async () => ({ diagnostics: ["planner offline"] }),
  });

  assert.equal(unavailable.source, "failed");
  assert.equal(unavailable.route.plan, undefined);
  assert.equal(unavailable.route.kind, "ask-user");
  assert.match(unavailable.route.reason, /planner offline/);
  assert.equal(unavailable.route.agents.length, 0);
});

test("repair cycles reuse LLM-selected responsibilities instead of hardcoded worker reviewer agents", async () => {
  const cwd = tempDir("pi-chalin-custom-repair-");
  try {
    const route = routeFromPlan({
      topology: "sequential",
      expectedEffects: ["read", "write", "verify"],
      steps: [
        {
          id: "apply",
          agent: "impl-a",
          task: "Apply the parser mutation and collect verification evidence.",
          expectedEffects: ["read", "write", "verify"],
          files: ["src/parser.ts"],
        },
        {
          id: "audit",
          agent: "audit-a",
          task: "Verify the parser mutation against the requested behavior.",
          expectedEffects: ["read", "verify"],
        },
      ],
      risk: "medium",
      needsMemory: false,
      needsArtifacts: true,
      reason: "Custom agents were selected by the structured planner.",
    });
    const run = createRunState(route, cwd, "Fix the parser behavior.");
    const implementation = run.steps[0]!;
    implementation.status = "complete";
    implementation.output = {
      agent: "impl-a",
      text: "Implemented parser change.",
      handoff: "Implemented parser change.",
      structuredHandoff: {
        summary: "Parser behavior changed.",
        changedFiles: ["src/parser.ts"],
        verification: ["pnpm test parser"],
        evidenceClaims: [],
        risks: [],
        nextActions: [],
      },
      memoryCandidates: [],
      raw: "Implemented parser change.",
      warnings: [],
    };
    implementation.metrics = {
      durationMs: 1,
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      toolCalls: 1,
      toolCallsByName: {},
      filesTouched: ["src/parser.ts"],
    };
    const audit = run.steps[1]!;
    audit.status = "complete";
    audit.output = {
      agent: "audit-a",
      text: "Parser verification failed.",
      handoff: "Parser verification failed.",
      structuredHandoff: {
        summary: "Parser verification found a blocking gap.",
        changedFiles: [],
        verification: ["reviewed src/parser.ts"],
        evidenceClaims: [],
        risks: ["parser edge case still fails"],
        nextActions: [],
      },
      reviewerVerdict: {
        verdict: "fail",
        blockingFindings: ["Parser edge case still fails in src/parser.ts."],
        missingCoverage: [],
        evidence: ["reviewed src/parser.ts"],
        repairFiles: ["src/parser.ts"],
        residualRisks: [],
        requiredRepair: "Fix the parser edge case.",
      },
      memoryCandidates: [],
      raw: "Parser verification failed.",
      warnings: [],
    };

    const agents = new Map<string, AgentDefinition>([
      ["impl-a", customAgent("impl-a", "implementation", ["inspect-files", "edit-files", "validate"])],
      ["audit-a", customAgent("audit-a", "review", ["inspect-files", "validate"])],
    ]);
    const resumed = await new MockWorkerRunner().resume(run, { cwd, agents });
    const repairSteps = resumed.steps.filter((step) => step.id.startsWith("review-repair-"));

    assert.ok(repairSteps.some((step) => step.id.includes("-mutation") && step.agent === "impl-a"));
    assert.ok(repairSteps.some((step) => step.id.includes("-verification") && step.agent === "audit-a"));
    assert.equal(resumed.route.agents.includes("worker"), false);
    assert.equal(resumed.route.agents.includes("reviewer"), false);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});
