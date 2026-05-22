import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import ts from "typescript";
import type { WorkflowEvalCase } from "../evals/workflow-cases.ts";

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
    validation: WorkflowValidationResult;
  };
  critical: WorkflowQualityIssue[];
  warnings: WorkflowQualityIssue[];
  suggestions: WorkflowQualityIssue[];
}

const IGNORED_DIRS = new Set([".git", "node_modules", ".pi-mesh", "dist", "coverage"]);

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

  for (const check of evalCase.expected.requiredContent) {
    possible += check.points;
    const content = readPattern(scoringCwd, check.file);
    const failed = check.patterns.filter((pattern) => !new RegExp(pattern, "ims").test(content));
    if (failed.length === 0) {
      earned += check.points;
      matched.push(`content:${check.file}:${check.label}`);
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
    const hit = forbidden.patterns.find((pattern) => new RegExp(pattern, "ims").test(content));
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

  const validation = options.validateTests || evalCase.expected.validation?.runTests
    ? validateWorkflowTests(scoringCwd, evalCase, { timeoutMs: options.validationTimeoutMs ?? 8_000 })
    : skippedValidation("validation disabled");
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
      const finalEvidenceIsOutcome = evalCase.kind === "review-only";
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

  return {
    caseId: evalCase.id,
    kind: evalCase.kind,
    suite: evalCase.suite,
    pass: critical.length === 0 && score >= 80,
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
  const command = resolveValidationCommand(cwd);
  if (!command) return skippedValidation("no dependency-free validation command detected", started);
  const run = spawnSync(command.command, command.args, {
    cwd,
    encoding: "utf-8",
    timeout: options.timeoutMs ?? 8_000,
    env: { ...process.env, CI: "1" },
  });
  const stdout = run.stdout ?? "";
  const stderr = run.stderr ?? "";
  const noTestsExecuted = didValidationRunZeroTests(stdout, stderr);
  return {
    status: run.status === 0 && !noTestsExecuted ? "pass" : "fail",
    command: [command.command, ...command.args].join(" "),
    durationMs: Date.now() - started,
    reason: noTestsExecuted ? "validation command executed zero tests" : run.error?.message,
    stdoutSnippet: snippet(stdout, 800),
    stderrSnippet: snippet(stderr, 800),
  };
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
    if (/\b(vitest|jest|tsx|ts-node|tape)\b/i.test(script) && !hasNodeModules(cwd)) return undefined;
    if (/node\s+.*--test|python\s+-m\s+unittest|go\s+test|npm\s+test/i.test(script) || hasNodeModules(cwd)) {
      const args = /node\s+.*--test|python\s+-m\s+unittest|go\s+test/i.test(script) ? ["test"] : ["test", "--", "--runInBand"];
      return { command: "npm", args };
    }
    return undefined;
  }
  if (fs.existsSync(path.join(cwd, "go.mod"))) return { command: "go", args: ["test", "./..."] };
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
  if (!relativePathOrPattern.includes("*")) return exists(cwd, relativePathOrPattern) ? [relativePathOrPattern] : [];
  const pattern = new RegExp(`^${relativePathOrPattern.split("*").map(escapeRegExp).join(".*")}$`);
  return listFiles(cwd).filter((file) => pattern.test(file)).sort();
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
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
