import { beforeEach, expect, it, vi } from 'vitest';
import type { ReactElement, ReactNode } from 'react';
import { refreshUsage, send } from '../conn';
import { SettingsPanel } from './SettingsPanel';
import { Modal } from '../controls/Modal';
import { Select } from '../controls/Select';
import type { SettingsSnapshot } from './settings-model';

// Exercise the component's real handlers and asynchronous requests without a DOM dependency.
// Effects are flushed after each render; DOM focus/dialog behavior is verified in the browser.
const hooks = vi.hoisted(() => ({ store: { connected: false, usageSources: undefined as unknown, usageScanning: false }, slots: [] as unknown[], cursor: 0, deps: [] as unknown[][], effects: [] as (() => unknown)[] }));
vi.mock('react', async (original) => ({
  ...await original<typeof import('react')>(),
  useState: (initial: unknown) => {
    const i = hooks.cursor++;
    if (!(i in hooks.slots)) hooks.slots[i] = initial;
    return [hooks.slots[i], (next: unknown) => { hooks.slots[i] = typeof next === 'function' ? next(hooks.slots[i]) : next; }];
  },
  useRef: () => ({ current: null }),
  useEffect: (effect: () => unknown, deps: unknown[]) => {
    const i = hooks.cursor++;
    if (!hooks.deps[i] || deps.some((value, j) => value !== hooks.deps[i][j])) { hooks.deps[i] = deps; hooks.effects.push(effect); }
  },
}));
vi.mock('../store', () => ({ useStore: (select: (s: unknown) => unknown) => select(hooks.store) }));
vi.mock('../conn', () => ({ refreshUsage: vi.fn(), send: vi.fn() }));
vi.mock('../url', () => ({ token: () => 'test' }));
const snapshot: SettingsSnapshot = { scope: 'project', path: '/repo/.tiller/config.json', projectPath: '/repo', revision: 'r1', values: { 'profiles.claude.implementation.model': 'custom' }, entries: { 'profiles.claude.implementation.model': { value: 'custom', source: '/repo/.tiller/config.json' } }, inherited: { 'profiles.claude.implementation.model': { value: 'legacy-worker', source: '/home/config.json' } } };
let tree: ReactElement<Record<string, any>>;
const close = vi.fn();
const fetchMock = vi.fn(async (_url: unknown, options?: RequestInit) => {
  const scope = String(_url).includes('scope=home') ? 'home' : 'project';
  return { ok: true, json: async () => ({ ...snapshot, scope, ...(options?.method === 'POST' ? { revision: 'r2' } : {}) }) };
});
// Config directory checks: by path, so they never take a settings request's one-off mock.
const dirFetch = vi.fn(async (_path: string): Promise<unknown> => ({ exists: false, directory: false }));
const fetchStub = (url: unknown, options?: RequestInit) => {
  const dir = new URL(String(url), 'http://x').searchParams.get('claudeConfigDir');
  return dir === null ? fetchMock(url, options) : dirFetch(dir).then((check) => ({ ok: true, json: async () => check }));
};
function render() { hooks.cursor = 0; tree = SettingsPanel({ nodeId: 'n1', onClose: close }); hooks.effects.splice(0).forEach((effect) => effect()); }
async function settle() { await vi.waitFor(() => { render(); expect(elements(tree).some((e) => e.type === 'form')).toBe(true); expect(button('Close').props.disabled).toBe(false); }); }
type Element = ReactElement<Record<string, any>>;
function elements(node: ReactNode): Element[] {
  if (Array.isArray(node)) return node.flatMap((child) => elements(child));
  if (!node || typeof node !== 'object' || !('props' in node)) return [];
  const element = node as Element;
  return [element, ...elements(element.props.children)];
}
function text(node: ReactNode): string { return Array.isArray(node) ? node.map(text).join('') : node && typeof node === 'object' && 'props' in node ? text((node as Element).props.children) : typeof node === 'string' ? node : ''; }
function button(label: string, root: ReactNode = tree) { const match = elements(root).find((e) => e.type === 'button' && text(e.props.children) === label); if (!match) throw Error(`Missing button ${label}`); return match; }
function click(label: string, root: ReactNode = tree) { button(label, root).props.onClick(); render(); }
function confirmDiscard() { const notice = elements(tree).find((e) => e.props.role === 'alert' && text(e).includes('Discard unsaved changes?')); expect(notice).toBeDefined(); click('Discard changes', notice); }
function changeScope(scope: 'home' | 'project') { elements(tree).find((e) => e.props['aria-label'] === 'Settings scope')!.props.onChange({ target: { value: scope } }); render(); }
function search(value: string) { elements(tree).find((e) => e.props['aria-label'] === 'Search settings')!.props.onChange({ target: { value } }); render(); }
function input(id: string) { return elements(tree).find((e) => e.props.id === `setting-${id}`)!; }
async function submit() { await elements(tree).find((e) => e.type === 'form')!.props.onSubmit({ preventDefault() {} }); await settle(); }
beforeEach(async () => { hooks.store = { connected: false, usageSources: undefined, usageScanning: false }; vi.mocked(refreshUsage).mockClear(); hooks.slots = []; hooks.deps = []; hooks.effects = []; close.mockClear(); fetchMock.mockClear(); dirFetch.mockClear(); vi.stubGlobal('fetch', fetchStub); vi.stubGlobal('document', { activeElement: null }); render(); await settle(); });

it('marks only inherited selected dropdown values as defaults and preserves same-value customizations', async () => {
  const key = 'approvals.close';
  fetchMock.mockImplementationOnce(async () => ({ ok: true, json: async () => ({ ...snapshot, scope: 'home', values: {}, entries: { [key]: { value: 'never', source: 'default' } }, inherited: { [key]: { value: 'never', source: 'default' } } }) }));
  changeScope('home'); await settle(); click('Approvals & checks');
  const selected = () => elements(input(key)).find((e) => e.type === 'option' && e.props.value === input(key).props.value)!;
  const row = () => elements(tree).find((e) => e.props.className === 'settings-field' && elements(e).includes(input(key)))!;
  expect(text(selected())).toBe('Always ask for approval (default)');
  expect(text(row())).not.toContain('Using default');
  expect(elements(row()).some((e) => e.props.className === 'settings-detail')).toBe(false);
  expect(button('Save changes').props.disabled).toBe(true);
  expect(elements(input(key)).filter((e) => e.type === 'option' && text(e).includes('(default)'))).toHaveLength(1);
  input(key).props.onChange({ target: { value: 'never' } }); render();
  expect(text(selected())).toBe('Always ask for approval');
  expect(text(row())).toContain('Custom setting');
  expect(button('Save changes').props.disabled).toBe(false);
  await submit();
  const saved = fetchMock.mock.calls.find((call) => call[1]?.method === 'POST')!;
  expect(JSON.parse(String(saved[1]?.body))).toEqual({ scope: 'home', revision: 'r1', changes: { [key]: 'never' } });
});

