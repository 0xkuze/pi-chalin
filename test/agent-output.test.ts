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
