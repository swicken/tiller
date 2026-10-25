// Memory gardener bench Layer G (plan §5.2): the real store and runtime driven through scripted actions on the labeled
// fixtures. Deterministic and LLM-free; Layer H (live.ts) runs the model.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Gardener, type GardenHost } from '../../../src/daemon/gardener.js';
import { keepRank, LIMITS, SCHEMA_V1, type Actor, type GardenActionInput, type ItemRow, type MemoryScope } from '../../../src/daemon/memory-schema.js';
import { MemoryStore } from '../../../src/daemon/memory-store.js';
import { digestMeasure, loadFixture, Seeded } from './fixture.js';

const homes: string[] = [];
const seeded: Seeded[] = [];
afterEach(() => {
  for (const c of seeded.splice(0)) c.store.close();
  for (const h of homes.splice(0)) rmSync(h, { recursive: true, force: true });
  vi.restoreAllMocks();
});
const tempHome = () => {
  const h = mkdtempSync(join(tmpdir(), 'tl-garden-bench-'));
  homes.push(h);
  return h;
};
const seed = (name: string) => {
  const c = new Seeded(loadFixture(name), tempHome());
  seeded.push(c);
  return c;
};

const start = (c: Seeded) => {
  const r = c.store.startRun(c.scope(), { trigger: 'manual', model: 'claude-haiku-5-5' });
  if (!r.ok) throw new Error(r.reason);
  return r.run.id;
};
const end = (c: Seeded, run: number) => {
  c.store.endRun(undefined, run, 'done');
  c.store.finishRun(undefined, run, { usd: 0, incomplete: false });
};
const human: Actor = { kind: 'human' };
/** An agent at a tree root, so what it adds is eligible. */
const rootAgent: Actor = { kind: 'agent', nodeId: 'n-gbench', rootId: 'n-gbench', harness: 'claude', model: 'claude-haiku-5-5' };
const at = (c: Seeded, a: Actor): MemoryScope => (a.kind === 'agent' ? { ...c.scope(), nodeId: a.nodeId, rootId: a.rootId, harness: 'claude' } : c.scope());
const byId = (c: Seeded) => new Map(c.rows().map((r) => [r.id, r]));
/** A labeled cluster's member ids, best first (keepRank), so [0] is the keep the daemon picks. */
const ranked = (c: Seeded, labels: string[]) => {
  const rows = byId(c);
  return labels.map((l) => rows.get(c.id(l))!).sort(keepRank).map((r) => r.id);
};
/** The first labeled cluster with at least n members, none of them pinned. */
const cluster = (c: Seeded, n: number, test: (rows: ItemRow[]) => boolean = () => true) => {
  const rows = byId(c);
  const found = [...c.clusters().values()].find((ls) => ls.length >= n && !ls.some((l) => c.fx.garden[l].protected) && test(ls.map((l) => rows.get(c.id(l))!)));
  if (!found) throw new Error(`${c.fx.name} has no unpinned cluster of ${n}`);
  return ranked(c, found);
};
const merge = (c: Seeded, run: number, ids: number[]) => c.store.gardenApply(undefined, run, { action: 'merge', ids, reason: 'same fact' });
/**
 * [C, A, B] of a three-member cluster for an in-run chain (A+B into A, then A into C): C is re-derived until it is seen
 * more often than A and B together, so it still outranks A once A holds B's seen.
 */
function chain(c: Seeded, except: number[] = []): number[] {
  const [C, A, B] = cluster(c, 3, (rs) => rs[0].kind !== 'open_question' && !rs.some((r) => except.includes(r.id)));
  const rows = byId(c), text = rows.get(C)!;
  for (let seen = text.seen; seen <= rows.get(A)!.seen + rows.get(B)!.seen; seen++) c.store.add(at(c, rootAgent), rootAgent, { kind: text.kind, text: text.text });
  return [C, A, B];
}

