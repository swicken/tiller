// A worktree node's worktree from creation to removal: trust checks, creating it and running its setup, merging,
// closing and removing it with its teardown, reconciling worktrees with the registry, and the live git state.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import type { GitState, NodeStatus, NodeView, Worktree } from '../shared/protocol.js';
import { claudeHomes } from './claude-accounts.js';
import { turnDone } from './completion-watches.js';
import { loadConfig, type MergeStyle } from './config.js';
import type { NodeManager } from './manager.js';
import { buildChildEnv } from './pty.js';
import { tillerTrusts } from './trust.js';
import { initialState } from './status.js';
import { canonical, count, inside, logError } from './util.js';
import * as wt from './worktree.js';

/** Main checkouts in which this daemon has created worktrees, so reconciliation finds them after a lost record. */
const REPOS_FILE = 'worktree-repos.json';
/** How long close waits for a killed worktree node to exit, so Claude's lock on the worktree belongs to a dead pid. */
const EXIT_WAIT_MS = 3000;
/** After an edit, wait this long for more before recomputing a worktree's git state; a turn's end refreshes it at once. */
const GIT_DEBOUNCE_MS = 15_000;
/** Limit for each worktree setup or teardown command. */
const SETUP_TIMEOUT_MS = 10 * 60_000;

/** What stands between a node's worktree and its removal. */
export interface WorktreeCheck { dirty: string[]; unmerged: string[]; sharing: string[] }

/**
 * Why closing a worktree node must not go ahead, or undefined. Another live node working inside the tree always
 * refuses; uncommitted files or unmerged commits refuse unless the close says keep or discard. Short and action first.
 */
export function closeRefusal(c: WorktreeCheck, mode?: 'keep' | 'discard'): string | undefined {
  const unsafe = !mode && (c.dirty.length > 0 || c.unmerged.length > 0);
  const sharing = c.sharing.length ? `in use by ${c.sharing.join(', ')}` : '';
  if (!unsafe) return sharing ? `worktree ${sharing}; close those nodes first` : undefined;
  const msg = `worktree kept: ${count(c.dirty.length, 'dirty file')}, ${count(c.unmerged.length, 'unmerged commit')}; close with keep or discard`;
  return sharing ? `${msg}; ${sharing}` : msg;
}

export interface WorktreeReport {
  nodes: { nodeId: string; title: string; repo: string; path: string; branch: string; base: string; missing?: boolean }[];
  /** Worktrees with this daemon's marker but no node, left by a crash between creating the worktree and saving the record. */
  orphans: { nodeId: string; repo: string; path: string; branch?: string; base: string; dirty: string[]; unmerged: string[]; error?: string }[];
  /** <prefix>n-<hex> branches with neither a worktree nor a node, such as those kept by close with keep. */
  kept: { repo: string; branch: string; unmerged: string[] }[];
  /** What a clean removed, with the commits and uncommitted files that went with it. */
  removed: { what: string; commits: string[]; files: string[] }[];
}

/**
 * Whether we may answer Claude's folder-trust dialog for `cwd`. Only when the node's .claude.json already
 * records trust for the cwd or one of its ancestors; otherwise the human has to decide.
 */
export function trustPolicy(cwd: string, claudeJson: unknown): 'auto' | 'manual' {
  for (let dir = resolve(cwd); ; dir = dirname(dir)) {
    if (trusted(claudeJson, dir)) return 'auto';
    if (dirname(dir) === dir) return 'manual';
  }
}

/**
 * Whether `claude --worktree` will start in `repo`. Interactively it exits with "Workspace trust not yet accepted" unless
 * trust is recorded for the repo itself: with 2.1.296 a trusted ancestor did not count when the repo had its own entry.
 */
export function trustedForWorktree(repo: string, claudeJson: unknown): boolean {
  return trusted(claudeJson, repo);
}

