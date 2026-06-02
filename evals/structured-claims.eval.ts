#!/usr/bin/env bun
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { finalAnswerMaterial } from "../src/routing/route-format.ts";
import { buildSdkPrompt, childToolNames } from "../src/runner/runner-prompt.ts";
import { parseAgentOutput } from "../src/runner/runner.ts";
import { createRunState } from "../src/runner/runner-state.ts";
import type { AgentDefinition, EvidenceClaim } from "../src/domain/schemas.ts";

interface EvalResult {
  id: string;
  pass: boolean;
  detail: string;
}

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const contextBuilder: AgentDefinition = {
  name: "context-builder",
  scope: "built-in",
  concern: "context-building",
  capabilities: ["inspect-files", "search-files", "memory-read", "memory-write"],
  description: "Synthesize evidence.",
  model: "inherit",
  tools: [],
  memory: { read: true, write: "candidate", categories: [] },
  systemPrompt: "",
  diagnostics: [],
};

const rawScoutOutput = [
  "## Findings",
  "- Exploracion parcial con lenguaje natural no normalizado.",
  "## Claim Ledger",
  "```json",
  JSON.stringify([
    {
      kind: "negative-claim",
      subject: "direct browser control capability",
      summary: "No direct browser control entrypoint was confirmed in the inspected surface.",
      evidence: [],
      confidence: 0.41,
    },
    {
      kind: "transient-status",
      subject: "regression suite",
      summary: "La suite quedo roja durante una observacion parcial.",
      evidence: ["partial observation"],
      evidenceKind: "partial",
      confidence: 0.5,
    },
  ]),
  "```",
  "## Memory Candidates",
  "- testing: La suite quedo roja durante una observacion parcial.",
  "- tooling: Project verification commands should be read from package.json before reporting exact invocations.",
].join("\n");

const scoutOutput = parseAgentOutput("scout", rawScoutOutput);
const claimAudit = (scoutOutput.claims ?? []).filter((claim) => claim.kind !== "stable-fact");
const prompt = buildSdkPrompt(contextBuilder, "Synthesize final answer material.", repoRoot, "Prior handoff.", 12, "normal", {
  previousClaims: claimAudit,
});
const tools = childToolNames(contextBuilder, "Synthesize final answer material.", true, true, {
  previousClaimsNeedAudit: claimAudit.length > 0,
});
const finalMaterial = materialFromClaims(claimAudit);

const results: EvalResult[] = [
  {
    id: "claim-ledger-json-parsed",
    pass: (scoutOutput.claims ?? []).length === 2,
    detail: `claims=${scoutOutput.claims?.length ?? 0}`,
  },
  {
    id: "transient-memory-dropped-by-structured-claim",
    pass: scoutOutput.memoryCandidates.length === 1 && scoutOutput.memoryCandidates[0]?.category === "tooling",
    detail: `memory=${scoutOutput.memoryCandidates.map((candidate) => candidate.category).join(",")}`,
  },
  {
    id: "audit-tools-enabled-from-metadata",
    pass: ["read", "grep", "find"].every((tool) => tools.includes(tool)),
    detail: `tools=${tools.join(",")}`,
  },
  {
    id: "prompt-carries-structured-audit",
    pass: /Structured claim audit/.test(prompt) && /direct browser control capability/.test(prompt),
    detail: `promptChars=${prompt.length}`,
  },
  {
    id: "final-material-preserves-claim-evidence",
    pass: /direct browser control capability/.test(finalMaterial) && /evidence: missing/.test(finalMaterial),
    detail: finalMaterial.slice(0, 180),
  },
];

const passed = results.filter((result) => result.pass).length;
const failed = results.length - passed;

console.log(`pi-chalin structured claims eval: ${passed}/${results.length} passed`);
for (const result of results) {
  console.log(`${result.pass ? "✓" : "✗"} ${result.id} · ${result.detail}`);
}
if (failed > 0) process.exit(1);

function materialFromClaims(claims: EvidenceClaim[]): string {
  const run = createRunState({
    kind: "multi-agent-dag",
    agents: ["scout", "context-builder"],
    risk: "low",
    ambiguity: "low",
    needsMemory: false,
    needsArtifacts: false,
    reason: "structured claim eval",
    plan: {
      kind: "dag",
      stages: [
        { id: "evidence", tasks: [{ agent: "scout", task: "Map evidence." }] },
        { id: "synthesis", tasks: [{ agent: "context-builder", task: "Synthesize." }] },
      ],
    },
  }, repoRoot);
  run.status = "complete";
  run.steps[0]!.status = "complete";
  run.steps[0]!.output = {
    agent: "scout",
    text: "Free-form notes without conventional evidence headings.",
    handoff: "Free-form notes without conventional evidence headings.",
    raw: "",
    memoryCandidates: [],
    warnings: [],
    claims,
  };
  run.steps[1]!.status = "complete";
  run.steps[1]!.output = {
    agent: "context-builder",
    text: "Final synthesis: preserve unresolved capability claims.",
    handoff: "Final synthesis: preserve unresolved capability claims.",
    raw: "",
    memoryCandidates: [],
    warnings: [],
  };
  return finalAnswerMaterial(run) ?? "";
}
