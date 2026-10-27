// Shared contracts between daemon, UI and the agent-facing API. Keep this file small and stable.
import type { Harness, Profile, Effort } from './harness-policy.js';
export { HARNESSES, HARNESS_LABELS, PROFILES, PROFILE_LABELS, EFFORTS, type Harness, type Profile, type Effort } from './harness-policy.js';

/** `agent` is any agent harness; the harness field names which one. `terminal` is a plain login shell. */
export const NODE_KINDS = ['claude', 'agent', 'terminal'] as const;
export type NodeKind = (typeof NODE_KINDS)[number];

/** An agent node runs an agent harness; a terminal node is a shell with no agent behind it. */
export const isAgentKind = (kind: NodeKind): boolean => kind !== 'terminal';

/** Which agent CLI runs an agent node; terminals never call this and legacy nodes default to claude. */
export const harnessFor = ({ harness }: { harness?: Harness }): Harness => harness ?? 'claude';

/**
 * Agent status derived from hook events. 'none' is for plain terminals. 'armed' and 'queued' are nodes with no process
 * yet: armed waits on its dependencies (spawn after / afterSuccess), queued on daemon.maxWorking.
 */
export type AgentState = 'working' | 'waiting' | 'blocked' | 'done' | 'unknown' | 'none' | 'armed' | 'queued';

/** States in which an agent is waiting on the human: a permission prompt or a question. */
export const NEEDS_YOU_STATES: readonly AgentState[] = ['blocked', 'waiting'];
/**
 * A live node waiting on the human. sessions.ts applies the same rule to logged state events, and mod/hooks/notify.ts
 * keeps its own copy (the mod cannot import src/shared).
 */
export const needsYou = (s: NodeStatus) => !s.exited && NEEDS_YOU_STATES.includes(s.state);
/** The node's work has stopped: it exited or finished its turn. */
export const finished = (s: NodeStatus) => !!s.exited || s.state === 'done';

export interface NodeStatus {
  state: AgentState;
  /** Set on 'done' when the turn ended via StopFailure. */
  errored?: boolean;
  /** Set on 'done' when the turn was interrupted (Esc / Ctrl-C). */
  interrupted?: boolean;
  /** How 'done' was reached. Only 'stop' (Stop / StopFailure) counts as verified idle for message delivery. */
  doneSource?: 'stop' | 'idle_prompt' | 'sweep' | 'interrupt' | 'exit';
  /** Set when 'done' was reached only by the 20-minute stale sweep. */
  stale?: boolean;
  /** Set while working with no hook event for limits.stallMinutes; cleared by the next event. changedAt is when activity stopped. */
  stalled?: boolean;
  /** True once the PTY process has exited. */
  exited?: boolean;
  /** Last assistant message text, from Stop / Notification payloads. */
  lastAssistantMessage?: string;
  /** Latest permission_mode seen in a hook payload (default, acceptEdits, plan, auto, bypassPermissions). */
  permissionMode?: string;
  /** prompt_id of the turn in progress or last finished, from UserPromptSubmit. */
  promptId?: string;
  /** Short activity string while working, e.g. "Bash: npm test"; "needs approval: ..." when blocked. */
  activity?: string;
  /** From the mod's session.measure, when available. */
  contextPct?: number;
  contextTokens?: number;
  contextWindow?: number;
  /** Model id (e.g. claude-opus-5-5): SessionStart or the mod's turn.complete; view() falls back to the spawn --model. */
  model?: string;
  /** Latest effort level seen in a hook payload (low, medium, high, xhigh, max). */
  effort?: string;
  /** Spend of the current session only; NodeRecord.spentUsd is the node's total. */
  costUsd?: number;
  /** Live git state of the node's worktree; absent when it owns none. Not persisted: recomputed on daemon start. */
  git?: GitState;
  /** Wall-clock ms of the last event that changed state. */
  changedAt: number;
}

/** Which role prompt an agent node gets; 'none' means no role section. Default: root = orchestrator, child = worker. */
export const ROLES = ['orchestrator', 'worker', 'none'] as const;
export type Role = (typeof ROLES)[number];

