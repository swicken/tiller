// The memory gardener (memory v3, docs/memory.md): a daemon-spawned Claude node that merges duplicate memory items and
// hides superseded ones, in one repository of one account file per run. This module schedules runs and drives each one's
// lifecycle; the store checks every action (GardenStore), and the manager hosts the node (GardenHost).
import type { ModEvent, NodeRecord } from '../shared/protocol.js';
import type { GardenRunView, GardenStore, MemoryScope } from './memory-schema.js';
import type { HookEvent } from './status.js';

export const GARDENER_TOOLS = ['garden_list', 'garden_get', 'garden_merge', 'garden_supersede'] as const;
export type GardenerTool = (typeof GARDENER_TOOLS)[number];
/** The gardener's whole tool set as Claude names it: its agent definition and settings.json allow exactly these. */
export const GARDENER_AGENT_TOOLS = GARDENER_TOOLS.map((t) => `mcp__tiller__${t}` as const);
/** The --agents key and --agent name of the gardener's code-built agent definition. */
export const GARDENER_AGENT = 'tiller-gardener';
/**
 * Added to the gardener's launch env. Without them Claude Code 2.1.310 also offers the model `advisor` and a deferred-tool
 * placeholder (spike S0, spike/gardener-flags.ts); re-run the spike after a Claude Code upgrade.
 */
export const GARDENER_ENV = { CLAUDE_CODE_DISABLE_ADVISOR_TOOL: '1', CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS: '1' } as const;

type Measure = Extract<ModEvent, { event: 'session.measure' }>['payload'];

/** What the Gardener needs from the daemon; NodeManager provides it. */
export interface GardenHost {
  readonly home: string;
  readonly store: GardenStore;
  /**
   * Spawn the gardener node: a muted root titled "Memory gardener · <repo basename>" with D1's pinned fields (claude,
   * role none, isolation none, effort medium, this model and account) and NodeRecord.gardener set. Resolves to its id.
   */
  spawnGardener(req: { account?: string; repoPath: string; repoKey: string; runId: number; model: string; prompt: string }): Promise<string>;
  /** End its process through session.terminate(), so the node stays in the tree as exited. */
  stopGardener(nodeId: string): Promise<void>;
  /** Close (forced: it is a root) the earlier gardener node of this repository and account, archiving it with its spend. */
  closePreviousGardener(repoKey: string, account: string | undefined): Promise<void>;
  /** D3: no agent node working, nothing queued, not draining, and live nodes below daemon.maxLiveNodes. */
  quiet(): boolean;
  /** The highest percentUsed among the rate-limit windows usageByAccount holds under these keys; undefined: none known. */
  usageFor(keys: readonly string[]): number | undefined;
  /** Claude would not ask folder trust for path in this account: trustPolicy is auto. */
  trusted(path: string, account: string | undefined): boolean;
  /** The node has a live session in this daemon. */
  live(nodeId: string): boolean;
  /** The node's record (spentUsd and spentIncomplete are the run's cost); undefined once it is closed. */
  record(nodeId: string): NodeRecord | undefined;
  /** Every record with gardener set, live or exited: recovery at start. */
  gardenerRecords(): NodeRecord[];
  /** Show the run's summary as the node's outcome. */
  setOutcome(nodeId: string, outcome: 'succeeded' | 'failed', summary: string): void;
}

/** A garden tool call the Gardener let through: its scope comes from the node record, never from the call's arguments. */
export type GardenCall =
  | { ok: true; scope: MemoryScope; runId: number; callsLeft: number; outputLeft: number }
  | { ok: false; error: string };

/**
 * Schedules garden runs and drives the live one (at most one per daemon). The manager forwards a gardener node's hooks,
 * measures, turn end and exit; the MCP layer asks before each tool call and reports its output size.
 */
export class Gardener {
  constructor(private readonly host: GardenHost, private readonly opts: { now?: () => number } = {}) {}

  /** Start the hourly tick, unref'd. The first tick also recovers runs a previous daemon left. */
  start(): void {}

  /** One pass: recover stale runs, then start the most-new-items due target, if any. */
  async tick(): Promise<void> {}

  /** A node was removed: tick once, LIMITS.garden.afterCloseMs after the last removal. */
  nodeRemoved(): void {}

  /**
   * The human's run (tl memory garden run --repo P): every check except enabled, the interval, the threshold and the
   * pause. wait: resolve once the run has ended.
   */
  async runNow(_target: { repoPath: string; account?: string }, _opts: { wait?: boolean } = {}): Promise<{ ok: true; run: GardenRunView } | { ok: false; reason: string }> {
    return { ok: false, reason: 'not implemented' };
  }

  /** Every hook of a gardener node: PreToolUse and PermissionRequest count as tool calls, and any non-garden tool trips the wire. */
  hook(_nodeId: string, _event: HookEvent): void {}

  /** A gardener node's session.measure, after the manager has added its spend. */
  measured(_nodeId: string, _measure: Measure): void {}

  /** A gardener node finished its turn: the run ends. */
  turnDone(_nodeId: string): void {}

  /** A gardener node's process exited. */
  exited(_nodeId: string): void {}

  /** Before a tool call by a gardener node: refused when the run has ended or memory is off, and any non-garden tool trips the wire. */
  toolCall(_nodeId: string, _tool: string): GardenCall {
    return { ok: false, error: 'not implemented' };
  }

  /** After a garden tool built its result: false (and nothing counted) when it would pass LIMITS.garden.maxOutputChars. */
  toolOutput(_nodeId: string, _chars: number): boolean {
    return false;
  }

  /** drain and shutdown: end the live run as interrupted and stop the timers, without waiting for a run. */
  async stop(): Promise<void> {}
}

/** The run's tool-call cap: at most LIMITS.garden.maxToolCalls, and low enough that D11's worst case fits maxUsdPerRun. */
export function turnBound(_maxUsdPerRun: number): number {
  throw new Error('not implemented');
}

/** Why a target's scheduled runs are paused (D4 rule 8, D11's unpriced measure), from GardenTarget.recent; undefined: not paused. */
export function pausedBy(_recent: readonly GardenRunView[]): string | undefined {
  throw new Error('not implemented');
}

/** The gardener's --append-system-prompt: its own preamble and GARDENER_PROMPT, in place of the node preamble. */
export function gardenerSystemPrompt(_nodeId: string): string {
  throw new Error('not implemented');
}
