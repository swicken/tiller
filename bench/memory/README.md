# Memory benchmarks

Benchmarks for daemon-native memory (`docs/memory.md`). The design is in the session plans `memory-benchmarks-plan.md` (Layers A-C) and `memory-v4-plan.md` §2 (Layer R, the retrieval gate for local embeddings).

| Layer | What | How | Cost |
| --- | --- | --- | --- |
| A | Labelled fixtures replayed through the real capture, store and digest code | `npm test -- bench/memory` | $0 |
| R | Search retrieval over real archived trees (R1, R2b), an authored fixture (R2a) and scaled stores (S) | `bench:memory -- retrieval`, `bench:memory:replay -- --retrieval` | $0, except R2b collection |

## Data rules

R1, R2b and S read real session text, so:
- Session directories and repos are only ever read.
- Results go under `<root>/results` (default `~/.tiller-bench`), never into the repo. Result files hold ids and numbers; the one exception is R2b's collected queries, which also stay under `<root>/results`.
- `run.ts` refuses a `--root` inside `~/.tiller` or this checkout.
- Only the pre-registered trees are used: tiller (`n-96530325`) and storyGame (`n-76dead40`). `lib/archive.ts` checks that the selection rule still picks exactly these, and no bloksec repo is ever used.

## Commands

```sh
npm run bench:memory -- retrieval --golden [--deps ~/.tiller-bench/deps]           # tokenizer golden for the potion worker ($0)
npm run bench:memory -- retrieval --eval [--sets r1,r2a,r2b,s] [--explore minilm,bge,arctic] \
    [--deps ~/.tiller-bench/deps]                                                    # Layer R scoring ($0)
npm run bench:memory -- retrieval --collect [--harness auto] [--model claude=ID,codex=ID] [--effort E] \
    [--budget-usd 18] [--limit N] [--parallel 2] [--node-timeout-min 10] [--keep] [--yes]   # R2b collection (agent time)
npm run bench:memory:replay -- --retrieval [--scale 5000,20000]                     # R1 and S ($0, aggregates only)
```

Every command takes `--root DIR` (default `~/.tiller-bench`). `--collect` also takes `--home` (the tiller home whose sessions it reads, default `~/.tiller`).

Without `--deps`, `--eval` scores the FTS variants only; that is what CI runs. The reference tokenizer and the exploratory ONNX models load from a scratch install outside the repo's dependencies, made once by the human:

```sh
npm install --prefix ~/.tiller-bench/deps --ignore-scripts onnxruntime-node@1.30.0 @huggingface/tokenizers@0.2.0
```

## R2b collection

For each sampled node, `--collect`:
1. replays the tree's outcomes and closes that closed before the node was created (never the node or its descendants) into a store, and copies it with `VACUUM INTO` into a fresh temp `TL_HOME`, keyed to a scratch repo whose origin is `https://bench.invalid/<tree>-<node>-<harness>.git`;
2. starts a daemon on that home and an ephemeral port (`node --import tsx src/daemon/index.ts`, never the live home or port 7788) with `memory.enabled: true` and `memory.digest: "off"` (the `tools` arm);
3. opens a terminal bench parent and spawns the agent as its child with the node's archived prompt, cut to 2,000 characters, after a fixed elicitation: search memory first, then `report_outcome`;
4. waits for the report, closes the nodes, stops the daemon and reads the `memory_search` queries from the transcript (`lib/queries.ts`);
5. deletes the temp home and scratch repo unless `--keep` is given.

Each node gets its own daemon and store, so one harness's report never reaches the other harness's store.

**Sample:** labelled nodes (with a prompt and at least one file-overlap label) of each tree, up to 25 per tree, by a seeded shuffle (seed 4104). `--limit N` keeps the first N sampled nodes, each on all its harnesses; `--limit 1` is the smoke run.

**Tree → harness rule:** a tree's prompts go only to the harnesses that tree already used, from its archive's `harness` fields. Both trees used Claude and Codex. Pi is never used: neither tree used it, and Pi is not installed here. `--harness claude,codex` narrows the set; it cannot widen it.

**Models:** `claude-haiku-5-5` and `gpt-6-luna` by default; `--model claude=ID,codex=ID` overrides either.

**Cost and confirmation:** without `--yes`, `--collect` prints the sample, the tree → harness map and a projected cost ($0.18 per node), and starts nothing. With it, no new node starts once spend reaches `--budget-usd`. Spend is each node's measured `spentUsd`; Codex reports none, so a Codex node counts at the projection. The subscription covers the cost; the budget is rate-limit hygiene.

**Unattended runs:**
- Claude runs with a home preset `bench` (`permissionMode: bypassPermissions`, empty body, so the default worker role stays). Claude must trust `<root>`. A trusted ancestor such as your home directory is enough. Otherwise run `cd <root> && claude` once and accept the prompt; `--collect` checks this before starting.
- Codex keeps its own approval config, and Tiller's MCP calls ran without a prompt in the smoke run.
- A node that waits on a prompt for 30 s ends as `blocked`, meaning that harness cannot run unattended.

**Where transcripts go:** Claude writes its transcripts to `~/.claude/projects/<slug of the scratch repo path>/`, and Codex writes rollouts to `~/.codex/sessions/`. Deleting the scratch dirs does not remove them.

**Reading Codex queries:** the Codex bridge's transcript records tool names without arguments. `lib/queries.ts` follows its header's `threadId` to Codex's own rollout, `rollout-*-<threadId>.jsonl`, and reads the `McpToolCall` items for Tiller's server (`tiller_<hash>`).

### The queries file

`<root>/results/r2b-queries-<date>.json` (`-2`, `-3`, … when one exists; never overwritten) is rewritten after every node, so an interrupted run keeps what it collected:

```ts
{ version: 1, generatedAt, seed: 4104, perTree: 25, runs: [{
  tree, node, cluster, harness, model, asOf,    // asOf: the node's createdAt
  relevant: number[],                            // label item ids in the as-of store
  status: 'ok' | 'no-query' | 'blocked' | 'timeout' | 'error', detail?,
  queries: string[],                             // memory_search queries in call order
  spentUsd?,
}] }
```

The first query of each run is the scored R2b query (`r2bQueries` in `lib/queries.ts` turns the file into `RetrievalQuery`s); later queries are reformulations kept for reading. After collection, R2b rescoring reads only this file, so it is free and deterministic.

## The verdict

`--eval` writes `<root>/results/retrieval-<date>.json` (schema: `RetrievalResult` in `retrieval/types.ts`) and prints the §2.5 criteria. v4 ships only if every criterion passes:
- **P1:** on the primary set (0.5 R1-title + 0.5 R2b), hybrid potion beats the best FTS variant by at least +0.08 recall@8, with a cluster-bootstrap 95% CI lower bound of at least +0.02.
- **P2:** FTS misses at least 20% of queries, and hybrid cuts that miss rate to at most 0.75 times FTS's.
- **G1-G5:** guardrails for regressions, per-slice losses, non-inferiority, noise at scale and cost.

`verdict.ship` is `null` when a criterion was not evaluated (G5 is measured outside the bench). The configuration (τ, F-best) is frozen from S and R2a before R1 and R2b are scored; a rerun with new parameters is a new pre-registration.
