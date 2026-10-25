// The retrieval evaluator (memory-v4 plan §2.1-§2.5): the pre-declared rankers over a memory store file, the per-query
// metrics, the stratified cluster bootstrap, slices and paired comparisons, the §2.4 configuration freeze, the §2.5
// verdict and its printer, plus the R2a fixture and the R3 regression check. Results hold ids and numbers, never text.
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ftsTerms } from '../../../src/daemon/memory-schema.js';
import { GATE_CUTOFF, GATE_TREES, HOT_FILE_SHARE } from '../lib/archive.js';
import { Case, type Fixture } from '../lib/fixture.js';
import { wordpieceGolden } from './embedders.js';
import {
  RESULT_VERSION, type Comparison, type Criterion, type Embedder, type Estimate, type FtsVariant, type Need, type Noise, type QueryScore,
  type QuerySet, type RankerName, type RetrievalConfig, type RetrievalQuery, type RetrievalResult, type Slice, type SliceScore,
} from './types.js';

export const FTS_VARIANTS: FtsVariant[] = ['F0', 'F1', 'F2'];
/** The one ship candidate (§8 Q1); every other embedder is exploratory. */
export const CANDIDATE: RankerName = 'H:potion';
const SETS: QuerySet[] = ['r1-title', 'r1-brief', 'r2b', 'r2a', 's-irrelevant'];

/**
 * The frozen configuration. Each exploratory embedder gets its own floor by tau's rule, because cosine scales differ
 * between models; those floors are reported, never deciding.
 */
export type GateConfig = RetrievalConfig & { exploratoryTau?: Record<string, number> };

/** The pre-registered constants; tau and fBest come from §2.4 step 1. */
export function makeConfig(tau: number, fBest: FtsVariant, exploratoryTau?: Record<string, number>): GateConfig {
  return {
    tau, fBest, seed: 4104, resamples: 4000, rrfK: 60, pool: 50, vectorOnlyMax: 3, k: 8, mrrK: 20, weights: { 'r1-title': 0.5, r2b: 0.5 },
    trees: GATE_TREES.map((t) => t.rootId), cutoff: GATE_CUTOFF, hotFileShare: HOT_FILE_SHARE, ...(exploratoryTau ? { exploratoryTau } : {}),
  };
}

/** An embedder's cosine floor: tau for the candidate, its own for an exploratory one; NaN when not frozen. */
export const tauFor = (cfg: GateConfig, key: string): number => (`H:${key}` === CANDIDATE ? cfg.tau : cfg.exploratoryTau?.[key] ?? NaN);

// --- A store file, read-only ---

/** One repo of a MemoryStore file, opened read-only beside the store's own handle (WAL content included). */
export class StoreView {
  private readonly db: DatabaseSync | undefined;
  readonly repoId: number | undefined;

  constructor(file: string, repoKey: string) {
    if (!existsSync(file)) return;
    this.db = new DatabaseSync(file, { readOnly: true });
    this.repoId = (this.db.prepare('SELECT id FROM repos WHERE key = ?').get(repoKey) as { id: number } | undefined)?.id;
  }

  /**
   * F0 is MemoryStore.search's SQL exactly (ftsTerms, each quoted, OR-joined, bm25), without its 20 cap. F1 weights
   * text over body 3:1. F2 is F1 with a prefix match for single-token terms of 5 or more characters.
   */
  fts(query: string, variant: FtsVariant, limit: number): number[] {
    const terms = ftsTerms(query).map((t) => `"${t.replaceAll('"', '""')}"${variant === 'F2' && !t.includes(' ') && t.length >= 5 ? '*' : ''}`).join(' OR ');
    if (!this.db || this.repoId === undefined || !terms) return [];
    const rank = variant === 'F0' ? 'bm25(items_fts)' : 'bm25(items_fts, 3.0, 1.0)';
    return (this.db.prepare(`SELECT i.id FROM items_fts CROSS JOIN items i ON i.id = items_fts.rowid
      WHERE items_fts MATCH :terms AND i.repo_id = :repo AND i.invalid_at IS NULL ORDER BY ${rank} LIMIT :limit`)
      .all({ terms, repo: this.repoId, limit }) as { id: number }[]).map((r) => r.id);
  }

  /** The repo's searchable items as embedding text: text, a newline, body (§2.1). */
  docs(): { id: number; text: string }[] {
    if (!this.db || this.repoId === undefined) return [];
    return (this.db.prepare("SELECT id, text, body FROM items WHERE repo_id = ? AND invalid_at IS NULL AND text <> '' ORDER BY id")
      .all(this.repoId) as { id: number; text: string; body: string }[]).map((r) => ({ id: r.id, text: `${r.text}\n${r.body}` }));
  }

  close(): void {
    this.db?.close();
  }
}

// --- Rankers ---

