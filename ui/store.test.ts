import { expect, it, vi } from 'vitest';
import { claudeAccounts, conversation, mk } from './fixtures';
import { applyServer, conversationRequested, conversationsRequested, diffRequested, expectSpawn, getState, memoryActionRequested, memoryRequested, selectNode, showPane, toggleShowTools, update, transcriptRequested, viewArchived, viewMemory } from './store';
import type { MemoryPage } from '../src/shared/protocol';

it('the diff panel shows the diff reply\'s own failure, not another error for the same node', () => {
  diffRequested('a');
  applyServer({ t: 'error', id: 'a', message: 'no such node: a' }); // say, a mute that failed
  expect(getState().diff).toEqual({ id: 'a' });
  applyServer({ t: 'diff', id: 'a', error: 'a has no worktree of its own to diff' });
  expect(getState().diff).toEqual({ id: 'a', error: 'a has no worktree of its own to diff' });
});

it('a transcript reply lands in the slot asked for and is ignored for another node or session', () => {
  const data = { entries: [{ role: 'user' as const, text: 'hi' }], sessions: [{ sessionId: 's2', current: true }, { sessionId: 's1', current: false }] };
  transcriptRequested('a');
  applyServer({ t: 'transcript', id: 'b', ...data });
  applyServer({ t: 'transcript', id: 'a', sessionId: 's1', ...data });
  expect(getState().transcript).toEqual({ id: 'a' });
  applyServer({ t: 'transcript', id: 'a', sessionId: 's2', ...data }); // the current session, named by the reply
  expect(getState().transcript).toEqual({ id: 'a', sessionId: undefined, data });

  transcriptRequested('a'); // a refresh keeps the old data until the reply
  expect(getState().transcript?.data).toEqual(data);
  transcriptRequested('a', 's1');
  expect(getState().transcript).toEqual({ id: 'a', sessionId: 's1' });
  applyServer({ t: 'transcript', id: 'a', ...data });
  expect(getState().transcript).toEqual({ id: 'a', sessionId: 's1' });
  applyServer({ t: 'transcript', id: 'a', sessionId: 's1', error: 'session file is gone' });
  expect(getState().transcript).toEqual({ id: 'a', sessionId: 's1', error: 'session file is gone' });
});

it('toggleShowTools persists tl.showTools per viewer and still toggles when localStorage throws', () => {
  const saved = new Map<string, string>();
  vi.stubGlobal('localStorage', { setItem: (k: string, v: string) => saved.set(k, v) });
  expect(getState().showTools).toBe(false);
  toggleShowTools();
  expect(getState().showTools).toBe(true);
  expect(saved.get('tl.showTools')).toBe('1');
  vi.stubGlobal('localStorage', { setItem: () => { throw new Error('denied'); } });
  toggleShowTools();
  expect(getState().showTools).toBe(false);
  vi.unstubAllGlobals();
});

it('a throwing localStorage getItem at load leaves showTools off', async () => {
  vi.stubGlobal('localStorage', { getItem: () => { throw new Error('denied'); } });
  vi.resetModules();
  const fresh = await import('./store');
  expect(fresh.getState().showTools).toBe(false);
  vi.unstubAllGlobals();
});

it('a conversation reply lands only in the slot asked for; a stale one is ignored', () => {
  conversationRequested('w');
  applyServer({ t: 'conversation', id: 'w', with: 'p', ...conversation }); // the peer conversation, not the upward one
  applyServer({ t: 'conversation', id: 'x', ...conversation });
  expect(getState().conversation).toEqual({ id: 'w' });
  applyServer({ t: 'conversation', id: 'w', ...conversation });
  expect(getState().conversation?.data).toEqual(conversation);

  conversationRequested('w'); // a refresh keeps the data until the reply
  expect(getState().conversation?.data).toEqual(conversation);
  conversationRequested('w', 'p');
  applyServer({ t: 'conversation', id: 'w', ...conversation }); // late reply for the previous choice
  expect(getState().conversation).toEqual({ id: 'w', with: 'p' });
  applyServer({ t: 'conversation', id: 'w', with: 'p', error: 'no such node: p' });
  expect(getState().conversation).toEqual({ id: 'w', with: 'p', error: 'no such node: p' });

  const items = [{ id: 'w', relation: 'parent' as const, counterpart: 'root', title: 'tiller', live: true, messages: 3 }];
  conversationsRequested('w');
  applyServer({ t: 'conversations', id: 'other', items });
  expect(getState().conversations).toEqual({ id: 'w' });
  applyServer({ t: 'conversations', id: 'w', items });
  expect(getState().conversations).toEqual({ id: 'w', items });
});

