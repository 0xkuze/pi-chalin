import assert from "node:assert/strict";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { test } from "vitest";
import { setChalinStatus } from "../src/ui/ui-status.ts";

test("setChalinStatus removes the pi footer status instead of rendering it", () => {
  const updates: Array<{ key: string; value: string | undefined }> = [];
  const ctx = {
    hasUI: true,
    ui: {
      setStatus(key: string, value: string | undefined) {
        updates.push({ key, value });
      },
    },
  } as unknown as Pick<ExtensionContext, "hasUI" | "ui">;

  setChalinStatus(ctx, { kind: "running", intent: "scout", agent: "reviewer", completed: 1, total: 5 });

  assert.deepEqual(updates, [{ key: "pi-chalin", value: undefined }]);
});
