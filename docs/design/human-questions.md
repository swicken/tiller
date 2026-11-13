# Questions for the human: a list that outlives the chat

Status: design, 2026-11-13. Nothing is built. Written by node n-8b7d86f5 ("design: questions for the human").

Sources read: `src/shared/protocol.ts`, `src/daemon/mcp.ts`, `server.ts`, `messaging.ts`, `manager.ts`, `nodes.ts`, `notifier.ts`, `sessions.ts`, `modapi.ts`, `launch.ts`, `index.ts`, `cli.ts`, `conversation.ts`, the UI shell (`ui/App.tsx`, `TitleBar.tsx`, `SessionTabs.tsx`, `StatusBar.tsx`, `Toasts.tsx`, `ActivityDrawer.tsx`, `TerminalPane.tsx`, `store.ts`, `conn.ts`, `notify.ts`, `tray.ts`, `sidebar/`), `mod/`, the Pi and Codex adapter READMEs, and the behaviour docs. One behaviour the design depends on was checked with a throwaway test (section 19, item 1). No product code was changed.

## 1. Problem and goal

When many tasks run, the root orchestrator's chat is busy. The orchestrator asks the human something at the end of a turn, worker reports arrive as new prompts, and the question scrolls out of view. The human never answers because they never see it again.

The owner does not want questions to become blocking prompts. They want Tiller to capture what an agent has said needs the human, and keep it in front of them until it is dealt with.

The goal of this design is a **question**: a small record an agent creates with a tool call, which the daemon stores, every front end lists outside the chat, and the human answers or dismisses at any later time. The agent's turn is never held. The answer travels back to the agent as an ordinary Tiller message.

## 2. What exists today

Each point below was checked in the code.

