import assert from "node:assert/strict";
import { fauxAssistantMessage, fauxToolCall, registerFauxProvider } from "@earendil-works/pi-ai";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import { afterEach, test } from "bun:test";
import { beginChalinTurn, getSemanticPolicyJudgeResultsForTests, isSemanticPolicyJudgeRequestFresh, recordDirectToolCompletion, recordSemanticPolicyJudgeResult, resetRuntimeState } from "../src/runtime/state.ts";
import {
  parseSemanticPolicyJudgeResult,
  runSemanticPolicyJudge,
  SEMANTIC_POLICY_JUDGE_RESULT_SCHEMA,
  SEMANTIC_POLICY_JUDGE_TOOL_NAME,
  semanticPolicyJudgeStructuredOutputOptions,
  shouldApplySemanticPolicyJudgeResult,
  validateSemanticPolicyJudgeResult,
} from "../src/skills/semantic-policy-judge.ts";
import {
  DIRECT_DECISION_JUDGE_TOOL_NAME,
  directDecisionJudgeStructuredOutputOptions,
  parseDirectDecisionJudgeResult,
  runDirectDecisionJudge,
  shouldRejectDirectFromJudge,
  validateDirectDecisionJudgeResult,
} from "../src/skills/direct-decision-judge.ts";

afterEach(() => {
  resetRuntimeState();
});

test("direct policy automatically requests semantic review for quality-sensitive weak coverage gaps", () => {
  beginChalinTurn({ prompt: "Implement sortItems with focused tests.", cwd: "/tmp/pi-chalin-semantic-policy" });

  recordDirectToolCompletion({
    toolName: "write",
    path: "src/sortItems.ts",
    argsText: JSON.stringify({ path: "src/sortItems.ts", content: "export function sortItems(items) { return items; }\n" }),
  });
  const adapter = recordDirectToolCompletion({
    toolName: "write",
    path: "test/sortItems.test.ts",
    argsText: JSON.stringify({ path: "test/sortItems.test.ts", content: "test('empty', () => expect(1).toBe(1));\n" }),
  });

  assert.equal(adapter.policyJudge?.nudgeKind, "weak-test-coverage");
  assert.equal(adapter.policyJudge?.semanticReview?.trigger, "weak-test-coverage");
  assert.match(adapter.policyJudge?.semanticReview?.reasons.join("\n") ?? "", /semantic quality/i);
});

test("semantic policy review requests expire when direct turn state advances", () => {
  beginChalinTurn({ prompt: "Implement sortItems with focused tests.", cwd: "/tmp/pi-chalin-semantic-policy" });

  recordDirectToolCompletion({
    toolName: "write",
    path: "src/sortItems.ts",
    argsText: JSON.stringify({ path: "src/sortItems.ts", content: "export function sortItems(items) { return items; }\n" }),
  });
  const adapter = recordDirectToolCompletion({
    toolName: "write",
    path: "test/sortItems.test.ts",
    argsText: JSON.stringify({ path: "test/sortItems.test.ts", content: "test('empty', () => expect(1).toBe(1));\n" }),
  });
  const request = adapter.policyJudge?.semanticReview;

  assert.ok(request);
  assert.equal(isSemanticPolicyJudgeRequestFresh(request), true);

  recordDirectToolCompletion({
    toolName: "read",
    path: "src/sortItems.ts",
  });

  assert.equal(isSemanticPolicyJudgeRequestFresh(request), false);

  beginChalinTurn({ prompt: "Implement sortItems with focused tests.", cwd: "/tmp/pi-chalin-semantic-policy" });
  assert.equal(isSemanticPolicyJudgeRequestFresh(request), false, "same request key cannot survive into a later turn");
});

test("direct policy skips semantic review for mechanical progress and clean continue decisions", () => {
  beginChalinTurn({ prompt: "Inspect src/sortItems.ts.", cwd: "/tmp/pi-chalin-semantic-policy" });

  const readAdapter = recordDirectToolCompletion({
    toolName: "read",
    path: "src/sortItems.ts",
  });
  assert.equal(readAdapter.policyJudge?.nextAction, "continue");
  assert.equal(readAdapter.policyJudge?.semanticReview, undefined);

  const progressAdapter = recordDirectToolCompletion({
    toolName: "edit",
    path: "src/sortItems.ts",
    argsText: JSON.stringify({ path: "src/sortItems.ts", content: "export function sortItems(items) { return items; }\n" }),
  });
  assert.equal(progressAdapter.policyJudge?.nudgeKind, "progress");
  assert.equal(progressAdapter.policyJudge?.semanticReview, undefined);
});

