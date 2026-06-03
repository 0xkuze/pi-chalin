import type { AgentHandoffWorkUnit, AgentStep, RouteDecision, RouteExpectedEffect, RoutePlan, RunState, RunStepState, WorkUnit, WorkUnitKind } from "../domain/schemas.ts";

export interface PlannedRunUnits {
  steps: RunStepState[];
  workUnits: WorkUnit[];
}

export function expandWorkUnitsFromBestHandoff(run: RunState, steps: RunStepState[]): boolean {
  if (run.intentContract?.requiresInterview || run.recoveryState?.blockedByHumanInput) return false;
  const sourceStep = selectWorkUnitExpansionSource(run, steps);
  return sourceStep ? expandWorkUnitsFromHandoff(run, sourceStep) : false;
}

export function selectWorkUnitExpansionSource(run: RunState, steps: RunStepState[]): RunStepState | undefined {
  if (!hasWorkUnitDiscoveryRequest(run)) return undefined;
  if (run.workUnits?.some((unit) => unit.createdFrom === "fanout")) return undefined;
  return steps
    .map((step, index) => ({ step, index, rank: workUnitSourceRank(run, step) }))
    .filter(({ step, rank }) => rank > 0 && isUsableHandoffStep(step) && (step.output?.structuredHandoff?.workUnits?.length ?? 0) >= 2)
    .filter(({ rank }) => !hasPendingWorkUnitAuthority(run, rank))
    .sort((left, right) => right.rank - left.rank || right.index - left.index)[0]?.step;
}

export function planStepsWithWorkUnits(route: RouteDecision): PlannedRunUnits {
  const plan = route.plan;
  if (!plan) return { steps: [], workUnits: [] };
  if (plan.kind === "dag") return planDagSteps(route, plan);
  return planSequentialSteps(route, plan);
}

export function refreshWorkUnitStatuses(run: RunState): void {
  if (!run.workUnits?.length) return;
  for (const unit of run.workUnits) {
    const unitSteps = run.steps.filter((step) => step.workUnitId === unit.id);
    if (unitSteps.length === 0) continue;
    const failed = unitSteps.find((step) => step.status === "failed");
    const skipped = unitSteps.find((step) => step.status === "skipped");
    if (failed) {
      unit.status = "failed";
      unit.failureReason = failed.error;
    } else if (skipped) {
      unit.status = "skipped";
      unit.skippedReason = skipped.skipReason;
    } else if (unitSteps.some((step) => step.status === "paused")) unit.status = "paused";
    else if (unitSteps.some((step) => step.status === "running")) unit.status = "running";
    else if (unitSteps.every((step) => step.status === "complete" || step.status === "checkpointed")) unit.status = "complete";
    else unit.status = "pending";
  }
}