it('previews a saved dropdown reset as inherited and saves only its removal', async () => {
  const key = 'approvals.close';
  fetchMock.mockImplementationOnce(async () => ({ ok: true, json: async () => ({ ...snapshot, scope: 'home', values: { [key]: 'always' }, entries: { [key]: { value: 'always', source: '/home/config.json' } }, inherited: { [key]: { value: 'never', source: 'default' } } }) }));
  changeScope('home'); await settle(); click('Approvals & checks');
  expect(text(elements(input(key)).find((e) => e.type === 'option' && e.props.value === 'always'))).toBe('Always allow');
  elements(tree).find((e) => e.props['aria-label'] === 'Use inherited default: Close nodes without approval')!.props.onClick(); render();
  expect(input(key).props.value).toBe('never');
  expect(text(elements(input(key)).find((e) => e.type === 'option' && e.props.value === 'never'))).toBe('Always ask for approval (default)');
  expect(text(tree)).toContain('Unsaved');
  await submit();
  const saved = fetchMock.mock.calls.find((call) => call[1]?.method === 'POST')!;
  expect(JSON.parse(String(saved[1]?.body))).toEqual({ scope: 'home', revision: 'r1', changes: { [key]: null } });
});

it('preserves an unlisted scoped default when customizing and resetting dropdowns', async () => {
  const key = 'profiles.claude.implementation.effort';
  fetchMock.mockImplementationOnce(async () => ({ ok: true, json: async () => ({ ...snapshot, scope: 'home', values: {}, entries: { [key]: { value: 'provider-custom', source: '/shared/config.json' } }, inherited: { [key]: { value: 'provider-custom', source: '/shared/config.json' } } }) }));
  changeScope('home'); await settle();
  const selected = () => elements(input(key)).find((e) => e.type === 'option' && e.props.value === input(key).props.value)!;
  expect(input(key).props.value).toBe('provider-custom');
  expect(text(selected())).toBe('provider-custom (default)');
  input(key).props.onChange({ target: { value: 'high' } }); render();
  expect(text(selected())).toBe('High');
  expect(text(tree)).toContain('Custom setting');
  elements(tree).find((e) => e.props['aria-label'] === 'Use inherited default: Implementation effort')!.props.onClick(); render();
  expect(input(key).props.value).toBe('provider-custom');
  expect(text(selected())).toBe('provider-custom (default)');
  await submit();
  expect(fetchMock.mock.calls.some((call) => call[1]?.method === 'POST')).toBe(false);
  expect(button('Save changes').props.disabled).toBe(true);
  input(key).props.onChange({ target: { value: 'medium' } }); render();
  expect(text(selected())).toBe('Medium');
  await submit();
  const saved = fetchMock.mock.calls.find((call) => call[1]?.method === 'POST')!;
  expect(JSON.parse(String(saved[1]?.body))).toEqual({ scope: 'home', revision: 'r1', changes: { [key]: 'medium' } });
});

it('keeps unset harness defaults and unavailable previews distinct without creating drafts', () => {
  const key = 'profiles.claude.implementation.effort';
  expect(input(key).props.value).toBe('');
  expect(text(elements(input(key)).find((e) => e.type === 'option' && e.props.value === ''))).toBe('Harness default / unset (default)');
  expect(button('Save changes').props.disabled).toBe(true);
  click('Legacy Claude roles');
  input('roles.worker.effort').props.onChange({ target: { value: 'high' } }); render(); click('Claude');
  expect(text(elements(input(key)).find((e) => e.type === 'option' && e.props.value === ''))).toBe('Preview available after save');
  expect(text(input(key))).not.toContain('(default)');
  expect(text(tree)).toContain('Preview unavailable until legacy role changes are saved.');
});

it('removes informational disclosures while keeping editable profile groups', () => {
  for (const harness of ['Claude', 'Codex', 'Pi']) {
    click(harness);
    expect(elements(tree).filter((e) => e.type === 'fieldset')).toHaveLength(5);
    expect(elements(tree).filter((e) => e.type === 'summary').map(text)).not.toContain(`Recommended ${harness} defaults`);
    expect(text(tree)).not.toContain('How Claude inherits defaults');
    expect(text(tree)).not.toContain('Stage recommended');
    expect(text(tree)).not.toContain('Configuration details');
    expect(input(`profiles.${harness.toLowerCase()}.implementation.model`).props.disabled).toBe(false);
  }
});

it('shows each harness group in its harness section', () => {
  click('Claude'); expect(input('claude.inheritMcpServers')).toBeDefined();
  click('Pi'); expect(input('pi.extensions')?.type).toBe('textarea');
});

it('guards scope changes and closing, keeps edits on request, and discards only with explicit action', async () => {
  input('profiles.claude.implementation.model').props.onChange({ target: { value: 'edited' } }); render();
  changeScope('home');
  expect(text(tree)).toContain('Discard unsaved changes?');
  expect(fetchMock).toHaveBeenCalledTimes(1);
  click('Keep editing');
  expect(input('profiles.claude.implementation.model').props.value).toBe('edited');
  click('Close'); expect(close).not.toHaveBeenCalled();
  click('Keep editing'); changeScope('home'); confirmDiscard(); await settle();
  expect(fetchMock.mock.calls.at(-1)?.[0]).toBe('/api/settings?scope=home');
  expect(button('Save changes').props.disabled).toBe(true);
  expect(button('Daemon')).toBeDefined();
});

it('previews a reset using the server fallback and sends only the removed repository override', async () => {
  const reset = elements(tree).find((e) => e.type === 'button' && e.props['aria-label'] === 'Remove repository override: Implementation model')!;
  reset.props.onClick(); render();
  expect(input('profiles.claude.implementation.model').props.value).toBe('legacy-worker');
  expect(text(tree)).not.toContain('Configuration details');
  await submit();
  const body = JSON.parse(String(fetchMock.mock.calls.find((call) => call[1]?.method === 'POST')?.[1]?.body));
  expect(body).toEqual({ scope: 'project', nodeId: 'n1', revision: 'r1', changes: { 'profiles.claude.implementation.model': null } });
});

it('retains edits across categories and saves all edited fields', async () => {
  click('Limits');
  input('limits.maxDepth').props.onChange({ target: { value: '4' } }); render();
  click('Claude');
  input('profiles.claude.implementation.model').props.onChange({ target: { value: 'sonnet' } }); render();
  expect(fetchMock).toHaveBeenCalledTimes(1);
  await submit();
  const body = JSON.parse(String(fetchMock.mock.calls.find((call) => call[1]?.method === 'POST')?.[1]?.body));
  expect(body.changes).toEqual({ 'profiles.claude.implementation.model': 'sonnet', 'limits.maxDepth': 4 });
  expect(button('Save changes').props.disabled).toBe(true);
});

it('discards custom edits, and global saves omit the repository node', async () => {
  input('profiles.claude.implementation.model').props.onChange({ target: { value: 'sonnet' } }); render();
  click('Discard changes');
  expect(input('profiles.claude.implementation.model').props.value).toBe('custom');
  changeScope('home'); await settle();
  input('profiles.claude.implementation.model').props.onChange({ target: { value: 'sonnet' } }); render();
  await submit();
  const body = JSON.parse(String(fetchMock.mock.calls.find((call) => call[1]?.method === 'POST')?.[1]?.body));
  expect(body).toEqual({ scope: 'home', revision: 'r1', changes: { 'profiles.claude.implementation.model': 'sonnet' } });
});

