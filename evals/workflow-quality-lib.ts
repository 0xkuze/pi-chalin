import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import ts from "typescript";
import { WORKFLOW_ORACLE_DIR, type WorkflowEvalCase } from "./workflow-cases.ts";

export interface WorkflowQualityIssue {
  id: string;
  severity: "critical" | "warning" | "suggestion";
  message: string;
  evidence?: string;
  penalty: number;
}

export interface WorkflowValidationResult {
  status: "pass" | "fail" | "skipped";
  command?: string;
  reason?: string;
  hiddenValidation?: string;
  durationMs: number;
  stdoutSnippet?: string;
  stderrSnippet?: string;
}

export interface WorkflowSemanticMetrics {
  exportChecks: number;
  exportChecksPassed: number;
  scriptChecks: number;
  scriptChecksPassed: number;
  testChecks: number;
  testChecksPassed: number;
  packageBinPassed?: boolean;
  packageBinTargetPassed?: boolean;
}

export interface WorkflowDocumentationPlanMetrics {
  checked: boolean;
  matched: string[];
  missing: string[];
  truncated: boolean;
}

export interface WorkflowQualityReport {
  caseId: string;
  kind: WorkflowEvalCase["kind"];
  suite: WorkflowEvalCase["suite"];
  pass: boolean;
  qualityScore: number;
  efficiencyScore: number;
  score: number;
  matched: string[];
  missing: string[];
  metrics: {
    filesPresent: number;
    expectedFiles: number;
    projectFiles: number;
    durationMs?: number;
    finalTextChars: number;
    scoringRoot: string;
    semantic: WorkflowSemanticMetrics;
    documentationPlan: WorkflowDocumentationPlanMetrics;
    validation: WorkflowValidationResult;
  };
  critical: WorkflowQualityIssue[];
  warnings: WorkflowQualityIssue[];
  suggestions: WorkflowQualityIssue[];
}

const IGNORED_DIRS = new Set([".git", "node_modules", ".pi", ".pi-chalin", ".pi-lens", WORKFLOW_ORACLE_DIR, "dist", "coverage", "target"]);

