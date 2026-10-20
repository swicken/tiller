import { spawnSync } from 'node:child_process';
import { readFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { profileDefaults, effectiveProfileEntries, configEntries, loadConfig } from './config.js';

describe('loadConfig', () => {
  let dir = '';
  afterEach(() => rmSync(dir, { recursive: true, force: true }));
  const setup = (project: string | undefined, home: string | undefined) => {
    dir = mkdtempSync(join(tmpdir(), 'tl-cfg-'));
    const cwd = join(dir, 'repo'), homeDir = join(dir, 'home');
    mkdirSync(join(cwd, '.tiller'), { recursive: true });
    mkdirSync(homeDir);
    if (project !== undefined) writeFileSync(join(cwd, '.tiller', 'config.json'), project);
    if (home !== undefined) writeFileSync(join(homeDir, 'config.json'), home);
    return { cwd, homeDir };
  };

  it('resolves each key from the project file, then the home file, then the default', () => {
    const { cwd, homeDir } = setup(
      JSON.stringify({ roles: { worker: { model: 'haiku' } }, claude: { inheritMcpServers: false }, pi: { extensions: ['npm:pi-web-access'] }, worktrees: { include: ['.env'], mergeStyle: 'squash', taskBranch: 'feat/{slug}' }, gate: { command: 'npm test' }, limits: { maxChildren: 2 }, notifications: { kinds: { done: 'silent' } } }),
      JSON.stringify({ roles: { worker: { model: 'sonnet', effort: 'high' }, orchestrator: { model: 'opus' } }, claude: { inheritMcpServers: true }, approvals: { close: 'done' }, worktrees: { isolation: 'worktree', include: ['x'], setup: ['npm ci'] }, gate: { command: 'make', retries: 5 }, daemon: { resumeMaxAgeDays: 7, digestAfterMinutes: 30, maxWorking: 4 }, limits: { maxChildren: 5, stallMinutes: 2 }, notifications: { kinds: { done: 'sound', exited: 'silent' }, quietHours: '22:00-07:00' } }),
    );
    const proj = join(cwd, '.tiller', 'config.json'), home = join(homeDir, 'config.json');
    expect(loadConfig(cwd, homeDir)).toEqual({
      profiles: {
        claude: { orchestrator: {}, implementation: {}, explorer: {}, mechanical: {}, reviewer: {} },
        codex: { orchestrator: {}, implementation: {}, explorer: {}, mechanical: {}, reviewer: {} },
        pi: { orchestrator: {}, implementation: {}, explorer: {}, mechanical: {}, reviewer: {} },
      },
      roles: { orchestrator: { model: 'opus' }, worker: { model: 'haiku', effort: 'high' } }, claude: { inheritMcpServers: false }, pi: { extensions: ['npm:pi-web-access'] }, approvals: { close: 'done', merge: false },
      worktrees: { isolation: 'worktree', branchPrefix: 'tl/', include: ['.env'], mergeStyle: 'squash', setup: ['npm ci'], teardown: [], protected: ['main', 'master'], taskBranch: 'feat/{slug}' }, // include replaces the home list whole
      gate: { command: 'npm test', retries: 5, timeoutMinutes: 10 }, // each gate key resolves on its own
      daemon: { resumeOnStart: true, resumeMaxAgeDays: 7, sessionsKeepDays: 14, digestAfterMinutes: 30, maxLiveNodes: 20, maxWorking: 4 },
      limits: { maxDepth: 3, maxChildren: 2, stallMinutes: 2, maxMessagesPer10Min: 20 },
      notifications: { kinds: { needsYou: 'sound', errored: 'silent', done: 'silent', exited: 'silent' }, treeDoneSummary: true, quietHours: '22:00-07:00' },
    });
    const sources = Object.fromEntries(Object.entries(configEntries(cwd, homeDir)).map(([k, e]) => [k, e.source]));
    expect(sources).toEqual({
      ...Object.fromEntries(Object.keys(sources).filter((k) => k.startsWith('profiles.')).map((k) => [k, 'default'])),
      'roles.orchestrator.model': home, 'roles.orchestrator.effort': 'default', 'roles.worker.model': proj, 'roles.worker.effort': home,
      'claude.inheritMcpServers': proj, 'pi.extensions': proj,
      'approvals.close': home, 'approvals.merge': 'default',
      'worktrees.isolation': home, 'worktrees.branchPrefix': 'default', 'worktrees.include': proj, 'worktrees.mergeStyle': proj, 'worktrees.setup': home, 'worktrees.teardown': 'default', 'worktrees.protected': 'default', 'worktrees.taskBranch': proj,
      'gate.command': proj, 'gate.retries': home, 'gate.timeoutMinutes': 'default',
      'daemon.resumeOnStart': 'default', 'daemon.resumeMaxAgeDays': home, 'daemon.sessionsKeepDays': 'default', 'daemon.digestAfterMinutes': home, 'daemon.maxLiveNodes': 'default', 'daemon.maxWorking': home,
      'notifications.kinds.needsYou': 'default', 'notifications.kinds.done': proj, 'notifications.kinds.errored': 'default', 'notifications.kinds.exited': home,
      'notifications.treeDoneSummary': 'default', 'notifications.quietHours': home,
      'limits.maxDepth': 'default', 'limits.maxChildren': proj, 'limits.stallMinutes': home, 'limits.maxMessagesPer10Min': 'default',
    });
    expect(configEntries(cwd, homeDir)['gate.timeoutMinutes']).toEqual({ value: 10, source: 'default' });
  });

  it('resolves profile model and effort independently and separates harnesses from legacy roles', () => {
    const { cwd, homeDir } = setup(
      JSON.stringify({ profiles: { codex: { implementation: { model: 'project-codex' } }, claude: { implementation: { effort: 'low' } } }, roles: { worker: { model: 'project-claude', effort: 'max' } } }),
      JSON.stringify({ profiles: { codex: { implementation: { model: 'home-codex', effort: 'high' }, explorer: { model: 'home-explorer' } }, claude: { implementation: { model: 'home-profile' } } } }),
    );
    const c = loadConfig(cwd, homeDir);
    expect(profileDefaults(c, 'codex', 'implementation', 'worker')).toEqual({ model: 'project-codex', effort: 'high' });
    expect(profileDefaults(c, 'codex', 'explorer', 'none')).toEqual({ model: 'home-explorer', effort: 'high' });
    expect(profileDefaults(c, 'pi', 'implementation', 'worker')).toEqual({ model: undefined, effort: undefined });
    expect(profileDefaults(c, 'claude', 'implementation', 'worker')).toEqual({ model: 'home-profile', effort: 'low' });
    expect(profileDefaults(c, 'claude', 'reviewer', 'none')).toEqual({ model: 'project-claude', effort: 'max' });
    expect(configEntries(cwd, homeDir)['profiles.codex.implementation.effort'].source).toBe(join(homeDir, 'config.json'));
  });

  it('drops unsupported Codex profile effort per field and falls back before a spawn can queue it', () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { cwd, homeDir } = setup(
      JSON.stringify({ profiles: { codex: { reviewer: { model: 'keep-model', effort: 'max' } } } }),
      JSON.stringify({ profiles: { codex: { reviewer: { effort: 'high' } }, claude: { reviewer: { effort: 'max' } } } }),
    );
    const config = loadConfig(cwd, homeDir);
    expect(config.profiles.codex.reviewer).toEqual({ model: 'keep-model', effort: 'high' });
    expect(config.profiles.claude.reviewer.effort).toBe('max');
    expect(err.mock.calls[0]?.[0]).toContain('profiles.codex.reviewer.effort: unsupported Codex effort: max');
    expect(configEntries(cwd, homeDir)['profiles.codex.reviewer.effort'].source).toBe(join(homeDir, 'config.json'));
    err.mockRestore();
  });

  it('leaves configured profiles empty, with default guardrails and no gate when there are no files', () => {
    const { cwd, homeDir } = setup(undefined, undefined);
    const c = loadConfig(cwd, homeDir);
    expect(c).toMatchObject({ roles: { orchestrator: {}, worker: {} }, approvals: { close: 'never', merge: false }, worktrees: { isolation: 'none', branchPrefix: 'tl/' }, daemon: { resumeOnStart: true, resumeMaxAgeDays: 3 }, claude: { inheritMcpServers: true }, pi: { extensions: 'all' } });
    expect(c.worktrees.include).toBeUndefined();
    expect(c.gate).toBeUndefined();
    expect(c.notifications).toEqual({ kinds: { needsYou: 'sound', errored: 'silent', done: 'banner', exited: 'silent' }, treeDoneSummary: true });
  });

  it('uses shipped global defaults in a fresh home and tl config without creating files', () => {
    const { cwd, homeDir } = setup(undefined, undefined);
    const config = loadConfig(cwd, homeDir);
    expect(profileDefaults(config, 'claude', 'orchestrator', 'orchestrator')).toEqual({ model: 'opus', effort: undefined });
    expect(profileDefaults(config, 'claude', 'implementation', 'worker')).toEqual({ model: 'sonnet', effort: undefined });
    expect(profileDefaults(config, 'claude', 'mechanical', 'worker')).toEqual({ model: 'haiku', effort: undefined });
    expect(profileDefaults(config, 'codex', 'reviewer', 'worker')).toEqual({ model: 'gpt-6.1-sol', effort: 'high' });
    expect(profileDefaults(config, 'pi', 'implementation', 'worker')).toEqual({ model: undefined, effort: undefined });
    expect(configEntries(cwd, homeDir)['profiles.claude.orchestrator.model'].value).toBeUndefined();
    expect(effectiveProfileEntries(configEntries(cwd, homeDir))['profiles.claude.orchestrator.model']).toEqual({ value: 'opus', source: 'default' });
    const cli = spawnSync(process.execPath, ['--import', 'tsx', join(import.meta.dirname, 'cli.ts'), 'config', '--cwd', cwd], { env: { ...process.env, TL_HOME: homeDir }, encoding: 'utf8' });
    expect(cli.status, cli.stderr).toBe(0);
    expect(cli.stdout).toContain('profiles.claude.orchestrator.model: opus  [default]');
    expect(cli.stdout).toContain('profiles.codex.reviewer.effort: high  [default]');
    expect(existsSync(join(homeDir, 'config.json'))).toBe(false);
    expect(existsSync(join(cwd, '.tiller', 'config.json'))).toBe(false);
  });

  it('fills missing defaults on upgrade while preserving existing profile and legacy choices and config bytes', () => {
    const project = JSON.stringify({ roles: { worker: { model: 'custom-legacy', effort: 'low' } }, profiles: { claude: { reviewer: { effort: 'max' } }, codex: { reviewer: { model: 'custom-codex' } } } });
    const global = JSON.stringify({ roles: { orchestrator: { model: 'global-legacy' } }, profiles: { claude: { implementation: { model: 'global-profile' } }, codex: { implementation: { effort: 'low' } } } });
    const { cwd, homeDir } = setup(project, global);
    const config = loadConfig(cwd, homeDir);
    expect(profileDefaults(config, 'claude', 'implementation', 'worker')).toEqual({ model: 'global-profile', effort: 'low' });
    expect(profileDefaults(config, 'claude', 'reviewer', 'worker')).toEqual({ model: 'custom-legacy', effort: 'max' });
    expect(profileDefaults(config, 'claude', 'reviewer', 'orchestrator')).toEqual({ model: 'global-legacy', effort: 'max' });
    expect(profileDefaults(config, 'codex', 'reviewer', 'worker')).toEqual({ model: 'custom-codex', effort: 'high' });
    expect(profileDefaults(config, 'codex', 'implementation', 'worker')).toEqual({ model: 'gpt-6.1-sol', effort: 'low' });
    const cli = spawnSync(process.execPath, ['--import', 'tsx', join(import.meta.dirname, 'cli.ts'), 'config', '--cwd', cwd], { env: { ...process.env, TL_HOME: homeDir }, encoding: 'utf8' });
    expect(cli.status, cli.stderr).toBe(0);
    expect(cli.stdout).toContain('profiles.codex.implementation.model: gpt-6.1-sol  [default]');
    expect(cli.stdout).toContain('profiles.claude.reviewer.model: custom-legacy');
    expect(cli.stdout).toContain('profiles.claude.implementation.model: global-profile');
    expect(readFileSync(join(homeDir, 'config.json'), 'utf8')).toBe(global);
    expect(readFileSync(join(cwd, '.tiller', 'config.json'), 'utf8')).toBe(project);
  });

  it('drops only the bad key of a file, naming it in one log line, and falls back to home for it', () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const cases: [string, string][] = [
      [JSON.stringify({ closeWithoutConfirm: 'done', limits: { maxChildren: 2 } }), 'closeWithoutConfirm: unknown key'], // an old name
      [JSON.stringify({ approvals: { close: 'sometimes' }, limits: { maxChildren: 2 } }), 'approvals.close'],
      [JSON.stringify({ claude: { inheritMcpServers: 'no' }, limits: { maxChildren: 2 } }), 'claude.inheritMcpServers'],
      [JSON.stringify({ pi: { extensions: 'some' }, limits: { maxChildren: 2 } }), 'pi.extensions'],
      [JSON.stringify({ pi: { extensions: ['npm:ok', ''] }, limits: { maxChildren: 2 } }), 'pi.extensions'],
      [JSON.stringify({ roles: { worker: { effort: 'extreme' } }, limits: { maxChildren: 2 } }), 'roles.worker.effort'],
      [JSON.stringify({ profiles: { codex: { explorer: { effort: 'extreme' } } }, limits: { maxChildren: 2 } }), 'profiles.codex.explorer.effort'],
      [JSON.stringify({ profiles: { codex: { worker: { model: 'bad-profile' } } }, limits: { maxChildren: 2 } }), 'profiles.codex.worker: unknown key'],
      [JSON.stringify({ worktrees: { isolaton: 'worktree' }, limits: { maxChildren: 2 } }), 'worktrees.isolaton: unknown key'],
      [JSON.stringify({ worktrees: { taskBranch: 'tl/task' }, limits: { maxChildren: 2 } }), 'worktrees.taskBranch: must contain {slug}'],
      [JSON.stringify({ notifications: { quietHours: '22-7' }, limits: { maxChildren: 2 } }), 'notifications.quietHours'],
      [JSON.stringify({ daemon: { maxWorking: 1 }, limits: { maxChildren: 2 } }), 'daemon: read from the home file only'],
    ];
    for (const [bad, named] of cases) {
      const { cwd, homeDir } = setup(bad, JSON.stringify({ roles: { worker: { effort: 'low' } }, approvals: { close: 'always' }, daemon: { maxWorking: 3 } }));
      err.mockClear();
      expect(loadConfig(cwd, homeDir)).toMatchObject({ roles: { worker: { effort: 'low' } }, approvals: { close: 'always' }, daemon: { maxWorking: 3 }, limits: { maxChildren: 2 } });
      loadConfig(cwd, homeDir);
      expect(err).toHaveBeenCalledTimes(1);
      expect(err.mock.calls[0]![0]).toContain(named);
      rmSync(dir, { recursive: true, force: true });
    }
    err.mockRestore();
  });

  it('skips a file that is not JSON with one log line', () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { cwd, homeDir } = setup('{not json', JSON.stringify({ approvals: { close: 'always' } }));
    expect(loadConfig(cwd, homeDir).approvals.close).toBe('always');
    loadConfig(cwd, homeDir);
    expect(err).toHaveBeenCalledTimes(1);
    err.mockRestore();
  });
});
