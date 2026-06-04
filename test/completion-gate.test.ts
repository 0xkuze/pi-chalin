import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, test } from "vitest";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { buildCompletionGateContextMessage, buildCompletionGateContract, buildCompletionGateSteer, formatCompletionGateDecisionSteer, validateCompletionGateDecision } from "../src/runtime/completion-gate.ts";
import { registerChalinAutoRouter, resetAutorouteToolStateForTests, setCompletionGateJudgeForTests, setSemanticPolicyJudgeForTests } from "../src/routing/autoroute.ts";
import { COMPLETION_GATE_TOOL_NAME, completionGateSessionPrompt, parseCompletionGateDecision, runCompletionGateJudge, shouldRunCompletionGateChallenge } from "../src/skills/completion-gate-judge.ts";
import { resetRuntimeState } from "../src/runtime/state.ts";

afterEach(() => {
  resetAutorouteToolStateForTests();
  resetRuntimeState();
});

class FakePi {
  readonly handlers = new Map<string, ((event: any, ctx: any) => unknown | Promise<unknown>)[]>();
  readonly messages: Array<{ message: any; options: any }> = [];
  readonly entries: Array<{ customType: string; data: unknown }> = [];

  on(event: string, handler: (event: any, ctx: any) => unknown | Promise<unknown>): void {
    const handlers = this.handlers.get(event) ?? [];
    handlers.push(handler);
    this.handlers.set(event, handlers);
  }

  sendMessage(message: any, options: any): void {
    this.messages.push({ message, options });
  }

  appendEntry(customType: string, data: unknown): void {
    this.entries.push({ customType, data });
  }

  getThinkingLevel(): "high" {
    return "high";
  }

  setThinkingLevel(): void {
    return;
  }

  async emit(event: string, payload: unknown, ctx: any = { cwd: process.cwd() }): Promise<unknown> {
    const handlers = this.handlers.get(event) ?? [];
    let result: unknown;
    for (const handler of handlers) result = await handler(payload, ctx);
    return result;
  }
}

function tempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

test("completion gate is a semantic finalization contract, not a domain checklist", () => {
  const contract = buildCompletionGateContract();
  const context = buildCompletionGateContextMessage();
  const steer = buildCompletionGateSteer("inline");

  assert.equal(contract.includes("Completion Gate"), true);
  assert.equal(contract.includes("can_finalize"), true);
  assert.equal(contract.includes("keyword matching"), true);
  assert.equal(contract.includes("regex-like rules"), true);
  assert.equal(contract.includes("normal behavior"), true);
  assert.equal(contract.includes("preservation/invariant path"), true);
  assert.equal(contract.includes("representative evidence"), true);
  assert.equal(contract.includes("observed fixtures"), true);
  assert.equal(contract.includes("Mutation history"), true);
  assert.equal(contract.includes("direct repo/spec evidence"), true);
  assert.match(contract, /Do not rely on hidden background follow-up/i);
  assert.match(contract, /queued\/running requiredEvidence job is pending evidence/i);
  assert.equal(contract.includes("Hidden-test posture"), true);
  assert.ok(contract.length <= 3_000);
  assert.equal(contract.includes("varies only the target command/keyword"), false);
  assert.equal(context.includes("completion gate active"), true);
  assert.equal(steer.includes("changed files"), true);
  assert.equal(steer.includes("missing"), true);
  assert.equal(contract.includes("READ SERR"), false);
  assert.equal(contract.includes("QDP"), false);
  assert.equal(contract.includes("PR #124"), false);
});

test("completion gate decision validation is strict and action-consistent", () => {
  const valid = validateCompletionGateDecision({
    canFinalize: false,
    confidence: 0.91,
    missingEvidence: ["existing runner evidence"],
    nextAction: "verify_existing_evidence",
    reason: "A source mutation has only a synthetic probe.",
    requiredEvidence: ["nearest project verification"],
  });

  assert.equal(valid?.nextAction, "verify_existing_evidence");
  assert.equal(validateCompletionGateDecision({ ...valid, extra: true } as any), undefined);
  assert.equal(validateCompletionGateDecision({ ...valid, canFinalize: true } as any), undefined);
  assert.equal(validateCompletionGateDecision({ ...valid, nextAction: "continue" } as any), undefined);
});

test("completion gate parser trusts structured tool calls before textual JSON", () => {
  const toolMessage = {
    role: "assistant",
    content: [{
      type: "toolCall",
      id: "gate-1",
      name: COMPLETION_GATE_TOOL_NAME,
      arguments: {
        canFinalize: false,
        confidence: 0.92,
        missingEvidence: ["post-mutation evidence"],
        nextAction: "verify_existing_evidence",
        reason: "The final claim needs representative evidence.",
      },
    }],
  } as any;
  const textMessage = {
    role: "assistant",
    content: [{
      type: "text",
      text: JSON.stringify({
        canFinalize: false,
        confidence: 0.92,
        missingEvidence: ["post-mutation evidence"],
        nextAction: "verify_existing_evidence",
        reason: "The final claim needs representative evidence.",
      }),
    }],
  } as any;

  assert.equal(parseCompletionGateDecision(toolMessage, { allowTextJson: false })?.nextAction, "verify_existing_evidence");
  assert.equal(parseCompletionGateDecision(textMessage, { allowTextJson: false }), undefined);
  assert.equal(parseCompletionGateDecision(textMessage, { allowTextJson: true })?.nextAction, "verify_existing_evidence");
});