export function scoreWorkflowWorkspace(cwd: string, evalCase: WorkflowEvalCase, options: { finalText?: string; durationMs?: number; validateTests?: boolean; validationTimeoutMs?: number } = {}): WorkflowQualityReport {
  const scoringCwd = resolveScoringRoot(cwd, evalCase);
  const issues: WorkflowQualityIssue[] = [];
  const matched: string[] = [];
  const missing: string[] = [];
  let earned = 0;
  let possible = 0;

  for (const file of evalCase.expected.requiredFiles) {
    possible += 8;
    if (matchesFile(scoringCwd, file)) {
      earned += 8;
      matched.push(`file:${file}`);
    } else {
      missing.push(`file:${file}`);
      issues.push({ id: "missing-required-file", severity: "critical", message: "Falta un archivo requerido por el caso.", evidence: file, penalty: 25 });
    }
  }

  const shouldValidateTests = options.validateTests ?? evalCase.expected.validation?.runTests;
  const validation = shouldValidateTests
    ? validateWorkflowTests(scoringCwd, evalCase, { timeoutMs: options.validationTimeoutMs })
    : skippedValidation("validation disabled");
  const hiddenValidationPassed = validation.status === "pass" && Boolean(evalCase.expected.hiddenValidation);

  for (const check of evalCase.expected.requiredContent) {
    possible += check.points;
    const content = readPattern(scoringCwd, check.file);
    const failed = check.patterns.filter((pattern) => !new RegExp(pattern, "ims").test(content));
    if (failed.length === 0) {
      earned += check.points;
      matched.push(`content:${check.file}:${check.label}`);
    } else if (hiddenValidationPassed && !isTestEvidenceFile(check.file)) {
      earned += check.points;
      matched.push(`content-validated:${check.file}:${check.label}`);
      issues.push({
        id: "static-content-evidence-missing",
        severity: "warning",
        message: `La validación ejecutable pasó, pero la evidencia estática no reconoció: ${check.label}.`,
        evidence: `${check.file}: ${failed.join(", ")}`,
        penalty: 0,
      });
    } else {
      missing.push(`content:${check.file}:${check.label}`);
      issues.push({ id: "missing-required-content", severity: "critical", message: `No cumple contenido esperado: ${check.label}.`, evidence: `${check.file}: ${failed.join(", ")}`, penalty: Math.min(30, check.points) });
    }
  }


  for (const forbiddenFile of evalCase.expected.forbiddenFiles ?? []) {
    const hits = matchingFiles(scoringCwd, forbiddenFile);
    if (hits.length > 0) {
      issues.push({ id: "forbidden-file", severity: "critical", message: "Se creó o dejó un archivo prohibido para este caso.", evidence: `${forbiddenFile}: ${hits.slice(0, 5).join(", ")}`, penalty: 22 });
    }
  }

  for (const forbidden of evalCase.expected.forbiddenContent ?? []) {
    const content = read(scoringCwd, forbidden.file);
    const hit = forbidden.patterns.find((pattern) => forbiddenPatternMatches(content, pattern));
    if (hit) {
      issues.push({ id: "forbidden-content", severity: "critical", message: `Apareció contenido prohibido: ${forbidden.label}.`, evidence: `${forbidden.file}: ${hit}`, penalty: forbidden.penalty });
    }
  }

  const semantic = evaluateSemanticExpectations(scoringCwd, evalCase, matched, missing, issues);
  const semanticPossible = semantic.exportChecks + semantic.scriptChecks + semantic.testChecks + (evalCase.expected.semantic?.packageBin ? 2 : 0);
  const semanticEarned = semantic.exportChecksPassed + semantic.scriptChecksPassed + semantic.testChecksPassed + (semantic.packageBinPassed ? 1 : 0) + (semantic.packageBinTargetPassed ? 1 : 0);
  if (semanticPossible > 0) {
    possible += 24;
    earned += Math.round((semanticEarned / semanticPossible) * 24);
  }

  const documentationPlan = evaluateDocumentationPlan(scoringCwd, evalCase, issues);

  if (validation.status === "pass") {
    possible += 8;
    earned += 8;
    matched.push("validation:tests-pass");
  } else if (validation.status === "fail") {
    possible += 8;
    missing.push("validation:tests-fail");
    issues.push({ id: "validation-failed", severity: "critical", message: "La validación ejecutable falló.", evidence: validation.stderrSnippet || validation.stdoutSnippet, penalty: 24 });
  } else if (evalCase.expected.validation?.runTests && !evalCase.expected.validation.allowSkip) {
    possible += 8;
    missing.push("validation:tests-skipped");
    issues.push({ id: "validation-skipped", severity: "warning", message: "La validación ejecutable fue omitida.", evidence: validation.reason, penalty: 6 });
  }

  const finalText = options.finalText ?? "";
  for (const pattern of evalCase.expected.finalAnswerPatterns ?? []) {
    possible += 4;
    if (new RegExp(pattern, "ims").test(finalText)) {
      earned += 4;
      matched.push(`final:${pattern}`);
    } else {
      const finalEvidenceIsOutcome = evalCase.kind === "review-only" && evalCase.expected.requiredFiles.length === 0;
      issues.push({
        id: "missing-final-answer-evidence",
        severity: finalEvidenceIsOutcome ? "critical" : "warning",
        message: finalEvidenceIsOutcome
          ? "La tarea es review-only; la respuesta final con evidencia es el outcome principal."
          : "La respuesta final no menciona evidencia/verificación esperada.",
        evidence: pattern,
        penalty: finalEvidenceIsOutcome ? 18 : 4,
      });
    }
  }

  const projectFiles = listFiles(scoringCwd).length;
  if (evalCase.expected.maxFiles && projectFiles > evalCase.expected.maxFiles + 6) {
    issues.push({ id: "scope-too-wide", severity: "warning", message: "El resultado creó o tocó demasiados archivos para el caso.", evidence: `${projectFiles} files`, penalty: 10 });
  }
  if (evalCase.expected.maxDurationMs && options.durationMs && options.durationMs > evalCase.expected.maxDurationMs) {
    issues.push({ id: "duration-budget-exceeded", severity: "warning", message: "La ejecución excedió el presupuesto de eficiencia del caso.", evidence: `${options.durationMs}ms > ${evalCase.expected.maxDurationMs}ms`, penalty: 12 });
  }

  if (hasObviousNoop(scoringCwd)) {
    issues.push({ id: "obvious-noop", severity: "critical", message: "El workspace conserva placeholders/no-op obvios después de la tarea.", penalty: 25 });
  }

  const rawQuality = possible > 0 ? Math.round((earned / possible) * 100) : 0;
  const qualityPenalty = issues.filter((issue) => issue.severity === "critical").reduce((sum, issue) => sum + Math.min(18, issue.penalty), 0);
  const qualityScore = clamp(rawQuality - qualityPenalty, 0, 100);
  const efficiencyScore = scoreEfficiency(evalCase, projectFiles, options.durationMs);
  const warningPenalty = issues.filter((issue) => issue.severity === "warning").reduce((sum, issue) => sum + Math.min(8, issue.penalty), 0);
  const score = clamp(Math.round((qualityScore * 0.78) + (efficiencyScore * 0.22) - warningPenalty), 0, 100);
  const critical = issues.filter((issue) => issue.severity === "critical");
  const warnings = issues.filter((issue) => issue.severity === "warning");
  const suggestions = issues.filter((issue) => issue.severity === "suggestion");
  const onlyNonFunctionalWarnings = warnings.every((issue) => issue.id === "duration-budget-exceeded" || issue.id === "static-content-evidence-missing");
  const pass = critical.length === 0 && (score >= 80 || (qualityScore >= 80 && onlyNonFunctionalWarnings));

  return {
    caseId: evalCase.id,
    kind: evalCase.kind,
    suite: evalCase.suite,
    pass,
    qualityScore,
    efficiencyScore,
    score,
    matched,
    missing,
    metrics: {
      filesPresent: evalCase.expected.requiredFiles.filter((file) => matchesFile(scoringCwd, file)).length,
      expectedFiles: evalCase.expected.requiredFiles.length,
      projectFiles,
      durationMs: options.durationMs,
      finalTextChars: finalText.length,
      scoringRoot: scoringCwd,
      semantic,
      documentationPlan,
      validation,
    },
    critical,
    warnings,
    suggestions,
  };
}

