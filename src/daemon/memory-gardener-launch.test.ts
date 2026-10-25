// The memory gardener through the NodeManager (memory v3, W3): its spawn, launch, caps, hooks, measures and refusals,
// with a real memory store and a fake PtySession, as accounts.test.ts does.
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ModEvent } from '../shared/protocol.js';
import { gardenerSystemPrompt } from './gardener.js';
import { GARDENER_REFUSAL } from './lifecycle-guards.js';
import { NodeManager } from './manager.js';
import { MemoryStore } from './memory-store.js';
import { PtySession, type SpawnOpts } from './pty.js';
import { repoKeySync } from './worktree.js';

/** A PTY whose exit, like node-pty's, arrives in a later task than the kill. */
class FakeSession {
  exited = false;
  terminated = false;
  private killed = false;
  private exits: Array<(code: number) => void> = [];
  constructor(readonly opts: SpawnOpts) {}
  onData() {}
  onExit(cb: (code: number) => void) { this.exits.push(cb); }
  async flush() {}
  screenTail() { return []; }
  async write() {}
  kill() {
    if (this.killed) return;
    this.killed = true;
    setImmediate(() => { this.exited = true; for (const cb of this.exits) cb(0); });
  }
  terminate() {
    this.terminated = true;
    return new Promise<boolean>((ok) => { this.onExit(() => ok(true)); this.kill(); });
  }
}

const TOOLS = ['mcp__tiller__garden_list', 'mcp__tiller__garden_get', 'mcp__tiller__garden_merge', 'mcp__tiller__garden_supersede'];
const agent = { kind: 'agent' as const, nodeId: 'n-seed', rootId: 'n-seed' };

let dir: string, home: string, repo: string, workDir: string, m: NodeManager, processes: FakeSession[];
/** Runs before each fake process is returned to launch: the earliest a real one could act is a later task. */
let onSpawn: (s: FakeSession) => void;

beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'tl-gardener-launch-')));
  vi.stubEnv('HOME', dir); // ~/.claude.json is the test's
  for (const k of Object.keys(process.env)) if (k.startsWith('TL_')) vi.stubEnv(k, undefined); // when the suite runs inside a tiller node
  const bin = join(dir, 'bin');
  mkdirSync(bin);
  writeFileSync(join(bin, 'claude'), '#!/bin/sh\n');
  chmodSync(join(bin, 'claude'), 0o755);
  home = join(dir, 'tl'); repo = join(dir, 'repo'); workDir = join(dir, '.claude-work');
  mkdirSync(repo); mkdirSync(workDir);
  for (const json of [join(dir, '.claude.json'), join(workDir, '.claude.json')]) writeFileSync(json, JSON.stringify({ projects: { [repo]: { hasTrustDialogAccepted: true } } }));
  processes = [];
  onSpawn = () => {};
  vi.spyOn(PtySession, 'spawn').mockImplementation((opts) => { const s = new FakeSession(opts); processes.push(s); onSpawn(s); return s as unknown as PtySession; });
  vi.spyOn(console, 'log').mockImplementation(() => {});
  m = new NodeManager({ home, path: `${bin}:/usr/bin:/bin` });
  configure();
});
afterEach(async () => { await m.shutdown(); vi.restoreAllMocks(); vi.unstubAllEnvs(); rmSync(dir, { recursive: true, force: true }); });

function configure(extra: Record<string, unknown> = {}) {
  writeFileSync(join(home, 'config.json'), JSON.stringify({ memory: { enabled: true }, claude: { accounts: [{ name: 'work', configDir: '~/.claude-work' }] }, ...extra }));
}
/** Two agent pitfalls that state one fact, in this account's memory of the repo. */
function seed(account?: string): number[] {
  const scope = { ...(account ? { account } : {}), repoKey: repoKeySync(repo), repoPath: repo };
  return ['webpack build fails because node modules cache holds stale lockfile', 'webpack build fails because the node modules cache holds a stale lockfile']
    .map((text) => m.memory.add(scope, agent, { kind: 'pitfall', text }).id);
}
/** A manual run, as tl memory garden run does; returns the run and its node. */
async function run(account?: string) {
  const r = await m.gardener.runNow({ repoPath: repo, ...(account ? { account } : {}) });
  if (!r.ok) throw new Error(r.reason);
  return { runId: r.run.id, id: r.run.nodeId!, account };
}
const state = (runId: number, account?: string) => m.memory.run(account, runId);
const ended = (runId: number, account?: string) => vi.waitFor(() => { expect(state(runId, account).endedAt).toBeDefined(); return state(runId, account); });
const measure = (usd: number): ModEvent => ({ event: 'session.measure', payload: { cost: { usd } } } as ModEvent);

