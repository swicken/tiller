import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { WebSocket } from 'ws';
import { shellStreamId, type ClientMessage, type NodeKind, type ServerMessage } from '../shared/protocol.js';
import { NodeManager } from './manager.js';
import { startServer, type DaemonServer } from './server.js';

let home: string;
let manager: NodeManager;
let server: DaemonServer;
let ws: WebSocket;
let seen: ServerMessage[];

beforeEach(async () => {
  home = realpathSync(mkdtempSync(join(tmpdir(), 'tl-shells-')));
  vi.stubEnv('HOME', home); // the login shell must not load the developer's own profile
  manager = new NodeManager({ home, shell: '/bin/sh' });
  server = await startServer(manager, { port: 0 });
  vi.spyOn(server.updates, 'start').mockImplementation(() => {});
  seen = [];
  ws = new WebSocket(`ws://127.0.0.1:${server.port}/ws`);
  ws.on('message', (raw) => seen.push(JSON.parse(raw.toString())));
  await new Promise((ok, fail) => { ws.once('open', ok); ws.once('error', fail); });
  send({ t: 'auth', token: readFileSync(join(home, 'admin-token'), 'utf8') });
  await until(() => seen.find((m) => m.t === 'snapshot'));
});

afterEach(async () => {
  ws.terminate();
  await manager.shutdown();
  await server.close();
  rmSync(home, { recursive: true, force: true });
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

const send = (m: ClientMessage) => ws.send(JSON.stringify(m));

async function until<T>(find: () => T | undefined, ms = 5000): Promise<T> {
  for (const end = Date.now() + ms; Date.now() < end; await new Promise((r) => setTimeout(r, 20))) {
    const v = find();
    if (v) return v;
  }
  throw new Error(`timed out; saw ${JSON.stringify(seen).slice(-500)}`);
}

/** A node record with a runtime, as the daemon holds an exited one: the shell must not need a live agent. */
function node(m: NodeManager, kind: NodeKind = 'claude', extra: { cwd?: string; worktree?: { repo: string; path: string; branch: string; base: string; baseSha: string } } = {}): string {
  const rec = m.registry.create({ parentId: null, kind, title: kind, cwd: extra.cwd ?? home, worktree: extra.worktree });
  m.runtimes.set(rec.id, { status: { state: 'done', exited: true, changedAt: Date.now() } });
  return rec.id;
}

const output = (stream: string) => seen.flatMap((m) => (m.t === 'data' && m.id === stream ? [m.data] : [])).join('');

it('spawns one shell in a worktree node\'s worktree on the first attach, reuses it on the next, and leaves the agent alone', async () => {
  const wt = join(home, 'wt');
  mkdirSync(wt);
  const id = node(manager, 'claude', { cwd: wt, worktree: { repo: home, path: wt, branch: 'tl/x', base: 'main', baseSha: 'abc' } });
  const stream = shellStreamId(id);
  send({ t: 'attach', id: stream, cols: 80, rows: 24 });
  await until(() => manager.shells.session(id));
  const pid = manager.shells.session(id)!.pid;
  send({ t: 'input', id: stream, data: 'pwd -P\r' });
  // The worker's tree, not the main checkout the Claude adapter launches from.
  await until(() => output(stream).includes(`\n${wt}`) || undefined);
  send({ t: 'detach', id: stream });
  send({ t: 'attach', id: stream, cols: 100, rows: 30 });
  await until(() => seen.filter((m) => m.t === 'data' && m.id === stream && m.data.includes('pwd')).length >= 2 || undefined);
  expect(manager.shells.session(id)!.pid).toBe(pid);
  expect(manager.session(id)).toBeUndefined(); // the agent's own PTY is untouched, and no MCP reader can find the shell through it
  await until(() => manager.view(id)?.shellReady);
  expect(manager.view(id)!.status).toMatchObject({ state: 'done', exited: true });
});

it('runs the shell as the human: no agent identity, so tl inside it cannot act as the node', async () => {
  // The daemon may itself have been started from inside a node; that identity must not leak in either.
  vi.stubEnv('TL_NODE_ID', 'n-daemonparent');
  vi.stubEnv('TL_TOKEN_FILE', '/somewhere/token');
  const id = node(manager);
  const stream = shellStreamId(id);
  send({ t: 'attach', id: stream, cols: 80, rows: 24 });
  send({ t: 'input', id: stream, data: 'echo "ID=[$TL_NODE_ID] TOK=[$TL_TOKEN_FILE] EP=[$TL_ENDPOINT] SD=[$TL_SESSION_DIR]"\r' });
  await until(() => output(stream).includes('ID=[] TOK=[] EP=[] SD=[]') || undefined);
});

it('refuses a shell for a terminal node or an unknown node, and spawns nothing', async () => {
  const term = node(manager, 'terminal');
  for (const id of [term, 'n-nope']) {
    send({ t: 'attach', id: shellStreamId(id), cols: 80, rows: 24 });
    await until(() => seen.find((m) => m.t === 'error' && m.id === shellStreamId(id)));
    expect(manager.shells.session(id)).toBeUndefined();
  }
});

it('kills the shell when its node closes', async () => {
  const id = node(manager);
  send({ t: 'attach', id: shellStreamId(id), cols: 80, rows: 24 });
  const s = await until(() => manager.shells.session(id));
  await manager.close(id, true);
  await until(() => s.exited || undefined);
  expect(manager.shells.session(id)).toBeUndefined();
});

it('forgets a shell that exits, tells the viewer, and spawns a fresh one on the next attach', async () => {
  const id = node(manager);
  const stream = shellStreamId(id);
  send({ t: 'attach', id: stream, cols: 80, rows: 24 });
  const first = await until(() => manager.shells.session(id));
  await until(() => manager.view(id)?.shellReady);
  send({ t: 'input', id: stream, data: 'exit\r' });
  await until(() => output(stream).includes('[shell exited; reopen the Terminal tab to start a new one]') || undefined);
  expect(manager.shells.session(id)).toBeUndefined();
  expect(manager.view(id)!.shellReady).toBeUndefined(); // Insert is disabled again
  send({ t: 'attach', id: stream, cols: 80, rows: 24 });
  const second = await until(() => manager.shells.session(id));
  expect(second).not.toBe(first);
});

it('keeps a suggestion made before the shell exists until the human acts on it, and dismisses it without typing', async () => {
  const id = node(manager);
  manager.suggest(id, 'git pull', 'fetch the new base');
  // Insert with no shell yet is refused, and the suggestion stays.
  const { at } = manager.view(id)!.suggestion!;
  send({ t: 'suggestion', id, action: 'insert', at });
  await until(() => seen.find((m) => m.t === 'error' && m.id === id && /not ready/.test(m.message)));
  expect(manager.view(id)!.suggestion).toMatchObject({ command: 'git pull', why: 'fetch the new base' });
  send({ t: 'attach', id: shellStreamId(id), cols: 80, rows: 24 });
  const s = await until(() => manager.shells.session(id));
  expect(manager.view(id)!.suggestion?.command).toBe('git pull');
  const write = vi.spyOn(s, 'write');
  send({ t: 'suggestion', id, action: 'dismiss', at });
  await until(() => seen.find((m) => m.t === 'node' && m.node.id === id && !m.node.suggestion));
  expect(manager.view(id)!.suggestion).toBeUndefined();
  expect(write).not.toHaveBeenCalled();
});

it('inserts only once the shell has printed something, then types exactly the command with no Enter', async () => {
  // A shell that prints nothing until it reads a line, standing in for a login shell still loading its rc files.
  const script = join(home, 'slow-shell');
  writeFileSync(script, '#!/bin/sh\nread x\necho ready\nsleep 30\n');
  chmodSync(script, 0o755);
  const m = new NodeManager({ home: join(home, 'other'), shell: script });
  try {
    const id = node(m);
    m.suggest(id, 'npm test -- --run');
    await m.shells.attach(id, 80, 24);
    const s = m.shells.session(id)!;
    const { at } = m.view(id)!.suggestion!;
    expect(() => m.answerSuggestion(id, 'insert', at)).toThrow(/not ready/); // typed-ahead text could be swallowed
    expect(m.view(id)!.suggestion?.command).toBe('npm test -- --run');
    m.shells.input(id, '\r');
    await until(() => m.view(id)?.shellReady);
    const write = vi.spyOn(s, 'write');
    m.answerSuggestion(id, 'insert', at);
    // No trailing newline: the human decides whether to run it.
    expect(write).toHaveBeenCalledExactlyOnceWith('npm test -- --run');
    expect(m.view(id)!.suggestion).toBeUndefined();
  } finally {
    await m.shutdown();
  }
});

it('refuses an insert or dismiss aimed at a suggestion the agent has since replaced, so the human never acts on one unseen', async () => {
  const id = node(manager);
  await manager.shells.attach(id, 80, 24);
  await until(() => manager.view(id)?.shellReady);
  const write = vi.spyOn(manager.shells.session(id)!, 'write');
  manager.suggest(id, 'git status');
  const seenAt = manager.view(id)!.suggestion!.at;
  manager.suggest(id, 'rm -rf build'); // in the same millisecond, usually: the revision must still differ
  const { at } = manager.view(id)!.suggestion!;
  expect(at).toBeGreaterThan(seenAt);
  expect(() => manager.answerSuggestion(id, 'insert', seenAt)).toThrow(/changed/);
  expect(() => manager.answerSuggestion(id, 'dismiss', seenAt)).toThrow(/changed/);
  expect(write).not.toHaveBeenCalled();
  expect(manager.view(id)!.suggestion?.command).toBe('rm -rf build'); // still waiting for the human to see it
  manager.answerSuggestion(id, 'insert', at);
  expect(write).toHaveBeenCalledExactlyOnceWith('rm -rf build');
  expect(manager.view(id)!.suggestion).toBeUndefined();
});
