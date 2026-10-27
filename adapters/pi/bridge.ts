/**
 * The Tiller inbox bridge: poll `/inbox`, claim, submit, confirm acceptance, ack, and steer.
 *
 * Design notes:
 * - Never overlaps polls: `pollOnce()` returns immediately while another run is in flight.
 * - Only the *immediate next* message is ever claimed, and only while Pi is idle. Everything else
 *   stays in the daemon (unclaimed), so its sender can still withdraw it.
 * - A steer message aborts Pi's running turn once while it stays unclaimed; once Pi reports idle
 *   it is claimed ahead of the queue and delivered.
 * - A claim that could not be submitted because Pi became busy is released back to the daemon,
 *   which keeps it queued and retryable: it never reached Pi, so it is not ambiguous.
 * - `sendUserMessage` is fire-and-forget in Pi: a void return is not evidence that Pi accepted
 *   the prompt. It can still reject the input asynchronously, or consume it without ever starting
 *   a run. The bridge therefore tracks two distinct states:
 *     * `submitted` — `sendUserMessage` was called (the message is ambiguous; it must never be
 *       submitted again), and
 *     * `accepted`  — Pi actually started a run with this exact prompt, reported through
 *       `before_agent_start`. Only acceptance can ack the message.
 *   After a bounded confirmation window, an ambiguous claim is retired as stalled/nonretryable,
 *   never resent. Native Pi catches/logs send errors and returns void; even a thrown wrapper
 *   error is not proof that submission had no effect.
 * - The state is marked `submitted` *before* `sendUserMessage` is invoked, because Pi can
 *   dispatch `before_agent_start` synchronously from inside that call. Acceptance is an explicit
 *   flag, so the reentrant `confirmAccepted` cannot be undone by the enclosing submit.
 * - `confirmAccepted(text)` is invoked from `before_agent_start` only after the matching
 *   `UserPromptSubmit` hook has been forwarded, so a receipt can never precede submission.
 * - A submitted-but-unaccepted message that the daemon no longer lists (TTL expiry, daemon
 *   restart, node close) is cleared and reported as expired so it cannot wedge the queue forever.
 *   Two consecutive misses are required so the daemon-side `UserPromptSubmit` ack of an
 *   in-flight acceptance is never mistaken for expiry.
 * - `sendUserMessage`/`isIdle`/`abort` are injected, so the bridge is tested with a fake Pi.
 */

import type { InboxMessage } from "../shared/client.ts";

/** The subset of `TillerClient` the bridge uses; tests inject a fake. */
export interface TillerClientLike {
  inbox(): Promise<InboxMessage[]>;
  claim(id: string): Promise<boolean>;
  ack(id: string): Promise<void>;
  /** Retire an ambiguous claim without acknowledging delivery. Idempotent. */
  unconfirmed(id: string): Promise<void>;
  /** Hand back a claim that was never submitted. False if the daemon no longer has it. */
  release(id: string): Promise<boolean>;
}

export interface TillerBridgeDeps {
  client: TillerClientLike;
  /** Live idle check, e.g. `() => ctx.isIdle()`. */
  isIdle: () => boolean;
  /** Abort the running turn, e.g. `() => ctx.abort()`. */
  abort: () => void;
  /** Native Pi submission returns void and logs asynchronous prompt errors internally. */
  sendUserMessage: (text: string) => void;
  /** Called just before submitting. Bookkeeping only: no receipt/ack may happen here. */
  onSubmit?: (message: InboxMessage) => unknown;
  /** Called after a message is accepted by Pi and acked. */
  onDelivered?: (message: InboxMessage) => void;
  /** Called when a submitted-but-unaccepted message disappears from the daemon inbox. */
  onExpired?: (message: InboxMessage) => void;
  /** Called for poll/claim/send/ack failures. */
  onError?: (error: unknown, phase: string) => void;
  /** Default 1000 ms. */
  pollIntervalMs?: number;
  /** Bound the acceptance wait independently of daemon inbox TTL renewal. Default 60 seconds. */
  confirmationTimeoutMs?: number;
  now?: () => number;
  onUnconfirmed?: (message: InboxMessage) => void;
  /** Timer injection for tests. */
  setIntervalFn?: (handler: () => void, ms: number) => unknown;
  clearIntervalFn?: (handle: unknown) => void;
}

interface HeldMessage extends InboxMessage {
  claimedAt: number;
  retiring: boolean;
  /** `sendUserMessage` was invoked; it must never be invoked again for this claim. */
  submitted: boolean;
  /** A matching `before_agent_start` confirmed Pi accepted this prompt. */
  accepted: boolean;
  acking: boolean;
  /** Consecutive inbox polls where a submitted-unaccepted message was absent. */
  inboxMisses: number;
}

const defaultSetInterval = (handler: () => void, ms: number): unknown =>
  setInterval(handler, ms);
const defaultClearInterval = (handle: unknown): void =>
  clearInterval(handle as ReturnType<typeof setInterval>);