test("completion gate uses the generic AgentSession judge path", async () => {
  const expected = {
    canFinalize: true,
    confidence: 0.93,
    missingEvidence: [],
    nextAction: "finalize" as const,
    reason: "AgentSession tool output was accepted.",
  };
  const result = await runCompletionGateJudge({
    payload: {
      originalPrompt: "fix parser behavior",
      finalAnswer: "Done.",
      ledger: {
        changedPaths: ["src/parser.py"],
        readPaths: [],
        mutationRecords: [],
        commandRecords: [],
        failedCommandsAfterMutation: [],
        failedPostMutationCommands: [],
        postFailureMutationRecords: [],
        observations: [],
        evidenceAfterLatestMutation: true,
      },
      state: {
        mutationObserved: true,
        sourceMutationObserved: true,
        testMutationObserved: false,
        verificationObserved: true,
        terminalActionObserved: false,
        docsOnlyMutation: false,
        changedPaths: ["src/parser.py"],
        readPaths: [],
        promptCodePaths: [],
      },
    },
    context: {
      cwd: process.cwd(),
      model: { api: "generic-pi-api", id: "provider-agnostic-model" } as any,
      modelRegistry: {} as any,
      agentSessionJudge: async ({ payload, context }) => {
        assert.equal(payload.finalAnswer, "Done.");
        assert.equal(context.cwd, process.cwd());
        return expected;
      },
    },
  });

  assert.equal(result, expected);
});

test("completion gate challenges permissive finalization after failed evidence and custom probes", async () => {
  const payload = {
    originalPrompt: "fix parser normalization",
    finalAnswer: "Done.",
    ledger: {
      changedPaths: ["src/parser.py"],
      readPaths: ["tests/test_parser.py"],
      mutationRecords: [
        { toolName: "edit" as const, status: "pass" as const, afterFailedCommand: false, path: "src/parser.py", args: "broad parser normalization" },
      ],
      commandRecords: [
        { command: "project-test tests/test_parser.py", status: "fail" as const, afterLatestMutation: true },
        { command: "custom probe with selective fixture", status: "pass" as const, afterLatestMutation: true },
      ],
      failedCommandsAfterMutation: [
        { command: "project-test tests/test_parser.py", status: "fail" as const, afterLatestMutation: true },
      ],
      failedPostMutationCommands: [
        { command: "project-test tests/test_parser.py", status: "fail" as const, afterLatestMutation: true },
      ],
      postFailureMutationRecords: [],
      observations: [
        {
          toolName: "read",
          status: "pass" as const,
          afterLatestMutation: false,
          path: "tests/test_parser.py",
          text: "existing realistic fixture has surrounding parser states and sentinel values",
        },
        {
          toolName: "bash",
          status: "pass" as const,
          afterLatestMutation: true,
          command: "custom probe with selective fixture",
          text: "custom probe passed",
        },
      ],
      evidenceAfterLatestMutation: true,
      latestMutationIndex: 1,
    },
    state: {
      mutationObserved: true,
      sourceMutationObserved: true,
      testMutationObserved: false,
      verificationObserved: false,
      terminalActionObserved: false,
      docsOnlyMutation: false,
      changedPaths: ["src/parser.py"],
      readPaths: ["tests/test_parser.py"],
      promptCodePaths: [],
    },
  };
  const permissive = {
    canFinalize: true,
    confidence: 0.9,
    missingEvidence: [],
    nextAction: "finalize" as const,
    reason: "The selective probe is enough.",
  };
  const challenged = {
    canFinalize: false,
    confidence: 0.88,
    missingEvidence: ["realistic observed fixture was not covered"],
    nextAction: "expand_custom_probe" as const,
    reason: "The custom probe is narrower than the observed existing fixture and failed project evidence remains.",
    requiredEvidence: ["probe that mirrors the observed fixture shape"],
  };
  const calls: boolean[] = [];

  assert.equal(shouldRunCompletionGateChallenge(payload, permissive), true);

  const result = await runCompletionGateJudge({
    payload,
    context: {
      cwd: process.cwd(),
      model: { api: "generic-pi-api", id: "any-model" } as any,
      modelRegistry: {} as any,
      agentSessionJudge: async ({ challengeDecision }) => {
        calls.push(Boolean(challengeDecision));
        return challengeDecision ? challenged : permissive;
      },
    },
  });

  assert.deepEqual(calls, [false, true]);
  assert.equal(result, challenged);
});

