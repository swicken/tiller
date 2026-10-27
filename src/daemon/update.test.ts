import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReleaseUpdate, UpdateStatus } from '../shared/protocol.js';
import { applyUpdate, checkUpdate, compareVersions, createUpdater, gitCheckout, githubReleases, githubRepo, lockFileHolder, updateLine, UPDATE_CHECK_INTERVAL, type PublishedRelease, type ReleaseSource, type Updater } from './update.js';
const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'commit.gpgsign=false', ...args], {
  cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.com', GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.com' },
}).trim();
let dir: string, seed: string, work: string, rows: PublishedRelease[], source: ReleaseSource;
let template: string | undefined, initialRows: PublishedRelease[];
const commit = (path: string, text = path) => { writeFileSync(join(seed, path), text); git(seed, 'add', path); git(seed, 'commit', '-qm', text); };
const publish = (tag: string) => {
  const r = { id: rows.length + 1, tag, name: tag, body: `Notes for ${tag}`, publishedAt: '2026-10-17T00:00:00Z' }; rows.push(r); return r;
};
const release = (tag: string) => {
  git(seed, 'tag', tag); git(seed, 'push', '-q', 'origin', 'main', '--tags');
  return publish(tag);
};
/** Put a fake npm running `script` first on PATH; returns the env for applyUpdate. */
function fakeNpm(script: string) {
  const bin = join(dir, 'bin'); mkdirSync(bin);
  writeFileSync(join(bin, 'npm'), `#!/bin/sh\n${script}\n`); chmodSync(join(bin, 'npm'), 0o755);
  return { ...process.env, PATH: `${bin}:${process.env.PATH}` };
}
function setupCheckout() {
  if (!template) {
    dir = mkdtempSync(join(tmpdir(), 'tiller-release-test-'));
    git(dir, 'init', '-q', '--bare', '--initial-branch=main', 'origin.git');
    // No detached `git maintenance run --auto` after commit, push or fetch: its objects/maintenance.lock can vanish
    // mid-cpSync (ENOENT). Set in each repo's own config so receive-pack, the code under test and every copy inherit it.
    const noMaintenance = (repo: string) => git(repo, 'config', 'maintenance.auto', 'false');
    noMaintenance(join(dir, 'origin.git'));
    git(dir, 'clone', '-q', 'origin.git', 'seed'); seed = join(dir, 'seed'); noMaintenance(seed);
    rows = [];
    commit('README', 'first'); release('v0.1.0');
    git(dir, 'clone', '-q', 'origin.git', 'work'); work = join(dir, 'work'); noMaintenance(work);
    git(work, 'remote', 'set-url', 'origin', 'https://github.com/example/tiller.git');
    // Keep the seed's pushes inside each copy. The template has ordinary .git directories, no linked worktrees.
    git(seed, 'remote', 'set-url', 'origin', '../origin.git');
    template = dir;
    initialRows = rows;
  }
  dir = mkdtempSync(join(tmpdir(), 'tiller-release-test-'));
  // cpSync copies files rather than hard-linking writable Git state. Never run tests against the template.
  cpSync(template, dir, { recursive: true });
  seed = join(dir, 'seed'); work = join(dir, 'work');
  rows = structuredClone(initialRows);
  source = { transport: join(dir, 'origin.git'), list: async () => [...rows], get: async (_repo, id) => rows.find((r) => r.id === id)! };
}
/**
 * A linear in-memory release history for tests of updater state rather than Git. It mirrors checkUpdate's
 * results on a fast-forward-only main; the Git-backed suites cover checkUpdate itself.
 */
function setupFake() {
  dir = mkdtempSync(join(tmpdir(), 'tiller-release-test-'));
  rows = [];
  source = { list: async () => [...rows], get: async (_repo, id) => rows.find((r) => r.id === id)! };
  const history: string[] = [], tags = new Map<string, string>();
  const ancestor = (a: string, b: string) => history.includes(a) && history.indexOf(a) <= history.indexOf(b);
  const checkout = {
    head: '', repository: 'example/tiller',
    commit() { history.push(createHash('sha1').update(String(history.length)).digest('hex')); },
    release(tag: string) { tags.set(tag, history.at(-1)!); publish(tag); },
    install(tag: string) { checkout.commit(); checkout.release(tag); checkout.head = tags.get(tag)!; },
    isAncestor: async (a: string, b: string) => ancestor(a, b),
    lockHolder: () => lockFileHolder(join(dir, 'update.lock')),
    async check(source: ReleaseSource, notesSince?: string, _reuse?: boolean): Promise<UpdateStatus> {
      const sha = checkout.head, base: UpdateStatus = { sha, checkedAt: Date.now(), eligible: false, releases: [] };
      try {
        const published = (await source.list(checkout.repository)).sort((a, b) => compareVersions(b.tag, a.tag))
          .map((r): ReleaseUpdate => ({ ...r, sha: tags.get(r.tag)!, tagObject: tags.get(r.tag)! }));
        if (!published.length) return { ...base, reason: 'no published stable releases' };
        const [target] = published, current = published.find((r) => ancestor(r.sha, sha));
        const missed = current?.sha === sha && notesSince && notesSince !== sha && ancestor(notesSince, sha)
          ? published.filter((r) => compareVersions(r.tag, current.tag) <= 0 && !ancestor(r.sha, notesSince)) : undefined;
        const installedNotes = missed && { identity: createHash('sha256').update(JSON.stringify([checkout.repository, missed])).digest('hex'), releases: missed };
        const reason = ancestor(sha, target.sha) ? undefined : 'local or unreleased commits; latest release cannot fast-forward this checkout';
        return { ...base, repository: checkout.repository, target, currentVersion: current?.tag, releases: published.filter((r) => !ancestor(r.sha, sha)), installedNotes, eligible: !reason, reason };
      } catch (e) { return { ...base, reason: 'release check unavailable; try again later', fetchError: (e as Error).message }; }
    },
  };
  checkout.install('v0.1.0');
  return checkout;
}
// Fake only the scheduler; fixture Git subprocesses still run normally.
const fakeClock = () => vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
afterEach(() => { vi.useRealTimers(); });
afterAll(() => { if (template) rmSync(template, { recursive: true, force: true }); });