/** Two consecutive inbox misses before a submitted-unaccepted message is treated as expired. */
const EXPIRY_MISSES = 2;

export class TillerBridge {
  private readonly deps: TillerBridgeDeps;
  private readonly setIntervalFn: (handler: () => void, ms: number) => unknown;
  private readonly clearIntervalFn: (handle: unknown) => void;
  private readonly confirmationTimeoutMs: number;
  private readonly now: () => number;
  /** Guard stale inbox snapshots/late acceptance after retirement. Framed prompts contain unique ids. */
  private readonly retired = new Set<string>();
  /** At most one claimed message is held at a time. */
  private held?: HeldMessage;
  /** Steers the running turn was aborted for once; never abort again on later polls. */
  private readonly steersAborted = new Set<string>();
  private timer: unknown;
  private polling = false;
  private delivering = false;
  private stopped = false;

  constructor(deps: TillerBridgeDeps) {
    this.deps = deps;
    this.setIntervalFn = deps.setIntervalFn ?? defaultSetInterval;
    this.clearIntervalFn = deps.clearIntervalFn ?? defaultClearInterval;
    this.confirmationTimeoutMs = deps.confirmationTimeoutMs ?? 60_000;
    this.now = deps.now ?? Date.now;
  }

  /** Messages claimed but not yet accepted and acked. */
  get pendingCount(): number {
    return this.held ? 1 : 0;
  }

  /** Start the poll loop. Idempotent; the first poll runs immediately. */
  startPolling(): void {
    if (this.stopped || this.timer !== undefined) return;
    const ms = this.deps.pollIntervalMs ?? 1000;
    this.timer = this.setIntervalFn(() => {
      void this.pollOnce();
    }, ms);
    void this.pollOnce();
  }

  /** Stop the poll loop and drop any pending timer. Safe to call more than once. */
  stopPolling(): void {
    this.stopped = true;
    if (this.timer !== undefined) {
      this.clearIntervalFn(this.timer);
      this.timer = undefined;
    }
  }

  /**
   * One poll cycle. Reentrant calls are ignored, so a slow HTTP round-trip cannot stack polls.
   */
  async pollOnce(): Promise<void> {
    if (this.polling || this.stopped) return;
    this.polling = true;
    try {
      // Finish anything already claimed (submit, or retry an outstanding ack) before looking
      // at the inbox, so a claimed message is never bypassed.
      await this.flush();
      if (this.stopped) return;
      await this.pollInbox();
      if (this.stopped) return;
      // A message claimed while idle is submitted in this same cycle; a steer claimed while busy
      // waits for the next cycle, when Pi reports idle.
      await this.flush();
    } catch (error) {
      this.deps.onError?.(error, "poll");
    } finally {
      this.polling = false;
    }
  }

  /**
   * Pi accepted a prompt. Called from `before_agent_start` with the exact prompt, after the
   * matching `UserPromptSubmit` hook has been forwarded. Marks the held message accepted and
   * acks it; a failed ack is retried on later polls and never re-submits.
   */
  async confirmAccepted(text: string): Promise<void> {
    if (this.stopped) return;
    const message = this.held;
    if (!message) return;
    if (!message.submitted || message.accepted || message.retiring) return;
    // Only the injected message that Pi actually ran is confirmed; an unrelated human prompt
    // (or a stale prompt from a prior run) must not clear the claim.
    if (message.text !== text) return;
    message.accepted = true;
    await this.retryAck(message);
  }

  private isKnown(id: string): boolean {
    return this.retired.has(id) || this.held?.id === id;
  }

  private async claim(message: InboxMessage): Promise<boolean> {
    try {
      return await this.deps.client.claim(message.id);
    } catch (error) {
      this.deps.onError?.(error, "claim");
      return false;
    }
  }

  /** Abort the running turn for a steer, but only once: later polls must not re-abort. */
  private abortForSteer(id: string): void {
    if (this.steersAborted.has(id)) return;
    this.steersAborted.add(id);
    try {
      this.deps.abort();
    } catch (error) {
      this.deps.onError?.(error, "abort");
    }
  }

