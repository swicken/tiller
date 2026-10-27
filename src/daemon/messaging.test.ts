import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NodeStatus, NodeView } from '../shared/protocol.js';
import { classify, composerTextOf } from './pty.js';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { flushEvents } from './sessions.js';
import { ack, claim, deliver, flushInbox, holdDeliveries, inbox, messageStatus, PI_CONFIRM_MS, QUEUE_TTL_MS, release, saveInboxForRestart, startNotices, unconfirmed, withdraw, type Mgr } from './messaging.js';

const PROMPT = ['some output', '────────────────── n-b', '❯ ', '──────────────────'];

class FakeSession {
  pasted: string[] = [];
  ack = true;
  constructor(private mgr: FakeManager, private id: string, public lines = PROMPT) {}
  async flush() {}
  classifyScreen() { return classify(this.lines); }
  composerText() { return composerTextOf(this.lines); }
  async paste(text: string) {
    this.pasted.push(text);
    if (this.ack) {
      this.mgr.emit('hook', this.id, { hook_event_name: 'UserPromptSubmit', prompt: `[Pasted text] ${text}` });
      this.mgr.set(this.id, { state: 'working', doneSource: undefined });
    }
  }
}

class FakeManager extends EventEmitter {
  nodes = new Map<string, NodeView>();
  sessions = new Map<string, FakeSession>();
  view = (id: string) => this.nodes.get(id);
  projectDir = (n: { cwd: string }) => n.cwd;
  session = (id: string) => this.sessions.get(id) as never;
  typed: [string, string][] = [];
  input = (id: string, data: string) => { this.typed.push([id, data]); };
  events: [string, string, Record<string, unknown>][] = [];
  logEvent = (id: string, type: string, data: Record<string, unknown> = {}) => { this.events.push([id, type, data]); };
  add(id: string, parentId: string | null, status: Partial<NodeStatus> = {}, kind: 'claude' | 'terminal' = 'claude') {
    this.nodes.set(id, { id, parentId, kind, title: `T-${id}`, cwd: '/', createdAt: 0, unread: false, status: { state: 'done', doneSource: 'stop', changedAt: 0, ...status } });
    this.sessions.set(id, new FakeSession(this, id));
  }
  set(id: string, patch: Partial<NodeStatus>) {
    const v = this.nodes.get(id)!;
    v.status = { ...v.status, ...patch };
    this.emit('node', v);
  }
  get mgr() { return this as unknown as Mgr; }
}

let m: FakeManager;
beforeEach(() => {
  vi.useFakeTimers();
  m = new FakeManager();
  m.add('p', null);          // parent
  m.add('a', 'p');           // child a
  m.add('b', 'p');           // child b (sibling of a)
  m.add('x', null);          // unrelated root
  m.add('t', 'p', { state: 'none' }, 'terminal');
});
afterEach(() => vi.useRealTimers());

describe('gates', () => {
  it('delivers to a verified-idle sibling and reports the receipt', async () => {
    const r = await deliver(m.mgr, 'a', 'b', 'hello');
    expect(r).toMatchObject({ outcome: 'delivered', retryable: false });
    expect(r.messageId).toMatch(/^m-/);
  });

  it('refuses out-of-lineage, self and terminal targets; reports gone for missing or exited', async () => {
    expect(await deliver(m.mgr, 'a', 'x', 'hi')).toMatchObject({ outcome: 'refused' });
    expect(await deliver(m.mgr, 'a', 'a', 'hi')).toMatchObject({ outcome: 'refused' });
    expect(await deliver(m.mgr, 'a', 't', 'hi')).toMatchObject({ outcome: 'refused', detail: expect.stringContaining('not an agent node') });
    expect(await deliver(m.mgr, 'human', 'nope', 'hi')).toMatchObject({ outcome: 'gone' });
    expect(await deliver(m.mgr, 'a', 'nope', 'hi')).toMatchObject({ outcome: 'refused' }); // no existence probe
    m.set('b', { exited: true });
    expect(await deliver(m.mgr, 'a', 'b', 'hi')).toMatchObject({ outcome: 'gone' });
  });

  it('allows ancestor and descendant but not cousins', async () => {
    m.add('g', 'a'); // grandchild
    expect((await deliver(m.mgr, 'g', 'p', 'up')).outcome).toBe('delivered');
    expect((await deliver(m.mgr, 'p', 'g', 'down')).outcome).toBe('delivered');
    expect((await deliver(m.mgr, 'g', 'b', 'cousin-ish')).outcome).toBe('refused'); // g's uncle is not in lineage
  });

  it.each([
    ['working', { state: 'working' as const }],
    ['done via idle_prompt', { doneSource: 'idle_prompt' as const }],
    ['done via sweep', { doneSource: 'sweep' as const, stale: true }],
    ['stale', { stale: true }],
    ['blocked', { state: 'blocked' as const }],
  ])('queues when the target is %s', async (_n, patch) => {
    m.set('b', patch);
    const r = await deliver(m.mgr, 'a', 'b', 'hi');
    expect(r.outcome).toBe('queued');
    expect(m.sessions.get('b')!.pasted).toHaveLength(0);
  });

  it('queues when a dialog is showing or the composer holds a draft', async () => {
    m.sessions.get('b')!.lines = ['Do you trust this folder?', '❯ 1. Yes', '  2. No, exit', 'Enter to confirm · Esc to cancel'];
    expect(await deliver(m.mgr, 'a', 'b', 'hi')).toMatchObject({ outcome: 'queued', detail: expect.stringContaining('dialog') });
    m.sessions.get('p')!.lines = ['────── p', '❯ half typed', '──────'];
    expect(await deliver(m.mgr, 'a', 'p', 'hi')).toMatchObject({ outcome: 'queued', detail: expect.stringContaining('unsent') });
    expect(m.sessions.get('p')!.pasted).toHaveLength(0);
  });

  it('rate limits one send per pair per 10 s', async () => {
    await deliver(m.mgr, 'a', 'b', 'one');
    const r = await deliver(m.mgr, 'a', 'b', 'two');
    expect(r).toMatchObject({ outcome: 'refused', retryable: true, detail: 'rate limited, retry in 10 s' });
    expect((await deliver(m.mgr, 'b', 'a', 'other direction')).outcome).toBe('delivered');
    await vi.advanceTimersByTimeAsync(10_000);
    m.set('b', { state: 'done', doneSource: 'stop' });
    expect((await deliver(m.mgr, 'a', 'b', 'three')).outcome).toBe('delivered');
  });

  it('reports stalled when no matching UserPromptSubmit arrives within 8 s', async () => {
    m.sessions.get('b')!.ack = false;
    const p = deliver(m.mgr, 'a', 'b', 'hi');
    await vi.advanceTimersByTimeAsync(8000);
    expect(await p).toMatchObject({ outcome: 'stalled', retryable: false });
  });
});

