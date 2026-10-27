# Configuration

Tiller reads JSON config from two files: the project file `<repo>/.tiller/config.json` and the home file `~/.tiller/config.json` (under `TL_HOME` when set). Every key is optional. `tl config [--cwd P]` prints the effective value of every key for a directory and the file it came from, or `default`.

## Resolution

Each config key resolves independently: project file, then home file, then built-in default. For spawn model and effort, each field resolves in this order: explicit spawn argument, preset frontmatter, `profiles.<harness>.<profile>` config, legacy `roles` config (Claude only), then Tiller’s built-in task defaults, then the harness’s own default. A home profile setting therefore wins over a project legacy role setting; project beats home within the same config key. Profile selection resolves from the explicit spawn argument, then preset, then effective coordination role (`orchestrator` → `orchestrator`, `worker`/`none` → `implementation`). Coordination role resolves separately: explicit argument, preset, then root `orchestrator` or child `worker`. The project file is the one in the node's directory; for a node in its own git worktree it is the main checkout's. Both files are read on every use, so an edit applies without restarting the daemon.

Keys in the `daemon` group are daemon-wide and come from the home file only. A `daemon` group in a project file is ignored with a warning. So are `claude.accounts` and `claude.account`: an agent can edit its project file, and must not be able to choose which Claude account it runs in. The Settings panel's repository-level Claude account is stored in the home file too (see below).

Keys in the `approvals` group decide when an agent skips the human's approval, and an agent can edit its project file, so a project file may only make them stricter. The home file's value, or the default when the home file does not set the key, is the loosest an approval can be. A project value at least as strict applies; a looser one is ignored with a warning, and `tl config` then shows the home or default value as the source. For `approvals.close`, `never` is strictest, then `done`, then `always`; for `approvals.merge`, `false` is stricter than `true`. To let agents in a repo close finished nodes without asking, set `"approvals": { "close": "done" }` in the home file; a repo that should still ask can set `never` in its project file.

## Bad files and bad keys

A file that does not parse as JSON is skipped as a whole, and the daemon logs one line naming it. Inside a file that parses, every group and the top level are strict: an unknown key (for example a misspelling, or a name that has since been renamed) and a key with an invalid value are each logged once and dropped, and the rest of the file still applies. The warning goes to the daemon's log (or to the terminal, for `tl config`) in the form `tiller: ignoring in <path>: <key>: <reason>`.

## Keys

The layer column says where a key may be set: "project, home" means either file, with the project file winning; "home, project stricter" means the project file wins only when it is stricter.

