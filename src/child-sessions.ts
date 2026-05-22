import * as fs from "node:fs";
import * as path from "node:path";
import { type ExtensionContext, SessionManager } from "@earendil-works/pi-coding-agent";
import { resolveChalinPaths } from "./paths.ts";
import type { RunStepState } from "./schemas.ts";

const CHILD_SESSION_SCOPE = "pi-chalin";
const LEGACY_CHILD_SESSION_ARCHIVE = ".pi-chalin-hidden-child-sessions";

export interface ChildSessionDirOptions {
  cwd: string;
  runId: string;
  stepId: string;
  agent: string;
  parentSessionFile?: string;
}

export interface ChildSessionManagerOptions {
  cwd: string;
  runId: string;
  step: RunStepState;
  extensionContext?: Pick<ExtensionContext, "sessionManager">;
}

export interface LegacyChildSessionCleanupResult {
  moved: string[];
  failed: string[];
}

export function chalinChildSessionRoot(options: Pick<ChildSessionDirOptions, "cwd" | "runId" | "parentSessionFile">): string {
  if (options.parentSessionFile) {
    const parentBaseName = path.basename(options.parentSessionFile, ".jsonl");
    return path.join(path.dirname(options.parentSessionFile), parentBaseName, CHILD_SESSION_SCOPE, safePathSegment(options.runId));
  }

  return path.join(resolveChalinPaths({ cwd: options.cwd }).projectRoot, ".pi-chalin", "child-sessions", safePathSegment(options.runId));
}

export function chalinChildSessionDir(options: ChildSessionDirOptions): string {
  return path.join(
    chalinChildSessionRoot(options),
    `${safePathSegment(options.stepId)}-${safePathSegment(options.agent)}`,
  );
}

export function createChalinChildSessionManager(options: ChildSessionManagerOptions): SessionManager {
  const parentSessionFile = options.extensionContext?.sessionManager.getSessionFile();
  const sessionDir = chalinChildSessionDir({
    cwd: options.cwd,
    runId: options.runId,
    stepId: options.step.id,
    agent: options.step.agent,
    parentSessionFile,
  });
  fs.mkdirSync(sessionDir, { recursive: true });

  const manager = SessionManager.create(options.cwd, sessionDir);
  if (parentSessionFile) manager.newSession({ parentSession: parentSessionFile });
  return manager;
}

export async function hideLegacyTopLevelChildSessions(ctx: Pick<ExtensionContext, "sessionManager">): Promise<LegacyChildSessionCleanupResult> {
  const sessionDir = ctx.sessionManager.getSessionDir();
  const currentSessionFile = ctx.sessionManager.getSessionFile();
  const sessions = await SessionManager.list(ctx.sessionManager.getCwd(), sessionDir);
  const result: LegacyChildSessionCleanupResult = { moved: [], failed: [] };

  for (const session of sessions) {
    if (session.path === currentSessionFile) continue;
    if (!isPiChalinChildSessionPreview(session.firstMessage)) continue;

    const destination = hiddenLegacyChildSessionPath(sessionDir, session.path);
    try {
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      fs.renameSync(session.path, destination);
      result.moved.push(destination);
    } catch {
      result.failed.push(session.path);
    }
  }

  return result;
}

export function isPiChalinChildSessionPreview(firstMessage: string): boolean {
  return /^You are pi-chalin [a-zA-Z0-9._-]+:/.test(firstMessage.trimStart());
}

function safePathSegment(value: string): string {
  const normalized = value
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  return normalized || "session";
}

function hiddenLegacyChildSessionPath(sessionDir: string, sourceFile: string): string {
  const sourceBaseName = path.basename(sourceFile, ".jsonl");
  const archiveDir = path.join(sessionDir, LEGACY_CHILD_SESSION_ARCHIVE, safePathSegment(sourceBaseName));
  let candidate = path.join(archiveDir, path.basename(sourceFile));
  let suffix = 1;
  while (fs.existsSync(candidate)) {
    candidate = path.join(archiveDir, `${sourceBaseName}-${suffix}.jsonl`);
    suffix += 1;
  }
  return candidate;
}
