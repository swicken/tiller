# Memory

Memory lets later nodes learn from earlier work in the same repository: what was done, which commands verified it, which gate failures happened and how they were fixed, what was left open, and what the human wants every node to know. The daemon records it from its own state and shows a short digest to each node at launch. Agents search the rest on demand.

**Memory is off by default.** Until you opt in, the daemon creates no memory file, records nothing, adds nothing to any prompt and runs no extra git command. The `# Memory` section and the memory tools described here appear only for nodes where memory is on.

## Turning memory on

You opt in from the home file (`~/.tiller/config.json`, under `TL_HOME` when set), at one of three scopes:

- **Global:** `memory.enabled: true`.
- **Per account:** `claude.accounts[].memory: true`.
- **Per project:** an entry in `memory.projects`, `{ "path": "/repo", "enabled": true }`.

`tl memory on|off|inherit` edits these for you:

```sh
tl memory on                          # global memory.enabled
tl memory on --account work           # that account's memory flag
tl memory off --project ~/code/repo   # a memory.projects entry
tl memory inherit --project ~/code/repo   # remove the setting
```

`inherit` removes the setting at that scope. `--account` and `--project` together are refused. Only the human can change the switch: an agent calling `tl memory on` with its node token is refused.

**Settings → Memory** does the same from the app. At global scope it has the `memory.enabled` switch (labelled *Memory (global)*; *Use inherited default* removes the setting), one select per configured account (labelled *Memory for <account>*: *No account setting*, *On*, or *Off (a ceiling: no repository setting turns it on)*) and `memory.maxMB` (16 or more). At repository scope it has *Memory for this repository*: Inherit, On or Off, which is written to the **home** file's `memory.projects` under the repository's exact path, as `claude.account` is, and not to the repository file. Each opt-in change is the same write as the matching `tl memory` command (`memory.maxMB` has no `tl` equivalent). A repository file's `memory.enabled: false` stays JSON-only: edit `<repo>/.tiller/config.json` yourself, and Settings names it in the status line when it decides. The status line is the `source` the daemon reports, so Settings never re-implements the rules below. At repository scope it reads "Memory is on for root nodes here (account work): <source>.", labelled per account because a node in another account can resolve differently; at global scope, "The global setting is on (<source>)."; when `claude.accounts` is invalid, the repository line reads "Memory is off for root nodes here: account unknown: <the list's error>.", because the repository's account cannot be told.

### Which setting wins

For a node, the first rule that matches decides:

1. The project's own `.tiller/config.json` has `memory.enabled: false`: off. A project file can only turn memory down; `true` there is ignored with a warning, because an agent can edit its project file.
2. The node's account has `memory: false`: off. This is a **ceiling**: no project entry can lift it, so an employer's account stays off whatever a project says. A node with no account of its own uses the account named by `claude.account`, if any. With an invalid `claude.accounts` list, named accounts fail closed (off).
3. The longest `memory.projects` entry whose path contains the node's project: its `enabled`.
4. The account has `memory: true`: on.
5. `memory.enabled` in the home file, else off.

`tl memory status` shows the result for the current directory's project (the main checkout, for a worktree) and which setting decided it. With `--node ID` it shows that node's project instead, and with `--repo PATH` a directory's; `--account` picks the account. Nodes already running when you turn memory on start recording at their next event; a digest is only added to a launch after that. Turning memory off stops recording and digests at once, and does not delete anything.

A tree's nodes share a project (the main checkout, for a worktree node) and an account, so they all resolve alike.

## What is recorded

The daemon captures facts at its own call sites, never by reading files an agent can write:

- a node's first launch (its kind, harness, model, role, preset and parent);
- each `report_outcome`: the summary, changed files, `verified` and open questions;
- each gate run: whether it passed, the command, and for a failure the last 2,000 characters of output;
- each merge, and each human send (that it happened, never its text);
- each close: spend, branch fate and the outcome, which becomes one entry in the repository's work history.

From these it derives **items**, each with a stable id like `m12`:

| Kind | What it is |
| --- | --- |
| `ledger` | One line per closed node: title, verdict, gate state, branch fate and a brief. |
| `open_question` | A question a node's outcome left open. |
| `procedure` | A command from a successful outcome's `verified` field that passes the safe-command filter below. |
| `pitfall` | A gate failure, with a note on its fix when a later run passed (below). |
| `note` | A lesson an agent added with `memory_add`, or the human's pinned text (see Pins). |

