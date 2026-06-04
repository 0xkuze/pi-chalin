import { StringEnum, Type, type Api, type AssistantMessage, type Model } from "@earendil-works/pi-ai";
import { createAgentSession, DefaultResourceLoader, defineTool, getAgentDir, SessionManager, type ModelRegistry } from "@earendil-works/pi-coding-agent";
import { COMPLETION_GATE_ACTIONS, type CompletionGateDecision, type CompletionGatePayload, validateCompletionGateDecision } from "../runtime/completion-gate.ts";
import { parseJsonObject } from "../utils/json.ts";
import { isRecord } from "../utils/guards.ts";

export interface CompletionGateJudgeContext {
  cwd?: string;
  model?: Model<Api>;
  modelRegistry?: ModelRegistry;
  signal?: AbortSignal;
  agentSessionJudge?: CompletionGateAgentSessionJudge;
}

export interface CompletionGateJudgeInput {
  payload: CompletionGatePayload;
  context: CompletionGateJudgeContext;
  challengeDecision?: CompletionGateDecision;
}

type CompletionGateAgentSessionJudge = (input: CompletionGateJudgeInput) => Promise<CompletionGateDecision | undefined>;

export async function runCompletionGateJudge(input: CompletionGateJudgeInput): Promise<CompletionGateDecision | undefined> {
  const model = input.context.model;
  const registry = input.context.modelRegistry;
  if (!model || !registry) return undefined;
  const decision = await runCompletionGateJudgeAttempt(input);
  if (!shouldRunCompletionGateChallenge(input.payload, decision)) return decision;
  const challenged = await runCompletionGateJudgeAttempt({ ...input, challengeDecision: decision });
  if (challenged && !challenged.canFinalize) return challenged;
  return decision;
}

async function runCompletionGateJudgeAttempt(input: CompletionGateJudgeInput): Promise<CompletionGateDecision | undefined> {
  if (input.context.agentSessionJudge) return input.context.agentSessionJudge(input);
  return runAgentSessionCompletionGateJudge(input);
}

export function shouldRunCompletionGateChallenge(payload: CompletionGatePayload, decision: CompletionGateDecision | undefined): decision is CompletionGateDecision {
  if (!decision?.canFinalize) return false;
  const failedEvidenceExists = payload.ledger.failedPostMutationCommands.length > 0 || payload.ledger.failedCommandsAfterMutation.length > 0;
  if (!failedEvidenceExists) return false;
  const hasObservedExistingSurface = payload.ledger.observations.some((item) => item.toolName !== "edit" && item.toolName !== "write" && !item.afterLatestMutation);
  const hasPostMutationPassingCommand = payload.ledger.commandRecords.some((item) => item.afterLatestMutation && item.status === "pass");
  const hasPostFailureMutation = payload.ledger.postFailureMutationRecords.length > 0;
  return (hasObservedExistingSurface && hasPostMutationPassingCommand) || (hasPostFailureMutation && hasPostMutationPassingCommand);
}

export function shouldApplyCompletionGateDecision(decision: CompletionGateDecision | undefined): decision is CompletionGateDecision {
  if (!decision) return false;
  if (decision.canFinalize) return false;
  if (decision.confidence < 0.68) return false;
  return decision.nextAction !== "finalize";
}

export function parseCompletionGateDecision(message: AssistantMessage, options: { allowTextJson?: boolean } = {}): CompletionGateDecision | undefined {
  const toolResult = parseCompletionGateToolResult(message);
  if (toolResult) return toolResult;
  if (options.allowTextJson === false) return undefined;
  const text = message.content
    .filter((block): block is { type: "text"; text: string } => block.type === "text")
    .map((block) => block.text)
    .join("\n")
    .trim();
  const parsed = parseJsonObject(text);
  return parsed ? validateCompletionGateDecision(parsed) : undefined;
}

