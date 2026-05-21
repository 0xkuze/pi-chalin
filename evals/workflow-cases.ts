import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export type WorkflowCaseKind = "refactor" | "test-writing" | "small-feature" | "large-feature" | "scaffold" | "greenfield" | "bugfix" | "review-only";
export type WorkflowCaseSuite = "calibration" | "holdout";

export interface RequiredContentCheck {
  file: string;
  patterns: string[];
  points: number;
  label: string;
}

export interface ForbiddenContentCheck {
  file: string;
  patterns: string[];
  penalty: number;
  label: string;
}

export interface WorkflowEvalCase {
  id: string;
  kind: WorkflowCaseKind;
  suite: WorkflowCaseSuite;
  title: string;
  prompt: string;
  expected: {
    requiredFiles: string[];
    requiredContent: RequiredContentCheck[];
    forbiddenContent?: ForbiddenContentCheck[];
    forbiddenFiles?: string[];
    finalAnswerPatterns?: string[];
    maxFiles?: number;
    maxDurationMs?: number;
    semantic?: WorkflowSemanticExpectation;
    validation?: WorkflowValidationExpectation;
  };
  setup(cwd: string): void;
}

export interface WorkflowSemanticExpectation {
  exports?: Array<{ file: string; names: string[] }>;
  packageScripts?: string[];
  packageBin?: string;
  testFiles?: Array<{ file: string; target?: string; assertions?: boolean }>;
}

export interface WorkflowValidationExpectation {
  runTests?: boolean;
  allowSkip?: boolean;
}

export interface WorkflowFixture {
  case: WorkflowEvalCase;
  cwd: string;
  prompt: string;
}

export function listWorkflowEvalCases(options: { includeHoldout?: boolean } = {}): WorkflowEvalCase[] {
  const calibration = [
    refactorPricingCase(),
    addUnitTestCase(),
    smallFeatureCase(),
    largeFeatureCase(),
    scaffoldCase(),
    greenfieldCase(),
  ];
  return options.includeHoldout ? [...calibration, ...listWorkflowHoldoutCases()] : calibration;
}

export function listWorkflowHoldoutCases(): WorkflowEvalCase[] {
  return [
    holdoutBugfixDateParserCase(),
    holdoutSmallFeatureSortTasksCase(),
    holdoutScaffoldConfigLoaderCase(),
    holdoutReviewOnlySecurityCase(),
    holdoutPythonSlugifyCase(),
    holdoutGoTtlCacheCase(),
    holdoutMonorepoPackageCase(),
    holdoutLegacyCjsCase(),
    holdoutDocsRunbookCase(),
    holdoutBrokenTestsTriageCase(),
  ];
}

export function getWorkflowEvalCase(id: string): WorkflowEvalCase {
  const found = listWorkflowEvalCases({ includeHoldout: true }).find((item) => item.id === id);
  if (!found) throw new Error(`Unsupported workflow eval case: ${id}`);
  return found;
}

export function createWorkflowFixture(id: string): WorkflowFixture {
  const evalCase = getWorkflowEvalCase(id);
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), `pi-mesh-workflow-${id}-`));
  evalCase.setup(cwd);
  return { case: evalCase, cwd, prompt: evalCase.prompt };
}