export function expandWorkUnitsFromHandoff(run: RunState, sourceStep: RunStepState): boolean {
  if (run.intentContract?.requiresInterview || run.recoveryState?.blockedByHumanInput) return false;
  if (sourceStep.status === "skipped" || sourceStep.skipReason) return false;
  if (!hasWorkUnitDiscoveryRequest(run)) return false;
  if (run.workUnits?.some((unit) => unit.createdFrom === "fanout")) return false;
  const sourceUnit = run.workUnits?.find((unit) => unit.id === sourceStep.workUnitId);
  if (sourceUnit?.createdFrom === "fanout") return false;
  const sourceRank = workUnitSourceRank(run, sourceStep);
  if (sourceRank <= 0 || hasPendingWorkUnitAuthority(run, sourceRank)) return false;
  const fanoutUnits = extractFanoutWorkUnits(sourceStep);
  if (fanoutUnits.length < 2) {
    run.warnings.push(`Structured WorkUnit discovery from ${sourceStep.agent}/${sourceStep.id} returned ${fanoutUnits.length} unit(s); no fanout was materialized.`);
    return false;
  }

  const routeEffects = routeExpectedEffects(run.route);
  if (requiresDiscoveredWriteFanoutAuthorization(run, fanoutUnits, routeEffects)) {
    blockDiscoveredWriteFanoutForHumanInput(run, sourceStep, fanoutUnits);
    return false;
  }
  const aggregateStageId = `fanout-${safeId(sourceStep.id)}-aggregate`;
  const finalStageId = `fanout-${safeId(sourceStep.id)}-final-review`;
  const unitRefs = compileFanoutUnitRefs(sourceStep, fanoutUnits)
    .map((unitRef) => enrichFanoutUnitRef(unitRef, routeEffects));
  const primaryStages: Extract<RoutePlan, { kind: "dag" }>["stages"] = [];
  const reviewerStages: Extract<RoutePlan, { kind: "dag" }>["stages"] = [];
  const primarySteps: RunStepState[] = [];
  const reviewerSteps: RunStepState[] = [];
  const unitRefById = new Map(unitRefs.map((unitRef) => [unitRef.id, unitRef]));
  for (const level of fanoutLevels(unitRefs)) {
    const primaryStageId = `fanout-${safeId(sourceStep.id)}-${stageAgentLabel(level.refs)}-${level.level}`;
    const levelPrimarySteps = level.refs.map((unitRef): RunStepState => {
      unitRef.workerStepId = `${primaryStageId}:step-${unitRef.index + 1}`;
      unitRef.dependencyStepIds = unitRef.dependencyUnitIds
        .map((id) => unitRefById.get(id)?.reviewerStepId ?? unitRefById.get(id)?.workerStepId)
        .filter((id): id is string => Boolean(id));
      return {
        id: unitRef.workerStepId,
        agent: unitRef.agent,
        task: unitTaskForEffects(unitRef.input, unitRef.expectedEffects),
        status: "pending",
        stageId: primaryStageId,
        workUnitId: unitRef.id,
        dependencies: [sourceStep.id, ...unitRef.dependencyStepIds],
        budget: "normal",
      };
    });
    primarySteps.push(...levelPrimarySteps);
    primaryStages.push({ id: primaryStageId, tasks: levelPrimarySteps.map(toAgentStep) });
    const refsNeedingReview = level.refs.filter((unitRef) => unitRef.requiresReviewer);
    if (refsNeedingReview.length > 0) {
      const reviewStageId = `fanout-${safeId(sourceStep.id)}-reviewers-${level.level}`;
      const levelReviewerSteps = refsNeedingReview.map((unitRef): RunStepState => {
        unitRef.reviewerStepId = `${reviewStageId}:step-${unitRef.index + 1}`;
        return {
          id: unitRef.reviewerStepId,
          agent: "reviewer",
          task: reviewUnitTask(unitRef.input),
          status: "pending",
          stageId: reviewStageId,
          workUnitId: unitRef.id,
          dependencies: [unitRef.workerStepId],
          budget: "normal",
        };
      });
      reviewerSteps.push(...levelReviewerSteps);
      reviewerStages.push({ id: reviewStageId, tasks: levelReviewerSteps.map(toAgentStep) });
    }
  }
  const workUnits: WorkUnit[] = unitRefs.map((unitRef) => {
    const fanoutUnit = unitRef.input;
    const scope = fanoutUnit.scope.length ? fanoutUnit.scope : [fanoutUnit.title];
    const acceptanceCriteria = fanoutUnit.acceptanceCriteria.length ? fanoutUnit.acceptanceCriteria : scope;
    return {
      id: unitRef.id,
      title: fanoutUnit.title,
      kind: unitRef.kind,
      status: "pending",
      scope,
      ...(fanoutUnit.files?.length ? { files: fanoutUnit.files } : {}),
      dependencies: [sourceStep.workUnitId ?? sourceStep.id, ...unitRef.dependencyUnitIds],
      expectedEffects: unitRef.expectedEffects,
      acceptanceCriteria,
      workerStepId: unitRef.workerStepId,
      ...(unitRef.requiresReviewer ? { reviewerStepId: unitRef.reviewerStepId } : {}),
      sourceStepId: sourceStep.id,
      createdFrom: "fanout",
    };
  });
  const aggregatorId = `${aggregateStageId}:step-1`;
  const finalReviewId = `${finalStageId}:step-1`;
  const aggregatorUnit: WorkUnit = {
    id: `${aggregateStageId}-unit`,
    title: "Aggregate fanout results",
    kind: "synthesis",
    status: "pending",
    scope: workUnits.map((unit) => unit.title),
    dependencies: unitRefs.map((unitRef) => unitRef.reviewerStepId ?? unitRef.workerStepId),
    expectedEffects: ["read"],
    acceptanceCriteria: ["Summarize per-unit outcomes and unresolved gaps without hiding failed or skipped units."],
    workerStepId: aggregatorId,
    sourceStepId: sourceStep.id,
    createdFrom: "fanout",
  };
  const finalUnit: WorkUnit = {
    id: `${finalStageId}-unit`,
    title: "Final integration review",
    kind: "review",
    status: "pending",
    scope: workUnits.map((unit) => unit.title),
    dependencies: [aggregatorId],
    expectedEffects: ["read", "verify"],
    acceptanceCriteria: ["Confirm all unit reviewers passed or explicitly report blockers."],
    finalReviewerStepId: finalReviewId,
    sourceStepId: sourceStep.id,
    createdFrom: "fanout",
  };
  const aggregateStep: RunStepState = {
    id: aggregatorId,
    agent: "context-builder",
    task: "Aggregate the WorkUnit handoffs into a compact summary. Do not claim completion for failed or skipped units.",
    status: "pending",
    stageId: aggregateStageId,
    workUnitId: aggregatorUnit.id,
    dependencies: aggregatorUnit.dependencies,
    budget: "normal",
  };
  const finalReviewStep: RunStepState = {
    id: finalReviewId,
    agent: "reviewer",
    task: "Final integration review for all fanout units. Verify coverage, skipped reviewers, failed units, and remaining repair options.",
    status: "pending",
    stageId: finalStageId,
    workUnitId: finalUnit.id,
    dependencies: [aggregatorId],
    budget: "normal",
  };

  run.workUnits = [...(run.workUnits ?? []), ...workUnits, aggregatorUnit, finalUnit];
  run.steps.push(...primarySteps, ...reviewerSteps, aggregateStep, finalReviewStep);
  appendDagStages(run, [
    ...interleaveWorkerReviewerStages(primaryStages, reviewerStages),
    { id: aggregateStageId, tasks: [toAgentStep(aggregateStep)] },
    { id: finalStageId, tasks: [toAgentStep(finalReviewStep)] },
  ], sourceStep.stageId);
  const unresolvedDependencies = unitRefs.flatMap((unitRef) => unitRef.unresolvedDependencies.map((dependency) => `${unitRef.input.title}: ${dependency}`));
  if (unresolvedDependencies.length) {
    run.warnings.push(`Ignored unresolved WorkUnit dependencies that did not match structured unit ids or exact titles: ${unresolvedDependencies.slice(0, 8).join("; ")}.`);
  }
  const overlapDependencies = unitRefs.flatMap((unitRef) => unitRef.autoDependencies.map((reason) => `${unitRef.input.title}: ${reason}`));
  if (overlapDependencies.length) {
    run.warnings.push(`Serialized WorkUnits with overlapping declared files: ${overlapDependencies.slice(0, 8).join("; ")}.`);
  }
  run.route.agents = run.steps.map((step) => step.agent);
  run.route.needsArtifacts = true;
  run.route.expectedEffects = [...new Set<RouteExpectedEffect>(routeEffects)];
  run.warnings.push(`Expanded fanout/decomposition into ${workUnits.length} work unit(s) after ${sourceStep.agent}/${sourceStep.id}.`);
  return true;
}