type Act = GardenActionInput & { what: string };
/** Every labeled-correct action: merge each duplicate cluster, supersede each supersedable item by its labeled by. */
function oracle(c: Seeded): Act[] {
  const merges = [...c.clusters()].map(([name, ls]): Act => ({ action: 'merge', ids: ls.map((l) => c.id(l)), reason: `duplicates (${name})`, what: name }));
  const supersedes = c.labels((g) => g.stale === 'supersedable').map((l): Act => ({ action: 'supersede', id: c.id(l), by: c.id(c.fx.garden[l].by!), reason: 'answered or replaced', what: l }));
  return [...merges, ...supersedes];
}
/**
 * Apply the actions over as many runs as the caps need: a hides or supersedes refusal ends the run and retries in the next.
 * Every other refusal is a validator false refusal (G1).
 */
function applyAll(c: Seeded, acts: Act[]) {
  const runs = [start(c)];
  const refused: { what: string; message: string }[] = [];
  for (const a of acts) {
    let r = c.store.gardenApply(undefined, runs.at(-1)!, a);
    if (!r.ok && (r.rule === 'hides' || r.rule === 'supersedes')) {
      end(c, runs.at(-1)!);
      runs.push(start(c));
      r = c.store.gardenApply(undefined, runs.at(-1)!, a);
    }
    if (!r.ok) refused.push({ what: a.what, message: r.message });
  }
  end(c, runs.at(-1)!);
  return { runs, refused };
}

describe('G1 oracle', () => {
  for (const name of ['g-small', 'g-std']) {
    it(`${name}: the validator refuses at most 10% of labeled-correct actions, within the caps`, () => {
      const c = seed(name);
      const acts = oracle(c);
      const { runs, refused } = applyAll(c, acts);
      const rate = refused.length / acts.length;
      console.log(`G1 ${name}: ${acts.length} labeled actions over ${runs.length} runs, ${refused.length} refused (${(rate * 100).toFixed(1)}%)`);
      expect(rate, JSON.stringify(refused, null, 1)).toBeLessThanOrEqual(0.1);
      for (const run of runs) expect(c.store.verifyRun(undefined, run)).toEqual([]);
    });
  }
});

describe('G2 adversary', () => {
  it('g-std: refuses every adversarial instruction applied literally, by its named rule, and touches no protected item', () => {
    const c = seed('g-std');
    const run = start(c);
    const failures: string[] = [];
    const applied: number[] = [];
    for (const label of c.labels((g) => g.adversarial)) {
      const g = c.fx.garden[label];
      if (!g.attempt) continue; // "stop early" and the fake heading ask for no action
      const a = g.attempt;
      const r = c.store.gardenApply(undefined, run, a.action === 'merge'
        ? { action: 'merge', ids: a.ids.map((l) => c.id(l)), reason: g.adversarial! }
        : { action: 'supersede', id: c.id(a.id), by: c.id(a.by), reason: g.adversarial! });
      if (!r.ok && !r.message.startsWith(`refused (${r.rule}): `)) failures.push(`${label}: the refusal does not name its rule: ${r.message}`);
      if (g.expect === 'allowed') {
        if (r.ok) applied.push(r.action === 'merge' ? r.hidden[0] : r.hidden);
      } else if (r.ok) failures.push(`${label} (${g.adversarial}) was applied`);
      else if (!g.expect!.refused.includes(r.rule)) failures.push(`${label} (${g.adversarial}) refused as ${r.rule}, not one of ${g.expect!.refused}`);
    }
    const outside = Math.max(...c.rows().map((r) => r.id)) + 1000;
    const r = c.store.gardenApply(undefined, run, { action: 'supersede', id: c.id(c.labels((g) => g.good)[0]), by: outside, reason: 'guessed id' });
    if (r.ok || r.rule !== 'not a candidate') failures.push(`an id outside the candidate set: ${JSON.stringify(r)}`);
    expect(failures).toEqual([]);

    const fenced = new Set([...c.labels((g) => g.protected || g.ineligible).map((l) => c.id(l)),
      ...c.rows().filter((x) => x.kind === 'ledger' || x.author === 'human').map((x) => x.id)]);
    const actions = c.store.run(undefined, run).actions!;
    expect(actions.flatMap((a) => [a.itemId, a.intoId]).filter((id) => id !== undefined && fenced.has(id)).map((id) => c.name(id!))).toEqual([]);
    expect(c.store.verifyRun(undefined, run)).toEqual([]); // includes the hide and supersede caps
    // What D8 allows (the residual risk) is logged and undoable.
    for (const id of applied) {
      expect(c.store.undo(c.scope(), { item: id }, 'human').undone.map((u) => u.itemId)).toEqual([id]);
      expect(byId(c).get(id)!.invalid_at).toBeNull();
    }
    console.log(`G2 g-std: ${actions.length} of the allowed attempts applied, all undone; refused by rule ${JSON.stringify(c.store.run(undefined, run).stats.refused)}`);
  });

  it.todo('G2 through the tools: each attempt as the gardener node\'s garden_merge or garden_supersede over /api, refused with the same rule (needs W4)');
});

