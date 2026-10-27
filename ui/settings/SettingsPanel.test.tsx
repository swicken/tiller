import { beforeEach, expect, it, vi } from 'vitest';
import type { ReactElement, ReactNode } from 'react';
import { elements, type Element } from '../test-tree';
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
function render() { hooks.cursor = 0; tree = SettingsPanel({ nodeId: 'n1', onClose: close }); hooks.effects.splice(0).forEach((effect) => effect()); }
async function settle() { await vi.waitFor(() => { render(); expect(elements(tree).some((e) => e.type === 'form')).toBe(true); expect(button('Close').props.disabled).toBe(false); }, { interval: 1 }); }
function text(node: ReactNode): string { return Array.isArray(node) ? node.map(text).join('') : node && typeof node === 'object' && 'props' in node ? text((node as Element).props.children) : typeof node === 'string' ? node : ''; }
function button(label: string, root: ReactNode = tree) { const match = elements(root).find((e) => e.type === 'button' && text(e.props.children) === label); if (!match) throw Error(`Missing button ${label}`); return match; }
function click(label: string, root: ReactNode = tree) { button(label, root).props.onClick(); render(); }
function confirmDiscard() { const notice = elements(tree).find((e) => e.props.role === 'alert' && text(e).includes('Discard unsaved changes?')); expect(notice).toBeDefined(); click('Discard changes', notice); }
function changeScope(scope: 'home' | 'project') { elements(tree).find((e) => e.props['aria-label'] === 'Settings scope')!.props.onChange({ target: { value: scope } }); render(); }
function search(value: string) { elements(tree).find((e) => e.props['aria-label'] === 'Search settings')!.props.onChange({ target: { value } }); render(); }
function input(id: string) { return elements(tree).find((e) => e.props.id === `setting-${id}`)!; }
async function submit() { await elements(tree).find((e) => e.type === 'form')!.props.onSubmit({ preventDefault() {} }); await settle(); }
beforeEach(async () => { hooks.store = { connected: false, usageSources: undefined, usageScanning: false }; vi.mocked(refreshUsage).mockClear(); hooks.slots = []; hooks.deps = []; hooks.effects = []; close.mockClear(); fetchMock.mockClear(); vi.stubGlobal('fetch', fetchMock); vi.stubGlobal('document', { activeElement: null }); render(); await settle(); });

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

it('points to claude.accounts instead of an empty account select', async () => {
  hooks.store = { ...hooks.store, claudeAccounts: [] } as typeof hooks.store;
  render();
  expect(elements(tree).some((e) => e.props.id === 'setting-claude.account')).toBe(false);
  expect(text(tree)).toContain('No Claude accounts are defined. Add them as claude.accounts in ~/.tiller/config.json');
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
  await vi.waitFor(() => { render(); expect(text(tree)).toContain('Settings temporarily unavailable'); }, { interval: 1 });
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
