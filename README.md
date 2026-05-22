<p align="center">
  <a href="package.json"><img alt="version" src="https://img.shields.io/badge/version-0.1.0-111111?style=for-the-badge"></a>
  <a href="package.json"><img alt="license" src="https://img.shields.io/badge/license-MIT-0f766e?style=for-the-badge"></a>
  <a href="package.json"><img alt="bun" src="https://img.shields.io/badge/bun-%3E%3D1.3.14-111111?style=for-the-badge&logo=bun&logoColor=white"></a>
  <a href="package.json"><img alt="typescript" src="https://img.shields.io/badge/typescript-6.0-3178c6?style=for-the-badge&logo=typescript&logoColor=white"></a>
  <a href="package.json"><img alt="status" src="https://img.shields.io/badge/status-MVP-2563eb?style=for-the-badge"></a>
</p>

<h1 align="center">pi-chalin</h1>

<p align="center">
  A Pi Coding Agent extension for routed, memory-aware subagent workflows.
</p>

<p align="center">
  <a href="#what-it-does">What It Does</a> ·
  <a href="#quick-start">Quick Start</a> ·
  <a href="#commands">Commands</a> ·
  <a href="#architecture">Architecture</a> ·
  <a href="#development">Development</a>
</p>

---

## What It Does

`pi-chalin` adds a coordination layer to Pi Coding Agent. It keeps simple prompts direct, but routes broad, risky, or memory-sensitive work through focused subagents when that extra structure improves the result.

Use it when a task benefits from:

- deeper repository discovery before implementation;
- isolated planning, execution, and review roles;
- resumable long-running work;
- local memory with explicit review;
- visible routing, safety, and runtime state in the Pi TUI;
- audited web context for current external information.

## Capabilities

| Area | What pi-chalin provides |
| --- | --- |
| Routing | Direct execution for bounded work, chalin workflows for broad or risky work. |
| Subagents | Built-in `scout`, `planner`, `worker`, `reviewer`, `researcher`, `delegate`, `oracle`, `context-builder`, and `conflict-resolver` agents. |
| Topologies | `single`, `chain`, `parallel`, `dag`, and `memory-only` workflow shapes. |
| Memory | Configurable local or Engram-backed records, candidates, deduplication, revisions, and search. |
| Artifacts | Resumable checkpoints, validation contracts, interviews, and handoffs. |
| Safety | Approval thresholds, autonomy modes, recursion guards, single-writer isolation, stale-run recovery, and mutation checks. |
| TUI | Smart Panel, agent manager, activity monitor, memory review, artifact panel, and web fetch audit. |
| Evaluation | Orchestration, memory, trace, trajectory, mutation, and workflow quality evaluators. |

## Current Status

This is an MVP package, but it is not a sketch. The repository includes the extension entrypoint, command registration, tool registration, routing kernel, agent catalog, memory store, artifact support, web fetch support, worktree isolation, runtime guards, evaluators, and tests for the main behaviors.

The README is the canonical project overview in this repository. Historical design docs are not currently checked into the tree, so the documentation below sticks to the code and files that actually exist.

## Quick Start

### Requirements

- Bun `>=1.3.14`
- Pi Coding Agent runtime

### Install

```bash
bun add pi-chalin
```

For local development in this repository, run `bun install`.

### Verify

```bash
bun run typecheck
bun run test
```

### Load In Pi

`pi-chalin` is exposed as a Pi extension through `package.json`:

```json
{
  "pi": {
    "extensions": ["./src/index.ts"]
  }
}
```

Once Pi loads the package, use `/chalin` inside a Pi session.

## Commands

| Command | Purpose |
| --- | --- |
| `/chalin` | Open the Smart Panel. |
| `/chalin on` | Enable autonomous routing for the current project. |
| `/chalin off` | Disable autonomous routing for the current project. |
| `/chalin agents` | Open the agent manager. |
| `/chalin memory` | Review memory records and pending candidates. |
| `/chalin memory <query>` | Search the configured memory backend. |
| `/chalin artifacts` | Open artifact and resumable task context. |
| `/chalin artifacts <feature>` | Resume context for a specific feature artifact. |
| `/chalin activity` | Inspect the active or latest run. |
| `/chalin web` | Open the web fetch audit panel. |
| `/chalin settings` | Choose the memory provider: `auto`, `engram`, or `pi-chalin` local. |
| `/chalin status` | Print routing, autonomy, safety, agent, memory, and guard status. |

## Tools

The extension registers tools that the primary Pi agent can call when a prompt needs orchestration instead of direct execution.

| Tool | Purpose |
| --- | --- |
| `chalin_route` | Run a selected workflow with concrete agents, topology, risk, memory, and artifact needs. |
| `chalin_interview` | Ask blocking clarification questions before planning or running agents. |
| `chalin_web_search` | Search or fetch web context through the audited web layer. |
| `chalin_memory_search` | Retrieve compact durable memory during direct or routed work. |
| `chalin_memory_write` | Save durable project or user knowledge through WriteGuard. |
| `chalin_memory_revise` | Correct stale or inaccurate memory with evidence. |
| `chalin_artifact_resume` | Load resumable task context from stored artifacts. |
| `chalin_resume` | Resume the latest paused or stale chalin run. |

Child agents also receive guarded internal tools, such as `chalin_project_discovery`, `chalin_project_snapshot`, `chalin_artifact_write`, `chalin_memory_search`, `chalin_memory_write`, `chalin_memory_revise`, and `chalin_web_search`, according to their capabilities and budget.

## Architecture

`pi-chalin` is intentionally a modular monolith. That is the right foundation here: clear module boundaries without premature service boundaries.

