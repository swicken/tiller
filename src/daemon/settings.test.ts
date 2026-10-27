import fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { configEntries, loadConfig, profileDefaults } from './config.js';
import { NodeManager } from './manager.js';
import { startServer, type DaemonServer } from './server.js';
import { settingsSnapshot, updateSettings } from './settings.js';

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
    // claude.accounts is home-file JSON only, never a Settings field.
    for (const key of Object.keys(runtime).filter(key => !key.startsWith('profiles.') && key !== 'claude.accounts') as (keyof typeof runtime)[]) {
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
  it('refuses a project save while the inherited home file is malformed', () => {
    write({ limits: { maxDepth: 3 } });
    const s = snapshot();
    fs.writeFileSync(join(home, 'config.json'), '{broken');
    expect(() => save({ 'limits.maxDepth': 2 }, s.revision)).toThrow(/Malformed JSON/);
    expect(JSON.parse(fs.readFileSync(file(), 'utf8'))).toEqual({ limits: { maxDepth: 3 } });
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
