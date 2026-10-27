// The Layer A fixture format (bench plan §2.1) and its replay through the real memory modules on a temp home: Case
// seeds a MemoryStore from a fixture's episodes and resolves "@label" references to item ids. Shared by Layer A and the
// retrieval bench.
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ArchivedNode, Harness, Outcome } from '../../../src/shared/protocol.js';
import { derive } from '../../../src/daemon/memory-derive.js';
import type { DIGEST_SECTIONS } from '../../../src/daemon/memory-digest.js';
import { redact, type Actor, type CaptureEvent, type DigestRole, type ItemKind, type ItemRow, type MemoryScope } from '../../../src/daemon/memory-schema.js';
import { MemoryStore } from '../../../src/daemon/memory-store.js';

export type Section = keyof typeof DIGEST_SECTIONS;
/** Picks items by kind, repo alias, exact text or text substrings. */
export interface Matcher { kind?: ItemKind; repo?: string; text?: string; textIncludes?: string[] }
export interface ExpectItem extends Matcher {
  label?: string; author?: string; harness?: string; nodeId?: string; seen?: number; retracted?: boolean; pinned?: boolean; bodyIncludes?: string[];
}
/** A captured event without ts; the loader fills ts, spawn's parentId and kind, gate's attempt and close's whole ArchivedNode. */
export type FixtureEvent = { type: CaptureEvent['type'] } & Record<string, unknown>;
export type Op =
  | { type: 'add'; kind: ItemKind; text: string; body?: string; supersedes?: string; label?: string }
  | { type: 'forget'; match: string; reason: string; purge?: boolean }
  | { type: 'pin'; match?: string; text?: string; unpin?: boolean; label?: string };
export interface Episode {
  /** Offset from `now`, as -3d+5m. */
  at: string;
  repo: string;
  node?: string;
  /** Remembered per node; defaults: the node itself, claude, claude-haiku-5-5. */
  root?: string;
  harness?: Harness;
  model?: string;
  /** For an op: 'human', else the episode's node acts as an agent. */
  actor?: string;
  event?: FixtureEvent;
  op?: Op;
}
/** each, repeated with every "{i}" replaced by 1..repeat. */
export interface Repeat { repeat: number; each: Episode[] }
export interface Query {
  id: string;
  repo: string;
  role: DigestRole;
  brief?: string;
  must?: string[];
  should?: string[];
  forbidden?: string[];
  /** Default 8. */
  k?: number;
  /** Reported only: kept out of the aggregate floors. */
  report?: boolean;
  /** Labels that must be injected in this order. */
  ordered?: string[];
  /** [min, max] item lines per section. */
  sectionLines?: Partial<Record<Section, [number, number]>>;
  textIncludes?: string[];
  textExcludes?: string[];
  /** Reading harnesses whose digests must be byte-identical. */
  sameForHarnesses?: Harness[];
}
export interface Search { repo: string; query: string; first?: string; includes?: string[]; excludes?: string[] }
export interface Fixture {
  name: string;
  claim: number;
  note?: string;
  now: string;
  repos: Record<string, string>;
  episodes: (Episode | Repeat)[];
  expectItems?: ExpectItem[];
  forbidItems?: Matcher[];
  /** Rows of each kind across all repos, retracted ones included. */
  exactCounts?: Partial<Record<ItemKind, number>>;
  searches?: Search[];
  queries?: Query[];
  /** Strings that must not appear in the DB or WAL bytes. */
  absentBytes?: string[];
}
export interface Floors { macroRecallAtK: number; meanWorkerPrecision: number }

const UNIT = { d: 86_400_000, h: 3_600_000, m: 60_000, s: 1_000 } as const;
export function offset(at: string): number {
  let ms = 0;
  const rest = at.replace(/([+-])(\d+)([dhms])/g, (_, sign: string, n: string, unit: keyof typeof UNIT) => {
    ms += (sign === '-' ? -1 : 1) * Number(n) * UNIT[unit];
    return '';
  });
  if (rest) throw new Error(`bad offset "${at}"`);
  return ms;
}

export const expand = (episodes: (Episode | Repeat)[]): Episode[] => episodes.flatMap((e) => ('repeat' in e
  ? Array.from({ length: e.repeat }, (_, i) => JSON.parse(JSON.stringify(e.each).replaceAll('{i}', String(i + 1))) as Episode[]).flat()
  : [e]));

interface NodeCtx { root: string; harness: Harness; model: string; parentId: string | null; createdAt: number; gates: number; prompt?: string; outcome?: Outcome }
export type Row = ItemRow & { repo_key: string };

export class Case {
  readonly home = mkdtempSync(join(tmpdir(), 'tl-bench-'));
  readonly now: number;
  private clock: number;
  readonly store: MemoryStore;
  private readonly labels = new Map<string, number>();
  private readonly nodes = new Map<string, NodeCtx>();

  constructor(readonly fx: Fixture) {
    this.now = this.clock = Date.parse(fx.now);
    this.store = new MemoryStore(this.home, { now: () => this.clock });
  }

  scope(repo: string): MemoryScope {
    const repoKey = this.fx.repos[repo];
    if (!repoKey) throw new Error(`unknown repo alias "${repo}"`);
    return { repoKey, repoPath: `/bench/${repo}` };
  }