/** Whether a .claude.json records trust for exactly `dir`. */
function trusted(claudeJson: unknown, dir: string): boolean {
  return (claudeJson as { projects?: Record<string, { hasTrustDialogAccepted?: unknown }> } | null)?.projects?.[dir]?.hasTrustDialogAccepted === true;
}

/** A Claude home's .claude.json (trust lives there): `<configDir>/.claude.json`, or ~/.claude.json for the default home. */
export function readClaudeJson(configDir?: string): unknown {
  try { return JSON.parse(readFileSync(configDir ? join(configDir, '.claude.json') : join(homedir(), '.claude.json'), 'utf8')); } catch { return null; }
}

/** Whether any Claude home Tiller knows trusts `dir`: commands Tiller runs itself are not tied to one account. */
const claudeTrustsAny = (home: string, dir: string): boolean => claudeHomes(home).some((d) => trustPolicy(dir, readClaudeJson(d)) === 'auto');

/**
 * Give a node its worktree, branched from the tip of branch `baseBranch` (absent: the HEAD of the checkout its cwd is in),
 * and launch it, after the setup commands when configured. A failure removes the worktree and branch and throws; the
 * caller deals with the record.
 */
export async function addWorktree(m: NodeManager, id: string, prompt: string | undefined, baseBranch?: string): Promise<void> {
  const rt = m.runtimes.get(id)!;
  rt.busy = 'creating';
  try {
    await createWorktree(m, id, prompt, baseBranch);
  } finally {
    rt.busy = undefined;
  }
}

async function createWorktree(m: NodeManager, id: string, prompt: string | undefined, baseBranch?: string): Promise<void> {
  const rec = m.registry.get(id)!;
  const repo = await wt.mainCheckout(rec.cwd);
  const { base, baseSha } = baseBranch ? { base: baseBranch, baseSha: await wt.branchSha(rec.cwd, baseBranch) } : await wt.headInfo(rec.cwd);
  if (!baseSha) throw new Error(`base branch ${base} no longer exists`);
  const config = loadConfig(repo, m.home); // the main checkout's file, whichever branch rec.cwd has checked out
  const path = join(repo, wt.WORKTREES_DIR, id);
  const worktree: Worktree = { repo, path, branch: config.worktrees.branchPrefix + id, base, baseSha };
  m.registry.update(id, { cwd: path, worktree });
  let added = false;
  try {
    rememberRepo(m, repo); // first, so startup reconciliation looks here even if a crash loses the record
    await wt.add(repo, path, worktree.branch, baseSha);
    added = true;
    await wt.writeMarker(path, { home: m.home, nodeId: id, base, baseSha });
    await wt.ensureExcluded(repo);
    m.registry.flush(); // a crash from here on leaves a record, not an orphan
    await wt.copyIncluded(repo, path, config.worktrees.include);
    if (!m.registry.get(id)) throw new Error(`${id} was closed while its worktree was being created`);
    m.writeFiles(id);
    m.runtimes.get(id)!.status = { state: initialState(m.registry.get(id)!.kind), changedAt: Date.now() };
    const setup = worktreeCommands(m, repo, 'setup');
    if (setup.length) setupThenLaunch(m, id, worktree, setup, prompt); // in the background: it may take minutes
    else m.launch(id, prompt, false);
  } catch (err) {
    if (added) await teardown(m, id, worktree).then(() => wt.remove(repo, path, true)).then(() => wt.deleteBranch(repo, worktree.branch)).catch(logError);
    throw err;
  }
  refreshGit(m, id).catch(logError);
}

export type MergeResult = { base: string; sha: string; style: MergeStyle };

/** The refusals that hold whatever the node is doing: no worktree, a protected base, setup running. */
async function mergeable(m: NodeManager, id: string): Promise<Worktree> {
  const rec = m.registry.get(id);
  if (!rec) throw new Error(`no such node: ${id}`);
  const w = rec.worktree;
  if (!w) throw new Error(`${id} has no worktree of its own to merge`);
  if ((await wt.protectedBranches(w.repo, loadConfig(w.repo, m.home).worktrees.protected)).includes(w.base)) {
    throw new Error(`refusing to merge into protected branch ${w.base}; spawn workers with base <branch> (tl spawn --base, or base on the spawn tool) and open a pull request from it`);
  }
  if (m.runtimes.get(id)!.setup) throw new Error('worktree setup is running');
  return w;
}

