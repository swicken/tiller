import { describe, expect, it, vi } from "vitest";
import { authHeaders, readToken, TillerClient, TillerHttpError } from "./client.js";
import type { TillerFetchLike, TillerResponseLike } from "./client.js";

function response(status: number, body = ""): TillerResponseLike {
  return { status, text: async () => body };
}

function recorder(handler?: (url: string, init: any) => TillerResponseLike) {
  const calls: Array<{ url: string; init: any }> = [];
  const fetchFn: TillerFetchLike = async (url, init) => {
    calls.push({ url, init });
    return handler?.(url, init) ?? response(204);
  };
  return { calls, fetchFn };
}

const client = (fetchFn: TillerFetchLike) =>
  new TillerClient({
    endpoint: "http://127.0.0.1:7000/",
    nodeId: "n-1",
    token: "secret",
    fetch: fetchFn,
  });

describe("authHeaders", () => {
  it("carries the node-scoped bearer auth", () => {
    expect(authHeaders("n-1", "secret")).toMatchObject({
      Authorization: "Bearer secret",
      "X-TL-Node": "n-1",
      "Content-Type": "application/json",
    });
  });
});

describe("TillerClient", () => {
  it("builds the URL without a duplicate slash and serializes the body", () => {
    const c = client(async () => response(204));
    const [url, init] = c.request("POST", "/claim", { id: "m1" });
    expect(url).toBe("http://127.0.0.1:7000/claim");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body!)).toEqual({ id: "m1" });
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it("parses the inbox", async () => {
    const { fetchFn } = recorder(() =>
      response(200, JSON.stringify([{ id: "m1", text: "hi" }])),
    );
    await expect(client(fetchFn).inbox()).resolves.toEqual([{ id: "m1", text: "hi" }]);
  });

  it("returns false on 404 claim and true on 204", async () => {
    expect(await client(async () => response(404)).claim("gone")).toBe(false);
    expect(await client(async () => response(204)).claim("here")).toBe(true);
  });

  it("maps a release 404 to false and 2xx to true", async () => {
    expect(await client(async () => response(404)).release("gone")).toBe(false);
    expect(await client(async () => response(204)).release("here")).toBe(true);
    await expect(client(async () => response(500, "boom")).release("x")).rejects.toBeInstanceOf(TillerHttpError);
  });

  it("throws a TillerHttpError on other claim failures", async () => {
    await expect(client(async () => response(500, "boom")).claim("x")).rejects.toBeInstanceOf(
      TillerHttpError,
    );
  });

  it("posts ack, mod-event, hook and honest retirement with node auth", async () => {
    const { calls, fetchFn } = recorder();
    const c = client(fetchFn);
    await c.ack("m1");
    await c.modEvent("turn.complete", { turnId: "1" });
    await c.hook({ hook_event_name: "SessionStart" });
    await c.unconfirmed("m1");
    expect(calls.map((call) => call.url)).toEqual([
      "http://127.0.0.1:7000/ack",
      "http://127.0.0.1:7000/mod-event",
      "http://127.0.0.1:7000/hook",
      "http://127.0.0.1:7000/unconfirmed",
    ]);
    expect(JSON.parse(calls[3].init.body)).toEqual({ id: "m1" });
    expect(calls[3].init.headers).toMatchObject({ Authorization: "Bearer secret", "X-TL-Node": "n-1" });
    expect(calls[1].init.headers["X-TL-Node"]).toBe("n-1");
  });

  it("surfaces a non-2xx body", async () => {
    await expect(client(async () => response(400, "bad")).inbox()).rejects.toThrow("400 bad");
  });
});

describe("readToken", () => {
  it("trims the file contents", async () => {
    const read = vi.fn(async () => "  abc\n");
    await expect(readToken("/tmp/token", read)).resolves.toBe("abc");
    expect(read).toHaveBeenCalledWith("/tmp/token");
  });

  it("rejects an empty token file", async () => {
    await expect(readToken("/tmp/token", async () => "\n")).rejects.toThrow(/empty/);
  });
});
