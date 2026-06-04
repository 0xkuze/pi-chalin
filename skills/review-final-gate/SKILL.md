---
name: review-final-gate
description: Final review procedure for routed implementation, artifact, or mutation work before user-facing completion.
scope: built-in
extends:
  - reviewer
concerns:
  - review
capabilities:
  - validate
activation: auto
risk: medium
maxActiveWith:
  - bugfix-tight-loop
  - docs-artifact
allowedTools:
  - read
  - grep
  - find
  - ls
  - bash
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
- Compare actual changed files against the original user goal and worker claims.
- Treat passing tests as evidence for only the behavior they exercise.
- Flag missing requested criteria, missing permanent tests, skipped scope, unsafe broad edits, and unsupported claims.
- Return `verdict: "pass"` only after checking changed content and verification evidence.
- Use `verdict: "fail"` or `verdict: "gap"` when any blocking issue remains, and fill blockingFindings, missingCoverage, evidence, and requiredRepair.
