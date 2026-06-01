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
import type { AgentDefinition, ApprovalDecision, BudgetCapHit, ChalinRuntimeState, MemoryRecord, RouteDecision, RunState, RunStepState } from "./schemas.ts";
import { clearLegacyChalinControlWidget, setChalinStatus } from "./ui-status.ts";
import { formatWebFetchAudit, type WebFetchAuditEntry } from "./webfetch.ts";

const MEMORY_OVERLAY_TITLE = "Memory";
const WEBFETCH_OVERLAY_TITLE = "Articles";
const LIVE_STATUS_OVERLAY_TITLE = "Live";

function routeShortName(kind: RouteDecision["kind"]): string {
  return kind.replace(/^multi-agent-/, "");
}

export async function openSafetyApproval(ctx: ExtensionContext, route: RouteDecision, approval: ApprovalDecision): Promise<boolean> {
  const lines = [
    "Safety Approval",
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
  return ctx.ui.confirm("Safety Approval", `${lines.slice(1).join("\n")}\n\nApprove this chalin route once?`);
}

export function summarizeChalinHome(state: ChalinRuntimeState, agentCount: number): string[] {
  return [
    "pi-chalin",
    `routing: ${state.autoRoutingEnabled ? "on" : "off"}`,
    `agents: ${agentCount}`,
    `activity: ${summarizeActivity(state)}`,
    `guards: ${summarizeGuardHealth(state.lastRun)}`,
    `memory: ${state.memoryBackend ?? "built-in"}`,
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
    onSelectSettings?(): Promise<void>;
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
    ...(options.onSelectSettings ? ["Settings"] : []),
    "Status",
    ...(options.diagnostics.length > 0 ? ["Diagnostics"] : []),
    "Close",
  ];
  const selected = await ctx.ui.select("Smart Panel", actions);
  if (selected === "Agents") return options.onSelectAgents();
  if (selected === "Activity") return options.onSelectActivity();
  if (selected?.startsWith("Memory")) return options.onSelectMemory();
  if (selected === "Artifacts") return options.onSelectArtifacts?.();
  if (selected === "WebFetch") return options.onSelectWebFetch?.();
  if (selected === "Settings") return options.onSelectSettings?.();
  if (selected === "Diagnostics") return void ctx.ui.notify(options.diagnostics.join("\n"), "warning");
  if (selected === "Status") ctx.ui.notify(lines.join("\n"), "info");
}

export async function openWebFetchAuditPanel(ctx: ExtensionContext, entries: WebFetchAuditEntry[]): Promise<void> {
  const summary = formatWebFetchAudit(entries);
  if (!ctx.hasUI || entries.length === 0) {
    ctx.ui.notify(summary, "info");
    return;
  }
  if (typeof ctx.ui.custom === "function") {
    await openWebFetchAuditOverlay(ctx, entries);
    return;
  }
  const format = (entry: WebFetchAuditEntry) => `${entry.freshness} · ${entry.kind} · ${entry.sourceCount} sources · ${truncateUi(entry.label, 70)}`;
  const selected = await ctx.ui.select("WebFetch Audit", [...entries.map(format), "Summary", "Close"]);
  if (selected === "Summary") {
    ctx.ui.notify(summary, "info");
    return;
  }
  const entry = entries.find((candidate) => selected === format(candidate));
  if (!entry) return;
  ctx.ui.notify(formatWebFetchAudit([entry]), entry.freshness === "stale" ? "warning" : "info");
}

async function openWebFetchAuditOverlay(ctx: ExtensionContext, entries: WebFetchAuditEntry[]): Promise<void> {
  await ctx.ui.custom<void>(
    (tui, theme, _keybindings, done) => new WebFetchAuditOverlay(tui, theme, entries, () => done(undefined)),
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

type WebFetchOverlayFilter = WebFetchAuditEntry["freshness"] | "all";

class WebFetchAuditOverlay implements Component, Focusable {
  focused = false;
  private query = "";
  private filterIndex = 0;
  private selectedIndex = 0;
  private detailOpen = false;
  private detailScroll = 0;
  private readonly filters: WebFetchOverlayFilter[];

  constructor(
    private readonly tui: TUI,
    private readonly theme: Theme,
    private readonly entries: WebFetchAuditEntry[],
    private readonly done: () => void,
  ) {
    const present = new Set(entries.map((entry) => entry.freshness));
    this.filters = ["all", ...(["stale", "fresh", "no-ttl"] as const).filter((filter) => present.has(filter))];
  }

  handleInput(data: string): void {
    if (this.detailOpen) {
      this.handleDetailInput(data);
      return;
    }
    if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
      this.done();
      return;
    }
    if (matchesKey(data, "tab") || matchesKey(data, "right")) {
      this.moveFilter(1);
      return;
    }
    if (matchesKey(data, "left")) {
      this.moveFilter(-1);
      return;
    }
    if (matchesKey(data, "up")) {
      this.moveSelection(-1);
      return;
    }
    if (matchesKey(data, "down")) {
      this.moveSelection(1);
      return;
    }
    if (matchesKey(data, "pageUp")) {
      this.moveSelection(-WEBFETCH_OVERLAY_VISIBLE_ROWS);
      return;
    }
    if (matchesKey(data, "pageDown")) {
      this.moveSelection(WEBFETCH_OVERLAY_VISIBLE_ROWS);
      return;
    }
    if (matchesKey(data, "home")) {
      this.selectedIndex = 0;
      this.tui.requestRender();
      return;
    }
    if (matchesKey(data, "end")) {
      this.selectedIndex = Math.max(0, this.filteredEntries().length - 1);
      this.tui.requestRender();
      return;
    }
    if (matchesKey(data, "enter")) {
      if (this.filteredEntries()[this.selectedIndex]) {
        this.detailOpen = true;
        this.detailScroll = 0;
        this.tui.requestRender();
      }
      return;
    }
    if (isBackspace(data)) {
      this.query = this.query.slice(0, -1);
      this.selectedIndex = Math.min(this.selectedIndex, Math.max(0, this.filteredEntries().length - 1));
      this.tui.requestRender();
      return;
    }
    if (matchesKey(data, "ctrl+u")) {
      this.query = "";
      this.selectedIndex = 0;
      this.tui.requestRender();
      return;
    }
    if (isPrintableInput(data)) {
      this.query += data;
      this.selectedIndex = 0;
      this.tui.requestRender();
    }
  }

  render(width: number): string[] {
    const overlayWidth = Math.max(1, width);
    const innerWidth = Math.max(1, overlayWidth - 2);
    const filtered = this.filteredEntries();
    this.selectedIndex = Math.min(this.selectedIndex, Math.max(0, filtered.length - 1));
    const selected = filtered[this.selectedIndex];
    const filter = this.filters[this.filterIndex] ?? "all";
    if (this.detailOpen) {
      const detail = renderWebFetchDetailCard(selected, this.theme, innerWidth, this.detailScroll, WEBFETCH_DETAIL_VISIBLE_ROWS);
      this.detailScroll = detail.scroll;
      return renderMemoryOverlayShell(this.theme, overlayWidth, [
        ` ${this.theme.fg("accent", this.theme.bold(WEBFETCH_OVERLAY_TITLE))} ${this.theme.fg("dim", selected ? `detail · ${this.selectedIndex + 1}/${filtered.length}` : "detail")}`,
        ` ${this.theme.fg("dim", "Esc back · ↑/↓ scroll · Ctrl+C close")}`,
        "",
        ...detail.lines,
      ]);
    }
    const header = ` ${this.theme.fg("accent", this.theme.bold(WEBFETCH_OVERLAY_TITLE))} ${this.theme.fg("dim", `${filtered.length}/${this.entries.length} bundles · ${webFetchFilterLabel(filter)}`)}`;
    const body = renderWebFetchListWindow(filtered, this.selectedIndex, this.theme, innerWidth);
    return renderMemoryOverlayShell(this.theme, overlayWidth, [
      header,
      ` ${renderWebFetchFilterTabs(this.filters, filter, this.theme, Math.max(20, innerWidth - 2))}`,
      ` ${renderWebFetchSearchInput(this.query, this.theme, Math.max(20, innerWidth - 2))}`,
      ` ${this.theme.fg("dim", webFetchShortcutLine(this.query.length > 0))}`,
      "",
      ...body,
    ]);
  }

  invalidate(): void {}

  private moveFilter(delta: number): void {
    this.filterIndex = (this.filterIndex + delta + this.filters.length) % this.filters.length;
    this.selectedIndex = 0;
    this.detailOpen = false;
    this.detailScroll = 0;
    this.tui.requestRender();
  }

  private moveSelection(delta: number): void {
    const max = Math.max(0, this.filteredEntries().length - 1);
    this.selectedIndex = Math.max(0, Math.min(max, this.selectedIndex + delta));
    this.detailOpen = false;
    this.detailScroll = 0;
    this.tui.requestRender();
  }

  private handleDetailInput(data: string): void {
    if (matchesKey(data, "ctrl+c")) {
      this.done();
      return;
    }
    if (matchesKey(data, "escape") || matchesKey(data, "left") || isBackspace(data) || matchesKey(data, "enter")) {
      this.detailOpen = false;
      this.detailScroll = 0;
      this.tui.requestRender();
      return;
    }
    if (matchesKey(data, "up")) {
      this.detailScroll = Math.max(0, this.detailScroll - 1);
      this.tui.requestRender();
      return;
    }
    if (matchesKey(data, "down")) {
      this.detailScroll += 1;
      this.tui.requestRender();
      return;
    }
    if (matchesKey(data, "pageUp")) {
      this.detailScroll = Math.max(0, this.detailScroll - 8);
      this.tui.requestRender();
      return;
    }
    if (matchesKey(data, "pageDown")) {
      this.detailScroll += 8;
      this.tui.requestRender();
      return;
    }
    if (matchesKey(data, "home")) {
      this.detailScroll = 0;
      this.tui.requestRender();
      return;
    }
    if (matchesKey(data, "end")) {
      this.detailScroll = Number.MAX_SAFE_INTEGER;
      this.tui.requestRender();
    }
  }

  private filteredEntries(): WebFetchAuditEntry[] {
    const filter = this.filters[this.filterIndex] ?? "all";
    const search = parseWebFetchSearchQuery(this.query);
    return this.entries.filter((entry) => {
      if (filter !== "all" && entry.freshness !== filter) return false;
      if (!webFetchMatchesSearchFilters(entry, search.filters)) return false;
      if (search.terms.length === 0) return true;
      const haystack = normalizeSearch(webFetchSearchText(entry));
      return search.terms.every((term) => haystack.includes(term));
    });
  }
}

const WEBFETCH_OVERLAY_VISIBLE_ROWS = 22;
const WEBFETCH_DETAIL_VISIBLE_ROWS = 22;

function renderWebFetchListWindow(entries: WebFetchAuditEntry[], selectedIndex: number, theme: Theme, width: number): string[] {
  if (entries.length === 0) return [theme.fg("muted", "No matching WebFetch bundles.")];
  const startIndex = Math.max(
    0,
    Math.min(selectedIndex - Math.floor(WEBFETCH_OVERLAY_VISIBLE_ROWS / 2), entries.length - WEBFETCH_OVERLAY_VISIBLE_ROWS),
  );
  const endIndex = Math.min(startIndex + WEBFETCH_OVERLAY_VISIBLE_ROWS, entries.length);
  const lines: string[] = [];
  for (let index = startIndex; index < endIndex; index += 1) {
    const entry = entries[index];
    if (!entry) continue;
    const active = index === selectedIndex;
    const line = formatWebFetchOverlayRow(entry, width - 2);
    const prefix = active ? theme.fg("accent", "> ") : "  ";
    const colored = active ? theme.bg("selectedBg", theme.fg("text", line)) : colorWebFetchRow(theme, entry, line);
    lines.push(prefix + colored);
  }
  if (entries.length > WEBFETCH_OVERLAY_VISIBLE_ROWS) {
    lines.push(theme.fg("dim", `  ${selectedIndex + 1}/${entries.length}`));
  }
  return lines;
}

function renderWebFetchDetailCard(
  entry: WebFetchAuditEntry | undefined,
  theme: Theme,
  width: number,
  scroll: number,
  maxRows: number,
): { lines: string[]; scroll: number } {
  if (!entry) return { lines: [theme.fg("muted", "Select a WebFetch bundle to inspect details.")], scroll: 0 };
  const boxWidth = Math.max(20, width - 2);
  const contentWidth = Math.max(12, boxWidth - 4);
  const lines = webFetchDetailLines(entry, theme, contentWidth);
  const maxScroll = Math.max(0, lines.length - maxRows);
  const clampedScroll = Math.max(0, Math.min(scroll, maxScroll));
  const visible = lines.slice(clampedScroll, clampedScroll + maxRows);
  const range = maxScroll > 0 ? ` ${clampedScroll + 1}-${Math.min(lines.length, clampedScroll + maxRows)}/${lines.length}` : "";
  return {
    lines: renderMemoryInnerBox(theme, boxWidth, `WebFetch detail${range}`, visible),
    scroll: clampedScroll,
  };
}

function webFetchDetailLines(entry: WebFetchAuditEntry, theme: Theme, width: number): string[] {
  const sourceRows = entry.sources.length > 0
    ? entry.sources.flatMap((source, index) => [
      theme.fg("text", truncateToWidth(`${index + 1}. ${source.title || source.url || "Untitled source"}`, width, "...", false)),
      source.url ? theme.fg("dim", truncateToWidth(`   ${source.url}`, width, "...", false)) : "",
    ])
    : [theme.fg("muted", "No sources recorded for this bundle.")];
  const warningRows = entry.warnings.length > 0
    ? [
      "",
      theme.fg("muted", "warnings"),
      ...entry.warnings.flatMap((warning) => wrapPlainText(warning, Math.max(12, width)).map((line) => theme.fg("muted", line))),
    ]
    : [];
  return [
    theme.fg("accent", theme.bold(truncateToWidth(entry.label, width, "...", false))),
    theme.fg("dim", truncateToWidth(`${webFetchFilterLabel(entry.freshness)} · ${entry.kind} · ${entry.sourceCount} source${entry.sourceCount === 1 ? "" : "s"} · ${formatWebFetchAge(entry.ageMs)} old`, width, "...", false)),
    "",
    theme.fg("dim", `provider: ${entry.provider}`),
    theme.fg("dim", `key: ${entry.key}`),
    theme.fg("dim", `observed: ${entry.observedAt}`),
    theme.fg("dim", `ttl: ${entry.ttlMs > 0 ? formatWebFetchAge(entry.ttlMs) : "none"}`),
    ...warningRows,
    "",
    theme.fg("muted", "sources"),
    ...sourceRows,
  ].filter((line) => line !== "");
}

function formatWebFetchOverlayRow(entry: WebFetchAuditEntry, width: number): string {
  const sources = `${entry.sourceCount} source${entry.sourceCount === 1 ? "" : "s"}`;
  return truncateToWidth(`${webFetchFreshnessIcon(entry.freshness)} ${entry.freshness} · ${entry.kind} · ${sources} · ${entry.label}`, width, "...", false);
}

function renderWebFetchFilterTabs(filters: WebFetchOverlayFilter[], selected: WebFetchOverlayFilter, theme: Theme, width: number): string {
  const text = filters.map((filter) => {
    const label = ` ${webFetchFilterLabel(filter)} `;
    return filter === selected ? theme.bg("selectedBg", theme.fg("text", label)) : theme.fg("dim", label);
  }).join(" ");
  return truncateToWidth(text, width, "...", true);
}

function renderWebFetchSearchInput(query: string, theme: Theme, width: number): string {
  const text = query ? `Search: ${query}` : "Search: type text or filters like kind:search source:github";
  return truncateToWidth(query ? theme.fg("text", text) : theme.fg("dim", text), width, "...", true);
}

function webFetchShortcutLine(hasQuery: boolean): string {
  const clear = hasQuery ? " · Ctrl+U" : "";
  return `Enter details · Tab freshness · Search kind/fresh/source:value${clear} · Esc`;
}

function webFetchFilterLabel(filter: WebFetchOverlayFilter): string {
  return filter === "all" ? "all" : filter;
}

function colorWebFetchRow(theme: Theme, entry: WebFetchAuditEntry, line: string): string {
  if (entry.freshness === "stale") return theme.fg("accent", line);
  if (entry.freshness === "fresh") return theme.fg("text", line);
  return theme.fg("dim", line);
}

function webFetchFreshnessIcon(freshness: WebFetchAuditEntry["freshness"]): string {
  if (freshness === "fresh") return "✓";
  if (freshness === "stale") return "!";
  return "-";
}

function webFetchSearchText(entry: WebFetchAuditEntry): string {
  return [
    entry.key,
    entry.kind,
    entry.label,
    entry.provider,
    entry.freshness,
    ...entry.warnings,
    ...entry.sources.flatMap((source) => [source.title, source.url]),
  ].filter(Boolean).join(" ");
}

type WebFetchSearchField = "kind" | "freshness" | "provider" | "source" | "key";
type ParsedWebFetchSearch = { terms: string[]; filters: Array<{ field: WebFetchSearchField; value: string }> };

function parseWebFetchSearchQuery(query: string): ParsedWebFetchSearch {
  const terms: string[] = [];
  const filters: ParsedWebFetchSearch["filters"] = [];
  for (const token of normalizeSearch(query).split(" ").filter(Boolean)) {
    const separator = token.indexOf(":");
    if (separator <= 0 || separator === token.length - 1) {
      terms.push(token);
      continue;
    }
    const rawField = token.slice(0, separator);
    const field = webFetchSearchField(rawField);
    if (!field) {
      terms.push(token);
      continue;
    }
    filters.push({ field, value: token.slice(separator + 1) });
  }
  return { terms, filters };
}

function webFetchSearchField(value: string): WebFetchSearchField | undefined {
  if (value === "kind" || value === "type" || value === "mode") return "kind";
  if (value === "fresh" || value === "freshness" || value === "status" || value === "state") return "freshness";
  if (value === "provider") return "provider";
  if (value === "source" || value === "url") return "source";
  if (value === "key" || value === "cache") return "key";
  return undefined;
}

function webFetchMatchesSearchFilters(entry: WebFetchAuditEntry, filters: ParsedWebFetchSearch["filters"]): boolean {
  return filters.every((filter) => normalizeSearch(webFetchSearchFieldValue(entry, filter.field)).includes(filter.value));
}

function webFetchSearchFieldValue(entry: WebFetchAuditEntry, field: WebFetchSearchField): string {
  if (field === "kind") return entry.kind;
  if (field === "freshness") return entry.freshness;
  if (field === "provider") return entry.provider;
  if (field === "key") return entry.key;
  return entry.sources.flatMap((source) => [source.title, source.url]).filter(Boolean).join(" ");
}

function formatWebFetchAge(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "0s";
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h`;
  const days = Math.floor(hours / 24);
  return `${days}d`;
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

  const selected = await ctx.ui.select("Artifacts", [...features.map(format), "Close"]);
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
    const selected = await ctx.ui.select("Control", ["Live status", "Current agent", "Guards", "Close"]);
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
  const selected = await ctx.ui.select("Activity", items);
  if (selected === "Summary") ctx.ui.notify(lines.join("\n"), run.status === "failed" ? "error" : "info");
  else if (selected === "Log path") ctx.ui.notify(run.logsPath ?? "No log path recorded.", "info");
  else if (selected && selected !== "Close") {
    const step = run.steps.find((candidate) => selected === `${candidate.agent} · ${candidate.status}`);
    ctx.ui.notify(formatActivityStep(step), step?.status === "failed" ? "error" : "info");
  }
}

type MemoryReviewActions = { approve(id: string): void; reject(id: string): void; delete(id: string): void };
type MemoryReviewOptions = { title?: string; emptyMessage?: string; loadingMessage?: string; showStatusFilter?: boolean };
type MemoryReviewLoadResult = MemoryRecord[] | { memories: MemoryRecord[]; options?: MemoryReviewOptions };

export async function openMemoryReview(
  ctx: ExtensionContext,
  memories: MemoryRecord[],
  actions: MemoryReviewActions,
  options: MemoryReviewOptions = {},
): Promise<void> {
  if (memories.length === 0) {
    ctx.ui.notify(options.emptyMessage ?? "No memory records found.", "info");
    return;
  }
  const sorted = sortMemoryReviewRecords(memories);
  const format = (record: MemoryRecord) => formatMemoryListItem(record);
  if (!ctx.hasUI) {
    ctx.ui.notify(sorted.map(format).join("\n"), "info");
    return;
  }
  if (typeof ctx.ui.custom === "function") {
    const result = await openMemoryReviewOverlay(ctx, sorted, options);
    handleMemoryReviewResult(ctx, sorted, result, actions);
    return;
  }
  const selected = await ctx.ui.select(options.title ?? "Memory", [...sorted.map(format), "Close"]);
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
  if (action === "Approve") {
    actions.approve(record.id);
    ctx.ui.notify(`Memory approved: ${memoryTitle(record)}`, "info");
    return;
  }
  if (action === "Reject") {
    if (!await confirmMemoryDestructiveAction(ctx, record, "reject")) return;
    actions.reject(record.id);
    ctx.ui.notify(`Memory rejected: ${memoryTitle(record)}`, "info");
    return;
  }
  if (action === "Delete" || action === "Delete permanently") {
    if (!await confirmMemoryDestructiveAction(ctx, record, "delete")) return;
    actions.delete(record.id);
    ctx.ui.notify(`Memory deleted: ${memoryTitle(record)}`, "info");
  }
}

export async function openMemoryReviewWithLoading(
  ctx: ExtensionContext,
  loadMemories: () => Promise<MemoryReviewLoadResult>,
  actions: MemoryReviewActions,
  options: MemoryReviewOptions = {},
): Promise<void> {
  if (!ctx.hasUI || typeof ctx.ui.custom !== "function") {
    if (ctx.hasUI) ctx.ui.notify(options.loadingMessage ?? "Loading memory records...", "info");
    try {
      const loaded = normalizeMemoryReviewLoadResult(await loadMemories(), options);
      await openMemoryReview(ctx, loaded.memories, actions, loaded.options);
    } catch (error) {
      ctx.ui.notify(`Could not load memory records: ${errorMessage(error)}`, "error");
    }
    return;
  }

  const result = await openMemoryReviewLoadingOverlay(ctx, loadMemories, options);
  handleMemoryReviewResult(ctx, result?.memories ?? [], result, actions);
}

type MemoryOverlayAction = "details" | "approve" | "reject" | "delete";
type MemoryOverlayResult = { action: MemoryOverlayAction; id: string } | undefined;
type MemoryOverlayLoadedResult = ({ action: MemoryOverlayAction; id: string; memories: MemoryRecord[] } | undefined);
type MemoryDestructiveAction = Extract<MemoryOverlayAction, "reject" | "delete">;

async function openMemoryReviewOverlay(ctx: ExtensionContext, memories: MemoryRecord[], options: MemoryReviewOptions): Promise<MemoryOverlayResult> {
  return ctx.ui.custom<MemoryOverlayResult>(
    (tui, theme, _keybindings, done) => new MemoryReviewOverlay(tui, theme, options, memories, done),
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

async function openMemoryReviewLoadingOverlay(
  ctx: ExtensionContext,
  loadMemories: () => Promise<MemoryReviewLoadResult>,
  options: MemoryReviewOptions,
): Promise<MemoryOverlayLoadedResult> {
  return ctx.ui.custom<MemoryOverlayLoadedResult>(
    (tui, theme, _keybindings, done) => new MemoryReviewLoadingOverlay(tui, theme, loadMemories, options, done),
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

class MemoryReviewLoadingOverlay implements Component, Focusable {
  focused = false;
  private frame = 0;
  private child: MemoryReviewOverlay | undefined;
  private memories: MemoryRecord[] = [];
  private error: string | undefined;
  private closed = false;
  private readonly timer: ReturnType<typeof setInterval>;

  constructor(
    private readonly tui: TUI,
    private readonly theme: Theme,
    loadMemories: () => Promise<MemoryReviewLoadResult>,
    private readonly options: MemoryReviewOptions,
    private readonly done: (result: MemoryOverlayLoadedResult) => void,
  ) {
    this.timer = setInterval(() => {
      this.frame += 1;
      this.tui.requestRender();
    }, 650);
    this.timer.unref?.();
    void this.load(loadMemories);
  }

  handleInput(data: string): void {
    if (this.child) {
      this.child.handleInput(data);
      return;
    }
    if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c") || matchesKey(data, "enter")) this.close();
  }

  render(width: number): string[] {
    if (this.child) return this.child.render(width);
    return renderMemoryLoadingShell(
      this.theme,
      width,
      MEMORY_OVERLAY_TITLE,
      this.error,
      this.options.loadingMessage ?? "Loading memory records...",
      this.frame,
    );
  }

  invalidate(): void {}

  dispose(): void {
    this.closed = true;
    clearInterval(this.timer);
  }

  private async load(loadMemories: () => Promise<MemoryReviewLoadResult>): Promise<void> {
    try {
      const loaded = normalizeMemoryReviewLoadResult(await loadMemories(), this.options);
      if (this.closed) return;
      this.options.title = loaded.options.title ?? this.options.title;
      this.options.emptyMessage = loaded.options.emptyMessage ?? this.options.emptyMessage;
      this.options.loadingMessage = loaded.options.loadingMessage ?? this.options.loadingMessage;
      this.options.showStatusFilter = loaded.options.showStatusFilter ?? this.options.showStatusFilter;
      this.memories = sortMemoryReviewRecords(loaded.memories);
      clearInterval(this.timer);
      this.child = new MemoryReviewOverlay(this.tui, this.theme, this.options, this.memories, (result) => {
        this.done(result ? { ...result, memories: this.memories } : undefined);
      });
    } catch (error) {
      if (this.closed) return;
      this.error = errorMessage(error);
      clearInterval(this.timer);
    }
    this.tui.requestRender();
  }

  private close(): void {
    this.closed = true;
    clearInterval(this.timer);
    this.done(undefined);
  }
}

class MemoryReviewOverlay implements Component, Focusable {
  focused = false;
  private query = "";
  private filterIndex = 0;
  private selectedIndex = 0;
  private detailOpen = false;
  private detailScroll = 0;
  private pendingConfirmation: { action: MemoryDestructiveAction; record: MemoryRecord } | undefined;
  private readonly filters: Array<MemoryRecord["status"] | "all">;

  constructor(
    private readonly tui: TUI,
    private readonly theme: Theme,
    private readonly options: MemoryReviewOptions,
    private readonly memories: MemoryRecord[],
    private readonly done: (result: MemoryOverlayResult) => void,
  ) {
    const statuses = Array.from(new Set(memories.map((record) => record.status)));
    this.filters = this.showStatusFilter
      ? ["all", ...(["pending", "active", "quarantined", "stale", "superseded", "rejected"] as const).filter((status) => statuses.includes(status))]
      : ["all"];
  }

  handleInput(data: string): void {
    if (this.pendingConfirmation) {
      this.handleConfirmationInput(data);
      return;
    }
    if (this.detailOpen) {
      this.handleDetailInput(data);
      return;
    }
    if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
      this.done(undefined);
      return;
    }
    if (matchesKey(data, "tab") || matchesKey(data, "right")) {
      if (this.filters.length <= 1) return;
      this.filterIndex = (this.filterIndex + 1) % this.filters.length;
      this.selectedIndex = 0;
      this.tui.requestRender();
      return;
    }
    if (matchesKey(data, "left")) {
      if (this.filters.length <= 1) return;
      this.filterIndex = (this.filterIndex - 1 + this.filters.length) % this.filters.length;
      this.selectedIndex = 0;
      this.tui.requestRender();
      return;
    }
    if (matchesKey(data, "up")) {
      this.moveSelection(-1);
      return;
    }
    if (matchesKey(data, "down")) {
      this.moveSelection(1);
      return;
    }
    if (matchesKey(data, "pageUp")) {
      this.moveSelection(-MEMORY_OVERLAY_VISIBLE_ROWS);
      return;
    }
    if (matchesKey(data, "pageDown")) {
      this.moveSelection(MEMORY_OVERLAY_VISIBLE_ROWS);
      return;
    }
    if (matchesKey(data, "home")) {
      this.selectedIndex = 0;
      this.tui.requestRender();
      return;
    }
    if (matchesKey(data, "end")) {
      this.selectedIndex = Math.max(0, this.filteredMemories().length - 1);
      this.tui.requestRender();
      return;
    }
    if (matchesKey(data, "enter")) {
      if (this.filteredMemories()[this.selectedIndex]) {
        this.detailOpen = true;
        this.detailScroll = 0;
        this.tui.requestRender();
      }
      return;
    }
    if (isBackspace(data)) {
      this.query = this.query.slice(0, -1);
      this.selectedIndex = Math.min(this.selectedIndex, Math.max(0, this.filteredMemories().length - 1));
      this.tui.requestRender();
      return;
    }
    if (matchesKey(data, "ctrl+u")) {
      this.query = "";
      this.selectedIndex = 0;
      this.tui.requestRender();
      return;
    }
    if (isPrintableInput(data)) {
      this.query += data;
      this.selectedIndex = 0;
      this.tui.requestRender();
    }
  }

  render(width: number): string[] {
    const overlayWidth = Math.max(1, width);
    const innerWidth = Math.max(1, overlayWidth - 2);
    if (this.pendingConfirmation) {
      return renderMemoryConfirmationDialog(this.theme, overlayWidth, this.pendingConfirmation.action, this.pendingConfirmation.record);
    }
    const filtered = this.filteredMemories();
    this.selectedIndex = Math.min(this.selectedIndex, Math.max(0, filtered.length - 1));
    const selected = filtered[this.selectedIndex];
    const filter = this.filters[this.filterIndex] ?? "all";
    if (this.detailOpen) {
      const detail = renderMemoryDetailCard(selected, this.theme, innerWidth, this.detailScroll, MEMORY_DETAIL_VISIBLE_ROWS);
      this.detailScroll = detail.scroll;
      return renderMemoryOverlayShell(this.theme, overlayWidth, [
        ` ${this.theme.fg("accent", this.theme.bold(this.title))} ${this.theme.fg("dim", selected ? `detail · ${this.selectedIndex + 1}/${filtered.length}` : "detail")}`,
        ` ${this.theme.fg("dim", memoryDetailShortcutLine(selected))}`,
        "",
        ...detail.lines,
      ]);
    }
    const statusSuffix = this.filters.length > 1 ? ` · ${memoryFilterLabel(filter)}` : "";
    const header = ` ${this.theme.fg("accent", this.theme.bold(this.title))} ${this.theme.fg("dim", `${filtered.length}/${this.memories.length} records${statusSuffix}`)}`;
    const body = renderMemoryListWindow(filtered, this.selectedIndex, this.theme, innerWidth);
    return renderMemoryOverlayShell(this.theme, overlayWidth, [
      header,
      ...this.renderStatusFilterRow(filter, innerWidth),
      ` ${renderMemorySearchInput(this.query, this.theme, Math.max(20, innerWidth - 2))}`,
      ` ${this.theme.fg("dim", memoryShortcutLine(selected, this.query.length > 0, this.filters.length > 1))}`,
      "",
      ...body,
    ]);
  }

  invalidate(): void {}

  private moveSelection(delta: number): void {
    const max = Math.max(0, this.filteredMemories().length - 1);
    this.selectedIndex = Math.max(0, Math.min(max, this.selectedIndex + delta));
    this.detailOpen = false;
    this.detailScroll = 0;
    this.tui.requestRender();
  }

  private get title(): string {
    return MEMORY_OVERLAY_TITLE;
  }

  private get showStatusFilter(): boolean {
    return this.options.showStatusFilter ?? true;
  }

  private renderStatusFilterRow(filter: MemoryRecord["status"] | "all", innerWidth: number): string[] {
    if (this.filters.length <= 1) return [];
    return [` ${renderMemoryFilterTabs(this.filters, filter, this.theme, Math.max(20, innerWidth - 2))}`];
  }

  private handleDetailInput(data: string): void {
    if (matchesKey(data, "ctrl+c")) {
      this.done(undefined);
      return;
    }
    if (matchesKey(data, "escape") || matchesKey(data, "left") || isBackspace(data) || matchesKey(data, "enter")) {
      this.detailOpen = false;
      this.detailScroll = 0;
      this.tui.requestRender();
      return;
    }
    if (matchesKey(data, "up")) {
      this.detailScroll = Math.max(0, this.detailScroll - 1);
      this.tui.requestRender();
      return;
    }
    if (matchesKey(data, "down")) {
      this.detailScroll += 1;
      this.tui.requestRender();
      return;
    }
    if (matchesKey(data, "pageUp")) {
      this.detailScroll = Math.max(0, this.detailScroll - 8);
      this.tui.requestRender();
      return;
    }
    if (matchesKey(data, "pageDown")) {
      this.detailScroll += 8;
      this.tui.requestRender();
      return;
    }
    if (matchesKey(data, "home")) {
      this.detailScroll = 0;
      this.tui.requestRender();
      return;
    }
    if (matchesKey(data, "end")) {
      this.detailScroll = Number.MAX_SAFE_INTEGER;
      this.tui.requestRender();
      return;
    }
    if (data === "A" || data === "a") {
      this.finish("approve");
      return;
    }
    if (data === "R" || data === "r") {
      this.finish("reject");
      return;
    }
    if (data === "D" || data === "d") {
      this.finish("delete");
    }
  }

  private finish(action: MemoryOverlayAction): void {
    const record = this.filteredMemories()[this.selectedIndex];
    if (!record) return;
    if ((action === "approve" || action === "reject") && record.status !== "pending") {
      this.tui.requestRender();
      return;
    }
    if (isDestructiveMemoryAction(action)) {
      this.pendingConfirmation = { action, record };
      this.tui.requestRender();
      return;
    }
    this.done({ action, id: record.id });
  }

  private handleConfirmationInput(data: string): void {
    const pending = this.pendingConfirmation;
    if (!pending) return;
    if (matchesKey(data, "ctrl+c")) {
      this.done(undefined);
      return;
    }
    if (matchesKey(data, "escape") || data === "N" || data === "n") {
      this.pendingConfirmation = undefined;
      this.tui.requestRender();
      return;
    }
    if (matchesKey(data, "enter") || data === "Y" || data === "y") {
      this.done({ action: pending.action, id: pending.record.id });
    }
  }

  private filteredMemories(): MemoryRecord[] {
    const filter = this.filters[this.filterIndex] ?? "all";
    const search = parseMemorySearchQuery(this.query);
    return this.memories.filter((record) => {
      if (filter !== "all" && record.status !== filter) return false;
      if (!memoryMatchesSearchFilters(record, search.filters)) return false;
      if (search.terms.length === 0) return true;
      const haystack = normalizeSearch(memorySearchText(record));
      return search.terms.every((term) => haystack.includes(term));
    });
  }
}

const MEMORY_OVERLAY_VISIBLE_ROWS = 22;
const MEMORY_DETAIL_VISIBLE_ROWS = 22;
const MEMORY_LOADING_FRAMES = ["◆", "◇"];

function renderMemoryOverlayShell(theme: Theme, width: number, rows: string[]): string[] {
  const overlayWidth = Math.max(1, width);
  const innerWidth = Math.max(1, overlayWidth - 2);
  const border = (text: string) => theme.fg("border", text);
  const row = (content = "") => `${border("│")}${padAnsi(content, innerWidth)}${border("│")}`;
  return clampRenderedLines([
    border(`╭${"─".repeat(innerWidth)}╮`),
    ...rows.map((line) => row(line)),
    border(`╰${"─".repeat(innerWidth)}╯`),
  ], overlayWidth);
}

function renderMemoryLoadingShell(theme: Theme, width: number, title: string, error: string | undefined, message: string, frame: number): string[] {
  if (error) {
    return renderMemoryOverlayShell(theme, width, [
      ` ${theme.fg("accent", theme.bold(title))} ${theme.fg("dim", "error")}`,
      "",
      ` ${theme.fg("muted", `Could not load memory records: ${error}`)}`,
      "",
      ` ${theme.fg("dim", "Esc close")}`,
    ]);
  }
  return renderMemoryOverlayShell(theme, width, [
    ` ${theme.fg("accent", theme.bold(title))} ${theme.fg("dim", "loading")}`,
    "",
    ` ${theme.fg("accent", MEMORY_LOADING_FRAMES[frame % MEMORY_LOADING_FRAMES.length] ?? "◆")} ${message}`,
    ` ${theme.fg("dim", "Fetching records; cloud sync can take a moment.")}`,
    "",
    ` ${theme.fg("dim", "Esc close")}`,
  ]);
}

function renderMemoryConfirmationDialog(theme: Theme, width: number, action: MemoryDestructiveAction, record: MemoryRecord): string[] {
  const dialogWidth = Math.max(40, Math.min(72, width - 2));
  const contentWidth = Math.max(20, dialogWidth - 4);
  const title = action === "delete" ? "Confirm Delete" : "Confirm Reject";
  const consequence = action === "delete"
    ? "This permanently removes the memory from the configured store."
    : "This marks the memory rejected and removes it from retrieval.";
  const rows = [
    theme.fg("accent", theme.bold("Confirm destructive action")),
    "",
    ...wrapPlainText(consequence, contentWidth),
    "",
    theme.fg("dim", truncateToWidth(`Memory: ${memoryTitle(record)}`, contentWidth, "...", false)),
    "",
    theme.fg("text", "Enter/Y confirm"),
    theme.fg("dim", "Esc/N cancel"),
  ];
  return centerRenderedBlock(renderMemoryInnerBox(theme, dialogWidth, title, rows), width);
}

function memoryShortcutLine(record: MemoryRecord | undefined, hasQuery: boolean, hasStatusFilter: boolean): string {
  const clear = hasQuery ? " · Ctrl+U" : "";
  const status = hasStatusFilter ? " · Tab status" : "";
  return `Enter open/action${status} · Search cat/source/status:value${clear} · Esc`;
}

function memoryDetailShortcutLine(record: MemoryRecord | undefined): string {
  const actions = record?.status === "pending" ? "A approve · R reject · D delete" : record ? "D delete" : "No actions";
  return `Esc back · ↑/↓ scroll · ${actions} · Ctrl+C close`;
}

function normalizeMemoryReviewLoadResult(result: MemoryReviewLoadResult, defaults: MemoryReviewOptions): { memories: MemoryRecord[]; options: MemoryReviewOptions } {
  if (Array.isArray(result)) return { memories: result, options: defaults };
  return { memories: result.memories, options: { ...defaults, ...result.options } };
}

function sortMemoryReviewRecords(memories: MemoryRecord[]): MemoryRecord[] {
  return [...memories].sort((a, b) => memoryStatusRank(a.status) - memoryStatusRank(b.status) || b.createdAt.localeCompare(a.createdAt));
}

function handleMemoryReviewResult(ctx: ExtensionContext, memories: MemoryRecord[], result: MemoryOverlayResult, actions: MemoryReviewActions): void {
  if (!result) return;
  const record = memories.find((candidate) => candidate.id === result.id);
  if (!record) return;
  if (result.action === "details") {
    ctx.ui.notify(formatMemoryDetail(record), "info");
    return;
  }
  if (result.action === "approve") actions.approve(record.id);
  if (result.action === "reject") actions.reject(record.id);
  if (result.action === "delete") actions.delete(record.id);
  ctx.ui.notify(`Memory ${memoryActionPast(result.action)}: ${memoryTitle(record)}`, "info");
}

async function confirmMemoryDestructiveAction(ctx: ExtensionContext, record: MemoryRecord, action: MemoryDestructiveAction): Promise<boolean> {
  const title = action === "delete" ? "Delete Memory" : "Reject Memory";
  const consequence = action === "delete"
    ? "This permanently removes the memory from the configured store."
    : "This marks the memory rejected and removes it from retrieval.";
  return ctx.ui.confirm(title, `${consequence}\n\nMemory: ${memoryTitle(record)}\n\nContinue?`);
}

function isDestructiveMemoryAction(action: MemoryOverlayAction): action is MemoryDestructiveAction {
  return action === "reject" || action === "delete";
}

function renderMemoryListWindow(memories: MemoryRecord[], selectedIndex: number, theme: Theme, width: number): string[] {
  if (memories.length === 0) return [theme.fg("muted", "No matching memories.")];
  const startIndex = Math.max(
    0,
    Math.min(selectedIndex - Math.floor(MEMORY_OVERLAY_VISIBLE_ROWS / 2), memories.length - MEMORY_OVERLAY_VISIBLE_ROWS),
  );
  const endIndex = Math.min(startIndex + MEMORY_OVERLAY_VISIBLE_ROWS, memories.length);
  const lines: string[] = [];
  for (let index = startIndex; index < endIndex; index += 1) {
    const record = memories[index];
    if (!record) continue;
    const active = index === selectedIndex;
    const line = formatMemoryOverlayRow(record, width - 2);
    const prefix = active ? theme.fg("accent", "> ") : "  ";
    const colored = active ? theme.bg("selectedBg", theme.fg("text", line)) : colorMemoryRow(theme, record, line);
    lines.push(prefix + colored);
  }
  if (memories.length > MEMORY_OVERLAY_VISIBLE_ROWS) {
    lines.push(theme.fg("dim", `  ${selectedIndex + 1}/${memories.length}`));
  }
  return lines;
}

function renderMemoryDetailCard(
  record: MemoryRecord | undefined,
  theme: Theme,
  width: number,
  scroll: number,
  maxRows: number,
): { lines: string[]; scroll: number } {
  if (!record) return { lines: [theme.fg("muted", "Select a memory to inspect details.")], scroll: 0 };
  const boxWidth = Math.max(20, width - 2);
  const contentWidth = Math.max(12, boxWidth - 4);
  const lines = memoryDetailLines(record, theme, contentWidth);
  const maxScroll = Math.max(0, lines.length - maxRows);
  const clampedScroll = Math.max(0, Math.min(scroll, maxScroll));
  const visible = lines.slice(clampedScroll, clampedScroll + maxRows);
  const range = maxScroll > 0 ? ` ${clampedScroll + 1}-${Math.min(lines.length, clampedScroll + maxRows)}/${lines.length}` : "";
  return {
    lines: renderMemoryInnerBox(theme, boxWidth, `Memory detail${range}`, visible),
    scroll: clampedScroll,
  };
}

function memoryDetailLines(record: MemoryRecord, theme: Theme, width: number): string[] {
  const title = stripMemoryPrefix(record.content) || record.category;
  const metadata = [
    record.status,
    record.category,
    record.scope,
    record.sourceAgent,
    record.topicKey,
  ].filter(Boolean).join(" · ");
  return [
    theme.fg("accent", theme.bold(truncateToWidth(title, width, "...", false))),
    theme.fg("dim", truncateToWidth(metadata, width, "...", false)),
    "",
    ...wrapPlainText(record.content, Math.max(12, width)).map((line) => theme.fg("text", line)),
    "",
    theme.fg("dim", `confidence ${Math.round(record.confidence * 100)}% · importance ${record.importance}`),
    theme.fg("dim", `seen ${record.duplicateCount} · used ${record.useCount ?? 0} · revisions ${record.revisionCount}`),
    record.trigger ? theme.fg("dim", `trigger: ${record.trigger}`) : "",
    record.createdAt ? theme.fg("dim", `created: ${record.createdAt}`) : "",
    record.lastSeenAt ? theme.fg("dim", `last seen: ${record.lastSeenAt}`) : "",
    record.evidence ? "" : undefined,
    record.evidence ? theme.fg("muted", "evidence") : undefined,
    ...(record.evidence ? wrapPlainText(record.evidence, Math.max(12, width)).map((line) => theme.fg("muted", line)) : []),
  ].filter((line): line is string => line !== undefined);
}

function renderMemoryInnerBox(theme: Theme, width: number, title: string, rows: string[]): string[] {
  const boxWidth = Math.max(20, width);
  const innerWidth = Math.max(1, boxWidth - 2);
  const border = (text: string) => theme.fg("border", text);
  const titleText = ` ${title} `;
  const top = visibleWidth(titleText) < innerWidth
    ? `╭${titleText}${"─".repeat(Math.max(0, innerWidth - visibleWidth(titleText)))}╮`
    : `╭${"─".repeat(innerWidth)}╮`;
  return [
    border(top),
    ...rows.map((line) => `${border("│")}${padAnsi(line, innerWidth)}${border("│")}`),
    border(`╰${"─".repeat(innerWidth)}╯`),
  ].filter((line) => line !== "");
}

function formatMemoryOverlayRow(record: MemoryRecord, width: number): string {
  const title = stripMemoryPrefix(record.content) || record.category;
  return truncateToWidth(`${memoryStatusIcon(record.status)} ${title}`, width, "...", false);
}

function renderMemoryFilterTabs(filters: Array<MemoryRecord["status"] | "all">, selected: MemoryRecord["status"] | "all", theme: Theme, width: number): string {
  const text = filters.map((filter) => {
    const label = ` ${memoryFilterLabel(filter)} `;
    return filter === selected ? theme.bg("selectedBg", theme.fg("text", label)) : theme.fg("dim", label);
  }).join(" ");
  return truncateToWidth(text, width, "...", true);
}

function renderMemorySearchInput(query: string, theme: Theme, width: number): string {
  const text = query ? `Search: ${query}` : "Search: type text or filters like cat:workflow source:engram";
  return truncateToWidth(query ? theme.fg("text", text) : theme.fg("dim", text), width, "...", true);
}

function memoryFilterLabel(filter: MemoryRecord["status"] | "all"): string {
  return filter === "all" ? "all" : filter;
}

function colorMemoryRow(theme: Theme, record: MemoryRecord, line: string): string {
  if (record.status === "pending") return theme.fg("accent", line);
  if (record.status === "active") return theme.fg("text", line);
  if (record.status === "rejected") return theme.fg("muted", line);
  return theme.fg("dim", line);
}

function memorySearchText(record: MemoryRecord): string {
  return [
    record.id,
    record.status,
    record.category,
    record.sourceAgent,
    record.scope,
    record.topicKey,
    record.content,
    record.evidence,
  ].filter(Boolean).join(" ");
}

type MemorySearchField = "status" | "category" | "source" | "scope" | "topic";
type ParsedMemorySearch = { terms: string[]; filters: Array<{ field: MemorySearchField; value: string }> };

function parseMemorySearchQuery(query: string): ParsedMemorySearch {
  const terms: string[] = [];
  const filters: ParsedMemorySearch["filters"] = [];
  for (const token of normalizeSearch(query).split(" ").filter(Boolean)) {
    const separator = token.indexOf(":");
    if (separator <= 0 || separator === token.length - 1) {
      terms.push(token);
      continue;
    }
    const rawField = token.slice(0, separator);
    const field = memorySearchField(rawField);
    if (!field) {
      terms.push(token);
      continue;
    }
    filters.push({ field, value: token.slice(separator + 1) });
  }
  return { terms, filters };
}

function memorySearchField(value: string): MemorySearchField | undefined {
  if (value === "status" || value === "state") return "status";
  if (value === "category" || value === "cat") return "category";
  if (value === "source" || value === "agent") return "source";
  if (value === "scope") return "scope";
  if (value === "topic") return "topic";
  return undefined;
}

function memoryMatchesSearchFilters(record: MemoryRecord, filters: ParsedMemorySearch["filters"]): boolean {
  return filters.every((filter) => normalizeSearch(memorySearchFieldValue(record, filter.field)).includes(filter.value));
}

function memorySearchFieldValue(record: MemoryRecord, field: MemorySearchField): string {
  if (field === "status") return record.status;
  if (field === "category") return record.category;
  if (field === "source") return record.sourceAgent;
  if (field === "scope") return record.scope;
  return record.topicKey ?? "";
}

function normalizeSearch(value: string): string {
  return value.toLowerCase().replace(/\s+/g, " ").trim();
}

function wrapPlainText(text: string, width: number): string[] {
  const normalized = text.replace(/\r/g, "").split("\n").flatMap((line) => line.trim() ? [line.trim()] : [""]);
  const result: string[] = [];
  for (const line of normalized) {
    if (!line) {
      result.push("");
      continue;
    }
    let current = "";
    for (const word of line.split(/\s+/)) {
      const next = current ? `${current} ${word}` : word;
      if (visibleWidth(next) <= width) {
        current = next;
        continue;
      }
      if (current) result.push(current);
      current = visibleWidth(word) > width ? truncateToWidth(word, width, "", false) : word;
    }
    if (current) result.push(current);
  }
  return result.length ? result : [""];
}

function isBackspace(data: string): boolean {
  return data === "\b" || data === "\x7f" || matchesKey(data, "backspace");
}

function isPrintableInput(data: string): boolean {
  return data.length === 1 && data >= " " && data !== "\x7f";
}

function memoryActionPast(action: MemoryOverlayAction): string {
  if (action === "approve") return "approved";
  if (action === "reject") return "rejected";
  if (action === "delete") return "deleted";
  return "opened";
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
    `Activity · ${statusIcon(run.status)} ${displayActivityStatus(run.status)} · ${completed}/${run.steps.length} · ${elapsed}`,
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
  const budgetHits = run.metrics?.budgetCapHits ?? run.steps.flatMap((step) => step.metrics?.budgetCapHits ?? []);
  const duplicateReads = run.metrics?.duplicateReadCount ?? sumStepMetric(run, (step) => step.metrics?.duplicateReadCount ?? 0);
  const toolCalls = run.metrics?.toolCalls ?? sumStepMetric(run, (step) => step.metrics?.toolCalls ?? 0);
  const modelFallbacks = run.steps.reduce((count, step) => count + (step.modelResolution?.attempts.some((attempt) => ["invalid", "unavailable", "unauthenticated", "fallback", "runtime-error"].includes(attempt.status)) ? 1 : 0), 0);
  const worktreeState = summarizeWorktreeGuard(run);
  const guardHealth = policyViolations > 0 || /conflict|unavailable|failed/i.test(worktreeState) || modelFallbacks > 0
    ? "attention"
    : "ok";
  const budgetHealth = summarizeBudgetHealth(budgetHits, budgetStops);
  return [
    `guards: ${guardHealth}`,
    `budget: ${budgetHealth}`,
    `approval: risk ${run.route.risk}`,
    `tools: ${toolCalls} calls · policy violations: ${policyViolations} · duplicate reads: ${duplicateReads}`,
    `worktrees: ${worktreeState}`,
    `model fallback: ${modelFallbacks}`,
  ];
}

function summarizeBudgetHealth(hits: BudgetCapHit[] | undefined, stops: number): string {
  const hard = (hits ?? []).filter((hit) => hit.severity === "hard");
  const soft = (hits ?? []).filter((hit) => hit.severity === "soft");
  if (hard.length > 0 || stops > 0) return `stopped ${formatBudgetHit(hard[0] ?? soft[0])}${stops > 0 ? ` (${stops} stops)` : ""}`;
  if (soft.length > 0) return `warning ${formatBudgetHit(soft[0])}`;
  return "ok";
}

function formatBudgetHit(hit: BudgetCapHit | undefined): string {
  if (!hit) return "unknown cap";
  const used = formatCompactNumber(hit.used);
  const limit = formatCompactNumber(hit.limit);
  return `${hit.name} ${used}/${limit}${hit.toolName ? ` via ${hit.toolName}` : ""}`;
}

function formatCompactNumber(value: number): string {
  if (!Number.isFinite(value)) return "∞";
  if (Math.abs(value) >= 1_000_000) return `${Math.round(value / 100_000) / 10}M`;
  if (Math.abs(value) >= 1_000) return `${Math.round(value / 100) / 10}k`;
  return String(Math.round(value * 1000) / 1000);
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
      row(` ${this.theme.fg("accent", this.theme.bold(LIVE_STATUS_OVERLAY_TITLE))} ${this.theme.fg("dim", `run ${run.id} · ${displayActivityStatus(run.status)}${scrollInfo}`)}`),
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
    step.activeSkills?.length ? `active skills:\n${step.activeSkills.map((item) => `- ${item.skill.qualifiedName}: ${item.reason}`).join("\n")}` : undefined,
    step.suggestedSkills?.length ? `suggested skills:\n${step.suggestedSkills.map((item) => `- ${item.skill.qualifiedName}: ${item.reason}`).join("\n")}` : undefined,
    step.metrics ? `tools: ${step.metrics.toolCalls}/${step.maxToolCalls ?? "?"}\npolicy violations: ${step.metrics.policyViolations?.length ?? 0}\nbudget: ${summarizeBudgetHealth(step.metrics.budgetCapHits, step.metrics.budgetStopCount ?? 0)}\nfiles read: ${step.metrics.filesRead?.join(", ") ?? "none"}` : undefined,
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

function centerRenderedBlock(lines: string[], width: number): string[] {
  return lines.map((line) => {
    const left = Math.max(0, Math.floor((width - visibleWidth(line)) / 2));
    return padAnsi(`${" ".repeat(left)}${line}`, width);
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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
    step.metrics ? `tools: ${step.metrics.toolCalls}/${step.maxToolCalls ?? "?"} · policy violations: ${step.metrics.policyViolations?.length ?? 0} · budget: ${summarizeBudgetHealth(step.metrics.budgetCapHits, step.metrics.budgetStopCount ?? 0)}` : undefined,
    step.error ? `error: ${step.error}` : undefined,
  ].filter(Boolean).join("\n");
}