it('edits the Claude account in both scopes, with login state, and sends the home revision', async () => {
  const accounts = [
    { name: 'personal', projects: [], isDefault: true, loggedIn: true, email: 'me@example.com', loginCommand: 'claude auth login' },
    { name: 'work', configDir: '/c/w', projects: [], isDefault: false, loggedIn: false, loginCommand: 'CLAUDE_CONFIG_DIR=/c/w claude auth login' },
  ];
  hooks.store = { ...hooks.store, claudeAccounts: accounts } as typeof hooks.store;
  fetchMock.mockImplementationOnce(async () => ({ ok: true, json: async () => ({ ...snapshot, scope: 'home', values: { 'claude.account': 'personal' }, claudeAccount: { effective: 'personal' } }) }));
  fetchMock.mockImplementationOnce(async () => ({ ok: true, json: async () => ({ ...snapshot, homeRevision: 'h1', claudeAccount: { effective: 'work', project: '/' }, inherited: { ...snapshot.inherited, 'claude.account': { value: 'personal', source: '/home/config.json' } } }) }));
  const select = () => input('claude.account');
  const options = () => elements(select()).filter((e) => e.type === 'option').map((e) => text(e.props.children));
  changeScope('home'); await settle();
  expect(options()[0]).toBe('None');
  expect(select().props.value).toBe('personal');
  expect(text(tree)).toContain('Custom setting');
  expect(text(tree)).toContain('Root nodes outside listed projects run in personal.');
  changeScope('project'); await settle();
  // A parent folder in work's projects decides, so the empty choice is not the global default.
  expect(options()).toEqual(['No repository-specific account (work via /)', 'personal · me@example.com', 'work · not logged in']);
  expect(text(tree)).toContain('Currently from work via /.');
  expect(text(tree)).toContain('CLAUDE_CONFIG_DIR=/c/w claude auth login');
  const described = String(select().props['aria-describedby']).split(' ');
  expect(described).toEqual(['setting-claude.account-help', 'setting-claude.account-status', 'setting-claude.account-login']);
  for (const id of described) expect(elements(tree).some((e) => e.props.id === id)).toBe(true);
  select().props.onChange({ target: { value: 'personal' } }); render();
  vi.mocked(send).mockClear();
  await submit();
  const body = JSON.parse(String(fetchMock.mock.calls.find((call) => call[1]?.method === 'POST')?.[1]?.body));
  expect(body).toEqual({ scope: 'project', nodeId: 'n1', revision: 'r1', homeRevision: 'h1', changes: { 'claude.account': 'personal' } });
  expect(send).toHaveBeenCalledWith({ t: 'claudeAccounts' }); // login state and default follow the save
});

it('offers the global default when no projects entry covers the repository', async () => {
  hooks.store = { ...hooks.store, claudeAccounts: [{ name: 'personal', projects: [], isDefault: true, loggedIn: true, loginCommand: 'claude auth login' }] } as typeof hooks.store;
  fetchMock.mockImplementationOnce(async () => ({ ok: true, json: async () => ({ ...snapshot, scope: 'home', values: {} }) }));
  fetchMock.mockImplementationOnce(async () => ({ ok: true, json: async () => ({ ...snapshot, claudeAccount: { effective: 'personal' }, inherited: { 'claude.account': { value: 'personal', source: '/home/config.json' } } }) }));
  changeScope('home'); await settle(); changeScope('project'); await settle();
  expect(text(elements(input('claude.account')).find((e) => e.type === 'option')!.props.children)).toBe('Use global default (personal)');
});

it('lets the user reset an unknown claude.account from the error state', async () => {
  const error = 'claude.account in /home/config.json names "gone", which is not an account in claude.accounts; fix it before starting Claude nodes';
  hooks.store = { ...hooks.store, claudeAccounts: [{ name: 'claude.accounts', projects: [], isDefault: false, loggedIn: null, loginCommand: '', error }] } as typeof hooks.store;
  fetchMock.mockImplementationOnce(async () => ({ ok: true, json: async () => ({ ...snapshot, scope: 'home', values: { 'claude.account': 'gone' } }) }));
  changeScope('home'); await settle();
  expect(text(tree)).toContain(error);
  click('Reset to default');
  await submit();
  const body = JSON.parse(String(fetchMock.mock.calls.find((call) => call[1]?.method === 'POST')?.[1]?.body));
  expect(body.changes).toEqual({ 'claude.account': null });
});

it('offers no reset when the account list itself is invalid', async () => {
  hooks.store = { ...hooks.store, claudeAccounts: [{ name: 'claude.accounts', projects: [], isDefault: false, loggedIn: null, loginCommand: '', error: 'claude.accounts in /h is invalid: x' }] } as typeof hooks.store;
  fetchMock.mockImplementationOnce(async () => ({ ok: true, json: async () => ({ ...snapshot, scope: 'home', values: { 'claude.account': 'work' } }) }));
  changeScope('home'); await settle();
  expect(() => button('Reset to default')).toThrow();
});

// The accounts form: change a field and leave it, as a person would.
function type(field: string, value: string) { input(`claude.account-${field}`).props.onChange({ target: { value } }); render(); }
function leave(field: string) { input(`claude.account-${field}`).props.onBlur(); render(); }
const errorOf = (field: string) => { const describedBy = input(`claude.account-${field}`).props['aria-describedby']; return describedBy && text(elements(tree).find((e) => e.props.id === describedBy)); };

it('keeps multiple accounts opt-in: a statement and one button until asked, and Cancel discards the form', async () => {
  hooks.store = { ...hooks.store, claudeAccounts: [] } as typeof hooks.store;
  render();
  expect(text(tree)).toContain('If you use more than one Claude account');
  expect(input('claude.account-default')).toBeUndefined();
  expect(() => button('Save configuration')).toThrow();
  click('Set up multiple accounts');
  // The default account and one more are open at once.
  expect(input('claude.account-default').props.value).toBe('');
  expect(input('claude.account-0-name')).toBeDefined();
  expect(input('claude.account-1-name')).toBeUndefined();
  type('default', 'personal');
  click('Cancel');
  expect(input('claude.account-default')).toBeUndefined();
  click('Set up multiple accounts');
  expect(input('claude.account-default').props.value).toBe('');
});

