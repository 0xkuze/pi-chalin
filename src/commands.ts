import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { sessionModelOverrides, sessionThinkingOverrides } from "./agent-overrides.ts";
import { AgentCatalog } from "./agents.ts";
import { ArtifactStore } from "./artifacts.ts";
import { loadEffectiveConfig, writeProjectConfig, type ApprovalRiskThreshold, type AutonomyLevel, type ChalinConfig, type MemoryProvider } from "./config.ts";
import { createConfiguredMemoryStore, resolveMemoryBackendStatus, type MemoryBackendStatus } from "./memory-provider.ts";
import { resolveChalinPaths } from "./paths.ts";
import { getActiveRun, getLatestRun } from "./runtime-state.ts";
import type { AgentDefinition } from "./schemas.ts";
import { openAgentManager } from "./ui-agents.ts";
import {
  openMemoryReviewWithLoading,
  openArtifactPanel,
  openActivityMonitor,
  openWebFetchAuditPanel,
  openSmartPanel,
} from "./ui.ts";
import { setChalinStatus } from "./ui-status.ts";
import { listWebFetchAudit } from "./webfetch.ts";

export function registerChalinCommands(pi: ExtensionAPI): void {
  pi.registerCommand("chalin", {
    description: "Open Smart Panel or toggle autonomous routing with: /chalin on|off",
    getArgumentCompletions: (prefix) => {
      const values = ["on", "off", "agents", "memory", "artifacts", "activity", "web", "settings", "status"];
      const filtered = values.filter((value) => value.startsWith(prefix.trim()));
      return filtered.length > 0 ? filtered.map((value) => ({ value, label: value })) : null;
    },
    handler: async (args, ctx) => {
      const commandLine = args.trim();
      const [command = "", ...rest] = commandLine.split(/\s+/);

      if (command === "on" || command === "off") {
        const enabled = command === "on";
        const loaded = writeProjectConfig({ cwd: ctx.cwd }, { enabled });
        setChalinStatus(ctx, { kind: enabled ? "on" : "off" });
        ctx.ui.notify(`pi-chalin autonomous routing ${enabled ? "enabled" : "disabled"} for this project.`, "info");
        if (loaded.diagnostics.length > 0) ctx.ui.notify(loaded.diagnostics.join("\n"), "warning");
        return;
      }

      const loaded = loadEffectiveConfig({ cwd: ctx.cwd });
      const catalog = AgentCatalog.load({ cwd: ctx.cwd });
      const memory = createConfiguredMemoryStore({ cwd: ctx.cwd }, loaded.config);
      const artifacts = new ArtifactStore({ cwd: ctx.cwd });
      const agents = catalog.list();
      const diagnostics = [...loaded.diagnostics, ...catalog.diagnostics.warnings, ...catalog.diagnostics.errors];
      const activeRun = getActiveRun();
      const lastRun = getLatestRun();

      if (command === "agents") {
        await openAgentManager(ctx, agents, sessionModelOverrides, sessionThinkingOverrides, loaded.config.agents.modelOverrides, loaded.config.agents.thinkingOverrides);
        return;
      }

      if (command === "memory") {
        const query = rest.join(" ").trim();
        if (query) {
          const bundle = await memory.retrieve({ query, sourceAgent: "human-command", limit: 10, tokenBudget: 1200, includeEvidence: true });
          ctx.ui.notify(bundle.text || "No memory matches.", "info");
        } else {
          await openMemoryReviewWithLoading(ctx, async () => {
            const [memories, status] = await Promise.all([
              memory.list(),
              resolveMemoryBackendStatus({ cwd: ctx.cwd }, loaded.config),
            ]);
            return { memories, options: memoryReviewOptions(status) };
          }, {
            approve: (id) => void memory.approve(id),
            reject: (id) => void memory.reject(id),
            delete: (id) => void memory.delete(id),
          }, { title: "Memory", loadingMessage: "Loading memory records..." });
        }
        return;
      }

      if (command === "settings") {
        await openChalinSettings(ctx, loaded.config, {
          agents,
          diagnostics,
          onSelectAgents: () => openAgentManager(ctx, agents, sessionModelOverrides, sessionThinkingOverrides, loaded.config.agents.modelOverrides, loaded.config.agents.thinkingOverrides),
        });
        return;
      }

      if (command === "artifacts") {
        const featureId = rest.join(" ").trim();
        if (featureId) {
          ctx.ui.notify(await artifacts.resumeContext(featureId), "info");
          return;
        }
        await openArtifactPanel(ctx, artifacts);
        return;
      }

      if (command === "activity" || command === "runs") {
        await openActivityMonitor(ctx, activeRun ?? lastRun);
        return;
      }

      if (command === "web" || command === "webfetch") {
        await openWebFetchAuditPanel(ctx, await listWebFetchAudit({ cwd: ctx.cwd }));
        return;
      }

      if (command === "status") {
        const [pendingMemoryCount, memoryStatus] = await Promise.all([
          memory.pendingCount(),
          resolveMemoryBackendStatus({ cwd: ctx.cwd }, loaded.config),
        ]);
        ctx.ui.notify(
          [
            `routing: ${loaded.config.enabled ? "on" : "off"}`,
            `autonomy: ${loaded.config.autonomy}`,
            `approval threshold: ${labelForApprovalRiskThreshold(loaded.config.safety.approvalRiskThreshold)}`,
            `memory: ${memoryStatus.summary}`,
            ...(memoryStatus.detail ? [`memory detail: ${memoryStatus.detail}`] : []),
            `agents: ${agents.length}`,
            `pending memory: ${pendingMemoryCount}`,
            `last activity: ${lastRun?.id ?? "none"}`,
            lastRun ? `guards: ${lastRun.metrics?.policyViolations?.length ?? 0} policy violations · ${lastRun.metrics?.budgetStopCount ?? 0} budget stops` : "guards: no run yet",
          ].join("\n"),
          "info",
        );
        return;
      }

      if (command && command !== "panel") {
        ctx.ui.notify(`Unknown /chalin argument '${command}'. Use /chalin, /chalin activity, /chalin artifacts, /chalin web, /chalin on, or /chalin off. Normal prompts are routed automatically when enabled.`, "warning");
        return;
      }

      if (activeRun) {
        await openActivityMonitor(ctx, activeRun);
        return;
      }

      const [pendingMemories, memoryStatus] = await Promise.all([
        memory.list("pending"),
        resolveMemoryBackendStatus({ cwd: ctx.cwd }, loaded.config),
      ]);

      await openSmartPanel(ctx, {
        state: {
          autoRoutingEnabled: loaded.config.enabled,
          pendingApprovals: 0,
          activeRuns: activeRun ? 1 : 0,
          pendingMemoryCandidates: pendingMemories.length,
          memoryBackend: memoryStatus.summary,
          lastRun,
        },
        agents,
        diagnostics,
        pendingMemories,
        onSelectAgents: () => openAgentManager(ctx, agents, sessionModelOverrides, sessionThinkingOverrides, loaded.config.agents.modelOverrides, loaded.config.agents.thinkingOverrides),
        onSelectActivity: () => openActivityMonitor(ctx, activeRun ?? lastRun),
        onSelectMemory: async () => openMemoryReviewWithLoading(ctx, async () => {
          const [memories, status] = await Promise.all([
            memory.list(),
            resolveMemoryBackendStatus({ cwd: ctx.cwd }, loaded.config),
          ]);
          return { memories, options: memoryReviewOptions(status) };
        }, {
          approve: (id) => void memory.approve(id),
          reject: (id) => void memory.reject(id),
          delete: (id) => void memory.delete(id),
        }, { title: memoryReviewOptions(memoryStatus).title, loadingMessage: "Loading memory records..." }),
        onSelectArtifacts: () => openArtifactPanel(ctx, artifacts),
        onSelectWebFetch: async () => openWebFetchAuditPanel(ctx, await listWebFetchAudit({ cwd: ctx.cwd })),
        onSelectSettings: () => openChalinSettings(ctx, loaded.config, {
          agents,
          diagnostics,
          onSelectAgents: () => openAgentManager(ctx, agents, sessionModelOverrides, sessionThinkingOverrides, loaded.config.agents.modelOverrides, loaded.config.agents.thinkingOverrides),
        }),
      });
    },
  });
}

