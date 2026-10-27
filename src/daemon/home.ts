// The daemon's home directory and the files in it that the CLI, the daemon and the app shell share.
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const DEFAULT_PORT = 7788;
/** Admin token for the human: mcp.ts writes it once the server listens; the CLI and the app read it. */
export const ADMIN_TOKEN_FILE = 'admin-token';
/** The port the daemon bound, so `tl` finds it without TL_PORT. */
export const PORT_FILE = 'port';
/** This checkout's root, so the app shell can find bin/tld. */
export const REPO_FILE = 'repo';

/** TL_HOME, else ~/.tiller. */
export const homeDir = (): string => process.env.TL_HOME ?? join(homedir(), '.tiller');

/** TL_PORT (or `envPort`) when set and non-empty, else the port file, else DEFAULT_PORT. */
export function daemonPort(home = homeDir(), envPort = process.env.TL_PORT): number {
  if (envPort) return Number(envPort);
  try { return Number(readFileSync(join(home, PORT_FILE), 'utf8').trim()) || DEFAULT_PORT; } catch { return DEFAULT_PORT; }
}
