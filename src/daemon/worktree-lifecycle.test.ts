import { afterEach, describe, expect, it, vi } from 'vitest';
import type { NodeManager } from './manager.js';
import * as wt from './worktree.js';
import { refreshGit } from './worktree-lifecycle.js';

vi.mock('./worktree.js', () => ({ aheadBehind: vi.fn(async () => { throw new Error('no such branch'); }), branchSha: vi.fn(async () => undefined), branchTips: vi.fn(async () => new Map()), diffStat: vi.fn() }));

/** Each diffStat call waits until the test resolves it with the dirty files it should see. */
const pending: ((files: string[]) => void)[] = [];
vi.mocked(wt.diffStat).mockImplementation(() => new Promise((r) => pending.push((files) => r({ additions: 0, deletions: 0, dirty: files.length }))));
const settle = () => new Promise((r) => setTimeout(r, 0));

function fakeManager(ids = ['x']) {
  const worktree = { repo: process.cwd(), path: process.cwd(), branch: 'tl/x', base: 'dev', baseSha: '' };
  const m = {
    stopped: false,
    registry: { get: () => ({ id: 'x', worktree }) },
    runtimes: new Map<string, { git?: { dirty: number }; gitTimer?: unknown }>(ids.map((id) => [id, {}])),
    emitNode: vi.fn(),
  };
  return { m, nm: m as unknown as NodeManager };
}

describe('refreshGit coalescing', () => {
  afterEach(() => { pending.length = 0; vi.mocked(wt.diffStat).mockClear(); });

  it('runs git once for a burst of calls, then once more for those made during the run, seeing the later tree', async () => {
    const { m, nm } = fakeManager();
    const first = refreshGit(nm, 'x');
    const second = refreshGit(nm, 'x'), third = refreshGit(nm, 'x');
    expect(second).toBe(third);
    await settle();
    expect(wt.diffStat).toHaveBeenCalledTimes(1);
    pending.shift()!(['a']);
    await first;
    expect(m.runtimes.get('x')!.git!.dirty).toBe(1);
    await settle();
    expect(wt.diffStat).toHaveBeenCalledTimes(2);
    pending.shift()!(['a', 'b']); // the change made while the first run was in flight
    await second;
    expect(m.runtimes.get('x')!.git!.dirty).toBe(2);
    expect(m.emitNode).toHaveBeenCalledTimes(2);
    await settle();
    expect(wt.diffStat).toHaveBeenCalledTimes(2);
    // Idle again: the next call starts its own run, which emits nothing when the state is unchanged.
    const fourth = refreshGit(nm, 'x');
    await settle();
    pending.shift()!(['a', 'b']);
    await fourth;
    expect(wt.diffStat).toHaveBeenCalledTimes(3);
    expect(m.emitNode).toHaveBeenCalledTimes(2);
  });

  it('skips the queued rerun once the node is closed', async () => {
    const { m, nm } = fakeManager();
    const first = refreshGit(nm, 'x'), second = refreshGit(nm, 'x');
    await settle();
    m.runtimes.delete('x');
    pending.shift()!(['a']);
    await Promise.all([first, second]);
    await settle();
    expect(wt.diffStat).toHaveBeenCalledTimes(1);
    expect(pending).toHaveLength(0);
    expect(m.emitNode).not.toHaveBeenCalled();
  });
});

describe('refreshGit limits', () => {
  afterEach(() => { pending.length = 0; vi.mocked(wt.diffStat).mockClear(); });

  it('runs at most four refreshes at once across nodes, starting the next as each finishes', async () => {
    const ids = ['a', 'b', 'c', 'd', 'e', 'f'];
    const { nm } = fakeManager(ids);
    const runs = ids.map((id) => refreshGit(nm, id));
    await settle();
    expect(wt.diffStat).toHaveBeenCalledTimes(4);
    pending.shift()!([]);
    await settle();
    expect(wt.diffStat).toHaveBeenCalledTimes(5);
    while (pending.length) { pending.shift()!([]); await settle(); }
    await Promise.all(runs);
    expect(wt.diffStat).toHaveBeenCalledTimes(6);
  });

  it('keeps the last state when counting commits fails while the branch exists', async () => {
    const { m, nm } = fakeManager();
    const rt = m.runtimes.get('x')!;
    rt.git = { dirty: 7 };
    vi.mocked(wt.branchSha).mockResolvedValueOnce('abc');
    const run = refreshGit(nm, 'x').catch((err: Error) => err.message);
    await settle();
    pending.shift()!([]);
    expect(await run).toBe('no such branch');
    expect(rt.git).toEqual({ dirty: 7 });
    expect(m.emitNode).not.toHaveBeenCalled();
  });

  it('replaces a debounced refresh still waiting, so a turn end does not run git twice', async () => {
    const { m, nm } = fakeManager();
    const rt = m.runtimes.get('x')!;
    const timer = vi.fn();
    rt.gitTimer = setTimeout(timer, 0);
    const run = refreshGit(nm, 'x');
    expect(rt.gitTimer).toBeUndefined();
    await settle();
    pending.shift()!([]);
    await run;
    expect(timer).not.toHaveBeenCalled();
  });
});
