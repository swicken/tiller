import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { launchArgs } from './launch.js';
import { findArchived } from './archive.js';
import { cutOffText, NodeManager } from './manager.js';
import { ack, claim, deliver, inbox } from './messaging.js';
import { PtySession } from './pty.js';
import type { NodeStatus, NodeView } from '../shared/protocol.js';
import { setProjectTrust } from './trust.js';
import { trustPolicy } from './worktree-lifecycle.js';

/** A fake claude running `script` in `home`/bin, so nothing real launches; returns NodeManager options that find it. */
function fakeClaude(home: string, script = 'sleep 5') {
  const bin = join(home, 'bin');
  mkdirSync(bin);
  writeFileSync(join(bin, 'claude'), `#!/bin/sh\n${script}\n`);
  chmodSync(join(bin, 'claude'), 0o755);
  return { home, shell: '/bin/sh', path: `${bin}:/usr/bin:/bin` };
}

describe('trustPolicy', () => {
  const json = { projects: { '/work/repo': { hasTrustDialogAccepted: true }, '/work/no': { hasTrustDialogAccepted: false } } };
  it.each([
    ['/work/repo', json, 'auto'],            // exact match
    ['/work/repo/sub/dir', json, 'auto'],    // ancestor is trusted
    ['/work/no', json, 'manual'],            // explicitly not accepted
    ['/work/other', json, 'manual'],         // unknown
    ['/work', json, 'manual'],               // a parent of a trusted dir is not trusted
    ['/work/repo', { projects: { '/': { hasTrustDialogAccepted: true } } }, 'auto'], // root trusted
    ['/work/repo', {}, 'manual'],
    ['/work/repo', null, 'manual'],
  ])('%s -> %s', (cwd, cfg, want) => {
    expect(trustPolicy(cwd, cfg)).toBe(want);
  });
});

describe('trust dialog auto-answer', () => {
  let home = '';
  let m: NodeManager | undefined;
  afterEach(async () => { await m?.shutdown(); vi.unstubAllEnvs(); rmSync(home, { recursive: true, force: true }); });

  it('confirms only once Yes is selected, so a lost Down key does not exit Claude through "No, exit"', async () => {
    home = mkdtempSync(join(tmpdir(), 'tl-'));
    const bin = join(home, 'bin'), proj = join(home, 'proj');
    mkdirSync(bin);
    mkdirSync(proj);
    vi.stubEnv('HOME', home); // trustPolicy reads ~/.claude.json
    writeFileSync(join(home, '.claude.json'), JSON.stringify({ projects: { [home]: { hasTrustDialogAccepted: true } } }));
    // Fake claude: Claude's trust dialog, which drops the first key it gets because it draws before it listens.
    // Enter on "No, exit" exits; on Yes it prints "trusted" and stays up.
    writeFileSync(join(bin, 'claude'), `#!${process.execPath}
const mark = String.fromCodePoint(0x276f);
let yes = false, first = true;
const draw = () => process.stdout.write((yes ? '  No, exit\\r\\n' + mark + ' Yes, I trust this folder' : mark + ' No, exit\\r\\n  Yes, I trust this folder') + '\\r\\nEnter to confirm\\r\\n');
process.stdout.write('\\r\\n'.repeat(100)); // Claude draws at the bottom of the screen
process.stdin.setRawMode(true);
draw();
process.stdin.on('data', (d) => {
  if (first) { first = false; return; }
  if (String(d).includes('\\x1b[B')) { yes = true; draw(); } else if (String(d).includes('\\r')) { if (!yes) process.exit(1); process.stdout.write('trusted\\r\\n'); }
});
`);
    chmodSync(join(bin, 'claude'), 0o755);
    m = new NodeManager({ home: join(home, 'tl'), shell: '/bin/sh', path: `${bin}:/usr/bin:/bin` });
    const { id } = (await m.spawn({ kind: 'claude', title: 'c', cwd: proj }));
    await expect.poll(() => m!.session(id)?.screenTail(30).join('\n') ?? 'exited', { timeout: 3000 }).toContain('trusted');
    expect(m.view(id)!.status.exited).toBeFalsy();
  });
});

describe('NodeManager tokens and files', () => {
  let home = '';
  let m: NodeManager;
  afterEach(async () => { await m.shutdown(); rmSync(home, { recursive: true, force: true }); });

  it('verifies per-node tokens and keeps the secret private', () => {
    home = mkdtempSync(join(tmpdir(), 'tl-'));
    m = new NodeManager({ home });
    const t = m.tokenFor('n-1');
    expect(m.verifyToken('n-1', t)).toBe(true);
    expect(m.verifyToken('n-2', t)).toBe(false);
    expect(m.verifyToken('n-1', t.slice(0, -1))).toBe(false);
    expect(m.verifyToken('n-1', '')).toBe(false);
    expect(statSync(join(home, 'secret')).mode & 0o777).toBe(0o600);
    // A second manager on the same home derives the same tokens.
    const m2 = new NodeManager({ home });
    expect(m2.verifyToken('n-1', t)).toBe(true);
    m2.shutdown();
  });

  it('keeps tokens from an existing secret compatible with their credential files', () => {
    home = mkdtempSync(join(tmpdir(), 'tl-'));
    writeFileSync(join(home, 'secret'), 'known existing daemon secret', { mode: 0o600 });
    m = new NodeManager({ home });
    const token = '84c7a1be405d0246d0f1652aefaffbab60bec06868ff2051fdbf683c09e47e64';
    expect(m.tokenFor('n-1')).toBe(token);
    expect(m.verifyToken('n-1', token)).toBe(true);
    expect(m.verifyToken('n-1', token.toUpperCase())).toBe(false);
    m.writeFiles('n-1');
    expect(readFileSync(join(home, 'nodes/n-1/token'), 'utf8')).toBe(token);
    expect(readFileSync(join(home, 'nodes/n-1/hook-headers'), 'utf8')).toBe(`Authorization: Bearer ${token}\nX-TL-Node: n-1\n`);
  });

  it('writes node files with restrictive modes and removes them on close', async () => {
    home = mkdtempSync(join(tmpdir(), 'tl-'));
    m = new NodeManager({ home, shell: '/bin/sh' });
    const n = (await m.spawn({ kind: 'terminal', title: 't', cwd: tmpdir() }));
    const dir = join(home, 'nodes', n.id);
    expect(statSync(join(dir, 'token')).mode & 0o777).toBe(0o600);
    expect(statSync(join(dir, 'mcp.json')).mode & 0o777).toBe(0o600);
    expect(statSync(join(dir, 'hook-headers')).mode & 0o777).toBe(0o600);
    expect(statSync(join(dir, 'settings.json')).isFile()).toBe(true);
    await expect(m.close(n.id)).rejects.toThrow(/orchestrator/);
    await m.close(n.id, true);
    expect(() => statSync(dir)).toThrow();
    expect(m.list()).toEqual([]);
  });

  it('disables the project .mcp.json servers in a Claude node\'s settings only while inheritMcpServers is true', () => {
    home = mkdtempSync(join(tmpdir(), 'tl-'));
    const cwd = mkdtempSync(join(tmpdir(), 'tl-proj-'));
    writeFileSync(join(cwd, '.mcp.json'), JSON.stringify({ mcpServers: { echo: {} } }));
    m = new NodeManager({ home, path: '/usr/bin:/bin' });
    const id = m.registry.create({ kind: 'claude', parentId: null, title: 't', cwd }).id;
    const disabled = () => JSON.parse(readFileSync(join(home, 'nodes', id, 'settings.json'), 'utf8')).disabledMcpjsonServers;
    m.writeFiles(id);
    expect(disabled()).toEqual(['echo']);
    mkdirSync(join(cwd, '.tiller'));
    writeFileSync(join(cwd, '.tiller', 'config.json'), JSON.stringify({ claude: { inheritMcpServers: false } }));
    m.writeFiles(id);
    expect(disabled()).toBeUndefined();
    rmSync(cwd, { recursive: true, force: true });
  });

  it('cleans up when the cwd is bad', async () => {
    home = mkdtempSync(join(tmpdir(), 'tl-'));
    m = new NodeManager({ home, shell: '/bin/sh' });
    await expect(m.spawn({ kind: 'terminal', title: 't', cwd: '/no/such/dir' })).rejects.toThrow(/working directory/);
    expect(m.list()).toEqual([]);
  });
});

