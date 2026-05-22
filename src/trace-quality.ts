export type TraceVariant = "simple" | "mesh";
export type TraceIssueSeverity = "critical" | "warning" | "suggestion";

export interface TraceToolEvent {
  name: string;
  phase: "start" | "end" | "unknown";
  type?: string;
  index: number;
  argsText: string;
  resultText: string;
  isError: boolean;
}

export interface ParsedPiTrace {
  jsonEvents: number;
  nonJsonLines: number;
  eventTypes: Record<string, number>;
  toolEvents: TraceToolEvent[];
  assistantText: string;
  assistantTextChars: number;
  meshRouteResults: string[];
  meshRouteArgs: string[];
  lastEventType?: string;
}

export interface TraceIssue {
  id: string;
  severity: TraceIssueSeverity;
  message: string;
  evidence?: string;
  penalty: number;
}

export interface TraceQualityReport {
  variant: TraceVariant;
  promptKind: "deep-project-analysis" | "generic";
  pass: boolean;
  score: number;
  effectiveAnswerSource: "mesh_route" | "assistant" | "provided-final" | "stdout" | "none";
  effectiveAnswerChars: number;
  metrics: {
    jsonEvents: number;
    nonJsonLines: number;
    toolEvents: number;
    meshRouteStarts: number;
    meshRouteEnds: number;
    meshRouteApprovalBlocked: number;
    meshRouteNonExecutable: number;
    meshRouteResultChars: number;
    exploratoryParentToolsAfterMesh: number;
    durationMs?: number;
  };
  critical: TraceIssue[];
  warnings: TraceIssue[];
  suggestions: TraceIssue[];
}

export interface GradePiTraceOptions {
  variant?: TraceVariant;
  promptKind?: "deep-project-analysis" | "generic";
  finalText?: string;
  status?: number | null;
  signal?: string | null;
  timeoutReason?: string;
  durationMs?: number;
  maxDurationMs?: number;
  minAnswerChars?: number;
  requireMeshRoute?: boolean;
}

const EXPLORATORY_PARENT_TOOLS = new Set(["read", "bash", "grep", "find", "ls", "glob"]);
const DEFAULT_MIN_DEEP_ANSWER_CHARS = 700;

export function parsePiJsonTrace(stdout: string): ParsedPiTrace {
  const eventTypes: Record<string, number> = {};
  const toolEvents: TraceToolEvent[] = [];
  const meshRouteResults: string[] = [];
  const meshRouteArgs: string[] = [];
  const assistantTexts: string[] = [];
  let currentAssistantText = "";
  let jsonEvents = 0;
  let nonJsonLines = 0;
  let assistantTextChars = 0;
  let lastEventType: string | undefined;

  for (const rawLine of stdout.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      nonJsonLines += 1;
      continue;
    }

    jsonEvents += 1;
    const type = stringField(parsed, "type");
    if (type) {
      lastEventType = type;
      eventTypes[type] = (eventTypes[type] ?? 0) + 1;
    }

    const assistantDelta = assistantDeltaText(parsed);
    if (assistantDelta) {
      currentAssistantText += assistantDelta;
      assistantTextChars += assistantDelta.length;
    }

    const assistantSnapshot = assistantMessageText(parsed);
    if (assistantSnapshot) currentAssistantText = assistantSnapshot;

    if (isAssistantMessageEnd(parsed) && currentAssistantText.trim()) {
      assistantTexts.push(currentAssistantText.trim());
    }

    for (const toolEvent of extractToolEvents(parsed, toolEvents.length)) {
      toolEvents.push(toolEvent);
      if (toolEvent.name === "mesh_route") {
        if (toolEvent.argsText.trim()) meshRouteArgs.push(toolEvent.argsText.trim());
        if (toolEvent.resultText.trim()) meshRouteResults.push(toolEvent.resultText.trim());
      }
    }
  }

  const assistantText = (assistantTexts.at(-1) || currentAssistantText).trim();
  return {
    jsonEvents,
    nonJsonLines,
    eventTypes,
    toolEvents,
    assistantText,
    assistantTextChars: Math.max(assistantTextChars, assistantText.length),
    meshRouteResults,
    meshRouteArgs,
    lastEventType,
  };
}

