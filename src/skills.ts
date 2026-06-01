import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { Effect } from "effect";
import { DEFAULT_CONFIG, type ChalinConfig } from "./config.ts";
import { createSkillTraceEvent, type SkillTraceEvent } from "./observability.ts";
import { resolveChalinPaths, type ChalinPathsOptions } from "./paths.ts";
import {
  isAgentCapability,
  isAgentConcern,
  isSkillActivation,
  isSkillLifecycle,
  isSkillScope,
  isSkillScriptPolicy,
  isSkillTrust,
  riskRank,
  type AgentCapability,
  type AgentConcern,
  type AgentDefinition,
  type RejectedSkill,
  type ResolvedSkill,
  type RouteKind,
  type RouteRisk,
  type SkillActivation,
  type SkillDefinition,
  type SkillLifecycle,
  type SkillScope,
  type SkillTrust,
} from "./schemas.ts";

interface ParsedSkillFrontmatter {
  frontmatter: Record<string, string | string[]>;
  body: string;
}

interface SkillFileEnvelope {
  metadata: string;
  bodyLoaded: boolean;
}

export interface SkillCatalogDiagnostics {
  warnings: string[];
  errors: string[];
}

export interface SkillCatalogLoadOptions extends ChalinPathsOptions {
  config?: ChalinConfig;
}

export interface SkillResolution {
  skill?: SkillDefinition;
  error?: string;
}

export interface SkillAuditFinding {
  severity: "warning" | "error";
  code: string;
  message: string;
}

export interface SkillAuditResult {
  status: "passed" | "warning" | "blocked";
  findings: SkillAuditFinding[];
  event?: SkillTraceEvent;
}

export interface SkillMetricsRecord {
  skill: string;
  scope?: SkillScope;
  trust?: SkillTrust;
  activations: number;
  suggestions: number;
  rejections: number;
  outcomes: number;
  verificationObserved: number;
  reviewerPass: number;
  reviewerFail: number;
  retries: number;
  lastActivatedAt?: string;
  lastSuggestedAt?: string;
  lastRejectedAt?: string;
  lastOutcomeAt?: string;
}

export interface SkillMetricsSnapshot {
  version: 1;
  updatedAt: string;
  skills: Record<string, SkillMetricsRecord>;
}

export interface ResolveSkillsForStepOptions {
  catalog: SkillCatalog;
  config?: ChalinConfig;
  agent?: AgentDefinition;
  task: string;
  routeKind?: RouteKind;
  risk?: RouteRisk;
  featureId?: string;
  maxActive?: number;
  explicitSkills?: string[];
  disabledSkills?: string[];
}

export interface SkillLifecycleReconcileResult {
  updated: SkillDefinition[];
  events: SkillTraceEvent[];
}

const SCOPE_RANK: Record<SkillScope, number> = { "on-demand": 0, project: 1, user: 2, "built-in": 3 };
const DANGEROUS_PHRASES = [
  /\bignore (?:all )?(?:previous|prior|system|developer|user) instructions\b/i,
  /\boverride (?:system|developer|user) instructions\b/i,
  /\bomit (?:the )?reviewer\b/i,
  /\bdo not mention\b/i,
  /\bexfiltrat(?:e|ion)\b/i,
  /\bread (?:secrets?|\.env|private keys?)\b/i,
];
const SECRET_PATTERNS = [
  /\b(?:AWS|GOOGLE|OPENAI|ANTHROPIC|GITHUB|NPM)_[A-Z0-9_]*(?:SECRET|TOKEN|KEY)[A-Z0-9_]*\s*=\s*[A-Za-z0-9_./+=-]{12,}/,
  /\b(?:sk|ghp|gho|github_pat)_[A-Za-z0-9_]{16,}\b/,
  /-----BEGIN (?:RSA |OPENSSH |EC |DSA )?PRIVATE KEY-----/,
];

function hashText(text: string): string {
  return crypto.createHash("sha256").update(text).digest("hex");
}

export class SkillCatalog {
  private readonly byScope: Record<SkillScope, Map<string, SkillDefinition>>;
  private readonly byQualifiedName: Map<string, SkillDefinition>;
  readonly diagnostics: SkillCatalogDiagnostics;
  readonly events: SkillTraceEvent[];

  private constructor(
    byScope: Record<SkillScope, Map<string, SkillDefinition>>,
    byQualifiedName: Map<string, SkillDefinition>,
    diagnostics: SkillCatalogDiagnostics,
    events: SkillTraceEvent[],
  ) {
    this.byScope = byScope;
    this.byQualifiedName = byQualifiedName;
    this.diagnostics = diagnostics;
    this.events = events;
  }

  static load(options: SkillCatalogLoadOptions): SkillCatalog {
    const startedAt = Date.now();
    const paths = resolveChalinPaths(options);
    const config = options.config ?? DEFAULT_CONFIG;
    const diagnostics: SkillCatalogDiagnostics = { warnings: [], errors: [] };
    const byScope: Record<SkillScope, Map<string, SkillDefinition>> = {
      "built-in": new Map(),
      project: new Map(),
      user: new Map(),
      "on-demand": new Map(),
    };
    const byQualifiedName = new Map<string, SkillDefinition>();

    if (config.skills.enabled) {
      loadSkillDir(paths.builtInSkillsDir, "built-in", byScope, byQualifiedName, diagnostics);
      if (config.skills.allowUserSkills) loadSkillDir(paths.userSkillsDir, "user", byScope, byQualifiedName, diagnostics);
      if (config.skills.allowProjectSkills) loadSkillDir(paths.projectSkillsDir, "project", byScope, byQualifiedName, diagnostics);
      if (config.skills.allowOnDemandSkills) loadOnDemandSkills(paths.projectOnDemandSkillsDir, byScope, byQualifiedName, diagnostics);
    }

    recordShadowingDiagnostics(byScope, diagnostics);
    const durationMs = Date.now() - startedAt;
    const events = (["built-in", "user", "project", "on-demand"] as const).map((scope) => createSkillTraceEvent({
      type: "skill.catalog.loaded",
      scope,
      reason: config.skills.enabled ? "loaded" : "skills disabled",
      metadata: {
        count: byScope[scope].size,
        durationMs,
        errors: diagnostics.errors.length,
        warnings: diagnostics.warnings.length,
      },
    }));
    return new SkillCatalog(byScope, byQualifiedName, diagnostics, events);
  }

  list(scope?: SkillScope): SkillDefinition[] {
    const scopes = scope ? [scope] : (["on-demand", "project", "user", "built-in"] as const);
    return scopes.flatMap((currentScope) => [...this.byScope[currentScope].values()]).sort(compareSkills);
  }

