import { beforeEach, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import { elements, type Element } from '../test-tree';
import { Dialogs } from './Dialogs';
import { getState, update } from '../store';
import { mk } from '../fixtures';
import { send } from '../conn';

// Exercise the real form handlers with the repository's dependency-free component-test pattern.
const hooks = vi.hoisted(() => ({ slots: [] as unknown[], cursor: 0 }));
vi.mock('react', async (original) => ({
  ...await original<typeof import('react')>(),
  useState: (initial: unknown) => {
    const i = hooks.cursor++;
    if (!(i in hooks.slots)) hooks.slots[i] = initial;
    return [hooks.slots[i], (value: unknown) => { hooks.slots[i] = value; }];
  },
  useRef: (initial: unknown) => {
    const i = hooks.cursor++;
    return hooks.slots[i] ??= { current: initial };
  },
}));
vi.mock('../conn', () => ({ send: vi.fn() }));
vi.mock('../store', async (original) => {
  const store = await original<typeof import('../store')>();
  return { ...store, useStore: (select: (s: ReturnType<typeof store.getState>) => unknown) => select(store.getState()) };
});
function render(): Element | null {
  hooks.cursor = 0;
  const dialog = Dialogs() as Element;
  return (dialog.type as (props: object) => Element)(dialog.props);
}
const find = (tree: ReactNode, predicate: (el: Element) => boolean) => elements(tree).find(predicate)!;
beforeEach(() => {
  hooks.slots = [];
  vi.clearAllMocks();
  update(() => ({ connected: true, nodes: { root: mk('root', null, 0) }, dialog: { kind: 'changeHarness', id: 'root' } }));
});

it('makes the reset explicit, starts on the current harness, and focuses Cancel with native modal keyboard support', () => {
  const tree = render()!;
  expect(tree.props.title).toBe('Change harness for root?');
  expect(tree.props.restoreFocus).toBe(true);
  expect(tree.props.blockGlobalShortcuts).toBe(true);
  expect(JSON.stringify(tree)).toContain('fresh context');
  expect(JSON.stringify(tree)).toContain('Earlier transcripts stay readable');
  expect(JSON.stringify(tree)).toContain('permission overrides are cleared');
  const select = find(tree, (el) => el.props['aria-describedby'] === 'harness-defaults');
  expect(select.props.value).toBe('claude');
  expect(elements(select).filter((el) => el.type === 'option').map((el) => el.props.value)).toEqual(['claude', 'pi', 'codex']);
  expect(find(tree, (el) => el.props.type === 'submit').props.disabled).toBe(true);
  expect(find(tree, (el) => el.props.autoFocus).props.children).toBe('Cancel');
  tree.props.onClose();
  expect(getState().dialog).toBeNull();
  expect(send).not.toHaveBeenCalled();
});

it('submits the selected harness and optional prompt once, only after explicit confirmation', () => {
  let tree = render()!;
  find(tree, (el) => el.props['aria-describedby'] === 'harness-defaults').props.onChange({ target: { value: 'codex' } });
  find(tree, (el) => el.type === 'textarea').props.onChange({ target: { value: 'Read handoff first' } });
  tree = render()!;
  expect(find(tree, (el) => el.props.type === 'submit').props.disabled).toBe(false);
  const event = { preventDefault: vi.fn() };
  const form = find(tree, (el) => el.type === 'form');
  form.props.onSubmit(event); form.props.onSubmit(event);
  expect(event.preventDefault).toHaveBeenCalledTimes(2);
  expect(send).toHaveBeenCalledExactlyOnceWith({ t: 'changeHarness', id: 'root', harness: 'codex', prompt: 'Read handoff first' });
  expect(getState().dialog).toBeNull();
});

it('Cancel never sends a mutation, even after choosing a different harness', () => {
  let tree = render()!;
  find(tree, (el) => el.props['aria-describedby'] === 'harness-defaults').props.onChange({ target: { value: 'pi' } });
  tree = render()!;
  find(tree, (el) => el.props.children === 'Cancel').props.onClick();
  expect(send).not.toHaveBeenCalled();
  expect(getState().dialog).toBeNull();
});

it.each(['offline', 'changing', 'gate', 'pending', 'same'] as const)('blocks unsafe submission while %s', (condition) => {
  let tree = render()!;
  if (condition !== 'same') find(tree, (el) => el.props['aria-describedby'] === 'harness-defaults').props.onChange({ target: { value: 'pi' } });
  update((s) => ({ connected: condition !== 'offline', nodes: { root: { ...s.nodes.root,
    changingHarness: condition === 'changing', gate: condition === 'gate' ? 'running' : undefined,
    pending: condition === 'pending' ? { kind: 'queued', after: [], afterSuccess: [], satisfied: [] } as never : undefined } } }));
  tree = render()!;
  expect(find(tree, (el) => el.props.type === 'submit').props.disabled).toBe(true);
  find(tree, (el) => el.type === 'form').props.onSubmit({ preventDefault() {} });
  expect(send).not.toHaveBeenCalled();
});

it('excludes terminal nodes even when given a stale dialog request', () => {
  update((s) => ({ nodes: { root: { ...s.nodes.root, kind: 'terminal' } } }));
  expect(render()).toBeNull();
});
