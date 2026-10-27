import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocket, WebSocketServer } from 'ws';
import { z } from 'zod';
import { HARNESSES, MEMORY_ITEM_KINDS, type ClientMessage, type Dnd, type NativeNotification, type NodeView, type ServerMessage, type Usage } from '../shared/protocol.js';
import { loadConfig } from './config.js';
import { DEFAULT_PORT } from './home.js';
import type { NodeManager, NotifyEvent } from './manager.js';
import type { PtySession } from './pty.js';
import { history } from './archive.js';
import { conversation, conversations } from './conversation.js';
import { mountMcp } from './mcp.js';
import { claudeMemory, memoryAction, memoryGiven, memoryItem, memoryPage } from './memory-panel.js';
import { LIMITS } from './memory-schema.js';
import { modApi } from './modapi.js';
import { settingsApi } from './settings.js';
import { SPAWN_FIELDS } from './spawnfields.js';
import { accountViews } from './claude-accounts.js';
import type { HookEvent } from './status.js';
import { deliver, HUMAN } from './messaging.js';
import { spawnUpdate } from './up.js';
import { createUpdater, REPO, type Updater } from './update.js';
import { readBody } from './util.js';

const UI_DIR = fileURLToPath(new URL('../../ui/dist', import.meta.url));
const MAX_HOOK_BYTES = 8_000_000; // a PreToolUse payload for a large Write carries the whole file
const AUTH_TIMEOUT_MS = 5000;
const VERSION = (JSON.parse(readFileSync(fileURLToPath(new URL('../../package.json', import.meta.url)), 'utf8')) as { version: string }).version;
const CONFIRM_TIMEOUT_MS = 5 * 60_000;
/** A client this far behind stops getting a node's output until its buffer drains; it then gets a fresh screen. */
const MAX_BUFFERED_BYTES = 8 * 1024 * 1024;
/** Below this the client counts as drained; other nodes' output may keep it from ever reaching zero. */
const DRAINED_BYTES = 1024 * 1024;
const DRAIN_POLL_MS = 250;
const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.map': 'application/json',
};