test("completion gate challenges finalization after a post-failure mutation", async () => {
  const payload = {
    originalPrompt: "fix input normalization",
    finalAnswer: "Done.",
    ledger: {
      changedPaths: ["src/parser.py"],
      readPaths: ["tests/test_parser.py"],
      mutationRecords: [
        { toolName: "edit" as const, status: "pass" as const, afterFailedCommand: false, path: "src/parser.py", args: "initial broad normalization hypothesis" },
        { toolName: "edit" as const, status: "pass" as const, afterFailedCommand: true, path: "src/parser.py", args: "later narrowed implementation after blocked runner" },
      ],
      commandRecords: [
        { command: "project test", status: "fail" as const, afterLatestMutation: false },
        { command: "direct representative probe", status: "pass" as const, afterLatestMutation: true },
      ],
      failedCommandsAfterMutation: [
        { command: "project test", status: "fail" as const, afterLatestMutation: false },
      ],
      failedPostMutationCommands: [],
      postFailureMutationRecords: [
        { toolName: "edit" as const, status: "pass" as const, afterFailedCommand: true, path: "src/parser.py", args: "later narrowed implementation after blocked runner" },
      ],
      observations: [
        {
          toolName: "read",
          status: "pass" as const,
          afterLatestMutation: false,
          path: "tests/test_parser.py",
          text: "existing realistic fixture covers a full parser shape",
        },
        {
          toolName: "bash",
          status: "pass" as const,
          afterLatestMutation: true,
          command: "direct representative probe",
          text: "probe passed for the latest source state",
        },
      ],
      evidenceAfterLatestMutation: true,
      latestMutationIndex: 3,
    },
    state: {
      mutationObserved: true,
      sourceMutationObserved: true,
      testMutationObserved: false,
      verificationObserved: true,
      terminalActionObserved: false,
      docsOnlyMutation: false,
      changedPaths: ["src/parser.py"],
      readPaths: ["tests/test_parser.py"],
      promptCodePaths: [],
    },
  };
  const permissive = {
    canFinalize: true,
    confidence: 0.9,
    missingEvidence: [],
    nextAction: "finalize" as const,
    reason: "The later probe passed.",
  };
  const challenged = {
    canFinalize: false,
    confidence: 0.87,
    missingEvidence: ["post-failure mutation audit"],
    nextAction: "repair" as const,
    reason: "The gate challenged the post-failure mutation before accepting completion.",
    requiredEvidence: ["prove the latest source state still satisfies the full request"],
  };
  const calls: boolean[] = [];

  assert.equal(shouldRunCompletionGateChallenge(payload, permissive), true);

  const result = await runCompletionGateJudge({
    payload,
    context: {
      cwd: process.cwd(),
      model: { api: "generic-pi-api", id: "any-model" } as any,
      modelRegistry: {} as any,
      agentSessionJudge: async ({ challengeDecision }) => {
        calls.push(Boolean(challengeDecision));
        return challengeDecision ? challenged : permissive;
      },
    },
  });

  assert.deepEqual(calls, [false, true]);
  assert.equal(result, challenged);
});

test("completion gate session prompt repeats binding evidence audit after the payload", () => {
  const payload = {
    originalPrompt: "make parser normalization work",
    finalAnswer: "Done.",
    priorBlocks: [{
      canFinalize: false,
      confidence: 0.82,
      missingEvidence: ["representative fixture evidence"],
      nextAction: "expand_custom_probe" as const,
      reason: "A prior final used narrower evidence.",
      requiredEvidence: ["run a full observed fixture variant"],
    }],
    ledger: {
      changedPaths: ["src/parser.py"],
      readPaths: ["tests/test_parser.py"],
      mutationRecords: [
        { toolName: "edit" as const, status: "pass" as const, afterFailedCommand: false, path: "src/parser.py", args: "initial plausible normalization fix" },
        { toolName: "edit" as const, status: "pass" as const, afterFailedCommand: true, path: "src/parser.py", args: "later narrower repair after blocked verification" },
      ],
      commandRecords: [
        { command: "project test", status: "fail" as const, afterLatestMutation: true },
        { command: "custom probe", status: "pass" as const, afterLatestMutation: true },
      ],
      failedCommandsAfterMutation: [
        { command: "project test", status: "fail" as const, afterLatestMutation: true },
      ],
      failedPostMutationCommands: [
        { command: "project test", status: "fail" as const, afterLatestMutation: true },
      ],
      postFailureMutationRecords: [
        { toolName: "edit" as const, status: "pass" as const, afterFailedCommand: true, path: "src/parser.py", args: "later narrower repair after blocked verification" },
      ],
      observations: [],
      evidenceAfterLatestMutation: true,
    },
    state: {
      mutationObserved: true,
      sourceMutationObserved: true,
      testMutationObserved: false,
      verificationObserved: true,
      terminalActionObserved: false,
      docsOnlyMutation: false,
      changedPaths: ["src/parser.py"],
      readPaths: ["tests/test_parser.py"],
      promptCodePaths: [],
    },
  };

  const prompt = completionGateSessionPrompt(payload, payload.priorBlocks[0]);
  const payloadIndex = prompt.indexOf("Payload JSON:");
  const auditIndex = prompt.lastIndexOf("Final decision audit before calling completion_gate_result:");

  assert.ok(auditIndex > payloadIndex);
  assert.match(prompt.slice(auditIndex), /priorBlocks/);
  assert.match(prompt.slice(auditIndex), /postFailureMutationRecords/);
  assert.match(prompt.slice(auditIndex), /failedPostMutationCommands/);
  assert.match(prompt.slice(auditIndex), /realistic observed input shape/);
  assert.match(prompt.slice(auditIndex), /direct source\/test\/doc\/spec evidence/);
});

