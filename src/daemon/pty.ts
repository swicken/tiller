import { execFile } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import * as nodePty from 'node-pty';
import xterm from '@xterm/headless';
import serialize from '@xterm/addon-serialize';
const { Terminal } = xterm;
const { SerializeAddon } = serialize;

export interface SpawnOpts {
  file: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  cols: number;
  rows: number;
}

export type ScreenClass = 'prompt' | 'dialog' | 'unknown';

/** Lines of headless scrollback kept above the visible screen for each node. */
const SCROLLBACK_LINES = 1000;

const DIALOG_TEXT = /Enter to confirm|Esc to cancel|Quick safety check|No, exit/;
const NUMBERED_OPTION = /^(❯\s*)?\d+\.\s+\S/;
const RULE = /^─{3,}/;
const PROMPT_LINE = /^❯(\s|$)/;

/** Classify the bottom of a Claude Code screen from trimmed lines (oldest first). */
export function classify(lines: string[]): ScreenClass {
  const ls = lines.map((l) => l.trim());
  if (ls.some((l) => DIALOG_TEXT.test(l) || NUMBERED_OPTION.test(l))) return 'dialog';
  // The bottom rule sits below the cursor row, so only require the rule above the prompt line.
  const i = ls.findLastIndex((l) => PROMPT_LINE.test(l));
  return i > 0 && RULE.test(ls[i - 1]) ? 'prompt' : 'unknown';
}

/** Text typed after the prompt character on the last prompt line; '' when the composer is empty. */
export function composerTextOf(lines: string[]): string {
  const l = lines.map((x) => x.trim()).findLast((x) => PROMPT_LINE.test(x));
  return l ? l.slice(1).trim() : '';
}

export class PtySession {
  private pty: nodePty.IPty;
  private term: InstanceType<typeof Terminal>;
  private ser = new SerializeAddon();
  private lock: Promise<void> = Promise.resolve();
  private mouseEncoding: 1006 | 1016 | undefined;
  private dataCbs: Array<(d: string) => void> = [];
  private exitCbs: Array<(code: number) => void> = [];
  exited = false;
  get pid(): number { return this.pty.pid; }

  private constructor(pty: nodePty.IPty, cols: number, rows: number) {
    this.pty = pty;
    this.term = new Terminal({ cols, rows, scrollback: SCROLLBACK_LINES, allowProposedApi: true });
    this.term.loadAddon(this.ser);
    // SerializeAddon preserves mouse tracking but omits SGR/SGR-pixel encoding.
    // Observe the supported modes without consuming them or bypassing xterm's parser.
    for (const final of ['h', 'l']) {
      this.term.parser.registerCsiHandler({ prefix: '?', final }, (params) => {
        for (const param of params) {
          const mode = Array.isArray(param) ? param[0] : param;
          if (mode === 1006 || mode === 1016) this.mouseEncoding = final === 'h' ? mode : undefined;
        }
        return false;
      });
    }
    this.term.parser.registerEscHandler({ final: 'c' }, () => {
      this.mouseEncoding = undefined;
      return false;
    });
    pty.onData((d) => {
      this.term.write(d);
      for (const cb of this.dataCbs) cb(d);
    });
    pty.onExit(({ exitCode }) => {
      this.exited = true;
      for (const cb of this.exitCbs) cb(exitCode);
      this.term.dispose();
    });
  }

  static spawn(opts: SpawnOpts): PtySession {
    if (!existsSync(opts.cwd) || !statSync(opts.cwd).isDirectory()) {
      throw new Error(`Cannot start process: working directory does not exist: ${opts.cwd}`);
    }
    const pty = nodePty.spawn(opts.file, opts.args, {
      name: 'xterm-256color',
      cwd: opts.cwd,
      env: opts.env,
      cols: opts.cols,
      rows: opts.rows,
    });
    return new PtySession(pty, opts.cols, opts.rows);
  }