function hasWorkUnitDiscoveryRequest(run: RunState): boolean {
  return run.intentContract?.workUnitDiscoveryRequested === true || run.intentContract?.fanoutAuthorized === true;
}

function requiresDiscoveredWriteFanoutAuthorization(run: RunState, fanoutUnits: AgentHandoffWorkUnit[], routeEffects: RouteExpectedEffect[]): boolean {
  if (run.route.fanoutAuthorized !== false) return false;
  const writeUnits = fanoutUnits.filter((unit) => fanoutUnitExpectedEffects(unit, routeEffects).includes("write"));
  return writeUnits.length >= 2;
}

function blockDiscoveredWriteFanoutForHumanInput(run: RunState, sourceStep: RunStepState, fanoutUnits: AgentHandoffWorkUnit[]): void {
  const writeUnitTitles = fanoutUnits
    .filter((unit) => fanoutUnitExpectedEffects(unit, routeExpectedEffects(run.route)).includes("write"))
    .map((unit) => unit.title)
    .filter(Boolean)
    .slice(0, 5);
  const question = writeUnitTitles.length
    ? `Which discovered target(s) should be changed before mutation proceeds: ${writeUnitTitles.join(", ")}?`
    : "Which discovered target(s) should be changed before mutation proceeds?";
  run.intentContract = {
    ...(run.intentContract ?? { originalPrompt: run.rootTask ?? run.route.reason, explicitConstraints: [], forbiddenPaths: [] }),
    requiresInterview: true,
  };
  run.recoveryState = {
    ...(run.recoveryState ?? { pendingUnits: [], reviewersNotRun: [], resumeKind: "none", repairOptions: [] }),
    blockedByHumanInput: true,
    repairOptions: [...new Set([...(run.recoveryState?.repairOptions ?? []), question])],
  };
  const reason = `Skipped because ${sourceStep.agent}/${sourceStep.id} discovered multiple mutating targets without fanout authorization: ${question}`;
  for (const step of run.steps) {
    if (step === sourceStep || step.status !== "pending") continue;
    step.status = "skipped";
    step.skipReason = reason;
    step.endedAt = new Date().toISOString();
  }
  run.warnings.push(`Human input required before discovered write fanout from ${sourceStep.agent}/${sourceStep.id}; no worker fanout was materialized.`);
}

