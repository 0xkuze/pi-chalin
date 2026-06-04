import { candidateMatchesTransientClaim, isTransientVerificationStateClaim, parseClaimLedger } from "../observability/evidence-claims.ts";
import { createMemoryCandidate } from "../memory/memory.ts";
import type { AgentHandoff, AgentHandoffWorkUnit, AgentOutput, EvidenceClaim, MemoryCandidate, ReviewerEvidenceKind, ReviewerEvidenceRecord, ReviewerEvidenceStatus, ReviewerVerdict, RouteExpectedEffect } from "../domain/schemas.ts";
import { handoffBudgetChars, isRecord, memoryCandidateBudget, rawOutputBudgetChars, truncateText } from "./runner-utils.ts";

export interface ParseAgentOutputOptions {
  expectsReviewerVerdict?: boolean;
}

export function parseAgentOutput(agent: string, raw: string, options: ParseAgentOutputOptions = {}): AgentOutput {
  const warnings: string[] = [];
  const claimLedger = parseClaimLedger(raw, agent);
  warnings.push(...claimLedger.warnings);
  const structuredHandoff = parseStructuredAgentHandoff(raw, claimLedger.claims, warnings);
  const hasReviewerVerdictSection = Boolean(extractMarkdownSection(raw, "Reviewer Verdict"));
  const reviewerVerdict = options.expectsReviewerVerdict || hasReviewerVerdictSection ? parseStructuredReviewerVerdict(raw, warnings) : undefined;
  if (options.expectsReviewerVerdict && !reviewerVerdict) warnings.push("Review output did not include a structured Reviewer Verdict.");
  const handoff = structuredHandoff ? formatAgentHandoffSummary(structuredHandoff, agent) : undefined;
  const handoffContract = structuredHandoff ? "structured" : "missing";

  const candidates: MemoryCandidate[] = [];
  const memoryBlock = extractMarkdownSection(raw, "Memory Candidates") ?? extractMarkdownSection(raw, "Memory Candidate");
  if (memoryBlock) {
    for (const line of memoryBlock.split("\n")) {
      const parsed = parseMemoryCandidateLine(line);
      if (!parsed) continue;
      const structuredTransient = candidateMatchesTransientClaim(parsed.content, claimLedger.claims);
      if (isTransientVerificationStateClaim(parsed.content) || structuredTransient) {
        const source = structuredTransient ? "structured transient verification claim" : "transient verification status";
        warnings.push(`Dropped memory candidate with ${source}; require real non-dry-run command evidence instead.`);
        continue;
      }
      candidates.push(createMemoryCandidate({ category: parsed.category, content: parsed.content, sourceAgent: agent, confidence: parsed.confidence, scope: "project" }));
    }
  }

  if (raw.includes("## Memory Candidate") && candidates.length === 0) warnings.push("Memory candidate block was present but no valid bullet candidates were parsed.");
  const compactRaw = truncateText(raw.trim(), rawOutputBudgetChars());
  return { agent, text: compactRaw, handoff, structuredHandoff, handoffContract, reviewerVerdict, memoryCandidates: candidates.slice(0, memoryCandidateBudget()), claims: claimLedger.claims, raw: compactRaw, warnings };
}

function parseStructuredAgentHandoff(raw: string, claims: EvidenceClaim[], warnings: string[]): AgentHandoff | undefined {
  const value = parseJsonSection(raw, ["Agent Handoff", "Structured Handoff"], warnings);
  if (!isRecord(value)) return undefined;
  const summary = stringField(value, "summary");
  if (!summary) {
    warnings.push("Structured Agent Handoff omitted summary.");
    return undefined;
  }
  return {
    summary,
    changedFiles: stringArrayField(value, "changedFiles"),
    verification: stringArrayField(value, "verification", { structuredObjects: true }),
    evidenceClaims: evidenceClaimsField(value, claims),
    risks: stringArrayField(value, "risks"),
    nextActions: stringArrayField(value, "nextActions"),
    ...(typeof value.requiresHumanInput === "boolean" ? { requiresHumanInput: value.requiresHumanInput } : {}),
    ...(stringArrayField(value, "humanInputQuestions").length ? { humanInputQuestions: stringArrayField(value, "humanInputQuestions").slice(0, 5) } : {}),
    workUnits: workUnitsField(value),
  };
}