**A pitfall's fix note.** When a node's gate failed and later passed, the pitfall's body ends with `Fixed by <node>: the gate passed on attempt N.` and, when the outcome reported changed files, `Files it reported changing: a, b, c`. The daemon knows the node and the attempt. The files are the agent's own report, so at most five are listed, each on one line and cut at 120 characters; this is acceptable because a pitfall already counts as agent text under the trust rules below. The outcome's summary describes the task rather than the fix, so it is not copied. The daemon cannot know what the fix was: an agent that does records it with `memory_add pitfall`.

**Pins.** There is no `pin` kind: a pin is a flag on an item. Pinning by id (`tl memory pin mID`) pins an existing item and restores it if retracted; pinning agent or daemon text makes it an instruction every node in the repository follows, so the panel asks first. Pinning new text (`tl memory pin --text`) creates a human `note` under its own `PIN:` key, so it never collides with a plain note of the same words. Unpinning by id retracts a text pin, as unpinning by text does. The panel can edit a text pin you wrote (**Edit…**). Editing writes the new text as a pin that supersedes the old one and unpins the old one; if the new text is an earlier, unpinned pin's, that pin comes back, and text that is already pinned is refused ("already pinned as mN"). The old text stays out of every digest until you pin it again, which `pin --text <old text>` does, because that is yours to decide. An agent cannot pin, and re-deriving never touches pins. An agent's `memory_add note` of the old text makes a separate, unpinned note under the normal eligibility rule.

The procedure filter is an allowlist: only plain test, build, check and read-only commands of common tools (`npm test`, `cargo test`, `git diff`, `tl status` and the like). Anything with a pipe, redirect, `;`, `&`, `$(`, a backtick or an inline-code flag such as `-e` or `-c`, and anything that fetches code (`npx` of an unlisted tool, `npm install`, `pip install`, `cargo install`) is dropped.

### What is never stored

Message text, transcripts, `handoff.md` and hook payloads are never stored. Message text stays where it already is, in the session's event log. Before anything is derived or written, known secret formats are replaced with `[redacted]`: private-key blocks, AWS, GitHub, Anthropic, OpenAI, Slack and Google keys, JWTs, `Bearer` and `Basic` credentials, passwords in URLs, and `password=`, `secret=`, `token=` and `api_key=` assignments. This is a pattern list, not a guarantee; see [Residual risks](#residual-risks).

## What nodes are told

With memory on, a node's system prompt ends with a `# Memory` section built at launch (see [agent-roles.md](agent-roles.md#the-system-prompt)). It opens with a paragraph saying which part is instruction and which is data, then lists items one per line with id, age, node, harness and who said it:

- **Pinned by the human:** your standing instructions. The only part a node is told to follow.
- Orchestrators also get *Recent work*, *Raised recently, may be resolved*, *Verification that has worked*, *Pitfalls* and *Notes from agents*, up to about 6,000 characters.
- Workers get the pins plus the items that best match their brief, up to about 2,400 characters.
- Reviewers and explorers get the pins and verification that has worked, up to about 1,800 characters.

A digest is decided once per session and then **frozen**: a resume, a `tl reload` and a follow-up reuse the same text, so the prompt stays the same and the prompt cache is not broken. A node launched before memory was on, or whose frozen digest was purged, gets none on resume. Each line collapses control characters and is cut at 300 characters, so an item cannot open a heading or pose as a Tiller message frame.

`memory.digest` sets whether launches get the digest: `on` (the default once memory is on), `off` (capture and tools only), or `ab`, which gives it to half the nodes by a hash of the node id and records what the other half would have seen, so `tl memory status` can compare the two. A project file can only move this toward `off`.

## Trust model

Capturing at the daemon proves where text came from, not that it is true. So:

