// A harness's transcript file, read as the user and assistant messages of a conversation.
// Claude keeps one JSON object per line in <sessionId>.jsonl under <Claude home>/projects (~/.claude, or the account's CLAUDE_CONFIG_DIR).
// Pi keeps JSONL entries in <treeSessionDir>/agents/<nodeId>/<sessionId>.jsonl,
// with a tree of id/parentId entries whose active branch is the current conversation.
// The Codex bridge stores a header plus normalized user/assistant entries in the Claude content format.
import { copyFileSync, constants, existsSync, mkdirSync, rmSync } from 'node:fs';
import { open } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import type { Harness, SessionRecord, Transcript, TranscriptEntry } from '../shared/protocol.js';
import { claudeProjectSlug } from './claude-memory.js';

/** The most recent messages a transcript read returns. */
export const MAX_ENTRIES = 2000;
/** How much of the end of a transcript file is read; older lines are cut. */
export const TAIL_BYTES = 8 << 20;

/** One user or assistant message with its text and tool calls in content order. */
export interface Message { role: 'user' | 'assistant'; at?: number; parts: Array<{ text: string } | { tool: string }> }
/** claudeHome: the node's account's Claude home, for the fallback path (default ~/.claude). */
type Node = { cwd: string; sessionId?: string; previousSessions?: string[]; sessionHistory?: SessionRecord[]; transcriptPath?: string; harness?: Harness; claudeHome?: string };

/** Materialize legacy paths before changing harness or cwd; never infer an old decoder from the new harness. */
export function recordedSessions(n: Node): SessionRecord[] {
  if (!n.sessionId) return [];
  const harness = n.harness ?? 'claude';
  const current = n.transcriptPath ?? (harness === 'claude' ? transcriptFor(n.cwd, n.sessionId, n.claudeHome) : undefined);
  const prior = new Map(n.sessionHistory?.map((s) => [s.sessionId, s]));
  return [n.sessionId, ...(n.previousSessions ?? [])].flatMap((sid) => {
    if (sid !== n.sessionId && prior.has(sid)) return [prior.get(sid)!];
    return current ? [{ sessionId: sid, harness, transcriptPath: sid === n.sessionId ? current : join(dirname(current), `${sid}.jsonl`) }] : [];
  });
}

/** A follow-up owns readable history in its new tree, regardless of the old sessions' decoders. */
export function adoptSessionHistory(history: SessionRecord[], sessionDir: string, nodeId: string): SessionRecord[] {
  const dir = join(sessionDir, 'agents', nodeId, 'history');
  const created: string[] = [];
  try {
    return history.map((s) => {
      if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(s.sessionId)) throw new Error('invalid historical session id');
      const target = join(dir, `${s.sessionId}.jsonl`);
      if (s.transcriptPath === target) return s;
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      if (existsSync(s.transcriptPath)) {
        copyFileSync(s.transcriptPath, target, constants.COPYFILE_EXCL);
        created.push(target);
      }
      return { ...s, transcriptPath: target };
    });
  } catch (err) {
    for (const path of created) rmSync(path, { force: true });
    throw err;
  }
}

/** A parsed JSONL line, as either harness writes it. Unknown fields are ignored. */
type Entry = {
  type?: unknown;
  id?: unknown;
  parentId?: unknown;
  timestamp?: unknown;
  message?: { role?: unknown; content?: unknown; timestamp?: unknown };
};

/** Fallback for where Claude keeps a session's transcript: the real path of cwd with every non-alphanumeric character replaced by -. */
export function transcriptFor(cwd: string, sessionId: string, claudeHome = join(homedir(), '.claude')): string {
  return join(claudeHome, 'projects', claudeProjectSlug(cwd), `${sessionId}.jsonl`);
}

/** JSON.parse each non-empty line, dropping malformed lines and non-objects. */
function parseLines(raw: string): Entry[] {
  return raw.split('\n').flatMap((line): Entry[] => {
    if (!line.trim()) return [];
    try {
      const e: unknown = JSON.parse(line);
      return e && typeof e === 'object' && !Array.isArray(e) ? [e as Entry] : [];
    } catch { return []; }
  });
}

/**
 * Claude or Pi content blocks: a string, or an array of text and tool blocks (Claude's `tool_use`, Pi's `toolCall`);
 * other blocks (Pi's image and thinking) are dropped.
 */
function contentParts(content: unknown, toolType: 'tool_use' | 'toolCall'): Message['parts'] {
  const blocks: Array<{ type?: unknown; text?: unknown; name?: unknown }> = typeof content === 'string' ? [{ type: 'text', text: content }] : Array.isArray(content) ? content : [];
  return blocks.flatMap((b): Message['parts'] => (b?.type === 'text' && typeof b.text === 'string' && b.text.trim() ? [{ text: b.text.trim() }] : b?.type === toolType && typeof b.name === 'string' ? [{ tool: b.name }] : []));
}

/** A Pi message timestamp (Unix ms) with the ISO entry timestamp as a fallback. */
function piAt(e: Entry): number | undefined {
  const t = e.message?.timestamp;
  if (typeof t === 'number' && Number.isFinite(t)) return t;
  if (typeof e.timestamp === 'string') {
    const at = Date.parse(e.timestamp);
    if (!Number.isNaN(at)) return at;
  }
  return undefined;
}

