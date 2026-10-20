import { fmtAge, outcomeLine, shortEffort, shortModel, usageLine } from '../shared/format.js';
import { randomBytes } from 'node:crypto';
import { chmodSync, readFileSync, writeFileSync } from 'node:fs';
import type http from 'node:http';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import { dndActive, EFFORTS, finished, ISOLATIONS, NODE_KINDS, ROLES, type ArchivedNode, type Diff, type Dnd, type NodeView, type Outcome } from '../shared/protocol.js';
import { updateLine, type Updater } from './update.js';
import { fmtUsd, subtreeSpend } from '../shared/spend.js';
import { treeOrder } from '../shared/tree.js';
import { loadConfig, type Config } from './config.js';
import { ADMIN_TOKEN_FILE } from './home.js';
import { findArchived, history } from './archive.js';
import type { NodeManager } from './manager.js';
import { closeRefusal, type WorktreeReport } from './worktree-lifecycle.js';
import { MAX_PATCH_BYTES, MergeConflict } from './worktree.js';
import { PERMISSION_MODES } from './presets.js';
import { SPAWN_FIELDS } from './spawnfields.js';
import { readMessages, renderMessage, sessionMessages } from './transcript.js';
import { DAEMON, deliver, HUMAN, inScope, isDescendant, messageStatus, notifyWhen, QUEUE_CAP, QUEUE_TTL_MS, RATE_MS, startNotices, withdraw } from './messaging.js';
import { logError, PREVIEW_CHARS, readBody, safeEqual } from './util.js';

const MAX_WRITE_CHARS = 2000;
const IDEMPOTENCY_MS = 24 * 3600_000;
const TRANSCRIPT_CAP = 200_000;
const HISTORY_LINES = 50;

/** dnd sets do not disturb when `on` is given, and returns it. */
interface Ctx { updates?: Updater; manager: NodeManager; confirm: (text: string) => Promise<boolean>; focus: (from: string, id: string) => void; dnd: (on?: boolean, minutes?: number) => Dnd; caller: string }
interface Out { text?: string; data?: unknown }

/** How long report_outcome waits for a completion gate before replying that it is still running. */
const GATE_REPLY_MS = 30_000;

// ---- helpers ----

function flags(v: NodeView): string[] {
  const s = v.status;
  return (['errored', 'interrupted', 'exited', 'stale', 'stalled'] as const).filter((f) => s[f]);
}

function summarize(v: NodeView, now: number, all: NodeView[]) {
  return {
    id: v.id, parentId: v.parentId, title: v.title, kind: v.kind, ...(v.harness ? { harness: v.harness } : {}), cwd: v.cwd, state: v.status.state, flags: flags(v), exited: !!v.status.exited, createdAt: v.createdAt,
    age: fmtAge(now - v.createdAt), activity: v.status.activity, lastAssistantMessage: v.status.lastAssistantMessage?.slice(0, PREVIEW_CHARS),
    outcome: v.outcome, gate: v.gate, preset: v.preset, profile: v.profile, role: v.role,
    model: v.status.model, effort: v.status.effort, contextPct: v.status.contextPct, contextTokens: v.status.contextTokens, contextWindow: v.status.contextWindow, costUsd: v.status.costUsd,
    spentUsd: v.spentUsd, subtreeSpentUsd: subtreeSpend(all, v.id),
    worktree: v.worktree && worktreeSummary(v),
  };
}

function worktreeSummary(v: NodeView) {
  const w = v.worktree!, g = v.status.git;
  return { path: w.path, branch: w.branch, base: w.base, ahead: g?.ahead, behind: g?.behind, dirty: g?.dirty, missing: !!w.missing, merged: !!g?.mergedAt };
}

/** `⎇ tl/n-3f2a ↑3 ↓1 dirty merged` for the tree line. */
function branchText(w: ReturnType<typeof worktreeSummary>): string {
  return [`⎇ ${w.branch}`, w.ahead && `↑${w.ahead}`, w.behind && `↓${w.behind}`, w.dirty && 'dirty', w.merged && 'merged', w.missing && '(worktree missing)'].filter(Boolean).join(' ');
}

function modelInfo(n: ReturnType<typeof summarize>): string {
  const me = [n.profile && `profile ${n.profile}`, n.preset && `preset ${n.preset}`, n.model && shortModel(n.model), n.effort && shortEffort(n.effort)].filter(Boolean).join(' ');
  const own = n.spentUsd ?? 0;
  const spend = n.subtreeSpentUsd ? fmtUsd(own) + (n.subtreeSpentUsd > own ? ` (tree ${fmtUsd(n.subtreeSpentUsd)})` : '') : '';
  return [me, n.contextPct !== undefined && `ctx ${Math.round(n.contextPct)}%`, spend].filter(Boolean).map((p) => ` · ${p}`).join('');
}

function tree(nodes: ReturnType<typeof summarize>[]): string {
  return treeOrder(nodes).map(({ node: n, depth }) => {
    const reported = n.outcome && `reported ${outcomeLine(n.outcome)}`;
    const extra = [...n.flags, n.activity, reported].filter(Boolean).join(', ');
    const branch = n.worktree ? ` ${branchText(n.worktree)}` : '';
    return `${'  '.repeat(depth)}- ${n.id} "${n.title}" [${n.kind}] ${n.state}${extra ? ` (${extra})` : ''} ${n.age}${modelInfo(n)}${branch}`;
  }).join('\n') || '(no nodes)';
}

