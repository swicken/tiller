import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { stripVTControlCharacters } from 'node:util';
import { chmodSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { type Profile, harnessFor, isAgentKind, NEEDS_YOU_STATES, type Harness, type ArchivedNode, type Diff, type DigestItem, type Drain, type Transcript, type GitState, type ModEvent, type NodeKind, type NodeRecord, type NodeStatus, type NodeView, type Outcome, type Effort, type Isolation, type Role, type Usage, type Worktree } from '../shared/protocol.js';
import { loadConfig, type Config } from './config.js';
import { UsageRegistry } from './usage.js';
import { accountForProject, claudeConfigDir, claudeHomeOf, claudeHomes } from './claude-accounts.js';
import { homeDir } from './home.js';
import { ensurePresets, loadPreset, type Preset } from './presets.js';
import { projectMcpServerNames, terminalLaunch, writeNodeFiles, type LaunchInput } from './launch.js';
import { adapterFor, requireHarnessExecutable } from './harness.js';
import { pruneIds } from '../shared/prune.js';
import { dayKey } from '../shared/spend.js';
import { treeOrder } from '../shared/tree.js';
import { isSupportedEffort } from '../shared/harness-policy.js';
import { arm, scheduleSoon, working } from './scheduling.js';
import { CompletionGate, gateFor } from './completion-gate.js';
import type { CompletionWatches } from './completion-watches.js';
import { NodeTokens } from './node-tokens.js';
import { lifecycleRefusal } from './lifecycle-guards.js';
import { nodeDefaults, resolveSpawn, restartSelection, spawnTarget } from './spawn-policy.js';

import { DAEMON, deliver, handoverInbox, holdDeliveries, HUMAN, inScope, saveInboxForRestart, submitting, waitForDeliveries } from './messaging.js';
import { NodeRegistry } from './nodes.js';
import { buildChildEnv, PtySession } from './pty.js';
import { count, inside, logError } from './util.js';
import * as wt from './worktree.js';
import { addWorktree, closeWorktreeNode, dropQueuedMerges, gitSettled, mergeWorktree, readClaudeJson, refreshGit, refreshGitSoon, refreshMovedTips, setMissing, setupThenLaunch, trustedForWorktree, trustPolicy, worktreeCheck, worktreeCommands, worktreeEnv, worktrees, type MergeResult, type WorktreeCheck, type WorktreeReport } from './worktree-lifecycle.js';
import { appendEvent, buildDigest, ensureSession, flushEvents, handoffPrompt, listSessions, markClosed, readEvents, sessionDir, sweepSessions } from './sessions.js';
import { archivedOf, archiveNode, findArchived, type BranchFate } from './archive.js';
import { adoptSessionHistory, nodeTranscript, recordedSessions, transcriptFor } from './transcript.js';
import { active, initialState, interruptKeyPressed, interruptTimeout, ptyExited, reduce, stall, sweep, turnComplete, type HookEvent } from './status.js';


const MAX_PREVIOUS_SESSIONS = 10;
/** The node's earlier sessions then its current one, the newest MAX_PREVIOUS_SESSIONS. */
const sessionChain = (rec: NodeRecord) => [...(rec.previousSessions ?? []), ...(rec.sessionId ? [rec.sessionId] : [])].slice(-MAX_PREVIOUS_SESSIONS);
const INTERRUPT_MS = 1500;
const SWEEP_MS = 60_000;
const TRUST_WATCH_MS = 20_000;
/** How the Pi adapter prints an activation refusal to stderr (adapters/pi/index.ts report). */
const PI_REFUSAL = '[tiller] tiller: ';
const TRUST_BLOCKED_ACTIVITY = 'Trust dialog: answer it in the terminal';
/** The marker (U+276F) Claude draws in front of the selected option of a dialog. */
const SELECTED = String.fromCodePoint(0x276f);
const DEFAULT_SIZE = { cols: 120, rows: 40 };
const GIT_EDIT_TOOLS = ['Edit', 'Write', 'Bash'];
/** At most one cost event per node in this long. */
const COST_EVENT_MS = 60_000;
/** A drain ends by itself when whoever restarts the daemon has not polled it for this long (it died or was stopped). */
const DRAIN_LEASE_MS = 15_000;
/** Shutdown waits at most this long for processes and background work; restartDaemon allows the old daemon 10s. */
const SHUTDOWN_WAIT_MS = 7000;

/** The daemon's message to a resumed node whose turn the restart cut off. */
export const cutOffText = (reason: string) => `The tiller daemon restarted (${reason}) while your turn was running, so that turn was cut off. Your conversation is intact, but the last tool call may not have finished. Check where you were, for example with git status and the commands you last ran, then continue the task.`;

/** `cwd`, or the main checkout when it was a worktree since removed; undefined when neither exists. */
function usableCwd(cwd: string): string | undefined {
  if (existsSync(cwd)) return cwd;
  const at = cwd.indexOf(`${sep}${wt.WORKTREES_DIR}${sep}`), repo = at >= 0 ? cwd.slice(0, at) : undefined;
  return repo && existsSync(repo) ? repo : undefined;
}

/**
 * A Claude worktree record's transcript paths that name a missing file where the worktree's project dir holds it: from
 * before applyHook corrected the main checkout's path that a resumed session reports. Undefined when none changes.
 */
function repairedTranscripts(n: NodeRecord, claudeHome: string): Pick<NodeRecord, 'transcriptPath' | 'sessionHistory'> | undefined {
  if (!n.worktree || harnessFor(n) !== 'claude') return undefined;
  const repair = (sid: string | undefined, path: string | undefined) => {
    const real = sid && path && !existsSync(path) ? transcriptFor(n.worktree!.path, sid, claudeHome) : undefined;
    return real && existsSync(real) ? real : path;
  };
  const transcriptPath = repair(n.sessionId, n.transcriptPath);
  const sessionHistory = n.sessionHistory?.map((s) => (s.harness === 'claude' ? { ...s, transcriptPath: repair(s.sessionId, s.transcriptPath)! } : s));
  const changed = transcriptPath !== n.transcriptPath || sessionHistory?.some((s, i) => s.transcriptPath !== n.sessionHistory![i]!.transcriptPath);
  return changed ? { transcriptPath, sessionHistory } : undefined;
}

export interface SpawnRequest {
  kind: NodeKind;
  harness?: Harness;
  title: string;
  cwd: string;
  prompt?: string;
  model?: string;
  effort?: Effort;
  permissionMode?: string;
  role?: Role;
  profile?: Profile;
  parentId?: string | null;
  isolation?: Isolation;
  /** Worktree isolation only: the branch the worktree forks from and merges into, created at the cwd's HEAD if absent. */
  base?: string;
  /** A spawn preset's name; its fields fill in what the request leaves unset (see resolveSpawn). */
  preset?: string;
  /** Set for the human's spawns (web UI, app, admin token), which skip the spawn caps. */
  byHuman?: boolean;
  /** Arm the node: launch it once each of these has finished a turn begun after this spawn, or has exited. */
  after?: string[];
  /** Arm the node: launch it once each of these reported succeeded. A failed report blocks it. */
  afterSuccess?: string[];
  /** Launch past daemon.maxWorking instead of queueing (the human's tl spawn --now). */
  now?: boolean;
  /** A live or archived claude node whose conversation the new node starts from (claude --fork-session); cwd defaults to its. */
  fork?: string;
  /** The archived node whose session the new node continues (see followup). */
  followup?: ArchivedNode;
  /** A Claude account name (home config claude.accounts); the human's root spawns only. Absent: a child's parent's, else by project. */
  account?: string;
}

export interface ManagerOptions {
  /** Defaults to TL_HOME, then ~/.tiller. */
  home?: string;
  /** Shell for terminal nodes. Defaults to $SHELL, then /bin/sh. */
  shell?: string;
  /** PATH handed to children (from loginShellPath()). Defaults to this process's PATH. */
  path?: string;
  /** How long changeHarness waits for the old process to exit, and shutdown for its background work. Defaults to PtySession.terminate's. */
  terminateTimeoutMs?: number;
}

export interface NotifyEvent { id: string; kind: 'done' | 'needsYou' | 'errored' | 'exited'; title: string; body?: string }

/**
 * What the daemon holds for one node besides its record; none of it is persisted. Created with the node (spawn, or the
 * record loaded at start) and deleted with it in discard, so nothing per node outlives it.
 */
export interface NodeRuntime {
  /** Unset only while a new worktree node's tree is being created: view() hides the node until then. */
  status?: NodeStatus;
  /** The live PTY; unset once the process has gone. */
  session?: PtySession;
  /** The preset passed to the latest launch (empty for no preset), not a later edit of its file. */
  launchedPreset?: Partial<Preset>;
  unread?: boolean;
  lastHookAt?: number;
  interruptTimer?: NodeJS.Timeout;
  /** Set while the node's worktree is being created, closed or merged, or its harness changed; each excludes the others. */
  busy?: 'creating' | 'closing' | 'merging' | 'changing harness';
  /** A failed harness-change stop still owns the lifecycle lock until its actual process exits. */
  stoppingAfterFailedChange?: boolean;
  git?: GitState;
  gitTimer?: NodeJS.Timeout;
  /** A worktree setup in progress, so close can stop it. */
  setup?: { abort: AbortController; done: Promise<void> };
  /** Set until the worktree setup succeeds, with the prompt to launch with once it does; restart retries it. */
  needsSetup?: { prompt: string | undefined };
  /** What the node reported through report_outcome. */
  outcome?: Outcome;
  /** The completion gate's last run, with the failed runs since the node's last outcome. */
  gate?: CompletionGate;
  lastCostEvent?: number;
  /** When the latest turn began (UserPromptSubmit), for after dependencies and notify_when. */
  turnStart?: number;
  /** An agent node launched with a prompt whose first turn has not begun: it counts against daemon.maxWorking. */
  starting?: boolean;
  /** Armed from the record at start; it waits for resumeLive, which runs once the daemon has its endpoint. */
  restored?: boolean;
  /** The notify_when registrations this node made; discarded with its runtime. */
  watches?: CompletionWatches;
}

/**
 * Owns the registry, the live PTYs and the per-node status. Events (node:events):
 *   'node'    (view: NodeView)            created or changed
 *   'removed' (id: string)
 *   'outcome' (id: string)               report_outcome recorded an outcome, before the 'node' event that shows it
 *   'hook'    (id: string, event: HookEvent)  every accepted hook, before status is updated
 *   'data'    (id: string, data: string)  raw PTY output
 *   'notify'  (n: NotifyEvent)
 *   'usage'   (u: Usage)                  a node reported account-level rate limits
 */
export class NodeManager extends EventEmitter {
  readonly home: string;
  readonly registry: NodeRegistry;
  /** Newest account-level rate limits from any node. Not persisted: the next measure after a restart refills it. */
  usage?: Usage;
  /** The newest Claude report per Tiller account ('' for nodes without one), so an agent sees its own account's. */
  readonly usageByAccount = new Map<string, Usage>();
  readonly usageRegistry: UsageRegistry;
  /** Base URL of the daemon, set by the server once it knows its port. */
  endpoint = '';
  /** Whether any connected UI client has node `id` selected; set by the server. A selected node never turns unread. */
  isSelected: (id: string) => boolean = () => false;
  /** Each node's runtime state; see NodeRuntime. worktree-lifecycle.ts and scheduling.ts use it too. */
  readonly runtimes = new Map<string, NodeRuntime>();
  /** PATH handed to children. */
  readonly path: string;
  /** Set by shutdown: the live set is then frozen, so the PTYs' exits do not empty it. */
  private shutDown = false;
  private shell: string;
  private readonly terminateTimeoutMs?: number;
  private readonly tokens: NodeTokens;
  private sweepTimer: NodeJS.Timeout;
  /** Ids that were live when the daemon last went away, until resumeLive has dealt with them. */
  private pendingResume: Set<string>;
  /** Why the daemon last went away, for the message to the nodes whose turn it cut off. */
  private lastStop: string;
  /** Set while a restart waits for turns to end; see drain. */
  private drainState?: { reason: string; exclude?: string; force?: boolean; lease: NodeJS.Timeout };
  /** projectDir's main checkout of each cwd outside a worktree node. */
  private projectDirs = new Map<string, string>();
  /** repoAccountOf per node, computed on first view; refreshRepoAccounts recomputes it after a config change. */
  private repoAccounts = new Map<string, string | null | undefined>();

  constructor(opts: ManagerOptions = {}) {
    super();
    this.home = opts.home ?? homeDir();
    this.shell = opts.shell ?? process.env.SHELL ?? '/bin/sh';
    this.path = opts.path ?? process.env.PATH ?? '';
    this.terminateTimeoutMs = opts.terminateTimeoutMs;
    this.usageRegistry = new UsageRegistry(this.path, () => claudeHomes(this.home).filter((d): d is string => !!d));
    mkdirSync(join(this.home, 'nodes'), { recursive: true, mode: 0o700 });
    chmodSync(this.home, 0o700); // mkdir's mode does not apply to a directory that already existed
    ensurePresets(this.home);
    this.tokens = new NodeTokens(this.home);
    this.registry = new NodeRegistry(join(this.home, 'state.json'));
    this.registry.load();
    this.pendingResume = new Set(this.registry.live);
    this.lastStop = this.registry.stopped ?? 'unexpected exit';
    if (this.registry.stopped) this.registry.setStopped(undefined); // a later crash must not read it again
    // Nodes from a previous run have no process; they can be resumed.
    for (const n of this.registry.list()) {
      if (n.parentId && !n.rootId) this.registry.update(n.id, { rootId: this.rootIdOf(n.id) }); // records from before rootId
      const repaired = repairedTranscripts(n, claudeHomeOf(this.home, n.account));
      if (repaired) this.registry.update(n.id, repaired);
      if (n.pending) {
        this.runtimes.set(n.id, { restored: true, status: { state: 'armed', changedAt: Date.now() } });
        continue;
      }
      this.runtimes.set(n.id, { status: { state: initialState(n.kind), exited: true, changedAt: Date.now() } });
      refreshGit(this, n.id).catch(logError);
    }
    this.sweepTimer = setInterval(() => this.sweepStale(), SWEEP_MS);
    this.sweepTimer.unref();
    this.on('node', () => scheduleSoon(this));
    this.on('removed', (id: string) => { this.repoAccounts.delete(id); scheduleSoon(this); });
  }

  // ---- tokens ----

  tokenFor(nodeId: string): string {
    return this.tokens.tokenFor(nodeId, this.registry.get(nodeId)?.credentialGeneration);
  }

  verifyToken(nodeId: string, token: string): boolean {
    return this.tokens.verify(nodeId, token, this.registry.get(nodeId)?.credentialGeneration);
  }

  // ---- queries ----

  view(id: string): NodeView | undefined {
    const rec = this.registry.get(id), rt = this.runtimes.get(id);
    const status = rt?.status;
    if (!rec || !rt || !status) return undefined;
    const withModel = status.model || !rec.model ? status : { ...status, model: rec.model };
    const s = withModel.effort || !rec.effort ? withModel : { ...withModel, effort: rec.effort };
    const { git, outcome, gate } = rt;
    // The kind checks stay outside the cache: a harness change can turn a Claude node into another.
    const claudeRoot = !rec.parentId && isAgentKind(rec.kind) && harnessFor(rec) === 'claude';
    if (claudeRoot && !this.repoAccounts.has(id)) this.repoAccounts.set(id, this.repoAccountOf(rec));
    const repoAccount = claudeRoot ? this.repoAccounts.get(id) : undefined;
    const shown = rt.busy === 'changing harness' ? { ...s, activity: rt.stoppingAfterFailedChange ? 'waiting for old process exit; harness unchanged' : 'changing harness' } : gate?.state === 'running' ? { ...s, activity: `gate: ${gate.command}` } : s;
    return { ...rec, status: git ? { ...shown, git } : shown, unread: !!rt.unread, ...(outcome ? { outcome } : {}), ...(gate ? { gate: gate.state } : {}), ...(rt.busy === 'changing harness' ? { changingHarness: true } : {}), ...(repoAccount !== undefined ? { repoAccount } : {}) };
  }

  /**
   * For a root Claude node (view checks that; children run in their root's account, so only roots warn), the account a
   * new root session in its project would run in now (spawnAccount's mapping), when that is another Claude home than the
   * node's own (null: no account, so Claude's default home); else undefined. Undefined too while the accounts config is
   * invalid or the node's account is no longer configured: launches report those.
   */
  private repoAccountOf(rec: NodeRecord): string | null | undefined {
    try {
      const want = accountForProject(this.home, this.projectDir(rec));
      const dirOf = (a?: string) => (a === undefined ? undefined : claudeConfigDir(this.home, a));
      return dirOf(want) !== dirOf(rec.account) ? want ?? null : undefined;
    } catch { return undefined; }
  }

  /** Recompute repoAccount after the accounts config changed, emitting each node whose warning changed. */
  refreshRepoAccounts(): void {
    for (const rec of this.registry.list()) {
      if (!this.repoAccounts.has(rec.id)) continue; // never viewed: the next view computes it
      const next = this.repoAccountOf(rec);
      if (this.repoAccounts.get(rec.id) === next) continue;
      this.repoAccounts.set(rec.id, next);
      this.emitNode(rec.id);
    }
  }

  list(): NodeView[] {
    return this.registry.list().flatMap((n) => this.view(n.id) ?? []);
  }

  /** When the node's latest turn began, if one has since this daemon started. */
  turnStartedAt(id: string): number | undefined {
    return this.runtimes.get(id)?.turnStart;
  }

  /** The live PTY, for readers such as the MCP layer. Undefined once the process is gone or the node closed. */
  session(id: string): PtySession | undefined {
    return this.runtimes.get(id)?.session;
  }

  /** The root of the node's tree: the one recorded at spawn, else (for a root, or an older record) its topmost registered ancestor. */
  rootIdOf(id: string): string {
    const rec = this.registry.get(id);
    return rec?.rootId ?? (this.registry.lineage(id).at(-1) ?? rec)?.id ?? id;
  }

  /** The tree's session directory, keyed by its root id. */
  sessionDirOf(id: string): string {
    return sessionDir(this.home, this.rootIdOf(id));
  }

  /**
   * Append an event to the node's tree's events.jsonl; never blocks. Nothing is logged after shutdown: the PTY exits it
   * causes are not the tree's history (the nodes resume on the next start), and the append would outlive the process.
   */
  logEvent(id: string, type: string, data: Record<string, unknown> = {}): void {
    if (this.shutDown) return;
    appendEvent(this.sessionDirOf(id), { ts: Date.now(), type, id, title: this.registry.get(id)?.title, ...data });
  }

  /** The away digest: what every tree's event log says happened since `since`. */
  async digest(since: number): Promise<DigestItem[]> {
    await flushEvents();
    return buildDigest(listSessions(this.home).filter((x) => x.newest >= since).flatMap((x) => readEvents(x.dir, since)));
  }

  /** Delete the session directories that daemon.sessionsKeepDays has expired; returns their root ids. */
  sweepSessions(): string[] {
    const protectedRoots = new Set<string>();
    const sessionsRoot = resolve(this.home, 'sessions');
    for (const n of this.registry.list()) {
      protectedRoots.add(n.id);
      protectedRoots.add(this.rootIdOf(n.id));
      // Protect legacy cross-root transcript references until the next launch adopts them.
      for (const path of [n.transcriptPath, ...(n.sessionHistory ?? []).map((s) => s.transcriptPath)]) {
        if (path && inside(resolve(path), sessionsRoot)) protectedRoots.add(relative(sessionsRoot, resolve(path)).split(sep)[0]!);
      }
    }
    return sweepSessions(this.home, protectedRoots, loadConfig(null, this.home).daemon.sessionsKeepDays);
  }

  // ---- lifecycle ----

  /**
   * The directory whose .tiller config, presets and role prompts apply to a node or spawn request: its worktree's
   * repo, else the main checkout of its cwd (the cwd itself outside git). Never a worktree's own branch, which the node
   * in it can edit.
   */
  projectDir(n: { cwd: string; worktree?: Worktree }): string {
    if (n.worktree) return n.worktree.repo;
    let dir = this.projectDirs.get(n.cwd);
    // prune: cached for the daemon's life, so a later `git init` above a cwd is missed until restart; clear it if that matters.
    if (dir === undefined) this.projectDirs.set(n.cwd, dir = wt.mainCheckoutSync(n.cwd) ?? n.cwd);
    return dir;
  }

  /** Throw when an agent's spawn would pass limits.maxDepth or maxChildren (from the node's project config) or daemon.maxLiveNodes (home config). */
  private checkLimits(req: SpawnRequest, limits: Config['limits']): void {
    if (req.byHuman) return;
    const parentId = req.parentId ?? null;
    const { maxDepth, maxChildren } = limits;
    const { maxLiveNodes } = loadConfig(null, this.home).daemon;
    const refuse = (cap: string, value: number, what: string) => {
      throw new Error(`refused: ${cap} is ${value} and ${what}; reuse an idle worker (send it the work) or close finished ones`);
    };
    const depth = parentId === null ? 0 : this.registry.lineage(parentId).length + 1;
    if (depth > maxDepth) refuse('limits.maxDepth', maxDepth, `the new node would be ${depth} levels below the root`);
    const children = this.registry.list().filter((n) => n.parentId === parentId && this.session(n.id)).length;
    if (parentId !== null && children >= maxChildren) refuse('limits.maxChildren', maxChildren, `${parentId} has ${children} live children`);
    const live = this.liveIds().length;
    if (live >= maxLiveNodes) refuse('daemon.maxLiveNodes', maxLiveNodes, `${live} nodes are live`);
  }

  /**
   * Spawn a node. Each of role, model, effort, permissionMode and isolation comes from the request, else its preset,
   * else: model and effort from the harness/profile config, then legacy Claude role defaults; permissionMode from an agent parent's own
   * mode unless that is bypassPermissions; isolation from the config for an agent node whose role is worker or none.
   * Isolation "worktree" gives the node <main checkout>/.claude/worktrees/<id> on branch <prefix><id>, branched from its
   * base (see wt.pickBase: req.base, else the cwd's HEAD branch, else a new task branch); the repo must have a commit
   * and be trusted by Claude. Any failure removes the worktree and branch and discards the record.
   */
  async spawn(req: SpawnRequest): Promise<NodeView> {
    if (!req.byHuman && req.parentId && this.runtimes.get(req.parentId)?.busy === 'changing harness') throw new Error('parent is changing harness');
    req = spawnTarget(req, req.parentId ? this.registry.get(req.parentId) : undefined);
    const adapter = isAgentKind(req.kind) ? adapterFor(req) : undefined;
    const from = req.fork ? await this.forkSource(req) : undefined;
    if (from) req = { ...req, cwd: from.cwd };
    const parentId = req.parentId ?? null, dir = this.projectDir(req);
    const config = loadConfig(dir, this.home);
    const parent = parentId ? this.registry.get(parentId) : undefined, parentRt = parent && this.runtimes.get(parent.id);
    const { role, profile, model, effort, explicit, account, permissionMode, isolation } = resolveSpawn({
      req, adapterId: adapter?.id, config,
      parent: parent && { rec: parent, observedMode: parentRt?.status?.permissionMode, launchedPreset: parentRt?.launchedPreset },
      loadPreset: (name) => loadPreset(name, dir, this.home),
      account: () => this.spawnAccount(req, parent, from),
      validate: (permissionMode, preset) => adapter?.validate({ permissionMode, preset, piExtensions: { setting: config.pi.extensions, cwd: dir, path: this.path } }),
    });
    this.checkLimits(req, config.limits);
    this.checkDependencies(req);
    if (req.base && isolation !== 'worktree') throw new Error('base is for isolation "worktree" only');
    let base: { base: string; created: boolean } | undefined, head: { base: string; baseSha: string } | undefined;
    if (isolation === 'worktree') {
      const repo = await wt.mainCheckout(req.cwd);
      head = await wt.headInfo(req.cwd);
      if (adapter?.id === 'claude' && !trustedForWorktree(repo, readClaudeJson(account && claudeConfigDir(this.home, account)))) throw new Error(`refusing isolation "worktree": Claude does not trust ${repo} yet; run claude once in ${repo} to trust it`);
      const protectedBranches = await wt.protectedBranches(repo, config.worktrees.protected);
      base = await wt.pickBase(req.cwd, head, { requested: req.base, protected: protectedBranches, pattern: config.worktrees.taskBranch, title: req.title });
    }
    const rec = this.registry.create({ // the resolved fields, so restart keeps them
      parentId, kind: req.kind, ...(req.harness ? { harness: req.harness } : {}), title: req.title, cwd: req.cwd,
      model, effort, ...(adapter ? { explicit } : {}), ...(account ? { account } : {}), permissionMode, role, profile, preset: req.preset,
      sessionId: adapter ? req.followup?.sessionId ?? randomUUID() : undefined,
      ...(adapter && adapter.id !== 'claude' && req.followup?.transcriptPath ? { transcriptPath: req.followup.transcriptPath } : {}),
      ...(adapter && adapter.id !== 'claude' && req.followup?.previousSessions ? { previousSessions: req.followup.previousSessions } : {}),
      ...(req.followup?.sessionHistory ? { sessionHistory: req.followup.sessionHistory, previousSessions: req.followup.previousSessions } : {}),
      rootId: parentId ? this.rootIdOf(parentId) : undefined,
      prompt: req.prompt, forkOf: req.fork, forkSession: from?.sessionId, followupOf: req.followup?.id,
      // A follow-up's resumed session keeps counting its cost from where the archived node's last measure left it.
      lastCost: req.followup?.lastCost?.sessionId === req.followup?.sessionId ? req.followup?.lastCost : undefined,
    });
    this.runtimes.set(rec.id, {});
    if (arm(this, rec.id, { ...req, base: base?.base }, isolation)) return this.emitNode(rec.id)!;
    try {
      if (isolation === 'worktree') await addWorktree(this, rec.id, req.prompt, base!.base);
      else {
        this.writeFiles(rec.id);
        this.runtimes.get(rec.id)!.status = { state: initialState(req.kind), changedAt: Date.now() };
        this.launch(rec.id, req.prompt, false);
      }
    } catch (err) {
      this.discard(rec.id);
      // A task branch made for this spawn alone goes too, unless something has moved it; a requested base may be shared.
      if (base?.created && !req.base) await wt.git(req.cwd, ['update-ref', '-d', `refs/heads/${base.base}`, head!.baseSha]).catch(logError);
      throw err;
    }
    this.logEvent(rec.id, 'spawn', { parentId, kind: req.kind, ...(rec.worktree ? { branch: rec.worktree.branch } : {}) });
    return this.emitNode(rec.id)!;
  }

  /**
   * The Claude account of a new node: a child's is its parent's, a root's the human's choice, else a follow-up's or
   * fork's source's, else the one claude.accounts maps its project to. Only the human chooses one, never across accounts:
   * Claude finds a session only in its own account's home, and conversations must not move between accounts.
   */
  private spawnAccount(req: SpawnRequest, parent: NodeRecord | undefined, from: { account?: string } | undefined): string | undefined {
    if (req.account !== undefined && !req.byHuman) throw new Error('refused: only the human may choose a Claude account; a node you spawn runs in yours');
    const name = (a?: string) => a ?? 'default';
    // Compared by Claude home, so no account and the named default (no configDir) are the same; throws for an unconfigured name.
    const dirOf = (a?: string) => (a === undefined ? undefined : claudeConfigDir(this.home, a));
    const account = parent ? parent.account : req.account ?? (req.followup ? req.followup.account : from ? from.account : accountForProject(this.home, this.projectDir(req)));
    if (parent && req.account !== undefined && dirOf(req.account) !== dirOf(account)) throw new Error(`refused: a child runs in its parent's Claude account (${name(account)}), not ${req.account}`);
    if (req.followup && dirOf(req.followup.account) !== dirOf(account)) throw new Error(`refused: cannot follow up across Claude accounts (archived: ${name(req.followup.account)}, new node: ${name(account)})`);
    if (from && dirOf(from.account) !== dirOf(account)) throw new Error(`refused: cannot fork across Claude accounts (source: ${name(from.account)}, new node: ${name(account)})`);
    if (account) claudeConfigDir(this.home, account); // throws for one no longer configured
    return account;
  }

  /** CLAUDE_CONFIG_DIR for a node's account (undefined: the default home); throws when its account is no longer configured. */
  private claudeDirOf(rec: { account?: string }): string | undefined {
    return rec.account ? claudeConfigDir(this.home, rec.account) : undefined;
  }

  /**
   * The session a fork starts from (node req.fork's, live or archived, from the new node's own tree when both exist), its
   * Claude account and its cwd: the one asked for, else the source's, either falling back to the main checkout for a removed worktree.
   */
  private async forkSource(req: SpawnRequest): Promise<{ sessionId: string; cwd: string; account?: string }> {
    if (!isAgentKind(req.kind)) throw new Error('fork is for agent nodes only');
    if (!adapterFor(req).capabilities.fork) throw new Error('this harness does not support session forking');
    const src = this.registry.get(req.fork!) ?? await findArchived(this.home, req.fork!, req.parentId ? this.rootIdOf(req.parentId) : undefined);
    if (!src) throw new Error(`no such node to fork: ${req.fork}`);
    if ((src.harness ?? 'claude') !== harnessFor(req)) throw new Error('cannot fork a session across harnesses');
    // transcriptPath comes with SessionStart: without it the session has not started and there is nothing to fork.
    if (!src.sessionId || !src.transcriptPath) throw new Error(`refused: ${req.fork} has no session yet to fork`);
    const want = req.cwd || src.cwd, cwd = usableCwd(want);
    if (!cwd) throw new Error(`refused: ${want} no longer exists`);
    return { sessionId: src.sessionId, cwd, account: src.account };
  }

  /**
   * Continue an archived node's session as a new live node (claude --resume) that starts on `prompt`, with the archived
   * title (unless given), model, effort and role, under its parent when that is still live, else as a root. Its cwd is
   * the archived one, else the main checkout when that was a worktree since removed. Refused while another live node
   * continues the same session.
   */
  async followup(id: string, prompt: string, title?: string): Promise<NodeView> {
    const a = await findArchived(this.home, id);
    if (!a) throw new Error(`no archived node ${id}`);
    if (!a.sessionId || !a.transcriptPath) throw new Error(`${id} never started a session to follow up`);
    if (!existsSync(a.transcriptPath)) throw new Error(`the transcript of ${id} is gone (${a.transcriptPath})`);
    const twin = this.registry.list().find((n) => n.followupOf === id || n.sessionId === a.sessionId);
    if (twin) throw new Error(`refused: ${twin.id} already continues the session of ${id}; send it the prompt instead`);
    const cwd = usableCwd(a.cwd);
    if (!cwd) throw new Error(`refused: ${a.cwd} no longer exists`);
    const parentId = a.parentId && this.registry.get(a.parentId) ? a.parentId : null;
    return this.spawn({ kind: a.harness && a.harness !== 'claude' ? 'agent' : 'claude', ...(a.harness ? { harness: a.harness } : {}), title: title || a.title, cwd, prompt, model: a.model, effort: a.effort, role: a.role, profile: a.profile, parentId, isolation: 'none', byHuman: true, followup: a });
  }

  /** A live or archived agent node's conversation in one of its sessions (default: the current one). */
  async transcript(id: string, sessionId?: string): Promise<Transcript> {
    const n = await this.transcriptNode(id);
    return nodeTranscript({ ...n, claudeHome: claudeHomeOf(this.home, n.account) }, sessionId);
  }

  /** The record of a live node, else the archive line of a closed one; throws for neither. */
  async transcriptNode(id: string): Promise<NodeRecord | ArchivedNode> {
    const n = this.registry.get(id) ?? await findArchived(this.home, id);
    if (!n) throw new Error(`no such node: ${id}`);
    return n;
  }

  /** Throw unless every after / afterSuccess id is a node in the caller's scope. No cycle can form: a dependency must already exist. */
  private checkDependencies(req: SpawnRequest): void {
    const caller = req.byHuman ? HUMAN : req.parentId ?? HUMAN;
    for (const id of [...(req.after ?? []), ...(req.afterSuccess ?? [])]) {
      if (!this.registry.get(id)) throw new Error(`refused: no such node ${id} to wait for`);
      if (!inScope(this, caller, id)) throw new Error(`refused: ${id} is outside your lineage (self, ancestors, siblings, descendants)`);
    }
  }

  /** A worktree node's changes since it branched, committed or not. */
  async diff(id: string): Promise<Diff> {
    const rec = this.registry.get(id);
    if (!rec) throw new Error(`no such node: ${id}`);
    if (!rec.worktree) throw new Error(`${id} has no worktree of its own to diff`);
    return wt.diff(rec.worktree);
  }

  /**
   * Merge a worktree node's branch into its base in the project's style (worktrees.mergeStyle). Refused, with nothing changed,
   * while the node is working, closing or setting up, when its tree has uncommitted files, or when the branch conflicts
   * with base (the error names the paths).
   */
  merge(id: string): Promise<MergeResult> {
    return mergeWorktree(this, id);
  }

  /** Relaunch an exited agent node in its current session. Fails if the transcript or the node's worktree is gone. */
  async resume(id: string): Promise<{ ok: true } | { ok: false; error: string }> {
    const rec = this.registry.get(id);
    if (!rec) return { ok: false, error: 'No such node' };
    const rt = this.runtimes.get(id)!;
    const refusal = lifecycleRefusal('resume', id, rec, rt);
    if (refusal) return { ok: false, error: refusal };
    if (rec.worktree) {
      // Without its worktree, claude --resume carries on in the main checkout with no isolation.
      const w = rec.worktree;
      const listed = await wt.isListed(w).catch(() => false);
      setMissing(this, id, !listed);
      if (!listed) return { ok: false, error: 'worktree missing' };
      if (rt.busy) return { ok: false, error: `${id} is ${rt.busy}` };
      if (rt.session) return { ok: false, error: 'Node is still running' };
    }
    const status = rt.status!;
    const { sessionId } = rec;
    if (!sessionId) return { ok: false, error: 'No session to resume' };
    try {
      if (harnessFor(rec) === 'claude') this.claudeDirOf(rec);
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
    const transcript = adapterFor(rec).transcript({ ...rec, claudeHome: claudeHomeOf(this.home, rec.account) }, this.sessionDirOf(id));
    if (!transcript || !existsSync(transcript)) return { ok: false, error: `No conversation to resume (missing ${transcript})` };
    rt.lastHookAt = undefined;
    try {
      this.writeFiles(id); // the port, and so the endpoint in mcp.json, may have changed since the node was created
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
    this.registry.update(id, { transcriptPath: transcript });
    rt.status = { state: 'unknown', changedAt: Date.now() };
    try {
      this.launch(id, undefined, true);
    } catch (err) {
      rt.status = { ...status, exited: true, changedAt: Date.now() };
      return { ok: false, error: (err as Error).message };
    }
    this.logEvent(id, 'resume', { sessionId });
    this.emitNode(id);
    return { ok: true };
  }

  /**
   * Kill the node's process and relaunch it with the same record under a fresh session id, so a Claude node starts with
   * an empty context. Children and parentId are untouched; the old session ids are kept in previousSessions. `prompt` is
   * the first prompt; without one, a node whose tree has a handoff.md is pointed at it. A model or effort the spawn did
   * not choose (see NodeRecord.explicit) is re-resolved from the current config.
   */
  restart(id: string, prompt?: string): { ok: true } | { ok: false; error: string } {
    const rec = this.registry.get(id);
    if (!rec) return { ok: false, error: 'No such node' };
    const rt = this.runtimes.get(id)!;
    const refusal = lifecycleRefusal('restart', id, rec, rt);
    if (refusal) return { ok: false, error: refusal };
    let fresh: Pick<NodeRecord, 'model' | 'effort'> = {};
    if (isAgentKind(rec.kind)) {
      const harness = harnessFor(rec);
      try {
        if (harness === 'claude') this.claudeDirOf(rec); // the account is kept, never re-resolved; check it before stopping the node
      } catch (err) {
        return { ok: false, error: (err as Error).message };
      }
      const selection = restartSelection(rec, loadConfig(this.projectDir(rec), this.home), (name) => loadPreset(name, this.projectDir(rec), this.home));
      if ('error' in selection) return { ok: false, error: selection.error };
      fresh = selection.fresh;
    }
    const previousSessions = sessionChain(rec);
    const sessionHistory = this.priorSessions(id);
    this.kill(id);
    rt.lastHookAt = undefined;
    const sessionId = isAgentKind(rec.kind) ? randomUUID() : undefined;
    const transcriptPath = isAgentKind(rec.kind) && adapterFor(rec).id !== 'claude' && rec.transcriptPath && sessionId
      ? join(dirname(rec.transcriptPath), `${sessionId}.jsonl`) : undefined;
    this.registry.update(id, { ...fresh, sessionId, transcriptPath, previousSessions, ...(rec.sessionHistory ? { sessionHistory } : {}) });
    rt.status = { state: initialState(rec.kind), activity: 'restarting', changedAt: Date.now() };
    try {
      this.writeFiles(id);
      this.emit('data', id, '\x1bc'); // reset attached screens before the new process draws
      const first = isAgentKind(rec.kind) ? prompt || handoffPrompt(this.sessionDirOf(id)) : undefined;
      if (rec.worktree && rt.needsSetup) setupThenLaunch(this, id, rec.worktree, worktreeCommands(this, rec.worktree.repo, 'setup'), prompt || rt.needsSetup.prompt);
      else this.launch(id, first, false);
      this.logEvent(id, 'restart', { sessionId, ...(first ? { prompt: first } : {}) });
    } catch (err) {
      this.setStatus(id, { ...rt.status, state: initialState(rec.kind), exited: true, activity: undefined, changedAt: Date.now() }, false);
      return { ok: false, error: (err as Error).message };
    }
    this.emitNode(id);
    return { ok: true };
  }

  private priorSessions(id: string) {
    const rec = this.registry.get(id)!;
    const records = new Map(recordedSessions({ ...rec, claudeHome: claudeHomeOf(this.home, rec.account) }).map((s) => [s.sessionId, s]));
    return sessionChain(rec).flatMap((sid) => records.get(sid) ?? []);
  }

  /** Human-only replacement of an agent's CLI. Native contexts never cross the harness boundary. */
  async changeHarness(id: string, harness: Harness, prompt?: string, byHuman = false): Promise<{ ok: true } | { ok: false; error: string }> {
    if (!byHuman) return { ok: false, error: 'changing harness is only for the human' };
    const rec = this.registry.get(id), rt = this.runtimes.get(id);
    if (!rec || !rt) return { ok: false, error: 'No such node' };
    if (!isAgentKind(rec.kind)) return { ok: false, error: 'Only agent nodes can change harness' };
    if (harnessFor(rec) === harness) return { ok: false, error: `Node already uses ${harness}; use Restart for a fresh context` };
    const refusal = lifecycleRefusal('changeHarness', id, rec, rt);
    if (refusal) return { ok: false, error: refusal };
    rt.busy = 'changing harness';
    this.emitNode(id);
    let disrupted = false;
    try {
      const adapter = adapterFor({ kind: 'agent', harness });
      const defaults = nodeDefaults(loadConfig(this.projectDir(rec), this.home), harness, rec);
      if (defaults.effort && !isSupportedEffort(harness, defaults.effort)) throw new Error(`unsupported ${harness} effort: ${defaults.effort}`);
      // Explicit confirmation resets preset/model/effort/permission overrides to target defaults.
      requireHarnessExecutable(harness, this.path);
      if (harness === 'claude') this.claudeDirOf(rec); // the node keeps its account
      adapter.validate({ piExtensions: { setting: loadConfig(this.projectDir(rec), this.home).pi.extensions, cwd: this.projectDir(rec), path: this.path } });
      const owner = this.registry.list().find((n) => n.id !== id && n.worktree && inside(rec.cwd, n.worktree.path));
      const ownerRuntime = owner && this.runtimes.get(owner.id);
      if (ownerRuntime?.busy || ownerRuntime?.setup || ownerRuntime?.gate?.state === 'running') throw new Error('the shared worktree has a lifecycle operation running');
      if (rec.worktree) {
        const w = rec.worktree;
        const listed = await wt.isListed(w);
        if (!listed) throw new Error('worktree missing');
        if (harness === 'claude' && !trustedForWorktree(w.repo, readClaudeJson(this.claudeDirOf(rec)))) throw new Error(`Claude does not trust ${w.repo}; run claude there to trust it before changing harness`);
      }
      if (!existsSync(rec.cwd)) throw new Error(`working directory does not exist: ${rec.cwd}`);
      await waitForDeliveries(this, id);
      if (this.shutDown) throw new Error('daemon is shutting down');
      const oldProcess = rt.session;
      if (oldProcess) {
        try {
          if (!(await oldProcess.terminate(this.terminateTimeoutMs))) throw new Error('old process has not exited; harness was not changed. Wait for exit before retrying');
        } catch (error) {
          rt.stoppingAfterFailedChange = !oldProcess.exited;
          throw error;
        }
      }
      disrupted = true;
      if (this.shutDown) throw new Error('daemon is shutting down');
      // Rotate only after old shutdown receipts have drained. Old launch files are never rewritten.
      handoverInbox(this, id);
      const sessionHistory = this.priorSessions(id), from = harnessFor(rec), sessionId = randomUUID();
      this.registry.update(id, { kind: 'agent', harness, sessionId, transcriptPath: undefined,
        previousSessions: sessionChain(rec), sessionHistory,
        credentialGeneration: randomUUID(), model: defaults.model, effort: defaults.effort, explicit: [], permissionMode: undefined, preset: undefined,
        forkSession: undefined, lastCost: undefined });
      clearTimeout(rt.interruptTimer);
      rt.lastHookAt = rt.turnStart = rt.lastCostEvent = undefined;
      rt.starting = false;
      rt.outcome = rt.gate = rt.launchedPreset = undefined;
      rt.watches = undefined;
      rt.status = { state: initialState(rec.kind), activity: `starting ${harness}`, changedAt: Date.now() };
      this.registry.flush(); // Persist the new identity before any target process can use it.
      this.writeFiles(id);
      this.emit('data', id, '\x1bc');
      this.logEvent(id, 'change_harness', { from, harness, sessionId });
      this.launch(id, prompt || handoffPrompt(this.sessionDirOf(id)), false);
      return { ok: true };
    } catch (err) {
      const error = (err as Error).message;
      if (disrupted) {
        rt.status = { state: 'done', exited: true, errored: true, activity: `Harness change failed: ${error}. Use Restart to retry.`, changedAt: Date.now() };
        this.liveChanged();
      }
      return { ok: false, error };
    } finally {
      if (!rt.stoppingAfterFailedChange) rt.busy = undefined;
      this.emitNode(id);
    }
  }

  /**
   * Close and delete a node. A root (orchestrator) is refused unless `force`; use restart to clear one instead.
   * For a node that owns a worktree, `worktree` picks what happens to it: by default the close is refused, with the node
   * left running, unless the tree is clean and its branch merged; "keep" commits any changes as WIP and keeps the branch;
   * "discard" deletes both. Either way it is refused while another live node works inside the tree. Returns a note
   * when a branch is kept.
   */
  async close(id: string, force = false, worktree?: 'keep' | 'discard'): Promise<string | undefined> {
    const rec = this.registry.get(id);
    if (!force && rec?.parentId === null) throw new Error('refusing to close an orchestrator: restart it instead, or force the close');
    const rt = this.runtimes.get(id);
    const refusal = rec && rt && lifecycleRefusal('close', id, rec, rt);
    if (refusal) throw new Error(refusal);
    if (rec?.worktree) return closeWorktreeNode(this, id, rec.title, rec.worktree, worktree);
    this.kill(id);
    if (!this.registry.get(id)) return undefined;
    this.closed(id);
    return undefined;
  }

  /** Log the close, archive an agent node that has launched, record closedAt for a root's session directory, and forget the node. */
  closed(id: string, note?: string, fate: BranchFate = {}): void {
    this.logEvent(id, 'close', note ? { note } : {});
    const rec = this.registry.get(id), rt = this.runtimes.get(id);
    // Every launch sets lastActiveAt; a node that never launched has no conversation (nor a session directory) to keep.
    if (rec && isAgentKind(rec.kind) && rec.lastActiveAt !== undefined) archiveNode(this.sessionDirOf(id), archivedOf(rec, rt?.status, rt?.outcome, this.rootIdOf(id), fate));
    if (rec?.parentId === null) markClosed(this.home, id);
    this.discard(id);
    this.emit('removed', id);
  }

  /** Kill the node's process, if any, and forget it, freeing its maxWorking slot; returns the session it had. */
  kill(id: string): PtySession | undefined {
    const rt = this.runtimes.get(id);
    const s = rt?.session;
    if (rt) {
      clearTimeout(rt.interruptTimer);
      rt.session = undefined; // first, so the exit callback ignores it
      rt.starting = false;
    }
    this.liveChanged();
    s?.kill();
    return s;
  }

  /** Close every exited node with no live descendant. A node whose worktree is not safe to remove is kept, with the reason. */
  async prune(): Promise<{ removed: string[]; kept: { id: string; reason: string }[] }> {
    const removed: string[] = [], kept: { id: string; reason: string }[] = [];
    const depth = (id: string) => this.registry.lineage(id).length;
    for (const id of pruneIds(this.list()).sort((a, b) => depth(b) - depth(a))) { // children first
      try {
        await this.close(id, true); // exited only, so never a live orchestrator
        removed.push(id);
      } catch (err) {
        kept.push({ id, reason: (err as Error).message });
      }
    }
    return { removed, kept };
  }

  /** Uncommitted files, unmerged commits and other live nodes inside the node's worktree; undefined when it owns none. */
  worktreeCheck(id: string): Promise<WorktreeCheck | undefined> {
    return worktreeCheck(this, id);
  }

  /**
   * Reconcile worktrees with the registry, for every repo this daemon has used (or only the one `cwd` is in): drop git's
   * entries for deleted directories, mark nodes whose worktree is missing, and list orphans and kept branches.
   * clean "startup" removes orphans that are clean and have no commits; "safe" removes orphans and kept branches that are
   * clean and merged; "force" removes them all. Nothing inside a live node's cwd is removed.
   */
  worktrees(opts: { cwd?: string; clean?: 'startup' | 'safe' | 'force' } = {}): Promise<WorktreeReport> {
    return worktrees(this, opts);
  }

  rename(id: string, title: string): void {
    if (this.registry.update(id, { title })) this.emitNode(id);
  }

  /** Stop or restore a node's notifications (kept in its record); false when there is no such node. */
  mute(id: string, muted: boolean): boolean {
    if (!this.registry.update(id, { muted: muted || undefined })) return false;
    console.log(`${muted ? 'muted' : 'unmuted'} ${id}`);
    this.emitNode(id);
    return true;
  }

  /** A client selected `id`, which clears its unread flag. */
  select(id: string): void {
    const rt = this.runtimes.get(id);
    if (!rt?.unread) return;
    rt.unread = false;
    this.emitNode(id);
  }

  input(id: string, data: string, binary = false): void {
    if (this.runtimes.get(id)?.busy === 'changing harness') return;
    const rt = this.runtimes.get(id), s = rt?.session;
    if (!rt || !s) return;
    if (interruptKeyPressed(rt.status!, data)) {
      // Esc / Ctrl-C ends a turn without a Stop hook. If no hook shows up, call it interrupted.
      const sentAt = Date.now();
      clearTimeout(rt.interruptTimer);
      rt.interruptTimer = setTimeout(() => {
        rt.interruptTimer = undefined;
        const cur = rt.status;
        if (cur && (rt.lastHookAt ?? 0) < sentAt) this.setStatus(id, interruptTimeout(cur, Date.now()));
      }, INTERRUPT_MS);
      rt.interruptTimer.unref();
    }
    s.write(binary ? Buffer.from(data, 'latin1') : data).catch(logError);
  }

  resize(id: string, cols: number, rows: number): void {
    this.session(id)?.resize(cols, rows);
  }

  /** Resize to the viewer and return the visible screen serialized with attributes. */
  async attach(id: string, cols: number, rows: number): Promise<string> {
    const s = this.session(id);
    if (!s) return '';
    s.resize(cols, rows);
    await s.flush();
    return s.snapshot();
  }

  applyHook(nodeId: string, event: HookEvent): void {
    const rec = this.registry.get(nodeId), rt = this.runtimes.get(nodeId);
    const prev = rt?.status;
    if (!rec || !rt || !prev) return;
    if (rec.credentialGeneration && typeof event.session_id === 'string' && event.session_id !== rec.sessionId) return;
    const now = Date.now();
    rt.lastHookAt = now;
    if (event.hook_event_name === 'UserPromptSubmit') {
      rt.turnStart = now;
      rt.starting = false;
    }
    this.emit('hook', nodeId, event);
    const next = reduce(prev, event, now);
    if (next.state !== prev.state) this.registry.update(nodeId, { lastActiveAt: now });
    if (event.hook_event_name === 'SessionStart') {
      const sessionId = typeof event.session_id === 'string' ? event.session_id : undefined;
      let transcriptPath = typeof event.transcript_path === 'string' ? event.transcript_path : undefined;
      // claude --resume runs from the main checkout and fires SessionStart before it re-enters the worktree, so it reports
      // the checkout's project dir; the session's transcript stays under the worktree's.
      if (transcriptPath && rec.worktree && harnessFor(rec) === 'claude' && typeof event.cwd === 'string' && !wt.samePath(event.cwd, rec.worktree.path)) {
        transcriptPath = transcriptFor(rec.worktree.path, sessionId ?? rec.sessionId!, claudeHomeOf(this.home, rec.account));
      }
      if (sessionId && sessionId !== rec.sessionId) this.registry.update(nodeId, { sessionId });
      if (transcriptPath && transcriptPath !== rec.transcriptPath) this.registry.update(nodeId, { transcriptPath });
    }
    if (next.permissionMode && next.permissionMode !== rec.permissionMode) {
      this.registry.update(nodeId, { permissionMode: next.permissionMode });
    }
    this.setStatus(nodeId, next);
    const e = event.hook_event_name;
    if (e === 'Stop' || e === 'StopFailure') refreshGit(this, nodeId).catch(logError);
    else if (e === 'PostToolUse' && GIT_EDIT_TOOLS.includes(String(event.tool_name)) && rec.worktree) refreshGitSoon(this, nodeId);
  }

  /** Lifecycle events from a harness bridge; starts and final settlement drive the shared state machine. */
  applyModEvent(nodeId: string, ev: ModEvent): void {
    const rt = this.runtimes.get(nodeId), prev = rt?.status;
    if (!rt || !prev) return;
    const now = Date.now();
    if (process.env.TL_DEBUG) console.log(`${new Date(now).toISOString().slice(11, 23)} mod ${nodeId.slice(0, 6)} ${ev.event} ${JSON.stringify(ev.payload).slice(0, 300)}`);
    if (ev.event === 'turn.start') {
      // Claude's UserPromptSubmit hook owns its turn boundary; a late/duplicate mod start must not clear state.
      const rec = this.registry.get(nodeId);
      if (!rec || !isAgentKind(rec.kind) || harnessFor(rec) === 'claude') return;
      rt.lastHookAt = now;
      rt.turnStart = now;
      rt.starting = false;
      this.setStatus(nodeId, reduce(prev, { hook_event_name: 'UserPromptSubmit', prompt_id: ev.payload.turnId }, now));
    } else if (ev.event === 'turn.complete') {
      const model = ev.payload.usage?.model;
      let base = typeof model === 'string' && model !== prev.model ? { ...prev, model } : prev;
      // Claude's Stop hook owns its final message; other harnesses report it here.
      const rec = this.registry.get(nodeId);
      if (rec && isAgentKind(rec.kind) && harnessFor(rec) !== 'claude') {
        rt.lastHookAt = now;
        rt.starting = false;
        if (typeof ev.payload.answer === 'string') base = { ...base, lastAssistantMessage: ev.payload.answer };
      }
      this.setStatus(nodeId, turnComplete(base, now, ev.payload));
      refreshGit(this, nodeId).catch(logError);
    } else if (ev.event === 'session.measure') {
      const { context, cost, rateLimits } = ev.payload;
      const rec = this.registry.get(nodeId);
      const tool = rec && isAgentKind(rec.kind) ? harnessFor(rec) : undefined;
      // The account label is the daemon's, from the node's record; never the adapter's.
      const account = tool === 'claude' ? rec?.account : undefined;
      if (tool) {
        const unavailable = ev.payload.usageUnavailable ? this.usageRegistry.unavailable(tool, nodeId, now) : false;
        const reports = (ev.payload.usageReports ?? (rateLimits?.length ? [{ scope: 'account' as const, rateLimits }] : []))
          .map(({ account: _, ...r }) => (account ? { ...r, account } : r));
        const changed = this.usageRegistry.record(tool, nodeId, reports, now);
        if (changed || unavailable) this.emit('usageSources', this.usageRegistry.sources);
      }
      if (rateLimits?.length && (!tool || tool === 'claude')) { // empty off a subscription or before the first reading: keep the last report
        this.usage = { rateLimits, nodeId, at: now, ...(account ? { account } : {}) };
        this.usageByAccount.set(account ?? '', this.usage);
        this.emit('usage', this.usage);
      }
      if (cost) this.addSpend(nodeId, cost.usd, cost.incomplete === true, cost.unpricedAdded === true, now);
      if (cost && now - (rt.lastCostEvent ?? 0) >= COST_EVENT_MS) {
        rt.lastCostEvent = now;
        this.logEvent(nodeId, 'cost', { usd: cost.usd, ...(context ? { contextPct: context.percent } : {}) });
      }
      this.setStatus(nodeId, { ...prev,
        ...('model' in ev.payload && typeof ev.payload.model === 'string' ? { model: ev.payload.model } : {}),
        contextPct: context?.percent ?? prev.contextPct, contextTokens: context?.tokens ?? prev.contextTokens, contextWindow: context?.window ?? prev.contextWindow, costUsd: cost?.usd ?? prev.costUsd,
      });
    }
  }

  /**
   * Resume the nodes that were live when the daemon last went away, parents first. Skips nodes that no longer exist, have
   * lost their worktree or have been idle longer than resumeMaxAgeDays; then forgets the set, so it holds only nodes that
   * come up again. Returns a one-line summary.
   */
  async resumeLive(): Promise<string> {
    const ids = this.pendingResume;
    const { resumeOnStart, resumeMaxAgeDays } = loadConfig(null, this.home).daemon;
    let summary = 'nothing to resume';
    // Cleared before any resume, so a resumed node that starts a turn on a held message keeps the midTurn that sets.
    const wasMidTurn = new Set(this.registry.list().filter((n) => n.midTurn).map((n) => n.id));
    for (const id of wasMidTurn) this.registry.update(id, { midTurn: undefined }); // at most once per restart
    if (ids.size && !resumeOnStart) summary = `daemon.resumeOnStart is off; not resuming ${count(ids.size, 'node')}`;
    else if (ids.size) {
      const cutoff = Date.now() - resumeMaxAgeDays * 86_400_000;
      const skipped = [...ids].filter((id) => !this.registry.get(id)).map((id) => `${id} (no such node)`);
      let resumed = 0;
      const cutOff: string[] = [];
      for (const { node: n } of treeOrder(this.registry.list())) {
        if (!ids.has(n.id) || n.pending) continue; // a held node launches by itself once re-armed below
        if ((n.lastActiveAt ?? n.createdAt) < cutoff) { skipped.push(`${n.id} (idle over ${resumeMaxAgeDays} days)`); continue; }
        const r = await this.resume(n.id);
        if (r.ok) resumed++;
        else skipped.push(`${n.id} (${r.error})`);
        if (r.ok && wasMidTurn.has(n.id)) cutOff.push(n.id);
      }
      // Into the inbox at once: the resumed node's mod picks it up behind any message already queued for it.
      for (const id of cutOff) deliver(this, DAEMON, id, cutOffText(this.lastStop), { fromLabel: 'tiller (daemon restarted)', replyTo: null, inbox: true }).catch(logError);
      summary = `resumed ${resumed}, skipped ${skipped.length}${skipped.length ? `: ${skipped.join(', ')}` : ''}${cutOff.length ? `; told ${count(cutOff.length, 'node')} their turn was cut off` : ''}`;
    }
    this.pendingResume = new Set();
    this.liveChanged();
    for (const rt of this.runtimes.values()) rt.restored = undefined; // re-arm the nodes the record held back
    scheduleSoon(this);
    return `resume on start: ${summary}`;
  }

  /**
   * Hold message deliveries (see holdDeliveries) and agent spawns (they queue) while a restart for `reason` waits for
   * the agent nodes' turns to end, then return the nodes it still waits for, leaving out `exclude` (the node that
   * runs tl reload). Each call renews the drain's lease; it ends by itself after DRAIN_LEASE_MS without one.
   */
  drain(reason: string, exclude?: string): Drain {
    const d = this.drainState;
    if (d) clearTimeout(d.lease);
    const lease = setTimeout(() => { console.log('drain: no poll from the restart; releasing held messages and spawns'); this.endDrain(); }, DRAIN_LEASE_MS);
    lease.unref();
    this.drainState = { reason: d?.reason ?? reason, exclude: d ? d.exclude : exclude, force: d?.force, lease };
    if (!d) {
      console.log(`drain: holding messages and spawns for a restart (${reason})`);
      holdDeliveries(this);
      this.emit('drain', this.drainView());
    }
    return this.drainView()!;
  }

  /** The drain in progress, if any: why, and the agent nodes still working. */
  drainView(): Drain | undefined {
    const d = this.drainState;
    if (!d) return undefined;
    // A message the node's mod claimed just before the drain starts a turn whose hook has not arrived yet.
    const busy = (id: string) => working(this.runtimes.get(id)) || submitting(this, id);
    const waiting = this.registry.list().filter((n) => isAgentKind(n.kind) && n.id !== d.exclude && busy(n.id)).map((n) => ({ id: n.id, title: n.title }));
    return { reason: d.reason, waiting, ...(d.force ? { force: true } : {}) };
  }

  /** The human asked to restart without waiting: the restarting helper sees force on its next poll. */
  forceDrain(): void {
    if (!this.drainState || this.drainState.force) return;
    this.drainState.force = true;
    this.emit('drain', this.drainView());
  }

  /** End the drain without a restart: release the held messages and spawns. */
  endDrain(): void {
    if (!this.drainState) return;
    clearTimeout(this.drainState.lease);
    this.drainState = undefined;
    holdDeliveries(this);
    scheduleSoon(this);
    this.emit('drain', undefined);
  }

  get draining(): boolean { return !!this.drainState; }

  /**
   * Flush the registry and the message inbox, and kill every PTY. The live set is kept for resume on next start, unless
   * `clearLive` (an explicit stop: do not come back). Resolves once nothing more writes into the home or a worktree: the
   * PTYs have exited, worktree setups and git refreshes in flight have settled (or SHUTDOWN_WAIT_MS has passed, safely
   * inside the restart's wait for the old daemon), the registry and inbox are written again, and the event appends
   * already queued have landed. No git refresh starts once it is called, and no registry save after it resolves.
   */
  async shutdown(opts: { clearLive?: boolean } = {}): Promise<void> {
    if (!this.shutDown) {
      dropQueuedMerges(this); // before the PTYs' exits end the turns they wait for
      this.registry.setStopped(this.drainState?.reason ?? 'the daemon was stopped');
    }
    this.shutDown = true;
    clearTimeout(this.drainState?.lease);
    if (opts.clearLive) this.registry.setLive([]);
    clearInterval(this.sweepTimer);
    const wait = this.terminateTimeoutMs ?? SHUTDOWN_WAIT_MS;
    const work: Promise<unknown>[] = [];
    for (const rt of this.runtimes.values()) {
      clearTimeout(rt.interruptTimer);
      clearTimeout(rt.gitTimer);
      rt.setup?.abort.abort();
      if (rt.setup) work.push(rt.setup.done);
      if (rt.session) work.push(rt.session.terminate(wait).catch(() => false));
      work.push(gitSettled(rt));
    }
    this.registry.flush(); // now, in case the process is killed during the wait
    saveInboxForRestart(this);
    await Promise.race([Promise.all(work), sleep(wait, undefined, { ref: false })]);
    // Again: exiting processes' last hooks and messages land during the wait. The registry then stops saving.
    this.registry.close();
    saveInboxForRestart(this);
    await flushEvents();
  }

  // ---- internals; worktree-lifecycle.ts and scheduling.ts call the ones not marked private ----

  /** Whether shutdown has run. */
  get stopped(): boolean { return this.shutDown; }

  nodeDir(id: string): string { return join(this.home, 'nodes', id); }

  /** Old processes retain their old token paths; a new generation cannot be read through those paths. */
  private launchDir(id: string): string {
    const generation = this.registry.get(id)?.credentialGeneration;
    return generation ? join(this.nodeDir(id), 'launches', generation) : this.nodeDir(id);
  }

  /** Ids of the nodes with a live process. */
  private liveIds(): string[] {
    return [...this.runtimes].flatMap(([id, rt]) => (rt.session ? [id] : []));
  }

  /** Save the ids with a live process (plus any not yet resumed) with the registry. Call after every change to a session. */
  private liveChanged(): void {
    if (!this.shutDown) this.registry.setLive([...new Set([...this.pendingResume, ...this.liveIds()])]);
  }

  /** Token, hook-headers, settings.json and mcp.json for a node; mcp.json embeds the current endpoint. */
  writeFiles(id: string): void {
    const dir = this.launchDir(id);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const token = this.tokens.writeFiles(dir, id, this.registry.get(id)?.credentialGeneration);
    const rec = this.registry.get(id);
    // Inheriting brings in the user's and plugins' MCP servers, not the project's .mcp.json ones, which would stop the node on an approval prompt.
    const inherit = rec && loadConfig(this.projectDir(rec), this.home).claude.inheritMcpServers;
    const disabledMcpServers = rec && inherit ? projectMcpServerNames([rec.worktree?.path, rec.worktree?.repo, rec.cwd].filter((d): d is string => !!d)) : undefined;
    writeNodeFiles(dir, { nodeId: id, endpoint: this.endpoint, token, worktree: !!rec?.worktree, sessionDir: this.sessionDirOf(id), disabledMcpServers });
  }

  setOutcome(id: string, o: Outcome): void {
    const rt = this.runtimes.get(id);
    if (!rt) return;
    rt.outcome = o;
    rt.gate?.resetFailures();
    this.emit('outcome', id);
    this.emitNode(id);
    const { at: _at, ...data } = o;
    this.logEvent(id, 'outcome', data);
  }

  /** The completion gate for a node: gateFor its main checkout when it has its own worktree, else its cwd. */
  gateConfig(id: string): Config['gate'] {
    const rec = this.registry.get(id);
    return rec && gateFor(this.projectDir(rec), this.home);
  }

  /** Whether the node's completion gate is running now. */
  gateRunning(id: string): boolean {
    return this.runtimes.get(id)?.gate?.state === 'running';
  }

  /**
   * Run the gate command once in the node's cwd with the setup runner and env, appending to <node dir>/gate.log. While it
   * runs the node shows activity "gate: <command>". Resolves with whether it passed, the last lines of this run's output,
   * and the failed runs since the node's last recorded outcome, this one included.
   */
  async runGate(id: string, gate: NonNullable<Config['gate']>): Promise<{ ok: boolean; tail: string; failures: number }> {
    const rec = this.registry.get(id), rt = this.runtimes.get(id);
    if (!rec || !rt) return { ok: false, tail: 'node is gone', failures: 0 };
    if (rt.busy === 'changing harness') return { ok: false, tail: 'node is changing harness', failures: 0 };
    const completion = rt.gate ?? new CompletionGate();
    const env = rec.worktree ? worktreeEnv(this, id, rec.worktree) : buildChildEnv({ PATH: this.path, TL_NODE_ID: id });
    return completion.run(gate, {
      cwd: rec.cwd, env, log: join(this.nodeDir(id), 'gate.log'),
      present: () => !!this.registry.get(id),
      changed: () => { rt.gate = completion; this.emitNode(id); },
    });
  }

  /** Forget the node: its record, its runtime state and its files. The caller has killed its process. */
  discard(id: string): void {
    const rt = this.runtimes.get(id);
    clearTimeout(rt?.gitTimer);
    clearTimeout(rt?.interruptTimer);
    this.runtimes.delete(id);
    this.registry.remove(id);
    if (this.usageRegistry.remove(id)) this.emit('usageSources', this.usageRegistry.sources);
    rmSync(this.nodeDir(id), { recursive: true, force: true });
  }

  launch(id: string, prompt: string | undefined, resume: boolean): void {
    let rec = this.registry.get(id)!;
    // A follow-up's first launch (every launch sets lastActiveAt) resumes the session its record was created with.
    // prune: a restart before that first launch mints a fresh session and loses it; a follow-up has no worktree setup to fail first.
    resume ||= rec.lastActiveAt === undefined && !!rec.followupOf && !rec.credentialGeneration;
    const forkSession = rec.forkSession; // cleared once the fork has launched
    const owner = rec.worktree ? undefined : this.registry.list().find((n) => n.id !== id && n.worktree && this.session(n.id) && inside(rec.cwd, n.worktree.path));
    const rootId = this.rootIdOf(id), root = this.registry.get(rootId) ?? rec;
    const sessionDir = ensureSession(this.home, { rootId, title: root.title, cwd: root.cwd, createdAt: root.createdAt });
    const adapter = isAgentKind(rec.kind) ? adapterFor(rec) : undefined;
    if (rec.sessionHistory) rec = this.registry.update(id, { sessionHistory: adoptSessionHistory(rec.sessionHistory, sessionDir, id) })!;
    if (adapter?.prepareTranscript) {
      rec = this.registry.update(id, { transcriptPath: adapter.prepareTranscript(rec, sessionDir, resume) })!;
    }
    const config = loadConfig(this.projectDir(rec), this.home);
    const input: LaunchInput = {
      nodeId: id, nodeDir: this.launchDir(id), endpoint: this.endpoint, path: this.path, harness: adapter?.id,
      title: rec.title, parentId: rec.parentId, home: this.home, cwd: this.projectDir(rec), role: rec.role, profile: rec.profile, sessionId: rec.sessionId ?? '',
      resume, forkSession, transcriptPath: rec.transcriptPath, prompt, model: rec.model, effort: rec.effort, permissionMode: rec.permissionMode, worktree: rec.worktree, sharesWorktreeOf: owner?.id, sessionDir,
      preset: rec.preset ? loadPreset(rec.preset, this.projectDir(rec), this.home) : undefined,
      inheritMcpServers: config.claude.inheritMcpServers, piExtensions: config.pi.extensions,
      claudeConfigDir: adapter?.id === 'claude' ? this.claudeDirOf(rec) : undefined,
    };
    const spec = adapter ? adapter.launch(input) : terminalLaunch(input, this.shell);
    const cwd = adapter ? adapter.cwd(rec) : rec.cwd;
    const rt = this.runtimes.get(id)!;
    if (rt.session) throw new Error('node already has a running process');
    const s = PtySession.spawn({ ...spec, cwd, ...DEFAULT_SIZE });
    rt.session = s;
    rt.launchedPreset = input.preset ?? {};
    if (adapter && prompt) rt.starting = true;
    this.registry.update(id, { lastActiveAt: Date.now(), forkSession: undefined });
    this.liveChanged();
    const native = adapter !== undefined && adapter.id !== 'claude';
    let outputTail = ''; // native bridge failures are printed in the terminal
    s.onData((d) => {
      if (rt.session !== s) return;
      if (native) outputTail = (outputTail + d).slice(-8192);
      this.emit('data', id, d);
    });
    s.onExit((code) => {
      if (rt.session !== s) return;
      rt.session = undefined;
      rt.starting = false;
      this.liveChanged();
      if (rt.busy === 'changing harness' && !rt.stoppingAfterFailedChange) return;
      if (rt.stoppingAfterFailedChange) {
        rt.stoppingAfterFailedChange = false;
        rt.busy = undefined;
      }
      this.markUnread(id);
      let status = ptyExited(rt.status!, Date.now());
      if (native) {
        const lines = stripVTControlCharacters(outputTail).split(/[\r\n]+/).map((line) => line.trim());
        // The adapter's refusals (an incompatible Pi build, a bad launch environment) shut Pi down cleanly, often with code 0.
        const refusal = lines.findLast((line) => line.includes(PI_REFUSAL));
        if (code !== 0 || refusal) {
          const error = refusal?.slice(refusal.indexOf(PI_REFUSAL) + '[tiller] '.length) ?? lines.findLast((line) => /^Error:/i.test(line));
          status = { ...status, errored: true, activity: error?.slice(0, 300) ?? `Process exited with code ${code}` };
        } else status = { ...status, activity: undefined };
      }
      this.setStatus(id, status, false);
      this.emit('notify', { id, kind: 'exited', title: rec.title } satisfies NotifyEvent);
      refreshGit(this, id).catch(logError);
    });
    if (adapter?.id === 'claude') this.watchTrust(id, s, cwd, input.claudeConfigDir).catch(logError);
  }

  /**
   * Watch a fresh Claude screen for the folder-trust dialog; answer it only if policy allows. The dialog's
   * heading scrolls out of the viewport, so match on the option text and footer instead.
   */
  private async watchTrust(id: string, s: PtySession, cwd: string, claudeConfigDir: string | undefined): Promise<void> {
    const auto = trustPolicy(cwd, readClaudeJson(claudeConfigDir)) === 'auto';
    let downAt = 0;
    for (const end = Date.now() + TRUST_WATCH_MS; Date.now() < end; await sleep(250)) {
      const rt = this.runtimes.get(id);
      if (s.exited || rt?.session !== s || rt.lastHookAt !== undefined) return;
      await s.flush();
      const lines = s.screenTail(30);
      const screen = lines.join('\n');
      if (!screen.includes('Yes, I trust this folder') || !screen.includes('Enter to confirm')) continue;
      if (!auto) {
        this.setStatus(id, { ...rt.status!, state: 'blocked', activity: TRUST_BLOCKED_ACTIVITY, changedAt: Date.now() });
        return;
      }
      // The dialog draws before it takes keys, so a Down can be lost, and Enter on the default "No, exit" quits
      // Claude. Confirm only once Yes shows selected; repeat a Down that has not landed after a second.
      if (lines.some((l) => l.trimStart().startsWith(`${SELECTED} `) && l.includes('Yes, I trust this folder'))) {
        await s.write('\r');
        return;
      }
      if (Date.now() - downAt >= 1000) {
        await s.write('\x1b[B');
        downAt = Date.now();
      }
    }
  }

  /**
   * Add to the record's spend what the session spent since its last measure. A session's cost counts from zero, so a
   * different session id or a figure below the last one means a new session (restart) and counts whole. The last figure
   * is kept on the record so a session resumed after a daemon restart is not counted again. `incomplete` (the session has usage
   * the harness could not price) marks the node's total as a lower bound; `unpricedAdded` (this measure added some) marks today's.
   */
  private addSpend(id: string, usd: number, incomplete: boolean, unpricedAdded: boolean, now: number): void {
    const rec = this.registry.get(id);
    if (!rec) return;
    const last = rec.lastCost?.sessionId === rec.sessionId ? rec.lastCost?.usd : undefined;
    const delta = last !== undefined && usd >= last ? usd - last : usd;
    const day = dayKey(now);
    const today = rec.spentToday?.day === day ? rec.spentToday : undefined;
    const newlyIncomplete = (incomplete && !rec.spentIncomplete) || (unpricedAdded && !today?.incomplete);
    if (!(delta > 0) && !newlyIncomplete) return; // nothing new: lastCost already holds this figure, or a fresh session has spent nothing yet
    const add = delta > 0 ? delta : 0;
    this.registry.update(id, {
      spentUsd: (rec.spentUsd ?? 0) + add,
      spentToday: { day, usd: (today?.usd ?? 0) + add, ...(unpricedAdded || today?.incomplete ? { incomplete: true } : {}) },
      lastCost: { sessionId: rec.sessionId, usd },
      ...(incomplete ? { spentIncomplete: true } : {}),
    });
  }

  private sweepStale(): void {
    const now = Date.now();
    for (const [id, { status: prev }] of this.runtimes) {
      if (!prev) continue;
      const rec = this.registry.get(id);
      const stalled = prev.state === 'working' ? stall(prev, now, loadConfig(rec ? this.projectDir(rec) : null, this.home).limits.stallMinutes * 60_000) : prev;
      this.setStatus(id, sweep(stalled, now));
    }
    refreshMovedTips(this).catch(logError);
  }

  /** Store a new status, broadcast it, and notify on transitions into done / blocked / waiting. */
  setStatus(id: string, next: NodeStatus, notify = true): void {
    const rt = this.runtimes.get(id), prev = rt?.status;
    if (!rt || !prev || next === prev) return;
    rt.status = next;
    // Not after shutdown: the PTYs' exits then end turns that the next daemon must still see as cut off.
    const midTurn = active(next) && next.activity !== TRUST_BLOCKED_ACTIVITY;
    if (!this.shutDown && midTurn !== !!this.registry.get(id)?.midTurn) this.registry.update(id, { midTurn: midTurn || undefined });
    // The Stop hook's message often lands just after the mod's turn.complete has already moved the node to done.
    const message = next.lastAssistantMessage && next.lastAssistantMessage !== prev.lastAssistantMessage ? next.lastAssistantMessage.slice(0, 300) : undefined;
    if (next.state !== prev.state || !!next.exited !== !!prev.exited || (message && next.state !== 'working')) {
      this.logEvent(id, 'state', { from: prev.state, to: next.state, ...(next.activity ? { activity: next.activity } : {}), ...(message ? { message } : {}), ...(next.errored ? { errored: true } : {}), ...(next.exited ? { exited: true } : {}) });
    }
    let kind: NotifyEvent['kind'] | undefined;
    if (notify && next.state !== prev.state) {
      if (next.state === 'done') kind = next.errored ? 'errored' : 'done';
      else if (NEEDS_YOU_STATES.includes(next.state)) kind = 'needsYou';
    }
    if (kind) this.markUnread(id);
    this.emitNode(id);
    if (kind) {
      const title = this.registry.get(id)?.title ?? id;
      this.emit('notify', { id, kind, title, body: (next.lastAssistantMessage ?? next.activity)?.slice(0, 200) } satisfies NotifyEvent);
    }
  }

  private markUnread(id: string): void {
    const rt = this.runtimes.get(id);
    if (rt && !this.isSelected(id)) rt.unread = true;
  }

  emitNode(id: string): NodeView | undefined {
    const v = this.view(id);
    if (v) this.emit('node', v);
    return v;
  }
}