/** Explicit profile wins; otherwise the effective coordination role selects its coherent task default. */
export const profileFor = (profile: Profile | undefined, parentId: string | null, role?: Role): Profile =>
  profile ?? ((role ?? (parentId ? 'worker' : 'orchestrator')) === 'orchestrator' ? 'orchestrator' : 'implementation');

export const ISOLATIONS = ['none', 'worktree'] as const;
export type Isolation = (typeof ISOLATIONS)[number];

/** A worker's own git worktree: <repo>/.claude/worktrees/<nodeId> on branch tl/<nodeId>, branched from base at baseSha. */
export interface Worktree {
  /** The main checkout root; the PTY starts here with `claude --worktree <nodeId>`. */
  repo: string;
  path: string;
  branch: string;
  /** Symbolic base ref at spawn time (for example main), or the sha when HEAD was detached. */
  base: string;
  baseSha: string;
  /** True when the directory is gone from disk or from `git worktree list`; resume is refused until it is recreated. */
  missing?: boolean;
  /** The branch tip and time of the last merge: a squashed branch counts as merged until it moves. */
  merged?: { tip: string; at: number };
}

/** A worktree node's branch against its base, refreshed when its turn ends, after edits, on exit, merge and close. */
export interface GitState {
  branch: string;
  base: string;
  /** Commits on the branch that are not in base, and in base that are not on the branch. */
  ahead: number;
  behind: number;
  /** Uncommitted files in the worktree (modified, staged or untracked). */
  dirty: number;
  /** Lines added and removed by the node's work so far: the same numbers as the diff view (see Diff). */
  additions: number;
  deletions: number;
  /** When tiller last merged the branch into base; cleared once the branch moves past what was merged. */
  mergedAt?: number;
  /** Files that would conflict if base were merged into the branch now (git merge-tree); absent when it merges cleanly. */
  conflicts?: string[];
}

/** One file of a worktree node's diff. Binary files have no patch; neither do files past the 2 MB patch cap (Diff.truncated). */
export interface DiffFile {
  path: string;
  status: 'added' | 'modified' | 'deleted' | 'renamed';
  additions: number;
  deletions: number;
  binary?: boolean;
  /** Unified diff of this file, from its `diff --git` header line. */
  patch?: string;
}

/** Everything a worktree node changed since it branched: its commits and its uncommitted and untracked files, as one diff. */
export interface Diff { base: string; branch: string; files: DiffFile[]; truncated?: boolean }

/** What an armed or queued node still waits for before it launches; persisted so a restarted daemon re-arms it. */
export interface Pending {
  /** Launch once each of these has finished a turn begun after this node was created, or has exited. */
  after: string[];
  /** Launch once each of these reported succeeded; a failed report blocks. */
  afterSuccess: string[];
  /** Dependencies already met, so a restarted daemon does not wait for them again. */
  met: string[];
  /** The first prompt and isolation to launch with. The prompt is not sent to the UI. */
  prompt?: string;
  isolation?: Isolation;
  /** The worktree's base branch, resolved at spawn; absent in records from before it was, which fork from the cwd's HEAD. */
  base?: string;
  /** Launch past daemon.maxWorking (the human's tl spawn --now). */
  now?: boolean;
  /** The failed dependency, "n-x: note", once its parent has been told. */
  blocked?: string;
}