describe('loop detection', () => {
  beforeEach(() => { vi.stubEnv('TL_HOME', '/nonexistent'); }); // default limits, whatever the real home holds
  afterEach(() => { vi.unstubAllEnvs(); });
  const send = async (text: string) => {
    m.set('b', { state: 'done', doneSource: 'stop' });
    const r = await deliver(m.mgr, 'a', 'b', text);
    await vi.advanceTimersByTimeAsync(10_000); // past the per-pair rate limit
    return r;
  };

  it('refuses the 21st message between one pair in 10 minutes and tells the sender\'s parent once', async () => {
    for (let i = 1; i <= 20; i++) expect((await send(`m${i}`)).outcome).toBe('delivered');
    const r = await send('m21');
    expect(r).toMatchObject({ outcome: 'refused', retryable: false });
    expect(r.detail).toBe('looks like a loop: 20 messages to b in 10 min (limits.maxMessagesPer10Min); escalate to the human or change approach');
    expect(m.sessions.get('p')!.pasted).toHaveLength(1);
    expect(m.sessions.get('p')!.pasted[0]).toContain('from: tiller (child a "T-a" may be looping)');
    expect((await send('m22')).outcome).toBe('refused');
    expect(m.sessions.get('p')!.pasted).toHaveLength(1);
    expect((await deliver(m.mgr, 'b', 'a', 'other pair')).outcome).toBe('delivered');
    await vi.advanceTimersByTimeAsync(10 * 60_000); // the window has moved on
    expect((await send('m23')).outcome).toBe('delivered');
  });

  it('refuses an identical body repeated within 10 minutes; the human and the daemon are exempt', async () => {
    expect((await send('same')).outcome).toBe('delivered');
    expect(await send('same')).toMatchObject({ outcome: 'refused', detail: expect.stringContaining('the same message to b twice in 10 min; escalate to the human or change approach') });
    expect((await send('different')).outcome).toBe('delivered');
    for (const from of ['human', 'tiller']) {
      m.set('b', { state: 'done', doneSource: 'stop' });
      expect((await deliver(m.mgr, from, 'b', 'x')).outcome).toBe('delivered');
      await vi.advanceTimersByTimeAsync(10_000);
      m.set('b', { state: 'done', doneSource: 'stop' });
      expect((await deliver(m.mgr, from, 'b', 'x')).outcome).toBe('delivered');
    }
  });

  it('does not count a send that came back queueFull or was later withdrawn or expired', async () => {
    m.set('b', { state: 'working' });
    const fill = [];
    for (let i = 0; i < 16; i++) fill.push(await deliver(m.mgr, 'tiller', 'b', `fill${i}`));
    expect((await deliver(m.mgr, 'a', 'b', 'retry me')).outcome).toBe('queueFull');
    await withdraw(m.mgr, 'human', fill[0].messageId!);
    await vi.advanceTimersByTimeAsync(10_000);
    const r = await deliver(m.mgr, 'a', 'b', 'retry me');
    expect(r.outcome).toBe('queued');
    await withdraw(m.mgr, 'a', r.messageId!);
    await vi.advanceTimersByTimeAsync(10_000);
    expect((await deliver(m.mgr, 'a', 'b', 'retry me')).outcome).toBe('queued');
    await vi.advanceTimersByTimeAsync(5 * 60_000); // it expires
    expect((await deliver(m.mgr, 'a', 'b', 'retry me')).outcome).toBe('queued');
    expect(m.sessions.get('p')!.pasted).toEqual([]); // no loop notice
  });

  it('forgets a pair\'s rate, repeat and loop history once either node is removed', async () => {
    m.set('b', { state: 'done', doneSource: 'stop' });
    expect((await deliver(m.mgr, 'a', 'b', 'same')).outcome).toBe('delivered');
    for (const id of ['b', 'a']) {
      m.emit('removed', id);
      m.add(id, 'p'); // the same id again, standing in for a fresh node
      m.set('b', { state: 'done', doneSource: 'stop' });
      expect((await deliver(m.mgr, 'a', 'b', 'same')).outcome).toBe('delivered'); // no rate wait, no repeat refusal
    }
  });
});

describe('envelope', () => {
  it('frames the message with a per-delivery nonce', async () => {
    await deliver(m.mgr, 'a', 'b', 'line1\nline2');
    m.set('b', { state: 'done', doneSource: 'stop' });
    await deliver(m.mgr, 'p', 'b', 'again');
    const [first, second] = m.sessions.get('b')!.pasted;
    const nonceOf = (t: string) => /^--- TL MESSAGE (\S+) ---\n/.exec(t)?.[1];
    expect(nonceOf(first)).toBeTruthy();
    expect(nonceOf(second)).toBeTruthy();
    expect(nonceOf(first)).not.toBe(nonceOf(second));
    expect(first).toBe(`--- TL MESSAGE ${nonceOf(first)} ---\nfrom: T-a (a)\nreply-to: a\nline1\nline2\n--- END TL MESSAGE ${nonceOf(first)} ---`);
  });
});

