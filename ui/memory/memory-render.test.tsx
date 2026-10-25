import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { ClaudeMemoryView, MemoryItemView, MemoryPage } from '../../src/shared/protocol';
import { ClaudeView, GivenList, ItemDetail, ItemRow } from './MemoryPane';

// Untrusted text from items, digests and Claude's files, rendered for real: none of it may become markup or a live link.
vi.mock('../conn', () => ({ send: vi.fn() }));
vi.mock('../hooks', () => ({ useNow: () => 0 }));

const HOSTILE = '<img src=x onerror="alert(1)"><script>alert(2)</script>';
const item: MemoryItemView = { id: 5, kind: 'note', text: HOSTILE, body: `${HOSTILE}\n[x](javascript:alert(3))`, author: 'agent', nodeId: 'n-ab12', seen: 1, pinned: false, createdAt: 0, updatedAt: 0, eligible: true };
const page = { on: true, source: 's', cli: { repo: '/r', account: 'work' }, checkout: { path: '/r', from: 'node' } } as MemoryPage;
const noMarkup = (html: string) => {
  expect(html).not.toMatch(/<img|<script/);
  expect(html).not.toMatch(/href="(javascript|file):/i);
};

describe('untrusted item text', () => {
  it('renders a row and a detail literally', () => {
    const row = renderToStaticMarkup(<ItemRow item={item} now={0} selected={false} onSelect={() => {}} />);
    const detail = renderToStaticMarkup(<ItemDetail detail={{ item, givenTo: [] }} page={page} now={0} act={() => {}} onClose={() => {}} />);
    for (const html of [row, detail]) {
      noMarkup(html);
      expect(html).toContain('&lt;img src=x onerror=&quot;alert(1)&quot;&gt;&lt;script&gt;');
    }
    expect(detail).toContain('[x](javascript:alert(3))');
    expect(detail).toContain("tl memory forget m5 &#x27;&lt;reason&gt;&#x27; --purge --repo &#x27;/r&#x27; --account work");
  });

  it('shows the generic badge for a kind it does not know, and "(stays pinned)" on restoring a pinned item', () => {
    const later = renderToStaticMarkup(<ItemRow item={{ ...item, invalid: { at: 1, kind: 'later' as never, by: 'v9' } }} now={0} selected={false} onSelect={() => {}} />);
    expect(later).toContain('Hidden (later) by v9');
    const forgotten = renderToStaticMarkup(<ItemDetail detail={{ item: { ...item, pinned: true, invalid: { at: 1, kind: 'human', by: 'human' } }, givenTo: [] }} page={page} now={0} act={() => {}} onClose={() => {}} />);
    expect(forgotten).toContain('Restore (stays pinned)');
  });

  it('renders a digest in a pre, with resume and off-arm rows', () => {
    const html = renderToStaticMarkup(<GivenList now={0} onItem={() => {}} injections={[
      { sessionId: 's', arm: 'on', cause: 'resume', itemIds: [], text: '', ts: 0 },
      { sessionId: 's', arm: 'off', cause: 'ab', itemIds: [3], text: `# Memory\n- m3 ${HOSTILE}`, ts: 0 },
    ]} />);
    noMarkup(html);
    expect(html).toContain("Reused this session&#x27;s first digest.");
    expect(html).toContain('recorded, not given (A/B off arm)');
    expect(html).toMatch(/<pre># Memory\n- m3 &lt;img/);
    expect(html).toContain('>m3</button>');
  });
});

describe('Claude Code memory', () => {
  const view: ClaudeMemoryView = {
    dir: '/h/.claude/projects/-r/memory', account: 'work', omitted: ['a.md', 'b.md'], files: [
      { name: 'MEMORY.md', bytes: 10, mtime: 0, text: '- [topic](topic.md)' },
      { name: 'topic.md', bytes: 10, mtime: 0, text: '---\nname: topic\n---\n\n**bold** body' },
      { name: 'hostile.md', bytes: 10, mtime: 0, text: `${HOSTILE}\n\n[click](javascript:alert(3)) [file](file:///etc/passwd) ![pixel](https://example.com/p.png) [ok](https://example.com)` },
      { name: 'long.md', bytes: 70_000, mtime: 0, text: 'start', truncated: true },
    ],
  };
  it('renders frontmatter in a pre and the body as Markdown, with no markup, image or unsafe link from the file', () => {
    const html = renderToStaticMarkup(<ClaudeView view={view} checkout="/r" />);
    noMarkup(html);
    expect(html).toContain('<pre>name: topic</pre>');
    expect(html).toContain('<strong>bold</strong>');
    expect(html).toContain('href="https://example.com"');
    expect(html).toContain('pixel');
    expect(html).toContain('Claude Code&#x27;s own memory for /r (account work). Read-only; Tiller does not copy it.');
    expect(html).toContain('70000 bytes, truncated');
    expect(html).toContain('Not shown (over the limits): a.md, b.md');
  });
  it('says when there are no files, and shows a note instead', () => {
    expect(renderToStaticMarkup(<ClaudeView view={{ dir: '/d', files: [], omitted: [] }} />)).toContain('No Claude auto-memory at /d');
    const noted = renderToStaticMarkup(<ClaudeView view={{ dir: '/d', files: [], omitted: [], note: 'The memory directory is a symlink; it is not followed.' }} />);
    expect(noted).toContain('symlink');
    expect(noted).not.toContain('No Claude auto-memory');
  });
});
