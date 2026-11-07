import { expect, test } from 'vitest';
import type { NodeView } from './protocol.js';
import { pruneIds } from './prune.js';

const n = (id: string, parentId: string | null, exited: boolean, dormant?: boolean): NodeView =>
  ({ id, parentId, title: id, kind: 'claude', cwd: '/', createdAt: 0, unread: false, ...(dormant ? { dormant } : {}), status: { state: 'done', changedAt: 0, exited } });

test('prunes exited children, keeps live ones, exited roots and exited ancestors of a live node', () => {
  const nodes = [n('root', null, true), n('live', 'root', false), n('deadkid', 'root', true), n('gone', null, true), n('goneKid', 'gone', true), n('run', null, false)];
  expect(pruneIds(nodes).sort()).toEqual(['deadkid', 'goneKid']);
});

test('keeps a node that resume on start skipped (dormant), root or child', () => {
  const nodes = [n('idleRoot', null, true, true), n('idleKid', 'idleRoot', true, true), n('doneKid', 'idleRoot', true)];
  expect(pruneIds(nodes)).toEqual(['doneKid']);
});

test('with an explicit list, considers only those ids, roots and dormant nodes included, never one with a live descendant', () => {
  const nodes = [n('root', null, true), n('kid', 'root', true, true), n('other', 'root', true), n('busy', null, true), n('live', 'busy', false)];
  expect(pruneIds(nodes, ['root', 'kid', 'busy', 'live', 'missing']).sort()).toEqual(['kid', 'root']);
});