interface FanoutUnitRef {
  index: number;
  id: string;
  input: AgentHandoffWorkUnit;
  expectedEffects: RouteExpectedEffect[];
  agent: string;
  kind: WorkUnitKind;
  requiresReviewer: boolean;
  dependencyUnitIds: string[];
  dependencyStepIds: string[];
  unresolvedDependencies: string[];
  autoDependencies: string[];
  workerStepId: string;
  reviewerStepId?: string;
}

function compileFanoutUnitRefs(sourceStep: RunStepState, fanoutUnits: AgentHandoffWorkUnit[]): FanoutUnitRef[] {
  const sourcePrefix = `fanout-${safeId(sourceStep.id)}`;
  const refs = fanoutUnits.map((unit, index): FanoutUnitRef => ({
    index,
    id: `${sourcePrefix}-${index + 1}`,
    input: unit,
    expectedEffects: ["read"],
    agent: "context-builder",
    kind: "synthesis",
    requiresReviewer: false,
    dependencyUnitIds: [],
    dependencyStepIds: [],
    unresolvedDependencies: [],
    autoDependencies: [],
    workerStepId: "",
  }));
  const lookup = buildFanoutDependencyLookup(refs);
  for (const ref of refs) {
    for (const dependency of ref.input.dependencies ?? []) {
      const target = lookup.get(normalizeDependencyKey(dependency));
      if (!target || target === ref) {
        ref.unresolvedDependencies.push(dependency);
        continue;
      }
      ref.dependencyUnitIds.push(target.id);
    }
  }
  applyFileOverlapDependencies(refs);
  return refs;
}

function enrichFanoutUnitRef(unitRef: FanoutUnitRef, routeEffects: RouteExpectedEffect[]): FanoutUnitRef {
  const expectedEffects = fanoutUnitExpectedEffects(unitRef.input, routeEffects);
  return {
    ...unitRef,
    expectedEffects,
    agent: agentForExpectedEffects(expectedEffects),
    kind: kindForExpectedEffects(expectedEffects),
    requiresReviewer: expectedEffects.includes("write"),
  };
}

function fanoutUnitExpectedEffects(unit: AgentHandoffWorkUnit, routeEffects: RouteExpectedEffect[]): RouteExpectedEffect[] {
  if (unit.expectedEffects?.length) return uniqueExpectedEffects(unit.expectedEffects);
  if (routeEffects.includes("write") && (unit.files?.length ?? 0) === 0) {
    return routeEffects.includes("verify") ? ["read", "verify"] : ["read"];
  }
  return uniqueExpectedEffects(routeEffects);
}

