// Memory panel benchmarks (memory v2 plan §8): M1 page latency over a 12,000-item file, M2 reply sizes, M3 the Claude
// auto-memory caps. CI asserts the ceilings; the warm medians are logged against their targets.
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ServerMessage } from '../../src/shared/protocol.js';
import { claudeProjectSlug, readClaudeMemory } from '../../src/daemon/claude-memory.js';
import { NodeManager } from '../../src/daemon/manager.js';
import { switchMemory } from '../../src/daemon/memory-config.js';
import { memoryItem, memoryPage, type PageQuery, type PanelHost } from '../../src/daemon/memory-panel.js';
import { ITEM_KINDS, normalizeDedupe, type DerivedItem, type MemoryScope } from '../../src/daemon/memory-schema.js';
import { MemoryStore } from '../../src/daemon/memory-store.js';

const WORDS = ('socket timeout parser cache migration flaky retry lockfile release bundle worker gate schema index token '
  + 'config branch merge vitest daemon sidebar pane digest sqlite fts eviction quarantine checkout origin').split(' ');
const KiB = 1024;
const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;
const p95 = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.ceil(xs.length * 0.95) - 1]!;
/** Deterministic text of `len` characters from WORDS, seeded by n. */
const text = (n: number, len: number) => Array.from({ length: Math.ceil(len / 4) }, (_, i) => WORDS[(n * 7 + i * 13 + (n >> 3)) % WORDS.length]).join(' ').slice(0, len);
/** A unique word per index, in letters: dedupe keys drop digits. */
const tag = (n: number): string => (n < 26 ? '' : tag(Math.floor(n / 26) - 1)) + String.fromCharCode(97 + (n % 26));

let dir: string, home: string, repoA: string, repoB: string, m: NodeManager;
const host = (memory: MemoryStore): PanelHost => ({ home, memory, registry: m.registry, projectDir: (n) => m.projectDir(n), repoKeyOf: (d) => m.repoKeyOf(d), transcriptNode: (id) => m.transcriptNode(id) });

/** One store.apply per repository: count items of every kind from a succeeded node, then 10% retracted and `pins` pinned. */
function seed(store: MemoryStore, repo: string, count: number, len: (i: number) => number, pins: number): void {
  const scope: MemoryScope = { repoKey: m.repoKeyOf(repo), repoPath: repo, nodeId: `n-${count}`, rootId: 'n-root' };
  const items: DerivedItem[] = Array.from({ length: count }, (_, i) => {
    const kind = ITEM_KINDS[i % ITEM_KINDS.length]!, t = `${tag(i)} ${text(i, len(i) - tag(i).length - 1)}`;
    return { kind, text: t, author: 'agent', dedupe: normalizeDedupe(kind, t), ...(i === 0 ? { body: text(1, 2_000) } : {}) };
  });
  store.apply(scope, { episode: { kind: 'outcome', ts: Date.now(), data: { outcome: 'succeeded', gate: 'passed' } }, items, cites: [] });
  const db = new DatabaseSync(join(home, 'memory', '_default.db'));
  try {
    const repoId = (db.prepare('SELECT id FROM repos WHERE key = ?').get(scope.repoKey) as { id: number }).id;
    db.prepare('UPDATE items SET updated_at = updated_at - id * 1000 WHERE repo_id = ?').run(repoId);
    db.prepare(`UPDATE items SET invalid_at = 1, invalid_kind = 'agent', invalid_by = 'n-x', invalid_reason = 'bench' WHERE repo_id = ? AND id % 10 = 3`).run(repoId);
    db.prepare(`UPDATE items SET pinned = 1 WHERE id IN (SELECT id FROM items WHERE repo_id = ? AND invalid_at IS NULL ORDER BY id LIMIT ?)`).run(repoId, pins);
  } finally {
    db.close();
  }
}

beforeAll(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'tl-bench-panel-')));
  home = join(dir, 'tl');
  repoA = join(dir, 'a');
  repoB = join(dir, 'b');
  mkdirSync(repoA);
  mkdirSync(repoB);
  m = new NodeManager({ home, shell: '/bin/sh' });
  switchMemory(home, { project: repoA }, 'on');
  const store = new MemoryStore(home);
  seed(store, repoA, 10_000, (i) => 40 + (i * 37) % 261, 50);
  seed(store, repoB, 2_000, () => 300, 0);
  store.close();
}, 120_000);
afterAll(async () => { await m.shutdown(); rmSync(dir, { recursive: true, force: true }); });

