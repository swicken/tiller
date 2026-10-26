import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  LIMITS, normalizeDedupe, type Actor, type Derived, type DerivedItem, type EpisodeInput, type ItemKind, type MemoryScope,
} from './memory-schema.js';
import { DIGEST_SECTIONS, digestFor } from './memory-digest.js';
import { ftsQuery, MemoryStore, readFailure } from './memory-store.js';

const DAY = 86_400_000;
const T0 = Date.UTC(2026, 9, 1);

let home: string;
let clock: number;
let logs: string[];
const stores: MemoryStore[] = [];
const open = (opts: { now?: () => number } = {}) => {
  const s = new MemoryStore(home, { now: () => clock, log: (err) => logs.push(typeof err === 'string' ? err : (err as Error).message), ...opts });
  stores.push(s);
  return s;
};

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'tl-'));
  clock = T0;
  logs = [];
});
afterEach(() => {
  for (const s of stores.splice(0)) s.close();
  vi.restoreAllMocks();
  rmSync(home, { recursive: true, force: true });
});

const file = () => join(home, 'memory', '_default.db');
const scope = (nodeId = 'n-w1', rootId = 'n-r1', repoKey = 'git:example.com/a/b'): MemoryScope =>
  ({ repoKey, repoPath: '/repo', nodeId, rootId, harness: 'claude', model: 'claude-x' });
const human: Actor = { kind: 'human' };
const agent = (nodeId = 'n-w1', rootId = 'n-r1'): Actor => ({ kind: 'agent', nodeId, rootId, harness: 'claude', model: 'claude-x' });
const item = (kind: ItemKind, text: string, author: DerivedItem['author'] = 'agent', body?: string): DerivedItem =>
  ({ kind, text, author, dedupe: normalizeDedupe(kind, text), ...(body === undefined ? {} : { body }) });
const derived = (items: DerivedItem[], episode: EpisodeInput = { kind: 'spawn', ts: clock, data: { parentId: null, kind: 'claude' } }, cites: number[] = []): Derived =>
  ({ episode, items, cites });
const outcome = (outcome: 'succeeded' | 'failed', gate?: 'passed' | 'failed', ts = clock): EpisodeInput =>
  ({ kind: 'outcome', ts, data: { outcome, ...(gate ? { gate } : {}) } });
/** A raw handle on the account file, for checks the store does not expose. */
const raw = () => new DatabaseSync(file());
const row = (id: number) => { const db = raw(); try { return db.prepare('SELECT * FROM items WHERE id = ?').get(id) as Record<string, unknown>; } finally { db.close(); } };

describe('account files', () => {
  it('maps no account and accounts without configDir to _default, others to their name', () => {
    writeFileSync(join(home, 'config.json'), JSON.stringify({ claude: { accounts: [{ name: 'work', configDir: '/tmp/work-claude' }, { name: 'plain' }] } }));
    const s = open();
    expect(s.accountFile(undefined)).toBe(join(home, 'memory', '_default.db'));
    expect(s.accountFile('plain')).toBe(join(home, 'memory', '_default.db'));
    expect(s.accountFile('work')).toBe(join(home, 'memory', 'work.db'));
    expect(() => s.accountFile('nobody')).toThrow(/not configured/);
  });

  it('fails closed for named accounts while claude.accounts is invalid', () => {
    writeFileSync(join(home, 'config.json'), JSON.stringify({ claude: { accounts: 'nope' } }));
    const s = open();
    expect(() => s.accountFile('work')).toThrow(/claude.accounts/);
    s.apply({ ...scope(), account: 'work' }, derived([item('note', 'a note')]));
    expect(existsSync(join(home, 'memory'))).toBe(false);
    expect(() => s.search({ ...scope(), account: 'work' }, { query: 'note' })).toThrow(/^memory is unavailable: .*claude.accounts/);
    expect(s.accountFile(undefined)).toBe(file()); // no account needs no list
  });
});

describe('upsert and retraction', () => {
  it('bumps seen on a repeat with no burned ids', () => {
    const s = open();
    for (let i = 0; i < 3; i++) s.apply(scope(), derived([item('pitfall', 'gate `npm test` failed: boom 12')]));
    s.apply(scope(), derived([item('pitfall', 'gate `npm test` failed: other')]));
    expect(row(1)).toMatchObject({ seen: 3, kind: 'pitfall' });
    expect(row(2)).toMatchObject({ seen: 1, text: 'gate `npm test` failed: other' });
  });

  it('revives an agent retraction when later work derives it again; human retractions and supersedes stick', () => {
    const s = open();
    s.apply(scope(), derived([item('procedure', 'npm test'), item('procedure', 'npm run typecheck'), item('procedure', 'cargo test')]));
    s.forget(scope(), agent(), { id: 1, reason: 'flaky' });
    s.forget(scope(), human, { id: 2, reason: 'wrong' });
    s.add(scope(), human, { kind: 'procedure', text: 'cargo test --locked', supersedes: 3 });
    expect([row(1).invalid_kind, row(2).invalid_kind, row(3).invalid_kind]).toEqual(['agent', 'human', 'superseded']);
    s.apply(scope('n-w2'), derived([item('procedure', 'npm test'), item('procedure', 'npm run typecheck'), item('procedure', 'cargo test')]));
    expect(row(1)).toMatchObject({ invalid_kind: null, invalid_at: null, seen: 2 });
    expect(row(2)).toMatchObject({ invalid_kind: 'human', seen: 1 });
    expect(row(3)).toMatchObject({ invalid_kind: 'superseded', seen: 1 });
  });

  it("records an agent's supersede as an agent retraction", () => {
    const s = open();
    s.apply(scope(), derived([item('note', 'old note')]));
    expect(s.add(scope(), agent(), { kind: 'note', text: 'new note', supersedes: 1 })).toEqual({ id: 2 });
    expect(row(1)).toMatchObject({ invalid_kind: 'agent', invalid_by: 'n-w1', invalid_reason: 'superseded by m2' });
    expect(row(2)).toMatchObject({ supersedes: 1, author: 'agent', node_id: 'n-w1' });
  });

  it('revives an agent-retracted item that eviction tombstoned with the new text, findable by FTS', async () => {
    const s = open();
    s.apply(scope(), derived([item('pitfall', 'gate `npm test` failed: Zebra 1', 'agent', 'old body')]));
    s.forget(scope(), agent(), { id: 1, reason: 'stale' });
    clock = T0 + 40 * DAY;
    await s.enforceLimit(0);
    expect(row(1)).toMatchObject({ text: '', body: '', invalid_kind: 'agent' });
    s.apply(scope('n-w2'), derived([item('pitfall', 'gate `npm test` failed: Zebra 2', 'agent', 'giraffe body')], { kind: 'spawn', ts: clock, data: { parentId: null, kind: 'claude' } }));
    expect(row(1)).toMatchObject({ text: 'gate `npm test` failed: Zebra 2', body: 'giraffe body', invalid_kind: null });
    expect(s.search(scope(), { query: 'giraffe' }).map((v) => v.id)).toEqual([1]);
    expect(s.search(scope(), { query: 'zebra' }).map((v) => v.id)).toEqual([1]);
  });

  it('answers memory_add for live, revived and sticky items', () => {
    const s = open();
    expect(s.add(scope(), agent(), { kind: 'note', text: 'Use the fake pty' })).toEqual({ id: 1 });
    expect(s.add(scope(), agent(), { kind: 'note', text: 'use  the FAKE pty' })).toEqual({ id: 1, existing: true });
    s.forget(scope(), agent(), { id: 1, reason: 'meh' });
    expect(s.add(scope(), agent(), { kind: 'note', text: 'Use the fake pty' })).toEqual({ id: 1, revived: true });
    s.forget(scope(), human, { id: 1, reason: 'no' });
    expect(() => s.add(scope(), agent(), { kind: 'note', text: 'Use the fake pty' })).toThrow('retracted by the human as m1; not re-added');
  });

  it('refuses agents on pinned items and purge, and caps adds and forgets per node', () => {
    const s = open();
    const pin = s.pin(scope(), human, { text: 'Never run the release script from a worker' });
    expect(pin).toMatchObject({ id: 1, pinned: true, author: 'human', kind: 'note' });
    expect(() => s.forget(scope(), agent(), { id: 1, reason: 'x' })).toThrow(/pinned/);
    expect(() => s.add(scope(), agent(), { kind: 'note', text: 'replacement', supersedes: 1 })).toThrow(/pinned/);
    expect(() => s.forget(scope(), agent(), { id: 1, reason: 'x', purge: true })).toThrow('only the human can purge');
    expect(() => s.pin(scope(), agent(), { id: 1 })).toThrow('only the human can pin');
    for (let i = 0; i < 20; i++) s.add(scope(), agent('n-cap'), { kind: 'note', text: `note ${i}` });
    expect(() => s.add(scope(), agent('n-cap'), { kind: 'note', text: 'the twenty-first' })).toThrow('memory_add is limited to 20 per node');
    expect(s.add(scope(), agent('n-other'), { kind: 'note', text: 'the twenty-first' }).id).toBeGreaterThan(1);
  });

  it('pins restore a retracted item, and unpin undoes a pin', () => {
    const s = open();
    s.apply(scope(), derived([item('procedure', 'npm test')]));
    s.forget(scope(), human, { id: 1, reason: 'oops' });
    expect(s.pin(scope(), human, { id: 1 })).toMatchObject({ pinned: true });
    expect(row(1)).toMatchObject({ invalid_at: null, pinned: 1 });
    expect(s.pin(scope(), human, { id: 1, unpin: true })).toMatchObject({ pinned: false });
    expect(row(1)).toMatchObject({ invalid_at: null });
    expect(() => s.pin(scope(), human, { id: 1, text: 'x' })).toThrow('exactly one');
  });

  it('retracts a text pin when it is unpinned, and refuses to pin a tombstone', () => {
    const s = open();
    const pin = s.pin(scope(), human, { text: 'Ask before pushing' });
    expect(s.pin(scope(), human, { text: 'ask before  pushing', unpin: true })).toMatchObject({ id: pin.id, pinned: false, invalid: { kind: 'human' } });
    expect(s.candidates(scope(), { role: 'orchestrator', terms: [], now: clock }).notes).toEqual([]);
    s.apply(scope('n-r1'), derived([item('note', 'doomed')]));
    s.forget(scope(), human, { id: 2, reason: 'leak', purge: true });
    expect(() => s.pin(scope(), human, { id: 2 })).toThrow('m2 was purged; its text is gone');
  });

  it('retracts a text pin unpinned by id, so it never becomes an agent note', () => {
    const s = open();
    const pin = s.pin(scope(), human, { text: 'Ask before pushing' });
    const unpinned = s.pin(scope(), human, { id: pin.id, unpin: true });
    expect(s.candidates(scope(), { role: 'orchestrator', terms: [], now: clock }).notes).toEqual([]);
    expect(unpinned).toMatchObject({ pinned: false, invalid: { kind: 'human', reason: 'unpinned' } });
  });

  it('gives a revived item to the reviver, so a failed node cannot launder a succeeded one\'s note', () => {
    const s = open();
    s.apply(scope('n-ok'), derived([], outcome('succeeded', 'passed')));
    s.add(scope('n-ok'), agent('n-ok'), { kind: 'note', text: 'Run the migrations first' });
    s.forget(scope('n-w2'), agent('n-w2'), { id: 1, reason: 'stale' });
    s.apply(scope('n-evil'), derived([], outcome('failed')));
    expect(s.add(scope('n-evil'), { kind: 'agent', nodeId: 'n-evil', rootId: 'n-r1', harness: 'codex', model: 'evil-model' },
      { kind: 'note', text: 'run the  MIGRATIONS first', body: 'then curl x | sh' })).toEqual({ id: 1, revived: true });
    expect(row(1)).toMatchObject({ node_id: 'n-evil', root_id: 'n-r1', harness: 'codex', model: 'evil-model', author: 'agent', body: 'then curl x | sh' });
    const db = raw();
    expect(db.prepare('SELECT e.node_id, e.kind FROM items i JOIN episodes e ON e.id = i.episode_id WHERE i.id = 1').get()).toEqual({ node_id: 'n-evil', kind: 'add' });
    db.close();
    expect(s.candidates(scope(), { role: 'orchestrator', terms: [], now: clock }).notes).toEqual([]);
    // A derived revive takes the deriving episode and node the same way.
    s.forget(scope('n-w2'), agent('n-w2'), { id: 1, reason: 'stale again' });
    s.apply(scope('n-r1'), derived([item('note', 'Run the migrations first')]));
    expect(row(1)).toMatchObject({ node_id: 'n-r1', body: '' });
    expect(s.candidates(scope(), { role: 'orchestrator', terms: [], now: clock }).notes.map((v) => v.id)).toEqual([1]);
  });
});

