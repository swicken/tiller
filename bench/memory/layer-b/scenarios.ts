// The Layer B scenarios (bench plan §3.3), each pre-registered (§3.4 rule 7): its repo, brief 2, the canned phase-1
// episodes it seeds, the B0 targets, the primary metric with its direction, and the trap-hit rule. Changing a scenario
// changes its source hash, which every result records.
import type { Episode, Matcher, Repeat } from '../lib/fixture.js';
import type { ArmScore } from './score.js';
import { cachedRatesvc, GATE, HIDDEN_RATES_TEST, ledgerlib, ratesvc, type Files } from './repos.js';

export interface Primary {
  /** An ArmScore field. */
  key: 'firstPassGate' | 'toolCallsToVerify' | 'changelogTouched' | 'success';
  kind: 'binary' | 'count';
  /** The direction of benefit (for S5, of no harm). */
  better: 'higher' | 'lower';
  /** S5d: one-sided non-inferiority margin for on − off, in the metric's units (rate points as a fraction). */
  margin?: number;
}

export interface Scenario {
  name: string;
  id: string;
  claim: number;
  /** The fake origin's name; memory keys the store on it. */
  repo: string;
  files: () => Files;
  /** Files at <trial>/hidden, outside every arm's repo (S4's acceptance test). */
  hidden?: Files;
  title: string;
  brief: string;
  /** The canned phase-1 history, through the real derive and store (lib/fixture.ts), repo alias "r". */
  seed: (Episode | Repeat)[];
  /** B0: items that must be in the on arm's digest for the brief. */
  targets: Matcher[];
  /** B0 is recorded, not required (S5d: noise presence is reported). */
  b0Report?: true;
  primary: Primary;
  /** Whether the arm fell into the trap (§3.5 validity: the off arm should, at least half the time). */
  trapHit: (a: ArmScore) => boolean;
  /** $0 checks: R1's gate as built; overlays solving brief 2: the gate passes on `solved` and fails on `trapped`, the trap's solution. */
  r1Gate: 'pass' | 'fail';
  solved: Files;
  trapped?: Files;
}

const SEED_ROOT = 'n-5eed0000';

/** One seeded phase-1 node: spawn, the gate runs (false = failed with tail), the outcome and the close. */
function phase1(o: {
  at: string; node: string; title: string; prompt: string; gates: (string | true)[]; summary: string; verified: string; changedFiles: string[];
}): Episode[] {
  const ep = (min: number, event: Episode['event']): Episode => ({ at: `${o.at}+${min}m`, repo: 'r', node: o.node, root: SEED_ROOT, event });
  return [
    ep(0, { type: 'spawn', prompt: o.prompt }),
    ...o.gates.map((g, i) => ep(4 + 2 * i, g === true ? { type: 'gate', ok: true, command: GATE } : { type: 'gate', ok: false, command: GATE, tail: g })),
    ep(4 + 2 * o.gates.length, { type: 'outcome', outcome: 'succeeded', gate: 'passed', summary: o.summary, verified: o.verified, changedFiles: o.changedFiles }),
    ep(5 + 2 * o.gates.length, { type: 'close', archived: { title: o.title } }),
  ];
}

const exitLine = `${GATE}: exited with 1`;
const changelogTail = (file: string) => `$ ${GATE}\nchangelog check: ## Unreleased has no entry for ${file} (scripts/check-changelog.mjs)\n${exitLine}`;

// --- S1 gate-trap (claim 1) ---

/**
 * The plan's S1 brief shares no search term with the changelog pitfall: src, js and tests are code stopwords since D-2,
 * and nothing else overlaps, so B0 fails (D-1; Layer A's A1 worker-overlap query records the same miss). S1 therefore
 * names src/format.js, the file the pitfall is about, and the plan's brief stays as S1p, a B0-only record of the miss.
 */
