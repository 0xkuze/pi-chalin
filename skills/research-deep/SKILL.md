---
name: research-deep
description: Evidence-first research procedure for explicit current external research tasks.
scope: built-in
extends:
  - researcher
concerns:
  - research
capabilities:
  - external-context
  - inspect-files
activation: suggested
triggers:
  - research
  - current docs
  - latest
  - paper
risk: low
maxActiveWith: []
allowedTools:
  - read
  - grep
  - find
  - ls
  - chalin_web_search
  - chalin_project_discovery
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
- Separate primary sources, official documentation, peer-reviewed papers, and commentary.
- Build a compact evidence table with claim, source, date, and confidence.
- Prefer current official documentation for APIs, products, legal, financial, and security-sensitive claims.
- Mark inference explicitly when sources do not state the conclusion directly.
- Preserve URLs needed for final citation.
