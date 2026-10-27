// Client-side helpers for `tl` / `tl up`: find or start the daemon, pick the orchestrator for a directory.
import { spawn, type ChildProcess } from 'node:child_process';
import { closeSync, mkdirSync, openSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { agentMatches, agentStatus, kickstart } from './autostart.js';
import { ADMIN_TOKEN_FILE } from './home.js';
import { count } from './util.js';
import type { Drain, UpdateStatus } from '../shared/protocol.js';
import { harnessFor, isAgentKind, type Harness, type NodeKind } from '../shared/protocol.js';

export interface Health { ok: true; pid: number; home: string; version: string; sha?: string }

/** GET /health; undefined if nothing answers within `timeoutMs`. */
export async function findDaemon(port: number, timeoutMs = 500): Promise<Health | undefined> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(timeoutMs) });
    const body = (await res.json()) as Health;
    return res.ok && body.ok ? body : undefined;
  } catch { return undefined; }
}

/** Run bin/<name> detached (survives this process and its terminal) with output appended to <home>/<logName>. */
function detach(name: string, args: string[], home: string, port: number, opts: { env?: NodeJS.ProcessEnv; logName?: string; stdin?: 'ignore' | 'pipe' } = {}): { log: string; child: ChildProcess } {
  mkdirSync(home, { recursive: true });
  const log = join(home, opts.logName ?? 'daemon.log');
  const fd = openSync(log, 'a');
  try {
    const bin = fileURLToPath(new URL(`../../bin/${name}`, import.meta.url));
    const child = spawn(bin, args, { detached: true, stdio: [opts.stdin ?? 'ignore', fd, fd], env: { ...(opts.env ?? process.env), TL_HOME: home, TL_PORT: String(port) } });
    child.unref();
    return { log, child };
  } finally { closeSync(fd); }
}

/** Start bin/tld detached, then wait for /health. Throws with the log tail on failure. */
export const startDaemon = (home: string, port: number, waitMs = 15_000): Promise<Health> => waitForDaemon(port, detach('tld', [], home, port).log, waitMs);

/** Wait for a daemon that is starting, with its output in `log`, to answer /health. Throws with the log tail on failure. */
export async function waitForDaemon(port: number, log: string, waitMs = 15_000): Promise<Health> {
  for (const end = Date.now() + waitMs; Date.now() < end; await sleep(200)) {
    const h = await findDaemon(port);
    if (h) { console.log(`started daemon (pid ${h.pid}), log ${log}`); return h; }
  }
  const tail = readFileSync(log, 'utf8').split('\n').slice(-20).join('\n');
  throw new Error(`daemon did not come up on port ${port}; last log lines:\n${tail}`);
}

/**
 * The directory `tl up` works on, as a realpath: `path` (relative to `cwd`, `~` for the home directory), else `cwd`
 * when a directory-only flag was given, else undefined (just open the app). Throws when it is not a directory.
 */
export function upDir(path: string | undefined, dirFlag: boolean, cwd: string, home = homedir()): string | undefined {
  if (path === undefined && !dirFlag) return undefined;
  const p = resolve(cwd, (path ?? '.').replace(/^~(?=$|\/)/, home));
  let real: string;
  try { real = realpathSync(p); } catch { throw new Error(`no such directory: ${p}`); }
  if (!statSync(real).isDirectory()) throw new Error(`not a directory: ${p}`);
  return real;
}

export interface OrchestratorCandidate { id: string; title: string; kind: string; harness?: Harness; parentId: string | null; cwd: string; exited?: boolean; createdAt: number }

/** Whether a candidate is an agent node on `harness` (legacy records without a harness are claude). */
const onHarness = (n: OrchestratorCandidate, harness: Harness) =>
  isAgentKind(n.kind as NodeKind) && harnessFor(n) === harness;

/**
 * The newest top-level agent node for `cwd` (already a realpath) on `harness` (default claude): live ones when
 * `exited` is false, exited ones (resumable) when true.
 */
export function pickOrchestrator<T extends OrchestratorCandidate>(nodes: T[], cwd: string, exited = false, harness: Harness = 'claude'): T | undefined {
  return nodes
    .filter((n) => onHarness(n, harness) && n.parentId === null && n.cwd === cwd && !!n.exited === exited)
    .sort((a, b) => b.createdAt - a.createdAt)[0];
}

/** `env` without a node's identity, so the CLI acts as the human and finds the daemon by TL_HOME and TL_PORT. */
export function humanEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const { TL_NODE_ID, TL_TOKEN_FILE, TL_ENDPOINT, ...rest } = env;
  return rest;
}