export const COMPLETION_GATE_TOOL_NAME = "completion_gate_result";
export const COMPLETION_GATE_RESULT_SCHEMA = Type.Object({
  canFinalize: Type.Boolean({ description: "Whether finalization is supported by the original request and current evidence." }),
  confidence: Type.Number({ minimum: 0, maximum: 1, description: "Confidence from 0 to 1." }),
  missingEvidence: Type.Array(Type.String({ minLength: 1, maxLength: 180 }), {
    maxItems: 8,
    description: "Compact evidence gaps that make finalization unsafe.",
  }),
  nextAction: StringEnum(COMPLETION_GATE_ACTIONS, { description: "Smallest next action required before finalization." }),
  reason: Type.String({ minLength: 1, maxLength: 1_200, description: "Compact reason grounded in the provided ledger." }),
  requiredEvidence: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 180 }), {
    maxItems: 8,
    description: "Concrete evidence labels required before finalization.",
  })),
}, { additionalProperties: false });

function parseCompletionGateToolResult(message: AssistantMessage): CompletionGateDecision | undefined {
  for (const block of message.content) {
    if (block.type !== "toolCall" || block.name !== COMPLETION_GATE_TOOL_NAME) continue;
    const result = validateCompletionGateDecision(block.arguments);
    if (result) return result;
  }
  return undefined;
}