it('sets up Claude accounts when none exist, then shows the select and every new login', async () => {
  hooks.store = { ...hooks.store, claudeAccounts: [] } as typeof hooks.store;
  // At repository scope the seed still goes to the home file, against its revision.
  changeScope('home'); await settle();
  fetchMock.mockImplementationOnce(async () => ({ ok: true, json: async () => ({ ...snapshot, homeRevision: 'h1' }) }));
  changeScope('project'); await settle();
  expect(elements(tree).some((e) => e.props.id === 'setting-claude.account')).toBe(false);
  click('Set up multiple accounts');
  expect(button('Save configuration').props.disabled).toBe(true); // the default account needs a name
  type('default', 'personal');
  dirFetch.mockImplementation(async (path) => ({ exists: path === '/c/side', directory: path === '/c/side' }));
  for (let i = 0; i < 2; i++) click('Add another account');
  type('0-name', 'wo');
  expect(input('claude.account-0-dir').props.value).toBe('~/.claude-wo'); // a real default value, not a placeholder
  type('0-name', 'work');
  expect(input('claude.account-0-dir').props.value).toBe('~/.claude-work'); // and it follows the name
  type('1-name', 'gone');
  type('2-dir', '/c/side');
  type('2-name', 'side');
  expect(input('claude.account-2-dir').props.value).toBe('/c/side'); // an edited directory stops following
  // An existing directory needs no creating: the checkbox gives way to a note.
  await vi.waitFor(() => { render(); expect(text(tree)).toContain('Directory exists'); });
  expect(input('claude.account-2-create')).toBeUndefined();
  expect(input('claude.account-0-create').props.checked).toBe(true); // missing: create, ticked by default
  expect(dirFetch).toHaveBeenCalledWith('~/.claude-work');
  elements(tree).filter((e) => e.type === 'button' && text(e.props.children) === 'Remove')[1].props.onClick(); render();
  fetchMock.mockImplementationOnce(async () => ({ ok: true, json: async () => ({ ...snapshot, scope: 'home', revision: 'h2' }) }));
  vi.mocked(send).mockClear();
  button('Save configuration').props.onClick(); render();
  await vi.waitFor(() => { render(); expect(send).toHaveBeenCalledWith({ t: 'claudeAccounts' }); });
  const post = fetchMock.mock.calls.find((call) => call[1]?.method === 'POST')!;
  expect(String(post[0])).toContain('scope=home');
  expect(JSON.parse(String(post[1]?.body))).toEqual({ scope: 'home', revision: 'h1', openedWith: [], claudeAccounts: { account: 'personal', accounts: [
    { name: 'personal' }, { name: 'work', configDir: '~/.claude-work', create: true }, { name: 'side', configDir: '/c/side', create: false },
  ] } });
  expect(text(tree)).toContain('Loading Claude accounts'); // not the form again while the list refreshes
  hooks.store = { ...hooks.store, claudeAccounts: [
    { name: 'personal', projects: [], isDefault: true, loggedIn: true, loginCommand: 'claude auth login' },
    { name: 'work', configDir: '/u/.claude-work', projects: [], isDefault: false, loggedIn: false, loginCommand: 'CLAUDE_CONFIG_DIR=/u/.claude-work claude auth login' },
    { name: 'side', configDir: '/c/side', projects: [], isDefault: false, loggedIn: false, loginCommand: 'CLAUDE_CONFIG_DIR=/c/side claude auth login' },
  ] } as typeof hooks.store;
  render();
  expect(elements(tree).some((e) => e.props.id === 'setting-claude.account')).toBe(true);
  for (const dir of ['/u/.claude-work', '/c/side']) {
    expect(text(tree)).toContain(`CLAUDE_CONFIG_DIR=${dir} claude auth login`);
    expect(elements(tree).some((e) => e.type === 'code' && text(e) === `CLAUDE_CONFIG_DIR=${dir} claude`)).toBe(true);
  }
  expect(text(tree)).toContain('workspace trust');
});

it('explains form mistakes under a field once it was changed and left, and blocks saving until they are fixed', async () => {
  hooks.store = { ...hooks.store, claudeAccounts: [] } as typeof hooks.store;
  render();
  click('Set up multiple accounts');
  const saveDisabled = () => button('Save configuration').props.disabled;
  expect(saveDisabled()).toBe(true);
  expect(errorOf('default')).toBeUndefined(); // nothing is shown for an untouched form
  type('default', 'Team A');
  expect(errorOf('default')).toBeUndefined(); // still typing
  leave('default');
  expect(errorOf('default')).toBe('Use 1-32 letters, digits, _ or -, starting with a letter or digit.');
  expect(input('claude.account-default').props['aria-invalid']).toBe(true);
  type('default', '');
  expect(errorOf('default')).toBe('Enter a name.');
  type('default', 'personal');
  expect(saveDisabled()).toBe(true); // the open row has no name yet
  type('0-name', '-work'); leave('0-name');
  expect(errorOf('0-name')).toMatch(/^Use 1-32 letters/);
  type('0-name', '');
  expect(errorOf('0-name')).toBe('Enter a name.');
  type('0-name', 'personal');
  expect(errorOf('0-name')).toBe('Another account has this name.');
  // The prefilled directory's check shows once its row's name was touched.
  dirFetch.mockImplementation(async (path) => ({ exists: path === '~/.claude-work', directory: false }));
  type('0-name', 'work');
  await vi.waitFor(() => { render(); expect(errorOf('0-dir')).toBe('This path exists but is not a directory.'); });
  expect(saveDisabled()).toBe(true);
  type('0-dir', ' '); leave('0-dir');
  expect(errorOf('0-dir')).toBe('Enter a config directory.');
  type('0-dir', '/new');
  await vi.waitFor(() => { render(); expect(dirFetch).toHaveBeenCalledWith('/new'); });
  expect(errorOf('0-dir')).toBeUndefined();
  expect(saveDisabled()).toBe(false);
  input('claude.account-0-create').props.onChange({ target: { checked: false } }); render();
  expect(errorOf('0-dir')).toMatch(/does not exist. Tick Create this directory/);
  expect(saveDisabled()).toBe(true);
});

it('ignores a late existence reply for an older directory value', async () => {
  hooks.store = { ...hooks.store, claudeAccounts: [] } as typeof hooks.store;
  render();
  const replies: Record<string, (check: unknown) => void> = {};
  dirFetch.mockImplementation((path) => new Promise((resolve) => { replies[path] = resolve; }));
  click('Set up multiple accounts');
  type('0-dir', '/a');
  await vi.waitFor(() => expect(replies['/a']).toBeDefined());
  type('0-dir', '/b');
  await vi.waitFor(() => expect(replies['/b']).toBeDefined());
  replies['/b']({ exists: true, directory: true });
  replies['/a']({ exists: true, directory: false }); // older value, answered last
  await vi.waitFor(() => { render(); expect(text(tree)).toContain('Directory exists'); });
  expect(text(tree)).not.toContain('not a directory');
});

it('shows a refused save as an error and keeps the form', async () => {
  hooks.store = { ...hooks.store, claudeAccounts: [] } as typeof hooks.store;
  render();
  click('Set up multiple accounts');
  type('default', 'personal');
  click('Remove');
  fetchMock.mockImplementationOnce(async () => ({ ok: false, status: 400, json: async () => ({ error: '/x is inside the Tiller home; choose another directory' }) }) as never);
  button('Save configuration').props.onClick();
  await vi.waitFor(() => { render(); expect(text(tree)).toContain('inside the Tiller home'); });
  expect(input('claude.account-default').props.value).toBe('personal');
});

