import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ReactElement } from 'react';
import { mk } from '../fixtures';
import { inspectorBounds, inspectorHeight, readInspectorHeight, SidebarInspector } from './SidebarInspector';

const hooks = vi.hoisted(() => ({ updates: [] as unknown[], effects: [] as (() => (() => void) | undefined)[] }));
vi.mock('react', async (original) => ({
  ...await original<typeof import('react')>(),
  useState: (initial: unknown) => [typeof initial === 'function' ? initial() : initial, (value: unknown) => hooks.updates.push(value)],
  useRef: (current: unknown) => ({ current }),
  useLayoutEffect: (effect: () => (() => void) | undefined) => hooks.effects.push(effect),
}));

let stored: Map<string, string>;
beforeEach(() => {
  hooks.updates.length = 0;
  hooks.effects.length = 0;
  stored = new Map();
  vi.stubGlobal('localStorage', { getItem: (key: string) => stored.get(key) ?? null, setItem: (key: string, value: string) => stored.set(key, value) });
});
afterEach(() => vi.unstubAllGlobals());

const html = (node: Parameters<typeof SidebarInspector>[0]['node']) => renderToStaticMarkup(<SidebarInspector node={node} onClose={() => {}} />);

it('shows an empty selection and a named keyboard separator with bounded aria values', () => {
  const output = html(null);
  expect(output).toContain('id="sidebar-inspector"');
  expect(output).toContain('Select a node in this session');
  expect(output).toContain('role="separator" tabindex="0"');
  expect(output).toContain('aria-orientation="horizontal"');
  expect(output).toContain('aria-valuemin="160" aria-valuemax="480" aria-valuenow="300"');
  expect(output).toContain('aria-label="Close details"');
});

it('keeps live attention, outcome and gate independent and reports telemetry only when present', () => {
  const node = { ...mk('worker', 'root', 0, { state: 'blocked', activity: 'needs approval: Bash', interrupted: true }),
    unread: true, harness: 'codex' as const, role: 'worker' as const, profile: 'reviewer' as const,
    model: 'gpt-test', effort: 'high' as const, gate: 'running' as const,
    outcome: { outcome: 'succeeded' as const, summary: 'Earlier report', at: 0 },
  };
  const output = html(node);
  expect(output).toContain('needs you');
  expect(output).toContain('Unread message · Interrupted');
  expect(output).toContain('needs approval: Bash');
  for (const value of ['codex', 'worker', 'Reviewer', 'gpt-test', 'high', 'succeeded', 'running', 'Earlier report', 'Not reported']) expect(output).toContain(value);
  expect(output).not.toContain('Checks passed');
  expect(output).not.toContain('Pause');
  expect(output).not.toContain('class="ctx');
});

it('shows measured context, branch changes and a missing worktree without inventing commands', () => {
  const output = html({ ...mk('node', null, 0, { contextPct: 42, contextTokens: 42000, contextWindow: 100000,
    git: { branch: 'tl/a', base: 'main', ahead: 2, behind: 1, dirty: 3, additions: 42, deletions: 18 } }),
    worktree: { branch: 'tl/a', base: 'main', baseSha: 'abc', path: '/missing', repo: '/r', missing: true } });
  for (const value of ['42%', '42k / 100k tokens', 'tl/a', '2 ahead · 1 behind main', '3 uncommitted files', '+42', '−18', 'Missing — resume unavailable', 'No activity reported.']) expect(output).toContain(value);
});

it('describes a failed reported task as Needs changes while the agent is still working', () => {
  const output = html({ ...mk('worker', 'root', 0, { state: 'working' }), gate: 'running',
    outcome: { outcome: 'failed', summary: 'Unresolved review issue', at: 0 } });
  for (const text of ['<dt>Reported outcome</dt><dd><span title="Reported task outcome">Needs changes</span>', '>working<', '<dt>Completion gate</dt><dd>running</dd>', 'Unresolved review issue']) expect(output).toContain(text);
  expect(output).not.toContain('Turn errored');
  expect(output).not.toContain('>failed<');
});

it.each(['errored', 'exited'] as const)('preserves %s runtime status and failed gate beside a successful report', (state) => {
  const output = html({ ...mk('worker', 'root', 0, { state: 'done', errored: state === 'errored', exited: state === 'exited' }),
    gate: 'failed', outcome: { outcome: 'succeeded', at: 0 } });
  for (const text of [`>${state}<`, '<dt>Completion gate</dt><dd>failed</dd>', '<dt>Reported outcome</dt><dd><span title="Reported task outcome">succeeded</span>']) expect(output).toContain(text);
  expect(output).not.toContain('Needs changes');
  if (state === 'errored') expect(output).toContain('Turn errored');
});

it('does not attach an agent role or model to a plain terminal', () => {
  const output = html({ ...mk('shell', null, 0, { state: 'none' }), kind: 'terminal' });
  expect(output).toContain('terminal');
  expect(output).not.toContain('<dt>Role</dt>');
  expect(output).not.toContain('<dt>Model</dt>');
});

