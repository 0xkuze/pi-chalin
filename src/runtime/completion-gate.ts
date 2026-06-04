import type { EvidenceLedger } from "./evidence-ledger.ts";
import { compactString } from "../utils/json.ts";

export type CompletionGateSurface = "global" | "route" | "inline" | "terminal";
export const COMPLETION_GATE_ACTIONS = ["finalize", "verify_existing_evidence", "expand_custom_probe", "repair", "ask"] as const;
export type CompletionGateAction = typeof COMPLETION_GATE_ACTIONS[number];

export interface CompletionGatePayload {
  originalPrompt?: string;
  finalAnswer?: string;
  priorBlocks?: CompletionGateDecision[];
  ledger: EvidenceLedger;
  state: {
    mutationObserved: boolean;
    sourceMutationObserved: boolean;
    testMutationObserved: boolean;
    verificationObserved: boolean;
    verificationCommand?: string;
    terminalActionObserved: boolean;
    terminalActionCommand?: string;
    docsOnlyMutation: boolean;
    changedPaths: string[];
    readPaths: string[];
    promptCodePaths: string[];
    backgroundJobs?: Array<{
      id: string;
      command?: string;
      status: string;
      requiredEvidence: boolean;
      completionAction?: string;
    }>;
  };
}

export interface CompletionGateDecision {
  canFinalize: boolean;
  confidence: number;
  missingEvidence: string[];
  nextAction: CompletionGateAction;
  reason: string;
  requiredEvidence?: string[];
}

export function buildCompletionGateContract(): string {
  return [
    "## Completion Gate",
    "Mandatory before any final answer that claims completion, whether Primary Pi worked inline or delegated through pi-chalin.",
    "Run it silently with LLM judgment over the request, repo evidence, tool results, handoffs, and verification. Do not use keyword matching, domain-specific checklists, regex-like rules, or literal examples as decision logic.",
    "Internally decide `{ canFinalize: boolean, missingEvidence: string[], nextAction: \"finalize\" | \"verify_existing_evidence\" | \"expand_custom_probe\" | \"repair\" | \"ask\" }`.",
    "Coverage: map every explicit user request, accepted constraint, and behavior implied by the changed surface to representative evidence.",
    "Evidence: final claims need current file/tool/subagent/verification support. A passing command is not enough if changed behavior, required artifacts, runner discovery, public API, or a preservation/invariant path is unproven.",
    "Mutation history: if a mutation follows failed evidence, audit whether it repairs the failure or narrows/reverts a plausible implementation hypothesis. Finalization needs latest-source evidence.",
    "Existing surfaces: when tests, observed fixtures, examples, docs, or runner-discovered paths were read/found, prefer that evidence. If blocked, a custom probe must mirror or subsume real input shape, public flow, and preservation paths.",
    "Hidden-test posture: before finalizing, mentally construct the strongest plausible regression test from the request, observed fixtures/examples, and latest source diff. If evidence would not rule it out, block finalization.",
    "Expansion: derive the smallest adjacent checks from the actual change: normal behavior, a boundary/counterexample, and a preservation/invariant path when applicable.",
    "Prior blocks: treat earlier missingEvidence/requiredEvidence as binding acceptance debt until new evidence satisfies it or direct repo/spec evidence proves it unnecessary.",
    "Delegation: if a handoff names gaps, contradictions, skipped verification, or partial scope, treat that as missing evidence unless you repair it or state it as incomplete.",
    "Background jobs: a queued/running requiredEvidence job is pending evidence, not passing evidence. A final answer may honestly say the job is still running only if it does not claim the requested work is complete.",
    "Decision: if `can_finalize` is false, continue with the smallest repair/verification step or ask the user through the interview flow when a human decision blocks progress. Do not present an incomplete implementation as done.",
    "Do not rely on hidden background follow-up to prove a completion claim; self-audit before final, then finish with evidence, continue current work, or make the pending background job explicit.",
    "Do not expose the gate, JSON, or internal labels in the final answer unless the user asks how the harness made the decision.",
  ].join("\n");
}

export function buildCompletionGateContextMessage(): string {
  return [
    "pi-chalin completion gate active.",
    "Before any final answer that claims completion, silently run the Completion Gate from the system prompt.",
    "Finalize only when coverage and evidence support every requested outcome; otherwise continue with the smallest repair/verification step or ask the user if blocked.",
  ].join("\n");
}