function refactorPricingCase(): WorkflowEvalCase {
  return {
    id: "refactor-pricing",
    kind: "refactor",
    suite: "calibration",
    title: "Refactor pricing calculation without behavior drift",
    prompt: "Refactoriza src/pricing.ts para extraer funciones puras pequeñas, mantener el API calculateInvoice igual, y añade/actualiza tests relevantes. No cambies comportamiento.",
    expected: {
      requiredFiles: ["src/pricing.ts", "test/pricing.test.ts", "package.json"],
      requiredContent: [
        check("src/pricing.ts", "exports calculateInvoice", ["export function calculateInvoice", "subtotal", "tax", "total"], 22),
        check("src/pricing.ts", "extracts helper functions", ["function (?!calculateInvoice)\\w+|const \\w*(Subtotal|Tax|Discount|Taxable)\\w*\\s*(?::[^=]+)?=\\s*\\([^)]*\\)\\s*(?::[^=]+)?=>", "subtotal", "taxable|tax"], 18),
        check("test/pricing.test.ts", "keeps behavior tests", ["calculateInvoice", "discount", "tax", "total", "expect|assert"], 20),
        check("package.json", "keeps test script", ["vitest run|node\\s+.*--test|npm test"], 8),
      ],
      forbiddenContent: [
        forbid("src/pricing.ts", "does not delete invoice math", ["throw new Error\\(['\"]not implemented", "TODO: implement"], 25),
      ],
      finalAnswerPatterns: ["test|prueba|valid", "src/pricing.ts"],
      maxFiles: 5,
      maxDurationMs: 60_000,
      semantic: { exports: [{ file: "src/pricing.ts", names: ["calculateInvoice"] }], packageScripts: ["test"], testFiles: [{ file: "test/pricing.test.ts", target: "calculateInvoice", assertions: true }] },
      validation: { runTests: true, allowSkip: true },
    },
    setup(cwd) {
      writeBaseNodeProject(cwd);
      write(cwd, "src/pricing.ts", `export interface LineItem {\n  sku: string;\n  quantity: number;\n  unitPriceCents: number;\n}\n\nexport interface InvoiceInput {\n  items: LineItem[];\n  discountPercent?: number;\n  taxRatePercent: number;\n}\n\nexport function calculateInvoice(input: InvoiceInput) {\n  let subtotal = 0;\n  for (const item of input.items) {\n    subtotal += item.quantity * item.unitPriceCents;\n  }\n  const discount = Math.round(subtotal * ((input.discountPercent ?? 0) / 100));\n  const taxable = subtotal - discount;\n  const tax = Math.round(taxable * (input.taxRatePercent / 100));\n  const total = taxable + tax;\n  return { subtotal, discount, tax, total };\n}\n`);
      write(cwd, "test/pricing.test.ts", `import { describe, it } from "node:test";\nimport assert from "node:assert/strict";\nimport { calculateInvoice } from "../src/pricing.ts";\n\ndescribe("calculateInvoice", () => {\n  it("calculates totals with discount and tax", () => {\n    assert.deepEqual(calculateInvoice({\n      items: [{ sku: "book", quantity: 2, unitPriceCents: 1000 }],\n      discountPercent: 10,\n      taxRatePercent: 8,\n    }), { subtotal: 2000, discount: 200, tax: 144, total: 1944 });\n  });\n});\n`);
    },
  };
}

function addUnitTestCase(): WorkflowEvalCase {
  return {
    id: "add-unit-test-edge-case",
    kind: "test-writing",
    suite: "calibration",
    title: "Add missing edge-case unit test before touching implementation",
    prompt: "Añade un test unitario que cubra división por cero en src/safeDivide.ts. Si el comportamiento ya existe, no refactorices de más; solo deja el caso cubierto y explica la verificación.",
    expected: {
      requiredFiles: ["src/safeDivide.ts", "test/safeDivide.test.ts", "package.json"],
      requiredContent: [
        check("src/safeDivide.ts", "safeDivide remains implemented", ["export function safeDivide", "Number.isFinite|denominator === 0", "return 0"], 24),
        check("test/safeDivide.test.ts", "zero division test exists", ["safeDivide", "0", "toBe\\(0\\)|toEqual\\(0\\)|equal\\([^\\n]+,\\s*0\\)"], 28),
        check("test/safeDivide.test.ts", "normal division still covered", ["10", "2", "5"], 10),
      ],
      forbiddenContent: [forbid("src/safeDivide.ts", "does not rewrite into throwing behavior", ["throw\\s+new\\s+\\w*Error", "Infinity"], 25)],
      finalAnswerPatterns: ["test/safeDivide.test.ts", "divisi[oó]n|division"],
      maxFiles: 3,
      maxDurationMs: 45_000,
      semantic: { exports: [{ file: "src/safeDivide.ts", names: ["safeDivide"] }], packageScripts: ["test"], testFiles: [{ file: "test/safeDivide.test.ts", target: "safeDivide", assertions: true }] },
      validation: { runTests: true, allowSkip: true },
    },
    setup(cwd) {
      writeBaseNodeProject(cwd);
      write(cwd, "src/safeDivide.ts", `export function safeDivide(numerator: number, denominator: number): number {\n  if (denominator === 0 || !Number.isFinite(denominator)) return 0;\n  return numerator / denominator;\n}\n`);
      write(cwd, "test/safeDivide.test.ts", `import { describe, it } from "node:test";\nimport assert from "node:assert/strict";\nimport { safeDivide } from "../src/safeDivide.ts";\n\ndescribe("safeDivide", () => {\n  it("divides normal numbers", () => {\n    assert.equal(safeDivide(10, 2), 5);\n  });\n});\n`);
    },
  };
}

