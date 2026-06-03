import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { mergedSessionModelOverrides, mergedSessionThinkingOverrides } from "../agents/agent-overrides.ts";
import { AgentCatalog } from "../agents/agents.ts";
import { loadEffectiveConfig } from "../config/config.ts";
import type { RouteExpectedEffect, RouteRisk, RouteWorkUnitStrategy } from "../domain/schemas.ts";
import { ChalinKernel, routeFromPlan, type ChalinHandleResult } from "../kernel/kernel.ts";
import { createConfiguredMemoryStore } from "../memory/memory-provider.ts";
import { beginChalinRouteInvocation, finishChalinRouteInvocation, setLatestRun } from "../runtime/state.ts";
import { setChalinStatus } from "../ui/ui-status.ts";
import { openSafetyApproval } from "../ui/ui.ts";
import { collapseReadOnlyScoutContextRoute, inferRouteRequiresWorkspaceMutation, normalizeRouteForExecution } from "./route-guards.ts";
import { chalinRouteUpdateDetails, formatChalinRunWidget } from "./route-widget.ts";

export type ChalinDelegationStep = {
  id?: string;
  agent: string;
  task: string;
  budget?: "tight" | "normal" | "deep" | "extended";
  files?: string[];
};

export type ChalinDelegationRouteParams = {
  task: string;
  topology: "sequential" | "dag";
  steps?: ChalinDelegationStep[];
  stages?: Array<{ id?: string; name?: string; tasks?: ChalinDelegationStep[] }>;
  risk?: RouteRisk;
  needsMemory?: boolean;
  needsArtifacts?: boolean;
  expectedEffects: RouteExpectedEffect[];
  workUnitStrategy?: RouteWorkUnitStrategy;
  fanoutAuthorized?: boolean;
  requiresWorkspaceMutation?: boolean;
  reason?: string;
};

type DelegationToolUpdate = {
  content: Array<{ type: "text"; text: string }>;
  details: unknown;
};

export async function executeDelegatedChalinRoute(
  params: ChalinDelegationRouteParams,
  prompt: string,
  ctx: ExtensionContext,
  options: { signal?: AbortSignal; onUpdate?: (update: DelegationToolUpdate) => void } = {},
): Promise<ChalinHandleResult> {
  const loaded = loadEffectiveConfig({ cwd: ctx.cwd });
  const catalog = AgentCatalog.load({ cwd: ctx.cwd });
  const memory = createConfiguredMemoryStore({ cwd: ctx.cwd }, loaded.config);
  const kernel = new ChalinKernel({
    cwd: ctx.cwd,
    config: loaded.config,
    catalog,
    memory,
    modelOverrides: mergedSessionModelOverrides(loaded.config.agents.modelOverrides),
    thinkingOverrides: mergedSessionThinkingOverrides(loaded.config.agents.thinkingOverrides),
  });

  let route = routeFromPlan(params);
  const requiresWorkspaceMutation = route.expectedEffects?.includes("write") === true
    || Boolean(params.requiresWorkspaceMutation)
    || inferRouteRequiresWorkspaceMutation(route, params.task);
  route = loaded.config.safety.mutationExpectationGuard
    ? normalizeRouteForExecution(route, { requiresWorkspaceMutation, task: params.task, agents: kernel.resolvePlanAgents(route) })
    : collapseReadOnlyScoutContextRoute(route, requiresWorkspaceMutation);

  const guard = beginChalinRouteInvocation({ dryRun: false, route });
  const preApproval = await kernel.approvalFor(route);
  const approvalOverride = preApproval.action === "ask" && await openSafetyApproval(ctx, route, preApproval)
    ? { action: "allow" as const, reason: "Approved once through Safety Approval." }
    : undefined;
  const effectiveApproval = approvalOverride ?? preApproval;

  if (!guard.allowed) {
    return {
      route,
      approval: { action: "block", reason: guard.reason ?? "A delegated pi-chalin workflow already ran for this prompt." },
      memories: [],
      diagnostics: [],
    };
  }

  if (preApproval.action === "block" || (preApproval.action === "ask" && !approvalOverride)) {
    finishChalinRouteInvocation(guard.invocationId, preApproval.action);
    setChalinStatus(ctx, preApproval.action === "block" ? { kind: "failed" } : { kind: "stopped" });
    return { route, approval: preApproval, memories: [], diagnostics: [] };
  }

  setChalinStatus(ctx, route.plan
    ? { kind: "running", intent: route.agents.join(" -> ") || route.kind, agent: route.agents[0] ?? route.kind, completed: 0, total: Math.max(route.agents.length, 1) }
    : { kind: "synthesizing" });

  try {
    const result = await kernel.handleRoute(route, prompt, {
      cwd: ctx.cwd,
      extensionContext: ctx,
      signal: options.signal ?? ctx.signal,
      onUpdate: (updated) => {
        setLatestRun(updated);
        setChalinStatus(ctx, {
          kind: "running",
          intent: updated.route.agents.join(" -> ") || updated.route.kind,
          agent: updated.steps.find((step) => step.status === "running")?.agent ?? updated.route.agents[0] ?? updated.route.kind,
          completed: updated.steps.filter((step) => step.status === "complete" || step.status === "checkpointed").length,
          total: Math.max(updated.steps.length, 1),
        });
        options.onUpdate?.({
          content: [{ type: "text", text: formatChalinRunWidget(updated) }],
          details: chalinRouteUpdateDetails(updated),
        });
      },
    }, effectiveApproval);
    setLatestRun(result.run);
    finishChalinRouteInvocation(guard.invocationId, result.run?.status === "complete" ? "complete" : result.run?.status === "paused" ? "paused" : result.run?.status === "failed" ? "failed" : "complete");
    setChalinStatus(ctx, result.run?.status === "complete" ? { kind: "complete" } : result.run?.status === "failed" ? { kind: "failed" } : { kind: "idle" });
    return result;
  } catch (error) {
    finishChalinRouteInvocation(guard.invocationId, options.signal?.aborted || ctx.signal?.aborted ? "paused" : "failed");
    setChalinStatus(ctx, options.signal?.aborted || ctx.signal?.aborted ? { kind: "stopped" } : { kind: "failed" });
    throw error;
  }
}