const S1_PLAN_BRIEF = 'Add `parseCents(s)` to src/money.js, the inverse of formatCents, with tests.';
const S1_BRIEF = 'Add `parseCents(s)` to src/money.js, the inverse of formatCents in src/format.js, with tests.';
const S1_TITLE = 'parseCents';
const formatCentsTask = phase1({
  at: '-2d', node: 'n-5eed0001', title: 'formatCents',
  prompt: 'Add `formatCents(n)` to src/format.js returning a string like `12.34`, with tests.',
  gates: [changelogTail('src/format.js'), true],
  summary: 'Added formatCents(n) to src/format.js with tests in test/format.test.js. The first gate run failed on the changelog check; '
    + 'added a "- src/format.js:" line under ## Unreleased in CHANGELOG.md and the gate passed.',
  verified: '`node --test` 4 passed; the completion gate passed on the second attempt',
  changedFiles: ['src/format.js', 'test/format.test.js', 'CHANGELOG.md'],
});
const changelogPitfall: Matcher = { kind: 'pitfall', textIncludes: ['changelog check: ## Unreleased has no entry'] };

const PARSE_CENTS = `
/** parseCents('12.34') === 1234: the inverse of formatCents. */
export function parseCents(s) {
  return Math.round(Number(s) * 100);
}
`;
const PARSE_TEST = `import assert from 'node:assert/strict';
import test from 'node:test';
import { parseCents } from '../src/money.js';

test('parseCents inverts formatCents', () => {
  assert.equal(parseCents('12.34'), 1234);
  assert.equal(parseCents('-0.05'), -5);
});
`;
const parseCentsSolution = (changelog?: string): Files => ({
  'src/money.js': ledgerlib({ changelog: 'check' })['src/money.js'] + PARSE_CENTS,
  'test/parse.test.js': PARSE_TEST,
  ...(changelog === undefined ? {} : { 'CHANGELOG.md': changelog }),
});
const withEntry = ledgerlib({ changelog: 'check' })['CHANGELOG.md'].replace('## Unreleased\n', '## Unreleased\n\n- src/money.js: add parseCents(s).\n');

const gateTrap: Scenario = {
  name: 'gate-trap', id: 'S1', claim: 1, repo: 'ledgerlib',
  files: () => ledgerlib({ changelog: 'check' }),
  title: S1_TITLE, brief: S1_BRIEF,
  seed: formatCentsTask,
  targets: [changelogPitfall],
  primary: { key: 'firstPassGate', kind: 'binary', better: 'higher' },
  trapHit: (a) => !a.firstPassGate,
  r1Gate: 'pass',
  solved: parseCentsSolution(withEntry),
  trapped: parseCentsSolution(),
};

/** S1 with the plan's literal brief: B0 records whether the pitfall reaches it (it does not: D-1). Not run live. */
const gateTrapPlanBrief: Scenario = { ...gateTrap, name: 'gate-trap-plan-brief', id: 'S1p', brief: S1_PLAN_BRIEF, b0Report: true };

// --- S2 verify-rediscovery (claim 2) ---

const contractTail = (pair: string) => `$ ${GATE}
✖ contract: ${pair} (0.9ms)
  AssertionError [ERR_ASSERTION]: contract: ${pair} is not in fixtures/v2/rates.json
✔ contract: every published pair is served (0.1ms)
ℹ tests 9
ℹ pass 8
ℹ fail 1
${exitLine}`;

