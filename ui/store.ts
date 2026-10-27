import { useSyncExternalStore } from 'react';
import type { ArchivedNode, ClaudeAccountView, ClaudeMemoryView, Conversation, ConversationSummary, InstalledReleaseNotes, Diff, DigestItem, Dnd, Drain, MemoryAction, MemoryInjectionView, MemoryItemDetail, MemoryPage, MemoryTarget, ServerMessage, Transcript, UpdateStatus, Usage, UsageSource } from '../src/shared/protocol';
import type { ReviewComment } from './diff';
import { pickInitial, rootOf } from './sidebar/sessions';
import { insertSorted, type Nodes } from './sidebar/tree';
import { wantedNode } from './url';

export type Tone = 'info' | 'ok' | 'warn' | 'bad';
export interface Toast { id: number; text: string; nodeId?: string; tone: Tone }
export interface Activity { id: number; nodeId?: string; nodeName: string; at: number; text: string; tone: Tone; read: boolean }
export const ACTIVITY_LIMIT = 200;
/** Newest first; the oldest events expire, including their unread state. */
export const appendActivity = (items: Activity[], item: Activity): Activity[] => [item, ...items].slice(0, ACTIVITY_LIMIT);
export const activityUnread = (items: Activity[]) => items.filter((item) => !item.read).length;
export interface Confirm { confirmId: string; text: string }
/** A memory reply slot: the latest request's rid; data stays while a refresh is out, so the view does not flicker. */
export interface MemoryReply<T> { rid: number; data?: T; error?: string }
export type MemorySlot = 'memory' | 'memoryItem' | 'memoryGiven' | 'claudeMemory';
export type Dialog =
  | { kind: 'spawn'; parentId: string | null; cwd: string }
  | { kind: 'kill'; id: string }
  | { kind: 'restart'; id: string }
  | { kind: 'changeHarness'; id: string }
  | { kind: 'followup'; id: string; title: string }
  /** Spawn a Claude node that starts from `from`'s conversation (a live or archived node). */
  | { kind: 'fork'; from: string; title: string; cwd: string; parentId: string | null }
  | { kind: 'palette' }
  | { kind: 'update' }
  | { kind: 'whatsNew'; notes: InstalledReleaseNotes };

export interface Renaming { id: string; at: 'title' | 'row' | 'session' }

export interface State {
  nodes: Nodes;
  order: string[];
  selected: string | null;
  /** Root of the selected node's tree: the session shown in the sidebar. */
  session: string | null;
  /** Nodes that have a mounted terminal. */
  opened: string[];
  collapsed: string[];
  toasts: Toast[];
  confirms: Confirm[];
  activity: Activity[];
  activityOpen: boolean;
  connected: boolean;
  /** Reconnect attempts since the last successful connection. */
  retry: number;
  panel: boolean;
  dialog: Dialog | null;
  /** Node whose title is being edited inline, and the one surface showing the editor: the selected node appears in both its row and the title bar. */
  renaming: Renaming | null;
  /** A spawn was requested: select the next new node that arrives. */
  awaitSpawn: boolean;
  /** Do not disturb, as the daemon last reported it. */
  dnd?: Dnd;
  /** Account-level rate limits, as the newest node report gave them. */
  usage?: Usage;
  update?: UpdateStatus;
  /** A daemon restart waiting for agents to finish their turns. */
  drain?: Drain;
  usageSources?: UsageSource[];
  usageScanning?: boolean;
  /** Configured Claude accounts with their login state, as the last claudeAccounts reply gave them; absent until one arrives. */
  claudeAccounts?: ClaudeAccountView[];
  /** What happened while no client was focused, until dismissed. */
  digest?: { since: number; items: DigestItem[] };
  /** The Diff tab is showing instead of the terminal (for worktree nodes). */
  diffOpen: boolean;
  /** The last diff asked for; data stays while a refresh is out, so the view does not flicker. */
  diff: { id: string; data?: Diff; error?: string } | null;
  /** Review comments not sent yet, for any node. */
  comments: ReviewComment[];
  /** The Transcript tab is showing instead of the terminal (for Claude nodes). */
  transcriptOpen: boolean;
  /** The last transcript asked for (no sessionId: the node's current session); data stays while a refresh is out. */
  transcript: { id: string; sessionId?: string; data?: Transcript; error?: string } | null;
  /** The Transcript tab shows tool calls (per viewer, remembered). */
  showTools: boolean;
  /** The last conversation list asked for; items stay while a refresh is out. */
  conversations: { id: string; items?: ConversationSummary[]; error?: string } | null;
  /** The last conversation asked for: the upward conversation of `id`, or its peer conversation with `with`. */
  conversation: { id: string; with?: string; data?: Conversation; error?: string } | null;
  /** The sidebar shows closed nodes instead of the tree. */
  historyOpen: boolean;
  /** The last history reply. */
  history: ArchivedNode[];
  /** The closed node shown in the main pane, over the selected live node. */
  archived: ArchivedNode | null;
  /** Counts `removed` messages, so an open history asks again when a node is closed. */
  removals: number;
  /** The Memory tab is showing instead of the terminal (for agent nodes). */
  memoryOpen: boolean;
  /** The Memory pane opened from the sidebar footer or a closed node, shown in the main pane over the selected node. */
  memoryView: MemoryTarget | null;
  /** The closed node whose pane opened the memory view; closing the view shows it again. */
  memoryBack: ArchivedNode | null;
  /** Memory panel replies, each kept only when its rid is the latest asked for. more: a Load more, appended to the page. */
  memory: (MemoryReply<MemoryPage> & { more?: boolean }) | null;
  memoryItem: MemoryReply<MemoryItemDetail> | null;
  memoryGiven: MemoryReply<MemoryInjectionView[]> | null;
  claudeMemory: MemoryReply<ClaudeMemoryView> | null;
  /** Counts the human's memory action replies, so the open pane asks again. */
  memoryRev: number;
  /** The latest action reply: its rid and whether it succeeded. */
  memoryActed: { rid: number; ok: boolean } | null;
}

