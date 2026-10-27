import { randomBytes } from 'node:crypto';
import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fmtAge, noticeCut, outcomeLine } from '../shared/format.js';
import type { InboxMessage, NodeView, SendMode, SendResult } from '../shared/protocol.js';
import { loadConfig } from './config.js';
import { adapterFor } from './harness.js';
import { appendEvent } from './sessions.js';
import { CompletionWatches, type NotifyWhen } from './completion-watches.js';
import type { NodeManager } from './manager.js';
import { logError } from './util.js';

export const RATE_MS = 10_000;
/** Window for loop detection: limits.maxMessagesPer10Min per pair, and no identical body twice. */
const LOOP_MS = 10 * 60_000;
const RETRY_TEXT = 'Your last turn ended with an error. Continue where you left off.';
export const QUEUE_CAP = 16;
export const QUEUE_TTL_MS = 5 * 60_000;
/** Native Pi sends have no success/error return. Bound ambiguous claims even across adapter reload. */
export const PI_CONFIRM_MS = 60_000;
const RECEIPT_MS = 8000;
const WAITING_NOTICE_MS = 15 * 60_000;
const RETRY_MS = 1000;
const STATUS_TTL_MS = 3600_000;
/** A node is mod-live while its mod's last GET /inbox is this recent. */
const MOD_LIVE_MS = 5000;
const SAVE_MS = 50;
/** Message text kept in a `send` event; longer text is cut and the event marked `textCut`. */
const LOG_TEXT_CHARS = 32_000;
/** Caller ids that are not nodes. Both have full scope. */
export const HUMAN = 'human';
export const DAEMON = 'tiller';

export type Mgr = Pick<NodeManager, 'view' | 'session' | 'on' | 'off' | 'input' | 'logEvent' | 'projectDir'> & Partial<Pick<NodeManager, 'home' | 'runtimes' | 'draining' | 'sessionDirOf'>>;
interface DeliverOpts {
  /** "now" interrupts a working target and delivers at once; default "queue". */
  mode?: SendMode;
  /** Header after `from:`. Defaults to `<title> (<id>)` of the sender. */
  fromLabel?: string;
  /** Defaults to the sender's id; null prints `none`. */
  replyTo?: string | null;
  /** Called once with the final outcome (anything but queued). */
  onSettle?: (r: SendResult) => void;
  /** Queue in the target's inbox even before its mod polls, for a node that has just been resumed. */
  inbox?: boolean;
  /** The nodes a daemon notice concerns, recorded on its `send` event so each child's conversation can show it. */
  about?: string[];
  /** A notice the recipient no longer needs once it closes every node in `about` itself: dropNotices withdraws it while queued. */
  dropOnClose?: boolean;
}

// ---- scope (PLAN §5): self, ancestors, siblings, descendants ----

function ancestors(m: Mgr, id: string): string[] {
  const out: string[] = [];
  for (let p = m.view(id)?.parentId; p && !out.includes(p); p = m.view(p)?.parentId) out.push(p);
  return out;
}

export function isDescendant(m: Mgr, ancestor: string, id: string): boolean {
  return ancestors(m, id).includes(ancestor);
}

export function inScope(m: Mgr, caller: string, target: string): boolean {
  if (caller === HUMAN || caller === DAEMON || caller === target) return true;
  if (isDescendant(m, target, caller) || isDescendant(m, caller, target)) return true;
  const parent = m.view(caller)?.parentId;
  return !!parent && m.view(target)?.parentId === parent;
}

// ---- delivery ----

/** A target whose harness takes messages only through its mod's inbox (Pi): receipts come from its explicit ack, and a claim is a native submission. */
const nativeInbox = (v: NodeView | undefined): boolean => !!v && adapterFor(v).capabilities.inbox;

/** `steer`: the target's turn is interrupted for this message, so it goes ahead of the queue and its envelope says so. */
interface Entry { id: string; from: string; to: string; label: string; replyTo: string | null; text: string; steer?: boolean; timer?: NodeJS.Timeout }
/**
 * A message waiting in a mod-live node's inbox. `from` is the sender's node id; `msg.from` is the display label.
 * `claimed`: the mod is submitting it, so it can no longer be withdrawn. `since`: when its TTL started, when that was
 * not at enqueue (a restart that held it).
 */
interface InboxItem { to: string; from: string; msg: InboxMessage; claimed?: boolean; claimedAt?: number; since?: number; timer?: NodeJS.Timeout }
interface State {
  /** Mod-live nodes' last inbox poll, and the inbox itself (the queue for those nodes). */
  seen: Map<string, number>;
  inbox: Map<string, InboxItem[]>;
  inboxFile?: string;
  saveTimer?: NodeJS.Timeout;
  /** Deliveries are held for a restart; saved with the inbox so the next daemon gives held messages a fresh TTL. */
  held?: boolean;
  last: Map<string, number>;
  /** Per sender-target pair: messages accepted in the last LOOP_MS, and when the sender's parent was last told of a loop. */
  sent: Map<string, { at: number; text: string; id: string }[]>;
  loopNoticed: Map<string, number>;
  queues: Map<string, Entry[]>;
  locks: Map<string, Promise<unknown>>;
  /** Outcome of every message sent, for message_status. Pruned after STATUS_TTL_MS and when the sender is removed. */
  status: Map<string, Status>;
  /** Per-target timer that re-checks a verified-idle target whose screen was not ready yet. */
  retry: Map<string, NodeJS.Timeout>;
  /** Log a `settle` event when a queued message reaches its final outcome. */
  logSettle: (messageId: string, st: Status, r: SendResult) => void;
}
/** `dir`: the target's tree directory at send time, where a settle is logged once the target is closed. `dropOnClose`: the `about` of a dropOnClose notice. */
interface Status { from: string; to: string; result: SendResult; at: number; onSettle?: (r: SendResult) => void; dir?: string; dropOnClose?: string[] }
type Attempt = { result: SendResult } | { wait: string };

