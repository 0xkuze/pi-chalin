import type { ChalinFooterState } from "../ui/ui-status.ts";
import type { BudgetCapHit, CheckpointInfo, RouteDecision, RunState, RunStatus, RunStepStatus } from "../domain/schemas.ts";
import { checkpointLabel, isCheckpointStepStatus, isUsableStepStatus as isUsableCheckpointStepStatus } from "../runtime/status.ts";

type ChalinRouteWidgetStep = {
  id?: string;
  agent: string;
  task?: string;
  status?: RunStepStatus;
  checkpoint?: CheckpointInfo;
  model?: string;
  thinkingLevel?: string;
  skills?: string[];
  error?: string;
  skipReason?: string;
  workUnitId?: string;
  handoff?: string;
};

export type ChalinRouteWidgetDetails = {
  route?: RouteDecision;
  run?: {
    id: string;
    status: RunStatus;
    steps: ChalinRouteWidgetStep[];
    metrics?: RunState["metrics"];
    warnings?: string[];
    recoveryState?: RunState["recoveryState"];
  };
};

type ChalinRouteToolParams = {
  task: string;
  topology: "sequential" | "dag";
  steps?: Array<{ id?: string; agent: string; task: string; budget?: "tight" | "normal" | "deep" | "extended" }>;
  stages?: Array<{ id?: string; name?: string; tasks?: Array<{ id?: string; agent: string; task: string; budget?: "tight" | "normal" | "deep" | "extended" }> }>;
};

export function formatChalinRoutePlanWidget(params: ChalinRouteToolParams): string {
  const steps = plannedWidgetSteps(params);
  const title = routeTitle(params.topology, params.task);
  const agents = steps.map((step) => step.agent).filter(Boolean);
  return [
    `pi-chalin · ${title}`,
    agents.length ? `agents: ${compactAgentPath(agents)} · 0/${steps.length || 1}` : "agents: memory · 0/1",
    ...steps.slice(0, 8).map((step, index) => `${treePrefix(index, steps.length)} ${statusGlyph(step.status ?? "pending")} ${step.agent} — ${taskTitle(step.task)}`),
    steps.length > 8 ? `└ … +${steps.length - 8} more` : undefined,
  ].filter((line): line is string => Boolean(line)).join("\n");
}

export function formatChalinRunWidget(run: RunState): string {
  return formatChalinRunWidgetFromDetails(chalinRouteUpdateDetails(run));
}

export function formatChalinRunWidgetFromDetails(details: ChalinRouteWidgetDetails): string {
  const run = details.run;
  if (!run) return "pi-chalin · no run";
  const route = details.route;
  const steps = run.steps;
  const completed = steps.filter((step) => isUsableStepStatus(step.status)).length;
  const active = activeWidgetStep(run.status, steps);
  const title = route ? routeIntent(route) : "workflow";
  const displayStatus = statusLabel(run.status);
  const activeLabel = run.status === "failed" ? "blocked" : run.status === "paused" ? "paused" : "current";
  return [
    `pi-chalin · ${title} · ${displayStatus} · ${completed}/${steps.length || 1}`,
    active ? `${activeLabel}: ${active.agent} — ${active.error ? truncate(active.error, 86) : taskTitle(active.task ?? statusLabel(active.status ?? "pending"))}` : undefined,
    ...steps.slice(0, 8).map((step, index) => formatWidgetStep(step, index, steps.length, run.status)),
    steps.length > 8 ? `└ … +${steps.length - 8} more` : undefined,
    run.recoveryState?.failedStepId ? `recovery: failed ${run.recoveryState.failedStepId} · skipped reviewers: ${run.recoveryState.reviewersNotRun.length}` : undefined,
    formatWidgetGuards(run.metrics),
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
      status: run.status,
      metrics: run.metrics,
      warnings: run.warnings,
      recoveryState: run.recoveryState,
      steps: run.steps.map((step) => ({
        id: step.id,
        agent: step.agent,
        task: step.task,
        status: step.status,
        skipReason: step.skipReason,
        workUnitId: step.workUnitId,
        checkpoint: step.checkpoint,
        model: step.model,
        thinkingLevel: step.thinkingLevel,
        skills: step.activeSkills?.map((item) => item.skill.name),
        error: step.error,
        handoff: truncate(step.output?.handoff || step.output?.text || "", 180),
      })),
    },
  };
}

function plannedStepsFromRoute(route: RouteDecision): ChalinRouteWidgetStep[] {
  const plan = route.plan;
  if (!plan) return [];
  if (plan.kind === "sequential") return plan.steps;
  return plan.stages.flatMap((stage) => stage.tasks.map((step) => ({ ...step, id: `${stage.id}:${step.id ?? step.agent}` })));
}

function plannedWidgetSteps(params: ChalinRouteToolParams): ChalinRouteWidgetStep[] {
  if (params.topology === "sequential") return params.steps ?? [];
  if (params.topology === "dag") return params.stages?.flatMap((stage) => (stage.tasks ?? []).map((step) => ({ ...step, id: `${stage.id ?? "stage"}:${step.id ?? step.agent}` }))) ?? [];
  return [];
}

