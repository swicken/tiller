// The contract of daemon-native memory: its SQLite schema, row and IO types, limits, MCP tool shapes and the pure
// helpers every memory module shares. The store, derive, digest and opt-in modules implement against it.
import { z } from 'zod';
import {
  MEMORY_ITEM_KINDS, type ArchivedNode, type Harness, type MemoryInjectionView, type MemoryInvalidKind, type MemoryItemKind, type MemoryItemView, type NodeKind,
  type Outcome, type Profile, type Role, type SendOutcome,
} from '../shared/protocol.js';
import type { ClaudeAccount } from './claude-accounts.js';
import type { MergeStyle } from './config.js';

/**
 * Schema version 1. Kinds, authors and lengths have no CHECK: they are enforced in TS and zod (MEMORY_ITEM_KINDS, LIMITS), so a
 * new kind needs no table rebuild. Run it with exec() on a new file before anything else, outside a transaction:
 * auto_vacuum only holds when set before the first table, and journal_mode cannot change inside a transaction.
 */
export const SCHEMA_V1 = `
PRAGMA auto_vacuum = INCREMENTAL;     -- must precede the first CREATE TABLE (else silently 0)
PRAGMA journal_mode = WAL;            -- on every open also: synchronous=NORMAL, foreign_keys=ON
CREATE TABLE repos (
  id INTEGER PRIMARY KEY,
  key TEXT NOT NULL UNIQUE,           -- 'git:github.com/swicken/tiller' | 'path:/abs' | 'account:' (sentinel)
  path TEXT NOT NULL,
  created_at INTEGER NOT NULL
) STRICT;
INSERT INTO repos (key, path, created_at) VALUES ('account:', '', 0);   -- reserved account-wide scope; v1 never uses it
CREATE TABLE episodes (               -- append-only facts: derive() input, provenance, metrics
  id INTEGER PRIMARY KEY,
  ts INTEGER NOT NULL,
  repo_id INTEGER NOT NULL REFERENCES repos(id),
  root_id TEXT NOT NULL, node_id TEXT NOT NULL,
  kind TEXT NOT NULL,                 -- EPISODE_KINDS in TS
  harness TEXT, model TEXT, role TEXT, profile TEXT,
  data TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(data))   -- redacted, capped
) STRICT;
CREATE INDEX episodes_repo_ts ON episodes(repo_id, ts);
CREATE INDEX episodes_node ON episodes(node_id, ts);
CREATE TABLE items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,   -- m<id>; never reused
  repo_id INTEGER NOT NULL REFERENCES repos(id),
  kind TEXT NOT NULL,                     -- ITEM_KINDS
  text TEXT NOT NULL,                     -- '' only for tombstones
  body TEXT NOT NULL DEFAULT '',
  author TEXT NOT NULL,                   -- AUTHORS: daemon | agent | human
  node_id TEXT, root_id TEXT, harness TEXT, model TEXT,
  episode_id INTEGER REFERENCES episodes(id) ON DELETE SET NULL,
  dedupe TEXT NOT NULL,
  seen INTEGER NOT NULL DEFAULT 1,
  pinned INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  invalid_at INTEGER, invalid_kind TEXT,  -- agent (forget or supersede by an agent) | human | superseded (by the human only) | evicted
  invalid_by TEXT, invalid_reason TEXT,
  supersedes INTEGER REFERENCES items(id),
  cites INTEGER NOT NULL DEFAULT 0, gets INTEGER NOT NULL DEFAULT 0,
  UNIQUE (repo_id, kind, dedupe)
) STRICT;
CREATE INDEX items_repo_kind ON items(repo_id, kind, updated_at) WHERE invalid_at IS NULL;
CREATE INDEX items_root ON items(root_id, kind, updated_at) WHERE invalid_at IS NULL;
CREATE VIRTUAL TABLE items_fts USING fts5(text, body, content='items', content_rowid='id', tokenize='porter unicode61');
CREATE TRIGGER items_ai AFTER INSERT ON items BEGIN
  INSERT INTO items_fts(rowid, text, body) VALUES (new.id, new.text, new.body); END;
CREATE TRIGGER items_ad AFTER DELETE ON items BEGIN
  INSERT INTO items_fts(items_fts, rowid, text, body) VALUES ('delete', old.id, old.text, old.body); END;
CREATE TRIGGER items_au AFTER UPDATE OF text, body ON items BEGIN
  INSERT INTO items_fts(items_fts, rowid, text, body) VALUES ('delete', old.id, old.text, old.body);
  INSERT INTO items_fts(rowid, text, body) VALUES (new.id, new.text, new.body); END;
CREATE TABLE injections (             -- one row per launch that applied a digest decision
  id INTEGER PRIMARY KEY,
  ts INTEGER NOT NULL,
  session_id TEXT NOT NULL, node_id TEXT NOT NULL, root_id TEXT NOT NULL,
  repo_id INTEGER NOT NULL REFERENCES repos(id),
  arm TEXT NOT NULL,                  -- on | off (applied)
  cause TEXT NOT NULL,                -- config | ab | resume
  role TEXT, profile TEXT, harness TEXT, model TEXT,
  item_ids TEXT NOT NULL CHECK (json_valid(item_ids)),
  text TEXT NOT NULL                  -- '' on resume rows, scrubbed or evicted rows
) STRICT;
CREATE INDEX injections_session ON injections(session_id, ts);
CREATE INDEX injections_node ON injections(node_id, ts);
PRAGMA user_version = 1;
`;

/**
 * Forward migrations, in order: openFile runs each one whose version is above the file's user_version, after SCHEMA_V1 on
 * a new file, each in its own BEGIN IMMEDIATE that re-checks user_version first. Each sql ends by setting its version.
 * v3 (the gardener) owns 2; a later schema change takes the next number.
 */