const states = new WeakMap<object, State>();

function stateOf(m: Mgr): State {
  let s = states.get(m);
  if (s) return s;
  // On the target's tree; once the target is closed it no longer maps to its tree, so on the directory kept at send time.
  const logSettle = (messageId: string, st: Status, r: SendResult) => {
    const data = { messageId, from: st.from, outcome: r.outcome, ...(r.detail ? { detail: r.detail } : {}) };
    if (m.view(st.to)) m.logEvent(st.to, 'settle', data);
    else if (st.dir) appendEvent(st.dir, { ts: Date.now(), type: 'settle', id: st.to, ...data });
  };
  const st: State = { seen: new Map(), inbox: new Map(), last: new Map(), sent: new Map(), loopNoticed: new Map(), queues: new Map(), locks: new Map(), status: new Map(), retry: new Map(), logSettle };
  states.set(m, st);
  const kick = (id: string) => { if (st.queues.get(id)?.length) drain(m, st, id).catch(logError); };
  if (m.home) loadInbox(m, st, join(m.home, 'inbox.json'));
  m.on('node', (v: NodeView) => kick(v.id));
  // The prompt entering is the delivery. Do not rely on the mod's /ack alone: a hot reload of the mod right after
  // it submits drops the callback that would ack, and the reloaded mod then submits the still-queued message again.
  m.on('hook', (id: string, ev: { hook_event_name?: string; prompt?: unknown }) => {
    if (ev.hook_event_name !== 'UserPromptSubmit') return;
    // Pi receipts must come from its exact native acceptance + explicit /ack, not a hook substring.
    // A late prompt from a retired claim must never revive its sender's delivery status.
    if (nativeInbox(m.view(id))) return;
    const prompt = String(ev.prompt ?? '');
    for (const i of [...(st.inbox.get(id) ?? [])]) if (prompt.includes(i.msg.text.split('\n', 1)[0])) ack(m, id, i.msg.id);
  });
  m.on('removed', (id: string) => {
    for (const [k, v] of st.status) if (v.from === id) st.status.delete(k);
    for (const i of [...(st.inbox.get(id) ?? [])]) takeInbox(st, id, i.msg.id, { outcome: 'gone', retryable: false, detail: 'target was closed' });
    st.inbox.delete(id);
    st.seen.delete(id);
    for (const pairs of [st.last, st.sent, st.loopNoticed]) for (const k of pairs.keys()) if (k.split('\0').includes(id)) pairs.delete(k);
    kick(id);
  });
  return st;
}

/** Serialize work per target so two deliveries never race for one idle composer. */
function locked<T>(s: State, to: string, fn: () => Promise<T>): Promise<T> {
  const run = (s.locks.get(to) ?? Promise.resolve()).then(fn);
  const tail = run.catch(() => {});
  s.locks.set(to, tail);
  void tail.then(() => { if (s.locks.get(to) === tail) s.locks.delete(to); }); // nothing queued behind it
  return run;
}

/** Called with the node's lifecycle lock held: let any paste already submitted settle before stopping it. */
export function waitForDeliveries(m: Mgr, id: string): Promise<void> {
  return locked(stateOf(m), id, async () => {});
}

/** After the old process exits, keep unsubmitted prompts and retire claims without replaying ambiguous input. */
export function handoverInbox(m: Mgr, id: string): void {
  const s = stateOf(m);
  for (const item of [...(s.inbox.get(id) ?? [])]) if (item.claimed) unconfirmed(m, id, item.msg.id);
  for (const entry of s.queues.get(id) ?? []) {
    clearTimeout(entry.timer);
    addInbox(m, s, inboxItem(entry, s.status.get(entry.id)?.at ?? Date.now()));
  }
  s.queues.delete(id);
  clearTimeout(s.retry.get(id));
  s.retry.delete(id);
  s.seen.delete(id);
  saveInbox(s);
  flushInbox(m);
}

const verifiedIdle = (v: NodeView) => v.status.state === 'done' && !v.status.stale && v.status.doneSource === 'stop';
/** A steer pressed Esc, which ends the turn with no Stop hook: done via interrupt is idle enough for it. */
const readyFor = (v: NodeView, e: Entry | undefined) => verifiedIdle(v) || (!!e?.steer && v.status.state === 'done' && v.status.doneSource === 'interrupt');
const busy = (v: NodeView | undefined) => v?.status.state === 'working';
const gone: SendResult = { outcome: 'gone', retryable: false, detail: 'target does not exist or has exited' };
const changingHarness = (m: Mgr, id: string) => m.runtimes?.get(id)?.busy === 'changing harness';
const oneLine = (s: string) => s.replace(/[\r\n]+/g, ' ');

