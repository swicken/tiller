import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFile } from 'node:fs/promises';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { archivedOf, briefOf, findArchived, history } from './archive.js';
import { NodeManager } from './manager.js';
import { nodeTranscript, parseMessages, parseTranscript, readMessages, renderMessage, sessionMessages, TAIL_BYTES } from './transcript.js';
import type { NodeRecord } from '../shared/protocol.js';

// readFile passes through, recorded, so a test can see which archives were read.
vi.mock('node:fs/promises', async (orig) => {
  const m = await orig<typeof import('node:fs/promises')>();
  return { ...m, readFile: vi.fn(m.readFile) };
});

const line = (o: object) => JSON.stringify(o);
const FIXTURE = [
  line({ type: 'user', timestamp: '2026-10-13T10:00:00.000Z', message: { role: 'user', content: 'fix the bug' } }),
  line({ type: 'assistant', timestamp: '2026-10-13T10:00:05.000Z', message: { content: [{ type: 'text', text: 'Looking.' }, { type: 'tool_use', name: 'Bash', input: {} }] } }),
  line({ type: 'user', message: { content: [{ type: 'tool_result', content: 'ok' }] } }), // a tool result: dropped
  line({ type: 'summary', summary: 'x' }), // not a message
  'not json',
  line({ type: 'assistant', message: { content: [{ type: 'text', text: 'Fixed.' }] } }),
].join('\n');

// A Pi session file: a header, then id/parentId message entries. `message.timestamp` is Unix ms.
const PI_FIXTURE = [
  line({ type: 'session', version: 3, id: 'uuid', timestamp: '2026-10-13T10:00:00.000Z', cwd: '/x' }),
  line({ type: 'message', id: 'm1', parentId: null, timestamp: '2026-10-13T10:00:01.000Z', message: { role: 'user', content: 'fix the bug', timestamp: 1000 } }),
  line({ type: 'message', id: 'm2', parentId: 'm1', timestamp: '2026-10-13T10:00:02.000Z', message: { role: 'assistant', content: [{ type: 'text', text: 'Looking.' }, { type: 'toolCall', id: 't1', name: 'bash', arguments: { command: 'ls' } }], timestamp: 2000 } }),
  line({ type: 'message', id: 'm3', parentId: 'm2', timestamp: '2026-10-13T10:00:03.000Z', message: { role: 'toolResult', toolCallId: 't1', toolName: 'bash', content: [{ type: 'text', text: 'ok' }], isError: false, timestamp: 2500 } }),
  'not json',
  'null',
  line({ type: 'message', id: 'm4', parentId: 'm3', timestamp: '2026-10-13T10:00:04.000Z', message: { role: 'assistant', content: [{ type: 'text', text: 'Fixed.' }], timestamp: 3000 } }),
].join('\n');

// The last entry is the active leaf; `c`/`d` hang off `b` and are abandoned.
const PI_BRANCH = [
  line({ type: 'session', version: 3, id: 'uuid', timestamp: '2026-10-13T10:00:00.000Z', cwd: '/x' }),
  line({ type: 'message', id: 'a', parentId: null, message: { role: 'user', content: 'hello', timestamp: 1 } }),
  line({ type: 'message', id: 'b', parentId: 'a', message: { role: 'assistant', content: [{ type: 'text', text: 'hi' }], timestamp: 2 } }),
  line({ type: 'message', id: 'c', parentId: 'b', message: { role: 'user', content: 'abandoned', timestamp: 3 } }),
  line({ type: 'message', id: 'd', parentId: 'c', message: { role: 'assistant', content: [{ type: 'text', text: 'abandoned reply' }], timestamp: 4 } }),
  line({ type: 'message', id: 'e', parentId: 'b', message: { role: 'user', content: 'active', timestamp: 5 } }),
].join('\n');

