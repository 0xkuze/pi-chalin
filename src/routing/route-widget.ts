import type { ChalinFooterState } from "../ui/ui-status.ts";
import type { CheckpointInfo, NestedRunTrace, RouteDecision, RunState, RunStatus, RunStepPauseReason, RunStepStatus, WorkUnit } from "../domain/schemas.ts";
import { isCheckpointStepStatus, isUsableStepStatus } from "../runtime/status.ts";
export { isUsableStepStatus } from "../runtime/status.ts";

type ChalinRouteWidgetStep = {
  id?: string;
  agent: string;
  task?: string;
  status?: RunStepStatus;
  pauseReason?: RunStepPauseReason;
  checkpoint?: CheckpointInfo;
  model?: string;
  thinkingLevel?: string;
  skills?: string[];
  error?: string;
  skipReason?: string;
  workUnitId?: string;
  handoff?: string;
  nestedRuns?: NestedRunTrace[];
};

export type ChalinRouteWidgetDetails = {
  route?: RouteDecision;
  run?: {
    id: string;
    rootTask?: string;
    status: RunStatus;
    steps: ChalinRouteWidgetStep[];
    workUnits?: RunState["workUnits"];
    metrics?: RunState["metrics"];
    warnings?: string[];
    recoveryState?: RunState["recoveryState"];
  };
};

type ChalinRouteToolParams = {
  task: string;
  topology?: "auto" | "sequential" | "dag" | "chain" | "parallel";
  steps?: Array<{ id?: string; agent: string; task: string }>;
  stages?: Array<{ id?: string; name?: string; tasks?: Array<{ id?: string; agent: string; task: string }> }>;
};

export function formatChalinRoutePlanWidget(params: ChalinRouteToolParams): string {
  const steps = plannedWidgetSteps(params);
  const title = routeTitle(params.topology, params.task);
  const agents = steps.map((step) => step.agent).filter(Boolean);
  return [
    `chalin · ${title}`,
    agents.length ? `agents: ${compactAgentPath(agents)} · 0/${steps.length || 1}` : "agents: memory · 0/1",
    ...steps.slice(0, 8).map((step, index) => `${treePrefix(index, steps.length)} ${statusGlyph(step.status ?? "pending")} ${step.agent} — ${shortText(step.task)}`),
    steps.length > 8 ? `└ … +${steps.length - 8} more` : undefined,
  ].filter((line): line is string => Boolean(line)).join("\n");
}

export function formatChalinRouteRequestWidget(params: ChalinRouteToolParams): string {
  const steps = proposedWidgetSteps(params);
  const agents = steps.map((step) => step.agent).filter(Boolean);
  return [
    `chalin_route · delegating · ${params.topology ?? "auto"}`,
    `task: ${shortText(params.task, 15, 80)}`,
    agents.length ? `agents: ${compactAgentPath(agents)}` : "agents: auto",
  ].join("\n");
}

export function formatChalinRunWidget(run: RunState): string {
  return formatChalinRunWidgetFromDetails(chalinRouteUpdateDetails(run));
}

export function formatChalinRunWidgetFromDetails(details: ChalinRouteWidgetDetails): string {
  const run = details.run;
  if (!run) return "chalin · pending";
  const visibleItems = visibleWorkItems(run);
  const countItems = flattenWorkItems(visibleItems);
  const total = countItems.length || 1;
  const completed = countItems.length
    ? countItems.filter((item) => isFinishedItemStatus(item.status)).length
    : run.status === "complete" || run.status === "stale-repaired"
      ? 1
      : 0;
  const displayStatus = statusLabel(run.status);
  const active = activeWidgetStep(run.status, run.steps);
  const mission = shortText(run.rootTask ?? details.route?.reason ?? active?.task ?? "", 10, 80);
  return [
    `chalin · ${displayStatus} · ${completed}/${total}${mission ? ` · ${mission}` : ""}`,
    ...visibleItems.slice(0, 8).flatMap((item, index) => formatWorkItemTree(item, index, visibleItems.length)),
    visibleItems.length > 8 ? `└ … +${visibleItems.length - 8} more` : undefined,
  ].filter((line): line is string => Boolean(line)).join("\n");
}

