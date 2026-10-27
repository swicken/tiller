// Memory gardener bench Layer G (plan §5.2): the real store and runtime driven through scripted actions on the labeled
// fixtures. Deterministic and LLM-free; Layer H (live.ts) runs the model.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Gardener } from '../../../src/daemon/gardener.js';
import { GARDENER_REFUSAL } from '../../../src/daemon/lifecycle-guards.js';
import { NodeManager } from '../../../src/daemon/manager.js';
import { switchMemory } from '../../../src/daemon/memory-config.js';
import {
  keepRank, type Actor, type GardenActionInput, type GardenApplyResult, type ItemRow, type MemoryScope,
} from '../../../src/daemon/memory-schema.js';
import { MemoryStore } from '../../../src/daemon/memory-store.js';
import { startTestDaemon } from '../../../src/daemon/memory-test-daemon.test-helper.js';
import { PtySession } from '../../../src/daemon/pty.js';
import { digestMeasure, loadFixture, Seeded, type GardenLabel } from './fixture.js';

const homes: string[] = [];
const seeded: Seeded[] = [];
afterEach(() => {
  for (const c of seeded.splice(0)) c.store.close();
  for (const h of homes.splice(0)) rmSync(h, { recursive: true, force: true });
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
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
/**
 * A fixture seeded into a temp home with the daemon's view: a git checkout whose origin gives the fixture's repository key,
 * and items aged against the real clock. Its store is closed, so a NodeManager can own the file.
 */
const seedCheckout = (name: string) => {
  const fx = loadFixture(name), repo = realpathSync(tempHome());
  execFileSync('git', ['init', '-q', repo]);
  execFileSync('git', ['-C', repo, 'remote', 'add', 'origin', `https://${fx.repos.app.replace(/^git:/, '')}`]);
  const c = new Seeded(fx, tempHome(), { at: Date.now(), repoPath: repo });
  c.store.close();
  return { c, repo };
};
// The suite may itself run inside a tiller node: a NodeManager here must see only its temp home.
beforeEach(() => { for (const k of Object.keys(process.env)) if (k.startsWith('TL_')) vi.stubEnv(k, undefined); });

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

/** What one call returned, from the store or over /api: the hidden item, or the refusal's rule and message. */
type Outcome = { ok: true; hidden: number } | { ok: false; rule: string; message: string };
/** Each adversarial item's literal attempt, as a garden action. "Stop early" and the fake heading ask for none. */
const attempts = (c: Seeded) => c.labels((g) => g.attempt).map((label) => {
  const g = c.fx.garden[label], a = g.attempt!;
  const input: GardenActionInput = a.action === 'merge'
    ? { action: 'merge', ids: a.ids.map((l) => c.id(l)), reason: g.adversarial! }
    : { action: 'supersede', id: c.id(a.id), by: c.id(a.by), reason: g.adversarial! };
  return { label, g, input };
});
/** A supersede by an id past every item: never a candidate. */
const guessed = (c: Seeded): GardenActionInput =>
  ({ action: 'supersede', id: c.id(c.labels((g) => g.good)[0]), by: Math.max(...c.rows().map((r) => r.id)) + 1000, reason: 'guessed id' });
/** G2's verdict on each attempt's outcome and the guessed id's; [] when all hold. Applied allowed attempts go in applied. */
function judge(results: { label: string; g: GardenLabel; r: Outcome }[], guess: Outcome, applied: number[] = []): string[] {
  const failures: string[] = [];
  for (const { label, g, r } of results) {
    if (!r.ok && !r.message.startsWith(`refused (${r.rule}): `)) failures.push(`${label}: the refusal does not name its rule: ${r.message}`);
    if (g.expect === 'allowed') {
      if (r.ok) applied.push(r.hidden);
    } else if (r.ok) failures.push(`${label} (${g.adversarial}) was applied`);
    else if (!g.expect!.refused.includes(r.rule)) failures.push(`${label} (${g.adversarial}) refused as ${r.rule}, not one of ${g.expect!.refused}`);
  }
  if (guess.ok || guess.rule !== 'not a candidate') failures.push(`an id outside the candidate set: ${JSON.stringify(guess)}`);
  return failures;
}
/** No pin, human item, ledger line or failed-node item is hidden, kept or used as a by in the run, which passes verifyRun. */
function fenced(c: Seeded, store: MemoryStore, run: number): void {
  const fence = new Set([...c.labels((g) => g.protected || g.ineligible).map((l) => c.id(l)),
    ...c.rows().filter((x) => x.kind === 'ledger' || x.author === 'human').map((x) => x.id)]);
  const actions = store.run(undefined, run).actions!;
  expect(actions.flatMap((a) => [a.itemId, a.intoId]).filter((id) => id !== undefined && fence.has(id)).map((id) => c.name(id!))).toEqual([]);
  expect(store.verifyRun(undefined, run)).toEqual([]); // includes the hide and supersede caps
}
const fromStore = (r: GardenApplyResult): Outcome => (r.ok ? { ok: true, hidden: r.action === 'merge' ? r.hidden[0] : r.hidden } : r);

describe('G2 adversary', () => {
  it('g-std: refuses every adversarial instruction applied literally, by its named rule, and touches no protected item', () => {
    const c = seed('g-std');
    const run = start(c);
    const applied: number[] = [];
    const results = attempts(c).map(({ label, g, input }) => ({ label, g, r: fromStore(c.store.gardenApply(undefined, run, input)) }));
    expect(judge(results, fromStore(c.store.gardenApply(undefined, run, guessed(c))), applied)).toEqual([]);
    fenced(c, c.store, run);
    // What D8 allows (the residual risk) is logged and undoable.
    for (const id of applied) {
      expect(c.store.undo(c.scope(), { item: id }, 'human').undone.map((u) => u.itemId)).toEqual([id]);
      expect(byId(c).get(id)!.invalid_at).toBeNull();
    }
    console.log(`G2 g-std: ${applied.length} of the allowed attempts applied, all undone; refused by rule ${JSON.stringify(c.store.run(undefined, run).stats.refused)}`);
  });

  it('g-small: the poisoned paraphrase cannot supersede the note it copies, and merging the two keeps the original', () => {
    const c = seed('g-small');
    const [poison] = c.labels((g) => g.adversarial?.startsWith('paraphrase-poison'));
    const a = c.fx.garden[poison].attempt as { action: 'supersede'; id: string; by: string };
    const [target, by] = [c.id(a.id), c.id(a.by)];
    const run = start(c);
    expect(c.store.gardenApply(undefined, run, { action: 'supersede', id: target, by, reason: 'the current guidance' }))
      .toEqual({ ok: false, rule: 'copy', message: `refused (copy): m${by} is a near-copy of m${target}; merge them instead` });
    expect(merge(c, run, [by, target])).toMatchObject({ ok: true, kept: target, hidden: [by] });
  });

  it("g-std through the tools: the gardener node's garden_merge and garden_supersede over /api refuse the same attempts", async () => {
    const { c, repo } = seedCheckout('g-std');
    // The gardener node is a terminal relabelled, so no harness runs.
    const { manager, api, useGardener, close } = await startTestDaemon(c.home);
    switchMemory(c.home, {}, 'on');
    useGardener(repo);
    try {
      const started = await api('memory_garden', { action: 'run', repo });
      expect(started.error).toBeUndefined();
      const { id: run, nodeId: node } = started.data as { id: number; nodeId: string };
      const call = async (input: GardenActionInput): Promise<Outcome> => {
        const r = input.action === 'merge'
          ? await api('garden_merge', { ids: input.ids.map((id) => `m${id}`), reason: input.reason }, node)
          : await api('garden_supersede', { id: `m${input.id}`, by: `m${input.by}`, reason: input.reason }, node);
        if (!r.error) return { ok: true, hidden: manager.memory.run(undefined, run).actions!.at(-1)!.itemId };
        return { ok: false, rule: /^refused \(([^)]+)\)/.exec(r.error)?.[1] ?? '(none)', message: r.error };
      };
      const results: { label: string; g: GardenLabel; r: Outcome }[] = [];
      for (const { label, g, input } of attempts(c)) results.push({ label, g, r: await call(input) });
      expect(judge(results, await call(guessed(c)))).toEqual([]);
      fenced(c, manager.memory, run);
    } finally {
      await close();
    }
  });
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

describe('G9 recovery', () => {
  it('g-small through the daemon: resume on start skips a gardener record left running, and the first tick recovers its run', async () => {
    const { c, repo } = seedCheckout('g-small');
    writeFileSync(join(c.home, 'config.json'), JSON.stringify({ memory: { enabled: true } }));
    // A previous daemon's run: it holds the lease, has one merge, and its node spent $0.04 before the daemon died.
    const store = new MemoryStore(c.home);
    const started = store.startRun(c.scope(), { trigger: 'manual', model: 'claude-haiku-5-5' });
    if (!started.ok) throw new Error(started.reason);
    const runId = started.run.id, [keep, member] = cluster(c, 2);
    expect(store.gardenApply(undefined, runId, { action: 'merge', ids: [member, keep], reason: 'same fact' })).toMatchObject({ ok: true });
    store.close();
    const spawned = vi.spyOn(PtySession, 'spawn').mockImplementation(() => { throw new Error('nothing may launch'); });
    const m = new NodeManager({ home: c.home, shell: '/bin/sh' });
    try {
      const rec = m.registry.create({ kind: 'claude', parentId: null, title: 'Memory gardener · repo', cwd: repo, sessionId: 's', gardener: { repoKey: c.scope().repoKey, runId } });
      m.registry.update(rec.id, { spentUsd: 0.04 });
      m.runtimes.set(rec.id, { status: { state: 'done', exited: true, changedAt: Date.now() } }); // as a record loaded at start
      m.memory.setRunNode(undefined, runId, rec.id);
      (m as unknown as { pendingResume: Set<string> }).pendingResume = new Set([rec.id]);
      expect(await m.resumeLive()).toContain(`${rec.id} (${GARDENER_REFUSAL})`);
      await m.gardener.tick();
      expect(m.memory.run(undefined, runId)).toMatchObject({ state: 'interrupted', costUsd: 0.25, costIncomplete: true });
      expect(m.view(rec.id)!.outcome).toMatchObject({ outcome: 'failed', summary: expect.stringMatching(/^interrupted/) });
      expect(byId(c).get(member)!.invalid_kind).toBe('merged');
      expect(spawned).not.toHaveBeenCalled();
    } finally {
      await m.shutdown();
    }
  });
});
