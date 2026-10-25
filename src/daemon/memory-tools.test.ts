import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NodeManager } from './manager.js';
import { memoryOn, switchMemory } from './memory-config.js';
import type { InjectionView } from './memory-schema.js';
import { startServer, type DaemonServer } from './server.js';

// The memory tools over POST /api/<tool>, as the CLI calls them, with a node's token and the admin token.
let dir: string, home: string, repoA: string, repoB: string, manager: NodeManager, server: DaemonServer;

beforeEach(async () => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'tl-memtools-')));
  home = join(dir, 'home');
  repoA = join(dir, 'a');
  repoB = join(dir, 'b');
  for (const d of [home, repoA, repoB]) mkdirSync(d);
  execFileSync('git', ['init', '-q', repoA]);
  manager = new NodeManager({ home, shell: '/bin/sh' });
  server = await startServer(manager, { port: 0 });
  vi.spyOn(server.updates, 'start').mockImplementation(() => {});
});

afterEach(async () => {
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
/** An agent node in `cwd`: a terminal relabelled, so no harness runs. */
async function agent(cwd: string, title = 'w'): Promise<string> {
  const id = (await api('spawn', { kind: 'terminal', title, cwd })).data.nodeId as string;
  manager.registry.update(id, { kind: 'claude' });
  return id;
}
const on = () => switchMemory(home, {}, 'on');
const memoryDir = () => join(home, 'memory');

describe('memory tools', () => {
  it('are off by default with the source, create nothing, and memory_switch turns them on', async () => {
    const a = await agent(repoA);
    const off = await api('memory_search', { query: 'anything' }, a);
    expect(off.status).toBe(400);
    expect(off.error).toBe(`memory is off for this project (default); the human can turn it on with \`tl memory on --project ${repoA}\``);
    expect((await api('memory_add', { kind: 'note', text: 'x' }, a)).error).toMatch(/^memory is off/);
    expect((await api('memory_search', { query: 'x', repo: repoA })).error).toMatch(/^memory is off/);
    const status = await api('memory_status', { nodeId: a });
    expect(status.data).toMatchObject({ memory: { on: false, source: 'default' }, dbs: [], injections: [] });
    expect(existsSync(memoryDir())).toBe(false);

    const sw = await api('memory_switch', { on: true, project: repoA });
    expect(sw.data).toEqual({ on: true, source: `memory.projects ${repoA} in ${join(home, 'config.json')}` });
    expect(sw.text).toContain('memory is now on');
    const added = await api('memory_add', { kind: 'procedure', text: 'npm test -- src/x.test.ts passes' }, a);
    expect(added.data).toEqual({ id: 1 });
    expect((await api('memory_search', { query: 'npm test' }, a)).text).toMatch(new RegExp(`^m1 · procedure · \\w+ · ${a} claude · npm test`));
    // repoB has no entry: still off there.
    expect((await api('memory_search', { query: 'npm' }, await agent(repoB, 'b'))).error).toMatch(/^memory is off for this project \(default\)/);

    expect((await api('memory_switch', { on: null, project: repoA })).data.on).toBe(false);
    expect((await api('memory_switch', { on: true, project: 'relative/path' })).error).toMatch(/absolute path/);
    expect((await api('memory_switch', { on: true, project: repoA, account: 'x' })).error).toMatch(/not both/);
  });

  it('refuse agents memory_switch, memory_pin, memory_status, purge, repo and account, and pinned items', async () => {
    on();
    const a = await agent(repoA);
    for (const [tool, args] of [['memory_switch', { on: true }], ['memory_pin', { text: 'always run lint' }], ['memory_status', {}], ['memory_status', { repo: repoA }]] as const) {
      expect((await api(tool, args, a)).error).toBe(`${tool} is only for the human`);
    }
    expect(JSON.parse(readFileSync(join(home, 'config.json'), 'utf8')).memory).toEqual({ enabled: true });
    const own = (await api('memory_add', { kind: 'note', text: 'mine' }, a)).data.id as number;
    expect((await api('memory_forget', { id: `m${own}`, reason: 'r', purge: true }, a)).error).toBe('refused: only the human can purge');
    for (const scope of [{ repo: repoB }, { account: 'work' }]) {
      expect((await api('memory_search', { query: 'mine', ...scope }, a)).error).toMatch(/^refused: repo and account are the human's/);
      expect((await api('memory_add', { kind: 'note', text: 'elsewhere', ...scope }, a)).error).toMatch(/^refused/);
    }
    const pin = (await api('memory_pin', { text: 'Never push to main', repo: repoA })).data;
    expect(pin).toMatchObject({ author: 'human', pinned: true, text: 'Never push to main' });
    expect((await api('memory_forget', { id: `m${pin.id}`, reason: 'nope' }, a)).error).toMatch(/is pinned/);
    expect((await api('memory_add', { kind: 'note', text: 'better', supersedes: `m${pin.id}` }, a)).error).toMatch(/is pinned/);
    // The agent's actor is its node: the retraction is an agent's, by that node.
    expect((await api('memory_forget', { id: `m${own}`, reason: 'stale' }, a)).data.invalid).toMatchObject({ kind: 'agent', by: a, reason: 'stale' });
    expect((await api('memory_get', { id: `m${pin.id}` }, a)).text).toMatch(/pinned by the human · recorded by the human/);
  });

  it('memory_status { nodeId } returns its injections as InjectionView data, oldest first', async () => {
    on();
    const a = await agent(repoA);
    const scope = manager.memoryScope(a)!;
    manager.memory.recordInjection(scope, { sessionId: 's-1', arm: 'on', cause: 'config', itemIds: [1, 2], text: '# Memory\n...' });
    manager.memory.recordInjection(scope, { sessionId: 's-1', arm: 'on', cause: 'resume', itemIds: [], text: '' });
    const r = await api('memory_status', { nodeId: a, days: 30 });
    expect(r.status).toBe(200);
    const injections: InjectionView[] = r.data.injections;
    expect(injections).toEqual([
      { sessionId: 's-1', arm: 'on', cause: 'config', itemIds: [1, 2], text: '# Memory\n...', ts: expect.any(Number) },
      { sessionId: 's-1', arm: 'on', cause: 'resume', itemIds: [], text: '', ts: expect.any(Number) },
    ]);
    expect(r.data.memory).toEqual({ on: true, source: `memory.enabled in ${join(home, 'config.json')}` });
    expect(r.data.dbs).toMatchObject([{ key: '_default', state: 'ok', schema: 2 }]);
    expect(r.data.arms.on.nodes).toBe(1);
    expect(r.text).toContain(`injections of ${a}: 2`);
  });

  it('hides another repository\'s items: get, forget and search see no such item', async () => {
    on();
    const a = await agent(repoA, 'a'), b = await agent(repoB, 'b');
    const id = (await api('memory_add', { kind: 'pitfall', text: 'secret plans fail on Fridays' }, a)).data.id as number;
    expect((await api('memory_get', { id: `m${id}` }, b)).error).toBe(`no such item m${id}`);
    expect((await api('memory_forget', { id: `m${id}`, reason: 'x' }, b)).error).toBe(`no such item m${id}`);
    expect((await api('memory_search', { query: 'secret plans' }, b)).data).toEqual([]);
    expect((await api('memory_get', { id: `m${id}`, repo: repoB })).error).toBe(`no such item m${id}`);
    expect((await api('memory_get', { id: 'm99999999999999999' }, a)).status).toBe(400); // past the ref pattern
    expect((await api('memory_get', { id: `m${id}` }, a)).data).toMatchObject({ id, text: 'secret plans fail on Fridays', gets: 1 });
  });

  it('caps an agent at 20 adds; the human is not capped', async () => {
    on();
    const a = await agent(repoA);
    for (let i = 0; i < 20; i++) expect((await api('memory_add', { kind: 'note', text: `note number ${i}` }, a)).status).toBe(200);
    expect((await api('memory_add', { kind: 'note', text: 'one too many' }, a)).error).toBe('memory_add is limited to 20 per node');
    expect((await api('memory_add', { kind: 'note', text: 'the human adds', repo: repoA })).status).toBe(200);
    expect((await api('memory_add', { kind: 'ledger', text: 'x' }, a)).status).toBe(400); // not an add kind
    expect((await api('memory_add', { kind: 'note', text: 'x'.repeat(301) }, a)).status).toBe(400);
  });

  it('returns results for hostile queries, which never reach FTS5 as syntax', async () => {
    on();
    const a = await agent(repoA);
    await api('memory_add', { kind: 'pitfall', text: 'vitest watch mode hangs in CI' }, a);
    for (const query of ['"vitest" OR NEAR(watch', 'vitest*', '-vitest ^hangs', 'col:vitest AND (', "vitest'; DROP TABLE items; --", 'watch\u0000mode']) {
      const r = await api('memory_search', { query }, a);
      expect(r.status, query).toBe(200);
      expect(r.data.map((v: { text: string }) => v.text), query).toEqual(['vitest watch mode hangs in CI']);
    }
    expect((await api('memory_search', { query: '"*" ( ) :' }, a)).data).toEqual([]);
  });

  it('the human names the repository by a directory in it, defaulting the account by project', async () => {
    on();
    const a = await agent(repoA);
    const id = (await api('memory_add', { kind: 'note', text: 'from the agent' }, a)).data.id as number;
    expect((await api('memory_get', { id: `m${id}` })).error).toMatch(/^repo is required for the human/);
    expect((await api('memory_get', { id: `m${id}`, repo: 'a' })).error).toMatch(/^repo must be the absolute path of a directory/);
    // A subdirectory of the agent's checkout is the same repository.
    const sub = join(repoA, 'src');
    mkdirSync(sub);
    expect((await api('memory_get', { id: `m${id}`, repo: sub })).data).toMatchObject({ id, nodeId: a, author: 'agent' });
    const mine = await api('memory_add', { kind: 'note', text: 'from the human', repo: sub });
    expect((await api('memory_search', { query: 'human' }, a)).data).toMatchObject([{ id: mine.data.id, author: 'human' }]);
    // The human's forget is sticky; purge leaves a tombstone.
    expect((await api('memory_forget', { id: `m${id}`, reason: 'wrong', purge: true, repo: repoA })).data).toMatchObject({ tombstone: 'purged', text: '' });
    // A named account not in claude.accounts fails closed.
    expect((await api('memory_search', { query: 'x', repo: repoA, account: 'nope' })).error).toMatch(/^memory is off for this project \(Claude account "nope" is not configured/);
  });

  it('hides another repository\'s items from supersedes and pin too', async () => {
    on();
    const a = await agent(repoA, 'a'), b = await agent(repoB, 'b');
    const id = (await api('memory_add', { kind: 'note', text: 'repo a only' }, a)).data.id as number;
    expect((await api('memory_add', { kind: 'note', text: 'correction', supersedes: `m${id}` }, b)).error).toBe(`no such item m${id}`);
    expect((await api('memory_pin', { id: `m${id}`, repo: repoB })).error).toBe(`no such item m${id}`);
    expect((await api('memory_get', { id: `m${id}` }, a)).data).toMatchObject({ pinned: false });
    expect((await api('memory_get', { id: `m${id}` }, a)).data.invalid).toBeUndefined();
  });

  it('caps an agent at 20 forgets', async () => {
    on();
    const a = await agent(repoA);
    const ids: number[] = [];
    for (let i = 0; i < 21; i++) ids.push((await api('memory_add', { kind: 'note', text: `human note ${i}`, repo: repoA })).data.id);
    for (const id of ids.slice(0, 20)) expect((await api('memory_forget', { id: `m${id}`, reason: 'stale' }, a)).status).toBe(200);
    expect((await api('memory_forget', { id: `m${ids[20]}`, reason: 'stale' }, a)).error).toBe('memory_forget is limited to 20 per node');
  });

  /** Two Claude accounts with their own files; work covers repoA, with the given memory setting. */
  function accounts(work: { memory?: boolean } = {}) {
    for (const d of ['cw', 'co']) mkdirSync(join(dir, d), { recursive: true });
    writeFileSync(join(home, 'config.json'), JSON.stringify({ memory: { enabled: true }, claude: { accounts: [
      { name: 'work', configDir: join(dir, 'cw'), projects: [repoA], ...work }, { name: 'other', configDir: join(dir, 'co') },
    ] } }));
  }

  it('keeps accounts apart: one account\'s items are invisible from another', async () => {
    accounts();
    const a = await agent(repoA); // spawned in repoA: account work
    expect(manager.registry.get(a)!.account).toBe('work');
    await api('memory_add', { kind: 'note', text: 'employer detail' }, a);
    expect((await api('memory_search', { query: 'employer', repo: repoA })).data).toHaveLength(1); // the project's account
    expect((await api('memory_search', { query: 'employer', repo: repoA, account: 'work' })).data).toHaveLength(1);
    expect((await api('memory_search', { query: 'employer', repo: repoA, account: 'other' })).data).toEqual([]);
    expect(existsSync(join(memoryDir(), 'work.db'))).toBe(true);
    expect(existsSync(join(memoryDir(), 'other.db'))).toBe(false);
  });

  it('memory_switch reports the account ceiling that keeps a project off, and the off reply names it', async () => {
    accounts({ memory: false });
    const sw = await api('memory_switch', { on: true, project: repoA });
    const source = `claude.accounts work.memory in ${join(home, 'config.json')}`;
    expect(sw.data).toEqual({ on: false, source });
    expect(sw.text).toBe(`project ${repoA}: on, but memory stays off there: ${source} decides (that is the account's ceiling, which no project setting lifts)`);
    const a = await agent(repoA);
    expect((await api('memory_search', { query: 'x' }, a)).error).toBe(`memory is off for this project (${source}); that is the account's ceiling, which no project setting lifts`);
    // Without the ceiling, the same switch turns it on.
    accounts();
    expect((await api('memory_switch', { on: true, project: repoA })).text).toMatch(/: on; memory is now on there \(memory.projects /);
  });

  it('memory_status names an unknown node and reads a closed one from its archive', async () => {
    on();
    expect((await api('memory_status', { nodeId: 'n-nope' })).error).toBe('no such node: n-nope');
    const a = await agent(repoA);
    manager.memory.recordInjection(manager.memoryScope(a)!, { sessionId: 's-a', arm: 'off', cause: 'ab', itemIds: [], text: 'shadow' });
    await manager.close(a, true);
    const r = await api('memory_status', { nodeId: a });
    expect(r.text).toContain(`for ${repoA}, node ${a} (closed)`);
    expect(r.data.injections).toMatchObject([{ sessionId: 's-a', arm: 'off', cause: 'ab', text: 'shadow' }]);
  });

  it('memory_status without a node or repo names the global setting and the projects and accounts that have their own', async () => {
    for (const d of ['cw', 'cp', 'cx']) mkdirSync(join(dir, d), { recursive: true });
    writeFileSync(join(home, 'config.json'), JSON.stringify({
      memory: { projects: [{ path: repoA, enabled: true }, { path: repoB, enabled: false }] },
      claude: { accounts: [{ name: 'work', configDir: join(dir, 'cw'), memory: false }, { name: 'personal', configDir: join(dir, 'cp'), memory: true }, { name: 'plain', configDir: join(dir, 'cx') }] },
    }));
    const r = await api('memory_status', {});
    expect(r.status).toBe(200);
    expect(r.text!.split('\n').slice(0, 3)).toEqual([
      'memory.enabled (global): off (default)',
      `projects with their own setting: ${repoA} on, ${repoB} off`,
      'accounts: work off (ceiling), personal on',
    ]);
    switchMemory(home, {}, 'on');
    expect((await api('memory_status', {})).text!.split('\n')[0]).toBe(`memory.enabled (global): on (set in ${join(home, 'config.json')})`);
  });

  it('memory_status { repo } resolves the main checkout of a subdirectory or a linked worktree and matches memoryOn', async () => {
    switchMemory(home, { project: repoA }, 'on');
    const sub = join(repoA, 'src'), linked = join(dir, 'linked');
    mkdirSync(sub);
    execFileSync('git', ['-C', repoA, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'init']);
    execFileSync('git', ['-C', repoA, 'worktree', 'add', '-q', linked]);
    const want = memoryOn(home, repoA, undefined);
    expect(want.on).toBe(true);
    for (const repo of [repoA, sub, linked]) {
      const r = await api('memory_status', { repo });
      expect(r.text!.split('\n')[0], repo).toBe(`memory is on for ${repoA} (${want.source})`);
      expect(r.data, repo).toMatchObject({ memory: want, project: repoA });
    }
    // repoB is another project with no setting.
    expect((await api('memory_status', { repo: repoB })).text!.split('\n')[0]).toBe(`memory is off for ${repoB} (default)`);
    expect((await api('memory_status', { repo: 'a' })).error).toMatch(/^repo must be the absolute path of a directory/);
    expect((await api('memory_status', { repo: join(repoA, 'nope') })).error).toMatch(/^repo must be the absolute path of a directory/);
  });

  it('memory_status reports an invalid claude.accounts list as off with its reason, and still prints the rest', async () => {
    const link = join(dir, 'link');
    symlinkSync(repoB, link); // a non-git directory reached through a symlink prints as its real path
    writeFileSync(join(home, 'config.json'), JSON.stringify({ memory: { enabled: true }, claude: { accounts: [{ name: 'bad', configDir: '~/.claude' }] } }));
    for (const args of [{ repo: repoA }, { repo: link }]) {
      const r = await api('memory_status', args);
      expect(r.status, JSON.stringify(args)).toBe(200);
      expect(r.data.memory.on).toBe(false);
      expect(r.text).toMatch(new RegExp(`^memory is off for ${args.repo === link ? repoB : repoA} \\(.*claude\\.accounts`));
      expect(r.text).toContain('digest arms');
    }
    const bare = await api('memory_status', {});
    expect(bare.text!.split('\n')[2]).toMatch(/^accounts: .*claude\.accounts/);
  });

  it('memory_status says "no memory file yet" only while no *.db exists', async () => {
    const none = 'no memory file yet: one is created at the first capture after memory is on for a project';
    expect((await api('memory_status', {})).text).toContain(none);
    expect(existsSync(memoryDir())).toBe(false);
    on();
    await api('memory_add', { kind: 'note', text: 'first', repo: repoA });
    expect((await api('memory_status', {})).text).not.toContain('no memory file yet');
    // Another account's missing file is not "no memory file yet".
    accounts();
    const r = await api('memory_status', { account: 'other' });
    expect(r.text).not.toContain('no memory file yet');
    expect(r.data.dbs).toMatchObject([{ key: 'other', state: 'missing' }]);
  });

  it('over MCP, an agent sees no memory tools while memory is off, and then four without repo or account', async () => {
    const a = await agent(repoA);
    const tools = async () => {
      const c = new Client({ name: 't', version: '0' });
      await c.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${server.port}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${manager.tokenFor(a)}`, 'X-TL-Node': a } } }));
      return c;
    };
    const off = await tools();
    expect((await off.listTools()).tools.filter((t) => t.name.startsWith('memory_'))).toEqual([]);
    await off.close();
    on();
    const c = await tools();
    const listed = (await c.listTools()).tools.filter((t) => t.name.startsWith('memory_'));
    expect(listed.map((t) => t.name).sort()).toEqual(['memory_add', 'memory_forget', 'memory_get', 'memory_search']);
    for (const t of listed) {
      expect(t.inputSchema.properties, t.name).toHaveProperty(t.name === 'memory_search' ? 'query' : t.name === 'memory_add' ? 'text' : 'id');
      expect(t.inputSchema.properties, t.name).not.toHaveProperty('repo');
      expect(t.inputSchema.properties, t.name).not.toHaveProperty('account');
    }
    const missing = await c.callTool({ name: 'memory_get', arguments: { id: 'm999' } });
    expect(missing).toMatchObject({ isError: true, content: [{ type: 'text', text: 'no such item m999' }] });
    await c.callTool({ name: 'memory_add', arguments: { kind: 'note', text: 'over mcp' } });
    // The reply is its text alone, without the JSON block /api carries.
    const found = await c.callTool({ name: 'memory_search', arguments: { query: 'mcp' } });
    expect(found.content).toEqual([{ type: 'text', text: expect.stringMatching(/^m1 · note · .* · over mcp$/) }]);
    await c.close();
  });
});