function activeWidgetStep(runStatus: RunStatus, steps: ChalinRouteWidgetStep[]): ChalinRouteWidgetStep | undefined {
  if (runStatus === "failed") return steps.find((step) => step.status === "failed");
  if (runStatus === "paused") return steps.find((step) => step.status === "paused") ?? steps.find((step) => isCheckpointStepStatus(step.status));
  if (runStatus === "running" || runStatus === "pending") {
    return steps.find((step) => step.status === "running") ?? steps.find((step) => step.status === "pending");
  }
  return undefined;
}

export function plannedWidgetRun(route: RouteDecision): ChalinRouteWidgetDetails["run"] {
  return {
    id: "planned",
    status: "pending",
    steps: route.plan ? plannedStepsFromRoute(route).map((step) => ({ ...step, status: "pending" })) : [],
    warnings: [],
  };
}

export function chalinRouteUpdateDetails(run: RunState): ChalinRouteWidgetDetails {
  return {
    route: run.route,
    run: {
      id: run.id,
      rootTask: run.rootTask,
      status: run.status,
      metrics: run.metrics,
      warnings: run.warnings,
      recoveryState: run.recoveryState,
      workUnits: run.workUnits,
      steps: run.steps.map((step) => ({
        id: step.id,
        agent: step.agent,
        task: step.task,
        status: step.status,
        pauseReason: step.pauseReason,
        skipReason: step.skipReason,
        workUnitId: step.workUnitId,
        checkpoint: step.checkpoint,
        model: step.model,
        thinkingLevel: step.thinkingLevel,
        skills: step.activeSkills?.map((item) => item.skill.name),
        error: step.error,
        handoff: shortText(step.output?.handoff || step.output?.text || "", 45, 180),
        nestedRuns: step.nestedRuns,
      })),
    },
  };
}

type VisibleWorkItem = {
  id: string;
  title: string;
  agent: string;
  status: RunStepStatus;
  step?: ChalinRouteWidgetStep;
  unit?: WorkUnit;
  children?: VisibleWorkItem[];
  counted?: boolean;
};

function plannedStepsFromRoute(route: RouteDecision): ChalinRouteWidgetStep[] {
  const plan = route.plan;
  if (!plan) return [];
  if (plan.kind === "sequential") return plan.steps;
  return plan.stages.flatMap((stage) => stage.tasks.map((step) => ({ ...step, id: `${stage.id}:${step.id ?? step.agent}` })));
}

function plannedWidgetSteps(params: ChalinRouteToolParams): ChalinRouteWidgetStep[] {
  const topology = normalizeWidgetTopology(params.topology);
  if (topology === "sequential") return params.steps ?? [];
  if (topology === "dag") return params.stages?.flatMap((stage) => (stage.tasks ?? []).map((step) => ({ ...step, id: `${stage.id ?? "stage"}:${step.id ?? step.agent}` }))) ?? [];
  return [];
}

function proposedWidgetSteps(params: ChalinRouteToolParams): ChalinRouteWidgetStep[] {
  if (params.stages?.length) return params.stages.flatMap((stage) => (stage.tasks ?? []).map((step) => ({ ...step, id: `${stage.id ?? "stage"}:${step.id ?? step.agent}` })));
  return params.steps ?? [];
}

function visibleWorkItems(run: NonNullable<ChalinRouteWidgetDetails["run"]>): VisibleWorkItem[] {
  const items = run.workUnits?.length ? visibleItemsFromUnits(run.workUnits, run.steps, true) : visibleItemsFromSteps(run.steps, true);
  return withUniqueDisplayIds(items);
}

function visibleItemsFromUnits(units: WorkUnit[], steps: ChalinRouteWidgetStep[], includeNested: boolean): VisibleWorkItem[] {
  const items: VisibleWorkItem[] = [];
  const unitStepLookup = stepLookupByUnit(steps);
  for (const unit of units) {
    const step = selectRepresentativeStep(unit, stepsForUnit(unit, unitStepLookup, steps));
    items.push({
      id: displayId(unit.id),
      title: step?.task || unit.title || unit.id,
      agent: step?.agent ?? unit.kind,
      status: visibleStatus(unit.status, step),
      step,
      unit,
      children: includeNested ? nestedItemsFromStep(step) : [],
    });
  }
  return items;
}

