import type { NodeView } from './protocol.js';

/**
 * Ids of exited nodes that have no live descendant: removing them never orphans a running node. Roots and dormant nodes
 * (exited without finishing, see NodeRecord.dormant) are left out, so their sessions stay resumable. With `explicit`,
 * only the listed ids are considered, and listed roots and dormant nodes are included.
 */
export function pruneIds(nodes: NodeView[], explicit?: string[]): string[] {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const keep = new Set<string>();
  for (const n of nodes) {
    if (n.status.exited) continue;
    for (let p = n.parentId ? byId.get(n.parentId) : undefined; p && !keep.has(p.id); p = p.parentId ? byId.get(p.parentId) : undefined) keep.add(p.id);
  }
  const listed = explicit && new Set(explicit);
  const chosen = (n: NodeView) => (listed ? listed.has(n.id) : n.parentId !== null && !n.dormant);
  return nodes.filter((n) => n.status.exited && !keep.has(n.id) && chosen(n)).map((n) => n.id);
}