  /**
   * Claim at most one message, and only while idle: steers first, then the immediate next one.
   * Messages left behind stay in the daemon and remain withdrawable.
   */
  private async pollInbox(): Promise<void> {
    const messages = await this.deps.client.inbox();
    if (this.stopped) return;

    // At most one claimed message is held at a time, so a submitted-but-unaccepted message is
    // never bypassed and the message behind it stays withdrawable in the daemon. Still check
    // whether the daemon dropped it (TTL/restart/close) so it cannot wedge the queue forever.
    const held = this.held;
    if (held) {
      if (held.submitted && !held.accepted) {
        if (messages.some((message) => message.id === held.id)) {
          held.inboxMisses = 0;
        } else {
          held.inboxMisses += 1;
          if (held.inboxMisses >= EXPIRY_MISSES) {
            this.held = undefined;
            this.retired.add(held.id);
            this.deps.onExpired?.(held);
          }
        }
      }
      return;
    }

    if (!this.deps.isIdle()) {
      // Busy: everything waits unclaimed in the daemon. A steer aborts the running turn once and
      // is claimed when Pi reports idle, so its sender can withdraw it until then.
      const steer = messages.find((message) => message.steer && !message.claimed && !this.isKnown(message.id));
      if (steer) this.abortForSteer(steer.id);
      return;
    }

    const steers = messages.filter((message) => message.steer);
    for (const message of [...steers, ...messages.filter((message) => !message.steer)]) {
      if (this.isKnown(message.id)) continue;
      // Reloaded native claims are ambiguous: never submit them again.
      if (message.claimed) {
        await this.retire(this.newHeld(message));
        continue;
      }
      if (!(await this.claim(message))) {
        if (this.stopped) return;
        continue; // withdrawn/expired: the next message is now the immediate one
      }
      if (this.stopped) return;
      // Submitted by the flush that follows, or released if Pi became busy during the claim.
      this.held = this.newHeld(message);
      return;
    }
  }

  private newHeld(message: InboxMessage): HeldMessage {
    return {
      ...message,
      claimedAt: this.now(),
      retiring: false,
      submitted: false,
      accepted: false,
      acking: false,
      inboxMisses: 0,
    };
  }

  /** Submit or ack the held message. Never runs two submissions at once. */
  private async flush(): Promise<void> {
    if (this.delivering || this.stopped) return;
    const message = this.held;
    if (!message) return;
    this.delivering = true;
    try {
      if (message.accepted) {
        // Pi accepted it: retry the ack only, never the submit.
        await this.retryAck(message);
        return;
      }
      if (message.retiring || (message.submitted && this.now() - message.claimedAt >= this.confirmationTimeoutMs)) {
        await this.retire(message);
        return;
      }
      if (message.submitted) return; // awaiting acceptance: ambiguous, so never resubmit
      if (this.deps.isIdle()) {
        await this.submit(message);
        return;
      }
      // Pi became busy before submission: hand the claim back, and abort once for a steer.
      if (message.steer) this.abortForSteer(message.id);
      await this.release(message);
    } finally {
      this.delivering = false;
    }
  }

  private async submit(message: HeldMessage): Promise<void> {
    try {
      if (this.deps.onSubmit) await this.deps.onSubmit(message);
      if (this.stopped) return;
      // Mark submitted before the call: Pi may dispatch `before_agent_start` synchronously from
      // inside `sendUserMessage`, and `confirmAccepted` must see a submitted message.
      message.submitted = true;
      // No followUp fallback: it may combine queued prompts without an exact acceptance event.
      // A busy race is ambiguous and will retire honestly rather than queue an invisible replay.
      this.deps.sendUserMessage(message.text);
    } catch (error) {
      // A confirmation set synchronously during the call wins: Pi already ran the prompt, so the
      // throw must not un-submit it or turn a confirmed delivery into an ambiguous failure.
      if (message.accepted) {
        this.deps.onError?.(error, "send-after-accept");
        return;
      }
      this.deps.onError?.(error, "send");
      // A wrapper can throw after dispatch. Do not retry or assume the native failure surfaced.
      message.submitted = true;
      return;
    }
    // A void return is not acceptance. The message stays submitted until a matching
    // `before_agent_start` (via `confirmAccepted`) or the daemon drops it.
  }

  /** Return a never-submitted claim to the daemon's queue. A failure keeps it for a later retry. */
  private async release(message: HeldMessage): Promise<void> {
    try {
      await this.deps.client.release(message.id); // false: the daemon already dropped it
    } catch (error) {
      this.deps.onError?.(error, "release");
      return;
    }
    this.drop(message);
  }

  /** Retirement is a distinct terminal state; a late acceptance cannot turn it into delivery. */
  private async retire(message: HeldMessage): Promise<void> {
    message.retiring = true; // before HTTP: an acceptance racing this request must not ack
    try {
      await this.deps.client.unconfirmed(message.id);
    } catch (error) {
      this.deps.onError?.(error, "unconfirmed");
      return; // retry retirement only, never submission
    }
    this.retired.add(message.id);
    this.drop(message);
    this.deps.onUnconfirmed?.(message);
  }

  /** Stop holding `message`. False if it was not the held one (already dropped, or never held). */
  private drop(message: HeldMessage): boolean {
    if (this.held !== message) return false;
    this.held = undefined;
    return true;
  }

  /** Ack a submitted, accepted message. A failure keeps it for a later retry; success releases it. */
  private async retryAck(message: HeldMessage): Promise<void> {
    if (!message.accepted || message.acking || this.stopped) return;
    message.acking = true;
    try {
      await this.deps.client.ack(message.id);
      if (this.drop(message)) this.deps.onDelivered?.(message);
    } catch (error) {
      this.deps.onError?.(error, "ack");
    } finally {
      message.acking = false;
    }
  }
}