/** The envelope line that marks a steer (see conversation.ts, which parses envelopes). */
export const STEER_LINE = 'steer: the sender interrupted your turn on purpose to deliver this now';

function frame(e: Entry): { text: string; nonce: string } {
  const nonce = randomBytes(6).toString('base64url');
  // paste() strips ESC bytes, so the body cannot close the paste frame.
  const steer = e.steer ? `${STEER_LINE}\n` : '';
  return { nonce, text: `--- TL MESSAGE ${nonce} ---\nfrom: ${e.label}\nreply-to: ${e.replyTo ?? 'none'}\n${steer}${e.text}\n--- END TL MESSAGE ${nonce} ---` };
}

const inboxItem = (e: Entry, enqueuedAt: number): InboxItem =>
  ({ to: e.to, from: e.from, msg: { id: e.id, from: e.label, text: frame(e).text, enqueuedAt, ...(e.steer ? { steer: true } : {}) } });

async function attempt(m: Mgr, e: Entry): Promise<Attempt> {
  const check = (): Attempt | undefined => {
    const v = m.view(e.to);
    if (m.draining) return { wait: 'deliveries are held until the daemon restarts' };
    if (changingHarness(m, e.to)) return { wait: 'target is changing harness' };
    if (!v || v.status.exited) return { result: gone };
    if (!readyFor(v, e)) return { wait: `target is ${v.status.state}${v.status.doneSource ? ` (done via ${v.status.doneSource})` : ''}, not verified idle` };
  };
  const early = check();
  if (early) return early;
  const session = m.session(e.to);
  if (!session) return { result: gone };
  await session.flush();
  const late = check();
  if (late) return late;
  const screen = session.classifyScreen();
  if (screen !== 'prompt') return { wait: `screen shows ${screen === 'dialog' ? 'a dialog' : 'no composer prompt'}` };
  if (session.composerText()) return { wait: 'composer has unsent text' };

  const { text: envelope, nonce } = frame(e);
  // Subscribe before writing: a fast target can answer before paste() returns.
  let onHook!: (id: string, ev: { hook_event_name?: string; prompt?: unknown }) => void;
  let timer: NodeJS.Timeout | undefined;
  const receipt = new Promise<boolean>((resolve) => {
    onHook = (id, ev) => { if (id === e.to && ev.hook_event_name === 'UserPromptSubmit' && String(ev.prompt ?? '').includes(nonce)) resolve(true); };
    timer = setTimeout(() => resolve(false), RECEIPT_MS);
  });
  m.on('hook', onHook);
  try {
    await session.paste(envelope);
    const seen = await receipt;
    return { result: seen
      ? { outcome: 'delivered', retryable: false }
      : { outcome: 'stalled', retryable: false, detail: `no UserPromptSubmit carrying the message seen within ${RECEIPT_MS / 1000} s; it may still land` } };
  } finally {
    clearTimeout(timer);
    m.off('hook', onHook);
  }
}

function drain(m: Mgr, s: State, to: string): Promise<void> {
  return locked(s, to, async () => {
    const q = s.queues.get(to) ?? [];
    while (q.length) {
      const e = q[0];
      const a = await attempt(m, e);
      if ('wait' in a) break;
      q.splice(q.indexOf(e), 1); // a steer may have been put ahead of it meanwhile
      clearTimeout(e.timer);
      setResult(s, e.id, { ...a.result, messageId: e.id, ...(e.steer ? { steer: true } : {}) });
    }
    scheduleRetry(m, s, to);
  });
}

/**
 * A target that is verified idle can still fail the screen check for a moment: Stop arrives before the composer
 * repaints, and no further event follows. While messages wait on such a target, re-run the gate every second.
 */
function scheduleRetry(m: Mgr, s: State, to: string): void {
  clearTimeout(s.retry.get(to));
  s.retry.delete(to);
  const v = m.view(to);
  const q = s.queues.get(to);
  if (!q?.length || !v || !readyFor(v, q[0])) return;
  const t = setTimeout(() => { s.retry.delete(to); drain(m, s, to).catch(logError); }, RETRY_MS);
  t.unref();
  s.retry.set(to, t);
}

/** Queue `e`; the caller records the returned result in `s.status`. */
function enqueue(m: Mgr, s: State, e: Entry, detail: string): SendResult {
  const q = s.queues.get(e.to) ?? [];
  s.queues.set(e.to, q);
  if (q.length >= QUEUE_CAP) return { outcome: 'queueFull', retryable: true, detail: `${QUEUE_CAP} messages already queued for ${e.to}`, messageId: e.id };
  if (e.steer) q.splice(q.filter((x) => x.steer).length, 0, e); // after earlier steers, ahead of the rest
  else q.push(e);
  const arm = () => {
    e.timer = setTimeout(() => locked(s, e.to, async () => {
      const i = q.indexOf(e);
      if (i < 0) return;
      if (m.draining) return arm(); // held for a restart: the hold is not the target's delay
      q.splice(i, 1);
      setResult(s, e.id, { outcome: 'expired', retryable: true, detail: 'target never became idle within 5 min', messageId: e.id });
      scheduleRetry(m, s, e.to);
    }).catch(logError), QUEUE_TTL_MS);
    e.timer.unref();
  };
  arm();
  drain(m, s, e.to).catch(logError); // the target may have gone idle while we were deciding to queue
  return { outcome: 'queued', retryable: false, detail, messageId: e.id };
}