interface ChalinSettingsOptions {
  agents: AgentDefinition[];
  diagnostics: string[];
  onSelectAgents?: () => Promise<void>;
}

async function openChalinSettings(ctx: ExtensionContext, config: ChalinConfig, options: ChalinSettingsOptions): Promise<void> {
  const current = config.memory.provider;
  const threshold = config.safety.approvalRiskThreshold;
  const agentOverrideCount = countAgentOverrides(config);
  if (!ctx.hasUI) {
    ctx.ui.notify(formatSettingsSummary(config, options, current, threshold), "info");
    return;
  }

  const selected = await ctx.ui.select("Settings", [
    `Routing · ${config.enabled ? "on" : "off"} · ${config.autonomy}`,
    `Safety · approvals ${labelForApprovalRiskThreshold(threshold)}`,
    `Memory provider · ${labelForMemoryProvider(current)}`,
    `Agents · ${options.agents.length} · ${agentOverrideCount} override${agentOverrideCount === 1 ? "" : "s"}`,
    "Maintenance",
    `Diagnostics · ${options.diagnostics.length}`,
    "Close",
  ]);

  if (selected?.startsWith("Routing")) {
    await openRoutingSettings(ctx, config);
    return;
  }

  if (selected?.startsWith("Memory provider")) {
    await openMemoryProviderSettings(ctx);
    return;
  }

  if (selected?.startsWith("Safety")) {
    await openSafetySettings(ctx, config);
    return;
  }

  if (selected?.startsWith("Agents")) {
    await openAgentSettings(ctx, config, options);
    return;
  }

  if (selected === "Maintenance") {
    await openMaintenanceSettings(ctx);
    return;
  }

  if (selected?.startsWith("Diagnostics")) {
    ctx.ui.notify(options.diagnostics.length > 0 ? options.diagnostics.join("\n") : "No pi-chalin diagnostics.", options.diagnostics.length > 0 ? "warning" : "info");
  }
}