export function validateWorkflowTests(cwd: string, evalCase: WorkflowEvalCase, options: { timeoutMs?: number } = {}): WorkflowValidationResult {
  const started = Date.now();
  const missingTestArtifact = missingExpectedTestArtifact(cwd, evalCase);
  if (missingTestArtifact) {
    return {
      status: "fail",
      reason: `missing expected test artifact before validation: ${missingTestArtifact}`,
      durationMs: Date.now() - started,
    };
  }
  const hiddenValidation = evalCase.expected.hiddenValidation;
  let validationCwd = cwd;
  let tempValidationParent: string | undefined;
  if (hiddenValidation) {
    try {
      tempValidationParent = fs.mkdtempSync(path.join(os.tmpdir(), "pi-chalin-hidden-validation-"));
      validationCwd = path.join(tempValidationParent, "workspace");
      fs.cpSync(cwd, validationCwd, { recursive: true });
      hiddenValidation.setup(validationCwd);
    } catch (error) {
      if (tempValidationParent) fs.rmSync(tempValidationParent, { recursive: true, force: true });
      return {
        status: "fail",
        reason: error instanceof Error ? `hidden validation setup failed: ${error.message}` : "hidden validation setup failed",
        hiddenValidation: hiddenValidation.description,
        durationMs: Date.now() - started,
      };
    }
  }
  try {
    const command = resolveValidationCommand(validationCwd);
    if (!command) return skippedValidation("no dependency-free validation command detected", started);
    const timeoutMs = options.timeoutMs ?? defaultValidationTimeoutMs(command.command);
    const run = spawnSync(command.command, command.args, {
      cwd: validationCwd,
      encoding: "utf-8",
      timeout: timeoutMs,
      env: { ...process.env, CI: "1" },
    });
    const stdout = run.stdout ?? "";
    const stderr = run.stderr ?? "";
    const noTestsExecuted = didValidationRunZeroTests(stdout, stderr);
    return {
      status: run.status === 0 && !noTestsExecuted ? "pass" : "fail",
      command: [command.command, ...command.args].join(" "),
      hiddenValidation: hiddenValidation?.description,
      durationMs: Date.now() - started,
      reason: noTestsExecuted ? "validation command executed zero tests" : run.error?.message,
      stdoutSnippet: snippet(stdout, 800),
      stderrSnippet: snippet(stderr, 800),
    };
  } finally {
    if (tempValidationParent) fs.rmSync(tempValidationParent, { recursive: true, force: true });
  }
}

