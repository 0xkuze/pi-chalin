<p align="center">
  <img src="assets/pi-mesh-banner.png" alt="pi-mesh banner" width="100%" />
</p>

<p align="center">
  <a href="package.json"><img alt="version" src="https://img.shields.io/badge/version-0.1.0-111111?style=for-the-badge"></a>
  <a href="package.json"><img alt="license" src="https://img.shields.io/badge/license-MIT-0f766e?style=for-the-badge"></a>
  <a href="package.json"><img alt="node" src="https://img.shields.io/badge/node-%3E%3D22.19.0-3c873a?style=for-the-badge&logo=node.js&logoColor=white"></a>
  <a href="package.json"><img alt="typescript" src="https://img.shields.io/badge/typescript-5.7-3178c6?style=for-the-badge&logo=typescript&logoColor=white"></a>
  <a href="docs/prd-v0.2.md"><img alt="status" src="https://img.shields.io/badge/status-MVP%20v0.2-f59e0b?style=for-the-badge"></a>
</p>

<h1 align="center">pi-mesh</h1>

<p align="center">
  A Pi Coding Agent extension for routed, memory-aware subagent workflows.
</p>

<p align="center">
  <a href="#why-pi-mesh">Why</a> ·
  <a href="#capabilities">Capabilities</a> ·
  <a href="#quick-start">Quick Start</a> ·
  <a href="#architecture">Architecture</a> ·
  <a href="#commands">Commands</a> ·
  <a href="#development">Development</a>
</p>

---

## Why pi-mesh

Most coding agents work best when the task is clear, bounded, and local. Real engineering work is rarely that polite.

`pi-mesh` turns normal Pi prompts into routed workflows that can inspect context, plan, execute, review, preserve memory, and expose exactly enough UI for the human to stay in control. It is designed around one principle: agents should help with depth and parallelism without hiding autonomy from the developer.

Think of it as a lightweight coordination layer for Pi:

- route simple prompts directly instead of over-engineering them;
- delegate broad or risky work to focused subagents;
- preserve useful local memory with explicit review;
- show route, agent, model, run, and safety state in the TUI;
- keep the implementation as a modular monolith until real pressure demands more structure.

## Capabilities

| Area | What pi-mesh provides |
| --- | --- |
| Routing | Deterministic and model-assisted route decisions for normal prompts. |
| Subagents | Built-in `scout`, `planner`, `worker`, `reviewer`, `researcher`, `delegate`, `oracle`, `context-builder`, and conflict-resolution flows. |
| Workflow shapes | `single`, `chain`, `parallel`, `dag`, and `memory-only` execution modes. |
| Memory | Local-first records, candidates, approval/rejection, and FTS-backed search. |
| TUI | Smart Panel, agent manager, activity monitor, memory review, artifact panel, and web fetch audit surface. |
| Safety | Approval thresholds, autonomy modes, recursion guards, single-writer guard, stale-run reconciliation, and mutation expectation checks. |
| Artifacts | Resumable task context for longer work, interviews, and implementation handoffs. |
| Web context | Audited web search/fetch path for exploration workflows that need fresh external context. |

## Project Status

`pi-mesh` is currently an MVP-oriented package targeting the v0.2 design documented in [`docs/prd-v0.2.md`](docs/prd-v0.2.md) and [`docs/technical-design-v0.2.md`](docs/technical-design-v0.2.md).

The current codebase already includes the package entrypoint, command registration, tool registration, routing kernel, agent catalog, memory store, runtime state, artifact support, web fetch support, quality evaluators, and test coverage around the core behaviors.

## Quick Start

### Requirements

- Node.js `>=22.19.0`
- npm
- Pi Coding Agent runtime

### Install dependencies

```bash
npm install
```

### Run checks

```bash
npm run typecheck
npm test
```

### Load in Pi

`pi-mesh` is exposed as a Pi extension through `package.json`:

```json
{
  "pi": {
    "extensions": ["./src/index.ts"]
  }
}
```

Once Pi loads the package, use `/mesh` inside the Pi session.

## Commands

