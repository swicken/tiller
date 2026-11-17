import { needsYou, type NodeView, type Question } from '../../src/shared/protocol';
import { isOpen, sortQuestions } from '../../src/shared/questions';
import { roots, rootOf } from '../sidebar/sessions';
import type { Nodes } from '../sidebar/tree';

/** The first open question of the session on screen: the selected node's own first, then waiting before carrying on, oldest first. */
export function reminderList(questions: Record<string, Question>, nodes: Nodes, session: string | null, selected: string | null): Question[] {
  const here = sortQuestions(Object.values(questions)).filter((q) => isOpen(q) && rootOf(nodes, q.nodeId) === session);
  return [...here.filter((q) => q.nodeId === selected), ...here.filter((q) => q.nodeId !== selected)];
}

/** The title of the node the answer goes to; the asker's title when that node is gone. */
export const ownerTitle = (q: Question, nodes: Nodes) => nodes[q.nodeId]?.title ?? q.askedBy.title;

const MIN = 60_000;
/** "just now", "4 min ago", "2 h ago", "yesterday", "3 d ago". */
export function ago(ms: number): string {
  const m = Math.floor(Math.max(0, ms) / MIN);
  if (m < 1) return 'just now';
  if (m < 60) return `${m} min ago`;
  if (m < 1440) return `${Math.floor(m / 60)} h ago`;
  return m < 2880 ? 'yesterday' : `${Math.floor(m / 1440)} d ago`;
}

/** `“text”` closing a sentence: the full stop goes after it, unless the text brings its own (“Done.” not “Done.”.). */
export const quoted = (text: string) => `“${text}”${/[.!?…]$/.test(text) ? '' : '.'}`;

/** A sentence's closing mark, so text can be followed by more ("Keep it? 2 more", not "Keep it?. 2 more"). */
export const sentence = (text: string) => (/[.!?…]$/.test(text.trim()) ? text.trim() : `${text.trim()}.`);

/** The clock time in a tooltip: "02:14 PM". */
export const stamp = (at: number) => new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

export type Item = { kind: 'q'; q: Question } | { kind: 'approval'; node: NodeView };
export interface Group { key: string; title: string; note?: string; items: Item[] }
type Where = Omit<Group, 'items'>;

/** The session an item is listed under: its root's current title, else (the session is gone) the title it was asked under. */
function whereIs(nodes: Nodes, here: string | null, id: string, q?: Question): Where {
  const root = rootOf(nodes, id);
  if (nodes[root]) return { key: root, title: nodes[root].title, note: root === here ? 'this session' : undefined };
  return q?.rootTitle ? { key: `closed:${q.rootId}`, title: q.rootTitle, note: 'closed session' } : { key: 'closed', title: 'Closed sessions' };
}

/** Groups in display order: the session on screen, the other live sessions in tab order, then closed ones, "Closed sessions" last. */
function arrange(entries: [Where, Item][], nodes: Nodes, order: string[], here: string | null): Group[] {
  const tabs = roots(nodes, order).map((r) => r.id);
  const rank = (key: string) => (key === here ? -1 : key === 'closed' ? 1e9 + 1 : key.startsWith('closed:') ? 1e9 : tabs.indexOf(key));
  const by = new Map<string, Group>();
  for (const [w, item] of entries) (by.get(w.key) ?? by.set(w.key, { ...w, items: [] }).get(w.key)!).items.push(item);
  return [...by.values()].sort((a, b) => rank(a.key) - rank(b.key));
}

export interface Listing { groups: Group[]; notDelivered: Group[]; done: Group[]; waiting: number }

/**
 * What the panel lists. `pinned` holds, in order, every question that was open since the panel opened: they keep their place
 * when resolved, and a new one joins the end. Other resolved questions go to "Not delivered" (an answer the agent has not
 * received) or "Done in the last day". Within a group: questions waiting on you, approval prompts, then questions carrying on.
 */
