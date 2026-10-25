# Sessions, restart and resume

A tree is a root node and everything under it. This document covers what survives a restart of a node, of the daemon or of the machine, and how. The design behind the session directory is in [design/artifacts-plan.md](design/artifacts-plan.md).

## Session directories

Each tree gets a directory, `~/.tiller/sessions/<rootId>/`, created when the root launches. Every node in the tree has its path in the environment variable `TL_SESSION_DIR`, a sentence in its system prompt telling it to keep notes that must outlive its context there, with `handoff.md` as the current state of the work, and permission to write there without prompting. The directory is keyed by the root's id, not by Claude's session id, so it survives a node restart, `tl reload` and a reboot, unlike Claude's own scratchpad under `/tmp`. A `meta.json` in it records the root's title, directory and creation time, so the files remain identifiable after the root is gone.

`tl sessions` lists the directories with title, age, size and whether the root is closed, and `tl sessions path [id]` prints a tree's directory (by default this node's, or the orchestrator's for the current directory).

## Cleanup

When a root is closed, its `meta.json` gets `closedAt`. On daemon start and once a day, the daemon deletes the directories whose root closed more than `daemon.sessionsKeepDays` (default 14) ago, and those whose root is gone and that nothing has written to for that long. `tl sessions clean` runs that sweep now.

Memory is not swept with the session directories. When [memory](memory.md) is on, the daemon keeps it in `~/.tiller/memory/<account>.db`, one file per Claude account (`_default.db` for no account), bounded by `memory.maxMB` instead of by age. It records no message text and does not read `events.jsonl` or `archive.jsonl`.

A memory [gardener](memory.md#gardener) run is an ordinary root node, so its session directory and archived record follow this sweep like any other tree's. Claude is not given the directory: the gardener gets no `TL_SESSION_DIR` and no permission to write there. The node stays in the tree, exited, until the next run for its repository closes it or you do. The sweep counts from that close.

## The event log

The daemon appends one JSON line per event to `events.jsonl` in the tree's directory: spawn, close, state changes, report_outcome, each send (the human's, nodes' and the daemon's own notices) with its outcome and text, each completion-gate run (`gate`: whether it passed, the command and the attempt number, never its output, and logged whether or not memory is on), the final outcome (`settle`) of a send that was queued, withdraw, restart, resume, merge, the arming, queueing, release and launch of held spawns, and a cost snapshot at most once a minute per node. `tl log [id] [--since 2h] [--follow]` prints it; a non-root id shows only that node's events. Message text is kept here, on this machine, so the Transcript tab can show a node's conversations with its parent, its children and its peers, for closed nodes too. Agents in the tree can write this file, so the daemon checks each event's shape when it reads them and shows their text only as plain text.

## The away digest

When the app or a browser tab regains focus after more than `daemon.digestAfterMinutes` (default 10) with no focused window, it gets a "While you were away" card built from the event log. It lists, per node, what still needs you, what errored or failed and what finished, with the outcome lines; clicking a row selects the node.

## Restarting a node

`tl restart <id>` (also the Restart action in the app) kills a node's process and relaunches it under a new Claude session id, so a Claude node starts with an empty context while keeping its id, title, directory, role and children. A model or effort chosen at spawn (an explicit argument, the app's model field, or a preset) is kept; one that came from config is resolved again from the current config, so a config edit reaches the node on its next restart (unset now means the harness's default). Nodes recorded before this distinction count as config-resolved, except for what their preset sets (both are kept when the preset can no longer be loaded). Resuming nodes after a daemon restart does not re-resolve them. The previous session ids are kept on the node record as `previousSessions` (the newest 10). `--prompt T` (or the text field in the app's Restart dialog) gives the restarted node a first prompt; without one, a node whose tree has a `handoff.md` is told to read it first. Agents cannot restart nodes.

Live orchestrators are protected from being closed by accident. Agents cannot close them, the app offers Restart instead of Kill for them, and `tl kill <id>` on a root refuses with a hint; `tl kill --force <id>` overrides that. Once the process has exited, the app's exited card and Restart dialog also offer **Close**, which explicitly closes the root without restarting it. Children are kept. Worktree nodes still require the usual safe-close, Keep branch or Discard choice.

`tl resume <id>` relaunches an exited Claude node with its previous conversation (`claude --resume`). It refuses an armed or queued node, which launches by itself; close it to drop it.

## History, follow-up and fork