/**
 * The entries on Pi's active branch, oldest first. Pi stores a tree with id/parentId; the current
 * leaf is the last entry and abandoned branches are its siblings. A v1 (linear) file has no ids,
 * so every entry is active. Compaction and other state entries stay on the path but yield no message.
 */
function piActiveBranch(entries: Entry[]): Entry[] {
  const tree = entries.filter((e) => e.type !== 'session' && typeof e.id === 'string' && 'parentId' in e);
  if (!tree.length) return entries;
  const byId = new Map<string, Entry>();
  for (const e of tree) byId.set(e.id as string, e);
  const leaf = tree[tree.length - 1];
  const path: Entry[] = [];
  const seen = new Set<string>();
  for (let cur: Entry | undefined = leaf; cur && typeof cur.id === 'string' && !seen.has(cur.id);) {
    seen.add(cur.id);
    path.push(cur);
    cur = cur.parentId ? byId.get(String(cur.parentId)) : undefined;
  }
  return path.reverse();
}

/** The user and assistant messages of a transcript file's text, as `harness` wrote them. Tool results and lines with neither text nor tool calls are dropped. */
export function parseMessages(raw: string, harness: Harness = 'claude'): Message[] {
  const entries = parseLines(raw);
  if (harness !== 'pi') {
    return entries.flatMap((e): Message[] => {
      if (e.type !== 'user' && e.type !== 'assistant') return [];
      const parts = contentParts(e.message?.content, 'tool_use');
      if (!parts.length) return [];
      const at = typeof e.timestamp === 'string' ? Date.parse(e.timestamp) : NaN;
      return [{ role: e.type, parts, ...(Number.isNaN(at) ? {} : { at }) }];
    });
  }
  return piActiveBranch(entries).flatMap((e): Message[] => {
    const role = e.type === 'message' ? e.message?.role : undefined;
    if (role !== 'user' && role !== 'assistant') return [];
    const parts = contentParts(e.message?.content, 'toolCall');
    if (!parts.length) return [];
    const at = piAt(e);
    return [{ role, parts, ...(at === undefined ? {} : { at }) }];
  });
}

export function toEntry(m: Message): TranscriptEntry {
  const text = m.parts.flatMap((p) => ('text' in p ? [p.text] : [])).join('\n');
  const tools = m.parts.flatMap((p) => ('tool' in p ? [p.tool] : []));
  return { role: m.role, ...(m.at !== undefined ? { at: m.at } : {}), text, ...(tools.length ? { tools } : {}) };
}

export const parseTranscript = (raw: string, harness: Harness = 'claude'): TranscriptEntry[] => parseMessages(raw, harness).map(toEntry);

/** One message as text, as `tl read` prints it: tool calls become a "[tool: name]" marker where they occur. */
export const renderMessage = (m: Message): string => `${m.role}: ${m.parts.map((p) => ('text' in p ? p.text : `[tool: ${p.tool}]`)).join('\n')}`;

/** The last MAX_ENTRIES messages of a transcript file, reading at most its last TAIL_BYTES. */
export async function readMessages(path: string, harness: Harness = 'claude'): Promise<{ messages: Message[]; truncated: boolean }> {
  const f = await open(path, 'r');
  try {
    const { size } = await f.stat();
    const start = Math.max(0, size - TAIL_BYTES);
    const buf = Buffer.alloc(size - start);
    await f.read(buf, 0, buf.length, start);
    let raw = buf.toString('utf8');
    if (start > 0) raw = raw.slice(raw.indexOf('\n') + 1); // the first line is cut
    const all = parseMessages(raw, harness);
    return { messages: all.slice(-MAX_ENTRIES), truncated: start > 0 || all.length > MAX_ENTRIES };
  } finally {
    await f.close();
  }
}

/**
 * A node's messages in session `sessionId` (default: current). Explicit history chooses each segment's
 * decoder and path. Legacy same-harness records derive prior files beside the current transcript;
 * Claude's current path can also be derived from cwd, while Pi and Codex need their path on record.
 */
export async function sessionMessages(n: Node, sessionId?: string): Promise<{ messages: Message[]; truncated: boolean; sessions: Transcript['sessions'] }> {
  if (!n.sessionId) throw new Error('no session on record');
  const records = recordedSessions(n);
  const byId = new Map(records.map((s) => [s.sessionId, s]));
  const sessions = [n.sessionId, ...[...(n.previousSessions ?? [])].reverse()].map((sid) => ({ sessionId: sid, current: sid === n.sessionId, ...(n.sessionHistory ? { harness: byId.get(sid)?.harness } : {}) }));
  const sid = sessionId ?? n.sessionId;
  if (!sessions.some((s) => s.sessionId === sid)) throw new Error(`no session ${sid} on record for this node`);
  const record = byId.get(sid);
  if (sid === n.sessionId && n.sessionHistory && (!record || !existsSync(record.transcriptPath))) return { messages: [], truncated: false, sessions };
  if (!record) throw new Error(`a ${n.harness === 'pi' ? 'Pi' : 'Codex'} node needs its transcript path on record`);
  const { transcriptPath: path, harness } = record;
  if (!existsSync(path)) throw new Error(`the transcript of session ${sid} is gone (${path})`);
  return { ...(await readMessages(path, harness)), sessions };
}

export async function nodeTranscript(n: Node, sessionId?: string): Promise<Transcript> {
  const { messages, truncated, sessions } = await sessionMessages(n, sessionId);
  return { entries: messages.map(toEntry), sessions, ...(truncated ? { truncated } : {}) };
}
