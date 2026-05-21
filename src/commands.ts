import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { sessionModelOverrides, sessionThinkingOverrides } from "./agent-overrides.ts";
import { AgentCatalog } from "./agents.ts";
import { ArtifactStore } from "./artifacts.ts";
import { loadEffectiveConfig, writeProjectConfig } from "./config.ts";
import { MemoryStore } from "./memory.ts";
import { getActiveRun, getLatestRun } from "./runtime-state.ts";
import {
  openAgentManager,
  openMemoryReview,
  openArtifactPanel,
  openActivityMonitor,
  openWebFetchAuditPanel,
  openSmartPanel,
  setMeshStatus,
} from "./ui.ts";
import { listWebFetchAudit } from "./webfetch.ts";

export function registerMeshCommands(pi: ExtensionAPI): void {
  pi.registerCommand("mesh", {
    description: "Open pi-mesh Smart Panel or toggle autonomous routing with: /mesh on|off",
    getArgumentCompletions: (prefix) => {
      const values = ["on", "off", "agents", "memory", "artifacts", "activity", "web", "status"];
      const filtered = values.filter((value) => value.startsWith(prefix.trim()));
      return filtered.length > 0 ? filtered.map((value) => ({ value, label: value })) : null;
    },
    handler: async (args, ctx) => {
      const commandLine = args.trim();
      const [command = "", ...rest] = commandLine.split(/\s+/);

      if (command === "on" || command === "off") {
        const enabled = command === "on";
        const loaded = writeProjectConfig({ cwd: ctx.cwd }, { enabled });
        setMeshStatus(ctx, { kind: enabled ? "on" : "off" });
        ctx.ui.notify(`pi-mesh autonomous routing ${enabled ? "enabled" : "disabled"} for this project.`, "info");
        if (loaded.diagnostics.length > 0) ctx.ui.notify(loaded.diagnostics.join("\n"), "warning");
        return;
      }

      const loaded = loadEffectiveConfig({ cwd: ctx.cwd });
      const catalog = AgentCatalog.load({ cwd: ctx.cwd });
      const memory = new MemoryStore({ cwd: ctx.cwd });
      const artifacts = new ArtifactStore({ cwd: ctx.cwd });
      const agents = catalog.list();
      const diagnostics = [...loaded.diagnostics, ...catalog.diagnostics.warnings, ...catalog.diagnostics.errors];
      const pendingMemories = await memory.list("pending");
      const activeRun = getActiveRun();
      const lastRun = getLatestRun();

      if (command === "agents") {
        await openAgentManager(ctx, agents, sessionModelOverrides, sessionThinkingOverrides);
        return;
      }

      if (command === "memory") {
        const query = rest.join(" ").trim();
        if (query) {
          const results = await memory.search(query, 10);
          ctx.ui.notify(results.map((result) => `${result.score} · ${result.record.category}: ${result.record.content}`).join("\n") || "No memory matches.", "info");
        } else {
          await openMemoryReview(ctx, await memory.list(), {
            approve: (id) => void memory.approve(id),
            reject: (id) => void memory.reject(id),
            delete: (id) => void memory.delete(id),
          });
        }
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
        ctx.ui.notify(`Unknown /mesh argument '${command}'. Use /mesh, /mesh activity, /mesh artifacts, /mesh web, /mesh on, or /mesh off. Normal prompts are routed automatically when enabled.`, "warning");
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
          lastRun,
        },
        agents,
        diagnostics,
        pendingMemories,
        onSelectAgents: () => openAgentManager(ctx, agents, sessionModelOverrides, sessionThinkingOverrides),
        onSelectActivity: () => openActivityMonitor(ctx, activeRun ?? lastRun),
        onSelectMemory: async () => openMemoryReview(ctx, await memory.list(), {
          approve: (id) => void memory.approve(id),
          reject: (id) => void memory.reject(id),
          delete: (id) => void memory.delete(id),
        }),
        onSelectArtifacts: () => openArtifactPanel(ctx, artifacts),
        onSelectWebFetch: async () => openWebFetchAuditPanel(ctx, await listWebFetchAudit({ cwd: ctx.cwd })),
      });
    },
  });
}