  resolve(reference: string): SkillResolution {
    const trimmed = reference.trim();
    if (!trimmed) return { error: "Skill reference must not be empty." };
    const normalized = normalizeSkillReference(trimmed);
    const qualified = this.byQualifiedName.get(normalized);
    if (qualified) return { skill: qualified };

    if (trimmed.includes(":")) return { error: `Skill '${trimmed}' not found.` };
    for (const scope of ["on-demand", "project", "user", "built-in"] as const) {
      const skill = this.byScope[scope].get(trimmed);
      if (skill && (scope !== "on-demand" || skill.lifecycle === "active")) return { skill };
    }
    for (const scope of ["on-demand", "project", "user", "built-in"] as const) {
      const skill = this.byScope[scope].get(trimmed);
      if (skill) return { skill };
    }
    return { error: `Skill '${trimmed}' not found. Available skills: ${this.list().map((skill) => skill.qualifiedName).join(", ") || "none"}.` };
  }

  search(task: string, options: Omit<ResolveSkillsForStepOptions, "catalog" | "task"> = {}): ReturnType<typeof resolveSkillsForStep> {
    return resolveSkillsForStep({ ...options, catalog: this, task });
  }
}

export function resolveSkillsForStep(options: ResolveSkillsForStepOptions): {
  active: ResolvedSkill[];
  suggested: ResolvedSkill[];
  rejected: RejectedSkill[];
  events: SkillTraceEvent[];
} {
  const config = options.config ?? DEFAULT_CONFIG;
  const rejected: RejectedSkill[] = [];
  const suggested: ResolvedSkill[] = [];
  const candidates: ResolvedSkill[] = [];
  const explicit = new Set(options.explicitSkills ?? []);
  const disabled = new Set((options.disabledSkills ?? []).flatMap((reference) => disabledReferences(reference)));
  const events: SkillTraceEvent[] = [createSkillTraceEvent({
    type: "skill.match.started",
    agent: options.agent?.name,
    reason: options.task.slice(0, 160),
    metadata: {
      taskHash: hashText(options.task).slice(0, 16),
      routeKind: options.routeKind ?? "unknown",
      risk: options.risk ?? "unknown",
    },
  })];
  if (!config.skills.enabled) return { active: [], suggested: [], rejected: [], events };

  const explicitSkills = [...explicit].flatMap((reference) => {
    const resolved = options.catalog.resolve(reference);
    return resolved.skill ? [resolved.skill] : [];
  });
  const allSkills = uniqueSkills([...explicitSkills, ...options.catalog.list()]);
  for (const skill of allSkills) {
    if (disabled.has(skill.name) || disabled.has(skill.qualifiedName)) {
      const item = { skill, reason: "disabled for this turn", policy: "runtime" };
      rejected.push(item);
      events.push(skillEvent("skill.activation.rejected", skill, item.reason, options, item.policy));
      continue;
    }
    const isExplicit = explicit.has(skill.name) || explicit.has(skill.qualifiedName);
    const rejection = rejectionReason(skill, options, config, isExplicit, false);
    if (rejection) {
      rejected.push({ skill, reason: rejection.reason, policy: rejection.policy });
      if (rejection.policy === "lifecycle") {
        events.push(skillEvent("skill.stale.detected", skill, rejection.reason, options));
      }
      events.push(skillEvent("skill.activation.rejected", skill, rejection.reason, options, rejection.policy));
      continue;
    }
    const match = matchSkill(skill, options.task, explicit.has(skill.name) || explicit.has(skill.qualifiedName));
    if (!match.matched) {
      rejected.push({ skill, reason: match.reason });
      events.push(skillEvent("skill.activation.rejected", skill, match.reason, options));
      continue;
    }
    const governance = rejectionReason(skill, options, config, isExplicit, true);
    if (governance) {
      rejected.push({ skill, reason: governance.reason, policy: governance.policy });
      events.push(skillEvent("skill.activation.rejected", skill, governance.reason, options, governance.policy));
      continue;
    }
    const resolved = { skill: loadSkillBody(skill), reason: match.reason };
    if (skill.activation === "manual" && !isExplicit) {
      suggested.push(resolved);
      events.push(skillEvent("skill.match.result", skill, `suggested: ${match.reason}`, options));
    } else if (skill.activation === "suggested") {
      suggested.push(resolved);
      events.push(skillEvent("skill.match.result", skill, `suggested: ${match.reason}`, options));
    } else {
      candidates.push(resolved);
    }
  }

  const withoutShadowed = dropShadowed(candidates);
  const active: ResolvedSkill[] = [];
  const cap = options.maxActive ?? maxActiveForRoute(options.routeKind, config);
  for (const item of withoutShadowed) {
    if (active.length >= cap) {
      rejected.push({ skill: item.skill, reason: `composition cap ${cap} reached` });
      events.push(skillEvent("skill.activation.rejected", item.skill, `composition cap ${cap} reached`, options));
      continue;
    }
    const conflict = active.find((current) => !canCoexist(current.skill, item.skill));
    if (conflict) {
      rejected.push({ skill: item.skill, reason: `conflicts with active skill ${conflict.skill.qualifiedName}` });
      events.push(skillEvent("skill.activation.rejected", item.skill, `conflicts with active skill ${conflict.skill.qualifiedName}`, options));
      continue;
    }
    active.push(item);
    events.push(skillEvent("skill.activation.applied", item.skill, item.reason, options));
  }
  events.push(createSkillTraceEvent({
    type: "skill.match.result",
    agent: options.agent?.name,
    reason: `${active.length} active, ${suggested.length} suggested, ${rejected.length} rejected`,
    metadata: { active: active.length, suggested: suggested.length, rejected: rejected.length },
  }));
  return { active, suggested, rejected, events };
}

function skillEvent(type: SkillTraceEvent["type"], skill: SkillDefinition, reason: string, options: ResolveSkillsForStepOptions, policy?: string): SkillTraceEvent {
  return createSkillTraceEvent({
    type,
    skill: skill.qualifiedName,
    scope: skill.scope,
    trust: skill.trust,
    policy,
    agent: options.agent?.name,
    reason,
  });
}

