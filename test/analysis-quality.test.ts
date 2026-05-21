import assert from "node:assert/strict";
import { test } from "node:test";
import { getAnalysisFacts, scoreAnalysisAnswer } from "../src/analysis-quality.ts";

test("scoreAnalysisAnswer rewards accurate deep-project coverage over length", () => {
  const shallow = [
    "Engram is a local-first memory system for AI agents.",
    "It uses SQLite and FTS, has MCP, HTTP server, plugins, TUI and optional cloud.",
    "The architecture centers on a local store.",
  ].join("\n");

  const accurate = [
    "Engram is a local-first memory system for coding agents.",
    "The local source of truth is SQLite with FTS5 in internal/store.",
    "It exposes MCP tools such as mem_save, mem_search, mem_context, mem_judge, mem_compare and mem_doctor.",
    "It also has a local HTTP API with sessions, observations, search, prompts, context, conflicts and sync status routes.",
    "The CLI includes engram mcp, serve, tui, save, search, context, sync, cloud, conflicts, projects, setup, doctor and obsidian-export.",
    "Local Git sync writes .engram/manifest.json and compressed .engram/chunks/*.jsonl.gz chunks.",
    "Cloud is optional replication with Postgres-backed cloudstore, cloudserver, autosync, remote client, auth and dashboard rendered with templ/HTMX.",
    "Project detection lives in internal/project and resolves cwd, .engram/config.json, git root, origin and similarity.",
    "Semantic conflict surfacing uses FTS/BM25 candidates plus judged relations like conflicts_with, supersedes and compatible.",
    "Obsidian support lives in internal/obsidian and plugin/obsidian.",
    "The stack is Go 1.25, modernc.org/sqlite, pgx/v5, Bubbletea/Lipgloss, templ and HTMX.",
    "Validation evidence: go test ./... passes.",
  ].join("\n");

  const shallowScore = scoreAnalysisAnswer(shallow);
  const accurateScore = scoreAnalysisAnswer(accurate);

  assert.equal(shallowScore.pass, false);
  assert.equal(accurateScore.pass, true);
  assert.ok(accurateScore.score > shallowScore.score + 30, `${accurateScore.score} should clearly beat ${shallowScore.score}`);
  assert.equal(accurateScore.hallucinationPenalty, 0);
});

test("scoreAnalysisAnswer penalizes confident hallucinations", () => {
  const hallucinated = [
    "Engram is a React and Next.js app backed by MongoDB and Redis.",
    "It has Kubernetes services and no tests.",
    "It uses SQLite with FTS5.",
  ].join("\n");

  const result = scoreAnalysisAnswer(hallucinated);

  assert.equal(result.pass, false);
  assert.ok(result.hallucinationPenalty < 0);
  assert.ok(result.matchedHallucinations.length >= 3);
});

test("scoreAnalysisAnswer supports non-Engram synthetic project profiles", () => {
  const goService = [
    "This is a Go HTTP service with entrypoint cmd/api/main.go.",
    "It exposes routes GET /health, POST /v1/auth/refresh and GET /v1/orders.",
    "The domain is split across internal/domain, internal/http and internal/postgres adapters.",
    "Postgres migrations live in migrations/001_init.sql and configuration uses DATABASE_URL, JWT_SECRET and PORT.",
    "Tests run with go test ./... and cover refresh-token behavior.",
  ].join("\n");

  const frontendApp = [
    "This is a Vite React TypeScript frontend with src/main.tsx and src/App.tsx.",
    "Routing uses React Router with /login, /dashboard and /settings.",
    "State and API access live in src/lib/api.ts and src/features/auth/useSession.ts.",
    "Tests run with Vitest and React Testing Library.",
    "The build scripts are npm run dev, npm run build and npm run test.",
  ].join("\n");

  assert.equal(scoreAnalysisAnswer(goService, { profile: "go-service" }).pass, true);
  assert.equal(scoreAnalysisAnswer(frontendApp, { profile: "frontend-app" }).pass, true);
  assert.equal(scoreAnalysisAnswer(frontendApp, { profile: "go-service" }).pass, false);
  assert.ok(getAnalysisFacts("monorepo").length > 0);
});

test("scoreAnalysisAnswer does not punish scoped test coverage gaps as no-test hallucinations", () => {
  const answer = [
    "This Go HTTP service has cmd/api/main.go and routes GET /health, POST /v1/auth/refresh and GET /v1/orders.",
    "It uses internal/domain, internal/http and internal/postgres with Postgres migrations in migrations/001_init.sql.",
    "Configuration uses DATABASE_URL, JWT_SECRET and PORT.",
    "Tests run with go test ./... and routes_test.go covers refresh-token behavior.",
    "Coverage risk: there are no tests for the /v1/orders handler yet.",
  ].join("\n");

  const result = scoreAnalysisAnswer(answer, { profile: "go-service" });

  assert.equal(result.pass, true);
  assert.deepEqual(result.matchedHallucinations, []);
});
