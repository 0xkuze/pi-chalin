import {
  AssistantMessageComponent,
  getMarkdownTheme,
  ToolExecutionComponent,
  UserMessageComponent,
  type ExtensionContext,
  type Theme,
} from "@earendil-works/pi-coding-agent";
import { Container, Spacer, Text, type Component, type Focusable, type TUI } from "@earendil-works/pi-tui";
import { matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { ArtifactStore, FeatureArtifactState } from "./artifacts.ts";
import { getLatestRun, getLiveStepSession } from "./runtime-state.ts";
import type { AgentDefinition, ApprovalDecision, ChalinRuntimeState, MemoryRecord, RouteDecision, RunState, RunStepState } from "./schemas.ts";
import { clearLegacyChalinControlWidget, setChalinStatus } from "./ui-status.ts";
import { formatWebFetchAudit, type WebFetchAuditEntry } from "./webfetch.ts";

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
  return ctx.ui.confirm("pi-chalin Safety Approval", `${lines.slice(1).join("\n")}\n\nApprove this chalin route once?`);
}

export function summarizeChalinHome(state: ChalinRuntimeState, agentCount: number): string[] {
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
    state: ChalinRuntimeState;
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
  const lines = summarizeChalinHome(options.state, options.agents.length);
  setChalinStatus(ctx, options.state.activeRuns > 0 ? { kind: "running", intent: "activity", agent: "chalin", completed: 0, total: 1 } : options.state.autoRoutingEnabled ? { kind: "idle" } : { kind: "off" });

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

export async function openActivityMonitor(ctx: ExtensionContext, run: RunState | undefined): Promise<void> {
  clearLegacyChalinControlWidget(ctx);
  if (!run) {
    ctx.ui.notify("No pi-chalin activity yet.", "info");
    return;
  }
  setChalinStatus(ctx, run.status === "running"
    ? { kind: "running", intent: routeShortName(run.route.kind), agent: run.steps.find((step) => step.status === "running")?.agent ?? "chalin", completed: run.steps.filter((step) => isUsableActivityStatus(step.status)).length, total: Math.max(run.steps.length, 1) }
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
    if (selected === "Live status") {
      await openLiveStatusOverlay(ctx, run);
      return;
    }
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
    `seen: ${record.duplicateCount} · used: ${record.useCount ?? 0} · revisions: ${record.revisionCount}`,
    record.lastUsedAt ? `last used: ${record.lastUsedAt}` : undefined,
    record.utilityScore !== undefined ? `utility: ${Math.round(record.utilityScore * 100)}%` : undefined,
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
  if (status === "quarantined") return "!";
  if (status === "stale" || status === "superseded") return "-";
  return "○";
}

function memoryStatusRank(status: MemoryRecord["status"]): number {
  if (status === "pending") return 0;
  if (status === "quarantined") return 1;
  if (status === "active") return 2;
  if (status === "stale") return 3;
  if (status === "superseded") return 4;
  return 5;
}

function summarizeActivity(state: ChalinRuntimeState): string {
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

async function openLiveStatusOverlay(ctx: ExtensionContext, run: RunState): Promise<void> {
  if (typeof ctx.ui.custom !== "function") {
    ctx.ui.notify(formatActivity(run).join("\n"), "info");
    return;
  }
  await ctx.ui.custom<void>(
    (tui, theme, _keybindings, done) => new ChalinLiveStatusOverlay(tui, theme, () => getLatestRun() ?? run, ctx.cwd, () => done(undefined)),
    {
      overlay: true,
      overlayOptions: {
        anchor: "center",
        width: "94%",
        maxHeight: "88%",
        margin: 1,
      },
    },
  );
}

type LiveStatusTab = {
  id: string;
  title: string;
  step: RunStepState;
};

class ChalinLiveStatusOverlay implements Component, Focusable {
  focused = false;
  private selectedId: string | undefined;
  private scroll = 0;
  private followTail = true;
  private toolsExpanded = false;
  private timer: ReturnType<typeof setInterval>;

  constructor(
    private readonly tui: TUI,
    private readonly theme: Theme,
    private readonly runProvider: () => RunState,
    private readonly cwd: string,
    private readonly done: () => void,
  ) {
    this.timer = setInterval(() => this.tui.requestRender(), 650);
    this.timer.unref?.();
  }

  handleInput(data: string): void {
    if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
      this.done();
      return;
    }
    if (matchesKey(data, "tab") || matchesKey(data, "right")) {
      this.moveTab(1);
      return;
    }
    if (matchesKey(data, "left")) {
      this.moveTab(-1);
      return;
    }
    if (matchesKey(data, "up")) {
      this.followTail = false;
      this.scroll = Math.max(0, this.scroll - 1);
      this.tui.requestRender();
      return;
    }
    if (matchesKey(data, "down")) {
      this.followTail = false;
      this.scroll += 1;
      this.tui.requestRender();
      return;
    }
    if (matchesKey(data, "pageUp")) {
      this.followTail = false;
      this.scroll = Math.max(0, this.scroll - 8);
      this.tui.requestRender();
      return;
    }
    if (matchesKey(data, "pageDown")) {
      this.followTail = false;
      this.scroll += 8;
      this.tui.requestRender();
      return;
    }
    if (matchesKey(data, "home")) {
      this.followTail = false;
      this.scroll = 0;
      this.tui.requestRender();
      return;
    }
    if (matchesKey(data, "end")) {
      this.followTail = true;
      this.tui.requestRender();
      return;
    }
    if (matchesKey(data, "ctrl+o")) {
      this.toolsExpanded = !this.toolsExpanded;
      this.tui.requestRender();
      return;
    }
  }

  render(width: number): string[] {
    const run = this.runProvider();
    const tabs = liveStatusTabs(run);
    this.ensureSelectedTab(tabs);
    const selected = tabs.find((tab) => tab.id === this.selectedId) ?? tabs[0];
    const overlayWidth = Math.max(1, width);
    const innerWidth = Math.max(1, overlayWidth - 2);
    const bodyHeight = 24;
    const body = selected ? liveStatusBody(run, selected.step, this.tui, this.theme, this.cwd, Math.max(1, innerWidth - 2), this.toolsExpanded) : [this.theme.fg("dim", "No active subagent step.")];
    const maxScroll = Math.max(0, body.length - bodyHeight);
    if (this.followTail) this.scroll = maxScroll;
    this.scroll = Math.min(this.scroll, maxScroll);
    if (this.scroll >= maxScroll) this.followTail = true;
    const visibleBody = body.slice(this.scroll, this.scroll + bodyHeight);
    const border = (text: string) => this.theme.fg("border", text);
    const row = (content = "") => `${border("│")}${padAnsi(content, innerWidth)}${border("│")}`;
    const scrollInfo = maxScroll > 0 ? ` · ${this.scroll + 1}-${Math.min(body.length, this.scroll + bodyHeight)}/${body.length}` : "";
    const lines = [
      border(`╭${"─".repeat(innerWidth)}╮`),
      row(` ${this.theme.fg("accent", this.theme.bold("pi-chalin Live Status"))} ${this.theme.fg("dim", `run ${run.id} · ${displayActivityStatus(run.status)}${scrollInfo}`)}`),
      row(renderLiveTabs(tabs, this.selectedId, this.theme, innerWidth - 1)),
      row(this.theme.fg("dim", " TAB/right next tab · ctrl+o tools · up/down scroll · end live tail · esc close")),
      row(""),
      ...visibleBody.map((line) => row(line)),
      row(""),
      border(`╰${"─".repeat(innerWidth)}╯`),
    ];
    return clampRenderedLines(lines, overlayWidth);
  }

  invalidate(): void {}

  dispose(): void {
    clearInterval(this.timer);
  }

  private ensureSelectedTab(tabs: LiveStatusTab[]): void {
    if (tabs.length === 0) {
      this.selectedId = undefined;
      return;
    }
    if (this.selectedId && tabs.some((tab) => tab.id === this.selectedId)) return;
    this.selectedId = tabs.find((tab) => tab.step.status === "running")?.id
      ?? tabs.find((tab) => tab.step.status === "pending")?.id
      ?? tabs.at(-1)?.id;
    this.scroll = 0;
    this.followTail = true;
  }

  private moveTab(delta: number): void {
    const tabs = liveStatusTabs(this.runProvider());
    if (tabs.length === 0) return;
    this.ensureSelectedTab(tabs);
    const current = Math.max(0, tabs.findIndex((tab) => tab.id === this.selectedId));
    const next = (current + delta + tabs.length) % tabs.length;
    this.selectedId = tabs[next]?.id;
    this.scroll = 0;
    this.followTail = true;
    this.tui.requestRender();
  }
}

function liveStatusTabs(run: RunState): LiveStatusTab[] {
  return run.steps.map((step, index) => ({
    id: step.id || `${step.agent}-${index}`,
    title: `${statusIcon(step.status)} ${step.agent}`,
    step,
  }));
}

function renderLiveTabs(tabs: LiveStatusTab[], selectedId: string | undefined, theme: Theme, width: number): string {
  if (tabs.length === 0) return theme.fg("dim", " no subagent tabs ");
  const parts: string[] = [];
  for (const tab of tabs) {
    const active = tab.id === selectedId;
    const label = ` ${tab.title} `;
    parts.push(active ? theme.bg("selectedBg", theme.fg("text", label)) : theme.fg("dim", label));
  }
  return truncateToWidth(parts.join(" "), width, "…", true);
}

function liveStatusBody(run: RunState, step: RunStepState, tui: TUI, theme: Theme, cwd: string, width: number, toolsExpanded = false): string[] {
  const liveSession = getLiveStepSession(run.id, step.id);
  const messages = liveSession?.getMessages() ?? [];
  const lines: string[] = [
    theme.fg("dim", `route: ${run.route.kind} · progress: ${run.steps.filter((item) => isUsableActivityStatus(item.status)).length}/${run.steps.length} · elapsed: ${formatElapsed(run.startedAt, run.endedAt)}`),
    theme.fg("dim", `step: ${step.id} · ${step.agent} · ${step.status} · ${formatStepDuration(step)}${step.currentTool ? ` · tool: ${step.currentTool}` : ""}`),
    liveSession ? theme.fg("dim", `live session: in-memory · since ${formatElapsed(liveSession.startedAt, undefined)}`) : theme.fg("dim", "live session: not attached; showing persisted step summary"),
    "",
  ];
  lines.push(...(messages.length > 0
    ? renderPiLikeMessages([...messages], tui, cwd, theme, width, toolsExpanded)
    : renderFallbackStepSummary(step, tui, cwd, theme, width, toolsExpanded)));
  if (step.modelResolution || step.metrics || step.error) lines.push(...renderStepDiagnostics(step, theme, width));
  return clampRenderedLines(lines.length > 4 ? lines : [...lines, theme.fg("dim", "No subagent history available yet.")], width);
}

function renderPiLikeMessages(messages: unknown[], tui: TUI, cwd: string, theme: Theme, width: number, toolsExpanded = false): string[] {
  try {
    return renderPiLikeMessagesWithComponents(messages, tui, cwd, width, toolsExpanded);
  } catch {
    return renderPlainSessionMessages(messages, theme, width, toolsExpanded);
  }
}

function renderPiLikeMessagesWithComponents(messages: unknown[], tui: TUI, cwd: string, width: number, toolsExpanded: boolean): string[] {
  const container = new Container();
  const pendingTools = new Map<string, ToolExecutionComponent>();
  const markdownTheme = getMarkdownTheme();
  const toolOptions = { showImages: false, imageWidthCells: Math.max(20, Math.min(80, width - 4)) };

  for (const message of messages) {
    if (!isRecord(message)) continue;
    if (message.role === "user") {
      const text = messageTextContent(message.content);
      if (!text) continue;
      if (container.children.length > 0) container.addChild(new Spacer(1));
      container.addChild(new UserMessageComponent(text, markdownTheme));
      continue;
    }

    if (message.role === "assistant") {
      container.addChild(new AssistantMessageComponent(message as never, false, markdownTheme));
      for (const call of assistantToolCalls(message)) {
        const component = new ToolExecutionComponent(call.name, call.id, call.arguments, toolOptions, undefined, tui, cwd);
        component.setExpanded(toolsExpanded);
        container.addChild(component);
        if (message.stopReason === "aborted" || message.stopReason === "error") {
          component.updateResult({ content: [{ type: "text", text: String(message.errorMessage ?? "Operation failed") }], isError: true });
        } else {
          pendingTools.set(call.id, component);
        }
      }
      continue;
    }

    if (message.role === "toolResult") {
      const toolCallId = typeof message.toolCallId === "string" ? message.toolCallId : "";
      const component = pendingTools.get(toolCallId) ?? orphanToolComponent(message, tui, cwd, toolOptions, toolsExpanded);
      component.updateResult({
        content: toolResultContent(message.content),
        details: message.details,
        isError: Boolean(message.isError),
      });
      if (!pendingTools.has(toolCallId)) container.addChild(component);
      pendingTools.delete(toolCallId);
      continue;
    }

    const text = messageTextContent(message.content ?? message.text ?? message.display);
    if (text) {
      container.addChild(new Spacer(1));
      container.addChild(new Text(text, 1, 0));
    }
  }

  const rendered = container.render(Math.max(12, width));
  return rendered.length > 0 ? clampRenderedLines(rendered, width) : [""];
}

function renderFallbackStepSummary(step: RunStepState, tui: TUI, cwd: string, theme: Theme, width: number, toolsExpanded: boolean): string[] {
  return renderPiLikeMessages(fallbackStepMessages(step), tui, cwd, theme, width, toolsExpanded).concat(
    step.output?.handoff ? renderInfoBlock("Handoff", step.output.handoff, theme, width) : [],
    step.output?.memoryCandidates.length ? renderInfoBlock("Memory candidates", step.output.memoryCandidates.map((candidate) => `- ${candidate.category}: ${candidate.content}`).join("\n"), theme, width) : [],
    step.output?.warnings.length ? renderInfoBlock("Warnings", step.output.warnings.join("\n"), theme, width) : [],
  );
}

function renderPlainSessionMessages(messages: unknown[], theme: Theme, width: number, toolsExpanded: boolean): string[] {
  const lines: string[] = [];
  for (const message of messages) {
    if (!isRecord(message)) continue;
    if (message.role === "assistant") {
      const textParts = Array.isArray(message.content)
        ? message.content.flatMap((part) => isRecord(part) && part.type === "text" && typeof part.text === "string" ? [part.text] : [])
        : [];
      if (textParts.length) lines.push(...renderInfoBlock("Assistant", textParts.join("\n\n"), theme, width));
      for (const call of assistantToolCalls(message)) lines.push(...renderInfoBlock(`$ ${call.name}`, JSON.stringify(call.arguments, null, 2), theme, width));
      continue;
    }
    if (message.role === "toolResult") {
      const toolName = typeof message.toolName === "string" ? message.toolName : "toolResult";
      const text = toolResultContent(message.content).map((part) => part.text ?? "").filter(Boolean).join("\n");
      lines.push(...renderInfoBlock(toolName, formatPlainToolResult(text || "(empty)", theme, toolsExpanded), theme, width));
      continue;
    }
    const text = messageTextContent(message.content ?? message.text);
    if (text) lines.push(...renderInfoBlock(message.role === "user" ? "Task" : String(message.role ?? "message"), text, theme, width));
  }
  return lines.length ? clampRenderedLines(lines, width) : [theme.fg("dim", "No renderable messages in live session.")];
}

function formatPlainToolResult(text: string, theme: Theme, expanded: boolean): string {
  if (expanded) return text;
  const lines = text.split("\n");
  const visible = lines.slice(0, 10).join("\n");
  const remaining = lines.length - 10;
  return remaining > 0
    ? `${visible}\n${theme.fg("dim", `... (${remaining} more lines, ctrl+o to expand)`)}`
    : visible;
}

function fallbackStepMessages(step: RunStepState): unknown[] {
  const messages: unknown[] = [{ role: "user", content: step.task, timestamp: Date.now() }];
  const text = step.output?.raw || step.output?.text || (step.status === "running" ? "Working... waiting for the child session to publish messages." : "");
  if (text) {
    messages.push({
      role: "assistant",
      content: [{ type: "text", text }],
      api: "openai-responses",
      provider: "openai",
      model: step.model ?? "unknown",
      usage: emptyUsage(),
      stopReason: step.error ? "error" : "stop",
      errorMessage: step.error,
      timestamp: Date.now(),
    });
  }
  return messages;
}

function renderInfoBlock(title: string, text: string, theme: Theme, width: number): string[] {
  const container = new Container();
  container.addChild(new Spacer(1));
  container.addChild(new Text(theme.fg("customMessageLabel", theme.bold(title)), 1, 0));
  container.addChild(new Text(text, 1, 0));
  return clampRenderedLines(container.render(width), width);
}

function renderStepDiagnostics(step: RunStepState, theme: Theme, width: number): string[] {
  const diagnostics = formatStepDiagnostics(step);
  return diagnostics ? renderInfoBlock("Step diagnostics", theme.fg("dim", diagnostics), theme, width) : [];
}

function assistantToolCalls(message: Record<string, unknown>): Array<{ id: string; name: string; arguments: Record<string, unknown> }> {
  if (!Array.isArray(message.content)) return [];
  return message.content.flatMap((part, index) => {
    if (!isRecord(part) || part.type !== "toolCall") return [];
    const id = typeof part.id === "string" ? part.id : `tool-${index + 1}`;
    const name = typeof part.name === "string" ? part.name : "tool";
    const args = isRecord(part.arguments) ? part.arguments : isRecord(part.input) ? part.input : {};
    return [{ id, name, arguments: args }];
  });
}

function orphanToolComponent(
  message: Record<string, unknown>,
  tui: TUI,
  cwd: string,
  toolOptions: { showImages: boolean; imageWidthCells: number },
  toolsExpanded: boolean,
): ToolExecutionComponent {
  const name = typeof message.toolName === "string" ? message.toolName : "tool";
  const id = typeof message.toolCallId === "string" ? message.toolCallId : `orphan-${Date.now()}`;
  const component = new ToolExecutionComponent(name, id, {}, toolOptions, undefined, tui, cwd);
  component.setExpanded(toolsExpanded);
  return component;
}

function messageTextContent(content: unknown): string {
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      if (!isRecord(part)) return "";
      if (typeof part.text === "string") return part.text;
      if (typeof part.content === "string") return part.content;
      return "";
    })
    .filter(Boolean)
    .join("\n\n")
    .trim();
}

