import { execFile, execFileSync } from 'node:child_process';
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { systemPrompt } from './launch.js';
import { NodeManager } from './manager.js';
import { mountMcp } from './mcp.js';
import { inbox } from './messaging.js';

let home = '', manager: NodeManager, server: http.Server, base = '', admin = '';
const confirms: string[] = [];
let answer = true;
const focused: string[][] = [];

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), 'tl-mcp-'));
  manager = new NodeManager({ home, shell: '/bin/sh' });
  const { handler, publishAdminToken } = mountMcp(manager, async (t) => { confirms.push(t); return answer; }, (from, id) => focused.push([from, id]));
  expect(() => readFileSync(join(home, 'admin-token'))).toThrow(); // not written until the server is listening
  server = http.createServer((req, res) => void handler(req, res));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  publishAdminToken();
  admin = readFileSync(join(home, 'admin-token'), 'utf8');
});
afterAll(async () => {
  await manager.shutdown();
  server.closeAllConnections();
  await new Promise((r) => server.close(r));
  rmSync(home, { recursive: true, force: true });
});

const api = async (tool: string, args: object, id = 'human', token = admin) => {
  const res = await fetch(`${base}/api/${tool}`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'X-TL-Node': id }, body: JSON.stringify(args) });
  return { status: res.status, body: (await res.json().catch(() => ({}))) as { text?: string; data?: any; error?: string } };
};
const spawnT = (title: string, id = 'human', token = admin, extra = {}) => api('spawn', { kind: 'terminal', title, cwd: tmpdir(), ...extra }, id, token);

