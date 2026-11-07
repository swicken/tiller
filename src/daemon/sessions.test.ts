import { appendFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { NodeManager } from './manager.js';
import { buildDigest, expiringSessions, flushEvents, markClosed, markDismissed, markKept, markOpen, markWarned, parseSince, readEvents, readNewEvents, sessionDir, sweepSessions, type SessionEvent } from './sessions.js';

const DAY = 86_400_000;
const read = (f: string) => { try { return readFileSync(f, 'utf8'); } catch { return ''; } };

describe('session directories with a fake claude', () => {
  let home = '';
  let m: NodeManager | undefined;
  afterEach(async () => { await m?.shutdown(); rmSync(home, { recursive: true, force: true }); });

  /** A manager whose claude writes its argv and TL_SESSION_DIR next to the node's settings.json, then idles. */
  function setup() {
    home = mkdtempSync(join(tmpdir(), 'tl-sess-'));
    const bin = join(home, 'bin'), proj = join(home, 'proj');
    mkdirSync(bin);
    mkdirSync(proj);
    writeFileSync(join(bin, 'claude'), '#!/bin/sh\nfor a in "$@"; do case "$prev" in --settings) d="$(dirname "$a")";; esac; prev="$a"; done\nprintf "%s\\n" "$@" > "$d/argv"\necho "$TL_SESSION_DIR" > "$d/env"\nsleep 5\n');
    chmodSync(join(bin, 'claude'), 0o755);
    m = new NodeManager({ home: join(home, 'tl'), shell: '/bin/sh', path: `${bin}:/usr/bin:/bin` });
    return { m, proj, nodeFile: (id: string, f: string) => join(home, 'tl', 'nodes', id, f) };
  }

  it('creates the root\'s directory with meta.json and gives every node in the tree its path', async () => {
    const { m, proj, nodeFile } = setup();
    const root = (await m.spawn({ kind: 'claude', title: 'root', cwd: proj }));
    const worker = (await m.spawn({ kind: 'claude', title: 'w', cwd: proj, parentId: root.id }));
    const dir = sessionDir(m.home, root.id);
    expect(JSON.parse(readFileSync(join(dir, 'meta.json'), 'utf8'))).toMatchObject({ rootId: root.id, title: 'root', cwd: proj });
    await expect.poll(() => read(nodeFile(worker.id, 'env'))).toBe(`${dir}\n`);
    await expect.poll(() => read(nodeFile(root.id, 'env'))).toBe(`${dir}\n`);
    expect(read(nodeFile(worker.id, 'argv'))).toContain(`Notes that must outlive your context go in $TL_SESSION_DIR (${dir}); keep handoff.md there`);
  });

  it('restarts with the given prompt, else the handoff pointer when handoff.md exists, else no prompt', async () => {
    const { m, proj, nodeFile } = setup();
    const { id } = (await m.spawn({ kind: 'claude', title: 'root', cwd: proj }));
    const lastArgs = async () => {
      await expect.poll(() => read(nodeFile(id, 'argv'))).not.toBe('');
      const args = read(nodeFile(id, 'argv')).trimEnd().split('\n');
      rmSync(nodeFile(id, 'argv'));
      return args;
    };
    const firstPrompt = (args: string[]) => (args.at(-2) === '--' ? args.at(-1) : undefined);
    expect(firstPrompt(await lastArgs())).toBeUndefined();

    expect(m.restart(id)).toEqual({ ok: true }); // no handoff.md yet
    expect(firstPrompt(await lastArgs())).toBeUndefined();

    const dir = sessionDir(m.home, id);
    writeFileSync(join(dir, 'handoff.md'), '# state\n');
    m.restart(id);
    expect(firstPrompt(await lastArgs())).toBe(`Read ${join(dir, 'handoff.md')} first; it is your own handoff from before this restart.`);

    writeFileSync(join(dir, 'handoff.md'), 'x'.repeat(33 * 1024));
    m.restart(id);
    expect(firstPrompt(await lastArgs())).toContain('It is over 32 KB: rewrite it as the current state only');

    m.restart(id, 'carry on with step 3');
    expect(firstPrompt(await lastArgs())).toBe('carry on with step 3');
  });

  it('appends events in order and records closedAt when the root closes', async () => {
    const { m, proj } = setup();
    const t0 = Date.now();
    const root = (await m.spawn({ kind: 'claude', title: 'root', cwd: proj }));
    const w = (await m.spawn({ kind: 'claude', title: 'w', cwd: proj, parentId: root.id }));
    m.applyHook(w.id, { hook_event_name: 'UserPromptSubmit', session_id: m.view(w.id)!.sessionId, prompt: 'go' });
    m.applyModEvent(w.id, { event: 'turn.complete', payload: { durationMs: 1, isAborted: false, turnId: 't', reason: 'answer' } });
    m.applyHook(w.id, { hook_event_name: 'Stop', session_id: m.view(w.id)!.sessionId, last_assistant_message: 'all done' }); // after done: still logged
    m.restart(w.id);
    await m.close(w.id);
    await m.close(root.id, true);
    await flushEvents();
    const dir = sessionDir(m.home, root.id);
    const evs = readEvents(dir);
    expect(evs.map((e) => `${e.type}:${e.id === root.id ? 'root' : 'w'}`)).toEqual(['spawn:root', 'spawn:w', 'state:w', 'state:w', 'state:w', 'restart:w', 'close:w', 'close:root']);
    expect(evs[2]).toMatchObject({ from: 'unknown', to: 'working', title: 'w' });
    expect(evs[4]).toMatchObject({ from: 'done', to: 'done', message: 'all done' });
    expect(evs.every((e, i) => e.ts >= t0 && (i === 0 || e.ts >= evs[i - 1]!.ts))).toBe(true);
    expect(JSON.parse(readFileSync(join(dir, 'meta.json'), 'utf8')).closedAt).toBeGreaterThanOrEqual(t0);
  });

  it('logs nothing for the exits that shutdown causes', async () => {
    const { m, proj } = setup();
    const root = await m.spawn({ kind: 'claude', title: 'root', cwd: proj });
    await m.shutdown();
    await expect.poll(() => m.view(root.id)?.status.exited).toBe(true);
    await flushEvents();
    expect(readEvents(sessionDir(m.home, root.id)).map((e) => e.type)).toEqual(['spawn']);
  });
});

describe('sweepSessions', () => {
  let home = '';
  afterEach(() => rmSync(home, { recursive: true, force: true }));

  it('deletes only the directories of gone roots that closed, or went quiet, more than keepDays ago', () => {
    home = mkdtempSync(join(tmpdir(), 'tl-sweep-'));
    const now = Date.now();
    const make = (id: string, meta: object | null, mtime: number) => {
      const dir = sessionDir(home, id);
      mkdirSync(dir, { recursive: true });
      if (meta) writeFileSync(join(dir, 'meta.json'), JSON.stringify({ rootId: id, title: id, cwd: '/', createdAt: now - 30 * DAY, ...meta }));
      writeFileSync(join(dir, 'handoff.md'), 'x');
      for (const f of [join(dir, 'handoff.md'), ...(meta ? [join(dir, 'meta.json')] : []), dir]) utimesSync(f, mtime / 1000, mtime / 1000);
    };
    make('closed-old', { closedAt: now - 20 * DAY }, now - 20 * DAY);
    make('closed-recent', { closedAt: now - 2 * DAY }, now - 20 * DAY); // closedAt wins over old files
    make('gone-quiet', null, now - 20 * DAY);                            // no meta, root gone, nothing written for 20 days
    make('gone-active', null, now - DAY);
    make('live-old', {}, now - 90 * DAY);                                // root still registered: never swept
    expect(sweepSessions(home, new Set(['live-old']), 14, now, false).sort()).toEqual(['closed-old', 'gone-quiet']);
    for (const id of ['closed-recent', 'gone-active', 'live-old']) expect(existsSync(sessionDir(home, id))).toBe(true);
    expect(existsSync(sessionDir(home, 'closed-old'))).toBe(false);
  });
});

describe('retention warnings', () => {
  let home = '';
  let m: NodeManager | undefined;
  afterEach(async () => { await m?.shutdown(); m = undefined; rmSync(home, { recursive: true, force: true }); });
  const now = Date.now();
  /** A directory whose root closed `daysAgo` days ago, optionally with archive lines. */
  const make = (id: string, daysAgo: number, archive: object[] = []) => {
    const dir = sessionDir(home, id);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'meta.json'), JSON.stringify({ rootId: id, title: id, cwd: '/', createdAt: now - 30 * DAY, closedAt: now - daysAgo * DAY }));
    writeFileSync(join(dir, 'archive.jsonl'), archive.map((a) => `${JSON.stringify(a)}\n`).join(''));
  };
  const rootLine = (id: string, extra: object = {}) => ({ id, parentId: null, sessionId: 's', transcriptPath: join(home, 't.jsonl'), cwd: home, closedAt: now, ...extra });
  const meta = (id: string) => JSON.parse(readFileSync(join(sessionDir(home, id), 'meta.json'), 'utf8'));

  it('lists unprotected, unkept directories within 7 days of deletion, soonest first, with their stage', () => {
    home = mkdtempSync(join(tmpdir(), 'tl-ret-'));
    // keepDays 14: deletion 8, 6, 2 and 0.5 days away.
    make('d8', 6); make('d6', 8); make('d2', 12); make('h12', 13.5);
    make('protected', 13); make('kept', 13);
    markKept(home, 'kept');
    markWarned(home, 'h12', now - DAY / 2); // already warned, so the deadline itself decides
    const list = expiringSessions(home, new Set(['protected']), 14, now);
    expect(list.map((s) => [s.rootId, s.stage])).toEqual([['h12', 1], ['d2', 3], ['d6', 7]]);
    expect(list.find((s) => s.rootId === 'd2')).toMatchObject({ title: 'd2', cwd: '/', closedAt: now - 12 * DAY, deleteAt: now + 2 * DAY, dismissed: false });
    expect(sweepSessions(home, new Set(), 0, now, false).sort()).toEqual(['d2', 'd6', 'd8', 'h12', 'protected']); // kept survives keepDays 0
    expect(existsSync(sessionDir(home, 'kept'))).toBe(true);
  });

  it('holds an overdue directory until a day after its last-day warning reached a client', () => {
    home = mkdtempSync(join(tmpdir(), 'tl-ret-'));
    make('never', 20); make('long', 20); make('recent', 20);
    markWarned(home, 'long', now - 25 * 3_600_000);
    markWarned(home, 'recent', now - 2 * 3_600_000);
    expect(markWarned(home, 'recent', now)).toBe(false); // the first delivery counts
    const list = Object.fromEntries(expiringSessions(home, new Set(), 14, now).map((s) => [s.rootId, s]));
    expect(list.never).toMatchObject({ stage: 1, deleteAt: now + DAY });
    expect(list.recent).toMatchObject({ stage: 1, deleteAt: now + 22 * 3_600_000 });
    expect(sweepSessions(home, new Set(), 14, now)).toEqual(['long']);
    expect(sweepSessions(home, new Set(), 14, now, false).sort()).toEqual(['never', 'recent']); // tl sessions clean does not hold
  });

  it('starts warnings over when a root is restored or closed again', () => {
    home = mkdtempSync(join(tmpdir(), 'tl-ret-'));
    make('r', 13.5);
    markWarned(home, 'r', now - 2 * 3_600_000);
    markDismissed(home, 'r', 1);
    expect(expiringSessions(home, new Set(), 14, now)[0]).toMatchObject({ stage: 1, dismissed: true });
    markOpen(home, 'r');
    expect(meta('r')).not.toHaveProperty('dismissedStage');
    markClosed(home, 'r', now - 13.5 * DAY);
    expect(meta('r')).not.toHaveProperty('warnedAt');
    expect(expiringSessions(home, new Set(), 14, now)[0]).toMatchObject({ stage: 1, dismissed: false, deleteAt: now + DAY });
  });

  it('never writes or reads through a symlinked meta.json', () => {
    home = mkdtempSync(join(tmpdir(), 'tl-ret-'));
    const dir = sessionDir(home, 'evil'), target = join(home, 'target.json');
    mkdirSync(dir, { recursive: true });
    writeFileSync(target, '{"title":"secret","closedAt":1}');
    symlinkSync(target, join(dir, 'meta.json'));
    expect(() => markKept(home, 'evil')).toThrow(/not a regular file/);
    markClosed(home, 'evil');
    markOpen(home, 'evil');
    expect(readFileSync(target, 'utf8')).toBe('{"title":"secret","closedAt":1}');
    expect(expiringSessions(home, new Set(), 0, now)[0]).toMatchObject({ rootId: 'evil', title: undefined, closedAt: undefined });
  });

  it('counts a dismissal only at the stage it was made, keeping a meta-less directory\'s age', () => {
    home = mkdtempSync(join(tmpdir(), 'tl-ret-'));
    make('a', 8);
    markDismissed(home, 'a', 7);
    expect(expiringSessions(home, new Set(), 14, now)[0]).toMatchObject({ stage: 7, dismissed: true });
    expect(expiringSessions(home, new Set(), 14, now + 4 * DAY)[0]).toMatchObject({ stage: 3, dismissed: false });
    // No meta.json: the dismissal writes one but keeps the file times its deleteAt comes from.
    const dir = sessionDir(home, 'quiet');
    mkdirSync(dir);
    writeFileSync(join(dir, 'handoff.md'), 'x');
    const old = (now - 10 * DAY) / 1000;
    utimesSync(join(dir, 'handoff.md'), old, old); utimesSync(dir, old, old);
    markDismissed(home, 'quiet', 3);
    expect(expiringSessions(home, new Set(), 14, now).find((s) => s.rootId === 'quiet')).toMatchObject({ stage: 7, dismissed: false });
    expect(expiringSessions(home, new Set(), 14, now + 2 * DAY).find((s) => s.rootId === 'quiet')).toMatchObject({ stage: 3, dismissed: true, title: undefined });
  });

  it('is restorable only when the root\'s newest archive line has a session and no worktree', () => {
    home = mkdtempSync(join(tmpdir(), 'tl-ret-'));
    writeFileSync(join(home, 't.jsonl'), '');
    make('ok', 10, [rootLine('ok'), rootLine('child', { parentId: 'ok' })]);
    make('notranscript', 10, [rootLine('notranscript', { transcriptPath: join(home, 'gone.jsonl') })]);
    make('nocwd', 10, [rootLine('nocwd', { cwd: join(home, 'gone') })]);
    make('none', 10, [rootLine('child', { parentId: 'none' })]);
    make('worktree', 10, [rootLine('worktree', { branch: 'tl/x' })]);
    make('nosession', 10, [rootLine('nosession', { sessionId: undefined })]);
    make('later', 10, [rootLine('later', { closedAt: now }), rootLine('later', { closedAt: now - 1, branch: 'tl/x' })]);
    const r = Object.fromEntries(expiringSessions(home, new Set(), 14, now).map((s) => [s.rootId, s.restorable]));
    expect(r).toEqual({ ok: true, none: false, worktree: false, nosession: false, later: true, notranscript: false, nocwd: false });
  });

  it('manager deletes, keeps and dismisses, refusing protected trees and names outside sessions', async () => {
    home = mkdtempSync(join(tmpdir(), 'tl-ret-'));
    make('gone', 10);
    make('keepme', 10);
    m = new NodeManager({ home, shell: '/bin/sh' });
    expect(m.retention.map((s) => s.rootId)).toEqual(['gone', 'keepme']);
    const emitted: string[][] = [];
    m.on('retention', (list: { rootId: string }[]) => emitted.push(list.map((s) => s.rootId)));
    const n = await m.spawn({ kind: 'terminal', title: 't', cwd: tmpdir() });
    mkdirSync(sessionDir(home, n.id), { recursive: true });
    await expect(m.deleteSession(n.id)).rejects.toThrow(/still has a node/);
    const restoring = m.restore('gone').catch((e: Error) => e.message); // reads the archive asynchronously
    await expect(m.deleteSession('gone')).rejects.toThrow(/still has a node/);
    expect(await restoring).toMatch(/no archived node/);
    for (const bad of ['..', '../tl-x', 'a/b', '.', 'missing']) await expect(m.deleteSession(bad)).rejects.toThrow(/no session directory/);
    await m.keepSession('keepme');
    await m.dismissRetention(['gone']);
    expect(m.retention).toMatchObject([{ rootId: 'gone', stage: 7, dismissed: true }]);
    await m.deleteSession('gone');
    expect(existsSync(sessionDir(home, 'gone'))).toBe(false);
    expect(m.retention).toEqual([]);
    expect(emitted).toEqual([['gone'], ['gone'], []]);
  });
});

