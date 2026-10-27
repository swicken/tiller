import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { isValidElement, type ReactElement, type ReactNode } from 'react';
import { actionsFor, ActionButtons, actionMenuPosition } from './controls/ActionButtons';
import { TitleBar } from './TitleBar';
import { NodeRow } from './sidebar/NodeRow';
import { flattenSession } from './sidebar/tree';
import { ExitedCard } from './ExitedCard';
import { mk } from './fixtures';
import { getState, openDialog, showPane, togglePanel, update } from './store';
import { send } from './conn';

vi.mock('./conn', () => ({ send: vi.fn() }));
vi.mock('./hooks', () => ({ useNow: () => 10_000 }));
vi.mock('./store', async (importOriginal) => {
  const store = await importOriginal<typeof import('./store')>();
  return { ...store, useStore: (select: (state: ReturnType<typeof store.getState>) => unknown) => select(store.getState()) };
});

const worktree = { repo: '/w', path: '/w/child', branch: 'tl/child', base: 'main', baseSha: 'abc' };
const git = { branch: 'tl/child', base: 'main', ahead: 2, behind: 0, dirty: 0, additions: 12, deletions: 3 };
const child = () => ({ ...mk('child', 'root', 0, { state: 'done', git }), worktree });
const run = (node: ReturnType<typeof mk>, key: string) => actionsFor(node).find((a) => a.key === key)!.run();

beforeEach(() => {
  vi.clearAllMocks();
  update(() => ({ nodes: {}, renaming: null, panel: false }));
  openDialog(null); showPane('terminal');
});

describe('node action operations', () => {
  it('offers harness changes for roots and children, including exited agents, and excludes terminals and queued nodes', () => {
    for (const node of [mk('root', null, 0), child(), { ...child(), kind: 'agent' as const, harness: 'codex' as const, status: { ...child().status, exited: true } }]) {
      run(node, 'harness');
      expect(getState().dialog).toEqual({ kind: 'changeHarness', id: node.id });
    }
    for (const node of [{ ...child(), kind: 'terminal' as const }, { ...child(), pending: {} as never }, { ...child(), gate: 'running' as const }]) {
      expect(actionsFor(node).some((a) => a.key === 'harness')).toBe(false);
    }
    expect(send).not.toHaveBeenCalled();
  });

  it('retains root restart and routes child kill through its confirmation dialog', () => {
    run(mk('root', null, 0), 'restart');
    expect(getState().dialog).toEqual({ kind: 'restart', id: 'root' });
    run(child(), 'kill');
    expect(getState().dialog).toEqual({ kind: 'kill', id: 'child' });
    expect(send).not.toHaveBeenCalled();
  });

  it('protects exited worktrees from direct removal while allowing ordinary exited nodes to close', () => {
    const exited = { ...child(), status: { ...child().status, exited: true } };
    run(exited, 'remove');
    expect(getState().dialog).toEqual({ kind: 'kill', id: 'child' });
    expect(send).not.toHaveBeenCalled();
    run({ ...exited, worktree: undefined }, 'remove');
    expect(send).toHaveBeenCalledWith({ t: 'close', id: 'child' });
    expect(actionsFor(exited).map((a) => a.key)).toContain('resume');
    expect(actionsFor(exited).map((a) => a.key)).not.toContain('child');
  });

  it('offers Close on exited roots without exposing it for running orchestrators', () => {
    const root = mk('root', null, 0, { exited: true });
    const close = buttons(ExitedCard({ node: root })).find((b) => Array.isArray(b.props.children) && b.props.children.includes('Close'))!;
    close.props.onClick!();
    expect(send).toHaveBeenCalledExactlyOnceWith({ t: 'close', id: 'root', force: true });
    expect(actionsFor(root).map((a) => a.key)).toContain('restart');
    expect(actionsFor({ ...root, status: { ...root.status, exited: false } }).map((a) => a.key)).not.toContain('remove');
    run({ ...root, worktree }, 'remove');
    expect(getState().dialog).toEqual({ kind: 'kill', id: 'root' });
    expect(send).toHaveBeenCalledOnce();
  });

  it('preserves spawn, rename, mute, fork, resume and merge operations', () => {
    const node = child();
    run(node, 'child'); expect(getState().dialog).toEqual({ kind: 'spawn', parentId: 'child', cwd: '/w/child' });
    run(node, 'rename'); expect(getState().renaming).toEqual({ id: 'child', at: 'row' });
    run(node, 'mute'); expect(send).toHaveBeenLastCalledWith({ t: 'mute', id: 'child', muted: true });
    run({ ...node, muted: true }, 'mute'); expect(send).toHaveBeenLastCalledWith({ t: 'mute', id: 'child', muted: false });
    run(node, 'fork'); expect(getState().dialog).toEqual({ kind: 'fork', from: 'child', title: 'child', cwd: '/w/child', parentId: 'root' });
    run({ ...node, status: { ...node.status, exited: true } }, 'resume'); expect(send).toHaveBeenLastCalledWith({ t: 'resume', id: 'child' });
    run(node, 'merge'); expect(send).toHaveBeenLastCalledWith({ t: 'merge', id: 'child' });
  });

  it('keeps header New child and eligible Merge prominent, with compact New child in overflow', () => {
    for (const labels of [true, false]) {
      const html = renderToStaticMarkup(<ActionButtons node={child()} labels={labels} />);
      expect(html.includes('aria-label="New child"')).toBe(labels);
      expect(html).toContain('aria-label="Merge into main"');
      expect(html).toContain('aria-haspopup="menu"');
      expect(html).not.toContain('aria-label="Kill"');
      expect(html).not.toContain('aria-label="Rename"');
    }
    const working = { ...child(), status: { ...child().status, state: 'working' as const } };
    expect(renderToStaticMarkup(<ActionButtons node={working} labels />)).not.toContain('Merge into');
    expect(actionsFor({ ...child(), kind: 'agent', harness: 'codex' }).map((a) => a.key)).not.toContain('fork');
  });
});