describe('G3 undo fidelity', () => {
  it('g-std: undoing every run restores the items rows, with an in-run chain and a pinned keep unpinned before the undo', () => {
    const c = seed('g-std');
    const [C, A, B] = chain(c);
    const before = c.rows();
    const pinCluster = [...c.clusters().values()].find((ls) => ls.some((l) => c.fx.garden[l].protected))!;
    const [pin, dup] = ranked(c, pinCluster);
    expect(c.fx.garden[c.name(pin)].protected).toBe('pin');
    const run = start(c);
    expect(merge(c, run, [A, B])).toMatchObject({ ok: true, kept: A });
    expect(merge(c, run, [A, C])).toMatchObject({ ok: true, kept: C });
    expect(merge(c, run, [dup, pin])).toMatchObject({ ok: true, kept: pin });
    expect(c.store.run(undefined, run).actions!.find((a) => a.itemId === dup)!.seenDelta).toBe(0);
    end(c, run);
    const used = new Set([C, A, B, pin, dup]);
    const rest = applyAll(c, oracle(c).filter((a) => !(a.action === 'merge' ? a.ids : [a.id, a.by]).some((id) => used.has(id))));
    c.store.pin(c.scope(), human, { id: pin, unpin: true });

    for (const r of [...rest.runs].reverse().concat(run)) c.store.undo(c.scope(), { run: r }, 'human');
    const after = byId(c);
    expect(after.get(pin)!.seen).toBe(before.find((r) => r.id === pin)!.seen);
    const changed = before.filter((r) => r.id !== pin && JSON.stringify(after.get(r.id)) !== JSON.stringify(r));
    expect(changed.map((r) => ({ label: c.name(r.id), before: r, after: after.get(r.id) }))).toEqual([]);

    const again = [run, ...rest.runs].map((r) => c.store.undo(c.scope(), { run: r }, 'human'));
    expect(again.every((u) => u.undone.length === 0)).toBe(true);
    expect(JSON.stringify(c.rows())).toBe(JSON.stringify([...after.values()]));
  });
});

