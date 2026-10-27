// The Memory panel's daemon side (memory v2 W1) against real temp git repos: target and checkout resolution, the
// opt-in gate on actions, read failures as page states, the purge command's scope, and actions reaching the next digest.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MemoryTarget } from '../shared/protocol.js';
import { NodeManager } from './manager.js';
import { switchMemory } from './memory-config.js';
import { DIGEST_SECTIONS, digestFor } from './memory-digest.js';
import { memoryAction, memoryGiven, memoryItem, memoryPage, type PageQuery } from './memory-panel.js';
import { normalizeDedupe, type DerivedItem, type HistoryEntry, type MemoryScope } from './memory-schema.js';
import { MemoryStore } from './memory-store.js';
import { PtySession, type SpawnOpts } from './pty.js';

class FakeSession {
  private exits: Array<(code: number) => void> = [];
  constructor(readonly opts: SpawnOpts) {}
  onData() {}
  onExit(cb: (code: number) => void) { this.exits.push(cb); }
  async flush() {}
  screenTail() { return []; }
  async write() {}
  classifyScreen() { return 'unknown' as const; }
  kill() { for (const cb of this.exits) cb(0); }
  async terminate() { this.kill(); return true; }
}

const ORIGIN = 'https://example.com/acme/app.git';
const KEY = 'git:example.com/acme/app';
const g = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();

let dir: string, home: string, a: string, b: string, m: NodeManager;
/** A clone of ORIGIN: a git repo whose origin is the same URL, so it has the same repo key. */
function clone(name: string): string {
  const d = join(dir, name);
  mkdirSync(d);
  g(d, 'init', '-q', '-b', 'main');
  g(d, 'remote', 'add', 'origin', ORIGIN);
  return d;
}
beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'tl-memory-panel-')));
  home = join(dir, 'tl');
  a = clone('a');
  b = clone('b');
  vi.spyOn(PtySession, 'spawn').mockImplementation((opts) => new FakeSession(opts) as unknown as PtySession);
  m = new NodeManager({ home, shell: '/bin/sh', path: process.env.PATH });
});
afterEach(async () => { await m.shutdown(); vi.restoreAllMocks(); rmSync(dir, { recursive: true, force: true }); });

const scope = (over: Partial<MemoryScope> = {}): MemoryScope => ({ repoKey: KEY, repoPath: a, nodeId: 'n-root', rootId: 'n-root', ...over });
const item = (kind: DerivedItem['kind'], text: string, author: DerivedItem['author'] = 'agent'): DerivedItem => ({ kind, text, author, dedupe: normalizeDedupe(kind, text) });
const spawnEp = (): HistoryEntry => ({ kind: 'spawn', ts: Date.now(), data: { parentId: null, kind: 'claude' } });
/** Items recorded from repo a by its root node (eligible), so the file's first recorded path is a. */
const seed = (...items: DerivedItem[]) => m.memory.apply(scope(), { episode: spawnEp(), items, cites: [] });
const page = (target: MemoryTarget, q: Omit<PageQuery, 'target'> = {}) => memoryPage(m, { target, ...q });
const node = async (cwd: string, kind: 'claude' | 'terminal' = 'claude') => (await m.spawn({ kind, title: 't', cwd, byHuman: true })).id;
const config = (data: object) => writeFileSync(join(home, 'config.json'), JSON.stringify(data));

