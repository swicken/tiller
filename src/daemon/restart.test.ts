import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('node:child_process', () => ({ spawn: vi.fn() }));
vi.mock('./autostart.js', () => ({ agentMatches: vi.fn(), agentStatus: vi.fn(), kickstart: vi.fn() }));
// drainDaemon polls every second; vi.useFakeTimers does not reach node:timers/promises, so the waits resolve at once.
vi.mock('node:timers/promises', () => ({ setTimeout: vi.fn(async (_ms: number, value?: unknown) => value) }));
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { agentMatches, agentStatus, kickstart } from './autostart.js';
import { drainDaemon, restartDaemon } from './up.js';

const health = (home: string, sha = 'released') => new Response(JSON.stringify({ ok: true, pid: 123, home, sha }));
let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'tl-restart-'));
  writeFileSync(join(home, 'admin-token'), 'admin');
  vi.mocked(agentStatus).mockReturnValue({ installed: true, loaded: true });
  vi.mocked(spawn).mockImplementation(() => Object.assign(new EventEmitter(), { unref: vi.fn() }) as any);
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.clearAllMocks(); rmSync(home, { recursive: true, force: true }); });

describe('restartDaemon shared by update and reload', () => {
  it('refuses to signal another home even when called directly by a detached helper', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(health('/other')));
    const kill = vi.spyOn(process, 'kill').mockReturnValue(true);
    await expect(restartDaemon(home, 7799)).rejects.toThrow('another home');
    expect(kill).not.toHaveBeenCalled();
    expect(kickstart).not.toHaveBeenCalled();
    expect(spawn).not.toHaveBeenCalled();
  });

  it.each([false, true])('uses launchd only for matching home and port (matches=%s)', async (matches) => {
    vi.mocked(agentMatches).mockReturnValue(matches);
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(health(home))
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: { reason: 'r', waiting: [] } }))) // drain: nobody working
      .mockRejectedValueOnce(new Error('stopped'))
      .mockResolvedValueOnce(health(home)));
    const kill = vi.spyOn(process, 'kill').mockReturnValue(true);
    const say = vi.fn();
    await restartDaemon(home, 7799, 'released', say);
    expect(kill).toHaveBeenCalledExactlyOnceWith(123, 'SIGTERM');
    expect(agentMatches).toHaveBeenCalledExactlyOnceWith(home, 7799);
    expect(kickstart).toHaveBeenCalledTimes(matches ? 1 : 0);
    expect(spawn).toHaveBeenCalledTimes(matches ? 0 : 1);
    if (!matches) expect(vi.mocked(spawn).mock.calls[0][2]).toMatchObject({ env: { TL_HOME: home, TL_PORT: '7799' } });
    expect(say).toHaveBeenLastCalledWith(expect.stringContaining('it resumes the nodes that were live'));
  });

  it('retains verification of the released commit after restart', async () => {
    vi.mocked(agentMatches).mockReturnValue(true);
    vi.stubGlobal('fetch', vi.fn().mockRejectedValueOnce(new Error('absent')).mockResolvedValueOnce(health(home, 'wrong')));
    await expect(restartDaemon(home, 7799, 'released')).rejects.toThrow('expected commit released');
  });
});

describe('drainDaemon before a restart', () => {
  const drain = (waiting: string[], force = false) => new Response(JSON.stringify({ data: { reason: 'tl reload', waiting: waiting.map((id) => ({ id, title: `T-${id}` })), ...(force ? { force } : {}) } }));
  const body = (call: unknown[]) => JSON.parse((call[1] as RequestInit).body as string);

  it('polls while agents work, says whom it waits for as that changes, and stops once none is working', async () => {
    const fetch = vi.fn().mockResolvedValueOnce(drain(['a', 'b'])).mockResolvedValueOnce(drain(['a'])).mockResolvedValueOnce(drain([]));
    vi.stubGlobal('fetch', fetch);
    const say = vi.fn();
    await drainDaemon(home, 7799, { reason: 'tl reload', exclude: 'n-self', say });
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(fetch.mock.calls[0][0]).toBe('http://127.0.0.1:7799/api/drain');
    expect(body(fetch.mock.calls[0])).toEqual({ reason: 'tl reload', exclude: 'n-self' });
    expect(say.mock.calls.map((c) => c[0])).toEqual([
      'waiting for 2 agents to finish their turn: T-a (a), T-b (b)',
      'waiting for 1 agent to finish their turn: T-a (a)',
      'no agent is working',
    ]);
  });

  it('stops polling once aborted, so no poll lands after a cancel', async () => {
    const fetch = vi.fn().mockResolvedValue(drain(['a']));
    vi.stubGlobal('fetch', fetch);
    const abort = new AbortController();
    // This wait lasts until the abort, which may land before drainDaemon reaches it. Without the signal it ends at once,
    // so a drain that stops passing it polls again and fails the test.
    vi.mocked(sleep).mockImplementationOnce((_ms, value, o) => !o?.signal ? Promise.resolve(value) : new Promise((_, reject) => {
      const signal = o.signal!; signal.throwIfAborted(); signal.addEventListener('abort', () => reject(signal.reason));
    }));
    const done = drainDaemon(home, 7799, { reason: 'tl reload', signal: abort.signal });
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce());
    abort.abort();
    await expect(done).rejects.toThrow();
    expect(fetch).toHaveBeenCalledOnce();
  });

  it('with now, holds deliveries once and does not wait', async () => {
    const fetch = vi.fn().mockResolvedValue(drain(['a']));
    vi.stubGlobal('fetch', fetch);
    await drainDaemon(home, 7799, { reason: 'tl reload', now: true });
    expect(fetch).toHaveBeenCalledOnce();
  });

  it('stops waiting when the human asks the app to restart now', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(drain(['a'], true)));
    const say = vi.fn();
    await drainDaemon(home, 7799, { reason: 'tl reload', say });
    expect(say).toHaveBeenCalledExactlyOnceWith('restart now was asked for; not waiting');
  });

  it('restarts at once against a daemon that predates draining', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(new Response('', { status: 404 })));
    const say = vi.fn();
    await drainDaemon(home, 7799, { reason: 'tl reload', say });
    expect(say).toHaveBeenCalledExactlyOnceWith('the running daemon cannot wait for agents; restarting at once');
  });
});