const stored = (() => { try { return localStorage.getItem('tl.panel') === '1'; } catch { return false; } })();
const storedTools = (() => { try { return localStorage.getItem('tl.showTools') === '1'; } catch { return false; } })();

let state: State = {
  nodes: {}, order: [], selected: null, session: null, opened: [], collapsed: [], toasts: [], confirms: [], activity: [], activityOpen: false,
  connected: false, retry: 0, panel: stored, dialog: null, renaming: null, awaitSpawn: false, diffOpen: false, diff: null, comments: [],
  transcriptOpen: false, transcript: null, showTools: storedTools, conversations: null, conversation: null, historyOpen: false, history: [], archived: null, removals: 0,
  memoryOpen: false, memoryView: null, memoryBack: null, memory: null, memoryItem: null, memoryGiven: null, claudeMemory: null, memoryRev: 0, memoryActed: null,
};
const subs = new Set<() => void>();
let toastSeq = 0;
let activitySeq = 0;

export const getState = () => state;
export function update(fn: (s: State) => Partial<State>) {
  state = { ...state, ...fn(state) };
  subs.forEach((f) => f());
}
const subscribe = (f: () => void) => (subs.add(f), () => void subs.delete(f));
export function useStore<T>(sel: (s: State) => T): T {
  return useSyncExternalStore(subscribe, () => sel(state));
}

const without = <T,>(xs: T[], x: T) => xs.filter((y) => y !== x);

export const toast = (text: string, nodeId?: string, tone: Tone = 'info') =>
  update((s) => ({ toasts: [...s.toasts, { id: ++toastSeq, text, nodeId, tone }] }));
export const recordActivity = (text: string, nodeId?: string, tone: Tone = 'info', at = Date.now()) =>
  update((s) => ({ activity: appendActivity(s.activity, {
    id: ++activitySeq, nodeId, nodeName: (nodeId && s.nodes[nodeId]?.title) || nodeId || 'Tiller', at, text, tone, read: false,
  }) }));
