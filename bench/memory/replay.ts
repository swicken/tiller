// Layer R replay (memory-v4 plan §2.2, §2.4): R1 (each labelled archived node's title and brief against the store as
// of its creation) and S (each gate tree's final store padded with other repos' git log notes, for tau and noise), plus
// R2a and R3, then the §2.5 verdict. Sessions and repos are only read; real text stays in temp stores that are
// deleted, and <root>/results gets ids and numbers only.
//
//   npm run bench:memory:replay -- --retrieval [--scale 5000,20000] --root DIR [--home ~/.tiller]
//       [--deps DIR] [--explore minilm,bge,arctic] [--workspace ~/workspace]
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { LIMITS } from '../../src/daemon/memory-schema.js';
import { benchRoot, realPath } from './lib/daemon.js';
import { ArchiveReplay, clusters, gateTrees, hotFiles, isExcludedRepo, labels, replayAsOf, type Tree } from './lib/archive.js';
import { embedders } from './retrieval/embedders.js';
import {
  CANDIDATE, evaluate, fBestOf, FTS_VARIANTS, freeze, makeConfig, printVerdict, r3, R2a, rankers, scoreQueries, StoreView, tauFor, tauOf,
  topCosine, vectorIndex, writeResult, type GateConfig,
} from './retrieval/eval.js';
import { EXPLORATORY, type CandidateKey } from './retrieval/models.js';
import type { Embedder, Noise, QueryScore, RankerName, RetrievalQuery, RetrievalResult } from './retrieval/types.js';

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

/**
 * Commit subjects and bodies, read-only, of every repo under workspace except excluded ones and the given trees' own
 * (by path or name); oldest first, deduplicated.
 */