test("completion gate steer is operational and not domain-specific", () => {
  const steer = formatCompletionGateDecisionSteer({
    canFinalize: false,
    confidence: 0.88,
    missingEvidence: ["existing test surface"],
    nextAction: "expand_custom_probe",
    reason: "The evidence is narrower than the changed behavior.",
    requiredEvidence: ["one preservation path"],
  });

  assert.match(steer, /blocked finalization/);
  assert.match(steer, /expand_custom_probe/);
  assert.equal(steer.includes("READ SERR"), false);
  assert.equal(steer.includes("QDP"), false);
  assert.equal(steer.includes("PR #124"), false);
});

test("autoroute injects the completion gate into direct provider context", async () => {
  const pi = new FakePi();
  registerChalinAutoRouter(pi as unknown as ExtensionAPI);
  await pi.emit("before_agent_start", { prompt: "fix the bug", systemPrompt: "" });

  const result = await pi.emit("context", { messages: [] }) as { messages?: any[] } | undefined;

  const gate = result?.messages?.find((message) => message.customType === "pi-chalin-completion-gate");
  assert.equal(gate?.role, "custom");
  assert.equal(gate?.display, false);
  assert.equal(typeof gate?.timestamp, "number");
  assert.match(gate?.content ?? "", /completion gate active/);
});

test("autoroute does not duplicate an existing completion gate context message", async () => {
  const pi = new FakePi();
  registerChalinAutoRouter(pi as unknown as ExtensionAPI);
  await pi.emit("before_agent_start", { prompt: "fix the bug", systemPrompt: "" });
  const existing = {
    role: "custom",
    customType: "pi-chalin-completion-gate",
    content: "existing",
    display: false,
    timestamp: 1,
  };

  const result = await pi.emit("context", { messages: [existing] }) as { messages?: any[] } | undefined;

  assert.equal(result, undefined);
});

test("autoroute does not inject the completion gate when chalin is disabled", async () => {
  const cwd = tempDir("pi-chalin-completion-disabled-");
  fs.mkdirSync(path.join(cwd, ".pi-chalin"), { recursive: true });
  fs.writeFileSync(path.join(cwd, ".pi-chalin", "config.json"), JSON.stringify({ enabled: false }), "utf-8");
  const pi = new FakePi();
  registerChalinAutoRouter(pi as unknown as ExtensionAPI);
  await pi.emit("before_agent_start", { prompt: "fix the bug", systemPrompt: "" }, { cwd });

  const result = await pi.emit("context", { messages: [] }, { cwd }) as { messages?: any[] } | undefined;

  assert.equal(result, undefined);
});

test("autoroute replaces a rejected direct final without hidden post-final follow-up", async () => {
  const pi = new FakePi();
  const model = { api: "generic-pi-api" };
  const modelRegistry = { marker: "registry" };
  setCompletionGateJudgeForTests(async ({ payload }) => {
    assert.equal(payload.state.sourceMutationObserved, true);
    assert.equal(payload.ledger.changedPaths.includes("src/parser.py"), true);
    assert.equal(payload.finalAnswer, "Done.");
    return {
      canFinalize: false,
      confidence: 0.9,
      missingEvidence: ["runner evidence for changed behavior"],
      nextAction: "verify_existing_evidence",
      reason: "The attempted final answer lacks post-mutation verification evidence.",
      requiredEvidence: ["nearest existing test or equivalent user-facing evidence"],
    };
  });
  registerChalinAutoRouter(pi as unknown as ExtensionAPI);
  await pi.emit("before_agent_start", { prompt: "fix parser behavior", systemPrompt: "" }, { cwd: process.cwd(), model, modelRegistry });
  await pi.emit("tool_execution_start", { toolName: "edit", args: { path: "src/parser.py" } });
  await pi.emit("tool_execution_end", { toolName: "edit", args: { path: "src/parser.py", newText: "def parse(value):\n    return value\n" } });

  const replacement = await pi.emit("message_end", {
    message: {
      role: "assistant",
      content: [{ type: "text", text: "Done." }],
    },
  });

  const gateMessage = pi.messages.find((item) => item.message.customType === "pi-chalin-completion-gate-block");
  assert.equal(gateMessage, undefined);
  const replacementText = JSON.stringify(replacement);
  assert.match(replacementText, /completion gate/i);
  assert.match(replacementText, /cannot call this complete yet/i);
  assert.match(replacementText, /runner evidence for changed behavior/i);
  assert.doesNotMatch(replacementText, /Continuing after the completion gate found missing evidence/i);
});

