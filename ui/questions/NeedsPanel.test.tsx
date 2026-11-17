import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { mk } from '../fixtures';
import { getState, update } from '../store';
import { elements } from '../test-tree';
import { clearDraft } from './drafts';
import { mkq, NOW } from './fixtures';
import { NeedsPanel } from './NeedsPanel';
import { QuestionReminder } from './QuestionReminder';

const hooks = vi.hoisted(() => ({ states: [] as unknown[], next: 0 }));
vi.mock('react', async (original) => ({ ...await original<typeof import('react')>(),
  useState: (init: unknown) => {
    const i = hooks.next++;
    // The first value is kept, as a real component keeps its state between renders.
    if (!(i in hooks.states)) hooks.states[i] = typeof init === 'function' ? init() : init;
    return [hooks.states[i], (v: unknown) => { hooks.states[i] = v; }];
  },
  useRef: (init: unknown) => ({ current: init ?? null }), useMemo: (fn: () => unknown) => fn(), useEffect: () => {}, useLayoutEffect: () => {} }));
vi.mock('../store', async (original) => {
  const store = await original<typeof import('../store')>();
  return { ...store, useStore: (select: (state: ReturnType<typeof store.getState>) => unknown) => select(store.getState()) };
});
vi.mock('../conn', () => ({ send: vi.fn() }));
vi.mock('../hooks', () => ({ useNow: () => NOW }));

// Session "a" (a, its child a1, and a blocked child a2) and session "b".
const nodes = { a: { ...mk('a', null, 0), title: 'tiller' }, a1: mk('a1', 'a', 0), a2: mk('a2', 'a', NOW - 60_000, { state: 'blocked', activity: 'Bash: rm -rf node_modules' }), b: { ...mk('b', null, 0), title: 'dotcms-core' } };
const mainColumn = (clientWidth?: number) => vi.stubGlobal('document', { activeElement: null, body: {}, querySelector: () => (clientWidth === undefined ? null : { clientWidth }) });
const render = (el: React.ReactElement) => { hooks.next = 0; return renderToStaticMarkup(el); };
const put = (...qs: ReturnType<typeof mkq>[]) => update(() => ({ questions: Object.fromEntries(qs.map((q) => [q.id, q])) }));

beforeEach(() => {
  hooks.states.length = 0;
  mainColumn();
  update(() => ({ nodes, order: ['a', 'a1', 'a2', 'b'], session: 'a', selected: 'a', questions: {}, refusals: {}, connected: true, needs: { open: false } }));
  for (const id of ['own', 'older', 'far']) clearDraft(id);
});
afterEach(() => vi.unstubAllGlobals());

it('draws no reminder when the session on screen has no open question, though another session has one', () => {
  put(mkq('far', 'b', 5));
  expect(render(<QuestionReminder />)).toBe('');
  expect(render(<QuestionReminder bar />)).toBe('');
});

it('reminds of the selected node\'s own question before an older one from another node in the session', () => {
  put(mkq('older', 'a1', 40, { question: 'Older question?' }), mkq('own', 'a', 3, { question: 'Own question?', askedBy: { id: 'a', title: 'tiller' } }));
  const out = render(<QuestionReminder />);
  expect(out).toContain('Own question?');
  expect(out).not.toContain('Older question?');
  expect(out).toContain('+1 more');
  expect(out).toContain('aria-label="Answer tiller’s question: Own question? 1 more in this session"'); // one mark after the question, not two
  put(mkq('own', 'a', 3, { question: 'Own question', askedBy: { id: 'a', title: 'tiller' } }), mkq('older', 'a1', 40, { question: 'Older question?' }));
  expect(render(<QuestionReminder />)).toContain('aria-label="Answer tiller’s question: Own question. 1 more in this session"');
  // The bar form is the same button with another class; a node with no question of its own shows the oldest.
  expect(render(<QuestionReminder bar />)).toContain('q-remind q-bar');
  update(() => ({ selected: 'a1' }));
  expect(render(<QuestionReminder />)).toContain('Older question?');
});

it('names the agent that asked, not the one the question moved to', () => {
  put(mkq('own', 'a', 3, { question: 'Keep it?', askedBy: { id: 'a1x', title: 'closed child' } })); // asked by a closed child; its parent "tiller" owns it now
  const out = render(<QuestionReminder />);
  expect(out).toContain('closed child asks');
  expect(out).toContain('title="closed child asks: Keep it?"');
  expect(out).toContain('aria-label="Answer closed child’s question: Keep it?"');
  expect(out).not.toContain('tiller asks');
});

it('shows a question that carries on quietly, with its dot hollow', () => {
  put(mkq('own', 'a', 3, { assumption: 'keeping the alias' }));
  const out = render(<QuestionReminder />);
  expect(out).toContain('q-remind carrying');
  expect(out).toContain('· carrying on');
  expect(out).toContain('qring');
});

it('opens the panel on the reminded question when activated, and closes it when it is already open on that question', () => {
  put(mkq('older', 'a1', 40, { question: 'Older question?' }), mkq('own', 'a', 3, { question: 'Own question?' }));
  const activate = () => { hooks.next = 0; elements(QuestionReminder({})).find((el) => el.type === 'button')!.props.onClick(); };
  activate();
  expect(getState().needs).toEqual({ open: true, focusId: 'own' });
  const out = render(<NeedsPanel />);
  // The reminded question is the open card; the older one is a row.
  expect(out).toMatch(/<article[^>]*aria-labelledby="own-h"/);
  expect(out).not.toMatch(/<article[^>]*aria-labelledby="older-h"/);
  expect(out).toMatch(/<button class="qrow"[^>]*>(?:(?!<\/button>).)*Older question\?/);
  activate();
  expect(getState().needs.open).toBe(false);
  expect(render(<NeedsPanel />)).toBe('');
});