export interface NodeRecord {
  id: string;
  parentId: string | null;
  kind: NodeKind;
  /** Which agent CLI runs the node. Absent on legacy records and terminals; an agent defaults to claude. */
  harness?: Harness;
  title: string;
  cwd: string;
  model?: string;
  effort?: Effort;
  /** Which of model and effort the spawn chose (argument or preset); restart re-resolves the others from current config. Absent only on records from before this field: restart then keeps just what their preset sets. */
  explicit?: ('model' | 'effort')[];
  /** Tiller Claude account name (home config claude.accounts), set at spawn and inherited from the parent; never re-resolved. Absent: Claude's default home. */
  account?: string;
  permissionMode?: string;
  /** Explicit role override; absent means derive from parentId at each launch. */
  role?: Role;
  /** Resolved task profile at spawn; absent on legacy records, derived from parentId. */
  profile?: Profile;
  /** The spawn preset (.tiller/agents/<name>.md); its body and tool lists are re-read at each launch. */
  preset?: string;
  /** Set on a node that owns a git worktree (spawned with isolation "worktree"); its cwd is the worktree path. */
  worktree?: Worktree;
  createdAt: number;
  /** When the node last launched or changed state on a hook; resume on start skips nodes idle longer than daemon.resumeMaxAgeDays. */
  lastActiveAt?: number;
  /** Set while a turn is in progress (working, waiting or blocked), so the next daemon can tell the node its turn was cut off. */
  midTurn?: boolean;
  /** Harness session id: minted at launch, updated from SessionStart. Persisted so a restarted daemon can offer Resume. */
  sessionId?: string;
  /** Harness transcript file, from SessionStart (or found by resume). Persisted so Resume can find it. */
  transcriptPath?: string;
  /** Session ids from before each restart or harness change, oldest first (at most 10). */
  previousSessions?: string[];
  /** Explicit locations/decoders for prior sessions, which may have used another harness. Not sent to the UI. */
  sessionHistory?: SessionRecord[];
  /** Credential generation after a harness change; absent keeps legacy credentials compatible. */
  credentialGeneration?: string;
  /** Total spend in USD across all of the node's sessions, summed from the mod's session.measure. */
  spentUsd?: number;
  /** Set once a session reported usage it could not price (cost.incomplete): spentUsd is then only a lower bound. Never cleared. */
  spentIncomplete?: boolean;
  /** Spend on one local day (YYYY-MM-DD); a later day starts over. `incomplete`: unpriced usage was added that day (cost.unpricedAdded). */
  spentToday?: { day: string; usd: number; incomplete?: boolean };
  /** The session's cumulative cost at its last measure, so the next measure (even after a daemon restart) adds only the difference. */
  lastCost?: { sessionId?: string; usd: number };
  /** Set by the human (tl mute, the row's mute button): the node never sends an OS notification. */
  muted?: boolean;
  /** Set while the node is armed or queued; cleared when it launches. */
  pending?: Pending;
  /** The first prompt it was spawned with, kept for the archive. Not sent to the UI. */
  prompt?: string;
  /** The root of its tree, set at spawn so the node keeps its session directory after an ancestor closes; absent on a root. */
  rootId?: string;
  /** The node whose conversation this one was forked from (spawn fork): live or archived. */
  forkOf?: string;
  /** The session a fork starts from, until it has launched (--resume <forkSession> --fork-session). */
  forkSession?: string;
  /** The archived node whose session this one continues (followup). */
  followupOf?: string;
}

/** Do not disturb: while on (and before `until`, when set) the daemon sends no OS notifications. Not persisted. */
export interface Dnd { on: boolean; until?: number }
export const dndActive = (dnd: Dnd | undefined, now: number) => !!dnd?.on && (dnd.until === undefined || now < dnd.until);

/** What a node reported through report_outcome. Not persisted: a restarted daemon forgets it. */
export interface Outcome {
  outcome: 'succeeded' | 'failed';
  note?: string;
  summary?: string;
  changedFiles?: string[];
  /** What was run to check the work, and its result. */
  verified?: string;
  openQuestions?: string[];
  /** Set when a completion gate (config `gate`) decided the outcome. */
  gate?: 'passed' | 'failed';
  at: number;
}

export interface NodeView extends NodeRecord {
  status: NodeStatus;
  unread: boolean;
  outcome?: Outcome;
  /** The completion gate's last run for this node: running now, or how it ended. */
  gate?: 'running' | 'passed' | 'failed';
  changingHarness?: boolean;
  /** On a root Claude node: the account a new session in its repository would run in now, when that differs from `account`; null for no account (Claude's default home). A new session is needed to switch. */
  repoAccount?: string | null;
}

export interface SessionRecord { sessionId: string; harness: Harness; transcriptPath: string }

/** One user or assistant message of a node's conversation, for the transcript viewer. `tools` names the tools an assistant message called. */
export interface TranscriptEntry { role: 'user' | 'assistant'; at?: number; text: string; tools?: string[] }
/** A node's conversation (live or archived). `sessions` lists the sessions on record, current first; `truncated` when older entries were cut. */
export interface Transcript { entries: TranscriptEntry[]; sessions: { sessionId: string; current: boolean; harness?: Harness }[]; truncated?: boolean }

