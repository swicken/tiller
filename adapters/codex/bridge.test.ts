import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TillerClient, type InboxMessage } from '../shared/client.js';
import { CodexBridge } from './bridge.js';
import { RpcError } from './rpc.js';

let dir: string, bridge: CodexBridge;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'tl-codex-bridge-')); });
afterEach(async () => { vi.useRealTimers(); await bridge?.stop(); rmSync(dir, { recursive: true, force: true }); });

async function setup(messages: InboxMessage[], resumeHistory?: string, effort?: string, resumeMethod?: 'thread/resume' | 'thread/fork') {
  const client = new TillerClient({ endpoint: 'http://unused', nodeId: 'n-1', token: 'node-token' });
  vi.spyOn(client, 'hook').mockResolvedValue();
  vi.spyOn(client, 'modEvent').mockResolvedValue();
  vi.spyOn(client, 'inbox').mockResolvedValue(messages);
  vi.spyOn(client, 'claim').mockResolvedValue(true);
  vi.spyOn(client, 'ack').mockResolvedValue();
  vi.spyOn(client, 'release').mockResolvedValue(true);
  vi.spyOn(client, 'unconfirmed').mockResolvedValue();
  const rpc = { send: vi.fn(), request: vi.fn(async (method: string, _params: Record<string, unknown>) => {
    if (method === 'thread/resume' && !resumeMethod) throw new RpcError('no rollout found for thread id old');
    return method.startsWith('thread/') ? { thread: { id: 'native' }, model: 'test' } : { turn: { id: 'turn' } };
  }) };
  const fatal = vi.fn();
  if (resumeHistory !== undefined) writeFileSync(join(dir, 'session.jsonl'), JSON.stringify({ type: 'codex_session', threadId: 'old', ...(resumeMethod === 'thread/fork' ? { fork: true } : {}) }) + '\n' + resumeHistory);
  bridge = new CodexBridge({ transcriptPath: join(dir, 'session.jsonl'), sessionId: 'tiller-id', resume: resumeHistory !== undefined, instructions: 'role', effort }, rpc, client, vi.fn(), fatal);
  await bridge.start('http://unused', 'n-1');
  return { client, rpc, fatal };
}