test("autoroute steers away from inline bypass when delegated mutable work is still paused", async () => {
  const pi = new FakePi();
  registerChalinAutoRouter(pi as unknown as ExtensionAPI);

  await pi.emit("tool_execution_end", {
    toolName: "chalin_resume",
    result: {
      details: {
        run: {
          id: "run-paused",
          rootTask: "Implement the API client.",
          status: "paused",
          steps: [
            {
              id: "step-worker",
              agent: "worker",
              task: "Apply the API client implementation.",
              status: "pending",
              workUnitId: "unit-client",
            },
          ],
          workUnits: [
            {
              id: "unit-client",
              title: "API client implementation",
              kind: "implementation",
              status: "pending",
              scope: ["API client source and tests"],
              dependencies: [],
              expectedEffects: ["read", "write", "verify"],
              acceptanceCriteria: ["Client implementation and tests are complete"],
              workerStepId: "step-worker",
              createdFrom: "route-plan",
            },
          ],
          warnings: [],
        },
      },
    },
  });

  const nudge = pi.messages.find((item) => item.message.customType === "pi-chalin-delegated-work-pending-nudge");
  assert.equal(nudge?.message.display, false);
  assert.equal(nudge?.options.triggerTurn, false);
  assert.equal(nudge?.options.deliverAs, "steer");
  assert.match(nudge?.message.content ?? "", /pending delegated workspace mutation/i);
  assert.match(nudge?.message.content ?? "", /Do not continue this delegated implementation inline/i);
  assert.equal(pi.messages.some((item) => item.message.customType === "pi-chalin-synthesis-nudge"), false);
});

test("autoroute passes compact tool-result observations into the completion gate", async () => {
  const pi = new FakePi();
  const model = { api: "provider-neutral-api", id: "any-model" };
  const modelRegistry = { id: "registry" };
  setCompletionGateJudgeForTests(async ({ payload }) => {
    const observationText = payload.ledger.observations.map((item) => item.text).join("\n");
    assert.equal(observationText.includes("existing test transforms the full fixture"), true);
    assert.equal(observationText.includes("custom probe passed only minimal transformed input"), true);
    assert.equal(payload.ledger.observations.some((item) => item.path === "tests/test_parser.py" && item.afterLatestMutation === false), true);
    assert.equal(payload.ledger.observations.some((item) => item.command?.includes("python -") && item.afterLatestMutation === true), true);
    return {
      canFinalize: false,
      confidence: 0.9,
      missingEvidence: ["custom probe is narrower than observed existing fixture flow"],
      nextAction: "expand_custom_probe",
      reason: "The compact observations show an existing full-fixture transformation and a smaller custom probe.",
      requiredEvidence: ["representative evidence mirroring the observed fixture flow"],
    };
  });
  registerChalinAutoRouter(pi as unknown as ExtensionAPI);
  await pi.emit("before_agent_start", { prompt: "fix parser behavior", systemPrompt: "" }, { cwd: process.cwd(), model, modelRegistry });
  await pi.emit("tool_execution_end", {
    toolName: "read",
    args: { path: "tests/test_parser.py" },
    result: { content: [{ type: "text", text: "def test_existing_surface():\n    existing test transforms the full fixture and checks preservation" }] },
  }, { cwd: process.cwd() });
  await pi.emit("tool_execution_end", {
    toolName: "edit",
    args: { path: "src/parser.py" },
    result: { content: [{ type: "text", text: "Edited src/parser.py" }] },
  }, { cwd: process.cwd() });
  await pi.emit("tool_execution_end", {
    toolName: "bash",
    args: { command: "python - <<'PY'\nprint('probe')\nPY" },
    result: { content: [{ type: "text", text: "custom probe passed only minimal transformed input" }] },
  }, { cwd: process.cwd() });

  const replacement = await pi.emit("message_end", {
    message: {
      role: "assistant",
      content: [{ type: "text", text: "Done." }],
    },
  }, { cwd: process.cwd() });

  const gateMessage = pi.messages.find((item) => item.message.customType === "pi-chalin-completion-gate-block");
  assert.equal(gateMessage, undefined);
  const replacementText = JSON.stringify(replacement);
  assert.match(replacementText, /completion gate/i);
  assert.match(replacementText, /cannot call this complete yet/i);
  assert.doesNotMatch(replacementText, /Continuing after the completion gate found missing evidence/i);
  const audit = pi.entries.find((entry) => entry.customType === "pi-chalin-completion-gate-decision");
  assert.match(JSON.stringify(audit?.data), /expand_custom_probe/);
});

