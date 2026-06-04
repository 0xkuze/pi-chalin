import assert from "node:assert/strict";
import { test } from "vitest";
import { shouldScheduleFinalToolShutdown } from "../src/tools/tool-output.ts";

test("final tool shutdown is opt-in so print-mode synthesis is not aborted", () => {
  const previous = process.env.PI_CHALIN_NONINTERACTIVE_SHUTDOWN;
  try {
    delete process.env.PI_CHALIN_NONINTERACTIVE_SHUTDOWN;
    assert.equal(shouldScheduleFinalToolShutdown({ hasUI: false, shutdown: () => undefined }), false);

    process.env.PI_CHALIN_NONINTERACTIVE_SHUTDOWN = "1";
    assert.equal(shouldScheduleFinalToolShutdown({ hasUI: false, shutdown: () => undefined }), true);
  } finally {
    if (previous === undefined) delete process.env.PI_CHALIN_NONINTERACTIVE_SHUTDOWN;
    else process.env.PI_CHALIN_NONINTERACTIVE_SHUTDOWN = previous;
  }
});
