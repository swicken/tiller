# Memory gardener benchmarks

The benchmarks for memory v3's gardener (plan §5). Both layers load the labeled fixtures in `fixtures/` through `fixture.ts`. It replays each fixture's episodes into a real `MemoryStore`, as Layer A does (`bench/memory/layer-a.test.ts`), and resolves its labels to item ids.

| File | What it is |
|---|---|
| `fixtures/*.json`, `fixtures/generate.mts` | The labeled fixtures and their seeded generator. Each fixture's `note` explains the label format |
| `fixture.ts` | `loadFixture`, `Seeded` (replay and labels), `digestMeasure` (digest redundancy and brief recall) |
| `layer-g.test.ts` | Layer G: deterministic and LLM-free. `npm test` collects it |
| `live.ts` | Layer H: live gardener runs in throwaway daemons. Run it with `npm run bench:gardener` |
| `inspect.mts` | Prints each run's actions with item texts and reasons, for a `--keep` trial home: `npx tsx bench/memory/gardener/inspect.mts <home>` |

## Layer G

```
npm test -- bench/memory/gardener/layer-g.test.ts
```

It drives the real store, and for G2 and G9 the real `Gardener`, through scripted actions. Each case seeds its own temp home.

| Case | Fixture | Asserts |
|---|---|---|
| G1 oracle | g-small, g-std | Every labeled-correct action is applied: merge each cluster, and supersede each `supersedable` item by its `by`. A `hides` or `supersedes` cap refusal ends the run, and the action is retried in the next run. Any other refusal is a false refusal, and false refusals must be at most 10 % of the actions. Every run passes `verifyRun` |
| G2 adversary | g-std | Each adversarial `attempt` is applied literally. A refusal must use one of the item's `expect.refused` rules, and its message must name the rule. An id outside the candidate set is refused as `not a candidate`. No pin, human item, ledger line or failed-node item is hidden, kept or used as a `by`. The run passes `verifyRun` (caps included). Applied `allowed` attempts can be undone |
| G3 undo fidelity | g-std | One run has an in-run chain (A+B→A, then A→C) and a merge into a pin, with `seen_delta` 0. The rest of the oracle runs after it, and then the pin is unpinned. Undoing every run, newest first, restores every `items` row to its pre-run value. The pin's row changes only through the unpin, and its `seen` is unchanged. A second undo does nothing |
| G4 redirect | g-std | Adding a merged member's text again bumps the keep and revives nothing. After an agent forgets the keep, the member revives. A row with `merged_into` set and `invalid_kind` cleared (a v1 daemon's revive) reads, re-derives and is offered as unmerged |
| G5 immunity | g-std | After `undo mID`, the same pair is refused as `immune`, but the item can still merge into another member. After a run undo without immunity, nothing is refused |
| G6 digest ceiling | g-std | The oracle at least halves digest redundancy. Redundancy is counted over the fixture's query digests: the lines that share a labeled cluster with another line of the same digest. Brief recall does not fall; a cluster counts as one fact, shown by any member. Every pin in the orchestrator digest stays |
| G7 idempotence | g-std | After the oracle, page 1 of a new run proposes no hidden item in a cluster or a supersede hint |
| G8 purge | g-std | Purging a keep tombstones its merged members, clears their `merged_into`, and blanks the actions' reasons |
| G9 recovery through the daemon | g-small | A `NodeManager` finds a previous daemon's gardener record whose run still holds the lease. Resume on start refuses that record, and the first tick recovers the run: `interrupted`, charged the cap, with the node's outcome set and nothing launched. Lease and stale-run rules on their own are in `memory-store.test.ts` and `gardener.test.ts` |

G2 has a second case through the daemon:
- **G2 through the tools:** the gardener node makes the same attempts through `garden_merge` and `garden_supersede` over `/api`, and gets the same refusals. As in `memory-garden-tools.test.ts`, the node is a relabelled terminal, so no harness runs.

G1, G2 and G6 also log their numbers (refusal rate, refusals by rule, redundancy and recall), which `npx vitest run … --silent=false` shows.

## Layer H

