import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { NodeRecord } from '../shared/protocol.js';
import { CompletionGate } from './completion-gate.js';
import { GARDENER_REFUSAL, lifecycleRefusal, type LifecycleOp } from './lifecycle-guards.js';
import { NodeManager, type NodeRuntime } from './manager.js';
import type { PtySession } from './pty.js';

describe('lifecycleRefusal', () => {
  const rec = { id: 'n', kind: 'claude' } as NodeRecord;
  const gate = new CompletionGate(); // a new gate is running
  const session = {} as PtySession, setup = { abort: new AbortController(), done: Promise.resolve() };
  const pending = 'node is armed or queued: it launches by itself; close it to drop it';
  const gardener = { gardener: { repoKey: 'k', runId: 1 } };
  it.each<[LifecycleOp, Partial<NodeRecord>, NodeRuntime, string | undefined]>([
    ['resume', {}, {}, undefined],
    ['resume', { pending: { afterOutcome: [] } as any }, { busy: 'closing' }, pending],
    ['resume', { kind: 'terminal' }, { busy: 'closing' }, 'Only agent nodes can be resumed'],
    ['resume', {}, { busy: 'merging', session }, 'n is merging'],
    ['resume', {}, { session, setup }, 'Node is still running'],
    ['resume', {}, { setup, needsSetup: { prompt: undefined } }, 'worktree setup is running'],
    ['resume', {}, { needsSetup: { prompt: undefined } }, 'worktree setup has not succeeded; restart runs it again'],
    ['resume', {}, { gate }, undefined],
    ['restart', {}, { session, needsSetup: { prompt: undefined } }, undefined],
    ['restart', { pending: { afterOutcome: [] } as any, worktree: { path: '/nonexistent' } as any }, {}, pending],
    ['restart', { worktree: { path: '/nonexistent' } as any }, { setup }, 'worktree missing'],
    ['restart', {}, { setup, busy: 'closing' }, 'worktree setup is running'],
    ['restart', {}, { busy: 'closing', gate }, 'n is closing'],
    ['restart', {}, { gate }, 'n is running its completion gate'],
    ['changeHarness', {}, { session }, undefined],
    ['changeHarness', { pending: { afterOutcome: [] } as any }, { busy: 'closing' }, 'node is armed or queued; wait until it launches'],
    ['changeHarness', {}, { busy: 'closing', setup }, 'n is closing'],
    ['changeHarness', {}, { needsSetup: { prompt: undefined }, gate }, 'worktree setup must succeed before changing harness; use Restart to retry setup'],
    ['changeHarness', {}, { gate }, 'completion gate is running'],
    ['close', { pending: { afterOutcome: [] } as any }, { setup, needsSetup: { prompt: undefined }, gate }, undefined],
    ['close', {}, { busy: 'merging' }, 'n is already merging'],
    ['resume', gardener, {}, GARDENER_REFUSAL],
    ['restart', gardener, { busy: 'closing' }, GARDENER_REFUSAL],
    ['changeHarness', gardener, {}, GARDENER_REFUSAL],
    ['close', gardener, {}, undefined],
  ])('%s %j %j -> %s', (op, fields, rt, want) => {
    expect(lifecycleRefusal(op, 'n', { ...rec, ...fields }, rt)).toBe(want);
  });
});

describe('restart during the completion gate', () => {
  let home = '';
  let m: NodeManager;
  afterEach(async () => { await m.shutdown(); rmSync(home, { recursive: true, force: true }); });

  it('is refused while the gate runs and allowed once it finishes', async () => {
    home = mkdtempSync(join(tmpdir(), 'tl-guard-'));
    m = new NodeManager({ home, path: '/usr/bin:/bin' });
    const id = m.registry.create({ kind: 'terminal', parentId: null, title: 'gate', cwd: home }).id;
    m.runtimes.set(id, { status: { state: 'done', changedAt: Date.now() } });
    m.writeFiles(id);
    const run = m.runGate(id, { command: 'sleep 0.1', retries: 0, timeoutMinutes: 1 });
    expect(m.gateRunning(id)).toBe(true);
    expect(m.restart(id)).toEqual({ ok: false, error: `${id} is running its completion gate` });
    expect(m.runtimes.get(id)!.status!.activity).toBeUndefined(); // restart would have set 'restarting'
    expect(await run).toMatchObject({ ok: true });
    expect(m.restart(id)).toEqual({ ok: true });
  });
});
