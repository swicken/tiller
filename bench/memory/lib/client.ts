// A bench daemon's WebSocket client (bench plan §1, pattern from spike/e2e-orch.ts): admin auth, the live node map and
// spawn and close as the human sends them, so a WS spawn is byHuman.
import { WebSocket } from 'ws';
import type { ClientMessage, NodeView, ServerMessage } from '../../../src/shared/protocol.js';
import type { Daemon } from './daemon.js';

export type SpawnMessage = Omit<Extract<ClientMessage, { t: 'spawn' }>, 't'>;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class Client {
  readonly nodes = new Map<string, NodeView>();
  /** Every error message the daemon sent, in order. */
  readonly errors: string[] = [];

  private constructor(private readonly ws: WebSocket) {
    ws.on('message', (raw) => {
      const m = JSON.parse(raw.toString()) as ServerMessage;
      if (m.t === 'snapshot') for (const n of m.nodes) this.nodes.set(n.id, n);
      else if (m.t === 'node') this.nodes.set(m.node.id, m.node);
      else if (m.t === 'removed') this.nodes.delete(m.id);
      else if (m.t === 'error') this.errors.push(m.message);
    });
  }

  /** Connect and authenticate as the human; resolves once the snapshot arrived. */
  static async connect(d: Daemon, timeoutMs = 10_000): Promise<Client> {
    const ws = new WebSocket(`ws://127.0.0.1:${d.port}/ws`);
    let snapshot = false;
    ws.on('message', (raw) => { if ((JSON.parse(raw.toString()) as ServerMessage).t === 'snapshot') snapshot = true; });
    await new Promise<void>((ok, fail) => { ws.once('open', ok); ws.once('error', fail); });
    const c = new Client(ws);
    c.send({ t: 'auth', token: d.token });
    if (!(await c.waitFor(() => snapshot, timeoutMs))) throw new Error('no snapshot from the bench daemon (auth refused?)');
    return c;
  }

  send(m: ClientMessage): void {
    this.ws.send(JSON.stringify(m));
  }

  /** Poll probe until it returns a truthy value or ms pass (then undefined). */
  async waitFor<T>(probe: () => T | undefined | null | false, ms: number): Promise<T | undefined> {
    for (const end = Date.now() + ms; ; await sleep(250)) {
      const v = probe();
      if (v) return v;
      if (Date.now() > end) return undefined;
    }
  }

  /** Spawn a node with a title no other node has, and return it once listed. Throws on a daemon error or timeout. */
  async spawn(req: SpawnMessage, timeoutMs = 30_000): Promise<NodeView> {
    const errors = this.errors.length;
    this.send({ t: 'spawn', ...req });
    const r = await this.waitFor(() => this.errors[errors] ?? [...this.nodes.values()].find((n) => n.title === req.title), timeoutMs);
    if (typeof r === 'string') throw new Error(`spawn ${req.title} refused: ${r}`);
    if (!r) throw new Error(`spawn ${req.title}: no node after ${timeoutMs} ms`);
    return r;
  }

  /**
   * Wait for node `id`'s recorded outcome, then for its turn to end so its transcript is flushed. Ends early when the
   * node vanished or exited, sat `blocked` (a permission or trust prompt) for 30 s, so it cannot run unattended, or, with
   * idleMs, sat done that long without an outcome.
   */
  async awaitOutcome(id: string, timeoutMs: number, idleMs = Infinity): Promise<{ end: 'reported' | 'vanished' | 'exited' | 'blocked' | 'idle' | 'timeout'; detail?: string }> {
    let blockedSince = 0, idleSince = 0;
    type End = Awaited<ReturnType<Client['awaitOutcome']>>;
    const end = await this.waitFor((): End | undefined => {
      const n = this.nodes.get(id);
      if (!n) return { end: 'vanished' };
      if (n.outcome) return { end: 'reported' };
      if (n.status.exited) return { end: 'exited', detail: n.status.lastAssistantMessage?.slice(0, 200) ?? 'no message' };
      const since = (state: string, at: number) => (n.status.state !== state ? 0 : at || Date.now());
      blockedSince = since('blocked', blockedSince);
      idleSince = n.gate === 'running' ? 0 : since('done', idleSince);
      if (blockedSince && Date.now() - blockedSince > 30_000) return { end: 'blocked', detail: n.status.activity ?? 'blocked' };
      if (idleSince && Date.now() - idleSince > idleMs) return { end: 'idle', detail: n.status.lastAssistantMessage?.slice(0, 200) ?? 'no message' };
      return undefined;
    }, timeoutMs);
    if (!end) return { end: 'timeout', detail: `no report in ${timeoutMs / 60_000} min` };
    if (end.end === 'reported') await this.waitFor(() => this.nodes.get(id)?.status.state === 'done', 60_000);
    return end;
  }

  close(): void {
    this.ws.close();
  }
}
