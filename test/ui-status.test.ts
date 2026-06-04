import assert from "node:assert/strict";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { test } from "vitest";
import { setChalinStatus } from "../src/ui/ui-status.ts";

test("setChalinStatus renders the pi footer status", () => {
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

  assert.deepEqual(updates, [{ key: "pi-chalin", value: "chalin scout 1/5 reviewer" }]);
});

test("setChalinStatus does nothing when UI is unavailable", () => {
  const updates: Array<{ key: string; value: string | undefined }> = [];
  const ctx = {
    hasUI: false,
    ui: {
      setStatus(key: string, value: string | undefined) {
        updates.push({ key, value });
      },
    },
  } as unknown as Pick<ExtensionContext, "hasUI" | "ui">;

  setChalinStatus(ctx, { kind: "idle" });

  assert.deepEqual(updates, []);
});
