// Claude Code's auto-memory as the Memory panel reads it: where it is for a checkout, what is read and what is refused.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { claudeProjectSlug, readClaudeMemory } from './claude-memory.js';
import { NodeManager } from './manager.js';
import { claudeMemory } from './memory-panel.js';
import { transcriptFor } from './transcript.js';

const KiB = 1024;
const g = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();

let dir: string, claudeHome: string, repo: string;
beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'tl-claude-memory-')));
  claudeHome = join(dir, 'claude');
  repo = join(dir, 'repo');
  mkdirSync(repo);
});
afterEach(() => { vi.unstubAllEnvs(); rmSync(dir, { recursive: true, force: true }); });

/** The memory directory Claude keeps for repo, filled with name -> text. */
function memoryDir(files: Record<string, string> = {}, home = claudeHome, checkout = repo): string {
  const d = join(home, 'projects', claudeProjectSlug(checkout), 'memory');
  mkdirSync(d, { recursive: true });
  for (const [name, text] of Object.entries(files)) writeFileSync(join(d, name), text);
  return d;
}

describe('claudeProjectSlug', () => {
  it('is the transcript directory name: the real path with every other character a dash', () => {
    expect(claudeProjectSlug('/no/such/dir.x_y')).toBe('-no-such-dir-x-y');
    const link = join(dir, 'link');
    symlinkSync(repo, link);
    expect(claudeProjectSlug(link)).toBe(claudeProjectSlug(repo));
    expect(transcriptFor(link, 's-1', claudeHome)).toBe(join(claudeHome, 'projects', claudeProjectSlug(repo), 's-1.jsonl'));
  });
});

describe('readClaudeMemory', () => {
  it('reads the .md files, MEMORY.md first then by name, skipping symlinks, subdirectories and other files', async () => {
    const d = memoryDir({ 'b.md': 'bee', 'MEMORY.md': '# Index', 'a.md': 'ay', 'notes.txt': 'not markdown' });
    writeFileSync(join(dir, 'outside.md'), 'secret');
    symlinkSync(join(dir, 'outside.md'), join(d, 'link.md'));
    mkdirSync(join(d, 'sub.md'));
    mkdirSync(join(d, 'sub'));
    writeFileSync(join(d, 'sub', 'nested.md'), 'nested');
    const view = await readClaudeMemory(claudeHome, repo);
    expect(view.dir).toBe(d);
    expect(view.files.map((f) => [f.name, f.text, f.bytes])).toEqual([['MEMORY.md', '# Index', 7], ['a.md', 'ay', 2], ['b.md', 'bee', 3]]);
    expect(view.omitted).toEqual([]);
    expect(view.note).toBeUndefined();
  });

  it('refuses a symlinked memory directory and has no files when there is none', async () => {
    expect(await readClaudeMemory(claudeHome, repo)).toEqual({ dir: join(claudeHome, 'projects', claudeProjectSlug(repo), 'memory'), files: [], omitted: [] });
    const elsewhere = join(dir, 'elsewhere');
    mkdirSync(elsewhere);
    writeFileSync(join(elsewhere, 'MEMORY.md'), 'redirected');
    const d = join(claudeHome, 'projects', claudeProjectSlug(repo), 'memory');
    mkdirSync(join(d, '..'), { recursive: true });
    symlinkSync(elsewhere, d);
    expect(await readClaudeMemory(claudeHome, repo)).toEqual({ dir: d, files: [], omitted: [], note: `${d} is reached through a symlink; not read` });
    // A linked projects/<slug> is refused the same way; a linked Claude home is followed.
    rmSync(join(claudeHome, 'projects'), { recursive: true });
    mkdirSync(join(claudeHome, 'projects'));
    mkdirSync(join(elsewhere, 'memory'));
    symlinkSync(elsewhere, join(claudeHome, 'projects', claudeProjectSlug(repo)));
    expect((await readClaudeMemory(claudeHome, repo)).note).toBe(`${d} is reached through a symlink; not read`);
    const linkedHome = join(dir, 'linked-claude');
    symlinkSync(claudeHome, linkedHome);
    rmSync(join(claudeHome, 'projects', claudeProjectSlug(repo)));
    memoryDir({ 'MEMORY.md': 'through a linked home' });
    expect((await readClaudeMemory(linkedHome, repo)).files.map((f) => f.text)).toEqual(['through a linked home']);
  });

  it('skips a FIFO without waiting for a writer', async () => {
    const d = memoryDir({ 'a.md': 'ay' });
    execFileSync('mkfifo', [join(d, 'pipe.md')]);
    expect((await readClaudeMemory(claudeHome, repo)).files.map((f) => f.name)).toEqual(['a.md']);
  });

  it('caps the count, each file and the total, naming the rest in omitted', async () => {
    const many = Object.fromEntries(Array.from({ length: 101 }, (_, i) => [`f${String(i).padStart(3, '0')}.md`, 'x']));
    memoryDir(many);
    const counted = await readClaudeMemory(claudeHome, repo);
    expect(counted.files).toHaveLength(100);
    expect(counted.omitted).toEqual(['f100.md']);

    rmSync(claudeHome, { recursive: true });
    memoryDir({ 'big.md': 'é'.repeat(35 * KiB) }); // 70 KiB of two-byte characters
    const [big] = (await readClaudeMemory(claudeHome, repo)).files;
    expect(big).toMatchObject({ name: 'big.md', bytes: 70 * KiB, truncated: true });
    expect(Buffer.byteLength(big!.text)).toBe(64 * KiB);

    rmSync(claudeHome, { recursive: true });
    memoryDir(Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`t${String(i).padStart(2, '0')}.md`, 'y'.repeat(60 * KiB)])));
    const total = await readClaudeMemory(claudeHome, repo);
    expect(total.files).toHaveLength(17); // 17 x 60 KiB fit in 1 MiB, an 18th does not
    expect(total.omitted).toEqual(['t17.md', 't18.md', 't19.md']);
  });
});

