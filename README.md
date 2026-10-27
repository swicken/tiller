<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/assets/logo-dark.png">
    <img src="docs/assets/logo-light.png" alt="tiller" width="320">
  </picture>
</p>

# tiller

Tiller is a local daemon that runs several agent CLI sessions (Claude Code, Pi or Codex) as child processes, called nodes, and lets one of them, the orchestrator, spawn, message and watch the others. A root node (one with no parent) is an orchestrator; a node it spawns is a worker. The main front end is a native macOS app built with Tauri; the same UI runs in a browser. A Claude Code mod, Pi extension or Codex app-server bridge delivers messages and reports lifecycle events.

## Install

On a Mac, clone the repo and run:

    bin/setup

It checks everything tiller needs, lists what is missing with the exact command for each, asks once, installs those pieces, then runs `npm ci` (installing the locked dependencies without changing `package-lock.json`), `npm link` and `npm run app:build`. It never uses `sudo` and does not edit your shell profile. `bin/setup --no-app` skips Rust and the app build; `bin/setup --harness pi` installs Pi instead of Claude Code when neither is present. Run `tl doctor` (or `bin/setup --check`) later to rerun the checks without changing anything; it prints the fix for anything broken.

For Codex nodes, have `codex` on your PATH and authenticate with `codex login`; see the [Codex adapter](adapters/codex/README.md). The setup installer currently offers Claude Code or Pi.

What it checks, for reference:

- macOS with the Xcode Command Line Tools (`xcode-select --install`), which Tauri needs to build the native app.
- Homebrew, and Node 24 or newer (`brew install node`).
- An agent CLI on your PATH: `claude` (Claude Code, `curl -fsSL https://claude.ai/install.sh | bash`), or `pi` 1.2.x or 1.3.x (`npm install -g @earendil-works/pi-coding-agent@~1.3.0`). See [docs/harnesses.md](docs/harnesses.md) for Pi setup and limitations.
- Rust, through Homebrew's rustup: `brew install rustup`, then `"$(brew --prefix rustup)/bin/rustup" default stable`, which installs the stable toolchain and leaves your shell profile alone. That rustup is keg-only, so `cargo` is not on your PATH by default; `bin/setup` and `bin/tl-app` add it themselves. To run `npm run app:build` or `cargo` from your own shell, add `export PATH="$(brew --prefix rustup)/bin:$PATH"` to `~/.zshrc`.
- Optional: `terminal-notifier` (`brew install terminal-notifier`), so clicking a macOS notification selects the node.
- `tl` on your PATH pointing at this checkout. `npm link` puts `tl` (the client), `tld` (the daemon in the foreground) and `tl-app` (the native app) there; if you have another tiller checkout linked, `tl doctor` says where `tl` points.
- The built app, `src-tauri/target/release/bundle/macos/Tiller.app`. The first build compiles the Rust dependencies and takes a few minutes. Without it, `tl` opens the browser UI instead, and `tl-app` runs the app in dev mode. Rebuild after pulling changes to `ui/` or `src-tauri/` (`npm run app:build`, or rerun `bin/setup`).

## Use

