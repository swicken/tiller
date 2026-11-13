import { needsYou, type NodeView, type Question } from './protocol.js';

export const isOpen = (q: Question): boolean => q.state === 'open';

/** Open questions a node owns. */
export const openFor = (qs: Question[], nodeId: string): Question[] => qs.filter((q) => isOpen(q) && q.nodeId === nodeId);

/** Open first: those with no assumption (work is waiting) before the rest, oldest first within each; then resolved, newest first. */
export function sortQuestions(qs: Question[]): Question[] {
  const rank = (q: Question) => (!isOpen(q) ? 2 : q.assumption ? 1 : 0);
  return [...qs].sort((a, b) => rank(a) - rank(b) || (isOpen(a) ? a.askedAt - b.askedAt : (b.resolvedAt ?? b.askedAt) - (a.resolvedAt ?? a.askedAt)));
}

/** What needs the human: nodes blocked on a prompt, plus open questions. */
export const attention = (nodes: NodeView[], qs: Question[]): number => nodes.filter((n) => needsYou(n.status)).length + qs.filter(isOpen).length;