export const MIGRATIONS: readonly { version: number; sql: string }[] = [{
  version: 2,
  sql: `
ALTER TABLE items ADD COLUMN merged_into INTEGER REFERENCES items(id);   -- meaningful only while invalid_kind = 'merged'
CREATE TABLE garden_runs (
  id INTEGER PRIMARY KEY,                  -- r<id>
  repo_id INTEGER NOT NULL REFERENCES repos(id),
  node_id TEXT,                            -- the gardener node, once spawned
  trigger TEXT NOT NULL,                   -- GARDEN_TRIGGERS
  state TEXT NOT NULL,                     -- RUN_STATES
  started_at INTEGER NOT NULL, ended_at INTEGER,
  heartbeat_at INTEGER NOT NULL,           -- the owning daemon's watchdog; the lease goes stale by this, not by started_at
  watermark INTEGER NOT NULL,              -- max(items.id) at start: the next threshold counts ids above it
  model TEXT,
  cost_usd REAL, cost_incomplete INTEGER NOT NULL DEFAULT 0,
  stats TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(stats)),   -- GardenRunStats
  note TEXT                                -- why it ended, daemon text
) STRICT;
CREATE TABLE garden_actions (
  id INTEGER PRIMARY KEY,
  run_id INTEGER NOT NULL REFERENCES garden_runs(id),
  ts INTEGER NOT NULL,
  action TEXT NOT NULL,                    -- GARDEN_ACTION_KINDS
  item_id INTEGER NOT NULL REFERENCES items(id),   -- the hidden item
  into_id INTEGER REFERENCES items(id),            -- merge keep, or supersede by
  seen_delta INTEGER NOT NULL DEFAULT 0,           -- what a merge added to the keep's seen; 0 when the keep's row was not written
  reason TEXT NOT NULL,                    -- redacted, oneLine, <= LIMITS.garden.reason; '' after a purge
  undone_at INTEGER, undone_by TEXT,       -- GARDEN_UNDONE_BY
  immune INTEGER NOT NULL DEFAULT 0        -- 1: the human undid this (item_id, into_id) decision; later runs refuse the pair
) STRICT;
CREATE INDEX garden_actions_item ON garden_actions(item_id);
CREATE INDEX garden_actions_pair ON garden_actions(item_id, into_id) WHERE immune = 1;
CREATE INDEX garden_runs_repo ON garden_runs(repo_id, started_at);
PRAGMA user_version = 2;
`,
}];
/** The newest schema this tiller reads and writes; a file above it is off and never written. */
export const SCHEMA_VERSION = MIGRATIONS.at(-1)!.version;

/**
 * A text pin (memory_pin { text }) is a human `note` with pinned = 1 and its own dedupe key (pinDedupe), so it never merges
 * into an agent's note. Pinning by id (memory_pin { id }) sets pinned = 1 on that row, whoever wrote it: the human's
 * explicit choice. Pinned items of any kind render only as pins.
 */
export type ItemKind = MemoryItemKind;
/** The kinds an agent or the human may record with memory_add. */
export const ADD_KINDS = ['procedure', 'pitfall', 'note'] as const satisfies readonly ItemKind[];
export const EPISODE_KINDS = ['spawn', 'outcome', 'gate', 'merge', 'close', 'human_send', 'add', 'forget', 'pin', 'restore'] as const;
/** daemon: text made solely of daemon facts. agent: anything an agent wrote, gate output included. human: the human's. */
export type Author = MemoryItemView['author'];
/** Why an item is hidden: MEMORY_INVALID_KINDS (protocol.ts), so v3 appends to one list. */
export type InvalidKind = MemoryInvalidKind;
/** The item kinds the gardener may hide (D4): a ledger line is one per closed node, never a duplicate, but may be a supersede's by. */
export const GARDEN_KINDS = ['open_question', 'procedure', 'pitfall', 'note'] as const satisfies readonly ItemKind[];
export type GardenActionKind = 'merge' | 'supersede';
export type GardenTrigger = 'schedule' | 'manual';
/**
 * A garden run's state. running holds the lease; every other state is final, except that a finished run becomes reverted
 * when its post-run check fails and the daemon undoes it. skipped: it never started (untrusted or missing checkout).
 */
export type RunState = 'running' | 'done' | 'capped' | 'timeout' | 'off' | 'disabled' | 'interrupted' | 'failed' | 'reverted' | 'skipped';
/** Who undid an action: the human (tl memory garden undo, v2's restore) or the daemon's auto-undo, which never grants immunity. */
export type GardenUndoneBy = 'human' | 'daemon';
/**
 * The rule a refused garden call broke, named in its message and counted in GardenRunStats.refused (D8).
 * not running: the run's lease ended. not a candidate: the id is not in the run's frozen candidate set (another
 * repository's id included). ineligible: it fails ELIGIBLE now. protected: a pinned, human-authored or ledger item as a
 * hidden member. not live: retracted or tombstoned. kind: merge members of different kinds, or a supersede by of another
 * kind that is not a ledger, daemon-authored or seen at least twice. containment: below minContained against the keep
 * or by. terms: a superseded item with fewer than minSupersedeTerms terms. newer: by was not created after id.
 * immune: the human undid this pair. hides, supersedes: the run's caps. duplicate: an id given twice, or id equal to by.
 * chain: the merge would leave a redirect chain longer than LIMITS.garden.chainDepth. copy: a same-kind supersede whose
 * by contains at least copyContained of id's terms: a near-copy, which is merged so the daemon picks the keep.
 */
