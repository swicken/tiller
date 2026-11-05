import { expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { App } from './App';
import { mk } from './fixtures';
import { showPane, update } from './store';

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
