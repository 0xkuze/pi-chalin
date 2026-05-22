# Workflow eval matrix

`evals/workflow-quality.eval.ts` appends compact SDK run summaries to `workflow-quality-matrix.jsonl` by default.

Each JSONL row is intentionally small and versionable: case id, variants, run count, pass/fail, aggregate scores, p95 duration, model, git branch/commit, and dirty state. Full traces stay in `.pi-mesh/evals/` and should remain temporary.

Disable persistence for exploratory runs with:

```bash
PI_MESH_WORKFLOW_PERSIST_MATRIX=0 npm run eval:workflow -- --mode=sdk --case=<case>
```

For production-style workflow certification prefer the sharded runner:

```bash
npm run eval:workflow:sharded
```

Keep only compact release evidence JSONL/JSON files in this directory. Temporary shard folders (`.workflow-shards-*`) and ad-hoc exploratory JSONL files should be cleaned before commit.
