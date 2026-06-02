import * as fs from "node:fs";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { buildProjectDiscoveryIndex, formatProjectDiscoveryIndex, type ProjectDiscoveryIndex, type ProjectDiscoveryOptions } from "./discovery.ts";
import { resolveChalinPaths, type ChalinPathsOptions } from "../config/paths.ts";

export interface ProjectSnapshot extends ProjectDiscoveryIndex {
  cacheKey: string;
  git?: {
    branch?: string;
    head?: string;
    changedFiles: string[];
    recentCommits: string[];
  };
}

export function buildProjectSnapshot(options: ChalinPathsOptions & ProjectDiscoveryOptions & { maxAgeMs?: number }): ProjectSnapshot {
  const cwd = path.resolve(options.cwd ?? process.cwd());
  const index = buildProjectDiscoveryIndex(cwd, {
    maxDepth: options.maxDepth,
    maxEntries: options.maxEntries,
    maxChildrenPerDir: options.maxChildrenPerDir,
  });
  const snapshot: ProjectSnapshot = {
    ...index,
    cacheKey: stableHash(JSON.stringify(index.entries)),
    git: gitSnapshot(cwd),
  };
  writeLatestSnapshotCache({ cwd }, snapshot);
  return snapshot;
}

export function formatProjectSnapshot(snapshot: ProjectSnapshot): string {
  return [
    formatProjectDiscoveryIndex(snapshot),
    snapshot.git?.branch ? `- git: ${snapshot.git.branch} @ ${snapshot.git.head ?? "unknown"}` : undefined,
    snapshot.git?.changedFiles.length ? `- changed files: ${snapshot.git.changedFiles.slice(0, 12).join(", ")}` : undefined,
    snapshot.git?.recentCommits.length ? `- recent commits: ${snapshot.git.recentCommits.slice(0, 5).join(" | ")}` : undefined,
  ].filter((line): line is string => Boolean(line)).join("\n");
}

export function projectSnapshotCachePath(options: ChalinPathsOptions): string {
  return path.join(resolveChalinPaths(options).projectRoot, ".pi-chalin", "cache", "project-snapshot.json");
}

function writeLatestSnapshotCache(options: ChalinPathsOptions, snapshot: ProjectSnapshot): void {
  const cachePath = projectSnapshotCachePath(options);
  try {
    fs.mkdirSync(path.dirname(cachePath), { recursive: true });
    fs.writeFileSync(cachePath, `${JSON.stringify(snapshot, null, 2)}\n`, "utf-8");
  } catch {
    // Snapshot caching is an optimization; the live inventory remains authoritative.
  }
}

function gitSnapshot(cwd: string): ProjectSnapshot["git"] | undefined {
  if (!fs.existsSync(path.join(cwd, ".git"))) return undefined;
  const branch = git(cwd, ["branch", "--show-current"]).trim() || undefined;
  const head = git(cwd, ["rev-parse", "--short", "HEAD"]).trim() || undefined;
  const changedFiles = git(cwd, ["diff", "--name-status", "HEAD~1...HEAD"]).trim().split("\n").filter(Boolean).slice(0, 20);
  const recentCommits = git(cwd, ["log", "--oneline", "-5"]).trim().split("\n").filter(Boolean);
  return { branch, head, changedFiles, recentCommits };
}

function git(cwd: string, args: string[]): string {
  const result = spawnSync("git", args, { cwd, encoding: "utf-8", timeout: 2500 });
  return result.status === 0 ? result.stdout : "";
}

function stableHash(input: string): string {
  let hash = 5381;
  for (let index = 0; index < input.length; index++) hash = (hash * 33) ^ input.charCodeAt(index);
  return (hash >>> 0).toString(16);
}
