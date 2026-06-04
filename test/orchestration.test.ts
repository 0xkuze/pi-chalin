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
  assert.match(prompt, /do not treat same-turn web search as forbidden/i);
  assert.match(prompt, /materially resolves a docs\/API\/package\/community gap/i);
});

test("orchestrator delegates intent instead of selecting topology or subagents", () => {
  const prompt = buildChalinOrchestratorSystemPrompt(agents);

  assert.match(prompt, /pass the task intent/i);
  assert.doesNotMatch(prompt, /Use `topology=sequential`/);
  assert.doesNotMatch(prompt, /Pick subagents/);
});

test("orchestrator requires the same completion gate for inline and delegated work", () => {
  const prompt = buildChalinOrchestratorSystemPrompt(agents);

  assert.equal(prompt.includes("## Completion Gate"), true);
  assert.equal(prompt.includes("whether Primary Pi worked inline or delegated through pi-chalin"), true);
  assert.equal(prompt.includes("can_finalize"), true);
  assert.equal(prompt.includes("Do not use keyword matching"), true);
});

test("orchestrator favors delegation when scope cannot fit one compact loop", () => {
  const prompt = buildChalinOrchestratorSystemPrompt(agents);

  assert.match(prompt, /Before using repository tools inline/i);
  assert.match(prompt, /single concrete scope/i);
  assert.match(prompt, /clearly bounded verification path/i);
  assert.match(prompt, /delegate first/i);
  assert.doesNotMatch(prompt, /if prompt contains/i);
  assert.match(prompt, /Do not choose from keywords, regex-like matching/i);
});

test("orchestrator resolves uncertainty before finalization without hidden post-final work", () => {
  const prompt = buildChalinOrchestratorSystemPrompt(agents);
  const currentYear = new Date().getFullYear();
  const previousYear = currentYear - 1;

  assert.match(prompt, new RegExp(`${currentYear}`));
  assert.match(prompt, new RegExp(`${previousYear}`));
  assert.match(prompt, /before finalizing/i);
  assert.match(prompt, /ask the user/i);
  assert.match(prompt, /current or previous year/i);
  assert.match(prompt, /Do not rely on a hidden follow-up after the final answer/i);
});

test("orchestrator does not interview for discoverable docs or hypothetical fallback choices", () => {
  const prompt = buildChalinOrchestratorSystemPrompt(agents);

  assert.match(prompt, /Do not interview for permission to read docs/i);
  assert.match(prompt, /package metadata/i);
  assert.match(prompt, /Do not ask hypothetical fallback questions/i);
  assert.match(prompt, /resume the same chalin run/i);
});
