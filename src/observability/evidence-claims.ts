import type { EvidenceClaim, EvidenceClaimKind, EvidenceKind } from "../domain/schemas.ts";
import { isRecord } from "../utils/guards.ts";

const CLAIM_KIND_ALIASES: Record<string, EvidenceClaimKind> = {
  "stable-fact": "stable-fact",
  fact: "stable-fact",
  stable: "stable-fact",
  convention: "stable-fact",
  "transient-status": "transient-status",
  transient: "transient-status",
  "current-status": "transient-status",
  status: "transient-status",
  "negative-claim": "negative-claim",
  negative: "negative-claim",
  absent: "negative-claim",
  missing: "negative-claim",
  unknown: "unknown",
  gap: "unknown",
  unresolved: "unknown",
  contradiction: "contradiction",
  conflict: "contradiction",
};

const EVIDENCE_KIND_ALIASES: Record<string, EvidenceKind> = {
  read: "read",
  file: "read",
  search: "search",
  grep: "search",
  "verified-command": "verified-command",
  command: "verified-command",
  verification: "verified-command",
  partial: "partial",
  preview: "partial",
  handoff: "handoff",
  inference: "inference",
  none: "none",
};

export interface ClaimLedgerParseResult {
  claims: EvidenceClaim[];
  warnings: string[];
}

export function parseClaimLedger(raw: string, sourceAgent: string): ClaimLedgerParseResult {
  const section = extractClaimLedgerSection(raw);
  if (!section) return { claims: [], warnings: [] };
  const warnings: string[] = [];
  const jsonText = extractJsonPayload(section);
  const parsed = parseJson(jsonText);
  if (parsed === undefined) return { claims: [], warnings: ["Claim Ledger was present but was not valid JSON."] };
  const entries = Array.isArray(parsed) ? parsed : isRecord(parsed) && Array.isArray(parsed.claims) ? parsed.claims : undefined;
  if (!entries) return { claims: [], warnings: ["Claim Ledger must be a JSON array or an object with a claims array."] };
  const claims = entries
    .map((entry, index) => normalizeClaim(entry, sourceAgent, index, warnings))
    .filter((claim): claim is EvidenceClaim => Boolean(claim))
    .slice(0, 20);
  if (claims.length === 0) warnings.push("Claim Ledger was present but contained no valid claims.");
  return { claims, warnings };
}

export function claimsNeedingAudit(claims: EvidenceClaim[] | undefined): EvidenceClaim[] {
  return (claims ?? []).filter((claim) => claimNeedsAudit(claim));
}

export function claimsRequireAudit(claims: EvidenceClaim[] | undefined): boolean {
  return claimsNeedingAudit(claims).length > 0;
}

export function claimNeedsAudit(claim: EvidenceClaim): boolean {
  if (claim.kind === "contradiction" || claim.kind === "unknown") return true;
  if (claim.kind === "negative-claim") return claim.evidence.length === 0 || claim.confidence < 0.75 || claim.evidenceKind === "none" || claim.evidenceKind === "inference";
  if (claim.kind === "transient-status") return claim.evidenceKind !== "verified-command";
  return false;
}

export function candidateMatchesTransientClaim(content: string, claims: EvidenceClaim[] | undefined): boolean {
  const transientClaims = (claims ?? []).filter((claim) => claim.kind === "transient-status");
  if (transientClaims.length === 0) return false;
  const normalizedContent = normalizeClaimText(content);
  if (!normalizedContent) return false;
  return transientClaims.some((claim) => {
    const normalizedClaim = normalizeClaimText([claim.subject, claim.summary].filter(Boolean).join(" "));
    if (!normalizedClaim) return false;
    if (normalizedContent.includes(normalizedClaim) || normalizedClaim.includes(normalizedContent)) return true;
    return tokenOverlap(normalizedContent, normalizedClaim) >= 0.56;
  });
}

export function isTransientVerificationStateClaim(text: string): boolean {
  const normalized = normalizeClaimText(text);
  if (!normalized) return false;
  if (!hasVerificationSubject(normalized)) return false;
  if (hasWeakVerificationEvidence(normalized)) return true;
  return hasCurrentStateLanguage(normalized) && hasVerificationOutcome(normalized);
}

