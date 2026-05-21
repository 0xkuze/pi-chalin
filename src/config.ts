import * as fs from "node:fs";
import * as path from "node:path";
import { resolveMeshPaths, type MeshPathsOptions } from "./paths.ts";
import { isAgentThinkingLevel, riskRank, type AgentScope, type AgentThinkingLevel, type ApprovalDecision, type RouteDecision, type RouteRisk } from "./schemas.ts";

export type AutonomyLevel = "low" | "balanced" | "high";
export type ApprovalRiskThreshold = RouteRisk;
export type ModelPersistenceTarget = "session" | "project" | "user";

export interface MeshConfig {
  enabled: boolean;
  autonomy: AutonomyLevel;
  safety: {
    approvalRiskThreshold: ApprovalRiskThreshold;
    recursionGuard: boolean;
    singleWriterGuard: boolean;
    mutationExpectationGuard: boolean;
    blockCritical: boolean;
  };
  agents: {
    modelOverrides: Record<string, string>;
    thinkingOverrides: Record<string, AgentThinkingLevel>;
    modelPersistenceDefaults: Record<AgentScope, ModelPersistenceTarget>;
  };
}

export interface LoadedMeshConfig {
  config: MeshConfig;
  diagnostics: string[];
  paths: ReturnType<typeof resolveMeshPaths>;
}

export const DEFAULT_CONFIG: MeshConfig = {
  enabled: true,
  autonomy: "balanced",
  safety: {
    approvalRiskThreshold: "medium",
    recursionGuard: true,
    singleWriterGuard: true,
    mutationExpectationGuard: true,
    blockCritical: true,
  },
  agents: {
    modelOverrides: {},
    thinkingOverrides: {},
    modelPersistenceDefaults: {
      "built-in": "user",
      user: "user",
      project: "project",
    },
  },
};

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function deepMerge<T>(base: T, override: unknown): T {
  if (!isObject(base) || !isObject(override)) return override === undefined ? base : (override as T);
  const result: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(override)) {
    const current = result[key];
    result[key] = isObject(current) && isObject(value) ? deepMerge(current, value) : value;
  }
  return result as T;
}

function readJsonObject(filePath: string, diagnostics: string[]): Record<string, unknown> {
  if (!fs.existsSync(filePath)) return {};
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf-8")) as unknown;
    if (!isObject(parsed)) {
      diagnostics.push(`Config '${filePath}' must contain a JSON object.`);
      return {};
    }
    return parsed;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    diagnostics.push(`Failed to read config '${filePath}': ${message}`);
    return {};
  }
}

function coerceConfig(input: MeshConfig, diagnostics: string[]): MeshConfig {
  const config = deepMerge(DEFAULT_CONFIG, input);

  if (!["low", "balanced", "high"].includes(config.autonomy)) {
    diagnostics.push(`Invalid autonomy '${String(config.autonomy)}'; using '${DEFAULT_CONFIG.autonomy}'.`);
    config.autonomy = DEFAULT_CONFIG.autonomy;
  }

  if (!["low", "medium", "high", "critical"].includes(config.safety.approvalRiskThreshold)) {
    diagnostics.push(
      `Invalid safety.approvalRiskThreshold '${String(config.safety.approvalRiskThreshold)}'; using '${DEFAULT_CONFIG.safety.approvalRiskThreshold}'.`,
    );
    config.safety.approvalRiskThreshold = DEFAULT_CONFIG.safety.approvalRiskThreshold;
  }

  if (riskRank(config.safety.approvalRiskThreshold) > riskRank(DEFAULT_CONFIG.safety.approvalRiskThreshold)) {
    diagnostics.push(
      `Safety non-downgrade enforced: approvalRiskThreshold '${config.safety.approvalRiskThreshold}' is weaker than '${DEFAULT_CONFIG.safety.approvalRiskThreshold}'.`,
    );
    config.safety.approvalRiskThreshold = DEFAULT_CONFIG.safety.approvalRiskThreshold;
  }

  for (const key of ["recursionGuard", "singleWriterGuard", "mutationExpectationGuard", "blockCritical"] as const) {
    if (DEFAULT_CONFIG.safety[key] && config.safety[key] !== true) {
      diagnostics.push(`Safety non-downgrade enforced: safety.${key} cannot be disabled.`);
      config.safety[key] = true;
    }
  }

  if (!isObject(config.agents.modelOverrides)) config.agents.modelOverrides = {};
  if (!isObject(config.agents.thinkingOverrides)) config.agents.thinkingOverrides = {};
  for (const [agentRef, level] of Object.entries(config.agents.thinkingOverrides)) {
    if (typeof level !== "string" || !isAgentThinkingLevel(level)) {
      diagnostics.push(`Invalid agents.thinkingOverrides['${agentRef}']='${String(level)}'; removing override.`);
      delete config.agents.thinkingOverrides[agentRef];
    }
  }
  return config;
}

