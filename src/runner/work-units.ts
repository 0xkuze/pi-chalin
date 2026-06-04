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
    const unitStepIds = workUnitStepIds(unit);
    const unitSteps = run.steps.filter((step) => step.workUnitId === unit.id || unitStepIds.has(step.id));
    if (unitSteps.length === 0) continue;
    const running = unitSteps.find((step) => step.status === "running");
    const failed = unitSteps.find((step) => step.status === "failed");
    const skipped = unitSteps.find((step) => step.status === "skipped");
    if (running) {
      unit.status = "running";
      if (failed?.error && !unit.failureReason) unit.failureReason = failed.error;
    } else if (failed) {
      unit.status = "failed";
      unit.failureReason = failed.error;
    } else if (skipped) {
      unit.status = "skipped";
      unit.skippedReason = skipped.skipReason;
    } else if (unitSteps.some((step) => step.status === "paused")) unit.status = "paused";
    else if (unitSteps.every((step) => step.status === "complete" || step.status === "checkpointed")) unit.status = "complete";
    else unit.status = "pending";
    if (unit.status !== "skipped") delete unit.skippedReason;
  }
}

function workUnitStepIds(unit: WorkUnit): Set<string> {
  return new Set([unit.workerStepId, unit.reviewerStepId, unit.finalReviewerStepId, unit.sourceStepId].filter((id): id is string => Boolean(id)));
}

export function expandWorkUnitsFromHandoff(run: RunState, sourceStep: RunStepState): boolean {
  if (run.intentContract?.requiresInterview || run.recoveryState?.blockedByHumanInput) return false;
  if (sourceStep.agent === "planner") return false;
  if (sourceStep.status === "skipped" || sourceStep.skipReason) return false;
  if (!hasWorkUnitDiscoveryRequest(run)) return false;
  if (run.workUnits?.some((unit) => unit.createdFrom === "fanout")) return false;
  const sourceUnit = run.workUnits?.find((unit) => unit.id === sourceStep.workUnitId);
  if (sourceUnit?.createdFrom === "fanout") return false;
  const sourceRank = workUnitSourceRank(run, sourceStep);
  if (sourceRank <= 0 || hasPendingWorkUnitAuthority(run, sourceRank)) return false;
  const fanoutUnits = extractFanoutWorkUnits(sourceStep);
  if (fanoutUnits.length < 2) {
    run.warnings.push(`Structured WorkUnit discovery from ${sourceStep.agent}/${sourceStep.id} returned ${fanoutUnits.length} unit(s); no WorkUnit execution was materialized.`);
    return false;
  }

  const routeEffects = routeExpectedEffects(run.route);
  const unitRefs = compileFanoutUnitRefs(sourceStep, fanoutUnits)
    .map((unitRef) => enrichFanoutUnitRef(unitRef, routeEffects));
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
      sourceStepId: sourceStep.id,
      createdFrom: "fanout",
    };
  });
  const planningStageId = `fanout-${safeId(sourceStep.id)}-route-plan`;
  const planningStepId = `${planningStageId}:step-1`;
  const planningUnit: WorkUnit = {
    id: `${planningStageId}-unit`,
    title: "Plan discovered WorkUnit execution",
    kind: "planning",
    status: "pending",
    scope: workUnits.map((unit) => unit.title),
    dependencies: [sourceStep.workUnitId ?? sourceStep.id, ...unitRefs.flatMap((unitRef) => unitRef.dependencyUnitIds)],
    expectedEffects: ["read"],
    acceptanceCriteria: ["Choose the executable route, agent responsibilities, dependencies, and verification coverage for discovered WorkUnits without mutating files."],
    workerStepId: planningStepId,
    sourceStepId: sourceStep.id,
    createdFrom: "fanout",
  };
  const plannerStep: RunStepState = {
    id: planningStepId,
    agent: "planner",
    task: planDiscoveredWorkUnitsTask(sourceStep, workUnits, routeEffects),
    status: "pending",
    stageId: planningStageId,
    workUnitId: planningUnit.id,
    dependencies: [sourceStep.id],
    budget: "normal",
  };

  run.workUnits = [...(run.workUnits ?? []), ...workUnits, planningUnit];
  insertStepAfterSource(run, plannerStep, sourceStep);
  appendDagStages(run, [{ id: planningStageId, tasks: [toAgentStep(plannerStep)] }], sourceStep.stageId);
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
  run.warnings.push(`Queued planner route selection for ${workUnits.length} discovered WorkUnit(s) after ${sourceStep.agent}/${sourceStep.id}.`);
  return true;
}

function hasWorkUnitDiscoveryRequest(run: RunState): boolean {
  return run.intentContract?.workUnitDiscoveryRequested === true || run.intentContract?.fanoutAuthorized === true;
}

interface FanoutUnitRef {
  index: number;
  id: string;
  input: AgentHandoffWorkUnit;
  expectedEffects: RouteExpectedEffect[];
  kind: WorkUnitKind;
  dependencyUnitIds: string[];
  unresolvedDependencies: string[];
  autoDependencies: string[];
}