describe('G4 redirect', () => {
  it('g-std: re-deriving a merged member bumps its keep; with the keep forgotten, the member revives', () => {
    const c = seed('g-std');
    const [keep, member] = cluster(c, 2, (rs) => rs[0].kind !== 'open_question');
    const rows = byId(c), text = rows.get(member)!;
    end(c, ((run) => (merge(c, run, [member, keep]), run))(start(c)));
    const seen = byId(c).get(keep)!.seen;
    expect(c.store.add(at(c, rootAgent), rootAgent, { kind: text.kind, text: text.text })).toEqual({ id: keep, existing: true, merged: true });
    expect(byId(c).get(keep)!.seen).toBe(seen + 1);
    expect(byId(c).get(member)).toMatchObject({ invalid_kind: 'merged', merged_into: keep });

    c.store.forget(at(c, rootAgent), rootAgent, { id: keep, reason: 'stale' });
    expect(c.store.add(at(c, rootAgent), rootAgent, { kind: text.kind, text: text.text })).toMatchObject({ id: member, revived: true });
    expect(byId(c).get(member)).toMatchObject({ invalid_at: null, invalid_kind: null, merged_into: null });
  });

  it("g-std: a row a v1 daemon revived (merged_into left, invalid_kind cleared) is treated as unmerged", () => {
    const c = seed('g-std');
    const [keep, member] = cluster(c, 2, (rs) => rs[0].kind !== 'open_question');
    const text = byId(c).get(member)!;
    end(c, ((run) => (merge(c, run, [member, keep]), run))(start(c)));
    const db = new DatabaseSync(c.store.accountFile(undefined));
    db.prepare('UPDATE items SET invalid_at = NULL, invalid_kind = NULL, invalid_by = NULL, invalid_reason = NULL WHERE id = ?').run(member);
    db.close();
    const keepSeen = byId(c).get(keep)!.seen;
    expect(c.store.get(c.scope(), member).mergedInto).toBeUndefined();
    expect(c.store.add(at(c, rootAgent), rootAgent, { kind: text.kind, text: text.text })).toEqual({ id: member, existing: true });
    expect(byId(c).get(keep)!.seen).toBe(keepSeen);
    const run = start(c);
    expect(c.store.run(undefined, run).stats.candidates).toContain(member);
  });
});

describe('G5 immunity', () => {
  it('g-std: the human\'s undo of an item makes that pair immune, not the item; a run undo without immune grants nothing', () => {
    const c = seed('g-std');
    const [K, X, M] = cluster(c, 3);
    const r1 = start(c);
    expect(merge(c, r1, [M, K])).toMatchObject({ ok: true, kept: K });
    end(c, r1);
    c.store.undo(c.scope(), { item: M }, 'human');
    const r2 = start(c);
    expect(merge(c, r2, [M, K])).toMatchObject({ ok: false, rule: 'immune' });
    expect(merge(c, r2, [M, X])).toMatchObject({ ok: true, kept: X });
    end(c, r2);
    c.store.undo(c.scope(), { run: r2 }, 'human');
    const r3 = start(c);
    expect(merge(c, r3, [M, X])).toMatchObject({ ok: true, kept: X });
  });
});

describe('G6 digest ceiling', () => {
  it('g-std: the oracle halves digest redundancy, keeps labeled recall and every pin in the orchestrator digest', () => {
    const c = seed('g-std');
    const before = digestMeasure(c, c.store, c.clock);
    applyAll(c, oracle(c));
    const after = digestMeasure(c, c.store, c.clock);
    console.log(`G6 g-std: redundant lines ${before.redundancy} → ${after.redundancy}; brief recall ${before.recall.toFixed(3)} → ${after.recall.toFixed(3)}`);
    expect(before.redundancy).toBeGreaterThan(0);
    expect(after.redundancy).toBeLessThanOrEqual(before.redundancy / 2);
    expect(after.recall).toBeGreaterThanOrEqual(before.recall);
    const pins = new Set(c.labels((g) => g.protected).map((l) => c.id(l)));
    expect(before.orchestrator.filter((id) => pins.has(id)).filter((id) => !after.orchestrator.includes(id))).toEqual([]);
  });
});

describe('G7 idempotence', () => {
  it('g-std: after the oracle, a new run proposes no cluster member or supersede hint that is already hidden', () => {
    const c = seed('g-std');
    applyAll(c, oracle(c));
    const hidden = new Set(c.rows().filter((r) => r.invalid_kind === 'merged' || r.invalid_kind === 'gardener').map((r) => `m${r.id}`));
    expect(hidden.size).toBeGreaterThan(0);
    const page = c.store.gardenPage(undefined, start(c), { callsLeft: 20 });
    if (!('clusters' in page)) throw new Error(page.message);
    expect([...page.clusters.flatMap((x) => x.ids), ...page.supersedeHints.map((h) => h.id)].filter((id) => hidden.has(id))).toEqual([]);
  });
});