function uniqueExpectedEffects(effects: RouteExpectedEffect[]): RouteExpectedEffect[] {
  const allowed = new Set<RouteExpectedEffect>(["read", "write", "verify"]);
  const result: RouteExpectedEffect[] = [];
  for (const effect of effects) {
    if (!allowed.has(effect) || result.includes(effect)) continue;
    result.push(effect);
  }
  return result.length ? result : ["read"];
}

function agentForExpectedEffects(expectedEffects: RouteExpectedEffect[]): string {
  const effectSet = new Set(expectedEffects);
  if (effectSet.has("write")) return "worker";
  if (effectSet.has("verify")) return "reviewer";
  return "context-builder";
}

function kindForExpectedEffects(expectedEffects: RouteExpectedEffect[]): WorkUnitKind {
  const effectSet = new Set(expectedEffects);
  if (effectSet.has("write")) return "implementation";
  if (effectSet.has("verify")) return "review";
  return "synthesis";
}

function stageAgentLabel(refs: FanoutUnitRef[]): string {
  const agents = [...new Set(refs.map((ref) => ref.agent))];
  if (agents.length !== 1) return "units";
  return `${agents[0]}s`;
}

function applyFileOverlapDependencies(refs: FanoutUnitRef[]): void {
  for (let leftIndex = 0; leftIndex < refs.length; leftIndex += 1) {
    const left = refs[leftIndex]!;
    for (let rightIndex = leftIndex + 1; rightIndex < refs.length; rightIndex += 1) {
      const right = refs[rightIndex]!;
      const shared = sharedUnitFiles(left, right);
      if (shared.length === 0 || right.dependencyUnitIds.includes(left.id)) continue;
      right.dependencyUnitIds.push(left.id);
      right.autoDependencies.push(`depends on ${left.input.title} because both declare ${shared.slice(0, 4).join(", ")}`);
    }
  }
}

function sharedUnitFiles(left: FanoutUnitRef, right: FanoutUnitRef): string[] {
  const leftFiles = new Set(normalizedUnitFiles(left));
  return normalizedUnitFiles(right).filter((file) => leftFiles.has(file));
}

function normalizedUnitFiles(ref: FanoutUnitRef): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const file of ref.input.files ?? []) {
    const normalized = normalizeUnitFile(file);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(normalized);
  }
  return result;
}

function normalizeUnitFile(file: string): string {
  let normalized = file.trim().replaceAll("\\", "/");
  while (normalized.startsWith("./")) normalized = normalized.slice(2);
  return normalized;
}

function buildFanoutDependencyLookup(refs: FanoutUnitRef[]): Map<string, FanoutUnitRef> {
  const lookup = new Map<string, FanoutUnitRef>();
  for (const ref of refs) {
    const keys = [
      ref.input.id,
      ref.input.title,
      ref.id,
      `unit-${ref.index + 1}`,
    ].filter((value): value is string => Boolean(value));
    for (const key of keys) lookup.set(normalizeDependencyKey(key), ref);
  }
  return lookup;
}

function fanoutLevels(refs: FanoutUnitRef[]): Array<{ level: number; refs: FanoutUnitRef[] }> {
  const levelById = new Map<string, number>();
  const visiting = new Set<string>();
  const byId = new Map(refs.map((ref) => [ref.id, ref]));
  const levelFor = (ref: FanoutUnitRef): number => {
    const known = levelById.get(ref.id);
    if (known !== undefined) return known;
    if (visiting.has(ref.id)) {
      ref.unresolvedDependencies.push("cycle");
      levelById.set(ref.id, 1);
      return 1;
    }
    visiting.add(ref.id);
    const dependencyLevels = ref.dependencyUnitIds
      .map((id) => byId.get(id))
      .filter((dependency): dependency is FanoutUnitRef => Boolean(dependency))
      .map(levelFor);
    visiting.delete(ref.id);
    const level = dependencyLevels.length ? Math.max(...dependencyLevels) + 1 : 1;
    levelById.set(ref.id, level);
    return level;
  };
  for (const ref of refs) levelFor(ref);
  const grouped = new Map<number, FanoutUnitRef[]>();
  for (const ref of refs) {
    const level = levelById.get(ref.id) ?? 1;
    grouped.set(level, [...(grouped.get(level) ?? []), ref]);
  }
  return [...grouped.entries()]
    .sort(([left], [right]) => left - right)
    .map(([level, levelRefs]) => ({ level, refs: levelRefs }));
}