describe('published releases', () => {
  it('keeps legacy update status without runtimeSha from implying an older daemon', () => {
    const target = { id: 1, tag: 'v0.1.0', name: 'v0.1.0', body: '', publishedAt: '', sha: 'current', tagObject: 'tag' };
    expect(updateLine({ sha: 'current', checkedAt: 1, eligible: true, releases: [], target })).toBe('up to date at v0.1.0');
  });
  it('accepts only safe GitHub repository origins', () => {
    for (const url of ['https://github.com/a/b.git', 'git@github.com:a/b.git', 'ssh://git@github.com/a/b']) expect(githubRepo(url)).toBe('a/b');
    for (const url of ['https://github.com.evil/a/b', 'https://token@github.com/a/b', 'file:///a/b', 'https://github.com/a/b?x=1', 'https://github.com/a/..', 'git@evil:a/b']) expect(githubRepo(url)).toBeUndefined();
  });
  it('orders numeric semver without unsafe number conversion', () => {
    expect(compareVersions('v0.10.0', 'v0.9.99')).toBe(1);
    expect(compareVersions('v999999999999999999999.0.0', 'v2.0.0')).toBe(1);
    expect(() => compareVersions('v01.0.0', 'v1.0.0')).toThrow();
  });
  it('filters drafts, prereleases and invalid versions; handles rate limits and invalid responses', async () => {
    const row = { id: 1, tag_name: 'v0.1.0', name: null, body: 'notes', draft: false, prerelease: false, published_at: '2026-10-17T00:00:00Z' };
    const request = vi.fn(async () => new Response(JSON.stringify([row, { ...row, id: 2, draft: true }, { ...row, id: 3, prerelease: true }, { ...row, tag_name: 'main' }])));
    expect(await githubReleases(request as typeof fetch).list('a/b')).toEqual([{ id: 1, tag: 'v0.1.0', name: 'v0.1.0', body: 'notes', publishedAt: row.published_at }]);
    const limited = githubReleases((async () => new Response('', { status: 429 })) as typeof fetch);
    await expect(limited.list('a/b')).rejects.toThrow('rate limit');
    await expect(githubReleases((async () => new Response('{}')) as typeof fetch).list('a/b')).rejects.toThrow('invalid');
  });
});