test("autoroute treats a running background bash job as pending instead of passing evidence", async () => {
  const pi = new FakePi();
  const model = { api: "provider-neutral-api", id: "any-model" };
  const modelRegistry = { id: "registry" };
  setCompletionGateJudgeForTests(async () => {
    throw new Error("pending background jobs should produce a pending-turn replacement before semantic finalization");
  });
  registerChalinAutoRouter(pi as unknown as ExtensionAPI);
  await pi.emit("before_agent_start", { prompt: "fix parser and verify it", systemPrompt: "" }, { cwd: process.cwd(), model, modelRegistry });
  await pi.emit("tool_execution_end", {
    toolName: "edit",
    args: { path: "src/parser.py" },
    result: { content: [{ type: "text", text: "Edited src/parser.py" }] },
  }, { cwd: process.cwd() });
  await pi.emit("tool_execution_end", {
    toolName: "chalin_bash_job",
    args: { action: "start", command: "pnpm test" },
    result: {
      content: [{ type: "text", text: "background job verify-parser: running" }],
      details: {
        job: {
          id: "verify-parser",
          command: "pnpm test",
          status: "running",
          requiredEvidence: true,
          completionAction: "resume",
        },
      },
    },
  }, { cwd: process.cwd() });

  const replacement = await pi.emit("message_end", {
    message: {
      role: "assistant",
      content: [{ type: "text", text: "Done." }],
    },
  }, { cwd: process.cwd() });

  const replacementText = JSON.stringify(replacement);
  assert.match(replacementText, /Background verification is still running/i);
  assert.match(replacementText, /verify-parser: running/i);
  assert.match(replacementText, /resume requested on finish/i);
});

test("autoroute carries prior completion gate blocks into later finalization attempts", async () => {
  const pi = new FakePi();
  const model = { api: "provider-neutral-api", id: "any-model" };
  const modelRegistry = { id: "registry" };
  let calls = 0;
  setCompletionGateJudgeForTests(async ({ payload }) => {
    calls += 1;
    if (calls === 1) {
      assert.equal(payload.priorBlocks, undefined);
      return {
        canFinalize: false,
        confidence: 0.87,
        missingEvidence: ["representative fixture evidence"],
        nextAction: "expand_custom_probe",
        reason: "The attempted final used a narrower probe.",
        requiredEvidence: ["run a full observed fixture variant"],
      };
    }
    assert.deepEqual(payload.priorBlocks?.map((block) => [block.nextAction, block.missingEvidence, block.requiredEvidence]), [
      ["expand_custom_probe", ["representative fixture evidence"], ["run a full observed fixture variant"]],
    ]);
    return {
      canFinalize: true,
      confidence: 0.9,
      missingEvidence: [],
      nextAction: "finalize",
      reason: "The previous gate block was visible to the later decision.",
    };
  });
  registerChalinAutoRouter(pi as unknown as ExtensionAPI);
  await pi.emit("before_agent_start", { prompt: "fix parser behavior", systemPrompt: "" }, { cwd: process.cwd(), model, modelRegistry });
  await pi.emit("tool_execution_end", {
    toolName: "edit",
    args: { path: "src/parser.py", newText: "def parse(value):\n    return value\n" },
    result: { content: [{ type: "text", text: "Edited src/parser.py" }] },
  }, { cwd: process.cwd() });

  await pi.emit("message_end", {
    message: {
      role: "assistant",
      content: [{ type: "text", text: "Done." }],
    },
  }, { cwd: process.cwd() });
  await pi.emit("message_end", {
    message: {
      role: "assistant",
      content: [{ type: "text", text: "Verified and done." }],
    },
  }, { cwd: process.cwd() });

  assert.equal(calls, 2);
});

test("autoroute failed-verification nudge preserves plausible fixes when the runner is blocked", async () => {
  const pi = new FakePi();
  registerChalinAutoRouter(pi as unknown as ExtensionAPI);
  await pi.emit("before_agent_start", { prompt: "fix normalization behavior", systemPrompt: "" }, { cwd: process.cwd() });
  await pi.emit("tool_execution_end", {
    toolName: "edit",
    args: { path: "src/parser.py", newText: "def parse(value):\n    return value\n" },
    result: { content: [{ type: "text", text: "Edited src/parser.py" }] },
  }, { cwd: process.cwd() });
  await pi.emit("tool_execution_end", {
    toolName: "bash",
    args: { command: "project test" },
    isError: true,
    result: { content: [{ type: "text", text: "test runner could not start because project configuration or dependencies are unavailable" }] },
  }, { cwd: process.cwd() });

  const nudge = pi.messages.find((item) => item.message.customType === "pi-chalin-inline-verification-failed-nudge");
  assert.equal(nudge?.message.display, false);
  assert.equal(nudge?.options.triggerTurn, false);
  assert.equal(nudge?.options.deliverAs, "steer");
  assert.match(nudge?.message.content ?? "", /behavioral evidence or environment\/tooling\/config\/dependency blockage/);
  assert.match(nudge?.message.content ?? "", /do not narrow, revert, or simplify a plausible source fix/);
  assert.match(nudge?.message.content ?? "", /direct representative evidence or a faithful surrogate/);
  assert.equal((nudge?.message.content ?? "").includes("OpenAI"), false);
  assert.equal((nudge?.message.content ?? "").includes("QDP"), false);
});