function stepsForUnit(unit: WorkUnit, unitStepLookup: Map<string, ChalinRouteWidgetStep[]>, steps: ChalinRouteWidgetStep[]): ChalinRouteWidgetStep[] {
  const direct = unitStepLookup.get(unit.id) ?? [];
  const ids = new Set([unit.workerStepId, unit.reviewerStepId, unit.finalReviewerStepId, unit.sourceStepId].filter((id): id is string => Boolean(id)));
  if (ids.size === 0) return direct;
  const byReference = steps.filter((step) => typeof step.id === "string" && ids.has(step.id));
  if (byReference.length === 0) return direct;
  return [...direct, ...byReference.filter((step) => !direct.includes(step))];
}

function visibleItemsFromSteps(steps: ChalinRouteWidgetStep[], includeNested: boolean): VisibleWorkItem[] {
  const groups = new Map<string, ChalinRouteWidgetStep[]>();
  for (const step of steps) {
    const key = step.workUnitId ?? step.id ?? `${step.agent}:${groups.size + 1}`;
    const list = groups.get(key) ?? [];
    list.push(step);
    groups.set(key, list);
  }
  const items: VisibleWorkItem[] = [];
  for (const [key, group] of groups.entries()) {
    const step = selectRepresentativeStep(undefined, group);
    if (!step) continue;
    items.push({
      id: displayId(step.workUnitId ?? step.id ?? key),
      title: step.task ?? step.id ?? step.agent,
      agent: step.agent,
      status: step.status ?? "pending",
      step,
      counted: true,
      children: includeNested ? nestedItemsFromStep(step) : [],
    });
  }
  return items;
}

function nestedItemsFromStep(step: ChalinRouteWidgetStep | undefined): VisibleWorkItem[] {
  if (!step?.nestedRuns?.length) return [];
  const nestedItems = step.nestedRuns.flatMap((run) => {
    const runLike = {
      id: run.id,
      rootTask: run.rootTask,
      status: run.status,
      steps: run.steps,
      workUnits: run.workUnits,
    };
    return run.workUnits?.length
      ? visibleItemsFromUnits(run.workUnits, runLike.steps, false)
      : visibleItemsFromSteps(runLike.steps, false);
  });
  return withUniqueDisplayIds(markUncounted(nestedItems));
}

function stepLookupByUnit(steps: ChalinRouteWidgetStep[]): Map<string, ChalinRouteWidgetStep[]> {
  const lookup = new Map<string, ChalinRouteWidgetStep[]>();
  for (const step of steps) {
    if (!step.workUnitId) continue;
    const current = lookup.get(step.workUnitId) ?? [];
    current.push(step);
    lookup.set(step.workUnitId, current);
  }
  return lookup;
}

function selectRepresentativeStep(unit: WorkUnit | undefined, steps: ChalinRouteWidgetStep[]): ChalinRouteWidgetStep | undefined {
  const active = steps.find((step) => step.status === "running")
    ?? steps.find((step) => step.status === "pending")
    ?? steps.find((step) => step.status === "paused");
  if (active) return active;
  const preferredIds = [unit?.workerStepId, unit?.reviewerStepId, unit?.finalReviewerStepId].filter((id): id is string => Boolean(id));
  for (const id of preferredIds) {
    const found = steps.find((step) => step.id === id);
    if (found) return found;
  }
  return [...steps].reverse().find((step) => step.status !== "failed")
    ?? steps.at(-1);
}

function visibleStatus(unitStatus: RunStepStatus, step: ChalinRouteWidgetStep | undefined): RunStepStatus {
  if (step?.status === "running" || step?.status === "pending" || step?.status === "paused") return step.status;
  if (unitStatus === "pending" && step?.status && isFinishedItemStatus(step.status)) return step.status;
  if (unitStatus === "failed" && step && step.status !== "failed") return step.status ?? "running";
  return unitStatus;
}

function formatWorkItem(item: VisibleWorkItem, index: number, total: number): string {
  return `${treePrefix(index, total)} ${statusGlyph(item.status)} ${item.agent} - ${shortText(workItemTitle(item), 10, 80)}`;
}