async function openRoutingSettings(ctx: ExtensionContext, config: ChalinConfig): Promise<void> {
  const selected = await ctx.ui.select("Routing", [
    `Autonomous routing · ${config.enabled ? "on" : "off"}`,
    `Autonomy · ${config.autonomy}`,
    "Close",
  ]);
  if (selected?.startsWith("Autonomous routing")) {
    const choice = await ctx.ui.select("Autonomous Routing", ["On", "Off", "Close"]);
    const enabled = routingEnabledFromSettingsChoice(choice);
    if (enabled === undefined) return;
    writeProjectConfig({ cwd: ctx.cwd }, { enabled });
    setChalinStatus(ctx, { kind: enabled ? "on" : "off" });
    ctx.ui.notify(`Autonomous routing ${enabled ? "enabled" : "disabled"} for this project.`, "info");
    return;
  }
  if (selected?.startsWith("Autonomy")) {
    const choice = await ctx.ui.select("Autonomy", [
      "Low · ask before routed work",
      "Balanced · default",
      "High · fewer interruptions",
      "Close",
    ]);
    const autonomy = autonomyFromSettingsChoice(choice);
    if (!autonomy) return;
    const loaded = writeProjectConfig({ cwd: ctx.cwd }, { autonomy });
    ctx.ui.notify(`Autonomy set to ${loaded.config.autonomy}.`, "info");
  }
}

async function openSafetySettings(ctx: ExtensionContext, config: ChalinConfig): Promise<void> {
  const selected = await ctx.ui.select("Safety", [
    `Approval threshold · ${labelForApprovalRiskThreshold(config.safety.approvalRiskThreshold)}`,
    "Guard status",
    "Close",
  ]);
  if (selected?.startsWith("Approval threshold")) {
    const choice = await ctx.ui.select("Approval Threshold", [
      "Low · approve low and above",
      "Medium · approve medium and above",
      "None · do not ask for approvals",
      "Close",
    ]);
    const approvalRiskThreshold = approvalThresholdFromSettingsChoice(choice);
    if (!approvalRiskThreshold) return;

    const loaded = writeProjectConfig({ cwd: ctx.cwd }, { safety: { approvalRiskThreshold } } as Partial<ChalinConfig>);
    ctx.ui.notify(`Approval threshold set to ${labelForApprovalRiskThreshold(loaded.config.safety.approvalRiskThreshold)}.`, "info");
    return;
  }
  if (selected === "Guard status") ctx.ui.notify(formatSafetyGuardStatus(config), "info");
}