export function auditSkill(skill: SkillDefinition, config: ChalinConfig = DEFAULT_CONFIG): SkillAuditResult {
  const auditedSkill = loadSkillBody(skill);
  const findings: SkillAuditFinding[] = [];
  if (!auditedSkill.name) findings.push(error("missing-name", "Skill name is required."));
  if (!auditedSkill.description || auditedSkill.description.length < 12) findings.push(error("weak-description", "Skill description must be specific."));
  if (!auditedSkill.body.trim()) findings.push(error("empty-body", "Skill body must not be empty."));
  if (auditedSkill.trust === "blocked" || auditedSkill.lifecycle === "blocked") findings.push(error("blocked-skill", "Skill is blocked by metadata."));
  if (auditedSkill.triggers.some((trigger) => trigger.trim().length < 3 || /^(code|task|file|project|work|todo)$/i.test(trigger.trim()))) {
    findings.push(warn("broad-trigger", "Triggers should be specific enough to avoid overmatching."));
  }
  const text = `${serializeSkillMetadata(auditedSkill)}\n${auditedSkill.body}`;
  if (hasDangerousSkillInstruction(text)) findings.push(error("prompt-injection", "Skill tries to alter instruction hierarchy or reviewer gates."));
  if (hasSecretLikeValue(text)) findings.push(error("secret", "Skill appears to contain a secret or credential-like value."));
  findings.push(...auditSkillResources(auditedSkill));
  if (auditedSkill.scripts !== "disabled" && !config.skills.allowSkillScripts) findings.push(error("scripts-disabled", "Skill scripts are disabled by configuration."));
  if (auditedSkill.scripts !== "disabled" && auditedSkill.trust !== "trusted" && auditedSkill.trust !== "reviewed") findings.push(error("untrusted-script", "Untrusted skills cannot enable scripts."));
  if (auditedSkill.trust === "untrusted" && auditedSkill.activation === "auto") findings.push(error("untrusted-auto", "Untrusted skills cannot auto-activate."));
  const status = findings.some((finding) => finding.severity === "error") ? "blocked" : findings.length > 0 ? "warning" : "passed";
  return {
    status,
    findings,
    event: createSkillTraceEvent({
      type: "skill.audit.result",
      skill: auditedSkill.qualifiedName,
      scope: auditedSkill.scope,
      trust: auditedSkill.trust,
      reason: status,
      metadata: {
        findings: findings.length,
        errors: findings.filter((finding) => finding.severity === "error").length,
        warnings: findings.filter((finding) => finding.severity === "warning").length,
      },
    }),
  };
}

export function effectiveSkillToolNames(baseTools: string[], skills: SkillDefinition[]): string[] {
  let allowed = new Set(baseTools);
  for (const skill of skills) {
    if (skill.allowedTools.length > 0) {
      allowed = intersectSets(allowed, new Set(skill.allowedTools));
    }
    for (const denied of skill.deniedTools) allowed.delete(denied);
  }
  return [...allowed].sort();
}

export function formatActiveSkillsForPrompt(skills: ResolvedSkill[], maxBodyLines = 12): string | undefined {
  if (skills.length === 0) return undefined;
  return [
    "## Active Skills",
    "",
    ...skills.flatMap(({ skill, reason }) => {
      const activeSkill = loadSkillBody(skill);
      return [
        `### ${activeSkill.name}`,
        `Source: ${activeSkill.scope}${activeSkill.featureId ? `:${activeSkill.featureId}` : ""} · Trust: ${activeSkill.trust} · Activation: ${activeSkill.activation}`,
        `Use when: ${activeSkill.description}`,
        `Activated because: ${reason}`,
        activeSkill.allowedTools.length || activeSkill.deniedTools.length
          ? `Tool policy: allow ${activeSkill.allowedTools.join(", ") || "base policy"}; deny ${activeSkill.deniedTools.join(", ") || "none"}.`
          : undefined,
        "Rules:",
        ...compactSkillBody(activeSkill.body, maxBodyLines),
        "",
      ].filter((line): line is string => Boolean(line));
    }),
  ].join("\n").trim();
}

export function promoteSkill(options: {
  cwd: string;
  userRoot?: string;
  packageRoot?: string;
  reference: string;
  targetScope: "project" | "user";
  reviewedBy?: string;
}): { skill: SkillDefinition; audit: SkillAuditResult; path: string; events: SkillTraceEvent[] } {
  const catalog = SkillCatalog.load(options);
  const source = catalog.resolve(options.reference).skill;
  if (!source) throw new Error(`Cannot promote missing skill '${options.reference}'.`);
  const hydratedSource = loadSkillBody(source);
  const next = {
    ...hydratedSource,
    scope: options.targetScope,
    trust: "reviewed" as SkillTrust,
    lifecycle: "active" as SkillLifecycle,
    featureId: undefined,
    verifiedBy: options.reviewedBy ?? source.verifiedBy,
  };
  const audit = auditSkill(next, { ...DEFAULT_CONFIG, skills: { ...DEFAULT_CONFIG.skills, allowSkillScripts: false } });
  if (audit.status === "blocked") throw new Error(`Skill '${source.qualifiedName}' failed audit: ${audit.findings.map((finding) => finding.code).join(", ")}`);
  const paths = resolveChalinPaths(options);
  const targetDir = options.targetScope === "project" ? paths.projectSkillsDir : paths.userSkillsDir;
  const targetPath = path.join(targetDir, source.name, "SKILL.md");
  writeSkillFile(targetPath, next);
  const reloaded = loadSkillFile(targetPath, options.targetScope);
  return {
    skill: reloaded,
    audit,
    path: targetPath,
    events: [
      ...(audit.event ? [audit.event] : []),
      createSkillTraceEvent({
        type: "skill.promoted",
        skill: reloaded.qualifiedName,
        scope: reloaded.scope,
        trust: reloaded.trust,
        reason: `${source.scope} -> ${options.targetScope}`,
        metadata: {
          fromScope: hydratedSource.scope,
          toScope: options.targetScope,
          checksum: reloaded.checksum,
        },
      }),
    ],
  };
}

export function retireSkill(options: {
  cwd: string;
  userRoot?: string;
  packageRoot?: string;
  reference: string;
  lifecycle: Exclude<SkillLifecycle, "active" | "candidate">;
  actor?: string;
}): { skill: SkillDefinition; path: string; events: SkillTraceEvent[] } {
  const catalog = SkillCatalog.load(options);
  const skill = catalog.resolve(options.reference).skill;
  if (!skill) throw new Error(`Cannot retire missing skill '${options.reference}'.`);
  const hydratedSkill = loadSkillBody(skill);
  const next = { ...hydratedSkill, lifecycle: options.lifecycle };
  writeSkillFile(hydratedSkill.sourcePath, next, options.actor);
  const reloaded = loadSkillFile(skill.sourcePath, skill.scope, skill.featureId);
  return {
    skill: reloaded,
    path: skill.sourcePath,
    events: [createSkillTraceEvent({
      type: "skill.lifecycle.changed",
      skill: reloaded.qualifiedName,
      scope: reloaded.scope,
      trust: reloaded.trust,
      reason: `${hydratedSkill.lifecycle} -> ${options.lifecycle}`,
      metadata: {
        from: hydratedSkill.lifecycle,
        to: options.lifecycle,
        actor: options.actor ?? "unknown",
      },
    })],
  };
}

export class SkillMetricsStore {
  private readonly file: string;

  constructor(options: ChalinPathsOptions) {
    const paths = resolveChalinPaths(options);
    this.file = path.join(paths.projectArtifactsDir, "skill-metrics.json");
  }

  snapshot(): SkillMetricsSnapshot {
    return readSkillMetricsSnapshot(this.file);
  }

