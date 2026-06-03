import * as fs from "node:fs";
import * as path from "node:path";
import { type ExtensionContext, SessionManager } from "@earendil-works/pi-coding-agent";
import { resolveChalinPaths } from "../config/paths.ts";
import type { RunStepState } from "../domain/schemas.ts";

const CHILD_SESSION_SCOPE = "pi-chalin";

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

function safePathSegment(value: string): string {
  const normalized = value
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  return normalized || "session";
}
