// A node's conversations, assembled from its tree's event log (every message between nodes, daemon notices, delivery
// outcomes, reports and lifecycle marks) and, for its conversation with its parent, its own transcript turns.
// Agents can write events.jsonl, so every event is shape-checked here and its text is only ever data.
import { existsSync } from 'node:fs';
import type { ArchivedNode, Conversation, ConversationItem, ConversationSummary, NodeRecord, Outcome, SendOutcome, TranscriptEntry } from '../shared/protocol.js';
import { history } from './archive.js';
import type { NodeManager } from './manager.js';
import { DAEMON, HUMAN, STEER_LINE } from './messaging.js';
import { flushEvents, readEvents, sessionDir, type SessionEvent } from './sessions.js';
import { MAX_ENTRIES, readMessages, recordedSessions, toEntry } from './transcript.js';

const OUTCOMES: readonly SendOutcome[] = ['delivered', 'queued', 'stalled', 'expired', 'queueFull', 'gone', 'refused', 'withdrawn'];
/** First outcomes of a message that never reached its target: not part of any conversation. */
const UNSENT: readonly SendOutcome[] = ['refused', 'gone', 'queueFull'];

interface Send { ts: number; to: string; from: string; outcome: SendOutcome; messageId: string; text?: string; textCut?: true; label?: string; about?: string[]; steer?: true }
interface Settle { ts: number; outcome: SendOutcome }
/** What the tree's event log says, validated. `titles` holds each node's latest logged title. */
export interface Records { sends: Send[]; settles: Map<string, Settle>; outcomes: { ts: number; id: string; outcome: Outcome }[]; marks: { ts: number; id: string; text: string }[]; titles: Record<string, string> }

const str = (v: unknown): v is string => typeof v === 'string';
const strs = (v: unknown): v is string[] => Array.isArray(v) && v.every(str);
const sendOutcome = (v: unknown): v is SendOutcome => OUTCOMES.includes(v as SendOutcome);

function outcomeOf(e: SessionEvent): Outcome | undefined {
  if (e.outcome !== 'succeeded' && e.outcome !== 'failed') return undefined;
  return {
    outcome: e.outcome, at: e.ts,
    ...(str(e.note) ? { note: e.note } : {}), ...(str(e.summary) ? { summary: e.summary } : {}), ...(str(e.verified) ? { verified: e.verified } : {}),
    ...(strs(e.changedFiles) ? { changedFiles: e.changedFiles } : {}), ...(strs(e.openQuestions) ? { openQuestions: e.openQuestions } : {}),
    ...(e.gate === 'passed' || e.gate === 'failed' ? { gate: e.gate } : {}),
  };
}

/** The log's events as records, dropping any whose shape is wrong. */
export function parseRecords(events: SessionEvent[]): Records {
  const r: Records = { sends: [], settles: new Map(), outcomes: [], marks: [], titles: {} };
  for (const e of events) {
    if (!e || typeof e !== 'object' || !Number.isFinite(e.ts) || !str(e.id) || !str(e.type)) continue;
    const { ts, id } = e;
    if (str(e.title)) r.titles[id] = e.title;
    switch (e.type) {
      case 'send':
        if (str(e.from) && str(e.messageId) && sendOutcome(e.outcome)) {
          r.sends.push({ ts, to: id, from: e.from, outcome: e.outcome, messageId: e.messageId, ...(str(e.text) ? { text: e.text } : {}),
            ...(e.textCut === true ? { textCut: true } : {}), ...(str(e.label) ? { label: e.label } : {}), ...(strs(e.about) ? { about: e.about } : {}),
            ...(e.steer === true ? { steer: true } : {}) });
        }
        break;
      case 'settle':
        if (str(e.messageId) && sendOutcome(e.outcome) && !r.settles.has(e.messageId)) r.settles.set(e.messageId, { ts, outcome: e.outcome });
        break;
      case 'outcome': {
        const outcome = outcomeOf(e);
        if (outcome) r.outcomes.push({ ts, id, outcome });
        break;
      }
      case 'merge':
        if (str(e.branch) && str(e.base)) r.marks.push({ ts, id, text: `merged ${e.branch} into ${e.base}` });
        break;
      case 'close': r.marks.push({ ts, id, text: str(e.note) ? `closed: ${e.note}` : 'closed' }); break;
      case 'restart': r.marks.push({ ts, id, text: 'restarted' }); break;
    }
  }
  return r;
}