describe('Codex delivery failures', () => {
  it('uses a recognizable, per-launch Tiller MCP namespace with a 48-bit random suffix', async () => {
    const { rpc } = await setup([]);
    const params = vi.mocked(rpc.request).mock.calls.find(([method]) => method === 'thread/start')![1];
    const config = params.config as Record<string, unknown>;
    const names = Object.keys(config).map((key) => key.match(/^mcp_servers\.(.+)$/)?.[1]).filter(Boolean);
    expect(names).toHaveLength(1);
    expect(names[0]).toMatch(/^tiller_[a-f0-9]{12}$/);
    expect(names[0]!.length).toBeLessThanOrEqual(24);
  });

  it('reads account quotas once on attachment without starting a turn', async () => {
    const { client, rpc } = await setup([]);
    rpc.request.mockResolvedValueOnce({ accountId: 'account', rateLimits: { limitId: 'codex', primary: { usedPercent: 25, windowDurationMins: 300 } } } as any);
    bridge.startPolling();
    bridge.startPolling();
    await expect.poll(() => vi.mocked(client.modEvent).mock.calls).toContainEqual(['session.measure', {
      usageReports: [expect.objectContaining({ accountId: 'account', rateLimits: [expect.objectContaining({ percentUsed: 25, kind: '5h' })] })],
    }]);
    expect(rpc.request.mock.calls.filter(([method]) => method === 'account/rateLimits/read')).toHaveLength(1);
    expect(rpc.request.mock.calls.some(([method]) => method === 'turn/start')).toBe(false);
  });

  it('handles account updates before thread filtering and tolerates telemetry transport failures', async () => {
    const { client, fatal } = await setup([]);
    vi.mocked(client.modEvent).mockRejectedValueOnce(new Error('usage transport unavailable'));
    const update = { method: 'account/rateLimits/updated', params: { threadId: 'another-thread', rateLimits: { primary: { usedPercent: 30 } } } };
    bridge.handle(update);
    bridge.handle(update);
    await expect.poll(() => vi.mocked(client.modEvent).mock.calls.length).toBe(2);
    expect(client.modEvent).toHaveBeenLastCalledWith('session.measure', { usageReports: [expect.objectContaining({ rateLimits: [expect.objectContaining({ percentUsed: 30 })] })] });
    expect(fatal).not.toHaveBeenCalled();
  });

  it('reports unsupported account reads as unavailable without failing startup', async () => {
    const { client, rpc, fatal } = await setup([]);
    rpc.request.mockRejectedValueOnce(new RpcError('unsupported'));
    bridge.startPolling();
    await expect.poll(() => vi.mocked(client.modEvent).mock.calls).toContainEqual(['session.measure', { usageUnavailable: true }]);
    expect(fatal).not.toHaveBeenCalled();
  });

  it('reports native model picker changes to Tiller', async () => {
    const { client } = await setup([]);
    bridge.handle({ method: 'thread/settings/updated', params: { threadId: 'native', threadSettings: { model: 'selected-model' } } });
    await expect.poll(() => vi.mocked(client.modEvent).mock.calls).toEqual([['session.measure', { model: 'selected-model' }]]);
  });

  it('recreates an untouched session when Codex has not persisted a rollout', async () => {
    const { rpc } = await setup([], '');
    expect(rpc.request.mock.calls.map(([m]) => m)).toEqual(['initialize', 'thread/resume', 'thread/start']);
  });

  it('refuses to replace missing native history when a conversation was recorded', async () => {
    await expect(setup([], JSON.stringify({ type: 'user', message: { content: 'hello' } }) + '\n'))
      .rejects.toThrow('no rollout found');
  });

  it('retries a failed receipt without submitting the accepted prompt twice', async () => {
    const { client, rpc } = await setup([{ id: 'message', text: 'hello' }]);
    vi.mocked(client.ack).mockRejectedValueOnce(new Error('daemon unavailable'));
    await expect(bridge.poll()).rejects.toThrow('daemon unavailable');
    vi.mocked(client.inbox).mockResolvedValue([]);
    await bridge.poll();
    expect(client.ack).toHaveBeenCalledTimes(2);
    expect(rpc.request.mock.calls.filter(([m]) => m === 'turn/start')).toHaveLength(1);
    expect(client.unconfirmed).not.toHaveBeenCalled();
  });

  it('never replays an inherited claim after a bridge restart', async () => {
    const { client, rpc } = await setup([{ id: 'old', text: 'possibly ran', claimed: true }]);
    await bridge.poll();
    expect(client.unconfirmed).toHaveBeenCalledWith('old');
    expect(client.claim).not.toHaveBeenCalled();
    expect(rpc.request.mock.calls.some(([m]) => m === 'turn/start')).toBe(false);
  });

  it('never submits a withdrawn message', async () => {
    const { client, rpc } = await setup([{ id: 'gone', text: 'hello' }]);
    vi.mocked(client.claim).mockResolvedValue(false);
    await bridge.poll();
    expect(rpc.request.mock.calls.some(([m]) => m === 'turn/start')).toBe(false);
  });

  it('releases an explicitly rejected prompt but retires an ambiguous transport failure', async () => {
    const { client, rpc, fatal } = await setup([{ id: 'message', text: 'hello' }]);
    rpc.request.mockRejectedValueOnce(new RpcError('busy'));
    await expect(bridge.poll()).rejects.toThrow('busy');
    expect(client.release).toHaveBeenCalledWith('message');
    expect(client.ack).not.toHaveBeenCalled();
    rpc.request.mockRejectedValueOnce(new Error('connection lost'));
    await expect(bridge.poll()).rejects.toThrow('connection lost');
    expect(fatal).toHaveBeenCalled();
    expect(client.release).toHaveBeenCalledTimes(1);
    vi.mocked(client.inbox).mockResolvedValue([]);
    await bridge.poll();
    expect(client.unconfirmed).toHaveBeenCalledWith('message');
    expect(rpc.request.mock.calls.filter(([m]) => m === 'turn/start')).toHaveLength(2);
    expect(client.ack).not.toHaveBeenCalled();
  });
});

