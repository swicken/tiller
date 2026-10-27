import { mkdtempSync, rmSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { MEMORY_INVALID_KINDS, MEMORY_ITEM_KINDS } from '../shared/protocol.js';
import {
  EPISODE_KINDS, INVALID_KINDS, ITEM_KINDS, LIMITS, MEMORY_TOOL_SHAPES, MIGRATIONS, REDACTED, SCHEMA_V1, SCHEMA_VERSION, accountKey, contained, firstErrorLine, ftsTerms,
  gateExit, itemRef, keepRank, normalizeDedupe, normalizeRemote, parseItemRef, parseRunRef, pinDedupe, redact, runRef, structuralCode, type CaptureEvent,
} from './memory-schema.js';

const dirs: string[] = [];
const schemaDb = () => {
  const dir = mkdtempSync(join(tmpdir(), 'tl-mem-'));
  dirs.push(dir);
  const db = new DatabaseSync(join(dir, 'x.db'));
  db.exec(SCHEMA_V1);
  return db;
};
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

describe('SCHEMA_V1', () => {
  it('creates an incremental-vacuum WAL database at version 1 with the sentinel repo', () => {
    const db = schemaDb();
    expect(db.prepare('PRAGMA auto_vacuum').get()).toEqual({ auto_vacuum: 2 });
    expect(db.prepare('PRAGMA journal_mode').get()).toEqual({ journal_mode: 'wal' });
    expect(db.prepare('PRAGMA user_version').get()).toEqual({ user_version: 1 });
    expect(db.prepare('SELECT id, key FROM repos').all()).toEqual([{ id: 1, key: 'account:' }]);
    db.close();
  });

  it('enforces json_valid but not kinds, and keeps FTS in step with items', () => {
    const db = schemaDb();
    const episode = db.prepare("INSERT INTO episodes (ts, repo_id, root_id, node_id, kind, data) VALUES (1, 1, 'r', 'n', ?, ?)");
    expect(() => episode.run('outcome', '{not json')).toThrow();
    episode.run('a-future-kind', '{}');
    db.prepare("INSERT INTO items (repo_id, kind, text, author, dedupe, created_at, updated_at) VALUES (1, 'pitfall', 'flaky worktrees', 'daemon', 'x', 1, 1)").run();
    expect(db.prepare("SELECT rowid FROM items_fts WHERE items_fts MATCH 'worktree'").all()).toEqual([{ rowid: 1 }]); // porter stemming
    db.prepare("UPDATE items SET text = '' WHERE id = 1").run();
    expect(db.prepare("SELECT rowid FROM items_fts WHERE items_fts MATCH 'worktree'").all()).toEqual([]);
    db.close();
  });
});

describe('MIGRATIONS', () => {
  it('takes a v1 file to schema 2 in one transaction, keeping its items, with merged_into enforced', () => {
    const db = schemaDb();
    db.prepare("INSERT INTO items (repo_id, kind, text, author, dedupe, created_at, updated_at) VALUES (1, 'note', 'kept', 'agent', 'kept', 1, 1)").run();
    db.exec('PRAGMA foreign_keys = ON');
    expect(MIGRATIONS.map((m) => m.version)).toEqual([2]);
    expect(SCHEMA_VERSION).toBe(2);
    db.exec('BEGIN IMMEDIATE');
    db.exec(MIGRATIONS[0]!.sql);
    db.exec('COMMIT');
    expect([db.prepare('PRAGMA user_version').get(), db.prepare('PRAGMA auto_vacuum').get()]).toEqual([{ user_version: 2 }, { auto_vacuum: 2 }]);
    expect(db.prepare('SELECT text, merged_into FROM items').all()).toEqual([{ text: 'kept', merged_into: null }]);
    expect(() => db.prepare('UPDATE items SET merged_into = 99 WHERE id = 1').run()).toThrow(/FOREIGN KEY/);
    db.prepare("INSERT INTO garden_runs (repo_id, trigger, state, started_at, heartbeat_at, watermark) VALUES (1, 'manual', 'running', 1, 1, 1)").run();
    expect(() => db.prepare("UPDATE garden_runs SET stats = '{x' WHERE id = 1").run()).toThrow();
    db.close();
  });
});

describe('redact', () => {
  const secrets: [string, string][] = [
    ['PEM key', '-----BEGIN RSA PRIVATE KEY-----\nMIIEow\nabc\n-----END RSA PRIVATE KEY-----'],
    ['cut-off PEM key', '-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXk'],
    ['AWS key', 'AKIAIOSFODNN7EXAMPLE'],
    ['AWS session key', 'ASIAIOSFODNN7EXAMPLE'],
    ['GitHub token', `ghp_${'a1B2'.repeat(9)}`],
    ['GitHub server token', `ghs_${'x'.repeat(36)}`],
    ['GitHub fine-grained token', `github_pat_${'A1_'.repeat(20)}`],
    ['Anthropic key', `sk-ant-api03-${'k9'.repeat(20)}`],
    ['OpenAI key', `sk-${'Z'.repeat(40)}`],
    ['OpenAI project key', `sk-proj-${'q_'.repeat(20)}`],
    ['Slack token', 'xoxb-1234567890-abcdefghij'],
    ['Google key', `AIza${'S'.repeat(35)}`],
    ['JWT', 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2lnbmF0dXJl'],
  ];
  it.each(secrets)('removes a %s', (_, secret) => {
    const out = redact(`before ${secret} after`);
    expect(out).not.toContain(secret.slice(4, 24));
    expect(out).toContain(REDACTED);
    expect(out.startsWith('before ')).toBe(true);
  });

  it('removes credentials but keeps their labels', () => {
    expect(redact('curl -H "Authorization: Bearer abc.def-123"')).toBe(`curl -H "Authorization: Bearer ${REDACTED}"`);
    expect(redact('Basic dXNlcjpwYXNz')).toBe(`Basic ${REDACTED}`);
    expect(redact('a Basic understanding')).toBe('a Basic understanding');
    expect(redact('git clone https://bob:hunter2@example.com/r.git')).toBe(`git clone https://bob:${REDACTED}@example.com/r.git`);
    expect(redact('password=hunter2 next')).toBe(`password=${REDACTED} next`);
    expect(redact('{"api_key": "abc def", "x": 1}')).toBe(`{"api_key": ${REDACTED}, "x": 1}`);
    expect(redact('GITHUB_TOKEN=abc123 SECRET: s3cr3t ApiKey=v')).toBe(`GITHUB_TOKEN=${REDACTED} SECRET: ${REDACTED} ApiKey=${REDACTED}`);
  });

  it('leaves ordinary text alone', () => {
    const text = 'npm test passed; see src/daemon/x.ts(12,3): error TS2345 and m12. tokens: 400';
    expect(redact(text)).toBe(text);
  });

  it('is idempotent and deep over a capture event, keeping non-strings', () => {
    const event: CaptureEvent = {
      type: 'close', ts: 5,
      archived: {
        id: 'n-1', rootId: 'n-0', parentId: 'n-0', title: `use ghp_${'b'.repeat(36)}`, cwd: '/r', createdAt: 1, closedAt: 5, spentUsd: 0.5,
        outcome: { outcome: 'succeeded', summary: 'token: abc and Bearer abcdefgh1234', openQuestions: [`key ${secrets[7][1]}`], at: 4 },
      },
    };
    const once = redact(event);
    expect(JSON.stringify(once)).not.toMatch(/ghp_b|abcdefgh1234|sk-ant|token: abc/);
    expect(once).toMatchObject({ type: 'close', ts: 5, archived: { createdAt: 1, spentUsd: 0.5, outcome: { at: 4 } } });
    expect(redact(once)).toEqual(once);
    for (const [, secret] of secrets) {
      const s = redact(`x=${secret} https://u:p@h/ Bearer abc.12345678 token="q" ${secret}`);
      expect(redact(s)).toBe(s);
    }
  });
});

describe('normalizeRemote', () => {
  it.each(['git@github.com:A/B.git', 'https://user@github.com/a/b/', 'ssh://git@github.com/a/b.git', 'https://u:p@GitHub.com/a/b.git/'])('%s', (url) => {
    expect(normalizeRemote(url)).toBe('github.com/a/b');
  });
  it('keeps a local-path remote as its path', () => {
    expect(normalizeRemote('/Users/Me/Repo.git/')).toBe('/Users/Me/Repo.git');
    expect(normalizeRemote('file:///srv/Git/r')).toBe('/srv/Git/r');
  });
  it('keeps a port after the host of a URL', () => {
    expect(normalizeRemote('ssh://git@host:2222/a/b.git')).toBe('host:2222/a/b');
  });
});

describe('gate tail helpers', () => {
  const tsc = [
    '> tiller@0.0.0 typecheck', '> tsc --noEmit', '',
    'src/daemon/x.ts(12,3): error TS2345: Argument of type \'string\' is not assignable to parameter of type \'number\'.',
    'src/daemon/y.ts(1,1): error TS2307: Cannot find module \'z\'.',
    'npm run typecheck: exited with 2',
  ].join('\n');
  const vitest = [
    '\x1b[31m FAIL \x1b[39m src/daemon/a.test.ts > a > works', 'AssertionError: expected 1 to be 2', '',
    ' Test Files  1 failed | 3 passed (4)', 'npm test: exited with 1', '',
  ].join('\n');

  it('firstErrorLine finds the first error line and never the exit line', () => {
    expect(firstErrorLine(tsc)).toMatch(/^src\/daemon\/x\.ts\(12,3\): error TS2345/);
    expect(firstErrorLine(vitest)).toBe('FAIL  src/daemon/a.test.ts > a > works');
    expect(firstErrorLine('compiling\nsomething odd\nnpm run fail-fast: exited with 1')).toBe('something odd');
    expect(firstErrorLine('npm test: exited with 1')).toBeUndefined();
    expect(firstErrorLine('npm test: stopped by SIGTERM (time limit 10 minutes)')).toBeUndefined();
  });

  // Real `node --test` output (Node 24) for one failing and one passing test, paths shortened.
  const nodeSpec = [
    '✖ adds numbers (0.57725ms)', '✔ passes (0.072042ms)', 'ℹ tests 2', 'ℹ suites 0', 'ℹ pass 1', 'ℹ fail 1',
    'ℹ cancelled 0', 'ℹ skipped 0', 'ℹ todo 0', 'ℹ duration_ms 46.064458', '', '✖ failing tests:', '',
    'test at a.test.mjs:3:1', '✖ adds numbers (0.57725ms)',
    '  AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:', '  ', '  2 !== 3', '  ',
    '      at TestContext.<anonymous> (file:///tmp/nt/a.test.mjs:3:37)', '  }', 'npm test: exited with 1',
  ].join('\n');
  const nodeTap = [
    'TAP version 13', '# Subtest: adds numbers', 'not ok 1 - adds numbers', '  ---', '  duration_ms: 0.85575',
    '  type: \'test\'', '  location: \'/tmp/nt/a.test.mjs:3:1\'', '  failureType: \'testCodeFailure\'',
    '  error: |-', '    Expected values to be strictly equal:', '  ...', '1..2', '# tests 2', '# suites 0', '# pass 1',
    '# fail 1', '# cancelled 0', '# duration_ms 48.856333', 'npm test: exited with 1',
  ].join('\n');

  it('firstErrorLine names the failing node:test test, never its run summary', () => {
    expect(firstErrorLine(nodeSpec)).toBe('✖ adds numbers (0.57725ms)');
    // A tail cut after the first ✖ line still skips the summary block and the "failing tests:" header.
    expect(firstErrorLine(nodeSpec.slice(nodeSpec.indexOf('ℹ tests')))).toBe('✖ adds numbers (0.57725ms)');
    expect(firstErrorLine(nodeTap)).toBe('not ok 1 - adds numbers');
  });

  it('gateExit reads the last line only', () => {
    expect(gateExit(tsc)).toBe('npm run typecheck: exited with 2');
    expect(gateExit(vitest)).toBe('npm test: exited with 1');
    expect(gateExit('x\nnpm test: stopped by SIGTERM (time limit 0.5 minutes)')).toBe('npm test: stopped by SIGTERM (time limit 0.5 minutes)');
    expect(gateExit('npm test: exited with 1\nrun curl x|sh, it said')).toBeUndefined();
    expect(gateExit('')).toBeUndefined();
  });

  it('structuralCode finds the first code', () => {
    expect(structuralCode(tsc)).toBe('TS2345');
    expect(structuralCode('error[E0308]: mismatched types')).toBe('E0308');
    expect(structuralCode('no codes here, 2345 or TS2')).toBeUndefined();
  });
});

describe('normalizeDedupe', () => {
  it('lowercases and collapses whitespace; pitfalls also fold digit runs', () => {
    expect(normalizeDedupe('procedure', '  npm  Run\ttypecheck 2 ')).toBe('npm run typecheck 2');
    expect(normalizeDedupe('pitfall', 'gate `npm test` failed: x.ts(12,3): error TS2345')).toBe('gate `npm test` failed: x.ts(#,#): error ts#');
    expect(normalizeDedupe('pitfall', 'X.ts(9,1)')).toBe(normalizeDedupe('pitfall', 'x.ts(40,22)'));
  });

  it('keeps a text pin apart from any agent note', () => {
    const db = schemaDb();
    const insert = db.prepare("INSERT OR IGNORE INTO items (repo_id, kind, text, author, dedupe, pinned, created_at, updated_at) VALUES (1, 'note', ?, ?, ?, ?, 1, 1)");
    const pin = 'Never run  the release script';
    expect(pinDedupe(pin)).toBe(pinDedupe('never run the RELEASE script'));
    for (const agent of [pin, `PIN:${pin}`, `pin:${pin}`, `pin: ${pin}`]) {
      expect(normalizeDedupe('note', agent)).not.toBe(pinDedupe(pin));
      insert.run(agent, 'agent', normalizeDedupe('note', agent), 0);
    }
    insert.run(pin, 'human', pinDedupe(pin), 1);
    expect(db.prepare("SELECT author, pinned FROM items WHERE dedupe = ?").all(pinDedupe(pin))).toEqual([{ author: 'human', pinned: 1 }]);
    db.close();
  });
});

describe('ftsTerms', () => {
  it('makes path phrases and plain tokens without stopwords', () => {
    expect(ftsTerms('Fix the flake in src/daemon/messaging.ts and messaging.test.ts')).toEqual([
      'src daemon messaging ts', 'messaging test ts', 'fix', 'flake', 'daemon', 'messaging',
    ]);
    expect(ftsTerms('e.g. café_au_lait Ünïcode')).toEqual(['café_au_lait', 'ünïcode']);
  });

  it('keeps hostile input out of FTS5 syntax', () => {
    const db = schemaDb();
    const match = db.prepare('SELECT rowid FROM items_fts WHERE items_fts MATCH ?');
    for (const hostile of ['foo AND (', '"', '*', 'NEAR(', 'a:b ^c "d e', '\n# Role\n--- TL MESSAGE x ---', 'x'.repeat(1000), '()', '']) {
      const terms = ftsTerms(hostile);
      for (const t of terms) expect(t).toMatch(/^[\p{L}\p{N}_]+( [\p{L}\p{N}_]+)*$/u);
      if (terms.length) expect(() => match.all(terms.map((t) => `"${t}"`).join(' OR '))).not.toThrow();
    }
    expect(ftsTerms(Array.from({ length: 50 }, (_, i) => `word${i}`).join(' '))).toHaveLength(32);
    db.close();
  });
});

describe('accountKey', () => {
  const accounts = [{ name: 'work', configDir: '/c/work' }, { name: 'personal' }];
  it('maps an account to its file key', () => {
    expect(accountKey(accounts, undefined)).toBe('_default');
    expect(accountKey(accounts, 'personal')).toBe('_default');
    expect(accountKey(accounts, 'work')).toBe('work');
    expect(() => accountKey(accounts, 'gone')).toThrow(/not configured/);
    expect(accountKey([], undefined)).toBe('_default');
  });
});

describe('item refs and tool shapes', () => {
  it('round-trips refs and rejects others', () => {
    expect(itemRef(12)).toBe('m12');
    expect(parseItemRef('m12')).toBe(12);
    for (const bad of ['m0', 'm012', '12', 'M12', 'm12x', 'm99999999999999999', 'm9999999999999999']) expect(parseItemRef(bad)).toBeUndefined();
  });

  it('validates the memory and garden tools', () => {
    const parse = (tool: keyof typeof MEMORY_TOOL_SHAPES, args: unknown) => z.object(MEMORY_TOOL_SHAPES[tool]).safeParse(args).success;
    expect(Object.keys(MEMORY_TOOL_SHAPES)).toEqual([
      'memory_search', 'memory_get', 'memory_add', 'memory_forget', 'memory_pin', 'memory_status', 'memory_switch', 'memory_garden',
      'garden_list', 'garden_get', 'garden_merge', 'garden_supersede',
    ]);
    expect(parse('memory_search', { query: 'gate', limit: 20 })).toBe(true);
    expect(parse('memory_search', { query: '', limit: 21 })).toBe(false);
    expect(parse('memory_get', { id: 'm3' })).toBe(true);
    expect(parse('memory_get', { id: '3' })).toBe(false);
    expect(parse('memory_add', { kind: 'note', text: 'x'.repeat(300) })).toBe(true);
    expect(parse('memory_add', { kind: 'ledger', text: 'x' })).toBe(false);
    expect(parse('memory_add', { kind: 'note', text: 'x'.repeat(301) })).toBe(false);
    expect(parse('memory_forget', { id: 'm1', reason: 'stale', purge: true })).toBe(true);
    expect(parse('memory_pin', { text: 'x'.repeat(500) })).toBe(true);
    expect(parse('memory_status', { days: 366 })).toBe(false);
    expect(parse('memory_status', { repo: '/r/sub' })).toBe(true);
    expect(parse('memory_status', { repo: '' })).toBe(false);
    expect(parse('memory_switch', { on: null, project: '/p' })).toBe(true);
    expect(parse('memory_switch', {})).toBe(false);
    expect(parse('memory_garden', { action: 'undo', run: 'r3', immune: true })).toBe(true);
    expect(parse('memory_garden', { action: 'show', run: 'm3' })).toBe(false);
    expect(parse('garden_list', { cursor: 'c2' })).toBe(true);
    expect(parse('garden_list', { cursor: '2' })).toBe(false);
    expect(parse('garden_merge', { ids: ['m1', 'm2'], reason: 'same lesson' })).toBe(true);
    expect(parse('garden_merge', { ids: ['m1'], reason: 'x' })).toBe(false);
    expect(parse('garden_merge', { ids: Array.from({ length: 9 }, (_, i) => `m${i + 1}`), reason: 'x' })).toBe(false);
    expect(parse('garden_supersede', { id: 'm1', by: 'm2', reason: 'x'.repeat(200) })).toBe(true);
    expect(parse('garden_supersede', { id: 'm1', by: 'm2', reason: 'x'.repeat(201) })).toBe(false);
    // The gardener's scope is its record's: a repo or account argument is not part of its shapes.
    for (const t of ['garden_list', 'garden_get', 'garden_merge', 'garden_supersede'] as const) expect(Object.keys(MEMORY_TOOL_SHAPES[t])).not.toContain('repo');
  });

  it('round-trips run refs', () => {
    expect(runRef(12)).toBe('r12');
    expect(parseRunRef('r12')).toBe(12);
    for (const bad of ['r0', 'm12', '12', 'r12x']) expect(parseRunRef(bad)).toBeUndefined();
  });
});

describe('contained', () => {
  it('measures how much of the hidden item its target covers, never the reverse', () => {
    const question = 'why does the worktree setup hook fail on fresh clones';
    const ledger = 'W2 fixed: the worktree setup hook failed on fresh clones because npm ci ran before the copy';
    expect(contained(question, ledger)).toBeGreaterThanOrEqual(LIMITS.garden.minContained);
    // The short-subset path: a two-term note is fully inside a long item, but covers little of it.
    expect(contained('npm test', 'run npm test with the gate config before merging a worker branch')).toBe(1);
    expect(contained('run npm test with the gate config before merging a worker branch', 'npm test')).toBeLessThan(LIMITS.garden.minContained);
    expect(contained('the and of', 'anything')).toBe(0);
    expect(contained('', 'anything')).toBe(0);
  });

  it('counts every term, past the digest cap', () => {
    const words = Array.from({ length: 40 }, (_, i) => `word${i}`);
    expect(contained(words.join(' '), words.slice(20).join(' '))).toBe(0.5);
  });
});

describe('keepRank', () => {
  const member = (id: number, x: Partial<{ author: 'human' | 'daemon' | 'agent'; seen: number; pinned: 0 | 1; created_at: number }> = {}) =>
    ({ id, author: 'agent' as const, seen: 1, pinned: 0 as const, created_at: 100, ...x });
  const keep = (...items: ReturnType<typeof member>[]) => [...items].sort(keepRank)[0]!.id;

  it('keeps the most trusted copy whatever order the gardener gave', () => {
    expect(keep(member(1, { seen: 9 }), member(2, { author: 'daemon' }), member(3, { author: 'human' }))).toBe(3);
    expect(keep(member(1, { seen: 9 }), member(2, { author: 'daemon' }))).toBe(2);
    expect(keep(member(1, { seen: 2 }), member(2, { seen: 5 }))).toBe(2);
    expect(keep(member(2, { created_at: 50 }), member(1, { created_at: 60 }))).toBe(2);
    expect(keep(member(2), member(1))).toBe(1);
  });

  it('keeps a pin over any unpinned copy, so a pin is never a hidden member', () => {
    expect(keep(member(1, { author: 'human', seen: 9 }), member(2, { pinned: 1 }))).toBe(2);
  });
});

describe('the v2 contract', () => {
  it('aliases the item and invalid kinds to the protocol lists, so v3 appends to one', () => {
    expect(ITEM_KINDS).toBe(MEMORY_ITEM_KINDS);
    expect(INVALID_KINDS).toBe(MEMORY_INVALID_KINDS);
    expect(INVALID_KINDS).toEqual(['agent', 'human', 'superseded', 'evicted', 'gardener', 'merged']);
  });

  it('records restore episodes', () => {
    expect(EPISODE_KINDS).toContain('restore');
  });

  it('caps the panel and the Claude memory read', () => {
    expect(LIMITS.panel).toEqual({ page: 50, given: 20, givenTo: 20 });
    expect(LIMITS.claudeMemory).toEqual({ files: 100, fileBytes: 64 * 1024, totalBytes: 1024 * 1024 });
  });
});
