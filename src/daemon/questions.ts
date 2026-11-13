import { randomBytes } from 'node:crypto';
import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { isAgentKind, type AnswerDelivery, type DigestItem, type NodeView, type Question, type SendResult } from '../shared/protocol.js';
import { isOpen, sortQuestions } from '../shared/questions.js';
import type { NodeManager } from './manager.js';
import { DAEMON, deliver, HUMAN, isDescendant, messageStatus, withdraw } from './messaging.js';
import { appendEvent, sessionDir } from './sessions.js';
import { logError } from './util.js';

/** Open questions one owner may hold at a time. */
export const OPEN_CAP = 5;
/** Resolved questions stay in questions.json this long after resolvedAt. */
const KEEP_MS = 7 * 24 * 3600_000;
/** Resolved questions the snapshot and list_questions still show. */
const RECENT_MS = 24 * 3600_000;
/** Spacing between pushes of an answer that did not get through. */
const RETRY_MS = 30_000;
/** Question context kept in an `ask` event. */
const LOG_CONTEXT_CHARS = 2000;
const STATES = ['open', 'answered', 'dismissed', 'withdrawn'];

/** What the daemon keeps beyond the Question that clients see. */
interface StoredQuestion extends Question {
  /** The asker's ancestors when it asked, nearest first. parentId never changes, so this stays true. */
  path: string[];
  /** When the answer was last pushed, to space retries. */
  triedAt?: number;
}

export interface AskRequest { question: string; context?: string; choices?: string[]; assumption?: string; replaces?: string }

const pub = ({ path, triedAt, ...q }: StoredQuestion): Question => q;
const wellFormed = (q: unknown): q is StoredQuestion => {
  const x = q as Partial<StoredQuestion> | null;
  return typeof x?.id === 'string' && typeof x.rootId === 'string' && typeof x.nodeId === 'string' && typeof x.question === 'string'
    && typeof x.askedBy?.id === 'string' && typeof x.askedAt === 'number' && STATES.includes(x.state as string)
    && Array.isArray(x.path) && x.path.every((p) => typeof p === 'string');
};
/** An answer the owner has not accepted yet, so it follows the question to a new owner. */
const undelivered = (q: StoredQuestion) => q.state === 'answered' && (q.delivery?.state === 'waiting' || q.delivery?.state === 'queued');

/**
 * Questions agents raised for the human with ask_human, kept in <home>/questions.json so they outlive restarts. The
 * human's answer is stored first, then announced to the owner as an ordinary message. See docs/design/human-questions.md.
 * Emits 'question' (q: Question, isNew: boolean) on the manager for every change.
 */
export class Questions {
  private items: StoredQuestion[] = [];
  private readonly file: string;
  /** Answers being pushed to their owner, by question id. */
  private pushing = new Map<string, Promise<void>>();
  private retryTimer?: NodeJS.Timeout;
  /** Settles once the queued answers a previous daemon left have been reconciled. */
  readonly ready: Promise<void>;

  constructor(private m: NodeManager) {
    this.file = join(m.home, 'questions.json');
    this.load();
    m.on('removed', (id: string) => this.ownerClosed(id));
    m.on('node', (v: NodeView) => this.retryFor(v.id));
    this.ready = this.reconcile().catch(logError);
  }

  // ---- reading ----

  /** For the snapshot: every open question, and those resolved in the last 24 hours. */
  recent(): Question[] { return this.visibleTo(HUMAN); }

  /** For list_questions: a node's own and its descendants', everything for the human. Open first. */
  visibleTo(caller: string, all = false): Question[] {
    const cut = Date.now() - RECENT_MS;
    const mine = caller === HUMAN ? this.items : this.items.filter((q) => q.nodeId === caller || isDescendant(this.m, caller, q.nodeId));
    return sortQuestions(mine.filter((q) => all || isOpen(q) || (q.resolvedAt ?? 0) >= cut).map(pub));
  }

