import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { discoverUsage, UsageRegistry, usageReportsSchema } from './usage.js';

it('discovers tools without live agents and treats config files as evidence, not authentication', () => {
  const home = mkdtempSync(join(tmpdir(), 'tl-usage-'));
  try {
    const bin = join(home, 'bin'); mkdirSync(bin); mkdirSync(join(home, '.codex'));
    writeFileSync(join(bin, 'codex'), ''); chmodSync(join(bin, 'codex'), 0o755);
    writeFileSync(join(home, '.codex', 'auth.json'), 'credentials must not be read');
    const sources = discoverUsage(bin, { home, env: {}, now: 1 });
    expect(sources.find((s) => s.tool === 'codex')).toMatchObject({ installed: true, configured: true, authenticated: null, availability: 'unknown', rateLimits: [] });
    expect(sources.find((s) => s.tool === 'claude')).toMatchObject({ installed: false, configured: null });
    expect(sources.find((s) => s.tool === 'pi')).toMatchObject({ availability: 'unavailable', rateLimits: [] });
  } finally { rmSync(home, { recursive: true, force: true }); }
});

it('retains independent unknown accounts, shares identified pools, and does not erase on empty readings', () => {
  const registry = new UsageRegistry('');
  registry.record('claude', 'a', [{ scope: 'account', rateLimits: [{ kind: '5h', percentUsed: 10 }] }], 100);
  registry.record('claude', 'b', [{ scope: 'account', rateLimits: [{ kind: '5h', percentUsed: 90 }] }], 200);
  registry.record('claude', 'a', [{ scope: 'account', rateLimits: [] }], 300);
  expect(registry.sources.filter((s) => s.at).map((s) => [s.nodeIds, s.rateLimits[0].percentUsed, s.at])).toEqual([[['a'], 10, 100], [['b'], 90, 200]]);
  const report = { accountId: 'acct', pool: 'shared', scope: 'account' as const, rateLimits: [{ kind: '7d', percentUsed: 20 }] };
  registry.record('codex', 'c', [report], 400); registry.record('codex', 'd', [report], 500);
  expect(registry.sources.find((s) => s.tool === 'codex' && s.at)).toMatchObject({ nodeIds: ['c', 'd'], at: 500 });
});

it('rejects malformed model scope and percentages at the report boundary', () => {
  expect(usageReportsSchema.safeParse([{ scope: 'model', rateLimits: [] }]).success).toBe(false);
  expect(usageReportsSchema.safeParse([{ scope: 'account', rateLimits: [{ kind: '5h', percentUsed: NaN }] }]).success).toBe(false);
});

it('keeps past-account snapshots in the overview but removes them from a node that switched accounts', () => {
  const registry = new UsageRegistry('');
  const report = { provider: 'openai', accountId: 'old', scope: 'account' as const, rateLimits: [{ kind: '5h', percentUsed: 90 }] };
  registry.record('codex', 'a', [report], 100);
  registry.record('codex', 'a', [{ ...report, accountId: 'new', rateLimits: [{ kind: '5h', percentUsed: 10 }] }], 200);
  expect(registry.sources.filter((s) => s.at).map((s) => [s.accountId, s.nodeIds])).toEqual([['old', []], ['new', ['a']]]);
});

it('keeps distinct metered pool IDs even when display names match', () => {
  const registry = new UsageRegistry('');
  const report = { accountId: 'acct', pool: 'Shared pool', scope: 'account' as const, rateLimits: [{ kind: '5h', percentUsed: 10 }] };
  registry.record('codex', 'a', [{ ...report, poolId: 'one' }, { ...report, poolId: 'two' }], 100);
  expect(registry.sources.filter((s) => s.at).map((s) => s.poolId)).toEqual(['one', 'two']);
});