function forbiddenPatternMatches(content: string, pattern: string): boolean {
  const simpleCallName = simpleForbiddenCallName(pattern);
  if (simpleCallName) return hasStandaloneFunctionCall(content, simpleCallName);
  return new RegExp(pattern, "ims").test(content);
}

function simpleForbiddenCallName(pattern: string): string | undefined {
  if (!pattern.endsWith("\\(")) return undefined;
  const name = pattern.slice(0, -2);
  if (!name) return undefined;
  for (const char of name) {
    if (!isIdentifierChar(char)) return undefined;
  }
  return isIdentifierStart(name[0] ?? "") ? name : undefined;
}

function hasStandaloneFunctionCall(content: string, name: string): boolean {
  let index = content.indexOf(name);
  while (index >= 0) {
    const before = content[index - 1] ?? "";
    const afterName = index + name.length;
    let cursor = afterName;
    while (isHorizontalWhitespace(content[cursor] ?? "")) cursor += 1;
    if (!isIdentifierChar(before) && content[cursor] === "(") return true;
    index = content.indexOf(name, index + name.length);
  }
  return false;
}

function isIdentifierStart(char: string): boolean {
  if (char === "_") return true;
  const code = char.charCodeAt(0);
  return (code >= 65 && code <= 90) || (code >= 97 && code <= 122);
}

function isIdentifierChar(char: string): boolean {
  if (isIdentifierStart(char)) return true;
  const code = char.charCodeAt(0);
  return code >= 48 && code <= 57;
}

function isHorizontalWhitespace(char: string): boolean {
  return char === " " || char === "\t";
}

function defaultValidationTimeoutMs(command: string): number {
  if (command === "cargo") return 30_000;
  if (command === "go" || command === "python3" || command === "bun" || command === "npm") return 20_000;
  return 12_000;
}

function missingExpectedTestArtifact(cwd: string, evalCase: WorkflowEvalCase): string | undefined {
  const patterns = [
    ...evalCase.expected.requiredFiles.filter((file) => /(^|\/)(test|tests|__tests__)\/|\.(test|spec)\./i.test(file)),
    ...(evalCase.expected.semantic?.testFiles ?? []).map((item) => item.file),
  ];
  return patterns.find((pattern) => !matchesFile(cwd, pattern));
}

function didValidationRunZeroTests(stdout: string, stderr: string): boolean {
  const combined = `${stdout}
${stderr}`;
  return /\btests\s+0\b/i.test(combined)
    || /\bRan\s+0\s+tests?\b/i.test(combined)
    || /NO TESTS RAN/i.test(combined);
}

function resolveValidationCommand(cwd: string): { command: string; args: string[] } | undefined {
  const packageJson = readPackageJson(cwd);
  const script = typeof packageJson?.scripts?.test === "string" ? packageJson.scripts.test : undefined;
  if (script) {
    if (/\bbun\s+(?:run\s+)?test\b/i.test(script)) return { command: "bun", args: ["test"] };
    if (/\b(vitest|jest|tsx|ts-node|tape)\b/i.test(script) && !hasNodeModules(cwd)) return undefined;
    if (/python\s+-m\s+unittest|go\s+test/i.test(script)) {
      return { command: script.includes("go test") ? "go" : "python3", args: script.includes("go test") ? ["test", "./..."] : ["-m", "unittest", "discover", "-s", "tests"] };
    }
    if (/node\s+.*--test|npm\s+test/i.test(script) || hasNodeModules(cwd)) {
      return { command: "npm", args: ["test"] };
    }
    return undefined;
  }
  if (fs.existsSync(path.join(cwd, "go.mod"))) return { command: "go", args: ["test", "./..."] };
  if (fs.existsSync(path.join(cwd, "Cargo.toml"))) return { command: "cargo", args: ["test"] };
  if (fs.existsSync(path.join(cwd, "Makefile"))) return { command: "make", args: ["test"] };
  if (fs.existsSync(path.join(cwd, "tests")) && listFiles(cwd).some((file) => file.endsWith(".py"))) {
    return { command: "python3", args: ["-m", "unittest", "discover", "-s", "tests"] };
  }
  return undefined;
}

