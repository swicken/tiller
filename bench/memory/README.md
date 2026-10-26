# Memory benchmarks

Benchmarks for daemon-native memory (`docs/memory.md`). The design is in the session plans `memory-benchmarks-plan.md` (Layers A-C) and `memory-v4-plan.md` §2 (Layer R, the retrieval gate for local embeddings).

| Layer | What | How | Cost |
| --- | --- | --- | --- |
| A | Labelled fixtures replayed through the real capture, store and digest code | `npm test -- bench/memory` | $0 |
| R | Search retrieval over real archived trees (R1, R2b), an authored fixture (R2a) and scaled stores (S) | `bench:memory -- retrieval`, `bench:memory:replay -- --retrieval` | $0, except R2b collection |
| B0 | Each Layer B scenario's preflight: the planted lesson reaches the digest, and the scripted repo's gate behaves | `npm test -- bench/memory`, `bench:memory:layer-b -- --dry-run` | $0 |
| B | Paired live agents on scripted repos, memory `on` against `off` | `bench:memory:layer-b` | agent time |

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
npm run bench:memory:replay -- --retrieval [--scale [5000,20000]] --root DIR [--deps ~/.tiller-bench/deps] \
    [--explore minilm,bge,arctic] [--home ~/.tiller] [--workspace ~/workspace]      # R1, S, R2a and R3 ($0, aggregates only)
```

Every `bench:memory` command takes `--root DIR` (default `~/.tiller-bench`); `bench:memory:replay` requires it. `--collect` also takes `--home` (the tiller home whose sessions it reads, default `~/.tiller`). Both refuse a `--root` inside `~/.tiller`, the home they read, or this checkout.

`--golden` writes `fixtures/retrieval/wordpiece-golden.json`: the reference tokenizer's ids, without special tokens and with `[UNK]` kept, for the edge cases in `retrieval/embedders.ts` and every R2a corpus text. W1's in-tree WordPiece must match it.

Models are pinned by revision, size and sha256 in `retrieval/models.ts`. They download on first use into `<root>/models/<key>@<rev7>/` and are verified in memory before they are renamed into place; a file that fails verification is an error, never replaced.

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

## R1, R2a and S

- **R1:** every gate-tree node with at least one file-overlap label is scored twice: by its title and by its brief (title plus prompt). Each is scored against the store replayed from what closed before the node was created. R2b queries are scored in the same store as their node's R1 queries.
- **R2a:** `fixtures/retrieval/corpus.json` holds 81 hand-written targets for a fictional project, ten of them near-miss distractors. Every Layer A fixture's items are added to it, 357 items in all. `needs.json` holds 40 needs, ten of them with no relevant item. Each need has a lexical query, two paraphrases, a synonym swap and a Codex/Pi phrasing. `retrieval.test.ts` enforces two rules:
  - paraphrases share no `ftsTerms` token with any relevant target, and F0 finds none of them;
  - every other query keeps a shared token.

  `floors.json` holds F0-F2's R2a scores as a ratchet.
- **S:** each tree's final replayed store is padded with commit subjects and bodies (`git log`, read-only) from repos under `--workspace`, oldest first and deduplicated, into temp stores that are deleted afterwards. The padding leaves out bloksec repos and **every gate tree's repo**:
  - Each tree's irrelevant queries are the other gate trees' titles, plus R2a's zero-relevance queries.
  - The literal §2.2 rule left out only the tree's own repo. Those titles then matched near-copies of themselves in the other tree's commit log, so they were not irrelevant by construction.
  - The orchestrator chose this reading, and the frozen configuration records it under `interpretations`, with both τ values.
  - On this machine about 1k commits remain, so the S stores are the most available, about 1.1k-1.9k items, not 5k and 20k.

## The configuration freeze

The first run that has an embedder and `--scale` writes `<root>/results/retrieval-config.json`:
- **τ:** the 95th percentile of potion's top-1 cosine for irrelevant queries on each tree's largest S store, pooled.
- **F-best:** the F variant with the best R2a recall@8.
- **Exploratory floors:** each exploratory model gets its own floor by the same rule, since cosine scales differ between models.
- **The fixed constants.**

Later runs use the file and report any value they would compute differently. Delete it only for a new, recorded pre-registration.

## The verdict

`--eval` writes `<root>/results/retrieval-<date>.json` (schema: `RetrievalResult` in `retrieval/types.ts`) and prints the §2.5 criteria. v4 ships only if every criterion passes:
- **P1:** on the primary set (0.5 R1-title + 0.5 R2b), hybrid potion beats the best FTS variant by at least +0.08 recall@8, with a cluster-bootstrap 95% CI lower bound of at least +0.02.
- **P2:** FTS misses at least 20% of queries, and hybrid cuts that miss rate to at most 0.75 times FTS's.
- **G1-G5:** guardrails for regressions, per-slice losses, non-inferiority, noise at scale and cost.

`verdict.ship` is `null` when a criterion was not evaluated (G5 is measured outside the bench). The configuration (τ, F-best) is frozen from S and R2a before R1 and R2b are scored; a rerun with new parameters is a new pre-registration.

## Layer B: memory on against off

Each trial is one pair of phase-2 nodes on the same scripted repo and brief, one per arm, run at the same time (bench plan §3.1). Phase 1 is seeded: the scenario's canned episodes go through the real `derive` and store into a temp store, which `VACUUM INTO` copies into every arm's home. Phase 2 starts from the scripted post-task-1 repo R1, never from phase 1's tree, so the store is the only carrier of phase-1 knowledge.

```sh
npm run bench:memory:layer-b -- --list
npm run bench:memory:layer-b -- --scenario all --dry-run                      # B0 and the repo checks ($0)
npm run bench:memory:layer-b -- --scenario gate-trap --runs 15 --arms off,on --parallel 2 --root ~/.tiller-bench-layer-b --yes
npm run bench:memory:layer-b -- --scenario gate-trap --runs 15 --arms off,off ...    # the A/A calibration (§3.5)
npm run bench:memory:layer-b -- --report <root>/results/<runId>                # re-score, no LLM calls
```

Options: `--model` (default `claude-haiku-5-5`), `--effort`, `--node-timeout-min 15`, `--budget-usd 50` (no new pair starts past it), `--keep` (keep the trial dirs under `<root>/runs`). Without `--yes` a run prints its plan and projected cost and starts nothing.

**Arms** are home configs of each arm's own daemon: `off` (`memory.enabled: false`), `on` (`memory.enabled: true`, `digest: "on"`) and `tools` (`digest: "off"`, pull only). `placebo` is not built.

**Layout.** A trial is `<root>/runs/<runId>/tNN/` with `hidden/` (S4's acceptance test) and, per arm, `repo/` (R1, tagged `origin-base`, origin `https://bench.invalid/<repo>.git`), `home/` (its daemon's `TL_HOME`, on an ephemeral port) and `calls.jsonl`. The repo's instrumented scripts log every run of the gate, `tools/verify.mjs` and the `npm test` decoy to `calls.jsonl` through `scripts/log.sh`, by a path relative to the script, so both arms' repos are byte-identical. Results go to `<root>/results/<runId>/{results.json,summary.md}` and one line of `<root>/results/index.jsonl`.

