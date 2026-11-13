import { describe, expect, it } from 'vitest';
import type { NodeView, Question } from './protocol.js';
import { attention, isOpen, openFor, sortQuestions } from './questions.js';

const q = (id: string, extra: Partial<Question> = {}): Question => ({
  id, rootId: 'r', nodeId: 'n', askedBy: { id: 'n', title: 'n' }, question: id, state: 'open', askedAt: 100, ...extra,
});
const node = (id: string, state: NodeView['status']['state'], exited = false): NodeView => ({
  id, parentId: null, kind: 'claude', title: id, cwd: '/w', createdAt: 0, unread: false, status: { state, changedAt: 0, ...(exited && { exited: true }) },
});

describe('sortQuestions', () => {
  it('lists waiting-on-you before assumed, oldest first within each, then resolved newest first', () => {
    const sorted = sortQuestions([
      q('assumed-old', { assumption: 'go on', askedAt: 10 }),
      q('done-old', { state: 'answered', resolvedAt: 500 }),
      q('waiting-new', { askedAt: 300 }),
      q('done-new', { state: 'withdrawn', resolvedAt: 900 }),
      q('waiting-old', { askedAt: 200 }),
      q('assumed-new', { assumption: 'go on', askedAt: 20 }),
    ]);
    expect(sorted.map((x) => x.id)).toEqual(['waiting-old', 'waiting-new', 'assumed-old', 'assumed-new', 'done-new', 'done-old']);
  });

  it('does not change its input', () => {
    const input = [q('b', { askedAt: 2 }), q('a', { askedAt: 1 })];
    sortQuestions(input);
    expect(input.map((x) => x.id)).toEqual(['b', 'a']);
  });
});

describe('openFor and attention', () => {
  const qs = [q('mine', { nodeId: 'a' }), q('theirs', { nodeId: 'b' }), q('old', { nodeId: 'a', state: 'answered' })];

  it('openFor ignores resolved questions and other owners', () => {
    expect(openFor(qs, 'a').map((x) => x.id)).toEqual(['mine']);
    expect(isOpen(qs[2])).toBe(false);
  });

  it('attention adds nodes blocked on a prompt to open questions, and skips exited nodes', () => {
    const nodes = [node('a', 'blocked'), node('b', 'waiting'), node('c', 'done'), node('d', 'blocked', true)];
    expect(attention(nodes, qs)).toBe(2 + 2);
    expect(attention([], [])).toBe(0);
  });
});
