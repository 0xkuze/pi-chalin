export type TraceVariant = "simple" | "chalin";
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
  chalinRouteResults: string[];
  chalinRouteArgs: string[];
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
  effectiveAnswerSource: "chalin_route" | "assistant" | "provided-final" | "stdout" | "none";
  effectiveAnswerChars: number;
  metrics: {
    jsonEvents: number;
    nonJsonLines: number;
    toolEvents: number;
    chalinRouteStarts: number;
    chalinRouteEnds: number;
    chalinRouteApprovalBlocked: number;
    chalinRouteNonExecutable: number;
    chalinRouteResultChars: number;
    exploratoryParentToolsAfterChalin: number;
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
  requireChalinRoute?: boolean;
}

const EXPLORATORY_PARENT_TOOLS = new Set(["read", "bash", "grep", "find", "ls", "glob"]);
const DEFAULT_MIN_DEEP_ANSWER_CHARS = 700;

export function parsePiJsonTrace(stdout: string): ParsedPiTrace {
  const eventTypes: Record<string, number> = {};
  const toolEvents: TraceToolEvent[] = [];
  const chalinRouteResults: string[] = [];
  const chalinRouteArgs: string[] = [];
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
      if (toolEvent.name === "chalin_route") {
        if (toolEvent.argsText.trim()) chalinRouteArgs.push(toolEvent.argsText.trim());
        if (toolEvent.resultText.trim()) chalinRouteResults.push(toolEvent.resultText.trim());
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
    chalinRouteResults,
    chalinRouteArgs,
    lastEventType,
  };
}

