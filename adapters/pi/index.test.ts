import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import nativeExtension from "./index.ts";
const tillerPiExtension = (pi: PiExtensionApiLike) => nativeExtension(pi, { getVersion: async () => "1.2.0" });
import type { PiExtensionApiLike, PiExtensionContextLike } from "./types.ts";

type Handler = (event: any, ctx: PiExtensionContextLike) => unknown;

interface FakePi {
  api: PiExtensionApiLike;
  handlers: Map<string, Handler[]>;
  mcp: Array<{ name: string; config?: Record<string, unknown> }>;
  sent: string[];
  /** Replace the submit behavior (for example to throw before Pi accepts the message). */
  sendUserMessage: (content: string) => void;
  emit(event: string, payload?: unknown, ctx?: PiExtensionContextLike): Promise<unknown[]>;
}

function fakePi(): FakePi {
  const handlers = new Map<string, Handler[]>();
  const mcp: Array<{ name: string; config?: Record<string, unknown> }> = [];
  const sent: string[] = [];
  const sendUserMessage = (content: string) => {
    sent.push(String(content));
  };
  const api: PiExtensionApiLike = {
    on(event, handler) {
      const list = handlers.get(event) ?? [];
      list.push(handler as Handler);
      handlers.set(event, list);
      return () => {};
    },
    registerMcpServer(name, config) {
      mcp.push({ name, config: config as unknown as Record<string, unknown> });
    },
    unregisterMcpServer(name) {
      mcp.push({ name });
    },
    sendUserMessage(content) {
      sendUserMessage(String(content));
    },
  };
  return {
    api,
    handlers,
    mcp,
    sent,
    sendUserMessage,
    async emit(event, payload = {}, ctx = fakeContext()) {
      const results: unknown[] = [];
      for (const handler of handlers.get(event) ?? []) results.push(await handler(payload, ctx));
      return results;
    },
  };
}

function fakeContext(overrides: Partial<PiExtensionContextLike> = {}): PiExtensionContextLike {
  return {
    isIdle: () => true,
    abort: () => {},
    getContextUsage: () => ({ tokens: 100, contextWindow: 1000, percent: 10 }),
    sessionManager: {
      getSessionId: () => "sess-1",
      getSessionFile: () => "/home/.tiller/nodes/n-1/sessions/sess-1.jsonl",
      getEntries: () => [{ type: "usage", usage: { cost: { total: 0.5 } } }],
    },
    model: { id: "model-1", provider: "provider-1" },
    ui: { notify: vi.fn() },
    shutdown: () => {},
    ...overrides,
  };
}

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: any;
}

function stubFetch(inbox: unknown[] = []): Call[] {
  const calls: Call[] = [];
  vi.stubGlobal("fetch", async (url: string, init: any) => {
    const body = init?.body ? JSON.parse(init.body) : undefined;
    calls.push({ url, method: init?.method, headers: init?.headers ?? {}, body });
    if (url.endsWith("/inbox")) return { status: 200, text: async () => JSON.stringify(inbox) };
    return { status: 204, text: async () => "" };
  });
  return calls;
}

const ENV_KEYS = [
  "TL_NODE_ID",
  "TL_ENDPOINT",
  "TL_TOKEN_FILE",
  "TL_SESSION_ID",
  "TL_PI_POLL_MS",
] as const;

const ENV_BACKUP: Record<string, string | undefined> = {};
for (const key of ENV_KEYS) ENV_BACKUP[key] = process.env[key];

const tokenDir = mkdtempSync(join(tmpdir(), "tiller-pi-adapter-"));
const tokenFile = join(tokenDir, "token");
writeFileSync(tokenFile, "test-token\n", { mode: 0o600 });

