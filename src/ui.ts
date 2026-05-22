import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ArtifactStore, FeatureArtifactState } from "./artifacts.ts";
import { setAgentModelOverride, setAgentThinkingOverride, type ModelPersistenceTarget } from "./config.ts";
import type { AgentDefinition, AgentThinkingLevel, ApprovalDecision, MeshRuntimeState, MemoryRecord, RouteDecision, RunState } from "./schemas.ts";
import { formatWebFetchAudit, type WebFetchAuditEntry } from "./webfetch.ts";

const FOOTER_FRAMES = ["◆", "◇"];
const FOOTER_ANIMATION_MS = 650;
let footerTimer: ReturnType<typeof setInterval> | undefined;
let footerFrame = 0;
let footerTarget: Pick<ExtensionContext, "hasUI" | "ui"> | undefined;
let footerState: MeshFooterState = { kind: "idle" };

const LEGACY_CONTROL_WIDGET_KEY = "pi-chalin-control";

export function clearLegacyMeshControlWidget(ctx: Pick<ExtensionContext, "hasUI" | "ui">): void {
  if (!ctx.hasUI) return;
  ctx.ui.setWidget(LEGACY_CONTROL_WIDGET_KEY, undefined);
}

export type MeshFooterState =
  | { kind: "idle" }
  | { kind: "off" }
  | { kind: "on" }
  | { kind: "running"; intent: string; agent: string; completed: number; total: number }
  | { kind: "synthesizing" }
  | { kind: "complete"; intent?: string }
  | { kind: "stopped" }
  | { kind: "failed" };

export function setMeshStatus(ctx: Pick<ExtensionContext, "hasUI" | "ui">, state: MeshFooterState | string | undefined): void {
  if (!ctx.hasUI) return;
  if (state === undefined) {
    stopFooterAnimation();
    ctx.ui.setStatus("pi-chalin", undefined);
    return;
  }
  footerTarget = ctx;
  footerState = typeof state === "string" ? parseLegacyMeshStatus(state) : state;
  renderMeshFooterStatus();
  if (footerState.kind === "running" || footerState.kind === "synthesizing") startFooterAnimation();
  else stopFooterAnimation(false);
}

export function meshFooterText(state: MeshFooterState, frame = 0): string {
  if (state.kind === "idle") return "mesh ◦ idle";
  if (state.kind === "off") return "mesh × off";
  if (state.kind === "on") return "mesh ◦ ready";
  if (state.kind === "stopped") return "mesh ■ stopped";
  if (state.kind === "failed") return "mesh × failed";
  if (state.kind === "complete") return state.intent ? `mesh ✓ ${state.intent}` : "mesh ✓ complete";
  if (state.kind === "synthesizing") return `mesh ${FOOTER_FRAMES[frame % FOOTER_FRAMES.length]} synthesizing`;
  return `mesh ${FOOTER_FRAMES[frame % FOOTER_FRAMES.length]} ${state.intent} · ${state.agent} ${state.completed}/${state.total}`;
}

function parseLegacyMeshStatus(text: string): MeshFooterState {
  if (/off$/i.test(text)) return { kind: "off" };
  if (/on$/i.test(text)) return { kind: "on" };
  if (/idle$/i.test(text)) return { kind: "idle" };
  if (/stopped$/i.test(text)) return { kind: "stopped" };
  if (/failed$/i.test(text)) return { kind: "failed" };
  if (/consolidating|synth/i.test(text)) return { kind: "synthesizing" };
  if (/running$/i.test(text)) return { kind: "running", intent: "working", agent: text.replace(/^mesh:\s*/i, "").replace(/\s*running$/i, ""), completed: 0, total: 1 };
  return { kind: "idle" };
}

function startFooterAnimation(): void {
  if (footerTimer) return;
  footerTimer = setInterval(() => {
    footerFrame += 1;
    renderMeshFooterStatus();
  }, FOOTER_ANIMATION_MS);
  footerTimer.unref?.();
}

function stopFooterAnimation(render = true): void {
  if (footerTimer) {
    clearInterval(footerTimer);
    footerTimer = undefined;
  }
  footerFrame = 0;
  if (render) renderMeshFooterStatus();
}

function renderMeshFooterStatus(): void {
  footerTarget?.ui.setStatus("pi-chalin", meshFooterText(footerState, footerFrame));
}

