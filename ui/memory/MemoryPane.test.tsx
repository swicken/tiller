import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { isValidElement, type ReactNode } from 'react';
import type { ClientMessage, MemoryItemView, MemoryPage, MemoryTarget } from '../../src/shared/protocol';
import { send } from '../conn';
import { Markdown } from '../controls/Markdown';
import { applyServer, getState, update } from '../store';
import { MemoryPane } from './MemoryPane';
import { elements, type Element } from '../test-tree';

// The pane's real handlers and effects, without a DOM: a small renderer calls each function component with hook state kept
// per position in the tree, and runs effects whose dependencies changed, as React would.
const hooks = vi.hoisted(() => ({ key: '', cursor: 0, slots: new Map<string, unknown>(), deps: new Map<string, unknown[]>(), cleanups: new Map<string, () => void>(), pending: [] as (() => void)[] }));
vi.mock('react', async (original) => {
  const react = await original<typeof import('react')>();
  const slot = () => `${hooks.key}#${hooks.cursor++}`;
  return {
    ...react,
    useState: (init: unknown) => {
      const k = slot();
      if (!hooks.slots.has(k)) hooks.slots.set(k, typeof init === 'function' ? init() : init);
      return [hooks.slots.get(k), (next: unknown) => hooks.slots.set(k, typeof next === 'function' ? next(hooks.slots.get(k)) : next)];
    },
    useEffect: (effect: () => (() => void) | void, deps: unknown[]) => {
      const k = slot(), prev = hooks.deps.get(k);
      if (prev && deps.every((d, i) => Object.is(d, prev[i]))) return;
      hooks.deps.set(k, deps);
      hooks.pending.push(() => { hooks.cleanups.get(k)?.(); const c = effect(); if (c) hooks.cleanups.set(k, c); });
    },
  };
});
vi.mock('../store', async (original) => {
  const store = await original<typeof import('../store')>();
  return { ...store, useStore: (select: (s: ReturnType<typeof store.getState>) => unknown) => select(store.getState()) };
});
vi.mock('../conn', () => ({ send: vi.fn() }));
vi.mock('../hooks', () => ({ useNow: () => 100_000 }));

function expand(node: ReactNode, path: string): ReactNode {
  if (Array.isArray(node)) return node.map((n, i) => expand(n, `${path}.${i}`));
  if (!isValidElement(node)) return node;
  const el = node as Element;
  if (typeof el.type === 'function' && el.type !== Markdown) {
    const key = `${path}/${el.type.name}:${el.key ?? ''}`;
    const saved = [hooks.key, hooks.cursor] as const;
    [hooks.key, hooks.cursor] = [key, 0];
    const out = (el.type as (p: unknown) => ReactNode)(el.props);
    [hooks.key, hooks.cursor] = saved;
    return expand(out, key);
  }
  return { ...el, props: { ...el.props, children: expand(el.props.children, `${path}.${String(el.type)}`) } } as Element;
}
const text = (node: ReactNode): string => Array.isArray(node) ? node.map(text).join('') : isValidElement(node) ? text((node as Element).props.children) : typeof node === 'string' || typeof node === 'number' ? String(node) : '';

let props: { target: MemoryTarget; onClose?: () => void };
let tree: ReactNode;
/** Render, then run effects and re-render until nothing changes, as after a state update. */
function render() {
  for (let i = 0; i < 10; i++) {
    tree = expand(<MemoryPane {...props} />, 'root');
    if (!hooks.pending.length) return;
    hooks.pending.splice(0).forEach((run) => run());
  }
  throw Error('effects did not settle');
}
const all = () => elements(tree);
const find = (match: (el: Element) => boolean) => { const el = all().find(match); if (!el) throw Error('missing element'); return el; };
const button = (label: string | RegExp, within: (el: Element) => boolean = () => true) => {
  const el = all().filter(within).flatMap((e) => elements(e)).find((e) => e.type === 'button' && (typeof label === 'string' ? text(e.props.children) === label : label.test(text(e.props.children))));
  if (!el) throw Error(`missing button ${label}`);
  return el;
};
const detail = (e: Element) => e.type === 'aside';
const click = (label: string | RegExp, within?: (el: Element) => boolean) => { button(label, within).props.onClick(); render(); };
const byLabel = (label: string) => find((e) => e.props['aria-label'] === label);
const change = (label: string, value: string) => { byLabel(label).props.onChange({ target: { value } }); render(); };
const submit = (form: Element) => { form.props.onSubmit({ preventDefault() {} }); render(); };
const sent = () => vi.mocked(send).mock.calls.map(([m]) => m);
const last = <T extends ClientMessage['t']>(t: T) => sent().filter((m): m is Extract<ClientMessage, { t: T }> => m.t === t).at(-1)!;
const lines = () => all().filter((e) => typeof e.props.className === 'string' && e.props.className.startsWith('memory-line')).map((e) => text(e.props.children));
const rows = () => all().filter((e) => e.props.className?.startsWith?.('memory-row'));

