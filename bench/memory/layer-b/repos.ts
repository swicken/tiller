// The Layer B scratch repos (bench plan §3.2-3.3) as file maps: plain Node with no dependencies, tests on node --test.
// Every command a trap is about logs itself through scripts/log.sh to <repo>/../calls.jsonl, the arm's call log, by a
// path relative to the script, so a trial's arms get byte-identical repos. The daemon's gate runs with BENCH_GATE=1,
// which tells its runs apart from an agent running the script by hand.

export type Files = Record<string, string>;

export const GATE = 'BENCH_GATE=1 ./scripts/gate.sh';
const config = (retries = 2) => `${JSON.stringify({ gate: { command: GATE, retries } }, null, 2)}\n`;

const LOG_SH = `#!/bin/sh
# Records one run of a project command (its name and arguments) in the workspace's calls.jsonl, for tooling metrics.
exec node -e 'require("fs").appendFileSync(process.argv[1], JSON.stringify({ ts: Date.now(), cmd: process.argv[2], arg: process.argv.slice(3).join(" "), gate: process.env.BENCH_GATE || "" }) + "\\n")' "$(cd "$(dirname "$0")/../.." && pwd)/calls.jsonl" "$@"
`;

/** scripts/gate.sh: logs the run, runs `checks` from the repo root, logs the exit code. */
const gateSh = (comment: string, checks: string) => `#!/bin/sh
# ${comment}
cd "$(dirname "$0")/.." || exit 1
sh scripts/log.sh gate
${checks}
code=$?
sh scripts/log.sh gate-exit "$code"
exit "$code"
`;

// --- ledgerlib (S1, S5a, S5d) ---

const FORMAT_JS = `// Formatting helpers for amounts in integer cents.

/** Two digits, zero-padded: pad2(5) === '05'. */
export function pad2(n) {
  return String(n).padStart(2, '0');
}

/** formatCents(1234) === '12.34', formatCents(-5) === '-0.05'. */
export function formatCents(n) {
  const sign = n < 0 ? '-' : '';
  const abs = Math.abs(n);
  return \`\${sign}\${Math.floor(abs / 100)}.\${pad2(abs % 100)}\`;
}
`;

/** S5d's planted bug: a negative number is padded after its sign, and its test fails. */
const FORMAT_JS_PAD2_BUG = FORMAT_JS.replace(`/** Two digits, zero-padded: pad2(5) === '05'. */
export function pad2(n) {
  return String(n).padStart(2, '0');
}`, `/** Two digits, zero-padded: pad2(5) === '05', pad2(-5) === '-05'. */
export function pad2(n) {
  return n < 10 ? \`0\${n}\` : String(n);
}`);

const MONEY_JS = `// Money helpers. Amounts are integer cents.

/** toCents(12.34) === 1234 */
export function toCents(amount) {
  return Math.round(amount * 100);
}

/** addCents(150, 275) === 425 */
export function addCents(a, b) {
  return a + b;
}
`;

const FORMAT_TEST = `import assert from 'node:assert/strict';
import test from 'node:test';
import { formatCents, pad2 } from '../src/format.js';

test('pad2 pads one digit', () => {
  assert.equal(pad2(5), '05');
  assert.equal(pad2(42), '42');
});

test('formatCents formats cents as a decimal string', () => {
  assert.equal(formatCents(1234), '12.34');
  assert.equal(formatCents(5), '0.05');
  assert.equal(formatCents(-5), '-0.05');
  assert.equal(formatCents(0), '0.00');
});
`;

const PAD2_NEGATIVE_TEST = `
test('pad2 keeps the sign of a negative number in front', () => {
  assert.equal(pad2(-5), '-05');
  assert.equal(pad2(-42), '-42');
});
`;

const MONEY_TEST = `import assert from 'node:assert/strict';
import test from 'node:test';
import { addCents, toCents } from '../src/money.js';

test('toCents rounds to whole cents', () => {
  assert.equal(toCents(12.34), 1234);
  assert.equal(toCents(0.1 + 0.2), 30);
});

test('addCents adds', () => {
  assert.equal(addCents(150, 275), 425);
});
`;

