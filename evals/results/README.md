# Workflow eval matrix

`evals/workflow-quality.eval.ts` appends compact SDK run summaries to `workflow-quality-matrix.jsonl` by default.

Each JSONL row is intentionally small and versionable: case id, variants, run count, pass/fail, aggregate scores, p95 duration, model, git branch/commit, and dirty state. Full traces stay in `.pi-chalin/evals/` and should remain temporary.

Schema v4 rows also include `comparisons`, so one run can preserve the internal `chalin` vs `simple` baseline while adding external harness comparisons such as `chalin` vs `gentle`.

Disable persistence for exploratory runs with:

```bash
PI_CHALIN_WORKFLOW_PERSIST_MATRIX=0 bun run eval:workflow -- --mode=sdk --case=<case>
```

For production-style workflow certification prefer the sharded runner:

```bash
bun run eval:workflow:sharded
```

For harness comparison against the sibling `gentle-pi` checkout, run:

```bash
bun run eval:workflow:harness
```

That preset runs `simple`, `chalin`, and `gentle` on the same synthetic cases and uses `openai-codex/gpt-5.5` as both worker and Pi judge model by default. It combines deterministic workspace/trace scoring with a blind comparative judge: candidate labels are shuffled, harness names are hidden from the judge prompt, and the target harness must win the comparative rank. Override the external checkout with `--gentleRoot=/path/to/gentle-pi` or `PI_CHALIN_GENTLE_PI_ROOT`.

For routed harness comparison, use:

```bash
bun run eval:workflow:routed
```

That preset selects route-required cases only and uses a longer timeout for multi-agent work. Chalin must call `chalin_route`; Gentle must call its `subagent` tool from the companion bundle. Override the companion bundle with `--gentleCompanionRoot=/path/to/node_modules` or `PI_CHALIN_GENTLE_COMPANIONS_ROOT`.

Keep only compact release evidence JSONL/JSON files in this directory. Temporary shard folders (`.workflow-shards-*`) and ad-hoc exploratory JSONL files should be cleaned before commit.