it('opens the first question by sort order when nothing named one', () => {
  put(mkq('older', 'a1', 40), mkq('own', 'a', 3));
  update(() => ({ needs: { open: true } }));
  expect(render(<NeedsPanel />)).toMatch(/<article[^>]*aria-labelledby="older-h"/);
});

it('groups by session with the one on screen first, and lists an approval inside its session\'s group', () => {
  put(mkq('far', 'b', 5, { question: 'Far question?' }), mkq('own', 'a', 3, { question: 'Own question?' }));
  update(() => ({ needs: { open: true, focusId: 'own' } }));
  const out = render(<NeedsPanel />);
  const at = (s: string) => out.indexOf(s);
  expect(at('<b>tiller</b><span>· this session</span>')).toBeGreaterThan(-1);
  expect(at('<b>tiller</b>')).toBeLessThan(at('Own question?'));
  expect(at('Own question?')).toBeLessThan(at('<b>a2</b> needs your approval'));
  expect(at('<b>a2</b> needs your approval')).toBeLessThan(at('<b>dotcms-core</b>'));
  expect(at('<b>dotcms-core</b>')).toBeLessThan(at('Far question?'));
  expect(out).toContain('3 waiting');
  expect(out).toContain('Bash: rm -rf node_modules');
});

it('lists a group oldest first however the store holds it, and the first by that order is the open card', () => {
  put(mkq('own', 'a', 3, { question: 'Newest?' }), mkq('older', 'a', 55, { question: 'Oldest?' }), mkq('far', 'a', 9, { question: 'Middle?' }), mkq('c', 'a', 80, { question: 'Carrying?', assumption: 'x' }));
  update(() => ({ needs: { open: true } }));
  const out = render(<NeedsPanel />);
  const at = (s: string) => out.indexOf(s);
  expect(at('Oldest?')).toBeLessThan(at('Middle?'));
  expect(at('Middle?')).toBeLessThan(at('Newest?'));
  expect(at('Newest?')).toBeLessThan(at('needs your approval'));
  expect(at('needs your approval')).toBeLessThan(at('Carrying?'));
  expect(out).toMatch(/<article[^>]*aria-labelledby="older-h"/);
});

it('does not open a question that arrives while the panel is open, so it cannot take the keys from the terminal', () => {
  update(() => ({ nodes: { a: nodes.a }, order: ['a'], needs: { open: true } }));
  expect(render(<NeedsPanel />)).toContain('Nothing needs you right now');
  put(mkq('own', 'a', 0, { question: 'Fresh question?' }));
  const out = render(<NeedsPanel />); // the same panel, still open: its state is kept
  expect(out).not.toContain('<article');
  expect(out).toMatch(/<button class="qrow"[^>]*>(?:(?!<\/button>).)*Fresh question\?/);
  // Opened from somewhere that names a question, a card opens as before.
  update(() => ({ needs: { open: true, focusId: 'own' } }));
  expect(render(<NeedsPanel />)).toMatch(/<article[^>]*aria-labelledby="own-h"/);
});

it('words an approval row as the design does: no "ago", and the activity without its "needs approval:" lead', () => {
  update((s) => ({ nodes: { ...s.nodes, a2: mk('a2', 'a', NOW - 60_000, { state: 'blocked', activity: 'needs approval: Bash: npm ci' }) }, needs: { open: true } }));
  const out = render(<NeedsPanel />);
  expect(out).toContain('<b>a2</b> needs your approval · 1 min</span>');
  expect(out).toContain('<span class="qrow-sub">Bash: npm ci</span>');
});

it('shows a new question\'s row age as "now", not "0m"', () => {
  put(mkq('own', 'a', 3), mkq('fresh', 'a', 0));
  update(() => ({ needs: { open: true, focusId: 'own' } }));
  expect(render(<NeedsPanel />)).toContain('>now</time>');
});

it('says nothing needs you when nothing is waiting', () => {
  update(() => ({ nodes: { a: nodes.a }, order: ['a'], needs: { open: true } }));
  const out = render(<NeedsPanel />);
  expect(out).toContain('Nothing needs you right now');
  expect(out).toContain('Nothing waiting');
});

// (A question that was open while the panel stays in its group is covered in model.test.ts; the ref that pins it is reset by this file's mock.)
it('lists an answer the agent has not received under "Not delivered" when the panel opens', () => {
  put({ ...mkq('own', 'a', 3), state: 'answered', resolvedAt: NOW, answer: { choice: 'x', at: NOW }, delivery: { state: 'queued' } });
  update(() => ({ needs: { open: true } }));
  const out = render(<NeedsPanel />);
  expect(out).toContain('<b>Not delivered</b> (1)');
  expect(out).toContain('Waiting until tiller is free.');
  expect(out).not.toContain('Done in the last day');
});

it('is a full-window modal dialog when the main column is narrow, and an anchored panel otherwise', () => {
  put(mkq('own', 'a', 3));
  update(() => ({ needs: { open: true, focusId: 'own' } }));
  mainColumn(400);
  hooks.states.length = 0;
  const narrow = render(<NeedsPanel />);
  expect(narrow.startsWith('<dialog')).toBe(true);
  expect(narrow).toContain('qpanel qpanel-modal');
  expect(narrow).toContain('id="qpanel"');
  mainColumn(900);
  hooks.states.length = 0;
  const wide = render(<NeedsPanel />);
  expect(wide.startsWith('<section')).toBe(true);
  expect(wide).toContain('role="dialog"');
  expect(wide).not.toContain('<dialog');
});
