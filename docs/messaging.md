# Messaging between nodes

Nodes talk through the daemon. An agent calls the MCP tool `send` (the human uses `tl send <id> "text"`), and the daemon delivers the text to the target as a prompt. Scope is the sender's lineage: its parent and other ancestors, its siblings and its descendants. Agent nodes (Claude, Pi and Codex) receive messages; a terminal node takes raw keystrokes through `write`, which the human approves each time.

## The envelope

The target sees the message inside a frame that says who sent it and where to answer:

```
--- TL MESSAGE <nonce> ---
from: Builder (n-3f2a)
reply-to: n-3f2a
<body>
--- END TL MESSAGE <nonce> ---
```

The nonce is new for each delivery. Every node's system prompt says that framed messages are legitimate instructions and that only the outermost frame is authentic, so a body that contains something frame-shaped is plain data. Messages from the daemon itself have `reply-to: none`.

In a Claude node's chat the mod draws a delivered envelope as one line, `↘ message from Builder (n-3f2a) · reply-to n-3f2a` (with `· steer` for a steer, and no reply-to part for a daemon notice, whose `reply-to` is `none`), and the node's own `send` calls as `↗ message to <title> (<id>) · queued`. The sent line's outcome is what the call returned (usually `queued`) and is not updated when the message is delivered; a send that failed or was refused also shows its result. ctrl+o shows the full text. This changes the drawing only; Claude reads the whole envelope.

## The queue and delivery

A send is queued in the daemon's inbox for the target (kept in `inbox.json`, so it survives a daemon restart) and the reply has outcome `queued` and a `messageId`. The target's mod polls the inbox every second. While the target is running a turn, the mod leaves the message in the daemon, which keeps it withdrawable. When the turn ends, the mod claims the message (`POST /claim`); from that point it can no longer be withdrawn, and a message that was withdrawn or has expired fails the claim and is skipped. The mod then submits it as a prompt and acknowledges it once Claude accepts the prompt, which makes the outcome `delivered`. The daemon also counts a UserPromptSubmit hook that carries the message's frame as delivery, so an acknowledgement lost to a mod reload does not cause a second submit.

When the target's mod is not running (its last poll is more than 5 seconds old), the daemon pastes the message into the target's terminal instead. It waits until the target is verifiably idle and its screen shows an empty prompt rather than a dialog, writes one bracketed paste and then Enter, and waits up to 8 seconds for the prompt to be submitted: `delivered` if it was, `stalled` if not. A stalled message may or may not have arrived, so the sender should check before sending it again.

Each target holds at most 16 queued messages, and a message expires after 5 minutes in the queue. That clock starts over while the target is working and while its mod is submitting a claimed message, so a message for a long-running worker does not expire just because the worker is busy.

`message_status` with the messageId returns the current outcome. The outcomes are `queued`, `delivered`, `stalled`, `expired`, `queueFull`, `withdrawn`, `gone` (the target no longer exists or has exited) and `refused`, each with a detail and whether a retry can help.

The tree's event log (`events.jsonl`, see [sessions](sessions.md#the-event-log)) records every message, including the daemon's notices: a `send` event with the sender, the first outcome, the text (cut to 32,000 characters, marked `textCut`), the notice's `from:` label and the nodes it concerns (`about`), and a `settle` event when a queued message reaches its final outcome. The text stays on this machine in the tree's session directory until the sessions sweep removes it; the Transcript tab's conversations are built from these records.

## Held for a restart

While `tl reload`, `tl update` or the app's update waits for agents to finish their turns before restarting the daemon (see [sessions](sessions.md#waiting-for-turns-to-end)), the daemon holds every delivery, its own notices included. Sends are still accepted and answered `queued`; the inbox shows a node's mod only the messages it has already claimed, claims are refused, nothing is pasted, and a steer queues without interrupting the target. A held message does not expire: its 5-minute clock starts over while the hold lasts. At the restart, messages waiting to be pasted move into their targets' inboxes, in the order they were sent among the messages already there (together they can exceed the 16-message cap, which then only refuses new sends until the inbox drains), and `inbox.json` records that deliveries were held, so the new daemon gives each held message a fresh 5 minutes from when it loads, rather than dropping messages whose clock ran during the wait. If the wait is cancelled instead, the held messages are delivered as their targets allow.

After a restart, a resumed node whose turn was cut off gets one message from the daemon, from `tiller (daemon restarted)`, asking it to check where it was and continue.

## During a harness change

During a human-requested harness change, inbox intake and claims pause. A paste already in flight
settles its receipt before the process is stopped. Shutdown acknowledgments may still confirm
accepted prompts. After exit, unclaimed prompts stay queued for the replacement; any remaining
claimed prompt retires as `stalled`, not retryable, because acceptance is ambiguous. It is never
replayed automatically. Old launch credentials expire before the new process starts, and a late
old hook, measure or acknowledgment cannot affect the replacement. New sends during the switch
are refused with a retry hint.

## Steering

A send with mode `now` (`tl send --now`) is a steer. If the target is working, its turn is interrupted and the message is delivered at once, ahead of the other queued messages, with an extra envelope line telling the target it was interrupted on purpose. With the mod running, the mod claims the steer, aborts the turn and submits it; without the mod, the daemon presses Esc in the terminal and pastes the message once the turn has stopped. To a target that is not working, mode `now` is the same as the default `queue`. The orchestrator prompt reserves steering for a worker heading the wrong way.

## Withdrawing

