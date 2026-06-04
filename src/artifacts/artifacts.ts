import * as fs from "node:fs";
import * as path from "node:path";
import { Effect } from "effect";
import { resolveChalinPaths, type ChalinPathsOptions } from "../config/paths.ts";
import type { RunState } from "../domain/schemas.ts";
import { compactText } from "../utils/text.ts";

export type ArtifactFeatureStatus = "active" | "complete" | "failed" | "paused";

export interface ArtifactCheckpointInput {
  agent: string;
  title: string;
  summary: string;
  status: ArtifactFeatureStatus;
  stage?: string;
  validationRefs?: string[];
}

export interface ArtifactCheckpoint extends ArtifactCheckpointInput {
  id: string;
  createdAt: string;
}

export interface ValidationContract {
  id: string;
  title: string;
  commands: string[];
  successCriteria: string[];
  files?: string[];
  createdAt?: string;
}

export interface WorkerSkillInput {
  name: string;
  summary: string;
  rules: string[];
}

export interface WorkerSkillArtifact extends WorkerSkillInput {
  path: string;
  createdAt: string;
}

export interface ValidationContractArtifact extends ValidationContract {
  createdAt: string;
}

export interface InterviewAnswerArtifact {
  questionId: string;
  question: string;
  answer: string;
  custom?: boolean;
  recommended?: boolean;
}

export interface InterviewDecisionInput {
  task: string;
  reason: string;
  status: "answered" | "cancelled" | "non-interactive";
  answers: InterviewAnswerArtifact[];
}

export interface InterviewDecisionArtifact extends InterviewDecisionInput {
  id: string;
  createdAt: string;
}

export interface ApprovalDecisionInput {
  requestId: string;
  decision: "approved" | "rejected";
  toolName: string;
  reason: string;
  risk: "medium" | "high" | "critical";
  approvedAction: string;
  retriedAction?: string;
  equivalenceReason?: string;
  subagentId: string;
  paramsSummary?: string;
}

export interface ApprovalDecisionArtifact extends ApprovalDecisionInput {
  id: string;
  createdAt: string;
}

export interface FeatureArtifactState {
  featureId: string;
  goal: string;
  status: ArtifactFeatureStatus;
  chain: string[];
  currentStep?: string;
  checkpoints: ArtifactCheckpoint[];
  validationContracts: ValidationContractArtifact[];
  workerSkills: WorkerSkillArtifact[];
  interviewDecisions: InterviewDecisionArtifact[];
  approvalDecisions: ApprovalDecisionArtifact[];
  updatedAt: string;
  createdAt: string;
}

export interface RunArtifactSummary {
  runId: string;
  routeKind: RunState["route"]["kind"];
  agents: string[];
  status: RunState["status"];
  startedAt: string;
  endedAt?: string;
  durationMs?: number;
  handoffs: Array<{ agent: string; summary: string; status: string }>;
  workUnits?: RunState["workUnits"];
  recoveryState?: RunState["recoveryState"];
  mutationLedger?: RunState["mutationLedger"];
  verificationLedger?: RunState["verificationLedger"];
  observabilitySummary?: RunState["observabilitySummary"];
  warnings: string[];
  metrics?: RunState["metrics"];
  createdAt: string;
}

export function recordRunArtifactEffect(store: ArtifactStore, run: RunState): Effect.Effect<RunArtifactSummary, unknown> {
  return Effect.tryPromise(() => store.recordRun(run)).pipe(Effect.withSpan("artifacts.recordRun"));
}

export class ArtifactStore {
  private readonly paths: ReturnType<typeof resolveChalinPaths>;
  private readonly root: string;

  constructor(options: ChalinPathsOptions) {
    this.paths = resolveChalinPaths(options);
    this.root = path.join(this.paths.projectRoot, ".pi-chalin", "artifacts");
  }

  async initFeature(input: { featureId: string; goal: string; chain?: string[]; currentStep?: string }): Promise<FeatureArtifactState> {
    const now = new Date().toISOString();
    const existing = await this.loadFeature(input.featureId);
    const state: FeatureArtifactState = existing ? {
      ...existing,
      goal: input.goal,
      chain: input.chain ?? existing.chain,
      currentStep: input.currentStep ?? existing.currentStep,
      status: existing.status === "complete" ? "active" : existing.status,
      updatedAt: now,
    } : {
      featureId: safeId(input.featureId),
      goal: input.goal,
      status: "active",
      chain: input.chain ?? [],
      currentStep: input.currentStep,
      checkpoints: [],
      validationContracts: [],
      workerSkills: [],
      interviewDecisions: [],
      approvalDecisions: [],
      createdAt: now,
      updatedAt: now,
    };
    await this.writeFeatureState(state);
    return state;
  }

  async loadFeature(featureId: string): Promise<FeatureArtifactState | undefined> {
    const file = this.featureStatePath(featureId);
    if (!fs.existsSync(file)) return undefined;
    return normalizeFeatureState(JSON.parse(fs.readFileSync(file, "utf-8")) as Partial<FeatureArtifactState>);
  }