- `tl` starts the daemon if it is not running and opens the app on the existing sessions (or the browser UI when the app is not built), like `code`. `tl .` or `tl ~/some/repo` (like `code .`) also finds, resumes or creates the orchestrator for that directory and opens the app on it. Without `up` or `app` in front, the path must start with `.`, `/` or `~`. `tl --new` always starts a fresh orchestrator, for the current directory unless a path is given.
- `cd ~/some/repo && tl --harness pi` uses Pi instead of Claude Code; the spawn dialog also offers Pi. Claude Code is not needed for a Pi-only tree.
- `cd ~/some/repo && tl --harness codex` runs Codex; the spawn dialog also offers Codex. See the [Codex adapter](adapters/codex/README.md) for terminal controls and approval handling.
- `tl url` prints the browser UI's URL with the admin token; the daemon does not log it. It refuses inside a node.
- `tl stop` shuts the daemon down and closes every node; the nodes are not resumed on the next start.
- `tl reload` restarts the daemon on the current code and resumes the nodes that were live. Run it after pulling or editing daemon code. It first waits for agents to finish their turns, holding messages and spawns meanwhile (`--now` skips the wait, Ctrl-C cancels it), and afterwards tells each node whose turn was cut off to continue; see [restart and resume](docs/sessions.md#waiting-for-turns-to-end).
- `tl update --check` checks published stable GitHub releases and prints the latest version and notes for every missed release. `tl update` installs that exact release, rebuilds changed dependencies/UI/app and restarts the daemon. Before the restart it waits for agents to finish their turns (the app shows "Waiting for N agents to finish their turn" with **Restart now**; `tl update --now` skips the wait); live nodes then resume under the configured resume policy, and any whose turn was cut off is told to continue. If the checkout already contains the latest release but the daemon is still running older code, release management offers **Rebuild and restart** from the clean `main` checkout. After an installed release is detected, the footer's **What’s new** notice shows its unread release notes and disappears when read. When a future release is discovered, the footer shows **Update available**; select it to review release notes and explicitly install through release management. Installed unread notes remain separate under **What’s new**. No dialog opens and no update installs automatically. If the native app is rebuilt, quit and reopen Tiller.
- `tl autostart on|off|status` manages a launchd agent that starts the daemon at login and again after a crash.

Workers that edit code in parallel get their own git worktrees, each on a branch forked from a base branch. The base is a task branch, one per task, named after the repo's convention (`tl spawn --base feature/x`, or `base` on the spawn tool); when none is given and the checkout is on a protected branch (`main`, `master` or the remote's default), tiller makes one named `tl/<slug>` from the worker's title. Merges go into that base and never into a protected branch, so you push the task branch and open a pull request yourself. See [docs/worktrees.md](docs/worktrees.md).

`tl help` lists every command and flag.

## Working in the app

The sidebar shows your agent tree and lets you switch between sessions. Select a node to use its live terminal; the resizable **Details** drawer shows its model, effort, context usage and branch. Use **Transcript** to read a node's conversations with its parent, children and peers (tool calls are hidden unless you check **Show tool calls**) or its full transcript, including earlier sessions, or **Diff** to review a worker's worktree changes and send line comments back to it.

To switch an existing agent between Claude Code, Codex and Pi, open **More actions → Change harness…**. This stops the current process and starts a fresh conversation while keeping the node, its children and worktree. Earlier transcripts remain readable. Model, effort, preset and Claude permission overrides reset to the selected harness's defaults; review the confirmation before switching. See [harness switching](docs/harnesses.md#change-an-existing-agents-harness).

By default, notifications appear when an agent needs your input or approval and when all agents in a tree finish. Individual completions and routine errors stay in the UI. Settings let you adjust notifications, quiet hours and shortcuts; node muting and do not disturb are also available. See [front ends and notifications](docs/frontends.md).

## Updates

Updates use the GitHub repository identified by the checkout's `origin` (HTTPS or git SSH). Only published, non-draft, non-prerelease `vX.Y.Z` releases qualify; unreleased commits on `main` are never an update target. While at least one authenticated app or browser is connected, one daemon-owned checker runs immediately when stale and then two minutes after each successful check. Closing the last UI pauses automatic checking; reconnects share the same freshness window. Manual checks remain available. Failures back off from twenty minutes to six hours, and GitHub rate-limit headers pause requests until the server allows retries. Release-list requests use ETags when available; no local GitHub tokens are sent. A failed/offline/rate-limited check disables applying until a successful check; there is no cached-main fallback. Release versions are compared numerically, and skipped release notes are rolled up newest first. Release dialogs render authored Markdown and show change descriptions first, with the complete original generated notes available under collapsed **Technical details**. Releases without PR descriptions use actual non-merge commit subjects; full commit SHAs remain in the technical record.