/** What close keeps of a Claude node so it can be found, read, followed up or forked later. One line per node in <sessionDir>/archive.jsonl. */
export interface ArchivedNode {
  id: string;
  rootId: string;
  parentId: string | null;
  title: string;
  cwd: string;
  /** Which agent CLI ran the node; absent on legacy records and terminals (default claude). */
  harness?: Harness;
  model?: string;
  effort?: Effort;
  /** NodeRecord.explicit, so a follow-up keeps it. */
  explicit?: ('model' | 'effort')[];
  /** NodeRecord.account, so a follow-up stays in the same Claude account. */
  account?: string;
  role?: Role;
  profile?: Profile;
  /** The first prompt the node was spawned with. */
  prompt?: string;
  sessionId?: string;
  previousSessions?: string[];
  sessionHistory?: SessionRecord[];
  transcriptPath?: string;
  lastAssistantMessage?: string;
  outcome?: Outcome;
  /** One plain line (at most 200 characters) saying what the node did and how it ended, for an agent deciding whether to resume or fork it: the reported outcome's summary or note when there is one, else the first line of its last message. */
  brief?: string;
  spentUsd?: number;
  spentIncomplete?: boolean;
  /** The session's cumulative cost at its last measure (NodeRecord.lastCost), so a follow-up resuming that session does not count it again. */
  lastCost?: { sessionId?: string; usd: number };
  /** The worktree branch it worked on, when it had one. */
  branch?: string;
  /** What became of that branch at close, decided by the close check itself: merged into `base`, kept with a WIP commit (unmerged), or discarded with unmerged work. */
  branchFate?: 'merged' | 'kept' | 'discarded';
  /** The branch it merged into, when branchFate is merged. */
  base?: string;
  createdAt: number;
  closedAt: number;
}

/** One rate-limit window as Claude Code's `session.measure` reports it; `kind` is five_hour, seven_day or a gateway's spend_limit. */
export interface RateLimit { kind: string; percentUsed: number; resetsAt?: string; windowId?: string; observedAt?: number }
/** Legacy latest Claude account report, retained for CLI consumers. */
export interface Usage { rateLimits: RateLimit[]; nodeId: string; at: number; /** Tiller Claude account label, stamped by the daemon. */ account?: string }

/** Prepared by the daemon only after notification suppression, grouping and sound policy. */
export interface NativeNotification { id: string; title: string; subtitle?: string; body: string; sound: boolean }
/** Usage discovery is independent of live nodes. null means not verified, not absent. */
export type UsageTool = Harness;
export interface UsageSource {
  id: string;
  tool: UsageTool;
  provider?: string;
  accountId?: string;
  /** Tiller Claude account label stamped by the daemon (not the provider's accountId). */
  account?: string;
  pool?: string;
  poolId?: string;
  model?: string;
  scope: 'account' | 'model';
  nodeIds: string[];
  installed: boolean | null;
  version?: string;
  executableStatus?: 'ready' | 'broken' | 'unknown';
  configured: boolean | null;
  authenticated: boolean | null;
  availability: 'available' | 'unavailable' | 'unknown';
  detail?: string;
  rateLimits: RateLimit[];
  /** Last quota report; discovery alone never makes a retained report fresh. */
  at?: number;
  checkedAt: number;
}
/** A quota report from an adapter; tool identity comes from the authenticated node. */
export interface UsageReport {
  provider?: string; accountId?: string; pool?: string; poolId?: string; model?: string;
  /** Tiller Claude account label; the daemon sets it from the reporting node, never trusted from the adapter. */
  account?: string;
  scope: 'account' | 'model'; rateLimits: RateLimit[];
  /** Explicit full-read removals, ordered against window observations. Omission is a sparse update. */
  removedWindows?: { windowId: string; observedAt: number }[];
}