test("semantic policy result can only make deterministic decisions stricter", () => {
  const deterministic = {
    nextAction: "finalize" as const,
    reason: "Deterministic completion.",
    confidence: 0.9,
    blockingGap: false,
    nudgeKind: "completion" as const,
  };

  assert.equal(shouldApplySemanticPolicyJudgeResult(deterministic, {
    nextAction: "verify",
    reason: "Evidence is still missing.",
    confidence: 0.82,
    blockingGap: true,
    requiredEvidence: ["bun test"],
  }), true);
  assert.equal(shouldApplySemanticPolicyJudgeResult(deterministic, {
    nextAction: "finalize",
    reason: "Looks good.",
    confidence: 0.99,
    blockingGap: false,
    requiredEvidence: [],
  }), false);
  assert.equal(shouldApplySemanticPolicyJudgeResult({
    ...deterministic,
    nextAction: "block",
    blockingGap: true,
    nudgeKind: "workspace-boundary",
  }, {
    nextAction: "repair",
    reason: "Try repair.",
    confidence: 0.95,
    blockingGap: true,
    requiredEvidence: ["workspace"],
  }), false);

  const deterministicRepair = {
    ...deterministic,
    nextAction: "repair" as const,
    blockingGap: true,
    nudgeKind: "failure" as const,
  };
  assert.equal(shouldApplySemanticPolicyJudgeResult(deterministicRepair, {
    nextAction: "verify",
    reason: "Run verification.",
    confidence: 0.95,
    blockingGap: true,
    requiredEvidence: ["bun test"],
  }), false, "semantic verify would relax a deterministic repair");
  assert.equal(shouldApplySemanticPolicyJudgeResult(deterministicRepair, {
    nextAction: "block",
    reason: "Workspace boundary is still unsafe.",
    confidence: 0.95,
    blockingGap: true,
    requiredEvidence: ["current cwd"],
  }), true, "semantic block is stricter than deterministic repair");
});

test("semantic policy result parser accepts strict JSON objects with compact evidence", () => {
  const parsed = parseSemanticPolicyJudgeResult(fauxAssistantMessage([
    "The decision is:",
    "```json",
    JSON.stringify({
      nextAction: "repair",
      reason: " Missing focused assertions before final. ",
      confidence: 0.84,
      blockingGap: true,
      requiredEvidence: [" bun test test/sortItems.test.ts ", "test/sortItems.test.ts"],
    }),
    "```",
  ].join("\n")));

  assert.ok(parsed);
  const { trace, ...result } = parsed;
  assert.deepEqual(result, {
    nextAction: "repair",
    reason: "Missing focused assertions before final.",
    confidence: 0.84,
    blockingGap: true,
    requiredEvidence: ["bun test test/sortItems.test.ts", "test/sortItems.test.ts"],
  });
  assert.equal(trace?.mode, "json-fallback");
  assert.equal(typeof trace?.usage.totalTokens, "number");
});

test("semantic policy result parser rejects malformed schema-like JSON", () => {
  const valid = {
    nextAction: "repair",
    reason: "Missing focused assertions before final.",
    confidence: 0.84,
    blockingGap: true,
    requiredEvidence: ["bun test"],
  };

  for (const malformed of [
    { ...valid, nextAction: "done" },
    { ...valid, reason: "" },
    { ...valid, confidence: "0.84" },
    { ...valid, confidence: 1.01 },
    { ...valid, blockingGap: "true" },
    { ...valid, requiredEvidence: "bun test" },
    { ...valid, requiredEvidence: ["bun test", 42] },
    { ...valid, requiredEvidence: [""] },
    { ...valid, extra: "field" },
  ]) {
    assert.equal(parseSemanticPolicyJudgeResult(fauxAssistantMessage(JSON.stringify(malformed))), undefined);
  }
});