export type GardenRule =
  | 'not running' | 'not a candidate' | 'ineligible' | 'protected' | 'not live' | 'kind' | 'containment' | 'terms' | 'newer' | 'immune'
  | 'hides' | 'supersedes' | 'duplicate' | 'chain' | 'copy';
/** The digest arm a launch applied, and why: memory.digest on/off, the ab split, or a resume reusing its frozen text. */
export type Arm = MemoryInjectionView['arm'];
export type Cause = MemoryInjectionView['cause'];
/** Which digest a node gets: reviewer covers the reviewer and explorer profiles. */
export type DigestRole = 'orchestrator' | 'worker' | 'reviewer';

/** Every cap and budget. Characters unless named otherwise; a token is about 4 characters. */
export const LIMITS = {
  item: {
    text: 300,
    body: 2_000,
    /** A ledger item's body, and the brief excerpt at its head. */
    ledgerBody: 4_000,
    ledgerBrief: 500,
    /** A node's title in a ledger line. */
    title: 80,
  },
  outcome: {
    openQuestions: 10,
    openQuestion: 300,
    /** An outcome episode's serialized data. */
    episode: 6_000,
  },
  /** A failed gate's tail kept in its episode, cut from the front so the daemon's exit line stays last. */
  gateTail: 2_000,
  procedure: {
    span: 200,
    /** Recency weighting of seen: halves every this many days of age since updated_at. */
    halfLifeDays: 30,
  },
  perNode: { adds: 20, forgets: 20 },
  tools: {
    query: 500,
    reason: 300,
    pinText: 500,
    search: { default: 8, max: 20 },
    statusDays: { default: 14, max: 365 },
  },
  candidates: { pins: 20, ledger: 8, openQuestions: 10, openQuestionDays: 7, procedures: 10, pitfalls: 10, notes: 10, matched: 30 },
  digest: {
    line: 300,
    pinned: 1_200,
    budget: { orchestrator: 6_000, worker: 2_400, reviewer: 1_800 } satisfies Record<DigestRole, number>,
    /** Items per section after Pinned, by digest role, in render order. */
    orchestrator: { recent: 8, raised: 5, verification: 5, pitfalls: 3, notes: 3 },
    worker: { procedures: 3 },
    reviewer: { verification: 3 },
    /** k in the worker's RRF over bm25 and recency ranks. */
    rrfK: 60,
    ftsTerms: 32,
  },
  store: { lockTimeoutMs: 100, retryBrokenMs: 60_000 },
  /** The Memory panel: items per page (list and search), injections in a node's Given log, and an item's givenTo rows. */
  panel: { page: 50, given: 20, givenTo: 20 },
  /** Claude Code's auto-memory as the panel reads it: files per directory, bytes per file (more is truncated), bytes in all. */
  claudeMemory: { files: 100, fileBytes: 65_536, totalBytes: 1_048_576 },
  size: {
    defaultMB: 200,
    minMB: 16,
    /** Enforcement cuts down to this fraction of maxMB. */
    target: 0.9,
    batchRows: 500,
    evictAfterDays: 30,
    vacuumPages: 256,
    ftsMergePages: 200,
    /** The plan says "a few bounded steps"; tune in the store if merges prove slow. */
    ftsMergeSteps: 4,
  },
  /**
   * The gardener (memory v3), fixed until the bench shows a need for a key. A tool call is an attempt seen by a PreToolUse
   * or PermissionRequest hook (denied ones too). Claude's maxTurns does not stop an interactive turn (spike S0), so it is
   * only defence in depth; the daemon's call cap and the wall clock bound a run.
   */
  garden: {
    intervalHours: 24,
    timeoutMinutes: 10,
    leaseMs: 300_000,
    watchdogMs: 30_000,
    /** The hourly tick, and the debounced tick after the last node close. */
    tickMs: 3_600_000,
    afterCloseMs: 60_000,
    /** Daemon proposals (clusters and supersede hints) involving a new item that a scheduled run needs. */
    minProposals: 3,
    /** Hides per run: min(maxHides, ceil(maxHideShare × live gardenable items)), at most maxSupersedes of them supersedes. */
    maxHides: 40,
    maxHideShare: 0.25,
    maxSupersedes: 10,
    minContained: 0.5,
    minSupersedeTerms: 3,
    /**
     * A same-kind supersede whose by contains this much of the hidden item is refused as copy: a near-copy merges instead,
     * so the daemon keeps the established item. A poisoned paraphrase that quotes a note to supersede it scores 1.00;
     * the bench's replaced procedures score 0.75.
     */
    copyContained: 0.95,
    /** The newest gardenable items frozen into a run's candidate set, and items per garden_list page. */
    candidates: 300,
    page: 150,
    chainDepth: 8,
    /** A garden action's reason, and a candidate's text in a page. */
    reason: 200,
    text: 300,
    /** turnBound's ceiling; Claude's agent maxTurns is turnBound's result. */
    maxToolCalls: 20,
    maxOutputChars: 160_000,
    maxPageChars: 60_000,
    /**
     * turnBound's worst case per model request: maxContextTokens of uncached input at inputUsdPerMTok, plus
     * extraRequests beyond one per tool call (the first and the last), plus worstOutputTokens in all at outputUsdPerMTok.
     * Prices are claude-haiku-5-5's below its 100K-token tier.
     */
    maxContextTokens: 90_000,
    inputUsdPerMTok: 0.1,
    outputUsdPerMTok: 0.5,
    worstOutputTokens: 40_000,
    extraRequests: 2,
    /** Consecutive failed, capped, timeout or reverted runs that pause a target until a manual run succeeds. */
    pauseAfterFailures: 2,
    /** A run starts only while every rate-limit window of its account is below this percent. */
    rateLimitPercent: 80,
    /** GardenTarget.recent: the newest runs per target, skipped ones left out. */
    recentRuns: 10,
  },
} as const;