/** A configured Claude account (home config claude.accounts) with its login state. loggedIn null: not checked or unknown. */
export interface ClaudeAccountView {
  name: string; configDir?: string; projects: string[]; isDefault: boolean;
  loggedIn: boolean | null; email?: string; orgName?: string; loginCommand: string; error?: string;
}

/** Published stable GitHub release, pinned to its tag object and peeled commit. */
export interface ReleaseUpdate {
  id: number; tag: string; name: string; body: string; publishedAt: string; sha: string; tagObject: string;
}
/** Notes for a proven installed release; identity must be echoed when read. */
export interface InstalledReleaseNotes { identity: string; releases: ReleaseUpdate[] }
export interface UpdateStatus {
  runtimeSha?: string; sha: string; checkedAt: number; eligible: boolean; reason?: string; fetchError?: string;
  repository?: string; origin?: string; currentVersion?: string; target?: ReleaseUpdate; releases: ReleaseUpdate[];
  installedNotes?: InstalledReleaseNotes;
  blocker?: 'dirty';
  checking?: boolean; applying?: boolean; failed?: string;
}

/** A restart waiting for agents to finish their turns; message deliveries and agent spawns are held meanwhile. */
export interface Drain {
  /** Why the daemon restarts, such as "tl reload" or "update to v1.2.3". */
  reason: string;
  /** The agent nodes whose turn is still running. */
  waiting: { id: string; title: string }[];
  /** The human asked to restart now; the restarting helper stops waiting. */
  force?: boolean;
}

// Daemon -> UI (WebSocket, JSON). One message per line.
export type ServerMessage =
  | { t: 'update'; update: UpdateStatus }
  | { t: 'claudeAccounts'; accounts: ClaudeAccountView[] } // reply to the claudeAccounts request
  // nodes, like 'node' messages, omit prompt, pending.prompt and sessionHistory
  | { t: 'snapshot'; nodes: NodeView[]; update?: UpdateStatus; usage?: Usage; usageSources?: UsageSource[]; dnd?: Dnd; drain?: Drain; sessionOrder?: string[] } // sessionOrder: root ids in tab order
  | { t: 'sessionOrder'; ids: string[] }    // the human rearranged the session tabs
  | { t: 'drain'; drain?: Drain }            // a restart started, progressed or ended waiting for agents
  | ({ t: 'dnd' } & Dnd)                     // do not disturb changed
  | { t: 'usageSources'; sources: UsageSource[] }
  | { t: 'usage'; usage: Usage }             // a node reported new account-level rate limits
  | { t: 'node'; node: NodeView }            // created or updated (full record minus spawn prompts and sessionHistory)
  | { t: 'removed'; id: string }
  | { t: 'data'; id: string; data: string }  // raw PTY output
  | { t: 'nativeNotify'; requestId: string; notification: NativeNotification }
  | { t: 'notify'; id: string; kind: 'done' | 'needsYou' | 'errored' | 'exited'; title: string; body?: string }
  | { t: 'confirm'; confirmId: string; text: string } // ask the human to approve an agent action
  | { t: 'confirmDone'; confirmId: string }  // that confirm was answered or timed out; close the modal
  | { t: 'error'; message: string; id?: string }
  | { t: 'focus'; from: string; id: string }   // a node's mod asked to view node `id`; an attach client showing `from` switches
  | { t: 'digest'; since: number; items: DigestItem[] } // what happened while no client was focused; sent to the client that regained focus
  | ({ t: 'diff'; id: string } & (Diff | { error: string })) // reply to a diff request: the diff, or why there is none
  | ({ t: 'transcript'; id: string; sessionId?: string } & (Transcript | { error: string })) // reply to a transcript request
  | ({ t: 'conversations'; id: string } & ({ items: ConversationSummary[] } | { error: string })) // reply to a conversations request
  | ({ t: 'conversation'; id: string; with?: string } & (Conversation | { error: string })) // reply to a conversation request
  | { t: 'history'; items: ArchivedNode[] }   // reply to a history request, newest closed first
  | { t: 'sent'; id: string; result: SendResult } // reply to a send request
  ;

/** One node's line in the away digest: still needs you, errored or failed, or finished (with its outcome note). */
export interface DigestItem { id: string; title: string; kind: 'needsYou' | 'errored' | 'finished'; text?: string; at: number }

