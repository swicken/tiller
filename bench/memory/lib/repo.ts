// Scratch repos for bench nodes (bench plan §3.1-3.2): one commit of the given files with a fixed author and date,
// unsigned, so the same files always make the same commit, and the fake origin https://bench.invalid/<name>.git. The
// reserved .invalid TLD means nothing is ever fetched or pushed, and memory keys the repo on that origin.
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { repoKeySync } from '../../../src/daemon/worktree.js';

export const FAKE_HOST = 'bench.invalid';

const GIT_ENV = {
  GIT_AUTHOR_NAME: 'tiller bench', GIT_AUTHOR_EMAIL: 'bench@bench.invalid', GIT_AUTHOR_DATE: '2026-01-01T00:00:00Z',
  GIT_COMMITTER_NAME: 'tiller bench', GIT_COMMITTER_EMAIL: 'bench@bench.invalid', GIT_COMMITTER_DATE: '2026-01-01T00:00:00Z',
  GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'commit.gpgsign', GIT_CONFIG_VALUE_0: 'false',
};

/**
 * Create a repo at dir (which must not exist) holding `files` (relative paths; a file starting with #! is executable),
 * and return memory's key for it. With `tag`, that tag names the commit.
 */
export function makeRepo(dir: string, name: string, files: Record<string, string> = { 'README.md': `# ${name}\n` }, tag?: string): string {
  if (!/^[\w.-]+$/.test(name)) throw new Error(`bad repo name: ${name}`);
  mkdirSync(dir, { recursive: false });
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), text, { mode: text.startsWith('#!') ? 0o755 : 0o644 });
  }
  const git = (...args: string[]) => execFileSync('git', ['-C', dir, ...args], { env: { ...process.env, ...GIT_ENV }, stdio: 'ignore' });
  git('init', '-q', '-b', 'main');
  git('add', '-A');
  git('commit', '-q', '-m', 'bench scratch repo');
  if (tag) git('tag', tag);
  git('remote', 'add', 'origin', `https://${FAKE_HOST}/${name}.git`);
  return repoKeySync(dir);
}
