import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Effect } from "effect";
import { sessionModelOverrides, sessionThinkingOverrides } from "../agents/agent-overrides.ts";
import { AgentCatalog } from "../agents/agents.ts";
import { ArtifactStore } from "../artifacts/artifacts.ts";
import { loadEffectiveConfig, writeProjectConfig, type ApprovalRiskThreshold, type AutonomyLevel, type ChalinConfig, type MemoryProvider } from "../config/config.ts";
import { createConfiguredMemoryStore, resolveMemoryBackendStatus, type MemoryBackendStatus } from "../memory/memory-provider.ts";
import { resolveChalinPaths } from "../config/paths.ts";
import { activateSkillForTurn, disableSkillForTurn, getActiveRun, getLatestRun } from "../runtime/state.ts";
import type { AgentDefinition, RunState } from "../domain/schemas.ts";
import { SkillCatalog, SkillMetricsStore, auditSkill, formatSkillList, formatSkillSearch, formatSkillShow, promoteSkill, reconcileSkillLifecyclesEffect, retireSkill, summarizeSkillMetrics } from "../skills/skills.ts";
import { runStructuredSkillSelector } from "../skills/skill-selector.ts";
import { openAgentManager, openSkillManager } from "../ui/ui-agents.ts";
import {
  openMemoryReviewWithLoading,
  openArtifactPanel,
  openActivityMonitor,
  formatRunInspection,
  formatRunSummary,
  openWebFetchAuditPanel,
  openSmartPanel,
} from "../ui/ui.ts";
import { setChalinStatus } from "../ui/ui-status.ts";
import { listWebFetchAudit } from "../webfetch/webfetch.ts";

export function registerChalinCommands(pi: ExtensionAPI): void {
  pi.registerCommand("chalin", {
    description: "Open Smart Panel or toggle autonomous routing with: /chalin on|off",
    getArgumentCompletions: (prefix) => {
      const values = ["on", "off", "agents", "skills", "memory", "artifacts", "activity", "runs", "web", "settings", "status"];
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
      const skills = SkillCatalog.load({ cwd: ctx.cwd, config: loaded.config });
      const diagnostics = [...loaded.diagnostics, ...catalog.diagnostics.warnings, ...catalog.diagnostics.errors];
      const activeRun = getActiveRun();
      const lastRun = getLatestRun();

      if (command === "agents") {
        await openAgentManager(ctx, agents, sessionModelOverrides, sessionThinkingOverrides, loaded.config.agents.modelOverrides, loaded.config.agents.thinkingOverrides);
        return;
      }

      if (command === "skills") {
        if (rest.length === 0) await openSkillManager(ctx, skills);
        else await handleSkillsCommand(ctx, skills, rest);
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
          onSelectSkills: () => openSkillManager(ctx, skills),
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

      if (command === "runs") {
        await handleRunsCommand(ctx, rest, activeRun ?? lastRun);
        return;
      }

      if (command === "activity") {
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
            `skills: ${skills.list().length}${loaded.config.skills.enabled ? "" : " (disabled)"}`,
            `pending memory: ${pendingMemoryCount}`,
            `last activity: ${lastRun?.id ?? "none"}`,
            lastRun ? `guards: ${lastRun.metrics?.policyViolations?.length ?? 0} policy violations · ${formatCommandBudgetSummary(lastRun.metrics)}` : "guards: no run yet",
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
          onSelectSkills: () => openSkillManager(ctx, skills),
        }),
      });
    },
  });
}

async function handleRunsCommand(ctx: ExtensionContext, args: string[], inMemoryRun: RunState | undefined): Promise<void> {
  const [subcommand = "", ...rest] = args;
  if (!subcommand || subcommand === "activity") {
    await openActivityMonitor(ctx, inMemoryRun ?? loadLatestPersistedRun(ctx.cwd));
    return;
  }
  if (subcommand === "inspect") {
    const target = rest[0];
    const run = resolveRunReference(ctx.cwd, target, inMemoryRun);
    const stepId = rest[1];
    ctx.ui.notify(formatRunInspection(run, { stepId }), run?.status === "failed" ? "error" : "info");
    return;
  }
  if (subcommand === "summarize" || subcommand === "summary") {
    const json = rest.includes("--json");
    const failedOnly = rest.includes("--failed");
    const latest = rest.includes("--latest") || !failedOnly;
    const run = failedOnly ? loadLatestPersistedRun(ctx.cwd, (candidate) => candidate.status === "failed") : latest ? resolveRunReference(ctx.cwd, "latest", inMemoryRun) : inMemoryRun;
    ctx.ui.notify(json ? JSON.stringify(run ?? null, null, 2) : formatRunSummary(run), run?.status === "failed" ? "error" : "info");
    return;
  }
  ctx.ui.notify("Unknown /chalin runs argument. Use /chalin runs, /chalin runs inspect <runId|latest>, or /chalin runs summarize --latest|--failed|--json.", "warning");
}

