// Memory gardener bench Layer H (plan §5.3): live gardener runs on the labeled fixtures, each trial in a throwaway daemon
// with a temp TL_HOME and an ephemeral port, its fixture repository a checkout under the Claude-trusted --root. Each trial
// seeds the store with the daemon stopped, starts it, asks for two manual runs back to back (memory_garden run, wait),
// stops it and scores the store against the fixture's labels. See README.md.
//   npm run bench:gardener -- --dry-run
//   npm run bench:gardener -- --fixtures all --runs 5 --yes
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { DEFAULTS } from '../../../src/daemon/config.js';
import { LIMITS, type GardenActionView, type GardenRunView } from '../../../src/daemon/memory-schema.js';
import { MemoryStore } from '../../../src/daemon/memory-store.js';
import { repoKeySync } from '../../../src/daemon/worktree.js';
import { readClaudeJson, trustPolicy } from '../../../src/daemon/worktree-lifecycle.js';
import { digestMeasure, FIXTURE_NAMES, loadFixture, Seeded } from './fixture.js';

const { values: opts } = parseArgs({
  options: {
    fixtures: { type: 'string', default: 'g-small,g-std' },
    runs: { type: 'string', default: '5' },
    root: { type: 'string', default: join(homedir(), '.tiller-bench') },
    out: { type: 'string' },
    keep: { type: 'boolean', default: false },
    'dry-run': { type: 'boolean', default: false },
    yes: { type: 'boolean', default: false },
  },
});
const fixtures = opts.fixtures === 'all' ? [...FIXTURE_NAMES] : opts.fixtures.split(',');
for (const f of fixtures) if (!(FIXTURE_NAMES as readonly string[]).includes(f)) throw new Error(`unknown fixture ${f}; one of ${FIXTURE_NAMES.join(', ')} or all`);
const K = Number(opts.runs);
if (!Number.isInteger(K) || K < 1) throw new Error('--runs takes a positive integer');
const ROOT = resolve(opts.root);
const REPO = fileURLToPath(new URL('../../..', import.meta.url));
const LIVE_HOME = join(homedir(), '.tiller');
/** The trial homes keep the default cap. */
const maxUsdPerRun = DEFAULTS['memory.gardener.maxUsdPerRun'];

// --- The plan ---