describe('Codex daemon gap', () => {
  it('retries lifecycle reports while the daemon restarts instead of failing the session', async () => {
    const { client, fatal } = await setup([]);
    vi.useFakeTimers();
    const down = new Error('fetch failed');
    vi.mocked(client.modEvent).mockRejectedValueOnce(down).mockRejectedValueOnce(down);
    vi.mocked(client.hook).mockRejectedValueOnce(down);
    bridge.handle({ method: 'turn/started', params: { turn: { id: 'turn' } } });
    bridge.handle({ method: 'item/started', params: { item: { type: 'commandExecution', command: 'ls' } } });
    bridge.handle({ method: 'turn/completed', params: { turn: { id: 'turn', status: 'completed' } } });
    await vi.advanceTimersByTimeAsync(5000);
    expect(fatal).not.toHaveBeenCalled();
    expect(vi.mocked(client.modEvent).mock.calls.map(([event]) => event)).toEqual(['turn.start', 'turn.start', 'turn.start', 'turn.complete']);
    expect(client.hook).toHaveBeenLastCalledWith(expect.objectContaining({ hook_event_name: 'PreToolUse' }));
  });

  it('drops a report after about a minute without blocking later events', async () => {
    const { client, fatal } = await setup([]);
    const print = (bridge as unknown as { print: ReturnType<typeof vi.fn> }).print;
    vi.useFakeTimers();
    vi.mocked(client.modEvent).mockRejectedValue(new Error('fetch failed'));
    bridge.handle({ method: 'turn/started', params: { turn: { id: 'turn' } } });
    bridge.handle({ method: 'item/completed', params: { item: { type: 'agentMessage', text: 'kept answer' } } });
    await vi.advanceTimersByTimeAsync(59_000);
    expect(readFileSync(join(dir, 'session.jsonl'), 'utf8')).not.toContain('kept answer');
    await vi.advanceTimersByTimeAsync(2000);
    expect(readFileSync(join(dir, 'session.jsonl'), 'utf8')).toContain('kept answer');
    expect(print).toHaveBeenCalledWith(expect.stringContaining('dropped'));
    // Still unreachable: later reports are tried once and dropped rather than stalling again.
    const calls = vi.mocked(client.modEvent).mock.calls.length;
    bridge.handle({ method: 'turn/completed', params: { turn: { id: 'turn', status: 'completed' } } });
    await vi.advanceTimersByTimeAsync(0);
    expect(client.modEvent).toHaveBeenCalledTimes(calls + 1);
    vi.mocked(client.modEvent).mockResolvedValue();
    bridge.handle({ method: 'turn/started', params: { turn: { id: 'next' } } });
    await vi.advanceTimersByTimeAsync(0);
    expect(client.modEvent).toHaveBeenLastCalledWith('turn.start', { turnId: 'next' });
    expect(fatal).not.toHaveBeenCalled();
  });
});

describe('Codex compaction', () => {
  it('reports a completed contextCompaction item as SessionStart with source compact', async () => {
    const { client } = await setup([]);
    bridge.handle({ method: 'item/started', params: { item: { type: 'contextCompaction' } } });
    bridge.handle({ method: 'item/completed', params: { item: { type: 'contextCompaction' } } });
    await bridge.stop();
    const compacts = vi.mocked(client.hook).mock.calls.filter(([e]) => e.hook_event_name === 'SessionStart' && e.source === 'compact');
    expect(compacts).toHaveLength(1);
  });
});