describe('NodeManager completion gates', () => {
  let home: string;
  let m: NodeManager;
  let id: string;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'tl-gate-'));
    m = new NodeManager({ home, path: '/usr/bin:/bin' });
    id = m.registry.create({ kind: 'claude', parentId: null, title: 'gate', cwd: home }).id;
    m.runtimes.set(id, { status: { state: 'done', changedAt: Date.now() } });
    m.writeFiles(id);
  });
  afterEach(async () => {
    await m.shutdown();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    rmSync(home, { recursive: true, force: true });
  });

  it('keeps gate results before outcome/node/log events, scopes output to the attempt and resets failures on an outcome', async () => {
    const events: string[] = [];
    m.on('node', (v: NodeView) => events.push(`node:${v.gate}:${v.outcome?.outcome ?? '-'}`));
    m.on('outcome', () => events.push('outcome'));
    vi.spyOn(m, 'logEvent').mockImplementation((_id, type) => { events.push(`log:${type}`); });
    const gate = { command: 'echo previous; exit 3', retries: 2, timeoutMinutes: 1 };
    const first = await m.runGate(id, gate);
    expect(first).toMatchObject({ ok: false, failures: 1 });
    expect(first.tail).toContain('previous');
    expect(first.tail).toContain('exited with 3');
    const passed = await m.runGate(id, { ...gate, command: 'echo current' });
    expect(passed).toEqual({ ok: true, tail: '$ echo current\ncurrent', failures: 1 });
    m.setOutcome(id, { outcome: 'succeeded', gate: 'passed', at: Date.now() });
    expect(events).toEqual(['node:running:-', 'node:failed:-', 'log:gate', 'node:running:-', 'node:passed:-', 'log:gate', 'outcome', 'node:passed:succeeded', 'log:outcome']);
    expect(await m.runGate(id, gate)).toMatchObject({ ok: false, failures: 1 });
    expect(readFileSync(join(m.nodeDir(id), 'gate.log'), 'utf8')).toContain('previous');
  });

  it('reads worktree gate configuration from its trusted main checkout', () => {
    vi.stubEnv('HOME', home);
    const repo = join(home, 'repo'), cwd = join(home, 'worker');
    for (const dir of [repo, cwd]) mkdirSync(join(dir, '.tiller'), { recursive: true });
    writeFileSync(join(repo, '.tiller/config.json'), JSON.stringify({ gate: { command: 'echo main' } }));
    writeFileSync(join(cwd, '.tiller/config.json'), JSON.stringify({ gate: { command: 'echo worker' } }));
    m.registry.update(id, { cwd, worktree: { repo, path: cwd, branch: 'tl/worker', base: 'main', baseSha: 'abc' } });
    expect(m.gateConfig(id)).toBeUndefined();
    setProjectTrust(home, repo, true);
    expect(m.gateConfig(id)?.command).toBe('echo main');
  });

  it('does not publish a finished gate or restore runtime state after its node is closed', async () => {
    const changed: string[] = [];
    m.on('node', (v: NodeView) => changed.push(v.gate!));
    const run = m.runGate(id, { command: 'sleep 0.05; echo finished', retries: 0, timeoutMinutes: 1 });
    expect(changed).toEqual(['running']);
    await m.close(id, true);
    expect(await run).toMatchObject({ ok: true });
    expect(changed).toEqual(['running']);
    expect(m.view(id)).toBeUndefined();
    expect(m.runtimes.has(id)).toBe(false);
    expect(await m.runGate(id, { command: 'exit 0', retries: 0, timeoutMinutes: 1 })).toEqual({ ok: false, tail: 'node is gone', failures: 0 });
  });
});

describe('NodeManager runtime state', () => {
  let home = '';
  let m: NodeManager;
  afterEach(async () => { await m.shutdown(); rmSync(home, { recursive: true, force: true }); });

  it('SessionStart records the session id and transcript on the node; other events leave them', async () => {
    home = mkdtempSync(join(tmpdir(), 'tl-'));
    m = new NodeManager({ home, shell: '/bin/sh' });
    const { id } = await m.spawn({ kind: 'terminal', title: 't', cwd: tmpdir() });
    m.applyHook(id, { hook_event_name: 'SessionStart', session_id: 's2', transcript_path: '/t.jsonl' });
    m.applyHook(id, { hook_event_name: 'UserPromptSubmit', session_id: 'other' });
    expect(m.view(id)).toMatchObject({ sessionId: 's2', transcriptPath: '/t.jsonl' });
  });

  it('close leaves no runtime state behind', async () => {
    home = mkdtempSync(join(tmpdir(), 'tl-'));
    m = new NodeManager({ home, shell: '/bin/sh' });
    const { id } = await m.spawn({ kind: 'terminal', title: 't', cwd: tmpdir() });
    m.applyHook(id, { hook_event_name: 'UserPromptSubmit' });
    m.applyHook(id, { hook_event_name: 'Stop' }); // done: unread
    m.setOutcome(id, { outcome: 'succeeded', at: Date.now() });
    m.applyHook(id, { hook_event_name: 'UserPromptSubmit' });
    m.input(id, '\x1b'); // Esc while working arms the interrupt timer
    expect(m.runtimes.get(id)).toMatchObject({ unread: true, outcome: { outcome: 'succeeded' }, interruptTimer: expect.anything() });
    await m.close(id, true);
    expect([...m.runtimes.keys()]).toEqual([]);
  });

  it('shutdown gives up on background work that never settles after its bound', async () => {
    home = mkdtempSync(join(tmpdir(), 'tl-'));
    m = new NodeManager({ home, shell: '/bin/sh', terminateTimeoutMs: 200 });
    const { id } = await m.spawn({ kind: 'terminal', title: 't', cwd: tmpdir() });
    const session = m.session(id)!;
    vi.spyOn(session, 'terminate').mockReturnValue(new Promise(() => {}));
    const start = Date.now();
    await m.shutdown();
    expect(Date.now() - start).toBeLessThan(2000);
    session.kill();
  });
});

