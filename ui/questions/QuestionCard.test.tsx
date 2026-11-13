import { beforeEach, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { Question } from '../../src/shared/protocol';
import { send } from '../conn';
import { mk } from '../fixtures';
import { getState, update } from '../store';
import { elements } from '../test-tree';
import { clearDraft, getDraft, setDraft, settleSent } from './drafts';
import { mkq, NOW } from './fixtures';
import { QuestionCard } from './QuestionCard';

// useState keeps each call's value by its position in a render, so a test can set state and render again.
const hooks = vi.hoisted(() => ({ states: [] as unknown[], next: 0 }));
vi.mock('react', async (original) => ({ ...await original<typeof import('react')>(),
  useState: (init: unknown) => {
    const i = hooks.next++;
    return [i in hooks.states ? hooks.states[i] : typeof init === 'function' ? init() : init, (v: unknown) => { hooks.states[i] = v; }];
  },
  useRef: (init: unknown) => ({ current: init ?? null }), useEffect: () => {}, useLayoutEffect: () => {} }));
vi.mock('../store', async (original) => {
  const store = await original<typeof import('../store')>();
  return { ...store, useStore: (select: (state: ReturnType<typeof store.getState>) => unknown) => select(store.getState()) };
});
vi.mock('../conn', () => ({ send: vi.fn() }));
vi.mock('../hooks', () => ({ useNow: () => NOW }));

const root = { ...mk('root', null, 0), title: 'tiller' };
const worker = mk('worker', 'root', 0);
const go = vi.fn();
const put = (...qs: Question[]) => update(() => ({ questions: Object.fromEntries(qs.map((q) => [q.id, q])) }));
const props = (q: Question) => ({ q: getState().questions[q.id] ?? q, focus: false, go });
const tree = (q: Question) => { hooks.next = 0; return elements(QuestionCard(props(q))); };
const html = (q: Question) => { hooks.next = 0; return renderToStaticMarkup(<QuestionCard {...props(q)} />); };
/** The visible words of a card: tags dropped, entities decoded. */
const plain = (q: Question) => html(q).replace(/<[^>]*>/g, '').replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&amp;/g, '&');
const textOf = (n: ReactNode): string => Array.isArray(n) ? n.map(textOf).join('') : typeof n === 'string' || typeof n === 'number' ? String(n) : n && typeof n === 'object' && 'props' in n ? textOf((n.props as { children?: ReactNode }).children) : '';
// CopyButton is not expanded in an element tree, so its label is a prop.
const button = (q: Question, label: string) => tree(q).find((el) => (el.type === 'button' && textOf(el) === label) || el.props.label === label);
const type = (q: Question, value: string) => tree(q).find((el) => el.type === 'textarea')!.props.onChange({ target: { value } });

const ask = mkq('q-1', 'worker', 4, { choices: ['Keep it', 'Drop it'], askedBy: { id: 'worker', title: 'worker' } });

beforeEach(() => {
  vi.clearAllMocks(); hooks.states.length = 0;
  update(() => ({ nodes: { root, worker }, questions: {}, refusals: {}, connected: true }));
  put(ask);
  clearDraft('q-1'); clearDraft('q-2');
});

it('shows choices as buttons; a choice answers at once with the choice and whatever is typed', () => {
  expect(tree(ask).filter((el) => el.props.className === 'q-choice').map(textOf)).toEqual(['Keep it', 'Drop it']);
  type(ask, '  until March  ');
  button(ask, 'Drop it')!.props.onClick();
  expect(send).toHaveBeenCalledWith({ t: 'question', id: 'q-1', action: 'answer', choice: 'Drop it', text: 'until March' });
});

it('a choice with an empty box sends no text', () => {
  button(ask, 'Keep it')!.props.onClick();
  expect(send).toHaveBeenCalledWith({ t: 'question', id: 'q-1', action: 'answer', choice: 'Keep it' });
});