- **Only human pins are instructions.** Everything else is shown as background data under a header that says so.
- **Agent text reaches a prompt only from a node that succeeded.** An item is digest-eligible when the human or the daemon wrote it, or its node is the tree's root, or that node's latest outcome is `succeeded` with the gate not failed. Everything else is found only by `memory_search`. This covers outcome fields, notes and gate output alike.
- **A failed node contributes daemon facts only:** date, node id, harness, title, verdict, gate state and branch fate. For an unresolved gate failure, only the command, the daemon's own exit line and an error code such as `TS2345`. Its summary and the failing output stay in the item's body and are never pushed.
- **Each line says who said it.** An agent's item shows the node, harness and model; `· daemon` marks text made only of daemon facts.
- **Agent retractions are not sticky; human ones are.** A node's `memory_forget` hides an item until later work records the same thing again, which revives it. The human's `tl memory forget` is permanent, as is a human supersede. Agents cannot retract, supersede or purge a pin.
- **The [gardener](#gardener), when you turn it on, hides items but cannot write text.** It sees only digest-eligible items, never touches pins, the human's items or ledger lines, and every hide can be undone.
- **Caps:** an item's text is at most 300 characters and its body 2,000; a node may add 20 items and forget 20.

## Tools and commands

Every agent node with memory on gets these tools through the daemon's MCP server, on Claude, Codex and Pi alike:

| Tool | Who | What it does |
| --- | --- | --- |
| `memory_search` | all | Plain-words search over the repository's items. |
| `memory_get` | all | One item in full, with who recorded it and whether it was retracted. |
| `memory_add` | all | Record a `procedure`, `pitfall` or `note`; it is shown later only if the node reports success. |
| `memory_forget` | all | Hide an item with a reason. Purging is human only. |
| `memory_pin` | human | Pin a new instruction, or pin, unpin or restore an item. |
| `memory_status` | human | File health, size against the limit, the on/off resolution, the digest comparison, and per file the gardener's 30-day spend, paused repositories and newest runs. Takes `repo` (an absolute directory) or `nodeId` for a project; an agent calling the tool at all is refused. |
| `memory_switch` | human | What `tl memory on|off|inherit` calls. |
| `memory_garden` | human | What `tl memory garden` calls: the [gardener](#gardener)'s status, a manual run, a run's actions and undo. |

An agent's repository and account always come from its own node record; naming another is refused. While memory is off the tools answer "memory is off for this project", saying how to turn it on.

The human's side is `tl memory`:

```
tl memory on|off|inherit [--account NAME | --project PATH]
tl memory status [--days N] [--node ID] [--repo PATH] [--account NAME]
tl memory search QUERY [--kind K] [--all] [--repo PATH] [--account NAME]
tl memory show mID
tl memory add KIND TEXT [--body B] [--supersedes mID]
tl memory forget mID REASON [--purge]
tl memory pin (mID | --text TEXT) [--unpin]
tl memory garden [status] | run --repo PATH [--wait] | show rN | undo (rN [--immune] | mID)
```

`memory_status` resolves `repo` the way the other tools do, without the opt-in gate: the main checkout of that directory, and the account of its project unless `account` is given. It prints `memory is on|off for <main checkout> (<source>)`. The CLI passes its own directory, so `tl memory status` and the tool always agree. `nodeId` wins over `repo` when both are given. With neither, it prints `memory.enabled (global)`, `projects with their own setting` and `accounts`. It prints "no memory file yet" only when `~/.tiller/memory` holds no `*.db` file, and then says one is created at the first capture after memory is on for a project.

`forget --purge` removes an item for good: its text and body, the other items from the same report, the report's stored data and any frozen digest that quoted it, then the freed bytes are overwritten and the file compacted. Use it for an item that holds something it should not.

## The Memory panel

The app shows what memory holds and lets you change it. Reading needs no live node and works while memory is off, because turning memory off deletes nothing. There are three ways in:

- the **Memory** tab beside Terminal, Diff and Transcript on an agent node, for that node's repository and account;
- the Memory icon in the sidebar footer (labelled Memory; it toggles the page): for the selected node's repository, or, with nothing selected, for any account file, starting on the account file's first repository, which you change with the pickers at the top of the page;
- the **Memory** button on a closed node's pane, which adds that node's *Given to this node* section.

A page reads one account's file: the header's account picker lists the files that exist, and the repository picker lists the repositories in it (each with the first path recorded for it, which is not necessarily where it lives now). **Use a directory…** names a checkout by its path. The panel asks the daemon on opening, after each of your changes, on reconnect and on Refresh, never live; a node that records something while you look shows up on the next refresh.

### Which checkout decides

Whether memory is on is a question about a directory, and two clones of one `origin` share items but can be opted in differently. So the page judges a **checkout**, takes it from the first candidate whose repository key matches, and says which one it used on the *Checkout* line:

1. the directory you chose ("chosen"), which wins over the node's;
2. the node's own checkout ("from this node"): a worktree node's main checkout, and for a closed node the main checkout of its recorded directory, or of the repository its deleted worktree was made from;
3. a live node's checkout in that repository ("a live node");
4. the first path recorded for the repository in this file ("the recorded path"), only if it still exists and still has that key.

The page uses the node's own account as it is (a node with none reads the no-account file). If a closed node's checkout is gone, the page shows its repository only when this file recorded that same path, never another repository.

With none, the page says "No checkout of this repository is known: choose its directory" and the state line reads "Memory on or off is unknown: no checkout of this repository is known; choose its directory." Changes are refused with "refused: no checkout of this repository is known; choose its directory" (or, when it is off, "refused: memory is off for <checkout> (<source>)"), and the page shows "Changes need memory on for this checkout: <source>." This fails safe: a moved or deleted checkout never inherits another clone's opt-in. The *state* line otherwise shows memory on or off for that checkout and the setting that decides it. When off, it says "Change it in Settings → Memory" in plain text. A broken file shows its state and any quarantined copies instead of an error. Changes apply to nodes launched from now on; running nodes keep the digest they were given.

### Sections

- **Items:** a search box (plain words; common words such as "the" or "src" are ignored, and the page says so when nothing matches), chips for All, Pinned, Ledger, Open questions, Procedures, Pitfalls and Notes with their counts, and *Show retracted*. Each row shows the kind, the text as plain text, who recorded it, its age and how often it was seen, and badges: *Pinned*, *Superseded by mN*, *Evicted*, *Purged*, "Retracted by the human (permanent)", "Hidden by an agent until recorded again", and *Search only* (written by a node that did not succeed, so no digest includes it). A badge for an item hidden in a way the panel has no label for reads "Hidden (<kind>) by <who>". Open a row for its body, the node that recorded it (a link, when live) and the last 20 nodes whose digest included it. Without a query the list is most recently updated first, 50 at a time with *Load more*; with one it is best match first.
- **Given to this node** (when opened from a node): that node's latest 20 launches, newest first, each with the cause and the digest text. "recorded, not given (A/B off arm)" marks the off arm of an A/B (`memory.digest: ab`); a resume shows "Reused this session's first digest.".
- **Claude Code memory:** see below.

### Changes

Each change is made as the human, refused unless memory is on for the deciding checkout, and takes effect at the next fresh launch:

- **Pin** an item (restoring it if retracted; for an agent or daemon item the panel asks first), **Pin an instruction…** (new text, up to 500 characters), **Unpin**, and **Edit** a text pin you wrote.
- **Forget**, with a reason, is permanent: agents' later work cannot bring the item back. It is never a purge.
- **Restore** brings back an item that you or an agent hid, or another item replaced. It is not offered for tombstones (evicted or purged: the text is gone), for text pins (pin the text again instead) or for items hidden in a way the panel does not know. A restored item stays pinned if it was pinned, and the button reads "Restore (stays pinned)".

**Purge is CLI-only.** It is irreversible and compacts the file, so the panel shows a command to copy instead of a button:

```sh
tl memory forget m12 '<reason>' --purge --repo '/path/to/checkout' --account work
```

The command carries `--repo` and `--account`, because item ids are per file and a purge in the wrong one deletes someone else's item. It is shown only when those flags open exactly the file on screen: `--account` is left out only for the `_default` file when that is also the project's default account. Otherwise the page explains why there is no command, and when memory is off it says purging needs memory on, because the CLI refuses then.

## Claude Code's own memory

Claude Code keeps its own auto-memory. The panel's *Claude Code memory* section shows it, **read-only**: Tiller does not import, copy, index or inject it, and none of it reaches a node through Tiller. It is a window onto files you already have, next to Tiller's own.

Claude keys that memory by the repository's **main checkout**, not by a worktree. The files are `<Claude home>/projects/<slug>/memory/*.md`, where the slug is the checkout's real path with every character outside letters and digits replaced by `-` (the same slug transcripts use), and the Claude home is `~/.claude`, or the account's `configDir` for a named account. So a Tiller worktree node at `/r/.claude/worktrees/n-1` and a plain `git worktree add` checkout both show the memory of `/r`; the `-r--claude-worktrees-n-1` directory holds transcripts only. The section names the directory it checked, so a miss is visible. `MEMORY.md` is listed first, then the topic files by name, each in a collapsible block with any front matter apart from the text.

Because the files are Claude's and Claude writes them, they are untrusted: they are rendered as Markdown with HTML skipped, only `http(s)` links and no images. They are read without following symlinks: a symlinked directory or file is skipped. At most 100 files, 64 KiB each and 1 MiB in all (counting each file's JSON-encoded size) are read; the section marks a truncated file and lists the names left out. A named account that is not configured is an error, never a fall back to `~/.claude`.

Limits: an `autoMemoryDirectory`-style override of Claude's is not followed; if Claude shortens a very long slug, the panel shows the path it checked instead; and the location for a named account (`CLAUDE_CONFIG_DIR`) is inferred from where transcripts live, not confirmed.

## Accounts and files

Memory is kept in one SQLite file per Claude account, `~/.tiller/memory/<account>.db`, in a 0700 directory with 0600 files, so accounts never see each other's memory. Nodes without an account, and nodes in an account that has no `configDir`, use `_default.db`. Codex and Pi nodes use their root's account.

**Renaming an account orphans its file.** Rename `<old>.db` to `<new>.db` (and its `-wal` and `-shm` files, when present) with the daemon stopped. Deleting a file forgets everything in that account.

`tl memory` commands use `--account`, else the account for the repository the way `tl new` picks one. A tree started with an explicit `--account` is not visible to that default, so pass `--account` then.

## Repositories

Items belong to a repository, identified by its normalized `origin` remote (scheme, credentials, trailing `.git` and case removed), so clones of one repository share memory. A repository without an `origin` is keyed by the real path of its main checkout. A move or re-clone of a remote-less repository therefore starts empty; a changed remote forks memory the same way.

Every node started in a non-git directory such as `~` shares one key, so memory opted in for `~` is shared by all of them. The orchestrator's *Recent work* also covers the whole tree it started, so an orchestrator in one repository still sees its workers' work in another.

## Size limit and eviction

`memory.maxMB` (home file, default 200, minimum 16) bounds each account's file. At about 10 KB per closed node that is years of work. The daemon checks once after it first opens a file and once a day with the session sweep, and only existing files; a daily check never creates one. Over the limit, it evicts down to 90 percent, in this order, each step stopping as soon as it is under:

1. The text of frozen digests older than 30 days. Those sessions inject nothing on resume.
2. Episode detail older than 30 days, reduced to the fields metrics need.
3. The text of retracted items older than 30 days. The id and the human's retraction stay, so citations resolve to "evicted" and a retracted item is not re-added.
4. Valid `ledger` and `open_question` items older than 30 days, least cited and used first.

Pins, procedures, pitfalls and notes are never evicted. If the file is still over the limit the daemon logs it, `tl memory status` says so, and memory keeps working. Space is returned to the disk in small steps; there is no blocking full compaction.

## Gardener

The gardener is an optional Claude node that the daemon starts by itself to tidy one repository's memory. It merges items that say the same thing and hides items that a newer item makes obsolete, so digests repeat less. **It is off by default.** It writes no text of its own, cannot touch pins or the human's items, and every change it makes can be undone.

### What it does and does not do

A run sees the repository's live, digest-eligible `open_question`, `procedure`, `pitfall` and `note` items: the newest 300, plus every item the daemon proposes as a likely duplicate or replacement. It can do two things:

- **Merge** 2 to 8 items of one kind. The daemon, not the model, picks the item to keep: a pinned item first, then the human's over the daemon's over an agent's, then the most seen, then the oldest. The others are hidden as `merged`, and their `seen` counts are added to the kept item, unless it is pinned or the human's (those rows are never written). When later work records a merged item again, the kept item is counted instead and the merged one stays hidden.
- **Supersede** an item with a newer one: a question that a later work-history line answers, or a command or pitfall that a newer one replaced. The old item is hidden as `gardener`. If later work records it again, it comes back, as it would after an agent's retraction.

It never forgets an item outright: stale is not the same as wrong, and the size limit already handles growth. It never edits or writes item text. It never hides a pin, the human's item or a `ledger` line, and it is never shown an item from a node that did not succeed. Each change carries a reason of at most 200 characters, shown by `memory_get` ("merged into m12 by the gardener (r12): <reason>") and `tl memory garden show`.

### Turning it on

```json
{ "memory": { "enabled": true, "gardener": { "enabled": true } } }
```

The `memory.gardener` keys are read from the home file only. In a project file they are ignored with a warning, because an agent can edit its project file. Memory must also be on for the repository and account. The keys and their defaults are listed in [config.md](config.md#keys). Settings does not show them.

`claude.accounts[].gardener: false` is a ceiling, like `memory: false`: it blocks every run for that account's file, scheduled or manual.

### When it runs

The daemon checks every hour, and once more a minute after the last node closes. A repository in an account's file gets a run when all of these hold:

- `memory.gardener.enabled` is true, the account has no `gardener: false`, and memory is on for the repository and account;
- its last run started at least 24 hours ago (not configurable);
- at least `memory.gardener.minNewItems` (default 25) new gardenable items, and at least 3 daemon proposals that involve a new item (a likely duplicate group, or an item a newer one may replace);
- the account's gardener spend over the last 30 days, plus one full `maxUsdPerRun`, fits within `maxUsdPer30Days`;
- the daemon is quiet: no node working or queued, not draining, live nodes below `daemon.maxLiveNodes`, and the account's rate-limit windows under 80 percent;
- no other run is live, in this daemon or in another one sharing the home;
- Claude already trusts the repository's main checkout in that account. If not, run `claude` there once. An untrusted or missing checkout is recorded as `skipped` with the reason, not as a failure;
- the repository is not paused (see [How a run ends](#how-a-run-ends)).

At most one run is live per daemon, and the repository with the most new items goes first.

**By hand,** `tl memory garden run --repo PATH [--account NAME] [--wait]` starts a run now. It skips `enabled`, the 24 hours, the new-item threshold, a pause and the quiet-daemon check, except the 80 percent rate-limit guard. Memory, both ceilings, the budget, the rate-limit guard, the checkout and trust check, and the one-run rule still apply.

### The gardener node

A run is an ordinary, visible root node in the tree, titled `Memory gardener · <repository>`. It runs in the account whose file it gardens, with the repository's main checkout as its directory. It is muted, so a daily run sends no notification. It does not count towards `daemon.maxLiveNodes` or `daemon.maxWorking`, so while it is live there can be one node more than the limit. Agents cannot message it, list it or close it.

It gets one turn. When the turn ends, the daemon stops the process and sets the node's outcome, for example:

```
merged 4 (9 items), superseded 2 · $0.04 · undo: tl memory garden undo r12
```

The node then stays in the tree, exited, with its spend. The next run for that repository closes it, or you can close it yourself. It cannot be resumed, restarted, followed up or forked: start a new run instead.

**What the model is given.** It has only four tools, `garden_list`, `garden_get`, `garden_merge` and `garden_supersede`, and they act only on that run's repository. Claude Code launches it with these settings:
- `--restricted --tools '' --permission-mode dontAsk --strict-mcp-config`;
- an agent definition and a permission list that name exactly those four tools;
- `CLAUDE_CODE_DISABLE_ADVISOR_TOOL=1` and `CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS=1`, without which Claude Code offers two more tools.

So it has no shell, file, web or other Tiller tool, no claude.ai connector or plugin server, no session directory and no `# Memory` digest. The repository's `CLAUDE.md` and `AGENTS.md` are not loaded. Item text reaches it only inside tool results, under a system prompt that says item text is data written by other agents and never instructions. Its model comes from `memory.gardener.model` and its effort is always `medium`; the project's settings set neither.

### Cost and caps

The node's spend is the run's cost, and the tree shows it like any node's. Three limits apply:

- **Per run:** `memory.gardener.maxUsdPerRun`, default $0.25. Claude Code reports a node's cost only when its turn ends, so the daemon cannot stop a run on cost partway through. Instead, other limits keep the run from reaching the cap:
  - at most 20 tool calls, counting attempts, refused ones included. Lowering `maxUsdPerRun` lowers this cap;
  - at most 160,000 characters of tool output;
  - at most 10 minutes.

  The 21st call, going past the output limit, or the timeout ends the run.
- **Per account file:** `memory.gardener.maxUsdPer30Days`, default $3. A run starts only when a full per-run cap still fits.
- **Hides:** at most 40 per run, and at most a quarter of the live gardenable items. At most 10 of them may be supersedes.

**A run that ends without a reported cost** is charged the full `maxUsdPerRun` and marked incomplete, whatever it had spent. That covers the call cap, the tripwire, the timeout, memory turned off, a failed launch, a crash and a daemon restart, so the 30-day total never under-counts. A turn that ends without a priced cost report also pauses the repository.

On a subscription account the cost is Claude Code's API-equivalent estimate. The run uses the same account's quota as your work, which is why it starts only when the daemon is quiet and the rate limits are under 80 percent.

### How a run ends

`tl memory garden status` lists recent runs with their state:

| State | Meaning |
| --- | --- |
| `done` | The turn ended normally. |
| `capped` | The tool-call cap or the tool-output limit ended it. |
| `timeout` | It ran for 10 minutes. |
| `off` | Memory was turned off for the repository or account during the run. |
| `disabled` | `memory.gardener.enabled` was turned off during a scheduled run, or the account's `gardener: false` was set during any run. |
| `interrupted` | The daemon stopped, restarted or crashed during the run, or you closed the gardener node while it ran. Its changes are kept, not undone. |
| `failed` | The tripwire fired: the model tried a tool other than its four. The run's changes are undone. |
| `reverted` | The check after the run found a violation, or could not run, and the run's changes were undone. |
| `skipped` | It never started, because the checkout was missing or not trusted. |

After every run, crashed ones included, the daemon checks that:
- every hidden item has a logged action and was allowed to be hidden;
- every merge chain ends on a live item;
- the caps held;
- the orchestrator digest kept every pin;
- no item the human retracted came back.

A violation undoes the whole run.

**Pause.** A repository's scheduled runs pause in two cases: two consecutive runs end `failed`, `capped`, `timeout` or `reverted`, or a `done` run's cost report is missing. They resume after a manual run succeeds. `tl memory garden status` says so: "paused after 2 failed runs (last: capped)". `off`, `disabled` and `interrupted` runs neither count towards a pause nor reset the count.

**Two daemons on one home** never garden one file at the same time. A live run holds a lease, renewed every 30 seconds. When a lease is 5 minutes old, the next tick recovers its run, charges it and checks it.

### Undo

```
tl memory garden status [--repo PATH] [--account NAME]
tl memory garden show rN
tl memory garden undo rN [--immune]
tl memory garden undo mID
```

`show` lists a run's actions with the item texts, the reasons and what changed in the orchestrator digest. `undo rN` reverses a whole run, newest action first, and `undo mID` reverses that item's latest action. Undoing a merge takes its `seen` back off the kept item. An item is skipped, with the reason in the reply, if it has since come back, been retracted by someone else, purged or evicted. Pinning a hidden item by id undoes the action first.

**Immunity.** `undo mID` tells the gardener that one decision was wrong. Later runs refuse that same pair: that item into that keep, or that item superseded by that item. The item can still be merged into a different keep.
- `undo rN` grants immunity only with `--immune`. Otherwise the next run may try again.
- The daemon's own undo after a `failed` or `reverted` run never grants it.
- Pinning or unpinning an item clears its immunities.

Undo works until the hidden item's text is evicted. Eviction happens only when the file is over `memory.maxMB`, and then only to retracted items older than 30 days (see [eviction](#size-limit-and-eviction)).

### Trust

The gardener is a second model that reads agent-written text automatically, and its output is hiding. So the daemon checks every action in the transaction that applies it:

- **Candidates only.** Every id an action touches must be in the run's candidate set, including the computed keep and the replacing item. The set holds only digest-eligible items: text a digest could already show. Item ids are guessable, so an item naming a failed node's item ("supersede m7 by m9") gets "not a candidate".
- **A lexical floor.** At least half of a hidden item's search terms must appear in its keep or its replacement. A replacement must also:
  - be newer;
  - cover a hidden item that has at least 3 terms;
  - be of the same kind, a work-history line, the daemon's, or seen at least twice.

  So a two-word note cannot supersede a long older item. This is a lexical heuristic, not a judgement of meaning.
- **Caps and immunity.** The caps above apply, and so do the pairs you made immune.
- **The boundary is Claude Code's.** The daemon refuses the gardener every other Tiller tool. If the gardener tries any other tool, a tripwire ends the run as `failed` and undoes it. But only Claude Code's flags keep shell, file and network tools away from it, and those flags and the two environment variables depend on the Claude Code version.

  **After every Claude Code upgrade, re-run** `TL_HOME=$(mktemp -d) TL_PORT=7799 npx tsx spike/gardener-flags.ts` (see [spike/README.md](../spike/README.md)). It prints PASS or FAIL for each check and costs under a cent. Leave the gardener off while any check fails.

**Residual risk.** A poisoned note from a node that succeeded can steer the gardener into hiding eligible items that the note covers lexically, up to the per-run caps. Every such hide is logged with its reason and can be undone. A superseded item also comes back when later work records the same thing.

### Turning it off

- `memory.gardener.enabled: false` stops scheduled runs. A live scheduled run stops within 30 seconds as `disabled`.
- `claude.accounts[].gardener: false` stops every run in that account, including a live manual one.
- `memory.gardener.maxUsdPer30Days: 0` blocks every run.
- Turning memory off refuses the gardener's next tool call and stops the run within 30 seconds as `off`.

Changes already applied stay, just as turning memory off deletes nothing. Undo them with `tl memory garden undo`.

### Downgrading

The gardener adds columns and tables to the memory file. A daemon with gardener support therefore upgrades each account's file to schema version 2 when it opens it, whether or not the gardener is enabled. An older Tiller then treats that file as written by a newer one: memory is off for it and the file is never written, until you upgrade again (see [When something is wrong](#when-something-is-wrong)). Nothing in the file is lost. If an older daemon revives a merged item, readers ignore the leftover merge redirect, so a file shared with an older daemon stays consistent.

## When something is wrong

Memory never blocks the daemon or a launch. If a file cannot be used, memory is off for that account with a reason that `tl memory status` shows, and nodes carry on without it.

- **No `node:sqlite` or FTS5** (a Node build without them): memory is off, with the reason.
- **Corrupt file:** it is renamed, never deleted, to `<account>.corrupt-<timestamp>.db` (with its `-wal` and `-shm`), a fresh file is started and the daemon logs the path.
- **Written by a newer Tiller** (after a downgrade): memory is off for that file and it is never written.
- **Locked or unopenable:** that one operation is skipped and the open is retried at most once a minute.
- **Invalid `claude.accounts`:** named accounts are off.

**Two daemons on one home** (a second `TL_PORT`) share the files safely, and SQLite serialises their writes. The one exception: if one daemon quarantines a corrupt file while the other has it open, the other's writes go to the quarantined file until it reopens. Avoid sharing a home that holds a corrupt file.

## Residual risks

- **A poisoned node that succeeds can still push a note or an open question** into later prompts. Eligibility, the allowlist, one-line rendering and the caps narrow this; they do not remove it. Items show their node, so look at what an injected line says and forget it, permanently with `tl memory forget`, when it is wrong. Spawn titles, written by the spawning node and cut to 80 characters, appear in ledger lines as well.
- **`gate.command` comes from the tracked `.tiller/config.json`.** What the gate prints is agent-influenced text (it comes from code and tests the node wrote), so it is treated as agent text under the rules above.
- **Redaction knows only the formats listed.** An unknown secret format can reach the file. Purge it.
- **The panel's writes are as strong as the admin token.** Its changes go over the app's authenticated WebSocket, which accepts only the admin token (a node's token cannot open it), and there is no memory tool for agents to pin or restore. But any process of yours that can read `~/.tiller/admin-token` can drive the panel, the Settings API and `tl` itself, as in the rest of Tiller.
- **Memory is not a sandbox.** The file sits outside the session directory a node may write without asking, so Claude asks first, but a shell without restrictions can read or edit it, as it can `~/.tiller/config.json`.

## Retention

Memory is not part of the session sweep: it is kept past `daemon.sessionsKeepDays`, bounded only by `memory.maxMB`. The gardener's run and action log is never evicted; it holds a few short rows a day. Removal is `tl memory forget --purge`, deleting an account's file, or turning memory off and deleting the file. There is no backfill: memory starts empty when you opt in.

## Measuring it

Turning memory on is the only switch a benchmark needs. A benchmark arm is a plain Tiller home with its own config: no `memory.projects` and no accounts, so `memory.enabled` alone decides. The arms are `off` (`enabled: false`), `on` (`enabled: true`, `digest: on`) and `tools` (`enabled: true`, `digest: off`, so agents have the tools but no digest). A `placebo` arm is the `on` home seeded with irrelevant items by the benchmark itself. `tl memory status --node ID` lists the digest a node actually received. A gate run also writes a `gate` event to the event log whether or not memory is on, so a benchmark can score first-pass rates. For a live comparison, set `memory.digest: ab` and read the comparison in `tl memory status`.