  recordEvents(events: readonly SkillTraceEvent[]): SkillMetricsSnapshot {
    const snapshot = this.snapshot();
    const now = new Date().toISOString();
    for (const event of events) {
      if (!event.skill) continue;
      const record = snapshot.skills[event.skill] ?? emptySkillMetricsRecord(event.skill);
      record.scope = event.scope && isSkillScope(event.scope) ? event.scope : record.scope;
      record.trust = event.trust && isSkillTrust(event.trust) ? event.trust : record.trust;
      if (event.type === "skill.activation.applied") {
        record.activations += 1;
        record.lastActivatedAt = event.at ?? now;
      } else if (event.type === "skill.match.result" && event.reason?.startsWith("suggested:")) {
        record.suggestions += 1;
        record.lastSuggestedAt = event.at ?? now;
      } else if (event.type === "skill.activation.rejected") {
        record.rejections += 1;
        record.lastRejectedAt = event.at ?? now;
      } else if (event.type === "skill.outcome.recorded") {
        record.outcomes += 1;
        record.lastOutcomeAt = event.at ?? now;
        const metadata = isRecord(event.metadata) ? event.metadata : {};
        if (metadata.verification === "observed") record.verificationObserved += 1;
        if (metadata.reviewerPass === "true") record.reviewerPass += 1;
        if (metadata.reviewerPass === "false") record.reviewerFail += 1;
        const retries = Number(metadata.retries ?? 0);
        if (Number.isFinite(retries) && retries > 0) record.retries += retries;
      }
      snapshot.skills[event.skill] = record;
    }
    snapshot.updatedAt = now;
    writeSkillMetricsSnapshot(this.file, snapshot);
    return snapshot;
  }
}

export function recordSkillMetricsEffect(options: ChalinPathsOptions, events: readonly SkillTraceEvent[]): Effect.Effect<SkillMetricsSnapshot> {
  return Effect.sync(() => new SkillMetricsStore(options).recordEvents(events)).pipe(Effect.withSpan("skills.metrics.record"));
}

export function reconcileSkillLifecyclesEffect(options: SkillCatalogLoadOptions): Effect.Effect<SkillLifecycleReconcileResult> {
  return Effect.sync(() => {
    const catalog = SkillCatalog.load(options);
    const updated: SkillDefinition[] = [];
    const events: SkillTraceEvent[] = [];
    for (const skill of catalog.list("on-demand")) {
      if (skill.lifecycle !== "expired") continue;
      const hydrated = loadSkillBody(skill);
      writeSkillFile(hydrated.sourcePath, hydrated);
      updated.push(loadSkillFile(hydrated.sourcePath, hydrated.scope, hydrated.featureId));
      events.push(createSkillTraceEvent({
        type: "skill.lifecycle.changed",
        skill: hydrated.qualifiedName,
        scope: hydrated.scope,
        trust: hydrated.trust,
        reason: "expired by expiresAt",
        metadata: {
          from: "candidate",
          to: "expired",
          ...(hydrated.expiresAt ? { expiresAt: hydrated.expiresAt } : {}),
        },
      }));
    }
    return { updated, events };
  }).pipe(Effect.withSpan("skills.lifecycle.reconcile"));
}

export function summarizeSkillMetrics(snapshot: SkillMetricsSnapshot): string {
  const records = Object.values(snapshot.skills).sort((a, b) => b.activations - a.activations || a.skill.localeCompare(b.skill));
  if (records.length === 0) return "No skill metrics recorded yet.";
  return [
    `Skill metrics (${records.length})`,
    ...records.map((record) => [
      `- ${record.skill}`,
      `activations=${record.activations}`,
      `suggestions=${record.suggestions}`,
      `rejections=${record.rejections}`,
      `outcomes=${record.outcomes}`,
      `verified=${record.verificationObserved}`,
      `reviewerPass=${record.reviewerPass}`,
      `reviewerFail=${record.reviewerFail}`,
      `retries=${record.retries}`,
    ].join(" · ")),
  ].join("\n");
}

export function formatSkillList(catalog: SkillCatalog): string {
  const skills = catalog.list();
  if (skills.length === 0) return "No pi-chalin skills found.";
  return [
    `Skills (${skills.length})`,
    ...skills.map((skill) => {
      const flags = [
        skill.qualifiedName,
        `trust=${skill.trust}`,
        `lifecycle=${skill.lifecycle}`,
        `activation=${skill.activation}`,
        skill.extends.length ? `extends=${skill.extends.join(",")}` : undefined,
        skill.diagnostics.length ? `diagnostics=${skill.diagnostics.length}` : undefined,
      ].filter(Boolean).join(" · ");
      return `- ${flags}: ${skill.description}`;
    }),
    ...catalog.diagnostics.warnings.map((warning) => `- warning: ${warning}`),
  ].join("\n");
}

export function formatSkillShow(skill: SkillDefinition, audit: SkillAuditResult = auditSkill(skill)): string {
  const shownSkill = loadSkillBody(skill);
  return [
    `${shownSkill.qualifiedName}`,
    shownSkill.description,
    `scope: ${shownSkill.scope}`,
    `trust: ${shownSkill.trust}`,
    `lifecycle: ${shownSkill.lifecycle}`,
    `activation: ${shownSkill.activation}`,
    `extends: ${shownSkill.extends.join(", ") || "none"}`,
    `concerns: ${shownSkill.concerns.join(", ") || "any"}`,
    `capabilities: ${shownSkill.capabilities.join(", ") || "any"}`,
    `triggers: ${shownSkill.triggers.join(", ") || "none"}`,
    `tools: allow ${shownSkill.allowedTools.join(", ") || "base"}; deny ${shownSkill.deniedTools.join(", ") || "none"}`,
    `scripts: ${shownSkill.scripts}`,
    `resources: ${shownSkill.resources.join(", ") || "none"}`,
    `source: ${shownSkill.sourcePath}`,
    `checksum: ${shownSkill.checksum}`,
    `bodyLoaded: ${shownSkill.bodyLoaded ? "true" : "false"}`,
    `audit: ${audit.status}${audit.findings.length ? ` (${audit.findings.map((finding) => finding.code).join(", ")})` : ""}`,
    "",
    shownSkill.body,
  ].join("\n");
}

export function formatSkillSearch(task: string, result: ReturnType<typeof resolveSkillsForStep>): string {
  return [
    `Skill search for: ${task}`,
    result.active.length ? "Active:" : "Active: none",
    ...result.active.map((item) => `- ${item.skill.qualifiedName}: ${item.reason}`),
    result.suggested.length ? "Suggested:" : "Suggested: none",
    ...result.suggested.map((item) => `- ${item.skill.qualifiedName}: ${item.reason}`),
    result.rejected.length ? "Rejected:" : "Rejected: none",
    ...result.rejected.slice(0, 12).map((item) => `- ${item.skill.qualifiedName}: ${item.reason}`),
  ].join("\n");
}