const view = (id: number, x: Partial<MemoryItemView> = {}): MemoryItemView =>
  ({ id, kind: 'procedure', text: `item ${id}`, author: 'agent', nodeId: 'n1', seen: 1, pinned: false, createdAt: 0, updatedAt: 1000 - id, eligible: true, ...x });
const counts = { ledger: 1, open_question: 0, procedure: 50, pitfall: 2, note: 3, pinned: 1, retracted: 4 };
const pageOf = (x: Partial<MemoryPage> = {}): MemoryPage => ({
  target: { account: 'personal', repo: 'git:r', nodeId: 'n1' }, file: '_default', state: 'ok', quarantined: [],
  files: [{ account: null, file: '_default', state: 'ok' }, { account: 'work', file: 'work', state: 'ok' }],
  repos: [{ key: 'git:r', path: '/r', items: 56 }, { key: 'git:s', path: '/s', items: 2 }],
  checkout: { path: '/r', from: 'node' }, on: true, source: 'memory.projects /r', cli: { repo: '/r', account: 'personal' },
  counts, items: Array.from({ length: 50 }, (_, i) => view(i + 1)), ...x,
});
/** Answer the latest memory request with `page`. */
const answer = (page: MemoryPage = pageOf()) => { applyServer({ t: 'memory', rid: last('memory').rid, ...page }); render(); };
const answerItem = (item: MemoryItemView) => { applyServer({ t: 'memoryItem', rid: last('memoryItem').rid, item, givenTo: [] }); render(); };

beforeEach(() => {
  vi.mocked(send).mockClear();
  hooks.slots.clear(); hooks.deps.clear(); hooks.cleanups.clear(); hooks.pending.length = 0;
  update(() => ({ connected: true, nodes: {}, memory: null, memoryItem: null, memoryGiven: null, claudeMemory: null, memoryRev: 0, removals: 0, toasts: [] }));
  props = { target: { nodeId: 'n1' } };
  render();
});
afterEach(() => { vi.useRealTimers(); });