function compileFanoutUnitRefs(sourceStep: RunStepState, fanoutUnits: AgentHandoffWorkUnit[]): FanoutUnitRef[] {
  const sourcePrefix = `fanout-${safeId(sourceStep.id)}`;
  const refs = fanoutUnits.map((unit, index): FanoutUnitRef => ({
    index,
    id: `${sourcePrefix}-${index + 1}`,
    input: unit,
    expectedEffects: ["read"],
    kind: "planning",
    dependencyUnitIds: [],
    unresolvedDependencies: [],
    autoDependencies: [],
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
    kind: kindForExpectedEffects(expectedEffects),
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

function kindForExpectedEffects(expectedEffects: RouteExpectedEffect[]): WorkUnitKind {
  const effectSet = new Set(expectedEffects);
  if (effectSet.has("write")) return "implementation";
  if (effectSet.has("verify")) return "review";
  return "synthesis";
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

function normalizeDependencyKey(value: string): string {
  return normalizeText(value).toLowerCase();
}

function workUnitSourceRank(run: RunState, step: RunStepState): number {
  const sourceUnit = run.workUnits?.find((unit) => unit.id === step.workUnitId);
  if (sourceUnit?.createdFrom === "fanout") return 0;
  if (step.agent === "planner") return workUnitAuthorityRank("planning");
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
    units.push(unitForStep(unitId, step, id, expectedEffects, index > 0 ? [steps[index - 1]!.workUnitId ?? steps[index - 1]!.id] : []));
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
      units.push(unitForStep(unitId, step, id, expectedEffects, priorStageUnitIds));
      stageStepIds.push(id);
      stageUnitIds.push(unitId);
    });
    priorStageStepIds = stageStepIds;
    priorStageUnitIds = stageUnitIds;
  }
  return { steps, workUnits: units };
}

function unitForStep(unitId: string, step: AgentStep, stepId: string, expectedEffects: RouteExpectedEffect[], dependencies: string[]): WorkUnit {
  const unitExpectedEffects = expectedEffectsForPlannedStep(step, expectedEffects);
  return {
    id: unitId,
    title: step.id || taskTitle(step.task),
    kind: kindForExpectedEffects(unitExpectedEffects),
    status: "pending",
    scope: [step.task],
    dependencies,
    expectedEffects: unitExpectedEffects,
    acceptanceCriteria: [step.task],
    ...(step.files?.length ? { files: step.files } : {}),
    ...stepReferenceForExpectedEffects(unitExpectedEffects, stepId),
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
  if (step.expectedEffects?.length) return uniqueExpectedEffects(step.expectedEffects);
  if (routeEffects.length === 1) return uniqueExpectedEffects(routeEffects);
  return ["read"];
}

function stepReferenceForExpectedEffects(expectedEffects: RouteExpectedEffect[], stepId: string): Pick<WorkUnit, "workerStepId" | "reviewerStepId"> {
  const effectSet = new Set(expectedEffects);
  if (effectSet.has("write")) return { workerStepId: stepId };
  if (effectSet.has("verify")) return { reviewerStepId: stepId };
  return { workerStepId: stepId };
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

function insertStepAfterSource(run: RunState, step: RunStepState, sourceStep: RunStepState): void {
  const sourceIndex = run.steps.indexOf(sourceStep);
  if (sourceIndex < 0) {
    run.steps.push(step);
    return;
  }
  const insertionIndex = sourceStep.stageId
    ? lastStepIndexForStage(run.steps, sourceStep.stageId, sourceIndex) + 1
    : sourceIndex + 1;
  run.steps.splice(insertionIndex, 0, step);
}

function lastStepIndexForStage(steps: RunStepState[], stageId: string, fallbackIndex: number): number {
  let index = fallbackIndex;
  for (let candidateIndex = fallbackIndex + 1; candidateIndex < steps.length; candidateIndex += 1) {
    if (steps[candidateIndex]?.stageId !== stageId) continue;
    index = candidateIndex;
  }
  return index;
}

function toAgentStep(step: RunStepState): AgentStep {
  return { id: step.id.split(":").at(-1), agent: step.agent, task: step.task, budget: step.budget };
}

function routeExpectedEffects(route: RouteDecision): RouteExpectedEffect[] {
  return route.expectedEffects?.length ? route.expectedEffects : ["read"];
}

function planDiscoveredWorkUnitsTask(sourceStep: RunStepState, workUnits: WorkUnit[], routeEffects: RouteExpectedEffect[]): string {
  const unitSummary = workUnits.map((unit) => [
    `- ${unit.id}: ${unit.title}`,
    `  effects: ${unit.expectedEffects.join(", ")}`,
    unit.files?.length ? `  files: ${unit.files.join(", ")}` : undefined,
    unit.dependencies.length ? `  dependencies: ${unit.dependencies.join(", ")}` : undefined,
    unit.acceptanceCriteria.length ? `  acceptance: ${unit.acceptanceCriteria.join("; ")}` : undefined,
  ].filter((line): line is string => Boolean(line)).join("\n")).join("\n");
  return [
    `Decide the executable route for ${workUnits.length} discovered WorkUnit(s) from ${sourceStep.agent}/${sourceStep.id}.`,
    "Do not mutate files in this planning step.",
    "Use semantic judgment to decide whether nested delegation is needed, which effects each unit requires, dependencies, verification coverage, and whether human clarification is needed.",
    "If execution is needed, call chalin_delegate with the bounded objective and current evidence; do not choose topology, agents, or per-step budgets yourself.",
    `Route-level expected effects: ${routeEffects.join(", ")}.`,
    "Discovered WorkUnits:",
    unitSummary,
  ].join("\n");
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