  replay(): void {
    for (const ep of expand(this.fx.episodes)) {
      this.clock = this.now + offset(ep.at);
      const node = ep.node === undefined ? undefined : this.node(ep);
      const scope: MemoryScope = { ...this.scope(ep.repo), ...(node && { nodeId: ep.node, rootId: node.root, harness: node.harness, model: node.model }) };
      if (ep.event) {
        if (!node) throw new Error(`an event needs a node: ${JSON.stringify(ep)}`);
        // The capture funnel's order (plan R1): redact the whole event, then the node's history, derive and apply.
        const event = redact(this.capture(ep.event, ep.node!, node, ep.repo));
        this.store.apply(scope, derive(event, this.store.nodeHistory(scope, ep.node!)));
      } else if (ep.op) {
        const actor: Actor = ep.actor === 'human' ? { kind: 'human' }
          : node ? { kind: 'agent', nodeId: ep.node!, rootId: node.root, harness: node.harness, model: node.model }
            : (() => { throw new Error(`an op needs an actor or a node: ${JSON.stringify(ep)}`); })();
        this.op(ep.op, actor, actor.kind === 'human' ? this.scope(ep.repo) : scope);
      }
    }
    this.clock = this.now;
    for (const e of this.fx.expectItems ?? []) if (e.label) this.id(`@${e.label}`);
  }

  private node(ep: Episode): NodeCtx {
    let n = this.nodes.get(ep.node!);
    if (!n) {
      const root = ep.root ?? ep.node!;
      n = { root, harness: 'claude', model: 'claude-haiku-5-5', parentId: root === ep.node ? null : root, createdAt: this.clock, gates: 0 };
      this.nodes.set(ep.node!, n);
    }
    if (ep.root) n.root = ep.root;
    if (ep.harness) n.harness = ep.harness;
    if (ep.model) n.model = ep.model;
    return n;
  }

  /** The CaptureEvent the daemon would capture, with what the fixture leaves out filled in. */
  private capture(ev: FixtureEvent, id: string, n: NodeCtx, repo: string): CaptureEvent {
    const ts = this.clock;
    const { type, ...rest } = ev;
    switch (type) {
      case 'spawn': {
        const { prompt, ...spawn } = rest as { prompt?: string; parentId?: string | null };
        n.prompt = prompt ?? n.prompt;
        if (spawn.parentId !== undefined) n.parentId = spawn.parentId;
        return { type, ts, parentId: n.parentId, kind: 'claude', ...spawn };
      }
      case 'outcome': {
        const o = rest as unknown as Omit<Outcome, 'at'>;
        n.outcome = { ...o, at: ts };
        return { type, ts, ...o };
      }
      case 'gate': {
        n.gates++;
        return { type, ts, attempt: n.gates, ...(rest as { ok: boolean; command: string; tail?: string }) };
      }
      case 'close': {
        const archived: ArchivedNode = {
          id, rootId: n.root, parentId: n.parentId, title: id, cwd: `/bench/${repo}`, harness: n.harness, model: n.model,
          ...(n.prompt ? { prompt: n.prompt } : {}), ...(n.outcome ? { outcome: n.outcome } : {}), createdAt: n.createdAt, closedAt: ts,
          ...(rest.archived as Partial<ArchivedNode> | undefined),
        };
        return { type, ts, archived };
      }
      default:
        return { type, ts, ...rest } as CaptureEvent;
    }
  }

  private op(op: Op, actor: Actor, scope: MemoryScope): void {
    if (op.type === 'add') {
      const { id } = this.store.add(scope, actor, {
        kind: op.kind, text: op.text, ...(op.body ? { body: op.body } : {}), ...(op.supersedes ? { supersedes: this.id(op.supersedes) } : {}),
      });
      if (op.label) this.labels.set(op.label, id);
    } else if (op.type === 'forget') {
      this.store.forget(scope, actor, { id: this.id(op.match), reason: op.reason, ...(op.purge ? { purge: true } : {}) });
    } else {
      const { id } = this.store.pin(scope, actor, {
        ...(op.match ? { id: this.id(op.match) } : {}), ...(op.text ? { text: op.text } : {}), ...(op.unpin ? { unpin: true } : {}),
      });
      if (op.label) this.labels.set(op.label, id);
    }
  }

  /** Every item row, retracted ones included, with its repo key. */
  rows(): Row[] {
    const file = this.store.accountFile(undefined);
    if (!existsSync(file)) return [];
    const db = new DatabaseSync(file, { readOnly: true });
    try {
      return db.prepare('SELECT i.*, r.key AS repo_key FROM items i JOIN repos r ON r.id = i.repo_id ORDER BY i.id').all() as unknown as Row[];
    } finally {
      db.close();
    }
  }

  matching(m: Matcher): Row[] {
    const repoKey = m.repo === undefined ? undefined : this.scope(m.repo).repoKey;
    return this.rows().filter((r) => (!m.kind || r.kind === m.kind) && (!repoKey || r.repo_key === repoKey)
      && (m.text === undefined || r.text === m.text) && (m.textIncludes ?? []).every((s) => r.text.includes(s)));
  }

  /** The id of an "@label": an op's label, else its expectItems matcher, which must match exactly one item. */
  id(ref: string): number {
    if (!ref.startsWith('@')) throw new Error(`a label reference starts with @: "${ref}"`);
    const label = ref.slice(1);
    const known = this.labels.get(label);
    if (known !== undefined) return known;
    const e = this.fx.expectItems?.find((x) => x.label === label);
    if (!e) throw new Error(`unknown label "${label}"`);
    const found = this.matching(e);
    if (found.length !== 1) throw new Error(`label "${label}" matches ${found.length} items, not 1: ${JSON.stringify(e)}`);
    this.labels.set(label, found[0].id);
    return found[0].id;
  }

  /** The label of an id, for readable failures. */
  name(id: number): string {
    return [...this.labels].find(([, v]) => v === id)?.[0] ?? `m${id}`;
  }

  close(): void {
    this.store.close();
    rmSync(this.home, { recursive: true, force: true });
  }
}