function completionGateSystemPrompt(challengeDecision?: CompletionGateDecision): string {
  const base = [
    "You are pi-chalin's semantic completion gate for coding-agent work.",
    "You receive the original user prompt, a raw ledger of reads/writes/commands, runtime mutation state, and the attempted final answer.",
    "Use LLM judgment over the evidence. Do not use keyword matching, domain-specific checklists, regular expressions, memorized examples, or literal trigger phrases as decision logic.",
    "Decide whether the assistant can truthfully claim the task is complete. Completion means the requested behavior, relevant unchanged behavior, and stated constraints are supported by current evidence after the latest mutation.",
    "Treat raw command names and paths as evidence to interpret semantically, not as automatic pass/fail labels.",
    "Ledger observations are compact excerpts of real tool output. Use them to compare the original request, discovered existing surfaces, changed files, command results, and attempted final answer.",
    "Ledger mutationRecords are compact excerpts of write/edit arguments and outputs. Use them to compare earlier and later implementation hypotheses. If postFailureMutationRecords exist, explicitly audit whether the later mutation repaired the failed evidence or narrowed/reverted a plausible earlier fix after an environment/tooling blockage.",
    "If existing repo evidence, tests, fixtures, examples, docs, or runner-discovered surfaces were read or found, prefer evidence that exercises those surfaces over a smaller synthetic probe unless the probe clearly covers the same user-facing behavior and observed fixture/data transformations.",
    "If an existing evidence run was blocked by environment or tooling, custom evidence must mirror or subsume the observed test/fixture/example flow, including preservation paths and surrounding unchanged data shapes when those are visible in observations.",
    "For parser, format, serializer, tokenizer, command-reader, or normalization work, compare the custom command input with observed realistic examples. If the custom input only exercises the changed token or branch while observed examples include larger records, separators, missing/sentinel values, repeated blocks, comments, metadata, or other unchanged grammar states, require expanding the probe or running existing evidence.",
    "When the requested change is about case, whitespace, encoding, escaping, aliases, tolerance, or another normalization dimension, require representative evidence that applies that dimension consistently to the observed realistic input shape, not only to the edited token. A selective probe can finalize only if direct source, test, documentation, or specification evidence proves the surrounding grammar/data literals are intentionally outside the normalized contract.",
    "For normalization/tolerance changes after existing evidence is blocked, require metamorphic evidence: take an observed realistic fixture/example, or an equivalent full input shape, and apply the requested variation consistently across the whole input. A newly hand-built fixture with selected canonical literals is still partial. For case/normalization tasks, treat probes that vary only the target command/keyword while leaving surrounding grammar or data markers in canonical form as selective evidence, not representative evidence, unless direct repo/spec evidence proves the unchanged markers are intentionally canonical-only. Do not finalize from selective probes.",
    "Before allowing finalization, mentally construct the strongest plausible hidden regression test from the user's request, the latest diff, and the observed fixtures/examples. If current evidence does not rule out that realistic test failing, choose repair or expand_custom_probe instead of finalize.",
    "If a custom probe is the only post-mutation evidence, ask whether it covers the requested behavior in context plus an adjacent boundary or preservation path. If not, require expanding evidence or running existing evidence.",
    "If verification failed after mutation and no later evidence covers the same acceptance surface, require repair or representative evidence. If a human decision is genuinely required, choose ask.",
    "If the payload contains priorBlocks, treat every prior missingEvidence and requiredEvidence item as binding acceptance debt. A later final can pass only when new ledger evidence semantically satisfies those items, or when direct repo/spec evidence proves a prior item was unnecessary. Do not weaken or reinterpret prior blocks because a narrower later probe passed.",
    "Call completion_gate_result exactly once when the tool is available. Otherwise return JSON only with fields: canFinalize, confidence, missingEvidence, nextAction, reason, requiredEvidence.",
  ];
  if (!challengeDecision) return base.join("\n");
  return [
    ...base,
    "",
    "Adversarial challenge mode.",
    "A first completion gate decision allowed finalization even though the ledger contains earlier failed post-mutation evidence and later custom evidence.",
    "Your job is to audit that decision against the actual ledger, not to defer to it.",
    "If the ledger contains postFailureMutationRecords, compare the newer mutation with prior mutationRecords and failed command observations. If the newer mutation appears to narrow, remove, or contradict a plausible earlier implementation hypothesis, require repair unless later evidence proves the narrowed latest source state still satisfies the full user request and realistic observed surfaces.",
    "If the first decision claims a probe covered existing surfaces, verify that the command input/output in the ledger actually covers the realistic observed examples and the strongest plausible hidden regression test.",
    "If the decision relies on selective evidence, unstated assumptions, or an exclusion that is not proven by repo/spec evidence in the payload, return canFinalize false with repair or expand_custom_probe.",
    "Be especially skeptical of hand-built normalization probes. If they do not visibly transform an observed realistic fixture/example or an equivalent full input shape, treat them as insufficient after failed existing evidence. Reject selective probes that vary only the target command/keyword while leaving surrounding grammar or data markers canonical, unless direct repo/spec evidence in the payload proves those markers must remain canonical.",
    "Return canFinalize true only when the first decision's coverage claims are directly grounded in current post-mutation evidence.",
  ].join("\n");
}

async function runAgentSessionCompletionGateJudge(input: CompletionGateJudgeInput): Promise<CompletionGateDecision | undefined> {
  const model = input.context.model;
  const registry = input.context.modelRegistry;
  if (!model || !registry) return undefined;
  const cwd = input.context.cwd ?? process.cwd();
  let created: Awaited<ReturnType<typeof createAgentSession>> | undefined;
  try {
    const resourceLoader = new DefaultResourceLoader({
      cwd,
      agentDir: getAgentDir(),
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noContextFiles: true,
      systemPrompt: completionGateSystemPrompt(input.challengeDecision),
    });
    await resourceLoader.reload();
    created = await createAgentSession({
      cwd,
      model,
      modelRegistry: registry,
      sessionManager: SessionManager.inMemory(cwd),
      resourceLoader,
      noTools: "all",
      tools: [COMPLETION_GATE_TOOL_NAME],
      customTools: [createCompletionGateTool()],
      sessionStartEvent: { type: "session_start", reason: "new" },
    });
    const abortJudge = () => { void created?.session.abort(); };
    input.context.signal?.addEventListener("abort", abortJudge, { once: true });
    try {
      await created.session.prompt(completionGateSessionPrompt(input.payload, input.challengeDecision), {
        expandPromptTemplates: false,
        source: "extension",
      });
    } finally {
      input.context.signal?.removeEventListener("abort", abortJudge);
    }
    const messages = Array.isArray(created.session.state.messages) ? created.session.state.messages as unknown[] : [];
    return parseCompletionGateSessionMessages(messages);
  } catch {
    return undefined;
  } finally {
    created?.session.dispose();
  }
}

