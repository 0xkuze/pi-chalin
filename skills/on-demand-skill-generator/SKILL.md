---
name: on-demand-skill-generator
description: Procedure for turning a verified task recipe into an on-demand Skill candidate.
scope: built-in
extends:
  - worker
  - planner
concerns:
  - implementation
  - planning
capabilities:
  - validate
  - write-new-files
activation: manual
triggers:
  - generate skill
  - reusable procedure
  - worker skill
risk: low
maxActiveWith: []
allowedTools:
  - read
  - grep
  - find
  - ls
  - chalin_artifact_write
  - chalin_project_discovery
deniedTools:
  - bash
  - chalin_delegate
requiresReview: false
scripts: disabled
trust: trusted
lifecycle: active
version: 1
---

## Rules
- Create candidates only from procedures actually used or verified in the current task.
- Use a stable, specific kebab-case name and a description that states when to use it.
- Include trigger hints, tool restrictions, trust, lifecycle, and no scripts by default.
- Store candidates under the feature artifact until reviewed.
- Promotion requires audit and explicit target scope.
