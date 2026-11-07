// The daemon applies notification policy to actionable attention and tree completion.
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { APPROVAL_ID, dndActive, finished, isAgentKind, type Dnd, type NativeNotification, type NodeView } from '../shared/protocol.js';
import type { Notifications, NotifyLevel } from './config.js';
import type { NotifyEvent } from './manager.js';

const THROTTLE_MS = 5000;
const APP_BUNDLE = 'dev.tiller.app';

/** A node event, or an agent's request for the human's approval. */
export type Kind = NotifyEvent['kind'] | 'approval';

export interface Content { title: string; subtitle?: string; body: string; sound: boolean }

const firstLine = (s: string | undefined, max = 120) => (s ?? '').split('\n').find((l) => l.trim())?.trim().slice(0, max) ?? '';
const withText = (label: string, text: string) => (text ? `${label}: ${text}` : label);

/** What to show for `node` reaching `kind`. `root` is the session (root node) title. */
export function content(node: NodeView, kind: NotifyEvent['kind'], root?: string): Omit<Content, 'sound'> {
  const { state, activity, lastAssistantMessage: msg } = node.status;
  const subtitle = root && root !== node.title ? root : undefined;
  let body: string;
  if (kind === 'needsYou' && state === 'waiting') body = withText('Asks', activity?.replace(/^question: /, '') || firstLine(msg));
  else if (kind === 'needsYou') body = withText('Needs approval', activity?.replace(/^needs approval: /, '') ?? '');
  else if (kind === 'done') body = withText('Finished', firstLine(msg));
  else if (kind === 'errored') body = withText('Turn failed', firstLine(msg));
  else body = 'Exited';
  return { title: node.title, subtitle, body };
}

/** Whether local time `now` falls in `spec` ("HH:MM-HH:MM", start inclusive, end exclusive; may run across midnight). */
export function inQuietHours(spec: string, now: Date): boolean {
  const [start, end] = spec.split('-').map((t) => { const [h, m] = t.split(':').map(Number); return h * 60 + m; });
  const t = now.getHours() * 60 + now.getMinutes();
  return start <= end ? t >= start && t < end : t >= start || t < end;
}

/** How to show `kind` under the notifications config, and which setting decided it. */
export function decide(kind: Kind, cfg: Notifications, now: Date): { level: NotifyLevel; why: string } {
  const level = cfg.kinds[kind];
  if (level === 'silent') return { level, why: `kinds.${kind}` };
  if (cfg.quietHours && inQuietHours(cfg.quietHours, now)) return kind === 'needsYou' || kind === 'approval' ? { level: 'banner', why: 'quietHours' } : { level: 'silent', why: 'quietHours' };
  return { level, why: `kinds.${kind}` };
}

export interface NotifierDeps {
  view(id: string): NodeView | undefined;
  /** The whole tree `id` belongs to, root first. */
  tree(id: string): NodeView[];
  /** The notifications config that applies to node `id`. */
  config(id: string): Notifications;
  dnd(): Dnd;
  /** Clients looking at the node right now. */
  watchers(id: string): number;
  appConnected(): boolean;
  /** Approved payload only; true means accepted or committed with an uncertain receipt. */
  notifyNative?(notification: NativeNotification): Promise<boolean>;
  /** Absolute path of terminal-notifier, if installed. */
  terminalNotifier?: string;
  /** macOS bundle id of the daemon's terminal, activated on click when no app is connected. */
  terminalBundle?: string;
  /** Shell command run on click, given the node id. */
  onClick(id: string): string;
  run(file: string, args: string[]): void;
  now?(): number;
  /** Where each sent or suppressed notification is reported; defaults to console.log (the daemon log). */
  log?(line: string): void;
}

export function notifyArgs(c: Content, id: string, d: Pick<NotifierDeps, 'terminalNotifier' | 'terminalBundle' | 'appConnected' | 'onClick'>): { file: string; args: string[] } {
  if (!d.terminalNotifier) {
    const q = (s: string) => `"${s.replace(/[\\"]/g, '\\$&')}"`;
    return { file: 'osascript', args: ['-e', `display notification ${q(c.body)} with title ${q(c.title)}${c.subtitle ? ` subtitle ${q(c.subtitle)}` : ''}`] };
  }
  const activate = d.appConnected() ? APP_BUNDLE : d.terminalBundle;
  return {
    file: d.terminalNotifier,
    args: [
      '-title', c.title, ...(c.subtitle ? ['-subtitle', c.subtitle] : []), '-message', c.body, '-group', id,
      ...(c.sound ? ['-sound', 'default'] : []), ...(activate ? ['-activate', activate] : []), '-execute', d.onClick(id),
    ],
  };
}

const failed = (v: NodeView) => !!v.status.errored || v.outcome?.outcome === 'failed';
/** Everything of one node that summarize reads to decide new work or completion. */
const summaryInputs = (v: NodeView) => [v.status.state, !!v.status.exited, v.gate, !!v.pending, v.outcome, v.sessionId];

/**
 * Returns the 'notify' listener. Nothing is sent for a muted node, during do not disturb, or for a node a focused client
 * is looking at; then the notifications config picks banner, sound or silent; individual events are throttled to one per node and kind every 5 s.
 * With treeDoneSummary, agent done and exited are replaced by one notification per completed work cycle.
 * observe skips a node event that changed none of summaryInputs; recheck always runs; forget drops a removed node's state.
 */
