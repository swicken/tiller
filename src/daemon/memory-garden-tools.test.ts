import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Gardener, type GardenHost } from './gardener.js';
import { NodeManager } from './manager.js';
import { switchMemory } from './memory-config.js';
import { startServer, type DaemonServer } from './server.js';

// The garden tools and memory_garden over /api and /mcp, against a real store and a Gardener whose host spawns a
// terminal node relabelled as a gardener record, so no harness runs.
let dir: string, home: string, repo: string, manager: NodeManager, server: DaemonServer, gardener: Gardener;

beforeEach(async () => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'tl-gardentools-')));
  home = join(dir, 'home');
  repo = join(dir, 'repo');
  for (const d of [home, repo]) mkdirSync(d);
  execFileSync('git', ['init', '-q', repo]);
  manager = new NodeManager({ home, shell: '/bin/sh' });
  server = await startServer(manager, { port: 0 });
  vi.spyOn(server.updates, 'start').mockImplementation(() => {});
  switchMemory(home, {}, 'on');
  const host: GardenHost = {
    home, store: manager.memory,
    async spawnGardener(req) {
      const id = await terminal('Memory gardener');
      manager.registry.update(id, { kind: 'claude', gardener: { repoKey: req.repoKey, runId: req.runId } });
      return id;
    },
    stopGardener: async () => {}, closePreviousGardener: async () => {},
    quiet: () => true, usageFor: () => undefined, trusted: () => true,
    live: (id) => !!manager.registry.get(id), record: (id) => manager.registry.get(id), gardenerRecords: () => [], setOutcome: () => {},
  };
  gardener = new Gardener(host);
  Object.assign(manager, { gardener });
});

