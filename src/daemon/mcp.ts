import { fmtAge, shortEffort, shortModel, usageLine } from '../shared/format.js';
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
import { closeRefusal, queueMerge, type MergeResult, type WorktreeReport } from './worktree-lifecycle.js';
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
/** Diff text an agent gets over MCP; /api (the CLI) keeps the full patch. */
const MCP_DIFF_CHARS = 100_000;

/** dnd sets do not disturb when `on` is given, and returns it. */
interface Ctx { updates?: Updater; manager: NodeManager; confirm: (text: string) => Promise<boolean>; focus: (from: string, id: string) => void; dnd: (on?: boolean, minutes?: number) => Dnd; caller: string; mcp?: boolean }
interface Out { text?: string; data?: unknown }

/** How long report_outcome waits for a completion gate before replying that it is still running. */
const GATE_REPLY_MS = 30_000;

// ---- helpers ----

function flags(v: NodeView): string[] {
  const s = v.status;
  return (['errored', 'interrupted', 'exited', 'stale', 'stalled'] as const).filter((f) => s[f]);
}

function summarize(v: NodeView, now: number, all: NodeView[]) {
  const tree = subtreeSpend(all, v.id);
  return {
    id: v.id, parentId: v.parentId, title: v.title, kind: v.kind, ...(v.harness ? { harness: v.harness } : {}), ...(v.account ? { account: v.account } : {}), cwd: v.cwd, state: v.status.state, flags: flags(v), exited: !!v.status.exited, createdAt: v.createdAt,
    age: fmtAge(now - v.createdAt), activity: v.status.activity, lastAssistantMessage: v.status.lastAssistantMessage?.slice(0, PREVIEW_CHARS),
    outcome: v.outcome, gate: v.gate, preset: v.preset, profile: v.profile, role: v.role,
    model: v.status.model, effort: v.status.effort, contextPct: v.status.contextPct, contextTokens: v.status.contextTokens, contextWindow: v.status.contextWindow, costUsd: v.status.costUsd,
    spentUsd: v.spentUsd, ...(v.spentIncomplete ? { spentIncomplete: true } : {}),
    subtreeSpentUsd: tree.usd, ...(tree.incomplete ? { subtreeSpentIncomplete: true } : {}),
    worktree: v.worktree && worktreeSummary(v),
  };
}

function worktreeSummary(v: NodeView) {
  const w = v.worktree!, g = v.status.git;
  return { path: w.path, branch: w.branch, base: w.base, ahead: g?.ahead, behind: g?.behind, dirty: g?.dirty, missing: !!w.missing, merged: !!g?.mergedAt, conflicts: g?.conflicts };
}

/** `⎇ tl/n-3f2a ↑3 ↓1 conflicts:2 dirty merged` for the tree line. */
function branchText(w: ReturnType<typeof worktreeSummary>): string {
  return [`⎇ ${w.branch} from ${w.base}`, w.ahead && `↑${w.ahead}`, w.behind && `↓${w.behind}`, w.conflicts && `conflicts:${w.conflicts.length}`, w.dirty && 'dirty', w.merged && 'merged', w.missing && '(worktree missing)'].filter(Boolean).join(' ');
}

function modelInfo(n: ReturnType<typeof summarize>): string {
  const me = [n.profile && `profile ${n.profile}`, n.preset && `preset ${n.preset}`, n.model && shortModel(n.model), n.effort && shortEffort(n.effort)].filter(Boolean).join(' ');
  const own = n.spentUsd ?? 0;
  const treeMore = n.subtreeSpentUsd > own || (!!n.subtreeSpentIncomplete && !n.spentIncomplete);
  const spend = n.subtreeSpentUsd || n.subtreeSpentIncomplete
    ? fmtUsd(own, n.spentIncomplete) + (treeMore ? ` (tree ${fmtUsd(n.subtreeSpentUsd, n.subtreeSpentIncomplete)})` : '')
    : '';
  return [n.account && `account ${n.account}`, me, n.contextPct !== undefined && `ctx ${Math.round(n.contextPct)}%`, spend].filter(Boolean).map((p) => ` · ${p}`).join('');
}

