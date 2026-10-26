// Isolated benchmark daemons (bench plan §1, pattern from spike/restart-check.ts): a temp TL_HOME and an ephemeral port,
// started as `node --import tsx src/daemon/index.ts` from a checkout. Never the live ~/.tiller or port 7788.
import { spawn } from 'node:child_process';
import { mkdirSync, openSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setProjectTrust } from '../../../src/daemon/trust.js';
import { mainCheckoutSync } from '../../../src/daemon/worktree.js';

/** This checkout, whose daemon the bench runs. */
export const CHECKOUT = fileURLToPath(new URL('../../..', import.meta.url)).replace(/\/$/, '');
const LIVE_HOME = join(homedir(), '.tiller');
const LIVE_PORT = 7788;
/** Claude's unattended preset: bypassPermissions and an empty body, so the default worker role stays (bench plan §3.1). */
const CLAUDE_PRESET = '---\npermissionMode: bypassPermissions\n---\n';

/** A path with its existing part resolved through symlinks, so a path not yet created compares like a created one. */
export function realPath(path: string): string {
  const abs = resolve(path);
  try { return realpathSync(abs); } catch { return dirname(abs) === abs ? abs : join(realPath(dirname(abs)), basename(abs)); }
}

/** <root> as a real path, created; refused inside the live tiller home, this checkout or any of `also`. */
export function benchRoot(path: string, also: string[] = []): string {
  const root = realPath(path);
  const forbidden = [LIVE_HOME, CHECKOUT, mainCheckoutSync(CHECKOUT), ...also].flatMap((p) => (p ? [realPath(p)] : []));
  for (const f of forbidden) {
    const rel = relative(f, root);
    if (rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))) throw new Error(`refusing --root ${root}: it is inside ${f}`);
  }
  mkdirSync(root, { recursive: true, mode: 0o700 });
  return root;
}

/**
 * Make `home` a bench daemon's home: config.json holding `config`, the unattended `bench` preset, and Tiller trust for
 * `root`, so gate commands run in every scratch repo below it.
 */
export function prepareHome(home: string, root: string, config: object): void {
  mkdirSync(join(home, 'agents'), { recursive: true, mode: 0o700 });
  writeFileSync(join(home, 'config.json'), JSON.stringify(config, null, 2) + '\n');
  writeFileSync(join(home, 'agents', 'bench.md'), CLAUDE_PRESET);
  setProjectTrust(home, root, true);
}

export interface Daemon {
  home: string;
  port: number;
  token: string;
  /** SIGTERM, then SIGKILL after 10 s; resolves once the process is gone. */
  stop(): Promise<void>;
}

/** A port nothing listens on now. */
export function freePort(): Promise<number> {
  return new Promise((ok, fail) => {
    const s = createServer();
    s.once('error', fail);
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address() as { port: number };
      s.close(() => ok(port));
    });
  });
}

/** Start a daemon on `home` and wait for it to listen. Its output goes to <home>/daemon.log. */
export async function startDaemon(home: string, timeoutMs = 30_000): Promise<Daemon> {
  if (realPath(home) === realPath(LIVE_HOME)) throw new Error(`refusing to run a bench daemon on the live home ${LIVE_HOME}`);
  let port = await freePort();
  if (port === LIVE_PORT) port = await freePort();
  const log = join(home, 'daemon.log');
  const out = openSync(log, 'a');
  // The bench may itself run inside a tiller node: none of that node's TL_* variables may reach the scratch daemon.
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('TL_')));
  const p = spawn(process.execPath, ['--import', 'tsx', 'src/daemon/index.ts'], {
    cwd: CHECKOUT, env: { ...env, TL_HOME: home, TL_PORT: String(port) }, stdio: ['ignore', out, out],
  });
  let exited: number | null | undefined;
  const gone = new Promise<void>((r) => p.once('exit', (code) => { exited = code; r(); }));
  const stop = async () => {
    if (exited !== undefined) return;
    p.kill('SIGTERM');
    const timer = setTimeout(() => p.kill('SIGKILL'), 10_000);
    await gone;
    clearTimeout(timer);
  };
  for (const end = Date.now() + timeoutMs; ; await new Promise((r) => setTimeout(r, 200))) {
    if (exited !== undefined) throw new Error(`bench daemon exited with ${exited} before listening; see ${log}`);
    if (readFileSync(log, 'utf8').includes('tiller daemon listening')) break;
    if (Date.now() > end) {
      await stop();
      throw new Error(`bench daemon did not listen within ${timeoutMs} ms; see ${log}`);
    }
  }
  return { home, port, token: readFileSync(join(home, 'admin-token'), 'utf8').trim(), stop };
}
