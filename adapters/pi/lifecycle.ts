/**
 * Pure mappers from Pi lifecycle data onto the current Tiller protocol
 * (`/hook` events and `/mod-event` payloads in `src/shared/protocol.ts`).
 *
 * Nothing here talks to Pi or the network, so every mapping is unit-testable.
 */

import type { SessionInfo } from "./types.ts";

export interface TillerHookEvent {
  hook_event_name: string;
  [key: string]: unknown;
}

export interface TurnStartPayload {
  text: string;
  turnId: string;
}

export interface TurnCompletePayload {
  answer?: string;
  durationMs: number;
  isAborted: boolean;
  turnId: string;
  reason: "answer" | "aborted" | "refusal" | "error";
  usage?: Record<string, unknown>;
}

export interface SessionMeasureContext {
  tokens: number;
  window: number;
  percent: number;
}

export interface SessionMeasurePayload {
  context?: SessionMeasureContext;
  cost?: { usd: number };
}

/** Remove undefined values so the JSON body stays close to what Claude posts. */
function compact<T extends Record<string, unknown>>(value: T): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined));
}

/**
 * `SessionStart` is what makes the daemon record `session_id` and `transcript_path` on the node.
 * Pi gets the transcript path from the explicit `--session <path>` the daemon supplies.
 */
export function sessionStartHook(info: SessionInfo): TillerHookEvent {
  return {
    hook_event_name: "SessionStart",
    ...compact({
      session_id: info.sessionId || undefined,
      transcript_path: info.transcriptPath,
      model: info.model,
    }),
  };
}

/** `UserPromptSubmit` marks the node working and lets the daemon match the delivered prompt. */
export function userPromptHook(info: SessionInfo & { text: string }): TillerHookEvent {
  return {
    hook_event_name: "UserPromptSubmit",
    ...compact({
      session_id: info.sessionId || undefined,
      prompt: info.text,
    }),
  };
}

/** `SessionEnd` clears the node's state when Pi exits or the session is replaced. */
export function sessionEndHook(info: SessionInfo): TillerHookEvent {
  return {
    hook_event_name: "SessionEnd",
    ...compact({ session_id: info.sessionId || undefined }),
  };
}

/** Pi tool names mapped to the Claude names the daemon's hook reducer knows. */
export const PI_TO_TILLER_TOOL_NAME: Record<string, string> = {
  read: "Read",
  bash: "Bash",
  edit: "Edit",
  write: "Write",
  grep: "Grep",
  find: "Glob",
  ls: "LS",
  powershell: "PowerShell",
};

/** Translate Pi tool input field names to the Claude equivalents the daemon reads. */
export function normalizeToolInput(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input)) return {};
  const out: Record<string, unknown> = { ...(input as Record<string, unknown>) };
  if (out.file_path === undefined && typeof out.path === "string") out.file_path = out.path;
  if (out.old_string === undefined && typeof out.oldText === "string") out.old_string = out.oldText;
  if (out.new_string === undefined && typeof out.newText === "string") out.new_string = out.newText;
  return out;
}

export interface ToolHookInfo {
  toolName: string;
  input: unknown;
  sessionId?: string;
  phase: "start" | "end";
  /** `isError` on the matching `tool_execution_end`. */
  isError?: boolean;
}

/**
 * Pi's extension UI prompts (`ui_prompt_start` / `ui_prompt_end`) onto the hook events the daemon's
 * reducer understands: an open prompt is a `Notification` (`permission_prompt` -> blocked for an
 * approval-style confirm, `elicitation_dialog` -> waiting for a question), and its close returns the
 * node to `working` via `PostToolUse` (the reducer's generic working transition).
 */
export function uiPromptHook(info: {
  phase: "start" | "end";
  kind: string;
  title?: string;
  sessionId?: string;
}): TillerHookEvent {
  if (info.phase === "start") {
    return {
      hook_event_name: "Notification",
      ...compact({
        session_id: info.sessionId || undefined,
        notification_type: info.kind === "confirm" ? "permission_prompt" : "elicitation_dialog",
        message: info.title,
      }),
    };
  }
  return {
    hook_event_name: "PostToolUse",
    ...compact({ session_id: info.sessionId || undefined }),
  };
}

/** Optional `PreToolUse` / `PostToolUse` forwarding. The raw Pi name is kept in `pi_tool_name`. */
export function toolHook(info: ToolHookInfo): TillerHookEvent {
  return {
    hook_event_name: info.phase === "start" ? "PreToolUse" : "PostToolUse",
    ...compact({
      session_id: info.sessionId || undefined,
      tool_name: PI_TO_TILLER_TOOL_NAME[info.toolName] ?? info.toolName,
      pi_tool_name: info.toolName,
      tool_input: normalizeToolInput(info.input),
      ...(info.phase === "end" ? { is_error: info.isError } : {}),
    }),
  };
}

/** The run boundary (`agent_start`) -> Tiller `turn.start` (informational; `turn.complete` is authoritative). */
export function turnStartPayload(text: string, turnIndex: number): TurnStartPayload {
  return { text, turnId: String(turnIndex) };
}

export interface TurnCompleteInfo {
  turnId: string | number;
  aborted: boolean;
  durationMs: number;
  answer?: string;
  model?: string;
  provider?: string;
  /** The final assistant message's `stopReason` (`stop`, `length`, `toolUse`, `error`, `aborted`). */
  stopReason?: string;
}

/**
 * Pi's `agent_settled` is the final boundary: after it Pi will not automatically retry, compact,
 * or continue. Report the Tiller turn as complete there, not on the earlier `agent_end`.
 */