// ---- mod inbox (PLAN §14): the queue for nodes whose mod is polling ----

const modLive = (s: State, id: string) => Date.now() - (s.seen.get(id) ?? -Infinity) <= MOD_LIVE_MS;

/** Record a message's outcome for message_status, and settle it once the outcome is final. */
function setResult(s: State, messageId: string, result: SendResult): void {
  const st = s.status.get(messageId);
  if (!st) return;
  if (st.result.outcome === 'queued' && result.outcome !== 'queued') s.logSettle(messageId, st, result);
  st.result = result;
  // A message that never reached the target does not count toward loop detection, so the retry it invites is accepted.
  const key = `${st.from}\0${st.to}`;
  if (s.sent.has(key) && ['queueFull', 'expired', 'withdrawn'].includes(result.outcome)) s.sent.set(key, s.sent.get(key)!.filter((x) => x.id !== messageId));
  if (result.outcome !== 'queued') st.onSettle?.(result);
}

/** Remove a message from `to`'s inbox and record its final outcome. Undefined if it is not (or no longer) there. */
function takeInbox(s: State, to: string, id: string, result: SendResult): InboxItem | undefined {
  const q = s.inbox.get(to) ?? [];
  const at = q.findIndex((i) => i.msg.id === id);
  if (at < 0) return undefined;
  const [i] = q.splice(at, 1);
  clearTimeout(i.timer);
  setResult(s, id, { ...result, messageId: id, ...(i.msg.steer ? { steer: true } : {}) });
  saveInbox(s);
  return i;
}

function writeInbox(s: State): boolean {
  clearTimeout(s.saveTimer);
  s.saveTimer = undefined;
  const tmp = `${s.inboxFile}.tmp`;
  try {
    writeFileSync(tmp, JSON.stringify({ version: 2, ...(s.held ? { held: true } : {}), items: [...s.inbox.values()].flat().map(({ timer, ...i }) => i),
      // Preserve ambiguous terminal outcomes after restart; they must never become retryable expiry.
      unconfirmed: [...s.status].filter(([, st]) => st.result.outcome === 'stalled' && st.result.detail === UNCONFIRMED_DETAIL) }));
    renameSync(tmp, s.inboxFile!);
    return true;
  } catch (err) { logError(err); return false; }
}

function saveInbox(s: State): void {
  if (!s.inboxFile) return;
  s.saveTimer ??= setTimeout(() => writeInbox(s), SAVE_MS);
  s.saveTimer.unref();
}

/** Write a pending inbox save now (at shutdown), so an ack or enqueue in the last debounce window is not lost. */
export function flushInbox(m: Mgr): void {
  const s = states.get(m);
  if (s?.saveTimer) writeInbox(s);
}

/**
 * Hold or release every delivery for a restart (see NodeManager.drain): `m.draining` already says which. Released
 * messages are pasted or picked up as their targets allow.
 */
export function holdDeliveries(m: Mgr): void {
  const s = stateOf(m);
  s.held = !!m.draining;
  saveInbox(s);
  if (!s.held) for (const [id, q] of s.queues) if (q.length) drain(m, s, id).catch(logError);
}

/** How long a claim counts as a turn about to start; a mod that died after claiming must not hold a restart for ever. */
const SUBMIT_MS = 30_000;

/** Whether the node's mod has claimed a message in the last SUBMIT_MS and not yet acknowledged it: a turn is about to begin. */
export function submitting(m: Mgr, id: string): boolean {
  const now = Date.now();
  return (states.get(m)?.inbox.get(id) ?? []).some((i) => i.claimed && now - (i.claimedAt ?? 0) < SUBMIT_MS);
}

/**
 * At shutdown: move the messages waiting to be pasted into their targets' inboxes, where the resumed nodes' mods pick
 * them up, and write the inbox now.
 */
export function saveInboxForRestart(m: Mgr): void {
  const s = states.get(m);
  if (!s?.inboxFile) return;
  for (const [id, q] of s.queues) {
    for (const entry of q) {
      clearTimeout(entry.timer);
      addInbox(m, s, inboxItem(entry, s.status.get(entry.id)?.at ?? Date.now()));
    }
    // Both lists were in send order; keep that order across them. Together they may pass QUEUE_CAP, which then only refuses new sends.
    s.inbox.get(id)?.sort((a, b) => a.msg.enqueuedAt - b.msg.enqueuedAt);
  }
  s.queues.clear();
  for (const t of s.retry.values()) clearTimeout(t);
  writeInbox(s);
}

/**
 * Put `i` in its target's inbox and arm its TTL (measured from enqueue, so a reloaded item keeps its remaining time).
 * The mod holds a message while a turn runs (so it can still be withdrawn), so the TTL starts over while the target works,
 * and while the mod, still polling, is submitting the message it claimed.
 */