export interface VectorIndex { ids: number[]; vecs: Float32Array[] }

export async function vectorIndex(view: StoreView, e: Embedder): Promise<VectorIndex> {
  const docs = view.docs();
  return { ids: docs.map((d) => d.id), vecs: await e.embed(docs.map((d) => d.text), false) };
}

const dot = (a: Float32Array, b: Float32Array) => {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
};

/** Ids by cosine (vectors are unit length), at or above floor, best n. */
export function nearest(ix: VectorIndex, q: Float32Array, floor: number, n: number): { id: number; cos: number }[] {
  const hits: { id: number; cos: number }[] = [];
  ix.vecs.forEach((v, i) => {
    const cos = dot(v, q);
    if (cos >= floor) hits.push({ id: ix.ids[i], cos });
  });
  return hits.sort((a, b) => b.cos - a.cos || a.id - b.id).slice(0, n);
}

/** Reciprocal rank fusion: sum of 1 / (k + rank) over the lists; ties keep first-appearance order (list by list). */
export function rrf(lists: number[][], k: number): number[] {
  const score = new Map<number, number>();
  for (const l of lists) l.forEach((id, i) => score.set(id, (score.get(id) ?? 0) + 1 / (k + i + 1)));
  return [...score.keys()].sort((a, b) => score.get(b)! - score.get(a)!);
}

/** D4's cap on vector-only results: vectorOnlyMax in the default k, scaled up for longer limits. */
export const vectorOnlyCap = (limit: number, cfg: RetrievalConfig): number => (limit > cfg.k ? Math.ceil((cfg.vectorOnlyMax * limit) / cfg.k) : cfg.vectorOnlyMax);

/** H (D4): RRF over the FTS and vector pools, walked to limit, skipping vector-only items past the cap. */
export function hybrid(fts: number[], vec: number[], limit: number, cfg: RetrievalConfig): Ranked {
  const lexical = new Set(fts);
  const cap = vectorOnlyCap(limit, cfg);
  const ids: number[] = [];
  let vectorOnly = 0;
  for (const id of rrf([fts, vec], cfg.rrfK)) {
    if (ids.length >= limit) break;
    if (!lexical.has(id)) {
      if (vectorOnly >= cap) continue;
      vectorOnly++;
    }
    ids.push(id);
  }
  return { ids, vectorOnly };
}

/** A ranker's top `limit` ids for a query text on one store; vectorOnly counts ids outside F-best's pool. */
export interface Ranked { ids: number[]; vectorOnly?: number }
export type Rank = (text: string, limit: number) => Promise<Ranked>;

/** F0-F2 on a store, and V:key and H:key per embedder (which needs its frozen floor). */
export async function rankers(view: StoreView, cfg: GateConfig, embedders: Embedder[] = []): Promise<Map<RankerName, Rank>> {
  const out = new Map<RankerName, Rank>(FTS_VARIANTS.map((v) => [v, async (text, limit) => ({ ids: view.fts(text, v, limit) })]));
  for (const e of embedders) {
    const tau = tauFor(cfg, e.key);
    if (!Number.isFinite(tau)) throw new Error(`${e.key} needs its frozen cosine floor (§2.4)`);
    const ix = await vectorIndex(view, e);
    const pools = async (text: string) => {
      const [q] = await e.embed([text], true);
      return { fts: view.fts(text, cfg.fBest, cfg.pool), vec: nearest(ix, q, tau, cfg.pool).map((h) => h.id) };
    };
    out.set(`V:${e.key}`, async (text, limit) => {
      const p = await pools(text);
      const lexical = new Set(p.fts);
      const ids = p.vec.slice(0, limit);
      return { ids, vectorOnly: ids.filter((id) => !lexical.has(id)).length };
    });
    out.set(`H:${e.key}`, async (text, limit) => {
      const p = await pools(text);
      return hybrid(p.fts, p.vec, limit, cfg);
    });
  }
  return out;
}

/** The largest cosine for a query over a store's items, unfloored (tau's input on S). */
export async function topCosine(ix: VectorIndex, e: Embedder, text: string): Promise<number> {
  const [q] = await e.embed([text], true);
  return nearest(ix, q, -Infinity, 1)[0]?.cos ?? 0;
}

// --- Metrics (§2.3) ---

/** recall@k = |relevant ∩ top k| / min(|relevant|, k); rr = 1 / rank of the first relevant id in deep, else 0; null without relevance. */
export function metrics(top: number[], deep: number[], relevant: number[], k: number): Pick<QueryScore, 'recall' | 'rr' | 'miss'> {
  if (!relevant.length) return { recall: null, rr: null, miss: null };
  const rel = new Set(relevant);
  const hits = top.slice(0, k).filter((id) => rel.has(id)).length;
  const first = deep.findIndex((id) => rel.has(id));
  return { recall: hits / Math.min(rel.size, k), rr: first < 0 ? 0 : 1 / (first + 1), miss: hits === 0 };
}