  async appendCheckpoint(featureId: string, input: ArtifactCheckpointInput): Promise<ArtifactCheckpoint> {
    const state = await this.ensureFeature(featureId);
    const now = new Date().toISOString();
    const checkpoint: ArtifactCheckpoint = { ...input, id: `checkpoint-${Date.now().toString(36)}`, createdAt: now };
    state.checkpoints.push(checkpoint);
    state.currentStep = input.title;
    state.status = input.status;
    state.updatedAt = now;
    appendJsonLine(this.featurePath(featureId, "checkpoints.jsonl"), checkpoint);
    await this.writeFeatureState(state);
    return checkpoint;
  }

  async saveValidationContract(featureId: string, input: ValidationContract): Promise<ValidationContractArtifact> {
    const state = await this.ensureFeature(featureId);
    const contract = { ...input, id: safeId(input.id), createdAt: input.createdAt ?? new Date().toISOString() };
    state.validationContracts = [...state.validationContracts.filter((item) => item.id !== contract.id), contract];
    state.updatedAt = contract.createdAt;
    await this.writeFeatureState(state);
    atomicWriteJson(this.featurePath(featureId, "validations", `${contract.id}.json`), contract);
    return contract;
  }

  async saveWorkerSkill(featureId: string, input: WorkerSkillInput): Promise<WorkerSkillArtifact> {
    const state = await this.ensureFeature(featureId);
    const name = safeId(input.name);
    const skillPath = this.featurePath(featureId, "skills", name, "SKILL.md");
    const createdAt = new Date().toISOString();
    const artifact: WorkerSkillArtifact = { ...input, name, path: skillPath, createdAt };
    atomicWriteText(skillPath, formatWorkerSkill(artifact));
    state.workerSkills = [...state.workerSkills.filter((item) => item.name !== name), artifact];
    state.updatedAt = createdAt;
    await this.writeFeatureState(state);
    return artifact;
  }

  async appendApprovalDecision(featureId: string, input: ApprovalDecisionInput): Promise<ApprovalDecisionArtifact> {
    const state = await this.ensureFeature(featureId);
    const createdAt = new Date().toISOString();
    const artifact: ApprovalDecisionArtifact = { ...input, id: `approval-${Date.now().toString(36)}`, createdAt };
    state.approvalDecisions.push(artifact);
    state.currentStep = input.decision === "approved" ? "Action approval captured" : "Action approval rejected";
    state.status = input.decision === "rejected" ? "paused" : state.status === "complete" ? "complete" : "active";
    state.updatedAt = createdAt;
    appendJsonLine(this.featurePath(featureId, "approvals.jsonl"), artifact);
    await this.writeFeatureState(state);
    return artifact;
  }

  async appendInterviewDecision(featureId: string, input: InterviewDecisionInput): Promise<InterviewDecisionArtifact> {
    const state = await this.ensureFeature(featureId);
    const createdAt = new Date().toISOString();
    const artifact: InterviewDecisionArtifact = { ...input, id: `interview-${Date.now().toString(36)}`, createdAt };
    state.interviewDecisions.push(artifact);
    state.currentStep = input.status === "answered" ? "Interview answered" : "Interview pending";
    state.status = input.status === "answered" ? state.status : "paused";
    state.updatedAt = createdAt;
    appendJsonLine(this.featurePath(featureId, "interviews.jsonl"), artifact);
    await this.writeFeatureState(state);
    return artifact;
  }

  async resumeContext(featureId: string): Promise<string> {
    const state = await this.loadFeature(featureId);
    if (!state) return `No pi-chalin artifacts found for feature '${featureId}'.`;
    const latest = state.checkpoints.slice(-5).map((checkpoint) => `- ${checkpoint.title} (${checkpoint.agent}, ${checkpoint.status}): ${checkpoint.summary}`);
    const validations = state.validationContracts.map((contract) => `- ${contract.id}: ${contract.successCriteria.join("; ")}`);
    const interviews = state.interviewDecisions.slice(-5).flatMap((decision) => [
      `- ${decision.status}: ${decision.reason}`,
      ...decision.answers.map((answer) => `  - ${answer.question}: ${answer.answer}`),
    ]);
    const approvals = state.approvalDecisions.slice(-5).flatMap((decision) => [
      `- ${decision.decision}: ${decision.approvedAction} (${decision.toolName}, ${decision.risk}, ${decision.subagentId})`,
      decision.retriedAction ? `  - retry: ${decision.retriedAction}` : undefined,
      decision.equivalenceReason ? `  - equivalence: ${decision.equivalenceReason}` : undefined,
    ].filter((line): line is string => Boolean(line)));
    const skills = state.workerSkills.map((skill) => `- ${skill.name}: ${skill.summary}`);
    return [
      `Feature: ${state.featureId}`,
      `Goal: ${state.goal}`,
      `Status: ${state.status}`,
      state.chain.length ? `Chain: ${state.chain.join(" → ")}` : undefined,
      state.currentStep ? `Current step: ${state.currentStep}` : undefined,
      latest.length ? "Recent checkpoints:" : undefined,
      ...latest,
      validations.length ? "Validation contracts:" : undefined,
      ...validations,
      interviews.length ? "Interview decisions:" : undefined,
      ...interviews,
      approvals.length ? "Action approvals:" : undefined,
      ...approvals,
      skills.length ? "Worker skills:" : undefined,
      ...skills,
    ].filter((line): line is string => Boolean(line)).join("\n");
  }