export function distractors(workspace: string, exclude: Pick<Tree, 'cwd' | 'repo'>[]): Distractor[] {
  const paths = new Set(exclude.map((t) => realPath(t.cwd))), names = new Set(exclude.map((t) => t.repo));
  const repos = findRepos(workspace).filter((r) => !isExcludedRepo(realPath(r)) && !paths.has(realPath(r)) && !names.has(basename(r)));
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

// --- The gate run (replay.ts and run.ts retrieval --eval) ---

export type GateSet = 'r1' | 'r2a' | 'r2b' | 's';
export const GATE_SETS: GateSet[] = ['r1', 'r2a', 'r2b', 's'];
/** §2.2: 5k and 20k items, or the most available. */
export const SCALE = [5000, 20_000];

/**
 * The orchestrator's reading of §2.2, recorded in the frozen configuration: the literal rule (pad with every repo but
 * the tree's own) let a tree's irrelevant queries, the other gate tree's titles, match that tree's own commit messages,
 * which breaks "zero relevance by construction" and inflated tau (0.805 against 0.586 in the 2026-10-25 dry run).
 */
export const PADDING_RULE = {
  id: 'S-padding',
  rule: "each tree's S padding leaves out its own repo and the repos its irrelevant queries come from (every gate tree's repo)",
  reason: 'under the literal rule the other gate tree\'s titles match near-copies of themselves in that tree\'s commit log, so they are not irrelevant by construction',
};

export interface GateOptions {
  /** Checked with benchRoot by the caller. */
  root: string;
  home: string;
  sets: GateSet[];
  deps?: string;
  explore?: Exclude<CandidateKey, 'potion'>[];
  scale?: number[];
  workspace?: string;
  /** Scored R2b queries (lib/queries.ts r2bQueries); their relevant ids are recomputed from the same as-of replay as R1's. */
  r2b?: RetrievalQuery[];
  /** The result file's name: <root>/results/<name>-<date>.json. */
  name: string;
  log?: (s: string) => void;
}

/**
 * §2.4 and §2.5 end to end: F-best from R2a and the floors from the largest S stores (frozen in <root>/results on the
 * first run with a tau), then R1, R2b, R2a, S noise and R3 scored with that configuration, the result written and the
 * verdict printed. R2a always runs for F-best; it is reported only when asked for.
 */
export async function gate(o: GateOptions): Promise<RetrievalResult> {
  const log = o.log ?? ((s: string) => console.error(`[gate] ${s}`));
  const want = new Set(o.sets);
  const explore = o.explore ?? [];
  const trees = gateTrees(o.home);
  log(`trees: ${trees.map((t) => `${t.rootId} (${t.repo}, ${t.nodes.length} nodes)`).join(', ')}`);
  const all = o.deps ? await embedders(o.root, o.deps, explore) : [];
  if (!o.deps) log('no --deps: FTS variants only');
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
    const literal: number[] = [];
    /** Top-1 cosines of the tree's irrelevant queries on a store, per embedder, into `into(key)`. */
    const topCosines = async (store: { file: string; repoKey: string }, texts: string[], es: Embedder[], into: (key: string) => number[]) => {
      const view = new StoreView(store.file, store.repoKey);
      try {
        for (const e of es) {
          const ix = await vectorIndex(view, e);
          for (const text of texts) into(e.key).push(await topCosine(ix, e, text));
        }
      } finally {
        view.close();
      }
    };
    if (want.has('s')) {
      const workspace = o.workspace ?? join(homedir(), 'workspace');
      // A tree's irrelevant queries are the other gate trees' titles, so its padding leaves out those trees' repos as
      // well as its own (PADDING_RULE): every gate tree's repo.
      const padding = distractors(workspace, trees);
      for (const t of trees) {
        const s = scaledStores(t, padding, o.scale ?? SCALE, tmp);
        stores.set(t.rootId, s);
        log(`S ${t.rootId}: ${padding.length} distractors available; stores of ${s.map((x) => x.items).join(', ')} items (the most available up to ${(o.scale ?? SCALE).join(', ')})`);
        irrelevant.set(t.rootId, [...new Set([...trees.filter((x) => x !== t).flatMap((x) => x.nodes.map((n) => n.title)), ...zero])]);
        await topCosines(s[s.length - 1], irrelevant.get(t.rootId)!, all, (k) => (taus.get(k) ?? taus.set(k, []).get(k)!));
        // The literal §2.2 padding (only the tree's own repo left out), for the record: its tau, never used.
        const potion = all.filter((e) => `H:${e.key}` === CANDIDATE);
        if (potion.length) {
          const lit = scaledStores(t, distractors(workspace, [t]), [Math.max(...(o.scale ?? SCALE))], mkdtempSync(join(tmp, 'literal-')));
          await topCosines(lit[lit.length - 1], irrelevant.get(t.rootId)!, potion, () => literal);
        }
      }
    }
    const tauOfKey = (k: string) => (taus.has(k) ? tauOf(taus.get(k)!) : NaN);
    const exploratoryTau = Object.fromEntries(explore.flatMap((k) => (taus.has(k) ? [[k, tauOfKey(k)]] : [])));
    const computed: GateConfig = {
      ...makeConfig(tauOfKey('potion'), fBest, Object.keys(exploratoryTau).length ? exploratoryTau : undefined),
      ...(want.has('s') ? { interpretations: [{ ...PADDING_RULE, tau: tauOfKey('potion'), tauLiteral: literal.length ? tauOf(literal) : NaN }] } : {}),
    };
    const { config, written, differs } = freeze(o.root, computed);
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
          for (const [ranker, rank] of await rankers(view, config, es)) {
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
    const scores = want.has('r2a') ? await scoreQueries(r2a.queries, await rankers(r2aView, config, es), config) : [];
    if (want.has('r1') || want.has('r2b')) {
      const extra = new Map<string, Extra[]>();
      for (const q of want.has('r2b') ? o.r2b ?? [] : []) extra.set(q.node!, [...(extra.get(q.node!) ?? []), { id: q.id, set: q.set, text: q.text, ...(q.harness ? { harness: q.harness } : {}) }]);
      for (const t of trees) {
        const s = (await scoreTree(t, config, es, extra)).filter((x) => (x.set === 'r2b' ? want.has('r2b') : want.has('r1')));
        log(`${t.rootId}: ${new Set(s.map((x) => x.query.split('/')[1])).size} labelled nodes scored, ${new Set(s.filter((x) => x.set === 'r2b').map((x) => x.query)).size} R2b queries`);
        scores.push(...s);
      }
      if (want.has('r2b') && !o.r2b?.length) log('no R2b queries: the primary set (P1, P2) cannot be evaluated');
    }
    const regression = await r3((v) => rankers(v, config, es), config.k);
    const result = evaluate({ config, scores, noise, r3: regression, rankers: names, exploratory: es.map((e) => e.key).filter((k) => `H:${k}` !== CANDIDATE) });
    log(`wrote ${writeResult(o.root, o.name, result)}`);
    console.log(printVerdict(result));
    return result;
  } finally {
    r2aView.close();
    r2a.close();
    rmSync(tmp, { recursive: true, force: true });
  }
}

// --- The CLI ---

function main(argv: string[]): Promise<RetrievalResult> {
  // --scale may stand alone for the pre-registered sizes.
  const at = argv.indexOf('--scale');
  if (at >= 0 && (at + 1 === argv.length || argv[at + 1].startsWith('--'))) argv = [...argv.slice(0, at + 1), SCALE.join(','), ...argv.slice(at + 1)];
  const { values } = parseArgs({
    args: argv,
    options: {
      retrieval: { type: 'boolean', default: false }, scale: { type: 'string' }, root: { type: 'string' }, home: { type: 'string' },
      deps: { type: 'string' }, explore: { type: 'string' }, workspace: { type: 'string' },
    },
  });
  if (!values.root) throw new Error('--root DIR is required: a scratch directory outside the repo and ~/.tiller');
  if (!values.retrieval && !values.scale) throw new Error('nothing to do: pass --retrieval and/or --scale');
  const explore = (values.explore ? values.explore.split(',') : []) as Exclude<CandidateKey, 'potion'>[];
  for (const k of explore) if (!EXPLORATORY.includes(k)) throw new Error(`--explore takes ${EXPLORATORY.join(', ')}, not ${k}`);
  if (explore.length && !values.deps) throw new Error('--explore needs --deps');
  const scale = values.scale?.split(',').map(Number);
  if (scale?.some((n) => !Number.isInteger(n) || n <= 0)) throw new Error('--scale takes item counts, as 5000,20000');
  const home = resolve(values.home ?? process.env.TL_HOME ?? join(homedir(), '.tiller'));
  const root = benchRoot(values.root, [home]);
  return gate({
    root, home, sets: ['r2a', ...(values.retrieval ? ['r1' as const] : []), ...(scale ? ['s' as const] : [])], explore, name: 'replay',
    ...(scale ? { scale } : {}), ...(values.deps ? { deps: resolve(values.deps) } : {}), ...(values.workspace ? { workspace: resolve(values.workspace) } : {}),
    log: (s) => console.error(`[replay] ${s}`),
  });
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main(process.argv.slice(2)).catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