- **"Needs you" covers blocked nodes only.** `NEEDS_YOU_STATES` in `src/shared/protocol.ts` is `blocked` and `waiting`. Both come from harness events that stop the node mid-turn: a permission prompt, or Claude's `AskUserQuestion` (`src/daemon/status.ts`). A question written in prose leaves the node `done`. The status bar count, the Dock badge, the menu bar item (`ui/tray.ts`), the session switcher counts and the away digest all derive from those two states, so none of them records a prose question.
- **Approvals are blocking and short-lived.** `confirm` in `src/daemon/server.ts` broadcasts a modal (`ConfirmModal` in `ui/Toasts.tsx`), replays it to clients that connect later, raises an `approval` notification and expires (5 minutes, or 30 for a close). With no client connected it resolves `false` at once. It is a yes/no about a daemon action, owned by the daemon.
- **`suggest_command` is the closest sibling.** It is a non-blocking tool from an agent to the human (`src/daemon/mcp.ts`). The suggestion lives on the node's runtime (`NodeRuntime.suggestion` in `manager.ts`), so it is lost on a daemon restart; there is one per node and a later call replaces it; it reaches clients as a field of `NodeView` through the ordinary `node` broadcast; the human acts on it with a `suggestion` client message that carries the suggestion's `at` so a stale click is refused. The UI shows a `cmd` badge on the row, a dot on the Terminal tab and a strip above the shell.
- **Messages between nodes** go through `deliver` in `src/daemon/messaging.ts`: queued per target, held while the target works, delivered as a framed prompt when it is idle, with a receipt. Queued messages survive a restart in `inbox.json`. The human can send (`tl send`, the Diff tab's comments) but cannot receive: `notify_when` refuses the human with "the human has no inbox".
- **Station notices** tell a parent when a child exits, errors or has sat in `waiting` for 15 minutes (`question-unanswered` in `startNotices`). They concern blocked children, not prose questions.
- **The away digest** (`buildDigest` in `src/daemon/sessions.ts`) is built from `state` and `outcome` events in each tree's `events.jsonl`. Agents can write that file, so the daemon treats its contents as untrusted text.
- **Native notifications** are sent only by the daemon (`src/daemon/notifier.ts`), after mute, do not disturb, watched-node suppression, the per-kind level, quiet hours and a 5-second throttle per node and kind.
- **The Claude mod's band and toasts** (`mod/hooks/band.tsx`, `notify.ts`) are drawn only while no app or browser client is connected.
- **`report_outcome.openQuestions`** is the only structured place an agent can leave questions today. It reaches the parent only through `read` with what `outcome`, is not in the parent's notice, and is not persisted across a daemon restart.

## 3. The design in brief

- An agent calls `ask_human`. The call returns at once with an id such as `q-1a2b3c4d`.
- The daemon stores the question in `questions.json` in its home directory, so it survives `tl reload`, a node restart, context compaction and a reboot.
- Every connected client receives it and shows it in three places that do not scroll with the chat: a one-line bar above the pane for the session being viewed, a "Needs you" drawer that lists every open question across all sessions, and count badges on the session tabs, sidebar rows, status bar, Dock badge and menu bar item.
- The daemon raises a native notification at the existing `needsYou` level.
- The human answers with a choice button or free text, or dismisses it, from any client or from the shell with `tl answer`. The first response wins.
- The daemon sends the answer to the asking node as a framed message from `human (answer to q-1a2b3c4d)` through the existing message queue, and retries until it has a delivery receipt.
- The agent can withdraw a question, and can list its open questions and recent answers with `list_questions`.
- If the asking node is closed, the question moves to its nearest live ancestor rather than disappearing.

## 4. Terms

- **Question**: one record raised by `ask_human`. It may be a question, a decision between options, or a request for the human to do something; the design does not distinguish these (section 5.3).
- **Asker**: the node that called `ask_human`.
- **Owner**: the node the answer is delivered to. It is the asker until the asker is closed; then it is the asker's nearest live ancestor.
- **Assumption**: optional text in which the asker says what it will do in the meantime if nobody answers.
- **Open**: not yet answered, dismissed or withdrawn.
- **Tree** and **session**: a root node and everything under it, as elsewhere in Tiller.
- **Client**: the native app or a browser tab connected to the daemon's WebSocket.

## 5. Data model and lifecycle

### 5.1 Fields

These types go in `src/shared/protocol.ts`.

```ts
/** A question an agent raised for the human with ask_human. Stored by the daemon in <home>/questions.json. */
export type QuestionState = 'open' | 'answered' | 'dismissed' | 'withdrawn';

/** The human's answer. At least one of choice and text is set. */
export interface QuestionAnswer {
  /** One of the question's choices, verbatim. */
  choice?: string;
  text?: string;
  at: number;
}

/**
 * Whether the owner has been told the answer.
 * waiting: not sent yet, or the last attempt failed; the daemon tries again (detail says why).
 * queued: in the owner's message queue. delivered: the owner accepted the prompt.
 * unconfirmed: sent with no receipt; never sent again automatically. dropped: no node is left to tell.
 */
export interface AnswerDelivery {
  state: 'waiting' | 'queued' | 'delivered' | 'unconfirmed' | 'dropped';
  messageId?: string;
  detail?: string;
  at?: number;
}

export interface Question {
  /** "q-" and 8 hex characters. */
  id: string;
  /** Root of the tree it was asked in. Fixed; names the session directory its log events go to. */
  rootId: string;
  /** The owner: the node the answer goes to. */
  nodeId: string;
  /** The asker and its title when it asked, kept for display after it closes. */
  askedBy: { id: string; title: string };
  /** One line the human can answer without opening the chat. */
  question: string;
  /** Background, as plain text with line breaks. */
  context?: string;
  /** 2 to 6 labels, shown as buttons. */
  choices?: string[];
  /** What the asker does meanwhile if nobody answers. Absent: work is waiting on the human. */
  assumption?: string;
  state: QuestionState;
  askedAt: number;
  /** When it left 'open'. */
  resolvedAt?: number;
  answer?: QuestionAnswer;
  delivery?: AnswerDelivery;
  /** Set when withdrawn: a node id, or 'tiller' for the daemon, and why. */
  withdrawn?: { by: string; reason?: string };
  /** The question that replaced this one (ask_human with replaces). */
  replacedBy?: string;
}
```

The daemon keeps one more field that clients never receive:

```ts
/** src/daemon/questions.ts */
interface StoredQuestion extends Question {
  /** The asker's ancestors when it asked, nearest first. parentId never changes, so this stays true. */
  path: string[];
  /** When the answer was last pushed, to space retries. */
  triedAt?: number;
}
```

### 5.2 States

```
                 ask_human
                     |
                     v
   +--------------> open ---------------+------------------+
   |                 |                  |                  |
   |   human answers |   human dismisses    asker or ancestor withdraws,
   |                 v                  v   replaces it, or the tree is gone
   |             answered           dismissed          withdrawn
   |                 |
   |                 v   delivery: waiting -> queued -> delivered
   |                                   +-----------> unconfirmed | dropped
   |
   +-- owner closed: stays open, nodeId moves to the nearest live ancestor
```

`answered`, `dismissed` and `withdrawn` are final. Nothing reopens a question; an agent that needs to ask again asks a new one.

There is no `expired` or `stale` state. The purpose of the feature is that a question waits for the human for as long as it takes, so the daemon never times one out. Staleness is handled by people: the card shows the question's age, the agent is told to withdraw questions that no longer matter, and the human can dismiss.

There is no `acknowledged` state. Gas Town tracks acknowledgement so it can raise an unacknowledged item again at a higher severity. Tiller has one human on one machine; a second state would add a click without changing what happens next. Section 17 lists re-notification as left out.

### 5.3 No kinds and no severity; an assumption instead

**Chosen.** One kind of record. A decision is a question with `choices`. A request for action ("push the branch and open the pull request") is a question with choices such as "Done" and "Not doing it". Whether work is held up is carried by the presence or absence of `assumption`, which the UI shows as "Waiting on you" or "Meanwhile: …" and uses to sort.

**Alternatives considered.**

- *Kinds (`question`, `decision`, `fyi`, as in LangChain's Agent Inbox).* Question and decision differ only in whether choices are present, which the data already says. An FYI has nothing to resolve, so it has no lifecycle, and Tiller already has places for information: the last-message panel, `report_outcome` summaries, the Activity drawer and the tree-finished notification. Allowing FYIs in the list would invite agents to post status there, and a "needs you" list that contains things that do not need you stops being read. Rejected.
- *Severity levels (as in Gas Town).* Severity matters when items are routed to different people or re-raised on a timer. Here it would drive only sort order and perhaps a sound. Agents are poor judges of their own urgency and tend to mark everything high. The one distinction that changes what the human should do first is "is anything waiting on this", and `assumption` states that as a fact rather than a ranking. Rejected.

`assumption` also pushes agents toward the behaviour the owner asked for. An agent that must say what it will do meanwhile is being asked to keep working rather than stop.

### 5.4 Where questions are stored

**Chosen.** One file, `<home>/questions.json`, owned by a new daemon module. Its shape is `{ "version": 1, "items": StoredQuestion[] }`. Every change is written at once, synchronously, to a temporary file and renamed over the old one, the way `inbox.json` is written. Changes happen at human speed, so there is no debounce, and a tool call that has replied "recorded" is on disk.

Resolved questions stay in the file for 7 days after `resolvedAt` and are dropped on the next write after that. Open questions are never dropped.

**Alternatives considered.**

- *On the node record in `state.json`.* `NodeView` extends `NodeRecord` and is sent whole in every `node` broadcast, so question text would ride along with every status change. A record is deleted when its node closes, which conflicts with keeping a question after its asker closes. Rejected.
- *On `NodeRuntime`, as `suggest_command` does.* Runtime state is lost on `tl reload`, which the brief rules out. Rejected.
- *In the tree's session directory (`sessions/<rootId>/`).* Every agent in the tree may write there without a permission prompt, and the docs already treat `events.jsonl` and `archive.jsonl` as advisory for that reason. A question file there could be edited to show an answer the human never gave. The home directory's own files (`state.json`, `inbox.json`, the admin token) are the daemon's, and agents have no write permission rule for them. Rejected.
- *Derived from `events.jsonl`.* Same trust problem, and the log is append-only text that the sweep deletes. The log gets entries for history (section 8.4) but is never read back as state.
- *In `inbox.json`, as messages to a pseudo-node `human`.* The inbox is built around a target that polls, claims and acknowledges, with a 5-minute expiry and a 16-message cap. None of that fits a reader who may be away for a day. Rejected; the answer's trip back to the agent does use the inbox.

### 5.5 What happens when the owner restarts, exits or closes

- **Node restart or harness change** (fresh context, same node id): the question is untouched. The new context does not remember asking. The answer message carries the question text, so it is understandable on its own, and the system prompt tells the node that `list_questions` shows what it has open.
- **Context compaction**: nothing changes on the daemon side. An answer that arrived before the compaction may be summarised away; `list_questions` returns answers from the last 24 hours.
- **`tl reload`, an update or a crash**: the file is loaded on start. Delivery states are reconciled (section 6.5).
- **The owner's process exits** but the node remains: the question stays open and its card notes that the node is not running. An answer given meanwhile is stored and delivered when the node runs again.
- **The owner is closed** (close, kill, prune): each of its open questions, and each answered question whose delivery is not yet `delivered`, moves to the first node in `path` that still exists. `nodeId` changes; `askedBy` does not. Nobody is messaged about the move: the new owner hears about the question when its answer arrives, in a message that says who originally asked. If no node in `path` exists, an open question becomes `withdrawn` with `{ by: 'tiller', reason: 'the node that asked was closed' }` and an undelivered answer's delivery becomes `dropped`.

**Alternatives considered for a closed owner.**

- *Withdraw the question when its node closes.* This is the simplest rule, and it recreates the original problem: an orchestrator routinely closes a worker as soon as its report arrives, and the worker's still-open question would vanish from the list at that moment. Rejected.
- *Keep the question open with no owner.* The human would answer into nothing. Rejected.
- *Refuse to close a node that has open questions,* as a dirty worktree refuses. This would block cleanup on the human's attention, which is the kind of blocking the owner wants to avoid. Rejected.

Moving the question up matches how Tiller already treats a closed child's unfinished business: its parent is the one who hears about it.

### 5.6 Limits

| Limit | Value | Why |
| --- | --- | --- |
| Open questions per owner | 5 | Bounds noise from one node, as `QUEUE_CAP` does for messages. A sixth `ask_human` is refused with the ids of the open five. |
| `question` | 1 to 500 characters, one printable line | It is the row text, the notification body and the line echoed back with the answer. |
| `context` | up to 4,000 characters, printable text with line breaks and tabs | Background the human may expand. |
| `choices` | 2 to 6, each 1 to 120 characters, one printable line, all different | They are buttons. |
| `assumption`, withdraw `reason` | up to 300 characters, one printable line | |
| Answer text | up to 8,000 characters | Well under the 32,000 characters `deliver` logs. |

"Printable line" is the existing `PRINTABLE_LINE` pattern in `mcp.ts`: no control characters and no invisible format characters. Section 15 explains why that matters here.

## 6. The agent-facing tools

All tools are entries in the `tools` table in `src/daemon/mcp.ts`, so they are served over `/mcp` to every harness and over `POST /api/<tool>` to the CLI.

### 6.1 `ask_human`

```ts
ask_human: tool('Ask the human', ASK_DESCRIPTION, {
  question: z.string().min(1).max(500).regex(PRINTABLE_LINE, 'must be one line of printable characters'),
  context: z.string().max(4000).regex(PRINTABLE_TEXT, 'must be printable text').optional(),
  choices: z.array(z.string().min(1).max(120).regex(PRINTABLE_LINE)).min(2).max(6).optional(),
  assumption: z.string().min(1).max(300).regex(PRINTABLE_LINE).optional(),
  replaces: z.string().regex(/^q-[0-9a-f]{8}$/).optional(),
}, run)
```

`PRINTABLE_TEXT` is `/^(?:[^\p{Cc}\p{Cf}  ]|[\n\t])*$/u`.

Behaviour:

- Refused for the human caller and for a terminal node, as `suggest_command` is. There is no target argument: a node can only ask in its own name.
- If the caller already owns an open question with exactly the same `question` text, that question is returned with `replayed: true` and nothing new is created. This makes a retried tool call harmless and needs no request id.
- If the caller owns 5 open questions, the call is refused: `you have 5 open questions (q-…, q-…): withdraw one, or wait for an answer`.
- `replaces` names an open question the caller owns. It is withdrawn with reason `replaced by <new id>` and gets `replacedBy`, in the same step that creates the new one. If it names a question that is already resolved, the new question is still created. If it names a question the caller does not own, the call is refused.
- Duplicate labels in `choices` are refused.
- A write failure (disk full) refuses the call with the error; the tool never claims a question is recorded when it is not.

It returns:

```ts
{
  text: `Recorded as ${id} and shown to the human in tiller's Needs you list. This call does not wait: carry on or end your turn. ` +
        `The answer arrives later as a message from "human (answer to ${id})". list_questions shows your open questions and recent answers.`,
  data: { id, state: 'open', replayed?: true },
}
```

The description (`ASK_DESCRIPTION`), in full:

> Put a question or decision in front of the human in tiller's Needs you list, where it stays until they deal with it, however much chat scrolls past. It does not wait: the reply gives the question's id at once, and the answer arrives later as a message from "human (answer to <id>)". Use it for something only the human can settle when they may not be reading along; not for status updates, not for what you can find out yourself, and (if you have a parent) not for questions about your brief, which go to your parent with send. `question` is one line the human can answer without opening your chat (up to 500 characters); background goes in `context`. `choices` (2 to 6 short labels) become buttons, and the human may also type a free answer. `assumption` says what you will do meanwhile if nobody answers; leave it out only when your work cannot continue without the answer. One decision per call, at most 5 open at a time. `replaces` withdraws an earlier question of yours in favour of this one. If the human answers in chat instead, call withdraw_question. Asking the same open question again returns the same id.

**Why there is no update call.** An agent that wants to change a question uses `replaces`. A question whose text changes in place while the human is reading or typing an answer needs a revision number on every answer (as `Suggestion.at` does) and still surprises the reader. Replacing produces a new id, the old card visibly becomes "replaced", and an answer aimed at the old id is refused cleanly.

### 6.2 `withdraw_question`

```ts
withdraw_question: tool('Withdraw a question', '…', {
  id: z.string().regex(/^q-[0-9a-f]{8}$/),
  reason: z.string().max(300).regex(PRINTABLE_LINE).optional(),
}, run)
```

- The caller must be the question's owner or an ancestor of its owner. This is the rule `requireOwned(c, id, true)` applies to `rename` and `diff`. The human is refused with "use dismiss".
- An open question becomes `withdrawn` with `{ by: caller, reason }`. When an ancestor withdraws a descendant's question, the descendant is not messaged; the ancestor is expected to have told it whatever made the question moot, with `send`.
- A question that is already resolved is not an error. The reply says what happened, including the answer when there is one (`q-… was already answered: <answer>`), with `data: { ok: false, state, answer? }`, so an agent that raced the human still reads the answer.

**Why not reuse the existing `withdraw` tool.** `withdraw` takes a `messageId` and has message semantics (only while queued). Overloading it by id prefix would save one tool name and make both descriptions harder to follow.

### 6.3 `list_questions`

```ts
list_questions: tool('List questions for the human', '…', { all: z.boolean().optional() }, run)
```

- For an agent: the questions it owns and those its descendants own. For the human: every tree's.
- By default: open questions, then those resolved in the last 24 hours. With `all`: everything still in the file (7 days).
- Text output, one block per question, open first:

```
q-1a2b3c4d open 4m · you
  Should /v2 keep the /v1 alias?
  choices: Keep the alias | Drop it
  meanwhile: keeping the alias
q-9f8e7d6c answered 2m ago · n-3f2a "api worker"
  Which region is the staging bucket in?
  answer: eu-west-1 (delivered)
q-55aa01bc withdrawn 1h ago by n-3f2a · n-3f2a "api worker"
  May I delete the legacy fixtures?
  reason: answered in chat
```

`data` is the `Question[]`.

This tool is how an agent recovers after a restart or a compaction, and it is the reason a failed answer delivery cannot lose the answer: the answer lives on the question, and the message is only the announcement.

### 6.4 `answer_question` and the CLI (human only)

```ts
answer_question: tool('Answer a question', '…', {
  id: z.string().regex(/^q-[0-9a-f]{8}$/),
  choice: z.string().min(1).max(120).optional(),
  text: z.string().min(1).max(8000).optional(),
  dismiss: z.boolean().optional(),
}, run, true)   // humanOnly: refused to agents over /api and not listed to them over MCP
```

Exactly one of "answer" (a `choice`, a `text`, or both) and `dismiss: true` must be given. The WebSocket message in section 8.3 calls the same functions.

`src/daemon/cli.ts` gains:

```
tl questions [--all]                      list questions, open first, numbered choices
tl answer <id> [TEXT] [--choice N|LABEL]  answer one; N is the choice's number in tl questions
tl dismiss <id>                           drop one without answering; the agent is not told
```

`--choice` is matched against the labels first, and only if none matches is a number treated as a 1-based index; the CLI resolves the index by calling `list_questions`, so the API itself only ever takes a label. Inside a node, `tl answer` runs with the node's token and is refused; the human runs it from their own shell or from the node's Terminal tab, whose environment has no node identity.

### 6.5 How the answer reaches the agent

**Chosen.** The answer is stored on the question first, then announced to the owner with `deliver` from `messaging.ts`, sent by the daemon with a label that names the human:

```ts
deliver(manager, DAEMON, q.nodeId, body, {
  fromLabel: `human (answer to ${q.id})`,
  replyTo: null,
  about: [q.nodeId],
  onSettle,
});
```

The owner sees:

```
--- TL MESSAGE <nonce> ---
from: human (answer to q-1a2b3c4d)
reply-to: none
The human answered your question q-1a2b3c4d.
Question: Should /v2 keep the /v1 alias?
Choice: Keep the alias
Answer: Yes, until March. Add a deprecation header.
--- END TL MESSAGE <nonce> ---
```

The `Choice:` and `Answer:` lines appear only when set. When the question has moved to an ancestor, the first line is instead `The human answered question q-1a2b3c4d, asked by n-3f2a "api worker", which has since closed. You are its nearest live ancestor, so the answer comes to you.` Only the one-line `question` is echoed, never `context` (section 15).

A dismissal is **not** announced. Dismiss means "take this off my list". The common case is that the human already answered in chat and the agent forgot to withdraw; a message saying "dismissed" would cost the agent a turn and add to the noise this feature exists to reduce. `list_questions` shows the dismissal. If the human wants the agent to proceed without an answer, they say so as an answer.

**Delivery tracking.** The question's `delivery` follows the message:

| `deliver` result or settle | `delivery.state` | Then |
| --- | --- | --- |
| `delivered` | `delivered` | Done. |
| `queued` | `queued` (with `messageId`) | Wait for `onSettle`. The queue holds the message while the owner works. |
| `stalled` | `unconfirmed` | Never resent automatically: the prompt may have landed. The card says so; the agent can still read the answer with `list_questions`. |
| `expired`, `queueFull`, `gone`, `refused` | `waiting` (with the detail) | Try again. |
| owner not running | `waiting` ("the node is not running") | Try again when it runs. |

Retries: on every `node` event for the owner, and on a 30-second timer while any delivery is `waiting`, the module pushes again if the owner is live and at least 30 seconds have passed since `triedAt`. One message per question is in flight at a time.

**After a daemon restart.** `onSettle` callbacks do not survive a restart, although queued messages do. On load, for each answered question whose delivery is `queued`, the module calls `withdraw(manager, DAEMON, messageId)` and ignores a failure. If `messageStatus` then still reports the message as queued, the owner's bridge had already claimed it, so delivery becomes `unconfirmed`. Otherwise it becomes `waiting` and is sent again once the owner is live, with a fresh callback. The cost is a possible duplicate answer if the old daemon died in the instant between delivery and recording it; a repeated identical answer is harmless.

**A fix this depends on.** `deliver` prunes its status table by age: an entry older than one hour is deleted even when its message is still queued, which happens when the target works for more than an hour. The message is still delivered, but `onSettle` is never called and no `settle` event is logged (reproduced; section 19, item 1). A question's delivery would then show `queued` for ever. Phase 2 changes the prune in `deliver` to keep entries whose outcome is still `queued`.

**Alternatives considered.**

- *Send as the human (`deliver(manager, HUMAN, …)`).* `deliver` rate-limits every sender except the daemon to one message per target per 10 seconds. A human answering two questions from the same node in quick succession would have the second refused. Sending as the daemon with a label avoids that without touching the rate limit. The envelope the agent reads is the same either way. In the Transcript tab's conversation view the answer appears in the owner's upward conversation as a notice labelled `human (answer to q-…)`.
- *Hold the tool call open until the human answers (HumanLayer's "human as tool").* This is a blocking question, which the owner does not want, and tool calls time out.
- *Inject the answer as a steer (`mode: 'now'`).* Interrupting a working agent is reserved for a worker heading the wrong way. An answer can wait for the turn to end, as every other message does.
- *Rely on the agent polling `list_questions`.* An idle agent does not poll. The message is what wakes it.
- *Announce dismissals to the agent.* Covered above.

### 6.6 What the system prompt says

The guidance has to reach nodes whose role prompt is overridden by `~/.tiller/prompts/*.md` or `.tiller/*.md`, so the core sentences go in the preamble built by `systemPrompt` in `src/daemon/launch.ts`, next to the existing `suggest_command` sentence, and differ by whether the node has a parent, as the infrastructure paragraph already does.

For a node with no parent:

> A question you only write in your reply scrolls out of the human's view when other messages arrive. When you need the human to answer or decide something and they may not be reading along (workers are running, or you expect other messages first), call ask_human as well as saying so in your reply: the question stays listed for them until answered, and the answer arrives as a message. One decision per question; say what you will do meanwhile. If they answer in chat, call withdraw_question. list_questions shows your open questions and recent answers, for example after a restart.

For a node with a parent:

> Questions about your brief go to your parent with send. Call ask_human only for what only the human can settle (their credentials, a decision that is theirs to make), and mention it in your report. If the human answers in chat, call withdraw_question.

`DEFAULT_PROMPTS.orchestrator` gains one clause in its last paragraph: "a worker's open question that only the human can answer goes to them through ask_human, naming the worker". The worker prompt is unchanged; its instruction to ask the parent first stays the default.

The wording aims at the middle. "Use it for every question" would raise a card for each clarification in a one-to-one chat, where the human is reading the reply two lines above. "Use it when you think of it" would leave the original problem. The test given to the agent is one it can evaluate: is anything else going to arrive in this chat before the human is likely to read the question?

## 7. Who may ask, and who answers

**Chosen.**

| Action | Who |
| --- | --- |
| Ask | Any agent node, in its own name. Not terminal nodes, not the human. |
| See | The human sees everything. An agent's `list_questions` shows its own and its descendants'. |
| Answer, dismiss | The human only. |
| Withdraw | The owner, or any ancestor of the owner. |
| Receive the answer | The owner. |

**Why any agent node and not only roots.** Three things in the code point the same way.

1. A direct, non-blocking channel from any agent node to the human already exists: `suggest_command` is open to every agent node, and its badge appears on that node's row.
2. Workers already reach the human directly when they are blocked: a worker's permission prompt or `AskUserQuestion` is answered by the human in the worker's own terminal, and the orchestrator prompt says "never answer its permission prompts for it".
3. Under the lineage rule in `messaging.ts`, a node's ancestors are in its scope, and the human is in effect the ancestor of every root (the conversation list shows a root's parent as `human`). Asking the human is messaging an ancestor.

A roots-only rule would force every worker question through two extra orchestrator turns (worker to orchestrator, orchestrator to human, and back), spending the orchestrator's context, which is the other scarce resource in a busy tree. The risk of allowing workers is noise: eight workers each raising questions their orchestrator could have answered. That is held down by the prompt (parent first), the tool description, and the cap of 5 open questions per node. Because the choice is a judgement about how the owner's agents behave, it is the first open decision in section 18; switching to roots-only is one check in the tool and one sentence in the prompt.

**Why not an escalation chain** (the worker's question goes to its parent, which answers or forwards). Tiller already has the cheap half of this: `send` to the parent, which the worker prompt makes the default for anything about the brief. Making `ask_human` itself route through the parent would cost a parent turn for every question, would leave the question invisible to the human for as long as the parent is mid-turn, and would need a "holder" that moves up the tree. `ask_human` is for what the agent judges only the human can settle.

**Why a parent can withdraw but not answer.** An answer is delivered in an envelope that says it is from the human, and the receiving agent treats it with that authority. If an agent could mark a question answered, an agent could speak as the human. A parent that knows the answer sends it with `send`, as itself, and withdraws the question. Withdrawal by ancestors follows the rule `close`, `merge` and `rename` use: descendants only.

**Why the list is not scoped more tightly for reading.** An agent can already `read` the transcript of any node in its lineage, so question text is not a secrecy boundary inside a tree. `list_questions` shows own-and-descendants because that is what is useful, not because the rest is secret.

## 8. Daemon architecture

### 8.1 The module

New file `src/daemon/questions.ts`, exporting a class that `NodeManager` constructs, the way it constructs `Shells`:

```ts
export class Questions {
  constructor(m: NodeManager);                       // loads <home>/questions.json, reconciles, subscribes to 'removed' and 'node'

  /** For the snapshot: every open question, and those resolved in the last 24 hours. Without `path` and `triedAt`. */
  recent(): Question[];
  /** For list_questions: own and descendants' for a node, everything for the human. */
  visibleTo(caller: string, all?: boolean): Question[];
  openCount(nodeId: string): number;
  /** For the away digest: open questions asked at or after `since`. */
  digest(since: number): DigestItem[];

  ask(caller: string, req: { question: string; context?: string; choices?: string[]; assumption?: string; replaces?: string }): { question: Question; replayed: boolean };
  withdraw(caller: string, id: string, reason?: string): Question;   // throws when not permitted; returns the question as it now is
  answer(id: string, a: { choice?: string; text?: string }): Question; // the human; throws when not open or invalid
  dismiss(id: string): Question;                                        // the human; throws when not open
}
```

`manager.ts` changes by one field (`readonly questions: Questions`) and one constructor line. The class announces every change by emitting on the manager:

```
'question' (q: Question, isNew: boolean)     asked (isNew) or changed
```

`server.ts` broadcasts it, and `index.ts` passes new ones to the notifier. Each mutating method does its checks, changes the record, writes the file, logs the event and emits, all synchronously in one tick. Only the answer push afterwards is asynchronous.

**Alternative considered: a free-standing module wired through `mountMcp`'s context,** as `confirm` and `dnd` are. That keeps `manager.ts` untouched but threads a new parameter through `mountMcp`, `modApi`, the server and the tests' own `mountMcp` calls. `manager.shells` is the closer precedent and costs two lines.

### 8.2 What is reused and what is not

| Existing piece | Used for | Not used for, and why |
| --- | --- | --- |
| `deliver` and the inbox (`messaging.ts`) | Carrying the answer to the owner, with its queueing, restart survival, hold during a drain and receipts. | Storing questions: the inbox assumes a polling target, expires after 5 minutes and caps at 16. |
| `confirm` (`server.ts`) | Its idea of replaying pending items to a client that connects late, done here through the snapshot. Its notifier hook style (`server.onApproval`). | The mechanism: it is modal, yes/no, expires, and denies at once when no client is connected. Pending approvals also stay out of the new list in version 1, because two of the three kinds hold an agent's turn and need the modal's urgency. |
| `suggest_command` | The shape of the tool (agent only, own node only, validated text, immediate return, a reply that says what the human will see), the badge pattern on rows and collapsed parents, and the "refuse a stale click" idea, here as "refuse a response to a question that is no longer open". | Its storage: runtime-only, one per node, replaced by the next call. A second question must not erase the first, and none may be lost on reload. |
| `NEEDS_YOU_STATES` and node status | Nothing changes. | A new node state: status is derived from harness events, and a node with an open question is genuinely `done` or `working`. The "needs you" counts add open questions on top (section 9.3). |
| Station notices | Nothing. | Telling a parent about a child's unanswered question: it would cost the parent a turn, and the parent can look with `list_questions`. |
| `events.jsonl` | History and `tl log`. | State: agents can write it. |
| The away digest | Gains question rows (section 10). | |

### 8.3 Protocol

All additions are optional fields or new message types, so nothing existing changes meaning.

```ts
// Daemon -> UI
export type ServerMessage =
  // ...
  | { t: 'snapshot'; nodes: NodeView[]; /* existing fields */ questions?: Question[] } // every open question and those resolved in the last 24 hours
  | { t: 'question'; question: Question }   // asked or changed: replaces the client's copy by id
  // ...