describe('M1: panel latency at 10k items', () => {
  it('serves every page within the ceilings, warm and cold', async () => {
    const warm = host(m.memory), target = { dir: repoA };
    const first = await memoryPage(warm, { target });
    const second = await memoryPage(warm, { target, before: first.next });
    expect(first.items).toHaveLength(50);
    expect(second.next).toBeDefined();
    expect(first.repos.map((r) => r.items)).toEqual([9_000, 1_800]); // 10% of each retracted
    const cases: Record<string, () => Promise<unknown>> = {
      browse: () => memoryPage(warm, { target }),
      kind: () => memoryPage(warm, { target, kind: 'pitfall' }),
      pinned: () => memoryPage(warm, { target, kind: 'pinned' }),
      retracted: () => memoryPage(warm, { target, retracted: true }),
      query: () => memoryPage(warm, { target, query: 'socket timeout' }),
      page3: () => memoryPage(warm, { target, before: second.next }),
      item: () => memoryItem(warm, target, 5_000),
    };
    expect((await memoryPage(warm, { target, query: 'socket timeout' })).items.length).toBeGreaterThan(0);
    expect((await memoryPage(warm, { target, kind: 'pinned' })).counts.pinned).toBe(50);
    const report: string[] = [];
    for (const [name, run] of Object.entries(cases)) {
      const ms: number[] = [];
      for (let i = 0; i < 20; i++) {
        const t = performance.now();
        await run();
        ms.push(performance.now() - t);
      }
      report.push(`${name} median ${median(ms).toFixed(1)} ms, p95 ${p95(ms).toFixed(1)} ms`);
      expect(p95(ms), name).toBeLessThanOrEqual(150);
    }
    const cold: number[] = [];
    for (let i = 0; i < 3; i++) {
      const store = new MemoryStore(home);
      try {
        const t = performance.now();
        await memoryPage(host(store), { target } satisfies PageQuery);
        cold.push(performance.now() - t);
      } finally {
        store.close();
      }
    }
    report.push(`cold max ${Math.max(...cold).toFixed(1)} ms`);
    console.log(`M1 (warm median target 20 ms): ${report.join('; ')}`);
    expect(Math.max(...cold)).toBeLessThanOrEqual(400);
  });
});

describe('M2: reply size', () => {
  it('keeps a first page of 50 items of 300 characters within 40 KiB and a detail with a 2,000-character body within 8 KiB', async () => {
    const page = await memoryPage(host(m.memory), { target: { dir: repoB } });
    expect(page.items).toHaveLength(50);
    expect(page.items.every((v) => v.text.length === 300)).toBe(true);
    const pageBytes = Buffer.byteLength(JSON.stringify({ t: 'memory', rid: 1, ...page } satisfies ServerMessage));
    const detail = await memoryItem(host(m.memory), { dir: repoB }, 10_001);
    expect(detail.item.body).toHaveLength(2_000);
    const detailBytes = Buffer.byteLength(JSON.stringify({ t: 'memoryItem', rid: 2, ...detail } satisfies ServerMessage));
    console.log(`M2: page ${(pageBytes / KiB).toFixed(1)} KiB, detail ${(detailBytes / KiB).toFixed(1)} KiB`);
    expect(pageBytes).toBeLessThanOrEqual(40 * KiB);
    expect(detailBytes).toBeLessThanOrEqual(8 * KiB);
  });
});

describe('M3: Claude memory caps', () => {
  it('reads 150 files of 20 KiB into at most 1 MiB + 4 KiB, naming the rest', async () => {
    const claudeHome = join(dir, 'claude'), memory = join(claudeHome, 'projects', claudeProjectSlug(repoA), 'memory');
    mkdirSync(memory, { recursive: true });
    // Markdown with newlines, quotes and backslashes, which JSON escapes: the cap must hold for the encoded reply.
    const markdown = (n: number) => Array.from({ length: 20 * KiB }, (_, i) => `- "${WORDS[(n + i) % WORDS.length]}" in \`C:\\src\`\n`).join('').slice(0, 20 * KiB);
    for (let i = 0; i < 150; i++) writeFileSync(join(memory, `topic-${String(i).padStart(3, '0')}.md`), markdown(i));
    const ms: number[] = [];
    let view;
    for (let i = 0; i < 5; i++) {
      const t = performance.now();
      view = await readClaudeMemory(claudeHome, repoA);
      ms.push(performance.now() - t);
    }
    const bytes = Buffer.byteLength(JSON.stringify({ t: 'claudeMemory', rid: 1, ...view! } satisfies ServerMessage));
    console.log(`M3: ${view!.files.length} files, ${view!.omitted.length} omitted, ${(bytes / KiB).toFixed(1)} KiB, median ${median(ms).toFixed(1)} ms`);
    expect(view!.files.length + view!.omitted.length).toBe(150);
    expect(view!.omitted.length).toBeGreaterThan(0);
    expect(bytes).toBeLessThanOrEqual(1024 * KiB + 4 * KiB);
    expect(median(ms)).toBeLessThanOrEqual(100);
  });
});