export async function scoreQueries(qs: RetrievalQuery[], ranks: Map<RankerName, Rank>, cfg: RetrievalConfig): Promise<QueryScore[]> {
  const out: QueryScore[] = [];
  for (const q of qs) {
    for (const [ranker, rank] of ranks) {
      const top = await rank(q.text, cfg.k);
      const deep = await rank(q.text, cfg.mrrK);
      out.push({
        query: q.id, set: q.set, tree: q.tree, cluster: q.cluster, ...(q.harness ? { harness: q.harness } : {}), ...(q.class ? { class: q.class } : {}),
        ranker, ...metrics(top.ids, deep.ids, q.relevant, cfg.k), returned: top.ids.length, ...(top.vectorOnly === undefined ? {} : { vectorOnly: top.vectorOnly }),
      });
    }
  }
  return out;
}

// --- Uncertainty (§2.3) ---

/** mulberry32: a small seeded PRNG, so a rerun with the same seed resamples identically. */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** The p-th percentile (0-100) of ascending xs, interpolating linearly between ranks. */
export function percentile(xs: number[], p: number): number {
  if (!xs.length) return NaN;
  const at = (p / 100) * (xs.length - 1);
  const lo = Math.floor(at);
  return lo + 1 < xs.length ? xs[lo] + (at - lo) * (xs[lo + 1] - xs[lo]) : xs[lo];
}

/** A value of one query, with what the bootstrap groups it by. */
export interface Row { tree: string; cluster: string; set: string; value: number }
type Sums = Map<string, { sum: number; n: number }>;

const add = (into: Sums, set: string, sum: number, n: number) => {
  const s = into.get(set) ?? { sum: 0, n: 0 };
  into.set(set, { sum: s.sum + sum, n: s.n + n });
};

/** Σ w · mean(set) / Σ w over the weighted sets: fixed weights, whatever each set's size. NaN when a weighted set is empty. */
function weightedOf(sums: Sums, weights: Record<string, number>): number {
  let total = 0, w = 0;
  for (const [set, ws] of Object.entries(weights)) {
    const s = sums.get(set);
    if (!s?.n) return NaN;
    total += ws * (s.sum / s.n);
    w += ws;
  }
  return total / w;
}

export function weightedMean(rows: Row[], weights: Record<string, number>): number {
  const sums: Sums = new Map();
  for (const r of rows) add(sums, r.set, r.value, 1);
  return weightedOf(sums, weights);
}

/**
 * The stratified cluster bootstrap's 95% CI of weightedMean: strata are trees, and each resample draws as many clusters
 * as the tree has, with replacement, from that tree alone, so a cluster brings all its queries of every set and no
 * tree is resampled empty. A resample that leaves a weighted set empty is dropped.
 */
export function bootstrap(rows: Row[], weights: Record<string, number>, cfg: Pick<RetrievalConfig, 'seed' | 'resamples'>): [number, number] {
  const strata = new Map<string, Map<string, Sums>>();
  for (const r of rows) {
    const tree = strata.get(r.tree) ?? new Map<string, Sums>();
    strata.set(r.tree, tree);
    const cl = tree.get(r.cluster) ?? new Map();
    tree.set(r.cluster, cl);
    add(cl, r.set, r.value, 1);
  }
  const trees = [...strata.keys()].sort().map((t) => [...strata.get(t)!].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([, s]) => s));
  const next = rng(cfg.seed);
  const stats: number[] = [];
  for (let b = 0; b < cfg.resamples; b++) {
    const sums: Sums = new Map();
    for (const clusters of trees) {
      for (let i = 0; i < clusters.length; i++) {
        for (const [set, s] of clusters[Math.floor(next() * clusters.length)]) add(sums, set, s.sum, s.n);
      }
    }
    const v = weightedOf(sums, weights);
    if (Number.isFinite(v)) stats.push(v);
  }
  stats.sort((a, b) => a - b);
  return [percentile(stats, 2.5), percentile(stats, 97.5)];
}

// --- Slices and comparisons ---

const inSlice = (s: QueryScore, sl: Slice) => (sl.set === 'primary' ? s.set === 'r1-title' || s.set === 'r2b' : s.set === sl.set)
  && (sl.tree === undefined || s.tree === sl.tree) && (sl.harness === undefined || s.harness === sl.harness) && (sl.class === undefined || s.class === sl.class);
const weightsOf = (sl: Slice, cfg: RetrievalConfig): Record<string, number> => (sl.set === 'primary' ? cfg.weights : { [sl.set]: 1 });
const sameSlice = (a: Slice, b: Slice) => a.set === b.set && a.tree === b.tree && a.harness === b.harness && a.class === b.class;