async function openMemoryProviderSettings(ctx: ExtensionContext): Promise<void> {
  const choice = await ctx.ui.select("Memory Provider", [
    "Auto · Engram when available",
    "Engram · native Engram memory",
    "Built-in · local memory",
    "Close",
  ]);
  const provider = providerFromSettingsChoice(choice);
  if (!provider) return;

  const loaded = writeProjectConfig({ cwd: ctx.cwd }, { memory: { provider } } as Partial<ChalinConfig>);
  const status = await resolveMemoryBackendStatus({ cwd: ctx.cwd }, loaded.config);
  ctx.ui.notify(`Memory provider set to ${labelForMemoryProvider(provider)}.\nActive: ${status.summary}`, "info");
}

async function openAgentSettings(ctx: ExtensionContext, config: ChalinConfig, options: ChalinSettingsOptions): Promise<void> {
  const selected = await ctx.ui.select("Agents", [
    "Open Agent Manager",
    "Override summary",
    "Close",
  ]);
  if (selected === "Open Agent Manager") return options.onSelectAgents?.();
  if (selected === "Override summary") {
    ctx.ui.notify(formatAgentOverrideSummary(config, options.agents), "info");
  }
}

async function openMaintenanceSettings(ctx: ExtensionContext): Promise<void> {
  const webFetchFiles = countJsonFiles(webFetchCacheDir(ctx.cwd));
  const snapshotExists = fs.existsSync(projectSnapshotCachePath(ctx.cwd));
  const selected = await ctx.ui.select("Maintenance", [
    `Clear WebFetch cache · ${webFetchFiles} file${webFetchFiles === 1 ? "" : "s"}`,
    `Clear project snapshot cache · ${snapshotExists ? "1 file" : "none"}`,
    "Close",
  ]);
  if (selected?.startsWith("Clear WebFetch cache")) {
    await clearWebFetchCache(ctx, webFetchFiles);
    return;
  }
  if (selected?.startsWith("Clear project snapshot cache")) {
    await clearProjectSnapshotCache(ctx, snapshotExists);
  }
}

async function clearWebFetchCache(ctx: ExtensionContext, fileCount: number): Promise<void> {
  if (fileCount === 0) {
    ctx.ui.notify("No WebFetch cache files to clear.", "info");
    return;
  }
  const confirmed = await ctx.ui.confirm(
    "Clear WebFetch Cache",
    `This deletes cached web search/fetch bundles. Fresh web lookups can recreate them.\n\nFiles: ${fileCount}\n\nContinue?`,
  );
  if (!confirmed) return;
  fs.rmSync(webFetchCacheDir(ctx.cwd), { recursive: true, force: true });
  ctx.ui.notify(`Cleared ${fileCount} WebFetch cache file${fileCount === 1 ? "" : "s"}.`, "info");
}

async function clearProjectSnapshotCache(ctx: ExtensionContext, exists: boolean): Promise<void> {
  if (!exists) {
    ctx.ui.notify("No project snapshot cache file to clear.", "info");
    return;
  }
  const confirmed = await ctx.ui.confirm(
    "Clear Project Snapshot Cache",
    "This deletes the cached project snapshot. pi-chalin will rebuild it on the next discovery pass.\n\nContinue?",
  );
  if (!confirmed) return;
  fs.rmSync(projectSnapshotCachePath(ctx.cwd), { force: true });
  ctx.ui.notify("Cleared project snapshot cache.", "info");
}

function routingEnabledFromSettingsChoice(choice: string | undefined): boolean | undefined {
  if (choice === "On") return true;
  if (choice === "Off") return false;
  return undefined;
}

function autonomyFromSettingsChoice(choice: string | undefined): AutonomyLevel | undefined {
  if (choice?.startsWith("Low")) return "low";
  if (choice?.startsWith("Balanced")) return "balanced";
  if (choice?.startsWith("High")) return "high";
  return undefined;
}

function providerFromSettingsChoice(choice: string | undefined): MemoryProvider | undefined {
  if (choice?.startsWith("Auto")) return "auto";
  if (choice?.startsWith("Engram")) return "engram";
  if (choice?.startsWith("Built-in")) return "pi-chalin";
  return undefined;
}