export function gradePiTrace(stdout: string, options: GradePiTraceOptions = {}): TraceQualityReport {
  const variant = options.variant ?? "chalin";
  const promptKind = options.promptKind ?? "deep-project-analysis";
  const trace = parsePiJsonTrace(stdout);
  const lastChalinResult = trace.chalinRouteResults.at(-1)?.trim() ?? "";
  const providedFinal = options.finalText?.trim() ?? "";
  const assistant = trace.assistantText.trim();
  const effective = chooseEffectiveAnswer({ variant, lastChalinResult, lastChalinResultBlocked: isNonExecutableChalinResult(lastChalinResult), providedFinal, assistant, stdout });
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

  const chalinStarts = trace.toolEvents.filter((item) => item.name === "chalin_route" && item.phase === "start").length;
  const chalinEnds = trace.toolEvents.filter((item) => item.name === "chalin_route" && item.phase === "end").length;
  const chalinApprovalBlocked = countApprovalBlockedChalinRoutes(trace.toolEvents);
  const chalinNonExecutable = countNonExecutableChalinRoutes(trace.toolEvents);
  const chalinResultChars = lastChalinResult.length;

  const requireChalinRoute = options.requireChalinRoute ?? (variant === "chalin" && promptKind === "deep-project-analysis");

  if (variant === "chalin") {
    if (requireChalinRoute && chalinEnds === 0) {
      add({ id: "missing-chalin-route-result", severity: "critical", message: "La variante chalin no produjo resultado de `chalin_route`.", penalty: 40 });
    }
    if (chalinEnds > 1) {
      add({ id: "repeated-chalin-route", severity: "warning", message: "El parent llamó `chalin_route` más de una vez; puede indicar loop/orquestación ineficiente.", evidence: `${chalinEnds} completions`, penalty: 12 });
    }
    if (chalinStarts > 1 && chalinEnds <= 1) {
      add({ id: "restarted-chalin-route", severity: "warning", message: "Hay múltiples inicios de `chalin_route`; revisar retries o eventos duplicados.", evidence: `${chalinStarts} starts`, penalty: 8 });
    }
  }

  const exploratoryAfterChalin = countExploratoryParentToolsAfterExecutableChalin(trace.toolEvents);
  if (variant === "chalin" && exploratoryAfterChalin > 0) {
    add({ id: "parent-tools-after-chalin", severity: "warning", message: "El parent siguió explorando con tools directas después de terminar `chalin_route`; suele romper el contrato de delegación.", evidence: `${exploratoryAfterChalin} exploratory tool events`, penalty: 10 });
  }
  if (variant === "chalin" && chalinApprovalBlocked > 0) {
    add({ id: "chalin-route-approval-blocked", severity: "suggestion", message: "`chalin_route` quedó bloqueado por approval; si el parent recupera con tools directas, no debe contarse como exploración post-chalin.", evidence: `${chalinApprovalBlocked} blocked route result(s)`, penalty: 0 });
  }
  if (variant === "chalin" && chalinNonExecutable > chalinApprovalBlocked) {
    add({ id: "chalin-route-direct-recommended", severity: "suggestion", message: "`chalin_route` recomendó ejecución directa; si el parent recupera con tools nativas, no debe contarse como handoff chalin ejecutado.", evidence: `${chalinNonExecutable - chalinApprovalBlocked} direct recommendation(s)`, penalty: 0 });
  }

  const answerText = effective.text;
  const minAnswerChars = options.minAnswerChars ?? (promptKind === "deep-project-analysis" ? DEFAULT_MIN_DEEP_ANSWER_CHARS : 120);
  if (!answerText.trim()) {
    add({ id: "missing-answer", severity: "critical", message: "No hay texto final evaluable ni material de `chalin_route`.", penalty: 45 });
  } else if (answerText.length < minAnswerChars && !hasConciseImplementationEvidence(answerText, promptKind)) {
    add({ id: "thin-answer", severity: "warning", message: "La respuesta/material final es demasiado corto para una revisión profunda.", evidence: `${answerText.length} chars`, penalty: 14 });
  }

  if (promptKind === "deep-project-analysis") {
    const discoveryEvidence = hasDiscoveryEvidence(trace, answerText);
    if (!discoveryEvidence) {
      add({ id: "missing-discovery-first-evidence", severity: "warning", message: "No hay señal de `chalin_project_discovery` ni de discovery-first en la traza/material.", penalty: 12 });
    }
    if (!hasPathEvidence(answerText)) {
      add({ id: "missing-file-evidence", severity: "critical", message: "Una revisión profunda sin paths/archivos concretos no es auditable.", penalty: 25 });
    }
    if (!hasCoverageOrEvidenceTable(answerText)) {
      add({ id: "missing-coverage-evidence-structure", severity: "warning", message: "Falta una estructura explícita de cobertura/evidencia; dificulta comparar accuracy.", penalty: 8 });
    }
  }

  if (variant === "chalin" && providedFinal && lastChalinResult && providedFinal.length < Math.min(400, lastChalinResult.length / 2)) {
    add({ id: "partial-parent-final", severity: "suggestion", message: "El texto final del parent parece parcial; para scoring se usó el material completo de `chalin_route`.", evidence: `final=${providedFinal.length}, chalin_result=${lastChalinResult.length}`, penalty: 0 });
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
      chalinRouteStarts: chalinStarts,
      chalinRouteEnds: chalinEnds,
      chalinRouteApprovalBlocked: chalinApprovalBlocked,
      chalinRouteNonExecutable: chalinNonExecutable,
      chalinRouteResultChars: chalinResultChars,
      exploratoryParentToolsAfterChalin: exploratoryAfterChalin,
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

function chooseEffectiveAnswer(input: { variant: TraceVariant; lastChalinResult: string; lastChalinResultBlocked: boolean; providedFinal: string; assistant: string; stdout: string }): { source: TraceQualityReport["effectiveAnswerSource"]; text: string } {
  if (input.variant === "chalin" && input.lastChalinResult && !input.lastChalinResultBlocked) return { source: "chalin_route", text: input.lastChalinResult };
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

  if (directToolName && (phase !== "unknown" || directToolName === "chalin_route" || Boolean(result))) {
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

function countExploratoryParentToolsAfterExecutableChalin(toolEvents: TraceToolEvent[]): number {
  const lastChalinEndIndex = toolEvents.findLastIndex((item) => item.name === "chalin_route" && item.phase === "end" && !isNonExecutableChalinResult(item.resultText));
  if (lastChalinEndIndex < 0) return 0;
  return toolEvents.slice(lastChalinEndIndex + 1).filter((item) => EXPLORATORY_PARENT_TOOLS.has(item.name) && item.phase !== "end").length;
}

function countApprovalBlockedChalinRoutes(toolEvents: TraceToolEvent[]): number {
  return toolEvents.filter((item) => item.name === "chalin_route" && item.phase === "end" && isApprovalBlockedChalinResult(item.resultText)).length;
}

function countNonExecutableChalinRoutes(toolEvents: TraceToolEvent[]): number {
  return toolEvents.filter((item) => item.name === "chalin_route" && item.phase === "end" && isNonExecutableChalinResult(item.resultText)).length;
}

function isNonExecutableChalinResult(text: string): boolean {
  return isApprovalBlockedChalinResult(text) || /\bstatus:\s*direct-recommended\b|direct execution recommended|pi-chalin direct execution recommended/i.test(text);
}

function isApprovalBlockedChalinResult(text: string): boolean {
  return /\bApproval:\s*(ask|block)\b/i.test(text)
    || /\bstatus:\s*(ask|block)\b/i.test(text)
    || /did not execute because approval is required/i.test(text);
}

function hasDiscoveryEvidence(trace: ParsedPiTrace, answerText: string): boolean {
  const haystack = [
    answerText,
    trace.chalinRouteArgs.join("\n"),
    trace.chalinRouteResults.join("\n"),
    trace.toolEvents.map((item) => `${item.name} ${item.argsText} ${item.resultText}`).join("\n"),
  ].join("\n");
  return /chalin_project_discovery|Project Discovery Index|Cached Project Discovery Index|discovery[- ]first|índice de descubrimiento/i.test(haystack);
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
