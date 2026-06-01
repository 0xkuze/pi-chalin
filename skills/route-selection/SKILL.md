---
name: route-selection
description: Internal routing procedure for deciding direct work versus pi-chalin routed subagent workflows.
scope: built-in
extends:
  - planner
  - delegate
concerns:
  - planning
  - delegation
capabilities:
  - coordinate
activation: suggested
triggers:
  - route
  - delegate
  - multi-agent
risk: low
maxActiveWith: []
allowedTools:
  - read
  - grep
  - find
  - ls
  - chalin_project_discovery
deniedTools:
  - edit
  - write
requiresReview: false
scripts: disabled
trust: trusted
lifecycle: active
version: 1
---

## Rules
- Keep explicit small edits direct until evidence proves breadth, risk, ambiguity, or review isolation matters.
- Route broad, risky, multi-surface, or long-running work with concrete steps and success criteria.
- Routed mutations require an executing worker and later reviewer.
- Do not add scout, planner, researcher, or context-builder unless their output improves correctness.
- Collapse read-only redundant routes when direct evidence is cheaper.
