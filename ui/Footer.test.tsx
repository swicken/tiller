import { beforeEach, expect, it, vi } from 'vitest';
import type { ReactElement, ReactNode } from 'react';
import { elements as walk } from './test-tree';
import { renderToStaticMarkup } from 'react-dom/server';
import { StatusBar } from './StatusBar';
import { Dialogs } from './dialogs/Dialogs';
import { Palette } from './Palette';
import { getState, update } from './store';
import { send } from './conn';
import { toggleDnd } from './hooks';

const effects = vi.hoisted(() => [] as (() => unknown)[]);
vi.mock('./controls/Modal', () => ({ Modal: ({ children, footer }: { children: ReactNode; footer?: ReactNode }) => <>{children}{footer}</> }));
vi.mock('./store', async (original) => {
  const store = await original<typeof import('./store')>();
  return { ...store, useStore: (select: (state: ReturnType<typeof store.getState>) => unknown) => select(store.getState()) };
});
vi.mock('./conn', () => ({ send: vi.fn(), refreshUsage: vi.fn() }));
vi.mock('./hooks', () => ({ useNow: () => 100, toggleDnd: vi.fn() }));
vi.mock('react', async (original) => ({ ...await original<typeof import('react')>(), useState: (initial: unknown) => [initial, vi.fn()], useRef: () => ({ current: null }), useMemo: (fn: () => unknown) => fn(), useEffect: (fn: () => unknown) => effects.push(fn) }));
// A modal's footer prop holds nodes too.
const elements = (node: ReactNode) => walk(node, 'footer');
function command(key: string) {
  const element = elements(Palette()).find((el) => el.key === `cmd:${key}`);
  if (!element) throw Error(`Missing command ${key}`);
  return element;
}
beforeEach(() => {
  vi.clearAllMocks();
  effects.splice(0);
  vi.stubGlobal('document', { activeElement: null });
  vi.stubGlobal('location', { host: 'localhost' });
  vi.stubGlobal('requestAnimationFrame', (fn: () => void) => fn());
  update(() => ({ nodes: {}, order: [], connected: true, dnd: undefined, update: undefined, dialog: { kind: 'palette' }, activityOpen: false }));
});

it('removes persistent footer commands and shortcut text when current', () => {
  update(() => ({ update: { sha: 'current', checkedAt: 1, eligible: true, releases: [] } }));
  const html = renderToStaticMarkup(<StatusBar />);
  expect(html).toContain('Usage');
  for (const label of ['Updates', 'Update available', 'Update v2', 'disturb', 'Activity', '<kbd', 'What’s new']) expect(html).not.toContain(label);
});

it('shows discovered availability and opens release management without installing or acknowledging installed notes', () => {
  const release = { id: 2, tag: 'v0.1.1', sha: 'future', name: 'v0.1.1', body: 'Future notes', tagObject: 'future', publishedAt: '' };
  const notes = { identity: 'installed-identity', releases: [{ ...release, id: 1, sha: 'installed', body: 'Installed notes' }] };
  // Availability is still useful when a dirty checkout temporarily prevents installation.
  const status = { sha: 'installed', checkedAt: 1, eligible: false, reason: 'uncommitted or untracked files', releases: [release], target: release, installedNotes: notes };
  update(() => ({ update: status, dialog: null }));
  const html = renderToStaticMarkup(<StatusBar />);
  expect(html).toContain('Update available');
  expect(html).toContain('What’s new');
  expect(getState().dialog).toBeNull();
  expect(send).not.toHaveBeenCalled();
  const button = elements(StatusBar()).find((el) => el.props.className === 'update-available')!;
  expect(button.props['aria-haspopup']).toBe('dialog');
  button.props.onClick();
  expect(getState().dialog).toEqual({ kind: 'update' });
  expect(renderToStaticMarkup(<Dialogs />)).toContain('Future notes');
  effects.splice(0).forEach((effect) => effect());
  expect(send).not.toHaveBeenCalled();
  expect(getState().update?.installedNotes).toEqual(notes);
  for (const state of [
    { ...status, sha: 'future', releases: [] },
    { ...status, releases: [] }, // Development checkout already includes the latest release.
    { ...status, fetchError: 'offline' },
    { ...status, applying: true },
  ]) {
    update(() => ({ update: state }));
    expect(renderToStaticMarkup(<StatusBar />)).not.toContain('Update available');
    expect(renderToStaticMarkup(<StatusBar />)).toContain('What’s new');
  }
});