function parseStructuredReviewerVerdict(raw: string, warnings: string[]): ReviewerVerdict | undefined {
  const value = parseJsonSection(raw, ["Reviewer Verdict"], warnings);
  if (!isRecord(value)) return undefined;
  const rawVerdict = stringField(value, "verdict").toLowerCase();
  if (rawVerdict !== "pass" && rawVerdict !== "fail" && rawVerdict !== "gap") {
    warnings.push(`Structured Reviewer Verdict has invalid verdict '${rawVerdict || "missing"}'.`);
    return undefined;
  }
  const requiredRepair = textField(value, "requiredRepair", { structuredObjects: true });
  const evidence = stringArrayField(value, "evidence", { structuredObjects: true });
  const evidenceRecords = [
    ...reviewerEvidenceRecordsField(value, "evidence"),
    ...reviewerEvidenceRecordsField(value, "evidenceRecords"),
  ];
  if (rawVerdict === "pass" && evidence.length === 0) {
    warnings.push("Structured Reviewer Verdict pass omitted evidence; pass requires real evidence.");
    return undefined;
  }
  const blockingFindings = stringArrayField(value, "blockingFindings", { structuredObjects: true });
  const missingCoverage = stringArrayField(value, "missingCoverage", { structuredObjects: true });
  const residualRisks = stringArrayField(value, "residualRisks");
  const repairFiles = reviewerRepairFiles(value, evidenceRecords, rawVerdict);
  const normalizedVerdict = rawVerdict === "pass" && (blockingFindings.length > 0 || missingCoverage.length > 0 || requiredRepair)
    ? blockingFindings.length > 0 ? "fail" : "gap"
    : rawVerdict;
  if (normalizedVerdict !== rawVerdict) warnings.push("Structured Reviewer Verdict pass included blocking repair fields; normalized verdict to match the blocking contract.");
  return {
    verdict: normalizedVerdict,
    blockingFindings,
    missingCoverage,
    evidence,
    ...(evidenceRecords.length ? { evidenceRecords } : {}),
    ...(repairFiles.length ? { repairFiles } : {}),
    residualRisks,
    ...(requiredRepair ? { requiredRepair } : {}),
  };
}

function parseJsonSection(raw: string, names: string[], warnings: string[]): unknown {
  for (const name of names) {
    const section = extractMarkdownSection(raw, name);
    if (!section) continue;
    const jsonText = stripFencedJson(section);
    try {
      return JSON.parse(jsonText);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      warnings.push(`${name} JSON could not be parsed: ${message}`);
      return undefined;
    }
  }
  return undefined;
}

function extractMarkdownSection(raw: string, heading: string): string | undefined {
  const wanted = normalizeHeading(heading);
  const lines = raw.replace(/\r\n/g, "\n").split("\n");
  let start = -1;
  for (let index = 0; index < lines.length; index += 1) {
    const normalized = normalizeHeadingLine(lines[index] ?? "");
    if (normalized !== wanted) continue;
    start = index + 1;
    break;
  }
  if (start < 0) return undefined;
  let end = lines.length;
  for (let index = start; index < lines.length; index += 1) {
    if (isMarkdownHeading(lines[index] ?? "")) {
      end = index;
      break;
    }
  }
  return lines.slice(start, end).join("\n").trim();
}

function normalizeHeadingLine(line: string): string {
  let index = 0;
  while (line[index] === "#") index += 1;
  if (index === 0 || line[index] !== " ") return "";
  return normalizeHeading(line.slice(index + 1));
}

function normalizeHeading(value: string): string {
  return value.trim().toLowerCase().replaceAll(":", "");
}