export function turnCompletePayload(info: TurnCompleteInfo): TurnCompletePayload {
  const usage =
    info.model || info.provider
      ? compact({ model: info.model, provider: info.provider })
      : undefined;
  // A run can be aborted (Esc) or end on a provider error. `agent_settled.aborted` covers the
  // former; the final assistant message's `stopReason` distinguishes an error from a normal stop.
  const aborted = info.aborted || info.stopReason === "aborted";
  const reason: TurnCompletePayload["reason"] = aborted
    ? "aborted"
    : info.stopReason === "error"
      ? "error"
      : "answer";
  return compact({
    answer: info.answer,
    durationMs: Math.max(0, Math.round(info.durationMs)),
    isAborted: aborted,
    turnId: String(info.turnId),
    reason,
    usage,
  }) as unknown as TurnCompletePayload;
}

/** Context usage -> Tiller `session.measure` context. Returns undefined when Pi has no estimate. */
export function measureContext(
  usage: { tokens: number | null; contextWindow: number; percent: number | null } | undefined,
): SessionMeasureContext | undefined {
  if (!usage) return undefined;
  const { tokens, contextWindow, percent } = usage;
  const resolvedPercent =
    percent ?? (tokens !== null && contextWindow > 0 ? (tokens / contextWindow) * 100 : null);
  if (tokens === null && resolvedPercent === null) return undefined;
  return {
    tokens: tokens ?? 0,
    window: contextWindow,
    percent: resolvedPercent ?? 0,
  };
}

/**
 * Sum the session cost the way Pi's own `getSessionStats()` does: `usage` entries, compaction /
 * branch-summary usage, and assistant/tool-result message usage. Used for `session.measure.cost`.
 * `unpriced` counts usage with tokens but no cost (an unpriced model with no provider-reported
 * cost); when it is above zero, `usd` is only a lower bound.
 */
export function sumSessionCost(entries: readonly unknown[]): { usd: number; unpriced: number } {
  let usd = 0;
  let unpriced = 0;
  for (const entry of entries) {
    if (!entry || typeof entry !== "object") continue;
    const record = entry as Record<string, any>;
    let usage: unknown;
    if (record.type === "usage") {
      usage = record.usage;
    } else if (
      (record.type === "compaction" || record.type === "branch_summary") &&
      record.usage
    ) {
      usage = record.usage;
    } else if (record.type === "message") {
      const message = record.message;
      if (message?.role === "assistant" || message?.role === "toolResult") usage = message.usage;
    }
    if (!usage || typeof usage !== "object") continue;
    const u = usage as Record<string, any>;
    const cost = u.cost?.total;
    if (typeof cost === "number" && Number.isFinite(cost)) usd += cost;
    const tokens = [u.input, u.output, u.cacheRead, u.cacheWrite].reduce(
      (sum: number, n: unknown) => sum + (typeof n === "number" ? n : 0),
      0,
    );
    if (tokens > 0 && !(typeof cost === "number" && cost > 0) && u.cost?.source !== "provider") unpriced++;
  }
  return { usd, unpriced };
}

const isCost = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n) && n >= 0;

/**
 * The cost a provider reported for one generation in a raw stream chunk, keyed by the chunk's
 * response id (Pi stores the first chunk's id as the message's `responseId`). OpenRouter puts
 * `usage.cost` (USD charged to the account) on the final chunk of every streamed completion. For a
 * bring-your-own-key request that is only OpenRouter's fee, so the upstream provider's charge
 * (`cost_details.upstream_inference_cost`) is added; without it the chunk is ignored and Pi's
 * catalog price stands.
 */
export function providerReportedCost(data: unknown): { responseId: string; usd: number } | undefined {
  if (!data || typeof data !== "object") return undefined;
  const { id, usage } = data as {
    id?: unknown;
    usage?: { cost?: unknown; is_byok?: unknown; cost_details?: { upstream_inference_cost?: unknown } };
  };
  if (typeof id !== "string" || !id || !isCost(usage?.cost)) return undefined;
  if (usage.is_byok !== true) return { responseId: id, usd: usage.cost };
  const upstream = usage.cost_details?.upstream_inference_cost;
  return isCost(upstream) ? { responseId: id, usd: usage.cost + upstream } : undefined;
}

/**
 * The assistant message with its cost total replaced by the provider-reported one, marked
 * `cost.source: "provider"` so a reported $0 (a free model) does not read as unpriced. Pi's
 * per-category breakdown is left as Pi computed it. Undefined when no reported cost applies.
 */
export function withProviderCost(message: unknown, costs: ReadonlyMap<string, number>): unknown {
  if (!message || typeof message !== "object") return undefined;
  const m = message as { role?: unknown; responseId?: unknown; usage?: Record<string, any> };
  if (m.role !== "assistant" || typeof m.responseId !== "string" || !m.usage) return undefined;
  const usd = costs.get(m.responseId);
  if (usd === undefined) return undefined;
  return { ...m, usage: { ...m.usage, cost: { ...m.usage.cost, total: usd, source: "provider" } } };
}

/** Best-effort plain text of an assistant message, for the `turn.complete.answer` field. */
export function messageText(message: unknown): string | undefined {
  if (!message || typeof message !== "object") return undefined;
  const content = (message as { content?: unknown }).content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const parts = content
      .filter(
        (part): part is { type: string; text: string } =>
          !!part &&
          typeof part === "object" &&
          (part as { type?: unknown }).type === "text" &&
          typeof (part as { text?: unknown }).text === "string",
      )
      .map((part) => part.text);
    return parts.length ? parts.join("\n") : undefined;
  }
  return undefined;
}