describe('NodeManager restart', () => {
  let home = '';
  let m: NodeManager;
  afterEach(async () => { await m.shutdown(); rmSync(home, { recursive: true, force: true }); });

  it('relaunches a terminal node with a new process, same id, children kept; refuses to close a root; prune keeps a live root', async () => {
    home = mkdtempSync(join(tmpdir(), 'tl-'));
    m = new NodeManager({ home, shell: '/bin/sh' });
    const root = (await m.spawn({ kind: 'terminal', title: 'root', cwd: tmpdir() }));
    const kid = (await m.spawn({ kind: 'terminal', title: 'kid', cwd: tmpdir(), parentId: root.id }));
    const pid = m.session(root.id)!.pid;
    expect(m.restart(root.id)).toEqual({ ok: true });
    expect(m.session(root.id)!.pid).not.toBe(pid);
    expect(m.view(root.id)).toMatchObject({ id: root.id, parentId: null, title: 'root', status: { activity: 'restarting' } });
    expect(m.view(kid.id)!.parentId).toBe(root.id);
    expect(m.restart('nope')).toMatchObject({ ok: false });
    await expect(m.close(root.id)).rejects.toThrow(/orchestrator/);
    await m.close(kid.id); // a child closes without force
    expect(await m.prune()).toEqual({ removed: [], kept: [] });
    expect(m.view(root.id)).toBeDefined();
  });

  it('surfaces CLI startup errors after spawn and restart instead of leaving activity at restarting', async () => {
    home = mkdtempSync(join(tmpdir(), 'tl-'));
    const bin = join(home, 'bin'); mkdirSync(bin);
    writeFileSync(join(bin, 'pi'), '#!/bin/sh\nprintf "\\033[31mError: Model not found\\033[0m\\n"\nexit 1\n');
    chmodSync(join(bin, 'pi'), 0o755);
    m = new NodeManager({ home, path: `${bin}:/usr/bin:/bin` });
    const { id } = await m.spawn({ kind: 'agent', harness: 'pi', title: 'bad model', cwd: home, byHuman: true });
    const failed = { exited: true, errored: true, activity: 'Error: Model not found' };
    await expect.poll(() => m.view(id)?.status).toMatchObject(failed);
    expect(m.restart(id)).toEqual({ ok: true });
    await expect.poll(() => m.view(id)?.status).toMatchObject(failed);
  });

  it('gives a Claude node a new session id and keeps at most 10 old ones', () => {
    home = mkdtempSync(join(tmpdir(), 'tl-'));
    m = new NodeManager({ home, shell: '/bin/sh' });
    // A missing cwd makes the launch fail without starting claude; the record and launch arguments are what is under test.
    const id = m.registry.create({ parentId: null, kind: 'claude', title: 'c', cwd: '/no/such/dir', sessionId: 's0' }).id;
    m.runtimes.set(id, {}); // as spawn does
    const first = new Set<string>();
    for (let i = 0; i < 12; i++) { expect(m.restart(id)).toMatchObject({ ok: false }); first.add(m.registry.get(id)!.sessionId!); }
    const rec = m.registry.get(id)!;
    const args = launchArgs({ nodeId: id, nodeDir: '/tmp/n', endpoint: 'http://x', path: '', title: 'c', parentId: null, home, cwd: rec.cwd, sessionId: rec.sessionId! });
    expect(args.slice(0, 2)).toEqual(['--session-id', rec.sessionId]);
    expect(args).not.toContain('s0');
    expect(first.size).toBe(12);
    expect(rec.sessionId).not.toBe('s0');
    expect(rec.previousSessions).toHaveLength(10);
    expect(rec.previousSessions!.at(-1)).toBe([...first][10]);
  });
});