function skippedValidation(reason: string, started = Date.now()): WorkflowValidationResult {
  return { status: "skipped", reason, durationMs: Date.now() - started };
}

function evaluateSemanticExpectations(cwd: string, evalCase: WorkflowEvalCase, matched: string[], missing: string[], issues: WorkflowQualityIssue[]): WorkflowSemanticMetrics {
  const metrics: WorkflowSemanticMetrics = { exportChecks: 0, exportChecksPassed: 0, scriptChecks: 0, scriptChecksPassed: 0, testChecks: 0, testChecksPassed: 0 };
  const semantic = evalCase.expected.semantic;
  if (!semantic) return metrics;

  for (const expectedExport of semantic.exports ?? []) {
    // names are accepted alternatives for a single export expectation.
    // Counting every alternative as required would unfairly penalize valid implementations.
    metrics.exportChecks += 1;
    const exports = exportedNames(readPattern(cwd, expectedExport.file));
    const passed = expectedExport.names.some((name) => [...exports].some((actual) => exportNameMatches(name, actual)));
    if (passed) {
      metrics.exportChecksPassed += 1;
      matched.push(`semantic:export:${expectedExport.file}`);
    } else {
      missing.push(`semantic:export:${expectedExport.file}`);
      issues.push({ id: "semantic-export-missing", severity: "critical", message: "No se encontró export esperado por AST.", evidence: `${expectedExport.file}: ${expectedExport.names.join("|")}`, penalty: 18 });
    }
  }

  const packageJson = readPackageJson(cwd);
  for (const script of semantic.packageScripts ?? []) {
    metrics.scriptChecks += 1;
    if (packageJson?.scripts && typeof packageJson.scripts[script] === "string") {
      metrics.scriptChecksPassed += 1;
      matched.push(`semantic:package-script:${script}`);
    } else {
      missing.push(`semantic:package-script:${script}`);
      issues.push({ id: "semantic-script-missing", severity: "critical", message: "Falta script requerido en package.json.", evidence: script, penalty: 12 });
    }
  }

  if (semantic.packageBin) {
    const bin = packageJson?.bin;
    const binTarget = resolvePackageBinTarget(bin, semantic.packageBin);
    metrics.packageBinPassed = Boolean(binTarget);
    if (metrics.packageBinPassed) matched.push(`semantic:package-bin:${semantic.packageBin}`);
    else {
      missing.push(`semantic:package-bin:${semantic.packageBin}`);
      issues.push({ id: "semantic-bin-missing", severity: "critical", message: "Falta bin esperado en package.json.", evidence: semantic.packageBin, penalty: 12 });
    }
    if (binTarget) {
      const normalizedTarget = normalizePackageBinTarget(binTarget);
      const targetContent = read(cwd, normalizedTarget);
      metrics.packageBinTargetPassed = Boolean(targetContent.trim()) && /\b(process\.argv|argv)\b/.test(targetContent);
      if (metrics.packageBinTargetPassed) matched.push(`semantic:package-bin-target:${semantic.packageBin}`);
      else {
        missing.push(`semantic:package-bin-target:${semantic.packageBin}`);
        issues.push({
          id: "semantic-bin-target-invalid",
          severity: "critical",
          message: "El bin declarado no apunta a un archivo CLI ejecutable que lea argumentos.",
          evidence: `${semantic.packageBin}: ${binTarget}`,
          penalty: 12,
        });
      }
    }
  }

  for (const testFile of semantic.testFiles ?? []) {
    metrics.testChecks += 1;
    const content = readPattern(cwd, testFile.file);
    const assertionsOk = !testFile.assertions || /\b(expect|assert|strictEqual|deepEqual|toBe|toEqual|toThrow)\b/.test(content);
    const targetOk = !testFile.target || content.includes(testFile.target);
    if (content.trim() && assertionsOk && targetOk) {
      metrics.testChecksPassed += 1;
      matched.push(`semantic:test:${testFile.file}`);
    } else {
      missing.push(`semantic:test:${testFile.file}`);
      issues.push({ id: "semantic-test-missing", severity: "critical", message: "El test esperado no cubre target/assertions según checks semánticos.", evidence: testFile.file, penalty: 16 });
    }
  }

  return metrics;
}

