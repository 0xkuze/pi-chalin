---
name: run-verify-project
description: Project verification procedure for discovering and reusing the correct run, test, and smoke commands.
scope: built-in
extends:
  - worker
concerns:
  - implementation
capabilities:
  - validate
activation: auto
risk: medium
maxActiveWith:
  - bugfix-tight-loop
  - implementation-contract-edges
allowedTools:
  - read
  - grep
  - find
  - ls
  - edit
  - write
  - bash
  - chalin_bash_job
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
- Treat full test/build/typecheck/CI scripts, dev servers, watchers, and commands with slow/sleep/server names as potentially blocking; when `chalin_bash_job` is available, prefer it over `bash`, use `completionAction=resume` when the result should continue later, and report pass/fail only after a terminal status/read/await or completion wakeup.
- If a reusable command recipe is verified, record it as a worker skill candidate with evidence.
- If commands fail because the recipe is stale or incomplete, report the exact blocking dependency without fabricating success.
- Never treat ad-hoc scripts as permanent tests unless they are committed runner-discoverable tests.
