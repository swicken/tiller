import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NodeStatus, NodeView, Question } from '../shared/protocol.js';
import type { NodeManager } from './manager.js';
import { claim, flushInbox, inbox, messageStatus } from './messaging.js';
import { classify, composerTextOf } from './pty.js';
import { OPEN_CAP, Questions } from './questions.js';
import { flushEvents, readEvents, sessionDir } from './sessions.js';

/** An idle Claude screen: Claude's prompt character is U+276F. */
const RULE = String.fromCodePoint(0x2500).repeat(18);
const PROMPT = ['some output', `${RULE} n-b`, `${String.fromCodePoint(0x276f)} `, RULE];
const DAY = 24 * 3600_000;

class FakeSession {
  pasted: string[] = [];
  ack = true;
  constructor(private mgr: FakeManager, private id: string) {}
  async flush() {}
  classifyScreen() { return classify(PROMPT); }
  composerText() { return composerTextOf(PROMPT); }
  async paste(text: string) {
    this.pasted.push(text);
    if (this.ack) {
      this.mgr.emit('hook', this.id, { hook_event_name: 'UserPromptSubmit', prompt: `[Pasted text] ${text}` });
      this.mgr.set(this.id, { state: 'working', doneSource: undefined });
    }
  }
}

/** The parts of NodeManager that Questions and messaging use. */
class FakeManager extends EventEmitter {
  nodes = new Map<string, NodeView>();
  sessions = new Map<string, FakeSession>();
  runtimes = new Map<string, { busy?: string }>();
  draining = false;
  constructor(public home: string) { super(); }
  view = (id: string) => this.nodes.get(id);
  session = (id: string) => this.sessions.get(id) as never;
  projectDir = (n: { cwd: string }) => n.cwd;
  input = () => {};
  logEvent = () => {};
  rootIdOf = (id: string): string => {
    let n = this.nodes.get(id);
    while (n?.parentId && this.nodes.has(n.parentId)) n = this.nodes.get(n.parentId);
    return n?.id ?? id;
  };
  sessionDirOf = (id: string) => sessionDir(this.home, this.rootIdOf(id));
  registry = {
    get: (id: string) => this.nodes.get(id),
    lineage: (id: string) => {
      const out: NodeView[] = [];
      for (let p = this.nodes.get(id)?.parentId; p && this.nodes.get(p); p = this.nodes.get(p)?.parentId) out.push(this.nodes.get(p)!);
      return out;
    },
  };
  add(id: string, parentId: string | null, status: Partial<NodeStatus> = {}) {
    this.nodes.set(id, { id, parentId, kind: 'claude', title: `T-${id}`, cwd: '/', createdAt: 0, unread: false, status: { state: 'done', doneSource: 'stop', changedAt: 0, ...status } });
    this.sessions.set(id, new FakeSession(this, id));
  }
  set(id: string, patch: Partial<NodeStatus>) {
    const v = this.nodes.get(id)!;
    v.status = { ...v.status, ...patch };
    this.emit('node', v);
  }
  remove(id: string) {
    this.nodes.delete(id);
    this.sessions.delete(id);
    this.emit('removed', id);
  }
  get manager() { return this as unknown as NodeManager; }
}

let home: string;
let m: FakeManager;
let qs: Questions;
let changes: [Question, boolean][];

/** A tree r > w > g, with s a sibling of w. */
const tree = (fm: FakeManager) => {
  fm.add('r', null);
  fm.add('w', 'r');
  fm.add('g', 'w');
  fm.add('s', 'r');
};
const ask = (caller: string, question: string, extra = {}) => qs.ask(caller, { question, ...extra }).question;
const pasted = (id: string) => m.sessions.get(id)!.pasted;

beforeEach(() => {
  vi.useFakeTimers();
  home = mkdtempSync(join(tmpdir(), 'tl-questions-'));
  mkdirSync(sessionDir(home, 'r'), { recursive: true });
  changes = [];
  m = new FakeManager(home);
  tree(m);
  m.on('question', (q: Question, isNew: boolean) => changes.push([q, isNew]));
  qs = new Questions(m.manager);
});
afterEach(() => {
  vi.useRealTimers();
  rmSync(home, { recursive: true, force: true });
});

