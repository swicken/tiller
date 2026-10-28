import { beforeEach, expect, it, vi } from 'vitest';
import { elements, type Element } from './test-tree';
import { App } from './App';
import { SessionTabs } from './SessionTabs';
import { ActionMenu, actionsFor } from './controls/ActionButtons';
import { RenameInput } from './controls/RenameInput';
import { sessions } from './sidebar/sessions';
import { getState, update } from './store';
import { send } from './conn';
import { mk } from './fixtures';

// useState keeps each call's value by its position in a render, so a test can set state and render again.
const hooks = vi.hoisted(() => ({ effects: [] as (() => unknown)[], states: [] as unknown[], next: 0 }));
vi.mock('react', async (original) => ({ ...await original<typeof import('react')>(), useState: (init: unknown) => {
  const i = hooks.next++;
  return [i in hooks.states ? hooks.states[i] : init, (v: unknown) => { hooks.states[i] = v; }];
}, useRef: () => ({ current: null }), useMemo: (fn: () => unknown) => fn(), useEffect: (fn: () => unknown) => hooks.effects.push(fn) }));
vi.mock('./store', async (original) => {
  const store = await original<typeof import('./store')>();
  return { ...store, useStore: (select: (state: ReturnType<typeof store.getState>) => unknown) => select(store.getState()) };
});
vi.mock('./conn', () => ({ send: vi.fn() }));
vi.mock('./TerminalPane', () => ({ TerminalPane: () => null }));
vi.mock('./hooks', () => ({ useNow: () => 10_000, useDocumentSync: () => {} }));

const a = mk('a', null, 1);
const child = mk('child', 'a', 2, { state: 'blocked' });
const b = mk('b', null, 3, { exited: true });
const c = mk('c', null, 4);
const render = () => { hooks.next = 0; return elements(SessionTabs()); };
const tabs = () => render().filter((el) => /^stab( on)?$/.test(el.props.className));
const main = (tab: Element) => elements(tab).find((el) => el.props.className === 'stab-main')!;
const close = (tab: Element) => elements(tab).find((el) => el.props.className === 'stab-close')!;

beforeEach(() => {
  vi.clearAllMocks(); hooks.effects.length = 0; hooks.states.length = 0;
  update(() => ({ nodes: { a, child, b, c }, order: ['c', 'a', 'child', 'b'], sessionOrder: [], selected: 'child', session: 'a', collapsed: [], opened: [], dialog: null, archived: null, renaming: null }));
});

it('shows one tab per session in switcher order, marking only the current session', () => {
  const list = tabs();
  expect(list.map((t) => t.key)).toEqual(['c', 'a', 'b']);
  expect(list.map((t) => t.key)).toEqual(sessions(getState().nodes, getState().order).map((s) => s.root.id));
  expect(list.map((t) => main(t).props['aria-current'])).toEqual([false, true, false]);
  // The dot carries the session's most urgent status, as in the switcher: a's blocked child makes it 'needs'.
  expect(elements(main(list[1])).find((el) => el.props.kind)?.props.kind).toBe('needs');
});

it('selects a session root with one click', () => {
  main(tabs()[0]).props.onClick();
  expect(getState()).toMatchObject({ session: 'c', selected: 'c' });
});

it('closes through the same actions the menus use: a live root asks first, an exited root closes directly', () => {
  const [live, , exited] = tabs();
  expect(close(live).props['aria-label']).toBe('Close session c');
  close(live).props.onClick();
  expect(getState().dialog).toEqual({ kind: 'kill', id: 'c' });
  expect(send).not.toHaveBeenCalled();
  close(exited).props.onClick();
  expect(send).toHaveBeenCalledWith({ t: 'close', id: 'b', force: true });
});

it('opens the New session dialog from + in the current session directory', () => {
  render().find((el) => el.props.className === 'stab-new')!.props.onClick();
  expect(getState().dialog).toEqual({ kind: 'spawn', parentId: null, cwd: a.cwd });
});

function shortcuts() {
  let shortcut: (event: Record<string, unknown>) => void = () => {};
  vi.stubGlobal('addEventListener', (type: string, handler: typeof shortcut) => { if (type === 'keydown') shortcut = handler; });
  hooks.next = 0; App(); hooks.effects.find((fn) => String(fn).includes('keydown'))!();
  vi.unstubAllGlobals();
  return shortcut;
}