function evaluateDocumentationPlan(cwd: string, evalCase: WorkflowEvalCase, issues: WorkflowQualityIssue[]): WorkflowDocumentationPlanMetrics {
  const docsFiles = evalCase.expected.requiredFiles.filter((file) => isDocumentationEvidencePath(file));
  if (evalCase.kind !== "review-only" || docsFiles.length === 0) {
    return { checked: false, matched: [], missing: [], truncated: false };
  }

  const content = docsFiles.map((file) => readPattern(cwd, file)).join("\n\n");
  if (!content.trim()) return { checked: true, matched: [], missing: ["content"], truncated: false };

  const sections = documentationPlanSections(evalCase);
  const matched = sections.filter((section) => section.patterns.every((pattern) => pattern.test(content))).map((section) => section.id);
  const missing = sections.map((section) => section.id).filter((id) => !matched.includes(id));
  const truncated = looksLikeTruncatedDocumentation(content);

  if (missing.length > 0) {
    issues.push({
      id: "documentation-plan-incomplete",
      severity: "warning",
      message: "El documento de plan/review no cubre todas las secciones esperadas para una decisión productiva.",
      evidence: missing.join(", "),
      penalty: Math.min(18, missing.length * 4),
    });
  }
  if (truncated) {
    issues.push({
      id: "documentation-plan-truncated",
      severity: "warning",
      message: "El documento parece terminar en una sección/lista incompleta.",
      evidence: snippet(content.trim().slice(-240), 240),
      penalty: 12,
    });
  }

  return { checked: true, matched, missing, truncated };
}

function documentationPlanSections(evalCase: WorkflowEvalCase): Array<{ id: string; patterns: RegExp[] }> {
  const promptAndChecks = [
    evalCase.prompt,
    ...evalCase.expected.requiredContent.map((check) => `${check.label} ${check.patterns.join(" ")}`),
  ].join("\n");
  const sections = [
    { id: "current-state", patterns: [/estado actual|current|actual|hoy|as-is|existing|root cause|causa ra[ií]z/i, /src\/|crates\/|archivo|file/i] },
    { id: "incremental-steps", patterns: [/pasos?|steps?|increment|plan|fase/i] },
    { id: "validation", patterns: [/validaci(?:ó|o)n|tests?|pruebas?|verificaci(?:ó|o)n/i] },
  ];
  if (/arquitectura|architecture|boundary|frontera|cross-language|runtime/i.test(promptAndChecks)) {
    sections.push({ id: "target-architecture", patterns: [/arquitectura|dise(?:ñ|n)o|target|objetivo|flujo|boundary|frontera/i] });
  }
  if (/riesgos?|risks?|compatibilidad|compat/i.test(promptAndChecks)) {
    sections.push({ id: "risks", patterns: [/riesgos?|risks?|compatibilidad|compat/i] });
  }
  if (/rollback|revert|reversi(?:ó|o)n|backout/i.test(promptAndChecks)) {
    sections.push({ id: "rollback", patterns: [/rollback|revert|reversi(?:ó|o)n|backout/i] });
  }
  return sections;
}

function looksLikeTruncatedDocumentation(content: string): boolean {
  const trimmed = content.trim();
  if (!trimmed) return false;
  const lastLine = trimmed.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).at(-1) ?? "";
  return /(?:^#+\s+\S.*|:\s*|-|\d+[.)])$/.test(lastLine)
    || /\b(?:TODO|TBD|WIP)\b/.test(trimmed)
    || /(?:^|\n)\s*(?:[-*]\s*)?pendiente\s*:/i.test(trimmed)
    || /(?:rollback|validaci(?:ó|o)n|compatibilidad|riesgos?)\s*:\s*$/i.test(lastLine);
}