/** The data of each episode kind. harness, model, role and profile are columns, taken from the MemoryScope. */
export interface EpisodeData {
  spawn: { parentId: string | null; kind: NodeKind; branch?: string; preset?: string };
  outcome: Omit<Outcome, 'at'>;
  /** tail only on failure, ≤ LIMITS.gateTail. */
  gate: { ok: boolean; command: string; attempt: number; tail?: string };
  merge: { branch: string; base: string; sha: string; style: MergeStyle };
  close: {
    spentUsd?: number; createdAt: number; closedAt: number; branchFate?: ArchivedNode['branchFate'];
    base?: string; outcome?: Outcome['outcome']; gate?: Outcome['gate'];
  };
  human_send: { messageId: string; outcome: SendOutcome };
  /** actor: the node id, or 'human'. */
  add: { itemId: number; actor: string };
  forget: { itemId: number; actor: string; reason: string };
  pin: { itemId: number; unpin?: boolean };
  /** The human's restore of a hidden item; actor is 'human'. */
  restore: { itemId: number; actor: string };
}
export type EpisodeKind = keyof EpisodeData;
// EPISODE_KINDS lists exactly the keys of EpisodeData.
const episodeKindsMatch: [EpisodeKind, (typeof EPISODE_KINDS)[number]] extends [(typeof EPISODE_KINDS)[number], EpisodeKind] ? true : never = true;
void episodeKindsMatch;

/** What eviction keeps of an old episode's data: its metric fields; every other kind keeps {}. */
export interface EpisodeSkeleton {
  outcome: Pick<EpisodeData['outcome'], 'outcome' | 'gate'>;
  gate: Pick<EpisodeData['gate'], 'ok' | 'command'>;
  close: Pick<EpisodeData['close'], 'spentUsd' | 'createdAt' | 'closedAt' | 'branchFate' | 'outcome' | 'gate'>;
}

/**
 * One element of derive()'s history and of nodeHistory()'s result, and an episode to append: its repo, root, node,
 * harness, model, role and profile come from the MemoryScope.
 */
export type HistoryEntry = { [K in EpisodeKind]: { kind: K; ts: number; data: EpisodeData[K] } }[EpisodeKind];

/**
 * What the daemon captures, at its call sites only (see captureMemory). derive() is pure over it: time comes from ts.
 * gate.tail is the gate's whole tail on failure (derive caps it); close carries the node's archive line, title and prompt included.
 */
export type CaptureEvent =
  | ({ type: 'spawn'; ts: number } & EpisodeData['spawn'])
  | ({ type: 'outcome'; ts: number } & EpisodeData['outcome'])
  | ({ type: 'gate'; ts: number } & EpisodeData['gate'])
  | ({ type: 'merge'; ts: number } & EpisodeData['merge'])
  | { type: 'close'; ts: number; archived: ArchivedNode }
  | ({ type: 'human_send'; ts: number } & EpisodeData['human_send']);

/** An item derive() produces; node, root, harness and model come from the MemoryScope. derive never writes human items. */
export interface DerivedItem {
  kind: ItemKind;
  text: string;
  body?: string;
  author: Exclude<Author, 'human'>;
  /** normalizeDedupe of the redacted text, or the kind's own key (a ledger item's is the node id). */
  dedupe: string;
}
/** derive()'s result: the episode to append, its items, and the item ids its text cited as [m<id>]. */
export interface Derived { episode: HistoryEntry; items: DerivedItem[]; cites: number[] }

/** Where a memory operation applies. account: the node's (undefined: none). The node fields are absent for the human. */
export interface MemoryScope {
  account?: string;
  /** 'git:' + normalizeRemote(origin), else 'path:' + the main checkout's real path. */
  repoKey: string;
  repoPath: string;
  nodeId?: string;
  rootId?: string;
  harness?: Harness;
  model?: string;
  role?: Role;
  profile?: Profile;
}

/** Who calls add, forget or pin. An agent's eligibility comes from its newest outcome episode. */
export type Actor = { kind: 'human' } | { kind: 'agent'; nodeId: string; rootId: string; harness?: Harness; model?: string };

/** A row of items as SELECT * returns it. */
export interface ItemRow {
  id: number;
  repo_id: number;
  kind: ItemKind;
  text: string;
  body: string;
  author: Author;
  node_id: string | null;
  root_id: string | null;
  harness: string | null;
  model: string | null;
  episode_id: number | null;
  dedupe: string;
  seen: number;
  pinned: 0 | 1;
  created_at: number;
  updated_at: number;
  invalid_at: number | null;
  invalid_kind: InvalidKind | null;
  invalid_by: string | null;
  invalid_reason: string | null;
  supersedes: number | null;
  cites: number;
  gets: number;
  /** Schema 2. The keep a merge redirected this item to; readers treat it as null unless invalid_kind is 'merged'. */
  merged_into: number | null;
}

/** A row of injections as SELECT * returns it. item_ids is a JSON array of item ids. */
export interface InjectionRow {
  id: number;
  ts: number;
  session_id: string;
  node_id: string;
  root_id: string;
  repo_id: number;
  arm: Arm;
  cause: Cause;
  role: string | null;
  profile: string | null;
  harness: string | null;
  model: string | null;
  item_ids: string;
  text: string;
}
/** The digest's candidates, eligible and valid only, each list in its ranked order (matched: bm25 order; workers only). */
export interface DigestCandidates {
  pins: MemoryItemView[];
  ledger: MemoryItemView[];
  openQuestions: MemoryItemView[];
  procedures: MemoryItemView[];
  pitfalls: MemoryItemView[];
  notes: MemoryItemView[];
  matched: MemoryItemView[];
}
/**
 * What digestFor reads; MemoryStore implements it. terms come from ftsTerms(brief). now is the caller's clock (digestFor
 * passes its own): the open-question window and procedure recency are measured from it, not from the store's.
 */
