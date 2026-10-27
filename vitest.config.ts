import { availableParallelism } from 'node:os';
import { configDefaults, defineConfig } from 'vitest/config';

// mod/tests and mod-rows/tests run under `claude plugin test`, not vitest. Worker worktrees under .claude/worktrees hold copies of the tests.
// Bound concurrency to half the cores (at least two files) so real Git and child-process tests can overlap waits without unbounded competition.
// 120 s per test is a hang detector, not a budget: process fixtures can slow down when the machine is busy.
// Tests make real git commits and tags; the daemon inherits the user's git config, and a signing key or agent prompt must not block them.
const GIT_NO_SIGN = { GIT_CONFIG_COUNT: '2', GIT_CONFIG_KEY_0: 'commit.gpgsign', GIT_CONFIG_VALUE_0: 'false', GIT_CONFIG_KEY_1: 'tag.gpgsign', GIT_CONFIG_VALUE_1: 'false' };
export default defineConfig({ test: { env: GIT_NO_SIGN, exclude: [...configDefaults.exclude, 'mod/**', 'mod-rows/**', '**/.claude/worktrees/**'], fileParallelism: true, maxWorkers: Math.max(2, Math.floor(availableParallelism() / 2)), testTimeout: 120_000, expect: { poll: { timeout: 10_000 } } } });