describe('target resolution', () => {
  it('resolves a live node, a terminal, and a closed node whose worktree is gone', async () => {
    switchMemory(home, { project: a }, 'on');
    seed(item('procedure', 'npm test'));
    mkdirSync(join(a, 'sub'));
    const live = await node(join(a, 'sub'));
    expect(await page({ nodeId: live })).toMatchObject({
      target: { account: null, repo: KEY, nodeId: live }, file: '_default', state: 'ok', checkout: { path: a, from: 'node' }, on: true,
      items: [{ text: 'npm test', eligible: true }],
    });
    const term = await node(a, 'terminal');
    expect(await page({ nodeId: term })).toMatchObject({ checkout: { path: a, from: 'node' }, on: true });
    const gone = join(a, '.claude', 'worktrees', 'n-gone');
    mkdirSync(gone, { recursive: true });
    const closed = await node(gone);
    m.memory.recordInjection(scope({ nodeId: closed, rootId: closed }), { sessionId: 's-1', arm: 'on', cause: 'config', itemIds: [1], text: '# Memory' });
    await m.close(live, true);
    await m.close(term, true);
    await m.close(closed, true);
    rmSync(gone, { recursive: true });
    expect(await page({ nodeId: closed })).toMatchObject({ target: { repo: KEY, nodeId: closed }, checkout: { path: a, from: 'node' }, on: true });
    // Newest first: the row recorded after its launch's own digest.
    expect((await memoryGiven(m, closed)).map((j) => [j.sessionId === 's-1', j.cause, j.itemIds])).toEqual([[true, 'config', [1]], [false, 'config', [1]]]);
    await expect(page({ nodeId: 'n-nobody' })).rejects.toThrow('no such node: n-nobody');
    await expect(memoryGiven(m, 'n-nobody')).rejects.toThrow('no such node: n-nobody');
  });

  it('opens the no-account file for account null, a named account\'s own file, and refuses an unknown account', async () => {
    config({ claude: { accounts: [{ name: 'work', configDir: join(dir, 'work-claude'), projects: [a] }] } });
    expect(await page({ dir: a })).toMatchObject({ target: { account: 'work', repo: KEY, dir: a }, file: 'work', state: 'missing' });
    expect(await page({ dir: a, account: null })).toMatchObject({ target: { account: null }, file: '_default' });
    await expect(page({ dir: a, account: 'nobody' })).rejects.toThrow(/Claude account "nobody" is not configured/);
    await expect(page({ dir: join(a, 'missing') })).rejects.toThrow('dir must be the absolute path of a directory');
    await expect(page({ dir: 'relative' })).rejects.toThrow('dir must be the absolute path of a directory');
  });

  it('keeps a node with no account on the no-account file, even once its project is assigned an account', async () => {
    const n = await node(a);
    config({ claude: { accounts: [{ name: 'work', configDir: join(dir, 'work-claude'), projects: [a] }] }, memory: { projects: [{ path: a, enabled: true }] } });
    expect(await page({ nodeId: n })).toMatchObject({ target: { account: null }, file: '_default', on: true });
    await memoryAction(m, { nodeId: n }, { kind: 'pinText', text: 'Written to the default file' });
    expect(readdirSync(join(home, 'memory')).filter((f) => f.endsWith('.db'))).toEqual(['_default.db']);
    expect((await page({ nodeId: n })).items.map((v) => v.text)).toEqual(['Written to the default file']);
    expect((await page({ dir: a })).file).toBe('work'); // with no node, the project's account
  });

  it('never gives a node whose checkout is gone another repository of the file', async () => {
    m.memory.apply(scope({ repoKey: 'git:example.com/other', repoPath: join(dir, 'other') }), { episode: spawnEp(), items: [item('note', 'another repository')], cites: [] });
    const c = clone('c'), d = clone('d');
    g(c, 'remote', 'set-url', 'origin', 'https://example.com/acme/c.git');
    m.memory.apply(scope({ repoKey: m.repoKeyOf(d), repoPath: d }), { episode: spawnEp(), items: [item('note', 'from d')], cites: [] });
    const fromC = await node(c), fromD = await node(d);
    await m.close(fromC, true);
    await m.close(fromD, true);
    rmSync(c, { recursive: true });
    renameSync(d, join(dir, 'd-moved'));
    const gone = await page({ nodeId: fromC });
    expect(gone).toMatchObject({ on: null, items: [] });
    expect(gone.target.repo).toBeUndefined();
    // The file recorded the node's own checkout: its repository stays, with no checkout to judge the opt-in for.
    expect(await page({ nodeId: fromD })).toMatchObject({ target: { repo: KEY }, on: null, items: [{ text: 'from d' }] });
  });
});