describe('release checkout', () => {
  beforeEach(setupCheckout);
  afterEach(() => rmSync(dir, { recursive: true, force: true }));
  it('pins the latest release and rolls up missed notes without following unreleased main', async () => {
    commit('two'); release('v0.1.1'); commit('three'); release('v0.1.2');
    const target = git(seed, 'rev-parse', 'HEAD'); commit('unreleased'); git(seed, 'push', '-q', 'origin', 'main');
    const s = await checkUpdate(work, source);
    expect(s).toMatchObject({ eligible: true, currentVersion: 'v0.1.0', target: { tag: 'v0.1.2', sha: target } });
    expect(s.releases.map((r) => r.tag)).toEqual(['v0.1.2', 'v0.1.1']);
    const config = readFileSync(join(work, '.git/config'), 'utf8');
    await applyUpdate({ repo: work, log: join(dir, 'update.log'), expected: s, source });
    expect(git(work, 'rev-parse', 'HEAD')).toBe(target);
    expect(readFileSync(join(work, '.git/config'), 'utf8')).toBe(config);
    expect(git(work, 'status', '--porcelain')).toBe('');
  });
  it('checks releases without changing the checkout, dependency lock or user settings', async () => {
    commit('.gitignore', '.tiller/\n'); commit('package-lock.json', '{"lockfileVersion":3}\n'); release('v0.1.1');
    git(work, 'merge', '--ff-only', (await checkUpdate(work, source)).target!.sha);
    mkdirSync(join(work, '.tiller'));
    const settings = join(work, '.tiller/config.json');
    writeFileSync(settings, '{"roles":{"worker":{"model":"custom"}}}\n');
    const paths = ['package-lock.json', '.tiller/config.json', '.git/config'];
    const before = paths.map((p) => readFileSync(join(work, p), 'utf8'));
    const head = git(work, 'rev-parse', 'HEAD');
    commit('two'); release('v0.1.2');
    expect(await checkUpdate(work, source)).toMatchObject({ eligible: true, target: { tag: 'v0.1.2' } });
    expect(git(work, 'rev-parse', 'HEAD')).toBe(head);
    expect(git(work, 'status', '--porcelain')).toBe('');
    expect(paths.map((p) => readFileSync(join(work, p), 'utf8'))).toEqual(before);
    expect(existsSync(join(work, '.git/update.lock'))).toBe(false);
  });
  it('rebuilds and restarts a clean current-release checkout when the daemon runs older code', async () => {
    mkdirSync(join(seed, 'ui')); commit('ui/app', 'released'); release('v0.1.1');
    commit('README', 'documentation only'); release('v0.1.2');
    const target = git(seed, 'rev-parse', 'HEAD');
    const status = { ...await checkUpdate(work, source), runtimeSha: git(work, 'rev-parse', 'HEAD') };
    git(work, 'merge', '--ff-only', target);
    const current = { ...await checkUpdate(work, source), runtimeSha: status.runtimeSha };
    expect(current).toMatchObject({ eligible: true, sha: target, runtimeSha: status.runtimeSha, releases: [] });
    const calls = join(dir, 'calls'), env = fakeNpm(`echo "$*" >> '${calls}'`);
    const restart = vi.fn(async (sha: string) => expect(sha).toBe(target));
    await applyUpdate({ repo: work, log: join(dir, 'log'), expected: current, source, restart, env });
    expect(readFileSync(calls, 'utf8')).toContain('run ui:build');
    expect(restart).toHaveBeenCalledOnce();
    expect(git(work, 'rev-parse', 'HEAD')).toBe(target);
  });
  it('keeps an already-current source checkout and retries restart against that checkout after failure', async () => {
    mkdirSync(join(seed, 'ui')); commit('ui/app', 'runtime change'); release('v0.1.1');
    commit('README', 'later docs only'); release('v0.1.2');
    const target = git(seed, 'rev-parse', 'HEAD');
    const runtimeSha = git(work, 'rev-parse', 'HEAD');
    await checkUpdate(work, source);
    git(work, 'merge', '--ff-only', target);
    const current = { ...await checkUpdate(work, source), runtimeSha };
    const calls = join(dir, 'calls'), env = fakeNpm(`echo "$*" >> '${calls}'`);
    const restart = vi.fn(async (sha: string) => {
      expect(sha).toBe(target);
      if (restart.mock.calls.length === 1) throw new Error('temporary restart failure');
    });
    await expect(applyUpdate({ repo: work, log: join(dir, 'log'), expected: current, source, restart, env })).rejects.toThrow('temporary restart failure');
    expect(restart).toHaveBeenCalledTimes(2);
    expect(readFileSync(calls, 'utf8')).toContain('run ui:build');
    expect(git(work, 'rev-parse', 'HEAD')).toBe(target);
  });
  it('rebuilds changes from the running runtime through a newer source checkout to a docs-only latest release', async () => {
    mkdirSync(join(seed, 'ui')); commit('ui/app', 'runtime change'); release('v0.1.1');
    const checkout = git(seed, 'rev-parse', 'HEAD');
    commit('README', 'latest docs only'); release('v0.1.2');
    const target = git(seed, 'rev-parse', 'HEAD');
    const runtimeSha = git(work, 'rev-parse', 'HEAD');
    await checkUpdate(work, source);
    git(work, 'merge', '--ff-only', checkout);
    const expected = { ...await checkUpdate(work, source), runtimeSha };
    expect(expected.sha).toBe(checkout);
    const calls = join(dir, 'calls'), env = fakeNpm(`echo "$*" >> '${calls}'`);
    const restart = vi.fn(async (sha: string) => expect(sha).toBe(target));
    await applyUpdate({ repo: work, log: join(dir, 'log'), expected, source, restart, env });
    expect(readFileSync(calls, 'utf8')).toContain('run ui:build');
    expect(restart).toHaveBeenCalledOnce();
    expect(git(work, 'rev-parse', 'HEAD')).toBe(target);
  });
  it('preserves ignored local files when the release begins tracking their path', async () => {
    commit('.gitignore', 'private\n'); release('v0.1.1');
    git(work, 'merge', '--ff-only', (await checkUpdate(work, source)).target!.sha);
    writeFileSync(join(work, 'private'), 'keep my data');
    writeFileSync(join(seed, 'private'), 'release data'); git(seed, 'add', '-f', 'private'); git(seed, 'commit', '-qm', 'track private'); release('v0.1.2');
    const s = await checkUpdate(work, source);
    await expect(applyUpdate({ repo: work, log: join(dir, 'log'), expected: s, source })).rejects.toThrow('merge');
    expect(readFileSync(join(work, 'private'), 'utf8')).toBe('keep my data');
    expect(git(work, 'rev-parse', 'HEAD')).toBe(s.sha);
  });
  it('revalidates tags immediately before apply after the release API check', async () => {
    commit('two'); release('v0.1.1'); const s = await checkUpdate(work, source);
    const get = source.get;
    source.get = async (repository, id) => {
      commit('three'); git(seed, 'tag', '-f', 'v0.1.1'); git(seed, 'push', '-q', '--force', 'origin', 'v0.1.1');
      return get(repository, id);
    };
    await expect(applyUpdate({ repo: work, log: join(dir, 'log'), expected: s, source })).rejects.toThrow('released tag moved');
    expect(git(work, 'rev-parse', 'HEAD')).toBe(s.sha);
  });
  it('requires another review if a missed release body changes', async () => {
    commit('two'); const missed = release('v0.1.1'); commit('three'); release('v0.1.2');
    const s = await checkUpdate(work, source); missed.body = 'edited missed notes';
    await expect(applyUpdate({ repo: work, log: join(dir, 'log'), expected: s, source })).rejects.toThrow('release or checkout changed');
  });
  it('does not apply insteadOf twice when the first rewrite remains canonical', async () => {
    git(work, 'config', 'url.git@github.com:example/tiller.git.insteadOf', 'https://github.com/example/tiller.git');
    git(work, 'config', `url.${join(dir, 'origin.git')}.insteadOf`, 'git@github.com:example/tiller.git');
    git(work, 'config', 'protocol.ssh.allow', 'never'); // The regression must never contact a live provider.
    const s = await checkUpdate(work, { ...source, transport: undefined });
    expect(s.eligible).toBe(false);
    expect(s.target).toBeUndefined();
    expect(s.fetchError).toContain("transport 'ssh' not allowed");
  });
  it('rejects an effective origin rewritten to a different transport', async () => {
    git(work, 'config', `url.${join(dir, 'origin.git')}.insteadOf`, 'https://github.com/example/tiller.git');
    expect(await checkUpdate(work, { ...source, transport: undefined })).toMatchObject({ eligible: false, fetchError: 'effective origin transport does not match the GitHub release repository' });
  });
  it('never falls back when no releases or offline', async () => {
    expect(await checkUpdate(work, { ...source, list: async () => [] })).toMatchObject({ eligible: false, reason: 'no published stable releases' });
    expect(await checkUpdate(work, { ...source, list: async () => { throw new Error('offline'); } })).toMatchObject({ eligible: false, fetchError: 'offline' });
  });
  it('blocks dirty, untracked, local commits, detached and linked worktrees', async () => {
    commit('two'); release('v0.1.1');
    writeFileSync(join(work, 'local'), 'keep'); expect(await checkUpdate(work, source)).toMatchObject({ eligible: false, blocker: 'dirty', reason: expect.stringContaining('main checkout is not clean') }); rmSync(join(work, 'local'));
    writeFileSync(join(work, 'README'), 'keep'); expect(await checkUpdate(work, source)).toMatchObject({ eligible: false, blocker: 'dirty', reason: expect.stringContaining('uncommitted or untracked files. Move or stash') }); git(work, 'checkout', '--', 'README');
    git(work, 'commit', '--allow-empty', '-qm', 'local'); expect((await checkUpdate(work, source)).reason).toContain('local or unreleased');
    git(work, 'checkout', '--detach', '-q'); expect((await checkUpdate(work, source)).reason).toContain('must be on main');
    git(work, 'checkout', '-q', 'main');
    const linked = join(dir, 'linked'); git(work, 'worktree', 'add', '-q', '--detach', linked);
    expect((await checkUpdate(linked, source)).eligible).toBe(false);
  });
  it('starts outside a git checkout with release checks unavailable', async () => {
    const plain = join(dir, 'plain'); mkdirSync(plain);
    const list = vi.fn(source.list);
    const u = createUpdater({ repo: plain, home: dir, source: { ...source, list }, onChange: vi.fn(), spawnHelper: vi.fn(() => 'unused') });
    for (const s of [u.status(), await u.check()]) {
      expect(s).toMatchObject({ eligible: false, reason: expect.stringContaining('not running from a git checkout') });
      expect(s.target ?? s.fetchError ?? s.runtimeSha).toBeFalsy();
    }
    expect(updateLine(u.status())).toContain('release checks unavailable');
    expect(list).not.toHaveBeenCalled();
    await expect(u.apply({ tag: 'v0.1.0', sha: 'x' })).rejects.toThrow('cannot update: release checks unavailable');
  });
  it('reports dirty main structurally and clears the blocker on refresh, clean, non-main and failed checks', async () => {
    const u = createUpdater({ repo: work, home: dir, source, onChange: vi.fn(), spawnHelper: vi.fn(() => 'unused') });
    const local = join(work, 'local');
    writeFileSync(local, 'keep');
    expect(await u.check()).toMatchObject({ eligible: false, blocker: 'dirty' });
    rmSync(local);
    const clean = u.check();
    expect(u.status().blocker).toBeUndefined();
    expect(await clean).toMatchObject({ eligible: true, blocker: undefined });
    writeFileSync(local, 'keep');
    expect((await u.check()).blocker).toBe('dirty');
    git(work, 'checkout', '-qb', 'task');
    expect(await u.check()).toMatchObject({ eligible: false, blocker: undefined, reason: expect.stringContaining('must be on main') });
    git(work, 'checkout', '-q', 'main');
    expect((await u.check()).blocker).toBe('dirty');
    vi.spyOn(source, 'list').mockRejectedValueOnce(new Error('offline'));
    const unavailable = await u.check();
    expect(unavailable).toMatchObject({ eligible: false, fetchError: 'offline' });
    expect(unavailable.blocker).toBeUndefined();
    expect((await u.check()).blocker).toBe('dirty');
    const notesPath = join(dir, 'update-notes.json');
    rmSync(notesPath); mkdirSync(notesPath);
    expect(await u.check()).toMatchObject({ eligible: false, blocker: undefined, fetchError: expect.any(String) });
  });
  it('refuses a moved tag and changed release notes at apply', async () => {
    commit('two'); const r = release('v0.1.1'); const s = await checkUpdate(work, source);
    r.body = 'changed';
    await expect(applyUpdate({ repo: work, log: join(dir, 'log'), expected: s, source })).rejects.toThrow('release or checkout changed');
    r.body = 'Notes for v0.1.1'; commit('three'); git(seed, 'tag', '-f', r.tag); git(seed, 'push', '-q', '--force', 'origin', r.tag);
    await expect(applyUpdate({ repo: work, log: join(dir, 'log'), expected: s, source })).rejects.toThrow('release or checkout changed');
    expect(git(work, 'rev-parse', 'HEAD')).toBe(s.sha);
  });
  it('reports an incomplete artifact rollback after restoring HEAD when both builds fail', async () => {
    mkdirSync(join(seed, 'ui')); commit('ui/app', 'old'); release('v0.1.1');
    git(work, 'merge', '--ff-only', (await checkUpdate(work, source)).target!.sha);
    commit('ui/app', 'new'); release('v0.1.2');
    const s = await checkUpdate(work, source), builds = join(dir, 'builds');
    const env = fakeNpm(`git rev-parse HEAD >> '${builds}'\nexit 1`);
    const restart = vi.fn(async () => {});
    await expect(applyUpdate({ repo: work, log: join(dir, 'log'), expected: s, source, restart, env })).rejects.toThrow('rollback incomplete');
    expect(restart).not.toHaveBeenCalled();
    expect(git(work, 'rev-parse', 'HEAD')).toBe(s.sha);
    expect(readFileSync(builds, 'utf8').trim().split('\n')).toEqual([s.target!.sha, s.sha]);
    expect(existsSync(join(work, '.git/update.lock'))).toBe(false);
  });
  it('holds the checkout lock through verified restart and rolls back a failed restart', async () => {
    commit('two'); release('v0.1.1');
    const s = await checkUpdate(work, source), seen: string[] = [];
    await expect(applyUpdate({ repo: work, log: join(dir, 'log'), expected: s, source, restart: async (sha) => {
      expect(existsSync(join(work, '.git/update.lock'))).toBe(true);
      seen.push(sha);
      if (sha === s.target!.sha) throw new Error('health SHA mismatch');
    } })).rejects.toThrow('health SHA mismatch');
    expect(seen).toEqual([s.target!.sha, s.sha]);
    expect(git(work, 'rev-parse', 'HEAD')).toBe(s.sha);
  });
  it('preserves edits made by a failing build when rollback cannot safely reset', async () => {
    mkdirSync(join(seed, 'ui')); commit('ui/app', 'old'); release('v0.1.1');
    git(work, 'merge', '--ff-only', (await checkUpdate(work, source)).target!.sha);
    commit('ui/app', 'new'); release('v0.1.2');
    const s = await checkUpdate(work, source), env = fakeNpm('echo keep > ui/app\nexit 1');
    await expect(applyUpdate({ repo: work, log: join(dir, 'log'), expected: s, source, env })).rejects.toThrow('rollback incomplete');
    expect(readFileSync(join(work, 'ui/app'), 'utf8')).toBe('keep\n');
  });
  it('refuses restart and preserves a checkout moved by a build', async () => {
    mkdirSync(join(seed, 'ui')); commit('ui/app', 'new'); release('v0.1.1');
    const s = await checkUpdate(work, source), env = fakeNpm('git checkout -qb user-branch\nexit 0');
    const restart = vi.fn(async () => {});
    await expect(applyUpdate({ repo: work, log: join(dir, 'log'), expected: s, source, restart, env })).rejects.toThrow('HEAD or branch changed during update');
    expect(restart).not.toHaveBeenCalled();
    expect(git(work, 'symbolic-ref', '--short', 'HEAD')).toBe('user-branch');
    expect(git(work, 'rev-parse', 'HEAD')).toBe(s.target!.sha);
  });
  it('refuses a surviving lock without removing it or changing HEAD', async () => {
    commit('two'); release('v0.1.1'); const s = await checkUpdate(work, source);
    const lock = join(work, '.git/update.lock'); writeFileSync(lock, 'interrupted');
    await expect(applyUpdate({ repo: work, log: join(dir, 'log'), expected: s, source })).rejects.toThrow('interrupted update holds');
    expect(readFileSync(lock, 'utf8')).toBe('interrupted');
    expect(git(work, 'rev-parse', 'HEAD')).toBe(s.sha);
  });
  it('includes keg-only Homebrew cargo in forward and rollback app builds', async () => {
    mkdirSync(join(seed, 'src-tauri')); commit('src-tauri/config', 'old'); commit('.gitignore', 'src-tauri/target/\n'); release('v0.1.1');
    git(work, 'merge', '--ff-only', (await checkUpdate(work, source)).target!.sha);
    mkdirSync(join(work, 'src-tauri/target/release/bundle/macos/Tiller.app'), { recursive: true });
    commit('src-tauri/config', 'new'); release('v0.1.2');
    const s = await checkUpdate(work, source), paths = join(dir, 'paths'), failed = join(dir, 'failed');
    const env = fakeNpm(`echo "$PATH" >> '${paths}'\nif [ ! -e '${failed}' ]; then touch '${failed}'; exit 1; fi`);
    await expect(applyUpdate({ repo: work, log: join(dir, 'log'), expected: s, source, env })).rejects.toThrow('npm run app:build failed');
    expect(readFileSync(paths, 'utf8').trim().split('\n')).toEqual([`/opt/homebrew/opt/rustup/bin:${env.PATH}`, `/opt/homebrew/opt/rustup/bin:${env.PATH}`]);
    expect(git(work, 'rev-parse', 'HEAD')).toBe(s.sha);
  });
  it('uses a checkout-wide lock and rejects racing applies', async () => {
    commit('two'); release('v0.1.1');
    const helpers = vi.fn((_s: import('../shared/protocol.js').UpdateStatus, _exit: (code: number | null) => void) => join(dir, 'update.log'));
    const u = createUpdater({ repo: work, home: dir, source, onChange: () => {}, spawnHelper: helpers }); await u.check();
    const expected = { tag: u.status().target!.tag, sha: u.status().target!.sha };
    const results = await Promise.allSettled([u.apply(expected), u.apply(expected)]);
    expect(results.map((r) => r.status)).toEqual(['fulfilled', 'rejected']);
    expect(helpers).toHaveBeenCalledTimes(1);
    expect(helpers.mock.calls[0][0]).toMatchObject({ target: { tag: expected.tag, sha: expected.sha } });
  });
  it('keeps the same-runtime release check as a no-op', async () => {
    const u = createUpdater({ repo: work, home: dir, source, onChange: () => {}, spawnHelper: vi.fn(() => 'fixture') });
    await u.check();
    await expect(u.apply({ tag: u.status().target!.tag, sha: u.status().target!.sha })).rejects.toThrow('already at the latest release');
  });
});