it('closes the accounts form on a conflict and on every reload, so a stale form never saves over a newer file', async () => {
  hooks.store = { ...hooks.store, claudeAccounts: [] } as typeof hooks.store;
  render();
  click('Set up multiple accounts');
  type('default', 'personal');
  click('Remove');
  fetchMock.mockImplementationOnce(async () => ({ ok: false, status: 409, json: async () => ({ error: 'Settings changed; reload before saving' }) }) as never);
  button('Save configuration').props.onClick();
  await vi.waitFor(() => { render(); expect(text(tree)).toContain('Settings changed; reload before saving'); });
  expect(input('claude.account-default')).toBeUndefined();
  vi.mocked(send).mockClear();
  click('Reload latest settings'); await settle();
  expect(send).toHaveBeenCalledWith({ t: 'claudeAccounts' }); // the list is read again with the file
  expect(input('claude.account-default')).toBeUndefined();
  // A scope change reloads too, and closes a form opened meanwhile.
  click('Set up multiple accounts');
  changeScope('home'); await settle();
  expect(input('claude.account-default')).toBeUndefined();
});

it('offers no Configure while the account list is invalid', async () => {
  hooks.store = { ...hooks.store, claudeAccounts: [{ name: 'claude.accounts', projects: [], isDefault: false, loggedIn: null, loginCommand: '', error: 'claude.accounts in /h is invalid: x' }] } as typeof hooks.store;
  render();
  expect(() => button('Configure')).toThrow();
  expect(() => button('Set up multiple accounts')).toThrow();
});

it('configures existing accounts: names fixed, the default kept, a moved directory flagged, and an in-use removal confirmed', async () => {
  hooks.store = { ...hooks.store, claudeAccounts: [
    { name: 'personal', projects: [], isDefault: false, loggedIn: true, loginCommand: 'claude auth login' },
    { name: 'work', configDir: '/c/w', projects: ['/repo'], isDefault: true, loggedIn: true, loginCommand: 'CLAUDE_CONFIG_DIR=/c/w claude auth login' },
    { name: 'side', configDir: '/c/s', projects: [], isDefault: false, loggedIn: true, loginCommand: 'CLAUDE_CONFIG_DIR=/c/s claude auth login' },
  ], nodes: { a: { id: 'a', title: 'deploy fix', account: 'side' }, b: { id: 'b', title: 'docs', account: 'work' } } } as unknown as typeof hooks.store;
  fetchMock.mockImplementationOnce(async () => ({ ok: true, json: async () => ({ ...snapshot, scope: 'home', revision: 'h1' }) }));
  changeScope('home'); await settle();
  click('Configure');
  expect(input('claude.account-default')).toMatchObject({ props: { value: 'personal', readOnly: true } });
  expect(input('claude.account-0-name')).toMatchObject({ props: { value: 'work', readOnly: true } });
  expect(input('claude.account-0-dir').props.value).toBe('/c/w');
  expect(input('claude.account-0-create')).toBeUndefined(); // an unchanged directory is left alone
  const removes = () => elements(tree).filter((e) => e.type === 'button' && text(e.props.children) === 'Remove');
  expect(removes()[0].props.disabled).toBe(true); // work is claude.account
  expect(text(tree)).toContain('This is the default account, so it cannot be removed');
  type('0-dir', '/c/w2');
  expect(text(tree)).toContain('A new directory is a separate login: log in to work again');
  await vi.waitFor(() => { render(); expect(dirFetch).toHaveBeenCalledWith('/c/w2'); });
  expect(input('claude.account-0-create').props.checked).toBe(true);
  expect(removes().map((b) => b.props['aria-label'])).toEqual(['Remove work', 'Remove side']);
  removes()[1].props.onClick(); render(); // side, which "deploy fix" still records
  expect(text(tree)).toContain('side is used by deploy fix.');
  expect(elements(tree).find((e) => e.props.id === 'setting-claude.account-in-use')!.props.role).toBe('status');
  // Re-adding side now would bring its old projects back, so it waits for another save.
  click('Add another account');
  type('1-name', 'side'); leave('1-name');
  expect(errorOf('1-name')).toBe('Removed accounts can’t be re-added in the same save.');
  elements(tree).find((e) => e.props['aria-label'] === 'Remove side')!.props.onClick(); render();
  expect(removes()).toHaveLength(1);
  expect(button('Save configuration').props.disabled).toBe(true);
  input('claude.account-confirm').props.onChange({ target: { checked: true } }); render();
  expect(button('Save configuration').props.disabled).toBe(false);
  fetchMock.mockImplementationOnce(async () => ({ ok: true, json: async () => ({ ...snapshot, scope: 'home', revision: 'h2' }) }));
  button('Save configuration').props.onClick();
  await vi.waitFor(() => { render(); expect(fetchMock.mock.calls.some((call) => call[1]?.method === 'POST')).toBe(true); });
  // No claude.account: it has its own setting once accounts exist.
  expect(JSON.parse(String(fetchMock.mock.calls.find((call) => call[1]?.method === 'POST')![1]?.body))).toEqual({ scope: 'home', revision: 'h1', openedWith: ['personal', 'work', 'side'], claudeAccounts: { accounts: [
    { name: 'personal' }, { name: 'work', configDir: '/c/w2', create: true },
  ] } });
});

it('asks before moving the directory of an account that open nodes use, as it asks before removing one', async () => {
  hooks.store = { ...hooks.store, claudeAccounts: [
    { name: 'personal', projects: [], isDefault: false, loggedIn: true, loginCommand: 'claude auth login' },
    { name: 'work', configDir: '/c/w', projects: [], isDefault: true, loggedIn: true, loginCommand: 'CLAUDE_CONFIG_DIR=/c/w claude auth login' },
  ], nodes: { b: { id: 'b', title: 'docs', account: 'work' } } } as unknown as typeof hooks.store;
  fetchMock.mockImplementationOnce(async () => ({ ok: true, json: async () => ({ ...snapshot, scope: 'home', revision: 'h1' }) }));
  changeScope('home'); await settle();
  click('Configure');
  type('0-dir', '/c/w2'); leave('0-dir');
  expect(text(tree)).toContain('work is used by docs.');
  expect(text(tree)).toContain('run them in the new directory');
  expect(button('Save configuration').props.disabled).toBe(true);
  input('claude.account-confirm').props.onChange({ target: { checked: true } }); render();
  expect(text(tree)).toContain('Change anyway');
  expect(button('Save configuration').props.disabled).toBe(false);
});

it('retains drafts and disables saving on a revision conflict until reload', async () => {
  input('profiles.claude.implementation.model').props.onChange({ target: { value: 'sonnet' } }); render();
  fetchMock.mockImplementationOnce(async () => ({ ok: false, status: 409, json: async () => ({ error: 'File changed on disk' }) } as any));
  await submit();
  expect(text(tree)).toContain('File changed on disk');
  expect(input('profiles.claude.implementation.model').props.value).toBe('sonnet');
  expect(button('Save changes').props.disabled).toBe(true);
  click('Reload latest settings'); await settle();
  expect(input('profiles.claude.implementation.model').props.value).toBe('custom');
});


