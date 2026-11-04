# A shell tab for each agent node

Status: spec, 2026-11-04. Not implemented. Includes suggested commands.

## Goal

Let the human run quick CLI commands (`git pull`, `npm test`, `git log`) from Tiller without asking an agent to run them with `!`, which costs tokens and fills the agent's context. Each agent node gets a third pane tab, **Terminal**, holding a plain shell in that node's directory. The existing tab that shows the agent's PTY is renamed **Agent**.

Agents can't type into the shell, but they can **suggest a command** for it: the suggestion waits on the node with a badge until the human inserts it at the prompt (no Enter) or dismisses it. That saves the copy/paste without giving an agent a way to run anything as the human.

Standalone terminal nodes (New session → terminal) stay as they are. The tab is "a shell attached to this agent"; a terminal node is "a standalone shell".

## Decisions

- **One shell per agent node**, spawned lazily the first time its Terminal tab is opened. No idle shells for nodes nobody looks at.
- **Directory:** the node's `cwd` from its record (`rec.cwd`). For a worktree node that is the worktree path, not the repo the Claude adapter launches from (`harness.ts`, `cwd: (n) => n.worktree?.repo ?? n.cwd`). Being in the worker's tree is the main point.
- **Shell:** `manager.shell` (`$SHELL`, then `/bin/sh`) with `-l`, as `terminalLaunch` does for terminal nodes.
- **Human only.** The shell's environment is `buildChildEnv({ PATH: manager.path })`: no `TL_NODE_ID`, `TL_TOKEN_FILE`, `TL_ENDPOINT` or `TL_SESSION_DIR`, so `tl` inside it acts as the human (admin token), never as the agent. MCP tools (`read`, `write`, `send`) and `tl` commands never accept a shell stream id. Agents cannot read or type into it; the only way an agent's text reaches the shell is the human clicking Insert on a suggested command.
- **Lifetime:**
  - Switching tabs or nodes detaches but keeps the shell and anything running in it.
  - Closing the node (close, prune, closing its tree) kills its shell.
  - Daemon shutdown, `tl reload` and `tl update` kill every shell. The UI re-attaches on reconnect, which spawns a fresh one. (A future PTY holder, `docs/design/pty-holder.md`, could keep them.)
  - Agent restart, harness change, resume or exit leave the shell alone. An exited agent node still gets a working Terminal tab.
  - If the shell exits (the human types `exit`), the daemon forgets it and writes `[shell exited; reopen the Terminal tab to start a new one]` to attached clients. The next attach spawns a new shell.
- **No effect on node state.** A shell never changes the node's status, unread flag, notifications, tree-done summary, `maxWorking` slots or restart drain.
- **Not for terminal nodes or archived nodes.** Terminal nodes already are shells; archived nodes have no live record.

## Design

### Protocol (`src/shared/protocol.ts`)

No new message types. A shell is addressed by a **stream id** derived from the node id, and reuses `attach`, `detach`, `input`, `resize` and `data`:

```ts
export const shellStreamId = (nodeId: string) => `${nodeId}:shell`;
/** The node a shell stream id belongs to; undefined for a node id. */
export const shellNodeId = (streamId: string): string | undefined => ...;
```

Node ids (`n-xxxxxxxx`) contain no colon, so the two never collide. Document on the `attach` / `data` lines that `id` may be a shell stream id.

### Daemon

New module `src/daemon/shells.ts`, owned by the server (or hung off `NodeManager` as `manager.shells`, whichever keeps `server.ts` simpler). It holds `Map<nodeId, PtySession>` and emits `data` with the stream id. Roughly:

- `attach(nodeId, cols, rows): Promise<string>`: refuse an unknown node or a non-agent node (`isAgentKind`); spawn if there is no live shell (`PtySession.spawn`, which already refuses a missing directory); resize; flush; return the snapshot. Same contract as `manager.attach`.
- `input(nodeId, data, binary)`, `resize(nodeId, cols, rows)`: forward to the session if there is one. No interrupt-key detection; that is agent status logic.
- `kill(nodeId)`, `killAll()`.
- On the session's exit: drop it from the map and emit the "shell exited" line as `data`.

`server.ts`:

- In `attach`, `detach`, `input` and `resize`, route ids where `shellNodeId(m.id)` is defined to the shell module; node ids go to `manager` as before. An `attach` refusal (unknown node, missing directory) sends `{ t: 'error', message, id }`.
- Subscribe the existing per-client `data` forwarding (with its `MAX_BUFFERED_BYTES` stall check) to shell output too.
- `stall` and `resync` look up the session through a small `streamSession(id)` helper that resolves either kind, so a stalled shell view resyncs to its own screen instead of a blank one.
- On `manager` `removed`: kill that node's shell and drop its stream id from every client's `attached` and `stalled`.
- Kill all shells in the shutdown path, next to `manager.shutdown`.

Do not make `manager.session(id)` resolve shell ids: MCP `read` / `write` and messaging use it, and that would hand agents the human's shell.

### UI

- **Pane state (`ui/store.ts`):** add `shellOpen` beside `diffOpen` and `transcriptOpen` (global, like them, so the chosen pane sticks while switching nodes). `showPane` takes `'agent' | 'diff' | 'transcript' | 'shell'` and sets all three flags. Rename the `'terminal'` pane key to `'agent'` at its call sites, since "terminal" now means the shell.
- **Tabs (`ui/TitleBar.tsx`):** order Agent, Diff, Transcript, Terminal. The first tab is labelled "Agent" for agent nodes and stays "Terminal" for terminal nodes. The Terminal (shell) tab shows only for agent nodes, so a terminal node keeps its single tab.
- **Pane (`ui/TerminalPane.tsx`, `ui/App.tsx`):** when `shellOpen` and the selected node is an agent, show a `TermView` for `shellStreamId(selected)` instead of the node's own. The existing per-id xterm cache in `ui/terminals.ts` works as is with stream ids; Shift+Enter is sent as plain Enter because `isAgentNode` is false for a stream id. While the shell is shown, do not render the transcript, diff or `ExitedCard` overlays. Focus the shell's xterm when its tab is chosen.
- **Mock daemon (`ui/mock-server.mjs`):** answer a shell stream attach and echo input, so `npm run ui:dev` without a real daemon shows the tab working.

