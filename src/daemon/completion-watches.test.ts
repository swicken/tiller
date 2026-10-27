import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NodeView } from '../shared/protocol.js';
import { CompletionWatches } from './completion-watches.js';

describe('completion watches', () => {
  const nodes = new Map<string, NodeView>();
  const starts = new Map<string, number>();
  let watches: CompletionWatches;
  let notices: string[];
  const add = (id: string, state: NodeView['status']['state'], start: number) => {
    nodes.set(id, { id, title: id, parentId: null, kind: 'claude', cwd: '/', createdAt: 0, unread: false, status: { state, changedAt: start } });
    starts.set(id, start);
  };
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(100);
    nodes.clear();
    starts.clear();
    notices = [];
    watches = new CompletionWatches({ view: (id) => nodes.get(id), turnStartedAt: (id) => starts.get(id) },
      (text) => { notices.push(text); });
  });
  afterEach(() => vi.useRealTimers());

  it('counts the active turn at registration, while an idle node needs a later turn', () => {
    add('active', 'working', 10);
    add('idle', 'done', 20);
    watches.register({ ids: ['active', 'idle'], when: 'all', of: 'turn' });
    nodes.get('active')!.status.state = 'done';
    watches.sweep(110);
    expect(notices).toEqual([]);
    starts.set('idle', 120);
    watches.sweep(130);
    expect(notices).toEqual(['2 of 2 finished:\nactive: done\nidle: done']);
    expect(watches.covers('active')).toBe(false);
    watches.sweep(140);
    expect(notices).toHaveLength(1);
  });

  it('replaces the same deduplicated id set and drops coverage before sending an any notice', () => {
    add('a', 'working', 10);
    add('b', 'working', 20);
    watches = new CompletionWatches({ view: (id) => nodes.get(id), turnStartedAt: (id) => starts.get(id) }, (text) => {
      expect(watches.covers('a')).toBe(false);
      notices.push(text);
    });
    expect(watches.register({ ids: ['b', 'a', 'a'], when: 'all', of: 'success' })).toEqual({ replaced: false });
    expect(watches.register({ ids: ['a', 'b'], when: 'any', of: 'turn' })).toEqual({ replaced: true });
    nodes.get('a')!.status.state = 'done';
    watches.sweep(120);
    expect(notices).toEqual(['1 of 2 finished:\na: done\nb: working']);
  });

  it('forgets a node the watcher closes: the rest still report, and a watch left empty never fires', () => {
    add('a', 'working', 10);
    add('b', 'working', 20);
    add('c', 'working', 30);
    watches.register({ ids: ['a', 'b'], when: 'all', of: 'turn' });
    watches.register({ ids: ['c'], when: 'all', of: 'turn' });
    nodes.get('b')!.status.state = 'done';
    starts.set('b', 120);
    watches.forget('a'); // b, the only node left, has finished: it reports at once, without a
    expect(notices).toEqual(['1 of 1 finished:\nb: done']);
    watches.forget('c');
    nodes.delete('c');
    watches.sweep(130);
    expect(notices).toHaveLength(1);
    expect(watches.covers('c')).toBe(false);
  });

  it('passes the label and the watched ids to notify', () => {
    add('a', 'done', 10);
    add('b', 'done', 20);
    const calls: unknown[][] = [];
    watches = new CompletionWatches({ view: (id) => nodes.get(id), turnStartedAt: () => 200 }, (...args) => { calls.push(args); });
    watches.register({ ids: ['b', 'a'], when: 'all', of: 'turn' });
    expect(calls).toEqual([['2 of 2 finished:\na: done\nb: done', 'tiller (notify_when all of turn)', ['a', 'b']]]);
  });

  it('waits for a fresh report of either verdict, and counts removed or exited nodes', () => {
    add('a', 'done', 10);
    add('b', 'working', 20);
    add('c', 'working', 30);
    nodes.get('a')!.outcome = { outcome: 'succeeded', at: 50 };
    watches.register({ ids: ['a', 'b', 'c'], when: 'all', of: 'success' });
    nodes.delete('b');
    nodes.get('c')!.status.exited = true;
    watches.sweep(120);
    expect(notices).toEqual([]);
    nodes.get('a')!.outcome = { outcome: 'failed', at: 130, note: 'check failed' };
    watches.sweep(140);
    expect(notices).toEqual(['3 of 3 finished:\na: failed: check failed\nb: closed\nc: exited']);
  });

  it('expires a watch before checking a newly finished node after twelve hours', () => {
    add('a', 'working', 10);
    watches.register({ ids: ['a'], when: 'all', of: 'turn' });
    nodes.get('a')!.status.state = 'done';
    watches.sweep(100 + 12 * 3600_000 + 1);
    expect(notices).toEqual([]);
    expect(watches.covers('a')).toBe(false);
  });
});
