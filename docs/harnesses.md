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
role model defaults are not applied; Tiller's built-in Codex [task defaults](config.md#task-defaults-on-installation), or `profiles.codex.<profile>`, supply model/effort defaults, and Claude-specific permission modes and restricted presets
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

An account is a Claude config directory that Tiller passes to Claude as `CLAUDE_CONFIG_DIR`.
The `claude` CLI holds only one login per config directory, so giving each account its own
directory lets several logins (say, two Teams orgs) stay signed in at once. Your normal `claude`
in a terminal keeps using `~/.claude` and is not affected.

You need three things: the accounts listed in `~/.tiller/config.json`, each alternate account
logged in once, and a rule for which projects use which account.

### Set up accounts in Settings

When no accounts are configured, Settings → **Claude** → **Claude account** explains that Tiller
uses your default Claude login (`~/.claude`) and offers **Set up multiple accounts**. Nothing
changes until you click it. The form opens with the default account and one more account:

1. In **Default account name**, enter a name for your existing `~/.claude` login. It becomes
   `claude.account`, the account nodes use unless a project says otherwise.
2. Fill in the second account, and click **Add another account** for each further one. Each row
   has a **Name** and a **Config directory**. The directory starts as `~/.claude-<name>` and
   follows the name until you edit it. If the directory exists, the row says **Directory
   exists**; otherwise a ticked **Create this directory** checkbox has Tiller create it, and
   unticking it is an error. Remove a row with its remove button.
3. Click **Save configuration**. Tiller writes the accounts to `~/.tiller/config.json`. **Cancel**
   closes the form and discards it.

A field shows its problem once you have changed it and moved on, such as an empty, badly formed
or duplicate name, an empty directory, or a path that is not a directory. **Save configuration**
stays disabled while any field has a problem.

Once accounts exist, the field has a **Configure** button that opens the same form with the
current accounts. You can add accounts, remove them, and change an account's config directory.
Names cannot change, because nodes and repository mappings refer to accounts by name; to rename,
remove the account and add a new one, which starts with no `projects`. A kept account keeps its
`projects`. A new directory is a separate login, so log in to that account again. The default
account (`claude.account`) cannot be removed: choose another default in the field first. If open
nodes (running or not yet closed) use an account you remove, the form names them and asks you to
tick **Remove anyway**; those nodes keep running, but restarting or resuming them fails until the
account is configured again.

The save is refused if the file changed since Settings loaded it, if the account list in the file
is invalid, if it would remove the default account, if a new or changed config directory is
`~/.claude` or a symlink to it, is inside the Tiller home (`~/.tiller`), or does not exist and
was not to be created, if two accounts share a name or a directory, or if more than one account
has no config directory.

