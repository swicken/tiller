import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Question } from '../../src/shared/protocol';
import { mk } from '../fixtures';
import { getState, update } from '../store';
import { elements } from '../test-tree';
import { clearDraft, noteSent, setDraft } from './drafts';
import { mkq, NOW } from './fixtures';
import { QuestionLive } from './QuestionLive';

// A render keeps useState and useRef values by position; effects are collected and run by the test, as after a commit.
const hooks = vi.hoisted(() => ({ states: [] as unknown[], refs: [] as { current: unknown }[], next: 0, nextRef: 0, effects: [] as (() => unknown)[] }));
vi.mock('react', async (original) => ({ ...await original<typeof import('react')>(),
  useState: (init: unknown) => {
    const i = hooks.next++;
    if (!(i in hooks.states)) hooks.states[i] = init;
    return [hooks.states[i], (v: unknown) => { hooks.states[i] = typeof v === 'function' ? v(hooks.states[i]) : v; }];
  },
  useRef: (init: unknown) => (hooks.refs[hooks.nextRef] ??= { current: init }) && hooks.refs[hooks.nextRef++],
  useEffect: (fn: () => unknown) => { hooks.effects.push(fn); } }));
vi.mock('../store', async (original) => {
  const store = await original<typeof import('../store')>();
  return { ...store, useStore: (select: (state: ReturnType<typeof store.getState>) => unknown) => select(store.getState()) };
});

const root = { ...mk('root', null, 0), title: 'tiller' };
/** Render, run the effect as a commit would, render again, and return what the live region says and its key. */
const commit = () => {
  hooks.next = 0; hooks.nextRef = 0; hooks.effects.length = 0;
  QuestionLive();
  hooks.effects.forEach((fn) => fn());
  hooks.next = 0; hooks.nextRef = 0;
  const span = elements(QuestionLive()).find((el) => el.type === 'span')!;
  return { text: span.props.children as string, key: span.key };
};

beforeEach(() => {
  hooks.states.length = 0; hooks.refs.length = 0;
  clearDraft('q-1'); clearDraft('q-2');
  update(() => ({ nodes: { root }, questions: {}, refusals: {} }));
  commit(); // the baseline, as at the first render
});

it('announces a new open question, but not one that arrives with a snapshot', () => {
  update(() => ({ questions: { 'q-1': mkq('q-1', 'root', 0, { question: 'Keep it?' }) } }));
  expect(commit().text).toBe('New question from root in tiller: Keep it?');
  update((s) => ({ snapshots: s.snapshots + 1, questions: { 'q-2': mkq('q-2', 'root', 0) } })); // a snapshot
  expect(commit().text).toBe('New question from root in tiller: Keep it?'); // unchanged
});

it('announces a new question even when a node update lands in the same batch', () => {
  update(() => ({ nodes: { root: { ...root, unread: true } }, questions: { 'q-1': mkq('q-1', 'root', 0, { question: 'Keep it?' }) } }));
  expect(commit().text).toBe('New question from root in tiller: Keep it?');
});

describe('a question resolved elsewhere under text being typed', () => {
  const resolved = (extra: Partial<Question>) => update((s) => ({ questions: { ...s.questions, 'q-1': { ...s.questions['q-1'], state: 'withdrawn', resolvedAt: NOW, ...extra } } }));
  beforeEach(() => { update(() => ({ questions: { 'q-1': mkq('q-1', 'root', 5) } })); commit(); });

  it('is announced with what happened, and that the text is kept', () => {
    setDraft('q-1', 'Keep it until March');
    resolved({ withdrawn: { by: 'root', reason: 'found it in the docs' } });
    expect(commit().text).toBe('No longer needed. root withdrew it: “found it in the docs”. Your text is kept.');
  });

  it('says so for a replaced question and one answered in another window', () => {
    setDraft('q-1', 'Keep it');
    resolved({ replacedBy: 'q-2' });
    expect(commit().text).toBe('Replaced by a newer question. root asked again. Your text is kept.');
    update(() => ({ questions: { 'q-3': mkq('q-3', 'root', 5) } }));
    commit();
    setDraft('q-3', 'Something');
    update((s) => ({ questions: { ...s.questions, 'q-3': { ...s.questions['q-3'], state: 'answered', resolvedAt: NOW, answer: { text: 'other', at: NOW } } } }));
    expect(commit().text).toBe('This was answered in another window while you were writing. Your text is kept.');
  });

  it('says what happened, without the kept-text clause, when focus was in the card but nothing was typed', () => {
    const inCard = (sel: string) => sel === '[aria-labelledby="q-1-h"]';
    vi.stubGlobal('document', { activeElement: { closest: inCard } });
    try {
      resolved({ withdrawn: { by: 'root', reason: 'found it in the docs' } });
      expect(commit().text).toBe('No longer needed. root withdrew it: “found it in the docs”.');
    } finally { vi.unstubAllGlobals(); }
  });

  it('says nothing when nothing was typed, or when the change is this client\'s own answer or a refusal', () => {
    const key = commit().key;
    resolved({ withdrawn: { by: 'root' } });
    expect(commit().key).toBe(key); // no draft
    update(() => ({ questions: { 'q-4': mkq('q-4', 'root', 5) } }));
    commit();
    setDraft('q-4', 'mine');
    noteSent('q-4', { text: 'mine' });
    update((s) => ({ questions: { ...s.questions, 'q-4': { ...s.questions['q-4'], state: 'answered', resolvedAt: NOW, answer: { text: 'mine', at: NOW } } } }));
    expect(commit().text).toBe('Answer sent to tiller.'); // the one line, not also "Your text is kept"
  });
});

it('says the same outcome twice when two answers to one owner are accepted in a row', () => {
  const answer = (id: string) => {
    noteSent(id, { text: 'yes' });
    update((s) => ({ questions: { ...s.questions, [id]: { ...mkq(id, 'root', 5), state: 'answered', answer: { text: 'yes', at: NOW } } } }));
    return commit();
  };
  update(() => ({ questions: { 'q-1': mkq('q-1', 'root', 5), 'q-2': mkq('q-2', 'root', 5) } }));
  commit();
  const first = answer('q-1'), second = answer('q-2');
  expect([first.text, second.text]).toEqual(['Answer sent to tiller.', 'Answer sent to tiller.']);
  expect(second.key).not.toBe(first.key); // a new element, so a screen reader reads it again
});

it('announces a refusal once, when it arrives, in the words of the card', () => {
  update(() => ({ questions: { 'q-1': { ...mkq('q-1', 'root', 5), state: 'answered', answer: { choice: 'Drop it', at: NOW } } } }));
  commit();
  update(() => ({ refusals: { 'q-1': 'q-1 was already answered' } }));
  expect(commit().text).toBe('Not sent. This was already answered, in another window or from the shell: “Drop it”.');
  const key = commit().key; // an unrelated change does not say it again
  update(() => ({ connected: !getState().connected }));
  expect(commit().key).toBe(key);
});