describe('queue', () => {
  it('caps at 16, then refuses with queueFull', async () => {
    m.set('b', { state: 'working' });
    for (let i = 0; i < 16; i++) expect((await deliver(m.mgr, 'tiller', 'b', `m${i}`)).outcome).toBe('queued');
    expect(await deliver(m.mgr, 'tiller', 'b', 'overflow')).toMatchObject({ outcome: 'queueFull', retryable: true });
  });

  it('expires after 5 minutes and tells the sender through message_status', async () => {
    m.set('b', { state: 'working' });
    const r = await deliver(m.mgr, 'a', 'b', 'hi');
    expect(messageStatus(m.mgr, 'a', r.messageId!)?.outcome).toBe('queued');
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(messageStatus(m.mgr, 'a', r.messageId!)).toMatchObject({ outcome: 'expired', retryable: true });
    expect(messageStatus(m.mgr, 'p', r.messageId!)).toBeUndefined(); // only the sender may ask
  });

  it('flushes in order when the target reaches verified idle, one at a time', async () => {
    m.set('b', { state: 'working' });
    const r1 = await deliver(m.mgr, 'tiller', 'b', 'first');
    const r2 = await deliver(m.mgr, 'tiller', 'b', 'second');
    m.set('b', { state: 'done', doneSource: 'stop' });
    await vi.advanceTimersByTimeAsync(0);
    const pasted = m.sessions.get('b')!.pasted;
    expect(pasted).toHaveLength(1);
    expect(pasted[0]).toContain('first');
    expect(messageStatus(m.mgr, 'tiller', r1.messageId!)?.outcome).toBe('delivered');
    expect(messageStatus(m.mgr, 'tiller', r2.messageId!)?.outcome).toBe('queued');
    m.set('b', { state: 'working' });
    m.set('b', { state: 'done', doneSource: 'stop' });
    await vi.advanceTimersByTimeAsync(0);
    expect(m.sessions.get('b')!.pasted[1]).toContain('second');
  });

  it('retries every second while the target is verified idle but its composer has not repainted', async () => {
    m.set('b', { state: 'working' });
    const r = await deliver(m.mgr, 'a', 'b', 'hi');
    const b = m.sessions.get('b')!;
    b.lines = ['still repainting'];
    m.set('b', { state: 'done', doneSource: 'stop' }); // Stop arrives first; the screen check fails
    await vi.advanceTimersByTimeAsync(0);
    expect(b.pasted).toHaveLength(0);
    b.lines = PROMPT; // composer repaints; no further node event follows
    await vi.advanceTimersByTimeAsync(1000);
    expect(b.pasted).toHaveLength(1);
    expect(messageStatus(m.mgr, 'a', r.messageId!)?.outcome).toBe('delivered');
  });

  it('records immediate outcomes for message_status too', async () => {
    const r = await deliver(m.mgr, 'a', 'b', 'hi');
    expect(r.outcome).toBe('delivered');
    expect(messageStatus(m.mgr, 'a', r.messageId!)).toMatchObject({ outcome: 'delivered' });
    await vi.advanceTimersByTimeAsync(3600_000 + 1);
    await deliver(m.mgr, 'p', 'x', 'prune trigger');
    expect(messageStatus(m.mgr, 'a', r.messageId!)).toBeUndefined();
  });

  it('resolves queued messages as gone when the target exits', async () => {
    m.set('b', { state: 'working' });
    const r = await deliver(m.mgr, 'a', 'b', 'hi');
    m.set('b', { exited: true });
    await vi.advanceTimersByTimeAsync(0);
    expect(messageStatus(m.mgr, 'a', r.messageId!)?.outcome).toBe('gone');
  });
});

