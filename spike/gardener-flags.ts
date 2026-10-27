// Spike S0 (memory v3, plan G0): what the gardener's launch flags leave on this Claude Code. Starts its own daemon, which
// supplies a node id and token (a terminal node) and receives the hooks and the mod's session.measure. Runs claude itself
// in a PTY with the gardener command line against a stub `tiller` MCP server that serves the four garden tools, since the
// real ones do not exist yet. Writes a CLAUDE.md with a codeword into the checkout for the run and removes it afterwards.
// Costs under a cent of Haiku on the default Claude account. Re-run it on every Claude Code upgrade.
//   TL_HOME=$(mktemp -d) TL_PORT=7799 npx tsx spike/gardener-flags.ts
import { spawn as spawnChild } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import * as nodePty from 'node-pty';
import { WebSocket } from 'ws';
import { z } from 'zod';
import type { ClientMessage, NodeView, ServerMessage } from '../src/shared/protocol.js';

const PORT = process.env.TL_PORT ?? '7799';
const HOME = process.env.TL_HOME ?? '';
if (!HOME || HOME === join(homedir(), '.tiller') || PORT === '7788') throw new Error('set TL_HOME to a fresh temp dir and TL_PORT to a free port, never the live ~/.tiller or 7788');
// This may itself run inside a tiller node: the child claude must see only the throwaway daemon's node.
for (const k of Object.keys(process.env)) if (/^TL_/.test(k) && k !== 'TL_HOME' && k !== 'TL_PORT') delete process.env[k];
const REPO = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
const HOOK_SCRIPT = join(REPO, 'src/daemon/hook.sh');
const MODEL = 'claude-haiku-5-5';
const GARDEN = ['garden_list', 'garden_get', 'garden_merge', 'garden_supersede'];
const GARDENER_AGENT_TOOLS = GARDEN.map((t) => `mcp__tiller__${t}`);
const PROBE = 'mcp__tiller__garden_probe';
// Without these Claude Code 2.1.310 also sends the API a deferred `advisor` server tool (claude-opus-5-5) and, with only the
// first, a deferred DeferredToolPlaceholder, which the experimental-betas switch alone suppresses.
const GARDENER_ENV = { CLAUDE_CODE_DISABLE_ADVISOR_TOOL: '1', CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS: '1' };
const HOOK_EVENTS = ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Notification', 'PermissionRequest', 'Stop', 'StopFailure', 'SessionEnd'];
const t0 = Date.now();
const log = (s: string) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1).padStart(6)}s] ${s}`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const check = (ok: boolean, what: string) => { if (!ok) failures++; log(`${ok ? 'PASS' : 'FAIL'} ${what}`); };
const dlog = () => readFileSync(`${HOME}/daemon.log`, 'utf8');
const strip = (s: string) => s.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07]*\x07|\x1b[()][0-9A-B]/g, '');

async function waitFor<T>(what: string, ms: number, probe: () => T | undefined | false): Promise<T | undefined> {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(250)) { const v = probe(); if (v) return v; }
  log(`timeout waiting for ${what}`);
  return undefined;
}

/** The stand-in for the daemon's gardener tools: the four garden tools plus a probe no run allows, each call logged. */
function stubServer(calls: string[], slow: { ms: number }): Promise<string> {
  const ok = (data: object) => ({ content: [{ type: 'text' as const, text: JSON.stringify(data) }] });
  const page = { run: 'r1', page: 1, pages: 1, clusters: [{ kind: 'pitfall', keep: 'm1', ids: ['m1', 'm2'] }], supersedeHints: [{ id: 'm3', by: 'm4' }],
    items: ['m1', 'm2', 'm3', 'm4'].map((id) => ({ id, kind: 'pitfall', text: `spike item ${id}`, seen: 1, author: 'agent', protected: false })) };
  const http = createServer(async (req, res) => {
    const mcp = new McpServer({ name: 'tiller', version: '0.0.0' });
    const tool = (name: string, shape: z.ZodRawShape, result: object) => mcp.registerTool(name, { description: `Spike stand-in for ${name}.`, inputSchema: shape },
      async (args: unknown) => { calls.push(name); log(`stub call ${name} ${JSON.stringify(args)}`); await sleep(slow.ms); return ok(result); });
    tool('garden_list', { cursor: z.string().optional() }, page);
    tool('garden_get', { id: z.string() }, { id: 'm1', kind: 'pitfall', text: 'spike item m1', body: 'body' });
    tool('garden_merge', { ids: z.array(z.string()), reason: z.string() }, { kept: 'm1', hidden: ['m2'], hidesLeft: 39 });
    tool('garden_supersede', { id: z.string(), by: z.string(), reason: z.string() }, { hidden: 'm3', by: 'm4', supersedesLeft: 9 });
    tool('garden_probe', {}, { probe: 'this call should never arrive' });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on('close', () => { transport.close().catch(() => {}); mcp.close().catch(() => {}); });
    await mcp.connect(transport);
    await transport.handleRequest(req, res);
  });
  return new Promise((ok) => http.listen(0, '127.0.0.1', () => ok(`http://127.0.0.1:${(http.address() as AddressInfo).port}/mcp`)));
}