it('disables Send while the box is empty; Send and Cmd+Enter send the text alone and Enter is a line break', () => {
  expect(button(ask, 'Send')!.props.disabled).toBe(true);
  type(ask, '   ');
  expect(button(ask, 'Send')!.props.disabled).toBe(true);
  tree(ask).find((el) => el.type === 'textarea')!.props.onKeyDown({ key: 'Enter', metaKey: true, preventDefault: vi.fn() });
  expect(send).not.toHaveBeenCalled();

  type(ask, 'My own answer');
  expect(button(ask, 'Send')!.props.disabled).toBe(false);
  const enter = { key: 'Enter', preventDefault: vi.fn() };
  tree(ask).find((el) => el.type === 'textarea')!.props.onKeyDown(enter);
  expect(enter.preventDefault).not.toHaveBeenCalled();
  expect(send).not.toHaveBeenCalled();
  tree(ask).find((el) => el.type === 'textarea')!.props.onKeyDown({ key: 'Enter', metaKey: true, preventDefault: vi.fn() });
  expect(send).toHaveBeenLastCalledWith({ t: 'question', id: 'q-1', action: 'answer', text: 'My own answer' });
});

it('while an answer is in flight Send reads "Sending…" and nothing can be sent twice', () => {
  type(ask, 'Yes');
  button(ask, 'Send')!.props.onClick();
  expect(send).toHaveBeenCalledOnce();
  expect(button(ask, 'Sending…')!.props.disabled).toBe(true);
  button(ask, 'Drop it')!.props.onClick();
  expect(send).toHaveBeenCalledOnce();
});

it('dismisses with the dismiss action', () => {
  button(ask, 'Dismiss')!.props.onClick();
  expect(send).toHaveBeenCalledWith({ t: 'question', id: 'q-1', action: 'dismiss' });
});

it('shows agent text literally: no element and no link comes from it', () => {
  const q = mkq('q-2', 'worker', 4, {
    question: 'Use <b>bold</b> and [a link](http://example.com)?', context: '<i>ctx</i> [more](http://example.org)', assumption: '<u>meanwhile</u>', choices: ['<em>one</em>', 'two'],
  });
  put(q);
  const out = html(q);
  for (const literal of ['&lt;b&gt;bold&lt;/b&gt;', '[a link](http://example.com)', '&lt;i&gt;ctx&lt;/i&gt;', '&lt;u&gt;meanwhile&lt;/u&gt;', '&lt;em&gt;one&lt;/em&gt;']) expect(out).toContain(literal);
  expect(out).not.toMatch(/<(b>bold|i>|u>|em>|a[ >])/);
});

it('keeps a draft when the panel closes and reopens, and when its question is withdrawn', () => {
  type(ask, 'Keep it until March');
  expect(getDraft('q-1')).toBe('Keep it until March');
  hooks.states.length = 0; // the card is gone and a new one mounts
  expect(html(ask)).toContain('Keep it until March</textarea>');

  put({ ...ask, state: 'withdrawn', resolvedAt: NOW, withdrawn: { by: 'worker', reason: 'found it in the docs' } });
  const out = html(ask);
  expect(out).toMatch(/<textarea[^>]*readonly[^>]*>Keep it until March<\/textarea>/i);
  expect(plain(ask)).toContain('No longer needed. worker withdrew it: “found it in the docs”.');
  expect(plain(ask)).toContain('Your text is kept below.');
});

it('clears the draft when this client\'s own answer is accepted, and then shows the answer, not a notice', () => {
  type(ask, 'Keep it until March');
  button(ask, 'Send')!.props.onClick();
  // Another client's identical-looking answer would not match what was sent; this one does.
  put({ ...ask, state: 'answered', resolvedAt: NOW, answer: { text: 'Keep it until March', at: NOW }, delivery: { state: 'queued' } });
  expect(plain(ask)).toContain('You answered');
  expect(settleSent(getState().questions, () => 'worker')).toEqual(['Answer sent to worker.']);
  expect(getDraft('q-1')).toBe('');
  expect(html(ask)).not.toContain('q-refused');
  expect(plain(ask)).toContain('Waiting until worker is free.');
});

const answered = (state: NonNullable<Question['delivery']>['state'], extra: Partial<Question> = {}) =>
  mkq('q-2', 'worker', 30, { state: 'answered', resolvedAt: NOW - 8 * 60_000, answer: { choice: 'Keep it', text: 'for now', at: NOW - 8 * 60_000 }, delivery: { state, at: NOW - 8 * 60_000 }, ...extra });

