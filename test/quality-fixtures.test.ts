import assert from "node:assert/strict";
import * as fs from "node:fs";
import { test } from "node:test";
import { createSyntheticQualityFixture } from "../evals/quality-fixtures.ts";

test("createSyntheticQualityFixture creates isolated projects for each profile", () => {
  const goFixture = createSyntheticQualityFixture("go-service");
  const frontendFixture = createSyntheticQualityFixture("frontend-app");
  const monorepoFixture = createSyntheticQualityFixture("monorepo");

  try {
    assert.equal(goFixture.profile, "go-service");
    assert.equal(fs.existsSync(`${goFixture.cwd}/cmd/api/main.go`), true);
    assert.match(goFixture.prompt, /profundidad/i);

    assert.equal(frontendFixture.profile, "frontend-app");
    assert.equal(fs.existsSync(`${frontendFixture.cwd}/src/main.tsx`), true);

    assert.equal(monorepoFixture.profile, "monorepo");
    assert.equal(fs.existsSync(`${monorepoFixture.cwd}/pnpm-workspace.yaml`), true);
  } finally {
    fs.rmSync(goFixture.cwd, { recursive: true, force: true });
    fs.rmSync(frontendFixture.cwd, { recursive: true, force: true });
    fs.rmSync(monorepoFixture.cwd, { recursive: true, force: true });
  }
});
