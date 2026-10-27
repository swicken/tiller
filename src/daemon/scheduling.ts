// Dependency launches (spawn after / afterSuccess) and the daemon.maxWorking queue.
import { outcomeLine } from '../shared/format.js';
import { isAgentKind, type AgentState, type Isolation, type NodeView, type Pending } from '../shared/protocol.js';
import { loadConfig } from './config.js';
import { turnDone } from './completion-watches.js';
import type { NodeManager, NodeRuntime, SpawnRequest } from './manager.js';
import { DAEMON, deliver } from './messaging.js';
import { initialState } from './status.js';
import { logError } from './util.js';
import { addWorktree } from './worktree-lifecycle.js';

type Mgr = Pick<NodeManager, 'view' | 'turnStartedAt'>;

const succeeded = (v: NodeView | undefined) => v?.outcome?.outcome === 'succeeded' && v.outcome.gate !== 'failed';

/** Where a pending node's dependencies stand: every one now met, and the first failed afterSuccess one as "n-x: <outcome line>". */
function checkDeps(m: Mgr, p: Pending, since: number): { met: string[]; unmet: string[]; blocked?: string } {
  const met = new Set(p.met);
  for (const id of p.after) if (turnDone(m, id, since)) met.add(id);
  for (const id of p.afterSuccess) if (succeeded(m.view(id))) met.add(id);
  const unmet = [...new Set([...p.after, ...p.afterSuccess])].filter((id) => !met.has(id));
  let blocked: string | undefined;
  for (const id of p.afterSuccess.filter((x) => !met.has(x))) {
    const v = m.view(id);
    if (!v) blocked = `${id}: closed before reporting succeeded`;
    else if (v.outcome?.outcome === 'failed' || v.outcome?.gate === 'failed') blocked = `${id}: ${outcomeLine(v.outcome)}`;
    if (blocked) break;
  }
  return { met: [...met], unmet, ...(blocked ? { blocked } : {}) };
}

// ---- arming, the queue and release ----

/** Working now, or launched with a prompt whose first turn has not begun. */
export const working = (rt?: NodeRuntime) => !!rt && (!!rt.starting || (!!rt.session && rt.status?.state === 'working'));

/** Agent nodes working now, or launched with a prompt whose first turn has not begun. */
function workingCount(m: NodeManager): number {
  return m.registry.list().filter((n) => isAgentKind(n.kind) && working(m.runtimes.get(n.id))).length;
}

/**
 * Hold a new node back, with no process, when it has dependencies or must queue: an agent node while a restart drains,
 * or for daemon.maxWorking (unless `now`) while the cap is reached or others already queue. Returns whether it was held.
 */
export function arm(m: NodeManager, id: string, req: SpawnRequest, isolation: Isolation): boolean {
  const after = req.after ?? [], afterSuccess = req.afterSuccess ?? [];
  const max = loadConfig(null, m.home).daemon.maxWorking;
  const queue = isAgentKind(req.kind) && (m.draining || (!req.now && max > 0 && (workingCount(m) >= max || m.list().some((v) => v.status.state === 'queued'))));
  if (!after.length && !afterSuccess.length && !queue) return false;
  const rec = m.registry.update(id, { pending: { after, afterSuccess, met: [], prompt: req.prompt, isolation, ...(req.base ? { base: req.base } : {}), ...(req.now ? { now: true } : {}) } })!;
  m.runtimes.get(id)!.status = { state: 'armed', changedAt: Date.now() };
  if (after.length || afterSuccess.length) m.logEvent(id, 'arm', { parentId: rec.parentId, after, afterSuccess });
  schedule(m);
  return true;
}

const scheduled = new WeakSet<NodeManager>();

/** schedule once, after the current task: a burst of node events walks the pending nodes once. */
export function scheduleSoon(m: NodeManager): void {
  if (scheduled.has(m)) return;
  scheduled.add(m);
  queueMicrotask(() => { scheduled.delete(m); schedule(m); });
}

/**
 * Walk the armed and queued nodes in creation order: show what each waits on, tell the parent once when a failed
 * dependency blocks one, and launch each whose dependencies are met while daemon.maxWorking has room.
 */