describe('Codex shutdown', () => {
  it('drains accepted user, tool, answer and lifecycle events and rejects later events/polls', async () => {
    const { client, fatal } = await setup([]);
    const item = (value: object) => bridge.handle({ method: 'item/completed', params: { item: value } });
    bridge.handle({ method: 'turn/started', params: { turn: { id: 'last' } } });
    item({ type: 'userMessage', content: [{ type: 'text', text: 'question' }] });
    item({ type: 'commandExecution', command: 'echo answer' });
    item({ type: 'agentMessage', text: 'final answer' });
    bridge.handle({ method: 'turn/completed', params: { turn: { id: 'last', status: 'completed' } } });
    const stopped = bridge.stop();
    item({ type: 'agentMessage', text: 'too late' });
    await bridge.poll();
    await stopped;
    const transcript = readFileSync(join(dir, 'session.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    expect(transcript.slice(1).map((entry) => entry.message.content)).toEqual([
      [{ type: 'text', text: 'question' }], [{ type: 'tool_use', name: 'Bash' }], 'final answer',
    ]);
    expect(client.modEvent).toHaveBeenLastCalledWith('turn.complete', expect.objectContaining({ answer: 'final answer' }));
    expect(client.hook).toHaveBeenCalledWith(expect.objectContaining({ hook_event_name: 'PostToolUse' }));
    expect(client.hook).toHaveBeenLastCalledWith({ hook_event_name: 'SessionEnd' });
    expect(client.inbox).not.toHaveBeenCalled();
    expect(fatal).not.toHaveBeenCalled();
    await bridge.stop();
    expect(vi.mocked(client.hook).mock.calls.filter(([event]) => event.hook_event_name === 'SessionEnd')).toHaveLength(1);
  });

  it('does not claim an inbox response arriving after stop', async () => {
    const { client } = await setup([]);
    let resolve!: (messages: InboxMessage[]) => void;
    vi.mocked(client.inbox).mockImplementation(() => new Promise((done) => { resolve = done; }));
    const poll = bridge.poll();
    await expect.poll(() => client.inbox).toHaveBeenCalled();
    const stopped = bridge.stop();
    resolve([{ id: 'late', text: 'hello' }]);
    await Promise.all([poll, stopped]);
    expect(client.claim).not.toHaveBeenCalled();
  });

  it('releases a claim acquired while shutdown is starting', async () => {
    const { client, rpc } = await setup([{ id: 'pending', text: 'hello' }]);
    let resolve!: (claimed: boolean) => void;
    vi.mocked(client.claim).mockImplementation(() => new Promise((done) => { resolve = done; }));
    const poll = bridge.poll();
    await expect.poll(() => client.claim).toHaveBeenCalled();
    const stopped = bridge.stop();
    expect(client.hook).not.toHaveBeenCalledWith({ hook_event_name: 'SessionEnd' });
    resolve(true);
    await Promise.all([poll, stopped]);
    expect(client.release).toHaveBeenCalledWith('pending');
    expect(rpc.request.mock.calls.some(([method]) => method === 'turn/start')).toBe(false);
  });

  it.each([false, true])('settles an in-flight submission before SessionEnd (ambiguous=%s)', async (ambiguous) => {
    const { client, rpc } = await setup([{ id: 'pending', text: 'hello' }]);
    let resolve!: (value: any) => void, reject!: (error: Error) => void;
    rpc.request.mockImplementationOnce(() => new Promise((done, fail) => { resolve = done; reject = fail; }));
    const poll = bridge.poll().catch(() => {});
    await expect.poll(() => rpc.request.mock.calls.some(([method]) => method === 'turn/start')).toBe(true);
    const stopped = bridge.stop();
    expect(client.hook).not.toHaveBeenCalledWith({ hook_event_name: 'SessionEnd' });
    if (ambiguous) reject(new Error('connection closed'));
    else resolve({ turn: { id: 'last' } });
    await Promise.all([poll, stopped]);
    const receipt = vi.mocked(ambiguous ? client.unconfirmed : client.ack);
    expect(receipt).toHaveBeenCalledWith('pending');
    expect(receipt.mock.invocationCallOrder.at(-1)).toBeLessThan(vi.mocked(client.hook).mock.invocationCallOrder.at(-1)!);
    expect(client.hook).toHaveBeenLastCalledWith({ hook_event_name: 'SessionEnd' });
  });

  it('does not deadlock when a submission timeout initiates shutdown through fatal', async () => {
    const { client, rpc, fatal } = await setup([{ id: 'pending', text: 'hello' }]);
    let stopped: Promise<void> | undefined;
    fatal.mockImplementation(() => { stopped = bridge.stop(); });
    rpc.request.mockRejectedValueOnce(new Error('Codex turn/start response timed out; its outcome is unknown'));
    await expect(bridge.poll()).rejects.toThrow('response timed out');
    expect(stopped).toBeDefined();
    await stopped;
    expect(client.unconfirmed).toHaveBeenCalledWith('pending');
    expect(client.release).not.toHaveBeenCalled();
    expect(client.hook).toHaveBeenLastCalledWith({ hook_event_name: 'SessionEnd' });
  });

  it('drains the remaining accepted events when shutdown starts during a daemon retry', async () => {
    const { client, fatal } = await setup([]);
    vi.useFakeTimers();
    vi.mocked(client.modEvent).mockRejectedValue(new Error('daemon request timed out'));
    bridge.handle({ method: 'turn/started', params: { turn: { id: 'last' } } });
    bridge.handle({ method: 'item/completed', params: { item: { type: 'agentMessage', text: 'retained answer' } } });
    bridge.handle({ method: 'turn/completed', params: { turn: { id: 'last', status: 'completed' } } });
    const stopped = bridge.stop();
    await vi.advanceTimersByTimeAsync(5000);
    await stopped;
    expect(readFileSync(join(dir, 'session.jsonl'), 'utf8')).toContain('retained answer');
    expect(fatal).not.toHaveBeenCalled();
  });

  it('bounds shutdown with hung HTTP, retains queued transcripts and cancels pending requests', async () => {
    const { client } = await setup([]);
    const dispose = vi.spyOn(client, 'dispose');
    vi.useFakeTimers();
    vi.mocked(client.modEvent).mockImplementationOnce(() => new Promise(() => {}));
    bridge.handle({ method: 'turn/started', params: { turn: { id: 'last' } } });
    bridge.handle({ method: 'item/completed', params: { item: { type: 'commandExecution', command: 'echo answer' } } });
    bridge.handle({ method: 'item/completed', params: { item: { type: 'agentMessage', text: 'answer despite hung HTTP' } } });
    bridge.handle({ method: 'turn/completed', params: { turn: { id: 'last', status: 'completed' } } });
    const stopped = bridge.stop();
    let done = false;
    void stopped.then(() => { done = true; });
    await vi.advanceTimersByTimeAsync(4999);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(done).toBe(true);
    await stopped;
    expect(dispose).toHaveBeenCalledOnce();
    expect(readFileSync(join(dir, 'session.jsonl'), 'utf8')).toContain('answer despite hung HTTP');
    expect(readFileSync(join(dir, 'session.jsonl'), 'utf8')).toContain('tool_use');
    expect(client.modEvent).toHaveBeenCalledTimes(1);
    expect(client.hook).not.toHaveBeenCalledWith({ hook_event_name: 'SessionEnd' });
  });

  it('bounds an unresolved submission and never acknowledges its late acceptance', async () => {
    const { client, rpc } = await setup([{ id: 'unknown', text: 'possibly accepted' }]);
    let resolve!: (value: any) => void;
    rpc.request.mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
    const poll = bridge.poll();
    await expect.poll(() => rpc.request.mock.calls.some(([method]) => method === 'turn/start')).toBe(true);
    vi.useFakeTimers();
    const stopped = bridge.stop();
    await vi.advanceTimersByTimeAsync(5000);
    await stopped;
    expect(client.ack).not.toHaveBeenCalled();
    resolve({ turn: { id: 'late' } });
    await poll;
    expect(client.ack).not.toHaveBeenCalled();
    expect(client.release).not.toHaveBeenCalled();
  });

  it('attempts all pending receipts despite individual failures and never acknowledges unknown outcomes', async () => {
    const { client } = await setup([]);
    // Restore a pending ledger directly: ordinary polling will not submit new work
    // while a previous receipt is failing.
    const pending = bridge as unknown as { receipts: Set<string>; ambiguous: Set<string> };
    pending.receipts.add('failed');
    pending.receipts.add('accepted');
    pending.ambiguous.add('unknown');
    vi.mocked(client.ack).mockRejectedValueOnce(new Error('ack unavailable'));
    await bridge.stop();
    expect(client.ack).toHaveBeenCalledWith('failed');
    expect(client.ack).toHaveBeenCalledWith('accepted');
    expect(client.unconfirmed).toHaveBeenCalledWith('unknown');
    expect(client.ack).not.toHaveBeenCalledWith('unknown');
    expect(pending.receipts).toEqual(new Set(['failed']));
    expect(pending.ambiguous.size).toBe(0);
    expect(client.hook).toHaveBeenLastCalledWith({ hook_event_name: 'SessionEnd' });
  });

  it('retries a pending receipt during shutdown without resubmitting', async () => {
    const { client, rpc } = await setup([{ id: 'pending', text: 'hello' }]);
    vi.mocked(client.ack).mockRejectedValueOnce(new Error('temporary failure'));
    await expect(bridge.poll()).rejects.toThrow('temporary failure');
    await bridge.stop();
    expect(client.ack).toHaveBeenCalledTimes(2);
    expect(rpc.request.mock.calls.filter(([method]) => method === 'turn/start')).toHaveLength(1);
  });
});