// Controlled PTY callbacks exercise manager policy/lifecycle without launching either CLI or making model requests.
describe('NodeManager harness delegation and lifecycle', () => {
  let home: string;
  let m: NodeManager;
  let exit: (code: number) => void;
  let output: (data: string) => void;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'tl-policy-'));
    m = new NodeManager({ home, shell: '/bin/sh' });
    vi.spyOn(PtySession, 'spawn').mockImplementation(() => ({
      // No real process or trust watcher: callbacks are driven by the tests below.
      exited: true, kill() {}, terminate: async () => true,
      onData(cb: typeof output) { output = cb; }, onExit(cb: typeof exit) { exit = cb; },
    } as unknown as PtySession));
    writeFileSync(join(home, 'agents', 'plain.md'), 'Prompt only.');
  });
  afterEach(async () => { await m.shutdown(); vi.restoreAllMocks(); rmSync(home, { recursive: true, force: true }); });
  const pi = (parentId?: string, extra = {}) => m.spawn({ kind: 'agent', harness: 'pi', title: 'Pi', cwd: home, parentId, ...extra });
  const claude = (extra = {}) => m.spawn({ kind: 'claude', title: 'Claude', cwd: home, byHuman: true, ...extra });

  it('uses portable Tiller defaults on a fresh home without creating configuration', async () => {
    expect(await claude()).toMatchObject({ profile: 'orchestrator', model: 'opus', effort: undefined });
    for (const [profile, model] of [['implementation', 'sonnet'], ['explorer', 'haiku'], ['mechanical', 'haiku']] as const) {
      const node = await claude({ profile });
      expect(node.model).toBe(model);
      expect(node.effort).toBeUndefined();
    }
    expect(await m.spawn({ kind: 'agent', harness: 'codex', title: 'fresh', cwd: home, byHuman: true })).toMatchObject({ model: 'gpt-6-astra', effort: 'medium' });
    expect(await pi(undefined, { byHuman: true })).toMatchObject({ model: undefined, effort: undefined });
    expect(() => readFileSync(join(home, 'config.json'))).toThrow();
  });

  it('selects profiles independently of roles and resolves each spawn field before persisting it', async () => {
    writeFileSync(join(home, 'config.json'), JSON.stringify({
      roles: { worker: { model: 'claude-only', effort: 'max' } },
      profiles: { codex: { implementation: { model: 'impl', effort: 'medium' }, reviewer: { model: 'review', effort: 'high' } }, pi: { implementation: { model: 'pi-model' } } },
    }));
    writeFileSync(join(home, 'agents', 'task.md'), '---\nprofile: reviewer\nmodel: preset-model\n---\nCustom instructions.');
    const spawn = (extra = {}) => m.spawn({ kind: 'agent', harness: 'codex', title: 'Codex', cwd: home, byHuman: true, ...extra });
    const root = await spawn();
    expect(root).toMatchObject({ profile: 'orchestrator' });
    expect(root).toMatchObject({ model: 'gpt-6-astra', effort: 'medium' }); // Claude role settings never leak into Codex
    const child = await spawn({ parentId: root.id, role: 'none' });
    expect(child).toMatchObject({ profile: 'implementation', role: 'none', model: 'impl', effort: 'medium', status: { model: 'impl', effort: 'medium' } });
    expect(await spawn({ parentId: root.id, preset: 'task' })).toMatchObject({ profile: 'reviewer', model: 'preset-model', effort: 'high' });
    expect(await spawn({ parentId: root.id, preset: 'task', profile: 'implementation', effort: 'low' })).toMatchObject({ profile: 'implementation', model: 'preset-model', effort: 'low' });
    expect(await spawn({ parentId: root.id, preset: 'task', model: 'explicit' })).toMatchObject({ profile: 'reviewer', model: 'explicit', effort: 'high' });
    expect(await pi(root.id, { byHuman: true })).toMatchObject({ profile: 'implementation', model: 'pi-model' });
    writeFileSync(join(home, 'agents', 'effort.md'), '---\nprofile: reviewer\neffort: low\n---\nCustom instructions.');
    expect(await spawn({ preset: 'effort' })).toMatchObject({ profile: 'reviewer', model: 'review', effort: 'low' });
    expect(await spawn({ preset: 'effort', effort: 'medium' })).toMatchObject({ model: 'review', effort: 'medium' });
  });

  it('derives profile defaults from effective explicit or preset role, keeping explicit profile highest', async () => {
    writeFileSync(join(home, 'config.json'), JSON.stringify({ profiles: { codex: { orchestrator: { model: 'orchestrator-model' }, implementation: { model: 'implementation-model' }, reviewer: { model: 'review-model' } } } }));
    const spawn = (extra = {}) => m.spawn({ kind: 'agent', harness: 'codex', title: 'role default', cwd: home, byHuman: true, ...extra });
    const parent = await spawn();
    expect(parent).toMatchObject({ profile: 'orchestrator', model: 'orchestrator-model' });
    expect(await spawn({ parentId: parent.id })).toMatchObject({ profile: 'implementation', model: 'implementation-model' });
    expect(await spawn({ parentId: parent.id, role: 'orchestrator' })).toMatchObject({ profile: 'orchestrator', model: 'orchestrator-model' });
    expect(await spawn({ role: 'worker' })).toMatchObject({ profile: 'implementation', model: 'implementation-model' });
    expect(await spawn({ role: 'none' })).toMatchObject({ profile: 'implementation', model: 'implementation-model' });
    writeFileSync(join(home, 'agents', 'coordinator.md'), '---\nrole: orchestrator\n---\nCoordinate.');
    expect(await spawn({ parentId: parent.id, preset: 'coordinator' })).toMatchObject({ profile: 'orchestrator', model: 'orchestrator-model' });
    expect(await spawn({ parentId: parent.id, preset: 'coordinator', role: 'worker' })).toMatchObject({ profile: 'implementation', model: 'implementation-model' });
    expect(await spawn({ parentId: parent.id, preset: 'coordinator', profile: 'reviewer' })).toMatchObject({ profile: 'reviewer', model: 'review-model' });
  });

  it('rejects unsupported explicit and preset Codex effort before records, dependencies or worktrees allocate', async () => {
    writeFileSync(join(home, 'agents', 'max-effort.md'), '---\neffort: max\n---\nTask.');
    const create = vi.spyOn(m.registry, 'create');
    const launch = vi.mocked(PtySession.spawn);
    for (const extra of [{ effort: 'max' as const }, { preset: 'max-effort' }]) {
      for (const delayed of [{}, { afterSuccess: ['missing'] }, { isolation: 'worktree' as const, base: 'should-not-exist' }]) {
        await expect(m.spawn({ kind: 'agent', harness: 'codex', title: 'invalid effort', cwd: home, byHuman: true, ...extra, ...delayed })).rejects.toThrow('unsupported Codex effort: max');
      }
    }
    expect(create).not.toHaveBeenCalled();
    expect(launch).not.toHaveBeenCalled();
    expect(m.registry.list()).toEqual([]);
    expect(await m.spawn({ kind: 'agent', harness: 'codex', title: 'explicit override', cwd: home, byHuman: true, preset: 'max-effort', effort: 'high' })).toMatchObject({ effort: 'high' });
  });

  it('keeps resolved profile/model/effort through disk reload, resume, restart, archive and root followup', async () => {
    const node = await m.spawn({ kind: 'agent', harness: 'codex', title: 'review', cwd: home, byHuman: true, profile: 'reviewer', role: 'worker', model: 'original', effort: 'high' });
    m.registry.flush();
    const { NodeRegistry } = await import('./nodes.js');
    const reloaded = new NodeRegistry(join(home, 'state.json')); reloaded.load();
    expect(reloaded.get(node.id)).toMatchObject({ profile: 'reviewer', model: 'original', effort: 'high' });
    writeFileSync(join(home, 'config.json'), JSON.stringify({ profiles: { codex: { reviewer: { model: 'changed', effort: 'low' } } } }));
    writeFileSync(m.registry.get(node.id)!.transcriptPath!, JSON.stringify({ type: 'codex_session', threadId: 'fake-thread' }) + '\n');
    exit(0);
    expect(await m.resume(node.id)).toEqual({ ok: true });
    expect(m.restart(node.id)).toEqual({ ok: true });
    const lastArgs = vi.mocked(PtySession.spawn).mock.calls.at(-1)!;
    expect(JSON.stringify(lastArgs)).toContain('Review the supplied change');
    expect(JSON.stringify(lastArgs)).toContain('original');
    writeFileSync(m.registry.get(node.id)!.transcriptPath!, JSON.stringify({ type: 'codex_session', threadId: 'new-fake-thread' }) + '\n');
    await m.close(node.id, true);
    const archived = await findArchived(home, node.id);
    expect(archived).toMatchObject({ profile: 'reviewer', model: 'original', effort: 'high' });
    expect(await m.followup(node.id, 'Check again')).toMatchObject({ profile: 'reviewer', model: 'original', effort: 'high', role: 'worker' });
  });

  it('retains a child default profile and explicit role none when followup becomes a root', async () => {
    const parent = await claude();
    const child = await m.spawn({ kind: 'agent', harness: 'codex', parentId: parent.id, title: 'child', cwd: home, byHuman: true, role: 'none' });
    expect(child.profile).toBe('implementation');
    writeFileSync(m.registry.get(child.id)!.transcriptPath!, JSON.stringify({ type: 'codex_session', threadId: 'fake-thread' }) + '\n');
    await m.close(child.id, true);
    await m.close(parent.id, true);
    expect(await m.followup(child.id, 'Continue')).toMatchObject({ parentId: null, profile: 'implementation', role: 'none' });
  });

  it.each(['reviewer', 'explorer'] as const)('launches portable Codex %s instructions without bypassing preset restrictions', async (profile) => {
    const n = await m.spawn({ kind: 'agent', harness: 'codex', title: profile, cwd: home, byHuman: true, profile, role: 'worker' });
    expect(n.profile).toBe(profile);
    expect(JSON.stringify(vi.mocked(PtySession.spawn).mock.calls.at(-1))).toContain('read-only');
    await expect(m.spawn({ kind: 'agent', harness: 'codex', title: profile, cwd: home, byHuman: true, profile, preset: profile === 'reviewer' ? 'reviewer' : 'researcher' })).rejects.toThrow(/does not support Claude preset/);
  });

  it('allows explicit human Pi selection, including beneath a restricted Claude parent', async () => {
    expect(await pi(undefined, { byHuman: true })).toMatchObject({ harness: 'pi', permissionMode: undefined });
    const parent = await claude({ permissionMode: 'plan', preset: 'reviewer' });
    expect(await pi(parent.id, { byHuman: true })).toMatchObject({ harness: 'pi', permissionMode: undefined });
    // Human selection does not silently discard unsupported requested restrictions.
    await expect(pi(parent.id, { byHuman: true, permissionMode: 'plan' })).rejects.toThrow(/does not support Claude permissionMode/);
    // Pi enforces the reviewer's denied tools itself (see harness.test.ts).
    expect(await pi(parent.id, { byHuman: true, preset: 'reviewer' })).toMatchObject({ harness: 'pi', preset: 'reviewer' });
  });

  it('allows Pi parents and inherits their harness, not a Claude permission_mode hook field', async () => {
    const parent = await pi(undefined, { byHuman: true, preset: 'plain' });
    m.applyHook(parent.id, { hook_event_name: 'UserPromptSubmit', permission_mode: 'plan' });
    rmSync(join(home, 'agents', 'plain.md')); // not a restriction; the running Pi remains unrestricted delegation
    delete m.runtimes.get(parent.id)!.launchedPreset; // also irrelevant for a restored Pi parent
    expect(await m.spawn({ kind: 'agent', title: 'child', cwd: home, parentId: parent.id })).toMatchObject({ harness: 'pi', permissionMode: undefined });
  });

  it.each([undefined, 'plain'])('allows bypassPermissions Claude without restrictive preset (%s)', async (preset) => {
    const parent = await claude({ permissionMode: 'bypassPermissions', preset });
    expect(await pi(parent.id, { preset: 'plain' })).toMatchObject({ harness: 'pi', permissionMode: undefined });
  });

  it.each([undefined, 'default', 'plan', 'acceptEdits', 'auto'])('refuses Claude mode %s before allocating a Pi node', async (permissionMode) => {
    const parent = await claude({ permissionMode });
    const count = m.list().length;
    // A child's explicit mode/prompt-only preset must not override the parent's restriction for Pi delegation.
    for (const extra of [{}, { preset: 'plain' }, { permissionMode: 'bypassPermissions' }]) {
      await expect(pi(parent.id, extra)).rejects.toThrow(/unrestricted agent parent/);
    }
    expect(m.list()).toHaveLength(count);
    expect(m.runtimes.size).toBe(count);
  });

  it('checks effective live mode rather than a stale stored or preset mode', async () => {
    writeFileSync(join(home, 'agents', 'mode.md'), '---\npermissionMode: plan\n---\nPlan.');
    const parent = await claude({ preset: 'mode', permissionMode: 'bypassPermissions' });
    m.applyHook(parent.id, { hook_event_name: 'UserPromptSubmit', permission_mode: 'plan' });
    m.registry.update(parent.id, { permissionMode: 'bypassPermissions' }); // deliberately stale record
    await expect(pi(parent.id)).rejects.toThrow(/unrestricted agent parent/);
    m.applyHook(parent.id, { hook_event_name: 'UserPromptSubmit', permission_mode: 'bypassPermissions' });
    m.registry.update(parent.id, { permissionMode: 'plan' });
    expect(await pi(parent.id)).toMatchObject({ harness: 'pi' });
  });

  it.each(['tools: Read', 'tools: []', 'disallowedTools: Write', 'disallowedTools: []', 'maxTurns: 1'])('refuses launched Claude preset restriction %s, even if its file is removed', async (restriction) => {
    const file = join(home, 'agents', 'limited.md');
    writeFileSync(file, `---\n${restriction}\n---\nLimited.`);
    const parent = await claude({ permissionMode: 'bypassPermissions', preset: 'limited' });
    writeFileSync(file, 'Now only a prompt.');
    await expect(pi(parent.id, { preset: 'plain' })).rejects.toThrow(/no preset tools/);
    rmSync(file);
    await expect(pi(parent.id)).rejects.toThrow(/no preset tools/);
    expect(await pi(parent.id, { byHuman: true })).toMatchObject({ harness: 'pi' });
    writeFileSync(file, 'Now only a prompt.');
    expect(m.restart(parent.id)).toEqual({ ok: true }); // a new launch really did drop the old restrictions
    expect(await pi(parent.id)).toMatchObject({ harness: 'pi' });
  });

  it('fails closed for restored Claude preset parents until a new launch establishes the exact restrictions', async () => {
    const file = join(home, 'agents', 'limited.md');
    writeFileSync(file, '---\ntools: Read\n---\nLimited.');
    const parent = await claude({ preset: 'limited', permissionMode: 'bypassPermissions' });
    await m.shutdown();
    m = new NodeManager({ home, shell: '/bin/sh' }); // restored record, no launch snapshot
    expect(m.runtimes.get(parent.id)!.launchedPreset).toBeUndefined();
    writeFileSync(file, 'Now only a prompt.'); // cannot establish what the previous CLI was restricted to
    await expect(pi(parent.id)).rejects.toThrow(/preset restrictions are unknown/);
    rmSync(file);
    await expect(pi(parent.id)).rejects.toThrow(/preset restrictions are unknown/);
    expect(await pi(parent.id, { byHuman: true })).toMatchObject({ harness: 'pi' });
    writeFileSync(file, 'Now only a prompt.');
    expect(m.restart(parent.id)).toEqual({ ok: true });
    expect(await pi(parent.id)).toMatchObject({ harness: 'pi' });
  });

  it('also rejects an unlaunched Claude prompt-only preset because its launch restrictions are unknown', async () => {
    const parent = await claude({ preset: 'plain', permissionMode: 'bypassPermissions' });
    delete m.runtimes.get(parent.id)!.launchedPreset; // armed/unlaunched runtime has no trustworthy snapshot
    await expect(pi(parent.id)).rejects.toThrow(/preset restrictions are unknown/);
  });

  it('requires a known unrestricted agent parent for nonhuman Pi requests', async () => {
    await expect(pi()).rejects.toThrow(/only the human/);
    await expect(pi('missing')).rejects.toThrow(/only the human/);
    const parent = await m.spawn({ kind: 'terminal', title: 'terminal', cwd: home, permissionMode: 'bypassPermissions', byHuman: true });
    await expect(pi(parent.id)).rejects.toThrow(/only the human/);
  });

  it('preserves Claude inheritance and explicit override policy; allowed Pi delegation still rejects a requested mode', async () => {
    const parent = await claude({ permissionMode: 'plan' });
    expect(await claude({ parentId: parent.id, byHuman: false })).toMatchObject({ permissionMode: 'plan' });
    expect(await claude({ parentId: parent.id, byHuman: false, permissionMode: 'acceptEdits' })).toMatchObject({ permissionMode: 'acceptEdits' });
    await expect(claude({ parentId: parent.id, byHuman: false, permissionMode: 'bypassPermissions' })).rejects.toThrow(/only the human/);
    m.applyHook(parent.id, { hook_event_name: 'UserPromptSubmit', permission_mode: 'bypassPermissions' });
    await expect(pi(parent.id, { permissionMode: 'plan' })).rejects.toThrow(/does not support Claude permissionMode/);
    await expect(pi(parent.id, { permissionMode: 'bypassPermissions' })).rejects.toThrow(/only the human/);
  });

  it.each(['claude', 'agent'] as const)('ignores %s Claude mod turn.start before hooks and after tool, dialog and completion events', async (kind) => {
    const { id } = await claude({ kind, prompt: 'work' });
    const modStart = () => m.applyModEvent(id, { event: 'turn.start', payload: { text: 'work', turnId: 'mod-id' } });
    const unchanged = () => {
      const prev = m.runtimes.get(id)!.status;
      const rt = m.runtimes.get(id)!;
      const before = { lastHookAt: rt.lastHookAt, turnStart: rt.turnStart, starting: rt.starting };
      modStart();
      expect(m.runtimes.get(id)!.status).toBe(prev);
      expect({ lastHookAt: rt.lastHookAt, turnStart: rt.turnStart, starting: rt.starting }).toEqual(before);
    };
    unchanged(); // no mod-start transition even before UserPromptSubmit
    m.applyHook(id, { hook_event_name: 'UserPromptSubmit', prompt_id: 'hook-id' });
    m.applyHook(id, { hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: { file_path: '/a.ts' } });
    unchanged();
    m.applyHook(id, { hook_event_name: 'PermissionRequest', tool_name: 'Bash' });
    unchanged(); // cannot clear a blocked dialog
    m.applyModEvent(id, { event: 'turn.complete', payload: { answer: 'Finished.', durationMs: 10, isAborted: false, turnId: 'mod-id', reason: 'answer' } });
    unchanged(); // cannot resurrect an ended turn
    expect(m.view(id)!.status).toMatchObject({ state: 'done', promptId: 'hook-id' });
    expect(m.view(id)!.status.lastAssistantMessage).toBeUndefined(); // the Stop hook owns Claude's answer
  });

  it('leaves a settled Claude status untouched on a late mod turn.complete', async () => {
    const { id } = await claude({ prompt: 'work' });
    m.applyHook(id, { hook_event_name: 'UserPromptSubmit', prompt_id: 'hook-id' });
    m.applyHook(id, { hook_event_name: 'Stop', last_assistant_message: 'From the hook.' });
    const prev = m.runtimes.get(id)!.status;
    expect(prev).toMatchObject({ state: 'done', lastAssistantMessage: 'From the hook.' });
    m.applyModEvent(id, { event: 'turn.complete', payload: { answer: 'From the mod.', durationMs: 10, isAborted: false, turnId: 'mod-id', reason: 'answer' } });
    expect(m.runtimes.get(id)!.status).toBe(prev);
  });

  it('accepts Pi native turn.start as a turn boundary and settles normally', async () => {
    const { id } = await pi(undefined, { byHuman: true, prompt: 'work' });
    m.setStatus(id, { state: 'done', changedAt: 1, errored: true, lastAssistantMessage: 'old' }, false);
    m.applyModEvent(id, { event: 'turn.start', payload: { text: 'work', turnId: 'pi-id' } });
    expect(m.view(id)!.status).toMatchObject({ state: 'working', promptId: 'pi-id' });
    expect(m.view(id)!.status.errored).toBeUndefined();
    expect(m.view(id)!.status.lastAssistantMessage).toBeUndefined();
    expect(m.runtimes.get(id)).toMatchObject({ starting: false, lastHookAt: expect.any(Number), turnStart: expect.any(Number) });
    m.applyModEvent(id, { event: 'turn.complete', payload: { answer: 'Finished.', durationMs: 10, isAborted: false, turnId: 'pi-id', reason: 'answer' } });
    expect(m.view(id)!.status).toMatchObject({ state: 'done', lastAssistantMessage: 'Finished.' });
  });

  it.each(['unknown', 'done', 'working'] as const)('records model-select measurements without changing %s state, including on archive', async (state) => {
    const { id } = await pi(undefined, { byHuman: true, model: 'old-provider/model' });
    const prev: NodeStatus = Object.freeze({ state, changedAt: 1, model: 'old-provider/model', lastAssistantMessage: 'answer', activity: 'old activity' });
    m.setStatus(id, prev, false);
    // Idle model selection need not start another turn before the new model is archived.
    const payload = { model: 'new-provider/model', context: undefined };
    m.applyModEvent(id, { event: 'session.measure', payload });
    expect(m.view(id)!.status).toMatchObject({ state, changedAt: 1, model: 'new-provider/model', lastAssistantMessage: 'answer', activity: 'old activity' });
    expect(prev.model).toBe('old-provider/model');
    expect(m.runtimes.get(id)!.turnStart).toBeUndefined();
    m.applyModEvent(id, { event: 'session.measure', payload: { cost: { usd: 0.5 } } });
    expect(m.view(id)!.status).toMatchObject({ state, changedAt: 1, model: 'new-provider/model' });
    await m.close(id, true);
    expect(await findArchived(home, id)).toMatchObject({ model: 'new-provider/model' });
  });

  it.each([
    ['terminal', undefined], ['claude', undefined], ['agent', 'claude'], ['agent', 'pi'],
  ] as const)('keeps %s/%s exit semantics and does not mutate previous status', async (kind, harness) => {
    const { id } = await m.spawn({ kind, harness, title: 'exit', cwd: home, byHuman: true });
    const prev: NodeStatus = Object.freeze({ state: kind === 'terminal' ? 'none' : 'unknown', exited: true, changedAt: 1, activity: 'previous activity' });
    m.setStatus(id, prev, false); // ptyExited returns this exact status when it is already marked exited
    output('\u001b[31mError: launch failed\u001b[0m\r\n');
    exit(7);
    expect(prev).toEqual({ state: kind === 'terminal' ? 'none' : 'unknown', exited: true, changedAt: 1, activity: 'previous activity' });
    if (harness === 'pi') {
      expect(m.view(id)!.status).toMatchObject({ exited: true, errored: true, activity: 'Error: launch failed' });
      expect(m.view(id)!.status).not.toBe(prev);
    } else expect(m.runtimes.get(id)!.status).toBe(prev);
  });

  it.each([0, 3])('reports Pi exit %s immutably, with generic error fallback and clean activity clearing', async (code) => {
    const { id } = await pi(undefined, { byHuman: true });
    const prev: NodeStatus = Object.freeze({ state: 'done', exited: true, changedAt: 1, activity: 'old' });
    m.setStatus(id, prev, false);
    output('ordinary output\r\n');
    exit(code);
    expect(m.view(id)!.status).toMatchObject({ exited: true, activity: code ? 'Process exited with code 3' : undefined });
    expect(m.view(id)!.status.errored).toBe(code ? true : undefined);
    expect(prev.activity).toBe('old');
    expect(m.view(id)!.status).not.toBe(prev);
  });

  it.each([0, 1])('shows the adapter\'s activation refusal on a Pi exit %s', async (code) => {
    const { id } = await pi(undefined, { byHuman: true });
    output('\u001b[2J pi starting\r\n\u001b[31m[tiller] tiller: incompatible Pi build (missing native Pi 1.2.x events (version 0.87.1)); not activating\u001b[0m\r\n');
    output('\u001b[?1049lbye\r\n');
    exit(code);
    expect(m.view(id)!.status).toMatchObject({
      exited: true, errored: true, activity: 'tiller: incompatible Pi build (missing native Pi 1.2.x events (version 0.87.1)); not activating',
    });
  });

  it('finishes an active Pi on a failing PTY exit without mutating its working status', async () => {
    const { id } = await pi(undefined, { byHuman: true });
    const prev: NodeStatus = Object.freeze({ state: 'working', changedAt: 1, activity: 'tool running' });
    m.setStatus(id, prev, false);
    exit(3);
    expect(m.view(id)!.status).toMatchObject({ state: 'done', doneSource: 'exit', exited: true, errored: true, activity: 'Process exited with code 3' });
    expect(prev).toEqual({ state: 'working', changedAt: 1, activity: 'tool running' });
  });

  it.each(['terminal', 'claude', 'agent'] as const)('preserves active %s exit transition without adding errors', async (kind) => {
    const { id } = await m.spawn({ kind, title: 'exit', cwd: home, byHuman: true });
    const prev: NodeStatus = Object.freeze({ state: 'working', changedAt: 1, activity: 'doing work', interrupted: true });
    m.setStatus(id, prev, false);
    exit(3);
    expect(m.view(id)!.status).toMatchObject({ state: 'done', doneSource: 'exit', exited: true, interrupted: true, activity: undefined });
    expect(m.view(id)!.status.errored).toBeUndefined();
    expect(prev).toMatchObject({ state: 'working', activity: 'doing work' });
  });
});