export function gradePiTrace(stdout: string, options: GradePiTraceOptions = {}): TraceQualityReport {
  const variant = options.variant ?? "mesh";
  const promptKind = options.promptKind ?? "deep-project-analysis";
  const trace = parsePiJsonTrace(stdout);
  const lastMeshResult = trace.meshRouteResults.at(-1)?.trim() ?? "";
  const providedFinal = options.finalText?.trim() ?? "";
  const assistant = trace.assistantText.trim();
  const effective = chooseEffectiveAnswer({ variant, lastMeshResult, lastMeshResultBlocked: isNonExecutableMeshResult(lastMeshResult), providedFinal, assistant, stdout });
  const issues: TraceIssue[] = [];

  const add = (issue: TraceIssue) => issues.push(issue);

  if (options.timeoutReason) {
    add({ id: "timeout", severity: "critical", message: "La corrida terminó por timeout; no es un resultado confiable.", evidence: options.timeoutReason, penalty: 45 });
  }
  if (options.signal) {
    add({ id: "terminated-signal", severity: "critical", message: "El proceso terminó por señal; hay que investigar colgado/interrupción.", evidence: options.signal, penalty: 35 });
  }
  if (typeof options.status === "number" && options.status !== 0) {
    add({ id: "non-zero-status", severity: "critical", message: "El proceso devolvió status no-cero.", evidence: String(options.status), penalty: 35 });
  }
  if (options.maxDurationMs && options.durationMs && options.durationMs > options.maxDurationMs) {
    add({ id: "duration-budget-exceeded", severity: "warning", message: "La corrida excedió el presupuesto de duración definido para evals rápidas.", evidence: `${options.durationMs}ms > ${options.maxDurationMs}ms`, penalty: 12 });
  }

  const meshStarts = trace.toolEvents.filter((item) => item.name === "mesh_route" && item.phase === "start").length;
  const meshEnds = trace.toolEvents.filter((item) => item.name === "mesh_route" && item.phase === "end").length;
  const meshApprovalBlocked = countApprovalBlockedMeshRoutes(trace.toolEvents);
  const meshNonExecutable = countNonExecutableMeshRoutes(trace.toolEvents);
  const meshResultChars = lastMeshResult.length;

  const requireMeshRoute = options.requireMeshRoute ?? (variant === "mesh" && promptKind === "deep-project-analysis");

  if (variant === "mesh") {
    if (requireMeshRoute && meshEnds === 0) {
      add({ id: "missing-mesh-route-result", severity: "critical", message: "La variante mesh no produjo resultado de `mesh_route`.", penalty: 40 });
    }
    if (meshEnds > 1) {
      add({ id: "repeated-mesh-route", severity: "warning", message: "El parent llamó `mesh_route` más de una vez; puede indicar loop/orquestación ineficiente.", evidence: `${meshEnds} completions`, penalty: 12 });
    }
    if (meshStarts > 1 && meshEnds <= 1) {
      add({ id: "restarted-mesh-route", severity: "warning", message: "Hay múltiples inicios de `mesh_route`; revisar retries o eventos duplicados.", evidence: `${meshStarts} starts`, penalty: 8 });
    }
  }

  const exploratoryAfterMesh = countExploratoryParentToolsAfterExecutableMesh(trace.toolEvents);
  if (variant === "mesh" && exploratoryAfterMesh > 0) {
    add({ id: "parent-tools-after-mesh", severity: "warning", message: "El parent siguió explorando con tools directas después de terminar `mesh_route`; suele romper el contrato de delegación.", evidence: `${exploratoryAfterMesh} exploratory tool events`, penalty: 10 });
  }
  if (variant === "mesh" && meshApprovalBlocked > 0) {
    add({ id: "mesh-route-approval-blocked", severity: "suggestion", message: "`mesh_route` quedó bloqueado por approval; si el parent recupera con tools directas, no debe contarse como exploración post-mesh.", evidence: `${meshApprovalBlocked} blocked route result(s)`, penalty: 0 });
  }
  if (variant === "mesh" && meshNonExecutable > meshApprovalBlocked) {
    add({ id: "mesh-route-direct-recommended", severity: "suggestion", message: "`mesh_route` recomendó ejecución directa; si el parent recupera con tools nativas, no debe contarse como handoff mesh ejecutado.", evidence: `${meshNonExecutable - meshApprovalBlocked} direct recommendation(s)`, penalty: 0 });
  }

  const answerText = effective.text;
  const minAnswerChars = options.minAnswerChars ?? (promptKind === "deep-project-analysis" ? DEFAULT_MIN_DEEP_ANSWER_CHARS : 120);
  if (!answerText.trim()) {
    add({ id: "missing-answer", severity: "critical", message: "No hay texto final evaluable ni material de `mesh_route`.", penalty: 45 });
  } else if (answerText.length < minAnswerChars && !hasConciseImplementationEvidence(answerText, promptKind)) {
    add({ id: "thin-answer", severity: "warning", message: "La respuesta/material final es demasiado corto para una revisión profunda.", evidence: `${answerText.length} chars`, penalty: 14 });
  }

  if (promptKind === "deep-project-analysis") {
    const discoveryEvidence = hasDiscoveryEvidence(trace, answerText);
    if (!discoveryEvidence) {
      add({ id: "missing-discovery-first-evidence", severity: "warning", message: "No hay señal de `mesh_project_discovery` ni de discovery-first en la traza/material.", penalty: 12 });
    }
    if (!hasPathEvidence(answerText)) {
      add({ id: "missing-file-evidence", severity: "critical", message: "Una revisión profunda sin paths/archivos concretos no es auditable.", penalty: 25 });
    }
    if (!hasCoverageOrEvidenceTable(answerText)) {
      add({ id: "missing-coverage-evidence-structure", severity: "warning", message: "Falta una estructura explícita de cobertura/evidencia; dificulta comparar accuracy.", penalty: 8 });
    }
  }

  if (variant === "mesh" && providedFinal && lastMeshResult && providedFinal.length < Math.min(400, lastMeshResult.length / 2)) {
    add({ id: "partial-parent-final", severity: "suggestion", message: "El texto final del parent parece parcial; para scoring se usó el material completo de `mesh_route`.", evidence: `final=${providedFinal.length}, mesh_result=${lastMeshResult.length}`, penalty: 0 });
  }

  const penalty = issues.reduce((sum, issue) => sum + issue.penalty, 0);
  const score = Math.max(0, Math.min(100, 100 - penalty));
  const critical = issues.filter((issue) => issue.severity === "critical");
  const warnings = issues.filter((issue) => issue.severity === "warning");
  const suggestions = issues.filter((issue) => issue.severity === "suggestion");
  return {
    variant,
    promptKind,
    pass: critical.length === 0 && score >= 80,
    score,
    effectiveAnswerSource: effective.source,
    effectiveAnswerChars: answerText.length,
    metrics: {
      jsonEvents: trace.jsonEvents,
      nonJsonLines: trace.nonJsonLines,
      toolEvents: trace.toolEvents.length,
      meshRouteStarts: meshStarts,
      meshRouteEnds: meshEnds,
      meshRouteApprovalBlocked: meshApprovalBlocked,
      meshRouteNonExecutable: meshNonExecutable,
      meshRouteResultChars: meshResultChars,
      exploratoryParentToolsAfterMesh: exploratoryAfterMesh,
      durationMs: options.durationMs,
    },
    critical,
    warnings,
    suggestions,
  };
}

