/**
 * Minimal structural types for the subset of the Pi extension API the Tiller bridge uses.
 *
 * These are deliberately local: Tiller does not install a second Pi runtime. The extension
 * reads the host-provided VERSION export only for its compatibility gate. Pi passes `ExtensionAPI` / `ExtensionContext`
 * object at load time and the shapes below match it structurally. Keeping the types here also
 * lets the pure helpers and the bridge be unit-tested with a fake Pi, without installing Pi.
 *
 * Compatibility target: @earendil-works/pi-coding-agent 1.2.x/1.3.x (see docs/extensions.md and
 * dist/core/extensions/types.d.ts).
 */

/** HTTP MCP server config accepted by `pi.registerMcpServer()` (shape of an `mcpServers` entry). */
export interface PiMcpServerConfig {
  type?: "http";
  url: string;
  headers?: Record<string, string>;
  /** How the server's tools reach the model. Tiller wants them directly callable. */
  exposure?: "codemode" | "deferred" | "direct" | "hidden";
  description?: string;
}

/** Options accepted by `pi.sendUserMessage()`. */
export interface PiSendUserMessageOptions {
  deliverAs?: "steer" | "followUp";
  expandPromptTemplates?: boolean;
}

/** Context usage returned by `ctx.getContextUsage()`. */
export interface PiContextUsageLike {
  tokens: number | null;
  contextWindow: number;
  percent: number | null;
}

/** Read-only session manager methods used to report the Tiller session and cost. */
export interface PiSessionManagerLike {
  getSessionId?(): string;
  getSessionFile?(): string | undefined;
  getEntries?(): readonly unknown[];
}

/** The `ExtensionContext` members the bridge reads. */
export interface PiExtensionContextLike {
  isIdle(): boolean;
  abort(): void;
  /** Graceful process shutdown; present in every real Pi context. */
  shutdown?(): void;
  getContextUsage?(): PiContextUsageLike | undefined;
  sessionManager?: PiSessionManagerLike;
  model?: { id?: string; provider?: string } | undefined;
  ui?: {
    notify?(message: string, type?: "info" | "warning" | "error"): void;
  };
}

/** The `ExtensionAPI` members the bridge uses. */
export interface PiExtensionApiLike {
  registerMcpServer?(name: string, config: PiMcpServerConfig): void;
  unregisterMcpServer?(name: string): void;
  /** Native Pi is fire-and-forget: it catches/logs prompt errors and returns void. */
  sendUserMessage(content: string, options?: PiSendUserMessageOptions): void;
  on(event: string, handler: (event: any, ctx: PiExtensionContextLike) => unknown): () => void;
}

/** Plain data about the live Pi session, captured from the event context. */
export interface SessionInfo {
  sessionId: string;
  transcriptPath?: string;
  model?: string;
  provider?: string;
}
