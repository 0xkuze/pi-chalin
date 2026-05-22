import type { ChalinHandleResult } from "./kernel.ts";
import type { ChalinRouteOutcome } from "./runtime-state.ts";
import type { RouteDecision, RunState } from "./schemas.ts";

export function formatRoute(route: RouteDecision, result: ChalinHandleResult | undefined, options: { availableAgents?: string[] } = {}): string {
  if (!result) {
    return [
      `Chalin workflow: ${route.kind}`,
      `Agents: ${route.agents.join(" → ") || "none"}`,
      `Risk: ${route.risk}`,
      `Reason: ${route.reason}`,
      options.availableAgents ? `\nAvailable agents: ${options.availableAgents.join(", ") || "none"}` : undefined,
    ].filter((line): line is string => line !== undefined).join("\n");
  }

  const finalMaterial = finalAnswerMaterial(result.run);
  const memoryMaterial = !finalMaterial && result.memories.length > 0 ? formatMemoryMaterial(result.memories) : undefined;
  const supportingFindings = supportingAgentFindings(result.run);
  const lines = [
    `pi-chalin completed: ${route.agents.join(" → ") || route.kind}`,
    `status: ${result.run?.status ?? result.approval.action}`,
    result.approval.action === "allow"
      ? "Instruction for the primary Pi agent: answer the user now from the Final answer material below. Do not call more tools unless it explicitly says a critical gap remains."
      : "Instruction for the primary Pi agent: pi-chalin did not execute because approval is required. Do not claim completion. If this is a safe explicit user-requested edit, continue directly with native tools; otherwise explain that approval is required.",
    result.approval.action !== "allow" ? `Approval: ${result.approval.action} — ${result.approval.reason}` : undefined,
    result.memories.length > 0 ? `Memory used: ${result.memories.length}` : undefined,
    finalMaterial ? "\nFinal answer material:" : undefined,
    finalMaterial,
    memoryMaterial ? "\nMemory material:" : undefined,
    memoryMaterial,
    supportingFindings ? "\nSupporting findings:" : undefined,
    supportingFindings,
    !finalMaterial && result.run ? "\nSubagent handoff:" : undefined,
    !finalMaterial && result.run ? result.run.steps.map(formatStep).join("\n") : undefined,
    options.availableAgents ? `\nAvailable agents: ${options.availableAgents.join(", ") || "none"}` : undefined,
  ];
  return lines.filter((line): line is string => line !== undefined && line.length > 0).join("\n");
}

function formatMemoryMaterial(memories: ChalinHandleResult["memories"]): string {
  return memories
    .slice(0, 8)
    .map((memory) => `- ${memory.category} · ${memory.sourceAgent} · ${memory.content}`)
    .join("\n");
}

export function finalAnswerMaterial(run: RunState | undefined): string | undefined {
  if (!run) return undefined;
  const completeSteps = run.steps.filter((step) => isUsableStepStatus(step.status));
  if (shouldAggregateFinalMaterial(run, completeSteps)) {
    const material = completeSteps
      .map((step) => {
        const output = stepFullOutput(step);
        return output ? `## ${step.agent}\n${output}` : undefined;
      })
      .filter((item): item is string => Boolean(item))
      .join("\n\n");
    return material ? truncate(material, finalAnswerMaterialBudget(run)) : undefined;
  }
  const primary = completeSteps.at(-1) ?? run.steps.at(-1);
  const output = primary ? stepOutput(primary) : undefined;
  return output ? truncate(output, finalAnswerMaterialBudget(run)) : undefined;
}

function shouldAggregateFinalMaterial(run: RunState, completeSteps: RunState["steps"]): boolean {
  if (completeSteps.length <= 1) return false;
  if (run.route.kind === "multi-agent-dag") return true;
  return /\b(deep|in[- ]depth|profundidad|profundo|an[aá]lisis|project analysis|Coverage Matrix|Evidence Table)\b/i.test(run.route.reason);
}

function finalAnswerMaterialBudget(run: RunState): number {
  const parsed = Number(process.env.PI_CHALIN_FINAL_MATERIAL_CHARS);
  if (Number.isFinite(parsed) && parsed > 500) return Math.floor(parsed);
  if (run.route.kind === "multi-agent-dag") return 12000;
  if (/\b(deep|in[- ]depth|profundidad|profundo|an[aá]lisis|project analysis|Coverage Matrix|Evidence Table)\b/i.test(run.route.reason)) return 10000;
  return 1200;
}

function supportingAgentFindings(run: RunState | undefined): string | undefined {
  if (!run) return undefined;
  const completeSteps = run.steps.filter((step) => isUsableStepStatus(step.status));
  if (completeSteps.length <= 1) return undefined;
  return completeSteps
    .slice(0, -1)
    .map((step) => `- ${step.agent}: ${truncate(stepOutput(step) || "no output", 260)}`)
    .join("\n");
}

function stepOutput(step: RunState["steps"][number]): string | undefined {
  return step.output?.handoff || step.output?.text || step.output?.raw || step.error;
}

function stepFullOutput(step: RunState["steps"][number]): string | undefined {
  return step.output?.text || step.output?.raw || step.output?.handoff || step.error;
}

export function outcomeForResult(result: ChalinHandleResult): ChalinRouteOutcome {
  if (result.approval.action === "ask") return "ask";
  if (result.approval.action === "block") return "block";
  if (result.run?.status === "failed") return "failed";
  if (result.run?.status === "paused") return "paused";
  return "complete";
}

export function formatDirectRecommendation(route: RouteDecision, reason: string): string {
  return [
    "pi-chalin direct execution recommended",
    "status: direct-recommended",
    reason,
    `Original route: ${route.kind} · ${route.agents.join(" → ") || "none"}`,
    "Instruction for the primary Pi agent: do not claim completion from this tool result. Continue now with native tools and complete the bounded edit directly.",
  ].join("\n");
}

function formatStep(step: RunState["steps"][number]): string {
  return `- ${step.agent}: ${truncate(stepOutput(step) || "no output", 420)}`;
}

export function compactRouteDetails(route: RouteDecision, result: ChalinHandleResult, diagnostics: unknown[]) {
  return {
    route,
    approval: result.approval,
    memoriesUsed: result.memories?.length ?? 0,
    run: result.run ? {
      id: result.run.id,
      status: result.run.status,
      logsPath: result.run.logsPath,
      metrics: result.run.metrics,
      steps: result.run.steps.map((step) => ({
        agent: step.agent,
        status: step.status,
        model: step.model,
        thinkingLevel: step.thinkingLevel,
        error: step.error,
        handoff: truncate(step.output?.handoff || step.output?.text || step.error || "", 600),
      })),
    } : undefined,
    diagnostics,
  };
}

function isUsableStepStatus(status: RunState["status"] | undefined): boolean {
  return status === "complete" || status === "budget-capped";
}

function truncate(text: string, max: number): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  return normalized.length <= max ? normalized : `${normalized.slice(0, max - 1)}…`;
}