describe('two clones of one origin (M8)', () => {
  it('judges the opt-in and the write gate for the checkout the human means', async () => {
    switchMemory(home, { project: a }, 'on');
    seed(item('note', 'from clone a'));
    const nodeA = await node(a), nodeB = await node(b);
    expect(await page({ nodeId: nodeA })).toMatchObject({ checkout: { path: a, from: 'node' }, on: true, source: `memory.projects ${a} in ${join(home, 'config.json')}` });
    expect(await memoryAction(m, { nodeId: nodeA }, { kind: 'pinText', text: 'Ask before pushing' })).toMatchObject({ pinned: true });
    const fromB = await page({ nodeId: nodeB });
    expect(fromB).toMatchObject({ target: { repo: KEY }, checkout: { path: b, from: 'node' }, on: false, source: 'default' });
    expect(fromB.items.map((v) => v.text)).toEqual(['Ask before pushing', 'from clone a']);
    await expect(memoryAction(m, { nodeId: nodeB }, { kind: 'pinText', text: 'From b' })).rejects.toThrow(`refused: memory is off for ${b} (default)`);
    // A directory the human chose wins over the node the panel was opened from.
    expect(await page({ nodeId: nodeA, dir: b })).toMatchObject({ checkout: { path: b, from: 'chosen' }, on: false });
    await m.close(nodeA, true);
    await m.close(nodeB, true);
    expect(await page({ dir: b })).toMatchObject({ checkout: { path: b, from: 'chosen' }, on: false });
    expect(await page({})).toMatchObject({ target: { repo: KEY }, checkout: { path: a, from: 'recorded path' }, on: true });
    renameSync(a, join(dir, 'a-moved'));
    const moved = await page({});
    expect(moved).toMatchObject({ on: null, source: 'no checkout of this repository is known; choose its directory' });
    expect(moved.checkout).toBeUndefined();
    await expect(memoryAction(m, {}, { kind: 'pinText', text: 'Nowhere' })).rejects.toThrow('refused: no checkout of this repository is known');
    expect((await page({})).counts).toMatchObject({ note: 2, pinned: 1 });
  });

  it('finds a live node\'s checkout of the repository when the target names none', async () => {
    switchMemory(home, { project: b }, 'on');
    seed(item('note', 'recorded from a'));
    await node(b);
    expect(await page({})).toMatchObject({ checkout: { path: b, from: 'live node' }, on: true });
  });
});

describe('read failures and memory off', () => {
  it('gives a broken file\'s state with empty lists, lists a quarantined file, and says off without node:sqlite', async () => {
    // A new daemon each time: a store retries a file that failed only after LIMITS.store.retryBrokenMs.
    const restart = async () => { await m.shutdown(); m = new NodeManager({ home, shell: '/bin/sh' }); };
    const db = join(home, 'memory', '_default.db');
    mkdirSync(db, { recursive: true }); // a directory where the file should be
    expect(await page({ dir: a })).toMatchObject({ state: expect.stringMatching(/^broken: /), items: [], repos: [], counts: { note: 0, pinned: 0 } });
    rmSync(db, { recursive: true });
    writeFileSync(db, 'this is not a database '.repeat(400));
    await restart();
    const quarantined = await page({ dir: a });
    expect(quarantined.quarantined).toEqual([expect.stringMatching(/_default\.corrupt-\d+\.db$/)]);
    expect(quarantined.state).toBe('missing');
    const s = new MemoryStore(home);
    s.apply(scope(), { episode: spawnEp(), items: [item('note', 'kept')], cites: [] });
    s.close();
    await restart();
    vi.spyOn(process, 'getBuiltinModule').mockReturnValue(undefined as never);
    expect(await page({ dir: a })).toMatchObject({ state: 'off: this Node has no node:sqlite', items: [] });
  });

  it('shows what is kept while memory is off and refuses actions with the deciding setting', async () => {
    seed(item('procedure', 'npm test'), item('note', 'a note'));
    const off = await page({ dir: a });
    expect(off).toMatchObject({ on: false, source: 'default', checkout: { path: a, from: 'chosen' }, counts: { procedure: 1, note: 1 } });
    expect(off.items).toHaveLength(2);
    expect(await memoryItem(m, { dir: a }, 1)).toMatchObject({ item: { id: 1, text: 'npm test' } });
    for (const action of [{ kind: 'pin', itemId: 1 }, { kind: 'forget', itemId: 1, reason: 'x' }, { kind: 'pinText', text: 'x' }] as const) {
      await expect(memoryAction(m, { dir: a }, action)).rejects.toThrow(`refused: memory is off for ${a} (default)`);
    }
    expect((await page({ dir: a })).counts).toMatchObject({ procedure: 1, note: 1, pinned: 0, retracted: 0 });
  });

  it('reads a missing file without creating one', async () => {
    switchMemory(home, { project: a }, 'on');
    expect(await page({ dir: a })).toMatchObject({ state: 'missing', file: '_default', files: [], repos: [], items: [], on: true });
    expect(await page({})).toMatchObject({ state: 'missing', on: null });
    await expect(memoryItem(m, { dir: a }, 1)).rejects.toThrow('no such item m1');
    expect(await memoryGiven(m, await node(a, 'terminal'))).toEqual([]);
    expect(existsSync(join(home, 'memory'))).toBe(false);
  });
});

