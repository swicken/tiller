// The retrieval check: a hand-worked metrics example, the R2a fixture's validity and its FTS floors, and replay.ts's
// guards and R1 scoring. Synthetic data only.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { ArchivedNode } from '../../src/shared/protocol.js';
import { ftsTerms } from '../../src/daemon/memory-schema.js';
import type { Tree } from './lib/archive.js';
import { benchRoot, startDaemon } from './lib/daemon.js';
import { metrics, R2a, r2aFloors, r2aNeeds, scoreQueries, slicesOf } from './retrieval/eval.js';
import { replay, scoreTree } from './replay.js';

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
    const q1 = metrics([5, 1, 7, 2, 9], [1, 2]);
    // q2: the one relevant id is 9th: a miss at 8, rr 1/9 at 20.
    const q2 = metrics([4, 5, 6, 7, 8, 9, 10, 11, 3], [3]);
    // q3: 10 relevant, 4 of them in the top 8 (first at rank 3): recall 4 / min(10, 8), rr 1/3.
    const q3 = metrics([20, 21, 1, 2, 22, 3, 4, 23], [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect([q1, q2, q3]).toEqual([{ recall: 1, rr: 0.5, miss: false }, { recall: 0, rr: 1 / 9, miss: true }, { recall: 0.5, rr: 1 / 3, miss: false }]);
  });
});

describe('R2a fixture', () => {
  let r: R2a;
  beforeAll(() => { r = new R2a(); });
  afterAll(() => r?.close());
  const needs = r2aNeeds();
  /** ftsTerms tokens of a whole text, uncapped: ftsTerms per whitespace-separated chunk. */
  const tokens = (s: string) => new Set(s.split(/\s+/).flatMap((chunk) => ftsTerms(chunk, Infinity)));

  it('has at least 350 items, 30 needs, and one lexical, one synonym and one harness query each', () => {
    expect(r.case.rows().length).toBeGreaterThanOrEqual(350);
    expect(needs).toHaveLength(30);
    expect(new Set(needs.map((n) => n.id)).size).toBe(30);
    for (const n of needs) expect(n.queries.map((q) => q.class).sort(), n.id).toEqual(['harness-phrasing', 'lexical', 'synonym']);
  });

  it('resolves every label to exactly one live item, each relevant to one need', () => {
    const rows = new Map(r.case.rows().map((x) => [x.id, x]));
    const ids = needs.flatMap((n) => n.relevant.map((l) => r.case.id(l))); // Case.id throws unless exactly one item matches
    expect(ids.length).toBeGreaterThan(0);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(rows.get(id)?.invalid_at, r.case.name(id)).toBeNull();
  });

  it('every query shares an ftsTerms token with a relevant target', () => {
    const rows = new Map(r.case.rows().map((x) => [x.id, x]));
    const failures: string[] = [];
    for (const n of needs) {
      const target = new Set(n.relevant.flatMap((l) => {
        const x = rows.get(r.case.id(l))!;
        return [...tokens(`${x.text}\n${x.body}`)];
      }));
      for (const q of n.queries) if (!ftsTerms(q.text).some((t) => target.has(t))) failures.push(`${n.id} ${q.class} "${q.text}" shares no token`);
    }
    expect(failures).toEqual([]);
  });

  it('meets the FTS floors in fixtures/retrieval/floors.json', () => {
    const [all] = slicesOf(scoreQueries(r.queries, r.rank));
    console.log(`R2a search scores: recall@8 ${all.recallAtK}, MRR@20 ${all.mrr}`);
    const floors = r2aFloors();
    expect(all.recallAtK, 'recall@8').toBeGreaterThanOrEqual(floors.recallAtK);
    expect(all.mrr, 'MRR@20').toBeGreaterThanOrEqual(floors.mrr);
  });
});

describe('replay.ts', () => {
  it('refuses a --root inside the repo, ~/.tiller or the home it reads, and a daemon home inside ~/.tiller', async () => {
    const repo = fileURLToPath(new URL('../../', import.meta.url));
    const home = scratch('tl-bench-home-');
    expect(() => benchRoot(join(repo, 'bench', 'out'), [home])).toThrow(/inside/);
    expect(() => benchRoot(join(homedir(), '.tiller', 'bench'), [home])).toThrow(/inside/);
    expect(() => benchRoot(join(home, 'results'), [home])).toThrow(/inside/);
    // A child named like `..x` is still inside.
    expect(() => benchRoot(join(repo, '..out'), [home])).toThrow(/inside/);
    expect(() => benchRoot(join(homedir(), '.tiller', '..out'), [home])).toThrow(/inside/);
    await expect(startDaemon(join(homedir(), '.tiller', 'bench-home'))).rejects.toThrow(/live home/);
    expect(benchRoot(join(scratch('tl-bench-root-'), 'new'), [home])).toMatch(/new$/);
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

  it('scores R1 titles and briefs against the as-of store, relevant = the labelled ledger items', () => {
    const s = scoreTree(tree);
    // Only n-00000003 has a label (n-00000001 shares a.ts); its title finds that ledger first.
    expect(s.map((x) => x.query)).toEqual([`${ROOT}/n-00000003/r1-title`, `${ROOT}/n-00000003/r1-brief`]);
    expect(s[0]).toMatchObject({ recall: 1, rr: 1, miss: false });
  });

  it('scores R1 on a synthetic home and writes ids and numbers only', () => {
    const home = scratch('tl-bench-replay-home-');
    const root = scratch('tl-bench-replay-root-');
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
    const r = replay({ root, home, name: 'replay', log: () => {} });
    expect(r.queries.filter((q) => q.set === 'r1-title')).toHaveLength(22);
    expect(r.slices.map((s) => [s.set, s.tree ?? ''])).toEqual([
      ['r1-title', ''], ['r1-title', 'n-76dead40'], ['r1-title', 'n-96530325'], ['r1-brief', ''], ['r1-brief', 'n-76dead40'], ['r1-brief', 'n-96530325'],
    ]);
    const written = readFileSync(join(root, 'results', `replay-${r.generatedAt.slice(0, 10)}.json`), 'utf8');
    expect(written).not.toMatch(/Fix module|"text"/);
  });
});

it('keeps real session and git text out of the committed fixtures', () => {
  const dir = fileURLToPath(new URL('./fixtures/retrieval/', import.meta.url));
  const text = ['corpus.json', 'needs.json', 'floors.json'].map((f) => readFileSync(join(dir, f), 'utf8')).join('\n');
  expect(text).not.toMatch(/\bn-[0-9a-f]{8}\b|tiller|storyGame|bloksec/i);
});
