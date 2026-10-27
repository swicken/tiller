import { describe, expect, it } from 'vitest';
import { branchLabel, ctxLevel, fmtAge, fmtTokens, outcomeLine, shortEffort, shortModel, usageLine, usageParts } from './format.js';

describe('format', () => {
  it('renders an outcome as one line, summary before note', () => {
    expect(outcomeLine({ outcome: 'succeeded', gate: 'passed', summary: 'did\n  it', note: 'n' })).toBe('succeeded (gate passed): did it');
    expect(outcomeLine({ outcome: 'failed', note: 'broke' })).toBe('failed: broke');
    expect(outcomeLine({ outcome: 'succeeded' })).toBe('succeeded');
  });
  it('labels a read-only worktree as detached at its base', () => {
    expect(branchLabel({ branch: 'tl/n-1', base: 'main' })).toBe('tl/n-1');
    expect(branchLabel({ base: 'main' })).toBe('detached @ main');
  });
  it('shortens model ids', () => {
    expect(shortModel('claude-opus-5-5')).toBe('opus 5.5');
    expect(shortModel('claude-sonnet-5-5')).toBe('sonnet 5.5');
    expect(shortModel('claude-haiku-5-5')).toBe('haiku 5.5');
    expect(shortModel('claude-fable-5-1')).toBe('fable 5.1');
    expect(shortModel('claude-3-7-sonnet')).toBe('3-7-sonnet');
    expect(shortModel('gpt-x')).toBe('gpt-x');
    expect(shortModel(undefined)).toBe('');
  });
  it('shortens effort', () => {
    expect(shortEffort('medium')).toBe('med');
    expect(shortEffort('xhigh')).toBe('xhigh');
  });
  it('fmtAge', () => {
    expect([0, 4_000, 5_000, 59_000, 180_000, 3_600_000, 90_000_000, -5].map(fmtAge)).toEqual(['now', 'now', '5s', '59s', '3m', '1h', '1d', 'now']);
  });
  it('ctxLevel thresholds: green below 50, amber 50 to 80 inclusive, red above', () => {
    expect([0, 49.9, 50, 80, 80.1, 100].map(ctxLevel)).toEqual(['ok', 'ok', 'warn', 'warn', 'bad', 'bad']);
  });
  it('fmtTokens', () => {
    expect([999, 84_000, 1_500_000].map(fmtTokens)).toEqual(['999', '84k', '1.5M']);
  });
  it('usage: windows with reset times, amber above 80%, red above 95%', () => {
    const now = new Date(2026, 9, 13, 12, 0).getTime(); // local time, so the printed reset times do not depend on the zone
    const limits = [
      { kind: 'five_hour', percentUsed: 42.4, resetsAt: new Date(2026, 9, 13, 14, 30).toISOString() },
      { kind: 'seven_day', percentUsed: 80.5, resetsAt: new Date(2026, 9, 15, 9, 5).toISOString() },
      { kind: 'spend_limit', percentUsed: 96 },
    ];
    const weekday = new Date(2026, 9, 15).toLocaleDateString([], { weekday: 'short' });
    expect(usageParts(limits, false, now)).toEqual([
      { text: '5h 42% · resets 14:30', level: 'ok' },
      { text: `7d 81% · resets ${weekday} 09:05`, level: 'warn' },
      { text: 'spend_limit 96%', level: 'bad' },
    ]);
    expect(usageParts(limits, true, now).map((p) => p.text)).toEqual(['5h 42%', '7d 81%', 'spend_limit 96%']);
    expect(usageParts([{ kind: 'five_hour', percentUsed: 80 }, { kind: 'five_hour', percentUsed: 95 }]).map((p) => p.level)).toEqual(['ok', 'warn']);
    expect(usageParts([{ kind: 'five_hour', percentUsed: 1, resetsAt: 'garbage' }])[0]!.text).toBe('5h 1%');
    expect(usageLine(undefined)).toBe('usage: no report yet');
    expect(usageLine({ rateLimits: limits.slice(0, 1), nodeId: 'n-1', at: now - 120_000 }, now)).toBe('usage: 5h 42% · resets 14:30 (from n-1, 2m ago)');
  });
});

it('marks expired windows without presenting the prior percentage as current', () => {
  const now = new Date(2026, 9, 17, 12).getTime();
  const date = new Date(2026, 9, 13, 14, 30);
  expect(usageParts([{ kind: 'five_hour', percentUsed: 10, resetsAt: date.toISOString() }], false, now)[0].text).toBe('5h · reset passed · awaiting report');
});

it('marks stale individual windows even while another window refreshed recently', () => {
  expect(usageParts([{ kind: '7d', percentUsed: 45, observedAt: 1000 }], false, 601000)[0].text).toBe('7d 45% · stale (10m ago)');
});
