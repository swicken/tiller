import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request } from 'node:http';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WebSocket } from 'ws';
import type { ClientMessage, NodeView, ServerMessage } from '../shared/protocol.js';
import { NodeManager } from './manager.js';
import { forUi, startServer, type DaemonServer } from './server.js';
import { deliver, inbox, messageStatus } from './messaging.js';

let home: string;
let manager: NodeManager;
let server: DaemonServer;
let ws: WebSocket | undefined;
let seen: ServerMessage[];

beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), 'tl-'));
  manager = new NodeManager({ home, shell: '/bin/sh' });
  server = await startServer(manager, { port: 0 });
  // Lifecycle tests must not poll the live GitHub API.
  vi.spyOn(server.updates, 'start').mockImplementation(() => {});
  vi.spyOn(server.updates, 'stop');
  seen = [];
});

afterEach(async () => {
  vi.useRealTimers();
  ws?.terminate();
  await manager.shutdown();
  await server.close();
  rmSync(home, { recursive: true, force: true });
  vi.restoreAllMocks();
});

const adminToken = () => readFileSync(join(home, 'admin-token'), 'utf8');

async function connect(token = adminToken(), client?: 'app' | 'browser'): Promise<void> {
  ws = new WebSocket(`ws://127.0.0.1:${server.port}/ws`);
  ws.on('message', (raw) => seen.push(JSON.parse(raw.toString())));
  await new Promise((ok, fail) => { ws!.once('open', ok); ws!.once('error', fail); });
  send({ t: 'auth', token, client });
}
const send = (m: ClientMessage) => ws!.send(JSON.stringify(m));

async function until<T>(find: () => T | undefined, ms = 5000): Promise<T> {
  for (const end = Date.now() + ms; Date.now() < end; await new Promise((r) => setTimeout(r, 20))) {
    const v = find();
    if (v) return v;
  }
  throw new Error(`timed out; saw ${JSON.stringify(seen).slice(0, 500)}`);
}