/** See NodeManager.merge. */
export async function mergeWorktree(m: NodeManager, id: string): Promise<MergeResult> {
  const w = await mergeable(m, id);
  const rec = m.registry.get(id)!;
  const rt = m.runtimes.get(id)!, s = rt.status!;
  if (s.state === 'working' && !s.exited) throw new Error(`refusing to merge while ${id} is working; wait until its turn ends`);
  if (rt.busy) throw new Error(`${id} is already ${rt.busy}`);
  rt.busy = 'merging';
  try {
    await gitSettled(rt);
    const dirty = existsSync(w.path) ? await wt.dirtyFiles(w.path) : [];
    if (dirty.length) throw new Error(`merge refused, nothing changed: ${count(dirty.length, 'uncommitted file')} in the worktree; commit them first`);
    const style = loadConfig(w.repo, m.home).worktrees.mergeStyle;
    const subject = style === 'squash' ? `${rec.title} (squashed from ${w.branch})` : `Merge branch '${w.branch}': ${rec.title}`;
    const sha = await wt.mergeInto(w.repo, w.branch, w.base, style, subject);
    const merged = { tip: (await wt.branchSha(w.repo, w.branch)) ?? '', at: Date.now() };
    m.registry.update(id, { worktree: { ...m.registry.get(id)!.worktree!, merged } });
    m.logEvent(id, 'merge', { branch: w.branch, base: w.base, sha: sha.slice(0, 7), style });
    return { base: w.base, sha, style };
  } finally {
    rt.busy = undefined;
    await refreshGit(m, id).catch(logError);
  }
}

interface QueuedMerge { by: string; since: number; settle: (result: Promise<MergeResult>) => void }
/** Merges waiting for their node's turn to end, by node id. In memory only: shutdown drops them, telling each caller. */
const queuedMerges = new WeakMap<NodeManager, Map<string, QueuedMerge>>();

/**
 * Merge `id` once the turn it is working on ends (or it exits), for `by`. Returns false, queueing nothing, when the node is
 * not working: the caller merges now. Refusals that a turn's end cannot lift throw now; the merge re-checks them all.
 * `settle` gets the merge, or a rejection when the node is closed or the daemon stops first. One per node: a second throws.
 */
export async function queueMerge(m: NodeManager, id: string, by: string, settle: QueuedMerge['settle']): Promise<boolean> {
  await mergeable(m, id);
  const s = m.view(id)!.status;
  if (s.state !== 'working' || s.exited) return false;
  let q = queuedMerges.get(m);
  if (!q) {
    queuedMerges.set(m, q = new Map());
    const all = q;
    m.on('node', (v: NodeView) => fireQueuedMerge(m, all, v.id));
    m.on('removed', (gone: string) => {
      all.get(gone)?.settle(Promise.reject(new Error(`${gone} was closed before its turn ended; nothing was merged`)));
      all.delete(gone);
      for (const [k, e] of all) if (e.by === gone) all.delete(k); // nobody is left to tell
    });
  }
  const queued = q.get(id);
  if (queued) throw new Error(`a merge of ${id} is already queued by ${queued.by}`);
  q.set(id, { by, since: m.turnStartedAt(id) ?? Date.now(), settle });
  fireQueuedMerge(m, q, id); // the turn may have ended while the checks ran
  return true;
}

function fireQueuedMerge(m: NodeManager, q: Map<string, QueuedMerge>, id: string): void {
  const e = q.get(id);
  if (!e || m.stopped || !turnDone({ view: (x) => m.view(x), turnStartedAt: (x) => m.turnStartedAt(x) }, id, e.since)) return;
  q.delete(id);
  e.settle(mergeWorktree(m, id));
}