  /** For the away digest: open questions asked at or after `since`. */
  digest(since: number): DigestItem[] {
    return this.items.filter((q) => isOpen(q) && q.askedAt >= since)
      .map((q) => ({ id: q.nodeId, title: q.askedBy.title, kind: 'needsYou' as const, text: `Asks: ${q.question}`, at: q.askedAt, questionId: q.id }));
  }

  /** Resolves once the answer to `id` has been handed to its owner (or has failed to be). */
  delivered(id: string): Promise<void> { return this.pushing.get(id) ?? Promise.resolve(); }

  get(id: string): Question | undefined {
    const q = this.items.find((x) => x.id === id);
    return q && pub(q);
  }

  // ---- changing ----

  /** `caller` asks the human. An identical open question of the caller's is returned instead (replayed). */
  ask(caller: string, req: AskRequest): { question: Question; replayed: boolean } {
    const v = this.m.view(caller);
    if (!v || !isAgentKind(v.kind)) throw new Error('only an agent node can ask the human');
    const mine = this.items.filter((q) => q.nodeId === caller && isOpen(q));
    const same = mine.find((q) => q.question === req.question);
    if (same) return { question: pub(same), replayed: true };
    if (req.choices && new Set(req.choices).size !== req.choices.length) throw new Error('choices must all be different');
    const old = req.replaces ? this.items.find((q) => q.id === req.replaces) : undefined;
    if (req.replaces && old?.nodeId !== caller) throw new Error(old ? `${req.replaces} is not your question` : `no such question: ${req.replaces}`);
    const replacing = old && isOpen(old) ? old : undefined;
    if (mine.length - (replacing ? 1 : 0) >= OPEN_CAP) {
      throw new Error(`you have ${OPEN_CAP} open questions (${mine.map((q) => q.id).join(', ')}): withdraw one, or wait for an answer`);
    }
    const now = Date.now();
    const q: StoredQuestion = {
      id: this.newId(), rootId: this.m.rootIdOf(caller), nodeId: caller, askedBy: { id: caller, title: v.title }, question: req.question,
      ...(req.context ? { context: req.context } : {}), ...(req.choices ? { choices: req.choices } : {}), ...(req.assumption ? { assumption: req.assumption } : {}),
      state: 'open', askedAt: now, path: this.m.registry.lineage(caller).map((n) => n.id),
    };
    this.commit(() => {
      this.items.push(q);
      if (replacing) Object.assign(replacing, { state: 'withdrawn', resolvedAt: now, withdrawn: { by: caller, reason: `replaced by ${q.id}` }, replacedBy: q.id });
    });
    this.log(q, 'ask', { question: q.question, ...(q.choices ? { choices: q.choices } : {}), ...(q.assumption ? { assumption: q.assumption } : {}),
      ...(q.context ? { context: q.context.slice(0, LOG_CONTEXT_CHARS), ...(q.context.length > LOG_CONTEXT_CHARS ? { contextCut: true } : {}) } : {}),
      ...(replacing ? { replaces: replacing.id } : {}) });
    if (replacing) {
      this.log(replacing, 'ask_withdraw', { by: caller, reason: replacing.withdrawn?.reason });
      this.announce(replacing);
    }
    this.announce(q, true);
    return { question: pub(q), replayed: false };
  }

  /**
   * The owner or an ancestor of it takes a question back. One that is no longer open is returned as it is, not refused, so
   * a caller that raced the human can read the answer.
   */
  withdraw(caller: string, id: string, reason?: string): Question {
    if (caller === HUMAN) throw new Error('refused: use dismiss; the human does not withdraw questions');
    const q = this.require(id);
    if (q.nodeId !== caller && !isDescendant(this.m, caller, q.nodeId)) throw new Error(`refused: ${id} is not yours or a descendant's`);
    if (!isOpen(q)) return pub(q);
    this.commit(() => Object.assign(q, { state: 'withdrawn', resolvedAt: Date.now(), withdrawn: { by: caller, ...(reason ? { reason } : {}) } }));
    this.log(q, 'ask_withdraw', { by: caller, ...(reason ? { reason } : {}) });
    this.announce(q);
    return pub(q);
  }

