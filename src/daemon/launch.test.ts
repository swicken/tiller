import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Role } from '../shared/protocol.js';
import { launchArgs, projectMcpServerNames, promptPath, systemPrompt, terminalBundleFor, writeNodeFiles } from './launch.js';

describe('terminalBundleFor', () => {
  it('maps known TERM_PROGRAM values', () => {
    expect(terminalBundleFor('ghostty')).toBe('com.mitchellh.ghostty');
    expect(terminalBundleFor('iTerm.app')).toBe('com.googlecode.iterm2');
    expect(terminalBundleFor('WezTerm')).toBe('com.github.wez.wezterm');
  });
  it('returns undefined for unknown or missing values', () => {
    expect(terminalBundleFor('xterm')).toBeUndefined();
    expect(terminalBundleFor(undefined)).toBeUndefined();
  });
});

describe('launchArgs', () => {
  const base = { nodeId: 'n', nodeDir: '/tmp/n', endpoint: 'http://x', path: '', title: 't', parentId: null, home: '/nonexistent', cwd: '/nonexistent', sessionId: 's' };
  it('passes the permission mode only when set', () => {
    const i = launchArgs({ ...base, permissionMode: 'auto' }).indexOf('--permission-mode');
    expect(launchArgs({ ...base, permissionMode: 'auto' }).slice(i, i + 2)).toEqual(['--permission-mode', 'auto']);
    expect(launchArgs(base)).not.toContain('--permission-mode');
  });
  it('passes --strict-mcp-config only when inheritMcpServers is false, and always the node mcp.json', () => {
    expect(launchArgs({ ...base, inheritMcpServers: false })).toContain('--strict-mcp-config');
    expect(launchArgs({ ...base, inheritMcpServers: true })).not.toContain('--strict-mcp-config');
    expect(launchArgs(base)).not.toContain('--strict-mcp-config');
    expect(launchArgs(base)).toContain('/tmp/n/mcp.json');
  });
});

describe('role prompts', () => {
  const dirs: string[] = [];
  const tmp = () => { const d = mkdtempSync(join(tmpdir(), 'tl-roles-')); dirs.push(d); return d; };
  afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
  const prompt = (home: string, cwd: string, parentId: string | null, role?: Role) => systemPrompt({ nodeId: 'n', title: 't', parentId, home, cwd, role });

  it('picks orchestrator for a root, worker for a child, and honours an explicit role', () => {
    const home = tmp();
    expect(prompt(home, home, null)).toContain('You are the orchestrator');
    expect(prompt(home, home, 'p')).toContain('You are a worker');
    expect(prompt(home, home, 'p', 'orchestrator')).toContain('You are the orchestrator');
    expect(prompt(home, home, null, 'none')).not.toContain('# Role');
  });
  it('uses the built-in default until the user creates a home override, and writes no file', () => {
    const home = tmp();
    expect(promptPath(home, home, 'worker').path).toBeUndefined();
    expect(prompt(home, home, 'p')).toContain('You are a worker');
    mkdirSync(join(home, 'prompts'));
    writeFileSync(join(home, 'prompts', 'worker.md'), 'custom');
    expect(promptPath(home, home, 'worker')).toEqual({ path: join(home, 'prompts', 'worker.md'), override: false });
    expect(prompt(home, home, 'p')).toContain('# Role\ncustom'); // read fresh, not cached
  });
  it('lets a repo override beat the home file', () => {
    const home = tmp(), repo = tmp();
    mkdirSync(join(repo, '.tiller'));
    writeFileSync(join(repo, '.tiller', 'worker.md'), 'repo worker');
    expect(prompt(home, repo, 'p')).toContain('repo worker');
    expect(promptPath(home, repo, 'worker').override).toBe(true);
    expect(prompt(home, repo, null)).toContain('You are the orchestrator'); // no override for that role
  });
  it('tells only a node with a parent to report_outcome', () => {
    const home = tmp();
    expect(prompt(home, home, 'p')).toContain('call report_outcome');
    expect(prompt(home, home, null)).not.toContain('call report_outcome');
  });
  it('keeps the external-changes rule in the preamble even when a preset replaces the role', () => {
    const home = tmp();
    const preset = { name: 'x', body: 'preset body', source: 'x.md' };
    const sp = systemPrompt({ nodeId: 'n', title: 't', parentId: 'p', home, cwd: home, preset });
    expect(sp).toContain('# Role\npreset body');
    expect(sp).toContain('Never run anything that changes infrastructure');
    expect(sp).toContain('ask your parent with send');
    expect(prompt(home, home, null)).toContain('stop and ask the human first');
  });
  it('puts the role text in --append-system-prompt and stays compact', () => {
    const home = tmp();
    const args = launchArgs({ nodeId: 'n', nodeDir: '/tmp/n', endpoint: 'http://x', path: '', title: 't', parentId: null, home, cwd: home, sessionId: 's' });
    const sp = args[args.indexOf('--append-system-prompt') + 1]!;
    expect(sp).toContain('You are the orchestrator for this repository');
    expect(sp.split(/\s+/).length).toBeLessThan(600);
  });
});