describe('G8 purge', () => {
  it('g-std: purging a keep tombstones its merged members, clears their redirect and blanks the action reasons', () => {
    const c = seed('g-std');
    const [keep, ...members] = cluster(c, 2);
    const run = start(c);
    expect(merge(c, run, [keep, ...members])).toMatchObject({ ok: true, kept: keep });
    end(c, run);
    c.store.forget(c.scope(), human, { id: keep, reason: 'holds a secret', purge: true });
    const rows = byId(c);
    for (const id of [keep, ...members]) expect(rows.get(id)).toMatchObject({ text: '', merged_into: null });
    expect(c.store.run(undefined, run).actions!.map((a) => a.reason)).toEqual(members.map(() => ''));
  });
});

describe('G9 lease and recovery', () => {
  it('g-small: refuses a second lease while the heartbeat is live; recovers a stale run, charged the full cap, never one whose node is live here', async () => {
    const c = seed('g-small');
    writeFileSync(join(c.home, 'config.json'), JSON.stringify({ memory: { enabled: true, gardener: { enabled: true } } }));
    const r1 = start(c);
    expect(c.store.startRun(c.scope(), { trigger: 'manual', model: 'm' })).toEqual({ ok: false, reason: `garden run r${r1} holds this memory file's lease` });
    const [keep, member] = cluster(c, 2);
    expect(merge(c, r1, [member, keep])).toMatchObject({ ok: true });
    c.store.setRunNode(undefined, r1, 'n-gone');
    c.clock += LIMITS.garden.leaseMs + 1;
    const r2 = start(c); // the stale lease no longer holds
    c.store.setRunNode(undefined, r2, 'n-live');
    c.clock += LIMITS.garden.leaseMs + 1;

    const host: GardenHost = {
      home: c.home, store: c.store,
      spawnGardener: () => Promise.reject(new Error('no spawn in this case')), stopGardener: async () => {}, closePreviousGardener: async () => {},
      quiet: () => false, usageFor: () => undefined, trusted: () => true,
      live: (id) => id === 'n-live', record: () => undefined, gardenerRecords: () => [], setOutcome: () => {},
    };
    const verify = vi.spyOn(c.store, 'verifyRun');
    const g = new Gardener(host, { now: () => c.clock });
    await g.tick();
    await g.stop();
    expect(c.store.run(undefined, r1)).toMatchObject({ state: 'interrupted', costUsd: 0.25, costIncomplete: true, endedAt: c.clock });
    expect(verify).toHaveBeenCalledWith(undefined, r1);
    expect(byId(c).get(member)!.invalid_kind).toBe('merged'); // an interrupted run is not undone: the human may
    expect(c.store.run(undefined, r2).state).toBe('running');
  });

  it.todo('G9 through the daemon: resumeLive skips a gardener record, and the first tick recovers its run charged the record\'s spend (needs W3)');
});

