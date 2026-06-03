import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { isAgentThinkingLevel, type AgentDefinition, type AgentThinkingLevel, type ModelResolutionAttempt, type ModelResolutionLog } from "../domain/schemas.ts";

interface ModelResolutionContext {
  cwd?: string;
  agents?: Map<string, AgentDefinition>;
  modelOverrides?: Record<string, string>;
  thinkingOverrides?: Record<string, AgentThinkingLevel>;
  extensionContext?: ExtensionContext;
}

export interface ResolvedAgentModel {
  model: ExtensionContext["model"];
  label: string;
  resolution: ModelResolutionLog;
  warnings: string[];
}

export function resolveAgentModel(agent: AgentDefinition | undefined, agentName: string, context: ModelResolutionContext): ResolvedAgentModel {
  const fallback = context.extensionContext?.model;
  const tier = agentTier(agentName);
  const forcedModel = process.env.PI_CHALIN_EVAL_AGENT_MODEL;
  const candidates: Array<{ source: ModelResolutionAttempt["source"]; ref?: string }> = [
    { source: "session-override", ref: forcedModel },
    { source: "session-override", ref: context.modelOverrides?.[`${agent?.scope ?? "built-in"}/${agentName}`] ?? context.modelOverrides?.[agentName] },
    { source: "agent", ref: agent?.model && agent.model !== "inherit" ? agent.model : undefined },
    { source: "tier", ref: context.modelOverrides?.[`tier/${tier}`] ?? process.env[`PI_CHALIN_${tier.toUpperCase()}_MODEL`] },
  ];
  const attempts: ModelResolutionAttempt[] = [];

  for (const candidate of candidates) {
    if (!candidate.ref) continue;
    const resolved = resolveModelRef(candidate.ref, context);
    attempts.push({ source: candidate.source, ref: candidate.ref, status: resolved.status, model: resolved.model ? `${resolved.model.provider}/${resolved.model.id}` : undefined, reason: resolved.reason });
    if (resolved.status === "selected" && resolved.model) {
      const selected = `${resolved.model.provider}/${resolved.model.id}`;
      return {
        model: resolved.model,
        label: selected,
        resolution: { selected, tier, attempts },
        warnings: fallbackWarnings(agentName, attempts, selected),
      };
    }
  }

  const inherited = fallback ? `${fallback.provider}/${fallback.id}` : "inherit";
  attempts.push({ source: "inherit", status: fallback ? "selected" : "fallback", model: inherited, reason: fallback ? undefined : "no active Pi model available" });
  return {
    model: fallback,
    label: fallback ? `${inherited} (${tier}:inherit)` : `inherit (${tier})`,
    resolution: { selected: inherited, tier, attempts },
    warnings: fallbackWarnings(agentName, attempts, inherited),
  };
}

export function resolveInheritedModelFallback(
  previous: ResolvedAgentModel,
  agentName: string,
  context: ModelResolutionContext,
  reason: string,
): ResolvedAgentModel | undefined {
  const fallback = context.extensionContext?.model;
  if (!fallback) return undefined;
  const inherited = `${fallback.provider}/${fallback.id}`;
  if (previous.resolution.selected === inherited) return undefined;

  let selectedMarked = false;
  const attempts = previous.resolution.attempts.map((attempt) => {
    if (selectedMarked || attempt.status !== "selected" || attempt.model !== previous.resolution.selected) return attempt;
    selectedMarked = true;
    return { ...attempt, status: "runtime-error" as const, reason: compactRuntimeReason(reason) };
  });
  if (!selectedMarked) {
    attempts.push({
      source: "agent",
      status: "runtime-error",
      model: previous.resolution.selected,
      reason: compactRuntimeReason(reason),
    });
  }
  attempts.push({
    source: "inherit",
    status: "selected",
    model: inherited,
    reason: `runtime fallback after ${previous.resolution.selected} failed`,
  });

  return {
    model: fallback,
    label: `${inherited} (${previous.resolution.tier}:inherit-runtime-fallback)`,
    resolution: { selected: inherited, tier: previous.resolution.tier, attempts },
    warnings: [`Model runtime fallback for ${agentName}: ${previous.resolution.selected} failed (${compactRuntimeReason(reason)}); selected ${inherited}.`],
  };
}

