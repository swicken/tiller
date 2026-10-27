import { readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import xterm from '@xterm/headless';
import { PtySession, buildChildEnv, classify, composerTextOf, loginShellPath } from './pty.js';

const base = { cwd: '/tmp', cols: 80, rows: 24 };
const env = () => buildChildEnv({});

async function until(cond: () => boolean, ms = 3000) {
  const t = Date.now();
  while (!cond()) {
    if (Date.now() - t > ms) throw new Error('timeout');
    await new Promise((r) => setTimeout(r, 20));
  }
}

function collect(s: PtySession) {
  const box = { out: '' };
  s.onData((d) => { box.out += d; });
  return box;
}

describe('PtySession', () => {
  it('bounds a stop without treating the sent signal as proof, then observes real exit', async () => {
    const s = PtySession.spawn({ ...base, file: process.execPath, args: ['-e', "process.on('SIGHUP', () => {}); console.log('ready'); setInterval(() => {}, 1000)"], env: env() });
    const box = collect(s);
    try {
      await until(() => box.out.includes('ready'));
      expect(await s.terminate(25)).toBe(false);
      expect(s.exited).toBe(false);
      const stopped = s.terminate(2000);
      process.kill(s.pid, 'SIGTERM');
      expect(await stopped).toBe(true);
      expect(s.exited).toBe(true);
      expect(await s.terminate()).toBe(true);
    } finally {
      if (!s.exited) process.kill(s.pid, 'SIGTERM');
    }
  });

  it('delivers data, buffers it, and reports exit', async () => {
    const s = PtySession.spawn({ ...base, file: '/bin/sh', args: ['-c', 'printf "a\\nb\\n"; cat'], env: env(), rows: 10 });
    const box = collect(s);
    await until(() => box.out.includes('b'));
    await s.flush();
    const tail = s.screenTail(10);
    expect(tail).toContain('a');
    expect(tail).toContain('b');
    await s.write('hi\n');
    await until(() => box.out.includes('hi'));
    s.kill();
    await until(() => s.exited);
  });

  it('preserves mouse encoding in snapshots across split modes, disable and reset without consuming native modes', async () => {
    const s = PtySession.spawn({ ...base, file: process.execPath, args: ['-e',
      "process.stdin.setRawMode(true); process.stdin.on('data', d => process.stdout.write(d)); console.log('ready')"], env: env() });
    const box = collect(s);
    try {
      await until(() => box.out.includes('ready'));
      const cases = [
        ['\x1b[?1049;1003;1006;2004h', 1006, 'alternate', 'any'],
        ['\x1b[?10', 1006, 'alternate', 'any'],
        ['06l', 0, 'alternate', 'any'],
        ['\x1b[?1006;1016h', 1016, 'alternate', 'any'],
        ['\x1b[?1006l', 0, 'alternate', 'any'],
        ['\x1b[?1016;1006h', 1006, 'alternate', 'any'],
        ['\x1b[!p', 1006, 'alternate', 'any'], // xterm soft reset retains mouse modes.
        ['\x1b[?1016l', 0, 'alternate', 'any'],
        ['\x1b[?1006h\x1bc', 0, 'normal', 'none'],
        ['\x1b[?1002;1006h', 1006, 'normal', 'drag'], // RIS leaves observers installed.
        ['\x1b[?1002l', 1006, 'normal', 'none'], // Encoding survives capture being disabled.
        ['\x1b[?1016:1h', 1016, 'normal', 'none'], // xterm uses the primary parameter.
      ] as const;
      for (const [sequence, encoding, buffer, tracking] of cases) {
        const offset = box.out.length;
        await s.write(sequence);
        await until(() => box.out.length >= offset + sequence.length);
        await s.flush();
        const restored = new xterm.Terminal({ allowProposedApi: true });
        try {
          let response = '';
          restored.onData((data) => { response += data; });
          await new Promise<void>((resolve) => restored.write(s.snapshot() + '\x1b[?1006$p\x1b[?1016$p', resolve));
          expect(response).toBe(`\x1b[?1006;${encoding === 1006 ? 1 : 2}$y\x1b[?1016;${encoding === 1016 ? 1 : 2}$y`);
          expect(restored.buffer.active.type).toBe(buffer);
          expect(restored.modes.mouseTrackingMode).toBe(tracking);
          if (sequence.includes('2004h')) expect(restored.modes.bracketedPasteMode).toBe(true);
        } finally { restored.dispose(); }
      }
    } finally { await s.terminate(); }
  });

  it('rejects a missing cwd with a clear error', () => {
    expect(() => PtySession.spawn({ ...base, cwd: '/no/such/dir', file: '/bin/sh', args: [], env: env() }))
      .toThrow(/working directory does not exist/);
  });

  it('paste strips ESC and writes concurrent writes in call order', async () => {
    const s = PtySession.spawn({ ...base, file: '/bin/cat', args: [], env: env() });
    const box = collect(s);
    const p = s.paste('x\x1b[201~y');
    const w1 = s.write('AAA');
    const w2 = s.write('BBB');
    await Promise.all([p, w1, w2]);
    await until(() => box.out.includes('BBB'));
    // The tty echoes ESC as ^[ ; the only ones are the frame markers, never from the body.
    expect(box.out).toContain('^[[200~x[201~y^[[201~');
    expect(box.out.indexOf('AAA')).toBeGreaterThan(box.out.indexOf('201~y'));
    expect(box.out.indexOf('BBB')).toBeGreaterThan(box.out.indexOf('AAA'));
    s.kill();
  });

  it('clamps screenTail to the visible rows plus the scrollback', async () => {
    const s = PtySession.spawn({ ...base, file: '/bin/sh', args: ['-c', 'i=0; while [ $i -lt 1500 ]; do echo line-$i; i=$((i+1)); done; cat'], env: env(), rows: 10 });
    try {
      await until(() => { void s.flush(); return s.screenTail(5000).some((l) => l.includes('line-1499')); });
      const tail = s.screenTail(5000);
      expect(tail).toHaveLength(10 + 1000);
      expect(tail).not.toContain('line-0');
    } finally { s.kill(); }
  });

  it('classifies a live screen through the headless buffer', async () => {
    const s = PtySession.spawn({ ...base, file: '/bin/sh', args: ['-c', 'printf "──────\\n❯ draft"; cat'], env: env(), rows: 10 });
    await until(() => { void s.flush(); return s.classifyScreen() === 'prompt'; });
    expect(s.composerText()).toBe('draft');
    s.kill();
  });

  it('releases its file descriptors after the process exits', async () => {
    const fds = () => readdirSync('/dev/fd').length;
    const before = fds();
    for (let i = 0; i < 10; i++) {
      const s = PtySession.spawn({ ...base, file: '/bin/sh', args: ['-c', 'cat'], env: env() });
      expect(await s.terminate(2000)).toBe(true);
    }
    // node-pty 1.1.0 leaked the master, a kqueue and the slave per PTY (+30 here).
    await until(() => fds() <= before + 2).catch(() => {});
    const { version } = createRequire(import.meta.url)('node-pty/package.json');
    expect(fds(), `node-pty ${version} is installed; if package.json pins another, node_modules is stale: run npm ci`).toBeLessThanOrEqual(before + 2);
  });
});

describe('classify', () => {
  const rule = '─'.repeat(40);
  it('prompt between rules', () => {
    expect(classify(['hello', rule, '❯', rule])).toBe('prompt');
    expect(classify(['hello', rule, '❯ half typed'])).toBe('prompt');
  });
  it('dialog footers and numbered options', () => {
    expect(classify(['Quick safety check', '❯ 1. Yes, I trust this folder', '  2. No, exit'])).toBe('dialog');
    expect(classify([rule, '❯', rule, 'Esc to cancel'])).toBe('dialog');
    expect(classify(['Enter to confirm'])).toBe('dialog');
  });
  it('unknown otherwise', () => {
    expect(classify(['$ ls', 'file'])).toBe('unknown');
    expect(classify([])).toBe('unknown');
  });
  it('composerText', () => {
    expect(composerTextOf([rule, '❯', rule])).toBe('');
    expect(composerTextOf([rule, '❯ fix the bug  '])).toBe('fix the bug');
  });
});

describe('env helpers', () => {
  it('buildChildEnv drops Claude/TERM vars and sets defaults', () => {
    const saved = { ...process.env };
    process.env.CLAUDECODE = '1';
    process.env.TERM_PROGRAM = 'x';
    const e = buildChildEnv({ TL_NODE_ID: 'n-1' });
    process.env = saved;
    expect(e.CLAUDECODE).toBeUndefined();
    expect(e.TERM_PROGRAM).toBeUndefined();
    expect(e.TERM).toBe('xterm-256color');
    expect(e.COLORTERM).toBe('truecolor');
    expect(e.LANG).toBeTruthy();
    expect(e.TL_NODE_ID).toBe('n-1');
  });
  it('loginShellPath returns a cached PATH', async () => {
    const p = await loginShellPath('/bin/sh'); // never the user's own login shell
    expect(p).toContain('/');
    expect(await loginShellPath('/bin/sh')).toBe(p);
  }, 15_000);
});
