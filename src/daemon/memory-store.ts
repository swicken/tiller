// The memory store: one SQLite file per account under <home>/memory, and the only module that loads node:sqlite. It
// loads lazily, in the first open, so a Node without the builtin only turns memory off. Methods the manager calls never
// throw (they log once per account and reason, and return empty); methods behind the tools throw errors to show as
// written. The store never checks the opt-in: its callers do, and a script using it directly writes whatever the config.
import type { DatabaseSync, SQLInputValue } from 'node:sqlite';
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, renameSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { MEMORY_ITEM_KINDS, type MemoryInjectionView, type MemoryItemDetail, type MemoryItemView } from '../shared/protocol.js';
import { claudeAccounts, type ClaudeAccount } from './claude-accounts.js';
import { loadConfig } from './config.js';
import { digestFor, oneLine } from './memory-digest.js';
import {
  accountKey, ADD_KINDS, contained, firstErrorLine, ftsTerms, GARDEN_KINDS, itemRef, keepRank, LIMITS, MIGRATIONS, normalizeDedupe,
  pinDedupe, redact, runRef, SCHEMA_V1, SCHEMA_VERSION,
  type Actor, type Arm, type Cause, type Derived, type DigestCandidates, type DigestRole, type DigestSource,
  type EpisodeKind, type EpisodeSkeleton, type GardenActionInput, type GardenActionKind, type GardenActionView, type GardenApplyResult,
  type GardenCandidate, type GardenPage, type GardenRefused, type GardenRule, type GardenRunStats, type GardenRunView, type GardenSnapshot,
  type GardenStore, type GardenTarget, type GardenTrigger, type GardenUndoneBy, type GardenUndoResult, type GardenUndoTarget,
  type HistoryEntry, type InjectionRow, type ItemKind, type ItemRow, type MemoryScope, type RunState,
} from './memory-schema.js';
import { logError } from './util.js';

const DAY = 86_400_000;
const MB = 1024 * 1024;
/** How long a read of claude.accounts is reused. */
const ACCOUNTS_TTL_MS = 2_000;
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

/** A refusal or a missing item, for the caller as written. Anything else a tool-facing method throws is "memory is unavailable". */
export class MemoryError extends Error {}
/** Why a file cannot be used; the reason without the "memory is unavailable: " prefix. */
class Unavailable extends Error {}

export interface MemoryStoreOptions {
  /** The clock for the rows the store stamps itself; scripts backdate with it. Episodes keep their own ts. */
  now?: () => number;
  /** Gets a string for an expected condition (quarantine, a blocked checkpoint, over the limit, unavailable), else the error itself. */
  log?: (err: unknown) => void;
}

/** One account file's health, for memory_status. */
export interface MemoryDbStatus {
  key: string;
  path: string;
  /** ok; missing (no file yet); or "off: <reason>" / "broken: <reason>". */
  state: string;
  schema?: number;
  /** The file and its WAL on disk. */
  sizeBytes?: number;
  /** (page_count - freelist_count) * page_size, the measure memory.maxMB limits. */
  usedBytes?: number;
  /** Still over memory.maxMB after the last eviction. */
  overLimit?: boolean;
  counts?: { items: Record<ItemKind, number>; retracted: number; tombstones: number; pinned: number; episodes: number; injections: number };
  /** Corrupt files set aside as <key>.corrupt-<ts>.db. */
  quarantined: string[];
}

/** One digest arm's metrics over the nodes whose first injection row falls in the window (null: no node to measure). */
export interface ArmStats {
  nodes: number;
  /** Of nodes that ran a gate, the share whose first run passed. */
  firstPassGate: number | null;
  /** Of nodes that reported, the share whose latest outcome failed. */
  failedOutcomes: number | null;
  /** Gate runs per node whose latest outcome succeeded. */
  gateRunsPerSuccess: number | null;
  /** Means over closed nodes. */
  spentUsd: number | null;
  wallMs: number | null;
  humanSendsPerNode: number | null;
  injectedItems: number;
  /** [m<id>] cites of a node's injected items in its outcomes, per injected item. */
  citesPerInjected: number | null;
  forgetsOfInjected: number;
  /** Failed gate runs whose first error line is in a pitfall recorded before the node launched, and of those in its digest. */
  repeatedPitfalls: number;
  repeatedInjectedPitfalls: number;
}

/** merged: the text's row was merged by the gardener, and id is the live keep its redirect ends on, counted again. */
export type AddResult = { id: number; existing?: true; revived?: true; merged?: true };
/** The panel's browse cursor: the last row's (updated_at, id). */
export interface ListCursor { updatedAt: number; id: number }
/** Live items per kind in one repository, plus its live pins and its retracted items (tombstones included). */
export type ItemCounts = Record<ItemKind, number> & { pinned: number; retracted: number };
export const noCounts = (): ItemCounts => ({ ...Object.fromEntries(MEMORY_ITEM_KINDS.map((k) => [k, 0])), pinned: 0, retracted: 0 }) as ItemCounts;

const EMPTY_CANDIDATES = (): DigestCandidates => ({ pins: [], ledger: [], openQuestions: [], procedures: [], pitfalls: [], notes: [], matched: [] });

// FTS queries join as `items_fts CROSS JOIN items`, which fixes the FTS index as the outer loop: one MATCH, then a rowid
// lookup per hit. Left to the planner, items can drive and re-run the MATCH for every row of the repo.

/** A MATCH expression from search terms (ftsTerms): each quoted, joined with OR, so no FTS5 syntax gets through; '' for none. */
export const ftsQuery = (terms: readonly string[]): string => terms.map((t) => `"${t.replaceAll('"', '""')}"`).join(' OR ');

/**
 * An item may enter a digest when the human or the daemon wrote it, when the tree's root did, or when its node's newest
 * outcome succeeded with no failed gate. Over `items i`.
 */
const ELIGIBLE = `(i.author IN ('human', 'daemon') OR i.node_id = i.root_id OR coalesce((
  SELECT json_extract(e.data, '$.outcome') = 'succeeded' AND coalesce(json_extract(e.data, '$.gate'), '') <> 'failed'
  FROM episodes e WHERE e.node_id = i.node_id AND e.kind = 'outcome' ORDER BY e.ts DESC, e.id DESC LIMIT 1), 0))`;

/** What eviction and purge keep of an episode's data: its metric fields, else {}. */
function skeleton(kind: string, data: Record<string, unknown>): Record<string, unknown> {
  const keep: { [K in keyof EpisodeSkeleton]: (keyof EpisodeSkeleton[K])[] } = {
    outcome: ['outcome', 'gate'],
    gate: ['ok', 'command'],
    close: ['spentUsd', 'createdAt', 'closedAt', 'branchFate', 'outcome', 'gate'],
  };
  const fields: string[] = keep[kind as keyof EpisodeSkeleton] ?? [];
  return Object.fromEntries(fields.filter((f) => data[f] !== undefined).map((f) => [f, data[f]]));
}

/** A human text pin (memory_pin { text }): its dedupe key is in the PIN: namespace. */
const isTextPin = (r: Pick<ItemRow, 'dedupe'>) => r.dedupe.startsWith('PIN:');

function view(r: ItemRow, withBody = false): MemoryItemView {
  return {
    id: r.id, kind: r.kind, text: r.text, ...(withBody ? { body: r.body } : {}), author: r.author,
    ...(r.node_id ? { nodeId: r.node_id } : {}), ...(r.root_id ? { rootId: r.root_id } : {}),
    ...(r.harness ? { harness: r.harness } : {}), ...(r.model ? { model: r.model } : {}),
    seen: r.seen, pinned: r.pinned === 1, cites: r.cites, gets: r.gets, createdAt: r.created_at, updatedAt: r.updated_at,
    ...(r.supersedes !== null ? { supersedes: r.supersedes } : {}),
    ...(r.invalid_at !== null && r.invalid_kind !== null ? { invalid: {
      at: r.invalid_at, kind: r.invalid_kind, ...(r.invalid_by ? { by: r.invalid_by } : {}), ...(r.invalid_reason ? { reason: r.invalid_reason } : {}),
    } } : {}),
    ...(r.invalid_kind === 'merged' && r.merged_into !== null ? { mergedInto: r.merged_into } : {}),
    ...(r.text === '' ? { tombstone: r.dedupe.startsWith('purged:') ? 'purged' as const : 'evicted' as const } : {}),
    ...(isTextPin(r) ? { textPin: true as const } : {}),
  };
}

/** A panel row, selected with `${ELIGIBLE} AS eligible`: without body, cites, gets and rootId. */
function rowView(r: ItemRow & { eligible: number }): MemoryItemView {
  const { cites: _cites, gets: _gets, rootId: _rootId, ...v } = view(r);
  return { ...v, eligible: r.eligible === 1 };
}

const injectionView = (r: InjectionRow): MemoryInjectionView =>
  ({ sessionId: r.session_id, arm: r.arm, cause: r.cause, itemIds: JSON.parse(r.item_ids) as number[], text: r.text, ts: r.ts });

const errcode = (err: unknown): number => ((err as { errcode?: number }).errcode ?? -1) & 0xff;
/** SQLITE_BUSY or SQLITE_LOCKED: another process holds the file for now. */
const locked = (err: unknown) => errcode(err) === 5 || errcode(err) === 6;

/** A file state for a read a tool-facing method failed: locked (try again) or off, with the reason. */
export function readFailure(err: unknown): string {
  const cause = (err as Error).cause ?? err;
  return `${locked(cause) ? 'locked' : 'off'}: ${(cause as Error).message ?? String(cause)}`;
}
const pragma = (db: DatabaseSync, name: string): number => Number(Object.values(db.prepare(`PRAGMA ${name}`).get() ?? {})[0] ?? 0);
const used = (db: DatabaseSync): number => (pragma(db, 'page_count') - pragma(db, 'freelist_count')) * pragma(db, 'page_size');

function tx<T>(db: DatabaseSync, fn: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    if (db.isTransaction) db.exec('ROLLBACK');
    throw err;
  }
}

// ---- The gardener's rows and pure helpers (memory v3, D6-D9).

/** A garden_runs row with its repository's key. */
interface RunRow {
  id: number; repo_id: number; repo_key: string; node_id: string | null; trigger: GardenTrigger; state: RunState; started_at: number;
  ended_at: number | null; heartbeat_at: number; watermark: number; model: string | null; cost_usd: number | null; cost_incomplete: number;
  stats: string; note: string | null;
}
const RUN_SQL = 'SELECT g.*, r.key AS repo_key FROM garden_runs g JOIN repos r ON r.id = g.repo_id';
interface ActionRow {
  id: number; run_id: number; ts: number; action: GardenActionKind; item_id: number; into_id: number | null; seen_delta: number;
  reason: string; undone_at: number | null; undone_by: GardenUndoneBy | null; immune: number;
}
type EligibleRow = ItemRow & { eligible: number };
type Refuse = (rule: GardenRule, message: string) => GardenRefused;
const GARDEN_IN = GARDEN_KINDS.map((k) => `'${k}'`).join(', ');
/** What a garden_list page keeps free for its header and page 1's clusters and hints, below LIMITS.garden.maxPageChars. */
const PROPOSALS_RESERVE = 20_000;

/** Why a candidate cannot be read or acted on now: hidden or tombstoned, or no longer ELIGIBLE. */
const unfit = (r: EligibleRow, refuse: Refuse): GardenRefused | undefined =>
  (r.invalid_at !== null ? refuse('not live', `${itemRef(r.id)} is ${r.text === '' ? 'tombstoned' : 'hidden'}`)
    : r.eligible ? undefined : refuse('ineligible', `${itemRef(r.id)} may no longer enter a digest`));

/** What a garden run may use as a merge keep or supersede by, never hide: a pinned, human-authored or ledger item (D8 rule 3). */
const protectedWhy = (r: ItemRow): string | undefined =>
  (r.pinned ? 'pinned' : r.author === 'human' ? "the human's" : r.kind === 'ledger' ? 'a ledger line' : undefined);
const gardenBy = (runId: number) => `gardener:${runRef(runId)}`;
/** A duration as "40m", "5h" or "12d". */
function since(ms: number): string {
  const min = Math.max(0, Math.floor(ms / 60_000));
  return min < 60 ? `${min}m` : min < 24 * 60 ? `${Math.floor(min / 60)}h` : `${Math.floor(min / (24 * 60))}d`;
}
const emptySnapshot = (): GardenSnapshot => ({ live: {}, digest: { ids: [], chars: 0 }, redundancy: 0 });

/**
 * The daemon's proposals over live, eligible rows (§3.4). clusters: union-find over same-kind pairs whose lower-ranked
 * member is hideable, not immune against the higher, and contained in it at minContained; each cluster is its keep
 * (keepRank) first, then the members that pass against that keep. hints: an open question or pitfall outside every
 * cluster, with at least minSupersedeTerms terms, and the newer same-kind item or ledger line containing the most of it.
 * immune holds "<item>:<into>" pairs.
 */