function addInbox(m: Mgr, s: State, i: InboxItem): void {
  const q = s.inbox.get(i.to) ?? [];
  s.inbox.set(i.to, q);
  q.push(i);
  armInbox(m, s, i);
}

function armInbox(m: Mgr, s: State, i: InboxItem): void {
  const arm = (ms: number) => {
    i.timer = setTimeout(() => {
      if (!s.inbox.get(i.to)?.includes(i)) return;
      if (i.claimed && nativeInbox(m.view(i.to))) {
        const remaining = (i.claimedAt ?? i.msg.enqueuedAt) + PI_CONFIRM_MS - Date.now();
        if (remaining > 0) return arm(remaining);
        unconfirmed(m, i.to, i.msg.id);
        return;
      }
      if (m.draining || busy(m.view(i.to)) || (i.claimed && modLive(s, i.to))) return arm(QUEUE_TTL_MS);
      takeInbox(s, i.to, i.msg.id, { outcome: 'expired', retryable: true, detail: 'not picked up by the target within 5 min' });
    }, ms);
    i.timer.unref();
  };
  arm(Math.max(0, (i.claimed && nativeInbox(m.view(i.to))
    ? (i.claimedAt ?? i.msg.enqueuedAt) + PI_CONFIRM_MS
    : (i.since ?? i.msg.enqueuedAt) + QUEUE_TTL_MS) - Date.now()));
}

/**
 * Restore queued messages after a daemon restart, dropping those past their TTL. When the old daemon held deliveries
 * for the restart, the unclaimed messages start a fresh TTL instead: the time held is not the target's delay.
 */
function loadInbox(m: Mgr, s: State, file: string): void {
  s.inboxFile = file;
  try {
    const data = JSON.parse(readFileSync(file, 'utf8'));
    for (const [id, st] of Array.isArray(data?.unconfirmed) ? data.unconfirmed : []) {
      if (typeof id === 'string' && st?.result?.outcome === 'stalled' && st.result.detail === UNCONFIRMED_DETAIL && Date.now() - st.at < STATUS_TTL_MS) s.status.set(id, st);
    }
    for (const i of Array.isArray(data?.items) ? (data.items as InboxItem[]) : []) {
      if (!i?.msg?.id) continue;
      if (data.held && !i.claimed) i.since = Date.now();
      // An old claimed Pi message is ambiguous, not a safe-to-retry expiration.
      if (Date.now() - (i.since ?? i.msg.enqueuedAt) >= QUEUE_TTL_MS && !(i.claimed && nativeInbox(m.view(i.to)))) continue;
      s.status.set(i.msg.id, { from: i.from, to: i.to, result: { outcome: 'queued', retryable: false, messageId: i.msg.id }, at: i.msg.enqueuedAt,
        ...(m.view(i.to) ? { dir: m.sessionDirOf?.(i.to) } : {}) });
      addInbox(m, s, i);
    }
  } catch { /* no file, or unreadable: start empty */ }
}

export function markModLive(m: Mgr, nodeId: string): void {
  stateOf(m).seen.set(nodeId, Date.now());
}

/**
 * GET /inbox: the node's unacked messages, oldest first; while deliveries are held for a restart, only those its mod
 * has already claimed. Every poll marks the node mod-live.
 */
export function inbox(m: Mgr, nodeId: string): InboxMessage[] {
  if (changingHarness(m, nodeId)) return [];
  markModLive(m, nodeId);
  return (stateOf(m).inbox.get(nodeId) ?? []).filter((i) => i.claimed || !m.draining).map((i) => ({ ...i.msg, ...(i.claimed ? { claimed: true } : {}) }));
}

/** POST /ack: the mod submitted the message, so it is delivered. False if it is not (or no longer) in that node's inbox. */
export function ack(m: Mgr, nodeId: string, id: string): boolean {
  return !!takeInbox(stateOf(m), nodeId, id, { outcome: 'delivered', retryable: false });
}

/** POST /claim: the mod is about to submit the message, so it can no longer be withdrawn. False if it is not in that node's inbox. */
export function claim(m: Mgr, nodeId: string, id: string): boolean {
  if (changingHarness(m, nodeId) || m.draining) return false;
  const s = stateOf(m);
  const i = s.inbox.get(nodeId)?.find((x) => x.msg.id === id);
  if (!i) return false;
  if (nativeInbox(m.view(nodeId)) && i.claimed) return false; // ambiguous prior owner: never replay
  i.claimed = true;
  i.claimedAt ??= Date.now();
  if (nativeInbox(m.view(nodeId))) {
    // Persist BEFORE returning success: a daemon crash after native submission must not enable replay.
    if (s.inboxFile && !writeInbox(s)) {
      // The mod is told 404 and will not submit, so the message stays queued as before.
      delete i.claimed;
      delete i.claimedAt;
      return false;
    }
    clearTimeout(i.timer);
    i.timer = setTimeout(() => unconfirmed(m, nodeId, id), PI_CONFIRM_MS);
    i.timer.unref();
    return true;
  }
  saveInbox(s);
  return true;
}

/**
 * POST /release: the mod claimed the message but never submitted it (the target became busy first), so it goes back
 * in the queue, withdrawable again and retryable when its TTL ends. False if it is not a claimed message of that node.
 */
