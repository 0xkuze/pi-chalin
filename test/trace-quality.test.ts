import assert from "node:assert/strict";
import { test } from "node:test";
import { buildTraceJudgePrompt, gradePiTrace, parsePiJsonTrace, parseTraceJudgeVerdict } from "../src/trace-quality.ts";
import { MAX_JUDGE_TIMEOUT_MS, resolveJudgeTimeoutMs } from "../evals/trace-quality.eval.ts";

function event(value: unknown): string {
  return JSON.stringify(value);
}

const deepAnswer = [
  "## Coverage Matrix",
  "| Área | Evidencia |",
  "| Runtime | src/runner.ts usa Cached Project Discovery Index y mesh_project_discovery |",
  "| Tools | src/child-tools.ts expone mesh_project_discovery |",
  "| Tests | test/discovery.test.ts valida layouts raros |",
  "## Evidence Table",
  "- src/discovery.ts: índice raw stack-agnostic.",
  "- package.json: scripts test/typecheck.",
  "- agents/scout.md: discovery-first antes de claims.",
  "Conclusión: el proyecto implementa una extensión de orquestación multi-agente con discovery primero, rutas delegadas, controles de evidencia y evals de calidad. ".repeat(8),
].join("\n");

test("parsePiJsonTrace extracts mesh_route args and result material", () => {
  const stdout = [
    event({ type: "tool_execution_start", toolName: "mesh_route", args: { prompt: "use mesh_project_discovery first" } }),
    event({ type: "tool_execution_end", toolName: "mesh_route", result: { content: [{ type: "text", text: deepAnswer }] } }),
  ].join("\n");

  const trace = parsePiJsonTrace(stdout);
  assert.equal(trace.jsonEvents, 2);
  assert.equal(trace.toolEvents.length, 2);
  assert.match(trace.meshRouteArgs[0] ?? "", /mesh_project_discovery/);
  assert.match(trace.meshRouteResults[0] ?? "", /src\/discovery\.ts/);
});

test("gradePiTrace passes evidence-rich mesh trace", () => {
  const stdout = [
    event({ type: "tool_execution_start", toolName: "mesh_route", args: { prompt: "Call mesh_project_discovery before claims" } }),
    event({ type: "tool_execution_end", toolName: "mesh_route", result: { content: [{ type: "text", text: deepAnswer }] } }),
    event({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "Resumen parcial" }] } }),
  ].join("\n");

  const report = gradePiTrace(stdout, { variant: "mesh", finalText: "Resumen parcial" });
  assert.equal(report.pass, true);
  assert.equal(report.effectiveAnswerSource, "mesh_route");
  assert.equal(report.critical.length, 0);
  assert.ok(report.suggestions.some((issue) => issue.id === "partial-parent-final"));
});

test("gradePiTrace fails mesh traces without mesh_route result", () => {
  const stdout = event({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: deepAnswer }] } });

  const report = gradePiTrace(stdout, { variant: "mesh" });
  assert.equal(report.pass, false);
  assert.ok(report.critical.some((issue) => issue.id === "missing-mesh-route-result"));
});

test("gradePiTrace flags repeated mesh_route and parent exploration after mesh", () => {
  const stdout = [
    event({ type: "tool_execution_end", toolName: "mesh_route", result: { content: [{ type: "text", text: deepAnswer }] } }),
    event({ type: "tool_execution_end", toolName: "mesh_route", result: { content: [{ type: "text", text: deepAnswer }] } }),
    event({ type: "tool_execution_start", toolName: "read", args: { path: "src/runner.ts" } }),
  ].join("\n");

  const report = gradePiTrace(stdout, { variant: "mesh" });
  assert.equal(report.pass, false);
  assert.ok(report.warnings.some((issue) => issue.id === "repeated-mesh-route"));
  assert.ok(report.warnings.some((issue) => issue.id === "parent-tools-after-mesh"));
});

test("gradePiTrace treats tools after approval-blocked mesh_route as recovery", () => {
  const blockedMesh = "pi-chalin completed: scout → planner → worker\nstatus: ask\nApproval: ask — Route risk 'medium' meets approval threshold 'medium'.";
  const stdout = [
    event({ type: "tool_execution_end", toolName: "mesh_route", result: { content: [{ type: "text", text: blockedMesh }] } }),
    event({ type: "tool_execution_start", toolName: "read", args: { path: "src/pricing.ts" } }),
    event({ type: "tool_execution_start", toolName: "edit", args: { path: "src/pricing.ts" } }),
    event({ type: "tool_execution_start", toolName: "bash", args: { command: "npm test" } }),
    event({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "Cambios en src/pricing.ts. Verificación: npm test passed." }] } }),
  ].join("\n");

  const report = gradePiTrace(stdout, { variant: "mesh", promptKind: "generic", finalText: "Cambios en src/pricing.ts. Verificación: npm test passed.", minAnswerChars: 20 });

  assert.equal(report.metrics.meshRouteApprovalBlocked, 1);
  assert.equal(report.metrics.exploratoryParentToolsAfterMesh, 0);
  assert.equal(report.effectiveAnswerSource, "provided-final");
  assert.equal(report.warnings.some((issue) => issue.id === "parent-tools-after-mesh"), false);
  assert.ok(report.suggestions.some((issue) => issue.id === "mesh-route-approval-blocked"));
});

