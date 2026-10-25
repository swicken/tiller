import fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NodeRecord } from '../shared/protocol.js';
import { type DueFacts, due, type GardenHost, Gardener, GARDENER_PROMPT, gardenAccount, gardenerSystemPrompt, pausedBy, runSummary, turnBound } from './gardener.js';
import type { GardenActionView, GardenRunView, GardenStore, GardenTarget, GardenUndoTarget, MemoryScope } from './memory-schema.js';

let dir: string, home: string, repo: string, repoKey: string;
let log: string[], store: FakeStore, host: ReturnType<typeof fakeHost>, g: Gardener;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
  vi.setSystemTime(new Date('2026-10-25T12:00:00Z'));
  dir = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), 'tl-gardener-')));
  home = join(dir, 'home'); repo = join(dir, 'repo');
  fs.mkdirSync(home); fs.mkdirSync(repo);
  repoKey = `path:${repo}`;
  writeHome({ memory: { enabled: true, gardener: { enabled: true } } });
  log = [];
  store = new FakeStore(log);
  host = fakeHost(store);
  g = new Gardener(host);
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(async () => {
  await g.stop();
  vi.useRealTimers();
  vi.restoreAllMocks();
  fs.rmSync(dir, { recursive: true, force: true });
});

const writeHome = (data: unknown) => fs.writeFileSync(join(home, 'config.json'), JSON.stringify(data));
const flush = () => new Promise((ok) => setImmediate(ok));
const HOUR = 3_600_000;

function runView(over: Partial<GardenRunView> = {}): GardenRunView {
  return {
    id: 1, repoKey, trigger: 'schedule', state: 'done', startedAt: Date.now() - 48 * HOUR, heartbeatAt: Date.now() - 48 * HOUR, watermark: 0,
    costIncomplete: false, stats: { candidates: [1, 2, 3], maxHides: 10, before: { live: {}, digest: { ids: [], chars: 0 }, redundancy: 0 }, refused: {}, calls: 0, outputChars: 0 },
    ...over,
  };
}
const target = (over: Partial<GardenTarget> = {}): GardenTarget => ({ key: '_default', repoKey, repoPath: repo, newItems: 30, proposals: 5, recent: [], ...over });

/** An in-memory GardenStore: one account file, runs only; the tool methods are not the runtime's. */
class FakeStore implements GardenStore {
  targets: GardenTarget[] = [];
  runsById = new Map<number, GardenRunView>();
  actions: GardenActionView[] = [];
  violations: string[] = [];
  cost = 0;
  nextId = 1;
  skips: { scope: MemoryScope; note: string }[] = [];
  undos: { target: GardenUndoTarget; by: string }[] = [];
  constructor(private readonly log: string[]) {}
  private get(id: number) {
    const r = this.runsById.get(id);
    if (!r) throw new Error(`no such run r${id}`);
    return r;
  }
  gardenTargets() { this.log.push('gardenTargets'); return this.targets; }
  startRun(scope: MemoryScope, input: { trigger: 'schedule' | 'manual'; model: string }) {
    if ([...this.runsById.values()].some((r) => r.state === 'running')) return { ok: false as const, reason: 'another run holds the lease' };
    const run = runView({ id: this.nextId++, repoKey: scope.repoKey, trigger: input.trigger, model: input.model, state: 'running', startedAt: Date.now(), heartbeatAt: Date.now() });
    this.runsById.set(run.id, run);
    this.log.push(`startRun ${input.trigger}`);
    return { ok: true as const, run: { ...run } };
  }
  skipRun(scope: MemoryScope, input: { note: string }) { this.skips.push({ scope, note: input.note }); }
  heartbeat(_: string | undefined, id: number) { this.get(id).heartbeatAt = Date.now(); }
  setRunNode(_: string | undefined, id: number, nodeId: string) { this.get(id).nodeId = nodeId; }
  gardenPage(): never { throw new Error('not the runtime\'s'); }
  gardenGet(): never { throw new Error('not the runtime\'s'); }
  gardenApply(): never { throw new Error('not the runtime\'s'); }
  countCalls(_: string | undefined, id: number, totals: { calls: number; outputChars: number }) { Object.assign(this.get(id).stats, totals); }
  endRun(_: string | undefined, id: number, state: GardenRunView['state'], note?: string) {
    const r = this.get(id);
    if (!(r.state === 'running' || (state === 'reverted' && r.endedAt !== undefined))) return false;
    this.log.push(`endRun ${state}`);
    Object.assign(r, { state, ...(note ? { note } : {}) });
    return true;
  }
  finishRun(account: string | undefined, id: number, cost: { usd: number; incomplete: boolean }) {
    const r = this.get(id);
    if (r.endedAt !== undefined) return { ...r };
    if (r.state === 'running') this.endRun(account, id, 'interrupted');
    this.log.push('finishRun');
    Object.assign(r, { endedAt: Date.now(), costUsd: cost.usd, costIncomplete: cost.incomplete });
    return { ...r };
  }
  verifyRun() { this.log.push('verifyRun'); return this.violations; }
  undo(_: MemoryScope, t: GardenUndoTarget, by: 'human' | 'daemon') {
    this.log.push(`undo ${by}`);
    this.undos.push({ target: t, by });
    for (const a of this.actions) if ('run' in t && a.runId === t.run) Object.assign(a, { undoneAt: Date.now(), undoneBy: by });
    return { undone: [], skipped: [] };
  }
  runs() { return [...this.runsById.values()]; }
  run(_: string | undefined, id: number) { return { ...this.get(id), actions: this.actions.filter((a) => a.runId === id) }; }
  cost30d() { return this.cost; }
}