test("semantic policy schema is closed and structured output is only enabled for forceable tool APIs", () => {
  const schema = SEMANTIC_POLICY_JUDGE_RESULT_SCHEMA as unknown as {
    additionalProperties: boolean;
    properties: Record<string, { enum?: string[] }>;
  };
  assert.equal(schema.additionalProperties, false);
  assert.deepEqual(Object.keys(schema.properties).sort(), [
    "blockingGap",
    "confidence",
    "nextAction",
    "reason",
    "requiredEvidence",
  ]);
  assert.ok(schema.properties.nextAction?.enum?.includes("repair"));

  assert.deepEqual(semanticPolicyJudgeStructuredOutputOptions("openai-completions"), {
    toolChoice: { type: "function", function: { name: SEMANTIC_POLICY_JUDGE_TOOL_NAME } },
  });
  assert.deepEqual(semanticPolicyJudgeStructuredOutputOptions("anthropic-messages"), {
    toolChoice: { type: "tool", name: SEMANTIC_POLICY_JUDGE_TOOL_NAME },
  });
  assert.deepEqual(semanticPolicyJudgeStructuredOutputOptions("google-generative-ai"), {
    toolChoice: "any",
  });
  assert.equal(semanticPolicyJudgeStructuredOutputOptions("openai-responses"), undefined);
  assert.equal(semanticPolicyJudgeStructuredOutputOptions("openai-codex-responses"), undefined);
});

test("semantic policy validator rejects unknown fields before parsing trace metadata", () => {
  assert.equal(validateSemanticPolicyJudgeResult({
    nextAction: "verify",
    reason: "Needs evidence.",
    confidence: 0.88,
    blockingGap: true,
    requiredEvidence: ["bun test"],
    providerInjectedField: true,
  }), undefined);
});

test("semantic policy parser prefers schema-constrained tool calls and records usage trace", () => {
  const parsed = parseSemanticPolicyJudgeResult(fauxAssistantMessage([
    fauxToolCall(SEMANTIC_POLICY_JUDGE_TOOL_NAME, {
      nextAction: "verify",
      reason: "Focused test evidence is missing.",
      confidence: 0.91,
      blockingGap: true,
      requiredEvidence: ["bun test test/sortItems.test.ts"],
    }),
  ], { stopReason: "toolUse", responseId: "judge-response-1" }));

  assert.ok(parsed);
  assert.equal(parsed.nextAction, "verify");
  assert.equal(parsed.trace?.mode, "tool-schema");
  assert.equal(parsed.trace?.responseId, "judge-response-1");
  assert.equal(parsed.trace?.stopReason, "toolUse");
  assert.equal(typeof parsed.trace?.usage.totalTokens, "number");

  recordSemanticPolicyJudgeResult(parsed);
  const stored = getSemanticPolicyJudgeResultsForTests();
  assert.equal(stored.length, 1);
  assert.deepEqual(stored[0], parsed);

  stored[0]!.trace!.usage.cost.total = 999;
  assert.notEqual(getSemanticPolicyJudgeResultsForTests()[0]?.trace?.usage.cost.total, 999);
});

test("semantic policy judge falls back to JSON validation and traces usage when SDK cannot force tool output", async () => {
  const registration = registerFauxProvider({
    api: "semantic-policy-faux",
    provider: "semantic-policy-faux",
  });
  try {
    registration.setResponses([
      (context, options) => {
        assert.equal(context.tools, undefined);
        assert.equal((options as { reasoning?: string } | undefined)?.reasoning, "low");
        return fauxAssistantMessage(JSON.stringify({
          nextAction: "repair",
          reason: "Assertions do not prove the requested behavior.",
          confidence: 0.86,
          blockingGap: true,
          requiredEvidence: ["test/sortItems.test.ts"],
        }), { responseId: "json-fallback-response" });
      },
    ]);

    const result = await runSemanticPolicyJudge({
      deterministic: {
        nextAction: "finalize",
        reason: "Completion nudge.",
        confidence: 0.9,
        blockingGap: false,
      },
      request: {
        key: "semantic-policy-test",
        turnId: 1,
        trigger: "weak-test-coverage",
        reasons: ["semantic quality review"],
        snapshot: {
          cwd: "/tmp/pi-chalin-semantic-policy",
          docsOnlyPathPrompt: false,
          mutationObserved: true,
          sourceMutationObserved: true,
          testMutationObserved: true,
          verificationObserved: true,
          docsOnlyMutation: false,
          changedPaths: ["src/sortItems.ts", "test/sortItems.test.ts"],
          readPaths: [],
          promptCodePaths: [],
          toolEvents: [],
          counters: {
            mutationToolCount: 2,
            evidenceToolCount: 0,
            searchToolCount: 0,
            readToolCount: 0,
            verificationAttemptCount: 1,
            postFailureEvidenceToolCount: 0,
          },
        },
      },
      context: {
        model: registration.getModel(),
        modelRegistry: {
          getApiKeyAndHeaders: async () => ({ ok: true as const, apiKey: "test-key" }),
        } as unknown as ModelRegistry,
      },
    });

    assert.ok(result);
    assert.equal(result.nextAction, "repair");
    assert.equal(result.trace?.mode, "json-fallback");
    assert.equal(result.trace?.api, "semantic-policy-faux");
    assert.equal(result.trace?.responseId, "json-fallback-response");
    assert.ok(result.trace.usage.totalTokens > 0);
  } finally {
    registration.unregister();
  }
});