// UI -> Daemon
export type ClientMessage =
  // ...
  | { t: 'question'; id: string; action: 'answer' | 'dismiss'; choice?: string; text?: string } // answer needs choice or text; dismiss takes neither
  // ...

/** One node's line in the away digest. questionId: the row is an open question; a client that knows questions opens it instead of selecting the node. */
export interface DigestItem { id: string; title: string; kind: 'needsYou' | 'errored' | 'finished'; text?: string; at: number; questionId?: string }
```

The zod schema in `server.ts`:

```ts
z.object({ t: z.literal('question'), id: z.string().regex(/^q-[0-9a-f]{8}$/), action: z.enum(['answer', 'dismiss']),
  choice: z.string().min(1).max(120).optional(), text: z.string().min(1).max(8000).optional() })
  .refine((m) => (m.action === 'answer' ? m.choice !== undefined || m.text !== undefined : m.choice === undefined && m.text === undefined)),
```

Details:

- **Snapshot.** `questions: manager.questions.recent()`. A client that connects late therefore has every open question, which is the replay `confirm` does by hand.
- **Deltas.** One message type carries the whole question on every change. Questions are small and rare, so there is no patch format and no removal message: a resolved question arrives as a delta with its final state, and clients drop resolved ones older than 24 hours when they render.
- **Success has no reply.** The `question` broadcast with the new state is the confirmation, for the client that acted and for every other.
- **Refusals** are sent to the acting client as `{ t: 'error', message, id: <owner node id> }`. The `question` case in `handle` must catch and send this itself, because the generic handler puts `msg.id` in the error's `id`, which the UI treats as a node id.
- **Digest.** In the `visibility` handler, the items are `[...manager.questions.digest(since), ...(await manager.digest(since))]`. A question row is `{ id: nodeId, title: askedBy.title, kind: 'needsYou', text: 'Asks: ' + question, at: askedAt, questionId }`.

### 8.4 Event-log entries

Written to the tree's `events.jsonl` with `appendEvent(sessionDir(home, q.rootId), …)`, using the `rootId` stored on the question, because `manager.logEvent` cannot find the tree of a node that has just been removed. `id` is the owner's node id at the time.

| `type` | Extra fields |
| --- | --- |
| `ask` | `questionId`, `question`, `choices?`, `assumption?`, `context?` (cut to 2,000 characters, with `contextCut`), `replaces?` |
| `ask_answer` | `questionId`, `choice?`, `text?` (cut to 32,000, with `textCut`) |
| `ask_dismiss` | `questionId` |
| `ask_withdraw` | `questionId`, `by`, `reason?` |
| `ask_move` | `questionId`, `from` (the closed owner), `to` |

The answer's delivery needs no entries of its own: `deliver` already logs `send` and `settle` for the message.

### 8.5 Several clients, and races

The daemon is one thread and each mutation is synchronous from check to write, so "at the same time" always resolves to an order.

- **Two clients answer.** The first changes the question to `answered` and every client receives the delta. The second is refused: `q-1a2b3c4d was already answered`. Its client has, by then, also received the delta.
- **The human answers after the agent withdrew** (or the reverse). Whichever arrives first wins. A late answer is refused: `q-1a2b3c4d was withdrawn by the agent: <reason>`. A late withdraw gets the non-error reply that carries the answer (section 6.2).
- **The human answers a question that was replaced.** Refused: `q-1a2b3c4d was replaced by q-5e6f7a8b`. The new card is already on screen.
- **The human's typed text when an answer is refused.** The UI keeps a draft per question id and clears it only when that question becomes `answered`. A refused answer therefore leaves the text in the box of the now-resolved card, where it can be copied.
- **A client that never reconnects.** Nothing is owed to it; state lives in the daemon.
- **Clients and the CLI together.** `tl answer` calls the same `answer` method. Clients see the delta.

## 9. The UI

### 9.1 Where the list lives

**Chosen.** Three surfaces that share one card component.

1. **A question bar** above the pane, shown whenever the session being viewed has an open question. It is one fixed line, below the title bar and above the stage, so it is present on every pane tab (Agent, Diff, Transcript, Terminal) and never scrolls. It shows the first open question of the session (the selected node's own before others, questions without an assumption before those with one, oldest first), the number of others, and an **Answer** button. It borrows the look of the suggestion strip (`.suggest-strip` in `ui/layout.css`).
2. **A "Needs you" drawer** listing every open question in every session, grouped by session with the current one first, then the nodes blocked on a prompt, then a collapsed list of what was resolved in the last 24 hours. Answering happens here. It reuses the structure of `ui/ActivityDrawer.tsx`: a fixed drawer on the right, 420 px wide, which becomes a full-window modal dialog on a narrow window, with the same Escape and focus-return handling.
3. **A "Needs you" button** at the right end of the session tabs strip, always visible in the browser and in the app (where that strip is the title bar). It shows the total count and opens the drawer.

**Alternatives considered.**

- *A section in the sidebar.* The sidebar is 320 px by default and already holds the session switcher, the tree, the details inspector and a footer. There is room for a count but not for a question with context, choices and a text box. The sidebar gets badges instead.
- *A tab beside Agent, Diff, Transcript and Terminal.* A pane tab belongs to one node and replaces the terminal while open, so it is neither global nor visible while the human watches the agent. Rejected.
- *Only a count in the session tabs or status bar.* A number does not say what is being asked, and the owner's complaint is that the question itself goes out of view. The bar keeps the words on screen.
- *A docked panel in the slot the Last response panel uses (`.panel` in `.work`).* A docked panel does not cover the terminal, which is pleasant while answering. It also means two panels competing for one slot, new width and resize handling, and its own narrow-window behaviour. The drawer covers the right 420 px of the terminal only while the human is answering, and the bar already provides the always-visible part. This is open decision 6.
- *Answering inside the bar.* Choice buttons in the bar would allow one-click answers. It would also make the bar's height vary, and each change of height resizes the terminal underneath. Left for later (section 17).

### 9.2 Mockups

In these drawings `(o)` is a node's state dot, `?N` is the count badge and `->` is the jump-to-node button.

**A. One open question in the session being viewed, two more elsewhere.**

```
+--------------------------------------------------------------------------------------------+
| (o) tiller 1   (o) dotcms-core 2   (o) docs      +                      [ (o) Needs you 3 ] |
+-----------------------+--------------------------------------------------------------------+
| (o) tiller  ~/tiller  | tiller                               (o) done      Restart  ...    |
| [ + New session ]     | ~/workspace/tiller   claude   opus                                 |
|                       | Agent   Diff   Transcript   Terminal              [ Last response ]|
| (o) orchestrator ?1 4m+--------------------------------------------------------------------+
|     done              | ? orchestrator asks  Should /v2 keep the /v1 alias?     [ Answer ] |
|  +(o) api worker   2m +--------------------------------------------------------------------+
|  |   working · Edit   |                                                                    |
|  +(o) ui worker    9m |   (the agent's terminal, unchanged)                                |
|      done             |                                                                    |
+-----------------------+--------------------------------------------------------------------+
| (o) daemon connected · 127.0.0.1:7788    9 nodes · 3 need you    Usage                      |
+--------------------------------------------------------------------------------------------+
```

**B. The bar with several questions, the first of which has an assumption.**

```
| ? api worker asks  Which region is the staging bucket in?   meanwhile: eu-west-1   +2  [ Answer ] |
```

**C. The drawer, opened from the bar's Answer button; the first card has focus in its text box.**

```
                                              +------------------------------------------+
                                              | Needs you (4)                   [ Close ] |
                                              +------------------------------------------+
                                              | TILLER · this session                    |
                                              | +--------------------------------------+ |
                                              | | orchestrator ->              4m ago  | |
                                              | | Should /v2 keep the /v1 alias?       | |
                                              | | > Context                            | |
                                              | | Waiting on you                       | |
                                              | | [ Keep the alias ]  [ Drop it ]      | |
                                              | | +----------------------------------+ | |
                                              | | | Type an answer…                  | | |
                                              | | +----------------------------------+ | |
                                              | |        [ Dismiss ]  [ Send Cmd+Enter ]| |
                                              | +--------------------------------------+ |
                                              | DOTCMS-CORE                              |
                                              | +--------------------------------------+ |
                                              | | api worker ->               12m ago  | |
                                              | | Which region is the staging bucket   | |
                                              | | in?                                  | |
                                              | | Meanwhile: assuming eu-west-1        | |
                                              | | +----------------------------------+ | |
                                              | | | Type an answer…                  | | |
                                              | | +----------------------------------+ | |
                                              | |        [ Dismiss ]  [ Send Cmd+Enter ]| |
                                              | +--------------------------------------+ |
                                              | ...                                      |
                                              | BLOCKED ON A PROMPT (1)                  |
                                              |   builder ->  needs approval: Bash npm … |
                                              | > Resolved in the last 24 hours (3)      |
                                              +------------------------------------------+
```

**D. Resolved cards, as the collapsed section shows them.**

```
| +--------------------------------------+ |
| | orchestrator ->          answered 1m | |
| | Should /v2 keep the /v1 alias?       | |
| | Answer: Keep the alias, "until March"| |
| | Queued until orchestrator is idle    | |   delivery: queued
| +--------------------------------------+ |
| +--------------------------------------+ |
| | api worker (closed), now orchestrator| |   the owner moved to the ancestor
| | Which region is the staging bucket…  | |
| | Answer: "eu-west-1"                  | |
| | Delivered                            | |
| +--------------------------------------+ |
| +--------------------------------------+ |
| | ui worker ->            withdrawn 2h | |
| | May I delete the legacy fixtures?    | |
| | Withdrawn by the agent: answered in  | |
| | chat                                 | |
| +--------------------------------------+ |
```

The delivery line reads, by state: `waiting` "Waiting to tell <node>: <detail>"; `queued` "Queued until <node> is idle"; `delivered` "Delivered"; `unconfirmed` "Sent, but delivery is unconfirmed; the agent can still read it"; `dropped` "Not delivered: the node was closed".

**E. Nothing open.** The bar is absent, the strip button is dim, and the drawer says so.

```
| (o) tiller   (o) dotcms-core   (o) docs      +                               [ Needs you ] |
                                              +------------------------------------------+
                                              | Needs you                       [ Close ] |
                                              +------------------------------------------+
                                              | Nothing needs you.                       |
                                              | Questions agents raise with ask_human,   |
                                              | and nodes blocked on a prompt, appear    |
                                              | here.                                    |
                                              | > Resolved in the last 24 hours (3)      |
                                              +------------------------------------------+
```

**F. A narrow window.** The strip button shrinks to its count, the bar keeps its button and truncates the text, and the drawer is a full-window dialog (section 9.7 gives the widths).

```
+----------------------------------------+      +----------------------------------------+
| (o) tiller 1  (o) dotc…  +     [ (o)3 ] |      | Needs you (4)                 [ Close ] |
+---------------+------------------------+      +----------------------------------------+
| (o) orche. ?1 | tiller     (o) done ...|      | TILLER · this session                  |
|  +(o) api wor | Agent Diff Transc Term |      | +------------------------------------+ |
|  +(o) ui work +------------------------+      | | orchestrator ->            4m ago  | |
|               | ? Should /v2 k… [Answer]|      | | Should /v2 keep the /v1 alias?     | |
|               +------------------------+      | | [ Keep the alias ]  [ Drop it ]    | |
|               | (terminal)             |      | | [ Type an answer…                ] | |
+---------------+------------------------+      | |    [ Dismiss ] [ Send Cmd+Enter ]  | |
                                                +----------------------------------------+
```

**G. The shell.**

```
$ tl questions
q-1a2b3c4d  open 4m   tiller / orchestrator
  Should /v2 keep the /v1 alias?
  1) Keep the alias   2) Drop it
  waiting on you
