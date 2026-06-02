import { complete, completeSimple, StringEnum, Type, type Api, type AssistantMessage, type Context, type Model, type ProviderStreamOptions, type Tool } from "@earendil-works/pi-ai";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import type { SemanticPolicyJudgeTrace } from "../runtime/direct-policy.ts";

export type DirectDecisionJudgeDecision = "direct" | "route" | "interview";

export interface DirectDecisionJudgeContext {
  model?: Model<Api>;
  modelRegistry?: ModelRegistry;
  signal?: AbortSignal;
}

export interface DirectDecisionJudgeScope {
  oneOwnershipSurface: boolean;
  clearAcceptanceSurface: boolean;
  parentVerifiableWithoutDelegation: boolean;
  needsRepositoryStateOrHistorySynthesis: boolean;
  needsMultipleLocalEvidenceSurfaces: boolean;
  needsBroadWorkspaceEvidence: boolean;
  needsDelegatedReviewOrSplitCoverage: boolean;
}

export interface DirectDecisionJudgeInput {
  task: string;
  reason: string;
  scope: DirectDecisionJudgeScope;
  context: DirectDecisionJudgeContext;
}

export interface DirectDecisionJudgeResult {
  decision: DirectDecisionJudgeDecision;
  reason: string;
  confidence: number;
  blockers: string[];
  trace?: SemanticPolicyJudgeTrace;
}

export async function runDirectDecisionJudge(input: DirectDecisionJudgeInput): Promise<DirectDecisionJudgeResult | undefined> {
  const model = input.context.model;
  const registry = input.context.modelRegistry;
  if (!model || !registry) return undefined;
  const auth = await registry.getApiKeyAndHeaders(model);
  if (!auth.ok) return undefined;
  const structuredOutputOptions = directDecisionJudgeStructuredOutputOptions(model.api);
  const baseOptions = {
    apiKey: auth.apiKey,
    headers: auth.headers,
    temperature: 0,
    maxTokens: 360,
    timeoutMs: directDecisionJudgeTimeoutMs(),
    maxRetries: 0,
    signal: input.context.signal,
  };
  try {
    const context: Context = {
      systemPrompt: directDecisionJudgeSystemPrompt(),
      messages: [{
        role: "user",
        timestamp: Date.now(),
        content: JSON.stringify(directDecisionJudgePayload(input), null, 2),
      }],
    };
    if (structuredOutputOptions) context.tools = [DIRECT_DECISION_JUDGE_TOOL];
    const response = structuredOutputOptions
      ? await complete(model, context, { ...baseOptions, ...structuredOutputOptions, reasoning: "high" })
      : await completeSimple(model, context, { ...baseOptions, reasoning: "high" });
    return parseDirectDecisionJudgeResult(response);
  } catch {
    return undefined;
  }
}

export function shouldRejectDirectFromJudge(result: DirectDecisionJudgeResult | undefined): result is DirectDecisionJudgeResult {
  if (!result) return false;
  if (result.decision === "direct") return false;
  if (result.confidence < 0.72) return false;
  return result.blockers.length > 0;
}

function directDecisionJudgePayload(input: DirectDecisionJudgeInput): Record<string, unknown> {
  return {
    proposedDirectDecision: {
      task: input.task,
      reason: input.reason,
      scopeClaims: input.scope,
    },
    directContract: {
      direct: [
        "one bounded local ownership surface",
        "clear acceptance surface",
        "parent agent can verify cheaply without delegated review",
        "no broad workspace discovery or multi-surface synthesis required before acting",
        "read-only status alone does not make a task direct",
      ],
      route: [
        "delegated discovery, planning, implementation, review, or context relief materially improves correctness",
        "the work needs reconstruction of project, change, temporal, or repository state",
        "the work needs combining independent evidence surfaces or broad workspace coverage",
        "the work needs constraint-compliance judgment across discovered evidence",
        "the work naturally decomposes into smaller responsibilities, units, or review gates",
      ],
      interview: [
        "a non-discoverable human decision blocks a responsible direct or routed plan",
      ],
    },
  };
}

function directDecisionJudgeSystemPrompt(): string {
  return [
    "You are pi-chalin's semantic DIRECT/ROUTE gate.",
    "Audit the proposed DIRECT decision as structural claims, not as truth.",
    "Do not classify from hardcoded wording, examples, domain names, or literal phrases; reason from scope shape, evidence burden, verification burden, and delegation value.",
    "Choose direct only when the primary agent can complete the work from one bounded local ownership surface with a clear parent-verifiable acceptance surface.",
    "Read-only work is not automatically direct; if correctness depends on broad evidence, constraint compliance, or independent judgment, choose route.",
    "Choose route when subagents, staged ownership, independent review, broad discovery, multi-surface synthesis, project/change/history reconstruction, or context relief materially improves reliability.",
    "Choose interview only when a human decision is genuinely required before either direct work or routed work can proceed.",
    "If the task/reason conflicts with the boolean scope claims, trust the semantic task/reason analysis and report the conflict as a blocker.",
    "When a direct_decision_judge_result tool is available, call it exactly once with the final decision.",
    "Otherwise return JSON only with fields: decision, reason, confidence, blockers.",
  ].join("\n");
}

