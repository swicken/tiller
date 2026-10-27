import { outcomeLine } from '../shared/format.js';
import type { NodeView } from '../shared/protocol.js';
import { active } from './status.js';

interface CompletionQuery {
  view: (id: string) => NodeView | undefined;
  turnStartedAt: (id: string) => number | undefined;
}

/** Whether `id` has finished a turn begun at or after `since`, has exited, or is gone. */
export function turnDone(query: CompletionQuery, id: string, since: number): boolean {
  const v = query.view(id);
  return !v || !!v.status.exited || (v.status.state === 'done' && (query.turnStartedAt(id) ?? -Infinity) >= since);
}

const NOTIFY_TTL_MS = 12 * 3600_000;
export type NotifyWhen = { ids: string[]; when: 'all' | 'any'; of: 'turn' | 'success' };
/** since: the turn in progress at registration, else a later turn or report. */
interface Watch extends NotifyWhen { at: number; since: Record<string, number> }

/** One caller's one-shot watches. Its runtime owns their lifetime; messaging supplies delivery. */
export class CompletionWatches {
  private readonly all = new Map<string, Watch>();
  /** Nodes the watcher is closing now (see hold). */
  private readonly closing = new Set<string>();

  constructor(private readonly query: CompletionQuery, private readonly notify: (text: string, label: string, ids: string[]) => void) {}

  covers(id: string): boolean {
    return [...this.all.values()].some((w) => w.ids.includes(id));
  }

  register(req: NotifyWhen): { replaced: boolean } {
    const ids = [...new Set(req.ids)].sort();
    const key = ids.join(',');
    const replaced = this.all.has(key);
    const now = Date.now();
    const since = Object.fromEntries(ids.map((id) => {
      const v = this.query.view(id);
      return [id, v && active(v.status) ? this.query.turnStartedAt(id) ?? now : now];
    }));
    this.all.set(key, { ...req, ids, at: now, since });
    this.check(key);
    return { replaced };
  }

  /** The watcher is closing `id` itself: its watches wait, rather than count the close as finishing, until settle. */
  hold(id: string): void {
    this.closing.add(id);
  }

  /** The watcher's close of `id` ended: if it closed, forget `id`; if not, the node runs on and its watches check again. */
  settle(id: string, closed: boolean): void {
    this.closing.delete(id);
    if (closed) return this.forget(id);
    for (const [key, w] of [...this.all]) if (w.ids.includes(id)) this.check(key);
  }

  /**
   * The watcher closed `id` itself, so needs no word of it: drop it from each watch, and a watch left with none. A watch
   * on just the rest, waiting for the same thing, already reports them; one waiting for something else is kept beside it.
   */
  private forget(id: string): void {
    for (const [key, w] of [...this.all]) {
      if (!w.ids.includes(id)) continue;
      this.all.delete(key);
      const ids = w.ids.filter((x) => x !== id), next = ids.join(','), alt = `${next}\0${w.when} ${w.of}`;
      if (!ids.length || [next, alt].some((k) => this.all.get(k)?.when === w.when && this.all.get(k)?.of === w.of)) continue;
      const k = this.all.has(next) ? alt : next;
      this.all.set(k, { ...w, ids });
      this.check(k);
    }
  }

  sweep(now: number): void {
    for (const [key, w] of this.all) {
      if (now - w.at > NOTIFY_TTL_MS) this.all.delete(key);
      else this.check(key);
    }
  }

  private finished(w: Watch, id: string): boolean {
    if (w.of === 'turn') return turnDone(this.query, id, w.since[id]);
    const v = this.query.view(id);
    return !v || !!v.status.exited || (v.outcome?.at ?? -Infinity) >= w.since[id];
  }

  private line(id: string): string {
    const v = this.query.view(id);
    if (!v) return `${id}: closed`;
    if (v.outcome) return `${id}: ${outcomeLine(v.outcome, true)}`;
    return `${id}: ${v.status.exited ? 'exited' : v.status.state}`;
  }

  private check(key: string): void {
    const w = this.all.get(key)!;
    if (w.ids.some((id) => this.closing.has(id))) return;
    const done = w.ids.filter((id) => this.finished(w, id));
    if (w.when === 'all' ? done.length < w.ids.length : !done.length) return;
    this.all.delete(key);
    const text = `${done.length} of ${w.ids.length} finished:\n${w.ids.map((id) => this.line(id)).join('\n')}`;
    this.notify(text, `tiller (notify_when ${w.when} of ${w.of})`, w.ids);
  }
}