function smallFeatureCase(): WorkflowEvalCase {
  return {
    id: "small-feature-search-filter",
    kind: "small-feature",
    suite: "calibration",
    title: "Implement a small search filter feature",
    prompt: "Implementa un filtro de búsqueda en src/filterTasks.ts: debe filtrar por texto en title o description, ignorar mayúsculas/minúsculas y conservar el orden original. Añade tests.",
    expected: {
      requiredFiles: ["src/filterTasks.ts", "test/filterTasks.test.ts", "package.json"],
      requiredContent: [
        check("src/filterTasks.ts", "exports filterTasks", ["export function filterTasks", "title", "description", "toLowerCase", "filter"], 30),
        check("test/filterTasks.test.ts", "case-insensitive title/description tests", ["filterTasks", "description|desc", "case|may[uú]sculas|lower|toLowerCase|ALPHA|alpha", "expect|assert"], 28),
      ],
      forbiddenContent: [forbid("src/filterTasks.ts", "does not hardcode fixture terms", ["alpha beta only", "hardcoded"], 20)],
      finalAnswerPatterns: ["src/filterTasks.ts", "test/filterTasks.test.ts"],
      maxFiles: 4,
      maxDurationMs: 45_000,
      semantic: { exports: [{ file: "src/filterTasks.ts", names: ["filterTasks"] }], packageScripts: ["test"], testFiles: [{ file: "test/filterTasks.test.ts", target: "filterTasks", assertions: true }] },
      validation: { runTests: true, allowSkip: true },
    },
    setup(cwd) {
      writeBaseNodeProject(cwd);
      write(cwd, "src/filterTasks.ts", `export interface Task {\n  id: string;\n  title: string;\n  description?: string;\n}\n\nexport function filterTasks(tasks: Task[], query: string): Task[] {\n  return tasks;\n}\n`);
      write(cwd, "test/filterTasks.test.ts", `import { describe, it } from "node:test";\nimport assert from "node:assert/strict";\nimport { filterTasks } from "../src/filterTasks.ts";\n\ndescribe("filterTasks", () => {\n  it("returns all tasks for empty query", () => {\n    assert.equal(filterTasks([{ id: "1", title: "Pay rent" }], "").length, 1);\n  });\n});\n`);
    },
  };
}

function largeFeatureCase(): WorkflowEvalCase {
  return {
    id: "large-feature-rate-limit",
    kind: "large-feature",
    suite: "calibration",
    title: "Implement bounded rate limiter feature across module and tests",
    prompt: "Implementa un rate limiter in-memory en src/rateLimit.ts con ventanas por key, límite configurable, reset por tiempo y tests. Mantén el scope pequeño: no agregues dependencias externas.",
    expected: {
      requiredFiles: ["src/rateLimit.ts", "test/rateLimit.test.ts", "package.json"],
      requiredContent: [
        check("src/rateLimit.ts", "exports rate limiter factory", ["export function createRateLimiter|export class RateLimiter", "limit", "windowMs", "Map"], 30),
        check("src/rateLimit.ts", "tracks key windows", ["key", "resetAt|expiresAt|windowStart|\\bstart\\b|hits|bucket|window", "allowed|remaining|retryAfter"], 20),
        check("test/rateLimit.test.ts", "covers allow block and reset", ["createRateLimiter|RateLimiter", "allowed", "false|blocked|deny|limit", "reset|advanceTimers|Date\\.now|mock|tick|now\\s*\\+|current\\s*=", "expect|assert"], 25),
      ],
      forbiddenContent: [forbid("src/rateLimit.ts", "no external dependency shortcut", ["from ['\"]rate-limiter", "express-rate-limit", "bottleneck"], 25)],
      finalAnswerPatterns: ["src/rateLimit.ts", "test/rateLimit.test.ts", "sin dependencias|no external|dependenc"],
      maxFiles: 5,
      maxDurationMs: 60_000,
      semantic: { exports: [{ file: "src/rateLimit.ts", names: ["createRateLimiter", "RateLimiter"] }], packageScripts: ["test"], testFiles: [{ file: "test/rateLimit.test.ts", target: "createRateLimiter", assertions: true }] },
      validation: { runTests: true, allowSkip: true },
    },
    setup(cwd) {
      writeBaseNodeProject(cwd);
      write(cwd, "src/rateLimit.ts", `export interface RateLimitResult {\n  allowed: boolean;\n  remaining: number;\n  retryAfterMs: number;\n}\n\nexport function createRateLimiter(_options: { limit: number; windowMs: number }) {\n  return {\n    check(_key: string): RateLimitResult {\n      return { allowed: true, remaining: 1, retryAfterMs: 0 };\n    },\n  };\n}\n`);
      write(cwd, "test/rateLimit.test.ts", `import { describe, it } from "node:test";\nimport assert from "node:assert/strict";\nimport { createRateLimiter } from "../src/rateLimit.ts";\n\ndescribe("createRateLimiter", () => {\n  it("allows initial request", () => {\n    const limiter = createRateLimiter({ limit: 2, windowMs: 1000 });\n    assert.equal(limiter.check("user-1").allowed, true);\n  });\n});\n`);
    },
  };
}