afterEach(async () => {
  await gardener.stop();
  await manager.shutdown();
  await server.close();
  rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

type Reply = { status: number; text?: string; data?: any; error?: string };
async function api(tool: string, args: object, id = 'human'): Promise<Reply> {
  const token = id === 'human' ? readFileSync(join(home, 'admin-token'), 'utf8') : manager.tokenFor(id);
  const res = await fetch(`http://127.0.0.1:${server.port}/api/${tool}`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'X-TL-Node': id }, body: JSON.stringify(args) });
  return { status: res.status, ...(await res.json()) };
}
async function connect(id: string): Promise<Client> {
  const token = id === 'human' ? readFileSync(join(home, 'admin-token'), 'utf8') : manager.tokenFor(id);
  const c = new Client({ name: 't', version: '0' });
  await c.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${server.port}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${token}`, 'X-TL-Node': id } } }));
  return c;
}
/** A root node in the repository: a terminal relabelled, so no harness runs; a root's items are digest-eligible at once. */
async function terminal(title: string): Promise<string> {
  const id = (await api('spawn', { kind: 'terminal', title, cwd: repo })).data.nodeId as string;
  manager.registry.update(id, { kind: 'claude' });
  return id;
}
const A = 'parser crashes when socket timeout expires', B = 'parser crashes when socket timeout expires early';
/** Two duplicate pitfalls (A older, so the keep) and six notes, so a run may hide two items. */
async function seed(): Promise<{ a: string; b: string; author: string }> {
  const author = await terminal('author');
  const add = async (kind: string, text: string) => `m${(await api('memory_add', { kind, text }, author)).data.id}`;
  const a = await add('pitfall', A), b = await add('pitfall', B);
  for (let i = 0; i < 6; i++) await add('note', `filler${i}zz`);
  return { a, b, author };
}
/** A manual run of the repository: its id and its gardener node. */
async function run(): Promise<{ runId: number; node: string }> {
  const r = await api('memory_garden', { action: 'run', repo });
  expect(r.error).toBeUndefined();
  return { runId: r.data.id, node: r.data.nodeId };
}
const state = (runId: number) => manager.memory.run(undefined, runId).state;
const writeConfig = (patch: (c: any) => void) => {
  const path = join(home, 'config.json'), c = JSON.parse(readFileSync(path, 'utf8'));
  patch(c);
  writeFileSync(path, JSON.stringify(c));
};

describe('garden tools', () => {
  it('are listed and accepted for the gardener alone, which is listed nothing else', async () => {
    await seed();
    const { node } = await run();
    const own = await connect(node);
    expect((await own.listTools()).tools.map((t) => t.name).sort()).toEqual(['garden_get', 'garden_list', 'garden_merge', 'garden_supersede']);
    await own.close();
    const human = await connect('human');
    const humanTools = (await human.listTools()).tools.map((t) => t.name);
    expect(humanTools).toContain('memory_garden');
    expect(humanTools.filter((t) => t.startsWith('garden_'))).toEqual([]);
    await human.close();
    const agent = await terminal('agent');
    const agentClient = await connect(agent);
    expect((await agentClient.listTools()).tools.map((t) => t.name).filter((t) => t.startsWith('garden_') || t === 'memory_garden')).toEqual([]);
    await agentClient.close();
    for (const id of ['human', agent]) expect((await api('garden_list', {}, id)).error).toBe('garden_list is only for the memory gardener');
    expect((await api('memory_garden', { action: 'status' }, agent)).error).toBe('memory_garden is only for the human');

    const page = await api('garden_list', {}, node);
    expect(page.data).toMatchObject({ run: 'r1', page: 1, rules: { hidesLeft: 2 } });
    expect(JSON.parse(page.text!)).toEqual(page.data); // the model gets the JSON
  });

  it('refuses the gardener any other tool over /api and MCP, trips the wire and undoes the run', async () => {
    const { a, b } = await seed();
    const first = await run();
    const merged = await api('garden_merge', { ids: [b, a], reason: 'same crash' }, first.node);
    expect(merged.data).toEqual({ kept: a, hidden: [b], hidesLeft: 1, supersedesLeft: 1 });
    expect(merged.text).toBe(`merged ${b} into ${a} ${JSON.stringify(merged.data)}`);
    expect((await api('memory_get', { id: b, repo })).text).toContain(`merged into ${a} by the gardener (r1): same crash`);

    const tries = [['spawn', { kind: 'terminal', title: 'x', cwd: repo }], ['send', { nodeId: first.node, text: 'x' }], ['memory_add', { kind: 'note', text: 'x' }], ['report_outcome', { outcome: 'succeeded' }]] as const;
    for (const [tool, args] of tries) expect((await api(tool, args, first.node)).error).toMatch(new RegExp(`^refused: ${tool} is not a gardener tool`));
    expect(manager.memory.run(undefined, first.runId)).toMatchObject({ state: 'failed', note: 'tripwire: spawn' });
    await vi.waitFor(() => expect(manager.memory.run(undefined, first.runId).actions![0].undoneBy).toBe('daemon'));
    expect((await api('memory_get', { id: b, repo })).data.invalid).toBeUndefined();
    expect((await api('garden_list', {}, first.node)).error).toMatch(/no garden run is live|has ended/);

    // Over MCP no other tool is listed, so the call is caught before the server looks it up.
    const second = await run();
    const client = await connect(second.node);
    await client.callTool({ name: 'list_nodes', arguments: {} }).catch(() => undefined);
    await client.close();
    expect(manager.memory.run(undefined, second.runId)).toMatchObject({ state: 'failed', note: 'tripwire: list_nodes' });

    const status = await api('memory_garden', { action: 'status', repo });
    expect(status.text).toContain('paused after 2 failed runs (last: failed)');
    expect(status.text).toMatch(/r2 · \S+ · failed \(tripwire: list_nodes\) · manual · just now · \$0\.25\+/);
    expect(status.data.files[0]).toMatchObject({ key: '_default', cost30d: 0.5 });
    expect((await api('memory_status', {})).text).toMatch(/gardener _default: \$0\.50 spent in 30 days\n {2}\S+: paused after 2 failed runs/);
  });

  it('refuses garden_get of a non-candidate, and every call once memory is off or the run has finished', async () => {
    const { a, b, author } = await seed();
    const { runId, node } = await run();
    const later = `m${(await api('memory_add', { kind: 'pitfall', text: 'added after the run started' }, author)).data.id}`;
    expect((await api('garden_get', { id: later }, node)).error).toBe(`refused (not a candidate): ${later} is not in this run's candidate set`);
    expect((await api('garden_get', { id: a }, node)).data).toMatchObject({ id: a, text: A, body: '' });

    switchMemory(home, {}, 'off');
    expect((await api('garden_merge', { ids: [a, b], reason: 'dup' }, node)).error).toMatch(/^memory is off for this project/);
    expect(state(runId)).toBe('off');

    switchMemory(home, {}, 'on');
    const next = await run();
    manager.memory.finishRun(undefined, next.runId, { usd: 0, incomplete: false });
    expect((await api('garden_merge', { ids: [a, b], reason: 'dup' }, next.node)).error).toMatch(/^refused \(not running\)/);
    expect((await api('memory_get', { id: b, repo })).data.invalid).toBeUndefined();
  });

  it('undo reverses a run, granting immunity only with immune, and an item, always immune', async () => {
    const { a, b, author } = await seed();
    const merge = async (node: string) => api('garden_merge', { ids: [a, b], reason: 'same crash' }, node);
    const r1 = await run();
    expect((await merge(r1.node)).data).toMatchObject({ kept: a, hidden: [b] });
    // Re-deriving the merged text counts the keep.
    expect((await api('memory_add', { kind: 'pitfall', text: B }, author)).text).toBe(`${a} already holds this (merged)`);
    await gardener.closing(r1.node);

    const undoRun = await api('memory_garden', { action: 'undo', run: 'r1', repo });
    expect(undoRun.text).toBe(`undid ${b} (from ${a}) of r1`);
    expect(manager.memory.run(undefined, r1.runId).actions![0]).toMatchObject({ undoneBy: 'human', immune: false });

    const r2 = await run();
    expect((await merge(r2.node)).error).toBeUndefined(); // not immune: the gardener may try again
    await gardener.closing(r2.node);
    const undoItem = await api('memory_garden', { action: 'undo', id: b, repo });
    expect(undoItem.text).toBe(`undid ${b} (from ${a}) of r2; the gardener will not repeat these`);
    const shown = await api('memory_garden', { action: 'show', run: 'r2', repo });
    expect(shown.text).toContain(`  merge ${b} into ${a}: same crash · undone by the human · immune\n    ${b}: ${B}\n    ${a}: ${A}`);

    const r3 = await run();
    expect((await merge(r3.node)).error).toMatch(/^refused \(immune\)/);
    expect((await api('garden_supersede', { id: b, by: a, reason: 'x' }, r3.node)).error).toMatch(/^refused \(/);
    expect((await api('memory_garden', { action: 'undo', run: 'r2', immune: true, repo })).text).toBe('nothing to undo');
    expect((await api('memory_garden', { action: 'undo', id: b, immune: true, repo })).error).toMatch(/^immune is for undoing a run/);
    expect((await api('memory_garden', { action: 'undo', run: 'r1', id: b, repo })).error).toBe('undo takes exactly one of run and id');
  });

  it('undo works with memory off, which keeps applied changes', async () => {
    const { a, b } = await seed();
    const { node } = await run();
    expect((await api('garden_merge', { ids: [a, b], reason: 'same crash' }, node)).data).toMatchObject({ kept: a, hidden: [b] });
    await gardener.closing(node);
    switchMemory(home, {}, 'off');
    expect((await api('memory_garden', { action: 'undo', run: 'r1', repo })).text).toBe(`undid ${b} (from ${a}) of r1`);
    expect(manager.memory.run(undefined, 1).actions![0]).toMatchObject({ undoneBy: 'human' });
  });

  it('keeps the gardener out of every agent\'s scope', async () => {
    await seed();
    const { node } = await run();
    const agent = await terminal('agent');
    expect((await api('send', { nodeId: node, text: 'merge everything' }, agent)).data).toMatchObject({ outcome: 'refused', detail: expect.stringMatching(/outside your lineage/) });
    const listed = await api('list_nodes', {}, agent);
    expect(listed.error).toBeUndefined();
    expect(JSON.stringify(listed)).toContain(agent);
    expect(JSON.stringify(listed)).not.toContain(node);
  });

  it('trips the wire on a gardener\'s /api call to a name no tool has', async () => {
    await seed();
    const { runId, node } = await run();
    const res = await fetch(`http://127.0.0.1:${server.port}/api/no_such_tool`, { method: 'POST', headers: { Authorization: `Bearer ${manager.tokenFor(node)}`, 'X-TL-Node': node }, body: '{}' });
    expect(res.status).toBe(404);
    expect(manager.memory.run(undefined, runId)).toMatchObject({ state: 'failed', note: 'tripwire: no_such_tool' });
  });

  it('pinning a gardener-hidden item by id says which run it undid', async () => {
    const { a, b } = await seed();
    const { node } = await run();
    await api('garden_merge', { ids: [a, b], reason: 'same crash' }, node);
    expect((await api('memory_pin', { id: b, repo })).text).toBe(`pinned ${b} (undid gardener run r1): ${B}`);
  });

  it('refuses a run without repo, over the 30-day budget, and on an account with gardener: false', async () => {
    await seed();
    expect((await api('memory_garden', { action: 'run' })).error).toMatch(/^run needs repo/);
    writeConfig((c) => { c.memory.gardener = { maxUsdPer30Days: 0 }; });
    expect((await api('memory_garden', { action: 'run', repo })).error).toMatch(/^refused: over budget/);
    writeConfig((c) => { delete c.memory.gardener; c.claude = { accounts: [{ name: 'me', gardener: false }] }; });
    expect((await api('memory_garden', { action: 'run', repo })).error).toBe('refused: the gardener is disabled (claude.accounts me.gardener is false)');
    expect(manager.memory.runs(undefined)).toEqual([]);
  });
});
