/**
 * Tiller Pi extension.
 *
 * Load with `pi --extension <path-to-this-directory>` (or via a Pi package). The extension is
 * inert unless the daemon launched Pi with `TL_NODE_ID`, `TL_ENDPOINT`, and `TL_TOKEN_FILE`.
 *
 * What it bridges, using the current Tiller mod-facing protocol (`src/shared/protocol.ts`):
 * - Registers the Tiller MCP server (`pi.registerMcpServer`) with node-scoped auth headers.
 * - Polls `/inbox`, claims only the immediate next message, submits through `pi.sendUserMessage`,
 *   and acks only once a matching `before_agent_start` confirms Pi accepted the prompt. A void
 *   `sendUserMessage` return is ambiguous; after a bounded wait the claim retires as unconfirmed
 *   (stalled/nonretryable), never re-sent or falsely acknowledged. Messages are claimed only while
 *   Pi is idle, so they stay withdrawable until then; steers abort the running turn first. A claim
 *   Pi became busy before submitting is released back to the daemon as retryable.
 * - Reports `/hook` `SessionStart` with the daemon's `TL_SESSION_ID` (never Pi's own header UUID),
 *   `UserPromptSubmit` from the actual `before_agent_start` prompt, `SessionEnd`, and optionally
 *   PreToolUse/PostToolUse for tool activity.
 * - Reports `/mod-event` `turn.start` once per run (from `agent_start`), `turn.complete` on
 *   `agent_settled` (the final boundary, with the final message's `stopReason` mapped to
 *   aborted/error/answer), and `session.measure`.
 * - Maps Pi's `ui_prompt_start` / `ui_prompt_end` onto the daemon's Notification / PostToolUse
 *   reducer events so a waiting extension dialog shows as waiting/blocked and closes back to
 *   working. Only dialogs during an active run (from `before_agent_start`/`agent_start` through
 *   `agent_settled`) map; idle slash-command dialogs are ignored, and nested dialogs are counted
 *   so one mapped start pairs with one mapped end.
 *
 * Every lifecycle HTTP call is serialized through one queue, so `SessionStart` can never race the
 * first turn's events; handlers for state-critical events await that queue.
 *
 * It does not change Pi's permission handling; the daemon refuses restrictions it cannot map
 * before launch.
 */

import { randomBytes } from "node:crypto";
import { TillerBridge } from "./bridge.ts";
import { readToken, TillerClient, type TillerModEventName } from "../shared/client.ts";
import {
  missingCapabilities,
  nativePiVersion,
  supportsNativeEvents,
  parseBridgeConfig,
  type BridgeConfig,
} from "./config.ts";
import {
  measureContext,
  messageText,
  providerReportedCost,
  sessionEndHook,
  sessionStartHook,
  sumSessionCost,
  toolHook,
  turnCompletePayload,
  turnStartPayload,
  uiPromptHook,
  userPromptHook,
  withProviderCost,
} from "./lifecycle.ts";
import { SerialQueue } from "./queue.ts";
import type {
  PiExtensionApiLike,
  PiExtensionContextLike,
  SessionInfo,
} from "./types.ts";

const MCP_DESCRIPTION =
  "Tiller node orchestration: spawn, message, read, and monitor sibling and child nodes, and report outcomes.";

/**
 * Plain session data for a hook. `managedSessionId` is the daemon's `TL_SESSION_ID`; when present
 * it wins over Pi's own header UUID, because the node record, transcript path and resume all key
 * off the Tiller id.
 */
function sessionInfo(
  ctx: PiExtensionContextLike | undefined,
  model?: string,
  managedSessionId?: string,
): SessionInfo {
  const manager = ctx?.sessionManager;
  let sessionId = managedSessionId?.trim() ?? "";
  let transcriptPath: string | undefined;
  try {
    transcriptPath = manager?.getSessionFile?.();
  } catch {
    transcriptPath = undefined;
  }
  if (!sessionId) {
    try {
      sessionId = manager?.getSessionId?.() ?? "";
    } catch {
      sessionId = "";
    }
  }
  return { sessionId, transcriptPath, model };
}

function modelOf(ctx: PiExtensionContextLike | undefined): string | undefined {
  const model = ctx?.model;
  return model?.id ? (model.provider ? `${model.provider}/${model.id}` : model.id) : undefined;
}