/** At shutdown, before any node exits: drop the queued merges, telling their callers. */
export function dropQueuedMerges(m: NodeManager): void {
  const q = queuedMerges.get(m);
  for (const [id, e] of q ?? []) e.settle(Promise.reject(new Error(`the daemon stopped before ${id}'s turn ended; nothing was merged, merge again`)));
  q?.clear();
}

/** The worktree half of NodeManager.close: refuse an unsafe close, stop setup, kill the node, remove the tree, forget the node. */
export async function closeWorktreeNode(m: NodeManager, id: string, title: string, w: Worktree, mode?: 'keep' | 'discard'): Promise<string | undefined> {
  const rt = m.runtimes.get(id)!;
  rt.busy = 'closing';
  try {
    await gitSettled(rt);
    const refusal = closeRefusal((await worktreeCheck(m, id))!, mode);
    if (refusal) throw new Error(refusal);
    const setup = rt.setup;
    setup?.abort.abort();
    await setup?.done;
    const s = m.kill(id);
    if (s && !s.exited) await new Promise<void>((done) => { s.onExit(() => done()); setTimeout(done, EXIT_WAIT_MS).unref(); });
    let note: string | undefined;
    try {
      note = await removeWorktree(m, id, title, w, mode);
    } catch (err) {
      m.setStatus(id, { ...rt.status!, exited: true, activity: (err as Error).message, changedAt: Date.now() }, false);
      throw err;
    }
    // A plain close got here only with the branch merged (closeRefusal and removeWorktree check it); keep notes a kept branch.
    m.closed(id, note, note ? { branchFate: 'kept' } : mode === 'discard' ? { branchFate: 'discarded' } : { branchFate: 'merged', base: w.base });
    return note;
  } finally {
    rt.busy = undefined;
  }
}

/** Uncommitted files, unmerged commits and other live nodes inside the node's worktree; undefined when it owns none. */
export async function worktreeCheck(m: NodeManager, id: string): Promise<WorktreeCheck | undefined> {
  const w = m.registry.get(id)?.worktree;
  if (!w) return undefined;
  const sharing = m.registry.list().filter((n) => n.id !== id && m.session(n.id) && inside(n.cwd, w.path)).map((n) => n.id);
  if (!existsSync(w.path)) return { dirty: [], unmerged: [], sharing }; // missing: close keeps an unmerged branch, so nothing is lost
  const [dirty, unmerged] = await Promise.all([wt.dirtyFiles(w.path), wt.unmergedCommits(w.repo, w.branch, w.base, w.baseSha)]);
  // A squash merge leaves the branch's own commits outside base; it still counts as merged until the branch moves.
  return { dirty, unmerged: unmerged.length && (await mergedAt(w)) ? [] : unmerged, sharing };
}

async function removeWorktree(m: NodeManager, id: string, title: string, w: Worktree, mode?: 'keep' | 'discard'): Promise<string | undefined> {
  if (!existsSync(w.path)) {
    await wt.prune(w.repo);
    if (!(await wt.branchSha(w.repo, w.branch))) return undefined;
    if (mode === 'discard' || (!mode && !(await wt.unmergedCommits(w.repo, w.branch, w.base, w.baseSha)).length)) {
      await wt.deleteBranch(w.repo, w.branch);
      return undefined;
    }
    return `worktree was missing; kept branch ${w.branch}`;
  }
  if (mode === 'keep' && (await wt.dirtyFiles(w.path)).length) {
    await wt.git(w.path, ['add', '-A']);
    await wt.git(w.path, ['commit', '-q', '--no-verify', '-m', `WIP: tiller node "${title}" (${id})`]);
  } else if (!mode) {
    const c = (await worktreeCheck(m, id))!; // again: the agent may have written something before it died
    if (c.dirty.length || c.unmerged.length) throw new Error(`worktree kept: changed during close (${c.dirty.length} uncommitted file(s), ${c.unmerged.length} unmerged commit(s))`);
  }
  await wt.unlockForRemoval(w.repo, w.path, id);
  await teardown(m, id, w);
  await wt.remove(w.repo, w.path, mode === 'discard');
  if (mode === 'keep') return `kept branch ${w.branch}`;
  await wt.deleteBranch(w.repo, w.branch); // merged (checked above) or discarded
  return undefined;
}