Installed unread notes are separate from update availability. The first daemon observation establishes a baseline without a notice, including when offline. Later checks show notes only when the running daemon is at an exact published stable release commit; development commits and an old daemon whose checkout moved do not count. Notes for skipped releases are rolled up newest first from that baseline. The baseline and proven unread notes persist in `<TL_HOME>/update-notes.json`, so reconnects, restarts, and multiple UI clients share read state. Notes-file mutations briefly serialize across daemon instances; an interrupted `<TL_HOME>/update-notes.json.lock` leaves notes unchanged and reports its path. Confirm no notes writer is active before manually removing that lock. Reading acknowledges the exact displayed identity; an older acknowledgment cannot dismiss newer notes. Proven cached notes remain readable offline, while missing release metadata waits for a successful check and never guesses notes from main or a package version.

Updating is human-only and requires the primary checkout on `main`, no uncommitted or untracked files, no git operation in progress, and an ancestor relationship allowing a fast-forward to the release. Local or unreleased commits are preserved by refusing the update. Linked worktrees and detached checkouts cannot apply updates. Tags and commits are pinned and checked again before applying, including release publication and notes; a changed target requires another review. No remotes are reconfigured or pushed.

Keep the primary checkout on clean `main` and do development on task branches in separate worktrees so updates remain available. If an update is disabled, release management shows the reason and recovery guidance. Uncommitted or untracked files are identified as an unclean `main` checkout; after fixing the checkout, check releases again to refresh its eligibility. Manual and automatic checks share daemon-owned progress; applying stays disabled while eligibility is refreshed. Updating restarts the daemon once agents have finished their turns, or at once with **Restart now** or `--now`. They can resume afterward; automatic resume follows `daemon.resumeOnStart`, the idle-age limit and session/worktree availability.

The detached helper logs to `<TL_HOME>/update.log` and holds a checkout-wide `.git/update.lock`, including while rebuilding and restarting. A failed update attempts `git reset --keep` to the original commit, reinstalls/rebuilds the steps it started, and verifies the restarted daemon's commit. Edits that prevent a safe rollback are retained and reported with the log path. An interrupted helper can leave the lock behind: inspect the log and checkout, confirm no helper is running, repair/rebuild if necessary, then remove the lock manually before retrying. Never remove a live helper's lock. This updater rebuilds a source checkout; it does not download prebuilt app assets.

## Where files live

Everything the daemon keeps is under `~/.tiller`, or `TL_HOME` when set: the node registry (`state.json`), per-node files under `nodes/<id>/`, the admin token `tl` uses, `config.json` ([docs/config.md](docs/config.md)), presets under `agents/` and the log `daemon.log`. Each tree of nodes has a session directory, `sessions/<rootId>/`, for notes and the event log ([docs/sessions.md](docs/sessions.md)). The daemon listens on 127.0.0.1, port 7788 unless `TL_PORT` says otherwise. Inside a node, `tl` talks to the node's own daemon (`TL_ENDPOINT`) and refuses rather than guess when `TL_HOME` or `TL_PORT` names a different one; to address another daemon from a node, run `tl` without `TL_NODE_ID`, `TL_TOKEN_FILE`, `TL_ENDPOINT` and the inherited `TL_PORT`.

## Configuration

Tiller reads two JSON files, both optional: a per-repo file at `<repo>/.tiller/config.json`, which you commit so everyone who runs tiller in that repo gets the same behaviour, and a global file at `~/.tiller/config.json` for your own defaults across repos. Each key resolves on its own: the repo file wins over the global file, which wins over the built-in default. Keys in the `daemon` group (resume, retention, node caps) are daemon-wide and are read from the global file only. Keys in the `approvals` group decide when an agent skips your approval, so the repo file may only make them stricter than the global file: set `"approvals": { "close": "done" }` globally to let orchestrators close finished workers without asking. Both files are re-read on every use, so an edit applies without restarting the daemon. `tl config` prints the effective value of every key for the current directory and which file it came from.