const DIRECT_DECISION_JUDGE_TIMEOUT_MS = 20_000;
const DIRECT_DECISION_JUDGE_DECISIONS = ["direct", "route", "interview"] as const satisfies readonly DirectDecisionJudgeDecision[];
const DIRECT_DECISION_JUDGE_RESULT_KEYS = new Set(["decision", "reason", "confidence", "blockers"]);
export const DIRECT_DECISION_JUDGE_TOOL_NAME = "direct_decision_judge_result";
export const DIRECT_DECISION_JUDGE_RESULT_SCHEMA = Type.Object({
  decision: StringEnum(DIRECT_DECISION_JUDGE_DECISIONS, { description: "Strictest orchestration decision justified by the direct scope contract." }),
  reason: Type.String({ minLength: 1, maxLength: 1_200, description: "Compact technical reason for the decision." }),
  confidence: Type.Number({ minimum: 0, maximum: 1, description: "Judge confidence from 0 to 1." }),
  blockers: Type.Array(Type.String({ minLength: 1, maxLength: 180 }), {
    maxItems: 8,
    description: "Compact structural blockers that prevent direct execution.",
  }),
}, { additionalProperties: false });
const DIRECT_DECISION_JUDGE_TOOL = {
  name: DIRECT_DECISION_JUDGE_TOOL_NAME,
  description: "Emit the final direct decision judge result.",
  parameters: DIRECT_DECISION_JUDGE_RESULT_SCHEMA,
} as const satisfies Tool;

export function parseDirectDecisionJudgeResult(message: AssistantMessage): DirectDecisionJudgeResult | undefined {
  const toolResult = parseDirectDecisionJudgeToolResult(message);
  if (toolResult) return withDirectDecisionJudgeTrace(toolResult, message, "tool-schema");
  const text = message.content
    .filter((block): block is { type: "text"; text: string } => block.type === "text")
    .map((block) => block.text)
    .join("\n")
    .trim();
  const parsed = parseJsonObject(text);
  const result = parsed ? validateDirectDecisionJudgeResult(parsed) : undefined;
  return result ? withDirectDecisionJudgeTrace(result, message, "json-fallback") : undefined;
}

export function validateDirectDecisionJudgeResult(parsed: Record<string, unknown>): DirectDecisionJudgeResult | undefined {
  if (Object.keys(parsed).some((key) => !DIRECT_DECISION_JUDGE_RESULT_KEYS.has(key))) return undefined;
  if (!isDirectDecisionJudgeDecision(parsed.decision)) return undefined;
  const reason = compactString(parsed.reason, 1_200);
  if (!reason) return undefined;
  if (typeof parsed.confidence !== "number" || !Number.isFinite(parsed.confidence) || parsed.confidence < 0 || parsed.confidence > 1) return undefined;
  if (!Array.isArray(parsed.blockers) || parsed.blockers.length > 8) return undefined;
  const blockers = validateBlockers(parsed.blockers);
  if (!blockers) return undefined;
  return {
    decision: parsed.decision,
    reason,
    confidence: parsed.confidence,
    blockers,
  };
}

export function directDecisionJudgeStructuredOutputOptions(api: Api): ProviderStreamOptions | undefined {
  if (api === "openai-completions" || api === "mistral-conversations") {
    return { toolChoice: { type: "function", function: { name: DIRECT_DECISION_JUDGE_TOOL_NAME } } };
  }
  if (api === "anthropic-messages" || api === "bedrock-converse-stream") {
    return { toolChoice: { type: "tool", name: DIRECT_DECISION_JUDGE_TOOL_NAME } };
  }
  if (api === "google-generative-ai" || api === "google-vertex") {
    return { toolChoice: "any" };
  }
  return undefined;
}

function parseDirectDecisionJudgeToolResult(message: AssistantMessage): DirectDecisionJudgeResult | undefined {
  for (const block of message.content) {
    if (block.type !== "toolCall" || block.name !== DIRECT_DECISION_JUDGE_TOOL_NAME) continue;
    const result = validateDirectDecisionJudgeResult(block.arguments);
    if (result) return result;
  }
  return undefined;
}

function withDirectDecisionJudgeTrace(result: DirectDecisionJudgeResult, message: AssistantMessage, mode: SemanticPolicyJudgeTrace["mode"]): DirectDecisionJudgeResult {
  return {
    ...result,
    trace: {
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
    },
  };
}

function parseJsonObject(text: string): Record<string, unknown> | undefined {
  const trimmed = stripMarkdownJsonFence(text.trim());
  if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) return undefined;
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : undefined;
  } catch {
    return undefined;
  }
}

function stripMarkdownJsonFence(text: string): string {
  if (!text.startsWith("```")) return text;
  const firstLineEnd = text.indexOf("\n");
  if (firstLineEnd < 0) return text;
  const body = text.slice(firstLineEnd + 1);
  return body.endsWith("```") ? body.slice(0, -3).trim() : text;
}

function validateBlockers(values: unknown[]): string[] | undefined {
  const normalized: string[] = [];
  for (const value of values) {
    const blocker = compactString(value, 180);
    if (!blocker) return undefined;
    normalized.push(blocker);
  }
  return normalized;
}

function compactString(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = collapseWhitespace(value.trim());
  if (!normalized || normalized.length > maxLength) return undefined;
  return normalized;
}

function collapseWhitespace(value: string): string {
  let output = "";
  let pendingSpace = false;
  for (const char of value) {
    if (char === " " || char === "\n" || char === "\r" || char === "\t" || char === "\v" || char === "\f") {
      pendingSpace = output.length > 0;
      continue;
    }
    if (pendingSpace) output += " ";
    output += char;
    pendingSpace = false;
  }
  return output;
}

function isDirectDecisionJudgeDecision(value: unknown): value is DirectDecisionJudgeDecision {
  return typeof value === "string" && DIRECT_DECISION_JUDGE_DECISIONS.includes(value as DirectDecisionJudgeDecision);
}

function directDecisionJudgeTimeoutMs(): number {
  const configured = Number(process.env.PI_CHALIN_DIRECT_DECISION_JUDGE_TIMEOUT_MS);
  return Number.isFinite(configured) && configured > 0 ? Math.floor(configured) : DIRECT_DECISION_JUDGE_TIMEOUT_MS;
}