describe('asking', () => {
  it('stores the question, writes the file and announces it; a new manager on the same home loads it', async () => {
    const q = ask('w', 'Which region?', { choices: ['eu', 'us'], assumption: 'eu', context: 'line one\nline two' });
    expect(q).toMatchObject({ id: expect.stringMatching(/^q-[0-9a-f]{8}$/), rootId: 'r', nodeId: 'w', askedBy: { id: 'w', title: 'T-w' }, state: 'open', choices: ['eu', 'us'], assumption: 'eu' });
    expect(changes).toEqual([[q, true]]);
    const stored = JSON.parse(readFileSync(join(home, 'questions.json'), 'utf8'));
    expect(stored).toMatchObject({ version: 1, items: [{ id: q.id, path: ['r'] }] });
    expect(JSON.stringify(qs.recent())).not.toContain('"path"'); // clients never see it

    const m2 = new FakeManager(home);
    tree(m2);
    expect(new Questions(m2.manager).recent()).toEqual([q]);
    await flushEvents();
    expect(readEvents(sessionDir(home, 'r')).find((e) => e.type === 'ask')).toMatchObject({ id: 'w', questionId: q.id, question: 'Which region?', context: 'line one\nline two' });
  });

  it('keeps the title of the tree\'s root as it was when asked, for display after the session is gone', () => {
    const q = ask('g', 'Whose session?');
    expect(q.rootTitle).toBe('T-r');
    m.nodes.get('r')!.title = 'renamed later';
    m.remove('g');
    expect(qs.get(q.id)?.rootTitle).toBe('T-r');
    expect(ask('r', 'Root asking').rootTitle).toBe('renamed later'); // a root's own session
  });

  it('returns the same open question when it is asked again, and refuses a sixth', () => {
    const first = ask('w', 'Same?');
    expect(qs.ask('w', { question: 'Same?' })).toEqual({ question: first, replayed: true });
    expect(qs.recent()).toHaveLength(1);
    const ids = [first.id, ...[2, 3, 4, 5].map((i) => ask('w', `Q${i}`).id)];
    expect(() => ask('w', 'Q6')).toThrow(`you have ${OPEN_CAP} open questions (${ids.join(', ')})`);
    expect(ask('r', 'Another node has its own five').nodeId).toBe('r');
  });

  it('refuses duplicate choices and a caller that is not a node', () => {
    expect(() => ask('w', 'Dup?', { choices: ['a', 'a'] })).toThrow('choices must all be different');
    expect(() => ask('human', 'Me?')).toThrow('only an agent node');
  });

  it('replaces withdraws the old question and links it, in one step', () => {
    const old = ask('w', 'First wording?');
    const next = ask('w', 'Better wording?', { replaces: old.id });
    expect(qs.get(old.id)).toMatchObject({ state: 'withdrawn', withdrawn: { by: 'w', reason: `replaced by ${next.id}` }, replacedBy: next.id });
    expect(qs.get(next.id)?.state).toBe('open');
    expect(changes.map(([q, isNew]) => [q.id, isNew])).toEqual([[old.id, true], [old.id, false], [next.id, true]]);
  });

  it('replaces at the cap frees its slot, still creates the new question for a resolved target, and refuses one that is not yours', () => {
    const ids = [1, 2, 3, 4, 5].map((i) => ask('w', `Q${i}`).id);
    expect(ask('w', 'Q6', { replaces: ids[0] }).state).toBe('open');
    qs.dismiss(ids[1]);
    expect(ask('w', 'After a dismissal', { replaces: ids[1] }).state).toBe('open'); // a resolved target is no obstacle
    expect(() => ask('s', 'Mine now', { replaces: ids[2] })).toThrow(`${ids[2]} is not your question`);
    expect(() => ask('s', 'Ghost', { replaces: 'q-00000000' })).toThrow('no such question');
  });

  it('refuses and rolls back when the file cannot be written', () => {
    rmSync(home, { recursive: true, force: true }); // the directory is gone, so the write fails
    expect(() => ask('w', 'Lost?')).toThrow();
    expect(qs.recent()).toEqual([]);
    expect(changes).toEqual([]);
  });

  it('lists a node its own and its descendants\' questions, and the human all of them', () => {
    const own = ask('w', 'Mine');
    const below = ask('g', 'Below');
    const beside = ask('s', 'Beside');
    expect(qs.visibleTo('w').map((q) => q.id).sort()).toEqual([own.id, below.id].sort());
    expect(qs.visibleTo('g').map((q) => q.id)).toEqual([below.id]);
    expect(qs.visibleTo('human').map((q) => q.id).sort()).toEqual([own.id, below.id, beside.id].sort());
  });

  it('digest lists open questions asked at or after the time, as needs-you rows that name the question', () => {
    const old = ask('w', 'Old');
    vi.setSystemTime(Date.now() + 60_000);
    const fresh = ask('s', 'Fresh');
    expect(qs.digest(old.askedAt + 1)).toEqual([{ id: 's', title: 'T-s', kind: 'needsYou', text: 'Asks: Fresh', at: fresh.askedAt, questionId: fresh.id }]);
    qs.dismiss(fresh.id);
    expect(qs.digest(0).map((d) => d.questionId)).toEqual([old.id]);
  });
});

