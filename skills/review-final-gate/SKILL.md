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
  - chalin_bash_job
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
- Use normal `bash` by default for review checks and for commands whose result is needed before the next response. Use `chalin_bash_job` only when review verification may run a long/full-suite test, typecheck, build, CI, watcher, dev-server, a command that would otherwise need a long timeout, or async work that can continue independently. Do not start a background job if the next action is simply waiting for it; use `completionAction=resume` when the result should continue later, and record pass evidence only after a terminal status/read/await or completion wakeup reports success.
- Use `verdict: "fail"` or `verdict: "gap"` when any blocking issue remains, and fill blockingFindings, missingCoverage, evidence, and requiredRepair.