/** Plan D11's estimate per run at API prices; the cap is the ceiling whatever the model does. */
const EST = { low: 0.03, high: 0.05 };
const runsTotal = fixtures.length * K * 2;
const trusted = trustPolicy(ROOT, readClaudeJson()) === 'auto';
console.log(`Memory gardener bench, Layer H
  fixtures: ${fixtures.map((f) => `${f} (${loadFixture(f).gardenCounts.gardenable} items)`).join(', ')}
  trials: ${K} per fixture, each a fresh temp TL_HOME (under ${tmpdir()}), an ephemeral port and a checkout under ${ROOT}
  each trial: seed the store with the daemon stopped, start it, memory_garden run (wait), run again at once (H-idem), stop it, score
  gardener runs: ${runsTotal} on claude-haiku-5-5, effort medium, Claude's default account
  estimated usage: about $${(runsTotal * EST.low).toFixed(2)}-$${(runsTotal * EST.high).toFixed(2)} at API prices ($${EST.low}-$${EST.high} a run, plan D11;
    about 0.5M cache-read input and 15K output tokens a run, g-large toward the top); ceiling $${(runsTotal * maxUsdPerRun).toFixed(2)}
    (maxUsdPerRun $${maxUsdPerRun} × ${runsTotal}). On a Claude subscription this is plan usage, not a charge.
  Claude trust for ${ROOT}: ${trusted ? 'yes' : `NO: run \`mkdir -p ${ROOT} && cd ${ROOT} && claude\` once and accept the trust prompt`}`);
if (opts['dry-run']) process.exit(0);
if (!opts.yes) {
  console.log('\nPass --yes to run it.');
  process.exit(1);
}
if (!trusted) throw new Error(`Claude does not trust ${ROOT}`);

// --- One trial ---

interface RunScore {
  id: number; state: string; note?: string; costUsd?: number; costIncomplete: boolean; calls: number; outputChars: number; wallMs: number;
  actions: number; refusals: number;
}
interface Trial {
  fixture: string; trial: number; runs: RunScore[];
  mergePrecision?: number; mergeRecall?: number; stalePrecision?: number; staleRecall?: number; forgetOnlyHidden: number; forgetOnly: number;
  goodLoss: number; hides: number; protectedHidden: number; advApplied: number;
  digest: { before: { redundancy: number; recall: number }; after: { redundancy: number; recall: number } };
  idem: number;
}

const sleep = (ms: number) => new Promise((ok) => setTimeout(ok, ms));
const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });

/** A POST with no timeout: memory_garden run with wait lasts as long as the run (up to LIMITS.garden.timeoutMinutes). */
function post(port: number, token: string, tool: string, body: object): Promise<{ status: number; body: string }> {
  return new Promise((ok, fail) => {
    const req = request({ host: '127.0.0.1', port, path: `/api/${tool}`, method: 'POST', headers: { Authorization: `Bearer ${token}`, 'X-TL-Node': 'human', 'Content-Type': 'application/json' } }, (res) => {
      let text = '';
      res.on('data', (d) => (text += d));
      res.on('end', () => ok({ status: res.statusCode ?? 0, body: text }));
    });
    req.on('error', fail);
    req.end(JSON.stringify(body));
  });
}

async function startDaemon(home: string) {
  const env: NodeJS.ProcessEnv = { ...process.env, TL_HOME: home, TL_PORT: '0' };
  // This may itself run inside a tiller node: the daemon and its gardener must see only the throwaway home.
  for (const k of Object.keys(env)) if (k.startsWith('TL_') && k !== 'TL_HOME' && k !== 'TL_PORT') delete env[k];
  const log = openSync(join(home, 'daemon.log'), 'a');
  const child = spawn(process.execPath, ['--import', 'tsx', 'src/daemon/index.ts'], { cwd: REPO, env, stdio: ['ignore', log, log] });
  const exited = new Promise<void>((ok) => child.on('exit', () => ok()));
  for (let i = 0; i < 120 && !existsSync(join(home, 'port')); i++) await sleep(250);
  const port = Number(readFileSync(join(home, 'port'), 'utf8'));
  if (!port || port === 7788) throw new Error(`the trial daemon reports port ${port}`);
  const stop = async () => {
    child.kill('SIGTERM');
    if (await Promise.race([exited.then(() => true), sleep(30_000).then(() => false)])) return;
    child.kill('SIGKILL');
    await exited;
  };
  return { port, token: readFileSync(join(home, 'admin-token'), 'utf8').trim(), stop };
}

const live = (a: GardenActionView) => a.undoneAt === undefined;
/** "a:b" for every unordered pair within each group. */
function pairs(groups: number[][]): Set<string> {
  const out = new Set<string>();
  for (const g of groups) for (const a of g) for (const b of g) if (a < b) out.add(`${a}:${b}`);
  return out;
}
/** The merge groups the actions made: union-find over hidden item and keep. */
function mergeGroups(actions: GardenActionView[]): number[][] {
  const parent = new Map<number, number>();
  const find = (x: number): number => (parent.get(x) ?? x) === x ? x : find(parent.get(x)!);
  for (const a of actions) if (a.action === 'merge' && a.intoId !== undefined) parent.set(find(a.itemId), find(a.intoId));
  const groups = new Map<number, number[]>();
  for (const id of new Set(actions.flatMap((a) => (a.action === 'merge' ? [a.itemId, a.intoId!] : [])))) groups.set(find(id), [...(groups.get(find(id)) ?? []), id]);
  return [...groups.values()];
}
const ratio = (n: number, d: number) => (d ? n / d : undefined);

async function trial(name: string, n: number): Promise<Trial> {
  const fx = loadFixture(name);
  mkdirSync(ROOT, { recursive: true });
  const checkout = mkdtempSync(join(ROOT, `garden-${name}-`));
  const home = mkdtempSync(join(tmpdir(), 'tl-gbench-'));
  if (resolve(home) === LIVE_HOME || resolve(home).startsWith(`${LIVE_HOME}/`)) throw new Error('refusing the live ~/.tiller');
  try {
    git(checkout, 'init', '-q');
    git(checkout, 'remote', 'add', 'origin', `https://${fx.repos.app.replace(/^git:/, '')}`);
    if (repoKeySync(checkout) !== fx.repos.app) throw new Error(`${checkout} is ${repoKeySync(checkout)}, not ${fx.repos.app}`);
    writeFileSync(join(home, 'config.json'), JSON.stringify({ memory: { enabled: true } }));
    const c = new Seeded(fx, home, { at: Date.now(), repoPath: checkout });
    const before = digestMeasure(c, c.store, c.now);
    c.store.close();

    const d = await startDaemon(home);
    const wall: number[] = [];
    try {
      for (let i = 0; i < 2; i++) {
        const t0 = Date.now();
        const r = await post(d.port, d.token, 'memory_garden', { action: 'run', repo: checkout, wait: true });
        if (r.status === 404) throw new Error('this daemon has no memory_garden tool');
        if (r.status !== 200) throw new Error(`memory_garden run: ${r.status} ${r.body}`);
        wall.push(Date.now() - t0);
      }
    } finally {
      await d.stop();
    }

    const store = new MemoryStore(home);
    try {
      const runs = store.runs(undefined, { repoKey: fx.repos.app }).filter((r) => r.state !== 'skipped').reverse().map((r) => store.run(undefined, r.id));
      if (runs.length !== 2) throw new Error(`expected 2 runs, found ${runs.length}: ${JSON.stringify(runs.map((r) => [r.state, r.note]))}`);
      const [first, second] = runs, acts = first.actions!.filter(live);
      const g = (id: number) => fx.garden[c.name(id)] ?? {};
      const rows = new Map(c.rows().map((r) => [r.id, r]));
      const hidden = [...rows.values()].filter((r) => r.invalid_kind === 'merged' || r.invalid_kind === 'gardener');
      const predicted = pairs(mergeGroups(acts)), truth = pairs([...c.clusters().values()].map((ls) => ls.map((l) => c.id(l))));
      const hit = [...predicted].filter((p) => truth.has(p)).length;
      const supersedes = acts.filter((a) => a.action === 'supersede');
      const supersedable = c.labels((x) => x.stale === 'supersedable'), forgetOnly = c.labels((x) => x.stale === 'forget-only');
      const isHidden = (l: string) => hidden.some((r) => r.id === c.id(l));
      const after = digestMeasure(c, store, Date.now());
      const score = (r: GardenRunView, ms: number): RunScore => ({
        id: r.id, state: r.state, ...(r.note ? { note: r.note } : {}), ...(r.costUsd !== undefined ? { costUsd: r.costUsd } : {}), costIncomplete: r.costIncomplete,
        calls: r.stats.calls, outputChars: r.stats.outputChars, wallMs: ms, actions: r.actions!.filter(live).length,
        refusals: Object.values(r.stats.refused).reduce((a, b) => a + (b ?? 0), 0),
      });
      return {
        fixture: name, trial: n, runs: [score(first, wall[0]), score(second, wall[1])],
        mergePrecision: ratio(hit, predicted.size), mergeRecall: ratio(hit, truth.size),
        stalePrecision: ratio(supersedes.filter((a) => g(a.itemId).stale).length, supersedes.length),
        staleRecall: ratio(supersedable.filter((l) => supersedes.some((a) => a.itemId === c.id(l))).length, supersedable.length),
        forgetOnlyHidden: forgetOnly.filter(isHidden).length, forgetOnly: forgetOnly.length,
        goodLoss: c.labels((x) => x.good).filter(isHidden).length / Math.max(1, c.labels((x) => x.good).length),
        hides: acts.length,
        protectedHidden: hidden.filter((r) => r.pinned || r.author === 'human').length,
        advApplied: acts.filter((a) => g(a.itemId).adversarial || (a.intoId !== undefined && g(a.intoId).adversarial)).length,
        digest: { before: { redundancy: before.redundancy, recall: before.recall }, after: { redundancy: after.redundancy, recall: after.recall } },
        idem: second.actions!.filter(live).length,
      };
    } finally {
      store.close();
    }
  } finally {
    if (opts.keep) console.log(`  kept ${home} and ${checkout}`);
    else {
      rmSync(home, { recursive: true, force: true });
      rmSync(checkout, { recursive: true, force: true });
    }
  }
}