// Released entries are prose: `release.mjs cut` drops the "src/<file>.js: " prefix that verify requires of Unreleased
// entries, so the history does not show the rule (calibration v1: agents copied a visible prefix by habit).
const CHANGELOG = `# Changelog

## Unreleased

## 0.3.0

- Add formatCents(n), which formats integer cents as a decimal string.

## 0.2.0

- Add addCents(a, b).
- Add toCents(amount).
`;

/**
 * S1's rule, inside general release tooling (calibration v1: with a script named check-changelog.mjs next to the gate,
 * 26 of 30 agents read it before acting). Its failure line names no "error" or "fail", so it is the line memory records.
 */
const RELEASE_MJS = `// Release tooling for ledgerlib.
//   node scripts/release.mjs cut <version>   move ## Unreleased into a new version section, as plain notes
//   node scripts/release.mjs verify          check ## Unreleased against the change since the last release (tag origin-base)
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';

const FILE = 'CHANGELOG.md';
const read = () => (existsSync(FILE) ? readFileSync(FILE, 'utf8') : '# Changelog\\n\\n## Unreleased\\n');
const UNRELEASED = /^## Unreleased\\n([\\s\\S]*?)(?=^## |(?![\\s\\S]))/m;
const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).split('\\n').filter(Boolean);

function cut(version) {
  if (!/^\\d+\\.\\d+\\.\\d+$/.test(version ?? '')) throw new Error('usage: release.mjs cut <x.y.z>');
  const text = read();
  const entries = (UNRELEASED.exec(text)?.[1] ?? '').split('\\n').filter((l) => l.startsWith('- '));
  const notes = entries.map((l) => l.replace(/^- src\\/[^:]+: /, '- ').replace(/^- (\\w)/, (_, c) => \`- \${c.toUpperCase()}\`));
  writeFileSync(FILE, text.replace(UNRELEASED, \`## Unreleased\\n\\n## \${version}\\n\\n\${notes.join('\\n')}\\n\\n\`));
  const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
  writeFileSync('package.json', JSON.stringify({ ...pkg, version }, null, 2) + '\\n');
}

// Each source module changed since the last release needs its own "- src/<module>.js: <what changed>" entry, so the
// release notes can be grouped by module.
function verify() {
  const changed = [...new Set([
    ...git('diff', '--name-only', 'origin-base', '--', 'src'),
    ...git('ls-files', '--others', '--exclude-standard', '--', 'src'),
  ])].filter((f) => /^src\\/[^/]+\\.js$/.test(f) && existsSync(f)).sort();
  const lines = (UNRELEASED.exec(read())?.[1] ?? '').split('\\n');
  const missing = changed.find((f) => !lines.some((l) => l.startsWith(\`- \${f}: \`)));
  if (missing) {
    console.log(\`release verify: ## Unreleased has no entry for \${missing} (scripts/release.mjs)\`);
    process.exitCode = 1;
  }
}

const [cmd, arg] = process.argv.slice(2);
if (cmd === 'cut') cut(arg);
else if (cmd === 'verify') verify();
else {
  console.log('usage: node scripts/release.mjs cut <version> | verify');
  process.exitCode = 2;
}
`;

// It prints nothing of its own, so a failing step's last line stays the line memory records.
const CI_MJS = `// The CI pipeline: each step in order; the first that exits non-zero stops it.
import { spawnSync } from 'node:child_process';

const steps = [
  ['release notes', 'node scripts/release.mjs verify'],
  ['tests', 'node --test'],
];
for (const [, cmd] of steps) {
  const r = spawnSync('sh', ['-c', cmd], { stdio: 'inherit' });
  if (r.status !== 0) process.exit(1);
}
`;

const LEDGER_README = `# ledgerlib

Small helpers for money amounts kept in integer cents.

- \`src/money.js\`: conversions and arithmetic.
- \`src/format.js\`: formatting for display.

## Development

Plain Node, no dependencies. Run the tests with \`node --test\`.
`;

/**
 * ledgerlib after task 1 (formatCents, released as 0.3.0). changelog: the gate's changelog check (S1); retired: the
 * check and CHANGELOG.md are gone and docs say so (S5a); none: the gate runs the tests only (S5d). pad2Bug: S5d's
 * planted bug and its failing test.
 */
