import { appendFileSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomBytes } from 'node:crypto';
import { codexHeader, type CodexHeader } from '../../src/shared/codex-transcript.js';
import { TillerClient, type InboxMessage } from '../shared/client.js';
import { RpcError, type Packet } from './rpc.js';
import { CodexUsage, readCodexUsage } from './usage.js';

export interface BridgeOptions {
  transcriptPath: string;
  sessionId: string;
  resume: boolean;
  instructions: string;
  prompt?: string;
  model?: string;
  effort?: string;
}
/** How long lifecycle reports retry an unreachable daemon, e.g. across `tl reload`. */
const DAEMON_GAP_MS = 60_000;

export interface Rpc {
  request(method: string, params: Record<string, unknown>): Promise<any>;
  send(packet: Packet): void;
  close?(): void;
}

/** App-server notifications own turn boundaries; turn/start's response proves prompt acceptance. */
export class CodexBridge {
  private readonly accountUsage = new CodexUsage();
  private threadId = '';
  initialization: unknown;
  startResult: unknown;
  hasHistory = false;
  freshThread = false;
  get nativeThreadId(): string { return this.threadId; }
  private turnId?: string;
  private busy = false;
  private pollTask?: Promise<void>;
  private submitting = false;
  private interrupted?: string;
  private answer = '';
  private model?: string;
  private queue = Promise.resolve();
  private receipts = new Set<string>();
  private ambiguous = new Set<string>();
  private timer?: NodeJS.Timeout;
  private stopped = false;
  private stopTask?: Promise<void>;
  private expired = false;
  private unreachableSince?: number;
  private readonly shutdown = new AbortController();

  constructor(private o: BridgeOptions, private rpc: Rpc, private client: TillerClient,
    private print: (text: string) => void, private fatal: (error: Error) => void) {}

  async start(endpoint: string, nodeId: string): Promise<void> {
    this.initialization = await this.rpc.request('initialize', { clientInfo: { name: 'tiller', title: 'Tiller', version: '0.0.0' }, capabilities: { experimentalApi: true } });
    this.rpc.send({ method: 'initialized' });
    const name = `tiller_${randomBytes(6).toString('hex')}`;
    const params: Record<string, unknown> = {
      cwd: process.cwd(), developerInstructions: this.o.instructions + `

# Tiller coordination
When the user asks for workers or subagents in this Tiller session, use the ${name} MCP server's spawn tool with kind \"agent\" and harness \"codex\". These are the independent sessions visible in Tiller. Codex's built-in spawn_agent tool creates internal agents that do not appear in Tiller; do not use it for Tiller workers. Use Tiller send/read/report_outcome to coordinate them. The built-in reviewer/researcher presets contain Claude-specific restrictions; for Codex workers use a self-contained read-only review/research prompt instead of those presets.`,
      ...(this.o.model ? { model: this.o.model } : {}),
      config: { [`mcp_servers.${name}`]: {
        url: `${endpoint.replace(/\/+$/, '')}/mcp`, required: true,
        http_headers: { 'X-TL-Node': nodeId }, env_http_headers: { Authorization: 'TL_CODEX_AUTHORIZATION' },
      } },
    };
    let history = '', method = 'thread/start';
    if (this.o.resume) {
      history = readFileSync(this.o.transcriptPath, 'utf8');
      const header = codexHeader(history);
      params.threadId = header.threadId;
      method = header.fork ? 'thread/fork' : 'thread/resume';
    }
    const initialParams: Record<string, unknown> = { ...params, config: {
      ...(params.config as Record<string, unknown>),
      ...(this.o.effort ? { model_reasoning_effort: this.o.effort } : {}),
    } };
    this.freshThread = method === 'thread/start';
    let result;
    try { result = await this.rpc.request(method, this.freshThread ? initialParams : params); } catch (error) {
      // Codex does not persist a rollout until the first turn. An untouched session can be
      // recreated, but never silently replace a missing conversation that has recorded messages.
      const tail = history.slice(history.indexOf('\n') + 1).trim();
      if (!this.o.resume || tail || !(error instanceof RpcError) || !error.message.includes('no rollout found for thread id')) throw error;
      this.freshThread = true;
      const { threadId: _old, ...fresh } = initialParams;
      result = await this.rpc.request('thread/start', fresh);
    }
    if (typeof result?.thread?.id !== 'string' || !result.thread.id) throw new Error('Codex returned no thread id');
    this.threadId = result.thread.id;
    this.startResult = result;
    this.hasHistory = !!history.slice(history.indexOf('\n') + 1).trim();
    this.model = result.model ?? this.o.model;
    mkdirSync(dirname(this.o.transcriptPath), { recursive: true, mode: 0o700 });
    // Persist native identity before accepting any prompt. Never touch the source archive.
    const tmp = `${this.o.transcriptPath}.tmp`;
    writeFileSync(tmp, JSON.stringify({ type: 'codex_session', threadId: this.threadId } satisfies CodexHeader) + '\n' +
      (history ? history.slice(history.indexOf('\n') + 1) : ''), { mode: 0o600 });
    renameSync(tmp, this.o.transcriptPath);
    await this.client.hook({ hook_event_name: 'SessionStart', session_id: this.o.sessionId,
      transcript_path: this.o.transcriptPath, model: this.model });
  }

