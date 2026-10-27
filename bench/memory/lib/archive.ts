// Archived trees for the retrieval benchmark (R1): the pre-registered tree selection, a replay of a tree's outcomes
// and closes through the real derive and store.apply into a temp MemoryStore as of a time, and file-overlap labels.
// Session files are only ever read: archive.jsonl holds real session text, so nothing from it may be written into the
// repo, and tests use synthetic archives.
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { homedir, tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import type { ArchivedNode } from '../../../src/shared/protocol.js';
import { derive } from '../../../src/daemon/memory-derive.js';
import { redact, type CaptureEvent, type MemoryScope } from '../../../src/daemon/memory-schema.js';
import { MemoryStore } from '../../../src/daemon/memory-store.js';
import type { SessionMeta } from '../../../src/daemon/sessions.js';

// --- Pre-registered selection (§2.2) ---

/**
 * "As of 2026-10-24", the end of that day on the machine that counted the trees (EDT): trees created and nodes closed
 * from here on are not gate data, so the set cannot grow toward a result (nor take in the gate's own nodes).
 */
export const GATE_CUTOFF = Date.parse('2026-10-25T00:00:00-04:00');
/** A tree qualifies with at least this many nodes closed before the cutoff that report changedFiles. */
export const MIN_NODES_WITH_FILES = 20;
/** A file touched by more than this share of a tree's nodes says nothing about relevance and labels nothing. */
export const HOT_FILE_SHARE = 0.15;
/**
 * The human's decision: only the tiller and storyGame trees, and no bloksec tree in any benchmark data (R1 or
 * otherwise). gateTrees() checks that the rule over the machine's archives still selects exactly these.
 */
export const GATE_TREES = [
  { rootId: 'n-96530325', repo: 'tiller' },
  { rootId: 'n-76dead40', repo: 'storyGame' },
] as const;

/** Any repo under a bloksec directory, or named bloksec*. */
export const isExcludedRepo = (path: string): boolean => path.split('/').some((s) => /^bloksec/i.test(s));

export interface TreeCounts { rootId: string; cwd: string; createdAt: number; nodesWithFiles: number }

/** The rule: created before the cutoff, enough nodes with changedFiles before it, and not an excluded repo. */
export const selectTrees = (trees: TreeCounts[], cutoff = GATE_CUTOFF): string[] => trees
  .filter((t) => t.createdAt < cutoff && t.nodesWithFiles >= MIN_NODES_WITH_FILES && !isExcludedRepo(t.cwd))
  .map((t) => t.rootId).sort();

// --- Reading ---

export interface Tree {
  rootId: string;
  /** The root's checkout, from meta.json. */
  cwd: string;
  repo: string;
  createdAt: number;
  /** Archived nodes closed before the cutoff, in closedAt order. */
  nodes: ArchivedNode[];
}

const files = (a: ArchivedNode) => a.outcome?.changedFiles ?? [];

/** One session directory's tree, read-only. rootId comes from the directory, as the daemon reads it (archive.ts). */
export function readTree(dir: string, cutoff = GATE_CUTOFF): Tree {
  const rootId = basename(dir);
  const meta = JSON.parse(readFileSync(join(dir, 'meta.json'), 'utf8')) as SessionMeta;
  const path = join(dir, 'archive.jsonl');
  const lines = existsSync(path) ? readFileSync(path, 'utf8').split('\n') : [];
  const nodes = lines.flatMap((l) => { try { return l ? [{ ...(JSON.parse(l) as ArchivedNode), rootId }] : []; } catch { return []; } })
    .filter((a) => a.closedAt < cutoff).sort((a, b) => a.closedAt - b.closedAt);
  return { rootId, cwd: meta.cwd, repo: basename(meta.cwd), createdAt: meta.createdAt, nodes };
}

/** The gate's trees from <home>/sessions. Throws when the rule selects anything but GATE_TREES, or a repo differs. */
export function gateTrees(home = join(homedir(), '.tiller'), cutoff = GATE_CUTOFF): Tree[] {
  const root = join(home, 'sessions');
  const trees = readdirSync(root).filter((d) => existsSync(join(root, d, 'meta.json'))).map((d) => readTree(join(root, d), cutoff));
  const picked = selectTrees(trees.map((t) => ({ ...t, nodesWithFiles: t.nodes.filter((a) => files(a).length).length })), cutoff);
  const want = GATE_TREES.map((t) => t.rootId).sort();
  if (picked.join() !== want.join()) throw new Error(`the selection rule picks [${picked}], not the pre-registered [${want}]`);
  return GATE_TREES.map(({ rootId, repo }) => {
    const t = trees.find((x) => x.rootId === rootId)!;
    if (t.repo !== repo) throw new Error(`tree ${rootId} is repo ${t.repo}, not ${repo}`);
    return t;
  });
}

// --- Replay ---

/** The nodes a query from node q is scored against: closed before q was created, never q or its descendants. */
export function asOfNodes(tree: Tree, q: ArchivedNode): ArchivedNode[] {
  const parent = new Map(tree.nodes.map((a) => [a.id, a.parentId]));
  const below = (id: string) => {
    for (let p = parent.get(id); p; p = parent.get(p)) if (p === q.id) return true;
    return false;
  };
  return tree.nodes.filter((a) => a.closedAt < q.createdAt && a.id !== q.id && !below(a.id));
}

/**
 * A temp MemoryStore fed a tree's outcomes and closes in closedAt order, through the capture funnel's steps (redact,
 * nodeHistory, derive, apply). advanceTo is incremental; for the strict as-of rule build one from asOfNodes.
 */
export class ArchiveReplay {
  readonly home = mkdtempSync(join(tmpdir(), 'tl-bench-archive-'));
  readonly store: MemoryStore;
  readonly scope: MemoryScope;
  private clock = 0;
  private next = 0;
  private readonly nodes: ArchivedNode[];

  constructor(readonly tree: Tree, nodes: ArchivedNode[] = tree.nodes) {
    this.nodes = [...nodes].sort((a, b) => a.closedAt - b.closedAt);
    this.store = new MemoryStore(this.home, { now: () => this.clock });
    this.scope = { repoKey: `bench:${tree.repo}`, repoPath: `/bench/${tree.repo}` };
  }

  /** Apply every remaining node closed before t (all of them when t is omitted). */
  advanceTo(t = Infinity): this {
    for (; this.next < this.nodes.length && this.nodes[this.next].closedAt < t; this.next++) {
      const a = this.nodes[this.next];
      const scope: MemoryScope = { ...this.scope, nodeId: a.id, rootId: this.tree.rootId, harness: a.harness ?? 'claude', ...(a.model ? { model: a.model } : {}) };
      const events: CaptureEvent[] = [];
      if (a.outcome) {
        const { at, ...o } = a.outcome;
        events.push({ type: 'outcome', ts: at, ...o });
      }
      events.push({ type: 'close', ts: a.closedAt, archived: a });
      for (const e of events) {
        this.clock = e.ts;
        this.store.apply(scope, derive(redact(e), this.store.nodeHistory(scope, a.id)));
      }
    }
    return this;
  }

  /** Archived node id → its ledger item's id (derive keys a ledger item on its node id). */
  ledgerIds(): Map<string, number> {
    const file = this.store.accountFile(undefined);
    if (!existsSync(file)) return new Map();
    const db = new DatabaseSync(file, { readOnly: true });
    try {
      const rows = db.prepare("SELECT id, dedupe FROM items WHERE kind = 'ledger'").all() as { id: number; dedupe: string }[];
      return new Map(rows.map((r) => [r.dedupe, r.id]));
    } finally {
      db.close();
    }
  }

  close(): void {
    this.store.close();
    rmSync(this.home, { recursive: true, force: true });
  }
}

/** The store a query from node q is scored against. The caller closes it. */
export const replayAsOf = (tree: Tree, q: ArchivedNode): ArchiveReplay => new ArchiveReplay(tree, asOfNodes(tree, q)).advanceTo();

// --- Labels ---

/** A changedFiles entry as a path relative to the repo: no worktree or checkout prefix, no "./", no " (note)". */
export function normalizeFile(f: string, repoCwd: string): string {
  let p = f.trim().replace(/\s+\(.*\)$/, '');
  const wt = p.indexOf('/.claude/worktrees/');
  if (wt >= 0) p = p.slice(wt + '/.claude/worktrees/'.length).replace(/^[^/]+\/?/, '');
  else if (p.startsWith(`${repoCwd}/`)) p = p.slice(repoCwd.length + 1);
  return p.replace(/^\.\//, '');
}

/** Files touched by more than `share` of the tree's nodes. */
export function hotFiles(tree: Tree, share = HOT_FILE_SHARE): Set<string> {
  const touched = new Map<string, number>();
  for (const a of tree.nodes) for (const f of new Set(files(a).map((x) => normalizeFile(x, tree.cwd)))) touched.set(f, (touched.get(f) ?? 0) + 1);
  return new Set([...touched].filter(([, n]) => n > share * tree.nodes.length).map(([f]) => f));
}

/** The archived nodes whose ledger items are relevant to node q: as-of nodes sharing a file with q, hot files dropped. */
export function labels(tree: Tree, q: ArchivedNode, hot = hotFiles(tree)): string[] {
  const own = new Set(files(q).map((f) => normalizeFile(f, tree.cwd)).filter((f) => !hot.has(f)));
  if (!own.size) return [];
  return asOfNodes(tree, q).filter((a) => files(a).some((f) => own.has(normalizeFile(f, tree.cwd)))).map((a) => a.id);
}
