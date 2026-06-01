---
name: memory-maintenance
description: Suggested memory hygiene procedure for durable project facts, stale corrections, and deduplication.
scope: built-in
extends:
  - reviewer
  - researcher
  - planner
concerns:
  - memory-curation
  - review
  - research
capabilities:
  - memory-read
  - memory-write
activation: suggested
triggers:
  - memory
  - remember
  - stale
  - durable knowledge
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