```txt
Package
  assets/                 banner and packaged image assets
  agents/                 built-in agent definitions
  src/                    extension source
  test/                   Bun test coverage
  evals/                  quality and behavior evaluators
```

The npm package ships only runtime extension source, built-in agents, and this README. Tests, evaluators, and local assets stay in the repository to keep installation small.

Core modules:

```txt
src/index.ts              extension registration
src/commands.ts           /chalin command tree
src/tools.ts              Pi tool definitions
src/autoroute.ts          prompt-time routing nudges
src/kernel.ts             route validation and orchestration
src/runner.ts             mock and SDK-backed worker execution
src/agents.ts             built-in, project, and user agent catalog
src/config.ts             config, autonomy, safety, and overrides
src/memory.ts             memory records, candidates, and search
src/artifacts.ts          resumable task state and handoffs
src/webfetch.ts           audited external context
src/worktrees.ts          isolated writer worktrees
src/ui.ts                 TUI surfaces and notifications
src/schemas.ts            shared route, run, agent, and memory types
```

Runtime flow:

```txt
Prompt
  -> Pi primary agent
  -> direct answer, chalin_interview, chalin_resume, or chalin_route
  -> ChalinKernel
  -> config and safety checks
  -> memory and artifact context
  -> agent resolution
  -> worker runner
  -> output parsing
  -> artifact and memory capture
  -> TUI status and final response
```

## Agent Model

Agents are Markdown files with YAML frontmatter. They can come from three scopes:

```txt
agents/*.md              built-in package agents
.pi-chalin/agents/*.md   project agents
~/.pi/chalin/agents/*.md   user agents
```

Resolution order:

```txt
name             -> project/name, then user/name, then built-in/name
project/name     -> project only
user/name        -> user only
built-in/name    -> built-in only
```

Project agents win locally, user agents remain portable across projects, and built-ins provide the default catalog.

## Runtime Storage

Project-local runtime files live under `.pi-chalin/`:

```txt
.pi-chalin/config.json
.pi-chalin/agents/
.pi-chalin/artifacts/
.pi-chalin/cache/
.pi-chalin/memory.sqlite
.pi-chalin/runs/
```

Memory can run against pi-chalin's local SQLite store or Engram. Configure it in `.pi-chalin/config.json` or through `/chalin settings`:

```json
{
  "memory": {
    "provider": "auto",
    "engram": {
      "baseUrl": "http://127.0.0.1:7437",
      "command": "engram",
      "autoStart": false,
      "autoSync": true,
      "syncThrottleMs": 30000,
      "timeoutMs": 800
    }
  }
}
```

`auto` uses Engram when the HTTP service is reachable and falls back to local memory. `engram` uses Engram as the memory source for `/chalin memory`; the `baseUrl` may point at any Engram local-runtime-compatible endpoint, including a remote `engram serve` instance. Engram Cloud is supported through Engram's local-first sync model: run `engram serve` against a cloud-enrolled/synced Engram store, then point pi-chalin at that runtime. When `autoSync` is enabled and the configured Engram runtime is local, pi-chalin checks `/sync/status` and runs the official `engram sync --cloud --import --project <project>` before reads, then `engram sync --cloud --project <project>` after writes. This uses `ENGRAM_CLOUD_TOKEN` from the runtime environment and never persists the token.

If the user already has `gentle-pi`/`gentle-engram` working, pi-chalin reuses that Engram runtime. No MCP bootstrap command is required from pi-chalin: choose `engram` in `/chalin settings`, and pi-chalin will use `ENGRAM_URL`, `ENGRAM_PORT`, `ENGRAM_BIN`, the default `http://127.0.0.1:7437` runtime, and Engram's own project detection. If Engram Cloud is enrolled and the Pi process has `ENGRAM_CLOUD_TOKEN`, reads automatically import pending cloud chunks before listing/searching memory.

When Engram is the active/preferred memory provider, `/chalin memory` lists Engram observations only, including project and personal scopes returned by Engram. pi-chalin does not expose its local `approve`/`reject` review flow in that mode. If the user selects `pi-chalin local`, the local SQLite memory store keeps its existing pending-review, approve, reject, delete, search, and revise behavior.

User-level configuration and agents currently live under `~/.pi/chalin/`. That path is part of the Pi chalin workflow namespace, not the package name.

## Environment Variables

Common runtime and evaluation switches use the `PI_CHALIN_` prefix:

```txt
PI_CHALIN_DISABLED
PI_CHALIN_CHILD
PI_CHALIN_RUNNER
PI_CHALIN_MOCK_STEP_DELAY_MS
PI_CHALIN_WORKFLOW_MODEL
PI_CHALIN_WORKFLOW_THINKING
PI_CHALIN_WORKFLOW_GATES
```

See `package.json` and the evaluator files under `evals/` for the full set used by development scripts.

## Development

Useful scripts:

```bash
bun run test
bun run typecheck
bun run eval
bun run eval:all
bun run eval:workflow
bun run eval:workflow:matrix
```

The fast confidence path is:

```bash
bun run typecheck
bun run test
```

The broader evaluator path is intentionally heavier. Use it when changing routing, runtime policy, child-tool budgets, memory behavior, or workflow scoring.

The test script runs Bun's test runner directly, so `bun test` and `bun run test` exercise the same suite.

## Design Principles

- Route only when routing helps.
- Keep the human in command.
- Make autonomy observable.
- Prefer local memory with review.
- Treat safety gates as product behavior, not plumbing.
- Keep the architecture modular before splitting boundaries.
- Verify with tests and evaluators, not intuition.

## License

MIT. See [`package.json`](package.json) for the current package metadata.
