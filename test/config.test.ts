import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, test } from "vitest";
import { loadEffectiveConfig, setAgentThinkingOverride } from "../src/config/config.ts";

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) fs.rmSync(tempDirs.pop()!, { recursive: true, force: true });
});

function tempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function writeJson(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf-8");
}

test("config merge order is defaults then project then user", () => {
  const cwd = tempDir("pi-chalin-cwd-");
  const userRoot = tempDir("pi-chalin-user-");
  writeJson(path.join(cwd, ".pi-chalin", "config.json"), { enabled: false, autonomy: "low" });
  writeJson(path.join(userRoot, "config.json"), { autonomy: "high" });

  const loaded = loadEffectiveConfig({ cwd, userRoot });
  assert.equal(loaded.config.enabled, false);
  assert.equal(loaded.config.autonomy, "high");
});

test("safety keeps mandatory guards while allowing explicit approval prompts", () => {
  const cwd = tempDir("pi-chalin-cwd-");
  const userRoot = tempDir("pi-chalin-user-");
  writeJson(path.join(userRoot, "config.json"), {
    safety: {
      approvalRiskThreshold: "high",
      recursionGuard: false,
      singleWriterGuard: false,
      mutationExpectationGuard: false,
    },
  });

  const loaded = loadEffectiveConfig({ cwd, userRoot });
  assert.equal(loaded.config.safety.approvalRiskThreshold, "high");
  assert.equal(loaded.config.safety.recursionGuard, true);
  assert.equal(loaded.config.safety.singleWriterGuard, true);
  assert.equal(loaded.config.safety.mutationExpectationGuard, true);
  assert.ok(loaded.diagnostics.some((line) => line.includes("Safety non-downgrade enforced")));
});

test("config supports explicit no-approval threshold", () => {
  const cwd = tempDir("pi-chalin-cwd-");
  writeJson(path.join(cwd, ".pi-chalin", "config.json"), {
    safety: {
      approvalRiskThreshold: "none",
    },
  });

  const loaded = loadEffectiveConfig({ cwd });

  assert.equal(loaded.config.safety.approvalRiskThreshold, "none");
});

test("config persists and validates per-agent thinking overrides", () => {
  const cwd = tempDir("pi-chalin-cwd-");
  setAgentThinkingOverride({ cwd }, "built-in/reviewer", "high", "project");
  writeJson(path.join(cwd, ".pi-chalin", "config.json"), {
    agents: {
      thinkingOverrides: {
        "built-in/reviewer": "high",
        "built-in/scout": "huge",
      },
    },
  });

  const loaded = loadEffectiveConfig({ cwd });

  assert.equal(loaded.config.agents.thinkingOverrides["built-in/reviewer"], "high");
  assert.equal(loaded.config.agents.thinkingOverrides["built-in/scout"], undefined);
  assert.match(loaded.diagnostics.join("\n"), /Invalid agents.thinkingOverrides/);
});

test("config validates memory provider and engram settings", () => {
  const cwd = tempDir("pi-chalin-cwd-");
  const userRoot = tempDir("pi-chalin-user-");
  writeJson(path.join(userRoot, "config.json"), {
    memory: {
      provider: "cloud-brain",
      engram: {
        baseUrl: "",
        command: "",
        autoStart: "yes",
        autoSync: "yes",
        syncThrottleMs: -1,
        timeoutMs: 42,
        project: 123,
      },
    },
  });

  const loaded = loadEffectiveConfig({ cwd, userRoot });

  assert.equal(loaded.config.memory.provider, "auto");
  assert.equal(loaded.config.memory.engram.baseUrl, "http://127.0.0.1:7437");
  assert.equal(loaded.config.memory.engram.command, "engram");
  assert.equal(loaded.config.memory.engram.autoStart, false);
  assert.equal(loaded.config.memory.engram.autoSync, true);
  assert.equal(loaded.config.memory.engram.syncThrottleMs, 30_000);
  assert.equal(loaded.config.memory.engram.timeoutMs, 800);
  assert.equal(loaded.config.memory.engram.project, undefined);
  assert.match(loaded.diagnostics.join("\n"), /Invalid memory\.provider/);
});

test("config validates skill policy toggles and stale window", () => {
  const cwd = tempDir("pi-chalin-cwd-");
  writeJson(path.join(cwd, ".pi-chalin", "config.json"), {
    skills: {
      staleAfterDays: 400,
      autoActivation: "yes",
    },
  });

  const loaded = loadEffectiveConfig({ cwd });

  assert.equal(loaded.config.skills.staleAfterDays, 30);
  assert.equal(loaded.config.skills.autoActivation, true);
  assert.match(loaded.diagnostics.join("\n"), /Invalid skills\.staleAfterDays/);
  assert.match(loaded.diagnostics.join("\n"), /Invalid skills\.autoActivation/);
});