describe('answering', () => {
  it('validates the answer, refuses a resolved question with its state, and delivers it as the human', async () => {
    const q = ask('w', 'Alias?', { choices: ['Keep', 'Drop'] });
    expect(() => qs.answer(q.id, {})).toThrow('needs a choice or text');
    expect(() => qs.answer(q.id, { choice: 'Maybe' })).toThrow('not one of the choices');
    expect(() => qs.answer('q-00000000', { text: 'x' })).toThrow('no such question');
    const answered = qs.answer(q.id, { choice: 'Keep', text: 'until March' });
    expect(answered).toMatchObject({ state: 'answered', answer: { choice: 'Keep', text: 'until March' }, delivery: { state: 'waiting' } });
    await qs.delivered(q.id);
    expect(qs.get(q.id)?.delivery).toMatchObject({ state: 'delivered', messageId: expect.stringMatching(/^m-/) });
    expect(pasted('w')).toHaveLength(1);
    expect(pasted('w')[0]).toContain(`from: human (answer to ${q.id})`);
    expect(pasted('w')[0]).toContain(`The human answered your question ${q.id}.\nQuestion: Alias?\nChoice: Keep\nAnswer: until March`);
    expect(pasted('w')[0]).toContain('reply-to: none');
    expect(() => qs.answer(q.id, { text: 'again' })).toThrow(`${q.id} was already answered`);
    expect(() => qs.dismiss(q.id)).toThrow('already answered');
    await flushEvents();
    expect(readEvents(sessionDir(home, 'r')).find((e) => e.type === 'ask_answer')).toMatchObject({ questionId: q.id, choice: 'Keep', text: 'until March' });
  });

  it('refuses a choice for a question without choices, and says why a withdrawn or replaced question is refused', () => {
    const plain = ask('w', 'Free text?');
    expect(() => qs.answer(plain.id, { choice: 'x' })).toThrow('has no choices');
    qs.withdraw('w', plain.id, 'answered in chat');
    expect(() => qs.answer(plain.id, { text: 'late' })).toThrow(`${plain.id} was withdrawn by the agent: answered in chat`);
    const old = ask('w', 'v1');
    const next = ask('w', 'v2', { replaces: old.id });
    expect(() => qs.answer(old.id, { text: 'late' })).toThrow(`${old.id} was replaced by ${next.id}`);
  });

  it('dismissing sends nothing and keeps the agent unaware', async () => {
    const q = ask('w', 'Skip?');
    expect(qs.dismiss(q.id)).toMatchObject({ state: 'dismissed', resolvedAt: expect.any(Number) });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(pasted('w')).toEqual([]);
    expect(qs.get(q.id)?.delivery).toBeUndefined();
    expect(() => qs.answer(q.id, { text: 'late' })).toThrow('already dismissed');
  });

  it('queues the answer while the owner works and records delivery once it is idle', async () => {
    m.set('w', { state: 'working' });
    const q = ask('w', 'Later?');
    qs.answer(q.id, { text: 'yes' });
    await qs.delivered(q.id);
    expect(qs.get(q.id)?.delivery).toMatchObject({ state: 'queued', messageId: expect.stringMatching(/^m-/) });
    expect(pasted('w')).toEqual([]);
    m.set('w', { state: 'done', doneSource: 'stop' });
    await vi.advanceTimersByTimeAsync(0);
    expect(qs.get(q.id)?.delivery?.state).toBe('delivered');
    expect(pasted('w')).toHaveLength(1);
  });

  it('an answer with no receipt becomes unconfirmed and is never sent again', async () => {
    m.sessions.get('w')!.ack = false; // the paste is never seen by the harness
    const q = ask('w', 'Hello?');
    qs.answer(q.id, { text: 'hi' });
    await vi.advanceTimersByTimeAsync(8000);
    expect(qs.get(q.id)?.delivery).toMatchObject({ state: 'unconfirmed' });
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    m.set('w', { state: 'done', doneSource: 'stop' });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(pasted('w')).toHaveLength(1);
  });

  it('keeps a refused answer waiting and retries it on the owner\'s next change, no sooner than 30 s after the last try', async () => {
    m.runtimes.set('w', { busy: 'changing harness' }); // deliver refuses, saying to retry
    const q = ask('w', 'Retry?');
    qs.answer(q.id, { text: 'yes' });
    await qs.delivered(q.id);
    expect(qs.get(q.id)?.delivery).toMatchObject({ state: 'waiting', detail: expect.stringContaining('changing harness') });
    m.runtimes.delete('w');
    m.set('w', { activity: 'x' }); // too soon
    await qs.delivered(q.id);
    expect(qs.get(q.id)?.delivery?.state).toBe('waiting');
    expect(pasted('w')).toEqual([]);
    vi.setSystemTime(Date.now() + 31_000);
    m.set('w', { activity: 'y' });
    await qs.delivered(q.id);
    expect(qs.get(q.id)?.delivery?.state).toBe('delivered');
    expect(pasted('w')).toHaveLength(1);
  });

  it('waits while the owner is not running, then sends when it runs; a 30 s timer covers a node that reports nothing', async () => {
    m.set('w', { exited: true });
    const q = ask('w', 'Anyone?');
    qs.answer(q.id, { text: 'yes' });
    await qs.delivered(q.id);
    expect(qs.get(q.id)?.delivery).toMatchObject({ state: 'waiting', detail: 'the node is not running' });
    m.set('w', { exited: false });
    await qs.delivered(q.id);
    expect(qs.get(q.id)?.delivery?.state).toBe('delivered');

    m.set('s', { exited: true });
    const q2 = ask('s', 'Timer?');
    qs.answer(q2.id, { text: 'yes' });
    m.nodes.get('s')!.status.exited = false; // running again, without a node event
    await vi.advanceTimersByTimeAsync(30_000);
    expect(qs.get(q2.id)?.delivery?.state).toBe('delivered');
  });
});

