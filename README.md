<p align="center">
  <img src="assets/pi-chalin-banner.png" alt="Chalin banner" width="100%">
</p>

<p align="center">
  <a href="package.json"><img alt="version" src="https://img.shields.io/badge/version-0.3.1-111111?style=for-the-badge"></a>
  <a href="LICENSE"><img alt="license" src="https://img.shields.io/badge/license-MIT%20%2B%20Attribution-0f766e?style=for-the-badge"></a>
  <a href="package.json"><img alt="bun" src="https://img.shields.io/badge/bun-%3E%3D1.3.14-111111?style=for-the-badge&logo=bun&logoColor=white"></a>
  <a href="package.json"><img alt="typescript" src="https://img.shields.io/badge/typescript-6.0-3178c6?style=for-the-badge&logo=typescript&logoColor=white"></a>
</p>

<h1 align="center">Chalin</h1>

<p align="center">
  Routed, memory-aware subagent orchestration for Pi Coding Agent.
</p>

<p align="center">
  <a href="#why-chalin">Why Chalin</a> ·
  <a href="#features">Features</a> ·
  <a href="#quick-start">Quick Start</a> ·
  <a href="#commands">Commands</a> ·
  <a href="#configuration">Configuration</a> ·
  <a href="#development">Development</a>
</p>

---

## Why Chalin

Chalin is a Pi Coding Agent extension for work that benefits from deliberate coordination: broad repository analysis, risky edits, multi-step implementation, memory recall, and review-heavy workflows.

The extension keeps small prompts direct. When a task needs more structure, Chalin gives the primary Pi agent a guarded way to route work through focused subagents, preserve handoffs, use memory, and surface what is happening in the TUI.

The product goal is simple: keep the human in command while giving complex engineering work a reliable execution frame.

## Features

| Area | Capability |
| --- | --- |
| Routing | Direct execution for bounded work; routed workflows for broad, risky, or memory-sensitive work. |
| Subagents | Built-in `scout`, `planner`, `worker`, `reviewer`, `researcher`, `delegate`, `oracle`, `context-builder`, and `conflict-resolver` agents. |
| Workflow shapes | `single`, `chain`, `parallel`, `dag`, and `memory-only` plans. |
| Memory | Built-in SQLite memory with review, or native Engram memory with optional cloud sync. |
| Safety | Approval thresholds, critical-route blocking, recursion guards, single-writer protection, mutation expectation checks, and destructive-action confirmation. |
| State | Resumable runs, artifacts, validation contracts, activity monitoring, and cached discovery context. |
| TUI | Smart Panel, Settings, Agent Manager, Memory Review, Activity, Artifacts, and WebFetch audit panels. |

## Quick Start

### Requirements

- Bun `>=1.3.14`
- Pi Coding Agent runtime

### Install

```bash
pi install npm:pi-chalin
```

For local development in this repository:

