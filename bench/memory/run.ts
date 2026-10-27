// The memory bench's CLI (memory-v4 plan §2.7). Only the retrieval subcommand exists:
//   npm run bench:memory -- retrieval --golden [--deps DIR] [--root DIR]                  G1's tokenizer golden ($0)
//   npm run bench:memory -- retrieval --eval [--sets r1,r2a,r2b,s] [--explore minilm,bge,arctic] [--deps DIR] [--root DIR]
//   npm run bench:memory -- retrieval --collect [--harness auto|claude,codex] [--model claude=ID,codex=ID] [--effort E]
//       [--budget-usd 18] [--limit N] [--parallel 2] [--node-timeout-min 10] [--root DIR] [--keep] [--yes]
// --collect is R2b (§2.2): each sampled archived node's real prompt goes, after a fixed elicitation, to fresh agent nodes
// in a scratch daemon whose store is the as-of replay, and their memory_search queries are saved under <root>/results.
// See bench/memory/README.md.
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { HARNESSES, type ArchivedNode, type Effort, type Harness } from '../../src/shared/protocol.js';
import { MemoryStore } from '../../src/daemon/memory-store.js';
import { recordedSessions } from '../../src/daemon/transcript.js';
import { readClaudeJson, trustPolicy } from '../../src/daemon/worktree-lifecycle.js';
import { clusters, gateTrees, hotFiles, labels, replayAsOf, type Tree } from './lib/archive.js';
import { Client } from './lib/client.js';
import { benchRoot, prepareHome, startDaemon } from './lib/daemon.js';
import { makeRepo } from './lib/repo.js';
import { R2B_VERSION, r2bQueries, transcriptQueries, type R2bFile, type R2bRun } from './lib/queries.js';
import { rng } from './lib/stats.js';
import { gate, GATE_SETS, type GateOptions, type GateSet } from './replay.js';
import { golden } from './retrieval/eval.js';
import { EXPLORATORY } from './retrieval/models.js';
import type { RetrievalQuery } from './retrieval/types.js';

const SEED = 4104;
const PER_TREE = 25;
const PROMPT_CHARS = 2000;
/** Projected spend per node (§2.2: about $6-18 for about 100 haiku-class nodes), used for the plan and for nodes that report none. */
const PROJECTED_USD = 0.18;
const MODELS: Partial<Record<Harness, string>> = { claude: 'claude-haiku-5-5', codex: 'gpt-6-luna' };
const ELICIT = 'You are about to work on the task below in another checkout. Do not read or edit files. Call memory_search for '
  + 'what you would look up first (you may search more than once), then report_outcome with what you found.';

const usage = () => {
  console.error('usage: bench:memory -- retrieval (--collect | --eval | --golden) [options]; see bench/memory/README.md');
  process.exit(2);
};

const { values: o, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    collect: { type: 'boolean' }, eval: { type: 'boolean' }, golden: { type: 'boolean' },
    root: { type: 'string', default: join(homedir(), '.tiller-bench') },
    home: { type: 'string', default: join(homedir(), '.tiller') },
    harness: { type: 'string', default: 'auto' }, model: { type: 'string' }, effort: { type: 'string' },
    'budget-usd': { type: 'string', default: '18' }, limit: { type: 'string' }, parallel: { type: 'string', default: '2' },
    'node-timeout-min': { type: 'string', default: '10' }, keep: { type: 'boolean' }, yes: { type: 'boolean' },
    sets: { type: 'string' }, explore: { type: 'string' }, deps: { type: 'string' },
  },
});
if (positionals[0] !== 'retrieval' || [o.collect, o.eval, o.golden].filter(Boolean).length !== 1) usage();

// --- --eval and --golden: G1's evaluator ---

