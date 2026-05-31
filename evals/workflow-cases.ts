import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export type WorkflowCaseKind = "refactor" | "test-writing" | "small-feature" | "large-feature" | "scaffold" | "greenfield" | "bugfix" | "review-only";
export type WorkflowCaseSuite = "calibration" | "holdout" | "community" | "complex";
export const WORKFLOW_ORACLE_DIR = ".workflow-oracle";

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
  promptMustMention?: string[];
}

export interface WorkflowEvalCase {
  id: string;
  kind: WorkflowCaseKind;
  suite: WorkflowCaseSuite;
  title: string;
  prompt: string;
  promptVariants?: string[];
  sourceProfile?: {
    kind: "synthetic" | "community-inspired" | "real-oss-inspired";
    inspiredBy?: string[];
    privateData: false;
  };
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
    hiddenValidation?: WorkflowHiddenValidationExpectation;
    orchestration?: WorkflowOrchestrationExpectation;
    antiCheat?: WorkflowAntiCheatExpectation;
  };
  authoringReview?: WorkflowAuthoringReview;
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

export interface WorkflowHiddenValidationExpectation {
  description: string;
  setup(cwd: string): void;
}

export interface WorkflowAntiCheatExpectation {
  forbiddenPathMarkers?: string[];
  notes?: string[];
}

export interface WorkflowOrchestrationExpectation {
  requireChalinRoute?: boolean;
  requireGentleSubagent?: boolean;
  rationale?: string;
}

export interface WorkflowAuthoringReview {
  oracleSolution?: string;
  knownFailureModes?: string[];
  antiCheatNotes?: string[];
  reviewedBy: string;
  reviewedAt: string;
}

export interface WorkflowFixture {
  case: WorkflowEvalCase;
  cwd: string;
  prompt: string;
  promptVariantIndex: number;
  promptVariantCount: number;
}

export function listWorkflowEvalCases(options: { includeHoldout?: boolean; includeCommunity?: boolean; includeComplex?: boolean } = {}): WorkflowEvalCase[] {
  const calibration = [
    refactorPricingCase(),
    addUnitTestCase(),
    smallFeatureCase(),
    largeFeatureCase(),
    scaffoldCase(),
    greenfieldCase(),
  ];
  return [
    ...calibration,
    ...(options.includeHoldout ? listWorkflowHoldoutCases() : []),
    ...(options.includeCommunity ? listWorkflowCommunityCases() : []),
    ...(options.includeComplex ? listWorkflowComplexCases() : []),
  ];
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

export function listWorkflowCommunityCases(): WorkflowEvalCase[] {
  return [
    communityExpressAuthMiddlewareCase(),
    communityReduxSelectorCase(),
    communityPythonPaginationCase(),
    communityGoHttpMiddlewareCase(),
    communityReactDebounceHookCase(),
    communityNextApiValidationCase(),
    communityGraphqlResolverCase(),
    communityKoaErrorMiddlewareCase(),
    communityCliEnvValidatorCase(),
    communityPythonRetryPolicyCase(),
    communityPythonCsvSummaryCase(),
    communityPythonRequestParserCase(),
    communityGoRetryBackoffCase(),
    communityGoJsonDecoderCase(),
    communityGoLruCacheCase(),
    communityTsFeatureFlagsCase(),
    communityNodeWebhookVerifierCase(),
    communityPythonFeatureFlagsCase(),
    communityGoSlugNormalizerCase(),
    communityTsEventEmitterCase(),
  ];
}

export function listWorkflowComplexCases(): WorkflowEvalCase[] {
  return [
    complexBunZigRustLockfileTriageCase(),
    complexBunZigRuntimePlanCase(),
    complexUvRustIndexUrlBugfixCase(),
    complexRustWorkspaceCacheFeatureCase(),
    complexSqliteCTokenizerBugfixCase(),
    complexRedisCExpireFeatureCase(),
    complexCpythonCUnicodeRegressionCase(),
    complexLlvmCppDiagnosticPlanCase(),
  ];
}

export function getWorkflowEvalCase(id: string): WorkflowEvalCase {
  const found = listWorkflowEvalCases({ includeHoldout: true, includeCommunity: true, includeComplex: true }).find((item) => item.id === id);
  if (!found) throw new Error(`Unsupported workflow eval case: ${id}`);
  return found;
}

export function selectWorkflowPrompt(evalCase: WorkflowEvalCase, variantIndex = 0): { prompt: string; index: number; count: number } {
  const prompts = evalCase.promptVariants?.length ? evalCase.promptVariants : autoPromptVariants(evalCase.prompt);
  const index = ((Math.floor(variantIndex) % prompts.length) + prompts.length) % prompts.length;
  return { prompt: prompts[index]!, index, count: prompts.length };
}

function autoPromptVariants(prompt: string): string[] {
  return [
    prompt,
    `Necesito una solución acotada, verificable y sin atajos. ${prompt} Si se piden tests, deben probar el comportamiento solicitado con asserts no triviales. Al final reporta archivos cambiados y verificación ejecutada.`,
    `Trabaja como en un cambio real de producción pero mantén el scope mínimo. ${prompt} Si se piden tests, actualízalos con casos de comportamiento/edge case y ejecútalos.`,
  ];
}

export function createWorkflowFixture(id: string, options: { promptVariantIndex?: number } = {}): WorkflowFixture {
  const evalCase = getWorkflowEvalCase(id);
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), `pi-chalin-workflow-${id}-`));
  evalCase.setup(cwd);
  const prompt = selectWorkflowPrompt(evalCase, options.promptVariantIndex ?? 0);
  return { case: evalCase, cwd, prompt: prompt.prompt, promptVariantIndex: prompt.index, promptVariantCount: prompt.count };
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
        check("test/pricing.test.ts", "covers pricing edge behavior", ["items\\s*:\\s*\\[(?:(?!\\]).)*sku\\s*:(?:(?!\\]).)*sku\\s*:", "missing discount|defaults missing discount|descuento omitido|discount to zero", "12\\.5|7\\.25|8\\.875|fraction|fracci[oó]n|porcentajes fraccionarios"], 18),
        check("package.json", "keeps test script", ["vitest run|node\\s+.*--test|bun test"], 8),
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
      writeBaseBunProject(cwd);
      write(cwd, "src/pricing.ts", `export interface LineItem {\n  sku: string;\n  quantity: number;\n  unitPriceCents: number;\n}\n\nexport interface InvoiceInput {\n  items: LineItem[];\n  discountPercent?: number;\n  taxRatePercent: number;\n}\n\nexport function calculateInvoice(input: InvoiceInput) {\n  let subtotal = 0;\n  for (const item of input.items) {\n    subtotal += item.quantity * item.unitPriceCents;\n  }\n  const discount = Math.round(subtotal * ((input.discountPercent ?? 0) / 100));\n  const taxable = subtotal - discount;\n  const tax = Math.round(taxable * (input.taxRatePercent / 100));\n  const total = taxable + tax;\n  return { subtotal, discount, tax, total };\n}\n`);
      write(cwd, "test/pricing.test.ts", `import { describe, it } from "bun:test";\nimport assert from "node:assert/strict";\nimport { calculateInvoice } from "../src/pricing.ts";\n\ndescribe("calculateInvoice", () => {\n  it("calculates totals with discount and tax", () => {\n    assert.deepEqual(calculateInvoice({\n      items: [{ sku: "book", quantity: 2, unitPriceCents: 1000 }],\n      discountPercent: 10,\n      taxRatePercent: 8,\n    }), { subtotal: 2000, discount: 200, tax: 144, total: 1944 });\n  });\n});\n`);
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
      forbiddenFiles: ["src/*.test.ts"],
      finalAnswerPatterns: ["test/safeDivide.test.ts", "divisi[oó]n|division"],
      maxFiles: 3,
      maxDurationMs: 45_000,
      semantic: { exports: [{ file: "src/safeDivide.ts", names: ["safeDivide"] }], packageScripts: ["test"], testFiles: [{ file: "test/safeDivide.test.ts", target: "safeDivide", assertions: true }] },
      validation: { runTests: true, allowSkip: true },
    },
    setup(cwd) {
      writeBaseBunProject(cwd);
      write(cwd, "src/safeDivide.ts", `export function safeDivide(numerator: number, denominator: number): number {\n  if (denominator === 0 || !Number.isFinite(denominator)) return 0;\n  return numerator / denominator;\n}\n`);
      write(cwd, "test/safeDivide.test.ts", `import { describe, it } from "bun:test";\nimport assert from "node:assert/strict";\nimport { safeDivide } from "../src/safeDivide.ts";\n\ndescribe("safeDivide", () => {\n  it("divides normal numbers", () => {\n    assert.equal(safeDivide(10, 2), 5);\n  });\n});\n`);
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
        check("src/filterTasks.ts", "exports filterTasks", ["export function filterTasks", "title", "description", "to(?:Locale)?LowerCase", "filter"], 30),
        check("test/filterTasks.test.ts", "case-insensitive title/description tests", ["filterTasks", "description|desc", "case|may[uú]sculas|lower|toLowerCase|ALPHA|alpha", "expect|assert"], 28),
        check("test/filterTasks.test.ts", "search filter edge coverage", ["empty|vac[ií]a|\"\"|''", "\"\\s{2,}\"|'\\s{2,}'|whitespace|blank|trim", "\\[\\]|length\\s*,\\s*0|no matches|no-match|sin resultados", "order|orden|preserv|tasks\\[[0-9]+\\].*tasks\\[[0-9]+\\]"], 16),
      ],
      forbiddenContent: [forbid("src/filterTasks.ts", "does not hardcode fixture terms", ["alpha beta only", "hardcoded"], 20)],
      finalAnswerPatterns: ["src/filterTasks.ts", "test/filterTasks.test.ts"],
      maxFiles: 4,
      maxDurationMs: 45_000,
      semantic: { exports: [{ file: "src/filterTasks.ts", names: ["filterTasks"] }], packageScripts: ["test"], testFiles: [{ file: "test/filterTasks.test.ts", target: "filterTasks", assertions: true }] },
      validation: { runTests: true, allowSkip: true },
      hiddenValidation: {
        description: "Hidden behavior tests cover case-insensitive title/description search, blank query behavior, no-match behavior, and order preservation.",
        setup(cwd) {
          write(cwd, "test/__hidden__/filterTasks.hidden.test.ts", `import { describe, it } from "bun:test";
import assert from "node:assert/strict";
import { filterTasks, type Task } from "../../src/filterTasks.ts";

const tasks: Task[] = [
  { id: "a", title: "Alpha rollout", description: "Billing launch" },
  { id: "b", title: "Beta cleanup", description: "Remove obsolete flag" },
  { id: "c", title: "Gamma docs", description: "ALPHA release notes" },
];

describe("filterTasks hidden behavior", () => {
  it("matches title or description case-insensitively and preserves order", () => {
    assert.deepEqual(filterTasks(tasks, "alpha").map((task) => task.id), ["a", "c"]);
  });

  it("returns all tasks for a blank query without mutating input order", () => {
    assert.deepEqual(filterTasks(tasks, "   ").map((task) => task.id), ["a", "b", "c"]);
  });

  it("returns an empty list when no task matches", () => {
    assert.deepEqual(filterTasks(tasks, "shipyard"), []);
  });
});
`);
        },
      },
    },
    authoringReview: {
      oracleSolution: "Implement filterTasks as a pure filter over normalized query/title/description and add behavior tests for empty, no-match, case-insensitive, and order-preserving paths.",
      knownFailureModes: ["Returns tasks unchanged", "Only searches title", "Case-sensitive search", "Ignores blank query normalization", "Hardcodes starter fixture terms"],
      antiCheatNotes: ["Starter tests are intentionally insufficient; hidden tests are installed only during validation."],
      reviewedBy: "pi-chalin-maintainers",
      reviewedAt: "2026-05-24",
    },
    setup(cwd) {
      writeBaseBunProject(cwd);
      write(cwd, "src/filterTasks.ts", `export interface Task {\n  id: string;\n  title: string;\n  description?: string;\n}\n\nexport function filterTasks(tasks: Task[], query: string): Task[] {\n  return tasks;\n}\n`);
      write(cwd, "test/filterTasks.test.ts", `import { describe, it } from "bun:test";\nimport assert from "node:assert/strict";\nimport { filterTasks } from "../src/filterTasks.ts";\n\ndescribe("filterTasks", () => {\n  it("returns all tasks for empty query", () => {\n    assert.equal(filterTasks([{ id: "1", title: "Pay rent" }], "").length, 1);\n  });\n});\n`);
    },
  };
}