// UI -> Daemon.
export type ClientMessage =
  | { t: 'update'; tag: string; sha: string }
  | { t: 'claudeAccounts' }                  // list configured Claude accounts with their login state
  | { t: 'updateCheck' }
  | { t: 'restartNow' }                       // stop waiting for agents and restart the daemon at once
  | { t: 'updateNotesRead'; identity: string }
  | { t: 'auth'; token: string; client?: 'app' | 'browser' } // must be the first message; token comes from the ?k= query param of the served UI URL
  | { t: 'nativeNotifyReady'; ok: boolean; error?: string }
  | { t: 'nativeNotifyResult'; requestId: string; ok: boolean; error?: string }
  | { t: 'usageRefresh' }                    // bounded local CLI discovery; never starts inference
  | { t: 'visibility'; focused: boolean }       // whether this client's window is in front; the daemon skips OS notifications for a node a focused client has selected
  | { t: 'attach'; id: string; cols: number; rows: number } // start receiving data; replies with a data message holding the serialized screen
  | { t: 'detach'; id: string }
  | { t: 'input'; id: string; data: string; binary?: boolean } // binary: data contains raw byte values (xterm legacy mouse reports)
  | { t: 'resize'; id: string; cols: number; rows: number }
  | { t: 'select'; id: string }                // clears unread
  | { t: 'spawn'; kind: NodeKind; harness?: Harness; title: string; cwd: string; prompt?: string; model?: string; effort?: Effort; role?: Role; profile?: Profile; parentId?: string | null; isolation?: Isolation; base?: string; preset?: string; after?: string[]; afterSuccess?: string[]; now?: boolean; fork?: string; account?: string } // account: Claude account name, human only (children inherit); fork: a live or archived node id whose conversation the new node starts from (claude --resume <session> --fork-session); the node must run the claude harness
  | { t: 'close'; id: string; force?: boolean; worktree?: 'keep' | 'discard' }  // a root (orchestrator) is refused without force; worktree picks what happens to a dirty or unmerged worktree (default: refuse)
  | { t: 'merge'; id: string }                 // merge a worktree node's branch into its base, in the worktrees.mergeStyle style
  | { t: 'restart'; id: string; prompt?: string } // relaunch with a fresh session: clears context, keeps the node and its children; prompt is its first prompt
  | { t: 'changeHarness'; id: string; harness: Harness; prompt?: string } // human only: fresh context, target defaults; preserve node and history
  | { t: 'resume'; id: string }
  | { t: 'prune' }                             // remove every exited node that has no live descendant
  | { t: 'rename'; id: string; title: string }
  | { t: 'confirm'; confirmId: string; ok: boolean }
  | { t: 'diff'; id: string }                  // a worktree node's diff; replies diff, with error for a node without a worktree
  | { t: 'transcript'; id: string; sessionId?: string } // a live or archived Claude node's conversation (default: its current session); replies transcript
  | { t: 'conversations'; id: string }             // a live or archived node's conversation list; replies conversations
  | { t: 'conversation'; id: string; with?: string } // the upward conversation of id, or its peer conversation with `with`; replies conversation
  | { t: 'history'; rootId?: string; query?: string } // archived nodes, of one tree or all, optionally filtered by text in title, prompt or last message; replies history
  | { t: 'followup'; id: string; prompt: string; title?: string } // continue an archived node's session as a new live node (claude --resume <session>) that starts on `prompt`; replies node (or error)
  | { t: 'send'; id: string; text: string; mode?: SendMode } // a message from the human, as `tl send` delivers it; replies sent
  | { t: 'mute'; id: string; muted: boolean }  // the human mutes or unmutes a node's OS notifications
  | { t: 'dnd'; on: boolean; minutes?: number } // do not disturb on (for minutes, else until turned off) or off
  | { t: 'sessionOrder'; ids: string[] }    // save the session tab order (root ids, left to right); broadcast to every client
  ;

// Outcome of delivering a message into an agent node (PLAN.md §6).
export type SendOutcome = 'delivered' | 'queued' | 'stalled' | 'expired' | 'queueFull' | 'gone' | 'refused' | 'withdrawn';

