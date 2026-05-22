import type { ChalinFooterState } from "./ui-status.ts";
import type { RouteDecision, RunState, RunStatus } from "./schemas.ts";

type ChalinRouteWidgetStep = {
  id?: string;
  agent: string;
  task?: string;
  status?: RunStatus;
  model?: string;
  thinkingLevel?: string;
  error?: string;
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
  };
};

type ChalinRouteToolParams = {
  task: string;
  topology: "single" | "chain" | "parallel" | "dag" | "memory-only";
  steps?: Array<{ id?: string; agent: string; task: string; budget?: "tight" | "normal" | "deep" | "extended" }>;
  stages?: Array<{ id?: string; name?: string; tasks: Array<{ id?: string; agent: string; task: string; budget?: "tight" | "normal" | "deep" | "extended" }> }>;
};

export function formatChalinRoutePlanWidget(params: ChalinRouteToolParams): string {
  const steps = plannedWidgetSteps(params);
  const title = routeTitle(params.topology, params.task);
  const agents = steps.map((step) => step.agent).filter(Boolean);
  return [
    `pi-chalin · ${title}`,
    agents.length ? `agents: ${compactAgentPath(agents)} · 0/${steps.length || 1}` : "agents: memory · 0/1",
    ...steps.slice(0, 8).map((step, index) => `${treePrefix(index, steps.length)} ${statusGlyph(step.status ?? "pending")} ${step.agent} — ${truncate(step.task ?? "waiting", 76)}`),
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
  const displayStatus = run.status === "budget-capped" && completed === (steps.length || 1) ? "done" : statusLabel(run.status);
  const activeLabel = run.status === "failed" ? "blocked" : "current";
  return [
    `pi-chalin · ${title} · ${displayStatus} · ${completed}/${steps.length || 1}`,
    active ? `${activeLabel}: ${active.agent} — ${truncate(active.error ?? active.task ?? statusLabel(active.status ?? "pending"), 86)}` : undefined,
    ...steps.slice(0, 8).map((step, index) => formatWidgetStep(step, index, steps.length, run.status)),
    steps.length > 8 ? `└ … +${steps.length - 8} more` : undefined,
    formatWidgetGuards(run.metrics),
  ].filter((line): line is string => Boolean(line)).join("\n");
}

function activeWidgetStep(runStatus: RunStatus, steps: ChalinRouteWidgetStep[]): ChalinRouteWidgetStep | undefined {
  if (runStatus === "failed") return steps.find((step) => step.status === "failed");
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
      steps: run.steps.map((step) => ({
        id: step.id,
        agent: step.agent,
        task: step.task,
        status: step.status,
        model: step.model,
        thinkingLevel: step.thinkingLevel,
        error: step.error,
        handoff: truncate(step.output?.handoff || step.output?.text || "", 180),
      })),
    },
  };
}

function plannedStepsFromRoute(route: RouteDecision): ChalinRouteWidgetStep[] {
  const plan = route.plan;
  if (!plan) return [];
  if (plan.kind === "single") return [{ agent: plan.agent, task: plan.task }];
  if (plan.kind === "chain") return plan.steps;
  if (plan.kind === "parallel") return plan.tasks;
  return plan.stages.flatMap((stage) => stage.tasks.map((step) => ({ ...step, id: `${stage.id}:${step.id ?? step.agent}` })));
}

function plannedWidgetSteps(params: ChalinRouteToolParams): ChalinRouteWidgetStep[] {
  if (params.topology === "single") {
    const first = params.steps?.[0];
    return first ? [first] : [];
  }
  if (params.topology === "chain" || params.topology === "parallel") return params.steps ?? [];
  if (params.topology === "dag") return params.stages?.flatMap((stage) => stage.tasks.map((step) => ({ ...step, id: `${stage.id ?? "stage"}:${step.id ?? step.agent}` }))) ?? [];
  return [{ agent: "memory", task: params.task, status: "pending" }];
}

function formatWidgetStep(step: ChalinRouteWidgetStep, index: number, total: number, runStatus?: RunStatus): string {
  const detail = step.status === "complete"
    ? step.handoff || "done"
    : step.status === "failed"
      ? step.error || "failed"
      : step.status === "paused"
        ? step.error || "paused"
        : step.status === "budget-capped"
          ? step.handoff || step.error || step.task || "checkpoint saved"
          : step.status === "pending" && runStatus === "failed"
            ? "skipped after failure"
          : step.task || "working";
  const suffix = step.status === "budget-capped" ? " · budget limit reached" : "";
  return `${treePrefix(index, total)} ${statusGlyph(step.status)} ${step.agent} — ${truncate(detail, 88)}${suffix}`;
}

function statusGlyph(status: RunStatus | undefined): string {
  if (status === "complete" || status === "budget-capped") return "✓";
  if (status === "running") return "◆";
  if (status === "failed") return "×";
  if (status === "paused") return "■";
  return "○";
}

function statusLabel(status: RunStatus): string {
  if (status === "complete") return "done";
  if (status === "failed") return "failed";
  if (status === "paused") return "paused";
  if (status === "budget-capped") return "checkpointed";
  if (status === "running") return "running";
  return "pending";
}

export function isUsableStepStatus(status: RunStatus | undefined): boolean {
  return status === "complete" || status === "budget-capped";
}

function treePrefix(index: number, total: number): string {
  return index === total - 1 ? "└" : "├";
}

function routeTitle(topology: ChalinRouteToolParams["topology"], task: string): string {
  if (topology === "memory-only") return "memory lookup";
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
    if (/budget: limit reached/.test(line)) return theme.fg("warning", line);
    if (/◆/.test(line)) return theme.fg("accent", line);
    return theme.fg("dim", line);
  }).join("\n");
}

function formatWidgetGuards(metrics: RunState["metrics"] | undefined): string {
  if (!metrics) return "tools: 0 · guards: checking";
  const policyViolations = metrics.policyViolations?.length ?? 0;
  const budgetStops = metrics.budgetStopCount ?? 0;
  if (policyViolations > 0) return `tools: ${metrics.toolCalls} · guards: attention · ${policyViolations} policy`;
  if (budgetStops > 0) return `tools: ${metrics.toolCalls} · guards: ok · budget: limit reached (${budgetStops} stops)`;
  return `tools: ${metrics.toolCalls} · guards: ok`;
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
  if (route.kind === "memory-only") return "memory lookup";
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