export interface DigestSource { candidates(scope: MemoryScope, q: { role: DigestRole; terms: string[]; now: number }): DigestCandidates }
export interface DigestInput { role: DigestRole; brief?: string; now: number }
/** text is '' when nothing was selected. */
export interface DigestResult { text: string; itemIds: number[] }

// ---- The gardener (memory v3): garden runs, their candidates and actions. Refs in JSON are m<id> and r<id>.

/** One item of a garden_list page, as the gardener model sees it. text is oneLine'd and at most LIMITS.garden.text. */
export interface GardenCandidate {
  id: string;
  kind: ItemKind;
  text: string;
  /** Since created_at and updated_at, as "12d", "5h" or "40m". */
  age: string;
  lastSeen: string;
  seen: number;
  author: Author;
  /** Pinned, human-authored or a ledger line: it can be a merge's keep or a supersede's by, never hidden. */
  protected: boolean;
  /** Daemon facts only, such as "not seen for 45 days". */
  hint?: string;
}
/** A daemon-proposed duplicate set of one kind; keep is the daemon's pick (keepRank), and ids include it. */
export interface GardenCluster { kind: ItemKind; keep: string; ids: string[] }
/** An item whose terms a newer same-kind item, or a newer ledger line, contains at minContained or more (D8 rule 5). */
export interface GardenHint { id: string; by: string }
/** One garden_list result. next is the cursor of the following page ("c2"); absent on the last. */
export interface GardenPage {
  run: string;
  page: number;
  pages: number;
  next?: string;
  now: number;
  rules: { hidesLeft: number; supersedesLeft: number; callsLeft: number; minContained: number };
  /** On page 1 only; later pages carry []. */
  clusters: GardenCluster[];
  supersedeHints: GardenHint[];
  items: GardenCandidate[];
}
/** A refused garden call: the rule it broke and a message naming it, shown to the model as an error. */
export interface GardenRefused { ok: false; rule: GardenRule; message: string }
export type GardenActionInput =
  | { action: 'merge'; ids: number[]; reason: string }
  | { action: 'supersede'; id: number; by: number; reason: string };
/** hidesLeft and supersedesLeft are after this action. */
export type GardenApplyResult =
  | { ok: true; action: 'merge'; kept: number; hidden: number[]; hidesLeft: number; supersedesLeft: number }
  | { ok: true; action: 'supersede'; hidden: number; by: number; hidesLeft: number; supersedesLeft: number }
  | GardenRefused;

/** The orchestrator digest and live counts on one side of a run (D9). */
export interface GardenSnapshot {
  live: Partial<Record<ItemKind, number>>;
  digest: { ids: number[]; chars: number };
  /** Digest lines in the same proposed cluster as another digest line. */
  redundancy: number;
}
/** garden_runs.stats. startRun writes candidates, maxHides and before; the rest is written as the run goes and ends. */
export interface GardenRunStats {
  /** The run's candidate set: every id a garden call may touch. */
  candidates: number[];
  /** The hide cap computed at start: min(maxHides, ceil(maxHideShare × live gardenable items)). */
  maxHides: number;
  before: GardenSnapshot;
  after?: GardenSnapshot;
  refused: Partial<Record<GardenRule, number>>;
  /** Attempted tool calls, and tool-output characters returned to the model. */
  calls: number;
  outputChars: number;
  /** verifyRun's findings, when it found any. */
  violations?: string[];
}
export interface GardenActionView {
  id: number;
  runId: number;
  ts: number;
  action: GardenActionKind;
  itemId: number;
  /** The merge keep or the supersede by. */
  intoId?: number;
  seenDelta: number;
  reason: string;
  undoneAt?: number;
  undoneBy?: GardenUndoneBy;
  immune: boolean;
  /** run() only: the texts as they are now ('' for a tombstone). */
  itemText?: string;
  intoText?: string;
}
export interface GardenRunView {
  id: number;
  repoKey: string;
  nodeId?: string;
  trigger: GardenTrigger;
  state: RunState;
  startedAt: number;
  endedAt?: number;
  heartbeatAt: number;
  watermark: number;
  model?: string;
  costUsd?: number;
  costIncomplete: boolean;
  note?: string;
  stats: GardenRunStats;
  /** run() only, oldest first. */
  actions?: GardenActionView[];
}
/** One repository in one existing account file, as the scheduler judges it (D4). */
export interface GardenTarget {
  /** The account file's key: an account name, or _default. */
  key: string;
  repoKey: string;
  repoPath: string;
  /** Live, unpinned, eligible items of GARDEN_KINDS above the newest started run's watermark (every one, before any run). */
  newItems: number;
  /** Daemon proposals (clusters and supersede hints) with at least one new item. */
  proposals: number;
  /** Newest first, at most LIMITS.garden.recentRuns, skipped runs left out. A running one holds or held the lease. */
  recent: GardenRunView[];
}
export type GardenUndoTarget = { run: number; immune?: boolean } | { item: number };
export interface GardenUndoResult {
  undone: { actionId: number; runId: number; itemId: number; intoId?: number }[];
  skipped: { actionId: number; itemId: number; reason: string }[];
}