export function createNotifier(d: NotifierDeps): ((n: NotifyEvent) => void) & {
  observe(node: NodeView): void; approval(text: string): void; recheck(node: NodeView): void; forget(id: string): void;
} {
  const last = new Map<string, number>();
  const seen = new Map<string, unknown[]>();
  /** Roots whose finish has been announced, until one of their agents starts new work. */
  const announced = new Set<string>();
  const active = new Set<string>();
  const observed = new Map<string, {
    sessionId?: string; exited: boolean; gate: NodeView['gate']; outcomeBeforeGate: NodeView['outcome'];
  }>();
  const log = d.log ?? console.log;
  const post = (id: string, kind: Kind, key: string, c: Omit<Content, 'sound'>, now: number) => {
    const say = (what: string) => log(`notify ${id} ${key}: ${what}`);
    if (d.view(id)?.muted) return say('suppressed (muted)');
    if (dndActive(d.dnd(), now)) return say('suppressed (do not disturb)');
    if (d.watchers(id) > 0) return say('suppressed (watched)');
    const { level, why } = decide(kind, d.config(id), new Date(now));
    if (level === 'silent') return say(`suppressed (${why})`);
    const k = `${id}:${key}`;
    if (key !== 'tree' && kind !== 'approval' && now - (last.get(k) ?? -Infinity) < THROTTLE_MS) return say('suppressed (throttled)');
    last.set(k, now);
    const payload = { ...c, id, sound: level === 'sound' };
    const fallback = () => {
      const { file, args } = notifyArgs(payload, id, d);
      d.run(file, args);
      say(`sent ${level} (${why})`);
    };
    if (!d.notifyNative) return fallback();
    void d.notifyNative(payload).then((accepted) => {
      if (accepted) say(`dispatched ${level} via native app (${why})`);
      else fallback();
    }).catch((err: unknown) => {
      say(`native delivery failed: ${String(err)}; using daemon fallback`);
      fallback();
    });
  };
  const summarize = (id: string, now: number, completionEvent = false) => {
    const tree = d.tree(id);
    const root = tree[0] ?? d.view(id);
    if (!root || !d.config(root.id).treeDoneSummary) return;
    const agents = tree.filter((v) => isAgentKind(v.kind));
    if (!agents.length) return;
    let complete = true, newWork = false;
    for (const v of agents) {
      const prev = observed.get(v.id);
      // setOutcome replaces the outcome object. A retained report cannot finalize a later gate attempt.
      const outcomeBeforeGate = v.gate === 'running' && prev?.gate !== 'running' ? v.outcome : prev?.outcomeBeforeGate;
      const freshOutcome = !!v.outcome && v.outcome !== outcomeBeforeGate;
      const gateFinal = !v.gate || (freshOutcome && (v.gate === 'passed' || v.outcome?.outcome === 'failed'));
      // A passed gate emits before its report is stored, including when the agent has already exited.
      const gatePending = !gateFinal && (v.gate === 'passed' || !v.status.exited);
      if (v.pending || v.gate === 'running' || (!v.status.exited && (
        ['working', 'waiting', 'blocked', 'armed', 'queued'].includes(v.status.state)
        || (v.status.state === 'unknown' && (!prev || prev.sessionId !== v.sessionId || prev.exited))
      ))) newWork = true;
      if (v.pending || v.gate === 'running' || gatePending || !finished(v.status)) complete = false;
      observed.set(v.id, { sessionId: v.sessionId, exited: !!v.status.exited, gate: v.gate, outcomeBeforeGate });
    }
    if (newWork) {
      announced.delete(root.id);
      active.add(root.id);
    }
    if (!complete) return;
    if (announced.has(root.id) || (!completionEvent && !active.has(root.id))) return;
    announced.add(root.id);
    active.delete(root.id);
    const bad = agents.filter(failed).length;
    post(root.id, 'done', 'tree', { title: root.title, body: `tree ${root.title} finished: ${agents.length - bad} succeeded, ${bad} failed` }, now);
  };
  const notify = (n: NotifyEvent) => {
    const node = d.view(n.id);
    if (!node) return;
    const now = (d.now ?? Date.now)();
    summarize(n.id, now, n.kind !== 'needsYou' && isAgentKind(node.kind));
    const root = d.tree(n.id)[0] ?? node;
    if (d.config(root.id).treeDoneSummary && (n.kind === 'done' || n.kind === 'exited') && isAgentKind(node.kind)) {
      return log(`notify ${n.id} ${n.kind}: suppressed (treeDoneSummary)`);
    }
    post(n.id, n.kind, n.kind, content(node, n.kind, root.title), now);
  };
  /** An approval request is not about one node: it has no mute or throttle, is skipped while a focused window shows the modal, has its own banner group, and the project config is the home one. */
  let approvals = 0;
  const approval = (text: string) => post(`${APPROVAL_ID}-${++approvals}`, 'approval', 'approval', { title: 'Approval needed', body: firstLine(text) }, (d.now ?? Date.now)());
  const recheck = (node: NodeView) => summarize(node.id, (d.now ?? Date.now)());
  // Working, pending, restart and gate transitions do not emit notification events.
  const observe = (node: NodeView) => {
    const inputs = summaryInputs(node), prev = seen.get(node.id);
    seen.set(node.id, inputs);
    if (!prev?.every((x, i) => x === inputs[i])) recheck(node);
  };
  const forget = (id: string) => {
    for (const k of last.keys()) if (k.startsWith(`${id}:`)) last.delete(k);
    seen.delete(id);
    observed.delete(id);
    announced.delete(id);
    active.delete(id);
  };
  return Object.assign(notify, { observe, recheck, forget, approval });
}

/** First executable named `name` on `path`, else undefined. */
export function findBin(name: string, path: string): string | undefined {
  return path.split(delimiter).map((dir) => join(dir, name)).find((f) => existsSync(f));
}

export const runDetached = (file: string, args: string[]) => { execFile(file, args, (error) => { if (error) console.error(`notification fallback failed (${file}): ${error.message}`); }).unref(); };