describe('mod inbox', () => {
  it('bounds claimed Pi messages despite live polls/busy state; late hook/ack cannot report delivered', async () => {
    Object.assign(m.nodes.get('b')!, { kind: 'agent', harness: 'pi' });
    const r = await deliver(m.mgr, 'a', 'b', 'unaccepted native send');
    const [msg] = inbox(m.mgr, 'b');
    expect(claim(m.mgr, 'b', msg.id)).toBe(true);
    expect(claim(m.mgr, 'b', msg.id)).toBe(false);
    m.set('b', { state: 'working' });
    for (let i = 0; i < 60; i++) {
      inbox(m.mgr, 'b');
      await vi.advanceTimersByTimeAsync(PI_CONFIRM_MS / 60);
    }
    expect(messageStatus(m.mgr, 'a', r.messageId!)).toMatchObject({ outcome: 'stalled', retryable: false, detail: expect.stringContaining('may still run') });
    expect(inbox(m.mgr, 'b')).toEqual([]);
    m.emit('hook', 'b', { hook_event_name: 'UserPromptSubmit', prompt: msg.text });
    expect(ack(m.mgr, 'b', msg.id)).toBe(false);
    expect(messageStatus(m.mgr, 'a', msg.id)?.outcome).toBe('stalled');
    const b = await deliver(m.mgr, 'p', 'b', 'later B', { mode: 'now' });
    expect(claim(m.mgr, 'b', b.messageId!)).toBe(true);
  });

  it('a released Pi claim is queued, withdrawable and retryable again, never stalled', async () => {
    Object.assign(m.nodes.get('b')!, { kind: 'agent', harness: 'pi' });
    m.set('b', { state: 'working' });
    const r = await deliver(m.mgr, 'a', 'b', 'claimed just as Pi became busy');
    expect(release(m.mgr, 'b', r.messageId!)).toBe(false); // not claimed
    expect(claim(m.mgr, 'b', r.messageId!)).toBe(true);
    expect(release(m.mgr, 'p', r.messageId!)).toBe(false); // no cross-node mutation
    expect(release(m.mgr, 'b', r.messageId!)).toBe(true);
    expect(inbox(m.mgr, 'b')).toEqual([expect.not.objectContaining({ claimed: true })]);
    await vi.advanceTimersByTimeAsync(PI_CONFIRM_MS + 1000); // the claim lease no longer applies
    expect(messageStatus(m.mgr, 'a', r.messageId!)?.outcome).toBe('queued');
    m.set('b', { state: 'done', doneSource: 'stop' });
    await vi.advanceTimersByTimeAsync(QUEUE_TTL_MS);
    expect(messageStatus(m.mgr, 'a', r.messageId!)).toMatchObject({ outcome: 'expired', retryable: true });
    const w = await deliver(m.mgr, 'p', 'b', 'withdraw me after a release');
    expect(claim(m.mgr, 'b', w.messageId!)).toBe(true);
    expect(release(m.mgr, 'b', w.messageId!)).toBe(true);
    await expect(withdraw(m.mgr, 'p', w.messageId!)).resolves.toMatchObject({ result: { outcome: 'withdrawn' } });
  });

  it('a Pi claim that cannot be persisted is refused and stays queued, not retired', async () => {
    Object.assign(m.nodes.get('b')!, { kind: 'agent', harness: 'pi' });
    const home = join(tmpdir(), `tlinbox-missing-${process.pid}`, 'nope'); // never created, so every write fails
    const mh = Object.assign(Object.create(m), { home }) as Mgr;
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => {});
    const r = await deliver(mh, 'a', 'b', 'claim persist fails');
    expect(claim(mh, 'b', r.messageId!)).toBe(false);
    quiet.mockRestore();
    expect(inbox(mh, 'b')).toEqual([expect.not.objectContaining({ claimed: true })]);
    await vi.advanceTimersByTimeAsync(PI_CONFIRM_MS + 1000);
    expect(messageStatus(mh, 'a', r.messageId!)?.outcome).toBe('queued');
  });

  it('retires only the caller claimed message, preserves status and prevents replay across restart', async () => {
    Object.assign(m.nodes.get('b')!, { kind: 'agent', harness: 'pi' });
    const home = mkdtempSync(join(tmpdir(), 'tlinbox-pi-'));
    try {
      const withHome = (): Mgr => Object.assign(Object.create(m), { home }) as Mgr;
      const m1 = withHome();
      const r = await deliver(m1, 'a', 'b', 'native A');
      expect(unconfirmed(m1, 'b', r.messageId!)).toBe(false); // not yet claimed
      expect(claim(m1, 'b', r.messageId!)).toBe(true);
      // Claim is saved before /claim returns, no debounce window can allow replay.
      const m2 = withHome();
      expect(inbox(m2, 'b')[0]).toMatchObject({ id: r.messageId, claimed: true });
      expect(claim(m2, 'b', r.messageId!)).toBe(false);
      expect(unconfirmed(m2, 'p', r.messageId!)).toBe(false); // no cross-node mutation
      expect(unconfirmed(m2, 'b', r.messageId!)).toBe(true);
      flushInbox(m2);
      const m3 = withHome();
      expect(inbox(m3, 'b')).toEqual([]);
      expect(messageStatus(m3, 'a', r.messageId!)).toMatchObject({ outcome: 'stalled', retryable: false });
      expect(ack(m3, 'b', r.messageId!)).toBe(false);
    } finally { rmSync(home, { recursive: true, force: true }); }
  });

  beforeEach(() => { inbox(m.mgr, 'b'); }); // b's mod polls

  it('queues for a mod-live target without pasting; the inbox lists it; ack resolves it as delivered', async () => {
    m.set('b', { state: 'working' });
    const r = await deliver(m.mgr, 'a', 'b', 'hello');
    expect(r).toMatchObject({ outcome: 'queued', retryable: false, messageId: expect.stringMatching(/^m-/) });
    const [msg] = inbox(m.mgr, 'b');
    expect(msg).toMatchObject({ id: r.messageId, from: 'T-a (a)' });
    expect(msg.text).toMatch(/^--- TL MESSAGE (\S+) ---\nfrom: T-a \(a\)\nreply-to: a\nhello\n--- END TL MESSAGE \1 ---$/);
    expect(m.sessions.get('b')!.pasted).toHaveLength(0);
    expect(messageStatus(m.mgr, 'a', r.messageId!)?.outcome).toBe('queued');
    expect(ack(m.mgr, 'p', r.messageId!)).toBe(false); // not p's message
    expect(ack(m.mgr, 'b', r.messageId!)).toBe(true);
    expect(inbox(m.mgr, 'b')).toEqual([]);
    expect(messageStatus(m.mgr, 'a', r.messageId!)).toMatchObject({ outcome: 'delivered' });
  });

  it('a UserPromptSubmit carrying the message delivers it, so a mod that reloads before acking does not resubmit it', async () => {
    const r = await deliver(m.mgr, 'a', 'b', 'hello');
    const [msg] = inbox(m.mgr, 'b');
    m.emit('hook', 'b', { hook_event_name: 'UserPromptSubmit', prompt: msg.text }); // submitted; the reload then drops the ack
    expect(inbox(m.mgr, 'b')).toEqual([]); // the reloaded mod's next poll finds nothing to submit again
    expect(messageStatus(m.mgr, 'a', r.messageId!)).toMatchObject({ outcome: 'delivered' });
    expect(ack(m.mgr, 'b', r.messageId!)).toBe(false); // a late ack is harmless
  });

  it('expires unacked messages after 5 minutes and removes them from the inbox', async () => {
    const r = await deliver(m.mgr, 'a', 'b', 'hi');
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(inbox(m.mgr, 'b')).toEqual([]);
    expect(messageStatus(m.mgr, 'a', r.messageId!)).toMatchObject({ outcome: 'expired', retryable: true });
  });

  it('does not expire while the target works (the mod holds messages until the turn ends)', async () => {
    m.set('b', { state: 'working' });
    const r = await deliver(m.mgr, 'a', 'b', 'hi');
    await vi.advanceTimersByTimeAsync(12 * 60_000);
    expect(inbox(m.mgr, 'b').map((x) => x.id)).toEqual([r.messageId]);
    m.set('b', { state: 'done', doneSource: 'stop' });
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(messageStatus(m.mgr, 'a', r.messageId!)).toMatchObject({ outcome: 'expired' });
  });

  it('does not expire a claimed message while the mod is live and submitting it', async () => {
    const r = await deliver(m.mgr, 'a', 'b', 'slow submit');
    expect(claim(m.mgr, 'b', r.messageId!)).toBe(true);
    await vi.advanceTimersByTimeAsync(5 * 60_000 - 1000);
    inbox(m.mgr, 'b'); // the mod still polls
    await vi.advanceTimersByTimeAsync(2000); // past the TTL
    expect(messageStatus(m.mgr, 'a', r.messageId!)?.outcome).toBe('queued');
    expect(ack(m.mgr, 'b', r.messageId!)).toBe(true);
    expect(messageStatus(m.mgr, 'a', r.messageId!)).toMatchObject({ outcome: 'delivered' });
    // A claimed message whose mod has gone away still expires.
    const gone = await deliver(m.mgr, 'p', 'b', 'mod died');
    claim(m.mgr, 'b', gone.messageId!);
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(messageStatus(m.mgr, 'p', gone.messageId!)).toMatchObject({ outcome: 'expired' });
  });

  it('caps the inbox at 16', async () => {
    for (let i = 0; i < 16; i++) expect((await deliver(m.mgr, 'tiller', 'b', `m${i}`)).outcome).toBe('queued');
    expect(await deliver(m.mgr, 'tiller', 'b', 'overflow')).toMatchObject({ outcome: 'queueFull', retryable: true });
  });

  it('station notices ride the inbox too', async () => {
    startNotices(m.mgr);
    inbox(m.mgr, 'p');
    m.set('a', { exited: true });
    await vi.advanceTimersByTimeAsync(0);
    expect(inbox(m.mgr, 'p')[0].text).toContain('stopped: exited');
    expect(m.sessions.get('p')!.pasted).toHaveLength(0);
  });

  it('a stopped notice carries the child\'s last message whole, and cuts a very long one visibly', async () => {
    startNotices(m.mgr);
    inbox(m.mgr, 'p');
    const para = 'A full paragraph about what was done. '.repeat(20).trim(); // ~760 characters: carried whole
    m.set('a', { exited: true, lastAssistantMessage: para });
    m.set('b', { exited: true, lastAssistantMessage: 'y'.repeat(1600) });
    await vi.advanceTimersByTimeAsync(0);
    const [a, b] = inbox(m.mgr, 'p').map((x) => x.text);
    expect(a).toContain(`\n${para}\n`);
    expect(b).toContain(`\n${'y'.repeat(1500)}… (read summary for the rest)\n`);
  });

  it('falls back to paste once the mod has not polled for 5 s', async () => {
    await vi.advanceTimersByTimeAsync(5000);
    expect((await deliver(m.mgr, 'a', 'b', 'still live')).outcome).toBe('queued'); // exactly 5 s: still live
    await vi.advanceTimersByTimeAsync(1);
    const r = await deliver(m.mgr, 'p', 'b', 'stale mod');
    expect(r.outcome).toBe('delivered');
    expect(m.sessions.get('b')!.pasted).toHaveLength(1);
  });

  it('reload drops stale claimed Claude items exactly as before but retires stale Pi claims honestly', async () => {
    const home = mkdtempSync(join(tmpdir(), 'tlinbox-stale-claims-'));
    try {
      m.add('pi', 'p');
      Object.assign(m.nodes.get('pi')!, { kind: 'agent', harness: 'pi' });
      m.set('b', { state: 'working' }); // old code must not renew a restored stale Claude claim
      const enqueuedAt = Date.now() - QUEUE_TTL_MS - 1;
      writeFileSync(join(home, 'inbox.json'), JSON.stringify({ version: 1, items: ['b', 'pi'].map((to) => ({
        to, from: 'a', claimed: true, msg: { id: `old-${to}`, from: 'a', text: to, enqueuedAt },
      })) }));
      const restarted = Object.assign(Object.create(m), { home }) as Mgr;
      expect(inbox(restarted, 'b')).toEqual([]);
      expect(messageStatus(restarted, 'a', 'old-b')).toBeUndefined();
      expect(inbox(restarted, 'pi')).toMatchObject([{ id: 'old-pi', claimed: true }]);
      await vi.advanceTimersByTimeAsync(0);
      expect(inbox(restarted, 'pi')).toEqual([]);
      expect(messageStatus(restarted, 'a', 'old-pi')).toMatchObject({ outcome: 'stalled', retryable: false });
    } finally { rmSync(home, { recursive: true, force: true }); }
  });

  it('survives a restart; entries past their TTL are dropped', async () => {
    const home = mkdtempSync(join(tmpdir(), 'tlinbox-'));
    try {
      const withHome = (): Mgr => Object.assign(Object.create(m), { home }) as Mgr; // fresh state per Mgr object
      const m1 = withHome();
      inbox(m1, 'b');
      const keep = await deliver(m1, 'a', 'b', 'keep');
      await vi.advanceTimersByTimeAsync(60);
      expect(JSON.parse(readFileSync(join(home, 'inbox.json'), 'utf8')).items).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(4 * 60_000);
      const m2 = withHome();
      expect(inbox(m2, 'b').map((x) => x.id)).toEqual([keep.messageId]);
      await vi.advanceTimersByTimeAsync(60_000 + 1);
      expect(inbox(m2, 'b')).toEqual([]);
      expect(inbox(withHome(), 'b')).toEqual([]); // expired entry is not reloaded
    } finally { rmSync(home, { recursive: true, force: true }); }
  });

  it('flushInbox writes a pending save at once, so a shutdown inside the debounce loses nothing', async () => {
    const home = mkdtempSync(join(tmpdir(), 'tlinbox-'));
    try {
      const m1 = Object.assign(Object.create(m.mgr), { home }) as Mgr;
      inbox(m1, 'b');
      const sent = await deliver(m1, 'a', 'b', 'just before shutdown');
      flushInbox(m1); // no timers advanced: the 50 ms debounce has not fired
      expect(JSON.parse(readFileSync(join(home, 'inbox.json'), 'utf8')).items.map((i: { msg: { id: string } }) => i.msg.id)).toEqual([sent.messageId]);
    } finally { rmSync(home, { recursive: true, force: true }); }
  });
});