describe('websocket', () => {
  it('accepts an authenticated human harness request and validates the target before dispatch', async () => {
    const change = vi.spyOn(manager, 'changeHarness').mockResolvedValue({ ok: true });
    await connect(); await until(() => seen.find((m) => m.t === 'snapshot'));
    send({ t: 'changeHarness', id: 'root', harness: 'pi', prompt: 'go' });
    await until(() => change.mock.calls.length || undefined);
    expect(change).toHaveBeenCalledExactlyOnceWith('root', 'pi', 'go', true);
    ws!.send(JSON.stringify({ t: 'changeHarness', id: 'root', harness: 'invalid' }));
    await until(() => seen.find((m) => m.t === 'error' && m.message === 'Malformed message'));
    expect(change).toHaveBeenCalledTimes(1);
  });

  it('discovers all supported tools in the initial snapshot with no live nodes', async () => {
    await connect();
    const snapshot = await until(() => seen.find((m) => m.t === 'snapshot'));
    expect(snapshot?.t === 'snapshot' && snapshot.nodes).toEqual([]);
    expect(snapshot?.t === 'snapshot' && snapshot.usageSources?.map((s) => s.tool)).toEqual(['claude', 'codex', 'pi']);
    expect(snapshot?.t === 'snapshot' && snapshot.usageSources?.every((s) => s.authenticated === null && s.rateLimits.length === 0)).toBe(true);
  });

  it('forwards a human UI read acknowledgment with its exact identity', async () => {
    const acknowledge = vi.spyOn(server.updates, 'acknowledgeNotes');
    await connect();
    await until(() => seen.find((m) => m.t === 'snapshot'));
    send({ t: 'updateNotesRead', identity: 'reviewed-release-identity' });
    await until(() => acknowledge.mock.calls.length || undefined);
    expect(acknowledge).toHaveBeenCalledWith('reviewed-release-identity');
  });

  it('runs one updater lifecycle for authenticated app/browser clients only', async () => {
    await connect();
    await until(() => seen.find((m) => m.t === 'snapshot'));
    expect(server.updates.start).not.toHaveBeenCalled();
    const initialStops = vi.mocked(server.updates.stop).mock.calls.length;
    ws!.terminate();
    await until(() => vi.mocked(server.updates.stop).mock.calls.length > initialStops || undefined);
    await connect(adminToken(), 'app');
    await until(() => vi.mocked(server.updates.start).mock.calls.length || undefined);
    const app = ws!;
    await connect(adminToken(), 'browser');
    await until(() => vi.mocked(server.updates.start).mock.calls.length === 2 || undefined);
    const stopped = vi.mocked(server.updates.stop).mock.calls.length;
    app.terminate();
    await until(() => vi.mocked(server.updates.start).mock.calls.length === 3 || undefined);
    expect(server.updates.stop).toHaveBeenCalledTimes(stopped);
    ws!.terminate();
    await until(() => vi.mocked(server.updates.stop).mock.calls.length > stopped || undefined);
  });

  it('saves the session tab order in state.json, broadcasts it, and fills in roots it does not name', async () => {
    const mk = (title: string, parentId: string | null = null) => manager.registry.create({ parentId, kind: 'terminal', title, cwd: home });
    const a = mk('a'), b = mk('b'), c = mk('c'), child = mk('child', a.id);
    await connect();
    const snap = await until(() => seen.find((m) => m.t === 'snapshot'));
    expect(snap.t === 'snapshot' && snap.sessionOrder).toEqual([a.id, b.id, c.id]);
    // Children, unknown and repeated ids are dropped; roots left out follow, oldest first.
    send({ t: 'sessionOrder', ids: [c.id, 'n-gone', child.id, a.id, c.id] });
    const sent = await until(() => seen.find((m) => m.t === 'sessionOrder'));
    expect(sent).toEqual({ t: 'sessionOrder', ids: [c.id, a.id, b.id] });
    manager.registry.remove(a.id);
    manager.registry.flush();
    expect(JSON.parse(readFileSync(join(home, 'state.json'), 'utf8')).sessionOrder).toEqual([c.id]);
    const next = new NodeManager({ home, shell: '/bin/sh' });
    const d = next.registry.create({ parentId: null, kind: 'terminal', title: 'd', cwd: home });
    expect(next.sessionOrder()).toEqual([c.id, b.id, child.id, d.id]); // a's child outlives it as a tab of its own
    await next.shutdown();
  });

  it('keeps an orphaned child in the saved tab order once its root closes, as the UI gives it a tab', async () => {
    const mk = (title: string, parentId: string | null = null) => manager.registry.create({ parentId, kind: 'terminal', title, cwd: home });
    const a = mk('a'), b = mk('b'), orphan = mk('orphan', a.id);
    await manager.close(a.id, true); // a root's children are kept
    expect(manager.registry.get(orphan.id)?.parentId).toBe(a.id);
    await connect();
    const snap = await until(() => seen.find((m) => m.t === 'snapshot'));
    expect(snap.t === 'snapshot' && snap.sessionOrder).toEqual([b.id, orphan.id]);
    send({ t: 'sessionOrder', ids: [orphan.id, b.id] });
    expect(await until(() => seen.find((m) => m.t === 'sessionOrder'))).toEqual({ t: 'sessionOrder', ids: [orphan.id, b.id] });
    manager.registry.flush();
    expect(JSON.parse(readFileSync(join(home, 'state.json'), 'utf8')).sessionOrder).toEqual([orphan.id, b.id]);
    const next = new NodeManager({ home, shell: '/bin/sh' });
    expect(next.sessionOrder()).toEqual([orphan.id, b.id]);
    await next.shutdown();
  });

  it('rejects a bad token', async () => {
    await connect('wrong');
    const code = await new Promise((ok) => ws!.once('close', ok));
    expect(code).toBe(4401);
    expect(seen).toEqual([]);
  });

  it('preserves raw wheel bytes and Unicode text through websocket input to a real PTY', async () => {
    await connect();
    await until(() => seen.find((m) => m.t === 'snapshot'));
    const { id } = await manager.spawn({ kind: 'terminal', title: 'raw input', cwd: home });
    send({ t: 'attach', id, cols: 100, rows: 24 });
    const output = () => seen.flatMap((m) => m.t === 'data' && m.id === id ? [m.data] : []).join('');
    send({ t: 'input', id, data: "stty raw -echo; printf '\\nBYTE_READY\\n'; dd bs=1 count=19 2>/dev/null | od -An -tx1; printf 'BYTE_DONE\\n'\r" });
    await until(() => output().includes('\nBYTE_READY\n') || undefined, 30_000);
    // Legacy wheel up/down at column 100, row 3, followed by ordinary UTF-8 text.
    send({ t: 'input', id, data: '\x1b[M`\x84#\x1b[Ma\x84#', binary: true });
    send({ t: 'input', id, data: 'hé🌍' });
    // Read only between the markers: the prompt before them shows the hostname and cwd, which can contain any hex.
    const dumped = await until(() => /\nBYTE_READY\n([\s\S]*)\nBYTE_DONE\n/.exec(output())?.[1], 30_000)
      .catch(() => { throw new Error(`od output never completed; terminal showed ${JSON.stringify(output())}`); });
    expect(dumped.trim().replace(/\s+/g, ' ')).toBe('1b 5b 4d 60 84 23 1b 5b 4d 61 84 23 68 c3 a9 f0 9f 8c 8d');
  });

  it('validates binary byte strings without restricting ordinary Unicode input', async () => {
    const input = vi.spyOn(manager, 'input');
    await connect();
    await until(() => seen.find((m) => m.t === 'snapshot'));
    for (const message of [
      { t: 'input', id: 'missing', data: 'Ā', binary: true },
      { t: 'input', id: 'missing', data: '🌍', binary: true },
      { t: 'input', id: 'missing', data: 'bytes', binary: 'true' },
    ]) ws!.send(JSON.stringify(message));
    await until(() => seen.filter((m) => m.t === 'error' && m.message === 'Malformed message').length === 3 || undefined);
    expect(input).not.toHaveBeenCalled();
    send({ t: 'input', id: 'missing', data: '\x00\xff', binary: true });
    send({ t: 'input', id: 'missing', data: '🌍', binary: false });
    await until(() => input.mock.calls.length === 2 || undefined);
    expect(input).toHaveBeenNthCalledWith(1, 'missing', '\x00\xff', true);
    expect(input).toHaveBeenNthCalledWith(2, 'missing', '🌍', false);
  });

  it('runs a terminal node end to end', async () => {
    await connect();
    await until(() => seen.find((m) => m.t === 'snapshot'));
    send({ t: 'spawn', kind: 'terminal', title: 'sh', cwd: tmpdir() });
    const created = await until(() => seen.find((m) => m.t === 'node'));
    if (created.t !== 'node') throw new Error('unreachable');
    const id = created.node.id;
    expect(created.node.status.state).toBe('none');

    send({ t: 'attach', id, cols: 80, rows: 24 });
    send({ t: 'input', id, data: 'echo hi\r' });
    await until(() => seen.find((m) => m.t === 'data' && m.id === id && m.data.includes('hi')));

    send({ t: 'close', id }); // a root is an orchestrator: refused without force
    await until(() => seen.find((m) => m.t === 'error' && m.id === id && /orchestrator/.test(m.message)));
    expect(manager.list()).toHaveLength(1);
    send({ t: 'restart', id });
    await until(() => seen.find((m) => m.t === 'data' && m.id === id && m.data === '\x1bc'));
    expect(manager.list().map((n) => n.id)).toEqual([id]);
    send({ t: 'close', id, force: true });
    await until(() => seen.find((m) => m.t === 'removed' && m.id === id));
    expect(manager.list()).toEqual([]);
  });

  it.each([false, true])('stops forwarding output to a client that stops reading, then resyncs its screen once it drains (process exits: %s)', async (exits) => {
    await connect();
    await until(() => seen.find((m) => m.t === 'snapshot'));
    const { id } = await manager.spawn({ kind: 'terminal', title: 'flood', cwd: home });
    const stalled = new WebSocket(`ws://127.0.0.1:${server.port}/ws`);
    const got: ServerMessage[] = [];
    let bytes = 0;
    stalled.on('message', (raw: Buffer) => { bytes += raw.length; got.push(JSON.parse(raw.toString())); });
    await new Promise((ok) => stalled.once('open', ok));
    stalled.send(JSON.stringify({ t: 'auth', token: adminToken() }));
    stalled.send(JSON.stringify({ t: 'attach', id, cols: 80, rows: 24 }));
    await until(() => got.find((m) => m.t === 'snapshot'));
    await new Promise((r) => setTimeout(r, 200)); // let the attach land before the socket stops reading
    const socket = (stalled as unknown as { _socket: { pause(): void; resume(): void } })._socket;
    socket.pause();
    let output = '';
    const tail = (_: string, d: string) => { output = (output + d).slice(-100); };
    manager.on('data', tail);
    const flood = 32 * 1024 * 1024;
    // The sleep lets the screen parse the flood before the exit disposes it.
    manager.input(id, `head -c ${flood} /dev/zero | tr '\\0' x; echo; echo FLOOD_$((1+1))${exits ? '; sleep 1; exit' : ''}\r`);
    await until(() => output.includes('FLOOD_2') || undefined, 60_000);
    if (exits) await until(() => manager.view(id)?.status.exited || undefined, 15_000);
    manager.off('data', tail);
    socket.resume();
    const resync = await until(() => got.find((m) => m.t === 'data' && m.data.startsWith('\x1bc') && m.data.includes('FLOOD_2')), 15_000);
    expect(resync).toBeTruthy();
    expect(bytes).toBeLessThan(flood / 2);
    stalled.terminate();
  }, 90_000);

  it('replies to history and transcript for a closed Claude node, and with an error for an unknown one', async () => {
    const transcriptPath = join(home, 't.jsonl');
    writeFileSync(transcriptPath, `${JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'done' }] } })}\n`);
    const id = manager.registry.create({ parentId: null, kind: 'claude', title: 'old', cwd: home, lastActiveAt: Date.now(), prompt: 'build it', sessionId: 's1', transcriptPath }).id;
    manager.runtimes.set(id, {});
    mkdirSync(manager.sessionDirOf(id), { recursive: true }); // made at launch; this node never launched
    manager.closed(id);
    await connect();
    send({ t: 'history', query: 'BUILD' });
    const h = await until(() => seen.find((m) => m.t === 'history'));
    expect(h).toMatchObject({ items: [{ id, rootId: id, title: 'old', prompt: 'build it', brief: 'build it' }] });
    send({ t: 'transcript', id });
    expect(await until(() => seen.find((m) => m.t === 'transcript'))).toEqual({ t: 'transcript', id, entries: [{ role: 'assistant', text: 'done' }], sessions: [{ sessionId: 's1', current: true }] });
    send({ t: 'transcript', id: 'n-nope' });
    expect(await until(() => seen.find((m) => m.t === 'transcript' && m.id === 'n-nope'))).toEqual({ t: 'transcript', id: 'n-nope', error: 'no such node: n-nope' });
  });

  it('replies to conversations and conversation from the tree\'s event log, with a missing transcript read as none', async () => {
    const root = manager.registry.create({ parentId: null, kind: 'claude', title: 'lead', cwd: home, prompt: 'plan it' }).id;
    const child = manager.registry.create({ parentId: root, kind: 'claude', title: 'worker', cwd: home, prompt: 'build it', sessionId: 's1', transcriptPath: join(home, 'gone.jsonl') }).id;
    mkdirSync(manager.sessionDirOf(root), { recursive: true });
    manager.logEvent(root, 'send', { from: child, outcome: 'delivered', messageId: 'm-1', text: 'done, see branch' });
    await connect();
    send({ t: 'conversations', id: root });
    expect(await until(() => seen.find((m) => m.t === 'conversations'))).toMatchObject({ t: 'conversations', id: root, items: [
      { id: root, relation: 'parent', counterpart: 'human', messages: 0 },
      { id: child, relation: 'child', counterpart: child, title: 'worker', live: true, messages: 1 },
    ] });
    send({ t: 'conversation', id: child });
    expect(await until(() => seen.find((m) => m.t === 'conversation'))).toMatchObject({ t: 'conversation', id: child, a: root, b: child, relation: 'parent',
      titles: { [root]: 'lead', [child]: 'worker' },
      items: [{ kind: 'brief', from: root, text: 'build it' }, { kind: 'message', from: child, to: root, text: 'done, see branch', delivery: 'delivered' }] });
    send({ t: 'conversation', id: 'n-nope', with: child });
    expect(await until(() => seen.find((m) => m.t === 'conversation' && m.id === 'n-nope'))).toEqual({ t: 'conversation', id: 'n-nope', with: child, error: 'no such node: n-nope' });
  });
});