// Exercise the view controls' real handlers without adding a DOM test dependency.
function buttons(node: ReactNode): ReactElement<{ children?: ReactNode; onClick?: () => void; 'aria-label'?: string }>[] {
  if (!isValidElement<{ children?: ReactNode }>(node)) return [];
  return [ ...(node.type === 'button' ? [node] : []), ...[node.props.children].flat().flatMap(buttons) ];
}

describe('inline rename', () => {
  // The selected node shows in both its row and the title bar. Two editors used to mount: the second's autofocus
  // blurred the first, whose blur commit ended renaming, so the menu's Rename appeared to do nothing.
  it.each(['title', 'row'] as const)('opens exactly one editor, on the surface whose menu was used: %s', (at) => {
    const node = child();
    update(() => ({ nodes: { child: node }, order: ['child'], selected: 'child' }));
    actionsFor(node, at).find((a) => a.key === 'rename')!.run();
    const row = flattenSession(getState().nodes, getState().order, 'child', [])[0];
    const editors = (html: string) => html.match(/class="rename"/g)?.length ?? 0;
    expect(editors(renderToStaticMarkup(<TitleBar node={node} />))).toBe(at === 'title' ? 1 : 0);
    expect(editors(renderToStaticMarkup(<NodeRow row={row} />))).toBe(at === 'row' ? 1 : 0);
  });
});

describe('header views', () => {
  it('switches panes and the independent supporting panel through the visible controls', () => {
    const controls = buttons(TitleBar({ node: child() }));
    controls.find((b) => b.props.children === 'Diff')!.props.onClick!();
    expect(getState().diffOpen).toBe(true); expect(getState().transcriptOpen).toBe(false);
    controls.find((b) => b.props.children === 'Transcript')!.props.onClick!();
    expect(getState().diffOpen).toBe(false); expect(getState().transcriptOpen).toBe(true);
    controls.find((b) => b.props['aria-label'] === 'Toggle last response panel')!.props.onClick!();
    expect(getState().panel).toBe(true); expect(getState().transcriptOpen).toBe(true);
    controls.find((b) => b.props.children === 'Memory')!.props.onClick!();
    expect(getState().memoryOpen).toBe(true); expect(getState().transcriptOpen).toBe(false);
    controls.find((b) => b.props.children === 'Terminal')!.props.onClick!();
    expect(getState().diffOpen).toBe(false); expect(getState().transcriptOpen).toBe(false); expect(getState().memoryOpen).toBe(false);
    togglePanel();
  });

  it('shows the Memory tab for agent nodes, not terminals', () => {
    const html = (node: ReturnType<typeof mk>) => renderToStaticMarkup(<TitleBar node={node} />);
    showPane('memory');
    expect(html(mk('root', null, 0))).toContain('aria-pressed="true">Memory');
    expect(html({ ...mk('pi', null, 0), kind: 'agent', harness: 'pi' })).toContain('aria-pressed="true">Memory');
    expect(html({ ...mk('shell', null, 0), kind: 'terminal' })).not.toContain('>Memory<');
  });

  it('shows only supported views and never treats a hidden view as active', () => {
    const html = (node: ReturnType<typeof mk>) => renderToStaticMarkup(<TitleBar node={node} />);
    showPane('diff');
    expect(html(mk('root', null, 0))).toContain('aria-pressed="true">Terminal');
    expect(html(child())).toContain('aria-pressed="true">Diff');
    expect(html({ ...child(), kind: 'terminal' })).not.toContain('>Transcript<');
    expect(html({ ...mk('shell', null, 0), kind: 'terminal' })).not.toContain('aria-label="Pane"');
  });
});


describe('action menu viewport bounds', () => {
  it('keeps the reported left-edge sidebar menu visible when the page has a scrollbar', () => {
    // 900px window, 15px scrollbar, trigger right=202; the old 224px menu began at -37.
    const position = actionMenuPosition({ top: 200, bottom: 224, right: 202 }, 885, 760, 224);
    expect(position.left).toBe(8);
    expect(Number(position.left) + 224).toBeLessThanOrEqual(885 - 8);
  });

  it('aligns to the visible right edge and preserves above placement and vertical clearance', () => {
    const position = actionMenuPosition({ top: 700, bottom: 724, right: 885 }, 885, 760, 224);
    expect(position.left).toBe(653);
    expect(Number(position.left) + 224).toBe(877);
    expect(position.bottom).toBe(66);
    expect(position.maxHeight).toBe(686);
  });

  it('fits menus narrower than their usual width and limits short viewport height', () => {
    const position = actionMenuPosition({ top: 40, bottom: 64, right: 90 }, 180, 180, 224);
    expect(position.left).toBe(8);
    expect(position.maxWidth).toBe(164);
    expect(position.top).toBe(70);
    expect(position.maxHeight).toBe(102);
    expect(Number(position.top) + Number(position.maxHeight)).toBe(172);
  });
});