describe('event log reading', () => {
  it('filters by --since', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tl-log-'));
    const now = Date.now();
    writeFileSync(join(dir, 'events.jsonl'), [
      { ts: now - 3 * 3_600_000, type: 'spawn', id: 'a' },
      { ts: now - 3_600_000, type: 'state', id: 'a', from: 'working', to: 'done' },
      { ts: now - 60_000, type: 'close', id: 'a' },
    ].map((e) => JSON.stringify(e)).join('\n') + '\nnot json\n');
    expect(parseSince('2h')).toBe(2 * 3_600_000);
    expect(parseSince('15m')).toBe(15 * 60_000);
    expect(parseSince('2 hours')).toBeUndefined();
    expect(readEvents(dir, now - parseSince('2h')!).map((e) => e.type)).toEqual(['state', 'close']);
    expect(readEvents(dir).length).toBe(3); // the bad line is skipped
    rmSync(dir, { recursive: true, force: true });
  });

  it('reads the same events from the tail as a whole-file read, across chunks, bad lines and a partial last line', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tl-log-'));
    const lines: string[] = [];
    for (let i = 0; i < 4000; i++) {
      if (i % 97 === 0) lines.push('not json', '', '{"ts":');
      else if (i === 1500) lines.push(JSON.stringify({ ts: 1000 + i, type: 'note', id: 'a', text: 'x'.repeat(150_000) })); // longer than a chunk
      else lines.push(JSON.stringify({ ts: 1000 + i, type: 'state', id: `n-${i % 7}`, activity: `é✓ ${'ü'.repeat(i % 40)}` }));
    }
    writeFileSync(join(dir, 'events.jsonl'), `${lines.join('\n')}\n{"ts":9999,"type":"cut`);
    // The whole-file read this replaced.
    const whole = (since: number) => readFileSync(join(dir, 'events.jsonl'), 'utf8').split('\n').flatMap((l) => {
      try { const e = JSON.parse(l) as SessionEvent; return e.ts >= since ? [e] : []; } catch { return []; }
    });
    for (const since of [0, 1000, 1001, 2500, 2501, 4990, 4999, 5000, 1e13]) expect(readEvents(dir, since)).toEqual(whole(since));
    expect(readEvents(dir).length).toBe(4000 - 42); // every 97th line is replaced by bad ones
    rmSync(dir, { recursive: true, force: true });
  });

  it('follows appended whole lines and starts over when the log shrinks or is replaced', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tl-log-'));
    const file = join(dir, 'events.jsonl');
    const ev = (ts: number) => `${JSON.stringify({ ts, type: 'state', id: 'a' })}\n`;
    const ts = (r: { events: SessionEvent[] }) => r.events.map((e) => e.ts);
    let r = readNewEvents(dir);
    expect(ts(r)).toEqual([]); // no file yet
    writeFileSync(file, ev(1) + ev(2) + 'not json\n');
    expect(ts(r = readNewEvents(dir, r.cursor))).toEqual([1, 2]);
    expect(ts(r = readNewEvents(dir, r.cursor))).toEqual([]);
    appendFileSync(file, ev(3) + ev(4).slice(0, 5)); // a partial line waits
    expect(ts(r = readNewEvents(dir, r.cursor))).toEqual([3]);
    appendFileSync(file, ev(4).slice(5) + ev(5));
    expect(ts(r = readNewEvents(dir, r.cursor))).toEqual([4, 5]);
    writeFileSync(file, ev(6)); // truncated
    expect(ts(r = readNewEvents(dir, r.cursor))).toEqual([6]);
    writeFileSync(join(dir, 'next'), ev(7) + ev(8) + ev(9) + ev(10) + ev(11) + ev(12));
    renameSync(join(dir, 'next'), file); // replaced by a longer file
    expect(ts(r = readNewEvents(dir, r.cursor))).toEqual([7, 8, 9, 10, 11, 12]);
    appendFileSync(file, ev(13));
    expect(ts(readNewEvents(dir, r.cursor, 13))).toEqual([13]);
    expect(ts(readNewEvents(dir, undefined, 12))).toEqual([12, 13]);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('buildDigest', () => {
  it('reports each node\'s latest state, needs-you first, then errored, then finished, newest first within', () => {
    const ev = (ts: number, type: string, id: string, rest: object = {}): SessionEvent => ({ ts, type, id, title: id.toUpperCase(), ...rest });
    const log = [
      ev(1, 'state', 'done1', { from: 'working', to: 'done', message: 'all green' }),
      ev(2, 'outcome', 'done1', { outcome: 'succeeded', note: 'merged', summary: 'merged the fix' }),
      ev(3, 'state', 'ask', { from: 'working', to: 'waiting', message: 'Which port should I use?' }),
      ev(4, 'state', 'perm', { from: 'working', to: 'blocked', activity: 'needs approval: Bash rm -rf build' }),
      ev(5, 'state', 'answered', { from: 'working', to: 'blocked', activity: 'needs approval: x' }),
      ev(6, 'state', 'answered', { from: 'blocked', to: 'working' }),            // was blocked, no longer: nothing to report
      ev(7, 'state', 'crash', { from: 'working', to: 'done', errored: true, activity: 'API error' }),
      ev(8, 'outcome', 'failed', { outcome: 'failed', note: 'tests do not pass' }),
      ev(9, 'state', 'done2', { from: 'working', to: 'done', message: 'wrote the README' }),
      ev(10, 'cost', 'done2', { usd: 1.2 }),
      ev(11, 'spawn', 'fresh'),
    ];
    expect(buildDigest(log).map((i) => [i.kind, i.id, i.text])).toEqual([
      ['needsYou', 'perm', 'needs approval: Bash rm -rf build'],
      ['needsYou', 'ask', 'Which port should I use?'],
      ['errored', 'failed', 'failed: tests do not pass'],
      ['errored', 'crash', 'API error'],
      ['finished', 'done2', 'wrote the README'],
      ['finished', 'done1', 'succeeded: merged the fix'],
    ]);
    expect(buildDigest(log)[0]!.title).toBe('PERM');
  });
});