it('probes versions without sessions, labels broken executables, bounds hangs and caches concurrent scans', async () => {
  const home = mkdtempSync(join(tmpdir(), 'tl-usage-probe-'));
  try {
    const marker = join(home, 'calls');
    const scripts = {
      claude: `#!/bin/sh\n[ "$1" = --version ] || exit 1\necho version >> '${marker}'\necho 'Claude Code test-version'\n`,
      codex: '#!/missing-tiller-test-interpreter\n',
      pi: `#!${process.execPath}\nif (process.argv[2] !== '--version') throw Error('only version allowed'); setInterval(() => {}, 10000);`,
    };
    for (const [tool, script] of Object.entries(scripts)) { writeFileSync(join(home, tool), script); chmodSync(join(home, tool), 0o755); }
    const registry = new UsageRegistry(home, undefined, 500); // independent of any nodes or configured accounts
    expect(registry.sources.every((s) => s.installed && s.authenticated === null && s.rateLimits.length === 0)).toBe(true);
    const started = Date.now();
    await Promise.all([registry.refresh(100000), registry.refresh(100000)]);
    expect(Date.now() - started).toBeLessThan(5000);
    expect(registry.sources.find((s) => s.tool === 'claude')).toMatchObject({ version: 'Claude Code test-version', executableStatus: 'ready', authenticated: null });
    expect(registry.sources.filter((s) => s.tool !== 'claude').map((s) => s.executableStatus)).toEqual(['broken', 'broken']);
    await registry.refresh(100001);
    expect(readFileSync(marker, 'utf8')).toBe('version\n');
    registry.record('codex', 'old-agent', [{ scope: 'account', rateLimits: [{ kind: '5h', percentUsed: 40 }] }], 100000);
    rmSync(join(home, 'codex'));
    await registry.refresh(160001);
    expect(registry.sources.find((s) => s.id === 'discovery:codex')).toMatchObject({ installed: false });
    expect(registry.sources.find((s) => s.at)?.rateLimits[0].percentUsed).toBe(40);
    expect(readFileSync(marker, 'utf8')).toBe('version\nversion\n');
  } finally { rmSync(home, { recursive: true, force: true }); }
});

it('unavailable API reports retain exact snapshots as stale and recover only on new quota data', () => {
  const registry = new UsageRegistry('');
  const report = { scope: 'account' as const, rateLimits: [{ kind: '5h', percentUsed: 25 }] };
  registry.record('codex', 'a', [report], 100);
  registry.record('codex', 'b', [{ ...report, rateLimits: [{ kind: '5h', percentUsed: 75 }] }], 200);
  registry.unavailable('codex', 'a', 300);
  expect(registry.sources.find((s) => s.at === 100)).toMatchObject({ availability: 'unavailable', rateLimits: report.rateLimits, at: 100 });
  expect(registry.sources.find((s) => s.at === 200)?.availability).toBe('available');
  expect(registry.sources.find((s) => s.id === 'unavailable:codex:a')).toMatchObject({ rateLimits: [], authenticated: null, nodeIds: ['a'], availability: 'unavailable' });
  registry.record('codex', 'a', [report], 400);
  expect(registry.sources.some((s) => s.id === 'unavailable:codex:a')).toBe(false);
  expect(registry.sources.find((s) => s.at === 400)?.availability).toBe('available');
});

it('bounds removed unidentified snapshots per tool without blending active accounts or sending empty changes', () => {
  const registry = new UsageRegistry('');
  const report = { scope: 'account' as const, rateLimits: [{ kind: '5h', percentUsed: 5 }] };
  expect(registry.record('claude', 'live', [report], 1)).toBe(true);
  expect(registry.record('claude', 'live', [], 2)).toBe(false);
  for (let i = 0; i < 100; i++) {
    const id = `closed-${i}`;
    registry.record('claude', id, [{ ...report, rateLimits: [{ kind: '5h', percentUsed: i }] }], i + 10);
    registry.remove(id);
  }
  const reports = registry.sources.filter((s) => s.at !== undefined);
  expect(reports).toHaveLength(2);
  expect(reports.find((s) => s.nodeIds.includes('live'))?.rateLimits[0].percentUsed).toBe(5);
  expect(reports.find((s) => !s.nodeIds.length)?.rateLimits[0].percentUsed).toBe(99);
  expect(registry.remove('never-existed')).toBe(false);
});

it('merges shared pools by window observation time instead of regressing to another reporter’s cached window', () => {
  const registry = new UsageRegistry('');
  const report = { accountId: 'shared', poolId: 'codex', scope: 'account' as const, rateLimits: [
    { kind: '5h', windowId: 'primary', percentUsed: 20, observedAt: 100 },
    { kind: '7d', windowId: 'secondary', percentUsed: 40, observedAt: 100 },
  ] };
  registry.record('codex', 'a', [report], 100);
  registry.record('codex', 'b', [{ ...report, rateLimits: [{ kind: '7d', windowId: 'secondary', percentUsed: 45, observedAt: 200 }] }], 200);
  registry.record('codex', 'a', [{ ...report, rateLimits: [{ ...report.rateLimits[0], percentUsed: 21, observedAt: 300 }, report.rateLimits[1]] }], 300);
  expect(registry.sources.find((s) => s.accountId === 'shared')?.rateLimits.map((l) => l.percentUsed)).toEqual([21, 45]);
  expect(registry.record('codex', 'a', [{ ...report, rateLimits: [report.rateLimits[1]] }], 400)).toBe(false);
});