type Entry = { type?: string; shape?: { tools?: { name: string; type?: string }[] }; message?: { id?: string; model?: string; content?: unknown; usage?: { output_tokens?: number } } };
/** A mod event as the daemon logged it under TL_DEBUG: `at` is ms into the UTC day. */
interface ModLine { at: number; event: string; payload: string }
interface Run { hooks: Record<string, unknown>[]; screen: string; calls: string[]; mod: ModLine[]; prompted: boolean; transcript: Entry[] }

/** One claude session with the gardener command line; ends at the first Stop (or StopFailure) hook. */
async function runClaude(name: string, o: { nodeId: string; endpoint: string; stubUrl: string; calls: string[]; tools: string[]; maxTurns: number; prompt: string; extraArgs?: string[] }): Promise<Run> {
  const dir = join(HOME, 'spike', name);
  mkdirSync(dir, { recursive: true });
  const hookLog = join(dir, 'hooks.jsonl');
  writeFileSync(hookLog, '');
  const hook = [{ hooks: [{ type: 'command', command: `sh '${HOOK_SCRIPT}'` }, { type: 'command', command: `{ cat; echo; } >> '${hookLog}'` }] }];
  // As §3.5's writeNodeFiles: the daemon's hooks, and an allow list of exactly the four tools in place of mcp__tiller.
  writeFileSync(join(dir, 'settings.json'), JSON.stringify({ hooks: Object.fromEntries(HOOK_EVENTS.map((e) => [e, hook])), permissions: { allow: GARDENER_AGENT_TOOLS } }, null, 2));
  writeFileSync(join(dir, 'mcp.json'), JSON.stringify({ mcpServers: { tiller: { type: 'http', url: o.stubUrl } } }));
  const agents = { 'tiller-gardener': { description: 'tiller memory gardener', prompt: '', tools: o.tools, maxTurns: o.maxTurns } };
  const system = `You are tiller's memory gardener (node ${o.nodeId}). Your only tools are the four garden tools.`;
  const args = ['--restricted', '--tools', '', '--permission-mode', 'dontAsk', '--strict-mcp-config', '--disable-slash-commands', ...(o.extraArgs ?? []),
    '--agents', JSON.stringify(agents), '--agent', 'tiller-gardener',
    '--mcp-config', join(dir, 'mcp.json'), '--settings', join(dir, 'settings.json'),
    '--plugin-dir', join(REPO, 'mod'), '--plugin-dir', join(REPO, 'mod-rows'),
    '--model', MODEL, '--effort', 'medium', '--name', `spike ${name}`, '--append-system-prompt', system, '--', o.prompt];
  writeFileSync(join(dir, 'argv.json'), JSON.stringify(['claude', ...args], null, 2));
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !/^(CLAUDE|TERM|TERMINFO|COLORTERM)/.test(k)) env[k] = v; // as buildChildEnv: the default account
  Object.assign(env, GARDENER_ENV, { TERM: 'xterm-256color', TL_NODE_ID: o.nodeId, TL_ENDPOINT: o.endpoint, TL_TOKEN_FILE: join(HOME, 'nodes', o.nodeId, 'token') });

  const run: Run = { hooks: [], screen: '', calls: [], mod: [], prompted: false, transcript: [] };
  const from = o.calls.length, logFrom = dlog().length;
  const pty = nodePty.spawn('claude', args, { name: 'xterm-256color', cols: 140, rows: 45, cwd: REPO, env });
  let raw = '';
  pty.onData((d) => {
    raw += d;
    if (!run.prompted && /Do you want to|trust (this|the files in this) folder/i.test(strip(raw.slice(-6000)))) { run.prompted = true; log(`${name}: PROMPT shown, pressing Escape`); pty.write('\x1b'); }
  });
  const hooks = () => readFileSync(hookLog, 'utf8').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l) as Record<string, unknown>);
  const ended = await waitFor(`${name} Stop`, 300_000, () => hooks().some((h) => /^Stop/.test(String(h.hook_event_name))));
  await sleep(4000); // the turn-end measure follows Stop
  run.hooks = hooks();
  run.screen = strip(raw);
  run.calls = o.calls.slice(from);
  run.mod = dlog().slice(logFrom).split('\n').filter((l) => l.includes(` mod ${o.nodeId.slice(0, 6)} `)).map((l) => {
    const [event, ...rest] = l.slice(l.indexOf(' mod ') + 12).split(' ');
    return { at: Date.parse(`1970-01-01T${l.slice(0, 12)}Z`), event, payload: rest.join(' ') };
  });
  const tp = run.hooks.find((h) => typeof h.transcript_path === 'string')?.transcript_path as string | undefined;
  run.transcript = tp && existsSync(tp) ? readFileSync(tp, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
  pty.write('/exit\r');
  await sleep(1500);
  pty.kill();
  writeFileSync(join(dir, 'screen.txt'), run.screen);
  log(`${name}: ${ended ? 'turn ended' : 'NO Stop hook'}; hooks ${run.hooks.map((h) => `${h.hook_event_name}${h.tool_name ? `(${h.tool_name})` : ''}`).join(' ')}; stub calls [${run.calls.join(', ')}]; mod events ${run.mod.map((m) => m.event).join(' ')}; files in ${dir}`);
  return run;
}

