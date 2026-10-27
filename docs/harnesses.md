# Agent harnesses

Tiller supports **Claude Code**, **Pi** and **Codex** as agent nodes, alongside plain terminals. The daemon,
UI, coordination tools, dependency queue, worktrees and outcome reporting are shared. Claude
Code is not required to run a Pi-only tree.

## Run Codex

Install Codex CLI on your PATH and authenticate with `codex login`, then run:

```sh
cd /path/to/repo
tl --harness codex
tl new "Codex session" --harness codex --prompt "Inspect this repository"
```

The spawn dialog and MCP `spawn` tool also support Codex (`kind: "agent", harness: "codex"`).
The bridge uses Codex app-server with Codex's own sandbox and approval settings. It provides
streamed terminal output, inbox delivery and steering, lifecycle/context reporting, readable
transcripts, resume, restart and follow-up. Follow-up forks the native Codex thread. Claude's
role model defaults are not applied; `profiles.codex.<profile>` supplies optional model/effort defaults, and Claude-specific permission modes and restricted presets
are rejected. Codex's native history must remain available for resume/follow-up.

The terminal pane runs the real Codex CLI connected to the bridge's app-server, with native
slash commands, composer and approval dialogs. Use Tiller restart/follow-up to change the managed
conversation. Tiller workers use the MCP `spawn` tool; Codex's internal subagents do not create
Tiller tree nodes. See the [Codex adapter README](../adapters/codex/README.md) for delivery
guarantees, compatibility and limitations.

## Run Pi

Install and authenticate a compatible `pi` CLI on your PATH, then:

```sh
cd /path/to/repo
tl --harness pi
# Choose a model explicitly when desired:
tl new "Pi session" --harness pi --model openai/gpt-5 --prompt "Inspect this repository"
```

The adapter targets **`@earendil-works/pi-coding-agent` 1.2.x and 1.3.x**, which has native HTTP MCP
registration and the `agent_settled` extension event. At startup it checks Pi's version and the
APIs it needs. Any other version, including older, newer and prerelease builds, makes the node
shut down instead of running half-connected, with the reason in its row's activity. Unverified Pi minor releases stop Pi nodes
at startup until the adapter is updated for them.