  startPolling(): void {
    if (this.timer || this.stopped) return;
    this.timer = setInterval(() => { void this.poll().catch((e) => this.print(`Tiller inbox: ${e.message}\n`)); }, 1000);
    void readCodexUsage(this.accountUsage, () => this.rpc.request('account/rateLimits/read', {}))
      .then((measure) => this.stopped ? undefined : this.untilDeadline(() => this.client.modEvent('session.measure', measure)))
      .catch(() => {}); // Optional usage telemetry must never stop the agent.
  }

  handle(packet: Packet): void {
    if (this.stopTask) return;
    this.queue = this.queue.then(() => this.event(packet)).catch((error) => { this.fatal(error); });
  }

  private append(role: 'user' | 'assistant', content: unknown): void {
    appendFileSync(this.o.transcriptPath, JSON.stringify({ type: role, timestamp: new Date().toISOString(), message: { content } }) + '\n', { mode: 0o600 });
  }

  private async untilDeadline<T>(send: () => Promise<T>): Promise<T | undefined> {
    if (this.expired) return;
    let cancel!: () => void;
    const cutoff = new Promise<undefined>((resolve) => {
      cancel = () => resolve(undefined);
      this.shutdown.signal.addEventListener('abort', cancel, { once: true });
    });
    try { return await Promise.race([send(), cutoff]); }
    finally { this.shutdown.signal.removeEventListener('abort', cancel); }
  }

  /**
   * Send a lifecycle report, retrying each second while the daemon is unreachable. One outage
   * stalls the event queue for at most DAEMON_GAP_MS; after that reports are dropped (logged)
   * until one succeeds, as hook.sh drops failed hooks.
   */
  private async report(send: () => Promise<void>): Promise<void> {
    for (;;) {
      try { await this.untilDeadline(send); this.unreachableSince = undefined; return; } catch (error) {
        this.unreachableSince ??= Date.now();
        if (this.expired || Date.now() - this.unreachableSince >= DAEMON_GAP_MS) {
          this.print(`Tiller report dropped: ${(error as Error).message}\n`);
          return;
        }
      }
      await this.untilDeadline(() => new Promise<void>((resolve) => setTimeout(resolve, 1000)));
    }
  }