export function listing(questions: Record<string, Question>, nodes: Nodes, order: string[], here: string | null, pinned: string[], now: number): Listing {
  const all = Object.values(questions);
  const live = pinned.map((id) => questions[id]).filter((q): q is Question => !!q);
  const entry = (q: Question): [Where, Item] => [whereIs(nodes, here, q.nodeId, q), { kind: 'q', q }];
  const approvals = order.map((id) => nodes[id]).filter((n): n is NodeView => !!n && needsYou(n.status));
  const resolved = sortQuestions(all).filter((q) => !isOpen(q) && !pinned.includes(q.id));
  const undelivered = (q: Question) => q.state === 'answered' && !!q.delivery && q.delivery.state !== 'delivered';
  return {
    groups: arrange([
      ...live.filter((q) => !q.assumption).map(entry),
      ...approvals.map((node): [Where, Item] => [whereIs(nodes, here, node.id), { kind: 'approval', node }]),
      ...live.filter((q) => q.assumption).map(entry),
    ], nodes, order, here),
    notDelivered: arrange(resolved.filter(undelivered).map(entry), nodes, order, here),
    done: arrange(resolved.filter((q) => !undelivered(q) && (q.resolvedAt ?? q.askedAt) > now - 86_400_000).map(entry), nodes, order, here),
    waiting: all.filter(isOpen).length + approvals.length,
  };
}

/** Every question in the groups, in display order. */
export const questionsIn = (groups: Group[]): Question[] => groups.flatMap((g) => g.items.flatMap((i) => (i.kind === 'q' ? [i.q] : [])));

/** What the human answered, choice then text. */
export const answerText = (q: Question) => [q.answer?.choice, q.answer?.text].filter(Boolean).join('\n');

/** [bold lead, sentence] for a question that is no longer open. `refused`: the sentence for an answer that arrived too late. */
export function ended(q: Question, nodes: Nodes, refused: boolean): [string, string] {
  const asker = q.askedBy.title;
  if (q.replacedBy) return refused ? ['Not sent.', `${asker} replaced this with a newer question.`] : ['Replaced by a newer question.', `${asker} asked again.`];
  if (q.state === 'dismissed') return refused ? ['Not sent.', 'This was already dismissed.'] : ['You dismissed this.', `${asker} wasn’t told.`];
  if (q.state === 'withdrawn') {
    const { who, name } = withdrawnBy(q, nodes);
    const lead = refused ? 'Not sent.' : 'No longer needed.';
    if (who === 'tiller') return [lead, 'The agent that asked was closed, with no agent above it.'];
    const tail = refused ? 'this just before your answer arrived' : 'it';
    const reason = q.withdrawn?.reason?.trim();
    return [lead, `${who === 'asker' ? name : `${name}, the agent above it,`} withdrew ${tail}${reason ? `: ${quoted(reason)}` : '.'}`];
  }
  return refused ? ['Not sent.', `This was already answered, in another window or from the shell: ${quoted(answerText(q).replace('\n', ' · '))}`] : ['', 'This was answered elsewhere.'];
}

/** The notice for a refused answer or dismissal: the daemon's own words while the question is open, else why it is no longer open. */
export const notSent = (q: Question, nodes: Nodes, message: string): [string, string] => (isOpen(q) ? ['Not sent.', message] : ended(q, nodes, true));

/** Who withdrew a question: the asker, an agent above it, or the daemon. */
export function withdrawnBy(q: Question, nodes: Nodes): { who: 'asker' | 'ancestor' | 'tiller'; name: string } {
  const by = q.withdrawn?.by;
  if (by === 'tiller') return { who: 'tiller', name: 'Tiller' };
  if (!by || by === q.askedBy.id) return { who: 'asker', name: q.askedBy.title };
  return { who: 'ancestor', name: nodes[by]?.title ?? 'the agent above it' };
}
