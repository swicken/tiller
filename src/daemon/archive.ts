// <sessionDir>/archive.jsonl: one ArchivedNode per closed agent node, so it can be found, read, followed up or forked
// later. The sessions sweep deletes it with the rest of the directory.
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { outcomeLine } from '../shared/format.js';
import { profileFor } from '../shared/protocol.js';
import type { ArchivedNode, NodeRecord, NodeStatus, Outcome } from '../shared/protocol.js';
import { roleFor } from './launch.js';
import { appendLine, flushEvents, listSessions, sessionDir } from './sessions.js';

const ARCHIVE = 'archive.jsonl';
const BRIEF_CHARS = 200;

/** What close decided about a worktree node's branch; empty for a node without one. */
export type BranchFate = Pick<ArchivedNode, 'branchFate' | 'base'>;

const firstLine = (s?: string) => s?.split('\n').map((l) => l.trim()).find(Boolean);
const firstSentence = (s?: string) => {
  const t = s?.replace(/\s+/g, ' ').trim();
  return t && (/^.*?[.!?](?=\s|$)/.exec(t)?.[0] ?? t);
};
const FATE_TEXT = { merged: (base?: string) => `merged into ${base ?? 'its base'}`, kept: () => 'branch kept, unmerged', discarded: () => 'branch discarded' };

/**
 * One line of at most 200 characters on what the node did and how it ended: the outcome ("succeeded: ...") with its
 * summary's first sentence or its note, else the first line of its last message, else of its first prompt; then what
 * became of its branch.
 */
export function briefOf(a: Omit<ArchivedNode, 'brief'>): string | undefined {
  const o = a.outcome;
  const text = firstSentence(o?.summary) || o?.note || firstLine(a.lastAssistantMessage) || firstLine(a.prompt);
  const head = o ? outcomeLine({ outcome: o.outcome, gate: o.gate, summary: text }) : text?.replace(/\s+/g, ' ');
  const tail = a.branchFate ? ` (${FATE_TEXT[a.branchFate](a.base)})` : '';
  if (!head) return tail.trim() || undefined;
  const room = BRIEF_CHARS - tail.length;
  return (head.length > room ? `${head.slice(0, room - 1)}…` : head) + tail;
}

/** Pi reports a bare model id; keep a matching explicit provider qualifier for reliable CLI replay. */
function archiveModel(rec: NodeRecord, status?: NodeStatus): string | undefined {
  const model = status?.model;
  if (rec.harness !== 'pi') return model ?? rec.model;
  if (!model || model === 'unknown') return rec.model;
  if (rec.model?.includes('/') && rec.model.slice(rec.model.indexOf('/') + 1) === model) return rec.model;
  return model;
}

/** The archive line for a node being closed. */
export function archivedOf(rec: NodeRecord, status: NodeStatus | undefined, outcome: Outcome | undefined, rootId: string, fate: BranchFate, closedAt = Date.now()): ArchivedNode {
  const a: Omit<ArchivedNode, 'brief'> = {
    id: rec.id, rootId, parentId: rec.parentId, title: rec.title, cwd: rec.cwd, model: archiveModel(rec, status), effort: rec.effort, explicit: rec.explicit, account: rec.account,
    ...(rec.gardener ? { gardener: rec.gardener } : {}),
    role: roleFor(rec.role, rec.parentId), profile: profileFor(rec.profile, rec.parentId, rec.role), ...(rec.harness && rec.harness !== 'claude' ? { harness: rec.harness } : {}),
    prompt: rec.prompt, sessionId: rec.sessionId, previousSessions: rec.previousSessions, sessionHistory: rec.sessionHistory,
    transcriptPath: rec.transcriptPath, lastAssistantMessage: status?.lastAssistantMessage, outcome, spentUsd: rec.spentUsd, spentIncomplete: rec.spentIncomplete, lastCost: rec.lastCost,
    branch: rec.worktree?.branch, ...fate, createdAt: rec.createdAt, closedAt,
  };
  return { ...a, brief: briefOf(a) };
}

export const archiveNode = (dir: string, a: ArchivedNode): void => appendLine(join(dir, ARCHIVE), a);

/** The tree's archive lines. Agents can write the file, so rootId comes from the directory, never from the line. */
async function readArchive(dir: string, rootId: string): Promise<ArchivedNode[]> {
  let raw: string;
  try { raw = await readFile(join(dir, ARCHIVE), 'utf8'); } catch { return []; }
  return raw.split('\n').flatMap((l) => { try { return l ? [{ ...(JSON.parse(l) as ArchivedNode), rootId }] : []; } catch { return []; } });
}

/** Archived nodes, newest closed first: of one tree when rootId is given, and with `query` in title, prompt or last message (any case). */
export async function history(home: string, f: { rootId?: string; query?: string } = {}): Promise<ArchivedNode[]> {
  await flushEvents(); // archive lines still being written
  const q = f.query?.toLowerCase();
  const hit = (a: ArchivedNode) => !q || [a.title, a.prompt, a.lastAssistantMessage].some((s) => s?.toLowerCase().includes(q));
  // prune: reads every archive on each call; keep an index by id if trees and lookups grow large.
  const trees = listSessions(home).filter((s) => !f.rootId || s.rootId === f.rootId);
  return (await Promise.all(trees.map((s) => readArchive(s.dir, s.rootId)))).flat().filter(hit).sort((a, b) => b.closedAt - a.closedAt);
}

/** The newest-closed of `nodes` with id `id`. */
const newest = (nodes: ArchivedNode[], id: string) => nodes.filter((a) => a.id === id).sort((a, b) => b.closedAt - a.closedAt)[0];

/**
 * The archived node `id`, from tree `prefer` when it has one (a line elsewhere could claim the same id), else the newest.
 * Reads tree `prefer` alone first, so a hit there scans no other tree.
 */
export async function findArchived(home: string, id: string, prefer?: string): Promise<ArchivedNode | undefined> {
  if (prefer) {
    await flushEvents(); // archive lines still being written
    const hit = newest(await readArchive(sessionDir(home, prefer), prefer), id);
    if (hit) return hit;
  }
  return newest(await history(home), id);
}
