import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { dndActive, type Dnd, type NodeStatus, type NodeView } from '../shared/protocol.js';
import { loadConfig, type Notifications } from './config.js';
import { NodeRegistry } from './nodes.js';
import { ptyExited, reduce } from './status.js';
import { content, createNotifier, decide, inQuietHours, notifyArgs, type NotifierDeps } from './notifier.js';

const node = (title: string, status: Partial<NodeStatus> = {}, more: Partial<NodeView> = {}): NodeView => ({
  id: 'n1', parentId: null, kind: 'claude', title, cwd: '/', createdAt: 0, unread: false,
  status: { state: 'done', changedAt: 0, ...status }, ...more,
});
const DEFAULTS = loadConfig(null, mkdtempSync(join(tmpdir(), 'tl-notify-'))).notifications;
const at = (hhmm: string) => new Date(`2026-10-13T${hhmm}:00`);

describe('content', () => {
  it('blocked: needs approval with the tool', () => {
    const n = node('api', { state: 'blocked', activity: 'needs approval: Bash touch /tmp/x' });
    expect(content(n, 'needsYou')).toEqual({ title: 'api', subtitle: undefined, body: 'Needs approval: Bash touch /tmp/x' });
  });

  it('waiting: the question, else the first line of the last message', () => {
    expect(content(node('a', { state: 'waiting', activity: 'question: Which db?' }), 'needsYou').body).toBe('Asks: Which db?');
    expect(content(node('a', { state: 'waiting', lastAssistantMessage: '\nShall I proceed?\nmore' }), 'needsYou').body).toBe('Asks: Shall I proceed?');
  });

  it('done and errored use the first line, 120 chars', () => {
    const msg = 'x'.repeat(200) + '\nsecond';
    expect(content(node('a', { lastAssistantMessage: msg }), 'done').body).toBe(`Finished: ${'x'.repeat(120)}`);
    expect(content(node('a', { errored: true, lastAssistantMessage: 'rate limited' }), 'errored').body).toBe('Turn failed: rate limited');
  });

  it('exited, and the session title as subtitle only when it differs', () => {
    expect(content(node('child'), 'exited', 'session')).toEqual({ title: 'child', subtitle: 'session', body: 'Exited' });
    expect(content(node('same'), 'exited', 'same').subtitle).toBeUndefined();
  });
});

describe('notifyArgs', () => {
  const c = { title: 'api', subtitle: 'sess', body: 'Needs approval: Bash ls', sound: true };
  const base = { terminalNotifier: '/bin/tn', terminalBundle: 'com.mitchellh.ghostty', appConnected: () => false, onClick: (id: string) => `tl select ${id}` };

  it('builds terminal-notifier args, activating the app when connected, else the terminal', () => {
    expect(notifyArgs(c, 'n1', base).args).toEqual([
      '-title', 'api', '-subtitle', 'sess', '-message', 'Needs approval: Bash ls', '-group', 'n1',
      '-sound', 'default', '-activate', 'com.mitchellh.ghostty', '-execute', 'tl select n1',
    ]);
    expect(notifyArgs(c, 'n1', { ...base, appConnected: () => true }).args).toContain('dev.tiller.app');
  });

  it('falls back to osascript without terminal-notifier, escaping quotes', () => {
    const r = notifyArgs({ ...c, body: 'say "hi"', subtitle: undefined }, 'n1', { ...base, terminalNotifier: undefined });
    expect(r).toEqual({ file: 'osascript', args: ['-e', 'display notification "say \\"hi\\"" with title "api"'] });
  });
});