it('withholds stale profile reset and inherited previews while a legacy model draft is pending', async () => {
  click('Legacy Claude roles');
  input('roles.worker.model').props.onChange({ target: { value: 'haiku' } }); render();
  click('Claude');
  // The still-explicit profile remains accurate despite role edits.
  expect(input('profiles.claude.implementation.model').props.value).toBe('custom');
  elements(tree).find((e) => e.type === 'button' && e.props['aria-label'] === 'Remove repository override: Implementation model')!.props.onClick(); render();
  expect(input('profiles.claude.implementation.model').props.value).toBe('');
  expect(text(tree)).toContain('Preview unavailable until legacy role changes are saved.');
  expect(text(tree)).not.toContain('After save: legacy-worker');
  await submit();
  const body = JSON.parse(String(fetchMock.mock.calls.find((call) => call[1]?.method === 'POST')?.[1]?.body));
  expect(body.changes).toEqual({ 'roles.worker.model': 'haiku', 'profiles.claude.implementation.model': null });
});

it('keeps a draft across category navigation and confirms Escape before closing', () => {
  input('profiles.claude.implementation.model').props.onChange({ target: { value: 'edited' } }); render();
  click('Limits'); click('Claude');
  expect(input('profiles.claude.implementation.model').props.value).toBe('edited');
  expect(tree.type).toBe(Modal);
  expect(tree.props.onClose()).toBe(false); render();
  expect(close).not.toHaveBeenCalled();
  click('Keep editing');
  expect(input('profiles.claude.implementation.model').props.value).toBe('edited');
  click('Close'); confirmDiscard();
  expect(close).toHaveBeenCalledOnce();
  expect(fetchMock).toHaveBeenCalledTimes(1);
});

it('rejects blank model drafts locally and allows correction without losing other edits', async () => {
  input('profiles.claude.implementation.effort').props.onChange({ target: { value: 'high' } }); render();
  input('profiles.claude.implementation.model').props.onChange({ target: { value: '   ' } }); render();
  await submit();
  expect(text(tree)).toContain('enter a value or use the inherited default');
  expect(fetchMock).toHaveBeenCalledTimes(1);
  expect(input('profiles.claude.implementation.model').props.value).toBe('   ');
  input('profiles.claude.implementation.model').props.onChange({ target: { value: 'model/custom-id' } }); render();
  await submit();
  const saved = fetchMock.mock.calls.find((call) => call[1]?.method === 'POST')!;
  expect(JSON.parse(String(saved[1]?.body)).changes).toEqual({ 'profiles.claude.implementation.model': 'model/custom-id', 'profiles.claude.implementation.effort': 'high' });
});

it('retains drafts after server validation errors and retries the same revision', async () => {
  input('profiles.claude.implementation.model').props.onChange({ target: { value: 'sonnet' } }); render();
  fetchMock.mockImplementationOnce(async () => ({ ok: false, status: 400, json: async () => ({ error: 'Model unavailable for this provider' }) } as any));
  await submit();
  expect(text(tree)).toContain('Model unavailable for this provider');
  expect(input('profiles.claude.implementation.model').props.value).toBe('sonnet');
  expect(button('Save changes').props.disabled).toBe(false);
  await submit();
  const bodies = fetchMock.mock.calls.filter((call) => call[1]?.method === 'POST').map((call) => JSON.parse(String(call[1]?.body)));
  expect(bodies).toHaveLength(2);
  expect(bodies[1]).toEqual(bodies[0]);
  expect(button('Save changes').props.disabled).toBe(true);
});

it('disables scope, close, fields and save while a save request is pending', async () => {
  input('profiles.claude.implementation.model').props.onChange({ target: { value: 'sonnet' } }); render();
  let resolve!: (response: any) => void;
  fetchMock.mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
  elements(tree).find((e) => e.type === 'form')!.props.onSubmit({ preventDefault() {} }); render();
  expect(button('Please wait…').props.disabled).toBe(true);
  expect(button('Close').props.disabled).toBe(true);
  expect(elements(tree).find((e) => e.props['aria-label'] === 'Settings scope')!.props.disabled).toBe(true);
  expect(button('Discard changes').props.disabled).toBe(true);
  expect(input('profiles.claude.implementation.model').props.disabled).toBe(true);
  resolve({ ok: true, json: async () => ({ ...snapshot, revision: 'r2' }) });
  await settle();
  expect(button('Save changes').props.disabled).toBe(true);
  expect(text(tree)).toContain('Settings saved.');
});

it('retries a failed scope load and disables retry while the replacement request is pending', async () => {
  fetchMock.mockImplementationOnce(async () => ({ ok: false, status: 503, json: async () => ({ error: 'Settings temporarily unavailable' }) } as any));
  changeScope('home');
  await vi.waitFor(() => { render(); expect(text(tree)).toContain('Settings temporarily unavailable'); });
  expect(button('Save changes').props.disabled).toBe(true);
  let resolve!: (response: any) => void;
  fetchMock.mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
  click('Retry'); render();
  expect(button('Close').props.disabled).toBe(true);
  expect(elements(tree).find((e) => e.props['aria-label'] === 'Settings scope')!.props.disabled).toBe(true);
  const retry = elements(tree).find((e) => e.type === 'button' && text(e.props.children) === 'Retry');
  expect(!retry || retry.props.disabled).toBe(true);
  resolve({ ok: true, json: async () => ({ ...snapshot, scope: 'home' }) });
  await settle();
  expect(text(tree)).not.toContain('Settings temporarily unavailable');
  expect(fetchMock.mock.calls.slice(1).map((call) => call[0])).toEqual(['/api/settings?scope=home', '/api/settings?scope=home']);
});

it('allows CLI rescans only when discovery is available, connected, and idle', () => {
  click('CLI diagnostics');
  expect(button('Rescan').props.disabled).toBe(true);
  hooks.store.connected = true; render();
  expect(button('Rescan').props.disabled).toBe(true);
  hooks.store.usageSources = []; render();
  expect(button('Rescan').props.disabled).toBe(false);
  click('Rescan');
  expect(refreshUsage).toHaveBeenCalledOnce();
  hooks.store.usageScanning = true; render();
  expect(button('Scanning tools…').props.disabled).toBe(true);
  hooks.store.usageScanning = false; hooks.store.connected = false; render();
  expect(button('Rescan').props.disabled).toBe(true);
});


