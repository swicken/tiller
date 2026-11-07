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

it('lists the nodes prune will remove and sends exactly those ids on Remove', () => {
  update(() => ({ nodes: { root: mk('root', null, 0), a: mk('a', 'root', 0, { exited: true }), b: mk('b', 'root', 0, { exited: true }) }, dialog: { kind: 'prune', ids: ['a', 'b'] } }));
  const tree = render();
  expect(tree.props.title).toBe('Remove 2 finished nodes?');
  expect(elements(tree).filter((el) => el.type === 'li').map((el) => el.key)).toEqual(['a', 'b']);
  expect(button(tree, 'Cancel').props.autoFocus).toBe(true);
  expect(tree.props.restoreFocus).toBe(true);
  button(tree, 'Remove').props.onClick();
  expect(send).toHaveBeenCalledExactlyOnceWith({ t: 'prune', ids: ['a', 'b'] });
  expect(getState().dialog).toBeNull();
});

it('leaves out a listed node that was resumed or became dormant while the confirmation was open', () => {
  update(() => ({ nodes: { root: mk('root', null, 0), a: mk('a', 'root', 0), b: { ...mk('b', 'root', 0, { exited: true }), dormant: true }, c: mk('c', 'root', 0, { exited: true }) }, dialog: { kind: 'prune', ids: ['a', 'b', 'c'] } }));
  const tree = render();
  expect(tree.props.title).toBe('Remove 1 finished node?');
  button(tree, 'Remove').props.onClick();
  expect(send).toHaveBeenCalledExactlyOnceWith({ t: 'prune', ids: ['c'] });
});

it('cancelling or dismissing the prune confirmation sends nothing', () => {
  update(() => ({ nodes: { root: mk('root', null, 0), a: mk('a', 'root', 0, { exited: true }) }, dialog: { kind: 'prune', ids: ['a'] } }));
  const tree = render();
  button(tree, 'Cancel').props.onClick();
  expect(getState().dialog).toBeNull();
  openDialog({ kind: 'prune', ids: ['a'] });
  render().props.onClose();
  expect(getState().dialog).toBeNull();
  expect(send).not.toHaveBeenCalled();
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

it('confirms closing a running root with force and says its children are kept', () => {
  // The daemon refuses an unforced root close, so the confirm must authorize it; a child's Kill stays unforced.
  update(() => ({ nodes: { root: mk('root', null, 0), child: mk('child', 'root', 0) }, dialog: { kind: 'kill', id: 'root' } }));
  const tree = render();
  expect(tree.props.title).toBe('Close root?');
  expect(find(tree, (el) => el.type === 'p' && el.props.children === 'Its children are kept.')).toBeDefined();
  expect(button(tree, 'Kill')).toBeUndefined();
  button(tree, 'Close').props.onClick();
  expect(send).toHaveBeenCalledExactlyOnceWith({ t: 'close', id: 'root', force: true });
  expect(getState().dialog).toBeNull();
  openDialog({ kind: 'kill', id: 'child' });
  button(render(), 'Kill').props.onClick();
  expect(send).toHaveBeenLastCalledWith({ t: 'close', id: 'child' });
});