const verifyRediscovery: Scenario = {
  name: 'verify-rediscovery', id: 'S2', claim: 2, repo: 'ratesvc',
  files: ratesvc,
  title: 'GBP to JPY rate', brief: 'Add a `GBP→JPY` rate to src/rates.js and make sure it is verified.',
  seed: phase1({
    at: '-2d', node: 'n-5eed0002', title: 'EUR to CHF rate',
    prompt: 'Add a `EUR→CHF` rate to src/rates.js and make sure it is verified.',
    gates: [contractTail('EUR->CHF'), true],
    summary: 'Added EUR->CHF and its inverse CHF->EUR to src/rates.js and published both in fixtures/v2/rates.json.',
    verified: '`npm test` 2 passed; `node tools/verify.mjs contract` 9 passed',
    changedFiles: ['src/rates.js', 'fixtures/v2/rates.json'],
  }),
  targets: [{ kind: 'procedure', text: 'node tools/verify.mjs contract' }],
  primary: { key: 'toolCallsToVerify', kind: 'count', better: 'lower' },
  trapHit: (a) => !a.verifiedBeforeGate || a.npmTestBeforeVerify,
  r1Gate: 'pass',
  solved: (() => {
    const f = ratesvc();
    const fx = JSON.parse(f['fixtures/v2/rates.json']);
    fx.pairs['GBP->JPY'] = { rate: 192, inverse: 'JPY->GBP' };
    fx.pairs['JPY->GBP'] = { rate: 0.005208, inverse: 'GBP->JPY' };
    return {
      'src/rates.js': f['src/rates.js'].replace("  'CHF->EUR': 1.064,\n", "  'CHF->EUR': 1.064,\n  'GBP->JPY': 192,\n  'JPY->GBP': 0.005208,\n"),
      'fixtures/v2/rates.json': `${JSON.stringify(fx, null, 2)}\n`,
    };
  })(),
  trapped: { 'src/rates.js': ratesvc()['src/rates.js'].replace("  'CHF->EUR': 1.064,\n", "  'CHF->EUR': 1.064,\n  'GBP->JPY': 192,\n") },
};

// --- S4 same-files (claim 4) ---

const SET_RATES = (clear: boolean) => `
/** Changes several rates at once, as one audit entry. */
export function setRates(map) {
  const changes = Object.entries(map);
  for (const [pair, rate] of changes) check(pair, rate);
  for (const [pair, rate] of changes) RATES.set(pair, rate);
${clear ? '  convert.clear();\n' : ''}  audit({ type: 'rates', changes: { ...map } });
}
`;

const sameFiles: Scenario = {
  name: 'same-files', id: 'S4', claim: 4, repo: 'ratesvc',
  files: cachedRatesvc,
  hidden: { 'rates-batch.test.mjs': HIDDEN_RATES_TEST },
  title: 'setRates', brief: 'Add `setRates(map)` to src/rates.js: it updates several rates at once and records them as a single audit entry.',
  seed: phase1({
    at: '-1d', node: 'n-5eed0004', title: 'memoize convert',
    prompt: 'Batch conversions call convert() thousands of times: memoize convert in src/rates.js.',
    gates: [true],
    summary: 'Memoized convert() in src/rates.js through src/memo.js, and anything that changes a rate must call convert.clear() as setRate does, '
      + 'or convert keeps returning amounts at the old rate (src/batch.js converts right after rate changes). Added tests.',
    verified: '`node --test` 3 passed',
    changedFiles: ['src/rates.js', 'src/memo.js', 'src/batch.js', 'test/rates.test.js'],
  }),
  targets: [{ kind: 'ledger', textIncludes: ['convert.clear()'] }],
  primary: { key: 'firstPassGate', kind: 'binary', better: 'higher' },
  trapHit: (a) => !a.firstPassGate,
  r1Gate: 'fail',
  solved: { 'src/rates.js': cachedRatesvc()['src/rates.js'] + SET_RATES(true) },
  trapped: { 'src/rates.js': cachedRatesvc()['src/rates.js'] + SET_RATES(false) },
};

// --- S5a stale pitfall (claim 5) ---