  /** The human answers with a choice, text or both; the answer then goes to the owner. */
  answer(id: string, a: { choice?: string; text?: string }): Question {
    const q = this.require(id);
    if (!isOpen(q)) throw new Error(this.closedReason(q));
    if (a.choice === undefined && a.text === undefined) throw new Error('an answer needs a choice or text');
    if (a.choice !== undefined && !q.choices?.includes(a.choice)) throw new Error(q.choices ? `${a.choice} is not one of the choices of ${id}` : `${id} has no choices`);
    const now = Date.now();
    this.commit(() => Object.assign(q, {
      state: 'answered', resolvedAt: now, answer: { ...(a.choice !== undefined ? { choice: a.choice } : {}), ...(a.text !== undefined ? { text: a.text } : {}), at: now },
      delivery: { state: 'waiting', detail: 'not sent yet', at: now },
    }));
    this.log(q, 'ask_answer', { ...(a.choice !== undefined ? { choice: a.choice } : {}), ...(a.text !== undefined ? { text: a.text } : {}) });
    this.announce(q);
    void this.push(id);
    return pub(q);
  }

  /** The human takes a question off the list. The agent is not told. */
  dismiss(id: string): Question {
    const q = this.require(id);
    if (!isOpen(q)) throw new Error(this.closedReason(q));
    this.commit(() => Object.assign(q, { state: 'dismissed', resolvedAt: Date.now() }));
    this.log(q, 'ask_dismiss');
    this.announce(q);
    return pub(q);
  }

  // ---- delivering the answer ----

  /** Send the answer to its owner now, unless one is on its way, the owner is not running or it was sent. */
  private push(id: string): Promise<void> {
    const q = this.items.find((x) => x.id === id);
    const busy = this.pushing.get(id);
    if (busy || !q || q.state !== 'answered' || q.delivery?.state !== 'waiting') return busy ?? Promise.resolve();
    const owner = this.m.view(q.nodeId);
    if (!owner || owner.status.exited || owner.status.state === 'armed' || owner.status.state === 'queued') {
      this.setDelivery(q, { outcome: 'gone', retryable: true, detail: 'the node is not running' }, false);
      return Promise.resolve();
    }
    q.triedAt = Date.now();
    const p = this.send(q).catch(logError).finally(() => this.pushing.delete(id));
    this.pushing.set(id, p);
    return p;
  }

  private async send(q: StoredQuestion): Promise<void> {
    const { id, nodeId } = q;
    // deliver settles an immediate outcome before it returns, and a queued one possibly before this function resumes.
    const sent: { id?: string; early?: SendResult } = {};
    const first = await deliver(this.m, DAEMON, nodeId, this.body(q), {
      fromLabel: `human (answer to ${id})`, replyTo: null, about: [nodeId],
      onSettle: (r) => { if (sent.id) this.settled(id, sent.id, r); else sent.early = r; },
    }).catch((err: Error): SendResult => ({ outcome: 'refused', retryable: true, detail: err.message }));
    sent.id = first.messageId;
    const now = this.items.find((x) => x.id === id);
    if (now?.nodeId === nodeId && now.delivery?.state === 'waiting') this.setDelivery(now, sent.early ?? first);
  }

  /** A queued answer reached its final outcome. */
  private settled(id: string, messageId: string, r: SendResult): void {
    const q = this.items.find((x) => x.id === id);
    if (q?.delivery?.messageId === messageId) this.setDelivery(q, r);
  }

