import { beforeEach, expect, it, vi } from 'vitest';
import { elements, type Element } from './test-tree';
import { App } from './App';
import { SessionTabs } from './SessionTabs';
import { sessions } from './sidebar/sessions';
import { getState, update } from './store';
import { send } from './conn';
import { mk } from './fixtures';

const hooks = vi.hoisted(() => ({ effects: [] as (() => unknown)[] }));
vi.mock('react', async (original) => ({ ...await original<typeof import('react')>(), useState: () => [false, vi.fn()], useRef: () => ({ current: null }), useMemo: (fn: () => unknown) => fn(), useEffect: (fn: () => unknown) => hooks.effects.push(fn) }));
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
const tabs = () => elements(SessionTabs()).filter((el) => /^stab( on)?$/.test(el.props.className));
const main = (tab: Element) => elements(tab).find((el) => el.props.className === 'stab-main')!;
const close = (tab: Element) => elements(tab).find((el) => el.props.className === 'stab-close')!;

beforeEach(() => {
  vi.clearAllMocks(); hooks.effects.length = 0;
  update(() => ({ nodes: { a, child, b, c }, order: ['c', 'a', 'child', 'b'], selected: 'child', session: 'a', collapsed: [], opened: [], dialog: null, archived: null, renaming: null }));
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
  elements(SessionTabs()).find((el) => el.props.className === 'stab-new')!.props.onClick();
  expect(getState().dialog).toEqual({ kind: 'spawn', parentId: null, cwd: a.cwd });
});

it('steps through session tabs with Cmd+Shift+[ and ], wrapping at either end', () => {
  let shortcut: (event: Record<string, unknown>) => void = () => {};
  vi.stubGlobal('addEventListener', (type: string, handler: typeof shortcut) => { if (type === 'keydown') shortcut = handler; });
  App(); hooks.effects.find((fn) => String(fn).includes('keydown'))!();
  const press = (code: string) => shortcut({ metaKey: true, shiftKey: true, key: code === 'BracketLeft' ? '{' : '}', code, preventDefault: vi.fn() });
  press('BracketRight'); expect(getState().session).toBe('b');
  press('BracketRight'); expect(getState().session).toBe('c');
  press('BracketLeft'); expect(getState().session).toBe('b');
  // Shift with other keys stays unhandled so the terminal still gets them.
  const preventDefault = vi.fn();
  shortcut({ metaKey: true, shiftKey: true, key: 'K', code: 'KeyK', preventDefault });
  expect(preventDefault).not.toHaveBeenCalled();
  expect(getState().dialog).toBeNull();
  vi.unstubAllGlobals();
});
