// The retrieval check's contract (Layer R): queries scored against the product's memory search, and the result file.
// Result files hold ids and numbers only, never query or item text, because R1 queries are real session text and stay
// outside the repo.

/**
 * Where a query comes from:
 * - r1-title, r1-brief: an archived node's title, or its title plus prompt (the digest path);
 * - r2a: the authored fixture, scored in CI against floors.
 */
export type QuerySet = 'r1-title' | 'r1-brief' | 'r2a';

/** An R2a query's wording class. Each keeps at least one ftsTerms token of a relevant target. */
export type QueryClass = 'lexical' | 'synonym' | 'harness-phrasing';

/** One R2a need (fixtures/retrieval/needs.json): the items that answer it, and its queries. */
export interface Need {
  id: string;
  /** "@label"s of the R2a corpus (Layer A format). */
  relevant: string[];
  /** One lexical control, a synonym swap and a Codex/Pi phrasing. */
  queries: { class: QueryClass; text: string }[];
}

/** One scored query. */
export interface RetrievalQuery {
  /** Stable and text-free, as `<tree>/<node>/<set>` or `r2a/<need>/<n>`. */
  id: string;
  set: QuerySet;
  text: string;
  /** r2a only. */
  class?: QueryClass;
  /** An R1 tree's root id, or 'r2a'. */
  tree: string;
  /** Relevant item ids in the query's store; never empty. */
  relevant: number[];
}

/** One query's metrics. */
export interface QueryScore {
  query: string;
  set: QuerySet;
  tree: string;
  class?: QueryClass;
  /** |relevant ∩ top k| / min(|relevant|, k). */
  recall: number;
  /** 1 / rank of the first relevant item within mrrK, else 0. */
  rr: number;
  /** No relevant item in the top k. */
  miss: boolean;
  /** Results returned in the top k. */
  returned: number;
}

/** Means over a set, or one tree or class within it. */
export interface SliceScore {
  set: QuerySet;
  tree?: string;
  class?: QueryClass;
  queries: number;
  recallAtK: number;
  mrr: number;
  missAtK: number;
}

export interface RetrievalResult {
  /** ISO time. */
  generatedAt: string;
  queries: QueryScore[];
  slices: SliceScore[];
}
