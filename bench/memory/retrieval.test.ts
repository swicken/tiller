// The retrieval evaluator (memory-v4 plan §5, Gate): hand-worked metric, fusion and bootstrap examples, the R2a
// fixture's validity, its FTS floors, the verdict, the config freeze and replay.ts's guards. Synthetic data only.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { ArchivedNode } from '../../src/shared/protocol.js';
import { ftsTerms } from '../../src/daemon/memory-schema.js';
import type { Tree } from './lib/archive.js';
import { Case, type Fixture } from './lib/fixture.js';
import { readSafetensors } from './retrieval/embedders.js';
import {
  bootstrap, configPath, evaluate, fBestOf, freeze, hybrid, layerAFixtures, makeConfig, metrics, percentile, R2a, r2aFloors, r2aNeeds,
  rankers, rrf, scoreQueries, StoreView, tauOf, vectorOnlyCap, weightedMean, type R3, type Row,
} from './retrieval/eval.js';
import { verify } from './retrieval/models.js';
import type { FtsVariant, Noise, QueryScore, RankerName } from './retrieval/types.js';
import { checkRoot, distractors, gate, scaledStores, scoreTree } from './replay.js';

const cfg = makeConfig(NaN, 'F0');
const cleanup: (() => void)[] = [];
afterEach(() => { while (cleanup.length) cleanup.pop()!(); });
const scratch = (prefix: string) => {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
};

describe('metrics', () => {
  it('gives recall@8, MRR@20 and miss@8 on a 3-query hand example', () => {
    // q1: both relevant in the top 8 (ranks 2, 4): recall 2/2, rr 1/2.
    const q1 = metrics([5, 1, 7, 2, 9], [5, 1, 7, 2, 9], [1, 2], 8);
    // q2: the one relevant id is 9th: a miss at 8, rr 1/9 at 20.
    const deep2 = [4, 5, 6, 7, 8, 9, 10, 11, 3];
    const q2 = metrics(deep2.slice(0, 8), deep2, [3], 8);
    // q3: 10 relevant, 4 of them in the top 8 (first at rank 3): recall 4 / min(10, 8), rr 1/3.
    const top3 = [20, 21, 1, 2, 22, 3, 4, 23];
    const q3 = metrics(top3, top3, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 8);
    expect([q1, q2, q3]).toEqual([{ recall: 1, rr: 0.5, miss: false }, { recall: 0, rr: 1 / 9, miss: true }, { recall: 0.5, rr: 1 / 3, miss: false }]);
    const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
    expect(mean([q1, q2, q3].map((q) => q.recall!))).toBeCloseTo(0.5, 12);
    expect(mean([q1, q2, q3].map((q) => q.rr!))).toBeCloseTo((1 / 2 + 1 / 9 + 1 / 3) / 3, 12);
    expect(mean([q1, q2, q3].map((q) => (q.miss ? 1 : 0)))).toBeCloseTo(1 / 3, 12);
    expect(metrics([1, 2], [1, 2], [], 8)).toEqual({ recall: null, rr: null, miss: null });
  });
});

describe('fusion', () => {
  it('fuses two lists by 1 / (60 + rank), ties in first-appearance order', () => {
    // 3: 1/63 + 1/61; 1: 1/61; 2 and 4: 1/62 each, 2 seen first.
    expect(rrf([[1, 2, 3], [3, 4]], 60)).toEqual([3, 1, 2, 4]);
  });

  it('caps vector-only results at 3 of 8 and scales the cap for longer limits', () => {
    // RRF over FTS [1, 2] and vectors [10, 11, 12, 13, 1]: 1 (1/61 + 1/65), 10 (1/61), 2 and 11 (1/62), 12, 13.
    // 10, 11 and 12 are vector-only; 13 would be the fourth, so it is skipped.
    const c = { ...cfg, rrfK: 60, vectorOnlyMax: 3, k: 8 };
    expect(hybrid([1, 2], [10, 11, 12, 13, 1], 8, c)).toEqual({ ids: [1, 10, 2, 11, 12], vectorOnly: 3 });
    expect(hybrid([1, 2], [10, 11, 12, 13, 1], 2, c)).toEqual({ ids: [1, 10], vectorOnly: 1 });
    expect([vectorOnlyCap(4, c), vectorOnlyCap(8, c), vectorOnlyCap(20, c), vectorOnlyCap(50, c)]).toEqual([3, 3, 8, 19]);
  });
});