describe('Codex inbox effort', () => {
  it.each(['thread/resume', 'thread/fork'] as const)('preserves native effort on %s instead of replaying spawn effort', async (method) => {
    const initial = await setup([], undefined, 'high');
    bridge.handle({ method: 'thread/settings/updated', params: {
      threadId: 'native', threadSettings: { model: 'test', effort: 'low' },
    } });
    bridge.handle({ method: 'item/completed', params: { item: {
      type: 'userMessage', content: [{ type: 'text', text: 'previous turn' }],
    } } });
    await bridge.stop();
    expect(initial.client.modEvent).toHaveBeenCalledWith('session.measure', { model: 'test' });
    const history = readFileSync(join(dir, 'session.jsonl'), 'utf8').split('\n').slice(1).join('\n');
    const { rpc } = await setup([{ id: 'next', text: 'after native picker change' }], history, 'high', method);
    expect(rpc.request).toHaveBeenLastCalledWith(method, expect.objectContaining({
      threadId: 'old',
    }));
    expect(rpc.request.mock.calls.at(-1)?.[1].config).not.toHaveProperty('model_reasoning_effort');
    expect(bridge.freshThread).toBe(false);
    expect(bridge.hasHistory).toBe(true);
    await bridge.poll();
    expect(rpc.request).toHaveBeenLastCalledWith('turn/start', {
      threadId: 'native', input: [{ type: 'text', text: 'after native picker change', text_elements: [] }],
    });
  });

  it('seeds effort on the genuine new-thread fallback but not the preceding resume attempt', async () => {
    const { rpc } = await setup([], '', 'high');
    expect(bridge.freshThread).toBe(true);
    expect(rpc.request.mock.calls.find(([method]) => method === 'thread/resume')?.[1].config)
      .not.toHaveProperty('model_reasoning_effort');
    expect(rpc.request).toHaveBeenLastCalledWith('thread/start', expect.objectContaining({
      config: expect.objectContaining({ model_reasoning_effort: 'high' }),
    }));
  });

  it.each([
    { model: 'test', effort: 'low' },
    { model: 'other-model', effort: null },
    { model: 'other-model' },
    undefined,
  ])('inherits native thread settings after a spawn override: %j', async (threadSettings) => {
    const { rpc } = await setup([{ id: 'message', text: 'hello' }], undefined, 'high');
    expect(rpc.request).toHaveBeenCalledWith('thread/start', expect.objectContaining({
      config: expect.objectContaining({ model_reasoning_effort: 'high' }),
    }));
    bridge.handle({ method: 'thread/settings/updated', params: { threadId: 'native', threadSettings } });
    await bridge.poll();
    expect(rpc.request).toHaveBeenLastCalledWith('turn/start', {
      threadId: 'native', input: [{ type: 'text', text: 'hello', text_elements: [] }],
    });
  });
});
