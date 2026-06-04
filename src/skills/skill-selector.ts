import { Type, type Api, type AssistantMessage, type Model } from "@earendil-works/pi-ai";
import { createAgentSession, DefaultResourceLoader, defineTool, getAgentDir, SessionManager, type ModelRegistry } from "@earendil-works/pi-coding-agent";
import type { ChalinConfig } from "../config/config.ts";
import type { AgentDefinition, RouteKind, RouteRisk, SkillDefinition, SkillSelectionDecision } from "../domain/schemas.ts";
import { errorMessage } from "../utils/guards.ts";
import { compactString, parseJsonObject } from "../utils/json.ts";
import type { SkillCatalog } from "./skills.ts";

export interface SkillSelectorContext {
  cwd?: string;
  model?: Model<Api>;
  modelRegistry?: ModelRegistry;
  signal?: AbortSignal;
}

export interface SkillSelectorInput {
  catalog: SkillCatalog;
  config: ChalinConfig;
  agent?: AgentDefinition;
  task: string;
  routeKind?: RouteKind;
  risk?: RouteRisk;
  context: SkillSelectorContext;
}

export interface SkillSelectorRunResult {
  selectedSkills: SkillSelectionDecision[];
  diagnostics: string[];
}

const SKILL_SELECTOR_TOOL_NAME = "chalin_skill_selection";
const SKILL_SELECTOR_RESULT_KEYS = new Set(["selectedSkills"]);
const SKILL_SELECTOR_ITEM_KEYS = new Set(["reference", "reason", "confidence"]);

export const CHALIN_SKILL_SELECTOR_RESULT_SCHEMA = Type.Object({
  selectedSkills: Type.Array(Type.Object({
    reference: Type.String({ minLength: 1, maxLength: 160, description: "Skill reference from availableSkills, preferably the qualifiedName." }),
    reason: Type.String({ minLength: 8, maxLength: 600, description: "Semantic reason this skill materially improves this exact step." }),
    confidence: Type.Optional(Type.Number({ minimum: 0, maximum: 1, description: "Confidence from 0 to 1." })),
  }, { additionalProperties: false }), {
    description: "All and only skills materially useful for this exact step. Empty when no skill is worth activating.",
  }),
}, { additionalProperties: false });

export async function runStructuredSkillSelector(input: SkillSelectorInput): Promise<SkillSelectorRunResult> {
  const model = input.context.model;
  const registry = input.context.modelRegistry;
  if (!model || !registry) return { selectedSkills: [], diagnostics: ["Semantic skill selector requires an active Pi model and model registry."] };
  const availableSkills = input.catalog.list();
  if (availableSkills.length === 0) return { selectedSkills: [], diagnostics: ["Semantic skill selector found no available skills."] };

  return runAgentSessionSkillSelector(input, availableSkills);
}

export function parseSkillSelectorMessage(message: AssistantMessage, catalog?: SkillCatalog): SkillSelectionDecision[] | undefined {
  const toolResult = parseSkillSelectorToolResult(message, catalog);
  if (toolResult) return toolResult;
  const text = message.content
    .filter((block): block is { type: "text"; text: string } => block.type === "text")
    .map((block) => block.text)
    .join("\n")
    .trim();
  const parsed = parseJsonObject(text);
  return parsed ? validateSkillSelectorOutput(parsed, catalog) : undefined;
}