describe('uncertainty', () => {
  const rows = (tree: string, cluster: string, values: number[], set = 'r1-title'): Row[] => values.map((value) => ({ tree, cluster, set, value }));

  it('resamples within strata: no tree is ever drawn empty', () => {
    // Tree a is all 0 and tree b all 1, two clusters of one query each: every stratified resample has 2 of each, mean 0.5.
    const r = [...rows('a', 'a1', [0]), ...rows('a', 'a2', [0]), ...rows('b', 'b1', [1]), ...rows('b', 'b2', [1])];
    expect(bootstrap(r, { 'r1-title': 1 }, cfg)).toEqual([0.5, 0.5]);
  });

  it('is wider by cluster than by query when a cluster moves together, and deterministic for a seed', () => {
    // Four clusters of five identical queries: 0, 0, 1, 1.
    const byCluster = ['c1', 'c2', 'c3', 'c4'].flatMap((c, i) => rows('t', c, Array(5).fill(i < 2 ? 0 : 1)));
    const byQuery = byCluster.map((r, i) => ({ ...r, cluster: `q${i}` }));
    const [lo, hi] = bootstrap(byCluster, { 'r1-title': 1 }, cfg);
    const [qlo, qhi] = bootstrap(byQuery, { 'r1-title': 1 }, cfg);
    expect(hi - lo).toBeGreaterThan(qhi - qlo);
    // Four clusters drawn with replacement: all four of one value happens with probability 2/16 > 5%, so the CI spans [0, 1].
    expect([lo, hi]).toEqual([0, 1]);
    // Distinct values, so percentiles move with the draws: one seed repeats exactly, another differs.
    const spread = byQuery.map((r, i) => ({ ...r, value: i / 19 }));
    const once = bootstrap(spread, { 'r1-title': 1 }, cfg);
    expect(bootstrap(spread, { 'r1-title': 1 }, cfg)).toEqual(once);
    expect(bootstrap(spread, { 'r1-title': 1 }, { ...cfg, seed: 1 })).not.toEqual(once);
  });

  it('keeps the 50/50 primary weights whatever the set sizes', () => {
    const w = cfg.weights;
    expect(weightedMean([...rows('t', 'c', Array(10).fill(1)), ...rows('t', 'c', [0], 'r2b')], w)).toBe(0.5);
    expect(weightedMean([...rows('t', 'c', Array(100).fill(1)), ...rows('t', 'c', [0], 'r2b')], w)).toBe(0.5);
    expect(weightedMean(rows('t', 'c', [1]), w)).toBeNaN();
  });

  it('takes tau as the 95th percentile, interpolated', () => {
    // 0.1..1.0: rank 0.95 · 9 = 8.55, so 0.9 + 0.55 · 0.1.
    expect(tauOf([0.5, 0.1, 1.0, 0.3, 0.7, 0.2, 0.9, 0.4, 0.8, 0.6])).toBeCloseTo(0.955, 12);
    expect(percentile([1, 2, 3, 4], 50)).toBe(2.5);
    expect(percentile([7], 2.5)).toBe(7);
  });
});

