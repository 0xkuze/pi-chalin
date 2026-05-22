<p align="center">
  <img src="assets/pi-chalin-banner.png" alt="pi-chalin banner" width="100%" />
</p>

<p align="center">
  <a href="package.json"><img alt="version" src="https://img.shields.io/badge/version-0.1.0-111111?style=for-the-badge"></a>
  <a href="package.json"><img alt="license" src="https://img.shields.io/badge/license-MIT-0f766e?style=for-the-badge"></a>
  <a href="package.json"><img alt="bun" src="https://img.shields.io/badge/bun-%3E%3D1.3.14-111111?style=for-the-badge&logo=bun&logoColor=white"></a>
  <a href="package.json"><img alt="typescript" src="https://img.shields.io/badge/typescript-5.7-3178c6?style=for-the-badge&logo=typescript&logoColor=white"></a>
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

The important distinction: `pi-chalin` is the package name; `mesh` is still the workflow concept and command surface. That is why commands and tools use names like `/mesh` and `mesh_route`.

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
| Routing | Direct execution for bounded work, mesh workflows for broad or risky work. |
| Subagents | Built-in `scout`, `planner`, `worker`, `reviewer`, `researcher`, `delegate`, `oracle`, `context-builder`, and `conflict-resolver` agents. |
| Topologies | `single`, `chain`, `parallel`, `dag`, and `memory-only` workflow shapes. |
| Memory | Local records, candidates, approval/rejection, deduplication, revisions, and FTS-backed search. |
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
bun install
```

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

Once Pi loads the package, use `/mesh` inside a Pi session.

## Commands

| Command | Purpose |
| --- | --- |
| `/mesh` | Open the Smart Panel. |
| `/mesh on` | Enable autonomous routing for the current project. |
| `/mesh off` | Disable autonomous routing for the current project. |
| `/mesh agents` | Open the agent manager. |
| `/mesh memory` | Review memory records and pending candidates. |
| `/mesh memory <query>` | Search local memory. |
| `/mesh artifacts` | Open artifact and resumable task context. |
| `/mesh artifacts <feature>` | Resume context for a specific feature artifact. |
| `/mesh activity` | Inspect the active or latest run. |
| `/mesh web` | Open the web fetch audit panel. |
| `/mesh status` | Print routing, autonomy, safety, agent, memory, and guard status. |

## Tools

The extension registers tools that the primary Pi agent can call when a prompt needs orchestration instead of direct execution.

| Tool | Purpose |
| --- | --- |
| `mesh_route` | Run a selected workflow with concrete agents, topology, risk, memory, and artifact needs. |
| `mesh_interview` | Ask blocking clarification questions before planning or running agents. |
| `mesh_web_search` | Search or fetch web context through the audited web layer. |
| `mesh_artifact_resume` | Load resumable task context from stored artifacts. |
| `mesh_resume` | Resume the latest paused or stale mesh run. |

Child agents also receive guarded internal tools, such as `mesh_project_discovery`, `mesh_project_snapshot`, `mesh_artifact_write`, and `mesh_web_search`, according to their capabilities and budget.

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

Core modules:

```txt
src/index.ts              extension registration
src/commands.ts           /mesh command tree
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
  -> direct answer, mesh_interview, mesh_resume, or mesh_route
  -> MeshKernel
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
~/.pi/mesh/agents/*.md   user agents
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

User-level configuration and agents currently live under `~/.pi/mesh/`. That path is part of the Pi mesh workflow namespace, not the package name.

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