Afterwards, the field lists the login command for each logged-out account and the command to run
once in each project to accept workspace trust. Both are described in
[Log in each alternate account](#log-in-each-alternate-account) below.

### Set up accounts by hand

Edit `~/.tiller/config.json`:

```json
{
  "claude": {
    "accounts": [
      { "name": "team-a" },
      { "name": "team-b", "configDir": "~/.claude-team-b", "projects": ["~/workspace/team-b"] }
    ],
    "account": "team-a"
  }
}
```

- `name`: 1-32 letters, digits, `_` or `-`, starting with a letter or digit. Names must be unique.
- `configDir`: the account's `CLAUDE_CONFIG_DIR`, absolute or starting with `~/`. Leave it out for
  the account that uses your normal `~/.claude` login. At most one account may leave it out, and
  no two accounts may share a directory.
- `projects` (optional): directories whose root nodes run in this account, including anything
  inside them.
- `claude.account` (optional): the default account, by name, for root nodes in projects no
  account lists. Unset means those nodes run with no account, in `~/.claude`.

Accounts are read from the home file only. A project's `.tiller/config.json` cannot set
`claude.accounts` or `claude.account`; they are ignored there with a warning, so an agent cannot
add or pick an account.

If the list is invalid (a bad name, an unknown key, a duplicate name or `configDir`, a
`configDir` of `~/.claude`, or two entries without `configDir`), or `claude.account` names an
account that is not listed, Claude nodes fail closed rather than run in the wrong account. Root
spawns, and restarts or resumes of nodes that have an account, are refused with an error naming
the file and the problem until you fix it. The spawn dialog shows the error too.

### Log in each alternate account

Tiller never logs in or out for you. For each account with a `configDir`, log in once from a
terminal:

```sh
CLAUDE_CONFIG_DIR=~/.claude-team-b claude auth login
```

Then run Claude once under that account in each project it will use, to finish onboarding and
accept workspace trust:

```sh
cd ~/workspace/team-b/some-repo
CLAUDE_CONFIG_DIR=~/.claude-team-b claude
```

The default account already uses your normal `~/.claude` login, so it needs nothing extra.
`/login` in a node's own terminal also works.

### How a node picks its account

For a root node, Tiller uses the first of these that applies:

1. The account you chose when spawning (the spawn dialog, or `tl new` / `tl spawn --account NAME`).
2. The account whose `projects` contains the node's directory. The longest matching entry wins;
   on a tie, the first account in the config.
3. `claude.account`.
4. No account: Claude runs in `~/.claude`.

A child node always runs in its parent's account. Agents cannot choose or change an account: a
spawn with `account` from an agent, or a human child spawn naming another account, is refused.

Restart, resume and a harness change keep the node's account; it is never re-resolved from the
config. If you remove the account from the config, they fail with an error naming it until you
restore it. Fork and follow-up stay in the source's account, and a cross-account fork is refused
(see [sessions.md](sessions.md#history-follow-up-and-fork)).

**Choose per repository in Settings.** With a repository selected, the **Claude account** field
adds the repository's path to the chosen account's `projects`. **Use global default** removes that
path from every account. Only entries for exactly that path change: a broader entry that covers
the repository (such as a parent folder) stays and is shown as the source. With all repositories
selected, the field sets `claude.account`. Both write the home file, never the repository's
`.tiller/config.json`.

### Check that it worked

1. Open Settings → **Claude**. The **Claude account** field lists each account with its login
   state, and the email and organization it is logged in as. Tiller gets these by running
   `claude auth status --json` under each config directory.
2. Spawn a root node in a repository mapped to an alternate account, leaving the spawn dialog's
   account on **Automatic (by project)**. The inspector and `list_nodes` show the node's account
   as `account NAME`. In the node, `/status` shows which login it is using.

### Troubleshooting

- **Don't use `~/.claude` as a `configDir`.** Claude keys its keychain login by the exact
  `CLAUDE_CONFIG_DIR` string, so `~/.claude` given explicitly is a separate, logged-out login.
  Tiller rejects it; leave `configDir` out for that account instead.
- **"Loading Claude accounts…" never finishes.** The running daemon is older than the UI, for
  example after a `git pull`. Run `tl reload`.
- **An account shows as not logged in.** Run the login command Settings shows for it, such as
  `CLAUDE_CONFIG_DIR=~/.claude-team-b claude auth login`. A `configDir` that does not exist yet
  shows as logged out until that login creates it.

### Details

Only Claude launches get `CLAUDE_CONFIG_DIR`. Pi and Codex nodes keep the account so their
Claude children inherit it, and terminal nodes do not get the variable.

**Per account:** Claude's own settings, memory (`CLAUDE.md`), plugins, MCP servers, workspace
trust (`.claude.json`) and transcripts (`projects/`) live in each config directory and do not
carry over; symlink files between directories to share them. Tiller's plugin, MCP server and
settings are passed on the command line, so they work in every account. Claude's worktree trust
check uses the node's account. Tiller's own repository commands (setup, teardown, completion
gate) run when any configured account, or `tl trust`, trusts the repo.

**Usage:** nodes in one account share one quota source in the usage panel. Nodes without an
account each report separately. In `list_nodes`, an agent sees its own account's usage line; the
human's line is the newest report, labelled with its account.

**Not a sandbox.** Accounts prevent accidental cross-account use; they do not stop an agent
with a shell from running `CLAUDE_CONFIG_DIR=… claude` itself.

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

`profile` is independent of both `harness` and the coordination `role`. The effective coordination role selects the default profile: `orchestrator` maps to `orchestrator`, `worker`/`none` to `implementation` (normally root and child respectively). The spawn UI offers all five profiles, including **Mechanical worker** (`mechanical`). `tl new --harness codex --profile implementation` and MCP `spawn` with `profile: "reviewer"` use the same resolution. Model and effort defaults are configured separately per harness and profile in `profiles.<harness>.<profile>`; explicit spawn fields win over presets, which win over config. See [config.md](config.md) for precedence and the built-in task defaults. Legacy `roles` defaults remain Claude-only.

`reviewer` and `explorer` profiles provide read-only instructions supported by all harnesses. They do not translate or remove Claude tool restrictions. Pi enforces a preset's `tools` and `disallowedTools` through its own flags (see [Preset tool restrictions on Pi](#preset-tool-restrictions-on-pi)) and refuses names it cannot translate; Codex rejects restricted presets (including the named `reviewer` and `researcher`), and the existing cross-harness delegation guard remains in force. Use the portable profile when instruction-level read-only work is sufficient; use the restricted preset on Claude or Pi when its enforced tool policy is required.