/** --golden: G1's tokenizer golden. --eval: replay.ts's gate over the asked sets, R2b from the newest collection file. */
async function evaluate(): Promise<void> {
  const deps = o.deps && resolve(o.deps);
  if (o.golden) {
    console.log(`wrote ${await golden({ root, ...(deps ? { deps } : {}) })}`);
    return;
  }
  const list = (s?: string) => s?.split(',').map((x) => x.trim()).filter(Boolean);
  const sets = (list(o.sets) ?? GATE_SETS) as GateSet[];
  for (const s of sets) if (!GATE_SETS.includes(s)) throw new Error(`--sets takes ${GATE_SETS.join(', ')}, not ${s}`);
  const explore = (list(o.explore) ?? []) as NonNullable<GateOptions['explore']>;
  for (const k of explore) if (!EXPLORATORY.includes(k)) throw new Error(`--explore takes ${EXPLORATORY.join(', ')}, not ${k}`);
  let r2b: RetrievalQuery[] = [];
  const file = readdirSync(results).filter((f) => /^r2b-queries-.*\.json$/.test(f)).sort((a, b) => statSync(join(results, a)).mtimeMs - statSync(join(results, b)).mtimeMs).at(-1);
  if (sets.includes('r2b') && file) {
    r2b = r2bQueries(JSON.parse(readFileSync(join(results, file), 'utf8')) as R2bFile);
    console.error(`[eval] R2b: ${r2b.length} queries from ${file}`);
  }
  await gate({ root, home: resolve(o.home!), sets, explore, r2b, name: 'retrieval', ...(deps ? { deps } : {}), log: (s) => console.error(`[eval] ${s}`) });
}

// --- --collect: R2b ---

interface Job { tree: Tree; node: ArchivedNode; cluster: string; harness: Harness }