function routeShortName(kind: RouteDecision["kind"]): string {
  return kind.replace(/^multi-agent-/, "");
}

export async function openSafetyApproval(ctx: ExtensionContext, route: RouteDecision, approval: ApprovalDecision): Promise<boolean> {
  const lines = [
    "pi-chalin Safety Approval",
    `risk: ${route.risk}`,
    `route: ${route.kind}`,
    `agents: ${route.agents.join(" → ") || "none"}`,
    `reason: ${route.reason}`,
    `approval: ${approval.reason}`,
    route.needsArtifacts ? "scope: may inspect or change project artifacts" : "scope: read/context only",
  ];
  if (!ctx.hasUI) {
    ctx.ui.notify(lines.join("\n"), approval.action === "block" ? "error" : "warning");
    return false;
  }
  if (approval.action === "block") {
    ctx.ui.notify(lines.join("\n"), "error");
    return false;
  }
  return ctx.ui.confirm("pi-chalin Safety Approval", `${lines.slice(1).join("\n")}\n\nApprove this mesh route once?`);
}

export function summarizeMeshHome(state: MeshRuntimeState, agentCount: number): string[] {
  return [
    "pi-chalin",
    `routing: ${state.autoRoutingEnabled ? "on" : "off"}`,
    `agents: ${agentCount}`,
    `activity: ${summarizeActivity(state)}`,
    `guards: ${summarizeGuardHealth(state.lastRun)}`,
    `memory candidates: ${state.pendingMemoryCandidates}`,
    `approvals: ${state.pendingApprovals}`,
  ];
}

export async function openSmartPanel(
  ctx: ExtensionContext,
  options: {
    state: MeshRuntimeState;
    agents: AgentDefinition[];
    diagnostics: string[];
    pendingMemories: MemoryRecord[];
    onSelectAgents(): Promise<void>;
    onSelectActivity(): Promise<void>;
    onSelectMemory(): Promise<void>;
    onSelectArtifacts?(): Promise<void>;
    onSelectWebFetch?(): Promise<void>;
  },
): Promise<void> {
  const lines = summarizeMeshHome(options.state, options.agents.length);
  setMeshStatus(ctx, options.state.activeRuns > 0 ? { kind: "running", intent: "activity", agent: "mesh", completed: 0, total: 1 } : options.state.autoRoutingEnabled ? { kind: "idle" } : { kind: "off" });

  if (!ctx.hasUI) {
    ctx.ui.notify(lines.join(" | "), "info");
    return;
  }

  if (options.state.pendingApprovals > 0) {
    ctx.ui.notify("pi-chalin has pending approvals.", "warning");
    return;
  }
  if (options.state.activeRuns > 0) return options.onSelectActivity();

  const actions = [
    "Agents",
    ...(options.state.lastRun ? ["Activity"] : []),
    options.pendingMemories.length > 0 ? `Memory · ${options.pendingMemories.length} pending` : "Memory",
    ...(options.onSelectArtifacts ? ["Artifacts"] : []),
    ...(options.onSelectWebFetch ? ["WebFetch"] : []),
    "Status",
    ...(options.diagnostics.length > 0 ? ["Diagnostics"] : []),
    "Close",
  ];
  const selected = await ctx.ui.select("pi-chalin Smart Panel", actions);
  if (selected === "Agents") return options.onSelectAgents();
  if (selected === "Activity") return options.onSelectActivity();
  if (selected?.startsWith("Memory")) return options.onSelectMemory();
  if (selected === "Artifacts") return options.onSelectArtifacts?.();
  if (selected === "WebFetch") return options.onSelectWebFetch?.();
  if (selected === "Diagnostics") return void ctx.ui.notify(options.diagnostics.join("\n"), "warning");
  if (selected === "Status") ctx.ui.notify(lines.join("\n"), "info");
}

export async function openWebFetchAuditPanel(ctx: ExtensionContext, entries: WebFetchAuditEntry[]): Promise<void> {
  const summary = formatWebFetchAudit(entries);
  if (!ctx.hasUI || entries.length === 0) {
    ctx.ui.notify(summary, "info");
    return;
  }
  const format = (entry: WebFetchAuditEntry) => `${entry.freshness} · ${entry.kind} · ${entry.sourceCount} sources · ${truncateUi(entry.label, 70)}`;
  const selected = await ctx.ui.select("pi-chalin WebFetch Audit", [...entries.map(format), "Summary", "Close"]);
  if (selected === "Summary") {
    ctx.ui.notify(summary, "info");
    return;
  }
  const entry = entries.find((candidate) => selected === format(candidate));
  if (!entry) return;
  ctx.ui.notify(formatWebFetchAudit([entry]), entry.freshness === "stale" ? "warning" : "info");
}