test("autoroute aborts pending semantic judge work when the visible turn ends", async () => {
  const pi = new FakePi();
  const model = { api: "generic-pi-api", id: "semantic-test-model" };
  const modelRegistry = { id: "semantic-test-registry" };
  let started!: () => void;
  let finished!: () => void;
  let aborted = false;
  const startedPromise = new Promise<void>((resolve) => { started = resolve; });
  const finishedPromise = new Promise<void>((resolve) => { finished = resolve; });
  setSemanticPolicyJudgeForTests(async ({ context }) => {
    started();
    await new Promise<void>((resolve) => {
      const signal = context.signal;
      if (!signal || signal.aborted) {
        aborted = true;
        resolve();
        return;
      }
      signal.addEventListener("abort", () => {
        aborted = true;
        resolve();
      }, { once: true });
    });
    finished();
    return {
      nextAction: "repair",
      nudgeKind: "source-and-test-ready",
      reason: "This result arrived after the turn was aborted and must not steer.",
      confidence: 0.95,
      blockingGap: true,
      requiredEvidence: ["nearest repo evidence"],
      steerMessage: "This late steer should be suppressed.",
    };
  });
  registerChalinAutoRouter(pi as unknown as ExtensionAPI);
  await pi.emit("before_agent_start", { prompt: "fix parser behavior", systemPrompt: "" }, { cwd: process.cwd(), model, modelRegistry });

  await pi.emit("tool_execution_end", {
    toolName: "edit",
    args: { path: "src/parser.py", newText: "def parse(value):\n    return value.strip()\n" },
    result: { content: [{ type: "text", text: "Edited src/parser.py" }] },
  }, { cwd: process.cwd(), model, modelRegistry });
  await pi.emit("tool_execution_end", {
    toolName: "edit",
    args: { path: "tests/test_parser.py", newText: "def test_parse():\n    assert parse(' x ') == 'x'\n" },
    result: { content: [{ type: "text", text: "Edited tests/test_parser.py" }] },
  }, { cwd: process.cwd(), model, modelRegistry });

  await startedPromise;
  await pi.emit("agent_end", {}, { cwd: process.cwd() });
  await finishedPromise;

  assert.equal(aborted, true);
  assert.equal(pi.messages.some((item) => item.message.customType === "pi-chalin-semantic-policy-judge"), false);
});

test("autoroute inline steers stay compact for normal edit and verify loops", async () => {
  const pi = new FakePi();
  registerChalinAutoRouter(pi as unknown as ExtensionAPI);
  await pi.emit("before_agent_start", { prompt: "fix normalization behavior", systemPrompt: "" }, { cwd: process.cwd() });

  await pi.emit("tool_execution_end", {
    toolName: "edit",
    args: { path: "src/parser.py", newText: "def parse(value):\n    return value.strip()\n" },
    result: { content: [{ type: "text", text: "Edited src/parser.py" }] },
  }, { cwd: process.cwd() });

  const progress = pi.messages.find((item) => item.message.customType === "pi-chalin-inline-progress-nudge");
  assert.ok((progress?.message.content ?? "").length <= 520);
  assert.doesNotMatch(progress?.message.content ?? "", /Python unittest/);
  assert.doesNotMatch(progress?.message.content ?? "", /Final should be concise but complete/);

  await pi.emit("tool_execution_end", {
    toolName: "edit",
    args: { path: "test/parser.test.py", newText: "def test_parse_strips_value():\n    assert parse(' value ') == 'value'\n" },
    result: { content: [{ type: "text", text: "Edited test/parser.test.py" }] },
  }, { cwd: process.cwd() });

  await pi.emit("tool_execution_end", {
    toolName: "bash",
    args: { command: "repo-acceptance-check --changed-surface" },
    result: { content: [{ type: "text", text: "custom project acceptance passed" }] },
  }, { cwd: process.cwd() });

  const completion = pi.messages.find((item) => item.message.customType === "pi-chalin-inline-completion-nudge");
  assert.ok((completion?.message.content ?? "").length <= 760);
  assert.match(completion?.message.content ?? "", /Completion Gate before final/);
  assert.doesNotMatch(completion?.message.content ?? "", /test-matrix recap/);
});

test("autoroute reuses cached model context for completion gate at message end", async () => {
  const pi = new FakePi();
  const cwd = process.cwd();
  const model = { api: "generic-pi-api", id: "cached-model" };
  const modelRegistry = { id: "cached-registry" };
  setCompletionGateJudgeForTests(async ({ context }) => {
    assert.equal(context.cwd, cwd);
    assert.equal(context.model, model as any);
    assert.equal(context.modelRegistry, modelRegistry as any);
    return {
      canFinalize: true,
      confidence: 0.81,
      missingEvidence: [],
      nextAction: "finalize",
      reason: "The cached model context was available and the evidence is sufficient.",
    };
  });
  registerChalinAutoRouter(pi as unknown as ExtensionAPI);
  await pi.emit("before_agent_start", { prompt: "fix parser behavior", systemPrompt: "" }, { cwd, model, modelRegistry });
  await pi.emit("tool_execution_start", { toolName: "edit", args: { path: "src/parser.py" } });
  await pi.emit("tool_execution_end", { toolName: "edit", args: { path: "src/parser.py", newText: "def parse(value):\n    return value\n" } }, { cwd });

  await pi.emit("message_end", {
    message: {
      role: "assistant",
      content: [{ type: "text", text: "Done." }],
    },
  }, { cwd });

  const audit = pi.entries.find((entry) => entry.customType === "pi-chalin-completion-gate-decision");
  assert.match(JSON.stringify(audit?.data), /finalize/);
});