describe('the panel\'s Claude memory', () => {
  let m: NodeManager;
  beforeEach(() => {
    vi.stubEnv('HOME', join(dir, 'user'));
    m = new NodeManager({ home: join(dir, 'tl'), shell: '/bin/sh' });
  });
  afterEach(async () => { await m.shutdown(); });

  it('maps a worktree and a git worktree add checkout to the main checkout\'s directory in ~/.claude', async () => {
    g(repo, 'init', '-q', '-b', 'main');
    for (const [k, v] of [['user.email', 't@example.com'], ['user.name', 'T'], ['commit.gpgsign', 'false']]) g(repo, 'config', k!, v!);
    writeFileSync(join(repo, 'README'), 'x');
    g(repo, 'add', 'README');
    g(repo, 'commit', '-qm', 'init');
    const tiller = join(repo, '.claude', 'worktrees', 'n-1'), added = join(dir, 'added');
    g(repo, 'worktree', 'add', '-q', '-b', 'tl/n-1', tiller);
    g(repo, 'worktree', 'add', '-q', '-b', 'other', added);
    memoryDir({ 'MEMORY.md': '- [x](x.md)' }, join(dir, 'user', '.claude'));
    for (const d of [repo, tiller, added]) {
      const view = await claudeMemory(m, { dir: d });
      expect(view.dir).toBe(join(dir, 'user', '.claude', 'projects', claudeProjectSlug(repo), 'memory'));
      expect(view.files.map((f) => f.name)).toEqual(['MEMORY.md']);
      expect(view.account).toBeUndefined();
    }
    expect(existsSync(join(dir, 'tl', 'memory'))).toBe(false);
  });

  it('reads a named account from its config dir and refuses an account that is not configured, never ~/.claude', async () => {
    writeFileSync(join(dir, 'tl', 'config.json'), JSON.stringify({ claude: { accounts: [{ name: 'work', configDir: join(dir, 'work-claude') }] } }));
    memoryDir({ 'MEMORY.md': 'work memory' }, join(dir, 'work-claude'));
    memoryDir({ 'MEMORY.md': 'default memory' }, join(dir, 'user', '.claude'));
    expect(await claudeMemory(m, { dir: repo, account: 'work' })).toMatchObject({ account: 'work', files: [{ text: 'work memory' }] });
    expect(await claudeMemory(m, { dir: repo, account: null })).toMatchObject({ files: [{ text: 'default memory' }] });
    await expect(claudeMemory(m, { dir: repo, account: 'ghost' })).rejects.toThrow(/Claude account "ghost" is not configured/);
    await expect(claudeMemory(m, {})).rejects.toThrow("no checkout of this repository is known; choose the repository's directory");
    expect(existsSync(join(dir, 'tl', 'memory'))).toBe(false);
  });
});