export function resolveAgentThinking(
  agent: AgentDefinition | undefined,
  agentName: string,
  context: ModelResolutionContext,
  modelResolution?: ModelResolutionLog,
): { level?: Exclude<AgentThinkingLevel, "inherit">; label: AgentThinkingLevel } {
  const forcedEvalThinking = evalAgentThinkingOverride();
  const explicit = context.thinkingOverrides?.[`${agent?.scope ?? "built-in"}/${agentName}`] ?? context.thinkingOverrides?.[agentName];
  const frontmatter = agent?.thinking && agent.thinking !== "inherit" ? agent.thinking : undefined;
  const modelSuffix = selectedThinkingSuffix(modelResolution);
  const level = forcedEvalThinking ?? (explicit && explicit !== "inherit" ? explicit : frontmatter ?? modelSuffix);
  return level ? { level, label: level } : { label: "inherit" };
}

function evalAgentThinkingOverride(): Exclude<AgentThinkingLevel, "inherit"> | undefined {
  const value = process.env.PI_CHALIN_EVAL_AGENT_THINKING?.trim();
  if (!value || value === "inherit" || !isAgentThinkingLevel(value)) return undefined;
  return value as Exclude<AgentThinkingLevel, "inherit">;
}

function selectedThinkingSuffix(modelResolution?: ModelResolutionLog): Exclude<AgentThinkingLevel, "inherit"> | undefined {
  const selected = modelResolution?.attempts.find((attempt) => attempt.status === "selected" && attempt.ref)?.ref;
  if (!selected) return undefined;
  return splitThinkingSuffix(selected).thinking;
}

function resolveModelRef(ref: string, context: ModelResolutionContext): { status: ModelResolutionAttempt["status"]; model?: ExtensionContext["model"]; reason?: string } {
  const parsed = parseModelRef(splitThinkingSuffix(ref).model);
  if (!parsed) return { status: "invalid", reason: "expected provider/model-id" };
  const registry = context.extensionContext?.modelRegistry;
  const model = registry?.find(parsed.provider, parsed.modelId);
  if (!model) return { status: "unavailable", reason: "not found in Pi model registry" };
  if (!registry?.hasConfiguredAuth(model)) return { status: "unauthenticated", model, reason: "provider is not configured" };
  return { status: "selected", model };
}

function splitThinkingSuffix(ref: string): { model: string; thinking?: Exclude<AgentThinkingLevel, "inherit"> } {
  const trimmed = ref.trim();
  const colon = trimmed.lastIndexOf(":");
  if (colon === -1) return { model: trimmed };
  const suffix = trimmed.slice(colon + 1);
  if (suffix === "off" || suffix === "minimal" || suffix === "low" || suffix === "medium" || suffix === "high" || suffix === "xhigh") {
    return { model: trimmed.slice(0, colon), thinking: suffix };
  }
  return { model: trimmed };
}

function parseModelRef(ref: string): { provider: string; modelId: string } | undefined {
  const trimmed = ref.trim();
  if (!trimmed || trimmed === "inherit") return undefined;
  const slash = trimmed.indexOf("/");
  if (slash <= 0 || slash === trimmed.length - 1) return undefined;
  return { provider: trimmed.slice(0, slash), modelId: trimmed.slice(slash + 1) };
}

function agentTier(agentName: string): "fast" | "balanced" | "strong" {
  if (["scout", "context-builder"].includes(agentName)) return "fast";
  if (["worker"].includes(agentName)) return "strong";
  return "balanced";
}

function fallbackWarnings(agentName: string, attempts: ModelResolutionAttempt[], selected: string): string[] {
  const failed = attempts.filter((attempt) => ["invalid", "unavailable", "unauthenticated", "fallback", "runtime-error"].includes(attempt.status) && attempt.source !== "inherit");
  if (failed.length === 0) return [];
  const refs = failed.map((attempt) => `${attempt.ref ?? attempt.source} ${attempt.status}`).join("; ");
  return [`Model fallback for ${agentName}: ${refs}; selected ${selected}.`];
}

function compactRuntimeReason(reason: string): string {
  return reason.replace(/\s+/g, " ").trim().slice(0, 180) || "provider/model runtime error";
}