describe('installed unread release notes', () => {
  beforeEach(setupCheckout);
  afterEach(() => rmSync(dir, { recursive: true, force: true }));
  const updater = (onChange = vi.fn()) => createUpdater({ repo: work, home: dir, source, onChange, spawnHelper: vi.fn(() => { throw new Error('must not apply'); }) });
  const install = async (tag: string) => {
    commit(`file-${tag}`); release(tag);
    const s = await checkUpdate(work, source);
    git(work, 'merge', '--ff-only', s.target!.sha);
  };

  it('baselines first observation, distinguishes future releases, and rolls up actually installed releases', async () => {
    const first = updater();
    expect((await first.check()).installedNotes).toBeUndefined();
    commit('two'); release('v0.1.1'); commit('three'); release('v0.1.2');
    const available = await first.check();
    expect(available.releases.map((r) => r.tag)).toEqual(['v0.1.2', 'v0.1.1']);
    expect(available.installedNotes).toBeUndefined();
    git(work, 'merge', '--ff-only', available.target!.sha);
    // An old running daemon never claims the newly moved checkout is installed.
    expect((await first.check()).installedNotes).toBeUndefined();
    const current = updater();
    const notes = (await current.check()).installedNotes!;
    expect(notes.releases.map((r) => [r.tag, r.body])).toEqual([
      ['v0.1.2', 'Notes for v0.1.2'], ['v0.1.1', 'Notes for v0.1.1'],
    ]);
    expect(notes.identity).toMatch(/^[a-f0-9]{64}$/);
    expect(current.status().releases).toEqual([]);
  });

  it('keeps future release notes out of installed unread notes', async () => {
    await updater().check(); await install('v0.1.1');
    commit('future'); release('v0.1.2');
    const status = await updater().check();
    expect(status.target?.tag).toBe('v0.1.2');
    expect(status.releases.map((r) => r.tag)).toEqual(['v0.1.2']);
    expect(status.installedNotes?.releases.map((r) => r.tag)).toEqual(['v0.1.1']);
  });

  it('does not fabricate a partial rollup or disable future updates when older installed history is missing', async () => {
    await updater().check(); await install('v0.1.1'); await install('v0.1.2');
    commit('future'); release('v0.1.3');
    git(seed, 'push', '-q', 'origin', ':refs/tags/v0.1.1');
    const status = await updater().check();
    expect(status).toMatchObject({ eligible: true, target: { tag: 'v0.1.3' } });
    expect(status.installedNotes).toBeUndefined();
  });

  it('baselines offline first starts and waits for published metadata after a later install', async () => {
    const list = source.list;
    source.list = async () => { throw new Error('offline'); };
    expect((await updater().check()).installedNotes).toBeUndefined();
    source.list = list;
    expect((await updater().check()).installedNotes).toBeUndefined();
    await install('v0.1.1');
    source.list = async () => [];
    expect((await updater().check()).installedNotes).toBeUndefined();
    source.list = list;
    expect((await updater().check()).installedNotes?.releases.map((r) => r.tag)).toEqual(['v0.1.1']);
  });

  it('does not call development commits an installed release', async () => {
    await updater().check(); await install('v0.1.1');
    git(work, 'commit', '--allow-empty', '-qm', 'development');
    expect((await updater().check()).installedNotes).toBeUndefined();
  });
});

