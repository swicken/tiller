import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { adapterFor, claudeAdapter, codexAdapter, piAdapter, piToolName } from './harness.js';
import { DEFAULT_PRESETS, parsePreset } from './presets.js';
import { claudeLaunch, type LaunchInput } from './launch.js';
import { NodeManager } from './manager.js';
import { startServer, type DaemonServer } from './server.js';
import { deliver, HUMAN, messageStatus } from './messaging.js';
import { setProjectTrust, tillerTrusts } from './trust.js';
import { findArchived } from './archive.js';

let home: string;
let manager: NodeManager | undefined;
let server: DaemonServer | undefined;
beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'tl-harness-')); });
afterEach(async () => { await manager?.shutdown(); await server?.close(); manager = undefined; server = undefined; vi.unstubAllEnvs(); rmSync(home, { recursive: true, force: true }); });
const input = (): LaunchInput => ({ nodeId: 'n-test', nodeDir: join(home, 'nodes', 'n-test'), endpoint: 'http://127.0.0.1:1', path: '/usr/bin:/bin', title: 'test', parentId: null, home, cwd: home, sessionId: 'session-1', sessionDir: join(home, 'sessions', 'root') });

describe('harness boundary', () => {
  it('preserves the Claude command line and resolves legacy records', () => {
    expect(adapterFor({ kind: 'claude' })).toBe(claudeAdapter);
    expect(claudeAdapter.launch(input())).toEqual(claudeLaunch(input()));
    expect(adapterFor({ kind: 'agent', harness: 'pi' })).toBe(piAdapter);
  });
  it('launches interactive Pi with a persistent session, extension, role prompt and node identity', () => {
    const i = { ...input(), model: 'openai/test', effort: 'high', prompt: '-task' };
    const spec = piAdapter.launch(i);
    expect(spec.file).toBe('pi');
    expect(spec.args).toContain('--thinking');
    expect(spec.args).not.toContain('--permission-mode');
    expect(spec.args).not.toContain('--worktree');
    expect(spec.args.slice(-2)).toEqual(['--', '-task']);
    expect(spec.args[spec.args.indexOf('--session') + 1]).toBe(join(i.sessionDir!, 'agents', i.nodeId, 'session-1.jsonl'));
    expect(spec.env).toMatchObject({ TL_NODE_ID: i.nodeId, TL_SESSION_ID: i.sessionId, TL_HARNESS: 'pi', TL_TOKEN_FILE: join(i.nodeDir, 'token') });
    expect(spec.args[spec.args.indexOf('--append-system-prompt') + 1]).toContain('You are the orchestrator');
  });
  it('fails closed on unsupported restrictions and forking', () => {
    expect(() => piAdapter.launch({ ...input(), permissionMode: 'plan' })).toThrow(/permissionMode/);
    expect(() => piAdapter.validate({ preset: { maxTurns: 1 } })).toThrow(/maxTurns/);
    for (const preset of [{ tools: ['Read', 'WebSearch'] }, { disallowedTools: ['Bash(rm *)'] }, { tools: ['mcp__context7'] }, { disallowedTools: ['constructor'] }]) {
      expect(() => piAdapter.validate({ preset })).toThrow(/Pi has no equivalent of preset tool/);
    }
    expect(() => piAdapter.launch({ ...input(), forkSession: 'old' })).toThrow(/forking/);
  });
  it('translates Claude tool names to Pi tools, mapping tiller\'s MCP tools to the adapter\'s server name', () => {
    expect(['Read', 'Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'Bash', 'Grep', 'Glob', 'LS'].map(piToolName))
      .toEqual(['read', 'write', 'edit', 'edit', 'edit', 'bash', 'grep', 'find', 'ls']);
    expect(piToolName('mcp__tiller')).toBe('mcp__tl_*');
    expect(piToolName('mcp__tiller__spawn')).toBe('mcp__tl_*__spawn');
  });
  it('passes preset tools as --tools, always keeping tiller\'s MCP tools, and disallowedTools as --exclude-tools', () => {
    const arg = (args: string[], flag: string) => args.includes(flag) ? args[args.indexOf(flag) + 1] : undefined;
    const reviewer = piAdapter.launch({ ...input(), preset: parsePreset(DEFAULT_PRESETS.reviewer, 'reviewer.md') }).args;
    expect(arg(reviewer, '--exclude-tools')).toBe('edit,write');
    expect(reviewer).toContain('--no-extensions'); // with pi.extensions unset ("all")
    // A listed package is not loaded either: this path has no pi, so consulting pi list would throw.
    expect(piAdapter.launch({ ...input(), piExtensions: ['npm:web'], preset: { name: 'p', body: '', source: 'p.md', disallowedTools: ['Write'] } }).args).toContain('--no-extensions');
    expect(arg(reviewer, '--tools')).toBeUndefined();
    const allow = piAdapter.launch({ ...input(), preset: { name: 'p', body: '', source: 'p.md', tools: ['Read', 'Grep', 'mcp__tiller__send'] } }).args;
    expect(arg(allow, '--tools')).toBe('read,grep,mcp__tl_*__send,mcp__tl_*');
    expect(arg(allow, '--exclude-tools')).toBeUndefined();
    expect(allow).toContain('--no-extensions');
    expect(piAdapter.launch(input()).args.some((a) => a === '--tools' || a === '--exclude-tools' || a === '--no-extensions')).toBe(false);
    expect(piAdapter.launch({ ...input(), preset: { name: 'p', body: 'prompt only', source: 'p.md' } }).args).not.toContain('--no-extensions');
  });
  it('loads the user\'s Pi extensions for "all", only tiller\'s and the needed built-ins for "none", and listed packages by install path', () => {
    const bin = join(home, 'bin'); mkdirSync(bin);
    writeFileSync(join(bin, 'pi'), `#!/bin/sh
[ "$1" = list ] || exit 2
printf 'User packages:\\n  npm:web\\n    /pkgs/web\\n  npm:gone\\n  npm:filt (filtered)\\n    /pkgs/filt\\n\\nProject packages:\\n  npm:web\\n    /project/web\\n'
`);
    chmodSync(join(bin, 'pi'), 0o755);
    const launch = (piExtensions: LaunchInput['piExtensions']) => piAdapter.launch({ ...input(), path: `${bin}:/usr/bin:/bin`, piExtensions }).args;
    const extensions = (args: string[]) => args.flatMap((a, n) => args[n - 1] === '--extension' ? [a] : []);
    for (const all of [undefined, 'all'] as const) {
      expect(launch(all)).not.toContain('--no-extensions');
      expect(extensions(launch(all))).toHaveLength(1); // tiller's adapter only; Pi adds what its settings configure
    }
    const builtins = ['builtin:mcp', 'builtin:codemode', 'builtin:tool-search'];
    for (const none of ['none', []] satisfies LaunchInput['piExtensions'][]) {
      expect(launch(none)).toContain('--no-extensions');
      expect(extensions(launch(none)).slice(0, -1)).toEqual(builtins);
    }
    expect(extensions(launch(['npm:web'])).slice(0, -1)).toEqual([...builtins, '/project/web']); // the project entry replaces the user's
    expect(() => launch(['npm:gone'])).toThrow('pi.extensions lists npm:gone, which is not an installed Pi package');
    expect(() => launch(['npm:missing'])).toThrow('pi.extensions lists npm:missing, which is not an installed Pi package');
    expect(() => launch(['npm:filt'])).toThrow(/has filters/);
  });
  it('preserves independent launch effort validation for Codex and Pi', () => {
    for (const effort of ['low', 'medium', 'high', 'xhigh'] as const) {
      const spec = codexAdapter.launch({ ...input(), effort });
      expect(JSON.parse(spec.args.at(-1)!).effort).toBe(effort);
    }
    expect(() => codexAdapter.launch({ ...input(), effort: 'max' })).toThrow('unsupported Codex effort: max');
    expect(piAdapter.launch({ ...input(), effort: 'max' }).args).toContain('max');
  });
  it('uses an archived session path when resuming', () => {
    const i = { ...input(), resume: true, transcriptPath: join(home, 'old', 'session.jsonl') };
    expect(piAdapter.launch(i).args.slice(0, 2)).toEqual(['--session', i.transcriptPath]);
  });
});

// A fake Pi CLI loads the REAL extension and uses the REAL daemon HTTP API, but never calls a model.
// This checks launch env, lifecycle/status, MCP config/auth, inbox receipts and persisted sessions together.
function fakePi(): string {
  const bin = join(home, 'bin'); mkdirSync(bin);
  const extension = fileURLToPath(new URL('../../adapters/pi/index.ts', import.meta.url));
  writeFileSync(join(bin, 'pi'), `#!${process.execPath} --experimental-transform-types
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import extension from ${JSON.stringify(extension)};
const args = process.argv.slice(2), path = args[args.indexOf('--session') + 1];
if (!existsSync(path)) writeFileSync(path, JSON.stringify({ type: 'session', id: 'pi-native-id', version: 3, cwd: process.cwd() }) + '\\n');
// Native Pi opens --session using the header cwd, not the process launch cwd.
process.chdir(JSON.parse(readFileSync(path, 'utf8').split('\\n')[0]).cwd);
process.stdout.write('\\r\\n'.repeat(100));
const handlers = new Map(); let busy = false, index = 0;
const selected = args.includes('--model') ? args[args.indexOf('--model') + 1] : 'fake-pi';
const model = process.env.TL_TEST_PI_NO_MODEL ? undefined : { id: selected.slice(selected.indexOf('/') + 1) };
const ctx = { isIdle: () => !busy, abort: () => { busy = false; }, shutdown: () => process.exit(1), model,
 sessionManager: { getSessionId: () => 'pi-native-id', getSessionFile: () => path, getEntries: () => [] },
 ui: { notify() {} } };
const emit = async (name, event = {}) => { for (const fn of handlers.get(name) ?? []) await fn(event, ctx); };
const pi = { on(name, fn) { handlers.set(name, [...(handlers.get(name) ?? []), fn]); return () => {}; },
 registerMcpServer(name, config) { console.log('MCP_READY ' + JSON.stringify({name, url: config.url, node: config.headers['X-TL-Node']})); },
 unregisterMcpServer() {}, sendUserMessage(text) { busy = true; void run(text); } };
async function run(text) {
 await emit('before_agent_start', { messageType: 'user', prompt: text }); await emit('agent_start');
 const user = 'u' + ++index; appendFileSync(path, JSON.stringify({ type: 'message', id: user, parentId: index === 1 ? null : 'a' + (index-1), message: { role: 'user', content: text } }) + '\\n');
 const message = { role: 'assistant', content: [{ type: 'text', text: 'Pi received: ' + text }], stopReason: 'stop' };
 appendFileSync(path, JSON.stringify({ type: 'message', id: 'a' + index, parentId: user, message }) + '\\n');
 await emit('turn_end', { turnIndex: 0, message }); await emit('agent_end', { messages: [message] });
 busy = false; await emit('agent_settled', { aborted: false });
 console.log('PROCESSED');
}
extension(pi, { getVersion: async () => '1.2.0' }); await emit('session_start', { reason: 'startup' }); console.log('READY cwd=' + process.cwd());
process.on('SIGTERM', async () => { await emit('session_shutdown', { reason: 'quit' }); process.exit(0); });
setInterval(() => {}, 1000);
`);
  chmodSync(join(bin, 'pi'), 0o755);
  return `${bin}:/usr/bin:/bin`;
}

async function setup(): Promise<void> {
  vi.stubEnv('TL_PI_POLL_MS', '100');
  manager = new NodeManager({ home: join(home, 'tl'), path: fakePi() });
  server = await startServer(manager, { port: 0 });
}
const ready = async (id: string) => {
  await expect.poll(() => manager!.session(id)?.screenTail(30).join('\n'), { timeout: 5000 }).toContain('READY cwd=');
};

describe('Pi node integration', () => {
  it('launches without Claude, receives a daemon message, and keeps transcripts after close', async () => {
    await setup();
    const n = await manager!.spawn({ kind: 'agent', harness: 'pi', title: 'Pi', cwd: home, byHuman: true });
    await ready(n.id);
    expect(manager!.view(n.id)?.sessionId).toBe(n.sessionId); // not Pi's header UUID
    const sent = await deliver(manager!, HUMAN, n.id, 'hello from Tiller');
    expect(sent.outcome).toBe('queued');
    await expect.poll(() => messageStatus(manager!, HUMAN, sent.messageId!)?.outcome).toBe('delivered');
    await expect.poll(() => manager!.view(n.id)?.status.state).toBe('done');
    expect(manager!.view(n.id)?.status.lastAssistantMessage).toContain('hello from Tiller');
    expect((await manager!.transcript(n.id)).entries.map(e => e.text).join('\n')).toContain('hello from Tiller');
    const path = manager!.view(n.id)!.transcriptPath!;
    manager!.applyModEvent(n.id, { event: 'session.measure', payload: { cost: { usd: 0.8 } } });
    await manager!.close(n.id, true);
    expect(existsSync(manager!.nodeDir(n.id))).toBe(false);
    expect(existsSync(path)).toBe(true);
    expect((await manager!.transcript(n.id)).entries).toHaveLength(2);
    const next = await manager!.followup(n.id, 'next'); await ready(next.id);
    expect(next.harness).toBe('pi');
    expect(next.sessionId).toBe(n.sessionId);
    await expect(manager!.followup(n.id, 'duplicate')).rejects.toThrow(/already continues the session/);
    manager!.applyModEvent(next.id, { event: 'session.measure', payload: { cost: { usd: 1 } } });
    expect(manager!.view(next.id)!.spentUsd).toBeCloseTo(0.2);
    const adopted = join(manager!.sessionDirOf(next.id), 'agents', next.id, `${n.sessionId}.jsonl`);
    expect(next.transcriptPath).toBe(adopted);
    const originalEntries = readFileSync(path, 'utf8').split('\n').slice(1);
    expect(readFileSync(adopted, 'utf8').split('\n').slice(1)).toEqual(originalEntries);
    const oldMeta = join(manager!.sessionDirOf(n.id), 'meta.json');
    const meta = JSON.parse(readFileSync(oldMeta, 'utf8'));
    writeFileSync(oldMeta, JSON.stringify({ ...meta, closedAt: Date.now() - 100 * 86_400_000 }));
    expect(manager!.sweepSessions()).toContain(n.id);
    expect(existsSync(path)).toBe(false);
    expect(existsSync(adopted)).toBe(true);
    expect(manager!.restart(next.id).ok).toBe(true); await ready(next.id);
    const record = manager!.view(next.id)!;
    expect(record.previousSessions).toContain(n.sessionId);
    expect((await manager!.transcript(next.id, n.sessionId)).entries).toHaveLength(2);
    await manager!.close(next.id, true);
    expect(manager!.sweepSessions()).not.toContain(next.id);
    expect((await manager!.transcript(next.id, n.sessionId)).entries).toHaveLength(2);
    const again = await manager!.followup(next.id, 'again'); await ready(again.id);
    expect(again.previousSessions).toContain(n.sessionId);
    expect((await manager!.transcript(again.id, n.sessionId)).entries).toHaveLength(2);
  });

  it('keeps Pi defaults instead of importing Claude role models/effort, but honors explicit overrides', async () => {
    await setup();
    mkdirSync(join(home, '.tiller'));
    writeFileSync(join(home, '.tiller', 'config.json'), JSON.stringify({ roles: {
      orchestrator: { model: 'claude-mythos-5-1', effort: 'high' },
      worker: { model: 'claude-opus-5-5', effort: 'medium' },
    } }));
    const parent = await manager!.spawn({ kind: 'agent', harness: 'pi', title: 'Pi', cwd: home, byHuman: true }); await ready(parent.id);
    const child = await manager!.spawn({ kind: 'agent', title: 'worker', cwd: home, parentId: parent.id }); await ready(child.id);
    for (const node of [parent, child]) {
      expect(node.model).toBeUndefined();
      expect(node.effort).toBeUndefined();
    }
    const explicit = await manager!.spawn({ kind: 'agent', harness: 'pi', title: 'explicit', cwd: home, model: 'openai/test', effort: 'low', byHuman: true });
    await ready(explicit.id);
    expect(explicit).toMatchObject({ model: 'openai/test', effort: 'low' });
  });

  it('keeps an explicit provider/model through bare-id SessionStart, archive and follow-up', async () => {
    await setup();
    const n = await manager!.spawn({ kind: 'agent', harness: 'pi', title: 'qualified', cwd: home, model: 'openai/test', byHuman: true });
    await ready(n.id);
    expect(manager!.view(n.id)!.status.model).toBe('test'); // Native Pi reports its bare model.id.
    await manager!.close(n.id, true);
    expect((await findArchived(manager!.home, n.id))!.model).toBe('openai/test');
    const next = await manager!.followup(n.id, 'continue'); await ready(next.id);
    expect(next.model).toBe('openai/test');
    expect(manager!.view(next.id)!.status.model).toBe('test');
  });

  it('leaves model selection to Pi on follow-up when no model has resolved', async () => {
    vi.stubEnv('TL_TEST_PI_NO_MODEL', '1');
    await setup();
    const n = await manager!.spawn({ kind: 'agent', harness: 'pi', title: 'no model', cwd: home, byHuman: true });
    await ready(n.id);
    expect(manager!.view(n.id)!.status.model).toBeUndefined();
    await manager!.close(n.id, true);
    expect((await findArchived(manager!.home, n.id))!.model).toBeUndefined();
    const next = await manager!.followup(n.id, 'continue'); await ready(next.id);
    expect(next.model).toBeUndefined();
  });

  it('inherits Pi for agent children but never imports Claude permission modes', async () => {
    await setup();
    const parent = await manager!.spawn({ kind: 'agent', harness: 'pi', title: 'Pi', cwd: home, byHuman: true }); await ready(parent.id);
    manager!.applyHook(parent.id, { hook_event_name: 'UserPromptSubmit', permission_mode: 'auto' });
    const child = await manager!.spawn({ kind: 'agent', title: 'child', cwd: home, parentId: parent.id }); await ready(child.id);
    expect(child.harness).toBe('pi'); expect(child.permissionMode).toBeUndefined();
    const count = manager!.list().length;
    await expect(manager!.spawn({ kind: 'agent', harness: 'pi', title: 'restricted', cwd: home, permissionMode: 'plan', byHuman: true })).rejects.toThrow(/permissionMode/);
    await expect(manager!.spawn({ kind: 'agent', harness: 'pi', title: 'fork', cwd: home, fork: parent.id })).rejects.toThrow(/forking/);
    await expect(manager!.spawn({ kind: 'claude', harness: 'pi', title: 'bad', cwd: home })).rejects.toThrow(/kind "agent"/);
    expect(manager!.list()).toHaveLength(count);
  });

  it('resumes the exact Pi session and starts inside its managed worktree without Claude trust', async () => {
    await setup();
    const repo = join(home, 'repo'); mkdirSync(repo);
    execFileSync('git', ['init', '-q', repo]);
    execFileSync('git', ['-C', repo, '-c', 'user.name=Tiller Test', '-c', 'user.email=tiller@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-q', '--allow-empty', '-m', 'initial']);
    const n = await manager!.spawn({ kind: 'agent', harness: 'pi', title: 'worker', cwd: repo, isolation: 'worktree', byHuman: true }); await ready(n.id);
    expect(manager!.session(n.id)?.screenTail(30).join('\n')).toContain(n.worktree!.path);
    const path = manager!.view(n.id)!.transcriptPath!;
    manager!.session(n.id)!.kill();
    await expect.poll(() => manager!.view(n.id)?.status.exited).toBe(true);
    expect(await manager!.resume(n.id)).toEqual({ ok: true }); await ready(n.id);
    expect(manager!.view(n.id)?.transcriptPath).toBe(path);
    expect(readFileSync(path, 'utf8')).toContain('pi-native-id');
    await manager!.close(n.id, true, 'discard');
    expect(existsSync(n.worktree!.path)).toBe(false);
    const archived = await findArchived(manager!.home, n.id);
    expect(archived!.cwd).toBe(n.worktree!.path);
    const original = readFileSync(path, 'utf8');
    const next = await manager!.followup(n.id, 'more'); await ready(next.id);
    expect(next.cwd).toBe(realpathSync(repo));
    expect(manager!.session(next.id)?.screenTail(30).join('\n')).toContain(`READY cwd=${next.cwd}`);
    const adopted = readFileSync(next.transcriptPath!, 'utf8');
    expect(JSON.parse(adopted.split('\n')[0]).cwd).toBe(next.cwd);
    expect(readFileSync(path, 'utf8')).toBe(original); // Do not mutate the historical archive's cwd.
    expect(adopted.slice(adopted.indexOf('\n'))).toBe(original.slice(original.indexOf('\n')));
  });
});

describe('Tiller repository trust', () => {
  it('is explicit, matches ancestors but not siblings, and can be revoked', () => {
    expect(tillerTrusts(home, home)).toBe(false);
    setProjectTrust(home, join(home, 'project'), true);
    expect(tillerTrusts(home, join(home, 'project', 'subdir'))).toBe(true);
    expect(tillerTrusts(home, join(home, 'project-other'))).toBe(false);
    setProjectTrust(home, join(home, 'project'), false);
    expect(tillerTrusts(home, join(home, 'project'))).toBe(false);
  });
});