describe('withdrawing', () => {
  it('lets the owner and an ancestor of the owner withdraw, and refuses a sibling, a descendant and the human', () => {
    const [a, b, c, d] = ['A', 'B', 'C', 'D'].map((t) => ask('w', t));
    expect(qs.withdraw('w', a.id, 'moot')).toMatchObject({ state: 'withdrawn', withdrawn: { by: 'w', reason: 'moot' } });
    expect(qs.withdraw('r', b.id)).toMatchObject({ state: 'withdrawn', withdrawn: { by: 'r' } });
    expect(() => qs.withdraw('s', c.id)).toThrow('refused');
    expect(() => qs.withdraw('g', d.id)).toThrow('refused');
    expect(() => qs.withdraw('human', d.id)).toThrow('use dismiss');
    expect(qs.get(c.id)?.state).toBe('open');
  });

  it('returns an answered question with its answer instead of throwing, so a caller that raced the human reads it', () => {
    const q = ask('w', 'Raced?');
    qs.answer(q.id, { text: 'yes' });
    expect(qs.withdraw('w', q.id)).toMatchObject({ state: 'answered', answer: { text: 'yes' } });
  });
});

describe('a closed owner', () => {
  it('moves an open question to the nearest live ancestor, keeping who asked, and the answer goes there', async () => {
    const q = ask('g', 'Who answers?');
    m.remove('g');
    expect(qs.get(q.id)).toMatchObject({ nodeId: 'w', askedBy: { id: 'g', title: 'T-g' }, state: 'open' });
    m.remove('w'); // its path is [w, r]: w is gone too, so r
    expect(qs.get(q.id)?.nodeId).toBe('r');
    qs.answer(q.id, { text: 'me' });
    await qs.delivered(q.id);
    expect(pasted('r')[0]).toContain(`The human answered question ${q.id}, asked by g "T-g", which has since closed. You are its nearest live ancestor, so the answer comes to you.`);
    await flushEvents();
    expect(readEvents(sessionDir(home, 'r')).filter((e) => e.type === 'ask_move').map((e) => [e.from, e.to])).toEqual([['g', 'w'], ['w', 'r']]);
  });

  it('moves an answer that was not delivered yet, and leaves a delivered one', async () => {
    m.set('g', { exited: true });
    const waiting = ask('g', 'Waiting?');
    qs.answer(waiting.id, { text: 'a' });
    const sent = ask('s', 'Sent?');
    qs.answer(sent.id, { text: 'b' });
    await qs.delivered(sent.id);
    expect(qs.get(sent.id)?.delivery?.state).toBe('delivered');
    m.remove('g');
    m.remove('s');
    await qs.delivered(waiting.id);
    expect(qs.get(waiting.id)).toMatchObject({ nodeId: 'w', delivery: { state: 'delivered' } });
    expect(qs.get(sent.id)).toMatchObject({ nodeId: 's' });
  });

  it('withdraws an open question by tiller, and drops an undelivered answer, when no ancestor is left', () => {
    m.set('r', { exited: true });
    const open = ask('s', 'Open?');
    const answered = ask('r', 'Answered?');
    qs.answer(answered.id, { text: 'x' });
    expect(qs.get(answered.id)?.delivery).toMatchObject({ state: 'waiting' });
    m.remove('s');
    m.remove('w');
    m.remove('g');
    m.remove('r');
    expect(qs.get(open.id)).toMatchObject({ state: 'withdrawn', withdrawn: { by: 'tiller', reason: 'the node that asked was closed' } });
    expect(qs.get(answered.id)?.delivery?.state).toBe('dropped');
  });

  it('treats an owner missing at load as closed', () => {
    const q = ask('g', 'Gone?');
    const m2 = new FakeManager(home);
    m2.add('r', null); // g and w were lost with state.json
    expect(new Questions(m2.manager).get(q.id)).toMatchObject({ nodeId: 'r', state: 'open' });
  });
});