/** Hand `tl reload` to a detached `tl reload --detached`, which outlives the terminal of the node that ran it. */
export const spawnReload = (home: string, port: number): string => detach('tl', ['reload', '--detached'], home, port, { env: humanEnv(process.env) }).log;

/** Detached updater retains the reviewed release across the daemon restart; `now` restarts without draining. */
export function spawnUpdate(home: string, port: number, expected: UpdateStatus, onExit: (code: number | null) => void, now?: boolean): string {
  const { log, child } = detach('tl', ['update', '--detached', ...(now ? ['--now'] : [])], home, port, { env: humanEnv(process.env), logName: 'update.log', stdin: 'pipe' });
  child.stdin!.on('error', () => {}); // Spawn failure is reported by the child's error handler.
  child.stdin!.end(JSON.stringify(expected));
  child.once('exit', onExit);
  child.once('error', () => onExit(1));
  return log;
}

/** The daemon's drain tool, as the human; null when the daemon predates it or for a cancel. */
async function drainCall(home: string, port: number, args: { reason?: string; exclude?: string; cancel?: boolean }): Promise<Drain | null> {
  const token = readFileSync(join(home, ADMIN_TOKEN_FILE), 'utf8').trim();
  const res = await fetch(`http://127.0.0.1:${port}/api/drain`, {
    method: 'POST', body: JSON.stringify(args),
    headers: { Authorization: `Bearer ${token}`, 'X-TL-Node': 'human', 'Content-Type': 'application/json' },
  });
  if (res.status === 404) return null;
  const body = (await res.json().catch(() => ({}))) as { data?: Drain | null; error?: string };
  if (!res.ok) throw new Error(body.error ?? `drain: HTTP ${res.status}`);
  return body.data ?? null;
}

/**
 * Before a restart for `reason`: have the daemon hold message deliveries and agent spawns, then, unless `now`, wait
 * until no agent node but `exclude` is working, saying whom it waits for as that changes. Stops waiting when the human
 * asks the app to restart now. The hold lasts until the restart, or 15 s after the last poll. Aborting `signal` rejects
 * without another poll, so a cancel sent once this settles cannot be followed by a poll that holds again.
 */
export async function drainDaemon(home: string, port: number, o: { reason: string; exclude?: string; now?: boolean; say?: (s: string) => void; signal?: AbortSignal }): Promise<void> {
  const say = o.say ?? (() => {});
  let last = '';
  for (;;) {
    o.signal?.throwIfAborted();
    const d = await drainCall(home, port, { reason: o.reason, exclude: o.exclude });
    if (!d) { say('the running daemon cannot wait for agents; restarting at once'); return; }
    if (o.now) return;
    if (d.force) { say('restart now was asked for; not waiting'); return; }
    if (!d.waiting.length) { if (last) say('no agent is working'); return; }
    const line = `waiting for ${count(d.waiting.length, 'agent')} to finish their turn: ${d.waiting.map((w) => `${w.title} (${w.id})`).join(', ')}`;
    if (line !== last) say(line);
    last = line;
    await sleep(1000, undefined, { signal: o.signal });
  }
}

/** End a drain without restarting: the daemon releases the messages and spawns it held. */
export const cancelDrain = (home: string, port: number) => drainCall(home, port, { cancel: true });

/**
 * SIGTERM preserves live nodes; keep launchd ownership when enabled. First drains (see drainDaemon), which records
 * `reason` for the nodes whose turn the restart cuts off.
 */
export async function restartDaemon(home: string, port: number, expectedSha?: string, say: (s: string) => void = () => {}, o: { reason?: string; now?: boolean } = {}): Promise<void> {
  const old = await findDaemon(port);
  if (old) {
    if (old.home !== home) throw new Error('refusing to stop a daemon from another home');
    await drainDaemon(home, port, { reason: o.reason ?? 'restart', now: o.now, say });
    say(`stopping daemon pid ${old.pid}`);
    process.kill(old.pid, 'SIGTERM');
    for (const end = Date.now() + 10_000; await findDaemon(port); await sleep(200))
      if (Date.now() > end) throw new Error(`daemon pid ${old.pid} did not stop`);
  }
  const agent = agentStatus().loaded && agentMatches(home, port);
  if (agent) kickstart();
  const h = await (agent ? waitForDaemon(port, join(home, 'daemon.log')) : startDaemon(home, port));
  if (h.home !== home || (expectedSha && h.sha !== expectedSha)) throw new Error(`restarted daemon does not report expected commit ${expectedSha}`);
  say(`started daemon pid ${h.pid}${agent ? ' through launchd' : ''}; it resumes the nodes that were live`);
}
