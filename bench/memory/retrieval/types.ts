// The retrieval benchmark's contract (Layer R, memory-v4 plan §2): queries, rankers, embedders and the result file.
// The evaluator (G1) and the collection harness (G2) both build on these. Result files hold ids and numbers only, never
// query or item text, because R1 and R2b queries are real session text and stay outside the repo.
import type { Harness } from '../../../src/shared/protocol.js';

/**
 * Where a query comes from (§2.2):
 * - r1-title, r1-brief: an archived node's title, or its title plus prompt (the digest path);
 * - r2b: the first memory_search query a real agent wrote for that node's archived prompt;
 * - r2a: the authored mismatch fixture (capability and CI floors only, not in the primary set);
 * - s-irrelevant: a cross-repo title or an R2a zero-relevance need, run on the scaled stores (noise and τ).
 */
export type QuerySet = 'r1-title' | 'r1-brief' | 'r2b' | 'r2a' | 's-irrelevant';

/** An R2a query's wording class. Paraphrases share no ftsTerms token with any relevant target; every other class keeps one. */
export type QueryClass = 'lexical' | 'paraphrase' | 'synonym' | 'harness-phrasing';

/** One R2a need (fixtures/retrieval/needs.json): the items that answer it, and its queries. */
export interface Need {
  id: string;
  /** "@label"s of the R2a corpus (Layer A format); empty for a zero-relevance need. */
  relevant: string[];
  /** One lexical control, two paraphrases, a synonym swap and a Codex/Pi phrasing. */
  queries: { class: QueryClass; text: string }[];
}

/** One scored query. Every comparison is paired: same query, same store, same as-of time (§2.3). */
export interface RetrievalQuery {
  /** Stable and text-free, as `<tree>/<node>/<set>` or `r2a/<need>/<n>`. */
  id: string;
  set: QuerySet;
  text: string;
  /** r2a only. */
  class?: QueryClass;
  /** r2b only: the harness that wrote the query. */
  harness?: Harness;
  /** The stratum: an R1 tree's root id, or 'r2a'. */
  tree: string;
  /** The bootstrap's resampling unit: the task cluster (lib/archive.ts clusters), or the R2a need. */
  cluster: string;
  /** The archived node the query is about (R1, R2b, S). */
  node?: string;
  /** The store holds what closed before this time (ms); the query's own node and its descendants never. */
  asOf: number;
  /** Relevant item ids in that store; empty for a zero-relevance query. */
  relevant: number[];
}

/** Item ids, best first, for a query against the store its tree and asOf name. */
export type Ranker = (q: RetrievalQuery) => Promise<number[]>;

/** The pre-declared rankers (§2.1): FTS variants F0-F2, and per embedder key, vector-only (V:key) and hybrid (H:key). */
export type FtsVariant = 'F0' | 'F1' | 'F2';
export type RankerName = FtsVariant | `V:${string}` | `H:${string}`;

/** A text embedder. Vectors are unit length; query marks query-side text for models that embed queries differently. */
export interface Embedder {
  /** The candidate key, as potion or minilm. */
  key: string;
  dims: number;
  embed(texts: string[], query: boolean): Promise<Float32Array[]>;
}

// --- The result file (<root>/results/retrieval-<date>.json) ---

export const RESULT_VERSION = 1;

/** Frozen before R1 and R2b are scored (§2.4 step 1), from S and R2a only. */
export interface RetrievalConfig {
  /** Cosine floor: the 95th percentile of top-1 cosine for irrelevant queries on the 20k S stores, pooled across trees. */
  tau: number;
  /** The F variant with the highest R2a recall@8. */
  fBest: FtsVariant;
  /** 4104. */
  seed: number;
  /** 4000. */
  resamples: number;
  /** 60. */
  rrfK: number;
  /** Each ranker's list fed to RRF: 50. */
  pool: number;
  /** At most this many vector-only results in H's top k: 3. */
  vectorOnlyMax: number;
  /** recall@k and miss@k: 8. */
  k: number;
  /** MRR cut-off: 20. */
  mrrK: number;
  /** The primary set's fixed weights: 0.5 each. */
  weights: { 'r1-title': number; r2b: number };
  /** lib/archive.ts GATE_TREES root ids. */
  trees: string[];
  /** lib/archive.ts GATE_CUTOFF. */
  cutoff: number;
  /** lib/archive.ts HOT_FILE_SHARE. */
  hotFileShare: number;
}

/** One ranker on one query. */
export interface QueryScore {
  query: string;
  set: QuerySet;
  tree: string;
  cluster: string;
  harness?: Harness;
  class?: QueryClass;
  ranker: RankerName;
  /** |relevant ∩ top k| / min(|relevant|, k); null for a zero-relevance query. */
  recall: number | null;
  /** 1 / rank of the first relevant item within mrrK, else 0; null for a zero-relevance query. */
  rr: number | null;
  /** No relevant item in the top k; null for a zero-relevance query. */
  miss: boolean | null;
  /** Results returned, and of them vector-only (V and H). */
  returned: number;
  vectorOnly?: number;
}

/** A point estimate with its stratified cluster-bootstrap 95% CI when one was computed. */
export interface Estimate { value: number; ci?: [number, number] }

/** A slice is a set alone, or one tree, harness or class within it. 'primary' is the weighted R1-title + R2b set. */
export interface Slice { set: QuerySet | 'primary'; tree?: string; harness?: Harness; class?: QueryClass }

export interface SliceScore extends Slice {
  ranker: RankerName;
  queries: number;
  clusters: number;
  recallAtK: Estimate;
  mrr: Estimate;
  missAtK: Estimate;
}

/** A paired comparison, ranker − baseline, on one slice. */
export interface Comparison extends Slice {
  ranker: RankerName;
  baseline: RankerName;
  deltaRecallAtK: Estimate;
  /** Queries the baseline misses and the ranker hits, and the reverse. */
  rescued: number;
  lost: number;
}

/** Irrelevant queries on a scaled store (§2.5 G4). */
export interface Noise {
  tree: string;
  /** Items in the store: native, about 5k or about 20k. */
  items: number;
  ranker: RankerName;
  meanReturned: number;
  meanVectorOnly: number;
}

/** One §2.5 criterion; pass is null when it was not evaluated in this run (G5 is measured outside the bench). */
export interface Criterion {
  id: 'P1' | 'P2' | 'G1' | 'G2' | 'G3' | 'G4' | 'G5';
  pass: boolean | null;
  detail: string;
}

export interface RetrievalResult {
  version: typeof RESULT_VERSION;
  /** ISO time. */
  generatedAt: string;
  config: RetrievalConfig;
  /** Which sets and rankers ran, so a partial run (no --deps: FTS only) reads as such. */
  sets: QuerySet[];
  rankers: RankerName[];
  /** Exploratory embedders, reported but never deciding (§8 Q1). */
  exploratory: string[];
  queries: QueryScore[];
  slices: SliceScore[];
  comparisons: Comparison[];
  noise: Noise[];
  verdict: {
    /** True only when every criterion passed; null when one was not evaluated. */
    ship: boolean | null;
    criteria: Criterion[];
    /** The FTS-tuning recommendation (§2.5), when F1 or F2 clears its bar. */
    ftsTuning?: FtsVariant;
  };
}
