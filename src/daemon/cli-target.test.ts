import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

// Which daemon `tl ps` addresses: the CLI runs at import, so each case imports a fresh copy with its own env.
let dir: string, own: string, other: string;
const fetch = vi.fn(async (_url: string, _init: RequestInit) => new Response(JSON.stringify({ data: [] })));
const argv = process.argv;

/** A daemon home with the files `tl` reads: admin-token, port, and a node token. */
function daemonHome(name: string, port: number): string {
  const home = join(dir, name);
  mkdirSync(join(home, 'nodes', 'n-1'), { recursive: true });
  writeFileSync(join(home, 'admin-token'), `admin-${name}\n`);
  writeFileSync(join(home, 'port'), `${port}\n`);
  writeFileSync(join(home, 'nodes', 'n-1', 'token'), `node-${name}\n`);
  return home;
}

/** Inside node n-1 of `own` (port 7801), with the TL_HOME and TL_PORT it inherits from its daemon. */
function insideNode() {
  vi.stubEnv('TL_HOME', own);
  vi.stubEnv('TL_PORT', '7801');
  vi.stubEnv('TL_NODE_ID', 'n-1');
  vi.stubEnv('TL_TOKEN_FILE', join(own, 'nodes', 'n-1', 'token'));
  vi.stubEnv('TL_ENDPOINT', 'http://127.0.0.1:7801');
}

async function tl(...args: string[]) {
  vi.resetModules();
  process.argv = [process.execPath, 'tl', ...args];
  await import('./cli.js');
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'tl-cli-target-'));
  own = daemonHome('own', 7801);
  other = daemonHome('other', 7802);
  for (const k of ['TL_HOME', 'TL_PORT', 'TL_NODE_ID', 'TL_TOKEN_FILE', 'TL_ENDPOINT']) vi.stubEnv(k, undefined);
  vi.stubGlobal('fetch', fetch);
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(process, 'exit').mockImplementation(((code: number) => { throw new Error(`exit ${code}`); }) as never);
});
afterEach(() => { process.argv = argv; fetch.mockClear(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.restoreAllMocks(); rmSync(dir, { recursive: true, force: true }); });

const sent = () => fetch.mock.calls.map(([url, init]) => [url, (init.headers as Record<string, string>).Authorization]);

it('outside a node, addresses the daemon TL_HOME names as the human', async () => {
  vi.stubEnv('TL_HOME', other);
  await tl('ps');
  expect(sent()).toEqual([['http://127.0.0.1:7802/api/list_nodes', 'Bearer admin-other']]);
});

it("inside a node, addresses the node's own daemon with its token", async () => {
  insideNode();
  await tl('ps');
  expect(sent()).toEqual([['http://127.0.0.1:7801/api/list_nodes', 'Bearer node-own']]);
});

it('inside a node with a later credential generation, still addresses its own daemon', async () => {
  insideNode();
  const token = join(own, 'nodes', 'n-1', 'launches', 'g2', 'token');
  mkdirSync(join(token, '..'), { recursive: true });
  writeFileSync(token, 'node-own-g2\n');
  vi.stubEnv('TL_TOKEN_FILE', token);
  await tl('ps');
  expect(sent()).toEqual([['http://127.0.0.1:7801/api/list_nodes', 'Bearer node-own-g2']]);
});

it("inside a node, refuses when TL_HOME names another daemon's home", async () => {
  insideNode();
  vi.stubEnv('TL_HOME', other); // TL_PORT is still the inherited 7801, so the endpoints alone agree
  await expect(tl('ps')).rejects.toThrow('exit 1');
  expect(fetch).not.toHaveBeenCalled();
  expect(console.error).toHaveBeenCalledWith(expect.stringContaining(other));
});

it('inside a node, refuses when TL_HOME and TL_PORT name another daemon', async () => {
  insideNode();
  vi.stubEnv('TL_HOME', other);
  vi.stubEnv('TL_PORT', undefined); // the port file of `other` says 7802
  await expect(tl('ps')).rejects.toThrow('exit 1');
  expect(fetch).not.toHaveBeenCalled();
  expect(console.error).toHaveBeenCalledWith(expect.stringContaining('http://127.0.0.1:7802'));
});

it('inside a node, refuses when TL_PORT names another port', async () => {
  insideNode();
  vi.stubEnv('TL_PORT', '7802');
  await expect(tl('ps')).rejects.toThrow('exit 1');
  expect(fetch).not.toHaveBeenCalled();
});

it("tl url prints the browser UI's URL with the admin token, outside a node only", async () => {
  vi.stubEnv('TL_HOME', other);
  await tl('url');
  expect(console.log).toHaveBeenCalledWith('http://127.0.0.1:7802/?k=admin-other');
  insideNode();
  await expect(tl('url')).rejects.toThrow('exit 1');
  expect(console.log).toHaveBeenCalledTimes(1);
});

const bodies = () => fetch.mock.calls.map(([url, init]) => [url.replace(/^.*\/api\//, ''), JSON.parse(init.body as string)]);

it('tl memory sends the human its directory as repo; inside a node, never repo or account', async () => {
  vi.stubEnv('TL_HOME', other);
  await tl('memory', 'search', 'gate', 'flakes', '--kind', 'pitfall', '--account', 'work');
  await tl('memory', 'show', 'm3', '--repo', 'sub');
  await tl('memory', 'on', '--project', 'proj');
  await tl('memory', 'inherit', '--account', 'work');
  expect(bodies()).toEqual([
    ['memory_search', { query: 'gate flakes', kind: 'pitfall', repo: process.cwd(), account: 'work' }],
    ['memory_get', { id: 'm3', repo: join(process.cwd(), 'sub') }],
    ['memory_switch', { on: true, project: join(process.cwd(), 'proj') }],
    ['memory_switch', { on: null, account: 'work' }],
  ]);
  fetch.mockClear();
  insideNode();
  await tl('memory', 'add', 'note', 'tests', 'need', 'a', 'repo', '--body', 'b');
  await tl('memory', 'forget', 'm4', 'stale', 'now');
  expect(bodies()).toEqual([
    ['memory_add', { kind: 'note', text: 'tests need a repo', body: 'b' }],
    ['memory_forget', { id: 'm4', reason: 'stale now' }],
  ]);
  await expect(tl('memory', 'search', 'x', '--repo', '/elsewhere')).rejects.toThrow('exit 1');
  expect(fetch).toHaveBeenCalledTimes(2);
});
