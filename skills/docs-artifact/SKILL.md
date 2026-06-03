---
name: docs-artifact
description: Documentation and artifact writing procedure that keeps claims evidence-backed and reusable.
scope: built-in
extends:
  - worker
  - reviewer
concerns:
  - implementation
  - review
capabilities:
  - edit-files
  - validate
activation: auto
triggers:
  - docs
  - documentation
  - README
  - artifact
risk: low
maxActiveWith:
  - review-final-gate
allowedTools:
  - read
  - grep
  - find
  - ls
  - edit
  - write
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
- Ground every architectural or workflow claim in repository evidence or mark it as an open assumption.
- Keep docs structured for future maintainers: problem, decision, operational steps, validation, risks.
- Avoid raw logs and bulky command output; summarize and cite exact commands or paths.
- Preserve existing documentation style and headings unless the requested change requires a new structure.
- If writing a resumable artifact, include status, current step, validation contract, and reusable worker skill candidates.