describe('transcript', () => {
  it('reads user and assistant messages with their time and tool calls', () => {
    expect(parseTranscript(FIXTURE)).toEqual([
      { role: 'user', text: 'fix the bug', at: Date.parse('2026-10-13T10:00:00Z') },
      { role: 'assistant', text: 'Looking.', at: Date.parse('2026-10-13T10:00:05Z'), tools: ['Bash'] },
      { role: 'assistant', text: 'Fixed.' },
    ]);
  });

  it('lists the sessions current first and reads a previous one from the same directory', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tl-tr-'));
    writeFileSync(join(dir, 'cur.jsonl'), FIXTURE);
    writeFileSync(join(dir, 'old2.jsonl'), line({ type: 'user', message: { content: 'earlier' } }));
    const n = { cwd: dir, sessionId: 'cur', previousSessions: ['old1', 'old2'], transcriptPath: join(dir, 'cur.jsonl') };
    const t = await nodeTranscript(n);
    expect(t.sessions).toEqual([{ sessionId: 'cur', current: true }, { sessionId: 'old2', current: false }, { sessionId: 'old1', current: false }]);
    expect(t.entries).toHaveLength(3);
    expect((await nodeTranscript(n, 'old2')).entries).toEqual([{ role: 'user', text: 'earlier' }]);
    await expect(nodeTranscript(n, 'old1')).rejects.toThrow(/session old1 is gone/);
    await expect(nodeTranscript(n, 'other')).rejects.toThrow(/no session other on record/);
    rmSync(dir, { recursive: true, force: true });
  });

  it('reads Pi messages with text and tool calls, honoring the active branch and dropping malformed lines', () => {
    expect(parseTranscript(PI_FIXTURE, 'pi')).toEqual([
      { role: 'user', text: 'fix the bug', at: 1000 },
      { role: 'assistant', text: 'Looking.', at: 2000, tools: ['bash'] },
      { role: 'assistant', text: 'Fixed.', at: 3000 },
    ]);
    expect(parseTranscript(PI_BRANCH, 'pi')).toEqual([
      { role: 'user', text: 'hello', at: 1 },
      { role: 'assistant', text: 'hi', at: 2 },
      { role: 'user', text: 'active', at: 5 },
    ]);
    expect(parseTranscript(PI_FIXTURE)).toEqual([]); // the Claude parser does not see Pi message entries
  });

  it('reads a previous Pi session beside the current one, and needs the current path on record', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tl-pi-'));
    const sessions = join(dir, 'sessions');
    mkdirSync(sessions);
    // The file is named for the daemon's Tiller session id; the Pi header UUID may differ.
    writeFileSync(join(sessions, 'cur.jsonl'), PI_FIXTURE);
    writeFileSync(join(sessions, 'old2.jsonl'), line({ type: 'message', id: 'o', parentId: null, message: { role: 'user', content: 'earlier', timestamp: 7 } }));
    const n = { cwd: '/nowhere', harness: 'pi' as const, sessionId: 'cur', previousSessions: ['old1', 'old2'], transcriptPath: join(sessions, 'cur.jsonl') };
    const t = await nodeTranscript(n);
    expect(t.sessions).toEqual([{ sessionId: 'cur', current: true }, { sessionId: 'old2', current: false }, { sessionId: 'old1', current: false }]);
    expect(t.entries).toHaveLength(3);
    expect((await nodeTranscript(n, 'old2')).entries).toEqual([{ role: 'user', text: 'earlier', at: 7 }]);
    await expect(nodeTranscript(n, 'old1')).rejects.toThrow(/session old1 is gone/);
    await expect(sessionMessages({ cwd: '/home/someone', harness: 'pi', sessionId: 'cur' })).rejects.toThrow(/Pi node needs its transcript path/);
    rmSync(dir, { recursive: true, force: true });
  });

  it('renders text and tool calls in content order', () => {
    const [m] = parseMessages(line({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Read' }, { type: 'text', text: 'Then this.' }, { type: 'tool_use', name: 'Bash' }] } }));
    expect(renderMessage(m!)).toBe('assistant: [tool: Read]\nThen this.\n[tool: Bash]');
  });

  it('reads only the tail of a large file, dropping the cut line, and says so', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tl-tr-'));
    const one = `${line({ type: 'user', message: { content: 'x'.repeat(1000) } })}\n`;
    const path = join(dir, 'big.jsonl');
    writeFileSync(path, one.repeat(Math.ceil(TAIL_BYTES / one.length) + 10) + line({ type: 'user', message: { content: 'last' } }));
    const r = await readMessages(path);
    expect(r.truncated).toBe(true);
    expect(r.messages.at(-1)).toEqual({ role: 'user', parts: [{ text: 'last' }] });
    expect(r.messages.every((x) => 'text' in x.parts[0]! && (x.parts[0].text === 'last' || x.parts[0].text.length === 1000))).toBe(true);
    expect((await readMessages(join(dir, 'big.jsonl'))).messages.length).toBeLessThanOrEqual(2000);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('briefOf', () => {
  const base = { id: 'n-1', rootId: 'n-0', parentId: 'n-0', title: 't', cwd: '/', createdAt: 0, closedAt: 1 };
  it('leads with the outcome and its summary\'s first sentence, else the last message, else the prompt; ends with the branch fate', () => {
    expect(briefOf({ ...base, outcome: { outcome: 'succeeded', summary: 'Added the flag. Also tests.', at: 0 }, branch: 'tl/n-1', branchFate: 'merged', base: 'main' }))
      .toBe('succeeded: Added the flag. (merged into main)');
    expect(briefOf({ ...base, outcome: { outcome: 'failed', note: 'tests fail', at: 0 }, branchFate: 'kept' })).toBe('failed: tests fail (branch kept, unmerged)');
    expect(briefOf({ ...base, lastAssistantMessage: '\nDone with it.\nMore.', prompt: 'p', branchFate: 'discarded' })).toBe('Done with it. (branch discarded)');
    expect(briefOf({ ...base, prompt: 'write docs\nplease' })).toBe('write docs');
    const long = briefOf({ ...base, lastAssistantMessage: 'x'.repeat(500), branchFate: 'kept' })!;
    expect(long).toHaveLength(200);
    expect(long.endsWith('… (branch kept, unmerged)')).toBe(true);
  });
});

describe('archivedOf harness', () => {
  const rec: NodeRecord = { id: 'n-1', parentId: null, kind: 'claude', title: 't', cwd: '/', createdAt: 0 };
  it('records a nonlegacy harness and leaves the legacy default unset', () => {
    expect(archivedOf({ ...rec, harness: 'pi' }, undefined, undefined, 'n-1', {})).toMatchObject({ id: 'n-1', harness: 'pi' });
    expect(archivedOf({ ...rec, harness: 'claude' }, undefined, undefined, 'n-1', {})).not.toHaveProperty('harness');
    expect(archivedOf(rec, undefined, undefined, 'n-1', {})).not.toHaveProperty('harness');
  });
  it('preserves Pi provider qualifiers for the same selected model and ignores its no-model sentinel', () => {
    const pi = { ...rec, harness: 'pi' as const, model: 'anthropic/claude-sonnet-4-5' };
    const status = { state: 'done' as const, changedAt: 0, model: 'claude-sonnet-4-5' };
    expect(archivedOf(pi, status, undefined, 'n-1', {}).model).toBe(pi.model);
    expect(archivedOf(pi, { ...status, model: 'unknown' }, undefined, 'n-1', {}).model).toBe(pi.model);
    expect(archivedOf({ ...pi, model: undefined }, { ...status, model: 'unknown' }, undefined, 'n-1', {}).model).toBeUndefined();
    expect(archivedOf(pi, { ...status, model: 'openai/other' }, undefined, 'n-1', {}).model).toBe('openai/other');
    expect(archivedOf(pi, { ...status, model: 'other' }, undefined, 'n-1', {}).model).toBe('other'); // Do not reuse a stale requested model.
    expect(archivedOf({ ...rec, model: 'old' }, status, undefined, 'n-1', {}).model).toBe(status.model); // Claude is unchanged.
  });
});

describe('findArchived', () => {
  let home = '';
  afterEach(() => rmSync(home, { recursive: true, force: true }));

  it('finds the same node with and without a preferred tree, and a hit in that tree reads no other', async () => {
    home = mkdtempSync(join(tmpdir(), 'tl-find-'));
    const tree = (rootId: string, ...nodes: object[]) => {
      mkdirSync(join(home, 'sessions', rootId), { recursive: true });
      writeFileSync(join(home, 'sessions', rootId, 'archive.jsonl'), `${nodes.map(line).join('\n')}\nnot json\n`);
    };
    // n-dup is in both trees; t2's copy closed later and claims rootId t1, which the directory overrides.
    tree('t1', { id: 'n-a', title: 'a', closedAt: 10 }, { id: 'n-dup', title: 'old', closedAt: 20 }, { id: 'n-dup', title: 'older tie', closedAt: 20 });
    tree('t2', { id: 'n-b', title: 'b', closedAt: 30 }, { id: 'n-dup', title: 'new', rootId: 't1', closedAt: 40 });
    const find = async (id: string, prefer?: string) => (await findArchived(home, id, prefer))?.title;
    for (const prefer of [undefined, 't1', 't2', 't3']) expect(await find('n-missing', prefer)).toBeUndefined();
    expect([await find('n-a'), await find('n-a', 't1'), await find('n-a', 't2')]).toEqual(['a', 'a', 'a']);
    expect([await find('n-b'), await find('n-b', 't1'), await find('n-b', 't3')]).toEqual(['b', 'b', 'b']);
    expect([await find('n-dup'), await find('n-dup', 't1'), await find('n-dup', 't2')]).toEqual(['new', 'old', 'new']);
    expect((await findArchived(home, 'n-dup'))?.rootId).toBe('t2');

    vi.mocked(readFile).mockClear();
    expect(await find('n-a', 't1')).toBe('a');
    expect(vi.mocked(readFile).mock.calls.map(([p]) => p)).toEqual([join(home, 'sessions', 't1', 'archive.jsonl')]);
  });
});

describe('archive, history, follow-up and fork', () => {
  let home = '';
  let m: NodeManager;
  afterEach(async () => { await m.shutdown(); rmSync(home, { recursive: true, force: true }); }); // flush before the home goes, so no append fails after teardown

  /** A manager whose `claude` writes its argv to <node dir>/argv and idles. */
  const setup = () => {
    home = mkdtempSync(join(tmpdir(), 'tl-arch-'));
    const bin = join(home, 'bin');
    mkdirSync(bin);
    writeFileSync(join(bin, 'claude'), '#!/bin/sh\nfor a in "$@"; do case "$prev" in --settings) out="$(dirname "$a")/argv";; esac; prev="$a"; done\necho "$@" > "$out"\nsleep 5\n');
    chmodSync(join(bin, 'claude'), 0o755);
    m = new NodeManager({ home, shell: '/bin/sh', path: `${bin}:/usr/bin:/bin` });
  };
  const argv = async (id: string) => {
    const file = join(home, 'nodes', id, 'argv');
    await expect.poll(() => { try { return readFileSync(file, 'utf8'); } catch { return ''; } }).not.toBe('');
    return readFileSync(file, 'utf8');
  };
  /** A started claude node: SessionStart has given it a transcript. */
  const started = async (title: string, parentId: string | null, prompt?: string) => {
    const { id } = await m.spawn({ kind: 'claude', title, cwd: home, parentId, prompt, byHuman: true });
    const transcriptPath = join(home, `${m.registry.get(id)!.sessionId}.jsonl`);
    writeFileSync(transcriptPath, FIXTURE);
    m.applyHook(id, { hook_event_name: 'SessionStart', session_id: m.registry.get(id)!.sessionId, transcript_path: transcriptPath });
    return id;
  };

  it('archives a closed Claude node with its prompt, outcome and branch fate, not a terminal; history filters by query and tree', async () => {
    setup();
    const root = await started('root', null, 'lead the work');
    const a = await started('parser', root, 'write the parser');
    const b = await started('docs', root, 'write the docs');
    const c = await started('cleanup', root);
    const t = (await m.spawn({ kind: 'terminal', title: 'term', cwd: home, parentId: root })).id;
    m.setOutcome(a, { outcome: 'succeeded', summary: 'Parser done. Tests pass.', at: 1 });
    m.registry.update(a, { worktree: { repo: home, path: join(home, 'wt'), branch: `tl/${a}`, base: 'main', baseSha: 'x' }, spentUsd: 0.5 });
    // Match closeWorktreeNode: wait for the processes to stop before discarding their files.
    const closing = [a, b, c].map((id) => m.kill(id)!);
    await expect.poll(() => closing.every((session) => session.exited)).toBe(true);
    m.closed(a, undefined, { branchFate: 'merged', base: 'main' }); // what closeWorktreeNode passes for a merged branch
    m.closed(b, 'kept branch tl/b', { branchFate: 'kept' });
    m.closed(c, undefined, { branchFate: 'discarded' });
    await m.close(t);
    const other = await started('elsewhere', null, 'unrelated parser');
    await m.close(other, true);

    const all = await history(home);
    expect(all.map((x) => x.id).sort()).toEqual([a, b, c, other].sort());
    expect(all.find((x) => x.id === a)).toMatchObject({
      rootId: root, parentId: root, title: 'parser', prompt: 'write the parser', role: 'worker', outcome: { outcome: 'succeeded' },
      branch: `tl/${a}`, branchFate: 'merged', base: 'main', spentUsd: 0.5, sessionId: expect.any(String), transcriptPath: expect.stringContaining('.jsonl'),
      brief: 'succeeded: Parser done. (merged into main)', closedAt: expect.any(Number),
    });
    expect(all.find((x) => x.id === b)).toMatchObject({ branchFate: 'kept', brief: 'write the docs (branch kept, unmerged)' });
    expect(all.find((x) => x.id === c)).toMatchObject({ branchFate: 'discarded', brief: '(branch discarded)' });
    expect(all[0]!.closedAt).toBeGreaterThanOrEqual(all.at(-1)!.closedAt);
    expect((await history(home, { query: 'PARSER' })).map((x) => x.id).sort()).toEqual([a, other].sort());
    expect((await history(home, { query: 'parser', rootId: root })).map((x) => x.id)).toEqual([a]);
  });

  it('archives every node of a tree under its root, through prune (root first in the registry) and after a forced root close', async () => {
    setup();
    const root = await started('root', null);
    const kid = await started('kid', root);
    const grandkid = await started('grandkid', kid);
    for (const id of [root, kid, grandkid]) process.kill(m.session(id)!.pid, 'SIGKILL');
    await expect.poll(() => [root, kid, grandkid].every((id) => m.view(id)!.status.exited)).toBe(true);
    expect((await m.prune([root, kid, grandkid])).removed).toHaveLength(3);
    expect((await history(home, { rootId: root })).map((a) => [a.id, a.rootId]).sort()).toEqual([[grandkid, root], [kid, root], [root, root]].sort());

    const root2 = await started('root2', null);
    const kid2 = await started('kid2', root2);
    await m.close(root2, true);
    await m.close(kid2); // its root is gone; it still belongs to root2's tree
    expect((await history(home, { rootId: root2 })).map((a) => a.id).sort()).toEqual([kid2, root2].sort());
  });

  it('restores a closed root under its own id, exited and dormant, with its session; refuses a live id, a child and a worktree root', async () => {
    setup();
    const root = await started('root', null, 'lead');
    const kid = await started('kid', root);
    const before = m.registry.get(root)!;
    await m.close(kid);
    await m.close(root, true);
    const meta = () => JSON.parse(readFileSync(join(home, 'sessions', root, 'meta.json'), 'utf8'));
    expect(meta().closedAt).toEqual(expect.any(Number));
    const v = await m.restore(root);
    expect(v).toMatchObject({ id: root, parentId: null, title: 'root', cwd: home, status: { exited: true } });
    expect(m.registry.get(root)).toMatchObject({ kind: 'claude', sessionId: before.sessionId, transcriptPath: before.transcriptPath, prompt: 'lead', createdAt: before.createdAt, dormant: true });
    expect(m.registry.get(root)!.role).toBeUndefined(); // a root's default stays derived
    expect(meta().closedAt).toBeUndefined();
    await expect(m.restore(root)).rejects.toThrow(`refused: ${root} is already a node`);
    await expect(m.restore(kid)).rejects.toThrow(`refused: ${kid} was not a root; use tl followup`);
    await expect(m.restore('n-none')).rejects.toThrow('no archived node n-none');
    mkdirSync(join(home, 'sessions', 'n-wt'), { recursive: true }); // a worktree root: its tree was removed at close
    writeFileSync(join(home, 'sessions', 'n-wt', 'archive.jsonl'), `${JSON.stringify({ id: 'n-wt', parentId: null, title: 'wt', cwd: home, sessionId: 's', transcriptPath: before.transcriptPath, branch: 'tl/wt', createdAt: 0, closedAt: 1 })}\n`);
    await expect(m.restore('n-wt')).rejects.toThrow('refused: n-wt ran in a worktree (tl/wt)');
    expect(await m.resume(root)).toEqual({ ok: true });
    expect(await argv(root)).toContain(`--resume ${before.sessionId}`);
    expect(m.registry.get(root)!.dormant).toBeUndefined();
  });

  it('refuses a second follow-up of the same session while the first is live', async () => {
    setup();
    const a = await started('worker', null);
    await m.close(a, true);
    const f = await m.followup(a, 'more');
    await expect(m.followup(a, 'again')).rejects.toThrow(`refused: ${f.id} already continues the session of ${a}; send it the prompt instead`);
  });

  it('an armed fork keeps its own session id until it launches, and is not archived if closed before', async () => {
    setup();
    const root = await started('root', null);
    const src = await started('source', root);
    const srcSid = m.registry.get(src)!.sessionId!;
    const f = await m.spawn({ kind: 'claude', title: 'fork', cwd: '', parentId: root, fork: src, after: [root], byHuman: true });
    expect(f.status.state).toBe('armed');
    expect(m.registry.get(f.id)).toMatchObject({ forkSession: srcSid, sessionId: expect.not.stringMatching(srcSid) });
    await m.close(f.id);
    expect((await history(home)).map((a) => a.id)).not.toContain(f.id);
  });

  it('follows up an archived node with claude --resume and the prompt, under its live parent; refuses an unknown id', async () => {
    setup();
    const root = await started('root', null);
    const a = await started('worker', root, 'first task');
    const sid = m.registry.get(a)!.sessionId!;
    await m.close(a);
    const f = await m.followup(a, 'second task');
    expect(f).toMatchObject({ parentId: root, title: 'worker', followupOf: a, sessionId: sid, prompt: 'second task' });
    expect(m.registry.get(f.id)!.transcriptPath).toBeUndefined(); // Claude's SessionStart hook reports it, as for any launch
    const args = await argv(f.id);
    expect(args).toMatch(new RegExp(`^--resume ${sid} --name worker`));
    expect(args.trimEnd().endsWith('-- second task')).toBe(true);
    await expect(m.followup('n-nope', 'x')).rejects.toThrow('no archived node n-nope');
  });

  it('a follow-up does not count the resumed session\'s earlier spend again', async () => {
    setup();
    const a = await started('worker', null, 'task');
    const measure = (id: string, usd: number) => m.applyModEvent(id, { event: 'session.measure', payload: { cost: { usd } } });
    measure(a, 0.5);
    measure(a, 0.8);
    await m.close(a, true);
    const f = await m.followup(a, 'more');
    measure(f.id, 1.0); // the resumed session's counter carries on from 0.8
    expect(m.view(f.id)!.spentUsd).toBeCloseTo(0.2);
  });

  it('forks a live or archived node with --fork-session under a new session id; refuses one that has not started', async () => {
    setup();
    const root = await started('root', null);
    const src = await started('source', root);
    const srcSid = m.registry.get(src)!.sessionId!;
    const f = await m.spawn({ kind: 'claude', title: 'fork', cwd: '', parentId: root, fork: src, prompt: 'try another way', byHuman: true });
    const args = await argv(f.id);
    const newSid = m.registry.get(f.id)!.sessionId!;
    expect(newSid).not.toBe(srcSid);
    expect(args.startsWith(`--resume ${srcSid} --fork-session --session-id ${newSid} `)).toBe(true);
    expect(args.trimEnd().endsWith('-- try another way')).toBe(true);
    expect(m.registry.get(f.id)).toMatchObject({ forkOf: src, cwd: home });
    expect(m.registry.get(f.id)!.forkSession).toBeUndefined(); // cleared at launch, so a restart starts fresh
    await m.close(src);
    const g = await m.spawn({ kind: 'claude', title: 'fork2', cwd: '', parentId: root, fork: src, byHuman: true }); // archived source
    expect(await argv(g.id)).toContain(`--resume ${srcSid} --fork-session`);
    const fresh = (await m.spawn({ kind: 'claude', title: 'fresh', cwd: home, parentId: root, byHuman: true })).id;
    await expect(m.spawn({ kind: 'claude', title: 'x', cwd: '', fork: fresh, byHuman: true })).rejects.toThrow(/has no session yet/);
    await expect(m.spawn({ kind: 'terminal', title: 'x', cwd: '', fork: src, byHuman: true })).rejects.toThrow(/agent nodes only/);
  });
});