it('a history reply replaces the items', () => {
  const item = (id: string) => ({ id, rootId: 'r', parentId: null, title: id, cwd: '/w', createdAt: 0, closedAt: 1 });
  applyServer({ t: 'history', items: [item('x'), item('y')] });
  applyServer({ t: 'history', items: [item('z')] });
  expect(getState().history.map((a) => a.id)).toEqual(['z']);
});

it('rejects stale current-session metadata after the live node changes session, including historical requests', () => {
  update(() => ({ nodes: { switched: { ...mk('switched', null, 0), sessionId: 'new-current', harness: 'codex' } } }));
  const old = { entries: [{ role: 'assistant' as const, text: 'old answer' }], sessions: [{ sessionId: 'old-current', current: true }] };
  transcriptRequested('switched');
  applyServer({ t: 'transcript', id: 'switched', ...old });
  expect(getState().transcript?.data).toBeUndefined();
  transcriptRequested('switched', 'historical');
  const fresh = { ...old, sessions: [{ sessionId: 'new-current', current: true }, { sessionId: 'historical', current: false }] };
  applyServer({ t: 'transcript', id: 'switched', sessionId: 'historical', ...fresh });
  applyServer({ t: 'transcript', id: 'switched', sessionId: 'historical', ...old });
  expect(getState().transcript?.data).toEqual(fresh);
});

it('a failed spawn stops the wait, so the next node someone else spawns is not selected', () => {
  applyServer({ t: 'snapshot', nodes: [mk('r', null, 1)] });
  expectSpawn();
  applyServer({ t: 'error', message: 'fork: no session on record' });
  applyServer({ t: 'node', node: mk('other', 'r', 2) });
  expect(getState().selected).toBe('r');
});

it('retains source reports through selection, removal and older snapshots, and accepts authoritative new snapshots', () => {
  const source = { id: 'source', tool: 'claude' as const, scope: 'account' as const, nodeIds: ['usage-a'], rateLimits: [{ kind: '5h', percentUsed: 30 }], at: 100, checkedAt: 100, installed: true, configured: true, authenticated: true, availability: 'available' as const };
  applyServer({ t: 'snapshot', nodes: [mk('usage-a', null, 1), mk('usage-b', null, 2)], usageSources: [source] });
  applyServer({ t: 'focus', from: 'human', id: 'usage-b' });
  applyServer({ t: 'removed', id: 'usage-a' });
  applyServer({ t: 'snapshot', nodes: [] });
  expect(getState().usageSources).toEqual([source]);
  applyServer({ t: 'usageSources', sources: [{ ...source, at: 200 }] });
  expect(getState().usageSources?.[0].at).toBe(200);
  applyServer({ t: 'snapshot', nodes: [], usageSources: [] });
  expect(getState().usageSources).toEqual([]);
});

it('a legacy-daemon refresh error clears the scanning state', () => {
  update(() => ({ usageScanning: true }));
  applyServer({ t: 'error', message: 'Malformed message' });
  expect(getState().usageScanning).toBe(false);
});

it('accepts release snapshots and update progress while preserving settings-era usage and activity', () => {
  const releases = { sha: 'a'.repeat(40), runtimeSha: 'a'.repeat(40), eligible: false, releases: [], checkedAt: 1, reason: 'offline' };
  applyServer({ t: 'snapshot', nodes: [], update: releases });
  const sources = getState().usageSources;
  const activity = getState().activity;
  expect(getState().update).toEqual(releases);
  applyServer({ t: 'update', update: { ...releases, applying: true } });
  expect(getState().update?.applying).toBe(true);
  expect(getState().usageSources).toBe(sources);
  expect(getState().activity).toBe(activity);
  const count = getState().toasts.length;
  applyServer({ t: 'update', update: { ...releases, failed: 'build failed; see update.log' } });
  applyServer({ t: 'update', update: { ...releases, failed: 'build failed; see update.log' } });
  expect(getState().toasts.length).toBe(count + 1);
});

it('keeps the latest claudeAccounts reply', () => {
  applyServer({ t: 'claudeAccounts', accounts: claudeAccounts });
  expect(getState().claudeAccounts).toEqual(claudeAccounts);
  applyServer({ t: 'claudeAccounts', accounts: [] });
  expect(getState().claudeAccounts).toEqual([]);
});

