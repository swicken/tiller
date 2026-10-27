// Pi selects its runtime cwd from the session header, not the CLI's launch directory.
// Own the resumed copy in the current tree so its archive and transcript expire together.
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import type { NodeRecord } from '../shared/protocol.js';
import { adoptedSessions, writeAdopted } from './transcript-adoption.js';

export function piTranscript(sessionDir: string, nodeId: string, sessionId: string): string {
  // Archive lines can be edited by agents; never let an id escape the owned directory.
  if (!/^[a-zA-Z0-9](?:[a-zA-Z0-9._-]*[a-zA-Z0-9])?$/.test(sessionId)) throw new Error('invalid Pi session id');
  return join(sessionDir, 'agents', nodeId, `${sessionId}.jsonl`);
}

/** Change only metadata; retain all entries, branches, signatures, compaction and usage verbatim. */
function withCwd(raw: string, cwd: string): string {
  const newline = raw.indexOf('\n');
  const first = newline < 0 ? raw : raw.slice(0, newline);
  let header: Record<string, unknown>;
  try { header = JSON.parse(first) as Record<string, unknown>; } catch { throw new Error('invalid Pi session header'); }
  if (!header || header.type !== 'session' || typeof header.id !== 'string') throw new Error('invalid Pi session header');
  if (header.cwd === cwd) return raw;
  return JSON.stringify({ ...header, cwd }) + (newline < 0 ? '\n' : raw.slice(newline));
}

/** Prepare before spawning Pi. Also migrates live records made by the older cross-root follow-up implementation. */
export function preparePiTranscript(n: NodeRecord, sessionDir: string, resume = false): string {
  if (!n.sessionId) throw new Error('Pi needs a session id');
  const target = piTranscript(sessionDir, n.id, n.sessionId);
  const source = n.transcriptPath ?? target;
  if (resolve(source) === resolve(target)) {
    if (resume && !existsSync(source)) throw new Error(`missing Pi session transcript (${source})`);
    if (existsSync(source)) {
      const raw = readFileSync(source, 'utf8'), updated = withCwd(raw, n.cwd);
      if (updated !== raw) {
        const tmp = `${target}.${randomUUID()}.tmp`;
        try {
          writeFileSync(tmp, updated, { flag: 'wx', mode: 0o600 });
          renameSync(tmp, target);
        } finally { rmSync(tmp, { force: true }); }
      }
    }
    return target; // A new/restarted session does not exist until Pi first persists it.
  }
  // Copy the current file and any recorded prior sessions, never append to the archived source.
  // Validate before writing, and refuse collisions rather than silently resuming stale content.
  const copies = adoptedSessions(n).map((sid) => {
    const to = piTranscript(sessionDir, n.id, sid);
    const from = sid === n.sessionId ? source : join(dirname(source), `${sid}.jsonl`);
    if (!existsSync(from) && (sid !== n.sessionId || !resume)) return undefined; // Missing prior file, or a fresh restart session.
    if (existsSync(to)) throw new Error(`refused: Pi session adoption target already exists (${to})`);
    return { to, raw: withCwd(readFileSync(from, 'utf8'), n.cwd) };
  }).filter((c) => c !== undefined);
  mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
  writeAdopted(copies);
  return target;
}