/** `tl worktrees` output: one section per kind, with the commits and files a clean removed. */
function worktreeText(r: WorktreeReport): string {
  const unmerged = (n: number) => (n ? `, ${n} unmerged commit(s)` : '');
  const out = [
    ...r.nodes.map((n) => `node ${n.nodeId} "${n.title}" ${n.branch} from ${n.base} at ${n.path}${n.missing ? ' (missing)' : ''}`),
    ...r.orphans.map((o) => `orphan ${o.path} ${o.branch ?? '(detached)'} from ${o.base}${o.dirty.length ? `, ${o.dirty.length} uncommitted file(s)` : ''}${unmerged(o.unmerged.length)}${o.error ? ` (not removed: ${o.error})` : ''}`),
    ...r.kept.map((k) => `kept branch ${k.branch} in ${k.repo}${unmerged(k.unmerged.length)}`),
    ...r.removed.flatMap((x) => [`removed ${x.what}`, ...x.commits.map((c) => `  commit ${c}`), ...x.files.map((f) => `  file ${f}`)]),
  ];
  return out.join('\n') || '(no tiller worktrees)';
}

/** `tl diff` output: a summary line, then one line per file (stat) or each file's patch. */
function diffText(d: Diff, stat: boolean): string {
  const counts = (x: { additions: number; deletions: number }) => `+${x.additions} −${x.deletions}`;
  const total = d.files.reduce((t, f) => ({ additions: t.additions + f.additions, deletions: t.deletions + f.deletions }), { additions: 0, deletions: 0 });
  const head = `${d.branch} against ${d.base}: ${d.files.length} file(s), ${counts(total)}`;
  const body = d.files.map((f) => {
    const line = `${counts(f)}\t${f.path} (${f.status}${f.binary ? ', binary' : ''})`;
    return stat || !f.patch ? line : f.patch.trimEnd();
  });
  const tail = d.truncated ? [`(patches stop after ${MAX_PATCH_BYTES >> 20} MB; later files show counts only)`] : [];
  return [head, ...body, ...tail].join('\n');
}

function requireNode(m: NodeManager, id: string): NodeView {
  const v = m.view(id);
  if (!v) throw new Error(`no such node: ${id}`);
  return v;
}

function requireScope(c: Ctx, id: string): NodeView {
  const v = requireNode(c.manager, id);
  if (!inScope(c.manager, c.caller, id)) throw new Error(`refused: ${id} is outside your lineage (self, ancestors, siblings, descendants)`);
  return v;
}

const rootOf = (c: Ctx) => c.manager.rootIdOf(c.caller);

/** An archived node of the caller's own tree; any tree for the human. */
async function requireArchived(c: Ctx, id: string): Promise<ArchivedNode> {
  const a = await findArchived(c.manager.home, id, c.caller === HUMAN ? undefined : rootOf(c));
  if (!a) throw new Error(`no such node: ${id}`);
  if (c.caller !== HUMAN && a.rootId !== rootOf(c)) throw new Error(`refused: archived node ${id} is not of your own tree`);
  return a;
}

/** `n-x "title" closed 2h ago: succeeded: ... (merged into main) ⎇ tl/n-x $0.42` for the history tool. */
function historyLine(a: ArchivedNode, now: number): string {
  const age = fmtAge(now - a.closedAt);
  return [`${a.id} "${a.title}" closed ${age === 'now' ? 'just now' : `${age} ago`}${a.brief ? `: ${a.brief}` : ''}`, a.branch && `⎇ ${a.branch}`, a.spentUsd && fmtUsd(a.spentUsd)].filter(Boolean).join(' ');
}

const requireOwned = (c: Ctx, id: string, allowSelf: boolean): NodeView => {
  const v = requireNode(c.manager, id);
  if (c.caller !== HUMAN && !(allowSelf && id === c.caller) && !isDescendant(c.manager, c.caller, id)) {
    throw new Error(`refused: ${id} is not ${allowSelf ? 'you or ' : ''}one of your descendants`);
  }
  return v;
};

const who = (c: Ctx) => (c.caller === HUMAN ? 'The user' : `Node ${c.manager.view(c.caller)!.title} (${c.caller})`); // authenticate() guarantees the view

/**
 * Run the completion gate for a "succeeded" report. Passing records the outcome; the last failure records it as failed,
 * which tells the parent. Resolves with the report_outcome reply; a failure is also sent to the worker as a message when
 * `late()` says the reply already went out as "pending".
 */
async function runGate(m: NodeManager, id: string, gate: NonNullable<Config['gate']>, report: Omit<Outcome, 'at' | 'gate'>, late: () => boolean): Promise<Out> {
  const { ok, tail, failures } = await m.runGate(id, gate);
  const v = m.view(id);
  if (!v) return { data: { ok: false } }; // closed meanwhile
  if (ok) {
    m.setOutcome(id, { ...report, gate: 'passed', at: Date.now() });
    return { text: `Completion gate passed: ${gate.command}. Your outcome is recorded.`, data: { ok: true, gate: 'passed' } };
  }
  const total = gate.retries + 1, left = Math.max(0, total - failures);
  const head = `Completion gate failed (attempt ${failures} of ${total}): ${gate.command}\n${tail}`;
  if (!left) m.setOutcome(id, { ...report, outcome: 'failed', gate: 'failed', at: Date.now() });
  const text = left ? `${head}\nFix it and call report_outcome again.` : `${head}\nNo attempts left: your outcome is recorded as failed${v.parentId ? ' and your parent was told' : ''}.`;
  if (late()) deliver(m, DAEMON, id, text, { fromLabel: 'tiller (completion gate)', replyTo: null }).catch(logError);
  return { text, data: { ok: false, gate: 'failed', attemptsLeft: left } };
}

// ---- tools ----

/** humanOnly: refused to agents over /api and not listed to them over MCP. */
function tool<S extends z.ZodRawShape>(title: string, description: string, shape: S, run: (c: Ctx, a: z.infer<z.ZodObject<S>>) => Promise<Out>, humanOnly = false) {
  return { title, description, shape, run: run as (c: Ctx, a: never) => Promise<Out>, humanOnly };
}

