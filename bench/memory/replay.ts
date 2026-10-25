// Layer R replay (memory-v4 plan §2.2, §2.4): R1 (each labelled archived node's title and brief against the store as
// of its creation) and S (each gate tree's final store padded with other repos' git log notes, for tau and noise), plus
// R2a and R3, then the §2.5 verdict. Sessions and repos are only read; real text stays in temp stores that are
// deleted, and <root>/results gets ids and numbers only.
//
//   npm run bench:memory:replay -- --retrieval [--scale 5000,20000] --root DIR [--home ~/.tiller]
//       [--deps DIR] [--explore minilm,bge,arctic] [--workspace ~/workspace]
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, realpathSync, rmSync, statSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { LIMITS } from '../../src/daemon/memory-schema.js';
import { ArchiveReplay, clusters, gateTrees, hotFiles, isExcludedRepo, labels, replayAsOf, type Tree } from './lib/archive.js';
import { embedders } from './retrieval/embedders.js';
import {
  CANDIDATE, evaluate, fBestOf, FTS_VARIANTS, freeze, makeConfig, printVerdict, r3, R2a, rankers, scoreQueries, StoreView, tauFor, tauOf,
  topCosine, vectorIndex, writeResult, type GateConfig,
} from './retrieval/eval.js';
import { EXPLORATORY, type CandidateKey } from './retrieval/models.js';
import type { Embedder, Noise, QueryScore, RankerName, RetrievalQuery } from './retrieval/types.js';

const REPO = fileURLToPath(new URL('../../', import.meta.url));

// --- Where results may go ---

/** The real path of p, or of its nearest existing ancestor joined with the rest. */
function real(p: string): string {
  const abs = resolve(p);
  if (existsSync(abs)) return realpathSync(abs);
  const up = dirname(abs);
  return up === abs ? abs : join(real(up), basename(abs));
}

/** The checkout this script runs from and its main checkout (a worktree's common git dir), as real paths. */
function checkouts(): string[] {
  const out = [real(REPO)];
  try {
    const common = execFileSync('git', ['-C', REPO, 'rev-parse', '--path-format=absolute', '--git-common-dir'], { encoding: 'utf8' }).trim();
    out.push(real(dirname(common)));
  } catch { /* not a git checkout: the directory alone */ }
  return out;
}

/** Throws when root is inside the repo, ~/.tiller or the --home being read: results must never land there. */
export function checkRoot(root: string, home: string, forbidden = [...checkouts(), real(join(homedir(), '.tiller')), real(home)]): string {
  const r = real(root);
  for (const f of forbidden) if (r === f || r.startsWith(f + sep)) throw new Error(`--root ${root} is inside ${f}; choose a scratch directory outside the repo and ~/.tiller`);
  return r;
}

// --- R1 (§2.2) ---

/** Per labelled node, extra queries (R2b) scored in the same as-of store as its title and brief. */
export type Extra = Pick<RetrievalQuery, 'id' | 'set' | 'text' | 'harness'>;

/**
 * Every node of the tree with at least one label: its title and its brief (title plus prompt), plus any extra queries
 * for it, against the store replayed from what closed before it was created, relevant = its labels' ledger items.
 */
export async function scoreTree(tree: Tree, cfg: GateConfig, es: Embedder[], extra = new Map<string, Extra[]>()): Promise<QueryScore[]> {
  const hot = hotFiles(tree, cfg.hotFileShare);
  const cluster = clusters(tree);
  const out: QueryScore[] = [];
  for (const q of tree.nodes) {
    const lab = labels(tree, q, hot);
    if (!lab.length) continue;
    const replay = replayAsOf(tree, q);
    const view = new StoreView(replay.store.accountFile(undefined), replay.scope.repoKey);
    try {
      const ledger = replay.ledgerIds();
      const relevant = lab.flatMap((id) => (ledger.has(id) ? [ledger.get(id)!] : []));
      if (!relevant.length) continue;
      const base = { tree: tree.rootId, cluster: cluster.get(q.id)!, node: q.id, asOf: q.createdAt, relevant };
      const qs: RetrievalQuery[] = [
        { ...base, id: `${tree.rootId}/${q.id}/r1-title`, set: 'r1-title', text: q.title },
        { ...base, id: `${tree.rootId}/${q.id}/r1-brief`, set: 'r1-brief', text: [q.title, q.prompt].filter(Boolean).join('\n') },
        ...(extra.get(q.id) ?? []).map((x) => ({ ...base, ...x })),
      ];
      out.push(...await scoreQueries(qs, await rankers(view, cfg, es), cfg));
    } finally {
      view.close();
      replay.close();
    }
  }
  return out;
}

// --- S (§2.2) ---

export interface Distractor { at: number; text: string; body: string }