it('ignores empty PATH entries instead of detecting an executable in the daemon working directory', () => {
  const home = mkdtempSync(join(tmpdir(), 'tl-usage-cwd-'));
  try {
    writeFileSync(join(home, 'claude'), '#!/bin/sh\necho must-not-run\n'); chmodSync(join(home, 'claude'), 0o755);
    const moduleUrl = new URL('./usage.ts', import.meta.url).href;
    const result = execFileSync(process.execPath, ['--import', import.meta.resolve('tsx'), '--input-type=module', '-e',
      `import { discoverUsage } from ${JSON.stringify(moduleUrl)}; console.log(JSON.stringify(discoverUsage('::').map(s => s.installed)));`], { cwd: home, encoding: 'utf8' });
    expect(JSON.parse(result)).toEqual([false, false, false]);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

it('applies full-read window tombstones and rejects older cached windows after removal', () => {
  const registry = new UsageRegistry('');
  const report = { accountId: 'a', poolId: 'codex', scope: 'account' as const, rateLimits: [
    { kind: 'primary', windowId: 'primary', percentUsed: 10, observedAt: 100 },
    { kind: 'spend control', windowId: 'individualLimit', percentUsed: 75, observedAt: 100 },
  ] };
  registry.record('codex', 'one', [report], 100);
  registry.record('codex', 'one', usageReportsSchema.parse([{ ...report, rateLimits: [], removedWindows: [{ windowId: 'individualLimit', observedAt: 200 }] }]), 200);
  expect(registry.sources.find((s) => s.accountId === 'a')?.rateLimits.map((l) => l.windowId)).toEqual(['primary']);
  registry.record('codex', 'two', [report], 300); // another reporter still caches the removed spend window
  expect(registry.sources.find((s) => s.accountId === 'a')?.rateLimits.map((l) => l.windowId)).toEqual(['primary']);
  registry.record('codex', 'one', [{ ...report, rateLimits: [], removedWindows: [{ windowId: 'primary', observedAt: 400 }] }], 400);
  expect(registry.sources.find((s) => s.accountId === 'a')).toMatchObject({ rateLimits: [], availability: 'unavailable' });
});

it('keeps a healthy shared-account snapshot available when one reporter fails', () => {
  const registry = new UsageRegistry('');
  const report = { accountId: 'shared', scope: 'account' as const, rateLimits: [{ kind: '5h', percentUsed: 45 }] };
  registry.record('codex', 'failed', [report], 100);
  registry.record('codex', 'healthy', [report], 200);
  registry.unavailable('codex', 'failed', 300);
  expect(registry.sources.find((s) => s.accountId === 'shared')).toMatchObject({ availability: 'available', at: 200, nodeIds: ['failed', 'healthy'] });
  expect(registry.sources.find((s) => s.id === 'unavailable:codex:failed')?.nodeIds).toEqual(['failed']);
  expect(registry.sources.some((s) => s.id === 'unavailable:codex:healthy')).toBe(false);
});

it('keys Claude reports by the daemon-stamped Tiller account, so nodes of one account share a source', () => {
  const registry = new UsageRegistry('');
  const report = (percentUsed: number, account?: string) => ({ scope: 'account' as const, ...(account ? { account } : {}), rateLimits: [{ kind: 'five_hour', percentUsed }] });
  registry.record('claude', 'a', [report(10, 'work')], 100);
  registry.record('claude', 'b', [report(20, 'work')], 200);
  registry.record('claude', 'c', [report(30)], 300);
  registry.record('claude', 'd', [report(40)], 400);
  expect(registry.sources.filter((s) => s.at).map((s) => [s.account, s.nodeIds, s.rateLimits[0]!.percentUsed])).toEqual([
    ['work', ['a', 'b'], 20], [undefined, ['c'], 30], [undefined, ['d'], 40],
  ]);
  registry.record('claude', 'a', [report(5, 'personal')], 500); // a node now in another account leaves the old source
  expect(registry.sources.find((s) => s.account === 'work')!.nodeIds).toEqual(['b']);
  const acct = mkdtempSync(join(tmpdir(), 'tl-usage-acct-'));
  try {
    writeFileSync(join(acct, '.claude.json'), '{}');
    const configured = (dirs: string[]) => discoverUsage('', { home: join(acct, 'no-home'), env: {}, now: 0, claudeDirs: dirs }).find((s) => s.tool === 'claude')!.configured;
    expect([configured([]), configured([acct])]).toEqual([null, true]);
  } finally { rmSync(acct, { recursive: true, force: true }); }
});