function fakeHost(s: FakeStore) {
  const records = new Map<string, NodeRecord>(), liveIds = new Set<string>();
  let n = 0;
  return {
    home, store: s, records, liveIds,
    quietNow: true, usage: undefined as number | undefined, trust: true,
    spawns: [] as Parameters<GardenHost['spawnGardener']>[0][],
    outcomes: [] as { id: string; outcome: string; summary: string }[],
    usageKeys: [] as readonly string[],
    async spawnGardener(req: Parameters<GardenHost['spawnGardener']>[0]) {
      const id = `g${++n}`;
      log.push(`spawn ${id}`);
      this.spawns.push(req);
      records.set(id, { id, parentId: null, kind: 'claude', title: 'Memory gardener', cwd: req.repoPath, gardener: { repoKey: req.repoKey, runId: req.runId } } as NodeRecord);
      liveIds.add(id);
      return id;
    },
    async stopGardener(id: string) { log.push(`stop ${id}`); liveIds.delete(id); },
    async closePreviousGardener(key: string) { log.push(`closePrevious ${key}`); },
    quiet() { return this.quietNow; },
    usageFor(keys: readonly string[]) { this.usageKeys = keys; return this.usage; },
    trusted() { return this.trust; },
    live: (id: string) => liveIds.has(id),
    record: (id: string) => records.get(id),
    gardenerRecords: () => [...records.values()],
    setOutcome(id: string, outcome: 'succeeded' | 'failed', summary: string) { log.push(`outcome ${outcome}`); this.outcomes.push({ id, outcome, summary }); },
  };
}

/** Start a scheduled run on the one due target and return the node's id. */
async function startScheduled(): Promise<string> {
  store.targets = [target()];
  await g.tick();
  expect(host.spawns).toHaveLength(1);
  return 'g1';
}
const pre = (tool: string) => ({ hook_event_name: 'PreToolUse', tool_name: tool });
const lastRun = () => store.runsById.get(store.nextId - 1)!;