describe('NodeManager model and effort defaults', () => {
  let home = '';
  let m: NodeManager;
  afterEach(async () => { await m.shutdown(); rmSync(home, { recursive: true, force: true }); });

  it('records the configured model for the role unless spawn passes one; project beats home', async () => {
    home = mkdtempSync(join(tmpdir(), 'tl-'));
    const proj = join(home, 'proj');
    mkdirSync(join(proj, '.tiller'), { recursive: true });
    writeFileSync(join(home, 'config.json'), JSON.stringify({ roles: { orchestrator: { model: 'opus' }, worker: { model: 'sonnet' } } }));
    writeFileSync(join(proj, '.tiller', 'config.json'), JSON.stringify({ roles: { worker: { model: 'haiku' } } }));
    m = new NodeManager(fakeClaude(home));
    const model = async (req: { parentId?: string; model?: string; role?: 'none' }) => m.registry.get((await m.spawn({ kind: 'claude', title: 'c', cwd: proj, ...req })).id)!.model;
    const root = (await m.spawn({ kind: 'claude', title: 'root', cwd: proj }));
    expect(m.registry.get(root.id)!.model).toBe('opus');        // orchestrator: home file
    expect(await model({ parentId: root.id })).toBe('haiku');         // worker: project file
    expect(await model({ role: 'none' })).toBe('haiku');              // none counts as worker
    expect(await model({ parentId: root.id, model: 'x' })).toBe('x'); // explicit spawn argument
    expect(m.registry.get((await m.spawn({ kind: 'terminal', title: 't', cwd: proj })).id)!.model).toBeUndefined();
  });

  it('resolves effort from spawn, then the project file, then the home file, and passes it to claude as --effort', async () => {
    home = mkdtempSync(join(tmpdir(), 'tl-'));
    const proj = join(home, 'proj'), other = join(home, 'other');
    mkdirSync(join(proj, '.tiller'), { recursive: true });
    mkdirSync(other);
    writeFileSync(join(home, 'config.json'), JSON.stringify({ roles: { orchestrator: { effort: 'max' }, worker: { effort: 'high' } } }));
    writeFileSync(join(proj, '.tiller', 'config.json'), JSON.stringify({ roles: { worker: { effort: 'low' } } }));
    // Fake claude: writes its argv next to the node's settings.json, then idles.
    m = new NodeManager(fakeClaude(home, 'for a in "$@"; do case "$prev" in --settings) out="$(dirname "$a")/argv";; esac; prev="$a"; done\necho "$@" > "$out"\nsleep 5'));
    const root = (await m.spawn({ kind: 'claude', title: 'root', cwd: proj }));
    const spawn = async (req: { cwd?: string; effort?: 'medium' }) => m.registry.get((await m.spawn({ kind: 'claude', title: 'c', cwd: proj, parentId: root.id, ...req })).id)!;
    expect(m.registry.get(root.id)!.effort).toBe('max');            // orchestrator: home file
    const fromProject = await spawn({});
    expect(fromProject.effort).toBe('low');                          // worker: project beats home
    expect((await spawn({ cwd: other })).effort).toBe('high');               // no project file: home
    expect((await spawn({ effort: 'medium' })).effort).toBe('medium');       // explicit spawn argument
    const argvFile = join(home, 'nodes', fromProject.id, 'argv');
    await expect.poll(() => { try { return readFileSync(argvFile, 'utf8'); } catch { return ''; } }).toContain('--effort low');
  });
});