describe('FTS variants', () => {
  const fx: Fixture = {
    name: 'fts', claim: 0, now: '2026-10-20T12:00:00Z', repos: { r: 'git:bench.invalid/fts' },
    episodes: [
      { at: '-3d', repo: 'r', actor: 'human', op: { type: 'add', kind: 'note', text: 'The scheduler drops jobs at midnight', label: 'sched' } },
      { at: '-2d', repo: 'r', actor: 'human', op: { type: 'add', kind: 'note', text: 'Release notes', body: 'midnight builds are tagged nightly', label: 'body' } },
      { at: '-1d', repo: 'r', actor: 'human', op: { type: 'add', kind: 'note', text: 'Old midnight rule', label: 'gone' } },
      { at: '-1d+1m', repo: 'r', actor: 'human', op: { type: 'forget', match: '@gone', reason: 'wrong' } },
    ],
  };
  let c: Case;
  let view: StoreView;
  beforeAll(() => {
    c = new Case(fx);
    c.replay();
    view = new StoreView(c.store.accountFile(undefined), fx.repos.r);
  });
  afterAll(() => {
    view.close();
    c.close();
  });

  it('F0 is MemoryStore.search, F2 adds prefixes for 5+ character terms, retracted items never match', () => {
    expect(view.fts('midnight', 'F0', 8)).toEqual(c.store.search(c.scope('r'), { query: 'midnight' }).map((v) => v.id));
    expect(view.fts('midnight', 'F0', 8)).not.toContain(c.id('@gone'));
    expect(view.fts('sched', 'F0', 8)).toEqual([]);
    expect(view.fts('sched', 'F2', 8)).toEqual([c.id('@sched')]);
    expect(view.fts('the of', 'F1', 8)).toEqual([]);
  });

  it('F0 matches Layer A search for every fixture search', () => {
    for (const lfx of layerAFixtures().filter((f) => f.searches?.length)) {
      const lc = new Case(lfx);
      try {
        lc.replay();
        for (const s of lfx.searches!) {
          const v = new StoreView(lc.store.accountFile(undefined), lc.scope(s.repo).repoKey);
          expect(v.fts(s.query, 'F0', 8), `${lfx.name}: ${s.query}`).toEqual(lc.store.search(lc.scope(s.repo), { query: s.query }).map((x) => x.id));
          v.close();
        }
      } finally {
        lc.close();
      }
    }
  });
});

describe('R2a fixture', () => {
  let r: R2a;
  beforeAll(() => { r = new R2a(); });
  afterAll(() => r?.close());
  const needs = r2aNeeds();
  /** ftsTerms tokens of a whole text, uncapped: ftsTerms per whitespace-separated chunk. */
  const tokens = (s: string) => new Set(s.split(/\s+/).flatMap((chunk) => ftsTerms(chunk, Infinity)));

  it('has at least 350 items, 40 needs (10 with zero relevance), and one lexical, two paraphrase, one synonym and one harness query each', () => {
    expect(r.case.rows().length).toBeGreaterThanOrEqual(350);
    expect(needs).toHaveLength(40);
    expect(needs.filter((n) => !n.relevant.length)).toHaveLength(10);
    expect(new Set(needs.map((n) => n.id)).size).toBe(40);
    for (const n of needs) expect(n.queries.map((q) => q.class).sort(), n.id).toEqual(['harness-phrasing', 'lexical', 'paraphrase', 'paraphrase', 'synonym']);
  });

  it('resolves every label to exactly one live item, each relevant to one need', () => {
    const rows = new Map(r.case.rows().map((x) => [x.id, x]));
    const ids = needs.flatMap((n) => n.relevant.map((l) => r.case.id(l))); // Case.id throws unless exactly one item matches
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(rows.get(id)?.invalid_at, r.case.name(id)).toBeNull();
    expect(r.queries.filter((q) => !q.relevant.length)).toHaveLength(50);
  });

  it('paraphrases share no ftsTerms token with any relevant target; every other query keeps one', () => {
    const rows = new Map(r.case.rows().map((x) => [x.id, x]));
    const failures: string[] = [];
    for (const n of needs) {
      const target = new Set(n.relevant.flatMap((l) => {
        const x = rows.get(r.case.id(l))!;
        return [...tokens(`${x.text}\n${x.body}`)];
      }));
      for (const q of n.queries) {
        const terms = ftsTerms(q.text);
        const shared = terms.filter((t) => target.has(t));
        if (q.class === 'paraphrase' && shared.length) failures.push(`${n.id} paraphrase "${q.text}" shares ${shared}`);
        if (q.class !== 'paraphrase' && n.relevant.length && !shared.length) failures.push(`${n.id} ${q.class} "${q.text}" shares no token`);
        if (q.class !== 'paraphrase' && !terms.length) failures.push(`${n.id} ${q.class} "${q.text}" has no ftsTerms token`);
      }
    }
    expect(failures).toEqual([]);
  });

  it('meets the FTS floors in fixtures/retrieval/floors.json, and F0 finds no paraphrase target', async () => {
    const view = r.view();
    cleanup.push(() => view.close());
    const scores = await scoreQueries(r.queries, await rankers(view, cfg), cfg);
    const mean = (v: FtsVariant, f: (s: QueryScore) => number) => {
      const xs = scores.filter((s) => s.ranker === v && s.recall !== null);
      return xs.reduce((a, s) => a + f(s), 0) / xs.length;
    };
    const floors = r2aFloors();
    const got = Object.fromEntries((['F0', 'F1', 'F2'] as const).map((v) => [v, { recall: mean(v, (s) => s.recall!), mrr: mean(v, (s) => s.rr!) }]));
    console.log(`R2a FTS scores: ${JSON.stringify(got)}`);
    for (const v of ['F0', 'F1', 'F2'] as const) {
      expect(got[v].recall, `${v} recall@8`).toBeGreaterThanOrEqual(floors.recallAtK[v]);
      expect(got[v].mrr, `${v} MRR@20`).toBeGreaterThanOrEqual(floors.mrr[v]);
    }
    expect(scores.filter((s) => s.ranker === 'F0' && s.class === 'paraphrase' && s.recall).map((s) => s.query)).toEqual([]);
    expect(fBestOf(scores)).toMatch(/^F[012]$/);
  });
});