/** Per set; per tree (R1, R2b); per R2b harness; per R2a class; and the primary set when both its sets are present. */
export function slicesOf(scores: QueryScore[]): Slice[] {
  const out: Slice[] = [];
  const present = new Set(scores.filter((s) => s.recall !== null).map((s) => s.set));
  const distinct = <T>(xs: (T | undefined)[]) => [...new Set(xs.filter((x): x is T => x !== undefined))].sort();
  if (present.has('r1-title') && present.has('r2b')) out.push({ set: 'primary' });
  for (const set of SETS.filter((s) => present.has(s))) {
    const of = scores.filter((s) => s.set === set);
    out.push({ set });
    if (set === 'r1-title' || set === 'r1-brief' || set === 'r2b') for (const tree of distinct(of.map((s) => s.tree))) out.push({ set, tree });
    if (set === 'r2b') for (const harness of distinct(of.map((s) => s.harness))) out.push({ set, harness });
    if (set === 'r2a') for (const c of distinct(of.map((s) => s.class))) out.push({ set, class: c });
  }
  return out;
}

const estimate = (rows: Row[], weights: Record<string, number>, cfg: RetrievalConfig, ci: boolean): Estimate => {
  const value = weightedMean(rows, weights);
  return ci && rows.length ? { value, ci: bootstrap(rows, weights, cfg) } : { value };
};

export function sliceScore(scores: QueryScore[], sl: Slice, ranker: RankerName, cfg: RetrievalConfig): SliceScore {
  const of = scores.filter((s) => s.ranker === ranker && s.recall !== null && inSlice(s, sl));
  const rows = (f: (s: QueryScore) => number) => of.map((s) => ({ tree: s.tree, cluster: s.cluster, set: s.set, value: f(s) }));
  const w = weightsOf(sl, cfg);
  const ci = sl.set === 'primary';
  return {
    ...sl, ranker, queries: of.length, clusters: new Set(of.map((s) => `${s.tree}\0${s.cluster}`)).size,
    recallAtK: estimate(rows((s) => s.recall!), w, cfg, ci), mrr: estimate(rows((s) => s.rr!), w, cfg, ci), missAtK: estimate(rows((s) => (s.miss ? 1 : 0)), w, cfg, ci),
  };
}

/** ranker − baseline on the queries both scored, with its bootstrap CI; rescued and lost count miss@k flips. */
export function compare(scores: QueryScore[], sl: Slice, ranker: RankerName, baseline: RankerName, cfg: RetrievalConfig): Comparison | undefined {
  const base = new Map(scores.filter((s) => s.ranker === baseline && s.recall !== null && inSlice(s, sl)).map((s) => [s.query, s]));
  const pairs = scores.filter((s) => s.ranker === ranker && s.recall !== null && base.has(s.query)).map((s) => [s, base.get(s.query)!] as const);
  if (!pairs.length) return undefined;
  const rows = pairs.map(([s, b]) => ({ tree: s.tree, cluster: s.cluster, set: s.set, value: s.recall! - b.recall! }));
  return {
    ...sl, ranker, baseline, deltaRecallAtK: estimate(rows, weightsOf(sl, cfg), cfg, true),
    rescued: pairs.filter(([s, b]) => b.miss && !s.miss).length, lost: pairs.filter(([s, b]) => !b.miss && s.miss).length,
  };
}

// --- The §2.4 configuration freeze ---

/** The F variant with the highest R2a recall@k; a tie goes to the simpler (earlier) variant. */
export function fBestOf(r2a: QueryScore[]): FtsVariant {
  const recall = (v: FtsVariant) => weightedMean(r2a.filter((s) => s.ranker === v && s.recall !== null).map((s) => ({ ...s, value: s.recall! })), { r2a: 1 });
  return FTS_VARIANTS.reduce((best, v) => (recall(v) > recall(best) ? v : best));
}

/** tau: the 95th percentile of top-1 cosine for irrelevant queries on the 20k S stores, pooled across trees. */
export const tauOf = (top1: number[]): number => percentile([...top1].sort((a, b) => a - b), 95);

export const configPath = (root: string): string => join(root, 'results', 'retrieval-config.json');

/**
 * §2.4 step 1: the first computed configuration with a tau is written and is final. Later runs use the file and report
 * any key where their own computation differs: re-tuning means a new pre-registration (delete the file and say so).
 * A configuration without tau (no embedder) scores FTS only and is never written.
 */
export function freeze(root: string, computed: GateConfig): { config: GateConfig; written: boolean; differs: string[] } {
  const path = configPath(root);
  if (existsSync(path)) {
    const config = JSON.parse(readFileSync(path, 'utf8')) as GateConfig;
    const differs = (Object.keys(computed) as (keyof GateConfig)[])
      .filter((k) => !(k === 'tau' && !Number.isFinite(computed.tau)) && JSON.stringify(config[k]) !== JSON.stringify(computed[k]));
    return { config, written: false, differs };
  }
  if (!Number.isFinite(computed.tau)) return { config: computed, written: false, differs: [] };
  mkdirSync(join(root, 'results'), { recursive: true });
  writeFileSync(path, `${JSON.stringify(computed, null, 2)}\n`, { flag: 'wx' });
  return { config: computed, written: true, differs: [] };
}