export function validateSkillSelectorOutput(parsed: Record<string, unknown>, catalog?: SkillCatalog): SkillSelectionDecision[] | undefined {
  if (Object.keys(parsed).some((key) => !SKILL_SELECTOR_RESULT_KEYS.has(key))) return undefined;
  if (!Array.isArray(parsed.selectedSkills)) return undefined;
  const selected: SkillSelectionDecision[] = [];
  const seen = new Set<string>();
  for (const value of parsed.selectedSkills) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
    const item = value as Record<string, unknown>;
    if (Object.keys(item).some((key) => !SKILL_SELECTOR_ITEM_KEYS.has(key))) return undefined;
    const reference = compactString(item.reference, 160);
    const reason = compactString(item.reason, 600);
    if (!reference || !reason) return undefined;
    if (catalog && !catalog.resolve(reference).skill) return undefined;
    if (item.confidence !== undefined && (typeof item.confidence !== "number" || !Number.isFinite(item.confidence) || item.confidence < 0 || item.confidence > 1)) return undefined;
    const key = catalog?.resolve(reference).skill?.qualifiedName ?? reference;
    if (seen.has(key)) continue;
    seen.add(key);
    selected.push({
      reference,
      reason,
      ...(typeof item.confidence === "number" ? { confidence: item.confidence } : {}),
    });
  }
  return selected;
}

function parseSkillSelectorToolResult(message: AssistantMessage, catalog?: SkillCatalog): SkillSelectionDecision[] | undefined {
  for (const block of message.content) {
    if (block.type !== "toolCall" || block.name !== SKILL_SELECTOR_TOOL_NAME) continue;
    const result = validateSkillSelectorOutput(block.arguments, catalog);
    if (result) return result;
  }
  return undefined;
}

function skillSelectorPayload(input: SkillSelectorInput, skills: SkillDefinition[]): Record<string, unknown> {
  return {
    task: input.task,
    routeKind: input.routeKind ?? "unknown",
    risk: input.risk ?? "unknown",
    agent: input.agent ? {
      name: input.agent.name,
      concern: input.agent.concern,
      capabilities: input.agent.capabilities,
      tools: input.agent.tools,
      description: input.agent.description,
    } : undefined,
    skillPolicy: {
      autoActivationEnabled: input.config.skills.autoActivation,
      projectSkillsAllowed: input.config.skills.allowProjectSkills,
      userSkillsAllowed: input.config.skills.allowUserSkills,
      onDemandSkillsAllowed: input.config.skills.allowOnDemandSkills,
    },
    availableSkills: skills.map(skillSelectorSkillItem),
  };
}

function skillSelectorSkillItem(skill: SkillDefinition): Record<string, unknown> {
  return {
    reference: skill.qualifiedName,
    name: skill.name,
    scope: skill.scope,
    description: skill.description,
    activation: skill.activation,
    trust: skill.trust,
    lifecycle: skill.lifecycle,
    extends: skill.extends,
    concerns: skill.concerns,
    capabilities: skill.capabilities,
    risk: skill.risk,
    toolPolicy: {
      allow: skill.allowedTools,
      deny: skill.deniedTools,
    },
  };
}

function skillSelectorSystemPrompt(): string {
  return [
    "You are pi-chalin's semantic skill selector for one coding-agent subagent step.",
    "Select skills only when their description, concern, capability, trust, and tool policy materially improve this exact step.",
    "Do not select by keyword, trigger phrase, skill name similarity, or task-type table.",
    "Prefer no skill when the base agent can do the work cleanly without extra procedure.",
    "Select every materially useful skill; do not apply arbitrary composition caps.",
    "Manual or suggested activation metadata is policy context only; the harness will decide whether selection becomes active or suggested.",
    `When the ${SKILL_SELECTOR_TOOL_NAME} tool is available, call it exactly once with the final selection. Otherwise return JSON only.`,
  ].join("\n");
}

export const SKILL_SELECTOR_TEST_ONLY = {
  skillSelectorSystemPrompt,
  skillSelectorPayload,
};