describe('NodeManager live set and resume on start', () => {
  let home = '';
  let m: NodeManager;
  afterEach(async () => { await m.shutdown(); rmSync(home, { recursive: true, force: true }); });
  const saved = () => JSON.parse(readFileSync(join(home, 'state.json'), 'utf8')).live;

  it('saves the live ids as processes start and exit, keeps them on shutdown and clears them on an explicit stop', async () => {
    home = mkdtempSync(join(tmpdir(), 'tl-'));
    m = new NodeManager({ home, shell: '/bin/sh' });
    const a = (await m.spawn({ kind: 'terminal', title: 'a', cwd: tmpdir() }));
    const b = (await m.spawn({ kind: 'terminal', title: 'b', cwd: tmpdir(), parentId: a.id }));
    await expect.poll(saved).toEqual([a.id, b.id]);
    process.kill(m.session(b.id)!.pid, 'SIGKILL');
    await expect.poll(saved).toEqual([a.id]);
    m.shutdown(); // like SIGTERM: the set survives the PTYs' exits
    await new Promise((r) => setTimeout(r, 200));
    expect(saved()).toEqual([a.id]);
    m = new NodeManager({ home, shell: '/bin/sh' });
    m.shutdown({ clearLive: true }); // tl stop
    expect(saved()).toEqual([]);
  });

  it('resumes live Claude nodes parents first, skipping missing, idle and worktree-less ones, then forgets the set', async () => {
    home = mkdtempSync(join(tmpdir(), 'tl-'));
    const opts = fakeClaude(home);
    const transcript = join(home, 't.jsonl');
    writeFileSync(transcript, '');
    const now = Date.now(), day = 86_400_000;
    const rec = (id: string, parentId: string | null, extra = {}) => ({ id, parentId, kind: 'claude', title: id, cwd: home, createdAt: now - 30 * day, lastActiveAt: now, sessionId: `s-${id}`, transcriptPath: transcript, ...extra });
    const nodes = [
      rec('kid', 'root'), rec('root', null), rec('idle', 'root', { lastActiveAt: now - 4 * day }),
      rec('nowt', 'root', { worktree: { repo: home, path: join(home, 'gone'), branch: 'tl/nowt', base: 'main', baseSha: 'x' } }),
      rec('exited', 'root'), // not in the live set
    ];
    writeFileSync(join(home, 'state.json'), JSON.stringify({ version: 1, nodes, live: ['kid', 'root', 'idle', 'nowt', 'deleted'] }));
    m = new NodeManager(opts);
    const order: string[] = [];
    const resume = m.resume.bind(m);
    m.resume = (id) => { order.push(id); return resume(id); };
    expect(await m.resumeLive()).toBe('resume on start: resumed 2, skipped 3: deleted (no such node), idle (idle over 3 days), nowt (worktree missing)');
    expect(order).toEqual(['root', 'kid', 'nowt']);
    expect(m.view('root')!.status.exited).toBeFalsy();
    expect(m.view('kid')).toMatchObject({ sessionId: 's-kid' });
    expect(m.view('idle')!.status.exited).toBe(true);
    await expect.poll(() => saved().sort()).toEqual(['kid', 'root']); // only what came back up
    expect(await m.resumeLive()).toBe('resume on start: nothing to resume');
  });
});

