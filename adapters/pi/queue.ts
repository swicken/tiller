/**
 * A tiny serial task queue for lifecycle HTTP.
 *
 * Pi dispatches extension events as they happen, and several can overlap (for example a
 * `session_start` hook still in flight while the first `turn_start` fires). Posting those to the
 * daemon concurrently lets a later event win the race and leaves the node in the wrong state, so
 * every hook / mod-event goes through one queue and is awaited in order. A rejected task is
 * reported to the caller but never breaks the chain.
 */
export class SerialQueue {
  private tail: Promise<void> = Promise.resolve();

  /** Run `task` after every previously enqueued task, preserving enqueue order. */
  enqueue<T>(task: () => Promise<T> | T): Promise<T> {
    const run = this.tail.then(task, task);
    this.tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  /** Resolve once every task enqueued so far has settled. */
  async drain(): Promise<void> {
    await this.tail;
  }
}