async function runAgentSessionSkillSelector(input: SkillSelectorInput, availableSkills: SkillDefinition[]): Promise<SkillSelectorRunResult> {
  const model = input.context.model;
  const registry = input.context.modelRegistry;
  if (!model || !registry) return { selectedSkills: [], diagnostics: ["Semantic skill selector requires an active Pi model and model registry."] };
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
      systemPrompt: skillSelectorSystemPrompt(),
    });
    await resourceLoader.reload();
    created = await createAgentSession({
      cwd,
      model,
      modelRegistry: registry,
      sessionManager: SessionManager.inMemory(cwd),
      resourceLoader,
      noTools: "all",
      tools: [SKILL_SELECTOR_TOOL_NAME],
      customTools: [createSkillSelectorTool(input.catalog)],
      sessionStartEvent: { type: "session_start", reason: "new" },
    });
    const abortSelector = () => { void created?.session.abort(); };
    input.context.signal?.addEventListener("abort", abortSelector, { once: true });
    try {
      await created.session.prompt(skillSelectorSessionPrompt(input, availableSkills), {
        expandPromptTemplates: false,
        source: "extension",
      });
    } finally {
      input.context.signal?.removeEventListener("abort", abortSelector);
    }
    const messages = Array.isArray(created.session.state.messages) ? created.session.state.messages as unknown[] : [];
    const selectedSkills = parseSkillSelectorSessionMessages(messages, input.catalog);
    return selectedSkills
      ? { selectedSkills, diagnostics: [`Semantic skill selector chose ${selectedSkills.length} skill(s).`] }
      : { selectedSkills: [], diagnostics: ["Semantic skill selector response failed structured validation."] };
  } catch (error) {
    return { selectedSkills: [], diagnostics: [`Semantic skill selector failed: ${errorMessage(error)}`] };
  } finally {
    created?.session.dispose();
  }
}

function createSkillSelectorTool(catalog: SkillCatalog) {
  return defineTool({
    name: SKILL_SELECTOR_TOOL_NAME,
    label: "Chalin Skill Selection",
    description: "Emit pi-chalin's semantic skill selection for the current subagent step.",
    promptSnippet: "Emit pi-chalin's semantic skill selection.",
    promptGuidelines: [
      `Call ${SKILL_SELECTOR_TOOL_NAME} exactly once as the final action.`,
      "Do not answer in prose when this tool is available.",
    ],
    parameters: CHALIN_SKILL_SELECTOR_RESULT_SCHEMA,
    async execute(_toolCallId, params) {
      const selectedSkills = validateSkillSelectorOutput(params as Record<string, unknown>, catalog);
      return {
        content: [{ type: "text", text: selectedSkills ? `Accepted skill selection: ${selectedSkills.length} skill(s)` : "Rejected skill selection: failed catalog or schema validation." }],
        details: selectedSkills ? { selectedSkills } : { rejected: true, params },
        terminate: true,
      };
    },
  });
}

function skillSelectorSessionPrompt(input: SkillSelectorInput, availableSkills: SkillDefinition[]): string {
  return [
    "Payload JSON:",
    JSON.stringify(skillSelectorPayload(input, availableSkills), null, 2),
  ].join("\n");
}

function parseSkillSelectorSessionMessages(messages: unknown[], catalog: SkillCatalog): SkillSelectionDecision[] | undefined {
  for (const message of [...messages].reverse()) {
    if (!message || typeof message !== "object" || Array.isArray(message)) continue;
    const record = message as Record<string, unknown>;
    if (record.details && typeof record.details === "object" && !Array.isArray(record.details)) {
      const details = record.details as Record<string, unknown>;
      if (Array.isArray(details.selectedSkills)) {
        const parsed = validateSkillSelectorOutput({ selectedSkills: details.selectedSkills }, catalog);
        if (parsed) return parsed;
      }
    }
    if (record.role !== "assistant" || !Array.isArray(record.content)) continue;
    for (const block of record.content) {
      if (!block || typeof block !== "object" || Array.isArray(block)) continue;
      const item = block as Record<string, unknown>;
      if (item.type !== "toolCall" || item.name !== SKILL_SELECTOR_TOOL_NAME || !item.arguments || typeof item.arguments !== "object" || Array.isArray(item.arguments)) continue;
      const parsed = validateSkillSelectorOutput(item.arguments as Record<string, unknown>, catalog);
      if (parsed) return parsed;
    }
  }
  return undefined;
}
