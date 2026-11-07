import { beforeEach, expect, it, vi } from 'vitest';
import type { ExpiringSession } from '../src/shared/protocol';
import { elements, type Element } from './test-tree';
import { RetentionNotice, retentionNotice } from './RetentionNotice';
import { RetentionDialog } from './dialogs/RetentionDialog';
import { getState, update } from './store';
import { send } from './conn';

const DAY = 86_400_000;
const NOW = new Date(2026, 10, 7, 12).getTime();
const hooks = vi.hoisted(() => ({ confirming: null as string | null }));
vi.mock('react', async (original) => ({
  ...await original<typeof import('react')>(),
  useState: () => [hooks.confirming, (value: string | null) => { hooks.confirming = value; }],
}));
vi.mock('./conn', () => ({ send: vi.fn() }));
vi.mock('./hooks', () => ({ useNow: () => NOW }));
vi.mock('./store', async (original) => {
  const store = await original<typeof import('./store')>();
  return { ...store, useStore: (select: (s: ReturnType<typeof store.getState>) => unknown) => select(store.getState()) };
});

const session = (rootId: string, days: number, patch: Partial<ExpiringSession> = {}): ExpiringSession =>
  ({ rootId, title: `t-${rootId}`, cwd: '/w', closedAt: NOW - 10 * DAY, deleteAt: NOW + days * DAY, stage: days <= 1 ? 1 : days <= 3 ? 3 : 7, dismissed: false, restorable: true, ...patch });
const button = (nodes: Element[], label: string) => nodes.find((el) => el.type === 'button' && el.props['aria-label'] === label);

beforeEach(() => { vi.clearAllMocks(); hooks.confirming = null; });

it.each([
  [[session('a', 6)], '1 closed session will be deleted in 6 days', false],
  [[session('a', 3), session('b', 5)], '2 closed sessions will be deleted, starting in 3 days', false],
  [[session('a', 1)], '1 closed session will be deleted tomorrow', true],
  [[session('a', 0.2), session('b', 2)], '2 closed sessions will be deleted, starting today', true],
])('words the banner by the soonest undismissed session (%#)', (sessions, text, urgent) => {
  const notice = retentionNotice(sessions, NOW)!;
  expect(notice.text).toBe(text);
  expect(notice.urgent).toBe(urgent);
  expect(notice.title).toMatch(/deleted on /i);
});

it('counts and times only undismissed sessions, and hides when all are dismissed', () => {
  expect(retentionNotice([session('a', 1, { dismissed: true }), session('b', 5)], NOW)!.text).toBe('1 closed session will be deleted in 5 days');
  expect(retentionNotice([session('a', 1, { dismissed: true })], NOW)).toBeNull();
  update(() => ({ retention: [session('a', 1, { dismissed: true })] }));
  expect(RetentionNotice()).toBeNull();
});

it('alerts at stage 1, opens the review dialog and dismisses the undismissed ids', () => {
  update(() => ({ retention: [session('a', 1), session('b', 2, { dismissed: true }), session('c', 4)], dialog: null }));
  const banner = RetentionNotice() as Element;
  expect(banner.props.role).toBe('alert');
  const nodes = elements(banner);
  button(nodes, 'Review sessions due for deletion')!.props.onClick();
  expect(getState().dialog).toEqual({ kind: 'retention' });
  button(nodes, 'Dismiss session deletion warning')!.props.onClick();
  expect(send).toHaveBeenCalledWith({ t: 'retentionDismiss', rootIds: ['a', 'c'] });
  update(() => ({ retention: [session('c', 4)] }));
  expect((RetentionNotice() as Element).props.role).toBe('status');
});

it('lists every session in the dialog and sends keep, restore and delete only after a second click', () => {
  update(() => ({ retention: [session('a', 1, { dismissed: true }), session('b', 4, { restorable: false, title: undefined })] }));
  let nodes = elements(RetentionDialog());
  expect(nodes.filter((el) => el.type === 'li').map((el) => el.key)).toEqual(['a', 'b']);
  expect(button(nodes, 'Restore b')).toBeUndefined();
  button(nodes, 'Keep t-a')!.props.onClick();
  expect(send).toHaveBeenLastCalledWith({ t: 'sessionKeep', rootId: 'a' });
  button(nodes, 'Restore t-a')!.props.onClick();
  expect(send).toHaveBeenLastCalledWith({ t: 'restore', id: 'a' });
  vi.mocked(send).mockClear();
  button(nodes, 'Delete now: b')!.props.onClick();
  expect(send).not.toHaveBeenCalled();
  nodes = elements(RetentionDialog());
  expect(button(nodes, 'Delete now: b')).toBeUndefined();
  button(nodes, 'Confirm delete b')!.props.onClick();
  expect(send).toHaveBeenCalledWith({ t: 'sessionDelete', rootId: 'b' });
});

it('holds retention from the snapshot and retention messages', async () => {
  const { applyServer } = await import('./store');
  applyServer({ t: 'snapshot', nodes: [], retention: [session('a', 4)] });
  expect(getState().retention?.map((s) => s.rootId)).toEqual(['a']);
  applyServer({ t: 'retention', sessions: [] });
  expect(getState().retention).toEqual([]);
});