/**
 * What the gardener runtime, its tools and its CLI need from the store; MemoryStore implements it. account is the spawn
 * account, as everywhere in the store, and run ids are per account file. The tool methods (gardenPage, gardenGet,
 * gardenApply) refuse 'not running' once the lease has ended, and check every D8 rule inside the transaction that
 * applies the call. No method creates a file.
 */
export interface GardenStore {
  /** Every repository in every existing account file, with its scheduling facts. Reads only: it recovers nothing. */
  gardenTargets(): GardenTarget[];
  /**
   * Take the file's lease and freeze the run (BEGIN IMMEDIATE): refused while another run of this file is running with a
   * heartbeat younger than LIMITS.garden.leaseMs. watermark = max(items.id). stats.candidates is the newest
   * LIMITS.garden.candidates live, eligible items of GARDEN_KINDS (pinned and human ones included, as protected), plus
   * every item a daemon proposal names (a ledger line as a hint's by included).
   */
  startRun(scope: MemoryScope, input: { trigger: GardenTrigger; model: string }): { ok: true; run: GardenRunView } | { ok: false; reason: string };
  /** Record a run that never started; no new row when the repo's newest run is already skipped with the same note. */
  skipRun(scope: MemoryScope, input: { trigger: GardenTrigger; note: string }): void;
  heartbeat(account: string | undefined, runId: number): void;
  setRunNode(account: string | undefined, runId: number, nodeId: string): void;
  /** A page of the frozen candidate set. cursor is a page's "c<n>"; callsLeft is the runtime's count, echoed in rules. */
  gardenPage(account: string | undefined, runId: number, q: { cursor?: string; callsLeft: number }): GardenPage | GardenRefused;
  /** One candidate with its body; it does not count as a read (gets). */
  gardenGet(account: string | undefined, runId: number, id: number): { ok: true; item: GardenCandidate & { body: string } } | GardenRefused;
  gardenApply(account: string | undefined, runId: number, input: GardenActionInput): GardenApplyResult;
  /** Set stats.calls and stats.outputChars to the runtime's running totals. */
  countCalls(account: string | undefined, runId: number, totals: { calls: number; outputChars: number }): void;
  /**
   * End the lease: running → state, so every later tool call is refused. The one other transition is a finished run →
   * 'reverted' after auto-undo. Returns false, changing nothing, when neither applies.
   */
  endRun(account: string | undefined, runId: number, state: Exclude<RunState, 'running' | 'skipped'>, note?: string): boolean;
  /**
   * Record the run's cost, ended_at and stats.after, once: a later call returns the stored run unchanged. A run still
   * running is first ended as 'interrupted'. usd is what the caller charges (D11).
   */
  finishRun(account: string | undefined, runId: number, cost: { usd: number; incomplete: boolean }): GardenRunView;
  /** D9's post-run checks: [] when the run is sound. Records any findings in stats.violations. */
  verifyRun(account: string | undefined, runId: number): string[];
  /**
   * Undo a run's actions, or an item's latest one, newest first (D7). The human's item undo, and a run undo with immune,
   * mark the pairs immune; the daemon's never does. A run or item of another repository is "no such run" or "no such
   * item" (MemoryError).
   */
  undo(scope: MemoryScope, target: GardenUndoTarget, by: GardenUndoneBy): GardenUndoResult;
  /** Runs newest first, skipped ones included, without actions. */
  runs(account: string | undefined, q?: { repoKey?: string; limit?: number }): GardenRunView[];
  /** One run with its actions and their texts; MemoryError "no such run r<id>" otherwise. */
  run(account: string | undefined, runId: number): GardenRunView;
  /** cost_usd summed over the file's runs started in the 30 days before now. */
  cost30d(account: string | undefined): number;
}

const REF = /^m([1-9]\d{0,15})$/;
const RUN_REF = /^r([1-9]\d{0,15})$/;
const refId = (re: RegExp, ref: string): number | undefined => {
  const m = re.exec(ref);
  const id = m ? Number(m[1]) : NaN;
  return Number.isSafeInteger(id) ? id : undefined;
};
export const itemRef = (id: number): string => `m${id}`;
/** The id an `m<id>` ref names; undefined for anything else, or an id past the safe integer range. */
export const parseItemRef = (ref: string): number | undefined => refId(REF, ref);
export const runRef = (id: number): string => `r${id}`;
/** The id an `r<id>` ref names, as parseItemRef. */
export const parseRunRef = (ref: string): number | undefined => refId(RUN_REF, ref);

const ref = z.string().regex(REF, 'an item id like m12');
const run = z.string().regex(RUN_REF, 'a run id like r12');
const gardenReason = z.string().min(1).max(LIMITS.garden.reason);
/** repo (a path) and account pick the scope; for the human only, as spawn's account is. */
const humanScope = { repo: z.string().min(1).optional(), account: z.string().min(1).optional() };
/**
 * Input shapes of the memory tools. memory_pin, memory_status, memory_switch and memory_garden are humanOnly; the garden_*
 * tools are the gardener's only, and take their scope from its node record, never from arguments. Rules a raw shape
 * cannot state are the handlers': memory_pin takes exactly one of id and text; memory_switch refuses account with
 * project; memory_garden's run needs repo, show needs run, undo takes exactly one of run and id, and immune only with run.
 */