describe('repeated checks of a Git checkout', () => {
  beforeEach(setupCheckout);
  afterEach(() => rmSync(dir, { recursive: true, force: true }));
  it('reuses the resolved releases while the list and HEAD are unchanged, reading the checkout afresh each time', async () => {
    commit('two'); release('v0.1.1');
    const checkout = gitCheckout(work);
    const first = await checkout.check(source, undefined, true);
    expect(first).toMatchObject({ eligible: true, target: { tag: 'v0.1.1' } });
    // With the remote gone, only a check that fetches no tags still succeeds.
    renameSync(join(dir, 'origin.git'), join(dir, 'gone.git'));
    const { checkedAt: _, ...same } = first;
    expect(await checkout.check(source, undefined, true)).toMatchObject(same);
    writeFileSync(join(work, 'local'), 'keep');
    expect(await checkout.check(source, undefined, true)).toMatchObject({ eligible: false, blocker: 'dirty', target: first.target });
    rmSync(join(work, 'local'));
    writeFileSync(join(work, '.git/update.lock'), JSON.stringify({ pid: spawnSync('true').pid }));
    expect((await checkout.check(source, undefined, true)).reason).toContain('interrupted update');
    rmSync(join(work, '.git/update.lock'));
    expect(await checkout.check(source)).toMatchObject({ eligible: false, fetchError: expect.any(String) }); // a full check fetches
    renameSync(join(dir, 'gone.git'), join(dir, 'origin.git'));
    expect(await checkout.check(source, undefined, true)).toMatchObject(same); // and leaves nothing to reuse until it succeeds
    renameSync(join(dir, 'origin.git'), join(dir, 'gone.git'));
    publish('v0.1.2');
    expect(await checkout.check(source, undefined, true)).toMatchObject({ fetchError: expect.any(String) }); // a new release
    rows.pop();
    expect(await checkout.check(source, undefined, true)).toMatchObject(same);
    git(work, 'commit', '-q', '--allow-empty', '-m', 'local');
    expect(await checkout.check(source, undefined, true)).toMatchObject({ fetchError: expect.any(String) }); // a new HEAD
  });
});