export function release(m: Mgr, nodeId: string, id: string): boolean {
  const s = stateOf(m);
  const i = s.inbox.get(nodeId)?.find((x) => x.msg.id === id);
  if (!i?.claimed) return false;
  delete i.claimed;
  delete i.claimedAt;
  clearTimeout(i.timer);
  armInbox(m, s, i);
  saveInbox(s); // a crash before the save leaves it claimed, which retires as ambiguous: never a replay
  return true;
}

const UNCONFIRMED_DETAIL = 'native prompt acceptance was not confirmed; it may still run later; do not resend automatically';

/** Retire only this caller's claimed message. Idempotent; late acknowledgments cannot revive it. */
export function unconfirmed(m: Mgr, nodeId: string, id: string): boolean {
  const s = stateOf(m);
  const i = s.inbox.get(nodeId)?.find((item) => item.msg.id === id);
  if (!i?.claimed) return false;
  const retired = !!takeInbox(s, nodeId, id, { outcome: 'stalled', retryable: false, detail: UNCONFIRMED_DETAIL });
  if (retired && s.inboxFile) writeInbox(s); // persist terminal status before replying, not at debounce
  return retired;
}

/** Queue for a mod-live target. */
function queueInbox(m: Mgr, s: State, e: Entry): SendResult {
  if ((s.inbox.get(e.to)?.length ?? 0) >= QUEUE_CAP) return { outcome: 'queueFull', retryable: true, detail: `${QUEUE_CAP} messages already queued for ${e.to}` };
  addInbox(m, s, inboxItem(e, Date.now()));
  saveInbox(s);
  return e.steer
    ? { outcome: 'queued', retryable: false, steer: true, detail: 'the target\'s mod interrupts its turn and submits the message; delivery is confirmed when it does' }
    : { outcome: 'queued', retryable: false, detail: 'queued for the target\'s mod; delivery is confirmed when it submits the message' };
}

/**
 * Remove a message that is still queued (not yet pasted, or not yet claimed by the target's mod) and mark it withdrawn.
 * Only its sender, or the human, may. Rejects, saying why, when it cannot be withdrawn.
 */
export function withdraw(m: Mgr, caller: string, messageId: string): Promise<{ to: string; result: SendResult }> {
  const s = stateOf(m);
  const st = s.status.get(messageId);
  if (!st || (st.from !== caller && caller !== HUMAN)) return Promise.reject(new Error(`no message ${messageId} from you`));
  // Under the target's lock, so a paste in progress settles its outcome first.
  return locked(s, st.to, async () => {
    const refuse = (why: string) => new Error(`cannot withdraw ${messageId}: ${why}`);
    if (st.result.outcome !== 'queued') throw refuse(`it is already ${st.result.outcome}`);
    const inbox = s.inbox.get(st.to) ?? [];
    const item = inbox.find((i) => i.msg.id === messageId);
    const q = s.queues.get(st.to) ?? [];
    const entry = q.find((e) => e.id === messageId);
    if (item?.claimed) throw refuse('the target\'s mod is already submitting it');
    const result: SendResult = { outcome: 'withdrawn', retryable: false, detail: 'withdrawn by the sender before delivery', messageId };
    if (item) takeInbox(s, st.to, messageId, result);
    else if (entry) { q.splice(q.indexOf(entry), 1); clearTimeout(entry.timer); scheduleRetry(m, s, st.to); setResult(s, messageId, result); }
    else throw refuse('it is no longer queued');
    if (m.view(st.to)) m.logEvent(st.to, 'withdraw', { from: caller, messageId });
    return { to: st.to, result: st.result };
  });
}

/**
 * `caller` closed `ids` itself and needs no word of them: withdraw the daemon's dropOnClose notices to it (child and
 * notify_when notices, not a merge result), still queued, that concern only those nodes. One already claimed goes through.
 */
export function dropNotices(m: Mgr, caller: string, ids: string[]): void {
  for (const [messageId, st] of states.get(m)?.status ?? []) {
    if (st.from === DAEMON && st.to === caller && st.result.outcome === 'queued' && st.dropOnClose?.every((id) => ids.includes(id))) withdraw(m, DAEMON, messageId).catch(() => {});
  }
}

/** Outcome of a message the caller sent: final, or `queued` while it still waits. */
export function messageStatus(m: Mgr, caller: string, messageId: string): SendResult | undefined {
  const r = stateOf(m).status.get(messageId);
  return r && (r.from === caller || caller === HUMAN) ? r.result : undefined;
}