it.each([
  ['waiting', 'Not sent yet. Tiller will keep trying.'],
  ['queued', 'Waiting until worker is free. It will read your answer when it finishes its current turn.'],
  ['delivered', 'Delivered to worker · 8 min ago'],
  ['unconfirmed', 'It may not have seen this. The answer was sent but not confirmed; worker can still look it up.'],
  ['dropped', 'Couldn’t be delivered. The agent that asked was closed, and no agent is left to receive it.'],
] as const)('says what happened to an answer that is %s', (state, sentence) => {
  const q = answered(state);
  put(q);
  expect(plain(q)).toContain(sentence);
  expect(plain(q)).toContain('You answered');
});

it('says an answer is not sent yet because the owner is not running, with a way to go to it', () => {
  update((s) => ({ nodes: { ...s.nodes, worker: mk('worker', 'root', 0, { exited: true }) } }));
  const q = answered('waiting');
  put(q);
  expect(plain(q)).toContain('Not sent yet. worker isn’t running; it will get your answer when it starts again.');
  button(q, 'Go to worker')!.props.onClick();
  expect(go).toHaveBeenCalledWith('worker');
});

it.each([
  ['dismissed', { state: 'dismissed' }, 'You dismissed this. worker wasn’t told.'],
  ['withdrawn by the asker', { state: 'withdrawn', withdrawn: { by: 'worker', reason: 'not needed' } }, 'No longer needed. worker withdrew it: “not needed”.'],
  ['withdrawn by the asker, no reason', { state: 'withdrawn', withdrawn: { by: 'worker' } }, 'No longer needed. worker withdrew it.'],
  ['withdrawn by an ancestor', { state: 'withdrawn', withdrawn: { by: 'root' } }, 'No longer needed. tiller, the agent above it, withdrew it.'],
  ['withdrawn by tiller', { state: 'withdrawn', withdrawn: { by: 'tiller' } }, 'No longer needed. The agent that asked was closed, with no agent above it.'],
  ['replaced', { state: 'withdrawn', replacedBy: 'q-3', withdrawn: { by: 'worker', reason: 'replaced by q-3' } }, 'Replaced by a newer question. worker asked again.'],
] as [string, Partial<Question>, string][])('says a question that was %s', (_, extra, sentence) => {
  const q = mkq('q-2', 'worker', 30, { resolvedAt: NOW - 60_000, ...extra });
  put(q);
  expect(plain(q)).toContain(sentence);
});

it('offers "Show the new question" only while the replacing question is in the list', () => {
  const q = mkq('q-2', 'worker', 30, { state: 'withdrawn', replacedBy: 'q-3', resolvedAt: NOW });
  put(q);
  expect(button(q, 'Show the new question')).toBeUndefined();
  put(q, mkq('q-3', 'worker', 1));
  button(q, 'Show the new question')!.props.onClick();
  expect(getState().needs).toEqual({ open: true, focusId: 'q-3' });
});

it.each([
  ['withdrawn', { state: 'withdrawn', withdrawn: { by: 'worker', reason: 'found it in the docs' } }, 'Not sent. worker withdrew this just before your answer arrived: “found it in the docs”.', 'Your text is kept below.', 'Go to worker'],
  ['already answered', { state: 'answered', answer: { choice: 'Drop it', at: NOW } }, 'Not sent. This was already answered, in another window or from the shell: “Drop it”.', 'Your text is kept below so you can copy it.', 'Copy text'],
  ['replaced', { state: 'withdrawn', replacedBy: 'q-3', withdrawn: { by: 'worker' } }, 'Not sent. worker replaced this with a newer question.', 'Your text is kept below; you can move it to the new question.', 'Move text to the new question'],
] as [string, Partial<Question>, string, string, string][])('shows why an answer was refused when the question was %s, keeping the text', (_, extra, notSent, kept, next) => {
  const q = mkq('q-2', 'worker', 30, { resolvedAt: NOW, ...extra });
  put(q, mkq('q-3', 'worker', 1));
  setDraft('q-2', 'My considered answer');
  update(() => ({ refusals: { 'q-2': 'daemon words' } }));
  const out = plain(q);
  expect(out).toContain(notSent);
  expect(out).toContain(kept);
  expect(html(q)).toMatch(/<textarea[^>]*readonly[^>]*>My considered answer<\/textarea>/i);
  expect(button(q, next)).toBeDefined();
  expect(button(q, 'Discard text')).toBeDefined();
});