function propose(rows: ItemRow[], immune: Set<string>): { clusters: ItemRow[][]; hints: [ItemRow, ItemRow][] } {
  const g = LIMITS.garden;
  const terms = new Map(rows.map((r) => [r.id, ftsTerms(r.text, Infinity)]));
  const sets = new Map(rows.map((r) => [r.id, new Set(terms.get(r.id))]));
  // contained() (memory-schema.ts) over terms computed once per row: proposals compare every pair.
  const covers = (h: ItemRow, t: ItemRow) => {
    const ht = terms.get(h.id)!, ts = sets.get(t.id)!;
    return ht.length ? ht.filter((x) => ts.has(x)).length / ht.length : 0;
  };
  const passes = (m: ItemRow, keep: ItemRow) => !protectedWhy(m) && !immune.has(`${m.id}:${keep.id}`) && covers(m, keep) >= g.minContained;
  const parent = new Map<number, number>();
  const find = (x: number): number => {
    const p = parent.get(x) ?? x;
    if (p === x) return x;
    const root = find(p);
    parent.set(x, root);
    return root;
  };
  // prune: every pair of at most 2 × LIMITS.garden.candidates rows; bucket by shared term if the candidate limit grows.
  for (let i = 0; i < rows.length; i++) {
    for (let j = i + 1; j < rows.length; j++) {
      if (rows[i].kind !== rows[j].kind) continue;
      const [keep, m] = [rows[i], rows[j]].sort(keepRank);
      if (passes(m, keep)) parent.set(find(m.id), find(keep.id));
    }
  }
  const groups = new Map<number, ItemRow[]>();
  for (const r of rows) groups.set(find(r.id), [...(groups.get(find(r.id)) ?? []), r]);
  const clusters = [...groups.values()].flatMap((group) => {
    const [keep, ...rest] = group.sort(keepRank);
    const members = rest.filter((m) => passes(m, keep));
    return members.length ? [[keep, ...members]] : [];
  });
  const clustered = new Set(clusters.flat().map((r) => r.id));
  const hints: [ItemRow, ItemRow][] = [];
  for (const h of rows) {
    if ((h.kind !== 'open_question' && h.kind !== 'pitfall') || clustered.has(h.id) || protectedWhy(h) || terms.get(h.id)!.length < g.minSupersedeTerms) continue;
    let best: ItemRow | undefined, score: number = g.minContained;
    for (const by of rows) {
      if (by.created_at <= h.created_at || (by.kind !== h.kind && by.kind !== 'ledger') || immune.has(`${h.id}:${by.id}`)) continue;
      const c = covers(h, by);
      if (c > score || (c === score && (!best || by.created_at > best.created_at))) [best, score] = [by, c];
    }
    if (best) hints.push([h, best]);
  }
  return { clusters, hints };
}

function runView(r: RunRow): GardenRunView {
  return {
    id: r.id, repoKey: r.repo_key, ...(r.node_id ? { nodeId: r.node_id } : {}), trigger: r.trigger, state: r.state, startedAt: r.started_at,
    ...(r.ended_at !== null ? { endedAt: r.ended_at } : {}), heartbeatAt: r.heartbeat_at, watermark: r.watermark,
    ...(r.model ? { model: r.model } : {}), ...(r.cost_usd !== null ? { costUsd: r.cost_usd } : {}), costIncomplete: r.cost_incomplete === 1,
    ...(r.note ? { note: r.note } : {}), stats: JSON.parse(r.stats) as GardenRunStats,
  };
}

function actionView(a: ActionRow & { item_text?: string; into_text?: string | null }): GardenActionView {
  return {
    id: a.id, runId: a.run_id, ts: a.ts, action: a.action, itemId: a.item_id, ...(a.into_id !== null ? { intoId: a.into_id } : {}),
    seenDelta: a.seen_delta, reason: a.reason, ...(a.undone_at !== null ? { undoneAt: a.undone_at } : {}),
    ...(a.undone_by ? { undoneBy: a.undone_by } : {}), immune: a.immune === 1,
    ...(a.item_text !== undefined ? { itemText: a.item_text } : {}), ...(typeof a.into_text === 'string' ? { intoText: a.into_text } : {}),
  };
}

/** A garden_list item: text oneLine'd and capped, ages relative to now. */
const candidateView = (r: ItemRow, now: number): GardenCandidate => ({
  id: itemRef(r.id), kind: r.kind, text: oneLine(r.text, LIMITS.garden.text), age: since(now - r.created_at), lastSeen: since(now - r.updated_at),
  seen: r.seen, author: r.author, protected: protectedWhy(r) !== undefined,
});

/**
 * Replace rows by id with changed copies, deleting them first. An UPDATE that shrinks a row leaves its page as full as
 * before, while a DELETE rebalances the b-tree, so this is how eviction frees pages. Foreign keys are off for the batch,
 * so items keep their episode_id and supersedes; the triggers keep the FTS index in step.
 */
function rewrite(db: DatabaseSync, table: 'items' | 'episodes' | 'injections', rows: Record<string, SQLInputValue>[]): void {
  if (rows.length === 0) return;
  // PRAGMA foreign_keys is a no-op inside a transaction, where the DELETE would null episode_id and fail supersedes.
  if (db.isTransaction) throw new Error('rewrite() must run outside a transaction');
  const cols = Object.keys(rows[0]);
  db.exec('PRAGMA foreign_keys = OFF');
  try {
    tx(db, () => {
      const del = db.prepare(`DELETE FROM ${table} WHERE id = ?`);
      const ins = db.prepare(`INSERT INTO ${table} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`);
      for (const row of rows) del.run(row.id);
      for (const row of rows) ins.run(...cols.map((c) => row[c]));
    });
  } finally {
    db.exec('PRAGMA foreign_keys = ON');
  }
}

export class MemoryStore implements DigestSource, GardenStore {
  private readonly now: () => number;
  private readonly log: (err: unknown) => void;
  private sqlite?: typeof import('node:sqlite');
  /** Set when memory cannot work in this process at all: no node:sqlite, or no FTS5. */
  private off?: string;
  private readonly dbs = new Map<string, DatabaseSync>();
  /** Files that failed to open, retried after LIMITS.store.retryBrokenMs. */
  private readonly down = new Map<string, { state: 'off' | 'broken'; reason: string; at: number }>();
  private readonly logged = new Set<string>();
  private readonly overLimit = new Set<string>();
  private readonly checks = new Map<string, NodeJS.Immediate | undefined>();
  private readonly enforcing = new Set<string>();
  private accountsRead?: { at: number; value: ClaudeAccount[] | Error };

  constructor(readonly home: string, opts: MemoryStoreOptions = {}) {
    this.now = opts.now ?? Date.now;
    this.log = opts.log ?? logError;
  }

  /** The file of an account's memory. Throws for an account not in claude.accounts, or any named one while the list is invalid. */
  accountFile(account: string | undefined): string {
    return this.fileOf(this.keyOf(account));
  }

  // --- Manager-facing: never throw ---

  /** Append derive()'s episode and upsert its items, redacting everything again. Creates the file. */
  apply(scope: MemoryScope, derived: Derived): void {
    this.quiet(scope.account, undefined, () => {
      const { episode, cites } = redact(derived);
      // A dedupe key is lowercased text, which case-sensitive secret patterns (AKIA, AIza, eyJ...) no longer match:
      // derive it again from the redacted text, and redact any other key.
      const items = derived.items.map((it) => {
        const text = redact(it.text);
        return { ...it, text, body: redact(it.body), dedupe: it.dedupe === normalizeDedupe(it.kind, it.text) ? normalizeDedupe(it.kind, text) : redact(it.dedupe) };
      });
      const db = this.db(scope.account, true)!;
      tx(db, () => {
        const repo = this.repo(db, scope, true)!;
        const episodeId = this.episode(db, repo, scope, episode);
        for (const it of items) {
          this.upsert(db, {
            repo_id: repo, kind: it.kind, text: it.text, body: it.body ?? '', author: it.author, dedupe: it.dedupe,
            node_id: scope.nodeId ?? null, root_id: scope.rootId ?? null, harness: scope.harness ?? null, model: scope.model ?? null,
            episode_id: episodeId, now: episode.ts,
          });
        }
        if (cites.length) {
          db.prepare('UPDATE items SET cites = cites + 1 WHERE repo_id = ? AND id IN (SELECT value FROM json_each(?))').run(repo, JSON.stringify([...new Set(cites)]));
        }
      });
    });
  }

  /** The node's episodes since its latest outcome, oldest first: derive()'s history. */
  nodeHistory(scope: MemoryScope, nodeId: string): HistoryEntry[] {
    return this.quiet(scope.account, [], () => {
      const db = this.db(scope.account, false);
      if (!db) return [];
      const rows = db.prepare(`SELECT kind, ts, data FROM episodes WHERE node_id = :node
        AND id > coalesce((SELECT max(id) FROM episodes WHERE node_id = :node AND kind = 'outcome'), 0) ORDER BY id`).all({ node: nodeId });
      return rows.map((r) => ({ kind: r.kind, ts: r.ts, data: JSON.parse(String(r.data)) }) as HistoryEntry);
    });
  }

  /** The digest's eligible, valid candidates (DigestSource). The open-question window and procedure recency use `now`. */
  candidates(scope: MemoryScope, q: { role: DigestRole; terms: string[]; now: number }): DigestCandidates {
    return this.quiet(scope.account, EMPTY_CANDIDATES(), () => {
      const db = this.db(scope.account, false);
      if (!db) return EMPTY_CANDIDATES();
      const repo = this.repo(db, scope, false) ?? -1;
      const c = LIMITS.candidates;
      const list = (where: string, limit: number, params: Record<string, SQLInputValue> = {}) => (db.prepare(
        `SELECT i.* FROM items i WHERE i.invalid_at IS NULL AND ${where} ORDER BY i.updated_at DESC, i.id DESC LIMIT ${limit}`,
      ).all({ repo, ...params }) as unknown as ItemRow[]).map((r) => view(r));
      const kind = (k: ItemKind) => `i.kind = '${k}' AND i.repo_id = :repo AND i.pinned = 0 AND ${ELIGIBLE}`;
      const halfLife = LIMITS.procedure.halfLifeDays * DAY;
      const weight = (v: MemoryItemView) => v.seen * 0.5 ** ((q.now - v.updatedAt) / halfLife);
      const terms = ftsQuery(q.terms);
      return {
        pins: list('i.repo_id = :repo AND i.pinned = 1', c.pins),
        ledger: list(`i.kind = 'ledger' AND (i.repo_id = :repo OR i.root_id = :root) AND i.pinned = 0 AND ${ELIGIBLE}`, c.ledger, { root: scope.rootId ?? null }),
        openQuestions: list(`${kind('open_question')} AND i.updated_at >= :since`, c.openQuestions, { since: q.now - c.openQuestionDays * DAY }),
        // prune: ranked in JS over every eligible procedure in the repo; rank in SQL if a repo gathers thousands.
        procedures: list(kind('procedure'), -1).sort((a, b) => weight(b) - weight(a)).slice(0, c.procedures),
        pitfalls: list(kind('pitfall'), c.pitfalls),
        notes: list(kind('note'), c.notes),
        // An item is related only when it matches at least two of the terms (or the one there is), so a single shared
        // word does not make it related (bench D-2).
        // prune: one MATCH per term, counted over the whole file; restrict to the repo if term lists or files grow large.
        matched: q.role === 'worker' && terms ? (db.prepare(`SELECT i.* FROM items_fts CROSS JOIN items i ON i.id = items_fts.rowid
          WHERE items_fts MATCH :terms AND i.repo_id = :repo AND i.kind IN ('ledger', 'procedure', 'pitfall', 'note')
            AND i.invalid_at IS NULL AND i.pinned = 0 AND ${ELIGIBLE}
            AND i.id IN (SELECT rowid FROM (${q.terms.map((_, n) => `SELECT rowid FROM items_fts WHERE items_fts MATCH :t${n}`).join(' UNION ALL ')})
              GROUP BY rowid HAVING count(*) >= :need)
          ORDER BY bm25(items_fts) LIMIT ${c.matched}`).all({
          terms, repo, need: Math.min(2, q.terms.length), ...Object.fromEntries(q.terms.map((t, n) => [`t${n}`, ftsQuery([t])])),
        }) as unknown as ItemRow[]).map((r) => view(r)) : [],
      };
    });
  }

  /** The newest fresh (non-resume) injection of a session, which a resume reuses; undefined when none or on any failure. */
  frozen(account: string | undefined, sessionId: string): MemoryInjectionView | undefined {
    return this.quiet(account, undefined, () => {
      const row = this.db(account, false)?.prepare(
        `SELECT * FROM injections WHERE session_id = ? AND cause <> 'resume' ORDER BY ts DESC, id DESC LIMIT 1`,
      ).get(sessionId) as InjectionRow | undefined;
      return row && injectionView(row);
    });
  }

