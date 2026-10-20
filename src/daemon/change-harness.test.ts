import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { Harness } from '../shared/protocol.js';
import { NodeManager } from './manager.js';
import { PtySession, type SpawnOpts } from './pty.js';
import { ack, claim, DAEMON, deliver, HUMAN, inbox, messageStatus } from './messaging.js';
import { codexAdapter } from './harness.js';
import { findArchived } from './archive.js';
import { CompletionGate } from './completion-gate.js';
import * as worktree from './worktree.js';

class FakeSession {
  exited = false;
  kills = 0;
  held = false;
  private exits: Array<(code: number) => void> = [];
  constructor(readonly opts: SpawnOpts) {}
  onData() {}
  onExit(cb: (code: number) => void) { this.exits.push(cb); }
  async flush() {}
  screenTail() { return []; }
  async write() {}
  classifyScreen() { return 'unknown' as const; }
  kill() { this.kills++; if (!this.held) this.exit(); }
  exit() { this.exited = true; for (const cb of this.exits) cb(0); }
  async terminate() {
    this.kill();
    if (!this.exited) await new Promise<void>((resolve) => this.onExit(() => resolve()));
    return true;
  }
}

let home: string, bin: string, manager: NodeManager, processes: FakeSession[];
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'tl-change-'));
  bin = join(home, 'bin'); mkdirSync(bin);
  for (const h of ['claude', 'codex', 'pi']) { writeFileSync(join(bin, h), '#!/bin/sh\n'); chmodSync(join(bin, h), 0o755); }
  processes = [];
  vi.spyOn(PtySession, 'spawn').mockImplementation((opts) => {
    const s = new FakeSession(opts); processes.push(s); return s as unknown as PtySession;
  });
  manager = new NodeManager({ home: join(home, 'tl'), path: bin });
});
afterEach(async () => { await manager.shutdown(); vi.restoreAllMocks(); rmSync(home, { recursive: true, force: true }); });
const spawn = (harness: Harness = 'claude') => manager.spawn({ kind: 'agent', harness, title: 'Keep my title', cwd: home, byHuman: true });
const change = (id: string, harness: Harness) => manager.changeHarness(id, harness, undefined, true);

function persist(id: string, answer: string) {
  const rec = manager.registry.get(id)!;
  const path = rec.transcriptPath ?? join(home, `${rec.sessionId}.jsonl`);
  const raw = rec.harness === 'pi'
    ? [{ type: 'session', id: 'pi-native', cwd: home }, { type: 'message', message: { role: 'assistant', content: [{ type: 'text', text: answer }] } }]
    : [...(rec.harness === 'codex' ? [{ type: 'codex_session', threadId: 'old-native-thread' }] : []), { type: 'assistant', message: { content: answer } }];
  writeFileSync(path, raw.map((v) => JSON.stringify(v)).join('\n') + '\n');
  manager.applyHook(id, { hook_event_name: 'SessionStart', session_id: rec.sessionId, transcript_path: path });
  return { sessionId: rec.sessionId!, path, raw: readFileSync(path, 'utf8') };
}

