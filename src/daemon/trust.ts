// Explicit human opt-in for repository commands, independent of any agent CLI's trust database.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { canonical } from './util.js';

const file = (home: string) => join(home, 'trusted-projects.json');

export function trustedProjects(home: string): string[] {
  try {
    const data: unknown = JSON.parse(readFileSync(file(home), 'utf8'));
    return Array.isArray(data) ? data.filter((p): p is string => typeof p === 'string') : [];
  } catch { return []; }
}

export function tillerTrusts(home: string, path: string): boolean {
  const trusted = new Set(trustedProjects(home));
  for (let dir = canonical(path); ; dir = dirname(dir)) {
    if (trusted.has(dir)) return true;
    if (dirname(dir) === dir) return false;
  }
}

/** CLI-only human operation, never exposed as an agent MCP tool. */
export function setProjectTrust(home: string, path: string, trusted: boolean): void {
  const dir = canonical(path), projects = new Set(trustedProjects(home));
  if (trusted) projects.add(dir); else projects.delete(dir);
  mkdirSync(home, { recursive: true, mode: 0o700 });
  writeFileSync(file(home), JSON.stringify([...projects], null, 2) + '\n', { mode: 0o600 });
}
