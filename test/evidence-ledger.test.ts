import assert from "node:assert/strict";
import { test } from "vitest";
import { buildEvidenceLedger } from "../src/runtime/evidence-ledger.ts";
import type { InlineToolEvent } from "../src/runtime/inline-policy.ts";

test("evidence ledger records raw reads, writes, commands, and mutation order", () => {
  const events: InlineToolEvent[] = [
    { phase: "completed", toolName: "read", path: "tests/test_parser.py", observation: "def test_existing_surface():\n    fixture = transform_full_record()" },
    { phase: "completed", toolName: "edit", path: "src/parser.py", argsText: JSON.stringify({ path: "src/parser.py", edits: [{ oldText: "old", newText: "broad fix" }] }) },
    { phase: "completed", toolName: "bash", command: "python - <<'PY'\nprint('probe')\nPY", observation: "probe passed on minimal input" },
    { phase: "completed", toolName: "bash", command: "pytest tests/test_parser.py", isError: true, observation: "pytest could not import project dependency" },
    { phase: "completed", toolName: "edit", path: "src/parser.py", argsText: JSON.stringify({ path: "src/parser.py", edits: [{ oldText: "broad fix", newText: "narrow fix" }] }) },
  ];

  const ledger = buildEvidenceLedger(events);

  assert.deepEqual(ledger.changedPaths, ["src/parser.py"]);
  assert.deepEqual(ledger.readPaths, ["tests/test_parser.py"]);
  assert.equal(ledger.latestMutationIndex, 4);
  assert.equal(ledger.evidenceAfterLatestMutation, false);
  assert.deepEqual(ledger.mutationRecords.map((record) => [record.path, record.afterFailedCommand, record.args?.includes("fix")]), [
    ["src/parser.py", false, true],
    ["src/parser.py", true, true],
  ]);
  assert.deepEqual(ledger.commandRecords, [
    {
      command: "python - <<'PY'\nprint('probe')\nPY",
      status: "pass",
      afterLatestMutation: false,
    },
    {
      command: "pytest tests/test_parser.py",
      status: "fail",
      afterLatestMutation: false,
    },
  ]);
  assert.deepEqual(ledger.failedCommandsAfterMutation, [{
    command: "pytest tests/test_parser.py",
    status: "fail",
    afterLatestMutation: false,
  }]);
  assert.deepEqual(ledger.failedPostMutationCommands, []);
  assert.equal(ledger.postFailureMutationRecords.length, 1);
  assert.equal(ledger.postFailureMutationRecords[0]?.path, "src/parser.py");
  assert.deepEqual(ledger.observations, [
    {
      toolName: "read",
      status: "pass",
      afterLatestMutation: false,
      path: "tests/test_parser.py",
      text: "def test_existing_surface():\n    fixture = transform_full_record()",
    },
    {
      toolName: "bash",
      status: "pass",
      afterLatestMutation: false,
      command: "python - <<'PY'\nprint('probe')\nPY",
      text: "probe passed on minimal input",
    },
    {
      toolName: "bash",
      status: "fail",
      afterLatestMutation: false,
      command: "pytest tests/test_parser.py",
      text: "pytest could not import project dependency",
    },
  ]);
});

test("evidence ledger leaves command meaning to the semantic judge", () => {
  const events: InlineToolEvent[] = [
    { phase: "completed", toolName: "edit", argsText: JSON.stringify({ path: "./src/main.ts" }) },
    { phase: "completed", toolName: "bash", command: "any-runner --with-project-specific-flags" },
  ];

  const ledger = buildEvidenceLedger(events);

  assert.deepEqual(Object.keys(ledger.commandRecords[0] ?? {}).sort(), ["afterLatestMutation", "command", "status"]);
  assert.equal(ledger.commandRecords[0]?.command, "any-runner --with-project-specific-flags");
});

test("evidence ledger compacts observations while keeping both context edges", () => {
  const observation = `${"a".repeat(2_500)}\nimportant middle\n${"z".repeat(2_500)}`;
  const ledger = buildEvidenceLedger([
    { phase: "completed", toolName: "read", path: "fixtures/large.txt", observation },
  ]);

  const text = ledger.observations[0]?.text ?? "";
  assert.equal(text.length <= 4_000, true);
  assert.equal(text.startsWith("a"), true);
  assert.equal(text.endsWith("z"), true);
  assert.equal(text.includes("observation compacted"), true);
});