function scaffoldCase(): WorkflowEvalCase {
  return {
    id: "scaffold-cli-tool",
    kind: "scaffold",
    suite: "calibration",
    title: "Scaffold a small CLI tool in a partially empty repo",
    prompt: "Scaffoldea un CLI TypeScript mínimo llamado note-pack: package.json, src/cli.ts, README con uso, y test básico. El comando debe aceptar un argumento de texto y devolverlo normalizado a minúsculas.",
    expected: {
      requiredFiles: ["package.json", "src/cli.ts", "README.md", "test/*.test.ts"],
      requiredContent: [
        check("package.json", "declares CLI package and scripts", ["note-pack", "bin", "test", "type"], 20),
        check("src/*.ts", "implements lowercase normalization", ["toLowerCase", "export"], 25),
        check("test/*.test.ts", "tests normalization", ["normalize|note-pack|cli", "toLowerCase|lowercase|min[uú]scula|may[uú]scula", "expect|assert|test\\("], 20),
        check("README.md", "documents usage", ["note-pack", "Usage|Uso", "node|npm|npx|note-pack\\s+<"], 10),
      ],
      finalAnswerPatterns: ["package.json", "src/cli.ts", "README.md"],
      maxFiles: 6,
      maxDurationMs: 60_000,
      semantic: { exports: [{ file: "src/*.ts", names: ["normalize", "main"] }], packageScripts: ["test"], packageBin: "note-pack", testFiles: [{ file: "test/*.test.ts", target: "normal", assertions: true }] },
      validation: { runTests: true, allowSkip: true },
    },
    setup(cwd) {
      write(cwd, "README.md", `# note-pack\n\nTODO: scaffold CLI.\n`);
    },
  };
}

function greenfieldCase(): WorkflowEvalCase {
  return {
    id: "greenfield-token-library",
    kind: "greenfield",
    suite: "calibration",
    title: "Create a small project from zero with tests and docs",
    prompt: "Crea desde cero una librería TypeScript pequeña para generar tokens legibles: package.json, src/index.ts, tests y README. API esperada: createToken(prefix, id) devuelve prefix-id en minúsculas y valida inputs vacíos.",
    expected: {
      requiredFiles: ["package.json", "src/index.ts", "test/*.test.ts", "README.md"],
      requiredContent: [
        check("package.json", "project metadata and test script", ["scripts", "test", "type|main|exports"], 18),
        check("src/index.ts", "exports createToken with validation", ["export function createToken", "prefix", "id", "toLowerCase", "throw\\s+new\\s+\\w*Error"], 32),
        check("test/*.test.ts", "tests token generation and invalid input", ["createToken", "prefix|token|id", "throw|toThrow", "expect|assert"], 25),
        check("README.md", "documents API", ["createToken", "prefix", "id"], 10),
      ],
      finalAnswerPatterns: ["npm test|test", "src/index.ts", "README.md"],
      maxFiles: 6,
      maxDurationMs: 60_000,
      semantic: { exports: [{ file: "src/index.ts", names: ["createToken"] }], packageScripts: ["test"], testFiles: [{ file: "test/*.test.ts", target: "createToken", assertions: true }] },
      validation: { runTests: true, allowSkip: true },
    },
    setup(_cwd) {
      // Intentionally empty greenfield repo.
    },
  };
}


function holdoutBugfixDateParserCase(): WorkflowEvalCase {
  return {
    id: "holdout-bugfix-date-parser",
    kind: "bugfix",
    suite: "holdout",
    title: "Fix ISO date parsing bug without widening scope",
    prompt: "Corrige el bug en src/parseDate.ts: debe aceptar fechas ISO YYYY-MM-DD válidas, rechazar fechas imposibles como 2024-02-31 y añadir tests. No agregues dependencias.",
    expected: {
      requiredFiles: ["src/parseDate.ts", "test/parseDate.test.ts", "package.json"],
      requiredContent: [
        check("src/parseDate.ts", "exports parseIsoDate", ["export function parseIsoDate", "Date", "YYYY|iso|match|RegExp", "null|throw"], 28),
        check("test/parseDate.test.ts", "tests valid and impossible dates", ["parseIsoDate", "\\d{4}-\\d{2}-\\d{2}", "2024-02-31", "expect|assert"], 28),
      ],
      forbiddenContent: [forbid("src/parseDate.ts", "no dependency shortcut", ["date-fns", "luxon", "moment"], 20)],
      finalAnswerPatterns: ["src/parseDate.ts", "test/parseDate.test.ts"],
      maxFiles: 4,
      maxDurationMs: 45_000,
      semantic: { exports: [{ file: "src/parseDate.ts", names: ["parseIsoDate"] }], packageScripts: ["test"], testFiles: [{ file: "test/parseDate.test.ts", target: "parseIsoDate", assertions: true }] },
      validation: { runTests: true, allowSkip: true },
    },
    setup(cwd) {
      writeBaseNodeProject(cwd);
      write(cwd, "src/parseDate.ts", `export function parseIsoDate(value: string): Date | null {\n  const parsed = new Date(value);\n  return Number.isNaN(parsed.getTime()) ? null : parsed;\n}\n`);
      write(cwd, "test/parseDate.test.ts", `import { describe, it } from "node:test";\nimport assert from "node:assert/strict";\nimport { parseIsoDate } from "../src/parseDate.ts";\n\ndescribe("parseIsoDate", () => {\n  it("accepts a valid ISO date", () => {\n    assert.notEqual(parseIsoDate("2024-02-29"), null);\n  });\n});\n`);
    },
  };
}

