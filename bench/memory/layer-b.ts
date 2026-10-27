// Memory benchmark Layer B (bench plan §3): paired live agents on scripted repos, memory on against off.
//   npm run bench:memory:layer-b -- --list
//   npm run bench:memory:layer-b -- --scenario gate-trap|all --dry-run              B0 and the $0 repo checks
//   npm run bench:memory:layer-b -- --scenario gate-trap --runs 15 [--arms off,on] [--model claude-haiku-5-5] [--effort E]
//       [--parallel 2] [--node-timeout-min 15] [--budget-usd 50] [--root DIR] [--keep] [--yes]
//   npm run bench:memory:layer-b -- --report <results dir>                          re-score a run, no LLM calls
// See bench/memory/README.md.
import { appendFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { execFileSync } from 'node:child_process';
import type { Effort } from '../../src/shared/protocol.js';
import { readClaudeJson, trustPolicy } from '../../src/daemon/worktree-lifecycle.js';
import { benchRoot, CHECKOUT } from './lib/daemon.js';
import { SCENARIOS, type Scenario } from './layer-b/scenarios.js';
import { summarize, summaryMarkdown, type Trial } from './layer-b/score.js';
import { preflight, runTrial, type Arm, type Mode } from './layer-b/trial.js';

/** §5's per-node estimates, before a run measures its own. */
const ESTIMATE = { cheap: [0.05, 0.2], production: [0.5, 1.5] } as const;
const MAX_ATTEMPTS = 3;

const { values: o } = parseArgs({
  options: {
    list: { type: 'boolean' }, scenario: { type: 'string' }, 'dry-run': { type: 'boolean' }, report: { type: 'string' },
    runs: { type: 'string', default: '15' }, arms: { type: 'string', default: 'off,on' }, model: { type: 'string', default: 'claude-haiku-5-5' },
    effort: { type: 'string' }, parallel: { type: 'string', default: '2' }, 'node-timeout-min': { type: 'string', default: '15' },
    'budget-usd': { type: 'string', default: '50' }, root: { type: 'string', default: join(homedir(), '.tiller-bench') },
    keep: { type: 'boolean' }, yes: { type: 'boolean' },
  },
});

const SOURCES = ['layer-b/scenarios.ts', 'layer-b/repos.ts', 'layer-b/score.ts'].map((f) => fileURLToPath(new URL(f, import.meta.url)));
const scenarioHash = `sha256:${createHash('sha256').update(SOURCES.map((f) => readFileSync(f, 'utf8')).join('\0')).digest('hex').slice(0, 16)}`;

function pick(name?: string): Scenario[] {
  if (!name) throw new Error('--scenario NAME|all is required; --list shows them');
  if (name === 'all') return SCENARIOS;
  const s = SCENARIOS.filter((x) => x.name === name || x.id.toLowerCase() === name.toLowerCase());
  if (!s.length) throw new Error(`no scenario ${name}; --list shows them`);
  return s;
}

/** --arms off,on → two arms; a repeated mode (the A/A check, off,off) gets a numbered label. */
function arms(spec: string): Arm[] {
  const modes = spec.split(',').map((m) => m.trim());
  if (modes.length !== 2 || modes.some((m) => !['off', 'on', 'tools'].includes(m))) throw new Error('--arms takes two of off, on, tools, as off,on or off,off');
  return modes.map((m, i) => ({ label: modes.indexOf(m) < i ? `${m}${i + 1}` : m, mode: m as Mode }));
}

/** B0 and the $0 repo checks, printed. */
function dryRun(s: Scenario): boolean {
  const p = preflight(s);
  console.log(`${s.id} ${s.name}: store ${p.items} items; worker digest ${p.digestIds.length} items, ${p.digest.length} chars`);
  for (const c of p.checks) console.log(`  ${c.ok ? 'ok  ' : 'FAIL'} ${c.what}`);
  for (const line of p.digest.split('\n').filter((l) => l.startsWith('#') || l.startsWith('- [m'))) console.log(`    | ${line}`);
  return p.checks.every((c) => c.ok);
}

interface ResultsFile {
  schema: 1; runId: string; tillerSha: string; dirty: boolean; scenario: string; scenarioHash: string; phase1: 'seeded';
  harness: 'claude'; model: string; effort: string | null; arms: string[]; runs: number; trials: Trial[];
  summary?: ReturnType<typeof summarize>;
}

async function run(s: Scenario, root: string): Promise<void> {
  const armList = arms(o.arms!), runs = Number(o.runs), parallel = Math.max(1, Number(o.parallel)), budget = Number(o['budget-usd']);
  const runId = `${new Date().toISOString().replace(/[:.]/g, '-')}-${s.name}${armList[0].mode === armList[1].mode ? '-aa' : ''}`;
  const resultsDir = join(root, 'results', runId), work = join(root, 'runs', runId);
  const nodes = runs * armList.length;
  console.log(`\n${s.id} ${s.name}: ${runs} trials × ${armList.map((a) => a.label).join(' vs ')} = ${nodes} phase-2 nodes on ${o.model}${o.effort ? ` (${o.effort})` : ''}, ${parallel} trials at a time`);
  console.log(`  projected: $${(nodes * ESTIMATE.cheap[0]).toFixed(2)}-${(nodes * ESTIMATE.cheap[1]).toFixed(2)} at the cheap-model estimate; production (claude-opus-5-5) would be about $${(nodes * ESTIMATE.production[0]).toFixed(0)}-${(nodes * ESTIMATE.production[1]).toFixed(0)}`);
  if (!o.yes) {
    console.log('  Nothing started. Rerun with --yes to run.');
    return;
  }
  mkdirSync(resultsDir, { recursive: true, mode: 0o700 });
  const sha = execFileSync('git', ['-C', CHECKOUT, 'rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).trim();
  const dirty = execFileSync('git', ['-C', CHECKOUT, 'status', '--porcelain'], { encoding: 'utf8' }).trim() !== '';
  const file: ResultsFile = {
    schema: 1, runId, tillerSha: sha, dirty, scenario: s.name, scenarioHash, phase1: 'seeded', harness: 'claude', model: o.model!,
    effort: o.effort ?? null, arms: armList.map((a) => a.label), runs, trials: [],
  };
  const save = () => writeFileSync(join(resultsDir, 'results.json'), JSON.stringify(file, null, 2) + '\n', { mode: 0o600 });
  let spent = 0, next = 1;
  const worker = async () => {
    while (next <= runs && spent < budget) {
      const trial = next++;
      for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
        const trialDir = join(work, `t${String(trial).padStart(2, '0')}${attempt > 1 ? `-${attempt}` : ''}`);
        const log = (m: string) => console.log(`  [t${trial}${attempt > 1 ? `#${attempt}` : ''}] ${m}`);
        const t = await runTrial({
          s, root, trialDir, trial, attempt, arms: armList, model: o.model!, ...(o.effort ? { effort: o.effort as Effort } : {}),
          timeoutMs: Number(o['node-timeout-min']) * 60_000, idleMs: 180_000, log,
        });
        file.trials.push(t);
        spent += t.arms.reduce((sum, a) => sum + (a.spentUsd ?? 0), 0);
        save();
        if (!o.keep) rmSync(trialDir, { recursive: true, force: true });
        const reasons = summarize(s, [t]).voidReasons;
        if (!reasons.length) break;
        log(`void (${reasons.join('; ')})${attempt < MAX_ATTEMPTS ? ': rerunning the pair' : ': giving up on this trial'}`);
      }
    }
  };
  await Promise.all(Array.from({ length: parallel }, worker));
  if (!o.keep) rmSync(work, { recursive: true, force: true });
  file.summary = summarize(s, file.trials);
  save();
  const md = summaryMarkdown(s, o.model!, file.summary);
  writeFileSync(join(resultsDir, 'summary.md'), md);
  appendFileSync(join(root, 'results', 'index.jsonl'), JSON.stringify({ runId, scenario: s.name, model: o.model, arms: file.arms, scenarioHash, primary: file.summary.primary, pairs: file.summary.pairs, voids: file.summary.voids, costUsd: file.summary.costUsd }) + '\n');
  console.log(`\n${md}\nwrote ${resultsDir}`);
}

try {
  if (o.list) {
    for (const s of SCENARIOS) console.log(`${s.id.padEnd(4)} ${s.name.padEnd(20)} claim ${s.claim}: ${s.brief}`);
  } else if (o.report) {
    const file = JSON.parse(readFileSync(resolve(o.report, 'results.json'), 'utf8')) as ResultsFile;
    const s = pick(file.scenario)[0];
    if (file.scenarioHash !== scenarioHash) console.log(`note: the scenario sources changed since this run (${file.scenarioHash} → ${scenarioHash})`);
    console.log(summaryMarkdown(s, file.model, summarize(s, file.trials)));
  } else {
    const list = pick(o.scenario);
    if (o['dry-run']) {
      const results = list.map(dryRun);
      if (results.includes(false)) process.exit(1);
    } else {
      const root = benchRoot(o.root!);
      if (trustPolicy(root, readClaudeJson()) !== 'auto') throw new Error(`Claude does not trust ${root}: run \`cd ${root} && claude\` once and accept the trust prompt`);
      for (const s of list) {
        if (!dryRun(s)) throw new Error(`${s.id}'s preflight failed: nothing started`);
        await run(s, root);
      }
    }
  }
} catch (err) {
  console.error(`bench:memory:layer-b: ${(err as Error).message}`);
  process.exit(1);
}