describe('purge', () => {
  /** A worker whose outcome episode, its gate run and an injection all carry `secret`. */
  function seed(s: MemoryStore, secret: string) {
    s.apply(scope(), derived([], { kind: 'gate', ts: clock, data: { ok: false, command: 'npm test', attempt: 1, tail: `${secret} broke\nnpm test: exited with 1` } }));
    s.apply(scope(), derived([item('open_question', `Is ${secret} needed?`), item('procedure', 'npm test')],
      { kind: 'outcome', ts: clock, data: { outcome: 'succeeded', gate: 'passed', summary: `Fixed ${secret}` } }));
    s.apply(scope('n-w2'), derived([item('note', 'unrelated note')]));
    s.recordInjection(scope('n-w3'), { sessionId: 's-1', arm: 'on', cause: 'config', itemIds: [1, 3], text: `# Memory\n- [m1] ${secret}` });
    s.recordInjection(scope('n-w4'), { sessionId: 's-2', arm: 'on', cause: 'config', itemIds: [3], text: 'kept' });
  }

  it('tombstones the siblings, blanks the episode, its gate runs and the injections that named them', () => {
    const s = open();
    seed(s, 'plughword');
    const v = s.forget(scope(), human, { id: 1, reason: 'leaked', purge: true });
    expect(v).toMatchObject({ tombstone: 'purged', text: '', body: '', invalid: { kind: 'human', by: 'human' } });
    expect(row(2)).toMatchObject({ text: '', dedupe: 'purged:2', invalid_kind: 'human' });
    expect(row(3)).toMatchObject({ text: 'unrelated note', invalid_at: null });
    const db = raw();
    const data = db.prepare(`SELECT kind, data FROM episodes WHERE node_id = 'n-w1' ORDER BY id`).all().map((r) => [r.kind, JSON.parse(String(r.data))]);
    db.close();
    expect(data).toEqual([['gate', { ok: false, command: 'npm test' }], ['outcome', { outcome: 'succeeded', gate: 'passed' }]]);
    expect(s.frozen(undefined, 's-1')).toMatchObject({ text: '', itemIds: [1, 3] });
    expect(s.frozen(undefined, 's-2')).toMatchObject({ text: 'kept' });
    expect(s.search(scope(), { query: 'plughword', includeRetracted: true })).toEqual([]);
    // The purged text no longer blocks the same item being recorded again: its dedupe key was blanked too.
    expect(s.add(scope(), agent('n-w5'), { kind: 'procedure', text: 'npm test' })).toEqual({ id: 4 });
  });

  it('logs a purge checkpoint that another reader blocked', () => {
    const s = open();
    seed(s, 'readerword');
    const db = raw();
    db.exec('BEGIN');
    db.prepare('SELECT count(*) FROM items').get();
    try {
      s.forget(scope(), human, { id: 1, reason: 'leaked', purge: true });
    } finally {
      db.exec('COMMIT');
      db.close();
    }
    expect(logs.some((l) => l.includes('wal_checkpoint(TRUNCATE) was blocked'))).toBe(true);
  });

  it('removes the purged bytes from the database and its WAL', () => {
    const s = open();
    seed(s, 'zqxjvplumbus');
    const bytes = () => readFileSync(file()).toString('latin1') + (existsSync(`${file()}-wal`) ? readFileSync(`${file()}-wal`).toString('latin1') : '');
    expect(bytes()).toContain('zqxjvplumbus');
    s.forget(scope(), human, { id: 1, reason: 'leaked', purge: true });
    expect(bytes()).not.toContain('zqxjvplumbus');
    expect(bytes()).not.toContain('zqxjvplumbu'); // nor its porter stem in the FTS index
  });
});

