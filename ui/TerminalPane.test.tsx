import { afterEach, expect, it, vi } from 'vitest';
import type { ReactElement, ReactNode } from 'react';
import { TerminalPane } from './TerminalPane';
import { send } from './conn';
import { disposeTerm, getTerm } from './terminals';
import { mk } from './fixtures';

const fixture = vi.hoisted(() => ({
  effects: [] as (() => (() => void) | void)[],
  onData: vi.fn(),
  onBinary: vi.fn(),
  state: {} as Record<string, unknown>,
}));
vi.mock('react', async (original) => ({
  ...await original<typeof import('react')>(),
  useEffect: (fn: () => (() => void) | void) => fixture.effects.push(fn),
  useRef: () => ({ current: {} }),
}));
vi.mock('./store', () => ({ useStore: (select: (s: unknown) => unknown) => select(fixture.state) }));
vi.mock('./conn', () => ({ send: vi.fn() }));
vi.mock('./terminals', () => ({
  createTerm: () => ({ term: { onData: fixture.onData, onBinary: fixture.onBinary } }),
  disposeTerm: vi.fn(), getTerm: vi.fn(),
}));

afterEach(() => { fixture.effects.length = 0; vi.clearAllMocks(); vi.unstubAllGlobals(); });

type ViewProps = { id: string; visible: boolean; exited: boolean; strip?: boolean };
type Pane = ReactElement<{ children: [ReactElement<ViewProps>[], ReactElement<{ node: unknown }> | undefined, ReactElement<ViewProps> | undefined] }>;
const render = (state: Record<string, unknown>) => { fixture.state = state; return TerminalPane() as Pane; };
const run = <P,>(el: ReactElement<P>) => (el.type as (props: P) => ReactElement)(el.props);
/** Every button in a rendered element, by its text. */
const buttons = (el: ReactNode): ReactElement<{ children: string; disabled?: boolean; onClick: () => void }>[] => {
  if (!el || typeof el !== 'object' || !('props' in el)) return [];
  const e = el as ReactElement<{ children?: ReactNode }>;
  return [...(e.type === 'button' ? [e as never] : []), ...[e.props.children].flat().flatMap(buttons)];
};

it('forwards text and legacy wheel reports separately and disposes both input subscriptions', () => {
  const textSubscription = { dispose: vi.fn() };
  const binarySubscription = { dispose: vi.fn() };
  fixture.onData.mockReturnValue(textSubscription);
  fixture.onBinary.mockReturnValue(binarySubscription);
  const view = render({ opened: ['codex'], selected: 'codex', nodes: {}, connected: false }).props.children[0][0];
  run(view);
  const cleanup = fixture.effects[0]();

  expect(fixture.onBinary).toHaveBeenCalledOnce();
  fixture.onData.mock.calls[0][0]('hello 🌍');
  // X10 wheel up at column 100, row 3: the coordinate is a raw 0x84 byte.
  fixture.onBinary.mock.calls[0][0]('\x1b[M`\x84#');
  expect(send).toHaveBeenNthCalledWith(1, { t: 'input', id: 'codex', data: 'hello 🌍' });
  expect(send).toHaveBeenNthCalledWith(2, { t: 'input', id: 'codex', data: '\x1b[M`\x84#', binary: true });

  cleanup!();
  expect(textSubscription.dispose).toHaveBeenCalledOnce();
  expect(binarySubscription.dispose).toHaveBeenCalledOnce();
  expect(disposeTerm).toHaveBeenCalledExactlyOnceWith('codex');
});

it('shows the node\'s shell instead of its agent on the Terminal tab and attaches to <id>:shell, selecting the node itself', () => {
  const node = mk('a', null, 0);
  const [views, strip, shell] = render({ opened: ['a'], selected: 'a', nodes: { a: node }, connected: true, shellOpen: true }).props.children;
  expect(views[0].props.visible).toBe(false); // the agent's screen is hidden, so its view detaches
  expect(strip).toBeFalsy();
  expect(shell!.props).toMatchObject({ id: 'a:shell', visible: true, strip: false });
  const term = { reset: vi.fn(), focus: vi.fn(), cols: 80, rows: 24 };
  vi.mocked(getTerm).mockReturnValue({ term, fit: { fit: vi.fn() } } as never);
  vi.stubGlobal('document', { activeElement: null });
  run(shell!);
  fixture.effects[1]();
  // select carries the node id: a stream id there would count as nobody watching the node.
  expect(send).toHaveBeenCalledWith({ t: 'select', id: 'a' });
  expect(send).toHaveBeenCalledWith({ t: 'attach', id: 'a:shell', cols: 80, rows: 24 });
  expect(term.focus).toHaveBeenCalled();
});

it('has no shell for a terminal node, which is a shell already', () => {
  const node = { ...mk('t', null, 0), kind: 'terminal' as const };
  const [views, strip, shell] = render({ opened: ['t'], selected: 't', nodes: { t: node }, connected: true, shellOpen: true }).props.children;
  expect(views[0].props.visible).toBe(true);
  expect(strip).toBeFalsy();
  expect(shell).toBeFalsy();
});

it('offers a suggested command over the shell, with Insert disabled until the shell has printed its prompt', () => {
  const node = { ...mk('a', null, 0), suggestion: { command: 'npm test', why: 'run the suite', at: 1 } };
  let [, strip, shell] = render({ opened: ['a'], selected: 'a', nodes: { a: node }, connected: true, shellOpen: true }).props.children;
  expect(shell!.props.strip).toBe(true);
  let [insert, dismiss] = buttons(run(strip!));
  expect(insert.props).toMatchObject({ children: 'Insert', disabled: true }); // typed-ahead text could be lost while the shell starts
  dismiss.props.onClick();
  expect(send).toHaveBeenCalledWith({ t: 'suggestion', id: 'a', action: 'dismiss' });
  [, strip] = render({ opened: ['a'], selected: 'a', nodes: { a: { ...node, shellReady: true } }, connected: true, shellOpen: true }).props.children;
  [insert] = buttons(run(strip!));
  expect(insert.props.disabled).toBe(false);
  insert.props.onClick();
  // The daemon types its own validated copy; the UI never sends the command text.
  expect(send).toHaveBeenLastCalledWith({ t: 'suggestion', id: 'a', action: 'insert' });
});