  /** Record how `deliver` went, per the table in the design: only stalled is not retried, and queued waits for its settle. */
  private setDelivery(q: StoredQuestion, r: SendResult, tried = true): void {
    const at = Date.now();
    const detail = r.detail ? { detail: r.detail } : {};
    const d: AnswerDelivery = r.outcome === 'delivered' ? { state: 'delivered', messageId: r.messageId, at }
      : r.outcome === 'queued' ? { state: 'queued', messageId: r.messageId, ...detail, at }
      : r.outcome === 'stalled' ? { state: 'unconfirmed', messageId: r.messageId, ...detail, at }
      : { state: 'waiting', detail: r.detail ?? r.outcome, at };
    if (!tried && q.delivery?.state === 'waiting' && q.delivery.detail === d.detail) return; // nothing new to say
    q.delivery = d;
    this.save();
    this.announce(q);
    this.arm();
  }

  private due = (q: StoredQuestion) => q.state === 'answered' && q.delivery?.state === 'waiting' && Date.now() - (q.triedAt ?? 0) >= RETRY_MS;

  /** The owner's node changed (it may have started running): push its waiting answers that were last tried 30 s ago or more. */
  private retryFor(nodeId: string): void {
    for (const q of this.items) if (q.nodeId === nodeId && this.due(q)) void this.push(q.id);
  }