function schedule(m: NodeManager): void {
  if (m.stopped) return;
  let working = workingCount(m), maxWorking: number | undefined; // loaded once a pass, and only for a pending node
  for (const rec of m.registry.list()) {
    const p = rec.pending, rt = m.runtimes.get(rec.id)!;
    if (!p || rt.restored) continue;
    const { met, unmet, blocked } = checkDeps(m, p, rec.createdAt);
    if (met.length !== p.met.length || blocked !== p.blocked) {
      m.registry.update(rec.id, { pending: { ...p, met, blocked } });
      if (!unmet.length) m.logEvent(rec.id, 'release', { after: p.after, afterSuccess: p.afterSuccess });
      if (blocked) blockedNotice(m, rec.id, blocked);
    }
    const max = (maxWorking ??= loadConfig(null, m.home).daemon.maxWorking);
    let state: AgentState = 'armed', activity: string;
    if (unmet.length) activity = blocked ? `blocked by ${blocked}` : `after ${unmet.join(', ')}`;
    else if (isAgentKind(rec.kind) && m.draining) {
      state = 'queued';
      activity = 'queued: the daemon is waiting to restart';
    } else if (isAgentKind(rec.kind) && !p.now && max > 0 && working >= max) {
      state = 'queued';
      activity = `queued: ${working} working, daemon.maxWorking ${max}`;
    } else {
      release(m, rec.id);
      if (isAgentKind(rec.kind)) working++;
      continue;
    }
    const cur = rt.status!;
    if (cur.state === state && cur.activity === activity) continue;
    if (state === 'queued' && cur.state !== 'queued') m.logEvent(rec.id, 'queue', { working, maxWorking: max });
    m.setStatus(rec.id, { ...cur, state, activity, changedAt: Date.now() }, false);
  }
}

function blockedNotice(m: NodeManager, id: string, blocked: string): void {
  const rec = m.registry.get(id)!;
  m.logEvent(id, 'block', { by: blocked });
  if (!rec.parentId) return;
  const text = `${id} "${rec.title}" will not launch: blocked by ${blocked}. It launches if that node later reports succeeded; close it to drop it.`;
  deliver(m, DAEMON, rec.parentId, text, { fromLabel: `tiller (armed ${id} blocked)`, replyTo: null }).catch(logError);
}

/** Launch a held node as its spawn would have. A failure drops it and tells its parent. */
function release(m: NodeManager, id: string): void {
  const rec = m.registry.get(id)!, p = rec.pending as Pending, rt = m.runtimes.get(id)!;
  m.registry.update(id, { pending: undefined });
  if (rt.session) { // already launched some other way; launching again would fail and discard it with its process live
    const cur = rt.status!;
    if (cur.state === 'armed' || cur.state === 'queued') m.setStatus(id, { ...cur, state: 'unknown', activity: undefined, changedAt: Date.now() }, false);
    else m.emitNode(id);
    return;
  }
  m.logEvent(id, 'launch', p.isolation === 'worktree' ? { isolation: 'worktree' } : {});
  const fail = (err: Error) => {
    if (!m.registry.get(id)) return;
    m.logEvent(id, 'launch-failed', { error: err.message });
    if (rec.parentId) deliver(m, DAEMON, rec.parentId, `${id} "${rec.title}" failed to launch and was removed: ${err.message}`, { fromLabel: `tiller (armed ${id} failed)`, replyTo: null }).catch(logError);
    m.discard(id);
    m.emit('removed', id);
  };
  try {
    if (p.isolation === 'worktree') {
      if (p.prompt) rt.starting = true; // the worktree takes a while; hold its maxWorking slot meanwhile
      m.setStatus(id, { ...rt.status!, state: 'unknown', activity: 'creating worktree', changedAt: Date.now() }, false);
      addWorktree(m, id, p.prompt, p.base).then(() => m.emitNode(id), fail);
      return;
    }
    m.writeFiles(id);
    rt.status = { state: initialState(rec.kind), changedAt: Date.now() };
    m.launch(id, p.prompt, false);
    m.emitNode(id);
  } catch (err) {
    fail(err as Error);
  }
}