describe('restart drain', () => {
  const draining = (extra = {}) => {
    const d = Object.assign(Object.create(m), { draining: true, ...extra }) as Mgr & { draining: boolean };
    holdDeliveries(d);
    return d;
  };

  it('holds deliveries without expiring them and keeps them across the restart with a fresh TTL', async () => {
    const home = mkdtempSync(join(tmpdir(), 'tlinbox-drain-'));
    try {
      const m1 = draining({ home });
      inbox(m1, 'b'); // b's mod polls; a has none, so its messages wait to be pasted
      const toMod = await deliver(m1, 'a', 'b', 'for the mod');
      const toPaste = await deliver(m1, 'p', 'a', 'to paste');
      expect(toPaste.outcome).toBe('queued');
      expect(inbox(m1, 'b')).toEqual([]); // the mod has nothing to submit
      expect(claim(m1, 'b', toMod.messageId!)).toBe(false);
      await vi.advanceTimersByTimeAsync(2 * QUEUE_TTL_MS);
      expect(m.sessions.get('a')!.pasted).toEqual([]);
      expect(messageStatus(m1, 'a', toMod.messageId!)?.outcome).toBe('queued');
      expect(messageStatus(m1, 'p', toPaste.messageId!)?.outcome).toBe('queued');
      saveInboxForRestart(m1); // shutdown
      const m2 = Object.assign(Object.create(m), { home }) as Mgr; // the new daemon
      expect(inbox(m2, 'b').map((x) => x.id)).toEqual([toMod.messageId]);
      expect(inbox(m2, 'a').map((x) => x.id)).toEqual([toPaste.messageId]); // moved to the inbox for a's resumed mod
      await vi.advanceTimersByTimeAsync(QUEUE_TTL_MS - 1000); // the TTL starts at the load
      expect(inbox(m2, 'b')).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(2000);
      expect(inbox(m2, 'b')).toEqual([]);
    } finally { rmSync(home, { recursive: true, force: true }); }
  });

  it('keeps send order when the restart moves waiting pastes into an inbox that already has messages', async () => {
    const home = mkdtempSync(join(tmpdir(), 'tlinbox-order-'));
    try {
      const m1 = draining({ home });
      const pasteFirst = await deliver(m1, 'p', 'a', 'first, waiting to be pasted');
      await vi.advanceTimersByTimeAsync(1000);
      const inboxSecond = await deliver(m1, 'b', 'a', 'second, in the inbox', { inbox: true });
      saveInboxForRestart(m1);
      const m2 = Object.assign(Object.create(m), { home }) as Mgr;
      expect(inbox(m2, 'a').map((x) => x.id)).toEqual([pasteFirst.messageId, inboxSecond.messageId]);
    } finally { rmSync(home, { recursive: true, force: true }); }
  });

  it('delivers what it held once the drain ends without a restart, and never interrupts a turn for a steer', async () => {
    const d = draining();
    const held = await deliver(d, 'p', 'a', 'held');
    m.set('b', { state: 'working' });
    const steer = await deliver(d, 'p', 'b', 'urgent', { mode: 'now' });
    expect(steer).toMatchObject({ outcome: 'queued' });
    expect(steer.steer).toBeUndefined();
    expect(m.typed).toEqual([]); // no Esc
    expect(m.sessions.get('a')!.pasted).toEqual([]);
    d.draining = false;
    holdDeliveries(d);
    await vi.advanceTimersByTimeAsync(0);
    expect(messageStatus(d, 'p', held.messageId!)?.outcome).toBe('delivered');
  });
});