  /** Record one launch's digest decision for the scope's node. Creates the file. */
  recordInjection(scope: MemoryScope, inj: { sessionId: string; arm: Arm; cause: Cause; itemIds: number[]; text: string }): void {
    this.quiet(scope.account, undefined, () => {
      const db = this.db(scope.account, true)!;
      tx(db, () => {
        db.prepare(`INSERT INTO injections (ts, session_id, node_id, root_id, repo_id, arm, cause, role, profile, harness, model, item_ids, text)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
          this.now(), inj.sessionId, scope.nodeId ?? '', scope.rootId ?? scope.nodeId ?? '', this.repo(db, scope, true)!, inj.arm, inj.cause,
          scope.role ?? null, scope.profile ?? null, scope.harness ?? null, scope.model ?? null, JSON.stringify(inj.itemIds), redact(inj.text),
        );
      });
    });
  }

  /** Each account file's health: one account's, or every existing file's. Opens existing files only. brief: state only, no sizes or counts. */
  status(account?: string, brief = false): MemoryDbStatus[] {
    return account === undefined ? this.existingKeys().map((key) => this.statusOf(key, brief)) : [this.fileStatus(account, brief)];
  }

  /** One account file's health; undefined is the no-account file. Opens an existing file only. brief: state only. */
  fileStatus(account: string | undefined, brief = false): MemoryDbStatus {
    let key: string;
    try {
      key = this.keyOf(account);
    } catch (err) {
      return { key: account ?? '', path: '', state: `off: ${(err as Error).message}`, quarantined: [] };
    }
    return this.statusOf(key, brief);
  }

  /**
   * Enforce memory.maxMB on every account file that exists: past the limit, evict old content in order until the file
   * is under 0.9 x the limit, then reclaim the space. Batches yield to the event loop. Never creates a file or rejects.
   */
  async enforceLimit(maxMB: number): Promise<void> {
    for (const key of this.existingKeys()) await this.enforce(key, maxMB);
  }

  // --- Tool-facing: throw MemoryError as written, else "memory is unavailable: <reason>" ---

  /**
   * FTS over the repository's items, best match first. Terms are ORed (ftsQuery), so a query of stopwords only finds
   * nothing. pinned keeps pinned items only; eligible returns panel rows (rowView). The tools cap limit at
   * LIMITS.tools.search.max in zod; the panel asks for up to LIMITS.panel.page.
   */
  search(scope: MemoryScope, q: { query: string; kind?: ItemKind; pinned?: boolean; limit?: number; includeRetracted?: boolean; eligible?: boolean }): MemoryItemView[] {
    return this.loud(() => {
      const db = this.db(scope.account, false);
      const repo = db && this.repo(db, scope, false);
      const terms = ftsQuery(ftsTerms(q.query));
      if (!db || repo === undefined || !terms) return [];
      const rows = db.prepare(`SELECT i.*${q.eligible ? `, ${ELIGIBLE} AS eligible` : ''} FROM items_fts CROSS JOIN items i ON i.id = items_fts.rowid
        WHERE items_fts MATCH :terms AND i.repo_id = :repo ${q.kind ? 'AND i.kind = :kind' : ''} ${q.pinned ? 'AND i.pinned = 1' : ''}
          ${q.includeRetracted ? '' : 'AND i.invalid_at IS NULL'}
        ORDER BY bm25(items_fts) LIMIT :limit`).all({
        terms, repo, ...(q.kind ? { kind: q.kind } : {}), limit: Math.min(q.limit ?? LIMITS.tools.search.default, LIMITS.panel.page),
      }) as unknown as (ItemRow & { eligible: number })[];
      return rows.map((r) => (q.eligible ? rowView(r) : view(r)));
    });
  }

  /**
   * The panel's browse: the repository's items newest first (updated_at, then id), after `before` when given. pinned
   * keeps pinned items only; retracted includes retracted ones. Rows are rowView's; next is set when more follow.
   */
  list(scope: MemoryScope, q: { kind?: ItemKind; pinned?: boolean; retracted?: boolean; before?: ListCursor; limit?: number }): { items: MemoryItemView[]; next?: ListCursor } {
    return this.loud(() => {
      const db = this.db(scope.account, false);
      const repo = db && this.repo(db, scope, false);
      if (!db || repo === undefined) return { items: [] };
      const limit = Math.min(q.limit ?? LIMITS.panel.page, LIMITS.panel.page);
      // The page's ids first, so ELIGIBLE runs for its rows only.
      const rows = db.prepare(`SELECT i.*, ${ELIGIBLE} AS eligible FROM items i WHERE i.id IN (SELECT id FROM items WHERE repo_id = :repo
        ${q.kind ? 'AND kind = :kind' : ''} ${q.pinned ? 'AND pinned = 1' : ''} ${q.retracted ? '' : 'AND invalid_at IS NULL'}
        ${q.before ? 'AND (updated_at, id) < (:at, :id)' : ''} ORDER BY updated_at DESC, id DESC LIMIT ${limit + 1})
        ORDER BY i.updated_at DESC, i.id DESC`).all({
        repo, ...(q.kind ? { kind: q.kind } : {}), ...(q.before ? { at: q.before.updatedAt, id: q.before.id } : {}),
      }) as unknown as (ItemRow & { eligible: number })[];
      const items = rows.slice(0, limit).map(rowView), last = items.at(-1);
      return rows.length > limit && last ? { items, next: { updatedAt: last.updatedAt, id: last.id } } : { items };
    });
  }

  /** The repository's live items per kind, its live pins and its retracted items, tombstones included. */
  counts(scope: MemoryScope): ItemCounts {
    return this.loud(() => {
      const counts = noCounts();
      const db = this.db(scope.account, false);
      const repo = db && this.repo(db, scope, false);
      if (!db || repo === undefined) return counts;
      for (const r of db.prepare('SELECT kind, count(*) AS n FROM items WHERE repo_id = ? AND invalid_at IS NULL GROUP BY kind').all(repo) as { kind: ItemKind; n: number }[]) {
        counts[r.kind] = Number(r.n);
      }
      const r = db.prepare(`SELECT coalesce(sum(invalid_at IS NULL AND pinned = 1), 0) AS pinned, coalesce(sum(invalid_at IS NOT NULL), 0) AS retracted
        FROM items WHERE repo_id = ?`).get(repo) as { pinned: number; retracted: number };
      return { ...counts, pinned: Number(r.pinned), retracted: Number(r.retracted) };
    });
  }

  /** The file's repositories with their live item counts, oldest first; path is the first path recorded for the key. */
  repos(account: string | undefined): { key: string; path: string; items: number }[] {
    return this.loud(() => (this.db(account, false)?.prepare(`SELECT r.key, r.path,
      (SELECT count(*) FROM items i WHERE i.repo_id = r.id AND i.invalid_at IS NULL) AS items
      FROM repos r WHERE r.key <> 'account:' ORDER BY r.id`).all() as { key: string; path: string; items: number }[] | undefined ?? [])
      .map((r) => ({ key: r.key, path: r.path, items: Number(r.items) })));
  }

  /** One item in full for the panel, with eligible, its newest superseder and the digests that gave it; the read is not counted. */
  peek(scope: MemoryScope, id: number): MemoryItemDetail {
    return this.loud(() => {
      const db = this.db(scope.account, false);
      const repo = db && this.repo(db, scope, false);
      const row = db && repo !== undefined
        ? db.prepare(`SELECT i.*, ${ELIGIBLE} AS eligible FROM items i WHERE i.id = ? AND i.repo_id = ?`).get(id, repo) as (ItemRow & { eligible: number }) | undefined
        : undefined;
      if (!db || !row) throw new MemoryError(`no such item ${itemRef(id)}`);
      // prune: no index on supersedes, so this scans the repository's items; index it in a later schema version if bench M1's item read grows.
      // Only a hidden item is superseded: a live one was brought back after its superseder was recorded.
      const by = row.invalid_at === null ? undefined
        : db.prepare('SELECT id FROM items WHERE supersedes = ? AND repo_id = ? ORDER BY id DESC LIMIT 1').get(id, row.repo_id) as { id: number } | undefined;
      const givenTo = db.prepare(`SELECT node_id, session_id, arm, ts FROM injections, json_each(item_ids)
        WHERE json_each.value = ? AND cause <> 'resume' ORDER BY ts DESC, injections.id DESC LIMIT ${LIMITS.panel.givenTo}`).all(id) as
        { node_id: string; session_id: string; arm: Arm; ts: number }[];
      return {
        item: { ...view(row, true), eligible: row.eligible === 1 }, ...(by ? { supersededBy: Number(by.id) } : {}),
        givenTo: givenTo.map((g) => ({ nodeId: g.node_id, sessionId: g.session_id, arm: g.arm, ts: g.ts })),
      };
    });
  }

  /** One item in full, counting the read. Another repository's item is "no such item". */
  get(scope: MemoryScope, id: number): MemoryItemView {
    return this.loud(() => {
      const db = this.db(scope.account, false);
      const repo = db && this.repo(db, scope, false);
      if (!db || repo === undefined) throw new MemoryError(`no such item ${itemRef(id)}`);
      const row = this.item(db, repo, id);
      db.prepare('UPDATE items SET gets = gets + 1 WHERE id = ?').run(id);
      return view({ ...row, gets: row.gets + 1 }, true);
    });
  }

  /** memory_add. An agent may add LIMITS.perNode.adds; its supersedes hides the older item until later work records it again. */
  add(scope: MemoryScope, actor: Actor, input: { kind: ItemKind; text: string; body?: string; supersedes?: number }): AddResult {
    return this.loud(() => {
      if (!(ADD_KINDS as readonly string[]).includes(input.kind)) throw new MemoryError(`memory_add records ${ADD_KINDS.join(', ')}, not ${input.kind}`);
      const text = redact(input.text.trim()), body = redact(input.body ?? '');
      if (!text || text.length > LIMITS.item.text) throw new MemoryError(`text must be 1-${LIMITS.item.text} characters`);
      if (body.length > LIMITS.item.body) throw new MemoryError(`body must be at most ${LIMITS.item.body} characters`);
      const db = this.db(scope.account, true)!;
      return tx(db, () => {
        const repo = this.repo(db, scope, true)!;
        if (actor.kind === 'agent') this.cap(db, actor.nodeId, 'add', LIMITS.perNode.adds, 'memory_add');
        const old = input.supersedes === undefined ? undefined : this.item(db, repo, input.supersedes);
        if (old && actor.kind === 'agent' && old.pinned) throw new MemoryError(`${itemRef(old.id)} is pinned; pinned items are the human's to change`);
        const who = this.who(actor);
        const result = this.upsert(db, {
          repo_id: repo, kind: input.kind, text, body, author: actor.kind === 'human' ? 'human' : 'agent', dedupe: normalizeDedupe(input.kind, text),
          node_id: who.node_id, root_id: who.root_id, harness: who.harness, model: who.model, episode_id: null, now: this.now(),
        });
        if ('sticky' in result) throw new MemoryError(`retracted by the human as ${itemRef(result.sticky)}; not re-added`);
        const episodeId = this.episode(db, repo, { ...scope, ...this.episodeScope(actor) }, { kind: 'add', ts: this.now(), data: { itemId: result.id, actor: who.actor } });
        if (!result.existing) db.prepare('UPDATE items SET episode_id = ? WHERE id = ?').run(episodeId, result.id);
        if (old && old.id !== result.id) {
          db.prepare('UPDATE items SET supersedes = ? WHERE id = ?').run(old.id, result.id);
          if (actor.kind === 'human' || old.invalid_at === null) {
            this.invalidate(db, old.id, actor.kind === 'human' ? 'superseded' : 'agent', who.actor, `superseded by ${itemRef(result.id)}`);
          }
        }
        return result;
      });
    });
  }

  /**
   * memory_forget. An agent's retraction (at most LIMITS.perNode.forgets) lasts until later work records the item again;
   * the human's is permanent. purge (human only) also blanks the item's episode and siblings and removes the bytes.
   */
  forget(scope: MemoryScope, actor: Actor, input: { id: number; reason: string; purge?: boolean }): MemoryItemView {
    return this.loud(() => {
      if (input.purge && actor.kind !== 'human') throw new MemoryError('only the human can purge');
      const reason = redact(input.reason.trim()).slice(0, LIMITS.tools.reason);
      const db = this.db(scope.account, false);
      const repo = db && this.repo(db, scope, false);
      if (!db || repo === undefined) throw new MemoryError(`no such item ${itemRef(input.id)}`);
      const who = this.who(actor);
      const row = tx(db, () => {
        const item = this.item(db, repo, input.id);
        if (actor.kind === 'agent') {
          if (item.pinned) throw new MemoryError(`${itemRef(item.id)} is pinned; pinned items are the human's to change`);
          if (item.invalid_at !== null) throw new MemoryError(`${itemRef(item.id)} is already retracted`);
          this.cap(db, actor.nodeId, 'forget', LIMITS.perNode.forgets, 'memory_forget');
        }
        this.episode(db, repo, { ...scope, ...this.episodeScope(actor) }, { kind: 'forget', ts: this.now(), data: { itemId: item.id, actor: who.actor, reason } });
        if (input.purge) this.purge(db, item, reason);
        else this.invalidate(db, item.id, actor.kind === 'human' ? 'human' : 'agent', who.actor, reason);
        return this.item(db, repo, item.id);
      });
      if (input.purge) this.scrub(db, this.keyOf(scope.account));
      return view(row, true);
    });
  }

  /** memory_pin (human only): pin an item by id, restoring it if retracted, or pin new text as a human note; unpin undoes either. */
  pin(scope: MemoryScope, actor: Actor, input: { id?: number; text?: string; unpin?: boolean }): MemoryItemView {
    return this.loud(() => {
      if (actor.kind !== 'human') throw new MemoryError('only the human can pin');
      if ((input.id === undefined) === (input.text === undefined)) throw new MemoryError('memory_pin takes exactly one of id and text');
      const text = input.text === undefined ? undefined : redact(input.text.trim());
      if (text !== undefined && (!text || text.length > LIMITS.tools.pinText)) throw new MemoryError(`text must be 1-${LIMITS.tools.pinText} characters`);
      const db = this.db(scope.account, !input.unpin && text !== undefined);
      const repo = db && this.repo(db, scope, !input.unpin && text !== undefined);
      if (!db || repo === undefined) throw new MemoryError(input.id === undefined ? 'no such pin' : `no such item ${itemRef(input.id)}`);
      const row = tx(db, () => {
        let id = input.id;
        if (text !== undefined) {
          const dedupe = pinDedupe(text);
          id = (db.prepare(`SELECT id FROM items WHERE repo_id = ? AND kind = 'note' AND dedupe = ?`).get(repo, dedupe) as { id: number } | undefined)?.id;
          if (id === undefined && input.unpin) throw new MemoryError('no such pin');
          id ??= Number((db.prepare(`INSERT INTO items (repo_id, kind, text, author, dedupe, pinned, created_at, updated_at)
            VALUES (?, 'note', ?, 'human', ?, 1, ?, ?) RETURNING id`).get(repo, text, dedupe, this.now(), this.now()) as { id: number }).id);
        }
        const item = this.item(db, repo, id!);
        if (!input.unpin && item.text === '') throw new MemoryError(`${itemRef(item.id)} was ${view(item).tombstone}; its text is gone`);
        if (input.unpin) {
          db.prepare('UPDATE items SET pinned = 0, updated_at = ? WHERE id = ?').run(this.now(), item.id);
          // A text pin exists only as a pin: unpinned, by text or by id, it is the human's retracted note.
          if (isTextPin(item)) this.invalidate(db, item.id, 'human', 'human', 'unpinned');
        } else {
          // A gardener hide is undone as the human's undo would (the keep's seen restored); pinning then clears immunities.
          const action = this.gardened(db, item);
          if (action) this.undoActions(db, [action], 'human', false);
          db.prepare(`UPDATE items SET pinned = 1, updated_at = ?, invalid_at = NULL, invalid_kind = NULL, invalid_by = NULL, invalid_reason = NULL,
            merged_into = NULL WHERE id = ?`).run(this.now(), item.id);
        }
        // Pinning or unpinning an item clears its garden immunities (D7).
        db.prepare('UPDATE garden_actions SET immune = 0 WHERE immune = 1 AND (item_id = ? OR into_id = ?)').run(item.id, item.id);
        this.episode(db, repo, { ...scope, nodeId: 'human', rootId: 'human' }, { kind: 'pin', ts: this.now(), data: { itemId: item.id, ...(input.unpin ? { unpin: true } : {}) } });
        return this.item(db, repo, item.id);
      });
      return view(row, true);
    });
  }

  /**
   * The human's restore of an item hidden by an agent's or the human's retraction or supersede; pinned stays as it is.
   * A gardener hide is undone instead, as `tl memory garden undo m<id>` does, which makes that pair immune. Refuses live
   * items, tombstones, text pins (pinning the text again revives one) and any other kind of hiding.
   */
  restore(scope: MemoryScope, actor: Actor, input: { id: number }): MemoryItemView {
    return this.loud(() => {
      if (actor.kind !== 'human') throw new MemoryError('only the human can restore');
      const db = this.db(scope.account, false);
      const repo = db && this.repo(db, scope, false);
      if (!db || repo === undefined) throw new MemoryError(`no such item ${itemRef(input.id)}`);
      const row = tx(db, () => {
        const item = this.item(db, repo, input.id), ref = itemRef(item.id);
        if (item.invalid_at === null) throw new MemoryError(`${ref} is not retracted`);
        if (item.text === '') throw new MemoryError(`${ref} was ${view(item).tombstone}; its text is gone`);
        if (isTextPin(item)) throw new MemoryError(`${ref} is a text pin; pin it again instead`);
        const action = this.gardened(db, item);
        if (action) {
          const result = this.undoActions(db, [action], 'human', true);
          if (!result.undone.length) throw new MemoryError(`cannot restore ${ref}: ${result.skipped[0].reason}`);
        } else if (!['agent', 'human', 'superseded'].includes(item.invalid_kind!)) {
          throw new MemoryError(`cannot restore a ${item.invalid_kind} item here`);
        } else {
          // updated_at: it comes back at the top of the panel's browse.
          db.prepare(`UPDATE items SET invalid_at = NULL, invalid_kind = NULL, invalid_by = NULL, invalid_reason = NULL, merged_into = NULL,
            updated_at = ? WHERE id = ?`).run(this.now(), item.id);
        }
        this.episode(db, repo, { ...scope, ...this.episodeScope(actor) }, { kind: 'restore', ts: this.now(), data: { itemId: item.id, actor: 'human' } });
        return this.item(db, repo, item.id);
      });
      return view(row, true);
    });
  }

  /**
   * The human's edit of their own text pin O to new text: the pin of that text (its PIN: row revived when one exists,
   * else inserted) supersedes O, which is unpinned and hidden as superseded. Pinning O's text again revives O.
   */
  editPin(scope: MemoryScope, actor: Actor, input: { id: number; text: string }): MemoryItemView {
    return this.loud(() => {
      if (actor.kind !== 'human') throw new MemoryError('only the human can pin');
      const text = redact(input.text.trim());
      if (!text || text.length > LIMITS.tools.pinText) throw new MemoryError(`text must be 1-${LIMITS.tools.pinText} characters`);
      const db = this.db(scope.account, false);
      const repo = db && this.repo(db, scope, false);
      if (!db || repo === undefined) throw new MemoryError(`no such item ${itemRef(input.id)}`);
      const row = tx(db, () => {
        const old = this.item(db, repo, input.id);
        if (old.invalid_at !== null || !old.pinned || old.author !== 'human' || !isTextPin(old)) {
          throw new MemoryError('only your own text pins can be edited; pin new text instead');
        }
        const dedupe = pinDedupe(text);
        if (dedupe === old.dedupe) throw new MemoryError('unchanged');
        const now = this.now();
        // One row per PIN: key: revive it whatever its state, so the edit never hits the UNIQUE constraint.
        const found = db.prepare(`SELECT * FROM items WHERE repo_id = ? AND kind = 'note' AND dedupe = ?`).get(repo, dedupe) as ItemRow | undefined;
        if (found && found.invalid_at === null && found.pinned) throw new MemoryError(`already pinned as ${itemRef(found.id)}`);
        let id: number;
        if (found) {
          db.prepare(`UPDATE items SET text = ?, body = '', pinned = 1, updated_at = ?,
            invalid_at = NULL, invalid_kind = NULL, invalid_by = NULL, invalid_reason = NULL WHERE id = ?`).run(text, now, found.id);
          id = found.id;
        } else {
          id = Number((db.prepare(`INSERT INTO items (repo_id, kind, text, author, dedupe, pinned, created_at, updated_at)
            VALUES (?, 'note', ?, 'human', ?, 1, ?, ?) RETURNING id`).get(repo, text, dedupe, now, now) as { id: number }).id);
        }
        db.prepare('UPDATE items SET supersedes = ? WHERE id = ?').run(old.id, id);
        // Editing back to an earlier text: the old pin no longer supersedes the one it now gives way to (no cycle).
        db.prepare('UPDATE items SET pinned = 0, updated_at = ?, supersedes = CASE WHEN supersedes = ? THEN NULL ELSE supersedes END WHERE id = ?').run(now, id, old.id);
        this.invalidate(db, old.id, 'superseded', 'human', `edited as ${itemRef(id)}`);
        this.episode(db, repo, { ...scope, nodeId: 'human', rootId: 'human' }, { kind: 'pin', ts: now, data: { itemId: id } });
        return this.item(db, repo, id);
      });
      return view(row, true);
    });
  }

  /** A node's injection rows, oldest first (memory_status { nodeId }); with newest, only that many, newest first (the panel). */
  injections(account: string | undefined, nodeId: string, newest?: number): MemoryInjectionView[] {
    const sql = newest === undefined ? 'ORDER BY ts, id' : `ORDER BY ts DESC, id DESC LIMIT ${Math.trunc(newest)}`;
    return this.loud(() => (this.db(account, false)?.prepare(`SELECT * FROM injections WHERE node_id = ? ${sql}`)
      .all(nodeId) as InjectionRow[] | undefined ?? []).map(injectionView));
  }

  /** The digest arms compared over the nodes whose first fresh injection is within `days` (memory_status). */
  stats(account: string | undefined, days: number): Record<Arm, ArmStats> {
    return this.loud(() => {
      const db = this.db(account, false);
      const firsts = (db?.prepare(`SELECT * FROM injections j WHERE cause <> 'resume' AND ts >= ?
        AND id = (SELECT min(id) FROM injections k WHERE k.node_id = j.node_id AND k.cause <> 'resume')`).all(this.now() - days * DAY) ?? []) as unknown as InjectionRow[];
      const of = (arm: Arm) => this.armStats(db as DatabaseSync, firsts.filter((r) => r.arm === arm)); // no file: no rows to read
      return { on: of('on'), off: of('off') };
    });
  }

  /** Copy an account's memory to a new file with VACUUM INTO, uncheckpointed WAL content included. For scripts; it blocks. */
  snapshot(account: string | undefined, path: string): void {
    this.loud(() => {
      const db = this.db(account, false);
      if (!db) throw new MemoryError(`no memory file for ${this.keyOf(account)}`);
      try {
        closeSync(openSync(path, 'wx', 0o600)); // VACUUM INTO fills an empty file and keeps its mode
      } catch (err) {
        throw new MemoryError(`cannot create ${path}: ${(err as Error).message}`);
      }
      db.prepare('VACUUM INTO ?').run(path);
    });
  }

  // --- The gardener (GardenStore, memory-schema.ts). Tool-facing: they throw as the methods above. ---

  /** Every repository of every existing account file; a file that cannot be read is logged and left out. */
  gardenTargets(): GardenTarget[] {
    return this.existingKeys().flatMap((key) => this.quiet(key, [], () => {
      const db = this.handle(key, false);
      if (!db) return [];
      const repos = db.prepare(`SELECT id, key, path FROM repos WHERE key <> 'account:' ORDER BY id`).all() as { id: number; key: string; path: string }[];
      return repos.map((repo) => {
        const recent = (db.prepare(`${RUN_SQL} WHERE g.repo_id = ? AND g.state <> 'skipped' ORDER BY g.id DESC LIMIT ${LIMITS.garden.recentRuns}`)
          .all(repo.id) as unknown as RunRow[]).map(runView);
        const mark = recent[0]?.watermark ?? 0;
        const newItems = Number((db.prepare(`SELECT count(*) AS n FROM items i WHERE i.repo_id = ? AND i.id > ? AND i.invalid_at IS NULL
          AND i.pinned = 0 AND i.kind IN (${GARDEN_IN}) AND ${ELIGIBLE}`).get(repo.id, mark) as { n: number }).n);
        const p = newItems ? this.freeze(db, repo.id).proposals : { clusters: [], hints: [] };
        const proposals = p.clusters.filter((c) => c.some((r) => r.id > mark)).length + p.hints.filter(([h, by]) => h.id > mark || by.id > mark).length;
        return { key, repoKey: repo.key, repoPath: repo.path, newItems, proposals, recent };
      });
    }));
  }

  startRun(scope: MemoryScope, input: { trigger: GardenTrigger; model: string }): { ok: true; run: GardenRunView } | { ok: false; reason: string } {
    return this.loud(() => {
      const db = this.db(scope.account, false);
      const repo = db && this.repo(db, scope, false);
      if (!db || repo === undefined) return { ok: false, reason: 'no memory for this repository yet' };
      return tx(db, () => {
        const g = LIMITS.garden, now = this.now();
        const held = db.prepare(`SELECT id FROM garden_runs WHERE state = 'running' AND heartbeat_at > ? ORDER BY id DESC LIMIT 1`)
          .get(now - g.leaseMs) as { id: number } | undefined;
        if (held) return { ok: false as const, reason: `garden run ${runRef(held.id)} holds this memory file's lease` };
        const { items, ids, proposals } = this.freeze(db, repo);
        const stats: GardenRunStats = {
          candidates: ids, maxHides: Math.min(g.maxHides, Math.ceil(g.maxHideShare * items.filter((r) => !protectedWhy(r)).length)),
          before: this.gardenSnapshot(db, scope, repo, proposals.clusters), refused: {}, calls: 0, outputChars: 0,
        };
        const id = Number((db.prepare(`INSERT INTO garden_runs (repo_id, trigger, state, started_at, heartbeat_at, watermark, model, stats)
          VALUES (?, ?, 'running', ?, ?, (SELECT coalesce(max(id), 0) FROM items), ?, ?) RETURNING id`)
          .get(repo, input.trigger, now, now, input.model, JSON.stringify(stats)) as { id: number }).id);
        return { ok: true as const, run: runView(this.runRow(db, id)) };
      });
    });
  }

  skipRun(scope: MemoryScope, input: { trigger: GardenTrigger; note: string }): void {
    this.loud(() => {
      const db = this.db(scope.account, false);
      const repo = db && this.repo(db, scope, false);
      if (!db || repo === undefined) return;
      tx(db, () => {
        const last = db.prepare('SELECT state, note FROM garden_runs WHERE repo_id = ? ORDER BY id DESC LIMIT 1').get(repo) as { state: string; note: string | null } | undefined;
        if (last?.state === 'skipped' && last.note === input.note) return;
        const now = this.now();
        const stats: GardenRunStats = { candidates: [], maxHides: 0, before: emptySnapshot(), refused: {}, calls: 0, outputChars: 0 };
        db.prepare(`INSERT INTO garden_runs (repo_id, trigger, state, started_at, ended_at, heartbeat_at, watermark, stats, note)
          VALUES (?, ?, 'skipped', ?, ?, ?, (SELECT coalesce(max(id), 0) FROM items), ?, ?)`).run(repo, input.trigger, now, now, now, JSON.stringify(stats), input.note);
      });
    });
  }

  heartbeat(account: string | undefined, runId: number): void {
    this.loud(() => this.setRun(account, runId, 'heartbeat_at = :now', { now: this.now() }, `AND state = 'running'`));
  }

  setRunNode(account: string | undefined, runId: number, nodeId: string): void {
    this.loud(() => this.setRun(account, runId, 'node_id = :node', { node: nodeId }));
  }

  gardenPage(account: string | undefined, runId: number, q: { cursor?: string; callsLeft: number }): GardenPage | GardenRefused {
    return this.gardenCall(account, runId, (db, run, stats) => {
      const g = LIMITS.garden, now = this.now(), n = q.cursor ? Number(q.cursor.slice(1)) : 1;
      const rows = this.rowsOf(db, run.repo_id, stats.candidates);
      // Pages cut the frozen set, hidden items included, so a cursor names the same items all run long.
      const pages: EligibleRow[][] = [];
      let chars = 0;
      for (const r of rows) {
        const len = JSON.stringify(candidateView(r, now)).length + 1, last = pages.at(-1);
        if (last && last.length < g.page && chars + len <= g.maxPageChars - PROPOSALS_RESERVE) {
          last.push(r);
          chars += len;
        } else {
          pages.push([r]);
          chars = len;
        }
      }
      const shown = (r: EligibleRow) => r.invalid_at === null && r.eligible === 1;
      const p = n === 1 ? propose(rows.filter(shown), this.immunePairs(db)) : { clusters: [], hints: [] };
      return {
        run: runRef(run.id), page: n, pages: Math.max(1, pages.length), ...(n < pages.length ? { next: `c${n + 1}` } : {}), now,
        rules: { ...this.left(db, run.id, stats), callsLeft: q.callsLeft, minContained: g.minContained },
        clusters: p.clusters.map(([keep, ...rest]) => ({ kind: keep.kind, keep: itemRef(keep.id), ids: [keep, ...rest].map((r) => itemRef(r.id)) })),
        supersedeHints: p.hints.map(([h, by]) => ({ id: itemRef(h.id), by: itemRef(by.id) })),
        items: (pages[n - 1] ?? []).filter(shown).map((r) => candidateView(r, now)),
      };
    });
  }

  gardenGet(account: string | undefined, runId: number, id: number): { ok: true; item: GardenCandidate & { body: string } } | GardenRefused {
    return this.gardenCall(account, runId, (db, run, stats, refuse) => {
      if (!stats.candidates.includes(id)) return refuse('not a candidate', `${itemRef(id)} is not in this run's candidate set`);
      const [r] = this.rowsOf(db, run.repo_id, [id]);
      return unfit(r, refuse) ?? { ok: true as const, item: { ...candidateView(r, this.now()), body: oneLine(r.body, LIMITS.item.ledgerBody) } };
    });
  }

  gardenApply(account: string | undefined, runId: number, input: GardenActionInput): GardenApplyResult {
    return this.gardenCall(account, runId, (db, run, stats, refuse): GardenApplyResult => {
      const g = LIMITS.garden;
      const ids = input.action === 'merge' ? input.ids : [input.id, input.by];
      if (new Set(ids).size !== ids.length) return refuse('duplicate', input.action === 'merge' ? 'an id is given twice' : 'id and by are the same item');
      const outside = ids.find((id) => !stats.candidates.includes(id));
      if (outside !== undefined) return refuse('not a candidate', `${itemRef(outside)} is not in this run's candidate set`);
      const rows = this.rowsOf(db, run.repo_id, ids);
      for (const r of rows) {
        const refused = unfit(r, refuse);
        if (refused) return refused;
      }
      const ref = (r: ItemRow) => itemRef(r.id);
      const shield = (r: ItemRow) => protectedWhy(r) && refuse('protected', `${ref(r)} is ${protectedWhy(r)}; it is never hidden`);
      const immune = (h: ItemRow, into: ItemRow) => db.prepare('SELECT 1 FROM garden_actions WHERE item_id = ? AND into_id = ? AND immune = 1').get(h.id, into.id)
        && refuse('immune', `the human undid hiding ${ref(h)} behind ${ref(into)}`);
      const cover = (h: ItemRow, t: ItemRow) => contained(h.text, t.text) < g.minContained
        && refuse('containment', `${ref(t)} covers under ${g.minContained * 100}% of ${ref(h)}'s terms`);
      const done = this.left(db, run.id, stats);
      const reason = oneLine(redact(input.reason.trim()), g.reason), now = this.now();
      const hide = db.prepare(`UPDATE items SET invalid_at = ?, invalid_kind = ?, invalid_by = ?, invalid_reason = ?, merged_into = ? WHERE id = ?`);
      const log = db.prepare('INSERT INTO garden_actions (run_id, ts, action, item_id, into_id, seen_delta, reason) VALUES (?, ?, ?, ?, ?, ?, ?)');
      if (input.action === 'merge') {
        if (new Set(rows.map((r) => r.kind)).size > 1) return refuse('kind', 'merge members must share one kind');
        // The daemon picks the keep; the gardener's order never counts (D8 rule 4).
        const [keep, ...members] = [...rows].sort(keepRank);
        for (const m of members) {
          const refused = shield(m) || immune(m, keep) || cover(m, keep)
            || (this.hopsBelow(db, m.id) >= g.chainDepth && refuse('chain', `merging ${ref(m)} into ${ref(keep)} makes a merge chain longer than ${g.chainDepth}`));
          if (refused) return refused;
        }
        if (members.length > done.hidesLeft) return refuse('hides', `this run may hide ${done.hidesLeft} more items`);
        // A pinned or human keep's row is never written, so its undo subtracts nothing (seen_delta 0).
        const written = !keep.pinned && keep.author !== 'human';
        for (const m of members) {
          hide.run(now, 'merged', gardenBy(run.id), reason, keep.id, m.id);
          log.run(run.id, now, 'merge', m.id, keep.id, written ? m.seen : 0, reason);
        }
        if (written) db.prepare('UPDATE items SET seen = seen + ? WHERE id = ?').run(members.reduce((n, m) => n + m.seen, 0), keep.id);
        return { ok: true, action: 'merge', kept: keep.id, hidden: members.map((m) => m.id), ...this.left(db, run.id, stats) };
      }
      const [item, by] = rows;
      const refused = shield(item)
        || (by.kind !== item.kind && by.kind !== 'ledger' && by.author !== 'daemon' && by.seen < 2
          && refuse('kind', `${ref(by)} is a ${by.kind}: a supersede's by is the same kind, a ledger line, daemon-written or seen twice`))
        || (by.created_at <= item.created_at && refuse('newer', `${ref(by)} is not newer than ${ref(item)}`))
        || (ftsTerms(item.text, Infinity).length < g.minSupersedeTerms && refuse('terms', `${ref(item)} has under ${g.minSupersedeTerms} terms`))
        || cover(item, by)
        || (by.kind === item.kind && contained(item.text, by.text) >= g.copyContained
          && refuse('copy', `${ref(by)} is a near-copy of ${ref(item)}; merge them instead`))
        || immune(item, by)
        || (done.hidesLeft < 1 && refuse('hides', 'this run may hide no more items'))
        || (done.supersedesLeft < 1 && refuse('supersedes', 'this run may supersede no more items'));
      if (refused) return refused;
      hide.run(now, 'gardener', gardenBy(run.id), reason, null, item.id);
      log.run(run.id, now, 'supersede', item.id, by.id, 0, reason);
      return { ok: true, action: 'supersede', hidden: item.id, by: by.id, ...this.left(db, run.id, stats) };
    });
  }

  countCalls(account: string | undefined, runId: number, totals: { calls: number; outputChars: number }): void {
    this.loud(() => this.setRun(account, runId, `stats = json_set(stats, '$.calls', :calls, '$.outputChars', :chars)`,
      { calls: totals.calls, chars: totals.outputChars }));
  }

  endRun(account: string | undefined, runId: number, state: Exclude<RunState, 'running' | 'skipped'>, note?: string): boolean {
    return this.loud(() => this.setRun(account, runId, 'state = :state, note = coalesce(:note, note)', { state, note: note ?? null },
      `AND (state = 'running' OR (:state = 'reverted' AND ended_at IS NOT NULL AND state NOT IN ('skipped', 'reverted')))`));
  }

  finishRun(account: string | undefined, runId: number, cost: { usd: number; incomplete: boolean }): GardenRunView {
    return this.loud(() => {
      const db = this.runFile(account, runId);
      return runView(tx(db, () => {
        const run = this.runRow(db, runId);
        if (run.ended_at !== null) return run;
        const scope = { account, repoKey: run.repo_key, repoPath: '' };
        const stats: GardenRunStats = { ...JSON.parse(run.stats), after: this.gardenSnapshot(db, scope, run.repo_id, this.freeze(db, run.repo_id).proposals.clusters) };
        db.prepare(`UPDATE garden_runs SET state = CASE state WHEN 'running' THEN 'interrupted' ELSE state END, ended_at = ?, cost_usd = ?,
          cost_incomplete = ?, stats = ? WHERE id = ?`).run(this.now(), cost.usd, cost.incomplete ? 1 : 0, JSON.stringify(stats), runId);
        return this.runRow(db, runId);
      }));
    });
  }

  verifyRun(account: string | undefined, runId: number): string[] {
    return this.loud(() => {
      const db = this.runFile(account, runId);
      return tx(db, () => {
        const run = this.runRow(db, runId), stats = JSON.parse(run.stats) as GardenRunStats, by = gardenBy(runId), r = runRef(runId);
        const found: string[] = [];
        const actions = (db.prepare('SELECT * FROM garden_actions WHERE run_id = ? AND undone_at IS NULL ORDER BY id').all(runId) as unknown as ActionRow[]);
        // 1. Every row the run hides has its action, was a candidate and is not protected. Eligibility can lapse after the
        // hide (a failed outcome), so gardenApply checks it inside the hide's own transaction instead.
        for (const h of db.prepare('SELECT * FROM items WHERE invalid_by = ?').all(by) as unknown as ItemRow[]) {
          if (!actions.some((a) => a.item_id === h.id)) found.push(`m${h.id} is hidden by ${r} with no action`);
          if (protectedWhy(h)) found.push(`m${h.id} is ${protectedWhy(h)} but hidden by ${r}`);
          if (!stats.candidates.includes(h.id)) found.push(`m${h.id} was not a candidate of ${r}`);
        }
        // 2. Every merge chain the run made ends on a live item, or on one someone else retracted after the merge.
        for (const a of actions.filter((x) => x.action === 'merge')) {
          const item = db.prepare('SELECT * FROM items WHERE id = ?').get(a.item_id) as unknown as ItemRow;
          if (item.invalid_kind !== 'merged' || item.invalid_by !== by) continue; // revived or retracted since: no longer this run's redirect
          const end = this.chainEnd(db, item);
          if (!end || end.invalid_kind === 'merged') found.push(`m${item.id}'s merge chain is broken or longer than ${LIMITS.garden.chainDepth}`);
          else if (end.invalid_at !== null && (end.invalid_by === by || end.invalid_at < a.ts)) {
            found.push(`m${item.id} merges into m${end.id}, which ${end.invalid_by === by ? `${r} also hid` : 'was hidden before the merge'}`);
          }
        }
        // 3. The caps.
        const supersedes = actions.filter((a) => a.action === 'supersede').length;
        if (actions.length > stats.maxHides) found.push(`${r} hid ${actions.length} items, over its cap of ${stats.maxHides}`);
        if (supersedes > LIMITS.garden.maxSupersedes) found.push(`${r} superseded ${supersedes} items, over the cap of ${LIMITS.garden.maxSupersedes}`);
        // 4. The orchestrator digest keeps every pin it had before the run that the run hid or kept. The rules already
        // shield pins; this is the backstop. Untouched pins can leave it by the human's hand or the digest's own budget.
        const touched = new Set(actions.flatMap((a) => [a.item_id, a.into_id ?? a.item_id]));
        const after = new Set(stats.after?.digest.ids ?? digestFor(this, { account, repoKey: run.repo_key, repoPath: '' }, { role: 'orchestrator', now: this.now() }).itemIds);
        const pin = db.prepare('SELECT pinned, invalid_at, invalid_by FROM items WHERE id = ?');
        for (const id of stats.before.digest.ids.filter((x) => touched.has(x) && !after.has(x))) {
          const p = pin.get(id) as { pinned: number; invalid_at: number | null; invalid_by: string | null } | undefined;
          if (p?.pinned && (p.invalid_at === null || p.invalid_by === by)) found.push(`pin m${id} left the orchestrator digest`);
        }
        // 5. No item the run touched is live while its newest retraction or restore was the human's forget.
        for (const { id } of db.prepare(`SELECT i.id FROM items i WHERE i.id IN (SELECT value FROM json_each(?)) AND i.invalid_at IS NULL
          AND (SELECT e.kind = 'forget' AND json_extract(e.data, '$.actor') = 'human' FROM episodes e
            WHERE e.kind IN ('forget', 'pin', 'restore') AND json_extract(e.data, '$.itemId') = i.id ORDER BY e.id DESC LIMIT 1)`).all(JSON.stringify([...touched])) as { id: number }[]) {
          found.push(`m${id} is live after the human forgot it`);
        }
        if (found.length) db.prepare('UPDATE garden_runs SET stats = ? WHERE id = ?').run(JSON.stringify({ ...stats, violations: found }), runId);
        return found;
      });
    });
  }

  undo(scope: MemoryScope, target: GardenUndoTarget, by: GardenUndoneBy): GardenUndoResult {
    return this.loud(() => {
      const missing = 'run' in target ? `no such run ${runRef(target.run)}` : `no such item ${itemRef(target.item)}`;
      const db = this.db(scope.account, false);
      const repo = db && this.repo(db, scope, false);
      if (!db || repo === undefined) throw new MemoryError(missing);
      return tx(db, () => {
        if ('run' in target) {
          if (this.runRow(db, target.run).repo_id !== repo) throw new MemoryError(missing);
          const actions = db.prepare('SELECT * FROM garden_actions WHERE run_id = ? AND undone_at IS NULL ORDER BY id DESC').all(target.run) as unknown as ActionRow[];
          return this.undoActions(db, actions, by, by === 'human' && target.immune === true);
        }
        const action = this.latestAction(db, this.item(db, repo, target.item).id);
        if (!action) throw new MemoryError(`${itemRef(target.item)} was never hidden by the gardener`);
        return this.undoActions(db, [action], by, by === 'human');
      });
    });
  }

  runs(account: string | undefined, q: { repoKey?: string; limit?: number } = {}): GardenRunView[] {
    return this.loud(() => (this.db(account, false)?.prepare(`${RUN_SQL} ${q.repoKey === undefined ? '' : 'WHERE r.key = :repo'} ORDER BY g.id DESC LIMIT :limit`)
      .all({ ...(q.repoKey === undefined ? {} : { repo: q.repoKey }), limit: q.limit ?? LIMITS.garden.recentRuns }) as unknown as RunRow[] | undefined ?? [])
      .map(runView));
  }

  run(account: string | undefined, runId: number): GardenRunView {
    return this.loud(() => {
      const db = this.runFile(account, runId), run = runView(this.runRow(db, runId));
      const actions = db.prepare(`SELECT a.*, i.text AS item_text, k.text AS into_text FROM garden_actions a JOIN items i ON i.id = a.item_id
        LEFT JOIN items k ON k.id = a.into_id WHERE a.run_id = ? ORDER BY a.id`).all(runId) as unknown as (ActionRow & { item_text: string; into_text: string | null })[];
      return { ...run, actions: actions.map(actionView) };
    });
  }

  cost30d(account: string | undefined): number {
    return this.loud(() => Number((this.db(account, false)?.prepare('SELECT coalesce(sum(cost_usd), 0) AS usd FROM garden_runs WHERE started_at >= ?')
      .get(this.now() - 30 * DAY) as { usd: number } | undefined)?.usd ?? 0));
  }

  close(): void {
    for (const t of this.checks.values()) if (t) clearImmediate(t);
    for (const db of this.dbs.values()) db.close();
    this.dbs.clear();
  }

  // --- Internals ---

  private keyOf(account: string | undefined): string {
    return accountKey(account === undefined ? [] : this.accounts(), account);
  }

  /** claudeAccounts(home), or its error, reused for ACCOUNTS_TTL_MS: it reads and validates the home file on every call. */
  private accounts(): ClaudeAccount[] {
    if (!this.accountsRead || Date.now() - this.accountsRead.at > ACCOUNTS_TTL_MS) {
      let value: ClaudeAccount[] | Error;
      try { value = claudeAccounts(this.home); } catch (err) { value = err as Error; }
      this.accountsRead = { at: Date.now(), value };
    }
    if (this.accountsRead.value instanceof Error) throw this.accountsRead.value;
    return this.accountsRead.value;
  }

  private fileOf(key: string): string {
    return join(this.home, 'memory', `${key}.db`);
  }

  private existingKeys(): string[] {
    try {
      return readdirSync(join(this.home, 'memory')).flatMap((f) => /^([^.]+)\.db$/.exec(f)?.[1] ?? []);
    } catch {
      return [];
    }
  }

  /** Manager-facing: never throws; logs once per account and reason. */
  private quiet<T>(account: string | undefined, fallback: T, fn: () => T): T {
    try {
      return fn();
    } catch (err) {
      this.report(account ?? '', err);
      return fallback;
    }
  }

  /**
   * Log once per key and reason: an expected condition (a string reason, or Unavailable) as one line, anything else as
   * the error itself, so the stack printed is the failure's own.
   */
  private report(key: string, err: unknown): void {
    const reason = typeof err === 'string' ? err : (err as Error)?.message ?? String(err);
    if (this.logged.has(`${key}\0${reason}`)) return;
    this.logged.add(`${key}\0${reason}`);
    this.log(typeof err === 'string' || err instanceof Unavailable ? `memory${key ? ` (${key})` : ''}: ${reason}` : err);
  }

  /** Tool-facing: MemoryError as written, anything else as "memory is unavailable: <reason>". */
  private loud<T>(fn: () => T): T {
    try {
      return fn();
    } catch (err) {
      if (err instanceof MemoryError) throw err;
      throw new Error(`memory is unavailable: ${(err as Error)?.message ?? String(err)}`, { cause: err });
    }
  }

  private db(account: string | undefined, create: boolean): DatabaseSync | undefined {
    return this.handle(this.keyOf(account), create);
  }

  /**
   * The account file's open handle, opening it on first use. undefined when the file does not exist and create is false:
   * only writes create one. A corrupt file is renamed aside and, for a write, replaced by a new one.
   */
  private handle(key: string, create: boolean): DatabaseSync | undefined {
    const open = this.dbs.get(key);
    if (open) return open;
    if (this.off) throw new Unavailable(this.off);
    const down = this.down.get(key);
    if (down && (down.state === 'off' || Date.now() - down.at < LIMITS.store.retryBrokenMs)) throw new Unavailable(down.reason);
    const file = this.fileOf(key);
    if (!create && !existsSync(file)) return undefined;
    const sqlite = this.load();
    let db: DatabaseSync;
    try {
      db = this.openFile(sqlite, file, create);
    } catch (err) {
      if (err instanceof Unavailable) {
        this.down.set(key, { state: 'off', reason: err.message, at: Date.now() });
        throw err;
      }
      if (locked(err)) throw err; // skip this operation only
      if (errcode(err) !== 11 && errcode(err) !== 26) {
        this.down.set(key, { state: 'broken', reason: (err as Error).message, at: Date.now() });
        throw err;
      }
      const aside = this.quarantine(key);
      this.report(key, `${file} is corrupt (${(err as Error).message}); moved it to ${aside}`);
      if (!create) return undefined;
      db = this.openFile(sqlite, file, true);
    }
    this.down.delete(key);
    this.dbs.set(key, db);
    if (!this.checks.has(key)) { // check point (a): the size limit once after the first open, not inline
      const t = setImmediate(() => { this.checks.set(key, undefined); void this.enforce(key, this.maxMB()); });
      this.checks.set(key, t);
    }
    return db;
  }

  /** node:sqlite, loaded on the first open; FTS5 probed once in memory. Either missing turns memory off for this process. */
  private load(): typeof import('node:sqlite') {
    if (this.sqlite) return this.sqlite;
    const sqlite = process.getBuiltinModule?.('node:sqlite') as typeof import('node:sqlite') | undefined;
    if (!sqlite) throw new Unavailable(this.off = 'this Node has no node:sqlite');
    try {
      const probe = new sqlite.DatabaseSync(':memory:');
      try { probe.exec('CREATE VIRTUAL TABLE temp.fts_probe USING fts5(x)'); } finally { probe.close(); }
    } catch {
      throw new Unavailable(this.off = 'no FTS5');
    }
    return (this.sqlite = sqlite);
  }

  private openFile(sqlite: typeof import('node:sqlite'), file: string, create: boolean): DatabaseSync {
    if (create && !existsSync(file)) {
      mkdirSync(join(this.home, 'memory'), { recursive: true, mode: 0o700 });
      closeSync(openSync(file, 'a', 0o600)); // SQLite gives its -wal and -shm files the database file's mode
    }
    const db = new sqlite.DatabaseSync(file, { timeout: LIMITS.store.lockTimeoutMs });
    try {
      const version = pragma(db, 'user_version'); // the first statement: a corrupt file throws here
      if (version > SCHEMA_VERSION) throw new Unavailable(`written by a newer tiller (schema ${version})`);
      db.exec('PRAGMA secure_delete = ON; PRAGMA synchronous = NORMAL; PRAGMA foreign_keys = ON');
      if (version === 0) {
        // auto_vacuum and journal_mode cannot run in a transaction; the tables and user_version go in one, so a crash or
        // a second daemon creating the same file never leaves half a schema. The second finds version 1 and stops.
        const tables = SCHEMA_V1.search(/^CREATE TABLE/m);
        db.exec(SCHEMA_V1.slice(0, tables));
        tx(db, () => { if (pragma(db, 'user_version') === 0) db.exec(SCHEMA_V1.slice(tables)); });
      }
      // Each in its own transaction, re-checked inside it, so a second daemon migrating the same file skips what is done.
      for (const m of MIGRATIONS) {
        if (version < m.version) tx(db, () => { if (pragma(db, 'user_version') < m.version) db.exec(m.sql); });
      }
      return db;
    } catch (err) {
      db.close();
      throw err;
    }
  }

  /** Rename <key>.db and its -wal and -shm to <key>.corrupt-<ts>.db*, never deleting them; returns the new path. */
  private quarantine(key: string): string {
    const file = this.fileOf(key), aside = join(this.home, 'memory', `${key}.corrupt-${Date.now()}.db`);
    for (const suffix of ['', '-wal', '-shm']) if (existsSync(file + suffix)) renameSync(file + suffix, aside + suffix);
    return aside;
  }

  private maxMB(): number {
    try {
      return loadConfig(null, this.home).memory.maxMB;
    } catch {
      return LIMITS.size.defaultMB;
    }
  }

  private repo(db: DatabaseSync, scope: MemoryScope, create: boolean): number | undefined {
    const row = db.prepare('SELECT id FROM repos WHERE key = ?').get(scope.repoKey) as { id: number } | undefined;
    if (row || !create) return row?.id;
    return Number((db.prepare('INSERT INTO repos (key, path, created_at) VALUES (?, ?, ?) RETURNING id')
      .get(scope.repoKey, scope.repoPath, this.now()) as { id: number }).id);
  }

  /** The repo's item; another repo's, or none, is "no such item". */
  private item(db: DatabaseSync, repo: number, id: number): ItemRow {
    const row = db.prepare('SELECT * FROM items WHERE id = ? AND repo_id = ?').get(id, repo) as ItemRow | undefined;
    if (!row) throw new MemoryError(`no such item ${itemRef(id)}`);
    return row;
  }

  private episode(db: DatabaseSync, repo: number, scope: MemoryScope, e: HistoryEntry): number {
    return Number((db.prepare(`INSERT INTO episodes (ts, repo_id, root_id, node_id, kind, harness, model, role, profile, data)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`).get(
      e.ts, repo, scope.rootId ?? scope.nodeId ?? '', scope.nodeId ?? '', e.kind,
      scope.harness ?? null, scope.model ?? null, scope.role ?? null, scope.profile ?? null, JSON.stringify(e.data),
    ) as { id: number }).id);
  }

  /**
   * Bump a live item, revive an agent-retracted, gardener-hidden or evicted one with the new text, skip a human-retracted
   * one, else insert. A merged one bumps instead the live item its redirect chain ends on; with none, it revives.
   */
  private upsert(db: DatabaseSync, it: {
    repo_id: number; kind: ItemKind; text: string; body: string; author: string; dedupe: string; node_id: string | null;
    root_id: string | null; harness: string | null; model: string | null; episode_id: number | null; now: number;
  }): AddResult | { sticky: number } {
    const row = db.prepare('SELECT * FROM items WHERE repo_id = ? AND kind = ? AND dedupe = ?').get(it.repo_id, it.kind, it.dedupe) as ItemRow | undefined;
    if (!row) {
      const { now, ...cols } = it;
      const id = db.prepare(`INSERT INTO items (repo_id, kind, text, body, author, dedupe, node_id, root_id, harness, model, episode_id, created_at, updated_at)
        VALUES (:repo_id, :kind, :text, :body, :author, :dedupe, :node_id, :root_id, :harness, :model, :episode_id, :now, :now) RETURNING id`)
        .get({ ...cols, now }) as { id: number };
      return { id: Number(id.id) };
    }
    if (row.invalid_kind === 'human' || row.invalid_kind === 'superseded') return { sticky: row.id };
    const end = row.invalid_kind === 'merged' ? this.chainEnd(db, row) : undefined;
    if (end?.invalid_at === null) {
      db.prepare('UPDATE items SET seen = seen + 1, updated_at = ? WHERE id = ?').run(it.now, end.id);
      return { id: end.id, existing: true, merged: true };
    }
    // A revive is the reviver's item: its text, author and node decide eligibility, provenance and what purge reaches.
    const revived = row.invalid_kind !== null;
    const { repo_id, kind, dedupe, now, ...fresh } = it;
    db.prepare(`UPDATE items SET seen = seen + 1, updated_at = :now${revived
      ? `, ${Object.keys(fresh).map((c) => `${c} = :${c}`).join(', ')}, invalid_at = NULL, invalid_kind = NULL, invalid_by = NULL, invalid_reason = NULL,
        merged_into = NULL` : ''}
      WHERE id = :id`).run({ now, id: row.id, ...(revived ? fresh : {}) });
    return revived ? { id: row.id, revived: true } : { id: row.id, existing: true };
  }

  private invalidate(db: DatabaseSync, id: number, kind: 'agent' | 'human' | 'superseded', by: string, reason: string): void {
    db.prepare('UPDATE items SET invalid_at = ?, invalid_kind = ?, invalid_by = ?, invalid_reason = ?, merged_into = NULL WHERE id = ?')
      .run(this.now(), kind, by, reason, id);
  }

  /** The account's file for a run method; "no such run" when there is none. */
  private runFile(account: string | undefined, runId: number): DatabaseSync {
    const db = this.db(account, false);
    if (!db) throw new MemoryError(`no such run ${runRef(runId)}`);
    return db;
  }

  private runRow(db: DatabaseSync, runId: number): RunRow {
    const row = db.prepare(`${RUN_SQL} WHERE g.id = ?`).get(runId) as unknown as RunRow | undefined;
    if (!row) throw new MemoryError(`no such run ${runRef(runId)}`);
    return row;
  }

  /** UPDATE garden_runs SET <set> WHERE id = :id <where>, after checking the run exists; whether it changed the row. */
  private setRun(account: string | undefined, runId: number, set: string, params: Record<string, SQLInputValue> = {}, where = ''): boolean {
    const db = this.runFile(account, runId);
    return tx(db, () => {
      this.runRow(db, runId);
      return Number(db.prepare(`UPDATE garden_runs SET ${set} WHERE id = :id ${where}`).run({ ...params, id: runId }).changes) > 0;
    });
  }

  /**
   * A garden tool call, in one transaction: refused 'not running' once the lease has ended. refuse() counts its rule in
   * stats.refused in the same transaction and builds the refusal.
   */
  private gardenCall<T>(account: string | undefined, runId: number,
    fn: (db: DatabaseSync, run: RunRow, stats: GardenRunStats, refuse: Refuse) => T | GardenRefused): T | GardenRefused {
    return this.loud(() => {
      const db = this.runFile(account, runId);
      return tx(db, () => {
        const run = this.runRow(db, runId), stats = JSON.parse(run.stats) as GardenRunStats;
        const refuse: Refuse = (rule, message) => {
          stats.refused[rule] = (stats.refused[rule] ?? 0) + 1;
          db.prepare('UPDATE garden_runs SET stats = ? WHERE id = ?').run(JSON.stringify(stats), runId);
          return { ok: false, rule, message: `refused (${rule}): ${message}` };
        };
        return run.state === 'running' ? fn(db, run, stats, refuse) : refuse('not running', `${runRef(runId)} has ended (${run.state})`);
      });
    });
  }

  /** The repository's rows of these ids in their order, with ELIGIBLE as eligible; another repository's are left out. */
  private rowsOf(db: DatabaseSync, repo: number, ids: number[]): EligibleRow[] {
    const byId = new Map((db.prepare(`SELECT i.*, ${ELIGIBLE} AS eligible FROM items i WHERE i.repo_id = ? AND i.id IN (SELECT value FROM json_each(?))`)
      .all(repo, JSON.stringify(ids)) as unknown as EligibleRow[]).map((r) => [r.id, r]));
    return ids.flatMap((id) => byId.get(id) ?? []);
  }

  /** The hides and supersedes a run has left under its caps. */
  private left(db: DatabaseSync, runId: number, stats: GardenRunStats): { hidesLeft: number; supersedesLeft: number } {
    const n = db.prepare(`SELECT count(*) AS hides, coalesce(sum(action = 'supersede'), 0) AS supersedes FROM garden_actions WHERE run_id = ?`)
      .get(runId) as { hides: number; supersedes: number };
    const hidesLeft = Math.max(0, stats.maxHides - Number(n.hides));
    return { hidesLeft, supersedesLeft: Math.min(hidesLeft, Math.max(0, LIMITS.garden.maxSupersedes - Number(n.supersedes))) };
  }

  /**
   * A run's candidate set (D8 rule 1, §3.4): the newest LIMITS.garden.candidates live, eligible items of GARDEN_KINDS,
   * pinned and human ones included, plus every ledger line a supersede hint names; with the proposals over those items
   * and the repository's newest eligible ledger lines.
   */
  private freeze(db: DatabaseSync, repo: number): { items: ItemRow[]; ids: number[]; proposals: ReturnType<typeof propose> } {
    const live = (kinds: string, order: string) => db.prepare(`SELECT i.* FROM items i WHERE i.repo_id = ? AND i.invalid_at IS NULL
      AND i.kind IN (${kinds}) AND ${ELIGIBLE} ORDER BY ${order} LIMIT ${LIMITS.garden.candidates}`).all(repo) as unknown as ItemRow[];
    const items = live(GARDEN_IN, 'i.updated_at DESC, i.id DESC');
    const proposals = propose([...items, ...live(`'ledger'`, 'i.created_at DESC, i.id DESC')], this.immunePairs(db));
    return { items, ids: [...new Set([...items.map((r) => r.id), ...proposals.hints.map(([, by]) => by.id)])], proposals };
  }

  /** The (item, into) pairs the human made immune, as "<item>:<into>". */
  private immunePairs(db: DatabaseSync): Set<string> {
    return new Set((db.prepare('SELECT item_id, into_id FROM garden_actions WHERE immune = 1').all() as { item_id: number; into_id: number }[])
      .map((a) => `${a.item_id}:${a.into_id}`));
  }

  /** The repository's live counts and orchestrator digest on one side of a run (D9); redundancy is over these clusters. */
  private gardenSnapshot(db: DatabaseSync, scope: MemoryScope, repo: number, clusters: ItemRow[][]): GardenSnapshot {
    const live = Object.fromEntries((db.prepare('SELECT kind, count(*) AS n FROM items WHERE repo_id = ? AND invalid_at IS NULL GROUP BY kind')
      .all(repo) as { kind: ItemKind; n: number }[]).map((r) => [r.kind, Number(r.n)]));
    const digest = digestFor(this, scope, { role: 'orchestrator', now: this.now() }), shown = new Set(digest.itemIds);
    const redundancy = clusters.map((c) => c.filter((r) => shown.has(r.id)).length).filter((n) => n > 1).reduce((a, b) => a + b, 0);
    return { live, digest: { ids: digest.itemIds, chars: digest.text.length }, redundancy };
  }

  /** Where a merged row's redirect ends: the last row along merged_into, or undefined past LIMITS.garden.chainDepth hops. */
  private chainEnd(db: DatabaseSync, row: ItemRow): ItemRow | undefined {
    let r = row;
    for (let hops = 0; r.invalid_kind === 'merged' && r.merged_into !== null; hops++) {
      if (hops === LIMITS.garden.chainDepth) return undefined;
      r = db.prepare('SELECT * FROM items WHERE id = ?').get(r.merged_into) as unknown as ItemRow;
    }
    return r;
  }

  /** The most hops any merged row takes to redirect to this one, counted no further than LIMITS.garden.chainDepth. */
  private hopsBelow(db: DatabaseSync, id: number): number {
    const members = db.prepare(`SELECT id FROM items WHERE invalid_kind = 'merged' AND merged_into IN (SELECT value FROM json_each(?))`);
    let level = [id], hops = 0;
    for (; hops < LIMITS.garden.chainDepth; hops++) {
      level = (members.all(JSON.stringify(level)) as { id: number }[]).map((r) => Number(r.id));
      if (!level.length) break;
    }
    return hops;
  }

  private latestAction(db: DatabaseSync, itemId: number): ActionRow | undefined {
    return db.prepare('SELECT * FROM garden_actions WHERE item_id = ? ORDER BY id DESC LIMIT 1').get(itemId) as unknown as ActionRow | undefined;
  }

  /** The garden action behind a merged or gardener-hidden row; undefined for any other row. */
  private gardened(db: DatabaseSync, item: ItemRow): ActionRow | undefined {
    return item.invalid_kind === 'merged' || item.invalid_kind === 'gardener' ? this.latestAction(db, item.id) : undefined;
  }

  /**
   * Undo these actions in order (D7): an item its action's run still hides is cleared, and a merge's keep gives back
   * seen_delta. An item since revived, retracted by someone else, purged or evicted is skipped with the reason.
   */
  private undoActions(db: DatabaseSync, actions: ActionRow[], by: GardenUndoneBy, immune: boolean): GardenUndoResult {
    const result: GardenUndoResult = { undone: [], skipped: [] };
    for (const a of actions) {
      const r = db.prepare('SELECT * FROM items WHERE id = ?').get(a.item_id) as unknown as ItemRow;
      const why = a.undone_at !== null ? 'already undone' : r.text === '' ? (r.dedupe.startsWith('purged:') ? 'purged' : 'evicted')
        : r.invalid_at === null ? 'live again' : r.invalid_by !== gardenBy(a.run_id) ? `retracted since by ${r.invalid_by}` : undefined;
      if (why) {
        result.skipped.push({ actionId: a.id, itemId: a.item_id, reason: why });
        continue;
      }
      db.prepare('UPDATE items SET invalid_at = NULL, invalid_kind = NULL, invalid_by = NULL, invalid_reason = NULL, merged_into = NULL WHERE id = ?').run(r.id);
      if (a.seen_delta) db.prepare('UPDATE items SET seen = max(1, seen - ?) WHERE id = ?').run(a.seen_delta, a.into_id);
      db.prepare('UPDATE garden_actions SET undone_at = ?, undone_by = ?, immune = ? WHERE id = ?').run(this.now(), by, immune ? 1 : 0, a.id);
      result.undone.push({ actionId: a.id, runId: a.run_id, itemId: a.item_id, ...(a.into_id !== null ? { intoId: a.into_id } : {}) });
    }
    return result;
  }

  private cap(db: DatabaseSync, nodeId: string, kind: 'add' | 'forget', max: number, tool: string): void {
    const n = Number((db.prepare('SELECT count(*) AS n FROM episodes WHERE node_id = ? AND kind = ?').get(nodeId, kind) as { n: number }).n);
    if (n >= max) throw new MemoryError(`${tool} is limited to ${max} per node`);
  }

  private who(actor: Actor) {
    return actor.kind === 'human'
      ? { actor: 'human', node_id: null, root_id: null, harness: null, model: null }
      : { actor: actor.nodeId, node_id: actor.nodeId, root_id: actor.rootId, harness: actor.harness ?? null, model: actor.model ?? null };
  }

  /** The node columns of an actor's own episode: the agent's node, or 'human'. */
  private episodeScope(actor: Actor): Partial<MemoryScope> {
    return actor.kind === 'human'
      ? { nodeId: 'human', rootId: 'human', harness: undefined, model: undefined, role: undefined, profile: undefined }
      : { nodeId: actor.nodeId, rootId: actor.rootId, harness: actor.harness, model: actor.model };
  }

  /**
   * Tombstone the item, every item of its episode and every item merged into one of those, down the chain (judged
   * duplicates, they may hold the same secret). Cut that episode and the node's gate runs before it (since the previous
   * outcome) to their skeletons, and blank every injection that named one of the items and every garden action reason
   * about one. Runs in the caller's transaction; scrub() then removes the bytes.
   */
  private purge(db: DatabaseSync, item: ItemRow, reason: string): void {
    const ids = new Set(item.episode_id === null ? [item.id]
      : (db.prepare('SELECT id FROM items WHERE episode_id = ? OR id = ?').all(item.episode_id, item.id) as { id: number }[]).map((r) => Number(r.id)));
    const members = db.prepare(`SELECT id FROM items WHERE invalid_kind = 'merged' AND merged_into = ?`);
    for (const id of ids) for (const r of members.all(id) as { id: number }[]) ids.add(Number(r.id)); // iteration visits what it adds
    const json = JSON.stringify([...ids]);
    db.prepare(`UPDATE items SET text = '', body = '', dedupe = 'purged:' || id, invalid_at = :now, invalid_kind = 'human', invalid_by = 'human',
      invalid_reason = :reason, merged_into = NULL WHERE id IN (SELECT value FROM json_each(:ids))`).run({ now: this.now(), reason, ids: json });
    db.prepare(`UPDATE garden_actions SET reason = '' WHERE item_id IN (SELECT value FROM json_each(:ids)) OR into_id IN (SELECT value FROM json_each(:ids))`)
      .run({ ids: json });
    const ep = item.episode_id === null ? undefined
      : db.prepare('SELECT id, node_id, kind, data FROM episodes WHERE id = ?').get(item.episode_id) as { id: number; node_id: string; kind: string; data: string } | undefined;
    if (ep) {
      const since = Number((db.prepare(`SELECT coalesce(max(id), 0) AS id FROM episodes WHERE node_id = ? AND kind = 'outcome' AND id < ?`)
        .get(ep.node_id, ep.id) as { id: number }).id);
      const gates = db.prepare(`SELECT id, kind, data FROM episodes WHERE node_id = ? AND kind = 'gate' AND id > ? AND id < ?`)
        .all(ep.node_id, since, ep.id) as { id: number; kind: string; data: string }[];
      const set = db.prepare('UPDATE episodes SET data = ? WHERE id = ?');
      for (const e of [ep, ...gates]) set.run(JSON.stringify(skeleton(e.kind, JSON.parse(e.data))), e.id);
    }
    db.prepare(`UPDATE injections SET text = '' WHERE text <> '' AND EXISTS (SELECT 1 FROM json_each(item_ids) WHERE value IN (SELECT value FROM json_each(?)))`)
      .run(json);
  }

  /**
   * Remove purged bytes: secure_delete zeroed the freed cells; optimize rewrites FTS segments that still hold the old
   * tokens; the checkpoints and incremental_vacuum empty the WAL and drop freed pages. One blocking pass, for a rare human action.
   */
  private scrub(db: DatabaseSync, key: string): void {
    db.exec(`INSERT INTO items_fts(items_fts) VALUES ('optimize')`);
    this.checkpoint(db, key);
    for (let left = pragma(db, 'freelist_count'), was = Infinity; left > 0 && left < was; was = left, left = pragma(db, 'freelist_count')) {
      db.exec(`PRAGMA incremental_vacuum(${LIMITS.size.vacuumPages})`);
    }
    this.checkpoint(db, key);
  }

  /** wal_checkpoint(TRUNCATE), logging when a reader kept it from finishing (the WAL then still holds old pages). */
  private checkpoint(db: DatabaseSync, key: string): void {
    const r = db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get() as { busy: number; log: number; checkpointed: number };
    if (r.busy) this.report(key, `wal_checkpoint(TRUNCATE) was blocked by another reader (${r.checkpointed} of ${r.log} frames)`);
  }

  private statusOf(key: string, brief = false): MemoryDbStatus {
    const path = this.fileOf(key);
    let quarantined: string[] = [];
    try {
      quarantined = readdirSync(join(this.home, 'memory')).filter((f) => f.startsWith(`${key}.corrupt-`) && f.endsWith('.db')).map((f) => join(this.home, 'memory', f));
    } catch { /* no dir yet */ }
    const base = { key, path, quarantined };
    let db: DatabaseSync | undefined;
    try {
      db = this.handle(key, false);
    } catch (err) {
      const down = this.down.get(key);
      return { ...base, state: `${down?.state ?? (this.off ? 'off' : locked(err) ? 'locked' : 'broken')}: ${(err as Error).message}` };
    }
    if (!db) return { ...base, state: 'missing' };
    if (brief) return { ...base, state: 'ok' }; // opening read user_version, which a corrupt header fails
    try {
      const count = (sql: string) => Number((db.prepare(sql).get() as { n: number }).n);
      const items = Object.fromEntries(MEMORY_ITEM_KINDS.map((k) => [k, 0])) as Record<ItemKind, number>;
      for (const r of db.prepare('SELECT kind, count(*) AS n FROM items WHERE invalid_at IS NULL GROUP BY kind').all() as { kind: ItemKind; n: number }[]) items[r.kind] = Number(r.n);
      const size = (f: string) => { try { return statSync(f).size; } catch { return 0; } };
      return {
        ...base, state: 'ok', schema: pragma(db, 'user_version'), sizeBytes: size(path) + size(`${path}-wal`), usedBytes: used(db),
        ...(this.overLimit.has(key) ? { overLimit: true } : {}),
        counts: {
          items, retracted: count('SELECT count(*) AS n FROM items WHERE invalid_at IS NOT NULL'),
          tombstones: count(`SELECT count(*) AS n FROM items WHERE text = ''`), pinned: count('SELECT count(*) AS n FROM items WHERE pinned = 1 AND invalid_at IS NULL'),
          episodes: count('SELECT count(*) AS n FROM episodes'), injections: count('SELECT count(*) AS n FROM injections'),
        },
      };
    } catch (err) {
      return { ...base, state: `broken: ${(err as Error).message}` };
    }
  }

  private async enforce(key: string, maxMB: number): Promise<void> {
    if (this.enforcing.has(key)) return;
    this.enforcing.add(key);
    try {
      const db = this.handle(key, false);
      if (!db) return;
      const limit = maxMB * MB, target = limit * LIMITS.size.target;
      if (used(db) <= limit) {
        this.overLimit.delete(key);
        return;
      }
      const live = () => this.dbs.get(key) === db; // close() may run while we yield
      for (const step of this.evictions(db)) {
        while (live() && used(db) > target && step()) await tick();
      }
      if (!live()) return;
      for (let i = 0; i < LIMITS.size.ftsMergeSteps && live(); i++, await tick()) {
        db.prepare(`INSERT INTO items_fts(items_fts, rank) VALUES ('merge', ?)`).run(LIMITS.size.ftsMergePages);
      }
      for (let was = Infinity; live();) {
        const left = pragma(db, 'freelist_count');
        if (left === 0 || left >= was) break;
        was = left;
        db.exec(`PRAGMA incremental_vacuum(${LIMITS.size.vacuumPages})`);
        await tick();
      }
      if (!live()) return;
      this.checkpoint(db, key);
      if (used(db) > limit) {
        this.overLimit.add(key);
        this.report(key, `over memory.maxMB (${maxMB}) after eviction`);
      } else {
        this.overLimit.delete(key);
      }
    } catch (err) {
      this.report(key, err);
    } finally {
      this.enforcing.delete(key);
    }
  }

  /**
   * The eviction steps in order, each one batch per call returning whether it changed anything. Only content older than
   * LIMITS.size.evictAfterDays goes, and never a pinned item; procedures, pitfalls and notes are kept.
   */
  private evictions(db: DatabaseSync): (() => boolean)[] {
    const cut = this.now() - LIMITS.size.evictAfterDays * DAY, batch = LIMITS.size.batchRows, now = this.now();
    const rows = (sql: string, ...params: SQLInputValue[]) => db.prepare(sql).all(...params) as Record<string, SQLInputValue>[];
    let cursor = 0;
    return [
      // 1. Injection texts: their freezes then inject nothing on resume.
      () => {
        const batchRows = rows(`SELECT * FROM injections WHERE text <> '' AND ts < ? ORDER BY ts, id LIMIT ${batch}`, cut);
        rewrite(db, 'injections', batchRows.map((r) => ({ ...r, text: '' })));
        return batchRows.length > 0;
      },
      // 2. Episodes to their metric skeletons.
      () => {
        const batchRows = rows(`SELECT * FROM episodes WHERE ts < ? AND id > ? ORDER BY id LIMIT ${batch}`, cut, cursor);
        if (batchRows.length === 0) return false;
        cursor = Number(batchRows.at(-1)!.id);
        rewrite(db, 'episodes', batchRows.flatMap((r) => {
          const data = JSON.stringify(skeleton(String(r.kind), JSON.parse(String(r.data))));
          return data === r.data ? [] : [{ ...r, data }];
        }));
        return true;
      },
      // 3. Retracted items to tombstones: the row, dedupe and invalid_* stay, so a human retraction stays sticky.
      () => {
        const batchRows = rows(`SELECT * FROM items WHERE invalid_at IS NOT NULL AND invalid_at < ? AND pinned = 0
          AND (text <> '' OR body <> '') ORDER BY invalid_at, id LIMIT ${batch}`, cut);
        rewrite(db, 'items', batchRows.map((r) => ({ ...r, text: '', body: '' })));
        return batchRows.length > 0;
      },
      // 4. Valid ledger items and open questions, least used and oldest first.
      () => {
        const batchRows = rows(`SELECT * FROM items WHERE invalid_at IS NULL AND kind IN ('ledger', 'open_question') AND updated_at < ?
          AND pinned = 0 ORDER BY cites + gets, updated_at, id LIMIT ${batch}`, cut);
        rewrite(db, 'items', batchRows.map((r) => ({
          ...r, text: '', body: '', invalid_at: now, invalid_kind: 'evicted', invalid_by: 'daemon', invalid_reason: 'memory.maxMB',
        })));
        return batchRows.length > 0;
      },
    ];
  }

  private armStats(db: DatabaseSync, firsts: InjectionRow[]): ArmStats {
    const ratio = (n: number, d: number) => (d ? n / d : null);
    const s = { gated: 0, firstPass: 0, reported: 0, failed: 0, succeeded: 0, successRuns: 0, closed: 0, spent: 0, spentN: 0, wall: 0,
      sends: 0, injected: 0, cites: 0, forgets: 0, repeats: 0, repeatsInjected: 0 };
    for (const inj of firsts) {
      const injected = new Set(JSON.parse(inj.item_ids) as number[]);
      s.injected += injected.size;
      const eps = (db.prepare('SELECT kind, data FROM episodes WHERE node_id = ? ORDER BY ts, id').all(inj.node_id) as { kind: EpisodeKind; data: string }[])
        .map((e) => ({ kind: e.kind, data: JSON.parse(e.data) as Record<string, unknown> }));
      const gates = eps.filter((e) => e.kind === 'gate'), outcome = eps.filter((e) => e.kind === 'outcome').at(-1), close = eps.find((e) => e.kind === 'close');
      if (gates.length) { s.gated++; if (gates[0].data.ok) s.firstPass++; }
      if (outcome) {
        s.reported++;
        if (outcome.data.outcome === 'failed') s.failed++;
        else { s.succeeded++; s.successRuns += gates.length; }
      }
      if (close) {
        s.closed++;
        s.wall += Number(close.data.closedAt) - Number(close.data.createdAt);
        if (typeof close.data.spentUsd === 'number') { s.spent += close.data.spentUsd; s.spentN++; }
      }
      s.sends += eps.filter((e) => e.kind === 'human_send').length;
      for (const e of eps.filter((x) => x.kind === 'outcome')) {
        for (const [, id] of JSON.stringify(e.data).matchAll(/\[m(\d+)\]/g)) if (injected.has(Number(id))) s.cites++;
      }
      s.forgets += eps.filter((e) => e.kind === 'forget' && injected.has(Number(e.data.itemId))).length;
      // prune: a repeat is a failed run whose first error line appears in an earlier pitfall's dedupe key; skeletons lose the tail after eviction.
      for (const g of gates.filter((x) => !x.data.ok && typeof x.data.tail === 'string')) {
        const line = firstErrorLine(String(g.data.tail));
        if (!line) continue;
        const hit = db.prepare(`SELECT id FROM items WHERE repo_id = ? AND kind = 'pitfall' AND created_at <= ? AND instr(dedupe, ?) > 0 LIMIT 1`)
          .get(inj.repo_id, inj.ts, normalizeDedupe('pitfall', line)) as { id: number } | undefined;
        if (hit) { s.repeats++; if (injected.has(Number(hit.id))) s.repeatsInjected++; }
      }
    }
    return {
      nodes: firsts.length, firstPassGate: ratio(s.firstPass, s.gated), failedOutcomes: ratio(s.failed, s.reported),
      gateRunsPerSuccess: ratio(s.successRuns, s.succeeded), spentUsd: ratio(s.spent, s.spentN), wallMs: ratio(s.wall, s.closed),
      humanSendsPerNode: ratio(s.sends, firsts.length), injectedItems: s.injected, citesPerInjected: ratio(s.cites, s.injected),
      forgetsOfInjected: s.forgets, repeatedPitfalls: s.repeats, repeatedInjectedPitfalls: s.repeatsInjected,
    };
  }
}