The app's **Change harness…** action also starts a fresh context on an existing agent, including a
root. It preserves the node and workspace, resets launch overrides to the target harness's
defaults, and retains the previous session's harness and transcript location. See
[changing harness](harnesses.md#change-an-existing-agents-harness) for confirmation and failure behavior.

After a harness change, restart continues with the currently selected harness and resume resumes
only its current conversation. Each recorded historical session retains its own decoder and
location, including after another restart or node close. The newest ten previous session IDs
remain selectable, matching restart's existing retention limit; changing harness never deletes
transcript files. A follow-up continues only the archived node's final harness/session and owns
copies of its recorded readable history in the new tree. Older segments are read-only history,
not native contexts to resume across harnesses. Codex native thread IDs remain in Codex transcript
headers, separate from the public Tiller session IDs in the picker and API.

Closing a Claude node (close, kill, prune, or closing its root) appends one line for it to `archive.jsonl` in the tree's session directory: its title, directory, model, effort, role, first prompt, session ids, transcript path, last message, reported outcome, spend, and for a worktree node its branch with what close did to it (merged into its base, kept with a WIP commit, or discarded). A one-line `brief` (at most 200 characters) sums up what the node did and how it ended, from its outcome's summary or note, else its last message, else its first prompt, followed by the branch's fate. Terminal nodes, and Claude nodes that never launched, are not archived. The archive goes with the session directory when the sweep deletes it. Agents can write to the session directory, so `archive.jsonl` is advisory data: the daemon takes a line's tree from the directory it sits in, never from the line, but trusts the rest of it (such as the transcript path).

`tl history [--root ID] [QUERY]` lists the closed nodes, newest first, of one tree or all, keeping those whose title, first prompt or last message contains QUERY. The agents' `history` tool lists their own tree's in the same terse form, so an orchestrator can find a closed worker; its `read` tool reads a closed node of its own tree too. `tl transcript <id> [--session SID]` prints a live or closed node's conversation; SID picks one of its earlier sessions, read from the same directory as the current transcript, since Claude keeps every session of a project there.

`tl followup <id> --prompt P [--title T]` continues a closed node's session as a new node (`claude --resume <session> -- P`), with the same title unless T is given, and the same model, effort and role. It goes under the closed node's parent while that is live, else it becomes a root; it starts in the closed node's directory, or in the main checkout when that was a worktree since removed. The new node records `followupOf`. A second follow-up of the same session is refused while the first is live. A follow-up runs in the closed node's [Claude account](harnesses.md#claude-accounts), which must still be configured.

`tl spawn --fork ID ...` (the `fork` argument of the spawn tool) starts a new Claude node from a copy of another node's conversation (`claude --resume <session> --fork-session --session-id <new>`), then gives it the prompt; the source keeps its own session. The source may be live or closed, but must have started a session; an agent may fork only a node in its scope or a closed node of its own tree. The directory defaults to the source's, and the new node records `forkOf`. A fork stays in the source's [Claude account](harnesses.md#claude-accounts): a human root fork without an account takes the source's, and a fork whose new node would run in another account is refused. Claude finds a session only in its own account's home, and conversations do not move between accounts.

## Resume on daemon start

The daemon records which nodes are live in `state.json`. When it starts, after a crash, a kill, a reboot or `tl reload`, it resumes them, parents first. Armed and queued nodes are not resumed; they stay held and launch by themselves. It skips nodes that no longer exist, nodes whose worktree is missing and nodes idle for more than `daemon.resumeMaxAgeDays` (default 3), and logs one summary line. Setting `daemon.resumeOnStart` to false turns this off. `tl stop` is the "do not come back" switch: it clears the live set, so the next start resumes nothing.

`tl reload` works from inside a node's terminal too: a detached helper stops the daemon (keeping its live set) and starts a new one, which resumes the nodes itself. Each step is logged to `daemon.log` with a `tl reload:` prefix. If no daemon is running it just starts one.

### Waiting for turns to end

Before it stops the daemon, `tl reload` waits until no agent node is working, so a restart does not cut a worker off halfway through an edit. While it waits, the daemon holds every message delivery, its own notices included, so idle nodes do not start new turns, and it queues new agent spawns as "queued: the daemon is waiting to restart" (see [messaging](messaging.md#held-for-a-restart)). The command prints which nodes it waits for and updates the line as they finish. A node whose mod claimed a message in the last 30 seconds and has not yet confirmed it counts as working, since its turn is about to start. Nodes that are blocked on a permission prompt, waiting on a question, or idle do not count, and a node that runs `tl reload` itself is left out, since its own command is what waits. There is no time limit. `tl reload --now` restarts at once, and Ctrl-C stops waiting without restarting and releases what was held. The hold also ends by itself 15 seconds after the waiting command stops polling the daemon, so a command that dies cannot leave messages held.

`tl update` and the app's update action wait the same way, but only for the restart: the fast-forward and the builds run while agents keep working. While an update waits, the app's status bar shows "Waiting for N agents to finish their turn" with a **Restart now** button, which ends the wait; `tl update --now` skips it. The update's progress is logged to `update.log`.

### Telling interrupted nodes to continue

Each node record keeps `midTurn` while a turn is in progress (working, waiting on a question, or blocked on a permission prompt), and `state.json` records why the daemon stopped. Because both are saved as they change, a crash or a kill is covered as well as a clean stop. When the new daemon resumes a node whose turn was cut off, it queues one message to it through the inbox, behind any message already queued for it:

```
The tiller daemon restarted (tl reload) while your turn was running, so that turn was cut off. Your conversation is intact, but the last tool call may not have finished. Check where you were, for example with git status and the commands you last ran, then continue the task.
```

The reason in parentheses is `tl reload`, `update to vX.Y.Z`, `the daemon was stopped` (a plain SIGTERM, for example from launchd) or `unexpected exit` (a crash or a kill). Only resumed agent nodes get it: not terminals, not nodes that were idle or done, and not nodes the resume skipped. The daemon clears every `midTurn` once it has resumed the live set, so each restart sends the message at most once. Claude, Pi and Codex nodes all receive it, since each one's bridge polls the inbox as soon as it starts.

## Autostart

`tl autostart on` installs a launchd user agent, `~/Library/LaunchAgents/com.tiller.daemon.plist`, that starts the daemon at login, so the nodes come back after a reboot without opening the app, and starts it again if it crashes; `tl stop` exits cleanly and launchd leaves it stopped. With autostart on, `tl reload` starts the new daemon through launchd. `tl autostart off` removes the agent (stopping the daemon if launchd started it), and `tl autostart status` says whether it is installed and loaded. Turning it on while a daemon is running leaves that daemon alone: the agent's first launch finds the port taken and exits, and the next `tl reload` or login hands the daemon to launchd.