it('offers a rebuild and restart when the clean checkout is current but the daemon is older', () => {
  const release = { id: 2, tag: 'v0.1.1', sha: 'source', name: 'v0.1.1', body: 'Release notes', tagObject: 'tag', publishedAt: '' };
  update(() => ({ update: { sha: 'source', runtimeSha: 'running', currentVersion: release.tag, checkedAt: 1, eligible: true, releases: [], target: release }, dialog: null }));
  expect(renderToStaticMarkup(<StatusBar />)).toContain('Restart to finish update');
  elements(StatusBar()).find((el) => el.props.className === 'update-available')!.props.onClick();
  const html = renderToStaticMarkup(<Dialogs />);
  expect(html).toContain('Rebuild and restart');
  expect(html).toContain('source checkout has moved');
  const dialog = Dialogs() as ReactElement<Record<string, any>>;
  const renderDialog = dialog.type as (props: Record<string, any>) => ReactNode;
  const action = elements(renderDialog(dialog.props)).find((el) => el.type === 'button' && el.props.className === 'btn primary');
  action!.props.onClick();
  expect(send).toHaveBeenCalledWith({ t: 'update', tag: release.tag, sha: release.sha });
});

it('keeps Activity, notification toggling, and update management reachable through palette handlers', () => {
  command('activity').props.onClick();
  expect(getState().activityOpen).toBe(true);
  expect(getState().dialog).toBeNull();
  command('dnd').props.onClick();
  expect(toggleDnd).toHaveBeenCalledOnce();
  command('updates').props.onClick();
  expect(getState().dialog).toEqual({ kind: 'update' });
  expect(send).not.toHaveBeenCalled();
  command('check-updates').props.onClick();
  expect(send).toHaveBeenCalledWith({ t: 'updateCheck' });
  expect(getState().dialog).toEqual({ kind: 'update' });
  update(() => ({ dnd: { on: true } }));
  expect(JSON.stringify(command('dnd').props.children)).toContain('Turn off do not disturb');
});


it('shows only backend installed unread notes and acknowledges their loaded identity, preserving newer notes', () => {
  const release = { id: 1, tag: 'v1', name: 'Installed release', body: 'Installed changes', sha: 'installed', tagObject: 'tag', publishedAt: '' };
  const notes = { identity: 'installed-identity', releases: [release] };
  const status = { sha: 'installed', checkedAt: 1, eligible: false, releases: [], installedNotes: notes };
  update(() => ({ update: status }));
  expect(renderToStaticMarkup(<StatusBar />)).toContain('What’s new');
  expect(send).not.toHaveBeenCalled(); // Merely noticing the badge does not mark it read.
  elements(StatusBar()).find((el) => el.props.className === 'whats-new')!.props.onClick();
  expect(getState().dialog).toEqual({ kind: 'whatsNew', notes });
  // A newer update arriving while the dialog opens must never change which notes were read.
  const newer = { identity: 'newer-identity', releases: [{ ...release, id: 2, body: 'Newer changes' }] };
  update(() => ({ update: { ...status, installedNotes: newer } }));
  const html = renderToStaticMarkup(<Dialogs />);
  expect(html).toContain('Installed changes');
  expect(html).not.toContain('Newer changes');
  effects.splice(0).forEach((effect) => effect());
  expect(send).toHaveBeenCalledExactlyOnceWith({ t: 'updateNotesRead', identity: notes.identity });
  expect(getState().update?.installedNotes).toBe(newer); // No optimistic clearing of newer state.
  update(() => ({ update: { ...status, installedNotes: undefined } }));
  expect(renderToStaticMarkup(<StatusBar />)).not.toContain('What’s new');
});

it('manual release management never acknowledges installed notes', () => {
  command('updates').props.onClick();
  renderToStaticMarkup(<Dialogs />);
  effects.splice(0).forEach((effect) => effect());
  expect(send).not.toHaveBeenCalled();
});

it('closes the palette before opening release management so the native close event cannot dismiss it', () => {
  let nextFrame: (() => void) | undefined;
  vi.stubGlobal('requestAnimationFrame', (fn: () => void) => { nextFrame = fn; });
  command('updates').props.onClick();
  expect(getState().dialog).toBeNull();
  nextFrame!();
  expect(getState().dialog).toEqual({ kind: 'update' });
});

it('retains unread installed notes while disconnected instead of pretending an acknowledgement succeeded', () => {
  const notes = { identity: 'offline-identity', releases: [{ id: 1, tag: 'v1', name: 'v1', body: 'Loaded notes', sha: 'a', tagObject: 'a', publishedAt: '' }] };
  update(() => ({ connected: false, dialog: { kind: 'whatsNew', notes } }));
  expect(renderToStaticMarkup(<Dialogs />)).toContain('Loaded notes');
  effects.splice(0).forEach((effect) => effect());
  expect(send).not.toHaveBeenCalled();
});