it('keeps the notice a plain element, so a card that mounts again does not announce an old refusal', () => {
  setDraft('q-1', 'text');
  update(() => ({ refusals: { 'q-1': 'q-1 is not yours to answer' } }));
  expect(html(ask)).not.toContain('role="alert"');
});

it('offers a primary "OK", which focus can land on, after a refusal with no typed text', () => {
  update(() => ({ refusals: { 'q-1': 'q-1 is not yours to answer' } }));
  const ok = button(ask, 'OK')!;
  expect(ok.props.className).toBe('btn primary');
  expect(html(ask)).not.toContain('<textarea');
  ok.props.onClick();
  expect(getState().refusals).toEqual({});
});

it('limits the answer to what the daemon accepts, 8,000 characters', () => {
  expect(tree(ask).find((el) => el.type === 'textarea')!.props.maxLength).toBe(8000);
});

it('shows a refusal it does not recognise in the daemon\'s own words', () => {
  setDraft('q-1', 'text');
  update(() => ({ refusals: { 'q-1': 'q-1 is not yours to answer' } }));
  expect(plain(ask)).toContain('Not sent. q-1 is not yours to answer');
});

it('"Discard text" removes the notice and the draft', () => {
  const q = mkq('q-2', 'worker', 30, { state: 'answered', resolvedAt: NOW, answer: { text: 'theirs', at: NOW } });
  put(q);
  setDraft('q-2', 'mine');
  update(() => ({ refusals: { 'q-2': 'q-2 was already answered' } }));
  button(q, 'Discard text')!.props.onClick();
  expect(getState().refusals).toEqual({});
  expect(getDraft('q-2')).toBe('');
});

it('moves the draft to the new question and opens its card', () => {
  const q = mkq('q-2', 'worker', 30, { state: 'withdrawn', replacedBy: 'q-3', resolvedAt: NOW });
  put(q, mkq('q-3', 'worker', 1));
  setDraft('q-2', 'carry me');
  update(() => ({ refusals: { 'q-2': 'q-2 was replaced by q-3' } }));
  button(q, 'Move text to the new question')!.props.onClick();
  expect([getDraft('q-2'), getDraft('q-3')]).toEqual(['', 'carry me']);
  expect(getState()).toMatchObject({ refusals: {}, needs: { open: true, focusId: 'q-3' } });
});

it('disables the choices, Send and Dismiss while Tiller is not connected, and says the text is kept', () => {
  update(() => ({ connected: false }));
  type(ask, 'typed while away');
  expect(tree(ask).filter((el) => el.props.className === 'q-choice').map((el) => el.props.disabled)).toEqual([true, true]);
  expect(button(ask, 'Send')!.props.disabled).toBe(true);
  expect(button(ask, 'Dismiss')!.props.disabled).toBe(true);
  expect(plain(ask)).toContain('Tiller isn’t connected right now. Your text is kept.');
  button(ask, 'Send')!.props.onClick();
  expect(send).not.toHaveBeenCalled();
});

it('tells the two kinds of open question apart, and notes a stopped owner and a closed asker', () => {
  expect(plain(ask)).toContain('Waiting on you');
  const carrying = mkq('q-2', 'worker', 4, { assumption: 'keeping the alias' });
  put(carrying);
  expect(plain(carrying)).toContain('Carrying onMeanwhile: keeping the alias');
  update((s) => ({ nodes: { ...s.nodes, worker: mk('worker', 'root', 0, { exited: true }) } }));
  expect(plain(ask)).toContain('worker isn’t running. You can still answer; it gets your answer when it starts again.');
  const moved = mkq('q-2', 'root', 4, { askedBy: { id: 'gone', title: 'css tokens' } });
  put(moved);
  expect(plain(moved)).toContain('css tokens has closed, so your answer will go to tiller, the agent above it.');
  expect(plain(moved)).toContain('css tokens (closed)');
});