export function buildTraceJudgePrompt(input: { report: TraceQualityReport; stdoutSnippet?: string; finalTextSnippet?: string; rubric?: string }): string {
  return [
    "Eres un juez de evals de agentes. Evalúa si la traza demuestra comportamiento correcto, robusto y eficiente.",
    "Responde SOLO JSON válido con: {\"pass\":boolean,\"score\":number,\"verdict\":string,\"critical\":string[],\"warnings\":string[]}.",
    "Criterios: prioriza evidencia verificable, uso correcto de tools, cobertura suficiente, ausencia de loops/timeouts y fidelidad al proyecto. Si no hay evidencia suficiente, usa pass=false.",
    input.rubric ? `Rubrica adicional:\n${input.rubric}` : "",
    `Reporte determinístico:\n${JSON.stringify(input.report, null, 2)}`,
    input.finalTextSnippet ? `Texto final/material:\n${input.finalTextSnippet}` : "",
    input.stdoutSnippet ? `Snippet de traza:\n${input.stdoutSnippet}` : "",
  ].filter(Boolean).join("\n\n");
}

export interface TraceJudgeVerdict {
  pass: boolean;
  score: number;
  verdict: string;
  critical: string[];
  warnings: string[];
}

export function parseTraceJudgeVerdict(text: string): TraceJudgeVerdict {
  const parsed = parseJsonObjectFromText(text);
  const pass = Boolean(parsed.pass);
  const score = typeof parsed.score === "number" && Number.isFinite(parsed.score) ? Math.max(0, Math.min(100, Math.round(parsed.score))) : 0;
  const verdict = typeof parsed.verdict === "string" ? parsed.verdict : "No verdict";
  const critical = Array.isArray(parsed.critical) ? parsed.critical.filter((item): item is string => typeof item === "string") : [];
  const warnings = Array.isArray(parsed.warnings) ? parsed.warnings.filter((item): item is string => typeof item === "string") : [];
  return { pass, score, verdict, critical, warnings };
}