const ENVELOPE = new RegExp(`^--- TL MESSAGE (\\S+) ---\nfrom: ([^\n]*)\nreply-to: (.*)\n(${STEER_LINE}\n)?([\\s\\S]*?)\n--- END TL MESSAGE \\1 ---$`);

/** A delivered message as the recipient's transcript holds it (see frame() in messaging.ts), or undefined. */
export function parseEnvelope(text: string): { label: string; replyTo: string; body: string; steer?: true } | undefined {
  const m = ENVELOPE.exec(text.trim());
  return m ? { label: m[2], replyTo: m[3], body: m[5], ...(m[4] ? { steer: true } : {}) } : undefined;
}

/** Whether a from label names node `id`: `id "title"` (the daemon writes the id first), or the old `title (id)`, which older transcripts hold. */
const fromNode = (label: string, id: string) => label.startsWith(`${id} "`) || label.endsWith(`(${id})`);

/** Whether a send is part of `subject`'s conversation with `parent` (its parent's id, or human for a root). */
function upward(s: Send, subject: string, parent: string): boolean {
  if (s.to === subject) return s.from === parent || s.from === HUMAN || (s.from === DAEMON && (!s.about || s.about.includes(subject)));
  if (s.from === subject) return s.to === parent;
  return s.from === DAEMON && s.to === parent && !!s.about?.includes(subject);
}
const between = (s: Send, a: string, b: string) => (s.from === a && s.to === b) || (s.from === b && s.to === a);
const counted = (s: Send) => !UNSENT.includes(s.outcome);

/** A message is placed when `placeAt` saw it: at its delivery when that came later than the send. */
function messageItem(r: Records, s: Send, placeAt?: string): Extract<ConversationItem, { kind: 'message' }> {
  const settle = r.settles.get(s.messageId);
  return { kind: 'message', at: s.to === placeAt && settle?.outcome === 'delivered' ? settle.ts : s.ts, sentAt: s.ts, from: s.from, to: s.to,
    ...(s.text !== undefined ? { text: s.text } : {}), ...(s.label ? { label: s.label } : {}), messageId: s.messageId,
    delivery: settle?.outcome ?? s.outcome, ...(s.steer ? { steer: true } : {}) };
}

/** The titles of the conversation's participants, from `names`. */
function titlesFor(names: Record<string, string>, items: ConversationItem[], ids: string[]): Record<string, string> {
  const all = new Set(ids);
  for (const i of items) for (const id of 'from' in i ? [i.from, ...(i.kind === 'message' ? [i.to] : [])] : [i.id]) all.add(id);
  return Object.fromEntries([...all].flatMap((id) => (names[id] ? [[id, names[id]]] : [])));
}

/** Line endings and trailing spaces differ between the recorded text and a transcript's copy; compare without them. */
const norm = (t: string) => t.replace(/\r\n?/g, '\n').replace(/[ \t]+$/gm, '').trim();

/**
 * User lines the harness writes itself, not prompts the human typed: Claude's messages from other sessions, task and
 * subagent notifications, slash-command and `!` command echoes, skill loads, image notes and interrupt markers.
 */