function formatWidgetStep(step: ChalinRouteWidgetStep, index: number, total: number, runStatus?: RunStatus): string {
  const detail = step.status === "complete"
    ? taskTitle(step.task ?? "done")
    : step.status === "failed"
      ? step.error || "failed"
    : step.status === "paused"
      ? step.error || "paused"
    : step.status === "skipped"
      ? step.skipReason || "skipped after upstream failure"
      : isCheckpointStepStatus(step.status)
          ? taskTitle(step.task ?? step.error ?? "checkpoint saved")
          : step.status === "pending" && runStatus === "failed"
            ? "skipped after failure"
          : step.status === "pending" && runStatus === "paused"
            ? "waiting for resume"
          : taskTitle(step.task ?? "working");
  const suffix = isCheckpointStepStatus(step.status) ? ` · ${checkpointLabel(step.checkpoint).replace(/^checkpointed · /, "")}` : "";
  const skills = step.skills?.length ? ` · skills:${step.skills.join(",")}` : "";
  const unit = step.workUnitId ? ` · ${step.workUnitId}` : "";
  return `${treePrefix(index, total)} ${statusGlyph(step.status)} ${step.agent}${skills}${unit} — ${truncate(detail, 88)}${suffix}`;
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
  if (status === "failed") return "failed";
  if (status === "paused") return "paused";
  if (status === "skipped") return "skipped";
  if (isCheckpointStepStatus(status)) return "checkpointed";
  if (status === "running") return "running";
  return "pending";
}

export function isUsableStepStatus(status: RunStepStatus | undefined): boolean {
  return isUsableCheckpointStepStatus(status);
}

function treePrefix(index: number, total: number): string {
  return index === total - 1 ? "└" : "├";
}

function routeTitle(topology: ChalinRouteToolParams["topology"], task: string): string {
  return `${topology} · ${truncate(task, 52)}`;
}

function compactAgentPath(agents: string[]): string {
  const compact = agents.slice(0, 5).join(" → ");
  return agents.length > 5 ? `${compact} → +${agents.length - 5}` : compact;
}

export function colorizeChalinWidget(text: string, theme: { fg(scope: string, value: string): string; bold(value: string): string }): string {
  return text.split("\n").map((line, index) => {
    if (index === 0) return theme.fg("toolTitle", theme.bold(line));
    if (/current:/.test(line)) return theme.fg("muted", line);
    if (/✓/.test(line)) return theme.fg("success", line);
    if (/×|failed|attention/.test(line)) return theme.fg("error", line);
    if (/budget: (warning|stopped|limit reached)|inefficient/.test(line)) return theme.fg("warning", line);
    if (/◆/.test(line)) return theme.fg("accent", line);
    return theme.fg("dim", line);
  }).join("\n");
}

function formatWidgetGuards(metrics: RunState["metrics"] | undefined): string {
  if (!metrics) return "tools: 0 · guards: checking";
  const policyViolations = metrics.policyViolations?.length ?? 0;
  const budgetStops = metrics.budgetStopCount ?? 0;
  const budgetHits = metrics.budgetCapHits ?? [];
  const crossStepDuplicates = metrics.crossStepDuplicateReadCount ?? 0;
  if (policyViolations > 0) return `tools: ${metrics.toolCalls} · guards: attention · ${policyViolations} policy`;
  if (budgetStops > 0) return `tools: ${metrics.toolCalls} · guards: attention · budget: limit reached ${formatBudgetHit(budgetHits.find((hit) => hit.severity === "hard") ?? budgetHits[0])} (${budgetStops} stops)`;
  if (crossStepDuplicates > 0) return `tools: ${metrics.toolCalls} · guards: inefficient · cross-step duplicate reads: ${crossStepDuplicates}`;
  if (budgetHits.some((hit) => hit.severity === "soft")) return `tools: ${metrics.toolCalls} · guards: ok · budget: warning ${formatBudgetHit(budgetHits.find((hit) => hit.severity === "soft"))}`;
  return `tools: ${metrics.toolCalls} · guards: ok`;
}

function formatBudgetHit(hit: BudgetCapHit | undefined): string {
  if (!hit) return "unknown cap";
  return `${hit.name} ${formatCompactNumber(hit.used)}/${formatCompactNumber(hit.limit)}${hit.toolName ? ` via ${hit.toolName}` : ""}`;
}

function formatCompactNumber(value: number): string {
  if (!Number.isFinite(value)) return "∞";
  if (Math.abs(value) >= 1_000_000) return `${Math.round(value / 100_000) / 10}M`;
  if (Math.abs(value) >= 1_000) return `${Math.round(value / 100) / 10}k`;
  return String(Math.round(value * 1000) / 1000);
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
  if (route.agents.includes("worker")) return "implement safely";
  if (route.agents.includes("reviewer")) return "review";
  if (route.agents.includes("context-builder")) return "understand";
  if (route.agents.includes("planner")) return "plan";
  return route.agents[0] ?? route.kind;
}
function truncate(text: string, max: number): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  return normalized.length <= max ? normalized : `${normalized.slice(0, max - 1)}…`;
}

function taskTitle(task: string | undefined, max = 64): string {
  const normalized = (task || "working")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/[*_#>]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  const [firstClause = normalized] = normalized.split(/\s*(?:[.;:]\s+|\s+-\s+|\s+—\s+|\s+and\s+|\s+y\s+|\s+para\s+|\s+to\s+|\s+include\b|\s+including\b|\s+incluye\b|\s+identificar\b|\s+identify\b|\s+con\s+|\s+with\s+)/i);
  return truncate(firstClause || normalized || "working", max);
}
