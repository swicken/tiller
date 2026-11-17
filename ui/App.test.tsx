import { expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { App } from './App';
import { mk } from './fixtures';
import { getState, showPane, update } from './store';

// Effects do not run in a server render; collect them so a test can run the one that installs the key handler.
const effects = vi.hoisted(() => [] as (() => unknown)[]);
vi.mock('react', async (original) => ({ ...await original<typeof import('react')>(), useEffect: (fn: () => unknown) => { effects.push(fn); } }));
vi.mock('./conn', () => ({ send: vi.fn() }));
vi.mock('./hooks', () => ({ useNow: () => 10_000, useDocumentSync: () => {} }));
vi.mock('./TerminalPane', () => ({ TerminalPane: () => null }));
vi.mock('./StatusBar', () => ({ StatusBar: () => null }));
vi.mock('./sidebar/Sidebar', () => ({ Sidebar: () => null, useRows: () => [] }));
vi.mock('./SessionTabs', () => ({ SessionTabs: () => null, moveSession: vi.fn(), nthSession: vi.fn(), stepSession: vi.fn() }));
vi.mock('./store', async (importOriginal) => {
  const store = await importOriginal<typeof import('./store')>();
  return { ...store, useStore: (select: (state: ReturnType<typeof store.getState>) => unknown) => select(store.getState()) };
});

it('keeps the agent\'s exited card off its shell: the Terminal tab works whatever the agent is doing', () => {
  const node = mk('a', null, 0, { state: 'done', exited: true });
  update(() => ({ nodes: { a: node }, order: ['a'], sessionOrder: ['a'], selected: 'a', opened: ['a'] }));
  showPane('agent');
  expect(renderToStaticMarkup(<App />)).toContain('exited-overlay');
  showPane('shell');
  expect(renderToStaticMarkup(<App />)).not.toContain('exited-overlay');
});

const ask = { id: 'q-1', rootId: 'a', nodeId: 'a', askedBy: { id: 'a', title: 'a' }, question: 'Keep the alias?', state: 'open' as const, askedAt: 0 };
const withQuestion = () => update(() => ({ nodes: { a: mk('a', null, 0) }, order: ['a'], sessionOrder: ['a'], selected: 'a', session: 'a', opened: ['a'], questions: { [ask.id]: ask }, needs: { open: false } }));
const count = (html: string, s: string) => html.split(s).length - 1;

it('draws the reminder in the pane-tab row and as a bar over the stage, and the panel inside the stage', () => {
  withQuestion();
  showPane('agent');
  const html = renderToStaticMarkup(<App />);
  expect(count(html, 'class="q-remind"')).toBe(1);
  expect(count(html, 'q-remind q-bar')).toBe(1);
  expect(html.indexOf('class="q-remind"')).toBeLessThan(html.indexOf('panel-toggle'));
  expect(html.indexOf('class="stage"')).toBeLessThan(html.indexOf('q-remind q-bar'));
  expect(html).not.toContain('id="qpanel"');
  update(() => ({ needs: { open: true, focusId: ask.id } }));
  vi.stubGlobal('document', { activeElement: null, body: {}, querySelector: () => null }); // the panel reads the main column's width
  const open = renderToStaticMarkup(<App />);
  vi.unstubAllGlobals();
  expect(open.indexOf('class="stage"')).toBeLessThan(open.indexOf('id="qpanel"'));
  expect(open.indexOf('id="qpanel"')).toBeLessThan(open.indexOf('</main>'));
});

it('leaves the bar out while the Terminal tab\'s suggestion strip owns the top of the stage', () => {
  withQuestion();
  update((s) => ({ nodes: { a: { ...s.nodes.a, suggestion: { command: 'git push', at: 0 } } } }));
  showPane('shell');
  const html = renderToStaticMarkup(<App />);
  expect(html).not.toContain('q-bar');
  expect(count(html, 'class="q-remind"')).toBe(1); // the row form still reminds
  showPane('agent');
  expect(renderToStaticMarkup(<App />)).toContain('q-bar');
});

it('toggles the Needs you panel with Cmd+J', () => {
  withQuestion();
  let onKey: (e: Record<string, unknown>) => void = () => {};
  vi.stubGlobal('addEventListener', (type: string, f: typeof onKey) => { if (type === 'keydown') onKey = f; });
  renderToStaticMarkup(<App />);
  effects.filter((fn) => String(fn).includes('keydown')).at(-1)!();
  vi.unstubAllGlobals();
  const press = (key: string, extra = {}) => { const preventDefault = vi.fn(); onKey({ metaKey: true, key, code: `Key${key.toUpperCase()}`, preventDefault, ...extra }); return preventDefault; };
  expect(press('j')).toHaveBeenCalled();
  expect(getState().needs.open).toBe(true);
  press('j');
  expect(getState().needs.open).toBe(false);
  expect(press('j', { shiftKey: true })).not.toHaveBeenCalled(); // other chords stay with their owners
  expect(getState().needs.open).toBe(false);
});
