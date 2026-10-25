import type { MemoryItemKind, MemoryItemView, MemoryPage, MemoryTarget } from '../../src/shared/protocol';

/** The pane's sections, in order. Given needs a node; v3 may add its own here. */
export const SECTIONS = [
  { key: 'items', label: 'Items' },
  { key: 'given', label: 'Given to this node', needsNode: true },
  { key: 'claude', label: 'Claude Code memory' },
] as const;
export type SectionKey = (typeof SECTIONS)[number]['key'];
export const sectionsFor = (target: MemoryTarget) => SECTIONS.filter((s) => !('needsNode' in s) || target.nodeId);

export const KIND_LABEL: Record<MemoryItemKind, string> = { ledger: 'Ledger', open_question: 'Open question', procedure: 'Procedure', pitfall: 'Pitfall', note: 'Note' };
/** The kind chips: undefined is All. */
export const CHIPS: { kind?: MemoryItemKind | 'pinned'; label: string }[] = [
  { label: 'All' }, { kind: 'pinned', label: 'Pinned' }, { kind: 'ledger', label: 'Ledger' }, { kind: 'open_question', label: 'Open questions' },
  { kind: 'procedure', label: 'Procedures' }, { kind: 'pitfall', label: 'Pitfalls' }, { kind: 'note', label: 'Notes' },
];
export const chipCount = (counts: MemoryPage['counts'], kind?: MemoryItemKind | 'pinned') =>
  kind ? counts[kind] : (Object.keys(KIND_LABEL) as MemoryItemKind[]).reduce((n, k) => n + counts[k], 0);

/** Invalid kinds this UI can describe and restore; any other kind (v3's) gets a generic badge and no Restore. */
const INVALID_LABEL: Record<string, string> = {
  human: 'Retracted by the human (permanent)',
  agent: 'Hidden by an agent until recorded again',
  superseded: 'Superseded',
  merged: 'Merged by the gardener',
  gardener: 'Hidden by the gardener',
};
const RESTORABLE = new Set(['agent', 'human', 'superseded']);

export function badges(item: MemoryItemView, supersededBy?: number): string[] {
  const out: string[] = [];
  if (item.pinned) out.push('Pinned');
  if (item.tombstone) out.push(item.tombstone === 'evicted' ? 'Evicted' : 'Purged');
  else if (item.invalid) {
    const { kind, by } = item.invalid;
    if (kind === 'superseded' && supersededBy) out.push(`Superseded by m${supersededBy}`);
    else if (kind === 'merged' && item.mergedInto) out.push(`Merged into m${item.mergedInto} by the gardener`);
    else out.push(INVALID_LABEL[kind] ?? `Hidden (${kind})${by ? ` by ${by}` : ''}`);
  }
  if (item.eligible === false) out.push('Search only');
  return out;
}

export type ItemAction = 'pin' | 'unpin' | 'edit' | 'forget' | 'restore';
/** What the human can do to an item in its state; the daemon still judges each. */
export function itemActions(item: MemoryItemView): ItemAction[] {
  if (item.tombstone) return [];
  if (!item.invalid) return [item.pinned ? 'unpin' : 'pin', ...(item.pinned && item.textPin ? ['edit' as const] : []), 'forget'];
  // A retracted item may still be pinned (forget does not unpin). A retracted text pin comes back by pinning it again.
  const pin = item.pinned ? 'unpin' as const : 'pin' as const;
  return [pin, ...(!item.textPin && RESTORABLE.has(item.invalid.kind) ? ['restore' as const] : [])];
}

/** Pinning an agent's or the daemon's text turns it into an instruction: ask first (D7). */
export const pinNeedsConfirm = (item: MemoryItemView) => item.author !== 'human';

export const provenance = (item: MemoryItemView) =>
  item.author === 'agent' ? [item.nodeId ?? 'agent', item.harness, item.model].filter(Boolean).join(' · ') : item.author;

/** POSIX single quotes: the string is taken literally by the shell. */
export const shellQuote = (s: string) => `'${s.replaceAll("'", `'\\''`)}'`;

/** The CLI command that purges this item from exactly this file, or undefined when no tl memory scope opens it (D15). */
export const purgeCommand = (cli: MemoryPage['cli'], id: number) =>
  cli && `tl memory forget m${id} '<reason>' --purge --repo ${shellQuote(cli.repo)}${cli.account ? ` --account ${cli.account}` : ''}`;

/** Why the detail has no purge command, or a caveat for the one it has. */
export function purgeNote(page: MemoryPage): string | undefined {
  if (!page.cli) return page.checkout
    ? 'No purge command: the CLI would open another account file for this checkout.'
    : 'No purge command: no checkout of this repository is known. Choose its directory.';
  if (page.on !== true) return 'Purging needs memory on for this checkout; the CLI refuses while it is off.';
}

const FROM: Record<NonNullable<MemoryPage['checkout']>['from'], string> = { node: 'from this node', chosen: 'chosen', 'live node': 'a live node', 'recorded path': 'the recorded path' };
export const checkoutLine = (page: MemoryPage) => page.checkout
  ? `Checkout: ${page.checkout.path} (${FROM[page.checkout.from]})`
  : 'No checkout of this repository is known: choose its directory.';

export const stateLine = (page: MemoryPage) =>
  page.on === true ? `Memory is on for this checkout (${page.source}).`
  : page.on === false ? `Memory is off for this checkout (${page.source}). Change it in Settings → Memory.`
  : `Memory on or off is unknown: ${page.source}.`;

/** Splits leading YAML frontmatter (between --- lines) from a Markdown file. */
export function splitFrontmatter(text: string): { frontmatter?: string; body: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(text);
  return m ? { frontmatter: m[1], body: text.slice(m[0].length) } : { body: text };
}