describe('task profile prompts', () => {
  const base = { nodeId: 'n', title: 't', parentId: 'p', home: '/nonexistent', cwd: '/nonexistent' };
  it('adds portable task guidance independently of coordination role and honors none', () => {
    expect(systemPrompt(base)).toContain('Implement the assigned change');
    expect(systemPrompt({ ...base, parentId: null })).toContain('Coordinate the task');
    expect(systemPrompt({ ...base, role: 'orchestrator' })).toContain('Coordinate the task');
    expect(systemPrompt({ ...base, parentId: null, role: 'worker' })).toContain('Implement the assigned change');
    expect(systemPrompt({ ...base, profile: 'mechanical' })).toContain('narrowly specified mechanical task');
    for (const profile of ['reviewer', 'explorer'] as const) {
      const prompt = systemPrompt({ ...base, profile });
      expect(prompt).toContain('read-only');
      expect(prompt).toContain('You are a worker');
      expect(prompt).not.toContain('disallowedTools');
      expect(systemPrompt({ ...base, role: 'none', profile })).not.toContain('# Task profile');
    }
  });
  it('preserves a preset body replacing default task and role guidance', () => {
    const p = systemPrompt({ ...base, profile: 'reviewer', preset: { name: 'custom', body: 'Custom behavior', source: 'x' } });
    expect(p).toContain('Custom behavior');
    expect(p).not.toContain('Review the supplied change');
  });
});

it('retains enforced reviewer preset guidance for Claude and Pi and uses the portable review profile for Codex', () => {
  const base = { nodeId: 'n', title: 't', parentId: null, home: '/nonexistent', cwd: '/nonexistent' };
  for (const harness of ['claude', 'codex', 'pi'] as const) {
    const prompt = systemPrompt({ ...base, harness });
    expect(prompt).toContain(harness !== 'codex' ? 'spawn a node with preset "reviewer"' : 'spawn a node with profile "reviewer"');
    expect(prompt).not.toContain(harness !== 'codex' ? 'spawn a node with profile "reviewer"' : 'spawn a node with preset "reviewer"');
  }
});

describe('project MCP servers in a node\'s settings', () => {
  const dirs: string[] = [];
  const tmp = () => { const d = mkdtempSync(join(tmpdir(), 'tl-mcp-')); dirs.push(d); return d; };
  afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
  const settings = (dir: string, disabledMcpServers?: string[]) => {
    writeNodeFiles(dir, { nodeId: 'n', endpoint: 'http://x', token: 't', disabledMcpServers });
    return JSON.parse(readFileSync(join(dir, 'settings.json'), 'utf8'));
  };

  it('lists the servers of a .mcp.json in the directory or above it, and writes them as disabledMcpjsonServers', () => {
    const repo = tmp();
    mkdirSync(join(repo, 'sub'));
    writeFileSync(join(repo, '.mcp.json'), JSON.stringify({ mcpServers: { echo: {}, other: {} } }));
    expect(projectMcpServerNames([join(repo, 'sub')])).toEqual(['echo', 'other']);
    expect(settings(tmp(), ['echo', 'other']).disabledMcpjsonServers).toEqual(['echo', 'other']);
  });
  it('writes nothing when there are no servers', () => {
    expect(settings(tmp(), undefined)).not.toHaveProperty('disabledMcpjsonServers');
    expect(settings(tmp(), [])).not.toHaveProperty('disabledMcpjsonServers');
  });
  it('ignores a missing or malformed .mcp.json', () => {
    const repo = tmp();
    expect(projectMcpServerNames([repo])).toEqual([]);
    writeFileSync(join(repo, '.mcp.json'), '{not json');
    expect(projectMcpServerNames([repo])).toEqual([]);
    writeFileSync(join(repo, '.mcp.json'), JSON.stringify({ mcpServers: 'nope' }));
    expect(projectMcpServerNames([repo])).toEqual([]);
  });
});
