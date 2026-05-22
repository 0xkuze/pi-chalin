import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { sessionModelOverrides, sessionThinkingOverrides } from "./agent-overrides.ts";
import { AgentCatalog } from "./agents.ts";
import { ArtifactStore } from "./artifacts.ts";
import { loadEffectiveConfig, writeProjectConfig, type ChalinConfig, type MemoryProvider } from "./config.ts";
import { createConfiguredMemoryStore, resolveMemoryBackendStatus, type MemoryBackendStatus } from "./memory-provider.ts";
import { getActiveRun, getLatestRun } from "./runtime-state.ts";
import { openAgentManager } from "./ui-agents.ts";
import {
  openMemoryReview,
  openArtifactPanel,
  openActivityMonitor,
  openWebFetchAuditPanel,
  openSmartPanel,
} from "./ui.ts";
import { setChalinStatus } from "./ui-status.ts";
import { listWebFetchAudit } from "./webfetch.ts";

export function registerChalinCommands(pi: ExtensionAPI): void {
  pi.registerCommand("chalin", {
    description: "Open pi-chalin Smart Panel or toggle autonomous routing with: /chalin on|off",
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
      const pendingMemories = await memory.list("pending");
      const memoryStatus = await resolveMemoryBackendStatus({ cwd: ctx.cwd }, loaded.config);
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
          await openMemoryReview(ctx, await memory.list(), {
            approve: (id) => void memory.approve(id),
            reject: (id) => void memory.reject(id),
            delete: (id) => void memory.delete(id),
          }, memoryReviewOptions(memoryStatus));
        }
        return;
      }

      if (command === "settings") {
        await openChalinSettings(ctx, loaded.config);
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
        ctx.ui.notify(
          [
            `routing: ${loaded.config.enabled ? "on" : "off"}`,
            `autonomy: ${loaded.config.autonomy}`,
            `approval threshold: ${loaded.config.safety.approvalRiskThreshold}`,
            `memory: ${memoryStatus.summary}`,
            ...(memoryStatus.detail ? [`memory detail: ${memoryStatus.detail}`] : []),
            `agents: ${agents.length}`,
            `pending memory: ${pendingMemories.length}`,
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
        onSelectMemory: async () => openMemoryReview(ctx, await memory.list(), {
          approve: (id) => void memory.approve(id),
          reject: (id) => void memory.reject(id),
          delete: (id) => void memory.delete(id),
        }, memoryReviewOptions(memoryStatus)),
        onSelectArtifacts: () => openArtifactPanel(ctx, artifacts),
        onSelectWebFetch: async () => openWebFetchAuditPanel(ctx, await listWebFetchAudit({ cwd: ctx.cwd })),
        onSelectSettings: () => openChalinSettings(ctx, loaded.config),
      });
    },
  });
}

async function openChalinSettings(ctx: ExtensionContext, config: ChalinConfig): Promise<void> {
  const current = config.memory.provider;
  if (!ctx.hasUI) {
    ctx.ui.notify(`memory provider: ${current}`, "info");
    return;
  }

  const selected = await ctx.ui.select("pi-chalin Settings", [`Memory provider · ${labelForMemoryProvider(current)}`, "Close"]);
  if (!selected?.startsWith("Memory provider")) return;

  const choice = await ctx.ui.select("Memory Provider", [
    "Auto · Engram when available",
    "Engram · native Engram memory",
    "pi-chalin local",
    "Close",
  ]);
  const provider = providerFromSettingsChoice(choice);
  if (!provider) return;

  const loaded = writeProjectConfig({ cwd: ctx.cwd }, { memory: { provider } } as Partial<ChalinConfig>);
  const status = await resolveMemoryBackendStatus({ cwd: ctx.cwd }, loaded.config);
  ctx.ui.notify(`Memory provider set to ${labelForMemoryProvider(provider)}.\nActive: ${status.summary}`, "info");
}

function providerFromSettingsChoice(choice: string | undefined): MemoryProvider | undefined {
  if (choice?.startsWith("Auto")) return "auto";
  if (choice?.startsWith("Engram")) return "engram";
  if (choice?.startsWith("pi-chalin")) return "pi-chalin";
  return undefined;
}

function labelForMemoryProvider(provider: MemoryProvider): string {
  if (provider === "auto") return "auto";
  if (provider === "engram") return "engram";
  return "pi-chalin local";
}

function memoryReviewOptions(status: MemoryBackendStatus): { title: string; emptyMessage: string } {
  if (status.configuredProvider === "engram") {
    return {
      title: "Engram Memory",
      emptyMessage: status.engramAvailable
        ? status.detail ?? "No Engram memory records found."
        : "Engram memory is selected, but Engram is unavailable. Start Engram or update /chalin settings.",
    };
  }
  if (status.activeProvider === "engram") {
    return {
      title: "Engram Memory",
      emptyMessage: status.detail ?? "No Engram memory records found.",
    };
  }
  return {
    title: "pi-chalin Memory",
    emptyMessage: "No pi-chalin memory records found.",
  };
}
