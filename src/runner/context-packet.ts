import * as fs from "node:fs";
import * as path from "node:path";
import type { EvidenceClaim, RunState, RunStepState } from "../domain/schemas.ts";
import { compactHandoffItems, compactHandoffText, truncateText } from "./runner-utils.ts";

export interface ContextPacket {
  summary: string;
  workUnitIds: string[];
  claims: EvidenceClaim[];
  unknowns: EvidenceClaim[];
  filesRead: string[];
  changedFiles: string[];
  verification: string[];
  knownGaps: string[];
  tokenBudget: number;
}

export function buildContextPacket(run: RunState, currentStep: RunStepState, previous: string | undefined, tokenBudget = 900, cwd?: string, originalCwd?: string): ContextPacket | undefined {
  if (!currentStep.workUnitId && !run.workUnits?.length) return undefined;
  const roots = [cwd, originalCwd].filter((root): root is string => Boolean(root));
  const currentIndex = run.steps.indexOf(currentStep);
  const priorSteps = currentIndex >= 0 ? run.steps.slice(0, currentIndex) : run.steps.filter((step) => step !== currentStep);
  const claims = priorSteps.flatMap((step) => step.output?.claims ?? step.output?.structuredHandoff?.evidenceClaims ?? []).slice(0, 16);
  const changedFiles = sanitizeWorkspacePathList(unique(priorSteps.flatMap((step) => step.output?.structuredHandoff?.changedFiles ?? step.metrics?.filesTouched ?? [])), cwd);
  const verification = unique(priorSteps.flatMap((step) => step.output?.structuredHandoff?.verification ?? []))
    .map((item) => sanitizeContextText(compactHandoffText(item, 260), roots));
  const filesRead = sanitizeWorkspacePathList(unique(priorSteps.flatMap((step) => step.metrics?.filesRead ?? [])), cwd).slice(0, 80);
  const knownGaps = unique([
    ...priorSteps.flatMap((step) => step.output?.structuredHandoff?.risks ?? []).map((item) => compactHandoffText(item, 260)),
    ...priorSteps.flatMap((step) => step.output?.reviewerVerdict?.missingCoverage ?? []).map((item) => compactHandoffText(item, 260)),
    ...priorSteps.filter((step) => step.status === "failed" || step.status === "skipped").map((step) => step.error ?? step.skipReason ?? `${step.agent}/${step.id} did not complete`),
  ]).map((item) => sanitizeContextText(item, roots)).slice(0, 12);
  const summary = sanitizeContextText(buildContextSummary(priorSteps, previous, tokenBudget), roots);
  return {
    summary,
    workUnitIds: unique([currentStep.workUnitId, ...priorSteps.map((step) => step.workUnitId)].filter((value): value is string => Boolean(value))),
    claims,
    unknowns: claims.filter((claim) => claim.kind === "unknown" || claim.kind === "contradiction"),
    filesRead,
    changedFiles,
    verification,
    knownGaps,
    tokenBudget,
  };
}

function buildContextSummary(priorSteps: RunStepState[], previous: string | undefined, tokenBudget: number): string {
  const immediate = previous?.trim();
  const upstream = priorSteps
    .map((step) => {
      const text = stepContextSummary(step);
      return text ? `- ${step.agent}/${step.id}: ${text}` : undefined;
    })
    .filter((line): line is string => Boolean(line));
  const visibleUpstream = immediate
    ? upstream.filter((line) => !summaryAlreadyRepresented(immediate, line))
    : upstream;
  const parts = [
    immediate ? `previous: ${immediate}` : undefined,
    visibleUpstream.length ? `upstream:\n${visibleUpstream.join("\n")}` : undefined,
  ].filter((line): line is string => Boolean(line));
  return truncateText(parts.join("\n"), tokenBudget);
}

function stepContextSummary(step: RunStepState): string {
  const handoff = step.output?.structuredHandoff;
  if (!handoff) return (step.output?.handoff ?? step.output?.text ?? "").trim();
  return [
    compactHandoffText(handoff.summary, 260),
    handoff.changedFiles.length ? `changed: ${compactHandoffItems(handoff.changedFiles, { itemLimit: 12, itemMax: 160 })}` : undefined,
    handoff.verification.length ? `verification: ${compactHandoffItems(handoff.verification, { itemLimit: 6, itemMax: 220 })}` : undefined,
    handoff.risks.length ? `risks: ${compactHandoffItems(handoff.risks, { itemLimit: 6, itemMax: 220 })}` : undefined,
    handoff.nextActions.length ? `next: ${compactHandoffItems(handoff.nextActions, { itemLimit: 6, itemMax: 220 })}` : undefined,
  ].filter((line): line is string => Boolean(line)).join(" ");
}

function summaryAlreadyRepresented(previous: string, upstreamLine: string): boolean {
  const normalizedPrevious = normalizeSummaryText(previous);
  const normalizedLine = normalizeSummaryText(summarySegment(upstreamLine.replace(/^-\s+[^:]+:\s*/, "")));
  if (!normalizedLine) return false;
  const probe = normalizedLine.slice(0, Math.min(90, normalizedLine.length));
  return probe.length >= 32 && normalizedPrevious.includes(probe);
}