describe('NodeManager guardrails', () => {
  let home = '';
  let m: NodeManager;
  afterEach(async () => { vi.useRealTimers(); await m.shutdown(); rmSync(home, { recursive: true, force: true }); });

  it('refuses an agent spawn at each cap, naming it; the human is exempt', async () => {
    home = mkdtempSync(join(tmpdir(), 'tl-'));
    const proj = join(home, 'proj');
    mkdirSync(join(proj, '.tiller'), { recursive: true });
    writeFileSync(join(proj, '.tiller', 'config.json'), JSON.stringify({ limits: { maxDepth: 2, maxChildren: 2 } }));
    writeFileSync(join(home, 'config.json'), JSON.stringify({ daemon: { maxLiveNodes: 4 } }));
    m = new NodeManager({ home, shell: '/bin/sh' });
    const spawn = async (parentId: string | null, byHuman = false) => (await m.spawn({ kind: 'terminal', title: 't', cwd: proj, parentId, byHuman })).id;
    const root = await spawn(null, true);
    const c1 = await spawn(root);
    await spawn(root);
    await expect(spawn(root)).rejects.toThrow('refused: limits.maxChildren is 2 and ' + root + ' has 2 live children; reuse an idle worker (send it the work) or close finished ones');
    const c3 = await spawn(root, true); // the human is exempt; 4 live now
    await expect(spawn(c1)).rejects.toThrow(/^refused: daemon\.maxLiveNodes is 4 and 4 nodes are live; reuse an idle worker/);
    await m.close(c3);
    const g = await spawn(c1); // depth 2 is allowed
    await expect(spawn(g)).rejects.toThrow(/^refused: limits\.maxDepth is 2 and the new node would be 3 levels below the root; reuse/);
    expect(m.list()).toHaveLength(4); // nothing was created by the refusals
  });

  it('keeps each node\'s spend across a session restart and a daemon restart', async () => {
    vi.useFakeTimers({ toFake: ['Date'], now: new Date('2026-06-01T12:00:00') }); // a fixed day, even across midnight
    home = mkdtempSync(join(tmpdir(), 'tl-'));
    const opts = fakeClaude(home);
    m = new NodeManager(opts);
    const id = (await m.spawn({ kind: 'claude', title: 'c', cwd: home, byHuman: true })).id;
    const measure = (usd: number) => m.applyModEvent(id, { event: 'session.measure', payload: { cost: { usd } } });
    measure(0.5);
    measure(0.8);  // session totals: +0.3
    expect(m.restart(id)).toEqual({ ok: true });
    measure(0.25); // a fresh session counts from zero
    expect(m.view(id)).toMatchObject({ spentUsd: 1.05, status: { costUsd: 0.25 } });
    m.shutdown();
    m = new NodeManager(opts);
    expect(m.view(id)!.spentUsd).toBeCloseTo(1.05);
    expect(m.view(id)!.spentToday).toEqual({ day: '2026-06-01', usd: expect.closeTo(1.05) });
    measure(0.1); // the resumed node's first measure after the daemon restart
    expect(m.view(id)!.spentUsd).toBeCloseTo(1.15);
  });

  it('does not count a resumed session\'s earlier spend again after a daemon restart', async () => {
    home = mkdtempSync(join(tmpdir(), 'tl-'));
    const opts = fakeClaude(home);
    m = new NodeManager(opts);
    const id = (await m.spawn({ kind: 'claude', title: 'c', cwd: home, byHuman: true })).id;
    const measure = (usd: number) => m.applyModEvent(id, { event: 'session.measure', payload: { cost: { usd } } });
    measure(0.5);
    measure(0.8);
    m.shutdown();
    m = new NodeManager(opts);
    measure(1.0); // the same session, resumed: its cost keeps counting from 0.8
    expect(m.view(id)!.spentUsd).toBeCloseTo(1.0);
  });

  it('marks spend incomplete when a measure says some usage had no price, and only then', async () => {
    vi.useFakeTimers({ toFake: ['Date'], now: new Date('2026-06-01T12:00:00') }); // a fixed day, even across midnight
    const day = '2026-06-01';
    home = mkdtempSync(join(tmpdir(), 'tl-'));
    m = new NodeManager(fakeClaude(home));
    const unpriced = (await m.spawn({ kind: 'claude', title: 'unpriced', cwd: home, byHuman: true })).id;
    const priced = (await m.spawn({ kind: 'claude', title: 'priced', cwd: home, byHuman: true })).id;
    // Unpriced usage only: no known amount yet, but not a known $0.
    m.applyModEvent(unpriced, { event: 'session.measure', payload: { cost: { usd: 0, incomplete: true, unpricedAdded: true } } });
    expect(m.view(unpriced)).toMatchObject({ spentUsd: 0, spentIncomplete: true, spentToday: { day, usd: 0, incomplete: true } });
    m.applyModEvent(unpriced, { event: 'session.measure', payload: { cost: { usd: 0.2, incomplete: true } } });
    expect(m.view(unpriced)).toMatchObject({ spentUsd: 0.2, spentIncomplete: true, spentToday: { day, usd: 0.2, incomplete: true } });
    // The next day: the session is still incomplete, but nothing unpriced was added today.
    m.registry.update(unpriced, { spentToday: { day: '2000-01-01', usd: 0.2, incomplete: true } });
    m.applyModEvent(unpriced, { event: 'session.measure', payload: { cost: { usd: 0.3, incomplete: true } } });
    expect(m.view(unpriced)).toMatchObject({ spentUsd: expect.closeTo(0.3), spentIncomplete: true, spentToday: { day, usd: expect.closeTo(0.1) } });
    expect(m.view(unpriced)!.spentToday!.incomplete).toBeUndefined();
    m.applyModEvent(unpriced, { event: 'session.measure', payload: { cost: { usd: 0.3, incomplete: true, unpricedAdded: true } } });
    expect(m.view(unpriced)!.spentToday).toMatchObject({ day, incomplete: true });
    // A measure without the flag (Claude, Codex, or a fully priced Pi session) leaves spend complete.
    m.applyModEvent(priced, { event: 'session.measure', payload: { cost: { usd: 0.5 } } });
    expect(m.view(priced)).toMatchObject({ spentUsd: 0.5, spentToday: { day, usd: 0.5 } });
    expect(m.view(priced)!.spentIncomplete).toBeUndefined();
    expect(m.view(priced)!.spentToday!.incomplete).toBeUndefined();
  });
});