/** The S1 lesson three times, 30 days old, so the pitfall is seen 3 times; the repo has since retired the changelog. */
const stalePitfall: Scenario = {
  name: 'harm-stale', id: 'S5a', claim: 5, repo: 'ledgerlib',
  files: () => ledgerlib({ changelog: 'retired' }),
  title: S1_TITLE, brief: S1_BRIEF,
  seed: [
    ...phase1({ at: '-32d', node: 'n-5eed0051', title: 'formatCents', prompt: 'Add `formatCents(n)` to src/format.js, with tests.',
      gates: [changelogTail('src/format.js'), true], summary: 'Added formatCents(n) with tests; the gate needed a CHANGELOG.md entry.',
      verified: '`node --test` 4 passed', changedFiles: ['src/format.js', 'test/format.test.js', 'CHANGELOG.md'] }),
    ...phase1({ at: '-31d', node: 'n-5eed0052', title: 'pad2 export', prompt: 'Export pad2 from src/format.js and document it.',
      gates: [changelogTail('src/format.js'), true], summary: 'Exported pad2 with a doc comment; the gate needed a CHANGELOG.md entry.',
      verified: '`node --test` 4 passed', changedFiles: ['src/format.js', 'CHANGELOG.md'] }),
    ...phase1({ at: '-30d', node: 'n-5eed0053', title: 'formatCents sign', prompt: 'formatCents(-5) should be -0.05: fix src/format.js.',
      gates: [changelogTail('src/format.js'), true], summary: 'Fixed the sign of small negative amounts in formatCents; the gate needed a CHANGELOG.md entry.',
      verified: '`node --test` 4 passed', changedFiles: ['src/format.js', 'test/format.test.js', 'CHANGELOG.md'] }),
  ],
  targets: [changelogPitfall],
  primary: { key: 'changelogTouched', kind: 'binary', better: 'lower' },
  trapHit: (a) => a.changelogTouched,
  r1Gate: 'pass',
  solved: parseCentsSolution(),
};

// --- S5d unrelated noise (claim 5) ---

const REPORTS = ['totals', 'aging', 'payouts', 'refunds', 'taxes', 'fees', 'disputes', 'ledger', 'monthly', 'quarterly'];
const noise: (Episode | Repeat)[] = [
  {
    repeat: 40,
    each: phase1({
      at: '-20d-{i}h', node: 'n-0015e{i}', title: 'reports {i}',
      prompt: 'Reports: add column {i} to the CSV export in src/reports/export.js and format its numbers.',
      gates: [true], summary: 'Added CSV column {i} to src/reports/export.js, with its number format and a test.',
      verified: '`node --test` passed', changedFiles: ['src/reports/export.js', 'test/reports/export.test.js'],
    }),
  },
  ...REPORTS.flatMap((r, i) => phase1({
    at: `-15d+${i}h`, node: `n-0015f${i}`, title: `reports ${r}`, prompt: `Fix the ${r} report in src/reports/${r}.js.`,
    gates: i < 6 ? [`$ ${GATE}\nError: src/reports/${r}.js: the ${r} report is missing a number format\n${exitLine}`, true] : [true],
    summary: `Fixed the ${r} report in src/reports/${r}.js.`,
    verified: `\`node --test test/reports/${r}.test.js\` passed`, changedFiles: [`src/reports/${r}.js`],
  })),
];

const unrelatedNoise: Scenario = {
  name: 'harm-noise', id: 'S5d', claim: 5, repo: 'ledgerlib',
  files: () => ledgerlib({ changelog: 'none', pad2Bug: true }),
  title: 'pad2 negatives', brief: 'Fix the off-by-one in src/format.js `pad2` for negative numbers: test/format.test.js has a failing case.',
  seed: noise,
  targets: [{ kind: 'ledger', textIncludes: ['reports'] }],
  b0Report: true,
  primary: { key: 'success', kind: 'binary', better: 'higher', margin: 0.10 },
  trapHit: (a) => !a.success,
  r1Gate: 'fail',
  solved: { 'src/format.js': ledgerlib({ changelog: 'none' })['src/format.js'].replace("return String(n).padStart(2, '0');", "return n < 0 ? `-${pad2(-n)}` : String(n).padStart(2, '0');") },
};

export const SCENARIOS: Scenario[] = [gateTrap, gateTrapPlanBrief, verifyRediscovery, sameFiles, stalePitfall, unrelatedNoise];