function interleaveWorkerReviewerStages(
  workerStages: Extract<RoutePlan, { kind: "dag" }>["stages"],
  reviewerStages: Extract<RoutePlan, { kind: "dag" }>["stages"],
): Extract<RoutePlan, { kind: "dag" }>["stages"] {
  if (reviewerStages.length === 0) return workerStages;
  const stages: Extract<RoutePlan, { kind: "dag" }>["stages"] = [];
  const count = Math.max(workerStages.length, reviewerStages.length);
  for (let index = 0; index < count; index += 1) {
    const workerStage = workerStages[index];
    const reviewerStage = reviewerStages[index];
    if (workerStage) stages.push(workerStage);
    if (reviewerStage) stages.push(reviewerStage);
  }
  return stages;
}

function normalizeDependencyKey(value: string): string {
  return normalizeText(value).toLowerCase();
}

function workUnitSourceRank(run: RunState, step: RunStepState): number {
  const sourceUnit = run.workUnits?.find((unit) => unit.id === step.workUnitId);
  if (sourceUnit?.createdFrom === "fanout") return 0;
  if (sourceUnit?.kind) return workUnitAuthorityRank(sourceUnit.kind);
  return (step.output?.structuredHandoff?.workUnits?.length ?? 0) >= 2 ? 1 : 0;
}

function workUnitAuthorityRank(kind: WorkUnitKind): number {
  if (kind === "planning") return 4;
  if (kind === "discovery") return 3;
  if (kind === "synthesis") return 2;
  return 1;
}

function hasPendingWorkUnitAuthority(run: RunState, currentRank: number): boolean {
  return run.steps.some((step) => {
    if (step.status !== "pending" && step.status !== "running") return false;
    return workUnitSourceRank(run, step) >= currentRank;
  });
}

function isUsableHandoffStep(step: RunStepState): boolean {
  if (step.status === "skipped" || step.skipReason) return false;
  return (step.status === "complete" || step.status === "checkpointed") && Boolean(step.output?.structuredHandoff);
}

function planSequentialSteps(route: RouteDecision, plan: Extract<RoutePlan, { kind: "sequential" }>): PlannedRunUnits {
  const expectedEffects = routeExpectedEffects(route);
  const steps: RunStepState[] = [];
  const units: WorkUnit[] = [];
  for (let index = 0; index < plan.steps.length; index += 1) {
    const step = plan.steps[index]!;
    const id = `step-${index + 1}`;
    const unitId = step.id ? `unit-${safeId(step.id)}` : `unit-${index + 1}`;
    steps.push({
      id,
      agent: step.agent,
      task: step.task,
      budget: step.budget,
      status: "pending",
      stageId: "sequential",
      workUnitId: unitId,
      dependencies: index > 0 ? [steps[index - 1]!.id] : [],
    });
    units.push(unitForStep(unitId, step, id, "sequential", expectedEffects, index > 0 ? [steps[index - 1]!.workUnitId ?? steps[index - 1]!.id] : []));
  }
  return { steps, workUnits: units };
}

function planDagSteps(route: RouteDecision, plan: Extract<RoutePlan, { kind: "dag" }>): PlannedRunUnits {
  const expectedEffects = routeExpectedEffects(route);
  const steps: RunStepState[] = [];
  const units: WorkUnit[] = [];
  let priorStageStepIds: string[] = [];
  let priorStageUnitIds: string[] = [];
  for (const stage of plan.stages) {
    const stageStepIds: string[] = [];
    const stageUnitIds: string[] = [];
    stage.tasks.forEach((step, index) => {
      const id = `${stage.id}:step-${index + 1}`;
      const unitId = `unit-${safeId(stage.id)}-${safeId(step.id ?? `${index + 1}`)}`;
      steps.push({
        id,
        agent: step.agent,
        task: step.task,
        budget: step.budget,
        status: "pending",
        stageId: stage.id,
        workUnitId: unitId,
        dependencies: [...priorStageStepIds],
      });
      units.push(unitForStep(unitId, step, id, stage.id, expectedEffects, priorStageUnitIds));
      stageStepIds.push(id);
      stageUnitIds.push(unitId);
    });
    priorStageStepIds = stageStepIds;
    priorStageUnitIds = stageUnitIds;
  }
  return { steps, workUnits: units };
}