/** Git checkouts (a .git directory, so no worktrees) under dir, not descending into one. */
export function findRepos(dir: string, depth = 4): string[] {
  if (depth < 0 || !existsSync(dir)) return [];
  if (existsSync(join(dir, '.git')) && statSync(join(dir, '.git')).isDirectory()) return [dir];
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  return names.filter((n) => !n.startsWith('.') && n !== 'node_modules').map((n) => join(dir, n))
    .filter((p) => { try { return statSync(p).isDirectory(); } catch { return false; } })
    .flatMap((p) => findRepos(p, depth - 1));
}

const cut = (s: string, max: number) => (s.length > max ? `${s.slice(0, max - 1)}…` : s);

/** Commit subjects and bodies, read-only, of every repo under workspace except excluded ones and the tree's own; oldest first, deduplicated. */
export function distractors(workspace: string, tree: Tree): Distractor[] {
  const own = real(tree.cwd);
  const repos = findRepos(workspace).filter((r) => !isExcludedRepo(real(r)) && real(r) !== own && basename(r) !== tree.repo);
  const all: Distractor[] = [];
  for (const r of repos) {
    let log: string;
    try {
      log = execFileSync('git', ['--no-optional-locks', '-C', r, 'log', '--reverse', '--format=%ct%x1f%s%x1f%b%x1e'], { encoding: 'utf8', maxBuffer: 1 << 28, stdio: ['ignore', 'pipe', 'ignore'] });
    } catch {
      continue;
    }
    for (const rec of log.split('\x1e')) {
      const [ct, subject, body] = rec.replace(/^\n/, '').split('\x1f');
      const text = subject?.trim();
      if (text) all.push({ at: Number(ct), text: cut(text, LIMITS.item.text), body: cut((body ?? '').trim(), LIMITS.item.body) });
    }
  }
  const seen = new Set<string>();
  return all.sort((a, b) => a.at - b.at).filter((d) => {
    const key = `${d.text.toLowerCase()}\0${d.body.toLowerCase()}`;
    return seen.has(key) ? false : (seen.add(key), true);
  });
}

/** A tree's S stores: its final replayed store, then padded to each target size, each a snapshot file under dir. */
export function scaledStores(tree: Tree, padding: Distractor[], targets: number[], dir: string): { file: string; repoKey: string; items: number }[] {
  const replay = new ArchiveReplay(tree).advanceTo();
  try {
    const count = () => {
      const v = new StoreView(replay.store.accountFile(undefined), replay.scope.repoKey);
      try { return v.docs().length; } finally { v.close(); }
    };
    let items = count();
    const out: { file: string; repoKey: string; items: number }[] = [];
    const snap = () => {
      const file = join(dir, `${tree.rootId}-${items}.db`);
      if (!out.some((s) => s.items === items)) {
        replay.snapshot(file);
        out.push({ file, repoKey: replay.scope.repoKey, items });
      }
    };
    snap();
    let next = 0;
    for (const target of [...targets].sort((a, b) => a - b)) {
      for (; items < target && next < padding.length; next++) {
        const d = padding[next];
        try {
          if (!replay.store.add(replay.scope, { kind: 'human' }, { kind: 'note', text: d.text, ...(d.body ? { body: d.body } : {}) }).existing) items++;
        } catch { /* redaction pushed it over a limit: skip it */ }
      }
      snap();
    }
    return out;
  } finally {
    replay.close();
  }
}

// --- The run ---

interface Args { retrieval: boolean; scale?: number[]; root: string; home: string; deps?: string; explore: Exclude<CandidateKey, 'potion'>[]; workspace: string }

function args(argv: string[]): Args {
  // --scale may stand alone for the pre-registered sizes.
  const at = argv.indexOf('--scale');
  if (at >= 0 && (at + 1 === argv.length || argv[at + 1].startsWith('--'))) argv = [...argv.slice(0, at + 1), '5000,20000', ...argv.slice(at + 1)];
  const { values } = parseArgs({
    args: argv,
    options: {
      retrieval: { type: 'boolean', default: false }, scale: { type: 'string' }, root: { type: 'string' }, home: { type: 'string' },
      deps: { type: 'string' }, explore: { type: 'string' }, workspace: { type: 'string' },
    },
  });
  if (!values.root) throw new Error('--root DIR is required: a scratch directory outside the repo and ~/.tiller');
  if (!values.retrieval && !values.scale) throw new Error('nothing to do: pass --retrieval and/or --scale');
  const explore = (values.explore ? values.explore.split(',') : []) as Args['explore'];
  for (const k of explore) if (!EXPLORATORY.includes(k)) throw new Error(`--explore takes ${EXPLORATORY.join(', ')}, not ${k}`);
  if (explore.length && !values.deps) throw new Error('--explore needs --deps');
  const scale = values.scale?.split(',').map(Number);
  if (scale?.some((n) => !Number.isInteger(n) || n <= 0)) throw new Error(`--scale takes item counts, as 5000,20000`);
  return {
    retrieval: values.retrieval, ...(scale ? { scale } : {}), root: resolve(values.root), home: resolve(values.home ?? process.env.TL_HOME ?? join(homedir(), '.tiller')),
    ...(values.deps ? { deps: resolve(values.deps) } : {}), explore, workspace: resolve(values.workspace ?? join(homedir(), 'workspace')),
  };
}