Task profiles (`orchestrator`, `implementation`, `explorer`, `mechanical`, `reviewer`) select portable task guidance independently of coordination roles (`orchestrator`, `worker`, `none`). Default profiles follow the effective role: orchestrator maps to orchestrator, worker/none to implementation (normally root and child respectively). Use `--profile` with `tl new` / `tl spawn`, or the spawn dialog. Built-in [task defaults](docs/config.md#task-defaults-on-installation) apply when model/effort overrides under `profiles.<harness>.<profile>` are unset. Existing Claude `roles` settings remain compatible and take precedence over built-in defaults.

A typical legacy Claude repo file sets the models for each role, gives workers their own worktrees with task branches named in the repo's convention and defines the check that must pass before a worker may report success:

```json
{
  "roles": { "orchestrator": { "model": "opus", "effort": "high" }, "worker": { "model": "sonnet", "effort": "medium" } },
  "worktrees": { "isolation": "worktree", "taskBranch": "feature/{slug}", "setup": ["npm ci"] },
  "gate": { "command": "npm test" }
}
```

The same two levels hold for the text tiller gives agents: a repo can override the role prompts with `.tiller/orchestrator.md` and `.tiller/worker.md`, or globally with `~/.tiller/prompts/<role>.md`, and spawn presets (a named bundle of role text, model, effort, isolation and tool restrictions) live in `.tiller/agents/<name>.md` or `~/.tiller/agents/<name>.md`. Every key, its default and its level are listed in [docs/config.md](docs/config.md); prompts and presets are in [docs/agent-roles.md](docs/agent-roles.md).

## Known limits

- Anthropic can disable mods remotely, and `--bare` or `--safe-mode` drop them. The daemon and CLI still work then; messages are pasted into the terminal instead.
- Claude shows its trust dialog the first time it opens a new folder; attach and accept it.
- One daemon per user.
- With autostart on, a daemon started by `tl` or the app (when none was running) runs outside launchd, so a crash does not bring it back until the next `tl reload` or login.

## Development and tests

Use Node.js 24+ and run `npm ci` from the repository root. `npm run ui:dev` starts Vite with hot reload and proxies to the daemon at `127.0.0.1:7788` (or `TL_WS`). For daemon experiments, set a separate `TL_HOME` and `TL_PORT` to keep live sessions isolated. See [ui/README.md](ui/README.md) for the mock daemon workflow.

| Check | Command |
| --- | --- |
| Daemon, shared code and adapters | `npm run typecheck` |
| UI types | `npx --no-install tsc --noEmit -p ui/tsconfig.json` |
| Full Vitest suite | `npm test` |
| Focused tests | `npm test -- src/daemon/messaging.test.ts` |
| Claude mod | `claude plugin validate mod/` and `claude plugin test mod/`; the same for `mod-rows/` |
| Release helpers | `node --test scripts/release-test.mjs` |
| Production UI build | `npm run ui:build` |
| Native app tests | `cargo test --locked --all-targets --manifest-path src-tauri/Cargo.toml` |

Vitest runs up to one test file per two CPU cores at once (at least two) to bound resource use for real Git and child-process fixtures. Implementation workers run focused tests for their changes; reviewers run targeted checks as needed. This repository's automatic completion gate checks root, Pi adapter and UI types, so it does not replace focused tests. Run the full suite once on the final integrated tree before publication. [GitHub CI](.github/workflows/ci.yml) also checks release helpers, the production UI build and Rust on macOS. See [AGENTS.md](AGENTS.md) for the contribution workflow.

## Documentation

- [docs/config.md](docs/config.md): every config key, its default and which file it is read from.
- [docs/harnesses.md](docs/harnesses.md): harness adapters, Pi usage, compatibility and repository trust.
- [docs/messaging.md](docs/messaging.md): how messages between nodes are queued, delivered, steered and limited.
- [docs/agent-roles.md](docs/agent-roles.md): role prompts, presets, outcomes and the completion gate.
- [docs/worktrees.md](docs/worktrees.md): running workers in their own git worktrees and merging their work.
- [docs/sessions.md](docs/sessions.md): session directories, the event log, restart and resume.
- [docs/frontends.md](docs/frontends.md): the app, the browser UI, the in-session band and notifications.
- [docs/releases.md](docs/releases.md): how releases are published and what the updater relies on.
- [PLAN.md](PLAN.md): the original design rationale; [docs/design/](docs/design/) holds the design documents for later features.
