import type { NodeView } from '../../src/shared/protocol';
import { statusKind, type Nodes, type StatusKind } from './tree';

/** Ancestors from the session root down to `id`, inclusive. Tolerates missing parents; parentId is fixed at spawn, so there are no cycles. */
export function ancestry(nodes: Nodes, id: string): NodeView[] {
  const chain: NodeView[] = [];
  for (let n: NodeView | undefined = nodes[id]; n; n = n.parentId ? nodes[n.parentId] : undefined) chain.unshift(n);
  return chain;
}

export const rootOf = (nodes: Nodes, id: string): string => ancestry(nodes, id)[0]?.id ?? id;

/** Roots (no parent, or parent unknown) in display order. */
export const roots = (nodes: Nodes, order: string[]): NodeView[] =>
  order.map((id) => nodes[id]).filter((n): n is NodeView => !!n && !(n.parentId && nodes[n.parentId]));

/** `order` with its roots in the saved tab order, roots the saved order does not name after them, then every other node as it was. */
export function arrange(nodes: Nodes, order: string[], saved: string[]): string[] {
  const rs = roots(nodes, order).map((r) => r.id);
  const placed = saved.filter((id) => rs.includes(id));
  return [...placed, ...rs.filter((id) => !placed.includes(id)), ...order.filter((id) => !rs.includes(id))];
}

/** The session tab to the right of root `id`, else the one to its left. */
export function besideSession(nodes: Nodes, order: string[], id: string): string | undefined {
  const rs = roots(nodes, order);
  const i = rs.findIndex((r) => r.id === id);
  return i < 0 ? undefined : (rs[i + 1] ?? rs[i - 1])?.id;
}

/** Most urgent first: this is the colour a session's dot takes. */
const URGENCY: StatusKind[] = ['needs', 'errored', 'working', 'done', 'queued', 'armed', 'unknown', 'exited'];

export interface SessionInfo { root: NodeView; size: number; needs: number; kind: StatusKind }

export function sessions(nodes: Nodes, order: string[]): SessionInfo[] {
  const rs = roots(nodes, order);
  const by = new Map<string, SessionInfo>(rs.map((root) => [root.id, { root, size: 0, needs: 0, kind: 'exited' }]));
  for (const id of order) {
    const n = nodes[id];
    const s = n && by.get(rootOf(nodes, id));
    if (!s) continue;
    const k = statusKind(n);
    s.size++;
    if (k === 'needs') s.needs++;
    if (URGENCY.indexOf(k) < URGENCY.indexOf(s.kind)) s.kind = k;
  }
  return rs.map((r) => by.get(r.id)!);
}

/** What to show first: the requested node, else the most recently changed live root, else the first root. */
export function pickInitial(nodes: Nodes, order: string[], want?: string): string | null {
  if (want && nodes[want]) return want;
  const rs = roots(nodes, order);
  const live = rs.filter((r) => !r.status.exited);
  const newest = live.reduce<NodeView | undefined>((a, b) => (!a || b.status.changedAt > a.status.changedAt ? b : a), undefined);
  return (newest ?? rs[0])?.id ?? null;
}
