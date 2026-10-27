import { beforeEach, expect, it, vi } from 'vitest';
import { elements } from '../test-tree';
import { Modal } from './Modal';

// Exercise the real component handlers without adding a DOM dependency.
// Native focus trapping, CSS resize, and autofocus are checked separately in a browser.
const hooks = vi.hoisted(() => ({ slots: [] as unknown[], cursor: 0, effects: [] as (() => void)[] }));
vi.mock('react', async (original) => ({
  ...await original<typeof import('react')>(),
  useRef: (initial: unknown) => {
    const i = hooks.cursor++;
    return hooks.slots[i] ??= { current: initial };
  },
  useState: (initial: unknown) => {
    const i = hooks.cursor++;
    if (!(i in hooks.slots)) hooks.slots[i] = initial;
    return [hooks.slots[i], (next: unknown) => { hooks.slots[i] = typeof next === 'function' ? next(hooks.slots[i]) : next; }];
  },
  useLayoutEffect: (effect: () => void) => { if (!hooks.effects.length) hooks.effects.push(effect); },
}));
function render(props: Partial<Parameters<typeof Modal>[0]> = {}) {
  hooks.cursor = 0;
  return Modal({ title: 'Notes', children: <input autoFocus />, ...props });
}
beforeEach(() => { hooks.slots = []; hooks.effects = []; vi.stubGlobal('document', { activeElement: null }); });

it('opens before mounting autofocus children and footer, preserving custom boxes', () => {
  const props = { className: 'palette', footer: <button autoFocus>Close</button> };
  let tree = render(props);
  expect(elements(tree).some((el) => el.type === 'input' || el.type === 'button')).toBe(false);
  expect(elements(tree).some((el) => el.props.className === 'palette')).toBe(true);
  const dialog = { showModal: vi.fn() };
  tree.props.ref.current = dialog;
  hooks.effects[0]();
  expect(dialog.showModal).toHaveBeenCalledOnce();
  tree = render(props);
  expect(elements(tree).filter((el) => el.props.autoFocus)).toHaveLength(2);
  expect(elements(tree).some((el) => el.props.className === 'modal-resizable')).toBe(false);
});

it('offers expand and restore only for resizable dialogs and separates body from actions', () => {
  expect(elements(render()).some((el) => el.type === 'button')).toBe(false);
  const props = { resizable: true, footer: <button>Close</button> };
  let tree = render(props);
  tree.props.ref.current = { showModal() {} };
  hooks.effects[0]();
  tree = render(props);
  const button = () => elements(tree).find((el) => el.props.className === 'btn modal-expand')!;
  expect(button().props['aria-pressed']).toBe(false);
  expect(button().props.children).toBe('Expand dialog');
  button().props.onClick(); tree = render(props);
  expect(button().props['aria-pressed']).toBe(true);
  expect(button().props.children).toBe('Restore size');
  expect(elements(tree).some((el) => el.props.className === 'modal modal-resizable modal-expanded')).toBe(true);
  const body = elements(tree).find((el) => el.props.className === 'modal-body')!;
  expect(body.props.tabIndex).toBe(0);
  expect(elements(body).some((el) => el.type === 'input')).toBe(true);
  expect(elements(body).some((el) => el.type === 'button')).toBe(false);
  expect(elements(tree).some((el) => el.props.className === 'modal-footer')).toBe(true);
  button().props.onClick(); tree = render(props);
  expect(button().props['aria-pressed']).toBe(false);
});

it('keeps Escape, backdrop, and native-close dismissal semantics', () => {
  const onClose = vi.fn();
  const tree = render({ onClose });
  const preventDefault = vi.fn();
  tree.props.onCancel({ preventDefault });
  expect(preventDefault).toHaveBeenCalledOnce();
  expect(onClose).toHaveBeenCalledTimes(1);
  const target = {};
  tree.props.onMouseDown({ target: {}, currentTarget: target });
  expect(onClose).toHaveBeenCalledTimes(1);
  tree.props.onMouseDown({ target, currentTarget: target });
  tree.props.onClose({});
  expect(onClose).toHaveBeenCalledTimes(3);
});

it('never dismisses an unanswered approval and reopens only while connected', () => {
  const tree = render({ resizable: true, label: 'Approve command', title: undefined });
  expect(tree.props['aria-label']).toBe('Approve command');
  const preventDefault = vi.fn();
  tree.props.onCancel({ preventDefault });
  expect(preventDefault).toHaveBeenCalledOnce();
  const dialog = { isConnected: true, showModal: vi.fn() };
  tree.props.onMouseDown({ target: dialog, currentTarget: dialog });
  tree.props.onClose({ currentTarget: dialog });
  expect(dialog.showModal).toHaveBeenCalledOnce();
  dialog.isConnected = false;
  tree.props.onClose({ currentTarget: dialog });
  expect(dialog.showModal).toHaveBeenCalledOnce();
});


it('reopens native close when a draft guard rejects dismissal', () => {
  const onClose = vi.fn(() => false);
  const tree = render({ onClose });
  const dialog = { isConnected: true, showModal: vi.fn() };
  tree.props.onClose({ currentTarget: dialog });
  expect(onClose).toHaveBeenCalledOnce();
  expect(dialog.showModal).toHaveBeenCalledOnce();
  dialog.isConnected = false;
  tree.props.onClose({ currentTarget: dialog });
  expect(dialog.showModal).toHaveBeenCalledOnce();
});

it('restores focus to the connected opener when unmounted', async () => {
  const opener = { isConnected: true, focus: vi.fn() };
  vi.stubGlobal('document', { activeElement: opener });
  render({ restoreFocus: true });
  const cleanup = hooks.effects[0]() as unknown as () => void;
  cleanup();
  await Promise.resolve();
  expect(opener.focus).toHaveBeenCalledOnce();
});


it('leaves intentional navigation focus alone unless restoration is requested', async () => {
  const opener = { isConnected: true, focus: vi.fn() };
  vi.stubGlobal('document', { activeElement: opener });
  render({ className: 'palette', onClose: vi.fn() });
  const cleanup = hooks.effects[0]() as unknown as () => void;
  cleanup();
  await Promise.resolve();
  expect(opener.focus).not.toHaveBeenCalled();
});

it('lets dismissible dialogs reach global shortcuts while protecting mandatory and opted-in dialogs', () => {
  expect(render({ className: 'palette', onClose: vi.fn() }).props.onKeyDown).toBeUndefined();
  const stopPropagation = vi.fn();
  render().props.onKeyDown({ stopPropagation });
  render({ onClose: vi.fn(), blockGlobalShortcuts: true }).props.onKeyDown({ stopPropagation });
  expect(stopPropagation).toHaveBeenCalledTimes(2);
});
