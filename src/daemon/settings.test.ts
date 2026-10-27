import fs from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { configEntries, loadConfig, profileDefaults } from './config.js';
import { NodeManager } from './manager.js';
import { startServer, type DaemonServer } from './server.js';
import { claudeAccounts } from './claude-accounts.js';
import { SETTINGS_FIELDS } from '../shared/settings.js';
import { switchMemory } from './memory-config.js';
import { LIMITS } from './memory-schema.js';
import { saveClaudeAccounts, settingsSnapshot, updateSettings } from './settings.js';

let root: string, home: string, project: string, manager: NodeManager, server: DaemonServer, nodeId: string;
beforeEach(async () => {
  root = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), 'tl-settings-')));
  home = join(root, 'home'); project = join(root, 'project');
  fs.mkdirSync(home); fs.mkdirSync(project);
  manager = new NodeManager({ home, shell: '/bin/sh' });
  nodeId = manager.registry.create({ parentId: null, kind: 'terminal', title: 'settings', cwd: project }).id;
  server = await startServer(manager, { port: 0 });
});
afterEach(async () => {
  vi.restoreAllMocks();
  await manager.shutdown(); await server?.close(); fs.rmSync(root, { recursive: true, force: true });
});
const snapshot = (scope: 'project' | 'home' = 'project') => settingsSnapshot(manager, scope, scope === 'project' ? nodeId : undefined);
const save = (changes: Record<string, unknown>, revision = snapshot().revision) => updateSettings(manager, { scope: 'project', nodeId, revision, changes });
const file = () => join(project, '.tiller', 'config.json');
function write(data: unknown) { fs.mkdirSync(join(project, '.tiller'), { recursive: true }); fs.writeFileSync(file(), JSON.stringify(data)); }
async function request(method = 'GET', query = '?scope=home', body?: unknown, token = fs.readFileSync(join(home, 'admin-token'), 'utf8')) {
  return fetch(`http://127.0.0.1:${server.port}/api/settings${query}`, { method, headers: { Authorization: `Bearer ${token}` }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
}

describe('settings persistence', () => {
  it('shows fresh-home Tiller defaults at both scopes without creating config files', () => {
    for (const s of [snapshot('home'), snapshot()]) {
      expect(s.values).toEqual({});
      expect(s.entries['profiles.claude.orchestrator.model']).toEqual({ value: 'opus', source: 'default' });
      expect(s.entries['profiles.claude.implementation.model']).toEqual({ value: 'sonnet', source: 'default' });
      expect(s.entries['profiles.claude.explorer.model']).toEqual({ value: 'haiku', source: 'default' });
      expect(s.entries['profiles.claude.reviewer.effort'].value).toBeUndefined();
      expect(s.entries['profiles.codex.implementation.model']).toEqual({ value: 'gpt-6.1-sol', source: 'default' });
      expect(s.entries['profiles.codex.implementation.effort']).toEqual({ value: 'medium', source: 'default' });
      expect(s.inherited['profiles.claude.implementation.model']).toEqual({ value: 'sonnet', source: 'default' });
    }
    expect(fs.existsSync(join(home, 'config.json'))).toBe(false);
    expect(fs.existsSync(file())).toBe(false);
  });

  it('applies mixed legacy edits and profile removal together, then refreshes the effective preview', () => {
    fs.writeFileSync(join(home, 'config.json'), JSON.stringify({ roles: { worker: { model: 'sonnet' } } }));
    write({ roles: { worker: { model: 'opus' } }, profiles: { claude: { implementation: { model: 'custom' } } } });
    const before = snapshot();
    expect(before.inherited['profiles.claude.implementation.model']).toEqual({ value: 'opus', source: file() });
    const saved = save({ 'profiles.claude.implementation.model': null, 'roles.worker.model': 'haiku' }, before.revision);
    expect(saved.entries['profiles.claude.implementation.model']).toEqual({ value: 'haiku', source: file() });
    expect(saved.entries['profiles.claude.explorer.model']).toEqual({ value: 'haiku', source: file() });
    expect(saved.inherited['roles.worker.model']).toEqual({ value: 'sonnet', source: join(home, 'config.json') });
    expect(profileDefaults(loadConfig(project, home), 'claude', 'implementation', 'worker')).toEqual({ model: 'haiku', effort: undefined });
  });

  it('distinguishes explicit, effective, inherited and default values and removes overrides', () => {
    fs.writeFileSync(join(home, 'config.json'), JSON.stringify({ limits: { maxDepth: 9 }, daemon: { maxWorking: 3 } }));
    write({ limits: { maxDepth: 4 }, custom: { future: ['kept'] } });
    const s = snapshot();
    expect(s.values).toEqual({ 'limits.maxDepth': 4, 'custom.future': ['kept'] });
    expect(s.entries['limits.maxDepth']).toEqual({ value: 4, source: file() });
    expect(s.inherited['limits.maxDepth']).toEqual({ value: 9, source: join(home, 'config.json') });
    expect(s.entries['daemon.maxWorking'].value).toBe(3);
    const next = save({ 'limits.maxDepth': null, 'worktrees.setup': ['touch never-executed'] });
    expect(next.entries['limits.maxDepth'].value).toBe(9);
    expect(next.values['custom.future']).toEqual(['kept']);
    expect(fs.existsSync(join(project, 'never-executed'))).toBe(false);
    expect(next.revision).not.toBe(s.revision);
  });
  it('matches runtime invalid-leaf filtering while retaining invalid explicit values for repair', () => {
    fs.writeFileSync(join(home, 'config.json'), JSON.stringify({ limits: { maxDepth: 7, maxChildren: -2 }, roles: { worker: { model: 'home-model' } } }));
    write({ limits: { maxDepth: -1, maxChildren: 4 }, roles: { worker: { effort: 'invalid' } }, custom: 'kept' });
    const s = snapshot();
    const runtime = configEntries(project, home), homeRuntime = configEntries(null, home);
    // claude.accounts is home-file JSON only, never a Settings field; memory has no Settings fields in v1.
    for (const key of Object.keys(runtime).filter(key => !key.startsWith('profiles.') && key !== 'claude.accounts' && !key.startsWith('memory.')) as (keyof typeof runtime)[]) {
      expect(s.entries[key]).toEqual(runtime[key]);
      expect(s.inherited[key]).toEqual(homeRuntime[key]);
    }
    expect(s.values['limits.maxDepth']).toBe(-1);
    expect(s.values['roles.worker.effort']).toBe('invalid');
    expect(s.entries['limits.maxDepth'].value).toBe(7);
    expect(s.inherited['limits.maxChildren'].value).toBe(8);
    save({ 'limits.maxDepth': 2 });
    expect(snapshot().values['roles.worker.effort']).toBe('invalid');
  });
  it('shows the legacy worker model for an unset Claude implementation profile and its inherited source', () => {
    fs.writeFileSync(join(home, 'config.json'), JSON.stringify({ roles: { worker: { model: 'legacy-model' } } }));
    const expected = { value: 'legacy-model', source: join(home, 'config.json') };
    expect(snapshot().entries['profiles.claude.implementation.model']).toEqual(expected);
    expect(snapshot().inherited['profiles.claude.implementation.model']).toEqual(expected);
    expect(snapshot('home').entries['profiles.claude.implementation.model']).toEqual(expected);
    expect(snapshot('home').inherited['profiles.claude.implementation.model']).toEqual(expected);
  });
  it('previews profile reset using retained same-file legacy roles at project and home scopes', () => {
    write({ roles: { worker: { model: 'project-legacy' } }, profiles: { claude: { implementation: { model: 'override' } } } });
    const before = snapshot();
    expect(before.inherited['profiles.claude.implementation.model']).toEqual({ value: 'project-legacy', source: file() });
    const after = save({ 'profiles.claude.implementation.model': null }, before.revision);
    expect(after.entries['profiles.claude.implementation.model']).toEqual(before.inherited['profiles.claude.implementation.model']);
    fs.writeFileSync(join(home, 'config.json'), JSON.stringify({ roles: { worker: { model: 'home-legacy' } }, profiles: { claude: { implementation: { model: 'home-override' } } } }));
    const homeBefore = snapshot('home');
    expect(homeBefore.inherited['profiles.claude.implementation.model']).toEqual({ value: 'home-legacy', source: join(home, 'config.json') });
    const homeAfter = updateSettings(manager, { scope: 'home', revision: homeBefore.revision, changes: { 'profiles.claude.implementation.model': null } });
    expect(homeAfter.entries['profiles.claude.implementation.model']).toEqual(homeBefore.inherited['profiles.claude.implementation.model']);
  });
  it('resolves each profile field across project/home before applying Claude legacy role fallback', () => {
    fs.writeFileSync(join(home, 'config.json'), JSON.stringify({
      profiles: { claude: { implementation: { model: 'home-profile' } }, codex: { explorer: { effort: 'max', model: 'home-codex' } } },
      roles: { worker: { model: 'home-worker', effort: 'medium' }, orchestrator: { model: 'home-orchestrator' } },
    }));
    write({ profiles: { claude: { implementation: { model: '', effort: 'high' } } }, roles: { worker: { model: 'project-worker' }, orchestrator: { effort: 'low' } } });
    const s = snapshot();
    const config = loadConfig(project, home);
    for (const harness of ['claude', 'pi', 'codex'] as const) {
      for (const profile of ['orchestrator', 'implementation', 'explorer', 'mechanical', 'reviewer'] as const) {
        const runtime = profileDefaults(config, harness, profile, profile === 'orchestrator' ? 'orchestrator' : 'worker');
        for (const leaf of ['model', 'effort'] as const) expect(s.entries[`profiles.${harness}.${profile}.${leaf}`].value).toEqual(runtime[leaf]);
      }
    }
    expect(s.entries['profiles.claude.implementation.model']).toEqual({ value: 'home-profile', source: join(home, 'config.json') });
    expect(s.entries['profiles.claude.implementation.effort']).toEqual({ value: 'high', source: file() });
    expect(s.inherited['profiles.claude.implementation.effort']).toEqual({ value: 'medium', source: join(home, 'config.json') });
    for (const profile of ['explorer', 'mechanical', 'reviewer']) {
      expect(s.entries[`profiles.claude.${profile}.model`]).toEqual({ value: 'project-worker', source: file() });
      expect(s.inherited[`profiles.claude.${profile}.model`]).toEqual({ value: 'project-worker', source: file() });
    }
    expect(s.entries['profiles.claude.orchestrator.model'].value).toBe('home-orchestrator');
    expect(s.entries['profiles.claude.orchestrator.effort'].value).toBe('low');
    expect(s.entries['profiles.codex.explorer.effort']).toEqual({ value: 'high', source: 'default' });
    expect(s.entries['profiles.codex.explorer.model'].value).toBe('home-codex');
    expect(s.entries['profiles.pi.implementation.model'].value).toBeUndefined();
    expect(s.values['profiles.claude.implementation.model']).toBe('');
    const h = snapshot('home');
    expect(h.entries['profiles.claude.reviewer.model'].value).toBe('home-worker');
    expect(h.inherited['profiles.claude.reviewer.model']).toEqual({ value: 'home-worker', source: join(home, 'config.json') });
  });
  it('rejects invalid leaves, groups, unknown keys and home-only project changes', () => {
    for (const changes of [{ 'limits.maxDepth': -1 }, { limits: {} }, { 'unknown.key': true }, { 'daemon.maxWorking': 2 }, { 'worktrees.taskBranch': 'bad' }, { 'gate.command': '' }, { 'profiles.codex.explorer.effort': 'invalid' }, { 'profiles.codex.reviewer.effort': 'max' }]) {
      expect(() => save(changes)).toThrow();
    }
    expect(fs.existsSync(file())).toBe(false);
    expect(save({ 'profiles.codex.explorer.model': 'gpt-model', 'profiles.claude.reviewer.effort': 'high' }).values['profiles.codex.explorer.model']).toBe('gpt-model');
  });
  it('resolves worktrees through manager.projectDir', () => {
    const resolve = vi.spyOn(manager, 'projectDir').mockReturnValue(project);
    expect(snapshot().path).toBe(file()); expect(resolve).toHaveBeenCalledWith(manager.registry.get(nodeId));
  });
  it('refuses malformed JSON, non-objects and malformed groups without overwriting', () => {
    for (const raw of ['{broken', 'null', '[]', '{"limits":2}']) {
      fs.mkdirSync(join(project, '.tiller'), { recursive: true }); fs.writeFileSync(file(), raw);
      expect(() => snapshot()).toThrow();
      expect(() => save({ 'limits.maxDepth': 2 }, 'old')).toThrow();
      expect(fs.readFileSync(file(), 'utf8')).toBe(raw);
    }
  });
  it('detects concurrent revisions and preserves external changes after a reload', () => {
    const old = snapshot();
    write({ custom: 17 });
    expect(() => save({ 'limits.maxDepth': 2 }, old.revision)).toThrow(/changed/);
    const first = snapshot(); save({ 'limits.maxDepth': 2 }, first.revision);
    expect(() => save({ 'limits.maxChildren': 1 }, first.revision)).toThrow(/changed/);
    expect(snapshot().values.custom).toBe(17);
  });
  it('detects an external edit during temp-file writing and cleans the temp file', () => {
    write({ custom: 'original' }); const old = snapshot();
    const original = fs.fsyncSync;
    vi.spyOn(fs, 'fsyncSync').mockImplementation(fd => { original(fd); fs.writeFileSync(file(), '{"custom":"external"}'); });
    expect(() => save({ 'limits.maxDepth': 2 }, old.revision)).toThrow(/changed/);
    expect(snapshot().values.custom).toBe('external');
    expect(fs.readdirSync(join(project, '.tiller'))).toEqual(['config.json']);
  });
  it('keeps the original intact and removes temp files after rename or write failure', () => {
    write({ custom: 'original' });
    for (const operation of ['renameSync', 'fsyncSync'] as const) {
      const spy = vi.spyOn(fs, operation).mockImplementation(() => { throw new Error('disk failure'); });
      expect(() => save({ 'limits.maxDepth': 2 })).toThrow(/disk failure/);
      spy.mockRestore();
      expect(snapshot().values).toEqual({ custom: 'original' });
      expect(fs.readdirSync(join(project, '.tiller'))).toEqual(['config.json']);
    }
  });
  it('rejects symlinked config files and .tiller directories', () => {
    const outside = join(root, 'outside'); fs.writeFileSync(outside, '{}');
    fs.mkdirSync(join(project, '.tiller')); fs.symlinkSync(outside, file());
    expect(() => snapshot()).toThrow(/Unsafe/); expect(() => save({}, 'x')).toThrow(/Unsafe/);
    fs.rmSync(join(project, '.tiller'), { recursive: true }); fs.symlinkSync(home, join(project, '.tiller'));
    expect(() => snapshot()).toThrow(/Unsafe/);
    expect(fs.readFileSync(outside, 'utf8')).toBe('{}');
  });
  it('reports read failures rather than treating them as a missing layer', () => {
    write({});
    const original = fs.openSync;
    vi.spyOn(fs, 'openSync').mockImplementation(((path: unknown, ...args: unknown[]) => {
      if (path === file()) throw Object.assign(new Error('access denied'), { code: 'EACCES' });
      return (original as Function)(path, ...args);
    }) as typeof fs.openSync);
    expect(() => snapshot()).toThrow(/access denied/);
  });
});

describe('admin HTTP API', () => {
  it('requires admin bearer and rejects node tokens even with the human header', async () => {
    expect((await request('GET', '?scope=home', undefined, '')).status).toBe(401);
    expect((await request('GET', '?scope=home', undefined, manager.tokenFor(nodeId))).status).toBe(401);
    expect((await request()).status).toBe(200);
  });
  it('validates scope and node selection and refuses arbitrary paths', async () => {
    for (const query of ['?scope=project', '?scope=bad', '?scope=home&path=/tmp/a']) expect((await request('GET', query)).status).toBe(400);
    expect((await request('GET', '?scope=project&nodeId=missing')).status).toBe(404);
    const response = await request('GET', `?scope=project&nodeId=${nodeId}`);
    expect((await response.json()).path).toBe(file());
  });
  it('allows only one simultaneous save with the same revision', async () => {
    const s = await (await request()).json();
    const posts = await Promise.all([2, 3].map(value => request('POST', '', { scope: 'home', revision: s.revision, changes: { 'daemon.maxWorking': value } })));
    expect(posts.map(r => r.status).sort()).toEqual([200, 409]);
    expect([2, 3]).toContain(snapshot('home').values['daemon.maxWorking']);
  });
  it('saves home without a node, rejects stale posts, and returns JSON errors', async () => {
    const s = await (await request()).json();
    const update = { scope: 'home', revision: s.revision, changes: { 'daemon.maxWorking': 7 } };
    expect((await request('POST', '', update)).status).toBe(200);
    expect((await request('POST', '', update)).status).toBe(409);
    expect((await request('POST', '', { ...update, path: '/tmp/config' })).status).toBe(400);
    fs.writeFileSync(join(home, 'config.json'), '{broken');
    const res = await request(); expect(res.status).toBe(422); expect((await res.json()).error).toMatch(/Malformed JSON/);
    expect((await request('DELETE', '')).status).toBe(405);
  });
});

describe('Claude account setting', () => {
  const homeFile = () => join(home, 'config.json');
  const homeJson = () => JSON.parse(fs.readFileSync(homeFile(), 'utf8'));
  const accounts = (workProjects: string[] = []) => [{ name: 'personal' }, { name: 'work', configDir: join(root, 'cw'), projects: workProjects }, { name: 'side', configDir: join(root, 'cs') }];
  const saveAccount = (scope: 'project' | 'home', value: string | null, s = snapshot(scope)) =>
    updateSettings(manager, { scope, ...(scope === 'project' ? { nodeId } : {}), revision: s.revision, homeRevision: s.homeRevision, changes: { 'claude.account': value } });

  it('home scope sets claude.account in the home file, validated against claude.accounts', () => {
    fs.writeFileSync(homeFile(), JSON.stringify({ claude: { accounts: accounts() } }));
    const s = saveAccount('home', 'work');
    expect(homeJson().claude.account).toBe('work');
    expect(s.values['claude.account']).toBe('work');
    expect(s.claudeAccount).toEqual({ effective: 'work' });
    expect(() => saveAccount('home', 'nope')).toThrow(/"nope" is not an account in claude.accounts/);
    expect(saveAccount('home', null).values).not.toHaveProperty('claude.account');
    expect(homeJson().claude).not.toHaveProperty('account');
  });

  it('project scope moves the repo between accounts in the home file and never touches the repo file', () => {
    write({ limits: { maxDepth: 2 } });
    const repoBefore = fs.readFileSync(file(), 'utf8');
    const prefix = join(root, 'elsewhere');
    fs.writeFileSync(homeFile(), JSON.stringify({ claude: { accounts: accounts([prefix]), account: 'personal' } }));
    let s = snapshot();
    expect(s.values).not.toHaveProperty('claude.account');
    expect(s.entries['claude.account']).toEqual({ value: 'personal', source: homeFile() });
    expect(s.inherited['claude.account']).toEqual({ value: 'personal', source: homeFile() });

    s = saveAccount('project', 'side');
    expect(homeJson().claude.accounts.map((a: { projects?: string[] }) => a.projects)).toEqual([undefined, [prefix], [project]]);
    expect(s.values['claude.account']).toBe('side');
    expect(s.claudeAccount).toEqual({ effective: 'side', project });
    s = saveAccount('project', 'work', s);
    expect(homeJson().claude.accounts.map((a: { projects?: string[] }) => a.projects)).toEqual([undefined, [prefix, project], []]);
    expect(s.entries['claude.account']).toEqual({ value: 'work', source: homeFile() });
    s = saveAccount('project', null, s);
    expect(homeJson().claude.accounts[1].projects).toEqual([prefix]); // only the exact entry goes; a broader one stays
    expect(s.values).not.toHaveProperty('claude.account');
    expect(s.claudeAccount).toEqual({ effective: 'personal' });
    expect(fs.readFileSync(file(), 'utf8')).toBe(repoBefore);
  });

  it('shows a broader projects entry as the source, and ignores a claude.account in the repo file', () => {
    write({ claude: { account: 'side' } });
    fs.writeFileSync(homeFile(), JSON.stringify({ claude: { accounts: accounts([root]) } }));
    const s = snapshot();
    expect(s.values).not.toHaveProperty('claude.account');
    expect(s.claudeAccount).toEqual({ effective: 'work', project: root });
  });

  it('checks a project-scope account change against the home file revision', () => {
    fs.writeFileSync(homeFile(), JSON.stringify({ claude: { accounts: accounts() } }));
    const s = snapshot();
    fs.writeFileSync(homeFile(), JSON.stringify({ claude: { accounts: accounts(), account: 'side' } })); // edited meanwhile
    expect(() => saveAccount('project', 'work', s)).toThrow(/Settings changed/);
    expect(() => updateSettings(manager, { scope: 'project', nodeId, revision: s.revision, changes: { 'claude.account': 'work' } })).toThrow(/Settings changed/);
    expect(homeJson().claude.accounts[1].projects).toEqual([]);
    expect(fs.existsSync(file())).toBe(false);
  });

  it('can remove a claude.account that names an account since deleted', () => {
    fs.writeFileSync(homeFile(), JSON.stringify({ claude: { accounts: accounts(), account: 'gone' } }));
    expect(() => saveAccount('home', 'work')).not.toThrow();
    fs.writeFileSync(homeFile(), JSON.stringify({ claude: { accounts: accounts(), account: 'gone' } }));
    expect(() => saveAccount('home', 'side', snapshot('home'))).not.toThrow(); // a valid name replaces it
    fs.writeFileSync(homeFile(), JSON.stringify({ claude: { accounts: accounts(), account: 'gone' } }));
    expect(saveAccount('home', null).values).not.toHaveProperty('claude.account');
    expect(homeJson().claude).not.toHaveProperty('account');
  });

  it('refuses any account change while the accounts config is invalid', () => {
    fs.writeFileSync(homeFile(), JSON.stringify({ claude: { accounts: [{ name: 'a' }, { name: 'a', configDir: '/x' }] } }));
    expect(() => saveAccount('project', 'a')).toThrow(/claude.accounts in .* is invalid/);
  });
});

describe('Memory settings', () => {
  const homeFile = () => join(home, 'config.json');
  const homeText = () => fs.readFileSync(homeFile(), 'utf8');
  const homeJson = () => JSON.parse(homeText());
  const accounts = () => [{ name: 'personal' }, { name: 'work', configDir: join(root, 'cw') }];
  const saveHome = (changes: Record<string, unknown>, s = snapshot('home')) => updateSettings(manager, { scope: 'home', revision: s.revision, changes });
  const saveProject = (changes: Record<string, unknown>, s = snapshot()) => updateSettings(manager, { scope: 'project', nodeId, revision: s.revision, homeRevision: s.homeRevision, changes });

  it('reports each pseudo-key and the memory verdict at both scopes', () => {
    const [personal, work] = accounts();
    fs.writeFileSync(homeFile(), JSON.stringify({ memory: { enabled: true, maxMB: 32, projects: [{ path: project, enabled: false }, { path: root, enabled: true }] }, claude: { accounts: [{ ...personal, memory: false }, { ...work, memory: true }, { name: 'plain', configDir: join(root, 'cp') }] } }));
    const h = snapshot('home');
    expect(h.values).toMatchObject({ 'memory.enabled': true, 'memory.maxMB': 32, 'claude.accounts.personal.memory': false, 'claude.accounts.work.memory': true });
    expect(h.values).not.toHaveProperty('claude.accounts.plain.memory');
    expect(h.values).not.toHaveProperty('memory.project');
    expect(h.memory).toEqual({ on: true, source: `memory.enabled in ${homeFile()}`, projects: [{ path: project, enabled: false }, { path: root, enabled: true }] });
    expect(h.entries['memory.maxMB']).toEqual({ value: 32, source: homeFile() });
    const p = snapshot();
    expect(p.values['memory.project']).toBe(false); // this repository's own entry, not the broader one for root
    expect(p.memory).toEqual({ on: false, source: `memory.projects ${project} in ${homeFile()}` });
    expect(p.values).not.toHaveProperty('claude.accounts.work.memory');
  });

  it('shows no repository value when only a broader entry decides, and names a repo file memory.enabled false', () => {
    fs.writeFileSync(homeFile(), JSON.stringify({ memory: { projects: [{ path: root, enabled: true }] } }));
    let p = snapshot();
    expect(p.values).not.toHaveProperty('memory.project');
    expect(p.memory).toEqual({ on: true, source: `memory.projects ${root} in ${homeFile()}` });
    write({ memory: { enabled: false } });
    p = snapshot();
    expect(p.memory).toEqual({ on: false, source: `memory.enabled in ${file()}` });
  });

  it('fails closed when the account list is invalid, rather than reading memory.enabled', () => {
    fs.writeFileSync(homeFile(), JSON.stringify({ memory: { enabled: true }, claude: { accounts: [{ name: 'a' }, { name: 'a', configDir: '/x' }] } }));
    expect(snapshot().memory).toEqual({ on: false, source: expect.stringMatching(/^account unknown: claude\.accounts in .* is invalid/) });
    expect(snapshot('home').memory?.on).toBe(true);
  });

  it('refuses the global switch like tl memory does when memory.projects is invalid', () => {
    fs.writeFileSync(homeFile(), JSON.stringify({ memory: { projects: 'x' } }));
    const bytes = homeText();
    expect(() => saveHome({ 'memory.enabled': true })).toThrow(expect.objectContaining({ status: 422 }));
    expect(() => switchMemory(home, {}, 'on')).toThrow(expect.objectContaining({ status: 422 }));
    expect(homeText()).toBe(bytes);
    expect(() => saveHome({ 'memory.enabled': 'yes' }, snapshot('home'))).toThrow(expect.objectContaining({ status: 400 }));
  });

  it('judges the verdict for the account root nodes here run in', () => {
    const [personal, work] = accounts();
    fs.writeFileSync(homeFile(), JSON.stringify({ memory: { enabled: true }, claude: { accounts: [{ ...personal, memory: false }, work], account: 'personal' } }));
    expect(snapshot().memory).toEqual({ on: false, source: `claude.accounts personal.memory in ${homeFile()}`, account: 'personal' });
    expect(snapshot('home').memory?.on).toBe(true); // the global value, whatever the accounts say
  });

  it('memory.project writes the exact path in the home memory.projects, and null removes it', () => {
    write({ limits: { maxDepth: 2 } });
    const repoBefore = fs.readFileSync(file(), 'utf8');
    fs.writeFileSync(homeFile(), JSON.stringify({ memory: { projects: [{ path: root, enabled: false }] } }));
    let s = saveProject({ 'memory.project': true });
    expect(homeJson().memory.projects).toEqual([{ path: root, enabled: false }, { path: project, enabled: true }]);
    expect(s.values['memory.project']).toBe(true);
    expect(s.memory).toEqual({ on: true, source: `memory.projects ${project} in ${homeFile()}` });
    s = saveProject({ 'memory.project': false }, s);
    expect(homeJson().memory.projects).toEqual([{ path: root, enabled: false }, { path: project, enabled: false }]);
    s = saveProject({ 'memory.project': null }, s);
    expect(homeJson().memory.projects).toEqual([{ path: root, enabled: false }]);
    expect(s.values).not.toHaveProperty('memory.project');
    expect(fs.readFileSync(file(), 'utf8')).toBe(repoBefore); // the repo file is never written for it
  });

  it('refuses a stale or missing homeRevision for memory.project without writing', () => {
    fs.writeFileSync(homeFile(), JSON.stringify({ custom: 1 }));
    const s = snapshot();
    fs.writeFileSync(homeFile(), JSON.stringify({ custom: 2 })); // edited meanwhile
    const bytes = homeText();
    expect(() => saveProject({ 'memory.project': true }, s)).toThrow(expect.objectContaining({ status: 409 }));
    expect(() => updateSettings(manager, { scope: 'project', nodeId, revision: s.revision, changes: { 'memory.project': true } })).toThrow(expect.objectContaining({ status: 409 }));
    expect(homeText()).toBe(bytes);
    expect(fs.existsSync(file())).toBe(false);
  });

  it('saves claude.account and memory.project in one home write', () => {
    fs.writeFileSync(homeFile(), JSON.stringify({ claude: { accounts: accounts() } }));
    const rename = vi.spyOn(fs, 'renameSync');
    saveProject({ 'claude.account': 'work', 'memory.project': true });
    expect(rename.mock.calls.filter(([, to]) => to === homeFile())).toHaveLength(1);
    expect(rename.mock.calls.filter(([, to]) => to === file())).toHaveLength(0);
    const [personal, work] = accounts();
    expect(homeJson()).toMatchObject({ claude: { accounts: [personal, { ...work, projects: [project] }] }, memory: { projects: [{ path: project, enabled: true }] } });
    expect(fs.existsSync(file())).toBe(false);
  });

  it('sets and removes an account value in the same write as other home changes', () => {
    fs.writeFileSync(homeFile(), JSON.stringify({ claude: { accounts: accounts() } }));
    let s = saveHome({ 'claude.accounts.work.memory': false, 'memory.maxMB': 64 });
    expect(homeJson().claude.accounts[1]).toEqual({ ...accounts()[1], memory: false });
    expect(homeJson().memory.maxMB).toBe(64);
    expect(s.values['claude.accounts.work.memory']).toBe(false);
    s = saveHome({ 'claude.accounts.work.memory': true }, s);
    expect(homeJson().claude.accounts[1].memory).toBe(true);
    s = saveHome({ 'claude.accounts.work.memory': null, 'memory.maxMB': null }, s);
    expect(homeJson().claude.accounts).toEqual(accounts());
    expect(homeJson().memory).toEqual({});
    expect(s.values).not.toHaveProperty('claude.accounts.work.memory');
  });

  it('refuses an unknown account with 400 and an invalid account list with 422', () => {
    fs.writeFileSync(homeFile(), JSON.stringify({ claude: { accounts: accounts() } }));
    expect(() => saveHome({ 'claude.accounts.gone.memory': true })).toThrow(expect.objectContaining({ status: 400, message: expect.stringContaining('"gone" is not configured') }));
    expect(() => saveHome({ 'claude.accounts.work.memory': 'yes' })).toThrow(expect.objectContaining({ status: 400 }));
    fs.writeFileSync(homeFile(), JSON.stringify({ claude: { accounts: [{ name: 'a' }, { name: 'a', configDir: '/x' }] } }));
    const bytes = homeText();
    expect(() => saveHome({ 'claude.accounts.a.memory': true })).toThrow(expect.objectContaining({ status: 422 }));
    expect(homeText()).toBe(bytes);
  });

  it('validates memory.maxMB against the 16 MB floor', () => {
    expect(() => saveHome({ 'memory.maxMB': 15 })).toThrow(expect.objectContaining({ status: 400 }));
    expect(fs.existsSync(homeFile())).toBe(false);
    expect(saveHome({ 'memory.maxMB': 16 }).values['memory.maxMB']).toBe(16);
    expect(SETTINGS_FIELDS.find((f) => f.key === 'memory.maxMB')?.min).toBe(LIMITS.size.minMB);
  });

  it('keeps every other memory key home-only', () => {
    fs.writeFileSync(homeFile(), JSON.stringify({ claude: { accounts: accounts() } }));
    const bytes = homeText();
    for (const key of ['memory.enabled', 'memory.maxMB', 'claude.accounts.work.memory']) expect(() => saveProject({ [key]: key === 'memory.maxMB' ? 32 : true })).toThrow(expect.objectContaining({ status: 400, message: expect.stringMatching(/home-only/) }));
    expect(() => saveHome({ 'memory.project': true })).toThrow(expect.objectContaining({ status: 400 }));
    expect(homeText()).toBe(bytes);
    expect(fs.existsSync(file())).toBe(false);
  });

  it('refuses a node bearer token on POST with 401 and leaves the file bytes unchanged', async () => {
    fs.writeFileSync(homeFile(), JSON.stringify({ claude: { accounts: accounts() } }));
    const bytes = homeText(), s = snapshot('home');
    const res = await request('POST', '', { scope: 'home', revision: s.revision, changes: { 'memory.enabled': true, 'claude.accounts.work.memory': true } }, manager.tokenFor(nodeId));
    expect(res.status).toBe(401);
    expect(homeText()).toBe(bytes);
    const repo = await request('POST', '', { scope: 'project', nodeId, revision: snapshot().revision, homeRevision: s.homeRevision, changes: { 'memory.project': true } }, manager.tokenFor(nodeId));
    expect(repo.status).toBe(401);
    expect(homeText()).toBe(bytes);
    expect(fs.existsSync(file())).toBe(false);
  });

  // M7: a Settings save writes the same bytes as the matching `tl memory` change on a copy of the home file.
  it('writes the same home file as switchMemory for each control', () => {
    const start = JSON.stringify({ custom: 1, memory: { projects: [{ path: root, enabled: false }, { path: project, enabled: false }] }, claude: { accounts: accounts() } }, null, 2) + '\n';
    const copy = join(root, 'copy');
    const cases: { target: { account?: string; project?: string }; key: string; scope: 'home' | 'project' }[] = [
      { target: {}, key: 'memory.enabled', scope: 'home' },
      { target: { account: 'work' }, key: 'claude.accounts.work.memory', scope: 'home' },
      { target: { project }, key: 'memory.project', scope: 'project' },
    ];
    for (const { target, key, scope } of cases) {
      for (const [value, setting] of [[true, 'on'], [false, 'off'], [null, 'inherit']] as const) {
        fs.writeFileSync(homeFile(), start);
        fs.rmSync(copy, { recursive: true, force: true }); fs.mkdirSync(copy);
        fs.writeFileSync(join(copy, 'config.json'), start);
        switchMemory(copy, target, setting);
        const s = snapshot(scope);
        updateSettings(manager, { scope, ...(scope === 'project' ? { nodeId } : {}), revision: s.revision, homeRevision: s.homeRevision, changes: { [key]: value } });
        expect(homeText(), `${key} ${setting}`).toBe(fs.readFileSync(join(copy, 'config.json'), 'utf8'));
      }
    }
  });
});

describe('Claude accounts form', () => {
  const homeFile = () => join(home, 'config.json');
  const homeJson = () => JSON.parse(fs.readFileSync(homeFile(), 'utf8'));
  // The names the form was opened with: by default the file's current ones, as a form opened just now would have.
  const openedNames = () => (fs.existsSync(homeFile()) ? homeJson().claude?.accounts ?? [] : []).map((a: { name: string }) => a.name);
  const seed = (accounts: { name: string; configDir?: string; create?: boolean }[], account = accounts[0].name, revision = snapshot('home').revision, openedWith = openedNames()) =>
    saveClaudeAccounts(manager, { scope: 'home', revision, openedWith, claudeAccounts: { accounts, account } });
  // After the first save the form never sends claude.account: it has its own setting.
  const configure = (accounts: Parameters<typeof seed>[0], revision = snapshot('home').revision, openedWith = openedNames()) =>
    saveClaudeAccounts(manager, { scope: 'home', revision, openedWith, claudeAccounts: { accounts } });

  it('writes the accounts and default, keeps other settings, and creates a requested directory owner-only', () => {
    fs.writeFileSync(homeFile(), JSON.stringify({ limits: { maxDepth: 3 }, claude: { inheritMcpServers: false } }));
    const existing = join(root, 'cx'); fs.mkdirSync(existing);
    const s = seed([{ name: 'personal' }, { name: 'work', configDir: join(root, 'new', 'cw'), create: true }, { name: 'side', configDir: existing }], 'personal');
    expect(homeJson()).toEqual({ limits: { maxDepth: 3 }, claude: { inheritMcpServers: false, accounts: [{ name: 'personal' }, { name: 'work', configDir: join(root, 'new', 'cw') }, { name: 'side', configDir: existing }], account: 'personal' } });
    expect(fs.statSync(join(root, 'new', 'cw')).mode & 0o777).toBe(0o700);
    expect(s.values['claude.account']).toBe('personal');
    expect(claudeAccounts(home).map((a) => a.name)).toEqual(['personal', 'work', 'side']); // the runtime accepts what was written
  });

  it('replaces a stale claude.account left without a list', () => {
    fs.writeFileSync(homeFile(), JSON.stringify({ claude: { account: 'gone' } }));
    seed([{ name: 'a' }]);
    expect(homeJson().claude).toEqual({ accounts: [{ name: 'a' }], account: 'a' });
  });

  it('refuses a symlink to ~/.claude, a directory in the Tiller home, and a file', () => {
    vi.stubEnv('HOME', root);
    try {
      fs.mkdirSync(join(root, '.claude')); fs.symlinkSync(join(root, '.claude'), join(root, 'link'));
      fs.writeFileSync(join(root, 'file'), '');
      expect(() => seed([{ name: 'a', configDir: join(root, 'link') }])).toThrow(/is Claude's default home/);
      expect(() => seed([{ name: 'a', configDir: '~/link' }])).toThrow(/is Claude's default home/);
      expect(() => seed([{ name: 'a', configDir: join(home, 'claude'), create: true }])).toThrow(/inside the Tiller home/);
      expect(() => seed([{ name: 'a', configDir: join(root, 'file'), create: true }])).toThrow(/is not a directory/);
      expect(fs.existsSync(join(home, 'claude'))).toBe(false);
      expect(fs.existsSync(homeFile())).toBe(false);
    } finally { vi.unstubAllEnvs(); }
  });

  it('refuses ~/.claude and the Tiller home spelled in another case, where the disk is case-insensitive', ({ skip }) => {
    vi.stubEnv('HOME', root);
    try {
      fs.mkdirSync(join(root, '.claude')); fs.mkdirSync(join(home, 'acct'));
      if (!fs.existsSync(join(root, '.CLAUDE'))) return skip(); // case-sensitive volume: the spelling is a different folder
      expect(() => seed([{ name: 'a', configDir: join(root, '.CLAUDE') }])).toThrow(/is Claude's default home/);
      expect(() => seed([{ name: 'a', configDir: join(root, 'HOME', 'acct') }])).toThrow(/inside the Tiller home/);
      expect(fs.existsSync(homeFile())).toBe(false);
    } finally { vi.unstubAllEnvs(); }
  });

  it('refuses a new directory under a symlink to the Tiller home or to the homedir, which would land there', () => {
    vi.stubEnv('HOME', root);
    try {
      fs.symlinkSync(home, join(root, 'tl-link')); fs.symlinkSync(root, join(root, 'up'));
      expect(() => seed([{ name: 'a', configDir: join(root, 'tl-link', 'acct'), create: true }])).toThrow(/inside the Tiller home/);
      expect(() => seed([{ name: 'a', configDir: join(root, 'up', '.claude'), create: true }])).toThrow(/is Claude's default home/); // ~/.claude does not exist yet
      expect(fs.existsSync(join(home, 'acct'))).toBe(false);
      expect(fs.existsSync(join(root, '.claude'))).toBe(false);
      expect(fs.existsSync(homeFile())).toBe(false);
    } finally { vi.unstubAllEnvs(); }
  });

  it('reconfigures by name: kept accounts keep their projects and other fields, new ones get none and their directory, the default stays', () => {
    const before = snapshot('home').revision;
    const work = join(root, 'cw'), moved = join(root, 'moved'), added = join(root, 'added');
    fs.writeFileSync(homeFile(), JSON.stringify({ limits: { maxDepth: 3 }, claude: { account: 'personal', accounts: [
      { name: 'personal', projects: ['~/p'] }, { name: 'work', configDir: work, projects: [project], memory: false, gardener: false }, { name: 'side', configDir: '~/never-created', projects: ['/s'] },
    ] } }));
    expect(() => configure([{ name: 'personal' }], before)).toThrow(/Settings changed/);
    // side keeps a directory that does not exist yet (it is only checked when new or changed); old is gone.
    configure([{ name: 'personal' }, { name: 'work', configDir: moved, create: true }, { name: 'side', configDir: join(homedir(), 'never-created') }, { name: 'new', configDir: added, create: true }]);
    expect(homeJson()).toEqual({ limits: { maxDepth: 3 }, claude: { account: 'personal', accounts: [
      { name: 'personal', projects: ['~/p'] }, { name: 'work', configDir: moved, projects: [project], memory: false, gardener: false }, { name: 'side', configDir: '~/never-created', projects: ['/s'] }, { name: 'new', configDir: added },
    ] } });
    expect([moved, added].map((d) => fs.statSync(d).mode & 0o777)).toEqual([0o700, 0o700]);
    // There is no rename: a different name is a new account, so work's repositories do not follow it.
    configure([{ name: 'personal' }, { name: 'job', configDir: moved }]);
    expect(homeJson().claude.accounts).toEqual([{ name: 'personal', projects: ['~/p'] }, { name: 'job', configDir: moved }]);
  });

  it('refuses to remove the default account, to set claude.account after setup, or to edit an invalid list', () => {
    fs.writeFileSync(homeFile(), JSON.stringify({ claude: { account: 'work', accounts: [{ name: 'personal' }, { name: 'work', configDir: join(root, 'cw') }] } }));
    expect(() => configure([{ name: 'personal' }])).toThrow(/work is the default account \(claude.account\); choose another default/);
    expect(() => seed([{ name: 'personal' }, { name: 'work', configDir: join(root, 'cw') }], 'personal')).toThrow(/change the default account with its own setting/);
    expect(() => configure([{ name: 'personal' }, { name: 'work', configDir: join(root, 'cw') }, { name: 'personal', configDir: join(root, 'x'), create: true }])).toThrow(/duplicate account name personal/);
    // Dropping a configDir would quietly move work onto ~/.claude's login (the file would also have two default homes).
    expect(() => configure([{ name: 'work' }])).toThrow(expect.objectContaining({ status: 400, message: expect.stringMatching(/work: keep a config directory/) }));
    // Once accounts exist, a claude.account naming none of them blocks saving until the file is fixed.
    fs.writeFileSync(homeFile(), JSON.stringify({ claude: { account: 'gone', accounts: [{ name: 'personal' }] } }));
    expect(() => configure([{ name: 'personal' }])).toThrow(expect.objectContaining({ status: 422, message: expect.stringMatching(/names "gone"/) }));
    fs.writeFileSync(homeFile(), JSON.stringify({ claude: { accounts: [{ name: 'a' }, { name: 'a', configDir: '/x' }] } }));
    expect(() => configure([{ name: 'a' }])).toThrow(expect.objectContaining({ status: 422 }));
    expect(fs.existsSync(join(root, 'x'))).toBe(false);
  });

  it('refuses a form opened before an account was added by hand, even with a current revision, and keeps that account', () => {
    seed([{ name: 'a' }, { name: 'b', configDir: join(root, 'cb'), create: true }], 'a');
    const json = homeJson(); json.claude.accounts.push({ name: 'c', configDir: join(root, 'cc') }); fs.writeFileSync(homeFile(), JSON.stringify(json));
    // The form still lists a and b (it loads over WebSocket); the revision is read fresh, so only the names can refuse it.
    const revision = snapshot('home').revision;
    expect(() => saveClaudeAccounts(manager, { scope: 'home', revision, openedWith: ['a', 'b'], claudeAccounts: { accounts: [{ name: 'a' }, { name: 'b', configDir: join(root, 'cb') }] } }))
      .toThrow(expect.objectContaining({ status: 409, message: 'Settings changed; reload before saving' }));
    expect(homeJson().claude.accounts.map((a: { name: string }) => a.name)).toEqual(['a', 'b', 'c']);
    // Reloaded, the form lists c and the same save goes through.
    expect(() => configure([{ name: 'a' }, { name: 'b', configDir: join(root, 'cb') }, { name: 'c', configDir: join(root, 'cc') }], revision, ['a', 'b', 'c'])).not.toThrow();
    expect(homeJson().claude.accounts.map((a: { name: string }) => a.name)).toEqual(['a', 'b', 'c']);
  });

  it('refuses invalid lists before creating anything: ~/.claude, duplicates, two default homes, bad names, missing dirs, unknown default', () => {
    const dir = join(root, 'never');
    const cases: [Parameters<typeof seed>[0], string | undefined, RegExp][] = [
      [[{ name: 'a' }, { name: 'b', configDir: '~/.claude', create: true }, { name: 'c', configDir: dir, create: true }], 'a', /omit configDir for Claude's default home/],
      [[{ name: 'a', configDir: dir, create: true }, { name: 'a', configDir: join(root, 'x'), create: true }], 'a', /duplicate account name a/],
      [[{ name: 'a' }, { name: 'b' }, { name: 'c', configDir: dir, create: true }], undefined, /at most one account may omit configDir/],
      [[{ name: '' }, { name: 'c', configDir: dir, create: true }], undefined, /a name is 1-32/],
      [[{ name: 'a', configDir: join(root, 'missing') }], undefined, /does not exist; choose to create it/],
      [[{ name: 'a' }, { name: 'c', configDir: dir, create: true }], 'b', /"b" is not one of the accounts/],
    ];
    for (const [accounts, account, error] of cases) expect(() => seed(accounts, account)).toThrow(error);
    expect(fs.existsSync(dir)).toBe(false);
    expect(fs.existsSync(homeFile())).toBe(false);
  });

  it('is admin-only over HTTP, home-only, and a project file still cannot set accounts', async () => {
    const body = { scope: 'home', revision: snapshot('home').revision, openedWith: [], claudeAccounts: { accounts: [{ name: 'a' }], account: 'a' } };
    expect((await request('POST', '', body, manager.tokenFor(nodeId))).status).toBe(401);
    expect((await request('POST', '', { ...body, scope: 'project', nodeId })).status).toBe(400);
    // One body is either a seed or a settings change, never both; the default account is required.
    for (const bad of [{ ...body, changes: { 'daemon.maxWorking': 2 } }, { ...body, extra: 1 }, { ...body, claudeAccounts: { accounts: body.claudeAccounts.accounts } }]) expect((await request('POST', '', bad)).status).toBe(400);
    expect(fs.existsSync(homeFile())).toBe(false);
    expect((await request('POST', '', body)).status).toBe(200);
    expect((await request('POST', '', body)).status).toBe(409); // stale revision
    write({ claude: { accounts: [{ name: 'repo' }], account: 'repo' } });
    expect(loadConfig(project, home).claude).toMatchObject({ accounts: [{ name: 'a' }], account: 'a' });
  });

  it('checks a prospective config directory for the form: admin-only, ~/ expanded, never creating anything', async () => {
    vi.stubEnv('HOME', root);
    try {
      fs.mkdirSync(join(root, 'existing')); fs.writeFileSync(join(root, 'file'), ''); fs.mkdirSync(join(root, '.claude'));
      const check = async (path: string, token?: string) => {
        const res = await request('GET', `?${new URLSearchParams({ claudeConfigDir: path })}`, undefined, token);
        return res.status === 200 ? res.json() : res.status;
      };
      expect(await check('~/existing', manager.tokenFor(nodeId))).toBe(401);
      expect(await check('~/existing')).toEqual({ exists: true, directory: true });
      expect(await check('~/file')).toEqual({ exists: true, directory: false });
      expect(await check('~/missing/deeper')).toEqual({ exists: false, directory: false });
      expect(fs.existsSync(join(root, 'missing'))).toBe(false);
      expect((await check('~/.claude')).error).toMatch(/Claude's default home/);
      expect((await check(join(home, 'x'))).error).toMatch(/inside the Tiller home/);
      expect((await check('relative')).error).toMatch(/absolute path or one starting with ~\//);
      expect((await request('GET', '?claudeConfigDir=%2Fx&scope=home')).status).toBe(400); // strict: one query or the other
    } finally { vi.unstubAllEnvs(); }
  });
});