/** See NodeManager.worktrees. */
export async function worktrees(m: NodeManager, opts: { cwd?: string; clean?: 'startup' | 'safe' | 'force' } = {}): Promise<WorktreeReport> {
  const repos = opts.cwd ? [await wt.mainCheckout(opts.cwd)]
    : [...new Set([...knownRepos(m), ...m.registry.list().flatMap((n) => (n.worktree ? [n.worktree.repo] : []))])];
  const report: WorktreeReport = { nodes: [], orphans: [], kept: [], removed: [] };
  for (const repo of repos) {
    if (!existsSync(repo)) continue;
    try { await reconcileRepo(m, repo, opts.clean, report); } catch (err) { if (opts.cwd) throw err; logError(err); }
  }
  return report;
}

async function reconcileRepo(m: NodeManager, repo: string, clean: 'startup' | 'safe' | 'force' | undefined, r: WorktreeReport): Promise<void> {
  await wt.prune(repo);
  const entries = await wt.listWorktrees(repo);
  const live = (path: string) => m.registry.list().some((n) => m.session(n.id) && inside(n.cwd, path));
  const dir = canonical(join(repo, wt.WORKTREES_DIR)) + sep;
  for (const e of entries.filter((x) => canonical(x.path).startsWith(dir))) {
    const marker = await wt.readMarker(e.path);
    if (!marker || marker.home !== m.home || m.registry.get(marker.nodeId)?.worktree) continue; // not ours, or a node's
    const dirty = await wt.dirtyFiles(e.path);
    // A detached orphan has no branch to compare; only force removes it.
    const unmerged = e.branch ? await wt.unmergedCommits(repo, e.branch, marker.base, marker.baseSha) : ['(detached HEAD)'];
    const safe = !dirty.length && !!e.branch && (clean === 'startup' ? !(await wt.hasCommits(repo, e.branch, marker.baseSha)) : !unmerged.length);
    const orphan = { nodeId: marker.nodeId, repo, path: e.path, branch: e.branch, base: marker.base, dirty, unmerged };
    if (clean && (clean === 'force' || safe) && !live(e.path)) {
      try {
        await wt.unlockForRemoval(repo, e.path, marker.nodeId);
        await teardown(m, marker.nodeId, { repo, path: e.path, base: marker.base });
        await wt.remove(repo, e.path, clean === 'force');
        if (e.branch) await wt.deleteBranch(repo, e.branch);
        r.removed.push({ what: `worktree ${e.path}${e.branch ? ` and branch ${e.branch}` : ''}`, commits: unmerged, files: dirty });
        continue;
      } catch (err) {
        r.orphans.push({ ...orphan, error: (err as Error).message });
        continue;
      }
    }
    r.orphans.push(orphan);
  }
  for (const n of m.registry.list()) {
    if (n.worktree?.repo !== repo) continue;
    setMissing(m, n.id, !entries.some((e) => wt.samePath(e.path, n.worktree!.path)));
    const w = m.registry.get(n.id)!.worktree!;
    r.nodes.push({ nodeId: n.id, title: n.title, repo, path: w.path, branch: w.branch, base: w.base, missing: w.missing });
  }
  const prefix = loadConfig(repo, m.home).worktrees.branchPrefix;
  const used = new Set([...entries.flatMap((e) => (e.branch ? [e.branch] : [])), ...m.registry.list().flatMap((n) => (n.worktree ? [n.worktree.branch] : []))]);
  const leftover = (await wt.branches(repo, prefix)).filter((b) => !used.has(b) && /^n-[0-9a-f]{8}$/.test(b.slice(prefix.length)));
  if (!leftover.length) return;
  // The nodes and their recorded bases are gone, so judge against the main checkout's HEAD: as unmergedCommits does,
  // but with one listing of the branches already in it, so only the rest need git cherry.
  const { baseSha: head } = await wt.headInfo(repo);
  const merged = new Set(await wt.mergedBranches(repo, head));
  for (const branch of leftover) {
    const unmerged = merged.has(branch) ? [] : await wt.cherry(repo, head, branch);
    if (clean === 'force' || (clean === 'safe' && !unmerged.length)) {
      await wt.deleteBranch(repo, branch);
      r.removed.push({ what: `branch ${branch} in ${repo}`, commits: unmerged, files: [] });
    } else {
      r.kept.push({ repo, branch, unmerged });
    }
  }
}