export const MEMORY_TOOL_SHAPES = {
  memory_search: {
    query: z.string().min(1).max(LIMITS.tools.query), kind: z.enum(MEMORY_ITEM_KINDS).optional(),
    limit: z.number().int().min(1).max(LIMITS.tools.search.max).optional(), includeRetracted: z.boolean().optional(), ...humanScope,
  },
  memory_get: { id: ref, ...humanScope },
  memory_add: {
    kind: z.enum(ADD_KINDS), text: z.string().min(1).max(LIMITS.item.text), body: z.string().max(LIMITS.item.body).optional(),
    supersedes: ref.optional(), ...humanScope,
  },
  memory_forget: { id: ref, reason: z.string().min(1).max(LIMITS.tools.reason), purge: z.boolean().optional(), ...humanScope },
  memory_pin: { id: ref.optional(), text: z.string().min(1).max(LIMITS.tools.pinText).optional(), unpin: z.boolean().optional(), ...humanScope },
  memory_status: {
    days: z.number().int().min(1).max(LIMITS.tools.statusDays.max).optional(), nodeId: z.string().min(1).optional(), account: z.string().min(1).optional(),
    /** A directory whose project to report on (human only, as the tool is). */
    repo: z.string().min(1).optional(),
  },
  /** on: null means inherit (remove the setting). No account or project sets the global memory.enabled. */
  memory_switch: { on: z.boolean().nullable(), account: z.string().min(1).optional(), project: z.string().min(1).optional() },
  /** wait: run returns when the run ends. */
  memory_garden: {
    action: z.enum(['status', 'run', 'show', 'undo']), run: run.optional(), id: ref.optional(), wait: z.boolean().optional(),
    immune: z.boolean().optional(), ...humanScope,
  },
  garden_list: { cursor: z.string().regex(/^c[1-9]\d{0,3}$/, 'a page cursor like c2').optional() },
  garden_get: { id: ref },
  garden_merge: { ids: z.array(ref).min(2).max(8), reason: gardenReason },
  garden_supersede: { id: ref, by: ref, reason: gardenReason },
} satisfies Record<`memory_${string}` | `garden_${string}`, z.ZodRawShape>;

export const REDACTED = '[redacted]';
// prune: known secret formats only; an unknown format is stored as written until the human purges it.
const SECRET_PATTERNS: RegExp[] = [
  // A PEM private key, to its END line or, when cut off, to the end of the text.
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY-----|$)/g,
  /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g,
  /\bgh[pousr]_[A-Za-z0-9_]{20,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
  /\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{20,}/g, // Anthropic, OpenAI
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/g,
  /\bAIza[A-Za-z0-9_-]{30,}/g,
  /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*/g, // JWT
];

function redactString(s: string): string {
  let out = s;
  for (const re of SECRET_PATTERNS) out = out.replace(re, REDACTED);
  // URL userinfo: keep the user, drop the password.
  out = out.replace(/\b([a-z][a-z0-9+.-]*:\/\/[^/\s:@]*):[^/\s@]+@/gi, `$1:${REDACTED}@`);
  // prune: a credential must look like one (a digit, a symbol or an inner capital), so "Basic understanding" stays prose.
  out = out.replace(/\b(Bearer|Basic)(\s+)([A-Za-z0-9._~+/-]{8,}=*)/gi, (all, scheme, gap, cred: string) =>
    (/[0-9._~+/=-]|.[A-Z]/.test(cred) ? `${scheme}${gap}${REDACTED}` : all));
  // key = value, key: value, "key": "value"; access_token and API_KEY included.
  return out.replace(/(password|secret|token|api[_-]?key)(["']?\s*[:=]\s*)("[^"\n]*"|'[^'\n]*'|[^\s,;}'"]+)/gi, `$1$2${REDACTED}`);
}

/** value with every string in it, however deep, cleared of known secret formats. Idempotent; object keys are kept. */
export function redact<T>(value: T): T {
  if (typeof value === 'string') return redactString(value) as T;
  if (Array.isArray(value)) return value.map(redact) as T;
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, redact(v)])) as T;
  return value;
}