/** One row of a node's conversation list. Participants are node ids, 'human' or 'tiller' (the daemon). */
export interface ConversationSummary {
  /** Request params that open it: `id` is the subject (upward conversation) or this node (peer); `with` is the peer. */
  id: string; with?: string;
  /** As seen from the node the list is for; a root's parent row has counterpart 'human'. */
  relation: 'parent' | 'child' | 'peer';
  counterpart: string; title: string; live: boolean;
  /** A closed counterpart, so the UI can open its pane. */
  archived?: ArchivedNode;
  messages: number; lastAt?: number; outcome?: Outcome['outcome'];
}
export type ConversationItem =
  | { kind: 'brief'; at: number; from: string; text: string }
  /** text absent: sent before message text was recorded. at is the delivery time when known, sentAt when it was sent. */
  | { kind: 'message'; at: number; sentAt: number; from: string; to: string; text?: string; label?: string; messageId: string; delivery: SendOutcome; steer?: true }
  /** The subject's own transcript entry; a prompt typed directly into it has from 'human'. */
  | { kind: 'turn'; at?: number; from: string; role: 'user' | 'assistant'; text: string; tools?: string[] }
  | { kind: 'outcome'; at: number; from: string; outcome: Outcome }
  /** A lifecycle marker such as merged, closed or restarted. */
  | { kind: 'event'; at: number; id: string; text: string };
export interface Conversation { a: string; b: string; relation: 'parent' | 'peer'; titles: Record<string, string>; items: ConversationItem[]; truncated?: boolean }
/** "queue" waits for the target to be idle; "now" interrupts a working target first (a steer). */
export type SendMode = 'queue' | 'now';
/** `steer` is set when the message interrupts (or interrupted) the target's running turn. */
export interface SendResult { outcome: SendOutcome; retryable: boolean; detail?: string; messageId?: string; steer?: true }

// Mod-facing HTTP API (PLAN §14). All routes authenticate like /hook: Authorization bearer + X-TL-Node.
// The per-node mod (mod/) polls these; the daemon treats a node as "mod-live" while polls keep arriving.

/** GET /inbox → InboxMessage[] (unacked messages for the calling node, oldest first). */
/** `steer`: abort the running turn and submit now; otherwise the mod holds it until no turn runs, so it can be withdrawn. */
export interface InboxMessage { id: string; from: string; text: string; enqueuedAt: number; steer?: true; claimed?: true }
/** POST /claim { id } → 204, or 404 if it was withdrawn or expired. Sent just before $.prompt.submit; a claimed message can no longer be withdrawn. */
/** POST /release { id } → 204, or 404 if it is no longer a claimed message of this node. Hands back a claim that was never submitted: queued, withdrawable and retryable again. */
/** POST /ack { id } → 204. Sent only on native prompt acceptance (the turn started). */
/** POST /unconfirmed { id } → 204. Retires this node's claimed prompt as stalled/nonretryable, never delivered. */
/** POST /mod-event { event, payload } → 204. */
export type ModEvent =
  | { event: 'turn.start'; payload: { text: string; turnId: string } }
  | { event: 'turn.complete'; payload: { answer?: string; durationMs: number; isAborted: boolean; turnId: string; reason: 'answer' | 'aborted' | 'refusal' | 'error'; usage?: Record<string, unknown> } }
  | { event: 'session.measure'; payload: { model?: string; context?: { tokens: number; window: number; percent: number }; cost?: { usd: number; incomplete?: boolean; unpricedAdded?: boolean }; rateLimits?: RateLimit[]; usageReports?: UsageReport[]; usageUnavailable?: boolean } };
/** POST /focus { id } → 204; the daemon broadcasts `focus` to ws clients (PLAN §14). */
/** GET /tree → ChildView[]: the calling node's whole tree from its root, depth-first. */
export interface ChildView {
  id: string; title: string; depth: number; state: AgentState;
  /** True on the calling node's own row. */
  self?: boolean;
  parentId?: string | null;
  errored?: boolean; interrupted?: boolean; exited?: boolean;
  activity?: string; ageSec: number; lastMessage?: string; unread: boolean; contextPct?: number;
}