export function setMissing(m: NodeManager, id: string, missing: boolean): void {
  const w = m.registry.get(id)?.worktree;
  if (!w || !!w.missing === missing) return;
  const { missing: _, ...rest } = w;
  m.registry.update(id, { worktree: missing ? { ...rest, missing } : rest });
  m.emitNode(id);
}

type GitRun = { done: Promise<void>; again?: Promise<void> };
/** Per node runtime: the git refresh in flight and the one rerun queued behind it. */
const gitRuns = new WeakMap<object, GitRun>();

/**
 * Recompute a worktree node's git state and re-emit the node when it changed. Calls coalesce per node: one made while a
 * refresh runs queues a single rerun, shared by every later call, so each call settles after a refresh that started
 * after it, and replaces a debounced refreshGitSoon still waiting. A node closed or a daemon stopped meanwhile skips the
 * rerun; none starts after shutdown.
 */
export function refreshGit(m: NodeManager, id: string): Promise<void> {
  const rt = m.runtimes.get(id);
  if (!rt || m.stopped) return Promise.resolve();
  clearTimeout(rt.gitTimer); // this refresh starts after the edits that timer waits on
  rt.gitTimer = undefined;
  const run = gitRuns.get(rt);
  if (!run) return startGit(m, id, rt);
  const next = () => {
    if (m.runtimes.get(id) === rt && !m.stopped) return startGit(m, id, rt);
    gitRuns.delete(rt);
  };
  return (run.again ??= run.done.then(next, next));
}

/** Settles once the node's git refresh in flight, and the rerun queued behind it, have finished. */
export function gitSettled(rt: object): Promise<void> {
  const run = gitRuns.get(rt);
  return (run?.again ?? run?.done ?? Promise.resolve()).catch(() => {});
}

function startGit(m: NodeManager, id: string, rt: object): Promise<void> {
  // A queued rerun keeps the entry until it replaces it, so no call slips in between and runs alongside.
  const run: GitRun = { done: gitSlot(() => readGit(m, id)).finally(() => { if (!run.again) gitRuns.delete(rt); }) };
  gitRuns.set(rt, run);
  return run.done;
}

/** At most this many git refreshes run at once, so a burst (every worktree node at startup) cannot flood the daemon with git processes. */
const GIT_CONCURRENCY = 4;
let gitActive = 0;
const gitWaiting: (() => void)[] = [];

async function gitSlot<T>(f: () => Promise<T>): Promise<T> {
  if (gitActive < GIT_CONCURRENCY) gitActive++;
  else await new Promise<void>((r) => gitWaiting.push(r)); // the finishing run hands its slot over
  try {
    return await f();
  } finally {
    const next = gitWaiting.shift();
    if (next) next();
    else gitActive--;
  }
}