function rejectionReason(
  skill: SkillDefinition,
  options: ResolveSkillsForStepOptions,
  config: ChalinConfig,
  explicit: boolean,
  includeAudit: boolean,
): { reason: string; policy?: string } | undefined {
  if (skill.lifecycle === "blocked" || skill.lifecycle === "expired") return { reason: `lifecycle ${skill.lifecycle}`, policy: "lifecycle" };
  if (skill.lifecycle === "stale") return { reason: "stale skills require manual review", policy: "lifecycle" };
  const freshness = freshnessRejection(skill, config);
  if (freshness && !explicit) return freshness;
  if (skill.scope === "on-demand" && skill.lifecycle !== "active" && !explicit) return { reason: "on-demand candidate is not active for this feature", policy: "lifecycle" };
  if (skill.scope === "on-demand" && options.featureId && skill.featureId !== options.featureId) return { reason: `feature mismatch: ${skill.featureId ?? "unknown"}`, policy: "scope" };
  if (options.agent && !skill.extends.includes(options.agent.name) && !skill.extends.includes(options.agent.concern) && !skill.extends.includes("*")) return { reason: `agent ${options.agent.name} is incompatible`, policy: "agent" };
  if (options.agent && skill.concerns.length > 0 && !skill.concerns.includes(options.agent.concern)) return { reason: `concern ${options.agent.concern} is incompatible`, policy: "concern" };
  if (options.agent && skill.capabilities.length > 0 && !skill.capabilities.some((capability) => options.agent?.capabilities.includes(capability))) return { reason: "capability mismatch", policy: "capability" };
  if (options.risk && riskRank(skill.risk) < riskRank(options.risk) && skill.risk === "low" && options.risk !== "low") return { reason: `risk ${options.risk} exceeds skill risk ${skill.risk}`, policy: "risk" };
  if (includeAudit) {
    const audit = auditSkill(skill, config);
    if (audit.status === "blocked") return { reason: `audit blocked: ${audit.findings.map((finding) => finding.code).join(", ")}`, policy: "audit" };
  }
  if (!config.skills.autoActivation && skill.activation === "auto" && !explicit) return { reason: "auto activation disabled", policy: "config" };
  if (skill.activation === "auto" && !explicit) {
    if (skill.scope === "built-in" && skill.trust === "trusted") return undefined;
    if (skill.scope === "project" && config.skills.requireAuditForProjectSkills && skill.trust !== "reviewed" && skill.trust !== "trusted") return { reason: "project skill requires reviewed trust before auto activation", policy: "trust" };
    if (skill.scope === "user" && config.skills.requireAuditForUserSkills && skill.trust !== "reviewed" && skill.trust !== "trusted") return { reason: "user skill requires reviewed trust before auto activation", policy: "trust" };
    if (skill.trust !== "trusted" && skill.trust !== "reviewed") return { reason: `trust ${skill.trust} cannot auto-activate`, policy: "trust" };
  }
  return undefined;
}

function freshnessRejection(skill: SkillDefinition, config: ChalinConfig): { reason: string; policy: string } | undefined {
  const now = Date.now();
  const expiresAt = skill.expiresAt ? Date.parse(skill.expiresAt) : Number.NaN;
  if (Number.isFinite(expiresAt) && expiresAt <= now) return { reason: `expired at ${skill.expiresAt}`, policy: "lifecycle" };
  const lastVerifiedAt = skill.lastVerifiedAt ? Date.parse(skill.lastVerifiedAt) : Number.NaN;
  if (Number.isFinite(lastVerifiedAt) && config.skills.staleAfterDays > 0) {
    const staleAt = lastVerifiedAt + config.skills.staleAfterDays * 24 * 60 * 60 * 1000;
    if (staleAt <= now) return { reason: `stale: last verified at ${skill.lastVerifiedAt}`, policy: "lifecycle" };
  }
  return undefined;
}

function matchSkill(skill: SkillDefinition, task: string, explicit: boolean): { matched: boolean; reason: string } {
  if (explicit) return { matched: true, reason: "explicit skill request" };
  const normalizedTask = task.toLowerCase();
  const matchedTrigger = skill.triggers.find((trigger) => normalizedTask.includes(trigger.toLowerCase()));
  if (matchedTrigger) return { matched: true, reason: `trigger:${matchedTrigger}` };
  const words = skill.name.split(/[-_\s]+/).filter((word) => word.length >= 4);
  if (words.length > 0 && words.every((word) => normalizedTask.includes(word.toLowerCase()))) return { matched: true, reason: `name:${skill.name}` };
  return { matched: false, reason: "no trigger matched" };
}

function maxActiveForRoute(routeKind: RouteKind | undefined, config: ChalinConfig): number {
  if (routeKind === "bypass") return config.skills.maxActiveDirect;
  if (routeKind === "single-agent") return config.skills.maxActivePerStep;
  if (routeKind === "multi-agent-dag" || routeKind === "multi-agent-chain" || routeKind === "multi-agent-parallel") return config.skills.maxActivePerStep;
  return config.skills.maxActiveDirect;
}

function canCoexist(a: SkillDefinition, b: SkillDefinition): boolean {
  if (a.maxActiveWith.length === 0 && b.maxActiveWith.length === 0) return true;
  return a.maxActiveWith.includes(b.name) || a.maxActiveWith.includes(b.qualifiedName) || b.maxActiveWith.includes(a.name) || b.maxActiveWith.includes(a.qualifiedName);
}

function dropShadowed(candidates: ResolvedSkill[]): ResolvedSkill[] {
  const byName = new Map<string, ResolvedSkill>();
  for (const candidate of candidates.sort((a, b) => compareSkills(a.skill, b.skill))) {
    if (!byName.has(candidate.skill.name)) byName.set(candidate.skill.name, candidate);
  }
  return [...byName.values()];
}

function uniqueSkills(skills: SkillDefinition[]): SkillDefinition[] {
  const seen = new Set<string>();
  const result: SkillDefinition[] = [];
  for (const skill of skills) {
    if (seen.has(skill.qualifiedName)) continue;
    seen.add(skill.qualifiedName);
    result.push(skill);
  }
  return result;
}

function loadSkillDir(
  dir: string,
  scope: SkillScope,
  byScope: Record<SkillScope, Map<string, SkillDefinition>>,
  byQualifiedName: Map<string, SkillDefinition>,
  diagnostics: SkillCatalogDiagnostics,
): void {
  if (!fs.existsSync(dir)) return;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (error) {
    diagnostics.errors.push(`Failed to read ${scope} skills dir '${dir}': ${errorMessage(error)}`);
    return;
  }
  for (const entry of entries) {
    const skillPath = entry.isDirectory() ? path.join(dir, entry.name, "SKILL.md") : entry.isFile() && entry.name.endsWith(".md") ? path.join(dir, entry.name) : "";
    if (!skillPath || !fs.existsSync(skillPath)) continue;
    addSkill(loadSkillFile(skillPath, scope), byScope, byQualifiedName, diagnostics);
  }
}

