/**
 * Tiny HTTP client for the Tiller mod-facing API (`src/shared/protocol.ts`).
 *
 * Mirrors `mod/hooks/api.ts`: every request carries `Authorization: Bearer <token>` and
 * `X-TL-Node: <nodeId>`. `fetch` is injectable so the pure helpers can be tested without a
 * network or agent harness.
 */

import { readFile } from "node:fs/promises";

export interface TillerResponseLike {
  status: number;
  text(): Promise<string>;
}

export type TillerFetchLike = (
  url: string,
  init: {
    method: string;
    headers: Record<string, string>;
    body?: string;
    signal?: AbortSignal;
  },
) => Promise<TillerResponseLike>;

export interface InboxMessage {
  id: string;
  /** Display label of the sender. */
  from?: string;
  text: string;
  enqueuedAt?: number;
  /** A previous bridge claimed this prompt; never replay it after reload/restart. */
  claimed?: boolean;
  /** Abort the running turn and submit now instead of waiting for idle. */
  steer?: boolean;
}

export type TillerModEventName = "turn.start" | "turn.complete" | "session.measure";

export interface TillerClientOptions {
  endpoint: string;
  nodeId: string;
  token: string;
  fetch?: TillerFetchLike;
  /** Per-request timeout. A local daemon answers quickly; a hung request must not stall the adapter. Default 5000. */
  timeoutMs?: number;
}

export class TillerHttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "TillerHttpError";
  }
}

/** Auth headers for a node-scoped Tiller request. Exported for daemon/tests. */
export function authHeaders(nodeId: string, token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    "X-TL-Node": nodeId,
    "Content-Type": "application/json",
  };
}

/**
 * Read and trim the node token. A leading/trailing newline is normal because the daemon writes
 * the token to a 0600 file; an empty token is an error.
 */
export async function readToken(
  tokenFile: string,
  readFileFn: (path: string) => Promise<string> = (path) => readFile(path, "utf8"),
): Promise<string> {
  const token = (await readFileFn(tokenFile)).trim();
  if (!token) throw new Error(`token file is empty: ${tokenFile}`);
  return token;
}

export class TillerClient {
  private readonly endpoint: string;
  private readonly nodeId: string;
  private readonly token: string;
  private readonly fetchFn: TillerFetchLike;
  private readonly timeoutMs: number;
  /** Aborted by `dispose()` so shutdown does not leave in-flight requests (or their timers) behind. */
  private readonly controller = new AbortController();

  constructor(options: TillerClientOptions) {
    this.endpoint = options.endpoint.replace(/\/+$/, "");
    this.nodeId = options.nodeId;
    this.token = options.token;
    this.fetchFn = options.fetch ?? (fetch as unknown as TillerFetchLike);
    this.timeoutMs = options.timeoutMs ?? 5000;
  }

  /** Build the URL and fetch init for a request; pure and easily asserted in tests. */
  request(
    method: string,
    path: string,
    body?: unknown,
  ): [string, { method: string; headers: Record<string, string>; body?: string; signal?: AbortSignal }] {
    // A per-request timeout plus the client-wide shutdown signal: whichever fires first wins.
    const signal = AbortSignal.any([AbortSignal.timeout(this.timeoutMs), this.controller.signal]);
    return [
      `${this.endpoint}${path}`,
      {
        method,
        headers: authHeaders(this.nodeId, this.token),
        body: body === undefined ? undefined : JSON.stringify(body),
        signal,
      },
    ];
  }

  /** Abort in-flight requests (and stop accepting new ones). Safe to call more than once. */
  dispose(): void {
    this.controller.abort();
  }

  private async raw(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<{ status: number; text: string }> {
    const [url, init] = this.request(method, path, body);
    const response = await this.fetchFn(url, init);
    return { status: response.status, text: await response.text() };
  }

  /** Perform a request, parsing JSON on success. Non-2xx throws; callers that accept 404 use `raw`/`claim`. */
  async call<T = unknown>(method: string, path: string, body?: unknown): Promise<T | undefined> {
    const { status, text } = await this.raw(method, path, body);
    if (status >= 200 && status < 300) {
      return text ? (JSON.parse(text) as T) : undefined;
    }
    throw new TillerHttpError(`${method} ${path}: ${status}${text ? ` ${text}` : ""}`, status);
  }

  /** Unacked messages for this node, oldest first. */
  inbox(): Promise<InboxMessage[]> {
    return this.call<InboxMessage[]>("GET", "/inbox").then((messages) => messages ?? []);
  }

  /**
   * Claim a message just before submitting it. Returns false when the daemon answers 404
   * (withdrawn or expired), so the caller must not submit it.
   */
  async claim(id: string): Promise<boolean> {
    const { status } = await this.raw("POST", "/claim", { id });
    if (status === 404) return false;
    if (status >= 200 && status < 300) return true;
    throw new TillerHttpError(`POST /claim: ${status}`, status);
  }

  /** Acknowledge a claimed message once it has been submitted. */
  async ack(id: string): Promise<void> {
    await this.call("POST", "/ack", { id });
  }

  /** Hand back a claim that was never submitted. Returns false when the daemon no longer has it (404). */
  async release(id: string): Promise<boolean> {
    const { status } = await this.raw("POST", "/release", { id });
    if (status === 404) return false;
    if (status >= 200 && status < 300) return true;
    throw new TillerHttpError(`POST /release: ${status}`, status);
  }

  /** Retire an ambiguous native submission. No delivery receipt and no automatic retry. */
  async unconfirmed(id: string): Promise<void> {
    await this.call("POST", "/unconfirmed", { id });
  }

  /** Forward a lifecycle event. */
  async modEvent(event: TillerModEventName, payload: Record<string, unknown>): Promise<void> {
    await this.call("POST", "/mod-event", { event, payload });
  }

  /** Forward a Claude-style hook event (SessionStart, UserPromptSubmit, PreToolUse, ...). */
  async hook(event: Record<string, unknown>): Promise<void> {
    await this.call("POST", "/hook", event);
  }
}