const spawned = new Map<string, { args: string; result: unknown; at: number }>();

const tools = {
  list_nodes: tool(
    'List nodes',
    `List the nodes you can see (yourself, your ancestors, siblings and descendants) as an indented tree plus JSON. The text starts with one line of account-level Claude usage (5-hour and 7-day rate-limit windows, percent used and reset time), which every node draws on. Each node has id, parentId, title, kind (claude, agent or terminal), harness (claude, pi or codex on generic agent nodes), cwd, state (working, waiting, blocked, done, unknown, none; armed: waiting on spawn dependencies, queued: waiting on daemon.maxWorking, with the reason in activity),flags (errored, interrupted, exited, stale, stalled: working with no hook event for limits.stallMinutes), age, current activity, its last assistant message truncated to ${PREVIEW_CHARS} characters, the outcome it reported through report_outcome, if any ({ outcome, note, summary, changedFiles, verified, openQuestions, gate }: read these before calling read on a finished worker), gate (its completion gate: running, passed or failed), spentUsd (its total spend across sessions) and subtreeSpentUsd (with all its descendants), and for a node with its own git worktree, worktree { path, branch, base, ahead, behind, dirty, missing, merged }: its commits not yet in base, base's commits not on the branch, the count of uncommitted files, and whether merge has merged it. Use it to find node ids before calling send, read or close.`,
    {},
    async (c) => {
      const all = c.manager.list();
      const nodes = all.filter((v) => inScope(c.manager, c.caller, v.id)).map((v) => summarize(v, Date.now(), all));
      return { text: `${usageLine(c.manager.usage)}\n${tree(nodes)}`, data: nodes };
    }),

  spawn: tool(
    'Start node',
    'Open a new node as a child of yourself and return its id. kind "claude" starts Claude Code; kind "agent" starts the selected `harness` (claude, pi or codex), inheriting your harness when omitted; kind "terminal" starts a login shell. `cwd` must be an existing directory. Spawning never changes what the user is looking at. `role` picks the role prompt the node gets: "orchestrator", "worker" or "none"; by default a node you spawn is a worker. `profile` selects task guidance independently of role: orchestrator, implementation, explorer, mechanical or reviewer; defaults follow the effective coordination role (orchestrator maps to orchestrator, worker/none to implementation). Omit `model` and `effort` to use per-harness profile config, then legacy Claude role config. Explicit arguments win over presets, which win over config. Explorer and reviewer profiles provide portable read-only instructions; they do not enforce tool restrictions. Claude children inherit a same-harness parent permissionMode when omitted. Pi and Codex reject permissionMode and presets with maxTurns; Pi enforces preset tools/disallowedTools with its own tool flags and rejects tool names it cannot translate, and Codex rejects presets with tools/disallowedTools, rather than ignoring restrictions. isolation "worktree" (agent nodes only) gives the child its own git worktree at <main checkout>/.claude/worktrees/<id> on a new branch from its base, which needs a repo with a commit (Claude also requires its own workspace trust), and the reply then carries worktree { path, branch, base }. `base` (worktree isolation only) names the branch the child forks from and is merged back into; it is created at the HEAD of the checkout `cwd` is in when it does not exist. Pass the same base to every worker of one task so their merges accumulate on it. Without base, the base is the branch checked out at `cwd`, unless that is protected (worktrees.protected, default main and master, plus origin\'s default branch) or detached: then a new branch named by worktrees.taskBranch (default "tl/{slug}" from the title) is created for it. Omitting isolation uses the project config (default "none"), so a child whose cwd is inside an existing worktree shares that tree. `preset` names a spawn preset (.tiller/agents/<name>.md in the main checkout of `cwd`, else ~/.tiller/agents/<name>.md; built-in: "reviewer", "researcher"): it sets the role text, model, effort, permissionMode, isolation and tool restrictions, and any argument you pass overrides it. Pass a unique `requestId` so a retry after a timeout returns the original node (with replayed: true) instead of opening a second one; reusing a requestId with different arguments is an error. `after` and `afterSuccess` (node ids in your scope) create the node armed, with no process yet: it launches by itself, exactly as this spawn would, once each `after` node has finished a turn that began after this spawn (or has exited), and each `afterSuccess` node has reported succeeded through report_outcome (gate passed, when one is configured). A failed report blocks it and you get a message; close it to drop it. When the daemon config sets daemon.maxWorking and that many agent nodes are working, a new node is queued instead and launched in creation order as others stop. The reply then has state "armed" or "queued" and what it waits on. `fork` (Claude nodes only: kind "claude", or "agent" on harness claude) starts the node from a copy of another node\'s conversation, then `prompt`: a node in your scope, or a closed node of your tree (see history); `cwd` then defaults to that node\'s.',
    { ...SPAWN_FIELDS, cwd: SPAWN_FIELDS.cwd.optional(), permissionMode: z.enum(PERMISSION_MODES).optional(), requestId: z.string().optional() },
    async (c, { requestId, cwd, ...req }) => {
      if (req.now && c.caller !== HUMAN) throw new Error('refused: only the human may bypass daemon.maxWorking with now');
      if (!cwd && !req.fork) throw new Error('cwd is required unless you fork');
      if (req.fork && c.caller !== HUMAN) {
        if (c.manager.registry.get(req.fork)) requireScope(c, req.fork);
        else await requireArchived(c, req.fork);
      }
      const now = Date.now();
      for (const [k, v] of spawned) if (now - v.at > IDEMPOTENCY_MS) spawned.delete(k);
      const key = `${c.caller}\0${requestId}`;
      const args = JSON.stringify({ cwd, ...req });
      const prior = requestId ? spawned.get(key) : undefined;
      if (prior) {
        if (prior.args !== args) throw new Error(`requestId ${requestId} was already used with different arguments`);
        return { data: { ...(prior.result as object), replayed: true } };
      }
      const view = await c.manager.spawn({ ...req, cwd: cwd ?? '', parentId: c.caller === HUMAN ? null : c.caller, byHuman: c.caller === HUMAN });
      const w = view.worktree;
      const held = view.status.state === 'armed' || view.status.state === 'queued' ? { state: view.status.state, waiting: view.status.activity } : {};
      const result = w ? { nodeId: view.id, worktree: { path: w.path, branch: w.branch, base: w.base } } : { nodeId: view.id, ...held };
      if (requestId) spawned.set(key, { args, result, at: now });
      return { data: result };
    }),

  send: tool(
    'Send message',
    `Send a message to another agent node (self excluded; scope is your parent, siblings, and descendants). The message reaches the target as a prompt inside a framed envelope that shows the target who sent it and where to reply. Delivery is normally queued and confirmed asynchronously: the reply has outcome "queued" and a messageId, and the target's plugin submits the message when the target is idle (up to ${QUEUE_CAP} queued, for ${QUEUE_TTL_MS / 60_000} minutes). Call message_status with the messageId to see when it becomes delivered. If the target has no plugin running, the message is instead pasted into its prompt when it is idle, and the reply may be delivered, stalled or queued. Outcomes: queued (still waiting), delivered, stalled (pasted but not confirmed, do not resend blindly), expired and queueFull (not delivered; resend later), withdrawn, gone, refused (the detail says why). Only one send per target per ${RATE_MS / 1000} seconds is accepted. Terminal nodes cannot receive messages; use write. mode "now" steers: if the target is working, its turn is interrupted and the message delivered at once, with an envelope line saying so (the reply and message_status carry steer: true); to an idle target it is the same as the default "queue". Use it only to stop a worker heading the wrong way. A queued message can be taken back with withdraw.`,
    { nodeId: z.string().min(1), text: z.string().min(1), mode: z.enum(['queue', 'now']).optional() },
    async (c, a) => ({ data: await deliver(c.manager, c.caller, a.nodeId, a.text, { mode: a.mode }) })),

  withdraw: tool(
    'Withdraw message',
    'Take back a message you sent that is still queued (not yet submitted to or pasted into the target). Its outcome becomes "withdrawn" and it is never delivered. A message with any other outcome (see send), or one being submitted, cannot be withdrawn, and the error says why. Takes the messageId from the send reply.',
    { messageId: z.string().min(1) },
    async (c, a) => ({ data: (await withdraw(c.manager, c.caller, a.messageId)).result })),

  message_status: tool(
    'Check message status',
    'Look up the current outcome of a message you sent, which is how you confirm a queued message was delivered. It returns the same result as send (outcomes are listed there), with outcome queued until the message settles. Takes the messageId from the send reply.',
    { messageId: z.string().min(1) },
    async (c, a) => {
      const r = messageStatus(c.manager, c.caller, a.messageId);
      if (!r) throw new Error(`no queued message ${a.messageId} from you`);
      return { data: r };
    }),

  notify_when: tool(
    'Watch node completion',
    'Get one message when a set of nodes finishes, instead of polling list_nodes or having each worker report separately. Returns at once; later you receive a single framed message "N of M finished:" with one line per node giving its outcome (or its state). when "all" waits for every node, "any" for the first. of "turn" counts a node once it finishes the turn in progress now, or for an idle node its next turn (exiting or closing counts too); of "success" counts a node once it calls report_outcome (either verdict) from now on, or within the turn in progress now. Ids must be in your scope. One pending notify_when per id set: calling again with the same ids replaces it. It expires after 12 hours.',
    { ids: z.array(z.string().min(1)).min(1), when: z.enum(['all', 'any']), of: z.enum(['turn', 'success']) },
    async (c, a) => {
      if (c.caller === HUMAN) throw new Error('notify_when is only for agent nodes: the human has no inbox');
      for (const id of a.ids) requireScope(c, id);
      return { data: { ok: true, ...notifyWhen(c.manager, c.caller, a) } };
    }),

  read: tool(
    'Read node output',
    'Read another node (yourself, your ancestors, siblings or descendants). what "summary" returns the last `lines` (default 30) user and assistant messages of an agent node\'s conversation, with tool calls reduced to a "[tool: name]" marker; "transcript" returns the whole conversation (capped at the most recent 200 KB); "terminal" returns the last `lines` (default 60) rows of the node\'s screen and works for terminal nodes too. Summary and transcript also take a closed node of your tree (see history).',
    { nodeId: z.string().min(1), what: z.enum(['summary', 'transcript', 'terminal']), lines: z.number().int().min(1).max(5000).optional() },
    async (c, a) => {
      const v = c.manager.registry.get(a.nodeId) || a.what === 'terminal' ? requireScope(c, a.nodeId) : await requireArchived(c, a.nodeId);
      if (a.what === 'terminal') {
        const s = c.manager.session(a.nodeId);
        if (!s) throw new Error('node has no running process');
        await s.flush();
        return { text: s.screenTail(a.lines ?? 60).join('\n') };
      }
      const path = v.transcriptPath;
      if (!path) throw new Error('node has no transcript yet (not an agent node, or it has not started); try what: "terminal"');
      const entries = (await readMessages(path, v.harness)).messages.map(renderMessage);
      if (a.what === 'summary') return { text: entries.slice(-(a.lines ?? 30)).join('\n\n') };
      return { text: entries.join('\n\n').slice(-TRANSCRIPT_CAP) };
    }),

  history: tool(
    'List past agents',
    `List the closed agent nodes of your tree, newest first, one line each: id, title, when it closed, a one-line brief of what it did and how it ended (with its branch's fate), branch and spend. \`query\` keeps those whose title, first prompt or last message contains it. Read one with read, continue its work by spawning with fork. At most ${HISTORY_LINES} lines. \`rootId\` picks a tree for the human only.`,
    { query: z.string().optional(), rootId: z.string().min(1).optional() },
    async (c, a) => {
      const items = await history(c.manager.home, { rootId: c.caller === HUMAN ? a.rootId : rootOf(c), query: a.query });
      const now = Date.now(), more = items.length - HISTORY_LINES;
      return { text: [...items.slice(0, HISTORY_LINES).map((x) => historyLine(x, now)), ...(more > 0 ? [`(${more} more; narrow with query)`] : [])].join('\n') || '(no closed nodes)' };
    }),

  transcript: tool(
    'Read session transcript',
    'A live or closed Claude node\'s conversation in one of its sessions (default: the current one), as read "transcript" prints it, with its session ids. Only the human may call this.',
    { nodeId: z.string().min(1), sessionId: z.string().min(1).optional() },
    async (c, a) => {
      const t = await sessionMessages(await c.manager.transcriptNode(a.nodeId), a.sessionId);
      const head = `sessions: ${t.sessions.map((s) => s.sessionId + (s.current ? ' (current)' : '')).join(', ')}${t.truncated ? `; older entries cut, showing the last ${t.messages.length}` : ''}`;
      return { text: [head, ...t.messages.map(renderMessage)].join('\n\n') };
    }, true),

  followup: tool(
    'Continue past agent',
    'Continue a closed agent node\'s session as a new live node using its harness that starts on `prompt`, with its title (unless `title`), model, effort, role and profile, under its parent when that is still live. Only the human may call this.',
    { nodeId: z.string().min(1), prompt: z.string().min(1), title: z.string().min(1).optional() },
    async (c, a) => ({ data: { nodeId: (await c.manager.followup(a.nodeId, a.prompt, a.title)).id } }), true),

  write: tool(
    'Type in terminal',
    'Type raw keystrokes into another node\'s terminal (yourself, ancestors, siblings or descendants), for example to answer a prompt in a terminal node or press Enter. The human must approve each call in the UI; if they decline or nobody is watching you get {ok:false, reason:"denied"}. Text is limited to 2000 characters. For talking to an agent node use send, which is safer.',
    { nodeId: z.string().min(1), text: z.string().min(1).max(MAX_WRITE_CHARS) },
    async (c, a) => {
      const v = requireScope(c, a.nodeId);
      if (!c.manager.session(a.nodeId)) throw new Error('node has no running process');
      if (c.caller !== HUMAN && !(await c.confirm(`${who(c)} wants to type into ${v.title} (${v.id}): ${JSON.stringify(a.text)}`))) {
        return { data: { ok: false, reason: 'denied' } };
      }
      c.manager.input(a.nodeId, a.text);
      return { data: { ok: true } };
    }),

  close: tool(
    'Close nodes',
    'Close and delete nodes. Every id must exist and be a descendant of yours, otherwise the whole batch is refused and nothing is closed. Orchestrators (root nodes) cannot be closed by agents. The human approves the batch once in the UI; if they decline you get {ok:false, reason:"denied"}. The project config (approvals.close in .tiller/config.json) can skip that approval: "always" skips it, "done" skips it when every node in the batch is done, has exited or has called report_outcome (so a worker can be closed as soon as its report arrives), and the default "never" always asks. A node with its own git worktree closes only when the tree is clean, its branch is merged and no other live node works in it; otherwise the batch is refused, nothing is closed, and the error says why. `worktree` decides instead for the whole batch: "keep" commits uncommitted changes as a WIP commit and keeps the branch, "discard" deletes the worktree and branch with any unmerged work, and always needs the human\'s approval.',
    { nodeIds: z.array(z.string().min(1)).min(1), force: z.boolean().optional(), worktree: z.enum(['keep', 'discard']).optional() },
    async (c, a) => {
      const views = a.nodeIds.map((id) => requireOwned(c, id, false));
      for (const v of views) {
        if (v.parentId !== null) continue; // only the human gets here with a root: requireOwned refuses agents
        if (!a.force) throw new Error(`refusing to close an orchestrator; use tl kill --force ${v.id}`);
      }
      // Refusals come before the confirm and before approvals.close: no setting turns a refused close into a close.
      const destroys: string[] = [];
      for (const v of views) {
        const check = await c.manager.worktreeCheck(v.id);
        if (!check) continue;
        const refusal = closeRefusal(check, a.worktree);
        if (refusal) throw new Error(views.length > 1 ? `${v.id}: ${refusal}` : refusal);
        if (a.worktree === 'discard') destroys.push(`${v.title}: discards ${check.unmerged.length} commit(s) and ${check.dirty.length} changed file(s) on ${v.worktree!.branch}`);
      }
      const list = views.map((v) => `${v.title} (${v.id})`).join(', ');
      const mode = c.caller === HUMAN ? undefined : loadConfig(c.manager.projectDir(c.manager.view(c.caller)!), c.manager.home).approvals.close;
      // "done" also counts a node that has reported but is still working, so a worker can be closed as soon as its report arrives.
      const preapproved = a.worktree !== 'discard' && (mode === 'always' || (mode === 'done' && views.every((v) => finished(v.status) || v.outcome)));
      const text = `${who(c)} wants to close ${views.length} node(s): ${list}${destroys.length ? `. This deletes their worktrees: ${destroys.join('; ')}` : ''}`;
      if (c.caller !== HUMAN && !preapproved && !(await c.confirm(text))) {
        return { data: { ok: false, reason: 'denied' } };
      }
      const notes: string[] = [];
      for (const id of a.nodeIds) {
        const note = await c.manager.close(id, true, a.worktree); // roots were vetted above
        if (note) notes.push(`${id}: ${note}`);
      }
      return { data: { ok: true, closed: a.nodeIds, ...(notes.length ? { notes } : {}) } };
    }),

  merge: tool(
    'Merge node changes',
    'Merge the git branch of one of your descendants that has its own worktree into the branch it was created from (its base), in the project\'s merge style (worktrees.mergeStyle in .tiller/config.json: "merge", the default, makes a merge commit; "squash" makes one commit; "ff-only" only fast-forwards). Refused, with nothing changed, when the base is a protected branch (worktrees.protected, default main and master, plus origin\'s default branch: spawn with a `base` branch instead and have the human open a pull request from it), while the node is working, when its worktree has uncommitted files, when the base is checked out somewhere with uncommitted changes, A conflict with the base is checked first without touching any file: the reply is then {ok:false, conflicts:[paths]}; send the worker a rebase instruction rather than resolving it yourself, then merge again. The merge or squash commit is signed when the repo\'s git config sets commit.gpgsign, and a signing failure refuses the merge with git\'s error. The human approves each merge in the UI unless the project config sets approvals.merge; if they decline you get {ok:false, reason:"denied"}. Close the node afterwards to remove its worktree and branch.',
    { nodeId: z.string().min(1) },
    async (c, a) => {
      const v = requireOwned(c, a.nodeId, false);
      if (!v.worktree) throw new Error(`${v.id} has no worktree of its own to merge`);
      const skip = c.caller === HUMAN || loadConfig(v.worktree.repo, c.manager.home).approvals.merge;
      if (!skip && !(await c.confirm(`${who(c)} wants to merge ${v.title} (${v.id}): branch ${v.worktree.branch} into ${v.worktree.base}`))) {
        return { data: { ok: false, reason: 'denied' } };
      }
      let r: Awaited<ReturnType<NodeManager['merge']>>;
      try {
        r = await c.manager.merge(a.nodeId);
      } catch (err) {
        if (!(err instanceof MergeConflict)) throw err;
        return { text: `${err.message}. Send the worker a rebase instruction: rebase ${v.worktree.branch} onto ${v.worktree.base}, resolve, commit, then merge again.`, data: { ok: false, conflicts: err.conflicts } };
      }
      return { text: `merged ${v.worktree.branch} into ${r.base} (${r.style}), now at ${r.sha.slice(0, 7)}`, data: { ok: true, ...r } };
    }),

  resume: tool(
    'Resume node',
    'Relaunch an exited Claude node with its previous conversation. Only the human may call this.',
    { nodeId: z.string().min(1) },
    async (c, a) => {
      const r = await c.manager.resume(a.nodeId);
      if (!r.ok) throw new Error(r.error);
      return { data: { ok: true } };
    }, true),

  restart: tool(
    'Restart node',
    'Restart a node: kill its process and relaunch it with a fresh session, which clears its context. Its title, directory, model, effort and children are kept. `prompt` is its first prompt; without one, a node whose tree has a handoff.md in its session directory is told to read it first. Only the human may call this.',
    { nodeId: z.string().min(1), prompt: z.string().optional() },
    async (c, a) => {
      const r = c.manager.restart(a.nodeId, a.prompt);
      if (!r.ok) throw new Error(r.error);
      return { data: { ok: true } };
    }, true),

  change_harness: tool(
    'Change agent harness',
    'Stop an existing agent and start Claude, Codex or Pi with a fresh native context. Keeps node identity, children, workspace and readable history. Clears preset, permission, model and effort overrides and uses the target profile defaults. Only the human may call this.',
    { nodeId: z.string().min(1), harness: z.enum(['claude', 'codex', 'pi']), prompt: z.string().optional() },
    async (c, a) => {
      const r = await c.manager.changeHarness(a.nodeId, a.harness, a.prompt, true);
      if (!r.ok) throw new Error(r.error);
      return { data: { ok: true } };
    }, true),

  prune: tool(
    'Remove finished nodes',
    'Remove every exited node that has no live descendant (files and records). A node whose git worktree has uncommitted or unmerged work is kept and listed. Only the human may call this.',
    {},
    async (c) => {
      const { removed, kept } = await c.manager.prune();
      const keptText = kept.length ? `; kept ${kept.length} node(s) with worktree work:\n${kept.map((k) => `  ${k.id}: ${k.reason}`).join('\n')}` : '';
      return { text: `removed ${removed.length} exited node(s)${keptText}`, data: { ok: true, removed, kept } };
    }, true),

  diff: tool(
    'Review changes',
    `Show what a node with its own git worktree (yourself or one of your descendants) changed since it branched from its base: its commits plus its uncommitted and untracked files, as one unified diff of the working tree against where the branch started. Patch text stops after ${MAX_PATCH_BYTES >> 20} MB; the remaining files are listed with their line counts only, as are binary files. stat true lists only the files and counts.`,
    { nodeId: z.string().min(1), stat: z.boolean().optional() },
    async (c, a) => {
      requireOwned(c, a.nodeId, true);
      return { text: diffText(await c.manager.diff(a.nodeId), !!a.stat) };
    }),

  worktrees: tool(
    'Manage worktrees',
    'List tiller git worktrees for the repo `cwd` is in (all known repos when omitted): node worktrees, orphans (a worktree with no node) and kept branches. clean "safe" removes the orphans and kept branches that are clean and merged; "force" removes all of them and reports the commits and files that went. Only the human may call this.',
    { cwd: z.string().min(1).optional(), clean: z.enum(['safe', 'force']).optional() },
    async (c, a) => {
      const r = await c.manager.worktrees(a);
      return { text: worktreeText(r), data: r };
    }, true),

  select: tool(
    'Show node',
    'Make the web UI and app show a node (they switch to it). Only the human may call this.',
    { nodeId: z.string().min(1) },
    async (c, a) => {
      requireNode(c.manager, a.nodeId);
      if (process.env.TL_DEBUG) console.log(`select ${a.nodeId}`);
      c.focus(HUMAN, a.nodeId);
      return { data: { ok: true } };
    }, true),

  shutdown: tool(
    'Stop Tiller',
    'Stop the daemon: flush the registry, kill every node process and exit. The nodes are not resumed on the next start. Only the human may call this.',
    {},
    async (c) => {
      c.manager.shutdown({ clearLive: true });
      setTimeout(() => process.exit(0), 100); // after the reply is flushed
      return { text: 'daemon stopping', data: { ok: true, pid: process.pid } };
    }, true),

  mute: tool(
    'Mute notifications',
    'Stop (muted true) or restore one node\'s OS notifications; the mute is kept across restarts. Only the human may call this.',
    { nodeId: z.string().min(1), muted: z.boolean() },
    async (c, a) => {
      if (!c.manager.mute(a.nodeId, a.muted)) throw new Error(`no such node: ${a.nodeId}`);
      return { text: `${a.muted ? 'muted' : 'unmuted'} ${a.nodeId}`, data: { ok: true } };
    }, true),

  dnd: tool(
    'Set do not disturb',
    'Turn do not disturb on, for `minutes` when given, or off: it stops every OS notification and is not kept across a daemon restart. Without `on`, only report it. Only the human may call this.',
    { on: z.boolean().optional(), minutes: z.number().positive().max(7 * 24 * 60).optional() },
    async (c, a) => {
      const d = c.dnd(a.on, a.minutes);
      const text = dndActive(d, Date.now()) ? `do not disturb is on${d.until ? ` until ${new Date(d.until).toLocaleTimeString()}` : ''}` : 'do not disturb is off';
      return { text, data: d };
    }, true),

  update: tool(
    'Update Tiller',
    'Check published stable GitHub releases and roll-up notes. With apply, install the exact reviewed tag and commit, rebuild and restart the daemon, resuming live nodes. The restart first waits for agent nodes to finish their turns, unless `now`. Human only.',
    { apply: z.boolean().optional(), tag: z.string().optional(), sha: z.string().optional(), now: z.boolean().optional() },
    async (c, a) => {
      if (!c.updates) throw new Error('updates unavailable');
      if (!a.apply) { const s = await c.updates.check(); return { text: updateLine(s), data: s }; }
      if (!a.tag || !a.sha) throw new Error('check and supply the reviewed tag and sha');
      const result = await c.updates.apply({ tag: a.tag, sha: a.sha, now: a.now });
      return { text: `Updating to ${a.tag}; the daemon will restart and resume live nodes. Log: ${result.log}`, data: result };
    }, true),

  drain: tool(
    'Drain before a restart',
    'Before restarting the daemon for `reason`: hold message deliveries and agent spawns and report the agent nodes still working (leaving out `exclude`). Call it again every few seconds while waiting; the hold ends by itself 15 s after the last call. `cancel` ends it at once and releases what it held. Only the human may call this.',
    { reason: z.string().min(1).max(200).optional(), exclude: z.string().optional(), cancel: z.boolean().optional() },
    async (c, a) => {
      if (a.cancel) { c.manager.endDrain(); return { text: 'drain cancelled', data: null }; }
      if (!a.reason) throw new Error('reason is required');
      const d = c.manager.drain(a.reason, a.exclude);
      return { text: d.waiting.length ? `waiting for ${d.waiting.map((w) => w.id).join(', ')}` : 'no agent is working', data: d };
    }, true),

  sessions_clean: tool(
    'Clean old sessions',
    'Delete the session directories that daemon.sessionsKeepDays has expired now, rather than at the daily sweep. Only the human may call this.',
    {},
    async (c) => {
      const removed = c.manager.sweepSessions();
      return { text: `removed ${removed.length} expired session director${removed.length === 1 ? 'y' : 'ies'}${removed.length ? `: ${removed.join(', ')}` : ''}`, data: { removed } };
    }, true),

  rename: tool(
    'Rename node',
    'Change the title of yourself or one of your descendants.',
    { nodeId: z.string().min(1), title: z.string().min(1) },
    async (c, a) => {
      requireOwned(c, a.nodeId, true);
      c.manager.rename(a.nodeId, a.title);
      return { data: { ok: true } };
    }),

  report_outcome: tool(
    'Report task outcome',
    'Report how your own task ended: "succeeded" or "failed", with an optional short note. Call it once when your work is finished so whoever launched you can tell the difference between done and done well. It is about yourself only. Fill the structured fields too, so your parent can read your result from list_nodes without reading your transcript: summary (what you did, in a sentence or two), changedFiles (paths), verified (what you ran to check the work and its result) and openQuestions (anything left for your parent to decide). If the project configures a completion gate (config `gate`), a "succeeded" report is accepted only once the gate command passes in your directory: the reply says whether the gate passed or failed (with the command\'s output and the attempts you have left); fix the problem and call report_outcome again. A gate still running after 30 seconds is replied to as pending, and a failure then arrives as a message instead. Any report while your gate runs is refused. When no attempts are left the outcome is recorded as failed. Your parent is told of every recorded outcome.',
    {
      outcome: z.enum(['succeeded', 'failed']), note: z.string().optional(), summary: z.string().optional(), changedFiles: z.array(z.string()).optional(),
      verified: z.string().optional(), openQuestions: z.array(z.string()).optional(),
    },
    async (c, a) => {
      if (c.caller === HUMAN) throw new Error('report_outcome is only for agent nodes');
      // A report of either verdict waits for a running gate, so the gate's result cannot overwrite a later "failed".
      if (c.manager.gateRunning(c.caller)) return { text: 'The completion gate is still running for your previous report; wait for its result.', data: { ok: false, gate: 'running' } };
      const gate = a.outcome === 'succeeded' ? c.manager.gateConfig(c.caller) : undefined;
      if (!gate) {
        c.manager.setOutcome(c.caller, { ...a, at: Date.now() });
        return { data: { ok: true } };
      }
      let late = false;
      const pending: Out = { text: `Completion gate running: ${gate.command}. Your outcome is recorded if it passes; if it fails you get a message with its output.`, data: { ok: true, gate: 'pending' } };
      return Promise.race([
        runGate(c.manager, c.caller, gate, a, () => late),
        sleep(GATE_REPLY_MS, undefined, { ref: false }).then(() => { late = true; return pending; }),
      ]);
    }),
};

