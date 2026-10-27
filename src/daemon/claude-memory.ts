// Claude Code's own auto-memory for a checkout, read for the Memory panel only: never stored, injected or given to a
// node, so this module does not touch the memory store. The directory must be reached without symlinks below the Claude
// home; each file is opened without following one and checked on its descriptor.
import { constants, realpathSync } from 'node:fs';
import { lstat, open, readdir, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import type { ClaudeMemoryView } from '../shared/protocol.js';
import { LIMITS } from './memory-schema.js';

/** Claude's directory name for a project under <Claude home>/projects: the real path with every non-alphanumeric character replaced by -. */
export function claudeProjectSlug(dir: string): string {
  let real = dir;
  try { real = realpathSync(dir); } catch { /* keep the path as given */ }
  return real.replace(/[^a-zA-Z0-9]/g, '-');
}

/** A regular file's size, mtime and first `max` bytes; undefined for a symlink, a directory or anything else. */
async function readRegular(path: string, max: number): Promise<{ size: number; mtime: number; bytes: Buffer } | undefined> {
  let file;
  try {
    // O_NONBLOCK: opening a FIFO must not wait for a writer; fstat then refuses it.
    file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch {
    return undefined;
  }
  try {
    const st = await file.stat();
    if (!st.isFile()) return undefined;
    const bytes = Buffer.alloc(Math.min(st.size, max));
    const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
    return { size: st.size, mtime: st.mtimeMs, bytes: bytes.subarray(0, bytesRead) };
  } finally {
    await file.close();
  }
}

/**
 * <claudeHome>/projects/<slug of checkout>/memory/*.md, MEMORY.md first then by name, within LIMITS.claudeMemory: a
 * file past fileBytes is cut (truncated); once the count or the total is reached, the rest go by name into omitted.
 * A missing directory has no files; a symlinked or non-directory one is not read.
 */
export async function readClaudeMemory(claudeHome: string, checkout: string): Promise<ClaudeMemoryView> {
  const dir = join(claudeHome, 'projects', claudeProjectSlug(checkout), 'memory');
  const view: ClaudeMemoryView = { dir, files: [], omitted: [] };
  let real: string;
  try {
    real = await realpath(dir);
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'ENOENT' ? view : { ...view, note: `cannot read ${dir}: ${(err as Error).message}` };
  }
  // The Claude home itself may be a link (dotfiles); below it, neither projects/<slug> nor memory may be.
  // prune: checked once, then read by path: a swap between this check and the reads is not caught (Node has no openat).
  const home = await realpath(claudeHome).catch(() => claudeHome);
  if (real !== join(home, 'projects', claudeProjectSlug(checkout), 'memory')) return { ...view, note: `${dir} is reached through a symlink; not read` };
  if (!(await lstat(real)).isDirectory()) return { ...view, note: `${dir} is not a directory; not read` };
  const order = (n: string) => (n === 'MEMORY.md' ? '' : n);
  const names = (await readdir(real)).filter((n) => n.endsWith('.md')).sort((a, b) => (order(a) < order(b) ? -1 : order(a) > order(b) ? 1 : 0));
  const cap = LIMITS.claudeMemory;
  // The total counts each text as JSON encodes it, so the reply stays within the cap however the text escapes.
  let total = 0, full = false;
  for (const name of names) {
    if (!full) {
      const f = await readRegular(join(real, name), cap.fileBytes);
      if (!f) continue;
      const text = f.bytes.toString('utf8'), size = Buffer.byteLength(JSON.stringify(text));
      full = view.files.length === cap.files || total + size > cap.totalBytes;
      if (!full) {
        total += size;
        view.files.push({ name, bytes: f.size, mtime: f.mtime, text, ...(f.size > f.bytes.length ? { truncated: true as const } : {}) });
        continue;
      }
    }
    view.omitted.push(name);
  }
  return view;
}