const ANSI = /\x1b\[[0-9;?]*[A-Za-z]/g;
/** The exit line runCommands appends to a failed gate's output (worktree.ts). */
const EXIT_LINE = /: (?:exited with \d+|stopped by \S+ \(time limit [\d.]+ minutes\))$/;

/** The daemon's own exit line, read from the tail's last non-empty line only; undefined when that is not one. */
export function gateExit(tail: string): string | undefined {
  const last = tail.trimEnd().split('\n').at(-1)?.trim();
  return last && EXIT_LINE.test(last) ? last : undefined;
}

/**
 * The line of a failed gate's output most likely to name the error: the first matching error|fail|✗|✖|×|not ok|TS<digits>,
 * else the last non-empty output line. Never the daemon's exit line, nor node:test's run summary ("ℹ fail 0", "# fail 0",
 * "✖ failing tests:"). It is gate output, so agent text.
 */
export function firstErrorLine(tail: string): string | undefined {
  const lines = tail.replace(ANSI, '').split('\n').map((l) => l.trim())
    .filter((l) => l && !/^(?:[ℹ#] \w+ [\d.]+|✖ failing tests:)$/.test(l));
  if (gateExit(tail) !== undefined) lines.pop();
  // prune: keyword heuristic; parse per-tool formats if pitfalls show the wrong line.
  return lines.find((l) => /error|fail|✗|✖|×|^not ok|TS\d{4}/i.test(l)) ?? lines.at(-1);
}

/** The first structural error code in the tail (TS2345, E0308): one token that cannot carry an instruction. */
export const structuralCode = (tail: string): string | undefined => /\b[A-Z]{1,5}\d{3,5}\b/.exec(tail)?.[0];

/** An item's dedupe key: lowercase, whitespace collapsed, and for pitfalls each digit run as #. Pass redacted text. */
export function normalizeDedupe(kind: ItemKind, text: string): string {
  const key = text.toLowerCase().replace(/\s+/g, ' ').trim();
  return kind === 'pitfall' ? key.replace(/\d+/g, '#') : key;
}

/**
 * A text pin's dedupe key. normalizeDedupe lowercases, so its keys never contain "PIN:": no agent text can produce this
 * key, and UNIQUE (repo_id, kind, dedupe) keeps a pin apart from an agent note with the same text.
 */
export const pinDedupe = (text: string): string => `PIN:${normalizeDedupe('note', text)}`;

/**
 * A git remote URL as one key: scheme, userinfo, a trailing / and .git removed, scp host:path as host/path, lowercased.
 * A local-path remote (absolute, or file://) is returned as its path, unchanged in case; resolve a relative one against
 * the checkout before calling. Prefix the result with 'git:'.
 */
export function normalizeRemote(url: string): string {
  const u = url.trim();
  const file = /^file:\/\//i.test(u) ? u.slice('file://'.length) : u;
  if (file.startsWith('/')) return file.replace(/\/+$/, '') || '/';
  const scheme = /^[a-z][a-z0-9+.-]*:\/\//i.exec(u);
  let rest = scheme ? u.slice(scheme[0].length) : u;
  const slash = rest.indexOf('/');
  const at = rest.lastIndexOf('@', slash < 0 ? undefined : slash);
  if (at >= 0) rest = rest.slice(at + 1);
  // scp form: a colon before any slash separates host and path.
  if (!scheme) rest = rest.replace(/^([^/:]+):\/*/, '$1/');
  return rest.replace(/\/+$/, '').replace(/\.git$/i, '').replace(/\/+$/, '').toLowerCase();
}

const STOPWORDS = new Set(('a an and are as at be but by can do does for from has have if in into is it its me my no not of on or our '
  + 'should so than that the their them then there these they this to too use was we were what when where which while who why will with '
  + 'would you your all any also each how just more most only other some such very').split(' '));
/** Directory names and file extensions that nearly every code path shares, so they say nothing about which work is related (bench D-2). */
const CODE_STOPWORDS = new Set(('src lib test tests spec specs index dist js jsx mjs cjs ts tsx mts cts json md yml yaml toml txt css scss html '
  + 'py rs go sh').split(' '));
const TOKEN = /[\p{L}\p{N}_]+/gu;
const PATH = /[\p{L}\p{N}_-]+(?:[/.][\p{L}\p{N}_-]+)+/gu;

/**
 * Search terms from untrusted text (a node's brief, a tool query): path mentions (src/daemon/x.ts, messaging.ts) as
 * phrases of all their tokens, space-joined, so only that exact path matches one; then single tokens of 2+ letters,
 * digits or _, lowercased, without stopwords, code stopwords (src, test, ts...) or repeats, at most
 * LIMITS.digest.ftsTerms. A path's specific parts thus stay as tokens and its generic ones only inside the phrase. A
 * term holds only letters, digits, _ and single spaces, so quoting each one (and joining with OR) keeps every FTS5
 * operator out of a MATCH.
 */
export function ftsTerms(text: string, max: number = LIMITS.digest.ftsTerms): string[] {
  const terms = new Set<string>();
  for (const [path] of text.toLowerCase().matchAll(PATH)) {
    const parts = path.match(TOKEN) ?? [];
    if (parts.length > 1 && (path.includes('/') || /[\p{L}\p{N}_-]{2,}\.\p{L}[\p{L}\p{N}]{0,4}$/u.test(path))) terms.add(parts.join(' '));
  }
  for (const [token] of text.toLowerCase().matchAll(TOKEN)) {
    if (token.length >= 2 && !STOPWORDS.has(token) && !CODE_STOPWORDS.has(token)) terms.add(token);
  }
  return [...terms].slice(0, max);
}

/**
 * The share of `hidden`'s terms (ftsTerms, uncapped) that `target` also has: |T(h) ∩ T(t)| / |T(h)|, 0 when hidden has
 * none. Asymmetric on purpose: a short item never covers a long one (D8 rule 5).
 */
// prune: lexical similarity; v4's embeddings replace it if bench G1 refuses more than 10 % of labeled-correct actions.
export function contained(hidden: string, target: string): number {
  const h = ftsTerms(hidden, Infinity);
  if (!h.length) return 0;
  const t = new Set(ftsTerms(target, Infinity));
  return h.filter((x) => t.has(x)).length / h.length;
}

const AUTHOR_RANK: Record<Author, number> = { human: 0, daemon: 1, agent: 2 };
/**
 * Orders merge members best first, so sort(keepRank)[0] is the keep: pinned, then human > daemon > agent, then seen
 * descending, then created_at ascending, then id. The gardener's own order never counts.
 */
export function keepRank(a: Pick<ItemRow, 'id' | 'author' | 'seen' | 'pinned' | 'created_at'>, b: typeof a): number {
  return b.pinned - a.pinned || AUTHOR_RANK[a.author] - AUTHOR_RANK[b.author] || b.seen - a.seen || a.created_at - b.created_at || a.id - b.id;
}

/** The memory file key of a node's account: the name, or _default for none or Claude's default home (no configDir). */
export const DEFAULT_ACCOUNT_KEY = '_default';
/**
 * accounts is claudeAccounts(home), which throws on an invalid list, so a named account fails closed. Throws for a
 * name not in the list. Account names cannot start with _, so _default never collides with one.
 */
export function accountKey(accounts: readonly Pick<ClaudeAccount, 'name' | 'configDir'>[], account: string | undefined): string {
  if (account === undefined) return DEFAULT_ACCOUNT_KEY;
  const a = accounts.find((x) => x.name === account);
  if (!a) throw new Error(`Claude account "${account}" is not configured (claude.accounts)`);
  return a.configDir ? a.name : DEFAULT_ACCOUNT_KEY;
}