function resolveRunReference(cwd: string, target: string | undefined, inMemoryRun: RunState | undefined): RunState | undefined {
  if (!target || target === "latest") return inMemoryRun ?? loadLatestPersistedRun(cwd);
  if (inMemoryRun?.id === target) return inMemoryRun;
  return loadPersistedRun(cwd, target);
}

function loadLatestPersistedRun(cwd: string, predicate: (run: RunState) => boolean = () => true): RunState | undefined {
  const runsDir = path.join(resolveChalinPaths({ cwd }).projectRoot, ".pi-chalin", "runs");
  if (!fs.existsSync(runsDir)) return undefined;
  const files = fs.readdirSync(runsDir)
    .filter((name) => name.endsWith(".json"))
    .map((name) => path.join(runsDir, name))
    .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
  for (const file of files) {
    try {
      const run = JSON.parse(fs.readFileSync(file, "utf-8")) as RunState;
      run.logsPath ??= file;
      if (predicate(run)) return run;
    } catch {
      // Ignore corrupt run files; another persisted run may still be inspectable.
    }
  }
  return undefined;
}

function loadPersistedRun(cwd: string, runId: string): RunState | undefined {
  const runsDir = path.join(resolveChalinPaths({ cwd }).projectRoot, ".pi-chalin", "runs");
  const direct = path.join(runsDir, `${runId}.json`);
  if (fs.existsSync(direct)) {
    try {
      const run = JSON.parse(fs.readFileSync(direct, "utf-8")) as RunState;
      run.logsPath ??= direct;
      return run;
    } catch {
      return undefined;
    }
  }
  return loadLatestPersistedRun(cwd, (run) => run.id === runId);
}

function formatCommandBudgetSummary(metrics: RunState["metrics"] | undefined): string {
  const hits = metrics?.budgetCapHits ?? [];
  const soft = hits.filter((hit) => hit.severity === "soft").length;
  const hard = hits.filter((hit) => hit.severity === "hard").length;
  return `${soft} budget warnings · ${hard} budget checkpoints`;
}

async function handleSkillsCommand(ctx: ExtensionContext, catalog: SkillCatalog, args: string[]): Promise<void> {
  const [subcommand = "list", ...rest] = args;
  if (subcommand === "list") {
    ctx.ui.notify(formatSkillList(catalog), "info");
    return;
  }
  if (subcommand === "metrics") {
    ctx.ui.notify(summarizeSkillMetrics(new SkillMetricsStore({ cwd: ctx.cwd }).snapshot()), "info");
    return;
  }
  if (subcommand === "reconcile") {
    const result = await Effect.runPromise(reconcileSkillLifecyclesEffect({ cwd: ctx.cwd }));
    ctx.ui.notify(`skill lifecycle reconcile: ${result.updated.length} updated${result.updated.length ? `\n${result.updated.map((skill) => `- ${skill.qualifiedName}: ${skill.lifecycle}`).join("\n")}` : ""}`, "info");
    return;
  }
  if (subcommand === "search" || subcommand === "use") {
    const task = rest.join(" ").trim();
    if (!task) {
      ctx.ui.notify(`/chalin skills ${subcommand} requires a task or skill name.`, "warning");
      return;
    }
    if (subcommand === "use") {
      const resolved = catalog.resolve(task);
      if (!resolved.skill) {
        ctx.ui.notify(resolved.error ?? `Skill '${task}' not found.`, "warning");
        return;
      }
      const audit = auditSkill(resolved.skill);
      if (audit.status === "blocked") {
        ctx.ui.notify(`Skill '${resolved.skill.qualifiedName}' failed audit: ${audit.findings.map((finding) => finding.code).join(", ")}`, "warning");
        return;
      }
      activateSkillForTurn(resolved.skill.qualifiedName);
      ctx.ui.notify(`skill activated for this turn: ${resolved.skill.qualifiedName}\n\n${formatSkillSearch(task, catalog.search(task, { explicitSkills: [resolved.skill.qualifiedName] }))}`, "info");
      return;
    }
    const loaded = loadEffectiveConfig({ cwd: ctx.cwd });
    const selection = await runStructuredSkillSelector({
      catalog,
      config: loaded.config,
      task,
      context: {
        model: ctx.model,
        modelRegistry: ctx.modelRegistry,
        signal: ctx.signal,
      },
    });
    const result = catalog.search(task, { config: loaded.config, selectedSkills: selection.selectedSkills });
    ctx.ui.notify(`${formatSkillSearch(task, result)}${selection.diagnostics.length ? `\n\n${selection.diagnostics.join("\n")}` : ""}`, "info");
    return;
  }
  const reference = rest[0];
  if (!reference) {
    ctx.ui.notify(`/chalin skills ${subcommand} requires a skill reference.`, "warning");
    return;
  }
  const resolved = catalog.resolve(reference);
  if (!resolved.skill) {
    ctx.ui.notify(resolved.error ?? `Skill '${reference}' not found.`, "warning");
    return;
  }
  if (subcommand === "show") {
    ctx.ui.notify(formatSkillShow(resolved.skill), "info");
    return;
  }
  if (subcommand === "audit") {
    const audit = auditSkill(resolved.skill);
    ctx.ui.notify(formatSkillShow(resolved.skill, audit), audit.status === "blocked" ? "warning" : "info");
    return;
  }
  if (subcommand === "promote") {
    const target = rest[1] === "user" ? "user" : "project";
    try {
      const result = promoteSkill({ cwd: ctx.cwd, reference, targetScope: target, reviewedBy: "slash-command" });
      ctx.ui.notify(`skill promoted: ${result.skill.qualifiedName}\npath: ${result.path}\naudit: ${result.audit.status}`, "info");
    } catch (error) {
      ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
    }
    return;
  }
  if (subcommand === "disable") {
    disableSkillForTurn(resolved.skill.qualifiedName);
    ctx.ui.notify(`skill disabled for this turn: ${resolved.skill.qualifiedName}`, "info");
    return;
  }
  if (subcommand === "retire") {
    const lifecycle = rest[1] === "expired" ? "expired" : rest[1] === "blocked" ? "blocked" : "stale";
    const result = retireSkill({ cwd: ctx.cwd, reference, lifecycle, actor: "slash-command" });
    ctx.ui.notify(`skill retired: ${result.skill.qualifiedName} -> ${result.skill.lifecycle}\npath: ${result.path}`, "info");
    return;
  }
  ctx.ui.notify("Unknown skills command. Use list, show, search, use, audit, promote, retire, disable, metrics, or reconcile.", "warning");
}