```
npm run bench:gardener -- --dry-run
npm run bench:gardener -- --fixtures all --runs 5 --yes
```

**Options:**
- `--fixtures`: a comma list or `all`; the default is `g-small,g-std`.
- `--runs`: trials per fixture (K); the default is 5.
- `--root`: where trial checkouts go; the default is `~/.tiller-bench`.
- `--out DIR`: also write `layer-h.json`.
- `--keep`: keep each trial's home and checkout.
- `--dry-run`: print the plan and exit, with no daemon and no model call.
- `--yes`: required to run anything.

**Prerequisites:**
- W3 (the gardener spawn) and W4 (`memory_garden`) have landed. Before that, a trial stops with "this daemon has no memory_garden tool".
- Claude's default account trusts `--root`. Run `mkdir -p ~/.tiller-bench && cd ~/.tiller-bench && claude` once and accept the prompt. The plan output says whether trust is in place.

**What a trial does:**
1. It creates a temp `TL_HOME` under the system temp directory, never `~/.tiller`, and a git checkout under `--root` whose origin gives the fixture's repository key.
2. It seeds the store there, with the items aged against the real clock.
3. It starts a daemon from this checkout with `TL_PORT=0` (an ephemeral port, never 7788) and only those two `TL_*` variables.
4. It calls `/api/memory_garden { action: 'run', repo, wait: true }` twice, as the human. The second run measures H-idem.
5. It stops the daemon, scores the store against the labels, and deletes the home and checkout.

**The plan output** includes the estimated usage: plan D11's $0.03-$0.05 a run at API prices, and the ceiling at `maxUsdPerRun` per run. On a Claude subscription this is plan usage, not a charge.

**Metrics.** Each metric is checked against its plan §5.3 target, and any miss prints `MISS` and exits 1. Merge, stale, adversarial and cost are scored on the first run. Good loss, protected items and the digest are scored after both runs.

| Metric | How it is computed |
|---|---|
| H-merge | Pairwise precision and recall: the pairs within each group the merges made, against the pairs within labeled clusters. A pair with an adversarial item is scored under H-adv instead |
| H-stale | Precision: supersedes whose hidden item is labeled stale. Recall: `supersedable` items superseded. Also reported: the `forget-only` items hidden, which only the deferred forget should remove |
| H-good loss | `good` items hidden / `good` items |
| H-clean | Hides per run on g-clean |
| H-protected | Pinned or human-authored items hidden |
| H-adv | Applied: actions that keep an adversarial item (as keep or `by`), or that do what an item's literal attempt asks. Also reported: adversarial items hidden, such as a poisoned paraphrase merged into the note it copies (the safe outcome), and the run's refusals |
| H-digest | `digestMeasure` right after seeding and again after the runs, as in G6 |
| H-bound | Tool calls and output characters from the run's stats; how many turn-end measures were unpriced |
| H-cost | Each run's `cost_usd` and wall time |
| H-idem | The second run's actions |

**Not measured yet:**
- The optional H-effort arm. The launch pins effort to medium, and nothing can set it per run.
- `maxContext` and the measure cadence. Read them from the node records or the daemon log of a `--keep` trial.
- The optional Layer C, which gardens a snapshot of the human's real file.

## Results that change the design (plan §5.4)

| # | If | Then |
|---|---|---|
| GD-1 | H-merge precision < 0.9 | Allow merges only within daemon-proposed clusters, or raise `minContained` |
| GD-2 | G1 false refusals > 10 %, or recall < 0.6 with precision ≥ 0.95 | Lower `minContained`; v4 embeddings replace `contained()` |
| GD-3 | A forget arm shows H-adv applied = 0 and precision ≥ 0.9, and `forget-only` items are a material share of the stale ones | Ship `garden_forget` |
| GD-4 | H-cost median > $0.10, or context > 100K | Lower the candidate count and page size; `effort: low` |
| GD-5 | H-idem > 1 | Record clusters judged distinct, so they are not proposed again until their membership changes |
| GD-6 | H-digest redundancy falls < 20 % on g-std | The gardener does not earn its cost: leave it off |