describe('installed unread release notes state', () => {
  let fake: ReturnType<typeof setupFake>;
  beforeEach(() => { fake = setupFake(); });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));
  const updater = (onChange = vi.fn()) => createUpdater({ repo: dir, home: dir, source, checkout: fake, onChange, spawnHelper: vi.fn(() => { throw new Error('must not apply'); }) });

  it('persists a shared acknowledgment across reconnects, restarts, checks and offline starts', async () => {
    await updater().check(); fake.install('v0.1.1');
    const changed = vi.fn(), current = updater(changed);
    const notes = (await current.check()).installedNotes!;
    expect(updater().status().installedNotes).toEqual(notes);
    await current.acknowledgeNotes('stale');
    expect(current.status().installedNotes).toEqual(notes);
    await current.acknowledgeNotes(notes.identity);
    expect(changed.mock.lastCall![0].installedNotes).toBeUndefined();
    expect((await current.check()).installedNotes).toBeUndefined();
    source.list = async () => { throw new Error('offline'); };
    const restarted = updater();
    expect(restarted.status().installedNotes).toBeUndefined();
    expect(await restarted.check()).toMatchObject({ eligible: false, fetchError: 'offline' });
    expect(restarted.status().installedNotes).toBeUndefined();
  });

  it('does not let an older client acknowledgment dismiss a newer unseen installed release', async () => {
    await updater().check(); fake.install('v0.1.1');
    const old = (await updater().check()).installedNotes!;
    fake.install('v0.1.2');
    const current = updater(), notes = (await current.check()).installedNotes!;
    expect(notes.identity).not.toBe(old.identity);
    expect(notes.releases.map((r) => r.tag)).toEqual(['v0.1.2', 'v0.1.1']);
    await current.acknowledgeNotes(old.identity);
    expect(current.status().installedNotes).toEqual(notes);
    await current.acknowledgeNotes(notes.identity);
    expect(updater().status().installedNotes).toBeUndefined();
  });

  it('keeps proven cached notes offline or with no published releases without allowing apply', async () => {
    await updater().check(); fake.install('v0.1.1');
    const notes = (await updater().check()).installedNotes!;
    source.list = async () => { throw new Error('offline'); };
    const current = updater();
    expect(current.status().installedNotes).toEqual(notes);
    expect(await current.check()).toMatchObject({ installedNotes: notes, eligible: false, fetchError: 'offline' });
    await expect(current.apply({ tag: 'v0.1.1', sha: notes.releases[0].sha })).rejects.toThrow('release changed');
    source.list = async () => [];
    expect(await current.check()).toMatchObject({ installedNotes: notes, eligible: false, reason: 'no published stable releases' });
  });

  it('does not infer notices from a corrupt cache', async () => {
    await updater().check(); fake.install('v0.1.1');
    writeFileSync(join(dir, 'update-notes.json'), '{broken');
    const current = updater();
    expect((await current.check()).installedNotes).toBeUndefined();
    expect(JSON.parse(readFileSync(join(dir, 'update-notes.json'), 'utf8')).baselineSha).toBe(fake.head);
  });

  it('does not resurrect acknowledged notes when an in-flight check finishes', async () => {
    await updater().check(); fake.install('v0.1.1');
    const current = updater(), notes = (await current.check()).installedNotes!;
    const list = source.list;
    let finish!: () => void;
    source.list = async (repo) => { await new Promise<void>((r) => { finish = r; }); return list(repo); };
    const checking = current.check();
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
    await current.acknowledgeNotes(notes.identity);
    finish();
    expect((await checking).installedNotes).toBeUndefined();
    expect(updater().status().installedNotes).toBeUndefined();
  });

  it('does not resurrect another instance acknowledgment after its paused check finishes', async () => {
    await updater().check(); fake.install('v0.1.1');
    const a = updater(), notes = (await a.check()).installedNotes!;
    const b = updater(), list = source.list;
    let finish!: () => void;
    source.list = async (repo) => { await new Promise<void>((r) => { finish = r; }); return list(repo); };
    const checking = b.check();
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
    await a.acknowledgeNotes(notes.identity);
    finish();
    expect((await checking).installedNotes).toBeUndefined();
    expect(updater().status().installedNotes).toBeUndefined();
  });

  it('keeps a newer persisted release when an old daemon acknowledges its stale identity', async () => {
    await updater().check(); fake.install('v0.1.1');
    const old = updater(), previous = (await old.check()).installedNotes!;
    fake.install('v0.1.2');
    const current = updater(), newer = (await current.check()).installedNotes!;
    await old.acknowledgeNotes(previous.identity);
    source.list = async () => { throw new Error('offline'); };
    expect((await updater().check()).installedNotes).toEqual(newer);
    expect(current.status().installedNotes).toEqual(newer);
  });

  it('waits for brief notes-lock contention without blocking daemon initialization', async () => {
    await updater().check(); fake.install('v0.1.1');
    const lock = join(dir, 'update-notes.json.lock');
    writeFileSync(lock, 'fixture');
    const current = updater();
    const checking = current.check();
    setTimeout(() => rmSync(lock), 50);
    expect((await checking).installedNotes?.releases[0].tag).toBe('v0.1.1');
  });

  it('retains unread notes and does not broadcast read state when persistence fails', async () => {
    await updater().check(); fake.install('v0.1.1');
    const changed = vi.fn(), current = updater(changed), notes = (await current.check()).installedNotes!;
    changed.mockClear();
    const path = join(dir, 'update-notes.json'), saved = `${path}.saved`;
    renameSync(path, saved); mkdirSync(path);
    await expect(current.acknowledgeNotes(notes.identity)).rejects.toThrow();
    expect(changed).not.toHaveBeenCalled();
    expect(current.status().installedNotes).toEqual(notes);
    rmSync(path, { recursive: true }); renameSync(saved, path);
    expect(updater().status().installedNotes).toEqual(notes);
  });

});


