// Source-checkout updater. Release discovery never follows main or changes remote configuration.
import { execFile, execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, linkSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { createHash, randomUUID } from 'node:crypto';
import type { InstalledReleaseNotes, ReleaseUpdate, UpdateStatus } from '../shared/protocol.js';
import { pidAlive } from './util.js';

export const REPO = fileURLToPath(new URL('../..', import.meta.url));
export const UPDATE_LOG = 'update.log';
export const UPDATE_LOCK = 'update.lock';
export const UPDATE_CHECK_INTERVAL = 2 * 60_000;
const exec = promisify(execFile);
const git = async (repo: string, ...args: string[]) => (await exec('git', args, {
  cwd: repo, timeout: 60_000, maxBuffer: 8 * 1024 * 1024,
  env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_SSH_COMMAND: 'ssh -o BatchMode=yes' },
})).stdout.trim();
const tryGit = (repo: string, ...args: string[]) => git(repo, ...args).catch(() => undefined);
const version = (tag: string) => /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(tag)?.slice(1).map(BigInt);
export function compareVersions(a: string, b: string): number {
  const av = version(a), bv = version(b);
  if (!av || !bv) throw new Error('release tags must use vX.Y.Z');
  for (let i = 0; i < 3; i++) if (av[i] !== bv[i]) return av[i] > bv[i] ? 1 : -1;
  return 0;
}
/** Accept only unambiguous GitHub origins; never send an origin URL or credentials to another host. */
export function githubRepo(origin: string): string | undefined {
  const match = /^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([A-Za-z0-9_-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/.exec(origin);
  return match && !['.', '..'].includes(match[2]) ? `${match[1]}/${match[2]}` : undefined;
}
export interface PublishedRelease { id: number; tag: string; name: string; body: string; publishedAt: string }
export interface ReleaseSource {
  /** Local fixture transport for tests; production always validates Git's effective GitHub URL. */
  transport?: string;
  list(repo: string): Promise<PublishedRelease[]>;
  get(repo: string, id: number): Promise<PublishedRelease>;
}
function published(value: unknown): PublishedRelease | undefined {
  if (!value || typeof value !== 'object') return;
  const r = value as Record<string, unknown>;
  if (r.draft !== false || r.prerelease !== false || typeof r.published_at !== 'string' || !Number.isFinite(Date.parse(r.published_at))
    || typeof r.id !== 'number' || !Number.isSafeInteger(r.id) || r.id <= 0 || typeof r.tag_name !== 'string' || !version(r.tag_name)
    || (r.body !== null && typeof r.body !== 'string') || (r.name !== null && typeof r.name !== 'string')) return;
  return { id: r.id, tag: r.tag_name, name: (r.name as string) || r.tag_name, body: (r.body as string) || '', publishedAt: r.published_at };
}
/** Public REST API, deliberately unauthenticated: no local tokens are sent to GitHub. */
export function githubReleases(request: typeof fetch = fetch): ReleaseSource {
  const cache = new Map<string, { etag: string; value: unknown }>();
  let retryAt = 0;
  let rateFailures = 0;
  const json = async (path: string, conditional = false) => {
    if (Date.now() < retryAt) throw new Error('GitHub rate limit cooldown; try again later');
    const cached = conditional ? cache.get(path) : undefined;
    const r = await request(`https://api.github.com/repos/${path}`, {
      headers: { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', ...(cached ? { 'If-None-Match': cached.etag } : {}) },
      signal: AbortSignal.timeout(20_000), redirect: 'error',
    });
    const limited = r.status === 403 || r.status === 429;
    if (limited || r.headers.get('x-ratelimit-remaining') === '0') {
      const retry = r.headers.get('retry-after');
      const reset = Number(r.headers.get('x-ratelimit-reset')) * 1000;
      const after = retry === null ? 0 : /^\d+$/.test(retry) ? Date.now() + Number(retry) * 1000 : Date.parse(retry);
      retryAt = Math.max(Date.now() + (limited ? Math.min(6 * 3600_000, 60_000 * 2 ** Math.min(rateFailures++, 9)) : 0), reset || 0, after || 0);
    } else rateFailures = 0;
    if (r.status === 304 && cached) return cached.value;
    if (!r.ok) throw new Error(r.status === 403 || r.status === 429 ? 'GitHub rate limit or access denied; try again later' : `GitHub releases unavailable (HTTP ${r.status})`);
    const value: unknown = await r.json();
    if (conditional && r.headers.has('etag')) cache.set(path, { etag: r.headers.get('etag')!, value });
    else cache.delete(path);
    return value;
  };
  return {
    async list(repo) {
      const releases: PublishedRelease[] = [];
      for (let page = 1; page <= 10; page++) {
        const rows = await json(`${repo}/releases?per_page=100&page=${page}`, true);
        if (!Array.isArray(rows)) throw new Error('invalid GitHub releases response');
        releases.push(...rows.flatMap((r) => { const p = published(r); return p ? [p] : []; }));
        if (rows.length < 100) return releases;
      }
      throw new Error('release history exceeds 1000 entries; cannot safely roll up notes');
    },
    async get(repo, id) {
      const release = published(await json(`${repo}/releases/${id}`));
      if (!release || release.id !== id) throw new Error('release is no longer published and stable');
      return release;
    },
  };
}
const ancestor = async (repo: string, a: string, b: string) => (await tryGit(repo, 'merge-base', '--is-ancestor', a, b)) !== undefined;
async function safeCheckout(repo: string): Promise<{ reason: string; blocker?: UpdateStatus['blocker'] } | undefined> {
  if (await tryGit(repo, 'symbolic-ref', '--short', '-q', 'HEAD') !== 'main') return { reason: 'The primary checkout must be on main to update. Switch it to main, then check releases again.' };
  const operations = ['MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'rebase-merge', 'rebase-apply', 'BISECT_LOG'];
  // rev-parse prints one line per option, in order.
  const [common, dir, ...paths] = (await git(repo, 'rev-parse', '--git-common-dir', '--git-dir', ...operations.flatMap((name) => ['--git-path', name]))).split('\n');
  if (resolve(repo, common) !== resolve(repo, dir)) return { reason: 'updates require the primary checkout, not a linked worktree' };
  if (paths.length !== operations.length) throw new Error('unexpected git rev-parse output');
  if (paths.some((p) => existsSync(resolve(repo, p)))) return { reason: 'a git operation is in progress' };
  if (await git(repo, 'status', '--porcelain', '--untracked-files=all')) return { blocker: 'dirty', reason: 'The main checkout is not clean: it contains uncommitted or untracked files. Move or stash those changes (including untracked files), then check releases again.' };
}
async function remoteTag(repo: string, origin: string, tag: string): Promise<string> {
  const refs = await git(repo, 'ls-remote', '--exit-code', '--refs', origin, `refs/tags/${tag}`);
  const [sha, ref] = refs.split(/\s+/);
  if (!/^[a-f0-9]{40,64}$/.test(sha) || ref !== `refs/tags/${tag}`) throw new Error(`cannot resolve released tag ${tag}`);
  return sha;
}
async function resolveRelease(repo: string, origin: string, release: PublishedRelease): Promise<ReleaseUpdate> {
  if (!version(release.tag)) throw new Error('invalid release tag');
  const tagObject = await remoteTag(repo, origin, release.tag);
  const ref = `refs/tiller/update/${randomUUID()}`;
  try {
    await git(repo, 'fetch', '--quiet', '--no-tags', '--no-write-fetch-head', origin, `refs/tags/${release.tag}:${ref}`);
    if (await git(repo, 'rev-parse', ref) !== tagObject) throw new Error(`released tag ${release.tag} moved during fetch; check again`);
    const sha = await git(repo, 'rev-parse', `${ref}^{commit}`);
    return { ...release, sha, tagObject };
  } finally { await tryGit(repo, 'update-ref', '-d', ref); }
}
async function releaseTransport(repo: string, origin: string, repository: string, source?: ReleaseSource): Promise<string> {
  if (source?.transport) return source.transport;
  const effective = await git(repo, 'remote', 'get-url', 'origin');
  if (githubRepo(effective)?.toLowerCase() !== repository.toLowerCase()) throw new Error('effective origin transport does not match the GitHub release repository');
  // Feed Git the original URL so it applies exactly the one rewrite validated above.
  return origin;
}
/** The releases resolved against one checkout HEAD: the part of a check that fetches tags. */
interface ResolvedHistory {
  target: ReleaseUpdate; releases: ReleaseUpdate[]; currentVersion?: string; installedNotes?: InstalledReleaseNotes;
  /** HEAD is an ancestor of the target. */
  fastForward: boolean;
  /** False when the installed notes could not be resolved, so a later check must try again. */
  complete: boolean;
}
/**
 * One check's history, kept for the next: a check that finds the same HEAD, origin, transport, published releases and
 * notes baseline reuses it instead of fetching every tag again. The checkout state and lock are always read afresh.
 */
export interface CheckMemo { key?: string; history?: ResolvedHistory }
async function resolveHistory(repo: string, transport: string, repository: string, rows: PublishedRelease[], sha: string, notesSince?: string): Promise<ResolvedHistory> {
  const target = await resolveRelease(repo, transport, rows[0]);
  const releases: ReleaseUpdate[] = [];
  let currentVersion: string | undefined;
  let currentRelease: ReleaseUpdate | undefined;
  for (const row of rows) {
    const r = row.id === target.id ? target : await resolveRelease(repo, transport, row);
    if (await ancestor(repo, r.sha, sha)) { currentVersion = r.tag; currentRelease = r; break; }
    if (!(await ancestor(repo, r.sha, target.sha))) throw new Error(`${r.tag} is not in the latest release history`);
    releases.push(r);
  }
  // An ancestor tag describes development ancestry, not an installed release.
  // Only an exact runtime checkout can produce post-install notes.
  let installedNotes: InstalledReleaseNotes | undefined;
  let complete = true;
  try {
    if (notesSince && notesSince !== sha && await ancestor(repo, notesSince, sha)) {
      const pinned = currentRelease;
      if (pinned?.sha === sha) {
        const missed: ReleaseUpdate[] = [];
        for (const row of rows.filter((r) => compareVersions(r.tag, pinned.tag) <= 0)) {
          const r = row.id === pinned.id ? pinned : await resolveRelease(repo, transport, row);
          if (await ancestor(repo, r.sha, notesSince)) break;
          if (!(await ancestor(repo, r.sha, sha))) throw new Error(`${r.tag} is not in the installed release history`);
          missed.push(r);
        }
        installedNotes = { identity: createHash('sha256').update(JSON.stringify([repository, missed])).digest('hex'), releases: missed };
      }
    }
  } catch { complete = false; /* Incomplete installed history waits for a later check; future update validation is independent. */ }
  return { target, releases, currentVersion, installedNotes, fastForward: await ancestor(repo, sha, target.sha), complete };
}
/** `common` is the checkout's Git common directory when the caller already knows it. */
export async function checkUpdate(repo: string, source: ReleaseSource = githubReleases(), notesSince?: string, o: { memo?: CheckMemo; common?: string } = {}): Promise<UpdateStatus> {
  const sha = await tryGit(repo, 'rev-parse', 'HEAD') ?? '';
  const base: UpdateStatus = { sha, checkedAt: Date.now(), eligible: false, releases: [] };
  try {
    const origin = await git(repo, 'config', '--get', 'remote.origin.url');
    const repository = githubRepo(origin);
    if (!repository) return { ...base, reason: 'origin must identify a GitHub repository (HTTPS or git SSH)' };
    const transport = await releaseTransport(repo, origin, repository, source);
    const rows = (await source.list(repository)).sort((a, b) => compareVersions(b.tag, a.tag));
    if (!rows.length) return { ...base, reason: 'no published stable releases' };
    if (new Set(rows.map((r) => r.tag)).size !== rows.length) throw new Error('duplicate release tags');
    const key = JSON.stringify([sha, origin, transport, rows, notesSince]);
    let history = o.memo?.key === key ? o.memo.history : undefined;
    if (!history) {
      history = await resolveHistory(repo, transport, repository, rows, sha, notesSince);
      if (o.memo) { o.memo.key = history.complete ? key : undefined; o.memo.history = history; }
    }
    const { target, releases, currentVersion, installedNotes, fastForward } = history;
    const checkout = await safeCheckout(repo);
    const holder = lockFileHolder(resolve(repo, o.common ?? await git(repo, 'rev-parse', '--git-common-dir'), UPDATE_LOCK));
    const reason = checkout?.reason
      ?? (holder?.stale ? `an interrupted update (pid ${holder.pid}, no longer running) left ${holder.path}; inspect update.log and the checkout, then remove the lock` : undefined)
      ?? (!fastForward ? 'local or unreleased commits; latest release cannot fast-forward this checkout' : undefined)
      ?? (currentVersion && compareVersions(target.tag, currentVersion) < 0 ? 'latest release would downgrade this checkout' : undefined);
    return { ...base, repository, origin, target, currentVersion, releases, installedNotes, eligible: !reason, reason, blocker: checkout?.blocker };
  } catch (e) { return { ...base, reason: 'release check unavailable; try again later', fetchError: (e as Error).message }; }
}
export function updateLine(s: UpdateStatus): string {
  const runtimeBehind = !!s.runtimeSha && s.runtimeSha !== s.sha;
  const head = s.fetchError ? `${s.reason}: ${s.fetchError}` : !s.target ? s.reason : runtimeBehind && s.sha === s.target.sha
    ? `checkout at ${s.target.tag}; daemon is running older code (${s.runtimeSha?.slice(0, 7)})` : s.sha === s.target.sha
    ? `up to date at ${s.target.tag}` : `${s.target.tag} available (${s.target.sha.slice(0, 7)})${s.reason ? `; cannot update: ${s.reason}` : ''}`;
  return [head, ...s.releases.map((r) => `\n${r.tag} — ${r.name}\n${r.body || 'No release notes provided.'}`)].join('\n');
}
export function planSteps(changed: string[], appBuilt: boolean) {
  const install = changed.some((p) => /^package(-lock)?\.json$/.test(p));
  return { install, ui: install || changed.some((p) => /^(ui|src\/shared)\//.test(p)), app: appBuilt && changed.some((p) => /^src-tauri\//.test(p)) };
}
export async function applyUpdate(o: { repo: string; log: string; expected: UpdateStatus; restart?: (sha: string) => Promise<void>; source?: ReleaseSource; env?: NodeJS.ProcessEnv }): Promise<void> {
  // The git-common-dir lock excludes different daemons/TL_HOMEs using the same checkout.
  const lock = resolve(o.repo, await git(o.repo, 'rev-parse', '--git-common-dir'), UPDATE_LOCK);
  try { writeFileSync(lock, JSON.stringify({ pid: process.pid, sha: o.expected.sha }), { flag: 'wx' }); }
  catch { throw new Error(`another or interrupted update holds ${lock}; inspect ${o.log} before removing the lock`); }
  const say = (s: string) => appendFileSync(o.log, `${new Date().toISOString()} tl update: ${s}\n`);
  const started: string[][] = [];
  let moved = false;
  let restartAttempted = false;
  const run = async (cmd: string, args: string[], timeout = 60_000) => {
    say(`running ${cmd} ${args.join(' ')}`);
    const env = o.env ?? process.env;
    // Homebrew rustup is keg-only; match bin/tl-app for forward and rollback app builds.
    const runEnv = cmd === 'npm' && args[0] === 'run' && args[1] === 'app:build'
      ? { ...env, PATH: `/opt/homebrew/opt/rustup/bin:${env.PATH ?? ''}` } : env;
    try { const r = await exec(cmd, args, { cwd: o.repo, env: runEnv, timeout, maxBuffer: 16 * 1024 * 1024 }); say(r.stdout + r.stderr); }
    catch (e) { const err = e as Error & { stdout?: string; stderr?: string }; say((err.stdout ?? '') + (err.stderr ?? '')); throw new Error(`${cmd} ${args.join(' ')} failed: ${err.message}`); }
  };
  try {
    const runtimeSha = o.expected.runtimeSha;
    const s = await checkUpdate(o.repo, o.source);
    const target = o.expected.target;
    if (!target || !s.target || !s.eligible || s.sha !== o.expected.sha || s.origin !== o.expected.origin
      || s.target.id !== target.id || s.target.tag !== target.tag || s.target.sha !== target.sha || s.target.tagObject !== target.tagObject || JSON.stringify(s.releases) !== JSON.stringify(o.expected.releases))
      throw new Error(`release or checkout changed; check again${s.reason ? `: ${s.reason}` : ''}`);
    const restartOnly = s.sha === target.sha && !!runtimeSha && runtimeSha !== target.sha;
    if (s.sha === target.sha && !restartOnly) throw new Error('already at the latest release');
    const publishedNow = await (o.source ?? githubReleases()).get(s.repository!, target.id);
    if (JSON.stringify(publishedNow) !== JSON.stringify({ id: target.id, tag: target.tag, name: target.name, body: target.body, publishedAt: target.publishedAt }))
      throw new Error('release changed; review its notes again');
    if (await remoteTag(o.repo, await releaseTransport(o.repo, s.origin!, s.repository!, o.source), target.tag) !== target.tagObject) throw new Error('released tag moved; check again');
    if (await safeCheckout(o.repo) || await git(o.repo, 'rev-parse', 'HEAD') !== s.sha) throw new Error('checkout changed; check again');
    const appBuilt = existsSync(join(o.repo, 'src-tauri/target/release/bundle/macos/Tiller.app'));
    const runtimeDiffers = !!runtimeSha && runtimeSha !== s.sha;
    const changed = (await git(o.repo, 'diff', '--name-only', runtimeDiffers ? runtimeSha : s.sha, target.sha)).split('\n');
    const plan = restartOnly ? { install: true, ui: true, app: appBuilt } : planSteps(changed, appBuilt);
    if (!restartOnly) {
      await run('git', ['merge', '--ff-only', '--no-edit', '--no-overwrite-ignore', target.sha]);
      moved = true;
    }
    for (const [needed, args] of [[plan.install, ['ci']], [plan.ui, ['run', 'ui:build']], [plan.app, ['run', 'app:build']]] as const) {
      if (needed) { started.push([...args]); await run('npm', [...args], 30 * 60_000); }
    }
    if (await git(o.repo, 'rev-parse', 'HEAD') !== target.sha || await safeCheckout(o.repo)) throw new Error('checkout changed during build; refusing restart');
    if (o.restart) { restartAttempted = true; await o.restart(target.sha); }
    say(`updated to ${target.tag} at ${target.sha}`);
  } catch (e) {
    if (moved || (restartAttempted && !!o.expected.runtimeSha && o.expected.runtimeSha !== o.expected.target?.sha)) {
      try {
        // --keep refuses to discard edits made during a build. Never reset a checkout someone moved.
        if (await git(o.repo, 'rev-parse', 'HEAD') !== o.expected.target!.sha || await tryGit(o.repo, 'symbolic-ref', '--short', '-q', 'HEAD') !== 'main') throw new Error('HEAD or branch changed during update');
        if (moved) await run('git', ['reset', '--keep', o.expected.sha]);
        for (const args of started) await run('npm', args, 30 * 60_000);
        if (restartAttempted && o.restart) await o.restart(moved ? o.expected.sha : o.expected.target!.sha);
      } catch (rollback) { throw new Error(`${(e as Error).message}; rollback incomplete: ${(rollback as Error).message}; see ${o.log}`); }
    }
    say((e as Error).message);
    throw e;
  } finally { rmSync(lock); }
}

/** Explicit reload must not race an updater changing this checkout. Stale locks require human inspection. */
export function updateLocked(repo: string): boolean {
  return !!lockHolder(repo);
}
export interface LockHolder { path: string; pid?: number; stale: boolean }
/**
 * The lock is in this checkout's Git directory, so its holder ran on this host and its pid can be probed here.
 * Only a holder proven gone is stale. Nothing here removes the lock, so `wx` creation stays the only way to take it.
 */
function lockHolder(repo: string): LockHolder | undefined {
  const common = execFileSync('git', ['rev-parse', '--git-common-dir'], { cwd: repo, encoding: 'utf8' }).trim();
  return lockFileHolder(resolve(repo, common, UPDATE_LOCK));
}
export function lockFileHolder(path: string): LockHolder | undefined {
  let pid: unknown;
  try { pid = JSON.parse(readFileSync(path, 'utf8')).pid; }
  catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    // `wx` creates the file before the pid is written, so unreadable contents may belong to a live helper.
    return { path, stale: false };
  }
  if (typeof pid !== 'number' || !Number.isSafeInteger(pid) || pid <= 0) return { path, stale: false };
  return { path, pid, stale: !pidAlive(pid) };
}

export const UPDATE_NOTES = 'update-notes.json';
interface NotesState { repository: string; baselineSha: string; unread?: InstalledReleaseNotes }
const commitSha = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{40,64}$/.test(v);
function readNotes(path: string, repository: string, runtimeSha: string): NotesState {
  try {
    const s = JSON.parse(readFileSync(path, 'utf8')) as NotesState;
    const n = s.unread;
    if (s.repository !== repository || !commitSha(s.baselineSha)) throw new Error('invalid notes baseline');
    if (n && (typeof n.identity !== 'string' || !/^[a-f0-9]{64}$/.test(n.identity) || !Array.isArray(n.releases) || !n.releases.length
      || n.releases.some((r) => !r || !Number.isSafeInteger(r.id) || r.id <= 0 || typeof r.tag !== 'string' || !version(r.tag)
        || !commitSha(r.sha) || !commitSha(r.tagObject) || typeof r.name !== 'string' || typeof r.body !== 'string'
        || typeof r.publishedAt !== 'string' || !Number.isFinite(Date.parse(r.publishedAt)))
      || n.identity !== createHash('sha256').update(JSON.stringify([repository, n.releases])).digest('hex'))) throw new Error('invalid cached notes');
    return s;
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code && code !== 'ENOENT') throw e;
    return { repository, baselineSha: runtimeSha };
  }
}
function writeNotes(path: string, state: NotesState, initial = false) {
  const temp = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temp, JSON.stringify(state), { mode: 0o600 });
    if (initial) {
      try { linkSync(temp, path); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e; }
    } else renameSync(temp, path);
  }
  finally { rmSync(temp, { force: true }); }
}

/** Only notes transactions use this lock; never hold it across Git or network work. */
async function notesTransaction<T>(path: string, change: () => T): Promise<T> {
  const lock = `${path}.lock`;
  for (let attempt = 0; ; attempt++) {
    try { writeFileSync(lock, String(process.pid), { flag: 'wx', mode: 0o600 }); break; }
    catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      if (attempt === 50) throw new Error(`release notes state busy; inspect ${lock} before removing an interrupted notes lock`);
      await delay(20);
    }
  }
  try { return change(); } finally { rmSync(lock); }
}

/** The Git operations the updater needs; tests substitute an in-memory release history. */
export interface UpdaterCheckout {
  /** HEAD when the updater started, or '' outside a Git checkout. */
  head: string;
  /** The GitHub repository named by origin, or '' without one. */
  repository: string;
  /** `reuse` lets an unchanged release list and HEAD skip fetching the release tags again; see CheckMemo. */
  check(source: ReleaseSource, notesSince?: string, reuse?: boolean): Promise<UpdateStatus>;
  isAncestor(a: string, b: string): Promise<boolean>;
  lockHolder(): LockHolder | undefined;
}
export function gitCheckout(repo: string): UpdaterCheckout {
  const read = (...args: string[]) => execFileSync('git', args, { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  let head = '';
  try { head = read('rev-parse', 'HEAD'); } catch { /* No checkout: release checks stay unavailable. */ }
  let repository = '';
  try { repository = githubRepo(read('config', '--get', 'remote.origin.url')) ?? ''; } catch { /* No origin: release discovery remains unavailable. */ }
  let common: string | undefined;
  try { common = resolve(repo, read('rev-parse', '--git-common-dir')); } catch { /* No checkout: lockHolder looks again and throws. */ }
  let memo: CheckMemo = {};
  return {
    head, repository,
    // A full check starts a new memo, so it never serves what an earlier check resolved.
    check: (source, notesSince, reuse) => checkUpdate(repo, source, notesSince, { memo: reuse ? memo : (memo = {}), common }),
    isAncestor: (a, b) => ancestor(repo, a, b),
    lockHolder: () => common ? lockFileHolder(resolve(common, UPDATE_LOCK)) : lockHolder(repo),
  };
}

export function createUpdater(o: { repo: string; home: string; onChange(s: UpdateStatus): void; spawnHelper: (expected: UpdateStatus, onExit: (code: number | null) => void, now?: boolean) => string; source?: ReleaseSource; checkout?: UpdaterCheckout }) {
  // Keep conditional-response validators and rate-limit cooldown across checks.
  const source = o.source ?? githubReleases();
  const checkout = o.checkout ?? gitCheckout(o.repo);
  const { head: runtimeSha, repository } = checkout;
  const unavailable = runtimeSha ? undefined : 'release checks unavailable: Tiller is not running from a git checkout';
  const notesPath = join(o.home, UPDATE_NOTES);
  let notes = readNotes(notesPath, repository, runtimeSha);
  // Establish the first-observation baseline before any network request, including offline starts.
  if (runtimeSha) {
    writeNotes(notesPath, notes, true);
    notes = readNotes(notesPath, repository, runtimeSha);
  }
  const unread = () => notes.unread?.releases[0]?.sha === runtimeSha ? notes.unread : undefined;
  let status: UpdateStatus = { installedNotes: unread(), runtimeSha, sha: runtimeSha, checkedAt: 0, checking: false, eligible: false, releases: [], reason: unavailable ?? 'not checked yet' };
  let checking: Promise<UpdateStatus> | undefined;
  let applying = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let active = false;
  let nextCheckAt = 0;
  let failures = 0;
  const schedule = () => {
    if (timer) clearTimeout(timer);
    timer = undefined;
    if (!active || checking) return;
    timer = setTimeout(poll, Math.max(0, nextCheckAt - Date.now()));
    timer.unref();
  };
  const poll = () => {
    timer = undefined;
    // A helper (possibly another daemon's) owns Git while applying an update. One that exited without
    // unlocking does not: check anyway, and the check reports the interrupted update.
    let holder: LockHolder | undefined;
    try { holder = checkout.lockHolder(); } catch { /* Let check report an unavailable checkout. */ }
    const live = holder && !holder.stale ? holder : undefined;
    if (applying || live) {
      nextCheckAt = Date.now() + UPDATE_CHECK_INTERVAL;
      // Say why discovery paused rather than keeping "not checked yet" or a result that invites a doomed apply.
      if (live && !applying) set({ ...status, eligible: false, blocker: undefined, reason: `another update${live.pid ? ` (pid ${live.pid})` : ''} holds ${live.path}; release checks resume after it finishes` });
      schedule(); return;
    }
    void check(true).catch(() => { /* check publishes a recoverable failure and schedules a retry. */ });
  };
  const set = (s: UpdateStatus) => { status = { ...s, installedNotes: unread(), runtimeSha, checking: !!checking, applying }; o.onChange(status); return status; };
  /** `reuse`: an automatic poll, which may skip resolving an unchanged release history again. Others check in full. */
  const check = (reuse = false) => {
    if (checking) return checking;
    if (applying || unavailable) return Promise.resolve(status);
    const perform = async () => {
      notes = readNotes(notesPath, repository, runtimeSha);
      const observed = JSON.stringify(notes);
      const previousInstalled = notes.unread?.releases[0].sha;
      const s = await checkout.check(source, notes.baselineSha, reuse);
      const canAdvance = !previousInstalled || await checkout.isAncestor(previousInstalled, runtimeSha);
      notes = await notesTransaction(notesPath, () => {
        const current = readNotes(notesPath, repository, runtimeSha);
        // Another daemon may have acknowledged or discovered newer notes during this check.
        if (JSON.stringify(current) !== observed) return current;
        const next = canAdvance && s.repository === repository && s.sha === runtimeSha && s.installedNotes
          ? { ...current, unread: s.installedNotes } : current;
        writeNotes(notesPath, next);
        return next;
      });
      return s;
    };
    checking = Promise.resolve().then(perform).catch((e: unknown): UpdateStatus => ({ ...status, checkedAt: Date.now(), eligible: false, blocker: undefined, reason: 'release check unavailable; try again later', fetchError: e instanceof Error ? e.message : String(e) })).then((s) => {
      failures = s.fetchError ? failures + 1 : 0;
      nextCheckAt = Date.now() + (failures ? Math.min(6 * 3600_000, 10 * 60_000 * 2 ** Math.min(failures, 6)) : UPDATE_CHECK_INTERVAL);
      checking = undefined;
      return set(s);
    }).finally(schedule);
    // Assign the shared promise before broadcasting so concurrent callers join it.
    set({ ...status, eligible: false, blocker: undefined });
    schedule();
    return checking;
  };
  return {
    status: () => {
      try { notes = readNotes(notesPath, repository, runtimeSha); } catch { /* Retain proven state on an unreadable file. */ }
      return status = { ...status, installedNotes: unread() };
    }, check: () => check(),
    async acknowledgeNotes(identity: string) {
      notes = await notesTransaction(notesPath, () => {
        const current = readNotes(notesPath, repository, runtimeSha);
        if (current.unread?.identity !== identity || current.unread.releases[0].sha !== runtimeSha) return current;
        const next: NotesState = { repository, baselineSha: runtimeSha };
        writeNotes(notesPath, next);
        return next;
      });
      set(status);
    },
    // Called for authenticated app/browser connections; reconnects keep the shared freshness budget.
    start() { if (!active) { active = true; schedule(); } },
    stop() { active = false; if (timer) clearTimeout(timer); timer = undefined; },
    /** `now` restarts without waiting for agents to finish their turns. */
    async apply(expected: { tag: string; sha: string; now?: boolean }) {
      // Finish discovery before handing Git to the detached install helper.
      if (checking) await checking;
      if (applying) throw new Error('an update is already running');
      if (unavailable) throw new Error(`cannot update: ${unavailable}`);
      if (!status.target || expected.tag !== status.target.tag || expected.sha !== status.target.sha) throw new Error('release changed; check and review again');
      if (!status.eligible) throw new Error(`cannot update: ${status.reason}`);
      if (status.sha === status.target.sha && (!status.runtimeSha || status.runtimeSha === status.target.sha)) throw new Error('already at the latest release');
      const approved = status;
      applying = true; set(status);
      const log = join(o.home, UPDATE_LOG);
      try {
        o.spawnHelper(approved, (code) => {
          applying = false;
          if (code !== 0) set({ ...status, failed: `update helper failed or was interrupted; see ${log}` });
          else void check();
        }, expected.now);
        return { log, status };
      } catch (e) { applying = false; set({ ...status, failed: (e as Error).message }); throw e; }
    },
  };
}
export type Updater = ReturnType<typeof createUpdater>;