describe('decide', () => {
  it('defaults to actionable attention and a banner level for tree completion', () => {
    expect((['needsYou', 'errored', 'done', 'exited'] as const).map((k) => decide(k, DEFAULTS, at('12:00')).level)).toEqual(['sound', 'silent', 'banner', 'silent']);
    expect(decide('approval', DEFAULTS, at('12:00'))).toEqual({ level: 'sound', why: 'kinds.approval' });
  });

  it('follows the kinds map', () => {
    const cfg: Notifications = { ...DEFAULTS, kinds: { ...DEFAULTS.kinds, needsYou: 'banner', errored: 'silent' } };
    expect(decide('needsYou', cfg, at('12:00')).level).toBe('banner');
    expect(decide('errored', cfg, at('12:00'))).toEqual({ level: 'silent', why: 'kinds.errored' });
  });

  it('quiet hours across midnight: silent except needs-you, which loses its sound', () => {
    const q = { ...DEFAULTS, quietHours: '22:00-07:00' };
    for (const t of ['22:00', '23:59', '00:00', '06:59']) {
      expect(decide('needsYou', q, at(t))).toEqual({ level: 'banner', why: 'quietHours' });
      expect(decide('approval', q, at(t))).toEqual({ level: 'banner', why: 'quietHours' });
      expect(decide('errored', q, at(t)).level).toBe('silent');
      expect(decide('done', q, at(t)).level).toBe('silent');
    }
    for (const t of ['07:00', '12:00', '21:59']) expect(decide('needsYou', q, at(t)).level).toBe('sound');
  });

  it('quiet hours within one day', () => {
    expect([at('12:59'), at('13:00'), at('13:59'), at('14:00')].map((d) => inQuietHours('13:00-14:00', d))).toEqual([false, true, true, false]);
  });
});

describe('dndActive', () => {
  it('is on until it expires, or until turned off when it has no end', () => {
    expect(dndActive({ on: true, until: 1000 }, 999)).toBe(true);
    expect(dndActive({ on: true, until: 1000 }, 1000)).toBe(false);
    expect(dndActive({ on: true }, 1e15)).toBe(true);
    expect(dndActive({ on: false }, 0)).toBe(false);
  });
});

