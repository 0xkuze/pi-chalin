import assert from "node:assert/strict";
import { test } from "vitest";
import { buildChalinOrchestratorSystemPrompt } from "../src/orchestration/orchestration.ts";
import type { AgentDefinition } from "../src/domain/schemas.ts";

const agents: AgentDefinition[] = [
  {
    name: "scout",
    description: "map local evidence",
    concern: "recon",
    scope: "built-in",
    model: "inherit",
    thinking: "low",
    tools: ["read", "grep", "find", "ls"],
    capabilities: ["inspect-files"],
    memory: { read: true, write: "never", categories: [] },
    sourcePath: "agents/scout.md",
    systemPrompt: "Scout prompt.",
    diagnostics: [],
  },
];

test("orchestrator forbids web as a substitute for repository evidence", () => {
  const prompt = buildChalinOrchestratorSystemPrompt(agents);

  assert.match(prompt, /Do not use web as a substitute for local repository evidence/);
  assert.match(prompt, /delegate a read-only `chalin_route` instead/);
  assert.match(prompt, /Do not call `chalin_route` and `chalin_web_search` in the same assistant turn/);
});
