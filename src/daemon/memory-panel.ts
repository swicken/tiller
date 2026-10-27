// The Memory panel's requests (docs/memory.md): which account file, repository and checkout a MemoryTarget means, the
// reads, and the human's actions. Every request comes over the WebSocket, which only the admin token opens, so every
// action is the human's. The store keeps the SQL and server.ts the transport.
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import type {
  ClaudeMemoryView, MemoryAction, MemoryInjectionView, MemoryItemDetail, MemoryItemKind, MemoryItemView, MemoryPage, MemoryTarget,
} from '../shared/protocol.js';
import { accountForProject, claudeConfigDir } from './claude-accounts.js';
import { readClaudeMemory } from './claude-memory.js';
import { usableCwd, type NodeManager } from './manager.js';
import { memoryOn } from './memory-config.js';
import { DEFAULT_ACCOUNT_KEY, LIMITS, type Actor, type MemoryScope } from './memory-schema.js';
import { noCounts, readFailure, type ListCursor } from './memory-store.js';
import { requireDir } from './util.js';

/** What the panel needs of the manager. */
export type PanelHost = Pick<NodeManager, 'home' | 'memory' | 'registry' | 'projectDir' | 'repoKeyOf' | 'transcriptNode'>;

type Checkout = NonNullable<MemoryPage['checkout']>;

/** A MemoryTarget resolved: the account and its file, the repository, and the checkout the opt-in is judged for. */
interface ResolvedTarget {
  account: string | undefined;
  /** The account file's key. */
  file: string;
  repoKey?: string;
  /** The file's repositories; empty when it is missing or cannot be read. */
  repos: MemoryPage['repos'];
  checkout?: Checkout;
  on: boolean | null;
  source: string;
}

const HUMAN: Actor = { kind: 'human' };
const NO_CHECKOUT = 'no checkout of this repository is known; choose its directory';

/**
 * Resolve a target as the human's tool scope is (memoryScopeOf), the node optional: the node (live, else closed) gives
 * the defaults, its own account included (none means the no-account file); dir is a checkout the human chose, which
 * wins over the node's. The opt-in is judged for the first checkout whose repo key is the repository's: the chosen one,
 * the node's, a live node's, then the first path the file recorded. With none, on is null.
 */
async function resolveTarget(m: PanelHost, t: MemoryTarget): Promise<ResolvedTarget> {
  const live = t.nodeId === undefined ? undefined : m.registry.get(t.nodeId);
  const node = live ?? (t.nodeId === undefined ? undefined : await m.transcriptNode(t.nodeId));
  // A closed node's worktree may be gone: its cwd then maps back to the main checkout.
  const nodeDir = live ? m.projectDir(live) : node && m.projectDir({ cwd: usableCwd(node.cwd) ?? node.cwd });
  const nodeCheckout = nodeDir && existsSync(nodeDir) ? nodeDir : undefined;
  if (t.dir !== undefined) requireDir(t.dir, 'dir');
  const dirCheckout = t.dir === undefined ? undefined : m.projectDir({ cwd: t.dir });
  const project = dirCheckout ?? nodeCheckout;
  const account = t.account !== undefined ? t.account ?? undefined
    : node ? node.account : project ? accountForProject(m.home, project) : undefined;
  const file = basename(m.memory.accountFile(account), '.db'); // throws for an account not configured
  let repos: MemoryPage['repos'] = [];
  try { repos = m.memory.repos(account); } catch { /* the page shows the file's state */ }
  // A node whose checkout is gone keeps its repository only when the file recorded that path; never another's.
  const repoKey = t.repo ?? (project ? m.repoKeyOf(project) : node ? repos.find((r) => r.path === nodeDir)?.key : repos[0]?.key);
  const checkout = repoKey === undefined ? undefined
    : checkoutOf(m, repoKey, dirCheckout, nodeCheckout, repos.find((r) => r.key === repoKey)?.path);
  const verdict = checkout ? memoryOn(m.home, checkout.path, account) : { on: null, source: NO_CHECKOUT };
  return { account, file, ...(repoKey === undefined ? {} : { repoKey }), repos, ...(checkout ? { checkout } : {}), ...verdict };
}

/** The first existing checkout with the repo key: the chosen one, the node's, a live node's, then the recorded path. */
function checkoutOf(m: PanelHost, repoKey: string, dirCheckout?: string, nodeCheckout?: string, recorded?: string): Checkout | undefined {
  const has = (path: string | undefined): path is string => !!path && existsSync(path) && m.repoKeyOf(path) === repoKey;
  if (has(dirCheckout)) return { path: dirCheckout, from: 'chosen' };
  if (has(nodeCheckout)) return { path: nodeCheckout, from: 'node' };
  for (const n of m.registry.list()) {
    const path = m.projectDir(n);
    if (has(path)) return { path, from: 'live node' };
  }
  return has(recorded) ? { path: recorded, from: 'recorded path' } : undefined;
}

/** The store scope of a resolved target with a repository; repoPath is only recorded by writes, which need a checkout. */
const scopeOf = (r: ResolvedTarget): MemoryScope => ({ account: r.account, repoKey: r.repoKey!, repoPath: r.checkout?.path ?? '' });