function contextUsage(ctx: PiExtensionContextLike | undefined) {
  try {
    return ctx?.getContextUsage?.();
  } catch {
    return undefined;
  }
}

function sessionCost(ctx: PiExtensionContextLike | undefined): { usd: number; unpriced: number } {
  try {
    return sumSessionCost(ctx?.sessionManager?.getEntries?.() ?? []);
  } catch {
    return { usd: 0, unpriced: 0 };
  }
}

/** The final assistant message of a run, for `turn.complete`'s answer and error mapping. */
function lastAssistantMessage(messages: unknown): unknown {
  if (!Array.isArray(messages)) return undefined;
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message && typeof message === "object" && (message as { role?: unknown }).role === "assistant") {
      return message;
    }
  }
  return undefined;
}

export default function tillerPiExtension(
  pi: PiExtensionApiLike,
  // Tests/fake CLI supply the host version without installing a second Pi runtime.
  dependencies: { getVersion?: () => Promise<string | undefined> } = {},
): void {
  // Extension state. The factory is called once per runtime load; a /reload or session
  // replacement builds a fresh closure, and session_shutdown stops the previous bridge.
  let currentCtx: PiExtensionContextLike | undefined;
  let config: BridgeConfig | undefined;
  let client: TillerClient | undefined;
  let bridge: TillerBridge | undefined;
  let currentModel: string | undefined;
  let lastUserText = "";
  let lastTurnIndex = 0;
  /** Start of the current run (from agent_start), so turn.complete measures the whole run. */
  let runStartedAt = Date.now();
  let lastTurnMessage: unknown;
  /** True from before_agent_start / agent_start until agent_settled: the only window where UI
   *  prompts belong to a run rather than to an idle extension command dialog. */
  let runActive = false;
  /** Open UI prompts seen during the run. Only the mapped (outermost) start gets a mapped end. */
  let uiOpenCount = 0;
  /** Unpriced usage entries at the last session.measure; set from the session at startup, so a
   *  resumed session's earlier unpriced usage is not reported as new. */
  let unpricedMeasured = 0;
  const lifecycle = new SerialQueue();

  /** The daemon minted this Pi session; absent only on an unmanaged launch. */
  const managedSessionId = (): string | undefined => config?.sessionId;
  const isManagedSession = (): boolean => Boolean(process.env.TL_SESSION_ID?.trim());

  const info = (ctx: PiExtensionContextLike | undefined, model = currentModel): SessionInfo =>
    sessionInfo(ctx, model, managedSessionId());

  const report = (message: string, type: "info" | "warning" | "error" = "warning"): void => {
    try {
      currentCtx?.ui?.notify?.(message, type);
    } catch {
      /* no UI available */
    }
    if (type === "error") console.error(`[tiller] ${message}`);
  };

  /**
   * Report an activation/configuration failure and ask Pi to shut down. A managed node must never
   * be left running with a half-initialised bridge (no MCP server, no inbox polling, or an
   * unknown token), so every activation error fail-closes the same way.
   */
  const failClosed = (ctx: PiExtensionContextLike, message: string): void => {
    report(message, "error");
    try {
      ctx.shutdown?.();
    } catch {
      /* no shutdown available */
    }
  };

  const forwardHook = (event: Record<string, unknown>): Promise<void> =>
    lifecycle.enqueue(async () => {
      try {
        await client?.hook(event);
      } catch (error) {
        console.error(`[tiller] /hook failed: ${String(error)}`);
      }
    });

  const forwardModEvent = (event: TillerModEventName, payload: object): Promise<void> =>
    lifecycle.enqueue(async () => {
      try {
        await client?.modEvent(event, payload as Record<string, unknown>);
      } catch (error) {
        console.error(`[tiller] /mod-event ${event} failed: ${String(error)}`);
      }
    });

  const sendMeasure = (): Promise<void> => {
    const context = measureContext(contextUsage(currentCtx));
    const { usd, unpriced } = sessionCost(currentCtx);
    // `incomplete` covers the whole session; `unpricedAdded` only usage new since the last measure,
    // so the daemon marks just the day it happened on.
    const unpricedAdded = unpriced > unpricedMeasured;
    unpricedMeasured = unpriced;
    return forwardModEvent("session.measure", {
      ...(currentModel ? { model: currentModel } : {}),
      ...(context ? { context } : {}),
      ...(usd > 0 || unpriced > 0
        ? { cost: { usd, ...(unpriced > 0 ? { incomplete: true } : {}), ...(unpricedAdded ? { unpricedAdded } : {}) } }
        : {}),
    });
  };

  // OpenRouter reports what it charged on the final stream chunk; Pi prices from its catalog and
  // records $0 for unpriced models such as openrouter/auto. Hold the reported cost by response id
  // and write it into the assistant message at message_end, before Pi persists it, so the session
  // entries (and Pi's own totals) carry the real figure.
  const providerCosts = new Map<string, number>();
  pi.on("provider_stream_event", (event) => {
    if (!config) return;
    const reported = providerReportedCost(event?.data);
    if (reported) providerCosts.set(reported.responseId, reported.usd);
  });

  pi.on("message_end", (event) => {
    if (!config || providerCosts.size === 0 || event?.message?.role !== "assistant") return;
    const message = withProviderCost(event.message, providerCosts);
    providerCosts.clear(); // one stream per assistant message; drop anything it did not claim
    return message ? { message } : undefined;
  });

  pi.on("session_start", async (event, ctx) => {
    currentCtx = ctx;

    // A managed node must not let Pi replace its session: the daemon tracks one session id and
    // transcript path. The session_before_* guards below normally cancel this; if a build does not
    // honor them, fail closed rather than leave the node pointing at a different conversation.
    if (isManagedSession() && (event?.reason === "new" || event?.reason === "resume" || event?.reason === "fork")) {
      failClosed(ctx, `tiller: refusing managed session replacement (${event.reason}); shutting down`);
      return;
    }

    if (!process.env.TL_NODE_ID?.trim()) return; // inert unless Tiller launched us

    // Start clean if a previous session left a timer behind (defensive; shutdown should have run).
    bridge?.stopPolling();
    bridge = undefined;
    client?.dispose();
    client = undefined;
    config = undefined;

    const parsed = parseBridgeConfig(process.env);
    if (!parsed.ok) {
      failClosed(ctx, `tiller: not activating: ${parsed.error}`);
      return;
    }

    // Capability gate: fail closed *before* registering the MCP server or reading the token, so an
    // incompatible Pi never runs as a half node that silently misses its tools or messages.
    const missing = missingCapabilities(pi);
    const version = await (dependencies.getVersion ?? nativePiVersion)();
    if (!supportsNativeEvents(version)) missing.push(`native Pi 1.2.x/1.3.x events (version ${version ?? "unknown"})`);
    if (typeof ctx.isIdle !== "function") missing.push("ctx.isIdle");
    if (typeof ctx.abort !== "function") missing.push("ctx.abort");
    if (typeof ctx.shutdown !== "function") missing.push("ctx.shutdown");
    if (missing.length > 0) {
      failClosed(ctx, `tiller: incompatible Pi build (missing ${missing.join(", ")}); not activating`);
      return;
    }

    config = parsed.config;
    // File MCP entries silently override extension registrations. Use a fresh node-scoped name
    // each runtime: ordinary `tiller` (or an old runtime's entry) cannot shadow authenticated tools.
    config.mcpName += `_${randomBytes(6).toString("hex")}`; // 48-bit entropy; full server name <=24 chars
    currentModel = modelOf(ctx);
    lastUserText = "";
    lastTurnIndex = 0;
    lastTurnMessage = undefined;
    runActive = false;
    uiOpenCount = 0;
    runStartedAt = Date.now();

    let token: string;
    try {
      token = await readToken(config.tokenFile);
    } catch (error) {
      config = undefined;
      failClosed(ctx, `tiller: cannot read token file: ${String(error)}`);
      return;
    }
    client = new TillerClient({
      endpoint: config.endpoint,
      nodeId: config.nodeId,
      token,
    });

    // Node-scoped Tiller MCP registration. Without it the node cannot call any Tiller tool, so a
    // failure is fatal rather than a warning: fail closed and ask Pi to shut down.
    try {
      pi.registerMcpServer!(config.mcpName, {
        type: "http",
        url: `${config.endpoint}/mcp`,
        headers: {
          Authorization: `Bearer ${token}`,
          "X-TL-Node": config.nodeId,
        },
        exposure: config.exposure,
        description: MCP_DESCRIPTION,
      });
    } catch (error) {
      client.dispose();
      client = undefined;
      config = undefined;
      failClosed(ctx, `tiller: could not register MCP server: ${String(error)}; shutting down`);
      return;
    }

    // SessionStart goes first and is awaited, so no turn event can reach the daemon before the
    // daemon knows which session it belongs to.
    await forwardHook(sessionStartHook(info(ctx)));

    bridge = new TillerBridge({
      client,
      isIdle: () => currentCtx?.isIdle() ?? true,
      abort: () => currentCtx?.abort(),
      sendUserMessage: (text) => pi.sendUserMessage(text),
      // Bookkeeping only. The `UserPromptSubmit` receipt is emitted from `before_agent_start`
      // once Pi has actually accepted the message, never here.
      onSubmit: (message) => {
        lastUserText = message.text;
      },
      onUnconfirmed: (message) => {
        report(`tiller: message ${message.id} unconfirmed; it may still run later; do not resend automatically`, "warning");
      },
      onExpired: (message) => {
        // Disappearance does not prove rejection. The daemon may have retired it or closed/restarted.
        report(`tiller: message ${message.id} removed without confirmed acceptance; do not resend automatically`, "warning");
      },
      onError: (error, phase) => {
        console.error(`[tiller] bridge ${phase}: ${String(error)}`);
      },
      pollIntervalMs: config.pollIntervalMs,
    });
    bridge.startPolling();

    // Start from a known baseline: record cost/context once the MCP and hooks are in place.
    unpricedMeasured = sessionCost(ctx).unpriced;
    await sendMeasure();
  });

  pi.on("session_shutdown", async (event, ctx) => {
    currentCtx = ctx;
    runActive = false;
    uiOpenCount = 0;
    bridge?.stopPolling();
    bridge = undefined;
    // Only a real quit ends the node; reload/new/resume/fork replace the runtime and a fresh
    // session_start follows, so SessionEnd would just flap the node's state. Skip it entirely when
    // the gate never activated the bridge (no client).
    if (event?.reason === "quit" && client) await forwardHook(sessionEndHook(info(ctx)));
    // Let queued hooks land before tearing the client down, then cancel anything still in flight.
    await lifecycle.drain();
    try {
      if (config) pi.unregisterMcpServer?.(config.mcpName);
    } catch {
      /* nothing registered, or another extension owns the name */
    }
    client?.dispose();
    config = undefined;
    client = undefined;
    currentCtx = undefined;
  });

  // Pi's own /new, /resume, /fork and /tree would move the session id and file out from under the
  // daemon. For a managed node they are cancelled: the daemon owns the conversation and resume.
  pi.on("session_before_switch", (_event, ctx) => {
    currentCtx = ctx;
    if (!isManagedSession()) return;
    report("tiller: this node's session is managed by Tiller; /new and /resume are disabled", "warning");
    return { cancel: true };
  });

  pi.on("session_before_fork", (_event, ctx) => {
    currentCtx = ctx;
    if (!isManagedSession()) return;
    report("tiller: this node's session is managed by Tiller; /fork is disabled", "warning");
    return { cancel: true };
  });

  pi.on("session_before_tree", (_event, ctx) => {
    currentCtx = ctx;
    if (!isManagedSession()) return;
    report("tiller: this node's session is managed by Tiller; /tree is disabled", "warning");
    return { cancel: true };
  });

  pi.on("before_agent_start", async (event, ctx) => {
    currentCtx = ctx;
    currentModel = modelOf(ctx) ?? currentModel;
    // `before_agent_start` fires before the run starts and carries the real prompt. This is the
    // only place a `UserPromptSubmit` receipt comes from, so a failed `sendUserMessage` (which
    // never reaches this event) cannot be acked as delivered.
    if (event?.messageType === "user" && typeof event.prompt === "string") {
      lastUserText = event.prompt;
      runActive = true;
      await forwardHook(userPromptHook({ ...info(ctx), text: event.prompt }));
      // Only now, after the actual prompt reached the daemon, is the injected message accepted.
      // This is the sole place a delivery is confirmed; a void `sendUserMessage` return is not.
      await bridge?.confirmAccepted(event.prompt);
    }
  });

  // The run, not the individual turns, is the unit of work: one `turn.start` from `agent_start`
  // through the final `agent_settled`, even when a tool-using run makes several model turns.
  pi.on("agent_start", async (_event, ctx) => {
    currentCtx = ctx;
    runActive = true;
    runStartedAt = Date.now();
    lastTurnIndex = 0;
    // A new run must not report a previous run's final message (and its stopReason) if this one
    // errors before producing its own.
    lastTurnMessage = undefined;
    await forwardModEvent("turn.start", turnStartPayload(lastUserText, lastTurnIndex));
  });

  pi.on("model_select", async (event, ctx) => {
    currentCtx = ctx;
    currentModel = modelOf({ ...ctx, model: event?.model ?? ctx.model }) ?? currentModel;
    await sendMeasure(); // persist idle switches too, without fabricating a run boundary
  });

  pi.on("turn_start", (event, ctx) => {
    currentCtx = ctx;
    if (typeof event?.turnIndex === "number") lastTurnIndex = event.turnIndex;
  });

  pi.on("turn_end", async (event, ctx) => {
    currentCtx = ctx;
    if (typeof event?.turnIndex === "number") lastTurnIndex = event.turnIndex;
    lastTurnMessage = event?.message;
    await sendMeasure();
  });

  // `agent_end` carries the final messages even when a turn did not reach `turn_end`; keep the
  // final assistant message so `agent_settled` can distinguish an error from a normal stop.
  pi.on("agent_end", (event, ctx) => {
    currentCtx = ctx;
    const final = lastAssistantMessage(event?.messages);
    if (final) lastTurnMessage = final;
  });

  // `agent_settled` is the final boundary: no automatic retry, compaction, or continuation
  // follows. Report the Tiller turn as complete here rather than on the earlier `agent_end`.
  pi.on("agent_settled", async (event, ctx) => {
    currentCtx = ctx;
    // The run ends at this final boundary; UI prompts after it belong to idle Pi dialogs.
    runActive = false;
    uiOpenCount = 0;
    const stopReason = (lastTurnMessage as { stopReason?: unknown } | undefined)?.stopReason;
    await forwardModEvent(
      "turn.complete",
      turnCompletePayload({
        turnId: lastTurnIndex,
        aborted: event?.aborted === true,
        durationMs: Date.now() - runStartedAt,
        answer: messageText(lastTurnMessage),
        model: currentModel,
        // `model` is provider-qualified for replay; usage's provider is separate metadata.
        provider: ctx?.model?.provider,
        stopReason: typeof stopReason === "string" ? stopReason : undefined,
      }),
    );
    await sendMeasure();
  });

  // Pi extension dialogs are the node's "needs you" moments, but only during an active run: a
  // prompt from an idle slash command is not the node blocking on the model. Nested dialogs are
  // counted so one mapped `start` pairs with exactly one mapped `end`.
  pi.on("ui_prompt_start", async (event, ctx) => {
    currentCtx = ctx;
    if (!runActive) return;
    uiOpenCount += 1;
    if (uiOpenCount > 1) return; // a nested dialog does not re-open the mapped prompt
    await forwardHook(
      uiPromptHook({
        phase: "start",
        kind: String(event?.kind ?? ""),
        title: event?.title,
        sessionId: info(ctx).sessionId,
      }),
    );
  });

  pi.on("ui_prompt_end", async (event, ctx) => {
    currentCtx = ctx;
    if (uiOpenCount === 0) return; // idle dialog, or its start was never mapped
    uiOpenCount -= 1;
    if (uiOpenCount > 0) return; // still inside the mapped prompt
    await forwardHook(
      uiPromptHook({
        phase: "end",
        kind: String(event?.kind ?? ""),
        sessionId: info(ctx).sessionId,
      }),
    );
  });

  pi.on("tool_execution_start", async (event, ctx) => {
    currentCtx = ctx;
    if (!config?.hookTools) return;
    await forwardHook(
      toolHook({
        phase: "start",
        toolName: String(event?.toolName ?? ""),
        input: event?.args,
        sessionId: info(ctx).sessionId,
      }),
    );
  });

  pi.on("tool_execution_end", async (event, ctx) => {
    currentCtx = ctx;
    if (!config?.hookTools) return;
    await forwardHook(
      toolHook({
        phase: "end",
        toolName: String(event?.toolName ?? ""),
        input: event?.args,
        isError: event?.isError === true,
        sessionId: info(ctx).sessionId,
      }),
    );
  });
}