/** PLAN §6. Resolves once the message is delivered, stalled, refused or queued. */
export async function deliver(m: Mgr, fromId: string, toId: string, text: string, opts: DeliverOpts = {}): Promise<SendResult> {
  const s = stateOf(m);
  const id = `m-${randomBytes(4).toString('hex')}`;
  const now = Date.now();
  for (const [k, v] of s.status) if (now - v.at > STATUS_TTL_MS) s.status.delete(k);
  const out = (r: SendResult): SendResult => {
    const result = { ...r, messageId: id };
    s.status.set(id, { from: fromId, to: toId, result, at: now, onSettle: opts.onSettle, ...(m.view(toId) ? { dir: m.sessionDirOf?.(toId) } : {}), ...(opts.dropOnClose && opts.about?.length ? { dropOnClose: opts.about } : {}) });
    setResult(s, id, result);
    if (m.view(toId)) {
      m.logEvent(toId, 'send', { from: fromId, outcome: result.outcome, messageId: id, ...(result.steer ? { steer: true } : {}),
        // A refused send (an out-of-scope one included) never reached the target: keep its words out of the target's log.
        ...(result.outcome === 'refused' ? {} : { text: text.slice(0, LOG_TEXT_CHARS), ...(text.length > LOG_TEXT_CHARS ? { textCut: true } : {}),
          ...(opts.fromLabel ? { label: oneLine(opts.fromLabel) } : {}) }),
        ...(opts.about?.length ? { about: opts.about } : {}) });
    }
    return result;
  };
  const refuse = (detail: string, retryable = false) => out({ outcome: 'refused', retryable, detail });

  // Scope first, so an out-of-scope caller cannot tell a missing node from one it may not touch.
  if (!inScope(m, fromId, toId)) return refuse('target is outside your lineage (self, ancestors, siblings, descendants)');
  const target = m.view(toId);
  if (!target || target.status.exited) return out(gone);
  if (changingHarness(m, toId)) return refuse('target is changing harness; retry after it starts', true);
  if (fromId === toId) return refuse('cannot send to yourself');
  if (target.kind === 'terminal') return refuse('not an agent node; use write for terminals');

  const key = `${fromId}\0${toId}`;
  const wait = (s.last.get(key) ?? -Infinity) + RATE_MS - Date.now();
  if (fromId !== DAEMON && wait > 0) return refuse(`rate limited, retry in ${Math.ceil(wait / 1000)} s`, true);
  const from = m.view(fromId);
  if (fromId !== DAEMON && fromId !== HUMAN) {
    const recent = (s.sent.get(key) ?? []).filter((x) => now - x.at < LOOP_MS);
    s.sent.set(key, recent);
    const max = loadConfig(from ? m.projectDir(from) : null, m.home).limits.maxMessagesPer10Min;
    const why = recent.length >= max ? `${recent.length} messages to ${toId} in 10 min (limits.maxMessagesPer10Min)`
      : recent.some((x) => x.text === text) ? `the same message to ${toId} twice in 10 min` : undefined;
    if (why) {
      loopNotice(m, s, from, key, why);
      return refuse(`looks like a loop: ${why}; escalate to the human or change approach`);
    }
    recent.push({ at: now, text, id });
  }
  s.last.set(key, Date.now());

  const label = opts.fromLabel ?? (from ? `${oneLine(from.title)} (${fromId})` : fromId);
  // A steer interrupts only a working target; to an idle (or blocked, or waiting) one, "now" is the same as "queue".
  // While a restart waits for turns to end, it queues too.
  const steer = opts.mode === 'now' && busy(target) && !m.draining;
  const entry: Entry = { id, from: fromId, to: toId, label: oneLine(label), replyTo: opts.replyTo === undefined ? fromId : opts.replyTo, text, steer };
  if (opts.inbox || modLive(s, toId) || adapterFor(target).capabilities.inbox) return out(queueInbox(m, s, entry)); // the mod aborts the turn itself
  if (steer) {
    // No mod to abort the turn: press Esc as the human would. The manager marks the turn interrupted, which wakes the queue.
    const r = enqueue(m, s, entry, '');
    if (r.outcome !== 'queued') return out(r);
    m.input(toId, '\x1b');
    return out({ ...r, steer: true, detail: 'interrupted the target\'s turn; the message is pasted once it stops' });
  }
  const q = s.queues.get(toId);
  if (q?.length) return out(enqueue(m, s, entry, `behind ${q.length} queued message(s)`)); // keep order
  const a = await locked(s, toId, () => attempt(m, entry));
  return out('wait' in a ? enqueue(m, s, entry, a.wait) : a.result);
}

/** Tell the looping sender's parent, at most once per pair per LOOP_MS. */
function loopNotice(m: Mgr, s: State, from: NodeView | undefined, key: string, why: string): void {
  const now = Date.now();
  if (!from?.parentId || now - (s.loopNoticed.get(key) ?? -Infinity) < LOOP_MS) return;
  s.loopNoticed.set(key, now);
  childNotice(m, from, 'may be looping', `Refused a send: ${why}. It was told to escalate to the human or change approach.`);
}

/** A daemon notice to `v`'s parent about `v`. */
function childNotice(m: Mgr, v: NodeView, why: string, body: string): void {
  if (v.parentId) deliver(m, DAEMON, v.parentId, body, { fromLabel: `tiller (child ${v.id} "${v.title}" ${why})`, replyTo: null, about: [v.id], dropOnClose: true }).catch(logError);
}

// ---- station notices (PLAN §7) ----

/**
 * Tell a parent when its child reports an outcome (unless the parent's pending notify_when covers that child, which then
 * carries it), exits, errors, sits on a question or stalls. Once per episode. A turn error first gets
 * one "continue" message to the child; the parent hears of the next error in the episode.
 */