/**
 * The tl memory scope that opens exactly this file and repository (the purge command's): a named account maps to its
 * own file; for no account, the CLI picks the checkout's account, which must map to the same file.
 */
function cliScope(m: PanelHost, r: ResolvedTarget): MemoryPage['cli'] {
  if (!r.checkout) return undefined;
  if (r.account !== undefined) return { repo: r.checkout.path, account: r.account };
  try {
    return basename(m.memory.accountFile(accountForProject(m.home, r.checkout.path)), '.db') === DEFAULT_ACCOUNT_KEY ? { repo: r.checkout.path } : undefined;
  } catch {
    return undefined;
  }
}

export interface PageQuery {
  target: MemoryTarget;
  kind?: MemoryItemKind | 'pinned';
  query?: string;
  retracted?: boolean;
  before?: ListCursor;
}

/** One page of the panel. A file that cannot be read gives a page with its state and empty lists; only a bad target throws. */
export async function memoryPage(m: PanelHost, q: PageQuery): Promise<MemoryPage> {
  const r = await resolveTarget(m, q.target);
  const status = m.memory.fileStatus(r.account, true), cli = cliScope(m, r);
  const page: MemoryPage = {
    target: { account: r.account ?? null, ...(r.repoKey === undefined ? {} : { repo: r.repoKey }), ...(q.target.nodeId ? { nodeId: q.target.nodeId } : {}), ...(q.target.dir ? { dir: q.target.dir } : {}) },
    file: r.file, state: status.state, quarantined: status.quarantined,
    files: m.memory.status(undefined, true).map((s) => ({ account: s.key === DEFAULT_ACCOUNT_KEY ? null : s.key, file: s.key, state: s.state })),
    repos: r.repos, ...(r.checkout ? { checkout: r.checkout } : {}), on: r.on, source: r.source, ...(cli ? { cli } : {}),
    counts: noCounts(), items: [],
  };
  if (status.state !== 'ok' || r.repoKey === undefined) return page;
  const scope = scopeOf(r), filter = q.kind === 'pinned' ? { pinned: true } : { kind: q.kind };
  try {
    const counts = m.memory.counts(scope);
    const query = q.query?.trim();
    if (query) return { ...page, counts, items: m.memory.search(scope, { query, ...filter, includeRetracted: q.retracted, eligible: true, limit: LIMITS.panel.page }) };
    const { items, next } = m.memory.list(scope, { ...filter, retracted: q.retracted, before: q.before });
    return { ...page, counts, items, ...(next ? { next } : {}) };
  } catch (err) {
    return { ...page, state: readFailure(err) };
  }
}

/** One item in full, not counted as an agent's read. */
export async function memoryItem(m: PanelHost, target: MemoryTarget, itemId: number): Promise<MemoryItemDetail> {
  const r = await resolveTarget(m, target);
  if (r.repoKey === undefined) throw new Error(`no such item m${itemId}`);
  return m.memory.peek(scopeOf(r), itemId);
}

/** A live or closed node's digest decisions from its account's file, newest first; none without a file. */
export async function memoryGiven(m: PanelHost, nodeId: string): Promise<MemoryInjectionView[]> {
  const node = await m.transcriptNode(nodeId);
  return m.memory.injections(node.account, nodeId, LIMITS.panel.given);
}

/** The human's change to an item, refused unless memory is on for the target's checkout. forget never purges. */
export async function memoryAction(m: PanelHost, target: MemoryTarget, action: MemoryAction): Promise<MemoryItemView> {
  const r = await resolveTarget(m, target);
  if (r.on !== true || !r.checkout) throw new Error(`refused: ${r.checkout ? `memory is off for ${r.checkout.path} (${r.source})` : r.source}`);
  const s = m.memory, scope = scopeOf(r);
  switch (action.kind) {
    case 'pin': return s.pin(scope, HUMAN, { id: action.itemId });
    case 'pinText': return s.pin(scope, HUMAN, { text: action.text });
    case 'unpin': return s.pin(scope, HUMAN, { id: action.itemId, unpin: true });
    case 'editPin': return s.editPin(scope, HUMAN, { id: action.itemId, text: action.text });
    case 'forget': return s.forget(scope, HUMAN, { id: action.itemId, reason: action.reason });
    case 'restore': return s.restore(scope, HUMAN, { id: action.itemId });
  }
}

/** Claude Code's own auto-memory for the target's checkout, in the account's Claude home; read-only, never stored. */
export async function claudeMemory(m: PanelHost, target: MemoryTarget): Promise<ClaudeMemoryView> {
  const r = await resolveTarget(m, target);
  if (!r.checkout) throw new Error("no checkout of this repository is known; choose the repository's directory");
  // claudeConfigDir throws for an account no longer configured: never fall back to ~/.claude for one.
  const claudeHome = (r.account === undefined ? undefined : claudeConfigDir(m.home, r.account)) ?? join(homedir(), '.claude');
  return { ...(await readClaudeMemory(claudeHome, r.checkout.path)), ...(r.account === undefined ? {} : { account: r.account }) };
}