q-9f8e7d6c  open 12m  dotcms-core / api worker
  Which region is the staging bucket in?
  meanwhile: assuming eu-west-1
$ tl answer q-1a2b3c4d --choice 1 "until March"
answered q-1a2b3c4d; queued for orchestrator (it is working)
```

### 9.3 Counts on rows, tabs and elsewhere

One shared helper in a new `src/shared/questions.ts` keeps every count the same:

```ts
export const isOpen = (q: Question): boolean => q.state === 'open';
/** Open questions a node owns. */
export const openFor = (qs: Question[], nodeId: string): Question[] => qs.filter((q) => isOpen(q) && q.nodeId === nodeId);
/** Open first: those with no assumption (work is waiting) before the rest, oldest first within each; then resolved, newest first. */
export function sortQuestions(qs: Question[]): Question[];
/** What needs the human: nodes blocked on a prompt, plus open questions. */
export const attention = (nodes: NodeView[], qs: Question[]): number => nodes.filter((n) => needsYou(n.status)).length + qs.filter(isOpen).length;
```

- **Sidebar row** (`ui/sidebar/NodeRow.tsx`): a `count warn` badge `?N` beside the unread dot on a node that owns open questions, with the first question as its tooltip. A collapsed parent shows "N questions" among its signals when hidden descendants own some, as it shows "suggested command" today.
- **Session tabs** (`ui/SessionTabs.tsx`): a small count after the tab title when the session has open questions or blocked nodes. `sessions()` in `ui/sidebar/sessions.ts` takes the questions as an argument, adds them to each session's `needs`, and treats a session with an open question as `needs` for its dot colour. The session switcher's counts follow, since they read the same value.
- **Status bar** (`ui/StatusBar.tsx`): "N need you" uses `attention` and becomes a button that opens the drawer.
- **Document title, Dock badge and menu bar item** (`ui/hooks.ts`, `ui/tray.ts`): the count uses `attention`; `trayState` turns amber for an open question and lists each as `[ownerId, "<title>: <question>"]`. The Rust side receives the same shape as today and does not change.

### 9.4 Answering

- A **choice button** sends the answer at once with that choice, together with whatever is in the text box. Typing a note first and then clicking a choice sends both.
- **Send** (Cmd+Enter in the text box) sends the text alone; it is disabled while the box is empty. Enter inserts a line break.
- **Dismiss** asks nothing further. Its tooltip reads "Remove from your list. The agent is not told; answer instead if it is waiting."
- There are no attachments in version 1. An answer can name a file path.
- All text from the agent (`question`, `context`, `choices`, `assumption`, the withdraw reason) is rendered as plain text with line breaks preserved, never as Markdown or HTML, and links are not made clickable.
- Drafts are kept in a module-level map keyed by question id, so closing the drawer does not lose typed text.

### 9.5 Jumping to the node

The owner's name on a card (with its arrow) is a button that selects that node, which also switches session through the store's existing `choose`. The drawer stays open on a wide window and closes on a narrow one, as the Activity drawer does. A row in "Blocked on a prompt" selects its node the same way. When the owner no longer exists in the client's node list (a resolved question from a closed tree), the name is plain text.

### 9.6 Client state

`ui/store.ts` gains:

```ts
/** Questions by id, as the snapshot and question messages gave them. */
questions: Record<string, Question>;
/** The Needs you drawer is open; focusId is the question to scroll to and focus. */
needs: { open: boolean; focusId?: string };
```

with `openNeeds(focusId?)` and `closeNeeds()`. In `applyServer`, `snapshot` replaces `questions` with `m.questions ?? []` and `question` upserts by id. `conn.ts` routes a `question` message through a small function in `ui/notify.ts` first: when the id is not yet in the store and the state is `open`, it records an Activity entry and shows a toast "<title> asks: <question>" (tone `warn`), and in the browser plays the existing needs-you chime. A snapshot never toasts. `Toast` gains an optional `questionId`; clicking such a toast opens the drawer on that question.

The Cmd+K palette gains a "Needs you" entry beside "Activity". The away digest card opens the drawer on a row that has `questionId`, and uses `id` plus `questionId` as its React key.

### 9.7 Narrow windows

- **The drawer** follows the Activity drawer's rule exactly: at a window width of 420 px or less it is a modal `<dialog>` that fills the window and makes the rest inert; above that it is a 420 px overlay on the right. Selecting a node from a card closes it in the modal form only.
- **The bar** is a single flex row that never wraps. The question text takes the free width and ends in an ellipsis; the "+N" count and the Answer button never shrink. When the pane is under 420 px wide the "<node> asks" label and the "meanwhile" text are hidden, leaving `?`, the question and the button.
- **The strip button** shows its label and count above 640 px and the dot and count alone at or below it, the breakpoint `ui/sidebar/sidebar.css` already uses. With nothing open it stays visible, dim, at every width.
- **The status bar count** is already hidden at 480 px and below by the existing rule in `ui/activity.css`; the strip button is the count that remains.
- **Cards** are one column at every width. Choice buttons wrap onto further lines.

## 10. Notifications, the digest and the terminal

**The native notification.** A new question raises one notification through the existing path. The notifier gains one method:

```ts
question(q: Pick<Question, 'nodeId' | 'question'>): void
// post(q.nodeId, 'needsYou', 'question', { title: node.title, subtitle: root title when different, body: `Asks: ${q.question}` (first 120 characters) }, now)
```

`post` already separates the level's kind from the throttle and log key, so this uses the `notifications.kinds.needsYou` level (default: banner with sound) with its own key, `question`. Every existing rule applies unchanged: nothing is sent for a muted node, during do not disturb, or while a focused client has the owner selected; quiet hours reduce it to a banner without sound, as for any needs-you notification; and at most one is sent per node every 5 seconds. Clicking it runs `tl select <ownerId>`, or selects the owner in the app, and the question bar is then on screen. A suppressed notification is not replayed later; the list and the counts are what persist.

**Chosen: reuse the `needsYou` level. Alternative: a new `notifications.kinds.question` key.** A question means the same thing to the human as the existing kind's description, "a node that needs approval or an answer". A separate key would let someone keep the sound for blocked prompts and silence it for questions, at the cost of a config key, a settings row and documentation before anyone has asked for the distinction. It is a small change to add later, and it is open decision 3.

**No reminders.** Version 1 does not notify again about a question that stays open. Gas Town re-raises unacknowledged items; for one human at one machine, a repeating notification is more likely to get the feature turned off than to get the question answered. The Dock badge and the counts stay up for as long as the question is open.

**The away digest.** A client that regains focus after `daemon.digestAfterMinutes` gets, at the top of the card, one "Needs you" row for each question asked while it was away and still open. Questions come from the daemon's own store, not from the event log.

**Inside a Claude node with no client attached.** The mod's band should gain `· ? N for you (tl questions)`, where N is the number of open questions in the tree, and a toast "<title> asks you something" when a descendant's count rises. This needs `ChildView` to gain `questions?: number` from `/tree`. However, the band is drawn only while no app or browser is connected, and today there is no other way to look at a node's terminal: `tl attach` is still item 4 in `docs/future-plan.md`. As far as I can tell, nobody can currently see the band. The mod change is therefore specified here but left out of version 1 (section 17) and should be built together with `tl attach`.

**Pi and Codex.** Everything above except the band is done by the daemon and the clients, so it is the same for all three harnesses. Pi and Codex have no band today for anything, including blocked children.

## 11. Harness coverage

| | Claude Code | Pi | Codex |
| --- | --- | --- | --- |
| Tools reach the agent | `/mcp`, as `mcp__tiller__ask_human`; the node's settings already allow `mcp__tiller`, and a preset's allowlist always keeps it | `/mcp` through the extension's node-scoped server (`tl_<prefix>_<random>`); a preset's `--tools` always includes it | `/mcp` through the required server `tiller_<random>` |
| Prompt guidance | `--append-system-prompt` | `--append-system-prompt` | `developerInstructions` |
| Answer arrives | The mod polls the inbox, claims the message when the turn ends, submits and acknowledges it. If the mod is not polling, the daemon pastes it into the idle prompt. | The extension's bridge claims one message while idle, submits it natively and acknowledges on Pi's acceptance. | The bridge claims just before `turn/start` and acknowledges when the app-server returns a turn id. |
| An unconfirmed delivery | Only on the paste path (`stalled` when no `UserPromptSubmit` is seen in 8 s) | A claim not confirmed within 60 s | A claim not confirmed within 60 s |
| Compact drawing of the answer in chat | One dim line, "message from human (answer to q-…)", by the existing `mod-rows` plugin, with no change | The frame as text | The frame as text |
| Band without a client | Specified, deferred (section 10) | None exists | None exists |

Nothing in version 1 is specific to Claude. The tool names in prompt text are written bare (`ask_human`), as `suggest_command` is, because each harness prefixes them differently.

## 12. One question, end to end

The steps are the same for every harness except where the last column says otherwise.

| Step | What happens | Harness differences |
| --- | --- | --- |
| **Asked** | The agent calls `ask_human`. The daemon validates, stores, writes `questions.json`, logs `ask`, emits `question`, and replies with the id. The agent carries on or ends its turn; its status is whatever its hooks say. | None. |
| **Shown** | See the table below. | None. |
| **Notified** | The notifier posts at the `needsYou` level unless suppressed. | None. |
| **Answered** | The human responds from a client or the shell. The daemon checks the question is still open, stores the answer, writes, logs `ask_answer`, emits. | None. |
| **Withdrawn** (instead) | The agent calls `withdraw_question`, or the human dismisses. Stored, written, logged, emitted. Nothing is delivered. | None. |
| **Delivered** | The daemon calls `deliver`. If the owner is idle the message is submitted at once; if it is working it waits in the queue; if it is not running the question waits and is pushed when it runs. `delivery` goes to `delivered` on the receipt. | The receipt comes from the mod's acknowledgement or the `UserPromptSubmit` hook (Claude), or the bridge's acknowledgement (Pi, Codex). |
| **Closed** | The question is final. It stays in the drawer's resolved list for 24 hours, in `list_questions` with `all` for 7 days, and in `events.jsonl` until the sessions sweep. | None. |

What the human sees and does, by situation:

| | The app is connected | A browser tab is connected | No client; the human is at a shell | Nobody is there |
| --- | --- | --- | --- | --- |
| **Shown** | Bar, drawer, badges, Dock badge and menu bar item, immediately. A toast and an Activity entry. | Bar, drawer, badges, the count in the tab title, immediately. A toast, an Activity entry and a chime. | `tl questions`. | Stored. Every client that connects later gets it in its snapshot. |
| **Notified** | Native notification through the app, unless a focused window has the owner selected. Clicking selects the owner. | Native notification from the daemon (`terminal-notifier`, else `osascript`), unless the focused tab has the owner selected. | The same daemon notification. With `terminal-notifier`, clicking runs `tl select`, which opens the app if it is built. | The same daemon notification, waiting in Notification Centre. Do not disturb and quiet hours apply. |
| **Answered** | Drawer: a choice, text, or Dismiss. | The same. | `tl answer`, `tl dismiss`. Typing the answer into the agent's chat is not possible without a client. | Later, by any of the other three. Nothing expires. |
| **Returning after a while** | The away digest lists questions asked meanwhile. | The same. | `tl questions`. | |
| **After `tl reload`** | The page reconnects and the snapshot restores the list. | The same. | `tl questions`. | The file is loaded on start. |

Two contrasts with approvals are deliberate. An approval asked while no client is connected is denied on the spot, and one left unanswered expires. A question asked while no client is connected is kept, and never expires.

## 13. Edge cases and failure modes

| Case | Behaviour |
| --- | --- |
| `tl reload`, update or crash with open questions | Loaded from `questions.json`. No notification is repeated. Clients get them in the snapshot. |
| Crash between a change and its write | Cannot leave a replied-to call unrecorded: the write happens before the tool or client is answered. |
| `questions.json` unreadable or of an unknown version | Renamed to `questions.json.corrupt-<timestamp>`, as `state.json` is, and the daemon starts with none. One line in `daemon.log`. |
| The file cannot be written | `ask_human` and the human's answer are refused with the error. In-memory state is rolled back so memory and disk agree. |
| A question's owner is missing at load (`state.json` was lost) | Treated as a closed owner: moved to a live ancestor in `path`, else withdrawn by `tiller`. |
| The same question asked twice | The existing one is returned, `replayed: true`. |
| A sixth open question from one node | Refused, naming the five. |
| `replaces` names a resolved question, or someone else's | Resolved: the new one is created anyway. Someone else's: refused. |
| A choice not among the question's choices; a choice for a question without choices; an empty answer | Refused. |
| The owner restarts or changes harness | Unchanged. During a harness change `deliver` refuses with a retry hint; the delivery waits and retries. |
| The owner exits | Open questions stay. An answer waits as `waiting` and is pushed when the node runs again. |
| The owner is closed, with a live ancestor | The question, or its undelivered answer, moves to that ancestor. |
| The owner is closed, with no live ancestor (a root, or the whole tree) | Open: withdrawn by `tiller`. Answered and undelivered: delivery `dropped`. |
| A root is closed with `--force` while its children live on | The children's questions are untouched: each child is its own owner. |
| The human answers in the agent's chat instead | The agent is told to call `withdraw_question`. If it does not, the human dismisses, silently. |
| The owner is working when the answer comes | The message waits in the queue, whose expiry restarts while the target works. The card says "Queued until <node> is idle". |
| The owner sits on a permission prompt for more than 5 minutes after the answer | The message expires; delivery returns to `waiting` and is retried on the owner's next change or the timer. |
| The owner's queue is full | The same: `waiting`, then retried. |
| The delivery is `stalled` | `unconfirmed`. Not resent. The agent can read the answer with `list_questions`; the human can message the node. |
| The answer waits more than an hour in the queue | Works once the pruning fix in section 6.5 is in. Without it the delivery would show `queued` for ever. |
| A restart while an answer is queued | Reconciled on load (section 6.5); at worst the agent receives the same answer twice. |
| A restart is draining (`tl reload` waiting for turns) | `ask_human` and answers are accepted. `deliver` holds the message until the restart, as it holds every delivery. |
| Asked during do not disturb, quiet hours, or by a muted node | Listed as usual. The notification is suppressed or softened and not replayed. |
| Two questions from one node within 5 seconds | One notification (the throttle); both are listed. |
| Two clients respond at once; answer versus withdraw | The first wins; the second is told what happened (section 8.5). |
| A client that predates the feature | Ignores the new messages; see section 14. |
| An armed or queued node, a terminal node, the human | Cannot ask: the first two have no process, and the tool refuses the last two. |
| Subagents inside a Claude node | They share the node's MCP identity, so their questions belong to the node. |
| Very many questions | Bounded by 5 per node and `daemon.maxLiveNodes` (20 by default), so about 100. The drawer scrolls; the bar shows one and a count. |
| The human deletes `questions.json` by hand | The daemon's in-memory copy is rewritten on the next change. After a restart the list is empty. |

## 14. Migration and compatibility

- **Existing homes.** No `questions.json` means no questions. Nothing else in the home changes format. `state.json`, `inbox.json` and `events.jsonl` are untouched, apart from new event types that older readers ignore (`parseRecords` in `conversation.ts` and `buildDigest` both switch on known types).
- **Existing nodes.** The feature arrives with a daemon restart, which relaunches every live node. Each relaunch builds the system prompt and fetches the tool list afresh, so running nodes gain the tools and the guidance without anyone restarting them by hand. Role overrides in `~/.tiller/prompts` or `.tiller/` need no edit, because the guidance is in the preamble.
- **An older client with the new daemon** (a browser tab not yet reloaded, or an app window that has not reconnected). The extra `questions` field on the snapshot is ignored, and `applyServer` has no case for `question`, so the message does nothing. Such a client shows no questions and sends no question messages. Native notifications still come from the daemon, and `tl answer` works. In practice this state is brief: the page reloads itself when it reconnects to a daemon running a different commit (`conn.ts`).
- **A new client with an older daemon** (`npm run ui:dev` against an old daemon, or the mock). The snapshot has no `questions`, which the store reads as none; with no questions the UI never sends a `question` message, which the old daemon would reject as malformed. The counts fall back to blocked nodes only, exactly as today.
- **The digest.** `DigestItem.questionId` is optional. An older client shows a question row as a needs-you row and selects the node when it is clicked. If one node is both blocked and has a question, the older client's list has two rows with the same React key, which draws a console warning and nothing worse.
- **The native app.** No change to `src-tauri/`. The menu bar item receives the same `[id, title]` pairs.
- **The mod.** No change in version 1.
- **Configuration.** No new keys.
- **Downgrade.** An older daemon ignores `questions.json`. The questions in it are not lost; they reappear after upgrading again, minus any whose resolved time has passed 7 days.

## 15. Security and scope

- **Who can raise a question.** Only an authenticated agent node, and only in its own name, because the tool takes no target. A terminal node is refused. The tool cannot be used to put words on another node's card.
- **Who can answer.** Only a caller holding the admin token: a WebSocket client (every client authenticates with it) or `POST /api/answer_question` as `human`. Agents are not offered the tool over MCP and are refused over `/api`. As everywhere in Tiller, this is as strong as the admin token file: an agent runs as the same OS user and could read `<home>/admin-token`, which would equally let it approve its own `confirm` requests today. This design neither weakens nor strengthens that.
- **Why agents cannot answer for the human.** The answer is delivered with a label saying it is from the human and is acted on with the human's authority. No path lets an agent create that message.
- **Who can withdraw.** The owner and its ancestors. A sibling or a descendant cannot remove a node's question.
- **Who can see.** The human, all of it. An agent, its own and its descendants' through `list_questions`; other text in its lineage it could already reach with `read`.
- **Text shown to the human is agent-controlled.** It is rendered as plain text only. The single-line fields refuse control characters and invisible format characters, including the bidirectional overrides that can make a label display as something other than what it is; this matters because the human clicks a choice and the daemon then tells the agent the human chose that exact label. The notification body is the first 120 characters of `question`, passed to `terminal-notifier` as an argument or to `osascript` through the existing quoting in `notifyArgs`. The command a notification click runs contains only a node id.
- **Text sent back to the agent.** The answer message contains the one-line `question`, the choice and the human's text. Because `question` cannot contain a line break, an agent cannot craft a question that, echoed back, looks like an extra `Answer:` line from the human. `context` is never echoed. When a question has moved to an ancestor, the ancestor receives a descendant's one-line question as quoted data under a daemon-written first line that says where it came from.
- **Frames inside text.** A question or answer that contains something shaped like a Tiller frame is covered by the existing rule that only the outermost frame is authentic.
- **State is not read from agent-writable files.** The store is in the daemon's home, not the session directory, and the digest reads questions from the store, not the event log.
- **What is kept on disk.** Question and answer text sit in `questions.json` (for up to 7 days after resolution) and in the tree's `events.jsonl` (until the sessions sweep), both under the 0700 home, alongside message text that is already kept there.
- **Noise as abuse.** A misbehaving agent can hold at most 5 open questions and cause at most one notification per 5 seconds; muting the node stops its notifications.

## 16. Phased implementation plan

Phase 1 goes first because everything else compiles against it. Phases 2, 3, 4 and 5 touch disjoint files and can run in parallel after it. Phase 6 integrates.

Phase 1 should be able to land alone without breaking the build: the new client message has no zod member yet, and `clientMessage … satisfies z.ZodType<ClientMessage>` should still hold because a schema for a narrower union satisfies the wider type. The phase 1 worker confirms this with the typecheck; if it does not hold, the zod member from section 8.3 moves into phase 1 with a `handle` case that throws "not implemented".

### Phase 1: contracts and client state

Files owned: `src/shared/protocol.ts`, `src/shared/questions.ts`, `src/shared/questions.test.ts`, `ui/store.ts`, `ui/store.test.ts`, `ui/mock-server.mjs`.

Work: the types in sections 5.1 and 8.3; the helpers in 9.3; the store fields, actions and `applyServer` cases in 9.6; mock data (one open question with choices on the root of the first session, one open with an assumption on a child in another session, one answered and one withdrawn), in-memory handling of the `question` client message, and one new question 20 seconds after connecting, to exercise the toast.

Tests: `sortQuestions` orders waiting-on-you before assumed and oldest first; `attention` adds blocked nodes and open questions; `openFor` ignores resolved; the store replaces questions on a snapshot (including one with no `questions` field), upserts on `question`, and keeps a resolved question.

### Phase 2: the daemon's store, tools, WebSocket and CLI

Files owned: `src/daemon/questions.ts`, `src/daemon/questions.test.ts`, `src/daemon/manager.ts` (the field and constructor line only), `src/daemon/mcp.ts`, `src/daemon/mcp.test.ts`, `src/daemon/server.ts`, `src/daemon/server.test.ts`, `src/daemon/messaging.ts` (the status pruning fix only), `src/daemon/messaging.test.ts`, `src/daemon/cli.ts`, `docs/messaging.md`.

Work: sections 5.4 to 5.6, 6.1 to 6.5, 8.1, 8.3 to 8.5; a "Questions for the human" section in `docs/messaging.md`.

Tests, in `questions.test.ts` with a temporary home:

- `ask` stores, writes the file and emits; a new manager on the same home loads it.
- The same text again returns the same id; a sixth open question is refused; `replaces` withdraws the old one and sets `replacedBy`.
- `answer` validates the choice, refuses a resolved question with its state, and calls `deliver` with the label `human (answer to <id>)` and a body containing the question, choice and text.
- Delivery mapping: delivered; queued then settled; `stalled` gives `unconfirmed` and is not retried; `expired` and `gone` give `waiting` and are retried on the owner's next `node` event, not sooner than 30 seconds.
- `dismiss` sends nothing.
- `withdraw` is allowed for the owner and an ancestor, refused for a sibling and a descendant, and on an answered question returns the answer without throwing.
- Closing the owner moves an open question and an undelivered answer to the nearest live ancestor; with none, the question is withdrawn by `tiller` and the answer's delivery is `dropped`.
- A corrupt file is set aside; resolved questions older than 7 days are dropped on write.
- Reconciliation on load: a `queued` delivery whose message is still unclaimed is withdrawn and sent again; a claimed one becomes `unconfirmed`.

In `mcp.test.ts`: `ask_human` is refused for the human and for a terminal node and rejects control characters, a newline in `question`, one choice, seven choices and duplicate choices; `answer_question` is refused with a node's token and absent from an agent's MCP tool list; `list_questions` shows own and descendants' for a node and everything for the human.

In `server.test.ts`: the snapshot carries open questions; a second client receives the `question` delta; two clients answering give one answer and one error whose `id` is the owner's node id; a malformed `question` message (answer with neither choice nor text) is rejected; the digest after an away period includes a question asked meanwhile.

In `messaging.test.ts`: a message still queued after 61 minutes keeps its status, and its acknowledgement calls `onSettle` and logs `settle`. This test fails on the current code.

### Phase 3: notifications

Files owned: `src/daemon/notifier.ts`, `src/daemon/notifier.test.ts`, `src/daemon/index.ts`.

Work: the `question` method and its wiring to the manager's `question` event when `isNew` (section 10). `index.ts` compiles before phase 2 lands because the manager's `on` is the untyped `EventEmitter` one.

Tests: a new question posts at the `needsYou` level with the body `Asks: …`; it is suppressed for a muted node, during do not disturb and when the owner is watched; quiet hours make it a banner without sound; a second within 5 seconds from the same node is throttled while a blocked-prompt notification from that node is not affected by it; a changed (not new) question posts nothing.

### Phase 4: the drawer, the card and the bar

Files owned: a new folder `ui/questions/` (`NeedsYouDrawer.tsx`, `QuestionCard.tsx`, `QuestionBar.tsx`, `drafts.ts`, `questions.css`, and tests beside them), `ui/App.tsx`, `ui/main.tsx` (the stylesheet import), `ui/Palette.tsx`.

Work: sections 9.1, 9.2, 9.4 and 9.5, developed against the mock daemon.

Tests: the bar is absent with no open question in the session and shows the selected node's own question first; its Answer button opens the drawer focused on that question; a card renders choices as buttons and sends `{ t: 'question', action: 'answer', choice }` with any typed text; Send is disabled when the box is empty; Dismiss sends `dismiss`; agent text containing `<b>` or a Markdown link is shown literally; a draft survives closing and reopening the drawer and survives the question becoming `withdrawn`, and is cleared when it becomes `answered`; each delivery state shows its line; the drawer groups by session with the current one first and lists blocked nodes; the empty state renders; at 400 px wide the drawer is a modal dialog.

### Phase 5: counts, badges and toasts on existing surfaces

Files owned: `ui/SessionTabs.tsx`, `ui/StatusBar.tsx`, `ui/sidebar/NodeRow.tsx`, `ui/sidebar/sessions.ts`, `ui/sidebar/SessionSwitcher.tsx`, `ui/sidebar/sidebar.css`, `ui/layout.css`, `ui/tray.ts`, `ui/hooks.ts`, `ui/conn.ts`, `ui/notify.ts`, `ui/Toasts.tsx`, the tests beside each, and `ui/README.md`.

Work: sections 9.3 and 9.6 (the strip button, the toast and Activity entry, the digest row).

Tests: a row shows `?2` for a node owning two open questions and a collapsed parent shows the hidden total; a session whose nodes are all `done` but which has an open question has a `needs` dot and a count on its tab; the status bar count and the document title use `attention`; `trayState` is amber with an open question and lists it; a new open question outside a snapshot produces one toast and one Activity entry, and a snapshot produces none; a digest row with `questionId` opens the drawer.

### Phase 6: prompts, behaviour docs and the end-to-end check

Files owned: `src/daemon/launch.ts`, `src/daemon/launch.test.ts`, `docs/agent-roles.md`, `docs/frontends.md`, `docs/sessions.md`, `spike/e2e-questions.ts`, `spike/README.md`. It runs after phases 2 to 5 are merged, and may then adjust a prompt assertion in `mcp.test.ts`.

Work: the prompt text in section 6.6; a "Questions" section in `docs/frontends.md` (the bar, the drawer, the counts, the notification, `tl questions`); the files and the digest in `docs/sessions.md`; the preamble in `docs/agent-roles.md`.

Tests: `systemPrompt` contains the root wording for a node without a parent and the child wording for one with a parent, for each harness.

The end-to-end check with a real agent is a manual script in the style of `spike/e2e-orch.ts` and `spike/restart-check.ts`. It starts its own daemon on a temporary `TL_HOME` and an unused port (never 7788 or 7790), with `TL_NODE_ID`, `TL_TOKEN_FILE` and `TL_ENDPOINT` unset, and stops it by pid. Steps:

1. Spawn one Claude root on the cheapest model with the prompt: "Call ask_human with the question 'Which colour?' and the choices red and blue, then end your turn. When the answer arrives, write the chosen colour to answer.txt."
2. Connect a WebSocket client and wait for a `question` message in state `open`. Check `tl questions` prints it.
3. Stop the daemon and start it again on the same home. Check the snapshot still carries the question.
4. Send `{ t: 'question', id, action: 'answer', choice: 'blue' }`.
5. Wait for the question to reach `answered` with delivery `delivered`, and for `answer.txt` to contain `blue`.
6. Check `events.jsonl` has `ask`, `ask_answer`, and a `send` with the label `human (answer to <id>)` that settled `delivered`.

The same script should be run once with `--harness pi` and once with `--harness codex` where those CLIs are installed and logged in, since each harness delivers the answer through a different bridge.

The orchestrator runs `npm test` once on the integrated tree, as `AGENTS.md` requires, and per the owner's standing preference the integrated branch is offered in a sandbox daemon for trying before a pull request is opened.

## 17. Left out of version 1

- **Kinds, severity, FYIs** (section 5.3).
- **Reminders and escalation timers** for questions that stay open (section 10).
- **A separate notification level** for questions (open decision 3).
- **The mod's band and toast, and `ChildView.questions`,** until `tl attach` gives someone a way to see them (section 10). A `/tl-questions` slash command belongs with that work.
- **Attachments** on answers, **multiple selection** among choices, and **editing an answer** after sending.
- **Answering from the bar** with one click, and **answering from the notification** with action buttons.
- **Interrupting a working agent with the answer** ("send now").
- **A "send again" control** for an `unconfirmed` delivery; the agent can read the answer, and the human can message the node.
- **Pending approvals in the drawer.** They stay modal.
- **Markdown** in question text.
- **Questions in the Transcript tab's conversations.** The answer already appears there as a labelled notice; showing "asked the human: …" as a mark is one more case in `parseRecords`.
- **Detecting questions in prose.** No tool found in the research does this, and a wrong guess in either direction costs trust in the list.
- **Turning a worker's `openQuestions` into questions automatically.** They are addressed to the parent, which decides what the human needs to see.
- **A phone or chat channel.** The event log entries and the single `question` event are the hook points for it.

## 18. Open decisions for the owner

1. **May workers ask the human directly?** Recommended: yes, every agent node may, with the prompt sending brief questions to the parent first and a cap of 5 open per node. The alternative is roots only, with workers always going through their orchestrator. Direct asking saves two orchestrator turns per question and matches how `suggest_command` and permission prompts already work; roots-only gives a quieter list and an orchestrator that knows everything the human was asked. Changing between them later is one check and one sentence.
2. **Is Dismiss silent?** Recommended: yes. The agent is not messaged when the human dismisses; it sees the dismissal only in `list_questions`. The alternative is to tell the agent, which costs it a turn each time, most often right after the human already answered in chat.
3. **Which notification level?** Recommended: reuse `notifications.kinds.needsYou`, so a question sounds like a blocked prompt and needs no new setting. The alternative is a `notifications.kinds.question` key with its own default.
4. **What happens to a question when its node is closed?** Recommended: it moves to the nearest live ancestor, which receives the answer. The alternative is to withdraw it at close, which is simpler and lets a worker's question vanish when the orchestrator tidies up.
5. **How strongly should agents be told to use it?** Recommended: when the human may not be reading along, meaning workers are running or other messages are expected first. The stronger alternative, "every question to the human goes through ask_human", loses nothing and will put a card up for each clarification in a quiet one-to-one chat.
6. **Drawer or docked panel?** Recommended: the overlay drawer modelled on the Activity drawer, plus the one-line bar. The alternative is a docked panel in the Last response slot, which never covers the terminal and costs more layout work.

## 19. Found along the way

1. **A message queued for more than an hour loses its status record** (reproduced with a throwaway test against `messaging.ts`, since deleted). `deliver` deletes every status entry older than an hour, including one whose message is still queued because its target has been working that long. The message is still delivered, but `message_status` and `withdraw` then say there is no such message, no `settle` event is logged, and `onSettle` is never called. Phase 2 includes the one-condition fix because answer delivery depends on `onSettle`.
2. **The human's own sends are rate-limited.** `deliver` exempts only the daemon from the limit of one message per target per 10 seconds, so two quick `tl send`s, or Diff comments followed by a follow-up, get the second refused. `docs/messaging.md` describes the limit as per sender, so this is as written, but it is surprising for a person. This design avoids it by relaying answers as the daemon.
3. **The mod's band and toasts appear to be unreachable today.** They draw only when no app or browser is connected, and without one of those there is no way to view a node's terminal until `tl attach` exists. I did not find any shipped client that connects without declaring itself an app or a browser.
4. **`docs/frontends.md` describes a status bar control that `ui/StatusBar.tsx` does not have:** a "do not disturb 1 h" button that shows the time left. Do not disturb is reachable from the Cmd+K palette, the menu bar item and `tl dnd`. This is from reading the component and searching `ui/` for it, not from running the UI.
5. **The Activity drawer has no visible button.** The only way to open it is the Cmd+K palette's "Activity" entry.
6. **A reported outcome does not survive a daemon restart,** so a worker's `openQuestions` disappear from the live node after `tl reload` (they remain in the event log). The comment on `Outcome` in `protocol.ts` says so; it is worth knowing when judging how much `openQuestions` can be relied on.
