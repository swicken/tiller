import { expect, it, vi } from 'vitest';
import { claudeAccounts, conversation, mk } from './fixtures';
import { applyServer, conversationRequested, conversationsRequested, diffRequested, expectSpawn, getState, selectSession, toggleShowTools, update, transcriptRequested } from './store';
import { roots } from './sidebar/sessions';

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

it('keeps session tabs in the daemon\'s saved order, puts new sessions last and hands a closed session\'s selection to its right-hand neighbour', () => {
  const [a, b, c, child] = [mk('a', null, 1), mk('b', null, 3), mk('c', null, 2), mk('child', 'b', 4)];
  update(() => ({ nodes: {}, order: [], sessionOrder: [], selected: null, session: null }));
  applyServer({ t: 'snapshot', nodes: [a, b, c, child], sessionOrder: ['c', 'a', 'b'] });
  const tabs = () => roots(getState().nodes, getState().order).map((r) => r.id);
  expect(tabs()).toEqual(['c', 'a', 'b']);
  // A new session goes last, though it changed most recently; its child stays with its siblings.
  applyServer({ t: 'node', node: mk('d', null, 99) });
  expect(tabs()).toEqual(['c', 'a', 'b', 'd']);
  applyServer({ t: 'sessionOrder', ids: ['b', 'd', 'c', 'a'] });
  expect(tabs()).toEqual(['b', 'd', 'c', 'a']);
  expect(getState().sessionOrder).toEqual(['b', 'd', 'c', 'a']);
  // A reload keeps it.
  applyServer({ t: 'snapshot', nodes: [a, b, c, child, mk('d', null, 99)], sessionOrder: ['b', 'd', 'c', 'a'] });
  expect(tabs()).toEqual(['b', 'd', 'c', 'a']);
  selectSession('d');
  applyServer({ t: 'removed', id: 'd' });
  expect(getState().session).toBe('c');
  selectSession('a');
  applyServer({ t: 'removed', id: 'a' }); // the last tab: its left-hand neighbour
  expect(getState().session).toBe('c');
});