describe('steer (mode now)', () => {
  it('to an idle target behaves like queue: pasted at once, no Esc, no steer line', async () => {
    const r = await deliver(m.mgr, 'a', 'b', 'hi', { mode: 'now' });
    expect(r).toMatchObject({ outcome: 'delivered' });
    expect(r.steer).toBeUndefined();
    expect(m.typed).toEqual([]);
    expect(m.sessions.get('b')!.pasted[0]).not.toContain('steer:');
  });

  it('to a working target presses Esc once, jumps the queue, and delivers once after the interrupt', async () => {
    m.set('b', { state: 'working' });
    const queued = await deliver(m.mgr, 'p', 'b', 'normal');
    const r = await deliver(m.mgr, 'a', 'b', 'stop that', { mode: 'now' });
    expect(r).toMatchObject({ outcome: 'queued', steer: true });
    expect(m.typed).toEqual([['b', '\x1b']]);
    const b = m.sessions.get('b')!;
    expect(b.pasted).toHaveLength(0);
    m.set('b', { state: 'done', doneSource: 'interrupt', interrupted: true }); // what the manager does after Esc
    await vi.advanceTimersByTimeAsync(0);
    expect(b.pasted).toHaveLength(1);
    expect(b.pasted[0]).toMatch(/\nreply-to: a\nsteer: the sender interrupted your turn on purpose to deliver this now\nstop that\n/);
    expect(messageStatus(m.mgr, 'a', r.messageId!)).toMatchObject({ outcome: 'delivered', steer: true });
    // Later events (a late Stop, the retry timer) do not paste it again, and the normal message waits for a real Stop.
    m.set('b', { state: 'done', doneSource: 'interrupt' });
    await vi.advanceTimersByTimeAsync(5000);
    expect(b.pasted).toHaveLength(1);
    expect(messageStatus(m.mgr, 'p', queued.messageId!)?.outcome).toBe('queued');
    m.set('b', { state: 'done', doneSource: 'stop' });
    await vi.advanceTimersByTimeAsync(0);
    expect(b.pasted.map((t) => t.includes('stop that'))).toEqual([true, false]);
    expect(m.typed).toHaveLength(1);
  });

  it('keeps the rate limit', async () => {
    m.set('b', { state: 'working' });
    await deliver(m.mgr, 'a', 'b', 'one');
    expect(await deliver(m.mgr, 'a', 'b', 'two', { mode: 'now' })).toMatchObject({ outcome: 'refused', retryable: true });
    expect(m.typed).toEqual([]);
  });

  it('to a mod-live working target flags the inbox message for the mod instead of pressing Esc', async () => {
    inbox(m.mgr, 'b');
    m.set('b', { state: 'working' });
    const r = await deliver(m.mgr, 'a', 'b', 'stop that', { mode: 'now' });
    expect(r).toMatchObject({ outcome: 'queued', steer: true });
    expect(m.typed).toEqual([]);
    const [msg] = inbox(m.mgr, 'b');
    expect(msg.steer).toBe(true);
    expect(msg.text).toContain('\nsteer: the sender interrupted your turn');
    expect(claim(m.mgr, 'b', msg.id)).toBe(true);
    expect(ack(m.mgr, 'b', msg.id)).toBe(true);
    expect(messageStatus(m.mgr, 'a', r.messageId!)).toMatchObject({ outcome: 'delivered', steer: true });
  });
});