```bash
bun install
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
| `/chalin settings` | Tune routing, safety approvals, memory provider, agent overrides, maintenance, and diagnostics. |
| `/chalin agents` | Inspect agents and override model or thinking settings. |
| `/chalin memory` | Review built-in memory records or Engram observations. |
| `/chalin memory <query>` | Search the configured memory backend. |
| `/chalin artifacts` | Open resumable task artifacts. |
| `/chalin artifacts <feature>` | Resume context for a named feature artifact. |
| `/chalin activity` | Inspect the active or latest run. |
| `/chalin web` | Review cached WebFetch bundles and freshness. |
| `/chalin status` | Print routing, autonomy, safety, memory, agent, and guard status. |

## Tools

The extension registers Pi tools for the primary agent. The primary agent stays in control; Chalin provides the execution frame when routing is useful.

| Tool | Purpose |
| --- | --- |
| `chalin_route` | Run a selected workflow with concrete agents, topology, risk, memory, and artifact needs. |
| `chalin_resume` | Resume the latest paused or stale Chalin run. |
| `chalin_interview` | Ask blocking clarification questions before planning or execution. |
| `chalin_memory_search` | Retrieve compact durable memory during direct or routed work. |
| `chalin_memory_write` | Save durable project or user knowledge through WriteGuard. |
| `chalin_memory_revise` | Correct stale or inaccurate memory with evidence. |
| `chalin_artifact_resume` | Load resumable task context from stored artifacts. |
| `chalin_web_search` | Search or fetch current web context through the audited web layer. |

Child agents receive only the guarded tools appropriate to their role, capability set, and budget.

## Configuration

Project configuration lives at:

```txt
.pi-chalin/config.json
```

User-level configuration and agents live under:

```txt
~/.pi/chalin/
```

Useful top-level settings:

```json
{
  "enabled": true,
  "autonomy": "balanced",
  "safety": {
    "approvalRiskThreshold": "medium"
  },
  "memory": {
    "provider": "auto"
  }
}
```

Use `/chalin settings` for the supported interactive path. It exposes:

- routing on/off and autonomy;
- safety approval threshold, including a no-prompt mode for non-critical routes;
- memory provider selection;
- agent override summary and Agent Manager access;
- maintenance for caches;
- diagnostics.

Critical routes remain blocked by the safety policy even when approval prompts are disabled.

## Memory

Chalin supports three memory modes:

| Provider | Behavior |
| --- | --- |
| `auto` | Uses Engram when reachable, otherwise falls back to built-in memory. |
| `engram` | Uses Engram as the source of truth for memory surfaces and tools. |
| `pi-chalin` | Uses the built-in SQLite memory store. The UI labels this mode as `built-in`. |

Built-in memory keeps the review workflow: pending candidates can be approved, rejected, revised, or deleted. Destructive memory actions require confirmation.

Engram mode uses Engram directly for memory listing, search, write, revise, and routed workflow context. When the configured Engram runtime is local and `autoSync` is enabled, Chalin can use Engram's local-first cloud sync path through the runtime environment.

Common Engram environment variables:

```txt
ENGRAM_URL
ENGRAM_PORT
ENGRAM_BIN
ENGRAM_CLOUD_TOKEN
PI_CHALIN_MEMORY_PROVIDER
```

## Agents

Agents are Markdown files with YAML frontmatter. They can come from three scopes:

```txt
agents/*.md                built-in package agents
.pi-chalin/agents/*.md     project agents
~/.pi/chalin/agents/*.md   user agents
```

Resolution order:

```txt
name             -> project/name, then user/name, then built-in/name
project/name     -> project only
user/name        -> user only
built-in/name    -> built-in only
```

Project agents win locally, user agents remain portable, and built-ins provide the default catalog.

## Architecture

Chalin is a modular monolith. The extension keeps runtime boundaries explicit without splitting the product into premature services.

```txt
src/index.ts              extension registration
src/commands.ts           /chalin command tree
src/tools.ts              Pi tool definitions
src/autoroute.ts          prompt-time routing guidance
src/kernel.ts             route validation and orchestration
src/runner.ts             worker execution, resume, and run metrics
src/agents.ts             agent catalog and resolution
src/config.ts             config, safety, autonomy, and overrides
src/memory.ts             built-in memory store
src/memory-provider.ts    built-in and Engram memory backends
src/artifacts.ts          resumable task state and handoffs
src/webfetch.ts           audited external context cache
src/worktrees.ts          isolated writer worktrees
src/ui.ts                 TUI panels and confirmations
src/schemas.ts            shared runtime types
```

Runtime state is project-local:

```txt
.pi-chalin/config.json
.pi-chalin/agents/
.pi-chalin/artifacts/
.pi-chalin/cache/
.pi-chalin/memory.sqlite
.pi-chalin/runs/
```

## Development

Fast verification:

```bash
bun run typecheck
bun run test
```

Focused evaluator scripts are available for routing, memory, trace, trajectory, and workflow quality work:

```bash
bun run eval
bun run eval:memory
bun run eval:trace
bun run eval:workflow
bun run eval:workflow:harness
bun run eval:workflow:complex
```

Use the broader evaluator path when changing routing policy, runner behavior, child-tool budgets, memory semantics, or workflow scoring. `eval:workflow:harness` compares simple, Chalin, and Gentle harnesses on the standard suite; `eval:workflow:complex` runs the expanded real-OSS-inspired suite across Zig/Rust, Rust, C, and C++ planning/implementation cases.

## Design Principles

- Route only when routing improves quality.
- Keep the human in command.
- Make autonomy observable.
- Prefer durable memory with review.
- Treat safety gates as product behavior.
- Verify behavior with tests and evaluators.

## License

Chalin is distributed under an MIT-style license with an attribution addendum. See [LICENSE](LICENSE).