function setBaseEnv(): void {
  process.env.TL_NODE_ID = "n-1";
  process.env.TL_ENDPOINT = "http://127.0.0.1:7777";
  process.env.TL_TOKEN_FILE = tokenFile;
  process.env.TL_SESSION_ID = "tiller-sess-1";
  process.env.TL_PI_POLL_MS = "60000";
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

beforeEach(() => {
  for (const key of ENV_KEYS) delete process.env[key];
  vi.stubGlobal("fetch", undefined);
});

afterEach(() => {
  vi.unstubAllGlobals();
  for (const key of ENV_KEYS) {
    if (ENV_BACKUP[key] === undefined) delete process.env[key];
    else process.env[key] = ENV_BACKUP[key];
  }
});

afterAll(() => rmSync(tokenDir, { recursive: true, force: true }));

describe("tiller pi extension", () => {
  it.each(["1.2.0", "1.3.0"])("activates MCP and lifecycle forwarding on Pi %s", async (version) => {
    setBaseEnv();
    const calls = stubFetch();
    const pi = fakePi();
    const shutdown = vi.fn();
    nativeExtension(pi.api, { getVersion: async () => version });
    await pi.emit("session_start", { reason: "startup" }, fakeContext({ shutdown }));
    expect(shutdown).not.toHaveBeenCalled();
    expect(pi.mcp).toHaveLength(1);
    expect(calls.some((call) => call.body?.hook_event_name === "SessionStart")).toBe(true);
    await pi.emit("session_shutdown", { reason: "quit" });
  });

  it("fails closed when on() accepts unknown event names but the host event contract is unsupported", async () => {
    setBaseEnv();
    const calls = stubFetch();
    const pi = fakePi();
    const shutdown = vi.fn();
    nativeExtension(pi.api, { getVersion: async () => "1.1.9" });
    await pi.emit("session_start", { reason: "startup" }, fakeContext({ shutdown }));
    expect(shutdown).toHaveBeenCalledOnce();
    expect(pi.mcp).toEqual([]);
    expect(calls).toEqual([]);
  });

  it("a file-configured tiller MCP server cannot override the node-scoped authenticated registration", async () => {
    setBaseEnv();
    stubFetch();
    const pi = fakePi();
    const configured = { tiller: { url: "http://wrong.invalid/mcp" } };
    const effective: Record<string, unknown> = { ...configured };
    const register = pi.api.registerMcpServer!;
    pi.api.registerMcpServer = (name, config) => {
      register(name, config);
      effective[name] = configured[name as keyof typeof configured] ?? config;
    };
    tillerPiExtension(pi.api);
    await pi.emit("session_start", { reason: "startup" });
    expect(effective[pi.mcp[0].name]).toMatchObject({
      url: "http://127.0.0.1:7777/mcp",
      headers: { Authorization: "Bearer test-token", "X-TL-Node": "n-1" },
    });
    expect(effective.tiller).toEqual(configured.tiller);
    await pi.emit("session_shutdown", { reason: "quit" });
  });

  it("bounds MCP server/tool names with at least 16 chars of future provider-name headroom", async () => {
    setBaseEnv();
    process.env.TL_NODE_ID = "n-abcdefgh-extra-long-future-node-id";
    stubFetch();
    const pi = fakePi();
    tillerPiExtension(pi.api);
    await pi.emit("session_start", { reason: "startup" });
    const name = pi.mcp[0].name;
    expect(name).toMatch(/^tl_abcdefgh_[a-f0-9]{12}$/);
    expect(name.length).toBeLessThanOrEqual(24);
    const source = readFileSync(new URL("../../src/daemon/mcp.ts", import.meta.url), "utf8");
    const toolNames = [...source.matchAll(/^  ([a-z_]+): tool\(/gm)].map((match) => match[1]);
    expect(toolNames.length).toBeGreaterThan(20);
    const longest = toolNames.reduce((a, b) => a.length >= b.length ? a : b);
    expect(`mcp__${name}__${longest}`.length).toBeLessThanOrEqual(64 - 16);
    await pi.emit("session_shutdown", { reason: "quit" });
  });

  it("reports provider-qualified runtime model switches including idle selections", async () => {
    setBaseEnv();
    const calls = stubFetch();
    const pi = fakePi();
    tillerPiExtension(pi.api);
    await pi.emit("session_start", { reason: "startup" });
    await pi.emit("model_select", { model: { id: "next", provider: "other" } });
    expect(calls.filter((c) => c.body?.event === "session.measure").at(-1)?.body.payload.model).toBe("other/next");
    await pi.emit("session_shutdown", { reason: "quit" });
  });

  it("is inert without TL_NODE_ID", async () => {
    const calls = stubFetch();
    const pi = fakePi();
    tillerPiExtension(pi.api);
    await pi.emit("session_start", { type: "session_start", reason: "startup" });
    await tick();
    expect(pi.mcp).toEqual([]);
    expect(calls).toEqual([]);
  });

  it("registers the MCP server and reports SessionStart with the transcript path", async () => {
    setBaseEnv();
    const calls = stubFetch();
    const pi = fakePi();
    tillerPiExtension(pi.api);
    await pi.emit("session_start", { type: "session_start", reason: "startup" });
    await tick();

    expect(pi.mcp[0]).toMatchObject({
      name: expect.stringMatching(/^tl_1_[a-f0-9]{12}$/),
      config: {
        type: "http",
        url: "http://127.0.0.1:7777/mcp",
        exposure: "direct",
        headers: { "X-TL-Node": "n-1", Authorization: "Bearer test-token" },
      },
    });
    // The daemon's TL_SESSION_ID wins over Pi's own header UUID (and the context reports
    // "sess-1"), or a resume would look up the wrong session path.
    const sessionStart = calls.find((call) => call.body?.hook_event_name === "SessionStart");
    expect(sessionStart?.body).toMatchObject({
      session_id: "tiller-sess-1",
      transcript_path: "/home/.tiller/nodes/n-1/sessions/sess-1.jsonl",
      model: "provider-1/model-1",
    });

    // The bridge polls the inbox and reports a first session.measure baseline.
    expect(calls.some((call) => call.url.endsWith("/inbox"))).toBe(true);
    const measure = calls.find((call) => call.body?.event === "session.measure");
    expect(measure?.body.payload).toMatchObject({
      context: { tokens: 100, window: 1000, percent: 10 },
      cost: { usd: 0.5 },
    });

    await pi.emit("session_shutdown", { type: "session_shutdown", reason: "quit" });
    expect(calls.some((call) => call.body?.hook_event_name === "SessionEnd")).toBe(true);
  });

  it("reports the actual user prompt as UserPromptSubmit and the run on the agent_settled boundary", async () => {
    setBaseEnv();
    const calls = stubFetch();
    const pi = fakePi();
    tillerPiExtension(pi.api);
    await pi.emit("session_start", { type: "session_start", reason: "startup" });
    await tick();

    await pi.emit("before_agent_start", { type: "before_agent_start", messageType: "user", prompt: "do the thing" });
    await pi.emit("agent_start", { type: "agent_start" });
    await pi.emit("turn_start", { type: "turn_start", turnIndex: 0, timestamp: Date.now() - 50 });
    await pi.emit(
      "turn_end",
      { type: "turn_end", turnIndex: 0, message: { role: "assistant", content: "all done" } },
    );
    await pi.emit("agent_settled", { type: "agent_settled", aborted: false });

    const submitted = calls.find((call) => call.body?.hook_event_name === "UserPromptSubmit");
    expect(submitted?.body).toMatchObject({ session_id: "tiller-sess-1", prompt: "do the thing" });

    const start = calls.find((call) => call.body?.event === "turn.start");
    expect(start?.body.payload).toMatchObject({ turnId: "0", text: "do the thing" });
    const complete = calls.find((call) => call.body?.event === "turn.complete");
    expect(complete?.body.payload).toMatchObject({
      turnId: "0",
      isAborted: false,
      reason: "answer",
      answer: "all done",
      usage: { model: "provider-1/model-1", provider: "provider-1" },
    });

    await pi.emit("session_shutdown", { type: "session_shutdown", reason: "quit" });
  });

  it("writes the provider-reported cost into the assistant message and reports unpriced usage as incomplete", async () => {
    setBaseEnv();
    const calls = stubFetch();
    const pi = fakePi();
    tillerPiExtension(pi.api);
    const entries: unknown[] = [];
    const ctx = fakeContext({ sessionManager: { getSessionId: () => "sess-1", getEntries: () => entries } });
    await pi.emit("session_start", { type: "session_start", reason: "startup" }, ctx);
    await tick();

    // An OpenRouter stream: content chunks, then the final chunk with usage.cost.
    const stream = { type: "provider_stream_event", provider: "openrouter", api: "openai-completions", model: "openrouter/auto" };
    await pi.emit("provider_stream_event", { ...stream, data: { id: "gen-1", choices: [{ delta: { content: "hi" } }] } }, ctx);
    await pi.emit("provider_stream_event", { ...stream, data: { id: "gen-1", choices: [], usage: { prompt_tokens: 140, completion_tokens: 24, cost: 0.0004 } } }, ctx);
    const assistant = { role: "assistant", responseId: "gen-1", usage: { input: 116, output: 24, cost: { total: 0 } } };
    const [result] = (await pi.emit("message_end", { type: "message_end", message: assistant }, ctx)) as Array<{ message?: any }>;
    expect(result?.message?.usage.cost).toEqual({ total: 0.0004, source: "provider" });
    // A second message without a reported cost is left alone.
    expect(await pi.emit("message_end", { type: "message_end", message: { ...assistant, responseId: "gen-2" } }, ctx)).toEqual([undefined]);

    entries.push({ type: "message", message: result!.message });
    await pi.emit("turn_end", { type: "turn_end", turnIndex: 0, message: result!.message }, ctx);
    let measure = calls.filter((c) => c.body?.event === "session.measure").at(-1);
    expect(measure?.body.payload.cost).toEqual({ usd: 0.0004 });

    // An unpriced model with no provider cost: tokens but $0. Reported as a lower bound, not a known $0.
    entries.push({ type: "message", message: { role: "assistant", usage: { input: 50, output: 5, cost: { total: 0 } } } });
    await pi.emit("turn_end", { type: "turn_end", turnIndex: 1, message: {} }, ctx);
    measure = calls.filter((c) => c.body?.event === "session.measure").at(-1);
    expect(measure?.body.payload.cost).toEqual({ usd: 0.0004, incomplete: true });

    await pi.emit("session_shutdown", { type: "session_shutdown", reason: "quit" }, ctx);
  });

  it("leaves messages unchanged when Tiller did not launch Pi", async () => {
    const pi = fakePi();
    tillerPiExtension(pi.api);
    await pi.emit("session_start", { type: "session_start", reason: "startup" });
    await pi.emit("provider_stream_event", { data: { id: "gen-1", usage: { cost: 0.1 } } });
    const message = { role: "assistant", responseId: "gen-1", usage: { cost: { total: 0 } } };
    expect(await pi.emit("message_end", { type: "message_end", message })).toEqual([undefined]);
  });

  it("maps a final assistant stopReason of error to turn.complete reason error", async () => {
    setBaseEnv();
    const calls = stubFetch();
    const pi = fakePi();
    tillerPiExtension(pi.api);
    await pi.emit("session_start", { type: "session_start", reason: "startup" });
    await tick();

    await pi.emit("before_agent_start", { type: "before_agent_start", messageType: "user", prompt: "go" });
    await pi.emit("agent_start", { type: "agent_start" });
    await pi.emit("agent_end", {
      type: "agent_end",
      messages: [{ role: "assistant", content: "boom", stopReason: "error" }],
    });
    await pi.emit("agent_settled", { type: "agent_settled", aborted: false });

    const complete = calls.find((call) => call.body?.event === "turn.complete");
    expect(complete?.body.payload).toMatchObject({ isAborted: false, reason: "error" });

    await pi.emit("session_shutdown", { type: "session_shutdown", reason: "quit" });
  });

  it("never emits UserPromptSubmit for a message Pi rejected", async () => {
    setBaseEnv();
    const calls = stubFetch([{ id: "m1", text: "do it", enqueuedAt: Date.now() }]);
    const pi = fakePi();
    pi.sendUserMessage = () => {
      throw new Error("pi refused the prompt");
    };
    tillerPiExtension(pi.api);
    await pi.emit("session_start", { type: "session_start", reason: "startup" });
    await tick();

    // The injected inbox message fails to submit; before_agent_start never runs, so no receipt
    // and no ack.
    expect(calls.some((call) => call.body?.hook_event_name === "UserPromptSubmit")).toBe(false);
    expect(calls.some((call) => call.url.endsWith("/ack"))).toBe(false);

    await pi.emit("session_shutdown", { type: "session_shutdown", reason: "quit" });
  });

  it("acks an injected message only when Pi actually starts a run with it", async () => {
    setBaseEnv();
    const calls = stubFetch([{ id: "m1", text: "do it", enqueuedAt: Date.now() }]);
    const pi = fakePi();
    tillerPiExtension(pi.api);
    await pi.emit("session_start", { type: "session_start", reason: "startup" });
    await tick();

    // Pi took the send but has not started a run: a void return is not acceptance, so no ack yet.
    expect(pi.sent).toEqual(["do it"]);
    expect(calls.some((call) => call.url.endsWith("/ack"))).toBe(false);

    await pi.emit(
      "before_agent_start",
      { type: "before_agent_start", messageType: "user", prompt: "do it" },
    );
    expect(calls.some((call) => call.body?.hook_event_name === "UserPromptSubmit")).toBe(true);
    expect(calls.some((call) => call.url.endsWith("/ack"))).toBe(true);

    // Acceptance does not cause a duplicate resubmission.
    expect(pi.sent).toEqual(["do it"]);

    await pi.emit("session_shutdown", { type: "session_shutdown", reason: "quit" });
  });

  it("maps only in-run UI prompts, pairing the outermost start with one end", async () => {
    setBaseEnv();
    const calls = stubFetch();
    const pi = fakePi();
    tillerPiExtension(pi.api);
    await pi.emit("session_start", { type: "session_start", reason: "startup" });
    await tick();

    // An idle extension-command dialog is not the node waiting on the model.
    await pi.emit("ui_prompt_start", { type: "ui_prompt_start", kind: "select", title: "Command" });
    expect(calls.some((call) => call.body?.hook_event_name === "Notification")).toBe(false);

    await pi.emit("before_agent_start", { type: "before_agent_start", messageType: "user", prompt: "run" });
    await pi.emit("agent_start", { type: "agent_start" });

    // Outer followed by a nested dialog: only the outer start maps, and only when both close.
    await pi.emit("ui_prompt_start", { type: "ui_prompt_start", kind: "select", title: "Pick one" });
    await pi.emit("ui_prompt_start", { type: "ui_prompt_start", kind: "confirm", title: "Allow?" });
    await pi.emit("ui_prompt_end", { type: "ui_prompt_end", kind: "confirm" });

    const notifications = calls.filter((call) => call.body?.hook_event_name === "Notification");
    expect(notifications.map((call) => call.body.notification_type)).toEqual([
      "elicitation_dialog",
    ]);
    expect(calls.filter((call) => call.body?.hook_event_name === "PostToolUse")).toHaveLength(0);

    await pi.emit("ui_prompt_end", { type: "ui_prompt_end", kind: "select" });
    expect(calls.filter((call) => call.body?.hook_event_name === "PostToolUse")).toHaveLength(1);

    // After the run settles, a dialog belongs to idle Pi again.
    await pi.emit("agent_settled", { type: "agent_settled", aborted: false });
    await pi.emit("ui_prompt_start", { type: "ui_prompt_start", kind: "select", title: "Later" });
    expect(calls.filter((call) => call.body?.hook_event_name === "PostToolUse")).toHaveLength(1);
    expect(
      calls.filter((call) => call.body?.hook_event_name === "Notification").length,
    ).toBe(1);

    await pi.emit("session_shutdown", { type: "session_shutdown", reason: "quit" });
  });

  it("fails closed before registering anything when the Pi build lacks MCP support", async () => {
    setBaseEnv();
    const calls = stubFetch();
    const pi = fakePi();
    delete (pi.api as { registerMcpServer?: unknown }).registerMcpServer;
    const notify = vi.fn();
    const shutdown = vi.fn();
    tillerPiExtension(pi.api);
    await pi.emit(
      "session_start",
      { type: "session_start", reason: "startup" },
      fakeContext({ ui: { notify }, shutdown }),
    );
    await tick();

    expect(pi.mcp).toEqual([]);
    expect(calls).toEqual([]);
    expect(shutdown).toHaveBeenCalled();
    expect(notify).toHaveBeenCalledWith(expect.stringContaining("incompatible Pi build"), "error");
  });

  it("fails closed when the MCP server cannot be registered", async () => {
    setBaseEnv();
    const calls = stubFetch();
    const pi = fakePi();
    pi.api.registerMcpServer = () => {
      throw new Error("name taken");
    };
    const notify = vi.fn();
    const shutdown = vi.fn();
    tillerPiExtension(pi.api);
    await pi.emit(
      "session_start",
      { type: "session_start", reason: "startup" },
      fakeContext({ ui: { notify }, shutdown }),
    );
    await tick();

    expect(calls).toEqual([]);
    expect(shutdown).toHaveBeenCalled();
    expect(notify).toHaveBeenCalledWith(expect.stringContaining("could not register MCP server"), "error");
  });

  it("cancels Pi session replacement for a managed node and shuts down if it still happens", async () => {
    setBaseEnv();
    const notify = vi.fn();
    const shutdown = vi.fn();
    const pi = fakePi();
    tillerPiExtension(pi.api);

    const [guard] = await pi.emit(
      "session_before_switch",
      { type: "session_before_switch", reason: "new" },
      fakeContext({ ui: { notify } }),
    );
    expect(guard).toEqual({ cancel: true });
    expect(notify).toHaveBeenCalledWith(expect.stringContaining("managed by Tiller"), "warning");

    // A build that ignores the cancel: refuse to run on the replacement and shut down.
    const calls = stubFetch();
    await pi.emit(
      "session_start",
      { type: "session_start", reason: "resume" },
      fakeContext({ ui: { notify }, shutdown }),
    );
    expect(shutdown).toHaveBeenCalled();
    expect(calls).toEqual([]);
  });

  it("shuts down instead of running half-activate when the bridge environment is invalid", async () => {
    setBaseEnv();
    process.env.TL_ENDPOINT = "file:///tmp/sock";
    const calls = stubFetch();
    const pi = fakePi();
    const notify = vi.fn();
    const shutdown = vi.fn();
    tillerPiExtension(pi.api);
    await pi.emit(
      "session_start",
      { type: "session_start", reason: "startup" },
      fakeContext({ ui: { notify }, shutdown }),
    );
    await tick();

    expect(pi.mcp).toEqual([]);
    expect(calls).toEqual([]);
    expect(shutdown).toHaveBeenCalled();
    expect(notify).toHaveBeenCalledWith(expect.stringContaining("not activating"), "error");
  });

  it("shuts down instead of running half-activate when the token file cannot be read", async () => {
    setBaseEnv();
    process.env.TL_TOKEN_FILE = join(tokenDir, "missing-token");
    const calls = stubFetch();
    const pi = fakePi();
    const notify = vi.fn();
    const shutdown = vi.fn();
    tillerPiExtension(pi.api);
    await pi.emit(
      "session_start",
      { type: "session_start", reason: "startup" },
      fakeContext({ ui: { notify }, shutdown }),
    );
    await tick();

    // The MCP server must not be registered with no token to authenticate it.
    expect(pi.mcp).toEqual([]);
    expect(calls).toEqual([]);
    expect(shutdown).toHaveBeenCalled();
    expect(notify).toHaveBeenCalledWith(expect.stringContaining("cannot read token file"), "error");
  });
});