  async recordRun(run: RunState): Promise<RunArtifactSummary> {
    const createdAt = new Date().toISOString();
    const summary: RunArtifactSummary = {
      runId: run.id,
      routeKind: run.route.kind,
      agents: run.route.agents,
      status: run.status,
      startedAt: run.startedAt,
      endedAt: run.endedAt,
      durationMs: run.metrics?.durationMs,
      handoffs: run.steps.map((step) => ({
        agent: step.agent,
        status: step.status,
        summary: compactText(step.output?.handoff || step.output?.text || step.error || "", 600),
      })).filter((item) => item.summary.length > 0),
      workUnits: run.workUnits,
      recoveryState: run.recoveryState,
      mutationLedger: run.mutationLedger,
      verificationLedger: run.verificationLedger,
      observabilitySummary: run.observabilitySummary,
      warnings: run.warnings,
      metrics: run.metrics,
      createdAt,
    };
    atomicWriteJson(this.runPath(run.id, "summary.json"), summary);
    return summary;
  }

  async loadRun(runId: string): Promise<RunArtifactSummary | undefined> {
    const file = this.runPath(runId, "summary.json");
    if (!fs.existsSync(file)) return undefined;
    return JSON.parse(fs.readFileSync(file, "utf-8")) as RunArtifactSummary;
  }

  async listFeatures(): Promise<FeatureArtifactState[]> {
    const dir = path.join(this.root, "features");
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir)
      .map((name) => path.join(dir, name, "state.json"))
      .filter((file) => fs.existsSync(file))
      .map((file) => normalizeFeatureState(JSON.parse(fs.readFileSync(file, "utf-8")) as Partial<FeatureArtifactState>))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  private async ensureFeature(featureId: string): Promise<FeatureArtifactState> {
    return await this.loadFeature(featureId) ?? await this.initFeature({ featureId, goal: `Continue ${featureId}` });
  }

  private async writeFeatureState(state: FeatureArtifactState): Promise<void> {
    atomicWriteJson(this.featureStatePath(state.featureId), state);
  }

  private featureStatePath(featureId: string): string {
    return this.featurePath(featureId, "state.json");
  }

  private featurePath(featureId: string, ...parts: string[]): string {
    return path.join(this.root, "features", safeId(featureId), ...parts);
  }

  private runPath(runId: string, ...parts: string[]): string {
    return path.join(this.root, "runs", safeId(runId), ...parts);
  }
}

function safeId(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 96) || "artifact";
}

function atomicWriteJson(file: string, value: unknown): void {
  atomicWriteText(file, `${JSON.stringify(value, null, 2)}\n`);
}

function atomicWriteText(file: string, value: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, value);
  fs.renameSync(tmp, file);
}

function appendJsonLine(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, `${JSON.stringify(value)}\n`);
}

function formatWorkerSkill(skill: WorkerSkillArtifact): string {
  const expiresAt = new Date(Date.parse(skill.createdAt) + 30 * 24 * 60 * 60 * 1000).toISOString();
  return [
    "---",
    `name: ${skill.name}`,
    `description: ${skill.summary}`,
    "scope: on-demand",
    "extends:",
    "  - worker",
    "concerns:",
    "  - implementation",
    "capabilities:",
    "  - validate",
    "activation: manual",
    "risk: low",
    "allowedTools: []",
    "deniedTools: []",
    "requiresReview: false",
    "scripts: disabled",
    "trust: untrusted",
    "lifecycle: candidate",
    `expiresAt: ${expiresAt}`,
    "version: 1",
    "---",
    "",
    "## Purpose",
    skill.summary,
    "",
    "## Rules",
    ...skill.rules.map((rule) => `- ${rule}`),
    "",
  ].join("\n");
}


function normalizeFeatureState(raw: Partial<FeatureArtifactState>): FeatureArtifactState {
  const now = new Date().toISOString();
  return {
    featureId: raw.featureId ?? "artifact",
    goal: raw.goal ?? "Continue artifact",
    status: raw.status ?? "active",
    chain: raw.chain ?? [],
    currentStep: raw.currentStep,
    checkpoints: raw.checkpoints ?? [],
    validationContracts: raw.validationContracts ?? [],
    workerSkills: raw.workerSkills ?? [],
    interviewDecisions: raw.interviewDecisions ?? [],
    approvalDecisions: raw.approvalDecisions ?? [],
    createdAt: raw.createdAt ?? now,
    updatedAt: raw.updatedAt ?? now,
  };
}