export function loadEffectiveConfig(options: MeshPathsOptions): LoadedMeshConfig {
  const paths = resolveMeshPaths(options);
  const diagnostics: string[] = [];
  const projectConfig = readJsonObject(paths.projectConfigPath, diagnostics);
  const userConfig = readJsonObject(paths.userConfigPath, diagnostics);
  const merged = deepMerge(deepMerge(DEFAULT_CONFIG, projectConfig), userConfig);
  return { config: coerceConfig(merged, diagnostics), diagnostics, paths };
}

export function writeProjectConfig(options: MeshPathsOptions, configPatch: Partial<MeshConfig>): LoadedMeshConfig {
  const loaded = loadEffectiveConfig(options);
  const current = readJsonObject(loaded.paths.projectConfigPath, []);
  const next = deepMerge(current, configPatch);
  fs.mkdirSync(path.dirname(loaded.paths.projectConfigPath), { recursive: true });
  fs.writeFileSync(loaded.paths.projectConfigPath, `${JSON.stringify(next, null, 2)}\n`, "utf-8");
  return loadEffectiveConfig(options);
}

export function writeUserConfig(options: MeshPathsOptions, configPatch: Partial<MeshConfig>): LoadedMeshConfig {
  const loaded = loadEffectiveConfig(options);
  const current = readJsonObject(loaded.paths.userConfigPath, []);
  const next = deepMerge(current, configPatch);
  fs.mkdirSync(path.dirname(loaded.paths.userConfigPath), { recursive: true });
  fs.writeFileSync(loaded.paths.userConfigPath, `${JSON.stringify(next, null, 2)}\n`, "utf-8");
  return loadEffectiveConfig(options);
}

export function setAgentModelOverride(
  options: MeshPathsOptions,
  agentRef: string,
  model: string | undefined,
  target: Exclude<ModelPersistenceTarget, "session">,
): LoadedMeshConfig {
  const loaded = loadEffectiveConfig(options);
  const overrides = { ...loaded.config.agents.modelOverrides };
  if (model) overrides[agentRef] = model;
  else delete overrides[agentRef];
  const patch: Partial<MeshConfig> = { agents: { ...loaded.config.agents, modelOverrides: overrides } };
  return target === "project" ? writeProjectConfig(options, patch) : writeUserConfig(options, patch);
}

export function setAgentThinkingOverride(
  options: MeshPathsOptions,
  agentRef: string,
  thinking: AgentThinkingLevel | undefined,
  target: Exclude<ModelPersistenceTarget, "session">,
): LoadedMeshConfig {
  const loaded = loadEffectiveConfig(options);
  const overrides = { ...loaded.config.agents.thinkingOverrides };
  if (thinking && thinking !== "inherit") overrides[agentRef] = thinking;
  else delete overrides[agentRef];
  const patch: Partial<MeshConfig> = { agents: { ...loaded.config.agents, thinkingOverrides: overrides } };
  return target === "project" ? writeProjectConfig(options, patch) : writeUserConfig(options, patch);
}

export function approvalDecision(config: MeshConfig, route: RouteDecision): ApprovalDecision {
  if (route.kind === "bypass" || route.kind === "memory-only") return { action: "allow", reason: "No subagent execution required." };
  if (route.risk === "critical" && config.safety.blockCritical) {
    return { action: "block", reason: "Critical routes are blocked by default safety policy." };
  }
  const threshold = config.autonomy === "low" ? "low" : config.safety.approvalRiskThreshold;
  if (riskRank(route.risk) >= riskRank(threshold)) {
    return { action: "ask", reason: `Route risk '${route.risk}' meets approval threshold '${threshold}'.` };
  }
  return { action: "allow", reason: `Route risk '${route.risk}' is below approval threshold '${threshold}'.` };
}