// ---- HTTP ----

/**
 * Handler for `/mcp` (MCP over stateless streamable HTTP) and `POST /api/<tool>` (the same tools as plain JSON, for the CLI).
 * Both authenticate with `Authorization: Bearer` + `X-TL-Node`. Node id `human` takes the admin token written to `<home>/admin-token`.
 */
export function mountMcp(manager: NodeManager, confirm: Ctx['confirm'], focus: Ctx['focus'], dnd: Ctx['dnd'] = () => ({ on: false }), updates?: Updater): {
  handler: (req: http.IncomingMessage, res: http.ServerResponse) => Promise<void>;
  /** Write the admin token file. Call once the server is listening, so a daemon that fails to bind leaves the running daemon's token alone. */
  publishAdminToken: () => void;
  /** Caller id for a request's Bearer + X-TL-Node (`human` for the admin token), or undefined. */
  authenticate: (req: http.IncomingMessage) => string | undefined;
  /** Whether `token` is the admin token (the WebSocket clients authenticate with it). */
  isAdmin: (token: string) => boolean;
} {
  const adminFile = join(manager.home, ADMIN_TOKEN_FILE);
  let adminToken = ''; // kept across restarts, so attached clients re-authenticate after `tl reload`
  try { adminToken = readFileSync(adminFile, 'utf8').trim(); } catch { /* first start: minted below */ }
  adminToken ||= randomBytes(32).toString('base64url');
  const publishAdminToken = () => {
    writeFileSync(adminFile, adminToken, { mode: 0o600 });
    chmodSync(adminFile, 0o600);
  };
  startNotices(manager);
  manager.on('removed', (id: string) => {
    for (const k of spawned.keys()) if (k.startsWith(`${id}\0`)) spawned.delete(k);
  });

  const isAdmin = (token: string) => safeEqual(token, adminToken);
  const authenticate = (req: http.IncomingMessage): string | undefined => {
    const id = String(req.headers['x-tl-node'] ?? '');
    const bearer = /^Bearer (.+)$/.exec(req.headers.authorization ?? '')?.[1] ?? '';
    if (id === HUMAN) return isAdmin(bearer) ? id : undefined;
    return id && manager.view(id) && manager.verifyToken(id, bearer) ? id : undefined;
  };

  async function api(req: http.IncomingMessage, res: http.ServerResponse, name: string, ctx: Ctx): Promise<void> {
    const reply = (code: number, body: unknown) => res.writeHead(code, { 'Content-Type': 'application/json' }).end(JSON.stringify(body));
    const t = (tools as Record<string, (typeof tools)[keyof typeof tools]>)[name];
    if (req.method !== 'POST' || !t) return void res.writeHead(404).end();
    const raw = await readBody(req, res);
    if (raw === undefined) return;
    if (authenticate(req) !== ctx.caller) return void res.writeHead(401).end();
    try {
      if (t.humanOnly && ctx.caller !== HUMAN) throw new Error(`${name} is only for the human`);
      const args = z.object(t.shape).parse(raw ? JSON.parse(raw) : {});
      reply(200, await t.run(ctx, args as never));
    } catch (err) {
      reply(400, { error: err instanceof z.ZodError ? err.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') : (err as Error).message });
    }
  }

  const handler = async (req: http.IncomingMessage, res: http.ServerResponse) => {
    const caller = authenticate(req);
    if (!caller) return void res.writeHead(401).end();
    const ctx: Ctx = { manager, confirm, focus, dnd, updates, caller };
    const path = new URL(req.url ?? '/', 'http://x').pathname;
    if (path.startsWith('/api/')) return api(req, res, path.slice(5), ctx);

    const mcp = new McpServer({ name: 'tiller', version: '0.0.0' });
    for (const [name, t] of Object.entries(tools)) {
      if (t.humanOnly && caller !== HUMAN) continue;
      mcp.registerTool(name, { title: t.title, description: t.description, inputSchema: t.shape }, async (args: unknown) => {
        try {
          if (authenticate(req) !== caller) throw new Error('node credentials have expired');
          const out = await t.run(ctx, args as never);
          const content = [out.text, out.data === undefined ? undefined : JSON.stringify(out.data)].flatMap((x) => (x === undefined ? [] : [{ type: 'text' as const, text: x }]));
          return { content };
        } catch (err) {
          return { content: [{ type: 'text' as const, text: (err as Error).message }], isError: true };
        }
      });
    }
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on('close', () => { transport.close().catch(logError); mcp.close().catch(logError); });
    await mcp.connect(transport);
    await transport.handleRequest(req, res);
  };
  return { handler, publishAdminToken, authenticate, isAdmin };
}