describe('create only on write', () => {
  it('reads, status and enforceLimit on a home without memory create nothing', async () => {
    const s = open();
    expect(s.status()).toEqual([]);
    await s.enforceLimit(1);
    expect(s.search(scope(), { query: 'anything' })).toEqual([]);
    expect(s.candidates(scope(), { role: 'worker', terms: ['anything'], now: clock })).toMatchObject({ pins: [], matched: [] });
    expect(s.frozen(undefined, 's-1')).toBeUndefined();
    expect(s.injections(undefined, 'n-w1')).toEqual([]);
    expect(s.nodeHistory(scope(), 'n-w1')).toEqual([]);
    expect(s.stats(undefined, 14).on.nodes).toBe(0);
    expect(() => s.get(scope(), 1)).toThrow('no such item m1');
    expect(() => s.forget(scope(), human, { id: 1, reason: 'x' })).toThrow('no such item m1');
    expect(existsSync(join(home, 'memory'))).toBe(false);
  });

  it('creates the directory 0700 and the files 0600', () => {
    const s = open();
    s.apply(scope(), derived([item('note', 'hello')]));
    expect(statSync(join(home, 'memory')).mode & 0o777).toBe(0o700);
    expect(statSync(file()).mode & 0o777).toBe(0o600);
    expect(statSync(`${file()}-wal`).mode & 0o777).toBe(0o600);
    const db = raw();
    expect([db.prepare('PRAGMA auto_vacuum').get(), db.prepare('PRAGMA journal_mode').get(), db.prepare('PRAGMA user_version').get()])
      .toEqual([{ auto_vacuum: 2 }, { journal_mode: 'wal' }, { user_version: 2 }]);
    db.close();
  });

  /** The schema memory v2 shipped (SCHEMA_V1 at c5414ba), frozen here so a later edit to SCHEMA_V1 cannot hide a migration bug. */
  const SHIPPED_V1 = `
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

  it('migrates a v1 file to schema 2 when it opens, keeping its items', () => {
    mkdirSync(join(home, 'memory'), { recursive: true });
    const v1 = new DatabaseSync(file());
    v1.exec(SHIPPED_V1);
    v1.prepare(`INSERT INTO repos (key, path, created_at) VALUES ('git:example.com/a/b', '/repo', 0)`).run();
    v1.prepare(`INSERT INTO items (repo_id, kind, text, author, dedupe, created_at, updated_at) VALUES (2, 'note', 'kept from v1', 'agent', 'kept from v1', 0, 0)`).run();
    v1.close();
    const s = open();
    expect(s.search(scope(), { query: 'kept' }).map((v) => v.text)).toEqual(['kept from v1']);
    expect(s.status()[0]).toMatchObject({ state: 'ok', schema: 2 });
    const db = raw();
    expect(db.prepare('SELECT merged_into FROM items').get()).toEqual({ merged_into: null });
    expect(db.prepare('SELECT count(*) AS n FROM garden_runs').get()).toEqual({ n: 0 });
    db.close();
  });
});

describe('search, history and eligibility', () => {
  it('survives hostile FTS input, stems with porter and hides other repositories', () => {
    const s = open();
    s.apply(scope(), derived([item('pitfall', 'tests failing on the daemon socket')]));
    for (const query of ['foo AND (', '"', '*', 'NEAR(', 'text:x OR', '^', '-']) expect(() => s.search(scope(), { query })).not.toThrow();
    expect(s.search(scope(), { query: 'failed sockets' }).map((v) => v.id)).toEqual([1]);
    const other = scope('n-w1', 'n-r1', 'git:example.com/other');
    expect(s.search(other, { query: 'failed sockets' })).toEqual([]);
    expect(() => s.get(other, 1)).toThrow('no such item m1');
    expect(s.get(scope(), 1)).toMatchObject({ id: 1, gets: 1, body: '' });
    expect(ftsQuery(['a"b', 'src daemon'])).toBe('"a""b" OR "src daemon"');
  });

  it('drives FTS queries from the index, not from the items of the repo', () => {
    const s = open();
    for (let i = 0; i < 50; i++) s.apply(scope('n-r1'), derived([item('note', `note number ${i} about sockets`)]));
    const sql: string[] = [];
    const prepare = DatabaseSync.prototype.prepare;
    vi.spyOn(DatabaseSync.prototype, 'prepare').mockImplementation(function (this: DatabaseSync, text: string) {
      if (text.includes('MATCH')) sql.push(text);
      return prepare.call(this, text);
    });
    s.search(scope(), { query: 'sockets', kind: 'note' });
    s.search(scope(), { query: 'sockets', includeRetracted: true });
    s.candidates(scope(), { role: 'worker', terms: ['sockets'], now: clock });
    vi.restoreAllMocks();
    expect(sql).toHaveLength(3);
    const db = raw();
    try {
      for (const q of sql) expect((db.prepare(`EXPLAIN QUERY PLAN ${q}`).all()[0] as { detail: string }).detail).toMatch(/^SCAN items_fts VIRTUAL TABLE/);
    } finally {
      db.close();
    }
  });

  it('redacts derived items again in apply, dedupe keys included', () => {
    const s = open();
    const secret = 'AKIAABCDEFGHIJKLMNOP';
    s.apply(scope('n-r1'), derived([item('pitfall', `deploy failed with key ${secret}`, 'agent', `body ${secret}`)],
      { kind: 'outcome', ts: clock, data: { outcome: 'succeeded', summary: `used ${secret}` } }));
    const db = raw();
    const dump = JSON.stringify([db.prepare('SELECT * FROM items').all(), db.prepare('SELECT * FROM episodes').all()]);
    db.close();
    expect(dump.toLowerCase()).not.toContain(secret.toLowerCase());
    expect(row(1)).toMatchObject({ text: 'deploy failed with key [redacted]', dedupe: 'deploy failed with key [redacted]' });
  });

  it("returns a node's episodes since its latest outcome", () => {
    const s = open();
    const gate = (ok: boolean): EpisodeInput => ({ kind: 'gate', ts: clock, data: { ok, command: 'npm test', attempt: 1 } });
    s.apply(scope(), derived([], gate(false)));
    s.apply(scope(), derived([], outcome('failed', 'failed')));
    s.apply(scope(), derived([], gate(false)));
    s.apply(scope(), derived([], gate(true)));
    s.apply(scope('n-w2'), derived([], gate(false)));
    expect(s.nodeHistory(scope(), 'n-w1').map((h) => [h.kind, h.kind === 'gate' && h.data.ok])).toEqual([['gate', false], ['gate', true]]);
  });

  it('puts in candidates only items from the root, from succeeded nodes without a failed gate, and from the human or daemon', () => {
    const s = open();
    const note = (node: string, text: string, author: DerivedItem['author'] = 'agent') => s.apply(scope(node), derived([item('note', text, author)]));
    note('n-r1', 'from root');
    note('n-ok', 'from succeeded');
    s.apply(scope('n-ok'), derived([], outcome('succeeded', 'passed')));
    note('n-fail', 'from failed');
    s.apply(scope('n-fail'), derived([], outcome('failed')));
    note('n-gate', 'from gate failed');
    s.apply(scope('n-gate'), derived([], outcome('succeeded', 'failed')));
    note('n-silent', 'from no outcome');
    note('n-fail', 'daemon fact', 'daemon');
    s.add(scope(), human, { kind: 'note', text: 'from human' });
    // An earlier success does not cover a later failure: only the newest outcome counts.
    note('n-flip', 'from flipped');
    s.apply(scope('n-flip'), derived([], outcome('succeeded')));
    s.apply(scope('n-flip'), derived([], outcome('failed')));
    const notes = s.candidates(scope(), { role: 'orchestrator', terms: [], now: clock }).notes.map((v) => v.text);
    expect(notes.sort()).toEqual(['daemon fact', 'from human', 'from root', 'from succeeded']);
  });

  it('fills every candidate list per its rules', () => {
    const s = open();
    s.apply(scope('n-r1'), derived([item('ledger', 'other repo, same tree')], undefined), );
    s.apply(scope('n-r1', 'n-r1', 'git:example.com/other'), derived([item('ledger', 'other repo ledger in my tree')]));
    s.apply(scope('n-x', 'n-x', 'git:example.com/other'), derived([item('ledger', 'other repo other tree')]));
    clock = T0 - 10 * DAY;
    s.apply(scope('n-r1'), derived([item('open_question', 'old question')], { kind: 'spawn', ts: clock, data: { parentId: null, kind: 'claude' } }));
    clock = T0;
    s.apply(scope('n-r1'), derived([item('open_question', 'new question'), item('procedure', 'npm test'), item('pitfall', 'messaging flake')]));
    for (let i = 0; i < 3; i++) s.apply(scope('n-r1'), derived([item('procedure', 'npm run typecheck')]));
    s.pin(scope(), human, { text: 'pinned rule' });
    const c = s.candidates(scope(), { role: 'worker', terms: ['messaging'], now: clock });
    expect(c.pins.map((v) => v.text)).toEqual(['pinned rule']);
    expect(c.ledger.map((v) => v.text).sort()).toEqual(['other repo ledger in my tree', 'other repo, same tree']);
    expect(c.openQuestions.map((v) => v.text)).toEqual(['new question']);
    expect(c.procedures.map((v) => v.text)).toEqual(['npm run typecheck', 'npm test']);
    expect(c.matched.map((v) => v.text)).toEqual(['messaging flake']);
    expect(c.notes).toEqual([]);
    expect(s.candidates(scope(), { role: 'orchestrator', terms: ['messaging'], now: clock }).matched).toEqual([]);
  });

  it('counts an item as matched only when it shares two of the terms, or the only one', () => {
    const s = open();
    s.apply(scope('n-r1'), derived([item('ledger', 'invoice rounding in billing'), item('pitfall', 'billing flake')]));
    const matched = (terms: string[]) => s.candidates(scope(), { role: 'worker', terms, now: clock }).matched.map((v) => v.text);
    expect(matched(['invoice', 'billing', 'theme'])).toEqual(['invoice rounding in billing']);
    expect(matched(['billing', 'theme'])).toEqual([]);
    expect(matched(['billing']).sort()).toEqual(['billing flake', 'invoice rounding in billing']);
  });
});

describe('failure modes', () => {
  it('quarantines a corrupt file, keeping its bytes, and starts a new one', () => {
    mkdirSync(join(home, 'memory'), { recursive: true });
    const garbage = 'this is not a database '.repeat(400);
    writeFileSync(file(), garbage);
    const s = open();
    s.apply(scope(), derived([item('note', 'after the corruption')]));
    const aside = readdirSync(join(home, 'memory')).filter((f) => /^_default\.corrupt-\d+\.db$/.test(f));
    expect(aside).toHaveLength(1);
    expect(readFileSync(join(home, 'memory', aside[0]), 'utf8')).toBe(garbage);
    expect(s.search(scope(), { query: 'corruption' }).map((v) => v.text)).toEqual(['after the corruption']);
    expect(s.status()[0]).toMatchObject({ state: 'ok', quarantined: [join(home, 'memory', aside[0])] });
    expect(logs.some((l) => l.includes('is corrupt'))).toBe(true);
  });

  it('skips the operation while another handle holds the write lock', () => {
    const s = open();
    s.apply(scope(), derived([item('note', 'first')]));
    const db = raw();
    db.exec('BEGIN IMMEDIATE');
    try {
      s.apply(scope(), derived([item('note', 'second')]));
      s.apply(scope(), derived([item('note', 'third')]));
      expect(() => s.add(scope(), human, { kind: 'note', text: 'fourth' })).toThrow('memory is unavailable: database is locked');
      expect(s.search(scope(), { query: 'first' })).toHaveLength(1); // reads still work under WAL
    } finally {
      db.exec('ROLLBACK');
      db.close();
    }
    expect(logs.filter((l) => l.includes('locked'))).toHaveLength(1);
    expect(s.search(scope(), { query: 'second' })).toEqual([]);
    s.apply(scope(), derived([item('note', 'fifth')]));
    expect(s.search(scope(), { query: 'fifth' })).toHaveLength(1);
  });

  it('never writes a file from a newer schema', () => {
    open().apply(scope(), derived([item('note', 'kept')]));
    stores.pop()!.close();
    const db = raw();
    db.exec('PRAGMA user_version = 99');
    db.close();
    const s = open();
    s.apply(scope(), derived([item('note', 'dropped')]));
    expect(s.candidates(scope(), { role: 'orchestrator', terms: [], now: clock }).notes).toEqual([]);
    expect(() => s.search(scope(), { query: 'kept' })).toThrow('memory is unavailable: written by a newer tiller (schema 99)');
    expect(s.status()[0].state).toBe('off: written by a newer tiller (schema 99)');
    const check = raw();
    expect(check.prepare('SELECT count(*) AS n FROM items').get()).toEqual({ n: 1 });
    check.close();
  });

  it('turns off without node:sqlite and creates no file', () => {
    vi.spyOn(process, 'getBuiltinModule').mockReturnValue(undefined as never);
    const s = open();
    s.apply(scope(), derived([item('note', 'x')]));
    s.recordInjection(scope(), { sessionId: 's', arm: 'on', cause: 'config', itemIds: [], text: '' });
    expect(() => s.add(scope(), human, { kind: 'note', text: 'x' })).toThrow('memory is unavailable: this Node has no node:sqlite');
    expect(existsSync(join(home, 'memory'))).toBe(false);
  });

  it('turns off without FTS5 and creates no file', () => {
    const real = process.getBuiltinModule('node:sqlite');
    class NoFts extends real.DatabaseSync {
      override exec(sql: string) {
        if (/fts5/i.test(sql)) throw new Error('no such module: fts5');
        return super.exec(sql);
      }
    }
    vi.spyOn(process, 'getBuiltinModule').mockReturnValue({ ...real, DatabaseSync: NoFts } as never);
    const s = open();
    s.apply(scope(), derived([item('note', 'x')]));
    expect(() => s.add(scope(), human, { kind: 'note', text: 'x' })).toThrow('memory is unavailable: no FTS5');
    expect(existsSync(join(home, 'memory'))).toBe(false);
  });
});

describe('size limit', () => {
  const big = (n: number) => `${'lorem ipsum dolor '.repeat(Math.ceil(n / 18))}`.slice(0, n);
  /** About 1 MB each of old injection texts, old episode data and old ledger bodies, plus a pin, a procedure and a human retraction. */
  function seed(s: MemoryStore) {
    clock = T0 - 60 * DAY;
    for (let i = 0; i < 300; i++) {
      const node = `n-${i}`;
      s.apply(scope(node), derived([item('ledger', `ledger ${i}`, 'daemon', big(3_000))],
        { kind: 'outcome', ts: clock, data: { outcome: 'succeeded', summary: big(3_000) } }));
      s.recordInjection(scope(node), { sessionId: `s-${i}`, arm: 'on', cause: 'config', itemIds: [1], text: big(3_000) });
    }
    s.apply(scope('n-r1'), derived([item('procedure', 'npm test'), item('pitfall', 'gate `x` failed: forgotten')]));
    s.forget(scope(), human, { id: 302, reason: 'wrong' });
    s.pin(scope(), human, { text: 'pinned rule' });
    clock = T0;
  }
  const usedBytes = (s: MemoryStore) => s.status()[0].usedBytes!;
  const onDisk = () => statSync(file()).size + (existsSync(`${file()}-wal`) ? statSync(`${file()}-wal`).size : 0);

  it('blanks old injection texts first and stops once under 0.9 x the limit', async () => {
    const s = open();
    seed(s);
    expect(usedBytes(s)).toBeGreaterThan(2.5 * 1024 * 1024);
    await s.enforceLimit(3);
    expect(usedBytes(s)).toBeLessThanOrEqual(0.9 * 3 * 1024 * 1024);
    const db = raw();
    expect(db.prepare(`SELECT count(*) AS n FROM injections WHERE text <> ''`).get()).toEqual({ n: 0 });
    expect(db.prepare(`SELECT count(*) AS n FROM items WHERE kind = 'ledger' AND text <> ''`).get()).toEqual({ n: 300 });
    expect(db.prepare(`SELECT count(*) AS n FROM episodes WHERE json_extract(data, '$.summary') IS NOT NULL`).get()).toEqual({ n: 300 });
    db.close();
  });

  it('evicts in order down to 0.9 x a tiny limit, never pins, keeps human retractions sticky and shrinks the file', async () => {
    const s = open();
    seed(s);
    const before = onDisk();
    let tickedFirst = false, done = false;
    setImmediate(() => { tickedFirst = !done; });
    await s.enforceLimit(1);
    done = true;
    expect(tickedFirst).toBe(true); // it yielded to the event loop
    expect(usedBytes(s)).toBeLessThanOrEqual(0.9 * 1024 * 1024);
    expect(onDisk()).toBeLessThan(before / 2);
    const db = raw();
    expect(db.prepare(`SELECT count(*) AS n FROM injections WHERE text <> ''`).get()).toEqual({ n: 0 });
    expect(db.prepare(`SELECT count(*) AS n FROM episodes WHERE json_extract(data, '$.summary') IS NOT NULL`).get()).toEqual({ n: 0 });
    db.close();
    expect(s.get(scope('n-0'), 1)).toMatchObject({ tombstone: 'evicted', text: '', invalid: { kind: 'evicted' } });
    expect(s.candidates(scope(), { role: 'orchestrator', terms: [], now: clock })).toMatchObject({
      pins: [{ text: 'pinned rule' }], procedures: [{ text: 'npm test' }],
    });
    expect(row(302)).toMatchObject({ text: '', invalid_kind: 'human' });
    s.apply(scope('n-again'), derived([item('pitfall', 'gate `x` failed: forgotten')]));
    expect(row(302)).toMatchObject({ text: '', invalid_kind: 'human', seen: 1 });
    expect(s.status()[0].overLimit).toBeUndefined();
  });

  it('reports a file still over the limit after eviction', async () => {
    const s = open();
    for (let i = 0; i < 40; i++) s.pin(scope(), human, { text: `pin ${i} ${big(400)}` });
    await s.enforceLimit(0);
    expect(s.status()[0].overLimit).toBe(true);
    expect(logs.some((l) => l.includes('over memory.maxMB'))).toBe(true);
    expect(s.candidates(scope(), { role: 'orchestrator', terms: [], now: clock }).pins).toHaveLength(20);
  });
});

describe('bench hooks', () => {
  it('lets a second store on the same home seed backdated items as an agent whose outcome was applied first', () => {
    open().apply(scope('n-r1'), derived([item('note', 'from the daemon store')]));
    let script = T0 - 3 * DAY;
    const s = open({ now: () => script });
    s.apply(scope('n-ok'), derived([], outcome('succeeded', 'passed', script)));
    s.apply(scope('n-bad'), derived([], outcome('failed', undefined, script)));
    script += 60_000;
    s.add(scope('n-ok'), agent('n-ok'), { kind: 'note', text: 'eligible note' });
    s.add(scope('n-bad'), agent('n-bad'), { kind: 'note', text: 'ineligible note' });
    const notes = s.candidates(scope(), { role: 'orchestrator', terms: [], now: T0 }).notes;
    expect(notes.map((v) => [v.text, v.createdAt])).toEqual([['eligible note', T0 - 3 * DAY + 60_000], ['from the daemon store', T0]].sort((a, b) => Number(b[1]) - Number(a[1])));
  });

  it('snapshots a file with an uncheckpointed WAL', () => {
    const s = open();
    for (let i = 0; i < 50; i++) s.apply(scope(), derived([item('note', `snapshot flake number ${i}`)]));
    expect(statSync(`${file()}-wal`).size).toBeGreaterThan(0);
    const other = mkdtempSync(join(tmpdir(), 'tl-'));
    try {
      mkdirSync(join(other, 'memory'));
      s.snapshot(undefined, join(other, 'memory', '_default.db'));
      expect(statSync(join(other, 'memory', '_default.db')).mode & 0o777).toBe(0o600);
      expect(() => s.snapshot(undefined, join(other, 'memory', '_default.db'))).toThrow(/cannot create .*EEXIST/);
      const copy = new MemoryStore(other, { now: () => clock });
      try {
        const q = { query: 'snapshot flake', limit: 20 };
        expect(copy.search(scope(), q)).toEqual(s.search(scope(), q));
        expect(copy.search(scope(), q)).toHaveLength(20);
      } finally {
        copy.close();
      }
    } finally {
      rmSync(other, { recursive: true, force: true });
    }
  });
});

describe('injections and stats', () => {
  it('lists a node’s injections and compares the arms', () => {
    const s = open();
    s.apply(scope(), derived([item('pitfall', 'gate `npm test` failed: Error: boom in parser')]));
    s.recordInjection(scope('n-a'), { sessionId: 's-a', arm: 'on', cause: 'ab', itemIds: [1], text: '# Memory' });
    s.recordInjection(scope('n-a'), { sessionId: 's-a', arm: 'on', cause: 'resume', itemIds: [1], text: '' });
    s.recordInjection(scope('n-b'), { sessionId: 's-b', arm: 'off', cause: 'ab', itemIds: [1], text: '# Memory (shadow)' });
    s.apply(scope('n-a'), derived([], { kind: 'gate', ts: clock, data: { ok: true, command: 'npm test', attempt: 1 } }));
    s.apply(scope('n-a'), derived([], { kind: 'outcome', ts: clock, data: { outcome: 'succeeded', gate: 'passed', verified: 'avoided [m1]' } }));
    s.apply(scope('n-b'), derived([], { kind: 'gate', ts: clock, data: { ok: false, command: 'npm test', attempt: 1, tail: 'Error: boom in parser\nnpm test: exited with 1' } }));
    s.apply(scope('n-b'), derived([], { kind: 'outcome', ts: clock, data: { outcome: 'failed', gate: 'failed' } }));
    expect(s.injections(undefined, 'n-a')).toEqual([
      { sessionId: 's-a', arm: 'on', cause: 'ab', itemIds: [1], text: '# Memory', ts: clock },
      { sessionId: 's-a', arm: 'on', cause: 'resume', itemIds: [1], text: '', ts: clock },
    ]);
    expect(s.injections(undefined, 'n-a', 1)).toEqual([{ sessionId: 's-a', arm: 'on', cause: 'resume', itemIds: [1], text: '', ts: clock }]);
    const stats = s.stats(undefined, 14);
    expect(stats.on).toMatchObject({ nodes: 1, firstPassGate: 1, failedOutcomes: 0, gateRunsPerSuccess: 1, citesPerInjected: 1, repeatedPitfalls: 0 });
    expect(stats.off).toMatchObject({ nodes: 1, firstPassGate: 0, failedOutcomes: 1, gateRunsPerSuccess: null, repeatedPitfalls: 1, repeatedInjectedPitfalls: 1 });
  });
});

describe('the panel (v2)', () => {
  it('browses newest first with a keyset that neither repeats nor skips rows sharing updated_at', () => {
    const s = open();
    s.apply(scope(), derived(Array.from({ length: 130 }, (_, i) => item('note', `same time note ${i}`))));
    const ids: number[] = [];
    let before: { updatedAt: number; id: number } | undefined, pages = 0;
    do {
      const page = s.list(scope(), { before });
      expect(page.items.length).toBeLessThanOrEqual(50);
      ids.push(...page.items.map((v) => v.id));
      before = page.next;
      pages++;
    } while (before);
    expect(pages).toBe(3);
    expect(ids).toEqual(Array.from({ length: 130 }, (_, i) => 130 - i));
    expect(s.list(scope(), { before: { updatedAt: T0, id: 1 } })).toEqual({ items: [] });
  });

  it('marks text pins, and only them, as textPin', () => {
    const s = open();
    s.apply(scope(), derived([item('note', 'pinned agent note')]));
    s.pin(scope(), human, { id: 1 });
    const pin = s.pin(scope(), human, { text: 'Pinned text' });
    expect(pin.textPin).toBe(true);
    expect(s.peek(scope(), pin.id).item.textPin).toBe(true);
    expect(s.search(scope(), { query: 'pinned', eligible: true }).map((v) => [v.id, v.textPin])).toEqual(expect.arrayContaining([[1, undefined], [pin.id, true]]));
    const rows = s.list(scope(), { pinned: true }).items;
    expect(rows.map((v) => [v.id, v.textPin])).toEqual([[pin.id, true], [1, undefined]]);
    expect(rows[1]).not.toHaveProperty('textPin');
    expect(s.pin(scope(), human, { id: pin.id, unpin: true }).textPin).toBe(true); // still the human's text pin, now retracted
  });

  it('filters by kind, pinned and retracted, and omits body, cites, gets and rootId', () => {
    const s = open();
    s.apply(scope(), derived([item('procedure', 'npm test', 'agent', 'the body'), item('pitfall', 'gate failed: boom'), item('note', 'a note')]));
    s.pin(scope(), human, { id: 2 });
    s.forget(scope(), human, { id: 3, reason: 'stale' });
    expect(s.list(scope(), {}).items.map((v) => v.id)).toEqual([2, 1]);
    expect(s.list(scope(), { retracted: true }).items.map((v) => v.id)).toEqual([3, 2, 1]);
    expect(s.list(scope(), { kind: 'procedure' }).items.map((v) => v.id)).toEqual([1]);
    expect(s.list(scope(), { pinned: true }).items.map((v) => v.id)).toEqual([2]);
    const [procedure] = s.list(scope(), { kind: 'procedure' }).items;
    for (const omitted of ['body', 'cites', 'gets', 'rootId']) expect(procedure).not.toHaveProperty(omitted);
  });

  it('marks each row eligible as the digest would take it', () => {
    const s = open();
    s.apply(scope('n-ok'), derived([], outcome('succeeded', 'passed')));
    s.apply(scope('n-bad'), derived([], outcome('failed')));
    s.apply(scope('n-gatefail'), derived([], outcome('succeeded', 'failed')));
    s.add(scope('n-ok'), agent('n-ok'), { kind: 'note', text: 'from a succeeded node' });
    s.add(scope('n-bad'), agent('n-bad'), { kind: 'note', text: 'from a failed node' });
    s.add(scope('n-gatefail'), agent('n-gatefail'), { kind: 'note', text: 'from a node whose gate failed' });
    s.add(scope('n-none'), agent('n-none'), { kind: 'note', text: 'from a node with no outcome' });
    s.add(scope('n-r1'), agent('n-r1', 'n-r1'), { kind: 'note', text: 'from the root' });
    s.apply(scope('n-bad'), derived([item('ledger', 'daemon fact', 'daemon')]));
    s.add(scope(), human, { kind: 'note', text: 'from the human' });
    expect(Object.fromEntries(s.list(scope(), {}).items.map((v) => [v.text, v.eligible]))).toEqual({
      'from a succeeded node': true, 'from a failed node': false, 'from a node whose gate failed': false, 'from a node with no outcome': false,
      'from the root': true, 'daemon fact': true, 'from the human': true,
    });
  });

  it('extends search with a pinned filter, eligible rows and a limit of 50, leaving the tool output as it was', () => {
    const s = open();
    s.apply(scope(), derived([item('note', 'zebra crossing rules')]));
    expect(JSON.stringify(s.search(scope(), { query: 'zebra' }))).toBe(JSON.stringify([{
      id: 1, kind: 'note', text: 'zebra crossing rules', author: 'agent', nodeId: 'n-w1', rootId: 'n-r1', harness: 'claude', model: 'claude-x',
      seen: 1, pinned: false, cites: 0, gets: 0, createdAt: T0, updatedAt: T0,
    }]));
    s.apply(scope(), derived(Array.from({ length: 60 }, (_, i) => item('note', `zebra number ${i}`))));
    s.pin(scope(), human, { id: 5 });
    expect(s.search(scope(), { query: 'zebra', limit: 99 })).toHaveLength(50);
    const rows = s.search(scope(), { query: 'zebra', limit: 99, eligible: true });
    expect(rows.every((v) => v.eligible === false && !('body' in v) && !('gets' in v))).toBe(true);
    expect(s.search(scope(), { query: 'zebra', pinned: true }).map((v) => v.id)).toEqual([5]);
    expect(s.search(scope(), { query: 'the src of this' })).toEqual([]);
  });

  it('counts per kind, pins and retractions; lists repos without the sentinel; reports one file even for no account', () => {
    const s = open();
    s.apply(scope(), derived([item('procedure', 'npm test'), item('note', 'a')]));
    s.apply(scope(), derived([item('note', 'b')]));
    s.apply(scope('n-w1', 'n-r1', 'git:example.com/other'), derived([item('note', 'elsewhere')]));
    s.pin(scope(), human, { text: 'pinned text' });
    s.forget(scope(), human, { id: 2, reason: 'x' });
    s.forget(scope(), human, { id: 3, reason: 'x', purge: true });
    expect(s.counts(scope())).toEqual({ ledger: 0, open_question: 0, procedure: 1, pitfall: 0, note: 1, pinned: 1, retracted: 2 });
    expect(s.repos(undefined)).toEqual([{ key: 'git:example.com/a/b', path: '/repo', items: 2 }, { key: 'git:example.com/other', path: '/repo', items: 1 }]);
    writeFileSync(join(home, 'config.json'), JSON.stringify({ claude: { accounts: [{ name: 'work', configDir: '/tmp/work-claude' }] } }));
    s.apply({ ...scope(), account: 'work' }, derived([item('note', 'work note')]));
    expect(s.status()).toHaveLength(2);
    expect(s.fileStatus(undefined)).toMatchObject({ key: '_default', state: 'ok' });
    expect(s.fileStatus('nobody').state).toMatch(/^off: .*not configured/);
  });

  it('peeks without counting a get, with its superseder and the fresh digests that gave it', () => {
    const s = open();
    s.apply(scope(), derived([item('note', 'old note', 'agent', 'the body')]));
    s.add(scope(), human, { kind: 'note', text: 'new note', supersedes: 1 });
    s.recordInjection(scope('n-a'), { sessionId: 's-a', arm: 'on', cause: 'config', itemIds: [1], text: 'x' });
    clock += 1000;
    s.recordInjection(scope('n-a'), { sessionId: 's-a', arm: 'on', cause: 'resume', itemIds: [1], text: '' });
    s.recordInjection(scope('n-b'), { sessionId: 's-b', arm: 'off', cause: 'ab', itemIds: [2, 1], text: 'y' });
    const d = s.peek(scope(), 1);
    expect(d).toMatchObject({ item: { id: 1, body: 'the body', gets: 0, eligible: false, invalid: { kind: 'superseded' } }, supersededBy: 2 });
    expect(d.givenTo).toEqual([{ nodeId: 'n-b', sessionId: 's-b', arm: 'off', ts: clock }, { nodeId: 'n-a', sessionId: 's-a', arm: 'on', ts: T0 }]);
    expect(row(1).gets).toBe(0);
    expect(() => s.peek(scope('n-w1', 'n-r1', 'git:example.com/other'), 1)).toThrow('no such item m1');
  });

  it('restores agent and human retractions, keeping pinned, and refuses the rest', () => {
    const s = open();
    s.apply(scope(), derived([item('procedure', 'npm test'), item('procedure', 'cargo test'), item('note', 'gardened'), item('note', 'live')]));
    s.apply(scope(), derived([item('note', 'doomed')]));
    s.pin(scope(), human, { id: 1 });
    s.forget(scope(), human, { id: 1, reason: 'wrong' });
    s.forget(scope(), agent(), { id: 2, reason: 'stale' });
    s.forget(scope(), human, { id: 5, reason: 'leak', purge: true });
    const db = raw();
    db.prepare(`UPDATE items SET invalid_at = 1, invalid_kind = 'gardener', invalid_by = 'gardener' WHERE id = 3`).run();
    db.close();
    const pin = s.pin(scope(), human, { text: 'Ask first' });
    s.pin(scope(), human, { id: pin.id, unpin: true });
    expect(() => s.restore(scope(), human, { id: 4 })).toThrow('m4 is not retracted');
    expect(() => s.restore(scope(), human, { id: 5 })).toThrow('m5 was purged; its text is gone');
    expect(() => s.restore(scope(), human, { id: pin.id })).toThrow(`m${pin.id} is a text pin; pin it again instead`);
    expect(() => s.restore(scope(), human, { id: 3 })).toThrow('cannot restore a gardener item here');
    expect(() => s.restore(scope(), agent(), { id: 1 })).toThrow('only the human can restore');
    expect(s.restore(scope(), human, { id: 2 })).toMatchObject({ id: 2, pinned: false });
    clock += 1000;
    expect(s.restore(scope(), human, { id: 1 })).toMatchObject({ id: 1, pinned: true, updatedAt: clock });
    expect(s.list(scope(), {}).items[0]!.id).toBe(1); // back at the top of the browse
    expect(row(1)).toMatchObject({ invalid_at: null, pinned: 1 });
    expect(s.candidates(scope(), { role: 'orchestrator', terms: [], now: clock }).pins.map((v) => v.id)).toEqual([1]);
    const check = raw();
    expect(check.prepare(`SELECT node_id, data FROM episodes WHERE kind = 'restore' ORDER BY id`).all()).toEqual([
      { node_id: 'human', data: JSON.stringify({ itemId: 2, actor: 'human' }) }, { node_id: 'human', data: JSON.stringify({ itemId: 1, actor: 'human' }) },
    ]);
    check.close();
    s.apply(scope('n-w2'), derived([item('procedure', 'npm test')]));
    expect(row(1)).toMatchObject({ seen: 2, invalid_at: null });
  });

  it('edits a text pin: the new text supersedes the old, which only pinning its text again brings back', () => {
    const s = open();
    const digest = () => digestFor(s, scope(), { role: 'worker', brief: '', now: clock }).text;
    const old = s.pin(scope(), human, { text: 'Never push to main' });
    const edited = s.editPin(scope(), human, { id: old.id, text: 'Never push to main or release' });
    expect(edited).toMatchObject({ pinned: true, supersedes: old.id, author: 'human', text: 'Never push to main or release' });
    expect(digest()).toContain(`${DIGEST_SECTIONS.pinned}\n- [m${edited.id}] `);
    expect(digest()).not.toMatch(/: Never push to main$/m);
    expect(row(old.id)).toMatchObject({ pinned: 0, invalid_kind: 'superseded', invalid_by: 'human', invalid_reason: `edited as m${edited.id}` });
    expect(() => s.editPin(scope(), human, { id: edited.id, text: 'never push to  MAIN or release' })).toThrow('unchanged');
    // Editing to the text of an earlier pin, since unpinned, revives that row instead of hitting UNIQUE.
    const earlier = s.pin(scope(), human, { text: 'Run the linter' });
    s.pin(scope(), human, { id: earlier.id, unpin: true });
    const again = s.editPin(scope(), human, { id: edited.id, text: 'run the LINTER' });
    expect(again).toMatchObject({ id: earlier.id, pinned: true, text: 'run the LINTER', supersedes: edited.id });
    expect(again.invalid).toBeUndefined();
    const other = s.pin(scope(), human, { text: 'Other pin' });
    expect(() => s.editPin(scope(), human, { id: other.id, text: 'Run the linter' })).toThrow(`already pinned as m${earlier.id}`);
    // The human's prerogative: pinning the old text again revives the old row.
    expect(s.pin(scope(), human, { text: 'Never push to main' })).toMatchObject({ id: old.id, pinned: true });
    expect(row(old.id).invalid_at).toBeNull();
    expect(digest()).toMatch(/: Never push to main$/m);
    // Only the human's own live text pins can be edited.
    s.apply(scope(), derived([item('note', 'an agent note')]));
    const note = s.list(scope(), { kind: 'note' }).items.find((v) => v.text === 'an agent note')!;
    s.pin(scope(), human, { id: note.id });
    s.pin(scope(), human, { id: old.id, unpin: true });
    for (const id of [note.id, old.id]) {
      expect(() => s.editPin(scope(), human, { id, text: 'y' })).toThrow('only your own text pins can be edited; pin new text instead');
    }
    expect(() => s.editPin(scope(), agent(), { id: other.id, text: 'z' })).toThrow('only the human can pin');
  });

  it('edits back to an earlier text without a supersede cycle', () => {
    const s = open();
    const a = s.pin(scope(), human, { text: 'Text A' });
    const b = s.editPin(scope(), human, { id: a.id, text: 'Text B' });
    expect(s.peek(scope(), a.id).supersededBy).toBe(b.id);
    const back = s.editPin(scope(), human, { id: b.id, text: 'Text A' });
    expect(back).toMatchObject({ id: a.id, pinned: true, supersedes: b.id });
    expect(row(b.id).supersedes).toBeNull();
    expect(s.peek(scope(), a.id).supersededBy).toBeUndefined();
    expect(s.peek(scope(), b.id).supersededBy).toBe(a.id);
  });

  it('reports a read that hit a lock as locked, anything else as off', () => {
    const busy = Object.assign(new Error('database is locked'), { errcode: 5 });
    expect(readFailure(new Error('memory is unavailable: database is locked', { cause: busy }))).toBe('locked: database is locked');
    expect(readFailure(new Error('memory is unavailable: disk I/O error', { cause: Object.assign(new Error('disk I/O error'), { errcode: 10 }) })))
      .toBe('off: disk I/O error');
    const writer = open();
    writer.apply(scope(), derived([item('note', 'x')]));
    writer.close();
    const db = raw(); // holds the file exclusively, as another process could
    db.exec('PRAGMA locking_mode = EXCLUSIVE; BEGIN IMMEDIATE');
    db.prepare(`UPDATE items SET seen = seen + 1`).run();
    try {
      expect(open().fileStatus(undefined, true).state).toMatch(/^locked: database is locked/);
    } finally {
      db.exec('ROLLBACK');
      db.close();
    }
  });

  it('logs expected conditions as one string and an unexpected failure as its own error', () => {
    mkdirSync(join(home, 'memory'), { recursive: true });
    writeFileSync(file(), 'this is not a database '.repeat(400));
    const got: unknown[] = [];
    stores.push(new MemoryStore(home, { now: () => clock, log: (e) => got.push(e) }));
    stores.at(-1)!.apply(scope(), derived([item('note', 'x')]));
    expect(got).toEqual([expect.stringMatching(/^memory \(_default\): .*_default\.db is corrupt \(.*\); moved it to /)]);
    const boom = new Error('injected failure');
    const real = process.getBuiltinModule('node:sqlite');
    class Broken extends real.DatabaseSync {
      constructor(path: string) {
        if (path !== ':memory:') throw boom;
        super(path);
      }
    }
    vi.spyOn(process, 'getBuiltinModule').mockReturnValue({ ...real, DatabaseSync: Broken } as never);
    const other = mkdtempSync(join(tmpdir(), 'tl-'));
    try {
      stores.push(new MemoryStore(other, { log: (e) => got.push(e) }));
      stores.at(-1)!.apply(scope(), derived([item('note', 'x')]));
      expect(got[1]).toBe(boom);
    } finally {
      rmSync(other, { recursive: true, force: true });
    }
  });

  it('never creates a file on a read, a restore or an edit', () => {
    const s = open();
    expect(s.list(scope(), {})).toEqual({ items: [] });
    expect(s.counts(scope())).toMatchObject({ note: 0, pinned: 0, retracted: 0 });
    expect(s.repos(undefined)).toEqual([]);
    expect(s.fileStatus(undefined)).toMatchObject({ key: '_default', state: 'missing' });
    expect(s.search(scope(), { query: 'anything', eligible: true })).toEqual([]);
    expect(() => s.peek(scope(), 1)).toThrow('no such item m1');
    expect(() => s.restore(scope(), human, { id: 1 })).toThrow('no such item m1');
    expect(() => s.editPin(scope(), human, { id: 1, text: 'x' })).toThrow('no such item m1');
    expect(() => s.pin(scope(), human, { id: 1, unpin: true })).toThrow('no such item m1');
    expect(existsSync(join(home, 'memory'))).toBe(false);
  });
});

describe('the gardener (v3)', () => {
  const P = {
    A: 'parser crashes when socket timeout expires',
    B: 'parser crashes when socket timeout expires early',
    C: 'socket timeout crashes parser',
    Q: 'why does release signing hang forever',
    L: 'fixed release signing hang forever in the ci pipeline',
  };
  const query = <T>(fn: (db: DatabaseSync) => T): T => { const db = raw(); try { return fn(db); } finally { db.close(); } };
  const idOf = (text: string) => Number(query((db) => (db.prepare('SELECT id FROM items WHERE text = ?').get(text) as { id: number }).id));
  const rows = (sql: string) => query((db) => db.prepare(sql).all());
  /** Root-written, so eligible, items one second apart, so created_at orders them; their ids by name. */
  function seed<K extends string>(s: MemoryStore, items: Record<K, DerivedItem>): Record<K, number> {
    const ids = {} as Record<K, number>;
    for (const [name, it] of Object.entries(items) as [K, DerivedItem][]) {
      clock += 1000;
      s.apply(scope('n-r1'), derived([it]));
      ids[name] = idOf(it.text);
    }
    return ids;
  }
  /** Distinct one-term notes, so a run's hide cap (a quarter of its hideable candidates) has room. */
  const filler = (s: MemoryStore, n = 40) => s.apply(scope('n-r1'), derived(Array.from({ length: n }, (_, i) => item('note', `filler${i}zz`))));
  /**
   * In this order C, A, B: three pitfalls, C seen three times so it outranks A even after B merges into A (a chain).
   * Then question Q and the newer ledger line L answering it.
   */
  const fixture = (s: MemoryStore) => {
    const ids = seed(s, {
      C: item('pitfall', P.C), A: item('pitfall', P.A), B: item('pitfall', P.B), Q: item('open_question', P.Q), L: item('ledger', P.L, 'daemon'),
    });
    for (let i = 0; i < 2; i++) s.apply(scope('n-r1'), derived([item('pitfall', P.C)]));
    return ids;
  };
  const start = (s: MemoryStore, sc = scope()) => {
    const r = s.startRun(sc, { trigger: 'manual', model: 'claude-haiku-5-5' });
    if (!r.ok) throw new Error(r.reason);
    return r.run.id;
  };
  /** End a run as done and start the next. */
  const next = (s: MemoryStore, run: number) => {
    s.endRun(undefined, run, 'done');
    s.finishRun(undefined, run, { usd: 0.01, incomplete: false });
    return start(s);
  };
  const merge = (s: MemoryStore, run: number, ids: number[], reason = 'same fact') => s.gardenApply(undefined, run, { action: 'merge', ids, reason });
  const supersede = (s: MemoryStore, run: number, id: number, by: number) => s.gardenApply(undefined, run, { action: 'supersede', id, by, reason: 'answered' });
  const refused = (rule: string) => ({ ok: false, rule, message: expect.stringContaining(`refused (${rule}): `) });

  it('creates no file from its reads, a start, a skip or an undo', () => {
    const s = open();
    expect(s.gardenTargets()).toEqual([]);
    expect(s.runs(undefined)).toEqual([]);
    expect(s.cost30d(undefined)).toBe(0);
    expect(s.startRun(scope(), { trigger: 'manual', model: 'm' })).toEqual({ ok: false, reason: 'no memory for this repository yet' });
    s.skipRun(scope(), { trigger: 'schedule', note: 'untrusted' });
    expect(() => s.undo(scope(), { run: 1 }, 'human')).toThrow('no such run r1');
    expect(() => s.run(undefined, 1)).toThrow('no such run r1');
    expect(() => s.heartbeat(undefined, 1)).toThrow('no such run r1');
    expect(existsSync(join(home, 'memory'))).toBe(false);
  });

  it('offers a cluster that keeps an older question, pitfall or procedure the supersede by its newest member instead', () => {
    const s = open();
    filler(s);
    const ids = seed(s, {
      old: item('procedure', 'npx jest sessions/schema-guard.test.ts -t decodeSchema --runInBand'),
      short: item('procedure', 'npm ci'),
      note: item('note', 'release notes live in the wiki'),
      fresh: item('pitfall', 'webpack build fails because node modules cache holds stale lockfile'),
      by: item('procedure', 'npx vitest run sessions/schema-guard.test.ts -t decodeSchema'),
      shortBy: item('procedure', 'npm ci --silent'),
      noteBy: item('note', 'release notes live in the team wiki'),
      freshDup: item('pitfall', 'webpack build fails because the node modules cache holds a stale lockfile'),
    });
    // The stale command was seen more, so it is the keep; the newer pitfall was seen more, so it is.
    for (let i = 0; i < 2; i++) s.apply(scope('n-r1'), derived([item('procedure', 'npx jest sessions/schema-guard.test.ts -t decodeSchema --runInBand'), item('pitfall', 'webpack build fails because the node modules cache holds a stale lockfile')]));
    const page = s.gardenPage(undefined, start(s), { callsLeft: 19 });
    if (!('items' in page)) throw new Error('refused');
    const alt = (old: number, by: number) => `if these are not the same lesson (a command, path or flag changed), supersede m${old} by m${by} instead of merging`;
    const byKeep = Object.fromEntries(page.clusters.map((c) => [c.keep, c]));
    expect(byKeep[`m${ids.old}`]).toEqual({ kind: 'procedure', keep: `m${ids.old}`, ids: [`m${ids.old}`, `m${ids.by}`], alternative: alt(ids.old, ids.by) });
    expect(byKeep[`m${ids.short}`]).not.toHaveProperty('alternative'); // under three terms
    expect(byKeep[`m${ids.note}`]).not.toHaveProperty('alternative'); // a note is only merged
    expect(byKeep[`m${ids.freshDup}`]).not.toHaveProperty('alternative'); // the keep is the newer
    expect(Object.keys(byKeep).sort()).toEqual([ids.old, ids.short, ids.note, ids.freshDup].map((id) => `m${id}`).sort());
    expect(page.supersedeHints).toEqual([]); // the alternative is the cluster's, not a separate proposal
    // The alternative passes the store's own supersede checks.
    const run = page.run.slice(1);
    expect(s.gardenApply(undefined, Number(run), { action: 'supersede', id: ids.old, by: ids.by, reason: 'jest replaced by vitest' })).toMatchObject({ ok: true });
  });

  it('freezes the candidates, proposes the cluster and the hint, and lists them on page 1', () => {
    const s = open();
    const ids = fixture(s);
    const pin = s.pin(scope(), human, { text: 'never force push shared branches' }).id;
    s.apply(scope('n-bad'), derived([item('pitfall', 'parser crashes when socket timeout expires badly')], outcome('failed')));
    s.apply(scope('n-r1', 'n-r1', 'git:example.com/other'), derived([item('pitfall', 'parser crashes when socket timeout expires elsewhere')]));
    const run = start(s);
    const byId = (a: number, b: number) => a - b;
    expect(s.run(undefined, run).stats.candidates.sort(byId)).toEqual([ids.C, ids.A, ids.B, ids.Q, ids.L, pin].sort(byId));
    const page = s.gardenPage(undefined, run, { callsLeft: 19 });
    expect(page).toMatchObject({
      run: `r${run}`, page: 1, pages: 1, now: clock, rules: { hidesLeft: 1, supersedesLeft: 1, callsLeft: 19, minContained: 0.5 },
      clusters: [{ kind: 'pitfall', keep: `m${ids.C}`, ids: [`m${ids.C}`, `m${ids.A}`, `m${ids.B}`] }],
      supersedeHints: [{ id: `m${ids.Q}`, by: `m${ids.L}` }],
    });
    expect(page).not.toHaveProperty('next');
    if (!('items' in page)) throw new Error('refused');
    expect(Object.fromEntries(page.items.map((c) => [c.id, c.protected]))).toEqual({
      [`m${ids.C}`]: false, [`m${ids.A}`]: false, [`m${ids.B}`]: false, [`m${ids.Q}`]: false, [`m${ids.L}`]: true, [`m${pin}`]: true,
    });
    expect(page.items.find((c) => c.id === `m${ids.A}`)).toEqual({
      id: `m${ids.A}`, kind: 'pitfall', text: P.A, age: '0m', lastSeen: '0m', seen: 1, author: 'agent', protected: false,
    });
    expect(s.gardenGet(undefined, run, ids.L)).toMatchObject({ ok: true, item: { id: `m${ids.L}`, body: '' } });
    expect(row(ids.L).gets).toBe(0);
    expect(s.gardenGet(undefined, run, idOf('parser crashes when socket timeout expires badly'))).toEqual(refused('not a candidate'));
  });

  it('pages a large candidate set by cursor, and leaves what the run hid out of its pages and proposals', () => {
    const s = open();
    const ids = fixture(s);
    filler(s, 160);
    const run = start(s);
    const first = s.gardenPage(undefined, run, { callsLeft: 19 });
    const second = s.gardenPage(undefined, run, { cursor: 'c2', callsLeft: 18 });
    expect(first).toMatchObject({ page: 1, pages: 2, next: 'c2', rules: { hidesLeft: 40, supersedesLeft: 10 } });
    expect(second).toMatchObject({ page: 2, pages: 2, clusters: [], supersedeHints: [] });
    expect(second).not.toHaveProperty('next');
    const shown = (p: ReturnType<MemoryStore['gardenPage']>) => ('items' in p ? p.items.map((c) => c.id) : []);
    expect(shown(first)).toHaveLength(LIMITS.garden.page);
    expect(shown(first).length + shown(second).length).toBe(165);
    expect(merge(s, run, [ids.A, ids.B, ids.C])).toEqual({ ok: true, action: 'merge', kept: ids.C, hidden: [ids.A, ids.B], hidesLeft: 38, supersedesLeft: 10 });
    const after = s.gardenPage(undefined, run, { callsLeft: 17 });
    expect(after).toMatchObject({ clusters: [], supersedeHints: [{ id: `m${ids.Q}`, by: `m${ids.L}` }] });
    expect([...shown(after), ...shown(s.gardenPage(undefined, run, { cursor: 'c2', callsLeft: 16 }))]).toHaveLength(163);
  });

  it('merges into the keep the daemon ranks highest, never writing a pinned keep, with a redacted reason', () => {
    const s = open();
    const ids = fixture(s);
    filler(s);
    for (let i = 0; i < 3; i++) s.apply(scope('n-r1'), derived([item('pitfall', P.B)]));
    const bumped = clock;
    const run = start(s);
    // B was seen four times: it outranks the older C and A whatever order the gardener gives.
    expect(merge(s, run, [ids.C, ids.A, ids.B], 'dup of AKIAABCDEFGHIJKLMNOP\nline two')).toMatchObject({ ok: true, kept: ids.B, hidden: [ids.C, ids.A] });
    expect(row(ids.B)).toMatchObject({ seen: 8, updated_at: bumped, invalid_at: null });
    expect(row(ids.A)).toMatchObject({ invalid_kind: 'merged', merged_into: ids.B, invalid_by: `gardener:r${run}`, invalid_reason: 'dup of [redacted] line two' });
    expect(s.get(scope(), ids.A)).toMatchObject({ mergedInto: ids.B, invalid: { kind: 'merged', by: `gardener:r${run}` } });
    // A pinned keep comes first, and its row is never written.
    const notes = seed(s, { x: item('note', 'release notes live in the wiki'), y: item('note', 'release notes live in the team wiki') });
    s.pin(scope(), human, { id: notes.x });
    const run2 = next(s, run);
    expect(merge(s, run2, [notes.y, notes.x])).toMatchObject({ ok: true, kept: notes.x, hidden: [notes.y] });
    expect(row(notes.x).seen).toBe(1);
    expect(s.run(undefined, run2).actions).toEqual([expect.objectContaining({
      action: 'merge', itemId: notes.y, intoId: notes.x, seenDelta: 0, itemText: 'release notes live in the team wiki', intoText: 'release notes live in the wiki',
    })]);
  });

  it('refuses every broken rule by name and counts the refusals', () => {
    const s = open();
    const ids = fixture(s);
    filler(s);
    const more = seed(s, {
      long: item('pitfall', 'webpack build fails because node modules cache holds stale lockfile'),
      tiny: item('pitfall', 'flaky ports'),
      docker: item('pitfall', 'docker compose leaves orphan volumes'),
      short: item('pitfall', 'webpack build fails'),
      big: item('pitfall', 'flaky ports in parallel runs'),
      note: item('note', 'docker compose leaves orphan volumes behind'),
      cargo: item('note', 'cargo lockfile drifts after rebase'),
      pin: item('pitfall', 'socket timeout crashes parser on boot'),
    });
    s.apply(scope('n-ok'), derived([item('note', 'cargo lockfile drifts after every rebase')], outcome('succeeded')));
    const cargo2 = idOf('cargo lockfile drifts after every rebase');
    const pin = s.pin(scope(), human, { id: more.pin }).id;
    s.apply(scope('n-bad'), derived([item('pitfall', 'parser crashes when socket timeout expires badly')], outcome('failed')));
    s.apply(scope('n-r1', 'n-r1', 'git:example.com/other'), derived([item('pitfall', 'parser crashes on another repo')]));
    const run = start(s);
    s.apply(scope('n-ok'), derived([], outcome('failed'))); // n-ok's note was a candidate and is no longer eligible
    s.forget(scope(), human, { id: ids.Q, reason: 'moot' });
    expect(merge(s, run, [ids.A, idOf('parser crashes when socket timeout expires badly')])).toEqual(refused('not a candidate'));
    expect(merge(s, run, [ids.A, idOf('parser crashes on another repo')])).toEqual(refused('not a candidate'));
    expect(merge(s, run, [ids.A, ids.A])).toEqual(refused('duplicate'));
    expect(supersede(s, run, ids.A, ids.A)).toEqual(refused('duplicate'));
    expect(merge(s, run, [more.cargo, cargo2])).toEqual(refused('ineligible'));
    expect(supersede(s, run, ids.Q, ids.L)).toEqual(refused('not live'));
    expect(merge(s, run, [ids.A, more.note])).toEqual(refused('kind'));
    expect(merge(s, run, [ids.A, more.docker])).toEqual(refused('containment'));
    expect(supersede(s, run, pin, ids.L)).toEqual(refused('protected'));
    expect(merge(s, run, [ids.C, pin])).toMatchObject({ ok: true, kept: pin }); // a pin may be the keep
    expect(supersede(s, run, more.long, more.short)).toEqual(refused('containment')); // the short subset
    expect(supersede(s, run, more.tiny, more.big)).toEqual(refused('terms'));
    expect(supersede(s, run, more.short, more.long)).toEqual(refused('newer'));
    expect(supersede(s, run, more.docker, more.note)).toEqual(refused('kind'));
    s.apply(scope('n-r1'), derived([item('note', 'docker compose leaves orphan volumes behind')])); // seen twice: it may supersede across kinds
    expect(supersede(s, run, more.docker, more.note)).toMatchObject({ ok: true, hidden: more.docker, by: more.note });
    expect(s.run(undefined, run).stats.refused).toEqual({
      'not a candidate': 2, duplicate: 2, ineligible: 1, 'not live': 1, kind: 2, containment: 2, protected: 1, terms: 1, newer: 1,
    });
    s.endRun(undefined, run, 'done');
    expect(merge(s, run, [ids.A, ids.B])).toEqual(refused('not running'));
    expect(s.gardenPage(undefined, run, { callsLeft: 1 })).toEqual(refused('not running'));
  });

  it('caps hides at a quarter of the hideable candidates, and supersedes at ten', () => {
    const s = open();
    const ids = fixture(s);
    const small = start(s); // C, A, B and Q are hideable: one hide
    expect(merge(s, small, [ids.A, ids.B, ids.C])).toEqual(refused('hides'));
    expect(merge(s, small, [ids.A, ids.C])).toMatchObject({ ok: true, hidesLeft: 0, supersedesLeft: 0 });
    expect(supersede(s, small, ids.Q, ids.L)).toEqual(refused('hides'));
    filler(s);
    const pairs = Array.from({ length: 11 }, (_, i) => seed(s, {
      q: item('open_question', `gadget${i} sprocket${i} flange${i} widget${i}`), l: item('ledger', `fixed gadget${i} sprocket${i} flange${i} widget${i}`, 'daemon'),
    }));
    const run = next(s, small);
    for (const p of pairs.slice(0, 10)) expect(supersede(s, run, p.q, p.l)).toMatchObject({ ok: true });
    expect(supersede(s, run, pairs[10].q, pairs[10].l)).toEqual(refused('supersedes'));
    expect(row(pairs[0].q)).toMatchObject({ invalid_kind: 'gardener', merged_into: null, invalid_by: `gardener:r${run}` });
  });

  it('redirects re-derivation along a merge chain to its live end, and revives the row when the end is gone', () => {
    const s = open();
    const ids = fixture(s);
    filler(s);
    const run = start(s);
    merge(s, run, [ids.A, ids.B]); // B into A
    merge(s, run, [ids.A, ids.C]); // A into C: B → A → C
    expect([row(ids.A).seen, row(ids.C).seen]).toEqual([2, 5]);
    s.apply(scope('n-r1'), derived([item('pitfall', P.B)]));
    expect(row(ids.C).seen).toBe(6);
    expect(row(ids.B)).toMatchObject({ invalid_kind: 'merged', merged_into: ids.A });
    expect(s.add(scope('n-r1'), agent('n-r1'), { kind: 'pitfall', text: P.B })).toEqual({ id: ids.C, existing: true, merged: true });
    s.forget(scope(), agent(), { id: ids.C, reason: 'stale' });
    s.apply(scope('n-r1'), derived([item('pitfall', P.B)]));
    expect(row(ids.B)).toMatchObject({ invalid_kind: null, merged_into: null, seen: 2 });
  });

  it('follows at most eight hops, and treats merged_into without the merged kind as unset', () => {
    const s = open();
    s.apply(scope('n-r1'), derived(Array.from({ length: 10 }, (_, i) => item('note', `hop note ${i}`))));
    const chain = (n: number) => query((db) => {
      for (let id = 1; id <= n; id++) {
        db.prepare(`UPDATE items SET invalid_at = 1, invalid_kind = 'merged', invalid_by = 'gardener:r1', merged_into = ? WHERE id = ?`).run(id + 1, id);
      }
    });
    chain(8); // 1 → … → 9: eight hops
    s.apply(scope('n-r1'), derived([item('note', 'hop note 0')]));
    expect([row(1).invalid_kind, row(9).seen]).toEqual(['merged', 2]);
    chain(9); // 1 → … → 10: nine hops, past the depth
    s.apply(scope('n-r1'), derived([item('note', 'hop note 0')]));
    expect(row(1)).toMatchObject({ invalid_kind: null, merged_into: null, seen: 2 });
    // A v1 daemon's revive clears invalid_* but not merged_into: readers treat the row as unmerged.
    query((db) => db.prepare(`UPDATE items SET invalid_at = NULL, invalid_kind = NULL, invalid_by = NULL, merged_into = 10 WHERE id = 2`).run());
    expect(s.get(scope(), 2)).not.toHaveProperty('mergedInto');
    s.apply(scope('n-r1'), derived([item('note', 'hop note 1')]));
    expect([row(2).seen, row(10).seen]).toEqual([2, 1]);
  });

  it('refuses a merge that would make a redirect chain longer than eight hops', () => {
    const s = open();
    const ids = seed(s, {
      K: item('pitfall', 'flaky widget gadget sprocket test'),
      D: item('pitfall', 'flaky widget gadget sprocket test again'),
      E: item('pitfall', 'flaky widget gadget sprocket test twice'),
    });
    filler(s);
    const hops = Array.from({ length: 15 }, (_, i) => idOf(`filler${i}zz`));
    query((db) => {
      const into = db.prepare(`UPDATE items SET invalid_at = 1, invalid_kind = 'merged', invalid_by = 'gardener:r1', merged_into = ? WHERE id = ?`);
      hops.slice(0, 8).forEach((id, i) => into.run(i < 7 ? hops[i + 1] : ids.D, id)); // eight hops down to D
      hops.slice(8).forEach((id, i) => into.run(i < 6 ? hops[i + 9] : ids.E, id)); // seven down to E
    });
    const run = start(s);
    expect(merge(s, run, [ids.K, ids.D])).toEqual(refused('chain'));
    expect(merge(s, run, [ids.K, ids.E])).toMatchObject({ ok: true, kept: ids.K, hidden: [ids.E] });
    expect(s.run(undefined, run).stats.refused).toEqual({ chain: 1 });
    expect(row(ids.D).invalid_at).toBeNull();
  });

  it('undoes a run newest first back to the rows it found, the second time doing nothing', () => {
    const s = open();
    const ids = fixture(s);
    filler(s);
    const before = rows('SELECT * FROM items ORDER BY id');
    const run = start(s);
    merge(s, run, [ids.A, ids.B]);
    merge(s, run, [ids.A, ids.C]);
    supersede(s, run, ids.Q, ids.L);
    expect(s.undo(scope(), { run }, 'human')).toMatchObject({ undone: [{ itemId: ids.Q }, { itemId: ids.A, intoId: ids.C }, { itemId: ids.B, intoId: ids.A }], skipped: [] });
    expect(rows('SELECT * FROM items ORDER BY id')).toEqual(before);
    expect(s.undo(scope(), { run }, 'human')).toEqual({ undone: [], skipped: [] });
    expect(s.run(undefined, run).actions!.map((a) => [a.undoneBy, a.immune])).toEqual([['human', false], ['human', false], ['human', false]]);
    expect(() => s.undo(scope('n-w1', 'n-r1', 'git:example.com/other'), { run }, 'human')).toThrow(`no such run r${run}`);
  });

  it('skips actions whose item was revived, retracted by someone else or purged since', () => {
    const s = open();
    const ids = fixture(s);
    const notes = seed(s, { x: item('note', 'release notes live in the wiki'), y: item('note', 'release notes live in the team wiki') });
    filler(s);
    const run = start(s);
    merge(s, run, [ids.A, ids.B]);
    supersede(s, run, ids.Q, ids.L);
    merge(s, run, [notes.x, notes.y]);
    s.forget(scope(), agent(), { id: ids.A, reason: 'stale' });
    s.apply(scope('n-r1'), derived([item('pitfall', P.B)])); // its end is gone: B revives
    s.forget(scope(), human, { id: ids.Q, reason: 'moot' });
    s.forget(scope(), human, { id: notes.y, reason: 'leak', purge: true });
    expect(s.undo(scope(), { run }, 'human')).toEqual({
      undone: [],
      skipped: [
        { actionId: 3, itemId: notes.y, reason: 'purged' }, { actionId: 2, itemId: ids.Q, reason: 'retracted since by human' },
        { actionId: 1, itemId: ids.B, reason: 'live again' },
      ],
    });
  });

  it('gives a pinned keep back nothing it never got, after an unpin', () => {
    const s = open();
    const ids = fixture(s);
    filler(s);
    s.pin(scope(), human, { id: ids.A });
    const run = start(s);
    expect(merge(s, run, [ids.B, ids.A])).toMatchObject({ ok: true, kept: ids.A });
    s.pin(scope(), human, { id: ids.A, unpin: true });
    s.apply(scope('n-r1'), derived([item('pitfall', P.A)]));
    s.undo(scope(), { run }, 'human');
    expect([row(ids.A).seen, row(ids.B).invalid_at]).toEqual([2, null]);
  });

  it('makes a pair immune after undo m<id>, or undo r<id> with immune, never after the daemon undo; a pin clears it', () => {
    const s = open();
    const ids = fixture(s);
    filler(s);
    let run = start(s);
    merge(s, run, [ids.A, ids.B]);
    expect(s.undo(scope(), { item: ids.B }, 'human')).toMatchObject({ undone: [{ itemId: ids.B, intoId: ids.A }] });
    run = next(s, run);
    expect(merge(s, run, [ids.A, ids.B])).toEqual(refused('immune'));
    expect(s.gardenPage(undefined, run, { callsLeft: 9 })).toMatchObject({ clusters: [{ ids: [`m${ids.C}`, `m${ids.A}`, `m${ids.B}`] }] });
    expect(merge(s, run, [ids.B, ids.C])).toMatchObject({ ok: true, kept: ids.C }); // B may still go into another keep
    s.undo(scope(), { run }, 'human');
    run = next(s, run);
    expect(merge(s, run, [ids.B, ids.C])).toMatchObject({ ok: true });
    s.undo(scope(), { run, immune: true }, 'daemon');
    expect(s.run(undefined, run).actions![0]).toMatchObject({ undoneBy: 'daemon', immune: false });
    run = next(s, run);
    expect(merge(s, run, [ids.B, ids.C])).toMatchObject({ ok: true });
    s.undo(scope(), { run, immune: true }, 'human');
    run = next(s, run);
    expect(merge(s, run, [ids.B, ids.C])).toEqual(refused('immune'));
    s.pin(scope(), human, { id: ids.C });
    s.pin(scope(), human, { id: ids.C, unpin: true });
    expect(merge(s, run, [ids.B, ids.C])).toMatchObject({ ok: true });
    expect(() => s.undo(scope(), { item: ids.Q }, 'human')).toThrow(`m${ids.Q} was never hidden by the gardener`);
  });

  it("hands the panel's restore, and pin by id, of a gardener-hidden item to the undo", () => {
    const s = open();
    const ids = fixture(s);
    filler(s);
    const run = start(s);
    merge(s, run, [ids.A, ids.B]);
    supersede(s, run, ids.Q, ids.L);
    expect(s.restore(scope(), human, { id: ids.B })).toMatchObject({ id: ids.B, seen: 1 });
    expect(row(ids.A).seen).toBe(1);
    expect(s.pin(scope(), human, { id: ids.Q })).toMatchObject({ pinned: true });
    expect(s.run(undefined, run).actions!.map((a) => [a.itemId, a.undoneBy, a.immune])).toEqual([[ids.B, 'human', true], [ids.Q, 'human', false]]);
    expect(rows(`SELECT json_extract(data, '$.itemId') AS id FROM episodes WHERE kind = 'restore'`)).toEqual([{ id: ids.B }]);
  });

  it('purges the items merged into a purged keep, down the chain, and blanks their reasons', () => {
    const s = open();
    const ids = fixture(s);
    filler(s);
    const run = start(s);
    merge(s, run, [ids.A, ids.B], 'mentions plughword');
    merge(s, run, [ids.A, ids.C], 'mentions plughword');
    s.forget(scope(), human, { id: ids.C, reason: 'secret', purge: true });
    for (const id of [ids.A, ids.B, ids.C]) expect(row(id)).toMatchObject({ text: '', invalid_kind: 'human', merged_into: null });
    expect(rows('SELECT DISTINCT reason FROM garden_actions')).toEqual([{ reason: '' }]);
  });

  it('holds one lease per file while its heartbeat is fresh', () => {
    const s = open();
    fixture(s);
    s.apply(scope('n-r1', 'n-r1', 'git:example.com/other'), derived([item('note', 'elsewhere')]));
    const run = start(s);
    const other = scope('n-w1', 'n-r1', 'git:example.com/other');
    clock += LIMITS.garden.leaseMs - 1000;
    s.heartbeat(undefined, run);
    const beat = clock;
    clock += LIMITS.garden.leaseMs - 1000;
    expect(s.startRun(other, { trigger: 'schedule', model: 'm' })).toEqual({ ok: false, reason: `garden run r${run} holds this memory file's lease` });
    clock += 2000;
    expect(s.startRun(other, { trigger: 'schedule', model: 'm' })).toMatchObject({ ok: true, run: { id: run + 1, repoKey: 'git:example.com/other', state: 'running' } });
    s.setRunNode(undefined, run, 'n-gardener');
    s.countCalls(undefined, run, { calls: 7, outputChars: 12_345 });
    expect(s.run(undefined, run)).toMatchObject({ nodeId: 'n-gardener', heartbeatAt: beat, stats: { calls: 7, outputChars: 12_345 } });
  });

  it('finishes a stale run once as interrupted with its cost, and ends and reverts runs only by the rules', () => {
    const s = open();
    fixture(s);
    const run = start(s);
    clock += LIMITS.garden.leaseMs * 2;
    const done = s.finishRun(undefined, run, { usd: 0.25, incomplete: true });
    expect(done).toMatchObject({ state: 'interrupted', costUsd: 0.25, costIncomplete: true, endedAt: clock, stats: { after: { live: { pitfall: 3 } } } });
    expect(s.finishRun(undefined, run, { usd: 9, incomplete: false })).toEqual(done);
    expect(s.verifyRun(undefined, run)).toEqual([]);
    expect(s.endRun(undefined, run, 'failed')).toBe(false);
    expect(s.endRun(undefined, run, 'reverted', 'post-run check failed')).toBe(true);
    expect(s.endRun(undefined, run, 'reverted')).toBe(false);
    expect(s.run(undefined, run)).toMatchObject({ state: 'reverted', note: 'post-run check failed', costUsd: 0.25 });
    const live = start(s);
    expect(s.endRun(undefined, live, 'capped', 'cap')).toBe(true);
    expect(s.endRun(undefined, live, 'timeout')).toBe(false);
    expect(s.finishRun(undefined, live, { usd: 0.1, incomplete: false })).toMatchObject({ state: 'capped', costUsd: 0.1 });
    expect(s.cost30d(undefined)).toBeCloseTo(0.35);
    clock += 31 * DAY;
    expect(s.cost30d(undefined)).toBe(0);
  });

  it('records a skip once per repeated note, and leaves skips out of the recent runs', () => {
    const s = open();
    fixture(s);
    s.skipRun(scope(), { trigger: 'schedule', note: 'run claude once in /repo to trust it' });
    s.skipRun(scope(), { trigger: 'schedule', note: 'run claude once in /repo to trust it' });
    s.skipRun(scope(), { trigger: 'schedule', note: '/repo is missing' });
    expect(s.runs(undefined).map((r) => [r.state, r.note])).toEqual([['skipped', '/repo is missing'], ['skipped', 'run claude once in /repo to trust it']]);
    expect(s.gardenTargets()[0].recent).toEqual([]);
  });

  it('lists each repository with its new items and proposals above the last run’s watermark', () => {
    const s = open();
    const ids = fixture(s);
    s.pin(scope(), human, { text: 'pinned rules are not new items' });
    s.apply(scope('n-r1', 'n-r1', 'git:example.com/other'), derived([item('note', 'elsewhere')]));
    expect(s.gardenTargets()).toEqual([
      { key: '_default', repoKey: 'git:example.com/a/b', repoPath: '/repo', newItems: 4, proposals: 2, recent: [] },
      { key: '_default', repoKey: 'git:example.com/other', repoPath: '/repo', newItems: 1, proposals: 0, recent: [] },
    ]);
    const run = start(s);
    s.endRun(undefined, run, 'done');
    s.finishRun(undefined, run, { usd: 0.02, incomplete: false });
    s.apply(scope('n-r1'), derived([item('pitfall', 'parser crashes when socket timeout expires again')]));
    expect(s.gardenTargets()[0]).toMatchObject({ newItems: 1, proposals: 1, recent: [{ id: run, state: 'done', watermark: ids.L + 2 }] });
  });

  describe('verifyRun', () => {
    it('passes an in-run chain and a human forget of its keep after the merge', () => {
      const s = open();
      const ids = fixture(s);
      filler(s);
      const run = start(s);
      merge(s, run, [ids.A, ids.B]);
      merge(s, run, [ids.A, ids.C]);
      supersede(s, run, ids.Q, ids.L);
      clock += 1000;
      s.forget(scope(), human, { id: ids.C, reason: 'wrong' });
      s.endRun(undefined, run, 'done');
      s.finishRun(undefined, run, { usd: 0.03, incomplete: false });
      expect(s.verifyRun(undefined, run)).toEqual([]);
      expect(s.run(undefined, run).stats).not.toHaveProperty('violations');
    });

    it('fails a merge whose chain ends on an item the run superseded, which the daemon undo then reverts', () => {
      const s = open();
      const ids = fixture(s);
      const newer = seed(s, { D: item('pitfall', 'parser crashes when socket timeout expires under load') });
      filler(s);
      const run = start(s);
      expect(merge(s, run, [ids.B, ids.C])).toMatchObject({ ok: true, kept: ids.C });
      expect(supersede(s, run, ids.C, newer.D)).toMatchObject({ ok: true });
      s.endRun(undefined, run, 'done');
      s.finishRun(undefined, run, { usd: 0.03, incomplete: false });
      const found = s.verifyRun(undefined, run);
      expect(found).toEqual([`m${ids.B} merges into m${ids.C}, which r${run} also hid`]);
      expect(s.run(undefined, run).stats.violations).toEqual(found);
      expect(s.undo(scope(), { run }, 'daemon').undone).toHaveLength(2);
      expect(s.endRun(undefined, run, 'reverted', found.join('; '))).toBe(true);
      expect([row(ids.B).invalid_at, row(ids.C).invalid_at, row(ids.C).seen]).toEqual([null, null, 3]);
    });

    it('passes a merge whose member stopped being eligible after the run hid it', () => {
      const s = open();
      const ids = fixture(s);
      filler(s);
      s.apply(scope('n-ok'), derived([item('pitfall', `${P.A} again`)], outcome('succeeded')));
      const late = idOf(`${P.A} again`);
      const run = start(s);
      expect(merge(s, run, [ids.A, late])).toMatchObject({ ok: true, kept: ids.A, hidden: [late] });
      s.apply(scope('n-ok'), derived([], outcome('failed')));
      s.endRun(undefined, run, 'done');
      s.finishRun(undefined, run, { usd: 0.01, incomplete: false });
      expect(s.verifyRun(undefined, run)).toEqual([]);
    });

    it('fails a row hidden with no action, and a pin the run kept that left the digest, but not a pin it never touched', () => {
      const s = open();
      const ids = fixture(s);
      filler(s);
      const other = s.pin(scope(), human, { text: 'never force push shared branches' }).id;
      const pin = s.pin(scope(), human, { id: ids.C }).id;
      const run = start(s);
      expect(merge(s, run, [ids.B, pin])).toMatchObject({ ok: true, kept: pin });
      query((db) => db.prepare(`UPDATE items SET invalid_at = 1, invalid_kind = 'gardener', invalid_by = ? WHERE id = ?`).run(`gardener:r${run}`, ids.A));
      s.endRun(undefined, run, 'done');
      const stats = s.finishRun(undefined, run, { usd: 0, incomplete: false }).stats;
      expect(stats.before.digest.ids).toEqual(expect.arrayContaining([pin, other]));
      const after = { ...stats, after: { ...stats.after!, digest: { ids: [], chars: 0 } } };
      query((db) => db.prepare('UPDATE garden_runs SET stats = ? WHERE id = ?').run(JSON.stringify(after), run));
      expect(s.verifyRun(undefined, run)).toEqual([`m${ids.A} is hidden by r${run} with no action`, `pin m${pin} left the orchestrator digest`]);
    });
  });
});