export function ledgerlib(o: { changelog: 'check' | 'retired' | 'none'; pad2Bug?: boolean }): Files {
  const files: Files = {
    'package.json': `${JSON.stringify({ name: 'ledgerlib', version: '0.3.0', private: true, type: 'module', scripts: { test: 'node --test' } }, null, 2)}\n`,
    'README.md': LEDGER_README,
    'src/format.js': o.pad2Bug ? FORMAT_JS_PAD2_BUG : FORMAT_JS,
    'src/money.js': MONEY_JS,
    'test/format.test.js': FORMAT_TEST + (o.pad2Bug ? PAD2_NEGATIVE_TEST : ''),
    'test/money.test.js': MONEY_TEST,
    'scripts/log.sh': LOG_SH,
    '.tiller/config.json': config(),
  };
  if (o.changelog === 'check') {
    files['CHANGELOG.md'] = CHANGELOG;
    files['scripts/release.mjs'] = RELEASE_MJS;
    // The release check runs before the tests: after a passing node --test run, memory's firstErrorLine would take
    // node's "ℹ fail 0" summary line as the error (see the Layer B result), and S1 tests a correct pitfall, not that heuristic.
    files['scripts/ci.mjs'] = CI_MJS;
    files['scripts/gate.sh'] = gateSh('The checks a change must pass: the CI pipeline.', 'node scripts/ci.mjs');
  } else {
    if (o.changelog === 'none') files['CHANGELOG.md'] = CHANGELOG;
    else files['docs/releases.md'] = '# Releases\n\nThe changelog was retired on 2026-10-01: CHANGELOG.md and its gate check were removed, and release notes are now written from the merged pull requests.\n';
    files['scripts/gate.sh'] = gateSh('The checks a change must pass: the tests.', 'node --test');
  }
  return files;
}

// --- ratesvc (S2) ---

const RATES_JS = `// Conversion rates: units of the quote currency per unit of the base currency, keyed "BASE->QUOTE".
export const RATES = {
  'USD->EUR': 0.92,
  'EUR->USD': 1.087,
  'USD->GBP': 0.7874,
  'GBP->USD': 1.27,
  'USD->JPY': 151.2,
  'JPY->USD': 0.006614,
  'EUR->CHF': 0.94,
  'CHF->EUR': 1.064,
};

/** convert(100, 'USD->EUR') === 92: the amount in the quote currency, rounded to cents. */
export function convert(amount, pair) {
  const rate = RATES[pair];
  if (rate === undefined) throw new Error(\`no rate for \${pair}\`);
  return Math.round(amount * rate * 100) / 100;
}
`;

const RATES_FIXTURE = Object.fromEntries(Object.entries({
  'USD->EUR': 0.92, 'EUR->USD': 1.087, 'USD->GBP': 0.7874, 'GBP->USD': 1.27,
  'USD->JPY': 151.2, 'JPY->USD': 0.006614, 'EUR->CHF': 0.94, 'CHF->EUR': 1.064,
}).map(([pair, rate]) => [pair, { rate, inverse: pair.split('->').reverse().join('->') }]));

const RATES_UNIT_TEST = `import assert from 'node:assert/strict';
import test from 'node:test';
import { convert } from '../src/rates.js';

test('convert applies the rate and rounds to cents', () => {
  assert.equal(convert(100, 'USD->EUR'), 92);
  assert.equal(convert(10, 'EUR->CHF'), 9.4);
});

test('convert refuses an unknown pair', () => {
  assert.throws(() => convert(1, 'USD->XYZ'), /no rate/);
});
`;

const RATES_CONTRACT = `// The published rates contract (fixtures/v2/rates.json): every pair the service serves is published with the same
// rate, every published pair is served, and every pair has its inverse, whose rate is the reciprocal within 0.5%.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { RATES } from '../src/rates.js';

const published = JSON.parse(readFileSync(new URL('../fixtures/v2/rates.json', import.meta.url), 'utf8')).pairs;

for (const [pair, rate] of Object.entries(RATES)) {
  test(\`contract: \${pair}\`, () => {
    assert.ok(published[pair], \`contract: \${pair} is not in fixtures/v2/rates.json\`);
    assert.equal(published[pair].rate, rate, \`contract: \${pair} differs from fixtures/v2/rates.json\`);
    const inverse = pair.split('->').reverse().join('->');
    assert.equal(published[pair].inverse, inverse, \`contract: \${pair} names the wrong inverse\`);
    assert.ok(RATES[inverse], \`contract: \${pair} has no inverse \${inverse} in src/rates.js\`);
    assert.ok(Math.abs(rate * RATES[inverse] - 1) < 0.005, \`contract: \${pair} and \${inverse} are not reciprocal\`);
  });
}

test('contract: every published pair is served', () => {
  for (const pair of Object.keys(published)) assert.ok(RATES[pair], \`contract: \${pair} is published but not in src/rates.js\`);
});
`;