describe('verdict', () => {
  // Four task clusters in one tree; per cluster, one query F0 misses (recall 0) and H finds (1), one both find. Every
  // cluster's Δ is 0.5, so its CI is [0.5, 0.5]; F0's primary miss@8 is 0.5 and H's 0.
  const score = (set: QueryScore['set'], ranker: RankerName, n: number, recall: number, extra: Partial<QueryScore> = {}): QueryScore => ({
    query: `t/n${n}/${set}${extra.class ?? ''}`, set, tree: 't', cluster: `c${n % 4}`, ranker, recall, rr: recall, miss: recall === 0, returned: 8, ...extra,
  });
  const pair = (set: QueryScore['set'], extra: Partial<QueryScore> = {}) => Array.from({ length: 8 }, (_, n) => {
    const fts = n < 4 ? 0 : 1;
    return [score(set, 'F0', n, fts, extra), score(set, 'H:potion', n, 1, extra), score(set, 'F1', n, 1, extra)];
  }).flat();
  const scores = [
    ...pair('r1-title'), ...pair('r2b', { harness: 'claude' }), ...pair('r1-brief').map((s) => ({ ...s, recall: 1, miss: false })),
    ...pair('r2a', { tree: 'r2a', class: 'lexical' }).map((s) => ({ ...s, recall: 1, miss: false })),
  ];
  const noise = (ranker: RankerName, meanReturned: number, meanVectorOnly: number): Noise => ({ tree: 't', items: 20_000, ranker, meanReturned, meanVectorOnly });
  const pass: R3 = { pass: true, failures: [] };
  const c = { ...makeConfig(0.5, 'F0'), resamples: 500 };
  const run = (n: Noise[]) => evaluate({ config: c, scores, noise: n, r3: new Map([['H:potion', pass], ['F1', pass]]), rankers: ['F0', 'F1', 'H:potion'], exploratory: [] });

  it('passes P1-G4 on a hand-worked set, recommends F1, and leaves the ship verdict open for G5', () => {
    const r = run([noise('F0', 7.6, 0), noise('H:potion', 8, 0.5)]);
    const primary = r.comparisons.find((x) => x.set === 'primary' && x.ranker === 'H:potion' && x.baseline === 'F0')!;
    // 0.5 · mean Δ(R1-title) + 0.5 · mean Δ(R2b) = 0.5 · 0.5 + 0.5 · 0.5.
    expect(primary.deltaRecallAtK).toEqual({ value: 0.5, ci: [0.5, 0.5] });
    expect([primary.rescued, primary.lost]).toEqual([8, 0]);
    expect(Object.fromEntries(r.verdict.criteria.map((x) => [x.id, x.pass]))).toEqual({ P1: true, P2: true, G1: true, G2: true, G3: true, G4: true, G5: null });
    expect(r.verdict.ship).toBeNull();
    expect(r.verdict.ftsTuning).toBe('F1');
    expect(JSON.stringify(r)).not.toMatch(/"text"/);
  });

  it('fails G4 when H returns more than one vector-only result per irrelevant query, and then the verdict is no ship', () => {
    const r = run([noise('F0', 7.6, 0), noise('H:potion', 8, 1.25)]);
    expect(r.verdict.criteria.find((x) => x.id === 'G4')!.pass).toBe(false);
    expect(r.verdict.ship).toBe(false);
  });
});