function summarySegment(value: string): string {
  const markers = [" changed:", " verification:", " risks:", " next:"];
  const lower = value.toLowerCase();
  const positions = markers
    .map((marker) => lower.indexOf(marker))
    .filter((index) => index > 0);
  const end = positions.length ? Math.min(...positions) : value.length;
  return value.slice(0, end);
}

function normalizeSummaryText(value: string): string {
  return value.toLowerCase().replace(/\s+/g, " ").trim();
}

function sanitizeContextText(value: string, roots: string[]): string {
  return roots.length ? sanitizeWorkspaceTextForRoots(value, roots) : value;
}

export function sanitizeWorkspacePathList(values: string[], cwd?: string): string[] {
  return unique(values.flatMap((value) => {
    const sanitized = sanitizeWorkspacePath(value, cwd);
    return sanitized ? [sanitized] : [];
  }));
}

export function sanitizeWorkspacePath(value: string, cwd?: string): string | undefined {
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  if (!cwd || !path.isAbsolute(trimmed)) return trimmed;
  return sanitizeWorkspacePathForRoots(trimmed, [cwd]);
}

export function sanitizeWorkspacePathForRoots(value: string, roots: string[]): string | undefined {
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  if (!path.isAbsolute(trimmed)) return trimmed;
  for (const root of unique(roots.filter(Boolean))) {
    const relative = relativePathInsideRoot(root, trimmed);
    if (relative !== undefined) return relative;
  }
  return undefined;
}

export function sanitizeWorkspaceText(value: string, cwd?: string): string {
  if (!cwd || !value.includes("/")) return value;
  return sanitizeWorkspaceTextForRoots(value, [cwd]);
}

export function sanitizeWorkspaceTextForRoots(value: string, roots: string[]): string {
  if (!roots.length || !value.includes("/")) return value;
  let output = "";
  for (let index = 0; index < value.length;) {
    const char = value[index]!;
    if (char !== "/" || !isAbsolutePathStart(value, index)) {
      output += char;
      index += 1;
      continue;
    }
    const end = pathTokenEnd(value, index);
    const rawToken = value.slice(index, end);
    const { core, suffix } = trimPathTokenSuffix(rawToken);
    const replacement = path.isAbsolute(core)
      ? sanitizeWorkspacePathForRoots(core, roots) ?? "[outside-workspace-path]"
      : core;
    output += replacement === "." && suffix.startsWith(".") ? replacement + suffix.slice(1) : replacement + suffix;
    index = end;
  }
  return output;
}

function relativePathInsideRoot(root: string, target: string): string | undefined {
  return relativeInside(path.resolve(root), path.resolve(target))
    ?? relativeInside(safeRealpath(root), safeRealpath(target));
}

function relativeInside(root: string, target: string): string | undefined {
  const relative = path.relative(root, target);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return undefined;
  return relative ? relative.split(path.sep).join("/") : ".";
}

function safeRealpath(target: string): string {
  try {
    return fs.realpathSync(target);
  } catch {
    return path.resolve(target);
  }
}

export function formatContextPacket(packet: ContextPacket | undefined): string | undefined {
  if (!packet) return undefined;
  const lines = [
    `ContextPacket: workUnits=${packet.workUnitIds.join(", ") || "none"} budget=${packet.tokenBudget}`,
    packet.summary ? `summary: ${packet.summary}` : undefined,
    packet.changedFiles.length ? `changedFiles: ${packet.changedFiles.slice(0, 12).join(", ")}` : undefined,
    packet.verification.length ? `verification: ${compactHandoffItems(packet.verification, { itemLimit: 8, itemMax: 220 })}` : undefined,
    packet.knownGaps.length ? `knownGaps: ${compactHandoffItems(packet.knownGaps, { itemLimit: 8, itemMax: 220 })}` : undefined,
    packet.filesRead.length ? `alreadyRead: ${packet.filesRead.slice(0, 24).join(", ")}` : undefined,
    packet.unknowns.length ? `unknowns: ${packet.unknowns.map((claim) => `${claim.subject}: ${claim.summary}`).slice(0, 6).join("; ")}` : undefined,
  ];
  return lines.filter((line): line is string => Boolean(line)).join("\n");
}

function unique(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function isUrlSlash(value: string, index: number): boolean {
  const previous = index > 0 ? value[index - 1] : "";
  return previous === ":" || previous === "/";
}

function isAbsolutePathStart(value: string, index: number): boolean {
  if (isUrlSlash(value, index)) return false;
  return index === 0 || isPathTokenDelimiter(value[index - 1]!);
}

function pathTokenEnd(value: string, start: number): number {
  let index = start;
  while (index < value.length && !isPathTokenDelimiter(value[index]!)) index += 1;
  return index;
}

function isPathTokenDelimiter(char: string): boolean {
  return char === " "
    || char === "\n"
    || char === "\t"
    || char === "\r"
    || char === "`"
    || char === "\""
    || char === "'"
    || char === "="
    || char === "<"
    || char === ">"
    || char === "|";
}

function trimPathTokenSuffix(token: string): { core: string; suffix: string } {
  let end = token.length;
  while (end > 0 && isPathTokenSuffix(token[end - 1]!)) end -= 1;
  return { core: token.slice(0, end), suffix: token.slice(end) };
}

function isPathTokenSuffix(char: string): boolean {
  return char === "." || char === "," || char === ")" || char === "]" || char === "}";
}
