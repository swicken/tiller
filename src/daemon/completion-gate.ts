import { existsSync, readFileSync, statSync } from 'node:fs';
import type { NodeView } from '../shared/protocol.js';
import { loadConfig, type Config } from './config.js';
import { commandsTrusted } from './worktree-lifecycle.js';
import { runCommands } from './worktree.js';

/** Lines of gate output that go back to the worker. */
const GATE_TAIL_LINES = 60;

/** The completion gate configured for a project directory that `tl trust` or any Claude home trusts. `tl gate` uses it too. */
export function gateFor(dir: string, home: string): Config['gate'] {
  const gate = loadConfig(dir, home).gate;
  return gate && commandsTrusted(home, dir) ? gate : undefined;
}

/** One node's gate attempts, retained until its runtime is discarded. */
export class CompletionGate {
  state: NonNullable<NodeView['gate']> = 'running';
  command = '';
  private failures = 0;

  resetFailures(): void { this.failures = 0; }

  /** Run in the node's cwd; append the log, but return only this attempt's output and failure count. */
  async run(gate: NonNullable<Config['gate']>, input: {
    cwd: string;
    env: Record<string, string>;
    log: string;
    present: () => boolean;
    changed: () => void;
  }): Promise<{ ok: boolean; tail: string; failures: number }> {
    const { cwd, env, log, present, changed } = input;
    const failures = this.failures;
    const start = existsSync(log) ? statSync(log).size : 0;
    this.state = 'running';
    this.command = gate.command;
    changed();
    // prune: a node closed mid-gate leaves the command running until it ends or times out; add an abort if gates get long.
    const err = await runCommands([gate.command], { cwd, env, log, timeout: gate.timeoutMinutes * 60_000 }).then(() => undefined, (e: Error) => e);
    let out = '';
    try { out = readFileSync(log).subarray(start).toString(); } catch { /* node closed meanwhile */ }
    const lines = [...out.trimEnd().split('\n'), ...(err ? [err.message] : [])];
    const after = err ? failures + 1 : failures;
    if (present()) {
      this.state = err ? 'failed' : 'passed';
      this.command = gate.command;
      this.failures = after;
      changed();
    }
    return { ok: !err, tail: lines.slice(-GATE_TAIL_LINES).join('\n'), failures: after };
  }
}