// --- R2a: the authored fixture (§2.2) and R3: Layer A's search assertions (§2.5 G1) ---

const FIXTURES = fileURLToPath(new URL('../fixtures/', import.meta.url));
const R2A = join(FIXTURES, 'retrieval');

export const layerAFixtures = (): Fixture[] => readdirSync(FIXTURES).filter((f) => f.endsWith('.json') && f !== 'floors.json').sort()
  .map((f) => JSON.parse(readFileSync(join(FIXTURES, f), 'utf8')) as Fixture);
export const r2aCorpus = (): Fixture => JSON.parse(readFileSync(join(R2A, 'corpus.json'), 'utf8')) as Fixture;
export const r2aNeeds = (): Need[] => JSON.parse(readFileSync(join(R2A, 'needs.json'), 'utf8')) as Need[];
export interface R2aFloors { recallAtK: Record<FtsVariant, number>; mrr: Record<FtsVariant, number> }
export const r2aFloors = (): R2aFloors => JSON.parse(readFileSync(join(R2A, 'floors.json'), 'utf8')) as R2aFloors;

/**
 * The R2a store: corpus.json's targets replayed through Case, plus every Layer A fixture's items (each fixture replayed
 * on its own, then its rows copied into the corpus repo, retractions kept), so no fixture's labels or nodes collide.
 */
export class R2a {
  readonly case: Case;
  readonly repoKey: string;
  readonly queries: RetrievalQuery[];

