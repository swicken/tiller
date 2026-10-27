// The daemon over HTTP for the memory tests: a NodeManager and server on an ephemeral port, the /api caller with the
// admin or a node's token, and agent and gardener nodes that are terminals relabelled, so no harness runs.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { vi } from 'vitest';
import { Gardener } from './gardener.js';
import { NodeManager } from './manager.js';
import { startServer } from './server.js';

export type Reply = { status: number; text?: string; data?: any; error?: string };

export type TestDaemon = Awaited<ReturnType<typeof startTestDaemon>>;

export async function startTestDaemon(home: string) {
  const manager = new NodeManager({ home, shell: '/bin/sh' });
  const server = await startServer(manager, { port: 0 });
  vi.spyOn(server.updates, 'start').mockImplementation(() => {});
  let gardener: Gardener | undefined;
  const token = (id: string) => (id === 'human' ? readFileSync(join(home, 'admin-token'), 'utf8') : manager.tokenFor(id));
  async function api(tool: string, args: object, id = 'human'): Promise<Reply> {
    const res = await fetch(`http://127.0.0.1:${server.port}/api/${tool}`, { method: 'POST', headers: { Authorization: `Bearer ${token(id)}`, 'X-TL-Node': id }, body: JSON.stringify(args) });
    return { status: res.status, ...(await res.json()) };
  }
  /** A Claude node in `cwd`: a terminal relabelled. */
  async function agent(cwd: string, title = 'w'): Promise<string> {
    const id = (await api('spawn', { kind: 'terminal', title, cwd })).data.nodeId as string;
    manager.registry.update(id, { kind: 'claude' });
    return id;
  }
  /** The manager's Gardener replaced by one whose host spawns each gardener node as an agent in `repo`. */
  function useGardener(repo: string): Gardener {
    gardener = new Gardener({
      home, store: manager.memory,
      async spawnGardener(req) {
        const id = await agent(repo, 'Memory gardener');
        manager.registry.update(id, { gardener: { repoKey: req.repoKey, runId: req.runId } });
        return id;
      },
      stopGardener: async () => {}, closePreviousGardener: async () => {},
      quiet: () => true, usageFor: () => undefined, trusted: () => true,
      live: (id) => !!manager.registry.get(id), record: (id) => manager.registry.get(id), gardenerRecords: () => [], setOutcome: () => {},
    });
    Object.assign(manager, { gardener });
    return gardener;
  }
  async function close(): Promise<void> {
    await gardener?.stop();
    await manager.shutdown();
    await server.close();
  }
  return { manager, server, token, api, agent, useGardener, close };
}
