import { complete, completeSimple, StringEnum, Type, type Api, type AssistantMessage, type Context, type Model, type ProviderStreamOptions, type Tool } from "@earendil-works/pi-ai";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import type { PolicyJudgeDecision, PolicyJudgeNextAction, SemanticPolicyJudgeRequest, SemanticPolicyJudgeResult, SemanticPolicyJudgeTrace } from "./runtime-state.ts";

export interface SemanticPolicyJudgeContext {
  model?: Model<Api>;
  modelRegistry?: ModelRegistry;
  signal?: AbortSignal;
}

export interface SemanticPolicyJudgeInput {
  deterministic: PolicyJudgeDecision;
  request: SemanticPolicyJudgeRequest;
  context: SemanticPolicyJudgeContext;
}

export async function runSemanticPolicyJudge(input: SemanticPolicyJudgeInput): Promise<SemanticPolicyJudgeResult | undefined> {
  const model = input.context.model;
  const registry = input.context.modelRegistry;
  if (!model || !registry) return undefined;
  const auth = await registry.getApiKeyAndHeaders(model);
  if (!auth.ok) return undefined;
  const structuredOutputOptions = semanticPolicyJudgeStructuredOutputOptions(model.api);
  const baseOptions = {
    apiKey: auth.apiKey,
    headers: auth.headers,
    temperature: 0,
    maxTokens: 420,
    timeoutMs: semanticPolicyJudgeTimeoutMs(),
    maxRetries: 0,
    signal: input.context.signal,
  };
  try {
    const context: Context = {
      systemPrompt: semanticPolicyJudgeSystemPrompt(),
      messages: [{
        role: "user",
        timestamp: Date.now(),
        content: JSON.stringify(semanticPolicyJudgePayload(input), null, 2),
      }],
    };
    if (structuredOutputOptions) context.tools = [SEMANTIC_POLICY_JUDGE_TOOL];
    const response = structuredOutputOptions
      ? await complete(model, context, { ...baseOptions, ...structuredOutputOptions })
      : await completeSimple(model, context, { ...baseOptions, reasoning: "low" });
    return parseSemanticPolicyJudgeResult(response);
  } catch {
    return undefined;
  }
}

export function shouldApplySemanticPolicyJudgeResult(deterministic: PolicyJudgeDecision, semantic: SemanticPolicyJudgeResult | undefined): semantic is SemanticPolicyJudgeResult {
  if (!semantic) return false;
  if (!semantic.blockingGap) return false;
  if (semantic.confidence < 0.74) return false;
  if (semantic.nextAction === "continue" || semantic.nextAction === "finalize") return false;
  return actionStrictness(semantic.nextAction) > actionStrictness(deterministic.nextAction);
}