| Key | Type | Default | Layer | Meaning |
|---|---|---|---|---|
| `profiles.<harness>.<profile>.model` | string | See [task defaults](#task-defaults-on-installation) | project, home | Model for the selected harness and task profile. Harness: `claude`, `codex`, `pi`; profile: `orchestrator`, `implementation`, `explorer`, `mechanical`, `reviewer`. |
| `profiles.<harness>.<profile>.effort` | `low`, `medium`, `high`, `xhigh`, `max` | See [task defaults](#task-defaults-on-installation) | project, home | Effort for that harness/profile. Codex supports through `xhigh`; `max` is rejected as an invalid config leaf. Unsupported resolved Codex effort is rejected before node or worktree allocation, including queued spawns. |
| `roles.orchestrator.model` | string | unset (then the [task defaults](#task-defaults-on-installation)) | project, home | Model for an orchestrator spawned without one. |
| `roles.orchestrator.effort` | `low`, `medium`, `high`, `xhigh`, `max` | unset (then the [task defaults](#task-defaults-on-installation)) | project, home | Effort (passed to claude as `--effort`) for an orchestrator spawned without one. |
| `roles.worker.model` | string | unset (then the [task defaults](#task-defaults-on-installation)) | project, home | Model for a worker, or a node with role `none`, spawned without one. |
| `roles.worker.effort` | as above | unset (then the [task defaults](#task-defaults-on-installation)) | project, home | Effort for a worker, or a node with role `none`, spawned without one. |
| `pi.extensions` | `"all"`, `"none"` or string[] | `"all"` | project, home | Which of the user's Pi extensions a Pi node loads besides tiller's adapter. `"all"` loads what Pi's settings configure. `"none"` launches with `--no-extensions` plus the built-ins tiller needs (`builtin:mcp`, `builtin:codemode`, `builtin:tool-search`). A list of package sources as written in Pi's settings, such as `["npm:pi-web-access"]`, loads only those packages, by their install path from `pi list`, and an empty list loads none, like `"none"`; `"all"` and `"none"` cannot appear inside a list; one that is not installed or is filtered refuses the launch. A preset with `tools` or `disallowedTools` launches as `"none"` whatever this says. In the Settings panel, a single line `all` or `none` saves that word, other lines save a list, an empty box saves an empty list, and `all` or `none` mixed with package lines is refused. Read at each launch. See [harnesses](harnesses.md#which-pi-extensions-a-node-loads). |
| `claude.inheritMcpServers` | boolean | `true` | project, home | When true, a Claude node loads the user's and plugins' MCP servers as well as tiller's. A project's `.mcp.json` servers stay off in nodes (tiller lists them as `disabledMcpjsonServers` in the node's settings) because Claude would otherwise stop each new node on an approval prompt. Plugin tools are named `mcp__plugin_<plugin>_<server>__*`. When false the node is launched with `--strict-mcp-config` and gets only tiller's server. Read when the node's files are written for a launch, so a resume uses the current value. |
| `claude.accounts` | array | `[]` | home | Claude accounts nodes can run under, each `{ "name", "configDir"?, "projects"? }`; see [Claude accounts](harnesses.md#claude-accounts). `name` is 1-32 letters, digits, `_` or `-`. `configDir` (absolute or `~/…`) is the account's `CLAUDE_CONFIG_DIR`; an entry without it is Claude's default home (at most one). `projects` lists directories whose root nodes run in the account. A bad entry, an unknown key, a duplicate name or `configDir`, or a `configDir` of `~/.claude` makes the whole list invalid: Claude nodes then fail closed rather than run in the wrong account. A root spawn is refused with an error naming the file and the problem (the spawn dialog shows it too), as is a restart or resume of a node that has an account, until the list is fixed. When none are configured, Settings → Claude → **Claude account** offers a setup form that writes the first list; after that, Settings → Claude → **Configure** adds, removes and re-directs accounts, and Settings → Claude → **Claude account** picks the default. Editing the JSON also works. |
| `claude.account` | string | unset | home | The default account, by name, for a root node whose project no account's `projects` lists; unset means no account. A name not in `claude.accounts` makes Claude spawns fail closed, as an invalid list does. Settings → Claude → **Claude account** for all repositories. |
| `approvals.close` | `never`, `done`, `always` | `never` | home, project stricter | Whether an agent's `close` skips the human's approval: always, only when every node in the batch is done, exited or has reported an outcome, or never. |
| `approvals.merge` | boolean | `false` | home, project stricter | When true, an agent's `merge` does not ask the human. |
| `worktrees.isolation` | `none`, `worktree` | `none` | project, home | What a spawn of a worker agent node (any harness, not an orchestrator) gets when it does not say. |
| `worktrees.branchPrefix` | string | `tl/` | project, home | A worktree's branch is this prefix followed by the node id. |
| `worktrees.include` | list of gitignore patterns | `.worktreeinclude` | project, home | Gitignored files copied into a new worktree; when absent, the repo's `.worktreeinclude` file is used. |
| `worktrees.mergeStyle` | `merge`, `squash`, `ff-only` | `merge` | project, home | How the merge verb brings a branch into its base. |
| `worktrees.setup` | list of shell commands | `[]` | project, home | Run in a new worktree before the agent starts. See [copied `node_modules/`](#copied-node_modules) for re-installing a stale copy. |
| `worktrees.teardown` | list of shell commands | `[]` | project, home | Run in a worktree before tiller removes it. |
| `worktrees.protected` | list of branch names | `["main", "master"]` | project, home | Branches a merge never goes into; the remote's default branch counts too, unless the list is set to `[]`, which protects nothing. A worker spawned from one without a base gets a task branch. |
| `worktrees.taskBranch` | string containing `{slug}` | `tl/{slug}` | project, home | Name of the task branch made for such a worker; `{slug}` is its title in lower case with dashes. |
| `gate.command` | shell command | none | project, home | A check that must pass before a worker's `succeeded` report is recorded; no gate when unset. |
| `gate.retries` | integer, 0 or more | `2` | project, home | Further failed gate runs allowed before the outcome is recorded as failed. |
| `gate.timeoutMinutes` | positive number | `10` | project, home | Each gate run is stopped after this long. |
| `daemon.resumeOnStart` | boolean | `true` | home | Resume the nodes that were live when the daemon last went away. |
| `daemon.resumeMaxAgeDays` | number | `3` | home | Nodes idle longer than this are not resumed on start. |
| `daemon.sessionsKeepDays` | number | `14` | home | A session directory is deleted this long after its root closed. |
| `daemon.digestAfterMinutes` | number | `10` | home | A window regaining focus after this long with no focused window gets the away digest. |
| `daemon.maxLiveNodes` | integer | `20` | home | An agent's spawn is refused once this many nodes are live. |
| `daemon.maxWorking` | integer | `0` | home | Claude nodes working at once; past it a spawn is queued. 0 means no cap. |
| `notifications.kinds.needsYou` | `banner`, `sound`, `silent` | `sound` | project, home | How a node that needs approval or an answer is notified. |
| `notifications.kinds.errored` | as above | `silent` | project, home | How a turn that ended in an error is notified. |
| `notifications.kinds.done` | as above | `banner` | project, home | Level for the tree completion summary, or individual finished turns when tree summaries are disabled. |
| `notifications.kinds.exited` | as above | `silent` | project, home | How an exited node is notified. |
| `notifications.treeDoneSummary` | boolean | `true` | project, home | Replace per-agent done and exited notifications with one per tree once all agents finish, including the root; pending launches and unresolved gates delay completion. |
| `notifications.quietHours` | `"HH:MM-HH:MM"` | none | project, home | Local time span, which may cross midnight, during which only needs-you notifications are shown, without sound. |
| `limits.maxDepth` | integer | `3` | project, home | An agent's spawn is refused when the new node would sit more than this many levels below its root. |
| `limits.maxChildren` | integer | `8` | project, home | An agent's spawn is refused when the parent already has this many live children. |
| `limits.stallMinutes` | positive number | `5` | project, home | A working node with no hook event for this long is marked stalled and its parent is told. |
| `limits.maxMessagesPer10Min` | positive integer | `20` | project, home | Messages one node may send another in 10 minutes before further sends are refused as a likely loop. |

For notification levels, `sound` is a banner with a sound and `silent` sends nothing. The behaviour each key controls is described in the topic documents: [agent-roles.md](agent-roles.md) for roles, the gate and the spawn limits, [worktrees.md](worktrees.md) for the worktree keys and merge approval, [sessions.md](sessions.md) for resume, retention and the digest, [messaging.md](messaging.md) for the message limit and the working cap, and [frontends.md](frontends.md) for notifications.

## Example

```json
{
  "roles": { "orchestrator": { "model": "opus", "effort": "high" }, "worker": { "model": "sonnet", "effort": "medium" } },
  "worktrees": { "isolation": "worktree", "setup": ["npm ci"] },
  "gate": { "command": "npm test" },
  "limits": { "stallMinutes": 10 }
}
```

### Copied `node_modules/`

A `.worktreeinclude` that lists `node_modules/` gives each worktree a copy of the main checkout's install, stale or not, even when the worktree's `package-lock.json` pins other versions. To re-install only when the copy doesn't match the worktree's lockfile, use this setup command, which compares the lockfile with npm's record of what it installed (`node_modules/.package-lock.json`). Optional packages skipped on this platform don't count as differences:

```json
"worktrees": {
  "setup": ["node -e \"const r=require,s=JSON.stringify,a=r('./package-lock.json').packages,b=r('./node_modules/.package-lock.json').packages;delete a[''];process.exit(Object.keys(b).every(k=>s(a[k])===s(b[k]))&&Object.keys(a).every(k=>b[k]||a[k].optional)?0:1)\" 2>/dev/null || npm ci --no-audit --no-fund"]
}
```

A matching copy adds about 30 ms before the agent starts. A stale or missing copy runs `npm ci` instead, which takes about 1.5 s for this repo with a warm npm cache. A plain `"npm ci"` is also correct, but it pays that cost every time and replaces the copy-on-write clone with a full copy of the files.

<a id="opt-in-codex-task-defaults"></a>

## Task defaults on installation

Fresh installations immediately use Tiller’s built-in task defaults. Upgrading
also fills previously unset defaults effectively on the next read or new spawn,
including existing installations with partial configuration. No setup
step, staging action, or config-file write is required. Explicit spawn arguments,
presets, configured task profiles, and legacy Claude roles all take precedence;
each model and effort resolves independently. Existing config files are never
rewritten. Pi uses its provider’s defaults because its model IDs are provider-specific.

| Task profile | Claude model | Claude effort | Codex model | Codex effort |
| --- | --- | --- | --- | --- |
| Orchestrator | `opus` | CLI default | `gpt-6-astra` | medium |
| Implementation | `sonnet` | CLI default | `gpt-6.1-sol` | medium |
| Explorer | `haiku` | CLI default | `gpt-6-luna` | high |
| Mechanical | `haiku` | CLI default | `gpt-6-luna` | low |
| Reviewer | `opus` | CLI default | `gpt-6.1-sol` | high |

Claude aliases and custom models can resolve to models that do not support effort
controls, so Tiller does not force Claude effort. User-configured effort remains
unchanged. Staging Claude recommendations changes models only. Global Settings
labels shipped values **Tiller default**;
these are effective defaults, not overrides stored in your global file.

Existing `roles` settings apply only to Claude; they never supply Claude model IDs
to Codex or Pi. Model IDs in explicit spawn arguments and presets pass through
unchanged. Resolved profile, model and effort are retained through resume and
follow-up; config edits affect new spawns and, for a model or effort that came from
config rather than a spawn argument or preset, the node's next restart. Live harness reports take precedence
for model/effort display.

To customize Codex task defaults, add the desired fields to either config file:

```json
{
  "profiles": {
    "codex": {
      "orchestrator": { "model": "gpt-6-astra", "effort": "medium" },
      "implementation": { "model": "gpt-6.1-sol", "effort": "medium" },
      "explorer": { "model": "gpt-6-luna", "effort": "high" },
      "mechanical": { "model": "gpt-6-luna", "effort": "low" },
      "reviewer": { "model": "gpt-6.1-sol", "effort": "high" }
    }
  }
}
```

For example, `tl config --cwd /path/to/repo` includes `profiles.codex.reviewer.model` and the file that supplied it. A project can override just its effort while retaining the home model. A spawn’s explicit model can override its preset model while effort still comes from that preset or profile config.

## Settings HTTP API

Open **Settings** and choose **Global · all repositories** for shared defaults or
**Repository** for the selected node’s repository. The repository name and path
identify the target; repository overrides take precedence over global values.
**Daemon** settings are global only. Select a category to edit task profiles,
notifications, limits, worktrees, approvals, or legacy Claude roles. CLI discovery
is available separately under **CLI diagnostics**.

Each field shows its effective value. **Customize for this repository** or
**Customize globally** starts an override; **Remove repository override** (repository) or
**Use inherited default** (global) removes it. Claude profile resets can retain a
legacy role fallback; expand **Value source** to see where a value comes from.
Draft changes show an **After save** preview. When legacy role edits are pending,
Claude profile previews that may depend on them are marked unavailable until
saving; they do not show a predicted value. Model and effort inherit independently.
Removing a repository profile override can retain a repository legacy role value
rather than the global value.

Claude and Codex each show their built-in **Recommended defaults** in a model/effort table.
**Stage recommended defaults** customizes only that harness’s listed profile values
in the draft. Claude effort rows marked CLI default retain any configured effort. Review or cancel them before choosing **Save repository settings** or
**Save global settings**. Claude suggestions use the supported `opus`, `sonnet`,
and `haiku` CLI aliases; versions and availability depend on your provider
([Claude model reference](https://code.claude.com/docs/en/model-config#model-aliases)).
Custom model IDs remain editable. Nothing is written until Save; changing scope
or closing with unsaved edits requires choosing whether to discard them.

The human Settings editor uses `GET /api/settings?scope=home` or
`GET /api/settings?scope=project&nodeId=<existing-node-id>`. Both require
`Authorization: Bearer <admin-token>`; node tokens cannot read or save Settings.
No MCP Settings tool is exposed. Home settings work without a selected node.
Project settings use the node's project directory (the main checkout for worktree
nodes), never a path supplied by the client. Config files and project `.tiller`
directories that are symlinks are rejected.

A snapshot contains `scope`, `path`, `projectPath`, `revision`, flattened explicit
`values`, effective `entries`, and `inherited` entries from below the selected
layer, with legacy-role and final Tiller defaults applied to profile previews. Each entry has `value` (omitted if unset) and `source` (a config path or
`default`). Home inherits Tiller defaults; project inherits home and defaults, with Claude legacy-role fallback preserved.
The `daemon` group is editable only at home scope.

`claude.account` is special at project scope: the snapshot's value is the account whose
`projects` list this repository's exact path, `entries` holds the effective account, `inherited`
the global `claude.account`, and `claudeAccount` `{ effective, project }` names the `projects`
entry that decides it. Saving it rewrites those `projects` lists in the home file, never the
repository file, so the request must also carry the snapshot's `homeRevision`; a stale one is a
409 like a stale `revision`. A name must be in `claude.accounts`.

Save with `POST /api/settings` and a JSON body such as:

```json
{"scope":"project","nodeId":"n-example","revision":"<snapshot revision>","changes":{"limits.maxDepth":4,"gate.command":null}}
```

Only supported leaf keys may change; `null` removes that explicit override.
Profile model and effort keys use `profiles.<harness>.<profile>.model` and
`.effort`, for harnesses `claude`, `pi`, `codex` and profiles `orchestrator`,
`implementation`, `explorer`, `mechanical`, `reviewer`. Codex effort accepts `low`,
`medium`, `high`, `xhigh`; Claude and Pi additionally accept `max`. Unknown existing fields
are preserved. Saving command strings only stores them; it does not execute them.
Successful saves return a fresh snapshot. A stale revision returns HTTP 409;
reload and reconcile the changes before retrying. Invalid requests return 400,
unknown nodes 404, malformed JSON files or invalid group structures 422, and
filesystem failures 500 with an error message. Malformed files are never replaced.

Writes use an exclusive temporary file beside the config, flush it, and atomically
rename it over the original. Failed writes remove their temporary file and leave
the original intact. Writes in one daemon are serialized; a final content check
also detects external edits made before rename. Portable filesystem rename has
no cross-process compare-and-swap, so an external editor writing in the interval
between that check and rename can still race. Avoid simultaneous external edits
while saving through Settings.

Effective Settings entries use the same invalid-leaf filtering as runtime config
resolution; an invalid known override remains visible in raw `values` for repair
or reset but does not supply an effective value. Profile fields resolve
independently from project, then home, before Claude falls back to legacy roles.
The profile preview assumes coordination role `orchestrator` for that profile
and `worker` for implementation, explorer, mechanical and reviewer. An explicit
coordination role at spawn can change the legacy fallback; explicit spawn options
and preset values also take precedence over this configuration preview. Pi and
Codex never inherit Claude legacy roles. For ordinary fields, inherited entries
come from layers below the selected scope. A profile field’s inherited entry
previews resetting that field only: it uses a lower-layer profile value first,
then the effective legacy role value, including role overrides retained in the
selected file. This applies to both project and home resets.

## Native notifications

The daemon applies mute, do not disturb, watched-node suppression, quiet hours,
notification levels, throttling and tree summaries before requesting an OS
notification. When a ready Tiller app is connected, one app client submits that
approved notification through Tauri, using the release app's Tiller identity and
icon. Clicking it opens the app and selects the node if it still exists. macOS
may require you to allow notifications for Tiller; the app can request permission
but does not grant it for you.

With no ready native app, or after a definite native submission failure, the
daemon uses its existing terminal-notifier/AppleScript fallback. A fully quit app
is not started just to notify; fallback notifications may retain their sender's
icon. If the app disconnects or its receipt times out after dispatch, the daemon
logs uncertain delivery and does not resend, avoiding duplicate notifications.
The native plugin acknowledges submission, not eventual OS display. After an
update, rebuild and relaunch the release app and restart the updated daemon to
use native delivery; a browser tab alone uses the fallback.