const assistantText = (r: Run) => r.transcript.filter((e) => e.type === 'assistant').flatMap((e) => (Array.isArray(e.message?.content) ? e.message.content : []))
  .filter((c: { type?: string }) => c.type === 'text').map((c: { text?: string }) => c.text ?? '').join('\n');
const line = (r: Run, key: string) => assistantText(r).match(new RegExp(`^.*${key}:(.*)$`, 'm'))?.[1]?.trim() ?? '';
const modelCalls = (r: Run) => [...new Map(r.transcript.filter((e) => e.type === 'assistant' && e.message?.id).map((e) => [e.message!.id, e.message!])).values()];
const toolEvents = (r: Run) => r.hooks.filter((h) => h.hook_event_name === 'PreToolUse' || h.hook_event_name === 'PermissionRequest').map((h) => String(h.tool_name));
/** Every tool name Claude Code sent to the API in this session: the authoritative inventory. */
const sentTools = (r: Run) => [...new Set(r.transcript.filter((e) => e.type === 'api-request-shape').flatMap((e) => e.shape?.tools ?? []).map((t) => (t.type ? `${t.name} (${t.type})` : t.name)))];
/**
 * Priced session.measure events more than a second before the turn completes. The one right after turn.start carries no
 * tokens or cost, and the turn-end one lands within milliseconds of turn.complete, on either side of it.
 */
function midTurnMeasures(r: Run): number {
  const end = r.mod.find((m) => m.event === 'turn.complete')?.at ?? 0;
  return r.mod.filter((m) => m.event === 'session.measure' && m.payload.includes('"tokens"') && m.at < end - 1000).length;
}

