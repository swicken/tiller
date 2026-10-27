// Layer R replay, R1: each labelled archived node's title and brief scored with the product's memory search against the
// store as of its creation. Sessions are only read; real text stays in temp stores that are deleted, and
// <root>/results gets ids and numbers only.
//
//   npm run bench:memory:replay -- --root DIR [--home ~/.tiller]
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { benchRoot } from './lib/daemon.js';
import { gateTrees, hotFiles, labels, replayAsOf, type Tree } from './lib/archive.js';
import { printResult, result, scoreQueries, searchRank, writeResult } from './retrieval/eval.js';
import type { QueryScore, RetrievalQuery, RetrievalResult } from './retrieval/types.js';

/**
 * Every node of the tree with at least one label: its title and its brief (title plus prompt), against the store
 * replayed from what closed before it was created, relevant = its labels' ledger items.
 */
export function scoreTree(tree: Tree): QueryScore[] {
  const hot = hotFiles(tree);
  const out: QueryScore[] = [];
  for (const q of tree.nodes) {
    const lab = labels(tree, q, hot);
    if (!lab.length) continue;
    const replay = replayAsOf(tree, q);
    try {
      const ledger = replay.ledgerIds();
      const relevant = lab.flatMap((id) => (ledger.has(id) ? [ledger.get(id)!] : []));
      if (!relevant.length) continue;
      const base = { tree: tree.rootId, relevant };
      const qs: RetrievalQuery[] = [
        { ...base, id: `${tree.rootId}/${q.id}/r1-title`, set: 'r1-title', text: q.title },
        { ...base, id: `${tree.rootId}/${q.id}/r1-brief`, set: 'r1-brief', text: [q.title, q.prompt].filter(Boolean).join('\n') },
      ];
      out.push(...scoreQueries(qs, searchRank(replay.store, replay.scope)));
    } finally {
      replay.close();
    }
  }
  return out;
}

/** R1 over the pre-registered trees of home, written to <root>/results/<name>-<date>.json and printed. */
export function replay(o: { root: string; home: string; name: string; log?: (s: string) => void }): RetrievalResult {
  const log = o.log ?? ((s: string) => console.error(`[replay] ${s}`));
  const trees = gateTrees(o.home);
  log(`trees: ${trees.map((t) => `${t.rootId} (${t.repo}, ${t.nodes.length} nodes)`).join(', ')}`);
  const r = result(trees.flatMap((t) => scoreTree(t)));
  log(`wrote ${writeResult(o.root, o.name, r)}`);
  console.log(printResult(r));
  return r;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  try {
    const { values } = parseArgs({ options: { root: { type: 'string' }, home: { type: 'string' } } });
    if (!values.root) throw new Error('--root DIR is required: a scratch directory outside the repo and ~/.tiller');
    const home = resolve(values.home ?? process.env.TL_HOME ?? join(homedir(), '.tiller'));
    replay({ root: benchRoot(values.root, [home]), home, name: 'replay' });
  } catch (err) {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  }
}