describe('POST /hook', () => {
  it.each(['/hook', '/mod-event', '/api/report_outcome'])('fences an old authenticated %s request whose body finishes after credential rotation', async (path) => {
    const rec = manager.registry.create({ kind: 'agent', harness: 'pi', title: 'old runtime', cwd: home, parentId: null, sessionId: 'public-session' });
    manager.runtimes.set(rec.id, { status: { state: 'working', changedAt: 1 } });
    const token = manager.tokenFor(rec.id);
    const verify = vi.spyOn(manager, 'verifyToken');
    const req = request(manager.endpoint + path, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'X-TL-Node': rec.id } });
    const response = new Promise<number>((resolve, reject) => {
      req.on('response', (res) => { res.resume(); res.on('end', () => resolve(res.statusCode!)); });
      req.on('error', reject);
    });
    req.write('{');
    await expect.poll(() => verify.mock.calls.length).toBeGreaterThan(0);
    manager.registry.update(rec.id, { credentialGeneration: 'fresh-launch' });
    const body = path === '/hook' ? { hook_event_name: 'SessionStart', session_id: 'old-native', transcript_path: '/stale' }
      : path === '/mod-event' ? { event: 'session.measure', payload: { cost: { usd: 999 }, model: 'stale' } }
        : { outcome: 'succeeded', summary: 'stale outcome' };
    req.end(JSON.stringify(body).slice(1));
    expect(await response).toBe(401);
    expect(manager.view(rec.id)).toMatchObject({ sessionId: 'public-session', status: { state: 'working', changedAt: 1 } });
    expect(manager.view(rec.id)?.outcome).toBeUndefined();
    expect(manager.view(rec.id)?.spentUsd).toBeUndefined();
  });

  const post = (nodeId: string, token: string, body: object) => fetch(`${manager.endpoint}/hook`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'X-TL-Node': nodeId, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  it('rejects a wrong token and drives status with a right one', async () => {
    await connect();
    await until(() => seen.find((m) => m.t === 'snapshot'));
    const node = (await manager.spawn({ kind: 'terminal', title: 'agent', cwd: tmpdir() }));
    const token = manager.tokenFor(node.id);
    expect((await post(node.id, 'bad', { hook_event_name: 'Stop' })).status).toBe(401);
    expect((await post('n-other', token, { hook_event_name: 'Stop' })).status).toBe(401);

    expect((await post(node.id, token, { hook_event_name: 'UserPromptSubmit', prompt: 'x' })).status).toBe(204);
    await until(() => seen.find((m) => m.t === 'node' && m.node.status.state === 'working'));
    expect((await post(node.id, token, { hook_event_name: 'Stop', last_assistant_message: 'all done' })).status).toBe(204);
    const notify = await until(() => seen.find((m) => m.t === 'notify'));
    expect(notify).toMatchObject({ t: 'notify', id: node.id, kind: 'done', title: 'agent', body: 'all done' });

    const states = seen.flatMap((m) => (m.t === 'node' && m.node.id === node.id ? [m.node.status.state] : []));
    expect(states).toContain('working');
    expect(states.at(-1)).toBe('done');
    expect(manager.view(node.id)?.unread).toBe(true);
  });

  it('serves the mod API: auth, inbox, mod-event measure and tree', async () => {
    const parent = (await manager.spawn({ kind: 'terminal', title: 'boss', cwd: tmpdir() }));
    const kid = (await manager.spawn({ kind: 'terminal', title: 'kid', cwd: tmpdir(), parentId: parent.id }));
    const call = (path: string, id: string, token: string, init: RequestInit = {}) =>
      fetch(`http://127.0.0.1:${server.port}${path}`, { ...init, headers: { Authorization: `Bearer ${token}`, 'X-TL-Node': id, 'Content-Type': 'application/json' } });
    const tp = manager.tokenFor(parent.id), tk = manager.tokenFor(kid.id);
    expect((await call('/inbox', parent.id, 'bad')).status).toBe(401);
    expect((await call('/tree', kid.id, tp)).status).toBe(401); // another node's token
    expect(await (await call('/inbox', kid.id, tk)).json()).toEqual([]);
    const measure = { event: 'session.measure', payload: { context: { tokens: 1, window: 2, percent: 50 }, cost: { usd: 0.25 } } };
    expect((await call('/mod-event', kid.id, tk, { method: 'POST', body: JSON.stringify(measure) })).status).toBe(204);
    expect((await call('/mod-event', kid.id, tk, { method: 'POST', body: '{"event":"nope"}' })).status).toBe(400);
    expect(manager.view(kid.id)?.status).toMatchObject({ contextPct: 50, costUsd: 0.25 });
    expect(manager.view(kid.id)?.status).toMatchObject({ contextTokens: 1, contextWindow: 2 });
    const done = { event: 'turn.complete', payload: { durationMs: 1, isAborted: false, turnId: 't', reason: 'answer', usage: { model: 'claude-sonnet-5-5' } } };
    expect((await call('/mod-event', kid.id, tk, { method: 'POST', body: JSON.stringify(done) })).status).toBe(204);
    expect(manager.view(kid.id)?.status).toMatchObject({ model: 'claude-sonnet-5-5', contextPct: 50 });
    expect(await (await call('/tree', parent.id, tp)).json()).toMatchObject([
      { id: parent.id, title: 'boss', depth: 0, self: true, parentId: null },
      { id: kid.id, title: 'kid', depth: 1, contextPct: 50 },
    ]);
  });

  it('/unconfirmed authenticates node identity and never acknowledges a retired native prompt', async () => {
    const root = manager.registry.create({ parentId: null, kind: 'agent', harness: 'pi', title: 'pi', cwd: home, lastActiveAt: Date.now() });
    const other = manager.registry.create({ parentId: root.id, kind: 'agent', harness: 'pi', title: 'other', cwd: home, lastActiveAt: Date.now() });
    manager.runtimes.set(root.id, { status: { state: 'done', changedAt: Date.now() } });
    manager.runtimes.set(other.id, { status: { state: 'done', changedAt: Date.now() } });
    const r = await deliver(manager, 'human', root.id, 'A');
    const call = (path: string, id = root.id, token = manager.tokenFor(id)) => fetch(`${manager.endpoint}${path}`, {
      method: 'POST', headers: { Authorization: `Bearer ${token}`, 'X-TL-Node': id, 'Content-Type': 'application/json' }, body: JSON.stringify({ id: r.messageId }),
    });
    expect((await call('/claim')).status).toBe(204);
    expect((await call('/unconfirmed', root.id, 'wrong')).status).toBe(401);
    expect((await call('/unconfirmed', root.id, manager.tokenFor(other.id))).status).toBe(401);
    expect((await call('/unconfirmed', other.id)).status).toBe(204); // scoped idempotent no-op
    expect(inbox(manager, root.id)).toHaveLength(1);
    expect((await call('/unconfirmed')).status).toBe(204);
    expect((await call('/unconfirmed')).status).toBe(204);
    expect((await call('/ack')).status).toBe(204); // late ack no-op
    expect(messageStatus(manager, 'human', r.messageId!)).toMatchObject({ outcome: 'stalled', retryable: false });
    expect(inbox(manager, root.id)).toEqual([]);
  });

  it('/release hands a never-submitted claim back to the queue, 404 once it is not claimed', async () => {
    const root = manager.registry.create({ parentId: null, kind: 'agent', harness: 'pi', title: 'pi', cwd: home, lastActiveAt: Date.now() });
    manager.runtimes.set(root.id, { status: { state: 'done', changedAt: Date.now() } });
    const r = await deliver(manager, 'human', root.id, 'A');
    const call = (path: string) => fetch(`${manager.endpoint}${path}`, {
      method: 'POST', headers: { Authorization: `Bearer ${manager.tokenFor(root.id)}`, 'X-TL-Node': root.id, 'Content-Type': 'application/json' }, body: JSON.stringify({ id: r.messageId }),
    });
    expect((await call('/claim')).status).toBe(204);
    expect((await call('/release')).status).toBe(204);
    expect((await call('/release')).status).toBe(404);
    expect(inbox(manager, root.id)).toEqual([expect.not.objectContaining({ claimed: true })]);
    expect(messageStatus(manager, 'human', r.messageId!)?.outcome).toBe('queued');
    expect((await call('/claim')).status).toBe(204); // claimable again
  });

  it('mod-event rateLimits: keeps the newest report from any node, broadcasts it, drops a malformed one', async () => {
    const a = (await manager.spawn({ kind: 'terminal', title: 'a', cwd: tmpdir() }));
    const b = (await manager.spawn({ kind: 'terminal', title: 'b', cwd: tmpdir() }));
    // Real shell processes keep this test inference-free; mark their reporting harness explicitly.
    manager.registry.update(a.id, { kind: 'claude' });
    manager.registry.update(b.id, { kind: 'claude' });
    const post = (id: string, payload: unknown) => fetch(`http://127.0.0.1:${server.port}/mod-event`, {
      method: 'POST', body: JSON.stringify({ event: 'session.measure', payload }),
      headers: { Authorization: `Bearer ${manager.tokenFor(id)}`, 'X-TL-Node': id, 'Content-Type': 'application/json' },
    });
    await connect();
    await until(() => seen.find((m) => m.t === 'snapshot'));
    let sourceChanges = 0; manager.on('usageSources', () => sourceChanges++);
    const first = [{ kind: 'five_hour', percentUsed: 10, resetsAt: '2026-10-13T14:30:00Z' }];
    const newer = [{ kind: 'five_hour', percentUsed: 12 }, { kind: 'seven_day', percentUsed: 3 }];
    expect((await post(a.id, { rateLimits: first })).status).toBe(204);
    expect((await post(b.id, { rateLimits: newer })).status).toBe(204);
    expect((await post(a.id, { rateLimits: [] })).status).toBe(204); // no reading: keeps b's
    await post(a.id, { context: { tokens: 5, window: 10, percent: 50 } });
    expect(sourceChanges).toBe(2); // context-only and empty measures do not broadcast quota snapshots
    expect(manager.usage).toMatchObject({ rateLimits: newer, nodeId: b.id });
    const sent = await until(() => { const u = seen.filter((m) => m.t === 'usage'); return u.length === 2 ? u : undefined; });
    expect(sent.map((m) => m.t === 'usage' && m.usage.nodeId)).toEqual([a.id, b.id]);

    // Malformed: rejected, but context and cost from the same report still land on the node.
    expect((await post(a.id, { rateLimits: [{ kind: 'five_hour', percentUsed: 'lots' }], context: { tokens: 5, window: 10, percent: 50 }, cost: { usd: 1 } })).status).toBe(204);
    expect((await post(a.id, { rateLimits: 'nope' })).status).toBe(204);
    expect(manager.usage).toMatchObject({ rateLimits: newer, nodeId: b.id });
    expect(manager.view(a.id)?.status).toMatchObject({ contextPct: 50, costUsd: 1 });
    expect((await post(a.id, { usageUnavailable: true })).status).toBe(204);
    expect(manager.usageRegistry.sources.find((s) => s.nodeIds.includes(a.id) && s.rateLimits.length > 0)).toMatchObject({ availability: 'unavailable', rateLimits: first });
    expect(manager.usage).toMatchObject({ rateLimits: newer, nodeId: b.id });

    ws!.terminate();
    seen = [];
    await connect();
    const snap = await until(() => seen.find((m) => m.t === 'snapshot'));
    expect(snap).toMatchObject({ usage: { rateLimits: newer, nodeId: b.id } });
    expect(snap?.t === 'snapshot' && snap.usageSources?.filter((s) => s.at).map((s) => [s.nodeIds, s.rateLimits])).toEqual([[[a.id], first], [[b.id], newer]]);
    send({ t: 'usageRefresh' });
    const refreshed = await until(() => seen.find((m) => m.t === 'usageSources'));
    expect(refreshed?.t === 'usageSources' && refreshed.sources.filter((s) => s.id.startsWith('discovery:'))).toHaveLength(3);
    expect((await post(a.id, { usageReports: [{ scope: 'model', rateLimits: first }] })).status).toBe(204);
    expect(manager.usageRegistry.sources.filter((s) => s.rateLimits.length)).toHaveLength(2);
  });

  it('GET /tree: the whole tree from the root, the caller marked self', async () => {
    const root = (await manager.spawn({ kind: 'terminal', title: 'boss', cwd: tmpdir() }));
    const a = (await manager.spawn({ kind: 'terminal', title: 'a', cwd: tmpdir(), parentId: root.id }));
    const a1 = (await manager.spawn({ kind: 'terminal', title: 'a1', cwd: tmpdir(), parentId: a.id }));
    const b = (await manager.spawn({ kind: 'terminal', title: 'b', cwd: tmpdir(), parentId: root.id }));
    (await manager.spawn({ kind: 'terminal', title: 'elsewhere', cwd: tmpdir() }));
    const res = await fetch(`http://127.0.0.1:${server.port}/tree`, { headers: { Authorization: `Bearer ${manager.tokenFor(a.id)}`, 'X-TL-Node': a.id } });
    const rows = await res.json() as Array<{ id: string; depth: number; self?: boolean }>;
    expect(rows.map((r) => [r.id, r.depth, !!r.self])).toEqual([[root.id, 0, false], [a.id, 1, true], [a1.id, 2, false], [b.id, 1, false]]);
  });

  it('X-TL-Clients lists the connected client kinds on /tree and /inbox', async () => {
    const n = (await manager.spawn({ kind: 'terminal', title: 'boss', cwd: tmpdir() }));
    const header = async (path: string) => (await fetch(`http://127.0.0.1:${server.port}${path}`, { headers: { Authorization: `Bearer ${manager.tokenFor(n.id)}`, 'X-TL-Node': n.id } })).headers.get('x-tl-clients');
    expect(await header('/tree')).toBe('');
    await connect(adminToken(), 'app');
    await until(() => seen.find((m) => m.t === 'snapshot'));
    expect(await header('/tree')).toBe('app');
    expect(await header('/inbox')).toBe('app');
  });

  it('POST /focus: auth, lineage scope, broadcast', async () => {
    const parent = (await manager.spawn({ kind: 'terminal', title: 'boss', cwd: tmpdir() }));
    const kid = (await manager.spawn({ kind: 'terminal', title: 'kid', cwd: tmpdir(), parentId: parent.id }));
    const other = (await manager.spawn({ kind: 'terminal', title: 'other', cwd: tmpdir() }));
    const focus = (caller: string, token: string, id: string) =>
      fetch(`http://127.0.0.1:${server.port}/focus`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'X-TL-Node': caller }, body: JSON.stringify({ id }) });
    const tp = manager.tokenFor(parent.id), tk = manager.tokenFor(kid.id);
    await connect();
    await until(() => seen.find((m) => m.t === 'snapshot'));
    expect((await focus(parent.id, 'bad', kid.id)).status).toBe(401);
    expect((await focus(parent.id, tp, other.id)).status).toBe(403);
    expect((await focus(kid.id, tk, other.id)).status).toBe(403);
    const cousin = (await manager.spawn({ kind: 'terminal', title: 'cousin', cwd: tmpdir(), parentId: (await manager.spawn({ kind: 'terminal', title: 'aunt', cwd: tmpdir(), parentId: parent.id })).id }));
    expect((await focus(kid.id, tk, cousin.id)).status).toBe(204); // anywhere in the same tree
    expect((await focus(parent.id, tp, kid.id)).status).toBe(204);
    expect((await focus(kid.id, tk, parent.id)).status).toBe(204); // a child may focus its parent
    await until(() => seen.filter((m) => m.t === 'focus').length === 3 || undefined);
    expect(seen.filter((m) => m.t === 'focus')).toEqual([{ t: 'focus', from: kid.id, id: cousin.id }, { t: 'focus', from: parent.id, id: kid.id }, { t: 'focus', from: kid.id, id: parent.id }]);
  });

  it('the CLI\'s human-only API tools: mute, dnd and sessions_clean', async () => {
    const n = await manager.spawn({ kind: 'terminal', title: 't', cwd: tmpdir() });
    const api = async (tool: string, args: object, caller = 'human', token = adminToken()) => {
      const res = await fetch(`http://127.0.0.1:${server.port}/api/${tool}`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'X-TL-Node': caller }, body: JSON.stringify(args) });
      return { status: res.status, body: await res.json() as { text?: string; error?: string } };
    };
    await connect();
    await until(() => seen.find((m) => m.t === 'snapshot'));
    expect((await api('mute', { nodeId: n.id, muted: true })).body.text).toBe(`muted ${n.id}`);
    expect(manager.view(n.id)!.muted).toBe(true);
    expect((await api('mute', { nodeId: 'n-nope', muted: true })).body.error).toBe('no such node: n-nope');
    expect((await api('mute', { nodeId: n.id, muted: false }, n.id, manager.tokenFor(n.id))).body.error).toBe('mute is only for the human');
    expect((await api('dnd', { on: true, minutes: 30 })).body.text).toMatch(/^do not disturb is on until /);
    await until(() => seen.find((m) => m.t === 'dnd' && m.on));
    expect(server.dnd()).toMatchObject({ on: true });
    expect((await api('dnd', {})).body.text).toMatch(/^do not disturb is on until /); // no `on`: only reports
    expect((await api('dnd', { on: false })).body.text).toBe('do not disturb is off');
    expect((await api('sessions_clean', {})).body.text).toBe('removed 0 expired session directories');
  });
});