describe('panel size', () => {
  it('preserves a useful tree area and clamps short or exhausted containers', () => {
    expect(inspectorBounds(700)).toEqual({ min: 160, max: 560 });
    expect(inspectorHeight(500, 400)).toBe(280);
    expect(inspectorHeight(500, 200)).toBe(110);
    expect(inspectorHeight(500, 0)).toBe(0);
    expect(inspectorHeight(500, -10)).toBe(0);
    expect(inspectorHeight(500, 700)).toBe(500);
  });

  it.each(['', 'NaN', 'Infinity', '-1', '159', '561'])('ignores invalid stored height %j', (value) => {
    stored.set('tl.sidebarInspectorHeight', value);
    expect(readInspectorHeight()).toBe(300);
  });

  it('survives unavailable storage', () => {
    vi.stubGlobal('localStorage', { getItem: () => { throw new Error('denied'); } });
    expect(readInspectorHeight()).toBe(300);
  });
});

// Exercise actual separator handlers without introducing a DOM test dependency.
function surface() {
  const onClose = vi.fn();
  const root = SidebarInspector({ node: null, onClose });
  const children = root.props.children as ReactElement<any>[];
  const separator = children[0].props;
  const captured = new Set<number>();
  const element = { focus: vi.fn(), setPointerCapture: (id: number) => captured.add(id),
    hasPointerCapture: (id: number) => captured.has(id), releasePointerCapture: (id: number) => captured.delete(id) };
  separator.ref.current = element;
  return { root, separator, element, captured, onClose, children };
}
const key = (key: string, shiftKey = false) => ({ key, shiftKey, preventDefault: vi.fn(), stopPropagation: vi.fn() });
const pointer = (id: number, y: number, element: unknown) => ({ pointerId: id, clientY: y, button: 0, currentTarget: element, preventDefault: vi.fn() });

it('resizes by keyboard and persists only deliberate size changes; close invokes its callback', () => {
  const { separator, children, onClose } = surface();
  separator.onKeyDown(key('ArrowUp'));
  expect(stored.get('tl.sidebarInspectorHeight')).toBe('316');
  separator.onKeyDown(key('ArrowDown', true));
  expect(stored.get('tl.sidebarInspectorHeight')).toBe('260');
  separator.onKeyDown(key('Home'));
  expect(stored.get('tl.sidebarInspectorHeight')).toBe('160');
  separator.onKeyDown(key('End'));
  expect(stored.get('tl.sidebarInspectorHeight')).toBe('480');
  const header = children[1].props.children[0];
  header.props.children[1].props.onClick();
  expect(onClose).toHaveBeenCalledOnce();
});

it('captures drag input, ignores other pointers, saves on release and restores preference on cancel', () => {
  const { separator, element, captured } = surface();
  separator.onPointerDown(pointer(1, 200, element));
  expect(captured.has(1)).toBe(true);
  separator.onPointerMove(pointer(2, 100, element));
  expect(hooks.updates).toEqual([true]);
  separator.onPointerMove(pointer(1, 100, element));
  expect(hooks.updates).toContain(400);
  expect(stored.size).toBe(0);
  separator.onPointerUp(pointer(1, 100, element));
  expect(stored.get('tl.sidebarInspectorHeight')).toBe('400');
  expect(captured.size).toBe(0);
  separator.onPointerDown(pointer(3, 200, element));
  separator.onPointerMove(pointer(3, 250, element));
  separator.onPointerCancel(pointer(3, 250, element));
  expect(hooks.updates.at(-2)).toBe(400);
  expect(stored.get('tl.sidebarInspectorHeight')).toBe('400');
});

it('observes the session body and viewport without overwriting the preferred height', () => {
  stored.set('tl.sidebarInspectorHeight', '500');
  const { root } = surface();
  let measured: () => void = () => {};
  const observe = vi.fn(), disconnect = vi.fn(), removeEventListener = vi.fn();
  vi.stubGlobal('ResizeObserver', class { constructor(fn: () => void) { measured = fn; } observe = observe; disconnect = disconnect; });
  const viewport = { innerHeight: 600, addEventListener: vi.fn(), removeEventListener };
  vi.stubGlobal('window', viewport);
  const parent = { clientHeight: 700, getBoundingClientRect: () => ({ top: 100 }) };
  root.props.ref.current = { closest: () => parent };
  const cleanup = hooks.effects[0]();
  expect(observe).toHaveBeenCalledWith(parent);
  expect(hooks.updates.at(-1)).toBe(500);
  // The drawer shares the entire session body with the tree.
  expect(500 - inspectorHeight(500, 500)).toBe(120);
  viewport.innerHeight = 250;
  measured();
  expect(hooks.updates.at(-1)).toBe(150);
  expect(stored.get('tl.sidebarInspectorHeight')).toBe('500');
  cleanup?.();
  expect(disconnect).toHaveBeenCalledOnce();
  expect(removeEventListener).toHaveBeenCalledWith('resize', expect.any(Function));
});

it('shows the Claude account only when the node has one', () => {
  expect(html({ ...mk('a', null, 0), account: 'work' })).toContain('<dt>Account</dt><dd>work</dd>');
  expect(html(mk('a', null, 0))).not.toContain('<dt>Account</dt>');
  expect(html({ ...mk('shell', null, 0, { state: 'none' }), kind: 'terminal', account: 'work' })).not.toContain('<dt>Account</dt>');
});

it('warns when the daemon reports the repository now uses another account, including from the default home', () => {
  expect(html({ ...mk('a', null, 0), account: 'work', repoAccount: 'other' }))
    .toContain('<dd><span class="warn">Runs in work; this repository now uses other. Start a new session to switch.</span></dd>');
  expect(html({ ...mk('a', null, 0), repoAccount: 'work' })).toContain('Runs in default; this repository now uses work.');
});
