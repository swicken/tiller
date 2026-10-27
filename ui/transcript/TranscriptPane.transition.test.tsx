import { beforeEach, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ReactElement, ReactNode } from 'react';
import { elements } from '../test-tree';
import type { Harness, Transcript } from '../../src/shared/protocol';
import { applyServer, getState, update } from '../store';
import { mk } from '../fixtures';
import { send } from '../conn';
import { FullTranscript, TranscriptView } from './TranscriptPane';

// Keep one pane's hook state and effect dependencies across renders, using the existing
// dependency-free component-test pattern. Re-mounting would conceal the reported regression.
const hooks = vi.hoisted(() => ({ slots: [] as unknown[], cursor: 0, pending: [] as Array<() => void> }));
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
  useEffect: (effect: () => void, deps: unknown[]) => {
    const i = hooks.cursor++;
    const previous = hooks.slots[i] as unknown[] | undefined;
    if (!previous || deps.some((value, index) => !Object.is(value, previous[index]))) hooks.pending.push(effect);
    hooks.slots[i] = deps;
  },
  useLayoutEffect: () => {},
}));
vi.mock('../conn', () => ({ send: vi.fn() }));
vi.mock('../store', async (original) => {
  const store = await original<typeof import('../store')>();
  return { ...store, useStore: (select: (s: ReturnType<typeof store.getState>) => unknown) => select(store.getState()) };
});

function render() {
  hooks.cursor = 0;
  const node = getState().nodes.root;
  const tree = FullTranscript({ id: node.id, harness: node.harness, currentSessionId: node.sessionId, refresh: 'running' });
  const pending = hooks.pending.splice(0);
  for (const effect of pending) effect();
  return tree;
}
function view(tree: ReactNode) {
  return elements(tree).find((el) => el.type === TranscriptView) as ReactElement<Parameters<typeof TranscriptView>[0]> | undefined;
}
function replaceCurrent(sessionId: string, harness: Harness) {
  applyServer({ t: 'node', node: { ...getState().nodes.root, kind: 'agent', harness, sessionId, changingHarness: false, status: { state: 'unknown', changedAt: 3 } } });
}
const claude: Transcript = { entries: [{ role: 'assistant', text: 'Old Claude answer' }], sessions: [{ sessionId: 'claude-session', current: true }] };
const codex: Transcript = { entries: [], sessions: [{ sessionId: 'codex-session', current: true, harness: 'codex' }, { sessionId: 'claude-session', current: false, harness: 'claude' }] };

beforeEach(() => {
  hooks.slots = []; hooks.pending = [];
  vi.clearAllMocks();
  update(() => ({ connected: true, transcript: null, nodes: { root: { ...mk('root', null, 1), harness: 'claude', sessionId: 'claude-session' } } }));
});

it('refreshes a still-mounted current pane on harness/session replacement even when refresh stays running', () => {
  render();
  expect(send).toHaveBeenLastCalledWith({ t: 'transcript', id: 'root', sessionId: 'claude-session' });
  applyServer({ t: 'transcript', id: 'root', sessionId: 'claude-session', ...claude });
  expect(view(render())?.props.data).toEqual(claude);

  applyServer({ t: 'node', node: { ...getState().nodes.root, changingHarness: true } });
  render();
  expect(send).toHaveBeenCalledTimes(1);
  replaceCurrent('codex-session', 'codex');
  const replacing = render();
  expect(view(replacing)).toBeUndefined(); // old Claude content cannot acquire the new Codex label
  expect(JSON.stringify(replacing)).toContain('Loading transcript');
  expect(send).toHaveBeenLastCalledWith({ t: 'transcript', id: 'root', sessionId: 'codex-session' });

  // Both an explicit old request and a legacy unnamed-current reply can finish late.
  applyServer({ t: 'transcript', id: 'root', sessionId: 'claude-session', ...claude });
  applyServer({ t: 'transcript', id: 'root', ...claude });
  applyServer({ t: 'transcript', id: 'root', sessionId: 'claude-session', error: 'old failure' });
  expect(view(render())).toBeUndefined();

  applyServer({ t: 'transcript', id: 'root', sessionId: 'codex-session', ...codex });
  let current = view(render())!;
  const html = renderToStaticMarkup(current);
  expect(html).toContain('Current session · codex');
  expect(html).toContain('Session claude-s · claude');
  expect(html).not.toContain('Old Claude answer');

  // The old context is now available through the explicit historical choice.
  current.props.onSession('claude-session');
  render();
  applyServer({ t: 'transcript', id: 'root', sessionId: 'claude-session', ...codex, entries: claude.entries });
  current = view(render())!;
  expect(current.props.sessionId).toBe('claude-session');
  expect(renderToStaticMarkup(current)).toContain('<span class="who">Claude</span>');
});

it('keeps an explicit historical selection across another switch and rejects its stale session metadata', () => {
  render();
  applyServer({ t: 'transcript', id: 'root', sessionId: 'claude-session', ...claude });
  view(render())!.props.onSession('earlier-claude');
  render();
  const historical: Transcript = { entries: [{ role: 'assistant', text: 'Earlier Claude answer' }], sessions: [...claude.sessions, { sessionId: 'earlier-claude', current: false }] };
  applyServer({ t: 'transcript', id: 'root', sessionId: 'earlier-claude', ...historical });
  expect(view(render())?.props.sessionId).toBe('earlier-claude');

  replaceCurrent('codex-session', 'codex');
  expect(view(render())).toBeUndefined(); // legacy metadata must not relabel the historical answer
  expect(send).toHaveBeenLastCalledWith({ t: 'transcript', id: 'root', sessionId: 'earlier-claude' });
  const updated: Transcript = { ...historical, sessions: [...codex.sessions, { sessionId: 'earlier-claude', current: false, harness: 'claude' }] };
  applyServer({ t: 'transcript', id: 'root', sessionId: 'earlier-claude', ...updated });
  const current = view(render())!;
  expect(current.props.sessionId).toBe('earlier-claude');
  expect(renderToStaticMarkup(current)).toContain('<span class="who">Claude</span>');

  // A request made before the switch must not replace the refreshed history picker later.
  applyServer({ t: 'transcript', id: 'root', sessionId: 'earlier-claude', ...historical });
  expect(view(render())?.props.data).toEqual(updated);
});