export function formatSemanticPolicyJudgeSteer(result: SemanticPolicyJudgeResult): string {
  return [
    "pi-chalin semantic policy judge.",
    `Decision: ${result.nextAction} (${Math.round(result.confidence * 100)}% confidence).`,
    `Reason: ${result.reason}`,
    result.requiredEvidence.length
      ? `Required evidence before final: ${result.requiredEvidence.map((item) => `\`${item}\``).join(", ")}.`
      : undefined,
    "This semantic judge cannot override deterministic hard stops. Treat it as an extra review signal: patch or verify the named gap, then finish only with concrete evidence.",
  ].filter((line): line is string => Boolean(line)).join("\n");
}

function semanticPolicyJudgePayload(input: SemanticPolicyJudgeInput): Record<string, unknown> {
  return {
    deterministicDecision: {
      nextAction: input.deterministic.nextAction,
      nudgeKind: input.deterministic.nudgeKind,
      reason: input.deterministic.reason,
      confidence: input.deterministic.confidence,
      blockingGap: input.deterministic.blockingGap,
    },
    semanticRequest: {
      trigger: input.request.trigger,
      reasons: input.request.reasons,
    },
    directWorkSnapshot: input.request.snapshot,
  };
}

function semanticPolicyJudgeSystemPrompt(): string {
  return [
    "You are pi-chalin's semantic policy judge for direct coding work.",
    "Use the deterministic decision as the baseline. Never relax deterministic safety, workspace, or verification constraints.",
    "Only make the decision stricter when the snapshot shows a semantic quality or evidence gap that code rules may miss.",
    "When a semantic_policy_judge_result tool is available, call it exactly once with the final decision.",
    "Otherwise return JSON only with fields: nextAction, reason, confidence, blockingGap, requiredEvidence.",
    "nextAction must be one of: continue, nudge, verify, repair, finalize, block.",
    "confidence is 0..1. requiredEvidence is an array of compact path/command/evidence labels.",
  ].join("\n");
}

const SEMANTIC_POLICY_JUDGE_TIMEOUT_MS = 20_000;
const SEMANTIC_POLICY_JUDGE_ACTIONS = ["continue", "nudge", "verify", "repair", "finalize", "block"] as const satisfies readonly PolicyJudgeNextAction[];
const SEMANTIC_POLICY_JUDGE_RESULT_KEYS = new Set(["nextAction", "reason", "confidence", "blockingGap", "requiredEvidence"]);
export const SEMANTIC_POLICY_JUDGE_TOOL_NAME = "semantic_policy_judge_result";
export const SEMANTIC_POLICY_JUDGE_RESULT_SCHEMA = Type.Object({
  nextAction: StringEnum(SEMANTIC_POLICY_JUDGE_ACTIONS, { description: "Strictest next action justified by the runtime snapshot." }),
  reason: Type.String({ minLength: 1, maxLength: 1_200, description: "Compact technical reason for the decision." }),
  confidence: Type.Number({ minimum: 0, maximum: 1, description: "Judge confidence from 0 to 1." }),
  blockingGap: Type.Boolean({ description: "Whether the gap should block finalization." }),
  requiredEvidence: Type.Array(Type.String({ minLength: 1, maxLength: 180 }), {
    maxItems: 8,
    description: "Path, command, or evidence labels required before finalization.",
  }),
}, { additionalProperties: false });
const SEMANTIC_POLICY_JUDGE_TOOL = {
  name: SEMANTIC_POLICY_JUDGE_TOOL_NAME,
  description: "Emit the final semantic policy judge decision.",
  parameters: SEMANTIC_POLICY_JUDGE_RESULT_SCHEMA,
} as const satisfies Tool;
const POLICY_ACTION_STRICTNESS = {
  continue: 0,
  finalize: 0,
  nudge: 1,
  verify: 2,
  repair: 3,
  block: 4,
} as const satisfies Record<PolicyJudgeNextAction, number>;

export function parseSemanticPolicyJudgeResult(message: AssistantMessage): SemanticPolicyJudgeResult | undefined {
  const toolResult = parseSemanticPolicyJudgeToolResult(message);
  if (toolResult) return withSemanticPolicyJudgeTrace(toolResult, message, "tool-schema");
  const text = message.content
    .filter((block): block is { type: "text"; text: string } => block.type === "text")
    .map((block) => block.text)
    .join("\n")
    .trim();
  const parsed = parseJsonObject(text);
  if (!parsed) return undefined;
  const result = validateSemanticPolicyJudgeResult(parsed);
  return result ? withSemanticPolicyJudgeTrace(result, message, "json-fallback") : undefined;
}

function parseJsonObject(text: string): Record<string, unknown> | undefined {
  const trimmed = extractJsonObjectText(text);
  if (!trimmed) return undefined;
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : undefined;
  } catch {
    return undefined;
  }
}

export function validateSemanticPolicyJudgeResult(parsed: Record<string, unknown>): SemanticPolicyJudgeResult | undefined {
  if (Object.keys(parsed).some((key) => !SEMANTIC_POLICY_JUDGE_RESULT_KEYS.has(key))) return undefined;
  if (!isPolicyJudgeNextAction(parsed.nextAction)) return undefined;
  const reason = compactString(parsed.reason, 1_200);
  if (!reason) return undefined;
  if (typeof parsed.confidence !== "number" || !Number.isFinite(parsed.confidence) || parsed.confidence < 0 || parsed.confidence > 1) return undefined;
  if (typeof parsed.blockingGap !== "boolean") return undefined;
  if (!Array.isArray(parsed.requiredEvidence) || parsed.requiredEvidence.length > 8) return undefined;
  const requiredEvidence = validateRequiredEvidence(parsed.requiredEvidence);
  if (!requiredEvidence) return undefined;
  return {
    nextAction: parsed.nextAction,
    reason,
    confidence: parsed.confidence,
    blockingGap: parsed.blockingGap,
    requiredEvidence,
  };
}

function parseSemanticPolicyJudgeToolResult(message: AssistantMessage): SemanticPolicyJudgeResult | undefined {
  for (const block of message.content) {
    if (block.type !== "toolCall" || block.name !== SEMANTIC_POLICY_JUDGE_TOOL_NAME) continue;
    const result = validateSemanticPolicyJudgeResult(block.arguments);
    if (result) return result;
  }
  return undefined;
}

function withSemanticPolicyJudgeTrace(result: SemanticPolicyJudgeResult, message: AssistantMessage, mode: SemanticPolicyJudgeTrace["mode"]): SemanticPolicyJudgeResult {
  return {
    ...result,
    trace: semanticPolicyJudgeTrace(message, mode),
  };
}

function semanticPolicyJudgeTrace(message: AssistantMessage, mode: SemanticPolicyJudgeTrace["mode"]): SemanticPolicyJudgeTrace {
  return {
    mode,
    api: message.api,
    provider: message.provider,
    model: message.model,
    responseModel: message.responseModel,
    responseId: message.responseId,
    stopReason: message.stopReason,
    usage: {
      input: message.usage.input,
      output: message.usage.output,
      cacheRead: message.usage.cacheRead,
      cacheWrite: message.usage.cacheWrite,
      totalTokens: message.usage.totalTokens,
      cost: {
        input: message.usage.cost.input,
        output: message.usage.cost.output,
        cacheRead: message.usage.cost.cacheRead,
        cacheWrite: message.usage.cost.cacheWrite,
        total: message.usage.cost.total,
      },
    },
  };
}

export function semanticPolicyJudgeStructuredOutputOptions(api: Api): ProviderStreamOptions | undefined {
  if (api === "openai-completions" || api === "mistral-conversations") {
    return { toolChoice: { type: "function", function: { name: SEMANTIC_POLICY_JUDGE_TOOL_NAME } } };
  }
  if (api === "anthropic-messages" || api === "bedrock-converse-stream") {
    return { toolChoice: { type: "tool", name: SEMANTIC_POLICY_JUDGE_TOOL_NAME } };
  }
  if (api === "google-generative-ai" || api === "google-vertex") {
    return { toolChoice: "any" };
  }
  return undefined;
}

function validateRequiredEvidence(values: unknown[]): string[] | undefined {
  const normalized: string[] = [];
  for (const value of values) {
    const label = compactString(value, 180);
    if (!label) return undefined;
    normalized.push(label);
  }
  return normalized;
}

function compactString(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().replace(/\s+/g, " ");
  if (!normalized || normalized.length > maxLength) return undefined;
  return normalized;
}

function isPolicyJudgeNextAction(value: unknown): value is PolicyJudgeNextAction {
  return typeof value === "string" && SEMANTIC_POLICY_JUDGE_ACTIONS.includes(value as PolicyJudgeNextAction);
}

function actionStrictness(action: PolicyJudgeNextAction): number {
  return POLICY_ACTION_STRICTNESS[action];
}

function extractJsonObjectText(text: string): string | undefined {
  const trimmed = stripMarkdownJsonFence(text);
  if (trimmed.startsWith("{") && trimmed.endsWith("}")) return trimmed;
  return firstBalancedJsonObject(trimmed);
}

function stripMarkdownJsonFence(text: string): string {
  const trimmed = text.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return (fenced?.[1] ?? trimmed).trim();
}

function firstBalancedJsonObject(text: string): string | undefined {
  let start = -1;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (start < 0) {
      if (char === "{") {
        start = index;
        depth = 1;
      }
      continue;
    }
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === "\"") {
        inString = false;
      }
      continue;
    }
    if (char === "\"") {
      inString = true;
    } else if (char === "{") {
      depth += 1;
    } else if (char === "}") {
      depth -= 1;
      if (depth === 0) return text.slice(start, index + 1);
    }
  }
  return undefined;
}

function semanticPolicyJudgeTimeoutMs(): number {
  return SEMANTIC_POLICY_JUDGE_TIMEOUT_MS;
}