it('searches keys and help across categories without losing drafts when cleared or saved', async () => {
  input('profiles.claude.implementation.model').props.onChange({ target: { value: 'custom/draft' } }); render();
  search('  LIMITS.MAXDEPTH  ');
  expect(input('limits.maxDepth')).toBeDefined();
  expect(input('limits.maxChildren')).toBeUndefined();
  expect(button('Limits').props['aria-pressed']).toBe(true);
  search('cross midnight');
  expect(input('notifications.quietHours')).toBeDefined();
  expect(button('Notifications').props['aria-pressed']).toBe(true);
  search('no-such-setting-xyz');
  expect(text(tree)).toContain('No matching settings');
  expect(input('notifications.quietHours')).toBeUndefined();
  search(''); click('Claude');
  expect(input('profiles.claude.implementation.model').props.value).toBe('custom/draft');
  expect(button('Save changes').props.disabled).toBe(false);
  expect(fetchMock).toHaveBeenCalledTimes(1);
  search('limits.maxDepth');
  await submit();
  const saved = fetchMock.mock.calls.find((call) => call[1]?.method === 'POST')!;
  expect(JSON.parse(String(saved[1]?.body)).changes).toEqual({ 'profiles.claude.implementation.model': 'custom/draft' });
});

it('limits daemon search results to the global scope', async () => {
  search('daemon.maxWorking');
  expect(input('daemon.maxWorking')).toBeUndefined();
  expect(elements(tree).some((e) => e.type === 'button' && text(e.props.children) === 'Daemon')).toBe(false);
  expect(text(tree)).toContain('No matching settings');
  changeScope('home'); await settle();
  search('daemon.maxWorking');
  expect(button('Daemon').props['aria-pressed']).toBe(true);
  expect(input('daemon.maxWorking')).toBeDefined();
  changeScope('project'); await settle();
  expect(input('daemon.maxWorking')).toBeUndefined();
  expect(elements(tree).some((e) => e.type === 'button' && text(e.props.children) === 'Daemon')).toBe(false);
});

it('edits inherited controls directly and saves only the explicit customization', async () => {
  click('Limits');
  expect(input('limits.maxDepth').props.disabled).toBe(false);
  input('limits.maxDepth').props.onChange({ target: { value: '4' } }); render();
  await submit();
  const saved = fetchMock.mock.calls.find((call) => call[1]?.method === 'POST')!;
  expect(JSON.parse(String(saved[1]?.body)).changes).toEqual({ 'limits.maxDepth': 4 });
});

it('keeps completion retries disabled until a command is configured and preserves drafts when disabled again', async () => {
  click('Approvals & checks');
  expect(input('gate.retries').props.disabled).toBe(true);
  expect(input('gate.timeoutMinutes').props.disabled).toBe(true);
  input('gate.command').props.onChange({ target: { value: 'npm test' } }); render();
  expect(input('gate.retries').props.disabled).toBe(false);
  expect(input('gate.timeoutMinutes').props.disabled).toBe(false);
  input('gate.retries').props.onChange({ target: { value: '3' } }); render();
  elements(tree).find((e) => e.props['aria-label'] === 'Remove repository override: Check command')!.props.onClick(); render();
  expect(input('gate.retries').props.disabled).toBe(true);
  expect(input('gate.retries').props.value).toBe('3');
  input('gate.command').props.onChange({ target: { value: 'npm run check' } }); render();
  await submit();
  const saved = fetchMock.mock.calls.find((call) => call[1]?.method === 'POST')!;
  expect(JSON.parse(String(saved[1]?.body)).changes).toEqual({ 'gate.command': 'npm run check', 'gate.retries': 3 });
});

it('stages boolean switches as explicit overrides and preserves false in the save payload', async () => {
  click('Approvals & checks');
  expect(input('approvals.merge').props.role).toBe('switch');
  expect(input('approvals.merge').props['aria-checked']).toBe(false);
  input('approvals.merge').props.onClick(); render();
  expect(input('approvals.merge').props['aria-checked']).toBe(true);
  input('approvals.merge').props.onClick(); render();
  expect(input('approvals.merge').props['aria-checked']).toBe(false);
  expect(elements(tree).some((e) => e.props['aria-label'] === 'Remove repository override: Merge without approval')).toBe(true);
  await submit();
  const saved = fetchMock.mock.calls.find((call) => call[1]?.method === 'POST')!;
  expect(JSON.parse(String(saved[1]?.body)).changes).toEqual({ 'approvals.merge': false });
});

it('resets a saved boolean override to the inherited switch state and sends only its removal', async () => {
  fetchMock.mockImplementationOnce(async () => ({ ok: true, json: async () => ({
    ...snapshot, scope: 'home',
    values: { 'approvals.merge': true },
    entries: { 'approvals.merge': { value: true, source: '/home/config.json' } },
    inherited: { 'approvals.merge': { value: false, source: 'default' } },
  }) }));
  changeScope('home'); await settle(); click('Approvals & checks');
  expect(input('approvals.merge').props['aria-checked']).toBe(true);
  elements(tree).find((e) => e.props['aria-label'] === 'Use inherited default: Merge without approval')!.props.onClick(); render();
  expect(input('approvals.merge').props['aria-checked']).toBe(false);
  await submit();
  const saved = fetchMock.mock.calls.find((call) => call[1]?.method === 'POST')!;
  expect(JSON.parse(String(saved[1]?.body))).toEqual({ scope: 'home', revision: 'r1', changes: { 'approvals.merge': null } });
});


it('uses shared selects for scope, schema options and every harness effort', () => {
  expect(tree.type).toBe(Modal);
  expect(tree.props.label).toBe('Settings');
  expect(tree.props.restoreFocus).toBe(true);
  expect(tree.props.blockGlobalShortcuts).toBe(true);
  expect(tree.props.className).toBe('settings-dialog');
  expect(elements(tree).find((e) => e.props.id === 'settings-scope')!.type).toBe(Select);
  for (const harness of ['Claude', 'Pi', 'Codex']) {
    click(harness);
    expect(input(`profiles.${harness.toLowerCase()}.implementation.effort`).type).toBe(Select);
  }
  click('Notifications');
  expect(input('notifications.kinds.needsYou').type).toBe(Select);
});

it('guards every modal dismissal request until the draft is explicitly discarded', () => {
  input('profiles.claude.implementation.model').props.onChange({ target: { value: 'edited' } }); render();
  for (let i = 0; i < 3; i++) {
    expect(tree.props.onClose()).toBe(false); render();
    expect(close).not.toHaveBeenCalled();
  }
  click('Keep editing');
  expect(input('profiles.claude.implementation.model').props.value).toBe('edited');
  tree.props.onClose(); render(); confirmDiscard();
  expect(close).toHaveBeenCalledOnce();
});