describe('forUi', () => {
  it('drops the spawn prompts and session history and keeps everything else', () => {
    const node = {
      id: 'n', parentId: null, kind: 'claude', title: 't', cwd: '/', createdAt: 0, unread: false, status: { state: 'queued', changedAt: 0 },
      prompt: 'big brief', sessionHistory: [{ sessionId: 's', harness: 'claude', transcriptPath: '/t' }], previousSessions: ['s'],
      pending: { after: ['a'], afterSuccess: [], met: [], prompt: 'big brief', blocked: 'a failed' },
    } satisfies NodeView;
    expect(forUi(node)).toEqual({
      id: 'n', parentId: null, kind: 'claude', title: 't', cwd: '/', createdAt: 0, unread: false, status: { state: 'queued', changedAt: 0 },
      previousSessions: ['s'], pending: { after: ['a'], afterSuccess: [], met: [], blocked: 'a failed' },
    });
    expect(node.prompt).toBe('big brief'); // the daemon's own view is untouched
  });
});

describe('client tracking', () => {
  it('counts a watcher only while it has the node selected and its window focused; reports the app', async () => {
    await connect(adminToken(), 'app');
    await until(() => (server.appConnected() ? true : undefined));
    const id = (await manager.spawn({ kind: 'terminal', title: 'sh', cwd: tmpdir() })).id;
    const watching = (n: number) => until(() => (server.watchers(id) === n ? true : undefined));
    send({ t: 'select', id });
    send({ t: 'visibility', focused: false });
    await new Promise((r) => setTimeout(r, 100));
    expect(server.watchers(id)).toBe(0);
    send({ t: 'visibility', focused: true });
    await watching(1);
    send({ t: 'visibility', focused: false });
    await watching(0);
    ws!.terminate();
    await until(() => (server.appConnected() ? undefined : true));
  });
});


