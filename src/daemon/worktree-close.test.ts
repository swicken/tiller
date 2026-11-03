import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { NodeManager } from './manager.js';
import * as wt from './worktree.js';
import { worktrees } from './worktree-lifecycle.js';

let home = '', repo = '', m: NodeManager;
const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { encoding: 'utf8' }).trim();

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'tl-wtclose-'));
  repo = join(home, 'repo');
  mkdirSync(repo);
  git(repo, 'init', '-q', '-b', 'main');
  for (const f of ['a.txt', 'b.txt', 'c.txt']) writeFileSync(join(repo, f), f);
  git(repo, 'add', '.');
  git(repo, 'commit', '-q', '-m', 'root');
  m = new NodeManager({ home, shell: '/bin/sh' });
});
afterEach(async () => {
  await m.shutdown();
  rmSync(home, { recursive: true, force: true });
});

let seq = 0;
/** A terminal node (isolation is for agent nodes) standing in a worktree made by hand and recorded as the node's. */
async function node() {
  const name = `w${++seq}`, path = join(repo, '.claude', 'worktrees', name), branch = `tl/${name}`;
  git(repo, 'worktree', 'add', '-q', '-b', branch, path);
  const v = await m.spawn({ kind: 'terminal', title: name, cwd: path, byHuman: true });
  const w = { repo, path, branch, base: 'main', baseSha: git(repo, 'rev-parse', 'HEAD') };
  m.registry.update(v.id, { worktree: w });
  return { id: v.id, w };
}
const leftovers = () => readdirSync(join(repo, '.claude', 'worktrees')).filter((n) => n.startsWith('.removing-'));

describe('closing a worktree node', () => {
  it('removes the tree at once and deletes the merged branch', async () => {
    const { id, w } = await node();
    await m.close(id, true);
    expect(existsSync(w.path)).toBe(false);
    expect(git(repo, 'branch', '--list', w.branch)).toBe('');
    expect(git(repo, 'worktree', 'list', '--porcelain')).not.toContain(w.path);
    await expect.poll(leftovers).toEqual([]); // the moved folder is deleted in the background
  });

  it('finishes a removal that was interrupted partway, as the recorded mode decided', async () => {
    const { id, w } = await node();
    // git got half way: tracked files gone, and the record says deletion started (plain: the branch was merged).
    rmSync(join(w.path, 'a.txt'));
    rmSync(join(w.path, 'b.txt'));
    expect(await m.worktreeCheck(id)).toMatchObject({ dirty: expect.any(Array) }); // would refuse a plain close
    m.registry.update(id, { worktree: { ...w, removing: 'plain' } });
    expect(await m.worktreeCheck(id)).toEqual({ dirty: [], unmerged: [], sharing: [] });
    await m.close(id, true);
    expect(existsSync(w.path)).toBe(false);
    expect(git(repo, 'branch', '--list', w.branch)).toBe('');
    expect(m.view(id)).toBeUndefined();
  });

  it('keeps the branch of an interrupted keep, and deletes it for an interrupted discard', async () => {
    const kept = await node();
    writeFileSync(join(kept.w.path, 'wip.txt'), 'wip');
    git(kept.w.path, 'add', '-A');
    git(kept.w.path, 'commit', '-q', '-m', 'WIP'); // the WIP commit keep makes before deleting
    rmSync(join(kept.w.path, 'a.txt'));
    m.registry.update(kept.id, { worktree: { ...kept.w, removing: 'keep' } });
    expect(await m.close(kept.id, true)).toBe(`kept branch ${kept.w.branch}`);
    expect(git(repo, 'branch', '--list', kept.w.branch)).toContain(kept.w.branch);
    expect(existsSync(kept.w.path)).toBe(false);

    const dropped = await node();
    rmSync(join(dropped.w.path, 'c.txt'));
    m.registry.update(dropped.id, { worktree: { ...dropped.w, removing: 'discard' } });
    await m.close(dropped.id, true);
    expect(git(repo, 'branch', '--list', dropped.w.branch)).toBe('');
  });

  it('finishes when the worktree lost its .git file, without looking at the main checkout', async () => {
    const { id, w } = await node();
    writeFileSync(join(repo, 'a.txt'), 'changed in the main checkout');
    rmSync(join(w.path, '.git'));
    await expect(wt.dirtyFiles(w.path)).rejects.toThrow(/not a git work tree/); // not the main checkout's a.txt
    expect(await wt.diffStat(w)).toMatchObject({ dirty: 0 });
    await expect(m.close(id, true)).rejects.toThrow(); // unknown state: a plain close refuses, nothing was deleted
    expect(existsSync(w.path)).toBe(true);
    m.registry.update(id, { worktree: { ...w, removing: 'plain' } });
    await m.close(id, true);
    expect(existsSync(w.path)).toBe(false);
    expect(readFileOf(join(repo, 'a.txt'))).toBe('changed in the main checkout'); // the main checkout is untouched
  });

  it('shows a failed removal as exited and errored, and the next close finishes it', async () => {
    const { id, w } = await node();
    git(repo, 'worktree', 'lock', w.path, '--reason', 'held by someone else'); // not Claude's lock: removal refuses
    await expect(m.close(id, true)).rejects.toThrow(/locked/);
    expect(m.view(id)!.status).toMatchObject({ state: 'done', errored: true, exited: true });
    git(repo, 'worktree', 'unlock', w.path);
    await m.close(id, true);
    expect(m.view(id)).toBeUndefined();
  });

  it('treats a missing folder as removed', async () => {
    const { id, w } = await node();
    m.registry.update(id, { worktree: { ...w, removing: 'discard' } });
    rmSync(w.path, { recursive: true });
    await m.close(id, true);
    expect(git(repo, 'branch', '--list', w.branch)).toBe('');
  });

  it('deletes folders a crash left behind at startup, and finishes the removals it interrupted', async () => {
    const { id, w } = await node();
    const stray = join(repo, '.claude', 'worktrees', '.removing-old-1');
    mkdirSync(stray);
    writeFileSync(join(stray, 'f'), 'x');
    m.registry.update(id, { worktree: { ...w, removing: 'discard' } });
    await worktrees(m, { clean: 'startup' });
    expect(existsSync(stray)).toBe(false);
    expect(m.view(id)).toBeUndefined();
    expect(existsSync(w.path)).toBe(false);
  });
});

const readFileOf = (p: string) => execFileSync('cat', [p], { encoding: 'utf8' });