export async function openArtifactPanel(ctx: ExtensionContext, store: ArtifactStore): Promise<void> {
  const features = await store.listFeatures();
  if (features.length === 0) {
    ctx.ui.notify("No pi-chalin artifacts yet.", "info");
    return;
  }

  const format = (feature: FeatureArtifactState) => `${feature.status} · ${feature.featureId} · ${feature.currentStep ?? feature.goal}`;
  if (!ctx.hasUI) {
    ctx.ui.notify(features.map(format).join("\n"), "info");
    return;
  }

  const selected = await ctx.ui.select("pi-chalin Artifacts", [...features.map(format), "Close"]);
  const feature = features.find((candidate) => selected === format(candidate));
  if (!feature) return;

  const action = await ctx.ui.select(`Artifacts · ${feature.featureId}`, [
    "Resume context",
    "Checkpoints",
    "Validation contracts",
    "Interview decisions",
    "Worker skills",
    "Close",
  ]);
  if (action === "Resume context") {
    ctx.ui.notify(await store.resumeContext(feature.featureId), "info");
    return;
  }
  if (action === "Checkpoints") {
    ctx.ui.notify(formatArtifactCheckpoints(feature), "info");
    return;
  }
  if (action === "Validation contracts") {
    ctx.ui.notify(formatArtifactValidations(feature), "info");
    return;
  }
  if (action === "Interview decisions") {
    ctx.ui.notify(formatArtifactInterviews(feature), "info");
    return;
  }
  if (action === "Worker skills") {
    ctx.ui.notify(formatArtifactSkills(feature), "info");
  }
}

function formatArtifactCheckpoints(feature: FeatureArtifactState): string {
  if (feature.checkpoints.length === 0) return "No checkpoints recorded for this artifact.";
  return feature.checkpoints
    .slice(-12)
    .map((checkpoint) => `${artifactStatusIcon(checkpoint.status)} ${checkpoint.title} · ${checkpoint.agent} · ${truncateUi(checkpoint.summary, 160)}`)
    .join("\n");
}

function artifactStatusIcon(status: FeatureArtifactState["status"]): string {
  if (status === "complete") return "✓";
  if (status === "active") return "◆";
  if (status === "paused") return "■";
  return "×";
}

function formatArtifactValidations(feature: FeatureArtifactState): string {
  if (feature.validationContracts.length === 0) return "No validation contracts recorded for this artifact.";
  return feature.validationContracts
    .map((contract) => [
      `✓ ${contract.id} · ${contract.title}`,
      contract.commands.length ? `  commands: ${contract.commands.join(" ; ")}` : undefined,
      contract.successCriteria.length ? `  success: ${contract.successCriteria.join(" ; ")}` : undefined,
    ].filter(Boolean).join("\n"))
    .join("\n");
}

function formatArtifactInterviews(feature: FeatureArtifactState): string {
  if (feature.interviewDecisions.length === 0) return "No interview decisions recorded for this artifact.";
  return feature.interviewDecisions.slice(-8).map((decision) => [
    `◆ ${decision.status} · ${truncateUi(decision.reason, 120)}`,
    ...decision.answers.map((answer) => `  - ${truncateUi(answer.question, 80)} → ${truncateUi(answer.answer, 120)}${answer.custom ? " (custom)" : answer.recommended ? " (recommended)" : ""}`),
  ].join("\n")).join("\n");
}

function formatArtifactSkills(feature: FeatureArtifactState): string {
  if (feature.workerSkills.length === 0) return "No worker skills recorded for this artifact.";
  return feature.workerSkills.map((skill) => `◆ ${skill.name} · ${skill.summary}\n  ${skill.path}`).join("\n");
}