async function main(): Promise<void> {
  const a = args(process.argv.slice(2));
  checkRoot(a.root, a.home);
  const log = (s: string) => console.error(`[replay] ${s}`);
  const trees = gateTrees(a.home);
  log(`trees: ${trees.map((t) => `${t.rootId} (${t.repo}, ${t.nodes.length} nodes)`).join(', ')}`);
  const all = a.deps ? await embedders(a.root, a.deps, a.explore) : [];
  if (!a.deps) log('no --deps: FTS variants only');
  const tmp = mkdtempSync(join(tmpdir(), 'tl-bench-replay-'));
  const r2a = new R2a();
  const r2aView = r2a.view();
  try {
    // §2.4 step 1, from R2a and S only: F-best, then the floors on the largest S stores.
    const fts = makeConfig(NaN, 'F0');
    const fBest = fBestOf(await scoreQueries(r2a.queries, await rankers(r2aView, fts, []), fts));
    const zero = r2a.queries.filter((q) => !q.relevant.length).map((q) => q.text);
    const stores = new Map<string, ReturnType<typeof scaledStores>>();
    const irrelevant = new Map<string, string[]>();
    const taus = new Map<string, number[]>();
    if (a.scale) {
      for (const t of trees) {
        const padding = distractors(a.workspace, t);
        const s = scaledStores(t, padding, a.scale, tmp);
        stores.set(t.rootId, s);
        log(`S ${t.rootId}: ${padding.length} distractors available; stores of ${s.map((x) => x.items).join(', ')} items`);
        irrelevant.set(t.rootId, [...new Set([...trees.filter((o) => o !== t).flatMap((o) => o.nodes.map((n) => n.title)), ...zero])]);
        const largest = s[s.length - 1];
        const view = new StoreView(largest.file, largest.repoKey);
        try {
          for (const e of all) {
            const ix = await vectorIndex(view, e);
            const top = taus.get(e.key) ?? [];
            taus.set(e.key, top);
            for (const text of irrelevant.get(t.rootId)!) top.push(await topCosine(ix, e, text));
          }
        } finally {
          view.close();
        }
      }
    }
    const tauOfKey = (k: string) => (taus.has(k) ? tauOf(taus.get(k)!) : NaN);
    const exploratoryTau = Object.fromEntries(a.explore.flatMap((k) => (taus.has(k) ? [[k, tauOfKey(k)]] : [])));
    const { config, written, differs } = freeze(a.root, makeConfig(tauOfKey('potion'), fBest, Object.keys(exploratoryTau).length ? exploratoryTau : undefined));
    log(written ? 'froze the configuration (§2.4)' : Number.isFinite(config.tau) ? 'using the frozen configuration' : 'no tau: not frozen, FTS only');
    if (differs.length) log(`this run computes different ${differs.join(', ')} than the frozen file; the frozen values stand (re-tuning is a new pre-registration)`);
    const es = all.filter((e) => Number.isFinite(tauFor(config, e.key)));
    const names: RankerName[] = [...FTS_VARIANTS, ...es.flatMap((e) => [`V:${e.key}`, `H:${e.key}`] as RankerName[])];

    // §2.4 step 2, frozen.
    const noise: Noise[] = [];
    for (const [tree, s] of stores) {
      for (const store of s) {
        const view = new StoreView(store.file, store.repoKey);
        try {
          const ranks = await rankers(view, config, es);
          for (const [ranker, rank] of ranks) {
            let returned = 0, vectorOnly = 0;
            const texts = irrelevant.get(tree)!;
            for (const text of texts) {
              const r = await rank(text, config.k);
              returned += r.ids.length;
              vectorOnly += r.vectorOnly ?? 0;
            }
            noise.push({ tree, items: store.items, ranker, meanReturned: returned / texts.length, meanVectorOnly: vectorOnly / texts.length });
          }
        } finally {
          view.close();
        }
      }
    }
    const scores = await scoreQueries(r2a.queries, await rankers(r2aView, config, es), config);
    if (a.retrieval) for (const t of trees) {
      const s = await scoreTree(t, config, es);
      log(`R1 ${t.rootId}: ${new Set(s.map((x) => x.query.split('/')[1])).size} labelled nodes`);
      scores.push(...s);
    }
    const regression = await r3((v) => rankers(v, config, es), config.k);
    const result = evaluate({ config, scores, noise, r3: regression, rankers: names, exploratory: es.map((e) => e.key).filter((k) => `H:${k}` !== CANDIDATE) });
    log(`wrote ${writeResult(a.root, 'replay', result)}`);
    console.log(printVerdict(result));
  } finally {
    r2aView.close();
    r2a.close();
    rmSync(tmp, { recursive: true, force: true });
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
