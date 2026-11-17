import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { Question } from '../src/shared/protocol';
import { mk } from './fixtures';
import { handleQuestion } from './notify';
import { applyServer, getState, update } from './store';

// The real store, as conn.ts uses it: a question message goes through handleQuestion, then applyServer. In this
// environment there is no window, so the client is a browser and the chime plays.
const oscillators = vi.fn();
const focus = { on: true };
let clock = 0;
const question = (id: string, nodeId: string, extra: Partial<Question> = {}): Question =>
  ({ id, rootId: nodeId, nodeId, askedBy: { id: nodeId, title: nodeId }, question: `Question ${id}?`, state: 'open', askedAt: 1, ...extra });
const arrive = (q: Question) => { handleQuestion(q); applyServer({ t: 'question', question: q }); };

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  // The chime is throttled to one per node per 5 s, and the throttle outlives a test.
  vi.setSystemTime(++clock * 60_000);
  focus.on = true;
  vi.stubGlobal('document', { hasFocus: () => focus.on });
  vi.stubGlobal('AudioContext', class { currentTime = 0; destination = {}; resume() {} createOscillator() { oscillators(); return { frequency: {}, connect: () => ({ connect: () => {} }), start() {}, stop() {} }; } createGain() { return { gain: { setValueAtTime() {}, exponentialRampToValueAtTime() {} }, connect: () => ({ connect: () => {} }) }; } });
  oscillators.mockClear();
  const nodes = { tiller: { ...mk('tiller', null, 1), title: 'tiller' }, api: { ...mk('api', null, 2), title: 'api worker' }, deep: { ...mk('deep', 'api', 3), title: 'deep' } };
  update(() => ({ nodes, order: ['tiller', 'api', 'deep'], selected: 'tiller', session: 'tiller', questions: {}, activity: [], toasts: [] }));
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

it('a new open question in another session is one Activity entry, one toast naming it, and a chime', () => {
  arrive(question('q-00000001', 'deep', { question: 'Keep the alias?' }));
  expect(getState().activity).toMatchObject([{ text: 'deep asks: Keep the alias?', nodeId: 'deep', tone: 'warn' }]);
  expect(getState().toasts).toMatchObject([{ text: 'Keep the alias?', nodeId: 'deep', tone: 'warn', questionId: 'q-00000001' }]);
  expect(oscillators).toHaveBeenCalledTimes(2);
  // A second question from the same node within 5 s is still recorded and shown, but does not chime again.
  arrive(question('q-00000002', 'deep'));
  expect(getState().activity).toHaveLength(2);
  expect(getState().toasts).toHaveLength(2);
  expect(oscillators).toHaveBeenCalledTimes(2);
});

it('a snapshot, a change to a question already held, and a question that is not open produce nothing', () => {
  applyServer({ t: 'snapshot', nodes: Object.values(getState().nodes), questions: [question('q-00000001', 'api')] });
  expect([getState().activity, getState().toasts]).toEqual([[], []]);
  arrive(question('q-00000001', 'api', { assumption: 'Go on' })); // the same id, changed
  arrive(question('q-00000002', 'api', { state: 'dismissed' }));
  expect([getState().activity, getState().toasts]).toEqual([[], []]);
  expect(oscillators).not.toHaveBeenCalled();
});

it('a question in the session on screen is an Activity entry but no toast while the window has focus', () => {
  arrive(question('q-00000001', 'tiller'));
  expect(getState().activity).toHaveLength(1);
  expect(getState().toasts).toEqual([]);
  focus.on = false;
  arrive(question('q-00000002', 'tiller'));
  expect(getState().toasts).toMatchObject([{ questionId: 'q-00000002' }]);
});
