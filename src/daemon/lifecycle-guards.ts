import { existsSync } from 'node:fs';
import { isAgentKind, type NodeRecord } from '../shared/protocol.js';
import type { NodeRuntime } from './manager.js';

export type LifecycleOp = 'resume' | 'restart' | 'changeHarness' | 'close';
type Guard = [check: (rec: NodeRecord, rt: NodeRuntime) => boolean, message: (id: string, rt: NodeRuntime) => string];

const pending: Guard = [(rec) => !!rec.pending, () => 'node is armed or queued: it launches by itself; close it to drop it'];
const busy: Guard = [(_, rt) => !!rt.busy, (id, rt) => `${id} is ${rt.busy}`];
const setupRunning: Guard = [(_, rt) => !!rt.setup, () => 'worktree setup is running'];

/**
 * Each lifecycle operation's synchronous refusals, checked in order; the first that holds wins. Callers check that the
 * node exists, plus anything async or op-specific (a resume's worktree listing, a harness change's target), themselves.
 * Close skips pending, setup and the gate; restart skips needsSetup, which it retries; resume skips the gate.
 */
const GUARDS: Record<LifecycleOp, Guard[]> = {
  resume: [
    pending,
    [(rec) => !isAgentKind(rec.kind), () => 'Only agent nodes can be resumed'],
    busy,
    [(_, rt) => !!rt.session, () => 'Node is still running'],
    setupRunning,
    [(_, rt) => !!rt.needsSetup, () => 'worktree setup has not succeeded; restart runs it again'],
  ],
  restart: [
    pending,
    [(rec) => !!rec.worktree && !existsSync(rec.worktree.path), () => 'worktree missing'], // --worktree would make a fresh one
    setupRunning,
    busy,
    [(_, rt) => rt.gate?.state === 'running', (id) => `${id} is running its completion gate`],
  ],
  changeHarness: [
    [(rec) => !!rec.pending, () => 'node is armed or queued; wait until it launches'],
    busy,
    [(_, rt) => !!(rt.setup || rt.needsSetup), () => 'worktree setup must succeed before changing harness; use Restart to retry setup'],
    [(_, rt) => rt.gate?.state === 'running', () => 'completion gate is running'],
  ],
  close: [
    [(_, rt) => !!rt.busy, (id, rt) => `${id} is already ${rt.busy}`],
  ],
};

/** The first of `op`'s guards that refuses node `id`, as its message; undefined when the operation may go ahead. */
export function lifecycleRefusal(op: LifecycleOp, id: string, rec: NodeRecord, rt: NodeRuntime): string | undefined {
  const hit = GUARDS[op].find(([check]) => check(rec, rt));
  return hit?.[1](id, rt);
}