const id = z.string().min(1);
const size = z.number().int().min(1).max(1000);
const rid = z.number().int().min(0);
const itemId = z.number().int().positive();
const memoryTarget = z.object({
  account: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$/).nullable().optional(),
  repo: z.string().min(1).max(1024).optional(), nodeId: id.optional(), dir: z.string().min(1).max(4096).optional(),
});
const pinText = z.string().min(1).max(LIMITS.tools.pinText);
const memoryActionShape = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('pin'), itemId }),
  z.object({ kind: z.literal('pinText'), text: pinText }),
  z.object({ kind: z.literal('unpin'), itemId }),
  z.object({ kind: z.literal('editPin'), itemId, text: pinText }),
  z.object({ kind: z.literal('forget'), itemId, reason: z.string().min(1).max(LIMITS.tools.reason) }),
  z.object({ kind: z.literal('restore'), itemId }),
]);
const clientMessage = z.discriminatedUnion('t', [
  z.object({ t: z.literal('auth'), token: z.string(), client: z.enum(['app', 'browser']).optional() }),
  z.object({ t: z.literal('nativeNotifyReady'), ok: z.boolean(), error: z.string().max(1000).optional() }),
  z.object({ t: z.literal('nativeNotifyResult'), requestId: id, ok: z.boolean(), error: z.string().max(1000).optional() }),
  z.object({ t: z.literal('usageRefresh') }),
  z.object({ t: z.literal('claudeAccounts') }),
  z.object({ t: z.literal('updateCheck') }),
  z.object({ t: z.literal('restartNow') }),
  z.object({ t: z.literal('updateNotesRead'), identity: z.string().min(1).max(128) }),
  z.object({ t: z.literal('update'), tag: z.string(), sha: z.string() }),
  z.object({ t: z.literal('visibility'), focused: z.boolean() }),
  z.object({ t: z.literal('attach'), id, cols: size, rows: size }),
  z.object({ t: z.literal('detach'), id }),
  z.object({ t: z.literal('input'), id, data: z.string(), binary: z.boolean().optional() })
    .refine((m) => !m.binary || /^[\x00-\xff]*$/.test(m.data)),
  z.object({ t: z.literal('resize'), id, cols: size, rows: size }),
  z.object({ t: z.literal('select'), id }),
  z.object({ t: z.literal('spawn'), ...SPAWN_FIELDS, parentId: z.string().nullable().optional() }),
  z.object({ t: z.literal('close'), id, force: z.boolean().optional(), worktree: z.enum(['keep', 'discard']).optional() }),
  z.object({ t: z.literal('merge'), id }),
  z.object({ t: z.literal('restart'), id, prompt: z.string().optional() }),
  z.object({ t: z.literal('changeHarness'), id, harness: z.enum(HARNESSES), prompt: z.string().optional() }),
  z.object({ t: z.literal('resume'), id }),
  z.object({ t: z.literal('prune') }),
  z.object({ t: z.literal('rename'), id, title: z.string() }),
  z.object({ t: z.literal('confirm'), confirmId: z.string(), ok: z.boolean() }),
  z.object({ t: z.literal('diff'), id }),
  z.object({ t: z.literal('transcript'), id, sessionId: id.optional() }),
  z.object({ t: z.literal('conversations'), id }),
  z.object({ t: z.literal('conversation'), id, with: id.optional() }),
  z.object({ t: z.literal('history'), rootId: id.optional(), query: z.string().optional() }),
  z.object({ t: z.literal('followup'), id, prompt: z.string().min(1), title: z.string().min(1).optional() }),
  z.object({ t: z.literal('send'), id, text: z.string().min(1), mode: z.enum(['queue', 'now']).optional() }),
  z.object({ t: z.literal('mute'), id, muted: z.boolean() }),
  z.object({ t: z.literal('dnd'), on: z.boolean(), minutes: z.number().positive().max(7 * 24 * 60).optional() }),
  z.object({
    t: z.literal('memory'), rid, target: memoryTarget, kind: z.enum([...MEMORY_ITEM_KINDS, 'pinned'] as const).optional(),
    query: z.string().max(LIMITS.tools.query).optional(), retracted: z.boolean().optional(), before: z.object({ updatedAt: z.number().int().min(0), id: itemId }).optional(),
  }),
  z.object({ t: z.literal('memoryItem'), rid, target: memoryTarget, itemId }),
  z.object({ t: z.literal('memoryAction'), rid, target: memoryTarget, action: memoryActionShape }),
  z.object({ t: z.literal('memoryGiven'), rid, nodeId: id }),
  z.object({ t: z.literal('claudeMemory'), rid, target: memoryTarget }),
]) satisfies z.ZodType<ClientMessage>;

export interface DaemonServer {
  port: number;
  /**
   * Ask the human to approve something. Resolves false if no UI is connected, on refusal or when `signal` aborts (the
   * dialog then closes), and undefined on timeout.
   */
  confirm(text: string, signal?: AbortSignal): Promise<boolean | undefined>;
  /** How many connected clients are looking at node `id`: it is selected there and their window is in front. */
  watchers(id: string): number;
  /** Whether the native app is connected. */
  appConnected(): boolean;
  /** Delivers an approved notification to one native app; false means safe to use daemon fallback. */
  notifyNative(notification: NativeNotification): Promise<boolean>;
  /** Do not disturb, as the human last set it; check dndActive for whether it has expired. */
  dnd(): Dnd;
  updates: Updater;
  close(): Promise<void>;
}

interface Client {
  ws: WebSocket; authed: boolean; attached: Set<string>; kind?: 'app' | 'browser'; focused: boolean; selected?: string; nativeReady?: boolean;
  /** Attached nodes whose output was cut off by backpressure, resynced once the buffer drains; with the final screen if the process exited meanwhile. */
  stalled: Map<string, string | undefined>; drainTimer?: NodeJS.Timeout;
}

/** A node as the UI gets it: without the spawn prompts and session history, which it never reads. */
export function forUi({ prompt: _prompt, sessionHistory: _history, ...node }: NodeView): NodeView {
  if (!node.pending?.prompt) return node;
  const { prompt: _pendingPrompt, ...pending } = node.pending;
  return { ...node, pending };
}