function workItemTitle(item: VisibleWorkItem): string {
  if (item.step?.pauseReason === "awaiting-approval") return "awaiting approval";
  if (item.step?.pauseReason === "human-rejected") return "blocked by human rejection";
  return item.title;
}

function formatWorkItemTree(item: VisibleWorkItem, index: number, total: number): string[] {
  const children = item.children ?? [];
  return [
    formatWorkItem(item, index, total),
    ...children.slice(0, 8).flatMap((child, childIndex) => formatWorkItemSubtree(child, childIndex, children.length, "   ")),
    children.length > 8 ? `   └ … +${children.length - 8} more` : undefined,
  ].filter((line): line is string => Boolean(line));
}

function formatWorkItemSubtree(item: VisibleWorkItem, index: number, total: number, indent: string): string[] {
  const children = item.children ?? [];
  return [
    `${indent}${formatWorkItem(item, index, total)}`,
    ...children.slice(0, 8).flatMap((child, childIndex) => formatWorkItemSubtree(child, childIndex, children.length, `${indent}   `)),
    children.length > 8 ? `${indent}   └ … +${children.length - 8} more` : undefined,
  ].filter((line): line is string => Boolean(line));
}

function withUniqueDisplayIds(items: VisibleWorkItem[]): VisibleWorkItem[] {
  const counts = new Map<string, number>();
  return items.map((item) => uniqueDisplayItem(item, counts));
}

function uniqueDisplayItem(item: VisibleWorkItem, counts: Map<string, number>): VisibleWorkItem {
  const count = (counts.get(item.id) ?? 0) + 1;
  counts.set(item.id, count);
  const normalized = count === 1 ? item : { ...item, id: `${item.id}-${count}` };
  return normalized.children?.length
    ? { ...normalized, children: normalized.children.map((child) => uniqueDisplayItem(child, counts)) }
    : normalized;
}

function flattenWorkItems(items: VisibleWorkItem[]): VisibleWorkItem[] {
  return items.flatMap((item) => [
    ...(item.counted === false ? [] : [item]),
    ...flattenWorkItems(item.children ?? []),
  ]);
}

function markUncounted(items: VisibleWorkItem[]): VisibleWorkItem[] {
  return items.map((item) => ({
    ...item,
    counted: false,
    children: markUncounted(item.children ?? []),
  }));
}

function statusGlyph(status: RunStepStatus | undefined): string {
  if (status === "complete" || isCheckpointStepStatus(status)) return "✓";
  if (status === "running") return "◆";
  if (status === "failed") return "×";
  if (status === "paused") return "■";
  if (status === "skipped") return "○";
  return "○";
}

function statusLabel(status: RunStatus | RunStepStatus): string {
  if (status === "complete") return "done";
  if (status === "stale-repaired") return "done";
  if (status === "failed") return "failed";
  if (status === "paused") return "paused";
  if (status === "skipped") return "skipped";
  if (isCheckpointStepStatus(status)) return "done";
  if (status === "running") return "running";
  return "pending";
}

function treePrefix(index: number, total: number): string {
  return index === total - 1 ? "└" : "├";
}

function routeTitle(topology: ChalinRouteToolParams["topology"], task: string): string {
  return `${topology ?? "auto"} · ${shortText(task, 15, 52)}`;
}

function normalizeWidgetTopology(topology: ChalinRouteToolParams["topology"]): "auto" | "sequential" | "dag" | undefined {
  if (topology === "chain") return "sequential";
  if (topology === "parallel") return "dag";
  return topology;
}

function compactAgentPath(agents: string[]): string {
  const compact = agents.slice(0, 5).join(" → ");
  return agents.length > 5 ? `${compact} → +${agents.length - 5}` : compact;
}

export function colorizeChalinWidget(text: string, theme: { fg(scope: string, value: string): string; bold(value: string): string }): string {
  return text.split("\n").map((line, index) => {
    if (index === 0) return theme.fg("toolTitle", theme.bold(line));
    if (line.includes("✓") || line.includes("done")) return theme.fg("success", line);
    if (line.includes("×") || line.includes("failed")) return theme.fg("error", line);
    if (line.includes("pending") || line.includes("skipped")) return theme.fg("warning", line);
    if (line.includes("◆")) return theme.fg("accent", line);
    return theme.fg("dim", line);
  }).join("\n");
}

