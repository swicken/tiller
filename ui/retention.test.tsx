import { afterEach, beforeEach, expect, it, vi } from 'vitest';
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

beforeEach(() => { vi.clearAllMocks(); hooks.confirming = null; vi.useFakeTimers({ toFake: ['Date'], now: NOW }); });
afterEach(() => { vi.useRealTimers(); });

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

const regions = () => elements(RetentionNotice() as Element).filter((el) => el.props.role);
const roleWithText = () => regions().filter((el) => el.props.children).map((el) => el.props.role);

it('counts and times only undismissed sessions, and empties the banner when all are dismissed', () => {
  expect(retentionNotice([session('a', 1, { dismissed: true }), session('b', 5)], NOW)!.text).toBe('1 closed session will be deleted in 5 days');
  expect(retentionNotice([session('a', 1, { dismissed: true })], NOW)).toBeNull();
  update(() => ({ retention: [session('a', 1, { dismissed: true })] }));
  // The status region stays mounted, empty, so later warnings are announced.
  expect(regions().map((el) => el.props.role)).toEqual(['status']);
  expect(roleWithText()).toEqual([]);
});

it('says the next cleanup, not a past date, once deleteAt has passed', () => {
  const notice = retentionNotice([session('a', -0.1), session('b', 2)], NOW)!;
  expect(notice.text).toBe('2 closed sessions will be deleted, starting at the next cleanup');
  expect(notice.title).not.toMatch(/ on /);
  expect(retentionNotice([session('a', -0.1)], NOW)!.text).toBe('1 closed session will be deleted at the next cleanup');
});

it('shows stage 1 as a separate alert, opens the review dialog and dismisses the undismissed ids', () => {
  update(() => ({ retention: [session('c', 4)], dialog: null }));
  expect(roleWithText()).toEqual(['status']);
  update(() => ({ retention: [session('a', 1), session('b', 2, { dismissed: true }), session('c', 4)], dialog: null }));
  expect(roleWithText()).toEqual(['alert']);
  expect(regions().map((el) => el.props.role)).toEqual(['status', 'alert']);
  const nodes = elements(RetentionNotice() as Element);
  button(nodes, 'Review sessions due for deletion')!.props.onClick();
  expect(getState().dialog).toEqual({ kind: 'retention' });
  button(nodes, 'Dismiss session deletion warning')!.props.onClick();
  expect(send).toHaveBeenCalledWith({ t: 'retentionDismiss', rootIds: ['a', 'c'] });
});

it('lists every session in the dialog and sends keep, restore and delete only after a second click', () => {
  update(() => ({ retention: [session('a', 1, { dismissed: true }), session('b', 4, { restorable: false, title: undefined })] }));
  let nodes = elements(RetentionDialog());
  expect(nodes.filter((el) => el.type === 'li').map((el) => el.key)).toEqual(['a', 'b']);
  expect(button(nodes, 'Restore b')).toBeUndefined();
  expect(JSON.stringify(nodes.filter((el) => el.props.className === 'retention-dates').map((el) => el.props.children))).not.toContain('next cleanup');
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

it('shows an overdue session as due at the next cleanup in the dialog', () => {
  update(() => ({ retention: [session('a', -1)] }));
  const dates = elements(RetentionDialog()).find((el) => el.props.className === 'retention-dates')!;
  expect(dates.props.children).toContain('Deleted at the next cleanup');
});

it('holds retention from the snapshot and retention messages', async () => {
  const { applyServer } = await import('./store');
  applyServer({ t: 'snapshot', nodes: [], retention: [session('a', 4)] });
  expect(getState().retention?.map((s) => s.rootId)).toEqual(['a']);
  applyServer({ t: 'retention', sessions: [] });
  expect(getState().retention).toEqual([]);
});
