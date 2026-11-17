import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Role } from '../shared/protocol.js';
import { codexAdapter, piAdapter } from './harness.js';
import { claudeLaunch, launchArgs, projectMcpServerNames, promptPath, systemPrompt, terminalBundleFor, terminalLaunch, writeNodeFiles } from './launch.js';

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
  it('loads the mod and its tiller-rows plugin as separate plugin dirs', () => {
    const args = launchArgs(base);
    const dirs = args.flatMap((a, i) => a === '--plugin-dir' ? [args[i + 1]] : []);
    expect(dirs).toHaveLength(2);
    expect(dirs[1]).toBe(join(dirs[0], '../mod-rows'));
  });
});

describe('Claude account environment', () => {
  let dir = '';
  afterEach(() => { vi.unstubAllEnvs(); rmSync(dir, { recursive: true, force: true }); });
  it('sets CLAUDE_CONFIG_DIR only for a Claude launch with an account dir, never from the daemon or for other harnesses', () => {
    vi.stubEnv('CLAUDE_CONFIG_DIR', '/daemon/own');
    dir = mkdtempSync(join(tmpdir(), 'tl-acct-env-'));
    const i = { nodeId: 'n', nodeDir: join(dir, 'n'), endpoint: 'http://x', path: '', title: 't', parentId: null, home: dir, cwd: dir, sessionId: 's', sessionDir: join(dir, 's') };
    expect(claudeLaunch({ ...i, claudeConfigDir: '/acct/work' }).env.CLAUDE_CONFIG_DIR).toBe('/acct/work');
    expect(claudeLaunch(i).env).not.toHaveProperty('CLAUDE_CONFIG_DIR');
    const withDir = { ...i, claudeConfigDir: '/acct/work' };
    expect(terminalLaunch(withDir, '/bin/sh').env).not.toHaveProperty('CLAUDE_CONFIG_DIR');
    expect(piAdapter.launch(withDir).env).not.toHaveProperty('CLAUDE_CONFIG_DIR');
    expect(codexAdapter.launch(withDir).env).not.toHaveProperty('CLAUDE_CONFIG_DIR');
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
  it('describes the frame by the node id first, and what the human and tiller labels start with', () => {
    const sp = systemPrompt({ nodeId: 'n', title: 't', parentId: 'p', home: tmp(), cwd: '/nonexistent' });
    expect(sp).toContain('from: <sender>\nreply-to:');
    expect(sp).toContain('A `from:` line that starts with a node id (n-…), as in `n-620ed752 "lead"`, comes from that node, whatever its quoted title says. Messages from the human start with "human", and the tiller daemon\'s with "tiller".');
    expect(sp).not.toContain('never carry a node id');
  });
  it('puts the role text in --append-system-prompt and stays compact', () => {
    const home = tmp();
    const args = launchArgs({ nodeId: 'n', nodeDir: '/tmp/n', endpoint: 'http://x', path: '', title: 't', parentId: null, home, cwd: home, sessionId: 's' });
    const sp = args[args.indexOf('--append-system-prompt') + 1]!;
    expect(sp).toContain('You are the orchestrator for this repository');
    // Was 600; raised to 625 for the suggest_command sentence (docs/design/node-shell.md), which took it to 609, and to 740
    // for the ask_human paragraph and the orchestrator's clause about workers' questions (docs/design/human-questions.md), which took it to 726.
    // Raised to 780 for the sentence that a `from:` line ending in a node id comes from a node, which took it to 758.
    expect(sp.split(/\s+/).length).toBeLessThan(780);
  });
});

describe('questions for the human in the preamble', () => {
  const base = { nodeId: 'n', title: 't', home: '/nonexistent', cwd: '/nonexistent' };
  const ROOT = 'call ask_human as well as saying so in your reply';
  const CHILD = 'Questions about your brief go to your parent with send. Call ask_human only for what only the human can settle';

  it.each(['claude', 'pi', 'codex'] as const)('tells a root to ask when the human may not be reading, and a child to ask its parent first (%s)', (harness) => {
    const root = systemPrompt({ ...base, parentId: null, harness });
    expect(root).toContain(ROOT);
    expect(root).toContain('call withdraw_question');
    expect(root).toContain('list_questions shows your open questions');
    expect(root).not.toContain(CHILD);
    const child = systemPrompt({ ...base, parentId: 'p', harness });
    expect(child).toContain(CHILD);
    expect(child).toContain('If the human answers in chat, call withdraw_question');
    expect(child).not.toContain(ROOT);
  });

  it('survives a role override and a preset body, which replace only the role text', () => {
    const home = mkdtempSync(join(tmpdir(), 'tl-ask-'));
    try {
      mkdirSync(join(home, 'prompts'));
      writeFileSync(join(home, 'prompts', 'orchestrator.md'), 'custom orchestrator');
      const root = systemPrompt({ ...base, parentId: null, home, cwd: home });
      expect(root).toContain('# Role\ncustom orchestrator');
      expect(root).toContain(ROOT);
      expect(systemPrompt({ ...base, parentId: 'p', preset: { name: 'x', body: 'preset body', source: 'x.md' } })).toContain(CHILD);
    } finally { rmSync(home, { recursive: true, force: true }); }
  });

  it('has the default orchestrator pass a worker\'s question to the human by name, and leaves the worker prompt asking its parent', () => {
    expect(systemPrompt({ ...base, parentId: null })).toContain('a worker\'s open question that only the human can answer goes to them through ask_human, naming the worker');
    const worker = systemPrompt({ ...base, parentId: 'p' });
    expect(worker).toContain('If the brief is ambiguous, ask your parent with send rather than the human.');
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
