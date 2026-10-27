import { timingSafeEqual } from 'node:crypto';
import { realpathSync } from 'node:fs';
import type http from 'node:http';
import { homedir } from 'node:os';
import { join, resolve, sep } from 'node:path';

/** Constant-time string comparison for tokens. */
export function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/** How much of a node's last assistant message the node lists (list_nodes, the mod's /tree) show. */
export const PREVIEW_CHARS = 200;

/** "1 file", "2 files". */
export const count = (n: number, noun: string) => `${n} ${noun}${n === 1 ? '' : 's'}`;

/** Whether `path` is `dir` or inside it. */
export const inside = (path: string, dir: string) => path === dir || path.startsWith(dir + sep);

/** `~/x` under the user's home, then path.resolve: no trailing slash, no realpath. */
export const expandHome = (path: string) => resolve(path.startsWith('~/') ? join(homedir(), path.slice(2)) : path);

/** For `.catch(logError)` on fire-and-forget promises. */
/**
 * `path` with symlinks resolved, as `git worktree list` reports it (git registers resolved paths); `path` made absolute when it
 * does not exist. Trust lists, account projects and worktree paths compare in this form.
 */
export const canonical = (path: string) => { try { return realpathSync(path); } catch { return resolve(path); } };

/** Whether process `pid` may exist: only ESRCH proves it gone (EPERM means it runs under another user). */
export const pidAlive = (pid: number): boolean => {
  try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code !== 'ESRCH'; }
};

export const logError = (err: unknown): void => console.error('tiller:', err);

/** The request body, or undefined once it passes `max` characters: then this has answered 413 and destroyed the request. */
export async function readBody(req: http.IncomingMessage, res: http.ServerResponse, max = 1_000_000): Promise<string | undefined> {
  let body = '';
  for await (const chunk of req) {
    body += chunk;
    if (body.length > max) { res.writeHead(413).end(); req.destroy(); return undefined; }
  }
  return body;
}
