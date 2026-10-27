// lib/archive.ts on synthetic archives only: no real session text in the repo.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ArchivedNode } from '../../src/shared/protocol.js';
import {
  asOfNodes, GATE_CUTOFF, gateTrees, hotFiles, labels, normalizeFile, readTree, replayAsOf, selectTrees, type Tree,
} from './lib/archive.js';

const ROOT = 'n-00000000';
const T = Date.parse('2026-10-20T00:00:00Z');
const min = (m: number) => T + m * 60_000;

function node(id: string, o: { parent?: string; created: number; closed: number; files?: string[]; prompt?: string; role?: ArchivedNode['role']; open?: string[] }): ArchivedNode {
  return {
    id, rootId: ROOT, parentId: o.parent ?? ROOT, title: `task ${id}`, cwd: '/w/tiller', harness: 'claude', model: 'bench', role: o.role ?? 'worker',
    prompt: o.prompt ?? `work on ${id}`, createdAt: min(o.created), closedAt: min(o.closed),
    outcome: { outcome: 'succeeded', summary: `did ${id}.`, changedFiles: o.files ?? [], ...(o.open ? { openQuestions: o.open } : {}), at: min(o.closed - 1) },
  };
}

// Six nodes; q is n-00000004, created at minute 25.
const w1 = node('n-00000001', { created: 0, closed: 10, files: ['src/a.ts', 'src/hot.ts'], open: ['Should alpha retry twice?'] });
const r1 = node('n-00000002', { created: 11, closed: 20, prompt: 'Review n-00000001 on its branch.' });
const w2 = node('n-00000003', { created: 21, closed: 30, files: ['src/b.ts', 'src/hot.ts'] }); // still open when q starts
const q = node('n-00000004', { created: 25, closed: 60, files: ['./src/a.ts', 'src/b.ts'] });
const c = node('n-00000005', { parent: q.id, created: 22, closed: 24, files: ['src/a.ts'] }); // q's child, closed early by a skewed clock
const late = node('n-00000006', { created: 40, closed: 50, files: ['src/c.ts'], role: 'orchestrator', prompt: 'Integrate n-00000004.' });
const tree: Tree = { rootId: ROOT, cwd: '/w/tiller', repo: 'tiller', createdAt: T, nodes: [w1, r1, c, w2, late, q] };

const cleanup: (() => void)[] = [];
afterEach(() => { while (cleanup.length) cleanup.pop()!(); });

describe('as-of replay', () => {
  it('excludes q, its descendants and anything closed after q was created', () => {
    expect(asOfNodes(tree, q).map((a) => a.id)).toEqual([w1.id, r1.id]);
  });

  it('replays outcomes and closes into a store that holds only the as-of nodes', () => {
    const r = replayAsOf(tree, q);
    cleanup.push(() => r.close());
    expect([...r.ledgerIds().keys()].sort()).toEqual([w1.id, r1.id]);
    // The outcome went through derive too: w1's open question is an item.
    expect(r.store.search(r.scope, { query: 'alpha retry' }).map((v) => v.kind)).toContain('open_question');
    expect(r.store.search(r.scope, { query: q.id })).toEqual([]);
  });
});

describe('labels', () => {
  it('drops a file that 2 of 6 nodes touch at the 15% threshold', () => {
    expect(hotFiles(tree).has('src/hot.ts')).toBe(true);
    expect(hotFiles(tree, 0.4).has('src/hot.ts')).toBe(false);
  });

  it('labels as-of nodes that share a non-hot file', () => {
    // w2 shares src/b.ts but closed after q started; c shares src/a.ts but is q's child.
    expect(labels(tree, q, new Set(['src/hot.ts']))).toEqual([w1.id]);
    expect(labels(tree, q, new Set(['src/a.ts', 'src/hot.ts']))).toEqual([]);
  });

  it('normalizes changedFiles entries to repo paths', () => {
    expect(normalizeFile('/w/tiller/.claude/worktrees/n-1/src/a.ts', '/w/tiller')).toBe('src/a.ts');
    expect(normalizeFile('/w/tiller/src/a.ts', '/w/tiller')).toBe('src/a.ts');
    expect(normalizeFile('./src/a.ts (new)', '/w/tiller')).toBe('src/a.ts');
  });
});

describe('tree selection', () => {
  const before = GATE_CUTOFF - 86_400_000;
  it('keeps trees with at least 20 nodes with changedFiles, created before the cutoff, outside bloksec', () => {
    expect(selectTrees([
      { rootId: 'n-a', cwd: '/w/scottstuff/tiller', createdAt: before, nodesWithFiles: 20 },
      { rootId: 'n-b', cwd: '/w/scottstuff/small', createdAt: before, nodesWithFiles: 19 },
      { rootId: 'n-c', cwd: '/w/bloksec/bloksec', createdAt: before, nodesWithFiles: 120 },
      { rootId: 'n-d', cwd: '/w/bloksec_website_redesign', createdAt: before, nodesWithFiles: 40 },
      { rootId: 'n-e', cwd: '/w/scottstuff/new', createdAt: GATE_CUTOFF, nodesWithFiles: 50 },
    ])).toEqual(['n-a']);
  });

  it('reads a home read-only and checks the rule against the pre-registered trees', () => {
    const home = mkdtempSync(join(tmpdir(), 'tl-bench-home-'));
    cleanup.push(() => rmSync(home, { recursive: true, force: true }));
    const write = (rootId: string, cwd: string, withFiles: number) => {
      const dir = join(home, 'sessions', rootId);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'meta.json'), JSON.stringify({ rootId, title: rootId, cwd, createdAt: before }));
      const nodes = Array.from({ length: withFiles }, (_, i) => ({ ...node(`n-1000${String(i).padStart(4, '0')}`, { created: i, closed: i + 1, files: ['f.ts'] }), rootId: 'n-forged' }));
      // One node closed after the cutoff, which readTree drops.
      nodes.push({ ...node('n-20000000', { created: 0, closed: 1, files: ['f.ts'] }), closedAt: GATE_CUTOFF });
      writeFileSync(join(dir, 'archive.jsonl'), `${nodes.map((n) => JSON.stringify(n)).join('\n')}\nnot json\n`);
    };
    write('n-96530325', '/w/scottstuff/tiller', 20);
    write('n-76dead40', '/w/scottstuff/storyGame', 26);
    write('n-3ef98b0b', '/w/bloksec/bloksec', 120);
    write('n-0000000a', '/w/scottstuff/tiny', 3);

    const t = readTree(join(home, 'sessions', 'n-76dead40'));
    expect(t.nodes).toHaveLength(26);
    expect(t.nodes.every((a) => a.rootId === 'n-76dead40')).toBe(true);
    expect(gateTrees(home).map((x) => [x.rootId, x.repo])).toEqual([['n-96530325', 'tiller'], ['n-76dead40', 'storyGame']]);

    write('n-0000000b', '/w/scottstuff/other', 30);
    expect(() => gateTrees(home)).toThrow(/not the pre-registered/);
  });
});
