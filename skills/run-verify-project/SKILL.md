---
name: run-verify-project
description: Suggested project verification procedure for discovering and reusing the correct run, test, and smoke commands.
scope: built-in
extends:
  - worker
concerns:
  - implementation
capabilities:
  - validate
activation: suggested
triggers:
  - run verify
  - verification command
  - smoke check
  - test command
risk: low
maxActiveWith:
  - bugfix-tight-loop
allowedTools:
  - read
  - grep
  - find
  - ls
  - bash
  - chalin_artifact_write
  - chalin_project_discovery
deniedTools:
  - chalin_delegate
requiresReview: false
scripts: disabled
trust: trusted
lifecycle: active
version: 1
---

## Rules
- Discover commands from package manifests, README, Makefile, CI, or existing tests before inventing them.
- Prefer the nearest focused verification command over full-suite commands for bounded work.
- If a reusable command recipe is verified, record it as a worker skill candidate with evidence.
- If commands fail because the recipe is stale or incomplete, report the exact blocking dependency without fabricating success.
- Never treat ad-hoc scripts as permanent tests unless they are committed runner-discoverable tests.