export function sanitizeTransientVerificationClaims(text: string): { text: string; warnings: string[] } {
  const warnings: string[] = [];
  const lines = text.split("\n").map((line) => {
    if (!isTransientVerificationStateClaim(line)) return line;
    warnings.push("transient verification claim was marked unverified");
    return `${line} [unverified transient status; require a real non-dry-run command before reporting as current state]`;
  });
  return { text: lines.join("\n"), warnings };
}

function normalizeClaimText(text: string): string {
  return text
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function extractClaimLedgerSection(raw: string): string | undefined {
  return raw.match(/##\s*Claim Ledger\s*\n([\s\S]*?)(?:\n##\s|$)/i)?.[1]?.trim();
}

function extractJsonPayload(section: string): string {
  return section.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1]?.trim() ?? section.trim();
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function normalizeClaim(entry: unknown, sourceAgent: string, index: number, warnings: string[]): EvidenceClaim | undefined {
  if (!isRecord(entry)) {
    warnings.push(`Claim Ledger entry ${index + 1} is not an object.`);
    return undefined;
  }
  const kind = normalizeClaimKind(entry.kind);
  const subject = stringValue(entry.subject);
  const summary = stringValue(entry.summary ?? entry.claim);
  if (!kind || !subject || !summary) {
    warnings.push(`Claim Ledger entry ${index + 1} is missing kind, subject, or summary.`);
    return undefined;
  }
  const evidence = stringArray(entry.evidence);
  const evidenceKind = normalizeEvidenceKind(entry.evidenceKind ?? entry.evidence_kind);
  return {
    kind,
    subject,
    summary,
    evidence,
    ...(evidenceKind ? { evidenceKind } : {}),
    confidence: clampConfidence(entry.confidence),
    sourceAgent,
  };
}

function normalizeClaimKind(value: unknown): EvidenceClaimKind | undefined {
  const key = stringValue(value)?.toLowerCase().replace(/[_\s]+/g, "-");
  return key ? CLAIM_KIND_ALIASES[key] : undefined;
}

function normalizeEvidenceKind(value: unknown): EvidenceKind | undefined {
  const key = stringValue(value)?.toLowerCase().replace(/[_\s]+/g, "-");
  return key ? EVIDENCE_KIND_ALIASES[key] : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((item) => stringValue(item)).filter((item): item is string => Boolean(item)).slice(0, 8);
}

function clampConfidence(value: unknown): number {
  const numeric = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(numeric)) return 0.7;
  return Math.max(0, Math.min(1, numeric));
}


function tokenOverlap(left: string, right: string): number {
  const leftTokens = meaningfulTokens(left);
  const rightTokens = meaningfulTokens(right);
  if (leftTokens.size === 0 || rightTokens.size === 0) return 0;
  const shared = [...leftTokens].filter((token) => rightTokens.has(token)).length;
  return shared / Math.min(leftTokens.size, rightTokens.size);
}

function meaningfulTokens(text: string): Set<string> {
  return new Set(text.split(/[^a-z0-9/-]+/i).filter((token) => token.length >= 4));
}

function hasVerificationSubject(text: string): boolean {
  return /\b(test|tests|suite|specs?|typecheck|build|lint|evals?|ci|verification|validation|pruebas?|tests?|validacion|verificacion)\b/.test(text);
}

function hasWeakVerificationEvidence(text: string): boolean {
  return /\b(dry[- ]?run|preview|inventory|inventario|grep count|partial logs?|logs? parciales?|not executed|no ejecutad[oa]s?|would run|no corrid[oa]s?|head -|tail -)\b/.test(text);
}

function hasCurrentStateLanguage(text: string): boolean {
  return /\b(currently|current|now|today|actualmente|actual|ahora|hoy|at the moment|en este momento)\b/.test(text);
}

function hasVerificationOutcome(text: string): boolean {
  return /\b(fail(?:ed|ing|s)?|pass(?:ed|ing|es)?|red|green|broken|failing|passing|fall(?:a|an|ando|o)|pasa(?:n|ndo)?|rojo|verde|exitos[oa]s?|fallid[oa]s?)\b/.test(text);
}
