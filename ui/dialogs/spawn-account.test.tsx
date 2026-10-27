import { beforeEach, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import { elements, type Element } from '../test-tree';
import { Dialogs } from './Dialogs';
import { update } from '../store';
import { claudeAccounts, mk } from '../fixtures';
import { send } from '../conn';

// The change-harness pattern: hooks are replayed by call order so the real handlers can be driven without a DOM.
const hooks = vi.hoisted(() => ({ slots: [] as unknown[], cursor: 0 }));
vi.mock('react', async (original) => ({
  ...await original<typeof import('react')>(),
  useState: (initial: unknown) => {
    const i = hooks.cursor++;
    if (!(i in hooks.slots)) hooks.slots[i] = initial;
    return [hooks.slots[i], (value: unknown) => { hooks.slots[i] = value; }];
  },
  useEffect: (effect: () => void) => { effect(); },
}));
vi.mock('../conn', () => ({ send: vi.fn() }));
vi.mock('../store', async (original) => {
  const store = await original<typeof import('../store')>();
  return { ...store, useStore: (select: (s: ReturnType<typeof store.getState>) => unknown) => select(store.getState()) };
});
function render(): Element {
  hooks.cursor = 0;
  const dialog = Dialogs() as Element;
  return (dialog.type as (props: object) => Element)(dialog.props);
}
const text = (tree: ReactNode) => JSON.stringify(tree);
const accountSelect = (tree: ReactNode) => elements(tree).find((el) => el.props.value !== undefined && elements(el.props.children).some((o) => o.type === 'option' && o.props.children === 'Automatic (by project)'));

beforeEach(() => {
  hooks.slots = [];
  vi.clearAllMocks();
  update(() => ({ claudeAccounts: undefined, nodes: { parent: { ...mk('parent', null, 0), account: 'work' } }, dialog: { kind: 'spawn', parentId: null, cwd: '/repo' } }));
});

it('asks for accounts when a root spawn opens and keeps today\'s dialog when none are configured', () => {
  expect(accountSelect(render())).toBeUndefined();
  expect(send).toHaveBeenCalledWith({ t: 'claudeAccounts' });
  update(() => ({ claudeAccounts: [] }));
  expect(accountSelect(render())).toBeUndefined();
});

it('offers Automatic plus each account with its login state, and sends only a chosen account', () => {
  update(() => ({ claudeAccounts }));
  let tree = render();
  const select = accountSelect(tree)!;
  expect(elements(select).filter((el) => el.type === 'option').map((el) => el.props.children))
    .toEqual(['Automatic (by project)', 'personal (default) · me@example.com', 'work · me@work.example, Work Inc', 'client · not logged in']);
  elements(tree).find((el) => el.type === 'form')!.props.onSubmit({ preventDefault() {} });
  expect(send).toHaveBeenLastCalledWith(expect.not.objectContaining({ account: expect.anything() }));

  update(() => ({ dialog: { kind: 'spawn', parentId: null, cwd: '/repo' } }));
  tree = render();
  accountSelect(tree)!.props.onChange({ target: { value: 'work' } });
  tree = render();
  expect(text(tree)).not.toContain('auth login');
  elements(tree).find((el) => el.type === 'form')!.props.onSubmit({ preventDefault() {} });
  expect(send).toHaveBeenLastCalledWith(expect.objectContaining({ t: 'spawn', kind: 'claude', account: 'work' }));
});

it('shows the login command and the /login hint for a logged-out account', () => {
  update(() => ({ claudeAccounts }));
  let tree = render();
  accountSelect(tree)!.props.onChange({ target: { value: 'client' } });
  tree = render();
  const command = elements(tree).find((el) => el.props['aria-label'] === 'Login command')!;
  expect(command.props.readOnly).toBe(true);
  expect(command.props.value).toBe('CLAUDE_CONFIG_DIR=/Users/me/.claude-client claude auth login');
  expect(accountSelect(tree)!.props['aria-describedby']).toBe('account-login');
  expect(text(tree)).toContain("or /login in the node's terminal");
});

it('hides the select for other harnesses and shows a child\'s inherited account read-only', () => {
  update(() => ({ claudeAccounts }));
  let tree = render();
  elements(tree).find((el) => el.props.role === 'radio' && el.props.children === 'pi')!.props.onClick();
  expect(accountSelect(render())).toBeUndefined();

  hooks.slots = [];
  vi.mocked(send).mockClear();
  update(() => ({ dialog: { kind: 'spawn', parentId: 'parent', cwd: '/repo' } }));
  tree = render();
  expect(send).not.toHaveBeenCalled();
  expect(accountSelect(tree)).toBeUndefined();
  expect(text(tree)).toContain('"Account: ","work"," (inherited)"');
});

it('falls back to Automatic when a fresh reply no longer lists the selected account', () => {
  update(() => ({ claudeAccounts }));
  accountSelect(render())!.props.onChange({ target: { value: 'work' } });
  expect(accountSelect(render())!.props.value).toBe('work');
  update(() => ({ claudeAccounts: claudeAccounts.filter((a) => a.name !== 'work') }));
  const tree = render();
  expect(accountSelect(tree)!.props.value).toBe('');
  elements(tree).find((el) => el.type === 'form')!.props.onSubmit({ preventDefault() {} });
  expect(send).toHaveBeenLastCalledWith(expect.not.objectContaining({ account: expect.anything() }));
});

it('shows an invalid accounts config as an error, never as an account to send', () => {
  const error = 'claude.accounts in /home/config.json is invalid: claude.accounts: duplicate account name work; fix it before starting Claude nodes';
  update(() => ({ claudeAccounts: [{ name: 'claude.accounts', projects: [], isDefault: false, loggedIn: null, loginCommand: '', error }] }));
  const tree = render();
  expect(accountSelect(tree)).toBeUndefined();
  expect(elements(tree).find((el) => el.props.role === 'alert')!.props.children).toBe(error);
  elements(tree).find((el) => el.type === 'form')!.props.onSubmit({ preventDefault() {} });
  expect(send).toHaveBeenLastCalledWith(expect.not.objectContaining({ account: expect.anything() }));
});