const memoryAccounts = [
  { name: 'personal', projects: [], isDefault: true, loggedIn: true, loginCommand: 'claude auth login' },
  { name: 'work', configDir: '/c/w', projects: [], isDefault: false, loggedIn: true, loginCommand: 'x' },
];
const homeMemory = { ...snapshot, scope: 'home', homeRevision: 'h1', values: { 'claude.accounts.work.memory': false } as Record<string, unknown>, entries: { 'memory.enabled': { value: false, source: 'default' }, 'memory.maxMB': { value: 200, source: 'default' } }, inherited: { 'memory.enabled': { value: false, source: 'default' }, 'memory.maxMB': { value: 200, source: 'default' } }, memory: { on: false, source: 'default', projects: [{ path: '/repo', enabled: true }, { path: '/other', enabled: false }] } };
const sent = () => JSON.parse(String(fetchMock.mock.calls.find((call) => call[1]?.method === 'POST')![1]?.body));
const memoryHome = async (extra: Partial<SettingsSnapshot> = {}) => {
  hooks.store = { ...hooks.store, claudeAccounts: memoryAccounts } as typeof hooks.store;
  fetchMock.mockImplementationOnce(async () => ({ ok: true, json: async () => ({ ...homeMemory, ...extra }) }));
  changeScope('home'); await settle(); click('Memory');
};
const memoryProject = async (memory: SettingsSnapshot['memory'], values: Record<string, unknown> = {}) => {
  hooks.store = { ...hooks.store, claudeAccounts: memoryAccounts } as typeof hooks.store;
  fetchMock.mockImplementationOnce(async () => ({ ok: true, json: async () => ({ ...homeMemory, values: {} }) }));
  fetchMock.mockImplementationOnce(async () => ({ ok: true, json: async () => ({ ...snapshot, homeRevision: 'h1', values, memory }) }));
  changeScope('home'); await settle(); changeScope('project'); await settle(); click('Memory');
};

it('shows the Memory group at home scope: global switch, an account select, the size limit, the entries and the sidebar note', async () => {
  await memoryHome();
  expect(elements(tree).some((e) => e.type === 'button' && text(e.props.children) === 'Memory')).toBe(true);
  expect(input('memory.enabled').props.role).toBe('switch');
  expect(input('memory.enabled').props['aria-checked']).toBe(false);
  expect(input('memory.maxMB').props.min).toBe(16);
  expect(input('memory.maxMB').props.value).toBe('200');
  const work = input('claude.accounts.work.memory');
  expect(work.type).toBe(Select);
  expect(work.props.value).toBe('false');
  expect(elements(work).filter((e) => e.type === 'option').map((e) => text(e.props.children))).toEqual(['No account setting', 'On', 'Off (a ceiling: no repository setting turns it on)']);
  expect(input('claude.accounts.personal.memory').props.value).toBe('');
  expect(elements(tree).some((e) => e.props.id === 'setting-memory.project')).toBe(false);
  expect(text(tree)).toContain('The global setting is off (default).');
  expect(elements(tree).filter((e) => e.type === 'li').map(text)).toEqual(['/repo On', '/other Off']);
  expect(text(tree)).toContain('use the Memory icon in the sidebar footer.');
});

it('skips a draft for an account that disappeared, says so, and still saves the rest', async () => {
  await memoryHome();
  input('claude.accounts.work.memory').props.onChange({ target: { value: 'true' } }); render();
  input('memory.maxMB').props.onChange({ target: { value: '64' } }); render();
  hooks.store = { ...hooks.store, claudeAccounts: [memoryAccounts[0]] } as typeof hooks.store; // work was removed meanwhile
  render();
  expect(text(tree)).toContain('Not saved: work is no longer a usable Claude account. Other changes still save.');
  await submit();
  expect(sent().changes).toEqual({ 'memory.maxMB': 64 });
});

it('saves each home memory control as its own key, with removal as null', async () => {
  await memoryHome();
  input('memory.enabled').props.onClick(); render();
  input('claude.accounts.personal.memory').props.onChange({ target: { value: 'true' } }); render();
  input('claude.accounts.work.memory').props.onChange({ target: { value: '' } }); render();
  input('memory.maxMB').props.onChange({ target: { value: '64' } }); render();
  expect(text(tree)).toContain('Unsaved');
  await submit();
  expect(sent()).toEqual({ scope: 'home', revision: 'r1', homeRevision: 'h1', changes: { 'memory.enabled': true, 'claude.accounts.personal.memory': true, 'claude.accounts.work.memory': null, 'memory.maxMB': 64 } });
});

it('rejects a non-numeric size limit locally', async () => {
  await memoryHome();
  input('memory.maxMB').props.onChange({ target: { value: 'big' } }); render();
  await elements(tree).find((e) => e.type === 'form')!.props.onSubmit({ preventDefault() {} }); render();
  expect(fetchMock.mock.calls.some((call) => call[1]?.method === 'POST')).toBe(false);
  expect(text(tree)).toContain('enter a number');
});

it('offers no account selects while the account list is invalid, and says why', async () => {
  const error = 'claude.accounts in /h/config.json is invalid: duplicate account name a';
  hooks.store = { ...hooks.store, claudeAccounts: [{ name: 'claude.accounts', projects: [], isDefault: false, loggedIn: null, loginCommand: '', error }] } as typeof hooks.store;
  fetchMock.mockImplementationOnce(async () => ({ ok: true, json: async () => ({ ...homeMemory, values: {} }) }));
  changeScope('home'); await settle(); click('Memory');
  expect(elements(tree).some((e) => String(e.props.id ?? '').startsWith('setting-claude.accounts.'))).toBe(false);
  expect(text(tree)).toContain(error);
});

it('shows the repository choice and the verdict at project scope, and no home-only fields', async () => {
  await memoryProject({ on: true, source: 'memory.projects /repo in /home/config.json', account: 'work' }, { 'memory.project': true });
  const choice = input('memory.project');
  expect(choice.type).toBe(Select);
  expect(choice.props.value).toBe('true');
  expect(elements(choice).filter((e) => e.type === 'option').map((e) => text(e.props.children))).toEqual(['Inherit', 'On', 'Off']);
  expect(text(tree)).toContain('Memory is on for root nodes here (account work): memory.projects /repo in /home/config.json.');
  for (const key of ['memory.enabled', 'memory.maxMB', 'claude.accounts.work.memory']) expect(elements(tree).some((e) => e.props.id === `setting-${key}`)).toBe(false);
  expect(elements(tree).some((e) => e.type === 'li')).toBe(false);
});

it('names a repository file turning memory off as the deciding setting', async () => {
  await memoryProject({ on: false, source: 'memory.enabled in /repo/.tiller/config.json' });
  expect(input('memory.project').props.value).toBe('');
  expect(text(tree)).toContain('Memory is off for root nodes here: memory.enabled in /repo/.tiller/config.json.');
});

it('saves the repository choice with the home revision', async () => {
  await memoryProject({ on: false, source: 'default' }, { 'memory.project': false });
  input('memory.project').props.onChange({ target: { value: 'true' } }); render();
  await submit();
  expect(sent()).toEqual({ scope: 'project', nodeId: 'n1', revision: 'r1', homeRevision: 'h1', changes: { 'memory.project': true } });
});

it('saves Inherit for the repository as removal', async () => {
  await memoryProject({ on: true, source: 'x' }, { 'memory.project': true });
  input('memory.project').props.onChange({ target: { value: '' } }); render();
  await submit();
  expect(sent().changes).toEqual({ 'memory.project': null });
});

it('finds the Memory group by searching its help', async () => {
  await memoryHome();
  click('Approvals & checks');
  search('ceiling');
  expect(elements(tree).some((e) => e.props.id === 'setting-claude.accounts.work.memory')).toBe(true);
  expect(elements(tree).some((e) => e.type === 'button' && text(e.props.children) === 'Memory')).toBe(true);
});
