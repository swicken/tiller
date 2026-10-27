import { timingSafeEqual } from 'node:crypto';
import { statSync } from 'node:fs';
import type http from 'node:http';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve, sep } from 'node:path';

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

/** Throws unless `path`, the argument `name`, is the absolute path of an existing directory. */
export function requireDir(path: string, name: string): void {
  if (!isAbsolute(path) || !statSync(path, { throwIfNoEntry: false })?.isDirectory()) throw new Error(`${name} must be the absolute path of a directory: ${path}`);
}

/** For `.catch(logError)` on fire-and-forget promises. */
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
