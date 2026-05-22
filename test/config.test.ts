import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, test } from "node:test";
import { loadEffectiveConfig, setAgentThinkingOverride } from "../src/config.ts";

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

test("safety non-downgrade prevents disabling mandatory guards", () => {
  const cwd = tempDir("pi-chalin-cwd-");
  const userRoot = tempDir("pi-chalin-user-");
  writeJson(path.join(userRoot, "config.json"), {
    safety: {
      approvalRiskThreshold: "critical",
      recursionGuard: false,
      singleWriterGuard: false,
      mutationExpectationGuard: false,
    },
  });

  const loaded = loadEffectiveConfig({ cwd, userRoot });
  assert.equal(loaded.config.safety.approvalRiskThreshold, "medium");
  assert.equal(loaded.config.safety.recursionGuard, true);
  assert.equal(loaded.config.safety.singleWriterGuard, true);
  assert.equal(loaded.config.safety.mutationExpectationGuard, true);
  assert.ok(loaded.diagnostics.some((line) => line.includes("Safety non-downgrade enforced")));
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