async function readGit(m: NodeManager, id: string): Promise<void> {
  const w = m.registry.get(id)?.worktree;
  if (!w || m.stopped) return;
  const missing = !existsSync(w.path);
  const [counts, stat, merged, tips] = await Promise.all([
    // Fails when the branch is gone: then zero counts. Any other failure keeps the last state.
    wt.aheadBehind(w.repo, w.branch, w.base, w.baseSha).catch(async (err: Error) => { if (await wt.branchSha(w.repo, w.branch)) throw err; return undefined; }),
    wt.diffStat(w).catch((err: Error) => err),
    mergedAt(w),
    wt.branchTips(w.repo).catch(() => new Map<string, string>()),
  ]);
  // A missing worktree with no branch has nothing to diff.
  if (stat instanceof Error && (counts || !missing)) throw stat;
  const { additions, deletions, dirty } = stat instanceof Error ? { additions: 0, deletions: 0, dirty: 0 } : stat;
  const rt = m.runtimes.get(id);
  if (!rt || m.stopped) return; // closed or shut down meanwhile
  // Merging base can conflict only when both sides have commits; the answer holds until a tip moves.
  const key = tipKey(w, tips), last = tipsSeen.get(rt);
  const conflicts = last?.key === key ? last.conflicts : counts?.ahead && counts.behind ? await baseConflicts(w, key) : [];
  if (m.runtimes.get(id) !== rt || m.stopped) return;
  tipsSeen.set(rt, { key, conflicts });
  if (missing) setMissing(m, id, true); // only resume and the worktree sweep clear it: they also check `git worktree list`
  const lines = counts ? { ...counts, additions, deletions } : { ahead: 0, behind: 0, additions: 0, deletions: 0 };
  const next: GitState = { branch: w.branch, base: w.base, ...lines, dirty, ...(merged ? { mergedAt: merged } : {}), ...(conflicts.length ? { conflicts } : {}) };
  if (JSON.stringify(next) === JSON.stringify(rt.git)) return;
  rt.git = next;
  m.emitNode(id);
}

/** Per node runtime: the base and branch tips its last refresh saw, and the files merging that base would conflict in. */
const tipsSeen = new WeakMap<object, { key: string; conflicts: string[] }>();
const tipKey = (w: Worktree, tips: Map<string, string>) => `${tips.get(w.base) ?? w.baseSha} ${tips.get(w.branch) ?? ''}`;

/** The files that would conflict if base were merged into the branch (git merge-tree; nothing is touched). A failure (git older than 2.38) is logged and counts as none. */
async function baseConflicts(w: Worktree, key: string): Promise<string[]> {
  const [base, tip] = key.split(' ') as [string, string];
  return wt.mergeTree(w.repo, tip, base).then((r) => r.conflicts, (err: Error) => { logError(err); return []; });
}

/**
 * Refresh every worktree node whose base or branch tip moved since its last refresh, with one git call per repo. Hook
 * events refresh a node as it works; this catches a base that moves under an idle or exited node, or a branch moved
 * from outside (tl carry, a manual merge). The daemon's periodic sweep runs it.
 */
export async function refreshMovedTips(m: NodeManager): Promise<void> {
  const byRepo = new Map<string, { id: string; rt: object; w: Worktree }[]>();
  for (const [id, rt] of m.runtimes) {
    const w = m.registry.get(id)?.worktree;
    if (w && !w.missing && tipsSeen.has(rt)) byRepo.set(w.repo, [...(byRepo.get(w.repo) ?? []), { id, rt, w }]);
  }
  for (const [repo, nodes] of byRepo) {
    const tips = await wt.branchTips(repo).catch(() => undefined); // the repo is gone: nothing to compare
    for (const { id, rt, w } of tips ? nodes : []) {
      if (tipsSeen.get(rt)!.key !== tipKey(w, tips!)) refreshGit(m, id).catch(logError);
    }
  }
}

export function refreshGitSoon(m: NodeManager, id: string): void {
  const rt = m.runtimes.get(id)!;
  clearTimeout(rt.gitTimer);
  rt.gitTimer = setTimeout(() => { rt.gitTimer = undefined; refreshGit(m, id).catch(logError); }, GIT_DEBOUNCE_MS);
  rt.gitTimer.unref();
}