  /** While any answer waits, look again every 30 s. */
  private arm(): void {
    if (this.retryTimer || !this.items.some((q) => q.state === 'answered' && q.delivery?.state === 'waiting')) return;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = undefined;
      for (const q of this.items) if (this.due(q)) void this.push(q.id);
      this.arm();
    }, RETRY_MS);
    this.retryTimer.unref();
  }

  private body(q: StoredQuestion): string {
    const title = q.askedBy.title.replace(/\s+/g, ' ');
    const head = q.askedBy.id === q.nodeId ? `The human answered your question ${q.id}.`
      : `The human answered question ${q.id}, asked by ${q.askedBy.id} "${title}", which has since closed. You are its nearest live ancestor, so the answer comes to you.`;
    return [head, `Question: ${q.question}`, q.answer?.choice !== undefined && `Choice: ${q.answer.choice}`, q.answer?.text !== undefined && `Answer: ${q.answer.text}`].filter(Boolean).join('\n');
  }

  // ---- restarts and closed owners ----

  /**
   * Answers a previous daemon had queued: its onSettle callbacks are gone. Take each message back; if the owner's bridge had
   * already claimed it, the delivery is unconfirmed, otherwise it is sent again.
   */
  private async reconcile(): Promise<void> {
    for (const q of this.items.filter((x) => x.state === 'answered' && x.delivery?.state === 'queued' && x.delivery.messageId)) {
      const messageId = q.delivery!.messageId!;
      await withdraw(this.m, DAEMON, messageId).catch(() => {});
      const r = messageStatus(this.m, HUMAN, messageId);
      this.setDelivery(q, r?.outcome === 'queued' ? { ...r, outcome: 'stalled', detail: 'claimed by the node before the daemon restarted; delivery unconfirmed' } : r ?? { outcome: 'withdrawn', retryable: true, detail: 'the daemon restarted before the answer was delivered' }, false);
      if (q.delivery?.state === 'waiting') q.triedAt = undefined;
    }
    for (const q of this.items) if (q.delivery?.state === 'waiting') void this.push(q.id);
    this.arm();
  }

  /** A node is gone: its open questions and undelivered answers go to its nearest live ancestor, else end. */
  private ownerClosed(id: string): void {
    const moving = this.items.filter((q) => q.nodeId === id && (isOpen(q) || undelivered(q)));
    if (!moving.length) return;
    const now = Date.now();
    for (const q of moving) {
      const to = q.path.find((p) => this.m.registry.get(p));
      if (to) {
        Object.assign(q, { nodeId: to });
        if (q.state === 'answered') q.delivery = { state: 'waiting', detail: `${id} was closed`, at: now };
        this.log(q, 'ask_move', { from: id, to });
      } else if (isOpen(q)) {
        Object.assign(q, { state: 'withdrawn', resolvedAt: now, withdrawn: { by: 'tiller', reason: 'the node that asked was closed' } });
        this.log(q, 'ask_withdraw', { by: 'tiller', reason: 'the node that asked was closed' });
      } else q.delivery = { state: 'dropped', detail: 'the node that asked was closed and no ancestor is left', at: now };
      q.triedAt = undefined;
    }
    this.save();
    for (const q of moving) {
      this.announce(q);
      if (q.delivery?.state === 'waiting') void this.push(q.id);
    }
    this.arm();
  }

  // ---- storage ----

  private load(): void {
    let raw: string;
    try { raw = readFileSync(this.file, 'utf8'); } catch { return; } // no file yet
    try {
      const data = JSON.parse(raw);
      if (data?.version !== 1 || !Array.isArray(data.items) || !data.items.every(wellFormed)) throw new Error('bad shape');
      this.items = data.items;
    } catch (err) {
      logError(`questions.json is unreadable (${(err as Error).message}); set aside as questions.json.corrupt-*`);
      try { renameSync(this.file, `${this.file}.corrupt-${Date.now()}`); } catch { /* best effort */ }
      return;
    }
    // An owner that vanished while the daemon was down (state.json lost, say) is a closed owner.
    for (const id of new Set(this.items.map((q) => q.nodeId))) if (!this.m.registry.get(id)) this.ownerClosed(id);
  }

  /** Drop what has been resolved for 7 days, then write the file at once: a call that replied "recorded" is on disk. */
  private write(): void {
    const cut = Date.now() - KEEP_MS;
    this.items = this.items.filter((q) => isOpen(q) || (q.resolvedAt ?? q.askedAt) >= cut);
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify({ version: 1, items: this.items }));
    renameSync(tmp, this.file);
  }

  /** Apply a change and write it; when the write fails, put the memory back so it agrees with the disk, and throw. */
  private commit(change: () => void): void {
    const before = structuredClone(this.items);
    try { change(); this.write(); } catch (err) { this.items = before; throw err; }
  }

  /** For changes nobody is waiting on (delivery progress): a failed write is logged, and the next write carries it. */
  private save(): void {
    try { this.write(); } catch (err) { logError(err); }
  }

  // ---- helpers ----

  private require(id: string): StoredQuestion {
    const q = this.items.find((x) => x.id === id);
    if (!q) throw new Error(`no such question: ${id}`);
    return q;
  }

  private newId(): string {
    let id: string;
    do id = `q-${randomBytes(4).toString('hex')}`; while (this.items.some((q) => q.id === id));
    return id;
  }

  private closedReason(q: StoredQuestion): string {
    if (q.state !== 'withdrawn') return `${q.id} was already ${q.state}`;
    if (q.replacedBy) return `${q.id} was replaced by ${q.replacedBy}`;
    const by = q.withdrawn?.by;
    const who = by === 'tiller' ? 'tiller' : by === q.askedBy.id || by === q.nodeId ? 'the agent' : by;
    return `${q.id} was withdrawn by ${who}${q.withdrawn?.reason ? `: ${q.withdrawn.reason}` : ''}`;
  }

  /** Into the tree's events.jsonl by the rootId stored on the question: the owner's own tree may be gone. `id` is the owner. */
  private log(q: StoredQuestion, type: string, data: Record<string, unknown> = {}): void {
    appendEvent(sessionDir(this.m.home, q.rootId), { ts: Date.now(), type, id: q.nodeId, title: this.m.registry.get(q.nodeId)?.title ?? q.askedBy.title, questionId: q.id, ...data });
  }

  private announce(q: StoredQuestion, isNew = false): void {
    this.m.emit('question', pub(q), isNew);
  }
}