async function main(): Promise<void> {
  mkdirSync(HOME, { recursive: true });
  const out = openSync(`${HOME}/daemon.log`, 'a');
  appendFileSync(`${HOME}/daemon.log`, '=== daemon start ===\n');
  const daemon = spawnChild('node', ['--import', 'tsx', 'src/daemon/index.ts'], { cwd: REPO, env: { ...process.env, TL_HOME: HOME, TL_PORT: PORT, TL_DEBUG: '1' }, stdio: ['ignore', out, out] });
  const claudeMd = join(REPO, 'CLAUDE.md');
  if (existsSync(claudeMd)) throw new Error(`${claudeMd} exists; run from a checkout without one`);
  const codeword = `MARIGOLD-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
  try {
    await waitFor('daemon listening', 20_000, () => dlog().includes('listening'));
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
    const nodes = new Map<string, NodeView>();
    const states: string[] = [];
    ws.on('message', (raw) => {
      const m = JSON.parse(raw.toString()) as ServerMessage;
      if (m.t === 'snapshot') for (const n of m.nodes) nodes.set(n.id, n);
      else if (m.t === 'node') { nodes.set(m.node.id, m.node); states.push(`${m.node.status.state}${m.node.status.activity ? `:${m.node.status.activity}` : ''}`); }
    });
    await new Promise<void>((ok, fail) => { ws.once('open', ok); ws.once('error', fail); });
    const send = (m: ClientMessage) => ws.send(JSON.stringify(m));
    send({ t: 'auth', token: readFileSync(`${HOME}/admin-token`, 'utf8').trim() });
    await sleep(500);
    send({ t: 'spawn', kind: 'terminal', title: 'gardener-host', cwd: REPO });
    const nodeId = (await waitFor('host node', 10_000, () => [...nodes.values()].find((n) => n.title === 'gardener-host')?.id)) ?? '';
    await waitFor('host token', 5000, () => existsSync(join(HOME, 'nodes', nodeId, 'token')));
    const calls: string[] = [], slow = { ms: 0 };
    const stubUrl = await stubServer(calls, slow);
    const base = { nodeId, endpoint: `http://127.0.0.1:${PORT}`, stubUrl, calls, tools: GARDENER_AGENT_TOOLS, maxTurns: 20 };
    writeFileSync(claudeMd, `# Spike\n\nThe project codeword is ${codeword}.\n`);

    // A: the final flag set; inventory, CLAUDE.md, attempted built-ins, then every garden tool in turn.
    const a = await runClaude('inventory', { ...base, prompt: [
      'This is a configuration self-test, not a garden run. Do these steps in order.',
      '1. Write one line that starts with "TOOLS:" and lists the exact names of every tool you can call, comma-separated, including any deferred tools named in system reminders and any tool you could load. Nothing else on that line.',
      '2. Write one line "CODEWORD: <word>" with the project codeword from CLAUDE.md, or "CODEWORD: none" if you have no CLAUDE.md content.',
      '3. Write one line "SKILLS:" listing every skill or slash command you could run, or "SKILLS: none".',
      '4. For each of Bash, Read, Edit, Write, Glob, Grep, WebFetch, WebSearch, Skill, Agent, Task, ToolSearch, advisor: if it is in your tool list, call it once with a harmless argument (for Bash: echo hi; for Read: CLAUDE.md); otherwise skip it.',
      '5. Call garden_list. Then garden_get with id "m1". Then garden_merge with ids ["m1","m2"] and reason "spike". Then garden_supersede with id "m3", by "m4", reason "spike". One tool call per message.',
      '6. End your turn with the line DONE.',
    ].join('\n') });
    // B: a tool the agent offers but settings.json does not allow, to see dontAsk deny it and the tripwire see it.
    const b = await runClaude('dontask', { ...base, tools: [...GARDENER_AGENT_TOOLS, PROBE],
      prompt: 'Call the garden_probe tool once with no arguments. Whatever happens, then write the line "PROBE: <the exact result or error you got>" and end your turn.' });
    // C: the turn limit in interactive mode, from the agent definition or the hidden --max-turns flag.
    const c = await runClaude('maxturns', { ...base, maxTurns: 2, extraArgs: ['--max-turns', '2'], prompt: 'Call garden_list six times, one call per message, waiting for each result. Then write DONE.' });
    // D: a turn over a minute long, to see whether session.measure arrives during it.
    slow.ms = 20_000;
    const d = await runClaude('cadence', { ...base, prompt: 'Call garden_get with id "m1" three times, one call per message, waiting for each result. Then write DONE.' });

    log('--- answers ---');
    const tools = sentTools(a), extra = tools.filter((t) => !GARDENER_AGENT_TOOLS.includes(t));
    const listed = line(a, 'TOOLS').split(',').map((s) => s.trim().replace(/[`*.]/g, '')).filter(Boolean);
    log(`tools sent to the API: ${tools.join(', ')}; the model's TOOLS line: ${listed.join(', ')}; SKILLS line: ${line(a, 'SKILLS')}`);
    check(tools.length === 4 && extra.length === 0, `(1) Claude Code sent the API exactly the four garden tools (extra: ${extra.join(', ') || 'none'})`);
    check(listed.every((t) => GARDENER_AGENT_TOOLS.includes(t) || GARDEN.includes(t)) && toolEvents(a).every((t) => GARDENER_AGENT_TOOLS.includes(t)), '(1) the model names and attempts no other tool');
    check(GARDEN.every((t) => a.calls.includes(t)), `(2) all four garden tools were called directly, with no ToolSearch (stub calls: ${a.calls.join(', ')})`);
    const events = new Set(a.hooks.map((h) => String(h.hook_event_name)));
    check(['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Stop'].every((e) => events.has(e)), `(3) --settings hooks fire under --restricted (${[...events].join(', ')})`);
    check(states.some((s) => /^working:mcp__tiller__garden/.test(s)), `(3) the daemon's node status follows the hooks (${[...new Set(states)].join(' → ')})`);
    const measures = a.mod.filter((m) => m.event === 'session.measure');
    const usd = Number(measures.at(-1)?.payload.match(/"usd":([0-9.e-]+)/)?.[1] ?? NaN);
    check(usd > 0 && !measures.some((m) => /"(incomplete|unpricedAdded)":true/.test(m.payload)), `(3) the mod's session.measure reaches the daemon with a priced cost.usd (${measures.length} measures, last usd ${usd})`);
    log(`probe run: tool events ${JSON.stringify(toolEvents(b))}; the model got ${JSON.stringify(line(b, 'PROBE').slice(0, 120))}`);
    check(!b.calls.includes('garden_probe') && !b.prompted && /denied/i.test(line(b, 'PROBE')), '(4) dontAsk denied the non-allowed tool without a prompt (the stub never received it)');
    check(toolEvents(b).includes(PROBE), '(4) the denied call emitted a PreToolUse or PermissionRequest naming it, for the tripwire');
    const models = [...new Set(modelCalls(a).map((m) => m.model))];
    check(models.length > 0 && models.every((m) => m === MODEL), `(5) --model ${MODEL} is accepted (models in the transcript: ${models.join(', ')})`);
    check(c.calls.length > 0 && c.calls.length <= 2, `(5) agent maxTurns 2 plus --max-turns 2 stop the turn interactively (garden_list calls: ${c.calls.length} of the 6 asked)`);
    const out = modelCalls(a).map((m) => m.usage?.output_tokens ?? 0);
    log(`(6) run A: ${out.length} model calls, ${out.reduce((s, n) => s + n, 0)} output tokens in the turn (${out.join('+')}); run D: ${modelCalls(d).length} model calls over ${d.calls.length} tool calls of 20 s`);
    log(`(6) run D mod events: ${d.mod.map((m) => `${m.event}@${((m.at - d.mod[0].at) / 1000).toFixed(1)}s`).join(' ')}`);
    check(midTurnMeasures(d) >= modelCalls(d).length - 1, `(6) session.measure arrives per model call (priced mid-turn measures: run A ${midTurnMeasures(a)} of ${modelCalls(a).length} calls, run D ${midTurnMeasures(d)} of ${modelCalls(d).length})`);
    const loaded = [codeword, '# Working on Tiller'].some((s) => JSON.stringify(a.transcript).includes(s));
    check(!loaded, `(7) the repo's CLAUDE.md and AGENTS.md stay out of the context under --restricted (the model's CODEWORD line: ${JSON.stringify(line(a, 'CODEWORD'))})`);
    log(`permission or trust prompt: ${[a, b, c, d].some((r) => r.prompted) ? 'shown' : 'not shown'}`);
    ws.close();
  } finally {
    rmSync(claudeMd, { force: true });
    daemon.kill('SIGTERM');
  }
}

main().catch((e) => { failures++; log(`ERROR ${e}`); }).finally(() => { log(failures ? `${failures} FAILURE(S)` : 'ALL PASS'); process.exit(failures ? 1 : 0); });