function exportedNames(content: string): Set<string> {
  const names = new Set<string>();
  if (!content.trim()) return names;
  const source = ts.createSourceFile("module.ts", content, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const visit = (node: ts.Node) => {
    const modifiers = ts.canHaveModifiers(node) ? ts.getModifiers(node) : undefined;
    const exported = modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword);
    if (exported && (ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node) || ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node)) && node.name) names.add(node.name.text);
    if (exported && ts.isVariableStatement(node)) {
      for (const declaration of node.declarationList.declarations) if (ts.isIdentifier(declaration.name)) names.add(declaration.name.text);
    }
    if (ts.isExportDeclaration(node) && node.exportClause && ts.isNamedExports(node.exportClause)) {
      for (const element of node.exportClause.elements) names.add(element.name.text);
    }
    if (ts.isExpressionStatement(node) && ts.isBinaryExpression(node.expression) && node.expression.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
      collectCommonJsExportNames(node.expression, names);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return names;
}

function collectCommonJsExportNames(expression: ts.BinaryExpression, names: Set<string>): void {
  const left = expression.left;
  const right = expression.right;
  if (isModuleExports(left) && ts.isObjectLiteralExpression(right)) {
    for (const property of right.properties) {
      if (ts.isShorthandPropertyAssignment(property)) names.add(property.name.text);
      if (ts.isPropertyAssignment(property) && ts.isIdentifier(property.name)) names.add(property.name.text);
      if (ts.isPropertyAssignment(property) && ts.isStringLiteral(property.name)) names.add(property.name.text);
    }
    return;
  }
  const assignedName = commonJsAssignedName(left);
  if (assignedName) names.add(assignedName);
}

function isModuleExports(node: ts.Node): boolean {
  return ts.isPropertyAccessExpression(node) && node.expression.getText() === "module" && node.name.text === "exports";
}

function commonJsAssignedName(node: ts.Node): string | undefined {
  if (!ts.isPropertyAccessExpression(node)) return undefined;
  if (node.expression.getText() === "exports") return node.name.text;
  if (ts.isPropertyAccessExpression(node.expression) && node.expression.expression.getText() === "module" && node.expression.name.text === "exports") return node.name.text;
  return undefined;
}

function exportNameMatches(expected: string, actual: string): boolean {
  if (actual === expected) return true;
  const normalizedExpected = expected.toLowerCase();
  const normalizedActual = actual.toLowerCase();
  return normalizedExpected.length >= 4 && normalizedActual.startsWith(normalizedExpected);
}

function resolvePackageBinTarget(bin: unknown, commandName: string): string | undefined {
  if (typeof bin === "string" && bin.trim()) return bin;
  if (bin && typeof bin === "object") {
    const target = (bin as Record<string, unknown>)[commandName];
    if (typeof target === "string" && target.trim()) return target;
  }
  return undefined;
}

function normalizePackageBinTarget(target: string): string {
  return target.replace(/^[.][/\\]/, "");
}

function readPackageJson(cwd: string): { scripts?: Record<string, unknown>; bin?: unknown } | undefined {
  try {
    return JSON.parse(read(cwd, "package.json")) as { scripts?: Record<string, unknown>; bin?: unknown };
  } catch {
    return undefined;
  }
}

function hasNodeModules(cwd: string): boolean {
  return fs.existsSync(path.join(cwd, "node_modules"));
}

function scoreEfficiency(evalCase: WorkflowEvalCase, projectFiles: number, durationMs: number | undefined): number {
  let score = 100;
  if (evalCase.expected.maxFiles && projectFiles > evalCase.expected.maxFiles) score -= Math.min(35, (projectFiles - evalCase.expected.maxFiles) * 4);
  if (evalCase.expected.maxDurationMs && durationMs) {
    const ratio = durationMs / evalCase.expected.maxDurationMs;
    if (ratio > 1) score -= Math.min(35, Math.round((ratio - 1) * 40));
  }
  return clamp(score, 0, 100);
}