function createCompletionGateTool() {
  return defineTool({
    name: COMPLETION_GATE_TOOL_NAME,
    label: "Completion Gate",
    description: "Emit the final semantic completion-gate decision.",
    promptSnippet: "Emit the final completion-gate decision.",
    promptGuidelines: [
      `Call ${COMPLETION_GATE_TOOL_NAME} exactly once as the final action.`,
      "Do not answer in prose when this tool is available.",
    ],
    parameters: COMPLETION_GATE_RESULT_SCHEMA,
    async execute(_toolCallId, params) {
      const decision = validateCompletionGateDecision(params as Record<string, unknown>);
      return {
        content: [{ type: "text", text: decision ? `Accepted completion gate decision: ${decision.nextAction}` : "Rejected completion gate decision: failed schema validation." }],
        details: decision ?? { rejected: true, params },
        terminate: true,
      };
    },
  });
}

export function completionGateSessionPrompt(payload: CompletionGatePayload, challengeDecision?: CompletionGateDecision): string {
  return [
    completionGateSystemPrompt(challengeDecision),
    "",
    challengeDecision ? "First gate decision JSON:" : undefined,
    challengeDecision ? JSON.stringify(challengeDecision, null, 2) : undefined,
    challengeDecision ? "" : undefined,
    "Payload JSON:",
    JSON.stringify(payload, null, 2),
    "",
    "Final decision audit before calling completion_gate_result:",
    "- If priorBlocks exist, list mentally how new ledger evidence satisfies each prior requiredEvidence item. If any item is not satisfied by new evidence or direct repo/spec evidence, return canFinalize false.",
    "- If postFailureMutationRecords exist, compare them against prior mutationRecords and failed command observations. If a later edit narrowed, reverted, or contradicted a plausible earlier fix after an environment/tooling/config/dependency failure, return canFinalize false unless later evidence proves the latest source state still satisfies the full original request and realistic observed surfaces.",
    "- If failedPostMutationCommands exist, identify the failed acceptance surface and the later evidence that covers that same surface. A later narrower probe does not supersede a broader failed surface.",
    "- If the request concerns normalization/tolerance for an input language, parser, serializer, command reader, file format, or comparable surface, verify whether the later evidence varies the realistic observed input shape consistently. If it varies only the edited token/branch while keeping surrounding alphabetic grammar/data markers canonical, return canFinalize false unless direct source/test/doc/spec evidence in the payload proves those markers are intentionally excluded from the normalized contract.",
    "- If returning canFinalize true, the reason must explicitly ground the decision in current ledger evidence for prior blocks, failed surfaces, realistic observed shapes, and preservation paths when any are present.",
  ].filter((line): line is string => line !== undefined).join("\n");
}

function parseCompletionGateSessionMessages(messages: unknown[]): CompletionGateDecision | undefined {
  for (const message of [...messages].reverse()) {
    if (!isRecord(message)) continue;
    if (isRecord(message.details)) {
      const decision = validateCompletionGateDecision(message.details);
      if (decision) return decision;
    }
    if (message.role !== "assistant" || !Array.isArray(message.content)) continue;
    for (const block of message.content) {
      if (!isRecord(block) || block.type !== "toolCall" || block.name !== COMPLETION_GATE_TOOL_NAME || !isRecord(block.arguments)) continue;
      const decision = validateCompletionGateDecision(block.arguments);
      if (decision) return decision;
    }
  }
  return undefined;
}