it('changes Claude → Codex → Pi → Claude with fresh IDs, defaults and readable, retained archived history', async () => {
  writeFileSync(join(manager.home, 'config.json'), JSON.stringify({ profiles: { codex: { orchestrator: { model: 'target-codex', effort: 'xhigh' } }, pi: { orchestrator: { model: 'provider/pi-model', effort: 'max' } } } }));
  const { id } = await spawn();
  const child = await manager.spawn({ kind: 'terminal', parentId: id, title: 'Child', cwd: home });
  manager.registry.update(id, { model: 'claude-only-model', effort: 'max', permissionMode: 'plan', preset: 'reviewer', forkSession: 'stale-fork' });
  const identity = { id, title: manager.view(id)!.title, cwd: home, parentId: null, createdAt: manager.view(id)!.createdAt };
  const history = [];
  for (const target of ['codex', 'pi', 'claude'] as const) {
    const old = persist(id, `answer from ${manager.view(id)!.harness}`); history.push(old);
    const oldToken = manager.tokenFor(id), oldTokenPath = manager.session(id) as unknown as FakeSession;
    expect(await change(id, target)).toEqual({ ok: true });
    expect(manager.view(id)).toMatchObject({ ...identity, harness: target, kind: 'agent' });
    expect(manager.registry.get(child.id)?.parentId).toBe(id);
    expect(manager.view(id)!.sessionId).not.toBe(old.sessionId);
    expect(manager.view(id)!.permissionMode).toBeUndefined();
    expect(manager.view(id)!.preset).toBeUndefined();
    expect(manager.view(id)!.forkSession).toBeUndefined();
    expect(manager.verifyToken(id, oldToken)).toBe(false);
    expect(readFileSync(oldTokenPath.opts.env.TL_TOKEN_FILE, 'utf8')).toBe(oldToken);
    const spec = processes.at(-1)!.opts;
    if (target !== 'claude') expect(spec.env.TL_SESSION_ID).toBe(manager.view(id)!.sessionId);
    else expect(spec.args).toContain(manager.view(id)!.sessionId);
    expect(spec.env.TL_TOKEN_FILE).toContain('/launches/');
    if (target === 'codex') {
      const input = JSON.parse(spec.args.at(-1)!);
      expect(input).toMatchObject({ resume: false, model: 'target-codex', effort: 'xhigh' });
      expect(input.transcriptPath).not.toBe(old.path);
    } else if (target === 'pi') {
      expect(spec.args).toContain('provider/pi-model'); expect(spec.args).toContain('max');
      expect(spec.args).not.toContain('--resume');
    } else expect(spec.args).not.toContain('--resume');
    for (const past of history) {
      expect((await manager.transcript(id, past.sessionId)).entries[0].text).toContain('answer from');
      expect(readFileSync(past.path, 'utf8')).toBe(past.raw);
    }
  }
  persist(id, 'final Claude answer');
  const token = manager.tokenFor(id);
  await manager.close(child.id);
  await manager.close(id, true);
  const archived = await findArchived(manager.home, id);
  expect(archived?.sessionHistory).toHaveLength(3);
  for (const past of history) expect((await manager.transcript(id, past.sessionId)).entries).toHaveLength(1);
  const followup = await manager.followup(id, 'continue');
  expect(followup.harness ?? 'claude').toBe('claude');
  for (const past of history) expect((await manager.transcript(followup.id, past.sessionId)).entries).toHaveLength(1);
  expect(manager.verifyToken(followup.id, token)).toBe(false);
});

it('waits for old process exit, locks competing lifecycle actions, and never launches twice', async () => {
  const { id } = await spawn(); persist(id, 'working');
  const old = processes[0]; old.held = true;
  const pending = change(id, 'pi');
  await expect.poll(() => old.kills).toBe(1);
  expect(processes).toHaveLength(1);
  expect(manager.view(id)?.changingHarness).toBe(true);
  expect(await change(id, 'codex')).toMatchObject({ ok: false, error: expect.stringContaining('changing harness') });
  expect(manager.restart(id)).toMatchObject({ ok: false });
  expect(await manager.resume(id)).toMatchObject({ ok: false });
  await expect(manager.close(id, true)).rejects.toThrow('changing harness');
  expect(await manager.runGate(id, { command: 'exit 0', retries: 1, timeoutMinutes: 1 })).toMatchObject({ ok: false });
  expect(claim(manager, id, 'anything')).toBe(false);
  old.exit();
  expect(await pending).toEqual({ ok: true });
  expect(processes).toHaveLength(2);
  expect(processes.filter((p) => !p.exited)).toHaveLength(1);
});