describe('items', () => {
  it('asks on open for the target and renders 50 rows', () => {
    expect(sent()).toEqual([{ t: 'memory', rid: expect.any(Number), target: { nodeId: 'n1' } }]);
    answer();
    expect(rows()).toHaveLength(50);
    expect(text(button(/^Procedures/).props.children)).toBe('Procedures 50');
    expect(text(button(/^All/).props.children)).toBe('All 56');
  });

  it('sends the kind chosen by a chip, and none for All', () => {
    answer();
    click(/^Procedures/);
    expect(last('memory')).toMatchObject({ target: { nodeId: 'n1' }, kind: 'procedure' });
    click(/^Pinned/);
    expect(last('memory').kind).toBe('pinned');
    click(/^All/);
    expect(last('memory')).not.toHaveProperty('kind');
  });

  it('debounces search: three keystrokes send one request', () => {
    vi.useFakeTimers();
    answer();
    const before = sent().length;
    for (const q of ['v', 'vi', 'vit']) { change('Search memory', q); vi.advanceTimersByTime(100); }
    expect(sent()).toHaveLength(before);
    vi.advanceTimersByTime(250); render();
    expect(sent().slice(before)).toEqual([expect.objectContaining({ t: 'memory', query: 'vit' })]);
    answer(pageOf({ items: [] }));
    expect(all().some((e) => /Common words like 'the' or 'src' are ignored/.test(text(e.props.children)))).toBe(true);
  });

  it('Load more sends the cursor and appends the next page', () => {
    answer(pageOf({ next: { updatedAt: 950, id: 50 } }));
    click('Load more');
    expect(last('memory')).toMatchObject({ before: { updatedAt: 950, id: 50 } });
    answer(pageOf({ items: [view(51), view(52)] }));
    expect(rows()).toHaveLength(52);
  });

  it('shows nothing answered before it opened, such as another target\'s page', () => {
    answer();
    props = { target: { nodeId: 'n2' } };
    hooks.slots.clear(); hooks.deps.clear();
    tree = expand(<MemoryPane {...props} />, 'root'); // the first paint, before its own request
    expect(rows()).toHaveLength(0);
    render();
    expect(rows()).toHaveLength(0);
    answer();
    expect(rows()).toHaveLength(50);
  });

  it('drops a stale page: only the latest request is shown', () => {
    const first = last('memory').rid;
    click(/^Pitfalls/);
    applyServer({ t: 'memory', rid: first, ...pageOf() });
    render();
    expect(rows()).toHaveLength(0);
    answer(pageOf({ items: [view(1, { kind: 'pitfall' })] }));
    expect(rows()).toHaveLength(1);
  });

  it('the account and repository pickers and "Use a directory…" send a new target', () => {
    answer();
    // personal has no Claude home of its own, so it shares the _default file: one entry, named for it.
    expect(elements(byLabel('Account')).filter((e) => e.type === 'option').map((e) => [e.props.value, text(e.props.children)]))
      .toEqual([['_default', 'personal (_default file)'], ['work', 'work']]);
    expect(byLabel('Account').props.value).toBe('_default');
    change('Account', 'work');
    expect(last('memory').target).toEqual({ nodeId: 'n1', account: 'work', repo: undefined });
    answer(pageOf({ target: { account: 'work', repo: 'git:r', nodeId: 'n1' } }));
    change('Repository', 'git:s');
    expect(last('memory').target).toEqual({ nodeId: 'n1', account: 'work', repo: 'git:s' });
    change('Account', '_default');
    expect(last('memory').target).toMatchObject({ account: null });
    change('Use a directory', ' /Users/me/clone ');
    submit(find((e) => e.type === 'form' && elements(e).includes(byLabel('Use a directory'))));
    expect(last('memory').target).toEqual({ nodeId: 'n1', account: null, dir: '/Users/me/clone', repo: undefined });
    expect(byLabel('Use a directory').props.maxLength).toBe(4096);
    expect(byLabel('Search memory').props.maxLength).toBe(500);
  });

  it('an error keeps the page and its pickers, so a bad directory can be corrected or cleared', () => {
    answer();
    change('Use a directory', 'relative/dir');
    submit(find((e) => e.type === 'form' && elements(e).includes(byLabel('Use a directory'))));
    applyServer({ t: 'memory', rid: last('memory').rid, error: 'dir must be the absolute path of a directory: relative/dir' });
    render();
    expect(lines()).toContain('dir must be the absolute path of a directory: relative/dir');
    expect(rows()).toHaveLength(50);
    change('Use a directory', '/Users/me/clone');
    submit(find((e) => e.type === 'form' && elements(e).includes(byLabel('Use a directory'))));
    expect(last('memory').target).toEqual({ nodeId: 'n1', dir: '/Users/me/clone', repo: undefined });
    change('Use a directory', '');
    expect(button('Clear').props.disabled).toBe(false);
    submit(find((e) => e.type === 'form' && elements(e).includes(byLabel('Use a directory'))));
    expect(last('memory').target).toEqual({ nodeId: 'n1', dir: undefined, repo: undefined });
  });

  it('keeps the typed pin when the daemon refuses it, and clears it once accepted', () => {
    answer();
    change('Pin an instruction', 'Run the gate first.');
    const pinForm = () => find((e) => e.props.className === 'memory-pin');
    submit(pinForm());
    applyServer({ t: 'memoryAction', rid: last('memoryAction').rid, error: 'already pinned as m3' }); render();
    expect(byLabel('Pin an instruction').props.value).toBe('Run the gate first.');
    submit(pinForm());
    applyServer({ t: 'memoryAction', rid: last('memoryAction').rid, item: view(60, { author: 'human', kind: 'note', pinned: true }) }); render();
    expect(byLabel('Pin an instruction').props.value).toBe('');
  });

  it('keeps an item from a later page open when a refetch returns the first page', () => {
    answer(pageOf({ next: { updatedAt: 950, id: 50 } }));
    click('Load more');
    answer(pageOf({ items: [view(51), view(52)] }));
    rows()[51].props.onClick(); render();
    answerItem(view(52));
    applyServer({ t: 'memoryAction', rid: 998, item: view(1) }); render();
    answer();
    expect(rows()).toHaveLength(50);
    expect(last('memoryItem').itemId).toBe(52);
    answerItem(view(52));
    expect(find((e) => e.type === 'aside').props['aria-label']).toBe('Item m52');
  });

  it('shows the checkout and state lines for on, off and unknown, and disables actions unless on', () => {
    answer();
    expect(lines()).toEqual(['Checkout: /r (from this node)', 'Memory is on for this checkout (memory.projects /r). Changes apply to nodes launched from now on; running nodes keep the digest they were given.']);
    expect(byLabel('Pin an instruction').props.disabled).toBe(false);
    answer(pageOf({ on: false, source: 'memory.enabled (global): off (default)', checkout: { path: '/s', from: 'chosen' } }));
    expect(lines()[0]).toBe('Checkout: /s (chosen)');
    expect(lines()[1]).toMatch(/^Memory is off for this checkout \(memory.enabled \(global\): off \(default\)\). Change it in Settings → Memory\./);
    expect(byLabel('Pin an instruction').props.disabled).toBe(true);
    expect(all().some((e) => e.props.className === 'memory-blocked' && /Changes need memory on/.test(text(e.props.children)))).toBe(true);
    answer(pageOf({ on: null, source: 'no checkout of this repository is known', checkout: undefined, cli: undefined }));
    expect(lines()[0]).toBe('No checkout of this repository is known: choose its directory.');
    expect(lines()[1]).toMatch(/^Memory on or off is unknown/);
    expect(byLabel('Pin an instruction').props.disabled).toBe(true);
  });

  it('shows a broken file\'s state and its quarantined copies with empty lists', () => {
    answer(pageOf({ state: 'broken: file is not a database', quarantined: ['personal.db.broken-1'], repos: [], items: [], counts: { ...counts, procedure: 0 } }));
    expect(lines()).toContain('File _default: broken: file is not a database');
    expect(lines()).toContain('Quarantined copies: personal.db.broken-1');
    expect(rows()).toHaveLength(0);
  });

  it('pins new text through memoryAction with the page\'s target', () => {
    answer();
    change('Pin an instruction', 'Run the gate first.');
    submit(find((e) => e.props.className === 'memory-pin'));
    expect(last('memoryAction')).toEqual({ t: 'memoryAction', rid: expect.any(Number), target: pageOf().target, action: { kind: 'pinText', text: 'Run the gate first.' } });
  });

  it('refetches the page and the open item after an action reply, and on reconnect', () => {
    answer();
    rows()[0].props.onClick(); render();
    const asked = sent().length;
    applyServer({ t: 'memoryAction', rid: 999, item: view(1) });
    render();
    expect(sent().slice(asked).map((m) => m.t).sort()).toEqual(['memory', 'memoryItem']);
    update(() => ({ connected: false })); render();
    const offline = sent().length;
    update(() => ({ connected: true })); render();
    expect(sent().slice(offline).map((m) => m.t).sort()).toEqual(['memory', 'memoryItem']);
  });
});

