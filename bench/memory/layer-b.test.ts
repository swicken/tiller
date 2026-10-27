// Layer B0 (bench plan §2, §3.3) and the Layer B scorer: each scenario's $0 preflight (the planted lesson reaches the
// digest, R1's gate, the solved and trapped overlays), the paired statistics against known values, and scoring of
// synthetic arms. Deterministic and LLM-free.
import { describe, expect, it } from 'vitest';
import { bootstrapCi, mcnemarExact, median, wilcoxon } from './lib/stats.js';
import { SCENARIOS } from './layer-b/scenarios.js';
import { scoreArm, summarize, type ArmRaw, type Trial } from './layer-b/score.js';
import { preflight } from './layer-b/trial.js';

describe('Layer B0 preflight', () => {
  for (const s of SCENARIOS) {
    it(`${s.id} ${s.name}`, () => {
      const p = preflight(s);
      expect(p.checks.filter((c) => !c.ok).map((c) => c.what)).toEqual([]);
      expect(p.digest.startsWith('# Memory')).toBe(true);
    }, 30_000);
  }

  it("S1p: the plan's literal brief does not reach the changelog pitfall (D-1), which is why S1 names src/format.js", () => {
    expect(preflight(SCENARIOS.find((s) => s.id === 'S1p')!).checks[0].what).toMatch(/is not in the digest/);
  }, 30_000);
});

describe('paired statistics', () => {
  it('exact McNemar', () => {
    expect(mcnemarExact(5, 0)).toBeCloseTo(0.0625, 10); // §4: 5 of 5 discordant pairs never reach 0.05
    expect(mcnemarExact(10, 0)).toBeCloseTo(2 / 1024, 10);
    expect(mcnemarExact(3, 3)).toBe(1);
    expect(mcnemarExact(0, 0)).toBe(1);
  });

  it('Wilcoxon signed-rank, exact for small n', () => {
    expect(wilcoxon([1, 2, 3, 4, 5])).toBeCloseTo(2 / 32, 10); // all positive: only the two extreme sign sets
    expect(wilcoxon([0, 0])).toBe(1);
    expect(wilcoxon([1, -1])).toBe(1);
  });

  it('bootstrap CI is seeded and brackets the median', () => {
    const xs = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    const ci = bootstrapCi(xs, median, 2000);
    expect(ci).toEqual(bootstrapCi(xs, median, 2000));
    expect(ci[0]).toBeLessThanOrEqual(5.5);
    expect(ci[1]).toBeGreaterThanOrEqual(5.5);
  });
});

describe('scoring', () => {
  const base = (over: Partial<ArmRaw>): ArmRaw => ({
    label: 'off', mode: 'off', nodeId: 'n-1', end: 'reported', createdAt: 1_000, endedAt: 61_000, spentUsd: 0.1,
    gates: [], calls: [], tools: [{ at: 2_000, name: 'Read' }], injections: [], diff: [],
    tokens: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4 }, autoMemory: false, ...over,
  });
  const passed = { outcome: 'succeeded' as const, gate: 'passed' as const, at: 31_000 };

  it('first-pass gate needs the first daemon gate run to pass', () => {
    expect(scoreArm(base({ outcome: passed, gates: [{ ts: 30_000, ok: true }] }), []).firstPassGate).toBe(true);
    const second = scoreArm(base({ outcome: passed, gates: [{ ts: 20_000, ok: false }, { ts: 30_000, ok: true }] }), []);
    expect(second).toMatchObject({ firstPassGate: false, success: true, gateAttempts: 2, wallSec: 30 });
  });

  it('S2: tool calls before the first own verify run, and the npm test decoy before it', () => {
    const tools = [10, 20, 30, 40, 50].map((at) => ({ at, name: 'Bash' }));
    const calls = [{ ts: 25, cmd: 'npm-test', arg: '', gate: '' }, { ts: 35, cmd: 'verify', arg: 'contract', gate: '' }, { ts: 45, cmd: 'verify', arg: 'contract', gate: '1' }];
    const a = scoreArm(base({ tools, calls, gates: [{ ts: 45, ok: true }], outcome: passed }), []);
    expect(a).toMatchObject({ toolCallsToVerify: 3, verifiedBeforeGate: true, npmTestBeforeVerify: true });
    // Only the gate's own verify run: counted up to the first gate run, not rediscovered.
    const b = scoreArm(base({ tools, calls: calls.slice(2), gates: [{ ts: 45, ok: false }] }), []);
    expect(b).toMatchObject({ toolCallsToVerify: 4, verifiedBeforeGate: false });
  });

  it('voids infra failures and an arm whose injection log contradicts it (§3.4 rules 2 and 5)', () => {
    expect(scoreArm(base({ end: 'blocked', detail: 'needs approval' }), []).voidReason).toMatch(/^blocked/);
    expect(scoreArm(base({ tools: [] }), []).voidReason).toBe('no tool call');
    expect(scoreArm(base({ autoMemory: true }), []).voidReason).toMatch(/auto-memory/);
    const inj = { sessionId: 's', arm: 'on' as const, cause: 'config' as const, itemIds: [1, 2], text: '# Memory', ts: 1 };
    expect(scoreArm(base({ injections: [inj] }), []).voidReason).toMatch(/off arm saw memory/);
    expect(scoreArm(base({ mode: 'on', injections: [] }), [1]).voidReason).toBe('invalid: digest not delivered');
    expect(scoreArm(base({ mode: 'on', injections: [inj], outcome: { ...passed, summary: 'used [m2] and [m9]' } }), [1])).toMatchObject({
      voidReason: undefined, targetsInjected: true, injected: [1, 2], cited: [2],
    });
  });

  it('summarizes pairs: a re-run pair replaces its void attempt', () => {
    const s = SCENARIOS[0];
    const inj = { sessionId: 's', arm: 'on' as const, cause: 'config' as const, itemIds: [2], text: '', ts: 1 };
    const trial = (n: number, attempt: number, off: boolean, on: boolean, voidOn = false): Trial => ({
      trial: n, attempt, startOrder: ['off', 'on'], inputsHash: 'h', targets: [2], shadow: [2],
      arms: [
        base({ gates: [{ ts: 30_000, ok: off }], outcome: { ...passed, gate: off ? 'passed' : 'passed' } }),
        base({ label: 'on', mode: 'on', injections: voidOn ? [] : [inj], gates: [{ ts: 30_000, ok: on }], outcome: passed }),
      ],
    });
    const trials = [trial(1, 1, false, true, true), trial(1, 2, false, true), ...[2, 3, 4, 5, 6].map((n) => trial(n, 1, false, true))];
    const r = summarize(s, trials);
    expect(r).toMatchObject({ pairs: 6, voids: 0, primary: { meanA: 0, meanB: 1, diff: 1, discordant: { bBetter: 6, aBetter: 0 } } });
    expect(r.primary.p).toBeCloseTo(2 / 64, 10);
    expect(r.primary.verdict).toBe('benefit');
    expect(r.voidReasons).toEqual(['t1#1: invalid: digest not delivered']);
  });
});