/** When the node's branch was last merged, if it has not moved since. */
async function mergedAt(w: Worktree): Promise<number | undefined> {
  return w.merged && ((await wt.branchSha(w.repo, w.branch)) ?? '') === w.merged.tip ? w.merged.at : undefined;
}

/** The configured setup or teardown commands for a repo, or none unless `tl trust` or some Claude home trusts it. */
export function worktreeCommands(m: NodeManager, repo: string, kind: 'setup' | 'teardown'): string[] {
  const cmds = loadConfig(repo, m.home).worktrees[kind];
  return cmds.length && commandsTrusted(m.home, repo) ? cmds : [];
}

/** Whether repo shell commands (worktree setup/teardown, the completion gate) may run in `dir`: `tl trust` or some Claude home trusts it. */
export const commandsTrusted = (home: string, dir: string): boolean => tillerTrusts(home, dir) || claudeTrustsAny(home, dir);

export function worktreeEnv(m: NodeManager, id: string, w: Pick<Worktree, 'repo' | 'path' | 'base'>): Record<string, string> {
  return buildChildEnv({ PATH: m.path, TL_NODE_ID: id, TL_WORKTREE: w.path, TL_REPO: w.repo, TL_BASE: w.base });
}

/**
 * Run the worktree setup commands in the background, each shown as the node's activity, then launch with `prompt`. A
 * failure leaves the node exited and errored, pointing at setup.log; restart runs the setup again.
 */
export function setupThenLaunch(m: NodeManager, id: string, w: Worktree, cmds: string[], prompt: string | undefined): void {
  const rt = m.runtimes.get(id)!;
  const abort = new AbortController();
  const log = join(m.nodeDir(id), 'setup.log');
  const show = (patch: Partial<NodeStatus>, notify = false) => m.setStatus(id, { ...rt.status!, ...patch, changedAt: Date.now() }, notify);
  rt.needsSetup = { prompt };
  const done = wt.runCommands(cmds, {
    cwd: w.path, env: worktreeEnv(m, id, w), log, timeout: SETUP_TIMEOUT_MS, signal: abort.signal,
    onStart: (cmd) => show({ state: 'unknown', activity: `setting up worktree: ${cmd}` }),
  }).then(() => {
    if (abort.signal.aborted || !m.registry.get(id)) return;
    rt.needsSetup = undefined;
    rt.status = { state: initialState(m.registry.get(id)!.kind), changedAt: Date.now() };
    m.launch(id, prompt, false);
    m.emitNode(id);
  }).catch((err: Error) => {
    if (abort.signal.aborted || !m.registry.get(id)) return; // closed or shut down meanwhile
    rt.starting = false; // no process ever started, so no exit frees its maxWorking slot
    show({ state: 'done', errored: true, exited: true, activity: `worktree setup failed: ${err.message}; see ${log}` }, true);
  }).finally(() => { rt.setup = undefined; });
  rt.setup = { abort, done };
}

/** Best effort: run the teardown commands in a worktree about to be removed. A failure is logged and never blocks removal. */
async function teardown(m: NodeManager, id: string, w: Pick<Worktree, 'repo' | 'path' | 'base'>): Promise<void> {
  if (!existsSync(w.path)) return;
  const dir = m.nodeDir(id);
  for (const cmd of worktreeCommands(m, w.repo, 'teardown')) {
    await wt.runCommands([cmd], { cwd: w.path, env: worktreeEnv(m, id, w), log: existsSync(dir) ? join(dir, 'setup.log') : undefined, timeout: SETUP_TIMEOUT_MS }).catch(logError);
  }
}

function knownRepos(m: NodeManager): string[] {
  try {
    const v: unknown = JSON.parse(readFileSync(join(m.home, REPOS_FILE), 'utf8'));
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  } catch { return []; }
}

function rememberRepo(m: NodeManager, repo: string): void {
  const repos = knownRepos(m);
  if (!repos.includes(repo)) writeFileSync(join(m.home, REPOS_FILE), JSON.stringify([...repos, repo], null, 2));
}