function chooseEffectiveAnswer(input: { variant: TraceVariant; lastMeshResult: string; lastMeshResultBlocked: boolean; providedFinal: string; assistant: string; stdout: string }): { source: TraceQualityReport["effectiveAnswerSource"]; text: string } {
  if (input.variant === "mesh" && input.lastMeshResult && !input.lastMeshResultBlocked) return { source: "mesh_route", text: input.lastMeshResult };
  if (input.providedFinal) return { source: "provided-final", text: input.providedFinal };
  if (input.assistant) return { source: "assistant", text: input.assistant };
  const trimmedStdout = input.stdout.trim();
  if (trimmedStdout && !looksLikeOnlyJsonLines(trimmedStdout)) return { source: "stdout", text: trimmedStdout };
  return { source: "none", text: "" };
}

function extractToolEvents(parsed: unknown, indexBase: number): TraceToolEvent[] {
  const type = stringField(parsed, "type");
  const result = field(parsed, "result") ?? field(parsed, "output");
  const args = field(parsed, "args") ?? field(parsed, "arguments") ?? field(parsed, "input") ?? field(parsed, "params");
  const directToolName = stringField(parsed, "toolName") ?? nestedStringField(parsed, ["tool", "name"]) ?? stringField(parsed, "name");
  const phase = phaseFromType(type);
  const events: TraceToolEvent[] = [];

  if (directToolName && (phase !== "unknown" || directToolName === "mesh_route" || Boolean(result))) {
    events.push({
      name: directToolName,
      phase,
      type,
      index: indexBase,
      argsText: unknownToSearchableText(args),
      resultText: toolResultToText(result) || unknownToSearchableText(result),
      isError: Boolean(field(parsed, "isError")) || Boolean(field(parsed, "error")) || type === "tool_execution_error",
    });
  }

  for (const block of messageContentBlocks(parsed)) {
    if (!block || typeof block !== "object") continue;
    const blockType = stringField(block, "type");
    if (blockType !== "tool_use" && blockType !== "tool_result") continue;
    const name = stringField(block, "name") ?? stringField(block, "toolName") ?? "unknown_tool";
    events.push({
      name,
      phase: blockType === "tool_use" ? "start" : "end",
      type: blockType,
      index: indexBase + events.length,
      argsText: unknownToSearchableText(field(block, "input") ?? field(block, "args")),
      resultText: toolResultToText(field(block, "content")) || unknownToSearchableText(field(block, "content")),
      isError: Boolean(field(block, "is_error")),
    });
  }

  return events;
}

function phaseFromType(type: string | undefined): TraceToolEvent["phase"] {
  if (!type) return "unknown";
  if (/tool.*(start|begin|call|use)/i.test(type)) return "start";
  if (/tool.*(end|result|finish|complete)/i.test(type)) return "end";
  if (/tool.*error/i.test(type)) return "end";
  return "unknown";
}

function countExploratoryParentToolsAfterExecutableMesh(toolEvents: TraceToolEvent[]): number {
  const lastMeshEndIndex = toolEvents.findLastIndex((item) => item.name === "mesh_route" && item.phase === "end" && !isNonExecutableMeshResult(item.resultText));
  if (lastMeshEndIndex < 0) return 0;
  return toolEvents.slice(lastMeshEndIndex + 1).filter((item) => EXPLORATORY_PARENT_TOOLS.has(item.name) && item.phase !== "end").length;
}

function countApprovalBlockedMeshRoutes(toolEvents: TraceToolEvent[]): number {
  return toolEvents.filter((item) => item.name === "mesh_route" && item.phase === "end" && isApprovalBlockedMeshResult(item.resultText)).length;
}

function countNonExecutableMeshRoutes(toolEvents: TraceToolEvent[]): number {
  return toolEvents.filter((item) => item.name === "mesh_route" && item.phase === "end" && isNonExecutableMeshResult(item.resultText)).length;
}

function isNonExecutableMeshResult(text: string): boolean {
  return isApprovalBlockedMeshResult(text) || /\bstatus:\s*direct-recommended\b|direct execution recommended|pi-chalin direct execution recommended/i.test(text);
}

function isApprovalBlockedMeshResult(text: string): boolean {
  return /\bApproval:\s*(ask|block)\b/i.test(text)
    || /\bstatus:\s*(ask|block)\b/i.test(text)
    || /did not execute because approval is required/i.test(text);
}