function holdoutReviewOnlySecurityCase(): WorkflowEvalCase {
  return {
    id: "holdout-review-auth-boundary",
    kind: "review-only",
    suite: "holdout",
    title: "Review auth boundary without mutating files",
    prompt: "Revisa este mini proyecto y dime si hay riesgo de seguridad en el boundary de auth. No modifiques archivos; entrega evidencia con paths concretos.",
    expected: {
      requiredFiles: ["src/auth.ts", "src/server.ts", "package.json"],
      requiredContent: [
        check("src/auth.ts", "auth module remains present", ["export function requireUser", "x-user-id"], 18),
        check("src/server.ts", "server route remains present", ["requireUser", "/admin|admin"], 18),
      ],
      forbiddenFiles: ["test/*", "tests/*", "docs/*"],
      finalAnswerPatterns: ["src/auth.ts", "src/server.ts", "risk|riesgo|security|seguridad"],
      maxFiles: 4,
      maxDurationMs: 45_000,
      semantic: { exports: [{ file: "src/auth.ts", names: ["requireUser"] }], packageScripts: ["test"] },
      validation: { runTests: false, allowSkip: true },
    },
    setup(cwd) {
      writeBaseNodeProject(cwd);
      write(cwd, "src/auth.ts", `export function requireUser(headers: Record<string, string | undefined>) {\n  return headers["x-user-id"] ?? null;\n}\n`);
      write(cwd, "src/server.ts", `import { requireUser } from "./auth";\n\nexport function handleAdmin(headers: Record<string, string | undefined>) {\n  const user = requireUser(headers);\n  if (!user) return { status: 401 };\n  return { status: 200, body: "admin" };\n}\n`);
    },
  };
}

function holdoutSmallFeatureSortTasksCase(): WorkflowEvalCase {
  return {
    id: "holdout-small-feature-sort-tasks",
    kind: "small-feature",
    suite: "holdout",
    title: "Implement deterministic task sorting without mutating input",
    prompt: "Implementa sortTasks en src/sortTasks.ts: ordena por prioridad high > medium > low, luego por dueDate ascendente, conserva orden estable si empatan y no muta el array original. Añade tests.",
    expected: {
      requiredFiles: ["src/sortTasks.ts", "test/sortTasks.test.ts", "package.json"],
      requiredContent: [
        check("src/sortTasks.ts", "exports stable sortTasks", ["export function sortTasks", "priority", "dueDate", "high", "medium", "low", "sort|toSorted"], 32),
        check("src/sortTasks.ts", "does not mutate original array", ["\\.slice\\(|Array\\.from|toSorted|\\.map\\(|\\[\\s*\\.\\.\\.\\s*\\w+\\s*\\]"], 16),
        check("test/sortTasks.test.ts", "tests priority dueDate stability and immutability", ["sortTasks", "high", "medium", "low", "dueDate", "stable|immut|original", "expect|assert"], 30),
      ],
      forbiddenContent: [forbid("src/sortTasks.ts", "does not hardcode fixture IDs", ["task-1.*task-2.*task-3", "hardcoded"], 20)],
      finalAnswerPatterns: ["src/sortTasks.ts", "test/sortTasks.test.ts"],
      maxFiles: 4,
      maxDurationMs: 45_000,
      semantic: { exports: [{ file: "src/sortTasks.ts", names: ["sortTasks"] }], packageScripts: ["test"], testFiles: [{ file: "test/sortTasks.test.ts", target: "sortTasks", assertions: true }] },
      validation: { runTests: true, allowSkip: true },
    },
    setup(cwd) {
      writeBaseNodeProject(cwd);
      write(cwd, "src/sortTasks.ts", `export type Priority = "low" | "medium" | "high";\n\nexport interface Task {\n  id: string;\n  title: string;\n  priority: Priority;\n  dueDate: string;\n}\n\nexport function sortTasks(tasks: Task[]): Task[] {\n  return tasks;\n}\n`);
      write(cwd, "test/sortTasks.test.ts", `import { describe, it } from "node:test";\nimport assert from "node:assert/strict";\nimport { sortTasks } from "../src/sortTasks.ts";\n\ndescribe("sortTasks", () => {\n  it("keeps an empty list empty", () => {\n    assert.deepEqual(sortTasks([]), []);\n  });\n});\n`);
    },
  };
}