function labelForMemoryProvider(provider: MemoryProvider): string {
  if (provider === "auto") return "auto";
  if (provider === "engram") return "engram";
  return "built-in";
}

function approvalThresholdFromSettingsChoice(choice: string | undefined): ApprovalRiskThreshold | undefined {
  if (choice?.startsWith("Low")) return "low";
  if (choice?.startsWith("Medium")) return "medium";
  if (choice?.startsWith("None")) return "none";
  return undefined;
}

function labelForApprovalRiskThreshold(threshold: ApprovalRiskThreshold): string {
  if (threshold === "none") return "disabled";
  return `from ${threshold}`;
}

function countAgentOverrides(config: ChalinConfig): number {
  return Object.keys(config.agents.modelOverrides).length + Object.keys(config.agents.thinkingOverrides).length;
}

function formatSettingsSummary(
  config: ChalinConfig,
  options: ChalinSettingsOptions,
  provider: MemoryProvider,
  threshold: ApprovalRiskThreshold,
): string {
  const overrideCount = countAgentOverrides(config);
  return [
    `routing: ${config.enabled ? "on" : "off"}`,
    `autonomy: ${config.autonomy}`,
    `approval threshold: ${labelForApprovalRiskThreshold(threshold)}`,
    `memory provider: ${labelForMemoryProvider(provider)}`,
    `agents: ${options.agents.length}`,
    `agent overrides: ${overrideCount}`,
    `diagnostics: ${options.diagnostics.length}`,
  ].join("\n");
}

function formatSafetyGuardStatus(config: ChalinConfig): string {
  return [
    "Safety guards",
    `recursion guard: ${enabledLabel(config.safety.recursionGuard)} locked`,
    `single-writer guard: ${enabledLabel(config.safety.singleWriterGuard)} locked`,
    `mutation expectation guard: ${enabledLabel(config.safety.mutationExpectationGuard)} locked`,
    `critical route blocking: ${enabledLabel(config.safety.blockCritical)} locked`,
  ].join("\n");
}

function formatAgentOverrideSummary(config: ChalinConfig, agents: AgentDefinition[]): string {
  const modelOverrides = Object.entries(config.agents.modelOverrides);
  const thinkingOverrides = Object.entries(config.agents.thinkingOverrides);
  return [
    `agents: ${agents.length}`,
    `model overrides: ${modelOverrides.length}`,
    ...modelOverrides.map(([agent, model]) => `  ${agent}: ${model}`),
    `thinking overrides: ${thinkingOverrides.length}`,
    ...thinkingOverrides.map(([agent, thinking]) => `  ${agent}: ${thinking}`),
  ].join("\n");
}

function enabledLabel(value: boolean): string {
  return value ? "on" : "off";
}

function webFetchCacheDir(cwd: string): string {
  return path.join(resolveChalinPaths({ cwd }).projectRoot, ".pi-chalin", "cache", "webfetch");
}

function projectSnapshotCachePath(cwd: string): string {
  return path.join(resolveChalinPaths({ cwd }).projectRoot, ".pi-chalin", "cache", "project-snapshot.json");
}

function countJsonFiles(dir: string): number {
  if (!fs.existsSync(dir)) return 0;
  try {
    return fs.readdirSync(dir).filter((file) => file.endsWith(".json")).length;
  } catch {
    return 0;
  }
}

function memoryReviewOptions(status: MemoryBackendStatus): { title: string; emptyMessage: string; showStatusFilter?: boolean } {
  if (status.configuredProvider === "engram") {
    return {
      title: "Engram Memory",
      showStatusFilter: false,
      emptyMessage: status.engramAvailable
        ? status.detail ?? "No Engram memory records found."
        : "Engram memory is selected, but Engram is unavailable. Start Engram or update /chalin settings.",
    };
  }
  if (status.activeProvider === "engram") {
    return {
      title: "Engram Memory",
      showStatusFilter: false,
      emptyMessage: status.detail ?? "No Engram memory records found.",
    };
  }
  return {
    title: "Memory",
    emptyMessage: "No built-in memory records found.",
  };
}