describe('automatic discovery while a UI is connected', () => {
  let fake: ReturnType<typeof setupFake>;
  beforeEach(() => { fake = setupFake(); });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));
  // Join an automatic check without starting one; the in-memory checkout may already have finished it.
  const settle = async (updater: Updater) => { if (updater.status().checking) await updater.check(); };
  const setup = () => {
    const changed = vi.fn();
    const spawnHelper = vi.fn(() => 'unused');
    const list = vi.spyOn(source, 'list');
    const updater = createUpdater({ repo: dir, home: dir, source, checkout: fake, onChange: changed, spawnHelper });
    const tick = async (ms: number) => {
      await vi.advanceTimersByTimeAsync(ms);
      await settle(updater);
    };
    return { updater, changed, spawnHelper, list, tick };
  };
  it.each([false, true])('publishes coalesced manual check progress and clears it after failure=%s', async (fail) => {
    const { updater, changed, list } = setup();
    await updater.check();
    expect(updater.status().eligible).toBe(true);
    changed.mockClear();
    let finish!: () => void;
    list.mockImplementationOnce(() => new Promise((resolve, reject) => {
      finish = () => fail ? reject(new Error('offline')) : resolve([...rows]);
    }));
    const pending = updater.check();
    expect(updater.check()).toBe(pending);
    expect(updater.status()).toMatchObject({ checking: true, eligible: false });
    expect(changed).toHaveBeenCalledTimes(1);
    expect(changed.mock.calls[0][0]).toMatchObject({ checking: true, eligible: false });
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
    finish();
    expect(await pending).toMatchObject({ checking: false, eligible: !fail });
    expect(updater.status().checking).toBe(false);
    expect(changed.mock.calls.map(([s]) => s.checking)).toEqual([true, false]);
    expect(changed.mock.calls[1][0].fetchError).toBe(fail ? 'offline' : undefined);
    expect(list).toHaveBeenCalledTimes(2);
  });
  it('lets only automatic polls reuse a resolved release history', async () => {
    fakeClock();
    const check = vi.spyOn(fake, 'check');
    const { updater, tick } = setup();
    updater.start(); await tick(0);
    await tick(UPDATE_CHECK_INTERVAL);
    await updater.check();
    expect(check.mock.calls.map((c) => c[2])).toEqual([true, true, false]);
    updater.stop();
  });
  it('clears progress after a notes-state error before discovery starts', async () => {
    const { updater, changed, list } = setup();
    const path = join(dir, 'update-notes.json');
    rmSync(path); mkdirSync(path);
    expect(await updater.check()).toMatchObject({ checking: false, eligible: false, fetchError: expect.any(String) });
    expect(changed.mock.calls.map(([s]) => s.checking)).toEqual([true, false]);
    expect(list).not.toHaveBeenCalled();
  });
  it('waits for fresh eligibility before applying and keeps checking off during installation', async () => {
    fake.commit(); fake.release('v0.1.1');
    const { updater, changed, list, spawnHelper } = setup();
    const target = (await updater.check()).target!;
    let finish!: (rows: PublishedRelease[]) => void;
    list.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    const pending = updater.check();
    const applying = updater.apply({ tag: target.tag, sha: target.sha });
    expect(spawnHelper).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
    finish([...rows]); await pending; await applying;
    expect(spawnHelper).toHaveBeenCalledTimes(1);
    expect(await updater.check()).toMatchObject({ applying: true, checking: false });
    expect(list).toHaveBeenCalledTimes(2);
    expect(changed.mock.calls.every(([s]) => !(s.checking && s.applying))).toBe(true);
  });
  it('refuses a waiting apply when the refresh fails', async () => {
    fake.commit(); fake.release('v0.1.1');
    const { updater, list, spawnHelper } = setup();
    const target = (await updater.check()).target!;
    let fail!: (error: Error) => void;
    list.mockImplementationOnce(() => new Promise((_resolve, reject) => { fail = reject; }));
    const pending = updater.check();
    const refused = expect(updater.apply({ tag: target.tag, sha: target.sha })).rejects.toThrow('release changed; check and review again');
    await vi.waitFor(() => expect(fail).toBeTypeOf('function'));
    fail(new Error('offline')); await pending; await refused;
    expect(updater.status()).toMatchObject({ checking: false, applying: false, eligible: false });
    expect(spawnHelper).not.toHaveBeenCalled();
  });
  it('discovers a newly published release on one shared timer, without installing or marking notes unread', async () => {
    fakeClock();
    const { updater, changed, spawnHelper, list } = setup();
    const installed = fake.head;
    updater.start(); updater.start();
    expect(vi.getTimerCount()).toBe(1);
    const firstBroadcast = new Promise((resolve) => changed.mockImplementationOnce(resolve));
    await vi.advanceTimersByTimeAsync(0);
    await firstBroadcast; await settle(updater);
    expect(list).toHaveBeenCalledTimes(1);
    fake.commit(); fake.release('v0.1.1');
    const calls = changed.mock.calls.length;
    const discovery = new Promise((resolve) => changed.mockImplementationOnce(resolve));
    await vi.advanceTimersByTimeAsync(UPDATE_CHECK_INTERVAL);
    await discovery; await settle(updater);
    expect(changed.mock.calls.length).toBe(calls + 2);
    expect(list).toHaveBeenCalledTimes(2);
    expect(updater.status()).toMatchObject({ target: { tag: 'v0.1.1' }, eligible: true });
    expect(updater.status().installedNotes).toBeUndefined();
    expect(fake.head).toBe(installed);
    expect(spawnHelper).not.toHaveBeenCalled();
    updater.stop();
    expect(vi.getTimerCount()).toBe(0);
  });
  it('pauses when closed, avoids reconnect bursts, and checks immediately when reopened stale', async () => {
    fakeClock();
    const { updater, list, tick } = setup();
    await vi.advanceTimersByTimeAsync(UPDATE_CHECK_INTERVAL);
    expect(list).not.toHaveBeenCalled();
    updater.start(); await tick(0); updater.stop();
    updater.start();
    await vi.advanceTimersByTimeAsync(UPDATE_CHECK_INTERVAL - 1);
    expect(list).toHaveBeenCalledTimes(1);
    updater.stop();
    await vi.advanceTimersByTimeAsync(UPDATE_CHECK_INTERVAL * 4);
    expect(list).toHaveBeenCalledTimes(1);
    updater.start(); await tick(0);
    expect(list).toHaveBeenCalledTimes(2);
    updater.stop();
  });
  it('coalesces manual checks with discovery and does not rearm after closing during a request', async () => {
    fakeClock();
    const { updater, list, changed } = setup();
    let finish!: (rows: PublishedRelease[]) => void;
    list.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    updater.start(); await vi.advanceTimersByTimeAsync(0);
    const first = updater.check();
    expect(updater.check()).toBe(first);
    expect(updater.status()).toMatchObject({ checking: true, eligible: false });
    updater.stop();
    // Wait until the check reaches the mocked release request.
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
    finish([...rows]); await first;
    expect(changed.mock.calls.map(([s]) => s.checking)).toEqual([true, false]);
    expect(list).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });
  it('backs off offline failures, recovers automatically, and allows an explicit retry sooner', async () => {
    fakeClock();
    const { updater, list, tick } = setup();
    list.mockRejectedValueOnce(new Error('offline')).mockRejectedValueOnce(new Error('offline'));
    updater.start(); await tick(0);
    expect(updater.status()).toMatchObject({ checking: false, eligible: false, fetchError: 'offline' });
    await vi.advanceTimersByTimeAsync(UPDATE_CHECK_INTERVAL);
    expect(list).toHaveBeenCalledTimes(1);
    // An explicit retry runs inside the backoff; failing again doubles it to 40 minutes.
    expect(await updater.check()).toMatchObject({ fetchError: 'offline' });
    expect(list).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(40 * 60_000 - 1);
    expect(list).toHaveBeenCalledTimes(2);
    await tick(1);
    expect(list).toHaveBeenCalledTimes(3);
    expect(updater.status()).toMatchObject({ checking: false, eligible: true });
    expect(updater.status().fetchError).toBeUndefined();
    updater.stop();
  });
  it('pauses discovery during an explicitly approved install and resumes after helper failure', async () => {
    fakeClock();
    fake.commit(); fake.release('v0.1.1');
    let exit!: (code: number | null) => void;
    const list = vi.spyOn(source, 'list');
    const updater = createUpdater({ repo: dir, home: dir, source, checkout: fake, onChange: vi.fn(), spawnHelper: (_expected, onExit) => { exit = onExit; return 'fixture'; } });
    updater.start(); await vi.advanceTimersByTimeAsync(0); await settle(updater);
    const target = updater.status().target!;
    await updater.apply({ tag: target.tag, sha: target.sha });
    await vi.advanceTimersByTimeAsync(UPDATE_CHECK_INTERVAL);
    expect(await updater.check()).toMatchObject({ applying: true, checking: false });
    expect(list).toHaveBeenCalledTimes(1);
    exit(1);
    await vi.advanceTimersByTimeAsync(UPDATE_CHECK_INTERVAL); await settle(updater);
    expect(list).toHaveBeenCalledTimes(2);
    expect(updater.status().applying).toBe(false);
    updater.stop();
  });
  it.each([
    ['a live helper', () => JSON.stringify({ pid: process.pid, sha: 'fixture' }), `another update (pid ${process.pid}) holds`],
    ['unreadable contents', () => 'fixture', 'another update holds'],
  ])('does not check, and says so, while %s holds the checkout lock', async (_, contents, reason) => {
    fakeClock();
    const { updater, list, tick } = setup();
    writeFileSync(join(dir, 'update.lock'), contents());
    updater.start(); await vi.advanceTimersByTimeAsync(0);
    expect(list).not.toHaveBeenCalled();
    expect(updater.status()).toMatchObject({ eligible: false, reason: expect.stringContaining(reason) });
    rmSync(join(dir, 'update.lock'));
    await tick(UPDATE_CHECK_INTERVAL);
    expect(list).toHaveBeenCalledTimes(1);
    updater.stop();
  });
});

