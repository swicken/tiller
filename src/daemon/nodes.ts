import { randomBytes } from 'node:crypto';
import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import type { NodeRecord } from '../shared/protocol.js';

export class NodeRegistry {
  private nodes = new Map<string, NodeRecord>();
  private timer: NodeJS.Timeout | undefined;
  /** Ids of the nodes with a live process, saved with the nodes so a crash or kill still leaves them for resume on start. */
  private liveIds: string[] = [];
  /** Why the daemon stopped cleanly; absent after a crash or kill. The next start reads it and clears it. */
  private stopReason: string | undefined;
  /** Root ids in the order the human arranged the session tabs. */
  private order: string[] = [];
  private closed = false;

  constructor(private file: string) {}

  load(): void {
    let raw: string;
    try {
      raw = readFileSync(this.file, 'utf8');
    } catch {
      return; // no file yet
    }
    try {
      const data = JSON.parse(raw);
      if (data?.version !== 1 || !Array.isArray(data.nodes)) throw new Error('bad shape');
      this.nodes = new Map((data.nodes as NodeRecord[]).map((n) => [n.id, n]));
      this.liveIds = Array.isArray(data.live) ? data.live.filter((x: unknown): x is string => typeof x === 'string') : [];
      this.stopReason = typeof data.stopped === 'string' ? data.stopped : undefined;
      this.order = Array.isArray(data.sessionOrder) ? data.sessionOrder.filter((x: unknown): x is string => typeof x === 'string') : [];
    } catch {
      try { renameSync(this.file, `${this.file}.corrupt-${Date.now()}`); } catch { /* best effort */ }
      this.nodes = new Map();
    }
  }

  create(partial: Omit<NodeRecord, 'id' | 'createdAt'>): NodeRecord {
    let id: string;
    do id = `n-${randomBytes(4).toString('hex')}`; while (this.nodes.has(id));
    const node: NodeRecord = { ...partial, id, createdAt: Date.now() };
    this.nodes.set(id, node);
    this.save();
    return node;
  }

  get(id: string): NodeRecord | undefined { return this.nodes.get(id); }
  list(): NodeRecord[] { return [...this.nodes.values()]; }

  /** Ancestors, nearest parent first. */
  lineage(id: string): NodeRecord[] {
    const out: NodeRecord[] = [];
    const seen = new Set([id]);
    for (let p = this.nodes.get(id)?.parentId; p && !seen.has(p); p = this.nodes.get(p)?.parentId) {
      const n = this.nodes.get(p);
      if (!n) break;
      seen.add(p);
      out.push(n);
    }
    return out;
  }

  update(id: string, patch: Partial<Omit<NodeRecord, 'id'>>): NodeRecord | undefined {
    const n = this.nodes.get(id);
    if (!n) return undefined;
    Object.assign(n, patch);
    this.save();
    return n;
  }

  get live(): string[] { return this.liveIds; }

  setLive(ids: string[]): void {
    this.liveIds = ids;
    this.save();
  }

  get stopped(): string | undefined { return this.stopReason; }

  setStopped(reason: string | undefined): void {
    this.stopReason = reason;
    this.save();
  }

  get sessionOrder(): string[] { return this.order; }

  setSessionOrder(ids: string[]): void {
    this.order = ids;
    this.save();
  }

  remove(id: string): boolean {
    this.order = this.order.filter((x) => x !== id);
    const had = this.nodes.delete(id);
    if (had) this.save();
    return had;
  }

  /** Write any pending change immediately (for shutdown and tests). */
  flush(): void {
    if (!this.timer) return;
    clearTimeout(this.timer);
    this.timer = undefined;
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify({ version: 1, nodes: this.list(), live: this.liveIds, stopped: this.stopReason, sessionOrder: this.order }, null, 2));
    renameSync(tmp, this.file);
  }

  /** Shutdown's final write: flush, then schedule no more saves, since the process exits and the home may go. */
  close(): void {
    this.flush();
    this.closed = true;
  }

  private save(): void {
    if (!this.closed) this.timer ??= setTimeout(() => this.flush(), 50);
  }
}