function largeFeatureCase(): WorkflowEvalCase {
  return {
    id: "large-feature-rate-limit",
    kind: "large-feature",
    suite: "calibration",
    title: "Implement bounded rate limiter feature across module and tests",
    prompt: "Implementa un rate limiter in-memory en src/rateLimit.ts con ventanas por key, límite configurable, reset por tiempo y tests. Valida que limit y windowMs sean enteros positivos, incluyendo tests para valores fraccionarios inválidos. Mantén el scope pequeño: no agregues dependencias externas.",
    expected: {
      requiredFiles: ["src/rateLimit.ts", "test/rateLimit.test.ts", "package.json"],
      requiredContent: [
        check("src/rateLimit.ts", "exports rate limiter factory", ["export function createRateLimiter|export class RateLimiter", "limit", "windowMs", "Map"], 30),
        check("src/rateLimit.ts", "tracks key windows", ["key", "resetAt|expiresAt|windowStart|\\bstart\\b|hits|bucket|window", "allowed|remaining|retryAfter"], 20),
        check("src/rateLimit.ts", "validates positive integer options", ["(?:Number\\.is(?:Safe)?Integer\\([^)]*limit|(?:assert|check|ensure|validate)\\w*\\(\\s*limit)", "(?:Number\\.is(?:Safe)?Integer\\([^)]*windowMs|(?:assert|check|ensure|validate)\\w*\\(\\s*windowMs)", "(?:Number\\.is(?:Safe)?Integer\\(|Math\\.(?:floor|trunc)\\(|%\\s*1\\b)", "throw\\s+new\\s+\\w*Error"], 16),
        check("test/rateLimit.test.ts", "covers allow block and reset", ["createRateLimiter|RateLimiter", "allowed", "false|blocked|deny|limit", "reset|advanceTimers|Date\\.now|mock|tick|now\\s*\\+|current\\s*=", "expect|assert"], 25),
        check("test/rateLimit.test.ts", "covers invalid fractional options", ["1\\.5|2\\.5|fraction|fraccion|integer|entero", "limit", "windowMs", "throws|assert\\.throws|toThrow"], 12),
      ],
      forbiddenContent: [
        forbid("src/rateLimit.ts", "no external dependency shortcut", ["from ['\"]rate-limiter", "express-rate-limit", "bottleneck"], 25),
      ],
      finalAnswerPatterns: ["src/rateLimit.ts", "test/rateLimit.test.ts", "sin dependencias|no external|dependenc"],
      maxFiles: 5,
      maxDurationMs: 60_000,
      semantic: { exports: [{ file: "src/rateLimit.ts", names: ["createRateLimiter", "RateLimiter"] }], packageScripts: ["test"], testFiles: [{ file: "test/rateLimit.test.ts", target: "createRateLimiter", assertions: true }] },
      validation: { runTests: true, allowSkip: true },
      hiddenValidation: {
        description: "Hidden rate limiter tests reject fractional option rounding and verify independent key windows.",
        setup(cwd) {
          write(cwd, "test/rateLimit.hidden.test.ts", `import { describe, it } from "bun:test";
import assert from "node:assert/strict";
import { createRateLimiter } from "../src/rateLimit.ts";

describe("createRateLimiter hidden validation", () => {
  it("rejects fractional options instead of silently rounding them", () => {
    assert.throws(() => createRateLimiter({ limit: 1.2, windowMs: 1000 }));
    assert.throws(() => createRateLimiter({ limit: 2, windowMs: 1000.5 }));
  });

  it("keeps keys independent and resets by elapsed window time", () => {
    let now = 0;
    const limiter = createRateLimiter({ limit: 1, windowMs: 100, now: () => now });
    assert.equal(limiter.check("a").allowed, true);
    assert.equal(limiter.check("a").allowed, false);
    assert.equal(limiter.check("b").allowed, true);
    now = 100;
    assert.equal(limiter.check("a").allowed, true);
  });
});
`);
        },
      },
    },
    setup(cwd) {
      writeBaseBunProject(cwd);
      write(cwd, "src/rateLimit.ts", `export interface RateLimitResult {\n  allowed: boolean;\n  remaining: number;\n  retryAfterMs: number;\n}\n\nexport function createRateLimiter(_options: { limit: number; windowMs: number }) {\n  return {\n    check(_key: string): RateLimitResult {\n      return { allowed: true, remaining: 1, retryAfterMs: 0 };\n    },\n  };\n}\n`);
      write(cwd, "test/rateLimit.test.ts", `import { describe, it } from "bun:test";\nimport assert from "node:assert/strict";\nimport { createRateLimiter } from "../src/rateLimit.ts";\n\ndescribe("createRateLimiter", () => {\n  it("allows initial request", () => {\n    const limiter = createRateLimiter({ limit: 2, windowMs: 1000 });\n    assert.equal(limiter.check("user-1").allowed, true);\n  });\n});\n`);
    },
  };
}