describe('item detail', () => {
  const open = (item: MemoryItemView, page = pageOf({ items: [item] })) => {
    answer(page);
    rows()[0].props.onClick(); render();
    expect(last('memoryItem')).toMatchObject({ itemId: item.id, target: { nodeId: 'n1' } });
    answerItem(item);
  };

  it('asks before pinning an agent\'s item, then pins it', () => {
    open(view(3));
    click('Pin', detail);
    expect(sent().some((m) => m.t === 'memoryAction')).toBe(false);
    expect(all().some((e) => /an instruction every node in this repository follows/.test(text(e.props.children)))).toBe(true);
    click('Pin', detail);
    expect(last('memoryAction').action).toEqual({ kind: 'pin', itemId: 3 });
  });

  it('pins the human\'s own item without asking', () => {
    open(view(3, { author: 'human', kind: 'note', textPin: true, pinned: false, invalid: { at: 1, kind: 'human', by: 'human', reason: 'unpinned' } }));
    click('Pin', detail);
    expect(last('memoryAction').action).toEqual({ kind: 'pin', itemId: 3 });
  });

  it('forget needs a reason, prefilled', () => {
    open(view(4));
    click('Forget…');
    const reason = () => find((e) => e.type === 'input' && e.props.required);
    expect(reason().props.value).toBe('wrong or stale');
    reason().props.onChange({ target: { value: '  ' } }); render();
    expect(button('Forget').props.disabled).toBe(true);
    submit(find((e) => e.type === 'form' && e.props.className === 'memory-confirm'));
    expect(sent().some((m) => m.t === 'memoryAction')).toBe(false);
    reason().props.onChange({ target: { value: 'it is wrong' } }); render();
    submit(find((e) => e.type === 'form' && e.props.className === 'memory-confirm'));
    expect(last('memoryAction').action).toEqual({ kind: 'forget', itemId: 4, reason: 'it is wrong' });
  });

  it('edits a human text pin', () => {
    open(view(5, { author: 'human', kind: 'note', pinned: true, textPin: true }));
    expect(all().filter((e) => e.type === 'button').map((e) => text(e.props.children))).toEqual(expect.arrayContaining(['Unpin', 'Edit…', 'Forget…']));
    click('Edit…');
    find((e) => e.type === 'textarea').props.onChange({ target: { value: 'new text' } }); render();
    submit(find((e) => e.type === 'form' && e.props.className === 'memory-confirm'));
    expect(last('memoryAction').action).toEqual({ kind: 'editPin', itemId: 5, text: 'new text' });
  });

  it('offers no actions for a tombstone, and disables them while memory is off', () => {
    open(view(6, { text: '', tombstone: 'purged', invalid: { at: 1, kind: 'human', by: 'human' } }));
    expect(all().find((e) => e.props.className === 'memory-actions')?.props.children).toEqual([]);
    open(view(7), pageOf({ items: [view(7)], on: false, source: 'off' }));
    expect(button('Pin', detail).props.disabled).toBe(true);
    expect(button('Forget…', detail).props.disabled).toBe(true);
  });
});