describe('the configuration freeze (§2.4)', () => {
  it('writes the first configuration with a tau and keeps it against later runs', () => {
    const root = scratch('tl-bench-freeze-');
    expect(freeze(root, makeConfig(NaN, 'F1'))).toMatchObject({ written: false });
    expect(existsSync(configPath(root))).toBe(false);
    expect(freeze(root, makeConfig(0.41, 'F1'))).toMatchObject({ written: true, differs: [] });
    const again = freeze(root, makeConfig(0.47, 'F2'));
    expect(again).toMatchObject({ written: false, differs: ['tau', 'fBest'] });
    expect([again.config.tau, again.config.fBest, again.config.seed]).toEqual([0.41, 'F1', 4104]);
    // A run without an embedder has no tau to compare.
    expect(freeze(root, makeConfig(NaN, 'F1')).differs).toEqual([]);
  });
});

describe('replay.ts', () => {
  it('refuses a --root inside the repo, ~/.tiller or the home it reads', () => {
    const repo = fileURLToPath(new URL('../../', import.meta.url));
    const home = scratch('tl-bench-home-');
    expect(() => checkRoot(join(repo, 'bench', 'out'), home)).toThrow(/inside/);
    expect(() => checkRoot(join(homedir(), '.tiller', 'bench'), home)).toThrow(/inside/);
    expect(() => checkRoot(join(home, 'results'), home)).toThrow(/inside/);
    expect(checkRoot(join(scratch('tl-bench-root-'), 'new'), home)).toMatch(/new$/);
  });

  const ROOT = 'n-00000000';
  const T = Date.parse('2026-10-20T00:00:00Z');
  const node = (id: string, created: number, files: string[], title: string): ArchivedNode => ({
    id, rootId: ROOT, parentId: ROOT, title, cwd: '/w/own', harness: 'claude', model: 'bench', role: 'worker', prompt: `${title} please`,
    createdAt: T + created * 60_000, closedAt: T + (created + 5) * 60_000,
    outcome: { outcome: 'succeeded', summary: `${title}.`, changedFiles: files, at: T + (created + 4) * 60_000 },
  });
  const tree: Tree = {
    rootId: ROOT, cwd: '/w/own', repo: 'own', createdAt: T,
    nodes: [node('n-00000001', 0, ['a.ts'], 'Parser fix'), node('n-00000002', 10, ['b.ts'], 'Lexer tweak'), node('n-00000003', 20, ['a.ts', 'c.ts'], 'Parser again'),
      // Twelve unrelated nodes, so a.ts (2 of 15 nodes, 13%) stays under the 15% hot-file share.
      ...'defghijklmno'.split('').map((f, i) => node(`n-000000${String(10 + i)}`, 30 + i * 10, [`${f}.ts`], `Other ${f}`))],
  };

  it('scores R1 titles and briefs against the as-of store, relevant = the labelled ledger items', async () => {
    const s = await scoreTree(tree, cfg, []);
    // Only n-00000003 has a label (n-00000001 shares a.ts); its title finds that ledger first.
    expect([...new Set(s.map((x) => x.query))]).toEqual([`${ROOT}/n-00000003/r1-title`, `${ROOT}/n-00000003/r1-brief`]);
    expect(s.find((x) => x.query.endsWith('r1-title') && x.ranker === 'F0')).toMatchObject({ recall: 1, rr: 1, miss: false, cluster: 'n-00000003' });
  });

  it('pads with other repos\' commits, oldest first and deduplicated, never a gate tree\'s or a bloksec repo', () => {
    const ws = scratch('tl-bench-ws-');
    const git = (dir: string, ...a: string[]) => execFileSync('git', ['-C', dir, ...a], { encoding: 'utf8' });
    const repo = (path: string, commits: [string, number][]) => {
      mkdirSync(path, { recursive: true });
      git(path, 'init', '-q');
      for (const [msg, at] of commits) {
        writeFileSync(join(path, 'f'), msg);
        git(path, 'add', 'f');
        execFileSync('git', ['-C', path, '-c', 'user.email=b@bench.invalid', '-c', 'user.name=bench', 'commit', '-qm', msg], { env: { ...process.env, GIT_AUTHOR_DATE: `@${at} +0000`, GIT_COMMITTER_DATE: `@${at} +0000` } });
      }
    };
    repo(join(ws, 'other'), [['Second other', 2000], ['Shared subject', 3000]]);
    repo(join(ws, 'more'), [['First more', 1000], ['Shared subject', 4000]]);
    repo(join(ws, 'bloksec', 'api'), [['Secret work', 1500]]);
    repo(join(ws, 'own'), [['Own work', 500]]);
    // The other gate tree's repo, and a second clone of it found by name.
    repo(join(ws, 'peer'), [['Peer work', 600]]);
    repo(join(ws, 'clones', 'peer'), [['Peer clone work', 700]]);
    const own = { cwd: join(ws, 'own'), repo: 'own' }, peer = { cwd: join(ws, 'peer'), repo: 'peer' };
    expect(distractors(ws, [own, peer]).map((x) => x.text)).toEqual(['First more', 'Second other', 'Shared subject']);
    // The literal §2.2 rule, kept for the record: only the tree's own repo left out.
    expect(distractors(ws, [own]).map((x) => x.text)).toEqual(['Peer work', 'Peer clone work', 'First more', 'Second other', 'Shared subject']);

    const dir = scratch('tl-bench-s-');
    const padding = Array.from({ length: 12 }, (_, i) => ({ at: i, text: `distractor ${i % 10}`, body: '' }));
    const stores = scaledStores(tree, padding, [20, 40], dir);
    // 15 ledger items natively; 10 distinct distractors (two repeats merge) reach 25, short of 40, so 25 is the largest.
    expect(stores.map((s) => s.items)).toEqual([15, 20, 25]);
    for (const s of stores) expect(existsSync(s.file)).toBe(true);
  });
});

