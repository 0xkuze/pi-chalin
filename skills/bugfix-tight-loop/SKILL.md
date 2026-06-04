---
name: bugfix-tight-loop
description: Procedure for bounded bug fixes with exact local evidence, small edits, and nearest verification.
scope: built-in
extends:
  - worker
concerns:
  - implementation
capabilities:
  - edit-files
  - validate
activation: auto
risk: low
maxActiveWith:
  - review-final-gate
allowedTools:
  - read
  - grep
  - find
  - ls
  - edit
  - bash
  - chalin_bash_job
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
- Read the exact target surface before editing.
- Change the smallest behavior-preserving region that fixes the failure.
- Add or update the nearest runner-discoverable regression test unless the user explicitly forbids test edits.
- When tests are touched, cover the broken behavior plus the nearest meaningful boundary of the same contract.
- Run the nearest verification command from repository evidence.
- Use normal `bash` by default, especially when the result is needed before the next response. Use `chalin_bash_job` only for likely-long/full-suite test, typecheck, build, CI, watcher, dev-server, commands that would otherwise need a long timeout, or async work that can continue independently. Do not start a background job if the next action is simply waiting for it; use `completionAction=resume` when the result should continue later, and do not cite it as passing evidence until a terminal status/read/await or completion wakeup reports success.
- Final handoff cites implementation path, test or evidence path, and verification command.
