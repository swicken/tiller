// Per-tree session directories, <home>/sessions/<rootId>: notes that outlive a node's context (handoff.md and the like),
// meta.json, and events.jsonl, the daemon's log of what happened in the tree. Keyed by rootId, so restart keeps them.
import { closeSync, existsSync, fstatSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { appendFile } from 'node:fs/promises';
import { join } from 'node:path';
import { outcomeLine } from '../shared/format.js';
import { NEEDS_YOU_STATES, type AgentState, type DigestItem, type Outcome } from '../shared/protocol.js';
import { logError } from './util.js';

const SESSIONS_DIR = 'sessions';
const HANDOFF = 'handoff.md';
const EVENTS = 'events.jsonl';
const DAY_MS = 86_400_000;
const CHUNK = 64 * 1024;

export interface SessionMeta { rootId: string; title: string; cwd: string; createdAt: number; closedAt?: number }

export const sessionDir = (home: string, rootId: string): string => join(home, SESSIONS_DIR, rootId);
const eventsFile = (dir: string): string => join(dir, EVENTS);

/** Past this, the restart pointer also asks for the handoff note to be condensed. */
const HANDOFF_LONG_BYTES = 32 * 1024;

/** The first prompt after a restart that names none: a pointer at the handoff note, when there is one. */
export function handoffPrompt(dir: string): string | undefined {
  const file = join(dir, HANDOFF);
  if (!existsSync(file)) return undefined;
  const long = statSync(file).size > HANDOFF_LONG_BYTES;
  return `Read ${file} first; it is your own handoff from before this restart.${long ? ' It is over 32 KB: rewrite it as the current state only, moving history to a separate log file.' : ''}`;
}

/** Create the directory (0700) and its meta.json if missing. Cheap enough to call on every launch. */
export function ensureSession(home: string, meta: SessionMeta): string {
  const dir = sessionDir(home, meta.rootId);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  try { writeFileSync(join(dir, 'meta.json'), JSON.stringify(meta, null, 2), { flag: 'wx' }); } catch { /* exists */ }
  return dir;
}

function readMeta(dir: string): SessionMeta | undefined {
  try { return JSON.parse(readFileSync(join(dir, 'meta.json'), 'utf8')) as SessionMeta; } catch { return undefined; }
}

/** Record that the tree's root closed; the sweep deletes the directory sessionsKeepDays later. */
export function markClosed(home: string, rootId: string, at = Date.now()): void {
  const dir = sessionDir(home, rootId);
  const meta = readMeta(dir);
  if (meta) writeFileSync(join(dir, 'meta.json'), JSON.stringify({ ...meta, closedAt: at }, null, 2));
}

export interface SessionInfo extends Partial<SessionMeta> { rootId: string; dir: string; files: number; bytes: number; newest: number }

export function listSessions(home: string): SessionInfo[] {
  const root = join(home, SESSIONS_DIR);
  let ids: string[];
  try { ids = readdirSync(root); } catch { return []; }
  return ids.flatMap((rootId) => {
    const dir = join(root, rootId);
    try {
      const stats = readdirSync(dir).map((f) => statSync(join(dir, f)));
      const newest = Math.max(statSync(dir).mtimeMs, ...stats.map((s) => s.mtimeMs));
      return [{ ...readMeta(dir), rootId, dir, files: stats.length, bytes: stats.reduce((n, s) => n + s.size, 0), newest }];
    } catch { return []; } // not a directory, or gone meanwhile
  });
}

/**
 * Delete the directories of trees whose root is gone and that have been quiet for keepDays: closed that long ago, or,
 * with no closedAt, no file touched for that long. A directory whose root still exists is never swept.
 */
export function sweepSessions(home: string, existing: Set<string>, keepDays: number, now = Date.now()): string[] {
  const cutoff = now - keepDays * DAY_MS;
  const removed: string[] = [];
  for (const s of listSessions(home)) {
    if (existing.has(s.rootId) || (s.closedAt ?? s.newest) >= cutoff) continue;
    rmSync(s.dir, { recursive: true, force: true });
    removed.push(s.rootId);
  }
  return removed;
}

// ---- event log ----

export type SessionEvent = { ts: number; type: string; id: string; title?: string } & Record<string, unknown>;

const writes = new Map<string, Promise<void>>();

/** Append one JSON line, in call order per file, without blocking the caller. A failed write is logged and dropped. */
export function appendLine(file: string, value: unknown): void {
  const next = (writes.get(file) ?? Promise.resolve()).then(() => appendFile(file, `${JSON.stringify(value)}\n`)).catch(logError);
  writes.set(file, next);
  void next.then(() => { if (writes.get(file) === next) writes.delete(file); });
}

export const appendEvent = (dir: string, ev: SessionEvent): void => appendLine(eventsFile(dir), ev);

/** Resolves once every pending append has landed (for tests and shutdown). */
export const flushEvents = async (): Promise<void> => { await Promise.all(writes.values()); };

/** One log line as an event at or after `since`; undefined when unreadable or older. */
function eventAt(line: string, since: number): SessionEvent | undefined {
  try { const e = JSON.parse(line) as SessionEvent; return e.ts >= since ? e : undefined; } catch { return undefined; }
}

/**
 * Events at or after `since`, oldest first; unreadable lines are skipped. Reads backwards from the end in chunks and
 * stops at the first readable event older than `since`.
 */
// prune: assumes the log is in ts order (appendLine keeps call order, ts is Date.now() at the call); a backwards clock
// step can hide earlier events newer than `since`. Read the whole file if that ever matters.
export function readEvents(dir: string, since = 0): SessionEvent[] {
  let fd: number;
  try { fd = openSync(eventsFile(dir), 'r'); } catch { return []; }
  try {
    const out: SessionEvent[] = [];
    let pos = fstatSync(fd).size;
    let carry = Buffer.alloc(0); // the end of a line whose start lies further back
    while (pos > 0) {
      const n = Math.min(CHUNK, pos);
      pos -= n;
      const buf = Buffer.alloc(n + carry.length);
      readSync(fd, buf, 0, n, pos);
      carry.copy(buf, n);
      // The bytes before the first '\n' may start mid-line (and mid-character), so they wait for the next chunk.
      const nl = pos > 0 ? buf.indexOf(0x0a) : -1;
      if (pos > 0 && nl < 0) { carry = buf; continue; }
      carry = buf.subarray(0, Math.max(nl, 0));
      for (const l of buf.subarray(nl + 1).toString('utf8').split('\n').reverse()) {
        const e = eventAt(l, -Infinity);
        if (!e) continue;
        if (e.ts >= since) out.push(e);
        else if (typeof e.ts === 'number') return out.reverse();
      }
    }
    return out.reverse();
  } finally {
    closeSync(fd);
  }
}

/** Where `tl log --follow` has read up to: the file (by inode) and the byte after the last whole line read. */
export interface EventCursor { ino: number; offset: number }

/**
 * Events at or after `since` in the whole lines appended after `cursor`, and the cursor past them. Starts over from the
 * beginning when the file shrank or was replaced; a partial last line waits for the next call.
 */
export function readNewEvents(dir: string, cursor: EventCursor = { ino: 0, offset: 0 }, since = 0): { events: SessionEvent[]; cursor: EventCursor } {
  let fd: number;
  try { fd = openSync(eventsFile(dir), 'r'); } catch { return { events: [], cursor }; }
  try {
    const { ino, size } = fstatSync(fd);
    const start = ino === cursor.ino && size >= cursor.offset ? cursor.offset : 0;
    const buf = Buffer.alloc(size - start);
    readSync(fd, buf, 0, buf.length, start);
    const end = buf.lastIndexOf(0x0a) + 1;
    const events = buf.subarray(0, end).toString('utf8').split('\n').flatMap((l) => eventAt(l, since) ?? []);
    return { events, cursor: { ino, offset: start + end } };
  } finally {
    closeSync(fd);
  }
}

/** "90s", "15m", "2h" or "3d" as milliseconds; undefined when malformed. */
export function parseSince(s: string): number | undefined {
  const m = /^(\d+)([smhd])$/.exec(s.trim());
  return m ? Number(m[1]) * { s: 1000, m: 60_000, h: 3_600_000, d: DAY_MS }[m[2] as 's' | 'm' | 'h' | 'd'] : undefined;
}

/** One readable line: local time, node, type and the event's own fields. */
export function formatEvent(e: SessionEvent): string {
  const { ts, type, id, title, ...rest } = e;
  const time = new Date(ts).toLocaleString('sv-SE').slice(5, 19); // MM-DD HH:MM:SS
  const detail = Object.entries(rest).map(([k, v]) => `${k}=${typeof v === 'string' ? JSON.stringify(v.length > 120 ? `${v.slice(0, 120)}…` : v) : v}`).join(' ');
  return `${time}  ${(title ?? '').slice(0, 24).padEnd(24)} ${id}  ${type.padEnd(8)} ${detail}`;
}

// ---- away digest ----

const RANK: Record<DigestItem['kind'], number> = { needsYou: 0, errored: 1, finished: 2 };

/**
 * Per node, what the log says happened since the human looked away: still blocked or waiting (with the question or
 * activity), errored or failed (with the outcome line), or finished (with the outcome line). Needs-you first, newest first within.
 */
export function buildDigest(events: SessionEvent[]): DigestItem[] {
  const byNode = new Map<string, { title: string; state?: SessionEvent; outcome?: SessionEvent }>();
  for (const e of [...events].sort((a, b) => a.ts - b.ts)) {
    const n = byNode.get(e.id) ?? { title: e.title ?? e.id };
    if (e.title) n.title = e.title;
    if (e.type === 'state') n.state = e;
    else if (e.type === 'outcome') n.outcome = e;
    byNode.set(e.id, n);
  }
  const items: DigestItem[] = [];
  for (const [id, { title, state, outcome }] of byNode) {
    const to = state?.to as AgentState | undefined;
    const at = Math.max(state?.ts ?? 0, outcome?.ts ?? 0);
    const text = (...xs: unknown[]) => xs.find((x): x is string => typeof x === 'string' && x !== '');
    const reported = outcome && outcomeLine(outcome as unknown as Outcome); // an outcome event's data is the Outcome
    if (to && NEEDS_YOU_STATES.includes(to) && !state!.exited) items.push({ id, title, kind: 'needsYou', text: text(state!.activity, state!.message), at });
    else if (state?.errored || outcome?.outcome === 'failed') items.push({ id, title, kind: 'errored', text: text(reported, state?.activity, state?.message), at });
    else if (outcome || to === 'done') items.push({ id, title, kind: 'finished', text: text(reported, state?.message), at });
  }
  return items.sort((a, b) => RANK[a.kind] - RANK[b.kind] || b.at - a.at);
}