describe('createNotifier', () => {
  const setup = (watchers = 0, opts: { nodes?: NodeView[]; cfg?: Partial<Notifications>; dnd?: Dnd; native?: NotifierDeps['notifyNative'] } = {}) => {
    const calls: string[][] = [], logs: string[] = [];
    let t = 1000, w = watchers, reads = 0;
    const nodes = opts.nodes ?? [node('api', { state: 'blocked', activity: 'needs approval: Bash ls' })];
    const notify = createNotifier({
      view: (id) => nodes.find((n) => n.id === id), tree: () => (reads++, nodes), config: () => (reads++, { ...DEFAULTS, ...opts.cfg }), dnd: () => opts.dnd ?? { on: false },
      watchers: () => w, appConnected: () => false, notifyNative: opts.native, terminalNotifier: '/bin/tn', onClick: (id) => id,
      run: (_f, a) => calls.push(a), now: () => t, log: (l) => logs.push(l),
    } satisfies NotifierDeps);
    return { calls, logs, notify, tick: (ms: number) => { t += ms; }, watch: (n: number) => { w = n; }, reads: () => reads };
  };
  const ev = (kind: 'needsYou' | 'done' | 'errored' | 'exited', id = 'n1') => ({ id, kind, title: 'api' }) as const;

  it('routes only approved content with policy-selected sound to native delivery', async () => {
    const native = vi.fn<NonNullable<NotifierDeps['notifyNative']>>(async () => true);
    const s = setup(0, { native });
    s.notify(ev('needsYou'));
    s.notify(ev('needsYou')); // spent throttle prevents another native offer
    await vi.waitFor(() => expect(native).toHaveBeenCalledTimes(1));
    expect(native).toHaveBeenCalledWith({ id: 'n1', title: 'api', subtitle: undefined, body: 'Needs approval: Bash ls', sound: true });
    expect(s.calls).toEqual([]);
    const banner = setup(0, { native, cfg: { kinds: { ...DEFAULTS.kinds, needsYou: 'banner' } } });
    banner.notify(ev('needsYou'));
    expect(native.mock.calls[1][0].sound).toBe(false);
  });

  it('notifies an approval request with the first line of its text, honouring the level and DND, without a throttle', () => {
    const s = setup(0, { nodes: [] });
    s.notify.approval('\nagent wants to close x (n9)\nmore detail');
    s.notify.approval('agent wants to merge y'); // same instant: approvals are not throttled
    expect(s.calls).toHaveLength(2);
    expect(s.calls[0]).toContain('agent wants to close x (n9)');
    expect(s.calls[0]).toContain('Approval needed');
    expect(s.calls[0]).toContain('default'); // the default level is sound
    const silent = setup(0, { nodes: [], cfg: { kinds: { ...DEFAULTS.kinds, approval: 'silent' } } });
    silent.notify.approval('x');
    const dnd = setup(0, { nodes: [], dnd: { on: true } });
    dnd.notify.approval('x');
    expect([silent.calls, dnd.calls]).toEqual([[], []]);
  });

  it('never offers muted, watched, DND or silent notifications to native delivery', () => {
    const native = vi.fn<NonNullable<NotifierDeps['notifyNative']>>(async () => true);
    for (const s of [
      setup(1, { native }), setup(0, { native, dnd: { on: true } }),
      setup(0, { native, nodes: [node('muted', {}, { muted: true })] }),
      setup(0, { native, cfg: { kinds: { ...DEFAULTS.kinds, needsYou: 'silent' } } }),
    ]) { s.notify(ev('needsYou')); expect(s.calls).toEqual([]); }
    expect(native).not.toHaveBeenCalled();
  });

  it('falls back once when native delivery is absent, unavailable or rejects', async () => {
    for (const native of [undefined, async () => false, async () => { throw new Error('plugin unavailable'); }]) {
      const s = setup(0, { native });
      s.notify(ev('needsYou'));
      await vi.waitFor(() => expect(s.calls).toHaveLength(1));
    }
  });

  it('is silent while a focused client has the node selected, and does not spend the throttle', () => {
    const s = setup(1);
    s.notify(ev('needsYou'));
    expect(s.calls).toHaveLength(0);
    s.watch(0);
    s.notify(ev('needsYou'));
    expect(s.calls).toHaveLength(1);
  });

  it('throttles per node and kind for 5 s', () => {
    const s = setup(0, { cfg: { treeDoneSummary: false } });
    s.notify(ev('needsYou'));
    s.tick(4000); s.notify(ev('needsYou'));
    s.notify(ev('done'));
    expect(s.calls).toHaveLength(2);
    s.tick(1000); s.notify(ev('needsYou'));
    expect(s.calls).toHaveLength(3);
  });

  it('plays a sound only at level sound', () => {
    const s = setup(0, { cfg: { kinds: { ...DEFAULTS.kinds, needsYou: 'banner' } } });
    s.notify(ev('needsYou'));
    expect(s.calls[0]).not.toContain('-sound');
    expect(s.logs).toEqual(['notify n1 needsYou: sent banner (kinds.needsYou)']);
  });

  it('do not disturb sends nothing until it expires', () => {
    const s = setup(0, { dnd: { on: true, until: 3000 } });
    s.notify(ev('needsYou'));
    expect(s.calls).toHaveLength(0);
    expect(s.logs).toEqual(['notify n1 needsYou: suppressed (do not disturb)']);
    s.tick(2000); s.notify(ev('needsYou'));
    expect(s.calls).toHaveLength(1);
  });

  it('a muted node never notifies, and the mute survives a save and reload of the record', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'tl-mute-')), 'state.json');
    const r = new NodeRegistry(file);
    const rec = r.create({ parentId: null, kind: 'claude', title: 'api', cwd: '/' });
    r.update(rec.id, { muted: true });
    r.flush();
    const r2 = new NodeRegistry(file);
    r2.load();
    const s = setup(0, { nodes: [{ ...r2.get(rec.id)!, unread: false, status: { state: 'blocked', changedAt: 0 } }] });
    s.notify(ev('needsYou', rec.id));
    expect(s.calls).toHaveLength(0);
    expect(s.logs).toEqual([`notify ${rec.id} needsYou: suppressed (muted)`]);
  });

  it('tree summary: per-node done is suppressed, and one notification fires when the last node finishes, counting outcomes', () => {
    const root = node('sess', { state: 'done' }, { id: 'r' });
    const a = node('a', { state: 'done' }, { id: 'a', parentId: 'r', outcome: { outcome: 'succeeded', at: 0 } });
    const b = node('b', { state: 'working' }, { id: 'b', parentId: 'r' });
    const c = node('c', { state: 'done' }, { id: 'c', parentId: 'r', outcome: { outcome: 'failed', at: 0 } });
    const sh = node('shell', { state: 'none' }, { id: 't', parentId: 'r', kind: 'terminal' });
    const s = setup(0, { nodes: [root, a, b, c, sh], cfg: { treeDoneSummary: true } });
    s.notify(ev('done', 'a'));
    expect(s.calls).toHaveLength(0);
    b.status = { state: 'done', errored: true, changedAt: 0 };
    s.notify(ev('errored', 'b')); // failure stays visible in the single final summary
    expect(s.calls.map((c) => c[c.indexOf('-message') + 1])).toEqual(['tree sess finished: 2 succeeded, 2 failed']);
    b.status = { ...b.status, exited: true };
    s.notify(ev('exited', 'b')); // an exit after the finish is not a new one
    s.tick(6000);
    s.notify(ev('done', 'a')); // repeated completion events never repeat a summary
    s.notify(ev('exited', 't')); // terminal exits are silent by default
    expect(s.calls).toHaveLength(1);
  });

  it.each(['working', 'queued', 'armed', 'waiting', 'blocked', 'unknown'] as const)('waits for every agent, including a %s root', (state) => {
    const root = node('session', { state }, { id: 'r', kind: 'agent', harness: 'codex' });
    const child = node('child', {}, { id: 'c', parentId: 'r' });
    const s = setup(0, { nodes: [root, child] });
    s.notify(ev('done', 'c'));
    s.notify(ev('errored', 'c'));
    expect(s.calls).toHaveLength(0);
    root.status.state = 'done';
    s.notify(ev('done', 'r'));
    expect(s.calls).toHaveLength(1);
  });

  it('waits for pending launches and gates, then rearms on new work even in a short cycle', () => {
    const root = node('session', {}, { id: 'r' });
    const child = node('child', {}, { id: 'c', parentId: 'r', gate: 'running' });
    const s = setup(0, { nodes: [root, child] });
    s.notify(ev('done', 'r'));
    expect(s.calls).toHaveLength(0);
    child.gate = 'passed';
    s.notify.observe(child); // gate completion has no notify event
    expect(s.calls).toHaveLength(0);
    child.outcome = { outcome: 'succeeded', gate: 'passed', at: 1 };
    s.notify.observe(child);
    expect(s.calls).toHaveLength(1);
    s.notify(ev('done', 'c'));
    expect(s.calls).toHaveLength(1);

    child.pending = { after: [], afterSuccess: [], met: [] };
    s.notify.observe(child);
    s.notify(ev('done', 'r'));
    expect(s.calls).toHaveLength(1);
    delete child.pending;
    child.status = { state: 'working', activity: 'restarting', changedAt: 1 };
    s.notify.observe(child);
    s.notify(ev('done', 'r'));
    expect(s.calls).toHaveLength(1);
    child.status = { state: 'done', exited: true, changedAt: 2 };
    s.notify.observe(child);
    expect(s.calls).toHaveLength(2);
    s.notify(ev('exited', 'c'));
    expect(s.calls).toHaveLength(2);
  });

  it('waits after a failed gate until retries resolve or a final failed outcome is recorded', () => {
    const root = node('session', {}, { id: 'r', gate: 'running' });
    const s = setup(0, { nodes: [root] });
    s.notify.observe(root);
    root.gate = 'failed';
    s.notify.observe(root);
    s.notify(ev('done', 'r'));
    expect(s.calls).toHaveLength(0);
    root.outcome = { outcome: 'failed', gate: 'failed', at: 1 };
    s.notify.observe(root);
    expect(s.calls[0]).toContain('tree session finished: 0 succeeded, 1 failed');
  });

  it('does not rearm when SessionEnd follows an announced Stop and the PTY later exits', () => {
    const root = node('session', { state: 'working' }, { id: 'r', sessionId: 'session-1' });
    const s = setup(0, { nodes: [root] });
    s.notify.observe(root);
    root.status = reduce(root.status, { hook_event_name: 'Stop' }, 10);
    s.notify.observe(root);
    s.notify(ev('done', 'r'));
    expect(s.calls).toHaveLength(1);
    root.status = reduce(root.status, { hook_event_name: 'SessionEnd' }, 20);
    s.notify.observe(root);
    s.tick(6000);
    root.status = ptyExited(root.status, 30);
    s.notify.observe(root);
    s.notify(ev('exited', 'r'));
    expect(s.calls).toHaveLength(1);
  });

  it('accepts a fresh explicit failed report without gate metadata after a failed gate', () => {
    const root = node('session', {}, { id: 'r', gate: 'running' });
    const s = setup(0, { nodes: [root] });
    s.notify.observe(root);
    root.gate = 'failed';
    s.notify.observe(root);
    expect(s.calls).toHaveLength(0);
    root.outcome = { outcome: 'failed', at: 1 }; // report_outcome failed bypasses the gate
    s.notify.observe(root);
    expect(s.calls[0]).toContain('tree session finished: 0 succeeded, 1 failed');
  });

  it.each(['turn', 'restart'] as const)('rejects a retained failed outcome after a new %s while a failed gate awaits retry', (cycle) => {
    const root = node('session', {}, { id: 'r', gate: 'failed', sessionId: 'session-1', outcome: { outcome: 'failed', gate: 'failed', at: 1 } });
    const s = setup(0, { nodes: [root] });
    s.notify(ev('done', 'r'));
    expect(s.calls).toHaveLength(1);
    if (cycle === 'restart') {
      root.sessionId = 'session-2';
      root.status = { state: 'unknown', activity: 'restarting', changedAt: 5 };
      s.notify.observe(root);
    }
    root.status = reduce(root.status, { hook_event_name: 'UserPromptSubmit', prompt_id: 'next' }, 10);
    s.notify.observe(root);
    root.gate = 'running';
    s.notify.observe(root);
    root.status = reduce(root.status, { hook_event_name: 'Stop' }, 20);
    s.notify.observe(root);
    root.gate = 'failed';
    s.notify.observe(root);
    s.notify(ev('done', 'r'));
    expect(s.calls).toHaveLength(1);
    root.outcome = { outcome: 'failed', gate: 'failed', at: 30 };
    s.notify.observe(root);
    expect(s.calls).toHaveLength(2);
  });

  it.each([
    { outcome: undefined, exited: false },
    { outcome: { outcome: 'failed' as const, gate: 'failed' as const, at: 1 }, exited: false },
    { outcome: { outcome: 'failed' as const, gate: 'failed' as const, at: 1 }, exited: true },
  ])('waits for the current outcome after a late successful gate (prior report and exit: %j)', ({ outcome, exited }) => {
    const root = node('session', { state: 'working' }, { id: 'r', outcome });
    const s = setup(0, { nodes: [root] });
    s.notify.observe(root);
    root.gate = 'running';
    s.notify.observe(root);
    root.status = reduce(root.status, { hook_event_name: 'Stop' }, 10);
    s.notify.observe(root); // the worker ended its turn after report_outcome returned pending
    s.notify(ev('done', 'r'));
    expect(s.calls).toHaveLength(0);
    if (exited) {
      root.status = ptyExited(root.status, 15);
      s.notify.observe(root);
    }
    root.gate = 'passed';
    s.notify.observe(root); // manager.runGate emits before mcp.runGate records the report
    expect(s.calls).toHaveLength(0);
    root.outcome = { outcome: 'succeeded', gate: 'passed', at: 20 };
    s.notify.observe(root);
    expect(s.calls.map((c) => c[c.indexOf('-message') + 1])).toEqual(['tree session finished: 1 succeeded, 0 failed']);
    s.notify(ev('done', 'r'));
    expect(s.calls).toHaveLength(1);
  });

  it('rechecks remaining agents when an unfinished child is closed', () => {
    const root = node('session', {}, { id: 'r' });
    const child = node('child', { state: 'armed' }, { id: 'c', parentId: 'r' });
    const nodes = [root, child];
    const s = setup(0, { nodes });
    s.notify.observe(child);
    s.notify(ev('done', 'r'));
    expect(s.calls).toHaveLength(0);
    nodes.pop();
    s.notify.recheck(root); // the removed listener rechecks surviving roots
    expect(s.calls[0]).toContain('tree session finished: 1 succeeded, 0 failed');
  });

  it('still notifies actionable questions and approval after an error, while other agents are active', () => {
    const root = node('session', { state: 'working' }, { id: 'r' });
    const child = node('child', { errored: true }, { id: 'c', parentId: 'r' });
    const s = setup(0, { nodes: [root, child] });
    s.notify(ev('errored', 'c'));
    child.status = { state: 'waiting', activity: 'question: Retry?', changedAt: 1 };
    s.notify(ev('needsYou', 'c'));
    s.tick(5000);
    child.status = { state: 'blocked', activity: 'needs approval: Bash', changedAt: 2 };
    s.notify(ev('needsYou', 'c'));
    expect(s.calls.map((c) => c[c.indexOf('-message') + 1])).toEqual(['Asks: Retry?', 'Needs approval: Bash']);
    expect(s.calls.every((c) => c.includes('-sound'))).toBe(true);
  });

  it('preserves explicit per-node notification overrides when tree summaries are disabled', () => {
    const s = setup(0, { cfg: { treeDoneSummary: false, kinds: { needsYou: 'sound', errored: 'sound', done: 'banner', exited: 'banner', approval: 'sound' } } });
    for (const kind of ['errored', 'done', 'exited'] as const) s.notify(ev(kind));
    expect(s.calls).toHaveLength(3);
  });

  it('observe skips a node event that changes nothing a tree summary reads; recheck always runs', () => {
    const root = node('session', { state: 'working', activity: 'Bash ls' }, { id: 'r', sessionId: 's1' });
    const s = setup(0, { nodes: [root] });
    s.notify.observe(root);
    const reads = s.reads();
    expect(reads).toBeGreaterThan(0);
    root.status = { ...root.status, activity: 'Edit a.ts', changedAt: 5 }; // PreToolUse/PostToolUse churn
    s.notify.observe(root);
    s.notify.observe({ ...root });
    expect(s.reads()).toBe(reads);
    s.notify.recheck(root);
    expect(s.reads()).toBeGreaterThan(reads);
    for (const change of [
      () => { root.status = { ...root.status, state: 'done' }; },
      () => { root.status = { ...root.status, exited: true }; },
      () => { root.gate = 'running'; },
      () => { root.pending = { after: [], afterSuccess: [], met: [] }; },
      () => { root.outcome = { outcome: 'succeeded', at: 1 }; },
      () => { root.sessionId = 's2'; },
    ]) {
      const before = s.reads();
      change();
      s.notify.observe(root);
      expect(s.reads()).toBeGreaterThan(before);
    }
  });

  it('forget drops a removed node\'s throttle and observation state', () => {
    const s = setup();
    s.notify(ev('needsYou'));
    s.notify(ev('needsYou'));
    expect(s.calls).toHaveLength(1); // throttled
    const n = node('api', { state: 'blocked' });
    s.notify.observe(n);
    s.notify.forget('n1');
    s.notify(ev('needsYou'));
    expect(s.calls).toHaveLength(2);
    const reads = s.reads();
    s.notify.observe(n);
    expect(s.reads()).toBeGreaterThan(reads);
  });
});