describe('approved native notification delivery', () => {
  const notification = { id: 'n-approved', title: 'Build', body: 'Finished', sound: false };
  const offer = () => until(() => seen.find((m) => m.t === 'nativeNotify')) as Promise<Extract<ServerMessage, { t: 'nativeNotify' }>>;
  const ready = async () => {
    await connect(adminToken(), 'app');
    await until(() => seen.find((m) => m.t === 'snapshot'));
    await new Promise<void>((ok) => {
      ws!.once('pong', () => ok());
      send({ t: 'nativeNotifyReady', ok: true });
      ws!.ping();
    });
  };

  it('uses fallback when no ready native app is connected', async () => {
    expect(await server.notifyNative(notification)).toBe(false);
    await connect(adminToken(), 'app');
    await until(() => seen.find((m) => m.t === 'snapshot'));
    expect(await server.notifyNative(notification)).toBe(false);
    send({ t: 'nativeNotifyReady', ok: false, error: 'plugin unavailable' });
  });

  it('dispatches to exactly one ready app and ignores receipts from another client', async () => {
    await ready();
    const other = new WebSocket(`ws://127.0.0.1:${server.port}/ws`);
    const otherSeen: ServerMessage[] = [];
    other.on('message', (raw) => otherSeen.push(JSON.parse(raw.toString())));
    await new Promise((ok) => other.once('open', ok));
    other.send(JSON.stringify({ t: 'auth', token: adminToken(), client: 'app' }));
    await until(() => otherSeen.find((m) => m.t === 'snapshot'));
    await new Promise<void>((ok) => {
      other.once('pong', () => ok());
      other.send(JSON.stringify({ t: 'nativeNotifyReady', ok: true }));
      other.ping();
    });
    const delivered = server.notifyNative(notification);
    const request = await offer();
    expect(request.notification).toEqual(notification);
    other.send(JSON.stringify({ t: 'nativeNotifyResult', requestId: request.requestId, ok: false }));
    send({ t: 'nativeNotifyResult', requestId: request.requestId, ok: true });
    expect(await delivered).toBe(true);
    expect(otherSeen.filter((m) => m.t === 'nativeNotify')).toEqual([]);
    other.terminate();
  });

  it('falls back on definitive plugin failure and surfaces the error', async () => {
    await ready();
    const delivered = server.notifyNative(notification);
    const request = await offer();
    send({ t: 'nativeNotifyResult', requestId: request.requestId, ok: false, error: 'permission denied' });
    expect(await delivered).toBe(false);
    expect(await until(() => seen.find((m) => m.t === 'error'))).toMatchObject({ message: 'Native notification: permission denied' });
  });

  it('does not retry or use fallback when a dispatched notification has no receipt', async () => {
    await ready();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const received = new Promise<Extract<ServerMessage, { t: 'nativeNotify' }>>((ok) => ws!.once('message', (raw) => ok(JSON.parse(raw.toString()))));
    const delivered = server.notifyNative(notification);
    const request = await received;
    await vi.advanceTimersByTimeAsync(10_001);
    expect(await delivered).toBe(true); // fallback could duplicate the OS notification
    vi.useRealTimers();
    send({ t: 'nativeNotifyResult', requestId: request.requestId, ok: false, error: 'late failure' });
    await new Promise((ok) => setTimeout(ok, 25));
    expect(seen.filter((m) => m.t === 'nativeNotify')).toHaveLength(1);
  });

  it('does not retry after the nominated app disconnects following dispatch', async () => {
    await ready();
    const delivered = server.notifyNative(notification);
    await offer();
    ws!.terminate();
    expect(await delivered).toBe(true);
  });
});
