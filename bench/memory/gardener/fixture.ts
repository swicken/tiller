// Loads a gardener fixture (fixtures/*.json, plan §5.1) into a real MemoryStore on a home directory, the way Layer A
// replays its fixtures: each captured event is redacted, then derived against its node's history and applied, with the
// store's clock set to the episode's time. Shared by layer-g.test.ts and live.ts.
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import type { ArchivedNode, Outcome } from '../../../src/shared/protocol.js';
import { derive } from '../../../src/daemon/memory-derive.js';
import { digestFor } from '../../../src/daemon/memory-digest.js';
import { redact, type Actor, type CaptureEvent, type DigestSource, type ItemKind, type ItemRow, type MemoryScope } from '../../../src/daemon/memory-schema.js';
import { MemoryStore } from '../../../src/daemon/memory-store.js';

/** The literal action an adversarial item asks for, by "@label". */
export type Attempt = { action: 'merge'; ids: string[] } | { action: 'supersede'; id: string; by: string };
/** One gardenable item's label (the fixture's note describes them). */
export interface GardenLabel {
  cluster?: string;
  stale?: 'supersedable' | 'forget-only';
  by?: string;
  good?: true;
  nearMiss?: string;
  protected?: 'pin';
  ineligible?: true;
  adversarial?: string;
  attempt?: Attempt | null;
  expect?: 'allowed' | { refused: string[] };
}
interface Episode {
  at: string;
  repo: string;
  node?: string;
  root?: string;
  actor?: 'human';
  event?: { type: 'outcome' | 'close' } & Record<string, unknown>;
  op?: { type: 'add'; kind: ItemKind; text: string; label?: string } | { type: 'pin'; text: string; label?: string };
}
export interface Query { id: string; repo: string; role: 'orchestrator' | 'worker'; brief?: string; should: string[] }
export interface GardenFixture {
  name: string;
  note: string;
  now: string;
  repos: Record<string, string>;
  episodes: Episode[];
  expectItems: { label: string; kind: ItemKind; text?: string; textIncludes?: string[] }[];
  queries: Query[];
  gardenCounts: Record<string, number>;
  garden: Record<string, GardenLabel>;
}

export const FIXTURE_NAMES = ['g-small', 'g-std', 'g-large', 'g-clean'] as const;
export function loadFixture(name: string): GardenFixture {
  return JSON.parse(readFileSync(fileURLToPath(new URL(`./fixtures/${name}.json`, import.meta.url)), 'utf8')) as GardenFixture;
}

const UNIT = { d: 86_400_000, h: 3_600_000, m: 60_000 } as const;
const offset = (at: string) => [...at.matchAll(/-(\d+)([dhm])/g)].reduce((ms, [, n, u]) => ms - Number(n) * UNIT[u as keyof typeof UNIT], 0);

/** A fixture replayed into a store, with its labels resolved to item ids. */
export class Seeded {
  readonly store: MemoryStore;
  /** The store's clock: the fixture's now (or at) once seeded; tests may move it. */
  clock: number;
  readonly now: number;
  private readonly ids = new Map<string, number>();
  private readonly repoPath: string | undefined;

  /** at replaces the fixture's now, so live runs see the items at their intended ages. repoPath is the checkout's path. */
  constructor(readonly fx: GardenFixture, readonly home: string, opts: { at?: number; repoPath?: string } = {}) {
    this.now = this.clock = opts.at ?? Date.parse(fx.now);
    this.repoPath = opts.repoPath;
    this.store = new MemoryStore(home, { now: () => this.clock });
    const scope = (alias: string): MemoryScope => ({ repoKey: fx.repos[alias], repoPath: this.repoPath ?? `/bench/${alias}` });
    const nodes = new Map<string, { root: string; outcome?: Outcome; createdAt: number }>();
    for (const ep of fx.episodes) {
      this.clock = this.now + offset(ep.at);
      if (ep.actor === 'human' && ep.op?.type === 'pin') {
        this.label(ep.op.label, this.store.pin(scope(ep.repo), { kind: 'human' }, { text: ep.op.text }).id);
        continue;
      }
      if (!ep.node) throw new Error(`an episode needs a node or the human: ${JSON.stringify(ep)}`);
      const n = nodes.get(ep.node) ?? { root: ep.root ?? ep.node, createdAt: this.clock };
      nodes.set(ep.node, n);
      const at: MemoryScope = { ...scope(ep.repo), nodeId: ep.node, rootId: n.root, harness: 'claude', model: 'claude-haiku-5-5' };
      if (ep.op?.type === 'add') {
        const actor: Actor = { kind: 'agent', nodeId: ep.node, rootId: n.root, harness: 'claude', model: 'claude-haiku-5-5' };
        this.label(ep.op.label, this.store.add(at, actor, { kind: ep.op.kind, text: ep.op.text }).id);
      } else if (ep.event) {
        const { type, ...rest } = ep.event, ts = this.clock;
        let event: CaptureEvent;
        if (type === 'outcome') {
          n.outcome = { ...(rest as unknown as Omit<Outcome, 'at'>), at: ts };
          event = { type, ts, ...(rest as unknown as Omit<Outcome, 'at'>) };
        } else {
          const archived: ArchivedNode = {
            id: ep.node, rootId: n.root, parentId: n.root === ep.node ? null : n.root, title: ep.node, cwd: at.repoPath, harness: 'claude',
            model: 'claude-haiku-5-5', ...(n.outcome ? { outcome: n.outcome } : {}), createdAt: n.createdAt, closedAt: ts,
            ...(rest.archived as Partial<ArchivedNode>),
          };
          event = { type, ts, archived };
        }
        this.store.apply(at, derive(redact(event), this.store.nodeHistory(at, ep.node)));
      } else {
        throw new Error(`unsupported episode: ${JSON.stringify(ep)}`);
      }
    }
    this.clock = this.now;
    const rows = this.rows();
    for (const e of fx.expectItems) {
      const found = rows.filter((r) => r.kind === e.kind && (e.text === undefined || r.text === e.text) && (e.textIncludes ?? []).every((s) => r.text.includes(s)));
      if (found.length !== 1) throw new Error(`${fx.name}: label ${e.label} matches ${found.length} items`);
      this.label(e.label, found[0].id);
    }
    for (const label of Object.keys(fx.garden)) this.id(label);
  }