describe('the purge command\'s scope (D15)', () => {
  it('names the account, omits it only when the checkout\'s own account opens the same file, and is absent otherwise', async () => {
    expect((await page({ dir: a })).cli).toEqual({ repo: a });
    config({ claude: { accounts: [{ name: 'work', configDir: join(dir, 'work-claude'), projects: [a] }] } });
    expect((await page({ dir: a })).cli).toEqual({ repo: a, account: 'work' });
    expect((await page({ dir: a, account: null })).cli).toBeUndefined();
    expect((await page({ dir: b, account: null })).cli).toEqual({ repo: b });
    expect((await page({})).cli).toBeUndefined(); // no checkout known
  });
});

describe('actions reach the next digest (M4)', () => {
  it('changes the next digest per action and leaves a frozen injection as it was', async () => {
    switchMemory(home, { project: a }, 'on');
    seed(item('procedure', 'npm run verify'));
    m.memory.apply(scope({ nodeId: 'n-bad', rootId: 'n-root' }), {
      episode: { kind: 'outcome', ts: Date.now(), data: { outcome: 'failed' } }, items: [item('pitfall', 'gate `npm test` failed: flaky socket')], cites: [],
    });
    const target = { dir: a }, act = (action: Parameters<typeof memoryAction>[2]) => memoryAction(m, target, action);
    const digest = () => digestFor(m.memory, { repoKey: KEY, repoPath: a }, { role: 'orchestrator', brief: '', now: Date.now() }).text;
    const pinned = () => /## Pinned by the human\n([\s\S]*?)(?:\n\n?## |$)/.exec(digest())?.[1] ?? '';
    const frozen = digest();
    m.memory.recordInjection(scope({ nodeId: 'n-frozen' }), { sessionId: 's-frozen', arm: 'on', cause: 'config', itemIds: [1], text: frozen });
    expect(frozen).toContain('npm run verify');
    expect(frozen).not.toContain('flaky socket');

    const pin = await act({ kind: 'pinText', text: 'Always run npm ci first' });
    expect(pinned()).toContain('Always run npm ci first');
    const edited = await act({ kind: 'editPin', itemId: pin.id, text: 'Always run npm ci, never npm install' });
    expect(pinned()).toContain('Always run npm ci, never npm install');
    expect(digest()).not.toContain('Always run npm ci first');
    expect(await act({ kind: 'pinText', text: 'Always run npm ci first' })).toMatchObject({ id: pin.id, pinned: true });
    expect(pinned()).toContain('Always run npm ci first');
    await act({ kind: 'unpin', itemId: edited.id });
    expect(digest()).not.toContain('never npm install');

    await act({ kind: 'forget', itemId: 1, reason: 'stale' });
    expect(digest()).not.toContain('npm run verify');
    seed(item('procedure', 'npm run verify')); // a later node verifies with it again
    expect(digest()).not.toContain('npm run verify');
    await act({ kind: 'restore', itemId: 1 });
    expect(digest()).toContain(`${DIGEST_SECTIONS.verification}\n- [m1]`);

    await act({ kind: 'pin', itemId: 2 });
    expect(pinned()).toContain('flaky socket');
    await act({ kind: 'forget', itemId: 2, reason: 'fixed' });
    expect(digest()).not.toContain('flaky socket');
    expect((await act({ kind: 'restore', itemId: 2 })).pinned).toBe(true);
    expect(pinned()).toContain('flaky socket');
    expect(m.memory.frozen(undefined, 's-frozen')?.text).toBe(frozen);
    expect(readdirSync(join(home, 'memory')).filter((f) => f.endsWith('.db'))).toEqual(['_default.db']);
  });
});