describe('gate (replay.ts and run.ts --eval)', () => {
  it('scores R1, R2b and R2a on a synthetic home, R2b in its node\'s as-of store, and writes ids and numbers only', async () => {
    const home = scratch('tl-bench-gate-home-');
    const root = scratch('tl-bench-gate-root-');
    const T = Date.parse('2026-10-01T00:00:00Z');
    const nodes = (rootId: string, repo: string) => Array.from({ length: 22 }, (_, i): ArchivedNode => ({
      // Pairs share a file (2 of 22 nodes, under the hot-file share); the second of each pair is labelled by the first.
      id: `n-${rootId.slice(2, 6)}${String(i).padStart(4, '0')}`, rootId, parentId: rootId, title: `Fix module m${Math.floor(i / 2)} of ${repo}`,
      cwd: `/w/${repo}`, harness: 'claude', model: 'bench', role: 'worker', prompt: `Fix module m${Math.floor(i / 2)}`,
      createdAt: T + i * 3_600_000, closedAt: T + i * 3_600_000 + 60_000,
      outcome: { outcome: 'succeeded', summary: `Fixed m${Math.floor(i / 2)}.`, changedFiles: [`m${Math.floor(i / 2)}.ts`], at: T + i * 3_600_000 + 30_000 },
    }));
    for (const [rootId, repo] of [['n-96530325', 'tiller'], ['n-76dead40', 'storyGame']]) {
      const dir = join(home, 'sessions', rootId);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'meta.json'), JSON.stringify({ rootId, title: rootId, cwd: `/w/${repo}`, createdAt: T - 1 }));
      writeFileSync(join(dir, 'archive.jsonl'), nodes(rootId, repo).map((n) => JSON.stringify(n)).join('\n'));
    }
    const node = 'n-96530003'; // m1's second node
    const r = await gate({
      root, home, sets: ['r1', 'r2a', 'r2b'], name: 'gate', log: () => {},
      r2b: [{ id: `n-96530325/${node}/r2b/claude`, set: 'r2b', text: 'module m1', harness: 'claude', tree: 'n-96530325', cluster: node, node, asOf: 0, relevant: [] }],
    });
    expect(r.sets).toEqual(['r1-title', 'r1-brief', 'r2b', 'r2a']);
    expect(r.queries.filter((q) => q.set === 'r1-title' && q.ranker === 'F0')).toHaveLength(22);
    expect(r.queries.find((q) => q.set === 'r2b' && q.ranker === 'F0')).toMatchObject({ recall: 1, rr: 1, harness: 'claude' });
    expect(r.slices.some((s) => s.set === 'primary')).toBe(true);
    expect(r.verdict.criteria.find((c) => c.id === 'P1')!.pass).toBeNull(); // no embedder: H was not run
    const written = readFileSync(join(root, 'results', `gate-${r.generatedAt.slice(0, 10)}.json`), 'utf8');
    expect(written).not.toMatch(/Fix module|"text"/);
  });
});

