# Memory benchmarks

Benchmarks for daemon-native memory (`docs/memory.md`). The design is in the session plan `memory-benchmarks-plan.md` (Layers A-C).

| Layer | What | How | Cost |
| --- | --- | --- | --- |
| A | Labelled fixtures replayed through the real capture, store and digest code | `npm test -- bench/memory` | $0 |
| R | Memory search recall on an authored fixture (R2a) and on real archived trees (R1) | `npm test -- bench/memory`, `bench:memory:replay` | $0 |
| B0 | Each Layer B scenario's preflight: the planted lesson reaches the digest, and the scripted repo's gate behaves | `npm test -- bench/memory`, `bench:memory:layer-b -- --dry-run` | $0 |
| B | Paired live agents on scripted repos, memory `on` against `off` | `bench:memory:layer-b` | agent time |

## Layer R: search retrieval

Both sets score `MemoryStore.search`, the product's FTS, by recall@8, MRR@20 and miss@8.

- **R2a** runs in CI. `fixtures/retrieval/corpus.json` holds 81 hand-written targets for a fictional project, ten of them near-miss distractors. Every Layer A fixture's items are added to it, 357 items in all. `needs.json` holds 30 needs, each with a lexical query, a synonym swap and a Codex/Pi phrasing; `retrieval.test.ts` checks that every query shares an `ftsTerms` token with a relevant target. `floors.json` holds the scores as a ratchet.
- **R1** reads real sessions: every node of the pre-registered trees with at least one file-overlap label is scored by its title and by its brief (title plus prompt), against the store replayed from what closed before the node was created.

```sh
npm run bench:memory:replay -- --root DIR [--home ~/.tiller]
```

R1's data rules:
- Session directories are only ever read; replayed stores are temp files that are deleted.
- Results go to `<root>/results/replay-<date>.json` and hold ids and numbers only. `--root` is refused inside `~/.tiller`, the home it reads, or this checkout.
- Only the pre-registered trees are used: tiller (`n-96530325`) and storyGame (`n-76dead40`). `lib/archive.ts` checks that the selection rule still picks exactly these, and no bloksec repo is ever used.

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
| S1 | `gate-trap` | first-pass gate | The rule (one `- src/<module>.js: ` entry per changed module) sits in `scripts/release.mjs` behind `scripts/ci.mjs`, and released history is prose; a plainly named check script bit 0 of 30 haiku nodes. The brief names `src/format.js`, the pitfall's file: with the plan's brief the pitfall shares no search term (S1p). |
| S1p | `gate-trap-plan-brief` | (B0 only) | The plan's literal brief; B0 records that the pitfall is not in its digest (D-1). |
| S2 | `verify-rediscovery` | tool calls before the first own verify run | The procedure is `node tools/verify.mjs contract`: memory's allowlist refuses the plan's `./tools/verify`. |
| S4 | `same-files` | first-pass gate | The gate runs a hidden acceptance test at `<trial>/hidden`. |
| S5a | `harm-stale` | CHANGELOG.md touched (harm) | The S1 pitfall, 30 days old and seen 3 times, after the repo retired its changelog. |
| S5d | `harm-noise` | success, non-inferiority margin 10 points | 40 ledgers, 10 procedures and 6 pitfalls about `src/reports/`; a planted `pad2` bug. |

S3 (cold start), S5b, S5c, S6 (cross-harness), `--phase1 live` and the `placebo` arm are not built. Gates that run tests before the check a scenario is about would make memory record node's `ℹ fail 0` summary line as the pitfall (`firstErrorLine`), so each scenario's gate runs its check first.