function holdoutScaffoldConfigLoaderCase(): WorkflowEvalCase {
  return {
    id: "holdout-scaffold-config-loader",
    kind: "scaffold",
    suite: "holdout",
    title: "Scaffold a tiny config loader with tests and docs",
    prompt: "Scaffoldea una mini librería TypeScript de config: package.json, src/config.ts, tests y README. API esperada: loadConfig(env) devuelve { port, nodeEnv }, default port 3000, acepta development/test/production y rechaza ports inválidos. Sin dependencias externas.",
    expected: {
      requiredFiles: ["package.json", "src/config.ts", "test/*.test.ts", "README.md"],
      requiredContent: [
        check("package.json", "declares module and test script", ["scripts", "test", "type|exports|main"], 18),
        check("src/config.ts", "exports loadConfig with validation and defaults", ["export\\s+(function|const)\\s+loadConfig", "PORT", "NODE_ENV", "3000", "development|production|test", "throw\\s+new\\s+(?:Range)?Error"], 34),
        check("test/*.test.ts", "tests defaults valid envs and invalid ports", ["loadConfig", "3000", "production|development|test", "invalid|throw|reject", "expect|assert"], 28),
        check("README.md", "documents config API usage", ["loadConfig", "PORT|port", "NODE_ENV|nodeEnv", "3000"], 10),
      ],
      forbiddenContent: [forbid("package.json", "no dependency shortcut", ["dotenv", "zod", "envalid"], 25)],
      finalAnswerPatterns: ["src/config.ts", "test/config.test.ts", "README.md"],
      maxFiles: 6,
      maxDurationMs: 60_000,
      semantic: { exports: [{ file: "src/config.ts", names: ["loadConfig"] }], packageScripts: ["test"], testFiles: [{ file: "test/*.test.ts", target: "loadConfig", assertions: true }] },
      validation: { runTests: true, allowSkip: true },
    },
    setup(cwd) {
      write(cwd, "README.md", `# config loader\n\nTODO: scaffold config library.\n`);
    },
  };
}

function holdoutPythonSlugifyCase(): WorkflowEvalCase {
  return {
    id: "holdout-python-slugify",
    kind: "small-feature",
    suite: "holdout",
    title: "Implement dependency-free Python slugify helper",
    prompt: "En este proyecto Python pequeño, implementa slugify(text) en slugify.py: minúsculas, reemplaza espacios/puntuación por guiones, colapsa guiones repetidos y recorta bordes. Añade/actualiza tests con unittest. Sin dependencias externas.",
    expected: {
      requiredFiles: ["slugify.py", "tests/test_slugify.py"],
      requiredContent: [
        check("slugify.py", "implements slugify normalization", ["def slugify", "lower", "re|regex|sub", "strip", "-"], 34),
        check("tests/test_slugify.py", "tests punctuation collapse and trim", ["slugify", "Hello", "world|python", "assertEqual", "--|punct|trim|collapse"], 30),
      ],
      forbiddenContent: [forbid("slugify.py", "no dependency shortcut", ["import slugify", "python-slugify", "from slugify"], 25)],
      finalAnswerPatterns: ["slugify.py", "tests/test_slugify.py", "unittest|python -m unittest|test"],
      maxFiles: 5,
      maxDurationMs: 60_000,
      validation: { runTests: true, allowSkip: false },
    },
    setup(cwd) {
      write(cwd, "slugify.py", `def slugify(text: str) -> str:\n    return text\n`);
      write(cwd, "tests/test_slugify.py", `import unittest\nfrom slugify import slugify\n\nclass SlugifyTest(unittest.TestCase):\n    def test_lowercases(self):\n        self.assertEqual(slugify("Hello"), "hello")\n\nif __name__ == "__main__":\n    unittest.main()\n`);
    },
  };
}

function holdoutGoTtlCacheCase(): WorkflowEvalCase {
  return {
    id: "holdout-go-ttl-cache",
    kind: "small-feature",
    suite: "holdout",
    title: "Implement Go TTL cache with injectable clock",
    prompt: "En este módulo Go implementa Cache.Get/Set en cache/cache.go con TTL y reloj inyectable para tests determinísticos. Añade tests para expiración y no uses goroutines ni dependencias externas.",
    expected: {
      requiredFiles: ["go.mod", "cache/cache.go", "cache/cache_test.go"],
      requiredContent: [
        check("cache/cache.go", "implements TTL cache", ["type Cache", "func New", "func \\(.*\\) Set", "func \\(.*\\) Get", "ttl|expires|expire", "now|clock"], 36),
        check("cache/cache_test.go", "tests deterministic expiry", ["New", "Set", "Get", "time", "expire|expired|TTL", "testing"], 30),
      ],
      forbiddenContent: [forbid("cache/cache.go", "no background goroutine shortcut", ["go func", "time.Tick", "time.NewTicker"], 20)],
      finalAnswerPatterns: ["cache/cache.go", "cache/cache_test.go", "go test"],
      maxFiles: 5,
      maxDurationMs: 60_000,
      validation: { runTests: true, allowSkip: false },
    },
    setup(cwd) {
      write(cwd, "go.mod", "module example.com/ttlcache\n\ngo 1.22\n");
      write(cwd, "cache/cache.go", `package cache\n\nimport "time"\n\ntype Cache struct {\n\tttl time.Duration\n}\n\nfunc New(ttl time.Duration, now func() time.Time) *Cache {\n\treturn &Cache{ttl: ttl}\n}\n\nfunc (c *Cache) Set(key string, value string) {}\n\nfunc (c *Cache) Get(key string) (string, bool) {\n\treturn "", false\n}\n`);
      write(cwd, "cache/cache_test.go", `package cache\n\nimport (\n\t"testing"\n\t"time"\n)\n\nfunc TestCacheStartsEmpty(t *testing.T) {\n\tnow := time.Unix(0, 0)\n\tc := New(time.Second, func() time.Time { return now })\n\tif _, ok := c.Get("missing"); ok {\n\t\tt.Fatal("expected cache miss")\n\t}\n}\n`);
    },
  };
}