export function footerStateForRun(run: RunState): ChalinFooterState {
  const active = run.steps.find((step) => step.status === "running") ?? run.steps.find((step) => step.status === "pending");
  const completed = run.steps.filter((step) => isUsableStepStatus(step.status)).length;
  const total = run.steps.length || 1;
  if (run.status === "complete") return { kind: "complete", intent: routeIntent(run.route) };
  if (run.status === "paused") return { kind: "stopped" };
  if (run.status === "failed") return { kind: "failed" };
  return { kind: "running", intent: routeIntent(run.route), agent: active?.agent ?? run.route.agents[0] ?? run.status, completed, total };
}

export function routeIntent(route: RouteDecision): string {
  return route.agents[0] ?? route.kind;
}

function isFinishedItemStatus(status: RunStepStatus): boolean {
  return status === "complete" || status === "checkpointed" || status === "failed" || status === "skipped";
}

function displayId(id: string): string {
  const normalized = normalizeId(id);
  return normalized || "work-unit";
}

function normalizeId(value: string): string {
  let result = "";
  let lastWasDash = false;
  for (const char of compactWhitespace(value).toLocaleLowerCase()) {
    const code = char.charCodeAt(0);
    const isDigit = code >= 48 && code <= 57;
    const isAsciiLetter = code >= 97 && code <= 122;
    const isUnicodeLetter = char.toLocaleLowerCase() !== char.toLocaleUpperCase();
    const isLetter = isAsciiLetter || isUnicodeLetter;
    if (isDigit || isLetter) {
      result += char;
      lastWasDash = false;
      continue;
    }
    if (!lastWasDash && result.length > 0) {
      result += "-";
      lastWasDash = true;
    }
  }
  while (result.endsWith("-")) result = result.slice(0, -1);
  return result;
}

function shortText(text: string | undefined, maxWords = 15, maxChars = 64): string {
  const normalized = compactWhitespace(stripInlineMarkup(text || "working"));
  if (normalized.length <= maxChars && wordCount(normalized) <= maxWords) return normalized;
  const byWords = firstWords(normalized, maxWords);
  const bounded = byWords.length <= maxChars ? byWords : trimToWordBoundary(byWords, maxChars);
  return `${bounded}...`;
}

function stripInlineMarkup(text: string): string {
  let result = "";
  for (const char of text) {
    if (char === "`" || char === "*" || char === "_") continue;
    result += char;
  }
  return result;
}

function compactWhitespace(text: string): string {
  let result = "";
  let pendingSpace = false;
  for (const char of text.trim()) {
    if (char === " " || char === "\n" || char === "\t" || char === "\r") {
      pendingSpace = result.length > 0;
      continue;
    }
    if (pendingSpace) result += " ";
    result += char;
    pendingSpace = false;
  }
  return result;
}

function wordCount(text: string): number {
  if (!text) return 0;
  let count = 0;
  let inWord = false;
  for (const char of text) {
    const isSpace = char === " " || char === "\n" || char === "\t" || char === "\r";
    if (isSpace) {
      inWord = false;
      continue;
    }
    if (!inWord) count += 1;
    inWord = true;
  }
  return count;
}

function firstWords(text: string, maxWords: number): string {
  const words: string[] = [];
  let current = "";
  for (const char of text) {
    const isSpace = char === " " || char === "\n" || char === "\t" || char === "\r";
    if (isSpace) {
      if (current) {
        words.push(current);
        if (words.length >= maxWords) break;
        current = "";
      }
      continue;
    }
    current += char;
  }
  if (current && words.length < maxWords) words.push(current);
  return words.join(" ");
}

function trimToWordBoundary(text: string, maxChars: number): string {
  const clipped = text.slice(0, Math.max(0, maxChars)).trimEnd();
  let lastSpace = -1;
  for (let index = 0; index < clipped.length; index += 1) {
    if (clipped[index] === " ") lastSpace = index;
  }
  return lastSpace > 0 ? clipped.slice(0, lastSpace) : clipped;
}