test("direct decision judge parses strict route and interview decisions", () => {
  const route = parseDirectDecisionJudgeResult(fauxAssistantMessage([
    fauxToolCall(DIRECT_DECISION_JUDGE_TOOL_NAME, {
      decision: "route",
      reason: "The proposed direct scope needs independent evidence synthesis.",
      confidence: 0.89,
      blockers: ["independent evidence synthesis"],
    }),
  ], { stopReason: "toolUse", responseId: "direct-decision-route" }));

  assert.ok(route);
  assert.equal(route.decision, "route");
  assert.equal(route.trace?.mode, "tool-schema");
  assert.equal(shouldRejectDirectFromJudge(route), true);

  const interview = validateDirectDecisionJudgeResult({
    decision: "interview",
    reason: "A human tradeoff blocks a responsible plan.",
    confidence: 0.8,
    blockers: ["human tradeoff"],
  });
  assert.ok(interview);
  assert.equal(shouldRejectDirectFromJudge(interview), true);
});

test("direct decision judge does not reject low confidence or direct decisions", () => {
  assert.equal(shouldRejectDirectFromJudge({
    decision: "route",
    reason: "Weak signal only.",
    confidence: 0.4,
    blockers: ["weak signal"],
  }), false);
  assert.equal(shouldRejectDirectFromJudge({
    decision: "direct",
    reason: "One bounded surface.",
    confidence: 0.92,
    blockers: [],
  }), false);
});

test("direct decision judge falls back to JSON validation with high reasoning", async () => {
  const registration = registerFauxProvider({
    api: "direct-decision-faux",
    provider: "direct-decision-faux",
  });
  try {
    registration.setResponses([
      (context, options) => {
        assert.equal(context.tools, undefined);
        assert.equal((options as { reasoning?: string } | undefined)?.reasoning, "high");
        return fauxAssistantMessage(JSON.stringify({
          decision: "route",
          reason: "The task requires reconstruction of current project state before a reliable answer.",
          confidence: 0.87,
          blockers: ["current project state reconstruction"],
        }), { responseId: "direct-decision-json" });
      },
    ]);

    const result = await runDirectDecisionJudge({
      task: "Explain what changed in the active workspace.",
      reason: "This was proposed as direct.",
      scope: {
        oneOwnershipSurface: true,
        clearAcceptanceSurface: true,
        parentVerifiableWithoutDelegation: true,
        needsRepositoryStateOrHistorySynthesis: false,
        needsMultipleLocalEvidenceSurfaces: false,
        needsBroadWorkspaceEvidence: false,
        needsDelegatedReviewOrSplitCoverage: false,
      },
      context: {
        model: registration.getModel(),
        modelRegistry: {
          getApiKeyAndHeaders: async () => ({ ok: true as const, apiKey: "test-key" }),
        } as unknown as ModelRegistry,
      },
    });

    assert.ok(result);
    assert.equal(result.decision, "route");
    assert.equal(result.trace?.mode, "json-fallback");
    assert.equal(result.trace?.responseId, "direct-decision-json");
    assert.equal(shouldRejectDirectFromJudge(result), true);
  } finally {
    registration.unregister();
  }
});

test("direct decision judge schema is closed and uses provider tool forcing where supported", () => {
  assert.equal(validateDirectDecisionJudgeResult({
    decision: "route",
    reason: "Needs routed evidence.",
    confidence: 0.9,
    blockers: ["evidence"],
    extra: "field",
  }), undefined);
  assert.deepEqual(directDecisionJudgeStructuredOutputOptions("openai-completions"), {
    toolChoice: { type: "function", function: { name: DIRECT_DECISION_JUDGE_TOOL_NAME } },
  });
  assert.deepEqual(directDecisionJudgeStructuredOutputOptions("anthropic-messages"), {
    toolChoice: { type: "tool", name: DIRECT_DECISION_JUDGE_TOOL_NAME },
  });
  assert.equal(directDecisionJudgeStructuredOutputOptions("openai-responses"), undefined);
});
