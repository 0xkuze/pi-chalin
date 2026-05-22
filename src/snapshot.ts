import * as fs from "node:fs";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { resolveMeshPaths, type MeshPathsOptions } from "./paths.ts";

export interface ProjectSnapshot {
  version: 1;
  createdAt: string;
  cwd: string;
  cacheKey: string;
  stack: string[];
  signals: string[];
  packageManagers: string[];
  testCommands: string[];
  buildCommands: string[];
  entrypoints: string[];
  highSignalFiles: string[];
  git?: {
    branch?: string;
    head?: string;
    changedFiles: string[];
    recentCommits: string[];
  };
}

interface StackSignal {
  file: string;
  stack: string;
  packageManager?: string;
  testCommands?: string[];
  buildCommands?: string[];
}

const STACK_SIGNALS: StackSignal[] = [
  { file: "package.json", stack: "node" },
  { file: "go.mod", stack: "go", testCommands: ["go test ./..."], buildCommands: ["go build ./..."] },
  { file: "Cargo.toml", stack: "rust", packageManager: "cargo", testCommands: ["cargo test"], buildCommands: ["cargo build"] },
  { file: "pyproject.toml", stack: "python", packageManager: "python", testCommands: ["pytest"], buildCommands: ["python -m build"] },
  { file: "requirements.txt", stack: "python", packageManager: "python", testCommands: ["pytest"] },
  { file: "pom.xml", stack: "java", packageManager: "maven", testCommands: ["mvn test"], buildCommands: ["mvn package"] },
  { file: "build.gradle", stack: "java", packageManager: "gradle", testCommands: ["gradle test"], buildCommands: ["gradle build"] },
  { file: "Gemfile", stack: "ruby", packageManager: "bundler", testCommands: ["bundle exec rspec"] },
  { file: "composer.json", stack: "php", packageManager: "composer", testCommands: ["composer test"] },
  { file: "Makefile", stack: "make" },
];

const HIGH_SIGNAL_ROOT_FILES = [
  "README.md",
  "AGENTS.md",
  "Makefile",
  "Taskfile.yml",
  "Dockerfile",
  "docker-compose.yml",
  "package.json",
  "go.mod",
  "Cargo.toml",
  "pyproject.toml",
  "pom.xml",
  "build.gradle",
  "tsconfig.json",
  "vite.config.ts",
  "vitest.config.ts",
  "next.config.js",
  "nuxt.config.ts",
];

const ENTRYPOINT_DIRS = ["cmd", "src", "app", "pages", "components", "internal", "pkg", "lib", "server", "api"];
const TEST_DIRS = ["test", "tests", "__tests__", "spec", "e2e"];

export function buildProjectSnapshot(options: MeshPathsOptions & { maxAgeMs?: number }): ProjectSnapshot {
  const cwd = path.resolve(options.cwd ?? process.cwd());
  const cachePath = projectSnapshotCachePath({ cwd });
  const cacheKey = computeCacheKey(cwd);
  const maxAgeMs = options.maxAgeMs ?? snapshotMaxAgeMs();
  const cached = readCachedSnapshot(cachePath);
  if (cached && cached.cacheKey === cacheKey && Date.now() - Date.parse(cached.createdAt) <= maxAgeMs) return cached;

  const snapshot = createProjectSnapshot(cwd, cacheKey);
  fs.mkdirSync(path.dirname(cachePath), { recursive: true });
  fs.writeFileSync(cachePath, `${JSON.stringify(snapshot, null, 2)}\n`, "utf-8");
  return snapshot;
}

export function formatProjectSnapshot(snapshot: ProjectSnapshot): string {
  return [
    `stack: ${snapshot.stack.join(", ") || "unknown"}`,
    `signals: ${snapshot.signals.slice(0, 12).join(", ") || "none"}`,
    snapshot.packageManagers.length ? `package managers: ${snapshot.packageManagers.join(", ")}` : undefined,
    snapshot.testCommands.length ? `test commands: ${snapshot.testCommands.join(" | ")}` : undefined,
    snapshot.buildCommands.length ? `build commands: ${snapshot.buildCommands.join(" | ")}` : undefined,
    snapshot.git?.branch ? `git: ${snapshot.git.branch} @ ${snapshot.git.head ?? "unknown"}` : undefined,
    snapshot.git?.changedFiles.length ? `changed files: ${snapshot.git.changedFiles.slice(0, 10).join(", ")}` : undefined,
    snapshot.git?.recentCommits.length ? `recent commits: ${snapshot.git.recentCommits.slice(0, 5).join(" | ")}` : undefined,
    snapshot.entrypoints.length ? `entrypoints: ${snapshot.entrypoints.slice(0, 10).join(", ")}` : undefined,
    snapshot.highSignalFiles.length ? `high-signal files: ${snapshot.highSignalFiles.slice(0, 12).join(", ")}` : undefined,
  ].filter((line): line is string => Boolean(line)).join("\n");
}