it('preserves unclaimed inbox prompts, settles shutdown receipts, and never replays an ambiguous claim', async () => {
  const { id } = await spawn('pi'); persist(id, 'old');
  const accepted = await deliver(manager, HUMAN, id, 'accepted during shutdown');
  const ambiguous = await deliver(manager, DAEMON, id, 'ambiguous');
  const queued = await deliver(manager, DAEMON, id, 'not submitted');
  expect(claim(manager, id, accepted.messageId!)).toBe(true);
  expect(claim(manager, id, ambiguous.messageId!)).toBe(true);
  const old = processes[0]; old.held = true;
  const pending = change(id, 'claude');
  await expect.poll(() => old.kills).toBe(1);
  expect(inbox(manager, id)).toEqual([]);
  expect(ack(manager, id, accepted.messageId!)).toBe(true);
  old.exit(); await pending;
  expect(messageStatus(manager, HUMAN, accepted.messageId!)?.outcome).toBe('delivered');
  expect(messageStatus(manager, DAEMON, ambiguous.messageId!)).toMatchObject({ outcome: 'stalled', retryable: false });
  expect(ack(manager, id, ambiguous.messageId!)).toBe(false);
  expect(inbox(manager, id).map((m) => m.id)).toEqual([queued.messageId]);
  expect(readFileSync(join(manager.home, 'inbox.json'), 'utf8')).toContain(queued.messageId!);
});

it('moves unpasted Claude fallback prompts into the target native inbox', async () => {
  const { id } = await spawn(); persist(id, 'old');
  const queued = await deliver(manager, HUMAN, id, 'keep this prompt');
  expect(queued.outcome).toBe('queued');
  expect(await change(id, 'pi')).toEqual({ ok: true });
  expect(inbox(manager, id)).toMatchObject([{ id: queued.messageId, text: expect.stringContaining('keep this prompt') }]);
});

it('leaves the old process untouched for missing executables, unsupported settings and same-harness requests', async () => {
  const { id } = await spawn();
  const sid = manager.view(id)!.sessionId;
  rmSync(join(bin, 'pi'));
  expect(await change(id, 'pi')).toMatchObject({ ok: false, error: expect.stringContaining('executable not found') });
  vi.spyOn(codexAdapter, 'validate').mockImplementationOnce(() => { throw new Error('unsupported codex effort'); });
  expect(await change(id, 'codex')).toMatchObject({ ok: false, error: expect.stringContaining('unsupported codex effort') });
  expect(await change(id, 'claude')).toMatchObject({ ok: false, error: expect.stringContaining('already uses') });
  expect(manager.view(id)!.sessionId).toBe(sid);
  expect(processes[0].kills).toBe(0);
});

it('leaves a failed target launch honest and recoverable by restart, retaining readable history', async () => {
  const { id } = await spawn(); const old = persist(id, 'retained');
  vi.mocked(PtySession.spawn).mockImplementationOnce(() => { throw new Error('launch exploded'); });
  expect(await change(id, 'pi')).toMatchObject({ ok: false, error: 'launch exploded' });
  expect(manager.view(id)).toMatchObject({ harness: 'pi', status: { exited: true, errored: true, activity: expect.stringContaining('Restart') } });
  expect(manager.session(id)).toBeUndefined();
  expect((await manager.transcript(id)).sessions).toHaveLength(2);
  expect((await manager.transcript(id, old.sessionId)).entries[0].text).toBe('retained');
  expect(manager.restart(id)).toEqual({ ok: true });
  expect(manager.session(id)).toBeDefined();
  expect((await manager.transcript(id, old.sessionId)).entries[0].text).toBe('retained');
});

it('refuses to replace an unproven stopped process, and supports an already exited node', async () => {
  const { id } = await spawn();
  vi.spyOn(processes[0], 'terminate').mockResolvedValueOnce(false);
  expect(await change(id, 'pi')).toMatchObject({ ok: false, error: expect.stringContaining('has not exited') });
  expect(processes).toHaveLength(1);
  expect(manager.view(id)!.harness).toBe('claude');
  expect(manager.view(id)!.changingHarness).toBe(true);
  expect(manager.restart(id)).toMatchObject({ ok: false });
  await expect(manager.close(id, true)).rejects.toThrow('changing harness');
  expect(await change(id, 'pi')).toMatchObject({ ok: false });
  processes[0].exit();
  expect(manager.view(id)!.changingHarness).toBeUndefined();
  expect(await change(id, 'pi')).toEqual({ ok: true });
});

it.each(['working', 'done'] as const)('changes a %s agent and clears old turn state', async (state) => {
  const { id } = await spawn();
  manager.applyHook(id, { hook_event_name: 'UserPromptSubmit', prompt: 'old task' });
  if (state === 'done') manager.applyHook(id, { hook_event_name: 'Stop', last_assistant_message: 'old answer' });
  expect(manager.view(id)?.status.state).toBe(state);
  expect(await change(id, 'pi')).toEqual({ ok: true });
  expect(manager.view(id)?.status.state).toBe('unknown');
  expect(manager.view(id)?.status.lastAssistantMessage).toBeUndefined();
});

