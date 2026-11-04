import { beforeEach, expect, it, vi } from 'vitest';
import type { ReactElement } from 'react';
import { TerminalPane } from '../TerminalPane';
import { mk } from '../fixtures';

const fixture = vi.hoisted(() => ({ effects: [] as (() => unknown)[], focus: vi.fn(), reset: vi.fn(), fit: vi.fn() }));
vi.mock('react', async (original) => ({ ...await original<typeof import('react')>(), useEffect: (fn: () => unknown) => fixture.effects.push(fn), useRef: () => ({ current: null }) }));
vi.mock('../store', () => ({ useStore: (select: (s: unknown) => unknown) => select({ opened: ['leaf'], selected: 'leaf', nodes: { leaf: mk('leaf', 'root', 0) }, connected: true }) }));
vi.mock('../conn', () => ({ send: vi.fn() }));
vi.mock('../terminals', () => ({ createTerm: vi.fn(), disposeTerm: vi.fn(), getTerm: () => ({ term: { focus: fixture.focus, reset: fixture.reset, cols: 80, rows: 24 }, fit: { fit: fixture.fit } }) }));

beforeEach(() => { fixture.effects.length = 0; vi.clearAllMocks(); });

it.each([true, false])('preserves tree focus while retaining non-tree terminal autofocus: inTree=%s', (inTree) => {
  const closest = vi.fn(() => inTree ? {} : null);
  vi.stubGlobal('document', { activeElement: { closest } });
  const pane = TerminalPane();
  const view = pane.props.children[0][0] as ReactElement<{ id: string; visible: boolean; exited: boolean }>;
  (view.type as (props: typeof view.props) => ReactElement)(view.props);
  fixture.effects[1](); // The real visible-terminal attach effect.
  expect(fixture.reset).toHaveBeenCalledOnce();
  expect(fixture.fit).toHaveBeenCalledOnce();
  expect(closest).toHaveBeenCalledWith('.tree');
  expect(fixture.focus).toHaveBeenCalledTimes(inTree ? 0 : 1);
  vi.unstubAllGlobals();
});