### Suggested commands

An agent puts a command in front of the human instead of asking them to copy it from the conversation.

**MCP tool** `suggest_command`, one entry in the `tools` table in `src/daemon/mcp.ts`. Pi and Codex reach the same MCP server, so every harness gets it.

- Input: `{ command: string; why?: string }`. `command` must be a single line of printable characters (no `\n`, `\r`, `\t` or other control characters, including escape sequences), 1 to 2000 characters; `why` is at most 200 characters and shown as a tooltip. Anything else is refused with an error the agent can read.
- Agent callers only (refused for `human`), and only into the caller's own node: no target id, so a node cannot plant commands on another node.
- Refused for a terminal node, which has no shell tab.
- Stores `{ command, why, at }` on the node's runtime (not the registry, so it does not survive a restart), replacing any earlier suggestion from that node, and emits the node.
- Returns text the agent can rely on: "Suggested in the human's Terminal tab. They may run it, edit it or ignore it, and you will not see the output."
- The description says when to use it: when the human should run a command themselves (they asked to run it, it needs their credentials or judgment, or it would waste tokens through the agent), not for commands the agent should run with its own tools.

**Protocol:** `NodeView` gains `suggestion?: { command: string; why?: string; at: number }`, filled in `manager.view`. It reaches clients through the existing `node` broadcast; no new server message. Clearing it is a new client message, `{ t: 'suggestion'; id: string; action: 'insert' | 'dismiss' }`. The daemon clears the suggestion either way and, for `insert`, writes the command to that node's shell (below); the UI never sends the text itself, so what reaches the PTY is always the validated string.

**When it clears:** insert, dismiss, a newer suggestion from the same node, or the node closing. A daemon restart loses it.

**Insert:** the daemon writes the command to the node's shell with no trailing newline. It is refused (error to the client, suggestion kept) when there is no shell yet or the shell has not printed any output since it was spawned: a login shell still loading its rc files can swallow or misorder typed-ahead text. `NodeView` also gains `shellReady?: true`, set (and the node emitted) on the shell's first output and cleared when it exits; the UI keeps Insert disabled until it is set. The server check is the authoritative one.

**Badges:** a pending suggestion must be visible without opening the node.

- Sidebar (`ui/sidebar/NodeRow.tsx`): a "suggested command" badge on the node's row, next to the unread dot. A collapsed parent shows it when a hidden descendant has one, as it does for unread.
- Title bar: a dot on the Terminal tab while that node has a suggestion.
- Terminal tab: a strip above the shell, `Agent suggests: <command>` with Insert and Dismiss, `why` as its tooltip. Long commands truncate with the full text in the tooltip. The strip shows as soon as the tab opens, including before the lazily spawned shell is ready.

**System prompt:** one sentence in `systemPrompt` (`src/daemon/launch.ts`) next to the other tool guidance: when you want the human to run a command themselves, call `suggest_command` rather than asking them to copy it. The tool description carries the details.

### Docs

Add a short section to `docs/frontends.md` describing the Agent / Terminal tabs, what the shell's directory and environment are, that it does not survive a reload, and how suggested commands appear and are inserted. Mention in `docs/messaging.md` (where terminal-node `write` is described) that agents cannot reach a node's shell and can only suggest commands for it.

## Tests

Daemon (`src/daemon/shells.test.ts`, or in `server.test.ts` with a temporary home and ephemeral port):

- The first attach to a shell stream spawns one shell in the node's `cwd` (worktree path for a worktree node); a second attach reuses it.
- The shell's environment has no `TL_NODE_ID` / `TL_TOKEN_FILE`, so `tl` in it would act as the human.
- Attaching to a terminal node's shell stream, or an unknown node's, is refused with an error and spawns nothing.
- Closing the node kills its shell.
- MCP `write` and `read` with a shell stream id are refused.
- The shell exiting leaves no session; the next attach spawns a new one.
- `suggest_command` stores the suggestion on the caller's node and it appears in that node's view; a second call replaces it.
- `suggest_command` refuses multi-line text, control characters and escape sequences (an injected `\n` would run the command), a human caller and a terminal node.
- A suggestion made before the shell exists survives until the tab is opened.
- `insert` writes exactly the command with no newline and clears the suggestion; `dismiss` clears it without writing; `insert` before the shell's first output is refused and keeps the suggestion.

UI (Vitest beside the components):

- An agent node shows Agent / Terminal tabs (plus Diff / Transcript when they apply); a terminal node shows no Agent label and no shell tab.
- Choosing Terminal attaches to `<id>:shell`, and the agent's pane overlays are not rendered over it.
- A node with a suggestion shows the sidebar badge (and its collapsed parent does), the Terminal tab dot and the strip; Insert is disabled until the shell is ready.

## Out of scope

Several shells per node, a shell for archived nodes, keeping shells across daemon restarts, agents reading or typing into the shell, multi-line suggestions, suggesting into another node's shell, telling the agent whether the human ran a suggestion, and a configurable shell command beyond `$SHELL`.
