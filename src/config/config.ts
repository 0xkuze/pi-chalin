import * as fs from "node:fs";
import * as path from "node:path";
import { Context, Effect, Layer } from "effect";
import { resolveChalinPaths, type ChalinPathsOptions } from "./paths.ts";
import { isAgentThinkingLevel, riskRank, type AgentScope, type AgentThinkingLevel, type ApprovalDecision, type RouteDecision, type RouteRisk } from "../domain/schemas.ts";

export type AutonomyLevel = "low" | "balanced" | "high";
export type ApprovalRiskThreshold = RouteRisk | "none";
export type ModelPersistenceTarget = "session" | "project" | "user";
export type MemoryProvider = "auto" | "engram" | "pi-chalin";

const DEFAULT_APPROVAL_RISK_THRESHOLD: ApprovalRiskThreshold = "none";

export interface ChalinConfig {
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
  memory: {
    provider: MemoryProvider;
    engram: {
      baseUrl: string;
      command: string;
      autoStart: boolean;
      autoSync: boolean;
      syncThrottleMs: number;
      timeoutMs: number;
      project?: string;
    };
  };
  skills: {
    enabled: boolean;
    autoActivation: boolean;
    maxActiveDirect: number;
    maxActivePerStep: number;
    allowProjectSkills: boolean;
    allowUserSkills: boolean;
    allowOnDemandSkills: boolean;
    allowSkillScripts: boolean;
    staleAfterDays: number;
    requireAuditForProjectSkills: boolean;
    requireAuditForUserSkills: boolean;
    telemetry: boolean;
  };
}

export interface LoadedChalinConfig {
  config: ChalinConfig;
  diagnostics: string[];
  paths: ReturnType<typeof resolveChalinPaths>;
}

interface ConfigServiceShape {
  readonly loaded: LoadedChalinConfig;
}

class ConfigService extends Context.Tag("pi-chalin/Config")<ConfigService, ConfigServiceShape>() {}