function loadOnDemandSkills(
  featuresDir: string,
  byScope: Record<SkillScope, Map<string, SkillDefinition>>,
  byQualifiedName: Map<string, SkillDefinition>,
  diagnostics: SkillCatalogDiagnostics,
): void {
  if (!fs.existsSync(featuresDir)) return;
  for (const feature of fs.readdirSync(featuresDir, { withFileTypes: true })) {
    if (!feature.isDirectory()) continue;
    const skillsDir = path.join(featuresDir, feature.name, "skills");
    if (!fs.existsSync(skillsDir)) continue;
    for (const skillDir of fs.readdirSync(skillsDir, { withFileTypes: true })) {
      const skillPath = skillDir.isDirectory() ? path.join(skillsDir, skillDir.name, "SKILL.md") : "";
      if (skillPath && fs.existsSync(skillPath)) addSkill(loadSkillFile(skillPath, "on-demand", feature.name), byScope, byQualifiedName, diagnostics);
    }
  }
}

function addSkill(
  skill: SkillDefinition,
  byScope: Record<SkillScope, Map<string, SkillDefinition>>,
  byQualifiedName: Map<string, SkillDefinition>,
  diagnostics: SkillCatalogDiagnostics,
): void {
  if (byScope[skill.scope].has(skill.name)) diagnostics.warnings.push(`${skill.sourcePath}: duplicate skill '${skill.name}' in ${skill.scope}; later definition overwrote earlier one.`);
  byScope[skill.scope].set(skill.name, skill);
  byQualifiedName.set(skill.qualifiedName, skill);
  for (const diagnostic of skill.diagnostics) diagnostics.warnings.push(`${skill.sourcePath}: ${diagnostic}`);
}

function loadSkillFile(filePath: string, scope: SkillScope, featureId?: string): SkillDefinition {
  const diagnostics: string[] = [];
  let envelope: SkillFileEnvelope = { metadata: "", bodyLoaded: false };
  try {
    envelope = readSkillFileEnvelope(filePath);
  } catch (error) {
    diagnostics.push(`invalid: failed to read skill file: ${errorMessage(error)}`);
  }
  const parsed = parseSkillFrontmatter(envelope.metadata);
  const fileName = path.basename(path.dirname(filePath));
  const declaredScope = stringValue(parsed.frontmatter.scope);
  const effectiveScope = declaredScope && isSkillScope(declaredScope) ? declaredScope : scope;
  if (declaredScope && declaredScope !== scope && scope !== "on-demand") diagnostics.push(`scope '${declaredScope}' overridden by loader scope '${scope}'.`);
  const name = safeSkillName(stringValue(parsed.frontmatter.name) || fileName);
  if (!name) diagnostics.push("invalid: skill name must not be empty.");
  const body = parsed.body.trim();
  const trust = enumValue(stringValue(parsed.frontmatter.trust), isSkillTrust, effectiveScope === "built-in" ? "trusted" : effectiveScope === "on-demand" ? "untrusted" : "reviewed");
  const declaredLifecycle = enumValue(stringValue(parsed.frontmatter.lifecycle), isSkillLifecycle, effectiveScope === "on-demand" ? "candidate" : "active");
  const expiresAt = stringValue(parsed.frontmatter.expiresAt ?? parsed.frontmatter["expires-at"]) || undefined;
  const lifecycle = effectiveLifecycle(declaredLifecycle, expiresAt);
  const skill: SkillDefinition = {
    name,
    description: stringValue(parsed.frontmatter.description) || `${name} skill`,
    scope: effectiveScope,
    extends: parseList(parsed.frontmatter.extends, ["*"]),
    concerns: parseConcerns(parsed.frontmatter.concerns, diagnostics),
    capabilities: parseCapabilities(parsed.frontmatter.capabilities, diagnostics),
    activation: enumValue(stringValue(parsed.frontmatter.activation), isSkillActivation, effectiveScope === "on-demand" ? "manual" : "suggested"),
    triggers: parseList(parsed.frontmatter.triggers, []),
    risk: parseRisk(stringValue(parsed.frontmatter.risk), diagnostics),
    maxActiveWith: parseList(parsed.frontmatter.maxActiveWith ?? parsed.frontmatter["max-active-with"], []),
    allowedTools: parseList(parsed.frontmatter.allowedTools ?? parsed.frontmatter["allowed-tools"], []),
    deniedTools: parseList(parsed.frontmatter.deniedTools ?? parsed.frontmatter["denied-tools"], []),
    requiresReview: parseBoolean(parsed.frontmatter.requiresReview ?? parsed.frontmatter["requires-review"], false),
    scripts: enumValue(stringValue(parsed.frontmatter.scripts), isSkillScriptPolicy, "disabled"),
    trust,
    lifecycle,
    version: parsePositiveInt(parsed.frontmatter.version, 1),
    sourcePath: filePath,
    checksum: sha256(envelope.metadata),
    qualifiedName: qualifiedName(effectiveScope, name, featureId),
    diagnostics,
    lastVerifiedAt: stringValue(parsed.frontmatter.lastVerifiedAt ?? parsed.frontmatter["last-verified-at"]) || undefined,
    expiresAt,
    featureId,
    verifiedBy: stringValue(parsed.frontmatter.verifiedBy ?? parsed.frontmatter["verified-by"]) || undefined,
    commandEvidence: parseList(parsed.frontmatter.commandEvidence ?? parsed.frontmatter["command-evidence"], []),
    resources: parseList(parsed.frontmatter.resources, []),
    body,
    bodyLoaded: envelope.bodyLoaded,
  };
  return skill;
}

export function loadSkillBody(skill: SkillDefinition): SkillDefinition {
  if (skill.bodyLoaded) return skill;
  let raw = "";
  try {
    raw = fs.readFileSync(skill.sourcePath, "utf-8");
  } catch {
    return skill;
  }
  const parsed = parseSkillFrontmatter(raw);
  return {
    ...skill,
    body: parsed.body.trim(),
    bodyLoaded: true,
    checksum: sha256(raw),
  };
}

function readSkillFileEnvelope(filePath: string): SkillFileEnvelope {
  const fd = fs.openSync(filePath, "r");
  try {
    const chunks: Buffer[] = [];
    const buffer = Buffer.allocUnsafe(4096);
    let bytesRead = 0;
    let total = "";
    do {
      bytesRead = fs.readSync(fd, buffer, 0, buffer.length, null);
      if (bytesRead > 0) {
        const chunk = Buffer.from(buffer.subarray(0, bytesRead));
        chunks.push(chunk);
        total += chunk.toString("utf-8");
      }
      const frontmatterEnd = total.startsWith("---\n") ? total.indexOf("\n---", 4) : -1;
      if (frontmatterEnd !== -1) {
        return { metadata: total.slice(0, frontmatterEnd + 4), bodyLoaded: false };
      }
    } while (bytesRead > 0 && total.length < 256_000);
    return { metadata: Buffer.concat(chunks).toString("utf-8"), bodyLoaded: true };
  } finally {
    fs.closeSync(fd);
  }
}

function effectiveLifecycle(lifecycle: SkillLifecycle, expiresAt: string | undefined): SkillLifecycle {
  if (lifecycle === "blocked" || lifecycle === "expired") return lifecycle;
  const expires = expiresAt ? Date.parse(expiresAt) : Number.NaN;
  return Number.isFinite(expires) && expires <= Date.now() ? "expired" : lifecycle;
}

