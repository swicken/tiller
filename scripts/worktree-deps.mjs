// worktrees.setup step: a new worktree gets a copy of the main checkout's node_modules (.worktreeinclude), which may
// not match this worktree's package-lock.json. Re-install with `npm ci` unless npm's record of what it installed
// (node_modules/.package-lock.json) matches the lockfile. Optional packages skipped on this platform don't count.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const packages = path => JSON.parse(readFileSync(path, 'utf8')).packages;

function fresh() {
  try {
    const locked = packages('package-lock.json');
    const installed = packages('node_modules/.package-lock.json');
    delete locked[''];
    const same = k => JSON.stringify(locked[k]) === JSON.stringify(installed[k]);
    return Object.keys(installed).every(same) && Object.keys(locked).every(k => installed[k] || locked[k].optional);
  } catch {
    return false; // no lockfile record (or unreadable): re-install
  }
}

if (!fresh()) execFileSync('npm', ['ci', '--no-audit', '--no-fund'], { stdio: 'inherit' });
