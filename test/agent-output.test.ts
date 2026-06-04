import assert from "node:assert/strict";
import { test } from "vitest";
import { parseAgentOutput } from "../src/runner/agent-output.ts";

test("parseAgentOutput parses Reviewer Verdict for review contracts without requiring reviewer agent name", () => {
  const output = parseAgentOutput("audit-a", [
    "## Agent Handoff",
    JSON.stringify({
      summary: "Reviewed parser change.",
      changedFiles: [],
      verification: ["reviewed src/parser.ts"],
      evidenceClaims: [],
      risks: [],
      nextActions: [],
    }),
    "",
    "## Reviewer Verdict",
    JSON.stringify({
      verdict: "pass",
      blockingFindings: [],
      missingCoverage: [],
      evidence: ["reviewed src/parser.ts"],
      residualRisks: [],
      requiredRepair: "",
    }),
  ].join("\n"), { expectsReviewerVerdict: true });

  assert.equal(output.reviewerVerdict?.verdict, "pass");
  assert.equal(output.warnings.some((warning) => /did not include/i.test(warning)), false);
});

test("parseAgentOutput normalizes annotated changedFiles to clean workspace paths", () => {
  const output = parseAgentOutput("worker", [
    "## Agent Handoff",
    JSON.stringify({
      summary: "Aligned API config and tests.",
      changedFiles: [
        "apps/api/package.json (rewrite: Vite+ scripts)",
        "apps/api/vite.config.ts (new: test include for src + test)",
        { path: "apps/api/tsconfig.build.json", reason: "exclude generated config" },
      ],
      verification: ["vp run api#test passed"],
      evidenceClaims: [],
      risks: [],
      nextActions: [],
    }),
  ].join("\n"));

  assert.deepEqual(output.structuredHandoff?.changedFiles, [
    "apps/api/package.json",
    "apps/api/vite.config.ts",
    "apps/api/tsconfig.build.json",
  ]);
  assert.match(output.handoff ?? "", /Changed: apps\/api\/package\.json; apps\/api\/vite\.config\.ts; apps\/api\/tsconfig\.build\.json/);
});

test("parseAgentOutput compacts long evidence path verification entries", () => {
  const evidencePaths = Array.from({ length: 30 }, (_, index) => `apps/api/src/file-${index}.ts`).join(", ");
  const output = parseAgentOutput("scout", [
    "## Agent Handoff",
    JSON.stringify({
      summary: "Mapped the API workspace evidence.",
      changedFiles: [],
      verification: [`evidencePaths: ${evidencePaths}`],
      evidenceClaims: [],
      risks: [],
      nextActions: [],
    }),
  ].join("\n"));

  assert.match(output.handoff ?? "", /evidencePaths: apps\/api\/src\/file-0\.ts/);
  assert.match(output.handoff ?? "", /more/);
  assert.doesNotMatch(output.handoff ?? "", /file-29\.ts/);
  assert.ok((output.handoff ?? "").length < 900);
});
