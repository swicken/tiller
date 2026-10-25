// memory_search queries out of harness transcripts (memory-v4 plan §2.7), and the R2b collection file that holds them.
// The daemon's transcript reader (src/daemon/transcript.ts) keeps only tool names, so this reads the arguments itself:
// - Claude: assistant `tool_use` blocks named mcp__<tiller server>__memory_search, with `input`;
// - Pi: assistant `toolCall` blocks named mcp__tl_<prefix>_<random>__memory_search, with `arguments`;
// - Codex: the bridge's transcript is in the Claude format but records tool names only, so its header's threadId leads to
//   Codex's own rollout (<CODEX_HOME>/sessions/**/rollout-*-<threadId>.jsonl), whose `McpToolCall` items carry the
//   server, tool and arguments of every MCP call.
// Collected queries are real-derived text: the file goes under <root>/results, never into the repo.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Harness } from '../../../src/shared/protocol.js';
import type { RetrievalQuery } from '../retrieval/types.js';

/** Tiller's MCP server as each harness names it: tiller (Claude), tiller_<hash> or tl_<hash> (Codex), tl_<prefix>_<random> (Pi). */
const SERVER = /^(?:tiller|tl)(?:_[A-Za-z0-9]+)*$/;
const TOOL = 'memory_search';
const isSearch = (name: unknown): boolean => {
  if (typeof name !== 'string' || !name.startsWith('mcp__') || !name.endsWith(`__${TOOL}`)) return false;
  return SERVER.test(name.slice('mcp__'.length, -`__${TOOL}`.length));
};

type Json = Record<string, any>;
const lines = (raw: string): Json[] => raw.split('\n').flatMap((l) => {
  if (!l.trim()) return [];
  try {
    const v: unknown = JSON.parse(l);
    return v && typeof v === 'object' && !Array.isArray(v) ? [v as Json] : [];
  } catch { return []; }
});
const queryOf = (args: unknown): string[] => {
  const q = (args as Json | undefined)?.query;
  return typeof q === 'string' && q.trim() ? [q] : [];
};
const blocks = (content: unknown): Json[] => (Array.isArray(content) ? content.filter((b) => b && typeof b === 'object') : []);

/** Claude's transcript (and the Codex bridge's, which has no tool inputs): queries in call order. */
export const claudeQueries = (raw: string): string[] => lines(raw)
  .filter((e) => e.type === 'assistant')
  .flatMap((e) => blocks(e.message?.content).filter((b) => b.type === 'tool_use' && isSearch(b.name)).flatMap((b) => queryOf(b.input)));

/** Pi's session file, in file order (a bench node never branches). */
export const piQueries = (raw: string): string[] => lines(raw)
  .filter((e) => e.type === 'message' && e.message?.role === 'assistant')
  .flatMap((e) => blocks(e.message?.content).filter((b) => b.type === 'toolCall' && isSearch(b.name)).flatMap((b) => queryOf(b.arguments)));

/** A Codex rollout: every completed or failed McpToolCall item to tiller's memory_search. */
export const codexRolloutQueries = (raw: string): string[] => lines(raw)
  .filter((e) => e.type === 'event_msg' && e.payload?.type === 'item_completed')
  .map((e) => e.payload.item as Json | undefined)
  .filter((it) => it?.type === 'McpToolCall' && it.tool === TOOL && typeof it.server === 'string' && SERVER.test(it.server))
  .flatMap((it) => queryOf(it!.arguments));

/** The Codex thread a bridge transcript belongs to, from its header line. */
export function codexThread(raw: string): string | undefined {
  const head = lines(raw.slice(0, raw.indexOf('\n') + 1 || raw.length))[0];
  return head?.type === 'codex_session' && typeof head.threadId === 'string' ? head.threadId : undefined;
}

/** Codex's rollout file for a thread, under sessions/ or archived_sessions/ of its home. */
export function codexRollout(threadId: string, codexHome = process.env.CODEX_HOME || join(homedir(), '.codex')): string | undefined {
  if (!/^[\w-]+$/.test(threadId)) return undefined;
  for (const sub of ['sessions', 'archived_sessions']) {
    const dir = join(codexHome, sub);
    if (!existsSync(dir)) continue;
    const hit = readdirSync(dir, { recursive: true, encoding: 'utf8' }).find((f) => f.endsWith(`-${threadId}.jsonl`));
    if (hit) return join(dir, hit);
  }
  return undefined;
}

/** The memory_search queries a node wrote, in call order, from its transcript file. Throws when Codex's rollout is missing. */
export function transcriptQueries(path: string, harness: Harness, codexHome?: string): string[] {
  const raw = readFileSync(path, 'utf8');
  if (harness === 'pi') return piQueries(raw);
  if (harness === 'claude') return claudeQueries(raw);
  const thread = codexThread(raw);
  const rollout = thread && codexRollout(thread, codexHome);
  if (!rollout) throw new Error(`no Codex rollout for ${thread ? `thread ${thread}` : `${path} (no codex_session header)`}`);
  return codexRolloutQueries(readFileSync(rollout, 'utf8'));
}

// --- The R2b collection file (<root>/results/r2b-queries-<date>.json) ---

export const R2B_VERSION = 1;

/** One sampled node on one harness. */
export interface R2bRun {
  tree: string;
  node: string;
  cluster: string;
  harness: Harness;
  model?: string;
  /** The archived node's createdAt: the store held what closed before it. */
  asOf: number;
  /** Label item ids in the as-of store (lib/archive.ts labels, through ledgerIds). */
  relevant: number[];
  /**
   * ok: at least one query; no-query: the node finished without calling memory_search; blocked: it waited on a
   * permission or trust prompt (the harness cannot run unattended); timeout; error: an infra failure (detail says).
   */
  status: 'ok' | 'no-query' | 'blocked' | 'timeout' | 'error';
  detail?: string;
  /** memory_search queries in call order: the first is scored, the rest are reformulations kept for reading. */
  queries: string[];
  spentUsd?: number;
}

export interface R2bFile {
  version: typeof R2B_VERSION;
  generatedAt: string;
  seed: number;
  perTree: number;
  runs: R2bRun[];
}

/** The scored R2b queries: each run's first query. */
export const r2bQueries = (file: R2bFile): RetrievalQuery[] => file.runs.filter((r) => r.queries.length).map((r) => ({
  id: `${r.tree}/${r.node}/r2b/${r.harness}`, set: 'r2b', text: r.queries[0], harness: r.harness,
  tree: r.tree, cluster: r.cluster, node: r.node, asOf: r.asOf, relevant: r.relevant,
}));