describe('restart drain and the cut-off message', () => {
  let home = '';
  let m: NodeManager;
  const old: NodeManager[] = [];
  afterEach(async () => { await Promise.all([m, ...old.splice(0)].map((x) => x.shutdown())); rmSync(home, { recursive: true, force: true }); });

  /** Fake claude in a temp home; `claude(title)` spawns one with a resumable transcript. */
  async function setup() {
    home = mkdtempSync(join(tmpdir(), 'tl-drain-'));
    const opts = { ...fakeClaude(home, 'sleep 30'), home: join(home, 'tl') };
    m = new NodeManager(opts);
    const claude = async (title: string, extra = {}) => {
      const { id } = await m.spawn({ kind: 'claude', title, cwd: home, byHuman: true, ...extra });
      const transcript = join(home, `${id}.jsonl`);
      writeFileSync(transcript, '');
      m.applyHook(id, { hook_event_name: 'SessionStart', session_id: m.registry.get(id)!.sessionId, transcript_path: transcript });
      return id;
    };
    const restart = async (o: { crash?: boolean } = {}) => {
      if (o.crash) { m.registry.flush(); old.push(m); } // the old process dies without its shutdown
      else {
        await m.shutdown();
        // What the PTYs' exits then do (the fake's sleep outlives the hangup), and the save that could follow.
        for (const v of m.list()) m.setStatus(v.id, { ...v.status, state: 'done', exited: true, changedAt: Date.now() }, false);
        await new Promise((r) => setTimeout(r, 100));
      }
      m = new NodeManager(opts);
      return m.resumeLive();
    };
    return { claude, restart };
  }

  it('waits for working agents but not the excluded one, and holds a spawn until after the restart', async () => {
    const { claude, restart } = await setup();
    const a = await claude('a'), b = await claude('b'), idle = await claude('idle');
    m.applyHook(a, { hook_event_name: 'UserPromptSubmit' });
    m.applyHook(b, { hook_event_name: 'UserPromptSubmit' });
    expect(m.drain('tl reload', b).waiting).toEqual([{ id: a, title: 'a' }]); // b runs tl reload; idle is not working
    const c = (await m.spawn({ kind: 'claude', title: 'c', cwd: home, prompt: 'go', byHuman: true, now: true })).id;
    await new Promise((r) => setTimeout(r, 20));
    expect(m.view(c)!.status).toMatchObject({ state: 'queued', activity: 'queued: the daemon is waiting to restart' });
    expect(m.session(c)).toBeUndefined();
    m.applyHook(a, { hook_event_name: 'Stop' });
    expect(m.drain('tl reload').waiting).toEqual([]);
    expect(m.session(idle)).toBeDefined();
    await restart();
    await expect.poll(() => !!m.session(c)).toBe(true); // launched by the new daemon
  });

  it('waits for a node whose mod claimed a message just before the drain, for at most 30 s', async () => {
    const { claude } = await setup();
    const a = await claude('a');
    const sent = await deliver(m, 'human', a, 'go', { inbox: true });
    expect(inbox(m, a)).toHaveLength(1);
    expect(claim(m, a, sent.messageId!)).toBe(true); // the turn it starts has no hook yet
    expect(m.drain('tl reload').waiting).toEqual([{ id: a, title: 'a' }]);
    vi.useFakeTimers({ toFake: ['Date'], now: Date.now() + 31_000 });
    try { expect(m.drain('tl reload').waiting).toEqual([]); } finally { vi.useRealTimers(); } // a dead mod does not hold it
    expect(ack(m, a, sent.messageId!)).toBe(true);
    expect(m.drain('tl reload').waiting).toEqual([]);
  });

  it('a drain that ends without a restart releases the held spawn', async () => {
    await setup();
    m.drain('tl reload');
    const c = (await m.spawn({ kind: 'claude', title: 'c', cwd: home, byHuman: true })).id;
    expect(m.view(c)!.status.state).toBe('queued');
    m.endDrain();
    await expect.poll(() => !!m.session(c)).toBe(true);
  });

  it('tells resumed working and blocked nodes once that their turn was cut off, and no idle, done or terminal node', async () => {
    const { claude, restart } = await setup();
    const working = await claude('working'), blocked = await claude('blocked'), done = await claude('done'), idle = await claude('idle');
    const term = (await m.spawn({ kind: 'terminal', title: 'term', cwd: home })).id;
    m.applyHook(working, { hook_event_name: 'UserPromptSubmit' });
    m.applyHook(blocked, { hook_event_name: 'UserPromptSubmit' });
    m.applyHook(blocked, { hook_event_name: 'PermissionRequest', tool_name: 'Bash' });
    m.applyHook(done, { hook_event_name: 'UserPromptSubmit' });
    m.applyHook(done, { hook_event_name: 'Stop' });
    m.drain('update to v9.9.9');
    expect(await restart()).toContain('told 2 nodes their turn was cut off');
    const texts = (id: string) => inbox(m, id).map((x) => x.text);
    for (const id of [working, blocked]) expect(texts(id)).toEqual([expect.stringContaining(cutOffText('update to v9.9.9'))]);
    for (const id of [done, idle, term]) expect(texts(id)).toEqual([]);
    expect(m.registry.list().some((n) => n.midTurn)).toBe(false);
    await restart(); // the resumed nodes have not started a turn: nothing new
    for (const id of [working, blocked]) expect(texts(id)).toHaveLength(1); // the first one, still queued
  });

  it('keeps midTurn on a resumed node that starts a turn while the other nodes resume', async () => {
    const { claude, restart } = await setup();
    const first = await claude('first');
    await claude('second');
    m.applyHook(first, { hook_event_name: 'UserPromptSubmit' });
    const proto = NodeManager.prototype, resume = proto.resume;
    // The first node takes a held message at once, before resumeLive reaches the second.
    vi.spyOn(proto, 'resume').mockImplementation(async function (this: NodeManager, id: string) {
      const r = await resume.call(this, id);
      if (id === first) this.applyHook(id, { hook_event_name: 'UserPromptSubmit' });
      return r;
    });
    try { await restart(); } finally { vi.restoreAllMocks(); }
    expect(m.registry.get(first)!.midTurn).toBe(true);
    expect(inbox(m, first)).toHaveLength(1); // still told, once
  });

  it('covers a crash: the turn in progress is persisted, and the message says the exit was unexpected', async () => {
    const { claude, restart } = await setup();
    const working = await claude('working');
    m.applyHook(working, { hook_event_name: 'UserPromptSubmit' });
    await restart({ crash: true });
    expect(inbox(m, working).map((x) => x.text)).toEqual([expect.stringContaining(cutOffText('unexpected exit'))]);
  });
});