describe('withdraw', () => {
  it('removes a queued paste-path message so it is never delivered', async () => {
    m.set('b', { state: 'working' });
    const r = await deliver(m.mgr, 'a', 'b', 'never mind');
    await expect(withdraw(m.mgr, 'p', r.messageId!)).rejects.toThrow(/no message .* from you/); // not p's
    expect(await withdraw(m.mgr, 'a', r.messageId!)).toMatchObject({ to: 'b', result: { outcome: 'withdrawn' } });
    m.set('b', { state: 'done', doneSource: 'stop' });
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(m.sessions.get('b')!.pasted).toHaveLength(0);
    expect(messageStatus(m.mgr, 'a', r.messageId!)).toMatchObject({ outcome: 'withdrawn' });
  });

  it('removes a mod inbox message before the mod claims it; a claimed one is refused', async () => {
    inbox(m.mgr, 'b');
    m.set('b', { state: 'working' });
    const r1 = await deliver(m.mgr, 'a', 'b', 'first');
    const r2 = await deliver(m.mgr, 'p', 'b', 'second');
    await withdraw(m.mgr, 'a', r1.messageId!);
    expect(inbox(m.mgr, 'b').map((x) => x.id)).toEqual([r2.messageId]);
    expect(claim(m.mgr, 'b', r1.messageId!)).toBe(false); // the mod must not submit it
    expect(claim(m.mgr, 'b', r2.messageId!)).toBe(true);
    await expect(withdraw(m.mgr, 'p', r2.messageId!)).rejects.toThrow(/already submitting/);
  });

  it('is refused after delivery, and the reply says so', async () => {
    const r = await deliver(m.mgr, 'a', 'b', 'hi');
    expect(r.outcome).toBe('delivered');
    await expect(withdraw(m.mgr, 'a', r.messageId!)).rejects.toThrow(`cannot withdraw ${r.messageId}: it is already delivered`);
  });
});