function isMarkdownHeading(line: string): boolean {
  if (!line.startsWith("#")) return false;
  let index = 0;
  while (line[index] === "#") index += 1;
  return index > 0 && line[index] === " ";
}

function stripFencedJson(section: string): string {
  const lines = section.trim().split("\n");
  const fenceStart = lines.findIndex((line) => line.trim().startsWith("```"));
  if (fenceStart >= 0) {
    const fenceEnd = lines.findIndex((line, index) => index > fenceStart && line.trim().startsWith("```"));
    if (fenceEnd > fenceStart) return lines.slice(fenceStart + 1, fenceEnd).join("\n").trim();
    return lines.slice(fenceStart + 1).join("\n").trim();
  }
  return lines.join("\n").trim();
}

function stringField(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  return typeof value === "string" ? value.trim() : "";
}

function textField(record: Record<string, unknown>, key: string, options: { structuredObjects?: boolean } = {}): string {
  const direct = stringField(record, key);
  if (direct) return direct;
  return stringArrayField(record, key, options).join("; ");
}

function stringArrayField(record: Record<string, unknown>, key: string, options: { structuredObjects?: boolean } = {}): string[] {
  const value = record[key];
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed ? [trimmed] : [];
  }
  if (options.structuredObjects && isRecord(value)) {
    const normalized = normalizeStringArrayItem(value, options);
    return normalized ? [normalized] : [];
  }
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => normalizeStringArrayItem(item, options))
    .filter((item): item is string => Boolean(item))
    .slice(0, 20);
}

function normalizeStringArrayItem(value: unknown, options: { structuredObjects?: boolean }): string | undefined {
  if (typeof value === "string") return value.trim() || undefined;
  if (!options.structuredObjects || !isRecord(value)) return undefined;
  const parts = labeledObjectFields(value);
  if (parts.length > 0) return parts.join(" | ");
  try {
    return JSON.stringify(value).slice(0, 500);
  } catch {
    return undefined;
  }
}

function labeledObjectFields(record: Record<string, unknown>): string[] {
  return Object.keys(record)
    .sort()
    .map((key) => labeledObjectField(record, key))
    .filter((part): part is string => Boolean(part))
    .slice(0, 12);
}

function labeledObjectField(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  if (typeof value === "string" && value.trim()) return `${key}: ${value.trim()}`;
  if (Array.isArray(value)) {
    const items = value.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
    if (items.length > 0) return `${key}: ${items.join(", ")}`;
  }
  return undefined;
}

function reviewerEvidenceRecordsField(record: Record<string, unknown>, key: string): ReviewerEvidenceRecord[] {
  const value = record[key];
  const values = Array.isArray(value) ? value : isRecord(value) ? [value] : [];
  return values
    .flatMap((item) => normalizeReviewerEvidenceRecord(item))
    .slice(0, 20);
}

function normalizeReviewerEvidenceRecord(value: unknown): ReviewerEvidenceRecord[] {
  if (!isRecord(value)) return [];
  const kind = reviewerEvidenceKind(stringField(value, "kind"));
  if (!kind) return [];
  const paths = uniqueNonEmptyStrings([
    ...stringArrayField(value, "paths"),
    ...stringArrayField(value, "files"),
  ]);
  const command = stringField(value, "command");
  const result = stringField(value, "result");
  const status = reviewerEvidenceStatus(stringField(value, "status"));
  const summary = stringField(value, "summary");
  return [{
    kind,
    paths,
    ...(command ? { command } : {}),
    ...(result ? { result } : {}),
    ...(status ? { status } : {}),
    ...(summary ? { summary } : {}),
  }];
}