interface ChalinSettingsOptions {
  agents: AgentDefinition[];
  diagnostics: string[];
  onSelectAgents?: () => Promise<void>;
  onSelectSkills?: () => Promise<void>;
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
    `Skills · ${config.skills.enabled ? "on" : "off"}`,
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

  if (selected?.startsWith("Skills")) {
    await openSkillSettings(ctx, config, options);
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

async function openSkillSettings(ctx: ExtensionContext, config: ChalinConfig, options: ChalinSettingsOptions): Promise<void> {
  const selected = await ctx.ui.select("Skills", [
    "Open Skill Manager",
    `Feature · ${config.skills.enabled ? "on" : "off"}`,
    `Project skills · ${config.skills.allowProjectSkills ? "on" : "off"}`,
    `User skills · ${config.skills.allowUserSkills ? "on" : "off"}`,
    `On-demand skills · ${config.skills.allowOnDemandSkills ? "on" : "off"}`,
    `Skill scripts · ${config.skills.allowSkillScripts ? "on" : "off"}`,
    "Policy summary",
    "Close",
  ]);
  if (selected === "Open Skill Manager") return options.onSelectSkills?.();
  if (selected === "Policy summary") {
    ctx.ui.notify(formatSkillPolicySummary(config), "info");
  }
}

async function openMaintenanceSettings(ctx: ExtensionContext): Promise<void> {
  const webFetchFiles = countJsonFiles(webFetchCacheDir(ctx.cwd));
  const selected = await ctx.ui.select("Maintenance", [
    `Clear WebFetch cache · ${webFetchFiles} file${webFetchFiles === 1 ? "" : "s"}`,
    "Close",
  ]);
  if (selected?.startsWith("Clear WebFetch cache")) {
    await clearWebFetchCache(ctx, webFetchFiles);
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
    `skills: ${config.skills.enabled ? "on" : "off"}`,
    `skill scopes: project=${enabledLabel(config.skills.allowProjectSkills)}, user=${enabledLabel(config.skills.allowUserSkills)}, on-demand=${enabledLabel(config.skills.allowOnDemandSkills)}`,
    `diagnostics: ${options.diagnostics.length}`,
  ].join("\n");
}

function formatSkillPolicySummary(config: ChalinConfig): string {
  return [
    "Skill policy",
    `feature: ${enabledLabel(config.skills.enabled)}`,
    `auto activation: ${enabledLabel(config.skills.autoActivation)}`,
    `project skills: ${enabledLabel(config.skills.allowProjectSkills)}`,
    `user skills: ${enabledLabel(config.skills.allowUserSkills)}`,
    `on-demand skills: ${enabledLabel(config.skills.allowOnDemandSkills)}`,
    `skill scripts: ${enabledLabel(config.skills.allowSkillScripts)}`,
    `stale after: ${config.skills.staleAfterDays} days`,
    `project audit required: ${enabledLabel(config.skills.requireAuditForProjectSkills)}`,
    `user audit required: ${enabledLabel(config.skills.requireAuditForUserSkills)}`,
    `telemetry: ${enabledLabel(config.skills.telemetry)}`,
  ].join("\n");
}

function formatSafetyGuardStatus(config: ChalinConfig): string {
  return [
    "Safety guards",
    `recursion guard: ${enabledLabel(config.safety.recursionGuard)} locked`,
    `single-writer guard: ${enabledLabel(config.safety.singleWriterGuard)} locked`,
    `mutation expectation guard: ${enabledLabel(config.safety.mutationExpectationGuard)} locked`,
    `critical route approval: required`,
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
