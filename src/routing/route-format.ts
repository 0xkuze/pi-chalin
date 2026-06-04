import type { ChalinHandleResult } from "../kernel/kernel.ts";
import { sanitizeTransientVerificationClaims } from "../observability/evidence-claims.ts";
import type { ChalinRouteOutcome } from "../runtime/state.ts";
import type { AgentHandoff, EvidenceClaim, RouteDecision, RunState } from "../domain/schemas.ts";
import { isUsableStepStatus } from "../runtime/status.ts";
import { compactText as truncate } from "../utils/text.ts";

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
  const partialSummary = !finalMaterial ? partialSubagentSummary(result.run) : undefined;
  const observability = runObservabilityMaterial(result.run);
  const lines = [
    routeResultHeadline(route, result),
    `status: ${result.run?.status ?? result.approval.action}`,
    routeResultInstruction(result, finalMaterial),
    result.approval.action !== "allow" ? `Approval: ${result.approval.action} — ${result.approval.reason}` : undefined,
    result.memories.length > 0 ? `Memory used: ${result.memories.length}` : undefined,
    finalMaterial ? "\nFinal answer material:" : undefined,
    finalMaterial,
    memoryMaterial ? "\nMemory material:" : undefined,
    memoryMaterial,
    partialSummary ? "\nPartial subagent summary:" : undefined,
    partialSummary,
    observability ? "\nRun observability:" : undefined,
    observability,
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
  if (run.status !== "complete") return undefined;
  const completeSteps = run.steps.filter((step) => isUsableStepStatus(step.status));
  const budget = finalAnswerMaterialBudget(run);
  if (shouldAggregateFinalMaterial(run, completeSteps)) {
    const primary = completeSteps.at(-1);
    const primaryOutput = primary ? stepFullOutput(primary) : undefined;
    const supporting = supportingEvidenceMaterial(completeSteps.slice(0, -1));
    const material = [
      primaryOutput,
      supporting ? `Supporting evidence:\n${supporting}` : undefined,
    ].filter((item): item is string => Boolean(item)).join("\n\n");
    return material ? finalMaterialWithEvidence(run, material, budget) : undefined;
  }
  const primary = completeSteps.at(-1) ?? run.steps.at(-1);
  const output = primary ? primaryFinalOutput(run, primary) : undefined;
  return output ? finalMaterialWithEvidence(run, output, budget) : undefined;
}

function routeResultHeadline(route: RouteDecision, result: ChalinHandleResult): string {
  const agents = route.agents.join(" → ") || route.kind;
  if (!result.run) return `pi-chalin ${result.approval.action}: ${agents}`;
  return result.run.status === "complete"
    ? `pi-chalin completed: ${agents}`
    : `pi-chalin ${result.run.status}: ${agents}`;
}

function routeResultInstruction(result: ChalinHandleResult, finalMaterial: string | undefined): string {
  if (result.approval.action !== "allow") {
    return "Instruction: approval required; do not claim completion.";
  }
  if (finalMaterial) {
    return "Instruction: answer from Final answer material; use more tools only for an explicit critical gap.";
  }
  if (result.run?.status === "paused") {
    return "Instruction: paused before final synthesis; treat summary as partial context.";
  }
  if (result.run?.status === "failed") {
    return "Instruction: failed before final synthesis; explain the gap and next repair step.";
  }
  return "Instruction: answer from the summary and name any remaining gap explicitly.";
}

function finalMaterialWithEvidence(run: RunState, material: string, max: number): string {
  const sanitized = sanitizeTransientVerificationClaims(material).text;
  const footer = implementationEvidenceFooter(run, material);
  if (!footer) return truncate(sanitized, max);
  const separator = sanitized.trim() ? "\n\n" : "";
  const availableForMaterial = max - footer.length - separator.length;
  if (availableForMaterial < 240) return truncate(`${sanitized}${separator}${footer}`, max);
  return `${truncate(sanitized, availableForMaterial)}${separator}${footer}`;
}

