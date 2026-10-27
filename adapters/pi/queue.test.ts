import { describe, expect, it } from "vitest";
import { SerialQueue } from "./queue.ts";

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("SerialQueue", () => {
  it("runs tasks strictly in enqueue order even when they resolve later", async () => {
    const queue = new SerialQueue();
    const events: string[] = [];

    const first = queue.enqueue(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      events.push("first");
    });
    const second = queue.enqueue(() => {
      events.push("second");
    });

    await Promise.all([first, second]);
    expect(events).toEqual(["first", "second"]);
  });

  it("keeps the chain alive after a rejected task and still reports it", async () => {
    const queue = new SerialQueue();
    const events: string[] = [];

    const failing = queue.enqueue(() => {
      events.push("fail");
      throw new Error("boom");
    });
    const after = queue.enqueue(() => {
      events.push("after");
    });

    await expect(failing).rejects.toThrow("boom");
    await after;
    expect(events).toEqual(["fail", "after"]);
  });

  it("drain resolves once every enqueued task has settled", async () => {
    const queue = new SerialQueue();
    const events: string[] = [];
    void queue.enqueue(async () => {
      await tick();
      events.push("done");
    });

    await queue.drain();
    expect(events).toEqual(["done"]);
  });
});
