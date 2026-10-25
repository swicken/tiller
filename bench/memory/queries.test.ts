// lib/queries.ts on synthetic transcripts, one canned snippet per harness (memory-v4 plan §5, Gate).
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { claudeQueries, codexRolloutQueries, piQueries, r2bQueries, transcriptQueries, type R2bFile } from './lib/queries.js';

const jsonl = (...entries: object[]) => entries.map((e) => JSON.stringify(e)).join('\n') + '\n';

const claude = jsonl(
  { type: 'user', message: { role: 'user', content: 'task text' } },
  { type: 'assistant', message: { role: 'assistant', content: [
    { type: 'text', text: 'Looking up earlier work.' },
    { type: 'tool_use', id: 't1', name: 'mcp__tiller__memory_search', input: { query: 'gate failure changelog' } },
  ] } },
  { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: '(no matching items)' }] } },
  { type: 'assistant', message: { content: [
    { type: 'tool_use', id: 't2', name: 'mcp__other__memory_search', input: { query: 'not tiller' } },
    { type: 'tool_use', id: 't3', name: 'mcp__tiller__memory_get', input: { id: 'm1' } },
    { type: 'tool_use', id: 't4', name: 'mcp__tiller__memory_search', input: { query: 'changelog entry', kind: 'pitfall' } },
  ] } },
);

// The Codex bridge's own transcript: a header, then the Claude format with tool names only.
const bridge = jsonl(
  { type: 'codex_session', threadId: '01a2b3c4-0000-7000-8000-000000000001' },
  { type: 'user', message: { content: [{ type: 'text', text: 'task text' }] } },
  { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'mcp__tiller_9f8e7d6c5b4a__memory_search' }] } },
);
const rollout = jsonl(
  { type: 'session_meta', payload: { id: '01a2b3c4-0000-7000-8000-000000000001' } },
  { type: 'response_item', payload: { type: 'custom_tool_call', name: 'exec', input: 'text(await tools.mcp__tiller_9f8e7d6c5b4a__memory_search({query:"in code"}))' } },
  { type: 'event_msg', payload: { type: 'item_completed', item: { type: 'McpToolCall', server: 'tiller_9f8e7d6c5b4a', tool: 'memory_search', arguments: { query: 'approval policy sandbox' }, status: 'completed' } } },
  { type: 'event_msg', payload: { type: 'item_completed', item: { type: 'McpToolCall', server: 'cua_repl', tool: 'memory_search', arguments: { query: 'other server' }, status: 'completed' } } },
  { type: 'event_msg', payload: { type: 'item_completed', item: { type: 'McpToolCall', server: 'tiller_9f8e7d6c5b4a', tool: 'report_outcome', arguments: { outcome: 'succeeded' }, status: 'completed' } } },
  { type: 'event_msg', payload: { type: 'item_completed', item: { type: 'McpToolCall', server: 'tl_45a35347f8c3', tool: 'memory_search', arguments: { query: 'exec approvals' }, status: 'failed' } } },
);

const pi = jsonl(
  { type: 'session', id: 's1' },
  { type: 'message', id: 'a', parentId: null, message: { role: 'user', content: 'task text' } },
  { type: 'message', id: 'b', parentId: 'a', message: { role: 'assistant', content: [
    { type: 'thinking', thinking: '...' },
    { type: 'toolCall', id: 'c1', name: 'mcp__tl_n1a2b3_7f3e9a0c1d2b__memory_search', arguments: { query: 'worktree merge style' } },
  ] } },
  { type: 'message', id: 'c', parentId: 'b', message: { role: 'toolResult', content: [{ type: 'text', text: 'm3 ...' }] } },
);

const cleanup: (() => void)[] = [];
afterEach(() => { while (cleanup.length) cleanup.pop()!(); });

describe('memory_search queries', () => {
  it('reads Claude tool_use inputs of tiller memory_search only, in call order', () => {
    expect(claudeQueries(claude)).toEqual(['gate failure changelog', 'changelog entry']);
  });

  it('finds no queries in the Codex bridge transcript, which records tool names only', () => {
    expect(claudeQueries(bridge)).toEqual([]);
  });

  it('reads tiller McpToolCall items of a Codex rollout, failed ones included', () => {
    expect(codexRolloutQueries(rollout)).toEqual(['approval policy sandbox', 'exec approvals']);
  });

  it('reads Pi toolCall arguments', () => {
    expect(piQueries(pi)).toEqual(['worktree merge style']);
  });

  it('follows a Codex bridge transcript to its rollout under the Codex home', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tl-bench-queries-'));
    cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
    const day = join(dir, 'codex', 'sessions', '2026', '10', '25');
    mkdirSync(day, { recursive: true });
    writeFileSync(join(day, 'rollout-2026-10-25T10-00-00-01a2b3c4-0000-7000-8000-000000000001.jsonl'), rollout);
    writeFileSync(join(dir, 'bridge.jsonl'), bridge);
    writeFileSync(join(dir, 'claude.jsonl'), claude);
    expect(transcriptQueries(join(dir, 'bridge.jsonl'), 'codex', join(dir, 'codex'))).toEqual(['approval policy sandbox', 'exec approvals']);
    expect(transcriptQueries(join(dir, 'claude.jsonl'), 'claude')).toEqual(['gate failure changelog', 'changelog entry']);
    writeFileSync(join(dir, 'orphan.jsonl'), bridge.replace('000000000001', '000000000002'));
    expect(() => transcriptQueries(join(dir, 'orphan.jsonl'), 'codex', join(dir, 'codex'))).toThrow(/no Codex rollout/);
  });

  it('scores each run by its first query and skips runs without one', () => {
    const run = { tree: 'n-00000000', cluster: 'n-00000001', asOf: 5, relevant: [3], status: 'ok' as const };
    const file: R2bFile = { version: 1, generatedAt: '', seed: 4104, perTree: 25, runs: [
      { ...run, node: 'n-00000004', harness: 'claude', queries: ['first', 'second'] },
      { ...run, node: 'n-00000004', harness: 'codex', queries: [], status: 'no-query' },
    ] };
    expect(r2bQueries(file)).toEqual([{ id: 'n-00000000/n-00000004/r2b/claude', set: 'r2b', text: 'first', harness: 'claude',
      tree: 'n-00000000', cluster: 'n-00000001', node: 'n-00000004', asOf: 5, relevant: [3] }]);
  });
});
