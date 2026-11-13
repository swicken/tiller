import { expect, it } from 'vitest';
import { mk } from '../fixtures';
import { ago, listing, questionsIn, reminderList, shortAge } from './model';
import { mkq, NOW } from './fixtures';

// Two sessions: a (with its child a1) and b. Questions are listed by the node that owns them.
const a = mk('a', null, 1), a1 = mk('a1', 'a', 2), b = mk('b', null, 3), blocked = mk('c', 'b', 4, { state: 'blocked', activity: 'Bash: rm -rf x' });
const nodes = { a, a1, b, c: blocked };
const order = ['a', 'a1', 'b', 'c'];

it('lists the selected node\'s own question first, then waiting before carrying on, oldest first; other sessions are not listed', () => {
  const qs = Object.fromEntries([
    mkq('old', 'a1', 30), mkq('carry', 'a', 50, { assumption: 'going on' }), mkq('own', 'a', 5), mkq('other', 'b', 90), mkq('done', 'a', 60, { state: 'dismissed' }),
  ].map((q) => [q.id, q]));
  expect(reminderList(qs, nodes, 'a', 'a').map((q) => q.id)).toEqual(['own', 'carry', 'old']);
  expect(reminderList(qs, nodes, 'a', 'a1').map((q) => q.id)).toEqual(['old', 'own', 'carry']);
  expect(reminderList(qs, nodes, 'b', 'b').map((q) => q.id)).toEqual(['other']);
});

it('groups by session with the session on screen first and puts an approval row in its session\'s group', () => {
  const qs = Object.fromEntries([mkq('qa', 'a', 5), mkq('qb', 'b', 10)].map((q) => [q.id, q]));
  const { groups, waiting } = listing(qs, nodes, order, 'b', ['qa', 'qb'], NOW);
  expect(groups.map((g) => [g.title, g.note, g.items.map((i) => (i.kind === 'q' ? i.q.id : `approval:${i.node.id}`))])).toEqual([
    ['b', 'this session', ['qb', 'approval:c']],
    ['a', undefined, ['qa']],
  ]);
  expect(waiting).toBe(3);
});

it('orders a group as waiting questions, approvals, then carrying on', () => {
  const qs = Object.fromEntries([mkq('carry', 'b', 40, { assumption: 'x' }), mkq('wait', 'b', 10)].map((q) => [q.id, q]));
  const { groups } = listing(qs, nodes, order, 'b', ['wait', 'carry'], NOW);
  expect(groups[0].items.map((i) => (i.kind === 'q' ? i.q.id : 'approval'))).toEqual(['wait', 'approval', 'carry']);
});

it('keeps a question that was open in its place after it resolves, and lists other resolved questions in the sections', () => {
  const answered = (id: string, state: 'delivered' | 'queued', extra = {}) => mkq(id, 'a', 20, { state: 'answered', resolvedAt: NOW - 60_000, delivery: { state }, ...extra });
  const qs = Object.fromEntries([
    answered('pinned', 'delivered'), answered('wait', 'queued'), answered('ok', 'delivered'), mkq('gone', 'a', 30, { state: 'withdrawn', resolvedAt: NOW - 2 * 86_400_000 }),
  ].map((q) => [q.id, q]));
  const l = listing(qs, nodes, order, 'a', ['pinned'], NOW);
  expect(questionsIn(l.groups).map((q) => q.id)).toEqual(['pinned']);
  expect(questionsIn(l.notDelivered).map((q) => q.id)).toEqual(['wait']);
  // Resolved more than a day ago is no longer "Done in the last day".
  expect(questionsIn(l.done).map((q) => q.id)).toEqual(['ok']);
});

it('headers a group for a session that no longer exists with its rootTitle, or "Closed sessions", last', () => {
  const resolved = (id: string, extra = {}) => mkq(id, 'gone', 20, { state: 'dismissed', resolvedAt: NOW - 60_000, ...extra });
  const qs = Object.fromEntries([resolved('x', { rootTitle: 'spike', rootId: 'r1' }), resolved('y'), mkq('live', 'a', 5, { state: 'dismissed', resolvedAt: NOW - 1000 })].map((q) => [q.id, q]));
  const { done } = listing(qs, nodes, order, 'a', [], NOW);
  expect(done.map((g) => [g.title, g.note])).toEqual([['a', 'this session'], ['spike', 'closed session'], ['Closed sessions', undefined]]);
});

it('words ages as the design does', () => {
  expect([0, 4 * 60_000, 2 * 3_600_000, 30 * 3_600_000, 5 * 86_400_000].map(ago)).toEqual(['just now', '4 min ago', '2 h ago', 'yesterday', '5 d ago']);
  expect([4 * 60_000, 3_600_000].map(shortAge)).toEqual(['4m', '1h']);
});
