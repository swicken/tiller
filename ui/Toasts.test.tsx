import { beforeEach, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { Question } from '../src/shared/protocol';
import { elements, type Element } from './test-tree';
import { DigestCard, Toasts } from './Toasts';
import { getState, toast, update } from './store';
import { mk } from './fixtures';

vi.mock('react', async (original) => ({ ...await original<typeof import('react')>(), useEffect: () => {} }));
vi.mock('./store', async (original) => {
  const store = await original<typeof import('./store')>();
  return { ...store, useStore: (select: (state: ReturnType<typeof store.getState>) => unknown) => select(store.getState()) };
});
vi.mock('./conn', () => ({ send: vi.fn() }));

const question = (id: string, extra: Partial<Question> = {}): Question =>
  ({ id, rootId: 'api', nodeId: 'api', askedBy: { id: 'api', title: 'api worker' }, question: 'Keep the alias?', state: 'open', askedAt: 1, ...extra });
/** The function components of one name in a rendered tree, each drawn once more (their hooks read the mocked store). */
const drawn = (tree: ReactNode, name: string) =>
  elements(tree).filter((el) => typeof el.type === 'function' && el.type.name === name).map((el) => ({ key: el.key, tree: (el.type as (props: object) => Element)(el.props) }));
const html = (tree: ReactNode) => renderToStaticMarkup(tree as never);
const click = (tree: ReactNode) => elements(tree).find((el) => el.type === 'button')!.props.onClick();

beforeEach(() => {
  update(() => ({
    nodes: { tiller: { ...mk('tiller', null, 1), title: 'tiller' }, api: { ...mk('api', null, 2), title: 'api worker' }, deep: { ...mk('deep', 'api', 3), title: 'deep' } },
    order: ['tiller', 'api', 'deep'], selected: 'tiller', session: 'tiller', questions: {}, toasts: [], needs: { open: false }, digest: undefined, confirms: [],
  }));
});

it('a question toast is one button naming who asks, and in which session when that is not the one on screen', () => {
  toast('Keep the alias?', 'deep', 'warn', 'q-00000001');
  const [item] = drawn(Toasts(), 'ToastItem');
  expect(html(item.tree)).toBe('<button class="toast warn qtoast" aria-label="Answer deep’s question"><span class="q-toast-who">deep asks<span> · in api worker</span></span><span class="q-toast-q">Keep the alias?</span></button>');
  update(() => ({ session: 'api' }));
  expect(html(drawn(Toasts(), 'ToastItem')[0].tree)).not.toContain(' · in ');
});

it('clicking a question toast opens the Needs you panel on its question and removes the toast', () => {
  toast('Keep the alias?', 'deep', 'warn', 'q-00000001');
  click(drawn(Toasts(), 'ToastItem')[0].tree);
  expect(getState().needs).toEqual({ open: true, focusId: 'q-00000001' });
  expect(getState().toasts).toEqual([]);
});

it('a digest row for a question reads "Asked you" with its state and opens the panel on it; other rows still select their node', () => {
  update(() => ({
    questions: { 'q-00000001': question('q-00000001'), 'q-00000002': question('q-00000002', { assumption: 'Go on' }) },
    digest: { since: 0, items: [
      { id: 'api', title: 'api worker', kind: 'needsYou', text: 'Keep the alias?', at: 1, questionId: 'q-00000001' },
      { id: 'api', title: 'api worker', kind: 'needsYou', text: 'Which port?', at: 2, questionId: 'q-00000002' },
      { id: 'deep', title: 'deep', kind: 'needsYou', text: 'Needs approval', at: 3 },
    ] },
  }));
  const rows = drawn(DigestCard(), 'DigestRow');
  // The same node can ask twice, so the key is the node plus the question.
  expect(rows.map((r) => r.key)).toEqual(['apiq-00000001', 'apiq-00000002', 'deep']);
  expect(html(rows[0].tree)).toContain('<span class="kind">Asked you</span> <strong>api worker</strong><span class="kind q-kind-state waiting"> · waiting on you</span><span class="text">Keep the alias?</span>');
  expect(html(rows[1].tree)).toContain('<span class="kind q-kind-state"> · carrying on meanwhile</span>');
  expect(html(rows[2].tree)).toContain('<span class="kind">Needs you</span>');
  expect(html(rows[2].tree)).not.toContain('q-kind-state');
  click(rows[1].tree);
  expect(getState().needs).toEqual({ open: true, focusId: 'q-00000002' });
  expect(getState().digest).toBeUndefined();
  update(() => ({ needs: { open: false } }));
  click(rows[2].tree);
  expect(getState().selected).toBe('deep');
  expect(getState().needs.open).toBe(false);
});