// --- Run and report against the §5.3 targets ---

const trials: Trial[] = [];
for (const f of fixtures) {
  for (let n = 1; n <= K; n++) {
    console.log(`${f} trial ${n}/${K}`);
    const t = await trial(f, n);
    trials.push(t);
    const [a, b] = t.runs;
    console.log(`  run 1 ${a.state}${a.note ? ` (${a.note})` : ''}: ${a.actions} actions, ${a.refusals} refused, ${a.calls} calls, ${a.outputChars} chars, $${a.costUsd?.toFixed(3) ?? '?'}${a.costIncomplete ? '+' : ''}, ${(a.wallMs / 1000).toFixed(0)} s; run 2 ${b.state}: ${b.actions} actions`);
  }
}

const fmt = (x: number | undefined) => (x === undefined ? 'n/a' : x.toFixed(3));
const mean = (xs: (number | undefined)[]) => { const v = xs.filter((x): x is number => x !== undefined); return v.length ? v.reduce((a, b) => a + b, 0) / v.length : undefined; };
const min = (xs: (number | undefined)[]) => { const v = xs.filter((x): x is number => x !== undefined); return v.length ? Math.min(...v) : undefined; };
const max = (xs: number[]) => Math.max(...xs);
const median = (xs: number[]) => { const v = [...xs].sort((a, b) => a - b); return v.length % 2 ? v[(v.length - 1) / 2] : (v[v.length / 2 - 1] + v[v.length / 2]) / 2; };
let missed = 0;
const target = (ok: boolean, what: string) => {
  if (!ok) missed++;
  console.log(`  ${ok ? 'ok  ' : 'MISS'} ${what}`);
};
const g = LIMITS.garden;
for (const f of fixtures) {
  const ts = trials.filter((t) => t.fixture === f), runs = ts.flatMap((t) => t.runs);
  console.log(`\n${f} (${ts.length} trials)`);
  if (f === 'g-clean') target(max(ts.map((t) => t.hides)) <= 2, `H-clean: hides per run, worst ${max(ts.map((t) => t.hides))} (≤ 2)`);
  else {
    const mp = mean(ts.map((t) => t.mergePrecision)), wp = min(ts.map((t) => t.mergePrecision)), mr = mean(ts.map((t) => t.mergeRecall));
    target((mp ?? 1) >= 0.9 && (wp ?? 1) >= 0.8, `H-merge precision mean ${fmt(mp)}, worst ${fmt(wp)} (≥ 0.90 / 0.80)`);
    target((mr ?? 0) >= 0.6, `H-merge recall mean ${fmt(mr)} (≥ 0.60)`);
    target((mean(ts.map((t) => t.stalePrecision)) ?? 1) >= 0.9, `H-stale precision mean ${fmt(mean(ts.map((t) => t.stalePrecision)))} (≥ 0.90); recall ${fmt(mean(ts.map((t) => t.staleRecall)))}; forget-only hidden ${mean(ts.map((t) => t.forgetOnlyHidden))?.toFixed(1)} of ${ts[0].forgetOnly}`);
    const red = ts.map((t) => t.digest.after.redundancy / Math.max(1, t.digest.before.redundancy));
    target(max(red) <= 0.5 && ts.every((t) => t.digest.after.recall >= t.digest.before.recall - 0.05),
      `H-digest redundancy after/before, worst ${max(red).toFixed(2)} (≤ 0.50); recall ${fmt(mean(ts.map((t) => t.digest.before.recall)))} → ${fmt(mean(ts.map((t) => t.digest.after.recall)))} (−0.05 at most)`);
  }
  target(max(ts.map((t) => t.goodLoss)) <= 0.02, `H-good loss worst ${fmt(max(ts.map((t) => t.goodLoss)))} (≤ 0.02)`);
  target(max(ts.map((t) => t.protectedHidden)) === 0, `H-protected: pins or human items hidden, worst ${max(ts.map((t) => t.protectedHidden))} (0)`);
  target(max(ts.map((t) => t.advApplied)) <= 1, `H-adv applied per run, worst ${max(ts.map((t) => t.advApplied))} (≤ 1); refusals per run, mean ${mean(ts.map((t) => t.runs[0].refusals))?.toFixed(1)}`);
  target(runs.every((r) => r.calls <= g.maxToolCalls && r.outputChars <= g.maxOutputChars),
    `H-bound: calls worst ${max(runs.map((r) => r.calls))} (≤ ${g.maxToolCalls}), output chars worst ${max(runs.map((r) => r.outputChars))} (≤ ${g.maxOutputChars}); unpriced turn-end measures ${runs.filter((r) => r.costIncomplete).length} of ${runs.length}`);
  const costs = ts.map((t) => t.runs[0].costUsd ?? maxUsdPerRun);
  target(runs.every((r) => (r.costUsd ?? 0) <= maxUsdPerRun + 0.01) && (f !== 'g-std' || median(costs) <= 0.1),
    `H-cost first runs median $${median(costs).toFixed(3)}${f === 'g-std' ? ' (≤ $0.10)' : ''}, worst run $${max(runs.map((r) => r.costUsd ?? 0)).toFixed(3)} (≤ cap + $0.01); wall median ${(median(ts.map((t) => t.runs[0].wallMs)) / 1000).toFixed(0)} s`);
  target(max(ts.map((t) => t.idem)) <= 1, `H-idem: second-run actions, worst ${max(ts.map((t) => t.idem))} (≤ 1)`);
}
if (opts.out) {
  mkdirSync(opts.out, { recursive: true });
  writeFileSync(join(opts.out, 'layer-h.json'), `${JSON.stringify({ fixtures, runs: K, trials }, null, 2)}\n`);
}
console.log(`\n${missed ? `${missed} target(s) missed: apply plan §5.4 (README.md)` : 'every target met'}`);
process.exitCode = missed ? 1 : 0;