function tree(nodes: ReturnType<typeof summarize>[]): string {
  return treeOrder(nodes).map(({ node: n, depth }) => {
    // The verdict only: the parent's notice already carried the excerpt, and read "outcome" gives the whole report.
    const reported = n.outcome && `reported ${n.outcome.outcome}${n.outcome.gate ? ` (gate ${n.outcome.gate})` : ''}`;
    const extra = [...n.flags, n.activity, n.gate === 'running' && 'gate running', reported].filter(Boolean).join(', ');
    const branch = n.worktree ? ` ${branchText(n.worktree)}` : '';
    const kind = n.kind === 'agent' && n.harness ? `agent ${n.harness}` : n.kind;
    const pad = '  '.repeat(depth);
    // An idle or waiting node that has not reported may be asking something: show the start of its last message.
    const last = !n.outcome && ['waiting', 'blocked', 'done'].includes(n.state) && n.lastAssistantMessage?.replace(/\s+/g, ' ').trim();
    return `${pad}- ${n.id} "${n.title}" [${kind}] ${n.state}${extra ? ` (${extra})` : ''} ${n.age}${modelInfo(n)}${branch}${last ? `\n${pad}    last: ${last}` : ''}`;
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

/** read "outcome": a node's report_outcome fields as plain text. */
function outcomeText(id: string, o: Outcome | undefined, gate?: NodeView['gate']): string {
  if (!o) return `${id} has not reported an outcome${gate === 'running' ? ' (its completion gate is running)' : ''}`;
  const list = (label: string, xs?: string[]) => (xs?.length ? [`${label}:`, ...xs.map((x) => `  - ${x}`)] : []);
  const age = fmtAge(Date.now() - o.at);
  return [
    `${id} reported ${o.outcome}${o.gate ? ` (gate ${o.gate})` : ''} ${age === 'now' ? 'just now' : `${age} ago`}`,
    o.note && `note: ${o.note}`, o.summary && `summary: ${o.summary}`, ...list('changed files', o.changedFiles),
    o.verified && `verified: ${o.verified}`, ...list('open questions', o.openQuestions),
  ].filter(Boolean).join('\n');
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
  return [`${a.id} "${a.title}" closed ${age === 'now' ? 'just now' : `${age} ago`}${a.brief ? `: ${a.brief}` : ''}`, a.branch && `⎇ ${a.branch}`, (a.spentUsd || a.spentIncomplete) && fmtUsd(a.spentUsd ?? 0, a.spentIncomplete)].filter(Boolean).join(' ');
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
    `List the nodes you can see (yourself, ancestors, siblings, descendants) as an indented tree, after a line of your Claude account's usage (5-hour and 7-day windows, shared by every node in the account). States: working, waiting, blocked, done, unknown, none; armed (waiting on spawn dependencies) and queued (waiting on daemon.maxWorking), with the reason as activity. Flags: errored, interrupted, exited, stale, stalled (working with no hook event for limits.stallMinutes). "reported <verdict>" follows report_outcome; the full report is in read what "outcome". [agent X] names the harness. Spend is the node's own, then "tree" with descendants; a trailing +, as in $0.12+, marks a lower bound because some usage had no price. A node with its own worktree shows ⎇ branch from base, ↑ commits not in base, ↓ base commits not on the branch, dirty (uncommitted files), merged, and conflicts:N (files that would conflict with base). Use it to find node ids for send, read or close.`,
    {},
    async (c) => {
      const all = c.manager.list();
      const nodes = all.filter((v) => inScope(c.manager, c.caller, v.id)).map((v) => summarize(v, Date.now(), all));
      // An agent sees its own Claude account's quota; the human, the newest report from any account (labelled with it).
      const usage = c.caller === HUMAN ? c.manager.usage : c.manager.usageByAccount.get(c.manager.registry.get(c.caller)?.account ?? '');
      return { text: `${usageLine(usage)}\n${tree(nodes)}`, data: nodes };
    }),

  spawn: tool(
    'Start node',
    `Open a child node and return its id. kind "claude": Claude Code; "agent": \`harness\` (claude, pi or codex; default yours); "terminal": a login shell. \`cwd\` must exist. \`role\`: "worker" (default), "orchestrator" or "none". \`profile\` (orchestrator, implementation, explorer, mechanical, reviewer) is independent of role and defaults from it (orchestrator, else implementation); explorer and reviewer instruct read-only work but enforce no tool restrictions. Explicit \`model\`/\`effort\` win over presets, which win over config. Claude children inherit a same-harness parent's permissionMode. Pi and Codex refuse permissionMode and preset options they cannot enforce; the error names them.
isolation "worktree" (agent nodes; a repo with a commit; Claude also needs its own workspace trust) gives the child a git worktree at <main checkout>/.claude/worktrees/<id> on a new branch; the reply carries worktree { path, branch, base }. \`base\` is the branch it forks from and merges into, created at the HEAD of \`cwd\`'s checkout if missing; give every worker of a task the same base so merges accumulate. Without base it is the branch checked out at \`cwd\`, unless that is protected (worktrees.protected, default main, master and origin's default) or detached: then a new worktrees.taskBranch branch (default "tl/{slug}") is made. Omitted isolation follows project config (default "none"), so a child whose cwd is in an existing worktree shares it.
\`preset\`: .tiller/agents/<name>.md in \`cwd\`'s main checkout, else ~/.tiller/agents/<name>.md (built-in "reviewer", "researcher"); it sets role text, model, effort, permissionMode, isolation and tool restrictions, and your arguments override it.
\`requestId\`: a retry with the same one returns the original node (replayed: true); reusing it with different arguments is an error.
\`after\`/\`afterSuccess\` (ids in your scope): the node starts armed, with no process, and launches once each \`after\` node finishes a turn begun after this spawn (or exits) and each \`afterSuccess\` node reports succeeded (gate passed, if configured). A failed report blocks it and you get a message; close it to drop it. With daemon.maxWorking agents working it is queued and launched in creation order. The reply then has state "armed" or "queued" and what it waits on.
\`fork\` (Claude nodes only) starts from a copy of another node's conversation, then \`prompt\`: a node in your scope or a closed node of your tree (see history); \`cwd\` defaults to its.`,
    { ...SPAWN_FIELDS, cwd: SPAWN_FIELDS.cwd.optional(), permissionMode: z.enum(PERMISSION_MODES).optional(), requestId: z.string().optional() },
    async (c, { requestId, cwd, ...req }) => {
      if (req.now && c.caller !== HUMAN) throw new Error('refused: only the human may bypass daemon.maxWorking with now');
      if (req.account !== undefined && c.caller !== HUMAN) throw new Error('refused: only the human may choose a Claude account; a node you spawn runs in yours');
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
    `Send a message to an agent node in your scope (parent, siblings, descendants; not yourself); it arrives as a framed prompt. Normally it is queued: the reply has outcome "queued" and a messageId, and the target's plugin submits it when the target is idle (up to ${QUEUE_CAP} queued, for ${QUEUE_TTL_MS / 60_000} minutes); message_status shows when it is delivered. A target with no plugin gets it pasted into its prompt when idle; the reply may be delivered, stalled or queued. Outcomes: queued, delivered, stalled (pasted, unconfirmed: do not resend blindly), expired and queueFull (not delivered; resend later), withdrawn, gone, refused (detail says why). One send per target per ${RATE_MS / 1000} seconds. Terminal nodes cannot receive messages; use write. mode "now" interrupts a working target's turn and delivers at once, with an envelope line saying so (reply and message_status carry steer: true); to an idle target it equals "queue". Use it only to stop a worker heading the wrong way. withdraw takes back a queued message.`,
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
    'Read another node (yourself, your ancestors, siblings or descendants). what "outcome" returns its report_outcome report; read it first for a finished worker. "summary" returns the last `lines` (default 30) user and assistant messages of an agent node\'s conversation, with tool calls reduced to a "[tool: name]" marker; "transcript" returns the whole conversation (capped at the most recent 200 KB); "terminal" returns the last `lines` (default 60) rows of the node\'s screen, which are the visible rows plus up to 1000 lines of scrollback, and works for terminal nodes too. Outcome, summary and transcript also take a closed node of your tree (see history).',
    { nodeId: z.string().min(1), what: z.enum(['outcome', 'summary', 'transcript', 'terminal']), lines: z.number().int().min(1).max(5000).optional() },
    async (c, a) => {
      const v = c.manager.registry.get(a.nodeId) || a.what === 'terminal' ? requireScope(c, a.nodeId) : await requireArchived(c, a.nodeId);
      if (a.what === 'terminal') {
        const s = c.manager.session(a.nodeId);
        if (!s) throw new Error('node has no running process');
        await s.flush();
        return { text: s.screenTail(a.lines ?? 60).join('\n') };
      }
      if (a.what === 'outcome') return { text: outcomeText(v.id, v.outcome, 'gate' in v ? v.gate : undefined) };
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
    `Close and delete nodes. Every id must be your descendant (agents cannot close orchestrators), or the whole batch is refused and nothing closes. The human approves the batch once in the UI; declined gives {ok:false, reason:"denied"}. Config approvals.close can skip that: "always" skips; "done" skips when every node is done, exited or has called report_outcome; "never" (default) asks. A node with its own worktree closes only when its tree is clean, its branch merged and no other live node works in it; otherwise the batch is refused, nothing closes, and the error says why. \`worktree\` overrides that for the batch: "keep" commits uncommitted changes as a WIP commit and keeps the branch; "discard" deletes the worktree and branch with any unmerged work and always needs the human's approval.`,
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
    `Merge the branch of a descendant that has its own worktree into its base, in the project's worktrees.mergeStyle ("merge", default: a merge commit; "squash": one commit; "ff-only": fast-forward only). Refused, with nothing changed, when the base is protected (worktrees.protected, default main, master and origin's default branch: spawn with a \`base\` branch instead and have the human open a pull request from it), while the node is working, when its worktree has uncommitted files, or when the base is checked out somewhere with uncommitted changes. Conflicts are checked first without touching files; the reply names the conflicting paths: send the worker a rebase instruction rather than resolving them yourself, then merge again. The commit is signed when git config sets commit.gpgsign; a signing failure refuses the merge with git's error. The human approves each merge in the UI unless config approvals.merge is set (a project's .tiller/config.json may only be stricter than the home file); declined gives {ok:false, reason:"denied"}. whenIdle: if the node is working, reply {ok:true, queued:true} at once and merge when its turn ends (or it exits); you then get a framed message with the result, or why it was dropped (node closed, daemon stopped). One queued merge per node. Close the node afterwards to remove its worktree and branch.`,
    { nodeId: z.string().min(1), whenIdle: z.boolean().optional() },
    async (c, a) => {
      const v = requireOwned(c, a.nodeId, false);
      if (!v.worktree) throw new Error(`${v.id} has no worktree of its own to merge`);
      const skip = c.caller === HUMAN || loadConfig(v.worktree.repo, c.manager.home).approvals.merge;
      const later = a.whenIdle && v.status.state === 'working' && !v.status.exited;
      if (!skip && !(await c.confirm(`${who(c)} wants to merge ${v.title} (${v.id}): branch ${v.worktree.branch} into ${v.worktree.base}${later ? ' when its turn ends' : ''}`))) {
        return { data: { ok: false, reason: 'denied' } };
      }
      const w = v.worktree;
      const reply = (merge: Promise<MergeResult>) => merge.then(
        (r) => ({ text: `merged ${w.branch} into ${r.base} (${r.style}), now at ${r.sha.slice(0, 7)}`, data: { ok: true, ...r } }),
        (err) => {
          if (!(err instanceof MergeConflict)) throw err;
          return { text: `${err.message}. Send the worker a rebase instruction: rebase ${w.branch} onto ${w.base}, resolve, commit, then merge again.`, data: { ok: false, conflicts: err.conflicts } };
        });
      if (a.whenIdle) {
        if (c.caller === HUMAN) throw new Error('whenIdle is only for agent nodes: the human has no inbox (tl merge --when-idle waits instead)');
        const caller = c.caller;
        const tell = (merge: Promise<MergeResult>) => void reply(merge).then((r) => r.text, (err: Error) => `merge of ${v.id} failed: ${err.message}`)
          .then((text) => deliver(c.manager, DAEMON, caller, text, { fromLabel: `tiller (queued merge of ${v.id})`, replyTo: null, about: [v.id] })).catch(logError);
        if (await queueMerge(c.manager, v.id, caller, tell)) {
          return { text: `queued: ${v.id} is working; you get a message with the merge result when its turn ends`, data: { ok: true, queued: true } };
        }
      }
      return reply(c.manager.merge(a.nodeId));
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
    'Restart a node: kill its process and relaunch it with a fresh session, which clears its context. Its title, directory and children are kept, and so are a model and effort chosen at spawn (argument or preset); ones that came from config are re-resolved from the current config. `prompt` is its first prompt; without one, a node whose tree has a handoff.md in its session directory is told to read it first. Only the human may call this.',
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
    `Show what a node with its own git worktree (yourself or one of your descendants) changed since it branched from its base: its commits plus its uncommitted and untracked files, as one unified diff of the working tree against where the branch started. Patch text stops after ${MAX_PATCH_BYTES >> 20} MB; the remaining files are listed with their line counts only, as are binary files. The reply is cut at ${MCP_DIFF_CHARS / 1000}k characters; stat true lists only the files and counts.`,
    { nodeId: z.string().min(1), stat: z.boolean().optional() },
    async (c, a) => {
      requireOwned(c, a.nodeId, true);
      const d = await c.manager.diff(a.nodeId);
      const text = diffText(d, !!a.stat);
      if (!c.mcp || text.length <= MCP_DIFF_CHARS) return { text };
      // At the last line break within the cap, so no line (or surrogate pair) is split; the short summary line always fits.
      const cut = text.lastIndexOf('\n', MCP_DIFF_CHARS), kept = text.slice(0, cut);
      // A stat listing has one line per file after the summary line.
      const note = a.stat ? `${d.files.length - (kept.split('\n').length - 1)} more file(s) not listed` : 'call diff with stat true for the file list, or read individual files';
      return { text: `${kept}\n(diff cut at ${MCP_DIFF_CHARS / 1000}k of ${Math.ceil(text.length / 1000)}k characters; ${note})` };
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
      // Exit only once shutdown (bounded) has finished, and no sooner than 100ms so the reply is flushed.
      void Promise.all([c.manager.shutdown({ clearLive: true }).catch(logError), sleep(100)]).finally(() => process.exit(0));
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
    `Report how your own task ended, once, when your work is finished: "succeeded" or "failed" with the report fields; your parent reads them with read what "outcome". If the project configures a completion gate (config \`gate\`), "succeeded" is accepted only once the gate command passes in your directory; on failure the reply gives its output and the attempts left: fix it and report again. A gate still running after 30 seconds is replied to as pending, and a failure then arrives as a message. Any report while your gate runs is refused. With no attempts left the outcome is recorded as failed. Your parent is told of every recorded outcome.`,
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
    ctx.mcp = true;

    const mcp = new McpServer({ name: 'tiller', version: '0.0.0' });
    for (const [name, t] of Object.entries(tools)) {
      if (t.humanOnly && caller !== HUMAN) continue;
      mcp.registerTool(name, { title: t.title, description: t.description, inputSchema: t.shape }, async (args: unknown) => {
        try {
          if (authenticate(req) !== caller) throw new Error('node credentials have expired');
          const out = await t.run(ctx, args as never);
          // The text alone when there is one: it carries what an agent needs, and /api keeps the data for the CLI.
          const text = out.text ?? (out.data === undefined ? undefined : JSON.stringify(out.data));
          return { content: text === undefined ? [] : [{ type: 'text' as const, text }] };
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