export async function openAgentManager(
  ctx: ExtensionContext,
  agents: AgentDefinition[],
  sessionModelOverrides: Map<string, string>,
  sessionThinkingOverrides: Map<string, AgentThinkingLevel>,
): Promise<void> {
  const format = (agent: AgentDefinition) => {
    const key = `${agent.scope}/${agent.name}`;
    const model = sessionModelOverrides.get(key) ?? agent.model;
    const thinking = sessionThinkingOverrides.get(key) ?? agent.thinking ?? "inherit";
    return `${key} · ${agent.concern} · ${model} · thinking ${thinking}`;
  };

  if (!ctx.hasUI) {
    ctx.ui.notify(agents.map(format).join("\n") || "No agents found", "info");
    return;
  }

  const selected = await ctx.ui.select("pi-chalin Agents", agents.map(format));
  if (!selected) return;
  const agent = agents.find((candidate) => selected.startsWith(`${candidate.scope}/${candidate.name} ·`));
  if (!agent) return;

  const action = await ctx.ui.select(`${agent.scope}/${agent.name}`, ["Inspect", "Change model", "Change thinking", "Reset model", "Reset thinking", "Close"]);
  if (action === "Change model") return openAgentModelPicker(ctx, agent, sessionModelOverrides);
  if (action === "Change thinking") return openAgentThinkingPicker(ctx, agent, sessionThinkingOverrides);
  if (action === "Reset model") {
    const key = `${agent.scope}/${agent.name}`;
    sessionModelOverrides.delete(key);
    setAgentModelOverride({ cwd: ctx.cwd }, key, undefined, defaultPersistenceTarget(agent.scope) === "user" ? "user" : "project");
    ctx.ui.notify(`${key} reset to inherit.`, "info");
    return;
  }
  if (action === "Reset thinking") {
    const key = `${agent.scope}/${agent.name}`;
    sessionThinkingOverrides.delete(key);
    setAgentThinkingOverride({ cwd: ctx.cwd }, key, undefined, defaultPersistenceTarget(agent.scope) === "user" ? "user" : "project");
    ctx.ui.notify(`${key} thinking reset to inherit.`, "info");
    return;
  }
  if (action === "Inspect") {
    ctx.ui.notify(
      [
        `${agent.scope}/${agent.name}`,
        agent.description,
        `concern: ${agent.concern}`,
        `model: ${sessionModelOverrides.get(`${agent.scope}/${agent.name}`) ?? agent.model}`,
        `thinking: ${sessionThinkingOverrides.get(`${agent.scope}/${agent.name}`) ?? agent.thinking ?? "inherit"}`,
        `tools: ${agent.tools.join(", ") || "none"}`,
        `memory: read=${agent.memory.read}, write=${agent.memory.write}`,
        agent.sourcePath ? `source: ${agent.sourcePath}` : undefined,
        "keys: ↑/↓ select · enter open · esc close",
      ].filter((line): line is string => Boolean(line)).join("\n"),
      agent.diagnostics.length > 0 ? "warning" : "info",
    );
  }
}

export async function openAgentThinkingPicker(
  ctx: ExtensionContext,
  agent: AgentDefinition,
  sessionThinkingOverrides: Map<string, AgentThinkingLevel>,
): Promise<void> {
  const key = `${agent.scope}/${agent.name}`;
  const options: AgentThinkingLevel[] = ["inherit", "off", "minimal", "low", "medium", "high", "xhigh"];
  const selected = ctx.hasUI ? await ctx.ui.select(`Thinking for ${key}`, options) as AgentThinkingLevel | undefined : undefined;
  if (!selected) return;

  const target = await choosePersistenceTarget(ctx, agent.scope);
  if (!target) return;
  if (target === "session") {
    if (selected === "inherit") sessionThinkingOverrides.delete(key);
    else sessionThinkingOverrides.set(key, selected);
  } else {
    setAgentThinkingOverride({ cwd: ctx.cwd }, key, selected, target);
  }
  ctx.ui.notify(`${key} thinking set to ${selected} (${target}).`, "info");
}

