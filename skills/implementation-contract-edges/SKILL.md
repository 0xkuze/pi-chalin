---
name: implementation-contract-edges
description: Contextual edge-contract checklist for implementation and review work involving parsers, normalization, time windows, scaffolds, CLIs, or public API contracts.
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
  - parser
  - scanner
  - tokenizer
  - lexer
  - grammar
  - state machine
  - delimiter
  - normalization
  - normalize
  - canonical
  - sorting
  - sort
  - trim
  - cache
  - retry
  - timeout
  - ttl
  - scaffold
  - package.json
  - cli
  - entrypoint
  - public api
risk: medium
maxActiveWith:
  - bugfix-tight-loop
  - review-final-gate
  - run-verify-project
allowedTools:
  - read
  - grep
  - find
  - ls
  - edit
  - write
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
- Derive the exact edge contract from the user request plus repo grammar, tests, docs, and public API evidence; do not invent unrelated validation.
- Parser, scanner, tokenizer, and state-machine work names changed states/transitions and tests changed boundaries, termination, protected spans, and error/EOF behavior when relevant.
- If a protected or delimited segment is a separate token/entity even when adjacent, assert separation from both previous and next unprotected text; do not merge it into a neighbor.
- Test delimiter adjacency around non-whitespace token characters and delimiter-like text inside protected states when supported.
- Normalization, sorting, filtering, and key-builder work separates trim/blank handling, preservation, duplicates, ordering, no-op/invalid behavior, and composition/determinism into focused runner-discoverable assertions.
- Preserve original case/content/format/order unless the request or source evidence explicitly asks for lossy conversion. If sorted values must preserve case/content, sort the trimmed originals with language-native lexicographic/ordinal order; casefolded sort keys require explicit evidence.
- For normalization, serialization, and key-builder APIs, prefer several compact visible tests over one smoke test; 8-12 focused assertions is usually the right size when the contract has many independent rules.
- For reusable public helpers, keep error types idiomatic for the language and test empty input, invalid types, invalid bounds, and relational bounds separately when validation is part of the contract.
- Time, retry, cache, rate, budget, and window behavior uses existing test seams or runner-native fake time instead of wall-clock sleeps or public API expansion unless repo evidence requires it.
- For configurable resource, range, window, pagination, retry, and cache behavior, validate only obvious invariants that would break the requested behavior, including relational bounds derived from current inputs.
- After validating configurable behavior, capture normalized config into implementation-owned values so later caller-side mutation cannot change runtime semantics.
- Scaffold, package, CLI, and entrypoint work keeps metadata, importable API, real command path, docs, build output, and test runner aligned with the requested toolchain.
- Keep scaffold tests/docs/build metadata in the requested language/toolchain unless repo convention proves otherwise; TypeScript requests use TypeScript tests.
- Prefer dependency-free/native test runners for new scaffolds unless the user requested a framework or the repo already established one; when a runner is used, write cases through that runner's discoverable API.
- For CLI contracts, test both importable logic and the real command path. If user text or args are accepted, include representative multi-token/no-input behavior instead of only one function call.
- For public/exported API changes, preserve existing docs and add a concise contract doc comment when local style supports it, especially for serialization, normalization, validation, or cross-module APIs.
- In review mode, check the changed edge contract criterion-by-criterion. Broad smoke tests, temp checks, or passing unrelated suites are gaps when permanent runner-discoverable assertions are needed for the requested behavior.