function parseSkillFrontmatter(content: string): ParsedSkillFrontmatter {
  const normalized = content.replace(/\r\n/g, "\n");
  if (!normalized.startsWith("---\n")) return { frontmatter: {}, body: normalized };
  const endIndex = normalized.indexOf("\n---", 4);
  if (endIndex === -1) return { frontmatter: {}, body: normalized };
  const block = normalized.slice(4, endIndex);
  const body = normalized.slice(endIndex + 4).trim();
  const frontmatter: Record<string, string | string[]> = {};
  let currentKey: string | undefined;
  for (const line of block.split("\n")) {
    if (!line.trim() || line.trim().startsWith("#")) continue;
    const listMatch = line.match(/^\s*-\s*(.*)$/);
    if (listMatch && currentKey) {
      const current = frontmatter[currentKey];
      const list = Array.isArray(current) ? current : current ? [current] : [];
      frontmatter[currentKey] = [...list, unquote(listMatch[1] ?? "")];
      continue;
    }
    const match = line.match(/^([A-Za-z0-9_.-]+):\s*(.*)$/);
    if (!match) continue;
    currentKey = match[1];
    const value = (match[2] ?? "").trim();
    frontmatter[currentKey] = value.startsWith("[") && value.endsWith("]")
      ? value.slice(1, -1).split(",").map((item) => unquote(item)).filter(Boolean)
      : unquote(value);
  }
  return { frontmatter, body };
}