function hasObviousNoop(cwd: string): boolean {
  return listFiles(cwd).filter((file) => /^(src|lib|app)\//.test(file)).some((file) => {
    const content = read(cwd, file);
    return /TODO:\s*(implement|scaffold)|throw new Error\(['"]not implemented|return tasks;\s*$|allowed:\s*true,\s*remaining:\s*1/s.test(content);
  });
}

function resolveScoringRoot(cwd: string, evalCase: WorkflowEvalCase): string {
  const rootMatches = evalCase.expected.requiredFiles.filter((file) => matchesFile(cwd, file)).length;
  let best = { cwd, matches: rootMatches };
  for (const entry of safeReadDir(cwd)) {
    if (!entry.isDirectory() || IGNORED_DIRS.has(entry.name)) continue;
    const candidate = path.join(cwd, entry.name);
    const matches = evalCase.expected.requiredFiles.filter((file) => matchesFile(candidate, file)).length;
    if (matches > best.matches) best = { cwd: candidate, matches };
  }
  return best.cwd;
}

function exists(cwd: string, relativePath: string): boolean {
  return Boolean(resolvePath(cwd, relativePath));
}

function isTestEvidenceFile(file: string): boolean {
  const normalized = file.replace(/\\/g, "/").toLowerCase();
  return normalized.includes("/test/") || normalized.includes("/tests/") || /(^|[._-])test\.[^.]+$/.test(path.basename(normalized));
}

function isDocumentationEvidencePath(relativePath: string): boolean {
  return relativePath.startsWith("docs/") || /\.(?:md|mdx|rst|adoc|txt)$/i.test(relativePath);
}

function existsAt(cwd: string, relativePath: string): boolean {
  return fs.existsSync(path.join(cwd, relativePath)) || alternatePaths(relativePath).some((item) => fs.existsSync(path.join(cwd, item)));
}

function read(cwd: string, relativePath: string): string {
  const resolved = resolvePath(cwd, relativePath);
  try {
    return resolved ? fs.readFileSync(resolved, "utf-8") : "";
  } catch {
    return "";
  }
}

function readPattern(cwd: string, relativePathOrPattern: string): string {
  const matches = matchingFiles(cwd, relativePathOrPattern);
  if (matches.length === 0) return read(cwd, relativePathOrPattern);
  return matches.map((file) => read(cwd, file)).join("\n");
}

function matchesFile(cwd: string, relativePathOrPattern: string): boolean {
  return matchingFiles(cwd, relativePathOrPattern).length > 0;
}

function matchingFiles(cwd: string, relativePathOrPattern: string): string[] {
  const candidates = [relativePathOrPattern, ...alternatePaths(relativePathOrPattern)];
  if (!relativePathOrPattern.includes("*")) return candidates.find((candidate) => exists(cwd, candidate)) ? [relativePathOrPattern] : [];
  const patterns = candidates.map((candidate) => new RegExp(`^${candidate.split("*").map((part) => RegExp.escape(part)).join(".*")}$`));
  return listFiles(cwd).filter((file) => patterns.some((pattern) => pattern.test(file))).sort();
}

function resolvePath(cwd: string, relativePath: string): string | undefined {
  const direct = path.join(cwd, relativePath);
  if (fs.existsSync(direct)) return direct;
  for (const alternate of alternatePaths(relativePath)) {
    const full = path.join(cwd, alternate);
    if (fs.existsSync(full)) return full;
  }
  return undefined;
}

function alternatePaths(relativePath: string): string[] {
  if (relativePath.startsWith("test/")) return [relativePath.replace(/^test\//, "tests/")];
  if (relativePath.startsWith("tests/")) return [relativePath.replace(/^tests\//, "test/")];
  return [];
}

function safeReadDir(cwd: string): fs.Dirent[] {
  try {
    return fs.readdirSync(cwd, { withFileTypes: true });
  } catch {
    return [];
  }
}

function listFiles(cwd: string): string[] {
  const results: string[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (IGNORED_DIRS.has(entry.name)) continue;
      const full = path.join(dir, entry.name);
      const rel = path.relative(cwd, full);
      if (entry.isDirectory()) walk(full);
      else results.push(rel);
    }
  };
  if (fs.existsSync(cwd)) walk(cwd);
  return results.sort();
}

function snippet(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}