| Command | Purpose |
| --- | --- |
| `/mesh` | Open the Smart Panel. It routes to the most relevant surface: active run, memory review, diagnostics, or home. |
| `/mesh on` | Enable autonomous routing for the current project. |
| `/mesh off` | Disable autonomous routing for the current project. |
| `/mesh agents` | Open the agent manager. |
| `/mesh memory` | Review memory records and pending candidates. |
| `/mesh memory <query>` | Search local memory. |
| `/mesh artifacts` | Open artifact and resumable task context. |
| `/mesh activity` | Inspect the active or latest run. |
| `/mesh web` | Open the web fetch audit panel. |
| `/mesh status` | Print routing, autonomy, safety, agent, memory, and guard status. |

## Tools

`pi-mesh` registers tools for workflows that need more than a direct answer:

| Tool | Purpose |
| --- | --- |
| `mesh_route` | Run a selected mesh workflow with concrete agents, topology, risk, memory, and artifact needs. |
| `mesh_interview` | Ask blocking clarification questions before planning or running agents. |
| `mesh_web_search` | Search or fetch web context through the audited mesh web layer. |
| `mesh_artifact_resume` | Resume task context from a stored artifact. |
| `mesh_resume` | Resume the latest paused or stale mesh run. |

## Architecture

`pi-mesh` deliberately starts as a modular monolith. That is not “less architecture”; it is architecture with fewer premature walls.

```txt
Pi Extension
  ├── commands.ts       /mesh command tree
  ├── tools.ts          mesh tools
  └── index.ts          extension registration

Core
  ├── kernel.ts         route and execution coordinator
  ├── config.ts         config, safety, autonomy, and model overrides
  ├── agents.ts         built-in, project, and user agent catalog
  ├── memory.ts         memory records, candidates, and search
  ├── runner.ts         SDK-first subagent execution
  ├── artifacts.ts      resumable task context
  ├── webfetch.ts       audited web context
  ├── ui.ts             TUI surfaces and notifications
  └── schemas.ts        shared types
```

Runtime flow:

```txt
Prompt or tool call
  -> MeshKernel
  -> effective config
  -> light memory lookup
  -> route decision
  -> safety/autonomy decision
  -> agent resolution
  -> worker runner
  -> output parsing
  -> memory/artifact capture
  -> TUI status and final response
```

## Agent Model

Agents are Markdown files with YAML frontmatter. They can come from three scopes:

```txt
agents/*.md                    built-in package agents
.pi-mesh/agents/*.md           project agents
~/.pi/mesh/agents/*.md         user agents
```

Resolution order:

```txt
name             -> project/name, then user/name, then built-in/name
project/name     -> project only
user/name        -> user only
built-in/name    -> built-in only
```

This gives teams a sane override model: project behavior wins locally, user preferences remain portable, and built-ins provide the baseline.

## Safety Model

`pi-mesh` treats autonomy as a product surface, not as an implementation detail.

- **Visible routing:** users can inspect route, agents, model choice, risk, and run status.
- **Approval gates:** medium/high risk work can require explicit approval depending on config.
- **Recursion guard:** child agents are prevented from recursively invoking mesh by default.
- **Single-writer guard:** parallel writers are constrained to avoid accidental worktree collisions.
- **Mutation expectation guard:** implementation routes that finish without real mutation are flagged.
- **Stale run reconciliation:** interrupted or missing runs can be inspected and resumed.

## Development

Useful scripts:

```bash
npm test
npm run typecheck
npm run eval
npm run eval:all
npm run eval:workflow
```

Key documentation:

- [`docs/prd-v0.2.md`](docs/prd-v0.2.md) - product requirements and user experience principles.
- [`docs/technical-design-v0.2.md`](docs/technical-design-v0.2.md) - architecture, runtime flow, and TUI strategy.
- [`docs/runtime-guards-v0.1.md`](docs/runtime-guards-v0.1.md) - safety guard policies.
- [`docs/webfetch-v0.1.md`](docs/webfetch-v0.1.md) - web context design.
- [`docs/implementation-roadmap-v0.2.md`](docs/implementation-roadmap-v0.2.md) - implementation phases and acceptance criteria.

## Design Principles

- **Route only when routing helps.** Simple prompts should stay simple.
- **Keep the human in command.** AI executes; the developer leads.
- **Prefer local memory with review.** Useful context should be durable, but never invisible.
- **Make autonomy observable.** No hidden agent behavior, no silent multi-agent detours.
- **Build the foundation first.** Good workflows need clear routing, safety, and feedback before visual complexity.

## License

MIT. See [`package.json`](package.json) for the current package metadata.