describe('G10 migration', () => {
  it('g-small: a v1 file migrates to v2 with every item intact', () => {
    const c = seed('g-small');
    const before = c.rows();
    const home = tempHome();
    mkdirSync(join(home, 'memory'));
    const v1 = new DatabaseSync(join(home, 'memory', '_default.db'));
    v1.exec(SCHEMA_V1);
    const cols = (v1.prepare('PRAGMA table_info(items)').all() as { name: string }[]).map((x) => x.name).join(', ');
    v1.exec(`ATTACH '${c.store.accountFile(undefined)}' AS src;
      INSERT INTO repos SELECT * FROM src.repos WHERE key <> 'account:';
      INSERT INTO episodes SELECT * FROM src.episodes;
      INSERT INTO items (${cols}) SELECT ${cols} FROM src.items;
      DETACH src;`);
    expect(v1.prepare('PRAGMA user_version').get()).toEqual({ user_version: 1 });
    v1.close();
    const s = new MemoryStore(home, { now: () => c.clock });
    try {
      expect(s.status()[0]).toMatchObject({ state: 'ok', schema: 2 });
      const text = before.find((r) => r.kind === 'pitfall')!.text;
      expect(s.search(c.scope(), { query: text }).map((v) => v.text)).toContain(text);
      expect(rowsOf(join(home, 'memory', '_default.db'))).toEqual(before);
      expect(s.startRun(c.scope(), { trigger: 'manual', model: 'm' })).toMatchObject({ ok: true });
    } finally {
      s.close();
    }
  });

  it('g-small: a v2 file opened by a store whose SCHEMA_VERSION is 1 is off and never written', async () => {
    const c = seed('g-small');
    seeded.splice(seeded.indexOf(c), 1);
    c.store.close();
    const file = c.store.accountFile(undefined), bytes = readFileSync(file);
    vi.doMock('../../../src/daemon/memory-schema.js', async (orig) => ({ ...(await orig<object>()), SCHEMA_VERSION: 1 }));
    vi.resetModules();
    try {
      const { MemoryStore: V1Store } = await import('../../../src/daemon/memory-store.js');
      const s = new V1Store(c.home, { now: () => c.clock, log: () => {} });
      try {
        expect(s.status()[0].state).toBe('off: written by a newer tiller (schema 2)');
        expect(() => s.pin(c.scope(), human, { text: 'written by the old daemon' })).toThrow('written by a newer tiller');
        expect(() => s.startRun(c.scope(), { trigger: 'manual', model: 'm' })).toThrow('written by a newer tiller');
      } finally {
        s.close();
      }
    } finally {
      vi.doUnmock('../../../src/daemon/memory-schema.js');
      vi.resetModules();
    }
    expect(readFileSync(file).equals(bytes)).toBe(true);
    expect(rowsOf(file)).toHaveLength(c.rows().length);
  });
});

describe('G11 verify shapes', () => {
  it('g-std: an in-run chain and a human forget of a keep mid-run pass the post-run check', () => {
    const c = seed('g-std');
    const [C, A, B] = chain(c);
    const [K, M] = cluster(c, 2, (rs) => !rs.some((r) => [C, A, B].includes(r.id)));
    const run = start(c);
    expect(merge(c, run, [A, B])).toMatchObject({ ok: true, kept: A });
    expect(merge(c, run, [A, C])).toMatchObject({ ok: true, kept: C });
    expect(merge(c, run, [M, K])).toMatchObject({ ok: true, kept: K });
    c.clock += 1000;
    c.store.forget(c.scope(), human, { id: K, reason: 'wrong' });
    end(c, run);
    expect(c.store.verifyRun(undefined, run)).toEqual([]);
  });

  it('g-std: a merge whose chain ends on an item the same run superseded fails the post-run check', () => {
    const c = seed('g-std');
    const rows = byId(c);
    // A procedure a newer one replaced: merge a duplicate into it, then supersede it in the same run.
    const label = c.labels((g) => g.stale === 'supersedable').find((l) => rows.get(c.id(l))!.kind === 'procedure')!;
    const old = { old: c.id(label), by: c.id(c.fx.garden[label].by!) };
    const text = rows.get(old.old)!.text;
    const dup = c.store.add(at(c, rootAgent), rootAgent, { kind: 'procedure', text: `${text} --silent` }).id;
    const run = start(c);
    expect(merge(c, run, [dup, old.old])).toMatchObject({ ok: true, kept: old.old });
    expect(c.store.gardenApply(undefined, run, { action: 'supersede', id: old.old, by: old.by, reason: 'replaced' })).toMatchObject({ ok: true });
    end(c, run);
    expect(c.store.verifyRun(undefined, run)).toEqual([`m${dup} merges into m${old.old}, which r${run} also hid`]);
  });
});

/** Every item row of a memory file, ordered by id. */
function rowsOf(file: string): ItemRow[] {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    return db.prepare('SELECT * FROM items ORDER BY id').all() as unknown as ItemRow[];
  } finally {
    db.close();
  }
}
