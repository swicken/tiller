import type { Question } from '../../src/shared/protocol';

export const NOW = 1_700_000_000_000;
/** An open question owned and asked by `nodeId`, asked `mins` minutes before NOW; `extra` overrides any field. */
export const mkq = (id: string, nodeId: string, mins: number, extra: Partial<Question> = {}): Question => ({
  id, rootId: 'a', nodeId, askedBy: { id: nodeId, title: nodeId }, question: `Question ${id}?`, state: 'open', askedAt: NOW - mins * 60_000, ...extra,
});