  private async event(p: Packet): Promise<void> {
    const v = p.params ?? {};
    // Account quota updates apply independently of the managed thread.
    if (p.method === 'account/rateLimits/updated' && p.id === undefined) {
      await this.untilDeadline(() => this.client.modEvent('session.measure', this.accountUsage.measure(v))).catch(() => {});
      return;
    }
    if (v.threadId && v.threadId !== this.threadId) return;
    if (p.id !== undefined && p.method) {
      // The real Codex TUI handles every approval/input request. Only mirror its waiting state.
      if (p.method.endsWith('/requestApproval') || p.method.endsWith('/requestUserInput') || p.method === 'mcpServer/elicitation/request') {
        await this.report(() => this.client.hook({ hook_event_name: 'Notification', notification_type:
          p.method?.includes('Approval') ? 'permission_prompt' : 'elicitation_dialog', message: v.reason ?? p.method }));
      }
    } else if (p.method === 'serverRequest/resolved') {
      if (this.busy) await this.report(() => this.client.hook({ hook_event_name: 'PostToolUse' }));
    } else if (p.method === 'thread/settings/updated' && typeof v.threadSettings?.model === 'string') {
      this.model = v.threadSettings.model;
      await this.report(() => this.client.modEvent('session.measure', { model: this.model }));
    } else if (p.method === 'turn/started') {
      this.busy = true;
      this.turnId = v.turn?.id;
      this.answer = '';
      this.interrupted = undefined;
      await this.report(() => this.client.modEvent('turn.start', { turnId: this.turnId }));

    } else if (p.method === 'item/started' || p.method === 'item/completed') {
      const item = v.item;
      if (!item || typeof item.type !== 'string') return;
      if (item.type === 'contextCompaction' && p.method === 'item/completed') { // the daemon reads this like Claude's SessionStart after /compact
        await this.report(() => this.client.hook({ hook_event_name: 'SessionStart', source: 'compact', session_id: this.o.sessionId,
          transcript_path: this.o.transcriptPath, model: this.model }));
      }
      if (item.type === 'userMessage' && p.method === 'item/completed' && Array.isArray(item.content)) {
        this.append('user', item.content.filter((c: any) => c?.type === 'text' && typeof c.text === 'string'));
      }
      if (item.type === 'agentMessage' && p.method === 'item/completed' && typeof item.text === 'string') {
        this.answer = item.text;
        this.append('assistant', item.text);
      }
      const tool = item.type === 'commandExecution' ? 'Bash' : item.type === 'fileChange' ? 'Edit'
        : item.type === 'mcpToolCall' ? `mcp__${item.server}__${item.tool}` : undefined;
      if (tool) {
        if (p.method === 'item/completed') this.append('assistant', [{ type: 'tool_use', name: tool }]);
        await this.report(() => this.client.hook({ hook_event_name: p.method === 'item/started' ? 'PreToolUse' : 'PostToolUse',
          tool_name: tool, tool_input: { command: item.command, file_path: item.changes?.[0]?.path } }));
      }
    } else if (p.method === 'thread/tokenUsage/updated') {
      const tokens = v.tokenUsage?.last?.totalTokens, window = v.tokenUsage?.modelContextWindow;
      if (Number.isFinite(tokens) && Number.isFinite(window) && window > 0) {
        await this.report(() => this.client.modEvent('session.measure', { context: { tokens, window, percent: tokens / window * 100 }, model: this.model }));
      }
    } else if (p.method === 'turn/completed') {
      const turn = v.turn;
      if (!turn || typeof turn.id !== 'string') throw new Error('invalid Codex turn completion');
      this.busy = false;
      this.turnId = undefined;
      await this.report(() => this.client.modEvent('turn.complete', { turnId: turn.id, answer: this.answer,
        isAborted: turn.status === 'interrupted', reason: turn.status === 'failed' ? 'error' : 'answer', usage: { model: this.model } }));
    }
  }

