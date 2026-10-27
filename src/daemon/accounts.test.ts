// Claude accounts through the node lifecycle: which account a node runs in, its CLAUDE_CONFIG_DIR, and what stays per account.
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { findArchived } from './archive.js';
import { gateFor } from './completion-gate.js';
import { NodeManager, type SpawnRequest } from './manager.js';
import { PtySession, type SpawnOpts } from './pty.js';

class FakeSession {
  exited = false;
  private exits: Array<(code: number) => void> = [];
  constructor(readonly opts: SpawnOpts) {}
  onData() {}
  onExit(cb: (code: number) => void) { this.exits.push(cb); }
  async flush() {}
  screenTail() { return []; }
  async write() {}
  classifyScreen() { return 'unknown' as const; }
  kill() { this.exited = true; for (const cb of this.exits) cb(0); }
  async terminate() { this.kill(); return true; }
}

let dir: string, m: NodeManager, processes: FakeSession[];
let workDir: string, otherDir: string, workProject: string, plain: string;
beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'tl-accounts-')));
  vi.stubEnv('HOME', dir); // ~/.claude.json and ~/.claude are the test's
  const bin = join(dir, 'bin'); mkdirSync(bin);
  for (const h of ['claude', 'pi', 'codex']) { writeFileSync(join(bin, h), '#!/bin/sh\n'); chmodSync(join(bin, h), 0o755); }
  workDir = join(dir, '.claude-work'); otherDir = join(dir, '.claude-other');
  workProject = join(dir, 'work'); plain = join(dir, 'plain');
  for (const d of [workDir, otherDir, workProject, plain]) mkdirSync(d);
  processes = [];
  vi.spyOn(PtySession, 'spawn').mockImplementation((opts) => { const s = new FakeSession(opts); processes.push(s); return s as unknown as PtySession; });
  m = new NodeManager({ home: join(dir, 'tl'), path: `${bin}:/usr/bin:/bin` });
  configure();
});
afterEach(async () => { await m.shutdown(); vi.restoreAllMocks(); vi.unstubAllEnvs(); rmSync(dir, { recursive: true, force: true }); });

function configure(accounts: unknown = [{ name: 'work', configDir: '~/.claude-work', projects: ['~/work'] }, { name: 'other', configDir: '~/.claude-other' }], extra = {}) {
  writeFileSync(join(m.home, 'config.json'), JSON.stringify({ claude: { accounts }, ...extra }));
}
const env = (s = processes.at(-1)!) => s.opts.env;
const spawn = (req: Partial<SpawnRequest> = {}) => m.spawn({ kind: 'claude', title: 't', cwd: workProject, byHuman: true, ...req });
const trust = (claudeJson: string, dir: string) => writeFileSync(claudeJson, JSON.stringify({ projects: { [dir]: { hasTrustDialogAccepted: true } } }));
/** Give a node a started session with a transcript in its account's home, as SessionStart does. */
function started(id: string, home = workDir): string {
  const rec = m.registry.get(id)!, path = join(home, 'projects', 'p', `${rec.sessionId}.jsonl`);
  mkdirSync(join(home, 'projects', 'p'), { recursive: true });
  writeFileSync(path, `${JSON.stringify({ type: 'assistant', message: { content: 'hi' } })}\n`);
  m.applyHook(id, { hook_event_name: 'SessionStart', session_id: rec.sessionId, transcript_path: path });
  return path;
}