Pi uses its own provider credentials and subscriptions; Tiller supplies neither. A Pi node's cost
comes from Pi's session entries, priced from Pi's model catalog, except that an OpenRouter
response's own reported cost replaces the catalog figure. When some usage has tokens but no price
(a model without catalog pricing and no reported cost), the spend shows as a lower bound with a
trailing `+`, such as `$0.12+`, in the UI, `tl ps` and `list_nodes`, and in every tree total that
includes it. Today's total gets the `+` only on a day that added such usage. Pi cannot tell a
genuine $0 catalog price from a missing one, so a provider that reports tokens at no cost, such as a
local model or `claude-bridge` on a subscription, shows `$0.00+` rather than `$0.00` from its first
turn on. An amount above zero but under a cent shows as `<$0.01` (`<$0.01+` when incomplete) instead of `$0.00`. See the [Pi adapter's limitations](../adapters/pi/README.md#limitations).

The spawn dialog also offers Pi. From another agent, use the existing `spawn` MCP tool:

```json
{ "kind": "agent", "harness": "pi", "title": "worker", "cwd": "/path/to/repo", "prompt": "Review the tests" }
```

Generic `agent` children inherit their parent's harness when `harness` is omitted. To mix CLIs,
select the harness explicitly. Legacy `kind: "claude"` remains Claude Code; terminal nodes do
not take a harness.

Tiller's `roles.*.model` and `roles.*.effort` defaults apply only to Claude Code. A Pi node uses
the model from the spawn, then its preset, then `profiles.pi.<profile>.model`, or else Pi's own default from
`~/.pi/agent/settings.json`. Use model names the selected CLI accepts; `pi --list-models` lists
Pi's. An explicit `effort` becomes Pi's `--thinking`.

## Sessions

### Change an existing agent's harness

Open the node's **More actions → Change harness…** menu, including on a root session or an exited
agent. Select Claude, Codex or Pi and confirm. The current process stops before the replacement
launches. The new harness starts a fresh native conversation, even when that node used the same
harness in an earlier session. An optional first prompt can point it at the work to continue;
otherwise Tiller points it at the tree's `handoff.md` when available.

The node keeps its identity, title, parent, children, working directory and worktree. Earlier
transcripts remain readable in the Transcript session picker, labeled with their harness.
Model, effort, preset and Claude permission overrides are cleared; the selected harness's task
profile defaults and configured permission/approval settings apply. Review those settings before
switching a restricted session. Changing harness is a human/admin action; agents cannot invoke it
or use it to bypass cross-harness launch restrictions. Terminals cannot change harness.

Armed/queued nodes, worktree setup, merge/close operations and running completion gates block a
switch. Tiller checks the executable and workspace before stopping the old process. A stop that
does not produce an exit notification within seven seconds refuses the replacement, preventing
overlapping agents. The node stays locked while its old process is still stopping; Restart and
Close cannot bypass that unconfirmed stop. Once exit is observed, it can be changed or restarted
again. Codex's host also confirms its managed native TUI and app-server exits before exiting.
Startup/authentication or adapter compatibility failures remain visible on
the exited node; fix the cause and use Restart or select another harness. No rollback resumes an
old native context automatically.

For local admin integrations, `POST /api/change_harness` takes `nodeId`, `harness` (`claude`,
`codex` or `pi`) and an optional `prompt` with the human token. It has the same fresh-context
consequences as the dialog; the caller supplies confirmation. Requesting the current harness is
refused with a Restart hint.

`tl send`, `tl read`, `tl transcript`, `tl resume`, `tl restart`, `tl followup`, dependency
launches and outcome reporting work with Pi nodes. Pi conversation files live under
`~/.tiller/sessions/<rootId>/agents/<nodeId>/<sessionId>.jsonl`. They survive node close and
follow session-directory retention, except that directories referenced by registered nodes are
not swept. A follow-up copies the conversation into the new node's own tree, so it no longer
depends on the old tree's retention; the source stays unchanged. The adapter README describes
[what the copy changes](../adapters/pi/README.md#load-it).

Tiller owns Pi's session lifecycle. Use Tiller's controls, not Pi's `/new`, `/resume`, `/fork` or
`/tree` commands, which the adapter cancels. Pi's `/reload` remains available.

## Messages

Messages to a Pi node go through the adapter's inbox bridge, never terminal paste. The bridge
takes a message only while Pi is idle; until then it stays queued and the sender can withdraw it.
A steer aborts the running turn and goes ahead of the queue once Pi is idle. A message counts as
delivered only when Pi starts a turn whose prompt equals the sent text exactly. An extension that
rewrites input would therefore leave deliveries unconfirmed, and they would retire after 60
seconds. A retired message is reported as `stalled` and not retryable, because Pi may still run
it late. Inspect the node (for example, for missing credentials) and do not
resend automatically. The adapter README has the [full delivery
protocol](../adapters/pi/README.md#inbox-claim-ack-steer).

## Worktrees and safety

Pi starts directly in the worktree Tiller created; it does not need Claude's `--worktree` flag
or workspace trust database. The `.claude/worktrees/<nodeId>` directory convention is kept so
Tiller's worktree reconciliation works the same way.

Repository-configured setup, teardown and completion-gate commands require explicit trust.
Without a Claude trust record, approve them from a **human terminal outside a Tiller node**:

```sh
tl trust --cwd /path/to/repo
# Remove Tiller's explicit opt-in:
tl untrust --cwd /path/to/repo
```

Trust authorizes the commands in the repository's `.tiller/config.json`, including future
changes, so inspect it before opting in. Trust also covers every directory below the trusted
one: trusting a parent folder trusts every repository under it, including ones cloned there
later. Trust is stored in `~/.tiller/trusted-projects.json`. Existing Claude trust, in the
default home or any configured [Claude account](#claude-accounts), is still honored; `untrust` removes only Tiller's opt-in, not Claude's record. This trust controls
Tiller's repository commands, not Pi's own project-resource trust or permission policy.

The check that stops `tl trust` and `tl untrust` from running inside a node looks at
`TL_NODE_ID`. It is **advisory, not a sandbox or security boundary**: a same-user agent can unset
the variable or write the trust file directly. Pi's project trust and node-scoped HTTP
authentication do not constrain same-user local code either. To enforce separation, use OS
accounts, a sandbox or container, and narrowly scoped filesystem and credential access.

### Preset tool restrictions on Pi

A preset's `tools` becomes Pi's `--tools` allowlist and its `disallowedTools` becomes
`--exclude-tools`. Presets name Claude tools, which tiller translates with a fixed table:

| Preset (Claude) name | Pi tool |
| --- | --- |
| `Read` | `read` |
| `Write` | `write` |
| `Edit`, `MultiEdit`, `NotebookEdit` | `edit` (Pi's edit and write also cover notebooks) |
| `Bash` | `bash` |
| `PowerShell` | `powershell` |
| `Grep` | `grep` |
| `Glob` | `find` |
| `LS` | `ls` |
| `mcp__tiller`, `mcp__tiller__<tool>` | `mcp__tl_<node prefix>_*`, `mcp__tl_<node prefix>_*__<tool>` |

A preset naming any other tool, such as `WebSearch`, `WebFetch`, a Claude permission rule like
`Bash(npm *)` or another MCP server's tools, is refused for Pi, so a restriction is never weaker
than written. An allowlist always keeps this node's tiller MCP tools (`mcp__tl_<node prefix>_*`: the
adapter registers tiller's server as `tl_<first 8 characters of the node id>_<random>`), so the
node can still report; because the list has an
`mcp__` entry, Pi then also leaves out every other MCP server's tools, and extension tools not
named. Pi has no equivalent of `maxTurns`, so a preset with it is still refused, as are Claude
`permissionMode` and session forking.

A preset with `tools` or `disallowedTools` also launches as if `pi.extensions` were `"none"`,
whatever the setting says: only tiller's adapter and the built-ins it needs load, because an
extension's tools, such as subagents or background tasks, could do what the preset denies.
Prompt-only presets follow `pi.extensions`. `builtin:mcp` still connects the user's own Pi MCP
servers (from Pi's `mcp.json`), and their tools stay callable unless the preset has a `tools`
allowlist, which leaves out every MCP tool it does not name; a `disallowedTools` list alone does
not remove them.

Restrictions apply to the node they are set on, not to its children: a restricted Pi node can
spawn an unrestricted Pi child, as a restricted Claude node can spawn an unrestricted Claude child.

The built-in `reviewer` preset runs on Pi as `--exclude-tools edit,write`, without the user's extensions. The `researcher`
preset names `WebSearch` and `WebFetch`, which have no Pi built-in, so it is still refused; use
`--profile explorer` for portable read-only research on Pi.

### Which Pi extensions a node loads

`pi.extensions` in the [config](config.md) chooses which of the user's Pi extensions and packages
a Pi node loads besides tiller's adapter. `"all"` (the default) loads what Pi's settings
configure, as a plain `pi` run would. A preset with tool restrictions overrides the setting with
`"none"` (see above). `"none"` launches with `--no-extensions` and loads back only
the built-ins tiller needs: `builtin:mcp` for tiller's server, and `builtin:codemode` and
`builtin:tool-search` for MCP exposures that use them. A list of package sources, written as in
Pi's settings (for example `["npm:pi-web-access"]`), does the same and adds each listed package
by the install path `pi list` reports; tiller does not pass the source itself, because `-e
npm:<pkg>` installs a separate temporary copy. A built-in disabled in Pi's settings stays
disabled. Some packages work against tiller's tracking: subagent extensions run work outside
tiller's tree, and background-task extensions can keep working after a turn ends, when tiller
already counts the node as done.

A listed package that is not in Pi's settings, not installed, or configured with filters makes
the launch fail with a message naming it, so the spawn is refused rather than starting a node
with fewer or more tools than the setting says. `--no-extensions` affects extensions only:
skills, prompt templates and themes from packages still load.

## Claude accounts

Claude nodes can run under different Claude accounts, for example a personal and a work
subscription. Each account is a Claude config directory, which Tiller passes to Claude as
`CLAUDE_CONFIG_DIR`. List them in the home file `~/.tiller/config.json` only; a project file's
`claude.accounts` and `claude.account` are ignored with a warning, so an agent cannot add or pick one:

```json
{
  "claude": {
    "accounts": [
      { "name": "personal" },
      { "name": "work", "configDir": "~/.claude-work", "projects": ["~/workspace/acme"] }
    ],
    "account": "personal"
  }
}
```

An entry without `configDir` is Claude's default home (`~/.claude`); at most one may omit it.
`claude.account` names the default account, for root nodes in projects no account lists;
unset means no account. If the list is invalid, or `claude.account` names no listed account,
Claude nodes fail closed: root spawns, and restarts or resumes of nodes with an account, are
refused with an error naming the problem until it is fixed.
Do not give `~/.claude` as a `configDir`: Claude keys its keychain login by the exact
`CLAUDE_CONFIG_DIR` string, so that would be a different, logged-out login.

**In Settings**, the Claude section has a **Claude account** field. For all repositories it sets
`claude.account`. For a repository it lists the repository's path under the chosen account's
`projects`, and **Use global default** removes it from every account; only entries for exactly
that path change, and a broader entry that covers the repository (such as a parent folder) stays
and is shown as the source. Both write the home file, never the repository's
`.tiller/config.json`. The field shows each account's login state and the login command for one
that is logged out. Accounts themselves (name and `configDir`) are defined in the JSON only.

**Log in** each account yourself, once, from a terminal, then run `claude` once in each project
under it to finish onboarding and accept its workspace trust:

```sh
CLAUDE_CONFIG_DIR=~/.claude-work claude auth login
CLAUDE_CONFIG_DIR=~/.claude-work claude   # in each project, once
```

`/login` in a node's own terminal works too. Tiller never logs in or out. The spawn dialog lists
the accounts with their login state, from `claude auth status --json` run under each directory;
a directory that does not exist yet is shown logged out without running Claude.

**Which account a node runs in:**

- A root node: the account the human chose (spawn dialog, or `tl new` / `tl spawn --account
  NAME`), else the account whose `projects` contains the node's project (the longest match
  wins, then config order), else `claude.account`, else Claude's default home with no account.
- A child: always its parent's. Agents cannot choose or change an account; a spawn with
  `account` from an agent, or a human child spawn naming another account, is refused.
- Restart, resume and a harness change keep the account; it is never re-resolved from the
  config. If the account is removed from the config, they fail with an error naming it until it
  is restored.
- Fork and follow-up stay in the source's account; a cross-account fork is refused (see
  [sessions.md](sessions.md#history-follow-up-and-fork)).

The node's record keeps the account's name, shown as `account NAME` in `list_nodes` and the
inspector. Only Claude launches get `CLAUDE_CONFIG_DIR`. Pi and Codex nodes keep the account so
their Claude children inherit it, and terminal nodes do not get the variable.

**Per account:** Claude's own settings, memory (`CLAUDE.md`), plugins, MCP servers, workspace
trust (`.claude.json`) and transcripts (`projects/`) live in each config directory and do not
carry over; symlink files between directories to share them. Tiller's plugin, MCP server and
settings are passed on the command line, so they work in every account. Claude's worktree trust
check uses the node's account. Tiller's own repository commands (setup, teardown, completion
gate) run when any configured account, or `tl trust`, trusts the repo.

**Usage:** nodes in one account share one quota source in the usage panel. Nodes without an
account each report separately, as before. In `list_nodes`, an agent sees its own account's
usage line; the human's line is the newest report, labelled with its account.

**Not a sandbox.** Accounts prevent accidental cross-account use; they do not stop an agent
with a shell from running `CLAUDE_CONFIG_DIR=… claude` itself.

## Usage and quotas

The usage panel shows each harness's account quotas. Codex reads them through its app-server
(see [the Codex adapter](../adapters/codex/README.md#account-quotas)); Claude reports them from
its mod's `session.measure`.

Discovery automatically checks the daemon launch PATH even with no live nodes.
Opening the overview or choosing Rescan runs at most three `--version` probes,
concurrently, with 1.5-second deadlines and 16 KiB output limits. Results are
cached for one minute and concurrent requests coalesce. Failed probes remain
detected tools with an explicit version-check failure. Authentication is unknown
until a quota report arrives. Pi does not expose provider account quotas through
the current adapter. Unknown accounts are
isolated by reporting node; identified account/provider/pool reports may be shared
only between nodes that actually reported that identity. Reports survive node
exit/removal and websocket reconnects for the daemon lifetime, but not daemon
restart. No background provider polling or inference is performed.

Each normalized window carries `windowId` and `observedAt`. Sparse notifications
keep the original observation time on cached windows, so the daemon can merge a
shared account's reports without regressing a newer reading from another agent.
Nullable IDs resolve to a known mirror pool or the single unambiguous known pool.
Sparse null spend metadata is retained; a full-read null emits timestamped
`removedWindows` entries so the registry removes that window and rejects older
cached copies. Read failures remain scoped to the reporting node; healthy nodes
sharing an identified account retain their available snapshot.

Removed nodes lose their source bindings. At most one newest unidentified closed
snapshot per tool is retained; unidentified accounts are never combined. Known
accounts retain their pools, and context-only measures do not broadcast snapshots.
Expired reset windows display “reset passed · awaiting report” with no old percent.

Claude Code 2.1.302 was inspected locally (read-only native binary): its mod
`session.measure` normalization currently emits `five_hour`, `seven_day`, and
`spend_limit` for gateway usage. Native Opus/Sonnet windows exist elsewhere but are
not emitted by that conversion. If explicit `seven_day_opus` / `seven_day_sonnet`
windows arrive, Tiller labels their family pools and filters unrelated families
from the selected-agent bar. It does not infer exact-model quotas from model names.

## Adapter boundary

`src/daemon/harness.ts` defines `HarnessAdapter`: validation, capabilities, launch command,
working directory, transcript location and optional pre-launch storage preparation.
Claude's adapter wraps the existing launch logic;
Pi's adapter loads `adapters/pi/index.ts`; Codex's adapter launches `adapters/codex/index.ts`,
which hosts the installed CLI's app-server. Neither CLI is installed with Tiller.

Coordination stays on the existing interfaces:

- **Tools:** HTTP MCP at `/mcp`, including `spawn`, `send`, `read`, `report_outcome`, and the rest.
- **Identity:** `TL_NODE_ID`, `TL_ENDPOINT`, `TL_TOKEN_FILE`; requests carry `Authorization:
  Bearer <node token>` and `X-TL-Node: <id>`. Never use the human/admin token in an agent adapter.
- **Lifecycle:** authenticated `POST /hook` and `POST /mod-event` feed the shared reducer.
- **Delivery:** `GET /inbox`, `POST /claim`, native prompt submission, then `POST /ack` only on
  observed acceptance, or `POST /release` for a claim that was never submitted. A busy agent
  leaves messages unclaimed and withdrawable; a steer aborts the turn and is claimed once idle.
  A fire-and-forget CLI API return is not delivery proof.

To add OpenCode/another CLI: add its harness identifier and adapter, provide an equivalent
lifecycle/inbox bridge using that CLI's native API, and supply a transcript decoder. Declare
unsupported capabilities, and reject unsupported restrictions in the adapter's `validate`. Do not duplicate the MCP tools
or implement arbitrary executable configuration as a shortcut.

See [the Pi adapter](../adapters/pi/README.md) for protocol mapping, compatibility and tests.

## Task profiles across harnesses

`profile` is independent of both `harness` and the coordination `role`. The effective coordination role selects the default profile: `orchestrator` maps to `orchestrator`, `worker`/`none` to `implementation` (normally root and child respectively). The spawn UI offers all five profiles, including **Mechanical worker** (`mechanical`). `tl new --harness codex --profile implementation` and MCP `spawn` with `profile: "reviewer"` use the same resolution. Model and effort defaults are configured separately per harness and profile in `profiles.<harness>.<profile>`; explicit spawn fields win over presets, which win over config. See [config.md](config.md) for precedence and recommended opt-in Codex defaults. Legacy `roles` defaults remain Claude-only.

`reviewer` and `explorer` profiles provide read-only instructions supported by all harnesses. They do not translate or remove Claude tool restrictions. Pi enforces a preset's `tools` and `disallowedTools` through its own flags (see [Preset tool restrictions on Pi](#preset-tool-restrictions-on-pi)) and refuses names it cannot translate; Codex rejects restricted presets (including the named `reviewer` and `researcher`), and the existing cross-harness delegation guard remains in force. Use the portable profile when instruction-level read-only work is sufficient; use the restricted preset on Claude or Pi when its enforced tool policy is required.