it('steps through session tabs with Cmd+Shift+[ and ], wrapping at either end, and jumps with Cmd+Shift+1..9', () => {
  const shortcut = shortcuts();
  const press = (code: string) => shortcut({ metaKey: true, shiftKey: true, key: code === 'BracketLeft' ? '{' : '}', code, preventDefault: vi.fn() });
  press('BracketRight'); expect(getState().session).toBe('b');
  press('BracketRight'); expect(getState().session).toBe('c');
  press('BracketLeft'); expect(getState().session).toBe('b');
  // Cmd+Shift+N jumps to the Nth tab, matched by code since Shift+2 reports key '@'; a missing tab is left unhandled.
  const digit = (n: number) => { const preventDefault = vi.fn(); shortcut({ metaKey: true, shiftKey: true, key: '!@#$'[n - 1] ?? '%', code: `Digit${n}`, preventDefault }); return preventDefault; };
  expect(digit(2)).toHaveBeenCalled(); expect(getState().session).toBe('a');
  expect(digit(1)).toHaveBeenCalled(); expect(getState().session).toBe('c');
  expect(digit(4)).not.toHaveBeenCalled(); expect(getState().session).toBe('c');
  // Cmd+Shift+9 is the last tab, however many there are.
  expect(digit(9)).toHaveBeenCalled(); expect(getState().session).toBe('b');
  // Shift with other keys stays unhandled so the terminal still gets them.
  const preventDefault = vi.fn();
  shortcut({ metaKey: true, shiftKey: true, key: 'K', code: 'KeyK', preventDefault });
  expect(preventDefault).not.toHaveBeenCalled();
  expect(getState().dialog).toBeNull();
});

it('moves the current tab with Cmd+Shift+Opt+[ and ], saving the order in the daemon, and stops at either end', () => {
  const shortcut = shortcuts();
  const press = (code: string, altKey = true) => { const preventDefault = vi.fn(); shortcut({ metaKey: true, shiftKey: true, altKey, key: '‘', code, preventDefault }); return preventDefault; };
  expect(press('BracketRight')).toHaveBeenCalled();
  expect(tabs().map((t) => t.key)).toEqual(['c', 'b', 'a']);
  expect(send).toHaveBeenLastCalledWith({ t: 'sessionOrder', ids: ['c', 'b', 'a'] });
  press('BracketRight'); // already last
  expect(send).toHaveBeenCalledOnce();
  press('BracketLeft'); press('BracketLeft'); press('BracketLeft');
  expect(tabs().map((t) => t.key)).toEqual(['a', 'c', 'b']);
  expect(send).toHaveBeenCalledTimes(3);
  expect(getState().session).toBe('a'); // moving never changes the selection
});

it('middle-click closes like the x: a live root asks first, an exited one closes; other buttons do nothing', () => {
  const [live, , exited] = tabs();
  live.props.onAuxClick({ button: 2 });
  expect(getState().dialog).toBeNull();
  live.props.onAuxClick({ button: 1 });
  expect(getState().dialog).toEqual({ kind: 'kill', id: 'c' });
  expect(send).not.toHaveBeenCalled();
  exited.props.onAuxClick({ button: 1 });
  expect(send).toHaveBeenCalledWith({ t: 'close', id: 'b', force: true });
});

it('right-click opens the root\'s action menu at the tab, whose Rename edits the tab in place', () => {
  const rect = { top: 5, bottom: 38, right: 200 };
  const preventDefault = vi.fn();
  tabs()[0].props.onContextMenu({ preventDefault, currentTarget: { getBoundingClientRect: () => rect } });
  expect(preventDefault).toHaveBeenCalled();
  const menu = render().find((el) => el.type === ActionMenu)!;
  expect(menu.props).toMatchObject({ label: 'Actions for c', at: rect });
  expect(menu.props.actions.map((x: { key: string }) => x.key)).toEqual(actionsFor(c).map((x) => x.key));
  menu.props.actions.find((x: { key: string }) => x.key === 'close').run();
  expect(getState().dialog).toEqual({ kind: 'kill', id: 'c' });
  menu.props.actions.find((x: { key: string }) => x.key === 'rename').run();
  expect(getState().renaming).toEqual({ id: 'c', at: 'tab' });
  menu.props.onClose();
  expect(render().some((el) => el.type === ActionMenu)).toBe(false);
});

it('double-click renames the tab inline, and the tab being edited cannot be dragged', () => {
  main(tabs()[1]).props.onDoubleClick();
  expect(getState().renaming).toEqual({ id: 'a', at: 'tab' });
  const [first, edited] = tabs();
  expect(elements(edited).find((el) => el.type === RenameInput)?.props).toEqual({ id: 'a', title: 'a' });
  expect(main(edited).type).toBe('span');
  expect(edited.props.onPointerDown).toBeUndefined();
  expect(first.props.onPointerDown).toBeTypeOf('function');
});

it('a vertical mouse wheel scrolls the strip sideways; a sideways trackpad swipe is left alone', () => {
  const strip = render().find((el) => el.props.role === 'group')!;
  const target = { scrollLeft: 0 };
  strip.props.onWheel({ deltaY: 40, deltaX: 0, deltaMode: 0, currentTarget: target });
  expect(target.scrollLeft).toBe(40);
  strip.props.onWheel({ deltaY: 2, deltaX: 30, deltaMode: 0, currentTarget: target });
  expect(target.scrollLeft).toBe(40);
});
