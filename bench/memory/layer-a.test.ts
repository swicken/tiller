// Memory benchmark Layer A (bench plan §2): labeled fixtures replayed through the real memory modules on a temp home,
// then capture, search and digest-selection assertions, the digest rendering contract, and the aggregate score floors.
// Deterministic and LLM-free. Set BENCH_OUT to a directory to also write the per-query scores as layer-a.json.
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Harness } from '../../src/shared/protocol.js';
import { DIGEST_HEADER, DIGEST_SECTIONS, digestFor } from '../../src/daemon/memory-digest.js';
import { LIMITS, type DigestRole, type MemoryScope } from '../../src/daemon/memory-schema.js';
import { Case, type Fixture, type Floors, type Section } from './lib/fixture.js';

const FIXTURES = fileURLToPath(new URL('./fixtures/', import.meta.url));
const fixtures = readdirSync(FIXTURES).filter((f) => f.endsWith('.json') && f !== 'floors.json').sort()
  .map((f) => JSON.parse(readFileSync(join(FIXTURES, f), 'utf8')) as Fixture);
const floors = JSON.parse(readFileSync(join(FIXTURES, 'floors.json'), 'utf8')) as Floors;

// --- The rendering contract (bench plan §2.2) ---

const HEADINGS = Object.entries(DIGEST_SECTIONS) as [Section, string][];
const ITEM_LINE = /^- \[m(\d+)\] \d+[mhd] ago · [^:\n]+: /;

