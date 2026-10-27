// The retrieval evaluator: the product's memory search (MemoryStore.search) as a ranker, per-query metrics, slices and
// the result file, plus the R2a fixture. Results hold ids and numbers, never text.
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { MemoryScope } from '../../../src/daemon/memory-schema.js';
import type { MemoryStore } from '../../../src/daemon/memory-store.js';
import { Case, type Fixture } from '../lib/fixture.js';
import type { Need, QueryScore, RetrievalQuery, RetrievalResult, SliceScore } from './types.js';

/** recall@k and miss@k. */
export const K = 8;
/** MRR cut-off. */
export const MRR_K = 20;

/** Item ids, best first. */
export type Rank = (text: string, limit: number) => number[];

/** The product's search on one repo of a store. */
export const searchRank = (store: MemoryStore, scope: MemoryScope): Rank => (query, limit) => store.search(scope, { query, limit }).map((v) => v.id);

// --- Metrics ---

/** recall@k = |relevant ∩ top k| / min(|relevant|, k); rr = 1 / rank of the first relevant id in ranked, else 0. */
export function metrics(ranked: number[], relevant: number[], k = K): Pick<QueryScore, 'recall' | 'rr' | 'miss'> {
  const rel = new Set(relevant);
  const hits = ranked.slice(0, k).filter((id) => rel.has(id)).length;
  const first = ranked.findIndex((id) => rel.has(id));
  return { recall: hits / Math.min(rel.size, k), rr: first < 0 ? 0 : 1 / (first + 1), miss: hits === 0 };
}

export function scoreQueries(qs: RetrievalQuery[], rank: Rank): QueryScore[] {
  return qs.map((q) => {
    const ranked = rank(q.text, MRR_K);
    return {
      query: q.id, set: q.set, tree: q.tree, ...(q.class ? { class: q.class } : {}),
      ...metrics(ranked, q.relevant), returned: Math.min(ranked.length, K),
    };
  });
}

const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;

/** Per set; per tree (R1); per class (R2a). */
export function slicesOf(scores: QueryScore[]): SliceScore[] {
  const out: SliceScore[] = [];
  const slice = (sl: Omit<SliceScore, 'queries' | 'recallAtK' | 'mrr' | 'missAtK'>, of: QueryScore[]) => out.push({
    ...sl, queries: of.length, recallAtK: mean(of.map((s) => s.recall)), mrr: mean(of.map((s) => s.rr)), missAtK: mean(of.map((s) => (s.miss ? 1 : 0))),
  });
  for (const set of [...new Set(scores.map((s) => s.set))]) {
    const of = scores.filter((s) => s.set === set);
    slice({ set }, of);
    if (set === 'r2a') for (const c of [...new Set(of.map((s) => s.class!))].sort()) slice({ set, class: c }, of.filter((s) => s.class === c));
    else for (const tree of [...new Set(of.map((s) => s.tree))].sort()) slice({ set, tree }, of.filter((s) => s.tree === tree));
  }
  return out;
}

export const result = (scores: QueryScore[]): RetrievalResult => ({ generatedAt: new Date().toISOString(), queries: scores, slices: slicesOf(scores) });

export function printResult(r: RetrievalResult): string {
  const f3 = (x: number) => x.toFixed(3);
  const lines = [`Memory search retrieval, ${r.generatedAt}`, '', `Slice                       Queries  recall@${K}  MRR@${MRR_K}  miss@${K}`];
  for (const s of r.slices) {
    const name = [s.set, s.tree ?? s.class].filter(Boolean).join(' ');
    lines.push(`${name.padEnd(28)}${String(s.queries).padStart(7)}  ${f3(s.recallAtK).padStart(8)}  ${f3(s.mrr).padStart(6)}  ${f3(s.missAtK).padStart(6)}`);
  }
  return lines.join('\n');
}

/** <root>/results/<name>-<date>.json: ids and numbers only. */
export function writeResult(root: string, name: string, r: RetrievalResult): string {
  const dir = join(root, 'results');
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${name}-${r.generatedAt.slice(0, 10)}.json`);
  writeFileSync(path, `${JSON.stringify(r, null, 2)}\n`);
  return path;
}

// --- R2a: the authored fixture ---

const FIXTURES = fileURLToPath(new URL('../fixtures/', import.meta.url));
const R2A = join(FIXTURES, 'retrieval');

export const layerAFixtures = (): Fixture[] => readdirSync(FIXTURES).filter((f) => f.endsWith('.json') && f !== 'floors.json').sort()
  .map((f) => JSON.parse(readFileSync(join(FIXTURES, f), 'utf8')) as Fixture);
export const r2aCorpus = (): Fixture => JSON.parse(readFileSync(join(R2A, 'corpus.json'), 'utf8')) as Fixture;
export const r2aNeeds = (): Need[] => JSON.parse(readFileSync(join(R2A, 'needs.json'), 'utf8')) as Need[];
export interface R2aFloors { recallAtK: number; mrr: number }
export const r2aFloors = (): R2aFloors => JSON.parse(readFileSync(join(R2A, 'floors.json'), 'utf8')) as R2aFloors;

/**
 * The R2a store: corpus.json's targets replayed through Case, plus every Layer A fixture's items (each fixture replayed
 * on its own, then its rows copied into the corpus repo, retractions kept), so no fixture's labels or nodes collide.
 */
export class R2a {
  readonly case: Case;
  readonly rank: Rank;
  readonly queries: RetrievalQuery[];

  constructor(corpus = r2aCorpus(), needs = r2aNeeds(), layerA = layerAFixtures()) {
    this.case = new Case(corpus);
    this.case.replay();
    const [alias] = Object.keys(corpus.repos);
    const scope = this.case.scope(alias);
    this.rank = searchRank(this.case.store, scope);
    const db = new DatabaseSync(this.case.store.accountFile(undefined));
    try {
      const repo = (db.prepare('SELECT id FROM repos WHERE key = ?').get(scope.repoKey) as { id: number }).id;
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
      id: `r2a/${n.id}/${i}`, set: 'r2a' as const, text: q.text, class: q.class, tree: 'r2a', relevant: n.relevant.map((l) => this.case.id(l)),
    })));
  }

  close(): void {
    this.case.close();
  }
}