  constructor(corpus = r2aCorpus(), needs = r2aNeeds(), layerA = layerAFixtures()) {
    this.case = new Case(corpus);
    this.case.replay();
    const [alias] = Object.keys(corpus.repos);
    this.repoKey = corpus.repos[alias];
    const db = new DatabaseSync(this.file);
    try {
      const repo = (db.prepare('SELECT id FROM repos WHERE key = ?').get(this.repoKey) as { id: number }).id;
      const insert = db.prepare(`INSERT INTO items (repo_id, kind, text, body, author, node_id, root_id, harness, model, dedupe, seen, pinned,
        created_at, updated_at, invalid_at, invalid_kind, invalid_by, invalid_reason) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
      for (const fx of layerA) {
        const c = new Case(fx);
        try {
          c.replay();
          for (const r of c.rows()) {
            insert.run(repo, r.kind, r.text, r.body, r.author, r.node_id, r.root_id, r.harness, r.model, `${fx.name}\0${r.repo_key}\0${r.dedupe}`, r.seen, r.pinned,
              r.created_at, r.updated_at, r.invalid_at, r.invalid_kind, r.invalid_by, r.invalid_reason);
          }
        } finally {
          c.close();
        }
      }
    } finally {
      db.close();
    }
    this.queries = needs.flatMap((n) => n.queries.map((q, i) => ({
      id: `r2a/${n.id}/${i}`, set: 'r2a' as const, text: q.text, class: q.class, tree: 'r2a', cluster: n.id, asOf: this.case.now, relevant: n.relevant.map((l) => this.case.id(l)),
    })));
  }

  get file(): string {
    return this.case.store.accountFile(undefined);
  }

  view(): StoreView {
    return new StoreView(this.file, this.repoKey);
  }

  close(): void {
    this.case.close();
  }
}

export interface R3 { pass: boolean; failures: string[] }

/** §2.5 G1 per ranker: Layer A's search includes and excludes hold, first is in the top 3, and no retracted item is found by its own text. */
export async function r3(ranksFor: (view: StoreView) => Promise<Map<RankerName, Rank>>, k: number, fixtures = layerAFixtures()): Promise<Map<RankerName, R3>> {
  const out = new Map<RankerName, R3>();
  const fail = (r: RankerName, f?: string) => {
    const x = out.get(r) ?? { pass: true, failures: [] };
    if (f) x.failures.push(f);
    x.pass = !x.failures.length;
    out.set(r, x);
  };
  for (const fx of fixtures) {
    const c = new Case(fx);
    const views: StoreView[] = [];
    try {
      c.replay();
      const ranks = new Map<string, Map<RankerName, Rank>>();
      const of = async (repo: string) => {
        if (!ranks.has(repo)) {
          const v = new StoreView(c.store.accountFile(undefined), c.scope(repo).repoKey);
          views.push(v);
          ranks.set(repo, await ranksFor(v));
        }
        return ranks.get(repo)!;
      };
      const rows = new Map(c.rows().map((r) => [r.id, r]));
      for (const s of fx.searches ?? []) {
        for (const [name, rank] of await of(s.repo)) {
          const { ids } = await rank(s.query, k);
          const what = `${fx.name}: search ${JSON.stringify(s.query)}`;
          fail(name);
          if (s.first && !ids.slice(0, 3).includes(c.id(s.first))) fail(name, `${what}: ${s.first} not in the top 3`);
          for (const l of s.includes ?? []) if (!ids.includes(c.id(l))) fail(name, `${what}: lacks ${l}`);
          for (const l of s.excludes ?? []) if (ids.includes(c.id(l))) fail(name, `${what}: has ${l}`);
        }
      }
      for (const q of fx.queries ?? []) {
        for (const l of q.forbidden ?? []) {
          const r = rows.get(c.id(l))!;
          if (r.invalid_at === null || !r.text) continue;
          for (const [name, rank] of await of(q.repo)) {
            fail(name);
            if ((await rank(r.text, k)).ids.includes(r.id)) fail(name, `${fx.name}: retracted ${l} found by its text`);
          }
        }
      }
    } finally {
      for (const v of views) v.close();
      c.close();
    }
  }
  return out;
}

// --- The result and the §2.5 verdict ---

export interface EvalInput {
  config: GateConfig;
  scores: QueryScore[];
  noise: Noise[];
  r3: Map<RankerName, R3>;
  rankers: RankerName[];
  /** Exploratory embedder keys. */
  exploratory: string[];
}

export function evaluate(input: EvalInput): RetrievalResult {
  const { config: cfg, scores, rankers } = input;
  const slices = slicesOf(scores);
  const comparisons: Comparison[] = [];
  for (const sl of slices) {
    for (const r of rankers) {
      const baselines: RankerName[] = r.startsWith('F') ? (r === 'F0' ? [] : ['F0']) : [cfg.fBest];
      for (const b of baselines) {
        const c = compare(scores, sl, r, b, cfg);
        if (c) comparisons.push(c);
      }
    }
  }
  const sets = SETS.filter((s) => scores.some((x) => x.set === s) || (s === 's-irrelevant' && input.noise.length));
  const partial = {
    version: RESULT_VERSION, generatedAt: new Date().toISOString(), config: cfg, sets, rankers, exploratory: input.exploratory,
    queries: scores, slices: slices.flatMap((sl) => rankers.map((r) => sliceScore(scores, sl, r, cfg))), comparisons, noise: input.noise,
  } satisfies Omit<RetrievalResult, 'verdict'>;
  return { ...partial, verdict: verdict(partial, input.r3) };
}

/** false when any is false, else null when any is null, else true. */
const all = (xs: (boolean | null)[]): boolean | null => (xs.includes(false) ? false : xs.includes(null) ? null : true);
const f3 = (x: number) => (Number.isFinite(x) ? x.toFixed(3) : 'n/a');
const signed = (x: number) => (x >= 0 ? `+${f3(x)}` : f3(x));
const ciText = (e: Estimate) => (e.ci ? ` [${signed(e.ci[0])}, ${signed(e.ci[1])}]` : '');

type Scored = Omit<RetrievalResult, 'verdict'>;
const findComparison = (r: Scored, sl: Slice, ranker: RankerName, baseline: RankerName) =>
  r.comparisons.find((c) => sameSlice(c, sl) && c.ranker === ranker && c.baseline === baseline);
const findSlice = (r: Scored, sl: Slice, ranker: RankerName) => r.slices.find((s) => sameSlice(s, sl) && s.ranker === ranker);

/** P1 for a hybrid ranker against F-best: Δrecall@k ≥ +0.08 on the primary set, CI lower bound ≥ +0.02. */
function p1(r: Scored, ranker: RankerName): Criterion {
  const c = findComparison(r, { set: 'primary' }, ranker, r.config.fBest);
  if (!c?.deltaRecallAtK.ci) return { id: 'P1', pass: null, detail: `no primary set for ${ranker} (needs R1-title and R2b)` };
  const d = c.deltaRecallAtK;
  return { id: 'P1', pass: d.value >= 0.08 && d.ci![0] >= 0.02, detail: `Δrecall@${r.config.k} ${ranker} − ${r.config.fBest} ${signed(d.value)}${ciText(d)}; needs ≥ +0.080 with a lower bound ≥ +0.020` };
}

/** G3 for any ranker against a baseline: R1-brief and R2a-lexical Δrecall@k ≥ −0.02. */
function g3(r: Scored, ranker: RankerName, baseline: RankerName): Criterion {
  const parts = ([{ set: 'r1-brief' }, { set: 'r2a', class: 'lexical' }] as Slice[]).map((sl) => {
    const c = findComparison(r, sl, ranker, baseline);
    const name = sl.class ? `${sl.set}-${sl.class}` : sl.set;
    return c ? { pass: c.deltaRecallAtK.value >= -0.02, text: `${name} ${signed(c.deltaRecallAtK.value)}` } : { pass: null, text: `${name} not scored` };
  });
  return { id: 'G3', pass: all(parts.map((p) => p.pass)), detail: `${parts.map((p) => p.text).join('; ')}; each needs ≥ −0.020` };
}

function g1(r3s: Map<RankerName, R3>, ranker: RankerName): Criterion {
  const x = r3s.get(ranker);
  if (!x) return { id: 'G1', pass: null, detail: `R3 not run for ${ranker}` };
  return { id: 'G1', pass: x.pass, detail: x.pass ? 'every Layer A search assertion holds (first relaxed to the top 3)' : x.failures.slice(0, 5).join('; ') };
}

export function verdict(r: Scored, r3s: Map<RankerName, R3>, candidate: RankerName = CANDIDATE): RetrievalResult['verdict'] {
  const cfg = r.config;
  const fb = cfg.fBest;
  const criteria: Criterion[] = [p1(r, candidate)];

  const pf = findSlice(r, { set: 'primary' }, fb), ph = findSlice(r, { set: 'primary' }, candidate);
  criteria.push(pf && ph && ph.queries
    ? {
      id: 'P2', pass: pf.missAtK.value >= 0.2 && ph.missAtK.value <= 0.75 * pf.missAtK.value,
      detail: `primary miss@${cfg.k} ${fb} ${f3(pf.missAtK.value)} (needs ≥ 0.200), ${candidate} ${f3(ph.missAtK.value)} (needs ≤ ${f3(0.75 * pf.missAtK.value)})`,
    }
    : { id: 'P2', pass: null, detail: `no primary set for ${candidate}` });

  criteria.push(g1(r3s, candidate));

  const g2 = r.comparisons.filter((c) => c.ranker === candidate && c.baseline === fb
    && ((c.set === 'r2b' && c.harness !== undefined) || (c.set === 'r1-title' && c.tree !== undefined)));
  const g2Bad = g2.filter((c) => c.deltaRecallAtK.value < -0.03);
  const haveR2b = g2.some((c) => c.set === 'r2b');
  criteria.push({
    id: 'G2', pass: !g2.length ? null : g2Bad.length ? false : haveR2b ? true : null,
    detail: `${g2.map((c) => `${c.harness ?? c.tree} ${signed(c.deltaRecallAtK.value)}`).join(', ') || 'no slices'}; each needs ≥ −0.030${haveR2b ? '' : ' (R2b harness slices missing)'}`,
  });

  criteria.push({ ...g3(r, candidate, fb) });

  const g4 = [...new Set(r.noise.map((n) => `${n.tree}\0${n.items}`))].map((key) => {
    const at = r.noise.filter((n) => `${n.tree}\0${n.items}` === key);
    const h = at.find((n) => n.ranker === candidate), f = at.find((n) => n.ranker === fb);
    if (!h || !f) return { pass: null, text: `${key.replace('\0', '@')} not scored` };
    return {
      pass: h.meanReturned <= f.meanReturned + 0.5 && h.meanVectorOnly <= 1,
      text: `${h.tree}@${h.items}: returned ${f3(h.meanReturned)} vs ${fb} ${f3(f.meanReturned)}, vector-only ${f3(h.meanVectorOnly)}`,
    };
  });
  criteria.push({ id: 'G4', pass: g4.length ? all(g4.map((x) => x.pass)) : null, detail: g4.length ? `${g4.map((x) => x.text).join('; ')}; needs returned ≤ ${fb} + 0.5 and vector-only ≤ 1.0` : 'S not scored' });

  criteria.push({ id: 'G5', pass: null, detail: 'measured in a scratch daemon with 20k items (§2.5 G5), not by this bench' });

  // FTS tuning (§2.5): F1 or F2 over F0 by ≥ +0.03 on the primary set, CI lower bound > 0, with G1 and G3 holding.
  let ftsTuning: FtsVariant | undefined;
  let best = -Infinity;
  for (const v of ['F1', 'F2'] as const) {
    const c = findComparison(r, { set: 'primary' }, v, 'F0');
    if (!c?.deltaRecallAtK.ci) continue;
    const ok = c.deltaRecallAtK.value >= 0.03 && c.deltaRecallAtK.ci[0] > 0 && g1(r3s, v).pass === true && g3(r, v, 'F0').pass === true;
    if (ok && c.deltaRecallAtK.value > best) [ftsTuning, best] = [v, c.deltaRecallAtK.value];
  }
  return { ship: all(criteria.map((c) => c.pass)), criteria, ...(ftsTuning ? { ftsTuning } : {}) };
}

/** The §2.5 report: the frozen configuration, the primary numbers, each criterion, the verdict and what does not decide it. */
export function printVerdict(r: RetrievalResult): string {
  const cfg: GateConfig = r.config;
  const mark = (p: boolean | null) => (p === null ? 'n/a ' : p ? 'pass' : 'FAIL');
  const floors = Object.entries(cfg.exploratoryTau ?? {}).map(([k, t]) => `${k} ${f3(t)}`).join(', ');
  const lines = [
    `Memory v4 retrieval gate (plan §2.5), ${r.generatedAt}`,
    `Frozen configuration: tau ${f3(cfg.tau)}, F-best ${cfg.fBest}, seed ${cfg.seed}, ${cfg.resamples} resamples, RRF k ${cfg.rrfK}, pool ${cfg.pool}, `
      + `vector-only ≤ ${cfg.vectorOnlyMax} of ${cfg.k}, weights R1-title ${cfg.weights['r1-title']} / R2b ${cfg.weights.r2b}`
      + `${floors ? `; exploratory floors ${floors}` : ''}`,
    `Sets: ${r.sets.join(', ')}; rankers: ${r.rankers.join(', ')}`,
    '',
    'Slice                       Ranker     Queries  recall@8          MRR@20  miss@8',
  ];
  for (const s of r.slices) {
    const name = [s.set, s.tree ?? s.harness ?? s.class].filter(Boolean).join(' ');
    lines.push(`${name.padEnd(28)}${s.ranker.padEnd(11)}${String(s.queries).padStart(7)}  ${(f3(s.recallAtK.value) + ciText(s.recallAtK)).padEnd(18)}${f3(s.mrr.value).padStart(6)}  ${f3(s.missAtK.value)}`);
  }
  lines.push('', 'Comparison (Δrecall@8)                    Δ                         rescued/lost');
  for (const c of r.comparisons) {
    const name = [c.set, c.tree ?? c.harness ?? c.class].filter(Boolean).join(' ');
    lines.push(`${`${name}: ${c.ranker} − ${c.baseline}`.padEnd(42)}${(signed(c.deltaRecallAtK.value) + ciText(c.deltaRecallAtK)).padEnd(26)}${c.rescued}/${c.lost}`);
  }
  if (r.noise.length) {
    lines.push('', 'Noise on S (irrelevant queries)   items  ranker     returned  vector-only');
    for (const n of r.noise) lines.push(`${n.tree.padEnd(34)}${String(n.items).padStart(5)}  ${n.ranker.padEnd(11)}${f3(n.meanReturned).padStart(8)}  ${f3(n.meanVectorOnly).padStart(11)}`);
  }
  lines.push('', `Criteria for ${CANDIDATE} against ${cfg.fBest}:`);
  for (const c of r.verdict.criteria) lines.push(`  ${c.id} ${mark(c.pass)}  ${c.detail}`);
  const v = r.verdict.ship;
  lines.push('', `Verdict: ${v === true ? 'SHIP v4 (potion)' : v === false ? 'NO SHIP: v4 stops here' : 'INCOMPLETE: a criterion was not evaluated in this run'}`);
  lines.push(`FTS tuning: ${r.verdict.ftsTuning ? `recommend ${r.verdict.ftsTuning} as a separate search-only PR` : 'no variant clears +0.03 over F0 with G1 and G3'}`);
  for (const key of r.exploratory) {
    const c = p1(r, `H:${key}`);
    lines.push(`Exploratory H:${key}: P1 ${mark(c.pass)} (${c.detail}); recorded only, never deciding (§8 Q1)`);
  }
  return lines.join('\n');
}

export const GOLDEN = join(R2A, 'wordpiece-golden.json');

/**
 * run.ts retrieval --golden: the reference tokenizer's ids for the edge cases and every R2a corpus text (authored, so
 * committable), written to fixtures/retrieval/wordpiece-golden.json for W1's in-tree WordPiece.
 */
export async function golden(o: { root: string; deps?: string }): Promise<string> {
  if (!o.deps) throw new Error('--golden needs --deps (the reference tokenizer)');
  const r = new R2a();
  let texts: string[];
  try {
    texts = r.case.rows().filter((x) => x.text).map((x) => `${x.text}\n${x.body}`);
  } finally {
    r.close();
  }
  const { cases, ...head } = await wordpieceGolden(o.root, o.deps, texts);
  // One case per line, so a diff shows which texts changed.
  writeFileSync(GOLDEN, `${JSON.stringify(head).slice(0, -1)},"cases":[\n${cases.map((c) => JSON.stringify(c)).join(',\n')}\n]}\n`);
  return GOLDEN;
}

/** <root>/results/<name>-<date>.json: ids and numbers only. */
export function writeResult(root: string, name: string, r: RetrievalResult): string {
  const dir = join(root, 'results');
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${name}-${r.generatedAt.slice(0, 10)}.json`);
  writeFileSync(path, `${JSON.stringify(r, null, 2)}\n`);
  return path;
}
