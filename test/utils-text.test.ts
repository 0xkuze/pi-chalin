import assert from "node:assert/strict";
import { test } from "vitest";
import { compactText } from "../src/utils/text.ts";

test("compactText normalizes whitespace and trims before ellipsis", () => {
  assert.equal(compactText("alpha   beta\n gamma", 12), "alpha beta…");
});

test("compactText handles very small limits without leaking text", () => {
  assert.equal(compactText("alpha", 1), "…");
  assert.equal(compactText("alpha", 0), "");
});
