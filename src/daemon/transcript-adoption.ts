// Adopting a follow-up's transcripts into the node's own tree, shared by the Pi and Codex harnesses.
import { closeSync, openSync, rmSync, writeFileSync } from 'node:fs';
import type { NodeRecord } from '../shared/protocol.js';

/** The sessions to adopt: the current one, then the previous ones its sessionHistory does not already record. */
export const adoptedSessions = (n: NodeRecord): string[] =>
  [...(n.sessionId ? [n.sessionId] : []), ...(n.previousSessions ?? []).filter((sid) => !n.sessionHistory?.some((s) => s.sessionId === sid))];

/** Create each file, refusing one that exists; if any fails, remove only the files this call created. */
export function writeAdopted(copies: { to: string; raw: string }[]): void {
  const created: string[] = [];
  try {
    for (const { to, raw } of copies) {
      const fd = openSync(to, 'wx', 0o600); // Once open succeeds, even a partial write belongs to us.
      created.push(to);
      try { writeFileSync(fd, raw); } finally { closeSync(fd); }
    }
  } catch (err) {
    for (const file of created) rmSync(file, { force: true });
    throw err;
  }
}