export function projectSnapshotCachePath(options: MeshPathsOptions): string {
  return path.join(resolveMeshPaths(options).projectRoot, ".pi-chalin", "cache", "project-snapshot.json");
}

function createProjectSnapshot(cwd: string, cacheKey: string): ProjectSnapshot {
  const rootEntries = safeReaddir(cwd);
  const rootFiles = new Set(rootEntries.filter((entry) => safeStat(path.join(cwd, entry))?.isFile()));
  const rootDirs = new Set(rootEntries.filter((entry) => safeStat(path.join(cwd, entry))?.isDirectory()));
  const stack = new Set<string>();
  const signals = new Set<string>();
  const packageManagers = new Set<string>();
  const testCommands = new Set<string>();
  const buildCommands = new Set<string>();

  for (const signal of STACK_SIGNALS) {
    if (!rootFiles.has(signal.file)) continue;
    stack.add(signal.stack);
    signals.add(signal.file);
    if (signal.packageManager) packageManagers.add(signal.packageManager);
    for (const command of signal.testCommands ?? []) testCommands.add(command);
    for (const command of signal.buildCommands ?? []) buildCommands.add(command);
  }

  if (rootFiles.has("package.json")) addPackageJsonSignals(cwd, stack, packageManagers, testCommands, buildCommands);
  for (const lock of ["bun.lock", "bun.lockb", "pnpm-lock.yaml", "yarn.lock", "package-lock.json"]) {
    if (rootFiles.has(lock)) signals.add(lock);
  }

  const entrypoints = discoverEntrypoints(cwd, rootDirs);
  const highSignalFiles = discoverHighSignalFiles(cwd, rootFiles, rootDirs);
  return {
    version: 1,
    createdAt: new Date().toISOString(),
    cwd,
    cacheKey,
    stack: [...stack].sort(),
    signals: [...signals].sort(),
    packageManagers: [...packageManagers].sort(),
    testCommands: [...testCommands].slice(0, 8),
    buildCommands: [...buildCommands].slice(0, 8),
    entrypoints,
    highSignalFiles,
    git: gitSnapshot(cwd),
  };
}

function addPackageJsonSignals(cwd: string, stack: Set<string>, packageManagers: Set<string>, testCommands: Set<string>, buildCommands: Set<string>): void {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(cwd, "package.json"), "utf-8")) as {
      scripts?: Record<string, string>;
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
      packageManager?: string;
    };
    const deps = new Set(Object.keys({ ...(parsed.dependencies ?? {}), ...(parsed.devDependencies ?? {}) }));
    for (const dep of deps) {
      if (["vue", "nuxt", "react", "next", "svelte", "astro"].includes(dep)) stack.add(dep);
      if (["vitest", "jest", "playwright"].includes(dep)) stack.add(dep);
      if (dep === "typescript") stack.add("typescript");
    }
    const manager = parsed.packageManager?.split("@")[0];
    packageManagers.add(manager || packageManagerFromLock(cwd) || "npm");
    for (const [name] of Object.entries(parsed.scripts ?? {})) {
      if (/^(test|test:|vitest|jest)/.test(name)) testCommands.add(`${manager || "npm"} run ${name}`);
      if (/^(build|typecheck|lint)$/.test(name)) buildCommands.add(`${manager || "npm"} run ${name}`);
    }
  } catch {
    stack.add("node");
    packageManagers.add(packageManagerFromLock(cwd) || "npm");
  }
}

function packageManagerFromLock(cwd: string): string | undefined {
  if (fs.existsSync(path.join(cwd, "bun.lock")) || fs.existsSync(path.join(cwd, "bun.lockb"))) return "bun";
  if (fs.existsSync(path.join(cwd, "pnpm-lock.yaml"))) return "pnpm";
  if (fs.existsSync(path.join(cwd, "yarn.lock"))) return "yarn";
  if (fs.existsSync(path.join(cwd, "package-lock.json"))) return "npm";
  return undefined;
}