describe('event log', () => {
  it('logs every send with its text on the target, the daemon\'s notices included, and withdrawals', async () => {
    m.set('b', { state: 'working' });
    const r = await deliver(m.mgr, 'human', 'b', 'hi');
    const n = await deliver(m.mgr, 'tiller', 'b', 'notice', { fromLabel: 'tiller (your\nturn errored)', about: ['b'] });
    await withdraw(m.mgr, 'human', r.messageId!);
    expect(m.events).toEqual([
      ['b', 'send', { from: 'human', outcome: 'queued', messageId: r.messageId, text: 'hi' }],
      ['b', 'send', { from: 'tiller', outcome: 'queued', messageId: n.messageId, text: 'notice', label: 'tiller (your turn errored)', about: ['b'] }],
      ['b', 'settle', { messageId: r.messageId, from: 'human', outcome: 'withdrawn', detail: 'withdrawn by the sender before delivery' }],
      ['b', 'withdraw', { from: 'human', messageId: r.messageId }],
    ]);
  });

  it('caps the logged text at 32,000 characters and marks it cut', async () => {
    await deliver(m.mgr, 'a', 'b', 'x'.repeat(32_001));
    const [, , data] = m.events.find(([, type]) => type === 'send')!;
    expect(data).toMatchObject({ text: 'x'.repeat(32_000), textCut: true });
  });

  it('logs settle once when a queued message delivers or expires, never for an immediate delivery', async () => {
    await deliver(m.mgr, 'a', 'b', 'at once');
    expect(m.events.map(([, type]) => type)).toEqual(['send']);
    m.set('p', { state: 'working' });
    const q = await deliver(m.mgr, 'a', 'p', 'later');
    const e = await deliver(m.mgr, 'b', 'p', 'never');
    m.set('p', { state: 'done', doneSource: 'stop' }); // delivers the first; the turn it starts holds the second until it expires
    await vi.advanceTimersByTimeAsync(QUEUE_TTL_MS);
    expect(m.events.filter(([, type]) => type === 'settle')).toEqual([
      ['p', 'settle', { messageId: q.messageId, from: 'a', outcome: 'delivered' }],
      ['p', 'settle', { messageId: e.messageId, from: 'b', outcome: 'expired', detail: 'target never became idle within 5 min' }],
    ]);
  });

  it('logs the settle in the target\'s tree directory, kept at send time, once the target is closed', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tl-tree-'));
    try {
      Object.assign(m, { sessionDirOf: () => dir });
      inbox(m.mgr, 'b');
      const r = await deliver(m.mgr, 'human', 'b', 'hi');
      m.nodes.delete('b');
      m.emit('removed', 'b');
      await flushEvents();
      const lines = readFileSync(join(dir, 'events.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
      expect(lines).toEqual([{ ts: expect.any(Number), type: 'settle', id: 'b', messageId: r.messageId, from: 'human', outcome: 'gone', detail: 'target was closed' }]);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('keeps the text and label of a refused send out of the log', async () => {
    await deliver(m.mgr, 'a', 'a', 'to myself', { fromLabel: 'forged (p)' });
    expect(m.events).toEqual([['a', 'send', { from: 'a', outcome: 'refused', messageId: expect.stringMatching(/^m-/) }]]);
  });

  it('station notices name the child they concern', async () => {
    startNotices(m.mgr);
    m.set('a', { exited: true });
    await vi.advanceTimersByTimeAsync(0);
    expect(m.events.find(([, type]) => type === 'send')).toEqual(['p', 'send', expect.objectContaining({ from: 'tiller', label: 'tiller (child a "T-a" stopped: exited)', about: ['a'] })]);
  });
});

describe('station notices', () => {
  it('first tells an errored child once to continue, then notifies the parent on the next error; a clean Stop re-arms', async () => {
    startNotices(m.mgr);
    const pasted = () => m.sessions.get('p')!.pasted, child = () => m.sessions.get('a')!.pasted;
    m.set('a', { state: 'done', errored: true, doneSource: 'stop', changedAt: 1 });
    await vi.advanceTimersByTimeAsync(0);
    expect(child()).toHaveLength(1);
    expect(child()[0]).toMatch(/\nfrom: tiller \(your turn errored\)\nreply-to: none\nYour last turn ended with an error\. Continue where you left off\.\n/);
    expect(pasted()).toHaveLength(0);
    m.set('a', { state: 'done', errored: true, doneSource: 'stop', changedAt: 1 }); // other events on the same error do nothing
    await vi.advanceTimersByTimeAsync(0);
    expect(child()).toHaveLength(1);
    expect(pasted()).toHaveLength(0);
    m.set('a', { state: 'done', errored: true, doneSource: 'stop', changedAt: 2 }); // the continued turn errored too
    await vi.advanceTimersByTimeAsync(0);
    expect(child()).toHaveLength(1);
    expect(pasted()).toHaveLength(1);
    expect(pasted()[0]).toMatch(/\nfrom: tiller \(child a "T-a" stopped: turn-errored\)\nreply-to: none\n/);
    m.set('a', { state: 'done', errored: true, changedAt: 3 }); // still the same episode: nothing more
    await vi.advanceTimersByTimeAsync(0);
    expect(pasted()).toHaveLength(1);
    m.set('p', { state: 'done', doneSource: 'stop' }); // parent finished handling the first notice
    m.set('a', { state: 'working', errored: undefined });
    m.set('a', { state: 'done', errored: undefined, doneSource: 'idle_prompt' }); // not a verified Stop: no re-arm
    m.set('a', { state: 'done', errored: true, doneSource: 'stop', changedAt: 4 });
    await vi.advanceTimersByTimeAsync(0);
    expect(pasted()).toHaveLength(1);
    m.set('a', { state: 'done', errored: undefined, doneSource: 'stop' }); // clean Stop re-arms: the retry comes first again
    m.set('a', { state: 'done', errored: true, changedAt: 5 });
    await vi.advanceTimersByTimeAsync(0);
    expect(child()).toHaveLength(2);
    expect(pasted()).toHaveLength(1);
  });

  it('tells the parent of the turn error when the queued "continue" message expires', async () => {
    startNotices(m.mgr);
    inbox(m.mgr, 'a'); // a's mod is live, so the retry message queues in its inbox
    m.set('a', { state: 'done', errored: true, doneSource: 'stop', changedAt: 1 });
    await vi.advanceTimersByTimeAsync(0);
    expect(inbox(m.mgr, 'a')[0].text).toContain('Continue where you left off');
    expect(m.sessions.get('p')!.pasted).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(m.sessions.get('p')!.pasted[0]).toMatch(/\nfrom: tiller \(child a "T-a" stopped: turn-errored\)\n/);
  });

  it('tells the parent once when a working child stalls, again only after activity resumes', async () => {
    startNotices(m.mgr);
    const pasted = () => m.sessions.get('p')!.pasted;
    m.set('a', { state: 'working', activity: 'Bash: npm test', stalled: true, changedAt: Date.now() - 7 * 60_000 });
    await vi.advanceTimersByTimeAsync(0);
    expect(pasted()).toHaveLength(1);
    expect(pasted()[0]).toMatch(/\nfrom: tiller \(child a "T-a" no activity\)\nreply-to: none\nNo hook event for 7m while working; last activity: Bash: npm test\.\n/);
    m.set('p', { state: 'done', doneSource: 'stop' });
    m.set('a', { activity: 'Bash: npm test' }); // still stalled
    await vi.advanceTimersByTimeAsync(0);
    expect(pasted()).toHaveLength(1);
    m.set('a', { stalled: undefined, changedAt: Date.now() }); // a hook event cleared it
    m.set('a', { stalled: true });
    await vi.advanceTimersByTimeAsync(0);
    expect(pasted()).toHaveLength(2);
  });

  it('notifies on exit, and after 15 minutes of waiting; never for blocked', async () => {
    startNotices(m.mgr);
    m.set('a', { state: 'blocked' });
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    expect(m.sessions.get('p')!.pasted).toHaveLength(0);
    m.set('b', { state: 'waiting' });
    await vi.advanceTimersByTimeAsync(15 * 60_000);
    expect(m.sessions.get('p')!.pasted[0]).toContain('stopped: question-unanswered');
    m.set('p', { state: 'done', doneSource: 'stop' });
    m.set('a', { exited: true });
    await vi.advanceTimersByTimeAsync(0);
    expect(m.sessions.get('p')!.pasted[1]).toContain('child a "T-a" stopped: exited');
  });
});