function hasDiscoveryEvidence(trace: ParsedPiTrace, answerText: string): boolean {
  const haystack = [
    answerText,
    trace.meshRouteArgs.join("\n"),
    trace.meshRouteResults.join("\n"),
    trace.toolEvents.map((item) => `${item.name} ${item.argsText} ${item.resultText}`).join("\n"),
  ].join("\n");
  return /mesh_project_discovery|Project Discovery Index|Cached Project Discovery Index|discovery[- ]first|índice de descubrimiento/i.test(haystack);
}

function hasPathEvidence(text: string): boolean {
  return /(?:^|[\s`])(?:[\w.-]+\/){1,}[\w.@-]+/m.test(text)
    || /(?:^|[\s`])(package\.json|go\.mod|Cargo\.toml|pyproject\.toml|README\.md|tsconfig\.json|pnpm-workspace\.yaml)(?:[\s`.,:;)]|$)/i.test(text);
}

function hasCoverageOrEvidenceTable(text: string): boolean {
  return /Coverage Matrix|Evidence Table|Matriz de cobertura|Tabla de evidencia|evidencia\s*\|/i.test(text);
}

function hasConciseImplementationEvidence(text: string, promptKind: GradePiTraceOptions["promptKind"]): boolean {
  if (promptKind === "deep-project-analysis") return false;
  return hasPathEvidence(text) && /\b(npm\s+test|pnpm\s+test|yarn\s+test|bun\s+test|node\s+--test|go\s+test|cargo\s+test|pytest|vitest|jest|tsc|typecheck|eslint|passed|pass|✅|verificaci[oó]n|prueba)\b/i.test(text);
}

function assistantDeltaText(parsed: unknown): string {
  const event = field(parsed, "assistantMessageEvent");
  if (!event || typeof event !== "object") return "";
  if (stringField(event, "type") === "text_delta") return stringField(event, "delta") ?? "";
  if (stringField(event, "type") === "text_end") return stringField(event, "content") ?? "";
  return "";
}

function assistantMessageText(parsed: unknown): string {
  const message = field(parsed, "message");
  if (!message || typeof message !== "object" || stringField(message, "role") !== "assistant") return "";
  return contentToText(field(message, "content"));
}

function isAssistantMessageEnd(parsed: unknown): boolean {
  const type = stringField(parsed, "type");
  const message = field(parsed, "message");
  return (type === "message_end" || type === "turn_end") && Boolean(message && typeof message === "object" && stringField(message, "role") === "assistant");
}

function messageContentBlocks(parsed: unknown): unknown[] {
  const message = field(parsed, "message");
  const content = message && typeof message === "object" ? field(message, "content") : field(parsed, "content");
  return Array.isArray(content) ? content : [];
}

function toolResultToText(result: unknown): string {
  if (typeof result === "string") return result;
  if (Array.isArray(result)) return result.map((part) => toolResultToText(part)).join("");
  if (!result || typeof result !== "object") return "";
  const content = field(result, "content");
  if (content !== undefined) return toolResultToText(content);
  const text = stringField(result, "text") ?? stringField(result, "value") ?? stringField(result, "output");
  return text ?? "";
}

function contentToText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((part) => {
    if (typeof part === "string") return part;
    if (part && typeof part === "object" && "text" in part && typeof part.text === "string") return part.text;
    return "";
  }).join("");
}

function unknownToSearchableText(value: unknown): string {
  if (value === undefined || value === null) return "";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function stringField(value: unknown, key: string): string | undefined {
  const item = field(value, key);
  return typeof item === "string" ? item : undefined;
}

function nestedStringField(value: unknown, path: string[]): string | undefined {
  let current = value;
  for (const key of path) current = field(current, key);
  return typeof current === "string" ? current : undefined;
}

function field(value: unknown, key: string): unknown {
  return value && typeof value === "object" && key in value ? (value as Record<string, unknown>)[key] : undefined;
}

function looksLikeOnlyJsonLines(value: string): boolean {
  const lines = value.split(/\r?\n/).filter((line) => line.trim());
  return lines.length > 0 && lines.every((line) => {
    try {
      JSON.parse(line);
      return true;
    } catch {
      return false;
    }
  });
}

function parseJsonObjectFromText(text: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(text) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
  } catch {
    // Try fenced or embedded JSON below.
  }
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1];
  if (fenced) return parseJsonObjectFromText(fenced);
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start >= 0 && end > start) {
    const parsed = JSON.parse(text.slice(start, end + 1)) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
  }
  throw new Error("Judge output did not contain a JSON object");
}