export async function startServer(manager: NodeManager, opts: { port?: number } = {}): Promise<DaemonServer> {
  const clients = new Set<Client>();
  const pendingNotifications = new Map<string, { client: Client; finish(ok: boolean, error?: string): void }>();
  const pendingConfirms = new Map<string, (ok: boolean | undefined) => void>();
  const focus = (from: string, id: string) => broadcast({ t: 'focus', from, id });
  const updates = createUpdater({ repo: REPO, home: manager.home, onChange: (update) => broadcast({ t: 'update', update }), spawnHelper: (expected, onExit, now) => spawnUpdate(manager.home, daemon.port, expected, onExit, now) });
  const { handler: mcp, publishAdminToken, authenticate, isAdmin } = mountMcp(manager, (text, signal) => daemon.confirm(text, signal), focus, (on, minutes) => setDnd(on, minutes), updates);
  const settings = settingsApi(manager, isAdmin);
  const mod = modApi(manager, authenticate, focus, () => [...new Set([...clients].filter((c) => c.authed && c.kind).map((c) => c.kind!))]);

  const sendTo = (c: Client, m: ServerMessage | string) => { if (c.ws.readyState === WebSocket.OPEN) c.ws.send(typeof m === 'string' ? m : JSON.stringify(m)); };
  const broadcast = (m: ServerMessage) => {
    const json = JSON.stringify(m);
    for (const c of clients) if (c.authed) sendTo(c, json);
  };
  /** Sessions whose exit keeps the final screen for stalled clients: a PTY's screen is disposed when it exits. */
  const exitWatched = new WeakSet<PtySession>();
  const stall = (c: Client, id: string) => {
    c.attached.delete(id);
    c.stalled.set(id, undefined);
    c.drainTimer ??= setInterval(() => { if (c.ws.bufferedAmount < DRAINED_BYTES) resync(c); }, DRAIN_POLL_MS);
    const s = manager.session(id);
    if (!s || exitWatched.has(s)) return;
    exitWatched.add(s);
    s.onExit(() => {
      const screen = s.snapshot();
      for (const other of clients) if (other.stalled.has(id)) other.stalled.set(id, screen);
    });
  };
  /** Like attach without the resize: reset the client's screen to a snapshot, then forward live output again. */
  const resync = (c: Client) => {
    clearInterval(c.drainTimer);
    c.drainTimer = undefined;
    for (const id of c.stalled.keys()) {
      const s = manager.session(id);
      void (s ? s.flush() : Promise.resolve()).then(() => {
        if (!c.stalled.has(id)) return; // detached or removed meanwhile
        const exitScreen = c.stalled.get(id);
        c.stalled.delete(id);
        sendTo(c, { t: 'data', id, data: '\x1bc' + (s && !s.exited ? s.snapshot() : exitScreen ?? '') });
        c.attached.add(id);
      });
    }
  };
  const syncUpdateChecks = () => {
    if ([...clients].some((c) => c.authed && c.kind)) updates.start();
    else updates.stop();
  };
  const appConnected = () => [...clients].some((c) => c.authed && c.kind === 'app');
  manager.isSelected = (id) => [...clients].some((c) => c.selected === id);
  const anyFocused = () => [...clients].some((c) => c.authed && c.focused);
  /** Since when no client has been focused; undefined while one is, or before any ever was. */
  let awaySince: number | undefined;
  let dnd: Dnd = { on: false };
  const noteAway = () => { awaySince = anyFocused() ? undefined : awaySince ?? Date.now(); };
  /** Turn do not disturb on (for `minutes` when given) or off and tell every client; with `on` undefined, only return it. */
  const setDnd = (on: boolean | undefined, minutes?: number): Dnd => {
    if (on === undefined) return dnd;
    dnd = on ? { on: true, ...(minutes ? { until: Date.now() + minutes * 60_000 } : {}) } : { on: false };
    console.log(`do not disturb ${on ? `on${dnd.until ? ` until ${new Date(dnd.until).toLocaleTimeString()}` : ''}` : 'off'}`);
    broadcast({ t: 'dnd', ...dnd });
    return dnd;
  };

  manager.on('node', (node: NodeView) => broadcast({ t: 'node', node: forUi(node) }));
  manager.on('removed', (rid: string) => {
    for (const c of clients) { c.attached.delete(rid); c.stalled.delete(rid); }
    broadcast({ t: 'removed', id: rid });
  });
  manager.on('data', (rid: string, data: string) => {
    let json: string | undefined;
    for (const c of clients) {
      if (!c.authed || !c.attached.has(rid)) continue;
      if (c.ws.bufferedAmount > MAX_BUFFERED_BYTES) stall(c, rid);
      else sendTo(c, json ??= JSON.stringify({ t: 'data', id: rid, data } satisfies ServerMessage));
    }
  });
  manager.on('notify', (n: NotifyEvent) => broadcast({ t: 'notify', ...n }));
  manager.on('usageSources', (sources) => broadcast({ t: 'usageSources', sources }));
  manager.on('usage', (usage: Usage) => broadcast({ t: 'usage', usage }));
  // While a restart drains, every node change may change who it waits for.
  let lastDrain = '';
  const syncDrain = () => {
    const drain = manager.drainView(), json = JSON.stringify(drain ?? null);
    if (json !== lastDrain) { lastDrain = json; broadcast({ t: 'drain', drain }); }
  };
  manager.on('drain', syncDrain);
  manager.on('node', () => { if (manager.draining) syncDrain(); });

  const failed = (err: Error) => ({ error: err.message });
  async function handle(c: Client, m: ClientMessage): Promise<void> {
    switch (m.t) {
      case 'auth': return;
      case 'nativeNotifyReady': {
        if (c.kind !== 'app') return;
        c.nativeReady = m.ok;
        if (m.error) console.error(`native notifications unavailable: ${m.error}`);
        return;
      }
      case 'nativeNotifyResult': {
        const pending = pendingNotifications.get(m.requestId);
        if (pending?.client === c) pending.finish(m.ok, m.error);
        return;
      }
      case 'updateCheck': await updates.check(); return;
      case 'updateNotesRead': await updates.acknowledgeNotes(m.identity); return;
      case 'update': await updates.apply(m); return;
      case 'restartNow': manager.forceDrain(); return;
      case 'usageRefresh':
        await manager.usageRegistry.refresh();
        sendTo(c, { t: 'usageSources', sources: manager.usageRegistry.sources });
        return;
      case 'claudeAccounts': sendTo(c, { t: 'claudeAccounts', accounts: await accountViews(manager.home, manager.path) }); return;
      case 'attach': {
        // Snapshot first, then subscribe, so live output is not also part of the snapshot. attach() resolves
        // and we add the client in the same tick, so no chunk can fall between the two.
        const text = await manager.attach(m.id, m.cols, m.rows);
        if (text) sendTo(c, { t: 'data', id: m.id, data: text });
        c.stalled.delete(m.id);
        c.attached.add(m.id);
        return;
      }
      case 'detach': c.attached.delete(m.id); c.stalled.delete(m.id); return;
      case 'input': manager.input(m.id, m.data, m.binary); return;
      case 'resize': manager.resize(m.id, m.cols, m.rows); return;
      case 'visibility': {
        const wasAway = !anyFocused();
        const regained = m.focused && !c.focused;
        c.focused = m.focused;
        if (regained && wasAway && awaySince !== undefined) {
          const since = awaySince;
          if (Date.now() - since > loadConfig(null, manager.home).daemon.digestAfterMinutes * 60_000) {
            const items = await manager.digest(since);
            if (items.length) sendTo(c, { t: 'digest', since, items });
          }
        }
        noteAway();
        return;
      }
      case 'select': c.selected = m.id; manager.select(m.id); return;
      case 'spawn': {
        const { t: _, ...req } = m;
        await manager.spawn({ ...req, byHuman: true });
        return;
      }
      case 'close': await manager.close(m.id, m.force, m.worktree); return;
      case 'merge': await manager.merge(m.id); return;
      case 'restart': {
        const r = manager.restart(m.id, m.prompt);
        if (!r.ok) sendTo(c, { t: 'error', message: r.error, id: m.id });
        return;
      }
      case 'changeHarness': {
        const r = await manager.changeHarness(m.id, m.harness, m.prompt, true);
        if (!r.ok) sendTo(c, { t: 'error', message: r.error, id: m.id });
        return;
      }
      case 'resume': {
        const r = await manager.resume(m.id);
        if (!r.ok) sendTo(c, { t: 'error', message: r.error, id: m.id });
        return;
      }
      case 'prune': await manager.prune(); return;
      case 'rename': manager.rename(m.id, m.title); return;
      case 'confirm': pendingConfirms.get(m.confirmId)?.(m.ok); return;
      case 'transcript': {
        const r = await manager.transcript(m.id, m.sessionId).catch(failed);
        sendTo(c, { t: 'transcript', id: m.id, ...(m.sessionId ? { sessionId: m.sessionId } : {}), ...r });
        return;
      }
      case 'conversations': {
        const r = await conversations(manager, m.id).then((items) => ({ items }), failed);
        sendTo(c, { t: 'conversations', id: m.id, ...r });
        return;
      }
      case 'conversation': {
        const r = await conversation(manager, m.id, m.with).catch(failed);
        sendTo(c, { t: 'conversation', id: m.id, ...(m.with ? { with: m.with } : {}), ...r });
        return;
      }
      case 'history': sendTo(c, { t: 'history', items: await history(manager.home, { rootId: m.rootId, query: m.query }) }); return;
      case 'followup': await manager.followup(m.id, m.prompt, m.title); return;
      case 'diff': sendTo(c, { t: 'diff', id: m.id, ...(await manager.diff(m.id).catch(failed)) }); return;
      case 'send': sendTo(c, { t: 'sent', id: m.id, result: await deliver(manager, HUMAN, m.id, m.text, { mode: m.mode }) }); return;
      case 'mute':
        if (!manager.mute(m.id, m.muted)) sendTo(c, { t: 'error', message: `no such node: ${m.id}`, id: m.id });
        return;
      case 'dnd': setDnd(m.on, m.minutes); return;
      // The Memory panel: replies to this client only, echoing its rid.
      case 'memory': sendTo(c, { t: 'memory', rid: m.rid, ...(await memoryPage(manager, m).catch(failed)) }); return;
      case 'memoryItem': sendTo(c, { t: 'memoryItem', rid: m.rid, ...(await memoryItem(manager, m.target, m.itemId).catch(failed)) }); return;
      case 'memoryAction': sendTo(c, { t: 'memoryAction', rid: m.rid, ...(await memoryAction(manager, m.target, m.action).then((item) => ({ item }), failed)) }); return;
      case 'memoryGiven': sendTo(c, { t: 'memoryGiven', rid: m.rid, ...(await memoryGiven(manager, m.nodeId).then((injections) => ({ injections }), failed)) }); return;
      case 'claudeMemory': sendTo(c, { t: 'claudeMemory', rid: m.rid, ...(await claudeMemory(manager, m.target).catch(failed)) }); return;
    }
  }

  const wss = new WebSocketServer({ noServer: true });
  wss.on('connection', (ws) => {
    const c: Client = { ws, authed: false, attached: new Set(), focused: false, stalled: new Map() };
    clients.add(c);
    const authTimer = setTimeout(() => { if (!c.authed) ws.close(4401, 'auth timeout'); }, AUTH_TIMEOUT_MS);
    ws.on('close', () => {
      clearTimeout(authTimer);
      clearInterval(c.drainTimer);
      clients.delete(c);
      syncUpdateChecks();
      for (const pending of pendingNotifications.values()) if (pending.client === c) pending.finish(true, 'app disconnected after dispatch; delivery uncertain, not resent');
      if (c.focused) noteAway();
    });
    ws.on('message', (raw) => {
      let msg: ClientMessage;
      try {
        msg = clientMessage.parse(JSON.parse(raw.toString()));
      } catch {
        if (!c.authed) ws.close(4401, 'auth required');
        else sendTo(c, { t: 'error', message: 'Malformed message' });
        return;
      }
      if (!c.authed) {
        if (msg.t === 'auth' && isAdmin(msg.token)) {
          c.authed = true;
          c.kind = msg.client;
          syncUpdateChecks();
          clearTimeout(authTimer);
          sendTo(c, { t: 'snapshot', update: updates.status(), nodes: manager.list().map(forUi), usage: manager.usage, usageSources: manager.usageRegistry.sources, dnd, drain: manager.drainView() });
        } else {
          ws.close(4401, 'auth required');
        }
        return;
      }
      handle(c, msg).catch((err: Error) => sendTo(c, { t: 'error', message: err.message, id: 'id' in msg ? msg.id : undefined }));
    });
  });

  const server = http.createServer((req, res) => {
    route(req, res).catch(() => { if (!res.headersSent) res.writeHead(500); res.end(); });
  });
  server.on('upgrade', (req, socket, head) => {
    if (new URL(req.url ?? '/', 'http://x').pathname === '/ws') wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
    else socket.destroy();
  });

  async function route(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://x');
    if (req.method === 'GET' && url.pathname === '/health') {
      return void res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ ok: true, pid: process.pid, home: manager.home, version: VERSION, sha: updates.status().runtimeSha }));
    }
    if (req.method === 'POST' && url.pathname === '/hook') return hook(req, res);
    if (url.pathname === '/api/settings') return settings(req, res, url);
    if (await mod(req, res, url.pathname)) return;
    if (url.pathname === '/mcp' || url.pathname.startsWith('/api/')) return mcp(req, res);
    if (req.method === 'GET' && (url.pathname === '/' || url.pathname.startsWith('/assets/'))) {
      return serveUi(url.pathname === '/' ? 'index.html' : url.pathname.slice(1), res);
    }
    res.writeHead(404).end();
  }

  async function hook(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const nodeId = authenticate(req);
    if (!nodeId || nodeId === HUMAN) { res.writeHead(401).end(); return; }
    const body = await readBody(req, res, MAX_HOOK_BYTES);
    if (body === undefined) return;
    if (authenticate(req) !== nodeId) { res.writeHead(401).end(); return; }
    let event: HookEvent;
    try {
      event = JSON.parse(body);
      if (typeof event?.hook_event_name !== 'string') throw new Error('no event name');
    } catch {
      res.writeHead(400).end();
      return;
    }
    manager.applyHook(nodeId, event);
    res.writeHead(204).end();
  }

  async function serveUi(rel: string, res: http.ServerResponse): Promise<void> {
    const file = resolve(UI_DIR, rel);
    if (!file.startsWith(UI_DIR + sep)) { res.writeHead(404).end(); return; }
    try {
      const body = await readFile(file);
      res.writeHead(200, { 'Content-Type': MIME[extname(file)] ?? 'application/octet-stream' }).end(body);
    } catch {
      if (rel === 'index.html') res.writeHead(200, { 'Content-Type': 'text/plain' }).end('UI not built');
      else res.writeHead(404).end();
    }
  }

  await new Promise<void>((ok, fail) => { server.once('error', fail); server.listen(opts.port ?? DEFAULT_PORT, '127.0.0.1', ok); });
  const port = (server.address() as AddressInfo).port;
  manager.endpoint = `http://127.0.0.1:${port}`;
  publishAdminToken();

  const daemon: DaemonServer = {
    port,
    confirm(text, signal) {
      if (signal?.aborted || ![...clients].some((c) => c.authed)) return Promise.resolve(false);
      const confirmId = randomUUID();
      return new Promise<boolean | undefined>((resolveConfirm) => {
        const timer = setTimeout(() => finish(undefined), CONFIRM_TIMEOUT_MS);
        const abort = () => finish(false);
        const finish = (ok: boolean | undefined) => {
          clearTimeout(timer);
          signal?.removeEventListener('abort', abort);
          pendingConfirms.delete(confirmId);
          broadcast({ t: 'confirmDone', confirmId });
          resolveConfirm(ok);
        };
        signal?.addEventListener('abort', abort, { once: true });
        pendingConfirms.set(confirmId, finish);
        broadcast({ t: 'confirm', confirmId, text });
      });
    },
    watchers: (id) => [...clients].filter((c) => c.authed && c.focused && c.selected === id).length,
    appConnected,
    notifyNative(notification) {
      const client = [...clients].find((c) => c.authed && c.kind === 'app' && c.nativeReady && c.ws.readyState === WebSocket.OPEN);
      if (!client) return Promise.resolve(false);
      const requestId = randomUUID();
      return new Promise<boolean>((resolveNotification) => {
        const timer = setTimeout(() => finish(true, 'delivery receipt timed out; delivery uncertain, not resent'), 10_000);
        const finish = (ok: boolean, error?: string) => {
          clearTimeout(timer);
          pendingNotifications.delete(requestId);
          if (error) {
            console.error(`native notification ${notification.id}: ${error}`);
            sendTo(client, { t: 'error', id: notification.id, message: `Native notification: ${error}` });
          }
          resolveNotification(ok);
        };
        // A lost receipt after dispatch is ambiguous: falling back could duplicate an OS notification.
        pendingNotifications.set(requestId, { client, finish });
        sendTo(client, { t: 'nativeNotify', requestId, notification });
      });
    },
    dnd: () => dnd,
    updates,
    async close() {
      updates.stop();
      for (const c of clients) c.ws.terminate();
      clients.clear();
      wss.close();
      server.closeAllConnections();
      await new Promise<void>((ok) => server.close(() => ok()));
    },
  };
  return daemon;
}
