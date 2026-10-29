import { describe, expect, it } from 'vitest';
import { ancestry, arrange, besideSession, pickInitial, rootOf, sessions } from './sessions';
import { mk } from '../fixtures';

const nodes = Object.fromEntries([
  mk('r1', null, 100), mk('c', 'r1', 500, { state: 'blocked' }), mk('g', 'c', 50),
  mk('r2', null, 300), mk('r3', null, 900, { exited: true }), mk('orphan', 'gone', 10),
].map((n) => [n.id, n]));
const order = ['r1', 'c', 'g', 'r2', 'r3', 'orphan'];

describe('sessions', () => {
  it('ancestry and rootOf walk to the root; unknown parents make a root', () => {
    expect(ancestry(nodes, 'g').map((n) => n.id)).toEqual(['r1', 'c', 'g']);
    expect(rootOf(nodes, 'g')).toBe('r1');
    expect(rootOf(nodes, 'orphan')).toBe('orphan');
  });

  it('summarises each session: size, needs-you count, most urgent state', () => {
    const [s1, s2, s3] = sessions(nodes, order);
    expect([s1.root.id, s1.size, s1.needs, s1.kind]).toEqual(['r1', 3, 1, 'needs']);
    expect([s2.root.id, s2.size, s2.needs, s2.kind]).toEqual(['r2', 1, 0, 'working']);
    expect(s3.kind).toBe('exited');
  });

  it('default session: ?node wins (even deep), else newest live root, else first root', () => {
    expect(pickInitial(nodes, order, 'g')).toBe('g');
    expect(pickInitial(nodes, order, 'nope')).toBe('r2'); // r3 is newer but exited; r1's child changes do not count
    expect(pickInitial(nodes, order)).toBe('r2');
    const dead = { r1: mk('r1', null, 1, { exited: true }), r2: mk('r2', null, 2, { exited: true }) };
    expect(pickInitial(dead, ['r1', 'r2'])).toBe('r1');
    expect(pickInitial({}, [])).toBeNull();
  });

  it('arrange puts roots in the saved order, roots it does not name last, and keeps every other node where it was', () => {
    // r3 is saved first; r1 and the orphan are not saved, so they follow in their current order; 'gone' is ignored.
    expect(arrange(nodes, order, ['r3', 'gone', 'r2'])).toEqual(['r3', 'r2', 'r1', 'orphan', 'c', 'g']);
    expect(sessions(nodes, arrange(nodes, order, ['r3', 'r2'])).map((x) => x.root.id)).toEqual(['r3', 'r2', 'r1', 'orphan']);
    expect(arrange(nodes, order, [])).toEqual(['r1', 'r2', 'r3', 'orphan', 'c', 'g']);
  });

  it('besideSession picks the tab to the right, else the left', () => {
    expect(besideSession(nodes, order, 'r2')).toBe('r3');
    expect(besideSession(nodes, order, 'orphan')).toBe('r3');
    expect(besideSession(nodes, ['r1'], 'r1')).toBeUndefined();
    expect(besideSession(nodes, order, 'c')).toBeUndefined(); // not a root
  });
});