describe('which account a node runs in', () => {
  it('without accounts: no account and no CLAUDE_CONFIG_DIR', async () => {
    configure([]);
    const { id } = await spawn();
    expect(m.registry.get(id)!.account).toBeUndefined();
    expect(env()).not.toHaveProperty('CLAUDE_CONFIG_DIR');
  });

  it('a mapped project gives the account and its canonical dir; elsewhere none', async () => {
    const { id } = await spawn();
    expect(m.registry.get(id)!.account).toBe('work');
    expect(env().CLAUDE_CONFIG_DIR).toBe(workDir);
    const other = await spawn({ cwd: plain });
    expect(m.registry.get(other.id)!.account).toBeUndefined();
    expect(env()).not.toHaveProperty('CLAUDE_CONFIG_DIR');
  });

  it('claude.account is the default for unmapped projects; a mapping wins over it', async () => {
    const accounts = [{ name: 'personal' }, { name: 'work', configDir: '~/.claude-work', projects: ['~/work'] }];
    configure(accounts, { claude: { accounts, account: 'personal' } });
    const { id } = await spawn({ cwd: plain });
    expect(m.registry.get(id)!.account).toBe('personal');
    expect(env()).not.toHaveProperty('CLAUDE_CONFIG_DIR');
    expect(m.registry.get((await spawn()).id)!.account).toBe('work');
    configure(accounts, { claude: { accounts, account: 'work' } });
    expect(m.registry.get((await spawn({ cwd: plain })).id)!.account).toBe('work');
    expect(env().CLAUDE_CONFIG_DIR).toBe(workDir);
    configure(accounts, { claude: { accounts, account: 'gone' } });
    await expect(spawn({ cwd: plain })).rejects.toThrow(/claude\.account .* names "gone"/);
  });

  it('the human\'s explicit account wins over the mapping; an unknown one is refused', async () => {
    const { id } = await spawn({ account: 'other' });
    expect(m.registry.get(id)!.account).toBe('other');
    expect(env().CLAUDE_CONFIG_DIR).toBe(otherDir);
    await expect(spawn({ account: 'nope' })).rejects.toThrow('Claude account "nope" is not configured');
  });

  it('children inherit; an agent cannot choose one, nor the human a different one for a child', async () => {
    const root = await spawn();
    const child = await m.spawn({ kind: 'claude', title: 'c', cwd: plain, parentId: root.id });
    expect(m.registry.get(child.id)!.account).toBe('work');
    expect(env().CLAUDE_CONFIG_DIR).toBe(workDir);
    await expect(m.spawn({ kind: 'claude', title: 'c', cwd: plain, parentId: root.id, account: 'work' })).rejects.toThrow(/only the human may choose a Claude account/);
    await expect(spawn({ parentId: root.id, account: 'other' })).rejects.toThrow(/parent's Claude account \(work\)/);
    const same = await spawn({ parentId: root.id, account: 'work' });
    expect(m.registry.get(same.id)!.account).toBe('work');
  });
});

describe('accounts are compared by Claude home', () => {
  it('no account and the named default are one home; a different dir is still refused', async () => {
    configure([]);
    const old = await spawn({ cwd: plain }); // from before accounts were configured
    started(old.id, join(dir, '.claude'));
    configure([{ name: 'personal' }, { name: 'work', configDir: '~/.claude-work' }]);
    const fork = await spawn({ cwd: plain, fork: old.id, account: 'personal' });
    expect(m.registry.get(fork.id)!.account).toBe('personal');
    expect(env()).not.toHaveProperty('CLAUDE_CONFIG_DIR');
    const child = await spawn({ cwd: plain, parentId: old.id, account: 'personal' });
    expect(m.registry.get(child.id)!.account).toBeUndefined(); // inherits the parent's (none)
    await expect(spawn({ cwd: plain, fork: old.id, account: 'work' })).rejects.toThrow(/cannot fork across Claude accounts \(source: default, new node: work\)/);
    await expect(spawn({ cwd: plain, parentId: old.id, account: 'work' })).rejects.toThrow(/parent's Claude account/);
  });
});

describe('an invalid claude.accounts list fails closed', () => {
  it('refuses root spawns and restarts of accounted nodes, naming the file and the problem', async () => {
    const { id } = await spawn({ kind: 'agent', harness: 'claude' });
    configure([{ name: 'work', configDir: '~/.claude-work', projects: ['~/work'] }, { name: 'work', configDir: '~/.claude-other' }]);
    const error = `claude.accounts in ${join(m.home, 'config.json')} is invalid: claude.accounts: duplicate account name work`;
    await expect(spawn()).rejects.toThrow(error);
    await expect(spawn({ cwd: plain })).rejects.toThrow(error);
    expect(m.restart(id)).toEqual({ ok: false, error: expect.stringContaining(error) });
    expect(m.registry.list().map((n) => n.id)).toEqual([id]);
  });
});

describe('the account is kept', () => {
  it('by restart and resume, which fail once the account is no longer configured', async () => {
    const { id } = await spawn({ kind: 'agent', harness: 'claude' });
    configure([{ name: 'work', configDir: '~/.claude-work' }]); // the project mapping is gone: a restart does not re-resolve
    expect(m.restart(id)).toEqual({ ok: true });
    expect(m.registry.get(id)!.account).toBe('work');
    expect(env().CLAUDE_CONFIG_DIR).toBe(workDir);
    started(id);
    processes.at(-1)!.kill();
    expect(await m.resume(id)).toEqual({ ok: true });
    expect(env().CLAUDE_CONFIG_DIR).toBe(workDir);
    expect(processes.at(-1)!.opts.args).toContain('--resume');

    processes.at(-1)!.kill();
    configure([]);
    const error = `Claude account "work" is not configured in ${join(m.home, 'config.json')} (claude.accounts)`;
    expect(await m.resume(id)).toEqual({ ok: false, error });
    const live = processes.length;
    expect(m.restart(id)).toEqual({ ok: false, error });
    expect(processes.length).toBe(live);
  });

  it('by a harness change claude -> pi -> claude, and Pi gets no CLAUDE_CONFIG_DIR', async () => {
    const { id } = await spawn({ kind: 'agent', harness: 'claude' });
    expect(await m.changeHarness(id, 'pi', undefined, true)).toEqual({ ok: true });
    expect(m.registry.get(id)!.account).toBe('work');
    expect(env().TL_HARNESS).toBe('pi');
    expect(env()).not.toHaveProperty('CLAUDE_CONFIG_DIR');
    expect(await m.changeHarness(id, 'claude', undefined, true)).toEqual({ ok: true });
    expect(m.registry.get(id)!.account).toBe('work');
    expect(env().CLAUDE_CONFIG_DIR).toBe(workDir);
  });
});

describe('fork and followup stay in one account', () => {
  it('a same-account fork resumes the source; a cross-account fork of an archived node is refused', async () => {
    const src = await spawn();
    started(src.id);
    const fork = await spawn({ fork: src.id, cwd: '' });
    expect(m.registry.get(fork.id)!.account).toBe('work');
    expect(processes.at(-1)!.opts.args).toContain('--fork-session');
    expect(env().CLAUDE_CONFIG_DIR).toBe(workDir);

    await m.close(src.id, true);
    expect((await findArchived(m.home, src.id))!.account).toBe('work');
    await expect(spawn({ fork: src.id, cwd: '', account: 'other' })).rejects.toThrow('refused: cannot fork across Claude accounts (source: work, new node: other)');
    started(fork.id);
    await expect(spawn({ fork: fork.id, cwd: plain, parentId: (await spawn({ cwd: plain })).id })).rejects.toThrow(/cannot fork across Claude accounts \(source: work, new node: default\)/);
  });

  it('a followup keeps the archived account', async () => {
    const src = await spawn({ cwd: plain, account: 'other' });
    started(src.id, otherDir);
    await m.close(src.id, true);
    const next = await m.followup(src.id, 'go on');
    expect(m.registry.get(next.id)!.account).toBe('other');
    expect(env().CLAUDE_CONFIG_DIR).toBe(otherDir);
  });
});

describe('trust per account', () => {
  it('a worktree spawn needs trust in the node\'s account, not ~/.claude.json', async () => {
    const repo = join(workProject, 'repo');
    mkdirSync(repo);
    const git = (...args: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd: repo });
    git('init', '-q', '-b', 'feature');
    git('commit', '-q', '--allow-empty', '-m', 'init');
    trust(join(dir, '.claude.json'), repo);
    await expect(spawn({ kind: 'agent', harness: 'claude', cwd: repo, isolation: 'worktree', parentId: (await spawn()).id })).rejects.toThrow(/does not trust/);
    trust(join(workDir, '.claude.json'), repo);
    const n = await spawn({ kind: 'agent', harness: 'claude', cwd: repo, isolation: 'worktree', role: 'worker' });
    expect(n.worktree).toBeDefined();
    expect(env().CLAUDE_CONFIG_DIR).toBe(workDir);
  });

  it('the gate runs when only an account\'s .claude.json trusts the project', () => {
    configure(undefined, { gate: { command: 'true' } });
    expect(gateFor(plain, m.home)).toBeUndefined();
    trust(join(otherDir, '.claude.json'), plain);
    expect(gateFor(plain, m.home)).toMatchObject({ command: 'true' });
  });
});

describe('usage per account', () => {
  const measure = (id: string, percentUsed: number) =>
    m.applyModEvent(id, { event: 'session.measure', payload: { rateLimits: [{ kind: 'five_hour', percentUsed }] } });
  const claude = () => m.usageRegistry.sources.filter((s) => s.tool === 'claude' && !s.id.startsWith('discovery:'));

  it('groups nodes of one account into one source; unaccounted nodes stay per node', async () => {
    const [a, b, c, x, y] = await Promise.all([spawn(), spawn(), spawn({ account: 'other' }), spawn({ cwd: plain }), spawn({ cwd: plain })]);
    for (const [n, pct] of [[a, 1], [b, 2], [c, 3], [x, 4], [y, 5]] as const) measure(n.id, pct);
    const sources = claude();
    expect(sources.find((s) => s.account === 'work')).toMatchObject({ nodeIds: [a.id, b.id], rateLimits: [{ percentUsed: 2 }] });
    expect(sources.find((s) => s.account === 'other')).toMatchObject({ nodeIds: [c.id] });
    expect(sources.filter((s) => !s.account).map((s) => s.nodeIds)).toEqual([[x.id], [y.id]]);
    expect(m.usage).toMatchObject({ nodeId: y.id });
    expect(m.usageByAccount.get('work')).toMatchObject({ nodeId: b.id, account: 'work' });
    expect(m.usageByAccount.get('')).toMatchObject({ nodeId: y.id });
    expect(m.usageByAccount.get('')).not.toHaveProperty('account');
  });

  it('never takes the account label from the adapter', async () => {
    const x = await spawn({ cwd: plain });
    m.applyModEvent(x.id, { event: 'session.measure', payload: { usageReports: [{ scope: 'account', account: 'work', rateLimits: [{ kind: 'five_hour', percentUsed: 9 }] }] } });
    expect(claude()).toEqual([expect.objectContaining({ nodeIds: [x.id] })]);
    expect(claude()[0]).not.toHaveProperty('account');
  });
});