function unitForStep(unitId: string, step: AgentStep, stepId: string, stageId: string, expectedEffects: RouteExpectedEffect[], dependencies: string[]): WorkUnit {
  const unitExpectedEffects = expectedEffectsForPlannedStep(step, expectedEffects);
  return {
    id: unitId,
    title: step.id || taskTitle(step.task),
    kind: kindForAgent(step.agent),
    status: "pending",
    scope: [step.task],
    dependencies,
    expectedEffects: unitExpectedEffects,
    acceptanceCriteria: [step.task],
    ...(step.files?.length ? { files: step.files } : {}),
    ...(step.agent === "reviewer" ? { reviewerStepId: stepId } : { workerStepId: stepId }),
    sourceStepId: stepId,
    createdFrom: "route-plan",
  };
}

function extractFanoutWorkUnits(step: RunStepState): AgentHandoffWorkUnit[] {
  const units = step.output?.structuredHandoff?.workUnits ?? [];
  const seen = new Set<string>();
  const result: AgentHandoffWorkUnit[] = [];
  for (const unit of units) {
    const title = normalizeText(unit.title);
    if (!title) continue;
    const key = title.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const scope = normalizeTexts(unit.scope);
    const files = normalizeTexts(unit.files ?? []);
    const acceptanceCriteria = normalizeTexts(unit.acceptanceCriteria);
    const expectedEffects = unit.expectedEffects?.length ? uniqueExpectedEffects(unit.expectedEffects) : [];
    const id = unit.id ? normalizeText(unit.id) : "";
    result.push({
      ...(id ? { id } : {}),
      title,
      scope: scope.length ? scope : [title],
      ...(files.length ? { files } : {}),
      dependencies: normalizeTexts(unit.dependencies ?? []),
      ...(expectedEffects.length ? { expectedEffects } : {}),
      acceptanceCriteria: acceptanceCriteria.length ? acceptanceCriteria : scope.length ? scope : [title],
    });
    if (result.length >= 20) break;
  }
  return result;
}

function expectedEffectsForPlannedStep(step: AgentStep, routeEffects: RouteExpectedEffect[]): RouteExpectedEffect[] {
  if (isPlannedWriteStep(step.agent)) return uniqueExpectedEffects(routeEffects);
  if (isPlannedVerificationStep(step.agent)) return routeEffects.includes("verify") ? ["read", "verify"] : ["read"];
  return ["read"];
}

function isPlannedWriteStep(agent: string): boolean {
  const normalized = agent.toLowerCase();
  return normalized === "worker" || normalized === "writer" || normalized === "implementer" || normalized === "conflict-resolver" || normalized === "repair";
}

function isPlannedVerificationStep(agent: string): boolean {
  const normalized = agent.toLowerCase();
  return normalized === "reviewer" || normalized === "verifier" || normalized === "validator" || normalized === "qa";
}

function appendDagStages(run: RunState, stages: Extract<RoutePlan, { kind: "dag" }>["stages"], afterStageId?: string): void {
  if (!run.route.plan || run.route.plan.kind !== "dag") {
    const completedSteps = run.steps.filter((step) => step.status !== "pending" || step.stageId === "sequential");
    run.route.plan = {
      kind: "dag",
      stages: [
        { id: "completed", tasks: completedSteps.map(toAgentStep) },
        ...stages,
      ],
    };
    run.route.kind = "multi-agent-dag";
    return;
  }
  const stageIndex = afterStageId ? run.route.plan.stages.findIndex((stage) => stage.id === afterStageId) : -1;
  if (stageIndex >= 0) {
    run.route.plan.stages.splice(stageIndex + 1, 0, ...stages);
    return;
  }
  run.route.plan.stages.push(...stages);
}

function toAgentStep(step: RunStepState): AgentStep {
  return { id: step.id.split(":").at(-1), agent: step.agent, task: step.task, budget: step.budget };
}

