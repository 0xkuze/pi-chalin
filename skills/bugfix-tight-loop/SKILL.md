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
triggers:
  - bugfix
  - failing test
  - regression
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
- Run the nearest verification command from repository evidence.
- Final handoff cites implementation path, test or evidence path, and verification command.