function discoverEntrypoints(cwd: string, rootDirs: Set<string>): string[] {
  const candidates = [
    "main.go",
    "cmd/*/main.go",
    "src/index.ts",
    "src/index.js",
    "src/main.ts",
    "src/main.js",
    "app/page.tsx",
    "pages/index.vue",
    "server/index.ts",
  ];
  const found = new Set<string>();
  for (const pattern of candidates) {
    if (pattern.includes("*")) {
      const [prefix, suffix] = pattern.split("*") as [string, string];
      const dir = path.join(cwd, prefix);
      for (const entry of safeReaddir(dir)) {
        const candidate = path.join(prefix, entry, suffix).replaceAll(path.sep, "/");
        if (fs.existsSync(path.join(cwd, candidate))) found.add(candidate);
      }
    } else if (fs.existsSync(path.join(cwd, pattern))) found.add(pattern);
  }
  for (const dir of ENTRYPOINT_DIRS) {
    if (!rootDirs.has(dir)) continue;
    for (const entry of safeReaddir(path.join(cwd, dir)).slice(0, 5)) found.add(path.join(dir, entry).replaceAll(path.sep, "/"));
  }
  return [...found].slice(0, 16);
}

function discoverHighSignalFiles(cwd: string, rootFiles: Set<string>, rootDirs: Set<string>): string[] {
  const result = new Set<string>();
  for (const file of HIGH_SIGNAL_ROOT_FILES) if (rootFiles.has(file)) result.add(file);
  for (const dir of [...ENTRYPOINT_DIRS, ...TEST_DIRS, "docs", ".github"]) {
    if (!rootDirs.has(dir)) continue;
    result.add(`${dir}/`);
    for (const entry of safeReaddir(path.join(cwd, dir)).slice(0, 5)) result.add(path.join(dir, entry).replaceAll(path.sep, "/"));
  }
  return [...result].slice(0, 32);
}

function gitSnapshot(cwd: string): ProjectSnapshot["git"] | undefined {
  if (!fs.existsSync(path.join(cwd, ".git"))) return undefined;
  const branch = git(cwd, ["branch", "--show-current"]).trim() || undefined;
  const head = git(cwd, ["rev-parse", "--short", "HEAD"]).trim() || undefined;
  const changedFiles = git(cwd, ["diff", "--name-status", "HEAD~1...HEAD"]).trim().split("\n").filter(Boolean).slice(0, 20);
  const recentCommits = git(cwd, ["log", "--oneline", "-5"]).trim().split("\n").filter(Boolean);
  return { branch, head, changedFiles, recentCommits };
}

function computeCacheKey(cwd: string): string {
  const parts = [
    git(cwd, ["rev-parse", "HEAD"]).trim(),
    ...HIGH_SIGNAL_ROOT_FILES.map((file) => `${file}:${mtime(path.join(cwd, file))}`),
    ...STACK_SIGNALS.map((signal) => `${signal.file}:${mtime(path.join(cwd, signal.file))}`),
  ];
  return stableHash(parts.join("|"));
}

function git(cwd: string, args: string[]): string {
  const result = spawnSync("git", args, { cwd, encoding: "utf-8", timeout: 2500 });
  return result.status === 0 ? result.stdout : "";
}

function readCachedSnapshot(cachePath: string): ProjectSnapshot | undefined {
  try {
    const parsed = JSON.parse(fs.readFileSync(cachePath, "utf-8")) as ProjectSnapshot;
    return parsed.version === 1 ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function safeReaddir(dir: string): string[] {
  try {
    return fs.readdirSync(dir).filter((entry) => !["node_modules", ".git", ".pi-chalin", "dist", "coverage"].includes(entry));
  } catch {
    return [];
  }
}

function safeStat(filePath: string): fs.Stats | undefined {
  try {
    return fs.statSync(filePath);
  } catch {
    return undefined;
  }
}

function mtime(filePath: string): number {
  return safeStat(filePath)?.mtimeMs ?? 0;
}

function snapshotMaxAgeMs(): number {
  const parsed = Number(process.env.PI_CHALIN_SNAPSHOT_MAX_AGE_MS);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 10 * 60 * 1000;
}

function stableHash(input: string): string {
  let hash = 5381;
  for (let index = 0; index < input.length; index++) hash = (hash * 33) ^ input.charCodeAt(index);
  return (hash >>> 0).toString(16);
}
