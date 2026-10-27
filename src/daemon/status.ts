import { basename } from 'node:path';
import type { AgentState, NodeKind, NodeStatus } from '../shared/protocol.js';

/** Raw JSON Claude Code posts to a hook. Payloads vary, so only the name is typed. */
export interface HookEvent {
  hook_event_name: string;
  session_id?: string;
  [key: string]: unknown;
}

const DONE_HOLDOFF_MS = 3000;
const STALE_MS = 20 * 60 * 1000;

/** A node's state before any hook arrives: a Claude node is unknown until SessionStart; a terminal has no agent state. */
export const initialState = (kind: NodeKind): AgentState => (kind === 'terminal' ? 'none' : 'unknown');

const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);

/** Same node, new state. Every call here is a real change, so changedAt moves and a stall marker clears. */
function next(prev: NodeStatus, patch: Partial<NodeStatus>, now: number): NodeStatus {
  return { ...prev, stalled: undefined, ...patch, changedAt: now };
}

const toolInput = (event: HookEvent) => (event.tool_input ?? {}) as Record<string, unknown>;

function toolDetail(event: HookEvent): string | undefined {
  const tool = str(event.tool_name);
  const input = toolInput(event);
  if (tool === 'Bash') return str(input.command)?.slice(0, 60);
  if (tool === 'Edit' || tool === 'Write' || tool === 'Read') {
    const p = str(input.file_path);
    return p && basename(p);
  }
  return undefined;
}

function toolActivity(event: HookEvent): string | undefined {
  const tool = str(event.tool_name);
  const detail = toolDetail(event);
  return tool && (detail ? `${tool}: ${detail}` : tool);
}

/** What a blocked node waits on. A Notification may carry only a message; keep an activity a PermissionRequest already set. */
function approvalActivity(prev: NodeStatus, event: HookEvent): string | undefined {
  const tool = str(event.tool_name);
  if (tool) return `needs approval: ${tool}${toolDetail(event) ? ` ${toolDetail(event)}` : ''}`;
  if (prev.activity?.startsWith('needs approval')) return prev.activity;
  return str(event.message)?.slice(0, 80);
}

/** The AskUserQuestion prompt, from either `question` or the first of `questions`. */
function questionActivity(event: HookEvent): string | undefined {
  const input = toolInput(event);
  const q = str(input.question) ?? str((input.questions as { question?: unknown }[] | undefined)?.[0]?.question);
  return q && `question: ${q.slice(0, 60)}`;
}

/** Turn ends: leave working/waiting/blocked for done, dropping the activity line. */
function done(prev: NodeStatus, now: number, patch: Partial<NodeStatus> = {}): NodeStatus {
  return next(prev, { state: 'done', activity: undefined, ...patch }, now);
}

/** A blocked/waiting event that arrives after its own turn already ended: same prompt_id, else within the holdoff. */
function lateAfterDone(prev: NodeStatus, event: HookEvent, now: number): boolean {
  if (prev.state !== 'done') return false;
  const id = str(event.prompt_id);
  return id && prev.promptId ? id === prev.promptId : now - prev.changedAt < DONE_HOLDOFF_MS;
}

export function reduce(prev: NodeStatus, event: HookEvent, now: number): NodeStatus {
  const out = step(prev, event, now);
  // Recorded even inside the done holdoff, without touching state or changedAt.
  const permissionMode = str(event.permission_mode) ?? out.permissionMode;
  const model = event.hook_event_name === 'SessionStart' ? str(event.model) ?? out.model : out.model;
  const effort = str((event.effort as { level?: unknown } | undefined)?.level) ?? out.effort;
  return permissionMode === out.permissionMode && model === out.model && effort === out.effort ? out : { ...out, permissionMode, model, effort };
}