export const DEFAULT_CONFIG: ChalinConfig = {
  enabled: true,
  autonomy: "balanced",
  safety: {
    approvalRiskThreshold: DEFAULT_APPROVAL_RISK_THRESHOLD,
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
  memory: {
    provider: "auto",
    engram: {
      baseUrl: "http://127.0.0.1:7437",
      command: "engram",
      autoStart: false,
      autoSync: true,
      syncThrottleMs: 30_000,
      timeoutMs: 800,
    },
  },
  skills: {
    enabled: true,
    autoActivation: true,
    maxActiveDirect: 1,
    maxActivePerStep: 2,
    allowProjectSkills: true,
    allowUserSkills: true,
    allowOnDemandSkills: true,
    allowSkillScripts: false,
    staleAfterDays: 30,
    requireAuditForProjectSkills: true,
    requireAuditForUserSkills: true,
    telemetry: true,
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

function coerceConfig(input: ChalinConfig, diagnostics: string[]): ChalinConfig {
  const config = deepMerge(DEFAULT_CONFIG, input);

  if (!["low", "balanced", "high"].includes(config.autonomy)) {
    diagnostics.push(`Invalid autonomy '${String(config.autonomy)}'; using '${DEFAULT_CONFIG.autonomy}'.`);
    config.autonomy = DEFAULT_CONFIG.autonomy;
  }

  if (!["low", "medium", "high", "critical", "none"].includes(config.safety.approvalRiskThreshold)) {
    diagnostics.push(
      `Invalid safety.approvalRiskThreshold '${String(config.safety.approvalRiskThreshold)}'; using '${DEFAULT_CONFIG.safety.approvalRiskThreshold}'.`,
    );
    config.safety.approvalRiskThreshold = DEFAULT_CONFIG.safety.approvalRiskThreshold;
  }

  if (DEFAULT_APPROVAL_RISK_THRESHOLD !== "none"
    && config.safety.approvalRiskThreshold !== "none"
    && riskRank(config.safety.approvalRiskThreshold) > riskRank(DEFAULT_APPROVAL_RISK_THRESHOLD)) {
    diagnostics.push(
      `Safety non-downgrade enforced: approvalRiskThreshold '${config.safety.approvalRiskThreshold}' is weaker than '${DEFAULT_APPROVAL_RISK_THRESHOLD}'.`,
    );
    config.safety.approvalRiskThreshold = DEFAULT_APPROVAL_RISK_THRESHOLD;
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
  if (!isObject(config.memory)) config.memory = structuredClone(DEFAULT_CONFIG.memory);
  if (!["auto", "engram", "pi-chalin"].includes(config.memory.provider)) {
    diagnostics.push(`Invalid memory.provider '${String(config.memory.provider)}'; using '${DEFAULT_CONFIG.memory.provider}'.`);
    config.memory.provider = DEFAULT_CONFIG.memory.provider;
  }
  if (!isObject(config.memory.engram)) config.memory.engram = structuredClone(DEFAULT_CONFIG.memory.engram);
  if (typeof config.memory.engram.baseUrl !== "string" || !config.memory.engram.baseUrl.trim()) {
    diagnostics.push(`Invalid memory.engram.baseUrl '${String(config.memory.engram.baseUrl)}'; using '${DEFAULT_CONFIG.memory.engram.baseUrl}'.`);
    config.memory.engram.baseUrl = DEFAULT_CONFIG.memory.engram.baseUrl;
  }
  if (typeof config.memory.engram.command !== "string" || !config.memory.engram.command.trim()) {
    diagnostics.push(`Invalid memory.engram.command '${String(config.memory.engram.command)}'; using '${DEFAULT_CONFIG.memory.engram.command}'.`);
    config.memory.engram.command = DEFAULT_CONFIG.memory.engram.command;
  }
  if (typeof config.memory.engram.autoStart !== "boolean") {
    diagnostics.push(`Invalid memory.engram.autoStart '${String(config.memory.engram.autoStart)}'; using '${DEFAULT_CONFIG.memory.engram.autoStart}'.`);
    config.memory.engram.autoStart = DEFAULT_CONFIG.memory.engram.autoStart;
  }
  if (typeof config.memory.engram.autoSync !== "boolean") {
    diagnostics.push(`Invalid memory.engram.autoSync '${String(config.memory.engram.autoSync)}'; using '${DEFAULT_CONFIG.memory.engram.autoSync}'.`);
    config.memory.engram.autoSync = DEFAULT_CONFIG.memory.engram.autoSync;
  }
  if (!Number.isFinite(config.memory.engram.syncThrottleMs) || config.memory.engram.syncThrottleMs < 0 || config.memory.engram.syncThrottleMs > 300_000) {
    diagnostics.push(`Invalid memory.engram.syncThrottleMs '${String(config.memory.engram.syncThrottleMs)}'; using '${DEFAULT_CONFIG.memory.engram.syncThrottleMs}'.`);
    config.memory.engram.syncThrottleMs = DEFAULT_CONFIG.memory.engram.syncThrottleMs;
  }
  if (!Number.isFinite(config.memory.engram.timeoutMs) || config.memory.engram.timeoutMs < 100 || config.memory.engram.timeoutMs > 10_000) {
    diagnostics.push(`Invalid memory.engram.timeoutMs '${String(config.memory.engram.timeoutMs)}'; using '${DEFAULT_CONFIG.memory.engram.timeoutMs}'.`);
    config.memory.engram.timeoutMs = DEFAULT_CONFIG.memory.engram.timeoutMs;
  }
  if (config.memory.engram.project !== undefined && typeof config.memory.engram.project !== "string") {
    diagnostics.push(`Invalid memory.engram.project '${String(config.memory.engram.project)}'; removing override.`);
    delete config.memory.engram.project;
  }
  if (!isObject(config.skills)) config.skills = structuredClone(DEFAULT_CONFIG.skills);
  for (const key of [
    "enabled",
    "autoActivation",
    "allowProjectSkills",
    "allowUserSkills",
    "allowOnDemandSkills",
    "allowSkillScripts",
    "requireAuditForProjectSkills",
    "requireAuditForUserSkills",
    "telemetry",
  ] as const) {
    if (typeof config.skills[key] !== "boolean") {
      diagnostics.push(`Invalid skills.${key} '${String(config.skills[key])}'; using '${DEFAULT_CONFIG.skills[key]}'.`);
      config.skills[key] = DEFAULT_CONFIG.skills[key];
    }
  }
  for (const [key, min, max] of [
    ["maxActiveDirect", 0, 5],
    ["maxActivePerStep", 0, 5],
    ["staleAfterDays", 1, 365],
  ] as const) {
    const value = config.skills[key];
    if (!Number.isFinite(value) || value < min || value > max) {
      diagnostics.push(`Invalid skills.${key} '${String(value)}'; using '${DEFAULT_CONFIG.skills[key]}'.`);
      config.skills[key] = DEFAULT_CONFIG.skills[key];
    } else {
      config.skills[key] = Math.floor(value);
    }
  }
  return config;
}

export function loadEffectiveConfig(options: ChalinPathsOptions): LoadedChalinConfig {
  return Effect.runSync(loadEffectiveConfigEffect(options));
}

export function configLayer(options: ChalinPathsOptions): Layer.Layer<ConfigService> {
  return Layer.effect(ConfigService, Effect.map(loadEffectiveConfigEffect(options), (loaded) => ({ loaded })));
}

export function loadEffectiveConfigEffect(options: ChalinPathsOptions): Effect.Effect<LoadedChalinConfig> {
  return Effect.sync(() => {
    const paths = resolveChalinPaths(options);
    const diagnostics: string[] = [];
    const projectConfig = readJsonObject(paths.projectConfigPath, diagnostics);
    const userConfig = readJsonObject(paths.userConfigPath, diagnostics);
    const merged = deepMerge(deepMerge(DEFAULT_CONFIG, projectConfig), userConfig);
    return { config: coerceConfig(merged, diagnostics), diagnostics, paths };
  }).pipe(Effect.withSpan("config.loadEffective"));
}

export function writeProjectConfig(options: ChalinPathsOptions, configPatch: Partial<ChalinConfig>): LoadedChalinConfig {
  const loaded = loadEffectiveConfig(options);
  const current = readJsonObject(loaded.paths.projectConfigPath, []);
  const next = deepMerge(current, configPatch);
  fs.mkdirSync(path.dirname(loaded.paths.projectConfigPath), { recursive: true });
  fs.writeFileSync(loaded.paths.projectConfigPath, `${JSON.stringify(next, null, 2)}\n`, "utf-8");
  return loadEffectiveConfig(options);
}

export function writeUserConfig(options: ChalinPathsOptions, configPatch: Partial<ChalinConfig>): LoadedChalinConfig {
  const loaded = loadEffectiveConfig(options);
  const current = readJsonObject(loaded.paths.userConfigPath, []);
  const next = deepMerge(current, configPatch);
  fs.mkdirSync(path.dirname(loaded.paths.userConfigPath), { recursive: true });
  fs.writeFileSync(loaded.paths.userConfigPath, `${JSON.stringify(next, null, 2)}\n`, "utf-8");
  return loadEffectiveConfig(options);
}

export function setAgentModelOverride(
  options: ChalinPathsOptions,
  agentRef: string,
  model: string | undefined,
  target: Exclude<ModelPersistenceTarget, "session">,
): LoadedChalinConfig {
  const loaded = loadEffectiveConfig(options);
  const overrides = { ...loaded.config.agents.modelOverrides };
  if (model) overrides[agentRef] = model;
  else delete overrides[agentRef];
  const patch: Partial<ChalinConfig> = { agents: { ...loaded.config.agents, modelOverrides: overrides } };
  return target === "project" ? writeProjectConfig(options, patch) : writeUserConfig(options, patch);
}

export function setAgentThinkingOverride(
  options: ChalinPathsOptions,
  agentRef: string,
  thinking: AgentThinkingLevel | undefined,
  target: Exclude<ModelPersistenceTarget, "session">,
): LoadedChalinConfig {
  const loaded = loadEffectiveConfig(options);
  const overrides = { ...loaded.config.agents.thinkingOverrides };
  if (thinking && thinking !== "inherit") overrides[agentRef] = thinking;
  else delete overrides[agentRef];
  const patch: Partial<ChalinConfig> = { agents: { ...loaded.config.agents, thinkingOverrides: overrides } };
  return target === "project" ? writeProjectConfig(options, patch) : writeUserConfig(options, patch);
}

export function approvalDecision(config: ChalinConfig, route: RouteDecision): ApprovalDecision {
  if (route.kind === "bypass") return { action: "allow", reason: "No subagent execution required." };
  if (route.risk === "critical" && config.safety.blockCritical) {
    return { action: "block", reason: "Critical routes are blocked by default safety policy." };
  }
  if (config.safety.approvalRiskThreshold === "none") {
    return { action: "allow", reason: "Approval prompts are disabled; critical routes remain governed by safety.blockCritical." };
  }
  const threshold = config.autonomy === "low" ? "low" : config.safety.approvalRiskThreshold;
  if (riskRank(route.risk) >= riskRank(threshold)) {
    return { action: "ask", reason: `Route risk '${route.risk}' meets approval threshold '${threshold}'.` };
  }
  return { action: "allow", reason: `Route risk '${route.risk}' is below approval threshold '${threshold}'.` };
}