test("autoroute keeps completion gate state if agent_end arrives before final message_end", async () => {
  const pi = new FakePi();
  const model = { api: "generic-pi-api", id: "cached-model" };
  const modelRegistry = { id: "cached-registry" };
  setCompletionGateJudgeForTests(async () => ({
    canFinalize: true,
    confidence: 0.88,
    missingEvidence: [],
    nextAction: "finalize",
    reason: "The final message still passed through the completion gate.",
  }));
  registerChalinAutoRouter(pi as unknown as ExtensionAPI);
  await pi.emit("before_agent_start", { prompt: "fix parser behavior", systemPrompt: "" }, { cwd: process.cwd(), model, modelRegistry });
  await pi.emit("tool_execution_start", { toolName: "edit", args: { path: "src/parser.py" } });
  await pi.emit("tool_execution_end", { toolName: "edit", args: { path: "src/parser.py", newText: "def parse(value):\n    return value\n" } }, { cwd: process.cwd() });

  await pi.emit("agent_end", {}, { cwd: process.cwd() });
  await pi.emit("message_end", {
    message: {
      role: "assistant",
      content: [{ type: "text", text: "Done." }],
    },
  }, { cwd: process.cwd() });

  const audit = pi.entries.find((entry) => entry.customType === "pi-chalin-completion-gate-decision");
  assert.match(JSON.stringify(audit?.data), /finalize/);
});

test("autoroute records an unavailable completion gate without hidden post-final follow-up", async () => {
  const pi = new FakePi();
  const model = { api: "generic-pi-api", id: "cached-model" };
  const modelRegistry = { id: "cached-registry" };
  setCompletionGateJudgeForTests(async () => undefined);
  registerChalinAutoRouter(pi as unknown as ExtensionAPI);
  await pi.emit("before_agent_start", { prompt: "fix parser behavior", systemPrompt: "" }, { cwd: process.cwd(), model, modelRegistry });
  await pi.emit("tool_execution_start", { toolName: "edit", args: { path: "src/parser.py" } });
  await pi.emit("tool_execution_end", { toolName: "edit", args: { path: "src/parser.py", newText: "def parse(value):\n    return value\n" } }, { cwd: process.cwd() });

  const replacement = await pi.emit("message_end", {
    message: {
      role: "assistant",
      content: [{ type: "text", text: "Done." }],
    },
  }, { cwd: process.cwd() });

  const fallback = pi.messages.find((item) => item.message.customType === "pi-chalin-completion-gate-self-check");
  assert.equal(fallback, undefined);
  assert.equal(pi.entries.some((entry) => entry.customType === "pi-chalin-completion-gate-diagnostic"), true);
  const replacementText = JSON.stringify(replacement);
  assert.match(replacementText, /completion gate/i);
  assert.match(replacementText, /cannot call this complete yet/i);
  assert.match(replacementText, /pre-final evidence check was unavailable/i);
  assert.doesNotMatch(replacementText, /Continuing because the completion gate could not finish/i);
});

test("autoroute does not loop unavailable completion gate diagnostics for the same evidence state", async () => {
  const pi = new FakePi();
  const model = { api: "generic-pi-api", id: "cached-model" };
  const modelRegistry = { id: "cached-registry" };
  setCompletionGateJudgeForTests(async () => undefined);
  registerChalinAutoRouter(pi as unknown as ExtensionAPI);
  await pi.emit("before_agent_start", { prompt: "fix parser behavior", systemPrompt: "" }, { cwd: process.cwd(), model, modelRegistry });
  await pi.emit("tool_execution_start", { toolName: "edit", args: { path: "src/parser.py" } });
  await pi.emit("tool_execution_end", { toolName: "edit", args: { path: "src/parser.py", newText: "def parse(value):\n    return value\n" } }, { cwd: process.cwd() });

  await pi.emit("message_end", {
    message: {
      role: "assistant",
      content: [{ type: "text", text: "Done." }],
    },
  }, { cwd: process.cwd() });
  await pi.emit("message_end", {
    message: {
      role: "assistant",
      content: [{ type: "text", text: "Implemented and verified." }],
    },
  }, { cwd: process.cwd() });

  const diagnosticCount = pi.entries.filter((entry) => entry.customType === "pi-chalin-completion-gate-diagnostic").length;
  assert.equal(pi.messages.filter((item) => item.message.customType === "pi-chalin-completion-gate-self-check").length, 0);
  assert.equal(diagnosticCount, 1);
});