describe('mcp api', () => {
  it('keeps the admin token across daemon starts on the same home', () => {
    const again = join(home, 'restart');
    mkdirSync(again);
    writeFileSync(join(again, 'admin-token'), admin);
    const m = new NodeManager({ home: again, shell: '/bin/sh' }); // a second mount on the shared manager would double its notices
    mountMcp(m, async () => true, () => {}).publishAdminToken();
    m.shutdown();
    expect(readFileSync(join(again, 'admin-token'), 'utf8')).toBe(admin);
  });
  it('accepts and lists resolved profiles through CLI spawn and rejects invalid MCP profiles', async () => {
    const dependency = (await spawnT('profile dependency')).body.data.nodeId;
    writeFileSync(join(home, 'config.json'), JSON.stringify({ profiles: { codex: { reviewer: { model: 'configured-codex', effort: 'high' } } } }));
    const env = { ...process.env, TL_HOME: home, TL_ENDPOINT: base, TL_NODE_ID: '', TL_TOKEN_FILE: '' };
    const run = promisify(execFile);
    const { stdout } = await run(join(import.meta.dirname, '../../bin/tl'), ['spawn', '--harness', 'codex', '--profile', 'reviewer', '--role', 'worker', '--title', 'CLI profile', '--cwd', home, '--after-success', dependency], { env });
    const id = JSON.parse(stdout).nodeId;
    expect(manager.view(id)).toMatchObject({ profile: 'reviewer', model: 'configured-codex', effort: 'high', pending: { afterSuccess: [dependency] } });
    const listed = (await api('list_nodes', {})).body;
    expect(listed.data.find((n: { id: string }) => n.id === id)).toMatchObject({ profile: 'reviewer', model: 'configured-codex', effort: 'high' });
    expect(listed.text).toContain('profile reviewer');
    const bad = await api('spawn', { kind: 'agent', harness: 'codex', title: 'bad', cwd: home, profile: 'worker' });
    expect(bad.status).toBe(400);
    expect(bad.body.error).toContain('profile');
    const config = await run(join(import.meta.dirname, '../../bin/tl'), ['config', '--cwd', home], { env });
    expect(config.stdout).toContain('profiles.codex.reviewer.model');
    expect(config.stdout).toContain('configured-codex');
    rmSync(join(home, 'config.json'));
    await manager.close(id, true);
    await manager.close(dependency, true);
  });

  it('rejects missing or wrong credentials', async () => {
    expect((await api('list_nodes', {}, 'human', 'nope')).status).toBe(401);
    expect((await api('list_nodes', {}, 'n-ghost', manager.tokenFor('n-ghost'))).status).toBe(401);
  });

  it('allows changing harness only with human credentials and validates target values', async () => {
    const id = (await spawnT('restricted caller')).body.data.nodeId;
    expect((await api('change_harness', { nodeId: id, harness: 'pi' }, id, manager.tokenFor(id))).body.error).toContain('only for the human');
    expect((await api('change_harness', { nodeId: id, harness: 'pi' }, 'human', 'wrong')).status).toBe(401);
    expect((await api('change_harness', { nodeId: id, harness: 'invalid' })).body.error).toContain('harness');
    expect((await api('change_harness', { nodeId: id, harness: 'pi' })).body.error).toContain('Only agent nodes');
    await manager.close(id, true);
  });

  it('spawn is idempotent per requestId and parents the node to the caller', async () => {
    const a = await spawnT('parent', 'human', admin, { requestId: 'r1' });
    const id = a.body.data.nodeId as string;
    expect((await spawnT('parent', 'human', admin, { requestId: 'r1' })).body.data).toEqual({ nodeId: id, replayed: true });
    expect((await spawnT('other', 'human', admin, { requestId: 'r1' })).status).toBe(400);
    const child = (await spawnT('kid', id, manager.tokenFor(id))).body.data.nodeId as string;
    expect(manager.view(child)?.parentId).toBe(id);
    const list = (await api('list_nodes', {})).body;
    expect(list.text).toContain(`  - ${child} "kid"`);
    expect(list.text?.split('\n')[0]).toBe('usage: no report yet');
    expect(list.data.find((n: any) => n.id === child)).toMatchObject({ parentId: id, kind: 'terminal', flags: [] });
    manager.registry.update(id, { spentUsd: 1 });
    manager.registry.update(child, { spentUsd: 2 });
    const spent = (await api('list_nodes', {})).body;
    expect(spent.data.find((n: any) => n.id === id)).toMatchObject({ spentUsd: 1, subtreeSpentUsd: 3 });
    expect(spent.text).toContain(`- ${id} "parent" [terminal] none now · $1.00 (tree $3.00)`);
    expect(spent.data.find((n: any) => n.id === id)).not.toHaveProperty('subtreeSpentIncomplete');
    // A child with unpriced usage makes its own figure and every ancestor's tree total a lower bound.
    manager.registry.update(child, { spentIncomplete: true });
    const partial = (await api('list_nodes', {})).body;
    expect(partial.data.find((n: any) => n.id === id)).toMatchObject({ spentUsd: 1, subtreeSpentUsd: 3, subtreeSpentIncomplete: true });
    expect(partial.data.find((n: any) => n.id === id)).not.toHaveProperty('spentIncomplete');
    expect(partial.data.find((n: any) => n.id === child)).toMatchObject({ spentIncomplete: true, subtreeSpentIncomplete: true });
    expect(partial.text).toContain(`- ${id} "parent" [terminal] none now · $1.00 (tree $3.00+)`);
    expect(partial.text).toContain(`${child} "kid" [terminal] none now · $2.00+`);
  });

  it('refuses to close an orchestrator unless the human forces it; restart is human-only', async () => {
    const root = (await spawnT('root')).body.data.nodeId as string;
    const kid = (await spawnT('kid', root, manager.tokenFor(root))).body.data.nodeId as string;
    const tok = (id: string) => manager.tokenFor(id);
    expect((await api('close', { nodeIds: [root] }, kid, tok(kid))).body.error).toMatch(/descendants/); // a child cannot reach its parent
    expect((await api('close', { nodeIds: [root] }, root, tok(root))).body.error).toMatch(/descendants/); // nor itself
    expect((await api('close', { nodeIds: [root], force: true }, kid, tok(kid))).status).toBe(400);
    expect((await api('close', { nodeIds: [root] })).body.error).toBe(`refusing to close an orchestrator; use tl kill --force ${root}`);
    expect(manager.view(root)).toBeDefined();
    expect((await api('restart', { nodeId: root }, kid, tok(kid))).body.error).toMatch(/only for the human/);
    expect((await api('restart', { nodeId: root })).body.data).toEqual({ ok: true });
    expect(manager.view(kid)!.parentId).toBe(root);
    expect((await api('close', { nodeIds: [root], force: true })).body.data).toMatchObject({ ok: true });
    expect(manager.view(root)).toBeUndefined();
  });

  it('enforces read scope and descendant-only close, with one confirm per batch', async () => {
    const p = (await spawnT('p2')).body.data.nodeId as string;
    const c1 = (await spawnT('c1', p, manager.tokenFor(p))).body.data.nodeId as string;
    const c2 = (await spawnT('c2', p, manager.tokenFor(p))).body.data.nodeId as string;
    const stranger = (await spawnT('stranger')).body.data.nodeId as string;
    const tok = (id: string) => manager.tokenFor(id);
    expect((await api('read', { nodeId: c2, what: 'terminal', lines: 3 }, c1, tok(c1))).status).toBe(200); // sibling
    expect((await api('read', { nodeId: stranger, what: 'terminal' }, c1, tok(c1))).status).toBe(400);
    expect((await api('close', { nodeIds: [c1, stranger] }, p, tok(p))).body.error).toMatch(/descendants/);
    expect(manager.view(c1)).toBeDefined(); // whole batch refused
    confirms.length = 0;
    expect((await api('close', { nodeIds: [c1, c2] }, p, tok(p))).body.data).toMatchObject({ ok: true });
    expect(confirms).toHaveLength(1);
    expect(manager.view(c1)).toBeUndefined();
    answer = false;
    const c3 = (await spawnT('c3', p, manager.tokenFor(p))).body.data.nodeId as string;
    expect((await api('write', { nodeId: c3, text: 'ls\r' }, p, tok(p))).body.data).toEqual({ ok: false, reason: 'denied' });
    answer = true;
  });

  it('fork, read and history reach a closed node only in the caller\'s own tree; fork of a live node needs scope', async () => {
    const tok = (id: string) => manager.tokenFor(id);
    const transcript = join(home, 'archived.jsonl');
    writeFileSync(transcript, `${JSON.stringify({ type: 'user', message: { content: 'hello there' } })}\n`);
    /** A Claude node that ran under `parentId`, closed; no claude process is launched. */
    const archived = (parentId: string, title: string) => {
      const id = manager.registry.create({ parentId, kind: 'claude', title, cwd: tmpdir(), lastActiveAt: Date.now(), prompt: `${title} task`, sessionId: `s-${title}`, transcriptPath: transcript }).id;
      manager.runtimes.set(id, {});
      manager.closed(id);
      return id;
    };
    const rootA = (await spawnT('treeA')).body.data.nodeId as string;
    const kidA = (await spawnT('kidA', rootA, tok(rootA))).body.data.nodeId as string;
    const rootB = (await spawnT('treeB')).body.data.nodeId as string;
    const kidB = (await spawnT('kidB', rootB, tok(rootB))).body.data.nodeId as string;
    const oldA = archived(rootA, 'old-a'), oldB = archived(rootB, 'old-b');
    const fork = (from: string) => api('spawn', { kind: 'claude', title: 'f', fork: from }, kidA, tok(kidA));
    expect((await fork(kidB)).body.error).toMatch(/outside your lineage/);
    expect((await fork(oldB)).body.error).toBe(`refused: archived node ${oldB} is not of your own tree`);
    expect((await api('spawn', { kind: 'claude', title: 'f' }, kidA, tok(kidA))).body.error).toMatch(/cwd is required unless you fork/);
    expect((await api('read', { nodeId: oldA, what: 'summary' }, kidA, tok(kidA))).body.text).toBe('user: hello there');
    expect((await api('read', { nodeId: oldB, what: 'summary' }, kidA, tok(kidA))).status).toBe(400);
    // A line in tree B's archive cannot claim tree A by naming it: the tree is the directory the line sits in.
    appendFileSync(join(manager.sessionDirOf(rootB), 'archive.jsonl'), `${JSON.stringify({ id: 'n-forged', rootId: rootA, parentId: rootA, title: 'f', cwd: tmpdir(), sessionId: 's', transcriptPath: transcript, createdAt: 0, closedAt: 0 })}\n`);
    expect((await api('read', { nodeId: 'n-forged', what: 'summary' }, kidA, tok(kidA))).body.error).toBe('refused: archived node n-forged is not of your own tree');
    const mine = (await api('history', { rootId: rootB }, kidA, tok(kidA))).body.text!; // an agent always gets its own tree
    expect(mine).toMatch(new RegExp(`^${oldA} "old-a" closed just now: old-a task$`));
    const all = (await api('history', { query: 'old-' })).body.text!;
    expect(all).toContain(oldA);
    expect(all).toContain(oldB);
    expect((await api('transcript', { nodeId: oldB })).body.text).toBe('sessions: s-old-b (current)\n\nuser: hello there');
    expect((await api('followup', { nodeId: oldA, prompt: 'x' }, kidA, tok(kidA))).body.error).toBe('followup is only for the human');
    for (const id of [kidA, kidB, rootA, rootB]) await manager.close(id, true); // the shared manager's maxLiveNodes
  });

  it('approvals.close in the caller\'s project config skips the confirm only as configured', async () => {
    const proj = join(home, 'proj');
    mkdirSync(join(proj, '.tiller'), { recursive: true });
    const setMode = (mode: string) => writeFileSync(join(proj, '.tiller', 'config.json'), JSON.stringify({ approvals: { close: mode } }));
    const p = (await spawnT('cfg', 'human', admin, { cwd: proj })).body.data.nodeId as string;
    const tok = manager.tokenFor(p);
    const kids = async (n: number) => Promise.all(Array.from({ length: n }, async () => (await spawnT('k', p, tok)).body.data.nodeId as string));
    const close = async (ids: string[]) => { confirms.length = 0; await api('close', { nodeIds: ids }, p, tok); return confirms.length; };
    setMode('done');
    const [a, b] = await kids(2);
    for (const id of [a, b]) manager.applyHook(id, { hook_event_name: 'Stop' });
    expect(await close([a, b])).toBe(0);
    expect(manager.view(a)).toBeUndefined();
    const [c, d] = await kids(2);
    manager.applyHook(c, { hook_event_name: 'Stop' });
    manager.applyHook(d, { hook_event_name: 'UserPromptSubmit' }); // working
    expect(await close([c, d])).toBe(1);
    const [f] = await kids(1);
    manager.applyHook(f, { hook_event_name: 'UserPromptSubmit' }); // still working, but it has reported its outcome
    await api('report_outcome', { outcome: 'succeeded' }, f, manager.tokenFor(f));
    expect(await close([f])).toBe(0);
    setMode('never');
    const [e] = await kids(1);
    manager.applyHook(e, { hook_event_name: 'Stop' });
    expect(await close([e])).toBe(1);
    setMode('always');
    const [g] = await kids(1);
    expect(await close([g])).toBe(0);
  });

  it('closeWithoutConfirm comes from the main checkout, not a worktree branch\'s own copy', async () => {
    const repo = join(home, 'wt-repo'), path = join(repo, '.claude', 'worktrees', 'x');
    const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { encoding: 'utf8' }).trim();
    const setMode = (dir: string, mode: string) => {
      mkdirSync(join(dir, '.tiller'), { recursive: true });
      writeFileSync(join(dir, '.tiller', 'config.json'), JSON.stringify({ closeWithoutConfirm: mode }));
    };
    mkdirSync(repo);
    git(repo, 'init', '-q', '-b', 'main');
    setMode(repo, 'never');
    git(repo, 'add', '.');
    git(repo, 'commit', '-qm', 'never');
    git(repo, 'worktree', 'add', '-q', '-b', 'tl/x', path);
    setMode(path, 'always'); // the worker's branch copy, which it can edit
    const p = (await spawnT('wt', 'human', admin, { cwd: path })).body.data.nodeId as string;
    manager.registry.update(p, { worktree: { repo, path, branch: 'tl/x', base: 'main', baseSha: git(repo, 'rev-parse', 'HEAD') } });
    const tok = manager.tokenFor(p);
    const kid = (await spawnT('k', p, tok, { cwd: path })).body.data.nodeId as string;
    const grandkid = (await spawnT('g', kid, manager.tokenFor(kid))).body.data.nodeId as string;
    const close = async (caller: string, id: string) => { confirms.length = 0; await api('close', { nodeIds: [id] }, caller, manager.tokenFor(caller)); return confirms.length; };
    expect(await close(kid, grandkid)).toBe(1); // a plain node whose cwd is in the worktree: the main checkout by git
    expect(await close(p, kid)).toBe(1);        // the worktree node itself: its worktree's repo
    await manager.close(p, true, 'discard'); // stay under limits.maxLiveNodes for the later tests
  });

  it('only the human may spawn with bypassPermissions; the mode is validated', async () => {
    const p = (await spawnT('bp')).body.data.nodeId as string;
    const args = { kind: 'terminal', title: 'k', cwd: tmpdir(), permissionMode: 'bypassPermissions' };
    expect((await api('spawn', args, p, manager.tokenFor(p))).body.error).toMatch(/only the human/);
    expect((await api('spawn', args)).status).toBe(200);
    expect((await api('spawn', { ...args, permissionMode: 'yolo' })).status).toBe(400);
  });

  it('spawn inherits the caller\'s observed permission mode; bypassPermissions is never inherited', async () => {
    const p = (await spawnT('pm')).body.data.nodeId as string;
    const tok = manager.tokenFor(p);
    const mode = async (extra = {}) => manager.registry.get((await spawnT('k', p, tok, extra)).body.data.nodeId)?.permissionMode;
    expect(await mode()).toBeUndefined();
    manager.applyHook(p, { hook_event_name: 'UserPromptSubmit', permission_mode: 'auto' });
    expect(await mode()).toBe('auto');
    expect(await mode({ permissionMode: 'default' })).toBe('default');
    manager.applyHook(p, { hook_event_name: 'UserPromptSubmit', permission_mode: 'bypassPermissions' });
    expect(await mode()).toBeUndefined();
    expect(manager.registry.get(p)?.permissionMode).toBe('bypassPermissions'); // recorded for resume
  });

  it('list_nodes shows a node only its lineage; write is capped at 2000 characters', async () => {
    const p = (await spawnT('lp')).body.data.nodeId as string;
    const c = (await spawnT('lc', p, manager.tokenFor(p))).body.data.nodeId as string;
    const stranger = (await spawnT('ls')).body.data.nodeId as string;
    const ids = (await api('list_nodes', {}, c, manager.tokenFor(c))).body.data.map((n: any) => n.id);
    expect(ids).toContain(p);
    expect(ids).toContain(c);
    expect(ids).not.toContain(stranger);
    const long = await api('write', { nodeId: p, text: 'x'.repeat(2001) }, c, manager.tokenFor(c));
    expect(long.status).toBe(400);
    expect(long.body.error).toMatch(/2000/);
    confirms.length = 0;
    await api('write', { nodeId: p, text: 'y'.repeat(1500) }, c, manager.tokenFor(c));
    expect(confirms[0]).toContain('y'.repeat(1500));
  });

  it('select is human only and announces a focus for an existing node', async () => {
    const id = (await spawnT('sel')).body.data.nodeId as string;
    expect((await api('select', { nodeId: id }, id, manager.tokenFor(id))).status).toBe(400);
    expect((await api('select', { nodeId: 'nope' })).status).toBe(400);
    expect(focused).toEqual([]);
    expect((await api('select', { nodeId: id })).status).toBe(200);
    expect(focused).toEqual([['human', id]]);
  });

  it('report_outcome stores the structured fields and list_nodes returns them; no gate configured records at once', async () => {
    const p = (await spawnT('rp')).body.data.nodeId as string;
    const w = (await spawnT('rw', p, manager.tokenFor(p))).body.data.nodeId as string;
    const report = { outcome: 'succeeded', note: 'n', summary: 'did it', changedFiles: ['a.ts', 'b.ts'], verified: 'vitest: 3 passed', openQuestions: ['keep b?'] };
    expect((await api('report_outcome', report, w, manager.tokenFor(w))).body.data).toEqual({ ok: true });
    const list = (await api('list_nodes', {}, p, manager.tokenFor(p))).body;
    expect(list.data.find((n: any) => n.id === w).outcome).toMatchObject(report);
    expect(list.text).toContain('reported succeeded: did it');
  });

  it('tells the parent of each recorded outcome once, unless its pending notify_when covers that child', async () => {
    const cwd = join(home, 'plain');
    mkdirSync(join(cwd, '.tiller'), { recursive: true });
    writeFileSync(join(cwd, '.tiller', 'config.json'), '{}');
    writeFileSync(join(home, 'config.json'), JSON.stringify({ daemon: { maxLiveNodes: 100 } })); // earlier tests leave many nodes live
    const p = (await spawnT('np', 'human', admin, { cwd })).body.data.nodeId as string;
    const [w1, w2] = [(await spawnT('nw1', p, manager.tokenFor(p), { cwd })).body.data.nodeId as string, (await spawnT('nw2', p, manager.tokenFor(p), { cwd })).body.data.nodeId as string];
    for (const id of [p, w1, w2]) { manager.registry.update(id, { kind: 'claude' }); inbox(manager, id); }
    await api('report_outcome', { outcome: 'succeeded', summary: 'did one' }, w1, manager.tokenFor(w1));
    await expect.poll(() => inbox(manager, p).map((x) => x.text)).toEqual([expect.stringContaining(`${w1} reported succeeded: did one`)]);
    expect((await api('notify_when', { ids: [w2], when: 'all', of: 'success' }, p, manager.tokenFor(p))).status).toBe(200);
    await api('report_outcome', { outcome: 'failed', note: 'no' }, w2, manager.tokenFor(w2));
    await expect.poll(() => inbox(manager, p).length).toBe(2);
    await new Promise((r) => setTimeout(r, 50));
    const texts = inbox(manager, p).map((x) => x.text);
    expect(texts).toHaveLength(2);
    expect(texts[1]).toContain(`1 of 1 finished:\n${w2}: failed: no`);
  });

  describe('completion gate', () => {
    const proj = () => join(home, 'gated');
    /** A gate that runs until a file named go appears. */
    const slow = () => join(home, 'gated-slow');
    const tok = (id: string) => manager.tokenFor(id);
    beforeAll(() => {
      mkdirSync(join(proj(), '.tiller'), { recursive: true });
      writeFileSync(join(proj(), '.tiller', 'config.json'), JSON.stringify({ gate: { command: 'test -f ok.txt && echo fine || { echo missing ok.txt; exit 3; }', retries: 1 } }));
      mkdirSync(join(slow(), '.tiller'), { recursive: true });
      writeFileSync(join(slow(), '.tiller', 'config.json'), JSON.stringify({ gate: { command: 'while [ ! -f go ]; do sleep 0.05; done' } }));
      writeFileSync(join(home, 'config.json'), JSON.stringify({ daemon: { maxLiveNodes: 100 } })); // earlier tests leave many nodes live
      writeFileSync(join(home, '.claude.json'), JSON.stringify({ projects: { [proj()]: { hasTrustDialogAccepted: true }, [slow()]: { hasTrustDialogAccepted: true } } })); // gate commands need trust, as setup does
      vi.stubEnv('HOME', home);
    });
    afterAll(() => vi.unstubAllEnvs());
    /** A parent and a worker in the gated project, both "claude" with a polling mod so the daemon's messages land in their inboxes. */
    const pair = async (cwd = proj()) => {
      const p = (await spawnT('gp', 'human', admin, { cwd })).body.data.nodeId as string;
      const w = (await spawnT('gw', p, tok(p), { cwd })).body.data.nodeId as string;
      for (const id of [p, w]) { manager.registry.update(id, { kind: 'claude' }); inbox(manager, id); }
      return { p, w };
    };

    it('records a passing gate with gate: passed', async () => {
      writeFileSync(join(proj(), 'ok.txt'), '');
      const { w } = await pair();
      const r = await api('report_outcome', { outcome: 'succeeded', summary: 's' }, w, tok(w));
      expect(r.body.data).toEqual({ ok: true, gate: 'passed' });
      expect(manager.view(w)).toMatchObject({ gate: 'passed', outcome: { outcome: 'succeeded', summary: 's', gate: 'passed' } });
      expect(readFileSync(join(home, 'nodes', w, 'gate.log'), 'utf8')).toContain('fine');
      rmSync(join(proj(), 'ok.txt'));
    });

    it('a fast gate failure is in the reply only, without recording; the last failure records failed and tells the parent', async () => {
      const { p, w } = await pair();
      const first = await api('report_outcome', { outcome: 'succeeded' }, w, tok(w));
      expect(first.body.data).toEqual({ ok: false, gate: 'failed', attemptsLeft: 1 });
      expect(first.body.text).toContain('Completion gate failed (attempt 1 of 2): test -f ok.txt');
      expect(first.body.text).toContain('missing ok.txt');
      expect(first.body.text).toContain('exited with 3');
      expect(first.body.text).toContain('Fix it and call report_outcome again.');
      expect(manager.view(w)!.outcome).toBeUndefined();
      expect(manager.view(w)!.gate).toBe('failed');
      const last = await api('report_outcome', { outcome: 'succeeded', summary: 's' }, w, tok(w));
      expect(last.body.data).toEqual({ ok: false, gate: 'failed', attemptsLeft: 0 });
      expect(last.body.text).toContain('attempt 2 of 2');
      expect(manager.view(w)!.outcome).toMatchObject({ outcome: 'failed', gate: 'failed', summary: 's' });
      await expect.poll(() => inbox(manager, p).map((x) => x.text)).toEqual([expect.stringContaining(`${w} reported failed (gate failed): s`)]);
      expect(inbox(manager, w)).toEqual([]);
    });

    it('refuses any report while the gate runs, so the run cannot overwrite a later verdict', async () => {
      const { w } = await pair(slow());
      const run = api('report_outcome', { outcome: 'succeeded', summary: 's' }, w, tok(w));
      await expect.poll(() => manager.view(w)!.gate).toBe('running');
      expect((await api('report_outcome', { outcome: 'failed' }, w, tok(w))).body.data).toEqual({ ok: false, gate: 'running' });
      writeFileSync(join(slow(), 'go'), '');
      expect((await run).body.data).toEqual({ ok: true, gate: 'passed' });
      expect(manager.view(w)!.outcome).toMatchObject({ outcome: 'succeeded', gate: 'passed' });
    });
  });

  it('serves the tools over MCP with schemas, without the human-only ones for agents', async () => {
    const id = (await spawnT('mcp-caller')).body.data.nodeId as string;
    const connect = async (who: string, token: string) => {
      const c = new Client({ name: 't', version: '0' });
      await c.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${token}`, 'X-TL-Node': who } } }));
      return c;
    };
    const human = await connect('human', admin);
    const humanTools = (await human.listTools()).tools;
    expect(humanTools.map((t) => t.name).sort()).toEqual(['change_harness', 'close', 'diff', 'dnd', 'drain', 'followup', 'history', 'list_nodes', 'merge', 'message_status', 'mute', 'notify_when', 'prune', 'read', 'rename', 'report_outcome', 'restart', 'resume', 'select', 'send', 'sessions_clean', 'shutdown', 'spawn', 'transcript', 'update', 'withdraw', 'worktrees', 'write']);
    expect(Object.fromEntries(humanTools.map((t) => [t.name, t.title]))).toMatchObject({
      send: 'Send message', spawn: 'Start node', notify_when: 'Watch node completion', read: 'Read node output',
      history: 'List past agents', followup: 'Continue past agent', merge: 'Merge node changes',
    });
    await human.close();
    const client = await connect(id, manager.tokenFor(id));
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(['close', 'diff', 'history', 'list_nodes', 'merge', 'message_status', 'notify_when', 'read', 'rename', 'report_outcome', 'send', 'spawn', 'withdraw', 'write']);
    expect(tools.find((t) => t.name === 'spawn')!.inputSchema.required).toEqual(['kind', 'title']); // cwd defaults to a fork source's
    expect(Object.fromEntries(tools.map((t) => [t.name, t.title]))).toMatchObject({
      notify_when: 'Watch node completion', read: 'Read node output', history: 'List past agents',
      spawn: 'Start node',
    });
    const r = (await client.callTool({ name: 'report_outcome', arguments: { outcome: 'succeeded' } })) as { content: Array<{ text: string }> };
    expect(r.content[0].text).toBe('{"ok":true}');
    await client.close();
  });
});

describe('systemPrompt', () => {
  it('states identity and framing rules', () => {
    const p = systemPrompt({ nodeId: 'n-1', title: 'Builder', parentId: null, home: '/nonexistent', cwd: '/nonexistent' });
    expect(p).toContain('node n-1');
    expect(p).toContain('parent node is none');
    expect(p).toContain('--- TL MESSAGE <nonce> ---');
    expect(p).toContain('OUTERMOST');
  });
});
