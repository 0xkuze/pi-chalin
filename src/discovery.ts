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
}

export interface ProjectDiscoveryOptions {
  maxDepth?: number;
  maxEntries?: number;
  maxChildrenPerDir?: number;
}

export interface ProjectDiscoveryFormatOptions {
  maxEntries?: number;
}

const DEFAULT_MAX_DEPTH = 4;
const DEFAULT_MAX_ENTRIES = 450;
const DEFAULT_MAX_CHILDREN_PER_DIR = 120;
const IGNORED_DIRS = new Set([
  ".git",
  ".hg",
  ".svn",
  ".pi-chalin",
  ".workflow-oracle",
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
      if (type === "dir" && isIgnoredDirName(child)) {
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
  };
}

function isIgnoredDirName(name: string): boolean {
  return IGNORED_DIRS.has(name) || name.startsWith(".workflow-shards-");
}

export function formatProjectDiscoveryIndex(index: ProjectDiscoveryIndex, options: ProjectDiscoveryFormatOptions = {}): string {
  const maxEntries = options.maxEntries ?? 220;
  const entries = index.entries.slice(0, maxEntries).map(formatDiscoveryEntry);
  const hiddenEntries = Math.max(0, index.entries.length - entries.length);
  const ignoredDirs = formatIgnoredDirs(index.ignoredDirs);
  const histogram = Object.entries(index.extensionHistogram)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 18)
    .map(([ext, count]) => `${ext}:${count}`)
    .join(", ");
  return [
    "Project discovery inventory (raw filesystem facts, non-semantic):",
    `- cwd: ${index.cwd}`,
    `- entries: ${index.entries.length}${index.truncated ? " (scan truncated)" : ""}${hiddenEntries ? `; showing ${entries.length}, ${hiddenEntries} omitted` : ""}`,
    ignoredDirs ? `- ignored dirs: ${ignoredDirs}` : undefined,
    histogram ? `- extension histogram: ${histogram}` : undefined,
    entries.length ? "- paths:\n" + entries.map((entry) => `  ${entry}`).join("\n") : undefined,
    "Guidance: inventory only; no stack/entrypoint/test/command/importance inference. Verify claims from exact files.",
  ].filter((line): line is string => Boolean(line)).join("\n");
}

function formatIgnoredDirs(ignoredDirs: string[]): string {
  if (ignoredDirs.length === 0) return "";
  const previewCount = 4;
  const preview = ignoredDirs.slice(0, previewCount).join(", ");
  const omitted = ignoredDirs.length - previewCount;
  return omitted > 0 ? `${preview}, ... ${omitted} more` : preview;
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

function formatDiscoveryEntry(entry: DiscoveryEntry): string {
  const marker: Record<DiscoveryEntryType, string> = {
    dir: "D",
    file: "F",
    symlink: "L",
    other: "O",
  };
  return `${marker[entry.type]} ${entry.path}`;
}