describe('the file', () => {
  it('is set aside when unreadable, and the daemon starts with no questions', () => {
    writeFileSync(join(home, 'questions.json'), '{ not json');
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(new Questions(m.manager).recent()).toEqual([]);
    expect(readdirSync(home).some((f) => f.startsWith('questions.json.corrupt-'))).toBe(true);
    expect(spy).toHaveBeenCalledWith('tiller:', expect.stringContaining('questions.json is unreadable'));
    spy.mockRestore();
  });

  it('is set aside when its shape is unknown', () => {
    writeFileSync(join(home, 'questions.json'), JSON.stringify({ version: 2, items: [] }));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(new Questions(m.manager).recent()).toEqual([]);
    expect(existsSync(join(home, 'questions.json'))).toBe(false);
    vi.restoreAllMocks();
  });

  it('drops resolved questions seven days after they were resolved on the next write, and keeps open ones', () => {
    const open = ask('w', 'Still open');
    const done = ask('w', 'Resolved');
    qs.dismiss(done.id);
    vi.setSystemTime(Date.now() + 7 * DAY + 1000);
    ask('w', 'Triggers a write');
    expect(qs.get(done.id)).toBeUndefined();
    expect(qs.get(open.id)?.state).toBe('open');
    expect(JSON.parse(readFileSync(join(home, 'questions.json'), 'utf8')).items.map((i: { id: string }) => i.id)).not.toContain(done.id);
  });

  it('shows resolved questions for 24 hours in recent and the list, and all of them with all', () => {
    const q = ask('w', 'Old news');
    qs.dismiss(q.id);
    vi.setSystemTime(Date.now() + DAY + 1000);
    expect(qs.recent()).toEqual([]);
    expect(qs.visibleTo('w')).toEqual([]);
    expect(qs.visibleTo('w', true).map((x) => x.id)).toEqual([q.id]);
  });
});

describe('after a daemon restart', () => {
  /** A daemon that queued an answer for `w` in its mod's inbox, then stopped. */
  const queuedAnswer = async (claimed: boolean) => {
    m.set('w', { state: 'working' });
    inbox(m.manager as never, 'w'); // w's mod is polling, so the answer waits in its inbox
    const q = ask('w', 'Before the restart?');
    qs.answer(q.id, { text: 'yes' });
    await qs.delivered(q.id);
    const { messageId } = qs.get(q.id)!.delivery!;
    expect(qs.get(q.id)?.delivery?.state).toBe('queued');
    if (claimed) expect(claim(m.manager as never, 'w', messageId!)).toBe(true);
    flushInbox(m.manager as never);
    const m2 = new FakeManager(home);
    tree(m2);
    m2.set('w', { state: 'working' });
    return { id: q.id, messageId: messageId!, m2 };
  };

  it('takes back an unclaimed queued answer and sends it again with a new message', async () => {
    const { id, messageId, m2 } = await queuedAnswer(false);
    const again = new Questions(m2.manager);
    await again.ready;
    await again.delivered(id);
    expect(messageStatus(m2.manager as never, 'human', messageId)?.outcome).toBe('withdrawn');
    const { delivery } = again.get(id)!;
    expect(delivery).toMatchObject({ state: 'queued', messageId: expect.stringMatching(/^m-/) });
    expect(delivery?.messageId).not.toBe(messageId);
  });

  it('marks a queued answer the node had already claimed as unconfirmed, and does not send it again', async () => {
    const { id, m2 } = await queuedAnswer(true);
    const again = new Questions(m2.manager);
    await again.ready;
    expect(again.get(id)?.delivery).toMatchObject({ state: 'unconfirmed' });
    expect(m2.sessions.get('w')!.pasted).toEqual([]);
  });
});