describe('sections', () => {
  it('Given lists the node\'s digests, and an item id opens that item', () => {
    answer();
    click('Given to this node');
    expect(last('memoryGiven')).toEqual({ t: 'memoryGiven', rid: expect.any(Number), nodeId: 'n1' });
    applyServer({ t: 'memoryGiven', rid: last('memoryGiven').rid, injections: [{ sessionId: 's', arm: 'on', cause: 'config', itemIds: [3], text: '# Memory', ts: 0 }] });
    render();
    click('m3');
    expect(last('memoryItem')).toMatchObject({ itemId: 3, target: { nodeId: 'n1' } });
  });

  it('a digest item opens in the node\'s own file and repository, even after the pickers chose another', () => {
    answer();
    change('Account', 'work');
    click('Given to this node');
    applyServer({ t: 'memoryGiven', rid: last('memoryGiven').rid, injections: [{ sessionId: 's', arm: 'on', cause: 'config', itemIds: [3], text: '# Memory', ts: 0 }] });
    render();
    click('m3');
    expect(last('memoryItem').target).toEqual({ nodeId: 'n1' });
    expect(last('memory').target).toEqual({ nodeId: 'n1' });
  });

  it('Given works for a closed node, and is hidden without a node', () => {
    props = { target: { nodeId: 'closed-1' } };
    hooks.slots.clear(); hooks.deps.clear(); render();
    click('Given to this node');
    expect(last('memoryGiven').nodeId).toBe('closed-1');
    props = { target: {} };
    hooks.slots.clear(); hooks.deps.clear(); render();
    expect(all().filter((e) => e.props.role === 'radio').map((e) => text(e.props.children))).toEqual(['Items', 'Claude Code memory']);
  });

  it('Claude Code memory asks for the target and shows its error', () => {
    click('Claude Code memory');
    expect(last('claudeMemory')).toEqual({ t: 'claudeMemory', rid: expect.any(Number), target: { nodeId: 'n1' } });
    applyServer({ t: 'claudeMemory', rid: last('claudeMemory').rid, error: 'choose the repository\'s directory' });
    render();
    expect(all().some((e) => text(e.props.children) === 'choose the repository\'s directory')).toBe(true);
  });

  it('Close closes the stage view', () => {
    const onClose = vi.fn();
    props = { target: {}, onClose };
    hooks.slots.clear(); hooks.deps.clear(); render();
    byLabel('Close memory').props.onClick();
    expect(onClose).toHaveBeenCalledOnce();
    expect(getState().memoryRev).toBe(0);
  });
});