  onData(cb: (d: string) => void): void { this.dataCbs.push(cb); }
  onExit(cb: (code: number) => void): void { this.exitCbs.push(cb); }

  resize(cols: number, rows: number): void {
    if (this.exited) return;
    this.pty.resize(cols, rows);
    this.term.resize(cols, rows);
  }

  kill(): void {
    if (!this.exited) this.pty.kill();
  }

  /** Wait for the PTY's exit notification; a sent signal alone does not prove termination. */
  terminate(timeoutMs = 7000): Promise<boolean> {
    if (this.exited) return Promise.resolve(true);
    return new Promise((resolve, reject) => {
      const finish = (exited: boolean) => {
        clearTimeout(timer);
        this.exitCbs = this.exitCbs.filter((cb) => cb !== onExit);
        resolve(exited);
      };
      const onExit = () => finish(true);
      const timer = setTimeout(() => finish(false), timeoutMs);
      this.onExit(onExit);
      try { this.kill(); } catch (err) {
        clearTimeout(timer);
        this.exitCbs = this.exitCbs.filter((cb) => cb !== onExit);
        reject(err);
      }
    });
  }

  /** Resolves once everything received so far has been parsed into the buffer. */
  flush(): Promise<void> {
    return new Promise((res) => this.term.write('', res));
  }

  private locked(fn: () => Promise<void>): Promise<void> {
    const run = this.lock.then(fn);
    this.lock = run.catch(() => {});
    return run;
  }

  write(data: string | Buffer): Promise<void> {
    return this.locked(async () => { if (!this.exited) this.pty.write(data); });
  }

  paste(text: string): Promise<void> {
    const body = text.replaceAll('\x1b', ''); // an ESC could close the paste frame; the only place bodies are stripped
    return this.locked(async () => {
      if (this.exited) return;
      this.pty.write(`\x1b[200~${body}\x1b[201~`);
      await new Promise((r) => setTimeout(r, 150));
      if (!this.exited) this.pty.write('\r');
    });
  }

  /** The visible screen as escape sequences with attributes, for a client to repaint from. */
  snapshot(): string {
    const encoding = this.mouseEncoding ? `\x1b[?${this.mouseEncoding}h` : '';
    return this.ser.serialize({ scrollback: 0 }) + encoding;
  }

  /** Last n rows of the viewport (not rows up to the cursor), right-trimmed. */
  screenTail(n: number): string[] {
    const buf = this.term.buffer.active;
    const end = buf.baseY + this.term.rows - 1;
    const start = Math.max(0, end - n + 1);
    const out: string[] = [];
    for (let y = start; y <= end; y++) out.push(buf.getLine(y)?.translateToString(true) ?? '');
    return out;
  }

  classifyScreen(): ScreenClass { return classify(this.screenTail(15)); }
  composerText(): string { return composerTextOf(this.screenTail(15)); }
}

export function buildChildEnv(extra: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined && !/^(CLAUDE|TERM|TERMINFO|COLORTERM)/.test(k)) env[k] = v;
  }
  env.TERM = 'xterm-256color';
  env.COLORTERM = 'truecolor';
  if (!env.LANG) env.LANG = 'en_US.UTF-8';
  return { ...env, ...extra };
}

let pathCache: Promise<string> | undefined;

/** PATH as seen by the user's login shell; a GUI-launched daemon has a minimal one. */
export function loginShellPath(shell = process.env.SHELL || '/bin/sh'): Promise<string> {
  pathCache ??= new Promise((resolve) => {
    const fallback = process.env.PATH ?? '';
    const child = execFile(shell, ['-ilc', 'echo $PATH'], { timeout: 10_000 }, (err, stdout) => {
      // Interactive shells may print noise first; the PATH is the last line.
      const last = stdout.trim().split('\n').pop()?.trim();
      resolve(err || !last ? fallback : last);
    });
    child.stdin?.end();
  });
  return pathCache;
}