  private async submit(text: string, message?: InboxMessage): Promise<void> {
    if (this.busy || this.submitting) throw new Error('Codex is busy; wait for completion or use /interrupt');
    this.busy = true;
    this.submitting = true;
    try {
      const result = await this.rpc.request('turn/start', { threadId: this.threadId,
        input: [{ type: 'text', text, text_elements: [] }] });
      if (this.expired) { if (message) this.ambiguous.add(message.id); return; }
      if (typeof result?.turn?.id !== 'string') throw new Error('Codex turn acceptance is unknown');
      if (this.busy) this.turnId = result.turn.id;
      if (message) this.receipts.add(message.id);
    } catch (error) {
      if (error instanceof RpcError) {
        this.busy = false;
        if (message && !this.expired) await this.client.release(message.id);
      } else {
        // A lost response may still have started the turn. Never replay this submission.
        if (message) this.ambiguous.add(message.id);
        this.fatal(error as Error);
      }
      throw error;
    } finally { this.submitting = false; }
  }

  async interrupt(): Promise<void> {
    if (!this.turnId || this.interrupted === this.turnId) return;
    const id = this.turnId;
    await this.rpc.request('turn/interrupt', { threadId: this.threadId, turnId: id });
    this.interrupted = id;
  }

  private async settleReceipts(): Promise<void> {
    if (this.expired) return;
    const settle = async (ids: Set<string>, send: (id: string) => Promise<void>) => {
      return Promise.allSettled([...ids].map(async (id) => { await send(id); ids.delete(id); }));
    };
    const results = await this.untilDeadline(() => Promise.all([settle(this.receipts, (id) => this.client.ack(id)),
        settle(this.ambiguous, (id) => this.client.unconfirmed(id))]));
    const failed = results?.flat().find((result) => result.status === 'rejected');
    if (failed?.status === 'rejected') throw failed.reason;
  }

  poll(): Promise<void> {
    if (this.pollTask || this.stopped) return Promise.resolve();
    this.pollTask = this.pollInbox().finally(() => { this.pollTask = undefined; });
    return this.pollTask;
  }

  private async pollInbox(): Promise<void> {
    await this.settleReceipts();
    if (this.stopped) return;
    const inbox = await this.client.inbox();
    if (this.stopped) return;
    // Claims inherited from a crashed adapter have an unknown outcome; never submit them again.
    for (const msg of inbox.filter((m) => m.claimed)) await this.client.unconfirmed(msg.id);
    const next = inbox.find((m) => !m.claimed && m.steer) ?? inbox.find((m) => !m.claimed);
    if (!next || this.stopped) return;
    if (this.busy || this.submitting) { if (next.steer) await this.interrupt(); return; }
    if (!await this.client.claim(next.id) || this.expired) return;
    if (this.stopped || this.busy || this.submitting) { await this.client.release(next.id); return; }
    await this.submit(next.text, next);
    if (!this.expired && this.receipts.has(next.id)) { await this.client.ack(next.id); this.receipts.delete(next.id); }
  }

  beginShutdown(): void {
    this.stopped = true;
    clearInterval(this.timer);
  }

  stop(): Promise<void> {
    if (this.stopTask) return this.stopTask;
    this.beginShutdown();
    const deadline = setTimeout(() => {
      this.expired = true;
      this.shutdown.abort();
      this.client.dispose();
      this.rpc.close?.();
      this.print('Codex shutdown deadline reached; some lifecycle reports or receipts may be unsent. Unresolved claims will not be replayed.\n');
    }, 5000);
    this.stopTask = this.drain().finally(() => { clearTimeout(deadline); });
    return this.stopTask;
  }

  private async drain(): Promise<void> {
    await this.untilDeadline(() => this.pollTask?.catch(() => {}) ?? Promise.resolve());
    // Deadline cancellation unblocks daemon notifications but still lets every accepted
    // event append its local transcript. It never turns an unknown claim into an ack.
    await this.queue;
    try { await this.settleReceipts(); }
    catch (error) { this.print(`Tiller receipts: ${(error as Error).message}\n`); }
    await this.untilDeadline(() => this.client.hook({ hook_event_name: 'SessionEnd' }));
  }
}