/** Up to n of xs, a seeded Fisher-Yates prefix. */
function sample<T>(xs: T[], n: number, seed: number): T[] {
  const a = [...xs], next = rng(seed);
  for (let i = 0; i < Math.min(n, a.length); i++) {
    const j = i + Math.floor(next() * (a.length - i));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a.slice(0, n);
}

/** Harnesses a tree already used (§2.2: a brief only reaches a provider it already reached). Pi needs the human's say. */
const treeHarnesses = (tree: Tree): Harness[] => HARNESSES.filter((h) => h !== 'pi' && tree.nodes.some((a) => (a.harness ?? 'claude') === h));

function plan(): Job[] {
  const want = o.harness === 'auto' ? undefined : o.harness!.split(',').map((h) => h.trim());
  for (const h of want ?? []) if (!(HARNESSES as readonly string[]).includes(h) || h === 'pi') throw new Error(`--harness ${h}: one of claude, codex (Pi needs the human's say, §8 Q2)`);
  const jobs: Job[] = [];
  for (const tree of gateTrees(o.home)) {
    const hot = hotFiles(tree), cl = clusters(tree);
    const labelled = tree.nodes.filter((a) => a.prompt?.trim() && labels(tree, a, hot).length);
    const picked = sample(labelled, PER_TREE, SEED);
    const harnesses = treeHarnesses(tree).filter((h) => !want || want.includes(h));
    console.log(`${tree.rootId} (${tree.repo}): ${labelled.length} labelled nodes, ${picked.length} sampled, harnesses ${harnesses.join(', ') || 'none'}`);
    for (const node of picked) for (const harness of harnesses) jobs.push({ tree, node, cluster: cl.get(node.id)!, harness });
  }
  if (!o.limit) return jobs;
  // --limit N: the first N sampled nodes (by tree, then sample order), each on all of its harnesses.
  const keep = new Set([...new Set(jobs.map((j) => j.node.id))].slice(0, Number(o.limit)));
  return jobs.filter((j) => keep.has(j.node.id));
}

function resultsFile(): string {
  const date = new Date().toISOString().slice(0, 10);
  for (let n = 1; ; n++) {
    const path = join(results, `r2b-queries-${date}${n > 1 ? `-${n}` : ''}.json`);
    if (!existsSync(path)) return path;
  }
}

/** Rewritten after every run, so an interrupted collection keeps what it paid for. */
function save(path: string, file: R2bFile): void {
  writeFileSync(`${path}.tmp`, JSON.stringify(file, null, 2) + '\n', { mode: 0o600 });
  renameSync(`${path}.tmp`, path);
}

async function collect(): Promise<void> {
  const models: Partial<Record<Harness, string>> = { ...MODELS };
  for (const kv of o.model?.split(',') ?? []) {
    const [h, m] = kv.split('=');
    if (!m || !(h in MODELS)) throw new Error(`--model ${kv}: expected claude=ID or codex=ID`);
    models[h as Harness] = m;
  }
  const budget = Number(o['budget-usd']), parallel = Math.max(1, Number(o.parallel)), timeoutMs = Number(o['node-timeout-min']) * 60_000;
  const jobs = plan();
  const out = resultsFile();
  const byHarness = new Map<Harness, number>();
  for (const j of jobs) byHarness.set(j.harness, (byHarness.get(j.harness) ?? 0) + 1);
  console.log(`\nR2b plan: ${jobs.length} nodes (${[...byHarness].map(([h, n]) => `${h} ${n} on ${models[h]}`).join(', ')})`);
  console.log(`projected cost about $${(jobs.length * PROJECTED_USD).toFixed(2)}; stops starting nodes at $${budget}; ${parallel} at a time`);
  console.log(`queries go to ${out}`);
  if (jobs.some((j) => j.harness === 'claude') && trustPolicy(root, readClaudeJson()) !== 'auto') {
    throw new Error(`Claude does not trust ${root}: run \`cd ${root} && claude\` once and accept the trust prompt`);
  }
  if (!o.yes) {
    console.log('\nNothing started. Rerun with --yes to collect.');
    return;
  }

  const work = join(root, 'work', new Date().toISOString().replace(/[:.]/g, '-'));
  mkdirSync(work, { recursive: true, mode: 0o700 });
  const file: R2bFile = { version: R2B_VERSION, generatedAt: new Date().toISOString(), seed: SEED, perTree: PER_TREE, runs: [] };
  let spent = 0, next = 0;
  const worker = async () => {
    while (next < jobs.length && spent < budget) {
      const job = jobs[next++];
      const run = await runOne(job, work, models[job.harness], timeoutMs);
      spent += run.spentUsd ?? PROJECTED_USD;
      file.runs.push(run);
      save(out, file);
      console.log(`${job.tree.repo} ${job.node.id} ${job.harness}: ${run.status}${run.detail ? ` (${run.detail})` : ''}, ${run.queries.length} queries, $${run.spentUsd?.toFixed(3) ?? '?'}`);
    }
  };
  await Promise.all(Array.from({ length: parallel }, worker));
  if (!o.keep) rmSync(work, { recursive: true, force: true });
  save(out, file);
  const left = jobs.length - file.runs.length;
  console.log(`\n${file.runs.length} runs, about $${spent.toFixed(2)}${left ? `; ${left} not started (budget)` : ''}; wrote ${out}`);
  for (const h of byHarness.keys()) {
    const runs = file.runs.filter((r) => r.harness === h);
    const by = (s: R2bRun['status']) => runs.filter((r) => r.status === s).length;
    console.log(`${h}: ok ${by('ok')}, no-query ${by('no-query')}, blocked ${by('blocked')}, timeout ${by('timeout')}, error ${by('error')}`);
  }
}

/** One sampled node on one harness, in its own scratch daemon whose store is the node's as-of replay. */
async function runOne(job: Job, work: string, model: string | undefined, timeoutMs: number): Promise<R2bRun> {
  const { tree, node, harness } = job;
  const run: R2bRun = { tree: tree.rootId, node: node.id, cluster: job.cluster, harness, ...(model ? { model } : {}), asOf: node.createdAt, relevant: [], status: 'error', queries: [] };
  const home = mkdtempSync(join(tmpdir(), 'tl-bench-'));
  const repo = join(work, `${node.id}-${harness}`);
  let daemon: Awaited<ReturnType<typeof startDaemon>> | undefined, client: Client | undefined;
  try {
    // The store: the as-of replay, snapshotted into the scratch home and keyed to the scratch repo's fake origin.
    const key = makeRepo(repo, `${tree.repo}-${node.id}-${harness}`);
    const replay = replayAsOf(tree, node);
    const dbFile = new MemoryStore(home).accountFile(undefined);
    try {
      const ids = replay.ledgerIds();
      run.relevant = labels(tree, node).flatMap((id) => ids.get(id) ?? []);
      mkdirSync(dirname(dbFile), { recursive: true, mode: 0o700 });
      if (ids.size) replay.snapshot(dbFile);
    } finally {
      replay.close();
    }
    if (existsSync(dbFile)) {
      const db = new DatabaseSync(dbFile);
      try { db.prepare('UPDATE repos SET key = ?, path = ? WHERE key = ?').run(key, repo, replay.scope.repoKey); } finally { db.close(); }
    }
    prepareHome(home, root, { memory: { enabled: true, digest: 'off' } });

    daemon = await startDaemon(home);
    client = await Client.connect(daemon);
    const parent = await client.spawn({ kind: 'terminal', title: 'bench', cwd: repo });
    const prompt = `${ELICIT}\n\n--- TASK ---\n${node.prompt!.slice(0, PROMPT_CHARS)}`;
    const agent = await client.spawn({
      ...(harness === 'claude' ? { kind: 'claude', preset: 'bench' } : { kind: 'agent', harness }),
      title: `r2b-${node.id}`, cwd: repo, prompt, parentId: parent.id, isolation: 'none',
      ...(model ? { model } : {}), ...(o.effort ? { effort: o.effort as Effort } : {}),
    });
    const ended = await finish(client, agent.id, timeoutMs);
    const view = client.nodes.get(agent.id) ?? agent;
    run.spentUsd = view.spentUsd;
    for (const s of recordedSessions(view)) if (existsSync(s.transcriptPath)) run.queries.push(...transcriptQueries(s.transcriptPath, s.harness));
    run.status = run.queries.length ? 'ok' : ended?.status ?? 'no-query';
    if (ended) run.detail = ended.detail;
    client.send({ t: 'close', id: agent.id });
    client.send({ t: 'close', id: parent.id, force: true });
    await client.waitFor(() => !client!.nodes.has(agent.id) && !client!.nodes.has(parent.id), 15_000);
  } catch (err) {
    run.status = run.queries.length ? 'ok' : 'error';
    run.detail = (err as Error).message;
  } finally {
    client?.close();
    await daemon?.stop();
    if (!o.keep) {
      rmSync(home, { recursive: true, force: true });
      rmSync(repo, { recursive: true, force: true });
    } else {
      console.log(`kept ${home} and ${repo}`);
    }
  }
  return run;
}

/** Why the node ended early, if it did, as an R2b status: blocked (it cannot run unattended), exited, or timeout. */
async function finish(client: Client, id: string, timeoutMs: number): Promise<{ status: R2bRun['status']; detail: string } | undefined> {
  const { end, detail = '' } = await client.awaitOutcome(id, timeoutMs);
  if (end === 'reported') return undefined;
  if (end === 'vanished') return { status: 'error', detail: 'node vanished' };
  if (end === 'exited') return { status: 'error', detail: `exited: ${detail}` };
  return { status: end === 'blocked' ? 'blocked' : 'timeout', detail };
}

let root = '', results = '';
try {
  root = benchRoot(o.root!, [o.home!]);
  results = join(root, 'results');
  mkdirSync(results, { recursive: true, mode: 0o700 });
  if (o.collect) await collect();
  else await evaluate();
} catch (err) {
  console.error(`bench:memory: ${(err as Error).message}`);
  process.exit(1);
}