export function buildCompletionGateSteer(surface: CompletionGateSurface): string {
  const scope = surface === "route"
    ? "the original prompt and delegated final material"
    : surface === "terminal"
      ? "the completed external action and verification already performed"
      : surface === "inline"
        ? "the original prompt, changed files, and latest verification"
        : "the original prompt and all available evidence";
  return [
    "Completion Gate before final:",
    `- Decide silently whether ${scope} prove every user-requested outcome and relevant preservation/boundary evidence.`,
    "- If the gate passes, answer concisely in the user's language.",
    "- If evidence is missing, do not claim completion; continue with the smallest repair/verification step or ask the user when blocked.",
  ].join("\n");
}

const COMPLETION_GATE_DECISION_KEYS = new Set(["canFinalize", "confidence", "missingEvidence", "nextAction", "reason", "requiredEvidence"]);

export function validateCompletionGateDecision(parsed: Record<string, unknown>): CompletionGateDecision | undefined {
  if (Object.keys(parsed).some((key) => !COMPLETION_GATE_DECISION_KEYS.has(key))) return undefined;
  if (typeof parsed.canFinalize !== "boolean") return undefined;
  if (typeof parsed.confidence !== "number" || !Number.isFinite(parsed.confidence) || parsed.confidence < 0 || parsed.confidence > 1) return undefined;
  const nextAction = isCompletionGateAction(parsed.nextAction) ? parsed.nextAction : undefined;
  if (!nextAction) return undefined;
  if (parsed.canFinalize && nextAction !== "finalize") return undefined;
  if (!parsed.canFinalize && nextAction === "finalize") return undefined;
  const reason = compactString(parsed.reason, 1_200);
  if (!reason) return undefined;
  const missingEvidence = validateEvidenceLabels(parsed.missingEvidence);
  if (!missingEvidence) return undefined;
  const requiredEvidence = parsed.requiredEvidence === undefined ? undefined : validateEvidenceLabels(parsed.requiredEvidence);
  if (parsed.requiredEvidence !== undefined && !requiredEvidence) return undefined;
  return {
    canFinalize: parsed.canFinalize,
    confidence: parsed.confidence,
    missingEvidence,
    nextAction,
    reason,
    ...(requiredEvidence ? { requiredEvidence } : {}),
  };
}

export function formatCompletionGateDecisionSteer(decision: CompletionGateDecision): string {
  return [
    "pi-chalin completion gate blocked finalization.",
    `Decision: ${decision.nextAction} (${Math.round(decision.confidence * 100)}% confidence).`,
    `Reason: ${decision.reason}`,
    decision.missingEvidence.length
      ? `Missing evidence: ${decision.missingEvidence.map((item) => `\`${item}\``).join(", ")}.`
      : undefined,
    decision.requiredEvidence?.length
      ? `Required before final: ${decision.requiredEvidence.map((item) => `\`${item}\``).join(", ")}.`
      : undefined,
    "Continue with the smallest evidence, repair, or interview step required by this decision. Do not summarize as complete until the gate can finalize.",
  ].filter((line): line is string => Boolean(line)).join("\n");
}

export function completionGateDecisionKey(payload: CompletionGatePayload, decision: CompletionGateDecision): string {
  return JSON.stringify({
    prompt: payload.originalPrompt,
    changedPaths: payload.state.changedPaths,
    mutations: payload.ledger.mutationRecords.map((record) => [record.toolName, record.status, record.afterFailedCommand, record.path ?? "", record.args ?? "", record.observation ?? ""]),
    commands: payload.ledger.commandRecords.map((record) => [record.command, record.status, record.afterLatestMutation]),
    failedCommandsAfterMutation: payload.ledger.failedCommandsAfterMutation.map((record) => [record.command, record.status, record.afterLatestMutation]),
    postFailureMutations: payload.ledger.postFailureMutationRecords.map((record) => [record.toolName, record.status, record.path ?? "", record.args ?? "", record.observation ?? ""]),
    observations: payload.ledger.observations.map((record) => [record.toolName, record.status, record.afterLatestMutation, record.path ?? "", record.command ?? "", record.text]),
    action: decision.nextAction,
    missingEvidence: decision.missingEvidence,
    requiredEvidence: decision.requiredEvidence ?? [],
  });
}

function validateEvidenceLabels(value: unknown): string[] | undefined {
  if (!Array.isArray(value) || value.length > 8) return undefined;
  const labels: string[] = [];
  for (const item of value) {
    const label = compactString(item, 180);
    if (!label) return undefined;
    labels.push(label);
  }
  return labels;
}

function isCompletionGateAction(value: unknown): value is CompletionGateAction {
  return typeof value === "string" && COMPLETION_GATE_ACTIONS.includes(value as CompletionGateAction);
}
