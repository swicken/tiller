// Spend roll-ups over node records, shared by the daemon (list_nodes) and the web UI.
import type { NodeRecord } from './protocol.js';
import { treeOrder } from './tree.js';

type Spender = Pick<NodeRecord, 'id' | 'parentId' | 'spentUsd' | 'spentIncomplete' | 'spentToday'>;

/** A spend figure; `incomplete` means some usage had no price, so `usd` is a lower bound. */
export interface Spend { usd: number; incomplete: boolean }

/** Local calendar day as YYYY-MM-DD. */
export const dayKey = (at: number) => new Date(at).toLocaleDateString('en-CA');

/** The node's own spend plus that of every descendant in `nodes` (no cycle guard: parentId is fixed at spawn). */
export function subtreeSpend(nodes: Iterable<Spender>, id: string): Spend {
  const all = [...nodes], root = all.find((n) => n.id === id);
  return (root ? treeOrder(all, root) : []).reduce<Spend>(
    (sum, { node }) => ({ usd: sum.usd + (node.spentUsd ?? 0), incomplete: sum.incomplete || !!node.spentIncomplete }),
    { usd: 0, incomplete: false },
  );
}

/** Spend today across `nodes`. */
export function todaySpend(nodes: Iterable<Spender>, now: number): Spend {
  const day = dayKey(now);
  const sum = { usd: 0, incomplete: false };
  for (const n of nodes) if (n.spentToday?.day === day) {
    sum.usd += n.spentToday.usd;
    sum.incomplete ||= !!n.spentToday.incomplete;
  }
  return sum;
}

/** `$0.42`, or `$0.42+` when the figure is a lower bound. A positive amount under a cent shows as `<$0.01`, not a misleading `$0.00`. */
export const fmtUsd = (usd: number, incomplete?: boolean) =>
  `${usd > 0 && usd < 0.01 ? '<$0.01' : `$${usd.toFixed(2)}`}${incomplete ? '+' : ''}`;

/** Tooltip suffix for a `+` figure. */
export const INCOMPLETE_NOTE = 'at least: some usage had no price';
