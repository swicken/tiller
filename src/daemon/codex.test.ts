import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { codexAdapter } from './harness.js';
import { codexHeader } from '../shared/codex-transcript.js';
import { NodeManager } from './manager.js';
import { startServer, type DaemonServer } from './server.js';
import { DAEMON, deliver, HUMAN, messageStatus } from './messaging.js';

let home: string, manager: NodeManager | undefined, server: DaemonServer | undefined;
beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'tl-codex-')); });
afterEach(async () => {
  await manager?.shutdown(); await server?.close(); manager = undefined; server = undefined;
  vi.unstubAllEnvs();
  rmSync(home, { recursive: true, force: true });
});

// The real bridge talks to a fake native app-server and the real authenticated daemon.
async function setup(opts: { terminateTimeoutMs?: number } = {}): Promise<void> {
  const bin = join(home, 'bin'); mkdirSync(bin);
  writeFileSync(join(bin, 'codex'), `#!${process.execPath}
const { createInterface } = require('node:readline');
const { appendFileSync } = require('node:fs');
const fs = require('node:fs');
const stubborn = fs.existsSync(${JSON.stringify(join(home, 'stubborn-native'))});
if (stubborn) {
 const role = process.argv.includes('--remote') ? 'tui' : 'appserver';
 fs.writeFileSync(${JSON.stringify(home)} + '/' + role + '.pid', String(process.pid));
 process.on('SIGTERM', () => fs.appendFileSync(${JSON.stringify(home)} + '/' + role + '.signals', 'TERM\\n'));
 process.on('SIGHUP', () => fs.appendFileSync(${JSON.stringify(home)} + '/' + role + '.signals', 'HUP\\n'));
 setInterval(() => {
  if (fs.existsSync(${JSON.stringify(join(home, 'release-native'))})) process.exit();
  try { fs.appendFileSync(${JSON.stringify(home)} + '/' + role + '.beat', 'x'); }
  catch { process.exit(); } // A failed test's removed fixture also cleans up a surviving fake.
 }, 20);
}
if (process.argv.includes('--remote')) {
 appendFileSync(${JSON.stringify(join(home, 'rpc.jsonl'))}, JSON.stringify({ method: 'tui/launch', params: { args: process.argv.slice(2) } }) + '\\n');
 const WebSocket = require(${JSON.stringify(fileURLToPath(new URL('../../node_modules/ws/index.js', import.meta.url)))});
 const remote = process.argv[process.argv.indexOf('--remote') + 1];
 const ws = new WebSocket('ws+unix://' + remote.slice('unix://'.length) + ':/');
 let threadId, nextId = 10;
 const send = p => ws.send(JSON.stringify(p));
 ws.on('open', () => send({ id: 1, method: 'initialize', params: { clientInfo: { name: 'codex-tui', version: 'fake' } } }));
 ws.on('message', raw => {
  const p = JSON.parse(raw);
  if (p.id === 1 && !p.method) {
   send({ method: 'initialized' });
   const resume = process.argv.indexOf('resume');
   send({ id: 2, method: resume >= 0 ? 'thread/resume' : 'thread/start', params: resume >= 0 ? { threadId: process.argv[resume + 1] } : {} });
  } else if (p.id === 2 && !p.method) {
   threadId = p.result.thread.id;
   console.log('FAKE CODEX TUI ready');
   const prompt = process.argv.indexOf('--');
   if (prompt >= 0) send({ id: ++nextId, method: 'turn/start', params: { threadId, input: [{ type: 'text', text: process.argv[prompt + 1] }] } });
  } else if (p.method === 'item/commandExecution/requestApproval') console.log('NATIVE APPROVAL ' + p.id);
 });
 createInterface({ input: process.stdin }).on('line', line => {
  if (line === '/approve approval yes') send({ id: 'approval', result: { decision: 'accept' } });
 });
 if (!stubborn) process.on('SIGTERM', () => process.exit());
} else {
const send = p => process.stdout.write(JSON.stringify(p) + '\\n');
const reply = (p, result) => send({ id: p.id, result });
let threadId, turn, seq = 0;
const event = (method, params) => send({ method, params: { threadId, ...params } });
function complete(status = 'completed') {
  const text = 'Codex received: ' + turn.text;
  event('item/agentMessage/delta', { delta: text });
  event('item/completed', { item: { type: 'agentMessage', id: 'answer', text } });
  event('thread/tokenUsage/updated', { tokenUsage: { last: { totalTokens: 200 }, modelContextWindow: 1000 } });
  event('turn/completed', { turn: { id: turn.id, status } }); turn = undefined;
}
createInterface({ input: process.stdin }).on('line', line => {
  const p = JSON.parse(line), v = p.params || {};
  appendFileSync(${JSON.stringify(join(home, 'rpc.jsonl'))}, JSON.stringify(p) + '\\n');
  if (!p.method) { if (p.id === 'approval') complete(); return; }
  if (p.method === 'initialize') return reply(p, {});
  if (p.method === 'initialized') return;
  if (['thread/start', 'thread/resume', 'thread/fork'].includes(p.method)) {
    if (v.model === 'crash-start') return process.stderr.write('KNOWN CODEX STARTUP DIAGNOSTIC\\n', () => process.exit(23));
    if (p.method === 'thread/start') threadId = 'native-' + process.pid;
    else threadId = p.method === 'thread/fork' ? 'fork-' + process.pid : v.threadId;
    const mcp = v.config ? Object.values(v.config)[0] : undefined;
    if (v.config && (!mcp.required || mcp.http_headers['X-TL-Node'] !== process.env.TL_NODE_ID || !process.env.TL_CODEX_AUTHORIZATION.startsWith('Bearer '))) throw Error('bad MCP identity');
    return reply(p, { thread: { id: threadId }, model: v.model || 'codex-default' });
  }
  if (p.method === 'turn/start') {
    const text = v.input[0].text;
    if (text.includes('reject-me')) return send({ id: p.id, error: { code: -1, message: 'rejected' } });
    turn = { id: 't-' + ++seq, text };
    event('turn/started', { turn: { id: turn.id } });
    event('item/completed', { item: { type: 'userMessage', id: 'user', content: v.input } });
    if (text.includes('crash-turn')) {
      complete();
      return process.stderr.write('KNOWN CODEX TURN DIAGNOSTIC\\n', () => process.exit(24));
    }
    reply(p, { turn: { id: turn.id } });
    if (text.includes('approve-me')) return send({ id: 'approval', method: 'item/commandExecution/requestApproval', params: { threadId, turnId: turn.id, command: 'echo hello', reason: 'test approval' } });
    if (text.includes('hold-me')) return;
    setTimeout(() => complete(), 50); return;
  }
  if (p.method === 'turn/interrupt') { reply(p, {}); complete('interrupted'); return; }
  send({ id: p.id, error: { code: -32601, message: 'unsupported' } });
});
}
`);
  chmodSync(join(bin, 'codex'), 0o755);
  manager = new NodeManager({ home: join(home, 'tl'), path: `${bin}:/usr/bin:/bin`, ...opts });
  server = await startServer(manager, { port: 0 });
}
const ready = async (id: string) => {
  await expect.poll(() => manager!.session(id)?.screenTail(40).join('\n')).toContain('FAKE CODEX TUI ready');
};
const packets = () => readFileSync(join(home, 'rpc.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));

describe('Codex harness', () => {
  it('keeps the host and lifecycle lock when native child exit remains unproven', async () => {
    await setup({ terminateTimeoutMs: 300 });
    writeFileSync(join(home, 'stubborn-native'), '');
    const preload = join(home, 'deny-native-kill.cjs');
    writeFileSync(preload, `const cp = require('node:child_process');
const kill = cp.ChildProcess.prototype.kill;
cp.ChildProcess.prototype.kill = function(signal) { return signal === 'SIGKILL' ? true : kill.call(this, signal); };
`);
    vi.stubEnv('NODE_OPTIONS', `--require=${preload}`);
    writeFileSync(join(home, 'bin', 'pi'), `#!${process.execPath}\nrequire('node:fs').writeFileSync(${JSON.stringify(join(home, 'pi-started'))}, 'started'); setInterval(() => {}, 1000);\n`);
    chmodSync(join(home, 'bin', 'pi'), 0o755);
    const m = manager!;
    const node = await m.spawn({ kind: 'agent', harness: 'codex', title: 'Unproven native stop', cwd: home, byHuman: true });
    try {
      await ready(node.id);
      const old = m.session(node.id);
      expect(await m.changeHarness(node.id, 'pi', undefined, true)).toMatchObject({ ok: false, error: expect.stringContaining('old process has not exited') });
      expect(m.session(node.id)).toBe(old);
      expect(m.view(node.id)).toMatchObject({ harness: 'codex', changingHarness: true });
      expect(m.restart(node.id)).toMatchObject({ ok: false });
      await expect(m.close(node.id, true)).rejects.toThrow('changing harness');
      expect(existsSync(join(home, 'pi-started'))).toBe(false);
    } finally {
      // Release only the fixture-owned children, then observe their host exit without PID cleanup.
      writeFileSync(join(home, 'release-native'), '');
      await expect.poll(() => m.session(node.id)).toBeUndefined();
    }
    expect(m.view(node.id)?.changingHarness).toBeUndefined();
    expect(m.view(node.id)?.status.exited).toBe(true);
  });

  it('confirms escalated native TUI and app-server exit before launching a replacement harness', async () => {
    await setup();
    writeFileSync(join(home, 'stubborn-native'), '');
    writeFileSync(join(home, 'bin', 'pi'), `#!${process.execPath}\nsetInterval(() => {}, 1000);\n`);
    chmodSync(join(home, 'bin', 'pi'), 0o755);
    const m = manager!;
    const node = await m.spawn({ kind: 'agent', harness: 'codex', title: 'Stubborn native children', cwd: home, byHuman: true });
    await ready(node.id);
    await expect.poll(() => { try { return readFileSync(join(home, 'tui.beat'), 'utf8').length; } catch { return 0; } }).toBeGreaterThan(0);
    const roles = ['tui', 'appserver'];
    const pids = roles.map((role) => Number(readFileSync(join(home, `${role}.pid`), 'utf8')));
    const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
    expect(pids.every(alive)).toBe(true);
    expect(await m.changeHarness(node.id, 'pi', undefined, true)).toEqual({ ok: true });
    expect(pids.some(alive)).toBe(false);
    const sizes = roles.map((role) => readFileSync(join(home, `${role}.beat`), 'utf8').length);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(roles.map((role) => readFileSync(join(home, `${role}.beat`), 'utf8').length)).toEqual(sizes);
    expect(roles.every((role) => readFileSync(join(home, `${role}.signals`), 'utf8').includes('TERM'))).toBe(true);
    expect(m.view(node.id)?.harness).toBe('pi');
  });

  it('switches a running root across real fake-CLI PTYs without reusing native threads or contaminating history', async () => {
    await setup();
    for (const harness of ['claude', 'pi']) {
      const file = join(home, 'bin', harness);
      writeFileSync(file, `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2), pi = ${JSON.stringify(harness)} === 'pi';
const sid = pi ? process.env.TL_SESSION_ID : args[args.indexOf('--session-id') + 1];
const path = pi ? args[args.indexOf('--session') + 1] : ${JSON.stringify(home)} + '/' + sid + '.jsonl';
const token = fs.readFileSync(process.env.TL_TOKEN_FILE, 'utf8');
const headers = { Authorization: 'Bearer ' + token, 'X-TL-Node': process.env.TL_NODE_ID };
const post = (route, body) => fetch(process.env.TL_ENDPOINT + route, { method: 'POST', headers, body: JSON.stringify(body) });
fs.writeFileSync(path, JSON.stringify(pi ? { type: 'session', id: 'native-pi', cwd: process.cwd() } : { type: 'system' }) + '\\n' + JSON.stringify(pi ? { type: 'message', message: { role: 'assistant', content: 'Pi history' } } : { type: 'assistant', message: { content: 'Claude history' } }) + '\\n');
post('/hook', { hook_event_name: 'SessionStart', session_id: sid, transcript_path: path }).then(() => console.log('FAKE ${harness} ready'));
process.on('SIGHUP', () => setTimeout(async () => {
 await post('/hook', { hook_event_name: 'SessionEnd', session_id: sid });
 fs.writeFileSync(${JSON.stringify(home)} + '/stopped-' + sid, 'stopped');
 process.exit();
}, 75));
setInterval(() => {}, 1000);
`);
      chmodSync(file, 0o755);
    }
    const m = manager!;
    const node = await m.spawn({ kind: 'agent', harness: 'claude', title: 'Root identity', cwd: home, byHuman: true });
    await expect.poll(() => m.session(node.id)?.screenTail(40).join('\n')).toContain('FAKE claude ready');
    const child = await m.spawn({ kind: 'terminal', title: 'Keep child', parentId: node.id, cwd: home });
    const history: Array<{ sessionId: string; text: string }> = [];
    let firstNative: string | undefined;
    for (const harness of ['codex', 'pi', 'claude', 'codex'] as const) {
      const old = m.view(node.id)!;
      const transcript = await m.transcript(node.id);
      history.push({ sessionId: old.sessionId!, text: transcript.entries[0]?.text ?? '' });
      const token = m.tokenFor(node.id);
      const oldHeaders = { Authorization: `Bearer ${token}`, 'X-TL-Node': node.id };
      expect(await m.changeHarness(node.id, harness, undefined, true)).toEqual({ ok: true });
      expect(m.view(node.id)).toMatchObject({ id: node.id, title: node.title, cwd: home, parentId: null, createdAt: node.createdAt, harness });
      expect(m.view(child.id)?.parentId).toBe(node.id);
      expect(m.view(node.id)?.sessionId).not.toBe(old.sessionId);
      if (old.harness !== 'codex') expect(readFileSync(join(home, `stopped-${old.sessionId}`), 'utf8')).toBe('stopped');
      if (harness === 'codex') {
        await ready(node.id);
        const native = codexHeader(readFileSync(m.registry.get(node.id)!.transcriptPath!, 'utf8')).threadId;
        if (firstNative) expect(native).not.toBe(firstNative);
        firstNative ??= native;
        const sent = await deliver(m, DAEMON, node.id, 'new Codex context');
        await expect.poll(() => messageStatus(m, DAEMON, sent.messageId!)?.outcome).toBe('delivered');
        await expect.poll(() => m.view(node.id)?.status.doneSource).toBe('stop');
      } else await expect.poll(() => m.session(node.id)?.screenTail(40).join('\n')).toContain(`FAKE ${harness} ready`);
      for (const [path, body] of [
        ['/hook', { hook_event_name: 'SessionStart', session_id: 'stale-native-id', transcript_path: '/bad' }],
        ['/mod-event', { event: 'session.measure', payload: { model: 'stale-model', cost: { usd: 999 } } }],
        ['/ack', { id: 'stale-message' }],
      ] as const) {
        expect((await fetch(m.endpoint + path, { method: 'POST', headers: oldHeaders, body: JSON.stringify(body) })).status).toBe(401);
      }
      expect(m.view(node.id)?.sessionId).not.toBe('stale-native-id');
      expect(m.view(node.id)?.status.model).not.toBe('stale-model');
      for (const past of history) expect((await m.transcript(node.id, past.sessionId)).entries[0]?.text ?? '').toBe(past.text);
    }
    await m.close(child.id);
    await m.close(node.id, true);
    const followup = await m.followup(node.id, 'continue in Codex');
    await ready(followup.id);
    for (const past of history) expect((await m.transcript(followup.id, past.sessionId)).entries[0]?.text ?? '').toBe(past.text);
    expect(followup.sessionHistory?.every((s) => s.transcriptPath.includes(followup.id))).toBe(true);
  });

  it('rejects restrictions that cannot be translated', () => {
    expect(() => codexAdapter.validate({ permissionMode: 'plan' })).toThrow(/permissionMode/);
    for (const preset of [{ tools: [] }, { disallowedTools: [] }, { maxTurns: 1 }]) {
      expect(() => codexAdapter.validate({ preset })).toThrow(/preset tools/);
    }
  });

  it.each(['startup', 'turn'] as const)('shows native stderr after a crash during pending %s', async (phase) => {
    await setup();
    const n = await manager!.spawn({ kind: 'agent', harness: 'codex', title: 'Crash diagnostics', cwd: home,
      ...(phase === 'startup' ? { model: 'crash-start' } : {}), byHuman: true });
    if (phase === 'turn') {
      await ready(n.id);
      await deliver(manager!, HUMAN, n.id, 'crash-turn');
    }
    await expect.poll(() => manager!.view(n.id)?.status.activity)
      .toContain(phase === 'startup' ? 'KNOWN CODEX STARTUP DIAGNOSTIC' : 'KNOWN CODEX TURN DIAGNOSTIC');
    expect(manager!.view(n.id)?.status.activity).not.toContain('Codex connection closed');
    if (phase === 'turn') {
      expect((await manager!.transcript(n.id)).entries.some((entry) => entry.role === 'assistant' && entry.text.includes('crash-turn'))).toBe(true);
    }
  });

  it('delivers once, reports lifecycle/context and preserves a separate native thread on follow-up', async () => {
    await setup();
    const n = await manager!.spawn({ kind: 'agent', harness: 'codex', title: 'Codex', cwd: home, effort: 'high', byHuman: true });
    await ready(n.id);
    expect(packets().filter((p) => p.method === 'tui/launch').at(-1).params.args).toContain('model_reasoning_effort="high"');
    expect(manager!.view(n.id)?.status.model).toBe('gpt-6-astra');
    expect(manager!.view(n.id)?.sessionId).toBe(n.sessionId);
    const sent = await deliver(manager!, HUMAN, n.id, 'hello');
    await expect.poll(() => messageStatus(manager!, HUMAN, sent.messageId!)?.outcome).toBe('delivered');
    await expect.poll(() => manager!.view(n.id)?.status.state).toBe('done');
    expect(manager!.view(n.id)?.status.lastAssistantMessage).toContain('hello');
    expect(manager!.view(n.id)?.status.contextPct).toBe(20);
    const entries = (await manager!.transcript(n.id)).entries;
    expect(entries.map((e) => e.role)).toEqual(['user', 'assistant']);
    expect(entries[0].text).toContain('hello');
    expect(packets().filter((p) => p.method === 'turn/start')).toHaveLength(1);
    const path = manager!.view(n.id)!.transcriptPath!, original = readFileSync(path, 'utf8');
    const nativeId = codexHeader(original).threadId;
    await manager!.close(n.id, true);
    const next = await manager!.followup(n.id, ''); await ready(next.id);
    expect(packets().filter((p) => p.method === 'tui/launch').at(-1).params.args).not.toContain('-c');
    expect(next.harness).toBe('codex');
    expect(next.transcriptPath).not.toBe(path);
    expect(codexHeader(readFileSync(next.transcriptPath!, 'utf8')).threadId).not.toBe(nativeId);
    expect(packets().some((p) => p.method === 'thread/fork' && p.params.threadId === nativeId)).toBe(true);
    expect(readFileSync(path, 'utf8')).toBe(original);
    expect((await manager!.transcript(next.id)).entries).toEqual(entries);
    manager!.kill(next.id);
    expect((await manager!.resume(next.id)).ok).toBe(true); await ready(next.id);
    expect(packets().filter((p) => p.method === 'thread/resume').length).toBeGreaterThanOrEqual(2);
    expect(packets().filter((p) => p.method === 'tui/launch').at(-1).params.args).not.toContain('-c');
    expect(manager!.restart(next.id).ok).toBe(true); await ready(next.id);
    expect(packets().filter((p) => p.method === 'tui/launch').at(-1).params.args).toContain('model_reasoning_effort="high"');
    expect(manager!.view(next.id)?.previousSessions).toContain(n.sessionId);
    expect((await manager!.transcript(next.id, n.sessionId)).entries).toEqual(entries);
  });

  it('keeps busy messages withdrawable, interrupts on steer, and surfaces approvals for a human response', async () => {
    await setup();
    const n = await manager!.spawn({ kind: 'agent', harness: 'codex', title: 'Codex', cwd: home, prompt: 'hold-me', byHuman: true });
    await ready(n.id);
    await expect.poll(() => manager!.view(n.id)?.status.state).toBe('working');
    const queued = await deliver(manager!, DAEMON, n.id, 'queued');
    // A steer interrupts the active turn and runs ahead of the ordinary message.
    const steer = await deliver(manager!, HUMAN, n.id, 'approve-me', { mode: 'now' });
    await expect.poll(() => manager!.view(n.id)?.status.state).toBe('blocked');
    expect(messageStatus(manager!, HUMAN, queued.messageId!)?.outcome).toBe('queued');
    expect(messageStatus(manager!, HUMAN, steer.messageId!)?.outcome).toBe('delivered');
    manager!.session(n.id)!.write('/approve approval yes\r');
    await expect.poll(() => messageStatus(manager!, HUMAN, queued.messageId!)?.outcome).toBe('delivered');
    await expect.poll(() => manager!.view(n.id)?.status.state).toBe('done');
    const starts = packets().filter((p) => p.method === 'turn/start');
    expect(starts.map((p) => p.params.input[0].text.includes('approve-me'))).toEqual([false, true, false]);
    expect(packets().find((p) => p.id === 'approval' && p.result)?.result).toEqual({ decision: 'accept' });
    expect(packets().filter((p) => p.method === 'turn/interrupt')).toHaveLength(1);
  });
});