function reviewerRepairFiles(record: Record<string, unknown>, evidenceRecords: ReviewerEvidenceRecord[], verdict: string): string[] {
  const explicitFiles = uniqueNonEmptyStrings([
    ...structuredFileReferences(record.repairFiles, { allowStringItems: true }),
    ...structuredFileReferences(record.blockingFindings),
    ...structuredFileReferences(record.missingCoverage),
    ...structuredFileReferences(record.requiredRepair),
    ...evidenceRecords.filter((item) => item.status === "fail").flatMap((item) => item.paths),
  ]);
  const hasFailedVerificationEvidence = evidenceRecords.some((item) => item.kind === "verification" && item.status === "fail");
  if (explicitFiles.length > 0 || verdict === "pass" || !hasFailedVerificationEvidence) return explicitFiles;
  return uniqueNonEmptyStrings(evidenceRecords
    .filter((item) => item.kind === "reviewed-content")
    .flatMap((item) => item.paths));
}

function structuredFileReferences(value: unknown, options: { allowStringItems?: boolean } = {}): string[] {
  if (typeof value === "string") return options.allowStringItems ? [value] : [];
  const values = Array.isArray(value) ? value : isRecord(value) ? [value] : [];
  return values.flatMap((item) => {
    if (typeof item === "string") return options.allowStringItems ? [item] : [];
    if (!isRecord(item)) return [];
    return [
      stringField(item, "file"),
      stringField(item, "path"),
      stringField(item, "filename"),
      ...stringArrayField(item, "files"),
      ...stringArrayField(item, "paths"),
      ...stringArrayField(item, "changedFiles"),
    ];
  });
}

function reviewerEvidenceKind(value: string): ReviewerEvidenceKind | undefined {
  const normalized = value.trim().toLowerCase();
  if (normalized === "reviewed-content") return "reviewed-content";
  if (normalized === "verification") return "verification";
  return undefined;
}

function reviewerEvidenceStatus(value: string): ReviewerEvidenceStatus | undefined {
  const normalized = value.trim().toLowerCase();
  if (normalized === "pass") return "pass";
  if (normalized === "fail") return "fail";
  if (normalized === "unknown") return "unknown";
  return undefined;
}

function uniqueNonEmptyStrings(values: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const trimmed = value.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    result.push(trimmed);
  }
  return result;
}

function evidenceClaimsField(record: Record<string, unknown>, fallback: EvidenceClaim[]): EvidenceClaim[] {
  const value = record.evidenceClaims;
  if (!Array.isArray(value)) return fallback;
  const parsed = value.flatMap((item) => normalizeEvidenceClaim(item));
  return parsed.length > 0 ? parsed.slice(0, 20) : fallback;
}

function workUnitsField(record: Record<string, unknown>): AgentHandoffWorkUnit[] {
  const value = record.workUnits;
  if (!Array.isArray(value)) return [];
  const parsed = value.flatMap((item) => normalizeHandoffWorkUnit(item));
  return uniqueWorkUnits(parsed).slice(0, 20);
}

function normalizeHandoffWorkUnit(value: unknown): AgentHandoffWorkUnit[] {
  if (!isRecord(value)) return [];
  const title = stringField(value, "title");
  if (!title) return [];
  const { scope, files } = workUnitScopeField(value);
  const acceptanceCriteria = stringArrayField(value, "acceptanceCriteria");
  const id = stringField(value, "id");
  const expectedEffects = workUnitExpectedEffectsField(value);
  return [{
    ...(id ? { id } : {}),
    title,
    scope: scope.length ? scope : [title],
    ...(files.length ? { files } : {}),
    dependencies: stringArrayField(value, "dependencies"),
    ...(expectedEffects.length ? { expectedEffects } : {}),
    acceptanceCriteria: acceptanceCriteria.length ? acceptanceCriteria : scope.length ? scope : [title],
  }];
}

function workUnitExpectedEffectsField(record: Record<string, unknown>): RouteExpectedEffect[] {
  const valid = new Set<RouteExpectedEffect>(["read", "write", "verify"]);
  const effects = stringArrayField(record, "expectedEffects")
    .map((effect) => effect.toLowerCase())
    .filter((effect): effect is RouteExpectedEffect => valid.has(effect as RouteExpectedEffect));
  return [...new Set(effects)];
}