export const markActivityRead = () => update((s) => ({ activity: s.activity.map((item) => item.read ? item : { ...item, read: true }) }));
export const clearActivity = () => update(() => ({ activity: [] }));
export const setActivityOpen = (activityOpen: boolean) => update((s) => ({
  activityOpen,
  ...(activityOpen ? { activity: s.activity.map((item) => item.read ? item : { ...item, read: true }) } : {}),
}));
export const dismissToast = (id: number) => update((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }));
export const dropConfirm = (confirmId: string) => update((s) => ({ confirms: s.confirms.filter((c) => c.confirmId !== confirmId) }));
export const setConnected = (connected: boolean, retry = 0) => update(() => ({ connected, retry, ...(!connected ? { usageScanning: false } : {}) }));
export const openDialog = (dialog: Dialog | null) => update(() => ({ dialog }));
export const dismissDigest = () => update(() => ({ digest: undefined }));
export const setRenaming = (renaming: Renaming | null) => update(() => ({ renaming }));
export const expectSpawn = () => update(() => ({ awaitSpawn: true }));
export const toggleCollapsed = (id: string) =>
  update((s) => ({ collapsed: s.collapsed.includes(id) ? without(s.collapsed, id) : [...s.collapsed, id] }));
export const togglePanel = () => update((s) => {
  try { localStorage.setItem('tl.panel', s.panel ? '0' : '1'); } catch { /* per-viewer convenience only */ }
  return { panel: !s.panel };
});
export const toggleShowTools = () => update((s) => {
  try { localStorage.setItem('tl.showTools', s.showTools ? '0' : '1'); } catch { /* per-viewer convenience only */ }
  return { showTools: !s.showTools };
});

/** What the stage shows for a live node. */
export const showPane = (pane: 'terminal' | 'diff' | 'transcript' | 'memory') =>
  update(() => ({ diffOpen: pane === 'diff', transcriptOpen: pane === 'transcript', memoryOpen: pane === 'memory' }));
/** Note that a diff for `id` was asked for; conn.ts sends the request. */
export const diffRequested = (id: string) => update((s) => ({ diff: s.diff?.id === id ? s.diff : { id } }));
/** Note that a transcript for `id` (and `sessionId`, else the current one) was asked for; the caller sends the request. */
export const transcriptRequested = (id: string, sessionId?: string) =>
  update((s) => ({ transcript: s.transcript?.id === id && s.transcript.sessionId === sessionId ? s.transcript : { id, sessionId } }));
/** Note that `id`'s conversation list was asked for; the caller sends the request. */
export const conversationsRequested = (id: string) =>
  update((s) => ({ conversations: s.conversations?.id === id ? s.conversations : { id } }));
/** Note that a conversation was asked for; the caller sends the request. */
export const conversationRequested = (id: string, peer?: string) =>
  update((s) => ({ conversation: s.conversation?.id === id && s.conversation.with === peer ? s.conversation : { id, with: peer } }));
export const toggleHistory = () => update((s) => ({ historyOpen: !s.historyOpen }));
export const viewArchived = (archived: ArchivedNode | null) => update(() => ({ archived, memoryView: null }));
/** Open the memory view (from `back`, a closed node's pane, if given), or close it and show `back` again. */
export const viewMemory = (memoryView: MemoryTarget | null, back: ArchivedNode | null = null) => update((s) => (memoryView
  ? { memoryView, archived: null, memoryBack: back }
  : s.memoryView ? { memoryView: null, archived: s.memoryBack, memoryBack: null } : {}));

let memoryRid = 0;
/** The last memory rid handed out: a pane opened now shows only replies to later requests, not another pane's. */
export const lastMemoryRid = () => memoryRid;
const actionKinds = new Map<number, MemoryAction['kind']>();
const ACTION_DONE: Record<MemoryAction['kind'], string> = { pin: 'Pinned', pinText: 'Pinned', unpin: 'Unpinned', editPin: 'Edited', forget: 'Forgot', restore: 'Restored' };
/**
 * Note a memory request for `slot` and return its rid; the caller sends it. An older reply for the slot is then dropped.
 * The data shown stays until the reply when it answered a request after `since` (the asking pane's own), else it goes.
 */
export function memoryRequested(slot: MemorySlot, since: number, more = false): number {
  const rid = ++memoryRid;
  update((s) => ({ [slot]: { rid, data: (s[slot]?.rid ?? 0) > since ? s[slot]?.data : undefined, ...(slot === 'memory' && { more }) } }));
  return rid;
}
/** Note the human's memory action and return its rid; the caller sends it. Its reply toasts and makes the pane ask again. */
export function memoryActionRequested(kind: MemoryAction['kind']): number {
  actionKinds.set(++memoryRid, kind);
  return memoryRid;
}
export const addComment = (c: ReviewComment) => update((s) => ({ comments: [...s.comments, c] }));
export const removeComment = (c: ReviewComment) => update((s) => ({ comments: without(s.comments, c) }));
export const clearComments = (nodeId: string) => update((s) => ({ comments: s.comments.filter((c) => c.nodeId !== nodeId) }));