const memoryPage = (items: number[]): MemoryPage => ({
  target: { account: null }, file: '_default', state: 'ok', quarantined: [], files: [], repos: [], on: true, source: 's',
  counts: { ledger: 0, open_question: 0, procedure: 0, pitfall: 0, note: 0, pinned: 0, retracted: 0 },
  items: items.map((id) => ({ id, kind: 'note', text: `m${id}`, author: 'human', seen: 0, pinned: false, createdAt: 0, updatedAt: 0 })),
});

it('keeps a memory reply only for the latest rid of its slot, and appends a Load more', () => {
  const stale = memoryRequested('memory', 0);
  const latest = memoryRequested('memory', 0);
  applyServer({ t: 'memory', rid: stale, ...memoryPage([1]) });
  expect(getState().memory).toEqual({ rid: latest, data: undefined, more: false });
  applyServer({ t: 'memory', rid: latest, ...memoryPage([2]) });
  expect(getState().memory?.data?.items.map((i) => i.id)).toEqual([2]);
  const more = memoryRequested('memory', 0, true);
  expect(getState().memory?.data?.items.map((i) => i.id)).toEqual([2]); // shown while the next page is out
  applyServer({ t: 'memory', rid: more, ...memoryPage([3]) });
  expect(getState().memory?.data?.items.map((i) => i.id)).toEqual([2, 3]);
  const failed = memoryRequested('memory', 0);
  applyServer({ t: 'memory', rid: failed, error: 'dir must be the absolute path of a directory: x' });
  expect(getState().memory).toMatchObject({ rid: failed, error: 'dir must be the absolute path of a directory: x' });
  expect(getState().memory?.data?.items.map((i) => i.id)).toEqual([2, 3]); // the page stays, to correct the target from
  memoryRequested('memory', failed); // a pane opened after that reply does not show it
  expect(getState().memory?.data).toBeUndefined();

  const item = memoryRequested('memoryItem', 0);
  applyServer({ t: 'memoryItem', rid: item - 1, error: 'stale' });
  expect(getState().memoryItem).toEqual({ rid: item, data: undefined });
  applyServer({ t: 'memoryItem', rid: item, error: 'no item m9' });
  expect(getState().memoryItem).toEqual({ rid: item, error: 'no item m9' });
  const given = memoryRequested('memoryGiven', 0);
  applyServer({ t: 'memoryGiven', rid: given, injections: [] });
  expect(getState().memoryGiven).toEqual({ rid: given, data: [] });
  const claude = memoryRequested('claudeMemory', 0);
  applyServer({ t: 'claudeMemory', rid: claude + 1, dir: '/d', files: [], omitted: [] });
  expect(getState().claudeMemory).toEqual({ rid: claude, data: undefined });
});

it('a memory action reply toasts its result and bumps the revision the open pane refetches on', () => {
  const rev = getState().memoryRev;
  applyServer({ t: 'memoryAction', rid: memoryActionRequested('restore'), item: memoryPage([4]).items[0] });
  applyServer({ t: 'memoryAction', rid: memoryActionRequested('pin'), error: 'memory is off for /r' });
  expect(getState().memoryRev).toBe(rev + 2);
  expect(getState().memoryActed).toEqual({ rid: expect.any(Number), ok: false });
  expect(getState().toasts.slice(-2).map((t) => [t.text, t.tone])).toEqual([['Restored m4', 'ok'], ['Memory not changed: memory is off for /r', 'bad']]);
});

it('showPane memory clears the other panes, and the memory view and a closed node replace each other', () => {
  showPane('transcript');
  showPane('memory');
  expect([getState().memoryOpen, getState().transcriptOpen, getState().diffOpen]).toEqual([true, false, false]);
  showPane('diff');
  expect(getState().memoryOpen).toBe(false);
  const closed = { id: 'c', rootId: 'c', parentId: null, title: 'c', cwd: '/w', createdAt: 0, closedAt: 1 };
  viewArchived(closed);
  viewMemory({ nodeId: 'c' });
  expect([getState().archived, getState().memoryView]).toEqual([null, { nodeId: 'c' }]);
  viewArchived(closed);
  expect([getState().archived, getState().memoryView]).toEqual([closed, null]);
  viewMemory({ nodeId: 'c' }, closed);
  viewMemory(null); // closing a view opened from a closed node's pane shows that pane again
  expect([getState().archived, getState().memoryView]).toEqual([closed, null]);
  viewMemory(null);
  expect(getState().archived).toBe(closed);
  viewMemory({});
  viewMemory(null);
  expect([getState().archived, getState().memoryView]).toEqual([null, null]);
  viewMemory({});
  update((s) => ({ nodes: { ...s.nodes, sel: mk('sel', null, 0) } }));
  selectNode('sel');
  expect(getState().memoryView).toBeNull();
});