function workUnitScopeField(record: Record<string, unknown>): { scope: string[]; files: string[] } {
  const value = record.scope;
  if (isRecord(value)) {
    const scope = [
      stringField(value, "purpose"),
      stringField(value, "summary"),
      stringField(value, "accomplishes"),
      ...stringArrayField(value, "details"),
    ].filter((item): item is string => Boolean(item));
    return {
      scope: scope.length ? scope : stringArrayField(record, "scope"),
      files: structuredFilesField(value, "files"),
    };
  }
  return { scope: stringArrayField(record, "scope"), files: structuredFilesField(record, "files") };
}

function structuredFilesField(record: Record<string, unknown>, key: string): string[] {
  const value = record[key];
  if (!Array.isArray(value)) return stringArrayField(record, key);
  return [...new Set(value.flatMap((item) => {
    if (typeof item === "string" && item.trim()) return [item.trim()];
    if (!isRecord(item)) return [];
    return [
      stringField(item, "path"),
      stringField(item, "file"),
      stringField(item, "filename"),
    ].filter((candidate): candidate is string => Boolean(candidate));
  }))].slice(0, 20);
}

function uniqueWorkUnits(values: AgentHandoffWorkUnit[]): AgentHandoffWorkUnit[] {
  const seen = new Set<string>();
  const unique: AgentHandoffWorkUnit[] = [];
  for (const unit of values) {
    const key = (unit.id ?? unit.title).toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(unit);
  }
  return unique;
}

function normalizeEvidenceClaim(value: unknown): EvidenceClaim[] {
  if (!isRecord(value)) return [];
  const kind = stringField(value, "kind");
  if (!["stable-fact", "transient-status", "negative-claim", "unknown", "contradiction"].includes(kind)) return [];
  const subject = stringField(value, "subject");
  const summary = stringField(value, "summary");
  if (!subject || !summary) return [];
  const confidence = Number(value.confidence);
  return [{
    kind: kind as EvidenceClaim["kind"],
    subject,
    summary,
    evidence: stringArrayField(value, "evidence"),
    confidence: Number.isFinite(confidence) ? Math.max(0, Math.min(1, confidence)) : 0.7,
  }];
}

function formatAgentHandoffSummary(handoff: AgentHandoff, agent?: string): string {
  const lines = [
    `Summary: ${handoff.summary}`,
    handoff.changedFiles.length ? `Changed: ${handoff.changedFiles.join(", ")}` : undefined,
    handoff.verification.length ? `Verification: ${handoff.verification.join("; ")}` : undefined,
    handoff.risks.length ? `Risks: ${handoff.risks.join("; ")}` : undefined,
    handoff.nextActions.length ? `Next: ${handoff.nextActions.join("; ")}` : undefined,
    handoff.requiresHumanInput ? `Human input required: ${(handoff.humanInputQuestions?.length ? handoff.humanInputQuestions : handoff.nextActions).join("; ")}` : undefined,
  ].filter((line): line is string => Boolean(line));
  return truncateText(lines.join("\n"), handoffBudgetChars(agent));
}

function parseMemoryCandidateLine(line: string): { category: string; content: string; confidence: number } | undefined {
  const bullet = line.match(/^\s*[-*]\s+(.+?)\s*$/)?.[1]?.trim();
  if (!bullet || /^none\.?$/i.test(bullet)) return undefined;
  const normalized = bullet
    .replace(/^`+|`+$/g, "")
    .replace(/^["“”']+|["“”']+$/g, "")
    .trim();
  if (!normalized || /^none\.?$/i.test(normalized)) return undefined;
  const tagged = normalized.match(/^(project-fact|pattern|tooling|testing|workflow|bugfix|validation|artifact|decision|preference|architecture|safety|security|failure|agent-note)\s*:\s*(.+)$/i);
  if (tagged?.[1] && tagged[2]) {
    const category = tagged[1].toLowerCase();
    return { category, content: tagged[2].trim(), confidence: category === "agent-note" ? 0.7 : 0.9 };
  }
  return { category: "agent-note", content: normalized, confidence: 0.7 };
}