function writeSkillFile(filePath: string, skill: SkillDefinition, actor?: string): void {
  const frontmatter = [
    "---",
    `name: ${skill.name}`,
    `description: ${skill.description}`,
    `scope: ${skill.scope}`,
    listYaml("extends", skill.extends),
    listYaml("concerns", skill.concerns),
    listYaml("capabilities", skill.capabilities),
    `activation: ${skill.activation}`,
    listYaml("triggers", skill.triggers),
    `risk: ${skill.risk}`,
    listYaml("maxActiveWith", skill.maxActiveWith),
    listYaml("allowedTools", skill.allowedTools),
    listYaml("deniedTools", skill.deniedTools),
    `requiresReview: ${skill.requiresReview}`,
    `scripts: ${skill.scripts}`,
    `trust: ${skill.trust}`,
    `lifecycle: ${skill.lifecycle}`,
    `version: ${skill.version}`,
    skill.lastVerifiedAt ? `lastVerifiedAt: ${skill.lastVerifiedAt}` : undefined,
    skill.expiresAt ? `expiresAt: ${skill.expiresAt}` : undefined,
    skill.verifiedBy || actor ? `verifiedBy: ${skill.verifiedBy ?? actor}` : undefined,
    listYaml("commandEvidence", skill.commandEvidence),
    listYaml("resources", skill.resources),
    "---",
    "",
  ].filter((line): line is string => Boolean(line)).join("\n");
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${frontmatter}${skill.body.trim()}\n`, "utf-8");
}

function listYaml(key: string, values: readonly string[]): string {
  if (values.length === 0) return `${key}: []`;
  return [key + ":", ...values.map((value) => `  - ${value}`)].join("\n");
}

function recordShadowingDiagnostics(byScope: Record<SkillScope, Map<string, SkillDefinition>>, diagnostics: SkillCatalogDiagnostics): void {
  const names = new Map<string, string[]>();
  for (const scope of ["built-in", "user", "project", "on-demand"] as const) {
    for (const skill of byScope[scope].values()) {
      const current = names.get(skill.name) ?? [];
      current.push(skill.qualifiedName);
      names.set(skill.name, current);
    }
  }
  for (const [name, qualified] of names) {
    if (qualified.length > 1) diagnostics.warnings.push(`skill shadowing detected for '${name}': ${qualified.join(" > ")}`);
  }
}

function compactSkillBody(body: string, maxLines: number): string[] {
  const lines = body.split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("-") || /^\d+\./.test(line))
    .slice(0, maxLines);
  if (lines.length > 0) return lines;
  return body.split("\n").map((line) => line.trim()).filter(Boolean).slice(0, Math.max(1, maxLines)).map((line) => `- ${line.replace(/^#+\s*/, "")}`);
}

function auditSkillResources(skill: SkillDefinition): SkillAuditFinding[] {
  const findings: SkillAuditFinding[] = [];
  for (const resource of skill.resources) {
    if (/^https?:\/\//i.test(resource)) {
      if (skill.trust !== "trusted" && skill.trust !== "reviewed") {
        findings.push(error("external-resource", `Untrusted skill resource '${resource}' must be reviewed before use.`));
      } else {
        findings.push(warn("external-resource", `External skill resource '${resource}' should be pinned or vendored for auditability.`));
      }
      continue;
    }
    if (path.isAbsolute(resource) || resource.split(/[\\/]+/).includes("..")) {
      findings.push(error("resource-path", `Skill resource '${resource}' must stay inside the skill package.`));
      continue;
    }
    const resolved = path.resolve(path.dirname(skill.sourcePath), resource);
    const skillDir = path.resolve(path.dirname(skill.sourcePath));
    if (!resolved.startsWith(`${skillDir}${path.sep}`) && resolved !== skillDir) {
      findings.push(error("resource-path", `Skill resource '${resource}' escapes the skill package.`));
      continue;
    }
    if (!fs.existsSync(resolved)) {
      findings.push(error("missing-resource", `Skill resource '${resource}' was declared but not found.`));
      continue;
    }
    const stat = fs.statSync(resolved);
    if (stat.isDirectory()) {
      findings.push(warn("resource-directory", `Skill resource '${resource}' is a directory; audit individual files before promotion.`));
      continue;
    }
    if (!isAuditableTextResource(resolved)) {
      const finding = skill.trust === "trusted" || skill.trust === "reviewed" ? warn : error;
      findings.push(finding("opaque-resource", `Skill resource '${resource}' is not a text asset that pi-chalin can audit for hidden instructions.`));
      continue;
    }
    const content = fs.readFileSync(resolved, "utf-8");
    if (content.length > 128_000) {
      findings.push(warn("large-resource", `Skill resource '${resource}' is large; keep resources compact or split reviewed references.`));
      continue;
    }
    if (hasDangerousSkillInstruction(content)) findings.push(error("resource-prompt-injection", `Skill resource '${resource}' contains instruction-hierarchy override language.`));
    if (hasSecretLikeValue(content)) findings.push(error("resource-secret", `Skill resource '${resource}' appears to contain a secret or credential-like value.`));
  }
  return findings;
}

function isAuditableTextResource(filePath: string): boolean {
  return /\.(?:md|mdx|txt|json|ya?ml|toml|csv|tsv|sh|bash|zsh|ts|tsx|js|jsx|mjs|cjs|py|rb|go|rs|java|kt|swift|sql|html|css)$/i.test(filePath);
}

function hasDangerousSkillInstruction(text: string): boolean {
  return DANGEROUS_PHRASES.some((pattern) => pattern.test(text));
}

function hasSecretLikeValue(text: string): boolean {
  return SECRET_PATTERNS.some((pattern) => pattern.test(text));
}

function compareSkills(a: SkillDefinition, b: SkillDefinition): number {
  return SCOPE_RANK[a.scope] - SCOPE_RANK[b.scope] || (a.featureId ?? "").localeCompare(b.featureId ?? "") || a.name.localeCompare(b.name);
}

function parseList(value: string | string[] | undefined, fallback: string[]): string[] {
  if (value === undefined) return fallback;
  if (Array.isArray(value)) return value.map((item) => item.trim()).filter(Boolean);
  const trimmed = value.trim();
  if (!trimmed || trimmed === "[]") return [];
  const unwrapped = trimmed.startsWith("[") && trimmed.endsWith("]") ? trimmed.slice(1, -1) : trimmed;
  return unwrapped.split(",").map((item) => unquote(item)).filter(Boolean);
}

function parseConcerns(value: string | string[] | undefined, diagnostics: string[]): AgentConcern[] {
  const result: AgentConcern[] = [];
  for (const item of parseList(value, [])) {
    if (isAgentConcern(item)) result.push(item);
    else diagnostics.push(`invalid: unknown concern '${item}'.`);
  }
  return [...new Set(result)];
}

function parseCapabilities(value: string | string[] | undefined, diagnostics: string[]): AgentCapability[] {
  const result: AgentCapability[] = [];
  for (const item of parseList(value, [])) {
    if (isAgentCapability(item)) result.push(item);
    else diagnostics.push(`invalid: unknown capability '${item}'.`);
  }
  return [...new Set(result)];
}

function parseRisk(value: string | undefined, diagnostics: string[]): RouteRisk {
  if (value === "low" || value === "medium" || value === "high" || value === "critical") return value;
  if (value) diagnostics.push(`invalid: unknown risk '${value}'.`);
  return "low";
}

function parseBoolean(value: string | string[] | undefined, fallback: boolean): boolean {
  const text = stringValue(value);
  if (!text) return fallback;
  if (["true", "yes", "1"].includes(text.toLowerCase())) return true;
  if (["false", "no", "0"].includes(text.toLowerCase())) return false;
  return fallback;
}

function parsePositiveInt(value: string | string[] | undefined, fallback: number): number {
  const parsed = Number.parseInt(stringValue(value), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function enumValue<T extends string>(value: string | undefined, guard: (value: string) => value is T, fallback: T): T {
  return value && guard(value) ? value : fallback;
}

function qualifiedName(scope: SkillScope, name: string, featureId?: string): string {
  return scope === "on-demand" ? `feature:${featureId ?? "unknown"}:${name}` : `${scope}:${name}`;
}

function normalizeSkillReference(reference: string): string {
  return reference.replace(/^built-in\//, "built-in:").replace(/^project\//, "project:").replace(/^user\//, "user:");
}

function disabledReferences(reference: string): string[] {
  const normalized = normalizeSkillReference(reference.trim());
  if (!normalized) return [];
  const parts = normalized.split(":");
  return parts.length >= 2 ? [normalized, parts.at(-1) ?? normalized] : [normalized];
}

function safeSkillName(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 96);
}

function stringValue(value: string | string[] | undefined): string {
  return Array.isArray(value) ? value.join(", ") : value?.trim() ?? "";
}

function unquote(value: string): string {
  const trimmed = value.trim();
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) return trimmed.slice(1, -1);
  return trimmed;
}

function sha256(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function serializeSkillMetadata(skill: SkillDefinition): string {
  return [
    skill.name,
    skill.description,
    skill.triggers.join("\n"),
    skill.allowedTools.join("\n"),
    skill.deniedTools.join("\n"),
  ].join("\n");
}

function intersectSets<T>(a: Set<T>, b: Set<T>): Set<T> {
  return new Set([...a].filter((item) => b.has(item)));
}

function emptySkillMetricsRecord(skill: string): SkillMetricsRecord {
  return {
    skill,
    activations: 0,
    suggestions: 0,
    rejections: 0,
    outcomes: 0,
    verificationObserved: 0,
    reviewerPass: 0,
    reviewerFail: 0,
    retries: 0,
  };
}

function readSkillMetricsSnapshot(file: string): SkillMetricsSnapshot {
  if (!fs.existsSync(file)) return emptySkillMetricsSnapshotFile();
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf-8")) as Partial<SkillMetricsSnapshot>;
    return {
      version: 1,
      updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : new Date(0).toISOString(),
      skills: isRecord(parsed.skills) ? normalizeSkillMetricsRecords(parsed.skills) : {},
    };
  } catch {
    return emptySkillMetricsSnapshotFile();
  }
}

function writeSkillMetricsSnapshot(file: string, snapshot: SkillMetricsSnapshot): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(snapshot, null, 2)}\n`, "utf-8");
  fs.renameSync(tmp, file);
}

function emptySkillMetricsSnapshotFile(): SkillMetricsSnapshot {
  return { version: 1, updatedAt: new Date(0).toISOString(), skills: {} };
}

function normalizeSkillMetricsRecords(records: Record<string, unknown>): Record<string, SkillMetricsRecord> {
  return Object.fromEntries(Object.entries(records).flatMap(([skill, value]) => {
    if (!isRecord(value)) return [];
    const record = emptySkillMetricsRecord(skill);
    return [[skill, {
      ...record,
      scope: typeof value.scope === "string" && isSkillScope(value.scope) ? value.scope : undefined,
      trust: typeof value.trust === "string" && isSkillTrust(value.trust) ? value.trust : undefined,
      activations: nonNegativeInt(value.activations),
      suggestions: nonNegativeInt(value.suggestions),
      rejections: nonNegativeInt(value.rejections),
      outcomes: nonNegativeInt(value.outcomes),
      verificationObserved: nonNegativeInt(value.verificationObserved),
      reviewerPass: nonNegativeInt(value.reviewerPass),
      reviewerFail: nonNegativeInt(value.reviewerFail),
      retries: nonNegativeInt(value.retries),
      lastActivatedAt: stringOrUndefined(value.lastActivatedAt),
      lastSuggestedAt: stringOrUndefined(value.lastSuggestedAt),
      lastRejectedAt: stringOrUndefined(value.lastRejectedAt),
      lastOutcomeAt: stringOrUndefined(value.lastOutcomeAt),
    } satisfies SkillMetricsRecord]];
  }));
}

function nonNegativeInt(value: unknown): number {
  return Number.isInteger(value) && Number(value) >= 0 ? Number(value) : 0;
}

function stringOrUndefined(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function error(code: string, message: string): SkillAuditFinding {
  return { severity: "error", code, message };
}

function warn(code: string, message: string): SkillAuditFinding {
  return { severity: "warning", code, message };
}

function errorMessage(errorValue: unknown): string {
  return errorValue instanceof Error ? errorValue.message : String(errorValue);
}