export async function openAgentModelPicker(
  ctx: ExtensionContext,
  agent: AgentDefinition,
  sessionModelOverrides: Map<string, string>,
): Promise<void> {
  const key = `${agent.scope}/${agent.name}`;
  const available = ctx.modelRegistry.getAvailable();
  const options = ["inherit", ...available.map((model) => `${model.provider}/${model.id}`)];
  const selected = ctx.hasUI ? await ctx.ui.select(`Model for ${key}`, options) : undefined;
  if (!selected) return;
  if (selected !== "inherit" && !options.includes(selected)) {
    ctx.ui.notify(`Model '${selected}' is not available.`, "error");
    return;
  }

  const target = await choosePersistenceTarget(ctx, agent.scope);
  if (!target) return;
  if (target === "session") {
    if (selected === "inherit") sessionModelOverrides.delete(key);
    else sessionModelOverrides.set(key, selected);
  } else {
    setAgentModelOverride({ cwd: ctx.cwd }, key, selected === "inherit" ? undefined : selected, target);
  }
  ctx.ui.notify(`${key} model set to ${selected} (${target}).`, "info");
}

export async function openActivityMonitor(ctx: ExtensionContext, run: RunState | undefined): Promise<void> {
  clearLegacyMeshControlWidget(ctx);
  if (!run) {
    ctx.ui.notify("No pi-chalin activity yet.", "info");
    return;
  }
  setMeshStatus(ctx, run.status === "running"
    ? { kind: "running", intent: routeShortName(run.route.kind), agent: run.steps.find((step) => step.status === "running")?.agent ?? "mesh", completed: run.steps.filter((step) => isUsableActivityStatus(step.status)).length, total: Math.max(run.steps.length, 1) }
    : run.status === "complete"
      ? { kind: "complete", intent: routeShortName(run.route.kind) }
      : run.status === "failed"
        ? { kind: "failed" }
        : { kind: "stopped" });
  const lines = formatActivity(run);
  if (!ctx.hasUI) {
    ctx.ui.notify(lines.join("\n"), run.status === "failed" ? "error" : "info");
    return;
  }

  if (run.status === "running") {
    const selected = await ctx.ui.select("pi-chalin Control", ["Live status", "Current agent", "Guards", "Close"]);
    if (selected === "Current agent") {
      const current = run.steps.find((step) => step.status === "running") ?? run.steps.find((step) => step.status === "pending");
      if (current) ctx.ui.notify(formatActivityStep(current), current.status === "failed" ? "error" : "info");
      return;
    }
    if (selected === "Guards") {
      ctx.ui.notify(summarizeRuntimeGuards(run).join("\n"), "info");
      return;
    }
    return;
  }

  const items = [
    "Summary",
    ...run.steps.map((step) => `${step.agent} · ${step.status}`),
    ...(run.logsPath ? ["Log path"] : []),
    "Close",
  ];
  const selected = await ctx.ui.select("pi-chalin Activity", items);
  if (selected === "Summary") ctx.ui.notify(lines.join("\n"), run.status === "failed" ? "error" : "info");
  else if (selected === "Log path") ctx.ui.notify(run.logsPath ?? "No log path recorded.", "info");
  else if (selected && selected !== "Close") {
    const step = run.steps.find((candidate) => selected === `${candidate.agent} · ${candidate.status}`);
    ctx.ui.notify(formatActivityStep(step), step?.status === "failed" ? "error" : "info");
  }
}

export async function openMemoryReview(
  ctx: ExtensionContext,
  memories: MemoryRecord[],
  actions: { approve(id: string): void; reject(id: string): void; delete(id: string): void },
): Promise<void> {
  if (memories.length === 0) {
    ctx.ui.notify("No memory records found.", "info");
    return;
  }
  const sorted = [...memories].sort((a, b) => memoryStatusRank(a.status) - memoryStatusRank(b.status) || b.createdAt.localeCompare(a.createdAt));
  const format = (record: MemoryRecord) => formatMemoryListItem(record);
  if (!ctx.hasUI) {
    ctx.ui.notify(sorted.map(format).join("\n"), "info");
    return;
  }
  const selected = await ctx.ui.select("pi-chalin Memory", [...sorted.map(format), "Close"]);
  if (!selected || selected === "Close") return;
  const record = sorted.find((candidate) => selected === format(candidate));
  if (!record) return;
  const actionOptions = [
    "Details",
    ...(record.status === "pending" ? ["Approve", "Reject"] : []),
    record.status !== "rejected" ? "Delete" : "Delete permanently",
    "Close",
  ];
  const action = await ctx.ui.select(`Memory · ${memoryTitle(record)}`, actionOptions);
  if (action === "Details") {
    ctx.ui.notify(formatMemoryDetail(record), "info");
    return;
  }
  if (action === "Approve") actions.approve(record.id);
  if (action === "Reject") actions.reject(record.id);
  if (action === "Delete" || action === "Delete permanently") actions.delete(record.id);
  if (action && action !== "Close") ctx.ui.notify(`Memory ${action.toLowerCase().replace(/\s+.*/, "")}d: ${memoryTitle(record)}`, "info");
}