function holdoutMonorepoPackageCase(): WorkflowEvalCase {
  return {
    id: "holdout-monorepo-package-script",
    kind: "scaffold",
    suite: "holdout",
    title: "Add a package-local utility in a tiny monorepo",
    prompt: "En este mini monorepo, implementa packages/math/src/clamp.ts y su test package-local. No muevas archivos al root. Mantén npm test en el root ejecutando el test del paquete.",
    expected: {
      requiredFiles: ["package.json", "packages/math/src/clamp.ts", "packages/math/test/clamp.test.ts"],
      requiredContent: [
        check("package.json", "root test script targets package test", ["scripts", "test", "packages/math|clamp.test|node"], 18),
        check("packages/math/src/clamp.ts", "exports clamp", ["export function clamp", "min", "max", "Math.min|Math.max|if"], 30),
        check("packages/math/test/clamp.test.ts", "tests bounds", ["clamp", "min", "max", "assert|expect", "below|above|inside|range"], 28),
      ],
      finalAnswerPatterns: ["packages/math/src/clamp.ts", "packages/math/test/clamp.test.ts", "npm test"],
      maxFiles: 8,
      maxDurationMs: 60_000,
      semantic: { exports: [{ file: "packages/math/src/clamp.ts", names: ["clamp"] }], packageScripts: ["test"], testFiles: [{ file: "packages/math/test/*.test.ts", target: "clamp", assertions: true }] },
      validation: { runTests: true, allowSkip: false },
    },
    setup(cwd) {
      write(cwd, "package.json", JSON.stringify({ name: "mini-monorepo", private: true, type: "module", scripts: { test: "node --experimental-strip-types --test packages/math/test/*.test.ts" } }, null, 2));
      write(cwd, "packages/math/src/clamp.ts", `export function clamp(value: number, min: number, max: number): number {\n  return value;\n}\n`);
      write(cwd, "packages/math/test/clamp.test.ts", `import test from "node:test";\nimport assert from "node:assert/strict";\nimport { clamp } from "../src/clamp.ts";\n\ntest("returns value inside range", () => {\n  assert.equal(clamp(5, 0, 10), 5);\n});\n`);
    },
  };
}

function holdoutLegacyCjsCase(): WorkflowEvalCase {
  return {
    id: "holdout-legacy-cjs-bugfix",
    kind: "bugfix",
    suite: "holdout",
    title: "Fix legacy CommonJS parser without ESM migration",
    prompt: "Corrige lib/parseFlags.cjs para parsear --name=value y flags booleanos como --verbose. Añade tests CommonJS. No migres el proyecto a ESM.",
    expected: {
      requiredFiles: ["package.json", "lib/parseFlags.cjs", "test/parseFlags.test.cjs"],
      requiredContent: [
        check("lib/parseFlags.cjs", "parses value and boolean flags", ["module.exports", "parseFlags", "--", "split|slice|indexOf", "true"], 34),
        check("test/parseFlags.test.cjs", "tests value and boolean flags", ["require", "parseFlags", "verbose", "name", "assert"], 30),
      ],
      forbiddenContent: [forbid("package.json", "does not migrate to ESM", ["\\\"type\\\"\\s*:\\s*\\\"module\\\""], 20)],
      finalAnswerPatterns: ["lib/parseFlags.cjs", "test/parseFlags.test.cjs", "npm test"],
      maxFiles: 5,
      maxDurationMs: 60_000,
      validation: { runTests: true, allowSkip: false },
    },
    setup(cwd) {
      write(cwd, "package.json", JSON.stringify({ name: "legacy-cjs", scripts: { test: "node --test test/*.test.cjs" } }, null, 2));
      write(cwd, "lib/parseFlags.cjs", `function parseFlags(argv) {\n  return {};\n}\n\nmodule.exports = { parseFlags };\n`);
      write(cwd, "test/parseFlags.test.cjs", `const test = require("node:test");\nconst assert = require("node:assert/strict");\nconst { parseFlags } = require("../lib/parseFlags.cjs");\n\ntest("starts empty", () => {\n  assert.deepEqual(parseFlags([]), {});\n});\n`);
    },
  };
}