function implementationEvidenceFooter(run: RunState, material: string): string | undefined {
  if (!hasMutationEvidence(run)) return undefined;
  const changedPaths = uniqueStrings(run.steps.flatMap((step) => step.metrics?.filesTouched ?? []));
  const verificationCommands = uniqueStrings(run.steps
    .flatMap((step) => step.metrics?.shellCommands ?? [])
    .map((command) => formatVerificationCommand(command))
    .filter((command) => command.length > 0));
  const lines: string[] = [];
  if (changedPaths.length > 0 && changedPaths.some((filePath) => !material.includes(filePath))) {
    lines.push(`Changed paths: ${changedPaths.slice(0, 10).join(", ")}`);
  }
  if (verificationCommands.length > 0 && verificationCommands.some((command) => !material.includes(command))) {
    lines.push(`Verification: ${verificationCommands.slice(0, 3).join("; ")}`);
  }
  return lines.length > 0 ? `Evidence:\n${lines.map((line) => `- ${line}`).join("\n")}` : undefined;
}

function formatVerificationCommand(command: string): string {
  const normalized = command
    .replace(/\s*2>&1\b/g, "")
    .replace(/\s+/g, " ")
    .trim();
  const parts = normalized.split(/\s+&&\s+/);
  while (parts[0]?.startsWith("cd ")) parts.shift();
  return parts.join(" && ").slice(0, 180);
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function shouldAggregateFinalMaterial(run: RunState, completeSteps: RunState["steps"]): boolean {
  if (completeSteps.length <= 1) return false;
  if (run.route.kind === "multi-agent-dag") return true;
  return !hasMutationEvidence(run);
}

function supportingEvidenceMaterial(steps: RunState["steps"]): string | undefined {
  const items = steps
    .map((step) => {
      const excerpt = structuredHandoffExcerpt(step.output?.structuredHandoff)
        ?? structuredClaimExcerpt(step.output?.claims)
        ?? (() => {
        const output = stepFullOutput(step);
        return output ? curatedEvidenceExcerpt(output) : undefined;
      })();
      return excerpt ? `- ${step.agent}: ${excerpt}` : undefined;
    })
    .filter((item): item is string => Boolean(item));
  return items.length ? items.join("\n") : undefined;
}

function structuredHandoffExcerpt(item: AgentHandoff | undefined): string | undefined {
  if (!item) return undefined;
  const pieces = [
    item.summary,
    item.changedFiles.length ? `changed: ${item.changedFiles.slice(0, 4).join(", ")}` : undefined,
    item.verification.length ? `verification: ${item.verification.slice(0, 3).join("; ")}` : undefined,
    item.risks.length ? `risks: ${item.risks.slice(0, 3).join("; ")}` : undefined,
    item.nextActions.length ? `next: ${item.nextActions.slice(0, 3).join("; ")}` : undefined,
  ].filter((value): value is string => Boolean(value));
  return pieces.length ? truncate(pieces.join(" "), 420) : undefined;
}

function structuredClaimExcerpt(claims: EvidenceClaim[] | undefined): string | undefined {
  if (!claims?.length) return undefined;
  const prioritized = [...claims].sort((left, right) => claimPriority(right) - claimPriority(left)).slice(0, 4);
  return prioritized.map((claim) => {
    const evidence = claim.evidence.length > 0 ? ` evidence: ${claim.evidence.slice(0, 3).join(", ")}` : " evidence: missing";
    const confidence = Number.isFinite(claim.confidence) ? ` confidence: ${claim.confidence}` : "";
    return truncate(`${claim.kind} ${claim.subject}: ${claim.summary};${evidence}${confidence}`, 320);
  }).join(" ");
}

function claimPriority(claim: EvidenceClaim): number {
  if (claim.kind === "contradiction") return 5;
  if (claim.kind === "unknown") return 4;
  if (claim.kind === "negative-claim") return 3;
  if (claim.kind === "transient-status") return 2;
  return 1;
}

function curatedEvidenceExcerpt(text: string): string | undefined {
  const lines = text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .filter((line) => /\b(Coverage Matrix|Evidence Table|Unknowns?|Gaps?|Findings?|Verdict|Changed|Verification|Effect evidence|Risk|Riesgo|Hallazgos?|Evidencia)\b/i.test(line))
    .slice(0, 4)
    .map((line) => truncate(collapseRepeatedText(line), 320));
  if (lines.length > 0) return lines.join(" ");
  return truncate(collapseRepeatedText(text), 320);
}

function collapseRepeatedText(text: string): string {
  return text
    .replace(/\b((?:[a-z][\w/-]*\s+){2,5})(?:\1){2,}/gi, "$1… ")
    .replace(/\s+/g, " ")
    .trim();
}

function finalAnswerMaterialBudget(run: RunState): number {
  const parsed = Number(process.env.PI_CHALIN_FINAL_MATERIAL_CHARS);
  if (Number.isFinite(parsed) && parsed > 500) return Math.floor(parsed);
  if (run.route.kind === "multi-agent-dag") return 12000;
  if (run.steps.length > 1 && !hasMutationEvidence(run)) return 10000;
  if (run.steps.length === 1 && !hasMutationEvidence(run)) return 6000;
  return 1200;
}

function partialSubagentSummary(run: RunState | undefined): string | undefined {
  if (!run) return undefined;
  const items = run.steps
    .slice(0, 8)
    .map(formatPartialStep)
    .filter((item): item is string => Boolean(item));
  if (run.steps.length > 8) items.push(`- +${run.steps.length - 8} more subagents omitted`);
  return items.length ? items.join("\n") : undefined;
}

function formatPartialStep(step: RunState["steps"][number]): string | undefined {
  const signal = partialStepSignal(step);
  if (!signal) return undefined;
  return `- ${step.agent}: ${signal}`;
}

function partialStepSignal(step: RunState["steps"][number]): string | undefined {
  if (isUsableStepStatus(step.status)) {
    const output = stepFullOutput(step);
    const claimSignal = structuredClaimExcerpt(step.output?.claims);
    const evidenceSignal = output ? curatedEvidenceExcerpt(output) : undefined;
    return truncate(cleanPartialSignal(claimSignal ?? evidenceSignal ?? "completed"), 220);
  }
  if (step.status === "failed" || step.status === "paused") return truncate(step.error || step.status, 220);
  if (step.status === "skipped") return truncate(step.skipReason || "skipped after upstream failure", 220);
  if (step.status === "running") return "running";
  if (step.status === "pending") return "waiting for resume";
  return undefined;
}

function runObservabilityMaterial(run: RunState | undefined): string | undefined {
  if (!run) return undefined;
  const lines = [
    `- run: ${run.id}${run.logsPath ? ` · log: ${run.logsPath}` : ""}`,
    run.workUnits?.length ? `- work units: ${run.workUnits.length} · skipped steps: ${run.steps.filter((step) => step.status === "skipped").length}` : undefined,
    run.recoveryState?.failedStepId ? `- failed: ${run.recoveryState.failedStepId}${run.recoveryState.failedUnitId ? ` · unit: ${run.recoveryState.failedUnitId}` : ""}` : undefined,
    run.recoveryState?.reviewersNotRun.length ? `- reviewers not run: ${run.recoveryState.reviewersNotRun.join(", ")}` : undefined,
    run.recoveryState?.repairOptions.length ? `- repair options: ${run.recoveryState.repairOptions.join("; ")}` : undefined,
    run.mutationLedger?.length || run.verificationLedger?.length ? `- ledgers: mutations ${run.mutationLedger?.length ?? 0} · verification ${run.verificationLedger?.length ?? 0}` : undefined,
  ];
  return lines.filter((line): line is string => Boolean(line)).join("\n");
}

function cleanPartialSignal(text: string): string {
  return text
    .replace(/^\s{0,3}#{1,6}\s+/gm, "")
    .replace(/\s*\|\s*/g, " | ")
    .replace(/\s+/g, " ")
    .trim();
}

function stepOutput(step: RunState["steps"][number]): string | undefined {
  return step.output?.handoff || step.output?.text || step.output?.raw || step.error;
}

function primaryFinalOutput(run: RunState, step: RunState["steps"][number]): string | undefined {
  if (run.steps.length === 1 && !hasMutationEvidence(run)) {
    return stepFullOutput(step);
  }
  return stepOutput(step);
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
        skipReason: step.skipReason,
        workUnitId: step.workUnitId,
        reviewGate: step.reviewGate,
        handoff: truncate(step.output?.handoff || step.output?.text || step.error || "", 600),
        structuredHandoff: step.output?.structuredHandoff,
        reviewerVerdict: step.output?.reviewerVerdict,
        nestedRuns: step.nestedRuns,
      })),
      workUnits: result.run.workUnits,
      recoveryState: result.run.recoveryState,
      mutationLedger: result.run.mutationLedger,
      verificationLedger: result.run.verificationLedger,
    } : undefined,
    diagnostics,
  };
}

function hasMutationEvidence(run: RunState): boolean {
  if (run.route.expectedEffects?.includes("write")) return true;
  if ((run.mutationLedger?.length ?? 0) > 0) return true;
  return run.steps.some((step) => {
    if ((step.metrics?.filesTouched?.length ?? 0) > 0) return true;
    return (step.output?.structuredHandoff?.changedFiles.length ?? 0) > 0;
  });
}