describe('due', () => {
  const gardener = { enabled: true, model: 'claude-haiku-5-5', minNewItems: 25, maxUsdPerRun: 0.25, maxUsdPer30Days: 3 };
  const facts = (over: Partial<DueFacts> = {}): DueFacts => ({
    now: Date.now(), manual: false, account: { usageKeys: [''] }, memory: { on: true, source: 'default' }, cost30d: 0, quiet: true, usage: undefined, running: false, ...over,
  });
  const failed = (id: number, state: GardenRunView['state'] = 'failed') => runView({ id, state });

  it('is due when every rule holds', () => {
    expect(due(target(), gardener, facts())).toBeUndefined();
    expect(due(target({ recent: [runView({ startedAt: Date.now() - 24 * HOUR })] }), gardener, facts({ usage: 79, cost30d: 2.75 }))).toBeUndefined();
  });

  it.each<[string, Partial<GardenTarget>, Partial<typeof gardener>, Partial<DueFacts>, RegExp]>([
    ['disabled', {}, { enabled: false }, {}, /memory\.gardener\.enabled is false/],
    ['memory off', {}, {}, { memory: { on: false, source: 'memory.enabled in /h/config.json' } }, /memory is off for this project \(memory\.enabled in/],
    ['the memory ceiling', {}, {}, { account: { usageKeys: [''], ceiling: { setting: 'memory', reason: 'claude.accounts me.memory is false' } } }, /memory is off .*me\.memory is false/],
    ['the gardener ceiling', {}, {}, { account: { usageKeys: [''], ceiling: { setting: 'gardener', reason: 'claude.accounts me.gardener is false' } } }, /gardener is disabled .*me\.gardener is false/],
    ['under 24 h', { recent: [runView({ id: 4, startedAt: Date.now() - 23 * HOUR })] }, {}, {}, /r4, started less than 24 h ago/],
    ['below the threshold', { newItems: 24 }, {}, {}, /24 new items, below memory\.gardener\.minNewItems \(25\)/],
    ['fewer than 3 proposals', { proposals: 2 }, {}, {}, /2 daemon proposals/],
    ['over budget', {}, {}, { cost30d: 2.76 }, /over budget: \$2\.76 spent/],
    ['a zero budget', {}, { maxUsdPer30Days: 0 }, {}, /over budget/],
    ['a cap too low for one call', {}, { maxUsdPerRun: 0.03 }, {}, /cannot cover one tool call/],
    ['not quiet', {}, {}, { quiet: false }, /the daemon is busy/],
    ['a live run', {}, {}, { running: true }, /already live/],
    ['paused after 2 failures', { recent: [failed(3, 'capped'), failed(2)] }, {}, {}, /paused after 2 failed runs \(last: capped\)/],
    ['a rate limit at 80 %', {}, {}, { usage: 80 }, /rate limit is at 80%/],
  ])('is not due: %s', (_, t, cfg, f, reason) => {
    expect(due(target(t), { ...gardener, ...cfg }, facts(f))).toMatch(reason);
  });

  it('lets a manual run skip only enabled, the interval, the threshold and the pause', () => {
    const t = target({ newItems: 0, proposals: 0, recent: [runView({ id: 3, state: 'timeout', startedAt: Date.now() - HOUR }), failed(2)] });
    expect(due(t, { ...gardener, enabled: false }, facts({ manual: true }))).toBeUndefined();
    expect(due(t, gardener, facts({ manual: true, memory: { on: false, source: 'default' } }))).toMatch(/memory is off/);
    expect(due(t, gardener, facts({ manual: true, account: { usageKeys: [], ceiling: { setting: 'gardener', reason: 'x' } } }))).toMatch(/disabled/);
    expect(due(t, { ...gardener, maxUsdPer30Days: 0 }, facts({ manual: true }))).toMatch(/over budget/);
    expect(due(t, gardener, facts({ manual: true, running: true }))).toMatch(/already live/);
  });
});

describe('gardenAccount', () => {
  const cfg = (accounts: { name: string; configDir?: string; memory?: boolean; gardener?: boolean }[], account?: string) =>
    ({ claude: { accounts: accounts.map((a) => ({ projects: [], ...a })), account, inheritMcpServers: true } }) as unknown as Parameters<typeof gardenAccount>[0];

  it('maps _default to the configDir-less named account, with both usage keys', () => {
    expect(gardenAccount(cfg([{ name: 'work', configDir: '/w' }, { name: 'me' }]), '_default')).toEqual({ account: 'me', usageKeys: ['', 'me'] });
    expect(gardenAccount(cfg([{ name: 'work', configDir: '/w' }]), '_default')).toEqual({ usageKeys: [''] });
  });

  it('applies a ceiling on either account that governs _default', () => {
    expect(gardenAccount(cfg([{ name: 'me', gardener: false }]), '_default').ceiling).toEqual({ setting: 'gardener', reason: 'claude.accounts me.gardener is false' });
    // No configDir-less account: claude.account governs the default home's file too (fail closed).
    expect(gardenAccount(cfg([{ name: 'work', configDir: '/w', memory: false }], 'work'), '_default').ceiling).toEqual({ setting: 'memory', reason: 'claude.accounts work.memory is false' });
    expect(gardenAccount(cfg([{ name: 'work', configDir: '/w', memory: false }]), '_default').ceiling).toBeUndefined();
  });

  it('maps a named key to its own account and fails closed when it is gone', () => {
    expect(gardenAccount(cfg([{ name: 'work', configDir: '/w' }]), 'work')).toEqual({ account: 'work', usageKeys: ['work'] });
    expect(gardenAccount(cfg([{ name: 'work', configDir: '/w', gardener: false }]), 'work').ceiling?.setting).toBe('gardener');
    expect(gardenAccount(cfg([]), 'work').ceiling).toEqual({ setting: 'memory', reason: 'Claude account "work" is not configured (claude.accounts)' });
  });
});

describe('turnBound', () => {
  // D11's worst case by hand: 90K input tokens at $0.10/MTok is $0.009 a request, plus 40K output tokens at $0.50/MTok.
  const worst = (calls: number) => (calls + 2) * 0.009 + 0.02;

  it('keeps the worst case within the cap, up to 20 calls', () => {
    expect(turnBound(0.25)).toBe(20);
    expect(worst(20)).toBeLessThanOrEqual(0.25);
    expect(turnBound(5)).toBe(20); // a raised cap never raises the bound past 20
    expect(turnBound(0.1)).toBe(6);
    expect(worst(6)).toBeLessThanOrEqual(0.1);
    expect(worst(7)).toBeGreaterThan(0.1);
    expect(turnBound(0.047)).toBe(1);
    expect(turnBound(0.03)).toBe(0);
  });
});

describe('pausedBy', () => {
  it('pauses after two consecutive failures, which off, disabled and interrupted runs neither count nor reset', () => {
    expect(pausedBy([])).toBeUndefined();
    expect(pausedBy([runView({ state: 'failed' })])).toBeUndefined();
    expect(pausedBy([runView({ state: 'reverted' }), runView({ state: 'off' }), runView({ state: 'interrupted' }), runView({ state: 'timeout' })])).toBe('paused after 2 failed runs (last: reverted)');
    expect(pausedBy([runView({ state: 'capped' }), runView({ state: 'done' }), runView({ state: 'failed' })])).toBeUndefined();
    expect(pausedBy([runView({ state: 'done' }), runView({ state: 'failed' }), runView({ state: 'failed' })])).toBeUndefined(); // a successful run clears it
  });

  it('pauses after a done run whose cost was not priced', () => {
    expect(pausedBy([runView({ id: 7, state: 'done', costIncomplete: true }), runView({ state: 'disabled' })])).toBe("paused: run r7's cost was not priced");
    expect(pausedBy([runView({ state: 'done' }), runView({ state: 'done', costIncomplete: true })])).toBeUndefined();
  });
});

describe('Gardener scheduling', () => {
  it('does nothing beyond reading config while the gardener is off (the default)', async () => {
    writeHome({});
    store.targets = [target()];
    await g.tick();
    expect(log).toEqual([]);
  });

  it('starts the target with the most new items, one run at a time', async () => {
    const other = join(dir, 'other');
    fs.mkdirSync(other);
    store.targets = [target(), target({ repoKey: 'path:other', repoPath: other, newItems: 50 })];
    await g.tick();
    expect(host.spawns).toMatchObject([{ repoKey: 'path:other', repoPath: other, runId: 1, model: 'claude-haiku-5-5' }]);
    expect(host.spawns[0].account).toBeUndefined();
    expect(host.spawns[0].prompt).toBe('Garden run r1 for path:other: 3 candidates, 5 daemon proposals. Begin with garden_list.');
    await g.tick();
    expect(host.spawns).toHaveLength(1);
    expect(await g.runNow({ repoPath: repo })).toEqual({ ok: false, reason: 'a garden run is already live' });
  });

  it('closes the previous gardener node after taking the lease and before spawning', async () => {
    await startScheduled();
    expect(log.filter((l) => !l.startsWith('gardenTargets'))).toEqual(['startRun schedule', `closePrevious ${repoKey}`, 'spawn g1']);
    expect(lastRun().nodeId).toBe('g1');
  });

  it('records an untrusted repository or a missing checkout as skipped, without spawning', async () => {
    host.trust = false;
    store.targets = [target()];
    await g.tick();
    expect(host.spawns).toEqual([]);
    expect(store.skips).toEqual([{ scope: { repoKey, repoPath: repo }, note: `run claude once in ${repo} to trust it` }]);
    store.targets = [target({ repoPath: join(dir, 'gone') })];
    host.trust = true;
    await g.tick();
    expect(store.skips[1].note).toBe(`${join(dir, 'gone')} is missing`);
  });

  it('asks for the rate limits under the account file\'s usage keys', async () => {
    host.usage = 85;
    store.targets = [target()];
    await g.tick();
    expect(host.spawns).toEqual([]);
    expect(host.usageKeys).toEqual(['']);
  });

  it('runs by hand while disabled and paused, and waits for the end', async () => {
    writeHome({ memory: { enabled: true } });
    store.targets = [target({ newItems: 0, recent: [runView({ id: 9, state: 'failed', startedAt: Date.now() - HOUR }), runView({ id: 8, state: 'failed' })] })];
    store.nextId = 10;
    const ended = g.runNow({ repoPath: repo }, { wait: true });
    await flush();
    host.records.get('g1')!.spentUsd = 0.04;
    g.measured('g1', { cost: { usd: 0.04 } });
    g.turnDone('g1');
    expect(await ended).toMatchObject({ ok: true, run: { id: 10, trigger: 'manual', state: 'done', costUsd: 0.04, costIncomplete: false } });
  });

  it('refuses a manual run on a ceiling account', async () => {
    writeHome({ memory: { enabled: true }, claude: { accounts: [{ name: 'me', gardener: false }] } });
    store.targets = [target()];
    expect(await g.runNow({ repoPath: repo })).toEqual({ ok: false, reason: 'the gardener is disabled (claude.accounts me.gardener is false)' });
  });
});

describe('Gardener finish paths', () => {
  it('ends a finished turn as done, charging the priced spend, with the summary as outcome', async () => {
    const id = await startScheduled();
    store.actions = [
      { id: 1, runId: 1, ts: 0, action: 'merge', itemId: 2, intoId: 1, seenDelta: 1, reason: 'same', immune: false },
      { id: 2, runId: 1, ts: 0, action: 'supersede', itemId: 5, intoId: 6, seenDelta: 0, reason: 'newer', immune: false },
    ];
    g.turnDone(id);
    await flush();
    expect(lastRun().state).toBe('done'); // the lease flipped at once
    expect(log).not.toContain(`stop ${id}`); // waiting for the turn-end measure
    host.records.get(id)!.spentUsd = 0.04;
    g.measured(id, { cost: { usd: 0.04 } });
    await flush();
    expect(lastRun()).toMatchObject({ state: 'done', costUsd: 0.04, costIncomplete: false });
    expect(log.slice(log.indexOf('endRun done'))).toEqual(['endRun done', `stop ${id}`, 'finishRun', 'verifyRun', 'outcome succeeded']);
    expect(host.outcomes).toEqual([{ id, outcome: 'succeeded', summary: 'merged 1 (2 items), superseded 1 · $0.04 · undo: tl memory garden undo r1' }]);
  });

  it('charges the full cap, marked incomplete, when the turn-end measure is unpriced or missing', async () => {
    let id = await startScheduled();
    host.records.get(id)!.spentUsd = 0.03;
    g.measured(id, { cost: { usd: 0.03, incomplete: true } });
    g.turnDone(id);
    await flush();
    expect(lastRun()).toMatchObject({ state: 'done', costUsd: 0.25, costIncomplete: true });
    expect(pausedBy([lastRun()])).toMatch(/not priced/);

    expect((await g.runNow({ repoPath: repo })).ok).toBe(true);
    id = 'g2';
    g.measured(id, {}); // the measure right after turn.start carries no cost
    g.turnDone(id);
    await vi.advanceTimersByTimeAsync(4_999);
    expect(log).not.toContain(`stop ${id}`);
    await vi.advanceTimersByTimeAsync(1);
    await flush();
    expect(lastRun()).toMatchObject({ state: 'done', costUsd: 0.25, costIncomplete: true });
  });

  it('caps the run at the 21st tool call, charging the full cap', async () => {
    const id = await startScheduled();
    host.records.get(id)!.spentUsd = 0.01;
    for (let i = 0; i < 20; i++) g.hook(id, pre('mcp__tiller__garden_get'));
    expect(g.toolCall(id, 'garden_get')).toMatchObject({ ok: true, callsLeft: 0, runId: 1, scope: { repoKey, repoPath: repo, nodeId: id } });
    expect(log).not.toContain('endRun capped');
    g.hook(id, pre('mcp__tiller__garden_get'));
    expect(g.toolCall(id, 'garden_get')).toEqual({ ok: false, error: 'garden run r1 has ended' });
    await flush();
    expect(lastRun()).toMatchObject({ state: 'capped', note: 'tool-call cap: 20', costUsd: 0.25, costIncomplete: true, stats: { calls: 21 } });
    expect(host.outcomes[0].outcome).toBe('failed');
  });

  it('caps the run when tool output would pass 160,000 characters', async () => {
    const id = await startScheduled();
    expect(g.toolOutput(id, 100_000)).toBe(true);
    expect(g.toolCall(id, 'garden_list')).toMatchObject({ ok: true, outputLeft: 60_000 });
    expect(g.toolOutput(id, 60_001)).toBe(false);
    await flush();
    expect(lastRun()).toMatchObject({ state: 'capped', note: 'tool-output cap: 160000 characters', stats: { outputChars: 100_000 } });
  });

  it('times out on the wall clock, heartbeating meanwhile', async () => {
    const id = await startScheduled();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(lastRun().heartbeatAt).toBe(Date.now());
    await vi.advanceTimersByTimeAsync(10 * 60_000 - 30_000);
    await flush();
    expect(lastRun()).toMatchObject({ state: 'timeout', costUsd: 0.25, costIncomplete: true });
    expect(log).toContain(`stop ${id}`);
  });

  it.each([
    ['memory off', { memory: { enabled: false, gardener: { enabled: true } } }, 'off', /memory is off for this project/],
    ['disabled', { memory: { enabled: true, gardener: { enabled: false } } }, 'disabled', /memory\.gardener\.enabled is false/],
    ['the gardener ceiling', { memory: { enabled: true, gardener: { enabled: true } }, claude: { accounts: [{ name: 'me', gardener: false }] } }, 'disabled', /me\.gardener is false/],
    ['the memory ceiling', { memory: { enabled: true, gardener: { enabled: true } }, claude: { accounts: [{ name: 'me', memory: false }] } }, 'off', /me\.memory is false/],
  ])('stops through the watchdog: %s', async (_, config, state, note) => {
    await startScheduled();
    writeHome(config);
    await vi.advanceTimersByTimeAsync(30_000);
    await flush();
    expect(lastRun()).toMatchObject({ state, note: expect.stringMatching(note), costIncomplete: true });
  });

  it('refuses a tool call once memory is off, ending the run', async () => {
    const id = await startScheduled();
    writeHome({ memory: { enabled: false, gardener: { enabled: true } } });
    expect(g.toolCall(id, 'garden_merge')).toEqual({ ok: false, error: `memory is off for this project (memory.enabled in ${join(home, 'config.json')})` });
    await flush();
    expect(lastRun().state).toBe('off');
  });

  it('ends a run as interrupted when the daemon stops', async () => {
    await startScheduled();
    await g.stop();
    expect(lastRun()).toMatchObject({ state: 'interrupted', costUsd: 0.25, costIncomplete: true });
    await g.tick();
    expect(host.spawns).toHaveLength(1);
  });

  it('fails a run whose process exits before its turn ends, and finishes it once', async () => {
    const id = await startScheduled();
    g.exited(id);
    g.turnDone(id);
    g.exited(id);
    await flush();
    expect(lastRun()).toMatchObject({ state: 'failed', note: 'the gardener exited before its turn ended' });
    expect(log.filter((l) => l === 'finishRun')).toHaveLength(1);
    expect(store.undos).toEqual([]);
  });

  it.each([
    ['a PreToolUse for Bash', (id: string) => g.hook(id, pre('Bash')), 'Bash'],
    ['a PermissionRequest', (id: string) => g.hook(id, { hook_event_name: 'PermissionRequest', tool_name: 'mcp__tiller__send' }), 'mcp__tiller__send'],
    ['an MCP call to spawn', (id: string) => expect(g.toolCall(id, 'spawn')).toMatchObject({ ok: false, error: expect.stringMatching(/spawn is not a gardener tool/) }), 'spawn'],
  ])('trips the wire on %s: failed, then auto-undo', async (_, attempt, tool) => {
    const id = await startScheduled();
    attempt(id);
    await flush();
    expect(lastRun()).toMatchObject({ state: 'failed', note: `tripwire: ${tool}` });
    expect(log.slice(log.indexOf('endRun failed'))).toEqual(['endRun failed', `stop ${id}`, 'finishRun', 'verifyRun', 'undo daemon', 'outcome failed']);
    expect(store.undos).toEqual([{ target: { run: 1 }, by: 'daemon' }]);
  });

  it('ignores hooks that are not tool attempts', async () => {
    const id = await startScheduled();
    g.hook(id, { hook_event_name: 'PostToolUse', tool_name: 'Bash' });
    g.hook(id, { hook_event_name: 'Stop' });
    g.hook('someone-else', pre('Bash'));
    await flush();
    expect(lastRun().state).toBe('running');
  });

  it('reverts a run whose post-run check finds a violation', async () => {
    const id = await startScheduled();
    store.violations = ['m4 hidden without an action row'];
    g.measured(id, { cost: { usd: 0.02 } });
    g.turnDone(id);
    await flush();
    expect(log.slice(log.indexOf('endRun done'))).toEqual(['endRun done', `stop ${id}`, 'finishRun', 'verifyRun', 'undo daemon', 'endRun reverted', 'outcome failed']);
    expect(lastRun()).toMatchObject({ state: 'reverted', note: 'post-run check: m4 hidden without an action row' });
  });

  it('fails the run without charging when the node cannot spawn', async () => {
    host.spawnGardener = async () => { throw new Error('no such account'); };
    store.targets = [target()];
    expect(await g.runNow({ repoPath: repo })).toEqual({ ok: false, reason: 'the gardener could not start: no such account' });
    expect(lastRun()).toMatchObject({ state: 'failed', note: 'spawn failed: no such account', costUsd: 0, costIncomplete: false });
  });
});

describe('Gardener recovery', () => {
  it('recovers a gardener record found at start, charging at least the cap', async () => {
    writeHome({});
    store.runsById.set(5, runView({ id: 5, state: 'running', nodeId: 'old' }));
    host.records.set('old', { id: 'old', parentId: null, kind: 'claude', title: 't', cwd: repo, spentUsd: 0.4, gardener: { repoKey, runId: 5 } } as NodeRecord);
    await g.tick();
    expect(store.runsById.get(5)).toMatchObject({ state: 'interrupted', costUsd: 0.4, costIncomplete: true });
    expect(log).toEqual(['endRun interrupted', 'finishRun', 'verifyRun', 'outcome failed']);
    expect(host.outcomes[0]).toMatchObject({ id: 'old', summary: expect.stringMatching(/^interrupted .*: no changes · \$0\.40\+$/) });
  });

  it('recovers a stale lease with and without a record, never a run whose node is live here', async () => {
    const stale = Date.now() - 300_001;
    store.runsById.set(1, runView({ id: 1, state: 'running', heartbeatAt: stale, nodeId: 'gone' }));
    store.runsById.set(2, runView({ id: 2, state: 'running', heartbeatAt: stale, nodeId: 'mine' }));
    store.runsById.set(3, runView({ id: 3, state: 'running', heartbeatAt: stale, nodeId: 'had' }));
    host.liveIds.add('mine'); // a laptop sleep: this daemon's own node is still live
    host.records.set('had', { id: 'had', parentId: null, kind: 'claude', title: 't', cwd: repo, spentUsd: 0.1 } as NodeRecord);
    store.nextId = 4;
    store.targets = [target({ newItems: 0, recent: [...store.runsById.values()].map((r) => ({ ...r })) })];
    await g.tick();
    expect(store.runsById.get(1)).toMatchObject({ state: 'interrupted', costUsd: 0.25, costIncomplete: true });
    expect(store.runsById.get(3)).toMatchObject({ state: 'interrupted', costUsd: 0.25, costIncomplete: true });
    expect(store.runsById.get(2)!.state).toBe('running');
    expect(host.outcomes.map((o) => o.id)).toEqual(['had']);
  });
});

describe('runSummary', () => {
  const action = (itemId: number, intoId: number, kind: 'merge' | 'supersede' = 'merge', undone = false): GardenActionView =>
    ({ id: itemId, runId: 12, ts: 0, action: kind, itemId, intoId, seenDelta: 0, reason: 'r', immune: false, ...(undone ? { undoneAt: 1, undoneBy: 'daemon' as const } : {}) });

  it('counts merges by final keep and items, and supersedes', () => {
    const run = runView({ id: 12, costUsd: 0.04, actions: [action(2, 1), action(3, 1), action(5, 4), action(7, 9, 'supersede')] });
    expect(runSummary(run)).toBe('merged 2 (5 items), superseded 1 · $0.04 · undo: tl memory garden undo r12');
    expect(runSummary(runView({ id: 12, costUsd: 0.01, actions: [action(2, 1), action(1, 3)] }))).toBe('merged 1 (3 items) · $0.01 · undo: tl memory garden undo r12');
  });

  it('names the state, the note and undone actions', () => {
    expect(runSummary(runView({ id: 12, state: 'failed', note: 'tripwire: Bash', costUsd: 0.25, costIncomplete: true, actions: [action(2, 1, 'merge', true)] })))
      .toBe('failed (tripwire: Bash): 1 undone · $0.25+');
    expect(runSummary(runView({ costUsd: 0 }))).toBe('no changes · $0.00');
  });
});

it('gives the gardener its own preamble and prompt', () => {
  const prompt = gardenerSystemPrompt('n-1');
  expect(prompt).toMatch(/^You are tiller's memory gardener \(node n-1\)\. Your only tools are the four garden tools\./);
  expect(prompt).toContain(GARDENER_PROMPT);
  expect(prompt).not.toMatch(/handoff|report_outcome|# Memory\n/);
});
