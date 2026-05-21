import * as fs from "node:fs";
import * as path from "node:path";

export type DiscoveryEntryType = "file" | "dir" | "symlink" | "other";

export interface DiscoveryEntry {
  path: string;
  type: DiscoveryEntryType;
  depth: number;
  ext?: string;
  sizeBytes?: number;
  childCount?: number;
}

export interface ProjectDiscoveryIndex {
  version: 1;
  createdAt: string;
  cwd: string;
  entries: DiscoveryEntry[];
  truncated: boolean;
  ignoredDirs: string[];
  extensionHistogram: Record<string, number>;
  shallowFiles: string[];
  configLikeFiles: string[];
  testLikeFiles: string[];
}

export interface ProjectDiscoveryOptions {
  maxDepth?: number;
  maxEntries?: number;
  maxChildrenPerDir?: number;
}

const DEFAULT_MAX_DEPTH = 4;
const DEFAULT_MAX_ENTRIES = 450;
const DEFAULT_MAX_CHILDREN_PER_DIR = 120;
const IGNORED_DIRS = new Set([
  ".git",
  ".hg",
  ".svn",
  ".pi-mesh",
  "node_modules",
  "vendor",
  "dist",
  "build",
  "coverage",
  ".next",
  ".nuxt",
  ".turbo",
  "target",
  "__pycache__",
]);

export function buildProjectDiscoveryIndex(cwdInput: string, options: ProjectDiscoveryOptions = {}): ProjectDiscoveryIndex {
  const cwd = path.resolve(cwdInput);
  const maxDepth = options.maxDepth ?? DEFAULT_MAX_DEPTH;
  const maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
  const maxChildrenPerDir = options.maxChildrenPerDir ?? DEFAULT_MAX_CHILDREN_PER_DIR;
  const entries: DiscoveryEntry[] = [];
  const ignoredDirs = new Set<string>();
  let truncated = false;

  const queue: Array<{ relativePath: string; depth: number }> = [{ relativePath: "", depth: 0 }];
  while (queue.length > 0 && entries.length < maxEntries) {
    const current = queue.shift()!;
    const absolute = path.join(cwd, current.relativePath);
    const children = safeReaddir(absolute).slice(0, maxChildrenPerDir);
    if (children.length === maxChildrenPerDir) truncated = true;

    for (const child of children) {
      if (entries.length >= maxEntries) {
        truncated = true;
        break;
      }
      const relativePath = path.join(current.relativePath, child).replaceAll(path.sep, "/");
      const childAbsolute = path.join(cwd, relativePath);
      const stat = safeLstat(childAbsolute);
      if (!stat) continue;
      const type = entryType(stat);
      const depth = current.depth + 1;
      if (type === "dir" && IGNORED_DIRS.has(child)) {
        ignoredDirs.add(relativePath);
        continue;
      }
      const entry: DiscoveryEntry = {
        path: relativePath,
        type,
        depth,
        ...(type === "file" ? { ext: fileExt(child), sizeBytes: stat.size } : {}),
        ...(type === "dir" ? { childCount: safeReaddir(childAbsolute).length } : {}),
      };
      entries.push(entry);
      if (type === "dir" && depth < maxDepth) queue.push({ relativePath, depth });
    }
  }
  if (queue.length > 0) truncated = true;

  const files = entries.filter((entry) => entry.type === "file");
  return {
    version: 1,
    createdAt: new Date().toISOString(),
    cwd,
    entries,
    truncated,
    ignoredDirs: [...ignoredDirs].sort(),
    extensionHistogram: extensionHistogram(files),
    shallowFiles: files.filter((entry) => entry.depth <= 2).map((entry) => entry.path).slice(0, 80),
    configLikeFiles: files.filter((entry) => isConfigLike(entry.path)).map((entry) => entry.path).slice(0, 80),
    testLikeFiles: files.filter((entry) => isTestLike(entry.path)).map((entry) => entry.path).slice(0, 80),
  };
}

export function formatProjectDiscoveryIndex(index: ProjectDiscoveryIndex): string {
  const dirs = index.entries.filter((entry) => entry.type === "dir").map((entry) => `${entry.path}/`).slice(0, 100);
  const files = index.entries.filter((entry) => entry.type === "file").map((entry) => entry.path).slice(0, 160);
  const histogram = Object.entries(index.extensionHistogram)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 18)
    .map(([ext, count]) => `${ext}:${count}`)
    .join(", ");
  return [
    "Project discovery index (raw, non-semantic):",
    `- cwd: ${index.cwd}`,
    `- entries: ${index.entries.length}${index.truncated ? " (truncated)" : ""}`,
    index.ignoredDirs.length ? `- ignored dirs: ${index.ignoredDirs.join(", ")}` : undefined,
    histogram ? `- extension histogram: ${histogram}` : undefined,
    dirs.length ? `- directories: ${dirs.join(", ")}` : undefined,
    index.shallowFiles.length ? `- shallow files: ${index.shallowFiles.join(", ")}` : undefined,
    index.configLikeFiles.length ? `- config-like files: ${index.configLikeFiles.join(", ")}` : undefined,
    index.testLikeFiles.length ? `- test-like files: ${index.testLikeFiles.join(", ")}` : undefined,
    files.length ? `- sampled files: ${files.join(", ")}` : undefined,
    "Guidance: treat this as an index only. Infer project architecture from reading evidence files, not from path names alone.",
  ].filter((line): line is string => Boolean(line)).join("\n");
}

function safeReaddir(dir: string): string[] {
  try {
    return fs.readdirSync(dir).sort((a, b) => a.localeCompare(b));
  } catch {
    return [];
  }
}

function safeLstat(filePath: string): fs.Stats | undefined {
  try {
    return fs.lstatSync(filePath);
  } catch {
    return undefined;
  }
}

function entryType(stat: fs.Stats): DiscoveryEntryType {
  if (stat.isSymbolicLink()) return "symlink";
  if (stat.isDirectory()) return "dir";
  if (stat.isFile()) return "file";
  return "other";
}

function fileExt(fileName: string): string {
  const ext = path.extname(fileName).toLowerCase();
  return ext || "[none]";
}

function extensionHistogram(files: DiscoveryEntry[]): Record<string, number> {
  const result: Record<string, number> = {};
  for (const file of files) result[file.ext ?? "[none]"] = (result[file.ext ?? "[none]"] ?? 0) + 1;
  return result;
}

function isConfigLike(filePath: string): boolean {
  const base = path.basename(filePath).toLowerCase();
  return /(^|[.-])(config|rc|lock|workspace|manifest|project|settings|schema)([.-]|$)/.test(base)
    || ["makefile", "dockerfile", "readme.md", "agents.md", "package.json", "go.mod", "cargo.toml", "pyproject.toml", "pom.xml", "build.gradle", "composer.json", "gemfile"].includes(base)
    || /\.(ya?ml|toml|json|ini|env|properties)$/i.test(base);
}

function isTestLike(filePath: string): boolean {
  return /(^|\/)(test|tests|spec|__tests__|e2e)(\/|$)/i.test(filePath)
    || /(?:^|[._-])(test|spec)\.[a-z0-9]+$/i.test(path.basename(filePath));
}