export function startNotices(m: Mgr): void {
  const notified = new Set<string>();
  const timers = new Map<string, NodeJS.Timeout>();
  /** The changedAt of the errored turn the child was told to continue from. */
  const retried = new Map<string, number>();
  const stallNoticed = new Set<string>();
  /** Nodes whose parent heard their branch conflicts with its base; cleared once it merges cleanly again. */
  const conflictNoticed = new Set<string>();
  const notice = (v: NodeView, reason: string) => {
    if (!v.parentId || notified.has(v.id)) return;
    notified.add(v.id);
    const last = v.status.lastAssistantMessage;
    const body = last ? noticeCut(last, 'read summary for the rest') : 'No further details.';
    childNotice(m, v, `stopped: ${reason}`, body);
  };
  const onNode = (v: NodeView) => {
    if (!v.parentId) return;
    const { state, exited, errored } = v.status;
    if (state !== 'waiting') {
      clearTimeout(timers.get(v.id));
      timers.delete(v.id);
    } else if (!timers.has(v.id)) {
      const t = setTimeout(() => {
        timers.delete(v.id);
        const cur = m.view(v.id);
        if (cur?.status.state === 'waiting') notice(cur, 'question-unanswered');
      }, WAITING_NOTICE_MS);
      t.unref();
      timers.set(v.id, t);
    }
    if (!v.status.stalled) stallNoticed.delete(v.id);
    else if (!stallNoticed.has(v.id)) {
      stallNoticed.add(v.id);
      const body = `No hook event for ${fmtAge(Date.now() - v.status.changedAt)} while working${v.status.activity ? `; last activity: ${v.status.activity}` : ''}.`;
      childNotice(m, v, 'no activity', body);
    }
    const g = v.status.git;
    if (!g?.conflicts) conflictNoticed.delete(v.id);
    else if (!conflictNoticed.has(v.id)) {
      conflictNoticed.add(v.id);
      childNotice(m, v, 'conflicts with its base', `Merging ${g.base} into ${g.branch} would conflict in ${g.conflicts.join(', ')}. `
        + `Send the worker a rebase instruction: rebase ${g.branch} onto ${g.base} (or merge ${g.base} into it), resolve, commit.`);
    }
    if (exited) notice(v, 'exited');
    else if (state === 'done' && errored) {
      const at = retried.get(v.id);
      if (at === undefined) {
        retried.set(v.id, v.status.changedAt);
        deliver(m, DAEMON, v.id, RETRY_TEXT, { fromLabel: 'tiller (your turn errored)', replyTo: null, about: [v.id],
          onSettle: (r) => { if (r.outcome !== 'delivered') notice(v, 'turn-errored'); } }).catch(logError);
      } else if (at !== v.status.changedAt) notice(v, 'turn-errored');
    } else if (state === 'done' && v.status.doneSource === 'stop') { notified.delete(v.id); retried.delete(v.id); } // only a clean Stop re-arms
  };
  const onOutcome = (id: string) => {
    const v = m.view(id);
    if (!v?.parentId || !v.outcome || watching(m, v.parentId, id)) return;
    childNotice(m, v, `reported ${v.outcome.outcome}`, `${id} reported ${outcomeLine(v.outcome, true)}`);
  };
  m.on('node', onNode);
  m.on('outcome', onOutcome);
}

// ---- notify_when ----

/** Managers whose node events already re-check their callers' watches. */
const listening = new WeakSet<NodeManager>();

/**
 * `caller` closes `id` itself with `close`: its notify_when watches leave `id` out once it has closed, and neither count
 * the close as finishing nor lose `id` when it fails (see CompletionWatches.hold).
 */
export async function closeWatched<T>(m: Pick<NodeManager, 'runtimes' | 'view'>, caller: string, id: string, close: () => Promise<T>): Promise<T> {
  const watches = () => m.runtimes.get(caller)?.watches;
  watches()?.hold(id);
  try {
    return await close();
  } finally {
    watches()?.settle(id, !m.view(id));
  }
}

/** Whether `caller` has a pending notify_when that covers `id`. */
export function watching(m: Partial<Pick<NodeManager, 'runtimes'>>, caller: string, id: string): boolean {
  return m.runtimes?.get(caller)?.watches?.covers(id) ?? false;
}

/**
 * Register a one-shot notice when all or any of the nodes finish. A caller's runtime owns its watches; messaging
 * wires node/removal events and daemon delivery. Replaces the watch for the same id set; delivery may be immediate.
 */
export function notifyWhen(m: NodeManager, caller: string, req: NotifyWhen): { replaced: boolean } {
  if (!listening.has(m)) {
    listening.add(m);
    const sweep = () => {
      const now = Date.now();
      for (const rt of m.runtimes.values()) rt.watches?.sweep(now);
    };
    m.on('node', sweep);
    m.on('removed', sweep);
  }
  const rt = m.runtimes.get(caller)!;
  rt.watches ??= new CompletionWatches({ view: (id) => m.view(id), turnStartedAt: (id) => m.turnStartedAt(id) },
    (text, fromLabel, about) => { deliver(m, DAEMON, caller, text, { fromLabel, replyTo: null, about, dropOnClose: true }).catch(logError); });
  return rt.watches.register(req);
}
