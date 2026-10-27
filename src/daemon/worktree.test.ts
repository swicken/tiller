// Worktree nodes against a throwaway git repo under the test's home, with a fake claude on PATH. Never this repo.
import { execFileSync } from 'node:child_process';
import { chmodSync, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { history } from './archive.js';
import { NodeManager, type SpawnRequest } from './manager.js';
import { mountMcp } from './mcp.js';
import { transcriptFor } from './transcript.js';
import * as wt from './worktree.js';
import { refreshGit } from './worktree-lifecycle.js';

const g = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim();
const commit = (dir: string, file: string) => { writeFileSync(join(dir, file), `${file}\n`); g(dir, 'add', file); g(dir, 'commit', '-qm', `add ${file}`); };


let home = '', repo = '', m: NodeManager;
let template: string | undefined;

function setup(): void {
  home = realpathSync(mkdtempSync(join(tmpdir(), 'tl-wt-')));
  vi.stubEnv('HOME', home); // trustPolicy reads ~/.claude.json; git then reads no global config
  repo = join(home, 'repo');
  if (!template) {
    template = mkdtempSync(join(tmpdir(), 'tl-wt-template-'));
    g(template, 'init', '-q', '-b', 'dev');
    // No detached `git maintenance run --auto` after commit: its objects/maintenance.lock can vanish mid-cpSync (ENOENT).
    for (const [k, v] of [['user.email', 't@example.com'], ['user.name', 'T'], ['commit.gpgsign', 'false'], ['maintenance.auto', 'false']]) g(template, 'config', k!, v!);
    commit(template, 'README');
  }
  // Copy before creating any linked worktrees: each test owns its .git and all absolute worktree metadata.
  cpSync(template, repo, { recursive: true });
  writeFileSync(join(home, '.claude.json'), JSON.stringify({ projects: { [repo]: { hasTrustDialogAccepted: true } } }));
  const bin = join(home, 'bin');
  mkdirSync(bin);
  // Fake claude: writes its cwd and argv next to the node's settings.json, then idles.
  writeFileSync(join(bin, 'claude'), '#!/bin/sh\nfor a in "$@"; do case "$prev" in --settings) out="$(dirname "$a")/argv";; esac; prev="$a"; done\n{ pwd; echo "$@"; } > "$out"\nexec sleep 30\n');
  chmodSync(join(bin, 'claude'), 0o755);
  m = new NodeManager({ home: join(home, 'tl'), shell: '/bin/sh', path: `${bin}:/usr/bin:/bin` });
}

const spawnW = (extra: Partial<SpawnRequest> = {}) => m.spawn({ kind: 'claude', title: 'w', cwd: repo, isolation: 'worktree', ...extra });
/** A root and, armed behind its next turn, a worktree child; the root's turn then releases the child. */
async function releasedChild(extra: Partial<SpawnRequest> = {}): Promise<string> {
  const root = (await m.spawn({ kind: 'claude', title: 'root', cwd: repo, byHuman: true })).id;
  const id = (await spawnW({ parentId: root, after: [root], ...extra })).id;
  m.applyHook(root, { hook_event_name: 'UserPromptSubmit' });
  m.applyHook(root, { hook_event_name: 'Stop' });
  await null; // the scheduler's microtask, queued by the hooks, releases the child before this resumes
  return id;
}
const exited = async (id: string) => { m.session(id)!.kill(); await expect.poll(() => m.view(id)!.status.exited).toBe(true); };

afterEach(async () => {
  await m?.shutdown();
  vi.unstubAllEnvs();
  rmSync(home, { recursive: true, force: true });
});
afterAll(() => { if (template) rmSync(template, { recursive: true, force: true }); });

describe('worktree nodes', () => {
  it('spawn creates the worktree, branch, marker and exclude line, and launches claude from the main checkout with --worktree', async () => {
    setup();
    const sha = g(repo, 'rev-parse', 'HEAD');
    const v = await spawnW();
    const path = join(repo, '.claude', 'worktrees', v.id);
    expect(v.cwd).toBe(path);
    expect(v.worktree).toEqual({ repo, path, branch: `tl/${v.id}`, base: 'dev', baseSha: sha });
    expect(g(path, 'branch', '--show-current')).toBe(`tl/${v.id}`);
    expect(JSON.parse(readFileSync(join(repo, '.git', 'worktrees', v.id, 'tl-node'), 'utf8'))).toEqual({ home: m.home, nodeId: v.id, base: 'dev', baseSha: sha });
    await spawnW(); // a second worktree does not add the line again
    expect(readFileSync(join(repo, '.git', 'info', 'exclude'), 'utf8').split('\n').filter((l) => l === '/.claude/worktrees/')).toHaveLength(1);
    expect(g(repo, 'status', '--porcelain')).toBe('');
    expect(JSON.parse(readFileSync(join(m.home, 'nodes', v.id, 'settings.json'), 'utf8')).worktree).toEqual({ baseRef: 'head' });
    const argv = join(m.home, 'nodes', v.id, 'argv');
    await expect.poll(() => (existsSync(argv) ? readFileSync(argv, 'utf8') : '')).toContain(`--worktree ${v.id}`);
    expect(readFileSync(argv, 'utf8').split('\n')[0]).toBe(repo);
  });

  it('refuses a terminal, a cwd outside git, a repo with no commits and an untrusted repo, leaving nothing behind', async () => {
    setup();
    await expect(m.spawn({ kind: 'terminal', title: 't', cwd: repo, isolation: 'worktree' })).rejects.toThrow(/agent nodes only/);
    await expect(spawnW({ cwd: join(home, 'bin') })).rejects.toThrow(/not inside a git work tree/);
    const empty = join(home, 'empty');
    mkdirSync(empty);
    g(empty, 'init', '-q');
    await expect(spawnW({ cwd: empty })).rejects.toThrow(/no commits/);
    // A trusted ancestor is not enough: claude --worktree checks the repo's own entry.
    writeFileSync(join(home, '.claude.json'), JSON.stringify({ projects: { [home]: { hasTrustDialogAccepted: true }, [repo]: { hasTrustDialogAccepted: false } } }));
    await expect(spawnW()).rejects.toThrow(`run claude once in ${repo} to trust it`);
    expect(m.list()).toEqual([]);
    expect(g(repo, 'branch', '--list', 'tl/*')).toBe('');
  });

  it('close refuses a dirty or unmerged tree and one shared with a live node; keep commits WIP, removes the directory and keeps the branch', async () => {
    setup();
    const v = await spawnW();
    const path = v.cwd, branch = `tl/${v.id}`;
    commit(path, 'a.txt');
    writeFileSync(join(path, 'b.txt'), 'b\n');
    await expect(m.close(v.id, true)).rejects.toThrow(/^worktree kept: 1 dirty file, 1 unmerged commit; close with keep or discard$/);
    expect(m.session(v.id)).toBeDefined(); // a refused close leaves the node running
    const sharer = (await m.spawn({ kind: 'terminal', title: 's', cwd: path, parentId: v.id }));
    await expect(m.close(v.id, true, 'discard')).rejects.toThrow(`worktree in use by ${sharer.id}; close those nodes first`);
    await expect(m.close(v.id, true)).rejects.toThrow(`worktree kept: 1 dirty file, 1 unmerged commit; close with keep or discard; in use by ${sharer.id}`);
    await m.close(sharer.id);

    expect(await m.close(v.id, true, 'keep')).toBe(`kept branch ${branch}`);
    expect(existsSync(path)).toBe(false);
    expect(m.view(v.id)).toBeUndefined();
    expect(g(repo, 'log', '-1', '--format=%s', branch)).toBe(`WIP: tiller node "w" (${v.id})`);
    expect(g(repo, 'show', '--format=', '--name-only', branch)).toBe('b.txt');
    expect(g(repo, 'status', '--porcelain')).toBe(''); // the main checkout is untouched

    const report = await m.worktrees({ cwd: repo });
    expect(report.kept).toEqual([{ repo, branch, unmerged: [expect.stringContaining('add a.txt'), expect.stringContaining('WIP')] }]);
    expect((await m.worktrees({ cwd: repo, clean: 'safe' })).kept).toHaveLength(1); // unmerged: safe leaves it
    const forced = await m.worktrees({ cwd: repo, clean: 'force' });
    expect(forced.removed).toEqual([{ what: `branch ${branch} in ${repo}`, commits: report.kept[0]!.unmerged, files: [] }]);
    expect(g(repo, 'branch', '--list', branch)).toBe('');
  });

  it('judges kept branches against the main checkout: in it, patch-equivalent to it, or unmerged', async () => {
    setup();
    const [merged, picked, open] = ['tl/n-aaaaaaa1', 'tl/n-aaaaaaa2', 'tl/n-aaaaaaa3'];
    g(repo, 'branch', merged);
    for (const b of [picked, open]) {
      g(repo, 'checkout', '-q', '-b', b, 'dev');
      commit(repo, `${b.slice(-1)}.txt`);
    }
    g(repo, 'checkout', '-q', 'dev');
    commit(repo, 'later.txt');
    g(repo, 'cherry-pick', picked);
    expect((await m.worktrees({ cwd: repo })).kept).toEqual([
      { repo, branch: merged, unmerged: [] },
      { repo, branch: picked, unmerged: [] },
      { repo, branch: open, unmerged: [expect.stringContaining('add 3.txt')] },
    ]);
    expect((await m.worktrees({ cwd: repo, clean: 'safe' })).kept.map((k) => k.branch)).toEqual([open]);
  });

  it('close discard removes the worktree and the branch with their work', async () => {
    setup();
    const v = await spawnW();
    commit(v.cwd, 'a.txt');
    writeFileSync(join(v.cwd, 'b.txt'), 'b\n');
    expect(await m.close(v.id, true, 'discard')).toBeUndefined();
    expect(existsSync(v.cwd)).toBe(false);
    expect(g(repo, 'branch', '--list', `tl/${v.id}`)).toBe('');
  });

  it('close and restart are refused while the worktree is being created', async () => {
    setup();
    const id = await releasedChild();
    expect(m.view(id)!.status.activity).toBe('creating worktree');
    await expect(m.close(id, true, 'discard')).rejects.toThrow(`${id} is already creating`);
    expect(m.restart(id)).toEqual({ ok: false, error: `${id} is creating` });
    await expect.poll(() => m.session(id), { timeout: 10_000 }).toBeDefined();
    const path = m.registry.get(id)!.worktree!.path;
    await m.close(id, true, 'discard');
    expect(existsSync(path)).toBe(false);
    expect(existsSync(join(m.home, 'nodes', id))).toBe(false);
  });

  it('close succeeds on a clean tree whose branch is merged, and deletes the branch', async () => {
    setup();
    const v = await spawnW();
    commit(v.cwd, 'a.txt');
    g(repo, 'merge', '-q', '--no-ff', '--no-edit', `tl/${v.id}`);
    await m.close(v.id, true);
    expect(existsSync(v.cwd)).toBe(false);
    expect(g(repo, 'branch', '--list', `tl/${v.id}`)).toBe('');
    expect(g(repo, 'worktree', 'list').split('\n')).toHaveLength(1);
  });

  it('close archives what became of the branch; a fork of the closed node lands in the main checkout', async () => {
    setup();
    const merged = await spawnW(), kept = await spawnW(), discarded = await spawnW();
    for (const v of [merged, kept, discarded]) commit(v.cwd, `${v.id}.txt`);
    g(repo, 'merge', '-q', '--no-ff', '--no-edit', `tl/${merged.id}`);
    const transcript = join(home, 't.jsonl');
    writeFileSync(transcript, '');
    m.applyHook(merged.id, { hook_event_name: 'SessionStart', session_id: m.registry.get(merged.id)!.sessionId, transcript_path: transcript });
    await m.close(merged.id, true);
    await m.close(kept.id, true, 'keep');
    await m.close(discarded.id, true, 'discard');
    const fates = Object.fromEntries((await history(m.home)).map((a) => [a.id, [a.branch, a.branchFate, a.base]]));
    expect(fates).toEqual({
      [merged.id]: [`tl/${merged.id}`, 'merged', 'dev'], [kept.id]: [`tl/${kept.id}`, 'kept', undefined], [discarded.id]: [`tl/${discarded.id}`, 'discarded', undefined],
    });
    for (const cwd of [merged.cwd, '']) { // the UI passes the archived cwd; tl spawn --fork passes none
      const f = await m.spawn({ kind: 'claude', title: 'f', cwd, fork: merged.id, byHuman: true });
      expect(m.registry.get(f.id)!.cwd).toBe(repo);
    }
  });

  it('prune removes a clean exited worktree node and keeps one with unmerged work', async () => {
    setup();
    const busy = await spawnW(), idle = await spawnW();
    commit(busy.cwd, 'a.txt');
    await exited(busy.id);
    await exited(idle.id);
    const r = await m.prune();
    expect(r.removed).toEqual([idle.id]);
    expect(r.kept).toEqual([{ id: busy.id, reason: 'worktree kept: 0 dirty files, 1 unmerged commit; close with keep or discard' }]);
    expect(existsSync(busy.cwd)).toBe(true);
    expect(existsSync(idle.cwd)).toBe(false);
  });

  it('resume and restart are refused when the worktree directory is gone; close then drops the unused branch', async () => {
    setup();
    const v = await spawnW();
    await exited(v.id);
    rmSync(v.cwd, { recursive: true, force: true });
    m.applyHook(v.id, { hook_event_name: 'Stop' }); // the git refresh notices the directory is gone
    await expect.poll(() => m.view(v.id)!.worktree!.missing).toBe(true);
    expect(await m.resume(v.id)).toEqual({ ok: false, error: 'worktree missing' });
    expect(m.view(v.id)!.worktree!.missing).toBe(true);
    expect(m.restart(v.id)).toEqual({ ok: false, error: 'worktree missing' });
    await m.close(v.id, true);
    expect(g(repo, 'branch', '--list', `tl/${v.id}`)).toBe('');
  });

  it('a resumed worktree session keeps its transcript under the worktree, though SessionStart reports the main checkout', async () => {
    setup();
    const v = await spawnW();
    const sid = m.registry.get(v.id)!.sessionId!, transcript = transcriptFor(v.cwd, sid);
    mkdirSync(dirname(transcript), { recursive: true });
    writeFileSync(transcript, '');
    m.applyHook(v.id, { hook_event_name: 'SessionStart', session_id: sid, transcript_path: transcript, cwd: v.cwd, source: 'startup' });
    await exited(v.id);
    expect(await m.resume(v.id)).toEqual({ ok: true });
    // What claude --resume, run from the main checkout, sends before it re-enters the worktree (Claude Code 2.1.310).
    m.applyHook(v.id, { hook_event_name: 'SessionStart', session_id: sid, transcript_path: transcriptFor(repo, sid), cwd: repo, source: 'resume' });
    expect(m.registry.get(v.id)!.transcriptPath).toBe(transcript);
    await exited(v.id);
    expect(await m.resume(v.id)).toEqual({ ok: true });
  });

  it('a restart repoints a recorded main-checkout transcript at the worktree file, and leaves it when neither exists', async () => {
    setup();
    const fixed = await spawnW(), lost = await spawnW();
    const sid = m.registry.get(fixed.id)!.sessionId!, transcript = transcriptFor(fixed.cwd, sid);
    mkdirSync(dirname(transcript), { recursive: true });
    writeFileSync(transcript, '');
    const stale = (id: string) => transcriptFor(repo, m.registry.get(id)!.sessionId!);
    m.registry.update(fixed.id, { transcriptPath: stale(fixed.id), sessionHistory: [{ sessionId: sid, harness: 'claude', transcriptPath: stale(fixed.id) }] });
    m.registry.update(lost.id, { transcriptPath: stale(lost.id) });
    await m.shutdown();
    m = new NodeManager({ home: m.home, shell: '/bin/sh', path: `${join(home, 'bin')}:/usr/bin:/bin` });
    expect(m.registry.get(fixed.id)!.transcriptPath).toBe(transcript);
    expect(m.registry.get(fixed.id)!.sessionHistory).toEqual([{ sessionId: sid, harness: 'claude', transcriptPath: transcript }]);
    expect(m.registry.get(lost.id)!.transcriptPath).toBe(stale(lost.id));
  });

  it('a worktree under a symlinked .claude, which git lists by its resolved path, is not missing; resume and close discard work', async () => {
    setup();
    mkdirSync(join(repo, '.agent'));
    symlinkSync('.agent', join(repo, '.claude'));
    const v = await spawnW();
    expect(v.cwd).toBe(join(repo, '.claude', 'worktrees', v.id));
    expect(g(repo, 'worktree', 'list', '--porcelain')).toContain(join(repo, '.agent', 'worktrees', v.id));
    expect((await m.worktrees()).nodes).toEqual([expect.objectContaining({ nodeId: v.id, missing: undefined })]);
    await exited(v.id);
    const transcript = transcriptFor(v.cwd, m.registry.get(v.id)!.sessionId!);
    mkdirSync(dirname(transcript), { recursive: true });
    writeFileSync(transcript, '');
    expect(await m.resume(v.id)).toEqual({ ok: true });
    await exited(v.id);
    g(repo, 'worktree', 'lock', '--reason', `claude session ${v.id} (pid 999999 start x)`, v.cwd); // a stale Claude lock
    commit(v.cwd, 'a.txt');
    expect(await m.close(v.id, true, 'discard')).toBeUndefined();
    expect(existsSync(join(repo, '.agent', 'worktrees', v.id))).toBe(false);
    expect(g(repo, 'branch', '--list', `tl/${v.id}`)).toBe('');
    // A cwd reached through a symlink still finds the main checkout by git's path.
    symlinkSync(repo, join(home, 'link'));
    const u = await spawnW({ cwd: join(home, 'link') });
    expect(m.view(u.id)!.worktree!.repo).toBe(repo);
    expect((await m.worktrees()).nodes).toEqual([expect.objectContaining({ nodeId: u.id, missing: undefined })]);
  });

  it('startup reconciliation removes a clean orphan, lists one with work, and ignores worktrees with another home', async () => {
    setup();
    const node = await spawnW(); // also records the repo in worktree-repos.json
    const sha = g(repo, 'rev-parse', 'HEAD');
    const orphan = async (id: string, markerHome: string) => {
      const path = join(repo, '.claude', 'worktrees', id);
      await wt.add(repo, path, `tl/${id}`, sha);
      await wt.writeMarker(path, { home: markerHome, nodeId: id, base: 'dev', baseSha: sha });
      return path;
    };
    const busy = await orphan('n-0000000a', m.home);
    commit(busy, 'x.txt');
    const idle = await orphan('n-0000000b', m.home);
    const foreign = await orphan('n-0000000c', '/another/home');
    const r = await m.worktrees({ clean: 'startup' });
    expect(r.removed.map((x) => x.what)).toEqual([`worktree ${idle} and branch tl/n-0000000b`]);
    expect(r.orphans).toEqual([expect.objectContaining({ nodeId: 'n-0000000a', path: busy, dirty: [], unmerged: [expect.stringContaining('add x.txt')] })]);
    expect(r.nodes.map((n) => n.nodeId)).toEqual([node.id]);
    expect(r.kept).toEqual([]);
    expect(existsSync(busy) && existsSync(foreign)).toBe(true);
  });

  it('an agent close of an unmerged worktree is refused even under approvals.close "done"; discard always asks', async () => {
    setup();
    writeFileSync(join(m.home, 'config.json'), JSON.stringify({ approvals: { close: 'done' } }));
    const confirms: string[] = [];
    const { handler } = mountMcp(m, async (t) => { confirms.push(t); return true; }, () => {});
    const server = http.createServer((req, res) => void handler(req, res));
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    try {
      const parent = (await m.spawn({ kind: 'terminal', title: 'boss', cwd: repo }));
      const kid = await spawnW({ parentId: parent.id });
      commit(kid.cwd, 'a.txt');
      await exited(kid.id);
      const close = async (args: object) => {
        const res = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/api/close`, {
          method: 'POST', headers: { Authorization: `Bearer ${m.tokenFor(parent.id)}`, 'X-TL-Node': parent.id }, body: JSON.stringify({ nodeIds: [kid.id], ...args }),
        });
        return (await res.json()) as { data?: unknown; error?: string };
      };
      expect((await close({})).error).toBe('worktree kept: 0 dirty files, 1 unmerged commit; close with keep or discard');
      expect(confirms).toEqual([]);
      expect(m.view(kid.id)).toBeDefined();
      expect((await close({ worktree: 'discard' })).data).toMatchObject({ ok: true });
      expect(confirms).toEqual([expect.stringContaining('discards 1 commit(s) and 0 changed file(s)')]);
      expect(existsSync(kid.cwd)).toBe(false);
    } finally {
      server.closeAllConnections();
      await new Promise((r) => server.close(r));
    }
  });

  it('archives a branch with no commits as empty, and one whose commits are in base as merged', async () => {
    setup();
    const empty = await spawnW(), merged = await spawnW();
    commit(merged.cwd, 'a.txt');
    g(repo, 'merge', '-q', '--no-ff', '--no-edit', `tl/${merged.id}`);
    await m.close(empty.id, true);
    await m.close(merged.id, true);
    const fates = Object.fromEntries((await history(m.home)).map((a) => [a.id, [a.branchFate, a.base, a.brief]]));
    expect(fates).toEqual({ [empty.id]: ['empty', undefined, '(no commits)'], [merged.id]: ['merged', 'dev', '(merged into dev)'] });
  });
});

describe('read-only (detached) worktree nodes', () => {
  const spawnD = (extra: Partial<SpawnRequest> = {}) => spawnW({ isolation: 'detached', ...extra });

  it('checks out base with HEAD detached and no branch; an unknown base is refused', async () => {
    setup();
    g(repo, 'checkout', '-q', '-b', 'feat');
    commit(repo, 'f.txt');
    const feat = g(repo, 'rev-parse', 'HEAD');
    g(repo, 'checkout', '-q', 'dev');
    const v = await spawnD({ base: 'feat' });
    const path = join(repo, '.claude', 'worktrees', v.id);
    expect(v.worktree).toEqual({ repo, path, base: 'feat', baseSha: feat });
    expect(g(path, 'rev-parse', 'HEAD')).toBe(feat);
    expect(g(path, 'branch', '--show-current')).toBe('');
    expect(g(repo, 'branch', '--list', 'tl/*')).toBe('');
    expect((await spawnD()).worktree).toMatchObject({ base: 'dev', baseSha: g(repo, 'rev-parse', 'dev') }); // no base: the cwd's HEAD
    await expect(spawnD({ base: 'nope' })).rejects.toThrow('base branch nope does not exist');
    expect(g(repo, 'branch', '--list', 'nope')).toBe('');
  });

  it('refuses a merge; a clean close removes the tree and archives it as read-only', async () => {
    setup();
    const v = await spawnD();
    await expect(m.merge(v.id)).rejects.toThrow(`${v.id} has a read-only (detached) worktree: there is no branch to merge`);
    await m.close(v.id, true);
    expect(existsSync(v.cwd)).toBe(false);
    expect(g(repo, 'worktree', 'list').split('\n')).toHaveLength(1);
    const [a] = await history(m.home);
    expect([a!.branch, a!.branchFate, a!.base, a!.brief]).toEqual([undefined, 'detached', 'dev', '(read-only)']);
  });

  it('close refuses uncommitted files and stray commits on the detached HEAD; keep puts them on a branch', async () => {
    setup();
    const v = await spawnD();
    writeFileSync(join(v.cwd, 'b.txt'), 'b\n');
    await expect(m.close(v.id, true)).rejects.toThrow(/^worktree kept: 1 dirty file, 0 unmerged commits in a read-only \(detached\) worktree; close with keep or discard$/);
    g(v.cwd, 'add', 'b.txt');
    g(v.cwd, 'commit', '-qm', 'stray');
    await expect(m.close(v.id, true)).rejects.toThrow(/^worktree kept: 0 dirty files, 1 unmerged commit in a read-only \(detached\) worktree; close with keep or discard$/);
    expect(existsSync(v.cwd)).toBe(true);
    expect(await m.close(v.id, true, 'keep')).toBe(`kept branch tl/${v.id}`);
    expect(existsSync(v.cwd)).toBe(false);
    expect(g(repo, 'log', '-1', '--format=%s', `tl/${v.id}`)).toBe('stray');
    const [a] = await history(m.home);
    expect([a!.branch, a!.branchFate]).toEqual([`tl/${v.id}`, 'kept']);
  });

  it('discard drops a stray commit, and its git state counts it', async () => {
    setup();
    const v = await spawnD();
    commit(v.cwd, 'a.txt');
    await refreshGit(m, v.id);
    expect(m.view(v.id)!.status.git).toMatchObject({ base: 'dev', ahead: 1, dirty: 0 });
    expect(m.view(v.id)!.status.git!.branch).toBeUndefined();
    await m.close(v.id, true, 'discard');
    expect(existsSync(v.cwd)).toBe(false);
    expect(g(repo, 'branch', '--list', 'tl/*')).toBe('');
    expect((await history(m.home))[0]!.branchFate).toBe('discarded');
  });
});

describe('git state and merge', () => {
  const stop = (id: string) => m.applyHook(id, { hook_event_name: 'Stop' });
  const config = (worktrees: object) => writeFileSync(join(m.home, 'config.json'), JSON.stringify({ worktrees }));

  it('counts commits ahead and behind and dirty files, refreshed when a turn stops', async () => {
    setup();
    const v = await spawnW();
    await expect.poll(() => m.view(v.id)!.status.git).toEqual({ branch: `tl/${v.id}`, base: 'dev', ahead: 0, behind: 0, dirty: 0, additions: 0, deletions: 0 });
    commit(v.cwd, 'a.txt');
    writeFileSync(join(v.cwd, 'b.txt'), 'b\n');
    commit(repo, 'c.txt');
    stop(v.id);
    await expect.poll(() => m.view(v.id)!.status.git).toEqual({ branch: `tl/${v.id}`, base: 'dev', ahead: 1, behind: 1, dirty: 1, additions: 2, deletions: 0 });
  });

  it('diffs commits and uncommitted work as one, file by file, leaving the node\'s own index alone', async () => {
    setup();
    commit(repo, 'gone.txt');
    const v = await spawnW();
    writeFileSync(join(v.cwd, 'README'), 'README\nmore\n');
    g(v.cwd, 'commit', '-qam', 'edit');
    g(v.cwd, 'rm', '-q', 'gone.txt');
    writeFileSync(join(v.cwd, 'new.txt'), 'one\ntwo\n');
    const d = await m.diff(v.id);
    expect({ ...d, files: d.files.map(({ patch, ...f }) => f) }).toEqual({
      base: 'dev', branch: `tl/${v.id}`, files: [
        { path: 'README', status: 'modified', additions: 1, deletions: 0 },
        { path: 'gone.txt', status: 'deleted', additions: 0, deletions: 1 },
        { path: 'new.txt', status: 'added', additions: 2, deletions: 0 },
      ],
    });
    expect(d.files[2]!.patch).toMatch(/^diff --git a\/new.txt b\/new.txt\n[^]*@@ -0,0 \+1,2 @@\n\+one\n\+two\n$/);
    expect(g(v.cwd, 'status', '--porcelain')).toBe('D  gone.txt\n?? new.txt');
  });

  it('counts the files git status lists as dirty, writing no objects into the repo', async () => {
    setup();
    commit(repo, 'gone.txt');
    commit(repo, 'staged.txt');
    const v = await spawnW();
    const w = m.registry.get(v.id)!.worktree!;
    writeFileSync(join(v.cwd, 'README'), 'modified\n');
    writeFileSync(join(v.cwd, 'new.txt'), 'untracked\n');
    rmSync(join(v.cwd, 'gone.txt'));
    writeFileSync(join(v.cwd, 'staged.txt'), 'staged\n');
    g(v.cwd, 'add', 'staged.txt');
    const objects = () => g(repo, 'count-objects', '-v');
    const before = objects();
    expect(g(v.cwd, 'status', '--porcelain').split('\n').map((l) => l.trim())).toEqual(['M README', 'D gone.txt', 'M  staged.txt', '?? new.txt']);
    expect(await wt.diffStat(w)).toEqual({ additions: 3, deletions: 3, dirty: 4 });
    expect(objects()).toBe(before);
  });

  it('shutdown waits for the git refresh in flight and the PTY exits, so the home can go', async () => {
    setup();
    const v = await spawnW();
    writeFileSync(join(v.cwd, 'c.txt'), `${'y'.repeat(99)}\n`.repeat(Math.ceil(wt.MAX_PATCH_BYTES / 100))); // a slow diff
    const session = m.session(v.id)!;
    let refreshed = false;
    refreshGit(m, v.id).then(() => { refreshed = true; }, () => { refreshed = true; });
    await m.shutdown();
    expect(refreshed).toBe(true);
    expect(session.exited).toBe(true);
  });

  it('lists binary files and files past the patch cap without a patch', async () => {
    setup();
    const v = await spawnW();
    writeFileSync(join(v.cwd, 'a.txt'), 'small\n');
    writeFileSync(join(v.cwd, 'b.bin'), Buffer.from([0, 1, 2, 0]));
    const lines = Math.ceil(wt.MAX_PATCH_BYTES / 100); // 100 bytes a line: the patch passes the cap
    writeFileSync(join(v.cwd, 'c.txt'), `${'y'.repeat(99)}\n`.repeat(lines));
    const d = await m.diff(v.id);
    expect(d.files.map((f) => [f.path, !!f.patch, !!f.binary])).toEqual([['a.txt', true, false], ['b.bin', false, true], ['c.txt', false, false]]);
    expect(d.truncated).toBe(true);
    expect(d.files[2]!.additions).toBe(lines);
  });

  it('refuses a diff for a node without a worktree', async () => {
    setup();
    const t = (await m.spawn({ kind: 'terminal', title: 't', cwd: repo }));
    await expect(m.diff(t.id)).rejects.toThrow(`${t.id} has no worktree of its own to diff`);
  });

  it('refuses a conflicting merge, naming the paths and touching no file', async () => {
    setup();
    const v = await spawnW();
    writeFileSync(join(v.cwd, 'README'), 'theirs\n');
    g(v.cwd, 'commit', '-qam', 'theirs');
    writeFileSync(join(repo, 'README'), 'ours\n');
    g(repo, 'commit', '-qam', 'ours');
    const head = g(repo, 'rev-parse', 'HEAD');
    await expect(m.merge(v.id)).rejects.toMatchObject({ message: `merge refused, nothing changed: tl/${v.id} conflicts with dev in README`, conflicts: ['README'] });
    expect(g(repo, 'rev-parse', 'HEAD')).toBe(head);
    expect(readFileSync(join(repo, 'README'), 'utf8')).toBe('ours\n');
    expect(g(repo, 'status', '--porcelain') + g(v.cwd, 'status', '--porcelain')).toBe('');
    expect(m.view(v.id)!.status.git?.mergedAt).toBeUndefined();
  });

  it('refuses a dirty tree; merges with a merge commit into the checked-out base and sets mergedAt; close then succeeds', async () => {
    setup();
    const v = await spawnW();
    commit(v.cwd, 'a.txt');
    writeFileSync(join(v.cwd, 'b.txt'), 'b\n');
    await expect(m.merge(v.id)).rejects.toThrow('1 uncommitted file in the worktree');
    rmSync(join(v.cwd, 'b.txt'));
    const r = await m.merge(v.id);
    expect(r).toEqual({ base: 'dev', sha: g(repo, 'rev-parse', 'dev'), style: 'merge' });
    expect(g(repo, 'log', '-1', '--format=%P').split(' ')).toHaveLength(2);
    expect(g(repo, 'log', '-1', '--format=%s')).toBe(`Merge branch 'tl/${v.id}': w`);
    expect(readFileSync(join(repo, 'a.txt'), 'utf8')).toBe('a.txt\n'); // the main checkout moved with its branch
    expect(g(repo, 'status', '--porcelain')).toBe('');
    expect(m.view(v.id)!.status.git).toMatchObject({ ahead: 0, mergedAt: expect.any(Number) });
    await expect(m.merge(v.id)).rejects.toThrow('nothing to merge');
    await m.close(v.id, true);
    expect(g(repo, 'branch', '--list', `tl/${v.id}`)).toBe('');
  });

  it('squash makes one commit on base and the squashed branch still closes; ff-only refuses a moved base', async () => {
    setup();
    config({ mergeStyle: 'squash' });
    const v = await spawnW();
    commit(v.cwd, 'a.txt');
    commit(v.cwd, 'b.txt');
    const before = g(repo, 'rev-parse', 'dev');
    await m.merge(v.id);
    expect(g(repo, 'log', '-1', '--format=%P')).toBe(before);
    expect(g(repo, 'log', '-1', '--format=%B')).toBe(`w (squashed from tl/${v.id})\n\n* add a.txt\n* add b.txt`);
    expect(g(repo, 'show', '--format=', '--name-only', 'dev').split('\n')).toEqual(['a.txt', 'b.txt']);
    await m.close(v.id, true);
    expect(existsSync(v.cwd)).toBe(false);

    config({ mergeStyle: 'ff-only' });
    const f = await spawnW();
    commit(f.cwd, 'f.txt');
    commit(repo, 'moved.txt');
    await expect(m.merge(f.id)).rejects.toThrow('cannot fast-forward dev');
    g(repo, 'reset', '-q', '--hard', 'HEAD~1');
    await m.merge(f.id);
    expect(g(repo, 'rev-parse', 'dev')).toBe(g(repo, 'rev-parse', `tl/${f.id}`));
  });

  /** Lift vitest's commit.gpgsign=false override and hide the user's global and system config, so the repo's config decides. */
  const repoConfigOnly = () => {
    const global = join(home, 'empty.gitconfig');
    writeFileSync(global, '');
    vi.stubEnv('GIT_CONFIG_COUNT', '0');
    vi.stubEnv('GIT_CONFIG_GLOBAL', global);
    vi.stubEnv('GIT_CONFIG_NOSYSTEM', '1');
  };
  /** ssh signing with a throwaway key file (no agent) and commit.gpgsign on; returns the key's path. */
  const sshSigning = () => {
    const key = join(home, 'key');
    execFileSync('ssh-keygen', ['-t', 'ed25519', '-N', '', '-f', key, '-q']);
    writeFileSync(join(home, 'allowed_signers'), `t@example.com ${readFileSync(`${key}.pub`, 'utf8')}`);
    for (const [k, v] of [['gpg.format', 'ssh'], ['user.signingkey', key], ['gpg.ssh.allowedSignersFile', join(home, 'allowed_signers')], ['commit.gpgsign', 'true']]) g(repo, 'config', k!, v!);
    return key;
  };
  const signed = (sha: string) => g(repo, 'cat-file', '-p', sha).split('\n\n')[0]!.includes('\ngpgsig ');

  it('signs merge and squash commits when the repo sets commit.gpgsign', async () => {
    setup();
    repoConfigOnly();
    sshSigning();
    const v = await spawnW();
    commit(v.cwd, 'a.txt');
    const merged = (await m.merge(v.id)).sha;
    config({ mergeStyle: 'squash' });
    const s = await spawnW();
    commit(s.cwd, 'b.txt');
    const squashed = (await m.merge(s.id)).sha;
    for (const sha of [merged, squashed]) {
      expect(signed(sha)).toBe(true);
      execFileSync('git', ['-C', repo, 'verify-commit', sha], { stdio: 'pipe' }); // throws on a bad or missing signature
    }
  });

  it('leaves the merge commit unsigned when commit.gpgsign is unset', async () => {
    setup();
    repoConfigOnly();
    g(repo, 'config', '--unset', 'commit.gpgsign');
    const v = await spawnW();
    commit(v.cwd, 'a.txt');
    expect(signed((await m.merge(v.id)).sha)).toBe(false);
  });

  it('refuses the merge with git\'s error when signing fails, leaving base where it was', async () => {
    setup();
    repoConfigOnly();
    const key = sshSigning();
    const v = await spawnW();
    commit(v.cwd, 'a.txt');
    g(repo, 'config', 'user.signingkey', `${key}.missing`);
    const before = g(repo, 'rev-parse', 'dev');
    await expect(m.merge(v.id)).rejects.toThrow(/^git commit-tree failed: .*key\.missing/s);
    expect(g(repo, 'rev-parse', 'dev')).toBe(before);
    expect(m.view(v.id)!.status.git?.mergedAt).toBeUndefined();
  });

  it('a squash-merged branch still counts as merged after a daemon restart', async () => {
    setup();
    config({ merge: 'squash' });
    const v = await spawnW();
    commit(v.cwd, 'a.txt');
    await m.merge(v.id);
    m.shutdown();
    m = new NodeManager({ home: m.home, shell: '/bin/sh', path: `${join(home, 'bin')}:/usr/bin:/bin` });
    await expect.poll(() => m.view(v.id)!.status.git?.mergedAt, { timeout: 10_000 }).toEqual(expect.any(Number));
    await m.close(v.id, true);
    expect(existsSync(v.cwd)).toBe(false);
  });

  it('moves a base that is not checked out by ref only, and refuses a base checked out with uncommitted changes', async () => {
    setup();
    const v = await spawnW();
    commit(v.cwd, 'a.txt');
    writeFileSync(join(repo, 'README'), 'edited\n');
    await expect(m.merge(v.id)).rejects.toThrow(`dev is checked out at ${repo} with uncommitted changes`);
    g(repo, 'checkout', '-q', '--', 'README');
    g(repo, 'switch', '-q', '-c', 'other');
    await m.merge(v.id);
    expect(g(repo, 'show', '--format=', '--name-only', 'dev^2')).toBe('a.txt');
    expect(existsSync(join(repo, 'a.txt'))).toBe(false); // the checkout on "other" is untouched
    expect(g(repo, 'status', '--porcelain')).toBe('');
  });

  it('a requested base is created at HEAD, workers fork from its tip, and merges move it and leave main alone', async () => {
    setup();
    g(repo, 'branch', '-m', 'main');
    const main = g(repo, 'rev-parse', 'main');
    await expect(m.spawn({ kind: 'claude', title: 'w', cwd: repo, base: 'feat/x' })).rejects.toThrow('base is for isolation "worktree" or "detached" only');
    await expect(spawnW({ base: 'bad..name' })).rejects.toThrow('not a valid branch name: bad..name');
    const v = await spawnW({ base: 'feat/x' });
    expect(v.worktree).toMatchObject({ base: 'feat/x', baseSha: main });
    expect(g(repo, 'rev-parse', 'feat/x')).toBe(main);
    commit(v.cwd, 'a.txt');
    const r = await m.merge(v.id);
    expect(r.base).toBe('feat/x');
    expect(g(repo, 'rev-parse', 'feat/x')).toBe(r.sha);
    expect(g(repo, 'rev-parse', 'main')).toBe(main);
    const next = await spawnW({ base: 'feat/x' }); // the second worker of the task starts from the first one's merge
    expect(next.worktree).toMatchObject({ base: 'feat/x', baseSha: r.sha });
  });

  it('without a base, a worker spawned on a protected branch gets a task branch named from its title', async () => {
    setup();
    g(repo, 'branch', '-m', 'main');
    const main = g(repo, 'rev-parse', 'main');
    const a = await spawnW({ title: 'Fix the Login bug!' }), b = await spawnW({ title: 'Fix the Login bug!' });
    expect(a.worktree).toMatchObject({ base: 'tl/fix-the-login-bug', baseSha: main });
    expect(b.worktree!.base).toBe('tl/fix-the-login-bug-2');
    g(repo, 'switch', '-q', '--detach');
    expect((await spawnW({ title: '???' })).worktree!.base).toBe('tl/task'); // detached counts as protected
    g(repo, 'switch', '-q', 'main');
    config({ taskBranch: 'feature/{slug}' });
    expect((await spawnW({ title: 'x' })).worktree!.base).toBe('feature/x');
  });

  it('refuses to merge into a protected branch, changing nothing, unless the config empties the list; origin\'s default counts', async () => {
    setup();
    g(repo, 'branch', '-m', 'main');
    const v = await spawnW({ base: 'main' });
    commit(v.cwd, 'a.txt');
    const main = g(repo, 'rev-parse', 'main'), tip = g(repo, 'rev-parse', `tl/${v.id}`);
    await expect(m.merge(v.id)).rejects.toThrow('refusing to merge into protected branch main; spawn workers with base <branch> (tl spawn --base, or base on the spawn tool) and open a pull request from it');
    expect([g(repo, 'rev-parse', 'main'), g(repo, 'rev-parse', `tl/${v.id}`)]).toEqual([main, tip]);
    expect(m.view(v.id)!.status.git?.mergedAt).toBeUndefined();
    config({ protected: [] });
    expect((await m.merge(v.id)).base).toBe('main');

    config({});
    g(repo, 'update-ref', 'refs/remotes/origin/trunk', 'HEAD');
    g(repo, 'symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/trunk');
    g(repo, 'branch', 'trunk');
    const t = await spawnW({ base: 'trunk' });
    commit(t.cwd, 't.txt');
    await expect(m.merge(t.id)).rejects.toThrow('refusing to merge into protected branch trunk');
  });

  it('an explicit empty protected list leaves origin\'s default branch unprotected; unset, main is protected', async () => {
    setup();
    g(repo, 'branch', '-m', 'main');
    g(repo, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
    g(repo, 'symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main');
    config({ protected: [] });
    const v = await spawnW();
    expect(v.worktree!.base).toBe('main');
    commit(v.cwd, 'a.txt');
    expect((await m.merge(v.id)).base).toBe('main');

    config({});
    const t = await spawnW({ title: 'x' });
    expect(t.worktree!.base).toBe('tl/x');
    const u = await spawnW({ base: 'main' });
    commit(u.cwd, 'u.txt');
    await expect(m.merge(u.id)).rejects.toThrow('refusing to merge into protected branch main');
  });
});

describe('setup and teardown commands', () => {
  const config = (worktrees: object) => writeFileSync(join(m.home, 'config.json'), JSON.stringify({ worktrees }));
  const argvOf = (id: string) => { const f = join(m.home, 'nodes', id, 'argv'); return existsSync(f) ? readFileSync(f, 'utf8') : ''; };

  it('setup runs in the worktree with its env before launch; a failure marks the node and restart retries it', async () => {
    setup();
    config({ setup: ['sleep 0.5', 'echo "$TL_NODE_ID $TL_BASE $TL_REPO $TL_WORKTREE $(pwd)" > ../setup-$TL_NODE_ID'] });
    const v = await spawnW({ prompt: 'hi' });
    expect(v.status).toMatchObject({ state: 'unknown', activity: 'setting up worktree: sleep 0.5' });
    await expect(m.merge(v.id)).rejects.toThrow('worktree setup is running');
    expect(m.session(v.id)).toBeUndefined();
    await expect.poll(() => argvOf(v.id), { timeout: 5000 }).toContain('-- hi');
    expect(readFileSync(join(repo, '.claude', 'worktrees', `setup-${v.id}`), 'utf8')).toBe(`${v.id} dev ${repo} ${v.cwd} ${v.cwd}\n`);

    config({ setup: ['echo broken; exit 3'] });
    const bad = await spawnW({ prompt: 'brief' });
    const log = join(m.home, 'nodes', bad.id, 'setup.log');
    await expect.poll(() => m.view(bad.id)!.status).toMatchObject({ exited: true, errored: true, activity: `worktree setup failed: echo broken; exit 3: exited with 3; see ${log}` });
    expect(readFileSync(log, 'utf8')).toBe('$ echo broken; exit 3\nbroken\n');
    expect(m.session(bad.id)).toBeUndefined();
    expect(await m.resume(bad.id)).toEqual({ ok: false, error: 'worktree setup has not succeeded; restart runs it again' });
    config({ setup: ['true'] });
    expect(m.restart(bad.id)).toEqual({ ok: true });
    await expect.poll(() => argvOf(bad.id), { timeout: 5000 }).toContain('-- brief');
  });

  it('a released node whose setup fails frees its limits.maxWorking slot', async () => {
    setup();
    writeFileSync(join(m.home, 'config.json'), JSON.stringify({ worktrees: { setup: ['exit 3'] }, limits: { maxWorking: 1 } }));
    const failed = await releasedChild({ prompt: 'brief' });
    await expect.poll(() => m.view(failed)!.status, { timeout: 10_000 }).toMatchObject({ exited: true, errored: true });
    const next = await m.spawn({ kind: 'claude', title: 'next', cwd: repo, parentId: m.registry.get(failed)!.parentId, prompt: 'go', isolation: 'none' });
    expect(next.status.state).not.toBe('queued');
    expect(m.session(next.id)).toBeDefined();
  });

  it('teardown runs in the worktree before close removes it', async () => {
    setup();
    config({ teardown: ['echo "$TL_NODE_ID" >> "$TL_REPO/../teardown.log"; test -d "$TL_WORKTREE"'] });
    const v = await spawnW();
    await m.close(v.id, true);
    expect(readFileSync(join(home, 'teardown.log'), 'utf8')).toBe(`${v.id}\n`);
    expect(existsSync(v.cwd)).toBe(false);
  });
});

describe('copyIncluded', () => {
  it('copies only files that match the include list and are gitignored; symlinks stay links', async () => {
    setup();
    writeFileSync(join(repo, '.gitignore'), '.env\nnode_modules/\nsecret.txt\nconfig/\n');
    g(repo, 'add', '.gitignore');
    g(repo, 'commit', '-qm', 'ignore');
    writeFileSync(join(repo, '.worktreeinclude'), '.env\nnode_modules/\nnotes.txt\nconfig/local.json\nREADME\n');
    mkdirSync(join(repo, 'node_modules', 'pkg'), { recursive: true });
    mkdirSync(join(repo, 'config'));
    for (const f of ['.env', 'notes.txt', 'secret.txt', 'node_modules/pkg/index.js', 'config/local.json', 'config/other.json']) writeFileSync(join(repo, f), f);
    symlinkSync('pkg', join(repo, 'node_modules', 'link'));
    const dest = mkdtempSync(join(home, 'dest-'));
    expect((await wt.copyIncluded(repo, dest)).sort()).toEqual(['.env', 'config/local.json', 'node_modules/']);
    expect(readFileSync(join(dest, 'node_modules/pkg/index.js'), 'utf8')).toBe('node_modules/pkg/index.js');
    expect(lstatSync(join(dest, 'node_modules/link')).isSymbolicLink()).toBe(true);
    for (const f of ['notes.txt', 'secret.txt', 'config/other.json', 'README']) expect(existsSync(join(dest, f))).toBe(false);
    expect(await wt.copyIncluded(repo, mkdtempSync(join(home, 'dest-')), ['secret.txt'])).toEqual(['secret.txt']); // config replaces .worktreeinclude
  });
});

describe('isListed', () => {
  it('is true only for an existing directory git lists, however the path is spelled', async () => {
    setup();
    const path = join(home, 'wt');
    g(repo, 'worktree', 'add', '-q', '-b', 'tl/listed', path);
    symlinkSync(path, join(home, 'wt-link'));
    expect(await wt.isListed({ repo, path })).toBe(true);
    expect(await wt.isListed({ repo, path: `${path}/` })).toBe(true);
    expect(await wt.isListed({ repo, path: join(home, 'wt-link') })).toBe(true);
    mkdirSync(join(home, 'plain'));
    expect(await wt.isListed({ repo, path: join(home, 'plain') })).toBe(false); // exists, not a worktree of repo
    rmSync(path, { recursive: true });
    expect(await wt.isListed({ repo, path })).toBe(false); // still registered, directory gone
  });
});