function routeExpectedEffects(route: RouteDecision): RouteExpectedEffect[] {
  return route.expectedEffects?.length ? route.expectedEffects : ["read"];
}

function unitTaskForEffects(unit: AgentHandoffWorkUnit, expectedEffects: RouteExpectedEffect[]): string {
  const contract = formatUnitContract(unit);
  const expectedEffectSet = new Set(expectedEffects);
  if (expectedEffectSet.has("write")) {
    return [
      `Implement work unit '${unit.title}'.`,
      contract,
      "Preserve the Original User Goal. Change only files in this WorkUnit scope; commands that create or update files are mutations too. Preserve public/exported signatures unless this WorkUnit includes every direct caller/update surface. If another file or caller update is required, stop and report the missing dependency or scope gap instead of editing outside the unit.",
    ].join(" ");
  }
  if (expectedEffectSet.has("verify")) {
    return [
      `Review work unit '${unit.title}' against the Original User Goal, available evidence, and verification/readback criteria.`,
      contract,
    ].join(" ");
  }
  return [
    `Analyze work unit '${unit.title}' against the Original User Goal and hand off evidence, gaps, and recommended next actions.`,
    contract,
  ].join(" ");
}

function reviewUnitTask(unit: AgentHandoffWorkUnit): string {
  return [
    `Review work unit '${unit.title}' against the Original User Goal, worker changes, and verification evidence.`,
    formatUnitContract(unit),
    "Fail or mark GAP if the worker edited outside this WorkUnit scope without an explicit dependency/scope-gap handoff.",
  ].join(" ");
}

function formatUnitContract(unit: AgentHandoffWorkUnit): string {
  return [
    unit.scope.length ? `Scope: ${unit.scope.join("; ")}.` : undefined,
    unit.files?.length ? `Files: ${unit.files.join("; ")}.` : undefined,
    unit.files?.length ? "Only the Files list is mutation-authoritative; scope text, acceptance criteria, or prior handoffs cannot authorize extra files unless they appear in Files." : undefined,
    unit.acceptanceCriteria.length ? `Acceptance criteria: ${unit.acceptanceCriteria.join("; ")}.` : undefined,
    unit.dependencies?.length ? `Dependencies: ${unit.dependencies.join("; ")}.` : undefined,
    unit.files?.length ? "Use edit for listed files that already exist, including full-content replacements; use write only for listed paths proven not to exist." : undefined,
  ].filter((line): line is string => Boolean(line)).join(" ");
}

function kindForAgent(agent: string): WorkUnitKind {
  if (agent === "scout" || agent === "researcher") return "discovery";
  if (agent === "planner") return "planning";
  if (agent === "reviewer") return "review";
  if (agent === "context-builder") return "synthesis";
  if (agent.toLowerCase() === "repair") return "repair";
  return "implementation";
}

function taskTitle(task: string): string {
  return normalizeText(task).slice(0, 80) || "work unit";
}

function safeId(value: string): string {
  let output = "";
  let lastWasSeparator = false;
  for (const char of value.toLowerCase()) {
    const code = char.charCodeAt(0);
    const isLetter = code >= 97 && code <= 122;
    const isDigit = code >= 48 && code <= 57;
    if (isLetter || isDigit) {
      output += char;
      lastWasSeparator = false;
      continue;
    }
    if (!lastWasSeparator && output.length > 0) {
      output += "-";
      lastWasSeparator = true;
    }
  }
  while (output.endsWith("-")) output = output.slice(0, -1);
  return output.slice(0, 48) || "unit";
}

function normalizeTexts(values: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const normalized = normalizeText(value);
    if (!normalized) continue;
    const key = normalized.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(normalized);
    if (result.length >= 20) break;
  }
  return result;
}

function normalizeText(value: string): string {
  let output = "";
  let lastWasWhitespace = false;
  for (const char of value.trim()) {
    if (isWhitespace(char)) {
      if (!lastWasWhitespace) output += " ";
      lastWasWhitespace = true;
      continue;
    }
    output += char;
    lastWasWhitespace = false;
  }
  return output.trim();
}

function isWhitespace(char: string): boolean {
  return char === " " || char === "\n" || char === "\r" || char === "\t" || char === "\f" || char === "\v";
}