function step(prev: NodeStatus, event: HookEvent, now: number): NodeStatus {
  switch (event.hook_event_name) {
    case 'UserPromptSubmit':
      return next(prev, {
        state: 'working', promptId: str(event.prompt_id), errored: undefined, interrupted: undefined, stale: undefined, doneSource: undefined,
        lastAssistantMessage: undefined, activity: undefined,
      }, now);

    case 'PreToolUse':
    case 'PostToolUse': {
      // Hooks run in parallel, so a late tool event can land just after Stop.
      if (prev.state === 'done' && now - prev.changedAt < DONE_HOLDOFF_MS) return prev;
      if (event.hook_event_name === 'PreToolUse') {
        if (event.tool_name === 'AskUserQuestion') return next(prev, { state: 'waiting', activity: questionActivity(event) }, now);
        return next(prev, { state: 'working', activity: toolActivity(event) }, now);
      }
      return next(prev, { state: 'working', activity: prev.state === 'working' ? prev.activity : undefined }, now);
    }

    case 'PermissionRequest':
      return lateAfterDone(prev, event, now) ? prev : next(prev, { state: 'blocked', activity: approvalActivity(prev, event) }, now);

    case 'Notification':
      switch (event.notification_type) {
        case 'permission_prompt':
          return lateAfterDone(prev, event, now) ? prev : next(prev, { state: 'blocked', activity: approvalActivity(prev, event) }, now);
        case 'elicitation_dialog':
        case 'agent_needs_input':
          return lateAfterDone(prev, event, now) ? prev : next(prev, { state: 'waiting' }, now);
        case 'idle_prompt':
          return prev.state === 'working' ? done(prev, now, { doneSource: 'idle_prompt' }) : prev;
        default:
          return prev; // closed allowlist: unknown types never move state
      }

    case 'Stop':
      return done(prev, now, {
        doneSource: 'stop',
        interrupted: event.is_interrupt ? true : undefined,
        lastAssistantMessage: str(event.last_assistant_message),
      });

    case 'StopFailure':
      return done(prev, now, { doneSource: 'stop', errored: true, lastAssistantMessage: str(event.last_assistant_message) ?? prev.lastAssistantMessage });

    case 'SessionStart': // the manager records its session_id and transcript_path on the node's record
    case 'SessionEnd':
      return next(prev, { state: 'unknown', activity: undefined }, now);

    default:
      return prev;
  }
}

/** Working with no state change for 20 minutes is presumed finished. */
export function sweep(prev: NodeStatus, now: number): NodeStatus {
  return prev.state === 'working' && now - prev.changedAt > STALE_MS ? done(prev, now, { stale: true, doneSource: 'sweep' }) : prev;
}

/** Working with no state change for `ms` is marked stalled. changedAt stays put, so it still says when activity stopped. */
export function stall(prev: NodeStatus, now: number, ms: number): NodeStatus {
  return prev.state === 'working' && !prev.stalled && now - prev.changedAt > ms ? { ...prev, stalled: true } : prev;
}

/** A turn is in progress: working, or waiting on the human mid-turn. */
export const active = (s: NodeStatus) => s.state === 'working' || s.state === 'waiting' || s.state === 'blocked';

export function ptyExited(prev: NodeStatus, now: number): NodeStatus {
  if (active(prev)) return next(prev, { exited: true, state: 'done', doneSource: 'exit', activity: undefined }, now);
  return prev.exited ? prev : next(prev, { exited: true }, now);
}

/** True when `data` typed into the node is a lone Esc or Ctrl-C and the node is working. */
export function interruptKeyPressed(prev: NodeStatus, data: string): boolean {
  return prev.state === 'working' && (data === '\x1b' || data === '\x03');
}

/** Call 1.5 s after interruptKeyPressed if no hook event arrived since (caller's timer). */
export function interruptTimeout(prev: NodeStatus, now: number): NodeStatus {
  return prev.state === 'working' ? done(prev, now, { interrupted: true, doneSource: 'interrupt' }) : prev;
}

/**
 * The mod's turn.complete is authoritative: the turn is over even when no Stop hook follows (a denied permission
 * prompt ends the turn with no Stop, PostToolUse or PostToolUseFailure). Moves working/waiting/blocked to done.
 */
export function turnComplete(prev: NodeStatus, now: number, o: { isAborted?: boolean; reason?: string }): NodeStatus {
  if (!active(prev)) return prev;
  if (o.isAborted) return done(prev, now, { interrupted: true, doneSource: 'interrupt' });
  return done(prev, now, o.reason === 'error' ? { errored: true, doneSource: 'stop' } : { doneSource: 'stop' });
}
