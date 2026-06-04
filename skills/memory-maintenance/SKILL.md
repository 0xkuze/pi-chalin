---
name: memory-maintenance
description: Memory hygiene procedure for explicit stale-memory, memory-revision, and durable-knowledge maintenance tasks.
scope: built-in
extends:
  - reviewer
  - researcher
  - planner
concerns:
  - memory-curation
  - planning
  - review
  - research
capabilities:
  - memory-read
  - memory-write
activation: auto
risk: low
maxActiveWith: []
allowedTools:
  - chalin_memory_search
  - chalin_memory_write
  - chalin_memory_revise
  - read
  - grep
  - find
deniedTools:
  - edit
  - write
  - bash
  - chalin_bash_job
requiresReview: false
scripts: disabled
trust: trusted
lifecycle: active
version: 1
---

## Rules
- Write only durable facts, decisions, tooling, workflow, testing, or preference knowledge.
- Prefer revising stale memory over adding a duplicate.
- Include compact evidence when correcting memory.
- Never save raw logs, command output, stack traces, secrets, or task completion notes.
- Current repository evidence and explicit user instructions override memory.