function scaffoldCase(): WorkflowEvalCase {
  return {
    id: "scaffold-cli-tool",
    kind: "scaffold",
    suite: "calibration",
    title: "Scaffold a small CLI tool in a partially empty repo",
    prompt: "Scaffoldea un CLI TypeScript mínimo llamado note-pack: package.json, src/cli.ts, README con uso, y test básico en test/cli.test.ts. Usa Bun para ejecutar el test TypeScript sin agregar frameworks de test externos. El comando debe aceptar un argumento de texto y devolverlo normalizado a minúsculas.",
    expected: {
      requiredFiles: ["package.json", "src/cli.ts", "README.md", "test/*.test.ts"],
      requiredContent: [
        check("package.json", "declares CLI package and scripts", ["note-pack", "bin", "test", "type"], 20),
        check("src/*.ts", "implements lowercase normalization", ["to(?:Locale)?LowerCase", "export"], 25),
        check("test/*.test.ts", "tests normalization", ["normalize|note-pack|cli", "toLowerCase|lowercase|min[uú]scula|may[uú]scula", "expect|assert|test\\("], 20),
        check("README.md", "documents usage", ["note-pack", "Usage|Uso", "bun|Bun|note-pack\\s+<"], 10),
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
      finalAnswerPatterns: ["bun test|test", "src/index.ts", "README.md"],
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
      writeBaseBunProject(cwd);
      write(cwd, "src/parseDate.ts", `export function parseIsoDate(value: string): Date | null {\n  const parsed = new Date(value);\n  return Number.isNaN(parsed.getTime()) ? null : parsed;\n}\n`);
      write(cwd, "test/parseDate.test.ts", `import { describe, it } from "bun:test";\nimport assert from "node:assert/strict";\nimport { parseIsoDate } from "../src/parseDate.ts";\n\ndescribe("parseIsoDate", () => {\n  it("accepts a valid ISO date", () => {\n    assert.notEqual(parseIsoDate("2024-02-29"), null);\n  });\n});\n`);
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
      writeBaseBunProject(cwd);
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
      writeBaseBunProject(cwd);
      write(cwd, "src/sortTasks.ts", `export type Priority = "low" | "medium" | "high";\n\nexport interface Task {\n  id: string;\n  title: string;\n  priority: Priority;\n  dueDate: string;\n}\n\nexport function sortTasks(tasks: Task[]): Task[] {\n  return tasks;\n}\n`);
      write(cwd, "test/sortTasks.test.ts", `import { describe, it } from "bun:test";\nimport assert from "node:assert/strict";\nimport { sortTasks } from "../src/sortTasks.ts";\n\ndescribe("sortTasks", () => {\n  it("keeps an empty list empty", () => {\n    assert.deepEqual(sortTasks([]), []);\n  });\n});\n`);
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
      finalAnswerPatterns: ["src/config.ts", "tests?/config.test.ts", "README.md"],
      maxFiles: 6,
      maxDurationMs: 60_000,
      semantic: { exports: [{ file: "src/config.ts", names: ["loadConfig"] }], packageScripts: ["test"], testFiles: [{ file: "test/*.test.ts", target: "loadConfig", assertions: true }] },
      validation: { runTests: true, allowSkip: true },
      hiddenValidation: {
        description: "Hidden config loader tests cover strict whole-string port parsing and env-parameter isolation from process.env.",
        setup(cwd) {
          write(cwd, "tests/config.hidden.test.ts", `import { describe, expect, test } from "bun:test";
import { loadConfig } from "../src/config";

describe("loadConfig hidden validation", () => {
  test("rejects fractional, trailing-text, and empty PORT values", () => {
    expect(() => loadConfig({ PORT: "3000.5" })).toThrow();
    expect(() => loadConfig({ PORT: "3000abc" })).toThrow();
    expect(() => loadConfig({ PORT: "" })).toThrow();
  });

  test("uses only the injected env object, not process.env", () => {
    const previous = process.env.PORT;
    process.env.PORT = "9999";
    try {
      expect(loadConfig({})).toEqual({ port: 3000, nodeEnv: "development" });
    } finally {
      if (previous === undefined) delete process.env.PORT;
      else process.env.PORT = previous;
    }
  });
});
`);
        },
      },
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
    prompt: "En este mini monorepo, implementa packages/math/src/clamp.ts y su test package-local. No muevas archivos al root. Mantén bun test en el root ejecutando el test del paquete.",
    expected: {
      requiredFiles: ["package.json", "packages/math/src/clamp.ts", "packages/math/test/clamp.test.ts"],
      requiredContent: [
        check("package.json", "root test script targets package test", ["scripts", "test", "packages/math|clamp.test|node"], 18),
        check("packages/math/src/clamp.ts", "exports clamp", ["export function clamp", "min", "max", "Math.min|Math.max|if"], 30),
        check("packages/math/test/clamp.test.ts", "tests bounds", ["clamp", "min", "max", "assert|expect", "below|above|inside|range"], 28),
      ],
      finalAnswerPatterns: ["packages/math/src/clamp.ts", "packages/math/test/clamp.test.ts", "bun test"],
      maxFiles: 8,
      maxDurationMs: 60_000,
      semantic: { exports: [{ file: "packages/math/src/clamp.ts", names: ["clamp"] }], packageScripts: ["test"], testFiles: [{ file: "packages/math/test/*.test.ts", target: "clamp", assertions: true }] },
      validation: { runTests: true, allowSkip: false },
    },
    setup(cwd) {
      write(cwd, "package.json", JSON.stringify({ name: "mini-monorepo", private: true, type: "module", scripts: { test: "bun test packages/math/test/*.test.ts" } }, null, 2));
      write(cwd, "packages/math/src/clamp.ts", `export function clamp(value: number, min: number, max: number): number {\n  return value;\n}\n`);
      write(cwd, "packages/math/test/clamp.test.ts", `import { test } from "bun:test";\nimport assert from "node:assert/strict";\nimport { clamp } from "../src/clamp.ts";\n\ntest("returns value inside range", () => {\n  assert.equal(clamp(5, 0, 10), 5);\n});\n`);
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
      finalAnswerPatterns: ["lib/parseFlags.cjs", "test/parseFlags.test.cjs", "bun test"],
      maxFiles: 5,
      maxDurationMs: 60_000,
      validation: { runTests: true, allowSkip: false },
    },
    setup(cwd) {
      write(cwd, "package.json", JSON.stringify({ name: "legacy-cjs", scripts: { test: "node --test test/*.test.cjs" } }, null, 2));
      write(cwd, "lib/parseFlags.cjs", `function parseFlags(argv) {\n  return {};\n}\n\nmodule.exports = { parseFlags };\n`);
      write(cwd, "test/parseFlags.test.cjs", `const { test } = require("bun:test");\nconst assert = require("node:assert/strict");\nconst { parseFlags } = require("../lib/parseFlags.cjs");\n\ntest("starts empty", () => {\n  assert.deepEqual(parseFlags([]), {});\n});\n`);
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
        check("docs/runbook.md", "documents tests diagnosis and rollback", ["Bun\\s+(run\\s+)?test", "sync", "rollback", "diagn[oó]stic|diagnos|debug|troubleshoot", "package.json", "src/sync.ts", "syncRecords|local|remote"], 45),
        check("src/sync.ts", "code remains untouched surface", ["export function syncRecords", "remote", "local"], 10),
      ],
      forbiddenFiles: ["test/*", "tests/*"],
      finalAnswerPatterns: ["docs/runbook.md", "bun test|test"],
      maxFiles: 6,
      maxDurationMs: 45_000,
      validation: { runTests: false, allowSkip: true },
    },
    setup(cwd) {
      writeBaseBunProject(cwd);
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
    prompt: "El test está fallando. Encuentra la causa raíz en src/normalizeEmail.ts, corrígela y deja bun test pasando. No cambies el test para ocultar el bug.",
    expected: {
      requiredFiles: ["package.json", "src/normalizeEmail.ts", "test/normalizeEmail.test.ts"],
      requiredContent: [
        check("src/normalizeEmail.ts", "normalizes trim and lowercase", ["export function normalizeEmail", "trim", "toLowerCase"], 34),
        check("test/normalizeEmail.test.ts", "keeps regression assertions", ["normalizeEmail", "USER@EXAMPLE.COM", "user@example.com", "assert|expect"], 28),
      ],
      forbiddenContent: [forbid("test/normalizeEmail.test.ts", "does not weaken assertion", ["notEqual|notStrictEqual|skip|todo"], 25)],
      finalAnswerPatterns: ["src/normalizeEmail.ts", "test/normalizeEmail.test.ts", "bun test"],
      maxFiles: 4,
      maxDurationMs: 45_000,
      semantic: { exports: [{ file: "src/normalizeEmail.ts", names: ["normalizeEmail"] }], packageScripts: ["test"], testFiles: [{ file: "test/normalizeEmail.test.ts", target: "normalizeEmail", assertions: true }] },
      validation: { runTests: true, allowSkip: false },
    },
    setup(cwd) {
      writeBaseBunProject(cwd);
      write(cwd, "src/normalizeEmail.ts", `export function normalizeEmail(input: string): string {\n  return input;\n}\n`);
      write(cwd, "test/normalizeEmail.test.ts", `import { test } from "bun:test";\nimport assert from "node:assert/strict";\nimport { normalizeEmail } from "../src/normalizeEmail.ts";\n\ntest("normalizes email whitespace and case", () => {\n  assert.equal(normalizeEmail(" USER@EXAMPLE.COM "), "user@example.com");\n});\n`);
    },
  };
}

function communityExpressAuthMiddlewareCase(): WorkflowEvalCase {
  return {
    id: "community-express-auth-middleware",
    kind: "small-feature",
    suite: "community",
    title: "Express-style auth middleware without external packages",
    prompt: "En este mini servidor estilo Express, implementa requireRole(role) en src/authMiddleware.ts. Debe leer req.user.roles, devolver 401 si no hay user, 403 si falta el rol, llamar next() si pasa, y añadir tests. No agregues dependencias.",
    promptVariants: [
      "Implementa requireRole(role) en src/authMiddleware.ts para un servidor estilo Express: 401 sin user, 403 sin rol, next() si autorizado. Añade tests y no instales paquetes.",
      "Hay un gap de autorización en este mini proyecto tipo Express. Corrige src/authMiddleware.ts con middleware requireRole(role), cubre user ausente, rol faltante y rol válido con tests.",
      "Trabaja como en una app Express real pero sin dependencia express: añade middleware requireRole(role), conserva los tipos existentes, cubre 401 sin user, 403 sin rol y next() autorizado, y deja bun test pasando.",
    ],
    sourceProfile: communityProfile("Express middleware", "Node.js http handlers"),
    expected: {
      requiredFiles: ["package.json", "src/authMiddleware.ts", "test/authMiddleware.test.ts"],
      requiredContent: [
        check("src/authMiddleware.ts", "exports requireRole middleware", ["export function requireRole", "role", "req", "res", "next"], 28),
        check("src/authMiddleware.ts", "handles 401 403 and next", ["401", "403", "next\\(", "roles|includes"], 32),
        check("test/authMiddleware.test.ts", "tests auth outcomes", ["requireRole", "401", "403", "next|called|llamad", "assert|expect"], 28),
      ],
      forbiddenContent: [forbid("package.json", "no express dependency shortcut", ["express", "@types/express"], 25)],
      finalAnswerPatterns: ["src/authMiddleware.ts", "test/authMiddleware.test.ts", "bun test|test"],
      maxFiles: 5,
      maxDurationMs: 60_000,
      semantic: { exports: [{ file: "src/authMiddleware.ts", names: ["requireRole"] }], packageScripts: ["test"], testFiles: [{ file: "test/authMiddleware.test.ts", target: "requireRole", assertions: true }] },
      validation: { runTests: true, allowSkip: false },
    },
    setup(cwd) {
      writeBaseBunProject(cwd);
      write(cwd, "src/authMiddleware.ts", `export interface RequestLike {\n  user?: { id: string; roles?: string[] };\n}\n\nexport interface ResponseLike {\n  status(code: number): ResponseLike;\n  json(body: unknown): void;\n}\n\nexport type Next = () => void;\n\nexport function requireRole(_role: string) {\n  return (_req: RequestLike, _res: ResponseLike, next: Next) => next();\n}\n`);
      write(cwd, "test/authMiddleware.test.ts", `import { test } from "bun:test";\nimport assert from "node:assert/strict";\nimport { requireRole } from "../src/authMiddleware.ts";\n\ntest("allows existing user for now", () => {\n  let called = false;\n  const res = { status: () => res, json: () => undefined };\n  requireRole("admin")({ user: { id: "u1", roles: ["admin"] } }, res, () => { called = true; });\n  assert.equal(called, true);\n});\n`);
    },
  };
}

function communityReduxSelectorCase(): WorkflowEvalCase {
  return {
    id: "community-redux-selector-refactor",
    kind: "refactor",
    suite: "community",
    title: "Redux-style selector refactor with behavior preservation",
    prompt: "Refactoriza src/selectVisibleTodos.ts estilo Redux selector: mantén el API selectVisibleTodos(state), extrae helpers pequeños, no muta state.todos y añade tests para filtro active/completed/all.",
    promptVariants: [
      "Refactoriza el selector estilo Redux en src/selectVisibleTodos.ts. Mantén selectVisibleTodos(state), extrae helpers pequeños, no mutes el estado y añade tests para filtros active/completed/all.",
      "Este mini proyecto imita un selector de Redux. Mejora la localidad del código en src/selectVisibleTodos.ts extrayendo helpers o un mapa de filtros nombrado, sin cambiar comportamiento, y añade tests de regresión para all/active/completed e inmutabilidad.",
      "Haz un refactor seguro del selector de todos: helpers claros, API igual, orden estable, sin mutación, y tests completos para all/active/completed.",
    ],
    sourceProfile: communityProfile("Redux selectors", "TodoMVC-style state"),
    expected: {
      requiredFiles: ["package.json", "src/selectVisibleTodos.ts", "test/selectVisibleTodos.test.ts"],
      requiredContent: [
        check("src/selectVisibleTodos.ts", "keeps selector API", ["export function selectVisibleTodos", "state", "visibilityFilter|filter"], 24),
        check("src/selectVisibleTodos.ts", "extracts helper and avoids mutation", ["function (?!selectVisibleTodos)\\w+|const \\w+[\\s\\S]{0,160}=\\s*(?:\\(|\\{)", "filter", "todos", "slice|map|filter|toSorted|\\[\\.\\.\\."], 24),
        check("test/selectVisibleTodos.test.ts", "tests all active completed and immutability", ["selectVisibleTodos", "active", "completed", "all", "immut|original|notStrictEqual|deepEqual|deepStrictEqual|does not mutate", "assert|expect"], 32),
      ],
      finalAnswerPatterns: ["src/selectVisibleTodos.ts", "test/selectVisibleTodos.test.ts", "test"],
      maxFiles: 5,
      maxDurationMs: 60_000,
      semantic: { exports: [{ file: "src/selectVisibleTodos.ts", names: ["selectVisibleTodos"] }], packageScripts: ["test"], testFiles: [{ file: "test/selectVisibleTodos.test.ts", target: "selectVisibleTodos", assertions: true }] },
      validation: { runTests: true, allowSkip: false },
    },
    setup(cwd) {
      writeBaseBunProject(cwd);
      write(cwd, "src/selectVisibleTodos.ts", `export type VisibilityFilter = "all" | "active" | "completed";\nexport interface Todo { id: string; text: string; completed: boolean }\nexport interface TodoState { todos: Todo[]; visibilityFilter: VisibilityFilter }\n\nexport function selectVisibleTodos(state: TodoState): Todo[] {\n  if (state.visibilityFilter === "active") return state.todos.filter((todo) => !todo.completed);\n  if (state.visibilityFilter === "completed") return state.todos.filter((todo) => todo.completed);\n  return state.todos;\n}\n`);
      write(cwd, "test/selectVisibleTodos.test.ts", `import { test } from "bun:test";\nimport assert from "node:assert/strict";\nimport { selectVisibleTodos } from "../src/selectVisibleTodos.ts";\n\ntest("returns all todos", () => {\n  const state = { visibilityFilter: "all" as const, todos: [{ id: "1", text: "Ship", completed: false }] };\n  assert.equal(selectVisibleTodos(state).length, 1);\n});\n`);
    },
  };
}

function communityPythonPaginationCase(): WorkflowEvalCase {
  return {
    id: "community-python-pagination",
    kind: "small-feature",
    suite: "community",
    title: "Django-style pagination helper without Django dependency",
    prompt: "En este mini módulo Python inspirado en paginación Django, implementa paginate(items, page, page_size): page 1-based, valida argumentos, devuelve items/page/total_pages/has_next/has_prev. Añade tests unittest.",
    promptVariants: [
      "Implementa paginate(items, page, page_size) estilo Django pero sin Django: validación, total_pages, has_next/has_prev y tests unittest.",
      "Hay un helper de paginación incompleto. Completa paginator.py con page 1-based, errores claros y tests de bordes.",
      "Añade una paginación pequeña y determinística en Python: slices correctos, páginas vacías válidas cuando excede el total, validación de page/page_size inválidos y unittest pasando.",
    ],
    sourceProfile: communityProfile("Django pagination", "Python web helpers"),
    expected: {
      requiredFiles: ["paginator.py", "tests/test_paginator.py"],
      requiredContent: [
        check("paginator.py", "implements paginate metadata", ["def paginate", "page_size", "total_pages", "has_next", "has_prev", "items"], 38),
        check("paginator.py", "validates invalid arguments", ["ValueError", "page", "page_size", "<= 0|< 1|>= 1|positive|must be"], 18),
        check("tests/test_paginator.py", "tests pages and invalid args", ["paginate", "assertEqual", "has_next|has_prev|empty_page", "ValueError|assertRaises"], 30),
      ],
      finalAnswerPatterns: ["paginator.py", "tests/test_paginator.py", "unittest|test"],
      maxFiles: 5,
      maxDurationMs: 60_000,
      validation: { runTests: true, allowSkip: false },
    },
    setup(cwd) {
      write(cwd, "paginator.py", `def paginate(items, page, page_size):\n    return {\"items\": items, \"page\": page, \"total_pages\": 1, \"has_next\": False, \"has_prev\": False}\n`);
      write(cwd, "tests/test_paginator.py", `import unittest\nfrom paginator import paginate\n\nclass PaginatorTest(unittest.TestCase):\n    def test_first_page(self):\n        result = paginate([1, 2, 3], 1, 2)\n        self.assertEqual(result[\"items\"], [1, 2, 3])\n\nif __name__ == \"__main__\":\n    unittest.main()\n`);
    },
  };
}

function communityGoHttpMiddlewareCase(): WorkflowEvalCase {
  return {
    id: "community-go-http-middleware",
    kind: "small-feature",
    suite: "community",
    title: "Go net/http request-id middleware",
    prompt: "En este módulo Go inspirado en net/http middleware, implementa requestid.Middleware: conserva X-Request-ID si existe, genera uno si falta, lo setea en request context y response header. Añade tests httptest. Sin dependencias externas.",
    promptVariants: [
      "Implementa middleware Go net/http para X-Request-ID: preservar existente, generar faltante, exponer en context y header, tests httptest.",
      "Completa requestid.Middleware sin dependencias: request id estable, header de respuesta y context value verificable. Añade tests para ID existente y generado.",
      "Trabaja como en una librería Go real: middleware pequeño, API limpia, request id en context/header, y tests para id entrante y generado.",
    ],
    sourceProfile: communityProfile("Go net/http middleware", "request-id packages"),
    expected: {
      requiredFiles: ["go.mod", "requestid/requestid.go", "requestid/requestid_test.go"],
      requiredContent: [
        check("requestid/requestid.go", "implements middleware", ["func Middleware", "http\\.Handler", "X-Request-ID", "Header", "Context|WithContext"], 36),
        check("requestid/requestid.go", "generates missing id without dependency", ["crypto/rand|time|atomic|uuid|request", "Set|Add"], 14),
        check("requestid/requestid_test.go", "tests existing and generated request ids", ["httptest", "Header|X-Request-ID", "Middleware", "generated|missing|existing|Preserves|Generates"], 30),
      ],
      forbiddenContent: [forbid("requestid/requestid.go", "no external uuid dependency", ["github.com/google/uuid", "github.com/rs/xid", "github.com/oklog/ulid"], 25)],
      finalAnswerPatterns: ["requestid/requestid.go", "requestid/requestid_test.go", "go test"],
      maxFiles: 5,
      maxDurationMs: 60_000,
      validation: { runTests: true, allowSkip: false },
    },
    setup(cwd) {
      write(cwd, "go.mod", "module example.com/requestid\n\ngo 1.22\n");
      write(cwd, "requestid/requestid.go", `package requestid\n\nimport "net/http"\n\nconst Header = "X-Request-ID"\n\nfunc Middleware(next http.Handler) http.Handler {\n\treturn http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {\n\t\tnext.ServeHTTP(w, r)\n\t})\n}\n`);
      write(cwd, "requestid/requestid_test.go", `package requestid\n\nimport (\n\t\"net/http\"\n\t\"net/http/httptest\"\n\t\"testing\"\n)\n\nfunc TestMiddlewareCallsNext(t *testing.T) {\n\tcalled := false\n\th := Middleware(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { called = true }))\n\th.ServeHTTP(httptest.NewRecorder(), httptest.NewRequest(\"GET\", \"/\", nil))\n\tif !called { t.Fatal(\"next was not called\") }\n}\n`);
    },
  };
}

function communityReactDebounceHookCase(): WorkflowEvalCase {
  return {
    id: "community-react-debounce-hook",
    kind: "small-feature",
    suite: "community",
    title: "React-inspired dependency-free debounce utility",
    prompt: "Implementa createDebouncer en src/debounce.ts, inspirado en hooks React pero sin React: debe retrasar llamadas, cancelar la anterior, exponer cancel() y añadir tests determinísticos con reloj controlado. En el test de reset, tras la segunda llamada deben pasar delayMs completos antes de ejecutar callback.",
    sourceProfile: communityProfile("React hooks", "debounced input utilities"),
    expected: {
      requiredFiles: ["package.json", "src/debounce.ts", "test/debounce.test.ts"],
      requiredContent: [
        check("src/debounce.ts", "exports debouncer with cancel", ["export function createDebouncer", "setTimeout", "clearTimeout|token|version|active", "cancel"], 34),
        check("test/debounce.test.ts", "tests delayed call and cancel deterministically", ["createDebouncer", "cancel", "setTimeout|clock|tick|delay", "assert|expect"], 34),
      ],
      finalAnswerPatterns: ["src/debounce.ts", "test/debounce.test.ts", "test"],
      maxFiles: 5,
      maxDurationMs: 60_000,
      semantic: { exports: [{ file: "src/debounce.ts", names: ["createDebouncer"] }], packageScripts: ["test"], testFiles: [{ file: "test/debounce.test.ts", target: "createDebouncer", assertions: true }] },
      validation: { runTests: true, allowSkip: false },
    },
    setup(cwd) {
      writeBaseBunProject(cwd);
      write(cwd, "src/debounce.ts", `export function createDebouncer(delayMs: number, callback: () => void) {\n  return { call() { callback(); }, cancel() {} };\n}\n`);
      write(cwd, "test/debounce.test.ts", `import { test } from "bun:test";\nimport assert from "node:assert/strict";\nimport { createDebouncer } from "../src/debounce.ts";\n\ntest("calls callback", () => {\n  let calls = 0;\n  createDebouncer(10, () => { calls += 1; }).call();\n  assert.equal(calls, 1);\n});\n`);
    },
  };
}

function communityNextApiValidationCase(): WorkflowEvalCase {
  return {
    id: "community-next-api-validation",
    kind: "bugfix",
    suite: "community",
    title: "Next.js-style API route validation without framework dependency",
    prompt: "Corrige src/api/createUser.ts estilo Next API route: validate email y name, devuelve 400 con error para payload inválido y 201 con user normalizado. Añade tests sin instalar Next.",
    sourceProfile: communityProfile("Next.js API routes", "request validation"),
    expected: {
      requiredFiles: ["package.json", "src/api/createUser.ts", "test/createUser.test.ts"],
      requiredContent: [
        check("src/api/createUser.ts", "validates and normalizes user payload", ["export (function createUserHandler|const createUserHandler|async function POST)", "email", "name", "400", "201", "toLowerCase|trim"], 42),
        check("test/createUser.test.ts", "tests invalid payload and success", ["createUserHandler|POST", "400", "201", "invalid|missing|email", "assert|expect"], 34),
      ],
      finalAnswerPatterns: ["src/api/createUser.ts", "test/createUser.test.ts", "test"],
      maxFiles: 5,
      maxDurationMs: 60_000,
      semantic: { exports: [{ file: "src/api/createUser.ts", names: ["createUserHandler", "POST"] }], packageScripts: ["test"], testFiles: [{ file: "test/createUser.test.ts", target: "createUser", assertions: true }] },
      validation: { runTests: true, allowSkip: false },
    },
    setup(cwd) {
      writeBaseBunProject(cwd);
      write(cwd, "src/api/createUser.ts", `export interface RequestLike { body?: unknown }\nexport function createUserHandler(req: RequestLike) {\n  return { status: 201, body: req.body };\n}\n`);
      write(cwd, "test/createUser.test.ts", `import { test } from "bun:test";\nimport assert from "node:assert/strict";\nimport { createUserHandler } from "../src/api/createUser.ts";\n\ntest("creates user", () => {\n  assert.equal(createUserHandler({ body: { email: "A@B.COM", name: "Ada" } }).status, 201);\n});\n`);
    },
  };
}

function communityGraphqlResolverCase(): WorkflowEvalCase {
  return {
    id: "community-graphql-resolver",
    kind: "small-feature",
    suite: "community",
    title: "GraphQL-style resolver authorization",
    prompt: "Implementa resolver getProject en src/resolvers/project.ts: debe validar context.user, filtrar projects por ownerId y devolver null si no existe/no pertenece. Añade tests.",
    sourceProfile: communityProfile("GraphQL resolvers", "authorization checks"),
    expected: {
      requiredFiles: ["package.json", "src/resolvers/project.ts", "test/projectResolver.test.ts"],
      requiredContent: [
        check("src/resolvers/project.ts", "exports authorized getProject resolver", ["export function getProject", "context|\\{\\s*user|user\\s*,\\s*projects", "user", "ownerId", "null"], 38),
        check("test/projectResolver.test.ts", "tests auth owner and missing project", ["getProject", "ownerId", "null", "user", "assert|expect"], 34),
      ],
      finalAnswerPatterns: ["src/resolvers/project.ts", "test/projectResolver.test.ts", "test"],
      maxFiles: 5,
      maxDurationMs: 60_000,
      semantic: { exports: [{ file: "src/resolvers/project.ts", names: ["getProject"] }], packageScripts: ["test"], testFiles: [{ file: "test/projectResolver.test.ts", target: "getProject", assertions: true }] },
      validation: { runTests: true, allowSkip: false },
    },
    setup(cwd) {
      writeBaseBunProject(cwd);
      write(cwd, "src/resolvers/project.ts", `export interface Project { id: string; ownerId: string; name: string }\nexport function getProject(_args: { id: string }, _context: { user?: { id: string }, projects: Project[] }): Project | null {\n  return null;\n}\n`);
      write(cwd, "test/projectResolver.test.ts", `import { test } from "bun:test";\nimport assert from "node:assert/strict";\nimport { getProject } from "../src/resolvers/project.ts";\n\ntest("missing project returns null", () => {\n  assert.equal(getProject({ id: "x" }, { user: { id: "u1" }, projects: [] }), null);\n});\n`);
    },
  };
}

function communityKoaErrorMiddlewareCase(): WorkflowEvalCase {
  return {
    id: "community-koa-error-middleware",
    kind: "bugfix",
    suite: "community",
    title: "Koa-style error middleware",
    prompt: "Corrige src/errorMiddleware.ts estilo Koa: catch errores de next(), setea status/body, preserva status explícito y oculta mensajes 500. Añade tests async.",
    sourceProfile: communityProfile("Koa middleware", "error handling"),
    expected: {
      requiredFiles: ["package.json", "src/errorMiddleware.ts", "test/errorMiddleware.test.ts"],
      requiredContent: [
        check("src/errorMiddleware.ts", "catches async errors and maps status", ["export async function errorMiddleware", "try", "catch", "status", "body", "500"], 40),
        check("test/errorMiddleware.test.ts", "tests explicit status and 500 masking", ["errorMiddleware", "await", "418|400|500", "Internal|interno|message|mensaje|boom|not found", "assert|expect"], 34),
      ],
      finalAnswerPatterns: ["src/errorMiddleware.ts", "test/errorMiddleware.test.ts", "test"],
      maxFiles: 5,
      maxDurationMs: 60_000,
      semantic: { exports: [{ file: "src/errorMiddleware.ts", names: ["errorMiddleware"] }], packageScripts: ["test"], testFiles: [{ file: "test/errorMiddleware.test.ts", target: "errorMiddleware", assertions: true }] },
      validation: { runTests: true, allowSkip: false },
    },
    setup(cwd) {
      writeBaseBunProject(cwd);
      write(cwd, "src/errorMiddleware.ts", `export interface ContextLike { status?: number; body?: unknown }\nexport async function errorMiddleware(_ctx: ContextLike, next: () => Promise<void>): Promise<void> {\n  await next();\n}\n`);
      write(cwd, "test/errorMiddleware.test.ts", `import { test } from "bun:test";\nimport assert from "node:assert/strict";\nimport { errorMiddleware } from "../src/errorMiddleware.ts";\n\ntest("passes through successful next", async () => {\n  const ctx = {};\n  await errorMiddleware(ctx, async () => {});\n  assert.deepEqual(ctx, {});\n});\n`);
    },
  };
}

function communityCliEnvValidatorCase(): WorkflowEvalCase {
  return {
    id: "community-cli-env-validator",
    kind: "scaffold",
    suite: "community",
    title: "Small CLI env validator",
    prompt: "Scaffoldea un CLI TypeScript validate-env: package.json con bin, src/cli.ts, tests y README. Debe validar que variables requeridas existan en env y devolver lista de missing. Sin dependencias.",
    sourceProfile: communityProfile("dotenv-style CLIs", "env validation"),
    expected: {
      requiredFiles: ["package.json", "src/cli.ts", "test/cli.test.ts", "README.md"],
      requiredContent: [
        check("package.json", "declares validate-env bin and test", ["validate-env", "bin", "scripts", "test"], 22),
        check("src/cli.ts", "exports env validation API and reads argv/env", ["(export function|function) (validateEnv|missingEnvVars|validateRequiredEnv|getMissingEnvVariables|getMissingEnv|missingEnv|runFromArgs|runCli|run)|module\\.exports", "process\\.argv|argv", "missing", "env"], 34),
        check("test/cli.test.ts", "tests missing and present env vars", ["validateEnv|missingEnvVars|validateRequiredEnv|getMissingEnvVariables|getMissingEnv|missingEnv|runFromArgs|runCli|run", "missing", "DATABASE_URL|API_KEY|DB_HOST|DB_PORT|API_TOKEN|VALIDATE_ENV_|TOKEN|API_URL|TEST_|FOO|BAR|MISSING_|CLI_PRESENT|CLI_MISSING|X_VAR|Y_VAR|\\bA\\b|\\bB\\b", "assert|expect"], 28),
        check("README.md", "documents CLI usage", ["validate-env", "Usage|Uso", "env|variable"], 10),
      ],
      finalAnswerPatterns: ["package.json", "src/cli.ts", "README.md", "test"],
      maxFiles: 6,
      maxDurationMs: 60_000,
      semantic: { exports: [{ file: "src/cli.ts", names: ["validateEnv", "missingEnvVars", "validateRequiredEnv", "getMissingEnvVariables", "getMissingEnv", "missingEnv", "runFromArgs", "runCli", "run", "main"] }], packageScripts: ["test"], packageBin: "validate-env", testFiles: [{ file: "test/cli.test.ts", target: "missing", assertions: true }] },
      validation: { runTests: true, allowSkip: false },
    },
    setup(cwd) {
      write(cwd, "README.md", "# validate-env\n\nTODO\n");
    },
  };
}

function communityPythonRetryPolicyCase(): WorkflowEvalCase {
  return {
    id: "community-python-retry-policy",
    kind: "small-feature",
    suite: "community",
    title: "Celery-inspired retry policy helper",
    prompt: "Implementa should_retry(attempt, max_attempts, exc) en retry_policy.py inspirado en Celery: retry para errores transitorios, no para ValueError, respeta max_attempts. Añade unittest.",
    sourceProfile: communityProfile("Celery retry policies", "Python task workers"),
    expected: {
      requiredFiles: ["retry_policy.py", "tests/test_retry_policy.py"],
      requiredContent: [
        check("retry_policy.py", "implements retry policy", ["def should_retry", "max_attempts", "ConnectionError|TimeoutError|transient", "isinstance|type"], 42),
        check("tests/test_retry_policy.py", "tests transient permanent and max attempts", ["should_retry", "ConnectionError|TimeoutError", "ValueError", "max|attempts?_exhausted|exhausted", "assert"], 34),
      ],
      finalAnswerPatterns: ["retry_policy.py", "tests/test_retry_policy.py", "unittest|test"],
      maxFiles: 5,
      maxDurationMs: 60_000,
      validation: { runTests: true, allowSkip: false },
    },
    setup(cwd) {
      write(cwd, "retry_policy.py", `def should_retry(attempt, max_attempts, exc):\n    return True\n`);
      write(cwd, "tests/test_retry_policy.py", `import unittest\nfrom retry_policy import should_retry\n\nclass RetryPolicyTest(unittest.TestCase):\n    def test_retries_connection_error(self):\n        self.assertTrue(should_retry(1, 3, ConnectionError()))\n\nif __name__ == "__main__":\n    unittest.main()\n`);
    },
  };
}

function communityPythonCsvSummaryCase(): WorkflowEvalCase {
  return {
    id: "community-python-csv-summary",
    kind: "small-feature",
    suite: "community",
    title: "Pandas-inspired CSV summary without pandas",
    prompt: "Implementa summarize_csv(text) en csv_summary.py sin pandas: parsea CSV con stdlib, devuelve rows, columns y counts por columna no vacía. Añade unittest.",
    sourceProfile: communityProfile("pandas data summaries", "stdlib CSV tooling"),
    expected: {
      requiredFiles: ["csv_summary.py", "tests/test_csv_summary.py"],
      requiredContent: [
        check("csv_summary.py", "implements csv summary with stdlib", ["def summarize_csv", "csv", "columns", "rows", "non_empty|counts"], 42),
        check("tests/test_csv_summary.py", "tests rows columns and counts", ["summarize_csv", "rows", "columns", "counts|non_empty", "assertEqual"], 34),
      ],
      forbiddenContent: [forbid("csv_summary.py", "no pandas dependency", ["pandas", "pd\\."], 25)],
      finalAnswerPatterns: ["csv_summary.py", "tests/test_csv_summary.py", "unittest|test"],
      maxFiles: 5,
      maxDurationMs: 60_000,
      validation: { runTests: true, allowSkip: false },
    },
    setup(cwd) {
      write(cwd, "csv_summary.py", `def summarize_csv(text: str):\n    return {\"rows\": 0, \"columns\": [], \"counts\": {}}\n`);
      write(cwd, "tests/test_csv_summary.py", `import unittest\nfrom csv_summary import summarize_csv\n\nclass CsvSummaryTest(unittest.TestCase):\n    def test_empty_header(self):\n        self.assertEqual(summarize_csv(\"name\\n\")[\"columns\"], [])\n\nif __name__ == \"__main__\":\n    unittest.main()\n`);
    },
  };
}

function communityPythonRequestParserCase(): WorkflowEvalCase {
  return {
    id: "community-python-request-parser",
    kind: "bugfix",
    suite: "community",
    title: "Flask-inspired request args parser",
    prompt: "Corrige parse_query(query) en request_parser.py inspirado en Flask request.args: soporta URL querystring, valores repetidos como lista y decode percent-encoding. Añade unittest.",
    sourceProfile: communityProfile("Flask request args", "query parsing"),
    expected: {
      requiredFiles: ["request_parser.py", "tests/test_request_parser.py"],
      requiredContent: [
        check("request_parser.py", "parses query strings and repeated values", ["def parse_query", "parse_qs|urllib|unquote", "list|append|values|vals", "query"], 42),
        check("tests/test_request_parser.py", "tests repeated and encoded values", ["parse_query", "%20|%21|%26|%E2|John|hello|ana", "tag|a=1&a=2|x=1&x=2|y=2&y=3", "assertEqual"], 34),
      ],
      finalAnswerPatterns: ["request_parser.py", "tests/test_request_parser.py", "unittest|test"],
      maxFiles: 5,
      maxDurationMs: 60_000,
      validation: { runTests: true, allowSkip: false },
    },
    setup(cwd) {
      write(cwd, "request_parser.py", `def parse_query(query: str):\n    return {}\n`);
      write(cwd, "tests/test_request_parser.py", `import unittest\nfrom request_parser import parse_query\n\nclass RequestParserTest(unittest.TestCase):\n    def test_empty(self):\n        self.assertEqual(parse_query(\"\"), {})\n\nif __name__ == \"__main__\":\n    unittest.main()\n`);
    },
  };
}

function communityGoRetryBackoffCase(): WorkflowEvalCase {
  return {
    id: "community-go-retry-backoff",
    kind: "small-feature",
    suite: "community",
    title: "Go retry backoff helper",
    prompt: "Implementa retry.Backoff(attempt, base, max) en Go: exponential backoff capped, attempt empieza en 1, sin sleep real ni dependencias. Añade tests.",
    sourceProfile: communityProfile("Go retry libraries", "backoff helpers"),
    expected: {
      requiredFiles: ["go.mod", "retry/backoff.go", "retry/backoff_test.go"],
      requiredContent: [
        check("retry/backoff.go", "implements capped exponential backoff", ["func Backoff", "attempt", "base", "max", "time\\.Duration", "<<|math|for"], 42),
        check("retry/backoff_test.go", "tests cap and attempts", ["Backoff", "time", "cap|max", "attempt", "testing"], 34),
      ],
      finalAnswerPatterns: ["retry/backoff.go", "retry/backoff_test.go", "go test"],
      maxFiles: 5,
      maxDurationMs: 60_000,
      validation: { runTests: true, allowSkip: false },
    },
    setup(cwd) {
      write(cwd, "go.mod", "module example.com/retry\n\ngo 1.22\n");
      write(cwd, "retry/backoff.go", `package retry\n\nimport "time"\n\nfunc Backoff(attempt int, base time.Duration, max time.Duration) time.Duration {\n\treturn base\n}\n`);
      write(cwd, "retry/backoff_test.go", `package retry\n\nimport (\n\t\"testing\"\n\t\"time\"\n)\n\nfunc TestBackoffFirstAttempt(t *testing.T) {\n\tif Backoff(1, time.Second, 10*time.Second) != time.Second { t.Fatal(\"unexpected\") }\n}\n`);
    },
  };
}

function communityGoJsonDecoderCase(): WorkflowEvalCase {
  return {
    id: "community-go-json-decoder",
    kind: "bugfix",
    suite: "community",
    title: "Go JSON strict decoder",
    prompt: "Corrige jsonx.DecodeStrict[T] para rechazar campos desconocidos y body vacío, usando encoding/json stdlib. Añade tests.",
    sourceProfile: communityProfile("Go HTTP JSON APIs", "strict decoders"),
    expected: {
      requiredFiles: ["go.mod", "jsonx/decode.go", "jsonx/decode_test.go"],
      requiredContent: [
        check("jsonx/decode.go", "implements strict generic decoder", ["func DecodeStrict", "DisallowUnknownFields", "json", "EOF|empty|Decode\\(&"], 42),
        check("jsonx/decode_test.go", "tests unknown fields and valid JSON", ["DecodeStrict", "unknown", "valid", "testing"], 34),
      ],
      finalAnswerPatterns: ["jsonx/decode.go", "jsonx/decode_test.go", "go test"],
      maxFiles: 5,
      maxDurationMs: 60_000,
      validation: { runTests: true, allowSkip: false },
      hiddenValidation: {
        description: "Hidden Go strict decoder tests cover whitespace-only empty bodies and trailing JSON values.",
        setup(cwd) {
          write(cwd, "jsonx/decode_hidden_test.go", `package jsonx

import (
	"strings"
	"testing"
)

func TestDecodeStrictRejectsWhitespaceOnlyBody(t *testing.T) {
	_, err := DecodeStrict[payload](strings.NewReader("   \\n\\t  "))
	if err == nil {
		t.Fatal("expected empty body error for whitespace-only input")
	}
}

func TestDecodeStrictRejectsTrailingJSON(t *testing.T) {
	_, err := DecodeStrict[payload](strings.NewReader(` + "`" + `{"Name":"Ada"} {"Name":"Grace"}` + "`" + `))
	if err == nil {
		t.Fatal("expected trailing JSON error")
	}
}
`);
        },
      },
    },
    setup(cwd) {
      write(cwd, "go.mod", "module example.com/jsonx\n\ngo 1.22\n");
      write(cwd, "jsonx/decode.go", `package jsonx\n\nimport \"io\"\n\nfunc DecodeStrict[T any](r io.Reader) (T, error) {\n\tvar zero T\n\treturn zero, nil\n}\n`);
      write(cwd, "jsonx/decode_test.go", `package jsonx\n\nimport (\n\t\"strings\"\n\t\"testing\"\n)\n\ntype payload struct { Name string }\n\nfunc TestDecodeStrictValid(t *testing.T) {\n\t_, err := DecodeStrict[payload](strings.NewReader(` + "`" + `{\"Name\":\"Ada\"}` + "`" + `))\n\tif err != nil { t.Fatal(err) }\n}\n`);
    },
  };
}

function communityGoLruCacheCase(): WorkflowEvalCase {
  return {
    id: "community-go-lru-cache",
    kind: "large-feature",
    suite: "community",
    title: "Go LRU cache without dependencies",
    prompt: "Implementa lru.Cache con Get/Set y capacidad fija. Debe evictar least-recently-used al superar capacidad, actualizar existing keys y tener tests. Sin dependencias.",
    sourceProfile: communityProfile("Go cache libraries", "LRU caches"),
    expected: {
      requiredFiles: ["go.mod", "lru/cache.go", "lru/cache_test.go"],
      requiredContent: [
        check("lru/cache.go", "implements LRU cache", ["type Cache", "func New", "func \\(.*\\) Get", "func \\(.*\\) Set", "capacity", "list|order|recent|lru"], 46),
        check("lru/cache_test.go", "tests eviction and update", ["New", "Set", "Get", "evict|least|recent", "update", "testing"], 34),
      ],
      finalAnswerPatterns: ["lru/cache.go", "lru/cache_test.go", "go test"],
      maxFiles: 5,
      maxDurationMs: 60_000,
      validation: { runTests: true, allowSkip: false },
    },
    setup(cwd) {
      write(cwd, "go.mod", "module example.com/lru\n\ngo 1.22\n");
      write(cwd, "lru/cache.go", `package lru\n\ntype Cache struct{}\n\nfunc New(capacity int) *Cache { return &Cache{} }\nfunc (c *Cache) Set(key string, value string) {}\nfunc (c *Cache) Get(key string) (string, bool) { return \"\", false }\n`);
      write(cwd, "lru/cache_test.go", `package lru\n\nimport \"testing\"\n\nfunc TestStartsEmpty(t *testing.T) {\n\tc := New(2)\n\tif _, ok := c.Get(\"x\"); ok { t.Fatal(\"expected miss\") }\n}\n`);
    },
  };
}

function communityTsFeatureFlagsCase(): WorkflowEvalCase {
  return {
    id: "community-ts-feature-flags",
    kind: "small-feature",
    suite: "community",
    title: "LaunchDarkly-style feature flag evaluator",
    prompt: "Implementa evaluateFlag en src/flags.ts: default value, boolean rules por userId allowlist y percentage rollout determinístico. Añade tests, sin dependencias.",
    sourceProfile: communityProfile("feature flag SDKs", "percentage rollouts"),
    expected: {
      requiredFiles: ["package.json", "src/flags.ts", "test/flags.test.ts"],
      requiredContent: [
        check("src/flags.ts", "exports deterministic flag evaluator", ["export function evaluateFlag", "defaultValue", "userId", "allowlist|allowed|userIds", "percentage|rollout"], 42),
        check("test/flags.test.ts", "tests default allowlist and percentage", ["evaluateFlag", "default", "allow", "percentage|rollout", "assert|expect"], 34),
      ],
      finalAnswerPatterns: ["src/flags.ts", "test/flags.test.ts", "test"],
      maxFiles: 5,
      maxDurationMs: 60_000,
      semantic: { exports: [{ file: "src/flags.ts", names: ["evaluateFlag"] }], packageScripts: ["test"], testFiles: [{ file: "test/flags.test.ts", target: "evaluateFlag", assertions: true }] },
      validation: { runTests: true, allowSkip: false },
    },
    setup(cwd) {
      writeBaseBunProject(cwd);
      write(cwd, "src/flags.ts", `export function evaluateFlag(_flag: unknown, _user: { userId: string }): boolean {\n  return false;\n}\n`);
      write(cwd, "test/flags.test.ts", `import { test } from "bun:test";\nimport assert from "node:assert/strict";\nimport { evaluateFlag } from "../src/flags.ts";\n\ntest("defaults false", () => {\n  assert.equal(evaluateFlag({ defaultValue: false }, { userId: "u1" }), false);\n});\n`);
    },
  };
}

function communityNodeWebhookVerifierCase(): WorkflowEvalCase {
  return {
    id: "community-node-webhook-verifier",
    kind: "small-feature",
    suite: "community",
    title: "Stripe-style webhook verifier with HMAC",
    prompt: "Implementa verifyWebhook en src/webhook.ts: HMAC sha256 sobre payload, timingSafeEqual, rechaza firma faltante/incorrecta. Añade tests con crypto stdlib.",
    sourceProfile: communityProfile("Stripe webhooks", "HMAC verification"),
    expected: {
      requiredFiles: ["package.json", "src/webhook.ts", "test/webhook.test.ts"],
      requiredContent: [
        check("src/webhook.ts", "exports HMAC webhook verifier", ["export function verifyWebhook", "createHmac", "sha256", "timingSafeEqual", "signature"], 46),
        check("test/webhook.test.ts", "tests valid and invalid signatures", ["verifyWebhook", "createHmac|sha256", "valid|válida|acepta|correcta|accepts correct|returns true|signature matches|matches", "invalid|missing|inválida|faltante|incorrecta|rechaza|rejects|returns false", "assert|expect"], 34),
      ],
      finalAnswerPatterns: ["src/webhook.ts", "test/webhook.test.ts", "test"],
      maxFiles: 5,
      maxDurationMs: 60_000,
      semantic: { exports: [{ file: "src/webhook.ts", names: ["verifyWebhook"] }], packageScripts: ["test"], testFiles: [{ file: "test/webhook.test.ts", target: "verifyWebhook", assertions: true }] },
      validation: { runTests: true, allowSkip: false },
    },
    setup(cwd) {
      writeBaseBunProject(cwd);
      write(cwd, "src/webhook.ts", `export function verifyWebhook(_payload: string, _signature: string | undefined, _secret: string): boolean {\n  return true;\n}\n`);
      write(cwd, "test/webhook.test.ts", `import { test } from "bun:test";\nimport assert from "node:assert/strict";\nimport { verifyWebhook } from "../src/webhook.ts";\n\ntest("placeholder accepts", () => {\n  assert.equal(verifyWebhook("{}", "x", "s"), true);\n});\n`);
    },
  };
}

function communityPythonFeatureFlagsCase(): WorkflowEvalCase {
  return {
    id: "community-python-feature-flags",
    kind: "small-feature",
    suite: "community",
    title: "Python feature flag evaluator",
    prompt: "Implementa evaluate_flag(flag, user) en feature_flags.py: default, allowlist y rollout porcentual determinístico por user id. Añade unittest.",
    sourceProfile: communityProfile("feature flag SDKs", "Python rollout helpers"),
    expected: {
      requiredFiles: ["feature_flags.py", "tests/test_feature_flags.py"],
      requiredContent: [
        check("feature_flags.py", "implements deterministic flag evaluator", ["def evaluate_flag", "default", "allowlist|allowed", "percentage|rollout", "hash|sha"], 42),
        check("tests/test_feature_flags.py", "tests default allowlist and rollout", ["evaluate_flag", "default", "allow", "percentage|rollout", "assert"], 34),
      ],
      finalAnswerPatterns: ["feature_flags.py", "tests/test_feature_flags.py", "unittest|test"],
      maxFiles: 5,
      maxDurationMs: 60_000,
      validation: { runTests: true, allowSkip: false },
    },
    setup(cwd) {
      write(cwd, "feature_flags.py", `def evaluate_flag(flag, user):\n    return bool(flag.get(\"default\", False))\n`);
      write(cwd, "tests/test_feature_flags.py", `import unittest\nfrom feature_flags import evaluate_flag\n\nclass FeatureFlagsTest(unittest.TestCase):\n    def test_default(self):\n        self.assertFalse(evaluate_flag({\"default\": False}, {\"id\": \"u1\"}))\n\nif __name__ == \"__main__\":\n    unittest.main()\n`);
    },
  };
}

function communityGoSlugNormalizerCase(): WorkflowEvalCase {
  return {
    id: "community-go-slug-normalizer",
    kind: "small-feature",
    suite: "community",
    title: "Go slug normalizer",
    prompt: "Implementa slug.Slugify en Go: lowercase, espacios/puntuación a guiones, colapsa guiones y trim. Añade tests sin dependencias.",
    sourceProfile: communityProfile("Go string utilities", "slug libraries"),
    expected: {
      requiredFiles: ["go.mod", "slug/slug.go", "slug/slug_test.go"],
      requiredContent: [
        check("slug/slug.go", "implements slugify", ["func Slugify", "strings|unicode|regexp", "unicode|regexp|range", "lower", "-"], 42),
        check("slug/slug_test.go", "tests punctuation collapse and trim", ["Slugify", "Hello", "collapse|punct|trim|dash|spaces|a--b|Hello, World", "testing"], 34),
      ],
      finalAnswerPatterns: ["slug/slug.go", "slug/slug_test.go", "go test"],
      maxFiles: 5,
      maxDurationMs: 60_000,
      validation: { runTests: true, allowSkip: false },
    },
    setup(cwd) {
      write(cwd, "go.mod", "module example.com/slug\n\ngo 1.22\n");
      write(cwd, "slug/slug.go", `package slug\n\nfunc Slugify(input string) string { return input }\n`);
      write(cwd, "slug/slug_test.go", `package slug\n\nimport \"testing\"\n\nfunc TestLowercase(t *testing.T) {\n\tif Slugify(\"Hello\") != \"hello\" { t.Fatal(\"expected lowercase\") }\n}\n`);
    },
  };
}

function communityTsEventEmitterCase(): WorkflowEvalCase {
  return {
    id: "community-ts-event-emitter",
    kind: "greenfield",
    suite: "community",
    title: "Node EventEmitter-inspired tiny emitter",
    prompt: "Crea una mini librería TypeScript EventEmitter-inspired: package.json, src/emitter.ts, tests y README. API: on, off, once, emit; listeners llamados en orden. Sin dependencias.",
    sourceProfile: communityProfile("Node EventEmitter", "typed event emitters"),
    expected: {
      requiredFiles: ["package.json", "src/emitter.ts", "test/emitter.test.ts", "README.md"],
      requiredContent: [
        check("package.json", "declares module and test script", ["scripts", "test", "type|exports|main"], 18),
        check("src/emitter.ts", "implements emitter API", ["class|function", "on(?:<[^>]+>)?\\(", "off(?:<[^>]+>)?\\(", "once(?:<[^>]+>)?\\(", "emit(?:<[^>]+>)?\\("], 42),
        check("test/emitter.test.ts", "tests order off and once", ["emit", "once", "off", "order|orden|called|llama", "assert|expect"], 34),
        check("README.md", "documents emitter API", ["on", "off", "once", "emit"], 8),
      ],
      finalAnswerPatterns: ["src/emitter.ts", "test/emitter.test.ts", "README.md"],
      maxFiles: 6,
      maxDurationMs: 60_000,
      semantic: { exports: [{ file: "src/emitter.ts", names: ["EventEmitter", "MiniEventEmitter", "Emitter", "createEmitter"] }], packageScripts: ["test"], testFiles: [{ file: "test/emitter.test.ts", target: "emit", assertions: true }] },
      validation: { runTests: true, allowSkip: false },
    },
    setup(_cwd) {
      // Greenfield community-inspired package.
    },
  };
}

function complexBunZigRustLockfileTriageCase(): WorkflowEvalCase {
  return {
    id: "complex-bun-zig-rust-lockfile-triage",
    kind: "review-only",
    suite: "complex",
    title: "Bun-inspired Zig/Rust lockfile duplicate package triage",
    prompt: "En esta base multi-lenguaje inspirada en Bun, haz un analisis profundo cross-language del bug de paquetes duplicados cuando la ruta del workspace mezcla separadores Windows/POSIX. No cambies codigo: actualiza docs/lockfile-triage.md con causa raiz en Zig y Rust, archivos implicados, reproduccion minima, plan de fix y validacion.",
    sourceProfile: realOssProfile("Bun", "Zig lockfile parser", "Rust package manifest resolver"),
    expected: {
      requiredFiles: ["docs/lockfile-triage.md", "src/install/lockfile.zig", "crates/resolver/src/manifest.rs"],
      requiredContent: [
        check("docs/lockfile-triage.md", "documents cross-language root cause", ["Lockfile\\.parse|lockfile\\.zig", "PackageManifest|manifest\\.rs|crates/resolver/src/manifest\\.rs", "Windows|POSIX|separator|separador|\\\\\\\\|/", "duplicate|duplicad", "cache key|workspace[_ -]?key|path key|identity keys?|package key"], 48),
        check("docs/lockfile-triage.md", "includes repro fix plan and validation", ["Repro|reproducci", "Plan|fix", "normalize|normaliz", "zig test|cargo test|bun test|validation|validaci"], 34),
        check("src/install/lockfile.zig", "fixture keeps Zig lockfile surface", ["pub const Lockfile", "parse", "workspace_path"], 8),
        check("crates/resolver/src/manifest.rs", "fixture keeps Rust manifest surface", ["pub struct PackageManifest", "from_json", "workspace_path"], 8),
      ],
      forbiddenFiles: ["src/install/*.test.zig", "crates/resolver/tests/*"],
      finalAnswerPatterns: ["docs/lockfile-triage.md", "Lockfile", "manifest"],
      maxFiles: 10,
      maxDurationMs: 75_000,
      validation: { runTests: false, allowSkip: true },
      orchestration: {
        requireChalinRoute: true,
        requireGentleSubagent: true,
        rationale: "Cross-language root-cause triage spans multiple ownership surfaces and should exercise each harness's subagent/router path.",
      },
    },
    setup(cwd) {
      write(cwd, "README.md", "# Bun-inspired installer fixture\n\nSynthetic fixture for lockfile/resolver triage.\n");
      write(cwd, "src/install/lockfile.zig", `pub const Lockfile = struct {\n    workspace_path: []const u8,\n\n    pub fn parse(workspace_path: []const u8) Lockfile {\n        return .{ .workspace_path = workspace_path };\n    }\n\n    pub fn packageKey(this: Lockfile, name: []const u8) []const u8 {\n        _ = this;\n        return name;\n    }\n};\n`);
      write(cwd, "crates/resolver/src/manifest.rs", `pub struct PackageManifest {\n    pub name: String,\n    pub workspace_path: String,\n}\n\nimpl PackageManifest {\n    pub fn from_json(name: &str, workspace_path: &str) -> Self {\n        Self { name: name.to_string(), workspace_path: workspace_path.to_string() }\n    }\n\n    pub fn workspace_key(&self) -> String {\n        format!(\"{}:{}\", self.workspace_path, self.name)\n    }\n}\n`);
      write(cwd, "docs/lockfile-triage.md", "# Lockfile duplicate triage\n\nTODO: map root cause and fix plan.\n");
    },
  };
}

function complexBunZigRuntimePlanCase(): WorkflowEvalCase {
  return {
    id: "complex-bun-zig-runtime-plan",
    kind: "review-only",
    suite: "complex",
    title: "Bun-inspired runtime boundary planning across Zig and Rust",
    prompt: "En esta base multi-lenguaje inspirada en Bun, planifica una implementacion segura y cross-language para propagar un nuevo runtime flag `--deny-net` desde CLI Zig hasta el runtime Rust. No escribas codigo: actualiza docs/deny-net-plan.md con arquitectura, archivos tocados, riesgos, pasos incrementales y validacion.",
    sourceProfile: realOssProfile("Bun", "Zig CLI boundary", "Rust runtime services"),
    expected: {
      requiredFiles: ["docs/deny-net-plan.md", "src/cli.zig", "src/bindings/runtime.zig", "crates/runtime/src/permissions.rs"],
      requiredContent: [
        check("docs/deny-net-plan.md", "maps Zig to Rust boundary", ["src/cli\\.zig", "runtime\\.zig", "permissions\\.rs", "FFI|binding|boundary|frontera", "deny-net"], 46),
        check("docs/deny-net-plan.md", "contains incremental implementation and validation plan", ["Paso|Step|Stage|Fase|Etapa|increment|staged|S[0-9]", "risk|riesgo", "tests|valid|verif", "CLI|runtime", "rollback|compat"], 34),
      ],
      forbiddenFiles: ["src/**/*.test.zig", "crates/runtime/tests/*"],
      finalAnswerPatterns: ["docs/deny-net-plan.md", "deny-net", "valid|verif|verificaci|prueba|test"],
      maxFiles: 10,
      maxDurationMs: 75_000,
      validation: { runTests: false, allowSkip: true },
      orchestration: {
        requireChalinRoute: true,
        requireGentleSubagent: true,
        rationale: "Cross-runtime architecture planning should use routed/subagent context isolation instead of direct parent-only work.",
      },
    },
    setup(cwd) {
      write(cwd, "src/cli.zig", `pub const CliOptions = struct {\n    script: []const u8,\n};\n\npub fn parseArgs(script: []const u8) CliOptions {\n    return .{ .script = script };\n}\n`);
      write(cwd, "src/bindings/runtime.zig", `pub extern fn bun_runtime_start(script: [*:0]const u8) void;\n`);
      write(cwd, "crates/runtime/src/permissions.rs", `pub struct RuntimePermissions {\n    pub allow_net: bool,\n}\n\nimpl Default for RuntimePermissions {\n    fn default() -> Self { Self { allow_net: true } }\n}\n`);
      write(cwd, "docs/deny-net-plan.md", "# deny-net plan\n\nTODO: plan runtime flag propagation.\n");
    },
  };
}

function complexUvRustIndexUrlBugfixCase(): WorkflowEvalCase {
  return {
    id: "complex-uv-rust-index-url-bugfix",
    kind: "bugfix",
    suite: "complex",
    title: "uv-inspired Rust index URL normalization bugfix",
    prompt: "En este workspace Rust inspirado en uv, corrige normalize_index_url en crates/index-url/src/lib.rs sin agregar dependencias externas. Debe normalizar scheme/host case-insensitive, quitar credenciales y tratar especificamente /simple y /simple/ como equivalentes normalizando /simple a /simple/. Otros paths y URLs sin path deben preservarse salvo scheme/host/credenciales, incluyendo query/fragment. Añade/actualiza tests y deja cargo test pasando.",
    sourceProfile: realOssProfile("uv", "Rust index URL resolver", "Python package indexes"),
    expected: {
      requiredFiles: ["Cargo.toml", "crates/index-url/Cargo.toml", "crates/index-url/src/lib.rs"],
      requiredContent: [
        check("crates/index-url/src/lib.rs", "normalizes index URLs", ["pub fn normalize_index_url", "trim", "to_ascii_lowercase|to_lowercase", "simple", "credentials|userinfo|@|split"], 44),
        check("crates/index-url/src/lib.rs", "contains Rust unit tests for equivalent URLs", ["#\\[cfg\\(test\\)\\]", "#\\[test\\]", "EXAMPLE\\.COM|Example\\.com|example\\.com", "/simple/?", "assert_eq"], 36),
      ],
      forbiddenContent: [forbid("crates/index-url/src/lib.rs", "no url crate shortcut", ["use url::", "url ="], 20, ["dependencias externas|external dependencies"])],
      finalAnswerPatterns: ["crates/index-url/src/lib.rs", "cargo test"],
      maxFiles: 8,
      maxDurationMs: 75_000,
      validation: { runTests: true, allowSkip: false },
      hiddenValidation: {
        description: "Hidden Rust index URL behavior tests cover query/fragment composition, non-target path case preservation, and no-path preservation.",
        setup(cwd) {
          write(cwd, "crates/index-url/tests/hidden.rs", `use index_url::normalize_index_url;

#[test]
fn normalizes_simple_before_query_and_fragment() {
    assert_eq!(
        normalize_index_url("HTTPS://token@Example.COM/simple?format=json#frag"),
        "https://example.com/simple/?format=json#frag"
    );
}

#[test]
fn preserves_non_target_path_case_and_no_path_urls() {
    assert_eq!(
        normalize_index_url("https://Example.com/pkg/SIMPLE"),
        "https://example.com/pkg/SIMPLE"
    );
    assert_eq!(normalize_index_url("https://Example.com"), "https://example.com");
}

#[test]
fn preserves_non_simple_path_query_without_adding_slash() {
    assert_eq!(
        normalize_index_url("https://Example.com/path?x=1"),
        "https://example.com/path?x=1"
    );
}
`);
        },
      },
    },
    setup(cwd) {
      write(cwd, "Cargo.toml", `[workspace]\nmembers = ["crates/index-url"]\nresolver = "2"\n`);
      write(cwd, "crates/index-url/Cargo.toml", `[package]\nname = "index-url"\nversion = "0.1.0"\nedition = "2021"\n`);
      write(cwd, "crates/index-url/src/lib.rs", `pub fn normalize_index_url(input: &str) -> String {\n    input.trim().to_string()\n}\n\n#[cfg(test)]\nmod tests {\n    use super::normalize_index_url;\n\n    #[test]\n    fn normalizes_simple_suffix_and_case() {\n        assert_eq!(normalize_index_url("HTTPS://EXAMPLE.COM/simple"), "https://example.com/simple/");\n    }\n\n    #[test]\n    fn strips_credentials_from_index_url() {\n        assert_eq!(normalize_index_url("https://token@example.com/simple/"), "https://example.com/simple/");\n    }\n}\n`);
    },
  };
}

function complexRustWorkspaceCacheFeatureCase(): WorkflowEvalCase {
  return {
    id: "complex-rust-workspace-cache-feature",
    kind: "large-feature",
    suite: "complex",
    title: "Rust workspace cache key feature with deterministic markers",
    prompt: "En este workspace Rust, implementa build_cache_key en crates/cache-key/src/lib.rs. Debe normalizar package con trim + lowercase, normalizar version con trim sin cambiar su contenido, aplicar trim a markers, ignorar markers vacios despues del trim, ordenar markers, preservar case y duplicados de markers, producir una key deterministica y cubrirlo con tests. Deja cargo test pasando.",
    sourceProfile: realOssProfile("Cargo ecosystem", "uv cache keys", "Rust workspaces"),
    expected: {
      requiredFiles: ["Cargo.toml", "crates/cache-key/Cargo.toml", "crates/cache-key/src/lib.rs"],
      requiredContent: [
        check("crates/cache-key/src/lib.rs", "implements deterministic cache key builder", ["pub fn build_cache_key", "package", "version", "markers", "sort|sort_unstable", "filter|is_empty", "to_ascii_lowercase|to_lowercase"], 48),
        check("crates/cache-key/src/lib.rs", "tests marker ordering and empty markers", ["#\\[test\\]", "marker", "sort|order|determin", "empty|blank", "assert_eq"], 34),
      ],
      finalAnswerPatterns: ["crates/cache-key/src/lib.rs", "cargo test"],
      maxFiles: 8,
      maxDurationMs: 75_000,
      validation: { runTests: true, allowSkip: false },
      hiddenValidation: {
        description: "Hidden Rust cache key behavior tests cover marker case preservation, trimming, sorting, duplicate retention, and empty marker filtering.",
        setup(cwd) {
          write(cwd, "crates/cache-key/tests/hidden.rs", `use cache_key::build_cache_key;

#[test]
fn preserves_marker_case_while_sorting_and_filtering() {
    assert_eq!(
        build_cache_key(" Ruff ", " 1.0.0 ", &["Zed", " alpha ", "", "  "]),
        "ruff:1.0.0:Zed,alpha"
    );
}

#[test]
fn keeps_duplicate_markers_without_lowercasing() {
    assert_eq!(
        build_cache_key("Pkg", "2", &["B", "a", "B"]),
        "pkg:2:B,B,a"
    );
}
`);
        },
      },
    },
    setup(cwd) {
      write(cwd, "Cargo.toml", `[workspace]\nmembers = ["crates/cache-key"]\nresolver = "2"\n`);
      write(cwd, "crates/cache-key/Cargo.toml", `[package]\nname = "cache-key"\nversion = "0.1.0"\nedition = "2021"\n`);
      write(cwd, "crates/cache-key/src/lib.rs", `pub fn build_cache_key(package: &str, version: &str, markers: &[&str]) -> String {\n    format!("{package}:{version}:{}", markers.join(","))\n}\n\n#[cfg(test)]\nmod tests {\n    use super::build_cache_key;\n\n    #[test]\n    fn normalizes_package_and_version() {\n        assert_eq!(build_cache_key(" Ruff ", " 1.0.0 ", &[]), "ruff:1.0.0:");\n    }\n}\n`);
    },
  };
}

function complexSqliteCTokenizerBugfixCase(): WorkflowEvalCase {
  return {
    id: "complex-sqlite-c-tokenizer-bugfix",
    kind: "bugfix",
    suite: "complex",
    title: "SQLite-inspired C tokenizer quote/comment bugfix",
    prompt: "Corrige el tokenizer C inspirado en SQLite: count_sql_tokens debe contar tokens ignorando whitespace, tratar strings entre comillas simples como un token separado incluso cuando la comilla aparece pegada a texto no-whitespace, y saltar comentarios -- hasta fin de linea. No agregues dependencias. Deja make test pasando.",
    sourceProfile: realOssProfile("SQLite", "C tokenizer", "SQL parser edge cases"),
    expected: {
      requiredFiles: ["Makefile", "include/sql_tokenizer.h", "src/sql_tokenizer.c", "tests/test_sql_tokenizer.c"],
      requiredContent: [
        check("src/sql_tokenizer.c", "handles quoted strings and line comments", ["count_sql_tokens", "'|quote|in_string|string", "--|comment|line_comment|p\\[0\\]\\s*==\\s*'-'|p\\[1\\]\\s*==\\s*'-'", "isspace|ctype", "tokens"], 48),
        check("tests/test_sql_tokenizer.c", "tests quotes comments and whitespace", ["count_sql_tokens", "select", "a b|quoted|quote", "--|comment", "assert"], 36),
      ],
      finalAnswerPatterns: ["src/sql_tokenizer.c", "tests/test_sql_tokenizer.c", "make test"],
      maxFiles: 8,
      maxDurationMs: 75_000,
      validation: { runTests: true, allowSkip: false },
      hiddenValidation: {
        description: "Hidden SQL tokenizer behavior tests cover unrestricted line comments, EOF comments, escaped quotes, quoted comment markers, and quote-delimited tokens adjacent to normal token characters.",
        setup(cwd) {
          write(cwd, "tests/test_sql_tokenizer.c", `#include "sql_tokenizer.h"
#include <assert.h>

int main(void) {
    assert(count_sql_tokens("select 'a b' from users") == 4);
    assert(count_sql_tokens("select a -- ignored token\\nfrom t") == 4);
    assert(count_sql_tokens("  select   *   from t  ") == 4);
    assert(count_sql_tokens("select a--comment without space\\nfrom t") == 4);
    assert(count_sql_tokens("select a--comment at eof") == 2);
    assert(count_sql_tokens("select 'it''s -- not comment' from t") == 4);
    assert(count_sql_tokens("a'b c d'") == 2);
    return 0;
}
`);
        },
      },
    },
    authoringReview: {
      oracleSolution: "Treat single-quoted strings as separate tokens with doubled quote escapes even when adjacent to normal token characters, skip any -- line comment until newline/EOF, and keep whitespace-only token boundaries intact.",
      knownFailureModes: ["Only handles comments when followed by whitespace", "Counts words inside quoted strings", "Treats -- inside strings as comments", "Passes starter tests without adding edge coverage"],
      antiCheatNotes: ["Starter tests are intentionally incomplete; hidden validation extends the visible test with boundary cases after the agent finishes."],
      reviewedBy: "pi-chalin-maintainers",
      reviewedAt: "2026-05-24",
    },
    setup(cwd) {
      writeCMakeProject(cwd, "test_sql_tokenizer", "src/sql_tokenizer.c tests/test_sql_tokenizer.c");
      write(cwd, "include/sql_tokenizer.h", `#pragma once\n\nint count_sql_tokens(const char *sql);\n`);
      write(cwd, "src/sql_tokenizer.c", `#include "sql_tokenizer.h"\n#include <ctype.h>\n\nint count_sql_tokens(const char *sql) {\n    int tokens = 0;\n    int in_token = 0;\n    for (const char *p = sql; *p; ++p) {\n        if (isspace((unsigned char)*p)) {\n            in_token = 0;\n        } else if (!in_token) {\n            tokens++;\n            in_token = 1;\n        }\n    }\n    return tokens;\n}\n`);
      write(cwd, "tests/test_sql_tokenizer.c", `#include "sql_tokenizer.h"\n#include <assert.h>\n\nint main(void) {\n    assert(count_sql_tokens("select 'a b' from users") == 4);\n    assert(count_sql_tokens("select a -- ignored token\\nfrom t") == 4);\n    assert(count_sql_tokens("  select   *   from t  ") == 4);\n    return 0;\n}\n`);
    },
  };
}

function complexRedisCExpireFeatureCase(): WorkflowEvalCase {
  return {
    id: "complex-redis-c-expire-feature",
    kind: "large-feature",
    suite: "complex",
    title: "Redis-inspired C expire table with deterministic clock",
    prompt: "Implementa en C una tabla TTL minima inspirada en Redis en src/expire_table.c: expire_set, expire_get y expire_sweep deben usar un reloj inyectado en ms, expirar keys vencidas y preservar keys vivas. Deja make test pasando.",
    sourceProfile: realOssProfile("Redis", "C expire dictionary", "TTL semantics"),
    expected: {
      requiredFiles: ["Makefile", "include/expire_table.h", "src/expire_table.c", "tests/test_expire_table.c"],
      requiredContent: [
        check("src/expire_table.c", "implements ttl set get and sweep", ["expire_set", "expire_get", "expire_sweep", "now_ms|clock", "ttl_ms|expires", "strcmp|key"], 50),
        check("tests/test_expire_table.c", "tests expiry and live keys", ["expire_set", "expire_get", "expire_sweep", "expired|ttl|live", "assert"], 36),
      ],
      forbiddenContent: [
        forbid("src/expire_table.c", "no wall-clock sleep shortcut", ["sleep\\(", "usleep\\(", "time\\("], 24),
        forbid("src/expire_table.c", "no arbitrary fixed-size table cap", ["#define\\s+MAX_EXPIRE_ENTRIES", "static\\s+expire_entry_t\\s+\\w+\\s*\\["], 20),
      ],
      finalAnswerPatterns: ["src/expire_table.c", "tests/test_expire_table.c", "make test"],
      maxFiles: 8,
      maxDurationMs: 75_000,
      validation: { runTests: true, allowSkip: false },
    },
    setup(cwd) {
      writeCMakeProject(cwd, "test_expire_table", "src/expire_table.c tests/test_expire_table.c");
      write(cwd, "include/expire_table.h", `#pragma once\n\nvoid expire_set(const char *key, const char *value, long long ttl_ms, long long now_ms);\nconst char *expire_get(const char *key, long long now_ms);\nvoid expire_sweep(long long now_ms);\nvoid expire_clear(void);\n`);
      write(cwd, "src/expire_table.c", `#include "expire_table.h"\n\nvoid expire_set(const char *key, const char *value, long long ttl_ms, long long now_ms) {\n    (void)key; (void)value; (void)ttl_ms; (void)now_ms;\n}\n\nconst char *expire_get(const char *key, long long now_ms) {\n    (void)key; (void)now_ms;\n    return 0;\n}\n\nvoid expire_sweep(long long now_ms) { (void)now_ms; }\nvoid expire_clear(void) {}\n`);
      write(cwd, "tests/test_expire_table.c", `#include "expire_table.h"\n#include <assert.h>\n#include <string.h>\n\nint main(void) {\n    expire_clear();\n    expire_set("session", "abc", 100, 0);\n    assert(strcmp(expire_get("session", 50), "abc") == 0);\n    assert(expire_get("session", 101) == 0);\n\n    expire_set("live", "yes", 100, 200);\n    expire_set("dead", "no", 10, 200);\n    expire_sweep(250);\n    assert(strcmp(expire_get("live", 250), "yes") == 0);\n    assert(expire_get("dead", 250) == 0);\n    return 0;\n}\n`);
    },
  };
}

function complexCpythonCUnicodeRegressionCase(): WorkflowEvalCase {
  return {
    id: "complex-cpython-c-unicode-regression",
    kind: "bugfix",
    suite: "complex",
    title: "CPython-inspired C unicode trim regression",
    prompt: "Corrige ascii_trim en C inspirado en CPython: debe recortar solo whitespace ASCII de bordes y preservar bytes UTF-8 internos sin truncarlos. Deja make test pasando.",
    sourceProfile: realOssProfile("CPython", "unicodeobject.c", "C string helpers"),
    expected: {
      requiredFiles: ["Makefile", "include/ascii_trim.h", "src/ascii_trim.c", "tests/test_ascii_trim.c"],
      requiredContent: [
        check("src/ascii_trim.c", "trims ascii whitespace without mutating utf8 bytes", ["ascii_trim", "isspace|ASCII|unsigned char", "memmove|memcpy|start|end", "len"], 46),
        check("tests/test_ascii_trim.c", "tests edge trim and utf8 preservation", ["ascii_trim", "caf|é|UTF|utf8", "hello\\\\t|leading|trailing|spaces|tabs", "assert|strcmp"], 36),
      ],
      finalAnswerPatterns: ["src/ascii_trim.c", "tests/test_ascii_trim.c", "make test"],
      maxFiles: 8,
      maxDurationMs: 75_000,
      validation: { runTests: true, allowSkip: false },
    },
    setup(cwd) {
      writeCMakeProject(cwd, "test_ascii_trim", "src/ascii_trim.c tests/test_ascii_trim.c");
      write(cwd, "include/ascii_trim.h", `#pragma once\n\nvoid ascii_trim(char *value);\n`);
      write(cwd, "src/ascii_trim.c", `#include "ascii_trim.h"\n#include <string.h>\n\nvoid ascii_trim(char *value) {\n    size_t len = strlen(value);\n    if (len > 0 && value[len - 1] == ' ') value[len - 1] = '\\0';\n}\n`);
      write(cwd, "tests/test_ascii_trim.c", `#include "ascii_trim.h"\n#include <assert.h>\n#include <string.h>\n\nint main(void) {\n    char a[] = "  hello\\t";\n    ascii_trim(a);\n    assert(strcmp(a, "hello") == 0);\n\n    char b[] = "  café au lait  ";\n    ascii_trim(b);\n    assert(strcmp(b, "café au lait") == 0);\n    return 0;\n}\n`);
    },
  };
}

function complexLlvmCppDiagnosticPlanCase(): WorkflowEvalCase {
  return {
    id: "complex-llvm-cpp-diagnostic-plan",
    kind: "review-only",
    suite: "complex",
    title: "LLVM-inspired C++ diagnostic ownership planning",
    prompt: "En esta base C++ inspirada en LLVM/Clang, haz un analisis profundo de arquitectura para mover la responsabilidad de formateo de diagnostics fuera de Parser.cpp hacia DiagnosticEngine sin cambiar comportamiento. No implementes codigo: actualiza docs/diagnostic-refactor-plan.md con mapa de dependencias, plan por etapas, riesgos y pruebas.",
    sourceProfile: realOssProfile("LLVM/Clang", "C++ parser diagnostics", "large compiler refactors"),
    expected: {
      requiredFiles: ["docs/diagnostic-refactor-plan.md", "include/DiagnosticEngine.h", "lib/Parser.cpp", "lib/DiagnosticEngine.cpp"],
      requiredContent: [
        check("docs/diagnostic-refactor-plan.md", "maps parser diagnostic ownership", ["Parser\\.cpp", "DiagnosticEngine", "format|formatting|formate", "ownership|responsabilidad", "dependency|dependencia|acopla|coupling"], 46),
        check("docs/diagnostic-refactor-plan.md", "includes staged plan risks and validation", ["stage|etapa|paso", "risk|riesgo", "test|validaci", "golden|snapshot|regression|regresi[oó]n", "rollback|compat"], 34),
      ],
      forbiddenFiles: ["lib/*Test.cpp", "tests/*"],
      finalAnswerPatterns: ["docs/diagnostic-refactor-plan.md", "DiagnosticEngine", "Parser.cpp"],
      maxFiles: 10,
      maxDurationMs: 75_000,
      validation: { runTests: false, allowSkip: true },
      orchestration: {
        requireChalinRoute: true,
        requireGentleSubagent: true,
        rationale: "Large refactor planning across parser and diagnostics ownership should exercise routed analysis.",
      },
    },
    setup(cwd) {
      write(cwd, "include/DiagnosticEngine.h", `#pragma once\n#include <string>\n\nclass DiagnosticEngine {\npublic:\n  void report(int line, const std::string &message);\n};\n`);
      write(cwd, "lib/DiagnosticEngine.cpp", `#include "DiagnosticEngine.h"\n#include <iostream>\n\nvoid DiagnosticEngine::report(int line, const std::string &message) {\n  std::cerr << line << ": " << message << "\\n";\n}\n`);
      write(cwd, "lib/Parser.cpp", `#include "DiagnosticEngine.h"\n#include <sstream>\n\nvoid parseToken(DiagnosticEngine &diag, int line, const char *token) {\n  std::ostringstream message;\n  message << "unexpected token '" << token << "'";\n  diag.report(line, message.str());\n}\n`);
      write(cwd, "docs/diagnostic-refactor-plan.md", "# Diagnostic refactor plan\n\nTODO: plan ownership migration.\n");
    },
  };
}

function communityProfile(...inspiredBy: string[]): WorkflowEvalCase["sourceProfile"] {
  return { kind: "community-inspired", inspiredBy, privateData: false };
}

function realOssProfile(...inspiredBy: string[]): WorkflowEvalCase["sourceProfile"] {
  return { kind: "real-oss-inspired", inspiredBy, privateData: false };
}

function writeBaseBunProject(cwd: string): void {
  write(cwd, "package.json", JSON.stringify({
    name: "workflow-eval-fixture",
    private: true,
    type: "module",
    scripts: { test: "bun test" },
  }, null, 2));
  write(cwd, "tsconfig.json", JSON.stringify({ compilerOptions: { target: "ES2022", module: "NodeNext", moduleResolution: "NodeNext", strict: true, noEmit: true, allowImportingTsExtensions: true }, include: ["src/**/*.ts", "test/**/*.ts"] }, null, 2));
}

function writeCMakeProject(cwd: string, target: string, sources: string): void {
  write(cwd, "Makefile", `CC ?= cc\nCFLAGS ?= -std=c11 -Wall -Wextra -Werror -Iinclude\n\n.PHONY: test clean\n\ntest: tests/${target}\n\t./tests/${target}\n\ntests/${target}: ${sources} include/*.h\n\t$(CC) $(CFLAGS) -o $@ ${sources}\n\nclean:\n\trm -f tests/${target}\n`);
}

function check(file: string, label: string, patterns: string[], points: number): RequiredContentCheck {
  return { file, label, patterns, points };
}

function forbid(file: string, label: string, patterns: string[], penalty: number, promptMustMention?: string[]): ForbiddenContentCheck {
  return { file, label, patterns, penalty, promptMustMention };
}

function write(cwd: string, relativePath: string, content: string): void {
  const file = path.join(cwd, relativePath);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content.trimStart());
}