/** Selection patch: selects `id` (and so its session), mounts its terminal, and clears unread locally (the daemon clears it on `select`). */
function choose(s: State, nodes: Nodes, id: string | null): Partial<State> {
  const n = id ? nodes[id] : undefined;
  if (!id || !n) return { nodes, selected: null, session: null };
  return {
    nodes: n.unread ? { ...nodes, [id]: { ...n, unread: false } } : nodes,
    selected: id,
    session: rootOf(nodes, id),
    opened: s.opened.includes(id) ? s.opened : [...s.opened, id],
  };
}

export const selectNode = (id: string) => update((s) => (s.nodes[id] ? { archived: null, memoryView: null, ...choose(s, s.nodes, id) } : {}));

/** Switching session selects its root. */
export const selectSession = (rootId: string) => update((s) => (s.session === rootId ? {} : { archived: null, memoryView: null, ...choose(s, s.nodes, rootId) }));

/** Reducer for server messages that change state (data/notify are handled by conn.ts). */
export function applyServer(m: ServerMessage) {
  switch (m.t) {
    case 'snapshot':
      return update((s) => {
        const nodes = Object.fromEntries(m.nodes.map((n) => [n.id, n]));
        let order = s.order.filter((id) => nodes[id]);
        const fresh = m.nodes.filter((n) => !order.includes(n.id)).sort((a, b) => b.status.changedAt - a.status.changedAt);
        for (const n of fresh) order = insertSorted(order, nodes, n);
        const base = { ...s, order, opened: s.opened.filter((id) => nodes[id]) };
        const sel = s.selected && nodes[s.selected] ? s.selected : pickInitial(nodes, order, s.selected ? undefined : wantedNode);
        return { order, opened: base.opened, update: m.update, usage: m.usage ?? s.usage, usageSources: m.usageSources ?? s.usageSources, dnd: m.dnd, drain: m.drain, ...choose(base, nodes, sel) };
      });
    case 'update':
      if (m.update.failed && m.update.failed !== state.update?.failed) toast(m.update.failed, undefined, 'bad');
      return update(() => ({ update: m.update }));
    case 'dnd':
      return update(() => ({ dnd: { on: m.on, until: m.until } }));
    case 'drain':
      return update(() => ({ drain: m.drain }));
    case 'usageSources':
      return update(() => ({ usageSources: m.sources, usageScanning: false }));
    case 'usage':
      return update(() => ({ usage: m.usage }));
    case 'claudeAccounts':
      return update(() => ({ claudeAccounts: m.accounts }));
    case 'node':
      return update((s) => {
        const isNew = !s.order.includes(m.node.id);
        const nodes = { ...s.nodes, [m.node.id]: m.node };
        const order = isNew ? insertSorted(s.order, s.nodes, m.node) : s.order;
        // The selected node is being looked at, so it never shows as unread.
        if (s.selected === m.node.id) nodes[m.node.id] = { ...m.node, unread: false };
        if (isNew && s.awaitSpawn) return { order, awaitSpawn: false, archived: null, memoryView: null, ...choose(s, nodes, m.node.id) };
        return { nodes, order };
      });
    case 'removed':
      return update((s) => {
        const { [m.id]: gone, ...nodes } = s.nodes;
        const order = without(s.order, m.id);
        const base = { ...s, opened: without(s.opened, m.id) };
        const next = s.selected !== m.id ? s.selected : gone?.parentId && nodes[gone.parentId] ? gone.parentId : pickInitial(nodes, order);
        return { order, opened: base.opened, removals: s.removals + 1, ...choose(base, nodes, next) };
      });
    case 'focus':
      return update((s) => ((m.from === 'human' || s.selected === m.from) && s.nodes[m.id] ? choose(s, s.nodes, m.id) : {}));
    case 'confirm':
      return update((s) => ({ confirms: [...s.confirms, { confirmId: m.confirmId, text: m.text }] }));
    case 'confirmDone':
      return dropConfirm(m.confirmId);
    case 'diff': {
      const { t: _, id, ...data } = m;
      return update((s) => (s.diff?.id === id ? { diff: 'error' in data ? { id, error: data.error } : { id, data } } : {}));
    }
    case 'transcript': {
      const { t: _, id, sessionId, ...data } = m;
      return update((s) => {
        const want = s.transcript;
        // A request without a session is answered for the current one, whether or not the reply names it.
        const current = 'sessions' in data ? data.sessions.find((x) => x.current)?.sessionId : undefined;
        const liveSession = s.nodes[id]?.sessionId;
        // The response may have begun reading before the live node changed harness/session.
        // Reject its old session list even for an explicitly selected historical segment.
        if (current && liveSession && current !== liveSession) return {};
        if (want?.id !== id || (want.sessionId !== sessionId && !(want.sessionId === undefined && sessionId === current))) return {};
        return { transcript: 'error' in data ? { id, sessionId: want.sessionId, error: data.error } : { id, sessionId: want.sessionId, data } };
      });
    }
    case 'conversations': {
      const { t: _, id, ...data } = m;
      return update((s) => (s.conversations?.id === id ? { conversations: { id, ...data } } : {}));
    }
    case 'conversation': {
      const { t: _, id, with: peer, ...data } = m;
      return update((s) => {
        const want = s.conversation;
        if (want?.id !== id || want.with !== peer) return {};
        return { conversation: 'error' in data ? { id, with: peer, error: data.error } : { id, with: peer, data } };
      });
    }
    case 'history':
      return update(() => ({ history: m.items }));
    case 'memory': {
      const { t: _, rid, ...data } = m;
      return update((s) => {
        const want = s.memory;
        if (want?.rid !== rid) return {};
        // An error keeps the page shown, so its pickers stay to correct a bad target.
        if ('error' in data) return { memory: { rid, error: data.error, data: want.data } };
        return { memory: { rid, data: want.more && want.data ? { ...data, items: [...want.data.items, ...data.items] } : data } };
      });
    }
    case 'memoryItem': {
      const { t: _, rid, ...data } = m;
      return update((s) => (s.memoryItem?.rid !== rid ? {} : { memoryItem: 'error' in data ? { rid, error: data.error } : { rid, data } }));
    }
    case 'memoryGiven':
      return update((s) => (s.memoryGiven?.rid !== m.rid ? {} : { memoryGiven: 'error' in m ? { rid: m.rid, error: m.error } : { rid: m.rid, data: m.injections } }));
    case 'claudeMemory': {
      const { t: _, rid, ...data } = m;
      return update((s) => (s.claudeMemory?.rid !== rid ? {} : { claudeMemory: 'error' in data ? { rid, error: data.error } : { rid, data } }));
    }
    case 'memoryAction': {
      const kind = actionKinds.get(m.rid);
      actionKinds.delete(m.rid);
      if ('error' in m) toast(`Memory not changed: ${m.error}`, undefined, 'bad');
      else toast(`${kind ? ACTION_DONE[kind] : 'Changed'} m${m.item.id}`, undefined, 'ok');
      return update((s) => ({ memoryRev: s.memoryRev + 1, memoryActed: { rid: m.rid, ok: !('error' in m) } }));
    }
    case 'sent': {
      const title = state.nodes[m.id]?.title ?? m.id;
      const { outcome, detail } = m.result;
      if (outcome !== 'delivered' && outcome !== 'queued') return toast(`Not sent to ${title}: ${outcome}${detail ? ` (${detail})` : ''}`, m.id, 'bad');
      clearComments(m.id);
      return toast(outcome === 'queued' ? `Queued for ${title}; it arrives when the node is idle` : `Sent to ${title}`, m.id, 'ok');
    }
    case 'error':
      if (state.usageScanning) update(() => ({ usageScanning: false }));
      // A spawn or follow-up that failed answers only with an error: stop waiting, or the next node anyone spawns gets selected.
      if (state.awaitSpawn) update(() => ({ awaitSpawn: false }));
      recordActivity(m.message, m.id, 'bad');
      return toast(m.message, m.id, 'bad');
    case 'digest':
      return update(() => ({ digest: { since: m.since, items: m.items } }));
  }
}