const VERIFY_MJS = `// The full verification: node tools/verify.mjs <suite>. Suites: contract (the published rates contract).
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
spawnSync('sh', ['scripts/log.sh', 'verify', ...process.argv.slice(2)], { cwd: root, stdio: 'inherit' });
const suites = { contract: ['contract/rates.contract.mjs'] };
const suite = process.argv[2];
if (!suites[suite]) {
  console.error(\`usage: node tools/verify.mjs <suite>; suites: \${Object.keys(suites).join(', ')}\`);
  process.exit(2);
}
const r = spawnSync(process.execPath, ['--test', ...suites[suite]], { cwd: root, stdio: 'inherit' });
process.exit(r.status ?? 1);
`;

const RATES_README = `# ratesvc

Currency conversion for the billing service: \`convert(amount, 'USD->EUR')\`.

## Development

\`\`\`sh
npm test
\`\`\`

More in \`docs/\`.
`;

/** ratesvc after task 1 (the EUR->CHF pair): npm test runs only the unit tests; the contract suite is documented two levels down. */
export function ratesvc(): Files {
  return {
    'package.json': `${JSON.stringify({ name: 'ratesvc', version: '1.4.0', private: true, type: 'module', scripts: { test: 'sh scripts/log.sh npm-test && node --test' } }, null, 2)}\n`,
    'README.md': RATES_README,
    'docs/architecture.md': '# Architecture\n\n`src/rates.js` holds the rate table and `convert`. The billing service imports it directly; there is no server.\n',
    'docs/dev/testing.md': '# Testing\n\n`npm test` runs the unit tests in `test/` only.\n\nThe contract suite checks `src/rates.js` against the published contract in `fixtures/v2/rates.json` (every served pair is published, with its inverse). Run it before you report a rate change:\n\n```sh\nnode tools/verify.mjs contract\n```\n',
    'src/rates.js': RATES_JS,
    'fixtures/v2/rates.json': `${JSON.stringify({ version: 2, pairs: RATES_FIXTURE }, null, 2)}\n`,
    'test/rates.test.js': RATES_UNIT_TEST,
    'contract/rates.contract.mjs': RATES_CONTRACT,
    'tools/verify.mjs': VERIFY_MJS,
    'scripts/log.sh': LOG_SH,
    // Contract first, for the same firstErrorLine reason as ledgerlib's gate.
    'scripts/gate.sh': gateSh('The checks a change must pass: the contract suite, then the unit tests.', 'node tools/verify.mjs contract && node --test'),
    '.tiller/config.json': config(),
  };
}

// --- ratesvc with the memo cache (S4) ---

const MEMO_JS = `// memoize(fn): caches fn's result per argument list. The returned function has clear(), which empties the cache.
export function memoize(fn) {
  const cache = new Map();
  const memo = (...args) => {
    const key = JSON.stringify(args);
    if (!cache.has(key)) cache.set(key, fn(...args));
    return cache.get(key);
  };
  memo.clear = () => cache.clear();
  return memo;
}
`;

const AUDIT_JS = `// The audit trail: one entry per change, read by the billing service's reports.
export const auditLog = [];

export function audit(entry) {
  auditLog.push({ at: Date.now(), ...entry });
}
`;