**Scoring sources:** the daemon's `gate` events in `events.jsonl` (first-pass gate, attempts), the call log (verify and decoy timing, hand-run gates), the outcome, the Claude transcript (tool calls with their file or command, tokens), the injection log read from each arm's store after its daemon stops, and `git diff origin-base` plus untracked files. A pair is void (and rerun, up to 3 attempts) when an arm was blocked, exited, errored before reporting, made no tool call, saw memory in the off arm, or did not get its digest in the on arm, or when Claude auto-memory existed for its repo path.

**Scenarios** (`layer-b/scenarios.ts`, hashed into every result):

| Id | Name | Primary | Notes |
| --- | --- | --- | --- |
| S1 | `gate-trap` | first-pass gate | The brief names `src/format.js`, the pitfall's file: with the plan's brief the pitfall shares no search term (S1p). |
| S1p | `gate-trap-plan-brief` | (B0 only) | The plan's literal brief; B0 records that the pitfall is not in its digest (D-1). |
| S2 | `verify-rediscovery` | tool calls before the first own verify run | The procedure is `node tools/verify.mjs contract`: memory's allowlist refuses the plan's `./tools/verify`. |
| S4 | `same-files` | first-pass gate | The gate runs a hidden acceptance test at `<trial>/hidden`. |
| S5a | `harm-stale` | CHANGELOG.md touched (harm) | The S1 pitfall, 30 days old and seen 3 times, after the repo retired its changelog. |
| S5d | `harm-noise` | success, non-inferiority margin 10 points | 40 ledgers, 10 procedures and 6 pitfalls about `src/reports/`; a planted `pad2` bug. |

S3 (cold start), S5b, S5c, S6 (cross-harness), `--phase1 live` and the `placebo` arm are not built. Gates that run tests before the check a scenario is about would make memory record node's `ℹ fail 0` summary line as the pitfall (`firstErrorLine`), so each scenario's gate runs its check first.