function toolResultContent(content: unknown): Array<{ type: string; text?: string; data?: string; mimeType?: string }> {
  if (Array.isArray(content)) {
    return content
      .filter(isRecord)
      .map((part) => ({
        type: typeof part.type === "string" ? part.type : "text",
        text: typeof part.text === "string" ? part.text : typeof part.content === "string" ? part.content : undefined,
        data: typeof part.data === "string" ? part.data : undefined,
        mimeType: typeof part.mimeType === "string" ? part.mimeType : undefined,
      }));
  }
  const text = typeof content === "string" ? content : content === undefined ? "" : JSON.stringify(content, null, 2);
  return text ? [{ type: "text", text }] : [];
}

function emptyUsage() {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

function formatStepDiagnostics(step: RunStepState): string {
  return [
    step.modelResolution ? `model: ${step.modelResolution.selected}\nthinking: ${step.thinkingLevel ?? "inherit"}\n${step.modelResolution.attempts.map((attempt) => `- ${attempt.source}: ${attempt.ref ?? "inherit"} -> ${attempt.status}${attempt.reason ? ` (${attempt.reason})` : ""}`).join("\n")}` : undefined,
    step.metrics ? `tools: ${step.metrics.toolCalls}/${step.maxToolCalls ?? "?"}\npolicy violations: ${step.metrics.policyViolations?.length ?? 0}\nbudget stops: ${step.metrics.budgetStopCount ?? 0}\nfiles read: ${step.metrics.filesRead?.join(", ") ?? "none"}` : undefined,
    step.error ? `error: ${step.error}` : undefined,
  ].filter(Boolean).join("\n\n");
}

function padAnsi(text: string, width: number): string {
  const singleLine = text.replace(/\r/g, "").replace(/\n/g, " ").replace(/\t/g, "   ");
  const truncated = truncateToWidth(singleLine, width, "…", false);
  const visible = visibleWidth(truncated);
  const repaired = visible <= width ? truncated : truncateToWidth(truncated, width, "", false);
  return `${repaired}${" ".repeat(Math.max(0, width - visibleWidth(repaired)))}`;
}

function clampRenderedLines(lines: string[], width: number): string[] {
  return lines.map((line) => padAnsi(line, width));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
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