const INJECTED = /^(?:Another Claude session sent a message|Base directory for this skill:|\[Request interrupted by user|\[Image: source:|<(?:task-notification|local-command-[a-z]+|command-(?:name|message|args)|bash-(?:input|stdout|stderr)|system-reminder)>)/;

export interface Subject { id: string; parentId: string | null; prompt?: string; createdAt: number }

/**
 * `subject`'s conversation with its parent (the human for a root): the brief, the messages and notices between them,
 * its reports and lifecycle marks, merged by time with its own transcript `turns`. A user turn that repeats the brief
 * or a recorded message, or that the harness injected, is dropped; an envelope with no record (from before messages were recorded) is kept only
 * from the parent or the human.
 */
export function buildConversation(subject: Subject, r: Records, turns: TranscriptEntry[], names = r.titles): Conversation {
  const { id, parentId } = subject;
  const parent = parentId ?? HUMAN;
  const brief = subject.prompt && norm(subject.prompt);
  const sends = r.sends.filter((s) => counted(s) && upward(s, id, parent));
  const records: Exclude<ConversationItem, { kind: 'turn' }>[] = [
    ...(brief ? [{ kind: 'brief' as const, at: subject.createdAt, from: parent, text: brief }] : []),
    // A message to the subject sent before text was recorded is covered by the envelope in its transcript.
    ...sends.filter((s) => s.text !== undefined || s.to !== id).map((s) => messageItem(r, s, id)),
    ...r.outcomes.filter((o) => o.id === id).map((o) => ({ kind: 'outcome' as const, at: o.ts, from: id, outcome: o.outcome })),
    ...r.marks.filter((e) => e.id === id).map((e) => ({ kind: 'event' as const, at: e.ts, id, text: e.text })),
  ].sort((x, y) => x.at - y.at);

  const recorded = r.sends.filter((s) => s.to === id && s.text !== undefined).map((s) => ({ text: norm(s.text!), cut: !!s.textCut }));
  const isRecorded = (body: string) => recorded.some((x) => (x.cut ? body.startsWith(x.text) : body === x.text));
  let last: number | undefined;
  const own = turns.flatMap((e): ConversationItem[] => {
    last = e.at ?? last;
    const turn = (from: string, text: string): ConversationItem[] =>
      [{ kind: 'turn', ...(last !== undefined ? { at: last } : {}), from, role: e.role, text, ...(e.tools?.length ? { tools: e.tools } : {}) }];
    const text = norm(e.text);
    if (e.role === 'assistant') return turn(id, e.text);
    if (!text || text === brief || INJECTED.test(text)) return [];
    const env = parseEnvelope(text);
    if (!env) return turn(HUMAN, text);
    const body = norm(env.body);
    if (isRecorded(body)) return [];
    if (env.label === HUMAN) return turn(HUMAN, body);
    return parentId && fromNode(env.label, parentId) ? turn(parentId, body) : [];
  });

  // Stable merge: a record goes before the first turn that is later than it.
  const items: ConversationItem[] = [];
  let i = 0;
  for (const t of own) {
    while (i < records.length && t.at !== undefined && records[i].at < t.at) items.push(records[i++]);
    items.push(t);
  }
  items.push(...records.slice(i));
  return { a: parent, b: id, relation: 'parent', titles: titlesFor(names, items, [parent, id]), items };
}

/** Messages between `a` and `b`, from the records alone. */
export function buildPeerConversation(a: string, b: string, r: Records, names = r.titles): Conversation {
  const items = r.sends.filter((s) => counted(s) && between(s, a, b)).map((s) => messageItem(r, s)).sort((x, y) => x.at - y.at);
  return { a, b, relation: 'peer', titles: titlesFor(names, items, [a, b]), items };
}

/** What the index knows of a node of the tree, live or closed. */
export interface TreeNode { title: string; parentId: string | null; createdAt: number; live: boolean; archived?: ArchivedNode; outcome?: Outcome['outcome'] }

/** `id`'s conversations: with its parent (or the human), with each child (most recent first), then with each peer. */
export function buildIndex(id: string, nodes: Map<string, TreeNode>, r: Records): ConversationSummary[] {
  const self = nodes.get(id);
  const parent = self?.parentId ?? HUMAN;
  const counterpart = (c: string) => {
    const n = nodes.get(c);
    return { counterpart: c, title: n?.title ?? r.titles[c] ?? (c === HUMAN ? 'You' : c), live: c === HUMAN || !!n?.live, ...(n?.archived ? { archived: n.archived } : {}) };
  };
  const stats = (sends: Send[], since = 0) => ({ messages: sends.length, ...(sends.length || since ? { lastAt: Math.max(since, ...sends.map((s) => s.ts)) } : {}) });
  const live = r.sends.filter(counted);

  const children = [...nodes].filter(([, n]) => n.parentId === id).map(([c, n]): ConversationSummary => {
    const reported = Math.max(0, ...r.outcomes.filter((o) => o.id === c).map((o) => o.ts));
    return { id: c, relation: 'child', ...counterpart(c), ...stats(live.filter((s) => upward(s, c, id)), Math.max(n.createdAt, reported)),
      ...(n.outcome ? { outcome: n.outcome } : {}) };
  }).sort((x, y) => (y.lastAt ?? 0) - (x.lastAt ?? 0));

  const known = new Set([id, parent, HUMAN, DAEMON, ...children.map((c) => c.id)]);
  const peers = [...new Set(live.flatMap((s) => (s.from === id ? [s.to] : s.to === id ? [s.from] : [])))].filter((p) => !known.has(p))
    .map((p): ConversationSummary => ({ id, with: p, relation: 'peer', ...counterpart(p), ...stats(live.filter((s) => between(s, id, p))) }))
    .sort((x, y) => (y.lastAt ?? 0) - (x.lastAt ?? 0));

  return [{ id, relation: 'parent', ...counterpart(parent), ...stats(live.filter((s) => upward(s, id, parent))) }, ...children, ...peers];
}

// ---- reading a live or archived node's tree ----

type Mgr = Pick<NodeManager, 'home' | 'registry' | 'view' | 'rootIdOf' | 'transcriptNode'>;

/** The node, its tree's records and every node of the tree. rootId comes from the registry or the archive's directory. */
async function readTree(m: Mgr, id: string): Promise<{ n: NodeRecord | ArchivedNode; r: Records; nodes: Map<string, TreeNode> }> {
  const n = await m.transcriptNode(id);
  const rootId = m.registry.get(id) ? m.rootIdOf(id) : (n as ArchivedNode).rootId;
  await flushEvents();
  // prune: reads and parses the whole event log on each request; switch to an index or tail scan if trees exceed about 20 MB of events.
  const r = parseRecords(readEvents(sessionDir(m.home, rootId)));
  const nodes = new Map<string, TreeNode>();
  for (const a of await history(m.home, { rootId })) {
    if (!nodes.has(a.id)) nodes.set(a.id, { title: a.title, parentId: a.parentId, createdAt: a.createdAt, live: false, archived: a, ...(a.outcome ? { outcome: a.outcome.outcome } : {}) });
  }
  for (const v of m.registry.list()) {
    const outcome = m.view(v.id)?.outcome?.outcome;
    if (m.rootIdOf(v.id) === rootId) nodes.set(v.id, { title: v.title, parentId: v.parentId, createdAt: v.createdAt, live: true, ...(outcome ? { outcome } : {}) });
  }
  return { n, r, nodes };
}


export async function conversations(m: Mgr, id: string): Promise<ConversationSummary[]> {
  const { n, r, nodes } = await readTree(m, id);
  if (!nodes.has(id)) nodes.set(id, { title: n.title, parentId: n.parentId, createdAt: n.createdAt, live: false });
  return buildIndex(id, nodes, r);
}

/** `id`'s conversation with its parent, or with peer `withId`. */
export async function conversation(m: Mgr, id: string, withId?: string): Promise<Conversation> {
  const { n, r, nodes } = await readTree(m, id);
  const names = { ...r.titles, ...Object.fromEntries([...nodes].map(([k, v]) => [k, v.title])) };
  if (withId) return buildPeerConversation(id, withId, r, names);
  const { turns, truncated } = await ownTurns(n);
  return { ...buildConversation({ id, parentId: n.parentId, prompt: n.prompt, createdAt: n.createdAt }, r, turns, names), ...(truncated ? { truncated } : {}) };
}

/** The node's transcript entries across its recorded sessions, oldest first, the newest MAX_ENTRIES of them. A missing file reads as none. */
async function ownTurns(n: NodeRecord | ArchivedNode): Promise<{ turns: TranscriptEntry[]; truncated: boolean }> {
  const sessions = recordedSessions(n); // current first, then the earlier ones oldest first
  let truncated = false;
  const turns: TranscriptEntry[] = [];
  for (const s of [...sessions.slice(1), ...sessions.slice(0, 1)]) {
    if (!existsSync(s.transcriptPath)) continue;
    const read = await readMessages(s.transcriptPath, s.harness).catch(() => undefined);
    if (!read) continue;
    truncated ||= read.truncated;
    turns.push(...read.messages.map(toEntry));
  }
  if (turns.length > MAX_ENTRIES) {
    truncated = true;
    turns.splice(0, turns.length - MAX_ENTRIES);
  }
  return { turns, truncated };
}