describe('automatic discovery of a Git checkout', () => {
  beforeEach(setupCheckout);
  afterEach(() => rmSync(dir, { recursive: true, force: true }));
  it('finds the lock holder in the Git common directory', () => {
    expect(gitCheckout(work).lockHolder()).toBeUndefined();
    const lock = join(work, '.git/update.lock');
    writeFileSync(lock, JSON.stringify({ pid: process.pid, sha: 'fixture' }));
    expect(gitCheckout(work).lockHolder()).toEqual({ path: lock, pid: process.pid, stale: false });
  });
  it('checks past a lock whose holder exited and reports the interrupted update without removing the lock', async () => {
    fakeClock();
    commit('two'); release('v0.1.1');
    const list = vi.spyOn(source, 'list'), spawnHelper = vi.fn(() => 'unused');
    const updater = createUpdater({ repo: work, home: dir, source, onChange: vi.fn(), spawnHelper });
    const lock = join(work, '.git/update.lock');
    writeFileSync(lock, JSON.stringify({ pid: spawnSync('true').pid, sha: 'fixture' }));
    updater.start(); await vi.advanceTimersByTimeAsync(0);
    // The automatic poll started this check; joining it must not start another.
    expect(updater.status().checking).toBe(true);
    await updater.check();
    expect(list).toHaveBeenCalledTimes(1);
    expect(updater.status()).toMatchObject({ eligible: false, target: { tag: 'v0.1.1' }, reason: expect.stringContaining('interrupted update') });
    const target = updater.status().target!;
    await expect(updater.apply({ tag: target.tag, sha: target.sha })).rejects.toThrow('cannot update: an interrupted update');
    expect(spawnHelper).not.toHaveBeenCalled();
    expect(existsSync(lock)).toBe(true);
    updater.stop();
  });
});

describe('GitHub polling transport', () => {
  it('revalidates each cached list page with ETags, while individual install validation stays fresh', async () => {
    const row = { id: 1, tag_name: 'v0.1.0', name: null, body: 'original', draft: false, prerelease: false, published_at: '2026-10-17T00:00:00Z' };
    const request = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify(Array(100).fill(row)), { headers: { etag: 'page1' } }))
      .mockResolvedValueOnce(new Response('[]', { headers: { etag: 'page2' } }))
      .mockResolvedValueOnce(new Response(null, { status: 304 }))
      .mockResolvedValueOnce(new Response(null, { status: 304 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ...row, body: 'edited' })));
    const api = githubReleases(request);
    expect(await api.list('a/b')).toHaveLength(100);
    expect(await api.list('a/b')).toHaveLength(100);
    expect(request.mock.calls[2][1]?.headers).toHaveProperty('If-None-Match', 'page1');
    expect(request.mock.calls[3][1]?.headers).toHaveProperty('If-None-Match', 'page2');
    expect((await api.get('a/b', 1)).body).toBe('edited');
    expect(request.mock.calls[4][1]?.headers).not.toHaveProperty('If-None-Match');
    expect(request.mock.calls.every(([, init]) => !('Authorization' in init!.headers!))).toBe(true);
  });
  it('honors both retry-after and primary reset, including manual retries, without serving stale success', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const request = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response('[]', { headers: { etag: 'first' } }))
      .mockResolvedValueOnce(new Response('', { status: 429, headers: { 'retry-after': '120', 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(Date.now() / 1000 + 3600) } }))
      .mockResolvedValueOnce(new Response('[]'));
    const api = githubReleases(request);
    await api.list('a/b');
    await expect(api.list('a/b')).rejects.toThrow('rate limit');
    vi.setSystemTime(Date.now() + 120_000);
    await expect(api.list('a/b')).rejects.toThrow('cooldown');
    expect(request).toHaveBeenCalledTimes(2);
    vi.setSystemTime(Date.now() + 3600_000);
    expect(await api.list('a/b')).toEqual([]);
    expect(request).toHaveBeenCalledTimes(3);
  });
  it('backs off repeated limit responses with no headers', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const request = vi.fn<typeof fetch>().mockResolvedValue(new Response('', { status: 403 }));
    const api = githubReleases(request);
    await expect(api.list('a/b')).rejects.toThrow('rate limit');
    await expect(api.list('a/b')).rejects.toThrow('cooldown');
    vi.setSystemTime(Date.now() + 60_000);
    await expect(api.list('a/b')).rejects.toThrow('rate limit');
    vi.setSystemTime(Date.now() + 60_000);
    await expect(api.list('a/b')).rejects.toThrow('cooldown');
    expect(request).toHaveBeenCalledTimes(2);
  });
});