/** The digest's contract violations, and its item ids per section in render order. */
function contract(text: string, itemIds: number[], role: DigestRole): { violations: string[]; sections: Partial<Record<Section, number[]>> } {
  const violations: string[] = [];
  const sections: Partial<Record<Section, number[]>> = {};
  if (text === '') {
    if (itemIds.length) violations.push('empty text with item ids');
    return { violations, sections };
  }
  if (!text.startsWith(`${DIGEST_HEADER}\n`)) violations.push('header differs from DIGEST_HEADER');
  if (text.length > LIMITS.digest.budget[role]) violations.push(`${text.length} chars over the ${role} budget ${LIMITS.digest.budget[role]}`);
  if (/[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/.test(text)) violations.push('a C0/C1 control character');
  let current: Section | undefined;
  let order = -1;
  const seen: number[] = [];
  // Everything after the fixed header paragraph.
  const lines = text.slice(DIGEST_HEADER.length + 1).split('\n');
  lines.forEach((line, i) => {
    if (line.length > LIMITS.digest.line) violations.push(`a ${line.length}-char line`);
    // A frame is authentic only at the start of a line (the outermost one); mid-line, a marker is plain data.
    if (/^--- (?:END )?TL MESSAGE/.test(line)) violations.push(`a line opens a TL frame: ${line}`);
    if (line === '' && i === 0) return;
    if (line.startsWith('#')) {
      const at = HEADINGS.findIndex(([, h]) => h === line);
      if (at < 0) violations.push(`a heading outside the contract: ${line}`);
      else if (at <= order) violations.push(`section out of order or repeated: ${line}`);
      else [order, current] = [at, HEADINGS[at][0]];
      return;
    }
    const m = ITEM_LINE.exec(line);
    if (!m || !current) return violations.push(`not a whole item line under a heading: ${JSON.stringify(line)}`);
    seen.push(Number(m[1]));
    (sections[current] ??= []).push(Number(m[1]));
  });
  if (JSON.stringify(seen) !== JSON.stringify(itemIds)) violations.push(`rendered ids ${JSON.stringify(seen)} differ from itemIds ${JSON.stringify(itemIds)}`);
  const pinned = text.indexOf(DIGEST_SECTIONS.pinned);
  if (pinned >= 0) {
    const next = text.indexOf('\n## ', pinned + 1);
    const used = (next < 0 ? text.length : next) - pinned + 1; // + the newline before the heading, as buildDigest counts it
    if (used > LIMITS.digest.pinned) violations.push(`pinned section ${used} chars over ${LIMITS.digest.pinned}`);
  }
  return { violations, sections };
}

// --- Scores (bench plan §2.2) ---

interface Score {
  case: string; query: string; role: DigestRole; report: boolean; k: number; relevant: number; injected: number;
  recallAtK?: number; precision?: number; chars: number; relatedLines: number;
}
const scores: Score[] = [];

for (const fx of fixtures) {
  describe(fx.name, () => {
    let c: Case;
    beforeAll(() => {
      c = new Case(fx);
      c.replay();
    });
    afterAll(() => c?.close());

    it('captures the labeled items', () => {
      const rows = c.rows();
      const failures: string[] = [];
      for (const e of fx.expectItems ?? []) {
        const what = e.label ?? JSON.stringify(e);
        const found = e.label ? rows.filter((r) => r.id === c.id(`@${e.label}`)) : c.matching(e);
        if (found.length !== 1) { failures.push(`${what}: ${found.length} items match`); continue; }
        const r = found[0];
        if (e.author !== undefined && r.author !== e.author) failures.push(`${what}: author ${r.author}, not ${e.author}`);
        if (e.harness !== undefined && r.harness !== e.harness) failures.push(`${what}: harness ${r.harness}, not ${e.harness}`);
        if (e.nodeId !== undefined && r.node_id !== e.nodeId) failures.push(`${what}: node ${r.node_id}, not ${e.nodeId}`);
        if (e.seen !== undefined && r.seen !== e.seen) failures.push(`${what}: seen ${r.seen}, not ${e.seen}`);
        if (e.retracted !== undefined && (r.invalid_at !== null) !== e.retracted) failures.push(`${what}: retracted is ${r.invalid_at !== null}`);
        if (e.pinned !== undefined && (r.pinned === 1) !== e.pinned) failures.push(`${what}: pinned is ${r.pinned === 1}`);
        for (const s of e.bodyIncludes ?? []) if (!r.body.includes(s)) failures.push(`${what}: body lacks ${JSON.stringify(s)}: ${JSON.stringify(r.body)}`);
      }
      for (const m of fx.forbidItems ?? []) {
        for (const r of c.matching(m)) failures.push(`forbidden item ${JSON.stringify(m)} found: m${r.id} ${JSON.stringify(r.text)}`);
      }
      for (const [kind, n] of Object.entries(fx.exactCounts ?? {})) {
        const got = rows.filter((r) => r.kind === kind);
        if (got.length !== n) failures.push(`${got.length} ${kind} items, not ${n}: ${JSON.stringify(got.map((r) => r.text))}`);
      }
      if (fx.absentBytes?.length) {
        const file = c.store.accountFile(undefined);
        const bytes = [file, `${file}-wal`].filter(existsSync).map((f) => readFileSync(f).toString('latin1')).join('');
        for (const s of fx.absentBytes) if (bytes.includes(s)) failures.push(`${JSON.stringify(s)} is in the DB or WAL bytes`);
      }
      expect(failures).toEqual([]);
    });

    if (fx.searches?.length) {
      it('search finds and hides the labeled items', () => {
        const failures: string[] = [];
        for (const s of fx.searches!) {
          const ids = c.store.search(c.scope(s.repo), { query: s.query }).map((v) => v.id);
          const what = `search ${JSON.stringify(s.query)} in ${s.repo} gave [${ids.map((id) => c.name(id))}]`;
          if (s.first && ids[0] !== c.id(s.first)) failures.push(`${what}: ${s.first} is not first`);
          for (const l of s.includes ?? []) if (!ids.includes(c.id(l))) failures.push(`${what}: lacks ${l}`);
          for (const l of s.excludes ?? []) if (ids.includes(c.id(l))) failures.push(`${what}: has ${l}`);
        }
        expect(failures).toEqual([]);
      });
    }

    for (const q of fx.queries ?? []) {
      it(`digest ${q.id} (${q.role}${q.report ? ', reported' : ''})`, () => {
        const scope = (harness: Harness): MemoryScope =>
          ({ ...c.scope(q.repo), nodeId: `n-query-${q.id}`, rootId: `n-query-${q.id}`, harness, model: 'bench' });
        const { text, itemIds } = digestFor(c.store, scope('claude'), { role: q.role, brief: q.brief, now: c.now });
        const { violations, sections } = contract(text, itemIds, q.role);
        const failures = [...violations];
        const injected = new Set(itemIds);
        const shown = `[${itemIds.map((id) => c.name(id))}]`;
        for (const l of q.must ?? []) if (!injected.has(c.id(l))) failures.push(`must ${l} not injected: ${shown}`);
        const rows = new Map(c.rows().map((r) => [r.id, r]));
        for (const l of q.forbidden ?? []) {
          const id = c.id(l);
          if (injected.has(id)) failures.push(`forbidden ${l} injected`);
          // A retracted item must also stay out of search; an ineligible live one stays searchable by design (D4).
          const r = rows.get(id)!;
          if (r.invalid_at !== null && r.text && c.store.search(c.scope(q.repo), { query: r.text }).some((v) => v.id === id)) {
            failures.push(`forbidden retracted ${l} found by search`);
          }
        }
        if (q.ordered) {
          const at = q.ordered.map((l) => itemIds.indexOf(c.id(l)));
          if (at.some((i, n) => i < 0 || (n > 0 && i <= at[n - 1]))) failures.push(`not in order ${q.ordered}: ${shown}`);
        }
        for (const [section, [min, max]] of Object.entries(q.sectionLines ?? {}) as [Section, [number, number]][]) {
          const n = sections[section]?.length ?? 0;
          if (n < min || n > max) failures.push(`${n} lines under ${section}, not ${min}-${max}`);
        }
        for (const s of q.textIncludes ?? []) if (!text.includes(s)) failures.push(`text lacks ${JSON.stringify(s)}`);
        for (const s of q.textExcludes ?? []) if (text.includes(s)) failures.push(`text has ${JSON.stringify(s)}`);
        for (const h of q.sameForHarnesses ?? []) {
          if (digestFor(c.store, scope(h), { role: q.role, brief: q.brief, now: c.now }).text !== text) failures.push(`the digest differs for a ${h} reader`);
        }
        const relevant = new Set([...(q.must ?? []), ...(q.should ?? [])].map((l) => c.id(l)));
        const k = q.k ?? 8;
        const hits = (ids: number[]) => ids.filter((id) => relevant.has(id)).length;
        scores.push({
          case: fx.name, query: q.id, role: q.role, report: !!q.report, k, relevant: relevant.size, injected: itemIds.length,
          ...(relevant.size ? { recallAtK: hits(itemIds.slice(0, k)) / relevant.size } : {}),
          ...(relevant.size ? { precision: itemIds.length ? hits(itemIds) / itemIds.length : 0 } : {}),
          chars: text.length, relatedLines: sections.related?.length ?? 0,
        });
        expect(failures, text).toEqual([]);
      });
    }
  });
}

// R9: placeholders wait as todo or skip, never it.fails, so the suite stays green when the behaviour lands.
// Left for the bench follow-up: captureMemory runs the same redact, nodeHistory, derive and apply as Case.replay, but
// through it each fixture node needs a registry node whose cwd is a checkout with that repo alias's remote, and
// manager.memory stamps add, forget and pin with Date.now, so backdated ops cannot replay without a clock hook.
it.todo('replays fixtures through NodeManager.captureMemory (W5) instead of this file\'s redact, nodeHistory, derive and apply');

describe('aggregate', () => {
  it('meets the floors in fixtures/floors.json', () => {
    const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);
    const counted = scores.filter((s) => !s.report);
    const macroRecallAtK = mean(counted.flatMap((s) => (s.recallAtK === undefined ? [] : [s.recallAtK])));
    const meanWorkerPrecision = mean(counted.flatMap((s) => (s.role === 'worker' && s.precision !== undefined ? [s.precision] : [])));
    console.table(scores.map((s) => ({ ...s, recallAtK: s.recallAtK?.toFixed(2), precision: s.precision?.toFixed(2) })));
    console.log(`macro recall@k ${macroRecallAtK.toFixed(3)} (floor ${floors.macroRecallAtK}); mean worker precision ${meanWorkerPrecision.toFixed(3)} (floor ${floors.meanWorkerPrecision})`);
    if (process.env.BENCH_OUT) {
      mkdirSync(process.env.BENCH_OUT, { recursive: true });
      writeFileSync(join(process.env.BENCH_OUT, 'layer-a.json'), `${JSON.stringify({ floors, macroRecallAtK, meanWorkerPrecision, queries: scores }, null, 2)}\n`);
    }
    expect(macroRecallAtK).toBeGreaterThanOrEqual(floors.macroRecallAtK);
    expect(meanWorkerPrecision).toBeGreaterThanOrEqual(floors.meanWorkerPrecision);
  });
});