describe('the gardener node', () => {
  it('launches with the S0 command line and env, the pinned fields, muted and outside every cap', async () => {
    // A project config and a home config that would change an ordinary spawn's isolation, effort and model.
    mkdirSync(join(repo, '.tiller'));
    writeFileSync(join(repo, '.tiller', 'config.json'), JSON.stringify({ worktrees: { isolation: 'worktree' }, roles: { worker: { model: 'opus', effort: 'max' } }, profiles: { claude: { implementation: { model: 'opus', effort: 'max' } } } }));
    mkdirSync(join(repo, '.tiller', 'agents'), { recursive: true });
    writeFileSync(join(repo, '.tiller', 'agents', 'tiller-gardener.md'), '---\nname: tiller-gardener\ntools: [Bash]\n---\nrun anything\n');
    configure({ daemon: { maxLiveNodes: 1, maxWorking: 1 } });
    const busy = await m.spawn({ kind: 'claude', title: 'busy', cwd: dir, prompt: 'work', byHuman: true }); // live and working: both caps reached
    seed();
    const { id } = await run();
    const rec = m.registry.get(id)!;
    expect(rec).toMatchObject({
      kind: 'claude', parentId: null, title: 'Memory gardener · repo', cwd: repo, role: 'none', effort: 'medium', model: 'claude-haiku-5-5',
      permissionMode: 'dontAsk', muted: true, gardener: { repoKey: repoKeySync(repo), runId: 1 },
    });
    expect(rec.worktree).toBeUndefined();
    expect(rec.account).toBeUndefined();
    const { opts } = processes.at(-1)!, nodeDir = m.nodeDir(id);
    expect(opts.file).toBe('claude');
    expect(opts.cwd).toBe(repo);
    expect(opts.args.slice(0, 15)).toEqual([
      '--session-id', rec.sessionId, '--name', 'Memory gardener · repo', '--model', 'claude-haiku-5-5', '--effort', 'medium',
      '--permission-mode', 'dontAsk', '--restricted', '--tools', '', '--strict-mcp-config', '--disable-slash-commands',
    ]);
    const at = opts.args.indexOf('--agents');
    expect(opts.args.slice(at, at + 4)).toEqual(['--agents', JSON.stringify({ 'tiller-gardener': { description: 'tiller memory gardener', prompt: '', tools: TOOLS, maxTurns: 20 } }), '--agent', 'tiller-gardener']);
    expect(opts.args.slice(at + 4)).toEqual([
      '--settings', join(nodeDir, 'settings.json'), '--mcp-config', join(nodeDir, 'mcp.json'), '--append-system-prompt', gardenerSystemPrompt(id),
      '--', expect.stringMatching(/^Garden run r1 for .*: 2 candidates, \d+ daemon proposals\. Begin with garden_list\.$/),
    ]);
    expect(opts.args).not.toContain('--add-dir');
    expect(opts.args).not.toContain('--resume');
    expect(opts.env).toMatchObject({ CLAUDE_CODE_DISABLE_ADVISOR_TOOL: '1', CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS: '1', TL_NODE_ID: id, TL_TOKEN_FILE: join(nodeDir, 'token') });
    for (const k of ['TL_SESSION_DIR', 'TL_PARENT_ID', 'CLAUDE_CONFIG_DIR']) expect(opts.env).not.toHaveProperty(k);
    expect(JSON.parse(readFileSync(join(nodeDir, 'settings.json'), 'utf8')).permissions).toEqual({ allow: TOOLS });
    // It launched past both caps, and counts against neither: with room for one more, an agent's spawn is not refused at
    // maxLiveNodes, and the human's does not queue at maxWorking.
    expect(m.view(id)!.status.state).not.toBe('queued');
    configure({ daemon: { maxLiveNodes: 2, maxWorking: 2 } });
    const child = await m.spawn({ kind: 'claude', title: 'child', cwd: dir, parentId: busy.id, prompt: 'go' });
    expect(m.view(child.id)!.status.state).not.toBe('queued');
    await m.close(child.id);
    expect((await m.spawn({ kind: 'claude', title: 'next', cwd: dir, prompt: 'go', byHuman: true })).status.state).not.toBe('queued');
  });

  it('runs in the account it is given, never claude.account', async () => {
    configure({ claude: { accounts: [{ name: 'work', configDir: '~/.claude-work' }, { name: 'other', configDir: '~/.claude-other' }], account: 'other' } });
    mkdirSync(join(dir, '.claude-other'));
    seed('work');
    const { id } = await run('work');
    expect(m.registry.get(id)!.account).toBe('work');
    expect(processes.at(-1)!.opts.env.CLAUDE_CONFIG_DIR).toBe(workDir);
  });

  it('ends a done run on its turn with the turn-end measure: the process stops, and the node keeps its spend and outcome', async () => {
    seed();
    const { runId, id } = await run();
    m.applyHook(id, { hook_event_name: 'UserPromptSubmit' });
    m.applyHook(id, { hook_event_name: 'PreToolUse', tool_name: 'mcp__tiller__garden_list' });
    m.applyModEvent(id, measure(0.03));
    m.applyHook(id, { hook_event_name: 'Stop' });
    expect(await ended(runId)).toMatchObject({ state: 'done', costUsd: 0.03, costIncomplete: false, stats: { calls: 1 } });
    expect(processes.at(-1)!.terminated).toBe(true);
    const view = m.view(id)!;
    expect(view).toMatchObject({ spentUsd: 0.03, outcome: { outcome: 'succeeded', summary: expect.stringContaining('no changes') } });
    expect(view.status.exited).toBe(true);
  });

  it('trips on a tool outside the four: the run fails, its actions are undone, and the process stops', async () => {
    const [a, b] = seed();
    const { runId, id } = await run();
    expect(m.memory.gardenApply(undefined, runId, { action: 'merge', ids: [a!, b!], reason: 'same fact' })).toMatchObject({ ok: true });
    m.applyHook(id, { hook_event_name: 'PreToolUse', tool_name: 'Bash' });
    expect(await ended(runId)).toMatchObject({ state: 'failed', note: 'tripwire: Bash', costIncomplete: true, costUsd: 0.25 });
    expect(state(runId).actions!.every((x) => x.undoneBy === 'daemon')).toBe(true);
    expect(processes.at(-1)!.terminated).toBe(true);
    expect(m.view(id)!.outcome?.outcome).toBe('failed');
  });

  it('knows its node before the process can send a hook', async () => {
    seed();
    // The first hook a real process could send arrives in a later task; this one comes in the very next.
    onSpawn = (s) => setImmediate(() => m.applyHook(s.opts.env.TL_NODE_ID!, { hook_event_name: 'PreToolUse', tool_name: 'Read' }));
    const { runId } = await run();
    expect(await ended(runId)).toMatchObject({ state: 'failed', note: 'tripwire: Read' });
  });

  it('ends the run as interrupted before the human closes the node, and when the daemon stops', async () => {
    seed();
    const first = await run();
    await m.close(first.id, true);
    expect(state(first.runId)).toMatchObject({ state: 'interrupted', note: 'the human closed the gardener node', costIncomplete: true });
    expect(m.registry.get(first.id)).toBeUndefined();
    const second = await run();
    await m.shutdown();
    const store = new MemoryStore(home);
    expect(store.run(undefined, second.runId)).toMatchObject({ state: 'interrupted', note: 'the daemon stopped' });
    store.close();
  });

  it('closes the previous gardener node of the repository and account at the next run', async () => {
    seed();
    const first = await run();
    m.applyModEvent(first.id, measure(0.01));
    m.applyHook(first.id, { hook_event_name: 'Stop' });
    await ended(first.runId);
    const second = await run();
    expect(m.registry.get(first.id)).toBeUndefined();
    expect(m.registry.get(second.id)?.gardener?.runId).toBe(second.runId);
  });

  it('refuses resume, restart, a harness change and a fork, and resume on start skips it', async () => {
    seed();
    const { runId, id } = await run();
    await m.close(id, true).catch(() => {}); // ends the run; recreate an exited record to act on
    const rec = m.registry.create({ kind: 'claude', parentId: null, title: 'Memory gardener · repo', cwd: repo, sessionId: 's', gardener: { repoKey: repoKeySync(repo), runId } });
    m.runtimes.set(rec.id, { status: { state: 'done', exited: true, changedAt: Date.now() } });
    expect(await m.resume(rec.id)).toEqual({ ok: false, error: GARDENER_REFUSAL });
    expect(m.restart(rec.id)).toEqual({ ok: false, error: GARDENER_REFUSAL });
    expect(await m.changeHarness(rec.id, 'pi', undefined, true)).toEqual({ ok: false, error: GARDENER_REFUSAL });
    m.registry.update(rec.id, { transcriptPath: join(dir, 't.jsonl') });
    await expect(m.spawn({ kind: 'claude', title: 'f', cwd: repo, fork: rec.id, byHuman: true })).rejects.toThrow(GARDENER_REFUSAL);
    (m as unknown as { pendingResume: Set<string> }).pendingResume = new Set([rec.id]);
    expect(await m.resumeLive()).toContain(`${rec.id} (${GARDENER_REFUSAL})`);
  });

  it('refuses a follow-up and a fork of a closed gardener node, from its archive line', async () => {
    seed();
    const { id } = await run();
    m.applyHook(id, { hook_event_name: 'SessionStart', session_id: m.registry.get(id)!.sessionId, transcript_path: join(dir, 't.jsonl') });
    writeFileSync(join(dir, 't.jsonl'), '');
    await m.close(id, true);
    expect(m.registry.get(id)).toBeUndefined();
    await expect(m.followup(id, 'carry on')).rejects.toThrow(GARDENER_REFUSAL);
    await expect(m.spawn({ kind: 'claude', title: 'f', cwd: repo, fork: id, byHuman: true })).rejects.toThrow(GARDENER_REFUSAL);
  });

  it('a cancelled drain interrupts the live run and schedules again; a shutdown stops for good', async () => {
    seed();
    const first = await run();
    m.drain('test');
    expect(await ended(first.runId)).toMatchObject({ state: 'interrupted', note: 'the daemon stopped' });
    expect(await m.gardener.runNow({ repoPath: repo })).toEqual({ ok: false, reason: 'the daemon is stopping' });
    m.endDrain();
    expect(await m.gardener.runNow({ repoPath: repo })).toMatchObject({ ok: true });
    m.drain('restart');
    await m.shutdown();
    m.endDrain(); // the drain's lease ending after the shutdown
    expect(await m.gardener.runNow({ repoPath: repo })).toEqual({ ok: false, reason: 'the daemon is stopping' });
  });
});

describe('no client makes a gardener node (decision 7)', () => {
  it('drops gardener from a spawn request', async () => {
    const view = await m.spawn({ kind: 'terminal', title: 'sh', cwd: dir, byHuman: true, gardener: { repoKey: 'k', runId: 1 } });
    expect(m.registry.get(view.id)).not.toHaveProperty('gardener');
    expect(m.registry.get(view.id)).not.toHaveProperty('muted');
  });
});

describe('off by default', () => {
  it('a default home spawns nothing and creates no memory directory over its ticks', async () => {
    writeFileSync(join(home, 'config.json'), '{}');
    for (let i = 0; i < 3; i++) await m.gardener.tick();
    expect(processes).toHaveLength(0);
    expect(existsSync(join(home, 'memory'))).toBe(false);
  });
});