describe('model files', () => {
  it('verifies size and sha256 before use, and reads a safetensors matrix in bounds', () => {
    const f = { path: 'x', size: 3, sha256: 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad' }; // sha256("abc")
    expect(verify(Buffer.from('abc'), f, 'x').toString()).toBe('abc');
    expect(() => verify(Buffer.from('abd'), f, 'x')).toThrow(/sha256/);
    expect(() => verify(Buffer.from('abcd'), f, 'x')).toThrow(/bytes/);

    const header = Buffer.from(JSON.stringify({ embeddings: { dtype: 'F32', shape: [2, 2], data_offsets: [0, 16] } }).padEnd(64, ' '));
    const len = Buffer.alloc(8);
    len.writeBigUInt64LE(BigInt(header.length));
    const data = Buffer.from(new Float32Array([1, 2, 3, 4]).buffer);
    const m = readSafetensors(Buffer.concat([len, header, data]), 'embeddings');
    expect([m.rows, m.dims, [...m.data]]).toEqual([2, 2, [1, 2, 3, 4]]);
    expect(() => readSafetensors(Buffer.concat([len, header, data.subarray(0, 12)]), 'embeddings')).toThrow(/bounds/);
    expect(() => readSafetensors(Buffer.concat([len, header, data]), 'other')).toThrow(/no F32/);
  });
});

it('keeps real session and git text out of the committed fixtures', () => {
  const dir = fileURLToPath(new URL('./fixtures/retrieval/', import.meta.url));
  const text = ['corpus.json', 'needs.json', 'floors.json'].map((f) => readFileSync(join(dir, f), 'utf8')).join('\n');
  expect(text).not.toMatch(/\bn-[0-9a-f]{8}\b|tiller|storyGame|bloksec/i);
});