function formatMemoryListItem(record: MemoryRecord): string {
  return `${memoryStatusIcon(record.status)} ${record.status} · ${record.category} · ${record.sourceAgent} · ${memoryTitle(record)}`;
}

function formatMemoryDetail(record: MemoryRecord): string {
  return [
    `${memoryStatusIcon(record.status)} ${memoryTitle(record)}`,
    "",
    record.content,
    "",
    `status: ${record.status}`,
    `category: ${record.category}`,
    `source: ${record.sourceAgent}`,
    `confidence: ${Math.round(record.confidence * 100)}%`,
    `importance: ${record.importance}`,
    `trigger: ${record.trigger}`,
    record.topicKey ? `topic: ${record.topicKey}` : undefined,
    record.evidence ? `evidence: ${record.evidence}` : undefined,
    `seen: ${record.duplicateCount} · revisions: ${record.revisionCount}`,
  ].filter((line): line is string => line !== undefined).join("\n");
}

function memoryTitle(record: MemoryRecord): string {
  return truncateUi(stripMemoryPrefix(record.content), 74);
}

function stripMemoryPrefix(content: string): string {
  return content
    .replace(/^`?([a-z][a-z-]{2,30})`?\s*:\s*`?\s*/i, "")
    .replace(/\s+/g, " ")
    .trim();
}

function memoryStatusIcon(status: MemoryRecord["status"]): string {
  if (status === "active") return "✓";
  if (status === "rejected") return "×";
  return "○";
}

function memoryStatusRank(status: MemoryRecord["status"]): number {
  return status === "pending" ? 0 : status === "active" ? 1 : 2;
}

function summarizeActivity(state: MeshRuntimeState): string {
  if (state.activeRuns > 0) return "running";
  if (state.lastRun) return `last ${state.lastRun.status}`;
  return "none";
}

function isUsableActivityStatus(status: RunState["status"] | undefined): boolean {
  return status === "complete" || status === "budget-capped";
}

function formatActivity(run: RunState): string[] {
  const completed = run.steps.filter((step) => isUsableActivityStatus(step.status)).length;
  const active = run.steps.find((step) => step.status === "running" || step.status === "pending");
  const elapsed = formatElapsed(run.startedAt, run.endedAt);
  return [
    `pi-chalin Activity · ${statusIcon(run.status)} ${displayActivityStatus(run.status)} · ${completed}/${run.steps.length} · ${elapsed}`,
    `route: ${run.route.kind} · risk: ${run.route.risk}`,
    `agents: ${run.route.agents.join(" → ") || "none"}`,
    active ? `current: ${active.agent} — ${truncateUi(active.task, 100)}` : undefined,
    ...run.steps.map((step) => `${statusIcon(step.status)} ${step.agent.padEnd(15)} ${formatStepDuration(step)} ${truncateUi(step.output?.handoff || step.error || step.task, 120)}`),
    ...summarizeRuntimeGuards(run),
    run.warnings.length ? `warnings: ${run.warnings.join("; ")}` : undefined,
    run.logsPath && run.status !== "running" ? `log: ${run.logsPath}` : undefined,
    "keys: Enter details · Esc close",
  ].filter((line): line is string => Boolean(line));
}

export function summarizeRuntimeGuards(run: RunState | undefined): string[] {
  if (!run) return ["guards: no run yet"];
  const policyViolations = run.metrics?.policyViolations?.length ?? sumStepMetric(run, (step) => step.metrics?.policyViolations?.length ?? 0);
  const budgetStops = run.metrics?.budgetStopCount ?? sumStepMetric(run, (step) => step.metrics?.budgetStopCount ?? 0);
  const duplicateReads = run.metrics?.duplicateReadCount ?? sumStepMetric(run, (step) => step.metrics?.duplicateReadCount ?? 0);
  const toolCalls = run.metrics?.toolCalls ?? sumStepMetric(run, (step) => step.metrics?.toolCalls ?? 0);
  const modelFallbacks = run.steps.reduce((count, step) => count + (step.modelResolution?.attempts.some((attempt) => ["invalid", "unavailable", "unauthenticated", "fallback"].includes(attempt.status)) ? 1 : 0), 0);
  const worktreeState = summarizeWorktreeGuard(run);
  const guardHealth = policyViolations > 0 || /conflict|unavailable|failed/i.test(worktreeState) || modelFallbacks > 0
    ? "attention"
    : "ok";
  const budgetHealth = budgetStops > 0 ? `limit reached (${budgetStops} stops)` : "ok";
  return [
    `guards: ${guardHealth}`,
    `budget: ${budgetHealth}`,
    `approval: risk ${run.route.risk}`,
    `tools: ${toolCalls} calls · policy violations: ${policyViolations} · duplicate reads: ${duplicateReads}`,
    `worktrees: ${worktreeState}`,
    `model fallback: ${modelFallbacks}`,
  ];
}

function summarizeGuardHealth(run: RunState | undefined): string {
  const first = summarizeRuntimeGuards(run)[0] ?? "guards: no run yet";
  return first.replace(/^guards:\s*/, "");
}

function sumStepMetric(run: RunState, pick: (step: RunState["steps"][number]) => number): number {
  return run.steps.reduce((total, step) => total + pick(step), 0);
}

function summarizeWorktreeGuard(run: RunState): string {
  const warnings = run.warnings.join("\n");
  if (/merge conflict/i.test(warnings)) return "conflict needs resolver";
  if (/worktree isolation unavailable/i.test(warnings)) return "unavailable";
  if (/worktree isolation active|isolated writer/i.test(warnings)) return "isolated writers";
  return "not needed";
}


function statusIcon(status: RunState["status"]): string {
  if (status === "complete" || status === "budget-capped") return "✓";
  if (status === "running") return "◆";
  if (status === "pending") return "·";
  if (status === "paused") return "■";
  if (status === "failed") return "×";
  return "◇";
}

function displayActivityStatus(status: RunState["status"]): string {
  if (status === "budget-capped") return "done · budget limit reached";
  return status;
}

function formatElapsed(startedAt: string | undefined, endedAt: string | undefined): string {
  if (!startedAt) return "--";
  const end = endedAt ? Date.parse(endedAt) : Date.now();
  const ms = Math.max(0, end - Date.parse(startedAt));
  return `${Math.round(ms / 1000)}s`;
}

function formatStepDuration(step: RunState["steps"][number]): string {
  return formatElapsed(step.startedAt, step.endedAt).padStart(4);
}

function truncateUi(text: string | undefined, max: number): string {
  const normalized = (text ?? "").replace(/\s+/g, " ").trim();
  return normalized.length <= max ? normalized : `${normalized.slice(0, max - 1)}…`;
}

function formatActivityStep(step: RunState["steps"][number] | undefined): string {
  if (!step) return "Step not found.";
  return [
    `${step.agent} · ${step.status}`,
    step.task,
    step.output?.handoff,
    step.modelResolution ? `model: ${step.modelResolution.selected}\nthinking: ${step.thinkingLevel ?? "inherit"}\n${step.modelResolution.attempts.map((attempt) => `- ${attempt.source}: ${attempt.ref ?? "inherit"} → ${attempt.status}${attempt.reason ? ` (${attempt.reason})` : ""}`).join("\n")}` : undefined,
    step.metrics ? `tools: ${step.metrics.toolCalls}/${step.maxToolCalls ?? "?"} · policy violations: ${step.metrics.policyViolations?.length ?? 0} · budget stops: ${step.metrics.budgetStopCount ?? 0}` : undefined,
    step.error ? `error: ${step.error}` : undefined,
  ].filter(Boolean).join("\n");
}

async function choosePersistenceTarget(ctx: ExtensionContext, scope: AgentDefinition["scope"]): Promise<ModelPersistenceTarget | undefined> {
  const preferred = defaultPersistenceTarget(scope);
  const options: ModelPersistenceTarget[] = [preferred, ...(["session", "project", "user"] as const).filter((item) => item !== preferred)];
  const selected = ctx.hasUI ? await ctx.ui.select("Persist model selection", options) : preferred;
  return selected as ModelPersistenceTarget | undefined;
}

function defaultPersistenceTarget(scope: AgentDefinition["scope"]): Exclude<ModelPersistenceTarget, "session"> {
  return scope === "project" ? "project" : "user";
}
