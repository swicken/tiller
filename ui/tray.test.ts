import { describe, expect, it } from 'vitest';
import type { Question } from '../src/shared/protocol';
import { attention } from '../src/shared/questions';
import { mk } from './fixtures';
import { trayState } from './tray';

const question = (id: string, nodeId: string, extra: Partial<Question> = {}): Question => ({
  id, rootId: nodeId, nodeId, askedBy: { id: nodeId, title: nodeId }, question: 'Which one?', state: 'open', askedAt: 1, ...extra,
});

describe('trayState', () => {
  it('green with nothing to do, amber listing the nodes that need you, red once one errored', () => {
    const idle = mk('a', null, 1), waiting = { ...mk('b', null, 1), title: 'api' }, broken = mk('c', null, 1);
    waiting.status = { ...waiting.status, state: 'waiting' };
    broken.status = { ...broken.status, state: 'done', errored: true };
    expect(trayState([idle], [])).toEqual({ color: 'green', items: [] });
    expect(trayState([idle, waiting], [])).toEqual({ color: 'amber', items: [['b', 'api']] });
    expect(trayState([idle, waiting, broken], [])).toEqual({ color: 'red', items: [['b', 'api']] });
    expect(trayState([{ ...waiting, status: { ...waiting.status, exited: true } }], []).color).toBe('green');
  });

  it('an open question makes it amber and is listed under its owner; resolved ones are not, and the count is attention', () => {
    const owner = { ...mk('a', null, 1, { state: 'done' }), title: 'tiller' }, blocked = { ...mk('b', null, 1, { state: 'blocked' }), title: 'api' };
    const qs = [question('q-00000001', 'a', { question: 'Keep the alias?' }), question('q-00000002', 'a', { state: 'dismissed' })];
    expect(trayState([owner], [])).toEqual({ color: 'green', items: [] });
    expect(trayState([owner], qs)).toEqual({ color: 'amber', items: [['a', 'tiller: Keep the alias?']] });
    const both = trayState([owner, blocked], qs);
    expect(both.items).toEqual([['b', 'api'], ['a', 'tiller: Keep the alias?']]);
    expect(both.items).toHaveLength(attention([owner, blocked], qs));
  });
});