it('persists generation and mixed history through daemon reload, resume and another restart', async () => {
  const { id } = await spawn(); const old = persist(id, 'Claude before reload');
  const oldToken = manager.tokenFor(id);
  expect(await change(id, 'pi')).toEqual({ ok: true });
  const current = persist(id, 'Pi before reload'), currentToken = manager.tokenFor(id);
  const dir = manager.home;
  await manager.shutdown();
  manager = new NodeManager({ home: dir, path: bin });
  expect(manager.verifyToken(id, oldToken)).toBe(false);
  expect(manager.verifyToken(id, currentToken)).toBe(true);
  expect(await manager.resume(id)).toEqual({ ok: true });
  expect(manager.view(id)?.sessionId).toBe(current.sessionId);
  expect((await manager.transcript(id, old.sessionId)).entries[0].text).toBe('Claude before reload');
  expect(manager.restart(id)).toEqual({ ok: true });
  expect(manager.view(id)?.sessionId).not.toBe(current.sessionId);
  expect((await manager.transcript(id, current.sessionId)).entries[0].text).toBe('Pi before reload');
  expect((await manager.transcript(id, old.sessionId)).entries[0].text).toBe('Claude before reload');
});

it('preserves owned worktree identity and refuses missing worktrees', async () => {
  const { id } = await spawn();
  const w = { repo: home, path: home, branch: 'tl/keep', base: 'tl/task', baseSha: 'abc' };
  manager.registry.update(id, { worktree: w });
  vi.spyOn(worktree, 'listWorktrees').mockResolvedValue([{ path: home, branch: w.branch }]);
  expect(await change(id, 'pi')).toEqual({ ok: true });
  expect(manager.view(id)!.worktree).toEqual(w);
  expect(processes.at(-1)!.opts.cwd).toBe(home);
  vi.mocked(worktree.listWorktrees).mockResolvedValue([]);
  expect(await change(id, 'codex')).toMatchObject({ ok: false, error: 'worktree missing' });
});

it('refuses terminal, nonhuman, pending, setup, busy and completion-gate transitions before disruption', async () => {
  const terminal = await manager.spawn({ kind: 'terminal', title: 'shell', cwd: home });
  expect(await change(terminal.id, 'pi')).toMatchObject({ ok: false });
  const { id } = await spawn();
  expect(await manager.changeHarness(id, 'pi')).toMatchObject({ ok: false, error: expect.stringContaining('only for the human') });
  manager.registry.update(id, { pending: { after: [], afterSuccess: [], satisfied: [] } as never });
  expect(await change(id, 'pi')).toMatchObject({ ok: false, error: expect.stringContaining('armed or queued') });
  manager.registry.update(id, { pending: undefined });
  const rt = manager.runtimes.get(id)!;
  rt.needsSetup = { prompt: 'setup' };
  expect(await change(id, 'pi')).toMatchObject({ ok: false, error: expect.stringContaining('setup') });
  rt.needsSetup = undefined; rt.busy = 'merging';
  expect(await change(id, 'pi')).toMatchObject({ ok: false, error: expect.stringContaining('merging') });
  rt.busy = undefined; rt.gate = new CompletionGate();
  expect(await change(id, 'pi')).toMatchObject({ ok: false, error: 'completion gate is running' });
  expect(processes.every((p) => p.kills === 0)).toBe(true);
});

it('refuses a change to Pi whose pi.extensions list is not installed before stopping the old process', async () => {
  writeFileSync(join(manager.home, 'config.json'), JSON.stringify({ pi: { extensions: ['npm:gone'] } })); // the fake pi lists nothing
  const { id } = await spawn();
  expect(await change(id, 'pi')).toMatchObject({ ok: false, error: expect.stringContaining('pi.extensions lists npm:gone') });
  expect(processes).toHaveLength(1);
  expect(processes[0].kills).toBe(0);
  expect(manager.view(id)!.harness).toBe('claude');
});