test("gradePiTrace treats direct-recommended mesh_route as non-executable recovery", () => {
  const directRecommended = "pi-chalin direct execution recommended\nstatus: direct-recommended\nDirect execution recommended: this is a bounded explicit-file mutation.";
  const final = "Cambios: `src/pricing.ts`. Verificación: `npm test` passed.";
  const stdout = [
    event({ type: "tool_execution_end", toolName: "mesh_route", result: { content: [{ type: "text", text: directRecommended }] } }),
    event({ type: "tool_execution_start", toolName: "read", args: { path: "src/pricing.ts" } }),
    event({ type: "tool_execution_start", toolName: "edit", args: { path: "src/pricing.ts" } }),
    event({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: final }] } }),
  ].join("\n");

  const report = gradePiTrace(stdout, { variant: "mesh", promptKind: "generic", finalText: final });

  assert.equal(report.metrics.meshRouteNonExecutable, 1);
  assert.equal(report.effectiveAnswerSource, "provided-final");
  assert.equal(report.warnings.some((issue) => issue.id === "parent-tools-after-mesh"), false);
  assert.ok(report.suggestions.some((issue) => issue.id === "mesh-route-direct-recommended"));
});

test("gradePiTrace does not treat approval-blocked mesh_route as final answer", () => {
  const blockedMesh = "pi-chalin completed: scout → planner → worker\nstatus: ask\nApproval: ask — Route risk 'medium' meets approval threshold 'medium'.";
  const report = gradePiTrace(event({ type: "tool_execution_end", toolName: "mesh_route", result: { content: [{ type: "text", text: blockedMesh }] } }), { variant: "mesh", promptKind: "generic" });

  assert.equal(report.effectiveAnswerSource, "none");
  assert.ok(report.critical.some((issue) => issue.id === "missing-answer"));
});

test("gradePiTrace accepts concise implementation evidence without rewarding verbosity", () => {
  const concise = "Cambios: `src/pricing.ts`. Verificación: `npm test` ✅ passed.";
  const report = gradePiTrace(event({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: concise }] } }), {
    variant: "simple",
    promptKind: "generic",
    finalText: concise,
  });

  assert.equal(report.pass, true);
  assert.equal(report.warnings.some((issue) => issue.id === "thin-answer"), false);
});

test("gradePiTrace fails unauditable deep answers without file evidence", () => {
  const stdout = event({ type: "tool_execution_end", toolName: "mesh_route", result: { content: [{ type: "text", text: "Este proyecto es importante y tiene buena arquitectura. ".repeat(30) }] } });

  const report = gradePiTrace(stdout, { variant: "mesh" });
  assert.equal(report.pass, false);
  assert.ok(report.critical.some((issue) => issue.id === "missing-file-evidence"));
});

test("parseTraceJudgeVerdict accepts fenced JSON judge output", () => {
  const verdict = parseTraceJudgeVerdict('```json\n{"pass":true,"score":91,"verdict":"sólido","critical":[],"warnings":["calibrar"]}\n```');
  assert.equal(verdict.pass, true);
  assert.equal(verdict.score, 91);
  assert.deepEqual(verdict.warnings, ["calibrar"]);
});

test("buildTraceJudgePrompt includes deterministic report and strict JSON contract", () => {
  const report = gradePiTrace(event({ type: "tool_execution_end", toolName: "mesh_route", result: { content: [{ type: "text", text: deepAnswer }] } }), { variant: "mesh" });
  const prompt = buildTraceJudgePrompt({ report, stdoutSnippet: "{}" });
  assert.match(prompt, /Responde SOLO JSON/);
  assert.match(prompt, /Reporte determinístico/);
});

test("resolveJudgeTimeoutMs caps optional LLM judge", () => {
  assert.equal(resolveJudgeTimeoutMs("999999"), MAX_JUDGE_TIMEOUT_MS);
  assert.equal(resolveJudgeTimeoutMs("1500"), 1500);
});
