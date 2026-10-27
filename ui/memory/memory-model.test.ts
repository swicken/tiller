import { describe, expect, it } from 'vitest';
import type { MemoryItemView, MemoryPage } from '../../src/shared/protocol';
import { badges, checkoutLine, itemActions, purgeCommand, purgeNote, sectionsFor, splitFrontmatter, stateLine } from './memory-model';

const item = (x: Partial<MemoryItemView> = {}): MemoryItemView =>
  ({ id: 7, kind: 'pitfall', text: 'a pitfall', author: 'agent', nodeId: 'n-ab12', harness: 'codex', model: 'gpt-5', seen: 2, pinned: false, createdAt: 0, updatedAt: 0, eligible: true, ...x });
const textPin = (x: Partial<MemoryItemView> = {}) => item({ kind: 'note', author: 'human', pinned: true, textPin: true, nodeId: undefined, ...x });
const hidden = (kind: string, x: Partial<MemoryItemView> = {}) => item({ invalid: { at: 1, kind: kind as never, by: 'gardener' }, ...x });

describe('purgeCommand', () => {
  it('names the checkout and a named account', () => {
    expect(purgeCommand({ repo: '/Users/me/r', account: 'work' }, 12)).toBe("tl memory forget m12 '<reason>' --purge --repo '/Users/me/r' --account work");
  });
  it('omits --account for the _default file', () => {
    expect(purgeCommand({ repo: '/r' }, 3)).toBe("tl memory forget m3 '<reason>' --purge --repo '/r'");
  });
  it('shell-quotes a path with spaces and quotes', () => {
    expect(purgeCommand({ repo: "/My Repos/it's here" }, 1)).toBe(`tl memory forget m1 '<reason>' --purge --repo '/My Repos/it'\\''s here'`);
  });
  it('gives none without a cli scope, and says why', () => {
    expect(purgeCommand(undefined, 1)).toBeUndefined();
    const page = { on: true, source: 's' } as MemoryPage;
    expect(purgeNote(page)).toMatch(/no checkout of this repository is known/);
    expect(purgeNote({ ...page, checkout: { path: '/r', from: 'node' } })).toMatch(/another account file/);
    expect(purgeNote({ ...page, cli: { repo: '/r' } })).toBeUndefined();
    expect(purgeNote({ ...page, on: false, cli: { repo: '/r' } })).toMatch(/needs memory on/);
  });
});

describe('item state', () => {
  it('offers Edit only on live human text pins', () => {
    expect(itemActions(textPin())).toEqual(['unpin', 'edit', 'forget']);
    expect(itemActions(item({ pinned: true }))).toEqual(['unpin', 'forget']);
    expect(itemActions(item())).toEqual(['pin', 'forget']);
    // A note the human added with tl memory add is not a text pin, even when pinned.
    expect(itemActions(textPin({ textPin: undefined }))).toEqual(['unpin', 'forget']);
    expect(itemActions(textPin({ textPin: undefined, pinned: false, invalid: { at: 1, kind: 'human', by: 'human' } }))).toEqual(['pin', 'restore']);
  });
  it('offers Restore for known retractions, not for tombstones, text pins or unknown kinds', () => {
    expect(itemActions(hidden('agent'))).toEqual(['pin', 'restore']);
    expect(itemActions(hidden('human', { pinned: true }))).toEqual(['unpin', 'restore']);
    expect(itemActions(hidden('superseded'))).toEqual(['pin', 'restore']);
    expect(itemActions(hidden('human', { tombstone: 'purged', text: '' }))).toEqual([]);
    expect(itemActions(hidden('evicted', { tombstone: 'evicted', text: '' }))).toEqual([]);
    expect(itemActions(textPin({ pinned: false, invalid: { at: 1, kind: 'human', by: 'human', reason: 'unpinned' } }))).toEqual(['pin']);
    expect(itemActions(hidden('gardener'))).toEqual(['pin']);
  });
  it('labels each hidden state, with a generic label for kinds it does not know', () => {
    expect(badges(hidden('human'))).toEqual(['Retracted by the human (permanent)']);
    expect(badges(hidden('agent'))).toEqual(['Hidden by an agent until recorded again']);
    expect(badges(hidden('superseded'), 9)).toEqual(['Superseded by m9']);
    expect(badges(hidden('evicted', { tombstone: 'evicted' }))).toEqual(['Evicted']);
    expect(badges(hidden('human', { tombstone: 'purged', pinned: true }))).toEqual(['Pinned', 'Purged']);
    expect(badges(hidden('gardener'))).toEqual(['Hidden by the gardener']);
    expect(badges(item({ invalid: { at: 1, kind: 'merged', by: 'gardener:r3' }, mergedInto: 12 }))).toEqual(['Merged into m12 by the gardener']);
    expect(badges(item({ invalid: { at: 1, kind: 'merged' } }))).toEqual(['Merged by the gardener']);
    expect(badges(item({ invalid: { at: 1, kind: 'later' as never, by: 'v9' } }))).toEqual(['Hidden (later) by v9']);
    expect(badges(item({ eligible: false }))).toEqual(['Search only']);
  });
});

describe('header lines', () => {
  const page = { on: true, source: 'memory.projects /r', checkout: { path: '/r', from: 'node' } } as MemoryPage;
  it('names the checkout and how it was found, or asks for a directory', () => {
    expect(checkoutLine(page)).toBe('Checkout: /r (from this node)');
    expect(checkoutLine({ ...page, checkout: { path: '/r', from: 'recorded path' } })).toBe('Checkout: /r (the recorded path)');
    expect(checkoutLine({ ...page, checkout: undefined })).toBe('No checkout of this repository is known: choose its directory.');
  });
  it('states on, off with where to change it, and unknown', () => {
    expect(stateLine(page)).toBe('Memory is on for this checkout (memory.projects /r).');
    expect(stateLine({ ...page, on: false, source: 'memory.enabled (global): off (default)' })).toBe('Memory is off for this checkout (memory.enabled (global): off (default)). Change it in Settings → Memory.');
    expect(stateLine({ ...page, on: null, source: 'no checkout of this repository is known' })).toBe('Memory on or off is unknown: no checkout of this repository is known.');
  });
  it('shows Given only for a node', () => {
    expect(sectionsFor({}).map((s) => s.key)).toEqual(['items', 'claude']);
    expect(sectionsFor({ nodeId: 'n1' }).map((s) => s.key)).toEqual(['items', 'given', 'claude']);
  });
});

describe('splitFrontmatter', () => {
  it('splits leading frontmatter and leaves other text whole', () => {
    expect(splitFrontmatter('---\nname: x\ntype: user\n---\n\n# Body\n')).toEqual({ frontmatter: 'name: x\ntype: user', body: '\n# Body\n' });
    expect(splitFrontmatter('---\r\nname: x\r\n---\r\nbody')).toEqual({ frontmatter: 'name: x', body: 'body' });
    expect(splitFrontmatter('# No frontmatter\n---\nnot: it\n---\n')).toEqual({ body: '# No frontmatter\n---\nnot: it\n---\n' });
    expect(splitFrontmatter('---\nunclosed')).toEqual({ body: '---\nunclosed' });
  });
});