`withdraw` (or `tl withdraw <messageId>`) takes back a message that is still queued: not yet claimed by the target's mod and not yet pasted. Its outcome becomes `withdrawn`. Only the sender, or the human, may withdraw a message, and the error says why when it cannot.

## Rate limit and loop guard

The daemon accepts one send per sender and target every 10 seconds; a faster one is refused with the time to wait. Separately, a send between two agents is refused as a likely loop when the sender has already sent that target `limits.maxMessagesPer10Min` messages (default 20) in the last 10 minutes, or the same text in the last 10 minutes. The refusal tells the sender to escalate to the human or change approach, and the sender's parent gets one message about it per pair every 10 minutes. The human and the daemon are exempt from the loop guard.

## Notices from the daemon

The daemon messages a parent, once per episode, when a child stops in a way that needs a decision: it exited, its turn ended in an error, or it has waited on a question for 15 minutes. An episode ends with the next cleanly finished turn. When a child's turn errors, the daemon first sends the child one message asking it to continue where it left off, and tells the parent only if that message is not delivered or the next turn errors too. A child working with no hook event for `limits.stallMinutes` gets one "no activity" notice to its parent.

When a child's outcome is recorded through `report_outcome`, its parent gets a message with the outcome line, unless a pending `notify_when` of the parent covers that child, in which case the `notify_when` message carries it. Both carry the verdict and the whole `summary` (else the note), so the parent rarely needs `read outcome`; `changedFiles`, `verified` and `openQuestions` stay in `read outcome`. A summary, or a stopped child's last message, longer than 1,500 characters is cut there and ends with "… (read outcome for the rest)" ("read summary" for a last message). The received-message row in Claude Code may shorten what it draws; the agent gets the full text.

An agent's `close` that needs the human's approval does not hold the agent's turn: it replies at once with `{ ok: false, pending: true, requestId }`, and the decision arrives later as a notice from `tiller (close request <requestId> approved|denied|expired)`. An approved notice lists the nodes closed, those someone else closed meanwhile, and each node that failed to close, with its error. Each node is checked again at approval: a `worktree: "discard"` whose worktree now holds more commits or changed files than the human was shown is refused for that node. If the calling agent is closed while its request waits, the human's dialog is dismissed and nothing closes. An `expired` notice means nobody answered within the approval timeout (5 minutes), and nothing was closed. With no UI connected the close is denied at once, as before, and a close that `approvals.close` lets skip the approval, or one by the human, closes and replies with the result.

## notify_when

`notify_when(ids, when, of)` lets an agent wait for several nodes with one message instead of polling. It returns at once; later the caller receives a single message, "N of M finished:", with one line per node giving its outcome or its state. `when: "all"` (the default) waits for every node and `"any"` for the first. `of: "turn"` counts a node once it finishes the turn now in progress (or, for an idle node, its next turn), or exits or is closed; `of: "success"` counts a node once it calls `report_outcome` with either verdict. Calling it again with the same ids replaces the pending one, and it expires after 12 hours. The human has no inbox, so it is for agents only.

An agent hears nothing more of nodes it closes itself with `close`: once each close succeeds, its pending `notify_when` watches drop the node (one left with no nodes is dropped, and the rest still report; a close that fails leaves the watch as it was, and the close itself never counts as the node finishing), and child and `notify_when` notices to it, still queued, that concern only those nodes are withdrawn. A queued merge result is never withdrawn. Notices about a node the human closed, or one closed by another agent, still arrive.

Each caller's runtime owns its registrations through `completion-watches.ts`, so closing the caller drops them. `messaging.ts` wires event checks and delivery, including suppression of individual outcome notices while a watch covers the child. Outcome events precede node events: suppression sees the pending watch before the node event completes it.

## Parameter aliases and defaults

The agent tools accept a few aliases, so a guessed name is not a validation error: `nodeIds` and `ids` on `close` and `notify_when`, `nodeId` and `id` on the tools that take one node (`send`, `read`, `write`, `rename`, `diff`, `merge`, and the human's `resume`, `restart`, `change_harness`, `transcript`, `followup` and `mute`), and `text` and `message` on `send`. Giving both names of a pair with different values is an error. `spawn` defaults `kind` to the caller's own (`claude`, or `agent` with the caller's harness when that is Pi or Codex; a given non-Claude `harness` means `agent`) and `cwd` to the caller's own directory; the human must still give `cwd`.

## Dependency launches and the spawn queue

A spawn can wait for other nodes: `tl spawn --after n-a,n-b --after-success n-c`, or `after` and `afterSuccess` on the MCP `spawn` tool. The node is created armed, with no process yet, and its row says what it waits on. It launches exactly as the spawn would have (worktree included) once each `after` node has finished a turn that began after the spawn, or has exited, and each `afterSuccess` node has reported succeeded, after its completion gate when one is configured. A failed report blocks it: the row says "blocked by n-c: <note>" and its parent gets a message. Dependencies must exist and be in the caller's scope. Closing an armed node discards it, and a restarted daemon re-arms armed nodes from `state.json`.

When `daemon.maxWorking` is set and that many Claude nodes are working, a new spawn is queued instead, shown as "queued" with the reason, and launched in creation order as nodes stop working; the status bar shows how many are queued. Only the human can skip the queue, with `tl spawn --now`. Arming, release, queueing and launch are written to the tree's event log.

`scheduling.ts` owns dependency evaluation, arming and queue release. It uses the same turn-completion predicate as completion watches; messaging does not import scheduling.