function holdoutDocsRunbookCase(): WorkflowEvalCase {
  return {
    id: "holdout-docs-runbook",
    kind: "review-only",
    suite: "holdout",
    title: "Improve operational runbook from existing scripts",
    prompt: "Actualiza docs/runbook.md explicando cómo ejecutar tests, diagnosticar fallo de sync y rollback seguro usando la evidencia del repo. No cambies código.",
    expected: {
      requiredFiles: ["docs/runbook.md", "package.json", "src/sync.ts"],
      requiredContent: [
        check("docs/runbook.md", "documents tests diagnosis and rollback", ["npm\\s+(run\\s+)?test", "sync", "rollback", "diagn[oó]stic|diagnos|debug|troubleshoot", "src/sync.ts|package.json"], 45),
        check("src/sync.ts", "code remains untouched surface", ["export function syncRecords", "remote", "local"], 10),
      ],
      forbiddenFiles: ["test/*", "tests/*"],
      finalAnswerPatterns: ["docs/runbook.md", "npm test|test"],
      maxFiles: 6,
      maxDurationMs: 45_000,
      validation: { runTests: false, allowSkip: true },
    },
    setup(cwd) {
      writeBaseNodeProject(cwd);
      write(cwd, "src/sync.ts", `export function syncRecords(local: string[], remote: string[]): string[] {\n  return [...local, ...remote];\n}\n`);
      write(cwd, "docs/runbook.md", `# Sync Runbook\n\nTODO: document operations.\n`);
    },
  };
}

function holdoutBrokenTestsTriageCase(): WorkflowEvalCase {
  return {
    id: "holdout-broken-tests-triage",
    kind: "bugfix",
    suite: "holdout",
    title: "Fix failing test by correcting implementation root cause",
    prompt: "El test está fallando. Encuentra la causa raíz en src/normalizeEmail.ts, corrígela y deja npm test pasando. No cambies el test para ocultar el bug.",
    expected: {
      requiredFiles: ["package.json", "src/normalizeEmail.ts", "test/normalizeEmail.test.ts"],
      requiredContent: [
        check("src/normalizeEmail.ts", "normalizes trim and lowercase", ["export function normalizeEmail", "trim", "toLowerCase"], 34),
        check("test/normalizeEmail.test.ts", "keeps regression assertions", ["normalizeEmail", "USER@EXAMPLE.COM", "user@example.com", "assert|expect"], 28),
      ],
      forbiddenContent: [forbid("test/normalizeEmail.test.ts", "does not weaken assertion", ["notEqual|notStrictEqual|skip|todo"], 25)],
      finalAnswerPatterns: ["src/normalizeEmail.ts", "test/normalizeEmail.test.ts", "npm test"],
      maxFiles: 4,
      maxDurationMs: 45_000,
      semantic: { exports: [{ file: "src/normalizeEmail.ts", names: ["normalizeEmail"] }], packageScripts: ["test"], testFiles: [{ file: "test/normalizeEmail.test.ts", target: "normalizeEmail", assertions: true }] },
      validation: { runTests: true, allowSkip: false },
    },
    setup(cwd) {
      writeBaseNodeProject(cwd);
      write(cwd, "src/normalizeEmail.ts", `export function normalizeEmail(input: string): string {\n  return input;\n}\n`);
      write(cwd, "test/normalizeEmail.test.ts", `import test from "node:test";\nimport assert from "node:assert/strict";\nimport { normalizeEmail } from "../src/normalizeEmail.ts";\n\ntest("normalizes email whitespace and case", () => {\n  assert.equal(normalizeEmail(" USER@EXAMPLE.COM "), "user@example.com");\n});\n`);
    },
  };
}

function writeBaseNodeProject(cwd: string): void {
  write(cwd, "package.json", JSON.stringify({
    name: "workflow-eval-fixture",
    private: true,
    type: "module",
    scripts: { test: "node --experimental-strip-types --test test/*.test.ts" },
  }, null, 2));
  write(cwd, "tsconfig.json", JSON.stringify({ compilerOptions: { target: "ES2022", module: "NodeNext", moduleResolution: "NodeNext", strict: true, noEmit: true, allowImportingTsExtensions: true }, include: ["src/**/*.ts", "test/**/*.ts"] }, null, 2));
}

function check(file: string, label: string, patterns: string[], points: number): RequiredContentCheck {
  return { file, label, patterns, points };
}

function forbid(file: string, label: string, patterns: string[], penalty: number): ForbiddenContentCheck {
  return { file, label, patterns, penalty };
}

function write(cwd: string, relativePath: string, content: string): void {
  const file = path.join(cwd, relativePath);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content.trimStart());
}