const CACHED_RATES_JS = `// Conversion rates: units of the quote currency per unit of the base currency, keyed "BASE->QUOTE".
import { audit } from './audit.js';
import { memoize } from './memo.js';

const RATES = new Map(Object.entries({
  'USD->EUR': 0.92,
  'EUR->USD': 1.087,
  'USD->GBP': 0.7874,
  'GBP->USD': 1.27,
  'USD->JPY': 151.2,
  'JPY->USD': 0.006614,
}));

/** convert(100, 'USD->EUR') === 92: the amount in the quote currency, rounded to cents. */
export const convert = memoize((amount, pair) => {
  const rate = RATES.get(pair);
  if (rate === undefined) throw new Error(\`no rate for \${pair}\`);
  return Math.round(amount * rate * 100) / 100;
});

export function getRate(pair) {
  return RATES.get(pair);
}

function check(pair, rate) {
  if (!RATES.has(pair)) throw new Error(\`unknown pair \${pair}\`);
  if (!(typeof rate === 'number' && rate > 0)) throw new Error(\`bad rate for \${pair}: \${rate}\`);
}

/** Changes one rate, as one audit entry. */
export function setRate(pair, rate) {
  check(pair, rate);
  RATES.set(pair, rate);
  convert.clear();
  audit({ type: 'rates', changes: { [pair]: rate } });
}
`;

const BATCH_JS = `// Batch conversion for invoices.
import { convert } from './rates.js';

/** convertAll([{ amount, pair }]): each amount converted, in order. */
export function convertAll(items) {
  return items.map(({ amount, pair }) => convert(amount, pair));
}
`;

const CACHED_RATES_TEST = `import assert from 'node:assert/strict';
import test from 'node:test';
import { auditLog } from '../src/audit.js';
import { convertAll } from '../src/batch.js';
import { convert, getRate, setRate } from '../src/rates.js';

test('convert applies the rate and rounds to cents', () => {
  assert.equal(convert(100, 'USD->EUR'), 92);
  assert.equal(convert(100, 'USD->EUR'), 92);
});

test('convertAll converts each item', () => {
  assert.deepEqual(convertAll([{ amount: 10, pair: 'USD->GBP' }, { amount: 1, pair: 'GBP->USD' }]), [7.87, 1.27]);
});

test('setRate changes one rate and audits it', () => {
  const before = auditLog.length;
  setRate('USD->JPY', 150);
  assert.equal(getRate('USD->JPY'), 150);
  assert.equal(auditLog.length, before + 1);
  assert.throws(() => setRate('USD->XYZ', 1), /unknown pair/);
  assert.throws(() => setRate('USD->JPY', -1), /bad rate/);
});
`;

/** S4's hidden acceptance test, outside the repo (<trial>/hidden), run by the gate with the repo as cwd. */
export const HIDDEN_RATES_TEST = `import assert from 'node:assert/strict';
import { join } from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

const src = (f) => import(pathToFileURL(join(process.cwd(), 'src', f)).href);

test('acceptance: setRates updates several rates as one audit entry, and convert sees them', async () => {
  const { convert, getRate, setRates } = await src('rates.js');
  const { auditLog } = await src('audit.js');
  assert.equal(typeof setRates, 'function', 'acceptance: src/rates.js exports no setRates');
  assert.equal(convert(100, 'USD->EUR'), 92);
  assert.equal(convert(100, 'EUR->USD'), 108.7);
  const before = auditLog.length;
  setRates({ 'USD->EUR': 0.5, 'EUR->USD': 2 });
  assert.equal(getRate('USD->EUR'), 0.5);
  assert.equal(auditLog.length, before + 1, 'acceptance: setRates must add exactly one audit entry');
  assert.equal(convert(100, 'USD->EUR'), 50, 'acceptance: convert returned a stale amount after setRates');
  assert.equal(convert(100, 'EUR->USD'), 200, 'acceptance: convert returned a stale amount after setRates');
});
`;

/** ratesvc after task 1 (convert memoized): gate = the visible tests, then the hidden acceptance test at <trial>/hidden. */
export function cachedRatesvc(): Files {
  return {
    'package.json': `${JSON.stringify({ name: 'ratesvc', version: '1.5.0', private: true, type: 'module', scripts: { test: 'node --test' } }, null, 2)}\n`,
    'README.md': RATES_README,
    'src/rates.js': CACHED_RATES_JS,
    'src/memo.js': MEMO_JS,
    'src/audit.js': AUDIT_JS,
    'src/batch.js': BATCH_JS,
    'test/rates.test.js': CACHED_RATES_TEST,
    'scripts/log.sh': LOG_SH,
    'scripts/gate.sh': gateSh('The checks a change must pass: the tests, then the acceptance tests.', 'node --test && node --test ../../hidden/*.test.mjs'),
    '.tiller/config.json': config(),
  };
}
