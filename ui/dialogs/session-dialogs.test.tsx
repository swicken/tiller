import { beforeEach, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import { elements, type Element } from '../test-tree';
import { Dialogs } from './Dialogs';
import { getState, openDialog, update } from '../store';
import { mk } from '../fixtures';
import { send } from '../conn';

const hooks = vi.hoisted(() => ({ title: undefined as string | undefined }));
vi.mock('react', async (original) => ({
  ...await original<typeof import('react')>(),
  useState: (initial: string) => [hooks.title ?? initial, (value: string) => { hooks.title = value; }],
}));
vi.mock('../conn', () => ({ send: vi.fn() }));
vi.mock('../store', async (original) => {
  const store = await original<typeof import('../store')>();
  return { ...store, useStore: (select: (s: ReturnType<typeof store.getState>) => unknown) => select(store.getState()) };
});
function render(): Element {
  const dialog = Dialogs() as Element;
  return (dialog.type as (props: object) => Element)(dialog.props);
}
const find = (tree: ReactNode, predicate: (el: Element) => boolean) => elements(tree).find(predicate)!;
const button = (tree: ReactNode, text: string) => find(tree, (el) => el.type === 'button' && el.props.children === text);
const submit = (tree: ReactNode) => find(tree, (el) => el.type === 'form').props.onSubmit({ preventDefault() {} });

beforeEach(() => {
  hooks.title = undefined;
  vi.clearAllMocks();
  update(() => ({ nodes: { root: mk('root', null, 0, { exited: true }) }, dialog: { kind: 'restart', id: 'root' } }));
});

it('closes an exited root from Restart without restarting it', () => {
  openDialog({ kind: 'restart', id: 'root' });
  const tree = render();
  expect(button(tree, 'Close').props.type).toBe('button');
  button(tree, 'Close').props.onClick();
  expect(send).toHaveBeenCalledExactlyOnceWith({ t: 'close', id: 'root', force: true });
  expect(getState().dialog).toBeNull();
});

it('keeps Close out of a running root restart dialog and preserves Restart', () => {
  update(() => ({ nodes: { root: mk('root', null, 0) }, dialog: { kind: 'restart', id: 'root' } }));
  const tree = render();
  expect(button(tree, 'Close')).toBeUndefined();
  submit(tree);
  expect(send).toHaveBeenCalledExactlyOnceWith({ t: 'restart', id: 'root' });
});

it('closes an exited child without forcing the operation', () => {
  update(() => ({ nodes: { child: mk('child', 'root', 0, { exited: true }) }, dialog: { kind: 'restart', id: 'child' } }));
  button(render(), 'Close').props.onClick();
  expect(send).toHaveBeenCalledExactlyOnceWith({ t: 'close', id: 'child' });
});

it.each(['Close', 'Keep branch', 'Discard'])('retains worktree protection and root authorization for %s', (choice) => {
  update((s) => ({ nodes: { root: { ...s.nodes.root, worktree: { repo: '/repo', path: '/repo/wt', branch: 'tl/root', base: 'main', baseSha: 'abc' } } }, dialog: { kind: 'restart', id: 'root' } }));
  button(render(), 'Close').props.onClick();
  expect(send).not.toHaveBeenCalled();
  expect(getState().dialog).toEqual({ kind: 'kill', id: 'root' });
  button(render(), choice).props.onClick();
  expect(send).toHaveBeenCalledExactlyOnceWith({ t: 'close', id: 'root', force: true,
    ...(choice === 'Close' ? {} : { worktree: choice === 'Discard' ? 'discard' : 'keep' }),
  });
});