  private label(label: string | undefined, id: number): void {
    if (label) this.ids.set(label, id);
  }

  /** The item id of a label, with or without its "@". */
  id(label: string): number {
    const id = this.ids.get(label.replace(/^@/, ''));
    if (id === undefined) throw new Error(`${this.fx.name}: unknown label ${label}`);
    return id;
  }

  /** The label of an item id, for readable failures; m<id> when it has none. */
  name(id: number): string {
    return [...this.ids].find(([, v]) => v === id)?.[0] ?? `m${id}`;
  }

  /** Labels whose garden entry passes the test. */
  labels(test: (g: GardenLabel) => unknown): string[] {
    return Object.entries(this.fx.garden).filter(([, g]) => test(g)).map(([l]) => l);
  }

  /** Labeled duplicate clusters, each a list of member labels, a pin included when it is one. */
  clusters(): Map<string, string[]> {
    const out = new Map<string, string[]>();
    for (const [label, g] of Object.entries(this.fx.garden)) if (g.cluster) out.set(g.cluster, [...(out.get(g.cluster) ?? []), label]);
    return out;
  }

  /** Every item row of the account file, ordered by id. */
  rows(): ItemRow[] {
    const db = new DatabaseSync(this.store.accountFile(undefined), { readOnly: true });
    try {
      return db.prepare('SELECT * FROM items ORDER BY id').all() as unknown as ItemRow[];
    } finally {
      db.close();
    }
  }

  /** The fixture's one repository. */
  scope(): MemoryScope {
    const [alias] = Object.keys(this.fx.repos);
    return { repoKey: this.fx.repos[alias], repoPath: this.repoPath ?? `/bench/${alias}` };
  }
}

/**
 * The fixture's query digests from store: redundancy is the lines that share a labeled cluster with another line of the
 * same digest; recall is the worker briefs' mean share of relevant facts shown, a cluster counting as one fact shown by
 * any member (the keep a merge left included); orchestrator is that digest's item ids.
 */
export function digestMeasure(c: Seeded, store: DigestSource, now: number): { redundancy: number; recall: number; orchestrator: number[] } {
  const clusterOf = (label: string) => c.fx.garden[label.replace(/^@/, '')]?.cluster;
  let redundancy = 0;
  const recall: number[] = [];
  let orchestrator: number[] = [];
  for (const q of c.fx.queries) {
    const scope: MemoryScope = { ...c.scope(), nodeId: `n-query-${q.id}`, rootId: `n-query-${q.id}`, harness: 'claude', model: 'bench' };
    const ids = digestFor(store, scope, { role: q.role, brief: q.brief, now }).itemIds;
    const counts = new Map<string, number>();
    for (const id of ids) {
      const cl = clusterOf(c.name(id));
      if (cl) counts.set(cl, (counts.get(cl) ?? 0) + 1);
    }
    redundancy += [...counts.values()].filter((n) => n > 1).reduce((a, b) => a + b, 0);
    if (q.role === 'orchestrator') {
      orchestrator = ids;
      continue;
    }
    const facts = new Map<string, number[]>();
    for (const l of q.should) facts.set(clusterOf(l) ?? l, [...(facts.get(clusterOf(l) ?? l) ?? []), c.id(l)]);
    recall.push([...facts.values()].filter((f) => f.some((id) => ids.includes(id))).length / facts.size);
  }
  return { redundancy, recall: recall.reduce((a, b) => a + b, 0) / recall.length, orchestrator };
}
