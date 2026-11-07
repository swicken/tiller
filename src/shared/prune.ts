import type { NodeView } from './protocol.js';

/**
 * Ids of exited nodes whose descendants are all removed too: removing them never orphans a node. Roots and dormant nodes
 * (exited without finishing, see NodeRecord.dormant) are left out, so their sessions stay resumable. With `explicit`,
 * only the listed ids are considered, and listed roots and dormant nodes are included.
 */
export function pruneIds(nodes: NodeView[], explicit?: string[]): string[] {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const listed = explicit && new Set(explicit);
  const chosen = (n: NodeView) => n.status.exited && (listed ? listed.has(n.id) : n.parentId !== null && !n.dormant);
  // Every node that stays (live, or exited but not chosen) keeps its whole ancestry, so no removal leaves an orphan.
  const keep = new Set<string>();
  for (const n of nodes) {
    if (chosen(n)) continue;
    for (let p = n.parentId ? byId.get(n.parentId) : undefined; p && !keep.has(p.id); p = p.parentId ? byId.get(p.parentId) : undefined) keep.add(p.id);
  }
  return nodes.filter((n) => chosen(n) && !keep.has(n.id)).map((n) => n.id);
}
