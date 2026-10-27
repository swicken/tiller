// Tiller owns this readable transcript; Codex owns the native thread referenced by its header.
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import type { NodeRecord } from '../shared/protocol.js';
import { codexHeader } from '../shared/codex-transcript.js';
import { adoptedSessions, writeAdopted } from './transcript-adoption.js';

export function codexTranscript(sessionDir: string, nodeId: string, sessionId: string): string {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(sessionId)) throw new Error('invalid Codex session id');
  return join(sessionDir, 'agents', nodeId, `${sessionId}.jsonl`);
}

export function prepareCodexTranscript(n: NodeRecord, sessionDir: string, resume: boolean): string {
  if (!n.sessionId) throw new Error('Codex needs a session id');
  const target = codexTranscript(sessionDir, n.id, n.sessionId);
  const source = n.transcriptPath ?? target;
  mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
  if (resume && !existsSync(source)) throw new Error(`missing Codex session transcript (${source})`);
  if (resolve(source) === resolve(target)) {
    if (resume) codexHeader(readFileSync(source, 'utf8'));
    return target;
  }
  // A follow-up forks the native thread, so two nodes never append to the same conversation.
  const copies = adoptedSessions(n).flatMap((sid) => {
    const from = sid === n.sessionId ? source : join(dirname(source), `${sid}.jsonl`);
    if (!existsSync(from)) return [];
    const to = codexTranscript(sessionDir, n.id, sid);
    if (existsSync(to)) throw new Error(`Codex session adoption target already exists (${to})`);
    const raw = readFileSync(from, 'utf8'), header = codexHeader(raw);
    const newline = raw.indexOf('\n');
    return [{ to, raw: JSON.stringify({ ...header, fork: true }) + (newline < 0 ? '\n' : raw.slice(newline)) }];
  });
  writeAdopted(copies);
  return target;
}
